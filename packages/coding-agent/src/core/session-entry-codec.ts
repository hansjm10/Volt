import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@hansjm10/volt-ai";
import { Check } from "typebox/value";
import { cloneCanonicalData } from "./canonical-data.ts";
import { parsePlanningState } from "./planning.ts";
import { RpcAssistantMessageSchema } from "./rpc/schema/external.ts";
import { RpcGitContextSchema } from "./rpc/schema/git-context.ts";
import { RpcThinkingLevelSchema } from "./rpc/schema/primitives.ts";
import {
	RPC_CLIENT_MESSAGE_ID_MAX_CHARS,
	RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE,
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX,
} from "./rpc/wire-limits.ts";
import type {
	ClientInputCommand,
	ClientInputPayload,
	ClientInputQueuedPayload,
	SessionEntry,
	SessionReference,
	SessionSnapshotHeader,
} from "./session-manager.ts";

export const SESSION_ID_MAX_CHARACTERS = 512;
const ENTRY_ID_MAX_CHARACTERS = SESSION_ID_MAX_CHARACTERS;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CLIENT_INPUT_ID_PATTERN = new RegExp(`^${RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE}$`);
export const CLIENT_INPUT_ERROR_MAX_SCALARS = 2_000;

interface StoredSessionEntryEnvelope {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly timestamp: string;
	readonly ordinal: number;
	readonly isHostOnly: boolean;
	readonly payload: unknown;
}

export interface SessionEntryEnvelope {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: SessionEntry["type"];
	readonly timestamp: string;
	readonly ordinal: number;
	readonly isHostOnly: boolean;
}

