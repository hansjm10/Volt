package httpapi

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/broker"
	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/credential"
)

const (
	developmentAppCheckToken = "development-app-check-token-at-least-32-bytes"
	appDeliverySecret        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

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
	brokerService, err := broker.New(signer, broker.Config{
		ClaimTTL:           10 * time.Minute,
		AccessTokenTTL:     15 * time.Minute,
		RefreshTokenTTL:    30 * 24 * time.Hour,
		RefreshMinInterval: 5 * time.Second,
		MaxClaims:          100,
		MaxCredentials:     200,
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
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service.handler = handler
	return service
}

func TestAnonymousPairingCredentialFlow(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("a", 64)
	appNodeID := strings.Repeat("b", 64)

	create := service.request(t, http.MethodPost, "/v1/pairing-claims", `{"hostNodeId":"`+hostNodeID+`"}`, nil)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var claim broker.PairingClaim
	decodeResponse(t, create, &claim)
	if claim.ClaimID == "" || claim.ClaimSecret == "" {
		t.Fatalf("incomplete pairing claim: %+v", claim)
	}

	pending := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claim.ClaimSecret,
	})
	if pending.Code != http.StatusAccepted || pending.Header().Get("Retry-After") != "1" {
		t.Fatalf("pending status = %d, headers = %v, body = %s", pending.Code, pending.Header(), pending.Body.String())
	}

	unauthenticatedApproval := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+appNodeID+`","deliverySecret":"`+appDeliverySecret+`"}`, nil)
	if unauthenticatedApproval.Code != http.StatusUnauthorized {
		t.Fatalf("approval without App Check status = %d", unauthenticatedApproval.Code)
	}

	approvalResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+appNodeID+`","deliverySecret":"`+appDeliverySecret+`"}`, map[string]string{
		"X-Firebase-AppCheck": developmentAppCheckToken,
	})
	if approvalResponse.Code != http.StatusOK {
		t.Fatalf("approval status = %d, body = %s", approvalResponse.Code, approvalResponse.Body.String())
	}
	var approval broker.Approval
	decodeResponse(t, approvalResponse, &approval)
	firstAppRefreshToken := approval.Credential.RefreshToken
	retryApprovalResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+appNodeID+`","deliverySecret":"`+appDeliverySecret+`"}`, map[string]string{
		"X-Firebase-AppCheck": developmentAppCheckToken,
	})
	if retryApprovalResponse.Code != http.StatusOK {
		t.Fatalf("retry approval status = %d, body = %s", retryApprovalResponse.Code, retryApprovalResponse.Body.String())
	}
	decodeResponse(t, retryApprovalResponse, &approval)
	if approval.Credential.RefreshToken == firstAppRefreshToken {
		t.Fatal("approval redelivery reused the prior refresh credential")
	}
	wrongDeliverySecret := strings.Repeat("B", 42) + "A"
	unauthorizedRedelivery := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+appNodeID+`","deliverySecret":"`+wrongDeliverySecret+`"}`, map[string]string{
		"X-Firebase-AppCheck": developmentAppCheckToken,
	})
	if unauthorizedRedelivery.Code != http.StatusUnauthorized {
		t.Fatalf("wrong delivery secret status = %d, body = %s", unauthorizedRedelivery.Code, unauthorizedRedelivery.Body.String())
	}
	oldAppRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + firstAppRefreshToken,
	})
	if oldAppRefresh.Code != http.StatusUnauthorized {
		t.Fatalf("superseded app refresh status = %d, body = %s", oldAppRefresh.Code, oldAppRefresh.Body.String())
	}
	appClaims, err := service.signer.Verify(approval.Credential.AccessToken, service.now)
	if err != nil {
		t.Fatal(err)
	}
	if appClaims.Subject != appNodeID || appClaims.EndpointKind != "app" || appClaims.GrantID != approval.GrantID {
		t.Fatalf("unexpected app claims: %+v", appClaims)
	}

	exchangeResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claim.ClaimSecret,
	})
	if exchangeResponse.Code != http.StatusOK {
		t.Fatalf("exchange status = %d, body = %s", exchangeResponse.Code, exchangeResponse.Body.String())
	}
	var exchange broker.Exchange
	decodeResponse(t, exchangeResponse, &exchange)
	firstHostRefreshToken := exchange.Credential.RefreshToken
	retryExchangeResponse := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claim.ClaimSecret,
	})
	if retryExchangeResponse.Code != http.StatusOK {
		t.Fatalf("retry exchange status = %d, body = %s", retryExchangeResponse.Code, retryExchangeResponse.Body.String())
	}
	decodeResponse(t, retryExchangeResponse, &exchange)
	if exchange.Credential.RefreshToken == firstHostRefreshToken {
		t.Fatal("exchange redelivery reused the prior refresh credential")
	}
	oldHostRefresh := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + firstHostRefreshToken,
	})
	if oldHostRefresh.Code != http.StatusUnauthorized {
		t.Fatalf("superseded host refresh status = %d, body = %s", oldHostRefresh.Code, oldHostRefresh.Body.String())
	}
	hostClaims, err := service.signer.Verify(exchange.Credential.AccessToken, service.now)
	if err != nil {
		t.Fatal(err)
	}
	if hostClaims.Subject != hostNodeID || hostClaims.EndpointKind != "host" || hostClaims.GrantID != approval.GrantID {
		t.Fatalf("unexpected host claims: %+v", hostClaims)
	}

	refreshResponse := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + exchange.Credential.RefreshToken,
	})
	if refreshResponse.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", refreshResponse.Code, refreshResponse.Body.String())
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
		"Authorization": "Bearer " + exchange.Credential.RefreshToken,
	})
	if throttledRefresh.Code != http.StatusTooManyRequests || throttledRefresh.Header().Get("Retry-After") != "5" {
		t.Fatalf("throttled refresh status = %d, headers = %v, body = %s", throttledRefresh.Code, throttledRefresh.Header(), throttledRefresh.Body.String())
	}

	revokeResponse := service.request(t, http.MethodPost, "/v1/tokens/revoke", "", map[string]string{
		"Authorization": "Bearer " + exchange.Credential.RefreshToken,
	})
	if revokeResponse.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body = %s", revokeResponse.Code, revokeResponse.Body.String())
	}
	refreshAfterRevoke := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + exchange.Credential.RefreshToken,
	})
	if refreshAfterRevoke.Code != http.StatusUnauthorized {
		t.Fatalf("refresh after revoke status = %d, body = %s", refreshAfterRevoke.Code, refreshAfterRevoke.Body.String())
	}

	appStillRefreshes := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
		"Authorization": "Bearer " + approval.Credential.RefreshToken,
	})
	if appStillRefreshes.Code != http.StatusOK {
		t.Fatalf("app refresh after host revoke status = %d, body = %s", appStillRefreshes.Code, appStillRefreshes.Body.String())
	}
}

