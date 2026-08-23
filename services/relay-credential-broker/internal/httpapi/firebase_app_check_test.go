package httpapi

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"firebase.google.com/go/v4/appcheck"
)

const (
	testFirebaseProjectNumber = "546623825529"
	testFirebaseAppID         = "1:546623825529:ios:9f5a707e3f4ef89154d6a8"
)

func TestFirebaseAppCheckVerifierUsesFirebaseAdminAndReturnsReplayMetadata(t *testing.T) {
	key := generateRSAKey(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		writeJSON(writer, http.StatusOK, testAppCheckJWKS{
			Keys: []testAppCheckJWK{jwkFor(&key.PublicKey, "key-one")},
		})
	}))
	defer server.Close()

	originalJWKSURL := appcheck.JWKSUrl
	appcheck.JWKSUrl = server.URL
	defer func() { appcheck.JWKSUrl = originalJWKSURL }()

	now := time.Now().UTC().Truncate(time.Second)
	verifier, err := NewFirebaseAppCheckVerifier(FirebaseAppCheckConfig{
		ProjectNumber: testFirebaseProjectNumber,
		AllowedAppIDs: []string{testFirebaseAppID},
		Now:           func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	token := signAppCheckToken(t, key, "key-one", validAppCheckClaims(now, nil))
	request := httptest.NewRequest(http.MethodPost, "/approve", nil)
	request.Header.Set("X-Firebase-AppCheck", token)

	verified, err := verifier.Verify(request)
	if err != nil {
		t.Fatal(err)
	}
	if verified.AppID != testFirebaseAppID || !verified.ReplayProtected || !verified.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("unexpected verified App Check metadata: %+v", verified)
	}
	expectedJTIHash := sha256.Sum256([]byte("limited-use-token-identifier-one"))
	if verified.JTIHash != expectedJTIHash {
		t.Fatalf("jti hash = %x, want %x", verified.JTIHash, expectedJTIHash)
	}
	if _, err := verifier.Verify(request); err != nil {
		t.Fatalf("Firebase Admin rejected a second stateless verification: %v", err)
	}
	forgedToken := signAppCheckToken(t, generateRSAKey(t), "key-one", validAppCheckClaims(now, map[string]any{
		"jti": "limited-use-token-identifier-forged",
	}))
	request.Header.Set("X-Firebase-AppCheck", forgedToken)
	if _, err := verifier.Verify(request); err == nil {
		t.Fatal("Firebase Admin accepted a forged signature")
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("JWKS request count = %d, want 1", got)
	}
}

func TestFirebaseAppCheckVerifierRejectsInvalidVerifiedClaims(t *testing.T) {
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*appcheck.DecodedAppCheckToken)
	}{
		{
			name: "issuer",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.Issuer = "https://firebaseappcheck.googleapis.com/wrong"
			},
		},
		{
			name: "audience",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.Audience = []string{"projects/wrong"}
			},
		},
		{
			name: "app ID",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.AppID = "wrong-app"
				token.Subject = "wrong-app"
			},
		},
		{
			name: "subject mismatch",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.Subject = "wrong-app"
			},
		},
		{
			name: "expiry",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.ExpiresAt = now
			},
		},
		{
			name: "future issue time",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.IssuedAt = now.Add(time.Second)
			},
		},
		{
			name: "excessive lifetime",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.IssuedAt = now.Add(-8 * 24 * time.Hour)
			},
		},
		{
			name: "missing limited-use jti",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				delete(token.Claims, "jti")
			},
		},
		{
			name: "non-string limited-use jti",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.Claims["jti"] = float64(1)
			},
		},
		{
			name: "malformed limited-use jti",
			mutate: func(token *appcheck.DecodedAppCheckToken) {
				token.Claims["jti"] = "contains whitespace"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			decoded := validDecodedAppCheckToken(now)
			test.mutate(decoded)
			verifier := newFakeFirebaseVerifier(t, now, &fakeFirebaseTokenVerifier{decoded: decoded})
			request := httptest.NewRequest(http.MethodPost, "/approve", nil)
			request.Header.Set("X-Firebase-AppCheck", "firebase-admin-verified-token")
			if _, err := verifier.Verify(request); err == nil {
				t.Fatal("invalid App Check token metadata was accepted")
			}
		})
	}
}

func TestFirebaseAppCheckVerifierRejectsAdminFailures(t *testing.T) {
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		client *fakeFirebaseTokenVerifier
	}{
		{name: "error", client: &fakeFirebaseTokenVerifier{err: errors.New("verification failed")}},
		{name: "nil token", client: &fakeFirebaseTokenVerifier{}},
		{name: "panic", client: &fakeFirebaseTokenVerifier{panicValue: "malformed claims"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := newFakeFirebaseVerifier(t, now, test.client)
			request := httptest.NewRequest(http.MethodPost, "/approve", nil)
			request.Header.Set("X-Firebase-AppCheck", "untrusted-token")
			if _, err := verifier.Verify(request); err == nil {
				t.Fatal("Firebase Admin failure was accepted")
			}
		})
	}
}

