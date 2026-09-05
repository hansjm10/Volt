package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
)

// Configuration and the fixture clock stay fixed while requests are in flight.
// Only the call counter is mutated concurrently.
type countingAppStoreVerifier struct {
	testAppStoreVerifier
	calls   atomic.Int32
	status  appstore.Status
	err     error
	started chan struct{}
	release chan struct{}
}

func (v *countingAppStoreVerifier) ReconcileEntitlement(ctx context.Context, id, environment string) (appstore.Entitlement, error) {
	v.calls.Add(1)
	if v.started != nil {
		select {
		case v.started <- struct{}{}:
		default:
		}
	}
	if v.release != nil {
		select {
		case <-v.release:
		case <-ctx.Done():
			return appstore.Entitlement{}, ctx.Err()
		}
	}
	if v.err != nil {
		return appstore.Entitlement{}, v.err
	}
	entitlement, err := v.testAppStoreVerifier.ReconcileEntitlement(ctx, id, environment)
	if v.status != "" {
		entitlement.Status = v.status
		if v.status != appstore.StatusActive && v.status != appstore.StatusGrace {
			entitlement.EntitledUntil = time.Time{}
		}
	}
	return entitlement, err
}

type reconciliationFixture struct {
	service     *testService
	verifier    *countingAppStoreVerifier
	hostRefresh string
	appRefresh  string
}

func newReconciliationFixture(t *testing.T, status appstore.Status, verifiedAge time.Duration) *reconciliationFixture {
	t.Helper()
	service := newTestService(t)
	fixture := &reconciliationFixture{
		service: service, hostRefresh: testSecret("vrr_", 2), appRefresh: testSecret("vrr_", 3),
		verifier: &countingAppStoreVerifier{
			testAppStoreVerifier: testAppStoreVerifier{now: func() time.Time { return service.now }},
			status:               status,
		},
	}
	claim := service.createBootstrapClaim(t, strings.Repeat("a", 64), testSecret("vpc_", 1), fixture.hostRefresh)
	service.approveClaim(t, claim.ClaimID, strings.Repeat("b", 64), fixture.appRefresh)
	service.now = service.now.Add(time.Minute)
	fixture.setEntitlement(t, status, verifiedAge)
	service.handler.appStore = fixture.verifier
	return fixture
}

func (f *reconciliationFixture) setEntitlement(t *testing.T, status appstore.Status, verifiedAge time.Duration) appstore.Entitlement {
	t.Helper()
	entitlement := appstore.Entitlement{
		AppTransactionID: defaultSubscriptionID, Environment: "Sandbox", Status: status,
		EntitledUntil: f.service.now.Add(48 * time.Hour), SourceSignedAt: f.service.now,
		VerifiedAt: f.service.now.Add(-verifiedAge),
	}
	if err := f.service.handler.broker.ApplyEntitlementReconciliation(context.Background(), entitlement); err != nil {
		t.Fatal(err)
	}
	return entitlement
}

func assertRefreshResponse(t *testing.T, response *httptest.ResponseRecorder, status int, retryAfter string) {
	t.Helper()
	if response.Code != status || response.Header().Get("Retry-After") != retryAfter {
		t.Fatalf("refresh status=%d headers=%v body=%s; want status=%d retry=%q", response.Code, response.Header(), response.Body.String(), status, retryAfter)
	}
	if status != http.StatusOK && strings.Contains(response.Body.String(), "accessToken") {
		t.Fatalf("denied refresh returned a JWT: %s", response.Body.String())
	}
}

