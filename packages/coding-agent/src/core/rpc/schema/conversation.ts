/**
 * Ordered-conversation projection schemas: assistant stream frames, queue
 * updates, transcript pages/entries, and the bootstrap envelope.
 *
 * Ordered-conversation frames are decorated post-construction with a
 * `delivery: {subscriptionId, cursor}` position by the projection feed
 * (conversation-projection-feed.ts) — the schemas declare it as optional even
 * where the constructing type does not, so the artifact matches the wire.
 */

import { Type } from "typebox";
import {
	RpcActiveToolCallStateSchema,
	RpcAssistantMessageSchema,
	RpcSlimAssistantEventSchema,
	RpcStopReasonSchema,
} from "./external.ts";
import { readonlyArrayOf, stringEnum } from "./helpers.ts";
import { RpcAssistantStreamPositionSchema, RpcConversationBootstrapReasonSchema } from "./primitives.ts";
import {
	RpcProjectionCollectionTruncationSchema,
	RpcProjectionTruncationSchema,
	RpcWorkflowEventSchema,
	RpcWorkflowToolEventSchema,
} from "./projections.ts";
import { RpcQueuedMessageSchema, RpcQueueUpdateProjectionSchema, RpcSessionStateSchema } from "./session.ts";

export const RpcConversationDeliveryPositionSchema = Type.Object(
	{
		subscriptionId: Type.String(),
		cursor: Type.Integer(),
	},
	{ additionalProperties: false },
);

const deliverySchema = Type.Optional(RpcConversationDeliveryPositionSchema);

