/**
 * Host→client event schemas outside the ordered-conversation stream: host
 * actions, extension UI, subagent lifecycle envelopes, and change signals.
 * The inbound control messages (extension_ui_response, host_action_response)
 * live here too — they are intercepted before command validation but belong
 * to the client→host contract.
 */

import { Type } from "typebox";
import {
	RPC_UI_ACTION_ID_MAX_CHARS,
	RPC_UI_ACTION_STATE_LABEL_MAX_CHARS,
	RPC_UI_ACTION_STATE_MAX_OPTIONS,
	RPC_UI_ACTION_STATE_OPTION_DESCRIPTION_MAX_CHARS,
	RPC_UI_ACTION_STATE_OPTION_LABEL_MAX_CHARS,
	RPC_UI_ACTION_STATE_OPTION_VALUE_MAX_CHARS,
	RPC_UI_ACTION_STATE_TYPE_MAX_CHARS,
	RPC_UI_ACTION_STATE_VALUE_MAX_CHARS,
} from "../wire-limits.ts";
import { RpcConversationDeliveryPositionSchema } from "./conversation.ts";
import { RpcGitContextSchema } from "./git-context.ts";
import { opaque, stringEnum } from "./helpers.ts";

// ============================================================================
// Host actions
// ============================================================================

export const RpcHostActionMetadataValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const RpcHostActionRequestSchema = Type.Object(
	{
		type: Type.Literal("host_action_request"),
		id: Type.String(),
		action: Type.String(),
		title: Type.String(),
		message: Type.Optional(Type.String()),
		confirmLabel: Type.Optional(Type.String()),
		cancelLabel: Type.Optional(Type.String()),
		commandPreview: Type.Optional(Type.String()),
		blocking: Type.Optional(Type.Boolean()),
		destructive: Type.Optional(Type.Boolean()),
		metadata: Type.Optional(Type.Record(Type.String(), RpcHostActionMetadataValueSchema)),
		timeoutMs: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const RpcHostActionUpdateSchema = Type.Object(
	{
		type: Type.Literal("host_action_update"),
		id: Type.String(),
		action: Type.String(),
		status: stringEnum(["running", "completed", "failed", "cancelled"]),
		message: Type.Optional(Type.String()),
		exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	},
	{ additionalProperties: false },
);

/** Client decision on a host action; "unavailable" is host-internal and never valid on the wire. */
export const RpcHostActionResponseSchema = Type.Object(
	{
		type: Type.Literal("host_action_response"),
		id: Type.String(),
		decision: stringEnum(["approved", "denied", "dismissed"]),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcPendingHostActionsResponseSchema = Type.Object(
	{ actions: Type.Array(RpcHostActionRequestSchema) },
	{ additionalProperties: false },
);

// ============================================================================
// Extension UI
// ============================================================================

/** Emitted when an extension needs user input */
export const RpcExtensionUIRequestSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("select"),
			title: Type.String(),
			options: Type.Array(Type.String()),
			timeout: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("confirm"),
			title: Type.String(),
			message: Type.String(),
			timeout: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("input"),
			title: Type.String(),
			placeholder: Type.Optional(Type.String()),
			timeout: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("editor"),
			title: Type.String(),
			prefill: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("notify"),
			message: Type.String(),
			notifyType: Type.Optional(stringEnum(["info", "warning", "error"])),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("setStatus"),
			statusKey: Type.String(),
			statusText: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("setWidget"),
			widgetKey: Type.String(),
			widgetLines: Type.Optional(Type.Array(Type.String())),
			widgetPlacement: Type.Optional(stringEnum(["aboveEditor", "belowEditor"])),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("setTitle"),
			title: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("extension_ui_request"),
			id: Type.String(),
			method: Type.Literal("set_editor_text"),
			text: Type.String(),
		},
		{ additionalProperties: false },
	),
]);

