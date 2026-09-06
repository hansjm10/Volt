import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	writePrivateNewFileSync,
} from "../../utils/private-files.ts";
import { decodeStoredSessionEntry, parsePersistedSessionEntry, sessionEntryEnvelope } from "../session-entry-codec.ts";
import type { SessionEntry } from "../session-manager.ts";
import { fuzzyMatchSessionText } from "../session-search.ts";
import { hardenSessionStoreSidecars } from "./artifacts.ts";
import {
	digestSessionStoreTransactionPayload,
	parseCanonicalSessionStoreJson,
	stringifyCanonicalSessionStoreJson,
} from "./canonical-json.ts";
import {
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	createSessionStoreTransactionValidationState,
	validateSessionStoreTransactionProjections,
} from "./projection.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerData,
	parseSessionStoreWorkerOperation,
	parseSessionStoreWorkerRequestEnvelope,
	type SessionStoreWorkerOperation,
	type SessionStoreWorkerResponseEnvelope,
} from "./protocol.ts";
import { initializeSessionStoreSchema } from "./schema-migration.ts";
import {
	SESSION_STORE_BUSY_TIMEOUT_MS,
	SESSION_STORE_DATABASE_FILENAME,
	SESSION_STORE_SCHEMA_VERSION,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInput,
	type SessionStoreCommitEvidence,
	type SessionStoreCommitReconciliation,
	type SessionStoreCreateReviewDiscussionInput,
	type SessionStoreCreateSessionInput,
	type SessionStoreDeleteSessionInput,
	type SessionStoreDeleteSessionResult,
	type SessionStoreEntry,
	SessionStoreError,
	type SessionStoreForeignKeyVerificationResult,
	type SessionStoreInfo,
	type SessionStoreRegisterReviewAnchorInput,
	type SessionStoreReplaceReviewGeneralInput,
	type SessionStoreResetReviewDiscussionInput,
	type SessionStoreResetReviewDiscussionResult,
	type SessionStoreReviewAnchor,
	type SessionStoreReviewDiscussion,
	type SessionStoreReviewDiscussionChild,
	type SessionStoreReviewSource,
	type SessionStoreSearchChunk,
	type SessionStoreSearchResult,
	type SessionStoreSessionIdentity,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreTransactionResult,
} from "./types.ts";

const data = parseSessionStoreWorkerData(workerData);
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

function sqlNullableInteger(row: Record<string, unknown>, key: string): number | null {
	const value = row[key];
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlBoolean(row: Record<string, unknown>, key: string): boolean {
	const value = sqlInteger(row, key);
	if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key} boolean column`);
	return value === 1;
}

function hardenStoreArtifacts(): void {
	hardenPrivateRegularFileSync(databasePath);
	hardenSessionStoreSidecars(databasePath);
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

function openDatabase(): SessionStoreInfo {
	if (closed) throw new SessionStoreError("closed", "Session store is closed");
	if (database) return storeInfo();

	ensurePrivateDirectorySync(sessionDirectory);
	hardenSessionStoreSidecars(databasePath);
	try {
		writePrivateNewFileSync(databasePath, new Uint8Array());
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	hardenPrivateRegularFileSync(databasePath);
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

		storeId = initializeSessionStoreSchema(opened);
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

function verifyForeignKeys(): SessionStoreForeignKeyVerificationResult {
	const row = requireDatabase().prepare("PRAGMA foreign_key_check").get();
	if (!row) return { status: "valid" };
	return {
		status: "violation",
		table: sqlString(row, "table"),
		rowId: sqlNullableInteger(row, "rowid"),
		parentTable: sqlString(row, "parent"),
		constraintIndex: sqlInteger(row, "fkid"),
	};
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

const SUMMARY_RESULT_COLUMNS = `
	id,
	sessionGeneration,
	formatVersion,
	cwd,
	createdAt,
	updatedAt,
	parentSessionDirectory,
	parentStoreId,
	parentSessionId,
	parentSessionGeneration,
	origin,
	startingGitContextRecorded,
	startingGitContextJson,
	name,
	visible,
	revision,
	leafId,
	messageCount,
	firstMessage
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
		startingGitContextRecorded: sqlBoolean(row, "startingGitContextRecorded"),
		startingGitContext:
			startingGitContextJson === null
				? null
				: parseCanonicalSessionStoreJson(startingGitContextJson, "Stored starting Git context"),
		name: sqlNullableString(row, "name"),
		visible: sqlBoolean(row, "visible"),
		revision: sqlInteger(row, "revision"),
		leafId: sqlNullableString(row, "leafId"),
		messageCount: sqlInteger(row, "messageCount"),
		firstMessage: sqlString(row, "firstMessage"),
	};
}

