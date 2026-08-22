package database

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const migrationLockID int64 = 8_606_146_524_991_413_121

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	version  int64
	name     string
	sql      string
	checksum [sha256.Size]byte
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("PostgreSQL pool is required")
	}
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLockID); err != nil {
		return fmt.Errorf("lock migrations: %w", err)
	}
	defer func() {
		_, _ = connection.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLockID)
	}()

	if _, err := connection.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version bigint PRIMARY KEY,
			name text NOT NULL UNIQUE,
			checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
			applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
		)
	`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	if err := validateAppliedMigrations(ctx, connection.Conn(), migrations); err != nil {
		return err
	}
	for _, item := range migrations {
		if err := applyMigration(ctx, connection.Conn(), item); err != nil {
			return err
		}
	}
	return nil
}

func validateAppliedMigrations(ctx context.Context, connection *pgx.Conn, migrations []migration) error {
	expected := make(map[int64]migration, len(migrations))
	for _, item := range migrations {
		expected[item.version] = item
	}
	rows, err := connection.Query(ctx, `
		SELECT version, name, checksum FROM schema_migrations ORDER BY version
	`)
	if err != nil {
		return fmt.Errorf("read applied migrations: %w", err)
	}
	defer rows.Close()
	applied := make(map[int64]bool, len(migrations))
	for rows.Next() {
		var version int64
		var name string
		var checksum []byte
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return fmt.Errorf("read applied migration: %w", err)
		}
		item, ok := expected[version]
		if !ok {
			return fmt.Errorf("database contains unknown migration %d", version)
		}
		if name != item.name || !equalChecksum(checksum, item.checksum) {
			return fmt.Errorf("migration %d differs from the applied migration", version)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read applied migrations: %w", err)
	}
	missingEarlierMigration := false
	for _, item := range migrations {
		if !applied[item.version] {
			missingEarlierMigration = true
			continue
		}
		if missingEarlierMigration {
			return fmt.Errorf("database migration history has a gap before version %d", item.version)
		}
	}
	return nil
}

func applyMigration(ctx context.Context, connection *pgx.Conn, item migration) error {
	transaction, err := connection.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", item.name, err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()

	var name string
	var checksum []byte
	err = transaction.QueryRow(ctx, `
		SELECT name, checksum
		FROM schema_migrations
		WHERE version = $1
	`, item.version).Scan(&name, &checksum)
	switch {
	case err == nil:
		if name != item.name || !equalChecksum(checksum, item.checksum) {
			return fmt.Errorf("migration %d differs from the applied migration", item.version)
		}
		return transaction.Commit(ctx)
	case !errors.Is(err, pgx.ErrNoRows):
		return fmt.Errorf("read migration %s: %w", item.name, err)
	}
	if _, err := transaction.Exec(ctx, item.sql); err != nil {
		return fmt.Errorf("apply migration %s: %w", item.name, err)
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO schema_migrations (version, name, checksum)
		VALUES ($1, $2, $3)
	`, item.version, item.name, item.checksum[:]); err != nil {
		return fmt.Errorf("record migration %s: %w", item.name, err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %s: %w", item.name, err)
	}
	return nil
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	migrations := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}
		prefix, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			return nil, fmt.Errorf("migration %q has no numeric prefix", entry.Name())
		}
		version, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("migration %q has an invalid version", entry.Name())
		}
		contents, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		migrations = append(migrations, migration{
			version:  version,
			name:     entry.Name(),
			sql:      string(contents),
			checksum: sha256.Sum256(contents),
		})
	}
	sort.Slice(migrations, func(left, right int) bool {
		return migrations[left].version < migrations[right].version
	})
	for index, item := range migrations {
		if index > 0 && migrations[index-1].version == item.version {
			return nil, fmt.Errorf("migration version %d is duplicated", item.version)
		}
	}
	if len(migrations) == 0 {
		return nil, errors.New("no embedded migrations found")
	}
	return migrations, nil
}

func equalChecksum(value []byte, expected [sha256.Size]byte) bool {
	if len(value) != sha256.Size {
		return false
	}
	for index := range expected {
		if value[index] != expected[index] {
			return false
		}
	}
	return true
}