/** Response to an extension UI request */
export const RpcExtensionUIResponseSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("extension_ui_response"), id: Type.String(), value: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("extension_ui_response"), id: Type.String(), confirmed: Type.Boolean() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("extension_ui_response"), id: Type.String(), cancelled: Type.Literal(true) },
		{ additionalProperties: false },
	),
]);

/** Surfaced when an extension handler throws; mirrors core/extensions ExtensionError. */
export const RpcExtensionErrorEventSchema = Type.Object(
	{
		type: Type.Literal("extension_error"),
		extensionPath: Type.String(),
		event: Type.String(),
		error: Type.String(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Subagent lifecycle envelopes + change signals
// ============================================================================

/** Wraps any projected frame from a subagent's stream (rpc-mode.ts). */
export const RpcSubagentEventSchema = Type.Object(
	{
		type: Type.Literal("subagent_event"),
		subagentId: Type.String(),
		event: opaque<unknown>("a projected subagent frame: message_* / queue_update / passthrough session events"),
	},
	{ additionalProperties: false },
);

export const RpcSubagentEndEventSchema = Type.Object(
	{
		type: Type.Literal("subagent_end"),
		subagentId: Type.String(),
		result: opaque<unknown>("subagent completion result; local-only surface"),
	},
	{ additionalProperties: false },
);

export const RpcSubagentDisposedEventSchema = Type.Object(
	{
		type: Type.Literal("subagent_disposed"),
		subagentId: Type.String(),
	},
	{ additionalProperties: false },
);

/** Agent provider run started with a host-authoritative presentation timestamp. */
export const RpcAgentStartEventSchema = Type.Object(
	{
		type: Type.Literal("agent_start"),
		startedAt: Type.Number(),
		delivery: Type.Optional(RpcConversationDeliveryPositionSchema),
	},
	{ additionalProperties: false },
);

/** Model catalog changed; clients re-fetch get_available_models. */
export const RpcModelsChangedEventSchema = Type.Object(
	{ type: Type.Literal("models_changed") },
	{ additionalProperties: false },
);

/** Full replacement of the active session's path-free Git context. */
export const RpcGitContextChangedEventSchema = Type.Object(
	{
		type: Type.Literal("git_context_changed"),
		gitContext: Type.Union([RpcGitContextSchema, Type.Null()]),
		delivery: Type.Optional(RpcConversationDeliveryPositionSchema),
	},
	{ additionalProperties: false },
);

/** Settled, bounded state for any host UI action. */
export const RpcUiActionStateChangedEventSchema = Type.Object(
	{
		type: Type.Literal("ui_action_state_changed"),
		action: Type.String({ minLength: 1, maxLength: RPC_UI_ACTION_ID_MAX_CHARS }),
		state: Type.Object(
			{
				type: Type.String({ minLength: 1, maxLength: RPC_UI_ACTION_STATE_TYPE_MAX_CHARS }),
				value: Type.Union([
					Type.String({ maxLength: RPC_UI_ACTION_STATE_VALUE_MAX_CHARS }),
					Type.Number(),
					Type.Boolean(),
					Type.Null(),
				]),
				label: Type.Optional(Type.String({ maxLength: RPC_UI_ACTION_STATE_LABEL_MAX_CHARS })),
				options: Type.Optional(
					Type.Array(
						Type.Object(
							{
								value: Type.String({ maxLength: RPC_UI_ACTION_STATE_OPTION_VALUE_MAX_CHARS }),
								label: Type.Optional(Type.String({ maxLength: RPC_UI_ACTION_STATE_OPTION_LABEL_MAX_CHARS })),
								description: Type.Optional(
									Type.String({ maxLength: RPC_UI_ACTION_STATE_OPTION_DESCRIPTION_MAX_CHARS }),
								),
							},
							{ additionalProperties: false },
						),
						{ maxItems: RPC_UI_ACTION_STATE_MAX_OPTIONS },
					),
				),
			},
			{ additionalProperties: false },
		),
		delivery: Type.Optional(RpcConversationDeliveryPositionSchema),
	},
	{ additionalProperties: false },
);
