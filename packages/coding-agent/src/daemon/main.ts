import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { getAgentDir, VERSION } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	parseIrohRemoteRpcCapabilities,
	parseIrohRemoteRpcGrant,
} from "../core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import { normalizeIrohRemoteAllowTools, parseIrohRemoteAllowTools } from "../core/remote/iroh/protocol.ts";
import { IrohRemotePushRelayHttpClient, revokeIrohRemoteClientPushTargets } from "../core/remote/iroh/push.ts";
import {
	IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
	IrohRemoteHostStateManager,
	isIrohRemoteWorkspaceHasWorktreesError,
} from "../core/remote/iroh/state-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	getCurrentThemeName,
	getResolvedThemeColors,
	getThemeByName,
	initTheme,
	onThemeChange,
	setTheme,
} from "../core/theme/runtime.ts";
import { BRAVE_SEARCH_AUTH_PROVIDER } from "../core/tools/web-search.ts";
import type {
	ControlClientStatus,
	ControlLeaseStatus,
	ControlRequest,
	ControlRevokedClientStatus,
	ControlWorkspaceStatus,
} from "./control-protocol.ts";
import { CONTROL_PAIR_CANCEL_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY, PROTOCOL_VERSION } from "./control-protocol.ts";
import {
	type ControlConnection,
	type ControlServer,
	probeControlSocket,
	startControlServer,
} from "./control-server.ts";
import {
	acquireDaemonLock,
	DAEMON_LOCK_START_TIME_TOLERANCE_MS,
	type DaemonLock,
	type DaemonLockOwner,
} from "./daemon-lock.ts";
import { KeepAwakeController, type KeepAwakeControllerOptions } from "./keep-awake.ts";
import type { DaemonLogger } from "./log.ts";
import { createDaemonLogger } from "./log.ts";
import {
	createDaemonControlSocketPath,
	type DaemonPaths,
	ensureDaemonDirs,
	getDaemonPaths,
	isWindowsNamedPipePath,
} from "./paths.ts";
import { verifyPidfileProcess, verifyVoltdProcessIdentity } from "./process-identity.ts";
import { VoltdStateStore } from "./state.ts";
import { handleWorktreeControlRequest, isWorktreeControlRequest, WorktreeManager } from "./worktree-manager.ts";

export interface Clock {
	now(): number;
}

export interface VoltdConfig {
	agentDir?: string;
	socketPath?: string;
	logPath?: string;
	foreground: boolean;
	clock?: Clock;
	/** Keep-awake controller overrides (tests inject a fake spawn here). */
	keepAwake?: KeepAwakeControllerOptions;
	/** Maximum time native extension disposal may delay process teardown. */
	extensionDisposeTimeoutMs?: number;
	/** Process lifecycle override for deterministic signal tests. */
	processLifecycle?: VoltdProcessLifecycle;
}

export interface VoltdProcessLifecycle {
	addShutdownSignalHandler(handler: () => void): void;
	removeShutdownSignalHandler(handler: () => void): void;
	forceExit(code: number): void;
}

export interface PidfileContents {
	pid: number;
	version: string;
	startedAtMs: number;
	socketPath: string;
	/** Per-daemon instance token; optional for pidfiles written by older versions. */
	token?: string;
}

export function readPidfile(pidfilePath: string): PidfileContents | undefined {
	try {
		const parsed = JSON.parse(readFileSync(pidfilePath, "utf8")) as Partial<PidfileContents>;
		if (typeof parsed.pid !== "number" || typeof parsed.socketPath !== "string") {
			return undefined;
		}
		return {
			pid: parsed.pid,
			version: typeof parsed.version === "string" ? parsed.version : "unknown",
			startedAtMs: typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : 0,
			socketPath: parsed.socketPath,
			...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
		};
	} catch {
		return undefined;
	}
}

export const VOLTD_EXIT_ALREADY_RUNNING = 3;
export const VOLTD_EXIT_BIND_FAILED = 4;
export const VOLTD_EXIT_INCOMPATIBLE_RUNNING = 5;

const DAEMON_BIND_WAIT_TIMEOUT_MS = 75_000;
const DAEMON_BIND_WAIT_POLL_MS = 200;
export const VOLTD_EXTENSION_DISPOSE_TIMEOUT_MS = 5_000;

