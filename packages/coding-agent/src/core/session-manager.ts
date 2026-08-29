import { type AgentMessage, uuidv7 } from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonCompatibleInput, JsonValue, Message, TextContent } from "@hansjm10/volt-ai";
import { createHash, randomUUID } from "crypto";
import {
	closeSync,
	constants,
	createReadStream,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { basename, join, resolve } from "path";
import { createInterface } from "readline";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { TextDecoder } from "util";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { syncDurableFile, writeDurableAtomicFile, writeDurableAtomicFileSync } from "../utils/durable-atomic-write.ts";
import { canonicalizePath, normalizePath, resolvePath } from "../utils/paths.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	openPrivateRegularFile,
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
	writePrivateNewFile,
} from "../utils/private-files.ts";
import { cloneCanonicalData } from "./canonical-data.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";
import { clonePlanningState, DEFAULT_PLANNING_STATE, type PlanningState, parsePlanningState } from "./planning.ts";
import { RpcGitContextSchema } from "./rpc/schema/git-context.ts";
import type { RpcGitContext } from "./rpc/types.ts";
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
	RPC_SESSION_QUEUE_MAX_ITEMS,
} from "./rpc/wire-limits.ts";

function deepFreezeCanonicalData<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeCanonicalData(nested);
		Object.freeze(value);
	}
	return value;
}

export const CURRENT_SESSION_VERSION = 5;

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
}

/** How a session came to exist. Absent means a user-initiated session. */
export type SessionOrigin = "subagent";

export type SessionAtomicAppendEffect = "not_started" | "rolled_back" | "uncertain" | "committed";
export type SessionAtomicAppendAuthority = "available" | "reconciliation_required";

export class SessionAtomicAppendError extends Error {
	readonly effect: SessionAtomicAppendEffect;
	readonly authority: SessionAtomicAppendAuthority;

	constructor(
		message: string,
		effect: SessionAtomicAppendEffect,
		authority: SessionAtomicAppendAuthority,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SessionAtomicAppendError";
		this.effect = effect;
		this.authority = authority;
	}
}

export class SessionConversationStateUnavailableError extends Error {
	readonly code = "session_conversation_state_unavailable";

	constructor(options?: ErrorOptions) {
		super(
			"Session conversation authority requires reconciliation because persisted state could not be proven; replace the runtime",
			options,
		);
		this.name = "SessionConversationStateUnavailableError";
	}
}

export type SessionConversationAuthorityStatus =
	| { readonly status: "available" }
	| {
			readonly status: "reconciliation_required";
			readonly error: SessionConversationStateUnavailableError;
	  };

export type SessionConversationAuthorityListener = (
	status: Extract<SessionConversationAuthorityStatus, { status: "reconciliation_required" }>,
) => void;

export type SessionPersistenceDrainResult =
	| { readonly status: "closed" }
	| {
			readonly status: "reconciliation_required";
			readonly error: SessionConversationStateUnavailableError;
	  };

/**
 * Identity-only proof of one locally atomic client-input delivery commit.
 *
 * Callers must pass this object back to the originating SessionManager for
 * verification. Its visible fields are diagnostic only and are never trusted
 * as proof of persistence.
 */
export interface SessionDeliveryCommitReceipt {
	readonly receiptId: string;
}

export interface SessionDeliveryAttemptIdentity {
	readonly deliveryId: string;
	readonly epoch: number;
	readonly attemptId: string;
}

export interface SessionDeliveryCommitInput extends SessionDeliveryAttemptIdentity {
	readonly messages: readonly AgentMessage[];
	readonly planning?: PlanningState;
}

/** Identity-only canonical projection guard issued by one live SessionManager. */
export interface SessionCanonicalProjectionToken {
	readonly tokenId: string;
}

export interface SessionCanonicalProjection {
	readonly token: SessionCanonicalProjectionToken;
	readonly leafId: string | null;
	readonly revision: number;
	readonly entries: readonly SessionEntry[];
}

export type SessionCanonicalAppend =
	| { readonly type: "message"; readonly message: AgentMessage }
	| { readonly type: "thinking_level_change"; readonly thinkingLevel: string }
	| { readonly type: "model_change"; readonly provider: string; readonly modelId: string }
	| { readonly type: "planning_state_change"; readonly planning: PlanningState }
	| {
			readonly type: "compaction";
			readonly summary: string;
			readonly firstKeptEntryId: string;
			readonly tokensBefore: number;
			readonly details?: JsonValue;
			readonly fromHook?: boolean;
	  }
	| {
			readonly type: "branch_summary";
			readonly fromId: string | null;
			readonly summary: string;
			readonly details?: JsonValue;
			readonly fromHook?: boolean;
	  }
	| { readonly type: "custom"; readonly customType: string; readonly data?: JsonValue }
	| {
			readonly type: "custom_message";
			readonly customType: string;
			readonly content: string | readonly (TextContent | ImageContent)[];
			readonly display: boolean;
			readonly details?: JsonValue;
	  }
	| { readonly type: "label"; readonly targetId: string; readonly label?: string }
	| { readonly type: "session_info"; readonly name?: string };

export type SessionCanonicalMutation =
	| { readonly kind: "move"; readonly leafId: string | null }
	| {
			readonly kind: "move_with_summary";
			readonly leafId: string | null;
			readonly summary?: {
				readonly summary: string;
				readonly details?: JsonValue;
				readonly fromHook?: boolean;
				readonly label?: string;
			};
	  }
	| { readonly kind: "append"; readonly entry: SessionCanonicalAppend };

export interface SessionCanonicalCommand {
	readonly guard: {
		readonly kind: "exact" | "descendant";
		readonly token: SessionCanonicalProjectionToken;
	};
	readonly mutations: readonly SessionCanonicalMutation[];
}

export interface SessionCanonicalCommitEvidence {
	readonly before: SessionCanonicalProjection;
	readonly after: SessionCanonicalProjection;
	readonly appendedEntryIds: readonly string[];
}

export class SessionCanonicalConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionCanonicalConflictError";
	}
}

interface VerifiedSessionDeliveryBase extends SessionDeliveryAttemptIdentity {
	readonly sessionId: string;
	readonly beforeLeafId: string | null;
	readonly afterLeafId: string | null;
	readonly revision: number;
	readonly beforeProjection: SessionCanonicalProjection;
	readonly afterProjection: SessionCanonicalProjection;
}

export interface VerifiedSessionDeliveryCommit extends VerifiedSessionDeliveryBase {
	readonly outcome: "committed";
	readonly entryIds: readonly string[];
	readonly messages: readonly AgentMessage[];
	readonly clientMessageIds: readonly string[];
	readonly planning?: PlanningState;
}

export interface VerifiedSessionDeliveryNoEffect extends VerifiedSessionDeliveryBase {
	readonly outcome: "no_effect";
}

export type VerifiedSessionDeliveryReceipt = VerifiedSessionDeliveryCommit | VerifiedSessionDeliveryNoEffect;

class AtomicAppendPersistenceFailure extends Error {
	readonly effect: Exclude<SessionAtomicAppendEffect, "committed">;
	readonly authority: SessionAtomicAppendAuthority;

