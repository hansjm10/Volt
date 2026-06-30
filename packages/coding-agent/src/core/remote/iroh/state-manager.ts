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
	type IrohRemoteLiveActivityRegistration,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemotePushTarget,
	type IrohRemotePushTargetPlatform,
	type IrohRemotePushTokenEnvironment,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
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

	async unregisterWorkspace(name: string): Promise<IrohRemoteWorkspace | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const index = state.workspaces.findIndex((workspace) => workspace.name === name);
			if (index === -1) {
				return undefined;
			}
			const [removedWorkspace] = state.workspaces.splice(index, 1);
			state.pendingPairingTickets = (state.pendingPairingTickets ?? []).filter(
				(ticket) => ticket.workspace !== name,
			);
			await this.saveUnlocked(state);
			return removedWorkspace ? cloneWorkspace(removedWorkspace) : undefined;
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
			const result = authorizeIrohRemoteClient(state, hello, remoteNodeId, {
				...options,
				workspace: workspaceAvailable ? workspace : undefined,
				workspaceStatuses,
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

	async getClient(nodeId: string): Promise<IrohRemoteClient | undefined> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			return client ? cloneClient(client) : undefined;
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
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const client = state.clients.find((entry) => entry.nodeId === nodeId);
			if (!client) {
				return {};
			}
			let createdAt = registration.createdAt;
			let replacedRegistration: IrohRemoteLiveActivityRegistration | undefined;
			const retainedRegistrations: IrohRemoteLiveActivityRegistration[] = [];
			for (const existingRegistration of client.liveActivities ?? []) {
				if (existingRegistration.activityId === registration.activityId) {
					createdAt = existingRegistration.createdAt;
					replacedRegistration = existingRegistration;
					continue;
				}
				retainedRegistrations.push(existingRegistration);
			}
			const savedRegistration = { ...registration, createdAt };
			client.liveActivities = [...retainedRegistrations, savedRegistration];
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

function cloneClient(client: IrohRemoteClient): IrohRemoteClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
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
