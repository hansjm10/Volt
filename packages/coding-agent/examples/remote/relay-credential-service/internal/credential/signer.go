package credential

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var rawBase64 = base64.RawURLEncoding

const (
	maxJWTBytes        = 8 * 1024
	maxAuthorityBytes  = 512
	minIdentifierBytes = 16
	maxIdentifierBytes = 128
	maxAccessTokenTTL  = time.Hour
	relayClockSkew     = 30 * time.Second
)

// Claims is the relay admission contract. The relay must validate the signature,
// issuer, audience, expiry, scope, and that Subject equals the authenticated Iroh
// endpoint ID before allowing a connection.
type Claims struct {
	Issuer       string `json:"iss"`
	Audience     string `json:"aud"`
	Subject      string `json:"sub"`
	ExpiresAt    int64  `json:"exp"`
	IssuedAt     int64  `json:"iat"`
	JWTID        string `json:"jti"`
	Scope        string `json:"scope"`
	EndpointKind string `json:"endpoint_kind"`
	GrantID      string `json:"grant_id"`
}

type jwtHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Type      string `json:"typ"`
}

// Signer issues Ed25519 JWTs and publishes the matching public JWK.
type Signer struct {
	issuer   string
	audience string
	keyID    string
	private  ed25519.PrivateKey
	public   ed25519.PublicKey
}

func NewSigner(issuer, audience string, private ed25519.PrivateKey) (*Signer, error) {
	issuer = strings.TrimSpace(issuer)
	audience = strings.TrimSpace(audience)
	if !validAuthority(issuer) {
		return nil, errors.New("issuer is invalid")
	}
	if !validAuthority(audience) {
		return nil, errors.New("audience is invalid")
	}
	if len(private) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid Ed25519 private key length: %d", len(private))
	}

	privateCopy := append(ed25519.PrivateKey(nil), private...)
	public := append(ed25519.PublicKey(nil), private.Public().(ed25519.PublicKey)...)
	digest := sha256.Sum256(public)
	return &Signer{
		issuer:   issuer,
		audience: audience,
		keyID:    rawBase64.EncodeToString(digest[:12]),
		private:  privateCopy,
		public:   public,
	}, nil
}

// LoadOrCreateSigner loads a base64url-encoded Ed25519 seed from a mode-0600
// file, creating one when the file does not exist.
func LoadOrCreateSigner(issuer, audience, path string) (*Signer, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("signing key path is required")
	}

	seed, err := readSeed(path)
	if errors.Is(err, os.ErrNotExist) {
		seed = make([]byte, ed25519.SeedSize)
		if _, randomErr := rand.Read(seed); randomErr != nil {
			return nil, fmt.Errorf("generate signing key: %w", randomErr)
		}
		if writeErr := writeSeed(path, seed); writeErr != nil {
			if !errors.Is(writeErr, os.ErrExist) {
				return nil, writeErr
			}
			seed, err = readSeed(path)
		} else {
			err = nil
		}
	}
	if err != nil {
		return nil, err
	}
	return NewSigner(issuer, audience, ed25519.NewKeyFromSeed(seed))
}

func (s *Signer) Issue(subject, endpointKind, grantID, jwtID string, now time.Time, ttl time.Duration) (string, time.Time, error) {
	if ttl < time.Second || ttl > maxAccessTokenTTL {
		return "", time.Time{}, errors.New("token TTL must be between one second and one hour")
	}
	if !validNodeID(subject) {
		return "", time.Time{}, errors.New("token subject must be a canonical Iroh node ID")
	}
	if endpointKind != "app" && endpointKind != "host" {
		return "", time.Time{}, errors.New("token endpoint kind must be app or host")
	}
	if !validIdentifier(grantID) || !validIdentifier(jwtID) {
		return "", time.Time{}, errors.New("token identifiers must be canonical base64url values between 16 and 128 bytes")
	}

	now = now.UTC()
	expiresAt := now.Add(ttl)
	if expiresAt.Unix() <= now.Unix() {
		return "", time.Time{}, errors.New("token TTL must produce a positive whole-second lifetime")
	}
	headerBytes, err := json.Marshal(jwtHeader{Algorithm: "EdDSA", KeyID: s.keyID, Type: "JWT"})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("encode JWT header: %w", err)
	}
	claimsBytes, err := json.Marshal(Claims{
		Issuer:       s.issuer,
		Audience:     s.audience,
		Subject:      subject,
		ExpiresAt:    expiresAt.Unix(),
		IssuedAt:     now.Unix(),
		JWTID:        jwtID,
		Scope:        "relay:connect",
		EndpointKind: endpointKind,
		GrantID:      grantID,
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("encode JWT claims: %w", err)
	}

	signingInput := rawBase64.EncodeToString(headerBytes) + "." + rawBase64.EncodeToString(claimsBytes)
	signature := ed25519.Sign(s.private, []byte(signingInput))
	return signingInput + "." + rawBase64.EncodeToString(signature), expiresAt, nil
}