func TestRefreshReconciliationAttemptsAreBounded(t *testing.T) {
	for _, test := range []struct {
		name       string
		cached     appstore.Status
		result     appstore.Status
		err        error
		first      int
		firstRetry string
	}{
		{name: "inactive success", cached: appstore.StatusInactive, result: appstore.StatusInactive, first: 402, firstRetry: "3600"},
		{name: "inactive outage", cached: appstore.StatusExpired, err: appstore.ErrSubscriptionUnavailable, first: 503, firstRetry: "3600"},
		{name: "inactive invalid proof", cached: appstore.StatusRevoked, err: appstore.ErrProofInvalid, first: 401},
		{name: "inactive apply failure", cached: appstore.StatusBillingRetry, result: "invalid", first: 500},
		{name: "stale active outage", cached: appstore.StatusActive, err: appstore.ErrSubscriptionUnavailable, first: 200},
		{name: "stale grace outage", cached: appstore.StatusGrace, err: appstore.ErrSubscriptionUnavailable, first: 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newReconciliationFixture(t, test.cached, 24*time.Hour)
			f.verifier.status, f.verifier.err = test.result, test.err
			service := f.service
			before, err := service.handler.broker.EntitlementForRefresh(context.Background(), f.hostRefresh)
			if err != nil {
				t.Fatal(err)
			}
			headers := map[string]string{"Authorization": "Bearer " + f.hostRefresh}
			assertRefreshResponse(t, service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), test.first, test.firstRetry)
			cooldownStatus, cooldownRetry := http.StatusPaymentRequired, "3600"
			if before.Active(service.now) {
				cooldownStatus, cooldownRetry = http.StatusTooManyRequests, "5"
			}
			for i := 0; i < 3; i++ {
				assertRefreshResponse(t, service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), cooldownStatus, cooldownRetry)
			}
			if got := f.verifier.calls.Load(); got != 1 {
				t.Fatalf("immediate reconciliation calls=%d, want 1", got)
			}
			after, err := service.handler.broker.EntitlementForRefresh(context.Background(), f.hostRefresh)
			if err != nil {
				t.Fatal(err)
			}
			if test.err != nil || test.result == "invalid" {
				if !after.LastVerifiedAt.Equal(before.LastVerifiedAt) {
					t.Fatalf("failed attempt changed verification time: before=%v after=%v", before.LastVerifiedAt, after.LastVerifiedAt)
				}
			} else if !after.LastVerifiedAt.Equal(service.now) {
				t.Fatalf("successful reconciliation was not applied: %v", after.LastVerifiedAt)
			}

			service.now = service.now.Add(time.Hour - time.Microsecond)
			if before.Active(service.now) {
				cooldownStatus, cooldownRetry = http.StatusOK, ""
			}
			assertRefreshResponse(t, service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), cooldownStatus, cooldownRetry)
			if got := f.verifier.calls.Load(); got != 1 {
				t.Fatalf("attempt before cooldown expiry: calls=%d", got)
			}
			service.now = service.now.Add(time.Microsecond)
			// The app endpoint has not refreshed a JWT, so its independent JWT throttle
			// does not obscure the entitlement's exact one-hour admission boundary.
			assertRefreshResponse(t, service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.appRefresh}), test.first, test.firstRetry)
			if got := f.verifier.calls.Load(); got != 2 {
				t.Fatalf("calls at cooldown expiry=%d, want 2", got)
			}
		})
	}
}

func TestRefreshReconciliationFreshnessAndRenewal(t *testing.T) {
	for _, status := range []appstore.Status{appstore.StatusActive, appstore.StatusGrace, appstore.StatusInactive} {
		t.Run(string(status), func(t *testing.T) {
			f := newReconciliationFixture(t, status, 0)
			f.verifier.status = appstore.StatusActive
			headers := map[string]string{"Authorization": "Bearer " + f.hostRefresh}
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusOK, "")
			wantCalls := int32(0)
			if status == appstore.StatusInactive {
				wantCalls = 1 // A successful renewal restores access on this refresh.
			}
			if got := f.verifier.calls.Load(); got != wantCalls {
				t.Fatalf("fresh status calls=%d, want %d", got, wantCalls)
			}
			f.service.now = f.service.now.Add(time.Hour)
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusOK, "")
			if got := f.verifier.calls.Load(); got != wantCalls {
				t.Fatalf("fresh active status retried just because cooldown elapsed: calls=%d", got)
			}
			f.service.now = f.service.now.Add(23 * time.Hour)
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusOK, "")
			if got := f.verifier.calls.Load(); got != wantCalls+1 {
				t.Fatalf("24-hour freshness boundary calls=%d, want %d", got, wantCalls+1)
			}
		})
	}
	for _, status := range []appstore.Status{appstore.StatusActive, appstore.StatusGrace} {
		t.Run("elapsed "+string(status), func(t *testing.T) {
			f := newReconciliationFixture(t, status, 0)
			entitlement := f.setEntitlement(t, status, 0)
			entitlement.EntitledUntil = f.service.now
			if err := f.service.handler.broker.ApplyEntitlementReconciliation(context.Background(), entitlement); err != nil {
				t.Fatal(err)
			}
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.hostRefresh}), http.StatusOK, "")
			if got := f.verifier.calls.Load(); got != 1 {
				t.Fatalf("elapsed entitlement with fresh verification calls=%d, want 1", got)
			}
		})
	}
}

