package testdatabase

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/database"
)

const testDatabaseEnvironment = "VOLT_TEST_DATABASE_URL"

func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv(testDatabaseEnvironment)
	if databaseURL == "" {
		t.Skipf("%s is not set; PostgreSQL integration test skipped", testDatabaseEnvironment)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL test database: %v", err)
	}
	var randomBytes [8]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "relay_broker_test_" + hex.EncodeToString(randomBytes[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create PostgreSQL test schema: %v", err)
	}

	configuration, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
		t.Fatal(err)
	}
	configuration.ConnConfig.RuntimeParams["search_path"] = schema
	configuration.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
		t.Fatal(err)
	}
	if err := database.Migrate(ctx, pool); err != nil {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
		t.Fatalf("migrate PostgreSQL test schema: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupContext, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupContext, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("drop PostgreSQL test schema: %v", err)
		}
		admin.Close()
	})
	return pool
}

func Count(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	allowed := map[string]bool{
		"consumed_app_check_tokens": true,
		"endpoints":                 true,
		"grants":                    true,
		"pairing_claims":            true,
		"schema_migrations":         true,
	}
	if !allowed[table] {
		t.Fatalf("unsupported test table %q", table)
	}
	var count int
	if err := pool.QueryRow(context.Background(), fmt.Sprintf("SELECT count(*) FROM %s", table)).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return count
}
