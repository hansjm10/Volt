import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	writePrivateNewFileSync,
} from "../../utils/private-files.ts";
import { fuzzyMatchSessionText } from "../session-search.ts";
import {
	digestSessionStoreTransactionPayload,
	parseCanonicalSessionStoreJson,
	stringifyCanonicalSessionStoreJson,
} from "./canonical-json.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerData,
	parseSessionStoreWorkerOperation,
	parseSessionStoreWorkerRequestEnvelope,
	type SessionStoreWorkerOperation,
	type SessionStoreWorkerResponseEnvelope,
} from "./protocol.ts";
import {
	SESSION_STORE_INDEX_NAMES,
	SESSION_STORE_SCHEMA_ID,
	SESSION_STORE_SCHEMA_SQL,
	SESSION_STORE_TABLE_NAMES,
} from "./schema.ts";
import {
	SESSION_STORE_BUSY_TIMEOUT_MS,
	SESSION_STORE_DATABASE_FILENAME,
	SESSION_STORE_SCHEMA_VERSION,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInput,
	type SessionStoreCommitEvidence,
	type SessionStoreCommitReconciliation,
	type SessionStoreCreateSessionInput,
	type SessionStoreDeleteSessionInput,
	type SessionStoreDeleteSessionResult,
	type SessionStoreEntry,
	SessionStoreError,
	type SessionStoreImportTransactionInput,
	type SessionStoreImportTransactionResult,
	type SessionStoreInfo,
	type SessionStoreLabel,
	type SessionStoreSearchChunk,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreSubagentSpawn,
	type SessionStoreTransactionResult,
} from "./types.ts";

const data = parseSessionStoreWorkerData(workerData);
const expectedTableNames = new Set<string>(SESSION_STORE_TABLE_NAMES);
const sessionDirectory = resolve(data.sessionDirectory);
const databasePath = resolve(sessionDirectory, SESSION_STORE_DATABASE_FILENAME);
const port = parentPort;
if (!port) throw new Error("Session store worker requires a parent port");

let database: DatabaseSync | undefined;
let storeId: string | undefined;
let closed = false;

function classifyOperationalStoreError(error: unknown): SessionStoreError | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
		return new SessionStoreError("store_busy", "SQLite session store is busy", { cause: error });
	}
	if (code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOT") {
		return new SessionStoreError("store_full", "SQLite session store is full", { cause: error });
	}
	if (
		(typeof code === "string" &&
			(code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY")) ||
		code === "EIO" ||
		code === "EMFILE" ||
		code === "ENFILE"
	) {
		return new SessionStoreError("store_io_error", "SQLite session store I/O failed", { cause: error });
	}
	return undefined;
}

function sqlString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlNullableString(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlInteger(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function hardenStoreArtifacts(): void {
	for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		if (existsSync(path)) hardenPrivateRegularFileSync(path);
	}
}

function pragmaInteger(db: DatabaseSync, sql: string, key: string): number {
	const row = db.prepare(sql).get();
	if (!row) throw new Error(`SQLite did not return ${key}`);
	return sqlInteger(row, key);
}

function pragmaString(db: DatabaseSync, sql: string, key: string): string {
	const row = db.prepare(sql).get();
	if (!row) throw new Error(`SQLite did not return ${key}`);
	return sqlString(row, key);
}

function withTransaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		hardenStoreArtifacts();
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function withDeferredReadTransaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN DEFERRED TRANSACTION");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function userSchemaObjects(db: DatabaseSync, type: "table" | "index"): string[] {
	return db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' AND (? <> 'index' OR sql IS NOT NULL) ORDER BY name",
		)
		.all(type, type)
		.map((row) => sqlString(row, "name"));
}

function schemaDigest(db: DatabaseSync): string {
	const objects = db
		.prepare(
			`SELECT type, name, tbl_name AS tableName, sql
			FROM sqlite_schema
			WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
			ORDER BY type, name`,
		)
		.all()
		.map((row) => ({
			type: sqlString(row, "type"),
			name: sqlString(row, "name"),
			tableName: sqlString(row, "tableName"),
			sql: sqlString(row, "sql"),
		}));
	const canonicalObjects = stringifyCanonicalSessionStoreJson(objects, "Session store schema objects");
	return `sha256:${createHash("sha256").update(canonicalObjects, "utf8").digest("hex")}`;
}

function expectedSchemaDigest(): string {
	const expected = new DatabaseSync(":memory:");
	try {
		expected.exec(SESSION_STORE_SCHEMA_SQL);
		return schemaDigest(expected);
	} finally {
		expected.close();
	}
}

const EXPECTED_SCHEMA_DIGEST = expectedSchemaDigest();

function assertExactNames(actual: readonly string[], expected: readonly string[], description: string): void {
	const expectedSorted = [...expected].sort();
	if (actual.length !== expectedSorted.length || actual.some((name, index) => name !== expectedSorted[index])) {
		throw new SessionStoreError(
			"store_schema_mismatch",
			`Session store ${description} do not match schema version ${SESSION_STORE_SCHEMA_VERSION}`,
		);
	}
}