const defaultProcessLifecycle: VoltdProcessLifecycle = {
	addShutdownSignalHandler(handler) {
		process.on("SIGTERM", handler);
		process.on("SIGINT", handler);
	},
	removeShutdownSignalHandler(handler) {
		process.off("SIGTERM", handler);
		process.off("SIGINT", handler);
	},
	forceExit(code) {
		process.exit(code);
	},
};

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Facilities later milestones build on (lease broker, Iroh host, theme service). */
export interface VoltdRuntimeServices {
	agentDir: string;
	paths: DaemonPaths;
	logger: DaemonLogger;
	state: VoltdStateStore;
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	controlServer: ControlServer;
	keepAwake: KeepAwakeController;
	/** Stored Brave Search API key for the web_search tool, persisted in auth.json. */
	webSearchKey: { set(apiKey: string | null): void; readonly configured: boolean };
	requestShutdown(reason: "cli" | "signal"): void;
}

export interface VoltdExtensionQuiesceContext {
	reason: "cli" | "signal";
}

export interface VoltdExtensionDisposeContext extends VoltdExtensionQuiesceContext {
	/** Aborted when the daemon-owned disposal deadline expires. */
	signal: AbortSignal;
	deadlineAtMs: number;
}

export interface VoltdServiceExtensionInstance {
	/** Extra request handling; return true when the request was handled. */
	handleRequest?(connection: ControlConnection, request: ControlRequest): Promise<boolean> | boolean;
	onConnectionClosed?(connection: ControlConnection): void;
	/** The daemon's active theme changed (theme_set or an extension setTheme). */
	onThemeChanged?(): void;
	/** Keep-awake status changed (control toggle, phone RPC toggle, or degradation). */
	onKeepAwakeChanged?(): void;
	statusExtras?(): { leases?: ControlLeaseStatus[]; phoneConnections?: number; relayCount?: number };
	/** Redeem a relay hello token; true when the socket was taken over. */
	admitRelay?(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer): boolean;
	/** Stop admitting work, settle durable ownership, and flush extension state. */
	quiesce?(context: VoltdExtensionQuiesceContext): Promise<void>;
	/** Release native/process resources after durable daemon state is closed. */
	dispose?(context: VoltdExtensionDisposeContext): Promise<void>;
}

export type VoltdServiceExtension = (services: VoltdRuntimeServices) => VoltdServiceExtensionInstance;

