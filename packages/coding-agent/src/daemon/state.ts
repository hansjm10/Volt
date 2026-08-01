import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteHostState,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
	type IrohRemoteWorkspaceWorktree,
	parseIrohRemoteHostState,
} from "../core/remote/iroh/state.ts";
import { DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS } from "../remote/integrated-runtime-retention.ts";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";

/**
 * Persistent daemon state. The pairing/client sections reuse the legacy host
 * state shapes verbatim (push targets and live-activity registrations stay
 * embedded in each client, as `src/core/remote/iroh/push.ts` expects). The Iroh
 * identity survives migration; pre-grant client authority is intentionally not imported.
 */
export interface VoltdStateFileV1 {
	version: 1;
	/** Iroh secret key bytes; MUST survive migration so the saved host identity remains stable. */
	irohSecretKey?: number[];
	clients: IrohRemoteClient[];
	revokedClients: IrohRemoteRevokedClient[];
	workspaceGenerationCounter: NonNullable<IrohRemoteHostState["workspaceGenerationCounter"]>;
	workspaceGenerations: NonNullable<IrohRemoteHostState["workspaceGenerations"]>;
	workspaces: IrohRemoteWorkspace[];
	worktrees: IrohRemoteWorkspaceWorktree[];
	pendingPairingTickets: IrohRemotePendingPairingTicket[];
	pairingSecretTombstones: IrohRemotePairingSecretTombstone[];
	settings: {
		/** Detached headless runtime retention TTL. */
		detachedRuntimeTtlMs: number;
		/** Tool allowlist applied ONLY to daemon-owned headless runtimes. */
		allowTools: string[] | null;
		/** Active daemon theme (theme_set); undefined falls back to the default theme. */
		themeName?: string;
		/** Push sanitized resolved theme tokens to capable phones (§9.5); OFF by default. */
		themeTokenPush?: boolean;
		/** Hold a keep-awake (prevent system sleep) assertion while the daemon runs; OFF by default. */
		keepAwakeEnabled?: boolean;
		/**
		 * Bearer token presented to relay servers (access.shared_token). Seeded
		 * from VOLT_IROH_RELAY_AUTH_TOKEN and persisted so bare restarts keep
		 * authenticating; pairing tickets carry it to phones.
		 */
		relayAuthToken?: string;
		/** Worktree cleanup policies (design §5.3); all opt-in except pruneOnStart. */
		worktreeCleanup?: WorktreeCleanupSettings;
	};
}

export interface WorktreeCleanupSettings {
	/** Remove clean, fully merged worktrees after the TTL once their runtime is disposed. */
	retention?: { enabled: boolean; ttlMs: number };
	/** Reconcile worktree records/checkouts during daemon startup (default true). */
	pruneOnStart?: boolean;
}

export interface ResolvedWorktreeCleanupPolicy {
	retention: { enabled: boolean; ttlMs: number } | undefined;
	pruneOnStart: boolean;
}

/** Apply worktree-cleanup defaults: retention off, pruneOnStart on. */
export function resolveWorktreeCleanupPolicy(
	settings: Pick<VoltdStateFileV1["settings"], "worktreeCleanup">,
): ResolvedWorktreeCleanupPolicy {
	const cleanup = settings.worktreeCleanup;
	const retention =
		cleanup?.retention?.enabled && cleanup.retention.ttlMs > 0
			? { enabled: true, ttlMs: cleanup.retention.ttlMs }
			: undefined;
	return { retention, pruneOnStart: cleanup?.pruneOnStart !== false };
}

function parseWorktreeCleanupSettings(value: unknown): WorktreeCleanupSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const retentionRecord =
		typeof record.retention === "object" && record.retention !== null && !Array.isArray(record.retention)
			? (record.retention as Record<string, unknown>)
			: undefined;
	const retention =
		retentionRecord !== undefined &&
		typeof retentionRecord.enabled === "boolean" &&
		typeof retentionRecord.ttlMs === "number" &&
		Number.isInteger(retentionRecord.ttlMs) &&
		retentionRecord.ttlMs > 0
			? { enabled: retentionRecord.enabled, ttlMs: retentionRecord.ttlMs }
			: undefined;
	const pruneOnStart = typeof record.pruneOnStart === "boolean" ? record.pruneOnStart : undefined;
	if (retention === undefined && pruneOnStart === undefined) {
		return undefined;
	}
	return {
		...(retention === undefined ? {} : { retention }),
		...(pruneOnStart === undefined ? {} : { pruneOnStart }),
	};
}

