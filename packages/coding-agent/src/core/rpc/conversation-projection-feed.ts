import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	ConversationProjectionLimitError,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
} from "./conversation-projection-limits.ts";
import { measureRpcJsonBytesWithin, projectRpcUtf8Prefix } from "./session-state.ts";
import {
	assertConversationProjectionSourceAssistantEventWithinLimits,
	type ProjectedMessageStartFrame,
	type ProjectedMessageUpdateFrame,
	type ProjectionDiagnostic,
	type ProjectionSanitizer,
	StreamProjector,
} from "./stream-projection.ts";
import {
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	type RpcAssistantStreamPosition,
	type RpcCommandType,
	type RpcConversationActiveAssistant,
	type RpcConversationBootstrapEvent,
	type RpcConversationBootstrapReason,
	type RpcConversationDiscontinuityReason,
} from "./types.ts";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
	RPC_UI_ACTION_ID_MAX_CHARS,
	RPC_UI_ACTION_STATE_LABEL_MAX_CHARS,
	RPC_UI_ACTION_STATE_MAX_OPTIONS,
	RPC_UI_ACTION_STATE_OPTION_DESCRIPTION_MAX_CHARS,
	RPC_UI_ACTION_STATE_OPTION_LABEL_MAX_CHARS,
	RPC_UI_ACTION_STATE_OPTION_VALUE_MAX_CHARS,
	RPC_UI_ACTION_STATE_TYPE_MAX_CHARS,
	RPC_UI_ACTION_STATE_VALUE_MAX_CHARS,
} from "./wire-limits.ts";

export {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
} from "./conversation-projection-limits.ts";
export { DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES } from "./wire-limits.ts";
export const DEFAULT_CONVERSATION_PROJECTION_MAX_CHECKPOINT_REQUESTS = 128;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_CHECKPOINTS_PER_WINDOW = 4;
export const DEFAULT_CONVERSATION_PROJECTION_CHECKPOINT_WINDOW_MS = 10_000;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS = 64;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW = 128;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_EVENT_BYTES = 256 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_TRANSCRIPT_COMMIT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_TRANSCRIPT_CURSORS = 1024;
const CONVERSATION_PROJECTION_TRANSCRIPT_CURSOR_MAX_UTF8_BYTES = 2048;
const CONVERSATION_PROJECTION_MAX_REBIND_CONTROLS = 128;
const CONVERSATION_PROJECTION_MAX_REBIND_CONTROL_BYTES = 512 * 1024;

type ActiveAssistantSourceEvent = object;

/** Minimal synchronous source surface implemented by AgentSession adapters. */
export interface ConversationProjectionSource {
	subscribe(listener: (event: object) => void): () => void;
	/** Retain expensive source observation only while at least one remote subscriber is active. */
	retainObservation?(): () => void;
	/** Synchronously fence projections when persisted conversation authority is lost. */
	subscribeAuthorityLoss?(listener: (error: Error) => void): () => void;
	/** Optional atomic source-generation hook for navigation and other rebases. */
	subscribeGenerationChanges?(listener: () => void): () => void;
}

export type ConversationProjectionSnapshot = Pick<
	RpcConversationBootstrapEvent,
	"conversation" | "state" | "activeAssistant" | "activeWorkflows"
> & {
	/** Extensible until branchEpoch is promoted into the shared wire type. */
	transcript: RpcConversationBootstrapEvent["transcript"] & Record<string, unknown>;
};

export interface ConversationProjectionSnapshotContext {
	source: ConversationProjectionSource;
	subscriptionId: string;
	branchEpoch: string;
	reason: RpcConversationBootstrapReason;
	requestId?: string;
	activeAssistant: RpcConversationActiveAssistant | null;
	/** Canonical raw workflow state; the builder applies subscriber policy. */
	activeWorkflows: readonly ConversationProjectionRawWorkflowSnapshot[];
}

export type ConversationProjectionSnapshotBuilder = (
	context: ConversationProjectionSnapshotContext,
) => ConversationProjectionSnapshot;

export interface ConversationProjectionQueueBounds {
	maxQueuedEnvelopes: number;
	maxQueuedBytes: number;
}

export interface ConversationProjectionPreparedValue {
	/** Final sanitized/decorated JSON value that the transport will encode without further transformation. */
	value: object;
	/** Exact encoded byte count, including transport framing such as the JSONL trailing LF. */
	bytes: number;
}

export interface ConversationProjectionFeedOptions extends Partial<ConversationProjectionQueueBounds> {
	maxCheckpointRequests?: number;
	maxCheckpointsPerWindow?: number;
	checkpointWindowMs?: number;
	createId?: () => string;
	now?: () => number;
}

export interface ConversationProjectionSubscriberOptions extends Partial<ConversationProjectionQueueBounds> {
	write(value: object): void | Promise<void>;
	buildSnapshot: ConversationProjectionSnapshotBuilder;
	/** Subscriber-specific authorization/projection for canonical external events. */
	projectExternal?: (event: object) => object | null;
	sanitizer?: ProjectionSanitizer;
	/** Prepare the final immutable outbound representation exactly once before it enters the queue. */
	prepare?: (value: object) => ConversationProjectionPreparedValue;
	/**
	 * Measure the fully encoded wire value when the caller has that encoder.
	 * Prefer `prepare` when transport decoration or sanitization can transform the value.
	 * The fallback is UTF-8 JSON size before later transport decoration.
	 */
	measureBytes?: (value: object) => number;
	onDiagnostic?: (diagnostic: ProjectionDiagnostic) => void;
	onError?: (error: Error) => void;
}

export interface ConversationProjectionCheckpointReceipt {
	subscriptionId: string;
	requestId: string;
	checkpointCursor: number;
}

export interface ConversationProjectionRecoveryRequest {
	requestId: string;
	lastAppliedCursor: number;
	assistantPosition?: RpcAssistantStreamPosition;
	reason: RpcConversationDiscontinuityReason;
}

export interface ConversationProjectionRawWorkflowSnapshot {
	workflowId: string;
	workflowEvent?: object;
	activeTools: readonly object[];
}

export interface ConversationProjectionSubscription {
	readonly subscriptionId: string;
	readonly branchEpoch: string;
	readonly ready: Promise<void>;
	/** Runs synchronously whenever this subscription's authority tuple rotates. */
	subscribeAuthorityChanges(listener: () => void): () => void;
	requestCheckpoint(request: ConversationProjectionRecoveryRequest): ConversationProjectionCheckpointReceipt;
	/** Enqueue a non-conversation control frame behind prior feed writes. */
	enqueueControl(value: object, onAdmitted?: (preparedValue: object) => void): Promise<void>;
	/**
	 * Atomically fence this subscriber, discard every value not yet handed to
	 * transport, and make `value` its final write. Authority tightening uses this
	 * instead of a normal control enqueue so no previously authorized source frame
	 * can leak after the rejection.
	 */
	fenceAndEnqueueTerminal(value: object, onAdmitted?: (preparedValue: object) => void): Promise<void>;
	flush(): Promise<void>;
	detach(): void;
}

type QueueItemKind = "ordinary" | "checkpoint" | "control" | "source_control" | "terminal";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

interface SubscriberQueueItem {
	value: object;
	bytes: number;
	kind: QueueItemKind;
	deferred?: Deferred<void>;
}

interface ConversationProjectionSubscriber {
	active: boolean;
	fenced: boolean;
	attaching: boolean;
	subscriptionId: string;
	nextCursor: number;
	projector: StreamProjector;
	readonly options: ConversationProjectionSubscriberOptions;
	readonly bounds: ConversationProjectionQueueBounds;
	readonly maxCheckpointRequests: number;
	readonly maxCheckpointsPerWindow: number;
	readonly checkpointWindowMs: number;
	readonly pending: SubscriberQueueItem[];
	readonly attachingTail: SubscriberQueueItem[];
	pendingNormalCount: number;
	pendingNormalBytes: number;
	pendingAuthority?: SubscriberQueueItem;
	attachingTailBytes: number;
	inFlight?: SubscriberQueueItem;
	draining: boolean;
	readonly flushWaiters: Deferred<void>[];
	readonly checkpoints: Map<
		string,
		{
			request: ConversationProjectionRecoveryRequest;
			receipt: ConversationProjectionCheckpointReceipt;
		}
	>;
	readonly checkpointRequestTimes: number[];
	readonly authorityChangeListeners: Set<() => void>;
	pendingCheckpointRequestId?: string;
	overflowRotationPending: boolean;
}

interface CanonicalWorkflowEvent {
	readonly value: object;
	readonly bytes: number;
}

