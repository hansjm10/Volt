/**
 * One TypeBox schema per RPC command — the schema-first source of truth for
 * the client→host command contract (issue #90).
 *
 * Every command object is strict (`additionalProperties: false`): an unknown
 * field is contract drift, not forward compatibility. Unknown command *types*
 * remain the dispatcher's business — see rpc-command-validation.ts.
 */

import { type TLiteral, type TObject, type TOptional, type TProperties, type TString, Type } from "typebox";
import { openStringEnum, stringEnum } from "./helpers.ts";
import { RpcAgentModeSchema, RpcPlanExecutionStrategySchema } from "./planning.ts";
import {
	RPC_TRIMMED_NON_EMPTY_PATTERN,
	RpcAssistantStreamPositionSchema,
	RpcClientMessageIdSchema,
	RpcConversationAuthoritySchema,
	RpcConversationDiscontinuityReasonSchema,
	RpcConversationIdentifierSchema,
	RpcConversationInputImagesSchema,
	RpcQueueModeSchema,
	RpcRegisterPushTargetArgsSchema,
	RpcSafeNonNegativeIntegerSchema,
	RpcStreamingBehaviorSchema,
	RpcThinkingLevelSchema,
	RpcUiActionListScopeSchema,
} from "./primitives.ts";

export const RpcClientCapabilityFeatureSchema = openStringEnum(["host_action_requests.v1", "planning_state.v1"]);
export const RpcMcpAuthFlowSchema = stringEnum(["browser", "device"]);

/**
 * Builds one strict command schema. Shared fields are flattened in (never
 * `Type.Intersect` — intersections composing `additionalProperties: false`
 * are unsatisfiable in JSON Schema): the optional correlation `id` and the
 * optional `conversationAuthority` carried by every command. Commands that
 * require correlation, such as invoke_ui_action, declare their schema
 * directly below.
 *
 * The return type is declared explicitly — TypeScript approximates object
 * literals that spread a generic to the bare `TProperties` index signature,
 * which would erase every `Static` command type (caught by
 * type-assertions.ts). The declared shape is exactly what the runtime value
 * holds, so the cast is sound. `properties` is required (pass `{}`) because
 * an omitted generic argument resolves `P` to its constraint, with the same
 * type-erasing effect.
 */
type CommandProperties<K extends string, P extends TProperties> = {
	id: TOptional<TString>;
	type: TLiteral<K>;
	conversationAuthority: TOptional<typeof RpcConversationAuthoritySchema>;
} & P;

function commandSchema<K extends string, P extends TProperties>(
	type: K,
	properties: P,
): TObject<CommandProperties<K, P>> {
	return Type.Object(
		{
			id: Type.Optional(Type.String()),
			type: Type.Literal(type),
			conversationAuthority: Type.Optional(RpcConversationAuthoritySchema),
			...properties,
		},
		{ additionalProperties: false },
	) as TObject<CommandProperties<K, P>>;
}

const workspaceNameSchema = Type.String({
	pattern: RPC_TRIMMED_NON_EMPTY_PATTERN,
	"x-volt-expected": "be a non-empty workspace name",
});

/**
 * Every RPC command schema, keyed by its `type` discriminant. This map is the
 * source of truth for the command contract: `RpcCommand`/`RpcCommandType` in
 * ../types.ts derive from it, validation compiles it, and the JSON Schema
 * artifact exports it.
 */
