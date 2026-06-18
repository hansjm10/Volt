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
	type IrohRemoteWorkspace,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "./state.ts";
import { upsertIrohRemoteWorkspace } from "./workspace.ts";

export interface IrohRemoteHostStateManagerOptions {
	initialState?: IrohRemoteHostState;
	statePath?: string;
}

export interface IrohRemoteClientRevocationResult {
	revoked: boolean;
	client?: IrohRemoteClient;
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

	async authorizeClient(
		hello: IrohRemoteHello,
		remoteNodeId: string,
		options: AuthorizeIrohRemoteClientOptions,
	): Promise<IrohRemoteClientAuthorizationResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const result = authorizeIrohRemoteClient(state, hello, remoteNodeId, options);
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

	async revokeClient(nodeId: string): Promise<IrohRemoteClientRevocationResult> {
		return this.runExclusive(async () => {
			const state = await this.loadUnlocked();
			const clientIndex = state.clients.findIndex((client) => client.nodeId === nodeId);
			if (clientIndex === -1) {
				return { revoked: false };
			}

			const [client] = state.clients.splice(clientIndex, 1);
			await this.saveUnlocked(state);
			return { revoked: true, client: cloneClient(client) };
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
		return { ...result };
	}
	return {
		...result,
		client: cloneClient(result.client),
		workspace: cloneWorkspace(result.workspace),
	};
}

function cloneClient(client: IrohRemoteClient): IrohRemoteClient {
	return {
		...client,
		allowedWorkspaces: [...client.allowedWorkspaces],
	};
}

function cloneHostState(state: IrohRemoteHostState): IrohRemoteHostState {
	return {
		hostSecretKey: state.hostSecretKey ? [...state.hostSecretKey] : undefined,
		consumedPairingSecretHashes: [...(state.consumedPairingSecretHashes ?? [])],
		workspaces: state.workspaces.map((workspace) => cloneWorkspace(workspace)),
		clients: state.clients.map((client) => cloneClient(client)),
	};
}

function cloneWorkspace(workspace: IrohRemoteWorkspace): IrohRemoteWorkspace {
	return { ...workspace };
}
