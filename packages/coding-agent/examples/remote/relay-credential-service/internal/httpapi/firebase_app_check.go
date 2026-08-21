package httpapi

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	firebaseAppCheckJWKSURL       = "https://firebaseappcheck.googleapis.com/v1/jwks"
	maxAppCheckTokenBytes         = 8 * 1024
	maxAppCheckJWKSBytes          = 64 * 1024
	maxAppCheckKeys               = 16
	maxAppCheckKeyCacheTTL        = 6 * time.Hour
	defaultAppCheckKeyCacheTTL    = time.Hour
	maxAppCheckTokenLifetime      = 7 * 24 * time.Hour
	maxAppCheckClockSkew          = 30 * time.Second
	minForcedJWKSRefreshInterval  = 30 * time.Second
	defaultConsumedAppCheckJTICap = 10_000
)

type FirebaseAppCheckConfig struct {
	ProjectNumber  string
	AllowedAppIDs  []string
	JWKSURL        string
	HTTPClient     *http.Client
	Now            func() time.Time
	MaxConsumedJTI int
}

type FirebaseAppCheckVerifier struct {
	projectNumber  string
	issuer         string
	audience       string
	allowedAppIDs  map[string]struct{}
	jwksURL        string
	httpClient     *http.Client
	now            func() time.Time
	maxConsumedJTI int

	keysMu            sync.Mutex
	keys              map[string]*rsa.PublicKey
	keysExpiresAt     time.Time
	nextForcedRefresh time.Time

	consumedMu sync.Mutex
	consumed   map[string]time.Time
}

type appCheckJWTHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Type      string `json:"typ"`
}

type appCheckJWTClaims struct {
	Issuer    string           `json:"iss"`
	Subject   string           `json:"sub"`
	Audience  appCheckAudience `json:"aud"`
	ExpiresAt int64            `json:"exp"`
	IssuedAt  int64            `json:"iat"`
	JWTID     string           `json:"jti"`
}

type appCheckAudience []string

type appCheckJWKS struct {
	Keys []appCheckJWK `json:"keys"`
}

type appCheckJWK struct {
	Algorithm string `json:"alg"`
	Exponent  string `json:"e"`
	KeyID     string `json:"kid"`
	KeyType   string `json:"kty"`
	Modulus   string `json:"n"`
	Use       string `json:"use"`
}

func NewFirebaseAppCheckVerifier(config FirebaseAppCheckConfig) (*FirebaseAppCheckVerifier, error) {
	projectNumber := strings.TrimSpace(config.ProjectNumber)
	if projectNumber == "" || strings.Trim(projectNumber, "0123456789") != "" || len(projectNumber) > 32 {
		return nil, errors.New("Firebase project number must be decimal digits")
	}
	allowedAppIDs := make(map[string]struct{}, len(config.AllowedAppIDs))
	for _, value := range config.AllowedAppIDs {
		appID := strings.TrimSpace(value)
		if appID == "" || len(appID) > 256 || strings.ContainsAny(appID, "\r\n\x00") {
			return nil, errors.New("Firebase app ID allowlist contains an invalid value")
		}
		allowedAppIDs[appID] = struct{}{}
	}
	if len(allowedAppIDs) == 0 || len(allowedAppIDs) > 8 {
		return nil, errors.New("Firebase app ID allowlist must contain between one and eight entries")
	}
	jwksURL := config.JWKSURL
	if jwksURL == "" {
		jwksURL = firebaseAppCheckJWKSURL
	}
	if !strings.HasPrefix(jwksURL, "https://") && !strings.HasPrefix(jwksURL, "http://127.0.0.1:") {
		return nil, errors.New("Firebase App Check JWKS URL must use HTTPS")
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Second}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	maxConsumedJTI := config.MaxConsumedJTI
	if maxConsumedJTI == 0 {
		maxConsumedJTI = defaultConsumedAppCheckJTICap
	}
	if maxConsumedJTI < 1 || maxConsumedJTI > 100_000 {
		return nil, errors.New("consumed App Check JTI capacity is invalid")
	}
	return &FirebaseAppCheckVerifier{
		projectNumber:  projectNumber,
		issuer:         "https://firebaseappcheck.googleapis.com/" + projectNumber,
		audience:       "projects/" + projectNumber,
		allowedAppIDs:  allowedAppIDs,
		jwksURL:        jwksURL,
		httpClient:     httpClient,
		now:            now,
		maxConsumedJTI: maxConsumedJTI,
		keys:           make(map[string]*rsa.PublicKey),
		consumed:       make(map[string]time.Time),
	}, nil
}

