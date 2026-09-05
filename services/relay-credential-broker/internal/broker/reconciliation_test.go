package broker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

func TestReconciliationReservationSurvivesEntitlementUpdatesAndGrantTransfer(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	ctx := context.Background()
	id := "subscription-reservation"
	oldHost := postgresTestSecret("vrr_", 2)
	claim, err := service.CreateBootstrapPairingClaim(ctx, strings.Repeat("a", 64), postgresTestHash(postgresTestSecret("vpc_", 1)), postgresTestHash(oldHost))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApprovePairingClaim(ctx, claim.ClaimID, postgresTestAppCheck(now, "old"), postgresTestEntitlement(now, id), strings.Repeat("b", 64), postgresTestHash(postgresTestSecret("vrr_", 3))); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	entitlement := postgresTestEntitlement(now, id)
	entitlement.Status = appstore.StatusInactive
	if err := service.ApplyEntitlementReconciliation(ctx, entitlement); err != nil {
		t.Fatal(err)
	}
	state, err := service.EntitlementForRefresh(ctx, oldHost)
	if err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, service, state.AppTransactionID, state.Environment, true)
	attemptedAt := now

	now = now.Add(time.Second)
	entitlement.SourceSignedAt, entitlement.VerifiedAt = now, now
	if err := service.ApplyEntitlementReconciliation(ctx, entitlement); err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, service, id, "Sandbox", false)
	now = now.Add(time.Second)
	entitlement.SourceSignedAt, entitlement.VerifiedAt = now, now
	if err := service.ApplyEntitlementNotification(ctx, appstore.Notification{
		UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Entitlement: entitlement,
	}); err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, service, id, "Sandbox", false)

	// Moving the same Apple identity to a different grant must not reset its budget.
	now = now.Add(time.Second)
	newHost := postgresTestSecret("vrr_", 5)
	newClaim, err := service.CreateBootstrapPairingClaim(ctx, strings.Repeat("c", 64), postgresTestHash(postgresTestSecret("vpc_", 4)), postgresTestHash(newHost))
	if err != nil {
		t.Fatal(err)
	}
	active := postgresTestEntitlement(now, id)
	for _, jti := range []string{"new", "approval-retry"} {
		if _, err := service.ApprovePairingClaim(ctx, newClaim.ClaimID, postgresTestAppCheck(now, jti), active, strings.Repeat("d", 64), postgresTestHash(postgresTestSecret("vrr_", 6))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.EntitlementForRefresh(ctx, oldHost); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("transferred host lookup error=%v", err)
	}
	now = now.Add(time.Second)
	entitlement.SourceSignedAt, entitlement.VerifiedAt = now, now
	if err := service.ApplyEntitlementReconciliation(ctx, entitlement); err != nil {
		t.Fatal(err)
	}
	state, err = service.EntitlementForRefresh(ctx, newHost)
	if err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, service, state.AppTransactionID, state.Environment, false)
	restarted := newPostgresBroker(t, pool, &now)
	assertReconciliationReservation(t, restarted, id, "Sandbox", false)

	other := entitlement
	other.AppTransactionID = "subscription-independent"
	if err := restarted.ApplyEntitlementReconciliation(ctx, other); err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, restarted, other.AppTransactionID, "Sandbox", true)
	assertReconciliationReservation(t, restarted, id, "Sandbox", false)

	now = attemptedAt.Add(time.Hour - time.Microsecond)
	assertReconciliationReservation(t, restarted, id, "Sandbox", false)
	now = attemptedAt.Add(time.Hour)
	assertReconciliationReservation(t, restarted, id, "Sandbox", true)
	now = attemptedAt.Add(-time.Hour)
	assertReconciliationReservation(t, restarted, id, "Sandbox", false)
}

func TestConcurrentReconciliationReservationsAdmitOnlyOneAttempt(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	first := newPostgresBroker(t, pool, &now)
	second := newPostgresBroker(t, pool, &now)
	entitlement := postgresTestEntitlement(now, "subscription-race")
	entitlement.Status = appstore.StatusInactive
	if err := first.ApplyEntitlementReconciliation(context.Background(), entitlement); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		admitted bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan outcome, 16)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < cap(results); i++ {
		go func() {
			<-start
			service := first
			if i%2 != 0 {
				service = second
			}
			admitted, err := service.TryReserveEntitlementReconciliation(ctx, entitlement.AppTransactionID, "Sandbox", 24*time.Hour)
			results <- outcome{admitted: admitted, err: err}
		}()
	}
	close(start)
	admitted := 0
	for i := 0; i < cap(results); i++ {
		result := <-results
		if result.err != nil {
			t.Errorf("concurrent admission: %v", result.err)
		}
		if result.admitted {
			admitted++
		}
	}
	if admitted != 1 {
		t.Fatalf("concurrent admitted attempts=%d, want 1", admitted)
	}
}

func TestReconciliationReservationRechecksCurrentEntitlement(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	ctx := context.Background()
	id := "subscription-freshness"
	entitlement := postgresTestEntitlement(now, id)
	entitlement.Status = appstore.StatusInactive
	if err := service.ApplyEntitlementReconciliation(ctx, entitlement); err != nil {
		t.Fatal(err)
	}
	// A notification can renew the entitlement after the handler's due lookup
	// but before admission. Admission must use the current row, not that snapshot.
	now = now.Add(time.Second)
	entitlement = postgresTestEntitlement(now, id)
	if err := service.ApplyEntitlementNotification(ctx, appstore.Notification{
		UUID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Entitlement: entitlement,
	}); err != nil {
		t.Fatal(err)
	}
	assertReconciliationReservation(t, service, id, "Sandbox", false)
	now = now.Add(24*time.Hour - time.Microsecond)
	assertReconciliationReservation(t, service, id, "Sandbox", false)
	now = now.Add(time.Microsecond)
	assertReconciliationReservation(t, service, id, "Production", false)
	assertReconciliationReservation(t, service, "missing", "Sandbox", false)
	assertReconciliationReservation(t, service, id, "Sandbox", true)

	if admitted, err := service.TryReserveEntitlementReconciliation(ctx, id, "Sandbox", 0); err == nil || admitted {
		t.Fatalf("invalid interval admitted=%v error=%v", admitted, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if admitted, err := service.TryReserveEntitlementReconciliation(cancelled, id, "Sandbox", 24*time.Hour); err == nil || admitted {
		t.Fatalf("cancelled reservation admitted=%v error=%v", admitted, err)
	}
}

func assertReconciliationReservation(t *testing.T, service *Broker, id, environment string, want bool) {
	t.Helper()
	admitted, err := service.TryReserveEntitlementReconciliation(context.Background(), id, environment, 24*time.Hour)
	if err != nil || admitted != want {
		t.Fatalf("reservation id=%s environment=%s admitted=%v error=%v, want %v", id, environment, admitted, err, want)
	}
}