function fail(path: string, reason: string): never {
	throw new TypeError(`Invalid session entry at ${path}: ${reason}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(path, "expected an object");
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
	if (result.length > ENTRY_ID_MAX_CHARACTERS) {
		fail(path, `must contain at most ${ENTRY_ID_MAX_CHARACTERS} characters`);
	}
	return result;
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected a boolean");
	return value;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
	return value;
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
	const result = finiteNumber(value, path);
	if (result < 0) fail(path, "must not be negative");
	return result;
}

function positiveSafeInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		fail(path, "expected a positive safe integer");
	}
	return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
	const result = stringValue(value, path);
	const parsed = new Date(result);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
		fail(path, "expected a canonical ISO-8601 UTC timestamp");
	}
	return result;
}

function messageTimestamp(value: unknown, path: string): number {
	const result = finiteNumber(value, path);
	if (!Number.isFinite(new Date(result).getTime())) {
		throw new Error("Session message timestamp must be representable as a Date");
	}
	return result;
}

function validateTextContent(value: unknown, path: string): asserts value is TextContent {
	const content = record(value, path);
	exactKeys(content, path, ["type", "text"], ["textSignature"]);
	if (content.type !== "text") fail(`${path}.type`, "expected text");
	stringValue(content.text, `${path}.text`);
	if (content.textSignature !== undefined) stringValue(content.textSignature, `${path}.textSignature`);
}

function validateImageContent(value: unknown, path: string): asserts value is ImageContent {
	const content = record(value, path);
	exactKeys(content, path, ["type", "data", "mimeType"]);
	if (content.type !== "image") fail(`${path}.type`, "expected image");
	stringValue(content.data, `${path}.data`);
	nonEmptyString(content.mimeType, `${path}.mimeType`);
}

function validateUserContent(value: unknown, path: string): void {
	if (typeof value === "string") return;
	if (!Array.isArray(value)) fail(path, "expected a string or content array");
	for (const [index, content] of value.entries()) {
		const item = record(content, `${path}[${index}]`);
		if (item.type === "text") validateTextContent(item, `${path}[${index}]`);
		else if (item.type === "image") validateImageContent(item, `${path}[${index}]`);
		else fail(`${path}[${index}].type`, "unsupported user content type");
	}
}

function validateAgentMessage(value: unknown, path: string): asserts value is AgentMessage {
	const message = record(value, path);
	const role = stringValue(message.role, `${path}.role`);
	if (role === "user") {
		exactKeys(message, path, ["role", "content", "timestamp"], ["clientMessageId"]);
		validateUserContent(message.content, `${path}.content`);
		messageTimestamp(message.timestamp, `${path}.timestamp`);
		if (message.clientMessageId !== undefined && !isValidClientMessageId(message.clientMessageId)) {
			fail(`${path}.clientMessageId`, "invalid client input identity");
		}
		return;
	}
	if (role === "assistant") {
		if (!Check(RpcAssistantMessageSchema, message)) fail(path, "invalid assistant message");
		const assistant = message as unknown as AssistantMessage;
		nonEmptyString(assistant.api, `${path}.api`);
		nonEmptyString(assistant.provider, `${path}.provider`);
		nonEmptyString(assistant.model, `${path}.model`);
		for (const [index, content] of assistant.content.entries()) {
			if (content.type !== "toolCall") continue;
			idValue(content.id, `${path}.content[${index}].id`);
			nonEmptyString(content.name, `${path}.content[${index}].name`);
		}
		messageTimestamp(assistant.timestamp, `${path}.timestamp`);
		return;
	}
	if (role === "toolResult") {
		exactKeys(message, path, ["role", "toolCallId", "toolName", "content", "isError", "timestamp"], ["details"]);
		idValue(message.toolCallId, `${path}.toolCallId`);
		nonEmptyString(message.toolName, `${path}.toolName`);
		if (!Array.isArray(message.content)) fail(`${path}.content`, "expected a content array");
		for (const [index, content] of message.content.entries()) {
			const item = record(content, `${path}.content[${index}]`);
			if (item.type === "text") validateTextContent(item, `${path}.content[${index}]`);
			else if (item.type === "image") validateImageContent(item, `${path}.content[${index}]`);
			else fail(`${path}.content[${index}].type`, "unsupported tool result content type");
		}
		booleanValue(message.isError, `${path}.isError`);
		messageTimestamp(message.timestamp, `${path}.timestamp`);
		return;
	}
	if (role === "bashExecution") {
		exactKeys(
			message,
			path,
			["role", "command", "output", "cancelled", "truncated", "timestamp"],
			["exitCode", "fullOutputPath", "excludeFromContext"],
		);
		stringValue(message.command, `${path}.command`);
		stringValue(message.output, `${path}.output`);
		if (message.exitCode !== undefined) finiteNumber(message.exitCode, `${path}.exitCode`);
		booleanValue(message.cancelled, `${path}.cancelled`);
		booleanValue(message.truncated, `${path}.truncated`);
		if (message.fullOutputPath !== undefined) stringValue(message.fullOutputPath, `${path}.fullOutputPath`);
		if (message.excludeFromContext !== undefined) {
			booleanValue(message.excludeFromContext, `${path}.excludeFromContext`);
		}
		messageTimestamp(message.timestamp, `${path}.timestamp`);
		return;
	}
	if (role === "custom") {
		exactKeys(message, path, ["role", "customType", "content", "display", "timestamp"], ["details"]);
		nonEmptyString(message.customType, `${path}.customType`);
		validateUserContent(message.content, `${path}.content`);
		booleanValue(message.display, `${path}.display`);
		messageTimestamp(message.timestamp, `${path}.timestamp`);
		return;
	}
	fail(`${path}.role`, `unsupported canonical message role ${JSON.stringify(role)}`);
}

function validateSessionReference(value: unknown, path: string): asserts value is SessionReference {
	const reference = record(value, path);
	exactKeys(reference, path, ["sessionDirectory", "storeId", "sessionId", "sessionGeneration"]);
	nonEmptyString(reference.sessionDirectory, `${path}.sessionDirectory`);
	idValue(reference.storeId, `${path}.storeId`);
	assertValidSessionIdValue(reference.sessionId, `${path}.sessionId`);
	idValue(reference.sessionGeneration, `${path}.sessionGeneration`);
}

function baseKeys(mode: "admission" | "persisted"): string[] {
	return mode === "persisted"
		? ["type", "id", "parentId", "timestamp", "ordinal"]
		: ["type", "id", "parentId", "timestamp"];
}

function validateEntryBase(entry: Record<string, unknown>, mode: "admission" | "persisted"): void {
	idValue(entry.id, "$.id");
	if (entry.parentId !== null) idValue(entry.parentId, "$.parentId");
	canonicalTimestamp(entry.timestamp, "$.timestamp");
	if (mode === "persisted") positiveSafeInteger(entry.ordinal, "$.ordinal");
}

function parseSessionEntry(
	value: unknown,
	mode: "admission" | "persisted",
	description = "Session entry",
): SessionEntry {
	const canonical = cloneCanonicalData(value, description);
	const entry = record(canonical, "$");
	const type = nonEmptyString(entry.type, "$.type");
	const base = baseKeys(mode);
	const optionalOrdinal = mode === "admission" ? ["ordinal"] : [];
	if (mode === "admission" && Object.hasOwn(entry, "ordinal")) {
		fail("$.ordinal", "must be assigned by SessionManager");
	}

	switch (type) {
		case "message":
			exactKeys(entry, "$", [...base, "message"], optionalOrdinal);
			validateAgentMessage(entry.message, "$.message");
			break;
		case "client_input_receipt": {
			exactKeys(entry, "$", [...base, "clientMessageId", "command", "semanticDigest", "input"], optionalOrdinal);
			assertClientMessageIdValue(entry.clientMessageId, "$.clientMessageId");
			const command = parseClientInputCommand(entry.command, "$.command");
			const input = normalizeClientInputPayload(command, entry.input);
			if (!isDeepStrictEqual(input, entry.input)) fail("$.input", "is not in canonical client input form");
			if (entry.semanticDigest !== digestClientInputPayload(command, input)) {
				fail("$.semanticDigest", "does not match the canonical client input");
			}
			break;
		}
		case "client_input_queued":
			exactKeys(entry, "$", [...base, "receiptId", "clientMessageId", "queuedInput"], optionalOrdinal);
			idValue(entry.receiptId, "$.receiptId");
			assertClientMessageIdValue(entry.clientMessageId, "$.clientMessageId");
			if (!isDeepStrictEqual(normalizeClientInputQueuedPayload(entry.queuedInput), entry.queuedInput)) {
				fail("$.queuedInput", "is not in canonical queued input form");
			}
			break;
		case "client_input_state":
			exactKeys(entry, "$", [...base, "receiptId", "clientMessageId", "state"], [...optionalOrdinal, "error"]);
			idValue(entry.receiptId, "$.receiptId");
			assertClientMessageIdValue(entry.clientMessageId, "$.clientMessageId");
			if (
				entry.state !== "accepted" &&
				entry.state !== "started" &&
				entry.state !== "completed" &&
				entry.state !== "failed"
			) {
				fail("$.state", "invalid client input state");
			}
			if (entry.error !== undefined) {
				const error = stringValue(entry.error, "$.error");
				if (entry.state !== "failed" || Array.from(error).length > CLIENT_INPUT_ERROR_MAX_SCALARS) {
					fail("$.error", "invalid client input error");
				}
			}
			break;
		case "thinking_level_change":
			exactKeys(entry, "$", [...base, "thinkingLevel"], optionalOrdinal);
			if (!Check(RpcThinkingLevelSchema, entry.thinkingLevel)) {
				throw new Error(`Thinking level entry ${String(entry.id)} has an invalid thinking level`);
			}
			break;
		case "fast_mode_change":
			exactKeys(entry, "$", [...base, "enabled"], optionalOrdinal);
			if (typeof entry.enabled !== "boolean") {
				throw new Error(`Fast mode entry ${String(entry.id)} has an invalid enabled state`);
			}
			break;
		case "model_change":
			exactKeys(entry, "$", [...base, "provider", "modelId"], optionalOrdinal);
			nonEmptyString(entry.provider, "$.provider");
			nonEmptyString(entry.modelId, "$.modelId");
			break;
		case "planning_state_change": {
			exactKeys(entry, "$", [...base, "planning"], optionalOrdinal);
			const planning = parsePlanningState(entry.planning);
			if (!isDeepStrictEqual(planning, entry.planning)) fail("$.planning", "is not in canonical planning form");
			break;
		}
		case "compaction":
			exactKeys(
				entry,
				"$",
				[...base, "summary", "firstKeptEntryId", "tokensBefore"],
				[...optionalOrdinal, "details", "fromHook"],
			);
			stringValue(entry.summary, "$.summary");
			idValue(entry.firstKeptEntryId, "$.firstKeptEntryId");
			nonNegativeFiniteNumber(entry.tokensBefore, "$.tokensBefore");
			if (entry.fromHook !== undefined) booleanValue(entry.fromHook, "$.fromHook");
			break;
		case "branch_summary":
			exactKeys(entry, "$", [...base, "fromId", "summary"], [...optionalOrdinal, "details", "fromHook"]);
			idValue(entry.fromId, "$.fromId");
			stringValue(entry.summary, "$.summary");
			if (entry.fromHook !== undefined) booleanValue(entry.fromHook, "$.fromHook");
			break;
		case "custom":
			exactKeys(entry, "$", [...base, "customType"], [...optionalOrdinal, "data"]);
			nonEmptyString(entry.customType, "$.customType");
			break;
		case "custom_message":
			exactKeys(entry, "$", [...base, "customType", "content", "display"], [...optionalOrdinal, "details"]);
			nonEmptyString(entry.customType, "$.customType");
			validateUserContent(entry.content, "$.content");
			booleanValue(entry.display, "$.display");
			break;
		case "label":
			exactKeys(entry, "$", [...base, "targetId"], [...optionalOrdinal, "label"]);
			idValue(entry.targetId, "$.targetId");
			if (entry.label !== undefined) stringValue(entry.label, "$.label");
			break;
		case "session_info":
			exactKeys(entry, "$", base, [...optionalOrdinal, "name"]);
			if (entry.name !== undefined) stringValue(entry.name, "$.name");
			break;
		case "session_start_git_context":
			exactKeys(entry, "$", [...base, "gitContext"], optionalOrdinal);
			if (entry.gitContext !== null && !Check(RpcGitContextSchema, entry.gitContext)) {
				fail("$.gitContext", "invalid starting Git context");
			}
			break;
		case "leaf":
			exactKeys(entry, "$", [...base, "targetId"], optionalOrdinal);
			if (entry.targetId !== null) idValue(entry.targetId, "$.targetId");
			break;
		case "subagent_spawn":
			exactKeys(
				entry,
				"$",
				[...base, "toolCallId", "subagentId", "agent", "childSessionId", "requestKey"],
				[...optionalOrdinal, "childSessionRef"],
			);
			idValue(entry.toolCallId, "$.toolCallId");
			idValue(entry.subagentId, "$.subagentId");
			nonEmptyString(entry.agent, "$.agent");
			assertValidSessionIdValue(entry.childSessionId, "$.childSessionId");
			idValue(entry.requestKey, "$.requestKey");
			if (entry.childSessionRef !== undefined) {
				validateSessionReference(entry.childSessionRef, "$.childSessionRef");
				if ((entry.childSessionRef as SessionReference).sessionId !== entry.childSessionId) {
					fail("$.childSessionRef.sessionId", "must match childSessionId");
				}
			}
			break;
		default:
			fail("$.type", `unsupported entry type ${JSON.stringify(type)}`);
	}
	validateEntryBase(entry, mode);
	return canonical as unknown as SessionEntry;
}

export function parseSessionEntryForAdmission(value: unknown, description?: string): SessionEntry {
	return parseSessionEntry(value, "admission", description);
}

export function parsePersistedSessionEntry(value: unknown): SessionEntry & { ordinal: number } {
	return parseSessionEntry(value, "persisted") as SessionEntry & { ordinal: number };
}

export function isHostOnlySessionEntryType(type: string): boolean {
	return (
		type === "client_input_receipt" ||
		type === "client_input_queued" ||
		type === "client_input_state" ||
		type === "session_start_git_context" ||
		type === "subagent_spawn" ||
		type === "leaf"
	);
}

export function sessionEntryEnvelope(entry: SessionEntry & { ordinal: number }): SessionEntryEnvelope {
	return {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		ordinal: entry.ordinal,
		isHostOnly: isHostOnlySessionEntryType(entry.type),
	};
}

export function decodeStoredSessionEntry(stored: StoredSessionEntryEnvelope): SessionEntry & { ordinal: number } {
	const entry = parsePersistedSessionEntry(stored.payload);
	const expected = sessionEntryEnvelope(entry);
	if (
		stored.id !== expected.id ||
		stored.parentId !== expected.parentId ||
		stored.type !== expected.type ||
		stored.timestamp !== expected.timestamp ||
		stored.ordinal !== expected.ordinal ||
		stored.isHostOnly !== expected.isHostOnly
	) {
		throw new Error(`Stored session entry ${JSON.stringify(stored.id)} does not match its canonical payload`);
	}
	return entry;
}

function validateEntryReferences(
	entry: SessionEntry & { ordinal: number },
	byId: ReadonlyMap<string, SessionEntry>,
): void {
	if (byId.has(entry.id)) throw new Error(`Session entry ${entry.id} has a duplicate identity`);
	if (entry.parentId !== null && !byId.has(entry.parentId)) {
		throw new Error(`Session entry ${entry.id} has an invalid or forward parent`);
	}
	if (entry.type === "compaction") {
		let currentId = entry.parentId;
		while (currentId !== null && currentId !== entry.firstKeptEntryId) {
			currentId = byId.get(currentId)?.parentId ?? null;
		}
		if (currentId !== entry.firstKeptEntryId) {
			throw new Error(`Compaction entry ${entry.id} has an invalid first-kept boundary`);
		}
	}
	if (entry.type === "leaf" || entry.type === "label") {
		const targetId = entry.targetId;
		if (targetId !== null) {
			const target = byId.get(targetId);
			if (!target || isHostOnlySessionEntryType(target.type)) {
				throw new Error(
					`${entry.type === "leaf" ? "Leaf" : "Label"} entry ${entry.id} targets an invalid conversation entry`,
				);
			}
		}
	}
	if (entry.type === "branch_summary" && entry.fromId !== (entry.parentId ?? "root")) {
		throw new Error(`Branch summary entry ${entry.id} has an invalid source`);
	}
}

export interface ClientInputSequenceRecord {
	readonly receiptId: string;
	readonly clientMessageId: string;
	readonly command: ClientInputCommand;
	readonly semanticDigest: string;
	readonly input: ClientInputPayload;
	queuedEntryId?: string;
	queuedInput?: ClientInputQueuedPayload;
	state: "accepted" | "started" | "completed" | "failed";
	error?: string;
	canonicalEntryId?: string;
}

export interface ClientInputSequenceSeed {
	readonly receiptId: string;
	readonly clientMessageId: string;
	readonly command: ClientInputCommand;
	readonly semanticDigest: string;
	readonly input: unknown;
	readonly queuedEntryId?: string;
	readonly queuedInput?: unknown;
	readonly state: "accepted" | "started" | "completed" | "failed";
	readonly error?: string;
	readonly canonicalEntryId?: string;
}

export interface ClientInputSequenceValidator {
	apply(entry: SessionEntry): void;
	get(clientMessageId: string): ClientInputSequenceRecord | undefined;
}

function expectedQueuedDelivery(record: ClientInputSequenceRecord): "steer" | "follow_up" | undefined {
	if (record.command === "steer") return "steer";
	if (record.command === "follow_up") return "follow_up";
	if (record.input.streamingBehavior === "steer") return "steer";
	if (record.input.streamingBehavior === "followUp") return "follow_up";
	return undefined;
}

function validateClientInputSequenceEntry(entry: SessionEntry, records: Map<string, ClientInputSequenceRecord>): void {
	if (entry.type === "client_input_receipt") {
		const input = normalizeClientInputPayload(entry.command, entry.input);
		const existing = records.get(entry.clientMessageId);
		if (existing) {
			throw new Error(`Client input id ${JSON.stringify(entry.clientMessageId)} has duplicate durable receipts`);
		}
		records.set(entry.clientMessageId, {
			receiptId: entry.id,
			clientMessageId: entry.clientMessageId,
			command: entry.command,
			semanticDigest: entry.semanticDigest,
			input,
			state: "accepted",
		});
		return;
	}
	if (entry.type === "client_input_queued") {
		const record = records.get(entry.clientMessageId);
		if (!record || record.receiptId !== entry.receiptId) {
			throw new Error(`Queued client input ${entry.id} has no matching receipt`);
		}
		if (record.state !== "accepted" && record.state !== "started") {
			throw new Error(`Queued client input ${entry.id} was persisted after dispatch started`);
		}
		const queuedInput = normalizeClientInputQueuedPayload(entry.queuedInput);
		if (queuedInput.delivery !== expectedQueuedDelivery(record)) {
			throw new Error(`Queued client input ${entry.id} conflicts with its requested delivery`);
		}
		if (record.queuedInput) {
			throw new Error(`Client input id ${JSON.stringify(entry.clientMessageId)} has duplicate queued entries`);
		}
		record.queuedEntryId = entry.id;
		record.queuedInput = queuedInput;
		record.state = "accepted";
		record.error = undefined;
		return;
	}
	if (entry.type === "client_input_state") {
		const record = records.get(entry.clientMessageId);
		if (!record || record.receiptId !== entry.receiptId) {
			throw new Error(`Client input state ${entry.id} has no matching receipt`);
		}
		if (record.state === "completed" || record.state === "failed") {
			throw new Error(`Client input state ${entry.id} follows a terminal state`);
		}
		if (entry.state === "started" && record.state !== "accepted") {
			throw new Error(`Client input state ${entry.id} repeats the started boundary`);
		}
		if (entry.state === "accepted" && record.state !== "started") {
			throw new Error(`Client input state ${entry.id} cannot roll back from ${record.state}`);
		}
		record.state = entry.state;
		record.error = entry.state === "failed" ? entry.error : undefined;
		return;
	}
	if (entry.type !== "message" || entry.message.role !== "user" || entry.message.clientMessageId === undefined) {
		return;
	}
	const record = records.get(entry.message.clientMessageId);
	if (!record || record.state !== "started") {
		throw new Error(
			`Canonical client input ${JSON.stringify(entry.message.clientMessageId)} requires a started receipt`,
		);
	}
	record.state = "completed";
	record.error = undefined;
	record.canonicalEntryId = entry.id;
}

export function createClientInputSequenceValidator(
	seeds: readonly ClientInputSequenceSeed[] = [],
): ClientInputSequenceValidator {
	const records = new Map<string, ClientInputSequenceRecord>();
	for (const seed of seeds) {
		assertClientMessageIdValue(seed.clientMessageId, "clientInput.clientMessageId");
		idValue(seed.receiptId, "clientInput.receiptId");
		const command = parseClientInputCommand(seed.command, "clientInput.command");
		const input = normalizeClientInputPayload(command, seed.input);
		if (seed.semanticDigest !== digestClientInputPayload(command, input)) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has a mismatched semantic digest`);
		}
		if (records.has(seed.clientMessageId)) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has duplicate state`);
		}
		if (
			seed.state !== "accepted" &&
			seed.state !== "started" &&
			seed.state !== "completed" &&
			seed.state !== "failed"
		) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has invalid state`);
		}
		const queuedInput =
			seed.queuedInput === undefined ? undefined : normalizeClientInputQueuedPayload(seed.queuedInput);
		const record: ClientInputSequenceRecord = {
			receiptId: seed.receiptId,
			clientMessageId: seed.clientMessageId,
			command,
			semanticDigest: seed.semanticDigest,
			input,
			state: seed.state,
			...(seed.queuedEntryId === undefined ? {} : { queuedEntryId: seed.queuedEntryId }),
			...(queuedInput === undefined ? {} : { queuedInput }),
			...(seed.error === undefined ? {} : { error: seed.error }),
			...(seed.canonicalEntryId === undefined ? {} : { canonicalEntryId: seed.canonicalEntryId }),
		};
		if ((record.queuedEntryId === undefined) !== (record.queuedInput === undefined)) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has incomplete queued state`);
		}
		if (record.queuedInput && record.queuedInput.delivery !== expectedQueuedDelivery(record)) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has conflicting queued state`);
		}
		if (
			(record.state !== "failed" && record.error !== undefined) ||
			(record.error !== undefined && Array.from(record.error).length > CLIENT_INPUT_ERROR_MAX_SCALARS)
		) {
			throw new Error(`Client input ${JSON.stringify(seed.clientMessageId)} has invalid terminal state`);
		}
		if (record.queuedEntryId !== undefined) idValue(record.queuedEntryId, "clientInput.queuedEntryId");
		if (record.canonicalEntryId !== undefined) idValue(record.canonicalEntryId, "clientInput.canonicalEntryId");
		records.set(seed.clientMessageId, record);
	}
	return {
		apply(entry) {
			validateClientInputSequenceEntry(entry, records);
		},
		get(clientMessageId) {
			return records.get(clientMessageId);
		},
	};
}

