import { createHash } from "node:crypto";
import type { IrohRemoteHello } from "./handshake.ts";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	type IrohRemoteHostHandshakeFailureOutcome,
	normalizeIrohRemoteAllowTools,
} from "./protocol.ts";
import type {
	IrohRemoteClient,
	IrohRemoteHostState,
	IrohRemotePairingSecretTombstone,
	IrohRemotePendingPairingTicket,
	IrohRemoteRevokedClient,
	IrohRemoteWorkspace,
} from "./state.ts";
import type { IrohRemoteWorkspaceAvailabilityClassifier, IrohRemoteWorkspaceStatus } from "./workspace.ts";

export const DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthorizeIrohRemoteClientOptions {
	allowTools: string;
	classifyWorkspaceAvailability?: IrohRemoteWorkspaceAvailabilityClassifier;
	pairingExpiresAt?: number;
	pairingSecret?: string;
	validateWorkspace?: (workspace: IrohRemoteWorkspace) => boolean | Promise<boolean>;
	workspace?: IrohRemoteWorkspace;
	workspaceStatuses?: readonly IrohRemoteWorkspaceStatus[];
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
	workspaceNames: string[];
	workspaces: IrohRemoteWorkspaceStatus[];
}

export interface IrohRemoteClientAuthorizationFailure {
	ok: false;
	client?: IrohRemoteClient;
	error: string;
	expiredPairingTickets?: IrohRemotePendingPairingTicket[];
	outcome: IrohRemoteHostHandshakeFailureOutcome;
	pairingSecretExpired: boolean;
	workspace?: IrohRemoteWorkspace;
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
	const workspace = options.workspace?.name === hello.workspace ? options.workspace : undefined;
	const registeredWorkspace =
		state.workspaces.find((entry) => entry.name === hello.workspace) ??
		(options.workspace?.name === hello.workspace ? options.workspace : undefined);
	const workspaceName = registeredWorkspace?.name ?? options.workspace?.name ?? hello.workspace;
	const workspaces = getIrohRemoteWorkspaceStatuses(state, options.workspaceStatuses);
	const workspaceNames = workspaces.filter((entry) => entry.status === "available").map((entry) => entry.name);
	const now = options.now ?? Date.now();
	const revokedClient = findIrohRemoteRevokedClient(state, remoteNodeId);
	const existingClient = revokedClient ? undefined : findIrohRemoteClient(state, remoteNodeId);
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
	const pairingSecretTombstones = prunePairingSecretTombstones(state, now);
	const matchingConsumedPairingSecret = pairingSecretHash
		? pairingSecretTombstones.find(
				(tombstone) =>
					tombstone.secretHash === pairingSecretHash && tombstone.outcome === "pairing_secret_consumed",
			)
		: undefined;
	const matchingExpiredPairingSecret = pairingSecretHash
		? pairingSecretTombstones.find(
				(tombstone) => tombstone.secretHash === pairingSecretHash && tombstone.outcome === "pairing_secret_expired",
			)
		: undefined;
	const runtimePairingSecretExpired =
		matchingRuntimePairingSecret !== undefined &&
		options.pairingExpiresAt !== undefined &&
		now > options.pairingExpiresAt;
	const pairingSecretExpired =
		runtimePairingSecretExpired ||
		matchingExpiredPairingTicket !== undefined ||
		matchingExpiredPairingSecret !== undefined;
	const expiredResultTickets = expiredPairingTickets.length > 0 ? expiredPairingTickets : undefined;
	const hasActivePairingSecretForRevokedClient =
		revokedClient?.rePairApprovedAt !== undefined &&
		hasPairingSecret &&
		!pairingSecretExpired &&
		matchingConsumedPairingSecret === undefined &&
		matchingExpiredPairingSecret === undefined;

	if (revokedClient && !hasActivePairingSecretForRevokedClient) {
		return {
			ok: false,
			error: "client is revoked",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "client_revoked",
			pairingSecretExpired: false,
		};
	}

	if (!existingClient && pairingSecretExpired) {
		if (runtimePairingSecretExpired && pairingSecretHash) {
			upsertPairingSecretTombstone(state, {
				secretHash: pairingSecretHash,
				workspace: workspaceName,
				outcome: "pairing_secret_expired",
				expiresAt: options.pairingExpiresAt,
				expiredAt: now,
				retainUntil: getPairingSecretTombstoneRetainUntil(now, options.pairingExpiresAt),
			});
		}
		return {
			ok: false,
			error: "pairing ticket has expired",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "pairing_secret_expired",
			pairingSecretExpired: true,
		};
	}

	if (!registeredWorkspace) {
		return {
			ok: false,
			error: `workspace is not registered: ${hello.workspace}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "workspace_unregistered",
			pairingSecretExpired: false,
		};
	}

	if (!workspace) {
		return {
			ok: false,
			error: `workspace path is unavailable: ${hello.workspace}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "workspace_unavailable",
			pairingSecretExpired: false,
		};
	}