func TestRefreshReconciliationIsSharedAcrossReplicasWithoutBlockingHeartbeats(t *testing.T) {
	f := newReconciliationFixture(t, appstore.StatusInactive, 0)
	f.verifier.err = appstore.ErrSubscriptionUnavailable
	f.verifier.started, f.verifier.release = make(chan struct{}, 1), make(chan struct{})
	replica := newTestServiceWithPool(t, f.service.pool)
	replica.now = f.service.now
	replica.handler.appStore = f.verifier
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	var release sync.Once
	defer release.Do(func() { close(f.verifier.release) })
	go func() {
		firstDone <- f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.hostRefresh})
	}()
	select {
	case <-f.verifier.started:
	case <-time.After(5 * time.Second):
		t.Fatal("first refresh did not reach Apple")
	}
	results := make(chan *httptest.ResponseRecorder, 12)
	for i := 0; i < cap(results); i++ {
		go func() {
			service, token := f.service, f.hostRefresh
			if i%2 != 0 {
				service, token = replica, f.appRefresh
			}
			results <- service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + token})
		}()
	}
	for i := 0; i < cap(results); i++ {
		select {
		case response := <-results:
			assertRefreshResponse(t, response, http.StatusPaymentRequired, "3600")
		case <-time.After(5 * time.Second):
			t.Fatal("cooldown heartbeat blocked behind Apple I/O")
		}
	}
	if got := f.verifier.calls.Load(); got != 1 {
		t.Fatalf("concurrent Apple calls=%d, want 1", got)
	}
	release.Do(func() { close(f.verifier.release) })
	select {
	case response := <-firstDone:
		assertRefreshResponse(t, response, http.StatusServiceUnavailable, "3600")
	case <-time.After(5 * time.Second):
		t.Fatal("first refresh did not finish")
	}
	// A newly constructed broker/server must observe the committed reservation.
	restarted := newTestServiceWithPool(t, f.service.pool)
	restarted.now = f.service.now
	restarted.handler.appStore = f.verifier
	assertRefreshResponse(t, restarted.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.hostRefresh}), http.StatusPaymentRequired, "3600")
	if got := f.verifier.calls.Load(); got != 1 {
		t.Fatalf("restart discarded attempt: calls=%d", got)
	}
}

func TestRefreshReconciliationAdmissionErrorsDoNotCallApple(t *testing.T) {
	f := newReconciliationFixture(t, appstore.StatusInactive, 0)
	// Fail only reservation UPDATEs: the authenticated lookup remains available.
	if _, err := f.service.pool.Exec(context.Background(), `
		CREATE FUNCTION reject_reconcile_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test reservation failure'; END $$;
		CREATE TRIGGER reject_reconcile_attempt BEFORE UPDATE OF last_reconcile_attempt_at
		ON app_store_entitlements FOR EACH ROW EXECUTE FUNCTION reject_reconcile_attempt();
	`); err != nil {
		t.Fatal(err)
	}
	response := f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.hostRefresh})
	assertRefreshResponse(t, response, http.StatusInternalServerError, "")
	if got := f.verifier.calls.Load(); got != 0 {
		t.Fatalf("failed reservation called Apple %d times", got)
	}
	if _, err := f.service.pool.Exec(context.Background(), "DROP TRIGGER reject_reconcile_attempt ON app_store_entitlements"); err != nil {
		t.Fatal(err)
	}
	assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.hostRefresh}), http.StatusPaymentRequired, "3600")
	if got := f.verifier.calls.Load(); got != 1 {
		t.Fatalf("failed reservation consumed attempt: calls=%d", got)
	}
}

