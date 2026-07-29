import { createHash } from "node:crypto";
import {
	cloneIrohRemoteRpcGrant,
	createIrohRemotePresetAccess,
	type IrohRemoteRpcGrant,
	parseIrohRemoteRpcGrant,
} from "./access-grant.ts";
import type { IrohRemoteHello } from "./handshake.ts";
import {
	canonicalizePersistedIrohRemoteAllowTools,
	type IrohRemoteHostHandshakeFailureOutcome,
	normalizeIrohRemoteAllowTools,
} from "./protocol.ts";
import type {
	IrohRemoteClient,
	IrohRemoteGrantedClient,
	IrohRemoteHostState,
	IrohRemotePairingSecretTombstone,
	IrohRemotePendingPairingTicket,
	IrohRemoteRevokedClient,
	IrohRemoteWorkspace,
} from "./state.ts";
import type { IrohRemoteWorkspaceAvailabilityClassifier, IrohRemoteWorkspaceStatus } from "./workspace.ts";

export const DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Pacing hint sent with transient workspace_unavailable rejections. Missing
// paths are rejected as workspace_missing without a hint: redialing cannot fix
// a deleted registration, so well-behaved clients stop automatic retries.
export const IROH_REMOTE_WORKSPACE_UNAVAILABLE_RETRY_AFTER_MS = 5_000;

// A re-pair approval for a revoked client is a standing grant to consume a
// pairing secret again. Bound it so a stale, unused approval cannot silently
// hijack an unrelated pairing ticket minted much later for a different device;
// the approval is otherwise cleared only when the revoked client actually
// re-pairs. The window comfortably covers a deliberate approve -> mint ticket
// -> scan operator flow.
export const DEFAULT_IROH_REMOTE_RE_PAIR_APPROVAL_TTL_MS = 30 * 60 * 1000;

export interface AuthorizeIrohRemoteClientOptions {
	allowTools: string;
	/** Default grant to resolve tracking clients against; tests inject alternate defaults. */
	defaultAllowTools?: string;
	rpcGrant?: IrohRemoteRpcGrant;
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
	client: IrohRemoteGrantedClient;
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
	retryAfterMs?: number;
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
	const rePairApprovalActive =
		revokedClient?.rePairApprovedAt !== undefined &&
		// Fail closed on a future timestamp (host clock moved back, or state carried
		// across a clock change): without the lower bound a negative delta always
		// satisfies the TTL and keeps a revoked client's re-pair approval alive
		// indefinitely.
		now >= revokedClient.rePairApprovedAt &&
		now - revokedClient.rePairApprovedAt <= DEFAULT_IROH_REMOTE_RE_PAIR_APPROVAL_TTL_MS;
	try {
		if (revokedClient) parseIrohRemoteRpcGrant(revokedClient.rpcGrant, "revoked client rpcGrant");
		if (existingClient) assertGrantedClient(existingClient);
	} catch {
		return {
			ok: false,
			error: "client RPC grant is missing or malformed",
			outcome: revokedClient ? "client_revoked" : "client_unknown",
			pairingSecretExpired: false,
		};
	}
	const hasActivePairingSecretForRevokedClient =
		rePairApprovalActive &&
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
		const workspaceStatus = workspaces.find((entry) => entry.name === hello.workspace)?.status;
		if (workspaceStatus === "missing") {
			return {
				ok: false,
				error: `workspace path is missing: ${hello.workspace}`,
				...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
				outcome: "workspace_missing",
				pairingSecretExpired: false,
			};
		}
		return {
			ok: false,
			error: `workspace path is unavailable: ${hello.workspace}`,
			...(expiredResultTickets ? { expiredPairingTickets: expiredResultTickets } : {}),
			outcome: "workspace_unavailable",
			pairingSecretExpired: false,
			retryAfterMs: IROH_REMOTE_WORKSPACE_UNAVAILABLE_RETRY_AFTER_MS,
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
		// A consumed ticket is the grant authority even when it carries no
		// customized tools: absence there means default-grant intent, so the new
		// client record tracks the current default instead of freezing a snapshot.
		const requestedAllowTools = matchingPendingPairingTicket
			? matchingPendingPairingTicket.allowedTools
			: options.allowTools;
		const persistedAllowedTools = canonicalizePersistedIrohRemoteAllowTools(
			requestedAllowTools,
			options.defaultAllowTools,
		);
		const allowedTools = normalizeIrohRemoteAllowTools(persistedAllowedTools, options.defaultAllowTools);
		let rpcGrant: IrohRemoteRpcGrant;
		try {
			const selectedGrant = parseIrohRemoteRpcGrant(
				matchingPendingPairingTicket?.rpcGrant ??
					options.rpcGrant ??
					createIrohRemotePresetAccess("coding").rpcGrant,
			);
			const revokedRevision =
				revokedClient === undefined
					? 0
					: parseIrohRemoteRpcGrant(revokedClient.rpcGrant, "revoked client rpcGrant").revision;
			if (revokedRevision === Number.MAX_SAFE_INTEGER) {
				throw new Error("revoked client RPC grant revision is exhausted");
			}
			rpcGrant = {
				...cloneIrohRemoteRpcGrant(selectedGrant),
				revision: Math.max(selectedGrant.revision, revokedRevision + 1),
			};
		} catch {
			return {
				ok: false,
				error: "pairing ticket RPC grant is missing or malformed",
				outcome: "client_unknown",
				pairingSecretExpired: false,
			};
		}
		const allowedWorkspace = matchingPendingPairingTicket?.workspace ?? workspace.name;
		const ticketExpiresAt = matchingPendingPairingTicket?.expiresAt ?? options.pairingExpiresAt;
		const client: IrohRemoteGrantedClient = {
			nodeId: remoteNodeId,
			label: hello.clientLabel || matchingPendingPairingTicket?.labelHint || remoteNodeId.slice(0, 12),
			allowedWorkspaces: [],
			...(persistedAllowedTools === undefined ? {} : { allowedTools: persistedAllowedTools }),
			rpcGrant,
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

	// Reconnects never write the grant back: a tracking client (no persisted
	// allowedTools) must keep resolving against the current default.
	const effectiveAllowTools = normalizeIrohRemoteAllowTools(existingClient.allowedTools, options.defaultAllowTools);
	existingClient.lastSeenAt = now;
	if (hello.clientLabel) {
		existingClient.label = hello.clientLabel;
	}
	return {
		ok: true,
		allowTools: effectiveAllowTools,
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

function assertGrantedClient(client: IrohRemoteClient): asserts client is IrohRemoteGrantedClient {
	client.rpcGrant = parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant");
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
