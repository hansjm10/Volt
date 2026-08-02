import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { cloneIrohRemoteRpcGrant, type IrohRemoteRpcGrant, parseIrohRemoteRpcGrant } from "./access-grant.ts";
import {
	type AuthorizeIrohRemoteClientOptions,
	authorizeIrohRemoteClient,
	type IrohRemoteClientAuthorizationResult,
	type IrohRemoteClientAuthorizationSuccess,
	isIrohRemoteClientAllowedForWorkspace,
} from "./authorization.ts";
import type { IrohRemoteHello } from "./handshake.ts";
import { canonicalizePersistedIrohRemoteAllowTools } from "./protocol.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteGrantedClient,
	type IrohRemoteGrantedRevokedClient,
	type IrohRemoteHostState,
	type IrohRemoteLiveActivityRegistration,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemotePushTarget,
	type IrohRemotePushTargetPlatform,
	type IrohRemotePushTokenEnvironment,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
	type IrohRemoteWorkspaceWorktree,
	normalizeIrohRemoteLiveActivityRegistrations,
	parseIrohRemoteLiveActivityRegistration,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "./state.ts";
import {
	findIrohRemoteWorkspace,
	getIrohRemoteWorkspaceStatuses,
	type IrohRemoteWorkspaceAvailabilityClassifier,
	type IrohRemoteWorkspaceStatus,
	upsertIrohRemoteWorkspace,
} from "./workspace.ts";

export interface IrohRemoteHostStateStore {
	read(): IrohRemoteHostState | Promise<IrohRemoteHostState>;
	/** Resolve only after the supplied snapshot is durably persisted. */
	write(state: IrohRemoteHostState): void | Promise<void>;
}

export class IrohRemoteStatePersistenceAmbiguousError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "IrohRemoteStatePersistenceAmbiguousError";
	}
}

export interface IrohRemoteHostStateManagerOptions {
	initialState?: IrohRemoteHostState;
	statePath?: string;
	/** Custom persistence (e.g. the voltd state envelope); mutually exclusive with statePath. */
	store?: IrohRemoteHostStateStore;
	/** Default grant to canonicalize/resolve against; tests inject alternate defaults. */
	defaultAllowTools?: string;
}

export interface IrohRemoteClientRevocationResult {
	revoked: boolean;
	client?: IrohRemoteClient;
	revokedClient?: IrohRemoteRevokedClient;
}

export interface IrohRemoteClientRePairApprovalResult {
	approved: boolean;
	revokedClient?: IrohRemoteRevokedClient;
}

export type IrohRemoteClientAccessUpdateResult =
	| { ok: true; client: IrohRemoteGrantedClient }
	| {
			ok: false;
			reason: "not_found" | "revision_conflict" | "revision_exhausted";
			currentRevision?: number;
	  };

export type IrohRemoteAuthorizedSessionSelectionResult =
	| { ok: true; client: IrohRemoteGrantedClient; previousSessionId: string | undefined }
	| { ok: false; reason: "authorization_changed" };

export interface IrohRemoteLiveActivityDeliveryChannelLookup {
	tokenHash: string;
	tokenEnvironment: IrohRemotePushTokenEnvironment;
	platform: IrohRemotePushTargetPlatform;
}

export interface IrohRemoteLiveActivityRegistrationResult {
	client?: IrohRemoteClient;
	registration?: IrohRemoteLiveActivityRegistration;
	replacedRegistration?: IrohRemoteLiveActivityRegistration;
}

export interface IrohRemoteLiveActivityPruneResult {
	liveActivityRemoved: boolean;
	registrationsRemoved: number;
	pushTarget?: IrohRemotePushTarget;
}

export interface IrohRemoteWorkspaceWorktreeLifecycleContext {
	workspace: IrohRemoteWorkspace;
	worktrees: IrohRemoteWorkspaceWorktree[];
	allWorktrees: IrohRemoteWorkspaceWorktree[];
}

export interface IrohRemoteWorkspaceWorktreeLifecycleOutcome<T> {
	result: T;
	worktree?: IrohRemoteWorkspaceWorktree;
	removeWorktreeIds?: string[];
	afterPersistWhileLocked?: () => Promise<void>;
}

export const IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR = "workspace_has_worktrees";
export const IROH_REMOTE_WORKTREE_PARENT_WORKSPACE_NOT_FOUND_ERROR = "worktree_parent_workspace_not_found";
export const IROH_REMOTE_WORKTREE_PERSISTENCE_ERROR = "worktree_persistence_failed";

/**
 * A workspace with persisted worktree children cannot be unregistered. This
 * typed conflict is thrown from the state mutation itself so every caller,
 * including lower-level ones, gets the same non-destructive invariant.
 */
export class IrohRemoteWorkspaceHasWorktreesError extends Error {
	readonly code = IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR;
	readonly workspaceName: string;
	readonly worktreeIds: string[];

