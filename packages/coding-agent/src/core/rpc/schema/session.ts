/**
 * Session-state, transcript, subagent, and host-status contract schemas —
 * the payload shapes of the state-oriented responses.
 */

import { Type } from "typebox";
import { RpcModelSchema, rpcModelProperties } from "./external.ts";
import { RpcGitContextSchema } from "./git-context.ts";
import { readonlyArrayOf, stringEnum } from "./helpers.ts";
import { RpcPlanningStateSchema } from "./planning.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";
import { RpcProjectionCollectionTruncationSchema, RpcProjectionTruncationSchema } from "./projections.ts";

export const RpcSessionListItemSchema = Type.Object(
	{
		sessionId: Type.String(),
		sessionName: Type.Optional(Type.String()),
		createdAt: Type.String(),
		modifiedAt: Type.String(),
		messageCount: Type.Number(),
		firstMessage: Type.String(),
		current: Type.Boolean(),
		/** "subagent" when this session was created for a delegated subagent run. */
		origin: Type.Optional(Type.Literal("subagent")),
	},
	{ additionalProperties: false },
);

export const RpcActiveToolExecutionSchema = Type.Object(
	{
		toolCallId: Type.String(),
		toolName: Type.String(),
		status: Type.Literal("started"),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		/** Projected details from the newest tool_execution_update, so clients that
		 *  attach mid-turn can restore live tool state (currently `subagent` only). */
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		projection: Type.Optional(RpcProjectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcActiveCompactionSchema = Type.Object(
	{
		reason: stringEnum(["manual", "threshold", "overflow"]),
		/** Unix epoch milliseconds when the active compaction started. */
		startedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RpcActiveRetrySchema = Type.Object(
	{
		attempt: Type.Number(),
		maxAttempts: Type.Number(),
	},
	{ additionalProperties: false },
);

/** One authoritative queued user message exposed to remote clients. */
export const RpcQueuedMessageSchema = Type.Object(
	{
		/** Stable semantic identity supplied by the remote client, or an opaque
		 * queue-only identity for locally originated input. */
		clientMessageId: Type.String(),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcQueueUpdateProjectionSchema = Type.Object(
	{
		steering: Type.Optional(RpcProjectionCollectionTruncationSchema),
		followUp: Type.Optional(RpcProjectionCollectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcSessionStateProjectionSchema = Type.Object(
	{
		model: Type.Optional(RpcProjectionTruncationSchema),
		sessionFile: Type.Optional(RpcProjectionTruncationSchema),
		sessionName: Type.Optional(RpcProjectionTruncationSchema),
		steeringQueue: Type.Optional(RpcProjectionCollectionTruncationSchema),
		followUpQueue: Type.Optional(RpcProjectionCollectionTruncationSchema),
		activeTools: Type.Optional(RpcProjectionCollectionTruncationSchema),
		/** Top-level workflow collection metadata carried here so the atomic snapshot remains one envelope. */
		activeWorkflows: Type.Optional(RpcProjectionCollectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcSessionStateSchema = Type.Object(
	{
		model: Type.Optional(RpcModelSchema),
		thinkingLevel: RpcThinkingLevelSchema,
		availableThinkingLevels: Type.Array(RpcThinkingLevelSchema),
		/** Authoritative branch-local Fast mode state for bootstrap/checkpoint recovery. */
		fastModeEnabled: Type.Boolean(),
		/** Authoritative branch-local agent mode and structured plan snapshot. */
		planning: RpcPlanningStateSchema,
		/** Path-free host Git metadata, or null when the cwd is not a usable worktree. */
		gitContext: Type.Union([RpcGitContextSchema, Type.Null()]),
		/** Whether a provider run or session-level continuation is active. */
		isStreaming: Type.Boolean(),
		/** Whether any prompt work, including asynchronous preflight, is active. */
		isBusy: Type.Optional(Type.Boolean()),
		isCompacting: Type.Boolean(),
		steeringMode: stringEnum(["all", "one-at-a-time"]),
		followUpMode: stringEnum(["all", "one-at-a-time"]),
		sessionFile: Type.Optional(Type.String()),
		sessionId: Type.String(),
		sessionName: Type.Optional(Type.String()),
		autoCompactionEnabled: Type.Boolean(),
		messageCount: Type.Number(),
		pendingMessageCount: Type.Number(),
		/** Authoritative queue contents for atomic bootstrap/checkpoint recovery. Always emitted; the iOS bootstrap decoder fails closed without them. */
		steeringQueue: readonlyArrayOf(RpcQueuedMessageSchema),
		followUpQueue: readonlyArrayOf(RpcQueuedMessageSchema),
		activeTools: Type.Optional(Type.Array(RpcActiveToolExecutionSchema)),
		activeCompaction: Type.Optional(RpcActiveCompactionSchema),
		activeRetry: Type.Optional(RpcActiveRetrySchema),
		projection: Type.Optional(RpcSessionStateProjectionSchema),
	},
	{ additionalProperties: false },
);

/** A model as reported to clients with host-owned selectable capabilities. */
export const RpcCatalogModelSchema = Type.Object(
	{
		...rpcModelProperties,
		availableThinkingLevels: Type.Array(RpcThinkingLevelSchema),
		supportsFastMode: Type.Boolean(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Transcript projection (local RPC)
// ============================================================================

export const RpcTranscriptToolStatusSchema = stringEnum(["started", "completed", "failed"]);

const transcriptBaseProperties = {
	id: Type.String(),
	timestamp: Type.String(),
};

export const RpcTranscriptTextItemSchema = Type.Object(
	{
		...transcriptBaseProperties,
		role: stringEnum(["user", "assistant", "system"]),
		text: Type.String(),
		/** Stable submitting-client identity. Present only on remotely submitted user messages. */
		clientMessageId: Type.Optional(Type.String()),
		/** Number of inline image blocks on the persisted user message. Transcript
		 *  projections are text-only; clients recover the blocks per entry via
		 *  `get_message_images`. */
		imageCount: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const RpcTranscriptToolItemSchema = Type.Object(
	{
		...transcriptBaseProperties,
		role: Type.Literal("tool"),
		toolName: Type.String(),
		status: RpcTranscriptToolStatusSchema,
		path: Type.Optional(Type.String()),
		summary: Type.String(),
		/** Number of inline image blocks on the persisted tool result (for example
		 *  a `read` of an image file). Transcript projections are text-only;
		 *  clients recover the blocks per entry via `get_message_images`. */
		imageCount: Type.Optional(Type.Number()),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		diffPreview: Type.Optional(Type.String()),
		patchPreview: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcTranscriptSummaryItemSchema = Type.Object(
	{
		...transcriptBaseProperties,
		role: Type.Literal("summary"),
		title: Type.Literal("Conversation compacted"),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcTranscriptItemSchema = Type.Union([
	RpcTranscriptTextItemSchema,
	RpcTranscriptToolItemSchema,
	RpcTranscriptSummaryItemSchema,
]);

export const RpcTranscriptResponseSchema = Type.Object(
	{
		sessionId: Type.String(),
		items: Type.Array(RpcTranscriptItemSchema),
		hasMore: Type.Boolean(),
		nextBeforeEntryId: Type.Union([Type.String(), Type.Null()]),
		/** Present for ordered remote pagination and correlated to the request's bootstrap generation. */
		branchEpoch: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Subagents
// ============================================================================

export const RpcSubagentDefinitionSourceSchema = stringEnum(["built-in", "user", "project"]);

export const RpcSubagentSourceInfoSchema = Type.Object(
	{
		source: Type.String(),
		scope: stringEnum(["user", "project", "temporary"]),
		origin: stringEnum(["package", "top-level"]),
	},
	{ additionalProperties: false },
);

export const RpcSubagentDefinitionSchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		source: RpcSubagentDefinitionSourceSchema,
		sourceInfo: RpcSubagentSourceInfoSchema,
		tools: Type.Optional(Type.Array(Type.String())),
		excludedTools: Type.Optional(Type.Array(Type.String())),
		allowedSubagents: Type.Optional(Type.Array(Type.String())),
		maxSubagentDepth: Type.Optional(Type.Number()),
		maxChildAgents: Type.Optional(Type.Number()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcListSubagentsResponseSchema = Type.Object(
	{ subagents: Type.Array(RpcSubagentDefinitionSchema) },
	{ additionalProperties: false },
);

export const RpcSubagentStartResponseSchema = Type.Object(
	{
		subagentId: Type.String(),
		sessionId: Type.String(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Push registration responses
// ============================================================================

export const RpcRegisterPushTargetResponseSchema = Type.Object(
	{
		status: Type.Literal("registered"),
		pushTargetId: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcRegisterLiveActivityResponseSchema = Type.Object(
	{
		status: Type.Literal("registered"),
		activityId: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcUnregisterLiveActivityResponseSchema = Type.Object(
	{
		status: Type.Literal("unregistered"),
		activityId: Type.String(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Host status + prompt admission
// ============================================================================

/**
 * Host keep-awake (prevent sleep) state as reported to phones. Deliberately
 * omits the host-local mechanism (caffeinate etc.); `reason` is generic wording
 * present only when degraded.
 */
export const RpcKeepAwakeStatusSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		state: stringEnum(["disabled", "active", "degraded"]),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/**
 * Host web-search key state as reported to phones. Deliberately omits the key
 * itself; only whether one is stored.
 */
export const RpcWebSearchStatusSchema = Type.Object({ configured: Type.Boolean() }, { additionalProperties: false });

export const RpcPromptResponseSchema = Type.Object(
	{
		clientMessageId: Type.String(),
		outcome: stringEnum(["admitted", "completed"]),
		/** Present when a canonical identified user entry completed this input. */
		canonicalEntryId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
