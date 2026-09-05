package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

func TestDevelopmentApprovalsHaveDistinctReplayIdentities(t *testing.T) {
	service := newTestService(t)
	sharedSecret := "development-app-store-proof-at-least-32-bytes"
	verifier, err := appstore.NewDevelopmentVerifier(sharedSecret, func() time.Time { return service.now })
	if err != nil {
		t.Fatal(err)
	}
	service.handler.appStore = verifier
	proof := strings.Repeat("ab", 32) + "." + sharedSecret
	otherDeviceID := "22222222-2222-4222-8222-222222222222"
	approve := func(claimID, signedProof, deviceID, appNodeID, appRefresh string) *httptest.ResponseRecorder {
		t.Helper()
		return service.request(t, http.MethodPost, "/v1/pairing-claims/"+claimID+"/approve", encodeBody(t, map[string]string{
			"appNodeId":                    appNodeID,
			"appRefreshTokenHash":          secretHash(appRefresh),
			"signedAppTransaction":         signedProof,
			"appStoreDeviceVerificationId": deviceID,
		}), map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	}

	firstClaimSecret := testSecret("vpc_", 1)
	firstHostRefresh := testSecret("vrr_", 2)
	firstAppRefresh := testSecret("vrr_", 3)
	firstAppNode := strings.Repeat("b", 64)
	firstClaim := service.createBootstrapClaim(t, strings.Repeat("a", 64), firstClaimSecret, firstHostRefresh)
	firstResponse := approve(firstClaim.ClaimID, proof, testDeviceVerificationID, firstAppNode, firstAppRefresh)
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first approval status = %d, body = %s", firstResponse.Code, firstResponse.Body.String())
	}
	var first broker.Approval
	decodeResponse(t, firstResponse, &first)
	service.exchangeClaim(t, firstClaim.ClaimID, firstClaimSecret)

	// Reusing the nonce on a different device must not collide or move the first subscription.
	otherClaimSecret := testSecret("vpc_", 4)
	otherHostRefresh := testSecret("vrr_", 5)
	otherAppRefresh := testSecret("vrr_", 6)
	otherClaim := service.createBootstrapClaim(t, strings.Repeat("c", 64), otherClaimSecret, otherHostRefresh)
	otherResponse := approve(otherClaim.ClaimID, proof, otherDeviceID, strings.Repeat("d", 64), otherAppRefresh)
	if otherResponse.Code != http.StatusOK {
		t.Fatalf("different-device approval status = %d, body = %s", otherResponse.Code, otherResponse.Body.String())
	}
	var other broker.Approval
	decodeResponse(t, otherResponse, &other)
	if first.GrantID == other.GrantID || first.EndpointID == other.EndpointID {
		t.Fatal("independent devices did not receive independent grants and endpoints")
	}
	service.exchangeClaim(t, otherClaim.ClaimID, otherClaimSecret)

	service.now = service.now.Add(time.Second)
	verifier, err = appstore.NewDevelopmentVerifier(sharedSecret, func() time.Time { return service.now })
	if err != nil {
		t.Fatal(err)
	}
	service.handler.appStore = verifier
	retryResponse := approve(firstClaim.ClaimID, proof, testDeviceVerificationID, firstAppNode, firstAppRefresh)
	if retryResponse.Code != http.StatusOK {
		t.Fatalf("retry after verifier recreation status = %d, body = %s", retryResponse.Code, retryResponse.Body.String())
	}
	var retry broker.Approval
	decodeResponse(t, retryResponse, &retry)
	if retry.GrantID != first.GrantID || retry.EndpointID != first.EndpointID ||
		retry.AppNodeID != first.AppNodeID || retry.HostNodeID != first.HostNodeID ||
		retry.Credential.AccessToken == first.Credential.AccessToken {
		t.Fatal("retry must retain authority while issuing a fresh JWT")
	}
	if _, err := service.signer.Verify(retry.Credential.AccessToken, service.now); err != nil {
		t.Fatalf("invalid retry JWT: %v", err)
	}

	for _, test := range []struct {
		name       string
		appNode    string
		appRefresh string
	}{
		{"changed node", strings.Repeat("7", 64), firstAppRefresh},
		{"changed refresh hash", firstAppNode, testSecret("vrr_", 10)},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := approve(firstClaim.ClaimID, proof, testDeviceVerificationID, test.appNode, test.appRefresh)
			var body errorResponse
			decodeResponse(t, response, &body)
			if response.Code != http.StatusConflict || body.Error != "claim_conflict" {
				t.Fatalf("conflicting retry status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	service.now = service.now.Add(time.Second)
	newClaimSecret := testSecret("vpc_", 7)
	newHostRefresh := testSecret("vrr_", 8)
	newAppRefresh := testSecret("vrr_", 9)
	newAppNode := strings.Repeat("f", 64)
	newClaim := service.createBootstrapClaim(t, strings.Repeat("e", 64), newClaimSecret, newHostRefresh)
	replay := approve(newClaim.ClaimID, proof, testDeviceVerificationID, newAppNode, newAppRefresh)
	var replayError errorResponse
	decodeResponse(t, replay, &replayError)
	if replay.Code != http.StatusConflict || replayError.Error != "app_store_proof_replayed" {
		t.Fatalf("cross-claim replay status = %d, body = %s", replay.Code, replay.Body.String())
	}
	pending := service.request(t, http.MethodPost, "/v1/pairing-claims/"+newClaim.ClaimID+"/exchange", "", map[string]string{
		"Authorization": "Bearer " + newClaimSecret,
	})
	if pending.Code != http.StatusAccepted {
		t.Fatalf("replay changed pending claim: status = %d, body = %s", pending.Code, pending.Body.String())
	}
	// A rejected replay must not revoke the previously approved authority.
	service.exchangeClaim(t, firstClaim.ClaimID, firstClaimSecret)

	freshProof := strings.Repeat("cd", 32) + "." + sharedSecret
	newResponse := approve(newClaim.ClaimID, freshProof, testDeviceVerificationID, newAppNode, newAppRefresh)
	if newResponse.Code != http.StatusOK {
		t.Fatalf("same-device fresh proof status = %d, body = %s", newResponse.Code, newResponse.Body.String())
	}
	var replacement broker.Approval
	decodeResponse(t, newResponse, &replacement)
	if replacement.GrantID == first.GrantID || replacement.EndpointID == first.EndpointID {
		t.Fatal("new daemon pairing did not create replacement authority")
	}
	exchange := service.exchangeClaim(t, newClaim.ClaimID, newClaimSecret)
	if exchange.GrantID != replacement.GrantID || exchange.AppEndpointID != replacement.EndpointID {
		t.Fatal("new claim exchange did not return the replacement authority")
	}
	for label, token := range map[string]string{
		"old host": firstHostRefresh,
		"old app":  firstAppRefresh,
	} {
		response := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
			"Authorization": "Bearer " + token,
		})
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s was not revoked after transfer: status = %d, body = %s", label, response.Code, response.Body.String())
		}
	}
	for label, token := range map[string]string{
		"new host":   newHostRefresh,
		"new app":    newAppRefresh,
		"other host": otherHostRefresh,
		"other app":  otherAppRefresh,
	} {
		response := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{
			"Authorization": "Bearer " + token,
		})
		if response.Code != http.StatusOK {
			t.Fatalf("%s lost authority: status = %d, body = %s", label, response.Code, response.Body.String())
		}
	}
}