interface MutableRawWorkflowSnapshot {
	workflowEvent?: CanonicalWorkflowEvent;
	readonly activeTools: Map<string, CanonicalWorkflowEvent>;
	activeToolBytes: number;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	// A transport failure should not become an unhandled rejection merely because
	// a caller elected not to await a lifecycle promise.
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

function requireQueueBound(value: number, name: string, hardMaximum: number): number {
	const bound = requirePositiveSafeInteger(value, name);
	if (bound > hardMaximum) {
		throw new Error(`${name} must not exceed the hard maximum of ${hardMaximum}`);
	}
	return bound;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OwnedJsonObject {
	readonly value: object;
	readonly bytes: number;
}

function freezeJsonValue(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	if (Array.isArray(value)) {
		for (const entry of value) freezeJsonValue(entry);
	} else {
		for (const key of Object.keys(value)) freezeJsonValue((value as Record<string, unknown>)[key]);
	}
	Object.freeze(value);
}

/** Own a bounded JSON value so producer mutation cannot change a queued or canonical frame after measurement. */
function ownJsonObjectWithin(value: object, maxBytes: number): OwnedJsonObject | null {
	if (measureRpcJsonBytesWithin(value, maxBytes) === null) return null;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return null;
		const owned: unknown = JSON.parse(serialized);
		if (!isRecord(owned) && !Array.isArray(owned)) return null;
		const bytes = measureRpcJsonBytesWithin(owned, maxBytes);
		if (bytes === null) return null;
		freezeJsonValue(owned);
		return { value: owned, bytes };
	} catch {
		return null;
	}
}

function isBoundedString(value: unknown, maxLength: number, minLength = 0): value is string {
	return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function assertUiActionStateChangedEvent(event: Record<string, unknown>): void {
	const malformed = (): never => {
		throw new Error("Conversation action-state event is malformed or exceeds its bounds");
	};
	if (
		!isBoundedString(event.action, RPC_UI_ACTION_ID_MAX_CHARS, 1) ||
		Object.keys(event).some((key) => key !== "type" && key !== "action" && key !== "state")
	) {
		malformed();
	}
	const state = event.state;
	if (!isRecord(state)) {
		throw new Error("Conversation action-state event is malformed or exceeds its bounds");
	}
	if (
		Object.keys(state).some((key) => key !== "type" && key !== "value" && key !== "label" && key !== "options") ||
		!isBoundedString(state.type, RPC_UI_ACTION_STATE_TYPE_MAX_CHARS, 1) ||
		!(
			state.value === null ||
			typeof state.value === "boolean" ||
			(typeof state.value === "number" && Number.isFinite(state.value)) ||
			isBoundedString(state.value, RPC_UI_ACTION_STATE_VALUE_MAX_CHARS)
		) ||
		(state.label !== undefined && !isBoundedString(state.label, RPC_UI_ACTION_STATE_LABEL_MAX_CHARS))
	) {
		malformed();
	}
	const options = state.options;
	if (options === undefined) {
		return;
	}
	if (!Array.isArray(options) || options.length > RPC_UI_ACTION_STATE_MAX_OPTIONS) {
		throw new Error("Conversation action-state event is malformed or exceeds its bounds");
	}
	for (const option of options) {
		if (
			!isRecord(option) ||
			Object.keys(option).some((key) => key !== "value" && key !== "label" && key !== "description") ||
			!isBoundedString(option.value, RPC_UI_ACTION_STATE_OPTION_VALUE_MAX_CHARS) ||
			(option.label !== undefined && !isBoundedString(option.label, RPC_UI_ACTION_STATE_OPTION_LABEL_MAX_CHARS)) ||
			(option.description !== undefined &&
				!isBoundedString(option.description, RPC_UI_ACTION_STATE_OPTION_DESCRIPTION_MAX_CHARS))
		) {
			malformed();
		}
	}
}

function isCanonicalExternalIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		!projectRpcUtf8Prefix(value, RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES).truncated
	);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalRecord(value: unknown): boolean {
	return value === undefined || isRecord(value);
}

function isPositiveCommitOrdinal(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "text" &&
		typeof value.text === "string" &&
		isOptionalString(value.textSignature)
	);
}

function isImageContent(value: unknown): boolean {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isThinkingContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "thinking" &&
		typeof value.thinking === "string" &&
		isOptionalString(value.thinkingSignature) &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function isToolCallContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		isCanonicalExternalIdentifier(value.id) &&
		isCanonicalExternalIdentifier(value.name) &&
		isRecord(value.arguments) &&
		isOptionalString(value.thoughtSignature)
	);
}

function isContentArray(value: unknown, predicate: (content: unknown) => boolean): boolean {
	return Array.isArray(value) && value.every(predicate);
}

function isUserOrCustomContent(value: unknown): boolean {
	return (
		typeof value === "string" || isContentArray(value, (content) => isTextContent(content) || isImageContent(content))
	);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		isNonNegativeFiniteNumber(value.input) &&
		isNonNegativeFiniteNumber(value.output) &&
		isNonNegativeFiniteNumber(value.cacheRead) &&
		isNonNegativeFiniteNumber(value.cacheWrite) &&
		(value.cacheWrite1h === undefined || isNonNegativeFiniteNumber(value.cacheWrite1h)) &&
		isNonNegativeFiniteNumber(value.totalTokens) &&
		isNonNegativeFiniteNumber(value.cost.input) &&
		isNonNegativeFiniteNumber(value.cost.output) &&
		isNonNegativeFiniteNumber(value.cost.cacheRead) &&
		isNonNegativeFiniteNumber(value.cost.cacheWrite) &&
		isNonNegativeFiniteNumber(value.cost.total)
	);
}

function isDiagnosticError(value: unknown): boolean {
	return (
		isRecord(value) &&
		isOptionalString(value.name) &&
		typeof value.message === "string" &&
		isOptionalString(value.stack) &&
		(value.code === undefined || typeof value.code === "string" || isFiniteNumber(value.code))
	);
}

function isAssistantDiagnostic(value: unknown): boolean {
	return (
		isRecord(value) &&
		isCanonicalExternalIdentifier(value.type) &&
		isFiniteNumber(value.timestamp) &&
		(value.error === undefined || isDiagnosticError(value.error)) &&
		isOptionalRecord(value.details)
	);
}

const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function assertCanonicalSessionMessage(message: Record<string, unknown>): void {
	if (!isCanonicalExternalIdentifier(message.role) || !isFiniteNumber(message.timestamp)) {
		throw new Error("Conversation transcript message commit is malformed");
	}
	switch (message.role) {
		case "user":
			if (
				!isUserOrCustomContent(message.content) ||
				(message.clientMessageId !== undefined && !isCanonicalExternalIdentifier(message.clientMessageId))
			) {
				throw new Error("Conversation transcript user-message commit is malformed");
			}
			return;
		case "assistant":
			if (
				!isContentArray(
					message.content,
					(content) => isTextContent(content) || isThinkingContent(content) || isToolCallContent(content),
				) ||
				!isCanonicalExternalIdentifier(message.api) ||
				!isCanonicalExternalIdentifier(message.provider) ||
				!isCanonicalExternalIdentifier(message.model) ||
				!isUsage(message.usage) ||
				typeof message.stopReason !== "string" ||
				!ASSISTANT_STOP_REASONS.has(message.stopReason) ||
				!isOptionalString(message.responseModel) ||
				!isOptionalString(message.responseId) ||
				!isOptionalString(message.errorMessage) ||
				(message.diagnostics !== undefined && !isContentArray(message.diagnostics, isAssistantDiagnostic))
			) {
				throw new Error("Conversation transcript assistant-message commit is malformed");
			}
			return;
		case "toolResult":
			if (
				!isCanonicalExternalIdentifier(message.toolCallId) ||
				!isCanonicalExternalIdentifier(message.toolName) ||
				!isContentArray(message.content, (content) => isTextContent(content) || isImageContent(content)) ||
				typeof message.isError !== "boolean"
			) {
				throw new Error("Conversation transcript tool-result commit is malformed");
			}
			return;
		case "custom":
			if (
				!isCanonicalExternalIdentifier(message.customType) ||
				!isUserOrCustomContent(message.content) ||
				typeof message.display !== "boolean"
			) {
				throw new Error("Conversation transcript custom-message commit is malformed");
			}
			return;
		case "bashExecution":
			if (
				typeof message.command !== "string" ||
				typeof message.output !== "string" ||
				!(message.exitCode === undefined || isFiniteNumber(message.exitCode)) ||
				typeof message.cancelled !== "boolean" ||
				typeof message.truncated !== "boolean" ||
				!isOptionalString(message.fullOutputPath) ||
				(message.excludeFromContext !== undefined && typeof message.excludeFromContext !== "boolean")
			) {
				throw new Error("Conversation transcript bash-message commit is malformed");
			}
			return;
		default:
			throw new Error(`Unsupported conversation transcript message role: ${message.role}`);
	}
}

function assertCanonicalTranscriptEntry(entry: Record<string, unknown>): void {
	if (
		!isCanonicalExternalIdentifier(entry.id) ||
		!(entry.parentId === null || isCanonicalExternalIdentifier(entry.parentId)) ||
		!isPositiveCommitOrdinal(entry.ordinal) ||
		!isCanonicalExternalIdentifier(entry.type) ||
		!isCanonicalExternalIdentifier(entry.timestamp)
	) {
		throw new Error("Conversation transcript commit is missing canonical persisted-entry identity");
	}
	switch (entry.type) {
		case "message":
			if (!isRecord(entry.message)) {
				throw new Error("Conversation transcript message commit is malformed");
			}
			assertCanonicalSessionMessage(entry.message);
			return;
		case "thinking_level_change":
			if (!isCanonicalExternalIdentifier(entry.thinkingLevel)) {
				throw new Error("Conversation transcript thinking-level commit is malformed");
			}
			return;
		case "fast_mode_change":
			if (typeof entry.enabled !== "boolean") {
				throw new Error("Conversation transcript Fast mode commit is malformed");
			}
			return;
		case "model_change":
			if (!isCanonicalExternalIdentifier(entry.provider) || !isCanonicalExternalIdentifier(entry.modelId)) {
				throw new Error("Conversation transcript model commit is malformed");
			}
			return;
		case "active_tools_change":
			if (
				!Array.isArray(entry.toolNames) ||
				entry.toolNames.some((name) => !isCanonicalExternalIdentifier(name)) ||
				new Set(entry.toolNames).size !== entry.toolNames.length
			) {
				throw new Error("Conversation transcript active-tools commit is malformed");
			}
			return;
		case "compaction":
			if (
				typeof entry.summary !== "string" ||
				!isCanonicalExternalIdentifier(entry.firstKeptEntryId) ||
				typeof entry.tokensBefore !== "number" ||
				!Number.isFinite(entry.tokensBefore) ||
				entry.tokensBefore < 0 ||
				(entry.fromHook !== undefined && typeof entry.fromHook !== "boolean")
			) {
				throw new Error("Conversation transcript compaction commit is malformed");
			}
			return;
		case "branch_summary":
			if (
				!isCanonicalExternalIdentifier(entry.fromId) ||
				typeof entry.summary !== "string" ||
				(entry.fromHook !== undefined && typeof entry.fromHook !== "boolean")
			) {
				throw new Error("Conversation transcript branch-summary commit is malformed");
			}
			return;
		case "custom":
			if (!isCanonicalExternalIdentifier(entry.customType)) {
				throw new Error("Conversation transcript custom commit is malformed");
			}
			return;
		case "custom_message":
			if (
				!isCanonicalExternalIdentifier(entry.customType) ||
				!isUserOrCustomContent(entry.content) ||
				typeof entry.display !== "boolean"
			) {
				throw new Error("Conversation transcript custom-message commit is malformed");
			}
			return;
		case "label":
			if (!isCanonicalExternalIdentifier(entry.targetId) || !isOptionalString(entry.label)) {
				throw new Error("Conversation transcript label commit is malformed");
			}
			return;
		case "session_info":
			if (!isOptionalString(entry.name)) {
				throw new Error("Conversation transcript session-info commit is malformed");
			}
			return;
		default:
			throw new Error(`Unsupported conversation transcript entry type: ${entry.type}`);
	}
}

