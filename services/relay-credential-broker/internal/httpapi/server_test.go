package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

const developmentAppCheckToken = "development-app-check-token-at-least-32-bytes"

type testService struct {
	handler *Server
	signer  *credential.Signer
	now     time.Time
}

func newTestService(t *testing.T) *testService {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := credential.NewSigner("https://credentials.volt.test", "volt-iroh-relay", private)
	if err != nil {
		t.Fatal(err)
	}
	service := &testService{
		signer: signer,
		now:    time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC),
	}
	pool := testdatabase.Open(t)
	brokerService, err := broker.New(pool, signer, broker.Config{
		ClaimTTL:                10 * time.Minute,
		AccessTokenTTL:          15 * time.Minute,
		RefreshInactivityTTL:    30 * 24 * time.Hour,
		RefreshMinInterval:      5 * time.Second,
		MaxClaims:               100,
		MaxEndpoints:            200,
		MaxAppEndpointsPerGrant: 8,
	}, func() time.Time { return service.now })
	if err != nil {
		t.Fatal(err)
	}
	appCheck, err := NewDevelopmentAppCheckVerifier(developmentAppCheckToken)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewServer(brokerService, signer, appCheck, Config{
		MaxConcurrentRequests: 8,
		RefreshMinInterval:    5 * time.Second,
		ReadinessCheck:        pool.Ping,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service.handler = handler
	return service
}

func TestBootstrapPairingUsesClientGeneratedStableRefreshSecrets(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("a", 64)
	appNodeID := strings.Repeat("b", 64)
	claimSecret := testSecret("vpc_", 1)
	hostRefreshToken := testSecret("vrr_", 2)
	appRefreshToken := testSecret("vrr_", 3)
	claim := service.createBootstrapClaim(t, hostNodeID, claimSecret, hostRefreshToken)

	pending := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claimSecret,
	})
	if pending.Code != http.StatusAccepted || pending.Header().Get("Retry-After") != "1" {
		t.Fatalf("pending status = %d, headers = %v, body = %s", pending.Code, pending.Header(), pending.Body.String())
	}

	approvalBody := encodeBody(t, map[string]string{
		"appNodeId":           appNodeID,
		"appRefreshTokenHash": secretHash(appRefreshToken),
	})
	unauthenticatedApproval := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", approvalBody, nil)
	if unauthenticatedApproval.Code != http.StatusUnauthorized {
		t.Fatalf("approval without App Check status = %d", unauthenticatedApproval.Code)
	}

	approvalResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", approvalBody, map[string]string{
		"X-Firebase-AppCheck": developmentAppCheckToken,
	})
	if approvalResponse.Code != http.StatusOK {
		t.Fatalf("approval status = %d, body = %s", approvalResponse.Code, approvalResponse.Body.String())
	}
	if strings.Contains(approvalResponse.Body.String(), "refreshToken") {
		t.Fatalf("approval returned plaintext refresh authority: %s", approvalResponse.Body.String())
	}
	var approval broker.Approval
	decodeResponse(t, approvalResponse, &approval)
	if approval.GrantID == "" || approval.EndpointID == "" || approval.HostNodeID != hostNodeID || approval.AppNodeID != appNodeID {
		t.Fatalf("incomplete approval: %+v", approval)
	}
	firstAppAccessToken := approval.Credential.AccessToken

	retryApprovalResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", approvalBody, map[string]string{
		"X-Firebase-AppCheck": developmentAppCheckToken,
	})
	if retryApprovalResponse.Code != http.StatusOK {
		t.Fatalf("retry approval status = %d, body = %s", retryApprovalResponse.Code, retryApprovalResponse.Body.String())
	}
	var retriedApproval broker.Approval
	decodeResponse(t, retryApprovalResponse, &retriedApproval)
	if retriedApproval.GrantID != approval.GrantID || retriedApproval.EndpointID != approval.EndpointID {
		t.Fatalf("approval retry changed authority: first=%+v retry=%+v", approval, retriedApproval)
	}
	if retriedApproval.Credential.AccessToken == firstAppAccessToken {
		t.Fatal("approval retry replayed the prior access JWT")
	}

	conflictingApproval := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", encodeBody(t, map[string]string{
		"appNodeId":           appNodeID,
		"appRefreshTokenHash": secretHash(testSecret("vrr_", 4)),
	}), map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	if conflictingApproval.Code != http.StatusConflict {
		t.Fatalf("conflicting refresh hash status = %d, body = %s", conflictingApproval.Code, conflictingApproval.Body.String())
	}

	appClaims, err := service.signer.Verify(approval.Credential.AccessToken, service.now)
	if err != nil {
		t.Fatal(err)
	}
	if appClaims.Subject != appNodeID || appClaims.EndpointKind != "app" || appClaims.GrantID != approval.GrantID {
		t.Fatalf("unexpected app claims: %+v", appClaims)
	}

	exchangeResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claimSecret,
	})
	if exchangeResponse.Code != http.StatusOK {
		t.Fatalf("exchange status = %d, body = %s", exchangeResponse.Code, exchangeResponse.Body.String())
	}
	if strings.Contains(exchangeResponse.Body.String(), "refreshToken") {
		t.Fatalf("exchange returned plaintext refresh authority: %s", exchangeResponse.Body.String())
	}
	var exchange broker.Exchange
	decodeResponse(t, exchangeResponse, &exchange)
	if exchange.GrantID != approval.GrantID || exchange.EndpointID == "" || exchange.AppEndpointID != approval.EndpointID || exchange.AppNodeID != appNodeID {
		t.Fatalf("unexpected exchange: %+v", exchange)
	}

	retryExchangeResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claimSecret,
	})
	if retryExchangeResponse.Code != http.StatusOK {
		t.Fatalf("retry exchange status = %d, body = %s", retryExchangeResponse.Code, retryExchangeResponse.Body.String())
	}
	var retriedExchange broker.Exchange
	decodeResponse(t, retryExchangeResponse, &retriedExchange)
	if retriedExchange.EndpointID != exchange.EndpointID || retriedExchange.GrantID != exchange.GrantID {
		t.Fatalf("exchange retry changed host authority: first=%+v retry=%+v", exchange, retriedExchange)
	}

	hostClaims, err := service.signer.Verify(exchange.Credential.AccessToken, service.now)
	if err != nil {
		t.Fatal(err)
	}
	if hostClaims.Subject != hostNodeID || hostClaims.EndpointKind != "host" || hostClaims.GrantID != approval.GrantID {
		t.Fatalf("unexpected host claims: %+v", hostClaims)
	}

	refreshResponse := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + hostRefreshToken,
	})
	if refreshResponse.Code != http.StatusOK {
		t.Fatalf("host refresh status = %d, body = %s", refreshResponse.Code, refreshResponse.Body.String())
	}
	var refreshed broker.AccessToken
	decodeResponse(t, refreshResponse, &refreshed)
	refreshedClaims, err := service.signer.Verify(refreshed.AccessToken, service.now)
	if err != nil {
		t.Fatal(err)
	}
	if refreshedClaims.Subject != hostNodeID || refreshedClaims.JWTID == hostClaims.JWTID {
		t.Fatalf("unexpected refreshed claims: %+v", refreshedClaims)
	}
	throttledRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + hostRefreshToken,
	})
	if throttledRefresh.Code != http.StatusTooManyRequests || throttledRefresh.Header().Get("Retry-After") != "5" {
		t.Fatalf("throttled refresh status = %d, headers = %v, body = %s", throttledRefresh.Code, throttledRefresh.Header(), throttledRefresh.Body.String())
	}

	appRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + appRefreshToken,
	})
	if appRefresh.Code != http.StatusOK {
		t.Fatalf("app refresh status = %d, body = %s", appRefresh.Code, appRefresh.Body.String())
	}
}