function initializeNewSchema(db: DatabaseSync): void {
	const existingTables = userSchemaObjects(db, "table");
	if (existingTables.length > 0) {
		throw new SessionStoreError(
			"store_schema_mismatch",
			"Refusing to initialize an unversioned non-empty session store",
		);
	}
	withTransaction(db, () => {
		db.exec(SESSION_STORE_SCHEMA_SQL);
		const insertMetadata = db.prepare("INSERT INTO store_metadata (key, value_json) VALUES (?, ?)");
		insertMetadata.run("schema_id", stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_ID, "Schema id"));
		insertMetadata.run("schema_digest", stringifyCanonicalSessionStoreJson(EXPECTED_SCHEMA_DIGEST, "Schema digest"));
		insertMetadata.run("store_id", stringifyCanonicalSessionStoreJson(randomUUID(), "Store id"));
		insertMetadata.run(
			"schema_version",
			stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_VERSION, "Schema version"),
		);
		insertMetadata.run("created_at", stringifyCanonicalSessionStoreJson(new Date().toISOString(), "Creation time"));
		db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
	});
}

function validateSchema(db: DatabaseSync): void {
	const userVersion = pragmaInteger(db, "PRAGMA user_version", "user_version");
	if (userVersion !== SESSION_STORE_SCHEMA_VERSION) {
		throw new SessionStoreError(
			"store_schema_mismatch",
			`Session store schema version ${userVersion} is unsupported; expected ${SESSION_STORE_SCHEMA_VERSION}`,
		);
	}
	assertExactNames(userSchemaObjects(db, "table"), SESSION_STORE_TABLE_NAMES, "tables");
	assertExactNames(userSchemaObjects(db, "index"), SESSION_STORE_INDEX_NAMES, "indexes");
	if (schemaDigest(db) !== EXPECTED_SCHEMA_DIGEST) {
		throw new SessionStoreError(
			"store_schema_mismatch",
			"Session store DDL, views, or triggers do not match the expected schema",
		);
	}

	const strictRows = db
		.prepare("PRAGMA table_list")
		.all()
		.filter((row) => sqlString(row, "schema") === "main" && expectedTableNames.has(sqlString(row, "name")));
	if (
		strictRows.length !== SESSION_STORE_TABLE_NAMES.length ||
		strictRows.some((row) => sqlInteger(row, "strict") !== 1)
	) {
		throw new SessionStoreError("store_schema_mismatch", "Every session store table must use SQLite STRICT mode");
	}

	if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
		throw new SessionStoreError("store_schema_mismatch", "Session store contains foreign key violations");
	}

	const metadataRows = db.prepare("SELECT key, value_json FROM store_metadata ORDER BY key").all();
	const metadata = new Map(
		metadataRows.map((row) => [
			sqlString(row, "key"),
			parseCanonicalSessionStoreJson(sqlString(row, "value_json"), `Store metadata ${sqlString(row, "key")}`),
		]),
	);
	const persistedStoreId = metadata.get("store_id");
	if (
		metadata.size !== 5 ||
		metadata.get("schema_id") !== SESSION_STORE_SCHEMA_ID ||
		metadata.get("schema_digest") !== EXPECTED_SCHEMA_DIGEST ||
		metadata.get("schema_version") !== SESSION_STORE_SCHEMA_VERSION ||
		typeof metadata.get("created_at") !== "string" ||
		typeof persistedStoreId !== "string" ||
		persistedStoreId.length === 0 ||
		persistedStoreId.length > 512
	) {
		throw new SessionStoreError("store_schema_mismatch", "Session store metadata does not match its schema version");
	}
	storeId = persistedStoreId;
}

function openDatabase(): SessionStoreInfo {
	if (closed) throw new SessionStoreError("closed", "Session store is closed");
	if (database) return storeInfo();

	ensurePrivateDirectorySync(sessionDirectory);
	for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		if (existsSync(path)) hardenPrivateRegularFileSync(path);
	}
	if (!existsSync(databasePath)) writePrivateNewFileSync(databasePath, new Uint8Array());
	const preOpenStat = lstatSync(databasePath);
	if (preOpenStat.isSymbolicLink() || !preOpenStat.isFile() || preOpenStat.nlink !== 1) {
		throw new SessionStoreError("store_initialization_failed", "Session store path is not a private regular file");
	}

	let opened: DatabaseSync | undefined;
	try {
		opened = new DatabaseSync(databasePath, {
			enableForeignKeyConstraints: true,
			enableDoubleQuotedStringLiterals: false,
			allowExtension: false,
			timeout: SESSION_STORE_BUSY_TIMEOUT_MS,
			readBigInts: false,
			returnArrays: false,
			allowBareNamedParameters: false,
			allowUnknownNamedParameters: false,
		});
		const postOpenStat = lstatSync(databasePath);
		if (
			postOpenStat.isSymbolicLink() ||
			!postOpenStat.isFile() ||
			postOpenStat.nlink !== 1 ||
			postOpenStat.dev !== preOpenStat.dev ||
			postOpenStat.ino !== preOpenStat.ino
		) {
			throw new SessionStoreError("store_initialization_failed", "Session store path changed while opening");
		}
		opened.exec("PRAGMA trusted_schema = OFF");
		opened.exec("PRAGMA foreign_keys = ON");
		opened.exec(`PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS}`);
		const journalMode = pragmaString(opened, "PRAGMA journal_mode = WAL", "journal_mode").toLowerCase();
		if (journalMode !== "wal") throw new Error(`SQLite refused WAL journal mode: ${journalMode}`);
		opened.exec("PRAGMA synchronous = FULL");
		opened.exec("PRAGMA temp_store = MEMORY");
		opened.exec("PRAGMA secure_delete = ON");

		const userVersion = pragmaInteger(opened, "PRAGMA user_version", "user_version");
		if (userVersion === 0) initializeNewSchema(opened);
		validateSchema(opened);
		database = opened;
		hardenStoreArtifacts();
		return storeInfo();
	} catch (error) {
		if (opened?.isOpen) opened.close();
		if (error instanceof SessionStoreError) throw error;
		const operationalError = classifyOperationalStoreError(error);
		if (operationalError) throw operationalError;
		throw new SessionStoreError("store_initialization_failed", "Could not initialize SQLite session store", {
			cause: error,
		});
	}
}

