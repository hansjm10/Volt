package broker

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
)

func TestBrokerRejectsUnsafeCredentialLifetimes(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := credential.NewSigner("https://credentials.volt.test", "volt-iroh-relay", private)
	if err != nil {
		t.Fatal(err)
	}
	valid := Config{
		ClaimTTL:                10 * time.Minute,
		AccessTokenTTL:          15 * time.Minute,
		RefreshInactivityTTL:    30 * 24 * time.Hour,
		RefreshMinInterval:      5 * time.Second,
		MaxClaims:               100,
		MaxEndpoints:            200,
		MaxAppEndpointsPerGrant: 8,
	}

	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "claim TTL", mutate: func(config *Config) { config.ClaimTTL = MaxClaimTTL + time.Second }},
		{name: "access TTL", mutate: func(config *Config) { config.AccessTokenTTL = MaxAccessTokenTTL + time.Second }},
		{name: "refresh inactivity maximum", mutate: func(config *Config) { config.RefreshInactivityTTL = MaxRefreshInactivityTTL + time.Second }},
		{name: "refresh inactivity below claim", mutate: func(config *Config) {
			config.AccessTokenTTL = time.Minute
			config.RefreshInactivityTTL = config.ClaimTTL - time.Second
		}},
		{name: "refresh inactivity below access", mutate: func(config *Config) { config.RefreshInactivityTTL = config.AccessTokenTTL - time.Second }},
		{name: "refresh interval", mutate: func(config *Config) { config.RefreshMinInterval = config.AccessTokenTTL }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configuration := valid
			test.mutate(&configuration)
			if _, err := New(nil, signer, configuration, time.Now); err == nil {
				t.Fatal("unsafe configuration was accepted")
			}
		})
	}
}

func TestParseSecretHashRequiresCanonicalSHA256(t *testing.T) {
	canonical := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if _, err := ParseSecretHash(canonical); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		canonical + "=",
		base64.RawURLEncoding.EncodeToString(make([]byte, 31)),
		strings.Repeat("!", 43),
		"",
	} {
		if _, err := ParseSecretHash(value); !errors.Is(err, ErrInvalidSecretHash) {
			t.Fatalf("ParseSecretHash(%q) error = %v", value, err)
		}
	}
}
