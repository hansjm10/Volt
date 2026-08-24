package broker

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

func TestConcurrentApprovalIsAtomicAndReplaySafe(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	claimSecret := postgresTestSecret("vpc_", 1)
	hostRefresh := postgresTestSecret("vrr_", 2)
	appRefresh := postgresTestSecret("vrr_", 3)
	claim, err := service.CreateBootstrapPairingClaim(
		context.Background(),
		string(bytes.Repeat([]byte{'a'}, 64)),
		postgresTestHash(claimSecret),
		postgresTestHash(hostRefresh),
	)
	if err != nil {
		t.Fatal(err)
	}

	proofs := []AppCheckProof{
		postgresTestAppCheck(now, "approval-one"),
		postgresTestAppCheck(now, "approval-two"),
	}
	approvals := make([]Approval, len(proofs))
	errorsByIndex := make([]error, len(proofs))
	var waitGroup sync.WaitGroup
	for index := range proofs {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			approvals[index], errorsByIndex[index] = service.ApprovePairingClaim(
				context.Background(),
				claim.ClaimID,
				proofs[index],
				string(bytes.Repeat([]byte{'b'}, 64)),
				postgresTestHash(appRefresh),
			)
		}()
	}
	waitGroup.Wait()
	for _, err := range errorsByIndex {
		if err != nil {
			t.Fatalf("concurrent approval failed: %v", err)
		}
	}
	if approvals[0].GrantID != approvals[1].GrantID || approvals[0].EndpointID != approvals[1].EndpointID {
		t.Fatalf("concurrent retries created different authority: %+v %+v", approvals[0], approvals[1])
	}
	if got := testdatabase.Count(t, pool, "grants"); got != 1 {
		t.Fatalf("grant count = %d, want 1", got)
	}
	if got := testdatabase.Count(t, pool, "endpoints"); got != 2 {
		t.Fatalf("endpoint count = %d, want 2", got)
	}
	if got := testdatabase.Count(t, pool, "consumed_app_check_tokens"); got != 2 {
		t.Fatalf("consumed App Check token count = %d, want 2", got)
	}

	if _, err := service.ApprovePairingClaim(
		context.Background(),
		claim.ClaimID,
		proofs[0],
		string(bytes.Repeat([]byte{'b'}, 64)),
		postgresTestHash(appRefresh),
	); !errors.Is(err, ErrAppCheckReplay) {
		t.Fatalf("replayed App Check error = %v, want %v", err, ErrAppCheckReplay)
	}

	rollbackProof := postgresTestAppCheck(now, "approval-after-rollback")
	if _, err := service.ApprovePairingClaim(
		context.Background(),
		"missing-claim",
		rollbackProof,
		string(bytes.Repeat([]byte{'b'}, 64)),
		postgresTestHash(appRefresh),
	); !errors.Is(err, ErrClaimNotFound) {
		t.Fatalf("missing claim error = %v, want %v", err, ErrClaimNotFound)
	}
	if got := testdatabase.Count(t, pool, "consumed_app_check_tokens"); got != 2 {
		t.Fatalf("failed approval consumed App Check token; count = %d", got)
	}
	if _, err := service.ApprovePairingClaim(
		context.Background(),
		claim.ClaimID,
		rollbackProof,
		string(bytes.Repeat([]byte{'b'}, 64)),
		postgresTestHash(appRefresh),
	); err != nil {
		t.Fatalf("App Check token rolled back with failed approval was not reusable: %v", err)
	}
}

func TestExchangeRefreshExpiryAndRevocationPersistAcrossBrokerRestart(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	firstService := newPostgresBroker(t, pool, &now)
	claimSecret := postgresTestSecret("vpc_", 11)
	hostRefresh := postgresTestSecret("vrr_", 12)
	appRefresh := postgresTestSecret("vrr_", 13)
	claim, err := firstService.CreateBootstrapPairingClaim(
		context.Background(),
		string(bytes.Repeat([]byte{'c'}, 64)),
		postgresTestHash(claimSecret),
		postgresTestHash(hostRefresh),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := firstService.ApprovePairingClaim(
		context.Background(),
		claim.ClaimID,
		postgresTestAppCheck(now, "restart-approval"),
		string(bytes.Repeat([]byte{'d'}, 64)),
		postgresTestHash(appRefresh),
	); err != nil {
		t.Fatal(err)
	}

	restartedService := newPostgresBroker(t, pool, &now)
	exchange, err := restartedService.ExchangePairingClaim(context.Background(), claim.ClaimID, claimSecret)
	if err != nil {
		t.Fatalf("exchange after broker restart: %v", err)
	}
	if exchange.GrantID == "" || exchange.EndpointID == "" {
		t.Fatalf("incomplete exchange after broker restart: %+v", exchange)
	}

	refreshErrors := make([]error, 2)
	var waitGroup sync.WaitGroup
	for index := range refreshErrors {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, refreshErrors[index] = restartedService.RefreshAccessToken(context.Background(), appRefresh)
		}()
	}
	waitGroup.Wait()
	successes := 0
	throttled := 0
	for _, err := range refreshErrors {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrRefreshThrottled):
			throttled++
		default:
			t.Fatalf("concurrent refresh error = %v", err)
		}
	}
	if successes != 1 || throttled != 1 {
		t.Fatalf("concurrent refresh outcomes: successes=%d throttled=%d", successes, throttled)
	}
	thirdService := newPostgresBroker(t, pool, &now)
	if _, err := thirdService.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, ErrRefreshThrottled) {
		t.Fatalf("refresh throttle did not survive restart: %v", err)
	}

	now = now.Add(5 * time.Second)
	var refreshErr error
	var revokeErr error
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		_, refreshErr = thirdService.RefreshAccessToken(context.Background(), appRefresh)
	}()
	go func() {
		defer waitGroup.Done()
		revokeErr = thirdService.RevokeRefreshToken(context.Background(), appRefresh)
	}()
	waitGroup.Wait()
	if revokeErr != nil {
		t.Fatalf("concurrent revoke failed: %v", revokeErr)
	}
	if refreshErr != nil && !errors.Is(refreshErr, ErrRefreshInvalid) {
		t.Fatalf("concurrent refresh error = %v", refreshErr)
	}
	if _, err := thirdService.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("refresh after committed revoke = %v, want %v", err, ErrRefreshInvalid)
	}

	now = now.Add(30 * 24 * time.Hour)
	if _, err := thirdService.RefreshAccessToken(context.Background(), hostRefresh); !errors.Is(err, ErrRefreshExpired) {
		t.Fatalf("inactive host refresh error = %v, want %v", err, ErrRefreshExpired)
	}
	if _, err := restartedService.RefreshAccessToken(context.Background(), hostRefresh); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("expired grant did not persist as revoked: %v", err)
	}
}