const CONVERSATION_PROJECTION_RESPONSE_COMMANDS: ReadonlySet<string> = new Set([
	"get_fork_messages",
	"get_last_assistant_text",
	"get_message_images",
	"get_messages",
	"get_session_stats",
	"get_state",
	"get_transcript",
	"get_transcript_entry_text",
] satisfies RpcCommandType[]);

function isConversationProjectionControl(
	value: object,
): value is object & { type: "response"; success: true; command: string; data?: unknown } {
	return (
		isRecord(value) &&
		value.type === "response" &&
		value.success === true &&
		typeof value.command === "string" &&
		CONVERSATION_PROJECTION_RESPONSE_COMMANDS.has(value.command)
	);
}

function isStaleTranscriptControl(value: object, branchEpoch: string): boolean {
	if (!isConversationProjectionControl(value) || value.command !== "get_transcript") return false;
	const data = value.data;
	return isRecord(data) && typeof data.branchEpoch === "string" && data.branchEpoch !== branchEpoch;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isAssistantStartOrUpdate(event: object): boolean {
	if (!isRecord(event) || (event.type !== "message_start" && event.type !== "message_update")) {
		return false;
	}
	return isAssistantMessage(event.message);
}

function endsAssistant(event: object): boolean {
	return (
		isRecord(event) &&
		((event.type === "message_end" && isAssistantMessage(event.message)) ||
			event.type === "agent_end" ||
			event.type === "agent_settled")
	);
}

const MCP_CONTROL_EVENT_TYPES = new Set([
	"mcp_servers_changed",
	"mcp_server_status_changed",
	"mcp_auth_request",
	"mcp_auth_update",
	"mcp_call_start",
	"mcp_call_update",
	"mcp_call_end",
]);

const CONVERSATION_INTERNAL_SOURCE_EVENT_TYPES = new Set(["delivery_start"]);

const CONVERSATION_SOURCE_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"session_info_changed",
	"thinking_level_changed",
	"planning_state_changed",
	"git_context_changed",
	"ui_action_state_changed",
	"auto_retry_start",
	"auto_retry_end",
	"client_input_outcome",
]);

const CONVERSATION_EXTERNAL_EVENT_TYPES = new Set([
	"conversation_transcript_committed",
	"workflow_start",
	"workflow_update",
	"workflow_end",
	"tool_execution_start",
	"tool_execution_end",
]);

function assertCanonicalExternalEvent(event: object): asserts event is Record<string, unknown> {
	if (!isRecord(event) || typeof event.type !== "string") {
		throw new Error("Conversation projection external lane received a malformed event");
	}
	if (!CONVERSATION_EXTERNAL_EVENT_TYPES.has(event.type)) {
		throw new Error(`Unsupported conversation projection external event: ${event.type}`);
	}
	if (event.projection !== undefined) {
		throw new Error("Conversation projection metadata is outbound-only and forbidden on canonical external events");
	}
	if (event.type === "conversation_transcript_committed") {
		if (!isRecord(event.entry)) {
			throw new Error("Conversation transcript commit is missing canonical persisted-entry identity");
		}
		assertCanonicalTranscriptEntry(event.entry);
		return;
	}
	if (!isCanonicalExternalIdentifier(event.workflowId)) {
		throw new Error("Conversation workflow event is missing a canonical workflow id");
	}
	if (event.type === "workflow_start" || event.type === "workflow_update" || event.type === "workflow_end") {
		if (!isCanonicalExternalIdentifier(event.kind)) {
			throw new Error("Conversation workflow event is missing a canonical workflow kind");
		}
		if (
			!isOptionalString(event.action) ||
			!isOptionalString(event.title) ||
			!isOptionalString(event.message) ||
			!isOptionalString(event.status)
		) {
			throw new Error("Conversation workflow event contains malformed optional fields");
		}
		return;
	}
	if (
		!isCanonicalExternalIdentifier(event.workflowKind) ||
		!isCanonicalExternalIdentifier(event.workflowAction) ||
		!isCanonicalExternalIdentifier(event.toolCallId) ||
		!isCanonicalExternalIdentifier(event.toolName)
	) {
		throw new Error("Conversation workflow tool event is missing canonical identifiers");
	}
	if (event.type === "tool_execution_start") {
		if (!isOptionalRecord(event.args)) {
			throw new Error("Conversation workflow tool start contains malformed arguments");
		}
		return;
	}
	if (typeof event.isError !== "boolean") {
		throw new Error("Conversation workflow tool end is missing its error outcome");
	}
}

function isAuthorityItem(item: SubscriberQueueItem): boolean {
	return item.kind === "checkpoint" || item.kind === "terminal";
}

function activeAssistantFromFrame(frame: object): RpcConversationActiveAssistant | null {
	if (!isRecord(frame) || !isRecord(frame.stream) || !isAssistantMessage(frame.message)) {
		return null;
	}
	if (frame.type === "message_start") {
		const start = frame as unknown as ProjectedMessageStartFrame;
		return { stream: start.stream, message: start.message };
	}
	if (frame.type === "message_update") {
		const update = frame as unknown as ProjectedMessageUpdateFrame;
		return {
			stream: update.stream,
			message: update.message!,
			...(update.toolState === undefined ? {} : { toolState: update.toolState }),
		};
	}
	return null;
}

/**
 * Session-owned snapshot-and-tail feed. It retains only canonical raw assistant
 * source state; all wire projection and sanitization remains subscriber-local.
 */
export class ConversationProjectionFeed {
	private source: ConversationProjectionSource;
	private detachSourceEvents: () => void = () => {};
	private detachSourceAuthorityLoss: () => void = () => {};
	private detachGenerationChanges: () => void = () => {};
	private releaseSourceObservation: (() => void) | undefined;
	private activeAssistantSourceEvent?: ActiveAssistantSourceEvent;
	private readonly subscribers = new Set<ConversationProjectionSubscriber>();
	private readonly subscribersById = new Map<string, ConversationProjectionSubscriber>();
	private readonly workflowSnapshots = new Map<string, MutableRawWorkflowSnapshot>();
	private canonicalWorkflowBytes = 0;
	private readonly transcriptCursors = new Set<string>();
	private readonly transcriptCursorOrder: string[] = [];
	private readonly pendingRebindControls: Array<{ value: object; bytes: number }> = [];
	private pendingRebindControlBytes = 0;
	private readonly createId: () => string;
	private readonly defaultBounds: ConversationProjectionQueueBounds;
	private readonly maxCheckpointRequests: number;
	private readonly maxCheckpointsPerWindow: number;
	private readonly checkpointWindowMs: number;
	private readonly now: () => number;
	private disposed = false;
	private poisonedError?: Error;
	private sourceAuthorityError?: Error;
	private sourceRebindPending = false;
	private _branchEpoch: string;

	constructor(source: ConversationProjectionSource, options: ConversationProjectionFeedOptions = {}) {
		this.source = source;
		this.createId = options.createId ?? randomUUID;
		this.defaultBounds = {
			maxQueuedEnvelopes: requireQueueBound(
				options.maxQueuedEnvelopes ?? DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
				"maxQueuedEnvelopes",
				DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
			),
			maxQueuedBytes: requireQueueBound(
				options.maxQueuedBytes ?? DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
				"maxQueuedBytes",
				DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
			),
		};
		this.maxCheckpointRequests = requirePositiveSafeInteger(
			options.maxCheckpointRequests ?? DEFAULT_CONVERSATION_PROJECTION_MAX_CHECKPOINT_REQUESTS,
			"maxCheckpointRequests",
		);
		this.maxCheckpointsPerWindow = requirePositiveSafeInteger(
			options.maxCheckpointsPerWindow ?? DEFAULT_CONVERSATION_PROJECTION_MAX_CHECKPOINTS_PER_WINDOW,
			"maxCheckpointsPerWindow",
		);
		this.checkpointWindowMs = requirePositiveSafeInteger(
			options.checkpointWindowMs ?? DEFAULT_CONVERSATION_PROJECTION_CHECKPOINT_WINDOW_MS,
			"checkpointWindowMs",
		);
		this.now = options.now ?? Date.now;
		this._branchEpoch = this.mintId("branchEpoch");
		this.bindSourceListeners();
	}

	get branchEpoch(): string {
		return this._branchEpoch;
	}

	get activeWorkflows(): readonly ConversationProjectionRawWorkflowSnapshot[] {
		return this.captureActiveWorkflows();
	}

	isTranscriptCursorValid(cursor: string): boolean {
		return this.transcriptCursors.has(cursor);
	}