function requireDatabase(): DatabaseSync {
	if (closed) throw new SessionStoreError("closed", "Session store is closed");
	if (!database) openDatabase();
	if (!database) throw new SessionStoreError("store_initialization_failed", "Session store did not initialize");
	hardenStoreArtifacts();
	return database;
}

function storeInfo(): SessionStoreInfo {
	const db = database;
	if (!db || !storeId) throw new SessionStoreError("store_initialization_failed", "Session store is not initialized");
	const journalMode = pragmaString(db, "PRAGMA journal_mode", "journal_mode").toLowerCase();
	const foreignKeys = pragmaInteger(db, "PRAGMA foreign_keys", "foreign_keys");
	const trustedSchema = pragmaInteger(db, "PRAGMA trusted_schema", "trusted_schema");
	const busyTimeout = pragmaInteger(db, "PRAGMA busy_timeout", "timeout");
	if (
		journalMode !== "wal" ||
		foreignKeys !== 1 ||
		trustedSchema !== 0 ||
		busyTimeout !== SESSION_STORE_BUSY_TIMEOUT_MS
	) {
		throw new SessionStoreError("store_schema_mismatch", "Required SQLite session store pragmas are not active");
	}
	return {
		storeId,
		databasePath,
		schemaVersion: SESSION_STORE_SCHEMA_VERSION,
		journalMode: "wal",
		foreignKeys: true,
		trustedSchema: false,
		busyTimeoutMs: SESSION_STORE_BUSY_TIMEOUT_MS,
	};
}

const SUMMARY_COLUMNS = `
	id,
	session_generation AS sessionGeneration,
	format_version AS formatVersion,
	cwd,
	created_at AS createdAt,
	updated_at AS updatedAt,
	parent_session_directory AS parentSessionDirectory,
	parent_store_id AS parentStoreId,
	parent_session_id AS parentSessionId,
	parent_session_generation AS parentSessionGeneration,
	origin,
	starting_git_context_recorded AS startingGitContextRecorded,
	starting_git_context_json AS startingGitContextJson,
	name,
	visible,
	revision,
	leaf_entry_id AS leafId,
	message_count AS messageCount,
	first_message AS firstMessage
`;

function summaryFromRow(row: Record<string, unknown>): SessionStoreSessionSummary {
	const origin = sqlNullableString(row, "origin");
	if (origin !== null && origin !== "subagent") throw new Error("Invalid SQLite origin column");
	const visible = sqlInteger(row, "visible");
	if (visible !== 0 && visible !== 1) throw new Error("Invalid SQLite visible column");
	const startingGitContextRecorded = sqlInteger(row, "startingGitContextRecorded");
	if (startingGitContextRecorded !== 0 && startingGitContextRecorded !== 1) {
		throw new Error("Invalid SQLite startingGitContextRecorded column");
	}
	const startingGitContextJson = sqlNullableString(row, "startingGitContextJson");
	if (startingGitContextRecorded === 0 && startingGitContextJson !== null) {
		throw new Error("Unrecorded starting Git context must be null");
	}
	return {
		id: sqlString(row, "id"),
		sessionGeneration: sqlString(row, "sessionGeneration"),
		formatVersion: sqlInteger(row, "formatVersion"),
		cwd: sqlString(row, "cwd"),
		createdAt: sqlString(row, "createdAt"),
		updatedAt: sqlString(row, "updatedAt"),
		parentSessionDirectory: sqlNullableString(row, "parentSessionDirectory"),
		parentStoreId: sqlNullableString(row, "parentStoreId"),
		parentSessionId: sqlNullableString(row, "parentSessionId"),
		parentSessionGeneration: sqlNullableString(row, "parentSessionGeneration"),
		origin,
		startingGitContextRecorded: startingGitContextRecorded === 1,
		startingGitContext:
			startingGitContextJson === null
				? null
				: parseCanonicalSessionStoreJson(startingGitContextJson, "Stored starting Git context"),
		name: sqlNullableString(row, "name"),
		visible: visible === 1,
		revision: sqlInteger(row, "revision"),
		leafId: sqlNullableString(row, "leafId"),
		messageCount: sqlInteger(row, "messageCount"),
		firstMessage: sqlString(row, "firstMessage"),
	};
}