export function validatePersistedSessionEntrySequence(
	values: readonly unknown[],
	options: { snapshot?: boolean } = {},
): Array<SessionEntry & { ordinal: number }> {
	const entries: Array<SessionEntry & { ordinal: number }> = [];
	const byId = new Map<string, SessionEntry>();
	const clientInputs = createClientInputSequenceValidator();
	let sawStartingGitContext = false;
	for (const [index, value] of values.entries()) {
		const entry = parsePersistedSessionEntry(value);
		if (entry.ordinal !== index + 1) {
			throw new Error(`Session entry ${entry.id} has a non-contiguous ordinal`);
		}
		validateEntryReferences(entry, byId);
		clientInputs.apply(entry);
		if (entry.type === "session_start_git_context") {
			if (sawStartingGitContext) throw new Error("Session contains more than one starting Git context entry");
			sawStartingGitContext = true;
		}
		if (options.snapshot && isHostOnlySessionEntryType(entry.type) && entry.type !== "leaf") {
			throw new Error(`Session snapshot contains unsupported host-only entry: ${entry.type}`);
		}
		if (options.snapshot && entry.type === "message" && entry.message.role === "user") {
			if (entry.message.clientMessageId !== undefined) {
				throw new Error("Session snapshot contains a transport-owned client message identity");
			}
		}
		if (options.snapshot && entry.type === "leaf" && index !== values.length - 1) {
			throw new Error("Session snapshot leaf must be the final entry");
		}
		entries.push(entry);
		byId.set(entry.id, entry);
	}
	if (options.snapshot) {
		const leafCount = entries.filter((entry) => entry.type === "leaf").length;
		if (leafCount !== 1) throw new Error("Session snapshot must contain exactly one final leaf entry");
	}
	return entries;
}