/** Subscriber-sanitized active assistant state used to seed the decoder before tail delivery. */
export const RpcConversationActiveAssistantSchema = Type.Object(
	{
		stream: RpcAssistantStreamPositionSchema,
		message: RpcAssistantMessageSchema,
		toolState: Type.Optional(readonlyArrayOf(RpcActiveToolCallStateSchema)),
		projection: Type.Optional(RpcProjectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcConversationAssistantPartSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("text"), text: Type.String(), truncated: Type.Boolean() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("thinking"),
			text: Type.String(),
			truncated: Type.Optional(Type.Boolean()),
			redacted: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
]);

/** Canonical transcript shape used by authorized remote conversation streams. */
export const RpcConversationTranscriptItemSchema = Type.Object(
	{
		entryId: Type.String(),
		ordinal: Type.Integer(),
		createdAt: Type.String(),
		role: stringEnum(["user", "assistant", "system", "tool"]),
		text: Type.String(),
		truncated: Type.Boolean(),
		/** Stable submitting-client identity. Present only on remotely submitted user messages. */
		clientMessageId: Type.Optional(Type.String()),
		imageCount: Type.Optional(Type.Number()),
		toolName: Type.Optional(Type.String()),
		status: Type.Optional(stringEnum(["completed", "failed"])),
		summary: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		output: Type.Optional(Type.String()),
		outputTruncated: Type.Optional(Type.Boolean()),
		parts: Type.Optional(Type.Array(RpcConversationAssistantPartSchema)),
		stopReason: Type.Optional(RpcStopReasonSchema),
	},
	{ additionalProperties: false },
);

export const RpcConversationTranscriptPageSchema = Type.Object(
	{
		workspaceName: Type.Optional(Type.String()),
		sessionId: Type.String(),
		items: Type.Array(RpcConversationTranscriptItemSchema),
		hasMore: Type.Boolean(),
		nextBeforeEntryId: Type.Union([Type.String(), Type.Null()]),
		projectionVersion: Type.Number(),
		branchEpoch: Type.String(),
		head: Type.Union([
			Type.Object({ entryId: Type.String(), ordinal: Type.Integer() }, { additionalProperties: false }),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);

/** One sanitized, append-ordered node in a session's branch tree. */
export const RpcSessionTreeNodeSchema = Type.Object(
	{
		entryId: Type.String(),
		parentEntryId: Type.Union([Type.String(), Type.Null()]),
		ordinal: Type.Integer(),
		createdAt: Type.String(),
		activeBranch: Type.Boolean(),
		/** Null for structural entries that are not part of transcript projection. */
		transcript: Type.Union([RpcConversationTranscriptItemSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

/** Bounded append-order page of the current session's complete branch tree. */
export const RpcSessionTreePageSchema = Type.Object(
	{
		workspaceName: Type.Optional(Type.String()),
		sessionId: Type.String(),
		nodes: Type.Array(RpcSessionTreeNodeSchema),
		hasMore: Type.Boolean(),
		nextAfterOrdinal: Type.Union([Type.Integer(), Type.Null()]),
		projectionVersion: Type.Number(),
		head: Type.Union([
			Type.Object({ entryId: Type.String(), ordinal: Type.Integer() }, { additionalProperties: false }),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);

export const RpcConversationWorkflowSnapshotSchema = Type.Object(
	{
		/** Stable identity retained even when workflow details are projected away. */
		workflowId: Type.String(),
		workflowEvent: Type.Optional(RpcWorkflowEventSchema),
		activeTools: Type.Array(RpcWorkflowToolEventSchema),
		activeToolsProjection: Type.Optional(RpcProjectionCollectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcConversationBootstrapEventSchema = Type.Object(
	{
		type: Type.Literal("conversation_bootstrap"),
		delivery: RpcConversationDeliveryPositionSchema,
		conversation: Type.Object(
			{
				workspaceName: Type.String(),
				sessionId: Type.String(),
			},
			{ additionalProperties: false },
		),
		state: RpcSessionStateSchema,
		transcript: RpcConversationTranscriptPageSchema,
		activeAssistant: Type.Union([RpcConversationActiveAssistantSchema, Type.Null()]),
		activeWorkflows: Type.Array(RpcConversationWorkflowSnapshotSchema),
		reason: RpcConversationBootstrapReasonSchema,
		requestId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Assistant stream frames (message_start / message_update / message_end)
// ============================================================================

export const RpcMessageStartFrameSchema = Type.Object(
	{
		type: Type.Literal("message_start"),
		stream: RpcAssistantStreamPositionSchema,
		message: RpcAssistantMessageSchema,
		delivery: deliverySchema,
	},
	{ additionalProperties: false },
);

export const RpcMessageUpdateFrameSchema = Type.Object(
	{
		type: Type.Literal("message_update"),
		stream: RpcAssistantStreamPositionSchema,
		assistantMessageEvent: RpcSlimAssistantEventSchema,
		message: Type.Optional(RpcAssistantMessageSchema),
		toolState: Type.Optional(readonlyArrayOf(RpcActiveToolCallStateSchema)),
		delivery: deliverySchema,
	},
	{ additionalProperties: false },
);

export const RpcMessageEndFrameSchema = Type.Object(
	{
		type: Type.Literal("message_end"),
		stream: RpcAssistantStreamPositionSchema,
		message: RpcAssistantMessageSchema,
		delivery: deliverySchema,
	},
	{ additionalProperties: false },
);

/**
 * Authoritative queue snapshot pushed on every queue mutation. Built
 * structurally by projectRpcQueueUpdate (session-state.ts); this schema mints
 * the wire name the hand-written types never had.
 */
export const RpcQueueUpdateEventSchema = Type.Object(
	{
		type: Type.Literal("queue_update"),
		steering: readonlyArrayOf(RpcQueuedMessageSchema),
		followUp: readonlyArrayOf(RpcQueuedMessageSchema),
		projection: Type.Optional(RpcQueueUpdateProjectionSchema),
		delivery: deliverySchema,
	},
	{ additionalProperties: false },
);

/**
 * One committed transcript entry pushed on the ordered conversation stream
 * (daemon/conversation-projection.ts). Previously undeclared in types.ts
 * despite being strict-decoded by the iOS client.
 */
export const RpcTranscriptEntryEventSchema = Type.Object(
	{
		type: Type.Literal("transcript_entry"),
		entry: RpcConversationTranscriptItemSchema,
		final: Type.Boolean(),
		delivery: deliverySchema,
	},
	{ additionalProperties: false },
);