export async function runVoltDaemon(config: VoltdConfig, extensions: VoltdServiceExtension[] = []): Promise<number> {
	process.title = "voltd";
	const agentDir = config.agentDir ?? getAgentDir();
	const usingDefaultSocketPath = config.socketPath === undefined;
	let selectedSocketPath = config.socketPath;
	const resolvePaths = (): DaemonPaths => {
		const basePaths = getDaemonPaths(agentDir);
		return {
			...basePaths,
			socketPath: selectedSocketPath ?? basePaths.socketPath,
			logPath: config.logPath ?? basePaths.logPath,
		};
	};
	let paths: DaemonPaths = resolvePaths();
	ensureDaemonDirs(paths);
	const logger = createDaemonLogger({
		logPath: paths.logPath,
		echoToStderr: config.foreground && process.stderr.isTTY,
	});
	const log = logger.child("daemon");
	const clock: Clock = config.clock ?? { now: () => Date.now() };
	const startedAtMs = clock.now();
	const pidfileToken = randomUUID();
	let daemonLock: DaemonLock | undefined;
	const releaseDaemonLock = () => {
		daemonLock?.release();
		daemonLock = undefined;
	};
	const finishBeforeServing = (code: number): number => {
		releaseDaemonLock();
		return code;
	};
	const verifyLockOwner = async (owner: DaemonLockOwner) => {
		const pidfile = readPidfile(paths.pidfilePath);
		if (pidfile?.pid === owner.pid) {
			const socketProbe = await probeControlSocket(pidfile.socketPath, {
				version: VERSION,
				timeoutMs: 500,
				...(pidfile.token === undefined ? {} : { authToken: pidfile.token }),
			});
			if (socketProbe.kind === "healthy" && socketProbe.status.pid === owner.pid) {
				return "match" as const;
			}
			if (socketProbe.kind === "live-rejected" || socketProbe.kind === "unresponsive") {
				return "unknown" as const;
			}
		}
		return verifyVoltdProcessIdentity(owner, { toleranceMs: DAEMON_LOCK_START_TIME_TOLERANCE_MS });
	};
	const lockResult = await acquireDaemonLock(paths.lockDirPath, { verifyOwner: verifyLockOwner });
	if (!lockResult.ok) {
		const pidfile = readPidfile(paths.pidfilePath);
		if (pidfile) {
			const socketProbe = await probeControlSocket(pidfile.socketPath, {
				version: VERSION,
				timeoutMs: 500,
				...(pidfile.token === undefined ? {} : { authToken: pidfile.token }),
			});
			if (socketProbe.kind === "healthy") {
				log("info", `another daemon is healthy (pid ${socketProbe.status.pid}); exiting`);
				return VOLTD_EXIT_ALREADY_RUNNING;
			}
			if (socketProbe.kind === "live-rejected" && socketProbe.reason === "protocol_mismatch") {
				log(
					"error",
					`another daemon is running with protocol ${socketProbe.protocolVersion ?? "unknown"}; not starting`,
				);
				return VOLTD_EXIT_INCOMPATIBLE_RUNNING;
			}
		}
		const owner = lockResult.owner ? ` by pid ${lockResult.owner.pid}` : "";
		log("error", `daemon startup lock is held${owner}; not starting a second daemon`);
		return VOLTD_EXIT_BIND_FAILED;
	}
	daemonLock = lockResult.lock;
	if (usingDefaultSocketPath && process.platform === "win32") {
		selectedSocketPath = createDaemonControlSocketPath(agentDir);
		paths = resolvePaths();
		ensureDaemonDirs(paths);
	}

	const state = new VoltdStateStore({ agentDir, statePath: paths.statePath });
	let migratedFromLegacyState = false;
	let legacyDroppedAccess: { clients: number; revokedClients: number; pendingPairingTickets: number } | undefined;
	try {
		const loadResult = await state.load();
		migratedFromLegacyState = loadResult.migratedFromLegacyState;
		legacyDroppedAccess = loadResult.legacyDroppedAccess;
		if (
			legacyDroppedAccess !== undefined &&
			legacyDroppedAccess.clients + legacyDroppedAccess.revokedClients + legacyDroppedAccess.pendingPairingTickets >
				0
		) {
			log(
				"warn",
				"migrated pre-grant Iroh host state: preserved host identity and workspace metadata, " +
					"dropped legacy clients, revocations, and pending tickets; all clients must pair again",
				legacyDroppedAccess,
			);
		}
	} catch (error) {
		log("error", `failed to load state: ${error instanceof Error ? error.message : String(error)}`);
		return finishBeforeServing(1);
	}

	// Global settings are the source of truth for daemon runtime policy. Project
	// settings are deliberately excluded: registering a workspace must never
	// widen or silently replace a paired client's workstation-level ceiling.
	const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	const globalSettingsErrors = settingsManager.drainErrors().filter((error) => error.scope === "global");
	if (globalSettingsErrors.length > 0) {
		log("error", `failed to load global settings: ${globalSettingsErrors[0]?.error.message ?? "unknown error"}`);
		return finishBeforeServing(1);
	}
	const remoteSettings = settingsManager.getRemoteSettings() as Record<string, unknown>;
	const configuredAllowTools = remoteSettings.allowTools;
	if (
		configuredAllowTools !== undefined &&
		(!Array.isArray(configuredAllowTools) || configuredAllowTools.some((tool) => typeof tool !== "string"))
	) {
		log("error", "invalid remote.allowTools setting: expected an array of tool names");
		return finishBeforeServing(1);
	}
	const allowTools =
		configuredAllowTools === undefined
			? null
			: Array.from(
					new Set((configuredAllowTools as string[]).map((tool) => tool.trim()).filter((tool) => tool.length > 0)),
				);
	state.updateSettings({ allowTools });
	try {
		await state.flush();
	} catch (error) {
		log("error", `failed to persist remote policy: ${error instanceof Error ? error.message : String(error)}`);
		return finishBeforeServing(1);
	}

	// The daemon's theme instance: persisted name from voltd state, no hot-reload
	// watcher (that is the rendering TUI's job).
	initTheme(state.state.settings.themeName, false);
	const stateManager = new IrohRemoteHostStateManager({
		store: {
			read: () => state.getHostState(),
			write: async (hostState) => {
				state.setHostState(hostState);
				// State-manager mutations are security-sensitive: callers must not
				// expose tickets or acknowledge pairing/revocation before durability.
				await state.flush();
			},
		},
	});
	const auditLogger = new IrohRemoteAuditLogger({ path: paths.auditPath });
	const fallbackPushRelayClient = new IrohRemotePushRelayHttpClient({
		authToken: process.env.VOLT_PUSH_RELAY_AUTH_TOKEN,
		baseUrl: process.env.VOLT_PUSH_RELAY_URL,
	});

	let shutdownPhase: "running" | "quiescing" | "disposing" | "complete" = "running";
	let resolveExit: ((code: number) => void) | undefined;
	const removeOwnedPidfile = () => {
		const current = readPidfile(paths.pidfilePath);
		if (!current) {
			return;
		}
		const owned = current.token === pidfileToken || (current.token === undefined && current.pid === process.pid);
		if (owned) {
			rmSync(paths.pidfilePath, { force: true });
		}
	};
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	const extensionInstances: VoltdServiceExtensionInstance[] = [];
	let controlServer: ControlServer | undefined;

	const keepAwake = new KeepAwakeController({
		...config.keepAwake,
		log: (level, message) => logger.log(level, "keep-awake", message),
		onStatusChanged: (status) => {
			config.keepAwake?.onStatusChanged?.(status);
			controlServer?.broadcast({ type: "keep_awake_changed", keepAwake: status });
			for (const extension of extensionInstances) {
				extension.onKeepAwakeChanged?.();
			}
		},
	});

	// Brave Search key storage for phone RPC: persisted in auth.json (never in
	// daemon state.json) so the web_search tool's fallback sees it.
	let webSearchAuthStorage: AuthStorage | undefined;
	const getWebSearchAuthStorage = (): AuthStorage => {
		webSearchAuthStorage ??= AuthStorage.create(join(agentDir, "auth.json"));
		return webSearchAuthStorage;
	};
	const webSearchKey: VoltdRuntimeServices["webSearchKey"] = {
		set(apiKey: string | null): void {
			const authStorage = getWebSearchAuthStorage();
			if (apiKey === null) {
				authStorage.remove(BRAVE_SEARCH_AUTH_PROVIDER);
			} else {
				authStorage.set(BRAVE_SEARCH_AUTH_PROVIDER, { type: "api_key", key: apiKey });
			}
		},
		get configured(): boolean {
			const authStorage = getWebSearchAuthStorage();
			// Other processes may write auth.json; re-read before reporting.
			authStorage.reload();
			const cred = authStorage.get(BRAVE_SEARCH_AUTH_PROVIDER);
			return cred?.type === "api_key" && cred.key.trim().length > 0;
		},
	};

	const shutdown = async (reason: "cli" | "signal") => {
		if (shutdownPhase !== "running") {
			return;
		}
		shutdownPhase = "quiescing";
		log("info", `shutting down (${reason})`);
		// Tell control clients up front: extension quiescing can drain streaming
		// runtimes for up to 60s and clients must not wait blind. New hellos are
		// already rejected via the shutdown admission gate.
		controlServer?.broadcast({ type: "daemon_shutdown" });
		// Close control request admission synchronously, then let the initiating
		// shutdown handler return its ok and drain with every request admitted before
		// the cut. No extension or durable state can quiesce underneath those tasks.
		await controlServer?.quiesce();
		let shutdownFailed = false;
		for (const [index, extension] of extensionInstances.entries()) {
			try {
				await extension.quiesce?.({ reason });
			} catch (error) {
				shutdownFailed = true;
				log(
					"error",
					`extension ${index + 1} quiesce failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		await keepAwake.shutdown().catch(() => {});
		await state.close().catch(() => {});

		shutdownPhase = "disposing";
		const disposeTimeoutMs = config.extensionDisposeTimeoutMs ?? VOLTD_EXTENSION_DISPOSE_TIMEOUT_MS;
		const disposeAbortController = new AbortController();
		const disposeContext: VoltdExtensionDisposeContext = {
			reason,
			signal: disposeAbortController.signal,
			deadlineAtMs: Date.now() + disposeTimeoutMs,
		};
		const extensionDisposal = Promise.all(
			extensionInstances.map(async (extension, index) => {
				try {
					await extension.dispose?.(disposeContext);
				} catch (error) {
					shutdownFailed = true;
					log(
						"error",
						`extension ${index + 1} dispose failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
		let disposeTimer: NodeJS.Timeout | undefined;
		const disposeOutcome = await Promise.race([
			extensionDisposal.then(() => "settled" as const),
			new Promise<"timed_out">((resolve) => {
				disposeTimer = setTimeout(() => resolve("timed_out"), disposeTimeoutMs);
			}),
		]);
		clearTimeout(disposeTimer);
		const extensionDisposalTimedOut = disposeOutcome === "timed_out";
		if (extensionDisposalTimedOut) {
			shutdownFailed = true;
			disposeAbortController.abort(new Error("daemon extension disposal deadline exceeded"));
			log("error", `extension dispose deadline exceeded after ${disposeTimeoutMs}ms; forcing process teardown`);
			// The aggregate observes every late rejection. The foreground daemon exits
			// immediately after runVoltDaemon resolves, terminating stuck native work.
			void extensionDisposal;
		}
		await auditLogger
			.log({
				type: "daemon_shutdown",
				success: !shutdownFailed,
				details: { reason, extensionDisposalTimedOut },
			})
			.catch(() => {});
		await controlServer?.close().catch(() => {});
		removeOwnedPidfile();
		releaseDaemonLock();
		shutdownPhase = "complete";
		log("info", "shutdown complete");
		resolveExit?.(0);
	};

	const requestShutdown = (reason: "cli" | "signal") => {
		void shutdown(reason);
	};

	const toClientStatuses = (): ControlClientStatus[] =>
		state.state.clients.map((client) => ({
			clientNodeId: client.nodeId,
			...(client.label === undefined ? {} : { label: client.label }),
			pairedAtMs: client.pairedAt ?? 0,
			lastSeenAtMs: client.lastSeenAt ?? 0,
			allowedTools: parseIrohRemoteAllowTools(client.allowedTools),
			usesDefaultTools: client.allowedTools === undefined,
			rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant"),
		}));
	const toRevokedClientStatuses = (): ControlRevokedClientStatus[] =>
		state.state.revokedClients.map((client) => ({
			clientNodeId: client.nodeId,
			...(client.label === undefined ? {} : { label: client.label }),
			pairedAtMs: client.pairedAt ?? 0,
			lastSeenAtMs: client.lastSeenAt ?? 0,
			revokedAtMs: client.revokedAt,
			rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "revoked client rpcGrant"),
			...(client.rePairApprovedAt === undefined ? {} : { rePairApprovedAtMs: client.rePairApprovedAt }),
		}));

	// Worktree control fallback (no iroh extension running / request not handled
	// there): records via the shared state manager, no runtime awareness.
	let fallbackWorktreeManager: WorktreeManager | undefined;
	const getFallbackWorktreeManager = (): WorktreeManager => {
		fallbackWorktreeManager ??= new WorktreeManager({
			agentDir,
			stateManager,
			auditLogger,
			flushState: () => state.flush(),
		});
		return fallbackWorktreeManager;
	};

	const handleRequest = async (connection: ControlConnection, request: ControlRequest): Promise<void> => {
		for (const extension of extensionInstances) {
			if (await extension.handleRequest?.(connection, request)) {
				return;
			}
		}
		if (isWorktreeControlRequest(request)) {
			await handleWorktreeControlRequest(connection, request, {
				manager: getFallbackWorktreeManager(),
				stateManager,
			});
			return;
		}
		switch (request.type) {
			case "status": {
				const workspaces: ControlWorkspaceStatus[] = state.state.workspaces.map((workspace) => ({
					name: workspace.name,
					path: workspace.path,
					...(workspace.allowedTools === undefined
						? {}
						: {
								allowedTools: workspace.allowedTools
									.split(",")
									.map((tool) => tool.trim())
									.filter((tool) => tool.length > 0),
							}),
				}));
				let leases: ControlLeaseStatus[] = [];
				let phoneConnections = 0;
				for (const extension of extensionInstances) {
					const extras = extension.statusExtras?.();
					if (extras?.leases) {
						leases = leases.concat(extras.leases);
					}
					phoneConnections += extras?.phoneConnections ?? 0;
				}
				connection.send({
					type: "status_result",
					id: request.id,
					version: VERSION,
					protocolVersion: PROTOCOL_VERSION,
					pid: process.pid,
					startedAtMs,
					capabilities: [CONTROL_PAIR_CANCEL_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
					leases,
					phoneConnections,
					workspaces,
					clients: toClientStatuses(),
					revokedClients: toRevokedClientStatuses(),
					remotePolicy: {
						allowTools: state.state.settings.allowTools,
						detachedRuntimeTtlMs: state.state.settings.detachedRuntimeTtlMs,
					},
					keepAwake: keepAwake.status,
				});
				return;
			}
			case "shutdown": {
				connection.send({ type: "ok", id: request.id });
				requestShutdown("cli");
				return;
			}
			case "clients_list": {
				connection.send({ type: "clients_result", id: request.id, clients: toClientStatuses() });
				return;
			}
			case "workspace_register": {
				let workspacePath: string;
				try {
					const stats = await stat(request.path);
					if (!stats.isDirectory()) {
						throw new Error(`Workspace path is not a directory: ${request.path}`);
					}
					workspacePath = await realpath(request.path);
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_workspace",
						message: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				await stateManager.upsertWorkspace({ name: request.name, path: workspacePath });
				await auditLogger
					.log({
						type: "workspace_registered",
						workspace: request.name,
						success: true,
						details: { path: workspacePath, source: "control" },
					})
					.catch(() => {});
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "workspace_unregister": {
				// State-only fallback (no Iroh extension running).
				let removedWorkspace: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
				try {
					removedWorkspace = await stateManager.unregisterWorkspace(request.name);
				} catch (error) {
					if (!isIrohRemoteWorkspaceHasWorktreesError(error)) {
						throw error;
					}
					await auditLogger
						.log({
							type: "workspace_unregistered",
							workspace: request.name,
							success: false,
							error: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
							details: {
								source: "state_only_fallback",
								worktreeCount: error.worktreeIds.length,
								worktreeIds: error.worktreeIds,
							},
						})
						.catch(() => {});
					connection.send({
						type: "error",
						id: request.id,
						code: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
						message: error.message,
					});
					return;
				}
				if (!removedWorkspace) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: `No registered workspace named ${request.name}`,
					});
					return;
				}
				await stateManager.removeLiveActivitiesForWorkspace(request.name);
				await auditLogger
					.log({
						type: "workspace_unregistered",
						workspace: request.name,
						success: true,
						details: { source: "state_only_fallback" },
					})
					.catch(() => {});
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "client_access_update": {
				const access =
					request.access !== undefined
						? createIrohRemotePresetAccess(request.access)
						: createIrohRemoteExplicitAccess(
								request.allowedTools ?? [],
								parseIrohRemoteRpcCapabilities(request.rpcCapabilities),
							);
				const updated = await stateManager.updateClientAccess(
					request.clientNodeId,
					request.expectedRevision,
					access,
				);
				if (!updated.ok) {
					connection.send({
						type: "error",
						id: request.id,
						code: updated.reason,
						message:
							updated.reason === "revision_conflict"
								? `RPC grant revision conflict (current ${updated.currentRevision ?? "unknown"})`
								: updated.reason === "revision_exhausted"
									? "RPC grant revision is exhausted; revoke and re-pair the client"
									: "client not found",
					});
					return;
				}
				await state.flush();
				await auditLogger
					.log({
						type: "client_access_updated",
						clientNodeId: request.clientNodeId,
						success: true,
						details: {
							expectedRevision: request.expectedRevision,
							revision: updated.client.rpcGrant.revision,
							allowedTools: normalizeIrohRemoteAllowTools(updated.client.allowedTools),
							rpcCapabilities: updated.client.rpcGrant.capabilities,
						},
					})
					.catch(() => {});
				connection.send({
					type: "client_access_updated",
					id: request.id,
					client: {
						clientNodeId: updated.client.nodeId,
						label: updated.client.label,
						pairedAtMs: updated.client.pairedAt,
						lastSeenAtMs: updated.client.lastSeenAt,
						allowedTools: parseIrohRemoteAllowTools(updated.client.allowedTools),
						usesDefaultTools: updated.client.allowedTools === undefined,
						rpcGrant: updated.client.rpcGrant,
					},
				});
				return;
			}
			case "client_revoke": {
				// State-only fallback (no Iroh extension running).
				const result = await stateManager.revokeClient(request.clientNodeId);
				await auditLogger
					.log({
						type: "client_revoked",
						clientNodeId: request.clientNodeId,
						success: result.revoked,
						error: result.revoked ? undefined : "client not found",
					})
					.catch(() => {});
				if (!result.revoked) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return;
				}
				if ((result.client?.pushTargets?.length ?? 0) > 0) {
					const summary = await revokeIrohRemoteClientPushTargets(result.client, fallbackPushRelayClient);
					const complete = summary.failed === 0 && summary.skipped === 0;
					if (!complete) {
						log("warn", "remote push-target cleanup incomplete after fallback client revoke", { ...summary });
					}
					await auditLogger
						.log({
							type: "push_targets_revoked",
							clientNodeId: request.clientNodeId,
							success: complete,
							error: complete
								? undefined
								: "remote push-target cleanup incomplete; relay TTL remains the lifetime bound",
							details: { ...summary, remainingLifetimeBound: "relay_target_ttl", source: "state_only_fallback" },
						})
						.catch(() => {});
				}
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "theme_set": {
				// Validate before applying: runtime setTheme falls back to dark on
				// failure, which must not clobber the active theme on a bad request.
				if (!getThemeByName(request.theme)) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_theme",
						message: `unknown theme: ${request.theme}`,
					});
					return;
				}
				const result = setTheme(request.theme, false);
				if (!result.success) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_theme",
						message: result.error ?? `unknown theme: ${request.theme}`,
					});
					return;
				}
				state.updateSettings({ themeName: request.theme });
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "keep_awake_set": {
				const status = keepAwake.setEnabled(request.enabled);
				state.updateSettings({ keepAwakeEnabled: request.enabled });
				connection.send({ type: "keep_awake_result", id: request.id, keepAwake: status });
				return;
			}
			case "client_approve_repair": {
				const result = await stateManager.approveClientRePair(request.clientNodeId);
				await auditLogger
					.log({
						type: "client_repair_approved",
						clientNodeId: request.clientNodeId,
						success: result.approved,
						error: result.approved ? undefined : "revoked client not found",
					})
					.catch(() => {});
				if (!result.approved) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: "revoked client not found",
					});
					return;
				}
				await state.flush();
				connection.send({ type: "ok", id: request.id });
				return;
			}
			default:
				connection.send({
					type: "error",
					id: request.id,
					code: "unsupported",
					message: `unsupported control request: ${request.type}`,
				});
				return;
		}
	};

	const bindControlServer = () =>
		startControlServer({
			socketPath: paths.socketPath,
			version: VERSION,
			authToken: pidfileToken,
			handlers: {
				onRequest: handleRequest,
				isShuttingDown: () => shutdownPhase !== "running",
				relayAdmission: {
					admitRelay(hello, socket, bufferedRemainder) {
						for (const extension of extensionInstances) {
							if (extension.admitRelay?.(hello.relayId, hello.relayToken, socket, bufferedRemainder)) {
								return true;
							}
						}
						return false;
					},
				},
				onConnectionClosed(connection) {
					for (const extension of extensionInstances) {
						extension.onConnectionClosed?.(connection);
					}
				},
				log(level, message) {
					logger.log(level === "info" ? "info" : level, "control", message);
				},
			},
		});

	// All daemon instances sharing an agent directory are serialized before bind;
	// the socket bind remains a final guard against external listeners.
	try {
		controlServer = await bindControlServer();
	} catch (error) {
		if (isErrnoException(error) && error.code === "EADDRINUSE") {
			const deadline = Date.now() + DAEMON_BIND_WAIT_TIMEOUT_MS;
			const pidfile = readPidfile(paths.pidfilePath);
			const probeOptions = {
				version: VERSION,
				...(pidfile?.socketPath === paths.socketPath && pidfile.token !== undefined
					? { authToken: pidfile.token }
					: {}),
			};
			let socketProbe = await probeControlSocket(paths.socketPath, probeOptions);
			let loggedShutdownWait = false;
			while (
				socketProbe.kind === "live-rejected" &&
				socketProbe.reason === "shutting_down" &&
				Date.now() < deadline
			) {
				if (!loggedShutdownWait) {
					loggedShutdownWait = true;
					log("info", "another daemon is shutting down; waiting for socket release");
				}
				await sleep(DAEMON_BIND_WAIT_POLL_MS);
				socketProbe = await probeControlSocket(paths.socketPath, { ...probeOptions, timeoutMs: 500 });
			}
			if (socketProbe.kind === "healthy") {
				log("info", `another daemon is healthy (pid ${socketProbe.status.pid}); exiting`);
				return finishBeforeServing(VOLTD_EXIT_ALREADY_RUNNING);
			}
			if (socketProbe.kind === "live-rejected" && socketProbe.reason === "protocol_mismatch") {
				log(
					"error",
					`another daemon is running with protocol ${socketProbe.protocolVersion ?? "unknown"}; not removing its socket`,
				);
				return finishBeforeServing(VOLTD_EXIT_INCOMPATIBLE_RUNNING);
			}
			if (pidfile && (await verifyPidfileProcess(pidfile)) === "match") {
				log("error", `pidfile still verifies live daemon pid ${pidfile.pid}; not removing socket`);
				return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
			}
			const canRegenerateWindowsPipe =
				process.platform === "win32" && usingDefaultSocketPath && isWindowsNamedPipePath(paths.socketPath);
			const canUnlinkSocketPath = !isWindowsNamedPipePath(paths.socketPath);
			const retryBind = async (message: string): Promise<boolean> => {
				log("warn", message);
				if (canRegenerateWindowsPipe) {
					selectedSocketPath = createDaemonControlSocketPath(agentDir);
					paths = resolvePaths();
					ensureDaemonDirs(paths);
				} else if (canUnlinkSocketPath) {
					rmSync(paths.socketPath, { force: true });
				} else {
					log("error", "control pipe is occupied and cannot be unlinked; not retrying bind");
					return false;
				}
				try {
					controlServer = await bindControlServer();
					return true;
				} catch (retryError) {
					log(
						"error",
						`bind retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
					);
					return false;
				}
			};
			if (socketProbe.kind === "live-rejected" || socketProbe.kind === "unresponsive") {
				if (
					!canRegenerateWindowsPipe ||
					(socketProbe.kind === "live-rejected" && socketProbe.reason === "shutting_down")
				) {
					log("error", "control socket is owned by a live daemon that is not healthy; not removing it");
					return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
				}
				if (
					!(await retryBind(
						"control pipe is occupied by a non-Volt listener; choosing a fresh pipe name and retrying bind once",
					))
				) {
					return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
				}
			} else if (
				!(await retryBind(
					canRegenerateWindowsPipe
						? "stale or pre-created control pipe detected; choosing a fresh pipe name and retrying bind once"
						: "stale socket detected; unlinking and retrying bind once",
				))
			) {
				return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
			}
		} else {
			log("error", `bind failed: ${error instanceof Error ? error.message : String(error)}`);
			return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
		}
	}
	if (!controlServer) {
		log("error", "bind failed: control server was not created");
		return finishBeforeServing(VOLTD_EXIT_BIND_FAILED);
	}

	// Pidfile is discovery metadata; liveness truth is the authenticated socket probe.
	writeFileSync(
		paths.pidfilePath,
		`${JSON.stringify({ pid: process.pid, version: VERSION, startedAtMs, socketPath: paths.socketPath, token: pidfileToken } satisfies PidfileContents)}\n`,
		{ mode: 0o600 },
	);

	// Broadcast every successful theme change (control theme_set, or an extension
	// calling ctx.ui.setTheme inside a daemon-owned runtime) to all control
	// clients as a resolved-token snapshot, and let service extensions push it
	// onward (e.g. host_theme_tokens frames to capable phones, §9.5).
	onThemeChange(() => {
		controlServer?.broadcast({
			type: "theme_snapshot",
			themeName: getCurrentThemeName() ?? "dark",
			tokens: getResolvedThemeColors(),
		});
		for (const extension of extensionInstances) {
			extension.onThemeChanged?.();
		}
	});

	const services: VoltdRuntimeServices = {
		agentDir,
		paths,
		logger,
		state,
		stateManager,
		auditLogger,
		controlServer,
		keepAwake,
		webSearchKey,
		requestShutdown,
	};
	for (const extension of extensions) {
		extensionInstances.push(extension(services));
	}

	// Re-apply the persisted keep-awake assertion now that extensions exist, so
	// their onKeepAwakeChanged hooks observe the startup transition.
	if (state.state.settings.keepAwakeEnabled === true) {
		keepAwake.setEnabled(true);
	}

	const processLifecycle = config.processLifecycle ?? defaultProcessLifecycle;
	const onSignal = () => {
		if (shutdownPhase !== "running") {
			log("warn", `shutdown signal received during ${shutdownPhase}; forcing process exit`);
			processLifecycle.forceExit(1);
			return;
		}
		requestShutdown("signal");
	};
	processLifecycle.addShutdownSignalHandler(onSignal);

	if (
		legacyDroppedAccess !== undefined &&
		legacyDroppedAccess.clients + legacyDroppedAccess.revokedClients + legacyDroppedAccess.pendingPairingTickets > 0
	) {
		await auditLogger
			.log({
				type: "legacy_remote_access_dropped",
				success: true,
				details: { ...legacyDroppedAccess, requiresRePair: true },
			})
			.catch(() => {});
	}
	await auditLogger
		.log({
			type: "daemon_started",
			success: true,
			details: { version: VERSION, migratedFromLegacyState, legacyDroppedAccess },
		})
		.catch(() => {});
	log("info", `voltd ${VERSION} listening`, { socketPath: paths.socketPath, pid: process.pid });

	const code = await exitPromise;
	processLifecycle.removeShutdownSignalHandler(onSignal);
	return code;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
