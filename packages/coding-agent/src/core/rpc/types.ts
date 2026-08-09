/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines to an RPC transport.
 * Responses and events are emitted as JSON lines by the transport.
 *
 * Every type here is derived (`Static`) from the TypeBox contract schemas in
 * ./schema/ — the single source of truth shared by runtime validation and the
 * exported JSON Schema artifact (issue #90). The one exception is the
 * recursive RpcProjectionTruncation, which stays hand-written and is pinned
 * to its schema via `Type.Unsafe` in schema/projections.ts.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import type { Static } from "typebox";
import type {
	RpcAgentOptionsDefaultConfigSchema,
	RpcAgentOptionsModelSelectionSchema,
	RpcAgentOptionsSchema,
} from "./schema/agent-options.ts";
import type { RPC_COMMAND_SCHEMAS, RpcClientCapabilityFeatureSchema } from "./schema/commands.ts";
import type {
	RpcConversationActiveAssistantSchema,
	RpcConversationAssistantPartSchema,
	RpcConversationBootstrapEventSchema,
	RpcConversationDeliveryPositionSchema,
	RpcConversationTranscriptItemSchema,
	RpcConversationTranscriptPageSchema,
	RpcConversationWorkflowSnapshotSchema,
	RpcQueueUpdateEventSchema,
	RpcSessionTreeNodeSchema,
	RpcSessionTreePageSchema,
	RpcTranscriptEntryEventSchema,
} from "./schema/conversation.ts";
import type {
	RpcExtensionErrorEventSchema,
	RpcExtensionUIRequestSchema,
	RpcExtensionUIResponseSchema,
	RpcGitContextChangedEventSchema,
	RpcHostActionRequestSchema,
	RpcHostActionResponseSchema,
	RpcHostActionUpdateSchema,
	RpcModelsChangedEventSchema,
	RpcPendingHostActionsResponseSchema,
	RpcSubagentDisposedEventSchema,
	RpcSubagentEndEventSchema,
	RpcSubagentEventSchema,
	RpcUiActionStateChangedEventSchema,
} from "./schema/events.ts";
import type { RpcGitContextSchema } from "./schema/git-context.ts";
import type {
	RpcMcpAuthResponseSchema,
	RpcMcpCapabilitiesResponseSchema,
	RpcSlashCommandSchema,
} from "./schema/mcp.ts";
import type {
	RpcAgentModeSchema,
	RpcPlanExecutionResultSchema,
	RpcPlanExecutionSchema,
	RpcPlanExecutionStrategySchema,
	RpcPlanningStateChangedEventSchema,
	RpcPlanningStateSchema,
	RpcPlanPhaseSchema,
	RpcPlanStateSchema,
	RpcPlanStepSchema,
	RpcPlanStepStatusSchema,
} from "./schema/planning.ts";
import type {
	RpcAssistantStreamPositionSchema,
	RpcConversationAuthoritySchema,
	RpcConversationBootstrapReasonSchema,
	RpcConversationDiscontinuityReasonSchema,
	RpcPushPlatformSchema,
	RpcPushProviderSchema,
	RpcRegisterPushTargetArgsSchema,
	RpcUiActionListScopeSchema,
} from "./schema/primitives.ts";
import type {
	RpcProjectionCollectionTruncationSchema,
	RpcReviewWorkflowDescriptorSchema,
	RpcReviewWorkflowLifecycleStatusSchema,
	RpcReviewWorkflowListResponseSchema,
	RpcReviewWorkflowResultResponseSchema,
	RpcWorkflowEventSchema,
	RpcWorkflowKindSchema,
	RpcWorkflowStatusSchema,
	RpcWorkflowToolEventSchema,
} from "./schema/projections.ts";
import type {
	RPC_RESPONSE_SCHEMAS,
	RpcErrorResponseSchema,
	RpcMcpPromptContentResponseSchema,
	RpcMcpPromptsResponseSchema,
	RpcMcpRecentCallsResponseSchema,
	RpcMcpResourceContentResponseSchema,
	RpcMcpResourcesResponseSchema,
	RpcMcpServerResponseSchema,
	RpcMcpServersResponseSchema,
	RpcMcpToolResponseSchema,
	RpcMcpToolsResponseSchema,
	RpcMessageImageSchema,
	RpcMessageImagesResponseSchema,
	RpcTranscriptEntryTextResponseSchema,
} from "./schema/responses.ts";
import type {
	RpcActiveCompactionSchema,
	RpcActiveRetrySchema,
	RpcActiveToolExecutionSchema,
	RpcCatalogModelSchema,
	RpcKeepAwakeStatusSchema,
	RpcListSubagentsResponseSchema,
	RpcPromptResponseSchema,
	RpcQueuedMessageSchema,
	RpcQueueUpdateProjectionSchema,
	RpcRegisterPushTargetResponseSchema,
	RpcSessionListItemSchema,
	RpcSessionStateProjectionSchema,
	RpcSessionStateSchema,
	RpcSubagentDefinitionSchema,
	RpcSubagentDefinitionSourceSchema,
	RpcSubagentSourceInfoSchema,
	RpcSubagentStartResponseSchema,
	RpcTranscriptItemSchema,
	RpcTranscriptResponseSchema,
	RpcTranscriptSummaryItemSchema,
	RpcTranscriptTextItemSchema,
	RpcTranscriptToolItemSchema,
	RpcTranscriptToolStatusSchema,
	RpcWebSearchStatusSchema,
} from "./schema/session.ts";
import type {
	UiActionArgumentDescriptorSchema,
	UiActionArgumentTypeSchema,
	UiActionCapabilitiesSchema,
	UiActionCapabilityFeatureSchema,
	UiActionCategorySchema,
	UiActionCompletionListResponseSchema,
	UiActionDescriptorSchema,
	UiActionInvocationQueueBehaviorSchema,
	UiActionInvocationResponseSchema,
	UiActionInvocationStatusSchema,
	UiActionListResponseSchema,
	UiActionOptionDescriptorSchema,
	UiActionPresentationHintSchema,
	UiActionPresentationKindSchema,
	UiActionScalarSchema,
	UiActionSlashAliasSchema,
	UiActionSourceSchema,
	UiActionStateDescriptorSchema,
	UiActionStateTypeSchema,
	UiActionStreamingBehaviorSchema,
} from "./schema/ui-actions.ts";

export { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES } from "./wire-limits.ts";

export type RpcModel = Model<Api>;
/** A model as reported to clients with host-owned selectable capabilities. */
export type RpcCatalogModel = Static<typeof RpcCatalogModelSchema>;
export type RpcSubagentDefinitionSource = Static<typeof RpcSubagentDefinitionSourceSchema>;

/**
 * Optimistic authority captured from one ordered-conversation bootstrap.
 * Remote mutations must present the complete tuple so a command queued behind
 * another client's rebind cannot act on the replacement conversation.
 */
export type RpcConversationAuthority = Static<typeof RpcConversationAuthoritySchema>;

export type RpcAgentOptionsModelSelection = Static<typeof RpcAgentOptionsModelSelectionSchema>;
export type RpcAgentOptionsDefaultConfig = Static<typeof RpcAgentOptionsDefaultConfigSchema>;
export type RpcAgentOptions = Static<typeof RpcAgentOptionsSchema>;

// ============================================================================
// RPC Commands
// ============================================================================

/**
 * The client→host command union, derived member-by-member from the TypeBox
 * contract schemas (schema/commands.ts). Every member carries a correlation
 * `id` that is optional except where the command contract requires it
 * (invoke_ui_action and report_stream_discontinuity), plus an optional
 * `conversationAuthority`.
 */
export type RpcCommandType = keyof typeof RPC_COMMAND_SCHEMAS;
export type RpcCommand = { [K in RpcCommandType]: Static<(typeof RPC_COMMAND_SCHEMAS)[K]> }[RpcCommandType];

// ============================================================================
// RPC Native UI Actions
// ============================================================================

export type UiActionSource = Static<typeof UiActionSourceSchema>;
export type UiActionCategory = Static<typeof UiActionCategorySchema>;
export type UiActionPresentationKind = Static<typeof UiActionPresentationKindSchema>;
export type UiActionArgumentType = Static<typeof UiActionArgumentTypeSchema>;
export type UiActionStateType = Static<typeof UiActionStateTypeSchema>;
export type UiActionStreamingBehavior = Static<typeof UiActionStreamingBehaviorSchema>;
export type UiActionScalar = Static<typeof UiActionScalarSchema>;
export type UiActionListScope = Static<typeof RpcUiActionListScopeSchema>;
export type UiActionInvocationQueueBehavior = Static<typeof UiActionInvocationQueueBehaviorSchema>;
export type UiActionInvocationStatus = Static<typeof UiActionInvocationStatusSchema>;
export type UiActionCapabilityFeature = Static<typeof UiActionCapabilityFeatureSchema>;
export type RpcClientCapabilityFeature = Static<typeof RpcClientCapabilityFeatureSchema>;

export type UiActionOptionDescriptor = Static<typeof UiActionOptionDescriptorSchema>;
export type UiActionPresentationHint = Static<typeof UiActionPresentationHintSchema>;
export type UiActionArgumentDescriptor = Static<typeof UiActionArgumentDescriptorSchema>;
export type UiActionStateDescriptor = Static<typeof UiActionStateDescriptorSchema>;
export type UiActionSlashAlias = Static<typeof UiActionSlashAliasSchema>;
export type UiActionDescriptor = Static<typeof UiActionDescriptorSchema>;
export type UiActionCapabilities = Static<typeof UiActionCapabilitiesSchema>;
export type UiActionListResponse = Static<typeof UiActionListResponseSchema>;
export type UiActionCompletionListResponse = Static<typeof UiActionCompletionListResponseSchema>;
export type UiActionInvocationResponse = Static<typeof UiActionInvocationResponseSchema>;

// ============================================================================
// RPC Workflow Events
// ============================================================================

export type RpcWorkflowKind = Static<typeof RpcWorkflowKindSchema>;
export type RpcWorkflowStatus = Static<typeof RpcWorkflowStatusSchema>;

/**
 * Describes a value whose wire projection was reduced to satisfy a byte
 * budget. Hand-written because it is recursive; schema/projections.ts pins
 * the schema to this exact type.
 */
export interface RpcProjectionTruncation {
	truncated: true;
	/** UTF-8 JSON bytes before projection, or null when intentionally unmeasured or not JSON-serializable. */
	originalBytes: number | null;
	/** UTF-8 JSON bytes after projection, excluding this metadata record. */
	projectedBytes: number;
	omittedEntries?: number;
	fields?: Record<string, RpcProjectionTruncation>;
}

/** Describes a bounded ordered collection. Included entries always retain source order. */
export type RpcProjectionCollectionTruncation = Static<typeof RpcProjectionCollectionTruncationSchema>;

export type RpcWorkflowEvent = Static<typeof RpcWorkflowEventSchema>;
export type RpcWorkflowToolEvent = Static<typeof RpcWorkflowToolEventSchema>;

// ============================================================================
// Detached review workflows
// ============================================================================

export type RpcReviewWorkflowLifecycleStatus = Static<typeof RpcReviewWorkflowLifecycleStatusSchema>;
export type RpcReviewWorkflowDescriptor = Static<typeof RpcReviewWorkflowDescriptorSchema>;
export type RpcReviewWorkflowResultResponse = Static<typeof RpcReviewWorkflowResultResponseSchema>;
export type RpcReviewWorkflowListResponse = Static<typeof RpcReviewWorkflowListResponseSchema>;

// ============================================================================
// RPC Host Actions
// ============================================================================

export type RpcHostActionRequest = Static<typeof RpcHostActionRequestSchema>;
export type RpcHostActionUpdate = Static<typeof RpcHostActionUpdateSchema>;
export type RpcHostActionResponse = Static<typeof RpcHostActionResponseSchema>;
export type RpcPendingHostActionsResponse = Static<typeof RpcPendingHostActionsResponseSchema>;

// ============================================================================
// RPC Subagents
// ============================================================================

export type RpcSubagentSourceInfo = Static<typeof RpcSubagentSourceInfoSchema>;
export type RpcSubagentDefinition = Static<typeof RpcSubagentDefinitionSchema>;
export type RpcListSubagentsResponse = Static<typeof RpcListSubagentsResponseSchema>;
export type RpcSubagentStartResponse = Static<typeof RpcSubagentStartResponseSchema>;

// ============================================================================
// RPC Push Notifications
// ============================================================================

export type RpcPushProvider = Static<typeof RpcPushProviderSchema>;
export type RpcPushPlatform = Static<typeof RpcPushPlatformSchema>;
export type RpcRegisterPushTargetArgs = Static<typeof RpcRegisterPushTargetArgsSchema>;
export type RpcRegisterPushTargetResponse = Static<typeof RpcRegisterPushTargetResponseSchema>;

// ============================================================================
// RPC MCP management
// ============================================================================

export type RpcMcpCapabilitiesResponse = Static<typeof RpcMcpCapabilitiesResponseSchema>;
export type RpcMcpServersResponse = Static<typeof RpcMcpServersResponseSchema>;
export type RpcMcpServerResponse = Static<typeof RpcMcpServerResponseSchema>;
export type RpcMcpToolsResponse = Static<typeof RpcMcpToolsResponseSchema>;
export type RpcMcpToolResponse = Static<typeof RpcMcpToolResponseSchema>;
export type RpcMcpResourcesResponse = Static<typeof RpcMcpResourcesResponseSchema>;
export type RpcMcpResourceContentResponse = Static<typeof RpcMcpResourceContentResponseSchema>;
export type RpcMcpPromptsResponse = Static<typeof RpcMcpPromptsResponseSchema>;
export type RpcMcpPromptContentResponse = Static<typeof RpcMcpPromptContentResponseSchema>;
export type RpcMcpRecentCallsResponse = Static<typeof RpcMcpRecentCallsResponseSchema>;
export type RpcMcpAuthResponse = Static<typeof RpcMcpAuthResponseSchema>;

/** A command available for invocation via prompt */
export type RpcSlashCommand = Static<typeof RpcSlashCommandSchema>;

// ============================================================================
// RPC State
// ============================================================================

export type RpcSessionListItem = Static<typeof RpcSessionListItemSchema>;
/** Path-free host-observed metadata for one active session worktree. */
export type RpcGitContext = Static<typeof RpcGitContextSchema>;
export type RpcActiveToolExecution = Static<typeof RpcActiveToolExecutionSchema>;
export type RpcActiveCompaction = Static<typeof RpcActiveCompactionSchema>;
export type RpcActiveRetry = Static<typeof RpcActiveRetrySchema>;
/** One authoritative queued user message exposed to remote clients. */
export type RpcQueuedMessage = Static<typeof RpcQueuedMessageSchema>;
export type RpcQueueUpdateProjection = Static<typeof RpcQueueUpdateProjectionSchema>;
export type RpcSessionStateProjection = Static<typeof RpcSessionStateProjectionSchema>;
export type RpcSessionState = Static<typeof RpcSessionStateSchema>;
export type RpcAgentMode = Static<typeof RpcAgentModeSchema>;
export type RpcPlanPhase = Static<typeof RpcPlanPhaseSchema>;
export type RpcPlanStepStatus = Static<typeof RpcPlanStepStatusSchema>;
export type RpcPlanExecutionStrategy = Static<typeof RpcPlanExecutionStrategySchema>;
export type RpcPlanStep = Static<typeof RpcPlanStepSchema>;
export type RpcPlanExecution = Static<typeof RpcPlanExecutionSchema>;
export type RpcPlanState = Static<typeof RpcPlanStateSchema>;
export type RpcPlanningState = Static<typeof RpcPlanningStateSchema>;
export type RpcPlanExecutionResult = Static<typeof RpcPlanExecutionResultSchema>;

export type RpcTranscriptToolStatus = Static<typeof RpcTranscriptToolStatusSchema>;

/** Convenience supertype of the transcript item variants. */
export interface RpcTranscriptBaseItem {
	id: string;
	role: "user" | "assistant" | "system" | "tool" | "summary";
	timestamp: string;
}

export type RpcTranscriptTextItem = Static<typeof RpcTranscriptTextItemSchema>;
export type RpcTranscriptToolItem = Static<typeof RpcTranscriptToolItemSchema>;
export type RpcTranscriptSummaryItem = Static<typeof RpcTranscriptSummaryItemSchema>;
export type RpcTranscriptItem = Static<typeof RpcTranscriptItemSchema>;
export type RpcTranscriptResponse = Static<typeof RpcTranscriptResponseSchema>;

// ============================================================================
// Ordered conversation projection
// ============================================================================

export type RpcConversationDeliveryPosition = Static<typeof RpcConversationDeliveryPositionSchema>;
export type RpcAssistantStreamPosition = Static<typeof RpcAssistantStreamPositionSchema>;
export type RpcConversationDiscontinuityReason = Static<typeof RpcConversationDiscontinuityReasonSchema>;
/** `branch_rebase` retains conversation identity; `session_rebind` replaces it. */
export type RpcConversationBootstrapReason = Static<typeof RpcConversationBootstrapReasonSchema>;
/** Subscriber-sanitized active assistant state used to seed the decoder before tail delivery. */
export type RpcConversationActiveAssistant = Static<typeof RpcConversationActiveAssistantSchema>;
/** Canonical transcript shape used by authorized remote conversation streams. */
export type RpcConversationTranscriptItem = Static<typeof RpcConversationTranscriptItemSchema>;
export type RpcConversationAssistantPart = Static<typeof RpcConversationAssistantPartSchema>;
export type RpcConversationTranscriptPage = Static<typeof RpcConversationTranscriptPageSchema>;
export type RpcSessionTreeNode = Static<typeof RpcSessionTreeNodeSchema>;
export type RpcSessionTreePage = Static<typeof RpcSessionTreePageSchema>;
export type RpcConversationWorkflowSnapshot = Static<typeof RpcConversationWorkflowSnapshotSchema>;
export type RpcConversationBootstrapEvent = Static<typeof RpcConversationBootstrapEventSchema>;

/** Authoritative queue snapshot pushed on every queue mutation. */
export type RpcQueueUpdateEvent = Static<typeof RpcQueueUpdateEventSchema>;
/** One committed transcript entry pushed on the ordered conversation stream. */
export type RpcTranscriptEntryEvent = Static<typeof RpcTranscriptEntryEventSchema>;

/** One recovered image block: an ImageContent record plus its position on the message. */
export type RpcMessageImage = Static<typeof RpcMessageImageSchema>;
export type RpcMessageImagesResponse = Static<typeof RpcMessageImagesResponseSchema>;
/** One bounded chunk of a transcript entry's sanitized canonical text (get_transcript_entry_text). */
export type RpcTranscriptEntryTextResponse = Static<typeof RpcTranscriptEntryTextResponseSchema>;

/**
 * Host keep-awake (prevent sleep) state as reported to phones. Deliberately
 * omits the host-local mechanism (caffeinate etc.); `reason` is generic wording
 * present only when degraded.
 */
export type RpcKeepAwakeStatus = Static<typeof RpcKeepAwakeStatusSchema>;

/**
 * Host web-search key state as reported to phones. Deliberately omits the key
 * itself; only whether one is stored.
 */
export type RpcWebSearchStatus = Static<typeof RpcWebSearchStatusSchema>;

export type RpcPromptResponse = Static<typeof RpcPromptResponseSchema>;

// ============================================================================
// RPC Responses
// ============================================================================

/**
 * The host→client response union: one success member per command plus the
 * catch-all error member, derived from schema/responses.ts.
 */
export type RpcResponse =
	| { [K in RpcCommandType]: Static<(typeof RPC_RESPONSE_SCHEMAS)[K]> }[RpcCommandType]
	| Static<typeof RpcErrorResponseSchema>;

// ============================================================================
// Host→client events and client→host control messages
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest = Static<typeof RpcExtensionUIRequestSchema>;
/** Response to an extension UI request */
export type RpcExtensionUIResponse = Static<typeof RpcExtensionUIResponseSchema>;
/** Surfaced when an extension handler throws. */
export type RpcExtensionErrorEvent = Static<typeof RpcExtensionErrorEventSchema>;

/** Wraps any projected frame from a subagent's stream. */
export type RpcSubagentEvent = Static<typeof RpcSubagentEventSchema>;
export type RpcSubagentEndEvent = Static<typeof RpcSubagentEndEventSchema>;
export type RpcSubagentDisposedEvent = Static<typeof RpcSubagentDisposedEventSchema>;
/** Model catalog changed; clients re-fetch get_available_models. */
export type RpcModelsChangedEvent = Static<typeof RpcModelsChangedEventSchema>;
/** Full replacement of the active session's path-free Git context. */
export type RpcGitContextChangedEvent = Static<typeof RpcGitContextChangedEventSchema>;
/** Settled, bounded state of a host UI action. */
export type RpcUiActionStateChangedEvent = Static<typeof RpcUiActionStateChangedEventSchema>;
/** Full authoritative planning snapshot emitted after every mutation. */
export type RpcPlanningStateChangedEvent = Static<typeof RpcPlanningStateChangedEventSchema>;
