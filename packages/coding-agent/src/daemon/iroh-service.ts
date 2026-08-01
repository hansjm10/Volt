import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { relative, resolve, sep } from "node:path";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../core/agent-session-services.ts";
import { clonePlanningState, DEFAULT_PLANNING_STATE } from "../core/planning.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	getIrohRemoteRpcCommandCapabilities,
	getIrohRemoteStreamCapability,
	getMissingIrohRemoteRpcCapability,
	hasIrohRemoteRpcCapability,
	parseIrohRemoteRpcCapabilities,
	parseIrohRemoteRpcGrant,
} from "../core/remote/iroh/access-grant.ts";
import type { IrohRemoteActiveStreamEntry } from "../core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import {
	createIrohRemoteAgentLaunchOptions,
	createIrohRemoteAgentLaunchSessionId,
	digestIrohRemoteAgentLaunchRequest,
	type IrohRemoteAgentLaunchConfiguredConfig,
	type IrohRemoteAgentLaunchOptions,
	type IrohRemoteAgentLaunchResolvedPlacement,
	type IrohRemoteAgentLaunchResult,
	type IrohRemoteAgentLaunchRpcBackend,
	type IrohRemoteCreateAgentRequest,
	resolveIrohRemoteAgentLaunchConfig,
} from "../core/remote/iroh/agent-launch.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { hashIrohRemotePairingSecret } from "../core/remote/iroh/authorization.ts";
import {
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	IrohRemoteHostEngine,
	type IrohRemoteHostHandshakeResult,
} from "../core/remote/iroh/engine.ts";
import {
	createIrohRemoteHandshakeFailure,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHello,
} from "../core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	writeIrohRemoteHandshakeResponse,
} from "../core/remote/iroh/handshake-reader.ts";
import { resolveIrohRemoteWorkspaceProjectTrusted } from "../core/remote/iroh/host-policy.ts";
import {
	IROH_REMOTE_ALPN,
	normalizeIrohRemoteAllowTools,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../core/remote/iroh/protocol.ts";
import {
	IrohRemoteInMemoryPushNotificationDeduper,
	type IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushNotificationIntent,
	IrohRemotePushRelayHttpClient,
	revokeIrohRemoteClientPushTargets,
} from "../core/remote/iroh/push.ts";
import {
	createIrohRemoteRpcCapabilityDeniedResponse,
	createIrohRemoteRpcErrorResponse,
} from "../core/remote/iroh/rpc-command-filter.ts";
import type { IrohRemoteClient, IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import {
	IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
	type IrohRemoteHostStateManager,
	isIrohRemoteWorkspaceHasWorktreesError,
} from "../core/remote/iroh/state-manager.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../core/remote/iroh/worktree-rpc.ts";
import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import { getDefaultSessionDir, SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { getCurrentThemeName, getResolvedThemeColors } from "../core/theme/runtime.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { createIrohRemoteAgentRuntimeWithSessionSelection } from "../modes/rpc/iroh-remote-agent-runtime.ts";
import { runIrohRemoteRpcMode } from "../modes/rpc/iroh-remote-rpc-mode.ts";
import { cleanupIncompleteAgentLaunch } from "./agent-launch-cleanup.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlLeaseStatus,
	type ControlRequest,
	createControlClientStatus,
	RELAY_RPC_COMMAND_TYPES,
	type RelayCloseReason,
} from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import {
	type ConversationCommandContext,
	createKeepAwakeRpcResponse,
	createRemoteRegisterLiveActivityRpcResponse,
	createRemoteUnregisterLiveActivityRpcResponse,
	createRpcSuccessResponse,
	createWebSearchKeyRpcResponse,
	getRpcResponseId,
	handleIntegratedConversationRpcCommand,
	handleRemoteHostRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
	type RemoteSessionListCursorEntry,
	toRpcKeepAwakeStatus,
} from "./conversation-commands.ts";
import {
	type ConversationCoordinator,
	ConversationCoordinatorRegistry,
	type ConversationCoordinatorRekeyReservation,
} from "./conversation-coordinator.ts";
import {
	createRemoteConversationExternalProjector,
	createRemoteConversationSnapshotBuilder,
} from "./conversation-projection.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type RemoteHostResponseContext,
} from "./handshake-responses.ts";
import {
	createConversationOpenError,
	getResolvedTargetSessionId,
	type IntegratedRuntimeAttachClaim,
	type IntegratedRuntimeEntry,
	IntegratedRuntimeRegistry,
	type IntegratedRuntimeSubscriber,
} from "./integrated-runtimes.ts";
import { IrohConnectionSupervisor } from "./iroh-connection-supervisor.ts";
import {
	formatIrohLoadError,
	type IrohConnectionLike,
	type IrohEndpointLike,
	type IrohModuleLike,
	loadIrohModule,
} from "./iroh-native.ts";
import { IrohRemoteResourceGuard } from "./iroh-resource-guard.ts";
import {
	createLifecycleFencedIrohStream,
	IrohStreamLifecycleClosedError,
	isIrohStreamLifecycleClosedError,
	runLifecycleFencedPhysicalOperation,
} from "./iroh-stream-lifecycle.ts";
import { type DaemonAttachClaim, LeaseBroker, type LeaseState } from "./lease-broker.ts";
import type { VoltdRuntimeServices, VoltdServiceExtension } from "./main.ts";
import { RelayRegistry } from "./relay-stream.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	resolveIrohRemoteSessionTarget,
} from "./session-target.ts";
import { resolveWorktreeCleanupPolicy } from "./state.ts";
import { createHostThemeTokensFrame, HOST_THEME_TOKENS_FEATURE } from "./theme-push.ts";
import { ViewerFeedRegistry } from "./viewer-feed.ts";
import { isPathInside, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import {
	type RemoteSanitizerOverrides,
	runAgentLaunchManagementStream,
	runWorkspaceDiscoveryStream,
	runWorkspaceManagementStream,
	runWorktreeManagementStream,
	WORKSPACE_UNREGISTERED_CLOSE_REASON,
	writeIrohRemoteJsonLine,
} from "./workspace-streams.ts";
import {
	evaluateWorktreeRelayGate,
	getRegisteredWorkingDirectoryForWorktree,
	getWorkspaceWorktreesDir,
	getWorktreesRoot,
	handleWorktreeControlRequest,
	isWorktreeControlRequest,
	WorktreeManager,
	type WorktreeResult,
	WorktreeRetentionSweeper,
} from "./worktree-manager.ts";

const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const DUPLICATE_CONVERSATION_RETRY_AFTER_MS = 500;
const RELAY_OFFER_RETRY_AFTER_MS = 1000;
const WORKSPACE_DISCOVERY_STREAM_SESSION_ID = "$workspace-discovery";
const WORKSPACE_MANAGEMENT_STREAM_SESSION_ID = "$workspace-management";
const IROH_ENDPOINT_READY_TIMEOUT_MS = 15_000;
const IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS = 15_000;
const SHUTDOWN_RUNTIME_IDLE_CAP_MS = 60_000;

class AgentLaunchAuthorizationChangedError extends Error {
	constructor() {
		super("agent launch authorization changed");
		this.name = "AgentLaunchAuthorizationChangedError";
	}
}

class AgentLaunchHostShutdownError extends Error {
	constructor() {
		super("host is shutting down");
		this.name = "AgentLaunchHostShutdownError";
	}
}

function getAgentLaunchBoundaryFailure(error: unknown): IrohRemoteAgentLaunchResult | undefined {
	if (error instanceof AgentLaunchAuthorizationChangedError) {
		return {
			kind: "error",
			error: { kind: "authorization_changed", message: "client or workspace authorization changed during launch" },
		};
	}
	if (error instanceof AgentLaunchHostShutdownError) {
		return { kind: "error", error: { kind: "host_shutdown", message: error.message } };
	}
	return undefined;
}

function normalizeRelayCloseReason(reason: string): RelayCloseReason {
	switch (reason) {
		case "phone_disconnected":
		case "tui_disconnected":
		case "lease_transferred":
		case "session_rekeyed_reconnect":
		case "workspace_unregistered":
		case "host_shutdown":
		case "error":
			return reason;
		default:
			return "error";
	}
}

function relayPendingMessageForReason(reason: string): string {
	if (reason === "host_shutdown") return "daemon shutting down";
	if (reason === "workspace_unregistered") return "workspace unregistered";
	return "relay offer cancelled; retry";
}

export type AuthorityInvalidationRuntime = Pick<IntegratedRuntimeEntry, "clientNodeId" | "workspaceName" | "sessionId">;

export function collectClientAuthorityInvalidationRuntimes<T extends AuthorityInvalidationRuntime>(
	activeStreams: IrohRemoteActiveStreamRegistry,
	runtimes: Iterable<T>,
	clientNodeId: string,
): Set<T> {
	const clientEntries = activeStreams.entriesForClientNodeId(clientNodeId);
	return new Set(
		Array.from(runtimes).filter(
			(runtime) =>
				runtime.clientNodeId === clientNodeId ||
				clientEntries.some(
					(entry) => entry.workspaceName === runtime.workspaceName && entry.sessionId === runtime.sessionId,
				),
		),
	);
}

export function collectClientAuthorityInvalidationStreams(
	activeStreams: IrohRemoteActiveStreamRegistry,
	runtimes: Iterable<AuthorityInvalidationRuntime>,
	clientNodeId: string,
): Set<IrohRemoteActiveStreamEntry> {
	const runtimeList = Array.from(runtimes);
	const entries = new Set(activeStreams.entriesForClientNodeId(clientNodeId));
	for (const runtime of collectClientAuthorityInvalidationRuntimes(activeStreams, runtimeList, clientNodeId)) {
		for (const entry of activeStreams.entriesForConversationKey(runtime.workspaceName, runtime.sessionId)) {
			entries.add(entry);
		}
	}
	return entries;
}

function getRelativeWorkingDirectoryForRoot(rootPath: string, cwd: string): string | null | undefined {
	const root = resolve(rootPath);
	const child = resolve(cwd);
	if (!isPathInside(root, child)) {
		return null;
	}
	const relativePath = relative(root, child);
	return relativePath.length === 0 || relativePath === "." ? undefined : relativePath.split(sep).join("/");
}

/**
 * Defensive cap on concurrent in-flight bi-streams per client connection. A
 * well-behaved client keeps only a handful open (one conversation + a few
 * utility streams); an authenticated-but-misbehaving client could otherwise open
 * unbounded concurrent streams, each spawning a runtime attach, and exhaust
 * daemon resources. Hitting the cap closes the connection.
 */
const MAX_CONCURRENT_STREAMS_PER_CONNECTION = 64;

let activeConnectionSequence = 0;
let activeStreamSequence = 0;

export type IrohRelayMode = "disabled" | "development" | "production";

/**
 * The Volt-operated relay fleet. Endpoints bind against these by default
 * ("production" mode); the n0 public relays ("development" mode) are for
 * development only and must be opted into via VOLT_IROH_RELAY_MODE=development.
 */
export const VOLT_PRODUCTION_RELAY_URLS = ["https://iroh-relay-us-central.volt-cli.dev"];

export interface IrohDaemonServiceConfig {
	relayMode?: IrohRelayMode;
	/**
	 * Relay server URLs (e.g. "https://relay.example.com"). When set (or via
	 * VOLT_IROH_RELAY_URLS, comma-separated), production mode binds against
	 * these instead of the built-in Volt fleet, and pairing tickets carry the
	 * URLs so clients bind against the same relays.
	 */
	relayUrls?: string[];
	/**
	 * Bearer token presented to relay servers configured with
	 * access.shared_token. Falls back to VOLT_IROH_RELAY_AUTH_TOKEN, then the
	 * token persisted in daemon state from a previous start.
	 */
	relayAuthToken?: string;
	pushRelayUrl?: string;
	pushRelayAuthToken?: string;
	profile?: string;
}

export interface IrohDaemonServiceDependencies {
	/** Decorate a freshly bound endpoint (used to exercise native lifecycle failures). */
	decorateEndpoint?(endpoint: IrohEndpointLike): IrohEndpointLike;
	/** Decorate an accepted raw stream before lifecycle fencing (test-only failure injection). */
	decorateAcceptedStream?(stream: IrohBiStreamLike): IrohBiStreamLike;
	/** Pause an authorized attach immediately before its first ownership publication (test-only race injection). */
	beforeAuthorizedStreamPublication?(
		kind:
			| "conversation"
			| "workspace_discovery"
			| "workspace_management"
			| "worktree_management"
			| "agent_management"
			| "relay",
		authorization: IrohRemoteClientAuthorizationSuccess,
	): void | Promise<void>;
	/** Runtime factory seam for cold-launch fault-injection tests. */
	createAgentLaunchRuntime?: typeof createIrohRemoteAgentRuntimeWithSessionSelection;
	/** Pause or invalidate authority immediately inside the cold-launch publication fence. */
	beforeAgentLaunchPublication?(): void | Promise<void>;
	/** Inject a failure after selection persistence and commit append, before final WAL flush. */
	beforeAgentLaunchCommitFlush?(): void | Promise<void>;
}

export interface ResolvedIrohRelayConfig {
	relayMode: IrohRelayMode;
	relayUrls: string[];
	warning?: string;
}

/**
 * Resolves the effective relay configuration. Precedence: explicit service
 * config, then VOLT_IROH_RELAY_MODE / VOLT_IROH_RELAY_URLS, then the Volt
 * production relay fleet.
 */
export function resolveIrohRelayConfig(
	config: Pick<IrohDaemonServiceConfig, "relayMode" | "relayUrls">,
	env: Record<string, string | undefined> = process.env,
): ResolvedIrohRelayConfig {
	const envUrls = parseRelayUrlsEnv(env.VOLT_IROH_RELAY_URLS);
	const envModeValue = env.VOLT_IROH_RELAY_MODE?.trim();
	let envMode: IrohRelayMode | undefined;
	let warning: string | undefined;
	if (envModeValue !== undefined && envModeValue !== "") {
		if (envModeValue === "disabled" || envModeValue === "development" || envModeValue === "production") {
			envMode = envModeValue;
		} else {
			warning = `ignoring invalid VOLT_IROH_RELAY_MODE "${envModeValue}" (expected disabled, development, or production)`;
		}
	}
	const relayMode = config.relayMode ?? envMode ?? "production";
	const configuredUrls = config.relayUrls ?? envUrls;
	const relayUrls =
		relayMode === "production" ? (configuredUrls ?? VOLT_PRODUCTION_RELAY_URLS) : (configuredUrls ?? []);
	return { relayMode, relayUrls, ...(warning === undefined ? {} : { warning }) };
}

function parseRelayUrlsEnv(value: string | undefined): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const urls = value
		.split(",")
		.map((url) => url.trim())
		.filter((url) => url.length > 0);
	return urls.length > 0 ? urls : undefined;
}

interface PendingPairRequest {
	requestId: string;
	connectionId: string;
	secretHash: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
	cancellation?: Promise<void>;
}

interface ClientConnectionRecord {
	connectionId: string;
	supervisor: IrohConnectionSupervisor;
}

type RelayPushDeliveryResult =
	| { ok: true; status: IrohRemotePushNotificationDeliveryStatus }
	| { ok: false; code: string; message: string };

function isExpectedApplicationClose(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ConnectionLost(ApplicationClosed") &&
		message.includes("error_code: 0") &&
		(message.includes('reason: b"done"') ||
			message.includes(`reason: b"${ACTIVE_REVOKE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${ACTIVE_REPLACE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${WORKSPACE_UNREGISTERED_CLOSE_REASON}"`))
	);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Keep a provisional admission task observed, but stop making daemon shutdown
 * wait for an external operation that cannot itself be cancelled. Every
 * ownership publication inside the task still revalidates the lease/signal;
 * if the external promise eventually settles, its normal stale-admission path
 * performs rollback and resource cleanup.
 */
async function waitUntilAdmissionCancelled<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) {
		void task.catch(() => {});
		return undefined;
	}
	let detachAbort = () => {};
	const cancelled = new Promise<undefined>((resolve) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		detachAbort = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([task, cancelled]);
	} finally {
		detachAbort();
		// Promise.race does not observe a loser that rejects later.
		void task.catch(() => {});
	}
}

export interface IrohDaemonAdmissionLease {
	/** Aborted synchronously when the daemon closes this admission epoch. */
	readonly signal: AbortSignal;
	/** True only while this lease still belongs to the service's open admission epoch. */
	isCurrent(): boolean;
	release(): void;
}

/**
 * One-way admission epoch for daemon-owned work. Closing the gate is
 * synchronous: callers that already crossed an await must revalidate their
 * lease immediately before publishing ownership, while shutdown can await the
 * fixed set of pre-close operations before taking runtime snapshots.
 */
export class IrohDaemonAdmissionGate {
	private open = true;
	private epoch = 0;
	private inFlight = 0;
	private readonly abortController = new AbortController();
	private drainPromise: Promise<void> | undefined;
	private resolveDrain: (() => void) | undefined;

	get isOpen(): boolean {
		return this.open;
	}

	tryAcquire(): IrohDaemonAdmissionLease | undefined {
		if (!this.open) {
			return undefined;
		}
		const leaseEpoch = this.epoch;
		let released = false;
		this.inFlight++;
		return {
			signal: this.abortController.signal,
			isCurrent: () => !released && this.open && this.epoch === leaseEpoch,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.inFlight--;
				if (this.inFlight === 0) {
					this.resolveDrain?.();
					this.resolveDrain = undefined;
					this.drainPromise = undefined;
				}
			},
		};
	}

	close(): void {
		if (!this.open) {
			return;
		}
		this.open = false;
		this.epoch++;
		this.abortController.abort(new Error("Iroh daemon admission closed"));
	}

	waitForDrain(): Promise<void> {
		if (this.inFlight === 0) {
			return Promise.resolve();
		}
		if (!this.drainPromise) {
			this.drainPromise = new Promise<void>((resolve) => {
				this.resolveDrain = resolve;
			});
		}
		return this.drainPromise;
	}
}

type IrohPhysicalStreamCloseAction = (reason: string) => Promise<void> | void;

/** Single idempotent owner for a physical bi-stream from accept to task exit. */
export class IrohPhysicalStreamOwner {
	private readonly fallbackClose: IrohPhysicalStreamCloseAction;
	readonly physicalStream: IrohBiStreamLike | undefined;
	private readonly closeController = new AbortController();
	private closeAction: IrohPhysicalStreamCloseAction | undefined;
	private readonly settledPromise: Promise<void>;
	private resolveSettled: () => void = () => {};
	private rejectSettled: (error: unknown) => void = () => {};
	private closeStarted = false;

	constructor(fallbackClose: IrohPhysicalStreamCloseAction, physicalStream?: IrohBiStreamLike) {
		this.fallbackClose = fallbackClose;
		this.physicalStream = physicalStream;
		this.settledPromise = new Promise<void>((resolve, reject) => {
			this.resolveSettled = resolve;
			this.rejectSettled = reject;
		});
	}

	get isClosing(): boolean {
		return this.closeStarted;
	}

	get settled(): Promise<void> {
		return this.settledPromise;
	}

	get signal(): AbortSignal {
		return this.closeController.signal;
	}

	installCloseAction(closeAction: IrohPhysicalStreamCloseAction): boolean {
		if (this.closeStarted || this.closeAction !== undefined) {
			return false;
		}
		this.closeAction = closeAction;
		return true;
	}

	close(reason: string): Promise<void> {
		if (this.closeStarted) {
			return this.settledPromise;
		}
		this.closeStarted = true;
		const closeAction = this.closeAction ?? this.fallbackClose;
		try {
			const closeResult = closeAction(reason);
			this.closeController.abort(new IrohStreamLifecycleClosedError());
			Promise.resolve(closeResult).then(this.resolveSettled, this.rejectSettled);
		} catch (error) {
			this.closeController.abort(new IrohStreamLifecycleClosedError());
			this.rejectSettled(error);
		}
		return this.settledPromise;
	}
}

