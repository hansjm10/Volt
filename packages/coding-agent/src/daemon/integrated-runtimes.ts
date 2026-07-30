import { realpath, rm } from "node:fs/promises";
import { relative, sep } from "node:path";
import type {
	AgentSessionReplacementTarget,
	AgentSessionReplacementTransaction,
	AgentSessionRuntime,
} from "../core/agent-session-runtime.ts";
import type { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import type { IrohRemoteHostEngine } from "../core/remote/iroh/engine.ts";
import {
	IrohRemoteHandshakeError,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	isIrohRemoteSessionId,
} from "../core/remote/iroh/handshake.ts";
import { shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization } from "../core/remote/iroh/host-policy.ts";
import {
	type IrohRemoteHostHandshakeFailureOutcome,
	type IrohRemoteRuntimeToolPolicy,
	isIrohRemoteRuntimeToolPolicyWithin,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir } from "../core/session-manager.ts";
import type { SubagentRuntimeRegistration } from "../core/subagents/index.ts";
import {
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteAgentRuntimeConversationTarget,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "../modes/rpc/iroh-remote-agent-runtime.ts";
import {
	type DetachedRuntimeRetentionHandle,
	scheduleDetachedRuntimeRetention,
} from "../remote/integrated-runtime-retention.ts";
import {
	assertConversationClientNodeId,
	type ConversationAttachClaim,
	type ConversationCoordinator,
	ConversationCoordinatorRegistry,
	type ConversationSubscriber,
} from "./conversation-coordinator.ts";
import type { IntegratedConversationSessionSelection } from "./handshake-responses.ts";
import type { DaemonRuntimeOwnerCapability } from "./lease-broker.ts";
import { isPathInside, resolveWorkspaceDirectory, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import { getRegisteredWorkingDirectoryForWorktree } from "./worktree-manager.ts";

export type IntegratedRuntimeSubscriber = ConversationSubscriber;

export type IntegratedRuntimeAttachClaim = ConversationAttachClaim;

export interface IntegratedRuntimeEntry {
	readonly coordinator: ConversationCoordinator;
	readonly key: string;
	clientNodeId: string;
	workspaceName: string;
	readonly sessionId: string;
	runtime: AgentSessionRuntime;
	readonly lifecycle: "prepared" | "active" | "retiring" | "retired";
	/** Monotonic ownership generation; rekey/retirement invalidates captured attaches. */
	readonly generation: number;
	/** Exactly-one terminal owner; concurrent cleanup paths join this promise. */
	readonly retirementPromise?: Promise<void>;
	/** Capability-scoped broker ownership for this exact runtime generation. */
	readonly leaseOwner?: DaemonRuntimeOwnerCapability;
	/** Attach claims fence rekey until stream/subscriber/feed ownership is published. */
	readonly attachClaims: ReadonlySet<IntegratedRuntimeAttachClaim>;
	/** Last reconnect target persisted for each co-attached paired client. */
	recordedSessionIdsByClient: Map<string, string>;
	readonly previousSessionIds: ReadonlySet<string>;
	readonly subscribers: ReadonlySet<IntegratedRuntimeSubscriber>;
	readonly detachedAt: number | undefined;
	readonly detachedRuntimeRetention: DetachedRuntimeRetentionHandle | undefined;
	parentSessionId?: string;
	subagentId?: string;
	/** Set when the runtime cwd is a daemon-managed worktree checkout. */
	worktreeId?: string;
	/** Host-local checkout path (sanitizer root); never sent on the wire. */
	worktreePath?: string;
	/** Registered-workspace-relative git source root for nested repo worktrees. */
	worktreeSourceRootRelativePath?: string;
	/** POSIX-style path relative to the registered workspace root. Omitted for root. */
	workingDirectory?: string;
	/** Immutable tool policy used to create this shared runtime. */
	toolPolicy: IrohRemoteRuntimeToolPolicy;
}

export interface IntegratedRuntimeStreamWriter {
	sessionId: string;
	write?(value: object): Promise<void> | void;
}

export interface IntegratedRuntimeRegistryOptions {
	agentDir?: string;
	profile?: string;
	/** Injectable runtime factory (tests); defaults to the real iroh remote runtime. */
	createRuntime?: typeof createIrohRemoteAgentRuntimeWithSessionSelection;
	auditLogger: IrohRemoteAuditLogger;
	stateManager: IrohRemoteHostStateManager;
	activeStreams: IrohRemoteActiveStreamRegistry;
	/** Stable per-conversation authorities shared with relay and stream ownership. */
	coordinators?: ConversationCoordinatorRegistry;
	detachedRuntimeTtlMs: () => number;
	/** Resolve the effective daemon-owned runtime policy. The client grant must remain the ceiling. */
	getToolPolicy?: (workspace: IrohRemoteWorkspace, clientAllowTools: string) => IrohRemoteRuntimeToolPolicy;
	/** Legacy workspace-policy seam. It is intersected with the client grant, never used as a replacement. */
	getAllowTools?: (workspace: IrohRemoteWorkspace) => string | undefined;
	getProjectTrustedForWorkspace: (workspace: IrohRemoteWorkspace) => boolean;
	setClientLastSessionId: IrohRemoteHostEngine["setClientLastSessionId"];
	/**
	 * Worktree resolution seam (wired to the daemon's WorktreeManager). Must
	 * throw a conversation-open error for an unknown/unavailable worktree.
	 */
	resolveWorktree?: (
		workspaceName: string,
		hello: IrohRemoteHello,
		targetSessionId: string | undefined,
	) => Promise<IrohRemoteWorkspaceWorktree | undefined>;
	/** Resolve/validate a selected working directory before creating a runtime. */
	resolveWorkingDirectory?: (options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}) => Promise<WorkspaceDirectoryResolution>;
	/** Persist the sessionId → worktree binding after a created worktree conversation. */
	bindWorktreeSession?: (workspaceName: string, worktreeId: string, sessionId: string) => Promise<void>;
	/** Lease-broker seam: invoked when a runtime's session id changes (rekey). */
	onRuntimeRekeyed?: (
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		previousSessionId: string,
		sessionId: string,
	) => void;
	/** Reserve the lease target before the old daemon runtime is invalidated. */
	prepareRuntimeRekey?: (
		owner: DaemonRuntimeOwnerCapability,
		workspaceName: string,
		previousSessionId: string,
		sessionId: string,
	) => { commit(): void; rollback(): void };
	/** Retire and await every stream/subscriber owner before low-level runtime disposal. */
	beforeRuntimeStop?: (entry: IntegratedRuntimeEntry, reason: string) => Promise<void>;
	onRuntimeDisposed?: (entry: IntegratedRuntimeEntry, reason: string) => void;
}

export function createConversationOpenError(
	outcome: IrohRemoteHostHandshakeFailureOutcome,
	message: string,
	details: Record<string, unknown> = {},
): IrohRemoteHandshakeError {
	const error = new IrohRemoteHandshakeError(outcome, message);
	Object.assign(error, details);
	return error;
}

export function createIrohRuntimeConversationTarget(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemoteAgentRuntimeConversationTarget {
	if (hello.mode !== "conversation") {
		throw new Error("integrated runtime requires a conversation stream");
	}
	if (hello.conversation.target === "new") {
		return { target: "new" };
	}
	if (hello.conversation.target === "session") {
		return { target: "session", sessionId: hello.conversation.sessionId };
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return previousSessionId === undefined ? { target: "last" } : { target: "last", resumeSessionId: previousSessionId };
}

export function getResolvedTargetSessionId(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	if (hello.mode !== "conversation") {
		return undefined;
	}
	if (hello.conversation.target === "session") {
		return hello.conversation.sessionId;
	}
	if (hello.conversation.target !== "last") {
		return undefined;
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return isIrohRemoteSessionId(previousSessionId) ? previousSessionId : undefined;
}

export function createConversationSessionSelectionFromEntry(
	entry: IntegratedRuntimeEntry,
	requestedSessionId: string = entry.sessionId,
): IntegratedConversationSessionSelection {
	if (requestedSessionId !== entry.sessionId) {
		return {
			kind: "session_rekeyed",
			requestedSessionId,
			sessionId: entry.sessionId,
		};
	}
	return {
		kind: "resumed",
		requestedSessionId: entry.sessionId,
		sessionId: entry.sessionId,
	};
}

let integratedRuntimeSubscriberSequence = 0;

function getRequestedWorkingDirectory(hello: IrohRemoteHello): string | undefined {
	return hello.mode === "conversation" && hello.conversation.target === "new"
		? hello.conversation.workingDirectory
		: undefined;
}

async function resolveRuntimeWorkingDirectory(rootPath: string, cwd: string): Promise<WorkspaceDirectoryResolution> {
	let rootReal: string;
	let cwdReal: string;
	try {
		rootReal = await realpath(rootPath);
		cwdReal = await realpath(cwd);
	} catch {
		throw createConversationOpenError("session_unavailable", "session working directory is unavailable");
	}
	if (!isPathInside(rootReal, cwdReal)) {
		throw createConversationOpenError(
			"session_unavailable",
			"stored session working directory is outside the authorized workspace",
		);
	}
	const relativePath = relative(rootReal, cwdReal).split(sep).join("/");
	return {
		absolutePath: cwdReal,
		...(relativePath.length === 0 ? {} : { relativePath }),
	};
}

function createAttachAdmissionCancelledError(): Error {
	return new Error("Conversation attach cancelled because daemon admission closed");
}

function assertAttachAdmissionOpen(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAttachAdmissionCancelledError();
	}
}

/**
 * Observe an uncancellable external operation without letting it retain daemon
 * admission after shutdown. A late successful resource result is handed to an
 * explicit disposer so cancellation cannot turn eventual settlement into a
 * leaked runtime.
 */
function waitForAttachAdmission<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	onLateSuccess?: (value: T) => Promise<void> | void,
): Promise<T> {
	if (!signal) {
		return operation;
	}
	let decided = false;
	let detachAbort = () => {};
	const disposeLate = (value: T): void => {
		if (!onLateSuccess) return;
		void Promise.resolve(onLateSuccess(value)).catch(() => {});
	};
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			if (decided) return;
			decided = true;
			detachAbort();
			reject(createAttachAdmissionCancelledError());
		};
		detachAbort = () => signal.removeEventListener("abort", onAbort);
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
		operation.then(
			(value) => {
				if (decided) {
					disposeLate(value);
					return;
				}
				decided = true;
				detachAbort();
				resolve(value);
			},
			(error: unknown) => {
				if (decided) return;
				decided = true;
				detachAbort();
				reject(error);
			},
		);
	});
}

