import { Buffer } from "node:buffer";
import { Compile } from "typebox/compile";
import { RPC_COMMAND_SCHEMAS } from "../../rpc/schema/commands.ts";
import { RpcSessionContextSchema } from "../../rpc/schema/session.ts";
import type { RpcGitContext, RpcSessionWorkContext } from "../../rpc/types.ts";
import { SessionManager } from "../../session-manager.ts";
import { IROH_REMOTE_SESSION_ID_PATTERN, isIrohRemoteWorkspaceName } from "./handshake.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_GET_SESSION_CONTEXTS_RPC_TYPE = "get_session_contexts";
export const IROH_REMOTE_SESSION_CONTEXTS_MAX_ITEMS = 64;
export const IROH_REMOTE_SESSION_CONTEXTS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024 - 1;

export interface IrohRemoteSessionContext {
	sessionId: string;
	startingGitContext: RpcGitContext | null;
	workContext: RpcSessionWorkContext | null;
}

export interface IrohRemoteSessionContextsRpcBackend {
	getSessionContexts(workspaceName: string, sessionIds: readonly string[]): Promise<IrohRemoteSessionContext[]>;
}

export function createIrohRemoteSessionContextsRpcBackend(options: {
	workspaceName: string;
	sessionDirectory: string;
	getLiveStartingGitContext(sessionId: string): RpcGitContext | null | undefined;
	getWorkContext(sessionId: string): RpcSessionWorkContext | undefined;
}): IrohRemoteSessionContextsRpcBackend {
	return {
		getSessionContexts: async (workspaceName, sessionIds) => {
			if (workspaceName !== options.workspaceName) {
				throw new Error("Session context workspace mismatch");
			}
			const liveContexts = new Map<string, RpcGitContext | null>();
			const persistedSessionIds: string[] = [];
			for (const sessionId of sessionIds) {
				const liveContext = options.getLiveStartingGitContext(sessionId);
				if (liveContext === undefined) {
					persistedSessionIds.push(sessionId);
				} else {
					liveContexts.set(sessionId, liveContext);
				}
			}
			const persistedContexts = await SessionManager.readStartingGitContexts(
				options.sessionDirectory,
				persistedSessionIds,
			);
			return sessionIds.map((sessionId) => ({
				sessionId,
				startingGitContext: liveContexts.get(sessionId) ?? persistedContexts.get(sessionId) ?? null,
				workContext: options.getWorkContext(sessionId) ?? null,
			}));
		},
	};
}

export type IrohRemoteSessionContextsRpcResponse =
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_GET_SESSION_CONTEXTS_RPC_TYPE;
			success: true;
			data: { contexts: IrohRemoteSessionContext[] };
	  }
	| IrohRemoteRpcErrorResponse;

export type IrohRemoteSessionContextsRpcResult =
	| { handled: false }
	| { handled: true; response: IrohRemoteSessionContextsRpcResponse };

const GET_SESSION_CONTEXTS_VALIDATOR = Compile(RPC_COMMAND_SCHEMAS.get_session_contexts);
const SESSION_CONTEXT_VALIDATOR = Compile(RpcSessionContextSchema);

export async function handleIrohRemoteSessionContextsRpcCommand(
	command: Record<string, unknown>,
	options: {
		authorizedWorkspaceName: string;
		backend: IrohRemoteSessionContextsRpcBackend;
	},
): Promise<IrohRemoteSessionContextsRpcResult> {
	if (command.type !== IROH_REMOTE_GET_SESSION_CONTEXTS_RPC_TYPE) {
		return { handled: false };
	}
	const id = typeof command.id === "string" ? command.id : undefined;
	const fail = (error: string): IrohRemoteSessionContextsRpcResult => ({
		handled: true,
		response: createIrohRemoteRpcErrorResponse(id, IROH_REMOTE_GET_SESSION_CONTEXTS_RPC_TYPE, error),
	});
	if (
		!GET_SESSION_CONTEXTS_VALIDATOR.Check(command) ||
		!isIrohRemoteWorkspaceName(command.workspaceName) ||
		!Array.isArray(command.sessionIds) ||
		command.sessionIds.length > IROH_REMOTE_SESSION_CONTEXTS_MAX_ITEMS ||
		!command.sessionIds.every(
			(sessionId): sessionId is string =>
				typeof sessionId === "string" && IROH_REMOTE_SESSION_ID_PATTERN.test(sessionId),
		) ||
		new Set(command.sessionIds).size !== command.sessionIds.length
	) {
		return fail("invalid_request");
	}
	if (command.workspaceName !== options.authorizedWorkspaceName) {
		return fail("session_mismatch");
	}
	try {
		const contexts = await options.backend.getSessionContexts(command.workspaceName, command.sessionIds);
		if (
			contexts.length !== command.sessionIds.length ||
			!contexts.every(
				(context, index) =>
					context.sessionId === command.sessionIds[index] && SESSION_CONTEXT_VALIDATOR.Check(context),
			)
		) {
			return fail("request_failed");
		}
		const response: IrohRemoteSessionContextsRpcResponse = {
			...(id === undefined ? {} : { id }),
			type: "response",
			command: IROH_REMOTE_GET_SESSION_CONTEXTS_RPC_TYPE,
			success: true,
			data: { contexts },
		};
		if (Buffer.byteLength(JSON.stringify(response), "utf8") > IROH_REMOTE_SESSION_CONTEXTS_MAX_RESPONSE_BYTES) {
			return fail("request_failed");
		}
		return { handled: true, response };
	} catch {
		return fail("request_failed");
	}
}