function findSummaryRow(
	db: DatabaseSync,
	sessionId: string,
	sessionGeneration?: string,
): Record<string, unknown> | undefined {
	return sessionGeneration === undefined
		? db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId)
		: db
				.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ? AND session_generation = ?`)
				.get(sessionId, sessionGeneration);
}

function findSummary(
	db: DatabaseSync,
	sessionId: string,
	sessionGeneration?: string,
): SessionStoreSessionSummary | null {
	const row = findSummaryRow(db, sessionId, sessionGeneration);
	return row ? summaryFromRow(row) : null;
}

function insertSession(db: DatabaseSync, input: SessionStoreCreateSessionInput): void {
	// Historical references are tombstones for exact incarnations, even after session deletion.
	if (
		db
			.prepare(`SELECT 1 FROM review_anchors WHERE source_session_id = ? AND source_session_generation = ?
		UNION ALL SELECT 1 FROM review_discussion_children WHERE child_session_id = ? AND child_session_generation = ?
		UNION ALL SELECT 1 FROM review_anchor_aliases WHERE session_id = ? AND session_generation = ? LIMIT 1`)
			.get(input.id, input.sessionGeneration, input.id, input.sessionGeneration, input.id, input.sessionGeneration)
	) {
		throw new SessionStoreError(
			"review_identity_conflict",
			"Cannot reuse a historically referenced session incarnation",
		);
	}
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

function reviewSourceAvailable(db: DatabaseSync, source: SessionStoreReviewSource): boolean {
	const summary = findSummary(db, source.sessionId, source.sessionGeneration);
	return summary !== null && canonicalCwdIdentity(summary.cwd) === source.cwd;
}

function findReviewAnchor(db: DatabaseSync, runId: string): SessionStoreReviewAnchor | null {
	const row = db.prepare("SELECT * FROM review_anchors WHERE run_id = ?").get(runId);
	if (!row) return null;
	const source = {
		sessionId: sqlString(row, "source_session_id"),
		sessionGeneration: sqlString(row, "source_session_generation"),
		cwd: sqlString(row, "cwd"),
	};
	const general = {
		sessionId: sqlString(row, "general_session_id"),
		sessionGeneration: sqlString(row, "general_session_generation"),
	};
	return {
		runId,
		source,
		createdAt: sqlString(row, "created_at"),
		sourceAvailable: reviewSourceAvailable(db, source),
		general,
		generalRevision: sqlInteger(row, "general_revision"),
		generalAvailable: reviewSourceAvailable(db, { ...general, cwd: source.cwd }),
	};
}

function resolveReviewAnchor(
	db: DatabaseSync,
	runId: string,
	member: SessionStoreReviewSource,
): SessionStoreReviewAnchor | null {
	const anchor = findReviewAnchor(db, runId);
	if (
		!anchor ||
		anchor.source.cwd !== canonicalCwdIdentity(member.cwd) ||
		!reviewSourceAvailable(db, { ...member, cwd: anchor.source.cwd })
	)
		return null;
	const canonical =
		anchor.source.sessionId === member.sessionId && anchor.source.sessionGeneration === member.sessionGeneration;
	const alias = db
		.prepare("SELECT 1 FROM review_anchor_aliases WHERE run_id = ? AND session_id = ? AND session_generation = ?")
		.get(runId, member.sessionId, member.sessionGeneration);
	return canonical || alias ? anchor : null;
}

function registerReviewAlias(
	runId: string,
	member: SessionStoreReviewSource,
	alias: SessionStoreReviewSource,
): SessionStoreReviewAnchor {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const anchor = resolveReviewAnchor(db, runId, member);
		if (!anchor)
			throw new SessionStoreError("review_identity_conflict", "Review handoff is not owned by this session");
		requireAvailableReviewSource(anchor);
		if (anchor.source.cwd !== canonicalCwdIdentity(alias.cwd))
			throw new SessionStoreError("review_cwd_mismatch", "Review handoff cwd mismatch");
		if (!reviewSourceAvailable(db, { ...alias, cwd: anchor.source.cwd }))
			throw new SessionStoreError("review_source_unavailable", "Review handoff session is unavailable");
		if (
			db
				.prepare(
					"SELECT 1 FROM review_discussion_children WHERE child_session_id = ? AND child_session_generation = ?",
				)
				.get(alias.sessionId, alias.sessionGeneration)
		)
			throw new SessionStoreError(
				"review_identity_conflict",
				"Discussion children cannot become source authorities",
			);
		db.prepare(
			"INSERT OR IGNORE INTO review_anchor_aliases (run_id, session_id, session_generation) VALUES (?, ?, ?)",
		).run(runId, alias.sessionId, alias.sessionGeneration);
		return anchor;
	});
}

/** Read-only membership includes historical finding children, never canonical write authority. */
function resolveReviewGeneral(
	db: DatabaseSync,
	runId: string,
	member: SessionStoreReviewSource,
): SessionStoreReviewAnchor | null {
	const anchor = findReviewAnchor(db, runId);
	if (
		!anchor ||
		anchor.source.cwd !== canonicalCwdIdentity(member.cwd) ||
		!reviewSourceAvailable(db, { ...member, cwd: anchor.source.cwd })
	)
		return null;
	if (resolveReviewAnchor(db, runId, member)) return anchor;
	const child = db
		.prepare(`SELECT 1 FROM review_discussion_children c
		JOIN review_discussions d ON d.discussion_id = c.discussion_id
		WHERE d.run_id = ? AND c.child_session_id = ? AND c.child_session_generation = ?`)
		.get(runId, member.sessionId, member.sessionGeneration);
	return child ? anchor : null;
}

function replaceReviewGeneral(input: SessionStoreReplaceReviewGeneralInput): SessionStoreReviewAnchor {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const anchor = resolveReviewAnchor(db, input.runId, input.member);
		if (
			!anchor ||
			!anchor.generalAvailable ||
			anchor.generalRevision !== input.expectedRevision ||
			anchor.general.sessionId !== input.member.sessionId ||
			anchor.general.sessionGeneration !== input.member.sessionGeneration
		)
			throw new SessionStoreError("review_identity_conflict", "Only the exact current General can replace itself");
		const replacement = input.replacement;
		if (
			anchor.source.cwd !== canonicalCwdIdentity(replacement.cwd) ||
			!reviewSourceAvailable(db, { ...replacement, cwd: anchor.source.cwd })
		)
			throw new SessionStoreError("review_source_unavailable", "Replacement General is unavailable");
		if (
			db
				.prepare(
					"SELECT 1 FROM review_discussion_children WHERE child_session_id = ? AND child_session_generation = ?",
				)
				.get(replacement.sessionId, replacement.sessionGeneration) ||
			(replacement.sessionId === input.member.sessionId &&
				replacement.sessionGeneration === input.member.sessionGeneration)
		)
			throw new SessionStoreError(
				"review_identity_conflict",
				"Replacement General must be a new source conversation",
			);
		db.prepare(
			"INSERT OR IGNORE INTO review_anchor_aliases (run_id, session_id, session_generation) VALUES (?, ?, ?)",
		).run(input.runId, replacement.sessionId, replacement.sessionGeneration);
		db.prepare(`UPDATE review_anchors SET general_session_id = ?, general_session_generation = ?, general_revision = general_revision + 1
			WHERE run_id = ? AND general_revision = ?`).run(
			replacement.sessionId,
			replacement.sessionGeneration,
			input.runId,
			input.expectedRevision,
		);
		return findReviewAnchor(db, input.runId)!;
	});
}

function assertReviewSource(anchor: Pick<SessionStoreReviewAnchor, "source">, source: SessionStoreReviewSource): void {
	if (anchor.source.sessionId !== source.sessionId || anchor.source.sessionGeneration !== source.sessionGeneration) {
		throw new SessionStoreError("review_identity_conflict", "Review run belongs to a different source incarnation");
	}
	if (anchor.source.cwd !== canonicalCwdIdentity(source.cwd)) {
		throw new SessionStoreError("review_cwd_mismatch", "Review source cwd does not match its canonical anchor");
	}
}

function requireAvailableReviewSource(anchor: Pick<SessionStoreReviewAnchor, "sourceAvailable">): void {
	if (!anchor.sourceAvailable)
		throw new SessionStoreError(
			"review_source_unavailable",
			"Review source is missing, deleted, stale or has a different cwd",
		);
}

function registerReviewAnchor(input: SessionStoreRegisterReviewAnchorInput): SessionStoreReviewAnchor {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const existing = findReviewAnchor(db, input.runId);
		if (existing) {
			assertReviewSource(existing, input.source);
			requireAvailableReviewSource(existing);
			return existing;
		}
		const source = { ...input.source, cwd: canonicalCwdIdentity(input.source.cwd) };
		const summary = findSummary(db, source.sessionId, source.sessionGeneration);
		if (!summary)
			throw new SessionStoreError("review_source_unavailable", "Review source incarnation does not exist");
		if (canonicalCwdIdentity(summary.cwd) !== source.cwd)
			throw new SessionStoreError("review_cwd_mismatch", "Review source cwd mismatch");
		db.prepare(
			`INSERT INTO review_anchors (run_id, source_session_id, source_session_generation, cwd, created_at,
			general_session_id, general_session_generation, general_revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(
			input.runId,
			source.sessionId,
			source.sessionGeneration,
			source.cwd,
			input.createdAt,
			source.sessionId,
			source.sessionGeneration,
		);
		return findReviewAnchor(db, input.runId)!;
	});
}

