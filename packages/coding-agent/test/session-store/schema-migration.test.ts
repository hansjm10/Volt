import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientInputSemanticDigest, SessionManager } from "../../src/core/session-manager.ts";
import { stringifyCanonicalSessionStoreJson } from "../../src/core/session-store/canonical-json.ts";
import { REVIEW_DISCUSSION_SCHEMA_SQL } from "../../src/core/session-store/discussion-schema.ts";
import { SQLiteSessionStoreClient } from "../../src/core/session-store/index.ts";
import { initializeSessionStoreSchema } from "../../src/core/session-store/schema-migration.ts";
import { SESSION_STORE_V1_SCHEMA_SQL, SESSION_STORE_V1_TABLE_NAMES } from "../../src/core/session-store/schema-v1.ts";

const NOW = "2026-09-05T12:00:00.000Z";
const roots: string[] = [];
const clients: SQLiteSessionStoreClient[] = [];
const canonical = (value: unknown): string => stringifyCanonicalSessionStoreJson(value, "Fixture");

function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-review-migration-"));
	roots.push(root);
	return join(root, "sessions");
}

function schemaObjects(db: DatabaseSync): Record<string, unknown>[] {
	return db
		.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`)
		.all()
		.map((row) => ({ ...row }));
}

function seedV1(dir: string, ddl = SESSION_STORE_V1_SCHEMA_SQL): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "sessions.sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec(ddl);
		const digest = `sha256:${createHash("sha256")
			.update(canonical(schemaObjects(db)))
			.digest("hex")}`;
		for (const [key, value] of Object.entries({
			schema_id: "volt-session-store-v1",
			schema_digest: digest,
			schema_version: 1,
			store_id: "original-store",
			created_at: NOW,
		})) {
			db.prepare("INSERT INTO store_metadata VALUES (?, ?)").run(key, canonical(value));
		}
		db.exec("PRAGMA user_version = 1");
		db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at,
			visible, revision, leaf_entry_id, message_count, first_message) VALUES (?, ?, 5, ?, ?, ?, 1, 1, 'message', 1, 'preserved')`).run(
			"source",
			"source-generation",
			dir,
			NOW,
			NOW,
		);
		db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at,
			parent_session_directory, parent_store_id, parent_session_id, parent_session_generation)
			VALUES ('related', 'related-generation', 5, ?, ?, ?, ?, 'original-store', 'source', 'source-generation')`).run(
			dir,
			NOW,
			NOW,
			dir,
		);
		const input = { message: "pending", images: [] };
		const semanticDigest = createClientInputSemanticDigest("steer", input);
		const receipt = {
			type: "client_input_receipt",
			id: "receipt",
			ordinal: 1,
			parentId: null,
			timestamp: NOW,
			clientMessageId: "client",
			command: "steer",
			semanticDigest,
			input,
		};
		const message = {
			type: "message",
			id: "message",
			ordinal: 2,
			parentId: null,
			timestamp: NOW,
			message: { role: "user", content: "preserved", timestamp: Date.parse(NOW) },
		};
		db.prepare("INSERT INTO entries VALUES ('source', 'receipt', 1, NULL, 'client_input_receipt', ?, 1, ?)").run(
			NOW,
			canonical(receipt),
		);
		db.prepare("INSERT INTO entries VALUES ('source', 'message', 2, NULL, 'message', ?, 0, ?)").run(
			NOW,
			canonical(message),
		);
		db.prepare(
			"INSERT INTO client_inputs VALUES ('source', 'client', 'receipt', 'steer', ?, ?, NULL, NULL, 'accepted', NULL, NULL)",
		).run(semanticDigest, canonical(input));
		db.exec("INSERT INTO search_chunks VALUES ('source', 0, 'message', 'preserved')");
		db.prepare("INSERT INTO transaction_commits VALUES ('commit', 'source', 'source-generation', ?, 0, 1, ?)").run(
			`sha256:${"a".repeat(64)}`,
			NOW,
		);
	} finally {
		db.close();
	}
	return path;
}

function dump(db: DatabaseSync): unknown {
	return {
		version: db.prepare("PRAGMA user_version").get(),
		objects: schemaObjects(db),
		tables: Object.fromEntries(
			SESSION_STORE_V1_TABLE_NAMES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
		),
	};
}

async function open(dir: string): Promise<SQLiteSessionStoreClient> {
	const client = await SQLiteSessionStoreClient.open(dir);
	clients.push(client);
	return client;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Regression #341 exact v1 to v2 migration", () => {
	it("preserves every populated v1 row, identity, transcript, receipt and commit evidence", async () => {
		const dir = directory();
		const path = seedV1(dir);
		const beforeDb = new DatabaseSync(path);
		const tables = SESSION_STORE_V1_TABLE_NAMES.filter((name) => name !== "store_metadata");
		const before = Object.fromEntries(
			tables.map((table) => [table, beforeDb.prepare(`SELECT * FROM ${table}`).all()]),
		);
		beforeDb.close();
		const client = await open(dir);
		expect(client.info).toMatchObject({ storeId: "original-store", schemaVersion: 2 });
		const db = new DatabaseSync(path);
		try {
			expect(Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))).toEqual(
				before,
			);
			expect(db.prepare("SELECT value_json FROM store_metadata WHERE key = 'created_at'").get()?.value_json).toBe(
				canonical(NOW),
			);
			expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
		expect(await client.loadSession("source", "source-generation")).toMatchObject({
			session: { id: "source", sessionGeneration: "source-generation", revision: 1 },
			entries: [{ id: "receipt" }, { id: "message" }],
			clientInputs: [{ clientMessageId: "client", state: "accepted" }],
		});
		expect(
			await client.reconcileCommit({
				sessionId: "source",
				sessionGeneration: "source-generation",
				commitId: "commit",
				digest: `sha256:${"a".repeat(64)}`,
			}),
		).toMatchObject({ status: "committed", evidence: { beforeRevision: 0, afterRevision: 1 } });
		expect(await client.listReviewDiscussions("absent")).toEqual([]);
		const manager = await SessionManager.open({
			sessionDirectory: dir,
			storeId: "original-store",
			sessionId: "related",
			sessionGeneration: "related-generation",
		});
		try {
			expect(manager.getHeader()?.parentSession).toMatchObject({
				storeId: "original-store",
				sessionId: "source",
				sessionGeneration: "source-generation",
			});
		} finally {
			await manager.closePersistence();
		}
		await client.close();
		const reopened = await open(dir);
		expect(reopened.info.storeId).toBe("original-store");
		expect(await reopened.loadSession("source", "source-generation")).not.toBeNull();
	});

	it("creates fresh v2 stores and leaves repeat opens unchanged", async () => {
		const dir = directory();
		const client = await open(dir);
		expect(client.info.schemaVersion).toBe(2);
		await client.close();
		const db = new DatabaseSync(client.info.databasePath);
		const before = dump(db);
		db.close();
		const next = await open(dir);
		expect(next.info.storeId).toBe(client.info.storeId);
		const after = new DatabaseSync(next.info.databasePath);
		try {
			expect(dump(after)).toEqual(before);
		} finally {
			after.close();
		}
	});

	it("converges across simultaneous independent worker upgrades", async () => {
		const dir = directory();
		seedV1(dir);
		const results = await Promise.allSettled(Array.from({ length: 8 }, () => open(dir)));
		// Settle every opener before cleanup, including when one reports an error.
		expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		const opened = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		expect(new Set(opened.map((client) => client.info.storeId))).toEqual(new Set(["original-store"]));
		expect(opened.every((client) => client.info.schemaVersion === 2)).toBe(true);
		for (const client of opened)
			expect((await client.loadSession("source", "source-generation"))?.entries).toHaveLength(2);
	});

	it.each(["ddl", "version", "commit"])("rolls back %s failures completely and permits a clean retry", (phase) => {
		const path = seedV1(directory());
		const db = new DatabaseSync(path);
		try {
			const before = dump(db);
			const exec = db.exec.bind(db);
			const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
				if (phase === "commit" && sql === "COMMIT") throw new Error("injected commit failure");
				exec(sql);
				if (
					(phase === "ddl" && sql === REVIEW_DISCUSSION_SCHEMA_SQL) ||
					(phase === "version" && sql === "PRAGMA user_version = 2")
				)
					throw new Error("injected upgrade failure");
			});
			expect(() => initializeSessionStoreSchema(db)).toThrow(/injected/);
			expect(db.isTransaction).toBe(false);
			expect(dump(db)).toEqual(before);
			spy.mockRestore();
			expect(initializeSessionStoreSchema(db)).toBe("original-store");
			expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
		} finally {
			db.close();
		}
	});

	it("rolls back failed v2 postvalidation including metadata and retries from v1", () => {
		const db = new DatabaseSync(seedV1(directory()));
		try {
			const before = dump(db);
			const exec = db.exec.bind(db);
			const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
				exec(sql);
				if (sql === "PRAGMA user_version = 2") exec("CREATE VIEW unexpected_post_upgrade AS SELECT 1");
			});
			expect(() => initializeSessionStoreSchema(db)).toThrow(/exact supported schema/);
			expect(db.isTransaction).toBe(false);
			expect(dump(db)).toEqual(before);
			spy.mockRestore();
			expect(initializeSessionStoreSchema(db)).toBe("original-store");
		} finally {
			db.close();
		}
	});

	it.each([
		"DROP INDEX entries_parent_idx",
		"CREATE TRIGGER unexpected AFTER UPDATE ON sessions BEGIN SELECT 1; END",
		"CREATE VIEW unexpected AS SELECT 1",
		"UPDATE store_metadata SET value_json = '\"tampered\"' WHERE key = 'schema_digest'",
		"UPDATE store_metadata SET value_json = '\"other\"' WHERE key = 'schema_id'",
		"INSERT INTO store_metadata VALUES ('extra', 'true')",
		"UPDATE store_metadata SET value_json = ' 1' WHERE key = 'schema_version'",
		"PRAGMA user_version = 7",
		"PRAGMA foreign_keys = OFF; INSERT INTO search_chunks VALUES ('missing', 0, NULL, 'orphan')",
		"PRAGMA ignore_check_constraints = ON; UPDATE sessions SET format_version = 0",
	])("rejects tampering without partial upgrade: %s", async (sql) => {
		const dir = directory();
		const path = seedV1(dir);
		const db = new DatabaseSync(path);
		db.exec(sql);
		const before = dump(db);
		db.close();
		await expect(SQLiteSessionStoreClient.open(dir)).rejects.toMatchObject({ code: "store_schema_mismatch" });
		const after = new DatabaseSync(path);
		try {
			expect(dump(after)).toEqual(before);
		} finally {
			after.close();
		}
	});

	it("rejects weakened v1 DDL even when its metadata digest is recomputed", async () => {
		const dir = directory();
		seedV1(dir, SESSION_STORE_V1_SCHEMA_SQL.replace("format_version >= 1", "format_version >= 0"));
		await expect(SQLiteSessionStoreClient.open(dir)).rejects.toMatchObject({ code: "store_schema_mismatch" });
	});
});
