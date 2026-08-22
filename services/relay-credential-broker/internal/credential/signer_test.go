package credential

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignerIssuesAndVerifiesNodeBoundToken(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner("https://credentials.volt.test", "volt-iroh-relay", private)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	nodeID := strings.Repeat("a", 64)
	token, expiresAt, err := signer.Issue(nodeID, "host", "grant_identifier_one", "jwt_identifier_one", now, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if want := now.Add(15 * time.Minute); !expiresAt.Equal(want) {
		t.Fatalf("expiresAt = %s, want %s", expiresAt, want)
	}

	claims, err := signer.Verify(token, now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != nodeID || claims.EndpointKind != "host" || claims.GrantID != "grant_identifier_one" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if _, err := signer.Verify(token+"x", now); err == nil {
		t.Fatal("tampered token verified")
	}
	if _, err := signer.Verify(token, expiresAt.Add(relayClockSkew+time.Second)); err == nil {
		t.Fatal("expired token verified")
	}
}

func TestSignerRejectsClaimsTheRelayWouldReject(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner("https://credentials.volt.test", "volt-iroh-relay", private)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	nodeID := strings.Repeat("a", 64)
	validGrantID := "grant_identifier_one"
	validJWTID := "jwt_identifier_one"

	tests := []struct {
		name         string
		subject      string
		endpointKind string
		grantID      string
		jwtID        string
		ttl          time.Duration
	}{
		{name: "subject", subject: strings.Repeat("A", 64), endpointKind: "host", grantID: validGrantID, jwtID: validJWTID, ttl: time.Minute},
		{name: "endpoint kind", subject: nodeID, endpointKind: "desktop", grantID: validGrantID, jwtID: validJWTID, ttl: time.Minute},
		{name: "grant ID", subject: nodeID, endpointKind: "host", grantID: "short", jwtID: validJWTID, ttl: time.Minute},
		{name: "JWT ID", subject: nodeID, endpointKind: "host", grantID: validGrantID, jwtID: "contains space value", ttl: time.Minute},
		{name: "subsecond TTL", subject: nodeID, endpointKind: "host", grantID: validGrantID, jwtID: validJWTID, ttl: time.Millisecond},
		{name: "excess TTL", subject: nodeID, endpointKind: "host", grantID: validGrantID, jwtID: validJWTID, ttl: maxAccessTokenTTL + time.Second},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := signer.Issue(test.subject, test.endpointKind, test.grantID, test.jwtID, now, test.ttl); err == nil {
				t.Fatal("relay-incompatible claim was issued")
			}
		})
	}
}

func TestSignerInteropVector(t *testing.T) {
	signingSeed := make([]byte, ed25519.SeedSize)
	endpointSeed := make([]byte, ed25519.SeedSize)
	for index := range signingSeed {
		signingSeed[index] = 7
		endpointSeed[index] = 9
	}
	signingPrivate := ed25519.NewKeyFromSeed(signingSeed)
	endpointPrivate := ed25519.NewKeyFromSeed(endpointSeed)
	nodeID := hex.EncodeToString(endpointPrivate.Public().(ed25519.PublicKey))
	signer, err := NewSigner("https://credentials.volt.test", "volt-iroh-relay-canary", signingPrivate)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := signer.Issue(
		nodeID,
		"host",
		"grant_identifier_one",
		"jwt_identifier_one",
		time.Unix(1_787_313_600, 0).UTC(),
		15*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}

	const expectedToken = "eyJhbGciOiJFZERTQSIsImtpZCI6Il9vRXNFdk9yVE9hc1hiYWEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL2NyZWRlbnRpYWxzLnZvbHQudGVzdCIsImF1ZCI6InZvbHQtaXJvaC1yZWxheS1jYW5hcnkiLCJzdWIiOiJmZDE3MjQzODVhYTBjNzViNjRmYjc4Y2Q2MDJmYTFkOTkxZmRlYmY3NmIxM2M1OGVkNzAyZWFjODM1ZTlmNjE4IiwiZXhwIjoxNzg3MzE0NTAwLCJpYXQiOjE3ODczMTM2MDAsImp0aSI6Imp3dF9pZGVudGlmaWVyX29uZSIsInNjb3BlIjoicmVsYXk6Y29ubmVjdCIsImVuZHBvaW50X2tpbmQiOiJob3N0IiwiZ3JhbnRfaWQiOiJncmFudF9pZGVudGlmaWVyX29uZSJ9.S0Eq4fPo1jq1ZUvASpZiE_6Grdx2Mb_iCkbtMLXxQktkJKSvriAc1CCISYwzd6ynPJKbNdcmnokG71jWpGvwCA"
	if token != expectedToken {
		t.Fatalf("interop token changed:\n%s", token)
	}
	if signer.KeyID() != "_oEsEvOrTOasXbaa" {
		t.Fatalf("interop key ID changed: %s", signer.KeyID())
	}
	if publicKey := base64.RawURLEncoding.EncodeToString(signingPrivate.Public().(ed25519.PublicKey)); publicKey != "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw" {
		t.Fatalf("interop public key changed: %s", publicKey)
	}
}

func TestLoadOrCreateSignerPersistsPrivateSeed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "signing-key")
	first, err := LoadOrCreateSigner("https://credentials.volt.test", "volt-iroh-relay", path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("signing key mode = %04o, want 0600", got)
	}

	second, err := LoadOrCreateSigner("https://credentials.volt.test", "volt-iroh-relay", path)
	if err != nil {
		t.Fatal(err)
	}
	if first.KeyID() != second.KeyID() {
		t.Fatalf("key ID changed across reload: %q != %q", first.KeyID(), second.KeyID())
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateSigner("https://credentials.volt.test", "volt-iroh-relay", path); err == nil {
		t.Fatal("over-permissive signing key file was accepted")
	}
}