export function validateSessionEntryAdmissionReferences(
	entry: SessionEntry,
	byId: ReadonlyMap<string, SessionEntry>,
	nextOrdinal: number,
): void {
	validateEntryReferences({ ...entry, ordinal: nextOrdinal }, byId);
}

export function parseSessionSnapshotHeader(
	value: unknown,
	expectedVersion: number,
	expectedSnapshotVersion: number,
): SessionSnapshotHeader {
	const canonical = cloneCanonicalData(value, "Session snapshot header");
	const header = record(canonical, "$header");
	exactKeys(
		header,
		"$header",
		["type", "version", "snapshotVersion", "id", "timestamp", "cwd"],
		["parentSessionDirectory", "parentStoreId", "parentSessionId", "parentSessionGeneration", "origin"],
	);
	if (header.type !== "session") fail("$header.type", "expected session");
	if (header.version !== expectedVersion) fail("$header.version", `expected ${expectedVersion}`);
	if (header.snapshotVersion !== expectedSnapshotVersion) {
		fail("$header.snapshotVersion", `expected ${expectedSnapshotVersion}`);
	}
	assertValidSessionIdValue(header.id, "$header.id");
	canonicalTimestamp(header.timestamp, "$header.timestamp");
	nonEmptyString(header.cwd, "$header.cwd");
	if (header.origin !== undefined && header.origin !== "subagent") fail("$header.origin", "invalid origin");
	const parentKeys = [
		"parentSessionDirectory",
		"parentStoreId",
		"parentSessionId",
		"parentSessionGeneration",
	] as const;
	const parentCount = parentKeys.filter((key) => Object.hasOwn(header, key)).length;
	if (parentCount !== 0 && parentCount !== parentKeys.length) {
		fail("$header", "parent reference must be complete");
	}
	if (parentCount > 0) {
		nonEmptyString(header.parentSessionDirectory, "$header.parentSessionDirectory");
		idValue(header.parentStoreId, "$header.parentStoreId");
		assertValidSessionIdValue(header.parentSessionId, "$header.parentSessionId");
		idValue(header.parentSessionGeneration, "$header.parentSessionGeneration");
	}
	return canonical as unknown as SessionSnapshotHeader;
}