export function createEmptyVoltdState(): VoltdStateFileV1 {
	return {
		version: 1,
		irohSecretKey: undefined,
		clients: [],
		revokedClients: [],
		workspaceGenerationCounter: 0,
		workspaceGenerations: [],
		workspaces: [],
		worktrees: [],
		pendingPairingTickets: [],
		pairingSecretTombstones: [],
		settings: {
			detachedRuntimeTtlMs: DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS,
			allowTools: null,
		},
	};
}

export function voltdStateToHostState(state: VoltdStateFileV1): IrohRemoteHostState {
	return {
		hostSecretKey: state.irohSecretKey,
		clients: state.clients,
		revokedClients: state.revokedClients,
		workspaceGenerationCounter: state.workspaceGenerationCounter,
		workspaceGenerations: state.workspaceGenerations,
		workspaces: state.workspaces,
		worktrees: state.worktrees,
		pendingPairingTickets: state.pendingPairingTickets,
		pairingSecretTombstones: state.pairingSecretTombstones,
	};
}

export function hostStateToVoltdState(
	hostState: IrohRemoteHostState,
	settings: VoltdStateFileV1["settings"],
): VoltdStateFileV1 {
	return {
		version: 1,
		irohSecretKey: hostState.hostSecretKey,
		clients: hostState.clients,
		revokedClients: hostState.revokedClients ?? [],
		workspaceGenerationCounter: hostState.workspaceGenerationCounter ?? 0,
		workspaceGenerations: hostState.workspaceGenerations ?? [],
		workspaces: hostState.workspaces,
		worktrees: hostState.worktrees ?? [],
		pendingPairingTickets: hostState.pendingPairingTickets ?? [],
		pairingSecretTombstones: hostState.pairingSecretTombstones ?? [],
		settings,
	};
}

export function parseVoltdState(value: unknown): VoltdStateFileV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("voltd state must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error(`unsupported voltd state version: ${String(record.version)}`);
	}
	const hostState = parseIrohRemoteHostState({
		...record,
		hostSecretKey: record.irohSecretKey,
	});
	const settings = typeof record.settings === "object" && record.settings !== null ? record.settings : {};
	const settingsRecord = settings as Record<string, unknown>;
	const detachedRuntimeTtlMs =
		typeof settingsRecord.detachedRuntimeTtlMs === "number" &&
		Number.isInteger(settingsRecord.detachedRuntimeTtlMs) &&
		settingsRecord.detachedRuntimeTtlMs > 0
			? settingsRecord.detachedRuntimeTtlMs
			: DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS;
	const allowTools = Array.isArray(settingsRecord.allowTools)
		? settingsRecord.allowTools.filter((tool): tool is string => typeof tool === "string")
		: null;
	const themeName = typeof settingsRecord.themeName === "string" ? settingsRecord.themeName : undefined;
	const themeTokenPush = settingsRecord.themeTokenPush === true;
	const keepAwakeEnabled = settingsRecord.keepAwakeEnabled === true;
	const relayAuthToken =
		typeof settingsRecord.relayAuthToken === "string" && settingsRecord.relayAuthToken.length > 0
			? settingsRecord.relayAuthToken
			: undefined;
	const worktreeCleanup = parseWorktreeCleanupSettings(settingsRecord.worktreeCleanup);
	return hostStateToVoltdState(hostState, {
		detachedRuntimeTtlMs,
		allowTools,
		...(themeName === undefined ? {} : { themeName }),
		...(themeTokenPush ? { themeTokenPush } : {}),
		...(keepAwakeEnabled ? { keepAwakeEnabled } : {}),
		...(relayAuthToken === undefined ? {} : { relayAuthToken }),
		...(worktreeCleanup === undefined ? {} : { worktreeCleanup }),
	});
}

export function getLegacyRemoteStatePath(agentDir: string): string {
	return join(agentDir, "remote", "iroh-host.json");
}