function reviewChildFromRow(
	db: DatabaseSync,
	row: Record<string, unknown>,
	cwd: string,
): SessionStoreReviewDiscussionChild {
	const child: SessionStoreSessionIdentity = {
		sessionId: sqlString(row, "child_session_id"),
		sessionGeneration: sqlString(row, "child_session_generation"),
	};
	const summary = findSummary(db, child.sessionId, child.sessionGeneration);
	return {
		discussionId: sqlString(row, "discussion_id"),
		ordinal: sqlInteger(row, "ordinal"),
		child,
		createdAt: sqlString(row, "created_at"),
		requestId: sqlString(row, "request_id"),
		kickoffClientMessageId: sqlString(row, "kickoff_client_message_id"),
		available: summary !== null && canonicalCwdIdentity(summary.cwd) === cwd,
	};
}

function reviewDiscussionFromRow(db: DatabaseSync, row: Record<string, unknown>): SessionStoreReviewDiscussion {
	const discussionId = sqlString(row, "discussion_id");
	const runId = sqlString(row, "run_id");
	const anchor = findReviewAnchor(db, runId);
	const childRow = db
		.prepare("SELECT * FROM review_discussion_children WHERE discussion_id = ? AND ordinal = ?")
		.get(discussionId, sqlInteger(row, "current_ordinal"));
	if (!anchor || !childRow)
		throw new SessionStoreError("constraint_failed", "Review discussion has missing canonical relations");
	return {
		discussionId,
		runId,
		findingId: sqlString(row, "finding_id"),
		source: anchor.source,
		sourceAvailable: anchor.sourceAvailable,
		contextSnapshot: parseCanonicalSessionStoreJson(sqlString(row, "context_snapshot_json"), "Review context"),
		createdAt: sqlString(row, "created_at"),
		current: reviewChildFromRow(db, childRow, anchor.source.cwd),
	};
}

