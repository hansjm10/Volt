import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	clonePlanState,
	createPlanExecutionPrompt,
	PLAN_EXECUTION_CUSTOM_TYPE,
	type PlanExecution,
	type PlanExecutionStrategy,
	type PlanningState,
	StalePlanRevisionError,
} from "./planning.ts";
import { captureReviewStateForHandoff, restoreReviewStateFromHandoff } from "./review-state.ts";
import { ReviewWorkflowManager } from "./review-workflows.ts";
import { ConversationProjectionFeed, type ConversationProjectionSource } from "./rpc/conversation-projection-feed.ts";
import type { RpcGitContext } from "./rpc/types.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists, MissingSessionCwdError } from "./session-cwd.ts";
import {
	assertCurrentSessionSnapshot,
	assertValidSessionId,
	isHostOnlySessionEntry,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	type SessionOrigin,
	type SessionReference,
	summarizeSessionEntries,
} from "./session-manager.ts";
import type { SubagentDelegationScope } from "./subagents/delegation-scope.ts";
import type { SubagentRegistry } from "./subagents/registry.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export interface SubagentRuntimeContext {
	depth: number;
	agentName: string;
	/** This runtime's own id in the session-wide delegation registry. */
	subagentId: string;
	path: string[];
	delegationScope: SubagentDelegationScope;
	/** Session-wide registry of delegated runs, shared by every runtime in the tree. */
	registry: SubagentRegistry;
	allowedSubagents?: string[];
	maxSubagentDepth?: number;
	maxChildAgents?: number;
}

export interface WorkspaceSessionSummary {
	sessionId: string;
	sessionName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	current: boolean;
	cwd: string;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
	/** First host-observed path-free Git state for this session. */
	startingGitContext?: RpcGitContext | null;
}

export interface AgentSessionSwitchOptions {
	cwdOverride?: string;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	/** Internal remote mutation lease revalidated at every awaited replacement boundary. */
	assertConversationGenerationCurrent?: () => void;
}

export interface AgentSessionReplacementTransaction {
	commit(): Promise<void>;
	/** Release the replacement reservation after the new projection generation is published. */
	finalize?(): Promise<void>;
	rollback(): Promise<void>;
	dispose(): Promise<void>;
}

export interface AgentSessionReplacementTarget {
	previousSessionId: string;
	sessionId: string;
	cwd?: string;
}

/**
 * Result of a structural session replacement operation (`newSession`, `fork`,
 * `switchSession`, `switchSessionById`).
 *
 * - `cancelled: true` — an extension cancelled the operation before teardown;
 *   the current session is unchanged and no `withSession` callback ran.
 * - `seeded` — the requested `withSession` callback ran to completion against
 *   the replacement session. Always `false` when no callback was requested,
 *   and `false` for no-op switches that target the current session (no
 *   replacement happens, so the callback never runs). When `cancelled` is
 *   `false`, a callback was requested, and a replacement actually happened,
 *   `seeded: false` means the recovered-client-input gate failed and skipped
 *   the callback: the replacement session and its durable queue remain
 *   authoritative, but nothing was seeded into it. Callers that treat a
 *   non-cancelled result as "the seed landed" must check `seeded`.
 */
export interface AgentSessionReplacementResult {
	cancelled: boolean;
	seeded: boolean;
}

interface AgentSessionStructuralOperation {
	expectedSession: AgentSession;
	expectedRevision: number;
	expectedConversationGenerationRevision: number;
	assertConversationGenerationCurrent?: () => void;
}

interface AgentSessionLifecycleLease {
	/** Revoked as soon as this invocation's own callback settles. */
	active: boolean;
	/** Re-entrant runtime operations admitted by this invocation. */
	readonly children: Set<Promise<void>>;
}

/** Canonical persistence commit consumed by subscriber-local transcript projectors. */
export interface ConversationTranscriptCommittedEvent {
	type: "conversation_transcript_committed";
	entry: SessionEntry;
}

