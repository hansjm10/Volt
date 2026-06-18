import { createHash } from "node:crypto";
import type { IrohRemoteHello } from "./handshake.ts";
import type { IrohRemoteClient, IrohRemoteHostState, IrohRemoteWorkspace } from "./state.ts";
import { upsertIrohRemoteWorkspace } from "./workspace.ts";

export interface AuthorizeIrohRemoteClientOptions {
	allowTools: string;
	pairingExpiresAt?: number;
	pairingSecret?: string;
	workspace: IrohRemoteWorkspace;
	now?: number;
}

export interface IrohRemoteClientAuthorizationSuccess {
	ok: true;
	allowTools: string;
	client: IrohRemoteClient;
	paired: boolean;
	pairingSecretConsumed: boolean;
	workspace: IrohRemoteWorkspace;
}

export interface IrohRemoteClientAuthorizationFailure {
	ok: false;
	error: string;
	pairingSecretExpired: boolean;
}

export type IrohRemoteClientAuthorizationResult =
	| IrohRemoteClientAuthorizationSuccess
	| IrohRemoteClientAuthorizationFailure;

export function authorizeIrohRemoteClient(
	state: IrohRemoteHostState,
	hello: IrohRemoteHello,
	remoteNodeId: string,
	options: AuthorizeIrohRemoteClientOptions,
): IrohRemoteClientAuthorizationResult {
	const workspace = upsertIrohRemoteWorkspace(state, options.workspace, options.allowTools);
	const now = options.now ?? Date.now();
	const existingClient = findIrohRemoteClient(state, remoteNodeId);
	const matchingPairingSecret =
		options.pairingSecret !== undefined && hello.secret === options.pairingSecret ? options.pairingSecret : undefined;
	const hasPairingSecret = matchingPairingSecret !== undefined;
	const pairingSecretHash =
		matchingPairingSecret !== undefined ? hashIrohRemotePairingSecret(matchingPairingSecret) : undefined;
	if (!state.consumedPairingSecretHashes) {
		state.consumedPairingSecretHashes = [];
	}
	const consumedPairingSecretHashes = state.consumedPairingSecretHashes;
	const pairingSecretExpired =
		hasPairingSecret && options.pairingExpiresAt !== undefined && now > options.pairingExpiresAt;

	if (!existingClient && pairingSecretExpired) {
		return { ok: false, error: "pairing ticket has expired", pairingSecretExpired: true };
	}

	if (hello.workspace !== workspace.name) {
		return { ok: false, error: `workspace not allowed: ${hello.workspace}`, pairingSecretExpired: false };
	}

	if (!existingClient && pairingSecretHash && consumedPairingSecretHashes.includes(pairingSecretHash)) {
		return { ok: false, error: "pairing ticket has already been used", pairingSecretExpired: false };
	}

	if (!existingClient && !hasPairingSecret) {
		return { ok: false, error: "client is not paired", pairingSecretExpired: false };
	}

	if (!existingClient) {
		if (!pairingSecretHash) {
			return { ok: false, error: "client is not paired", pairingSecretExpired: false };
		}
		const client: IrohRemoteClient = {
			nodeId: remoteNodeId,
			label: hello.clientLabel || remoteNodeId.slice(0, 12),
			allowedWorkspaces: [workspace.name],
			allowedTools: options.allowTools,
			pairedAt: now,
			lastSeenAt: now,
		};
		consumedPairingSecretHashes.push(pairingSecretHash);
		state.clients.push(client);
		return {
			ok: true,
			allowTools: options.allowTools,
			client,
			paired: true,
			pairingSecretConsumed: true,
			workspace,
		};
	}

	if (!isIrohRemoteClientAllowedForWorkspace(existingClient, workspace.name)) {
		return {
			ok: false,
			error: `client is not allowed to use workspace: ${workspace.name}`,
			pairingSecretExpired: false,
		};
	}

	existingClient.lastSeenAt = now;
	existingClient.allowedTools = options.allowTools;
	if (hello.clientLabel) {
		existingClient.label = hello.clientLabel;
	}
	return {
		ok: true,
		allowTools: options.allowTools,
		client: existingClient,
		paired: false,
		pairingSecretConsumed: false,
		workspace,
	};
}

export function findIrohRemoteClient(state: IrohRemoteHostState, nodeId: string): IrohRemoteClient | undefined {
	return state.clients.find((client) => client.nodeId === nodeId);
}

export function isIrohRemoteClientAllowedForWorkspace(client: IrohRemoteClient, workspaceName: string): boolean {
	return client.allowedWorkspaces.length === 0 || client.allowedWorkspaces.includes(workspaceName);
}

function hashIrohRemotePairingSecret(secret: string): string {
	return `sha256:${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}