func TestExistingGrantAddsAndRevokesOneAppEndpoint(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("c", 64)
	firstAppNodeID := strings.Repeat("d", 64)
	secondAppNodeID := strings.Repeat("e", 64)
	firstClaimSecret := testSecret("vpc_", 5)
	hostRefreshToken := testSecret("vrr_", 6)
	firstAppRefreshToken := testSecret("vrr_", 7)
	firstClaim := service.createBootstrapClaim(t, hostNodeID, firstClaimSecret, hostRefreshToken)
	firstApproval := service.approveClaim(t, firstClaim.ClaimID, firstAppNodeID, firstAppRefreshToken)
	firstExchange := service.exchangeClaim(t, firstClaim.ClaimID, firstClaimSecret)

	secondClaimSecret := testSecret("vpc_", 8)
	createSecond := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"claimSecretHash": secretHash(secondClaimSecret),
	}), map[string]string{"Authorization": "Bearer " + hostRefreshToken})
	if createSecond.Code != http.StatusCreated {
		t.Fatalf("existing grant claim status = %d, body = %s", createSecond.Code, createSecond.Body.String())
	}
	var secondClaim broker.PairingClaim
	decodeResponse(t, createSecond, &secondClaim)

	appCannotCreateClaim := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"claimSecretHash": secretHash(testSecret("vpc_", 9)),
	}), map[string]string{"Authorization": "Bearer " + firstAppRefreshToken})
	if appCannotCreateClaim.Code != http.StatusForbidden {
		t.Fatalf("app-authenticated claim status = %d, body = %s", appCannotCreateClaim.Code, appCannotCreateClaim.Body.String())
	}

	secondAppRefreshToken := testSecret("vrr_", 10)
	secondApproval := service.approveClaim(t, secondClaim.ClaimID, secondAppNodeID, secondAppRefreshToken)
	secondExchange := service.exchangeClaim(t, secondClaim.ClaimID, secondClaimSecret)
	if secondApproval.GrantID != firstApproval.GrantID || secondExchange.GrantID != firstApproval.GrantID {
		t.Fatalf("later pairing created another grant: first=%+v second=%+v", firstApproval, secondApproval)
	}
	if secondExchange.EndpointID != firstExchange.EndpointID {
		t.Fatalf("later pairing replaced host endpoint: first=%+v second=%+v", firstExchange, secondExchange)
	}
	if secondExchange.AppEndpointID != secondApproval.EndpointID || secondExchange.AppNodeID != secondAppNodeID {
		t.Fatalf("host did not observe second app endpoint: %+v", secondExchange)
	}

	duplicateNodeClaimSecret := testSecret("vpc_", 20)
	duplicateNodeClaimResponse := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"claimSecretHash": secretHash(duplicateNodeClaimSecret),
	}), map[string]string{"Authorization": "Bearer " + hostRefreshToken})
	if duplicateNodeClaimResponse.Code != http.StatusCreated {
		t.Fatalf("duplicate-node claim status = %d, body = %s", duplicateNodeClaimResponse.Code, duplicateNodeClaimResponse.Body.String())
	}
	var duplicateNodeClaim broker.PairingClaim
	decodeResponse(t, duplicateNodeClaimResponse, &duplicateNodeClaim)
	duplicateNodeApproval := service.request(t, http.MethodPost, "/v1/pairing-claims/"+duplicateNodeClaim.ClaimID+"/approve", encodeBody(t, map[string]string{
		"appNodeId":           secondAppNodeID,
		"appRefreshTokenHash": secretHash(testSecret("vrr_", 21)),
	}), map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	if duplicateNodeApproval.Code != http.StatusConflict {
		t.Fatalf("duplicate grant/node approval status = %d, body = %s", duplicateNodeApproval.Code, duplicateNodeApproval.Body.String())
	}

	otherHostNodeID := strings.Repeat("f", 64)
	otherClaimSecret := testSecret("vpc_", 22)
	otherHostRefreshToken := testSecret("vrr_", 23)
	otherAppRefreshToken := testSecret("vrr_", 24)
	otherClaim := service.createBootstrapClaim(t, otherHostNodeID, otherClaimSecret, otherHostRefreshToken)
	otherApproval := service.approveClaim(t, otherClaim.ClaimID, secondAppNodeID, otherAppRefreshToken)
	if otherApproval.GrantID == firstApproval.GrantID {
		t.Fatal("independent daemon identity reused the first grant")
	}
	crossGrantRevoke := service.request(t, http.MethodPost, "/v1/grant/endpoints/revoke", encodeBody(t, map[string]string{
		"endpointId": otherApproval.EndpointID,
	}), map[string]string{"Authorization": "Bearer " + hostRefreshToken})
	if crossGrantRevoke.Code != http.StatusForbidden {
		t.Fatalf("cross-grant app revoke status = %d, body = %s", crossGrantRevoke.Code, crossGrantRevoke.Body.String())
	}

	revokeSecond := service.request(t, http.MethodPost, "/v1/grant/endpoints/revoke", encodeBody(t, map[string]string{
		"endpointId": secondApproval.EndpointID,
	}), map[string]string{"Authorization": "Bearer " + hostRefreshToken})
	if revokeSecond.Code != http.StatusNoContent {
		t.Fatalf("host app revoke status = %d, body = %s", revokeSecond.Code, revokeSecond.Body.String())
	}
	revokeSecondAgain := service.request(t, http.MethodPost, "/v1/grant/endpoints/revoke", encodeBody(t, map[string]string{
		"endpointId": secondApproval.EndpointID,
	}), map[string]string{"Authorization": "Bearer " + hostRefreshToken})
	if revokeSecondAgain.Code != http.StatusNoContent {
		t.Fatalf("idempotent host app revoke status = %d, body = %s", revokeSecondAgain.Code, revokeSecondAgain.Body.String())
	}
	secondAppRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + secondAppRefreshToken,
	})
	if secondAppRefresh.Code != http.StatusUnauthorized {
		t.Fatalf("revoked second app refresh status = %d, body = %s", secondAppRefresh.Code, secondAppRefresh.Body.String())
	}
	firstAppRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + firstAppRefreshToken,
	})
	if firstAppRefresh.Code != http.StatusOK {
		t.Fatalf("first app refresh after second revoke status = %d, body = %s", firstAppRefresh.Code, firstAppRefresh.Body.String())
	}

	revokeGrant := service.request(t, http.MethodPost, "/v1/grant/revoke", "", map[string]string{
		"Authorization": "Bearer " + hostRefreshToken,
	})
	if revokeGrant.Code != http.StatusNoContent {
		t.Fatalf("grant revoke status = %d, body = %s", revokeGrant.Code, revokeGrant.Body.String())
	}
	revokeGrantAgain := service.request(t, http.MethodPost, "/v1/grant/revoke", "", map[string]string{
		"Authorization": "Bearer " + hostRefreshToken,
	})
	if revokeGrantAgain.Code != http.StatusNoContent {
		t.Fatalf("idempotent grant revoke status = %d, body = %s", revokeGrantAgain.Code, revokeGrantAgain.Body.String())
	}
	for label, token := range map[string]string{
		"host":      hostRefreshToken,
		"first app": firstAppRefreshToken,
	} {
		response := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
			"Authorization": "Bearer " + token,
		})
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s refresh after grant revoke status = %d, body = %s", label, response.Code, response.Body.String())
		}
	}
	otherGrantRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + otherAppRefreshToken,
	})
	if otherGrantRefresh.Code != http.StatusOK {
		t.Fatalf("other grant refresh after first grant revoke status = %d, body = %s", otherGrantRefresh.Code, otherGrantRefresh.Body.String())
	}
}