	constructor(
		message: string,
		effect: Exclude<SessionAtomicAppendEffect, "committed">,
		authority: SessionAtomicAppendAuthority,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.effect = effect;
		this.authority = authority;
	}
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	origin?: SessionOrigin;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** Monotonic file commit order. Added on append and backfilled by v4 migration. */
	ordinal?: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export type ClientInputCommand = "prompt" | "steer" | "follow_up";
export type ClientInputState = "accepted" | "started" | "completed" | "failed";
export type ClientInputStreamingBehavior = "steer" | "followUp";
export type ClientInputQueuedDelivery = "steer" | "follow_up";

export interface ClientInputPayload {
	message: string;
	images: ImageContent[];
	streamingBehavior?: ClientInputStreamingBehavior;
}

export interface ClientInputPayloadInput {
	message: string;
	images?: readonly ImageContent[];
	streamingBehavior?: ClientInputStreamingBehavior;
}

export interface ClientInputQueuedPayload {
	delivery: ClientInputQueuedDelivery;
	message: string;
	images: ImageContent[];
}

export interface ClientInputQueuedPayloadInput {
	delivery: ClientInputQueuedDelivery;
	message: string;
	images?: readonly ImageContent[];
}

/**
 * Durable idempotency reservation for one client-originated conversation input.
 * This is host metadata only: it never enters model context or transcript projection.
 *
 * An accepted receipt retains the exact retryable input. Queued delivery is
 * persisted separately after abortable transforms and before the in-memory
 * queue is mutated. A `started` receipt with no terminal record is deliberately
 * ambiguous and must never be replayed automatically. Canonical identified
 * user-message commits imply `completed`; handled non-message inputs append an
 * explicit terminal.
 */
export interface ClientInputReceiptEntry extends SessionEntryBase {
	type: "client_input_receipt";
	clientMessageId: string;
	command: ClientInputCommand;
	semanticDigest: string;
	input: ClientInputPayload;
}

/** Exact post-preflight queue intent, durable before queue admission is acknowledged. */
export interface ClientInputQueuedEntry extends SessionEntryBase {
	type: "client_input_queued";
	receiptId: string;
	clientMessageId: string;
	queuedInput: ClientInputQueuedPayload;
}

/** Append-only state transition for a client input receipt. */
export interface ClientInputStateEntry extends SessionEntryBase {
	type: "client_input_state";
	receiptId: string;
	clientMessageId: string;
	state: ClientInputState;
	error?: string;
}

export interface ClientInputRecord {
	receiptId: string;
	clientMessageId: string;
	command: ClientInputCommand;
	semanticDigest: string;
	input: ClientInputPayload;
	queuedEntryId?: string;
	queuedInput?: ClientInputQueuedPayload;
	state: ClientInputState;
	error?: string;
	/** Canonical identified user entry that completed this input, when applicable. */
	canonicalEntryId?: string;
}

/**
 * Durable automatic-recovery state. A started receipt without a canonical or
 * terminal boundary is an at-most-once ambiguity fence: queued receipts remain
 * visible, but none may be dispatched automatically past that uncertainty.
 */
export type ClientInputRecoveryPlan =
	| { kind: "idle"; records: [] }
	| { kind: "replay"; records: ClientInputRecord[] }
	| { kind: "blocked"; records: ClientInputRecord[]; blocker: ClientInputRecord };

export interface ClientInputReservation {
	record: ClientInputRecord;
	created: boolean;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface FastModeChangeEntry extends SessionEntryBase {
	type: "fast_mode_change";
	enabled: boolean;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/** Complete branch-local Plan mode snapshot. */
export interface PlanningStateChangeEntry extends SessionEntryBase {
	type: "planning_state_change";
	planning: PlanningState;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific JSON data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: JsonValue;
	/** True if generated by an extension, undefined/false if volt-generated (backward compatible) */
	fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific JSON data (not sent to LLM) */
	details?: JsonValue;
	/** True if generated by an extension, false if volt-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * First path-free Git observation for a newly created session. Host metadata
 * only: it never advances the conversation branch or enters model context.
 */
export interface SessionStartGitContextEntry extends SessionEntryBase {
	type: "session_start_git_context";
	gitContext: RpcGitContext | null;
}

const SessionStartGitContextEntrySchema = Type.Object(
	{
		type: Type.Literal("session_start_git_context"),
		id: Type.String({ minLength: 1 }),
		parentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		timestamp: Type.String({ minLength: 1, maxLength: 64 }),
		ordinal: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
		gitContext: Type.Union([RpcGitContextSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

function isValidSessionStartGitContextEntry(value: unknown): value is SessionStartGitContextEntry {
	return Check(SessionStartGitContextEntrySchema, value);
}

/** Durable host-only active-branch pointer. Never projected into conversation history. */
export interface LeafEntry extends SessionEntryBase {
	type: "leaf";
	targetId: string | null;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: JsonValue;
	display: boolean;
}

/**
 * Durable spawn edge for one subagent child started by a `subagent` tool call.
 * Host metadata only: never part of model context, branch navigation, forks, or
 * transcript projection. Appended at the two-phase publish commit point, so a
 * recorded edge always refers to a child whose first prompt was accepted.
 *
 * Edge state is derived, not stored: an edge is settled when its toolCallId
 * has a persisted toolResult produced by the tool itself. A missing result or
 * a dispose-time synthesized aborted result leaves the edge recoverable —
 * see docs/design/subagent-durable-spawn-graph.md §4. Registry hydration
 * reads these entries together with the named child transcripts to recover
 * results after a crash or runtime disposal (issue #129).
 */
export interface SubagentSpawnEntry extends SessionEntryBase {
	type: "subagent_spawn";
	toolCallId: string;
	subagentId: string;
	agent: string;
	childSessionId: string;
	/** Absolute child session file path at spawn time. Absent for in-memory children. */
	childSessionFile?: string;
	/** Dedup request key of the originating spawn request. Never projected to clients. */
	requestKey: string;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ClientInputReceiptEntry
	| ClientInputQueuedEntry
	| ClientInputStateEntry
	| ThinkingLevelChangeEntry
	| FastModeChangeEntry
	| ModelChangeEntry
	| PlanningStateChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| SessionStartGitContextEntry
	| LeafEntry
	| SubagentSpawnEntry;

/** Host-only input admission WAL records. These never participate in the conversation branch or projection. */
export function isClientInputWalEntry(
	entry: FileEntry,
): entry is ClientInputReceiptEntry | ClientInputQueuedEntry | ClientInputStateEntry {
	return (
		entry.type === "client_input_receipt" ||
		entry.type === "client_input_queued" ||
		entry.type === "client_input_state"
	);
}

/**
 * Host-only sidecar records sharing the JSONL for crash recovery. They never
 * advance the branch leaf, never enter model context or transcript projection,
 * and never copy into forks.
 */
export function isHostOnlySessionEntry(entry: FileEntry): boolean {
	return (
		isClientInputWalEntry(entry) ||
		entry.type === "session_start_git_context" ||
		entry.type === "subagent_spawn" ||
		entry.type === "leaf"
	);
}

const CLIENT_INPUT_ID_MAX_CHARACTERS = RPC_CLIENT_MESSAGE_ID_MAX_CHARS;
const CLIENT_INPUT_ID_PATTERN = new RegExp(`^${RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE}$`);
export const RUNTIME_QUEUE_ENTRY_ID_PREFIX = RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX;
const CLIENT_INPUT_MESSAGE_MAX_UTF8_BYTES = RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES;
const CLIENT_INPUT_MAX_IMAGES = RPC_CONVERSATION_INPUT_MAX_IMAGES;
const CLIENT_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES = RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES;
const CLIENT_INPUT_IMAGE_DATA_MAX_UTF8_BYTES = RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES;
const CLIENT_INPUT_IMAGES_MAX_UTF8_BYTES = RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES;
const CLIENT_INPUT_MAX_SERIALIZED_BYTES = RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES;
export const CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES = RPC_SESSION_QUEUE_MAX_ITEMS;
export const CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;
export const CLIENT_INPUT_MAX_OUTSTANDING_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical wire/storage grammar for durable external conversation identities. */
export function isValidClientMessageId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > CLIENT_INPUT_ID_MAX_CHARACTERS) {
		return false;
	}
	// Runtime-only queue identities use this reserved namespace. Keeping it out
	// of the external semantic-ID domain makes an observed local queue card
	// impossible to forge through paired-client ingress.
	if (value.startsWith(RUNTIME_QUEUE_ENTRY_ID_PREFIX)) {
		return false;
	}
	// Comparing the full match avoids JavaScript `$` accepting a match immediately
	// before a trailing line terminator.
	return value.match(CLIENT_INPUT_ID_PATTERN)?.[0] === value;
}

/** Runtime-only dequeue identity. This namespace is never valid at paired-client ingress. */
export function isRuntimeQueueEntryId(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(RUNTIME_QUEUE_ENTRY_ID_PREFIX) && value.length <= 64;
}

function assertClientMessageId(clientMessageId: string): void {
	if (!isValidClientMessageId(clientMessageId)) {
		throw new Error(
			`Client input id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,255} and be at most ${CLIENT_INPUT_ID_MAX_CHARACTERS} ASCII characters`,
		);
	}
}

function normalizeClientInputImages(value: unknown): ImageContent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error("Client input images must be an array");
	}
	if (value.length > CLIENT_INPUT_MAX_IMAGES) {
		throw new Error(`Client input images exceed the ${CLIENT_INPUT_MAX_IMAGES}-image limit`);
	}

	let aggregateBytes = 0;
	return value.map((candidate, index) => {
		if (
			!isRecord(candidate) ||
			candidate.type !== "image" ||
			typeof candidate.mimeType !== "string" ||
			typeof candidate.data !== "string"
		) {
			throw new Error(`Client input image ${index} is invalid`);
		}
		const mimeTypeBytes = Buffer.byteLength(candidate.mimeType, "utf8");
		if (mimeTypeBytes > CLIENT_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES) {
			throw new Error(
				`Client input image ${index} MIME type exceeds the ${CLIENT_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		const dataBytes = Buffer.byteLength(candidate.data, "utf8");
		if (dataBytes > CLIENT_INPUT_IMAGE_DATA_MAX_UTF8_BYTES) {
			throw new Error(
				`Client input image ${index} data exceeds the ${CLIENT_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		aggregateBytes += mimeTypeBytes + dataBytes;
		if (aggregateBytes > CLIENT_INPUT_IMAGES_MAX_UTF8_BYTES) {
			throw new Error(`Client input images exceed the ${CLIENT_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 limit`);
		}
		return { type: "image", mimeType: candidate.mimeType, data: candidate.data };
	});
}

function normalizeClientInputContent(message: unknown, images: unknown): { message: string; images: ImageContent[] } {
	if (typeof message !== "string") {
		throw new Error("Client input message must be a string");
	}
	if (Buffer.byteLength(message, "utf8") > CLIENT_INPUT_MESSAGE_MAX_UTF8_BYTES) {
		throw new Error(`Client input message exceeds the ${CLIENT_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`);
	}
	const normalizedImages = normalizeClientInputImages(images);
	if (
		Buffer.byteLength(JSON.stringify({ message, images: normalizedImages }), "utf8") >
		CLIENT_INPUT_MAX_SERIALIZED_BYTES
	) {
		throw new Error(`Client input exceeds the ${CLIENT_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`);
	}
	return { message, images: normalizedImages };
}

function normalizeClientInputPayload(command: ClientInputCommand, value: unknown): ClientInputPayload {
	if (!isRecord(value)) {
		throw new Error("Client input receipt payload is invalid");
	}
	const content = normalizeClientInputContent(value.message, value.images);
	const streamingBehavior = value.streamingBehavior;
	if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
		throw new Error("Client input streaming behavior is invalid");
	}
	if (command !== "prompt" && streamingBehavior !== undefined) {
		throw new Error("Only prompt inputs may specify streaming behavior");
	}
	return {
		...content,
		...(streamingBehavior === undefined ? {} : { streamingBehavior }),
	};
}

function normalizeClientInputQueuedPayload(value: unknown): ClientInputQueuedPayload {
	if (!isRecord(value) || (value.delivery !== "steer" && value.delivery !== "follow_up")) {
		throw new Error("Client input queued delivery is invalid");
	}
	return {
		delivery: value.delivery,
		...normalizeClientInputContent(value.message, value.images),
	};
}

function measureClientInputPayloadBytes(value: ClientInputPayload | ClientInputQueuedPayload): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function getOutstandingClientInputBytes(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state === "completed" || record.state === "failed") continue;
		total += measureClientInputPayloadBytes(record.input);
		if (record.queuedInput) {
			total += measureClientInputPayloadBytes(record.queuedInput);
		}
	}
	return total;
}

function getOutstandingClientInputCount(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state !== "completed" && record.state !== "failed") {
			total++;
		}
	}
	return total;
}

function getRecoverableQueuedClientInputCount(records: Iterable<ClientInputRecord>): number {
	let total = 0;
	for (const record of records) {
		if (record.state === "accepted" && record.queuedInput !== undefined) {
			total++;
		}
	}
	return total;
}

function assertClientInputOutstandingCount(records: Iterable<ClientInputRecord>, additionalEntries: number): void {
	if (getOutstandingClientInputCount(records) + additionalEntries > CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES) {
		throw new Error(`Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES}-entry limit`);
	}
}

function assertClientInputOutstandingBudget(records: Iterable<ClientInputRecord>, additionalBytes: number): void {
	if (getOutstandingClientInputBytes(records) + additionalBytes > CLIENT_INPUT_MAX_OUTSTANDING_BYTES) {
		throw new Error(
			`Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_BYTES}-byte aggregate limit`,
		);
	}
}

function digestClientInputPayload(command: ClientInputCommand, input: ClientInputPayload): string {
	return createHash("sha256")
		.update(JSON.stringify({ command, ...input }))
		.digest("hex");
}

export function createClientInputSemanticDigest(command: ClientInputCommand, input: ClientInputPayloadInput): string {
	return digestClientInputPayload(command, normalizeClientInputPayload(command, input));
}

function cloneClientInputRecord(record: ClientInputRecord): ClientInputRecord {
	return {
		...record,
		input: { ...record.input, images: record.input.images.map((image) => ({ ...image })) },
		...(record.queuedInput === undefined
			? {}
			: {
					queuedInput: {
						...record.queuedInput,
						images: record.queuedInput.images.map((image) => ({ ...image })),
					},
				}),
	};
}

function requireStartedClientInputReceipt(
	records: ReadonlyMap<string, ClientInputRecord>,
	clientMessageId: string,
): ClientInputRecord {
	assertClientMessageId(clientMessageId);
	const record = records.get(clientMessageId);
	if (!record) {
		throw new Error(`Canonical client input ${JSON.stringify(clientMessageId)} has no matching durable receipt`);
	}
	if (record.state !== "started") {
		throw new Error(
			`Canonical client input ${JSON.stringify(clientMessageId)} requires a started receipt; found ${record.state}`,
		);
	}
	return record;
}

function getExpectedClientInputQueuedDelivery(record: ClientInputRecord): ClientInputQueuedDelivery | undefined {
	if (record.command === "steer") return "steer";
	if (record.command === "follow_up") return "follow_up";
	if (record.input.streamingBehavior === "steer") return "steer";
	if (record.input.streamingBehavior === "followUp") return "follow_up";
	return undefined;
}

export type SessionEntryListener = (entry: SessionEntry) => void;

export interface SessionBranchChange {
	previousLeafId: string | null;
	nextLeafId: string | null;
}

export interface SessionBranchWindowOptions {
	/** Exclude this entry and begin at its parent; omit to begin at the active leaf. */
	beforeEntryId?: string;
	/** Newest branch entries returned in chronological order. */
	maxEntries: number;
	/** Older context returned separately for bounded correlation lookups. */
	lookbackEntries?: number;
}

export interface SessionBranchWindow {
	entries: SessionEntry[];
	lookback: SessionEntry[];
	hasEarlier: boolean;
	/** Number of branch entries visited, excluding the one bounded earlier-existence probe. */
	visitedEntries: number;
}

export type SessionBranchListener = (change: SessionBranchChange) => void;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	fastMode: { enabled: boolean };
	planning: PlanningState;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
	/** First host-observed path-free Git state for this session. */
	startingGitContext?: RpcGitContext | null;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getBranchWindow"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Migrate v3 → v4: assign stable file-order commit ordinals. Mutates in place. */
function migrateV3ToV4(entries: FileEntry[]): void {
	let ordinal = 1;
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 4;
			continue;
		}
		entry.ordinal = ordinal++;
	}
}

/** Migrate v4 → v5: discard unreplayable legacy WAL while preserving canonical transcript entries. */
function migrateV4ToV5(entries: FileEntry[]): void {
	const retainedEntries = entries.filter(
		(entry) =>
			entry.type !== "client_input_receipt" &&
			entry.type !== "client_input_queued" &&
			entry.type !== "client_input_state",
	);
	entries.splice(0, entries.length, ...retainedEntries);
	for (const entry of retainedEntries) {
		if (entry.type === "session") {
			entry.version = 5;
		} else if (entry.type === "message" && entry.message.role === "user") {
			// v4 receipts did not retain the replayable payload required by v5. Once
			// their WAL is discarded, the transport identity must go with it so the
			// migrated canonical transcript cannot impersonate a v5 completion boundary.
			delete (entry.message as { clientMessageId?: string }).clientMessageId;
		}
	}
}

function withoutClientInputIdentity(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "user" || entry.message.clientMessageId === undefined) {
		return entry;
	}
	const message = { ...entry.message };
	delete message.clientMessageId;
	return { ...entry, message };
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (!Number.isSafeInteger(version) || version < 1) {
		throw new Error(`Session has an invalid schema version: ${String(version)}`);
	}
	if (version > CURRENT_SESSION_VERSION) {
		throw new Error(`Session schema version ${version} is newer than supported version ${CURRENT_SESSION_VERSION}`);
	}
	if (version === CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);
	if (version < 5) migrateV4ToV5(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return {
			messages: [],
			thinkingLevel: "off",
			model: null,
			fastMode: { enabled: false },
			planning: clonePlanningState(DEFAULT_PLANNING_STATE),
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			model: null,
			fastMode: { enabled: false },
			planning: clonePlanningState(DEFAULT_PLANNING_STATE),
		};
	}

