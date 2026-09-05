import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseCanonicalSessionStoreJson, stringifyCanonicalSessionStoreJson } from "./canonical-json.ts";
import { REVIEW_DISCUSSION_SCHEMA_SQL } from "./discussion-schema.ts";
import { SESSION_STORE_SCHEMA_ID, SESSION_STORE_SCHEMA_SQL } from "./schema.ts";
import { SESSION_STORE_V1_SCHEMA_ID, SESSION_STORE_V1_SCHEMA_SQL } from "./schema-v1.ts";
import { SESSION_STORE_SCHEMA_VERSION, SessionStoreError } from "./types.ts";

function schemaDigest(db: DatabaseSync): string {
	const objects = db
		.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`)
		.all();
	// SQLite rows have null prototypes; canonical JSON accepts only ordinary objects.
	const canonical = stringifyCanonicalSessionStoreJson(
		objects.map((row) => ({ ...row })),
		"Schema objects",
	);
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function expectedDigest(sql: string): string {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(sql);
		return schemaDigest(db);
	} finally {
		db.close();
	}
}

const V1_DIGEST = expectedDigest(SESSION_STORE_V1_SCHEMA_SQL);
const V2_DIGEST = expectedDigest(SESSION_STORE_SCHEMA_SQL);

function mismatch(message: string): never {
	throw new SessionStoreError("store_schema_mismatch", message);
}

function validateSchema(db: DatabaseSync, version: 1 | 2): string {
	const digest = version === 1 ? V1_DIGEST : V2_DIGEST;
	const schemaId = version === 1 ? SESSION_STORE_V1_SCHEMA_ID : SESSION_STORE_SCHEMA_ID;
	if (db.prepare("PRAGMA user_version").get()?.user_version !== version || schemaDigest(db) !== digest) {
		mismatch("Session store DDL, views, triggers or version do not match the exact supported schema");
	}
	const metadata = new Map(
		db
			.prepare("SELECT key, value_json FROM store_metadata ORDER BY key")
			.all()
			.map((row) => {
				if (typeof row.key !== "string" || typeof row.value_json !== "string") mismatch("Invalid store metadata");
				try {
					return [row.key, parseCanonicalSessionStoreJson(row.value_json, "Store metadata")] as const;
				} catch {
					return mismatch("Store metadata must be canonical JSON");
				}
			}),
	);
	const storeId = metadata.get("store_id");
	const createdAt = metadata.get("created_at");
	if (
		metadata.size !== 5 ||
		metadata.get("schema_id") !== schemaId ||
		metadata.get("schema_digest") !== digest ||
		metadata.get("schema_version") !== version ||
		typeof storeId !== "string" ||
		storeId.length === 0 ||
		storeId.length > 512 ||
		storeId.includes("\0") ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(createdAt)) ||
		new Date(createdAt).toISOString() !== createdAt
	) {
		mismatch("Session store metadata does not match its schema version");
	}
	return storeId;
}

function validateIntegrity(db: DatabaseSync): void {
	const checks = db.prepare("PRAGMA integrity_check").all();
	if (checks.length !== 1 || checks[0]?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
		mismatch("Session store integrity verification failed");
	}
}

/** Only the exact frozen v1 schema can upgrade. All DDL and metadata commit together. */
export function initializeSessionStoreSchema(db: DatabaseSync): string {
	// Re-read after the write lock: another opener may have initialized/upgraded while we waited.
	db.exec("BEGIN IMMEDIATE");
	try {
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		if (version === 0) {
			if (db.prepare("SELECT 1 FROM main.sqlite_schema LIMIT 1").get()) {
				mismatch("Refusing to initialize an unversioned non-empty session store");
			}
			db.exec(SESSION_STORE_SCHEMA_SQL);
			const insert = db.prepare("INSERT INTO store_metadata (key, value_json) VALUES (?, ?)");
			for (const [key, value] of Object.entries({
				schema_id: SESSION_STORE_SCHEMA_ID,
				schema_digest: V2_DIGEST,
				store_id: randomUUID(),
				schema_version: SESSION_STORE_SCHEMA_VERSION,
				created_at: new Date().toISOString(),
			}))
				insert.run(key, stringifyCanonicalSessionStoreJson(value, "Store metadata"));
			db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
		} else if (version === 1) {
			validateSchema(db, 1);
			validateIntegrity(db);
			db.exec(REVIEW_DISCUSSION_SCHEMA_SQL);
			const update = db.prepare("UPDATE store_metadata SET value_json = ? WHERE key = ?");
			update.run(stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_ID, "Schema id"), "schema_id");
			update.run(stringifyCanonicalSessionStoreJson(V2_DIGEST, "Schema digest"), "schema_digest");
			update.run(
				stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_VERSION, "Schema version"),
				"schema_version",
			);
			db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
			validateIntegrity(db);
		} else if (version !== SESSION_STORE_SCHEMA_VERSION) {
			mismatch(`Session store schema version ${String(version)} is unsupported`);
		}
		const storeId = validateSchema(db, 2);
		db.exec("COMMIT");
		return storeId;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}