func (v *FirebaseAppCheckVerifier) Verify(request *http.Request) (string, error) {
	token, ok := singleHeaderValue(request.Header, "X-Firebase-AppCheck")
	if !ok || token == "" || len(token) > maxAppCheckTokenBytes {
		return "", errors.New("exactly one Firebase App Check token is required")
	}
	return v.verifyToken(request.Context(), token)
}

func (v *FirebaseAppCheckVerifier) verifyToken(ctx context.Context, token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", errors.New("Firebase App Check token shape is invalid")
	}
	headerBytes, err := decodeCanonicalBase64URL(parts[0])
	if err != nil {
		return "", errors.New("Firebase App Check header encoding is invalid")
	}
	var header appCheckJWTHeader
	if err := decodeOneJSON(headerBytes, &header); err != nil || header.Algorithm != "RS256" || header.Type != "JWT" || !validJWTIdentifier(header.KeyID, 1, 256) {
		return "", errors.New("Firebase App Check header is invalid")
	}

	key, err := v.keyFor(ctx, header.KeyID, false)
	if errors.Is(err, errAppCheckKeyNotFound) {
		key, err = v.keyFor(ctx, header.KeyID, true)
	}
	if err != nil {
		return "", err
	}
	signature, err := decodeCanonicalBase64URL(parts[2])
	if err != nil || len(signature) == 0 || len(signature) > 512 {
		return "", errors.New("Firebase App Check signature encoding is invalid")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return "", errors.New("Firebase App Check signature is invalid")
	}

	claimsBytes, err := decodeCanonicalBase64URL(parts[1])
	if err != nil {
		return "", errors.New("Firebase App Check claims encoding is invalid")
	}
	var claims appCheckJWTClaims
	if err := decodeOneJSON(claimsBytes, &claims); err != nil {
		return "", errors.New("Firebase App Check claims are invalid")
	}
	now := v.now().UTC()
	nowSeconds := now.Unix()
	if claims.Issuer != v.issuer || !claims.Audience.contains(v.audience) {
		return "", errors.New("Firebase App Check authority is invalid")
	}
	if _, ok := v.allowedAppIDs[claims.Subject]; !ok {
		return "", errors.New("Firebase App Check app is not allowed")
	}
	if claims.IssuedAt > now.Add(maxAppCheckClockSkew).Unix() || claims.ExpiresAt <= nowSeconds {
		return "", errors.New("Firebase App Check token is outside its validity window")
	}
	lifetime := claims.ExpiresAt - claims.IssuedAt
	if lifetime <= 0 || lifetime > int64(maxAppCheckTokenLifetime/time.Second) {
		return "", errors.New("Firebase App Check token lifetime is invalid")
	}
	if !validJWTIdentifier(claims.JWTID, 16, 512) {
		return "", errors.New("limited-use Firebase App Check token jti is required")
	}
	if err := v.consumeJTI(claims.JWTID, time.Unix(claims.ExpiresAt, 0).UTC(), now); err != nil {
		return "", err
	}
	return claims.Subject, nil
}

var errAppCheckKeyNotFound = errors.New("Firebase App Check signing key not found")

func (v *FirebaseAppCheckVerifier) keyFor(ctx context.Context, keyID string, forceRefresh bool) (*rsa.PublicKey, error) {
	v.keysMu.Lock()
	defer v.keysMu.Unlock()
	now := v.now().UTC()
	if !forceRefresh && now.Before(v.keysExpiresAt) {
		if key := v.keys[keyID]; key != nil {
			return key, nil
		}
		return nil, errAppCheckKeyNotFound
	}
	if forceRefresh {
		if now.Before(v.nextForcedRefresh) {
			return nil, errAppCheckKeyNotFound
		}
		v.nextForcedRefresh = now.Add(minForcedJWKSRefreshInterval)
	}
	keys, expiresAt, err := v.fetchKeys(ctx, now)
	if err != nil {
		return nil, err
	}
	v.keys = keys
	v.keysExpiresAt = expiresAt
	if key := v.keys[keyID]; key != nil {
		return key, nil
	}
	return nil, errAppCheckKeyNotFound
}

