package database_test

import (
	"context"
	"sort"
	"testing"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/database"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

func TestReconciliationMigrationPreservesExistingEntitlementData(t *testing.T) {
	pool := testdatabase.Open(t)
	ctx := context.Background()
	// Restore the pre-0003 shape only inside this disposable test schema, then
	// exercise the real migration runner with an existing bound entitlement.
	if _, err := pool.Exec(ctx, `
		ALTER TABLE app_store_entitlements DROP COLUMN last_reconcile_attempt_at;
		DELETE FROM schema_migrations WHERE version = 3;
		INSERT INTO app_store_entitlements (
			app_transaction_id, environment, product_id, subscription_group_id,
			status, entitled_until, source_signed_at, last_verified_at, updated_at
		) VALUES (
			'subscription-migration', 'Sandbox', 'volt-pro', 'group', 'active',
			'2026-09-21T12:00:00Z', '2026-08-21T12:00:00Z',
			'2026-08-21T12:01:00Z', '2026-08-21T12:01:00Z'
		);
		WITH inserted_grant AS (
			INSERT INTO grants (host_node_id, created_at)
			VALUES (repeat('a', 64), '2026-08-21T12:00:00Z') RETURNING id
		)
		INSERT INTO grant_entitlements (grant_id, app_transaction_id, bound_claim_created_at, bound_at)
		SELECT id, 'subscription-migration', '2026-08-21T12:00:00Z', '2026-08-21T12:01:00Z'
		FROM inserted_grant;
	`); err != nil {
		t.Fatal(err)
	}
	const snapshot = `
		SELECT jsonb_build_object(
			'entitlement', to_jsonb(entitlement) - 'last_reconcile_attempt_at',
			'binding', to_jsonb(binding), 'grant', to_jsonb(grant_record)
		)::text
		FROM app_store_entitlements AS entitlement
		JOIN grant_entitlements AS binding USING (app_transaction_id)
		JOIN grants AS grant_record ON grant_record.id = binding.grant_id
		WHERE entitlement.app_transaction_id = 'subscription-migration'
	`
	var before string
	if err := pool.QueryRow(ctx, snapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := database.Migrate(ctx, pool); err != nil {
			t.Fatalf("apply migration attempt %d: %v", i, err)
		}
	}
	var after string
	if err := pool.QueryRow(ctx, snapshot).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("migration changed bound entitlement data: before=%s after=%s", before, after)
	}
	var noAttempt bool
	if err := pool.QueryRow(ctx, `
		SELECT last_reconcile_attempt_at IS NULL FROM app_store_entitlements
		WHERE app_transaction_id = 'subscription-migration'
	`).Scan(&noAttempt); err != nil {
		t.Fatal(err)
	}
	if !noAttempt {
		t.Fatal("migration consumed an attempt for an existing entitlement")
	}
	if got := testdatabase.Count(t, pool, "schema_migrations"); got != 3 {
		t.Fatalf("migration count=%d, want 3", got)
	}
}

func TestMigrationsCreateAcceptedSchemaAndAreIdempotent(t *testing.T) {
	pool := testdatabase.Open(t)
	if err := database.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("rerun migrations: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = current_schema()
		  AND table_name <> 'schema_migrations'
	`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(tables)
	expected := []string{
		"app_store_approval_proofs",
		"app_store_entitlements",
		"app_store_notifications",
		"consumed_app_check_tokens",
		"endpoints",
		"grant_entitlements",
		"grants",
		"pairing_claims",
	}
	if len(tables) != len(expected) {
		t.Fatalf("tables = %v, want %v", tables, expected)
	}
	for index := range expected {
		if tables[index] != expected[index] {
			t.Fatalf("tables = %v, want %v", tables, expected)
		}
	}
	if got := testdatabase.Count(t, pool, "schema_migrations"); got != 3 {
		t.Fatalf("migration row count = %d, want 3", got)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO schema_migrations (version, name, checksum)
		VALUES (999, '0999_future.sql', $1)
	`, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(context.Background(), pool); err == nil {
		t.Fatal("migration runner accepted a database migrated beyond this binary")
	}
}