	constructor(workspaceName: string, worktrees: readonly IrohRemoteWorkspaceWorktree[]) {
		const worktreeIds = worktrees.map((worktree) => worktree.id).sort();
		const noun = worktreeIds.length === 1 ? "worktree" : "worktrees";
		super(
			`Workspace ${workspaceName} has ${worktreeIds.length} daemon-managed ${noun} (${worktreeIds.join(", ")}). ` +
				`Remove each with "volt remote worktree remove <id> --workspace ${workspaceName}" before unregistering; ` +
				"use --force only to explicitly discard dirty or busy worktrees.",
		);
		this.name = "IrohRemoteWorkspaceHasWorktreesError";
		this.workspaceName = workspaceName;
		this.worktreeIds = worktreeIds;
	}
}

export function isIrohRemoteWorkspaceHasWorktreesError(error: unknown): error is IrohRemoteWorkspaceHasWorktreesError {
	return error instanceof IrohRemoteWorkspaceHasWorktreesError;
}

export class IrohRemoteWorktreeParentWorkspaceNotFoundError extends Error {
	readonly code = IROH_REMOTE_WORKTREE_PARENT_WORKSPACE_NOT_FOUND_ERROR;
	readonly workspaceName: string;

	constructor(workspaceName: string) {
		super(`Cannot persist a worktree for unregistered workspace ${workspaceName}`);
		this.name = "IrohRemoteWorktreeParentWorkspaceNotFoundError";
		this.workspaceName = workspaceName;
	}
}

export function isIrohRemoteWorktreeParentWorkspaceNotFoundError(
	error: unknown,
): error is IrohRemoteWorktreeParentWorkspaceNotFoundError {
	return error instanceof IrohRemoteWorktreeParentWorkspaceNotFoundError;
}

export class IrohRemoteWorktreePersistenceError extends Error {
	readonly code = IROH_REMOTE_WORKTREE_PERSISTENCE_ERROR;
	readonly workspaceName: string;
	readonly worktreeId: string;

	constructor(workspaceName: string, worktreeId: string, cause: unknown) {
		super(`Failed to persist worktree ${worktreeId} for workspace ${workspaceName}`, { cause });
		this.name = "IrohRemoteWorktreePersistenceError";
		this.workspaceName = workspaceName;
		this.worktreeId = worktreeId;
	}
}

export function isIrohRemoteWorktreePersistenceError(error: unknown): error is IrohRemoteWorktreePersistenceError {
	return error instanceof IrohRemoteWorktreePersistenceError;
}

export class IrohRemoteHostStateManager {
	private readonly statePath: string | undefined;
	private readonly store: IrohRemoteHostStateStore | undefined;
	private readonly defaultAllowTools: string | undefined;
	private operationQueue: Promise<void> = Promise.resolve();
	private state: IrohRemoteHostState | undefined;

	constructor(options: IrohRemoteHostStateManagerOptions = {}) {
		if (options.initialState && options.statePath) {
			throw new Error("Cannot provide both initialState and statePath for Iroh remote host state manager");
		}
		if (options.store && (options.statePath || options.initialState)) {
			throw new Error(
				"Cannot combine a custom store with statePath/initialState for Iroh remote host state manager",
			);
		}
		this.statePath = options.statePath;
		this.store = options.store;
		this.defaultAllowTools = options.defaultAllowTools;
		this.state = options.initialState ? cloneHostState(options.initialState) : undefined;
	}

	async load(): Promise<IrohRemoteHostState> {
		return this.runExclusive(async () => cloneHostState(await this.loadUnlocked()));
	}

	async save(state?: IrohRemoteHostState): Promise<void> {
		await this.runExclusive(async () => {
			if (state !== undefined && this.statePath) {
				throw new Error("Cannot save explicit Iroh remote host state snapshots for file-backed state");
			}
			if (state === undefined && this.statePath) {
				this.state = await this.loadUnlocked();
			}
			await this.saveUnlocked(state !== undefined ? cloneHostState(state) : this.state);
		});
	}

	async getState(): Promise<IrohRemoteHostState> {
		return this.runExclusive(async () => cloneHostState(await this.loadUnlocked()));
	}