	registerTranscriptCursor(cursor: string | null): void {
		if (cursor === null) return;
		if (!cursor || projectRpcUtf8Prefix(cursor, CONVERSATION_PROJECTION_TRANSCRIPT_CURSOR_MAX_UTF8_BYTES).truncated) {
			throw new Error("Conversation transcript projection produced an invalid cursor");
		}
		if (this.transcriptCursors.has(cursor)) return;
		this.transcriptCursors.add(cursor);
		this.transcriptCursorOrder.push(cursor);
		while (this.transcriptCursorOrder.length > DEFAULT_CONVERSATION_PROJECTION_MAX_TRANSCRIPT_CURSORS) {
			const evicted = this.transcriptCursorOrder.shift();
			if (evicted !== undefined) this.transcriptCursors.delete(evicted);
		}
	}

	attach(options: ConversationProjectionSubscriberOptions): ConversationProjectionSubscription {
		this.assertActive();
		if (this.sourceRebindPending) {
			throw new Error("Conversation generation change is still awaiting host ownership rekey");
		}
		const subscriber: ConversationProjectionSubscriber = {
			active: true,
			fenced: false,
			attaching: true,
			subscriptionId: this.mintId("subscriptionId"),
			nextCursor: 1,
			projector: this.createProjector(options),
			options,
			bounds: {
				maxQueuedEnvelopes: requireQueueBound(
					options.maxQueuedEnvelopes ?? this.defaultBounds.maxQueuedEnvelopes,
					"maxQueuedEnvelopes",
					DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
				),
				maxQueuedBytes: requireQueueBound(
					options.maxQueuedBytes ?? this.defaultBounds.maxQueuedBytes,
					"maxQueuedBytes",
					DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
				),
			},
			maxCheckpointRequests: this.maxCheckpointRequests,
			maxCheckpointsPerWindow: this.maxCheckpointsPerWindow,
			checkpointWindowMs: this.checkpointWindowMs,
			pending: [],
			attachingTail: [],
			pendingNormalCount: 0,
			pendingNormalBytes: 0,
			attachingTailBytes: 0,
			draining: false,
			flushWaiters: [],
			checkpoints: new Map(),
			checkpointRequestTimes: [],
			authorityChangeListeners: new Set(),
			overflowRotationPending: false,
		};
		this.subscribers.add(subscriber);
		this.subscribersById.set(subscriber.subscriptionId, subscriber);

		const ready = createDeferred<void>();
		try {
			if (this.subscribers.size === 1) this.startSourceObservation();
			const subscriptionId = subscriber.subscriptionId;
			const branchEpoch = this._branchEpoch;
			const bootstrap = this.createBootstrap(subscriber, "bootstrap", 0);
			const item = this.createQueueItem(subscriber, bootstrap, "checkpoint", ready);
			this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
			this.assertAuthorityCapacity(subscriber, item, "Initial conversation bootstrap exceeds its authority slot");
			this.enqueueItem(subscriber, item);
			subscriber.attaching = false;
			this.flushAttachingTail(subscriber);
		} catch (error: unknown) {
			this.failSubscriber(subscriber, toError(error));
			throw error;
		}

		const feed = this;
		return {
			get subscriptionId() {
				return subscriber.subscriptionId;
			},
			get branchEpoch() {
				return feed._branchEpoch;
			},
			ready: ready.promise,
			subscribeAuthorityChanges(listener) {
				if (!subscriber.active) return () => {};
				subscriber.authorityChangeListeners.add(listener);
				return () => {
					subscriber.authorityChangeListeners.delete(listener);
				};
			},
			requestCheckpoint(request) {
				return feed.requestCheckpoint({ subscriptionId: subscriber.subscriptionId, ...request });
			},
			enqueueControl(value, onAdmitted) {
				return feed.enqueueControl(subscriber.subscriptionId, value, onAdmitted);
			},
			fenceAndEnqueueTerminal(value, onAdmitted) {
				return feed.fenceAndEnqueueTerminal(subscriber.subscriptionId, value, onAdmitted);
			},
			flush() {
				return feed.flushSubscriber(subscriber);
			},
			detach() {
				feed.detachSubscriber(subscriber);
			},
		};
	}

	requestCheckpoint(
		args: { subscriptionId: string } & ConversationProjectionRecoveryRequest,
	): ConversationProjectionCheckpointReceipt {
		this.assertActive();
		if (!args.requestId || args.requestId !== args.requestId.trim()) {
			throw new Error("requestId must be a canonical non-empty string");
		}
		if (projectRpcUtf8Prefix(args.requestId, RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES).truncated) {
			throw new Error(`requestId exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`);
		}
		const subscriber = this.subscribersById.get(args.subscriptionId);
		if (!subscriber?.active) {
			throw new Error(`Unknown or stale conversation subscription: ${args.subscriptionId}`);
		}
		if (subscriber.fenced) {
			throw new Error("Conversation projection subscription is terminally fenced");
		}
		if (subscriber.attaching) {
			throw new Error("Conversation projection authority cut is already in progress");
		}
		if (!Number.isSafeInteger(args.lastAppliedCursor) || args.lastAppliedCursor < 0) {
			throw new Error("lastAppliedCursor must be a safe non-negative integer");
		}
		if (
			args.reason !== "cursor_gap" &&
			args.reason !== "assistant_position_gap" &&
			args.reason !== "reducer_divergence"
		) {
			throw new Error("reason must identify a supported conversation discontinuity");
		}
		if (
			args.assistantPosition !== undefined &&
			(!Number.isSafeInteger(args.assistantPosition.epoch) ||
				args.assistantPosition.epoch < 0 ||
				!Number.isSafeInteger(args.assistantPosition.seq) ||
				args.assistantPosition.seq < 0)
		) {
			throw new Error("assistantPosition must contain safe non-negative epoch and seq values");
		}
		const lastIssuedCursor = subscriber.nextCursor - 1;
		if (args.lastAppliedCursor > lastIssuedCursor) {
			throw new Error(`lastAppliedCursor ${args.lastAppliedCursor} exceeds issued cursor ${lastIssuedCursor}`);
		}
		const request = Object.freeze({
			requestId: args.requestId,
			lastAppliedCursor: args.lastAppliedCursor,
			...(args.assistantPosition === undefined ? {} : { assistantPosition: { ...args.assistantPosition } }),
			reason: args.reason,
		});
		const existing = subscriber.checkpoints.get(args.requestId);
		if (existing) {
			if (
				existing.request.lastAppliedCursor !== request.lastAppliedCursor ||
				existing.request.reason !== request.reason ||
				existing.request.assistantPosition?.epoch !== request.assistantPosition?.epoch ||
				existing.request.assistantPosition?.seq !== request.assistantPosition?.seq
			) {
				throw new Error(`Conversation recovery request ${args.requestId} changed after admission`);
			}
			return existing.receipt;
		}
		if (subscriber.pendingCheckpointRequestId !== undefined) {
			throw new Error(`Conversation recovery checkpoint ${subscriber.pendingCheckpointRequestId} is still pending`);
		}
		this.recordCheckpointRequestRate(subscriber);
		const subscriptionId = subscriber.subscriptionId;
		const branchEpoch = this._branchEpoch;

		try {
			// A checkpoint supersedes every ordinary frame that has not been handed
			// to transport. If any later cut/materialization step fails, the
			// subscription is failed closed rather than continuing from a cursor whose
			// tail was already discarded.
			this.prunePendingOrdinaryTail(subscriber);
			subscriber.attaching = true;
			const checkpointCursor = this.takeNextCursor(subscriber);
			const checkpoint = this.createBootstrap(subscriber, "resync", checkpointCursor, args.requestId, true);
			const item = this.createQueueItem(subscriber, checkpoint, "checkpoint");
			this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
			this.assertAuthorityCapacity(subscriber, item, "Conversation recovery checkpoint exceeds its authority slot");
			const receipt = Object.freeze({
				subscriptionId: subscriber.subscriptionId,
				requestId: args.requestId,
				checkpointCursor,
			});
			this.rememberCheckpoint(subscriber, request, receipt);
			subscriber.pendingCheckpointRequestId = args.requestId;
			// The authority cut replaces only ordinary cursor tail. Controls already
			// accepted by the physical FIFO remain before it; controls accepted after
			// this synchronous append remain after it.
			this.enqueueItem(subscriber, item);
			this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
			subscriber.attaching = false;
			this.flushAttachingTail(subscriber);
			return receipt;
		} catch (error: unknown) {
			const queueError = toError(error);
			if (this.isSubscriberGenerationCurrent(subscriber, subscriptionId, branchEpoch)) {
				this.failSubscriber(subscriber, queueError);
			}
			throw queueError;
		}
	}