	if (existingClient && !isIrohRemoteClientAllowedForWorkspace(existingClient, workspace.name)) {
		return {
			ok: false,
			client: existingClient,
			error: `workspace authorization has been removed: ${workspace.name}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "workspace_authorization_removed",
			pairingSecretExpired: false,
			workspace,
		};
	}

	if (!existingClient && matchingConsumedPairingSecret) {
		return {
			ok: false,
			error: "pairing ticket has already been used",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "pairing_secret_consumed",
			pairingSecretExpired: false,
		};
	}

	if (!existingClient && !hasPairingSecret) {
		return {
			ok: false,
			error: "client is not paired",
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "client_unknown",
			pairingSecretExpired: false,
		};
	}

	if (!existingClient) {
		if (!pairingSecretHash) {
			return {
				ok: false,
				error: "client is not paired",
				...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
				outcome: "client_unknown",
				pairingSecretExpired: false,
			};
		}
		if (matchingPendingPairingTicket && matchingPendingPairingTicket.workspace !== workspace.name) {
			return {
				ok: false,
				error: `pairing ticket is not valid for workspace: ${workspace.name}`,
				...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
				outcome: "workspace_authorization_removed",
				pairingSecretExpired: false,
			};
		}
		const allowedTools = normalizeIrohRemoteAllowTools(
			matchingPendingPairingTicket?.allowedTools ?? options.allowTools,
		);
		const allowedWorkspace = matchingPendingPairingTicket?.workspace ?? workspace.name;
		const ticketExpiresAt = matchingPendingPairingTicket?.expiresAt ?? options.pairingExpiresAt;
		const client: IrohRemoteClient = {
			nodeId: remoteNodeId,
			label: hello.clientLabel || matchingPendingPairingTicket?.labelHint || remoteNodeId.slice(0, 12),
			allowedWorkspaces: [],
			allowedTools,
			pairedAt: now,
			lastSeenAt: now,
		};
		upsertPairingSecretTombstone(state, {
			secretHash: pairingSecretHash,
			workspace: allowedWorkspace,
			outcome: "pairing_secret_consumed",
			consumedAt: now,
			clientNodeId: remoteNodeId,
			...(matchingPendingPairingTicket?.createdAt === undefined
				? {}
				: { createdAt: matchingPendingPairingTicket.createdAt }),
			...(ticketExpiresAt === undefined ? {} : { expiresAt: ticketExpiresAt }),
			...(matchingPendingPairingTicket?.labelHint === undefined
				? {}
				: { labelHint: matchingPendingPairingTicket.labelHint }),
			retainUntil: getPairingSecretTombstoneRetainUntil(now, ticketExpiresAt),
		});
		if (matchingPendingPairingTicket) {
			state.pendingPairingTickets = getPendingPairingTickets(state).filter(
				(ticket) => ticket.secretHash !== matchingPendingPairingTicket.secretHash,
			);
		}
		if (revokedClient) {
			state.revokedClients = getRevokedClients(state).filter((client) => client.nodeId !== remoteNodeId);
			state.clients = state.clients.filter((entry) => entry.nodeId !== remoteNodeId);
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
			workspaceNames,
			workspaces,
		};
	}

	const persistedAllowedTools = normalizeIrohRemoteAllowTools(
		existingClient.allowedTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	);
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
		workspaceNames,
		workspaces,
	};
}

function getIrohRemoteWorkspaceStatuses(
	state: IrohRemoteHostState,
	workspaceStatuses: readonly IrohRemoteWorkspaceStatus[] | undefined,
): IrohRemoteWorkspaceStatus[] {
	return state.workspaces.map((workspace) => ({
		name: workspace.name,
		status: workspaceStatuses?.find((entry) => entry.name === workspace.name)?.status ?? "available",
	}));
}

export function findIrohRemoteClient(state: IrohRemoteHostState, nodeId: string): IrohRemoteClient | undefined {
	return state.clients.find((client) => client.nodeId === nodeId);
}

export function findIrohRemoteRevokedClient(
	state: IrohRemoteHostState,
	nodeId: string,
): IrohRemoteRevokedClient | undefined {
	return getRevokedClients(state).find((client) => client.nodeId === nodeId);
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

function getPairingSecretTombstones(state: IrohRemoteHostState): IrohRemotePairingSecretTombstone[] {
	state.pairingSecretTombstones ??= [];
	return state.pairingSecretTombstones;
}

function getRevokedClients(state: IrohRemoteHostState): IrohRemoteRevokedClient[] {
	state.revokedClients ??= [];
	return state.revokedClients;
}

function getPairingSecretTombstoneRetainUntil(terminalAt: number, expiresAt: number | undefined): number {
	return Math.max(terminalAt + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS, expiresAt ?? terminalAt);
}

function prunePairingSecretTombstones(state: IrohRemoteHostState, now: number): IrohRemotePairingSecretTombstone[] {
	const tombstones = getPairingSecretTombstones(state);
	const retainedTombstones = tombstones.filter((tombstone) => now <= tombstone.retainUntil);
	if (retainedTombstones.length !== tombstones.length) {
		state.pairingSecretTombstones = retainedTombstones;
	}
	return retainedTombstones;
}

function upsertPairingSecretTombstone(state: IrohRemoteHostState, tombstone: IrohRemotePairingSecretTombstone): void {
	const tombstones = getPairingSecretTombstones(state);
	state.pairingSecretTombstones = [
		...tombstones.filter((entry) => entry.secretHash !== tombstone.secretHash),
		tombstone,
	];
}

function pruneExpiredPendingPairingTickets(state: IrohRemoteHostState, now: number): IrohRemotePendingPairingTicket[] {
	const pendingPairingTickets = getPendingPairingTickets(state);
	const expiredPairingTickets = pendingPairingTickets.filter((ticket) => now > ticket.expiresAt);
	if (expiredPairingTickets.length > 0) {
		state.pendingPairingTickets = pendingPairingTickets.filter((ticket) => now <= ticket.expiresAt);
		for (const ticket of expiredPairingTickets) {
			upsertPairingSecretTombstone(state, {
				secretHash: ticket.secretHash,
				workspace: ticket.workspace,
				outcome: "pairing_secret_expired",
				createdAt: ticket.createdAt,
				expiresAt: ticket.expiresAt,
				expiredAt: now,
				...(ticket.labelHint === undefined ? {} : { labelHint: ticket.labelHint }),
				retainUntil: getPairingSecretTombstoneRetainUntil(now, ticket.expiresAt),
			});
		}
	}
	return expiredPairingTickets;
}