	async upsertWorkspace(workspace: IrohRemoteWorkspace, allowTools?: string): Promise<IrohRemoteWorkspace> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const savedWorkspace = upsertIrohRemoteWorkspace(state, workspace, allowTools);
			await this.saveUnlocked(state);
			return cloneWorkspace(savedWorkspace);
		});
	}

	async unregisterWorkspace(name: string): Promise<IrohRemoteWorkspace | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const index = state.workspaces.findIndex((workspace) => workspace.name === name);
			if (index === -1) {
				return undefined;
			}
			const worktrees = (state.worktrees ?? []).filter((worktree) => worktree.workspaceName === name);
			if (worktrees.length > 0) {
				throw new IrohRemoteWorkspaceHasWorktreesError(name, worktrees);
			}
			const [removedWorkspace] = state.workspaces.splice(index, 1);
			state.pendingPairingTickets = (state.pendingPairingTickets ?? []).filter(
				(ticket) => ticket.workspace !== name,
			);
			await this.saveUnlocked(state);
			return removedWorkspace ? cloneWorkspace(removedWorkspace) : undefined;
		});
	}

	/**
	 * Serialize a worktree create/adopt side effect with workspace unregister and
	 * commit its child record in the same state transaction. The operation runs
	 * while the state lock is held so an unregister cannot observe the gap between
	 * `git worktree add` and durable child persistence.
	 */
	async runWorkspaceWorktreeLifecycle<T>(
		workspaceName: string,
		operation: (
			context: IrohRemoteWorkspaceWorktreeLifecycleContext,
		) => Promise<IrohRemoteWorkspaceWorktreeLifecycleOutcome<T>>,
	): Promise<T> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const workspace = state.workspaces.find((entry) => entry.name === workspaceName);
			if (!workspace) {
				throw new IrohRemoteWorktreeParentWorkspaceNotFoundError(workspaceName);
			}
			const allWorktrees = (state.worktrees ?? []).map((worktree) => cloneWorktree(worktree));
			const outcome = await operation({
				workspace: cloneWorkspace(workspace),
				worktrees: allWorktrees.filter((worktree) => worktree.workspaceName === workspaceName),
				allWorktrees,
			});
			if (outcome.worktree !== undefined && outcome.removeWorktreeIds !== undefined) {
				throw new Error("Worktree lifecycle cannot persist and remove children in the same outcome");
			}
			if (outcome.worktree === undefined && outcome.removeWorktreeIds === undefined) {
				return outcome.result;
			}
			if (outcome.worktree !== undefined && outcome.worktree.workspaceName !== workspaceName) {
				throw new Error("Worktree lifecycle result does not match its parent workspace");
			}

			const worktreeIds = new Set(
				outcome.worktree === undefined ? outcome.removeWorktreeIds : [outcome.worktree.id],
			);
			const previousState = cloneHostState(state);
			state.worktrees = (state.worktrees ?? []).filter(
				(entry) => entry.workspaceName !== workspaceName || !worktreeIds.has(entry.id),
			);
			if (outcome.worktree !== undefined) {
				state.worktrees.push(cloneWorktree(outcome.worktree));
			}
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw new IrohRemoteWorktreePersistenceError(workspaceName, Array.from(worktreeIds).join(","), error);
			}
			try {
				await outcome.afterPersistWhileLocked?.();
			} catch (error) {
				try {
					await this.saveUnlocked(previousState);
				} catch (restoreError) {
					throw new IrohRemoteWorktreePersistenceError(
						workspaceName,
						Array.from(worktreeIds).join(","),
						new AggregateError([error, restoreError], "worktree lifecycle compensation failed"),
					);
				}
				throw error;
			}
			return outcome.result;
		});
	}

	async upsertWorktree(worktree: IrohRemoteWorkspaceWorktree): Promise<IrohRemoteWorkspaceWorktree> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			if (!state.workspaces.some((workspace) => workspace.name === worktree.workspaceName)) {
				throw new IrohRemoteWorktreeParentWorkspaceNotFoundError(worktree.workspaceName);
			}
			const previousState = cloneHostState(state);
			state.worktrees = [
				...(state.worktrees ?? []).filter(
					(entry) => entry.workspaceName !== worktree.workspaceName || entry.id !== worktree.id,
				),
				cloneWorktree(worktree),
			];
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw new IrohRemoteWorktreePersistenceError(worktree.workspaceName, worktree.id, error);
			}
			return cloneWorktree(worktree);
		});
	}

	async removeWorktree(workspaceName: string, worktreeId: string): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const worktrees = state.worktrees ?? [];
			const removed = worktrees.find((entry) => entry.workspaceName === workspaceName && entry.id === worktreeId);
			if (!removed) {
				return undefined;
			}
			state.worktrees = worktrees.filter((entry) => entry !== removed);
			await this.saveUnlocked(state);
			return cloneWorktree(removed);
		});
	}

	async listWorktrees(workspaceName?: string): Promise<IrohRemoteWorkspaceWorktree[]> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return (state.worktrees ?? [])
				.filter((entry) => workspaceName === undefined || entry.workspaceName === workspaceName)
				.map((entry) => cloneWorktree(entry));
		});
	}

	async bindWorktreeSession(workspaceName: string, worktreeId: string, sessionId: string): Promise<void> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const worktree = (state.worktrees ?? []).find(
				(entry) => entry.workspaceName === workspaceName && entry.id === worktreeId,
			);
			if (!worktree || worktree.sessionIds.includes(sessionId)) {
				return;
			}
			worktree.sessionIds = [...worktree.sessionIds, sessionId];
			await this.saveUnlocked(state);
		});
	}

	async findWorktreeForSession(
		workspaceName: string,
		sessionId: string,
	): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const worktree = (state.worktrees ?? []).find(
				(entry) => entry.workspaceName === workspaceName && entry.sessionIds.includes(sessionId),
			);
			return worktree ? cloneWorktree(worktree) : undefined;
		});
	}

	async listWorkspaceStatuses(
		options: { classifyWorkspaceAvailability?: IrohRemoteWorkspaceAvailabilityClassifier } = {},
	): Promise<IrohRemoteWorkspaceStatus[]> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return await getIrohRemoteWorkspaceStatuses(state, options.classifyWorkspaceAvailability);
		});
	}

	async addPendingPairingTicket(ticket: IrohRemotePendingPairingTicket): Promise<IrohRemotePendingPairingTicket> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			state.pendingPairingTickets = [
				...(state.pendingPairingTickets ?? []).filter((entry) => entry.secretHash !== ticket.secretHash),
				clonePendingPairingTicket(ticket),
			];
			await this.saveUnlocked(state);
			return clonePendingPairingTicket(ticket);
		});
	}

	async removePendingPairingTicket(secretHash: string): Promise<boolean> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const pending = state.pendingPairingTickets ?? [];
			const remaining = pending.filter((entry) => entry.secretHash !== secretHash);
			if (remaining.length === pending.length) return false;
			state.pendingPairingTickets = remaining;
			await this.saveUnlocked(state);
			return true;
		});
	}

	async authorizeClient(
		hello: IrohRemoteHello,
		remoteNodeId: string,
		options: AuthorizeIrohRemoteClientOptions,
	): Promise<IrohRemoteClientAuthorizationResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const workspaceStatuses = await this.getWorkspaceStatuses(state, options);
			const workspace = findIrohRemoteWorkspace(state, hello.workspace);
			const workspaceStatus = workspaceStatuses.find((entry) => entry.name === hello.workspace)?.status;
			const workspaceAvailable =
				workspace !== undefined &&
				workspaceStatus === "available" &&
				(options.validateWorkspace === undefined || (await options.validateWorkspace(workspace)));
			const defaultAllowTools = options.defaultAllowTools ?? this.defaultAllowTools;
			const result = authorizeIrohRemoteClient(state, hello, remoteNodeId, {
				...options,
				...(defaultAllowTools === undefined ? {} : { defaultAllowTools }),
				workspace: workspaceAvailable ? workspace : undefined,
				workspaceStatuses,
			});
			await this.saveUnlocked(state);
			return cloneAuthorizationResult(result);
		});
	}

	async listClients(): Promise<IrohRemoteGrantedClient[]> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return state.clients.map((client) => cloneClient(client));
		});
	}

	async getClient(nodeId: string): Promise<IrohRemoteGrantedClient | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			return client ? cloneClient(client) : undefined;
		});
	}

	/** Atomically revalidate every persisted authority component captured by a stream handshake. */
	async isAuthorizationCurrent(authorization: IrohRemoteClientAuthorizationSuccess): Promise<boolean> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return isAuthorizationCurrentInState(state, authorization);
		});
	}

	async updateClientAccess(
		nodeId: string,
		expectedRevision: number,
		access: { allowedTools: string; rpcGrant: IrohRemoteRpcGrant },
	): Promise<IrohRemoteClientAccessUpdateResult> {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
			throw new Error("expected RPC grant revision must be a safe integer greater than or equal to 1");
		}
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return { ok: false, reason: "not_found" };
			}
			const currentGrant = parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant");
			if (currentGrant.revision !== expectedRevision) {
				return { ok: false, reason: "revision_conflict", currentRevision: currentGrant.revision };
			}
			if (currentGrant.revision === Number.MAX_SAFE_INTEGER) {
				return { ok: false, reason: "revision_exhausted", currentRevision: currentGrant.revision };
			}
			const persistedAllowedTools = canonicalizePersistedIrohRemoteAllowTools(
				access.allowedTools,
				this.defaultAllowTools,
			);
			if (persistedAllowedTools === undefined) {
				delete client.allowedTools;
			} else {
				client.allowedTools = persistedAllowedTools;
			}
			client.rpcGrant = {
				...cloneIrohRemoteRpcGrant(access.rpcGrant),
				revision: expectedRevision + 1,
			};
			await this.saveUnlocked(state);
			return { ok: true, client: cloneClient(client) };
		});
	}

	async listRevokedClients(): Promise<IrohRemoteRevokedClient[]> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return getRevokedClients(state).map((client) => cloneRevokedClient(client));
		});
	}

	async setClientLastSessionId(
		nodeId: string,
		workspace: string,
		sessionId: string,
	): Promise<IrohRemoteClient | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return undefined;
			}
			const previousState = cloneHostState(state);
			client.lastSessionIdByWorkspace = {
				...(client.lastSessionIdByWorkspace ?? {}),
				[workspace]: sessionId,
			};
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw error;
			}
			return cloneClient(client);
		});
	}

	async setClientLastSessionIdIfAuthorizationCurrent(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		expectedPreviousSessionId: string | undefined,
		whileAuthorizationLocked?: () => Promise<void>,
	): Promise<IrohRemoteAuthorizedSessionSelectionResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			if (!isAuthorizationCurrentInState(state, authorization)) {
				return { ok: false, reason: "authorization_changed" };
			}
			const client = state.clients.find((entry) => entry.nodeId === authorization.client.nodeId)!;
			const previousSessionId = client.lastSessionIdByWorkspace?.[authorization.workspace.name];
			if (previousSessionId !== expectedPreviousSessionId) {
				return { ok: false, reason: "authorization_changed" };
			}
			const previousState = cloneHostState(state);
			client.lastSessionIdByWorkspace = {
				...(client.lastSessionIdByWorkspace ?? {}),
				[authorization.workspace.name]: sessionId,
			};
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw error;
			}
			await whileAuthorizationLocked?.();
			return { ok: true, client: cloneClient(client), previousSessionId };
		});
	}

	async setClientLastSessionIdIfCurrent(
		nodeId: string,
		workspace: string,
		expectedSessionId: string | undefined,
		nextSessionId: string,
	): Promise<boolean> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client || client.lastSessionIdByWorkspace?.[workspace] !== expectedSessionId) {
				return false;
			}
			const previousState = cloneHostState(state);
			client.lastSessionIdByWorkspace = {
				...(client.lastSessionIdByWorkspace ?? {}),
				[workspace]: nextSessionId,
			};
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw error;
			}
			return true;
		});
	}

	async restoreClientLastSessionIdIfCurrent(
		nodeId: string,
		workspace: string,
		expectedSessionId: string,
		previousSessionId: string | undefined,
	): Promise<boolean> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (client?.lastSessionIdByWorkspace?.[workspace] !== expectedSessionId) {
				return false;
			}
			const previousState = cloneHostState(state);
			if (previousSessionId === undefined) {
				delete client.lastSessionIdByWorkspace[workspace];
				if (Object.keys(client.lastSessionIdByWorkspace).length === 0) {
					delete client.lastSessionIdByWorkspace;
				}
			} else {
				client.lastSessionIdByWorkspace[workspace] = previousSessionId;
			}
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw error;
			}
			return true;
		});
	}

	/** Persist one conversation selection for every attached client in one state write. */
	async setClientsLastSessionId(
		nodeIds: readonly string[],
		workspace: string,
		sessionId: string,
	): Promise<IrohRemoteClient[]> {
		const selectedNodeIds = new Set(nodeIds);
		if (selectedNodeIds.size === 0) {
			return [];
		}
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const previousState = cloneHostState(state);
			const clients = state.clients.filter((client) => selectedNodeIds.has(client.nodeId));
			if (clients.length !== selectedNodeIds.size) {
				const foundNodeIds = new Set(clients.map((client) => client.nodeId));
				const missingNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !foundNodeIds.has(nodeId));
				throw new Error(`Cannot persist session selection for unknown client(s): ${missingNodeIds.join(", ")}`);
			}
			for (const client of clients) {
				client.lastSessionIdByWorkspace = {
					...(client.lastSessionIdByWorkspace ?? {}),
					[workspace]: sessionId,
				};
			}
			try {
				await this.saveUnlocked(state);
			} catch (error) {
				await this.restoreAfterFailedPersistence(previousState);
				throw error;
			}
			return clients.map((client) => cloneClient(client));
		});
	}

	async upsertClientPushTarget(
		nodeId: string,
		pushTarget: IrohRemotePushTarget,
	): Promise<IrohRemoteClient | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return undefined;
			}
			let createdAt = pushTarget.createdAt;
			const retainedTargets: IrohRemotePushTarget[] = [];
			for (const existingTarget of client.pushTargets ?? []) {
				if (isSamePushTargetSlot(existingTarget, pushTarget)) {
					createdAt = existingTarget.createdAt;
					continue;
				}
				retainedTargets.push(existingTarget);
			}
			client.pushTargets = [...retainedTargets, { ...pushTarget, createdAt }];
			await this.saveUnlocked(state);
			return cloneClient(client);
		});
	}

	async disableClientPushTarget(
		nodeId: string,
		pushTargetId: string,
		now = Date.now(),
	): Promise<IrohRemotePushTarget | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			const pushTarget = client?.pushTargets?.find((entry) => entry.id === pushTargetId);
			if (!pushTarget) {
				return undefined;
			}
			pushTarget.enabled = false;
			delete pushTarget.liveActivity;
			pushTarget.updatedAt = now;
			await this.saveUnlocked(state);
			return clonePushTarget(pushTarget);
		});
	}

	async findClientLiveActivityDeliveryChannel(
		nodeId: string,
		lookup: IrohRemoteLiveActivityDeliveryChannelLookup,
	): Promise<IrohRemotePushTarget | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			const pushTarget = client?.pushTargets?.find(
				(entry) =>
					entry.platform === lookup.platform &&
					entry.liveActivity?.tokenHash === lookup.tokenHash &&
					entry.liveActivity.tokenEnvironment === lookup.tokenEnvironment,
			);
			return pushTarget ? clonePushTarget(pushTarget) : undefined;
		});
	}

	async registerClientLiveActivity(
		nodeId: string,
		registration: IrohRemoteLiveActivityRegistration,
	): Promise<IrohRemoteLiveActivityRegistrationResult> {
		const validatedRegistration = parseIrohRemoteLiveActivityRegistration(registration);
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return {};
			}
			let createdAt = validatedRegistration.createdAt;
			let replacedRegistration: IrohRemoteLiveActivityRegistration | undefined;
			const retainedRegistrations: IrohRemoteLiveActivityRegistration[] = [];
			for (const existingRegistration of client.liveActivities ?? []) {
				if (
					(existingRegistration.workspaceName === validatedRegistration.workspaceName &&
						existingRegistration.sessionId === validatedRegistration.sessionId) ||
					existingRegistration.activityId === validatedRegistration.activityId
				) {
					createdAt = existingRegistration.createdAt;
					replacedRegistration = existingRegistration;
					continue;
				}
				retainedRegistrations.push(existingRegistration);
			}
			const savedRegistration = { ...validatedRegistration, createdAt };
			client.liveActivities = normalizeIrohRemoteLiveActivityRegistrations([
				...retainedRegistrations,
				savedRegistration,
			]);
			await this.saveUnlocked(state);
			return {
				client: cloneClient(client),
				registration: cloneLiveActivityRegistration(savedRegistration),
				...(replacedRegistration
					? { replacedRegistration: cloneLiveActivityRegistration(replacedRegistration) }
					: {}),
			};
		});
	}

	async unregisterClientLiveActivity(
		nodeId: string,
		workspaceName: string,
		sessionId: string,
		activityId: string,
	): Promise<boolean> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client?.liveActivities) {
				return false;
			}
			const beforeCount = client.liveActivities.length;
			client.liveActivities = client.liveActivities.filter(
				(entry) =>
					entry.workspaceName !== workspaceName ||
					entry.sessionId !== sessionId ||
					entry.activityId !== activityId,
			);
			const removed = client.liveActivities.length !== beforeCount;
			if (client.liveActivities.length === 0) {
				delete client.liveActivities;
			}
			if (removed) {
				await this.saveUnlocked(state);
			}
			return removed;
		});
	}

	async pruneClientLiveActivityDeliveryChannel(
		nodeId: string,
		registration: IrohRemoteLiveActivityRegistration,
		now = Date.now(),
	): Promise<IrohRemoteLiveActivityPruneResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return { liveActivityRemoved: false, registrationsRemoved: 0 };
			}

			let registrationsRemoved = 0;
			if (client.liveActivities) {
				const beforeCount = client.liveActivities.length;
				client.liveActivities = client.liveActivities.filter(
					(entry) => !isSameLiveActivityRegistration(entry, registration),
				);
				registrationsRemoved = beforeCount - client.liveActivities.length;
				if (client.liveActivities.length === 0) {
					delete client.liveActivities;
				}
			}

			const pushTarget = client.pushTargets?.find((entry) => {
				return (
					entry.id === registration.pushTargetId &&
					entry.platform === registration.platform &&
					entry.liveActivity?.tokenHash === registration.tokenHash &&
					entry.liveActivity.tokenEnvironment === registration.tokenEnvironment
				);
			});
			const liveActivityRemoved = pushTarget?.liveActivity !== undefined;
			if (liveActivityRemoved && pushTarget) {
				delete pushTarget.liveActivity;
				pushTarget.updatedAt = now;
			}

			if (registrationsRemoved > 0 || liveActivityRemoved) {
				await this.saveUnlocked(state);
			}
			return {
				liveActivityRemoved,
				registrationsRemoved,
				...(pushTarget ? { pushTarget: clonePushTarget(pushTarget) } : {}),
			};
		});
	}

	async removeClientLiveActivitiesForSession(
		nodeId: string,
		workspaceName: string,
		sessionId: string,
	): Promise<number> {
		return this.removeClientLiveActivities(nodeId, (entry) => {
			return entry.workspaceName === workspaceName && entry.sessionId === sessionId;
		});
	}

	async removeClientLiveActivitiesForWorkspace(nodeId: string, workspaceName: string): Promise<number> {
		return this.removeClientLiveActivities(nodeId, (entry) => entry.workspaceName === workspaceName);
	}

	/** Remove one runtime's complete conversation-identity history across every paired client. */
	async removeLiveActivitiesForWorkspaceSessions(
		workspaceName: string,
		sessionIds: ReadonlySet<string>,
	): Promise<number> {
		const selectedSessionIds = new Set(sessionIds);
		if (selectedSessionIds.size === 0) {
			return 0;
		}
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			let removedCount = 0;
			for (const client of state.clients) {
				if (!client.liveActivities) {
					continue;
				}
				const beforeCount = client.liveActivities.length;
				client.liveActivities = client.liveActivities.filter(
					(entry) => entry.workspaceName !== workspaceName || !selectedSessionIds.has(entry.sessionId),
				);
				removedCount += beforeCount - client.liveActivities.length;
				if (client.liveActivities.length === 0) {
					delete client.liveActivities;
				}
			}
			if (removedCount > 0) {
				await this.saveUnlocked(state);
			}
			return removedCount;
		});
	}

	async removeLiveActivitiesForWorkspace(workspaceName: string): Promise<number> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			let removedCount = 0;
			for (const client of state.clients) {
				if (!client.liveActivities) {
					continue;
				}
				const beforeCount = client.liveActivities.length;
				client.liveActivities = client.liveActivities.filter((entry) => entry.workspaceName !== workspaceName);
				removedCount += beforeCount - client.liveActivities.length;
				if (client.liveActivities.length === 0) {
					delete client.liveActivities;
				}
			}
			if (removedCount > 0) {
				await this.saveUnlocked(state);
			}
			return removedCount;
		});
	}

	async revokeClient(nodeId: string, now = Date.now()): Promise<IrohRemoteClientRevocationResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const clientIndex = state.clients.findIndex((client) => client.nodeId === nodeId);
			if (clientIndex === -1) {
				const revokedClient = getRevokedClients(state).find((client) => client.nodeId === nodeId);
				return {
					revoked: false,
					...(revokedClient ? { revokedClient: cloneRevokedClient(revokedClient) } : {}),
				};
			}

			const [client] = state.clients.splice(clientIndex, 1);
			const revokedClient: IrohRemoteRevokedClient = {
				nodeId: client.nodeId,
				label: client.label,
				allowedWorkspaces: [...client.allowedWorkspaces],
				...(client.allowedTools === undefined ? {} : { allowedTools: client.allowedTools }),
				rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant"),
				pairedAt: client.pairedAt,
				lastSeenAt: client.lastSeenAt,
				revokedAt: now,
				...(client.lastSessionIdByWorkspace
					? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } }
					: {}),
			};
			state.revokedClients = [...getRevokedClients(state).filter((entry) => entry.nodeId !== nodeId), revokedClient];
			await this.saveUnlocked(state);
			return { revoked: true, client: cloneClient(client), revokedClient: cloneRevokedClient(revokedClient) };
		});
	}

	async approveClientRePair(nodeId: string, now = Date.now()): Promise<IrohRemoteClientRePairApprovalResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const revokedClient = getRevokedClients(state).find((client) => client.nodeId === nodeId);
			if (!revokedClient) {
				return { approved: false };
			}
			revokedClient.rePairApprovedAt = now;
			await this.saveUnlocked(state);
			return { approved: true, revokedClient: cloneRevokedClient(revokedClient) };
		});
	}

	private async getWorkspaceStatuses(
		state: IrohRemoteHostState,
		options: AuthorizeIrohRemoteClientOptions,
	): Promise<IrohRemoteWorkspaceStatus[]> {
		return await getIrohRemoteWorkspaceStatuses(state, options.classifyWorkspaceAvailability);
	}

	private runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
		const run = this.operationQueue.then(
			() => this.withStateFileLock(operation),
			() => this.withStateFileLock(operation),
		);
		this.operationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async withStateFileLock<T>(operation: () => T | Promise<T>): Promise<T> {
		if (!this.statePath) {
			return await operation();
		}

		await mkdir(dirname(this.statePath), { recursive: true });
		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Iroh remote host state lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.statePath, {
				lockfilePath: `${this.statePath}.lock`,
				realpath: false,
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (error) => {
					lockCompromised = true;
					lockCompromisedError = error;
				},
			});

			throwIfCompromised();
			const result = await operation();
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors after a compromised lock.
				}
			}
		}
	}

	private async loadUnlocked(): Promise<IrohRemoteHostState> {
		if (this.store) {
			this.state = cloneHostState(await this.store.read());
			return this.state;
		}
		if (this.statePath) {
			this.state = await readIrohRemoteHostState(this.statePath, { defaultAllowTools: this.defaultAllowTools });
			return this.state;
		}
		this.state ??= createEmptyIrohRemoteHostState();
		return this.state;
	}

	private async saveUnlocked(state: IrohRemoteHostState | undefined): Promise<void> {
		const stateToSave = state ? cloneHostState(state) : createEmptyIrohRemoteHostState();
		this.state = stateToSave;
		if (this.store) {
			await this.store.write(cloneHostState(stateToSave));
			return;
		}
		if (this.statePath) {
			await writeIrohRemoteHostState(this.statePath, stateToSave);
		}
	}

	private async restoreAfterFailedPersistence(previousState: IrohRemoteHostState): Promise<void> {
		const restoredState = cloneHostState(previousState);
		this.state = restoredState;
		try {
			if (this.store) {
				await this.store.write(cloneHostState(restoredState));
			} else if (this.statePath) {
				await writeIrohRemoteHostState(this.statePath, restoredState);
			}
			this.state = restoredState;
		} catch (error) {
			throw new IrohRemoteStatePersistenceAmbiguousError(
				"remote host state compensation could not be durably confirmed",
				{ cause: error },
			);
		}
	}

	private async removeClientLiveActivities(
		nodeId: string,
		shouldRemove: (registration: IrohRemoteLiveActivityRegistration) => boolean,
	): Promise<number> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client?.liveActivities) {
				return 0;
			}
			const beforeCount = client.liveActivities.length;
			client.liveActivities = client.liveActivities.filter((entry) => !shouldRemove(entry));
			const removedCount = beforeCount - client.liveActivities.length;
			if (client.liveActivities.length === 0) {
				delete client.liveActivities;
			}
			if (removedCount > 0) {
				await this.saveUnlocked(state);
			}
			return removedCount;
		});
	}
}