export class IntegratedRuntimeRegistry {
	private readonly options: IntegratedRuntimeRegistryOptions;
	readonly coordinators: ConversationCoordinatorRegistry;
	private readonly entries = new Map<string, IntegratedRuntimeEntry>();
	private readonly sessionRekeyReservationsBySource = new Map<string, IntegratedRuntimeEntry>();
	private readonly sessionRekeyReservationsByTarget = new Map<string, IntegratedRuntimeEntry>();

	constructor(options: IntegratedRuntimeRegistryOptions) {
		this.options = options;
		this.coordinators = options.coordinators ?? new ConversationCoordinatorRegistry();
	}

	/** The conversation runtime key: one runtime per (workspaceName, sessionId). */
	getRegistryKey(workspaceName: string, sessionId: string): string {
		return this.coordinators.getRegistryKey(workspaceName, sessionId);
	}

	get size(): number {
		return this.entries.size;
	}

	values(): IntegratedRuntimeEntry[] {
		return Array.from(this.entries.values());
	}

	findOwner(workspaceName: string, sessionId: string): IntegratedRuntimeEntry | undefined {
		const direct = this.entries.get(this.getRegistryKey(workspaceName, sessionId));
		if (direct) {
			return direct;
		}
		for (const entry of this.entries.values()) {
			if (entry.workspaceName === workspaceName && entry.previousSessionIds.has(sessionId)) {
				return entry;
			}
		}
		return undefined;
	}

	private getSessionRekeyReservation(key: string): IntegratedRuntimeEntry | undefined {
		return this.sessionRekeyReservationsBySource.get(key) ?? this.sessionRekeyReservationsByTarget.get(key);
	}

	private createAttachRetryError(entry: IntegratedRuntimeEntry, message: string): IrohRemoteHandshakeError {
		return createConversationOpenError("duplicate_conversation_connection", message, {
			workspace: entry.workspaceName,
			sessionId: entry.sessionId,
			retryAfterMs: 500,
		});
	}

	private createAttachClaim(entry: IntegratedRuntimeEntry, clientNodeId: string): IntegratedRuntimeAttachClaim {
		return entry.coordinator.createAttachClaim(clientNodeId);
	}

	private assertAttachClaimCurrent(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		this.assertAttachClaimBelongsToEntry(entry, claim);
		if (!entry.coordinator.isAttachClaimCurrent(claim)) {
			throw this.createAttachRetryError(entry, "conversation attach claim is stale");
		}
	}

	private assertAttachClaimBelongsToEntry(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		if (claim.coordinator !== entry.coordinator) {
			throw this.createAttachRetryError(entry, "conversation attach claim belongs to another runtime");
		}
	}

	/** Validate a claim immediately before attach side effects. */
	assertEntryAttachable(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		this.assertAttachClaimCurrent(entry, claim);
		if (
			entry.lifecycle !== "active" ||
			this.entries.get(entry.key) !== entry ||
			this.getSessionRekeyReservation(entry.key) !== undefined
		) {
			throw this.createAttachRetryError(entry, "conversation runtime ownership changed during attach");
		}
	}