export function isValidSessionId(value: unknown): value is string {
	return typeof value === "string" && value.length <= SESSION_ID_MAX_CHARACTERS && SESSION_ID_PATTERN.test(value);
}

function assertValidSessionIdValue(value: unknown, path: string): asserts value is string {
	if (!isValidSessionId(value)) fail(path, "invalid session identity");
}

export function parseSessionReference(value: unknown, description = "Session reference"): SessionReference {
	const canonical = cloneCanonicalData(value, description);
	validateSessionReference(canonical, "$reference");
	return canonical as unknown as SessionReference;
}

export function isValidClientMessageId(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > RPC_CLIENT_MESSAGE_ID_MAX_CHARS ||
		value.startsWith(RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX)
	) {
		return false;
	}
	return value.match(CLIENT_INPUT_ID_PATTERN)?.[0] === value;
}

function assertClientMessageIdValue(value: unknown, path: string): asserts value is string {
	if (!isValidClientMessageId(value)) fail(path, "invalid client input identity");
}

export function assertClientMessageId(clientMessageId: string): void {
	if (!isValidClientMessageId(clientMessageId)) {
		throw new Error(
			`Client input id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,255} and be at most ${RPC_CLIENT_MESSAGE_ID_MAX_CHARS} ASCII characters`,
		);
	}
}