func (v *FirebaseAppCheckVerifier) fetchKeys(ctx context.Context, now time.Time) (map[string]*rsa.PublicKey, time.Time, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return nil, time.Time{}, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := v.httpClient.Do(request)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("fetch Firebase App Check keys: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, time.Time{}, fmt.Errorf("fetch Firebase App Check keys: status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAppCheckJWKSBytes+1))
	if err != nil || len(body) > maxAppCheckJWKSBytes {
		return nil, time.Time{}, errors.New("Firebase App Check JWKS response is invalid")
	}
	var document appCheckJWKS
	if err := decodeOneJSON(body, &document); err != nil || len(document.Keys) == 0 || len(document.Keys) > maxAppCheckKeys {
		return nil, time.Time{}, errors.New("Firebase App Check JWKS document is invalid")
	}
	keys := make(map[string]*rsa.PublicKey, len(document.Keys))
	for _, jwk := range document.Keys {
		if jwk.Algorithm != "RS256" || jwk.KeyType != "RSA" || jwk.Use != "sig" || !validJWTIdentifier(jwk.KeyID, 1, 256) {
			continue
		}
		key, err := rsaKey(jwk.Modulus, jwk.Exponent)
		if err != nil {
			continue
		}
		keys[jwk.KeyID] = key
	}
	if len(keys) == 0 {
		return nil, time.Time{}, errors.New("Firebase App Check JWKS has no usable keys")
	}
	return keys, now.Add(cacheTTL(response.Header.Get("Cache-Control"))), nil
}

func (v *FirebaseAppCheckVerifier) consumeJTI(jti string, expiresAt, now time.Time) error {
	v.consumedMu.Lock()
	defer v.consumedMu.Unlock()
	if previousExpiry, exists := v.consumed[jti]; exists && now.Before(previousExpiry) {
		return errors.New("Firebase App Check token was already consumed")
	}
	if len(v.consumed) >= v.maxConsumedJTI {
		for value, expiry := range v.consumed {
			if !now.Before(expiry) {
				delete(v.consumed, value)
			}
		}
		if len(v.consumed) >= v.maxConsumedJTI {
			return errors.New("Firebase App Check replay store capacity reached")
		}
	}
	v.consumed[jti] = expiresAt
	return nil
}

func (a *appCheckAudience) UnmarshalJSON(data []byte) error {
	var values []string
	if err := json.Unmarshal(data, &values); err == nil {
		*a = values
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return errors.New("audience must be a string or string array")
	}
	*a = []string{value}
	return nil
}

func (a appCheckAudience) contains(expected string) bool {
	for _, value := range a {
		if value == expected {
			return true
		}
	}
	return false
}

func rsaKey(modulusValue, exponentValue string) (*rsa.PublicKey, error) {
	modulus, err := decodeCanonicalBase64URL(modulusValue)
	if err != nil || len(modulus) < 256 || len(modulus) > 512 {
		return nil, errors.New("RSA modulus is invalid")
	}
	exponentBytes, err := decodeCanonicalBase64URL(exponentValue)
	if err != nil || len(exponentBytes) == 0 || len(exponentBytes) > 4 {
		return nil, errors.New("RSA exponent is invalid")
	}
	exponent := 0
	for _, value := range exponentBytes {
		exponent = exponent<<8 | int(value)
	}
	if exponent < 3 || exponent%2 == 0 {
		return nil, errors.New("RSA exponent is invalid")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: exponent}, nil
}

func decodeCanonicalBase64URL(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("value is not canonical unpadded base64url")
	}
	return decoded, nil
}

func decodeOneJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("JSON contains trailing values")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing values")
	}
	return nil
}

func validJWTIdentifier(value string, minimum, maximum int) bool {
	return len(value) >= minimum && len(value) <= maximum && !strings.ContainsAny(value, "\x00\r\n \t")
}

func cacheTTL(cacheControl string) time.Duration {
	for _, directive := range strings.Split(cacheControl, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(directive), "=")
		if !ok || strings.ToLower(name) != "max-age" {
			continue
		}
		seconds, err := strconv.ParseInt(strings.Trim(value, "\""), 10, 64)
		if err == nil && seconds > 0 {
			ttl := time.Duration(seconds) * time.Second
			if ttl > maxAppCheckKeyCacheTTL {
				return maxAppCheckKeyCacheTTL
			}
			return ttl
		}
	}
	return defaultAppCheckKeyCacheTTL
}
