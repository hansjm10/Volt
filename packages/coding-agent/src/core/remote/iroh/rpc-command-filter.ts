import { isRemoteSafeBuiltinHostActionId } from "../../host-actions.ts";
import { serializeJsonLine } from "../../rpc/jsonl.ts";

export const IROH_REMOTE_RPC_CANCELLATION_TYPES = new Set(["abort"]);

export const IROH_REMOTE_RPC_PASSTHROUGH_TYPES = new Set([
	"prompt",
	"steer",
	"follow_up",
	...IROH_REMOTE_RPC_CANCELLATION_TYPES,
	"new_session",
	"set_client_capabilities",
	"get_pending_host_actions",
	"host_action_response",
	"get_state",
	"get_transcript",
	"get_ui_capabilities",
	"get_ui_actions",
	"list_sessions",
	"switch_session_by_id",
	"register_push_target",
	"extension_ui_response",
]);

const IROH_REMOTE_UI_ACTION_PREFIXES = ["extension.command.", "prompt.template.", "skill."] as const;

export interface IrohRemoteRpcCommand extends Record<string, unknown> {
	type: string;
}

export interface IrohRemoteRpcErrorResponse {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
}

export type IrohRemoteRpcFilterResult =
	| { allowed: true; command: IrohRemoteRpcCommand }
	| { allowed: false; response: IrohRemoteRpcErrorResponse };

export function getIrohRemoteRpcFilterResult(line: string): IrohRemoteRpcFilterResult {
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
	const responseId = typeof command.id === "string" ? command.id : undefined;
	if (typeof command.type !== "string") {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				responseId,
				"unknown",
				"RPC command must be a JSON object with a string type",
			),
		};
	}

	if (command.type === "invoke_ui_action" || command.type === "get_ui_action_completions") {
		return getIrohRemoteUiActionCommandResult(command, responseId, command.type);
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

function getIrohRemoteUiActionCommandResult(
	command: Record<string, unknown>,
	responseId: string | undefined,
	commandType: "invoke_ui_action" | "get_ui_action_completions",
): IrohRemoteRpcFilterResult {
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

export function serializeIrohRemoteRpcFilterRejection(response: IrohRemoteRpcErrorResponse): string {
	return serializeJsonLine(response);
}

export function createIrohRemoteRpcErrorResponse(
	id: string | undefined,
	command: string,
	error: string,
): IrohRemoteRpcErrorResponse {
	return { id, type: "response", command, success: false, error };
}
