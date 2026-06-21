import { createHash } from "node:crypto";
import type { IrohRemoteHello } from "./handshake.ts";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "./protocol.ts";
import type {
	IrohRemoteClient,
	IrohRemoteHostState,
	IrohRemotePendingPairingTicket,
	IrohRemoteWorkspace,
} from "./state.ts";
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
	consumedPairingTicket?: IrohRemotePendingPairingTicket;
	expiredPairingTickets?: IrohRemotePendingPairingTicket[];
	paired: boolean;
	pairingSecretConsumed: boolean;
	workspace: IrohRemoteWorkspace;
}

export interface IrohRemoteClientAuthorizationFailure {
	ok: false;
	error: string;
	expiredPairingTickets?: IrohRemotePendingPairingTicket[];
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
	const pairingSecretHash = hello.secret ? hashIrohRemotePairingSecret(hello.secret) : undefined;
	const expiredPairingTickets = pruneExpiredPendingPairingTickets(state, now);
	const matchingExpiredPairingTicket = pairingSecretHash
		? expiredPairingTickets.find((ticket) => ticket.secretHash === pairingSecretHash)
		: undefined;
	const matchingPendingPairingTicket = pairingSecretHash
		? getPendingPairingTickets(state).find((ticket) => ticket.secretHash === pairingSecretHash)
		: undefined;
	const matchingRuntimePairingSecret =
		options.pairingSecret !== undefined && hello.secret === options.pairingSecret ? options.pairingSecret : undefined;
	const hasPairingSecret = matchingRuntimePairingSecret !== undefined || matchingPendingPairingTicket !== undefined;
	if (!state.consumedPairingSecretHashes) {
		state.consumedPairingSecretHashes = [];
	}
	const consumedPairingSecretHashes = state.consumedPairingSecretHashes;
	const runtimePairingSecretExpired =
		matchingRuntimePairingSecret !== undefined &&
		options.pairingExpiresAt !== undefined &&
		now > options.pairingExpiresAt;
	const pairingSecretExpired = runtimePairingSecretExpired || matchingExpiredPairingTicket !== undefined;
	const expiredResultTickets = expiredPairingTickets.length > 0 ? expiredPairingTickets : undefined;

	if (!existingClient && pairingSecretExpired) {
		return {
			ok: false,
			error: "pairing ticket has expired",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			pairingSecretExpired: true,
		};
	}

	if (hello.workspace !== workspace.name) {
		return {
			ok: false,
			error: `workspace not allowed: ${hello.workspace}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			pairingSecretExpired: false,
		};
	}

	if (!existingClient && pairingSecretHash && consumedPairingSecretHashes.includes(pairingSecretHash)) {
		return {
			ok: false,
			error: "pairing ticket has already been used",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			pairingSecretExpired: false,
		};
	}

	if (!existingClient && !hasPairingSecret) {
		return {
			ok: false,
			error: "client is not paired",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			pairingSecretExpired: false,
		};
	}

	if (!existingClient) {
		if (!pairingSecretHash) {
			return {
				ok: false,
				error: "client is not paired",
				...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
				pairingSecretExpired: false,
			};
		}
		if (matchingPendingPairingTicket && matchingPendingPairingTicket.workspace !== workspace.name) {
			return {
				ok: false,
				error: `pairing ticket is not valid for workspace: ${workspace.name}`,
				...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
				pairingSecretExpired: false,
			};
		}
		const allowedTools = matchingPendingPairingTicket?.allowedTools ?? options.allowTools;
		const allowedWorkspace = matchingPendingPairingTicket?.workspace ?? workspace.name;
		const client: IrohRemoteClient = {
			nodeId: remoteNodeId,
			label: hello.clientLabel || matchingPendingPairingTicket?.labelHint || remoteNodeId.slice(0, 12),
			allowedWorkspaces: [allowedWorkspace],
			allowedTools,
			pairedAt: now,
			lastSeenAt: now,
		};
		consumedPairingSecretHashes.push(pairingSecretHash);
		if (matchingPendingPairingTicket) {
			state.pendingPairingTickets = getPendingPairingTickets(state).filter(
				(ticket) => ticket.secretHash !== matchingPendingPairingTicket.secretHash,
			);
		}
		state.clients.push(client);
		return {
			ok: true,
			allowTools: allowedTools,
			client,
			...(matchingPendingPairingTicket ? { consumedPairingTicket: matchingPendingPairingTicket } : {}),
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			paired: true,
			pairingSecretConsumed: true,
			workspace,
		};
	}

	if (!isIrohRemoteClientAllowedForWorkspace(existingClient, workspace.name)) {
		return {
			ok: false,
			error: `client is not allowed to use workspace: ${workspace.name}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			pairingSecretExpired: false,
		};
	}

	const persistedAllowedTools = existingClient.allowedTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS;
	existingClient.lastSeenAt = now;
	existingClient.allowedTools = persistedAllowedTools;
	if (hello.clientLabel) {
		existingClient.label = hello.clientLabel;
	}
	return {
		ok: true,
		allowTools: persistedAllowedTools,
		client: existingClient,
		...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
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

export function hashIrohRemotePairingSecret(secret: string): string {
	return `sha256:${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}

function getPendingPairingTickets(state: IrohRemoteHostState): IrohRemotePendingPairingTicket[] {
	state.pendingPairingTickets ??= [];
	return state.pendingPairingTickets;
}

function pruneExpiredPendingPairingTickets(state: IrohRemoteHostState, now: number): IrohRemotePendingPairingTicket[] {
	const pendingPairingTickets = getPendingPairingTickets(state);
	const expiredPairingTickets = pendingPairingTickets.filter((ticket) => now > ticket.expiresAt);
	if (expiredPairingTickets.length > 0) {
		state.pendingPairingTickets = pendingPairingTickets.filter((ticket) => now <= ticket.expiresAt);
	}
	return expiredPairingTickets;
}
