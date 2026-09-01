import { hostname, userInfo } from "node:os";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import {
	createIrohRemoteHandshakeSuccess,
	type IrohRemoteConversationSelection,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
} from "../core/remote/iroh/handshake.ts";
import { createIrohRemoteHostMetadata, type IrohRemoteHostMetadata } from "../core/remote/iroh/metadata.ts";
import type { IrohRemoteRelayMode } from "../core/remote/iroh/protocol.ts";
import type { RpcSessionState } from "../core/rpc/types.ts";

/**
 * Session selection outcomes as tracked by the conversation owner. Extends the
 * runtime-level selection kinds with "session_rekeyed" (an existing runtime is
 * serving a different session id than the one requested).
 */
export type IntegratedConversationSessionSelection =
	| { kind: "created"; sessionId: string }
	| { kind: "created_after_missing"; requestedSessionId: string; sessionId: string }
	| { kind: "resumed"; requestedSessionId: string; sessionId: string }
	| { kind: "session_rekeyed"; requestedSessionId: string; sessionId: string };

/** Host identity/context needed to build handshake responses and host-state decoration. */
export interface RemoteHostResponseContext {
	hostNodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	relayUrls?: string[];
}

function getCurrentUserName(): string | undefined {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME;
	}
}

export function createRemoteHostMetadata(
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: RemoteHostResponseContext,
): IrohRemoteHostMetadata {
	return createIrohRemoteHostMetadata({
		authorization,
		hostNodeId: context.hostNodeId,
		relayMode: context.relayMode,
		relayUrls: context.relayUrls,
		hostName: hostname(),
		userName: getCurrentUserName(),
		cwd: "/workspace",
	});
}

export function decorateRemoteConversationSessionState(
	state: RpcSessionState,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: RemoteHostResponseContext,
): RpcSessionState & { workspaceName: string; remoteHost: IrohRemoteHostMetadata } {
	return {
		...state,
		workspaceName: authorization.workspace.name,
		remoteHost: createRemoteHostMetadata(authorization, context),
	};
}

export function getHandshakeConversationSelection(
	sessionSelection: IntegratedConversationSessionSelection,
): IrohRemoteConversationSelection {
	if (sessionSelection.kind === "created_after_missing") {
		return "created_missing_last";
	}
	if (sessionSelection.kind === "created") {
		return "created";
	}
	if (sessionSelection.kind === "session_rekeyed") {
		return "session_rekeyed";
	}
	return "resumed";
}

export function createIntegratedConversationHandshakeResponse(
	handshake: { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess },
	authorization: IrohRemoteClientAuthorizationSuccess,
	sessionId: string,
	sessionSelection: IntegratedConversationSessionSelection,
	context: RemoteHostResponseContext,
	worktreeId?: string,
	workingDirectory?: string,
): IrohRemoteHandshakeSuccess {
	if (handshake.hello.mode !== "conversation") {
		throw new Error("integrated conversation handshake response requires a conversation hello");
	}
	const requestedSessionId =
		sessionSelection.kind === "session_rekeyed" ? sessionSelection.requestedSessionId : undefined;
	return createIrohRemoteHandshakeSuccess({
		child: handshake.response.child,
		clientNodeId: authorization.client.nodeId,
		features: handshake.response.features,
		hostNodeId: context.hostNodeId,
		remoteHost: createRemoteHostMetadata(authorization, context),
		workspace: authorization.workspace.name,
		sessionId,
		conversation: {
			target: handshake.hello.conversation.target,
			sessionId,
			selection: getHandshakeConversationSelection(sessionSelection),
			...(requestedSessionId === undefined ? {} : { requestedSessionId }),
			// Echoed only for worktree-bound conversations; old clients never see it.
			...(worktreeId === undefined ? {} : { worktreeId }),
			...(workingDirectory === undefined ? {} : { workingDirectory }),
		},
	});
}

function isResponseRecord(value: object): value is Record<string, unknown> {
	return !Array.isArray(value);
}

function decorateRemoteUiActionResponse(value: object): object {
	if (!isResponseRecord(value)) {
		return value;
	}
	const data = value.data;
	if (
		value.type !== "response" ||
		value.command !== "get_ui_actions" ||
		value.success !== true ||
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data) ||
		!Array.isArray((data as Record<string, unknown>).actions)
	) {
		return value;
	}
	const actions = (data as Record<string, unknown>).actions as unknown[];
	return {
		...value,
		data: {
			...data,
			actions: actions.filter(
				(action) =>
					typeof action === "object" && action !== null && (action as Record<string, unknown>).remoteSafe === true,
			),
		},
	};
}

/**
 * Decorates outbound RPC frames with host-side metadata: filters get_ui_actions
 * to remote-safe actions, and stamps get_state responses with the workspace
 * name and remote host metadata.
 */
export function decorateRemoteHostState(
	value: object,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: RemoteHostResponseContext,
): object {
	const decoratedValue = decorateRemoteUiActionResponse(value);
	if (!isResponseRecord(decoratedValue)) {
		return decoratedValue;
	}
	const data = decoratedValue.data;
	if (
		decoratedValue.type !== "response" ||
		decoratedValue.command !== "get_state" ||
		decoratedValue.success !== true ||
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data)
	) {
		return decoratedValue;
	}
	return {
		...decoratedValue,
		data: decorateRemoteConversationSessionState(data as unknown as RpcSessionState, authorization, context),
	};
}