function isAuthorizationCurrentInState(
	state: IrohRemoteHostState,
	authorization: IrohRemoteClientAuthorizationSuccess,
): boolean {
	const client = state.clients.find((entry) => entry.nodeId === authorization.client.nodeId);
	const workspace = state.workspaces.find((entry) => entry.name === authorization.workspace.name);
	const workspaceGeneration = (state.workspaceGenerations ?? []).find(
		(record) => record.workspaceName === authorization.workspace.name,
	)?.generation;
	return (
		client?.rpcGrant?.revision === authorization.client.rpcGrant.revision &&
		client.allowedTools === authorization.client.allowedTools &&
		isIrohRemoteClientAllowedForWorkspace(client, authorization.workspace.name) &&
		workspace?.path === authorization.workspace.path &&
		workspace.allowedTools === authorization.workspace.allowedTools &&
		workspaceGeneration === authorization.workspaceGeneration
	);
}

function cloneAuthorizationResult(result: IrohRemoteClientAuthorizationResult): IrohRemoteClientAuthorizationResult {
	if (!result.ok) {
		return {
			...result,
			...(result.client ? { client: cloneClient(result.client) } : {}),
			...(result.expiredPairingTickets
				? { expiredPairingTickets: result.expiredPairingTickets.map((ticket) => clonePendingPairingTicket(ticket)) }
				: {}),
			...(result.workspace ? { workspace: cloneWorkspace(result.workspace) } : {}),
		};
	}
	return {
		...result,
		client: cloneClient(result.client),
		...(result.consumedPairingTicket
			? { consumedPairingTicket: clonePendingPairingTicket(result.consumedPairingTicket) }
			: {}),
		...(result.expiredPairingTickets
			? { expiredPairingTickets: result.expiredPairingTickets.map((ticket) => clonePendingPairingTicket(ticket)) }
			: {}),
		workspace: cloneWorkspace(result.workspace),
		workspaceNames: [...result.workspaceNames],
		workspaces: result.workspaces.map((workspace) => ({ ...workspace })),
	};
}