func TestEndpointLocalRevocationIsIdempotentAndHostRevocationCascades(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("1", 64)
	appNodeID := strings.Repeat("2", 64)
	claimSecret := testSecret("vpc_", 11)
	hostRefreshToken := testSecret("vrr_", 12)
	appRefreshToken := testSecret("vrr_", 13)
	claim := service.createBootstrapClaim(t, hostNodeID, claimSecret, hostRefreshToken)
	service.approveClaim(t, claim.ClaimID, appNodeID, appRefreshToken)

	for index := 0; index < 2; index++ {
		response := service.request(t, http.MethodPost, "/v1/tokens/revoke", "", map[string]string{
			"Authorization": "Bearer " + appRefreshToken,
		})
		if response.Code != http.StatusNoContent {
			t.Fatalf("app revoke %d status = %d, body = %s", index, response.Code, response.Body.String())
		}
	}
	hostRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + hostRefreshToken,
	})
	if hostRefresh.Code != http.StatusOK {
		t.Fatalf("host refresh after app revoke status = %d, body = %s", hostRefresh.Code, hostRefresh.Body.String())
	}

	for index := 0; index < 2; index++ {
		response := service.request(t, http.MethodPost, "/v1/tokens/revoke", "", map[string]string{
			"Authorization": "Bearer " + hostRefreshToken,
		})
		if response.Code != http.StatusNoContent {
			t.Fatalf("host revoke %d status = %d, body = %s", index, response.Code, response.Body.String())
		}
	}
	appRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + appRefreshToken,
	})
	if appRefresh.Code != http.StatusUnauthorized {
		t.Fatalf("app refresh after host revoke status = %d, body = %s", appRefresh.Code, appRefresh.Body.String())
	}
}

