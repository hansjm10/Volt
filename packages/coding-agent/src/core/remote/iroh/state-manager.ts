import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import {
	type AuthorizeIrohRemoteClientOptions,
	authorizeIrohRemoteClient,
	type IrohRemoteClientAuthorizationResult,
} from "./authorization.ts";
import type { IrohRemoteHello } from "./handshake.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteHostState,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "./state.ts";
import { findIrohRemoteWorkspace, upsertIrohRemoteWorkspace } from "./workspace.ts";

export interface IrohRemoteHostStateManagerOptions {
	initialState?: IrohRemoteHostState;
	statePath?: string;
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

export class IrohRemoteHostStateManager {
	private readonly statePath: string | undefined;
	private operationQueue: Promise<void> = Promise.resolve();
	private state: IrohRemoteHostState | undefined;

	constructor(options: IrohRemoteHostStateManagerOptions = {}) {
		if (options.initialState && options.statePath) {
			throw new Error("Cannot provide both initialState and statePath for Iroh remote host state manager");
		}
		this.statePath = options.statePath;
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

	async authorizeClient(
		hello: IrohRemoteHello,
		remoteNodeId: string,
		options: AuthorizeIrohRemoteClientOptions,
	): Promise<IrohRemoteClientAuthorizationResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const workspace = findIrohRemoteWorkspace(state, hello.workspace);
			const workspaceAvailable =
				workspace !== undefined &&
				(options.validateWorkspace === undefined || (await options.validateWorkspace(workspace)));
			const result = authorizeIrohRemoteClient(state, hello, remoteNodeId, {
				...options,
				workspace: workspaceAvailable ? workspace : undefined,
			});
			await this.saveUnlocked(state);
			return cloneAuthorizationResult(result);
		});
	}

	async listClients(): Promise<IrohRemoteClient[]> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			return state.clients.map((client) => cloneClient(client));
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
			client.lastSessionIdByWorkspace = {
				...(client.lastSessionIdByWorkspace ?? {}),
				[workspace]: sessionId,
			};
			await this.saveUnlocked(state);
			return cloneClient(client);
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
				allowedTools: client.allowedTools,
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
		if (this.statePath) {
			this.state = await readIrohRemoteHostState(this.statePath);
			return this.state;
		}
		this.state ??= createEmptyIrohRemoteHostState();
		return this.state;
	}

	private async saveUnlocked(state: IrohRemoteHostState | undefined): Promise<void> {
		const stateToSave = state ? cloneHostState(state) : createEmptyIrohRemoteHostState();
		this.state = stateToSave;
		if (this.statePath) {
			await writeIrohRemoteHostState(this.statePath, stateToSave);
		}
	}
}

function cloneAuthorizationResult(result: IrohRemoteClientAuthorizationResult): IrohRemoteClientAuthorizationResult {
	if (!result.ok) {
		return {
			...result,
			...(result.expiredPairingTickets
				? { expiredPairingTickets: result.expiredPairingTickets.map((ticket) => clonePendingPairingTicket(ticket)) }
				: {}),
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
	};
}

function cloneClient(client: IrohRemoteClient): IrohRemoteClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
		...(client.lastSessionIdByWorkspace ? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } } : {}),
	};
}

function cloneHostState(state: IrohRemoteHostState): IrohRemoteHostState {
	return {
		hostSecretKey: state.hostSecretKey ? [...state.hostSecretKey] : undefined,
		pairingSecretTombstones: (state.pairingSecretTombstones ?? []).map((tombstone) =>
			clonePairingSecretTombstone(tombstone),
		),
		workspaces: state.workspaces.map((workspace) => cloneWorkspace(workspace)),
		clients: state.clients.map((client) => cloneClient(client)),
		revokedClients: (state.revokedClients ?? []).map((client) => cloneRevokedClient(client)),
		pendingPairingTickets: (state.pendingPairingTickets ?? []).map((ticket) => clonePendingPairingTicket(ticket)),
	};
}

function clonePairingSecretTombstone(tombstone: IrohRemotePairingSecretTombstone): IrohRemotePairingSecretTombstone {
	return { ...tombstone };
}

function clonePendingPairingTicket(ticket: IrohRemotePendingPairingTicket): IrohRemotePendingPairingTicket {
	return { ...ticket };
}

function cloneRevokedClient(client: IrohRemoteRevokedClient): IrohRemoteRevokedClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
		...(client.lastSessionIdByWorkspace ? { lastSessionIdByWorkspace: { ...client.lastSessionIdByWorkspace } } : {}),
	};
}

function cloneWorkspace(workspace: IrohRemoteWorkspace): IrohRemoteWorkspace {
	return { ...workspace };
}

function getRevokedClients(state: IrohRemoteHostState): IrohRemoteRevokedClient[] {
	state.revokedClients ??= [];
	return state.revokedClients;
}