// Verify checks tokens issued by this signer. It is used by tests and local
// tooling; the relay must perform the equivalent checks in its AccessControl.
func (s *Signer) Verify(token string, now time.Time) (Claims, error) {
	var claims Claims
	if len(token) > maxJWTBytes {
		return claims, errors.New("JWT is too large")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, errors.New("invalid JWT shape")
	}

	headerBytes, err := decodeCanonicalBase64(parts[0])
	if err != nil {
		return claims, errors.New("invalid JWT header encoding")
	}
	var header jwtHeader
	if err := decodeStrictJSON(headerBytes, &header); err != nil {
		return claims, errors.New("invalid JWT header")
	}
	if header.Algorithm != "EdDSA" || header.KeyID != s.keyID || header.Type != "JWT" {
		return claims, errors.New("unexpected JWT header")
	}

	signature, err := decodeCanonicalBase64(parts[2])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return claims, errors.New("invalid JWT signature encoding")
	}
	if !ed25519.Verify(s.public, []byte(parts[0]+"."+parts[1]), signature) {
		return claims, errors.New("invalid JWT signature")
	}

	claimsBytes, err := decodeCanonicalBase64(parts[1])
	if err != nil || decodeStrictJSON(claimsBytes, &claims) != nil {
		return Claims{}, errors.New("invalid JWT claims")
	}
	if claims.Issuer != s.issuer || claims.Audience != s.audience || claims.Scope != "relay:connect" {
		return Claims{}, errors.New("unexpected JWT authority")
	}
	if !validNodeID(claims.Subject) || (claims.EndpointKind != "app" && claims.EndpointKind != "host") || !validIdentifier(claims.GrantID) || !validIdentifier(claims.JWTID) {
		return Claims{}, errors.New("invalid JWT identity")
	}
	now = now.UTC()
	if claims.ExpiresAt <= now.Add(-relayClockSkew).Unix() {
		return Claims{}, errors.New("JWT expired")
	}
	if claims.IssuedAt > now.Add(relayClockSkew).Unix() {
		return Claims{}, errors.New("JWT issued in the future")
	}
	lifetime := claims.ExpiresAt - claims.IssuedAt
	if lifetime <= 0 || lifetime > int64(maxAccessTokenTTL/time.Second) {
		return Claims{}, errors.New("JWT lifetime exceeds relay policy")
	}
	return claims, nil
}

func (s *Signer) JWKS() map[string]any {
	return map[string]any{
		"keys": []map[string]string{{
			"alg": "EdDSA",
			"crv": "Ed25519",
			"kid": s.keyID,
			"kty": "OKP",
			"use": "sig",
			"x":   rawBase64.EncodeToString(s.public),
		}},
	}
}

func (s *Signer) KeyID() string {
	return s.keyID
}

func validAuthority(value string) bool {
	return value != "" && len(value) <= maxAuthorityBytes && value == strings.TrimSpace(value) && !strings.ContainsFunc(value, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	})
}

func validNodeID(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range []byte(value) {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validIdentifier(value string) bool {
	if len(value) < minIdentifierBytes || len(value) > maxIdentifierBytes {
		return false
	}
	for _, character := range []byte(value) {
		if (character < '0' || character > '9') && (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func decodeCanonicalBase64(value string) ([]byte, error) {
	decoded, err := rawBase64.DecodeString(value)
	if err != nil || rawBase64.EncodeToString(decoded) != value {
		return nil, errors.New("value is not canonical unpadded base64url")
	}
	return decoded, nil
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON must contain exactly one value")
	}
	return nil
}

func readSeed(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("signing key path is not a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("signing key file permissions must be 0600, got %04o", info.Mode().Perm())
	}

	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read signing key: %w", err)
	}
	seed, err := rawBase64.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("signing key file must contain one base64url-encoded Ed25519 seed")
	}
	return seed, nil
}

func writeSeed(path string, seed []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create signing key directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	encoded := rawBase64.EncodeToString(seed) + "\n"
	if _, err := file.WriteString(encoded); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return fmt.Errorf("write signing key: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return fmt.Errorf("sync signing key: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("close signing key: %w", err)
	}
	return nil
}
