/**
 * Response schemas: one success member per command (double-discriminated by
 * `type: "response"` + `command`) plus the catch-all error member. The map is
 * keyed by RpcCommandType, so adding a command without declaring its response
 * shape fails typecheck.
 */

import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import { type TLiteral, type TObject, type TOptional, type TSchema, type TString, Type } from "typebox";
import type { RpcCommandType } from "../types.ts";
import { RPC_STABLE_ERROR_CODES } from "../wire-limits.ts";
import { RpcAgentOptionsSchema } from "./agent-options.ts";
import { RpcSessionTreePageSchema } from "./conversation.ts";
import { RpcPendingHostActionsResponseSchema } from "./events.ts";
import { RpcModelSchema } from "./external.ts";
import { opaque, openStringEnum } from "./helpers.ts";
import {
	RpcMcpAuthResponseSchema,
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpPromptSummarySchema,
	RpcMcpRecentCallSummarySchema,
	RpcMcpResourceSummarySchema,
	RpcMcpServerSummarySchema,
	RpcMcpToolSummarySchema,
	RpcSlashCommandSchema,
} from "./mcp.ts";
import { RpcPlanExecutionResultSchema, RpcPlanningStateSchema } from "./planning.ts";
import { RpcConversationIdentifierSchema, RpcThinkingLevelSchema } from "./primitives.ts";
import { RpcReviewWorkflowListResponseSchema, RpcReviewWorkflowResultResponseSchema } from "./projections.ts";
import {
	RpcCatalogModelSchema,
	RpcKeepAwakeStatusSchema,
	RpcListSubagentsResponseSchema,
	RpcPromptResponseSchema,
	RpcRegisterPushTargetResponseSchema,
	RpcSessionListItemSchema,
	RpcSessionStateSchema,
	RpcSubagentStartResponseSchema,
	RpcTranscriptResponseSchema,
	RpcWebSearchStatusSchema,
} from "./session.ts";
import {
	UiActionCapabilitiesSchema,
	UiActionCompletionListResponseSchema,
	UiActionInvocationResponseSchema,
	UiActionListResponseSchema,
} from "./ui-actions.ts";

// ============================================================================
// Response data bodies for host-internal result types
// ============================================================================

