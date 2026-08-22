package pairingticket

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeForAppRemovesOnlyRelayCredential(t *testing.T) {
	original := encodeTestTicket(t, map[string]any{
		"alpn":           "volt-rpc/0",
		"expiresAt":      1_787_314_500_000,
		"irohTicket":     "endpoint-ticket",
		"nodeId":         strings.Repeat("a", 64),
		"relayMode":      "production",
		"relayUrls":      []string{"https://iroh-relay-us-central-canary.volt-cli.dev"},
		"relayAuthToken": "host-node-bound-jwt",
		"secret":         "one-time-pairing-secret",
		"workspace":      "canary",
		"futureField":    map[string]any{"preserved": true},
	})

	sanitized, err := SanitizeForApp(original)
	if err != nil {
		t.Fatalf("SanitizeForApp() error = %v", err)
	}
	payload := decodeTestTicket(t, sanitized)
	if _, ok := payload["relayAuthToken"]; ok {
		t.Fatal("sanitized ticket retained relayAuthToken")
	}
	if got := payload["secret"]; got != "one-time-pairing-secret" {
		t.Fatalf("secret = %#v", got)
	}
	future, ok := payload["futureField"].(map[string]any)
	if !ok || future["preserved"] != true {
		t.Fatalf("futureField = %#v", payload["futureField"])
	}
}

func TestSanitizeForAppAcceptsAlreadySanitizedTicket(t *testing.T) {
	ticket := encodeTestTicket(t, map[string]any{
		"alpn":       "volt-rpc/0",
		"irohTicket": "endpoint-ticket",
		"secret":     "one-time-pairing-secret",
		"workspace":  "canary",
	})

	if _, err := SanitizeForApp(ticket); err != nil {
		t.Fatalf("SanitizeForApp() error = %v", err)
	}
}

func TestSanitizeForAppRejectsInvalidTickets(t *testing.T) {
	validPayload := map[string]any{
		"alpn":       "volt-rpc/0",
		"irohTicket": "endpoint-ticket",
		"secret":     "one-time-pairing-secret",
		"workspace":  "canary",
	}
	tests := map[string]string{
		"wrong prefix":      "https://example.com/ticket",
		"invalid base64url": Prefix + "***",
		"non-object":        Prefix + base64.RawURLEncoding.EncodeToString([]byte(`[]`)),
		"missing secret": encodeTestTicket(t, map[string]any{
			"alpn":       "volt-rpc/0",
			"irohTicket": "endpoint-ticket",
			"workspace":  "canary",
		}),
		"trailing data": Prefix + base64.RawURLEncoding.EncodeToString([]byte(`{"alpn":"volt-rpc/0"}{}`)),
		"too large":     Prefix + strings.Repeat("a", MaxTicketSize),
		"empty payload": Prefix,
	}
	validPayload["workspace"] = ""
	tests["empty field"] = encodeTestTicket(t, validPayload)

	for name, ticket := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := SanitizeForApp(ticket); err == nil {
				t.Fatal("SanitizeForApp() error = nil")
			}
		})
	}
}

func encodeTestTicket(t *testing.T, payload map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeTestTicket(t *testing.T, ticket string) map[string]any {
	t.Helper()
	encoded := strings.TrimPrefix(ticket, Prefix)
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(decoded, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}