function findSummary(
	db: DatabaseSync,
	sessionId: string,
	sessionGeneration?: string,
): SessionStoreSessionSummary | null {
	const row =
		sessionGeneration === undefined
			? db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId)
			: db
					.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ? AND session_generation = ?`)
					.get(sessionId, sessionGeneration);
	return row ? summaryFromRow(row) : null;
}

function insertSession(db: DatabaseSync, input: SessionStoreCreateSessionInput): void {
	try {
		db.prepare(
			`INSERT INTO sessions (
				id, session_generation, format_version, cwd, created_at, updated_at,
				parent_session_directory, parent_store_id, parent_session_id, parent_session_generation,
				origin, visible
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(
			input.id,
			input.sessionGeneration,
			input.formatVersion,
			input.cwd,
			input.createdAt,
			input.createdAt,
			input.parentSessionDirectory,
			input.parentStoreId,
			input.parentSessionId,
			input.parentSessionGeneration,
			input.origin,
		);
	} catch (error) {
		if (findSummary(db, input.id)) {
			throw new SessionStoreError("session_already_exists", `Session ${JSON.stringify(input.id)} already exists`, {
				cause: error,
			});
		}
		throw error;
	}
}

function createSession(input: SessionStoreCreateSessionInput): SessionStoreSessionSummary {
	const db = requireDatabase();
	return withTransaction(db, () => {
		insertSession(db, input);
		const summary = findSummary(db, input.id, input.sessionGeneration);
		if (!summary) throw new Error("Inserted session row could not be read");
		return summary;
	});
}

function listSessions(includeHidden: boolean, cwd: string | null): SessionStoreSessionSummary[] {
	const db = requireDatabase();
	let statement: StatementSync;
	let rows: Record<string, unknown>[];
	if (cwd === null) {
		statement = db.prepare(
			`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE (? = 1 OR visible = 1) ORDER BY updated_at DESC, id`,
		);
		rows = statement.all(includeHidden ? 1 : 0);
	} else {
		statement = db.prepare(
			`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE cwd = ? AND (? = 1 OR visible = 1) ORDER BY updated_at DESC, id`,
		);
		rows = statement.all(cwd, includeHidden ? 1 : 0);
	}
	return rows.map(summaryFromRow);
}

interface ParsedSearchQuery {
	readonly mode: "tokens" | "regex";
	readonly tokens: readonly { readonly kind: "fuzzy" | "phrase"; readonly value: string }[];
	readonly regex: RegExp | null;
	readonly invalid: boolean;
}

function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], regex: null, invalid: false };
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return { mode: "regex", tokens: [], regex: null, invalid: true };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i"), invalid: false };
		} catch {
			return { mode: "regex", tokens: [], regex: null, invalid: true };
		}
	}

	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buffer = "";
	let inQuote = false;
	const flush = (kind: "fuzzy" | "phrase"): void => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};
	for (const character of trimmed) {
		if (character === '"') {
			flush(inQuote ? "phrase" : "fuzzy");
			inQuote = !inQuote;
		} else if (!inQuote && /\s/u.test(character)) {
			flush("fuzzy");
		} else {
			buffer += character;
		}
	}
	if (inQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/u)
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
				.map((value) => ({ kind: "fuzzy" as const, value })),
			regex: null,
			invalid: false,
		};
	}
	flush("fuzzy");
	return { mode: "tokens", tokens, regex: null, invalid: false };
}

function matchesSearchText(text: string, parsed: ParsedSearchQuery): boolean {
	if (parsed.invalid) return false;
	if (parsed.mode === "regex") return parsed.regex !== null && text.search(parsed.regex) >= 0;
	if (parsed.tokens.length === 0) return true;

	let normalizedText: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "fuzzy") {
			if (!fuzzyMatchSessionText(token.value, text).matches) return false;
			continue;
		}
		normalizedText ??= text.toLowerCase().replace(/\s+/gu, " ").trim();
		const phrase = token.value.toLowerCase().replace(/\s+/gu, " ").trim();
		if (phrase && !normalizedText.includes(phrase)) return false;
	}
	return true;
}