func TestPairingClaimsRejectConflictsExpiryAndMalformedInput(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("3", 64)
	appNodeID := strings.Repeat("4", 64)
	claimSecret := testSecret("vpc_", 14)
	hostRefreshToken := testSecret("vrr_", 15)

	malformed := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"hostNodeId":           hostNodeID,
		"claimSecretHash":      secretHash(claimSecret),
		"hostRefreshTokenHash": secretHash(hostRefreshToken),
		"extra":                "true",
	}), nil)
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("unknown request field status = %d", malformed.Code)
	}
	invalidHash := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"hostNodeId":           hostNodeID,
		"claimSecretHash":      "invalid",
		"hostRefreshTokenHash": secretHash(hostRefreshToken),
	}), nil)
	if invalidHash.Code != http.StatusBadRequest {
		t.Fatalf("invalid secret hash status = %d", invalidHash.Code)
	}

	claim := service.createBootstrapClaim(t, hostNodeID, claimSecret, hostRefreshToken)
	duplicateSecret := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"hostNodeId":           hostNodeID,
		"claimSecretHash":      secretHash(claimSecret),
		"hostRefreshTokenHash": secretHash(testSecret("vrr_", 16)),
	}), nil)
	if duplicateSecret.Code != http.StatusConflict {
		t.Fatalf("duplicate claim secret status = %d, body = %s", duplicateSecret.Code, duplicateSecret.Body.String())
	}

	appRefreshToken := testSecret("vrr_", 17)
	service.approveClaim(t, claim.ClaimID, appNodeID, appRefreshToken)
	conflict := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", encodeBody(t, map[string]string{
		"appNodeId":           strings.Repeat("5", 64),
		"appRefreshTokenHash": secretHash(appRefreshToken),
	}), map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflicting approval status = %d, body = %s", conflict.Code, conflict.Body.String())
	}
	wrongSecret := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + testSecret("vpc_", 18),
	})
	if wrongSecret.Code != http.StatusUnauthorized {
		t.Fatalf("wrong claim secret status = %d, body = %s", wrongSecret.Code, wrongSecret.Body.String())
	}

	service.now = service.now.Add(10 * time.Minute)
	expired := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claimSecret,
	})
	if expired.Code != http.StatusGone {
		t.Fatalf("expired claim status = %d, body = %s", expired.Code, expired.Body.String())
	}

	service.now = service.now.Add(30 * 24 * time.Hour)
	expiredRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + appRefreshToken,
	})
	if expiredRefresh.Code != http.StatusGone {
		t.Fatalf("inactive refresh status = %d, body = %s", expiredRefresh.Code, expiredRefresh.Body.String())
	}
	revokeExpired := service.request(t, http.MethodPost, "/v1/tokens/revoke", "", map[string]string{
		"Authorization": "Bearer " + appRefreshToken,
	})
	if revokeExpired.Code != http.StatusNoContent {
		t.Fatalf("expired endpoint revoke status = %d, body = %s", revokeExpired.Code, revokeExpired.Body.String())
	}
}

