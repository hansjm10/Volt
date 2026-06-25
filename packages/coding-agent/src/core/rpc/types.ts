/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines to an RPC transport.
 * Responses and events are emitted as JSON lines by the transport.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/volt-ai";
import type { SessionStats } from "../agent-session.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { HostActionDecisionKind, HostActionRequest, HostActionUpdate } from "../host-interaction.ts";
import type { SourceInfo } from "../source-info.ts";

export type RpcModel = Model<Api>;

// ============================================================================
// RPC Commands
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// Client capabilities and host-initiated actions
	| { id?: string; type: "set_client_capabilities"; features: RpcClientCapabilityFeature[] }
	| { id?: string; type: "get_pending_host_actions" }

	// Native UI actions
	| { id?: string; type: "get_ui_capabilities" }
	| { id?: string; type: "get_ui_actions"; scope?: UiActionListScope }
	| {
			id?: string;
			type: "get_ui_action_completions";
			action: string;
			argument: string;
			prefix?: string;
	  }
	| {
			id?: string;
			type: "invoke_ui_action";
			action: string;
			args?: Record<string, unknown>;
			streamingBehavior?: UiActionInvocationQueueBehavior;
	  }

	// Push notifications
	| { id?: string; type: "register_push_target"; args: RpcRegisterPushTargetArgs }

	// Remote host management
	| { id?: string; type: "unregister_workspace"; name: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_transcript"; limit?: number; beforeEntryId?: string }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "switch_session_by_id"; sessionId: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC Native UI Actions
// ============================================================================

export type UiActionSource = "builtin" | "extension" | "prompt" | "skill" | "package";
export type UiActionCategory =
	| "review"
	| "session"
	| "model"
	| "context"
	| "extension"
	| "prompt"
	| "skill"
	| "advanced";
export type UiActionPresentationKind = "card" | "button" | "toggle" | "picker" | "palette" | "detail" | "hidden";
export type UiActionArgumentType = "string" | "boolean" | "enum" | "integer";
export type UiActionStateType = "boolean" | "string" | "enum" | "integer";
export type UiActionStreamingBehavior = "disabled" | "immediate" | "queueSteer" | "queueFollowUp";
export type UiActionScalar = string | number | boolean | null;
export type UiActionListScope = "primary" | "palette" | "all";
export type UiActionInvocationQueueBehavior = "steer" | "followUp";
export type UiActionInvocationStatus = "accepted" | "completed" | "queued" | "handled" | "cancelled";
export type UiActionCapabilityFeature =
	| "ui_actions.v1"
	| "ui_action_invocation.v1"
	| "ui_action_completions.v1"
	| (string & {});
export type RpcClientCapabilityFeature = "host_action_requests.v1" | (string & {});

export interface UiActionOptionDescriptor {
	value: string;
	label?: string;
	description?: string;
}

export interface UiActionPresentationHint {
	kind: UiActionPresentationKind | (string & {});
	group?: string;
	priority?: number;
	icon?: string;
}

export interface UiActionArgumentDescriptor {
	name: string;
	label?: string;
	description?: string;
	type: UiActionArgumentType | (string & {});
	required?: boolean;
	multiline?: boolean;
	placeholder?: string;
	hint?: string;
	defaultValue?: UiActionScalar;
	options?: UiActionOptionDescriptor[];
	completion?: "commandArguments" | (string & {});
}

export interface UiActionStateDescriptor {
	type: UiActionStateType | (string & {});
	value: UiActionScalar;
	label?: string;
	options?: UiActionOptionDescriptor[];
}

export interface UiActionSlashAlias {
	name: string;
	example?: string;
}

export interface UiActionDescriptor {
	schemaVersion: 1;
	id: string;
	label: string;
	description?: string;
	source: UiActionSource | (string & {});
	sourceScope?: "user" | "project" | "temporary";
	sourceOrigin?: "package" | "top-level";
	sourceLabel?: string;
	category: UiActionCategory | (string & {});
	presentation?: UiActionPresentationHint;
	args?: UiActionArgumentDescriptor[];
	state?: UiActionStateDescriptor;
	enabled: boolean;
	disabledReason?: string | null;
	destructive?: boolean;
	requiresConfirmation?: boolean;
	streamingBehavior?: UiActionStreamingBehavior | UiActionStreamingBehavior[];
	remoteSafe: boolean;
	slash?: UiActionSlashAlias;
}

export interface UiActionCapabilities {
	protocolVersion: 1;
	features: UiActionCapabilityFeature[];
	maxActions: number;
	maxDescriptorBytes: number;
}

export interface UiActionListResponse {
	actions: UiActionDescriptor[];
}

export interface UiActionCompletionListResponse {
	completions: UiActionOptionDescriptor[];
}

export interface UiActionInvocationResponse {
	action: string;
	status: UiActionInvocationStatus;
	queuedAs?: UiActionInvocationQueueBehavior;
	state?: UiActionStateDescriptor;
	stateChanged?: boolean;
	actionsChanged?: boolean;
	message?: string;
}

// ============================================================================
// RPC Workflow Events
// ============================================================================

export type RpcWorkflowKind = "review" | (string & {});
export type RpcWorkflowStatus = "running" | "finalizing" | "completed" | "cancelled" | "failed" | (string & {});

export interface RpcWorkflowEvent {
	type: "workflow_start" | "workflow_update" | "workflow_end";
	workflowId: string;
	kind: RpcWorkflowKind;
	action?: string;
	title?: string;
	message?: string;
	status?: RpcWorkflowStatus;
}

export type RpcWorkflowToolEvent =
	| {
			type: "tool_execution_start";
			workflowId: string;
			workflowKind: RpcWorkflowKind;
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			args?: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_end";
			workflowId: string;
			workflowKind: RpcWorkflowKind;
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
	  };

// ============================================================================
// RPC Host Actions
// ============================================================================

export type RpcHostActionRequest = { type: "host_action_request" } & HostActionRequest;
export type RpcHostActionUpdate = { type: "host_action_update" } & HostActionUpdate;
export type RpcHostActionResponse = {
	type: "host_action_response";
	id: string;
	decision: Exclude<HostActionDecisionKind, "unavailable">;
	message?: string;
};

export interface RpcPendingHostActionsResponse {
	actions: RpcHostActionRequest[];
}

// ============================================================================
// RPC Push Notifications
// ============================================================================

export type RpcPushProvider = "fcm";
export type RpcPushPlatform = "ios";

export interface RpcLiveActivityRegistration {
	activityId: string;
	pushToken: string;
	tokenHash?: string;
}

export interface RpcRegisterPushTargetArgs {
	provider: RpcPushProvider;
	platform: RpcPushPlatform;
	pushTargetId: string;
	pushTargetAuthToken: string;
	relayUrl?: string;
	tokenHash?: string;
	liveActivity?: RpcLiveActivityRegistration;
	enabled: boolean;
}

export interface RpcRegisterPushTargetResponse {
	status: "registered";
	pushTargetId: string;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionListItem {
	sessionId: string;
	sessionName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	current: boolean;
}

export interface RpcSessionState {
	model?: RpcModel;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export type RpcTranscriptToolStatus = "started" | "completed" | "failed";

export interface RpcTranscriptBaseItem {
	id: string;
	role: "user" | "assistant" | "tool" | "summary";
	timestamp: string;
}

export interface RpcTranscriptTextItem extends RpcTranscriptBaseItem {
	role: "user" | "assistant";
	text: string;
}

export interface RpcTranscriptToolItem extends RpcTranscriptBaseItem {
	role: "tool";
	toolName: string;
	status: RpcTranscriptToolStatus;
	path?: string;
	summary: string;
	diffPreview?: string;
	patchPreview?: string;
}

export interface RpcTranscriptSummaryItem extends RpcTranscriptBaseItem {
	role: "summary";
	title: "Conversation compacted";
	text: string;
}

export type RpcTranscriptItem = RpcTranscriptTextItem | RpcTranscriptToolItem | RpcTranscriptSummaryItem;

export interface RpcTranscriptResponse {
	sessionId: string;
	items: RpcTranscriptItem[];
	hasMore: boolean;
	nextBeforeEntryId: string | null;
}

// ============================================================================
// RPC Responses
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// Client capabilities and host-initiated actions
	| { id?: string; type: "response"; command: "set_client_capabilities"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_pending_host_actions";
			success: true;
			data: RpcPendingHostActionsResponse;
	  }

	// Native UI actions
	| { id?: string; type: "response"; command: "get_ui_capabilities"; success: true; data: UiActionCapabilities }
	| { id?: string; type: "response"; command: "get_ui_actions"; success: true; data: UiActionListResponse }
	| {
			id?: string;
			type: "response";
			command: "get_ui_action_completions";
			success: true;
			data: UiActionCompletionListResponse;
	  }
	| {
			id?: string;
			type: "response";
			command: "invoke_ui_action";
			success: true;
			data: UiActionInvocationResponse;
	  }

	// Push notifications
	| {
			id?: string;
			type: "response";
			command: "register_push_target";
			success: true;
			data: RpcRegisterPushTargetResponse;
	  }

	// Remote host management
	| {
			id?: string;
			type: "response";
			command: "unregister_workspace";
			success: true;
			data: {
				removedWorkspace: string;
				workspaceNames: string[];
				workspaces: Array<{ name: string; status: string }>;
			};
	  }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_transcript"; success: true; data: RpcTranscriptResponse }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: RpcModel;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: RpcModel; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: RpcModel[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: { sessions: RpcSessionListItem[] };
	  }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "switch_session_by_id"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