function normalizeClientInputImages(value: unknown): ImageContent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Client input images must be an array");
	if (value.length > RPC_CONVERSATION_INPUT_MAX_IMAGES) {
		throw new Error(`Client input images exceed the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-image limit`);
	}

	let aggregateBytes = 0;
	return value.map((candidate, index) => {
		const image = record(candidate, `clientInput.images[${index}]`);
		exactKeys(image, `clientInput.images[${index}]`, ["type", "mimeType", "data"]);
		if (image.type !== "image" || typeof image.mimeType !== "string" || typeof image.data !== "string") {
			throw new Error(`Client input image ${index} is invalid`);
		}
		nonEmptyString(image.mimeType, `clientInput.images[${index}].mimeType`);
		const mimeTypeBytes = Buffer.byteLength(image.mimeType, "utf8");
		if (mimeTypeBytes > RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES) {
			throw new Error(
				`Client input image ${index} MIME type exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		const dataBytes = Buffer.byteLength(image.data, "utf8");
		if (dataBytes > RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES) {
			throw new Error(
				`Client input image ${index} data exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		aggregateBytes += mimeTypeBytes + dataBytes;
		if (aggregateBytes > RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES) {
			throw new Error(
				`Client input images exceed the ${RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		return { type: "image", mimeType: image.mimeType, data: image.data };
	});
}

function normalizeClientInputContent(message: unknown, images: unknown): { message: string; images: ImageContent[] } {
	if (typeof message !== "string") throw new Error("Client input message must be a string");
	if (Buffer.byteLength(message, "utf8") > RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES) {
		throw new Error(
			`Client input message exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);
	}
	const normalizedImages = normalizeClientInputImages(images);
	if (
		Buffer.byteLength(JSON.stringify({ message, images: normalizedImages }), "utf8") >
		RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES
	) {
		throw new Error(`Client input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`);
	}
	return { message, images: normalizedImages };
}

function parseClientInputCommand(value: unknown, path: string): ClientInputCommand {
	if (value === "prompt" || value === "steer" || value === "follow_up") return value;
	return fail(path, "invalid client input command");
}

export function normalizeClientInputPayload(command: ClientInputCommand, value: unknown): ClientInputPayload {
	const canonical = cloneCanonicalData(value, "Client input receipt payload");
	const input = record(canonical, "clientInput");
	exactKeys(input, "clientInput", ["message"], ["images", "streamingBehavior"]);
	const content = normalizeClientInputContent(input.message, input.images);
	const streamingBehavior = input.streamingBehavior;
	if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
		throw new Error("Client input streaming behavior is invalid");
	}
	if (command !== "prompt" && streamingBehavior !== undefined) {
		throw new Error("Only prompt inputs may specify streaming behavior");
	}
	return { ...content, ...(streamingBehavior === undefined ? {} : { streamingBehavior }) };
}

export function normalizeClientInputQueuedPayload(value: unknown): ClientInputQueuedPayload {
	const canonical = cloneCanonicalData(value, "Queued client input payload");
	const input = record(canonical, "queuedInput");
	exactKeys(input, "queuedInput", ["delivery", "message"], ["images"]);
	if (input.delivery !== "steer" && input.delivery !== "follow_up") {
		throw new Error("Client input queued delivery is invalid");
	}
	return { delivery: input.delivery, ...normalizeClientInputContent(input.message, input.images) };
}

export function digestClientInputPayload(command: ClientInputCommand, input: ClientInputPayload): string {
	return createHash("sha256")
		.update(JSON.stringify({ command, ...input }))
		.digest("hex");
}

export function boundClientInputError(error: string): string {
	const scalars = Array.from(error);
	return scalars.length <= CLIENT_INPUT_ERROR_MAX_SCALARS
		? error
		: `${scalars.slice(0, CLIENT_INPUT_ERROR_MAX_SCALARS - 1).join("")}…`;
}