	private resolveToolPolicy(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteRuntimeToolPolicy {
		return (
			this.options.getToolPolicy?.(authorization.workspace, authorization.allowTools) ??
			resolveIrohRemoteRuntimeToolPolicy({
				clientAllowTools: authorization.allowTools,
				workspaceAllowTools: this.options.getAllowTools?.(authorization.workspace),
				daemonAllowTools: null,
			})
		);
	}

	async getOrCreateEntry(
		handshake: { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess },
		authorization: IrohRemoteClientAuthorizationSuccess,
		options: { signal?: AbortSignal } = {},
	): Promise<{
		entry: IntegratedRuntimeEntry;
		attachClaim: IntegratedRuntimeAttachClaim;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		assertAttachAdmissionOpen(options.signal);
		assertConversationClientNodeId(authorization.client.nodeId);
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		if (targetSessionId !== undefined) {
			const targetKey = this.getRegistryKey(authorization.workspace.name, targetSessionId);
			const reservedEntry = this.getSessionRekeyReservation(targetKey);
			if (reservedEntry) {
				throw this.createAttachRetryError(reservedEntry, "conversation runtime replacement is still publishing");
			}
			// One runtime per conversation: any paired client attaches to an existing
			// runtime for the target (conversation_in_use is retired; single-user model).
			const existing = this.findOwner(authorization.workspace.name, targetSessionId);
			if (existing) {
				if (existing.lifecycle !== "active") {
					throw this.createAttachRetryError(existing, "conversation runtime is retiring");
				}
				if (!shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization(authorization)) {
					assertAttachAdmissionOpen(options.signal);
					const attachingPolicy = this.resolveToolPolicy(authorization);
					if (!isIrohRemoteRuntimeToolPolicyWithin(existing.toolPolicy, attachingPolicy)) {
						throw createConversationOpenError(
							"conversation_in_use",
							"conversation is using tools outside this client's persisted grant",
							{ workspace: authorization.workspace.name, sessionId: targetSessionId },
						);
					}
					// Reattach recognized: cancel the pending detached-runtime TTL sweep
					// synchronously, before the caller's multi-await commit window. The
					// broker flips to daemon-active immediately (commitDaemonRuntime) but
					// attachSubscriber (which normally cancels retention) only runs after
					// several awaits; if the TTL timer elapsed in that window it would
					// dispose this very runtime mid-reattach (use-after-dispose + split
					// lease/registry ownership). detachedAt stays set so attachSubscriber
					// still logs the reattach and a pre-subscriber failure re-arms retention.
					this.cancelRetention(existing);
					const requestedSessionId =
						handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "session"
							? targetSessionId
							: existing.sessionId;
					return {
						entry: existing,
						attachClaim: this.createAttachClaim(existing, authorization.client.nodeId),
						created: false,
						sessionSelection: createConversationSessionSelectionFromEntry(existing, requestedSessionId),
					};
				}
				await waitForAttachAdmission(this.stopEntry(existing, "fresh_pairing_replaced_runtime"), options.signal);
			}
		}
		return this.createEntry(handshake, authorization, options);
	}

	private async resolveInitialWorkingDirectory(options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}): Promise<WorkspaceDirectoryResolution> {
		if (this.options.resolveWorkingDirectory) {
			return this.options.resolveWorkingDirectory(options);
		}
		const resolved = await resolveWorkspaceDirectory(options.rootPath, options.workingDirectory);
		if (!resolved.ok) {
			throw createConversationOpenError("invalid_conversation_target", resolved.error, {
				workspace: options.workspace.name,
			});
		}
		return resolved.value;
	}

	private async createEntry(
		handshake: { hello: IrohRemoteHello },
		authorization: IrohRemoteClientAuthorizationSuccess,
		options: { signal?: AbortSignal },
	): Promise<{
		entry: IntegratedRuntimeEntry;
		attachClaim: IntegratedRuntimeAttachClaim;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		let runtime: AgentSessionRuntime | undefined;
		let sessionSelection: IntegratedConversationSessionSelection | undefined;
		try {
			// Resolve any worktree binding first: explicit worktreeId on "new", or a
			// persisted sessionId binding on resume. Trust and allowTools stay pinned
			// to the PARENT workspace; only cwd changes. The session dir is ALWAYS
			// parent-keyed so worktree sessions stay listed under the workspace.
			assertAttachAdmissionOpen(options.signal);
			const worktree = this.options.resolveWorktree
				? await waitForAttachAdmission(
						this.options.resolveWorktree(
							authorization.workspace.name,
							handshake.hello,
							getResolvedTargetSessionId(handshake.hello, authorization),
						),
						options.signal,
					)
				: undefined;
			const rootPath = worktree?.path ?? authorization.workspace.path;
			const requestedWorkingDirectory = getRequestedWorkingDirectory(handshake.hello);
			assertAttachAdmissionOpen(options.signal);
			const initialDirectory = await waitForAttachAdmission(
				this.resolveInitialWorkingDirectory({
					workspace: authorization.workspace,
					rootPath,
					workingDirectory: requestedWorkingDirectory,
					...(worktree === undefined ? {} : { worktree }),
				}),
				options.signal,
			);
			const toolPolicy = this.resolveToolPolicy(authorization);
			assertAttachAdmissionOpen(options.signal);
			const runtimeOperation = (this.options.createRuntime ?? createIrohRemoteAgentRuntimeWithSessionSelection)({
				agentDir: this.options.agentDir,
				toolPolicy,
				conversationTarget: createIrohRuntimeConversationTarget(handshake.hello, authorization),
				cwd: initialDirectory.absolutePath,
				projectCwd: rootPath,
				workspaceName: authorization.workspace.name,
				baseRef: worktree?.baseRef,
				sessionDir: getDefaultSessionDir(authorization.workspace.path, this.options.agentDir),
				validateCwd: async (cwd) => {
					await resolveRuntimeWorkingDirectory(rootPath, cwd);
				},
				onSubagentRuntimeCreated: (event) => this.registerSubagentRuntime(event, authorization),
				profile: this.options.profile,
				projectTrusted: this.options.getProjectTrustedForWorkspace(authorization.workspace),
			});
			const runtimeResult = await waitForAttachAdmission(runtimeOperation, options.signal, async (lateResult) => {
				await cleanupUncommittedRuntime(lateResult.runtime, lateResult.sessionSelection);
			});
			runtime = runtimeResult.runtime;
			sessionSelection = runtimeResult.sessionSelection;
			assertAttachAdmissionOpen(options.signal);
			const runtimeDirectory = await waitForAttachAdmission(
				resolveRuntimeWorkingDirectory(rootPath, runtime.cwd),
				options.signal,
			);
			const remoteWorkingDirectory =
				worktree === undefined
					? runtimeDirectory.relativePath
					: getRegisteredWorkingDirectoryForWorktree(worktree, runtimeDirectory.relativePath);
			const echoedWorkingDirectory =
				handshake.hello.mode === "conversation" &&
				handshake.hello.conversation.target === "new" &&
				requestedWorkingDirectory === undefined
					? undefined
					: remoteWorkingDirectory;
			const sessionId = runtime.session.sessionId;
			const owner = this.findOwner(authorization.workspace.name, sessionId);
			const reservedOwner = this.getSessionRekeyReservation(
				this.getRegistryKey(authorization.workspace.name, sessionId),
			);
			if (reservedOwner) {
				await cleanupUncommittedRuntime(runtime, sessionSelection);
				runtime = undefined;
				throw this.createAttachRetryError(reservedOwner, "conversation runtime replacement is still publishing");
			}
			if (owner) {
				await cleanupUncommittedRuntime(runtime, sessionSelection);
				runtime = undefined;
				assertAttachAdmissionOpen(options.signal);
				if (owner.lifecycle !== "active") {
					throw this.createAttachRetryError(owner, "conversation runtime is retiring");
				}
				if (!isIrohRemoteRuntimeToolPolicyWithin(owner.toolPolicy, toolPolicy)) {
					throw createConversationOpenError(
						"conversation_in_use",
						"conversation is using tools outside this client's persisted grant",
						{ workspace: authorization.workspace.name, sessionId },
					);
				}
				return {
					entry: owner,
					attachClaim: this.createAttachClaim(owner, authorization.client.nodeId),
					created: false,
					sessionSelection: createConversationSessionSelectionFromEntry(owner),
				};
			}
			// Bind EVERY session actually created under the worktree root, not just
			// the initial "new"-target one: a created_after_missing replacement for a
			// bound-but-vanished resume target must stay resumable after a daemon
			// restart too (#83). Resumed sessions were bound when they were created.
			if (worktree !== undefined && sessionSelection.kind !== "resumed") {
				if (this.options.bindWorktreeSession) {
					assertAttachAdmissionOpen(options.signal);
					await waitForAttachAdmission(
						this.options.bindWorktreeSession(authorization.workspace.name, worktree.id, sessionId),
						options.signal,
					);
				}
			}
			assertAttachAdmissionOpen(options.signal);
			const entry = this.createEntryRecord({
				clientNodeId: authorization.client.nodeId,
				workspaceName: authorization.workspace.name,
				sessionId,
				runtime,
				...(worktree === undefined
					? {}
					: {
							worktreeId: worktree.id,
							worktreePath: worktree.path,
							...(worktree.sourceRootRelativePath === undefined
								? {}
								: { worktreeSourceRootRelativePath: worktree.sourceRootRelativePath }),
						}),
				...(echoedWorkingDirectory === undefined ? {} : { workingDirectory: echoedWorkingDirectory }),
				toolPolicy,
			});
			return {
				entry,
				attachClaim: this.createAttachClaim(entry, authorization.client.nodeId),
				created: true,
				sessionSelection,
			};
		} catch (error) {
			if (runtime) {
				await cleanupUncommittedRuntime(runtime, sessionSelection);
			}
			throw error;
		}
	}