	publishExternal(event: object): void {
		this.assertActive();
		let canonicalEvent: OwnedJsonObject;
		try {
			// Validate the immutable JSON value that will actually be reduced and
			// projected. Producer prototypes, getters, and toJSON transformations must
			// not let one shape pass validation and a different shape consume a cursor.
			const owned = ownJsonObjectWithin(
				event,
				DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_TRANSCRIPT_COMMIT_BYTES,
			);
			if (owned === null) {
				throw new Error(
					`Conversation projection external event exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_TRANSCRIPT_COMMIT_BYTES}-byte canonical limit`,
				);
			}
			assertCanonicalExternalEvent(owned.value);
			if (
				owned.value.type !== "conversation_transcript_committed" &&
				owned.bytes > DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_EVENT_BYTES
			) {
				throw new Error(
					`Conversation projection workflow event exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_EVENT_BYTES}-byte canonical-state limit`,
				);
			}
			canonicalEvent = owned;
			this.reduceExternalState(canonicalEvent);
		} catch (error: unknown) {
			const projectionError = toError(error);
			this.poisonGeneration(projectionError);
			throw projectionError;
		}
		if (this.sourceRebindPending) {
			return;
		}
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			try {
				const projected = subscriber.options.projectExternal
					? subscriber.options.projectExternal(canonicalEvent.value)
					: canonicalEvent.value;
				if (projected !== null) {
					this.enqueueOrdinaryFrame(subscriber, projected);
				}
			} catch (error: unknown) {
				this.failSubscriber(subscriber, toError(error));
			}
		}
	}

	/**
	 * Bind a replacement source without publishing its identity yet. Source state
	 * continues to reduce while the host atomically rekeys its runtime/lease owner;
	 * subscribers cannot attach or observe the new generation until commit.
	 */
	beginSourceRebind(source: ConversationProjectionSource): void {
		this.assertNotDisposed();
		if (this.sourceRebindPending) {
			throw new Error("Conversation source rebind is already pending");
		}
		// Retire request/reply capabilities while the old authority tuple is still
		// observable. Waiting until commit leaves a window where the source has
		// already changed but an old correlated reply can still mutate host state.
		// A suspended source already published this one-way authority cut.
		if (this.sourceAuthorityError === undefined) {
			this.notifyAllSubscriberAuthorityChanging();
		}
		this.stopSourceObservation();
		this.detachSourceEvents();
		this.detachSourceAuthorityLoss();
		this.detachGenerationChanges();
		this.source = source;
		this.activeAssistantSourceEvent = undefined;
		this.workflowSnapshots.clear();
		this.canonicalWorkflowBytes = 0;
		this.resetTranscriptCursors();
		this.clearPendingRebindControls();
		this.poisonedError = undefined;
		this.sourceAuthorityError = undefined;
		this._branchEpoch = this.mintId("branchEpoch");
		this.sourceRebindPending = true;
		this.bindSourceListeners();
		if (this.subscribers.size > 0) this.startSourceObservation();
	}

	/** Publish a source previously installed by beginSourceRebind as cursor zero. */
	commitSourceRebind(): void {
		this.assertActive();
		if (!this.sourceRebindPending) {
			throw new Error("Conversation source rebind is not pending");
		}
		this.sourceRebindPending = false;
		this.rotateAllSubscriptions("session_rebind", false);
		this.flushPendingRebindControls();
	}

	/**
	 * Fail closed if the host cannot rekey ownership. Existing subscribers are
	 * detached. The rejecting ownership listener is responsible for releasing or
	 * disposing its stale owner before it throws; after that cleanup the feed may
	 * serve the installed source to a later, freshly authorized attach.
	 */
	failSourceRebind(error: Error): void {
		if (!this.sourceRebindPending) return;
		for (const subscriber of [...this.subscribers]) {
			this.failSubscriber(subscriber, error);
		}
		this.clearPendingRebindControls();
		this.sourceRebindPending = false;
	}

	/** Replace a source immediately when no external ownership transaction exists. */
	rebindSource(source: ConversationProjectionSource): void {
		this.beginSourceRebind(source);
		this.commitSourceRebind();
	}

	/** Rotate after fork/navigation while retaining the same AgentSession source. */
	rotateForBranchRebase(): void {
		this.assertNotDisposed();
		if (this.sourceRebindPending) {
			// The unpublished generation's eventual bootstrap snapshots the current
			// branch, so an intermediate branch notification needs no separate frame.
			return;
		}
		this.activeAssistantSourceEvent = undefined;
		this.workflowSnapshots.clear();
		this.canonicalWorkflowBytes = 0;
		this.resetTranscriptCursors();
		this.clearPendingRebindControls();
		this.poisonedError = undefined;
		this._branchEpoch = this.mintId("branchEpoch");
		this.rotateAllSubscriptions("branch_rebase");
	}

	async flush(): Promise<void> {
		await Promise.all([...this.subscribers].map((subscriber) => this.flushSubscriber(subscriber)));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopSourceObservation();
		this.detachSourceEvents();
		this.detachSourceAuthorityLoss();
		this.detachGenerationChanges();
		for (const subscriber of [...this.subscribers]) {
			this.detachSubscriber(subscriber, new Error("Conversation projection feed disposed"));
		}
		this.workflowSnapshots.clear();
		this.canonicalWorkflowBytes = 0;
		this.resetTranscriptCursors();
		this.clearPendingRebindControls();
	}

	private bindSourceListeners(): void {
		this.detachSourceEvents = this.source.subscribe((event) => this.handleSourceEvent(event));
		const detachAuthorityLoss = this.source.subscribeAuthorityLoss?.((error) => this.suspendSourceAuthority(error));
		this.detachSourceAuthorityLoss = detachAuthorityLoss ?? (() => {});
		if (this.sourceAuthorityError !== undefined) {
			this.detachSourceAuthorityLoss();
			this.detachSourceAuthorityLoss = () => {};
			return;
		}
		this.detachGenerationChanges =
			this.source.subscribeGenerationChanges?.(() => this.rotateForBranchRebase()) ?? (() => {});
	}

	private startSourceObservation(): void {
		if (this.releaseSourceObservation) return;
		this.releaseSourceObservation = this.source.retainObservation?.();
	}

	private stopSourceObservation(): void {
		this.releaseSourceObservation?.();
		this.releaseSourceObservation = undefined;
	}

	private handleSourceEvent(event: object): void {
		if (this.disposed || this.poisonedError !== undefined || this.sourceAuthorityError !== undefined) return;
		if (!isRecord(event) || typeof event.type !== "string") {
			this.poisonGeneration(new Error("Conversation projection source emitted a malformed event"));
			return;
		}
		if (MCP_CONTROL_EVENT_TYPES.has(event.type)) {
			if (this.sourceRebindPending) {
				try {
					this.bufferPendingRebindControl(event);
				} catch (error: unknown) {
					this.poisonGeneration(toError(error));
				}
				return;
			}
			for (const subscriber of [...this.subscribers]) {
				if (!subscriber.active || subscriber.fenced) continue;
				void this.enqueueControl(subscriber.subscriptionId, event, undefined, "source_control");
			}
			return;
		}
		if (CONVERSATION_INTERNAL_SOURCE_EVENT_TYPES.has(event.type)) {
			return;
		}
		if (!CONVERSATION_SOURCE_EVENT_TYPES.has(event.type)) {
			this.poisonGeneration(new Error(`Unsupported conversation projection source event: ${event.type}`));
			return;
		}
		try {
			if (event.type === "ui_action_state_changed") {
				assertUiActionStateChangedEvent(event);
			}
			// Validate canonical source truth even with zero subscribers. Otherwise an
			// oversized active assistant could be cached and only fail much later while
			// assigning an attach/checkpoint cursor.
			assertConversationProjectionSourceAssistantEventWithinLimits(event);
		} catch (error: unknown) {
			this.poisonGeneration(toError(error));
			return;
		}
		if (isAssistantStartOrUpdate(event)) {
			this.activeAssistantSourceEvent = event;
		}
		const terminal = endsAssistant(event);
		if (terminal) {
			// Snapshot cuts created by terminal-frame overflow must observe the
			// post-event idle state, even though the terminal frame itself is still
			// projected through each subscriber's assistant projector below.
			this.activeAssistantSourceEvent = undefined;
		}
		if (this.sourceRebindPending) {
			return;
		}
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			try {
				const batch = subscriber.projector.push(event);
				this.reportDiagnostics(subscriber, batch.diagnostics);
				for (const frame of batch.frames) {
					this.enqueueOrdinaryFrame(subscriber, frame, terminal);
				}
			} catch (error: unknown) {
				const projectionError = toError(error);
				if (projectionError instanceof ConversationProjectionLimitError) {
					this.poisonGeneration(projectionError);
					return;
				}
				this.failSubscriber(subscriber, projectionError);
			}
		}
	}

	private suspendSourceAuthority(error: Error): void {
		if (this.disposed || this.sourceAuthorityError !== undefined) return;
		this.sourceAuthorityError = error;
		this.notifyAllSubscriberAuthorityChanging();
		this.stopSourceObservation();
		this.detachSourceEvents();
		this.detachSourceAuthorityLoss();
		this.detachGenerationChanges();
		this.detachSourceEvents = () => {};
		this.detachSourceAuthorityLoss = () => {};
		this.detachGenerationChanges = () => {};
		this.activeAssistantSourceEvent = undefined;
		this.workflowSnapshots.clear();
		this.canonicalWorkflowBytes = 0;
		this.resetTranscriptCursors();
		this.clearPendingRebindControls();
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			this.dropPendingConversationItems(subscriber, error);
			subscriber.attaching = false;
			subscriber.pendingCheckpointRequestId = undefined;
			subscriber.overflowRotationPending = false;
		}
	}

	private poisonGeneration(error: Error): void {
		this.poisonedError = error;
		for (const subscriber of [...this.subscribers]) {
			this.failSubscriber(subscriber, error);
		}
	}

	private bufferPendingRebindControl(value: object): void {
		if (this.pendingRebindControls.length >= CONVERSATION_PROJECTION_MAX_REBIND_CONTROLS) {
			throw new Error("Conversation source rebind exceeded its buffered control count limit");
		}
		const remainingBytes = CONVERSATION_PROJECTION_MAX_REBIND_CONTROL_BYTES - this.pendingRebindControlBytes;
		const owned = remainingBytes <= 0 ? null : ownJsonObjectWithin(value, remainingBytes);
		if (owned === null) {
			throw new Error("Conversation source rebind exceeded its buffered control byte limit");
		}
		this.pendingRebindControls.push({ value: owned.value, bytes: owned.bytes });
		this.pendingRebindControlBytes += owned.bytes;
	}

	private flushPendingRebindControls(): void {
		const controls = this.pendingRebindControls.splice(0);
		this.pendingRebindControlBytes = 0;
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			for (const control of controls) {
				void this.enqueueControl(subscriber.subscriptionId, control.value, undefined, "source_control");
			}
		}
	}

	private clearPendingRebindControls(): void {
		this.pendingRebindControls.splice(0);
		this.pendingRebindControlBytes = 0;
	}

	private createProjector(options: ConversationProjectionSubscriberOptions): StreamProjector {
		return new StreamProjector(options.sanitizer === undefined ? {} : { sanitizer: options.sanitizer });
	}

	private seedActiveAssistant(
		subscriber: ConversationProjectionSubscriber,
		replaceProjector: boolean,
	): RpcConversationActiveAssistant | null {
		if (replaceProjector) {
			subscriber.projector = this.createProjector(subscriber.options);
		} else {
			this.reportDiagnostics(subscriber, subscriber.projector.discontinuity().diagnostics);
		}
		if (!this.activeAssistantSourceEvent) {
			return null;
		}
		const batch = subscriber.projector.push(this.activeAssistantSourceEvent);
		this.reportDiagnostics(subscriber, batch.diagnostics);
		for (let index = batch.frames.length - 1; index >= 0; index--) {
			const active = activeAssistantFromFrame(batch.frames[index]!);
			if (active) return active;
		}
		throw new Error("Active assistant source event did not project to a full snapshot");
	}

	private createBootstrap(
		subscriber: ConversationProjectionSubscriber,
		reason: RpcConversationBootstrapReason,
		cursor: number,
		requestId?: string,
		replaceProjector = false,
	): RpcConversationBootstrapEvent {
		const subscriptionId = subscriber.subscriptionId;
		const branchEpoch = this._branchEpoch;
		const activeAssistant = this.seedActiveAssistant(subscriber, replaceProjector);
		this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
		const context: ConversationProjectionSnapshotContext = {
			source: this.source,
			subscriptionId,
			branchEpoch,
			reason,
			activeAssistant,
			activeWorkflows: this.captureActiveWorkflows(),
			...(requestId === undefined ? {} : { requestId }),
		};
		const snapshot = subscriber.options.buildSnapshot(context);
		this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
		this.registerTranscriptCursor(snapshot.transcript.nextBeforeEntryId);
		return Object.freeze({
			type: "conversation_bootstrap",
			delivery: Object.freeze({ subscriptionId, cursor }),
			conversation: snapshot.conversation,
			state: snapshot.state,
			transcript: snapshot.transcript,
			activeAssistant: snapshot.activeAssistant,
			activeWorkflows: snapshot.activeWorkflows,
			reason,
			...(requestId === undefined ? {} : { requestId }),
		});
	}

	private enqueueOrdinaryFrame(
		subscriber: ConversationProjectionSubscriber,
		frame: object,
		deferOverflowRotation = false,
	): void {
		if (subscriber.fenced || subscriber.overflowRotationPending) return;
		const cursor = this.takeNextCursor(subscriber);
		const value = Object.freeze({
			...frame,
			delivery: Object.freeze({ subscriptionId: subscriber.subscriptionId, cursor }),
		});
		const item = this.createQueueItem(subscriber, value, "ordinary");
		if (subscriber.attaching) {
			if (this.wouldOverflowNormal(subscriber, item)) {
				throw new Error("Conversation attaching tail exceeds outbound queue bounds");
			}
			subscriber.attachingTail.push(item);
			subscriber.attachingTailBytes += item.bytes;
			return;
		}
		if (this.wouldOverflowNormal(subscriber, item)) {
			if (deferOverflowRotation) {
				this.scheduleSubscriberOverflowRotation(subscriber);
			} else {
				this.rotateSubscriberForOverflow(subscriber);
			}
			return;
		}
		this.enqueueItem(subscriber, item);
	}

	private reduceExternalState(canonical: OwnedJsonObject): void {
		const event = canonical.value;
		if (!isRecord(event) || typeof event.workflowId !== "string" || !event.workflowId) {
			return;
		}
		const recognized =
			event.type === "workflow_start" ||
			event.type === "workflow_update" ||
			event.type === "workflow_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end";
		if (!recognized) return;
		const eventBytes = canonical.bytes;
		const workflowId = event.workflowId;
		if (event.type === "workflow_end") {
			const removed = this.workflowSnapshots.get(workflowId);
			if (removed) {
				this.canonicalWorkflowBytes -= (removed.workflowEvent?.bytes ?? 0) + removed.activeToolBytes;
				this.workflowSnapshots.delete(workflowId);
			}
			return;
		}
		if (event.type === "workflow_start" || event.type === "workflow_update") {
			if (
				!this.workflowSnapshots.has(workflowId) &&
				this.workflowSnapshots.size >= DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS
			) {
				throw new Error(
					`Conversation projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS}-workflow canonical-state limit`,
				);
			}
			const snapshot =
				this.workflowSnapshots.get(workflowId) ??
				({
					activeTools: new Map<string, CanonicalWorkflowEvent>(),
					activeToolBytes: 0,
				} satisfies MutableRawWorkflowSnapshot);
			const nextCanonicalBytes = this.canonicalWorkflowBytes - (snapshot.workflowEvent?.bytes ?? 0) + eventBytes;
			this.assertCanonicalWorkflowCapacity(nextCanonicalBytes);
			snapshot.workflowEvent = { value: canonical.value, bytes: eventBytes };
			this.canonicalWorkflowBytes = nextCanonicalBytes;
			this.workflowSnapshots.set(workflowId, snapshot);
			return;
		}
		if (typeof event.toolCallId !== "string" || !event.toolCallId) {
			return;
		}
		if (event.type === "tool_execution_start") {
			if (
				!this.workflowSnapshots.has(workflowId) &&
				this.workflowSnapshots.size >= DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS
			) {
				throw new Error(
					`Conversation projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_WORKFLOWS}-workflow canonical-state limit`,
				);
			}
			const snapshot =
				this.workflowSnapshots.get(workflowId) ??
				({
					activeTools: new Map<string, CanonicalWorkflowEvent>(),
					activeToolBytes: 0,
				} satisfies MutableRawWorkflowSnapshot);
			if (
				!snapshot.activeTools.has(event.toolCallId) &&
				snapshot.activeTools.size >= DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW
			) {
				throw new Error(
					`Conversation projection workflow ${workflowId} exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ACTIVE_TOOLS_PER_WORKFLOW}-tool canonical-state limit`,
				);
			}
			const previousBytes = snapshot.activeTools.get(event.toolCallId)?.bytes ?? 0;
			const nextCanonicalBytes = this.canonicalWorkflowBytes - previousBytes + eventBytes;
			this.assertCanonicalWorkflowCapacity(nextCanonicalBytes);
			snapshot.activeTools.set(event.toolCallId, { value: canonical.value, bytes: eventBytes });
			snapshot.activeToolBytes += eventBytes - previousBytes;
			this.canonicalWorkflowBytes = nextCanonicalBytes;
			this.workflowSnapshots.set(workflowId, snapshot);
			return;
		}
		if (event.type === "tool_execution_end") {
			const snapshot = this.workflowSnapshots.get(workflowId);
			if (!snapshot) return;
			const removed = snapshot.activeTools.get(event.toolCallId);
			if (removed) {
				snapshot.activeTools.delete(event.toolCallId);
				snapshot.activeToolBytes -= removed.bytes;
				this.canonicalWorkflowBytes -= removed.bytes;
			}
			if (!snapshot.workflowEvent && snapshot.activeTools.size === 0) {
				this.workflowSnapshots.delete(workflowId);
			}
		}
	}

	private assertCanonicalWorkflowCapacity(bytes: number): void {
		if (bytes > DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_BYTES) {
			throw new Error(
				`Conversation projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_CANONICAL_WORKFLOW_BYTES}-byte canonical workflow-state limit`,
			);
		}
	}

	private captureActiveWorkflows(): readonly ConversationProjectionRawWorkflowSnapshot[] {
		return Object.freeze(
			[...this.workflowSnapshots.entries()].map(([workflowId, snapshot]) =>
				Object.freeze({
					workflowId,
					...(snapshot.workflowEvent === undefined ? {} : { workflowEvent: snapshot.workflowEvent.value }),
					activeTools: Object.freeze([...snapshot.activeTools.values()].map((entry) => entry.value)),
				}),
			),
		);
	}

	private enqueueControl(
		subscriptionId: string,
		value: object,
		onAdmitted?: (preparedValue: object) => void,
		kind: "control" | "source_control" = "control",
	): Promise<void> {
		const subscriber = this.subscribersById.get(subscriptionId);
		if (!subscriber?.active) {
			return Promise.reject(new Error(`Unknown or stale conversation subscription: ${subscriptionId}`));
		}
		if (subscriber.fenced) {
			return Promise.reject(new Error("Conversation projection subscription is terminally fenced"));
		}
		// Transcript pages mutate the same reducer domain as checkpoint transcript
		// state. A response captured on an older generation is obsolete, not a
		// transport failure; omit it while preserving unrelated command responses.
		if (isStaleTranscriptControl(value, this._branchEpoch)) {
			onAdmitted?.(value);
			return Promise.resolve();
		}
		const deferred = createDeferred<void>();
		try {
			const item = this.createQueueItem(subscriber, value, kind, deferred);
			this.assertNormalCapacity(subscriber, item, "Conversation control output exceeds the normal pending lane");
			if (subscriber.attaching) {
				subscriber.attachingTail.push(item);
				subscriber.attachingTailBytes += item.bytes;
				onAdmitted?.(item.value);
			} else {
				this.enqueueItem(subscriber, item, false, onAdmitted);
			}
		} catch (error: unknown) {
			const queueError = toError(error);
			deferred.reject(queueError);
			this.failSubscriber(subscriber, queueError);
		}
		return deferred.promise;
	}

	private fenceAndEnqueueTerminal(
		subscriptionId: string,
		value: object,
		onAdmitted?: (preparedValue: object) => void,
	): Promise<void> {
		const subscriber = this.subscribersById.get(subscriptionId);
		if (!subscriber?.active) {
			return Promise.reject(new Error(`Unknown or stale conversation subscription: ${subscriptionId}`));
		}
		if (subscriber.fenced) {
			return Promise.reject(new Error("Conversation projection subscription is already terminally fenced"));
		}

		const deferred = createDeferred<void>();
		try {
			subscriber.fenced = true;
			this.dropAllPendingItems(subscriber, new Error("Superseded by terminal conversation fence"));
			const item = this.createQueueItem(subscriber, value, "terminal", deferred);
			this.assertAuthorityCapacity(subscriber, item, "Conversation terminal output exceeds its authority slot");
			// At most one value may already be in flight. The terminal is otherwise
			// the next and final value handed to transport.
			this.enqueueItem(subscriber, item, true, onAdmitted);
		} catch (error: unknown) {
			const queueError = toError(error);
			deferred.reject(queueError);
			this.failSubscriber(subscriber, queueError);
		}
		return deferred.promise;
	}

	private createQueueItem(
		subscriber: ConversationProjectionSubscriber,
		value: object,
		kind: QueueItemKind,
		deferred?: Deferred<void>,
	): SubscriberQueueItem {
		let candidate = value;
		let preparedBytes: number | undefined;
		if (subscriber.options.prepare) {
			const prepared = subscriber.options.prepare(value);
			candidate = prepared.value;
			preparedBytes = prepared.bytes;
		}
		const ownBudget = subscriber.options.prepare
			? subscriber.bounds.maxQueuedBytes
			: subscriber.options.measureBytes
				? DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES
				: subscriber.bounds.maxQueuedBytes - 1;
		const owned = ownBudget <= 0 ? null : ownJsonObjectWithin(candidate, ownBudget);
		if (owned === null) {
			throw new Error(`Conversation ${kind} output exceeds outbound queue byte bounds`);
		}
		if (preparedBytes !== undefined && preparedBytes !== owned.bytes + 1) {
			throw new Error("Conversation prepared byte count does not match its JSONL wire value");
		}
		const measuredBytes = preparedBytes ?? subscriber.options.measureBytes?.(owned.value);
		const bytes = measuredBytes ?? owned.bytes + 1;
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error("measureBytes must return a non-negative safe integer");
		}
		if (bytes > subscriber.bounds.maxQueuedBytes) {
			throw new Error(`Conversation ${kind} output exceeds its encoded-record byte bound`);
		}
		return { value: owned.value, bytes, kind, ...(deferred === undefined ? {} : { deferred }) };
	}

	private enqueueItem(
		subscriber: ConversationProjectionSubscriber,
		item: SubscriberQueueItem,
		priority = false,
		onAdmitted?: (preparedValue: object) => void,
	): void {
		if (!subscriber.active) {
			item.deferred?.reject(new Error("Conversation projection subscription is closed"));
			return;
		}
		if (isAuthorityItem(item)) {
			if (subscriber.pendingAuthority !== undefined) {
				throw new Error("Conversation projection authority slot is already occupied");
			}
			subscriber.pendingAuthority = item;
		} else {
			subscriber.pendingNormalCount++;
			subscriber.pendingNormalBytes += item.bytes;
		}
		if (priority) subscriber.pending.unshift(item);
		else subscriber.pending.push(item);
		// Admission is the causal boundary between the command tracker and the
		// physical FIFO. Invoke it after the immutable record owns queue capacity,
		// but before drainSubscriber can hand the record to transport.
		onAdmitted?.(item.value);
		this.drainSubscriber(subscriber);
	}

	private flushAttachingTail(subscriber: ConversationProjectionSubscriber): void {
		const tail = subscriber.attachingTail.splice(0);
		subscriber.attachingTailBytes = 0;
		for (let index = 0; index < tail.length; index++) {
			const item = tail[index]!;
			if (this.wouldOverflowNormal(subscriber, item)) {
				const error = new Error("Conversation attaching tail exceeds outbound queue bounds");
				for (let remaining = index; remaining < tail.length; remaining++) {
					tail[remaining]!.deferred?.reject(error);
				}
				throw error;
			}
			this.enqueueItem(subscriber, item);
		}
	}

	private wouldOverflowNormal(subscriber: ConversationProjectionSubscriber, item: SubscriberQueueItem): boolean {
		if (isAuthorityItem(item)) {
			throw new Error("Authority records do not consume the normal pending lane");
		}
		return (
			subscriber.pendingNormalCount + subscriber.attachingTail.length + 1 > subscriber.bounds.maxQueuedEnvelopes ||
			subscriber.pendingNormalBytes + subscriber.attachingTailBytes + item.bytes > subscriber.bounds.maxQueuedBytes
		);
	}

	private assertNormalCapacity(
		subscriber: ConversationProjectionSubscriber,
		item: SubscriberQueueItem,
		message: string,
	): void {
		if (this.wouldOverflowNormal(subscriber, item)) {
			throw new Error(message);
		}
	}

	private assertAuthorityCapacity(
		subscriber: ConversationProjectionSubscriber,
		item: SubscriberQueueItem,
		message: string,
	): void {
		if (!isAuthorityItem(item) || item.bytes > subscriber.bounds.maxQueuedBytes) {
			throw new Error(message);
		}
		if (subscriber.pendingAuthority !== undefined) {
			throw new Error("Conversation projection authority slot is already occupied");
		}
	}

	private scheduleSubscriberOverflowRotation(subscriber: ConversationProjectionSubscriber): void {
		subscriber.overflowRotationPending = true;
		queueMicrotask(() => {
			if (!subscriber.active || subscriber.fenced || !subscriber.overflowRotationPending) return;
			subscriber.overflowRotationPending = false;
			try {
				this.rotateSubscriberForOverflow(subscriber);
			} catch (error: unknown) {
				this.failSubscriber(subscriber, toError(error));
			}
		});
	}

	private rotateSubscriberForOverflow(subscriber: ConversationProjectionSubscriber): void {
		subscriber.overflowRotationPending = false;
		this.notifySubscriberAuthorityChanging(subscriber);
		this.dropPendingConversationItems(subscriber, new Error("Superseded by overflow subscription bootstrap"));
		this.subscribersById.delete(subscriber.subscriptionId);
		subscriber.subscriptionId = this.mintId("subscriptionId");
		subscriber.nextCursor = 1;
		subscriber.projector = this.createProjector(subscriber.options);
		subscriber.checkpoints.clear();
		subscriber.checkpointRequestTimes.splice(0);
		subscriber.pendingCheckpointRequestId = undefined;
		this.subscribersById.set(subscriber.subscriptionId, subscriber);
		subscriber.attaching = true;
		const subscriptionId = subscriber.subscriptionId;
		const branchEpoch = this._branchEpoch;
		const bootstrap = this.createBootstrap(subscriber, "overflow", 0, undefined, true);
		const item = this.createQueueItem(subscriber, bootstrap, "checkpoint");
		this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
		this.assertAuthorityCapacity(subscriber, item, "Overflow bootstrap exceeds its authority slot");
		this.enqueueItem(subscriber, item);
		this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
		subscriber.attaching = false;
		this.flushAttachingTail(subscriber);
	}

	private rotateAllSubscriptions(
		reason: Extract<RpcConversationBootstrapReason, "branch_rebase" | "session_rebind">,
		notifyAuthorityChanging = true,
	): void {
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			try {
				if (notifyAuthorityChanging) {
					this.notifySubscriberAuthorityChanging(subscriber);
				}
				this.dropPendingConversationItems(subscriber, new Error("Superseded by conversation generation change"));
				this.subscribersById.delete(subscriber.subscriptionId);
				subscriber.subscriptionId = this.mintId("subscriptionId");
				subscriber.nextCursor = 1;
				subscriber.projector = this.createProjector(subscriber.options);
				subscriber.checkpoints.clear();
				subscriber.checkpointRequestTimes.splice(0);
				subscriber.pendingCheckpointRequestId = undefined;
				subscriber.overflowRotationPending = false;
				this.subscribersById.set(subscriber.subscriptionId, subscriber);
				subscriber.attaching = true;
				const subscriptionId = subscriber.subscriptionId;
				const branchEpoch = this._branchEpoch;
				const bootstrap = this.createBootstrap(subscriber, reason, 0, undefined, true);
				const item = this.createQueueItem(subscriber, bootstrap, "checkpoint");
				this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
				this.assertAuthorityCapacity(subscriber, item, "Generation bootstrap exceeds its authority slot");
				this.enqueueItem(subscriber, item);
				this.assertSubscriberGeneration(subscriber, subscriptionId, branchEpoch);
				subscriber.attaching = false;
				this.flushAttachingTail(subscriber);
			} catch (error: unknown) {
				this.failSubscriber(subscriber, toError(error));
			}
		}
	}

	private prunePendingOrdinaryTail(subscriber: ConversationProjectionSubscriber): void {
		const retained: SubscriberQueueItem[] = [];
		for (const item of subscriber.pending) {
			if (item.kind === "ordinary") {
				item.deferred?.reject(new Error("Superseded by conversation recovery checkpoint"));
				continue;
			}
			retained.push(item);
		}
		subscriber.pending.splice(0, subscriber.pending.length, ...retained);
		this.recalculatePendingAccounting(subscriber);
		subscriber.attachingTail.splice(0);
		subscriber.attachingTailBytes = 0;
	}

	private dropPendingConversationItems(subscriber: ConversationProjectionSubscriber, error: Error): void {
		const retained: SubscriberQueueItem[] = [];
		for (const item of [...subscriber.pending, ...subscriber.attachingTail]) {
			if (item.kind === "source_control") {
				item.deferred?.resolve(undefined);
				continue;
			}
			if (item.kind !== "control") {
				item.deferred?.reject(error);
				continue;
			}
			if (
				isStaleTranscriptControl(item.value, this._branchEpoch) ||
				(this.sourceAuthorityError !== undefined && isConversationProjectionControl(item.value))
			) {
				item.deferred?.resolve(undefined);
				continue;
			}
			retained.push(item);
		}
		subscriber.pending.splice(0, subscriber.pending.length, ...retained);
		this.recalculatePendingAccounting(subscriber);
		subscriber.attachingTail.splice(0);
		subscriber.attachingTailBytes = 0;
	}

	private dropAllPendingItems(subscriber: ConversationProjectionSubscriber, error: Error): void {
		for (const item of subscriber.pending.splice(0)) {
			item.deferred?.reject(error);
		}
		subscriber.pendingNormalCount = 0;
		subscriber.pendingNormalBytes = 0;
		subscriber.pendingAuthority = undefined;
		for (const item of subscriber.attachingTail.splice(0)) {
			item.deferred?.reject(error);
		}
		subscriber.attachingTailBytes = 0;
		subscriber.pendingCheckpointRequestId = undefined;
	}

	private drainSubscriber(subscriber: ConversationProjectionSubscriber): void {
		if (subscriber.draining || !subscriber.active) return;
		subscriber.draining = true;
		void (async () => {
			try {
				while (subscriber.active && subscriber.pending.length > 0) {
					const item = subscriber.pending.shift()!;
					this.accountDequeuedPendingItem(subscriber, item);
					subscriber.inFlight = item;
					// Never hand a second value to transport until this promise settles.
					await subscriber.options.write(item.value);
					subscriber.inFlight = undefined;
					if (
						item.kind === "checkpoint" &&
						subscriber.pendingCheckpointRequestId !== undefined &&
						isRecord(item.value) &&
						item.value.requestId === subscriber.pendingCheckpointRequestId
					) {
						subscriber.pendingCheckpointRequestId = undefined;
					}
					item.deferred?.resolve(undefined);
					if (item.kind === "terminal") {
						this.detachSubscriber(subscriber);
						break;
					}
				}
			} catch (error: unknown) {
				this.failSubscriber(subscriber, toError(error));
			} finally {
				subscriber.draining = false;
				if (subscriber.active && subscriber.pending.length > 0) {
					this.drainSubscriber(subscriber);
				} else {
					this.settleFlushWaiters(subscriber);
				}
			}
		})();
	}

	private flushSubscriber(subscriber: ConversationProjectionSubscriber): Promise<void> {
		if (!subscriber.active) {
			return Promise.reject(new Error("Conversation projection subscription is closed"));
		}
		if (!subscriber.inFlight && subscriber.pending.length === 0 && !subscriber.draining) {
			return Promise.resolve();
		}
		const deferred = createDeferred<void>();
		subscriber.flushWaiters.push(deferred);
		return deferred.promise;
	}

	private settleFlushWaiters(subscriber: ConversationProjectionSubscriber, error?: Error): void {
		for (const waiter of subscriber.flushWaiters.splice(0)) {
			if (error) waiter.reject(error);
			else waiter.resolve(undefined);
		}
	}

	private detachSubscriber(subscriber: ConversationProjectionSubscriber, error?: Error): void {
		if (!subscriber.active) return;
		subscriber.active = false;
		this.subscribers.delete(subscriber);
		this.subscribersById.delete(subscriber.subscriptionId);
		if (this.subscribers.size === 0) this.stopSourceObservation();
		subscriber.authorityChangeListeners.clear();
		const closeError = error ?? new Error("Conversation projection subscription detached");
		for (const item of subscriber.pending.splice(0)) item.deferred?.reject(closeError);
		subscriber.pendingNormalCount = 0;
		subscriber.pendingNormalBytes = 0;
		subscriber.pendingAuthority = undefined;
		for (const item of subscriber.attachingTail.splice(0)) item.deferred?.reject(closeError);
		subscriber.attachingTailBytes = 0;
		subscriber.pendingCheckpointRequestId = undefined;
		subscriber.inFlight?.deferred?.reject(closeError);
		this.settleFlushWaiters(subscriber, closeError);
	}

	private failSubscriber(subscriber: ConversationProjectionSubscriber, error: Error): void {
		if (!subscriber.active) return;
		this.detachSubscriber(subscriber, error);
		try {
			subscriber.options.onError?.(error);
		} catch {}
	}

	private reportDiagnostics(
		subscriber: ConversationProjectionSubscriber,
		diagnostics: readonly ProjectionDiagnostic[],
	): void {
		for (const diagnostic of diagnostics) {
			try {
				subscriber.options.onDiagnostic?.(diagnostic);
			} catch {}
		}
	}

	private notifySubscriberAuthorityChanging(subscriber: ConversationProjectionSubscriber): void {
		for (const listener of [...subscriber.authorityChangeListeners]) {
			try {
				listener();
			} catch {
				// Authority rotation is irrevocably underway. A consumer's
				// cleanup observer cannot roll it back or prevent the fresh bootstrap.
			}
		}
	}

	private notifyAllSubscriberAuthorityChanging(): void {
		for (const subscriber of [...this.subscribers]) {
			if (!subscriber.active || subscriber.fenced) continue;
			this.notifySubscriberAuthorityChanging(subscriber);
		}
	}

	private rememberCheckpoint(
		subscriber: ConversationProjectionSubscriber,
		request: ConversationProjectionRecoveryRequest,
		receipt: ConversationProjectionCheckpointReceipt,
	): void {
		if (subscriber.checkpoints.size >= subscriber.maxCheckpointRequests) {
			const oldest = subscriber.checkpoints.keys().next().value;
			if (oldest !== undefined) subscriber.checkpoints.delete(oldest);
		}
		subscriber.checkpoints.set(request.requestId, { request, receipt });
	}

	private recordCheckpointRequestRate(subscriber: ConversationProjectionSubscriber): void {
		const now = this.now();
		if (!Number.isFinite(now)) {
			throw new Error("Conversation projection clock returned a non-finite value");
		}
		const cutoff = now - subscriber.checkpointWindowMs;
		while (subscriber.checkpointRequestTimes.length > 0 && subscriber.checkpointRequestTimes[0]! <= cutoff) {
			subscriber.checkpointRequestTimes.shift();
		}
		if (subscriber.checkpointRequestTimes.length >= subscriber.maxCheckpointsPerWindow) {
			throw new Error("Conversation recovery checkpoint rate limit exceeded");
		}
		subscriber.checkpointRequestTimes.push(now);
	}

	private takeNextCursor(subscriber: ConversationProjectionSubscriber): number {
		const cursor = subscriber.nextCursor;
		if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor >= Number.MAX_SAFE_INTEGER) {
			throw new Error("Conversation delivery cursor exhausted");
		}
		subscriber.nextCursor++;
		return cursor;
	}

	private mintId(name: string): string {
		const id = this.createId();
		if (
			typeof id !== "string" ||
			!id ||
			id !== id.trim() ||
			projectRpcUtf8Prefix(id, RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES).truncated
		) {
			throw new Error(`${name} factory returned an invalid id`);
		}
		return id;
	}

	private resetTranscriptCursors(): void {
		this.transcriptCursors.clear();
		this.transcriptCursorOrder.splice(0);
	}

	private recalculatePendingAccounting(subscriber: ConversationProjectionSubscriber): void {
		let pendingNormalCount = 0;
		let pendingNormalBytes = 0;
		let pendingAuthority: SubscriberQueueItem | undefined;
		for (const item of subscriber.pending) {
			if (isAuthorityItem(item)) {
				if (pendingAuthority !== undefined) {
					throw new Error("Conversation projection pending queue contains multiple authority records");
				}
				pendingAuthority = item;
			} else {
				pendingNormalCount++;
				pendingNormalBytes += item.bytes;
			}
		}
		subscriber.pendingNormalCount = pendingNormalCount;
		subscriber.pendingNormalBytes = pendingNormalBytes;
		subscriber.pendingAuthority = pendingAuthority;
	}

	private accountDequeuedPendingItem(subscriber: ConversationProjectionSubscriber, item: SubscriberQueueItem): void {
		if (isAuthorityItem(item)) {
			if (subscriber.pendingAuthority !== item) {
				throw new Error("Conversation projection authority queue accounting diverged");
			}
			subscriber.pendingAuthority = undefined;
			return;
		}
		if (subscriber.pendingNormalCount <= 0 || subscriber.pendingNormalBytes < item.bytes) {
			throw new Error("Conversation projection normal queue accounting diverged");
		}
		subscriber.pendingNormalCount--;
		subscriber.pendingNormalBytes -= item.bytes;
	}

	private isSubscriberGenerationCurrent(
		subscriber: ConversationProjectionSubscriber,
		subscriptionId: string,
		branchEpoch: string,
	): boolean {
		return (
			!this.disposed &&
			subscriber.active &&
			!subscriber.fenced &&
			subscriber.subscriptionId === subscriptionId &&
			this.subscribersById.get(subscriptionId) === subscriber &&
			this._branchEpoch === branchEpoch
		);
	}

	private assertSubscriberGeneration(
		subscriber: ConversationProjectionSubscriber,
		subscriptionId: string,
		branchEpoch: string,
	): void {
		if (!this.isSubscriberGenerationCurrent(subscriber, subscriptionId, branchEpoch)) {
			throw new Error("Conversation projection generation changed during authority preparation");
		}
	}

	private assertActive(): void {
		this.assertNotDisposed();
		if (this.sourceAuthorityError !== undefined) {
			throw this.sourceAuthorityError;
		}
		if (this.poisonedError !== undefined) {
			throw new Error(`Conversation projection generation is poisoned: ${this.poisonedError.message}`);
		}
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new Error("Conversation projection feed is disposed");
		}
	}
}