function searchSessions(query: string, includeHidden: boolean, cwd: string | null): SessionStoreSessionSummary[] {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const sessions = listSessions(includeHidden, cwd);
		const parsed = parseSearchQuery(query);
		if (parsed.invalid || sessions.length === 0) return [];

		let chunkRows: Record<string, unknown>[];
		if (cwd === null) {
			chunkRows = db
				.prepare(
					`SELECT search_chunks.session_id AS sessionId, search_chunks.text
				FROM search_chunks
				JOIN sessions ON sessions.id = search_chunks.session_id
				WHERE (? = 1 OR sessions.visible = 1)
				ORDER BY search_chunks.session_id, search_chunks.chunk_index`,
				)
				.all(includeHidden ? 1 : 0);
		} else {
			chunkRows = db
				.prepare(
					`SELECT search_chunks.session_id AS sessionId, search_chunks.text
				FROM search_chunks
				JOIN sessions ON sessions.id = search_chunks.session_id
				WHERE sessions.cwd = ? AND (? = 1 OR sessions.visible = 1)
				ORDER BY search_chunks.session_id, search_chunks.chunk_index`,
				)
				.all(cwd, includeHidden ? 1 : 0);
		}
		const chunksBySession = new Map<string, string[]>();
		for (const row of chunkRows) {
			const sessionId = sqlString(row, "sessionId");
			const chunks = chunksBySession.get(sessionId) ?? [];
			chunks.push(sqlString(row, "text"));
			chunksBySession.set(sessionId, chunks);
		}
		return sessions.filter((session) => {
			const extractedText = (chunksBySession.get(session.id) ?? []).join(" ");
			return matchesSearchText(`${session.id} ${session.name ?? ""} ${extractedText} ${session.cwd}`, parsed);
		});
	});
}

function entryFromRow(row: Record<string, unknown>): SessionStoreEntry {
	return {
		id: sqlString(row, "id"),
		parentId: sqlNullableString(row, "parentId"),
		type: sqlString(row, "type"),
		timestamp: sqlString(row, "timestamp"),
		ordinal: sqlInteger(row, "ordinal"),
		isHostOnly: sqlInteger(row, "isHostOnly") === 1,
		payload: parseCanonicalSessionStoreJson(sqlString(row, "payloadJson"), "Stored session entry payload"),
	};
}

function labelFromRow(row: Record<string, unknown>): SessionStoreLabel {
	return {
		targetEntryId: sqlString(row, "targetEntryId"),
		label: sqlString(row, "label"),
		timestamp: sqlString(row, "timestamp"),
	};
}

function clientInputFromRow(row: Record<string, unknown>): SessionStoreClientInput {
	const command = sqlString(row, "command");
	if (command !== "prompt" && command !== "steer" && command !== "follow_up") {
		throw new Error("Invalid SQLite client input command");
	}
	const state = sqlString(row, "state");
	if (state !== "accepted" && state !== "started" && state !== "completed" && state !== "failed") {
		throw new Error("Invalid SQLite client input state");
	}
	const queuedInputJson = sqlNullableString(row, "queuedInputJson");
	return {
		clientMessageId: sqlString(row, "clientMessageId"),
		receiptEntryId: sqlString(row, "receiptEntryId"),
		command,
		semanticDigest: sqlString(row, "semanticDigest"),
		input: parseCanonicalSessionStoreJson(sqlString(row, "inputJson"), "Stored client input"),
		queuedEntryId: sqlNullableString(row, "queuedEntryId"),
		queuedInput:
			queuedInputJson === null
				? null
				: parseCanonicalSessionStoreJson(queuedInputJson, "Stored queued client input"),
		state,
		error: sqlNullableString(row, "error"),
		canonicalEntryId: sqlNullableString(row, "canonicalEntryId"),
	};
}

function spawnFromRow(row: Record<string, unknown>): SessionStoreSubagentSpawn {
	return {
		entryId: sqlString(row, "entryId"),
		toolCallId: sqlString(row, "toolCallId"),
		subagentId: sqlString(row, "subagentId"),
		agent: sqlString(row, "agent"),
		childSessionId: sqlString(row, "childSessionId"),
		childStoreId: sqlNullableString(row, "childStoreId"),
		requestKey: sqlString(row, "requestKey"),
	};
}

function chunkFromRow(row: Record<string, unknown>): SessionStoreSearchChunk {
	return {
		chunkIndex: sqlInteger(row, "chunkIndex"),
		entryId: sqlNullableString(row, "entryId"),
		text: sqlString(row, "text"),
	};
}

function loadSession(sessionId: string, sessionGeneration: string): SessionStoreSnapshot | null {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const session = findSummary(db, sessionId, sessionGeneration);
		if (!session) return null;
		const entries = db
			.prepare(
				`SELECT entry_id AS id, parent_entry_id AS parentId, entry_type AS type, timestamp, ordinal,
				is_host_only AS isHostOnly, payload_json AS payloadJson
			FROM entries WHERE session_id = ? ORDER BY ordinal`,
			)
			.all(sessionId)
			.map(entryFromRow);
		const labels = db
			.prepare(
				`SELECT target_entry_id AS targetEntryId, label, timestamp
			FROM labels WHERE session_id = ? ORDER BY target_entry_id`,
			)
			.all(sessionId)
			.map(labelFromRow);
		const clientInputs = db
			.prepare(
				`SELECT client_message_id AS clientMessageId, receipt_entry_id AS receiptEntryId, command,
				semantic_digest AS semanticDigest, input_json AS inputJson, queued_entry_id AS queuedEntryId,
				queued_input_json AS queuedInputJson, state, error, canonical_entry_id AS canonicalEntryId
			FROM client_inputs WHERE session_id = ? ORDER BY client_message_id`,
			)
			.all(sessionId)
			.map(clientInputFromRow);
		const subagentSpawns = db
			.prepare(
				`SELECT entry_id AS entryId, tool_call_id AS toolCallId, subagent_id AS subagentId, agent,
				child_session_id AS childSessionId, child_store_id AS childStoreId, request_key AS requestKey
			FROM subagent_spawns WHERE session_id = ? ORDER BY entry_id`,
			)
			.all(sessionId)
			.map(spawnFromRow);
		const searchChunks = db
			.prepare(
				`SELECT chunk_index AS chunkIndex, entry_id AS entryId, text
			FROM search_chunks WHERE session_id = ? ORDER BY chunk_index`,
			)
			.all(sessionId)
			.map(chunkFromRow);
		return { session, entries, labels, clientInputs, subagentSpawns, searchChunks };
	});
}