export function isConversationTranscriptCommittedEvent(value: object): value is ConversationTranscriptCommittedEvent {
	return (
		"type" in value &&
		value.type === "conversation_transcript_committed" &&
		"entry" in value &&
		typeof value.entry === "object" &&
		value.entry !== null
	);
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	profile?: string;
	subagentContext?: SubagentRuntimeContext;
	workspaceName?: string;
	baseRef?: string;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function toSessionTimestamp(value: string | undefined): string {
	if (!value) {
		return new Date(0).toISOString();
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function sessionRefsEqual(left: SessionReference, right: SessionReference): boolean {
	return (
		resolvePath(left.sessionDirectory) === resolvePath(right.sessionDirectory) &&
		left.storeId === right.storeId &&
		left.sessionId === right.sessionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

async function closePreparedSessionManager(manager: SessionManager, error: unknown, message: string): Promise<never> {
	try {
		await manager.closePersistence();
	} catch (closeError) {
		throw new AggregateError([error, closeError], message);
	}
	throw error;
}

async function discardPreparedSessionManager(manager: SessionManager, error: unknown, message: string): Promise<never> {
	try {
		await manager.discardPersistence();
	} catch (cleanupError) {
		throw new AggregateError([error, cleanupError], message);
	}
	throw error;
}

function sessionInfoToSummary(info: SessionInfo, currentSessionId: string): WorkspaceSessionSummary {
	return {
		sessionId: info.id,
		sessionName: info.name,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
		current: info.id === currentSessionId,
		cwd: info.cwd,
		origin: info.origin,
		...(info.startingGitContext === undefined ? {} : { startingGitContext: info.startingGitContext }),
	};
}

interface RecoveredClientInputsTask {
	readonly session: AgentSession;
	readonly promise: Promise<void>;
	settled: boolean;
	succeeded: boolean;
	cancellationRequested: boolean;
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private prepareSessionReplacement?: (
		target: AgentSessionReplacementTarget,
	) => Promise<AgentSessionReplacementTransaction | undefined>;
	private readonly sessionWillProjectListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private readonly sessionReplacementListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private readonly subagentContext?: SubagentRuntimeContext;
	private detachConversationTranscriptCommits: () => void = () => {};
	private lifecycleTail: Promise<void> = Promise.resolve();
	private readonly lifecycleActorContext = new AsyncLocalStorage<AgentSessionLifecycleLease>();
	private lifecycleRevision = 0;
	private pendingStructuralOperationCount = 0;
	private sessionInvalidated = false;
	private sessionReplacementInProgress = false;
	private acceptingStructuralOperations = true;
	private disposePromise?: Promise<void>;
	private recoveredClientInputsEnabled = false;
	private recoveredClientInputsTask?: RecoveredClientInputsTask;
	private readonly clientInputAdmissions = new Map<Promise<void>, AgentSession>();
	private _reviewWorkflows?: ReviewWorkflowManager;
	readonly conversationProjectionFeed: ConversationProjectionFeed;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		subagentContext?: SubagentRuntimeContext,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.subagentContext = subagentContext;
		this.conversationProjectionFeed = new ConversationProjectionFeed(
			this.createConversationProjectionSource(_session),
		);
		this.bindConversationTranscriptCommits(_session);
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	/**
	 * Detached review workflows scoped to this runtime. Events are published
	 * through the runtime conversation projection feed so they survive client
	 * detach/reattach; disposal aborts every active review.
	 */
	get reviewWorkflows(): ReviewWorkflowManager {
		if (!this._reviewWorkflows) {
			this._reviewWorkflows = new ReviewWorkflowManager({
				publishEvent: (event) => {
					this.conversationProjectionFeed.publishExternal(event);
				},
			});
		}
		return this._reviewWorkflows;
	}

	/**
	 * Start the one-shot recovery of durable queued remote input. The projection
	 * source is already bound when this is called, so recovered transcript and
	 * queue events remain observable even though runtime attachment does not wait
	 * for the provider turn to drain.
	 */
	startRecoveredClientInputs(): Promise<void> {
		this.recoveredClientInputsEnabled = true;
		const session = this.session;
		const current = this.recoveredClientInputsTask;
		if (current?.session === session) {
			return current.promise;
		}
		if (this.disposePromise || this.sessionInvalidated) {
			return Promise.reject(new Error("Cannot recover client input after the agent runtime was invalidated"));
		}

		let state!: RecoveredClientInputsTask;
		// Capture the AgentSession abort generation synchronously. Deferring the
		// resume call itself to a promise microtask lets same-tick dispose/replace
		// abort first and then accidentally dispatch on the new generation.
		const recoveryOperation =
			current && !current.settled
				? (async () => {
						current.cancellationRequested = true;
						await current.session.abort("session_replacement").catch(() => undefined);
						await current.promise.catch(() => undefined);
						if (state.cancellationRequested) {
							throw new Error("Recovered client input processing was cancelled before dispatch");
						}
						await session.resumeRecoveredClientInputs();
					})()
				: session.resumeRecoveredClientInputs();
		const task = recoveryOperation
			.then(() => {
				state.succeeded = true;
			})
			.catch((error: unknown) => {
				if (!state.cancellationRequested && this.session === session && !this.sessionInvalidated) {
					const recovery = session.sessionManager.getClientInputRecoveryPlan();
					const message =
						recovery.kind === "blocked"
							? `Client input ${JSON.stringify(recovery.blocker.clientMessageId)} has an ambiguous post-restart outcome; later durable queued input remains visible but fenced from automatic replay.`
							: recovery.records.length > 0
								? "Recovered client input replay failed; its durable queued input remains available for an explicit retry or daemon restart."
								: "Recovered client input processing failed after its durable dispatch boundary; it was not automatically replayed.";
					if (
						!this._diagnostics.some(
							(diagnostic) => diagnostic.type === "warning" && diagnostic.message === message,
						)
					) {
						this._diagnostics.push({ type: "warning", message });
						console.warn(message);
					}
				}
				throw error;
			})
			.finally(() => {
				state.settled = true;
				// A successful recovery is one-shot for this session generation. A
				// failed attempt remains explicitly retryable without permitting two
				// overlapping attempts.
				if (!state.succeeded && this.recoveredClientInputsTask === state) {
					this.recoveredClientInputsTask = undefined;
				}
			});
		state = {
			session,
			promise: task,
			settled: false,
			succeeded: false,
			cancellationRequested: false,
		};
		// The runtime retains and joins the original rejection. Observe it here so
		// a background recovery failure can never become an unhandled rejection.
		void task.catch(() => undefined);
		this.recoveredClientInputsTask = state;
		return task;
	}

	private async abortAndJoinRecoveredClientInputs(session: AgentSession): Promise<void> {
		const recovery = this.recoveredClientInputsTask;
		if (!recovery || recovery.session !== session || recovery.settled) {
			return;
		}
		recovery.cancellationRequested = true;
		await recovery.session.abort("session_replacement").catch(() => undefined);
		await recovery.promise.catch(() => undefined);
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setPrepareSessionReplacement(
		prepare?: (target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>,
	): void {
		this.prepareSessionReplacement = prepare;
	}

	/** The currently installed rebind handler, so a temporary owner can restore it. */
	getRebindSession(): ((session: AgentSession) => Promise<void>) | undefined {
		return this.rebindSession;
	}

	/**
	 * Observe every installed replacement session without taking ownership of the
	 * runtime's legacy primary rebind hook. Co-attached RPC frontends use this so
	 * one subscriber cannot overwrite another's lifecycle callback.
	 */
	subscribeSessionReplaced(listener: (session: AgentSession) => Promise<void> | void): () => void {
		this.sessionReplacementListeners.add(listener);
		return () => {
			this.sessionReplacementListeners.delete(listener);
		};
	}

	/**
	 * Register a host-ownership barrier for replacement sessions. The new source
	 * is already bound and reducing state, but its cursor-zero generation remains
	 * unpublished until every listener has atomically rekeyed runtime/lease state.
	 */
	subscribeSessionWillProject(listener: (session: AgentSession) => Promise<void> | void): () => void {
		this.sessionWillProjectListeners.add(listener);
		return () => {
			this.sessionWillProjectListeners.delete(listener);
		};
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/** Wait for the fixed set of lifecycle operations admitted before this call. */
	waitForSessionOperations(): Promise<void> {
		return this.lifecycleTail;
	}

	/** True from structural command admission through replacement publication/failure. */
	get isSessionOperationInProgress(): boolean {
		return (
			this.pendingStructuralOperationCount > 0 || (this.disposePromise !== undefined && !this.sessionInvalidated)
		);
	}

	/**
	 * Execute against one stable session generation. Structural calls made by the
	 * operation itself are re-entrant; unrelated streams remain queued outside the
	 * actor and cannot observe teardown/create or an unpublished replacement.
	 */
	runWithStableSession<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
		if (!this.acceptingStructuralOperations) {
			return Promise.reject(new Error("Agent session runtime is no longer accepting session operations"));
		}
		const execute = async () => operation(this.session);
		return this.runOrEnqueueLifecycleOperation(execute);
	}

	/**
	 * Fence structural replacement behind an RPC prompt's durable admission
	 * without serializing unrelated reads or holding the actor for its provider
	 * turn. Registration is synchronous while the caller owns a stable session.
	 */
	trackClientInputAdmission(session: AgentSession, admission: Promise<void>): void {
		if (
			!this.acceptingStructuralOperations ||
			this.sessionInvalidated ||
			this.sessionReplacementInProgress ||
			this.session !== session
		) {
			throw new Error("Agent session generation changed before client input admission");
		}
		const observed = admission.then(
			() => undefined,
			() => undefined,
		);
		this.clientInputAdmissions.set(observed, session);
		void observed.finally(() => {
			this.clientInputAdmissions.delete(observed);
		});
	}

	private async waitForClientInputAdmissions(session: AgentSession): Promise<void> {
		while (true) {
			const pending = [...this.clientInputAdmissions]
				.filter(([, owner]) => owner === session)
				.map(([admission]) => admission);
			if (pending.length === 0) return;
			await Promise.all(pending);
		}
	}

	/**
	 * Acquire the current session generation for an interruption without joining
	 * the lifecycle FIFO. Interrupts must be able to stop a busy turn, but they
	 * may never act through a stream-local session pointer while replacement is
	 * invalidating or publishing ownership.
	 */
	runSessionInterruption<T>(operation: (session: AgentSession) => T): T {
		if (!this.acceptingStructuralOperations || this.sessionInvalidated || this.sessionReplacementInProgress) {
			throw new Error("Agent session generation is changing; retry the interruption");
		}
		// JavaScript cannot interleave another lifecycle transition during this
		// synchronous capability acquisition/callback invocation. Async results may
		// settle later, but they retain only this explicitly captured generation.
		return operation(this.session);
	}

	private runOrEnqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const parentLease = this.lifecycleActorContext.getStore();
		if (!parentLease?.active) {
			return this.enqueueLifecycleOperation(operation);
		}
		const result = this.runLifecycleOperation(operation);
		// Re-entrant calls must remain part of their caller's ownership turn even
		// when the caller intentionally does not await the returned promise. The
		// tracked completion observes rejection without changing the nested caller's
		// own promise semantics.
		parentLease.children.add(
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	private async runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const lease: AgentSessionLifecycleLease = { active: true, children: new Set() };
		try {
			return await this.lifecycleActorContext.run(lease, operation);
		} finally {
			// AsyncLocalStorage propagates into detached descendants. Revoking the
			// per-invocation lease at callback settlement prevents those descendants
			// from retaining ambient actor authority after their parent has returned.
			lease.active = false;
			await Promise.all(lease.children);
		}
	}

	private enqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lifecycleTail.then(() => this.runLifecycleOperation(operation));
		this.lifecycleTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private runStructuralOperation<T>(
		operation: (context: AgentSessionStructuralOperation) => Promise<T>,
		assertConversationGenerationCurrent?: () => void,
	): Promise<T> {
		if (!this.acceptingStructuralOperations) {
			return Promise.reject(new Error("Agent session runtime is no longer accepting structural operations"));
		}
		const context: AgentSessionStructuralOperation = {
			expectedSession: this.session,
			expectedRevision: this.lifecycleRevision,
			expectedConversationGenerationRevision: this.session.conversationGenerationRevision,
			assertConversationGenerationCurrent,
		};
		this.pendingStructuralOperationCount++;
		const execute = async () => {
			this.assertStructuralOperationCurrent(context);
			return operation(context);
		};
		const result = this.runOrEnqueueLifecycleOperation(execute);
		return result.finally(() => {
			this.pendingStructuralOperationCount--;
		});
	}

	private assertStructuralOperationCurrent(context: AgentSessionStructuralOperation): void {
		// Preserve a transport's stable stale-authority error when it supplied a
		// lease; the revision check remains the transport-neutral defense in depth.
		context.assertConversationGenerationCurrent?.();
		if (
			this.sessionInvalidated ||
			this.session !== context.expectedSession ||
			this.lifecycleRevision !== context.expectedRevision ||
			this.session.conversationGenerationRevision !== context.expectedConversationGenerationRevision
		) {
			throw new Error("Stale agent session structural operation");
		}
		if (this.session.hasActiveSessionMutation) {
			throw new Error("Cannot change sessions while a session mutation is active; wait for it to finish");
		}
		if (this.session.isStreaming) {
			throw new Error("Cannot change sessions while an agent run is active; abort or wait for it to finish");
		}
		if (this.session.isBashRunning) {
			throw new Error("Cannot change sessions while a bash run is active; abort or wait for it to finish");
		}
	}

	private assertNoActiveDetachedReview(): void {
		if (this._reviewWorkflows?.hasActiveWorkflows) {
			throw new Error("Cannot change sessions while a detached review is active; cancel or wait for it to finish");
		}
	}

	private getReplacementProfile(): string | undefined {
		return this.services.settingsManager.getRequestedProfile();
	}

	private getReplacementGitContextOptions(cwd: string): { workspaceName?: string; baseRef?: string } {
		if (resolvePath(cwd) !== resolvePath(this.cwd)) return {};
		return {
			workspaceName: this.services.workspaceName,
			baseRef: this.services.baseRef,
		};
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionRef?: SessionReference,
	): Promise<{ cancelled: boolean }> {
		if (this.session.sessionManager.getConversationAuthorityStatus().status === "reconciliation_required") {
			return { cancelled: false };
		}
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionRef,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		if (this.session.sessionManager.getConversationAuthorityStatus().status === "reconciliation_required") {
			return { cancelled: false };
		}
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionRef?: SessionReference,
		onInvalidated?: () => void,
	): Promise<void> {
		if (this.session.sessionManager.getConversationAuthorityStatus().status === "available") {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionRef,
			});
		}
		this.beforeSessionInvalidate?.();
		onInvalidated?.();
		try {
			await this.session.disposeSubagentToolManager();
		} finally {
			await this.session.disposeForSessionReplacement();
		}
	}

	private async disposeReplacementSession(session: AgentSession): Promise<void> {
		try {
			await session.disposeSubagentToolManager();
		} finally {
			session.dispose("disposal");
			await session.waitForClosed();
		}
	}

	private async replaceCurrentSession(options: {
		operation: AgentSessionStructuralOperation;
		reason: SessionShutdownEvent["reason"];
		previousSessionId?: string;
		allowSameSessionIdentity?: boolean;
		sessionManager: SessionManager;
		create: () => Promise<CreateAgentSessionRuntimeResult>;
		afterApply?: () => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		/** RPC request correlated with the replacement bootstrap, when any. */
		rebindRequestId?: string;
	}): Promise<{ seeded: boolean }> {
		const releasePreparedManagerOnFailure = options.sessionManager !== this.session.sessionManager;
		try {
			// The entire public operation runs in the lifecycle actor. Re-check at the
			// ownership boundary so a queued command can never prepare against the
			// session that happened to be current when the command was admitted.
			this.assertStructuralOperationCurrent(options.operation);
			if (this.sessionReplacementInProgress) {
				throw new Error("Agent session replacement is already in progress");
			}
			// Prompt handlers return to the transport immediately so state reads remain
			// responsive, but structural teardown must wait until every earlier prompt
			// has either durably queued, canonically started, or failed preflight.
			await this.waitForClientInputAdmissions(this.session);
			this.assertStructuralOperationCurrent(options.operation);
			if (this.session.sessionManager.getConversationAuthorityStatus().status === "available") {
				const clientInputRecovery = this.session.sessionManager.getClientInputRecoveryPlan();
				if (clientInputRecovery.kind === "blocked") {
					throw new Error("Cannot replace the session while a durable client input outcome is ambiguous");
				}
				if (clientInputRecovery.kind === "replay") {
					throw new Error("Cannot replace the session while durable client input is still queued");
				}
			}
			const previousSessionId = options.previousSessionId ?? this.session.sessionId;
			const sessionId = options.sessionManager.getSessionId();
			const sameSessionIdentity = previousSessionId === sessionId;
			if (sameSessionIdentity) {
				const previousSessionRef = this.session.sessionRef;
				const replacementSessionRef = options.sessionManager.getSessionRef();
				if (
					!options.allowSameSessionIdentity ||
					previousSessionRef === undefined ||
					replacementSessionRef === undefined ||
					!sessionRefsEqual(previousSessionRef, replacementSessionRef)
				) {
					throw new Error(
						"Cannot replace the current session with a different persisted reference using the same session ID",
					);
				}
			}
			this.sessionReplacementInProgress = true;
			try {
				await this.abortAndJoinRecoveredClientInputs(this.session);
				this.assertStructuralOperationCurrent(options.operation);
				// Defense in depth for unexpected re-entrant review starts after an
				// operation-specific pre-preparation check.
				this.assertNoActiveDetachedReview();
				const transaction = sameSessionIdentity
					? undefined
					: await this.prepareSessionReplacement?.({
							previousSessionId,
							sessionId,
							cwd: options.sessionManager.getCwd(),
						});
				let invalidated = false;
				let created: CreateAgentSessionRuntimeResult | undefined;
				let applied = false;
				try {
					this.assertStructuralOperationCurrent(options.operation);
					await this.teardownCurrent(options.reason, options.sessionManager.getSessionRef(), () => {
						this.assertStructuralOperationCurrent(options.operation);
						invalidated = true;
						this.sessionInvalidated = true;
						this.lifecycleRevision++;
					});
					created = await options.create();
					await created.session.sessionManager.flush();
					this.applyReplacement(created);
					applied = true;
					await options.afterApply?.();
					if (
						this.sessionInvalidated ||
						this.session !== created.session ||
						this.lifecycleRevision !== options.operation.expectedRevision + 1
					) {
						throw new Error("Agent session replacement changed before ownership commit");
					}
					await transaction?.commit();
					return await this.finishSessionReplacement(options.withSession, transaction, options.rebindRequestId);
				} catch (error: unknown) {
					const replacementError = error instanceof Error ? error : new Error(String(error));
					if (applied) {
						this.conversationProjectionFeed.failSourceRebind(replacementError);
						await this.disposeReplacementSession(this.session).catch(() => {});
						this.sessionInvalidated = true;
					} else if (created) {
						await this.disposeReplacementSession(created.session).catch(() => {});
					}
					if (invalidated) {
						this.acceptingStructuralOperations = false;
						this.conversationProjectionFeed.failSourceRebind(replacementError);
						this.conversationProjectionFeed.dispose();
						this.detachConversationTranscriptCommits();
						this.detachConversationTranscriptCommits = () => {};
					}
					if (transaction) {
						try {
							if (invalidated) {
								await transaction.dispose();
							} else {
								await transaction.rollback();
							}
						} catch {
							// The ownership service must also clear transactions on disconnect.
						}
					}
					throw replacementError;
				}
			} finally {
				this.sessionReplacementInProgress = false;
			}
		} catch (error) {
			if (releasePreparedManagerOnFailure) {
				try {
					await options.sessionManager.closePersistence();
				} catch (closeError) {
					throw new AggregateError(
						[error, closeError],
						"Session replacement failed and its prepared manager could not be closed",
					);
				}
			}
			throw error;
		}
	}

	private applyReplacement(result: CreateAgentSessionRuntimeResult): void {
		const source = this.createConversationProjectionSource(result.session);
		// Fence the old generation before subscription. A source implementation may
		// synchronously replay a transcript commit while attaching; it must reduce
		// only inside the unpublished replacement generation.
		this.conversationProjectionFeed.beginSourceRebind(source);
		let detachTranscriptCommits: () => void;
		try {
			detachTranscriptCommits = this.subscribeConversationTranscriptCommits(result.session);
		} catch (error: unknown) {
			const subscriptionError = error instanceof Error ? error : new Error(String(error));
			this.conversationProjectionFeed.failSourceRebind(subscriptionError);
			throw subscriptionError;
		}
		// Source binding and transcript subscription are the staged bundle. Do not
		// expose the replacement through runtime fields until both are installed.
		try {
			this.detachConversationTranscriptCommits();
		} catch (error: unknown) {
			detachTranscriptCommits();
			const detachError = error instanceof Error ? error : new Error(String(error));
			this.conversationProjectionFeed.failSourceRebind(detachError);
			throw detachError;
		}
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.detachConversationTranscriptCommits = detachTranscriptCommits;
		this.sessionInvalidated = false;
	}

	private createConversationProjectionSource(session: AgentSession): ConversationProjectionSource {
		const sessionLike = session as AgentSession & {
			subscribe?: AgentSession["subscribe"];
			subscribeConversationGenerationChanges?: AgentSession["subscribeConversationGenerationChanges"];
		};
		return {
			subscribe: (listener) =>
				typeof sessionLike.subscribe === "function"
					? sessionLike.subscribe((event) => listener(event), { monitorGitContext: false })
					: () => {},
			retainObservation: () => session.gitContextProvider.retainObservation(),
			subscribeAuthorityLoss: (listener) =>
				session.sessionManager.subscribeConversationAuthorityChanges((status) => listener(status.error)),
			subscribeGenerationChanges: (listener) =>
				typeof sessionLike.subscribeConversationGenerationChanges === "function"
					? sessionLike.subscribeConversationGenerationChanges(() => listener())
					: () => {},
		};
	}

	private subscribeConversationTranscriptCommits(session: AgentSession): () => void {
		if (typeof session.sessionManager?.subscribeEntries !== "function") {
			return () => {};
		}
		return session.sessionManager.subscribeEntries((entry) => {
			// Defense in depth: host-only sidecar records (admission WAL, subagent
			// spawn edges) are never transcript commits, even if a custom
			// SessionManager emits them.
			if (isHostOnlySessionEntry(entry)) return;
			// Planning snapshots are durable branch-local state, not transcript
			// rows. Clients receive them through planning_state_changed and every
			// bootstrap/checkpoint instead.
			if (entry.type === "planning_state_change") return;
			this.conversationProjectionFeed.publishExternal({
				type: "conversation_transcript_committed",
				entry,
			} satisfies ConversationTranscriptCommittedEvent);
		});
	}

	private bindConversationTranscriptCommits(session: AgentSession): void {
		this.detachConversationTranscriptCommits = this.subscribeConversationTranscriptCommits(session);
	}

	/** Publish a canonical conversation reducer event to every attached subscriber. */
	publishConversationProjectionEvent(event: object): void {
		this.conversationProjectionFeed.publishExternal(event);
	}

	private async finishSessionReplacement(
		withSession: ((ctx: ReplacedSessionContext) => Promise<void>) | undefined,
		transaction: AgentSessionReplacementTransaction | undefined,
		rebindRequestId: string | undefined,
	): Promise<{ seeded: boolean }> {
		try {
			for (const listener of [...this.sessionWillProjectListeners]) {
				await listener(this.session);
			}
		} catch (error: unknown) {
			const ownershipError = error instanceof Error ? error : new Error(String(error));
			this.conversationProjectionFeed.failSourceRebind(ownershipError);
			throw ownershipError;
		}
		this.conversationProjectionFeed.commitSourceRebind(rebindRequestId);
		await transaction?.finalize?.();
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		for (const listener of [...this.sessionReplacementListeners]) {
			await listener(this.session);
		}
		if (this.recoveredClientInputsEnabled) {
			// Admit and drain older durable input before post-replacement callbacks
			// can submit fresh work. Recovery failures are already diagnosed and leave
			// their exact queue visible; they do not invalidate the replacement.
			try {
				await this.startRecoveredClientInputs();
			} catch {
				// The replacement session and its durable queue remain authoritative,
				// but post-replacement callbacks may submit fresh work. Skip them until
				// a later attach explicitly retries and drains recovery, and surface
				// the skip so callers cannot mistake the non-cancelled result for a
				// completed `withSession` seed.
				return { seeded: false };
			}
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
			await this.session.sessionManager.flush();
			return { seeded: true };
		}
		await this.session.sessionManager.flush();
		return { seeded: false };
	}

	private async listWorkspaceSessionInfos(includeMessageFreeDurable = false): Promise<SessionInfo[]> {
		const workspaceCwd = resolvePath(this.cwd);
		return (
			await SessionManager.list(this.cwd, this.session.sessionManager.getSessionDir(), undefined, {
				includeMessageFreeDurable,
			})
		).filter((session) => !session.cwd || resolvePath(session.cwd) === workspaceCwd);
	}

	getCurrentSessionSummary(): WorkspaceSessionSummary {
		const header = this.session.sessionManager.getHeader();
		const entries = this.session.sessionManager.getEntries();
		const startingGitContext = this.session.sessionManager.getStartingGitContext();
		const summary = summarizeSessionEntries(entries);
		return {
			sessionId: this.session.sessionId,
			sessionName: this.session.sessionName,
			createdAt: toSessionTimestamp(header?.timestamp),
			modifiedAt:
				typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
					? new Date(summary.lastActivityTime).toISOString()
					: toSessionTimestamp(header?.timestamp),
			messageCount: summary.messageCount,
			firstMessage: summary.firstMessage,
			current: true,
			cwd: header?.cwd ?? this.cwd,
			origin: header?.origin,
			...(startingGitContext === undefined ? {} : { startingGitContext }),
		};
	}

	async listSessions(): Promise<WorkspaceSessionSummary[]> {
		const current = this.getCurrentSessionSummary();
		const summaries = (await this.listWorkspaceSessionInfos()).map((info) =>
			sessionInfoToSummary(info, this.session.sessionId),
		);
		const currentIndex = summaries.findIndex((summary) => summary.sessionId === current.sessionId);
		if (currentIndex === -1) {
			return [current, ...summaries];
		}
		summaries[currentIndex] = current;
		return summaries;
	}

	async switchSessionById(
		sessionId: string,
		options?: AgentSessionSwitchOptions,
	): Promise<AgentSessionReplacementResult> {
		return this.runStructuralOperation(
			(operation) => this.switchSessionByIdWithinOperation(sessionId, options, operation),
			options?.assertConversationGenerationCurrent,
		);
	}

	private async switchSessionByIdWithinOperation(
		sessionId: string,
		options: AgentSessionSwitchOptions | undefined,
		operation: AgentSessionStructuralOperation,
	): Promise<AgentSessionReplacementResult> {
		assertValidSessionId(sessionId);
		if (sessionId === this.session.sessionId) {
			if (this.session.sessionManager.getConversationAuthorityStatus().status === "available") {
				// No replacement happens, so a requested withSession callback never runs.
				return { cancelled: false, seeded: false };
			}
			const sessionRef = this.session.sessionRef;
			if (sessionRef === undefined) {
				throw new Error("Cannot reconcile an in-memory session without an authoritative session reference");
			}
			return this.switchSessionWithinOperation(sessionRef, options, operation, true);
		}
		const target = (await this.listWorkspaceSessionInfos(true)).find((session) => session.id === sessionId);
		this.assertStructuralOperationCurrent(operation);
		if (!target) {
			throw new Error(`Session not found in current workspace: ${sessionId}`);
		}
		return this.switchSessionWithinOperation(
			target.ref,
			target.cwd ? options : { ...options, cwdOverride: this.cwd },
			operation,
		);
	}

	async switchSession(
		sessionRef: SessionReference,
		options?: AgentSessionSwitchOptions,
	): Promise<AgentSessionReplacementResult> {
		return this.runStructuralOperation(
			(operation) => this.switchSessionWithinOperation(sessionRef, options, operation),
			options?.assertConversationGenerationCurrent,
		);
	}

	private async switchSessionWithinOperation(
		sessionRef: SessionReference,
		options: AgentSessionSwitchOptions | undefined,
		operation: AgentSessionStructuralOperation,
		refreshCurrentSession = false,
	): Promise<AgentSessionReplacementResult> {
		const currentSessionRef = this.session.sessionRef;
		const targetsCurrentSession = currentSessionRef !== undefined && sessionRefsEqual(sessionRef, currentSessionRef);
		if (
			targetsCurrentSession &&
			this.session.sessionManager.getConversationAuthorityStatus().status === "available"
		) {
			// No replacement happens, so a requested withSession callback never runs.
			return { cancelled: false, seeded: false };
		}
		if (targetsCurrentSession) refreshCurrentSession = true;
		const beforeResult = await this.emitBeforeSwitch("resume", sessionRef);
		this.assertStructuralOperationCurrent(operation);
		if (beforeResult.cancelled) {
			return { cancelled: true, seeded: false };
		}
		this.assertNoActiveDetachedReview();

		const previousSessionRef = this.session.sessionRef;
		const sessionManager = await SessionManager.open(sessionRef, options?.cwdOverride);
		try {
			this.assertStructuralOperationCurrent(operation);
			assertSessionCwdExists(sessionManager, this.cwd);
			const replacement = await this.replaceCurrentSession({
				operation,
				reason: "resume",
				allowSameSessionIdentity: refreshCurrentSession,
				sessionManager,
				create: () =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						...this.getReplacementGitContextOptions(sessionManager.getCwd()),
						sessionStartEvent: { type: "session_start", reason: "resume", previousSessionRef },
						projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
						profile: this.getReplacementProfile(),
						subagentContext: this.subagentContext,
					}),
				withSession: options?.withSession,
			});
			return { cancelled: false, seeded: replacement.seeded };
		} catch (error) {
			return await closePreparedSessionManager(
				sessionManager,
				error,
				"Session switch failed and its prepared manager could not be closed",
			);
		}
	}

	async newSession(options?: {
		parentSessionRef?: SessionReference;
		/** RPC request correlated with the replacement bootstrap, when any. */
		rebindRequestId?: string;
		/** Override the new session's cwd (e.g. a daemon-managed worktree checkout). */
		cwd?: string;
		/** Override the session dir (e.g. the parent workspace's default dir for worktree sessions). */
		sessionDir?: string;
		/** Host-owned workspace display name for the replacement Git context. */
		workspaceName?: string;
		/** Trusted managed-worktree base ref for the replacement Git context. */
		baseRef?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		/** Internal remote mutation lease revalidated at every awaited replacement boundary. */
		assertConversationGenerationCurrent?: () => void;
	}): Promise<AgentSessionReplacementResult> {
		return this.runStructuralOperation(
			(operation) => this.newSessionWithinOperation(options, operation),
			options?.assertConversationGenerationCurrent,
		);
	}

	/**
	 * Approve and start one exact ready-plan revision. The execution snapshot is
	 * durable before provider work begins, so retries observe the same execution
	 * identity instead of starting a second run.
	 */
	async executePlan(
		planId: string,
		expectedRevision: number,
		strategy: PlanExecutionStrategy,
		assertConversationGenerationCurrent?: () => void,
	): Promise<{ planning: PlanningState; selectedSessionId: string; started: boolean }> {
		const sourceSession = this.session;
		const sourcePlanning = sourceSession.planningState;
		const sourcePlan = sourcePlanning.plan;
		if (
			sourcePlan?.id === planId &&
			sourcePlan.execution?.approvedRevision === expectedRevision &&
			sourcePlan.execution.strategy === strategy
		) {
			return {
				planning: sourcePlanning,
				selectedSessionId: sourcePlan.execution.targetSessionId,
				started: false,
			};
		}
		if (!sourcePlan || sourcePlan.id !== planId || sourcePlan.revision !== expectedRevision) {
			throw new StalePlanRevisionError();
		}
		if (sourcePlan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		assertConversationGenerationCurrent?.();

		if (strategy === "retain_context") {
			const execution: PlanExecution = {
				id: randomUUID(),
				approvedRevision: expectedRevision,
				strategy,
				sourceSessionId: sourceSession.sessionId,
				targetSessionId: sourceSession.sessionId,
			};
			const result = await sourceSession.activatePlan(planId, expectedRevision, execution);
			if (result.activated) {
				await sourceSession.sessionManager.flush();
				void sourceSession
					.sendCustomMessage(
						{
							customType: PLAN_EXECUTION_CUSTOM_TYPE,
							content: createPlanExecutionPrompt(result.planning.plan!),
							display: true,
						},
						{ triggerTurn: true },
					)
					.catch(() => undefined);
			}
			return {
				planning: result.planning,
				selectedSessionId: sourceSession.sessionId,
				started: result.activated,
			};
		}

		const sourceSessionId = sourceSession.sessionId;
		const sourceSessionRef = sourceSession.sessionRef;
		const sourceManager = sourceSession.sessionManager;
		const sourceModel = sourceSession.model;
		const sourceThinking = sourceSession.thinkingLevel;
		const sourceFastMode = sourceSession.fastModeEnabled;
		const sourceReviewState = captureReviewStateForHandoff(sourceManager);
		let execution: PlanExecution | undefined;
		const replacement = await this.newSession({
			...(sourceSessionRef ? { parentSessionRef: sourceSessionRef } : {}),
			setup: async (sessionManager) => {
				restoreReviewStateFromHandoff(sessionManager, sourceReviewState);
				execution = {
					id: randomUUID(),
					approvedRevision: expectedRevision,
					strategy,
					sourceSessionId,
					targetSessionId: sessionManager.getSessionId(),
				};
				sessionManager.appendPlanningState({
					mode: "build",
					plan: {
						...clonePlanState(sourcePlan),
						revision: sourcePlan.revision + 1,
						phase: "active",
						execution,
					},
				});
				if (sourceModel) {
					sessionManager.appendModelChange(sourceModel.provider, sourceModel.id);
				}
				sessionManager.appendThinkingLevelChange(sourceThinking);
				if (sourceFastMode) {
					sessionManager.appendFastModeChange(true);
				}
			},
			withSession: async (context) => {
				if (!execution) {
					throw new Error("Plan execution session was not initialized");
				}
				// The source AgentSession has been disposed and its persistence lane
				// sealed before this post-replacement handoff callback. Reopen persisted
				// sources as the new exclusive writer; in-memory sources remain reusable.
				const handoffManager = sourceSessionRef ? await SessionManager.open(sourceSessionRef) : sourceManager;
				try {
					handoffManager.appendPlanningState({
						mode: "build",
						plan: {
							...clonePlanState(sourcePlan),
							revision: sourcePlan.revision + 1,
							phase: "handed_off",
							execution,
						},
					});
					await handoffManager.flush();
				} catch (error) {
					if (sourceSessionRef) {
						try {
							await handoffManager.closePersistence();
						} catch (closeError) {
							throw new AggregateError(
								[error, closeError],
								"Plan handoff failed and its source manager could not be closed",
							);
						}
					}
					throw error;
				}
				if (sourceSessionRef) await handoffManager.closePersistence();
				const activePlan = this.session.planningState.plan;
				if (!activePlan || activePlan.phase !== "active") {
					throw new Error("Plan execution session did not restore its active plan");
				}
				void context
					.sendMessage(
						{
							customType: PLAN_EXECUTION_CUSTOM_TYPE,
							content: createPlanExecutionPrompt(activePlan),
							display: true,
						},
						{ triggerTurn: true },
					)
					.catch(() => undefined);
			},
			assertConversationGenerationCurrent,
		});
		if (replacement.cancelled || !replacement.seeded || !execution) {
			throw new Error("Plan execution session was not created");
		}
		return {
			planning: this.session.planningState,
			selectedSessionId: execution.targetSessionId,
			started: true,
		};
	}

	private async newSessionWithinOperation(
		options:
			| {
					parentSessionRef?: SessionReference;
					rebindRequestId?: string;
					cwd?: string;
					sessionDir?: string;
					workspaceName?: string;
					baseRef?: string;
					setup?: (sessionManager: SessionManager) => Promise<void>;
					withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
					assertConversationGenerationCurrent?: () => void;
			  }
			| undefined,
		operation: AgentSessionStructuralOperation,
	): Promise<AgentSessionReplacementResult> {
		const beforeResult = await this.emitBeforeSwitch("new");
		this.assertStructuralOperationCurrent(operation);
		if (beforeResult.cancelled) {
			return { cancelled: true, seeded: false };
		}
		this.assertNoActiveDetachedReview();

		const previousSessionRef = this.session.sessionRef;
		const cwd = options?.cwd ?? this.cwd;
		const sessionDir = options?.sessionDir ?? this.session.sessionManager.getSessionDir();
		let sessionManager: SessionManager;
		if (this.session.sessionManager.isPersisted()) {
			sessionManager = await SessionManager.create(
				cwd,
				sessionDir,
				options?.parentSessionRef === undefined ? undefined : { parentSession: options.parentSessionRef },
			);
		} else {
			sessionManager = SessionManager.inMemory(cwd);
			if (options?.parentSessionRef) {
				sessionManager.newSession({ parentSession: options.parentSessionRef });
			}
		}
		try {
			this.assertStructuralOperationCurrent(operation);
			if (options?.setup) {
				await options.setup(sessionManager);
				this.assertStructuralOperationCurrent(operation);
			}
			await sessionManager.flush();

			const replacement = await this.replaceCurrentSession({
				operation,
				reason: "new",
				sessionManager,
				create: () =>
					this.createRuntime({
						cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						...this.getReplacementGitContextOptions(cwd),
						...(options?.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
						...(options?.baseRef === undefined ? {} : { baseRef: options.baseRef }),
						sessionStartEvent: { type: "session_start", reason: "new", previousSessionRef },
						profile: this.getReplacementProfile(),
						subagentContext: this.subagentContext,
					}),
				withSession: options?.withSession,
				rebindRequestId: options?.rebindRequestId,
			});
			return { cancelled: false, seeded: replacement.seeded };
		} catch (error) {
			if (sessionManager === this.session.sessionManager) {
				return await closePreparedSessionManager(
					sessionManager,
					error,
					"New session preparation failed and its installed manager could not be closed",
				);
			}
			return await discardPreparedSessionManager(
				sessionManager,
				error,
				"New session preparation failed and its manager persistence could not be discarded",
			);
		}
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<AgentSessionReplacementResult & { selectedText?: string }> {
		return this.runStructuralOperation((operation) => this.forkWithinOperation(entryId, options, operation));
	}

	private async forkWithinOperation(
		entryId: string,
		options: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> } | undefined,
		operation: AgentSessionStructuralOperation,
	): Promise<AgentSessionReplacementResult & { selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		this.assertStructuralOperationCurrent(operation);
		if (beforeResult.cancelled) {
			return { cancelled: true, seeded: false };
		}
		this.assertNoActiveDetachedReview();
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionRef = this.session.sessionRef;
		const previousSessionId = this.session.sessionId;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionRef = this.session.sessionRef;
			if (!currentSessionRef) {
				throw new Error("Persisted session is missing a session reference");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = await SessionManager.create(this.cwd, sessionDir, {
					parentSession: currentSessionRef,
				});
				try {
					this.assertStructuralOperationCurrent(operation);
					const replacement = await this.replaceCurrentSession({
						operation,
						reason: "fork",
						previousSessionId,
						sessionManager,
						create: () =>
							this.createRuntime({
								cwd: this.cwd,
								agentDir: this.services.agentDir,
								sessionManager,
								...this.getReplacementGitContextOptions(this.cwd),
								sessionStartEvent: { type: "session_start", reason: "fork", previousSessionRef },
								profile: this.getReplacementProfile(),
								subagentContext: this.subagentContext,
							}),
						withSession: options?.withSession,
					});
					return { cancelled: false, seeded: replacement.seeded, selectedText };
				} catch (error) {
					return await closePreparedSessionManager(
						sessionManager,
						error,
						"Session fork failed and its prepared manager could not be closed",
					);
				}
			}

			await this.session.sessionManager.flush();
			this.assertStructuralOperationCurrent(operation);
			const sessionManager = await SessionManager.open(currentSessionRef);
			try {
				this.assertStructuralOperationCurrent(operation);
				const forkedSessionRef = await sessionManager.createBranchedSession(targetLeafId);
				this.assertStructuralOperationCurrent(operation);
				if (!forkedSessionRef) {
					throw new Error("Failed to create forked session");
				}
				await sessionManager.flush();
				const replacement = await this.replaceCurrentSession({
					operation,
					reason: "fork",
					previousSessionId,
					sessionManager,
					create: () =>
						this.createRuntime({
							cwd: sessionManager.getCwd(),
							agentDir: this.services.agentDir,
							sessionManager,
							...this.getReplacementGitContextOptions(sessionManager.getCwd()),
							sessionStartEvent: { type: "session_start", reason: "fork", previousSessionRef },
							profile: this.getReplacementProfile(),
							subagentContext: this.subagentContext,
						}),
					withSession: options?.withSession,
				});
				return { cancelled: false, seeded: replacement.seeded, selectedText };
			} catch (error) {
				return await closePreparedSessionManager(
					sessionManager,
					error,
					"Session fork failed and its prepared manager could not be closed",
				);
			}
		}

		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession();
		} else {
			await sessionManager.createBranchedSession(targetLeafId);
		}
		this.assertStructuralOperationCurrent(operation);
		const replacement = await this.replaceCurrentSession({
			operation,
			reason: "fork",
			previousSessionId,
			sessionManager,
			create: () =>
				this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					...this.getReplacementGitContextOptions(this.cwd),
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionRef },
					profile: this.getReplacementProfile(),
					subagentContext: this.subagentContext,
				}),
			withSession: options?.withSession,
		});
		return { cancelled: false, seeded: replacement.seeded, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runStructuralOperation((operation) =>
			this.importFromJsonlWithinOperation(inputPath, cwdOverride, operation),
		);
	}

	private async createImportedSessionManager(
		inputPath: string,
		cwdOverride: string | undefined,
		assertCurrent: () => void,
	): Promise<SessionManager> {
		const fileEntries = loadEntriesFromFile(inputPath);
		if (fileEntries.length === 0) {
			throw new Error(`Session file has no valid session header: ${inputPath}`);
		}
		const header = assertCurrentSessionSnapshot(fileEntries);

		const importedCwd = resolvePath(cwdOverride ?? (header.cwd || this.cwd));
		if (cwdOverride === undefined && !existsSync(importedCwd)) {
			throw new MissingSessionCwdError({
				sessionCwd: importedCwd,
				fallbackCwd: this.cwd,
			});
		}

		const parentSession: SessionReference | undefined =
			header.parentSessionDirectory !== undefined &&
			header.parentStoreId !== undefined &&
			header.parentSessionId !== undefined &&
			header.parentSessionGeneration !== undefined
				? Object.freeze({
						sessionDirectory: header.parentSessionDirectory,
						storeId: header.parentStoreId,
						sessionId: header.parentSessionId,
						sessionGeneration: header.parentSessionGeneration,
					})
				: undefined;
		const newSessionOptions = {
			id: header.id,
			...(parentSession === undefined ? {} : { parentSession }),
			...(header.origin === undefined ? {} : { origin: header.origin }),
		};
		let sessionManager: SessionManager;
		if (this.session.sessionManager.isPersisted()) {
			sessionManager = await SessionManager.create(
				importedCwd,
				this.session.sessionManager.getSessionDir(),
				newSessionOptions,
			);
		} else {
			sessionManager = SessionManager.inMemory(importedCwd);
			sessionManager.newSession(newSessionOptions);
		}
		try {
			assertCurrent();

			const sourceById = new Map<string, SessionEntry>();
			let sourceLeafId: string | null = null;
			for (const entry of fileEntries) {
				if (entry.type === "session") continue;
				sourceById.set(entry.id, entry);
				if (entry.type === "leaf") sourceLeafId = entry.targetId;
				else sourceLeafId = entry.id;
			}

			const nearestPublicSourceId = (sourceId: string | null): string | null => {
				let currentId = sourceId;
				while (currentId) {
					const current = sourceById.get(currentId);
					if (!current) return null;
					if (!isHostOnlySessionEntry(current)) return current.id;
					currentId = current.parentId;
				}
				return null;
			};
			const importedIds = new Map<string, string>();
			const importedId = (sourceId: string | null): string | null => {
				const publicSourceId = nearestPublicSourceId(sourceId);
				return publicSourceId === null ? null : (importedIds.get(publicSourceId) ?? null);
			};
			const moveTo = (targetId: string | null): void => {
				if (sessionManager.getLeafId() === targetId) return;
				if (targetId === null) sessionManager.resetLeaf();
				else sessionManager.branch(targetId);
			};

			for (const entry of fileEntries) {
				if (entry.type === "session" || isHostOnlySessionEntry(entry)) continue;
				const parentId = importedId(entry.parentId);
				moveTo(parentId);
				let nextId: string;
				switch (entry.type) {
					case "message": {
						const message = entry.message;
						if (message.role === "branchSummary" || message.role === "compactionSummary") {
							throw new Error(`Cannot import non-canonical ${message.role} message entry`);
						}
						nextId = sessionManager.appendMessage(message);
						break;
					}
					case "thinking_level_change":
						nextId = sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
						break;
					case "fast_mode_change":
						nextId = sessionManager.appendFastModeChange(entry.enabled);
						break;
					case "model_change":
						nextId = sessionManager.appendModelChange(entry.provider, entry.modelId);
						break;
					case "planning_state_change":
						nextId = sessionManager.appendPlanningState(entry.planning);
						break;
					case "compaction": {
						const firstKeptEntryId = importedId(entry.firstKeptEntryId);
						if (!firstKeptEntryId) {
							throw new Error(`Compaction entry ${entry.id} references an unavailable retained entry`);
						}
						nextId = sessionManager.appendCompaction(
							entry.summary,
							firstKeptEntryId,
							entry.tokensBefore,
							entry.details,
							entry.fromHook,
						);
						break;
					}
					case "branch_summary":
						nextId = sessionManager.branchWithSummary(
							entry.fromId === "root" ? null : importedId(entry.fromId),
							entry.summary,
							entry.details,
							entry.fromHook,
						);
						break;
					case "custom":
						nextId = sessionManager.appendCustomEntry(entry.customType, entry.data);
						break;
					case "custom_message":
						nextId = sessionManager.appendCustomMessageEntry(
							entry.customType,
							entry.content,
							entry.display,
							entry.details,
						);
						break;
					case "label": {
						const targetId = importedId(entry.targetId);
						if (!targetId) throw new Error(`Label entry ${entry.id} references an unavailable target`);
						nextId = sessionManager.appendLabelChange(targetId, entry.label);
						break;
					}
					case "session_info":
						nextId = sessionManager.appendSessionInfo(entry.name ?? "");
						break;
					default:
						throw new Error(`Cannot import unsupported session entry type: ${entry.type}`);
				}
				importedIds.set(entry.id, nextId);
			}

			moveTo(importedId(sourceLeafId));
			await sessionManager.flush();
			assertCurrent();
			return sessionManager;
		} catch (error) {
			if (sessionManager.isPersisted()) {
				try {
					await sessionManager.closePersistence();
				} catch (closeError) {
					throw new AggregateError(
						[error, closeError],
						"Session import failed and its prepared manager could not be closed",
					);
				}
			}
			throw error;
		}
	}

	private async importFromJsonlWithinOperation(
		inputPath: string,
		cwdOverride: string | undefined,
		operation: AgentSessionStructuralOperation,
	): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const beforeResult = await this.emitBeforeSwitch("resume");
		this.assertStructuralOperationCurrent(operation);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		this.assertNoActiveDetachedReview();

		const previousSessionRef = this.session.sessionRef;
		await this.session.sessionManager.flush();
		this.assertStructuralOperationCurrent(operation);
		const sessionManager = await this.createImportedSessionManager(resolvedPath, cwdOverride, () =>
			this.assertStructuralOperationCurrent(operation),
		);
		try {
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.replaceCurrentSession({
				operation,
				reason: "resume",
				sessionManager,
				create: () =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						...this.getReplacementGitContextOptions(sessionManager.getCwd()),
						sessionStartEvent: { type: "session_start", reason: "resume", previousSessionRef },
						profile: this.getReplacementProfile(),
						subagentContext: this.subagentContext,
					}),
			});
			return { cancelled: false };
		} catch (error) {
			return await closePreparedSessionManager(
				sessionManager,
				error,
				"Session import failed and its prepared manager could not be closed",
			);
		}
	}

	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		// Close admission synchronously. Operations already in the actor retain
		// their FIFO position; disposal runs only after their ownership transaction
		// has either finalized or failed closed.
		this.acceptingStructuralOperations = false;
		const execute = async () => {
			// Detached reviews publish into the conversation feed; abort and join
			// them before the feed (and the rest of the runtime) is torn down.
			if (this._reviewWorkflows) {
				await this._reviewWorkflows.abortAll().catch(() => undefined);
			}
			const recoveredClientInputsTask = this.recoveredClientInputsTask;
			if (recoveredClientInputsTask && !recoveredClientInputsTask.settled) {
				recoveredClientInputsTask.cancellationRequested = true;
				await recoveredClientInputsTask.session.abort("disposal").catch(() => undefined);
				await recoveredClientInputsTask.promise.catch(() => undefined);
			}
			this.prepareSessionReplacement = undefined;
			this.sessionWillProjectListeners.clear();
			this.sessionReplacementListeners.clear();
			this.detachConversationTranscriptCommits();
			this.detachConversationTranscriptCommits = () => {};
			this.conversationProjectionFeed.dispose();
			if (this.sessionInvalidated) {
				return;
			}
			try {
				if (this.session.sessionManager.getConversationAuthorityStatus().status === "available") {
					await emitSessionShutdownEvent(this.session.extensionRunner, {
						type: "session_shutdown",
						reason: "quit",
					});
				}
				this.beforeSessionInvalidate?.();
			} finally {
				try {
					await this.session.disposeSubagentToolManager();
				} finally {
					this.session.dispose("disposal");
					await this.session.waitForClosed();
					this.sessionInvalidated = true;
					this.lifecycleRevision++;
				}
			}
		};
		this.disposePromise = this.runOrEnqueueLifecycleOperation(execute);
		return this.disposePromise;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /clear, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		profile?: string;
		subagentContext?: SubagentRuntimeContext;
		workspaceName?: string;
		baseRef?: string;
	},
): Promise<AgentSessionRuntime> {
	let result: CreateAgentSessionRuntimeResult;
	try {
		assertSessionCwdExists(options.sessionManager, options.cwd);
		result = await createRuntime(options);
	} catch (error) {
		try {
			await options.sessionManager.closePersistence();
		} catch (closeError) {
			throw new AggregateError(
				[error, closeError],
				"Agent session runtime creation failed and its manager could not be closed",
			);
		}
		throw error;
	}
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		options.subagentContext,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