func TestFirebaseAppCheckVerifierRequiresOneBoundedHeader(t *testing.T) {
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	client := &fakeFirebaseTokenVerifier{decoded: validDecodedAppCheckToken(now)}
	verifier := newFakeFirebaseVerifier(t, now, client)
	tests := []struct {
		name   string
		values []string
	}{
		{name: "missing"},
		{name: "empty", values: []string{""}},
		{name: "duplicate", values: []string{"one", "two"}},
		{name: "comma", values: []string{"one,two"}},
		{name: "oversized", values: []string{strings.Repeat("a", maxAppCheckTokenBytes+1)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/approve", nil)
			for _, value := range test.values {
				request.Header.Add("X-Firebase-AppCheck", value)
			}
			if _, err := verifier.Verify(request); err == nil {
				t.Fatal("invalid App Check header was accepted")
			}
		})
	}
	if client.calls != 0 {
		t.Fatalf("Firebase Admin call count = %d, want 0", client.calls)
	}
}

func newFakeFirebaseVerifier(
	t *testing.T,
	now time.Time,
	client firebaseAppCheckTokenVerifier,
) *FirebaseAppCheckVerifier {
	t.Helper()
	verifier, err := newFirebaseAppCheckVerifier(context.Background(), FirebaseAppCheckConfig{
		ProjectNumber: testFirebaseProjectNumber,
		AllowedAppIDs: []string{testFirebaseAppID},
		Now:           func() time.Time { return now },
	}, client)
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}

type fakeFirebaseTokenVerifier struct {
	decoded    *appcheck.DecodedAppCheckToken
	err        error
	panicValue any
	calls      int
}

func (v *fakeFirebaseTokenVerifier) VerifyToken(string) (*appcheck.DecodedAppCheckToken, error) {
	v.calls++
	if v.panicValue != nil {
		panic(v.panicValue)
	}
	return v.decoded, v.err
}

func validDecodedAppCheckToken(now time.Time) *appcheck.DecodedAppCheckToken {
	return &appcheck.DecodedAppCheckToken{
		Issuer:    "https://firebaseappcheck.googleapis.com/" + testFirebaseProjectNumber,
		Subject:   testFirebaseAppID,
		Audience:  []string{"projects/" + testFirebaseProjectNumber},
		ExpiresAt: now.Add(time.Hour),
		IssuedAt:  now,
		AppID:     testFirebaseAppID,
		Claims: map[string]interface{}{
			"jti": "limited-use-token-identifier-one",
		},
	}
}

func validAppCheckClaims(now time.Time, overrides map[string]any) map[string]any {
	claims := map[string]any{
		"iss": "https://firebaseappcheck.googleapis.com/" + testFirebaseProjectNumber,
		"sub": testFirebaseAppID,
		"aud": []string{"projects/" + testFirebaseProjectNumber},
		"exp": now.Add(time.Hour).Unix(),
		"iat": now.Unix(),
		"jti": "limited-use-token-identifier-one",
	}
	for key, value := range overrides {
		claims[key] = value
	}
	return claims
}

func signAppCheckToken(
	t *testing.T,
	key *rsa.PrivateKey,
	keyID string,
	claims map[string]any,
) string {
	t.Helper()
	headerBytes, err := json.Marshal(map[string]string{
		"alg": "RS256",
		"kid": keyID,
		"typ": "JWT",
	})
	if err != nil {
		t.Fatal(err)
	}
	claimsBytes, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString(headerBytes)
	payload := base64.RawURLEncoding.EncodeToString(claimsBytes)
	digest := sha256.Sum256([]byte(header + "." + payload))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%s.%s.%s", header, payload, base64.RawURLEncoding.EncodeToString(signature))
}

type testAppCheckJWKS struct {
	Keys []testAppCheckJWK `json:"keys"`
}

type testAppCheckJWK struct {
	Algorithm string `json:"alg"`
	Exponent  string `json:"e"`
	KeyID     string `json:"kid"`
	KeyType   string `json:"kty"`
	Modulus   string `json:"n"`
	Use       string `json:"use"`
}

func jwkFor(key *rsa.PublicKey, keyID string) testAppCheckJWK {
	exponent := bigEndianExponent(key.E)
	return testAppCheckJWK{
		Algorithm: "RS256",
		Exponent:  base64.RawURLEncoding.EncodeToString(exponent),
		KeyID:     keyID,
		KeyType:   "RSA",
		Modulus:   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		Use:       "sig",
	}
}

func bigEndianExponent(value int) []byte {
	var bytes [4]byte
	index := len(bytes)
	for value > 0 {
		index--
		bytes[index] = byte(value)
		value >>= 8
	}
	return bytes[index:]
}

func generateRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}
