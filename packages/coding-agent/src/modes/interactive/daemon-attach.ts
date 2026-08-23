import { basename, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { VERSION } from "../../config.ts";
import type {
	IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationIntent,
} from "../../core/remote/iroh/push.ts";
import { createDaemonClient, type DaemonClient } from "../../daemon/control-client.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlEvent,
	type ControlResponse,
	type ControlWorktreeStatus,
	type LeaseReleaseReason,
	type LeaseState,
	type RelayPreamble,
} from "../../daemon/control-protocol.ts";
import { getDaemonSocketPath } from "../../daemon/paths.ts";
import {
	type EnsureDaemonResult,
	ensureDaemonRunning,
	probeDaemon,
	readPublishedDaemonEndpoint,
} from "../../daemon/spawn.ts";
import { isPathInside } from "../../daemon/workspace-directory.ts";
import { getWorktreesRoot } from "../../daemon/worktree-manager.ts";

export type DaemonAttachConnectionState = "connected" | "reconnecting" | "gone" | "disabled";

export type AcquireOutcome =
	| { kind: "granted"; handoff: "cold" | "warm" | "none" }
	| { kind: "pending"; viewerFeedId: string; granted: Promise<{ handoff: "cold" | "warm" | "none" }> }
	| { kind: "denied"; reason: string }
	| { kind: "noop" };

export interface DaemonRelayOffer {
	relayId: string;
	relayToken: string;
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	streamId: string;
}

export interface OpenedRelay {
	preamble: RelayPreamble;
	stream: Duplex;
	/** Mark the relay finished locally (updates the footer count). */
	finished(): void;
}

export interface RelayRpcForwardResult {
	/** verbatim RPC response object to forward to the phone */
	response: Record<string, unknown>;
	/** refreshed workspace metadata after a successful unregister_workspace */
	workspaceMetadata?: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> };
}

export interface RelayWorkspaceUnregisterRetirement {
	isIngressOpen(): boolean;
	observeForwardedResponse(command: Record<string, unknown>, response: Record<string, unknown>): void;
	onResponseWritten(response: Record<string, unknown>): Promise<void>;
	finalize(): Promise<void>;
}

export function createRelayWorkspaceUnregisterRetirement(
	daemonAttach: Pick<DaemonAttach, "release">,
	getSessionId: () => string,
): RelayWorkspaceUnregisterRetirement {
	let workspaceUnregistered = false;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= daemonAttach.release(getSessionId(), "workspace_unregistered");
		return releasePromise;
	};
	return {
		isIngressOpen: () => !workspaceUnregistered,
		observeForwardedResponse(command, response) {
			if (
				command.type === "unregister_workspace" &&
				response.type === "response" &&
				response.command === "unregister_workspace" &&
				response.success === true
			) {
				workspaceUnregistered = true;
			}
		},
		async onResponseWritten(response) {
			if (workspaceUnregistered && response.command === "unregister_workspace" && response.success === true) {
				await release();
			}
		},
		async finalize() {
			if (workspaceUnregistered) {
				await release();
			}
		},
	};
}