export interface LegacyRemoteStateMigration {
	state: VoltdStateFileV1;
	droppedAccess: {
		clients: number;
		revokedClients: number;
		pendingPairingTickets: number;
	};
}

/**
 * One-time migration from remote/iroh-host.json. A pre-grant file keeps the
 * Iroh identity plus validated workspace/worktree metadata, but deliberately
 * drops every old authority-bearing record. Those clients must pair again
 * under an explicit RPC grant; expected pre-grant migration is not corruption.
 */
export function migrateLegacyRemoteState(agentDir: string, statePath: string): LegacyRemoteStateMigration | null {
	if (existsSync(statePath)) {
		return null;
	}
	const legacyPath = getLegacyRemoteStatePath(agentDir);
	if (!existsSync(legacyPath)) {
		return null;
	}
	const parsedJson: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
	let legacyState: IrohRemoteHostState;
	let droppedAccess = { clients: 0, revokedClients: 0, pendingPairingTickets: 0 };
	try {
		legacyState = parseIrohRemoteHostState(parsedJson);
	} catch (error) {
		if (!isPreGrantLegacyHostState(parsedJson)) {
			throw error;
		}
		const record = parsedJson as Record<string, unknown>;
		droppedAccess = {
			clients: Array.isArray(record.clients) ? record.clients.length : 0,
			revokedClients: Array.isArray(record.revokedClients) ? record.revokedClients.length : 0,
			pendingPairingTickets: Array.isArray(record.pendingPairingTickets) ? record.pendingPairingTickets.length : 0,
		};
		legacyState = parseIrohRemoteHostState({
			...record,
			clients: [],
			revokedClients: [],
			pendingPairingTickets: [],
		});
	}
	return {
		state: hostStateToVoltdState(legacyState, createEmptyVoltdState().settings),
		droppedAccess,
	};
}

