import { isRemoteSafeBuiltinHostActionId } from "../../host-actions.ts";
import { getRpcErrorResponseTarget, isUsableRpcConversationIdentifier } from "../../rpc/correlation.ts";
import { serializeJsonLine } from "../../rpc/jsonl.ts";
import {
	getIrohRemoteRpcCommandCapabilities,
	getMissingIrohRemoteRpcCapability,
	type IrohRemoteRpcCapability,
	type IrohRemoteRpcGrant,
	parseIrohRemoteRpcGrant,
} from "./access-grant.ts";

export const IROH_REMOTE_RPC_CANCELLATION_TYPES = new Set(["abort"]);

export const IROH_REMOTE_RPC_UNSUPPORTED_TYPES = new Set(["get_messages"]);

export const IROH_REMOTE_RPC_PASSTHROUGH_TYPES = new Set([
	"prompt",
	"steer",
	"follow_up",
	...IROH_REMOTE_RPC_CANCELLATION_TYPES,
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"set_client_capabilities",
	"report_stream_discontinuity",
	"get_pending_host_actions",
	"host_action_response",
	"get_state",
	"get_transcript",
	"get_message_images",
	"get_transcript_entry_text",
	"get_mcp_capabilities",
	"list_mcp_servers",
	"get_mcp_server",
	"connect_mcp_server",
	"refresh_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_recent_calls",
	"list_mcp_tools",
	"get_mcp_tool",
	"list_mcp_resources",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
	"disconnect_mcp_server",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"get_ui_capabilities",
	"get_ui_actions",
	"cancel_workflow",
	"get_review_result",
	"list_review_workflows",
	"open_review_session",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"list_sessions",
	"switch_session_by_id",
	"register_push_target",
	"unregister_workspace",
	// worktrees.v1: create/list only — remove_worktree is management-stream-only.
	"create_worktree",
	"list_worktrees",
	"set_keep_awake",
	"get_keep_awake",
	"set_web_search_key",
	"get_web_search_status",
	"upload_device_logs",
	"extension_ui_response",
	"get_available_models",
	"set_model",
	"set_thinking_level",
]);

const IROH_REMOTE_UI_ACTION_PREFIXES = ["extension.command.", "prompt.template.", "skill."] as const;

export interface IrohRemoteRpcCommand extends Record<string, unknown> {
	type: string;
}

export interface IrohRemoteRpcCapabilityDeniedError {
	code: "rpc_capability_denied";
	message: string;
	requiredCapability: IrohRemoteRpcCapability;
}

export interface IrohRemoteRpcErrorResponse {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
}

export interface IrohRemoteRpcCapabilityDeniedResponse {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: IrohRemoteRpcCapabilityDeniedError;
}

export type IrohRemoteStaticRpcFilterResult =
	| { allowed: true; command: IrohRemoteRpcCommand }
	| { allowed: false; response: IrohRemoteRpcErrorResponse };

export type IrohRemoteRpcFilterResult =
	| { allowed: true; command: IrohRemoteRpcCommand }
	| { allowed: false; response: IrohRemoteRpcErrorResponse | IrohRemoteRpcCapabilityDeniedResponse };

export function getIrohRemoteRpcFilterResult(line: string, rpcGrant: IrohRemoteRpcGrant): IrohRemoteRpcFilterResult {
	const staticResult = getStaticIrohRemoteRpcFilterResult(line);
	if (!staticResult.allowed) {
		return staticResult;
	}
	let granted: IrohRemoteRpcGrant;
	try {
		granted = parseIrohRemoteRpcGrant(rpcGrant, "remote RPC grant");
	} catch {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				typeof staticResult.command.id === "string" ? staticResult.command.id : undefined,
				staticResult.command.type,
				"Remote RPC grant is missing or malformed",
			),
		};
	}
	const required = getIrohRemoteRpcCommandCapabilities(staticResult.command);
	if (required === undefined) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				typeof staticResult.command.id === "string" ? staticResult.command.id : undefined,
				staticResult.command.type,
				`RPC command has no capability classification: ${staticResult.command.type}`,
			),
		};
	}
	const missing = getMissingIrohRemoteRpcCapability(granted, required);
	if (missing === undefined) {
		return staticResult;
	}
	return {
		allowed: false,
		response: createIrohRemoteRpcCapabilityDeniedResponse(
			typeof staticResult.command.id === "string" ? staticResult.command.id : undefined,
			staticResult.command.type,
			missing,
		),
	};
}

