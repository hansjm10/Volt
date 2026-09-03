import {
	decodeStoredSessionEntry,
	parsePersistedSessionEntry,
	validatePersistedSessionEntrySequence,
} from "../session-entry-codec.ts";
import { cloneCanonicalSessionStoreJson, isSessionStoreCommitDigest } from "./canonical-json.ts";
import {
	SESSION_STORE_SCHEMA_VERSION,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInput,
	type SessionStoreClientInputCommand,
	type SessionStoreClientInputState,
	type SessionStoreClientInputWrite,
	type SessionStoreCommitEvidence,
	type SessionStoreCommitReconciliation,
	type SessionStoreCreateSessionInput,
	type SessionStoreDeleteSessionInput,
	type SessionStoreDeleteSessionResult,
	type SessionStoreEntry,
	type SessionStoreEntryWrite,
	type SessionStoreErrorCode,
	type SessionStoreForeignKeyVerificationResult,
	type SessionStoreInfo,
	type SessionStoreJsonValue,
	type SessionStoreOrigin,
	type SessionStoreReconcileCommitInput,
	type SessionStoreSearchChunk,
	type SessionStoreSearchChunkWrite,
	type SessionStoreSearchResult,
	type SessionStoreSessionProjection,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreTransactionPayload,
	type SessionStoreTransactionResult,
} from "./types.ts";

export interface SessionStoreWorkerData {
	readonly sessionDirectory: string;
}

export type SessionStoreWorkerOperation =
	| { readonly kind: "initialize" }
	| { readonly kind: "verify_foreign_keys" }
	| { readonly kind: "create_session"; readonly input: SessionStoreCreateSessionInput }
	| { readonly kind: "load_session"; readonly sessionId: string; readonly sessionGeneration: string }
	| { readonly kind: "find_continuation_session"; readonly cwd: string | null }
	| {
			readonly kind: "list_sessions";
			readonly includeHidden: boolean;
			readonly cwd: string | null;
	  }
	| {
			readonly kind: "search_sessions";
			readonly query: string;
			readonly includeHidden: boolean;
			readonly cwd: string | null;
	  }
	| { readonly kind: "find_session"; readonly sessionId: string; readonly sessionGeneration: string }
	| { readonly kind: "find_session_by_id"; readonly sessionId: string }
	| { readonly kind: "apply_transaction"; readonly input: SessionStoreApplyTransactionInput }
	| { readonly kind: "reconcile_commit"; readonly input: SessionStoreReconcileCommitInput }
	| { readonly kind: "delete_session"; readonly input: SessionStoreDeleteSessionInput }
	| { readonly kind: "close" };

export interface SessionStoreWorkerRequestEnvelope {
	readonly requestId: number;
	readonly operationJson: string;
}

export interface SessionStoreWorkerErrorData {
	readonly code: SessionStoreErrorCode;
	readonly message: string;
}

export type SessionStoreWorkerResponseEnvelope =
	| { readonly requestId: number; readonly ok: true; readonly resultJson: string }
	| { readonly requestId: number; readonly ok: false; readonly error: SessionStoreWorkerErrorData };

const ERROR_CODES: ReadonlySet<string> = new Set<SessionStoreErrorCode>([
	"closed",
	"invalid_request",
	"invalid_response",
	"store_initialization_failed",
	"store_schema_mismatch",
	"store_busy",
	"store_io_error",
	"store_full",
	"session_already_exists",
	"session_not_found",
	"commit_identity_conflict",
	"commit_digest_mismatch",
	"constraint_failed",
	"worker_failed",
]);

