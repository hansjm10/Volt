package broker

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/credential"
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
		ClaimTTL:           10 * time.Minute,
		AccessTokenTTL:     15 * time.Minute,
		RefreshTokenTTL:    30 * 24 * time.Hour,
		RefreshMinInterval: 5 * time.Second,
		MaxClaims:          100,
		MaxCredentials:     200,
	}

	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "claim TTL", mutate: func(config *Config) { config.ClaimTTL = MaxClaimTTL + time.Second }},
		{name: "access TTL", mutate: func(config *Config) { config.AccessTokenTTL = MaxAccessTokenTTL + time.Second }},
		{name: "refresh TTL", mutate: func(config *Config) { config.RefreshTokenTTL = MaxRefreshTokenTTL + time.Second }},
		{name: "refresh interval", mutate: func(config *Config) { config.RefreshMinInterval = config.AccessTokenTTL }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configuration := valid
			test.mutate(&configuration)
			if _, err := New(signer, configuration, time.Now); err == nil {
				t.Fatal("unsafe configuration was accepted")
			}
		})
	}
}