/** Wire projection of core/agent-session.ts SessionStats (pinned in type-assertions.ts). */
export const RpcSessionStatsSchema = Type.Object(
	{
		sessionFile: Type.Optional(Type.String()),
		sessionId: Type.String(),
		userMessages: Type.Number(),
		assistantMessages: Type.Number(),
		toolCalls: Type.Number(),
		toolResults: Type.Number(),
		totalMessages: Type.Number(),
		tokens: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
				total: Type.Number(),
			},
			{ additionalProperties: false },
		),
		cost: Type.Number(),
		/** Current retained model context, separate from lifetime token totals. */
		contextUsage: Type.Optional(
			Type.Object(
				{
					tokens: Type.Union([Type.Number(), Type.Null()]),
					contextWindow: Type.Number(),
					percent: Type.Union([Type.Number(), Type.Null()]),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** Wire projection of core/bash-executor.ts BashResult (pinned in type-assertions.ts). */
export const RpcBashResultSchema = Type.Object(
	{
		/** Combined stdout + stderr output (sanitized, possibly truncated) */
		output: Type.String(),
		/** Process exit code (absent if killed/cancelled) */
		exitCode: Type.Optional(Type.Number()),
		cancelled: Type.Boolean(),
		truncated: Type.Boolean(),
		/** Path to temp file containing full output (if output exceeded truncation threshold) */
		fullOutputPath: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** Wire projection of core/compaction CompactionResult (pinned in type-assertions.ts). */
export const RpcCompactionResultSchema = Type.Object(
	{
		summary: Type.String(),
		firstKeptEntryId: Type.String(),
		tokensBefore: Type.Number(),
		/** Estimated context tokens after rebuilding from the new compaction boundary. */
		estimatedTokensAfter: Type.Optional(Type.Number()),
		details: Type.Optional(opaque<JsonValue>("extension-specific compaction data")),
	},
	{ additionalProperties: false },
);

/** One recovered image block: an ImageContent record plus its position on the message. */
export const RpcMessageImageSchema = Type.Object(
	{
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
		index: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RpcMessageImagesResponseSchema = Type.Object(
	{
		sessionId: Type.String(),
		entryId: Type.String(),
		/** Total image blocks on the entry, including any not in this page. */
		totalImages: Type.Number(),
		images: Type.Array(RpcMessageImageSchema),
		/** Cursor for the next page, or null when all images have been returned. */
		nextImageIndex: Type.Union([Type.Number(), Type.Null()]),
	},
	{ additionalProperties: false },
);

/**
 * One bounded chunk of a transcript entry's sanitized canonical text
 * (get_transcript_entry_text). Remote-only: transcript projections truncate
 * long entries; clients page the remainder per entry through this response.
 */
export const RpcTranscriptEntryTextResponseSchema = Type.Object(
	{
		workspaceName: Type.String(),
		sessionId: Type.String(),
		entryId: Type.String(),
		/** Start of this chunk, in Unicode scalars of the sanitized canonical entry text. */
		offset: Type.Number(),
		/** At most 12,000 scalars of sanitized canonical entry text. */
		text: Type.String(),
		/** True when more text remains past this chunk. */
		truncated: Type.Boolean(),
		/** Cursor for the next chunk, or null when the entry text is complete. */
		nextOffset: Type.Union([Type.Number(), Type.Null()]),
		/** Scalar length of the entry's full sanitized canonical text. */
		totalScalars: Type.Number(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Response member builders
// ============================================================================

type VoidResponseProperties<K extends string> = {
	id: TOptional<TString>;
	type: TLiteral<"response">;
	command: TLiteral<K>;
	success: TLiteral<true>;
};

type DataResponseProperties<K extends string, D extends TSchema> = VoidResponseProperties<K> & { data: D };

function voidResponse<K extends string>(command: K): TObject<VoidResponseProperties<K>> {
	return Type.Object(
		{
			id: Type.Optional(Type.String()),
			type: Type.Literal("response"),
			command: Type.Literal(command),
			success: Type.Literal(true),
		},
		{ additionalProperties: false },
	) as TObject<VoidResponseProperties<K>>;
}

function dataResponse<K extends string, D extends TSchema>(command: K, data: D): TObject<DataResponseProperties<K, D>> {
	return Type.Object(
		{
			id: Type.Optional(Type.String()),
			type: Type.Literal("response"),
			command: Type.Literal(command),
			success: Type.Literal(true),
			data,
		},
		{ additionalProperties: false },
	) as TObject<DataResponseProperties<K, D>>;
}

const cancelledDataSchema = Type.Object({ cancelled: Type.Boolean() }, { additionalProperties: false });

export const RpcMcpServersResponseSchema = Type.Object(
	{ servers: Type.Array(RpcMcpServerSummarySchema) },
	{ additionalProperties: false },
);

export const RpcMcpToolsResponseSchema = Type.Object(
	{
		server: Type.String(),
		tools: Type.Array(RpcMcpToolSummarySchema),
		metadataHash: Type.Optional(Type.String()),
		stale: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const RpcMcpToolResponseSchema = Type.Object({ tool: RpcMcpToolSummarySchema }, { additionalProperties: false });

export const RpcMcpResourcesResponseSchema = Type.Object(
	{
		server: Type.String(),
		resources: Type.Array(RpcMcpResourceSummarySchema),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcMcpResourceContentResponseSchema = Type.Object(
	{ result: opaque<unknown>("MCP SDK resource content; passed through verbatim") },
	{ additionalProperties: false },
);

export const RpcMcpPromptsResponseSchema = Type.Object(
	{
		server: Type.String(),
		prompts: Type.Array(RpcMcpPromptSummarySchema),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcMcpPromptContentResponseSchema = Type.Object(
	{ result: opaque<unknown>("MCP SDK prompt content; passed through verbatim") },
	{ additionalProperties: false },
);

export const RpcMcpRecentCallsResponseSchema = Type.Object(
	{ calls: Type.Array(RpcMcpRecentCallSummarySchema) },
	{ additionalProperties: false },
);

export const RpcMcpServerResponseSchema = Type.Object(
	{
		server: RpcMcpServerSummarySchema,
		persisted: Type.Optional(
			Type.Object({ path: Type.String(), scope: Type.String() }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

/**
 * Every success response schema, keyed by the originating command. Keyed on
 * RpcCommandType so a new command cannot ship without declaring its response.
 */
export const RPC_RESPONSE_SCHEMAS = {
	// Prompting (async - events follow)
	prompt: dataResponse("prompt", RpcPromptResponseSchema),
	steer: voidResponse("steer"),
	follow_up: voidResponse("follow_up"),
	abort: voidResponse("abort"),
	new_session: dataResponse("new_session", cancelledDataSchema),
	set_agent_mode: dataResponse("set_agent_mode", RpcPlanningStateSchema),
	plan_execute: dataResponse("plan_execute", RpcPlanExecutionResultSchema),
	plan_change: dataResponse("plan_change", RpcPlanningStateSchema),
	plan_discard: dataResponse("plan_discard", RpcPlanningStateSchema),

	// Client capabilities and host-initiated actions
	set_client_capabilities: voidResponse("set_client_capabilities"),
	report_stream_discontinuity: Type.Object(
		{
			id: RpcConversationIdentifierSchema,
			type: Type.Literal("response"),
			command: Type.Literal("report_stream_discontinuity"),
			success: Type.Literal(true),
			data: Type.Object(
				{
					subscriptionId: Type.String(),
					requestId: Type.String(),
					checkpointCursor: Type.Integer(),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	get_pending_host_actions: dataResponse("get_pending_host_actions", RpcPendingHostActionsResponseSchema),

	// Native UI actions
	get_ui_capabilities: dataResponse("get_ui_capabilities", UiActionCapabilitiesSchema),
	get_ui_actions: dataResponse("get_ui_actions", UiActionListResponseSchema),
	get_ui_action_completions: dataResponse("get_ui_action_completions", UiActionCompletionListResponseSchema),
	invoke_ui_action: Type.Object(
		{
			id: RpcConversationIdentifierSchema,
			type: Type.Literal("response"),
			command: Type.Literal("invoke_ui_action"),
			success: Type.Literal(true),
			data: UiActionInvocationResponseSchema,
		},
		{ additionalProperties: false },
	),

	// Detached review workflows
	cancel_workflow: voidResponse("cancel_workflow"),
	get_review_result: dataResponse("get_review_result", RpcReviewWorkflowResultResponseSchema),
	list_review_workflows: dataResponse("list_review_workflows", RpcReviewWorkflowListResponseSchema),
	open_review_session: dataResponse("open_review_session", cancelledDataSchema),

	// Push notifications
	register_push_target: dataResponse("register_push_target", RpcRegisterPushTargetResponseSchema),

	// Remote host management
	unregister_workspace: dataResponse(
		"unregister_workspace",
		Type.Object(
			{
				removedWorkspace: Type.String(),
				workspaceNames: Type.Array(Type.String()),
				workspaces: Type.Array(
					Type.Object({ name: Type.String(), status: Type.String() }, { additionalProperties: false }),
				),
			},
			{ additionalProperties: false },
		),
	),
	set_keep_awake: dataResponse(
		"set_keep_awake",
		Type.Object({ keepAwake: RpcKeepAwakeStatusSchema }, { additionalProperties: false }),
	),
	get_keep_awake: dataResponse(
		"get_keep_awake",
		Type.Object({ keepAwake: RpcKeepAwakeStatusSchema }, { additionalProperties: false }),
	),
	set_web_search_key: dataResponse(
		"set_web_search_key",
		Type.Object({ webSearch: RpcWebSearchStatusSchema }, { additionalProperties: false }),
	),
	get_web_search_status: dataResponse(
		"get_web_search_status",
		Type.Object({ webSearch: RpcWebSearchStatusSchema }, { additionalProperties: false }),
	),
	get_agent_options: dataResponse("get_agent_options", RpcAgentOptionsSchema),

	// Device diagnostics
	upload_device_logs: dataResponse(
		"upload_device_logs",
		Type.Object({ path: Type.String(), byteCount: Type.Number() }, { additionalProperties: false }),
	),

	// MCP management
	get_mcp_capabilities: dataResponse("get_mcp_capabilities", RpcMcpCapabilitiesResponseSchema),
	list_mcp_servers: dataResponse("list_mcp_servers", RpcMcpServersResponseSchema),
	get_mcp_server: dataResponse("get_mcp_server", RpcMcpServerResponseSchema),
	connect_mcp_server: dataResponse("connect_mcp_server", RpcMcpServerResponseSchema),
	disconnect_mcp_server: dataResponse("disconnect_mcp_server", RpcMcpServerResponseSchema),
	refresh_mcp_server: dataResponse("refresh_mcp_server", RpcMcpServerResponseSchema),
	start_mcp_server_auth: dataResponse("start_mcp_server_auth", RpcMcpAuthResponseSchema),
	complete_mcp_server_auth: dataResponse("complete_mcp_server_auth", RpcMcpAuthResponseSchema),
	poll_mcp_server_auth: dataResponse("poll_mcp_server_auth", RpcMcpAuthResponseSchema),
	cancel_mcp_server_auth: dataResponse("cancel_mcp_server_auth", RpcMcpAuthResponseSchema),
	logout_mcp_server: dataResponse("logout_mcp_server", RpcMcpAuthResponseSchema),
	set_mcp_server_enabled: dataResponse("set_mcp_server_enabled", RpcMcpServerResponseSchema),
	list_mcp_tools: dataResponse("list_mcp_tools", RpcMcpToolsResponseSchema),
	get_mcp_tool: dataResponse("get_mcp_tool", RpcMcpToolResponseSchema),
	list_mcp_resources: dataResponse("list_mcp_resources", RpcMcpResourcesResponseSchema),
	read_mcp_resource: dataResponse("read_mcp_resource", RpcMcpResourceContentResponseSchema),
	list_mcp_prompts: dataResponse("list_mcp_prompts", RpcMcpPromptsResponseSchema),
	get_mcp_prompt: dataResponse("get_mcp_prompt", RpcMcpPromptContentResponseSchema),
	list_mcp_recent_calls: dataResponse("list_mcp_recent_calls", RpcMcpRecentCallsResponseSchema),

	// State
	get_state: dataResponse("get_state", RpcSessionStateSchema),
	get_transcript: dataResponse("get_transcript", RpcTranscriptResponseSchema),
	get_session_tree: dataResponse("get_session_tree", RpcSessionTreePageSchema),
	get_message_images: dataResponse("get_message_images", RpcMessageImagesResponseSchema),
	get_transcript_entry_text: dataResponse("get_transcript_entry_text", RpcTranscriptEntryTextResponseSchema),

	// Subagents (local RPC only)
	list_subagents: dataResponse("list_subagents", RpcListSubagentsResponseSchema),
	subagent_start: dataResponse("subagent_start", RpcSubagentStartResponseSchema),
	subagent_abort: voidResponse("subagent_abort"),
	subagent_get_state: dataResponse("subagent_get_state", RpcSessionStateSchema),
	subagent_get_transcript: dataResponse("subagent_get_transcript", RpcTranscriptResponseSchema),
	subagent_dispose: voidResponse("subagent_dispose"),

	// Model
	set_model: dataResponse("set_model", RpcCatalogModelSchema),
	cycle_model: dataResponse(
		"cycle_model",
		Type.Union([
			Type.Object(
				{ model: RpcModelSchema, thinkingLevel: RpcThinkingLevelSchema, isScoped: Type.Boolean() },
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
	),
	get_available_models: dataResponse(
		"get_available_models",
		Type.Object({ models: Type.Array(RpcCatalogModelSchema) }, { additionalProperties: false }),
	),

	// Thinking
	set_thinking_level: dataResponse(
		"set_thinking_level",
		Type.Object({ level: RpcThinkingLevelSchema }, { additionalProperties: false }),
	),
	cycle_thinking_level: dataResponse(
		"cycle_thinking_level",
		Type.Union([Type.Object({ level: RpcThinkingLevelSchema }, { additionalProperties: false }), Type.Null()]),
	),

	// Queue modes
	set_steering_mode: voidResponse("set_steering_mode"),
	set_follow_up_mode: voidResponse("set_follow_up_mode"),

	// Compaction
	compact: dataResponse("compact", RpcCompactionResultSchema),
	set_auto_compaction: voidResponse("set_auto_compaction"),

	// Retry
	set_auto_retry: voidResponse("set_auto_retry"),
	abort_retry: voidResponse("abort_retry"),

	// Bash
	bash: dataResponse("bash", RpcBashResultSchema),
	abort_bash: voidResponse("abort_bash"),

	// Session
	get_session_stats: dataResponse("get_session_stats", RpcSessionStatsSchema),
	list_sessions: dataResponse(
		"list_sessions",
		Type.Object({ sessions: Type.Array(RpcSessionListItemSchema) }, { additionalProperties: false }),
	),
	export_html: dataResponse("export_html", Type.Object({ path: Type.String() }, { additionalProperties: false })),
	switch_session: dataResponse("switch_session", cancelledDataSchema),
	switch_session_by_id: dataResponse("switch_session_by_id", cancelledDataSchema),
	fork: dataResponse(
		"fork",
		Type.Object({ text: Type.String(), cancelled: Type.Boolean() }, { additionalProperties: false }),
	),
	clone: dataResponse("clone", cancelledDataSchema),
	get_fork_messages: dataResponse(
		"get_fork_messages",
		Type.Object(
			{
				messages: Type.Array(
					Type.Object({ entryId: Type.String(), text: Type.String() }, { additionalProperties: false }),
				),
			},
			{ additionalProperties: false },
		),
	),
	get_last_assistant_text: dataResponse(
		"get_last_assistant_text",
		Type.Object({ text: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
	),
	set_session_name: voidResponse("set_session_name"),

	// Messages
	get_messages: dataResponse(
		"get_messages",
		Type.Object(
			{
				messages: Type.Array(
					opaque<AgentMessage>(
						"open AgentMessage union (extensible via declaration merging); local-only command, remote-unsupported",
					),
				),
			},
			{ additionalProperties: false },
		),
	),

	// Commands
	get_commands: dataResponse(
		"get_commands",
		Type.Object({ commands: Type.Array(RpcSlashCommandSchema) }, { additionalProperties: false }),
	),
} as const satisfies { [K in RpcCommandType]: TObject };

const RpcErrorCodeSchema = Type.Optional(openStringEnum(RPC_STABLE_ERROR_CODES));

/**
 * Error responses are split so invoke_ui_action can never use the generic
 * id-optional member. A malformed invocation with no usable correlation id is
 * reported uncorrelated as command "invalid".
 */
export const RpcErrorResponseSchema = Type.Union([
	Type.Object(
		{
			id: RpcConversationIdentifierSchema,
			type: Type.Literal("response"),
			command: Type.Literal("invoke_ui_action"),
			success: Type.Literal(false),
			error: Type.String(),
			/** Stable machine-readable code for recovery decisions when one is available. */
			errorCode: RpcErrorCodeSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: Type.Optional(Type.String()),
			type: Type.Literal("response"),
			command: Type.String({ not: Type.Literal("invoke_ui_action") }),
			success: Type.Literal(false),
			error: Type.String(),
			/** Stable machine-readable code for recovery decisions when one is available. */
			errorCode: RpcErrorCodeSchema,
		},
		{ additionalProperties: false },
	),
]);