function evidenceFromRow(row: Record<string, unknown>): SessionStoreCommitEvidence {
	return {
		sessionId: sqlString(row, "sessionId"),
		sessionGeneration: sqlString(row, "sessionGeneration"),
		commitId: sqlString(row, "commitId"),
		digest: sqlString(row, "digest"),
		beforeRevision: sqlInteger(row, "beforeRevision"),
		afterRevision: sqlInteger(row, "afterRevision"),
		committedAt: sqlString(row, "committedAt"),
	};
}

function findCommit(db: DatabaseSync, commitId: string): SessionStoreCommitEvidence | null {
	const row = db
		.prepare(
			`SELECT commit_id AS commitId, session_id AS sessionId, session_generation AS sessionGeneration,
				digest, before_revision AS beforeRevision, after_revision AS afterRevision, committed_at AS committedAt
			FROM transaction_commits WHERE commit_id = ?`,
		)
		.get(commitId);
	return row ? evidenceFromRow(row) : null;
}

function reconcileCommit(input: {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly commitId: string;
	readonly digest: string;
}): SessionStoreCommitReconciliation {
	const evidence = findCommit(requireDatabase(), input.commitId);
	if (!evidence) return { status: "not_found" };
	if (
		evidence.sessionId !== input.sessionId ||
		evidence.sessionGeneration !== input.sessionGeneration ||
		evidence.digest !== input.digest
	) {
		return { status: "mismatch" };
	}
	return { status: "committed", evidence };
}

function assertMatchingDigest(input: SessionStoreApplyTransactionInput): void {
	const actualDigest = digestSessionStoreTransactionPayload(input.payload);
	if (actualDigest !== input.digest) {
		throw new SessionStoreError(
			"commit_digest_mismatch",
			"Session store transaction digest does not match its payload",
		);
	}
}