func TestPairingClaimsRejectConflictsExpiryAndMalformedInput(t *testing.T) {
	service := newTestService(t)
	hostNodeID := strings.Repeat("c", 64)
	appNodeID := strings.Repeat("d", 64)

	malformed := service.request(t, http.MethodPost, "/v1/pairing-claims", `{"hostNodeId":"`+hostNodeID+`","extra":true}`, nil)
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("unknown request field status = %d", malformed.Code)
	}

	create := service.request(t, http.MethodPost, "/v1/pairing-claims", `{"hostNodeId":"`+hostNodeID+`"}`, nil)
	var claim broker.PairingClaim
	decodeResponse(t, create, &claim)

	approveHeaders := map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken}
	first := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+appNodeID+`","deliverySecret":"`+appDeliverySecret+`"}`, approveHeaders)
	if first.Code != http.StatusOK {
		t.Fatalf("first approval status = %d, body = %s", first.Code, first.Body.String())
	}
	conflict := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/approve", `{"appNodeId":"`+strings.Repeat("e", 64)+`","deliverySecret":"`+appDeliverySecret+`"}`, approveHeaders)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflicting approval status = %d, body = %s", conflict.Code, conflict.Body.String())
	}

	service.now = service.now.Add(10 * time.Minute)
	expired := service.request(t, http.MethodPost, "/v1/pairing-claims/"+claim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + claim.ClaimSecret,
	})
	if expired.Code != http.StatusGone {
		t.Fatalf("expired claim status = %d, body = %s", expired.Code, expired.Body.String())
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

	response := service.request(t, http.MethodGet, "/healthz", "", nil)
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

	approveRequest := httptest.NewRequest(http.MethodPost, "/v1/pairing-claims/unknown/approve", bytes.NewBufferString(`{"appNodeId":"`+strings.Repeat("f", 64)+`","deliverySecret":"`+appDeliverySecret+`"}`))
	approveRequest.Header.Set("Content-Type", "application/json")
	approveRequest.Header.Add("X-Firebase-AppCheck", developmentAppCheckToken)
	approveRequest.Header.Add("X-Firebase-AppCheck", developmentAppCheckToken)
	approveResponse := httptest.NewRecorder()
	service.handler.ServeHTTP(approveResponse, approveRequest)
	if approveResponse.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate App Check status = %d, body = %s", approveResponse.Code, approveResponse.Body.String())
	}
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