function cloneClient(client: IrohRemoteClient): IrohRemoteGrantedClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
		rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant"),
		...(client.lastSessionIdByWorkspace ? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } } : {}),
		...(client.pushTargets ? { pushTargets: client.pushTargets.map((target) => clonePushTarget(target)) } : {}),
		...(client.liveActivities
			? { liveActivities: client.liveActivities.map((registration) => cloneLiveActivityRegistration(registration)) }
			: {}),
	};
}

function cloneHostState(state: IrohRemoteHostState): IrohRemoteHostState {
	return {
		hostSecretKey: state.hostSecretKey ? [...state.hostSecretKey] : undefined,
		pairingSecretTombstones: (state.pairingSecretTombstones ?? []).map((tombstone) =>
			clonePairingSecretTombstone(tombstone),
		),
		workspaceGenerationCounter: state.workspaceGenerationCounter ?? 0,
		workspaceGenerations: (state.workspaceGenerations ?? []).map((record) => ({ ...record })),
		workspaces: state.workspaces.map((workspace) => cloneWorkspace(workspace)),
		worktrees: (state.worktrees ?? []).map((worktree) => cloneWorktree(worktree)),
		clients: state.clients.map((client) => cloneClient(client)),
		revokedClients: (state.revokedClients ?? []).map((client) => cloneRevokedClient(client)),
		pendingPairingTickets: (state.pendingPairingTickets ?? []).map((ticket) => clonePendingPairingTicket(ticket)),
	};
}