	// Walk from leaf to root, collecting path
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// Extract settings and find compaction
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let fastMode = { enabled: false };
	let planning = clonePlanningState(DEFAULT_PLANNING_STATE);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "fast_mode_change") {
			fastMode = { enabled: entry.enabled };
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "planning_state_change") {
			planning = clonePlanningState(entry.planning);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// Build messages and collect corresponding entries
	// When there's a compaction, we need to:
	// 1. Emit summary first (entry = compaction)
	// 2. Emit kept messages (from firstKeptEntryId up to compaction)
	// 3. Emit messages after compaction
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		// Emit summary first
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));

		// Find compaction index in path
		const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);

		// Emit kept messages (before compaction, starting from firstKeptEntryId)
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessage(entry);
			}
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model, fastMode, planning };
}

/** Encode a cwd into the safe `--…--` session-directory name. */
function encodeSessionDirName(cwd: string): string {
	const resolvedCwd = resolvePath(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * True when a session directory is the default-shaped directory for a cwd
 * (under ANY agent dir). Such directories hold every session of that
 * workspace — including worktree-bound sessions whose header cwd differs —
 * so cwd filtering must not apply to them.
 */
function isDefaultShapedSessionDir(dir: string, cwd: string): boolean {
	return basename(dir) === encodeSessionDirName(cwd);
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.volt/agent/sessions/.
 * Pure path computation; `getDefaultSessionDir` also creates and hardens the
 * directory. Exported for read-only daemon lookups that must not mutate it.
 */
export function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	return join(resolvePath(agentDir), "sessions", encodeSessionDirName(cwd));
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	ensurePrivateDirectorySync(sessionDir);
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_HEADER_READ_CHUNK_BYTES = 4 * 1024;

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? (parsed as unknown as FileEntry) : null;
	} catch {
		return null;
	}
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseSessionEntryBytes(bytes: Uint8Array): { entry: FileEntry | null; malformed: boolean } {
	let line: string;
	try {
		line = fatalUtf8Decoder.decode(bytes);
	} catch {
		return { entry: null, malformed: bytes.length > 0 };
	}
	if (!line.trim()) return { entry: null, malformed: false };
	const entry = parseSessionEntryLine(line);
	return { entry, malformed: entry === null };
}

function parseAtomicSessionPreimage(content: Buffer): FileEntry[] {
	const entries: FileEntry[] = [];
	let lineStart = 0;
	let lineNumber = 0;
	for (
		let newlineIndex = content.indexOf(0x0a);
		newlineIndex !== -1;
		newlineIndex = content.indexOf(0x0a, lineStart)
	) {
		lineNumber++;
		const parsed = parseSessionEntryBytes(content.subarray(lineStart, newlineIndex));
		if (parsed.malformed) {
			throw new Error(`Current session JSONL is malformed at committed line ${lineNumber}`);
		}
		if (parsed.entry) entries.push(parsed.entry);
		lineStart = newlineIndex + 1;
	}
	if (lineStart < content.length) {
		// Only an unterminated malformed suffix can be a torn append. A complete
		// final JSON record without its delimiter remains part of the preimage.
		const parsed = parseSessionEntryBytes(content.subarray(lineStart));
		if (parsed.entry) entries.push(parsed.entry);
	}
	return entries;
}

function exactOptionalBytesEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.equals(right);
}

/**
 * Append at a verified JSONL boundary. A power loss can leave
 * either a complete JSON object without its line delimiter or an incomplete
 * final object. Preserve the former by adding the missing newline and discard
 * only the latter by truncating back to the last committed delimiter.
 *
 * Opening a session is deliberately read-only: target discovery and phone
 * relay attach may inspect a file while another lease owner is writing it.
 * Repair therefore happens only when this manager is actually appending, and
 * any repair is fsynced before the new boundary is written. Windows reopens
 * the verified file with O_APPEND because its O_APPEND handles cannot truncate;
 * other platforms use one no-follow append descriptor throughout.
 */
const sessionFileOperationQueues = new Map<string, Promise<void>>();

/** Serialize filesystem mutations across managers that temporarily share one session file. */
function serializeSessionFileOperation(filePath: string, operation: () => Promise<void>): Promise<void> {
	const previous = sessionFileOperationQueues.get(filePath) ?? Promise.resolve();
	const task = previous.then(operation);
	const lane = task.catch(() => {});
	sessionFileOperationQueues.set(filePath, lane);
	return task.finally(() => {
		if (sessionFileOperationQueues.get(filePath) === lane) {
			sessionFileOperationQueues.delete(filePath);
		}
	});
}

async function appendSessionFileEntry(filePath: string, content: string, durable: boolean): Promise<void> {
	// Windows rejects ftruncate on a descriptor opened with O_APPEND. Inspect and
	// repair without it, then reopen with OS-level append semantics for the entry.
	const appendFlag = process.platform === "win32" ? 0 : constants.O_APPEND;
	let handle = await openPrivateRegularFile(filePath, constants.O_RDWR | appendFlag);
	let failed = false;
	try {
		const fileStat = await handle.stat();
		let appendOffset = fileStat.size;
		if (fileStat.size > 0) {
			const lastByte = Buffer.allocUnsafe(1);
			if ((await handle.read(lastByte, 0, 1, fileStat.size - 1)).bytesRead !== 1) {
				throw new Error(`Failed to inspect session tail: ${filePath}`);
			}
			if (lastByte[0] !== 0x0a) {
				const scanBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, fileStat.size));
				let cursor = fileStat.size;
				let finalRecordOffset = 0;
				let foundDelimiter = false;
				while (cursor > 0 && !foundDelimiter) {
					const length = Math.min(scanBuffer.length, cursor);
					const offset = cursor - length;
					const { bytesRead } = await handle.read(scanBuffer, 0, length, offset);
					if (bytesRead !== length) throw new Error(`Failed to inspect session tail: ${filePath}`);
					for (let index = length - 1; index >= 0; index--) {
						if (scanBuffer[index] === 0x0a) {
							finalRecordOffset = offset + index + 1;
							foundDelimiter = true;
							break;
						}
					}
					cursor = offset;
				}

				const finalRecordLength = fileStat.size - finalRecordOffset;
				const finalRecord = Buffer.allocUnsafe(finalRecordLength);
				let bytesLoaded = 0;
				while (bytesLoaded < finalRecordLength) {
					const { bytesRead } = await handle.read(
						finalRecord,
						bytesLoaded,
						finalRecordLength - bytesLoaded,
						finalRecordOffset + bytesLoaded,
					);
					if (bytesRead === 0) throw new Error(`Failed to read session tail: ${filePath}`);
					bytesLoaded += bytesRead;
				}

				if (parseSessionEntryBytes(finalRecord).entry) {
					const { bytesWritten } = await handle.write("\n", fileStat.size, "utf8");
					if (bytesWritten !== 1) throw new Error(`Failed to repair session tail: ${filePath}`);
					appendOffset = fileStat.size + 1;
				} else {
					await handle.truncate(finalRecordOffset);
					appendOffset = finalRecordOffset;
				}
				await handle.sync();
			}
		}
		let appendPosition: number | null = appendOffset;
		if (process.platform === "win32") {
			await handle.close();
			handle = await openPrivateRegularFile(filePath, constants.O_WRONLY | constants.O_APPEND);
			appendPosition = null;
		}
		const entryBuffer = Buffer.from(content, "utf8");
		let bytesWritten = 0;
		while (bytesWritten < entryBuffer.length) {
			const result = await handle.write(
				entryBuffer,
				bytesWritten,
				entryBuffer.length - bytesWritten,
				appendPosition === null ? null : appendPosition + bytesWritten,
			);
			if (result.bytesWritten === 0) throw new Error(`Failed to append session entry: ${filePath}`);
			bytesWritten += result.bytesWritten;
		}
		if (durable) await handle.sync();
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (failed) {
			await handle.close().catch(() => {});
		} else {
			await handle.close();
		}
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let malformedCompleteLine: number | undefined;
	let lineNumber = 0;
	const fd = openSync(resolvedFilePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		const pendingChunks: Buffer[] = [];
		let pendingBytes = 0;
		const parseLine = (tail: Buffer): void => {
			const line = pendingBytes === 0 ? tail : Buffer.concat([...pendingChunks, tail], pendingBytes + tail.length);
			pendingChunks.splice(0);
			pendingBytes = 0;
			const parsed = parseSessionEntryBytes(line);
			if (parsed.entry) entries.push(parsed.entry);
			else if (parsed.malformed && malformedCompleteLine === undefined) malformedCompleteLine = lineNumber;
		};

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			let lineStart = 0;
			let newlineIndex = buffer.indexOf(0x0a, lineStart);
			while (newlineIndex !== -1 && newlineIndex < bytesRead) {
				lineNumber++;
				parseLine(buffer.subarray(lineStart, newlineIndex));
				lineStart = newlineIndex + 1;
				newlineIndex = buffer.indexOf(0x0a, lineStart);
			}
			if (lineStart < bytesRead) {
				const tail = Buffer.from(buffer.subarray(lineStart, bytesRead));
				pendingChunks.push(tail);
				pendingBytes += tail.length;
			}
		}

		// A malformed unterminated final fragment may be a torn append. Every
		// newline-terminated malformed record is a committed interior corruption
		// candidate and is handled fail-closed below for current WAL sessions.
		if (pendingBytes > 0) {
			const finalLine = Buffer.concat(pendingChunks, pendingBytes);
			const parsed = parseSessionEntryBytes(finalLine);
			if (parsed.entry) entries.push(parsed.entry);
		}
	} finally {
		closeSync(fd);
	}

	// Validate session header. Current WAL sessions cannot silently skip a
	// malformed committed line: it might be the only started/canonical boundary
	// preventing duplicate side effects. A parseable legacy header retains its
	// historical best-effort behavior. A file with no parseable records fails
	// because it cannot be proven to be legacy rather than a current WAL whose
	// header or only durable boundary was destroyed.
	const parsedHeader = entries[0];
	if (
		malformedCompleteLine !== undefined &&
		(entries.length === 0 ||
			(parsedHeader?.type === "session" && (parsedHeader.version ?? 1) >= CURRENT_SESSION_VERSION) ||
			entries.some(isClientInputWalEntry))
	) {
		throw new Error(`Current session JSONL is malformed at committed line ${malformedCompleteLine}`);
	}
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

/**
 * Hardened first-line header read (O_NOFOLLOW, single-link regular files
 * only). Exported for daemon worktree resolution, which needs a session's
 * stored cwd without paying a full WAL-validating open.
 */
export function readSessionHeader(filePath: string): SessionHeader | null {
	let fd: number | undefined;
	try {
		hardenPrivateRegularFileSync(filePath);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		fd = openSync(filePath, constants.O_RDONLY | noFollow);
		const fileStat = fstatSync(fd);
		if (!fileStat.isFile() || fileStat.nlink !== 1) return null;

		const chunks: Buffer[] = [];
		let byteCount = 0;
		let reachedBoundary = false;
		while (byteCount <= SESSION_HEADER_MAX_BYTES) {
			const remainingProbeBytes = SESSION_HEADER_MAX_BYTES + 1 - byteCount;
			const buffer = Buffer.allocUnsafe(Math.min(SESSION_HEADER_READ_CHUNK_BYTES, remainingProbeBytes));
			const bytesRead = readSync(fd, buffer, 0, buffer.length, byteCount);
			if (bytesRead === 0) {
				reachedBoundary = true;
				break;
			}
			const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
			const retainedBytes = newlineIndex === -1 ? bytesRead : newlineIndex;
			if (retainedBytes > 0) chunks.push(buffer.subarray(0, retainedBytes));
			byteCount += retainedBytes;
			if (newlineIndex !== -1) {
				reachedBoundary = true;
				break;
			}
		}
		if (!reachedBoundary || byteCount > SESSION_HEADER_MAX_BYTES) return null;
		const firstLine = Buffer.concat(chunks, byteCount).toString("utf8");
		if (!firstLine) return null;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string") {
			return null;
		}
		return header as unknown as SessionHeader;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && canonicalizePath(resolvePath(cwd)) === canonicalizePath(resolvedCwd);
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		ensurePrivateDirectorySync(resolvedSessionDir, { hardenExisting: false });
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeader(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContentFromContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function extractTextContent(message: Message): string {
	return extractTextContentFromContent(message.content);
}

function getEntryTimestamp(entry: Pick<SessionEntryBase, "timestamp">): number | undefined {
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	return getEntryTimestamp(entry);
}

function isDisplayedCustomMessage(entry: SessionEntry): entry is CustomMessageEntry {
	return entry.type === "custom_message" && entry.display;
}

function isSessionFileFlushContent(entry: FileEntry): boolean {
	return (
		entry.type === "client_input_receipt" ||
		entry.type === "leaf" ||
		entry.type === "planning_state_change" ||
		(entry.type === "message" && entry.message.role === "assistant") ||
		(entry.type === "custom_message" && entry.display)
	);
}

function isSessionDurabilityBoundary(entry: SessionEntry): boolean {
	return (
		entry.type === "fast_mode_change" ||
		entry.type === "planning_state_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "model_change" ||
		entry.type === "leaf" ||
		isClientInputWalEntry(entry) ||
		// A spawn edge that only reaches the page cache when the process dies
		// cannot recover its child; it gets the same fsync treatment as the
		// client-input WAL.
		entry.type === "subagent_spawn" ||
		entry.type === "session_start_git_context" ||
		(entry.type === "message" && entry.message.role === "user" && typeof entry.message.clientMessageId === "string")
	);
}

const CLIENT_INPUT_ERROR_MAX_SCALARS = 2_000;

function boundClientInputError(error: string): string {
	const scalars = Array.from(error);
	return scalars.length <= CLIENT_INPUT_ERROR_MAX_SCALARS
		? error
		: `${scalars.slice(0, CLIENT_INPUT_ERROR_MAX_SCALARS).join("")}…`;
}

export interface SessionEntrySummary {
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	lastActivityTime?: number;
}

export function summarizeSessionEntries(entries: Iterable<SessionEntry>): SessionEntrySummary {
	let messageCount = 0;
	let firstUserMessage = "";
	let firstFallbackMessage = "";
	const allMessages: string[] = [];
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type === "message") {
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstUserMessage && message.role === "user") {
				firstUserMessage = textContent;
			}
			if (!firstFallbackMessage && message.role === "assistant") {
				firstFallbackMessage = textContent;
			}
			continue;
		}

		if (isDisplayedCustomMessage(entry)) {
			messageCount++;

			const activityTime = getEntryTimestamp(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const textContent = extractTextContentFromContent(entry.content);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstFallbackMessage) {
				firstFallbackMessage = textContent;
			}
		}
	}

	return {
		messageCount,
		firstMessage: firstUserMessage || firstFallbackMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
		lastActivityTime,
	};
}

