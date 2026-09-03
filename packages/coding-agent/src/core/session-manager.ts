import { type AgentMessage, uuidv7 } from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonCompatibleInput, JsonValue, Message, TextContent } from "@hansjm10/volt-ai";
import { randomUUID } from "crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "fs";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { TextDecoder } from "util";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-write.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
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
import { RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX, RPC_SESSION_QUEUE_MAX_ITEMS } from "./rpc/wire-limits.ts";
import {
	assertClientMessageId,
	boundClientInputError,
	CLIENT_INPUT_ERROR_MAX_SCALARS,
	decodeStoredSessionEntry,
	digestClientInputPayload,
	isHostOnlySessionEntryType,
	isValidClientMessageId,
	normalizeClientInputPayload,
	normalizeClientInputQueuedPayload,
	parsePersistedSessionEntry,
	parseSessionEntryForAdmission,
	parseSessionReference,
	parseSessionSnapshotHeader,
	validatePersistedSessionEntrySequence,
	validateSessionEntryAdmissionReferences,
} from "./session-entry-codec.ts";
import {
	acquireSharedSQLiteSessionStore,
	digestSessionStoreTransactionPayload,
	SESSION_STORE_DATABASE_FILENAME,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInputWrite,
	type SessionStoreEntryWrite,
	type SessionStoreJsonValue,
	type SessionStoreLabelWrite,
	type SessionStoreSearchChunkWrite,
	type SessionStoreSessionProjection,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreSubagentSpawnWrite,
	type SessionStoreTransactionPayload,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "./session-store/index.ts";

function deepFreezeCanonicalData<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeCanonicalData(nested);
		Object.freeze(value);
	}
	return value;
}

export const CURRENT_SESSION_VERSION = 5;
export const CURRENT_SESSION_SNAPSHOT_VERSION = 1;

export interface SessionReference {
	readonly sessionDirectory: string;
	readonly storeId: string;
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: SessionReference;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
}

export interface SessionSnapshotHeader {
	type: "session";
	version: number;
	snapshotVersion: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSessionDirectory?: string;
	parentStoreId?: string;
	parentSessionId?: string;
	parentSessionGeneration?: string;
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
	parentSession?: SessionReference;
	origin?: SessionOrigin;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** Monotonic commit order assigned when the entry is persisted. */
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
	/** Durable child reference. Absent for in-memory children. */
	childSessionRef?: SessionReference;
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
	return isHostOnlySessionEntryType(entry.type);
}

export { isValidClientMessageId };
export const RUNTIME_QUEUE_ENTRY_ID_PREFIX = RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX;
export const CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES = RPC_SESSION_QUEUE_MAX_ITEMS;
export const CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;
export const CLIENT_INPUT_MAX_OUTSTANDING_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime-only dequeue identity. This namespace is never valid at paired-client ingress. */
export function isRuntimeQueueEntryId(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(RUNTIME_QUEUE_ENTRY_ID_PREFIX) && value.length <= 64;
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
	ref: SessionReference;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	parentSessionRef?: SessionReference;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
	/** First host-observed path-free Git state for this session. */
	startingGitContext?: RpcGitContext | null;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

function sessionReference(
	sessionDirectory: string,
	storeId: string,
	sessionId: string,
	sessionGeneration: string,
): SessionReference {
	return Object.freeze({ sessionDirectory, storeId, sessionId, sessionGeneration });
}

function sessionInfoFromStoreSummary(
	sessionDirectory: string,
	storeId: string,
	summary: SessionStoreSessionSummary,
): SessionInfo {
	let startingGitContext: RpcGitContext | null | undefined;
	if (summary.startingGitContextRecorded) {
		if (!Check(Type.Union([RpcGitContextSchema, Type.Null()]), summary.startingGitContext)) {
			throw new Error(`Session ${summary.id} has invalid starting Git context metadata`);
		}
		startingGitContext = summary.startingGitContext;
	}
	return {
		ref: sessionReference(sessionDirectory, storeId, summary.id, summary.sessionGeneration),
		id: summary.id,
		cwd: summary.cwd,
		...(summary.name === null ? {} : { name: summary.name }),
		...(summary.parentSessionId === null || summary.parentStoreId === null
			? {}
			: {
					parentSessionRef: sessionReference(
						summary.parentSessionDirectory!,
						summary.parentStoreId,
						summary.parentSessionId,
						summary.parentSessionGeneration!,
					),
				}),
		...(summary.origin === null ? {} : { origin: summary.origin }),
		...(startingGitContext === undefined ? {} : { startingGitContext }),
		created: new Date(summary.createdAt),
		modified: new Date(summary.updatedAt),
		messageCount: summary.messageCount,
		firstMessage: summary.firstMessage || "(no messages)",
	};
}

function storedEntryToSessionEntry(stored: SessionStoreSnapshot["entries"][number]): SessionEntry {
	return decodeStoredSessionEntry(stored);
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionRef"
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

function withoutClientInputIdentity(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "user" || entry.message.clientMessageId === undefined) {
		return entry;
	}
	const message = { ...entry.message };
	delete message.clientMessageId;
	return { ...entry, message };
}

export function createSessionSnapshotHeader(header: SessionHeader): SessionSnapshotHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		...(header.parentSession === undefined
			? {}
			: {
					parentSessionDirectory: header.parentSession.sessionDirectory,
					parentStoreId: header.parentSession.storeId,
					parentSessionId: header.parentSession.sessionId,
					parentSessionGeneration: header.parentSession.sessionGeneration,
				}),
		...(header.origin === undefined ? {} : { origin: header.origin }),
	};
}