	private createEntryRecord(options: {
		clientNodeId: string;
		workspaceName: string;
		sessionId: string;
		runtime: AgentSessionRuntime;
		parentSessionId?: string;
		subagentId?: string;
		worktreeId?: string;
		worktreePath?: string;
		worktreeSourceRootRelativePath?: string;
		workingDirectory?: string;
		toolPolicy: IrohRemoteRuntimeToolPolicy;
	}): IntegratedRuntimeEntry {
		const coordinator = this.coordinators.reserveRuntime(options.workspaceName, options.sessionId);
		const entry: IntegratedRuntimeEntry = {
			coordinator,
			get key() {
				return `${coordinator.workspaceName}\0${coordinator.sessionId}`;
			},
			clientNodeId: options.clientNodeId,
			workspaceName: options.workspaceName,
			get sessionId() {
				return coordinator.sessionId;
			},
			runtime: options.runtime,
			get lifecycle() {
				const lifecycle = coordinator.runtimeLifecycle;
				if (lifecycle === undefined) throw new Error("integrated runtime lost its coordinator lifecycle");
				return lifecycle;
			},
			get generation() {
				return coordinator.generation;
			},
			get retirementPromise() {
				return coordinator.retirement?.settled;
			},
			get leaseOwner() {
				return coordinator.leaseOwner;
			},
			get attachClaims() {
				return coordinator.attachClaims;
			},
			recordedSessionIdsByClient: new Map([[options.clientNodeId, options.sessionId]]),
			get previousSessionIds() {
				return coordinator.previousSessionIds;
			},
			get subscribers() {
				return coordinator.subscribers;
			},
			get detachedAt() {
				return coordinator.detachedAt;
			},
			get detachedRuntimeRetention() {
				return coordinator.detachedRuntimeRetention;
			},
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			...(options.subagentId === undefined ? {} : { subagentId: options.subagentId }),
			...(options.worktreeId === undefined ? {} : { worktreeId: options.worktreeId }),
			...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }),
			...(options.worktreeSourceRootRelativePath === undefined
				? {}
				: { worktreeSourceRootRelativePath: options.worktreeSourceRootRelativePath }),
			...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
			toolPolicy: {
				tools: [...options.toolPolicy.tools],
				allowUnlistedExtensionTools: options.toolPolicy.allowUnlistedExtensionTools,
			},
		};
		if (entry.parentSessionId === undefined) {
			entry.runtime.setPrepareSessionReplacement?.((target) => this.prepareEntrySessionReplacement(entry, target));
		}
		return entry;
	}

	private registerSubagentRuntime(
		event: IrohRemoteSubagentRuntimeCreatedEvent,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): SubagentRuntimeRegistration {
		const workspaceName = authorization.workspace.name;
		const parentEntry = this.findOwner(workspaceName, event.parentSessionId);
		if (!parentEntry || parentEntry.lifecycle !== "active") {
			throw new Error(`Parent runtime is not active for subagent session ${event.sessionId}`);
		}
		if (
			this.findOwner(workspaceName, event.sessionId) ||
			this.getSessionRekeyReservation(this.getRegistryKey(workspaceName, event.sessionId)) !== undefined
		) {
			throw new Error(`Subagent session ${event.sessionId} is already active`);
		}
		const entry = this.createEntryRecord({
			clientNodeId: authorization.client.nodeId,
			workspaceName,
			sessionId: event.sessionId,
			runtime: event.runtime,
			parentSessionId: event.parentSessionId,
			subagentId: event.id,
			toolPolicy: parentEntry.toolPolicy,
		});
		let state: "prepared" | "committed" | "rolled-back" = "prepared";
		return {
			commit: () => {
				if (state !== "prepared") return;
				if (this.findOwner(workspaceName, event.parentSessionId)?.lifecycle !== "active") {
					throw new Error(`Parent runtime is not active for subagent session ${event.sessionId}`);
				}
				if (
					this.findOwner(workspaceName, event.sessionId) ||
					this.getSessionRekeyReservation(this.getRegistryKey(workspaceName, event.sessionId)) !== undefined
				) {
					throw new Error(`Subagent session ${event.sessionId} is already active`);
				}
				state = "committed";
				entry.coordinator.activateRuntime();
				entry.coordinator.markDetached();
				this.entries.set(entry.key, entry);
				this.scheduleRetention(entry, "subagent_created");
				void this.logEntryAudit(entry, "remote_runtime_started", {
					parentSessionId: event.parentSessionId,
					reason: "subagent_created",
					subagentId: event.id,
				});
			},
			rollback: async () => {
				if (state === "rolled-back") return;
				if (state === "committed") {
					state = "rolled-back";
					await this.stopEntry(entry, "subagent_start_rolled_back");
					return;
				}
				state = "rolled-back";
				await entry.coordinator
					.beginRuntimeRetirement("subagent_start_rolled_back", () => event.runtime.dispose())
					.settled.catch(() => undefined);
			},
		};
	}

	async commitEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
		attachClaim: IntegratedRuntimeAttachClaim,
		signal?: AbortSignal,
	): Promise<void> {
		assertAttachAdmissionOpen(signal);
		this.assertAttachClaimCurrent(entry, attachClaim);
		if (attachClaim.clientNodeId !== authorization.client.nodeId) {
			throw this.createAttachRetryError(entry, "conversation attach client identity changed before commit");
		}
		if (entry.lifecycle !== "prepared" && entry.lifecycle !== "active") {
			throw this.createAttachRetryError(entry, "conversation runtime ownership changed before commit");
		}
		const initialLifecycle = entry.lifecycle;
		if (entry.lifecycle === "active") {
			this.assertEntryAttachable(entry, attachClaim);
		}
		const owner = this.findOwner(authorization.workspace.name, entry.sessionId);
		const reservedOwner = this.getSessionRekeyReservation(entry.key);
		if ((owner && owner !== entry) || (reservedOwner && reservedOwner !== entry)) {
			// Two attaches raced to create the same conversation runtime; the loser
			// retries and attaches to the winner.
			throw createConversationOpenError("duplicate_conversation_connection", "conversation runtime already active", {
				workspace: authorization.workspace.name,
				sessionId: entry.sessionId,
				retryAfterMs: 500,
			});
		}

		const inserted = this.entries.get(entry.key) !== entry;
		assertAttachAdmissionOpen(signal);
		if (inserted) {
			this.entries.set(entry.key, entry);
		}

		try {
			if (entry.parentSessionId === undefined) {
				await waitForAttachAdmission(
					this.options.setClientLastSessionId(
						authorization.client.nodeId,
						authorization.workspace.name,
						entry.sessionId,
					),
					signal,
				);
			}
			await waitForAttachAdmission(this.logSessionSelection(sessionSelection, authorization), signal);
			if (inserted) {
				await waitForAttachAdmission(
					this.logAudit({
						type: "runtime_started",
						clientNodeId: authorization.client.nodeId,
						workspace: authorization.workspace.name,
						success: true,
						details: this.getEntryDetails(entry),
					}),
					signal,
				);
				await waitForAttachAdmission(
					this.logEntryAudit(entry, "remote_runtime_started", { reason: "created" }),
					signal,
				);
			}
			// stopEntry fences claims and advances the generation before its first
			// await. Revalidate after every persistence/audit await and immediately
			// before publishing `active`, otherwise a paused commit could resurrect a
			// runtime that has already entered retirement.
			assertAttachAdmissionOpen(signal);
			this.assertAttachClaimCurrent(entry, attachClaim);
			if (entry.lifecycle !== initialLifecycle || this.entries.get(entry.key) !== entry) {
				throw this.createAttachRetryError(entry, "conversation runtime ownership changed during commit");
			}
			if (entry.lifecycle === "active") {
				this.assertEntryAttachable(entry, attachClaim);
			} else if (this.getSessionRekeyReservation(entry.key) !== undefined) {
				throw this.createAttachRetryError(entry, "conversation runtime ownership changed during commit");
			}
			entry.coordinator.activateRuntime();
		} catch (error) {
			// A concurrent stop owns a retiring entry until disposal completes. Do
			// not remove it here or stopEntry would return early and leak its runtime.
			if (inserted && entry.lifecycle === "prepared" && this.entries.get(entry.key) === entry) {
				this.entries.delete(entry.key);
			}
			throw error;
		}
	}

	async abortPreparedEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection | undefined,
		attachClaim: IntegratedRuntimeAttachClaim,
	): Promise<void> {
		if (entry.coordinator.retirement) {
			await entry.coordinator.retirement.settled;
			return;
		}
		if (entry.lifecycle === "retiring" || entry.lifecycle === "retired") {
			return;
		}
		this.assertAttachClaimCurrent(entry, attachClaim);
		if (entry.lifecycle !== "prepared") {
			throw new Error("Cannot abort a conversation runtime after ownership publication");
		}
		await entry.coordinator.beginRuntimeRetirement("prepared_attach_aborted", () =>
			this.finishPreparedEntryAbort(entry, sessionSelection),
		).settled;
	}

	private async finishPreparedEntryAbort(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection | undefined,
	): Promise<void> {
		if (entry.subscribers.size !== 0) {
			throw new Error("Cannot abort a prepared conversation runtime with attached subscribers");
		}
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
		}
		this.cancelRetention(entry);
		await cleanupUncommittedRuntime(entry.runtime, sessionSelection);
	}

	async attachSubscriber(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
	): Promise<IntegratedRuntimeSubscriber> {
		this.assertEntryAttachable(entry, attachClaim);
		const wasDetached = entry.subscribers.size === 0 && entry.detachedAt !== undefined;
		const previousDetachedAt = entry.detachedAt;
		this.cancelRetention(entry);
		const subscriber: IntegratedRuntimeSubscriber = {
			id: `subscriber-${++integratedRuntimeSubscriberSequence}`,
			clientNodeId: attachClaim.clientNodeId,
			attachedAt: Date.now(),
		};
		entry.coordinator.addSubscriber(subscriber);
		try {
			if (wasDetached) {
				entry.coordinator.markAttached();
				await this.logEntryAudit(
					entry,
					"remote_runtime_reattached",
					{
						reason: "subscriber_attached",
						subscriberId: subscriber.id,
					},
					{ clientNodeId: subscriber.clientNodeId },
				);
			}
			await this.logEntryAudit(
				entry,
				"remote_subscriber_attached",
				{ subscriberId: subscriber.id },
				{ clientNodeId: subscriber.clientNodeId },
			);
			// The caller cannot detach until this promise resolves, so an attach
			// fenced during audit publication must roll its provisional subscriber
			// back internally before surfacing the retry.
			this.assertEntryAttachable(entry, attachClaim);
			return subscriber;
		} catch (error) {
			entry.coordinator.removeSubscriber(subscriber);
			if (
				wasDetached &&
				previousDetachedAt !== undefined &&
				entry.lifecycle === "active" &&
				this.entries.get(entry.key) === entry &&
				entry.subscribers.size === 0
			) {
				entry.coordinator.markDetached(previousDetachedAt);
				const remainingTtlMs = Math.max(0, this.options.detachedRuntimeTtlMs() - (Date.now() - previousDetachedAt));
				this.scheduleRetention(entry, "subscriber_attach_failed", remainingTtlMs);
			}
			throw error;
		}
	}

	/**
	 * Start durable input recovery only for the published runtime generation that
	 * owns this fully admitted subscriber. The iroh service calls this after the
	 * ordered projection feed is bound, closing the loser-runtime dispatch race.
	 */
	startRecoveredClientInputs(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
		subscriber: IntegratedRuntimeSubscriber,
	): Promise<void> {
		this.assertEntryAttachable(entry, attachClaim);
		if (!entry.subscribers.has(subscriber) || subscriber.clientNodeId !== attachClaim.clientNodeId) {
			throw this.createAttachRetryError(entry, "conversation subscriber is not owned by this attach");
		}
		return entry.runtime.startRecoveredClientInputs();
	}

	async detachSubscriber(
		entry: IntegratedRuntimeEntry,
		subscriber: IntegratedRuntimeSubscriber,
		reason: string,
		error?: unknown,
	): Promise<void> {
		if (!entry.coordinator.removeSubscriber(subscriber)) {
			return;
		}
		const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
		await this.logEntryAudit(
			entry,
			"remote_subscriber_detached",
			{ reason, subscriberId: subscriber.id },
			{
				clientNodeId: subscriber.clientNodeId,
				success: errorMessage === undefined,
				error: errorMessage,
			},
		);
		if (entry.subscribers.size > 0) {
			return;
		}
		if (entry.lifecycle === "retiring" || entry.lifecycle === "retired") {
			return;
		}
		entry.coordinator.markDetached();
		await this.logEntryAudit(
			entry,
			"remote_runtime_detached",
			{ detachedAt: entry.detachedAt, reason },
			{ clientNodeId: subscriber.clientNodeId },
		);
		this.scheduleRetention(entry, reason);
	}

	async detachWithoutSubscriber(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
		reason: string,
	): Promise<void> {
		// Cleanup can run after retirement fenced/released the claim, but the
		// claim's captured actor identity remains immutable and authoritative.
		this.assertAttachClaimBelongsToEntry(entry, attachClaim);
		if (entry.lifecycle !== "active" || this.entries.get(entry.key) !== entry || entry.subscribers.size > 0) {
			return;
		}
		if (entry.detachedAt !== undefined) {
			// Already detached. A reattach that cancelled retention but then failed
			// before attachSubscriber ran can leave a detached entry with no timer;
			// re-arm so it is still swept rather than lingering forever. Honor the
			// ORIGINAL detach deadline (remaining TTL from detachedAt) instead of a
			// fresh full TTL, so repeated reconnect-then-abort cycles cannot keep
			// resetting the retention clock.
			if (!entry.detachedRuntimeRetention) {
				const remainingTtlMs = Math.max(0, this.options.detachedRuntimeTtlMs() - (Date.now() - entry.detachedAt));
				this.scheduleRetention(entry, reason, remainingTtlMs);
			}
			return;
		}
		entry.coordinator.markDetached();
		await this.logEntryAudit(
			entry,
			"remote_runtime_detached",
			{ detachedAt: entry.detachedAt, reason },
			{ clientNodeId: attachClaim.clientNodeId },
		);
		this.scheduleRetention(entry, reason);
	}

	async stopEntry(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		if (entry.coordinator.retirement) {
			await entry.coordinator.retirement.settled;
			return;
		}
		if (this.entries.get(entry.key) !== entry) {
			// Stale reference: the key may now belong to a replacement runtime, and
			// deleting by key alone would evict that runtime from the registry while
			// leaving it running unmanaged.
			return;
		}
		if (entry.lifecycle === "retired") {
			return;
		}
		if (entry.lifecycle === "retiring") {
			return;
		}
		await entry.coordinator.beginRuntimeRetirement(reason, () => this.finishEntryStop(entry, reason)).settled;
	}

	private async finishEntryStop(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		await this.options.beforeRuntimeStop?.(entry, reason);
		if (this.entries.get(entry.key) !== entry) {
			return;
		}
		if (entry.subscribers.size !== 0) {
			throw new Error(
				`Cannot stop conversation runtime ${entry.workspaceName}/${entry.sessionId} with attached subscribers`,
			);
		}
		const ownedConversationIds = new Set([entry.sessionId, ...entry.previousSessionIds]);
		const activeStreamCount = Array.from(ownedConversationIds).reduce(
			(count, sessionId) =>
				count + this.options.activeStreams.entriesForConversationKey(entry.workspaceName, sessionId).length,
			0,
		);
		if (activeStreamCount !== 0) {
			throw new Error(
				`Cannot stop conversation runtime ${entry.workspaceName}/${entry.sessionId} with active streams`,
			);
		}
		const wasActive = entry.runtime.session.isBusy;
		let removedLiveActivityCount = 0;
		let stopSuccess = true;
		const stopErrors: string[] = [];
		// dispose() closes structural admission synchronously, then joins the same
		// per-runtime actor as replacement. Keep registry/lease reservations intact
		// until that fixed admitted set has settled.
		try {
			await entry.runtime.dispose();
		} catch (error) {
			stopSuccess = false;
			stopErrors.push(`runtime disposal: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (this.entries.get(entry.key) !== entry) {
			return;
		}
		for (const [key, reservedEntry] of this.sessionRekeyReservationsBySource) {
			if (reservedEntry === entry) this.sessionRekeyReservationsBySource.delete(key);
		}
		for (const [key, reservedEntry] of this.sessionRekeyReservationsByTarget) {
			if (reservedEntry === entry) this.sessionRekeyReservationsByTarget.delete(key);
		}
		this.cancelRetention(entry);
		this.entries.delete(entry.key);
		try {
			removedLiveActivityCount = await this.options.stateManager.removeLiveActivitiesForWorkspaceSessions(
				entry.workspaceName,
				ownedConversationIds,
			);
		} catch (error: unknown) {
			stopSuccess = false;
			stopErrors.push(`live activity cleanup: ${error instanceof Error ? error.message : String(error)}`);
		}
		const stopError = stopErrors.length === 0 ? undefined : stopErrors.join("; ");
		try {
			await this.logAudit({
				type: "runtime_stopped",
				clientNodeId: entry.clientNodeId,
				workspace: entry.workspaceName,
				success: stopSuccess,
				error: stopError,
				details: this.getEntryDetails(entry, { active: wasActive, reason, removedLiveActivityCount }),
			});
			await this.logEntryAudit(
				entry,
				"remote_runtime_stopped",
				{ active: wasActive, reason, removedLiveActivityCount },
				{ success: stopSuccess, error: stopError },
			);
		} finally {
			this.options.onRuntimeDisposed?.(entry, reason);
		}
	}

	async stopAll(reason: string): Promise<void> {
		for (const entry of this.values()) {
			await this.stopEntry(entry, reason);
		}
	}

	async stopForClient(clientNodeId: string, reason: string): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.clientNodeId !== clientNodeId) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	async stopForWorkspace(
		workspaceName: string,
		reason: string,
		excludeEntry?: IntegratedRuntimeEntry,
	): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.workspaceName !== workspaceName || entry === excludeEntry) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	async stopForClientWorkspace(clientNodeId: string, workspaceName: string, reason: string): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.clientNodeId !== clientNodeId || entry.workspaceName !== workspaceName) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	private async prepareEntrySessionReplacement(
		entry: IntegratedRuntimeEntry,
		target: AgentSessionReplacementTarget,
	): Promise<AgentSessionReplacementTransaction> {
		if (entry.sessionId !== target.previousSessionId || this.entries.get(entry.key) !== entry) {
			throw new Error("daemon runtime ownership changed before session replacement preflight");
		}
		if (entry.lifecycle !== "active" || entry.attachClaims.size !== 0) {
			throw new Error("daemon runtime attach is still publishing");
		}
		const sourceKey = entry.key;
		const targetKey = this.getRegistryKey(entry.workspaceName, target.sessionId);
		const existing = this.findOwner(entry.workspaceName, target.sessionId);
		if (existing && existing !== entry) {
			throw new Error(`conversation runtime already active for ${entry.workspaceName}/${target.sessionId}`);
		}
		if (
			this.sessionRekeyReservationsBySource.has(sourceKey) ||
			this.sessionRekeyReservationsByTarget.has(sourceKey) ||
			this.sessionRekeyReservationsBySource.has(targetKey) ||
			this.sessionRekeyReservationsByTarget.has(targetKey)
		) {
			throw new Error("daemon runtime session replacement already in progress");
		}

		const lease = (() => {
			if (entry.coordinator.hasLeaseBroker) {
				return entry.coordinator.prepareDaemonRuntimeLeaseRekey(target.sessionId);
			}
			if (!this.options.prepareRuntimeRekey) {
				return undefined;
			}
			if (!entry.leaseOwner) {
				throw new Error("daemon runtime lease owner is unavailable for session replacement");
			}
			return this.options.prepareRuntimeRekey(
				entry.leaseOwner,
				entry.workspaceName,
				target.previousSessionId,
				target.sessionId,
			);
		})();
		this.sessionRekeyReservationsBySource.set(sourceKey, entry);
		if (sourceKey !== targetKey) {
			this.sessionRekeyReservationsByTarget.set(targetKey, entry);
		}
		const attachedClientNodeIds = new Set(
			this.options.activeStreams
				.entriesForConversationKey(entry.workspaceName, target.previousSessionId)
				.map((stream) => stream.clientNodeId),
		);
		attachedClientNodeIds.add(entry.clientNodeId);
		const preparedGeneration = entry.generation;
		let phase: "prepared" | "committed" | "finalized" | "rolled_back" | "disposed" = "prepared";
		let targetSessionPersisted = false;
		const clearReservation = () => {
			if (this.sessionRekeyReservationsBySource.get(sourceKey) === entry) {
				this.sessionRekeyReservationsBySource.delete(sourceKey);
			}
			if (this.sessionRekeyReservationsByTarget.get(targetKey) === entry) {
				this.sessionRekeyReservationsByTarget.delete(targetKey);
			}
		};
		const assertPreparedOwnershipCurrent = () => {
			if (
				entry.lifecycle !== "active" ||
				entry.generation !== preparedGeneration ||
				entry.attachClaims.size !== 0 ||
				this.entries.get(sourceKey) !== entry ||
				this.sessionRekeyReservationsBySource.get(sourceKey) !== entry ||
				(sourceKey !== targetKey && this.sessionRekeyReservationsByTarget.get(targetKey) !== entry)
			) {
				throw new Error("daemon runtime ownership changed before session replacement commit");
			}
			const targetOwner = this.findOwner(entry.workspaceName, target.sessionId);
			if (targetOwner && targetOwner !== entry) {
				throw new Error(`conversation runtime already active for ${entry.workspaceName}/${target.sessionId}`);
			}
		};
		const restorePreviousRecordedSession = async (): Promise<void> => {
			if (!targetSessionPersisted || entry.parentSessionId !== undefined) return;
			await this.options.stateManager.setClientsLastSessionId(
				Array.from(attachedClientNodeIds),
				entry.workspaceName,
				target.previousSessionId,
			);
			targetSessionPersisted = false;
		};

		return {
			commit: async () => {
				if (phase !== "prepared") return;
				try {
					assertPreparedOwnershipCurrent();
					if (entry.parentSessionId === undefined) {
						await this.options.stateManager.setClientsLastSessionId(
							Array.from(attachedClientNodeIds),
							entry.workspaceName,
							target.sessionId,
						);
						targetSessionPersisted = true;
					}
					if (entry.worktreeId !== undefined && this.options.bindWorktreeSession) {
						// Keep the durable worktree binding covering the replacement id so a
						// post-restart resume resolves the checkout again (#83). The append is
						// additive and idempotent; rollback leaves a stale-but-inert extra id.
						await this.options.bindWorktreeSession(entry.workspaceName, entry.worktreeId, target.sessionId);
					}
					// Persistence is an ownership await boundary. A stop can synchronously
					// fence the entry while that write is pending; never publish its lease or
					// registry rekey without revalidating the captured generation.
					assertPreparedOwnershipCurrent();
					lease?.commit();
				} catch (error) {
					try {
						await restorePreviousRecordedSession();
					} catch (compensationError) {
						throw new AggregateError(
							[error, compensationError],
							"session replacement failed and its persisted client target could not be restored",
						);
					}
					throw error;
				}

				if (this.entries.get(sourceKey) === entry) {
					this.entries.delete(sourceKey);
				}
				this.coordinators.rekey(entry.coordinator, target.sessionId);
				this.entries.set(targetKey, entry);
				for (const stream of this.options.activeStreams.entriesForConversationKey(
					entry.workspaceName,
					target.previousSessionId,
				)) {
					stream.sessionId = target.sessionId;
				}
				for (const clientNodeId of attachedClientNodeIds) {
					entry.recordedSessionIdsByClient.set(clientNodeId, target.sessionId);
				}
				phase = "committed";
			},
			finalize: async () => {
				if (phase === "finalized") return;
				if (phase !== "committed") {
					throw new Error("daemon runtime session replacement was not committed before publication");
				}
				phase = "finalized";
				clearReservation();
				await this.logEntryAudit(entry, "remote_runtime_session_changed", {
					previousSessionId: target.previousSessionId,
					sessionId: target.sessionId,
				});
				for (const clientNodeId of attachedClientNodeIds) {
					await this.logAudit({
						type: "session_changed",
						clientNodeId,
						workspace: entry.workspaceName,
						success: true,
						details: {
							reason: "remote_rpc_session_change",
							sessionId: target.sessionId,
							lastSessionUpdated: entry.parentSessionId === undefined,
						},
					});
				}
			},
			rollback: async () => {
				if (phase !== "prepared") return;
				phase = "rolled_back";
				clearReservation();
				lease?.rollback();
				await restorePreviousRecordedSession();
			},
			dispose: () => {
				if (phase === "disposed" || phase === "rolled_back") return Promise.resolve();
				const existingRetirement = entry.coordinator.retirement;
				const disposeTransaction = async (ownsRetirement: boolean): Promise<void> => {
					if (phase === "prepared") {
						lease?.rollback();
					}
					await restorePreviousRecordedSession().catch(() => undefined);
					phase = "disposed";
					clearReservation();
					if (!ownsRetirement) {
						// stopEntry already owns terminal disposal. Do not await it from the
						// replacement command whose settlement may be needed to unblock stop.
						return;
					}
					this.cancelRetention(entry);
					if (this.entries.get(entry.key) === entry) {
						this.entries.delete(entry.key);
					}
					this.options.onRuntimeDisposed?.(entry, "session_replacement_failed");
				};
				if (existingRetirement || entry.lifecycle === "retired") {
					return disposeTransaction(false);
				}
				const retirement = entry.coordinator.beginRuntimeRetirement(
					"session_replacement_failed",
					() => disposeTransaction(true),
					{ finalizationOrder: "concurrent" },
				);
				return retirement.finalization;
			},
		};
	}

	async handleSessionChanged(
		entry: IntegratedRuntimeEntry,
		activeStreamEntry: IntegratedRuntimeStreamWriter | undefined,
		session: { sessionId: string },
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		const previousSessionId = entry.sessionId;
		const attachedClientNodeIds = new Set(
			this.options.activeStreams
				.entriesForConversationKey(entry.workspaceName, previousSessionId)
				.map((stream) => stream.clientNodeId),
		);
		attachedClientNodeIds.add(authorization.client.nodeId);
		if (session.sessionId !== entry.sessionId) {
			try {
				await this.rekeyEntry(entry, activeStreamEntry, session.sessionId);
			} catch (error: unknown) {
				await this.stopEntry(entry, "session_rekey_failed").catch(() => {});
				throw error;
			}
		}
		if (activeStreamEntry) {
			activeStreamEntry.sessionId = session.sessionId;
		}
		for (const clientNodeId of attachedClientNodeIds) {
			if (entry.recordedSessionIdsByClient.get(clientNodeId) === session.sessionId) continue;
			try {
				await this.recordSessionChange(entry, session.sessionId, clientNodeId);
				entry.recordedSessionIdsByClient.set(clientNodeId, session.sessionId);
			} catch (error: unknown) {
				await this.stopEntry(entry, "session_rekey_persistence_failed").catch(() => {});
				throw error;
			}
		}
	}

	private async rekeyEntry(
		entry: IntegratedRuntimeEntry,
		activeStreamEntry: IntegratedRuntimeStreamWriter | undefined,
		nextSessionId: string,
	): Promise<void> {
		const previousSessionId = entry.sessionId;
		const previousKey = entry.key;
		const nextKey = this.getRegistryKey(entry.workspaceName, nextSessionId);
		if (entry.lifecycle !== "active" || entry.attachClaims.size !== 0) {
			throw new Error("daemon runtime attach is still publishing");
		}
		const existing = this.findOwner(entry.workspaceName, nextSessionId);
		if (existing && existing !== entry) {
			throw new Error(`conversation runtime already active for ${entry.workspaceName}/${nextSessionId}`);
		}
		if (
			this.sessionRekeyReservationsBySource.has(previousKey) ||
			this.sessionRekeyReservationsByTarget.has(previousKey) ||
			this.sessionRekeyReservationsBySource.has(nextKey) ||
			this.sessionRekeyReservationsByTarget.has(nextKey)
		) {
			throw new Error("daemon runtime session replacement already in progress");
		}
		// Rekey the lease first. The callback is synchronous and may reject; in
		// that case the registry and every active stream remain on the old identity
		// and the runtime's projection barrier fails closed.
		if (entry.coordinator.hasLeaseBroker) {
			entry.coordinator.rekeyDaemonRuntimeLease(nextSessionId);
		} else if (this.options.onRuntimeRekeyed) {
			if (!entry.leaseOwner) {
				throw new Error("daemon runtime lease owner is unavailable for session rekey");
			}
			this.options.onRuntimeRekeyed(entry.leaseOwner, entry.workspaceName, previousSessionId, nextSessionId);
		}
		if (this.entries.get(previousKey) === entry) {
			this.entries.delete(previousKey);
		}
		this.coordinators.rekey(entry.coordinator, nextSessionId);
		this.entries.set(nextKey, entry);
		// Re-key EVERY stream bound to the old conversation id, not just the one
		// that drove this session change. Workflow-event fan-out matches streams by
		// the runtime's current sessionId, so a co-attached device left on the stale
		// id would be silently dropped from all future events.
		for (const stream of this.options.activeStreams.entriesForConversationKey(
			entry.workspaceName,
			previousSessionId,
		)) {
			stream.sessionId = nextSessionId;
		}
		if (activeStreamEntry) {
			// Defensive: the driving stream is normally already in the registry, but
			// keep it consistent even if this runs before it was registered.
			activeStreamEntry.sessionId = nextSessionId;
		}
		// A rekeyed worktree conversation must stay resumable after a daemon
		// restart: append the new id to the durable binding (additive, idempotent).
		// Failure fails the rekey closed — handleSessionChanged stops the runtime
		// rather than leaving a persisted resume target that cannot be resolved
		// back to its checkout (#83). The registry has already moved to the new
		// identity, so the fail-closed outcome is a stopped runtime, not the old
		// identity retained.
		if (entry.worktreeId !== undefined && this.options.bindWorktreeSession) {
			await this.options.bindWorktreeSession(entry.workspaceName, entry.worktreeId, nextSessionId);
		}
		await this.logEntryAudit(entry, "remote_runtime_session_changed", {
			previousSessionId,
			sessionId: nextSessionId,
		});
	}

	private async recordSessionChange(
		entry: IntegratedRuntimeEntry,
		sessionId: string,
		clientNodeId: string,
	): Promise<void> {
		if (entry.parentSessionId !== undefined) {
			await this.logAudit({
				type: "session_changed",
				clientNodeId,
				workspace: entry.workspaceName,
				success: true,
				details: {
					reason: "remote_rpc_session_change",
					sessionId,
					parentSessionId: entry.parentSessionId,
					...(entry.subagentId === undefined ? {} : { subagentId: entry.subagentId }),
					lastSessionUpdated: false,
				},
			});
			return;
		}

		try {
			const client = await this.options.setClientLastSessionId(clientNodeId, entry.workspaceName, sessionId);
			await this.logAudit({
				type: "session_changed",
				clientNodeId,
				workspace: entry.workspaceName,
				success: client !== undefined,
				error: client ? undefined : "client not found",
				details: { reason: "remote_rpc_session_change", sessionId },
			});
		} catch (error) {
			await this.logAudit({
				type: "session_changed",
				clientNodeId,
				workspace: entry.workspaceName,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				details: { reason: "remote_rpc_session_change", sessionId },
			});
			throw error;
		}
	}

	// ==========================================================================
	// Retention
	// ==========================================================================

	cancelRetention(entry: IntegratedRuntimeEntry): void {
		if (!entry.detachedRuntimeRetention) {
			return;
		}
		entry.coordinator.cancelDetachedRuntimeRetention();
	}

	isDetached(entry: IntegratedRuntimeEntry): boolean {
		return (
			entry.lifecycle === "active" &&
			this.entries.get(entry.key) === entry &&
			entry.subscribers.size === 0 &&
			entry.detachedAt !== undefined
		);
	}

	scheduleRetention(entry: IntegratedRuntimeEntry, detachReason: string, ttlOverrideMs?: number): void {
		this.cancelRetention(entry);
		// A re-arm for an already-detached entry (reattach cancelled retention then
		// aborted before attach) honors the ORIGINAL detach deadline via an override
		// rather than restarting a full TTL, so a flaky reconnect-then-abort loop
		// cannot keep resetting the clock and pin a detached runtime open forever.
		const ttlMs = ttlOverrideMs ?? this.options.detachedRuntimeTtlMs();
		// Detached review workflows count as activity: a backgrounded client's
		// running review must pin the runtime until it reaches a terminal state.
		const isEntryActive = () =>
			entry.runtime.session.isBusy || entry.runtime.reviewWorkflows?.hasActiveWorkflows === true;
		const waitForEntryIdle = async () => {
			await entry.runtime.session.waitForIdle();
			await entry.runtime.reviewWorkflows?.waitForIdle();
		};
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs,
			isDetached: () => this.isDetached(entry),
			isActive: isEntryActive,
			waitForIdle: waitForEntryIdle,
			onExpire: async () => {
				if (!this.isDetached(entry) || isEntryActive()) {
					return;
				}
				await this.logEntryAudit(entry, "remote_runtime_retention_expired", {
					detachedAt: entry.detachedAt,
					detachReason,
					reason: "detached_runtime_ttl_expired",
					ttlMs,
				});
				// A reattach handshake can commit during the audit-write await above,
				// clearing detachedAt / adding a subscriber, or cancel and replace this
				// retention. Re-check (and confirm this retention is still the active
				// one) before disposing, so the sweep never tears down a runtime that
				// was just reattached.
				if (!this.isDetached(entry) || isEntryActive() || entry.detachedRuntimeRetention !== handle) {
					return;
				}
				await this.stopEntry(entry, "detached_runtime_ttl_expired");
			},
			onError: (error) => {
				void this.logEntryAudit(
					entry,
					"remote_runtime_retention_expired",
					{
						detachedAt: entry.detachedAt,
						detachReason,
						reason: "detached_runtime_ttl_error",
						ttlMs,
					},
					{ success: false, error: error instanceof Error ? error.message : String(error) },
				);
			},
		});
		entry.coordinator.setDetachedRuntimeRetention(handle);
	}

	// ==========================================================================
	// Audit helpers
	// ==========================================================================

	getEntryDetails(entry: IntegratedRuntimeEntry, extraDetails: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			runtime: "integrated-volt",
			sessionId: entry.sessionId,
			subscriberCount: entry.subscribers.size,
			active: entry.runtime.session.isBusy,
			...extraDetails,
		};
	}

	async logEntryAudit(
		entry: IntegratedRuntimeEntry,
		type: string,
		details: Record<string, unknown> = {},
		outcome: { clientNodeId?: string; success?: boolean; error?: string } = {},
	): Promise<void> {
		await this.logAudit({
			type,
			clientNodeId: outcome.clientNodeId ?? entry.clientNodeId,
			workspace: entry.workspaceName,
			success: outcome.success ?? true,
			error: outcome.error,
			details: this.getEntryDetails(entry, details),
		});
	}

	private async logSessionSelection(
		selection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		const common = {
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
		};
		if (selection.kind === "resumed") {
			await this.logAudit({
				...common,
				type: "session_resumed",
				success: true,
				details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
			});
			return;
		}
		if (selection.kind === "created_after_missing") {
			await this.logAudit({
				...common,
				type: "session_missing_on_resume",
				success: false,
				error: "session not found",
				details: { requestedSessionId: selection.requestedSessionId },
			});
			await this.logAudit({
				...common,
				type: "session_created",
				success: true,
				details: { reason: "missing_on_resume", sessionId: selection.sessionId },
			});
			return;
		}
		if (selection.kind === "session_rekeyed") {
			await this.logAudit({
				...common,
				type: "session_rekeyed",
				success: true,
				details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
			});
			return;
		}
		await this.logAudit({
			...common,
			type: "session_created",
			success: true,
			details: { reason: "new_client_connection", sessionId: selection.sessionId },
		});
	}

	private async logAudit(event: Parameters<IrohRemoteAuditLogger["log"]>[0]): Promise<void> {
		try {
			await this.options.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort and must not change remote runtime behavior.
		}
	}
}

async function cleanupUncommittedRuntime(
	runtime: AgentSessionRuntime,
	sessionSelection: IntegratedConversationSessionSelection | undefined,
): Promise<void> {
	const sessionFile = runtime.session.sessionFile;
	await runtime.dispose().catch(() => {});
	if (sessionSelection?.kind === "resumed") {
		return;
	}
	if (typeof sessionFile === "string" && sessionFile.length > 0) {
		await rm(sessionFile, { force: true }).catch(() => {});
	}
}