function closeIrohRemoteStream(stream: IrohBiStreamLike, reason?: string): void {
	try {
		const closeSend =
			reason === "stream_task_settled"
				? stream.send.finish?.()
				: stream.send.reset
					? stream.send.reset(0n)
					: stream.send.finish?.();
		if (closeSend) void Promise.resolve(closeSend).catch(() => {});
	} catch {}
	void Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

function getRemoteTerminalReason(reason: string): string | undefined {
	if (reason === ACTIVE_REVOKE_CLOSE_REASON) {
		return "client_revoked";
	}
	if (
		reason === WORKSPACE_UNREGISTERED_CLOSE_REASON ||
		reason === "workspace_authorization_removed" ||
		reason === "lease_transferred" ||
		reason === "session_rekeyed_reconnect"
	) {
		return reason;
	}
	return undefined;
}

function isAuthorityTighteningCloseReason(reason: string): boolean {
	return (
		reason === ACTIVE_REVOKE_CLOSE_REASON ||
		reason === WORKSPACE_UNREGISTERED_CLOSE_REASON ||
		reason === "workspace_authorization_removed" ||
		reason === "access_updated" ||
		reason === "access_updated_during_attach"
	);
}

/**
 * The daemon's Iroh host: owns the endpoint identity, pairing, revocation,
 * headless integrated runtimes, workspace/device streams, push dispatch, and
 * the accept loop. Ported from the dissolved src/remote/iroh-host.mjs.
 */
export function createIrohDaemonService(
	config: IrohDaemonServiceConfig = {},
	dependencies: IrohDaemonServiceDependencies = {},
): VoltdServiceExtension {
	return (services: VoltdRuntimeServices) => {
		const log = services.logger.child("iroh");
		const loaded = loadIrohModule();
		if (!loaded.iroh) {
			log("warn", formatIrohLoadError(loaded.error));
			return {
				async handleRequest(connection, request) {
					if (request.type === "pair_request") {
						connection.send({
							type: "error",
							id: request.id,
							code: "iroh_unavailable",
							message: formatIrohLoadError(loaded.error),
						});
						return true;
					}
					return false;
				},
			};
		}

		const service = new IrohDaemonService(loaded.iroh, services, config, dependencies);
		service.start();
		return {
			handleRequest: (connection, request) => service.handleRequest(connection, request),
			onConnectionClosed: (connection) => service.onControlConnectionClosed(connection),
			onThemeChanged: () => service.onThemeChanged(),
			onKeepAwakeChanged: () => service.onKeepAwakeChanged(),
			statusExtras: () => service.statusExtras(),
			admitRelay: (relayId, relayToken, socket, bufferedRemainder) =>
				service.admitRelay(relayId, relayToken, socket, bufferedRemainder),
			quiesce: () => service.quiesce(),
			dispose: () => service.dispose(),
		};
	};
}

export class IrohDaemonService {
	private readonly iroh: IrohModuleLike;
	private readonly services: VoltdRuntimeServices;
	private readonly dependencies: IrohDaemonServiceDependencies;
	private readonly relayMode: IrohRelayMode;
	private readonly relayUrls: string[];
	private readonly relayAuthToken: string | undefined;
	private readonly relayConfigWarning: string | undefined;
	private readonly profile: string | undefined;
	private readonly log: ReturnType<VoltdRuntimeServices["logger"]["child"]>;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly activeStreams = new IrohRemoteActiveStreamRegistry();
	private readonly admission = new IrohDaemonAdmissionGate();
	private readonly physicalStreamOwners = new Map<string, IrohPhysicalStreamOwner>();
	private readonly tuiCoordinatorRekeyReservations = new Map<string, ConversationCoordinatorRekeyReservation>();
	private readonly clientConnections = new Map<string, Set<ClientConnectionRecord>>();
	private readonly connectionSupervisors = new Map<string, IrohConnectionSupervisor>();
	private readonly connectionTasks = new Set<Promise<void>>();
	private readonly nativeLifecycleTasks = new Set<Promise<void>>();
	private readonly endpointDisposalTasks = new Map<IrohEndpointLike, Promise<void>>();
	private startupTask: Promise<void> | undefined;
	private startupEndpoint: IrohEndpointLike | undefined;
	private acceptLoopTask: Promise<void> | undefined;
	private readonly resourceGuard = new IrohRemoteResourceGuard();
	private readonly pendingPairRequests = new Map<string, PendingPairRequest>();
	private readonly sessionListCursors = new Map<string, RemoteSessionListCursorEntry>();
	private readonly agentLaunchOperations = new Map<
		string,
		{ requestDigest: string; promise: Promise<IrohRemoteAgentLaunchResult> }
	>();
	private readonly pushRelayClient: IrohRemotePushRelayHttpClient;
	private readonly pushNotificationDeduper = new IrohRemoteInMemoryPushNotificationDeduper();
	private readonly trustStore: ProjectTrustStore;
	private readonly conversationCoordinators = new ConversationCoordinatorRegistry();
	private readonly runtimes: IntegratedRuntimeRegistry;
	private readonly worktrees: WorktreeManager;
	private readonly worktreeRetention: WorktreeRetentionSweeper;
	private readonly leaseBroker: LeaseBroker;
	private readonly viewerFeeds: ViewerFeedRegistry;
	private readonly relays = new RelayRegistry();
	private endpoint: IrohEndpointLike | undefined;
	private engine: IrohRemoteHostEngine | undefined;
	private hostNodeId: string | undefined;
	private endpointTicket: string | undefined;
	private readonly ready: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

	constructor(
		iroh: IrohModuleLike,
		services: VoltdRuntimeServices,
		config: IrohDaemonServiceConfig,
		dependencies: IrohDaemonServiceDependencies,
	) {
		this.iroh = iroh;
		this.services = services;
		this.dependencies = dependencies;
		const relayConfig = resolveIrohRelayConfig(config);
		this.relayMode = relayConfig.relayMode;
		this.relayUrls = relayConfig.relayUrls;
		this.relayConfigWarning = relayConfig.warning;
		this.profile = config.profile;
		const envRelayAuthToken = process.env.VOLT_IROH_RELAY_AUTH_TOKEN?.trim();
		this.relayAuthToken =
			config.relayAuthToken ??
			(envRelayAuthToken !== undefined && envRelayAuthToken !== "" ? envRelayAuthToken : undefined) ??
			services.state.state.settings.relayAuthToken;
		// Persist a newly seen token so bare restarts keep authenticating against
		// the relay without re-exporting the env var.
		if (this.relayAuthToken !== undefined && this.relayAuthToken !== services.state.state.settings.relayAuthToken) {
			services.state.updateSettings({ relayAuthToken: this.relayAuthToken });
		}
		this.log = services.logger.child("iroh");
		this.stateManager = services.stateManager;
		this.trustStore = new ProjectTrustStore(services.agentDir);
		this.pushRelayClient = new IrohRemotePushRelayHttpClient({
			authToken: config.pushRelayAuthToken ?? process.env.VOLT_PUSH_RELAY_AUTH_TOKEN,
			baseUrl: config.pushRelayUrl ?? process.env.VOLT_PUSH_RELAY_URL,
		});
		this.runtimes = new IntegratedRuntimeRegistry({
			agentDir: services.agentDir,
			profile: config.profile,
			auditLogger: services.auditLogger,
			stateManager: this.stateManager,
			activeStreams: this.activeStreams,
			coordinators: this.conversationCoordinators,
			detachedRuntimeTtlMs: () => services.state.state.settings.detachedRuntimeTtlMs,
			getToolPolicy: (workspace, clientAllowTools) =>
				resolveIrohRemoteRuntimeToolPolicy({
					clientAllowTools,
					workspaceAllowTools: workspace.allowedTools,
					daemonAllowTools: services.state.state.settings.allowTools,
				}),
			getProjectTrustedForWorkspace: (workspace) =>
				resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore }),
			setClientLastSessionId: (nodeId, workspace, sessionId) =>
				this.requireEngine().setClientLastSessionId(nodeId, workspace, sessionId),
			resolveWorktree: (workspaceName, hello, targetSessionId) =>
				this.resolveConversationWorktree(workspaceName, hello, targetSessionId),
			resolveWorkingDirectory: (options) => this.resolveConversationWorkingDirectory(options),
			bindWorktreeSession: (workspaceName, worktreeId, sessionId) =>
				this.worktrees.bindSession(workspaceName, worktreeId, sessionId),
			onRuntimeDisposed: (entry) => {
				if (entry.worktreeId !== undefined) {
					this.worktreeRetention.onRuntimeDisposed(entry.workspaceName, entry.worktreeId);
				}
			},
		});
		this.worktrees = new WorktreeManager({
			agentDir: services.agentDir,
			stateManager: this.stateManager,
			auditLogger: services.auditLogger,
			hasActiveRuntimeForSession: (workspaceName, sessionId) =>
				this.runtimes.findOwner(workspaceName, sessionId) !== undefined,
			flushState: () => services.state.flush(),
		});
		this.worktreeRetention = new WorktreeRetentionSweeper({
			manager: this.worktrees,
			stateManager: this.stateManager,
			auditLogger: services.auditLogger,
			getRetentionPolicy: () => resolveWorktreeCleanupPolicy(services.state.state.settings).retention,
		});
		this.viewerFeeds = new ViewerFeedRegistry({
			sendTo: (connectionId, event) => services.controlServer.sendTo(connectionId, event),
		});
		this.leaseBroker = new LeaseBroker({
			isRuntimeStreaming: (workspaceName, sessionId) =>
				this.runtimes.findOwner(workspaceName, sessionId)?.runtime.session.isBusy ?? false,
			waitForRuntimeIdle: async (workspaceName, sessionId) => {
				await this.runtimes.findOwner(workspaceName, sessionId)?.runtime.session.waitForIdle();
			},
			disposeRuntime: async (workspaceName, sessionId, reason) => {
				const owner = this.runtimes.findOwner(workspaceName, sessionId);
				if (owner) {
					await this.stopRuntimeEntryAfterStreams(owner, reason);
				}
			},
			closePhoneStreams: async (workspaceName, sessionId, reason) => {
				await this.closeActiveStreamsForConversationKey(workspaceName, sessionId, reason);
			},
			closeRelays: (record, reason) => {
				for (const relayId of Array.from(record.relayIds)) {
					void this.conversationCoordinators
						.get(record.workspaceName, record.sessionId)
						?.closeTransport(relayId, reason);
				}
			},
			beginTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				const existing = this.conversationCoordinators.get(workspaceName, sessionId);
				if (!existing && this.runtimes.findOwner(workspaceName, sessionId)) {
					throw new Error(`daemon runtime lost its conversation coordinator for ${workspaceName}/${sessionId}`);
				}
				(existing ?? this.conversationCoordinators.getOrCreate(workspaceName, sessionId)).beginTuiLeaseHandoff(
					connectionId,
				);
			},
			commitTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				const coordinator = this.conversationCoordinators.get(workspaceName, sessionId);
				if (!coordinator) {
					throw new Error(`TUI handoff lost its conversation coordinator for ${workspaceName}/${sessionId}`);
				}
				coordinator.commitTuiLeaseHandoff(connectionId);
			},
			cancelTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
				this.conversationCoordinators.get(workspaceName, sessionId)?.cancelTuiLeaseHandoff(connectionId);
			},
			releaseTuiLease: (workspaceName, sessionId, connectionId) => {
				this.conversationCoordinators.get(workspaceName, sessionId)?.releaseTuiLease(connectionId);
			},
			prepareTuiLeaseRekey: (transactionId, workspaceName, oldSessionId, newSessionId, connectionId) => {
				const coordinator = this.conversationCoordinators.get(workspaceName, oldSessionId);
				if (!coordinator || coordinator.tuiLeaseConnectionId !== connectionId) {
					throw new Error("TUI lease rekey cannot reserve its conversation coordinator authority");
				}
				const reservation = this.conversationCoordinators.prepareRekey(coordinator, newSessionId);
				this.tuiCoordinatorRekeyReservations.set(transactionId, reservation);
			},
			commitTuiLeaseRekey: (transactionId, connectionId) => {
				const reservation = this.tuiCoordinatorRekeyReservations.get(transactionId);
				if (!reservation || reservation.coordinator.tuiLeaseConnectionId !== connectionId) {
					throw new Error("TUI lease rekey lost its conversation coordinator reservation");
				}
				this.conversationCoordinators.commitRekey(reservation);
				this.tuiCoordinatorRekeyReservations.delete(transactionId);
			},
			rollbackTuiLeaseRekey: (transactionId, connectionId) => {
				const reservation = this.tuiCoordinatorRekeyReservations.get(transactionId);
				if (!reservation || reservation.coordinator.tuiLeaseConnectionId !== connectionId) return;
				this.conversationCoordinators.rollbackRekey(reservation);
				this.tuiCoordinatorRekeyReservations.delete(transactionId);
			},
			onDrainStarted: (record, viewerFeedId) => {
				const owner = this.runtimes.findOwner(record.workspaceName, record.sessionId);
				if (owner && record.tuiConnectionId) {
					this.viewerFeeds.start(viewerFeedId, record.tuiConnectionId, owner.runtime.session);
				}
			},
			onDrainEnded: (_record, viewerFeedId, reason) => {
				this.viewerFeeds.end(viewerFeedId, reason);
			},
			audit: (event) => {
				void this.logAudit({
					type: event.type,
					workspace: event.workspaceName,
					success: true,
					details: { sessionId: event.sessionId, ...event.details },
				});
			},
		});
		this.conversationCoordinators.bindLeaseBroker(this.leaseBroker);
		let readyResolve: () => void = () => {};
		let readyReject: (error: unknown) => void = () => {};
		const readyPromise = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		readyPromise.catch(() => {});
		this.ready = { promise: readyPromise, resolve: readyResolve, reject: readyReject };
	}

	private requireEngine(): IrohRemoteHostEngine {
		if (!this.engine) {
			throw new Error("iroh host engine is not ready");
		}
		return this.engine;
	}

	private async reconcileAgentLaunchesOnStart(signal: AbortSignal): Promise<void> {
		try {
			const state = await this.stateManager.getState();
			for (const workspace of state.workspaces) {
				if (signal.aborted) return;
				const sessionDir = getDefaultSessionDir(workspace.path, this.services.agentDir);
				const sessions = await SessionManager.list(workspace.path, sessionDir, undefined, {
					includeMessageFreeDurable: true,
				});
				for (const session of sessions) {
					if (signal.aborted) return;
					try {
						const manager = SessionManager.open(session.path, sessionDir);
						const records = manager.getAgentLaunchRecords();
						if (records.length === 0 || records.every((record) => record.commit !== undefined)) continue;
						const record = records.find((candidate) => candidate.commit === undefined)!;
						await cleanupIncompleteAgentLaunch({
							workspace,
							sessionId: session.id,
							sessionFile: session.path,
							record,
							removeWorktree: (targetWorkspace, worktreeId) =>
								this.worktrees.remove(targetWorkspace, worktreeId, { force: true }),
							log: (message, details) => this.log("warn", message, details),
						});
					} catch (error) {
						this.log("warn", "failed to reconcile an incomplete agent launch", {
							workspace: workspace.name,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		} catch (error) {
			this.log("warn", "agent launch startup reconciliation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async pruneWorktreesOnStart(signal: AbortSignal): Promise<void> {
		if (signal.aborted || !resolveWorktreeCleanupPolicy(this.services.state.state.settings).pruneOnStart) {
			return;
		}
		try {
			const state = await this.stateManager.getState();
			if (signal.aborted) return;
			const workspacesWithRecords = new Set((state.worktrees ?? []).map((worktree) => worktree.workspaceName));
			for (const workspace of state.workspaces) {
				if (signal.aborted) return;
				// Skip workspaces with neither records nor checkout directories: no git
				// subprocesses or audit noise on the common no-worktrees start.
				if (
					!workspacesWithRecords.has(workspace.name) &&
					!existsSync(getWorkspaceWorktreesDir(this.services.agentDir, workspace.path))
				) {
					continue;
				}
				try {
					await this.worktrees.prune(workspace, { signal });
				} catch (error) {
					if (signal.aborted) return;
					this.log("warn", "worktree prune failed on start", {
						workspace: workspace.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} catch {
			// Startup prune is best-effort; a manual `volt remote worktree prune` covers it.
		}
	}

	private getResponseContext(): RemoteHostResponseContext {
		return {
			hostNodeId: this.hostNodeId,
			relayMode: this.relayMode,
			...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
		};
	}

	private isAuthorizationCurrent(authorization: IrohRemoteClientAuthorizationSuccess): Promise<boolean> {
		return this.stateManager.isAuthorizationCurrent(authorization);
	}

	private async assertAgentLaunchAuthorityCurrent(authorization: IrohRemoteClientAuthorizationSuccess): Promise<void> {
		if (!this.admission.isOpen) {
			throw new AgentLaunchHostShutdownError();
		}
		if (!(await this.isAuthorizationCurrent(authorization))) {
			throw new AgentLaunchAuthorizationChangedError();
		}
		if (!this.admission.isOpen) {
			throw new AgentLaunchHostShutdownError();
		}
	}

	private getCommandContext(conversation?: {
		workspaceName: string;
		workspacePath?: string;
		entry: IntegratedRuntimeEntry;
		streamEntry?: IrohRemoteActiveStreamEntry;
		onWorkspaceUnregistered?: () => void;
	}): ConversationCommandContext {
		return {
			agentDir: this.services.agentDir,
			auditLogger: this.services.auditLogger,
			hostEngine: this.engine,
			stateManager: this.stateManager,
			sessionListCursors: this.sessionListCursors,
			sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
			...(conversation === undefined
				? {}
				: {
						getConversationBranchEpoch: () => conversation.entry.runtime.conversationProjectionFeed.branchEpoch,
						isConversationTranscriptCursorValid: (cursor: string) =>
							conversation.entry.runtime.conversationProjectionFeed.isTranscriptCursorValid(cursor),
						registerConversationTranscriptCursor: (cursor: string | null) =>
							conversation.entry.runtime.conversationProjectionFeed.registerTranscriptCursor(cursor),
					}),
			listRuntimeStates: (workspaceName) => {
				const states = new Map<string, Exclude<LeaseState, "unowned">>();
				for (const record of this.leaseBroker.list()) {
					if (record.workspaceName === workspaceName && record.state !== "unowned") {
						states.set(record.sessionId, record.state);
					}
				}
				return states;
			},
			keepAwake: this.services.keepAwake,
			onKeepAwakeSetting: (enabled) => this.services.state.updateSettings({ keepAwakeEnabled: enabled }),
			webSearchKey: this.services.webSearchKey,
			createWorktreeBackend: (workspace) => this.createWorktreeRpcBackend(workspace),
			onWorkspaceUnregistered: async (workspaceName) => {
				// Unregistering the conversation's own workspace keeps the requesting
				// stream and runtime alive so the response can still be delivered
				// (mirrors the workspace-management stream path).
				const excludeOwn = conversation !== undefined && workspaceName === conversation.workspaceName;
				const workspacePath = excludeOwn ? conversation.workspacePath : undefined;
				await this.cleanupUnregisteredWorkspace(
					workspaceName,
					excludeOwn
						? { streamEntry: conversation.streamEntry, runtimeEntry: conversation.entry, workspacePath }
						: {},
				);
				if (excludeOwn) {
					conversation.onWorkspaceUnregistered?.();
				}
			},
			...(conversation === undefined
				? {}
				: {
						isTurnAdmissionClosed: () => !this.admission.isOpen,
						isDraining: () =>
							this.leaseBroker.isDraining(conversation.workspaceName, conversation.entry.sessionId),
						isSubagentSession: () =>
							conversation.entry.subagentId !== undefined || conversation.entry.parentSessionId !== undefined,
					}),
		};
	}

	start(): void {
		if (this.startupTask !== undefined) return;
		this.startupTask = this.runStart();
	}

	private trackNativeLifecycleTask(task: Promise<unknown>): void {
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		this.nativeLifecycleTasks.add(settled);
		void settled.then(() => this.nativeLifecycleTasks.delete(settled));
	}

	private retireEndpoint(endpoint: IrohEndpointLike, context: string): Promise<void> {
		if (this.startupEndpoint === endpoint) {
			this.startupEndpoint = undefined;
		}
		const existing = this.endpointDisposalTasks.get(endpoint);
		if (existing !== undefined) {
			return existing;
		}
		const closeTask = Promise.resolve()
			.then(() => endpoint.close())
			.catch((error: unknown) => {
				this.log("warn", `${context}: ${error instanceof Error ? error.message : String(error)}`);
			});
		this.endpointDisposalTasks.set(endpoint, closeTask);
		this.trackNativeLifecycleTask(closeTask);
		return closeTask;
	}

	private retireLateBoundEndpoint(bindTask: Promise<IrohEndpointLike>): void {
		const cleanupTask = bindTask.then(
			(endpoint) => this.retireEndpoint(endpoint, "late iroh endpoint disposal failed"),
			() => undefined,
		);
		this.trackNativeLifecycleTask(cleanupTask);
	}

	private async runStart(): Promise<void> {
		let endpoint: IrohEndpointLike | undefined;
		const startupAdmission = this.admission.tryAcquire();
		if (!startupAdmission) {
			this.ready.reject(new Error("iroh service shut down before endpoint startup"));
			return;
		}
		let startupAdmissionReleased = false;
		const releaseStartupAdmission = () => {
			if (startupAdmissionReleased) return;
			startupAdmissionReleased = true;
			startupAdmission.release();
		};
		if (this.relayConfigWarning !== undefined) {
			this.log("warn", this.relayConfigWarning);
		}
		try {
			// Reconcile worktree records/checkouts before the endpoint starts taking
			// conversations. The startup admission lease keeps every state mutation
			// inside the durable quiesce barrier, while its abort signal cancels git.
			await this.reconcileAgentLaunchesOnStart(startupAdmission.signal);
			await this.pruneWorktreesOnStart(startupAdmission.signal);
			if (!startupAdmission.isCurrent()) {
				this.ready.reject(new Error("iroh service shut down before endpoint startup"));
				return;
			}
			const builder = this.iroh.Endpoint.builder();
			if (this.relayMode === "development") {
				this.log(
					"warn",
					"using public n0 relays (development only; unset VOLT_IROH_RELAY_MODE for the Volt relays)",
				);
				this.iroh.presetN0(builder);
			} else if (this.relayMode === "production") {
				if (this.relayUrls.length === 0) {
					throw new Error("relayMode production requires relay URLs (config.relayUrls or VOLT_IROH_RELAY_URLS)");
				}
				this.iroh.presetN0DisableRelay(builder);
				if (this.relayAuthToken !== undefined) {
					const relayMap = this.iroh.RelayMap.empty();
					for (const url of this.relayUrls) {
						relayMap.insert({ url, authToken: this.relayAuthToken });
					}
					builder.relayMode(this.iroh.RelayMode.custom(relayMap));
				} else {
					builder.relayMode(this.iroh.RelayMode.customFromUrls(this.relayUrls));
				}
			} else {
				this.iroh.presetMinimal(builder);
				builder.relayMode(this.iroh.RelayMode.disabled());
			}
			const secretKey = this.services.state.state.irohSecretKey;
			if (secretKey) {
				builder.secretKey(secretKey);
			}
			builder.alpns([Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"))]);
			const bindTask = builder.bind();
			endpoint = await waitUntilAdmissionCancelled(bindTask, startupAdmission.signal);
			if (!endpoint) {
				this.retireLateBoundEndpoint(bindTask);
				this.ready.reject(new Error("iroh service shut down during endpoint bind"));
				return;
			}
			endpoint = this.dependencies.decorateEndpoint?.(endpoint) ?? endpoint;
			this.startupEndpoint = endpoint;
			if (!startupAdmission.isCurrent()) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after cancelled bind failed");
				endpoint = undefined;
				this.ready.reject(new Error("iroh service shut down during endpoint startup"));
				return;
			}
			if (!secretKey) {
				const boundKey = endpoint.secretKey().toBytes();
				this.services.state.setHostState({
					...this.services.state.getHostState(),
					hostSecretKey: boundKey,
				});
				// Persist the freshly minted identity synchronously before the accept
				// loop starts taking pairings. A crash/SIGKILL inside the 250ms debounce
				// window would otherwise lose the key, and every phone paired against
				// this endpoint would be talking to a node id the daemon can never
				// reproduce on restart.
				await this.services.state.flush();
				if (!startupAdmission.isCurrent()) {
					this.retireEndpoint(endpoint, "iroh endpoint disposal after identity persistence failed");
					endpoint = undefined;
					this.ready.reject(new Error("iroh service shut down during identity persistence"));
					return;
				}
			}
			// Everything after this boundary is native/publication work. Quiesce may
			// now close core state without waiting for bind/online transport tails;
			// dispose owns and bounds those tasks instead.
			releaseStartupAdmission();
			if (this.relayMode !== "disabled") {
				const onlineTask = Promise.resolve(endpoint.online());
				this.trackNativeLifecycleTask(onlineTask);
				const online = await waitUntilAdmissionCancelled(
					onlineTask.then(() => true),
					startupAdmission.signal,
				);
				if (online !== true) {
					this.retireEndpoint(endpoint, "iroh endpoint disposal after cancelled online failed");
					endpoint = undefined;
					this.ready.reject(new Error("iroh service shut down while endpoint was coming online"));
					return;
				}
			}
			if (!this.admission.isOpen) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after startup cancellation failed");
				endpoint = undefined;
				this.ready.reject(new Error("iroh service shut down during endpoint startup"));
				return;
			}
			const hostNodeId = endpoint.id().toString();
			const endpointTicket = this.iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
			const engine = new IrohRemoteHostEngine({
				auditLogger: this.services.auditLogger,
				classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
				hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				stateManager: this.stateManager,
				validateWorkspace: async (workspace) =>
					(await getIrohRemoteWorkspaceAvailabilityStatus(workspace)) === "available",
				workspace: { name: "voltd", path: this.services.agentDir },
			});
			this.endpoint = endpoint;
			this.startupEndpoint = undefined;
			this.hostNodeId = hostNodeId;
			this.endpointTicket = endpointTicket;
			this.engine = engine;
			this.ready.resolve();
			this.log("info", `iroh endpoint online`, {
				hostNodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
			});
			this.acceptLoopTask = this.acceptLoop(endpoint).catch((error) => {
				this.log("error", `accept loop failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			endpoint = undefined;
		} catch (error) {
			if (endpoint) {
				this.retireEndpoint(endpoint, "iroh endpoint disposal after startup failure failed");
			}
			this.ready.reject(error);
			this.log("error", `failed to start iroh endpoint: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			releaseStartupAdmission();
		}
	}

	private async acceptLoop(endpoint: IrohEndpointLike): Promise<void> {
		while (this.admission.isOpen) {
			let incoming: Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>;
			try {
				incoming = await endpoint.acceptNext();
			} catch (error) {
				if (!this.admission.isOpen) {
					break;
				}
				this.log("error", `accept failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!incoming) {
				break;
			}
			// Acquire once for the accepted incoming before branching. This is the
			// exact publication fence for both rejection work and handleConnection;
			// quiesce either observes this lease or wins before it can be acquired.
			const admission = this.admission.tryAcquire();
			if (!admission) {
				try {
					const refusalTask = Promise.resolve(incoming.refuse());
					this.trackNativeLifecycleTask(refusalTask);
				} catch {}
				break;
			}
			const connectionAdmission = this.resourceGuard.tryAcquireConnectionTask();
			if (!connectionAdmission.ok) {
				try {
					let refused = true;
					try {
						await runLifecycleFencedPhysicalOperation(
							() => incoming.refuse(),
							admission.signal,
							(task) => this.trackNativeLifecycleTask(task),
						);
					} catch (error) {
						if (isIrohStreamLifecycleClosedError(error)) {
							continue;
						}
						refused = false;
					}
					if (!admission.isCurrent()) {
						continue;
					}
					await this.logAudit({
						type: "iroh_security_connection_limit",
						success: false,
						error: "incoming connection refused at daemon connection-task limit",
						details: {
							limit: connectionAdmission.limit,
							refused,
							scope: connectionAdmission.scope,
						},
					});
				} finally {
					admission.release();
				}
				continue;
			}
			// Ownership of the per-incoming admission lease transfers to the
			// connection task; its single release path lives in handleConnection.
			const task = this.handleConnection(incoming, admission)
				.catch((error) => {
					if (!isExpectedApplicationClose(error)) {
						this.log(
							"error",
							`connection error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
						);
					}
				})
				.finally(() => {
					this.connectionTasks.delete(task);
					connectionAdmission.lease.release();
				});
			this.connectionTasks.add(task);
		}
	}

	private async handleConnection(
		incoming: NonNullable<Awaited<ReturnType<IrohEndpointLike["acceptNext"]>>>,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		let admissionReleased = false;
		const releaseAdmission = () => {
			if (admissionReleased) return;
			admissionReleased = true;
			admission.release();
		};
		let connection: IrohConnectionLike;
		let supervisor: IrohConnectionSupervisor;
		let remoteId: string;
		let connectionId: string;
		let unauthenticatedAdmission: Extract<
			ReturnType<IrohRemoteResourceGuard["tryAcquireUnauthenticatedConnection"]>,
			{ ok: true }
		>;
		try {
			try {
				const accepting = await runLifecycleFencedPhysicalOperation(
					() => incoming.accept(),
					admission.signal,
					(task) => this.trackNativeLifecycleTask(task),
				);
				connection = await runLifecycleFencedPhysicalOperation(
					() => accepting.connect(),
					admission.signal,
					(task) => this.trackNativeLifecycleTask(task),
				);
			} catch (error) {
				if (!isIrohStreamLifecycleClosedError(error) && admission.isCurrent()) {
					await this.logAudit({
						type: "iroh_security_transport_rejected",
						success: false,
						error: "incoming transport handshake failed",
						details: { phase: "transport_connect" },
					});
				}
				return;
			}
			// A transport handshake can complete in the same event-loop turn as
			// quiesce. Close it without publishing application ownership; endpoint
			// disposal owns any remaining native transport tail.
			if (!admission.isCurrent()) {
				try {
					connection.close(0n, Array.from(Buffer.from("host_shutdown", "utf8")));
				} catch {}
				return;
			}
			supervisor = new IrohConnectionSupervisor(connection);
			try {
				connection.setMaxConcurrentBiStreams(BigInt(MAX_CONCURRENT_STREAMS_PER_CONNECTION));
			} catch {
				supervisor.requestClose("stream_limit_configuration_failed", "immediate");
				await this.logAudit({
					type: "iroh_security_transport_rejected",
					success: false,
					error: "connected transport could not enforce the inbound stream limit",
					details: { phase: "stream_limit_configuration" },
				});
				releaseAdmission();
				await supervisor.finalize("stream_limit_configuration_failed");
				return;
			}
			try {
				remoteId = connection.remoteId().toString();
			} catch {
				supervisor.requestClose("invalid_remote_identity", "immediate");
				await this.logAudit({
					type: "iroh_security_transport_rejected",
					success: false,
					error: "connected transport did not expose a valid remote identity",
					details: { phase: "remote_identity" },
				});
				releaseAdmission();
				await supervisor.finalize("invalid_remote_identity");
				return;
			}
			const nodeConnectionAdmission = this.resourceGuard.tryAcquireNodeConnection(remoteId);
			if (!nodeConnectionAdmission.ok) {
				supervisor.requestClose("node_connection_limit", "immediate");
				await this.logAudit({
					type: "iroh_security_connection_limit",
					clientNodeId: remoteId,
					success: false,
					error: "connection refused at per-node connection limit",
					details: { limit: nodeConnectionAdmission.limit, scope: nodeConnectionAdmission.scope },
				});
				releaseAdmission();
				await supervisor.finalize("node_connection_limit");
				return;
			}
			supervisor.addTerminalFinalizer(() => nodeConnectionAdmission.lease.release());
			const provisionalUnauthenticatedAdmission = this.resourceGuard.tryAcquireUnauthenticatedConnection(remoteId);
			if (!provisionalUnauthenticatedAdmission.ok) {
				supervisor.requestClose("unauthenticated_connection_limit", "immediate");
				await this.logAudit({
					type: "iroh_security_unauthenticated_connection_limit",
					clientNodeId: remoteId,
					success: false,
					error: "unauthenticated connection refused at admission limit",
					details: {
						limit: provisionalUnauthenticatedAdmission.limit,
						scope: provisionalUnauthenticatedAdmission.scope,
					},
				});
				releaseAdmission();
				await supervisor.finalize("unauthenticated_connection_limit");
				return;
			}
			unauthenticatedAdmission = provisionalUnauthenticatedAdmission;
			supervisor.addTerminalFinalizer(() => provisionalUnauthenticatedAdmission.lease.release());
			connectionId = `conn-${++activeConnectionSequence}`;
			this.registerClientConnection(remoteId, connectionId, supervisor);
			releaseAdmission();
		} finally {
			releaseAdmission();
		}
		let acceptedStreamCount = 0;
		let authenticated = false;
		const unauthenticatedTimer = setTimeout(() => {
			if (authenticated || supervisor.isClosing) return;
			supervisor.requestClose("handshake_timeout", "immediate");
			void this.logAudit({
				type: "iroh_security_handshake_timeout",
				clientNodeId: remoteId,
				success: false,
				error: "connection did not authenticate before the handshake deadline",
				details: { connectionId, timeoutMs: IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS },
			});
		}, IROH_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS);
		unauthenticatedTimer.unref?.();

		const markAuthenticated = async (): Promise<boolean> => {
			if (authenticated) return true;
			if (supervisor.isClosing) return false;
			authenticated = true;
			clearTimeout(unauthenticatedTimer);
			unauthenticatedAdmission.lease.release();
			this.log("info", `client connection opened: ${remoteId} (${connectionId})`);
			await this.logAudit({
				type: "client_connected",
				clientNodeId: remoteId,
				success: true,
				details: { connectionId },
			});
			return true;
		};

		try {
			while (!supervisor.isClosing) {
				const stream = await (!authenticated
					? withTimeout(connection.acceptBi(), DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS, "handshake timed out")
					: connection.acceptBi());
				acceptedStreamCount++;
				if (!this.admission.isOpen) {
					closeIrohRemoteStream(stream, "host_shutdown");
					supervisor.requestClose("host_shutdown", "immediate");
					break;
				}
				if (supervisor.childTaskCount >= MAX_CONCURRENT_STREAMS_PER_CONNECTION) {
					// One connection is holding too many concurrent streams open. Refuse
					// further work and close the connection rather than let
					// it exhaust daemon resources; the just-accepted stream is torn down
					// with the connection. A legitimate client never reaches this.
					supervisor.requestClose("stream_limit_exceeded", "immediate");
					await this.logAudit({
						type: "iroh_security_stream_limit",
						clientNodeId: remoteId,
						success: false,
						error: "connection exceeded concurrent stream limit",
						details: { connectionId, limit: MAX_CONCURRENT_STREAMS_PER_CONNECTION, scope: "connection" },
					});
					break;
				}
				const streamAdmission = this.resourceGuard.tryAcquireActiveStream(remoteId);
				if (!streamAdmission.ok) {
					closeIrohRemoteStream(stream, "stream_limit_exceeded");
					await this.logAudit({
						type: "iroh_security_stream_limit",
						clientNodeId: remoteId,
						success: false,
						error: "stream refused at daemon active-stream limit",
						details: { connectionId, limit: streamAdmission.limit, scope: streamAdmission.scope },
					});
					supervisor.requestClose("done", "when_idle");
					continue;
				}
				const streamId = `stream-${++activeStreamSequence}`;
				const task = this.runOwnedConnectionStream(stream, remoteId, connectionId, streamId, markAuthenticated)
					.catch(async (error) => {
						if (
							this.admission.isOpen &&
							!isIrohStreamLifecycleClosedError(error) &&
							!isExpectedApplicationClose(error)
						) {
							if (authenticated) {
								this.log(
									"error",
									`stream error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
								);
							} else {
								await this.logAudit({
									type: "iroh_security_transport_rejected",
									clientNodeId: remoteId,
									success: false,
									error: "unauthenticated stream failed",
									details: { connectionId, phase: "stream_handshake" },
								});
							}
						}
					})
					.finally(() => {
						streamAdmission.lease.release();
					});
				supervisor.trackChild(task);
			}
		} catch (error) {
			if (acceptedStreamCount === 0 && authenticated) {
				throw error;
			}
			if (acceptedStreamCount === 0 && !supervisor.isClosing) {
				await this.logAudit({
					type: "iroh_security_handshake_timeout",
					clientNodeId: remoteId,
					success: false,
					error: "connection closed or timed out before opening a handshake stream",
					details: { connectionId, timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS },
				});
			}
		} finally {
			clearTimeout(unauthenticatedTimer);
			await this.closeActiveStreamsForConnection(connectionId, "connection_closed");
			await supervisor.finalize("done");
			if (authenticated && this.admission.isOpen) {
				this.log("info", `client connection closed: ${remoteId} (${connectionId})`);
				await this.logAudit({
					type: "client_disconnected",
					clientNodeId: remoteId,
					success: true,
					details: { connectionId },
				});
			}
		}
	}

	private async runOwnedConnectionStream(
		rawStream: IrohBiStreamLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		markAuthenticated: () => Promise<boolean>,
	): Promise<void> {
		const decoratedStream = this.dependencies.decorateAcceptedStream?.(rawStream) ?? rawStream;
		let stream: IrohBiStreamLike | undefined;
		const owner = new IrohPhysicalStreamOwner(
			(reason) => closeIrohRemoteStream(stream ?? decoratedStream, reason),
			decoratedStream,
		);
		stream = createLifecycleFencedIrohStream(decoratedStream, owner.signal, (task) =>
			this.trackNativeLifecycleTask(task),
		);
		this.physicalStreamOwners.set(streamId, owner);
		try {
			await this.handleConnectionStream(stream, remoteId, connectionId, streamId, markAuthenticated, owner);
		} finally {
			try {
				await owner.close("stream_task_settled").catch(() => {});
			} finally {
				if (this.physicalStreamOwners.get(streamId) === owner) {
					this.physicalStreamOwners.delete(streamId);
				}
			}
		}
	}

	private async handleConnectionStream(
		stream: IrohBiStreamLike,
		remoteId: string,
		connectionId: string,
		streamId: string,
		markAuthenticated: () => Promise<boolean>,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		const engine = this.requireEngine();
		const handshakeAdmission = this.resourceGuard.tryAcquireHandshake(remoteId);
		if (!handshakeAdmission.ok) {
			await owner.close("handshake_limit_exceeded").catch(() => {});
			await this.logAudit({
				type: "iroh_security_handshake_limit",
				clientNodeId: remoteId,
				success: false,
				error: "stream refused at concurrent handshake limit",
				details: { connectionId, limit: handshakeAdmission.limit, scope: handshakeAdmission.scope },
			});
			return;
		}
		let handshake: IrohRemoteHostHandshakeResult;
		try {
			handshake = await engine.readHandshake(stream.recv, remoteId, {
				child: "volt",
				isCancelled: () => owner.signal.aborted,
				maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
				timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			});
		} finally {
			handshakeAdmission.lease.release();
		}
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		if (!handshake.ok) {
			if (
				handshake.response.outcome === "workspace_authorization_removed" &&
				typeof handshake.response.workspace === "string"
			) {
				await this.closeWorkspaceAuthorizationRemovedStreams(remoteId, handshake.response.workspace);
			}
			await this.writeTerminalHandshakeResponse(stream, handshake.response);
			return;
		}
		if (!(await markAuthenticated())) {
			await owner.close("handshake_timeout").catch(() => {});
			return;
		}
		if (!this.admission.isOpen) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}

		const streamCapability = getIrohRemoteStreamCapability({
			mode: handshake.hello.mode,
			...(handshake.hello.mode === "workspaceManagement"
				? { purpose: handshake.hello.workspaceManagement.purpose }
				: {}),
		});
		if (
			streamCapability !== undefined &&
			!hasIrohRemoteRpcCapability(
				parseIrohRemoteRpcGrant(handshake.authorization.client.rpcGrant, "client rpcGrant"),
				streamCapability,
			)
		) {
			await this.writeTerminalHandshakeResponse(
				stream,
				createIrohRemoteHandshakeFailure(`rpc_capability_denied: ${streamCapability}`, {
					hostNodeId: this.hostNodeId,
					workspace: handshake.authorization.workspace.name,
				}),
			);
			return;
		}

		this.notifyPairingConsumed(handshake, remoteId);

		if (handshake.authorization.paired) {
			this.log("info", `paired client stream: ${handshake.authorization.client.label} (${remoteId}, ${streamId})`);
		}

		if (handshake.hello.mode === "workspaceDiscovery") {
			await this.runWorkspaceDiscovery(stream, handshake, connectionId, streamId, owner);
			return;
		}
		if (handshake.hello.mode === "workspaceManagement") {
			if (handshake.hello.workspaceManagement.purpose === "manage_worktrees") {
				await this.runWorktreeManagement(stream, handshake, connectionId, streamId, owner);
				return;
			}
			if (handshake.hello.workspaceManagement.purpose === "manage_agents") {
				await this.runAgentLaunchManagement(stream, handshake, connectionId, streamId, owner);
				return;
			}
			await this.runWorkspaceManagement(stream, handshake, connectionId, streamId, owner);
			return;
		}
		await this.runIntegratedConversation(stream, handshake, connectionId, streamId, owner);
	}

	// ==========================================================================
	// Workspace streams
	// ==========================================================================

	private registerActiveStream(
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		stream: IrohBiStreamLike,
		owner: IrohPhysicalStreamOwner,
		connectionId: string,
		streamId: string,
		details: {
			/** Adopt this physical stream into the stable conversation authority. */
			coordinator?: ConversationCoordinator;
			terminalSessionId?: string | undefined;
			sanitizerOverrides?: RemoteSanitizerOverrides;
			/** Settles after the owning stream task has detached its runtime subscriber. */
			lifecycleSettled?: Promise<void>;
		} = {},
	): { entry: IrohRemoteActiveStreamEntry; remove: () => void } {
		const entry: IrohRemoteActiveStreamEntry = {
			clientNodeId: authorization.client.nodeId,
			connectionId,
			sessionId,
			streamId,
			workspaceName: authorization.workspace.name,
			close: (reason: string) => owner.close(reason),
			write: (value: object) =>
				writeIrohRemoteJsonLine(stream.send, value, authorization, details.sanitizerOverrides ?? {}),
		};
		const installed = owner.installCloseAction((reason) =>
			this.closeStreamWithTerminal(stream, reason, {
				authorization,
				sessionId: Object.hasOwn(details, "terminalSessionId") ? details.terminalSessionId : entry.sessionId,
				write: (value) => entry.write?.(value),
				terminate: () => entry.terminate?.(),
				lifecycleSettled: details.lifecycleSettled,
			}),
		);
		if (!installed) {
			throw new Error("physical stream closed before active ownership was installed");
		}
		if (details.coordinator) {
			if (this.physicalStreamOwners.get(streamId) === owner) {
				this.physicalStreamOwners.delete(streamId);
			}
			const releaseConversationTransport = details.coordinator.registerTransport({
				id: streamId,
				kind: "direct",
				clientNodeId: authorization.client.nodeId,
				connectionId,
				close: (reason) => owner.close(reason),
			});
			void owner.settled.then(releaseConversationTransport, releaseConversationTransport);
		}
		const removeActiveStream = this.activeStreams.register(entry);
		let removed = false;
		return {
			entry,
			remove: () => {
				if (removed) return;
				removed = true;
				removeActiveStream();
			},
		};
	}

	// ==========================================================================
	// iOS theme token push (§9.5) — flag off by default, capability gated
	// ==========================================================================

	private isThemeTokenPushEnabled(): boolean {
		return this.services.state.state.settings.themeTokenPush === true || process.env.VOLT_HOST_THEME_TOKENS === "1";
	}

	/** Send the current sanitized theme tokens to one capable stream. */
	private pushThemeTokensToStream(entry: IrohRemoteActiveStreamEntry): void {
		if (!this.isThemeTokenPushEnabled() || !entry.capabilities?.has(HOST_THEME_TOKENS_FEATURE)) {
			return;
		}
		const frame = createHostThemeTokensFrame(getCurrentThemeName() ?? "dark", getResolvedThemeColors());
		void Promise.resolve(entry.write?.(frame)).catch(() => {});
	}

	/** Theme changed: fan the new tokens out to every capable phone stream. */
	onThemeChanged(): void {
		if (!this.isThemeTokenPushEnabled()) {
			return;
		}
		for (const entry of this.activeStreams.allEntries()) {
			this.pushThemeTokensToStream(entry);
		}
	}

	/**
	 * Keep-awake status changed (control toggle, phone toggle, or degradation):
	 * fan the new state to every phone stream. Clients that ignore the frame are
	 * fully supported, so no capability gating.
	 */
	onKeepAwakeChanged(): void {
		const frame = {
			type: "keep_awake_changed",
			data: { keepAwake: toRpcKeepAwakeStatus(this.services.keepAwake.status) },
		};
		for (const entry of this.activeStreams.allEntries()) {
			void Promise.resolve(entry.write?.(frame)).catch(() => {});
		}
	}

	private async closeStreamWithTerminal(
		stream: IrohBiStreamLike,
		reason: string,
		terminal: {
			authorization: IrohRemoteClientAuthorizationSuccess;
			sessionId: string | undefined;
			write(value: object): Promise<void> | void | undefined;
			terminate(): Promise<void> | undefined;
			lifecycleSettled?: Promise<void>;
		},
	): Promise<void> {
		// Revocation/access tightening invalidates the old projection policy. Do
		// not drain its already-authorized queue merely to deliver a courtesy frame;
		// close the physical stream immediately and force a fresh handshake.
		if (isAuthorityTighteningCloseReason(reason)) {
			const termination = terminal.terminate();
			if (termination) await termination.catch(() => {});
			else closeIrohRemoteStream(stream, reason);
			await terminal.lifecycleSettled?.catch(() => {});
			return;
		}
		const terminalReason = getRemoteTerminalReason(reason);
		if (terminalReason) {
			try {
				const delivery = terminal.write({
					type: "remote_terminal",
					reason: terminalReason,
					workspace: terminal.authorization.workspace.name,
					...(terminal.sessionId === undefined ? {} : { sessionId: terminal.sessionId }),
					hostNodeId: this.hostNodeId,
				});
				if (delivery) void Promise.resolve(delivery).catch(() => {});
			} catch {}
		}
		const termination = terminal.terminate();
		if (termination) await termination.catch(() => {});
		else closeIrohRemoteStream(stream, reason);
		await terminal.lifecycleSettled?.catch(() => {});
	}

	private async runWorkspaceDiscovery(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		await this.dependencies.beforeAuthorizedStreamPublication?.("workspace_discovery", handshake.authorization);
		if (!this.admission.isOpen || !(await this.isAuthorizationCurrent(handshake.authorization))) {
			await owner.close("access_updated_during_attach").catch(() => {});
			return;
		}
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_DISCOVERY_STREAM_SESSION_ID,
			stream,
			owner,
			connectionId,
			streamId,
			{ terminalSessionId: undefined },
		);
		try {
			await runWorkspaceDiscoveryStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationCurrent(handshake.authorization),
					closeStream: (reason) => {
						void owner.close(reason ?? "stream_closed").catch(() => {});
					},
				},
				{ commandContext: this.getCommandContext() },
			);
		} finally {
			activeStream.remove();
		}
	}

	private async runWorkspaceManagement(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		await this.dependencies.beforeAuthorizedStreamPublication?.("workspace_management", handshake.authorization);
		if (!this.admission.isOpen || !(await this.isAuthorizationCurrent(handshake.authorization))) {
			await owner.close("access_updated_during_attach").catch(() => {});
			return;
		}
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			owner,
			connectionId,
			streamId,
			{ terminalSessionId: undefined },
		);
		try {
			await runWorkspaceManagementStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationCurrent(handshake.authorization),
					closeStream: (reason) => {
						activeStream.remove();
						void owner.close(reason ?? "stream_closed").catch(() => {});
					},
				},
				{
					auditLogger: this.services.auditLogger,
					commandContext: this.getCommandContext(),
					unregisterWorkspace: async (workspaceName) => {
						let removedWorkspace: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
						try {
							removedWorkspace = await this.stateManager.unregisterWorkspace(workspaceName);
						} catch (error) {
							if (!isIrohRemoteWorkspaceHasWorktreesError(error)) {
								throw error;
							}
							return {
								ok: false,
								error: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
								details: {
									worktreeCount: error.worktreeIds.length,
									worktreeIds: error.worktreeIds,
								},
							};
						}
						if (!removedWorkspace) {
							return { ok: false, error: "workspace_unregistered" };
						}
						this.engine?.clearPairingSecretForWorkspace(workspaceName);
						const { closedStreamCount, stoppedRuntimeCount } = await this.cleanupUnregisteredWorkspace(
							workspaceName,
							{ streamEntry: activeStream.entry, workspacePath: removedWorkspace.path },
						);
						return { ok: true, closedStreamCount, stoppedRuntimeCount };
					},
				},
			);
		} finally {
			activeStream.remove();
		}
	}

	/** Serve a manage_agents workspaceManagement stream (agent_launch.v1). */
	private async runAgentLaunchManagement(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		await this.dependencies.beforeAuthorizedStreamPublication?.("agent_management", handshake.authorization);
		if (!this.admission.isOpen || !(await this.isAuthorizationCurrent(handshake.authorization))) {
			await owner.close("access_updated_during_attach").catch(() => undefined);
			return;
		}
		const sanitizerOverrides: RemoteSanitizerOverrides = {
			additionalRedactedPaths: [getWorktreesRoot(this.services.agentDir)],
		};
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			owner,
			connectionId,
			streamId,
			{ terminalSessionId: undefined, sanitizerOverrides },
		);
		try {
			await runAgentLaunchManagementStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationCurrent(handshake.authorization),
					closeStream: (reason) => {
						void owner.close(reason ?? "stream_closed").catch(() => undefined);
					},
				},
				{
					auditLogger: this.services.auditLogger,
					agents: this.createAgentLaunchRpcBackend(handshake.authorization),
					additionalRedactedPaths: sanitizerOverrides.additionalRedactedPaths,
				},
			);
		} finally {
			activeStream.remove();
		}
	}

	private createAgentLaunchRpcBackend(
		authorization: IrohRemoteClientAuthorizationSuccess,
	): IrohRemoteAgentLaunchRpcBackend {
		const workspace = authorization.workspace;
		return {
			getAgentLaunchOptions: async () => this.getAgentLaunchOptions(workspace),
			createAgent: async (_workspaceName, request) => {
				const operationKey = `${authorization.client.nodeId}\u0000${workspace.name}\u0000${request.launchId}`;
				const requestDigest = digestIrohRemoteAgentLaunchRequest(workspace.name, request);
				const existing = this.agentLaunchOperations.get(operationKey);
				if (existing) {
					return existing.requestDigest === requestDigest
						? existing.promise
						: {
								kind: "error",
								error: {
									kind: "launch_conflict",
									message: "launch id is already being used by a different request",
								},
							};
				}
				const operation = this.createConfiguredDetachedAgent(authorization, request).finally(() => {
					if (this.agentLaunchOperations.get(operationKey)?.promise === operation) {
						this.agentLaunchOperations.delete(operationKey);
					}
				});
				this.agentLaunchOperations.set(operationKey, { requestDigest, promise: operation });
				return operation;
			},
		};
	}

	private async getAgentLaunchOptions(workspace: IrohRemoteWorkspace): Promise<IrohRemoteAgentLaunchOptions> {
		const projectTrusted = resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore });
		const settingsManager = SettingsManager.create(workspace.path, this.services.agentDir, {
			profile: this.profile,
			projectTrusted,
		});
		const services = await createAgentSessionServices({
			cwd: workspace.path,
			projectCwd: workspace.path,
			agentDir: this.services.agentDir,
			settingsManager,
			workspaceName: workspace.name,
		});
		return createIrohRemoteAgentLaunchOptions(workspace.name, services);
	}

	private async createConfiguredDetachedAgent(
		authorization: IrohRemoteClientAuthorizationSuccess,
		request: IrohRemoteCreateAgentRequest,
	): Promise<IrohRemoteAgentLaunchResult> {
		try {
			await this.assertAgentLaunchAuthorityCurrent(authorization);
		} catch (error) {
			return (
				getAgentLaunchBoundaryFailure(error) ?? {
					kind: "error",
					error: { kind: "internal_error", message: "agent launch could not be authorized" },
				}
			);
		}
		const workspace = authorization.workspace;
		const sessionId = createIrohRemoteAgentLaunchSessionId(
			authorization.client.nodeId,
			workspace.name,
			request.launchId,
		);
		const sessionDir = getDefaultSessionDir(workspace.path, this.services.agentDir);
		const requestDigest = digestIrohRemoteAgentLaunchRequest(workspace.name, request);
		const existingSession = await SessionManager.findForResume(sessionDir, sessionId);
		try {
			await this.assertAgentLaunchAuthorityCurrent(authorization);
		} catch (error) {
			return getAgentLaunchBoundaryFailure(error)!;
		}
		if (existingSession) {
			const manager = SessionManager.open(existingSession.path, sessionDir);
			const record = manager.getAgentLaunchRecord(request.launchId);
			if (record?.receipt.requestDigest !== requestDigest) {
				return {
					kind: "error",
					error: { kind: "launch_conflict", message: "launch id was already used by a different request" },
				};
			}
			if (record.commit) {
				return {
					kind: "existing",
					launchId: request.launchId,
					sessionId,
					placement: record.receipt.placement,
					config: record.receipt.config,
				};
			}
			if (!record) {
				return {
					kind: "error",
					error: { kind: "launch_conflict", message: "launch session has no matching durable receipt" },
				};
			}
			const cleanup = await cleanupIncompleteAgentLaunch({
				workspace,
				sessionId,
				sessionFile: existingSession.path,
				record,
				removeWorktree: (targetWorkspace, worktreeId) =>
					this.worktrees.remove(targetWorkspace, worktreeId, { force: true }),
				log: (message, details) => this.log("warn", message, details),
			});
			if (cleanup.kind === "cleanup_required") {
				return {
					kind: "error",
					error: {
						kind: "cleanup_required",
						message: "an interrupted launch worktree could not be removed",
						worktreeId: cleanup.worktreeId,
					},
				};
			}
		}

		let options: IrohRemoteAgentLaunchOptions;
		try {
			options = await this.getAgentLaunchOptions(workspace);
		} catch {
			return {
				kind: "error",
				error: { kind: "internal_error", message: "agent launch catalog is unavailable" },
			};
		}
		try {
			await this.assertAgentLaunchAuthorityCurrent(authorization);
		} catch (error) {
			return getAgentLaunchBoundaryFailure(error)!;
		}
		if (request.catalogRevision !== options.revision) {
			return {
				kind: "error",
				error: {
					kind: "stale_catalog",
					message: "agent launch catalog changed",
					currentRevision: options.revision,
				},
			};
		}
		const resolvedConfig = resolveIrohRemoteAgentLaunchConfig(options, request.config);
		if (!resolvedConfig.ok) return { kind: "error", error: resolvedConfig.error };
		const config: IrohRemoteAgentLaunchConfiguredConfig = resolvedConfig.config;

		let resolvedPlacement: IrohRemoteAgentLaunchResolvedPlacement;
		let worktree: IrohRemoteWorkspaceWorktree | undefined;
		try {
			if (request.placement.kind === "workspace") {
				resolvedPlacement = {
					kind: "workspace",
					...(request.placement.workingDirectory === undefined
						? {}
						: { workingDirectory: request.placement.workingDirectory }),
				};
			} else if (request.placement.kind === "existing_worktree") {
				worktree = await this.worktrees.findWorktree(workspace.name, request.placement.worktreeId);
				if (!worktree) {
					return {
						kind: "error",
						error: { kind: "placement_unavailable", message: "requested worktree is unavailable" },
					};
				}
				resolvedPlacement = {
					kind: "worktree",
					worktreeId: worktree.id,
					branch: worktree.branch,
					created: false,
					...(request.placement.workingDirectory === undefined
						? {}
						: { workingDirectory: request.placement.workingDirectory }),
				};
			} else {
				const worktreeId =
					request.placement.worktreeName ??
					`agent-${digestIrohRemoteAgentLaunchRequest(workspace.name, request).slice(0, 12)}`;
				const created = await this.worktrees.create(workspace, {
					id: worktreeId,
					...(request.placement.branch === undefined ? {} : { branch: request.placement.branch }),
					...(request.placement.baseRef === undefined ? {} : { baseRef: request.placement.baseRef }),
					...(request.placement.workingDirectory === undefined
						? {}
						: { workingDirectory: request.placement.workingDirectory }),
				});
				if (!created.ok) {
					return {
						kind: "error",
						error: { kind: "placement_unavailable", message: "worktree could not be created" },
					};
				}
				worktree = created.worktree;
				resolvedPlacement = {
					kind: "worktree",
					worktreeId: worktree.id,
					branch: worktree.branch,
					created: true,
					...(request.placement.workingDirectory === undefined
						? {}
						: { workingDirectory: request.placement.workingDirectory }),
				};
			}
		} catch {
			return {
				kind: "error",
				error: { kind: "placement_unavailable", message: "agent placement is unavailable" },
			};
		}

		const compensateCreatedWorktree = async (
			fallback: IrohRemoteAgentLaunchResult,
		): Promise<IrohRemoteAgentLaunchResult> => {
			if (resolvedPlacement.kind !== "worktree" || !resolvedPlacement.created) return fallback;
			const removed = await this.worktrees
				.remove(workspace, resolvedPlacement.worktreeId, { force: true })
				.catch(() => ({ ok: false as const, error: "cleanup_failed" }));
			if (removed.ok) return fallback;
			try {
				const cleanupMarker = SessionManager.create(worktree?.path ?? workspace.path, sessionDir, {
					id: sessionId,
				});
				cleanupMarker.appendAgentLaunchReceipt({
					launchId: request.launchId,
					requestDigest,
					request,
					placement: resolvedPlacement,
					config,
				});
				await cleanupMarker.flush();
			} catch {
				// The durable worktree record still prevents destructive unregister/prune.
			}
			return {
				kind: "error",
				error: {
					kind: "cleanup_required",
					message: "the launch failed and its worktree could not be removed",
					worktreeId: resolvedPlacement.worktreeId,
				},
			};
		};

		try {
			await this.assertAgentLaunchAuthorityCurrent(authorization);
		} catch (error) {
			return compensateCreatedWorktree(getAgentLaunchBoundaryFailure(error)!);
		}

		let directory: WorkspaceDirectoryResolution;
		try {
			directory = await this.resolveConversationWorkingDirectory({
				workspace,
				rootPath: worktree?.path ?? workspace.path,
				workingDirectory: request.placement.workingDirectory,
				...(worktree === undefined ? {} : { worktree }),
			});
		} catch {
			return compensateCreatedWorktree({
				kind: "error",
				error: { kind: "placement_unavailable", message: "agent working directory is unavailable" },
			});
		}
		try {
			await this.assertAgentLaunchAuthorityCurrent(authorization);
		} catch (error) {
			return compensateCreatedWorktree(getAgentLaunchBoundaryFailure(error)!);
		}
		const cwd = directory.absolutePath;
		const daemonAttachBegin = this.leaseBroker.beginDaemonAttach(workspace.name, sessionId);
		if (daemonAttachBegin.kind !== "proceed") {
			return compensateCreatedWorktree({
				kind: "error",
				error: { kind: "launch_conflict", message: "session ownership changed during launch" },
			});
		}
		const daemonAttachClaim = daemonAttachBegin.claim;
		let sessionManager: SessionManager | undefined;
		let runtimeEntry: IntegratedRuntimeEntry | undefined;
		let unregisteredRuntime: AgentSessionRuntime | undefined;
		let previousSessionId: string | undefined;
		let selectionPersisted = false;
		try {
			sessionManager = SessionManager.create(cwd, sessionDir, { id: sessionId });
			sessionManager.appendModelChange(config.model.provider, config.model.modelId);
			sessionManager.appendThinkingLevelChange(config.thinkingLevel);
			sessionManager.appendFastModeChange(config.fastModeEnabled);
			sessionManager.appendPlanningState({ ...clonePlanningState(DEFAULT_PLANNING_STATE), mode: config.agentMode });
			const receipt = sessionManager.appendAgentLaunchReceipt({
				launchId: request.launchId,
				requestDigest,
				request,
				placement: resolvedPlacement,
				config,
			});
			await sessionManager.flush();
			await this.assertAgentLaunchAuthorityCurrent(authorization);
			const resolvedSessionTarget = {
				sessionId,
				sessionFilePath: sessionManager.getSessionFile(),
				selection: "created" as const,
				workspaceName: workspace.name,
				workspacePath: workspace.path,
				sessionManager,
			};
			const projectTrusted = resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore: this.trustStore });
			const toolPolicy = resolveIrohRemoteRuntimeToolPolicy({
				clientAllowTools: authorization.allowTools,
				workspaceAllowTools: workspace.allowedTools,
				daemonAllowTools: this.services.state.state.settings.allowTools,
			});
			const created = await (
				this.dependencies.createAgentLaunchRuntime ?? createIrohRemoteAgentRuntimeWithSessionSelection
			)({
				cwd,
				projectCwd: worktree?.path ?? workspace.path,
				agentDir: this.services.agentDir,
				profile: this.profile,
				workspaceName: workspace.name,
				projectTrusted,
				toolPolicy,
				resolvedSessionTarget,
				launchConfig: {
					model: config.model,
					thinkingLevel: config.thinkingLevel,
					agentMode: config.agentMode,
				},
			});
			unregisteredRuntime = created.runtime;
			await this.assertAgentLaunchAuthorityCurrent(authorization);
			if (worktree) await this.worktrees.bindSession(workspace.name, worktree.id, sessionId);
			await this.assertAgentLaunchAuthorityCurrent(authorization);
			const runtimeForRegistration = unregisteredRuntime;
			runtimeEntry = await this.runtimes.registerDetachedRuntime({
				clientNodeId: authorization.client.nodeId,
				workspaceName: workspace.name,
				sessionId,
				runtime: runtimeForRegistration,
				toolPolicy,
				daemonAttachClaim,
				...(worktree === undefined ? {} : { worktree }),
				...(resolvedPlacement.workingDirectory === undefined
					? {}
					: { workingDirectory: resolvedPlacement.workingDirectory }),
				publicationFence: async () => {
					await this.dependencies.beforeAgentLaunchPublication?.();
					await this.assertAgentLaunchAuthorityCurrent(authorization);
				},
			});
			unregisteredRuntime = undefined;
			await this.assertAgentLaunchAuthorityCurrent(authorization);
			const selection = await this.requireEngine().setClientLastSessionIdIfAuthorizationCurrent(
				authorization,
				sessionId,
			);
			if (!selection.ok) {
				throw new AgentLaunchAuthorizationChangedError();
			}
			previousSessionId = selection.previousSessionId;
			selectionPersisted = true;
			if (!this.admission.isOpen) {
				throw new AgentLaunchHostShutdownError();
			}
			sessionManager.appendAgentLaunchCommit(receipt.id, request.launchId);
			await this.dependencies.beforeAgentLaunchCommitFlush?.();
			await sessionManager.flush();
			return { kind: "created", launchId: request.launchId, sessionId, placement: resolvedPlacement, config };
		} catch (error) {
			if (selectionPersisted) {
				await this.requireEngine()
					.restoreClientLastSessionIdIfCurrent(
						authorization.client.nodeId,
						workspace.name,
						sessionId,
						previousSessionId,
					)
					.catch((restoreError: unknown) => {
						this.log("warn", "failed to restore agent launch session selection", {
							workspace: workspace.name,
							launchId: request.launchId,
							sessionId,
							error: restoreError instanceof Error ? restoreError.message : String(restoreError),
						});
						return false;
					});
			}
			await unregisteredRuntime?.dispose().catch(() => undefined);
			if (runtimeEntry) {
				await this.runtimes.stopEntry(runtimeEntry, "agent_cold_launch_rollback").catch(() => undefined);
			} else {
				this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			}
			const sessionFile = sessionManager?.getSessionFile();
			const record = (() => {
				if (!sessionManager || !sessionFile) return undefined;
				try {
					return (
						SessionManager.open(sessionFile, sessionDir).getAgentLaunchRecord(request.launchId) ??
						sessionManager.getAgentLaunchRecord(request.launchId)
					);
				} catch {
					return sessionManager.getAgentLaunchRecord(request.launchId);
				}
			})();
			if (record && sessionFile) {
				try {
					const cleanup = await cleanupIncompleteAgentLaunch({
						workspace,
						sessionId,
						sessionFile,
						record,
						removeWorktree: (targetWorkspace, worktreeId) =>
							this.worktrees.remove(targetWorkspace, worktreeId, { force: true }),
						log: (message, details) => this.log("warn", message, details),
					});
					if (cleanup.kind === "cleanup_required") {
						return {
							kind: "error",
							error: {
								kind: "cleanup_required",
								message: "the launch failed and its worktree could not be removed",
								worktreeId: cleanup.worktreeId,
							},
						};
					}
				} catch {
					// The durable receipt remains available for retry/startup reconciliation.
				}
			}
			return (
				getAgentLaunchBoundaryFailure(error) ?? {
					kind: "error",
					error: { kind: "internal_error", message: "agent launch could not be completed" },
				}
			);
		}
	}

	/** Serve a manage_worktrees workspaceManagement stream (worktrees.v1). */
	private async runWorktreeManagement(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		await this.dependencies.beforeAuthorizedStreamPublication?.("worktree_management", handshake.authorization);
		if (!this.admission.isOpen || !(await this.isAuthorizationCurrent(handshake.authorization))) {
			await owner.close("access_updated_during_attach").catch(() => {});
			return;
		}
		const sanitizerOverrides: RemoteSanitizerOverrides = {
			additionalRedactedPaths: [getWorktreesRoot(this.services.agentDir)],
		};
		const activeStream = this.registerActiveStream(
			handshake.authorization,
			WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
			stream,
			owner,
			connectionId,
			streamId,
			{ terminalSessionId: undefined, sanitizerOverrides },
		);
		try {
			await runWorktreeManagementStream(
				{
					stream,
					initialInput: handshake.initialInput,
					authorization: handshake.authorization,
					isRpcGrantCurrent: () => this.isAuthorizationCurrent(handshake.authorization),
					closeStream: (reason) => {
						void owner.close(reason ?? "stream_closed").catch(() => {});
					},
				},
				{
					auditLogger: this.services.auditLogger,
					additionalRedactedPaths: sanitizerOverrides.additionalRedactedPaths,
					worktrees: this.createWorktreeRpcBackend(handshake.authorization.workspace),
				},
			);
		} finally {
			activeStream.remove();
		}
	}

	/** Backend for the worktree RPC helpers, bound to the stream's authorized workspace. */
	private createWorktreeRpcBackend(workspace: IrohRemoteWorkspace): IrohRemoteWorktreeRpcBackend {
		return {
			createWorktree: async (_workspaceName, options) => {
				const created = await this.worktrees.create(workspace, options);
				if (!created.ok) {
					return {
						ok: false,
						error: created.error,
						...(created.detail === undefined ? {} : { detail: created.detail }),
					};
				}
				return { ok: true, worktree: created.worktree };
			},
			listWorktrees: async () => ({ ok: true, worktrees: await this.worktrees.list(workspace) }),
			removeWorktree: async (_workspaceName, worktreeId, force) =>
				this.removeWorkspaceWorktree(workspace, worktreeId, force),
		};
	}

	/**
	 * Runtime-aware worktree removal: refuses busy worktrees without force; with
	 * force, closes bound phone streams and stops bound runtimes first.
	 */
	private async removeWorkspaceWorktree(
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
		force: boolean,
	): Promise<WorktreeResult<{ stoppedRuntimeCount: number; closedStreamCount: number }>> {
		const record = await this.worktrees.findWorktree(workspace.name, worktreeId);
		if (!record) {
			return { ok: false, error: "worktree_not_found" };
		}
		let stoppedRuntimeCount = 0;
		let closedStreamCount = 0;
		const boundEntries = record.sessionIds
			.map((sessionId) => this.runtimes.findOwner(workspace.name, sessionId))
			.filter((entry): entry is IntegratedRuntimeEntry => entry !== undefined);
		if (boundEntries.length > 0) {
			if (!force) {
				return { ok: false, error: "worktree_busy" };
			}
			for (const entry of boundEntries) {
				closedStreamCount += await this.stopRuntimeEntryAfterStreams(entry, "worktree_removed");
				stoppedRuntimeCount++;
			}
		}
		const removed = await this.worktrees.remove(workspace, worktreeId, { force });
		if (!removed.ok) {
			return removed;
		}
		return { ok: true, stoppedRuntimeCount, closedStreamCount };
	}

	/**
	 * Worktree resolution for conversation opens: explicit worktreeId on "new"
	 * (must exist AND be on disk), persisted binding on resume (missing checkout
	 * fails with session_unavailable). Availability is an open-time failure, not
	 * an authorization failure.
	 */
	private async resolveConversationWorktree(
		workspaceName: string,
		hello: IrohRemoteHello,
		targetSessionId: string | undefined,
	): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		if (hello.mode !== "conversation") {
			return undefined;
		}
		if (hello.conversation.target === "new") {
			const worktreeId = hello.conversation.worktreeId;
			if (worktreeId === undefined) {
				return undefined;
			}
			const worktree = await this.worktrees.findWorktree(workspaceName, worktreeId);
			if (!worktree || !existsSync(worktree.path)) {
				throw createConversationOpenError("invalid_conversation_target", "unknown or unavailable worktree", {
					workspace: workspaceName,
				});
			}
			return worktree;
		}
		if (targetSessionId === undefined) {
			return undefined;
		}
		const worktree = await this.worktrees.resolveSessionWorktree(workspaceName, targetSessionId);
		if (worktree === undefined) {
			return undefined;
		}
		if (!existsSync(worktree.path)) {
			throw createConversationOpenError("session_unavailable", "worktree checkout is unavailable", {
				workspace: workspaceName,
				sessionId: targetSessionId,
			});
		}
		return worktree;
	}

	private async resolveConversationWorkingDirectory(options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}): Promise<WorkspaceDirectoryResolution> {
		if (options.worktree === undefined) {
			const parentDirectory = await this.worktrees.validateWorkingDirectory(
				options.workspace,
				options.workingDirectory,
			);
			if (!parentDirectory.ok) {
				const message = parentDirectory.detail ?? parentDirectory.error;
				throw createConversationOpenError("invalid_conversation_target", message, {
					workspace: options.workspace.name,
				});
			}
			return parentDirectory.directory;
		}
		const worktreeDirectory = await this.worktrees.resolveWorktreeWorkingDirectory(
			options.workspace,
			options.worktree,
			options.workingDirectory,
		);
		if (!worktreeDirectory.ok) {
			throw createConversationOpenError(
				"invalid_conversation_target",
				worktreeDirectory.detail ?? worktreeDirectory.error,
				{
					workspace: options.workspace.name,
					worktreeId: options.worktree.id,
				},
			);
		}
		return worktreeDirectory.directory;
	}

	// ==========================================================================
	// Integrated conversation serving
	// ==========================================================================

	private createPushNotificationDispatcher(
		authorization: IrohRemoteClientAuthorizationSuccess,
	): IrohRemotePushNotificationDispatcher {
		return new IrohRemotePushNotificationDispatcher({
			auditLogger: this.services.auditLogger,
			clientNodeId: authorization.client.nodeId,
			deduper: this.pushNotificationDeduper,
			relayClient: this.pushRelayClient,
			stateManager: this.stateManager,
			workspace: authorization.workspace.name,
		});
	}

	private async revokeClientPushTargets(client: IrohRemoteClient | undefined): Promise<void> {
		if ((client?.pushTargets?.length ?? 0) === 0) return;
		try {
			const summary = await revokeIrohRemoteClientPushTargets(client, this.pushRelayClient);
			const complete = summary.failed === 0 && summary.skipped === 0;
			if (!complete) {
				this.log("warn", "remote push-target cleanup incomplete after client revoke", { ...summary });
			}
			await this.logAudit({
				type: "push_targets_revoked",
				clientNodeId: client?.nodeId,
				success: complete,
				error: complete ? undefined : "remote push-target cleanup incomplete; relay TTL remains the lifetime bound",
				details: { ...summary, remainingLifetimeBound: "relay_target_ttl" },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("warn", "remote push-target cleanup failed after client revoke", { error: message });
			await this.logAudit({
				type: "push_targets_revoked",
				clientNodeId: client?.nodeId,
				success: false,
				error: "remote push-target cleanup failed; relay TTL remains the lifetime bound",
				details: { remainingLifetimeBound: "relay_target_ttl" },
			});
		}
	}

	private async writeTerminalHandshakeResponse(
		stream: IrohBiStreamLike,
		response: IrohRemoteHandshakeResponse,
	): Promise<void> {
		try {
			await writeIrohRemoteHandshakeResponse(stream.send, response);
		} finally {
			await Promise.resolve(stream.send.finish?.()).catch(() => {});
			await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
		}
	}

	private async sendHandshakeError(stream: IrohBiStreamLike, error: unknown): Promise<void> {
		const record = (error ?? {}) as Record<string, unknown>;
		// Plain {message, ...} records (relay closure, lease re-check) must not
		// stringify to "[object Object]".
		const message =
			error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error);
		const outcome = typeof record.outcome === "string" ? record.outcome : undefined;
		const workspace = typeof record.workspace === "string" ? record.workspace : undefined;
		const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
		const retryAfterMs = typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined;
		await this.writeTerminalHandshakeResponse(
			stream,
			createIrohRemoteHandshakeFailure(message, {
				hostNodeId: this.hostNodeId,
				...(outcome === undefined ? {} : { outcome: outcome as never }),
				...(workspace === undefined ? {} : { workspace }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			}),
		);
	}

	private async rejectDuplicateActiveConnection(
		stream: IrohBiStreamLike,
		authorization: IrohRemoteClientAuthorizationSuccess,
		sessionId: string,
		source = "active_stream_registry",
	): Promise<void> {
		const error = "duplicate conversation connection";
		await this.logAudit({
			type: "duplicate_connection_rejected",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error,
			details: {
				retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
				sessionId,
				source,
			},
		});
		await this.writeTerminalHandshakeResponse(
			stream,
			createIrohRemoteHandshakeFailure(error, {
				hostNodeId: this.hostNodeId,
				outcome: "duplicate_conversation_connection",
				workspace: authorization.workspace.name,
				sessionId,
				retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
			}),
		);
	}

	private async closeReplacedActiveStreams(
		authorization: IrohRemoteClientAuthorizationSuccess,
		replacementStreamId: string,
		replacedEntries: IrohRemoteActiveStreamEntry[],
	): Promise<void> {
		if (replacedEntries.length === 0) {
			return;
		}
		const replacedStreamIds = replacedEntries.map((entry) => entry.streamId);
		await this.initiateActiveStreamRetirement(new Set(replacedEntries), ACTIVE_REPLACE_CLOSE_REASON);
		this.log(
			"info",
			`client stream replaced: ${authorization.client.nodeId}/${authorization.workspace.name} (${replacedStreamIds.join(", ")} -> ${replacementStreamId})`,
		);
		await this.logAudit({
			type: "duplicate_connection_replaced",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: true,
			details: {
				closeReason: ACTIVE_REPLACE_CLOSE_REASON,
				closedCount: replacedEntries.length,
				replacedStreamIds,
				replacementStreamId,
				source: "active_stream_registry",
			},
		});
	}

	/**
	 * Relay a phone conversation stream to the owning TUI (§5.6): the daemon
	 * has already authenticated the phone; the TUI serves the framed RPC from
	 * its in-process runtime over a dedicated relay unix connection.
	 */
	private async relayConversationToTui(
		stream: IrohBiStreamLike,
		physicalOwner: IrohPhysicalStreamOwner,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		targetSessionId: string,
		tuiConnectionId: string,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		const authorization = handshake.authorization;
		const workspaceName = authorization.workspace.name;
		if (!admission.isCurrent()) {
			return;
		}

		// Duplicate handling per clientNodeId + key: duplicates already on this
		// Iroh connection are real duplicates; entries on older connections are
		// stale for this conversation and may be replaced independently of any
		// sibling subagent streams that opened first on the new connection.
		const liveRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"active",
		);
		const pendingRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"offered",
		);
		if (
			liveRelays.some((relay) => relay.connectionId === connectionId) ||
			pendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of liveRelays) {
			void this.conversationCoordinators.get(workspaceName, targetSessionId)?.closeTransport(relay.relayId, "error");
		}
		// Unredeemed offers for the same conversation on older connections are
		// superseded by this one: fail their deferred handshakes and settle them
		// (relay_closed to the TUI, lease bookkeeping) instead of leaking tasks.
		for (const pending of pendingRelays) {
			void this.conversationCoordinators
				.get(workspaceName, targetSessionId)
				?.closeTransport(pending.relayId, "error");
		}

		// Resolve the concrete session target for the preamble (§3.7).
		const target: IrohRemoteSessionTarget =
			handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "session"
				? { kind: "session", sessionId: handshake.hello.conversation.sessionId }
				: { kind: "last", resumeSessionId: targetSessionId };
		// A worktree-bound session must resolve against the worktree cwd (the
		// parent-keyed session dir plus a non-matching cwd makes SessionManager.list
		// filter by header cwd, restricting resolution to that worktree's sessions).
		// resolveSessionWorktree also heals stranded bindings (rekeyed/subagent
		// session ids) from the session's stored cwd, so relays fail with the
		// designed worktree gates instead of session_unavailable (#83).
		const boundWorktree = await this.worktrees.resolveSessionWorktree(workspaceName, targetSessionId);
		const relayOwnerCapabilities = this.services.controlServer
			.connections()
			.find((controlConnection) => controlConnection.connectionId === tuiConnectionId)?.capabilities;
		if (!relayOwnerCapabilities?.has(CONTROL_RPC_GRANTS_CAPABILITY)) {
			await this.sendHandshakeError(stream, {
				message: "conversation owner is not grant-aware; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		// Worktree-bound conversations are only relayed to TUIs that advertised the
		// worktrees control capability (an old TUI would sanitize with the parent
		// root and leak host paths), and never when the checkout has vanished.
		const relayGate = evaluateWorktreeRelayGate(boundWorktree, relayOwnerCapabilities, CONTROL_WORKTREES_CAPABILITY);
		if (!relayGate.ok) {
			if (relayGate.reason === "checkout_missing") {
				await this.sendHandshakeError(stream, {
					message: "worktree checkout is unavailable",
					outcome: "session_unavailable",
					workspace: workspaceName,
					sessionId: targetSessionId,
				});
				return;
			}
			await this.sendHandshakeError(stream, {
				message: "conversation owner cannot serve worktree sessions; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		let resolvedTarget: Awaited<ReturnType<typeof resolveIrohRemoteSessionTarget>>;
		try {
			resolvedTarget = await resolveIrohRemoteSessionTarget(
				target,
				{ name: workspaceName, path: authorization.workspace.path },
				createSessionManagerTargetStore(
					boundWorktree?.path ?? authorization.workspace.path,
					getDefaultSessionDir(authorization.workspace.path, this.services.agentDir),
					{ listAll: true, preserveSessionCwd: true },
				),
			);
		} catch (error) {
			await this.sendHandshakeError(stream, error);
			return;
		}
		const resolvedSessionManager = resolvedTarget.sessionManager as { getCwd?: () => string };
		const resolvedSessionCwd =
			resolvedSessionManager.getCwd?.() ?? boundWorktree?.path ?? authorization.workspace.path;
		const relayWorkingDirectoryRelativeToRoot = getRelativeWorkingDirectoryForRoot(
			boundWorktree?.path ?? authorization.workspace.path,
			resolvedSessionCwd,
		);
		if (relayWorkingDirectoryRelativeToRoot === null) {
			await this.sendHandshakeError(stream, {
				message: "stored session working directory is outside the authorized workspace",
				outcome: "session_unavailable",
				workspace: workspaceName,
				sessionId: targetSessionId,
			});
			return;
		}
		const relayWorkingDirectory =
			boundWorktree === undefined
				? relayWorkingDirectoryRelativeToRoot
				: getRegisteredWorkingDirectoryForWorktree(boundWorktree, relayWorkingDirectoryRelativeToRoot);

		// Session-target resolution awaited; the lease can have moved (release,
		// rekey, connection loss) in the meantime. Re-check before minting so the
		// offer cannot go to a stale or dead owner.
		const lease = this.leaseBroker.lookup(workspaceName, targetSessionId);
		if (lease?.state !== "tui-owned" || lease.tuiConnectionId !== tuiConnectionId) {
			await this.sendHandshakeError(stream, {
				message: "conversation lease owner changed; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return;
		}
		// The target-resolution awaits above can race an access update or revoke.
		// Recheck immediately before the synchronous mint so stale authorization
		// cannot create a new pending offer after control-plane invalidation acks.
		await this.dependencies.beforeAuthorizedStreamPublication?.("relay", authorization);
		if (!(await this.isAuthorizationCurrent(authorization))) {
			await this.sendHandshakeError(stream, { message: "client access changed; reconnect" });
			return;
		}
		if (!admission.isCurrent()) {
			return;
		}

		// A sibling stream can resolve/redeem while this stream awaits target
		// resolution. Re-check immediately before minting the offer.
		const currentLiveRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"active",
		);
		const currentPendingRelays = this.relays.forConversation(
			authorization.client.nodeId,
			workspaceName,
			targetSessionId,
			"offered",
		);
		if (
			currentLiveRelays.some((relay) => relay.connectionId === connectionId) ||
			currentPendingRelays.some((pending) => pending.connectionId === connectionId)
		) {
			await this.rejectDuplicateActiveConnection(stream, authorization, targetSessionId, "relay_registry");
			return;
		}
		for (const relay of currentLiveRelays) {
			void this.conversationCoordinators.get(workspaceName, targetSessionId)?.closeTransport(relay.relayId, "error");
		}
		for (const pending of currentPendingRelays) {
			void this.conversationCoordinators
				.get(workspaceName, targetSessionId)
				?.closeTransport(pending.relayId, "error");
		}

		if (!admission.isCurrent()) {
			return;
		}
		const coordinator = this.conversationCoordinators.getOrCreate(workspaceName, targetSessionId);
		let releaseRelayTransport = () => {};
		const relayPhysicalStream = physicalOwner.physicalStream ?? stream;
		const relay = this.relays.mint({
			workspaceName,
			sessionId: targetSessionId,
			clientNodeId: authorization.client.nodeId,
			connectionId,
			ownerControlConnectionId: tuiConnectionId,
			streamId,
			stream: relayPhysicalStream,
			observePhysicalTask: (task) => this.trackNativeLifecycleTask(task),
			preamble: {
				handshake: {
					hello: handshake.hello,
					response: handshake.response,
					initialInput: Array.from(handshake.initialInput),
				},
				authorization: {
					clientNodeId: authorization.client.nodeId,
					allowedTools: normalizeIrohRemoteAllowTools(authorization.client.allowedTools),
					rpcGrant: authorization.client.rpcGrant,
					workspaceName,
					workspacePath: authorization.workspace.path,
					...(boundWorktree === undefined
						? {}
						: {
								worktreeId: boundWorktree.id,
								worktreePath: boundWorktree.path,
								...(boundWorktree.sourceRootRelativePath === undefined
									? {}
									: { worktreeSourceRootRelativePath: boundWorktree.sourceRootRelativePath }),
							}),
				},
				// The phone verifies the saved host's node id in the handshake
				// response the TUI writes; without this the relay path fails the
				// client's identity check.
				...(this.hostNodeId === undefined ? {} : { hostNodeId: this.hostNodeId }),
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				connectionId,
				streamId,
				resolvedTarget: {
					sessionId: resolvedTarget.sessionId,
					...(resolvedTarget.sessionFilePath === undefined
						? {}
						: { sessionFilePath: resolvedTarget.sessionFilePath }),
					selection: resolvedTarget.selection,
					...(resolvedTarget.requestedSessionId === undefined
						? {}
						: { requestedSessionId: resolvedTarget.requestedSessionId }),
					workspaceName: resolvedTarget.workspaceName,
					workspacePath: resolvedTarget.workspacePath,
					...(boundWorktree === undefined ? {} : { worktreeId: boundWorktree.id }),
					...(relayWorkingDirectory === undefined ? {} : { workingDirectory: relayWorkingDirectory }),
				},
			},
			rejectPending: ({ message, retryAfterMs }) =>
				this.sendHandshakeError(relayPhysicalStream, {
					message,
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				}),
			onSettled: async (outcome) => {
				coordinator.unregisterRelayLease(relay.relayId);
				this.services.controlServer.sendTo(tuiConnectionId, {
					type: "relay_closed",
					relayId: relay.relayId,
					reason: outcome.reason,
				});
				await this.logAudit({
					type: "relay_closed",
					clientNodeId: authorization.client.nodeId,
					workspace: workspaceName,
					success: outcome.error === undefined,
					error: outcome.error,
					details: {
						relayId: relay.relayId,
						reason: outcome.reason,
						bytesUp: outcome.bytesUp,
						bytesDown: outcome.bytesDown,
						durationMs: outcome.durationMs,
					},
				});
			},
		});
		if (
			!physicalOwner.installCloseAction((reason) =>
				relay
					.close(normalizeRelayCloseReason(reason), {
						pendingMessage: relayPendingMessageForReason(reason),
						...(reason === "workspace_unregistered" || reason === "host_shutdown"
							? {}
							: { retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS }),
					})
					.then(() => undefined),
			)
		) {
			await relay.close("host_shutdown", { pendingMessage: relayPendingMessageForReason("host_shutdown") });
			this.conversationCoordinators.releaseIfVacant(coordinator);
			return;
		}

		try {
			releaseRelayTransport = coordinator.registerTransport({
				id: relay.relayId,
				kind: "relay",
				clientNodeId: authorization.client.nodeId,
				connectionId,
				close: (reason) => physicalOwner.close(reason),
			});
		} catch (error) {
			// Surface the underlying registration failure in the relay_closed audit
			// record; the client only ever sees the retryable pendingMessage.
			await relay.close("error", {
				pendingMessage: "conversation owner changed; retry",
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				error: error instanceof Error ? error.message : String(error),
			});
			this.conversationCoordinators.releaseIfVacant(coordinator);
			return;
		}
		void relay.settled.finally(releaseRelayTransport);
		if (this.physicalStreamOwners.get(streamId) === physicalOwner) {
			this.physicalStreamOwners.delete(streamId);
		}
		if (!admission.isCurrent()) {
			await coordinator.closeTransport(relay.relayId, "host_shutdown");
			return;
		}

		if (!coordinator.registerRelayLease(relay.relayId)) {
			await coordinator.closeTransport(relay.relayId, "error");
			return;
		}
		// Coordinator, relay, and exact lease ownership are synchronously published;
		// the long-lived relay no longer holds attach-operation admission.
		admission.release();
		void this.logAudit({
			type: "relay_opened",
			clientNodeId: authorization.client.nodeId,
			workspace: workspaceName,
			success: true,
			details: {
				relayId: relay.relayId,
				workspaceName,
				sessionId: targetSessionId,
				connectionId,
				streamId,
			},
		});
		const delivered = this.services.controlServer.sendTo(tuiConnectionId, {
			type: "relay_offer",
			relayId: relay.relayId,
			relayToken: relay.relayToken,
			workspaceName,
			sessionId: targetSessionId,
			clientNodeId: authorization.client.nodeId,
			connectionId,
			streamId,
		});
		if (!delivered) {
			// The TUI vanished between lease publication and offer delivery. The
			// coordinator closes the same offered owner the expiry path would close.
			void coordinator.closeTransport(relay.relayId, "error");
		}
		await relay.settled;
	}

	private async runIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
	): Promise<void> {
		const admission = this.admission.tryAcquire();
		if (!admission) {
			await owner.close("host_shutdown").catch(() => {});
			return;
		}
		const admittedTask = this.runAdmittedIntegratedConversation(
			stream,
			handshake,
			connectionId,
			streamId,
			owner,
			admission,
		);
		try {
			await waitUntilAdmissionCancelled(admittedTask, admission.signal);
		} finally {
			admission.release();
		}
	}

	private async runAdmittedIntegratedConversation(
		stream: IrohBiStreamLike,
		handshake: Extract<IrohRemoteHostHandshakeResult, { ok: true }>,
		connectionId: string,
		streamId: string,
		owner: IrohPhysicalStreamOwner,
		admission: IrohDaemonAdmissionLease,
	): Promise<void> {
		const authorization = handshake.authorization;
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		if (!admission.isCurrent()) {
			return;
		}
		const daemonAttach = this.leaseBroker.beginDaemonAttach(authorization.workspace.name, targetSessionId);
		if (daemonAttach.kind === "relay") {
			if (!targetSessionId) {
				await this.sendHandshakeError(stream, {
					message: "conversation lease owner changed; retry",
					retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				});
				return;
			}
			await this.relayConversationToTui(
				stream,
				owner,
				handshake,
				connectionId,
				streamId,
				targetSessionId,
				daemonAttach.tuiConnectionId,
				admission,
			);
			return;
		}
		if (daemonAttach.kind === "retry") {
			await this.sendHandshakeError(stream, {
				message: "conversation lease is draining; retry",
				retryAfterMs: daemonAttach.retryAfterMs,
			});
			return;
		}
		const daemonAttachClaim: DaemonAttachClaim = daemonAttach.claim;
		let entry: IntegratedRuntimeEntry;
		let attachClaim: IntegratedRuntimeAttachClaim;
		let sessionSelection: Awaited<ReturnType<IntegratedRuntimeRegistry["getOrCreateEntry"]>>["sessionSelection"];
		let createdRuntime = false;
		try {
			({
				entry,
				attachClaim,
				sessionSelection,
				created: createdRuntime,
			} = await this.runtimes.getOrCreateEntry(
				{ hello: handshake.hello, response: handshake.response },
				authorization,
				{ signal: admission.signal },
			));
		} catch (error) {
			this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			// Include the resolved target so a failing attach can be correlated with
			// its conversation from the audit log alone (#83 was undiagnosable without it).
			await this.logAudit({
				type: "runtime_failure",
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				details: {
					runtime: "integrated-volt",
					...(targetSessionId === undefined ? {} : { targetSessionId }),
					...(handshake.hello.mode === "conversation" ? { target: handshake.hello.conversation.target } : {}),
				},
			});
			await this.sendHandshakeError(stream, error);
			return;
		}
		if (!admission.isCurrent()) {
			this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			try {
				if (createdRuntime) {
					await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
				} else {
					await this.runtimes.detachWithoutSubscriber(entry, attachClaim, "host_shutdown_during_attach");
				}
			} finally {
				attachClaim.release();
			}
			return;
		}

		if (
			this.activeStreams.hasConversationOnConnection(
				authorization.client.nodeId,
				authorization.workspace.name,
				entry.sessionId,
				connectionId,
			)
		) {
			this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
			try {
				if (createdRuntime) {
					await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
				} else {
					// Reattach: getOrCreateEntry cancelled the detached-runtime retention
					// timer up front. Re-arm it (no-op unless the entry is still detached
					// with no timer) so aborting here never leaves the runtime unswept.
					await this.runtimes.detachWithoutSubscriber(entry, attachClaim, "reattach_superseded");
				}
			} finally {
				attachClaim.release();
			}
			await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
			return;
		}

		let activeStream: { entry: IrohRemoteActiveStreamEntry; remove: () => void } | undefined;
		let subscriber: IntegratedRuntimeSubscriber | undefined;
		let subscriberError: unknown;
		// Monotonic publication fact: once commitEntry succeeds, this runtime is
		// registry-owned even if the rest of this stream attach later fails.
		let runtimeOwnershipPublished = false;
		// Per-attach cleanup state is separate from runtime publication. Conflating
		// these lets a later handshake-write failure misclassify a published runtime
		// as uncommitted and dispose ownership shared with another attach.
		let attachDetached = false;
		let retireRuntimeAfterStreamLifecycle = false;
		let workspaceUnregistered = false;
		let workspaceUnregisterClosureScheduled = false;
		let handshakeResponseWritten = false;
		let resolveStreamLifecycleSettled = () => {};
		const streamLifecycleSettled = new Promise<void>((resolve) => {
			resolveStreamLifecycleSettled = resolve;
		});
		try {
			if (!admission.isCurrent()) {
				this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
				if (createdRuntime) {
					await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
				} else {
					await this.runtimes.detachWithoutSubscriber(entry, attachClaim, "host_shutdown_during_attach");
				}
				return;
			}
			if (!createdRuntime) {
				try {
					this.runtimes.assertEntryAttachable(entry, attachClaim);
				} catch (error) {
					this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
					throw error;
				}
			}
			await this.dependencies.beforeAuthorizedStreamPublication?.("conversation", authorization);
			if (!(await this.isAuthorizationCurrent(authorization))) {
				this.leaseBroker.abortDaemonAttach(daemonAttachClaim);
				try {
					if (createdRuntime) {
						await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
					} else {
						await this.runtimes.detachWithoutSubscriber(entry, attachClaim, "access_updated_during_attach");
					}
				} finally {
					attachClaim.release();
				}
				await this.sendHandshakeError(
					stream,
					new Error("client or workspace authority changed during conversation attach; reconnect"),
				);
				return;
			}
			const committedSessionId = entry.sessionId;
			const { outcome: brokerCommit, installedProvisionalOwner } =
				entry.coordinator.commitDaemonRuntime(daemonAttachClaim);
			if (!brokerCommit.ok) {
				if (createdRuntime) {
					await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
				} else if (brokerCommit.reason === "runtime_owner_fenced") {
					// The registry entry no longer owns the broker record. Retire this
					// stale runtime through its exactly-once terminal owner; its stale
					// capability cannot mutate the replacement lease record.
					await this.runtimes.stopEntry(entry, "daemon_runtime_owner_fenced");
				} else {
					await this.runtimes.detachWithoutSubscriber(entry, attachClaim, "daemon_attach_not_committed");
				}
				if (
					brokerCommit.reason === "tui_owned" &&
					brokerCommit.tuiConnectionId &&
					targetSessionId === committedSessionId
				) {
					await this.relayConversationToTui(
						stream,
						owner,
						handshake,
						connectionId,
						streamId,
						committedSessionId,
						brokerCommit.tuiConnectionId,
						admission,
					);
					return;
				}
				await this.sendHandshakeError(stream, {
					message: "conversation lease owner changed; retry",
					retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
				});
				return;
			}
			try {
				await this.runtimes.commitEntry(entry, sessionSelection, authorization, attachClaim, admission.signal);
			} catch (error) {
				try {
					if (createdRuntime) {
						// A TUI acquire queued behind this provisional broker cohort may
						// continue as soon as rollback settles it. Retire the unpublished
						// registry/runtime side first so cohort settlement is the real
						// cross-layer completion barrier, not an early lease-only signal.
						await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
					}
				} finally {
					entry.coordinator.rollbackDaemonRuntimeCommit(
						brokerCommit.token,
						brokerCommit.owner,
						installedProvisionalOwner,
					);
				}
				throw error;
			}
			runtimeOwnershipPublished = true;
			const detachCommittedAttach = async (reason: string): Promise<void> => {
				if (!runtimeOwnershipPublished || attachDetached) {
					return;
				}
				// commitEntry has published this runtime. Even when this attach created
				// it, another stream may already have captured/co-attached it, so only
				// detach this failed attach; never roll back shared runtime ownership.
				await this.runtimes.detachWithoutSubscriber(entry, attachClaim, reason);
				const stillOwnsLease = this.syncRuntimeLeaseStreamCount(entry);
				attachDetached = true;
				if (!stillOwnsLease) {
					await this.runtimes.stopEntry(entry, "daemon_runtime_owner_fenced");
				}
			};
			const brokerFinalization = entry.coordinator.finalizeDaemonRuntimeCommit(brokerCommit.token);
			if (brokerFinalization.kind === "fenced") {
				const exactDaemonOwnership =
					brokerFinalization.lease.kind === "exact" &&
					(brokerFinalization.lease.state === "daemon-active" ||
						brokerFinalization.lease.state === "daemon-detached" ||
						brokerFinalization.lease.state === "daemon-draining");
				if (exactDaemonOwnership) {
					// A drain (including one that was cancelled back to daemon ownership)
					// still owns the busy runtime. Reject only this attach and let runDrain
					// own eventual retirement.
					await detachCommittedAttach("daemon_attach_lease_fenced");
				} else {
					await this.runtimes.stopEntry(entry, "daemon_attach_lease_fenced");
					attachDetached = true;
				}
				throw new Error("Conversation lease changed while publishing the daemon runtime");
			}
			if (!admission.isCurrent()) {
				await detachCommittedAttach("host_shutdown_during_attach");
				return;
			}
			if (
				this.activeStreams.hasConversationOnConnection(
					authorization.client.nodeId,
					authorization.workspace.name,
					entry.sessionId,
					connectionId,
				)
			) {
				await detachCommittedAttach("reattach_superseded");
				await this.rejectDuplicateActiveConnection(stream, authorization, entry.sessionId);
				return;
			}
			// Worktree-bound conversations sanitize with the worktree checkout as the
			// root; the parent checkout and the worktrees root must ALSO redact (bash
			// output like `git worktree list` prints both).
			const worktreeSanitizerOverrides: RemoteSanitizerOverrides | undefined =
				entry.worktreePath === undefined
					? undefined
					: {
							remoteWorkspacePath:
								entry.worktreeSourceRootRelativePath === undefined
									? "/workspace"
									: `/workspace/${entry.worktreeSourceRootRelativePath}`,
							workspacePath: entry.worktreePath,
							additionalRedactedPaths: [authorization.workspace.path, getWorktreesRoot(this.services.agentDir)],
						};
			if (!(await this.isAuthorizationCurrent(authorization))) {
				await detachCommittedAttach("access_updated_during_attach");
				await this.sendHandshakeError(
					stream,
					new Error("client access changed during conversation attach; reconnect"),
				);
				return;
			}
			if (!admission.isCurrent()) {
				await detachCommittedAttach("host_shutdown_during_attach");
				return;
			}
			try {
				this.runtimes.assertEntryAttachable(entry, attachClaim);
			} catch (error) {
				void owner.close("attach_generation_changed").catch(() => {});
				throw error;
			}
			activeStream = this.registerActiveStream(
				authorization,
				entry.sessionId,
				stream,
				owner,
				connectionId,
				streamId,
				{
					coordinator: entry.coordinator,
					...(worktreeSanitizerOverrides === undefined ? {} : { sanitizerOverrides: worktreeSanitizerOverrides }),
					lifecycleSettled: streamLifecycleSettled,
				},
			);
			const replacedEntries = this.activeStreams.takeEntriesForConversationOnOtherConnections(
				authorization.client.nodeId,
				authorization.workspace.name,
				entry.sessionId,
				connectionId,
			);
			// The ordered feed installs the sole post-handshake writer. Until then,
			// global theme/keep-awake fanout must not overtake cursor-zero bootstrap.
			activeStream.entry.write = undefined;
			// Runtime, lease, and physical stream ownership are now synchronously
			// published. Later subscriber admission rechecks the service gate, while
			// this long-lived stream no longer belongs to the attach-operation drain.
			admission.release();
			await this.closeReplacedActiveStreams(authorization, streamId, replacedEntries);
			await writeIrohRemoteHandshakeResponse(
				stream.send,
				createIntegratedConversationHandshakeResponse(
					{ hello: handshake.hello, response: handshake.response },
					authorization,
					entry.sessionId,
					sessionSelection,
					this.getResponseContext(),
					entry.worktreeId,
					entry.workingDirectory,
				),
			);
			handshakeResponseWritten = true;
			if (!this.admission.isOpen) {
				return;
			}
			try {
				this.runtimes.assertEntryAttachable(entry, attachClaim);
			} catch (error) {
				void owner.close("attach_generation_changed").catch(() => {});
				throw error;
			}
			subscriber = await this.runtimes.attachSubscriber(entry, attachClaim);
			// attachSubscriber publishes the subscriber before awaiting its audit
			// record. A concurrent stop can fence the generation during that await,
			// so validate again before creating the RPC/projection lifecycle on an
			// entry that may already be retiring or disposed.
			try {
				this.runtimes.assertEntryAttachable(entry, attachClaim);
			} catch (error) {
				void owner.close("attach_generation_changed").catch(() => {});
				throw error;
			}
			if (!entry.coordinator.markTransportLeaseActive(streamId, true) || !this.syncRuntimeLeaseStreamCount(entry)) {
				retireRuntimeAfterStreamLifecycle = true;
				void owner.close("daemon_runtime_owner_fenced").catch(() => {});
				throw new Error("Conversation runtime lease owner changed during subscriber attach");
			}
			if (!this.admission.isOpen) {
				return;
			}
			const pushDispatcher = this.createPushNotificationDispatcher(authorization);
			const responseContext = this.getResponseContext();
			await runIrohRemoteRpcMode(entry.runtime, {
				rpcGrant: authorization.client.rpcGrant,
				clientNodeId: authorization.client.nodeId,
				isRpcGrantCurrent: () => (workspaceUnregistered ? false : this.isAuthorizationCurrent(authorization)),
				decorateOutbound: (value) => decorateRemoteHostState(value, authorization, responseContext),
				disposeRuntimeOnClose: false,
				notificationDelivery: pushDispatcher,
				onClientCapabilitiesChanged: (features) => {
					const streamEntry = activeStream?.entry;
					if (streamEntry) {
						streamEntry.capabilities = new Set(features);
						this.pushThemeTokensToStream(streamEntry);
					}
				},
				onResponseWritten: (response) => {
					if (
						!workspaceUnregistered ||
						workspaceUnregisterClosureScheduled ||
						response.command !== "unregister_workspace" ||
						response.success !== true
					) {
						return;
					}
					workspaceUnregisterClosureScheduled = true;
					// The response write has physically completed. Admit the explicit
					// terminal frame on the next microtask so the ordered feed can finish
					// the current response before retiring its requesting stream.
					queueMicrotask(() => {
						void (async () => {
							try {
								await activeStream?.entry.writeTerminal?.({
									type: "remote_terminal",
									reason: WORKSPACE_UNREGISTERED_CLOSE_REASON,
									workspace: authorization.workspace.name,
									sessionId: entry.sessionId,
									hostNodeId: this.hostNodeId,
								});
							} catch {
								// The response is already delivered; terminal delivery is best-effort.
							} finally {
								await owner.close(WORKSPACE_UNREGISTERED_CLOSE_REASON).catch(() => {});
							}
						})();
					});
				},
				buildConversationSnapshot: createRemoteConversationSnapshotBuilder({
					authorization,
					runtime: entry.runtime,
				}),
				projectConversationExternal: createRemoteConversationExternalProjector({
					authorization,
					runtime: entry.runtime,
				}),
				onConversationLifecycleReady: (lifecycle) => {
					if (activeStream?.entry) {
						activeStream.entry.write = lifecycle.write;
						activeStream.entry.writeTerminal = lifecycle.writeTerminal;
						activeStream.entry.terminate = lifecycle.terminate;
					}
				},
				onReady: () => {
					if (!subscriber) {
						throw new Error("Recovered input cannot start before subscriber admission");
					}
					// Arm recovery only after RPC has rebound the active session and extension
					// session_start/resource discovery has completed. Fresh sessions complete as
					// a no-op; later replacements inherit the same post-rebind capability.
					void this.runtimes.startRecoveredClientInputs(entry, attachClaim, subscriber);
					attachClaim.release();
				},
				onSessionWillProject: async (session) => {
					await this.runtimes.handleSessionChanged(entry, activeStream?.entry, session, authorization);
				},
				registerPushTarget: (args) => pushDispatcher.registerPushTarget(args),
				remoteCommandHandler: (command) =>
					handleIntegratedConversationRpcCommand(
						command as { type: string } & Record<string, unknown>,
						authorization,
						this.getCommandContext({
							workspaceName: authorization.workspace.name,
							workspacePath: authorization.workspace.path,
							entry,
							streamEntry: activeStream?.entry,
							onWorkspaceUnregistered: () => {
								workspaceUnregistered = true;
								activeStream?.remove();
							},
						}),
						entry.runtime,
					),
				stream,
				initialInput: handshake.initialInput,
				workspaceName: authorization.workspace.name,
				workspacePath: entry.worktreePath ?? authorization.workspace.path,
				...(worktreeSanitizerOverrides?.remoteWorkspacePath === undefined
					? {}
					: { remoteWorkspacePath: worktreeSanitizerOverrides.remoteWorkspacePath }),
				...(worktreeSanitizerOverrides?.additionalRedactedPaths === undefined
					? {}
					: { additionalRedactedPaths: worktreeSanitizerOverrides.additionalRedactedPaths }),
			});
		} catch (error) {
			subscriberError = error;
			if (!runtimeOwnershipPublished) {
				if (createdRuntime) {
					await this.runtimes.abortPreparedEntry(entry, sessionSelection, attachClaim);
				}
				if (!handshakeResponseWritten) {
					await this.sendHandshakeError(stream, error);
				}
				return;
			}
			if (!handshakeResponseWritten) {
				await this.sendHandshakeError(stream, error);
			}
		} finally {
			try {
				if (subscriber) {
					await this.runtimes.detachSubscriber(
						entry,
						subscriber,
						subscriberError ? "transport_error" : "transport_closed",
						subscriberError,
					);
					entry.coordinator.markTransportLeaseActive(streamId, false);
					if (!this.syncRuntimeLeaseStreamCount(entry)) {
						retireRuntimeAfterStreamLifecycle = true;
					}
				} else if (!attachDetached && (runtimeOwnershipPublished || !createdRuntime)) {
					// runtimeOwnershipPublished: normal detach after the runtime ran. !createdRuntime:
					// a reattach that failed before attachSubscriber, whose retention timer
					// getOrCreateEntry cancelled up front — re-arm it so the runtime is still
					// swept at TTL instead of leaking forever. detachWithoutSubscriber no-ops
					// when the entry was replaced or still has other subscribers.
					await this.runtimes.detachWithoutSubscriber(
						entry,
						attachClaim,
						subscriberError ? "transport_error" : "transport_closed",
					);
					// Sync the lease's stream count to reality. Without this, a handshake
					// write that failed after commitDaemonRuntime but before attachSubscriber
					// leaves the lease stuck at daemon-active with no live stream until the
					// detached-runtime retention TTL expires.
					entry.coordinator.markTransportLeaseActive(streamId, false);
					if (!this.syncRuntimeLeaseStreamCount(entry)) {
						retireRuntimeAfterStreamLifecycle = true;
					}
					attachDetached = true;
				}
			} finally {
				activeStream?.remove();
				resolveStreamLifecycleSettled();
				attachClaim.release();
			}
			if (workspaceUnregistered) {
				retireRuntimeAfterStreamLifecycle = true;
			}
			if (retireRuntimeAfterStreamLifecycle) {
				await this.runtimes.stopEntry(
					entry,
					workspaceUnregistered ? WORKSPACE_UNREGISTERED_CLOSE_REASON : "daemon_runtime_owner_fenced",
				);
			}
		}
	}

	// ==========================================================================
	// Stream/connection registries
	// ==========================================================================

	private registerClientConnection(nodeId: string, connectionId: string, supervisor: IrohConnectionSupervisor): void {
		const record: ClientConnectionRecord = {
			connectionId,
			supervisor,
		};
		let records = this.clientConnections.get(nodeId);
		if (!records) {
			records = new Set();
			this.clientConnections.set(nodeId, records);
		}
		records.add(record);
		this.connectionSupervisors.set(connectionId, supervisor);
		supervisor.addTerminalFinalizer(() => {
			records.delete(record);
			if (records.size === 0 && this.clientConnections.get(nodeId) === records) {
				this.clientConnections.delete(nodeId);
			}
			if (this.connectionSupervisors.get(connectionId) === supervisor) {
				this.connectionSupervisors.delete(connectionId);
			}
		});
	}

	private closeClientConnectionsForClient(nodeId: string, reason: string): number {
		const records = Array.from(this.clientConnections.get(nodeId) ?? []);
		if (records.length === 0) {
			return 0;
		}
		for (const record of records) {
			record.supervisor.requestClose(reason, "immediate");
		}
		return records.length;
	}

	private requestCloseWhenIdleForEntries(entries: IrohRemoteActiveStreamEntry[], reason: string): void {
		const requestedConnectionIds = new Set<string>();
		for (const entry of entries) {
			if (requestedConnectionIds.has(entry.connectionId)) {
				continue;
			}
			requestedConnectionIds.add(entry.connectionId);
			this.connectionSupervisors.get(entry.connectionId)?.requestClose(reason, "when_idle");
		}
	}

	private async closeActiveStreamsForConnection(connectionId: string, reason: string): Promise<void> {
		await this.initiateActiveStreamRetirement(new Set(this.activeStreams.entriesForConnection(connectionId)), reason);
	}

	private async closeActiveStreamsForConversationKey(
		workspaceName: string,
		sessionId: string,
		reason: string,
	): Promise<number> {
		const coordinator = this.conversationCoordinators.get(workspaceName, sessionId);
		if (!coordinator) return 0;
		const closedCount = coordinator.transportOwners().filter((owner) => owner.kind === "direct").length;
		await coordinator.closeTransports(reason, (owner) => owner.kind === "direct");
		return closedCount;
	}

	/** The coordinator's terminal barrier closes owners before runtime disposal. */
	private async stopRuntimeEntryAfterStreams(entry: IntegratedRuntimeEntry, reason: string): Promise<number> {
		const closedStreamCount = entry.coordinator.transportOwners().filter((owner) => owner.kind === "direct").length;
		await this.runtimes.stopEntry(entry, reason);
		return closedStreamCount;
	}

	/** Update lease state only when this exact runtime generation still owns it. */
	private syncRuntimeLeaseStreamCount(entry: IntegratedRuntimeEntry): boolean {
		return entry.coordinator.syncDaemonRuntimeStreamCount();
	}

	private initiateActiveStreamRetirement(
		entries: ReadonlySet<IrohRemoteActiveStreamEntry>,
		reason: string,
	): Promise<void> {
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}
		this.requestCloseWhenIdleForEntries(Array.from(entries), reason);
		const closures: Promise<void>[] = [];
		for (const entry of entries) {
			const coordinator = this.conversationCoordinators.get(entry.workspaceName, entry.sessionId);
			closures.push(
				(async () => {
					if (coordinator && (await coordinator.closeTransport(entry.streamId, reason))) return;
					await entry.close(reason);
				})().catch(() => undefined),
			);
		}
		return Promise.allSettled(closures).then(() => undefined);
	}

	private async closeActiveStreamsForWorkspace(
		workspaceName: string,
		reason: string,
		excludedEntry?: IrohRemoteActiveStreamEntry,
	): Promise<number> {
		const entries = this.activeStreams
			.entriesForWorkspaceName(workspaceName)
			.filter((entry) => entry !== excludedEntry);
		if (entries.length === 0) {
			return 0;
		}
		await this.initiateActiveStreamRetirement(new Set(entries), reason);
		return entries.length;
	}

	private closeRelaysForWorkspace(workspaceName: string, excludeRelayIds?: ReadonlySet<string>): void {
		for (const relay of this.relays.all()) {
			if (relay.workspaceName === workspaceName && !excludeRelayIds?.has(relay.relayId)) {
				void this.conversationCoordinators
					.get(relay.workspaceName, relay.sessionId)
					?.closeTransport(relay.relayId, "workspace_unregistered");
			}
		}
	}

	/**
	 * Post-unregister host cleanup shared by the control, workspace-management,
	 * and conversation RPC unregister paths: closes phone streams, stops
	 * runtimes, drops live activities, and closes TUI relays for the workspace.
	 * Exclusions keep the requesting stream/runtime/relays alive so the
	 * unregister response can still be delivered.
	 */
	private async cleanupUnregisteredWorkspace(
		workspaceName: string,
		exclusions: {
			streamEntry?: IrohRemoteActiveStreamEntry;
			runtimeEntry?: IntegratedRuntimeEntry;
			relayIds?: ReadonlySet<string>;
			/** Enables a non-destructive audit of preserved checkout directories. */
			workspacePath?: string;
		} = {},
	): Promise<{ closedStreamCount: number; stoppedRuntimeCount: number }> {
		const closedStreamCount = await this.closeActiveStreamsForWorkspace(
			workspaceName,
			WORKSPACE_UNREGISTERED_CLOSE_REASON,
			exclusions.streamEntry,
		);
		const stoppedRuntimeCount = await this.runtimes.stopForWorkspace(
			workspaceName,
			WORKSPACE_UNREGISTERED_CLOSE_REASON,
			exclusions.runtimeEntry,
		);
		await this.stateManager.removeLiveActivitiesForWorkspace(workspaceName);
		this.closeRelaysForWorkspace(workspaceName, exclusions.relayIds);
		if (exclusions.workspacePath !== undefined) {
			await this.worktrees
				.cleanupUnregisteredWorkspace({ name: workspaceName, path: exclusions.workspacePath })
				.catch(() => {});
		}
		return { closedStreamCount, stoppedRuntimeCount };
	}

	private async closeActiveStreamsForClientWorkspace(
		nodeId: string,
		workspaceName: string,
		reason: string,
	): Promise<number> {
		const entries = this.activeStreams
			.entriesForClientNodeId(nodeId)
			.filter((entry) => entry.workspaceName === workspaceName);
		if (entries.length === 0) {
			return 0;
		}
		await this.initiateActiveStreamRetirement(new Set(entries), reason);
		return entries.length;
	}

	private async closeClientForAccessUpdate(nodeId: string): Promise<void> {
		const runtimeEntries = collectClientAuthorityInvalidationRuntimes(
			this.activeStreams,
			this.runtimes.values(),
			nodeId,
		);
		const entries = collectClientAuthorityInvalidationStreams(this.activeStreams, runtimeEntries, nodeId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}
		// Invalidate transport and relay authority synchronously. Terminal writes
		// below are best-effort and must never keep old commands or buffered prompts
		// alive behind backpressure.
		this.closeClientConnectionsForClient(nodeId, "access_updated");
		for (const relay of this.relays.all().filter((candidate) => candidate.clientNodeId === nodeId)) {
			void this.conversationCoordinators
				.get(relay.workspaceName, relay.sessionId)
				?.closeTransport(relay.relayId, "error");
		}
		const streamClosures = this.initiateActiveStreamRetirement(entries, "access_updated");
		await streamClosures;
		await Promise.allSettled(
			Array.from(runtimeEntries, (runtimeEntry) => this.runtimes.stopEntry(runtimeEntry, "access_updated")),
		);
	}

	private async closeWorkspaceAuthorizationRemovedStreams(nodeId: string, workspaceName: string): Promise<void> {
		const reason = "workspace_authorization_removed";
		const relayClosures = this.relays
			.all()
			.filter((relay) => relay.clientNodeId === nodeId && relay.workspaceName === workspaceName)
			.map(
				(relay) =>
					this.conversationCoordinators
						.get(relay.workspaceName, relay.sessionId)
						?.closeTransport(relay.relayId, reason) ?? Promise.resolve(false),
			);
		const runtimeEntries = this.runtimes
			.values()
			.filter((entry) => entry.clientNodeId === nodeId && entry.workspaceName === workspaceName);
		const relayResults = await Promise.allSettled(relayClosures);
		let closedStreamCount = relayResults.filter(
			(result): result is PromiseFulfilledResult<true> => result.status === "fulfilled" && result.value,
		).length;
		closedStreamCount += await this.closeActiveStreamsForClientWorkspace(nodeId, workspaceName, reason);
		for (const entry of runtimeEntries) {
			closedStreamCount += await this.stopRuntimeEntryAfterStreams(entry, reason);
		}
		const stoppedRuntimeCount = runtimeEntries.length;
		const removedLiveActivityCount = await this.stateManager.removeClientLiveActivitiesForWorkspace(
			nodeId,
			workspaceName,
		);
		await this.logAudit({
			type: "workspace_authorization_removed",
			clientNodeId: nodeId,
			workspace: workspaceName,
			success: closedStreamCount > 0 || stoppedRuntimeCount > 0 || removedLiveActivityCount > 0,
			details: {
				closedStreamCount,
				removedLiveActivityCount,
				source: "authorization_failure",
				stoppedRuntimeCount,
			},
		});
	}

	async closeActiveStreamsForClient(nodeId: string): Promise<{ closed: boolean; closedCount: number }> {
		const runtimeEntries = collectClientAuthorityInvalidationRuntimes(
			this.activeStreams,
			this.runtimes.values(),
			nodeId,
		);
		const entries = collectClientAuthorityInvalidationStreams(this.activeStreams, runtimeEntries, nodeId);
		for (const entry of entries) {
			this.activeStreams.unregister(entry);
		}

		// Match access-update ordering: synchronously make active and unredeemed TUI
		// relays unusable before any terminal write, runtime disposal, or control ack.
		const activeRelays = this.relays.all("active").filter((relay) => relay.clientNodeId === nodeId);
		const pendingRelays = this.relays.all("offered").filter((relay) => relay.clientNodeId === nodeId);
		for (const relay of [...activeRelays, ...pendingRelays]) {
			void this.conversationCoordinators
				.get(relay.workspaceName, relay.sessionId)
				?.closeTransport(relay.relayId, "error");
		}

		const closedConnectionCount = this.closeClientConnectionsForClient(nodeId, ACTIVE_REVOKE_CLOSE_REASON);
		const streamClosures = this.initiateActiveStreamRetirement(entries, ACTIVE_REVOKE_CLOSE_REASON);
		await streamClosures;
		await Promise.allSettled(
			Array.from(runtimeEntries, (runtimeEntry) => this.runtimes.stopEntry(runtimeEntry, "client_revoked")),
		);
		const stoppedRuntimeCount = runtimeEntries.size;
		const closed =
			entries.size > 0 || closedConnectionCount > 0 || activeRelays.length > 0 || pendingRelays.length > 0;
		if (entries.size === 0) {
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				success: closed || stoppedRuntimeCount > 0,
				error: closed || stoppedRuntimeCount > 0 ? undefined : "no active connection found",
				details: {
					activeRelayCount: activeRelays.length,
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					pendingRelayCount: pendingRelays.length,
					source: "control_channel",
					stoppedRuntimeCount,
				},
			});
			return { closed, closedCount: closedConnectionCount + activeRelays.length + pendingRelays.length };
		}

		for (const entry of entries) {
			await this.logAudit({
				type: "active_connection_revoked",
				clientNodeId: nodeId,
				workspace: entry.workspaceName,
				success: true,
				details: {
					activeRelayCount: activeRelays.length,
					closeReason: ACTIVE_REVOKE_CLOSE_REASON,
					closedConnectionCount,
					pendingRelayCount: pendingRelays.length,
					source: "control_channel",
					streamId: entry.streamId,
					stoppedRuntimeCount,
				},
			});
		}
		return { closed: true, closedCount: entries.size + activeRelays.length + pendingRelays.length };
	}

	// ==========================================================================
	// Pairing over the control plane
	// ==========================================================================

	private notifyPairingConsumed(
		handshake: { ok: true; authorization: IrohRemoteClientAuthorizationSuccess },
		remoteId: string,
	): void {
		const consumed = handshake.authorization.consumedPairingTicket;
		if (!consumed) {
			return;
		}
		for (const [requestId, pending] of this.pendingPairRequests) {
			if (pending.secretHash !== consumed.secretHash) {
				continue;
			}
			clearTimeout(pending.timer);
			this.pendingPairRequests.delete(requestId);
			this.services.controlServer.sendTo(pending.connectionId, {
				type: "pairing_progress",
				requestId,
				phase: "completed",
				clientNodeId: remoteId,
			});
		}
	}

	private async handlePairRequest(
		connection: ControlConnection,
		request: ControlRequest & { type: "pair_request" },
	): Promise<void> {
		try {
			await withTimeout(
				this.ready.promise,
				IROH_ENDPOINT_READY_TIMEOUT_MS,
				"Iroh endpoint did not become ready within 15s",
			);
		} catch (error) {
			connection.send({
				type: "error",
				id: request.id,
				code: "iroh_unavailable",
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const engine = this.requireEngine();
		const endpoint = this.endpoint;
		if (!endpoint || !this.endpointTicket) {
			connection.send({ type: "error", id: request.id, code: "iroh_unavailable", message: "endpoint not ready" });
			return;
		}
		const workspaceName =
			typeof (request as Record<string, unknown>).workspaceName === "string"
				? ((request as Record<string, unknown>).workspaceName as string)
				: undefined;
		const requestId = randomUUID();
		try {
			const access =
				request.access !== undefined
					? createIrohRemotePresetAccess(request.access)
					: request.allowedTools !== undefined && request.rpcCapabilities !== undefined
						? createIrohRemoteExplicitAccess(
								request.allowedTools,
								parseIrohRemoteRpcCapabilities(request.rpcCapabilities),
							)
						: createIrohRemotePresetAccess("coding");
			const pairing = await engine.pair({
				allowTools: access.allowedTools,
				rpcGrant: access.rpcGrant,
				irohTicket: this.endpointTicket,
				nodeId: this.hostNodeId,
				relayMode: this.relayMode,
				...(this.relayMode === "production" ? { relayUrls: this.relayUrls } : {}),
				...(this.relayMode === "production" && this.relayAuthToken !== undefined
					? { relayAuthToken: this.relayAuthToken }
					: {}),
				...(workspaceName === undefined ? {} : { workspace: workspaceName }),
			});
			connection.send({ type: "pair_started", id: request.id, requestId });
			connection.send({
				type: "pairing_progress",
				requestId,
				phase: "ticket",
				ticket: pairing.ticket,
			});
			connection.send({ type: "pairing_progress", requestId, phase: "waiting" });
			const ttlMs = Math.max(0, pairing.expiresAt - Date.now());
			const timer = setTimeout(
				() => {
					if (!this.pendingPairRequests.delete(requestId)) {
						return;
					}
					this.services.controlServer.sendTo(connection.connectionId, {
						type: "pairing_progress",
						requestId,
						phase: "failed",
						error: "pairing ticket expired",
					});
				},
				ttlMs > 0 ? ttlMs : DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
			);
			timer.unref?.();
			this.pendingPairRequests.set(requestId, {
				requestId,
				connectionId: connection.connectionId,
				secretHash: hashIrohRemotePairingSecret(pairing.secret),
				expiresAt: pairing.expiresAt,
				timer,
			});
		} catch (error) {
			connection.send({
				type: "error",
				id: request.id,
				code: "pair_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// ==========================================================================
	// Control plane integration
	// ==========================================================================

	async handleRequest(connection: ControlConnection, request: ControlRequest): Promise<boolean> {
		switch (request.type) {
			case "lease_acquire": {
				const outcome = await this.leaseBroker.acquireForTui({
					connectionId: connection.connectionId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					force: request.force,
				});
				if (outcome.kind === "granted") {
					connection.send({
						type: "lease_granted",
						id: request.id,
						workspaceName: request.workspaceName,
						sessionId: request.sessionId,
						handoff: outcome.handoff,
					});
					return true;
				}
				if (outcome.kind === "denied") {
					connection.send({ type: "lease_denied", id: request.id, reason: outcome.reason });
					return true;
				}
				connection.send({ type: "lease_pending", id: request.id, viewerFeedId: outcome.viewerFeedId });
				outcome.granted.then(
					(granted) => {
						connection.send({
							type: "lease_granted",
							id: request.id,
							workspaceName: request.workspaceName,
							sessionId: request.sessionId,
							handoff: granted.handoff,
						});
					},
					(error: unknown) => {
						connection.send({
							type: "error",
							id: request.id,
							code: "drain_failed",
							message: error instanceof Error ? error.message : String(error),
						});
					},
				);
				return true;
			}
			case "lease_release": {
				const result = this.leaseBroker.releaseFromTui(
					connection.connectionId,
					request.workspaceName,
					request.sessionId,
				);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: "lease not held" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "lease_rekey_prepare": {
				const result = this.leaseBroker.prepareTuiRekey(
					request.workspaceName,
					request.oldSessionId,
					request.newSessionId,
					connection.connectionId,
				);
				if (!result.ok) {
					connection.send({
						type: "error",
						id: request.id,
						code: result.code,
						message: `conversation lease rekey preflight failed: ${result.code}`,
					});
					return true;
				}
				connection.send({ type: "lease_rekey_prepared", id: request.id, transactionId: result.reservation.id });
				return true;
			}
			case "lease_rekey_commit": {
				const reservation = this.leaseBroker.getTuiRekeyReservation(request.transactionId, connection.connectionId);
				if (!reservation) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: "conversation lease rekey transaction not found",
					});
					return true;
				}
				const relayedClientNodeIds = new Set(
					this.relays
						.all()
						.filter(
							(relay) =>
								relay.ownerControlConnectionId === connection.connectionId &&
								relay.workspaceName === reservation.workspaceName &&
								relay.sessionId === reservation.oldSessionId,
						)
						.map((relay) => relay.clientNodeId),
				);
				try {
					// A TUI rekey of a worktree-bound conversation must keep the durable
					// binding covering the new id, or a post-restart daemon resume of the
					// persisted reconnect target cannot resolve its checkout (#83). The
					// healing lookup also repairs a stranded old id at rekey time, and the
					// bind runs before the reconnect-target persist so a failure here
					// leaves the old target intact; the append is additive and idempotent,
					// so a stale extra id after a failed broker commit below is inert.
					const boundWorktree = await this.worktrees.resolveSessionWorktree(
						reservation.workspaceName,
						reservation.oldSessionId,
					);
					if (boundWorktree) {
						await this.worktrees.bindSession(
							reservation.workspaceName,
							boundWorktree.id,
							reservation.newSessionId,
						);
					}
					await this.stateManager.setClientsLastSessionId(
						Array.from(relayedClientNodeIds),
						reservation.workspaceName,
						reservation.newSessionId,
					);
				} catch (error: unknown) {
					connection.send({
						type: "error",
						id: request.id,
						code: "state_write_failed",
						message: error instanceof Error ? error.message : String(error),
					});
					return true;
				}
				const result = this.leaseBroker.commitTuiRekey(request.transactionId, connection.connectionId);
				if (!result.ok) {
					try {
						await this.stateManager.setClientsLastSessionId(
							Array.from(relayedClientNodeIds),
							reservation.workspaceName,
							reservation.oldSessionId,
						);
					} catch (error: unknown) {
						connection.send({
							type: "error",
							id: request.id,
							code: "state_write_failed",
							message: error instanceof Error ? error.message : String(error),
						});
						return true;
					}
					connection.send({
						type: "error",
						id: request.id,
						code: result.code,
						message: `conversation lease rekey failed: ${result.code}`,
					});
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "lease_rekey_rollback": {
				const result = this.leaseBroker.rollbackTuiRekey(request.transactionId, connection.connectionId);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: "rekey not prepared" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "lease_rekey_dispose": {
				const result = this.leaseBroker.disposeTuiRekey(request.transactionId, connection.connectionId);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: "rekey not prepared" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_subscribe": {
				if (!this.viewerFeeds.subscribe(request.viewerFeedId, connection.connectionId)) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_unsubscribe": {
				if (!this.viewerFeeds.unsubscribe(request.viewerFeedId, connection.connectionId)) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "viewer_abort": {
				if (!(await this.viewerFeeds.abort(request.viewerFeedId, connection.connectionId))) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" });
					return true;
				}
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "pair_request":
				await this.handlePairRequest(connection, request);
				return true;
			case "pair_cancel": {
				const pending = this.pendingPairRequests.get(request.requestId);
				if (!pending || pending.connectionId !== connection.connectionId) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: "pairing request not found",
					});
					return true;
				}
				try {
					await this.cancelPendingPairing(request.requestId, pending);
					connection.send({ type: "ok", id: request.id });
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "cancel_failed",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return true;
			}
			case "relay_rpc": {
				const result = await this.handleRelayRpc(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({
					type: "relay_rpc_result",
					id: request.id,
					response: result.response,
					...(result.workspaceMetadata === undefined ? {} : { workspaceMetadata: result.workspaceMetadata }),
				});
				return true;
			}
			case "relay_notification_delivery": {
				const result = await this.handleRelayNotificationDelivery(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: result.status });
				return true;
			}
			case "relay_live_activity_delivery": {
				const result = await this.handleRelayLiveActivityDelivery(connection, request);
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: result.code, message: result.message });
					return true;
				}
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: result.status });
				return true;
			}
			case "client_access_update": {
				const access =
					request.access !== undefined
						? createIrohRemotePresetAccess(request.access)
						: createIrohRemoteExplicitAccess(
								request.allowedTools ?? [],
								parseIrohRemoteRpcCapabilities(request.rpcCapabilities),
							);
				const engine = this.engine;
				const updated = engine
					? await engine.updateClientAccess(request.clientNodeId, request.expectedRevision, access)
					: await this.stateManager.updateClientAccess(request.clientNodeId, request.expectedRevision, access);
				if (!engine) {
					await this.logAudit({
						type: "client_access_updated",
						clientNodeId: request.clientNodeId,
						success: updated.ok,
						error: updated.ok ? undefined : updated.reason,
						details: {
							expectedRevision: request.expectedRevision,
							...(updated.ok
								? {
										revision: updated.client.rpcGrant.revision,
										allowedTools: normalizeIrohRemoteAllowTools(updated.client.allowedTools),
										usesDefaultTools: updated.client.allowedTools === undefined,
									}
								: { currentRevision: updated.currentRevision }),
						},
					});
				}
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
					return true;
				}
				await this.services.state.flush();
				await this.closeClientForAccessUpdate(request.clientNodeId);
				connection.send({
					type: "client_access_updated",
					id: request.id,
					client: createControlClientStatus(updated.client),
				});
				return true;
			}
			case "client_revoke": {
				const result = await this.requireEngineSafe();
				if (!result.ok) {
					connection.send({ type: "error", id: request.id, code: "iroh_unavailable", message: result.error });
					return true;
				}
				const revocation = await result.engine.revokeClient(request.clientNodeId);
				if (!revocation.revoked) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return true;
				}
				await this.closeActiveStreamsForClient(request.clientNodeId);
				await this.revokeClientPushTargets(revocation.client);
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			case "workspace_unregister": {
				let removedWorkspace: Awaited<ReturnType<IrohRemoteHostStateManager["unregisterWorkspace"]>>;
				try {
					removedWorkspace = await this.stateManager.unregisterWorkspace(request.name);
				} catch (error) {
					if (!isIrohRemoteWorkspaceHasWorktreesError(error)) {
						throw error;
					}
					await this.logAudit({
						type: "workspace_unregistered",
						workspace: request.name,
						success: false,
						error: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
						details: {
							source: "control",
							worktreeCount: error.worktreeIds.length,
							worktreeIds: error.worktreeIds,
						},
					});
					connection.send({
						type: "error",
						id: request.id,
						code: IROH_REMOTE_WORKSPACE_HAS_WORKTREES_ERROR,
						message: error.message,
					});
					return true;
				}
				if (!removedWorkspace) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: `No registered workspace named ${request.name}`,
					});
					return true;
				}
				this.engine?.clearPairingSecretForWorkspace(request.name);
				await this.cleanupUnregisteredWorkspace(request.name, { workspacePath: removedWorkspace.path });
				await this.logAudit({
					type: "workspace_unregistered",
					workspace: request.name,
					success: true,
					details: { source: "control" },
				});
				connection.send({ type: "ok", id: request.id });
				return true;
			}
			default:
				if (isWorktreeControlRequest(request)) {
					await handleWorktreeControlRequest(connection, request, {
						manager: this.worktrees,
						stateManager: this.stateManager,
						removeWorktree: (workspace, worktreeId, force) =>
							this.removeWorkspaceWorktree(workspace, worktreeId, force),
					});
					return true;
				}
				return false;
		}
	}

	private async createRelayDeliveryAuthorization(
		connection: ControlConnection,
		request: { clientNodeId: string; workspaceName: string; sessionId: string },
	): Promise<
		{ ok: true; authorization: IrohRemoteClientAuthorizationSuccess } | { ok: false; code: string; message: string }
	> {
		const lease = this.leaseBroker.lookup(request.workspaceName, request.sessionId);
		if (!lease || lease.state !== "tui-owned" || lease.tuiConnectionId !== connection.connectionId) {
			return {
				ok: false,
				code: "not_held",
				message: "relay lease is not held by this control connection",
			};
		}
		const client = await this.stateManager.getClient(request.clientNodeId);
		if (!client) {
			return { ok: false, code: "not_found", message: "paired client not found" };
		}
		const workspace = (await this.stateManager.getState()).workspaces.find(
			(candidate) => candidate.name === request.workspaceName,
		);
		if (!workspace) {
			return { ok: false, code: "not_found", message: `no registered workspace named ${request.workspaceName}` };
		}
		return {
			ok: true,
			authorization: {
				ok: true,
				allowTools: normalizeIrohRemoteAllowTools(client.allowedTools),
				client,
				paired: true,
				pairingSecretConsumed: false,
				workspace,
				workspaceNames: [workspace.name],
				workspaces: [{ name: workspace.name, status: "available" }],
			},
		};
	}

	private async handleRelayNotificationDelivery(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_notification_delivery" }>,
	): Promise<RelayPushDeliveryResult> {
		const notification = request.notification;
		if (notification.sessionId !== undefined && notification.sessionId !== request.sessionId) {
			return { ok: false, code: "session_mismatch", message: "notification session does not match relay session" };
		}
		if (notification.workspaceName !== undefined && notification.workspaceName !== request.workspaceName) {
			return {
				ok: false,
				code: "workspace_mismatch",
				message: "notification workspace does not match relay workspace",
			};
		}
		const authorization = await this.createRelayDeliveryAuthorization(connection, request);
		if (!authorization.ok) {
			return authorization;
		}
		const scopedNotification: IrohRemotePushNotificationIntent = {
			...notification,
			sessionId: notification.sessionId ?? request.sessionId,
			workspaceName: notification.workspaceName ?? request.workspaceName,
		};
		try {
			const status = await this.createPushNotificationDispatcher(authorization.authorization).deliverNotification(
				scopedNotification,
			);
			return { ok: true, status };
		} catch {
			return { ok: true, status: "failed" };
		}
	}

	private async handleRelayLiveActivityDelivery(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_live_activity_delivery" }>,
	): Promise<RelayPushDeliveryResult> {
		const contentState = request.update.contentState;
		if (contentState.sessionID !== request.sessionId) {
			return { ok: false, code: "session_mismatch", message: "Live Activity session does not match relay session" };
		}
		if (contentState.workspaceName !== request.workspaceName) {
			return {
				ok: false,
				code: "workspace_mismatch",
				message: "Live Activity workspace does not match relay workspace",
			};
		}
		const authorization = await this.createRelayDeliveryAuthorization(connection, request);
		if (!authorization.ok) {
			return authorization;
		}
		try {
			const status = await this.createPushNotificationDispatcher(
				authorization.authorization,
			).deliverLiveActivityUpdate(request.update);
			return { ok: true, status };
		} catch {
			return { ok: true, status: "failed" };
		}
	}

	/**
	 * Execute a state-touching RPC command forwarded from a TUI-owned relay
	 * against the daemon's real state (§5.6): push targets, live activities,
	 * and workspace unregistration must land here, not in the TUI's in-memory
	 * state copy.
	 */
	private async handleRelayRpc(
		connection: ControlConnection,
		request: Extract<ControlRequest, { type: "relay_rpc" }>,
	): Promise<
		| {
				ok: true;
				response: Record<string, unknown>;
				workspaceMetadata?: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> };
		  }
		| { ok: false; code: string; message: string }
	> {
		const relayAuthorization = this.relays.authorizeRpc(request.relayId, connection.connectionId, request);
		if (!relayAuthorization.ok) {
			return relayAuthorization;
		}
		const command = request.command;
		if (!RELAY_RPC_COMMAND_TYPES.has(command.type)) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		const client = await this.stateManager.getClient(request.clientNodeId);
		if (!client) {
			return { ok: false, code: "not_found", message: "paired client not found" };
		}
		const requiredCapabilities = getIrohRemoteRpcCommandCapabilities(command);
		if (requiredCapabilities === undefined) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		const missingCapability = getMissingIrohRemoteRpcCapability(client.rpcGrant, requiredCapabilities);
		if (missingCapability !== undefined) {
			return {
				ok: true,
				response: {
					...createIrohRemoteRpcCapabilityDeniedResponse(
						getRpcResponseId(command),
						command.type,
						missingCapability,
					),
				},
			};
		}
		const workspace = (await this.stateManager.getState()).workspaces.find(
			(candidate) => candidate.name === request.workspaceName,
		);
		if (!workspace) {
			return { ok: false, code: "not_found", message: `no registered workspace named ${request.workspaceName}` };
		}
		const authorization: IrohRemoteClientAuthorizationSuccess = {
			ok: true,
			allowTools: normalizeIrohRemoteAllowTools(client.allowedTools),
			client,
			paired: true,
			pairingSecretConsumed: false,
			workspace,
			workspaceNames: [workspace.name],
			workspaces: [{ name: workspace.name, status: "available" }],
		};
		const responseId = getRpcResponseId(command);
		if (command.type === "set_keep_awake" || command.type === "get_keep_awake") {
			const response = createKeepAwakeRpcResponse(command, this.getCommandContext());
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "set_web_search_key" || command.type === "get_web_search_status") {
			const response = createWebSearchKeyRpcResponse(command, this.getCommandContext());
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "register_push_target") {
			try {
				const data = await this.createPushNotificationDispatcher(authorization).registerPushTarget(command.args);
				return { ok: true, response: createRpcSuccessResponse(responseId, command.type, { ...data }) };
			} catch (error) {
				return {
					ok: true,
					response: {
						...createIrohRemoteRpcErrorResponse(
							responseId,
							command.type,
							error instanceof Error ? error.message : String(error),
						),
					},
				};
			}
		}
		if (command.type === "register_live_activity") {
			const response = await createRemoteRegisterLiveActivityRpcResponse(
				command,
				authorization,
				this.getCommandContext(),
				request.sessionId,
			);
			return { ok: true, response: response as Record<string, unknown> };
		}
		if (command.type === "unregister_live_activity") {
			const response = await createRemoteUnregisterLiveActivityRpcResponse(
				command,
				authorization,
				this.getCommandContext(),
				request.sessionId,
			);
			return { ok: true, response: response as Record<string, unknown> };
		}
		// unregister_workspace: run against the daemon state with the shared host
		// cleanup, keeping the requesting conversation's own relays open so the
		// response can still be delivered over them.
		const excludeRelayIds = new Set(
			this.relays
				.forConversation(request.clientNodeId, request.workspaceName, request.sessionId, "active")
				.map((relay) => relay.relayId),
		);
		const context: ConversationCommandContext = {
			...this.getCommandContext(),
			onWorkspaceUnregistered: async (workspaceName) => {
				await this.cleanupUnregisteredWorkspace(workspaceName, {
					relayIds: excludeRelayIds,
					workspacePath: workspace.path,
				});
			},
		};
		const response = await handleRemoteHostRpcCommand(command, authorization, context);
		if (!response) {
			return { ok: false, code: "unsupported", message: `unsupported relay rpc command: ${command.type}` };
		}
		return {
			ok: true,
			response: response as Record<string, unknown>,
			workspaceMetadata: {
				workspaceNames: [...authorization.workspaceNames],
				workspaces: authorization.workspaces.map((entry) => ({ name: entry.name, status: entry.status })),
			},
		};
	}

	private async requireEngineSafe(): Promise<
		{ ok: true; engine: IrohRemoteHostEngine } | { ok: false; error: string }
	> {
		try {
			await withTimeout(
				this.ready.promise,
				IROH_ENDPOINT_READY_TIMEOUT_MS,
				"Iroh endpoint did not become ready within 15s",
			);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!this.engine) {
			return { ok: false, error: "iroh host engine is not ready" };
		}
		return { ok: true, engine: this.engine };
	}

	private cancelPendingPairing(requestId: string, pending: PendingPairRequest): Promise<void> {
		if (this.pendingPairRequests.get(requestId) !== pending) {
			return Promise.resolve();
		}
		if (pending.cancellation) {
			return pending.cancellation;
		}
		clearTimeout(pending.timer);
		const cancellation = (async () => {
			if (this.engine) {
				await this.engine.cancelPairingSecretByHash(pending.secretHash);
			} else {
				await this.stateManager.removePendingPairingTicket(pending.secretHash);
			}
			await this.services.state.flush();
			if (this.pendingPairRequests.get(requestId) === pending) {
				this.pendingPairRequests.delete(requestId);
			}
		})();
		pending.cancellation = cancellation;
		void cancellation.catch(() => {
			if (pending.cancellation === cancellation) {
				pending.cancellation = undefined;
			}
		});
		return cancellation;
	}

	onControlConnectionClosed(connection: ControlConnection): void {
		this.leaseBroker.releaseAllForConnection(connection.connectionId);
		const admission = this.admission.tryAcquire();
		if (!admission) {
			// Quiesce owns every remaining ticket after the admission cut. A final
			// control-socket close must never launch a durable write after state.close().
			return;
		}
		const cancellations = Array.from(this.pendingPairRequests)
			.filter(([, pending]) => pending.connectionId === connection.connectionId)
			.map(async ([requestId, pending]) => {
				try {
					await this.cancelPendingPairing(requestId, pending);
				} catch (error) {
					this.log("warn", "failed to cancel pairing after control disconnect", {
						requestId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
		void Promise.all(cancellations).finally(() => admission.release());
	}

	admitRelay(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer): boolean {
		return this.relays.admit(relayId, relayToken, socket, bufferedRemainder);
	}

	statusExtras(): { leases: ControlLeaseStatus[]; phoneConnections: number; relayCount: number } {
		const leases: ControlLeaseStatus[] = this.leaseBroker.list().map((record) => ({
			workspaceName: record.workspaceName,
			sessionId: record.sessionId,
			state: record.state,
			relayCount: record.relayIds.size,
			streamCount: record.streamCount,
		}));
		return { leases, phoneConnections: this.clientConnections.size, relayCount: this.relays.activeCount() };
	}

	async quiesce(): Promise<void> {
		// Close the service-wide epoch before any snapshot or await. New streams,
		// ownership commits, relay offers, and turn-starting commands now fail
		// closed against the same state.
		this.admission.close();
		this.worktreeRetention.dispose();
		// Freeze expiry callbacks at the same cut. Once admission is closed, no
		// disconnect callback may mutate durable pairing state; quiesce becomes the
		// sole owner of every ticket still published in this map.
		for (const pending of this.pendingPairRequests.values()) {
			clearTimeout(pending.timer);
		}
		// 1. Stop accepting, then close every published conversation transport
		//    through its coordinator. Offered and redeemed relays share this same
		//    terminal path and therefore preserve the host_shutdown reason.
		const streamClosures: Promise<void>[] = this.conversationCoordinators
			.values()
			.map((coordinator) => coordinator.closeTransports("host_shutdown").then(() => undefined));
		// Retire every accepted physical stream, including handshakes and attach
		// operations that have not reached the active-stream registry yet.
		const activeEntries = this.activeStreams.allEntries();
		for (const entry of activeEntries) {
			this.activeStreams.unregister(entry);
		}
		for (const entry of activeEntries) {
			const coordinator = this.conversationCoordinators.get(entry.workspaceName, entry.sessionId);
			if (!coordinator) {
				try {
					streamClosures.push(Promise.resolve(entry.close("host_shutdown")));
				} catch {}
			}
		}
		const ownedStreams = Array.from(this.physicalStreamOwners.entries());
		for (const [, owner] of ownedStreams) {
			try {
				streamClosures.push(owner.close("host_shutdown"));
			} catch {}
		}

		// Every operation admitted by the old epoch either published before the
		// close (and is in the snapshots above) or observes a stale lease, rolls
		// back, and releases here. No runtime can appear after the next snapshot.
		await this.admission.waitForDrain();
		// Control request admission was drained before extension quiesce began, and
		// the service gate now rejects disconnect-owned cancellation work. Therefore
		// this is a fixed producer-free set: settle it completely before state.close.
		const pendingPairingResults = await Promise.allSettled(
			Array.from(this.pendingPairRequests, ([requestId, pending]) => this.cancelPendingPairing(requestId, pending)),
		);
		const pendingPairingFailures = pendingPairingResults.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		for (const failure of pendingPairingFailures) {
			this.log("warn", "failed to cancel pending pairing during quiesce", {
				error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
			});
		}

		// 2. Wait for busy runtimes to go idle (60s cap each, concurrently);
		//    never abort prompt preflight or a turn from shutdown.
		const drainResults = await Promise.allSettled(
			this.runtimes
				.values()
				.filter((entry) => entry.runtime.session.isBusy)
				.map((entry) =>
					withTimeout(entry.runtime.session.waitForIdle(), SHUTDOWN_RUNTIME_IDLE_CAP_MS, "drain cap"),
				),
		);
		const cappedRuntimes = drainResults.filter((result) => result.status === "rejected").length;
		// 3. Wait for stream-local projection/RPC modes and their outer subscriber
		//    detach before disposing runtime-owned feeds.
		await Promise.allSettled(streamClosures);
		for (const [streamId, owner] of ownedStreams) {
			if (this.physicalStreamOwners.get(streamId) === owner) {
				this.physicalStreamOwners.delete(streamId);
			}
		}
		// 4. Close all remaining client connections and join their admitted
		//    application children. Connection.closed(), accept-loop settlement,
		//    and endpoint closure are native tails owned by bounded dispose().
		const supervisors = Array.from(this.connectionSupervisors.values());
		for (const nodeId of Array.from(this.clientConnections.keys())) {
			this.closeClientConnectionsForClient(nodeId, "host_shutdown");
		}
		await Promise.allSettled(supervisors.map((supervisor) => supervisor.sealAndWaitForChildren()));
		// 5. Flush + dispose runtimes through the normal dispose path only after
		//    every accepted management/conversation child has stopped mutating.
		await this.runtimes.stopAll("host_shutdown");
		await this.services.auditLogger.flush().catch(() => {});
		this.log("info", "iroh service quiesced", { cappedRuntimes });
		if (pendingPairingFailures.length > 0) {
			throw new AggregateError(
				pendingPairingFailures.map((failure) => failure.reason),
				"pending pairing cleanup failed",
			);
		}
	}

	async dispose(): Promise<void> {
		const endpoints = new Set(
			[this.endpoint, this.startupEndpoint].filter(
				(endpoint): endpoint is IrohEndpointLike => endpoint !== undefined,
			),
		);
		this.endpoint = undefined;
		this.startupEndpoint = undefined;
		const endpointDisposals = Array.from(endpoints, (endpoint) =>
			this.retireEndpoint(endpoint, "iroh endpoint disposal failed"),
		);
		await Promise.allSettled([this.startupTask, ...endpointDisposals]);
		// The accept loop is the last producer of connection tasks and closed-gate
		// refusal tasks. Join it before taking the final disposal snapshots, then
		// drain to a fixed point because connection settlement can still enqueue a
		// raw native tail. The daemon's outer extension deadline bounds this whole
		// native phase.
		await this.acceptLoopTask;
		while (this.connectionTasks.size > 0 || this.nativeLifecycleTasks.size > 0) {
			await Promise.allSettled([...this.connectionTasks, ...this.nativeLifecycleTasks]);
		}
		await this.services.auditLogger.flush().catch(() => {});
		this.log("info", "iroh service stopped");
	}

	private async logAudit(event: Parameters<VoltdRuntimeServices["auditLogger"]["log"]>[0]): Promise<void> {
		try {
			await this.services.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort.
		}
	}
}