function requireReviewDiscussion(db: DatabaseSync, discussionId: string): SessionStoreReviewDiscussion {
	const row = db.prepare("SELECT * FROM review_discussions WHERE discussion_id = ?").get(discussionId);
	if (!row) throw new SessionStoreError("review_discussion_not_found", "Review discussion does not exist");
	return reviewDiscussionFromRow(db, row);
}

function reserveReviewChild(
	db: DatabaseSync,
	input: SessionStoreCreateReviewDiscussionInput | SessionStoreResetReviewDiscussionInput,
	cwd: string,
	ordinal: number,
): void {
	if (canonicalCwdIdentity(input.child.cwd) !== cwd)
		throw new SessionStoreError("review_cwd_mismatch", "Discussion child must use the canonical source cwd");
	insertSession(db, input.child);
	db.prepare(`INSERT INTO review_discussion_children (discussion_id, ordinal, child_session_id, child_session_generation,
		request_id, request_json, kickoff_client_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
		input.discussionId,
		ordinal,
		input.child.id,
		input.child.sessionGeneration,
		input.requestId,
		stringifyCanonicalSessionStoreJson(input, "Review request"),
		input.kickoffClientMessageId,
		input.createdAt,
	);
}

function createReviewDiscussion(input: SessionStoreCreateReviewDiscussionInput): SessionStoreReviewDiscussion {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const anchor = findReviewAnchor(db, input.runId);
		if (!anchor)
			throw new SessionStoreError(
				"review_anchor_not_found",
				"Canonical review anchor must be registered before creating discussions",
			);
		assertReviewSource(anchor, input.source);
		requireAvailableReviewSource(anchor);
		if (canonicalCwdIdentity(input.child.cwd) !== anchor.source.cwd)
			throw new SessionStoreError("review_cwd_mismatch", "Discussion child cwd mismatch");
		const existing = db
			.prepare("SELECT * FROM review_discussions WHERE run_id = ? AND finding_id = ?")
			.get(input.runId, input.findingId);
		if (existing) return reviewDiscussionFromRow(db, existing);
		if (db.prepare("SELECT 1 FROM review_discussions WHERE discussion_id = ?").get(input.discussionId)) {
			throw new SessionStoreError("review_identity_conflict", "Discussion id already belongs to another finding");
		}
		db.prepare(`INSERT INTO review_discussions (discussion_id, run_id, finding_id, context_snapshot_json, created_at, current_ordinal)
			VALUES (?, ?, ?, ?, ?, 1)`).run(
			input.discussionId,
			input.runId,
			input.findingId,
			stringifyCanonicalSessionStoreJson(input.contextSnapshot, "Review context"),
			input.createdAt,
		);
		reserveReviewChild(db, input, anchor.source.cwd, 1);
		return requireReviewDiscussion(db, input.discussionId);
	});
}

function resetReviewDiscussion(input: SessionStoreResetReviewDiscussionInput): SessionStoreResetReviewDiscussionResult {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const discussion = requireReviewDiscussion(db, input.discussionId);
		const anchor = {
			runId: discussion.runId,
			source: discussion.source,
			createdAt: discussion.createdAt,
			sourceAvailable: discussion.sourceAvailable,
		};
		assertReviewSource(anchor, input.source);
		const previous = db
			.prepare("SELECT * FROM review_discussion_children WHERE discussion_id = ? AND request_id = ?")
			.get(input.discussionId, input.requestId);
		if (previous) {
			if (
				sqlString(previous, "request_json") !== stringifyCanonicalSessionStoreJson(input, "Review reset request")
			) {
				throw new SessionStoreError(
					"review_identity_conflict",
					"Review request id already identifies a different operation",
				);
			}
			return { status: "reset", child: reviewChildFromRow(db, previous, discussion.source.cwd) };
		}
		requireAvailableReviewSource(anchor);
		if (
			discussion.current.child.sessionId !== input.expectedChild.sessionId ||
			discussion.current.child.sessionGeneration !== input.expectedChild.sessionGeneration
		) {
			return { status: "conflict", child: discussion.current };
		}
		// A deleted current child can be reset, but never silently rebound to a reused id.
		const ordinal = discussion.current.ordinal + 1;
		reserveReviewChild(db, input, discussion.source.cwd, ordinal);
		db.prepare(
			"UPDATE review_discussions SET current_ordinal = ? WHERE discussion_id = ? AND current_ordinal = ?",
		).run(ordinal, input.discussionId, discussion.current.ordinal);
		return { status: "reset", child: requireReviewDiscussion(db, input.discussionId).current };
	});
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

function canonicalCwdIdentity(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function sessionCwdMatches(summary: SessionStoreSessionSummary, canonicalCwd: string | null): boolean {
	return canonicalCwd === null || canonicalCwdIdentity(summary.cwd) === canonicalCwd;
}

function listSessions(includeHidden: boolean, cwd: string | null): SessionStoreSessionSummary[] {
	const db = requireDatabase();
	const rows = includeHidden
		? db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions ORDER BY updated_at DESC, id`).all()
		: db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE visible = 1 ORDER BY updated_at DESC, id`).all();
	const canonicalCwd = cwd === null ? null : canonicalCwdIdentity(cwd);
	return rows.map(summaryFromRow).filter((summary) => sessionCwdMatches(summary, canonicalCwd));
}

function findContinuationSession(cwd: string | null): SessionStoreSessionSummary | null {
	const db = requireDatabase();
	const limitClause = cwd === null ? "LIMIT 1" : "";
	const statement = db.prepare(
		`WITH continuation_candidates AS (
			SELECT
				${SUMMARY_COLUMNS},
				EXISTS (
					SELECT 1
					FROM client_inputs
					WHERE client_inputs.session_id = sessions.id
						AND client_inputs.state IN ('accepted', 'started')
				) AS hasPendingInput,
				(
					SELECT entries.timestamp
					FROM entries
					WHERE entries.session_id = sessions.id
						AND entries.entry_type IN (
							'client_input_receipt',
							'client_input_queued',
							'client_input_state'
						)
					ORDER BY entries.ordinal DESC
					LIMIT 1
				) AS pendingInputAt
			FROM sessions
		)
		SELECT ${SUMMARY_RESULT_COLUMNS}
		FROM continuation_candidates
		WHERE visible = 1 OR hasPendingInput = 1
		ORDER BY
			CASE
				WHEN hasPendingInput = 1 AND pendingInputAt > updatedAt THEN pendingInputAt
				ELSE updatedAt
			END DESC,
			id
		${limitClause}`,
	);
	const canonicalCwd = cwd === null ? null : canonicalCwdIdentity(cwd);
	for (const row of statement.iterate()) {
		const summary = summaryFromRow(row);
		if (sessionCwdMatches(summary, canonicalCwd)) return summary;
	}
	return null;
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

function matchSearchText(text: string, parsed: ParsedSearchQuery): { matches: boolean; score: number } {
	if (parsed.invalid) return { matches: false, score: 0 };
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const index = text.search(parsed.regex);
		return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
	}
	if (parsed.tokens.length === 0) return { matches: true, score: 0 };

	let score = 0;
	let normalizedText: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "fuzzy") {
			const match = fuzzyMatchSessionText(token.value, text);
			if (!match.matches) return { matches: false, score: 0 };
			score += match.score;
			continue;
		}
		normalizedText ??= text.toLowerCase().replace(/\s+/gu, " ").trim();
		const phrase = token.value.toLowerCase().replace(/\s+/gu, " ").trim();
		if (!phrase) continue;
		const index = normalizedText.indexOf(phrase);
		if (index < 0) return { matches: false, score: 0 };
		score += index * 0.1;
	}
	return { matches: true, score };
}

/**
 * Deep search preserves the established matcher while retaining chunks for at
 * most one session document. Latency still scales with searchable bytes and
 * query complexity; JavaScript RegExp execution has no general time bound.
 */
function searchSessions(query: string, includeHidden: boolean, cwd: string | null): SessionStoreSearchResult[] {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const sessions = listSessions(includeHidden, cwd);
		const parsed = parseSearchQuery(query);
		if (parsed.invalid || sessions.length === 0) return [];

		const chunksForSession = db.prepare(
			`SELECT text FROM search_chunks
			WHERE session_id = ?
			ORDER BY chunk_index`,
		);
		const results: SessionStoreSearchResult[] = [];
		for (const session of sessions) {
			const chunks: string[] = [];
			for (const row of chunksForSession.iterate(session.id)) chunks.push(sqlString(row, "text"));
			const extractedText = chunks.join(" ");
			const match = matchSearchText(`${session.id} ${session.name ?? ""} ${extractedText} ${session.cwd}`, parsed);
			if (match.matches) results.push({ summary: session, score: match.score });
		}
		results.sort((left, right) => {
			if (left.score !== right.score) return left.score - right.score;
			return Date.parse(right.summary.updatedAt) - Date.parse(left.summary.updatedAt);
		});
		return results;
	});
}

function entryFromRow(row: Record<string, unknown>): SessionStoreEntry {
	const stored: SessionStoreEntry = {
		id: sqlString(row, "id"),
		parentId: sqlNullableString(row, "parentId"),
		type: sqlString(row, "type"),
		timestamp: sqlString(row, "timestamp"),
		ordinal: sqlInteger(row, "ordinal"),
		isHostOnly: sqlBoolean(row, "isHostOnly"),
		payload: parseCanonicalSessionStoreJson(sqlString(row, "payloadJson"), "Stored session entry payload"),
	};
	decodeStoredSessionEntry(stored);
	return stored;
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

function chunkFromRow(row: Record<string, unknown>): SessionStoreSearchChunk {
	return {
		chunkIndex: sqlInteger(row, "chunkIndex"),
		entryId: sqlNullableString(row, "entryId"),
		text: sqlString(row, "text"),
	};
}

function projectionIntegrityError(
	component: "summary" | "client_inputs" | "search_chunks",
	cause: unknown,
): SessionStoreError {
	return new SessionStoreError(
		"session_store_projection_integrity",
		`Session store ${component} projection does not match canonical entries`,
		{ cause },
	);
}

function loadSession(sessionId: string, sessionGeneration: string): SessionStoreSnapshot | null {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const summaryRow = findSummaryRow(db, sessionId, sessionGeneration);
		if (!summaryRow) return null;
		let session: SessionStoreSessionSummary;
		try {
			session = summaryFromRow(summaryRow);
			parseSessionStoreOperationResult("find_session", session);
		} catch (error) {
			throw projectionIntegrityError("summary", error);
		}
		const entryRows = db
			.prepare(
				`SELECT entry_id AS id, parent_entry_id AS parentId, entry_type AS type, timestamp, ordinal,
				is_host_only AS isHostOnly, payload_json AS payloadJson
			FROM entries WHERE session_id = ? ORDER BY ordinal`,
			)
			.all(sessionId);
		let entries: SessionStoreEntry[];
		try {
			entries = entryRows.map(entryFromRow);
		} catch (error) {
			throw new SessionStoreError(
				"session_store_entry_integrity",
				"Session store canonical entries are invalid or inconsistent",
				{ cause: error },
			);
		}
		let clientInputs: SessionStoreClientInput[];
		try {
			clientInputs = db
				.prepare(
					`SELECT client_message_id AS clientMessageId, receipt_entry_id AS receiptEntryId, command,
					semantic_digest AS semanticDigest, input_json AS inputJson, queued_entry_id AS queuedEntryId,
					queued_input_json AS queuedInputJson, state, error, canonical_entry_id AS canonicalEntryId
				FROM client_inputs WHERE session_id = ? ORDER BY client_message_id`,
				)
				.all(sessionId)
				.map(clientInputFromRow);
		} catch (error) {
			throw projectionIntegrityError("client_inputs", error);
		}
		let searchChunks: SessionStoreSearchChunk[];
		try {
			searchChunks = db
				.prepare(
					`SELECT chunk_index AS chunkIndex, entry_id AS entryId, text
				FROM search_chunks WHERE session_id = ? ORDER BY chunk_index`,
				)
				.all(sessionId)
				.map(chunkFromRow);
		} catch (error) {
			throw projectionIntegrityError("search_chunks", error);
		}
		return { session, entries, clientInputs, searchChunks };
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

interface StoredEntryRelation {
	readonly parentId: string | null;
	readonly isHostOnly: boolean;
}

function validateTransactionEntryReferences(
	db: DatabaseSync,
	sessionId: string,
	entries: SessionStoreApplyTransactionInput["payload"]["entries"],
): Array<SessionEntry & { ordinal: number }> {
	const validatedEntries: Array<SessionEntry & { ordinal: number }> = [];
	const relations = new Map<string, StoredEntryRelation>();
	const findStored = db.prepare(
		`SELECT parent_entry_id AS parentId, entry_type AS type, is_host_only AS isHostOnly
		FROM entries WHERE session_id = ? AND entry_id = ?`,
	);
	const relationFor = (entryId: string): StoredEntryRelation | undefined => {
		const pending = relations.get(entryId);
		if (pending) return pending;
		const row = findStored.get(sessionId, entryId);
		if (!row) return undefined;
		const relation = {
			parentId: sqlNullableString(row, "parentId"),
			isHostOnly: sqlBoolean(row, "isHostOnly"),
		};
		relations.set(entryId, relation);
		return relation;
	};
	let sawStartingGitContext =
		db
			.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND entry_type = ? LIMIT 1")
			.get(sessionId, "session_start_git_context") !== undefined;

	for (const write of entries) {
		const entry = parsePersistedSessionEntry(write.entry);
		const envelope = sessionEntryEnvelope(entry);
		if (relationFor(envelope.id)) {
			throw new SessionStoreError("constraint_failed", `Entry ${JSON.stringify(envelope.id)} already exists`);
		}
		if (envelope.parentId !== null && !relationFor(envelope.parentId)) {
			throw new SessionStoreError(
				"constraint_failed",
				`Entry ${JSON.stringify(envelope.id)} has an invalid or forward parent`,
			);
		}
		if (entry.type === "compaction") {
			let currentId = entry.parentId;
			const visited = new Set<string>();
			while (currentId !== null && currentId !== entry.firstKeptEntryId) {
				if (visited.has(currentId)) {
					throw new SessionStoreError("constraint_failed", "Session entry parent chain contains a cycle");
				}
				visited.add(currentId);
				currentId = relationFor(currentId)?.parentId ?? null;
			}
			if (currentId !== entry.firstKeptEntryId) {
				throw new SessionStoreError(
					"constraint_failed",
					`Compaction entry ${JSON.stringify(entry.id)} has an invalid first-kept boundary`,
				);
			}
		}
		if (entry.type === "leaf" || entry.type === "label") {
			const targetId = entry.targetId;
			if (targetId !== null) {
				const target = relationFor(targetId);
				if (!target || target.isHostOnly) {
					throw new SessionStoreError(
						"constraint_failed",
						`${entry.type === "leaf" ? "Leaf" : "Label"} entry ${JSON.stringify(entry.id)} has an invalid target`,
					);
				}
			}
		}
		if (entry.type === "branch_summary" && entry.fromId !== (entry.parentId ?? "root")) {
			throw new SessionStoreError(
				"constraint_failed",
				`Branch summary entry ${JSON.stringify(entry.id)} has an invalid source`,
			);
		}
		if (entry.type === "session_start_git_context") {
			if (sawStartingGitContext) {
				throw new SessionStoreError("constraint_failed", "Session has more than one starting Git context entry");
			}
			sawStartingGitContext = true;
		}
		relations.set(envelope.id, {
			parentId: envelope.parentId,
			isHostOnly: envelope.isHostOnly,
		});
		validatedEntries.push(entry);
	}
	return validatedEntries;
}

function clientMessageIdForEntry(entry: SessionEntry): string | undefined {
	if (
		entry.type === "client_input_receipt" ||
		entry.type === "client_input_queued" ||
		entry.type === "client_input_state"
	) {
		return entry.clientMessageId;
	}
	return entry.type === "message" && entry.message.role === "user" ? entry.message.clientMessageId : undefined;
}

function loadTransactionClientInputs(
	db: DatabaseSync,
	sessionId: string,
	entries: readonly SessionEntry[],
): SessionStoreClientInput[] {
	const selected = new Map<string, SessionStoreClientInput>();
	const selectColumns = `client_message_id AS clientMessageId, receipt_entry_id AS receiptEntryId, command,
		semantic_digest AS semanticDigest, input_json AS inputJson, queued_entry_id AS queuedEntryId,
		queued_input_json AS queuedInputJson, state, error, canonical_entry_id AS canonicalEntryId`;
	const retain = (row: Record<string, unknown>): void => {
		const clientInput = clientInputFromRow(row);
		selected.set(clientInput.clientMessageId, clientInput);
	};
	for (const row of db
		.prepare(
			`SELECT ${selectColumns} FROM client_inputs
			WHERE session_id = ? AND state IN ('accepted', 'started')
			LIMIT ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES + 1}`,
		)
		.all(sessionId)) {
		retain(row);
	}
	const findStored = db.prepare(
		`SELECT ${selectColumns} FROM client_inputs WHERE session_id = ? AND client_message_id = ?`,
	);
	const affectedClientIds = new Set(entries.map(clientMessageIdForEntry).filter((id) => id !== undefined));
	for (const clientMessageId of affectedClientIds) {
		if (selected.has(clientMessageId)) continue;
		const row = findStored.get(sessionId, clientMessageId);
		if (row) retain(row);
	}
	return [...selected.values()];
}

function nextEntryOrdinal(db: DatabaseSync, sessionId: string): number {
	const row = db
		.prepare("SELECT COALESCE(MAX(ordinal), 0) AS maxOrdinal FROM entries WHERE session_id = ?")
		.get(sessionId);
	if (!row) throw new Error("Could not determine the current session entry ordinal");
	return sqlInteger(row, "maxOrdinal") + 1;
}

function nextSearchChunkIndex(db: DatabaseSync, sessionId: string): number {
	const row = db
		.prepare(
			"SELECT COALESCE(MAX(chunk_index), -1) AS maxChunkIndex, COUNT(*) AS chunkCount FROM search_chunks WHERE session_id = ?",
		)
		.get(sessionId);
	if (!row) throw new Error("Could not determine the current session search chunk index");
	const nextIndex = sqlInteger(row, "maxChunkIndex") + 1;
	if (nextIndex !== sqlInteger(row, "chunkCount")) {
		throw new Error("Stored session search chunk indexes are not contiguous");
	}
	return nextIndex;
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

	const summaryRow = findSummaryRow(db, input.sessionId, input.sessionGeneration);
	if (!summaryRow) {
		throw new SessionStoreError("session_not_found", `Session ${JSON.stringify(input.sessionId)} does not exist`);
	}
	const summary = summaryFromRow(summaryRow);
	if (summary.revision !== input.expectedRevision) {
		return { status: "conflict", actualRevision: summary.revision };
	}
	const canonicalEntries = validateTransactionEntryReferences(db, input.sessionId, input.payload.entries);
	const firstNewOrdinal = nextEntryOrdinal(db, input.sessionId);
	const transitionState = createSessionStoreTransactionValidationState(
		summary.createdAt,
		loadTransactionClientInputs(db, input.sessionId, canonicalEntries),
		firstNewOrdinal,
		nextSearchChunkIndex(db, input.sessionId),
	);
	validateSessionStoreTransactionProjections(
		transitionState,
		canonicalEntries,
		input.payload.clientInputs,
		input.payload.searchChunks,
	);
	let insertionOrdinal = firstNewOrdinal;
	const insertEntry = db.prepare(
		`INSERT INTO entries (
			session_id, entry_id, ordinal, parent_entry_id, entry_type, timestamp, is_host_only, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const entry of canonicalEntries) {
		const envelope = sessionEntryEnvelope(entry);
		if (envelope.ordinal !== insertionOrdinal) {
			throw new SessionStoreError(
				"constraint_failed",
				`Entry ${JSON.stringify(envelope.id)} has a non-contiguous ordinal`,
			);
		}
		insertEntry.run(
			input.sessionId,
			envelope.id,
			envelope.ordinal,
			envelope.parentId,
			envelope.type,
			envelope.timestamp,
			envelope.isHostOnly ? 1 : 0,
			stringifyCanonicalSessionStoreJson(entry, `Entry ${envelope.id} payload`),
		);
		insertionOrdinal += 1;
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

	const insertChunk = db.prepare(
		"INSERT INTO search_chunks (session_id, chunk_index, entry_id, text) VALUES (?, ?, ?, ?)",
	);
	for (const chunk of input.payload.searchChunks) {
		insertChunk.run(input.sessionId, chunk.chunkIndex, chunk.entryId, chunk.text);
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
		case "replace_review_general":
			return replaceReviewGeneral(operation.input);
		case "resolve_review_general":
			return withDeferredReadTransaction(requireDatabase(), () =>
				resolveReviewGeneral(requireDatabase(), operation.runId, operation.member),
			);
		case "register_review_alias":
			return registerReviewAlias(operation.runId, operation.member, operation.alias);
		case "resolve_review_anchor":
			return withDeferredReadTransaction(requireDatabase(), () =>
				resolveReviewAnchor(requireDatabase(), operation.runId, operation.member),
			);
		case "register_review_anchor":
			return registerReviewAnchor(operation.input);
		case "create_review_discussion":
			return createReviewDiscussion(operation.input);
		case "reset_review_discussion":
			return resetReviewDiscussion(operation.input);
		case "find_review_anchor":
			return withDeferredReadTransaction(requireDatabase(), () =>
				findReviewAnchor(requireDatabase(), operation.runId),
			);
		case "find_review_discussion_by_id":
		case "find_review_discussion":
		case "find_review_discussion_by_child":
		case "list_review_discussions":
		case "list_review_discussion_history": {
			const db = requireDatabase();
			return withDeferredReadTransaction(db, () => {
				if (operation.kind === "find_review_discussion_by_id") {
					const row = db
						.prepare("SELECT * FROM review_discussions WHERE discussion_id = ?")
						.get(operation.discussionId);
					return row ? reviewDiscussionFromRow(db, row) : null;
				}
				if (operation.kind === "find_review_discussion") {
					const row = db
						.prepare("SELECT * FROM review_discussions WHERE run_id = ? AND finding_id = ?")
						.get(operation.runId, operation.findingId);
					return row ? reviewDiscussionFromRow(db, row) : null;
				}
				if (operation.kind === "find_review_discussion_by_child") {
					const row = db
						.prepare(
							"SELECT * FROM review_discussion_children WHERE child_session_id = ? AND child_session_generation = ?",
						)
						.get(operation.child.sessionId, operation.child.sessionGeneration);
					if (!row) return null;
					const discussion = requireReviewDiscussion(db, sqlString(row, "discussion_id"));
					return { discussion, child: reviewChildFromRow(db, row, discussion.source.cwd) };
				}
				if (operation.kind === "list_review_discussions") {
					return db
						.prepare("SELECT * FROM review_discussions WHERE run_id = ? ORDER BY discussion_id LIMIT ? OFFSET ?")
						.all(operation.runId, operation.limit, operation.offset)
						.map((row) => reviewDiscussionFromRow(db, row));
				}
				const discussion = requireReviewDiscussion(db, operation.discussionId);
				return db
					.prepare(
						"SELECT * FROM review_discussion_children WHERE discussion_id = ? ORDER BY ordinal LIMIT ? OFFSET ?",
					)
					.all(operation.discussionId, operation.limit, operation.offset)
					.map((row) => reviewChildFromRow(db, row, discussion.source.cwd));
			});
		}
		case "initialize":
			return openDatabase();
		case "verify_foreign_keys":
			return verifyForeignKeys();
		case "create_session":
			return createSession(operation.input);
		case "load_session":
			return loadSession(operation.sessionId, operation.sessionGeneration);
		case "find_continuation_session":
			return findContinuationSession(operation.cwd);
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