function isPreGrantLegacyHostState(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	for (const field of ["clients", "revokedClients", "pendingPairingTickets"] as const) {
		const entries = record[field];
		if (!Array.isArray(entries)) {
			continue;
		}
		if (
			entries.some(
				(entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && !("rpcGrant" in entry),
			)
		) {
			return true;
		}
	}
	return false;
}

export interface VoltdStateStoreOptions {
	agentDir: string;
	statePath: string;
	/** Debounce for coalescing writes; flushes synchronously on close(). */
	debounceMs?: number;
	/** Durable writer seam for deterministic persistence-concurrency tests. */
	writeStateFile?: (path: string, content: string) => Promise<void>;
}

export interface LoadVoltdStateResult {
	state: VoltdStateFileV1;
	migratedFromLegacyState: boolean;
	legacyDroppedAccess?: LegacyRemoteStateMigration["droppedAccess"];
}

const DEFAULT_STATE_DEBOUNCE_MS = 250;

export interface InvalidVoltdStateFile {
	path: string;
	error: string;
}

function stateFileErrorMessage(path: string, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Daemon state file ${path} is invalid or incompatible: ${reason}`;
}

function invalidStateFileError(path: string, error: unknown): Error {
	return new Error(
		`${stateFileErrorMessage(path, error)}. Confirm regeneration from /remote or run ` +
			"`volt daemon regenerate-state`; existing phones will need to pair again.",
	);
}

/** Inspect persisted daemon state without modifying or migrating it. */
export function inspectVoltdStateFiles(agentDir: string): InvalidVoltdStateFile | undefined {
	const statePath = join(agentDir, "daemon", "state.json");
	if (existsSync(statePath)) {
		try {
			parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
			return undefined;
		} catch (error) {
			return { path: statePath, error: stateFileErrorMessage(statePath, error) };
		}
	}
	const legacyPath = getLegacyRemoteStatePath(agentDir);
	if (!existsSync(legacyPath)) {
		return undefined;
	}
	try {
		migrateLegacyRemoteState(agentDir, statePath);
		return undefined;
	} catch (error) {
		return { path: legacyPath, error: stateFileErrorMessage(legacyPath, error) };
	}
}

function regeneratePreGrantVoltdState(value: unknown): VoltdStateFileV1 | undefined {
	if (!isPreGrantLegacyHostState(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	try {
		return parseVoltdState({
			...record,
			clients: [],
			revokedClients: [],
			pendingPairingTickets: [],
		});
	} catch {
		return undefined;
	}
}

function readRecoverableVoltdState(path: string): VoltdStateFileV1 | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		try {
			return parseVoltdState(value);
		} catch {
			return regeneratePreGrantVoltdState(value);
		}
	} catch {
		return undefined;
	}
}

export interface RecoverableVoltdStateBackup {
	path: string;
	preservedIdentity: boolean;
}

/** Find the newest validated daemon-state backup that can be safely regenerated. */
export function findRecoverableVoltdStateBackup(agentDir: string): RecoverableVoltdStateBackup | undefined {
	const daemonDir = join(agentDir, "daemon");
	if (!existsSync(daemonDir)) {
		return undefined;
	}
	const candidates = readdirSync(daemonDir)
		.filter((name) => /^state\.json\.(?:corrupt|invalid)-\d+$/.test(name))
		.map((name) => {
			const path = join(daemonDir, name);
			return { path, modifiedAtMs: statSync(path).mtimeMs, state: readRecoverableVoltdState(path) };
		})
		.filter((candidate): candidate is typeof candidate & { state: VoltdStateFileV1 } => candidate.state !== undefined)
		.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
	const candidate = candidates[0];
	return candidate
		? { path: candidate.path, preservedIdentity: candidate.state.irohSecretKey !== undefined }
		: undefined;
}

/** Replace current state from a validated backup, preserving the source and backing up the current file. */
export async function recoverVoltdStateFromBackup(
	agentDir: string,
	backupPath: string,
): Promise<{ previousStateBackupPath?: string; preservedIdentity: boolean }> {
	const candidate = findRecoverableVoltdStateBackup(agentDir);
	if (!candidate || candidate.path !== backupPath) {
		throw new Error("The selected daemon-state recovery backup is no longer available.");
	}
	const recovered = readRecoverableVoltdState(backupPath);
	if (!recovered) {
		throw new Error("The selected daemon-state backup is no longer recoverable.");
	}
	const statePath = join(agentDir, "daemon", "state.json");
	let previousStateBackupPath: string | undefined;
	if (existsSync(statePath)) {
		previousStateBackupPath = `${statePath}.invalid-${Date.now()}`;
		await rename(statePath, previousStateBackupPath);
	}
	await writeDurableAtomicFile(statePath, `${JSON.stringify(recovered, null, 2)}\n`);
	return {
		...(previousStateBackupPath === undefined ? {} : { previousStateBackupPath }),
		preservedIdentity: recovered.irohSecretKey !== undefined,
	};
}

/** Back up invalid state and regenerate validated non-authority data when possible. */
export async function regenerateInvalidVoltdState(
	agentDir: string,
): Promise<{ backupPath: string; preservedIdentity: boolean }> {
	const invalid = inspectVoltdStateFiles(agentDir);
	if (!invalid) {
		throw new Error("Daemon state is valid; regeneration is not needed.");
	}
	let regenerated: VoltdStateFileV1 | undefined;
	if (invalid.path === join(agentDir, "daemon", "state.json")) {
		try {
			regenerated = regeneratePreGrantVoltdState(JSON.parse(readFileSync(invalid.path, "utf8")));
		} catch {
			// Malformed JSON cannot be partially recovered. The original is still backed up below.
		}
	}
	const backupPath = `${invalid.path}.invalid-${Date.now()}`;
	await rename(invalid.path, backupPath);
	if (regenerated) {
		await writeDurableAtomicFile(invalid.path, `${JSON.stringify(regenerated, null, 2)}\n`);
	}
	return { backupPath, preservedIdentity: regenerated?.irohSecretKey !== undefined };
}

/** Debounced, atomic (tmp + rename, 0600) persistence for VoltdStateFileV1. */
export class VoltdStateStore {
	private readonly statePath: string;
	private readonly agentDir: string;
	private readonly debounceMs: number;
	private readonly writeStateFile: (path: string, content: string) => Promise<void>;
	private current: VoltdStateFileV1 | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private pendingFlush: Promise<void> = Promise.resolve();
	private stateRevision = 0;
	private persistedRevision = 0;
	private migrated = false;
	private legacyDroppedAccess: LegacyRemoteStateMigration["droppedAccess"] | undefined;

	constructor(options: VoltdStateStoreOptions) {
		this.statePath = options.statePath;
		this.agentDir = options.agentDir;
		this.debounceMs = options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
		this.writeStateFile = options.writeStateFile ?? writeDurableAtomicFile;
	}

	async load(): Promise<LoadVoltdStateResult> {
		if (this.current) {
			return {
				state: this.current,
				migratedFromLegacyState: this.migrated,
				...(this.legacyDroppedAccess === undefined ? {} : { legacyDroppedAccess: this.legacyDroppedAccess }),
			};
		}
		let migration: LegacyRemoteStateMigration | null;
		try {
			migration = migrateLegacyRemoteState(this.agentDir, this.statePath);
		} catch (error) {
			throw invalidStateFileError(getLegacyRemoteStatePath(this.agentDir), error);
		}
		if (migration) {
			this.current = migration.state;
			this.markStateChanged();
			this.migrated = true;
			this.legacyDroppedAccess = migration.droppedAccess;
			await this.enqueueWrite();
			const legacyPath = getLegacyRemoteStatePath(this.agentDir);
			try {
				await rename(legacyPath, `${legacyPath}.migrated`);
			} catch (error) {
				// A daemon started concurrently (before the single-instance socket bind)
				// may have already migrated and renamed the legacy file. Its absence is
				// benign: the migrated content is identical and already persisted, so a
				// racing start must not crash here — it will fail cleanly at the socket
				// bind instead.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			return {
				state: this.current,
				migratedFromLegacyState: true,
				legacyDroppedAccess: migration.droppedAccess,
			};
		}
		if (existsSync(this.statePath)) {
			try {
				this.current = parseVoltdState(JSON.parse(readFileSync(this.statePath, "utf8")));
			} catch (error) {
				throw invalidStateFileError(this.statePath, error);
			}
		} else {
			this.current = createEmptyVoltdState();
			this.markStateChanged();
			await this.enqueueWrite();
		}
		return { state: this.current, migratedFromLegacyState: false };
	}

	get state(): VoltdStateFileV1 {
		if (!this.current) {
			throw new Error("voltd state not loaded");
		}
		return this.current;
	}

	/** Replace the host-state portion (used as the state-manager write hook). */
	setHostState(hostState: IrohRemoteHostState): void {
		this.current = hostStateToVoltdState(hostState, this.state.settings);
		this.scheduleFlush();
	}

	getHostState(): IrohRemoteHostState {
		return this.current ? voltdStateToHostState(this.current) : createEmptyIrohRemoteHostState();
	}

	updateSettings(settings: Partial<VoltdStateFileV1["settings"]>): void {
		this.current = { ...this.state, settings: { ...this.state.settings, ...settings } };
		this.scheduleFlush();
	}

	scheduleFlush(): void {
		this.markStateChanged();
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.enqueueWrite().catch(() => {});
		}, this.debounceMs);
		this.flushTimer.unref?.();
	}

	/**
	 * Force an immediate durable write, cancelling any pending debounce. Use after
	 * minting state that must survive a crash the moment it exists (e.g. the freshly
	 * generated Iroh identity, before the endpoint starts accepting pairings).
	 */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.current) {
			// Force an explicit current-snapshot revision. Besides preserving flush's
			// historical semantics, this catches callers that deliberately mutate the
			// loaded state object before requesting durability.
			this.markStateChanged();
			await this.enqueueWrite();
		} else {
			await this.pendingFlush;
		}
	}

	/** Flush pending changes and stop the debounce timer (graceful shutdown). */
	async close(): Promise<void> {
		await this.flush();
	}

	private markStateChanged(): void {
		this.stateRevision++;
	}

	private enqueueWrite(): Promise<void> {
		const write = this.pendingFlush.then(() => this.writeNow());
		this.pendingFlush = write.catch(() => {});
		return write;
	}

	/** Must only be invoked through enqueueWrite so atomic renames cannot overtake one another. */
	private async writeNow(): Promise<void> {
		if (!this.current || this.persistedRevision >= this.stateRevision) {
			return;
		}
		const revision = this.stateRevision;
		const content = `${JSON.stringify(this.current, null, 2)}\n`;
		await this.writeStateFile(this.statePath, content);
		this.persistedRevision = Math.max(this.persistedRevision, revision);
	}
}