function fail(path: string, reason: string): never {
	throw new TypeError(`Invalid session store protocol value at ${path}: ${reason}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail(path, "expected an ordinary object");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	path: string,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`${path}.${key}`, "unknown property");
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "missing property");
	}
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string") fail(path, "expected a string");
	return value;
}

function nonEmptyString(value: unknown, path: string): string {
	const result = stringValue(value, path);
	if (result.length === 0) fail(path, "must not be empty");
	if (result.includes("\0")) fail(path, "must not contain NUL");
	return result;
}

function idValue(value: unknown, path: string): string {
	const result = nonEmptyString(value, path);
	if (result.length > 512) fail(path, "must contain at most 512 characters");
	return result;
}

function nullableId(value: unknown, path: string): string | null {
	return value === null ? null : idValue(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected a boolean");
	return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		fail(path, `expected a safe integer greater than or equal to ${minimum}`);
	}
	return value;
}

function nullableSafeInteger(value: unknown, path: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "expected a safe integer or null");
	return value;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
	return value;
}

function timestampValue(value: unknown, path: string): string {
	const result = stringValue(value, path);
	const parsed = new Date(result);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
		fail(path, "expected a canonical ISO-8601 UTC timestamp");
	}
	return result;
}

function nullableString(value: unknown, path: string): string | null {
	return value === null ? null : stringValue(value, path);
}

function originValue(value: unknown, path: string): SessionStoreOrigin | null {
	if (value === null || value === "subagent") return value;
	return fail(path, "expected null or subagent");
}

function commandValue(value: unknown, path: string): SessionStoreClientInputCommand {
	if (value === "prompt" || value === "steer" || value === "follow_up") return value;
	return fail(path, "unsupported client input command");
}

function stateValue(value: unknown, path: string): SessionStoreClientInputState {
	if (value === "accepted" || value === "started" || value === "completed" || value === "failed") return value;
	return fail(path, "unsupported client input state");
}

function jsonValue(value: unknown, path: string): SessionStoreJsonValue {
	try {
		return cloneCanonicalSessionStoreJson(value, path);
	} catch (error) {
		throw new TypeError(`Invalid session store protocol value at ${path}: non-canonical JSON data`, { cause: error });
	}
}

function arrayValue<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path, "expected an array");
	return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function parseCreateSession(value: unknown, path: string): SessionStoreCreateSessionInput {
	const input = record(value, path);
	exactKeys(input, path, [
		"id",
		"sessionGeneration",
		"formatVersion",
		"cwd",
		"createdAt",
		"parentSessionDirectory",
		"parentStoreId",
		"parentSessionId",
		"parentSessionGeneration",
		"origin",
	]);
	const parentSessionDirectory =
		input.parentSessionDirectory === null
			? null
			: nonEmptyString(input.parentSessionDirectory, `${path}.parentSessionDirectory`);
	const parentStoreId = nullableId(input.parentStoreId, `${path}.parentStoreId`);
	const parentSessionId = nullableId(input.parentSessionId, `${path}.parentSessionId`);
	const parentSessionGeneration = nullableId(input.parentSessionGeneration, `${path}.parentSessionGeneration`);
	if (
		[parentSessionDirectory, parentStoreId, parentSessionId, parentSessionGeneration].some(
			(value) => value === null,
		) &&
		[parentSessionDirectory, parentStoreId, parentSessionId, parentSessionGeneration].some((value) => value !== null)
	) {
		fail(path, "parent reference fields must either all be null or all be present");
	}
	return {
		id: idValue(input.id, `${path}.id`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		formatVersion: safeInteger(input.formatVersion, `${path}.formatVersion`, 1),
		cwd: nonEmptyString(input.cwd, `${path}.cwd`),
		createdAt: timestampValue(input.createdAt, `${path}.createdAt`),
		parentSessionDirectory,
		parentStoreId,
		parentSessionId,
		parentSessionGeneration,
		origin: originValue(input.origin, `${path}.origin`),
	};
}

function parseSessionProjection(value: unknown, path: string): SessionStoreSessionProjection {
	const input = record(value, path);
	exactKeys(input, path, [
		"updatedAt",
		"startingGitContextRecorded",
		"startingGitContext",
		"name",
		"visible",
		"leafId",
		"messageCount",
		"firstMessage",
	]);
	const startingGitContextRecorded = booleanValue(
		input.startingGitContextRecorded,
		`${path}.startingGitContextRecorded`,
	);
	const startingGitContext =
		input.startingGitContext === null ? null : jsonValue(input.startingGitContext, `${path}.startingGitContext`);
	if (!startingGitContextRecorded && startingGitContext !== null) {
		fail(`${path}.startingGitContext`, "must be null until the starting Git context has been recorded");
	}
	return {
		updatedAt: timestampValue(input.updatedAt, `${path}.updatedAt`),
		startingGitContextRecorded,
		startingGitContext,
		name: nullableString(input.name, `${path}.name`),
		visible: booleanValue(input.visible, `${path}.visible`),
		leafId: nullableId(input.leafId, `${path}.leafId`),
		messageCount: safeInteger(input.messageCount, `${path}.messageCount`),
		firstMessage: stringValue(input.firstMessage, `${path}.firstMessage`),
	};
}

function parseEntryWrite(value: unknown, path: string): SessionStoreEntryWrite {
	const input = record(value, path);
	exactKeys(input, path, ["entry"]);
	const entry = parsePersistedSessionEntry(input.entry);
	return { entry: entry as unknown as SessionStoreJsonValue };
}

function parseEntry(value: unknown, path: string): SessionStoreEntry {
	const input = record(value, path);
	exactKeys(input, path, ["id", "parentId", "type", "timestamp", "ordinal", "isHostOnly", "payload"]);
	const stored: SessionStoreEntry = {
		id: idValue(input.id, `${path}.id`),
		parentId: nullableId(input.parentId, `${path}.parentId`),
		type: nonEmptyString(input.type, `${path}.type`),
		timestamp: timestampValue(input.timestamp, `${path}.timestamp`),
		ordinal: safeInteger(input.ordinal, `${path}.ordinal`, 1),
		isHostOnly: booleanValue(input.isHostOnly, `${path}.isHostOnly`),
		payload: jsonValue(input.payload, `${path}.payload`),
	};
	decodeStoredSessionEntry(stored);
	return stored;
}

function parseClientInput(value: unknown, path: string): SessionStoreClientInputWrite {
	const input = record(value, path);
	exactKeys(input, path, [
		"clientMessageId",
		"receiptEntryId",
		"command",
		"semanticDigest",
		"input",
		"queuedEntryId",
		"queuedInput",
		"state",
		"error",
		"canonicalEntryId",
	]);
	return {
		clientMessageId: idValue(input.clientMessageId, `${path}.clientMessageId`),
		receiptEntryId: idValue(input.receiptEntryId, `${path}.receiptEntryId`),
		command: commandValue(input.command, `${path}.command`),
		semanticDigest: nonEmptyString(input.semanticDigest, `${path}.semanticDigest`),
		input: jsonValue(input.input, `${path}.input`),
		queuedEntryId: nullableId(input.queuedEntryId, `${path}.queuedEntryId`),
		queuedInput: input.queuedInput === null ? null : jsonValue(input.queuedInput, `${path}.queuedInput`),
		state: stateValue(input.state, `${path}.state`),
		error: nullableString(input.error, `${path}.error`),
		canonicalEntryId: nullableId(input.canonicalEntryId, `${path}.canonicalEntryId`),
	};
}

function parseSearchChunk(value: unknown, path: string): SessionStoreSearchChunkWrite {
	const input = record(value, path);
	exactKeys(input, path, ["chunkIndex", "entryId", "text"]);
	return {
		chunkIndex: safeInteger(input.chunkIndex, `${path}.chunkIndex`),
		entryId: nullableId(input.entryId, `${path}.entryId`),
		text: stringValue(input.text, `${path}.text`),
	};
}

function parseTransactionPayload(value: unknown, path: string): SessionStoreTransactionPayload {
	const input = record(value, path);
	exactKeys(input, path, ["session", "entries", "clientInputs", "searchChunks"]);
	return {
		session: parseSessionProjection(input.session, `${path}.session`),
		entries: arrayValue(input.entries, `${path}.entries`, parseEntryWrite),
		clientInputs: arrayValue(input.clientInputs, `${path}.clientInputs`, parseClientInput),
		searchChunks: arrayValue(input.searchChunks, `${path}.searchChunks`, parseSearchChunk),
	};
}

function parseApplyTransaction(value: unknown, path: string): SessionStoreApplyTransactionInput {
	const input = record(value, path);
	exactKeys(input, path, ["sessionId", "sessionGeneration", "expectedRevision", "commitId", "digest", "payload"]);
	if (!isSessionStoreCommitDigest(input.digest)) fail(`${path}.digest`, "expected a sha256 commit digest");
	return {
		sessionId: idValue(input.sessionId, `${path}.sessionId`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		expectedRevision: safeInteger(input.expectedRevision, `${path}.expectedRevision`),
		commitId: idValue(input.commitId, `${path}.commitId`),
		digest: input.digest,
		payload: parseTransactionPayload(input.payload, `${path}.payload`),
	};
}

function parseReconcileInput(value: unknown, path: string): SessionStoreReconcileCommitInput {
	const input = record(value, path);
	exactKeys(input, path, ["sessionId", "sessionGeneration", "commitId", "digest"]);
	if (!isSessionStoreCommitDigest(input.digest)) fail(`${path}.digest`, "expected a sha256 commit digest");
	return {
		sessionId: idValue(input.sessionId, `${path}.sessionId`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		commitId: idValue(input.commitId, `${path}.commitId`),
		digest: input.digest,
	};
}

function parseDeleteInput(value: unknown, path: string): SessionStoreDeleteSessionInput {
	const input = record(value, path);
	exactKeys(input, path, ["sessionId", "sessionGeneration", "expectedRevision"]);
	return {
		sessionId: idValue(input.sessionId, `${path}.sessionId`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		expectedRevision: safeInteger(input.expectedRevision, `${path}.expectedRevision`),
	};
}

export function parseSessionStoreWorkerData(value: unknown): SessionStoreWorkerData {
	const input = record(value, "$workerData");
	exactKeys(input, "$workerData", ["sessionDirectory"]);
	return { sessionDirectory: nonEmptyString(input.sessionDirectory, "$workerData.sessionDirectory") };
}

export function parseSessionStoreWorkerOperation(value: unknown): SessionStoreWorkerOperation {
	const input = record(value, "$operation");
	const kind = stringValue(input.kind, "$operation.kind");
	switch (kind) {
		case "initialize":
		case "verify_foreign_keys":
		case "close":
			exactKeys(input, "$operation", ["kind"]);
			return { kind };
		case "create_session":
			exactKeys(input, "$operation", ["kind", "input"]);
			return { kind, input: parseCreateSession(input.input, "$operation.input") };
		case "load_session":
		case "find_session":
			exactKeys(input, "$operation", ["kind", "sessionId", "sessionGeneration"]);
			return {
				kind,
				sessionId: idValue(input.sessionId, "$operation.sessionId"),
				sessionGeneration: idValue(input.sessionGeneration, "$operation.sessionGeneration"),
			};
		case "find_session_by_id":
			exactKeys(input, "$operation", ["kind", "sessionId"]);
			return { kind, sessionId: idValue(input.sessionId, "$operation.sessionId") };
		case "delete_session":
			exactKeys(input, "$operation", ["kind", "input"]);
			return { kind, input: parseDeleteInput(input.input, "$operation.input") };
		case "find_continuation_session":
			exactKeys(input, "$operation", ["kind", "cwd"]);
			return { kind, cwd: nullableString(input.cwd, "$operation.cwd") };
		case "list_sessions":
			exactKeys(input, "$operation", ["kind", "includeHidden", "cwd"]);
			return {
				kind,
				includeHidden: booleanValue(input.includeHidden, "$operation.includeHidden"),
				cwd: nullableString(input.cwd, "$operation.cwd"),
			};
		case "search_sessions":
			exactKeys(input, "$operation", ["kind", "query", "includeHidden", "cwd"]);
			return {
				kind,
				query: stringValue(input.query, "$operation.query"),
				includeHidden: booleanValue(input.includeHidden, "$operation.includeHidden"),
				cwd: nullableString(input.cwd, "$operation.cwd"),
			};
		case "apply_transaction":
			exactKeys(input, "$operation", ["kind", "input"]);
			return { kind, input: parseApplyTransaction(input.input, "$operation.input") };
		case "reconcile_commit":
			exactKeys(input, "$operation", ["kind", "input"]);
			return { kind, input: parseReconcileInput(input.input, "$operation.input") };
		default:
			return fail("$operation.kind", `unsupported operation ${JSON.stringify(kind)}`);
	}
}

export function parseSessionStoreWorkerRequestEnvelope(value: unknown): SessionStoreWorkerRequestEnvelope {
	const input = record(value, "$request");
	exactKeys(input, "$request", ["requestId", "operationJson"]);
	return {
		requestId: safeInteger(input.requestId, "$request.requestId", 1),
		operationJson: stringValue(input.operationJson, "$request.operationJson"),
	};
}

export function parseSessionStoreWorkerResponseEnvelope(value: unknown): SessionStoreWorkerResponseEnvelope {
	const input = record(value, "$response");
	const requestId = safeInteger(input.requestId, "$response.requestId", 1);
	const ok = booleanValue(input.ok, "$response.ok");
	if (ok) {
		exactKeys(input, "$response", ["requestId", "ok", "resultJson"]);
		return { requestId, ok: true, resultJson: stringValue(input.resultJson, "$response.resultJson") };
	}
	exactKeys(input, "$response", ["requestId", "ok", "error"]);
	const error = record(input.error, "$response.error");
	exactKeys(error, "$response.error", ["code", "message"]);
	const code = stringValue(error.code, "$response.error.code");
	if (!ERROR_CODES.has(code)) fail("$response.error.code", "unsupported error code");
	return {
		requestId,
		ok: false,
		error: { code: code as SessionStoreErrorCode, message: stringValue(error.message, "$response.error.message") },
	};
}

function parseSummary(value: unknown, path: string): SessionStoreSessionSummary {
	const input = record(value, path);
	exactKeys(input, path, [
		"id",
		"sessionGeneration",
		"formatVersion",
		"cwd",
		"createdAt",
		"updatedAt",
		"parentSessionDirectory",
		"parentStoreId",
		"parentSessionId",
		"parentSessionGeneration",
		"origin",
		"startingGitContextRecorded",
		"startingGitContext",
		"name",
		"visible",
		"revision",
		"leafId",
		"messageCount",
		"firstMessage",
	]);
	const startingGitContextRecorded = booleanValue(
		input.startingGitContextRecorded,
		`${path}.startingGitContextRecorded`,
	);
	const startingGitContext =
		input.startingGitContext === null ? null : jsonValue(input.startingGitContext, `${path}.startingGitContext`);
	if (!startingGitContextRecorded && startingGitContext !== null) {
		fail(`${path}.startingGitContext`, "must be null until the starting Git context has been recorded");
	}
	const parentSessionDirectory =
		input.parentSessionDirectory === null
			? null
			: nonEmptyString(input.parentSessionDirectory, `${path}.parentSessionDirectory`);
	const parentStoreId = nullableId(input.parentStoreId, `${path}.parentStoreId`);
	const parentSessionId = nullableId(input.parentSessionId, `${path}.parentSessionId`);
	const parentSessionGeneration = nullableId(input.parentSessionGeneration, `${path}.parentSessionGeneration`);
	if (
		[parentSessionDirectory, parentStoreId, parentSessionId, parentSessionGeneration].some(
			(value) => value === null,
		) &&
		[parentSessionDirectory, parentStoreId, parentSessionId, parentSessionGeneration].some((value) => value !== null)
	) {
		fail(path, "parent reference fields must either all be null or all be present");
	}
	return {
		id: idValue(input.id, `${path}.id`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		formatVersion: safeInteger(input.formatVersion, `${path}.formatVersion`, 1),
		cwd: nonEmptyString(input.cwd, `${path}.cwd`),
		createdAt: timestampValue(input.createdAt, `${path}.createdAt`),
		updatedAt: timestampValue(input.updatedAt, `${path}.updatedAt`),
		parentSessionDirectory,
		parentStoreId,
		parentSessionId,
		parentSessionGeneration,
		origin: originValue(input.origin, `${path}.origin`),
		startingGitContextRecorded,
		startingGitContext,
		name: nullableString(input.name, `${path}.name`),
		visible: booleanValue(input.visible, `${path}.visible`),
		revision: safeInteger(input.revision, `${path}.revision`),
		leafId: nullableId(input.leafId, `${path}.leafId`),
		messageCount: safeInteger(input.messageCount, `${path}.messageCount`),
		firstMessage: stringValue(input.firstMessage, `${path}.firstMessage`),
	};
}

function parseSearchResult(value: unknown, path: string): SessionStoreSearchResult {
	const input = record(value, path);
	exactKeys(input, path, ["summary", "score"]);
	return {
		summary: parseSummary(input.summary, `${path}.summary`),
		score: finiteNumber(input.score, `${path}.score`),
	};
}

function parseEvidence(value: unknown, path: string): SessionStoreCommitEvidence {
	const input = record(value, path);
	exactKeys(input, path, [
		"sessionId",
		"sessionGeneration",
		"commitId",
		"digest",
		"beforeRevision",
		"afterRevision",
		"committedAt",
	]);
	if (!isSessionStoreCommitDigest(input.digest)) fail(`${path}.digest`, "expected a sha256 commit digest");
	return {
		sessionId: idValue(input.sessionId, `${path}.sessionId`),
		sessionGeneration: idValue(input.sessionGeneration, `${path}.sessionGeneration`),
		commitId: idValue(input.commitId, `${path}.commitId`),
		digest: input.digest,
		beforeRevision: safeInteger(input.beforeRevision, `${path}.beforeRevision`),
		afterRevision: safeInteger(input.afterRevision, `${path}.afterRevision`, 1),
		committedAt: timestampValue(input.committedAt, `${path}.committedAt`),
	};
}

function parseTransactionResult(value: unknown, path: string): SessionStoreTransactionResult {
	const input = record(value, path);
	const status = stringValue(input.status, `${path}.status`);
	if (status === "committed") {
		exactKeys(input, path, ["status", "evidence"]);
		return { status, evidence: parseEvidence(input.evidence, `${path}.evidence`) };
	}
	if (status === "conflict") {
		exactKeys(input, path, ["status", "actualRevision"]);
		return { status, actualRevision: safeInteger(input.actualRevision, `${path}.actualRevision`) };
	}
	return fail(`${path}.status`, "unsupported transaction status");
}

function parseDeleteResult(value: unknown, path: string): SessionStoreDeleteSessionResult {
	const input = record(value, path);
	const status = stringValue(input.status, `${path}.status`);
	if (status === "deleted" || status === "not_found") {
		exactKeys(input, path, ["status"]);
		return { status };
	}
	if (status === "conflict") {
		exactKeys(input, path, ["status", "actualRevision"]);
		return { status, actualRevision: safeInteger(input.actualRevision, `${path}.actualRevision`) };
	}
	return fail(`${path}.status`, "unsupported delete status");
}

function parseReconciliation(value: unknown, path: string): SessionStoreCommitReconciliation {
	const input = record(value, path);
	const status = stringValue(input.status, `${path}.status`);
	if (status === "committed") {
		exactKeys(input, path, ["status", "evidence"]);
		return { status, evidence: parseEvidence(input.evidence, `${path}.evidence`) };
	}
	if (status === "not_found" || status === "mismatch") {
		exactKeys(input, path, ["status"]);
		return { status };
	}
	return fail(`${path}.status`, "unsupported reconciliation status");
}

function parseForeignKeyVerificationResult(value: unknown, path: string): SessionStoreForeignKeyVerificationResult {
	const input = record(value, path);
	const status = stringValue(input.status, `${path}.status`);
	if (status === "valid") {
		exactKeys(input, path, ["status"]);
		return { status };
	}
	if (status === "violation") {
		exactKeys(input, path, ["status", "table", "rowId", "parentTable", "constraintIndex"]);
		return {
			status,
			table: nonEmptyString(input.table, `${path}.table`),
			rowId: nullableSafeInteger(input.rowId, `${path}.rowId`),
			parentTable: nonEmptyString(input.parentTable, `${path}.parentTable`),
			constraintIndex: safeInteger(input.constraintIndex, `${path}.constraintIndex`),
		};
	}
	return fail(`${path}.status`, "unsupported foreign-key verification status");
}

function parseInfo(value: unknown, path: string): SessionStoreInfo {
	const input = record(value, path);
	exactKeys(input, path, [
		"storeId",
		"databasePath",
		"schemaVersion",
		"journalMode",
		"foreignKeys",
		"trustedSchema",
		"busyTimeoutMs",
	]);
	if (input.schemaVersion !== SESSION_STORE_SCHEMA_VERSION)
		fail(`${path}.schemaVersion`, "unsupported schema version");
	if (input.journalMode !== "wal") fail(`${path}.journalMode`, "expected wal");
	if (input.foreignKeys !== true) fail(`${path}.foreignKeys`, "expected true");
	if (input.trustedSchema !== false) fail(`${path}.trustedSchema`, "expected false");
	return {
		storeId: idValue(input.storeId, `${path}.storeId`),
		databasePath: nonEmptyString(input.databasePath, `${path}.databasePath`),
		schemaVersion: SESSION_STORE_SCHEMA_VERSION,
		journalMode: "wal",
		foreignKeys: true,
		trustedSchema: false,
		busyTimeoutMs: safeInteger(input.busyTimeoutMs, `${path}.busyTimeoutMs`, 1),
	};
}

function parseSnapshot(value: unknown, path: string): SessionStoreSnapshot {
	const input = record(value, path);
	exactKeys(input, path, ["session", "entries", "clientInputs", "searchChunks"]);
	const entries = arrayValue(input.entries, `${path}.entries`, parseEntry);
	validatePersistedSessionEntrySequence(entries.map((entry) => entry.payload));
	return {
		session: parseSummary(input.session, `${path}.session`),
		entries,
		clientInputs: arrayValue(
			input.clientInputs,
			`${path}.clientInputs`,
			parseClientInput,
		) as SessionStoreClientInput[],
		searchChunks: arrayValue(
			input.searchChunks,
			`${path}.searchChunks`,
			parseSearchChunk,
		) as SessionStoreSearchChunk[],
	};
}

export function parseSessionStoreOperationResult(
	kind: SessionStoreWorkerOperation["kind"],
	value: unknown,
):
	| SessionStoreInfo
	| SessionStoreForeignKeyVerificationResult
	| SessionStoreSessionSummary
	| SessionStoreSessionSummary[]
	| SessionStoreSearchResult[]
	| SessionStoreSnapshot
	| SessionStoreTransactionResult
	| SessionStoreCommitReconciliation
	| SessionStoreDeleteSessionResult
	| null {
	switch (kind) {
		case "initialize":
			return parseInfo(value, "$result");
		case "verify_foreign_keys":
			return parseForeignKeyVerificationResult(value, "$result");
		case "create_session":
			return parseSummary(value, "$result");
		case "load_session":
			return value === null ? null : parseSnapshot(value, "$result");
		case "list_sessions":
			return arrayValue(value, "$result", parseSummary);
		case "search_sessions":
			return arrayValue(value, "$result", parseSearchResult);
		case "find_continuation_session":
		case "find_session":
		case "find_session_by_id":
			return value === null ? null : parseSummary(value, "$result");
		case "apply_transaction":
			return parseTransactionResult(value, "$result");
		case "reconcile_commit":
			return parseReconciliation(value, "$result");
		case "delete_session":
			return parseDeleteResult(value, "$result");
		case "close":
			if (value !== null) fail("$result", "expected null");
			return null;
	}
}

export function toClientInput(value: SessionStoreClientInputWrite): SessionStoreClientInput {
	return value;
}

export function toSearchChunk(value: SessionStoreSearchChunkWrite): SessionStoreSearchChunk {
	return value;
}