function clonePairingSecretTombstone(tombstone: IrohRemotePairingSecretTombstone): IrohRemotePairingSecretTombstone {
	return { ...tombstone };
}

function clonePendingPairingTicket(ticket: IrohRemotePendingPairingTicket): IrohRemotePendingPairingTicket {
	return {
		...ticket,
		...(ticket.rpcGrant === undefined ? {} : { rpcGrant: cloneIrohRemoteRpcGrant(ticket.rpcGrant) }),
	};
}

function clonePushTarget(pushTarget: IrohRemotePushTarget): IrohRemotePushTarget {
	return {
		...pushTarget,
		...(pushTarget.liveActivity ? { liveActivity: { ...pushTarget.liveActivity } } : {}),
	};
}

function cloneLiveActivityRegistration(
	registration: IrohRemoteLiveActivityRegistration,
): IrohRemoteLiveActivityRegistration {
	return { ...registration };
}

function cloneRevokedClient(client: IrohRemoteRevokedClient): IrohRemoteGrantedRevokedClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
		rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "revoked client rpcGrant"),
		...(client.lastSessionIdByWorkspace ? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } } : {}),
	};
}

function cloneWorkspace(workspace: IrohRemoteWorkspace): IrohRemoteWorkspace {
	return { ...workspace };
}

function cloneWorktree(worktree: IrohRemoteWorkspaceWorktree): IrohRemoteWorkspaceWorktree {
	return { ...worktree, sessionIds: [...worktree.sessionIds] };
}

function getRevokedClients(state: IrohRemoteHostState): IrohRemoteRevokedClient[] {
	state.revokedClients ??= [];
	return state.revokedClients;
}

function isSamePushTargetSlot(a: IrohRemotePushTarget, b: IrohRemotePushTarget): boolean {
	return a.id === b.id || (a.provider === b.provider && a.platform === b.platform);
}

function isSameLiveActivityRegistration(
	a: IrohRemoteLiveActivityRegistration,
	b: IrohRemoteLiveActivityRegistration,
): boolean {
	return (
		a.workspaceName === b.workspaceName &&
		a.sessionId === b.sessionId &&
		a.activityId === b.activityId &&
		a.tokenHash === b.tokenHash &&
		a.tokenEnvironment === b.tokenEnvironment &&
		a.platform === b.platform &&
		a.pushTargetId === b.pushTargetId
	);
}