/** Low-level syntax and hard-allowlist classifier. Remote serving must also apply an RPC grant. */
export function getStaticIrohRemoteRpcFilterResult(line: string): IrohRemoteStaticRpcFilterResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				undefined,
				"parse",
				`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
			),
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				undefined,
				"unknown",
				"RPC command must be a JSON object with a string type",
			),
		};
	}
	const command = parsed as Record<string, unknown>;
	const target = getRpcErrorResponseTarget(command);
	if (typeof command.type !== "string") {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				target.id,
				"unknown",
				"RPC command must be a JSON object with a string type",
			),
		};
	}

	if (command.type === "invoke_ui_action" && !isUsableRpcConversationIdentifier(command.id)) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				undefined,
				"invalid",
				"invoke_ui_action requires a trimmed, non-empty correlation id of at most 256 UTF-8 bytes",
			),
		};
	}

	const responseId = target.id;
	if (command.type === "invoke_ui_action" || command.type === "get_ui_action_completions") {
		return getIrohRemoteUiActionCommandResult(command, responseId, command.type);
	}

	if (command.type === "start_mcp_server_auth") {
		return getIrohRemoteMcpAuthCommandResult(command, responseId);
	}

	if (IROH_REMOTE_RPC_UNSUPPORTED_TYPES.has(command.type)) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(responseId, command.type, "unsupported_remote_command"),
		};
	}

	if (command.type === "get_session_tree") {
		return { allowed: true, command: command as IrohRemoteRpcCommand };
	}

	if (IROH_REMOTE_RPC_PASSTHROUGH_TYPES.has(command.type)) {
		return { allowed: true, command: command as IrohRemoteRpcCommand };
	}

	return {
		allowed: false,
		response: createIrohRemoteRpcErrorResponse(
			responseId,
			command.type,
			`RPC command not allowed over remote host: ${command.type}`,
		),
	};
}

function getIrohRemoteMcpAuthCommandResult(
	command: Record<string, unknown>,
	responseId: string | undefined,
): IrohRemoteStaticRpcFilterResult {
	if (command.flow !== "device") {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				responseId,
				"start_mcp_server_auth",
				"Only MCP device-code auth can be started over remote host",
			),
		};
	}
	if (typeof command.redirectUrl === "string") {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				responseId,
				"start_mcp_server_auth",
				"MCP browser redirect auth is not available over remote host",
			),
		};
	}
	return { allowed: true, command: command as IrohRemoteRpcCommand };
}

function getIrohRemoteUiActionCommandResult(
	command: Record<string, unknown>,
	responseId: string | undefined,
	commandType: "invoke_ui_action" | "get_ui_action_completions",
): IrohRemoteStaticRpcFilterResult {
	const action = command.action;
	if (typeof action !== "string" || action.length === 0) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(responseId, commandType, "UI action id must be a non-empty string"),
		};
	}
	if (!isIrohRemoteUiActionId(action)) {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				responseId,
				commandType,
				`UI action not available over remote host: ${action}`,
			),
		};
	}
	return { allowed: true, command: command as IrohRemoteRpcCommand };
}

function isIrohRemoteUiActionId(action: string): boolean {
	return (
		isRemoteSafeBuiltinHostActionId(action) ||
		IROH_REMOTE_UI_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
	);
}

export function serializeIrohRemoteRpcFilterRejection(
	response: IrohRemoteRpcErrorResponse | IrohRemoteRpcCapabilityDeniedResponse,
): string {
	return serializeJsonLine(response);
}

export function createIrohRemoteRpcErrorResponse(
	id: string | undefined,
	command: string,
	error: string,
): IrohRemoteRpcErrorResponse {
	const target = getRpcErrorResponseTarget({ id, type: command });
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error,
	};
}

export function createIrohRemoteRpcCapabilityDeniedResponse(
	id: string | undefined,
	command: string,
	requiredCapability: IrohRemoteRpcCapability,
): IrohRemoteRpcCapabilityDeniedResponse {
	const target = getRpcErrorResponseTarget({ id, type: command });
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: {
			code: "rpc_capability_denied",
			message: `RPC capability required: ${requiredCapability}`,
			requiredCapability,
		},
	};
}