func TestRefreshReconciliationSuspensionHeartbeatsAndNotificationRecovery(t *testing.T) {
	for _, tokenKind := range []string{"host", "app"} {
		t.Run(tokenKind, func(t *testing.T) {
			f := newReconciliationFixture(t, appstore.StatusInactive, 0)
			f.verifier.err = appstore.ErrSubscriptionUnavailable
			token := f.hostRefresh
			if tokenKind == "app" {
				token = f.appRefresh
			}
			headers := map[string]string{"Authorization": "Bearer " + token}
			for heartbeat := 0; heartbeat < 4; heartbeat++ {
				f.service.now = f.service.now.Add(29 * 24 * time.Hour)
				assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusServiceUnavailable, "3600")
				f.assertHeartbeat(t, token)
				f.service.now = f.service.now.Add(30 * time.Minute)
				assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusPaymentRequired, "3600")
				f.assertHeartbeat(t, token)
			}
			if got := f.verifier.calls.Load(); got != 4 {
				t.Fatalf("heartbeat reconciliation calls=%d, want 4", got)
			}
			// Notification recovery is immediate even inside the last attempt's cooldown.
			f.service.now = f.service.now.Add(time.Second)
			entitlement := appstore.Entitlement{
				AppTransactionID: defaultSubscriptionID, Environment: "Sandbox", Status: appstore.StatusActive,
				EntitledUntil: f.service.now.Add(48 * time.Hour), SourceSignedAt: f.service.now, VerifiedAt: f.service.now,
			}
			if err := f.service.handler.broker.ApplyEntitlementNotification(context.Background(), appstore.Notification{
				UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Entitlement: entitlement,
			}); err != nil {
				t.Fatal(err)
			}
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), http.StatusOK, "")
			if got := f.verifier.calls.Load(); got != 4 {
				t.Fatalf("notification recovery called Apple: calls=%d", got)
			}
		})
	}
}

func (f *reconciliationFixture) assertHeartbeat(t *testing.T, token string) {
	t.Helper()
	digest := sha256.Sum256([]byte(token))
	rows, err := f.service.pool.Query(context.Background(), `
		SELECT refresh_inactive_expires_at, last_refreshed_at IS NULL
		FROM endpoints WHERE kind = 'host' OR refresh_token_hash = $1
	`, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var expiry time.Time
		var neverIssued bool
		if err := rows.Scan(&expiry, &neverIssued); err != nil {
			t.Fatal(err)
		}
		if !expiry.Equal(f.service.now.Add(30*24*time.Hour)) || !neverIssued {
			t.Fatalf("heartbeat expiry=%v neverIssued=%v", expiry, neverIssued)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := 1
	if token == f.appRefresh {
		want = 2
	}
	if count != want {
		t.Fatalf("heartbeat endpoint count=%d, want %d", count, want)
	}
}

func TestRefreshReconciliationRejectsRevokedAndUnknownCredentials(t *testing.T) {
	for _, revokeHost := range []bool{false, true} {
		f := newReconciliationFixture(t, appstore.StatusInactive, 0)
		token := f.appRefresh
		if revokeHost {
			token = f.hostRefresh
		}
		if err := f.service.handler.broker.RevokeRefreshToken(context.Background(), token); err != nil {
			t.Fatal(err)
		}
		for _, rejected := range []string{token, testSecret("vrr_", 99)} {
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + rejected}), http.StatusUnauthorized, "")
		}
		if got := f.verifier.calls.Load(); got != 0 {
			t.Fatalf("revoked/unknown credentials called Apple %d times", got)
		}
	}
}

func TestCancelledRefreshDoesNotRefundReconciliationAttempt(t *testing.T) {
	f := newReconciliationFixture(t, appstore.StatusInactive, 0)
	f.verifier.started, f.verifier.release = make(chan struct{}, 1), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/tokens/refresh", nil).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+f.hostRefresh)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.service.handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	select {
	case <-f.verifier.started:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not reach Apple")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled refresh did not finish")
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("request was not cancelled")
	}
	// Release the stub so an accidental refund fails the call-count assertion
	// instead of hanging the test on another Apple attempt.
	close(f.verifier.release)
	assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", map[string]string{"Authorization": "Bearer " + f.appRefresh}), http.StatusPaymentRequired, "3600")
	if got := f.verifier.calls.Load(); got != 1 {
		t.Fatalf("cancelled attempt was refunded: calls=%d", got)
	}
}