export function serializeSessionJsonlSnapshot(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	leafId: string | null,
): string {
	const snapshotEntries = entries.map((entry, index) => ({
		...withoutClientInputIdentity(entry),
		ordinal: index + 1,
	}));
	const leaf: LeafEntry = {
		type: "leaf",
		id: generateId(new Set(snapshotEntries.map((entry) => entry.id))),
		parentId: snapshotEntries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		targetId: leafId,
		ordinal: snapshotEntries.length + 1,
	};
	const snapshotHeader = parseSessionSnapshotHeader(
		createSessionSnapshotHeader(header),
		CURRENT_SESSION_VERSION,
		CURRENT_SESSION_SNAPSHOT_VERSION,
	);
	const validatedEntries = validatePersistedSessionEntrySequence([...snapshotEntries, leaf], { snapshot: true });
	return `${[snapshotHeader, ...validatedEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Exported for compaction tests and snapshot consumers. */
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
	const visited = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current) {
		if (visited.has(current.id)) throw new Error("Session branch contains a parent cycle");
		visited.add(current.id);
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

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	hardenPrivateRegularFileSync(resolvedFilePath);
	const entries: FileEntry[] = [];
	let malformedCompleteLine: number | undefined;
	let lineNumber = 0;
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const fd = openSync(resolvedFilePath, constants.O_RDONLY | noFollow);
	try {
		const fileStat = fstatSync(fd);
		if (!fileStat.isFile() || fileStat.nlink !== 1)
			throw new Error(`Session JSONL is not a private regular file: ${filePath}`);
		if (noFollow === 0) {
			const pathStat = lstatSync(resolvedFilePath);
			if (
				pathStat.isSymbolicLink() ||
				!pathStat.isFile() ||
				pathStat.dev !== fileStat.dev ||
				pathStat.ino !== fileStat.ino
			) {
				throw new Error(`Session JSONL path changed while opening: ${filePath}`);
			}
		}
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

		// JSONL is explicit interchange, not a live append log. A non-empty
		// malformed final fragment is a truncated snapshot and must fail closed.
		if (pendingBytes > 0) {
			const finalLine = Buffer.concat(pendingChunks, pendingBytes);
			const parsed = parseSessionEntryBytes(finalLine);
			if (parsed.entry) entries.push(parsed.entry);
			else if (parsed.malformed && malformedCompleteLine === undefined) {
				malformedCompleteLine = lineNumber + 1;
			}
		}
	} finally {
		closeSync(fd);
	}

	if (malformedCompleteLine !== undefined) {
		throw new Error(`Session snapshot JSONL is malformed at committed line ${malformedCompleteLine}`);
	}
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

export function assertCurrentSessionSnapshot(entries: FileEntry[]): SessionSnapshotHeader {
	const headerValue = entries[0];
	if (!headerValue || headerValue.type !== "session") {
		throw new Error("Session snapshot has no valid header");
	}
	if (entries.slice(1).some((entry) => entry.type === "session")) {
		throw new Error("Session snapshot contains more than one header");
	}
	if (headerValue.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session snapshot entry version must be ${CURRENT_SESSION_VERSION}`);
	}
	if (
		(headerValue as SessionHeader & { snapshotVersion?: number }).snapshotVersion !== CURRENT_SESSION_SNAPSHOT_VERSION
	) {
		throw new Error(`Session snapshot version must be ${CURRENT_SESSION_SNAPSHOT_VERSION}`);
	}
	for (const entry of entries.slice(1)) {
		if (entry.type !== "leaf" && isHostOnlySessionEntry(entry)) {
			throw new Error(`Session snapshot contains unsupported host-only entry: ${entry.type}`);
		}
	}
	const header = parseSessionSnapshotHeader(headerValue, CURRENT_SESSION_VERSION, CURRENT_SESSION_SNAPSHOT_VERSION);
	const sessionEntries = validatePersistedSessionEntrySequence(entries.slice(1), { snapshot: true });
	entries.splice(0, entries.length, header, ...sessionEntries);
	return header;
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

export interface SessionEntrySummary {
	messageCount: number;
	firstMessage: string;
	lastActivityTime?: number;
}

interface SessionMessageSummaryAccumulator {
	messageCount: number;
	firstUserMessage: string;
	firstFallbackMessage: string;
	lastActivityTime: number | undefined;
}

interface SessionStoreProjectionAccumulator {
	messageSummary: SessionMessageSummaryAccumulator;
	hasPlanningState: boolean;
	name: string | undefined;
	startingGitContext: RpcGitContext | null | undefined;
}

function createSessionMessageSummaryAccumulator(): SessionMessageSummaryAccumulator {
	return {
		messageCount: 0,
		firstUserMessage: "",
		firstFallbackMessage: "",
		lastActivityTime: undefined,
	};
}

function createSessionStoreProjectionAccumulator(): SessionStoreProjectionAccumulator {
	return {
		messageSummary: createSessionMessageSummaryAccumulator(),
		hasPlanningState: false,
		name: undefined,
		startingGitContext: undefined,
	};
}

function cloneSessionStoreProjectionAccumulator(
	accumulator: SessionStoreProjectionAccumulator,
): SessionStoreProjectionAccumulator {
	return {
		messageSummary: { ...accumulator.messageSummary },
		hasPlanningState: accumulator.hasPlanningState,
		name: accumulator.name,
		startingGitContext: accumulator.startingGitContext,
	};
}

function accumulateSessionMessageSummary(accumulator: SessionMessageSummaryAccumulator, entry: SessionEntry): void {
	if (entry.type === "message") {
		accumulator.messageCount++;

		const activityTime = getMessageActivityTime(entry);
		if (typeof activityTime === "number") {
			accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, activityTime);
		}

		const message = entry.message;
		if (!isMessageWithContent(message)) return;
		if (message.role !== "user" && message.role !== "assistant") return;

		const textContent = extractTextContent(message);
		if (!textContent) return;

		if (!accumulator.firstUserMessage && message.role === "user") {
			accumulator.firstUserMessage = textContent;
		}
		if (!accumulator.firstFallbackMessage && message.role === "assistant") {
			accumulator.firstFallbackMessage = textContent;
		}
		return;
	}

	if (!isDisplayedCustomMessage(entry)) return;
	accumulator.messageCount++;

	const activityTime = getEntryTimestamp(entry);
	if (typeof activityTime === "number") {
		accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, activityTime);
	}

	const textContent = extractTextContentFromContent(entry.content);
	if (textContent && !accumulator.firstFallbackMessage) {
		accumulator.firstFallbackMessage = textContent;
	}
}

function accumulateSessionStoreProjection(accumulator: SessionStoreProjectionAccumulator, entry: SessionEntry): void {
	accumulateSessionMessageSummary(accumulator.messageSummary, entry);
	if (entry.type === "planning_state_change") {
		accumulator.hasPlanningState = true;
	} else if (entry.type === "session_info") {
		accumulator.name = entry.name?.trim() || undefined;
	} else if (entry.type === "session_start_git_context") {
		accumulator.startingGitContext = entry.gitContext;
	}
}

function sessionEntrySummaryFromAccumulator(accumulator: SessionMessageSummaryAccumulator): SessionEntrySummary {
	return {
		messageCount: accumulator.messageCount,
		firstMessage: accumulator.firstUserMessage || accumulator.firstFallbackMessage || "(no messages)",
		lastActivityTime: accumulator.lastActivityTime,
	};
}

export function summarizeSessionEntries(entries: Iterable<SessionEntry>): SessionEntrySummary {
	const accumulator = createSessionMessageSummaryAccumulator();
	for (const entry of entries) accumulateSessionMessageSummary(accumulator, entry);
	return sessionEntrySummaryFromAccumulator(accumulator);
}

export type SessionListProgress = (loaded: number, total: number) => void;

export interface SessionListOptions {
	includeMessageFreeDurable?: boolean;
}