func TestAppRefreshObservesHostInactivityExpiry(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	claimSecret := postgresTestSecret("vpc_", 21)
	hostRefresh := postgresTestSecret("vrr_", 22)
	appRefresh := postgresTestSecret("vrr_", 23)
	claim, err := service.CreateBootstrapPairingClaim(
		context.Background(),
		string(bytes.Repeat([]byte{'e'}, 64)),
		postgresTestHash(claimSecret),
		postgresTestHash(hostRefresh),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApprovePairingClaim(
		context.Background(),
		claim.ClaimID,
		postgresTestAppCheck(now, "host-inactivity-approval"),
		string(bytes.Repeat([]byte{'f'}, 64)),
		postgresTestHash(appRefresh),
	); err != nil {
		t.Fatal(err)
	}

	now = now.Add(29 * 24 * time.Hour)
	if _, err := service.RefreshAccessToken(context.Background(), appRefresh); err != nil {
		t.Fatalf("refresh app before host inactivity expiry: %v", err)
	}
	now = now.Add(24 * time.Hour)
	if _, err := service.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, ErrRefreshExpired) {
		t.Fatalf("app refresh after host inactivity expiry = %v, want %v", err, ErrRefreshExpired)
	}
	if _, err := service.RefreshAccessToken(context.Background(), appRefresh); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("app refresh after grant expiry was not terminal: %v", err)
	}
	if _, err := service.RefreshAccessToken(context.Background(), hostRefresh); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("host refresh after app observed grant expiry was not terminal: %v", err)
	}
}

func TestClaimCreationPrunesExpiredRetentionRows(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	if _, err := service.CreateBootstrapPairingClaim(
		context.Background(),
		string(bytes.Repeat([]byte{'1'}, 64)),
		postgresTestHash(postgresTestSecret("vpc_", 31)),
		postgresTestHash(postgresTestSecret("vrr_", 32)),
	); err != nil {
		t.Fatal(err)
	}
	now = now.Add(10*time.Minute + claimRetention)
	if _, err := service.CreateBootstrapPairingClaim(
		context.Background(),
		string(bytes.Repeat([]byte{'2'}, 64)),
		postgresTestHash(postgresTestSecret("vpc_", 33)),
		postgresTestHash(postgresTestSecret("vrr_", 34)),
	); err != nil {
		t.Fatal(err)
	}
	if got := testdatabase.Count(t, pool, "pairing_claims"); got != 1 {
		t.Fatalf("retained pairing claim count = %d, want 1", got)
	}
}

func newPostgresBroker(t *testing.T, pool *pgxpool.Pool, now *time.Time) *Broker {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := credential.NewSigner("https://credentials.volt.test", "volt-iroh-relay", private)
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(pool, signer, Config{
		ClaimTTL:                10 * time.Minute,
		AccessTokenTTL:          15 * time.Minute,
		RefreshInactivityTTL:    30 * 24 * time.Hour,
		RefreshMinInterval:      5 * time.Second,
		MaxClaims:               100,
		MaxEndpoints:            200,
		MaxAppEndpointsPerGrant: 8,
	}, func() time.Time { return *now })
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func postgresTestSecret(prefix string, fill byte) string {
	return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32))
}

func postgresTestHash(value string) SecretHash {
	return SecretHash(sha256.Sum256([]byte(value)))
}

func postgresTestAppCheck(now time.Time, jti string) AppCheckProof {
	return AppCheckProof{
		AppID:           "test-app",
		JTIHash:         SecretHash(sha256.Sum256([]byte(jti))),
		ExpiresAt:       now.Add(time.Hour),
		ReplayProtected: true,
	}
}
