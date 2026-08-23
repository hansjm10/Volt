package database_test

import (
	"context"
	"sort"
	"testing"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/database"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

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
	expected := []string{"consumed_app_check_tokens", "endpoints", "grants", "pairing_claims"}
	if len(tables) != len(expected) {
		t.Fatalf("tables = %v, want %v", tables, expected)
	}
	for index := range expected {
		if tables[index] != expected[index] {
			t.Fatalf("tables = %v, want %v", tables, expected)
		}
	}
	if got := testdatabase.Count(t, pool, "schema_migrations"); got != 1 {
		t.Fatalf("migration row count = %d, want 1", got)
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