async function buildSessionInfo(filePath: string, includeMessageFreeDurable = false): Promise<SessionInfo | null> {
	try {
		hardenPrivateRegularFileSync(filePath);
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		const entries: SessionEntry[] = [];
		let name: string | undefined;
		let startingGitContext: RpcGitContext | null | undefined;
		let sawStartingGitContext = false;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}
			if (entry.type === "session_start_git_context") {
				const currentFormat = (header.version ?? 1) >= CURRENT_SESSION_VERSION;
				if (currentFormat && (!isValidSessionStartGitContextEntry(entry) || sawStartingGitContext)) {
					throw new Error("Current session contains invalid starting Git context metadata");
				}
				if (!sawStartingGitContext && isValidSessionStartGitContextEntry(entry)) {
					startingGitContext = entry.gitContext;
					sawStartingGitContext = true;
				}
			}

			if (entry.type !== "session") {
				entries.push(entry);
			}
		}

		if (!header) return null;

		const summary = summarizeSessionEntries(entries);
		// A client-input receipt must be durable before admission, but that private
		// recovery boundary must not materialize an otherwise nonexistent
		// conversation in session selectors. Keep the file available for explicit
		// recovery by path; omit it from enumeration until canonical conversation
		// content has been committed.
		if (summary.messageCount === 0) {
			const hasFastModePolicy = entries.some((entry) => entry.type === "fast_mode_change");
			const hasPrivateClientInputWal = entries.some(isClientInputWalEntry);
			if ((hasFastModePolicy && !includeMessageFreeDurable) || (!hasFastModePolicy && hasPrivateClientInputWal)) {
				return null;
			}
		}
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const origin = header.origin === "subagent" ? header.origin : undefined;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
				? new Date(summary.lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			origin,
			...(startingGitContext === undefined ? {} : { startingGitContext }),
			created: new Date(header.timestamp),
			modified,
			messageCount: summary.messageCount,
			firstMessage: summary.firstMessage,
			allMessagesText: summary.allMessagesText,
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

export interface SessionListOptions {
	includeMessageFreeDurable?: boolean;
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
	includeMessageFreeDurable = false,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file, includeMessageFreeDurable)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
	includeMessageFreeDurable = false,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		ensurePrivateDirectorySync(dir, { hardenExisting: false });
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(
			files,
			() => {
				loaded++;
				onProgress?.(progressOffset + loaded, total);
			},
			includeMessageFreeDurable,
		);
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private clientInputsById: Map<string, ClientInputRecord> = new Map();
	private leafId: string | null = null;
	private nextOrdinal = 1;
	/** Monotonic revision of provider-visible entries and durable leaf movement. */
	private canonicalRevision = 0;
	/** Legacy migration is projected in memory on open and written only by the next actual writer. */
	private sessionFileNeedsMigration = false;
	/** First uncertain persistence failure. This manager remains fail-stopped until reloaded. */
	private persistenceError: Error | undefined;
	/** Sticky authority state carrying the first unresolved atomic-replacement cause. */
	private conversationAuthorityStatus: SessionConversationAuthorityStatus = { status: "available" };
	/** Prevents a disposed persisted session from accepting work after its final drain watermark. */
	private persistenceClosed = false;
	/** Only a session created by this manager may capture its first Git observation. */
	private acceptsStartingGitContext = false;
	/** Settled internal lane used to serialize immutable filesystem work. */
	private persistenceQueue: Promise<void> = Promise.resolve();
	/** Promise for all persistence work accepted through the latest synchronous mutation. */
	private persistenceWatermark: Promise<void> = Promise.resolve();
	private readonly entryListeners = new Set<SessionEntryListener>();
	private readonly branchListeners = new Set<SessionBranchListener>();
	private readonly conversationAuthorityListeners = new Set<SessionConversationAuthorityListener>();
	/** Entries staged by appendAtomically before one persistence operation is accepted. */
	private atomicAppendEntries: SessionEntry[] | undefined;
	/** Fences unrelated writers while an atomic replacement is settling. */
	private atomicAppendInFlight = false;
	/** Unforgeable in-process delivery commit capabilities issued by this manager. */
	private readonly deliveryCommitReceipts = new WeakMap<
		SessionDeliveryCommitReceipt,
		VerifiedSessionDeliveryReceipt
	>();
	/** Unforgeable raw projection guards issued by this manager generation. */
	private readonly canonicalProjectionTokens = new WeakMap<
		SessionCanonicalProjectionToken,
		SessionCanonicalProjection
	>();

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		hardenExistingSessionDir = true,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir) {
			ensurePrivateDirectorySync(this.sessionDir, { hardenExisting: hardenExistingSessionDir });
		}

		if (sessionFile) {
			this.setSessionFile(sessionFile);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this.assertConversationAuthorityAvailable();
		this.acceptsStartingGitContext = false;
		if (this.atomicAppendInFlight) {
			throw new Error("Cannot switch session files during an atomic append");
		}
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			hardenPrivateRegularFileSync(this.sessionFile);
			this.fileEntries = loadEntriesFromFile(this.sessionFile);

			if (this.fileEntries.length === 0) {
				throw new Error(`Session file has no valid session header: ${this.sessionFile}`);
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			if (!header || typeof header.id !== "string" || header.id.length === 0) {
				throw new Error(`Session file has no valid session header: ${this.sessionFile}`);
			}
			this.sessionId = header.id;

			// Migration is safe to compute for readers, but writing it here would let
			// target discovery mutate a session owned by another runtime.
			this.sessionFileNeedsMigration = migrateToCurrentVersion(this.fileEntries);

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this.assertConversationAuthorityAvailable();
		if (this.atomicAppendInFlight) {
			throw new Error("Cannot create a new session during an atomic append");
		}
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			...(options?.parentSession === undefined ? {} : { parentSession: options.parentSession }),
			...(options?.origin === undefined ? {} : { origin: options.origin }),
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.clientInputsById.clear();
		this.leafId = null;
		this.nextOrdinal = 1;
		this.canonicalRevision = 0;
		this.sessionFileNeedsMigration = false;
		this.flushed = false;
		this.acceptsStartingGitContext = true;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.clientInputsById.clear();
		this.leafId = null;
		this.nextOrdinal = 1;
		this.canonicalRevision = 0;
		const currentVersion =
			(this.fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined)?.version ===
			CURRENT_SESSION_VERSION;
		const seenEntryIds = new Set<string>();
		let lastWalOrdinal = 0;
		let sawStartingGitContext = false;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			if (currentVersion) {
				if (entry.type === "session_start_git_context") {
					if (!isValidSessionStartGitContextEntry(entry) || sawStartingGitContext) {
						throw new Error("Current session contains invalid starting Git context metadata");
					}
					sawStartingGitContext = true;
				}
				if (typeof entry.id !== "string" || entry.id.length === 0 || seenEntryIds.has(entry.id)) {
					throw new Error("Current session contains an invalid or duplicate entry identity");
				}
				seenEntryIds.add(entry.id);
				if (entry.type === "fast_mode_change" && typeof entry.enabled !== "boolean") {
					throw new Error(`Fast mode entry ${entry.id} has an invalid enabled state`);
				}
				if (isClientInputWalEntry(entry)) {
					if (!Number.isSafeInteger(entry.ordinal) || (entry.ordinal ?? 0) <= lastWalOrdinal) {
						throw new Error(`Client input WAL entry ${entry.id} has an invalid commit ordinal`);
					}
					lastWalOrdinal = entry.ordinal!;
					assertClientMessageId(entry.clientMessageId);
					if (
						(entry.type === "client_input_queued" || entry.type === "client_input_state") &&
						(typeof entry.receiptId !== "string" || entry.receiptId.length === 0)
					) {
						throw new Error(`Client input WAL entry ${entry.id} has an invalid receipt identity`);
					}
				}
			}
			if (Number.isSafeInteger(entry.ordinal) && (entry.ordinal ?? 0) > 0) {
				this.nextOrdinal = Math.max(this.nextOrdinal, (entry.ordinal ?? 0) + 1);
			}
			if (entry.type === "leaf") {
				if (
					entry.targetId !== null &&
					(!this.byId.has(entry.targetId) || isHostOnlySessionEntry(this.byId.get(entry.targetId)!))
				) {
					throw new Error(`Leaf entry ${entry.id} targets an invalid conversation entry`);
				}
				this.leafId = entry.targetId;
			}
			if (entry.type === "leaf" || !isHostOnlySessionEntry(entry)) this.canonicalRevision++;
			this.byId.set(entry.id, entry);
			if (!isHostOnlySessionEntry(entry)) {
				this.leafId = entry.id;
			}
			this._indexClientInputEntry(entry);
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _enqueuePersistence(write: () => Promise<void>): void {
		const task = this.persistenceQueue.then(async () => {
			if (this.persistenceError) throw this.persistenceError;
			try {
				await write();
			} catch (error) {
				this.persistenceError ??= error instanceof Error ? error : new Error(String(error));
				throw this.persistenceError;
			}
		});
		// Keep the serialization lane fulfilled so later accepted work can observe
		// the sticky error and stop without touching disk. The public watermark
		// retains rejection for flush callers.
		this.persistenceQueue = task.catch(() => {});
		this.persistenceWatermark = task;
		void task.catch(() => {});
	}

	private _serializeFileEntries(entries: readonly FileEntry[] = this.fileEntries): string {
		return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	}

	private _createFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const filePath = this.sessionFile;
		const content = this._serializeFileEntries();
		this._enqueuePersistence(() =>
			serializeSessionFileOperation(filePath, () => writePrivateNewFile(filePath, content)),
		);
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const filePath = this.sessionFile;
		const content = this._serializeFileEntries();
		this._enqueuePersistence(() =>
			serializeSessionFileOperation(filePath, () =>
				writeDurableAtomicFile(filePath, content, {
					directoryMode: PRIVATE_DIRECTORY_MODE,
					fileMode: PRIVATE_FILE_MODE,
				}),
			),
		);
		this.sessionFileNeedsMigration = false;
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getConversationAuthorityStatus(): SessionConversationAuthorityStatus {
		return this.conversationAuthorityStatus;
	}

	subscribeConversationAuthorityChanges(listener: SessionConversationAuthorityListener): () => void {
		this.conversationAuthorityListeners.add(listener);
		if (this.conversationAuthorityStatus.status === "reconciliation_required") {
			try {
				listener(this.conversationAuthorityStatus);
			} catch {
				// Authority loss is already committed. A projection observer cannot
				// make this manager available again.
			}
		}
		return () => {
			this.conversationAuthorityListeners.delete(listener);
		};
	}

	assertConversationAuthorityAvailable(): void {
		if (this.conversationAuthorityStatus.status === "reconciliation_required") {
			throw this.conversationAuthorityStatus.error;
		}
	}

	/** Fail-stop this manager when a committed canonical result cannot be interpreted safely. */
	retireConversationAuthority(cause: Error): SessionConversationStateUnavailableError {
		return this._requireConversationReconciliation(cause);
	}

	private _requireConversationReconciliation(cause: Error): SessionConversationStateUnavailableError {
		if (this.conversationAuthorityStatus.status === "reconciliation_required") {
			return this.conversationAuthorityStatus.error;
		}
		const status = {
			status: "reconciliation_required",
			error: new SessionConversationStateUnavailableError({ cause }),
		} as const;
		this.conversationAuthorityStatus = status;
		for (const listener of this.conversationAuthorityListeners) {
			try {
				listener(status);
			} catch {
				// Authority loss is sticky. Projection cleanup cannot roll it back.
			}
		}
		return status.error;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;
		const filePath = this.sessionFile;
		const appendEntry = () => {
			const content = `${JSON.stringify(entry)}\n`;
			this._enqueuePersistence(() =>
				serializeSessionFileOperation(filePath, () =>
					appendSessionFileEntry(filePath, content, isSessionDurabilityBoundary(entry)),
				),
			);
		};

		const hasFlushContent = this.fileEntries.some(isSessionFileFlushContent);
		if (!hasFlushContent) {
			if ((entry.type === "fast_mode_change" || entry.type === "planning_state_change") && !this.flushed) {
				this._createFile();
				this.flushed = true;
			} else if (this.flushed) {
				appendEntry();
			} else {
				// Keep the session virtual until content with an explicit materialization
				// contract arrives.
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			this._createFile();
			this.flushed = true;
		} else {
			appendEntry();
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		if (this.atomicAppendInFlight && !this.atomicAppendEntries) {
			throw new Error("An atomic session append is already in progress");
		}
		this._assertPersistenceHealthy();
		const canonicalEntry = cloneCanonicalData(entry, `Session ${entry.type} entry`);
		if (this.sessionFileNeedsMigration && !this.atomicAppendEntries) {
			// Rewriting is a writer action. Deferring it until the first append keeps
			// every discovery/open path content-read-only. Queueing it before the
			// append preserves commit order without blocking the caller.
			this._rewriteFile();
			this.flushed = true;
		}
		canonicalEntry.ordinal = this.nextOrdinal++;
		this.fileEntries.push(canonicalEntry);
		this.byId.set(canonicalEntry.id, canonicalEntry);
		if (canonicalEntry.type === "leaf" || !isHostOnlySessionEntry(canonicalEntry)) this.canonicalRevision++;
		if (canonicalEntry.type === "leaf") {
			this.leafId = canonicalEntry.targetId;
		} else if (!isHostOnlySessionEntry(canonicalEntry)) {
			this.leafId = canonicalEntry.id;
		}
		if (!this.atomicAppendEntries) {
			this._persist(canonicalEntry);
		}
		this._indexClientInputEntry(canonicalEntry);
		if (this.atomicAppendEntries) {
			this.atomicAppendEntries.push(canonicalEntry);
			return;
		}
		this._notifyEntryListeners(canonicalEntry);
	}

	private _notifyEntryListeners(entry: SessionEntry): void {
		if (isHostOnlySessionEntry(entry)) return;
		for (const listener of this.entryListeners) {
			try {
				listener(cloneCanonicalData(entry, `Session ${entry.type} observer entry`));
			} catch {
				// Persistence is authoritative. A projection observer cannot make a
				// successfully appended entry appear to have failed.
			}
		}
	}

	private _captureCanonicalProjection(): SessionCanonicalProjection {
		const token = Object.freeze({ tokenId: randomUUID() });
		const entries = deepFreezeCanonicalData(cloneCanonicalData(this.getBranch(), "Session canonical projection"));
		const projection = Object.freeze({
			token,
			leafId: this.leafId,
			revision: this.canonicalRevision,
			entries,
		});
		this.canonicalProjectionTokens.set(token, projection);
		return projection;
	}

	private _cloneCanonicalProjection(projection: SessionCanonicalProjection): SessionCanonicalProjection {
		return Object.freeze({
			token: projection.token,
			leafId: projection.leafId,
			revision: projection.revision,
			entries: deepFreezeCanonicalData(
				cloneCanonicalData([...projection.entries], "Detached session canonical projection"),
			),
		});
	}

	/** Issue an identity-authenticated raw projection guard for a later canonical command. */
	issueCanonicalProjection(): SessionCanonicalProjection {
		this.assertConversationAuthorityAvailable();
		if (this.atomicAppendInFlight) {
			throw new Error("Cannot issue a canonical projection while an atomic operation is in progress");
		}
		return this._cloneCanonicalProjection(this._captureCanonicalProjection());
	}

	private _appendCanonicalEntry(entry: SessionCanonicalAppend): string {
		switch (entry.type) {
			case "message":
				if (entry.message.role === "branchSummary" || entry.message.role === "compactionSummary") {
					throw new Error(`${entry.message.role} messages require their canonical session entry type`);
				}
				return this.appendMessage(entry.message);
			case "thinking_level_change":
				return this.appendThinkingLevelChange(entry.thinkingLevel);
			case "model_change":
				return this.appendModelChange(entry.provider, entry.modelId);
			case "planning_state_change":
				return this.appendPlanningState(entry.planning);
			case "compaction":
				return this.appendCompaction(
					entry.summary,
					entry.firstKeptEntryId,
					entry.tokensBefore,
					entry.details,
					entry.fromHook,
				);
			case "branch_summary":
				return this.branchWithSummary(entry.fromId, entry.summary, entry.details, entry.fromHook);
			case "custom":
				return this.appendCustomEntry(entry.customType, entry.data);
			case "custom_message":
				return this.appendCustomMessageEntry(
					entry.customType,
					typeof entry.content === "string" ? entry.content : [...entry.content],
					entry.display,
					entry.details,
				);
			case "label":
				return this.appendLabelChange(entry.targetId, entry.label);
			case "session_info":
				return this.appendSessionInfo(entry.name ?? "");
		}
	}

	/**
	 * Validate a manager-issued guard, apply normalized mutations, and capture
	 * immutable evidence entirely inside the manager's serialized append lane.
	 */
	async commitCanonicalCommand(command: SessionCanonicalCommand): Promise<SessionCanonicalCommitEvidence> {
		this._assertPersistenceHealthy();
		const basis = this.canonicalProjectionTokens.get(command.guard.token);
		if (!basis)
			throw new SessionCanonicalConflictError("Canonical projection guard was not issued by this SessionManager");
		const mutations = cloneCanonicalData([...command.mutations], "Session canonical mutations");
		let before: SessionCanonicalProjection | undefined;
		let after: SessionCanonicalProjection | undefined;
		let appendedEntryIds: readonly string[] = [];
		await this.appendAtomically(
			() => {
				const firstAppendedIndex = this.fileEntries.length;
				for (const mutation of mutations) {
					if (mutation.kind === "move") {
						if (mutation.leafId === null) this.resetLeaf();
						else this.branch(mutation.leafId);
					} else if (mutation.kind === "move_with_summary") {
						if (mutation.summary === undefined) {
							if (mutation.leafId === null) this.resetLeaf();
							else this.branch(mutation.leafId);
						} else {
							const summaryId = this.branchWithSummary(
								mutation.leafId,
								mutation.summary.summary,
								mutation.summary.details,
								mutation.summary.fromHook,
							);
							if (mutation.summary.label !== undefined) {
								this.appendLabelChange(summaryId, mutation.summary.label);
							}
						}
					} else {
						this._appendCanonicalEntry(mutation.entry);
					}
				}
				appendedEntryIds = Object.freeze(this.fileEntries.slice(firstAppendedIndex).map((entry) => entry.id));
				after = this._captureCanonicalProjection();
			},
			() => {},
			() => {
				before = this._captureCanonicalProjection();
				const exactMatch =
					basis.revision === before.revision &&
					basis.leafId === before.leafId &&
					basis.entries.length === before.entries.length &&
					basis.entries.every((entry, index) => entry.id === before!.entries[index]?.id);
				const guardMatches =
					command.guard.kind === "exact"
						? exactMatch
						: basis.leafId === null || before.entries.some((entry) => entry.id === basis.leafId);
				if (!guardMatches)
					throw new SessionCanonicalConflictError("Canonical branch changed before mutation commit");
			},
		);
		if (!before || !after) throw new Error("Canonical command did not capture commit evidence");
		return Object.freeze({
			before: this._cloneCanonicalProjection(before),
			after: this._cloneCanonicalProjection(after),
			appendedEntryIds,
		});
	}

	/**
	 * Stage synchronous append operations and publish them only after one atomic
	 * filesystem replacement settles. Existing append methods remain the sole
	 * entry mapping and validation path.
	 */
	private async appendAtomically(
		append: () => void,
		beforePublish: () => void,
		beforeStage: () => void = () => {},
	): Promise<void> {
		this._assertPersistenceHealthy();
		if (this.atomicAppendEntries || this.atomicAppendInFlight) {
			throw new Error("Nested atomic session appends are not supported");
		}
		this.atomicAppendInFlight = true;
		try {
			await this.persistenceWatermark;
			this._assertPersistenceHealthy();
		} catch (error) {
			this.atomicAppendInFlight = false;
			throw error;
		}
		const snapshot = {
			fileEntries: [...this.fileEntries],
			byId: new Map(this.byId),
			labelsById: new Map(this.labelsById),
			labelTimestampsById: new Map(this.labelTimestampsById),
			clientInputsById: new Map(
				[...this.clientInputsById].map(([id, record]) => [id, cloneClientInputRecord(record)]),
			),
			leafId: this.leafId,
			nextOrdinal: this.nextOrdinal,
			canonicalRevision: this.canonicalRevision,
			flushed: this.flushed,
			sessionFileNeedsMigration: this.sessionFileNeedsMigration,
		};
		const restore = (): void => {
			this.fileEntries = snapshot.fileEntries;
			this.byId = snapshot.byId;
			this.labelsById = snapshot.labelsById;
			this.labelTimestampsById = snapshot.labelTimestampsById;
			this.clientInputsById = snapshot.clientInputsById;
			this.leafId = snapshot.leafId;
			this.nextOrdinal = snapshot.nextOrdinal;
			this.canonicalRevision = snapshot.canonicalRevision;
			this.flushed = snapshot.flushed;
			this.sessionFileNeedsMigration = snapshot.sessionFileNeedsMigration;
		};
		try {
			beforeStage();
		} catch (error) {
			this.atomicAppendInFlight = false;
			if (error instanceof SessionCanonicalConflictError || error instanceof SessionAtomicAppendError) {
				throw error;
			}
			throw new SessionAtomicAppendError(
				error instanceof Error ? error.message : String(error),
				"not_started",
				"available",
				{ cause: error },
			);
		}
		const entries: SessionEntry[] = [];
		this.atomicAppendEntries = entries;
		try {
			append();
		} catch (error) {
			this.atomicAppendEntries = undefined;
			this.atomicAppendInFlight = false;
			restore();
			throw new SessionAtomicAppendError(
				error instanceof Error ? error.message : String(error),
				"rolled_back",
				"available",
				{ cause: error },
			);
		}

		const staged = {
			fileEntries: this.fileEntries,
			byId: this.byId,
			labelsById: this.labelsById,
			labelTimestampsById: this.labelTimestampsById,
			clientInputsById: this.clientInputsById,
			leafId: this.leafId,
			nextOrdinal: this.nextOrdinal,
			canonicalRevision: this.canonicalRevision,
		};
		let content: Buffer;
		try {
			content = Buffer.from(this._serializeFileEntries(), "utf8");
		} catch (error) {
			this.atomicAppendEntries = undefined;
			this.atomicAppendInFlight = false;
			restore();
			throw error;
		}
		const shouldPersist =
			entries.length > 0 &&
			this.persist &&
			this.sessionFile !== undefined &&
			(snapshot.flushed || staged.fileEntries.some(isSessionFileFlushContent));
		this.atomicAppendEntries = undefined;
		restore();

		try {
			if (shouldPersist) {
				const filePath = this.sessionFile!;
				const task = this.persistenceQueue.then(async () => {
					if (this.persistenceError) throw this.persistenceError;
					await serializeSessionFileOperation(filePath, async () => {
						let preimage: Buffer | undefined;
						try {
							preimage = existsSync(filePath) ? readFileSync(filePath) : undefined;
						} catch (error) {
							throw new AtomicAppendPersistenceFailure(
								"Could not verify atomic append preimage",
								"not_started",
								"reconciliation_required",
								{ cause: error },
							);
						}
						if (snapshot.flushed !== (preimage !== undefined)) {
							throw new AtomicAppendPersistenceFailure(
								"Session file presence changed before the atomic append could begin",
								"not_started",
								"reconciliation_required",
							);
						}
						if (preimage !== undefined) {
							let persistedEntries: FileEntry[];
							try {
								persistedEntries = parseAtomicSessionPreimage(preimage);
							} catch (error) {
								throw new AtomicAppendPersistenceFailure(
									error instanceof Error ? error.message : "Could not parse atomic append preimage",
									"not_started",
									"reconciliation_required",
									{ cause: error },
								);
							}
							const persistedHeader = persistedEntries.find((entry) => entry.type === "session");
							if (persistedHeader?.version !== CURRENT_SESSION_VERSION) {
								try {
									migrateToCurrentVersion(persistedEntries);
								} catch (error) {
									throw new AtomicAppendPersistenceFailure(
										error instanceof Error ? error.message : "Could not validate atomic append schema",
										"not_started",
										"reconciliation_required",
										{ cause: error },
									);
								}
								if (
									this._serializeFileEntries(persistedEntries) !==
									this._serializeFileEntries(snapshot.fileEntries)
								) {
									throw new AtomicAppendPersistenceFailure(
										"Session changed before the atomic append could begin",
										"not_started",
										"reconciliation_required",
									);
								}
								throw new AtomicAppendPersistenceFailure(
									"Atomic append requires the current session schema",
									"not_started",
									"available",
								);
							}
							if (
								this._serializeFileEntries(persistedEntries) !==
								this._serializeFileEntries(snapshot.fileEntries)
							) {
								throw new AtomicAppendPersistenceFailure(
									"Session changed before the atomic append could begin",
									"not_started",
									"reconciliation_required",
								);
							}
						}
						try {
							await writeDurableAtomicFile(filePath, content, {
								directoryMode: PRIVATE_DIRECTORY_MODE,
								fileMode: PRIVATE_FILE_MODE,
							});
						} catch (error) {
							let visible: Buffer | undefined;
							try {
								visible = existsSync(filePath) ? readFileSync(filePath) : undefined;
							} catch (visibilityError) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append visibility is uncertain",
									"uncertain",
									"reconciliation_required",
									{ cause: visibilityError },
								);
							}
							if (exactOptionalBytesEqual(visible, preimage)) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append was rolled back",
									"rolled_back",
									"available",
									{ cause: error },
								);
							}
							if (!exactOptionalBytesEqual(visible, content)) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append visibility is uncertain",
									"uncertain",
									"reconciliation_required",
									{ cause: error },
								);
							}
							try {
								await syncDurableFile(filePath);
							} catch (syncError) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append durability is uncertain",
									"uncertain",
									"reconciliation_required",
									{ cause: syncError },
								);
							}
							let durableVisible: Buffer;
							try {
								durableVisible = readFileSync(filePath);
							} catch (visibilityError) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append visibility is uncertain",
									"uncertain",
									"reconciliation_required",
									{ cause: visibilityError },
								);
							}
							if (!durableVisible.equals(content)) {
								throw new AtomicAppendPersistenceFailure(
									"Atomic append visibility changed after durability proof",
									"uncertain",
									"reconciliation_required",
								);
							}
						}
					});
				});
				this.persistenceQueue = task.catch(() => {});
				this.persistenceWatermark = task;
				await task;
			}
		} catch (error) {
			this.atomicAppendInFlight = false;
			const failure =
				error instanceof AtomicAppendPersistenceFailure
					? error
					: new AtomicAppendPersistenceFailure(
							error instanceof Error ? error.message : String(error),
							"uncertain",
							"reconciliation_required",
							{ cause: error },
						);
			if (failure.effect === "uncertain") {
				this.persistenceError ??= failure;
			} else {
				this.persistenceWatermark = this.persistenceQueue;
			}
			if (failure.authority === "reconciliation_required") {
				this._requireConversationReconciliation(failure);
			}
			throw new SessionAtomicAppendError(failure.message, failure.effect, failure.authority, { cause: failure });
		}

		this.fileEntries = staged.fileEntries;
		this.byId = staged.byId;
		this.labelsById = staged.labelsById;
		this.labelTimestampsById = staged.labelTimestampsById;
		this.clientInputsById = staged.clientInputsById;
		this.leafId = staged.leafId;
		this.nextOrdinal = staged.nextOrdinal;
		this.canonicalRevision = staged.canonicalRevision;
		this.flushed = shouldPersist || snapshot.flushed;
		this.sessionFileNeedsMigration = false;
		try {
			beforePublish();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const committedFailure = new SessionAtomicAppendError(message, "committed", "reconciliation_required", {
				cause: error,
			});
			this._requireConversationReconciliation(committedFailure);
			throw committedFailure;
		} finally {
			try {
				for (const entry of entries) this._notifyEntryListeners(entry);
				if (snapshot.leafId !== staged.leafId) {
					this._notifyBranchListeners(snapshot.leafId, staged.leafId);
				}
			} finally {
				this.atomicAppendInFlight = false;
			}
		}
	}

	/**
	 * Commit a provider-visible delivery and its host-only receipt transitions in
	 * one local transaction. Volatile queue/UI publication deliberately happens
	 * after this method returns.
	 */
	async commitDelivery(input: SessionDeliveryCommitInput): Promise<SessionDeliveryCommitReceipt> {
		this._assertPersistenceHealthy();
		const messages = cloneCanonicalData([...input.messages], "Session delivery messages");
		const planning = input.planning === undefined ? undefined : parsePlanningState(input.planning);
		let beforeProjection: SessionCanonicalProjection | undefined;
		let afterProjection: SessionCanonicalProjection | undefined;
		const entryIds: string[] = [];
		const clientMessageIds: string[] = [];

		await this.appendAtomically(
			() => {
				for (const message of messages) {
					if (message.role !== "user" || message.clientMessageId === undefined) continue;
					const record = this.clientInputsById.get(message.clientMessageId);
					if (record?.state === "accepted") {
						this.transitionClientInput(message.clientMessageId, "started");
						const stateEntry = this.fileEntries.at(-1);
						if (!stateEntry || stateEntry.type !== "client_input_state") {
							throw new Error("Client input start transition was not staged");
						}
						entryIds.push(stateEntry.id);
					}
					clientMessageIds.push(message.clientMessageId);
				}
				if (planning !== undefined) {
					entryIds.push(this.appendPlanningState(planning));
				}
				for (const message of messages) {
					if (message.role === "custom") {
						entryIds.push(
							this.appendCustomMessageEntry(
								message.customType,
								message.content,
								message.display,
								message.details,
								message.timestamp,
							),
						);
					} else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
						entryIds.push(this.appendMessage(message));
					} else {
						throw new Error(`Unsupported delivery message role: ${String(message.role)}`);
					}
				}
				afterProjection = this._captureCanonicalProjection();
			},
			() => {},
			() => {
				beforeProjection = this._captureCanonicalProjection();
			},
		);
		if (!beforeProjection || !afterProjection) throw new Error("Atomic delivery commit did not capture evidence");
		const receipt = Object.freeze({ receiptId: randomUUID() });
		this.deliveryCommitReceipts.set(
			receipt,
			Object.freeze({
				outcome: "committed" as const,
				deliveryId: input.deliveryId,
				epoch: input.epoch,
				attemptId: input.attemptId,
				sessionId: this.sessionId,
				beforeLeafId: beforeProjection.leafId,
				afterLeafId: afterProjection.leafId,
				revision: afterProjection.revision,
				beforeProjection,
				afterProjection,
				entryIds: Object.freeze([...entryIds]),
				messages: Object.freeze(cloneCanonicalData(messages, "Committed session delivery messages")),
				clientMessageIds: Object.freeze([...new Set(clientMessageIds)]),
				...(planning === undefined ? {} : { planning: clonePlanningState(planning) }),
			}),
		);
		return receipt;
	}

	/** Attest no effect at a serialized authority point without rewriting persistence. */
	async attestDeliveryNoEffect(identity: SessionDeliveryAttemptIdentity): Promise<SessionDeliveryCommitReceipt> {
		this._assertPersistenceHealthy();
		if (this.atomicAppendInFlight) throw new Error("Another atomic session operation is already in progress");
		this.atomicAppendInFlight = true;
		try {
			await this.persistenceWatermark;
			this._assertPersistenceHealthy();
		} catch (error) {
			this.atomicAppendInFlight = false;
			throw error;
		}
		try {
			const projection = this._captureCanonicalProjection();
			const receipt = Object.freeze({ receiptId: randomUUID() });
			this.deliveryCommitReceipts.set(
				receipt,
				Object.freeze({
					outcome: "no_effect",
					...identity,
					sessionId: this.sessionId,
					beforeLeafId: projection.leafId,
					afterLeafId: projection.leafId,
					revision: projection.revision,
					beforeProjection: projection,
					afterProjection: projection,
				}),
			);
			return receipt;
		} finally {
			this.atomicAppendInFlight = false;
		}
	}

	/** Roll delivery WAL state back while proving provider-visible context did not change. */
	async retainDelivery(
		identity: SessionDeliveryAttemptIdentity,
		messages: readonly AgentMessage[],
	): Promise<SessionDeliveryCommitReceipt> {
		const canonicalMessages = cloneCanonicalData([...messages], "Retained delivery messages");
		let beforeProjection: SessionCanonicalProjection | undefined;
		let afterProjection: SessionCanonicalProjection | undefined;
		await this.appendAtomically(
			() => {
				for (const message of canonicalMessages) {
					if (message.role !== "user" || message.clientMessageId === undefined) continue;
					if (this.getClientInput(message.clientMessageId)?.state === "started") {
						this.rollbackClientInput(message.clientMessageId);
					}
				}
				afterProjection = this._captureCanonicalProjection();
			},
			() => {},
			() => {
				beforeProjection = this._captureCanonicalProjection();
			},
		);
		if (!beforeProjection || !afterProjection) throw new Error("Retained delivery did not capture evidence");
		const beforeIds = beforeProjection.entries.map((entry) => entry.id);
		const afterIds = afterProjection.entries.map((entry) => entry.id);
		if (
			beforeProjection.leafId !== afterProjection.leafId ||
			beforeIds.length !== afterIds.length ||
			beforeIds.some((id, index) => id !== afterIds[index])
		) {
			throw new Error("Retaining delivery changed provider-visible context");
		}
		const receipt = Object.freeze({ receiptId: randomUUID() });
		this.deliveryCommitReceipts.set(
			receipt,
			Object.freeze({
				outcome: "no_effect",
				...identity,
				sessionId: this.sessionId,
				beforeLeafId: beforeProjection.leafId,
				afterLeafId: afterProjection.leafId,
				revision: afterProjection.revision,
				beforeProjection,
				afterProjection,
			}),
		);
		return receipt;
	}

	/**
	 * Consume client-input WAL ownership after a delivery failure whose provider
	 * effect cannot be replayed safely. This command is deliberately independent
	 * of volatile owner finalization so a restart cannot recover terminal work.
	 */
	async terminalizeDelivery(messages: readonly AgentMessage[], error: Error): Promise<void> {
		const canonicalMessages = cloneCanonicalData([...messages], "Terminal delivery messages");
		await this.appendAtomically(
			() => {
				const clientMessageIds = new Set(
					canonicalMessages.flatMap((message) =>
						message.role === "user" && message.clientMessageId !== undefined ? [message.clientMessageId] : [],
					),
				);
				for (const clientMessageId of clientMessageIds) {
					const record = this.getClientInput(clientMessageId);
					if (record?.state === "accepted" || record?.state === "started") {
						this.transitionClientInput(clientMessageId, "failed", error.message);
					}
				}
			},
			() => {},
		);
	}

	/** Verify that a delivery receipt was issued by this live manager instance. */
	verifyDeliveryReceipt(receipt: unknown): VerifiedSessionDeliveryReceipt | undefined {
		if (typeof receipt !== "object" || receipt === null) return undefined;
		const verified = this.deliveryCommitReceipts.get(receipt as SessionDeliveryCommitReceipt);
		if (!verified) return undefined;
		if (verified.outcome === "no_effect") {
			return {
				...verified,
				beforeProjection: this._cloneCanonicalProjection(verified.beforeProjection),
				afterProjection: this._cloneCanonicalProjection(verified.afterProjection),
			};
		}
		return {
			...verified,
			beforeProjection: this._cloneCanonicalProjection(verified.beforeProjection),
			afterProjection: this._cloneCanonicalProjection(verified.afterProjection),
			entryIds: [...verified.entryIds],
			messages: cloneCanonicalData([...verified.messages], "Verified session delivery messages"),
			clientMessageIds: [...verified.clientMessageIds],
			...(verified.planning === undefined ? {} : { planning: clonePlanningState(verified.planning) }),
		};
	}

	private _assertPersistenceHealthy(): void {
		this.assertConversationAuthorityAvailable();
		if (this.persistenceClosed) {
			throw new Error("Session persistence is closed");
		}
		if (!this.persistenceError) return;
		throw new Error(
			"Session persistence is fail-stopped after an uncertain write; reload the session before retrying",
			{ cause: this.persistenceError },
		);
	}

	/** Explicitly materialize the current canonical session and wait for its durability boundary. */
	async materialize(): Promise<void> {
		this._assertPersistenceHealthy();
		if (this.atomicAppendEntries || this.atomicAppendInFlight) {
			throw new Error("Cannot materialize a session during an atomic append");
		}
		if (!this.persist || !this.sessionFile) return;

		const filePath = this.sessionFile;
		if (!this.flushed) {
			this._createFile();
			this.flushed = true;
		} else {
			this._enqueuePersistence(() => serializeSessionFileOperation(filePath, () => syncDurableFile(filePath)));
		}
		await this.persistenceWatermark;
	}

	/** Wait for every filesystem operation accepted before this call. */
	flush(): Promise<void> {
		return this.persistenceWatermark;
	}

	/** Seal persistence and classify only this manager's recorded reconciliation failure. */
	async drainPersistence(): Promise<SessionPersistenceDrainResult> {
		if (this.persist) {
			this.persistenceClosed = true;
		}
		try {
			await this.flush();
		} catch (error) {
			const authority = this.conversationAuthorityStatus;
			if (authority.status === "reconciliation_required" && authority.error.cause === error) {
				return { status: "reconciliation_required", error: authority.error };
			}
			throw error;
		}
		const authority = this.conversationAuthorityStatus;
		return authority.status === "reconciliation_required"
			? { status: "reconciliation_required", error: authority.error }
			: { status: "closed" };
	}

	/** Seal a persisted manager against later writes and reject on every failed watermark. */
	async closePersistence(): Promise<void> {
		const result = await this.drainPersistence();
		if (result.status === "reconciliation_required") {
			throw result.error.cause instanceof Error ? result.error.cause : result.error;
		}
	}

	private _indexClientInputEntry(entry: SessionEntry): void {
		if (entry.type === "client_input_receipt") {
			assertClientMessageId(entry.clientMessageId);
			if (entry.command !== "prompt" && entry.command !== "steer" && entry.command !== "follow_up") {
				throw new Error(`Client input receipt ${entry.id} has an invalid command`);
			}
			const input = normalizeClientInputPayload(entry.command, entry.input);
			if (entry.semanticDigest !== digestClientInputPayload(entry.command, input)) {
				throw new Error(`Client input receipt ${entry.id} has a mismatched semantic digest`);
			}
			const existing = this.clientInputsById.get(entry.clientMessageId);
			if (!existing) {
				assertClientInputOutstandingCount(this.clientInputsById.values(), 1);
				assertClientInputOutstandingBudget(this.clientInputsById.values(), measureClientInputPayloadBytes(input));
				this.clientInputsById.set(entry.clientMessageId, {
					receiptId: entry.id,
					clientMessageId: entry.clientMessageId,
					command: entry.command,
					semanticDigest: entry.semanticDigest,
					input,
					state: "accepted",
				});
			} else if (existing.command !== entry.command || existing.semanticDigest !== entry.semanticDigest) {
				throw new Error(
					`Client input id ${JSON.stringify(entry.clientMessageId)} has conflicting durable receipts`,
				);
			}
			return;
		}

		if (entry.type === "client_input_queued") {
			assertClientMessageId(entry.clientMessageId);
			const record = this.clientInputsById.get(entry.clientMessageId);
			if (!record || record.receiptId !== entry.receiptId) {
				throw new Error(`Queued client input ${entry.id} has no matching receipt`);
			}
			if (record.state !== "accepted" && record.state !== "started") {
				throw new Error(`Queued client input ${entry.id} was persisted after dispatch started`);
			}
			const queuedInput = normalizeClientInputQueuedPayload(entry.queuedInput);
			if (queuedInput.delivery !== getExpectedClientInputQueuedDelivery(record)) {
				throw new Error(`Queued client input ${entry.id} conflicts with its requested delivery`);
			}
			if (record.queuedInput && JSON.stringify(record.queuedInput) !== JSON.stringify(queuedInput)) {
				throw new Error(`Client input id ${JSON.stringify(entry.clientMessageId)} has conflicting queued payloads`);
			}
			if (
				!record.queuedInput &&
				getRecoverableQueuedClientInputCount(this.clientInputsById.values()) >=
					CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES
			) {
				throw new Error(
					`Recoverable client input queue exceeds ${CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES} entries`,
				);
			}
			if (!record.queuedInput) {
				assertClientInputOutstandingBudget(
					this.clientInputsById.values(),
					measureClientInputPayloadBytes(queuedInput),
				);
			}
			record.queuedEntryId ??= entry.id;
			record.queuedInput = queuedInput;
			// A queued payload is the durable output of preflight/input hooks. Once it
			// commits, replay consumes this exact payload without re-running those
			// side effects, so the receipt is recoverable again.
			record.state = "accepted";
			record.error = undefined;
			return;
		}

		if (entry.type === "client_input_state") {
			assertClientMessageId(entry.clientMessageId);
			if (
				entry.state !== "accepted" &&
				entry.state !== "started" &&
				entry.state !== "completed" &&
				entry.state !== "failed"
			) {
				throw new Error(`Client input state ${entry.id} has an invalid state`);
			}
			if (
				(entry.error !== undefined && typeof entry.error !== "string") ||
				(entry.state !== "failed" && entry.error !== undefined) ||
				(typeof entry.error === "string" && Array.from(entry.error).length > CLIENT_INPUT_ERROR_MAX_SCALARS)
			) {
				throw new Error(`Client input state ${entry.id} has an invalid error`);
			}
			const record = this.clientInputsById.get(entry.clientMessageId);
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

		if (entry.type !== "message" || entry.message.role !== "user") {
			return;
		}
		const clientMessageId = (entry.message as { clientMessageId?: unknown }).clientMessageId;
		if (clientMessageId === undefined) {
			return;
		}
		if (typeof clientMessageId !== "string") {
			throw new Error(`Canonical client input ${entry.id} has an invalid client identity`);
		}
		const record = requireStartedClientInputReceipt(this.clientInputsById, clientMessageId);
		record.state = "completed";
		record.error = undefined;
		record.canonicalEntryId = entry.id;
	}

	getClientInput(clientMessageId: string): ClientInputRecord | undefined {
		this.assertConversationAuthorityAvailable();
		const record = this.clientInputsById.get(clientMessageId);
		return record ? cloneClientInputRecord(record) : undefined;
	}

	getClientInputRecoveryPlan(): ClientInputRecoveryPlan {
		this.assertConversationAuthorityAvailable();
		const commitOrdinal = (record: ClientInputRecord): number => {
			const admissionEntry = record.queuedEntryId
				? this.byId.get(record.queuedEntryId)
				: this.byId.get(record.receiptId);
			return admissionEntry?.ordinal ?? Number.MAX_SAFE_INTEGER;
		};
		const records = Array.from(this.clientInputsById.values())
			.filter((record) => record.state === "accepted" && record.queuedInput !== undefined)
			.sort((a, b) => commitOrdinal(a) - commitOrdinal(b))
			.map(cloneClientInputRecord);
		const blocker = Array.from(this.clientInputsById.values())
			.filter((record) => record.state === "started")
			.sort((a, b) => commitOrdinal(a) - commitOrdinal(b))[0];
		if (blocker) {
			return { kind: "blocked", records, blocker: cloneClientInputRecord(blocker) };
		}
		return records.length > 0 ? { kind: "replay", records } : { kind: "idle", records: [] };
	}

	getRecoverableQueuedClientInputs(): ClientInputRecord[] {
		return this.getClientInputRecoveryPlan().records;
	}

	reserveClientInput(
		clientMessageId: string,
		command: ClientInputCommand,
		inputValue: ClientInputPayloadInput,
	): ClientInputReservation {
		this._assertPersistenceHealthy();
		assertClientMessageId(clientMessageId);
		const input = normalizeClientInputPayload(command, inputValue);
		const semanticDigest = digestClientInputPayload(command, input);
		const existing = this.clientInputsById.get(clientMessageId);
		if (existing) {
			return { record: cloneClientInputRecord(existing), created: false };
		}
		assertClientInputOutstandingCount(this.clientInputsById.values(), 1);
		assertClientInputOutstandingBudget(this.clientInputsById.values(), measureClientInputPayloadBytes(input));
		const entry: ClientInputReceiptEntry = {
			type: "client_input_receipt",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			clientMessageId,
			command,
			semanticDigest,
			input,
		};
		this._appendEntry(entry);
		const record = this.clientInputsById.get(clientMessageId);
		if (!record) {
			throw new Error("Client input receipt was not indexed after persistence");
		}
		return { record: cloneClientInputRecord(record), created: true };
	}

	markClientInputQueued(clientMessageId: string, queuedInputValue: ClientInputQueuedPayloadInput): ClientInputRecord {
		this._assertPersistenceHealthy();
		const record = this.clientInputsById.get(clientMessageId);
		if (!record) {
			throw new Error(`Client input receipt not found: ${clientMessageId}`);
		}
		if (record.state !== "accepted" && record.state !== "started") {
			throw new Error(`Client input ${JSON.stringify(clientMessageId)} cannot be queued from ${record.state}`);
		}
		const queuedInput = normalizeClientInputQueuedPayload(queuedInputValue);
		if (queuedInput.delivery !== getExpectedClientInputQueuedDelivery(record)) {
			throw new Error(`Client input ${JSON.stringify(clientMessageId)} conflicts with its requested delivery`);
		}
		if (record.queuedInput) {
			if (JSON.stringify(record.queuedInput) !== JSON.stringify(queuedInput)) {
				throw new Error(`Client input ${JSON.stringify(clientMessageId)} has a conflicting queued payload`);
			}
			return cloneClientInputRecord(record);
		}
		assertClientInputOutstandingBudget(this.clientInputsById.values(), measureClientInputPayloadBytes(queuedInput));
		if (
			getRecoverableQueuedClientInputCount(this.clientInputsById.values()) >=
			CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES
		) {
			throw new Error(
				`Recoverable client input queue exceeds ${CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES} entries`,
			);
		}
		const entry: ClientInputQueuedEntry = {
			type: "client_input_queued",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			receiptId: record.receiptId,
			clientMessageId,
			queuedInput,
		};
		this._appendEntry(entry);
		return cloneClientInputRecord(this.clientInputsById.get(clientMessageId)!);
	}

	rollbackClientInput(clientMessageId: string): ClientInputRecord {
		this._assertPersistenceHealthy();
		const record = this.clientInputsById.get(clientMessageId);
		if (!record) {
			throw new Error(`Client input receipt not found: ${clientMessageId}`);
		}
		if (record.state !== "started") {
			return cloneClientInputRecord(record);
		}
		const entry: ClientInputStateEntry = {
			type: "client_input_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			receiptId: record.receiptId,
			clientMessageId,
			state: "accepted",
		};
		this._appendEntry(entry);
		return cloneClientInputRecord(this.clientInputsById.get(clientMessageId)!);
	}

	transitionClientInput(
		clientMessageId: string,
		state: Exclude<ClientInputState, "accepted">,
		error?: string,
	): ClientInputRecord {
		this._assertPersistenceHealthy();
		const record = this.clientInputsById.get(clientMessageId);
		if (!record) {
			throw new Error(`Client input receipt not found: ${clientMessageId}`);
		}
		if (record.state === "completed" || record.state === "failed") {
			return cloneClientInputRecord(record);
		}
		if (state === "started" && record.state !== "accepted") {
			return cloneClientInputRecord(record);
		}
		const entry: ClientInputStateEntry = {
			type: "client_input_state",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			receiptId: record.receiptId,
			clientMessageId,
			state,
			...(state === "failed" && error !== undefined ? { error: boundClientInputError(error) } : {}),
		};
		this._appendEntry(entry);
		return cloneClientInputRecord(this.clientInputsById.get(clientMessageId)!);
	}

	/**
	 * Observe public conversation entries after they are indexed and accepted
	 * into the ordered persistence lane. Host-only sidecar records (admission
	 * WAL, subagent spawn edges) are intentionally excluded. The callback runs
	 * synchronously at the in-memory
	 * commit boundary so ordered projections stay in the same causal lane as live
	 * events; callers that require disk durability must await flush().
	 */
	subscribeEntries(listener: SessionEntryListener): () => void {
		this.assertConversationAuthorityAvailable();
		this.entryListeners.add(listener);
		return () => {
			this.entryListeners.delete(listener);
		};
	}

	/**
	 * Observe the low-level active-leaf mutation before any later child append.
	 * This is not an Agent context commit boundary; consumers that require the
	 * rebuilt message state must observe AgentSession's conversation generation.
	 */
	subscribeBranchChanges(listener: SessionBranchListener): () => void {
		this.assertConversationAuthorityAvailable();
		this.branchListeners.add(listener);
		return () => {
			this.branchListeners.delete(listener);
		};
	}

	private _setBranchLeaf(nextLeafId: string | null): void {
		this.assertConversationAuthorityAvailable();
		if (this.atomicAppendInFlight && !this.atomicAppendEntries) {
			throw new Error("Cannot change session branches during an atomic append");
		}
		const previousLeafId = this.leafId;
		if (previousLeafId === nextLeafId) return;
		this._appendEntry({
			type: "leaf",
			id: generateId(this.byId),
			parentId: previousLeafId,
			timestamp: new Date().toISOString(),
			targetId: nextLeafId,
		});
		if (this.atomicAppendEntries) return;
		this._notifyBranchListeners(previousLeafId, nextLeafId);
	}

	private _notifyBranchListeners(previousLeafId: string | null, nextLeafId: string | null): void {
		for (const listener of this.branchListeners) {
			try {
				listener({ previousLeafId, nextLeafId });
			} catch {
				// Branch mutation remains authoritative if a projection observer fails.
			}
		}
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		this.assertConversationAuthorityAvailable();
		if (message.role === "user" && message.clientMessageId !== undefined) {
			requireStartedClientInputReceipt(this.clientInputsById, message.clientMessageId);
		}
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a Fast mode policy change as child of current leaf, then advance leaf. Returns entry id. */
	appendFastModeChange(enabled: boolean): string {
		const entry: FastModeChangeEntry = {
			type: "fast_mode_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			enabled,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append one validated atomic Plan mode snapshot as a child of the current leaf. */
	appendPlanningState(planning: PlanningState): string {
		const entry: PlanningStateChangeEntry = {
			type: "planning_state_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			planning: parsePlanningState(planning),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = JsonValue>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: JsonCompatibleInput<T>,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			...(details === undefined ? {} : { details: details as JsonValue }),
			...(fromHook === undefined ? {} : { fromHook }),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry<T = JsonValue>(customType: string, data?: JsonCompatibleInput<T>): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			...(data === undefined ? {} : { data: data as JsonValue }),
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Record the first completed Git scan for this newly created session.
	 * The expected id prevents a delayed scan from attaching to a replacement.
	 */
	recordStartingGitContext(expectedSessionId: string, gitContext: RpcGitContext | null): boolean {
		if (!Check(Type.Union([RpcGitContextSchema, Type.Null()]), gitContext)) {
			throw new Error("Cannot record invalid starting Git context metadata");
		}
		if (!this.acceptsStartingGitContext || this.sessionId !== expectedSessionId) {
			return false;
		}
		if (this.fileEntries.some((entry) => entry.type === "session_start_git_context")) {
			this.acceptsStartingGitContext = false;
			return false;
		}
		this._appendEntry({
			type: "session_start_git_context",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			gitContext,
		});
		this.acceptsStartingGitContext = false;
		return true;
	}

	getStartingGitContext(): RpcGitContext | null | undefined {
		const entry = this.fileEntries.find(
			(candidate): candidate is SessionStartGitContextEntry => candidate.type === "session_start_git_context",
		);
		return entry?.gitContext;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = JsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: JsonCompatibleInput<T>,
		timestamp?: number,
	): string {
		const entry: CustomMessageEntry = {
			type: "custom_message",
			customType,
			content,
			display,
			...(details === undefined ? {} : { details: details as JsonValue }),
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: timestamp === undefined ? new Date().toISOString() : new Date(timestamp).toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		this.assertConversationAuthorityAvailable();
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		const leafId = this.getLeafId();
		return leafId ? this.getEntry(leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		this.assertConversationAuthorityAvailable();
		const entry = this.byId.get(id);
		return entry && !isHostOnlySessionEntry(entry) ? entry : undefined;
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		if (!this.getEntry(parentId)) return [];
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId && !isHostOnlySessionEntry(entry)) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.getEntry(id) ? this.labelsById.get(id) : undefined;
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.getEntry(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			...(label === undefined ? {} : { label }),
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Record a durable spawn edge for a subagent child whose first prompt was
	 * accepted. Host metadata only: the entry never advances the branch leaf and
	 * is invisible to getEntries()/getBranch()/context building. Read back with
	 * getSubagentSpawnEntries() during registry hydration.
	 */
	appendSubagentSpawn(spawn: {
		toolCallId: string;
		subagentId: string;
		agent: string;
		childSessionId: string;
		childSessionFile?: string;
		requestKey: string;
	}): string {
		this._assertPersistenceHealthy();
		const entry: SubagentSpawnEntry = {
			type: "subagent_spawn",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			toolCallId: spawn.toolCallId,
			subagentId: spawn.subagentId,
			agent: spawn.agent,
			childSessionId: spawn.childSessionId,
			...(spawn.childSessionFile !== undefined ? { childSessionFile: spawn.childSessionFile } : {}),
			requestKey: spawn.requestKey,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** All durable spawn edges in file order, including edges recorded on other branches. */
	getSubagentSpawnEntries(): SubagentSpawnEntry[] {
		this.assertConversationAuthorityAvailable();
		return this.fileEntries.filter((entry): entry is SubagentSpawnEntry => entry.type === "subagent_spawn");
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all conversation entry types (messages, compaction, model changes, etc.)
	 * while traversing transparently across any host-only sidecar parents
	 * (admission WAL, subagent spawn edges).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.getLeafId();
		let current = startId ? this.getEntry(startId) : undefined;
		while (current) {
			if (!isHostOnlySessionEntry(current)) {
				path.push(current);
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path.reverse();
	}

	/**
	 * Return a bounded active-branch window without materializing the full path.
	 * The walk is newest-to-oldest with one final parent lookup to determine
	 * whether more history exists, then reverses only the bounded result.
	 */
	getBranchWindow(options: SessionBranchWindowOptions): SessionBranchWindow | undefined {
		this.assertConversationAuthorityAvailable();
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
			throw new Error("maxEntries must be a positive safe integer");
		}
		const lookbackEntries = options.lookbackEntries ?? 0;
		if (!Number.isSafeInteger(lookbackEntries) || lookbackEntries < 0) {
			throw new Error("lookbackEntries must be a non-negative safe integer");
		}
		if (options.maxEntries > Number.MAX_SAFE_INTEGER - lookbackEntries) {
			throw new Error("branch window size exceeds the safe integer range");
		}

		let current: SessionEntry | undefined;
		if (options.beforeEntryId !== undefined) {
			const before = this.getEntry(options.beforeEntryId);
			if (!before) return undefined;
			current = before.parentId ? this.byId.get(before.parentId) : undefined;
		} else {
			current = this.leafId ? this.byId.get(this.leafId) : undefined;
		}

		const reverseWindow: SessionEntry[] = [];
		const seen = new Set<string>();
		const capacity = options.maxEntries + lookbackEntries;
		while (current && reverseWindow.length < capacity) {
			if (seen.has(current.id)) {
				throw new Error("Session branch contains a parent cycle");
			}
			seen.add(current.id);
			if (!isHostOnlySessionEntry(current)) {
				reverseWindow.push(current);
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		while (current && isHostOnlySessionEntry(current)) {
			if (seen.has(current.id)) {
				throw new Error("Session branch contains a parent cycle");
			}
			seen.add(current.id);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const hasEarlier = current !== undefined;
		const visitedEntries = reverseWindow.length;
		reverseWindow.reverse();
		const entryStart = Math.max(0, reverseWindow.length - options.maxEntries);
		return {
			entries: reverseWindow.slice(entryStart),
			lookback: reverseWindow.slice(0, entryStart),
			hasEarlier,
			visitedEntries,
		};
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		this.assertConversationAuthorityAvailable();
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all conversation entries (excludes the header and host-only sidecar records).
	 * Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		this.assertConversationAuthorityAvailable();
		return this.fileEntries.filter(
			(entry): entry is SessionEntry => entry.type !== "session" && !isHostOnlySessionEntry(entry),
		);
	}

	/**
	 * Get the conversation as a tree. Returns a shallow defensive copy of public entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		// Admission WAL records share the JSONL for crash recovery but are not
		// conversation nodes and must never become blank/selectable tree rows.
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.getEntry(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this._setBranchLeaf(branchFromId);
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this._setBranchLeaf(null);
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary<T = JsonValue>(
		branchFromId: string | null,
		summary: string,
		details?: JsonCompatibleInput<T>,
		fromHook?: boolean,
	): string {
		if (branchFromId !== null && !this.getEntry(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const entry = cloneCanonicalData(
			{
				type: "branch_summary",
				id: generateId(this.byId),
				parentId: branchFromId,
				timestamp: new Date().toISOString(),
				fromId: branchFromId ?? "root",
				summary,
				...(details === undefined ? {} : { details: details as JsonValue }),
				...(fromHook === undefined ? {} : { fromHook }),
			} satisfies BranchSummaryEntry,
			"Session branch_summary entry",
		);
		this._assertPersistenceHealthy();
		this._setBranchLeaf(branchFromId);
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		if (this.atomicAppendInFlight) {
			throw new Error("Cannot create a branched session during an atomic append");
		}
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			pathWithoutLabels.push(withoutClientInputIdentity({ ...entry, parentId: pathParentId }));
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const parentSession = this.persist ? previousSessionFile : undefined;
		const origin = this.getHeader()?.origin;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			...(parentSession === undefined ? {} : { parentSession }),
			...(origin === undefined ? {} : { origin }),
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// Fast mode is recoverable by exact session ID even without visible
			// conversation content, so preserve that durable policy immediately.
			// Otherwise defer to _persist(), which creates the file once flush content
			// arrives, matching the newSession() contract and avoiding duplicate headers.
			const shouldWriteImmediately = this.fileEntries.some(
				(entry) =>
					isSessionFileFlushContent(entry) ||
					entry.type === "fast_mode_change" ||
					entry.type === "planning_state_change",
			);
			if (shouldWriteImmediately) {
				this._createFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.volt/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /clear or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		// An explicitly supplied session directory is a known private artifact
		// boundary. Harden it before parsing so a fail-closed corrupt session does
		// not leave sibling session artifacts exposed by permissive directory mode.
		// Do not chmod an implicitly derived parent, which may be a shared directory.
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		if (sessionDir !== undefined) {
			ensurePrivateDirectorySync(dir);
		}
		if (existsSync(resolvedPath)) {
			hardenPrivateRegularFileSync(resolvedPath);
		}
		// Extract cwd from session header if possible, otherwise use process.cwd()
		const entries = loadEntriesFromFile(resolvedPath);
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
		const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, sessionDir !== undefined);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.volt/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/**
	 * Strict daemon-only lookup for a reconnect target. Unlike user-facing
	 * selectors, this includes WAL-only sessions and fails closed when the target
	 * file is corrupt or when more than one file claims the same session id.
	 */
	static async findForResume(
		sessionDir: string,
		sessionId: string,
	): Promise<{ id: string; path: string } | undefined> {
		assertValidSessionId(sessionId);
		const dir = normalizePath(sessionDir);
		if (!existsSync(dir)) return undefined;
		ensurePrivateDirectorySync(dir, { hardenExisting: false });
		const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
		const matches: string[] = [];
		for (const filePath of files) {
			const header = readSessionHeader(filePath);
			const filenameClaimsTarget = basename(filePath).endsWith(`_${sessionId}.jsonl`);
			if (header?.id !== sessionId && !filenameClaimsTarget) continue;
			if (header?.id !== sessionId) {
				throw new Error(`Session file claiming ${sessionId} has an invalid header`);
			}
			// Full open validates every current-version WAL boundary and aggregate
			// resource invariant. Do not let listing's best-effort parser downgrade a
			// corrupt target to "missing".
			const manager = SessionManager.open(filePath, dir);
			if (manager.getSessionId() !== sessionId) {
				throw new Error(`Session file identity changed while opening ${sessionId}`);
			}
			matches.push(filePath);
		}
		if (matches.length > 1) {
			throw new Error(`Multiple session files claim ${sessionId}`);
		}
		return matches[0] ? { id: sessionId, path: matches[0] } : undefined;
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		if (existsSync(resolvedSourcePath)) {
			hardenPrivateRegularFileSync(resolvedSourcePath);
		}
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		ensurePrivateDirectorySync(dir);

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		const forkEntries = [
			newHeader,
			...sourceEntries
				.filter((entry): entry is SessionEntry => entry.type !== "session" && !isHostOnlySessionEntry(entry))
				.map(withoutClientInputIdentity),
		];
		writeDurableAtomicFileSync(newSessionFile, `${forkEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			directoryMode: PRIVATE_DIRECTORY_MODE,
			fileMode: PRIVATE_FILE_MODE,
		});

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.volt/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 * @param options Listing behavior. Message-free durable sessions remain hidden unless explicitly requested.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (
			await listSessionsFromDir(dir, onProgress, 0, undefined, options?.includeMessageFreeDurable)
		).filter((session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd));
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress, options?: SessionListOptions): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: SessionListOptions,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrOptions?: SessionListProgress | SessionListOptions,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrOptions === "function"
					? onProgressOrOptions
					: undefined;
		const listOptions =
			typeof sessionDirOrOnProgress === "function"
				? (onProgressOrOptions as SessionListOptions | undefined)
				: sessionDirOrOnProgress === undefined &&
						typeof onProgressOrOptions === "object" &&
						onProgressOrOptions !== null
					? onProgressOrOptions
					: options;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(
				customSessionDir,
				progress,
				0,
				undefined,
				listOptions?.includeMessageFreeDurable,
			);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					ensurePrivateDirectorySync(dir);
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(
				allFiles,
				() => {
					loaded++;
					progress?.(loaded, totalFiles);
				},
				listOptions?.includeMessageFreeDurable,
			);

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