func TestJWKSExposesOnlyPublicVerificationKey(t *testing.T) {
	service := newTestService(t)
	response := service.request(t, http.MethodGet, "/.well-known/jwks.json", "", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("JWKS status = %d", response.Code)
	}
	var document struct {
		Keys []map[string]string `json:"keys"`
	}
	decodeResponse(t, response, &document)
	if len(document.Keys) != 1 || document.Keys[0]["kid"] != service.signer.KeyID() || document.Keys[0]["x"] == "" {
		t.Fatalf("unexpected JWKS: %+v", document)
	}
	if _, found := document.Keys[0]["d"]; found {
		t.Fatal("JWKS exposed private key material")
	}
}

func TestLivenessAndReadinessAreSeparate(t *testing.T) {
	service := newTestService(t)
	for _, path := range []string{"/livez", "/readyz"} {
		response := service.request(t, http.MethodGet, path, "", nil)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", path, response.Code, response.Body.String())
		}
	}

	service.handler.readinessCheck = func(context.Context) error {
		return errors.New("database unavailable")
	}
	unavailable := service.request(t, http.MethodGet, "/readyz", "", nil)
	if unavailable.Code != http.StatusServiceUnavailable || !strings.Contains(unavailable.Body.String(), "service_unavailable") {
		t.Fatalf("unavailable readiness status = %d, body = %s", unavailable.Code, unavailable.Body.String())
	}
	live := service.request(t, http.MethodGet, "/livez", "", nil)
	if live.Code != http.StatusOK {
		t.Fatalf("liveness during dependency outage status = %d, body = %s", live.Code, live.Body.String())
	}
}