export interface RelayNotificationDeliveryForwarder {
	deliverNotification(
		clientNodeId: string,
		sessionId: string,
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
}

export interface DaemonAttachRekeyTransaction {
	commit(): Promise<void>;
	rollback(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * TUI-side daemon integration façade. Ordinary best-effort methods resolve as
 * no-ops when the daemon is unavailable. Rekeys reserve their target before a
 * runtime replacement and publish it only after the replacement is ready.
 */
export interface DaemonAttach {
	/** Connect, resolve (or auto-register) the cwd workspace. Never throws. */
	start(): Promise<void>;
	acquire(sessionId: string): Promise<AcquireOutcome>;
	release(sessionId: string, reason?: LeaseReleaseReason): Promise<void>;
	prepareRekey(
		oldSessionId: string,
		newSessionId: string,
		targetCwd?: string,
	): Promise<DaemonAttachRekeyTransaction | undefined>;
	/**
	 * Forward a state-touching RPC command from a relayed phone conversation to
	 * the daemon (push targets and workspace unregister). Returns
	 * undefined when the daemon is unreachable or rejected the request.
	 */
	forwardRelayRpc(
		clientNodeId: string,
		sessionId: string,
		command: Record<string, unknown> & { type: string },
	): Promise<RelayRpcForwardResult | undefined>;
	/** Deliver relayed completion pushes through the daemon-owned push backend. */
	relayNotificationDelivery: RelayNotificationDeliveryForwarder;
	/** Viewer feed subscription (drain overlay). */
	viewerSubscribe(viewerFeedId: string): Promise<void>;
	viewerUnsubscribe(viewerFeedId: string): Promise<void>;
	viewerAbort(viewerFeedId: string): Promise<void>;
	onRelayOffer(handler: (offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void): void;
	onEvent(handler: (event: ControlEvent) => void): () => void;
	/** Re-acquire outcomes after a daemon reconnect (session.reload on warm). */
	onReacquired(handler: (sessionId: string, outcome: AcquireOutcome) => void): void;
	relayCount(): number;
	onRelayCountChange(callback: (count: number) => void): void;
	connectionState(): DaemonAttachConnectionState;
	workspaceName(): string | undefined;
	setWorktreeContext(workspaceName: string, worktreeId: string): () => void;
	/** Live runtime ownership for sessions in a workspace, sourced from daemon status. */
	listRuntimeStates(workspaceName: string): Promise<ReadonlyMap<string, Exclude<LeaseState, "unowned">>>;
	dispose(): Promise<void>;
}

const NOOP_OUTCOME: AcquireOutcome = { kind: "noop" };

/**
 * Resolve the registered workspace for a cwd against the daemon: longest
 * path-prefix match first, then (§5.2.2) a worktree_resolve lookup so a TUI
 * launched inside a daemon-managed worktree binds to the PARENT workspace
 * instead of auto-registering a bogus workspace under ~/.volt/agent/worktrees.
 * Only when both miss is the cwd auto-registered.
 */
export async function resolveDaemonWorkspaceForCwd(
	client: Pick<DaemonClient, "request">,
	cwd: string,
	log: (message: string) => void = () => {},
): Promise<{ name: string; path: string; worktreeId?: string } | undefined> {
	const status = await client.request({ type: "status" });
	if (status.type !== "status_result") {
		return undefined;
	}
	const resolvedCwd = resolve(cwd);
	// A cwd inside a daemon-managed worktree belongs to the worktree's parent
	// workspace; auto-registering it would split lease keys from the daemon's
	// conversations for the same sessions.
	try {
		const resolved = await client.request({ type: "worktree_resolve", path: resolvedCwd });
		if (resolved.type === "worktree_resolve_result") {
			return { name: resolved.workspaceName, path: resolved.workspacePath, worktreeId: resolved.worktreeId };
		}
	} catch {
		// Old daemon (unknown request) or transient failure: fall through.
	}
	const match = status.workspaces
		.filter((workspace) => isPathInside(workspace.path, resolvedCwd))
		.sort((left, right) => right.path.length - left.path.length)[0];
	if (match) {
		return { name: match.name, path: match.path };
	}
	// Auto-register the cwd so phones can reach sessions opened here.
	const takenNames = new Set(status.workspaces.map((workspace) => workspace.name));
	const base = basename(resolvedCwd) || "workspace";
	let candidate = base;
	for (let suffix = 2; takenNames.has(candidate); suffix++) {
		candidate = `${base}-${suffix}`;
	}
	const registered = await client.request({ type: "workspace_register", name: candidate, path: resolvedCwd });
	if (registered.type === "ok") {
		log(`registered workspace ${candidate} -> ${resolvedCwd}`);
		return { name: candidate, path: resolvedCwd };
	}
	return undefined;
}

/**
 * Sanitizer roots for serving a relayed conversation from the TUI: a
 * worktree-bound conversation sanitizes with the worktree checkout as the
 * root, and the parent checkout plus the worktrees root must ALSO redact
 * (bash output like `git worktree list` prints both). §5.2.3.
 */
export function getRelayServingSanitizerOptions(
	authorization: RelayPreamble["authorization"],
	agentDir: string,
): { remoteWorkspacePath?: string; workspacePath: string; additionalRedactedPaths?: string[] } {
	if (authorization.worktreePath === undefined) {
		return { workspacePath: authorization.workspacePath };
	}
	return {
		...(authorization.worktreeSourceRootRelativePath === undefined
			? {}
			: { remoteWorkspacePath: `/workspace/${authorization.worktreeSourceRootRelativePath}` }),
		workspacePath: authorization.worktreePath,
		additionalRedactedPaths: [authorization.workspacePath, getWorktreesRoot(agentDir)],
	};
}

export interface DaemonWorktreeControl {
	workspaceName: string;
	workspacePath: string;
	listWorktrees(): Promise<ControlWorktreeStatus[]>;
	createWorktree(name?: string): Promise<{ ok: true; worktree: ControlWorktreeStatus } | { ok: false; error: string }>;
	/** Best-effort: records the session→worktree binding in daemon state. */
	bindSession(worktreeId: string, sessionId: string): Promise<boolean>;
	close(): Promise<void>;
}

export interface OpenDaemonWorktreeControlOptions {
	cwd: string;
	agentDir: string;
	/** Injectable for tests; defaults to ensureDaemonRunning. */
	ensureDaemon?: (agentDir: string) => Promise<EnsureDaemonResult>;
}

/**
 * Control-plane handle for the TUI /worktree command (§5.2.1): ensures the
 * daemon is running, resolves (or registers) the parent workspace for the
 * cwd, and exposes worktree list/create/bind over the control socket.
 */
export async function openDaemonWorktreeControl(
	options: OpenDaemonWorktreeControlOptions,
): Promise<{ ok: true; control: DaemonWorktreeControl } | { ok: false; error: string }> {
	const ensureDaemon = options.ensureDaemon ?? ensureDaemonRunning;
	let ensured: EnsureDaemonResult;
	try {
		ensured = await ensureDaemon(options.agentDir);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!ensured.healthy) {
		return { ok: false, error: `voltd is not available (${ensured.state}); try \`volt daemon start\`` };
	}
	const client = createDaemonClient({
		socketPath: ensured.socketPath ?? getDaemonSocketPath(options.agentDir),
		client: "tui",
		version: VERSION,
		authToken: ensured.authToken,
		reconnect: false,
		capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
	});
	try {
		await client.connect();
		const workspace = await resolveDaemonWorkspaceForCwd(client, options.cwd);
		if (!workspace) {
			await client.close();
			return { ok: false, error: "could not resolve or register a workspace for the current directory" };
		}
		const control: DaemonWorktreeControl = {
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			async listWorktrees() {
				const response = await client.request({ type: "worktree_list", workspaceName: workspace.name });
				return response.type === "worktrees_result" ? response.worktrees : [];
			},
			async createWorktree(name?: string) {
				const response = await client.request({
					type: "worktree_create",
					workspaceName: workspace.name,
					...(name === undefined ? {} : { worktreeName: name }),
				});
				if (response.type === "worktree_result") {
					return { ok: true, worktree: response.worktree };
				}
				const error =
					response.type === "error" ? `${response.code}: ${response.message}` : "unexpected daemon response";
				return { ok: false, error };
			},
			async bindSession(worktreeId: string, sessionId: string) {
				try {
					const response = await client.request({
						type: "worktree_bind",
						workspaceName: workspace.name,
						worktreeId,
						sessionId,
					});
					return response.type === "ok";
				} catch {
					return false;
				}
			},
			close: () => client.close(),
		};
		return { ok: true, control };
	} catch (error) {
		await client.close().catch(() => {});
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function createDisabledDaemonAttach(): DaemonAttach {
	return {
		async start() {},
		async acquire() {
			return NOOP_OUTCOME;
		},
		async release() {},
		async prepareRekey() {
			return undefined;
		},
		async forwardRelayRpc() {
			return undefined;
		},
		relayNotificationDelivery: {
			async deliverNotification() {
				return "failed";
			},
		},
		async viewerSubscribe() {},
		async viewerUnsubscribe() {},
		async viewerAbort() {},
		onRelayOffer() {},
		onEvent() {
			return () => {};
		},
		onReacquired() {},
		relayCount() {
			return 0;
		},
		onRelayCountChange() {},
		connectionState() {
			return "disabled";
		},
		workspaceName() {
			return undefined;
		},
		setWorktreeContext() {
			return () => {};
		},
		async listRuntimeStates() {
			return new Map();
		},
		async dispose() {},
	};
}

export interface CreateDaemonAttachOptions {
	cwd: string;
	agentDir: string;
	/** Auto-spawn the daemon when unreachable (remote.background). */
	autoStart?: boolean;
	log?: (message: string) => void;
}

export function createDaemonAttach(options: CreateDaemonAttachOptions): DaemonAttach {
	let client: DaemonClient | undefined;
	let state: DaemonAttachConnectionState = "reconnecting";
	let connectionGeneration = 0;
	let resolvedWorkspaceName: string | undefined;
	let resolvedContextCwd = options.cwd;
	let resolvedWorktreeId: string | undefined;
	let boundWorktreeSessionId: string | undefined;
	let stagedWorktreeContext: { workspaceName: string; worktreeId: string } | undefined;
	let activeRelays = 0;
	const activeRelayIds = new Map<string, string>();
	let currentSessionId: string | undefined;
	let heldSessionId: string | undefined;
	let pendingRekeyTransactionId: string | undefined;
	let disposed = false;
	let resolvingWorkspace: Promise<void> | undefined;
	const eventHandlers = new Set<(event: ControlEvent) => void>();
	const relayCountCallbacks = new Set<(count: number) => void>();
	let relayOfferHandler: ((offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>) => void) | undefined;
	let reacquiredHandler: ((sessionId: string, outcome: AcquireOutcome) => void) | undefined;

	const log = options.log ?? (() => {});

	const setRelayCount = (next: number) => {
		if (next === activeRelays) {
			return;
		}
		activeRelays = next;
		for (const callback of Array.from(relayCountCallbacks)) {
			callback(next);
		}
	};

	const parseAcquireResponse = (
		response: { type: string } & Record<string, unknown>,
		waitForResponse: (id: string) => Promise<{ type: string } & Record<string, unknown>>,
	): AcquireOutcome => {
		if (response.type === "lease_granted") {
			return { kind: "granted", handoff: response.handoff as "cold" | "warm" | "none" };
		}
		if (response.type === "lease_denied") {
			return { kind: "denied", reason: String(response.reason) };
		}
		if (response.type === "lease_pending") {
			const id = String(response.id);
			return {
				kind: "pending",
				viewerFeedId: String(response.viewerFeedId),
				granted: waitForResponse(id).then((terminal) => {
					if (terminal.type === "lease_granted") {
						return { handoff: terminal.handoff as "cold" | "warm" | "none" };
					}
					throw new Error(typeof terminal.message === "string" ? terminal.message : "lease drain failed");
				}),
			};
		}
		return NOOP_OUTCOME;
	};

	const trackAcquireOutcome = (sessionId: string, outcome: AcquireOutcome): void => {
		if (outcome.kind === "granted") {
			heldSessionId = sessionId;
			return;
		}
		if (outcome.kind === "pending") {
			void outcome.granted.then(
				() => {
					if (currentSessionId === sessionId && !pendingRekeyTransactionId) {
						heldSessionId = sessionId;
					}
				},
				() => {},
			);
			return;
		}
		if (heldSessionId === sessionId) {
			heldSessionId = undefined;
		}
	};

	const relayKey = (clientNodeId: string, sessionId: string) => `${clientNodeId}\0${sessionId}`;

	const handleRelayOffer = (offer: DaemonRelayOffer) => {
		const handler = relayOfferHandler;
		const activeClient = client;
		if (!handler || !activeClient) {
			return;
		}
		handler(offer, async () => {
			const opened = await activeClient.openRelay({ relayId: offer.relayId, relayToken: offer.relayToken });
			const key = relayKey(offer.clientNodeId, offer.sessionId);
			activeRelayIds.set(key, offer.relayId);
			setRelayCount(activeRelays + 1);
			let finished = false;
			const finish = () => {
				if (!finished) {
					finished = true;
					if (activeRelayIds.get(key) === offer.relayId) {
						activeRelayIds.delete(key);
					}
					setRelayCount(Math.max(0, activeRelays - 1));
				}
			};
			opened.stream.once("close", finish);
			return { preamble: opened.preamble, stream: opened.stream, finished: finish };
		});
	};

	const resolveWorkspace = async (): Promise<void> => {
		if (resolvedWorkspaceName) return;
		if (resolvingWorkspace) {
			return resolvingWorkspace;
		}
		resolvingWorkspace = (async () => {
			const activeClient = client;
			if (!activeClient) {
				return;
			}
			const workspace = await resolveDaemonWorkspaceForCwd(activeClient, resolvedContextCwd, log);
			if (workspace) {
				resolvedWorkspaceName = workspace.name;
				resolvedWorktreeId = workspace.worktreeId;
			}
		})().finally(() => {
			resolvingWorkspace = undefined;
		});
		return resolvingWorkspace;
	};

	const ensureWorktreeBinding = async (
		activeClient: DaemonClient,
		workspaceName: string,
		sessionId: string,
		acquireLease = true,
	): Promise<boolean> => {
		if (!resolvedWorktreeId || (boundWorktreeSessionId === sessionId && !acquireLease)) return true;
		const response = await activeClient.request({
			type: "worktree_bind",
			workspaceName,
			worktreeId: resolvedWorktreeId,
			sessionId,
			acquireLease,
		});
		if (response.type !== "ok") return false;
		boundWorktreeSessionId = sessionId;
		return true;
	};

	const ensureLeaseAfterConnected = async (): Promise<void> => {
		await resolveWorkspace();
		const sessionId = currentSessionId;
		const workspaceName = resolvedWorkspaceName;
		const activeClient = client;
		if (!sessionId || !workspaceName || !activeClient || !reacquiredHandler || pendingRekeyTransactionId) {
			return;
		}
		try {
			if (!(await ensureWorktreeBinding(activeClient, workspaceName, sessionId))) {
				const outcome: AcquireOutcome = { kind: "denied", reason: "worktree_busy" };
				trackAcquireOutcome(sessionId, outcome);
				reacquiredHandler(sessionId, outcome);
				return;
			}
			const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
			const outcome = parseAcquireResponse(
				response as { type: string } & Record<string, unknown>,
				(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
			);
			trackAcquireOutcome(sessionId, outcome);
			reacquiredHandler(sessionId, outcome);
		} catch {
			// The next reconnect retries.
		}
	};

	return {
		async start() {
			if (disposed) {
				return;
			}
			try {
				const ensured = options.autoStart
					? await ensureDaemonRunning(options.agentDir)
					: await probeDaemon(options.agentDir);
				if (disposed) {
					return;
				}
				const socketPath = ensured.socketPath;
				if (options.autoStart && ensured.state === "protocol-mismatch") {
					state = "gone";
					return;
				}
				const startingClient = createDaemonClient({
					socketPath: socketPath ?? getDaemonSocketPath(options.agentDir),
					client: "tui",
					version: VERSION,
					authToken: ensured.authToken,
					refreshEndpoint: () => readPublishedDaemonEndpoint(options.agentDir),
					capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
					reconnect: true,
					onEvent: (event) => {
						if (event.type === "relay_offer") {
							handleRelayOffer(event);
						}
						if (event.type === "relay_closed") {
							// The socket close callback decrements the count; nothing to do
							// beyond fanning the event out.
						}
						if (event.type === "daemon_shutdown") {
							setRelayCount(0);
						}
						for (const handler of Array.from(eventHandlers)) {
							handler(event);
						}
					},
					onConnectionStateChange: (next) => {
						state = next;
						if (next !== "connected") {
							connectionGeneration++;
							heldSessionId = undefined;
						}
						if (next === "connected") {
							void ensureLeaseAfterConnected().catch(() => {});
						}
					},
				});
				client = startingClient;
				await startingClient.connect();
				if (disposed || client !== startingClient) {
					await startingClient.close();
					return;
				}
				state = "connected";
				await ensureLeaseAfterConnected();
			} catch (error) {
				log(`daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
				state = client?.connectionState ?? "gone";
			}
		},
		async acquire(sessionId: string) {
			currentSessionId = sessionId;
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName || state !== "connected") {
				return NOOP_OUTCOME;
			}
			try {
				if (!(await ensureWorktreeBinding(activeClient, workspaceName, sessionId))) {
					return { kind: "denied", reason: "worktree_busy" };
				}
				const response = await activeClient.request({ type: "lease_acquire", workspaceName, sessionId });
				const outcome = parseAcquireResponse(
					response as { type: string } & Record<string, unknown>,
					(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
				);
				trackAcquireOutcome(sessionId, outcome);
				return outcome;
			} catch {
				return NOOP_OUTCOME;
			}
		},
		async release(sessionId: string, reason = "quit") {
			if (currentSessionId === sessionId) {
				currentSessionId = undefined;
			}
			if (heldSessionId === sessionId) {
				heldSessionId = undefined;
			}
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			if (!activeClient || !workspaceName) {
				return;
			}
			try {
				await activeClient.request({ type: "lease_release", workspaceName, sessionId, reason });
			} catch {
				// Daemon-side implicit release on disconnect covers this.
			}
		},
		async prepareRekey(oldSessionId: string, newSessionId: string, targetCwd?: string) {
			if (oldSessionId === newSessionId) {
				return undefined;
			}
			if (pendingRekeyTransactionId) {
				throw new Error("conversation lease rekey already in progress");
			}
			const previousWorkspaceName = resolvedWorkspaceName;
			const previousContextCwd = resolvedContextCwd;
			const previousWorktreeId = resolvedWorktreeId;
			const previousBoundWorktreeSessionId = boundWorktreeSessionId;
			const activeClient = client;
			pendingRekeyTransactionId = "resolving-context";
			let targetContext: Awaited<ReturnType<typeof resolveDaemonWorkspaceForCwd>>;
			try {
				targetContext =
					activeClient && state === "connected"
						? await resolveDaemonWorkspaceForCwd(activeClient, targetCwd ?? options.cwd, log)
						: stagedWorktreeContext
							? {
									name: stagedWorktreeContext.workspaceName,
									path: targetCwd ?? options.cwd,
									worktreeId: stagedWorktreeContext.worktreeId,
								}
							: undefined;
			} catch (error) {
				pendingRekeyTransactionId = undefined;
				throw error;
			}
			stagedWorktreeContext = undefined;
			resolvedContextCwd = targetCwd ?? options.cwd;
			if (targetContext) {
				resolvedWorkspaceName = targetContext.name;
				resolvedWorktreeId = targetContext.worktreeId;
				boundWorktreeSessionId = undefined;
			} else if (!activeClient || state !== "connected") {
				resolvedWorkspaceName = undefined;
				resolvedWorktreeId = undefined;
				boundWorktreeSessionId = undefined;
			}
			const workspaceName = resolvedWorkspaceName;
			const contextChanged = workspaceName !== previousWorkspaceName || resolvedWorktreeId !== previousWorktreeId;
			const sourceLeaseConnectionGeneration = connectionGeneration;
			let targetLeasePreacquired = false;
			let targetLeaseConnectionGeneration: number | undefined;
			const preacquireTargetLease = async (): Promise<void> => {
				if (!activeClient || !workspaceName || state !== "connected") {
					throw new Error("replacement session lease was not acquired");
				}
				let targetAcquireStarted = false;
				try {
					targetAcquireStarted = true;
					if (!(await ensureWorktreeBinding(activeClient, workspaceName, newSessionId, true))) {
						throw new Error("replacement session could not be bound to its worktree");
					}
					const targetAcquireResponse = await activeClient.request({
						type: "lease_acquire",
						workspaceName,
						sessionId: newSessionId,
					});
					const targetAcquire = parseAcquireResponse(
						targetAcquireResponse as { type: string } & Record<string, unknown>,
						(id) => activeClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
					);
					if (targetAcquire.kind === "denied" || targetAcquire.kind === "noop") {
						throw new Error(
							targetAcquire.kind === "denied"
								? `replacement session lease denied: ${targetAcquire.reason}`
								: "replacement session lease was not acquired",
						);
					}
					if (targetAcquire.kind === "pending") await targetAcquire.granted;
					targetLeasePreacquired = true;
					targetLeaseConnectionGeneration = connectionGeneration;
				} catch (error) {
					if (targetAcquireStarted) {
						await activeClient
							.request({
								type: "lease_release",
								workspaceName,
								sessionId: newSessionId,
								reason: "switch",
							})
							.catch(() => {});
					}
					throw error;
				}
			};
			if (contextChanged && activeClient && workspaceName && state === "connected") {
				try {
					await preacquireTargetLease();
				} catch (error) {
					pendingRekeyTransactionId = undefined;
					resolvedWorkspaceName = previousWorkspaceName;
					resolvedContextCwd = previousContextCwd;
					resolvedWorktreeId = previousWorktreeId;
					boundWorktreeSessionId = previousBoundWorktreeSessionId;
					if (state === "connected" && heldSessionId !== oldSessionId) {
						await ensureLeaseAfterConnected().catch(() => {});
					}
					throw error;
				}
			}
			let prepared: ControlResponse | undefined;
			if (
				heldSessionId === oldSessionId &&
				activeClient &&
				workspaceName &&
				state === "connected" &&
				!contextChanged
			) {
				prepared = await activeClient.request({
					type: "lease_rekey_prepare",
					workspaceName,
					oldSessionId,
					newSessionId,
				});
				if (prepared.type !== "lease_rekey_prepared") {
					if (prepared.type === "error" && prepared.code === "target_in_use") {
						try {
							// An existing daemon-owned conversation is a warm-switch target,
							// not a new identity to overwrite. Acquire it through the normal
							// drain/takeover path while retaining the source for rollback.
							await preacquireTargetLease();
						} catch (error) {
							pendingRekeyTransactionId = undefined;
							resolvedWorkspaceName = previousWorkspaceName;
							resolvedContextCwd = previousContextCwd;
							resolvedWorktreeId = previousWorktreeId;
							boundWorktreeSessionId = previousBoundWorktreeSessionId;
							throw error;
						}
					} else {
						pendingRekeyTransactionId = undefined;
						resolvedWorkspaceName = previousWorkspaceName;
						resolvedContextCwd = previousContextCwd;
						resolvedWorktreeId = previousWorktreeId;
						boundWorktreeSessionId = previousBoundWorktreeSessionId;
						throw new Error(
							prepared.type === "error"
								? prepared.message
								: `unexpected daemon response to conversation lease rekey preflight: ${prepared.type}`,
						);
					}
				}
			}
			if (
				heldSessionId !== oldSessionId ||
				!activeClient ||
				!workspaceName ||
				state !== "connected" ||
				contextChanged ||
				targetLeasePreacquired
			) {
				pendingRekeyTransactionId = "local";
				const previousHeldSessionId = heldSessionId;
				let phase: "prepared" | "committed" | "rolled_back" | "disposed" = "prepared";
				return {
					async commit() {
						if (phase !== "prepared") {
							return;
						}
						if (!resolvedWorkspaceName && state === "connected") await resolveWorkspace();
						if (targetLeasePreacquired && targetLeaseConnectionGeneration !== connectionGeneration) {
							const reconnectClient = client;
							const reconnectWorkspaceName = resolvedWorkspaceName;
							if (!reconnectClient || !reconnectWorkspaceName || state !== "connected") {
								throw new Error("replacement session lease was lost during reconnect");
							}
							if (!(await ensureWorktreeBinding(reconnectClient, reconnectWorkspaceName, newSessionId, true))) {
								throw new Error("replacement session lease could not be reacquired");
							}
							const response = await reconnectClient.request({
								type: "lease_acquire",
								workspaceName: reconnectWorkspaceName,
								sessionId: newSessionId,
							});
							const outcome = parseAcquireResponse(
								response as { type: string } & Record<string, unknown>,
								(id) =>
									reconnectClient.waitForResponse(id) as Promise<{ type: string } & Record<string, unknown>>,
							);
							if (outcome.kind === "denied" || outcome.kind === "noop") {
								throw new Error("replacement session lease could not be reacquired");
							}
							if (outcome.kind === "pending") await outcome.granted;
							targetLeaseConnectionGeneration = connectionGeneration;
						}
						const bindClient = client;
						const bindWorkspaceName = resolvedWorkspaceName;
						if (
							bindClient &&
							bindWorkspaceName &&
							!(await ensureWorktreeBinding(
								bindClient,
								bindWorkspaceName,
								newSessionId,
								!targetLeasePreacquired,
							))
						) {
							throw new Error("replacement session could not be bound to its worktree");
						}
						currentSessionId = newSessionId;
						heldSessionId = undefined;
						const connectedClient = client;
						const connectedWorkspaceName = resolvedWorkspaceName;
						if (connectedClient && connectedWorkspaceName && state === "connected") {
							try {
								await connectedClient.request({
									type: "lease_release",
									workspaceName: previousWorkspaceName ?? connectedWorkspaceName,
									sessionId: oldSessionId,
									reason: "switch",
								});
							} catch {
								// The old connection may already have released this lease.
							}
							if (targetLeasePreacquired) {
								const outcome: AcquireOutcome = { kind: "granted", handoff: "none" };
								trackAcquireOutcome(newSessionId, outcome);
								reacquiredHandler?.(newSessionId, outcome);
							} else {
								try {
									const response = await connectedClient.request({
										type: "lease_acquire",
										workspaceName: connectedWorkspaceName,
										sessionId: newSessionId,
									});
									const outcome = parseAcquireResponse(
										response as { type: string } & Record<string, unknown>,
										(id) =>
											connectedClient.waitForResponse(id) as Promise<
												{ type: string } & Record<string, unknown>
											>,
									);
									trackAcquireOutcome(newSessionId, outcome);
									reacquiredHandler?.(newSessionId, outcome);
								} catch {
									// Reconnect below re-acquires the committed session id.
								}
							}
						}
						phase = "committed";
						pendingRekeyTransactionId = undefined;
						if (state === "connected" && heldSessionId !== newSessionId) {
							await ensureLeaseAfterConnected().catch(() => {});
						}
					},
					async rollback() {
						if (phase !== "prepared") {
							return;
						}
						if (targetLeasePreacquired && activeClient && workspaceName) {
							await activeClient
								.request({
									type: "lease_release",
									workspaceName,
									sessionId: newSessionId,
									reason: "switch",
								})
								.catch(() => {});
						}
						phase = "rolled_back";
						pendingRekeyTransactionId = undefined;
						resolvedWorkspaceName = previousWorkspaceName;
						resolvedContextCwd = previousContextCwd;
						resolvedWorktreeId = previousWorktreeId;
						boundWorktreeSessionId = previousBoundWorktreeSessionId;
						currentSessionId = oldSessionId;
						heldSessionId =
							state === "connected" &&
							client === activeClient &&
							connectionGeneration === sourceLeaseConnectionGeneration
								? previousHeldSessionId
								: undefined;
						if (state === "connected" && heldSessionId !== oldSessionId) {
							await ensureLeaseAfterConnected().catch(() => {});
						}
					},
					async dispose() {
						if (phase === "disposed" || phase === "rolled_back") {
							return;
						}
						if (phase === "prepared" && targetLeasePreacquired && activeClient && workspaceName) {
							await activeClient
								.request({
									type: "lease_release",
									workspaceName,
									sessionId: newSessionId,
									reason: "quit",
								})
								.catch(() => {});
						}
						const disposedSessionId = phase === "committed" ? newSessionId : oldSessionId;
						const disposeClient = client;
						const disposeWorkspaceName = phase === "committed" ? resolvedWorkspaceName : previousWorkspaceName;
						if (disposeClient && disposeWorkspaceName) {
							try {
								await disposeClient.request({
									type: "lease_release",
									workspaceName: disposeWorkspaceName,
									sessionId: disposedSessionId,
									reason: "quit",
								});
							} catch {
								// Disconnect cleanup releases any server-side owner.
							}
						}
						if (phase !== "committed") {
							resolvedWorkspaceName = previousWorkspaceName;
							resolvedContextCwd = previousContextCwd;
							resolvedWorktreeId = previousWorktreeId;
							boundWorktreeSessionId = previousBoundWorktreeSessionId;
						}
						phase = "disposed";
						pendingRekeyTransactionId = undefined;
						currentSessionId = undefined;
						heldSessionId = undefined;
					},
				};
			}
			if (prepared?.type !== "lease_rekey_prepared") {
				throw new Error("conversation lease rekey preflight did not reserve its target");
			}
			const transactionId = prepared.transactionId;
			pendingRekeyTransactionId = transactionId;
			let phase: "prepared" | "committed" | "rolled_back" | "disposed" = "prepared";
			return {
				async commit() {
					if (phase !== "prepared") {
						return;
					}
					if (!(await ensureWorktreeBinding(activeClient, workspaceName, newSessionId, false))) {
						throw new Error("replacement session could not be bound to its worktree");
					}
					const response = await activeClient.request({ type: "lease_rekey_commit", transactionId });
					if (response.type !== "ok") {
						throw new Error(
							response.type === "error"
								? response.message
								: `unexpected daemon response to conversation lease rekey commit: ${response.type}`,
						);
					}
					phase = "committed";
					pendingRekeyTransactionId = undefined;
					currentSessionId = newSessionId;
					heldSessionId = newSessionId;
				},
				async rollback() {
					if (phase !== "prepared") {
						return;
					}
					let retained = false;
					try {
						const response = await activeClient.request({ type: "lease_rekey_rollback", transactionId });
						retained = response.type === "ok";
					} catch {
						// Disconnect cleanup rolls the reservation and lease back implicitly.
					}
					phase = "rolled_back";
					pendingRekeyTransactionId = undefined;
					resolvedWorkspaceName = previousWorkspaceName;
					resolvedContextCwd = previousContextCwd;
					resolvedWorktreeId = previousWorktreeId;
					boundWorktreeSessionId = previousBoundWorktreeSessionId;
					currentSessionId = oldSessionId;
					heldSessionId = retained && state === "connected" ? oldSessionId : undefined;
					if (state === "connected" && heldSessionId !== oldSessionId) {
						await ensureLeaseAfterConnected().catch(() => {});
					}
				},
				async dispose() {
					if (phase === "disposed" || phase === "rolled_back") {
						return;
					}
					try {
						if (phase === "committed") {
							await activeClient.request({
								type: "lease_release",
								workspaceName,
								sessionId: newSessionId,
								reason: "quit",
							});
						} else {
							await activeClient.request({ type: "lease_rekey_dispose", transactionId });
						}
					} catch {
						// Disconnect cleanup releases both reservation and lease implicitly.
					}
					if (phase !== "committed") {
						resolvedWorkspaceName = previousWorkspaceName;
						resolvedContextCwd = previousContextCwd;
						resolvedWorktreeId = previousWorktreeId;
						boundWorktreeSessionId = previousBoundWorktreeSessionId;
					}
					phase = "disposed";
					pendingRekeyTransactionId = undefined;
					currentSessionId = undefined;
					heldSessionId = undefined;
				},
			};
		},
		async forwardRelayRpc(
			clientNodeId: string,
			sessionId: string,
			command: Record<string, unknown> & { type: string },
		) {
			const workspaceName = resolvedWorkspaceName;
			const activeClient = client;
			const relayId = activeRelayIds.get(relayKey(clientNodeId, sessionId));
			if (!activeClient || !workspaceName || !relayId) {
				return undefined;
			}
			try {
				const response = await activeClient.request({
					type: "relay_rpc",
					relayId,
					clientNodeId,
					workspaceName,
					sessionId,
					command,
				});
				if (response.type !== "relay_rpc_result") {
					return undefined;
				}
				return {
					response: response.response,
					...(response.workspaceMetadata === undefined ? {} : { workspaceMetadata: response.workspaceMetadata }),
				};
			} catch {
				return undefined;
			}
		},
		relayNotificationDelivery: {
			async deliverNotification(clientNodeId, sessionId, notification) {
				const workspaceName = resolvedWorkspaceName;
				const activeClient = client;
				if (!activeClient || !workspaceName) {
					return "failed";
				}
				try {
					const response = await activeClient.request({
						type: "relay_notification_delivery",
						clientNodeId,
						workspaceName,
						sessionId,
						notification,
					});
					return response.type === "relay_push_delivery_result" ? response.status : "failed";
				} catch {
					return "failed";
				}
			},
		},
		async viewerSubscribe(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_subscribe", viewerFeedId });
			} catch {
				// Viewer feed is best-effort; the post-grant file load is authoritative.
			}
		},
		async viewerUnsubscribe(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_unsubscribe", viewerFeedId });
			} catch {
				// Best-effort.
			}
		},
		async viewerAbort(viewerFeedId: string) {
			try {
				await client?.request({ type: "viewer_abort", viewerFeedId });
			} catch {
				// Best-effort.
			}
		},
		onRelayOffer(handler) {
			relayOfferHandler = handler;
		},
		onEvent(handler) {
			eventHandlers.add(handler);
			return () => {
				eventHandlers.delete(handler);
			};
		},
		onReacquired(handler) {
			reacquiredHandler = handler;
		},
		relayCount() {
			return activeRelays;
		},
		onRelayCountChange(callback) {
			relayCountCallbacks.add(callback);
		},
		connectionState() {
			return state;
		},
		workspaceName() {
			return resolvedWorkspaceName;
		},
		setWorktreeContext(workspaceName, worktreeId) {
			const previous = stagedWorktreeContext;
			stagedWorktreeContext = { workspaceName, worktreeId };
			return () => {
				stagedWorktreeContext = previous;
			};
		},
		async listRuntimeStates(workspaceName: string) {
			const states = new Map<string, Exclude<LeaseState, "unowned">>();
			const activeClient = client;
			if (!activeClient || state !== "connected") {
				return states;
			}
			try {
				const response = await activeClient.request({ type: "status" });
				if (response.type !== "status_result") {
					return states;
				}
				for (const lease of response.leases) {
					if (lease.workspaceName === workspaceName && lease.state !== "unowned") {
						states.set(lease.sessionId, lease.state);
					}
				}
			} catch {
				// Presence is best-effort; list_sessions remains available from local state.
			}
			return states;
		},
		async dispose() {
			disposed = true;
			currentSessionId = undefined;
			heldSessionId = undefined;
			pendingRekeyTransactionId = undefined;
			activeRelayIds.clear();
			await client?.close();
			client = undefined;
			state = "gone";
		},
	};
}
