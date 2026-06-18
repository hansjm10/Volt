import { serializeJsonLine } from "../../rpc/jsonl.ts";

export const IROH_REMOTE_RPC_PASSTHROUGH_TYPES = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"get_state",
	"extension_ui_response",
]);

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
	if (typeof command.type !== "string") {
		return {
			allowed: false,
			response: createIrohRemoteRpcErrorResponse(
				undefined,
				"unknown",
				"RPC command must be a JSON object with a string type",
			),
		};
	}

	if (IROH_REMOTE_RPC_PASSTHROUGH_TYPES.has(command.type)) {
		return { allowed: true, command: command as IrohRemoteRpcCommand };
	}

	return {
		allowed: false,
		response: createIrohRemoteRpcErrorResponse(
			typeof command.id === "string" ? command.id : undefined,
			command.type,
			`RPC command not allowed over remote sidecar: ${command.type}`,
		),
	};
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