function applyTransactionInCurrentTransaction(
	db: DatabaseSync,
	input: SessionStoreApplyTransactionInput,
): SessionStoreTransactionResult {
	const previousCommit = findCommit(db, input.commitId);
	if (previousCommit) {
		if (
			previousCommit.sessionId !== input.sessionId ||
			previousCommit.sessionGeneration !== input.sessionGeneration ||
			previousCommit.digest !== input.digest
		) {
			throw new SessionStoreError(
				"commit_identity_conflict",
				`Commit id ${JSON.stringify(input.commitId)} is already bound to a different transaction`,
			);
		}
		return { status: "committed", evidence: previousCommit };
	}

	const summary = findSummary(db, input.sessionId, input.sessionGeneration);
	if (!summary) {
		throw new SessionStoreError("session_not_found", `Session ${JSON.stringify(input.sessionId)} does not exist`);
	}
	if (summary.revision !== input.expectedRevision) {
		return { status: "conflict", actualRevision: summary.revision };
	}
	const maxOrdinalRow = db
		.prepare("SELECT COALESCE(MAX(ordinal), 0) AS maxOrdinal FROM entries WHERE session_id = ?")
		.get(input.sessionId);
	if (!maxOrdinalRow) throw new Error("Could not determine the current session entry ordinal");
	let nextOrdinal = sqlInteger(maxOrdinalRow, "maxOrdinal") + 1;
	const insertEntry = db.prepare(
		`INSERT INTO entries (
			session_id, entry_id, ordinal, parent_entry_id, entry_type, timestamp, is_host_only, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const entry of input.payload.entries) {
		const ordinal = entry.ordinal ?? nextOrdinal;
		if (ordinal !== nextOrdinal) {
			throw new SessionStoreError(
				"constraint_failed",
				`Entry ${JSON.stringify(entry.id)} has a non-contiguous ordinal`,
			);
		}
		insertEntry.run(
			input.sessionId,
			entry.id,
			ordinal,
			entry.parentId,
			entry.type,
			entry.timestamp,
			entry.isHostOnly ? 1 : 0,
			stringifyCanonicalSessionStoreJson(entry.payload, `Entry ${entry.id} payload`),
		);
		nextOrdinal += 1;
	}

	const deleteLabel = db.prepare("DELETE FROM labels WHERE session_id = ? AND target_entry_id = ?");
	const upsertLabel = db.prepare(
		`INSERT INTO labels (session_id, target_entry_id, label, timestamp) VALUES (?, ?, ?, ?)
		ON CONFLICT (session_id, target_entry_id) DO UPDATE SET label = excluded.label, timestamp = excluded.timestamp`,
	);
	for (const label of input.payload.labels) {
		if (label.label === null) deleteLabel.run(input.sessionId, label.targetEntryId);
		else upsertLabel.run(input.sessionId, label.targetEntryId, label.label, label.timestamp);
	}

	const upsertClientInput = db.prepare(
		`INSERT INTO client_inputs (
			session_id, client_message_id, receipt_entry_id, command, semantic_digest, input_json,
			queued_entry_id, queued_input_json, state, error, canonical_entry_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (session_id, client_message_id) DO UPDATE SET
			receipt_entry_id = excluded.receipt_entry_id,
			command = excluded.command,
			semantic_digest = excluded.semantic_digest,
			input_json = excluded.input_json,
			queued_entry_id = excluded.queued_entry_id,
			queued_input_json = excluded.queued_input_json,
			state = excluded.state,
			error = excluded.error,
			canonical_entry_id = excluded.canonical_entry_id`,
	);
	for (const clientInput of input.payload.clientInputs) {
		upsertClientInput.run(
			input.sessionId,
			clientInput.clientMessageId,
			clientInput.receiptEntryId,
			clientInput.command,
			clientInput.semanticDigest,
			stringifyCanonicalSessionStoreJson(clientInput.input, "Client input"),
			clientInput.queuedEntryId,
			clientInput.queuedInput === null
				? null
				: stringifyCanonicalSessionStoreJson(clientInput.queuedInput, "Queued client input"),
			clientInput.state,
			clientInput.error,
			clientInput.canonicalEntryId,
		);
	}

	const insertSpawn = db.prepare(
		`INSERT INTO subagent_spawns (
			session_id, entry_id, tool_call_id, subagent_id, agent, child_session_id, child_store_id, request_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const spawn of input.payload.subagentSpawns) {
		insertSpawn.run(
			input.sessionId,
			spawn.entryId,
			spawn.toolCallId,
			spawn.subagentId,
			spawn.agent,
			spawn.childSessionId,
			spawn.childStoreId,
			spawn.requestKey,
		);
	}

	const upsertChunk = db.prepare(
		`INSERT INTO search_chunks (session_id, chunk_index, entry_id, text) VALUES (?, ?, ?, ?)
		ON CONFLICT (session_id, chunk_index) DO UPDATE SET entry_id = excluded.entry_id, text = excluded.text`,
	);
	for (const chunk of input.payload.searchChunks) {
		upsertChunk.run(input.sessionId, chunk.chunkIndex, chunk.entryId, chunk.text);
	}

	if (
		input.payload.session.leafId !== null &&
		!db
			.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND entry_id = ?")
			.get(input.sessionId, input.payload.session.leafId)
	) {
		throw new SessionStoreError("constraint_failed", "Session leaf must identify a stored entry");
	}

	const afterRevision = summary.revision + 1;
	const update = db
		.prepare(
			`UPDATE sessions SET
				updated_at = ?, starting_git_context_recorded = ?, starting_git_context_json = ?,
				name = ?, visible = ?, leaf_entry_id = ?, message_count = ?, first_message = ?, revision = ?
			WHERE id = ? AND session_generation = ? AND revision = ?`,
		)
		.run(
			input.payload.session.updatedAt,
			input.payload.session.startingGitContextRecorded ? 1 : 0,
			input.payload.session.startingGitContext === null
				? null
				: stringifyCanonicalSessionStoreJson(input.payload.session.startingGitContext, "Starting Git context"),
			input.payload.session.name,
			input.payload.session.visible ? 1 : 0,
			input.payload.session.leafId,
			input.payload.session.messageCount,
			input.payload.session.firstMessage,
			afterRevision,
			input.sessionId,
			input.sessionGeneration,
			summary.revision,
		);
	if (update.changes !== 1)
		throw new SessionStoreError("constraint_failed", "Session revision changed during transaction");

	const evidence: SessionStoreCommitEvidence = {
		sessionId: input.sessionId,
		sessionGeneration: input.sessionGeneration,
		commitId: input.commitId,
		digest: input.digest,
		beforeRevision: summary.revision,
		afterRevision,
		committedAt: new Date().toISOString(),
	};
	db.prepare(
		`INSERT INTO transaction_commits (
			commit_id, session_id, session_generation, digest, before_revision, after_revision, committed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		evidence.commitId,
		evidence.sessionId,
		evidence.sessionGeneration,
		evidence.digest,
		evidence.beforeRevision,
		evidence.afterRevision,
		evidence.committedAt,
	);
	return { status: "committed", evidence };
}

function applyTransaction(input: SessionStoreApplyTransactionInput): SessionStoreTransactionResult {
	assertMatchingDigest(input);
	const db = requireDatabase();
	try {
		return withTransaction(db, () => applyTransactionInCurrentTransaction(db, input));
	} catch (error) {
		if (error instanceof SessionStoreError) throw error;
		const operationalError = classifyOperationalStoreError(error);
		if (operationalError) throw operationalError;
		throw new SessionStoreError("constraint_failed", "SQLite rejected the session transaction", { cause: error });
	}
}

function immutableSessionMatches(summary: SessionStoreSessionSummary, input: SessionStoreCreateSessionInput): boolean {
	return (
		summary.id === input.id &&
		summary.sessionGeneration === input.sessionGeneration &&
		summary.formatVersion === input.formatVersion &&
		summary.cwd === input.cwd &&
		summary.createdAt === input.createdAt &&
		summary.parentSessionDirectory === input.parentSessionDirectory &&
		summary.parentStoreId === input.parentStoreId &&
		summary.parentSessionId === input.parentSessionId &&
		summary.parentSessionGeneration === input.parentSessionGeneration &&
		summary.origin === input.origin
	);
}

function importTransaction(input: SessionStoreImportTransactionInput): SessionStoreImportTransactionResult {
	assertMatchingDigest(input.transaction);
	const db = requireDatabase();
	try {
		return withTransaction(db, () => {
			const existing = findSummary(db, input.session.id);
			let createdSession = false;
			if (!existing) {
				if (input.transaction.expectedRevision !== 0) {
					throw new SessionStoreError("constraint_failed", "A new imported session must start at revision zero");
				}
				insertSession(db, input.session);
				createdSession = true;
			} else if (!immutableSessionMatches(existing, input.session)) {
				throw new SessionStoreError(
					"session_already_exists",
					`Session ${JSON.stringify(input.session.id)} exists with different immutable metadata`,
				);
			}
			return {
				createdSession,
				transaction: applyTransactionInCurrentTransaction(db, input.transaction),
			};
		});
	} catch (error) {
		if (error instanceof SessionStoreError) throw error;
		const operationalError = classifyOperationalStoreError(error);
		if (operationalError) throw operationalError;
		throw new SessionStoreError("constraint_failed", "SQLite rejected the imported session transaction", {
			cause: error,
		});
	}
}

function deleteSession(input: SessionStoreDeleteSessionInput): SessionStoreDeleteSessionResult {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const summary = findSummary(db, input.sessionId, input.sessionGeneration);
		if (!summary) return { status: "not_found" };
		if (summary.revision !== input.expectedRevision) {
			return { status: "conflict", actualRevision: summary.revision };
		}
		const result = db
			.prepare("DELETE FROM sessions WHERE id = ? AND session_generation = ? AND revision = ?")
			.run(input.sessionId, input.sessionGeneration, input.expectedRevision);
		if (result.changes !== 1) {
			throw new SessionStoreError("constraint_failed", "Session changed during conditional deletion");
		}
		return { status: "deleted" };
	});
}

function closeDatabase(): null {
	if (closed) return null;
	closed = true;
	if (database?.isOpen) database.close();
	database = undefined;
	storeId = undefined;
	hardenStoreArtifacts();
	return null;
}

function execute(operation: SessionStoreWorkerOperation): unknown {
	switch (operation.kind) {
		case "initialize":
			return openDatabase();
		case "create_session":
			return createSession(operation.input);
		case "load_session":
			return loadSession(operation.sessionId, operation.sessionGeneration);
		case "list_sessions":
			return listSessions(operation.includeHidden, operation.cwd);
		case "search_sessions":
			return searchSessions(operation.query, operation.includeHidden, operation.cwd);
		case "find_session":
			return findSummary(requireDatabase(), operation.sessionId, operation.sessionGeneration);
		case "find_session_by_id":
			return findSummary(requireDatabase(), operation.sessionId);
		case "apply_transaction":
			return applyTransaction(operation.input);
		case "reconcile_commit":
			return reconcileCommit(operation.input);
		case "delete_session":
			return deleteSession(operation.input);
		case "import_transaction":
			return importTransaction(operation.input);
		case "close":
			return closeDatabase();
	}
}

function errorResponse(requestId: number, error: unknown): SessionStoreWorkerResponseEnvelope {
	if (error instanceof SessionStoreError) {
		return { requestId, ok: false, error: { code: error.code, message: error.message } };
	}
	return {
		requestId,
		ok: false,
		error: {
			code: error instanceof TypeError ? "invalid_request" : "worker_failed",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

port.on("message", (message: unknown) => {
	let requestId = 1;
	try {
		const envelope = parseSessionStoreWorkerRequestEnvelope(message);
		requestId = envelope.requestId;
		const operationValue: unknown = JSON.parse(envelope.operationJson);
		const operation = parseSessionStoreWorkerOperation(operationValue);
		const result = execute(operation);
		const validatedResult = parseSessionStoreOperationResult(operation.kind, result);
		const response: SessionStoreWorkerResponseEnvelope = {
			requestId,
			ok: true,
			resultJson: stringifyCanonicalSessionStoreJson(validatedResult, "Session store worker result"),
		};
		port.postMessage(response);
	} catch (error) {
		port.postMessage(errorResponse(requestId, error));
	}
});