/**
 * Manages conversation sessions as append-only trees stored in SQLite.
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
	private sessionGeneration: string = "";
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private sessionStoreLease: SQLiteSessionStoreLease | undefined;
	private storeId: string | undefined;
	private storeRevision = 0;
	private nextSearchChunkIndex = 0;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private clientInputsById: Map<string, ClientInputRecord> = new Map();
	private sessionStoreProjection = createSessionStoreProjectionAccumulator();
	private leafId: string | null = null;
	private nextOrdinal = 1;
	/** Monotonic revision of provider-visible entries and durable leaf movement. */
	private canonicalRevision = 0;
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
	/** Queue tasks admitted but not fully settled, including reconciliation. */
	private unsettledPersistenceTasks = 0;
	private persistenceDrainPromise: Promise<SessionPersistenceDrainResult> | undefined;
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
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		sessionStoreLease?: SQLiteSessionStoreLease,
		snapshot?: SessionStoreSnapshot,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = sessionDir;
		this.persist = persist;
		this.sessionStoreLease = sessionStoreLease;
		this.storeId = sessionStoreLease?.client.info.storeId;
		if (persist && this.sessionDir) ensurePrivateDirectorySync(this.sessionDir);
		if (snapshot) this._loadStoreSnapshot(snapshot, cwd);
		else this.newSession(newSessionOptions);
	}

	private _loadStoreSnapshot(snapshot: SessionStoreSnapshot, cwdOverride?: string): void {
		const summary = snapshot.session;
		if (summary.formatVersion !== CURRENT_SESSION_VERSION) {
			throw new Error(`Session entry version must be ${CURRENT_SESSION_VERSION}`);
		}
		const parentSession =
			summary.parentSessionId === null ||
			summary.parentStoreId === null ||
			summary.parentSessionDirectory === null ||
			summary.parentSessionGeneration === null
				? undefined
				: sessionReference(
						summary.parentSessionDirectory,
						summary.parentStoreId,
						summary.parentSessionId,
						summary.parentSessionGeneration,
					);
		const header: SessionHeader = {
			type: "session",
			version: summary.formatVersion,
			id: summary.id,
			timestamp: summary.createdAt,
			cwd: cwdOverride ?? summary.cwd,
			...(parentSession === undefined ? {} : { parentSession }),
			...(summary.origin === null ? {} : { origin: summary.origin }),
		};
		this.cwd = resolvePath(cwdOverride ?? summary.cwd);
		this.sessionId = summary.id;
		this.sessionGeneration = summary.sessionGeneration;
		this.storeRevision = summary.revision;
		this.fileEntries = [header, ...snapshot.entries.map(storedEntryToSessionEntry)];
		this.nextSearchChunkIndex = snapshot.searchChunks.reduce(
			(maximum, chunk) => Math.max(maximum, chunk.chunkIndex + 1),
			0,
		);
		this.acceptsStartingGitContext = false;
		this._buildIndex();
	}

	newSession(options?: NewSessionOptions): SessionReference | undefined {
		this._assertPersistenceHealthy();
		if (this.atomicAppendInFlight) throw new Error("Cannot create a new session during an atomic append");
		if (this.unsettledPersistenceTasks > 0) {
			throw new Error("Cannot create a new session while persistence is pending; await flush() first");
		}
		if (options?.id !== undefined) assertValidSessionId(options.id);
		if (options?.origin !== undefined && options.origin !== "subagent") {
			throw new Error("Session origin is invalid");
		}
		const parentSession =
			options?.parentSession === undefined
				? undefined
				: parseSessionReference(options.parentSession, "Parent session reference");
		this.sessionId = options?.id ?? createSessionId();
		this.sessionGeneration = randomUUID();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			...(parentSession === undefined ? {} : { parentSession }),
			...(options?.origin === undefined ? {} : { origin: options.origin }),
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.clientInputsById.clear();
		this.sessionStoreProjection = createSessionStoreProjectionAccumulator();
		this.leafId = null;
		this.nextOrdinal = 1;
		this.canonicalRevision = 0;
		this.storeRevision = 0;
		this.nextSearchChunkIndex = 0;
		this.acceptsStartingGitContext = true;

		if (this.persist) {
			const store = this.sessionStoreLease?.client;
			if (!store || !this.storeId) throw new Error("Persisted session requires an initialized session store");
			const sessionId = this.sessionId;
			const sessionGeneration = this.sessionGeneration;
			const parent = parentSession;
			this._enqueuePersistence(async () => {
				await store.createHiddenSession({
					id: sessionId,
					sessionGeneration,
					formatVersion: CURRENT_SESSION_VERSION,
					cwd: this.cwd,
					createdAt: timestamp,
					parentSessionDirectory: parent?.sessionDirectory ?? null,
					parentStoreId: parent?.storeId ?? null,
					parentSessionId: parent?.sessionId ?? null,
					parentSessionGeneration: parent?.sessionGeneration ?? null,
					origin: options?.origin ?? null,
				});
			});
		}
		return this.getSessionRef();
	}

	private _buildIndex(): void {
		const header = this.fileEntries[0];
		if (!header || header.type !== "session") throw new Error("Current session header is unavailable");
		const validatedEntries = validatePersistedSessionEntrySequence(this.fileEntries.slice(1));
		this.fileEntries = [header, ...validatedEntries];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.clientInputsById.clear();
		this.sessionStoreProjection = createSessionStoreProjectionAccumulator();
		this.leafId = null;
		this.nextOrdinal = 1;
		this.canonicalRevision = 0;
		for (const entry of validatedEntries) {
			this.nextOrdinal = entry.ordinal + 1;
			if (entry.type === "leaf") this.leafId = entry.targetId;
			if (entry.type === "leaf" || !isHostOnlySessionEntry(entry)) this.canonicalRevision++;
			this.byId.set(entry.id, entry);
			if (!isHostOnlySessionEntry(entry)) {
				this.leafId = entry.id;
			}
			this._indexClientInputEntry(entry);
			this._indexLabelEntry(entry);
			accumulateSessionStoreProjection(this.sessionStoreProjection, entry);
		}
	}

	private _indexLabelEntry(entry: SessionEntry): void {
		if (entry.type !== "label") return;
		if (entry.label) {
			this.labelsById.set(entry.targetId, entry.label);
			this.labelTimestampsById.set(entry.targetId, entry.timestamp);
		} else {
			this.labelsById.delete(entry.targetId);
			this.labelTimestampsById.delete(entry.targetId);
		}
	}

	private _enqueuePersistence(
		write: () => Promise<void>,
		failureHandling: "fail_stop" | "propagate" = "fail_stop",
	): Promise<void> {
		this.unsettledPersistenceTasks++;
		const task = this.persistenceQueue
			.then(async () => {
				if (this.persistenceError) throw this.persistenceError;
				try {
					await write();
				} catch (error) {
					if (failureHandling === "propagate") throw error;
					this.persistenceError ??= error instanceof Error ? error : new Error(String(error));
					throw this.persistenceError;
				}
			})
			.finally(() => {
				this.unsettledPersistenceTasks--;
			});
		// Keep the serialization lane fulfilled so later accepted work can observe
		// the sticky error and stop without touching disk. The public watermark
		// retains rejection for flush callers.
		this.persistenceQueue = task.catch(() => {});
		this.persistenceWatermark = task;
		void task.catch(() => {});
		return task;
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

	getSessionRef(): SessionReference | undefined {
		if (!this.persist || !this.storeId) return undefined;
		return sessionReference(this.sessionDir, this.storeId, this.sessionId, this.sessionGeneration);
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

	private _storeProjection(): SessionStoreSessionProjection {
		const header = this.getHeader();
		if (!header) throw new Error("Session header is unavailable");
		const summary = sessionEntrySummaryFromAccumulator(this.sessionStoreProjection.messageSummary);
		const startingGitContext = this.sessionStoreProjection.startingGitContext;
		const updatedAt =
			typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
				? new Date(summary.lastActivityTime).toISOString()
				: header.timestamp;
		return {
			updatedAt,
			startingGitContextRecorded: startingGitContext !== undefined,
			startingGitContext: (startingGitContext ?? null) as SessionStoreJsonValue,
			name: this.sessionStoreProjection.name ?? null,
			visible: summary.messageCount > 0 || this.sessionStoreProjection.hasPlanningState,
			leafId: this.leafId,
			messageCount: summary.messageCount,
			firstMessage: summary.firstMessage === "(no messages)" ? "" : summary.firstMessage,
		};
	}

	private _storeClientInputs(entries: readonly SessionEntry[]): SessionStoreClientInputWrite[] {
		const affectedIds = new Set<string>();
		for (const entry of entries) {
			if (isClientInputWalEntry(entry)) affectedIds.add(entry.clientMessageId);
			if (entry.type === "message" && entry.message.role === "user" && entry.message.clientMessageId) {
				affectedIds.add(entry.message.clientMessageId);
			}
		}
		return [...affectedIds]
			.map((clientMessageId) => this.clientInputsById.get(clientMessageId))
			.filter((record): record is ClientInputRecord => record !== undefined)
			.map((record) => ({
				clientMessageId: record.clientMessageId,
				receiptEntryId: record.receiptId,
				command: record.command,
				semanticDigest: record.semanticDigest,
				input: record.input as unknown as SessionStoreJsonValue,
				queuedEntryId: record.queuedEntryId ?? null,
				queuedInput: (record.queuedInput ?? null) as unknown as SessionStoreJsonValue | null,
				state: record.state,
				error: record.error ?? null,
				canonicalEntryId: record.canonicalEntryId ?? null,
			}));
	}

	private _storePayload(entries: readonly SessionEntry[]): SessionStoreTransactionPayload {
		const labels: SessionStoreLabelWrite[] = [];
		const subagentSpawns: SessionStoreSubagentSpawnWrite[] = [];
		const searchChunks: SessionStoreSearchChunkWrite[] = [];
		for (const entry of entries) {
			if (entry.type === "label") {
				labels.push({ targetEntryId: entry.targetId, label: entry.label ?? null, timestamp: entry.timestamp });
			}
			if (entry.type === "subagent_spawn") {
				subagentSpawns.push({
					entryId: entry.id,
					toolCallId: entry.toolCallId,
					subagentId: entry.subagentId,
					agent: entry.agent,
					childSessionId: entry.childSessionId,
					childStoreId: entry.childSessionRef?.storeId ?? null,
					requestKey: entry.requestKey,
				});
			}
			let text = "";
			if (entry.type === "message" && isMessageWithContent(entry.message)) {
				if (entry.message.role === "user" || entry.message.role === "assistant") {
					text = extractTextContent(entry.message);
				}
			} else if (isDisplayedCustomMessage(entry)) {
				text = extractTextContentFromContent(entry.content);
			}
			if (text) {
				searchChunks.push({ chunkIndex: this.nextSearchChunkIndex++, entryId: entry.id, text });
			}
		}
		const storedEntries: SessionStoreEntryWrite[] = entries.map((entry) => ({
			entry: parsePersistedSessionEntry(entry) as unknown as SessionStoreJsonValue,
		}));
		return {
			session: this._storeProjection(),
			entries: storedEntries,
			labels,
			clientInputs: this._storeClientInputs(entries),
			subagentSpawns,
			searchChunks,
		};
	}

	private async _commitStorePayload(payload: SessionStoreTransactionPayload): Promise<void> {
		if (!this.persist) return;
		const currentLease = this.sessionStoreLease;
		if (!currentLease || !this.storeId) {
			throw new Error("Persisted session requires an initialized session store lease");
		}
		const commitId = randomUUID();
		const digest = digestSessionStoreTransactionPayload(payload);
		const expectedRevision = this.storeRevision;
		const input: SessionStoreApplyTransactionInput = {
			sessionId: this.sessionId,
			sessionGeneration: this.sessionGeneration,
			expectedRevision,
			commitId,
			digest,
			payload,
		};
		let store = currentLease.client;
		try {
			const result = await store.applyTransaction(input);
			if (result.status === "conflict") {
				throw new AtomicAppendPersistenceFailure(
					`Session revision changed from ${expectedRevision} to ${result.actualRevision}`,
					"not_started",
					"reconciliation_required",
				);
			}
			this.storeRevision = result.evidence.afterRevision;
			return;
		} catch (error) {
			if (error instanceof AtomicAppendPersistenceFailure) throw error;
			let replacementLease: SQLiteSessionStoreLease | undefined;
			let replacementInstalled = false;
			try {
				replacementLease = await acquireSharedSQLiteSessionStore(this.sessionDir);
				if (replacementLease.client.info.storeId !== this.storeId) {
					throw new Error("Replacement session store identity changed during reconciliation");
				}
				this.sessionStoreLease = replacementLease;
				replacementInstalled = true;
				store = replacementLease.client;
				await currentLease.release();
				const reconciliation = await store.reconcileCommit({
					sessionId: this.sessionId,
					sessionGeneration: this.sessionGeneration,
					commitId,
					digest,
				});
				if (reconciliation.status === "committed") {
					this.storeRevision = reconciliation.evidence.afterRevision;
					return;
				}
				const summary = await store.findSessionSummary(this.sessionId, this.sessionGeneration);
				if (reconciliation.status === "not_found" && summary?.revision === expectedRevision) {
					throw new AtomicAppendPersistenceFailure(
						"SQLite session transaction was rolled back",
						"rolled_back",
						"available",
						{ cause: error },
					);
				}
			} catch (reconciliationError) {
				let effectiveError: unknown = reconciliationError;
				if (replacementLease && !replacementInstalled) {
					try {
						await replacementLease.release();
					} catch (releaseError) {
						effectiveError = new AggregateError(
							[reconciliationError, releaseError],
							"Session store replacement failed and its lease could not be released",
						);
					}
				}
				if (effectiveError instanceof AtomicAppendPersistenceFailure) throw effectiveError;
				throw new AtomicAppendPersistenceFailure(
					"SQLite session transaction outcome could not be reconciled",
					"uncertain",
					"reconciliation_required",
					{ cause: effectiveError },
				);
			}
			throw new AtomicAppendPersistenceFailure(
				"SQLite session transaction outcome is ambiguous",
				"uncertain",
				"reconciliation_required",
				{ cause: error },
			);
		}
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist) return;
		const payload = this._storePayload([entry]);
		this._enqueuePersistence(async () => {
			try {
				await this._commitStorePayload(payload);
			} catch (error) {
				this._requireConversationReconciliation(error instanceof Error ? error : new Error(String(error)));
				throw error;
			}
		});
	}

	private _appendEntry(entry: SessionEntry): void {
		if (this.atomicAppendInFlight && !this.atomicAppendEntries) {
			throw new Error("An atomic session append is already in progress");
		}
		this._assertPersistenceHealthy();
		const canonicalEntry = parseSessionEntryForAdmission(entry, `Session ${entry.type} entry`);
		validateSessionEntryAdmissionReferences(canonicalEntry, this.byId, this.nextOrdinal);
		if (
			canonicalEntry.type === "session_start_git_context" &&
			this.sessionStoreProjection.startingGitContext !== undefined
		) {
			throw new Error("Session contains more than one starting Git context entry");
		}
		const stagedClientInputs = new Map(
			[...this.clientInputsById].map(([id, record]) => [id, cloneClientInputRecord(record)]),
		);
		this._indexClientInputEntry(canonicalEntry, stagedClientInputs);
		canonicalEntry.ordinal = this.nextOrdinal++;
		this.fileEntries.push(canonicalEntry);
		this.byId.set(canonicalEntry.id, canonicalEntry);
		if (canonicalEntry.type === "leaf" || !isHostOnlySessionEntry(canonicalEntry)) this.canonicalRevision++;
		if (canonicalEntry.type === "leaf") {
			this.leafId = canonicalEntry.targetId;
		} else if (!isHostOnlySessionEntry(canonicalEntry)) {
			this.leafId = canonicalEntry.id;
		}
		this._indexClientInputEntry(canonicalEntry);
		this._indexLabelEntry(canonicalEntry);
		accumulateSessionStoreProjection(this.sessionStoreProjection, canonicalEntry);
		if (!this.atomicAppendEntries) this._persist(canonicalEntry);
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

	/** Stage synchronous append operations and publish them only after one SQLite transaction commits. */
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
			sessionStoreProjection: cloneSessionStoreProjectionAccumulator(this.sessionStoreProjection),
			leafId: this.leafId,
			nextOrdinal: this.nextOrdinal,
			nextSearchChunkIndex: this.nextSearchChunkIndex,
			canonicalRevision: this.canonicalRevision,
		};
		const restore = (): void => {
			this.fileEntries = snapshot.fileEntries;
			this.byId = snapshot.byId;
			this.labelsById = snapshot.labelsById;
			this.labelTimestampsById = snapshot.labelTimestampsById;
			this.clientInputsById = snapshot.clientInputsById;
			this.sessionStoreProjection = snapshot.sessionStoreProjection;
			this.leafId = snapshot.leafId;
			this.nextOrdinal = snapshot.nextOrdinal;
			this.nextSearchChunkIndex = snapshot.nextSearchChunkIndex;
			this.canonicalRevision = snapshot.canonicalRevision;
		};
		try {
			beforeStage();
		} catch (error) {
			this.atomicAppendInFlight = false;
			if (error instanceof SessionCanonicalConflictError || error instanceof SessionAtomicAppendError) throw error;
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
			sessionStoreProjection: cloneSessionStoreProjectionAccumulator(this.sessionStoreProjection),
			leafId: this.leafId,
			nextOrdinal: this.nextOrdinal,
			nextSearchChunkIndex: this.nextSearchChunkIndex,
			canonicalRevision: this.canonicalRevision,
		};
		let payload: SessionStoreTransactionPayload | undefined;
		try {
			payload = entries.length > 0 && this.persist ? this._storePayload(entries) : undefined;
			staged.nextSearchChunkIndex = this.nextSearchChunkIndex;
		} catch (error) {
			this.atomicAppendEntries = undefined;
			this.atomicAppendInFlight = false;
			restore();
			throw error;
		}
		this.atomicAppendEntries = undefined;
		restore();

		try {
			if (payload) {
				await this._enqueuePersistence(() => this._commitStorePayload(payload), "propagate");
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
			if (failure.effect === "uncertain") this.persistenceError ??= failure;
			else this.persistenceWatermark = this.persistenceQueue;
			if (failure.authority === "reconciliation_required") this._requireConversationReconciliation(failure);
			throw new SessionAtomicAppendError(failure.message, failure.effect, failure.authority, { cause: failure });
		}

		this.fileEntries = staged.fileEntries;
		this.byId = staged.byId;
		this.labelsById = staged.labelsById;
		this.labelTimestampsById = staged.labelTimestampsById;
		this.clientInputsById = staged.clientInputsById;
		this.sessionStoreProjection = staged.sessionStoreProjection;
		this.leafId = staged.leafId;
		this.nextOrdinal = staged.nextOrdinal;
		this.nextSearchChunkIndex = staged.nextSearchChunkIndex;
		this.canonicalRevision = staged.canonicalRevision;
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
				if (snapshot.leafId !== staged.leafId) this._notifyBranchListeners(snapshot.leafId, staged.leafId);
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

	/** Wait for the hidden or visible SQLite session row and all accepted mutations to be durable. */
	async materialize(): Promise<void> {
		this._assertPersistenceHealthy();
		if (this.atomicAppendEntries || this.atomicAppendInFlight) {
			throw new Error("Cannot materialize a session during an atomic append");
		}
		await this.persistenceWatermark;
	}

	/** Wait for every filesystem operation accepted before this call. */
	flush(): Promise<void> {
		return this.persistenceWatermark;
	}

	/** Seal persistence and classify only this manager's recorded reconciliation failure. */
	drainPersistence(): Promise<SessionPersistenceDrainResult> {
		if (this.persistenceDrainPromise) return this.persistenceDrainPromise;
		if (this.persist) this.persistenceClosed = true;
		const watermark = this.persistenceWatermark;
		this.persistenceDrainPromise = (async () => {
			let result: SessionPersistenceDrainResult | undefined;
			let persistenceError: unknown;
			try {
				await watermark;
				const authority = this.conversationAuthorityStatus;
				result =
					authority.status === "reconciliation_required"
						? { status: "reconciliation_required", error: authority.error }
						: { status: "closed" };
			} catch (error) {
				const authority = this.conversationAuthorityStatus;
				if (authority.status === "reconciliation_required" && authority.error.cause === error) {
					result = { status: "reconciliation_required", error: authority.error };
				} else {
					persistenceError = error;
				}
			}

			const lease = this.sessionStoreLease;
			let releaseError: unknown;
			try {
				await lease?.release();
			} catch (error) {
				releaseError = error;
			} finally {
				if (this.sessionStoreLease === lease) this.sessionStoreLease = undefined;
			}
			if (releaseError !== undefined) {
				const authoritativeError =
					persistenceError ??
					(result?.status === "reconciliation_required"
						? result.error.cause instanceof Error
							? result.error.cause
							: result.error
						: undefined);
				if (authoritativeError !== undefined) {
					throw new AggregateError(
						[authoritativeError, releaseError],
						"Session persistence failed and its store lease could not be released",
					);
				}
				throw releaseError;
			}
			if (persistenceError !== undefined) throw persistenceError;
			return result ?? { status: "closed" };
		})();
		return this.persistenceDrainPromise;
	}

	/** Seal a persisted manager against later writes and reject on every failed watermark. */
	async closePersistence(): Promise<void> {
		const result = await this.drainPersistence();
		if (result.status === "reconciliation_required") {
			throw result.error.cause instanceof Error ? result.error.cause : result.error;
		}
	}

	private _indexClientInputEntry(
		entry: SessionEntry,
		records: Map<string, ClientInputRecord> = this.clientInputsById,
	): void {
		if (entry.type === "client_input_receipt") {
			assertClientMessageId(entry.clientMessageId);
			if (entry.command !== "prompt" && entry.command !== "steer" && entry.command !== "follow_up") {
				throw new Error(`Client input receipt ${entry.id} has an invalid command`);
			}
			const input = normalizeClientInputPayload(entry.command, entry.input);
			if (entry.semanticDigest !== digestClientInputPayload(entry.command, input)) {
				throw new Error(`Client input receipt ${entry.id} has a mismatched semantic digest`);
			}
			const existing = records.get(entry.clientMessageId);
			if (!existing) {
				assertClientInputOutstandingCount(records.values(), 1);
				assertClientInputOutstandingBudget(records.values(), measureClientInputPayloadBytes(input));
				records.set(entry.clientMessageId, {
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
			const record = records.get(entry.clientMessageId);
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
				getRecoverableQueuedClientInputCount(records.values()) >= CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES
			) {
				throw new Error(
					`Recoverable client input queue exceeds ${CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES} entries`,
				);
			}
			if (!record.queuedInput) {
				assertClientInputOutstandingBudget(records.values(), measureClientInputPayloadBytes(queuedInput));
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
		const record = requireStartedClientInputReceipt(records, clientMessageId);
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
		if (this.sessionStoreProjection.startingGitContext !== undefined) {
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
		return this.sessionStoreProjection.startingGitContext;
	}

	/** Get the incrementally maintained lifetime message summary for session listing. */
	getSessionEntrySummary(): SessionEntrySummary {
		this.assertConversationAuthorityAvailable();
		return sessionEntrySummaryFromAccumulator(this.sessionStoreProjection.messageSummary);
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		this.assertConversationAuthorityAvailable();
		return this.sessionStoreProjection.name;
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
		childSessionRef?: SessionReference;
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
			...(spawn.childSessionRef !== undefined ? { childSessionRef: spawn.childSessionRef } : {}),
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
		const visited = new Set<string>();
		const startId = fromId ?? this.getLeafId();
		let current = startId ? this.getEntry(startId) : undefined;
		while (current) {
			if (visited.has(current.id)) throw new Error("Session branch contains a parent cycle");
			visited.add(current.id);
			if (!isHostOnlySessionEntry(current)) path.push(current);
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

	/** Replace this manager with a new session containing only the selected branch. */
	async createBranchedSession(leafId: string): Promise<SessionReference | undefined> {
		if (this.atomicAppendInFlight) throw new Error("Cannot create a branched session during an atomic append");
		await this.persistenceWatermark;
		this._assertPersistenceHealthy();
		const previousSession = this.getSessionRef();
		const path = this.getBranch(leafId);
		if (path.length === 0) throw new Error(`Entry ${leafId} not found`);

		const retained: SessionEntry[] = [];
		const retainedIds = new Set<string>();
		let parentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			const copy = withoutClientInputIdentity({ ...entry, parentId });
			delete copy.ordinal;
			retained.push(copy);
			retainedIds.add(copy.id);
			parentId = copy.id;
		}
		const labels = [...this.labelsById]
			.filter(([targetId]) => retainedIds.has(targetId))
			.map(([targetId, label]) => ({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! }));
		const origin = this.getHeader()?.origin;
		this.newSession({
			...(previousSession === undefined ? {} : { parentSession: previousSession }),
			...(origin === undefined ? {} : { origin }),
		});
		await this.persistenceWatermark;
		await this.appendAtomically(
			() => {
				for (const entry of retained) this._appendEntry(entry);
				let labelParentId = retained.at(-1)?.id ?? null;
				for (const { targetId, label, timestamp } of labels) {
					const labelEntry: LabelEntry = {
						type: "label",
						id: generateId(this.byId),
						parentId: labelParentId,
						timestamp,
						targetId,
						label,
					};
					this._appendEntry(labelEntry);
					labelParentId = labelEntry.id;
				}
			},
			() => {},
		);
		return this.getSessionRef();
	}

	private static async _releaseLeaseAfterFailure(
		lease: SQLiteSessionStoreLease,
		error: unknown,
		message: string,
	): Promise<never> {
		try {
			await lease.release();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], message);
		}
		throw error;
	}

	private static async _store(dir: string): Promise<SQLiteSessionStoreLease> {
		return acquireSharedSQLiteSessionStore(normalizePath(dir));
	}

	private static async _scopedStore<T>(
		dir: string,
		operation: (store: SQLiteSessionStoreClient) => Promise<T>,
	): Promise<T> {
		const lease = await SessionManager._store(dir);
		let result: T;
		try {
			result = await operation(lease.client);
		} catch (error) {
			try {
				await lease.release();
			} catch (releaseError) {
				throw new AggregateError(
					[error, releaseError],
					"Session store operation failed and its lease could not be released",
				);
			}
			throw error;
		}
		await lease.release();
		return result;
	}

	/** Create and durably reserve a hidden persisted session. */
	static async create(cwd: string, sessionDir?: string, options?: NewSessionOptions): Promise<SessionManager> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		const lease = await SessionManager._store(dir);
		try {
			const manager = new SessionManager(cwd, dir, true, options, lease);
			await manager.flush();
			return manager;
		} catch (error) {
			return await SessionManager._releaseLeaseAfterFailure(
				lease,
				error,
				"Session creation failed and its store lease could not be released",
			);
		}
	}

	/** Open one authoritative SQLite session reference. */
	static async open(ref: SessionReference, cwdOverride?: string): Promise<SessionManager> {
		const canonicalRef = parseSessionReference(ref);
		const dir = resolvePath(canonicalRef.sessionDirectory);
		const lease = await SessionManager._store(dir);
		try {
			if (lease.client.info.storeId !== canonicalRef.storeId) {
				throw new Error("Session reference belongs to a different store");
			}
			const snapshot = await lease.client.loadSession(canonicalRef.sessionId, canonicalRef.sessionGeneration);
			if (!snapshot) throw new Error(`Session not found: ${canonicalRef.sessionId}`);
			return new SessionManager(cwdOverride ?? snapshot.session.cwd, dir, true, undefined, lease, snapshot);
		} catch (error) {
			return await SessionManager._releaseLeaseAfterFailure(
				lease,
				error,
				"Session open failed and its store lease could not be released",
			);
		}
	}

	/** Continue the most recent visible or pending-input session for a cwd, or create one. */
	static async continueRecent(cwd: string, sessionDir?: string): Promise<SessionManager> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		const lease = await SessionManager._store(dir);
		try {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const latest = await lease.client.findContinuationSession(filterCwd ? resolvePath(cwd) : undefined);
			if (!latest) {
				const manager = new SessionManager(cwd, dir, true, undefined, lease);
				await manager.flush();
				return manager;
			}
			const snapshot = await lease.client.loadSession(latest.id, latest.sessionGeneration);
			if (!snapshot) throw new Error(`Session not found: ${latest.id}`);
			return new SessionManager(snapshot.session.cwd, dir, true, undefined, lease, snapshot);
		} catch (error) {
			return await SessionManager._releaseLeaseAfterFailure(
				lease,
				error,
				"Session continuation failed and its store lease could not be released",
			);
		}
	}

	static async readStartingGitContexts(
		sessionDir: string,
		sessionIds: readonly string[],
	): Promise<ReadonlyMap<string, RpcGitContext | null>> {
		for (const sessionId of sessionIds) assertValidSessionId(sessionId);
		if (new Set(sessionIds).size !== sessionIds.length) {
			throw new Error("Session context lookup requires unique session ids");
		}
		const contexts = new Map<string, RpcGitContext | null>(sessionIds.map((sessionId) => [sessionId, null]));
		if (sessionIds.length === 0) return contexts;
		return SessionManager._scopedStore(normalizePath(sessionDir), async (store) => {
			for (const sessionId of sessionIds) {
				const summary = await store.findSessionSummaryById(sessionId);
				if (!summary?.startingGitContextRecorded) continue;
				if (!Check(Type.Union([RpcGitContextSchema, Type.Null()]), summary.startingGitContext)) {
					throw new Error(`Session ${sessionId} has invalid starting Git context metadata`);
				}
				contexts.set(sessionId, summary.startingGitContext);
			}
			return contexts;
		});
	}

	/** Find a generation-pinned reference by exact id; open() performs full snapshot validation. */
	static async findForResume(sessionDir: string, sessionId: string): Promise<SessionReference | undefined> {
		assertValidSessionId(sessionId);
		const dir = resolvePath(sessionDir);
		return SessionManager._scopedStore(dir, async (store) => {
			const summary = await store.findSessionSummaryById(sessionId);
			if (!summary) return undefined;
			return sessionReference(dir, store.info.storeId, summary.id, summary.sessionGeneration);
		});
	}

	/** Create an in-memory session (no persistence). */
	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", false);
	}

	/** Import an explicit JSONL snapshot into SQLite; the JSONL file is never reopened as live storage. */
	static async importFromJsonl(
		inputPath: string,
		targetCwd?: string,
		sessionDir?: string,
		options?: { id?: string },
	): Promise<SessionManager> {
		const resolvedPath = resolvePath(inputPath);
		if (sessionDir !== undefined) ensurePrivateDirectorySync(normalizePath(sessionDir));
		if (existsSync(resolvedPath)) hardenPrivateRegularFileSync(resolvedPath);
		const sourceEntries = loadEntriesFromFile(resolvedPath);
		if (sourceEntries.length === 0) throw new Error(`Cannot import invalid session JSONL: ${resolvedPath}`);
		const header = assertCurrentSessionSnapshot(sourceEntries);

		const cwd = targetCwd ?? header.cwd;
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const parentSession =
			header.parentSessionDirectory !== undefined &&
			header.parentStoreId !== undefined &&
			header.parentSessionId !== undefined &&
			header.parentSessionGeneration !== undefined
				? sessionReference(
						header.parentSessionDirectory,
						header.parentStoreId,
						header.parentSessionId,
						header.parentSessionGeneration,
					)
				: undefined;

		const sourceById = new Map<string, SessionEntry>();
		let sourceLeafId: string | null = null;
		for (const entry of sourceEntries) {
			if (entry.type === "session") continue;
			sourceById.set(entry.id, entry);
			if (entry.type === "leaf") sourceLeafId = entry.targetId;
			else sourceLeafId = entry.id;
		}
		const nearestPublicParent = (parentId: string | null): string | null => {
			let currentId = parentId;
			const visited = new Set<string>();
			while (currentId) {
				if (visited.has(currentId)) throw new Error("Imported session contains a host-only parent cycle");
				visited.add(currentId);
				const current = sourceById.get(currentId);
				if (!current) throw new Error(`Imported session references an unavailable entry: ${currentId}`);
				if (!isHostOnlySessionEntry(current)) return current.id;
				currentId = current.parentId;
			}
			return null;
		};
		const publicEntries = sourceEntries
			.filter((entry): entry is SessionEntry => entry.type !== "session" && !isHostOnlySessionEntry(entry))
			.map((entry) => withoutClientInputIdentity({ ...entry, parentId: nearestPublicParent(entry.parentId) }))
			.map((entry) => {
				delete entry.ordinal;
				return entry;
			});
		const finalLeafId = nearestPublicParent(sourceLeafId);
		const targetId = options?.id ?? header.id;
		const stage = async (manager: SessionManager): Promise<void> => {
			await manager.appendAtomically(
				() => {
					for (const entry of publicEntries) manager._appendEntry(entry);
					if (finalLeafId !== manager.getLeafId()) {
						if (finalLeafId === null) manager.resetLeaf();
						else manager.branch(finalLeafId);
					}
				},
				() => {},
			);
		};

		const validationManager = SessionManager.inMemory(cwd);
		validationManager.newSession({
			id: targetId,
			...(parentSession === undefined ? {} : { parentSession }),
			...(header.origin === undefined ? {} : { origin: header.origin }),
		});
		await stage(validationManager);

		const manager = await SessionManager.create(cwd, dir, {
			id: targetId,
			...(parentSession === undefined ? {} : { parentSession }),
			...(header.origin === undefined ? {} : { origin: header.origin }),
		});
		try {
			await stage(manager);
			return manager;
		} catch (error) {
			try {
				await manager.closePersistence();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session import failed and its manager could not be closed");
			}
			throw error;
		}
	}

	/** Fork a stored session into a new persisted session in another cwd/store. */
	static async forkFrom(
		sourceRef: SessionReference,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): Promise<SessionManager> {
		const source = await SessionManager.open(sourceRef);
		let target: SessionManager | undefined;
		try {
			target = await SessionManager.create(targetCwd, sessionDir, {
				...options,
				parentSession: sourceRef,
			});
			const sourceById = source.byId;
			const nearestPublicParent = (parentId: string | null): string | null => {
				let currentId = parentId;
				while (currentId) {
					const current = sourceById.get(currentId);
					if (!current) return null;
					if (!isHostOnlySessionEntry(current)) return current.id;
					currentId = current.parentId;
				}
				return null;
			};
			const entries = source
				.getEntries()
				.map((entry) => withoutClientInputIdentity({ ...entry, parentId: nearestPublicParent(entry.parentId) }))
				.map((entry) => {
					delete entry.ordinal;
					return entry;
				});
			await target.appendAtomically(
				() => {
					for (const entry of entries) target!._appendEntry(entry);
				},
				() => {},
			);
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (target) {
				try {
					await target.closePersistence();
				} catch (closeError) {
					cleanupErrors.push(closeError);
				}
			}
			try {
				await source.closePersistence();
			} catch (closeError) {
				cleanupErrors.push(closeError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Session fork failed and cleanup did not complete");
			}
			throw error;
		}
		try {
			await source.closePersistence();
		} catch (error) {
			try {
				await target.closePersistence();
			} catch (closeError) {
				throw new AggregateError(
					[error, closeError],
					"Session fork source and unreturned target could not be closed",
				);
			}
			throw error;
		}
		return target;
	}

	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		return SessionManager._scopedStore(dir, async (store) => {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const summaries = await store.listSessionSummaries({
				includeHidden: options?.includeMessageFreeDurable,
				...(filterCwd ? { cwd: resolvePath(cwd) } : {}),
			});
			onProgress?.(summaries.length, summaries.length);
			return summaries.map((summary) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
		});
	}

	static async search(
		cwd: string,
		query: string,
		sessionDir?: string,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		return SessionManager._scopedStore(dir, async (store) => {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const results = await store.searchSessionSummaries(query, {
				includeHidden: options?.includeMessageFreeDurable,
				...(filterCwd ? { cwd: resolvePath(cwd) } : {}),
			});
			return results.map(({ summary }) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
		});
	}

	static async searchAll(query: string, sessionDir?: string): Promise<SessionInfo[]> {
		if (sessionDir) {
			const dir = resolvePath(sessionDir);
			return SessionManager._scopedStore(dir, async (store) => {
				const results = await store.searchSessionSummaries(query);
				return results.map(({ summary }) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
			});
		}
		const sessionsRoot = getSessionsDir();
		if (!existsSync(sessionsRoot)) return [];
		const directories = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
		const result: { session: SessionInfo; score: number }[] = [];
		const storeFailures: unknown[] = [];
		let successfulStores = 0;
		for (const directory of directories) {
			if (!existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME))) continue;
			let storeResults: { session: SessionInfo; score: number }[];
			try {
				storeResults = await SessionManager._scopedStore(directory, async (store) => {
					const results = await store.searchSessionSummaries(query);
					return results.map(({ summary, score }) => ({
						session: sessionInfoFromStoreSummary(directory, store.info.storeId, summary),
						score,
					}));
				});
			} catch (error) {
				storeFailures.push(error);
				continue;
			}
			successfulStores += 1;
			result.push(...storeResults);
		}
		if (successfulStores === 0 && storeFailures.length > 0) {
			throw new AggregateError(storeFailures, "Could not search sessions in any project store");
		}
		result.sort((left, right) => {
			if (left.score !== right.score) return left.score - right.score;
			return right.session.modified.getTime() - left.session.modified.getTime();
		});
		return result.map(({ session }) => session);
	}

	static async exportJsonlSnapshot(ref: SessionReference, outputPath: string): Promise<{ revision: number }> {
		const manager = await SessionManager.open(ref);
		let result: { revision: number };
		try {
			const header = manager.getHeader();
			if (!header) throw new Error("Cannot export a session without a header");
			const content = serializeSessionJsonlSnapshot(header, manager.getEntries(), manager.getLeafId());
			writeDurableAtomicFileSync(resolvePath(outputPath), content, {
				directoryMode: PRIVATE_DIRECTORY_MODE,
				fileMode: PRIVATE_FILE_MODE,
			});
			result = { revision: manager.storeRevision };
		} catch (error) {
			try {
				await manager.closePersistence();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session export failed and its manager could not be closed");
			}
			throw error;
		}
		await manager.closePersistence();
		return result;
	}

	static async delete(ref: SessionReference, expectedRevision?: number): Promise<boolean> {
		const canonicalRef = parseSessionReference(ref);
		return SessionManager._scopedStore(canonicalRef.sessionDirectory, async (store) => {
			if (store.info.storeId !== canonicalRef.storeId) {
				throw new Error("Session reference belongs to a different store");
			}
			const summary = await store.findSessionSummary(canonicalRef.sessionId, canonicalRef.sessionGeneration);
			if (!summary) return false;
			const result = await store.deleteSession({
				sessionId: canonicalRef.sessionId,
				sessionGeneration: canonicalRef.sessionGeneration,
				expectedRevision: expectedRevision ?? summary.revision,
			});
			if (result.status === "conflict") {
				throw new Error(`Session changed before deletion (revision ${result.actualRevision})`);
			}
			return result.status === "deleted";
		});
	}

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
		const customDir =
			typeof sessionDirOrOnProgress === "string" && sessionDirOrOnProgress
				? resolvePath(sessionDirOrOnProgress)
				: undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrOptions === "function"
					? onProgressOrOptions
					: undefined;
		const listOptions =
			typeof sessionDirOrOnProgress === "function"
				? (onProgressOrOptions as SessionListOptions | undefined)
				: typeof onProgressOrOptions === "object" && onProgressOrOptions !== null
					? onProgressOrOptions
					: options;
		if (customDir) {
			return SessionManager._scopedStore(customDir, async (store) => {
				const summaries = await store.listSessionSummaries({
					includeHidden: listOptions?.includeMessageFreeDurable,
				});
				progress?.(summaries.length, summaries.length);
				return summaries.map((summary) => sessionInfoFromStoreSummary(customDir, store.info.storeId, summary));
			});
		}

		const sessionsRoot = getSessionsDir();
		if (!existsSync(sessionsRoot)) return [];
		const directories = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
		const result: SessionInfo[] = [];
		const storeFailures: unknown[] = [];
		let successfulStores = 0;
		let loaded = 0;
		for (const directory of directories) {
			if (existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME))) {
				let storeResults: SessionInfo[] | undefined;
				try {
					storeResults = await SessionManager._scopedStore(directory, async (store) => {
						const summaries = await store.listSessionSummaries({
							includeHidden: listOptions?.includeMessageFreeDurable,
						});
						return summaries.map((summary) =>
							sessionInfoFromStoreSummary(directory, store.info.storeId, summary),
						);
					});
				} catch (error) {
					storeFailures.push(error);
				}
				if (storeResults) {
					successfulStores += 1;
					result.push(...storeResults);
				}
			}
			loaded += 1;
			progress?.(loaded, directories.length);
		}
		if (successfulStores === 0 && storeFailures.length > 0) {
			throw new AggregateError(storeFailures, "Could not list sessions from any project store");
		}
		return result.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}
}