export const RPC_COMMAND_SCHEMAS = {
	// Prompting
	prompt: commandSchema("prompt", {
		clientMessageId: RpcClientMessageIdSchema,
		message: Type.String(),
		images: Type.Optional(RpcConversationInputImagesSchema),
		streamingBehavior: Type.Optional(RpcStreamingBehaviorSchema),
	}),
	steer: commandSchema("steer", {
		clientMessageId: RpcClientMessageIdSchema,
		message: Type.String(),
		images: Type.Optional(RpcConversationInputImagesSchema),
	}),
	follow_up: commandSchema("follow_up", {
		clientMessageId: RpcClientMessageIdSchema,
		message: Type.String(),
		images: Type.Optional(RpcConversationInputImagesSchema),
	}),
	abort: commandSchema("abort", {}),
	new_session: commandSchema("new_session", {
		parentSession: Type.Optional(Type.String()),
	}),
	set_agent_mode: commandSchema("set_agent_mode", {
		mode: RpcAgentModeSchema,
	}),
	plan_execute: commandSchema("plan_execute", {
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
		strategy: RpcPlanExecutionStrategySchema,
	}),
	plan_change: commandSchema("plan_change", {
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
	}),
	plan_discard: commandSchema("plan_discard", {
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
	}),

	// Client capabilities and host-initiated actions
	set_client_capabilities: commandSchema("set_client_capabilities", {
		features: Type.Array(RpcClientCapabilityFeatureSchema, { "x-volt-expected": "be an array of strings" }),
	}),
	get_pending_host_actions: commandSchema("get_pending_host_actions", {}),

	// Ordered conversation recovery. The command id is the recovery request id;
	// only the same-subscription checkpoint carrying that id can clear the fence.
	report_stream_discontinuity: Type.Object(
		{
			id: RpcConversationIdentifierSchema,
			type: Type.Literal("report_stream_discontinuity"),
			conversationAuthority: Type.Optional(RpcConversationAuthoritySchema),
			sessionId: RpcConversationIdentifierSchema,
			subscriptionId: RpcConversationIdentifierSchema,
			lastAppliedCursor: RpcSafeNonNegativeIntegerSchema,
			assistantPosition: Type.Optional(RpcAssistantStreamPositionSchema),
			reason: RpcConversationDiscontinuityReasonSchema,
		},
		{ additionalProperties: false },
	),

	// Native UI actions
	get_ui_capabilities: commandSchema("get_ui_capabilities", {}),
	get_ui_actions: commandSchema("get_ui_actions", {
		scope: Type.Optional(RpcUiActionListScopeSchema),
	}),
	get_ui_action_completions: commandSchema("get_ui_action_completions", {
		action: Type.String(),
		argument: Type.String(),
		prefix: Type.Optional(Type.String()),
	}),
	invoke_ui_action: Type.Object(
		{
			id: RpcConversationIdentifierSchema,
			type: Type.Literal("invoke_ui_action"),
			conversationAuthority: Type.Optional(RpcConversationAuthoritySchema),
			action: Type.String(),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			streamingBehavior: Type.Optional(RpcStreamingBehaviorSchema),
		},
		{ additionalProperties: false },
	),

	// Detached review workflows
	cancel_workflow: commandSchema("cancel_workflow", { workflowId: RpcConversationIdentifierSchema }),
	get_review_result: commandSchema("get_review_result", { workflowId: RpcConversationIdentifierSchema }),
	list_review_workflows: commandSchema("list_review_workflows", {}),
	open_review_session: commandSchema("open_review_session", { workflowId: RpcConversationIdentifierSchema }),

	// Push notifications
	register_push_target: commandSchema("register_push_target", {
		args: RpcRegisterPushTargetArgsSchema,
	}),

	// Remote host management
	unregister_workspace: commandSchema("unregister_workspace", { name: workspaceNameSchema }),
	set_keep_awake: commandSchema("set_keep_awake", { enabled: Type.Boolean() }),
	get_keep_awake: commandSchema("get_keep_awake", {}),
	set_web_search_key: commandSchema("set_web_search_key", {
		apiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	}),
	get_web_search_status: commandSchema("get_web_search_status", {}),
	get_agent_options: commandSchema("get_agent_options", {
		workspaceName: workspaceNameSchema,
	}),

	// Device diagnostics
	upload_device_logs: commandSchema("upload_device_logs", {
		fileName: Type.Optional(Type.String()),
		content: Type.String(),
	}),

	// MCP management
	get_mcp_capabilities: commandSchema("get_mcp_capabilities", {}),
	list_mcp_servers: commandSchema("list_mcp_servers", {}),
	get_mcp_server: commandSchema("get_mcp_server", { server: Type.String() }),
	connect_mcp_server: commandSchema("connect_mcp_server", { server: Type.String() }),
	disconnect_mcp_server: commandSchema("disconnect_mcp_server", { server: Type.String() }),
	refresh_mcp_server: commandSchema("refresh_mcp_server", { server: Type.String() }),
	start_mcp_server_auth: commandSchema("start_mcp_server_auth", {
		server: Type.String(),
		flow: Type.Optional(RpcMcpAuthFlowSchema),
		redirectUrl: Type.Optional(Type.String()),
	}),
	complete_mcp_server_auth: commandSchema("complete_mcp_server_auth", {
		server: Type.String(),
		redirectUrl: Type.String(),
		code: Type.String(),
		state: Type.Optional(Type.String()),
	}),
	poll_mcp_server_auth: commandSchema("poll_mcp_server_auth", { server: Type.String() }),
	cancel_mcp_server_auth: commandSchema("cancel_mcp_server_auth", { server: Type.String() }),
	logout_mcp_server: commandSchema("logout_mcp_server", { server: Type.String() }),
	set_mcp_server_enabled: commandSchema("set_mcp_server_enabled", {
		server: Type.String(),
		enabled: Type.Boolean(),
	}),
	list_mcp_tools: commandSchema("list_mcp_tools", { server: Type.String() }),
	get_mcp_tool: commandSchema("get_mcp_tool", { server: Type.String(), tool: Type.String() }),
	list_mcp_resources: commandSchema("list_mcp_resources", {
		server: Type.String(),
		cursor: Type.Optional(Type.String()),
	}),
	read_mcp_resource: commandSchema("read_mcp_resource", {
		server: Type.String(),
		resourceUri: Type.String(),
	}),
	list_mcp_prompts: commandSchema("list_mcp_prompts", {
		server: Type.String(),
		cursor: Type.Optional(Type.String()),
	}),
	get_mcp_prompt: commandSchema("get_mcp_prompt", {
		server: Type.String(),
		prompt: Type.String(),
		arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		argumentsJson: Type.Optional(Type.String()),
	}),
	list_mcp_recent_calls: commandSchema("list_mcp_recent_calls", {
		server: Type.Optional(Type.String()),
	}),

	// State
	get_state: commandSchema("get_state", {
		sessionId: Type.Optional(RpcConversationIdentifierSchema),
	}),
	get_transcript: commandSchema("get_transcript", {
		sessionId: Type.Optional(RpcConversationIdentifierSchema),
		limit: Type.Optional(Type.Number()),
		beforeEntryId: Type.Optional(Type.String()),
		branchEpoch: Type.Optional(RpcConversationIdentifierSchema),
	}),
	get_message_images: commandSchema("get_message_images", {
		sessionId: Type.Optional(RpcConversationIdentifierSchema),
		entryId: Type.String(),
		startImageIndex: Type.Optional(Type.Number()),
	}),
	get_transcript_entry_text: commandSchema("get_transcript_entry_text", {
		sessionId: Type.Optional(RpcConversationIdentifierSchema),
		entryId: Type.String(),
		/** Start of the requested chunk, in Unicode scalars of the entry's sanitized canonical text. Defaults to 0. */
		offset: Type.Optional(Type.Number()),
	}),

	// Subagents (local RPC only)
	list_subagents: commandSchema("list_subagents", {}),
	subagent_start: commandSchema("subagent_start", { agent: Type.String(), prompt: Type.String() }),
	subagent_abort: commandSchema("subagent_abort", { subagentId: Type.String() }),
	subagent_get_state: commandSchema("subagent_get_state", { subagentId: Type.String() }),
	subagent_get_transcript: commandSchema("subagent_get_transcript", {
		subagentId: Type.String(),
		limit: Type.Optional(Type.Number()),
		beforeEntryId: Type.Optional(Type.String()),
	}),
	subagent_dispose: commandSchema("subagent_dispose", { subagentId: Type.String() }),

	// Model
	set_model: commandSchema("set_model", {
		provider: Type.String(),
		modelId: Type.String(),
		persistDefault: Type.Optional(Type.Boolean()),
	}),
	cycle_model: commandSchema("cycle_model", {}),
	get_available_models: commandSchema("get_available_models", {}),

	// Thinking
	set_thinking_level: commandSchema("set_thinking_level", {
		level: RpcThinkingLevelSchema,
		persistDefault: Type.Optional(Type.Boolean()),
	}),
	cycle_thinking_level: commandSchema("cycle_thinking_level", {}),

	// Queue modes
	set_steering_mode: commandSchema("set_steering_mode", { mode: RpcQueueModeSchema }),
	set_follow_up_mode: commandSchema("set_follow_up_mode", { mode: RpcQueueModeSchema }),

	// Compaction
	compact: commandSchema("compact", { customInstructions: Type.Optional(Type.String()) }),
	set_auto_compaction: commandSchema("set_auto_compaction", { enabled: Type.Boolean() }),

	// Retry
	set_auto_retry: commandSchema("set_auto_retry", { enabled: Type.Boolean() }),
	abort_retry: commandSchema("abort_retry", {}),

	// Bash
	bash: commandSchema("bash", {
		command: Type.String(),
		excludeFromContext: Type.Optional(Type.Boolean()),
	}),
	abort_bash: commandSchema("abort_bash", {}),

	// Session
	get_session_stats: commandSchema("get_session_stats", {}),
	list_sessions: commandSchema("list_sessions", {
		limit: Type.Optional(Type.Integer({ minimum: 1, "x-volt-expected": "be a positive integer" })),
		cursor: Type.Optional(Type.String({ minLength: 1, "x-volt-expected": "be a non-empty string" })),
	}),
	export_html: commandSchema("export_html", { outputPath: Type.Optional(Type.String()) }),
	switch_session: commandSchema("switch_session", { sessionPath: Type.String() }),
	switch_session_by_id: commandSchema("switch_session_by_id", { sessionId: Type.String() }),
	fork: commandSchema("fork", { entryId: Type.String() }),
	clone: commandSchema("clone", {}),
	get_fork_messages: commandSchema("get_fork_messages", {}),
	get_last_assistant_text: commandSchema("get_last_assistant_text", {}),
	set_session_name: commandSchema("set_session_name", { name: Type.String() }),

	// Messages
	get_messages: commandSchema("get_messages", {}),

	// Commands (available for invocation via prompt)
	get_commands: commandSchema("get_commands", {}),
} as const satisfies Record<string, TObject>;
