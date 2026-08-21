package httpapi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testFirebaseProjectNumber = "546623825529"
	testFirebaseAppID         = "1:546623825529:ios:9f5a707e3f4ef89154d6a8"
)

func TestFirebaseAppCheckVerifierAcceptsOnceAndCachesKeys(t *testing.T) {
	key := generateRSAKey(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		writer.Header().Set("Cache-Control", "public, max-age=3600")
		writeJSON(writer, http.StatusOK, appCheckJWKS{
			Keys: []appCheckJWK{jwkFor(&key.PublicKey, "key-one")},
		})
	}))
	defer server.Close()

	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	verifier := newFirebaseVerifier(t, server, now)
	token := signAppCheckToken(t, key, "key-one", map[string]any{
		"iss": "https://firebaseappcheck.googleapis.com/" + testFirebaseProjectNumber,
		"sub": testFirebaseAppID,
		"aud": []string{"projects/" + testFirebaseProjectNumber},
		"exp": now.Add(time.Hour).Unix(),
		"iat": now.Unix(),
		"jti": "limited-use-token-identifier-one",
	})

	request := httptest.NewRequest(http.MethodPost, "/approve", nil)
	request.Header.Set("X-Firebase-AppCheck", token)
	appID, err := verifier.Verify(request)
	if err != nil {
		t.Fatal(err)
	}
	if appID != testFirebaseAppID {
		t.Fatalf("app ID = %q, want %q", appID, testFirebaseAppID)
	}
	if _, err := verifier.Verify(request); err == nil {
		t.Fatal("replayed limited-use token was accepted")
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("JWKS request count = %d, want 1", got)
	}
}

func TestFirebaseAppCheckVerifierRejectsWrongAuthorityAndMissingJTI(t *testing.T) {
	key := generateRSAKey(t)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, appCheckJWKS{
			Keys: []appCheckJWK{jwkFor(&key.PublicKey, "key-one")},
		})
	}))
	defer server.Close()
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name   string
		claims map[string]any
	}{
		{
			name: "issuer",
			claims: validAppCheckClaims(now, map[string]any{
				"iss": "https://firebaseappcheck.googleapis.com/wrong",
			}),
		},
		{
			name: "audience",
			claims: validAppCheckClaims(now, map[string]any{
				"aud": []string{"projects/wrong"},
			}),
		},
		{
			name: "app ID",
			claims: validAppCheckClaims(now, map[string]any{
				"sub": "wrong-app",
			}),
		},
		{
			name: "expiry",
			claims: validAppCheckClaims(now, map[string]any{
				"exp": now.Unix(),
			}),
		},
		{
			name: "missing limited-use jti",
			claims: validAppCheckClaims(now, map[string]any{
				"jti": "",
			}),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := newFirebaseVerifier(t, server, now)
			token := signAppCheckToken(t, key, "key-one", test.claims)
			request := httptest.NewRequest(http.MethodPost, "/approve", nil)
			request.Header.Set("X-Firebase-AppCheck", token)
			if _, err := verifier.Verify(request); err == nil {
				t.Fatal("invalid App Check token was accepted")
			}
		})
	}
}

func TestFirebaseAppCheckVerifierRefreshesUnknownKey(t *testing.T) {
	firstKey := generateRSAKey(t)
	secondKey := generateRSAKey(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requestNumber := requests.Add(1)
		key := jwkFor(&firstKey.PublicKey, "key-one")
		if requestNumber > 1 {
			key = jwkFor(&secondKey.PublicKey, "key-two")
		}
		writeJSON(writer, http.StatusOK, appCheckJWKS{Keys: []appCheckJWK{key}})
	}))
	defer server.Close()
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	verifier := newFirebaseVerifier(t, server, now)
	token := signAppCheckToken(
		t,
		secondKey,
		"key-two",
		validAppCheckClaims(now, nil),
	)
	request := httptest.NewRequest(http.MethodPost, "/approve", nil)
	request.Header.Set("X-Firebase-AppCheck", token)
	if _, err := verifier.Verify(request); err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("JWKS request count = %d, want 2", got)
	}
}

func TestFirebaseAppCheckVerifierThrottlesRepeatedUnknownKeyRefresh(t *testing.T) {
	key := generateRSAKey(t)
	unknownKey := generateRSAKey(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		writer.Header().Set("Cache-Control", "public, max-age=3600")
		writeJSON(writer, http.StatusOK, appCheckJWKS{
			Keys: []appCheckJWK{jwkFor(&key.PublicKey, "known-key")},
		})
	}))
	defer server.Close()

	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	verifier := newFirebaseVerifier(t, server, now)
	for index := 0; index < 2; index++ {
		token := signAppCheckToken(
			t,
			unknownKey,
			fmt.Sprintf("unknown-key-%d", index),
			validAppCheckClaims(now, map[string]any{
				"jti": fmt.Sprintf("limited-use-token-identifier-%d", index),
			}),
		)
		request := httptest.NewRequest(http.MethodPost, "/approve", nil)
		request.Header.Set("X-Firebase-AppCheck", token)
		if _, err := verifier.Verify(request); err == nil {
			t.Fatal("unknown Firebase signing key was accepted")
		}
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("JWKS request count = %d, want 2", got)
	}
}

func newFirebaseVerifier(
	t *testing.T,
	server *httptest.Server,
	now time.Time,
) *FirebaseAppCheckVerifier {
	t.Helper()
	verifier, err := NewFirebaseAppCheckVerifier(FirebaseAppCheckConfig{
		ProjectNumber:  testFirebaseProjectNumber,
		AllowedAppIDs:  []string{testFirebaseAppID},
		JWKSURL:        server.URL,
		HTTPClient:     server.Client(),
		Now:            func() time.Time { return now },
		MaxConsumedJTI: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	return verifier
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

func jwkFor(key *rsa.PublicKey, keyID string) appCheckJWK {
	exponent := bigEndianExponent(key.E)
	return appCheckJWK{
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
