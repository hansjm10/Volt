package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

func TestHostAppEndpointRevocationRequiresValidHostAuthority(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		name := "expired host"
		if revoked {
			name = "revoked grant"
		}
		t.Run(name, func(t *testing.T) {
			service := newTestService(t)
			hostRefresh := testSecret("vrr_", 2)
			appRefresh := testSecret("vrr_", 3)
			claim := service.createBootstrapClaim(t, strings.Repeat("a", 64), testSecret("vpc_", 1), hostRefresh)
			approval := service.approveClaim(t, claim.ClaimID, strings.Repeat("b", 64), appRefresh)
			service.now = service.now.Add(30 * 24 * time.Hour)
			want := http.StatusGone
			if revoked {
				if err := service.handler.broker.RevokeGrant(context.Background(), hostRefresh); err != nil {
					t.Fatal(err)
				}
				want = http.StatusUnauthorized
			}
			response := service.request(t, http.MethodPost, "/v1/grant/endpoints/revoke", encodeBody(t, map[string]string{
				"endpointId": approval.EndpointID,
			}), map[string]string{"Authorization": "Bearer " + hostRefresh})
			if response.Code != want {
				t.Fatalf("revoke status = %d, want %d, body = %s", response.Code, want, response.Body.String())
			}
			if _, err := service.handler.broker.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, broker.ErrRefreshInvalid) {
				t.Fatalf("app refresh after host authority became terminal = %v", err)
			}
		})
	}
}

func TestHostAppEndpointRevocationDoesNotRequireSubscription(t *testing.T) {
	for _, status := range []appstore.Status{
		appstore.StatusExpired,
		appstore.StatusBillingRetry,
		appstore.StatusRevoked,
		appstore.StatusInactive,
		appstore.StatusActive, // An active status with an elapsed entitlement deadline is also inactive.
	} {
		t.Run(string(status), func(t *testing.T) {
			service := newTestService(t)
			hostRefresh := testSecret("vrr_", 2)
			appRefresh := testSecret("vrr_", 3)
			claimSecret := testSecret("vpc_", 1)
			claim := service.createBootstrapClaim(t, strings.Repeat("a", 64), claimSecret, hostRefresh)
			approval := service.approveClaim(t, claim.ClaimID, strings.Repeat("b", 64), appRefresh)
			exchange := service.exchangeClaim(t, claim.ClaimID, claimSecret)

			peerRefresh := testSecret("vrr_", 5)
			peerClaimResponse := service.request(t, http.MethodPost, "/v1/pairing-claims", encodeBody(t, map[string]string{
				"claimSecretHash": secretHash(testSecret("vpc_", 4)),
			}), map[string]string{"Authorization": "Bearer " + hostRefresh})
			if peerClaimResponse.Code != http.StatusCreated {
				t.Fatalf("peer claim status = %d, body = %s", peerClaimResponse.Code, peerClaimResponse.Body.String())
			}
			var peerClaim broker.PairingClaim
			decodeResponse(t, peerClaimResponse, &peerClaim)
			service.approveClaim(t, peerClaim.ClaimID, strings.Repeat("c", 64), peerRefresh)

			otherClaim := service.createBootstrapClaim(t, strings.Repeat("d", 64), testSecret("vpc_", 6), testSecret("vrr_", 7))
			otherApproval := service.approveClaimWithSubscription(t, otherClaim.ClaimID, strings.Repeat("e", 64), testSecret("vrr_", 8), "subscription-other")

			service.now = service.now.Add(time.Minute)
			entitlement := appstore.Entitlement{
				AppTransactionID: defaultSubscriptionID,
				Environment:      "Sandbox",
				Status:           status,
				EntitledUntil:    service.now,
				SourceSignedAt:   service.now,
				VerifiedAt:       service.now,
			}
			if err := service.handler.broker.ApplyEntitlementReconciliation(context.Background(), entitlement); err != nil {
				t.Fatal(err)
			}
			// Exercise the broker directly so the HTTP fixture's automatic renewal does not mask suspension.
			if _, err := service.handler.broker.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, broker.ErrSubscriptionRequired) {
				t.Fatalf("inactive app refresh error = %v", err)
			}
			for _, request := range []struct {
				path  string
				body  string
				token string
			}{
				{path: "/v1/pairing-claims", body: encodeBody(t, map[string]string{"claimSecretHash": secretHash(testSecret("vpc_", 9))}), token: hostRefresh},
				{path: "/v1/pairing-claims/" + claim.ClaimID + "/exchange", token: claimSecret},
			} {
				response := service.request(t, http.MethodPost, request.path, request.body, map[string]string{"Authorization": "Bearer " + request.token})
				if response.Code != http.StatusPaymentRequired {
					t.Fatalf("inactive %s status = %d, body = %s", request.path, response.Code, response.Body.String())
				}
			}

			for _, test := range []struct {
				name       string
				token      string
				endpointID string
				want       int
			}{
				{name: "unknown credential", token: testSecret("vrr_", 10), endpointID: approval.EndpointID, want: http.StatusUnauthorized},
				{name: "app credential", token: appRefresh, endpointID: approval.EndpointID, want: http.StatusForbidden},
				{name: "host target", token: hostRefresh, endpointID: exchange.EndpointID, want: http.StatusForbidden},
				{name: "other grant", token: hostRefresh, endpointID: otherApproval.EndpointID, want: http.StatusForbidden},
				{name: "revoke", token: hostRefresh, endpointID: approval.EndpointID, want: http.StatusNoContent},
				{name: "retry", token: hostRefresh, endpointID: approval.EndpointID, want: http.StatusNoContent},
			} {
				response := service.request(t, http.MethodPost, "/v1/grant/endpoints/revoke", encodeBody(t, map[string]string{
					"endpointId": test.endpointID,
				}), map[string]string{"Authorization": "Bearer " + test.token})
				if response.Code != test.want {
					t.Fatalf("%s status = %d, want %d, body = %s", test.name, response.Code, test.want, response.Body.String())
				}
			}
			if _, err := service.handler.broker.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, broker.ErrRefreshInvalid) {
				t.Fatalf("revoked app refresh while inactive = %v", err)
			}

			service.now = service.now.Add(time.Minute)
			entitlement.Status = appstore.StatusActive
			entitlement.EntitledUntil = service.now.Add(24 * time.Hour)
			entitlement.SourceSignedAt = service.now
			entitlement.VerifiedAt = service.now
			if err := service.handler.broker.ApplyEntitlementReconciliation(context.Background(), entitlement); err != nil {
				t.Fatal(err)
			}
			for _, test := range []struct {
				name  string
				token string
				want  int
			}{
				{name: "revoked app", token: appRefresh, want: http.StatusUnauthorized},
				{name: "host", token: hostRefresh, want: http.StatusOK},
				{name: "peer app", token: peerRefresh, want: http.StatusOK},
			} {
				response := service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + test.token})
				if response.Code != test.want {
					t.Fatalf("%s refresh after renewal = %d, want %d, body = %s", test.name, response.Code, test.want, response.Body.String())
				}
			}
		})
	}
}