func TestConcurrencyLimitFailsClosed(t *testing.T) {
	service := newTestService(t)
	for index := 0; index < cap(service.handler.requestSemaphore); index++ {
		service.handler.requestSemaphore <- struct{}{}
	}
	defer func() {
		for index := 0; index < cap(service.handler.requestSemaphore); index++ {
			<-service.handler.requestSemaphore
		}
	}()

	response := service.request(t, http.MethodGet, "/livez", "", nil)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("busy service status = %d, headers = %v, body = %s", response.Code, response.Header(), response.Body.String())
	}
}

func TestDuplicateCredentialHeadersAreRejected(t *testing.T) {
	service := newTestService(t)

	refreshRequest := httptest.NewRequest(http.MethodPost, "/v1/tokens/refresh", nil)
	refreshRequest.Header.Add("Authorization", "Bearer first")
	refreshRequest.Header.Add("Authorization", "Bearer second")
	refreshResponse := httptest.NewRecorder()
	service.handler.ServeHTTP(refreshResponse, refreshRequest)
	if refreshResponse.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate Authorization status = %d, body = %s", refreshResponse.Code, refreshResponse.Body.String())
	}

	approveRequest := httptest.NewRequest(http.MethodPost, "/v1/pairing-claims/unknown/approve", bytes.NewBufferString(encodeBody(t, map[string]string{
		"appNodeId":           strings.Repeat("f", 64),
		"appRefreshTokenHash": secretHash(testSecret("vrr_", 19)),
	})))
	approveRequest.Header.Set("Content-Type", "application/json")
	approveRequest.Header.Add("X-Firebase-AppCheck", developmentAppCheckToken)
	approveRequest.Header.Add("X-Firebase-AppCheck", developmentAppCheckToken)
	approveResponse := httptest.NewRecorder()
	service.handler.ServeHTTP(approveResponse, approveRequest)
	if approveResponse.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate App Check status = %d, body = %s", approveResponse.Code, approveResponse.Body.String())
	}
}

func (s *testService) createBootstrapClaim(t *testing.T, hostNodeID, claimSecret, hostRefreshToken string) broker.PairingClaim {
	t.Helper()
	response := s.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
		"hostNodeId":           hostNodeID,
		"claimSecretHash":      secretHash(claimSecret),
		"hostRefreshTokenHash": secretHash(hostRefreshToken),
	}), nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}
	var claim broker.PairingClaim
	decodeResponse(t, response, &claim)
	if claim.ClaimID == "" || claim.ExpiresAt.IsZero() {
		t.Fatalf("incomplete pairing claim: %+v", claim)
	}
	return claim
}

func (s *testService) approveClaim(t *testing.T, claimID, appNodeID, appRefreshToken string) broker.Approval {
	t.Helper()
	response := s.request(t, http.MethodPost, "/v1/pairing-claims/"+claimID+"/approve", encodeBody(t, map[string]string{
		"appNodeId":           appNodeID,
		"appRefreshTokenHash": secretHash(appRefreshToken),
	}), map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	if response.Code != http.StatusOK {
		t.Fatalf("approval status = %d, body = %s", response.Code, response.Body.String())
	}
	var approval broker.Approval
	decodeResponse(t, response, &approval)
	return approval
}

func (s *testService) exchangeClaim(t *testing.T, claimID, claimSecret string) broker.Exchange {
	t.Helper()
	response := s.request(t, http.MethodPost, "/v1/pairing-claims/"+claimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claimSecret,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("exchange status = %d, body = %s", response.Code, response.Body.String())
	}
	var exchange broker.Exchange
	decodeResponse(t, response, &exchange)
	return exchange
}

func (s *testService) request(t *testing.T, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	s.handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), destination); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
}

func encodeBody(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func testSecret(prefix string, fill byte) string {
	return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32))
}

func secretHash(secret string) string {
	digest := sha256.Sum256([]byte(secret))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
