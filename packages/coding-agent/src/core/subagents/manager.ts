import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentAbortSource, AgentMessage, ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, Message, TextContent } from "@hansjm10/volt-ai";
import { createInProcessRpcClient, type InProcessRpcClient } from "../../modes/rpc/in-process-rpc-client.ts";
import type { RpcClientEvent } from "../../modes/rpc/rpc-client-base.ts";
import type { SessionStats } from "../agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	type SubagentRuntimeContext,
} from "../agent-session-runtime.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../rpc/types.ts";
import { SessionManager } from "../session-manager.ts";
import type {
	SubagentCapacityLimitSnapshot,
	SubagentSpawnCapacityConstraint,
	SubagentSpawnCapacityPhase,
	SubagentSpawnCapacityProposal,
	SubagentSpawnCapacitySnapshot,
} from "./capacity.ts";
import {
	type SubagentDelegationBatchReservation,
	type SubagentDelegationReservation,
	SubagentDelegationScope,
	type SubagentDelegationScopeLimits,
	type SubagentDelegationScopeOptions,
} from "./delegation-scope.ts";
import type { SubagentDefinition } from "./index.ts";
import {
	type SubagentFollowResult,
	SubagentRegistry,
	type SubagentRegistryRecord,
	type SubagentRegistrySnapshot,
	type SubagentRegistryStatus,
	type SubagentSpawnConfirmationPreflight,
} from "./registry.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "./tool-names.ts";
import { SubagentTurnBudget, type SubagentTurnLimits } from "./turn-budget.ts";

export type SubagentEvent = RpcClientEvent;
export type SubagentEndEvent = Extract<SubagentEvent, { type: "agent_end" }>;
export type SubagentEventListener = (event: SubagentEvent) => void;
export type SubagentActivityStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentActivityEvent {
	sequence: number;
	timestamp: number;
	event: SubagentEvent;
}

/** Retained view of a child run, including its live event flow and completed transcript. */
export interface SubagentActivity {
	id: string;
	sessionId: string;
	agent: {
		name: string;
		source: SubagentDefinition["source"] | undefined;
	};
	task?: string;
	status: SubagentActivityStatus;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	abortRequested: boolean;
	events: readonly SubagentActivityEvent[];
	droppedEvents: number;
	transcript: readonly AgentMessage[];
	sessionStats?: SessionStats;
	error?: string;
}

export type SubagentActivityListener = (activityId: string) => void;

export interface SubagentResult {
	id: string;
	sessionId: string;
	event: SubagentEndEvent;
}

export interface SubagentHandle {
	id: string;
	sessionId: string;
	/**
	 * Send a message to the child. A rejection before the start is published
	 * (prompt preflight or the host's runtime registration commit) rolls back
	 * the unpublished start (daemon hosts dispose the prepared child runtime)
	 * and disposes this handle, so it cannot be retried.
	 */
	prompt(message: string): Promise<void>;
	abort(source?: AgentAbortSource): Promise<void>;
	getState(): Promise<RpcSessionState>;
	getTranscript(options?: { limit?: number; beforeEntryId?: string }): Promise<RpcTranscriptResponse>;
	getSessionStats(): Promise<SessionStats>;
	waitForEnd(): Promise<SubagentResult>;
	dispose(): Promise<void>;
	onEvent(listener: SubagentEventListener): () => void;
}

export interface SubagentRuntimeCreatedEvent {
	id: string;
	sessionId: string;
	runtime: AgentSessionRuntime;
	definition?: SubagentDefinition;
	parentSessionId?: string;
	parentSessionFile?: string;
}

/** Host-owned registration prepared before prompting and committed only after prompt preflight succeeds. */
export interface SubagentRuntimeRegistration {
	commit(): void;
	rollback(): Promise<void>;
}

export interface SubagentManagerOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string;
	agentDir: string;
	workspaceName?: string;
	baseRef?: string;
	resourceLoader?: ResourceLoader;
	/** Parent session used to create durable child sessions when start options do not supply one. */
	parentSessionManager?: SessionManager;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
	/** Current subagent identity and delegation policy when this manager belongs to a child runtime. */
	subagentContext?: SubagentRuntimeContext;
	/**
	 * Tree-wide limit overrides for scopes this manager creates. Structural
	 * admission ceilings have finite defaults; aggregate token, cost, and
	 * deadline budgets abort only when this option supplies finite values.
	 */
	delegationLimits?: SubagentDelegationScopeLimits;
	/** Per-child turn safeguards; every parallel, chained, or nested runtime receives its own budget. */
	turnLimits?: SubagentTurnLimits;
	requestTimeoutMs?: number;
	/** Keep child runtimes alive after the hidden loopback client detaches. Another owner must retain/dispose them. */
	retainRuntimeOnDispose?: boolean;
	/** Called after a child runtime is ready so hosts can prepare it for live attachment. */
	onRuntimeCreated?: (
		event: SubagentRuntimeCreatedEvent,
	) => SubagentRuntimeRegistration | Promise<SubagentRuntimeRegistration> | Promise<void> | void;
}

export interface SubagentDelegationScopeLease {
	scope: SubagentDelegationScope;
	owned: boolean;
}

export interface SubagentSpawnPreflight extends SubagentSpawnConfirmationPreflight {
	capacity: SubagentSpawnCapacitySnapshot;
}

/** Opaque whole-batch admission consumed only by the manager that issued it. */
export interface SubagentSpawnBatchLease {
	readonly scope: SubagentDelegationScope;
	readonly capacity: SubagentSpawnCapacitySnapshot;
	release(): void;
}

export type SubagentSpawnAdmissionResult =
	| { status: "admitted"; capacity: SubagentSpawnCapacitySnapshot; lease: SubagentSpawnBatchLease }
	| { status: "invalid" }
	| { status: "capacity-rejected"; preflight: SubagentSpawnPreflight };

export interface SubagentStartOptions {
	cwd?: string;
	agentDir?: string;
	sessionManager?: SessionManager;
	requestTimeoutMs?: number;
	/** Shared root admission and accounting scope for all descendants created by one delegation tool call. */
	delegationScope?: SubagentDelegationScope;
	/** Whole-batch admission issued by this manager for a confirmed spawn request. */
	spawnBatchLease?: SubagentSpawnBatchLease;
	/**
	 * Attribution for the durable spawn edge recorded in the parent transcript at
	 * the publish commit point (issue #129). Omitted for programmatic starts,
	 * which record no edge and are invisible to registry hydration.
	 */
	spawnRecord?: SubagentSpawnRecordContext;
	/**
	 * §5 resume: reuse this id instead of minting a fresh one, so the resumed
	 * run re-occupies its claimed registry record. Set only by resumeDelegation.
	 */
	resumeSubagentId?: string;
	/**
	 * §5 resume: the interrupted run's original task, restored on the
	 * re-registered record instead of the continuation prompt.
	 */
	resumeTaskLabel?: string;
}

/** Tool-call attribution for one durable spawn edge. */
export interface SubagentSpawnRecordContext {
	toolCallId: string;
	/** createSubagentSpawnRequestKey hash of the originating spawn request. */
	requestKey: string;
}

export interface SubagentStartByNameOptions extends SubagentStartOptions {
	resourceLoader?: ResourceLoader;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
}

export class SubagentDefinitionNotFoundError extends Error {
	readonly agentName: string;
	readonly availableNames: string[];
	readonly diagnostics: ResourceDiagnostic[];

	constructor(agentName: string, availableNames: string[], diagnostics: ResourceDiagnostic[] = []) {
		super(
			agentName.trim() ? `Subagent definition "${agentName}" was not found` : "Subagent definition name is required",
		);
		this.name = "SubagentDefinitionNotFoundError";
		this.agentName = agentName;
		this.availableNames = availableNames;
		this.diagnostics = diagnostics;
	}
}

export class SubagentDefinitionConfigurationError extends Error {
	readonly agentName: string;
	readonly field: "model" | "thinking";

	constructor(agentName: string, field: "model" | "thinking", message: string) {
		super(`Invalid subagent definition "${agentName}" ${field}: ${message}`);
		this.name = "SubagentDefinitionConfigurationError";
		this.agentName = agentName;
		this.field = field;
	}
}

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_RETAINED_ACTIVITIES = 50;
const MAX_RETAINED_ACTIVITY_EVENTS = 2_000;
const DELEGATION_SNAPSHOT_MAX_RECORDS = 25;

interface SubagentCallerBatchReservation {
	reserve(): () => void;
	release(): void;
}

interface SubagentBatchAdmissionState {
	caller: SubagentCallerBatchReservation;
	tree: SubagentDelegationBatchReservation;
}

interface MutableSubagentActivity {
	id: string;
	sessionId: string;
	agent: SubagentActivity["agent"];
	task: string | undefined;
	status: SubagentActivityStatus;
	startedAt: number;
	updatedAt: number;
	finishedAt: number | undefined;
	abortRequested: boolean;
	events: SubagentActivityEvent[];
	droppedEvents: number;
	transcript: AgentMessage[];
	sessionStats: SessionStats | undefined;
	error: string | undefined;
	runtime: AgentSessionRuntime | undefined;
	nextSequence: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function capacityLimitSnapshot(
	maximum: number | undefined,
	used: number,
	reserved: number,
): SubagentCapacityLimitSnapshot {
	return {
		maximum: maximum === undefined || !Number.isFinite(maximum) ? null : maximum,
		used,
		reserved,
		remaining: maximum === undefined || !Number.isFinite(maximum) ? null : Math.max(0, maximum - used - reserved),
	};
}

function validateCapacityProposal(proposal: SubagentSpawnCapacityProposal): void {
	if (!Number.isSafeInteger(proposal.requestedStarts) || proposal.requestedStarts <= 0) {
		throw new Error("Subagent capacity requestedStarts must be a positive safe integer");
	}
	if (!Number.isSafeInteger(proposal.peakConcurrentStarts) || proposal.peakConcurrentStarts <= 0) {
		throw new Error("Subagent capacity peakConcurrentStarts must be a positive safe integer");
	}
	if (proposal.peakConcurrentStarts > proposal.requestedStarts) {
		throw new Error("Subagent capacity peakConcurrentStarts cannot exceed requestedStarts");
	}
}

/** Start-time system prompt context containing only registry-controlled run metadata. */
function formatDelegationSnapshot(snapshot: SubagentRegistrySnapshot): string | undefined {
	if (snapshot.records.length === 0) {
		return undefined;
	}
	const lines = snapshot.records.map((record) => {
		const followability =
			record.followability === "current"
				? "current run; not followable"
				: record.followability === "ancestor"
					? "ancestor; not followable"
					: record.followability === "dependency-cycle"
						? "dependency cycle; not followable"
						: "followable";
		return `- ${record.id} ${record.status} [${followability}]`;
	});
	const omitted = snapshot.total - snapshot.records.length;
	return [
		"Delegated subagent runs already recorded in this session (snapshot at your start):",
		...lines,
		...(omitted > 0 ? [`…and ${omitted} more.`] : []),
		`Call the ${SUBAGENT_REGISTRY_TOOL_NAME} tool with { "list": true } for the current state and untrusted task prompts. Only use { "follow": "<id>" } for runs marked [followable]; continue independently for current, ancestor, or dependency-cycle runs.`,
	].join("\n");
}

function getFinalAssistantText(event: SubagentEndEvent): string | undefined {
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index];
		if (!message || message.role !== "assistant") {
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			return undefined;
		}
		const text = content
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text.length > 0 ? text : undefined;
	}
	return undefined;
}

function getTerminalActivityResult(
	event: SubagentEndEvent,
	abortRequested: boolean,
): {
	status: Extract<SubagentActivityStatus, "completed" | "failed" | "aborted">;
	error?: string;
} {
	if (abortRequested) {
		return { status: "aborted" };
	}
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index];
		if (!message || message.role !== "assistant") {
			continue;
		}
		const assistant = message as { stopReason?: unknown; errorMessage?: unknown };
		if (assistant.stopReason === "aborted") {
			return { status: "aborted" };
		}
		if (assistant.stopReason === "error") {
			return {
				status: "failed",
				...(typeof assistant.errorMessage === "string" ? { error: assistant.errorMessage } : {}),
			};
		}
		return { status: "completed" };
	}
	return { status: "completed" };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function normalizeUniqueNames(names: readonly string[] | undefined): string[] | undefined {
	if (!names) {
		return undefined;
	}
	return Array.from(new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)));
}

function resolveEffectiveTools(options: {
	requestedTools: string[] | undefined;
	excludedTools: string[] | undefined;
	allowedTools: string[] | undefined;
	defaultTools: string[];
}): string[] | undefined {
	const normalizedRequested = normalizeUniqueNames(options.requestedTools);
	const normalizedAllowed = normalizeUniqueNames(options.allowedTools);
	const normalizedExcluded = normalizeUniqueNames(options.excludedTools);
	let effectiveTools: string[] | undefined;

	if (normalizedRequested && normalizedAllowed) {
		const allowed = new Set(normalizedAllowed);
		effectiveTools = normalizedRequested.filter((toolName) => allowed.has(toolName));
	} else if (normalizedRequested) {
		effectiveTools = normalizedRequested;
	} else if (normalizedAllowed) {
		effectiveTools = normalizedAllowed;
	} else if (normalizedExcluded) {
		effectiveTools = normalizeUniqueNames(options.defaultTools);
	}

	if (!effectiveTools || !normalizedExcluded) {
		return effectiveTools;
	}

	const excluded = new Set(normalizedExcluded);
	return effectiveTools.filter((toolName) => !excluded.has(toolName));
}

const RESUME_ID_PREVIEW_CHARS = 120;
const SUBAGENT_RESUME_PROMPT =
	"You were interrupted before completing your task. Review the conversation so far, finish the original task, and reply with your complete final report.";

function messageText(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * ToolCall ids of this transcript's settled subagent results. A synthesized
 * abort marker (agent-loop abort or dispose-time persistence, both prefixed
 * "Operation aborted") is not settlement: its children remain recoverable
 * (design §§2, 4 of docs/design/subagent-durable-spawn-graph.md).
 */
function collectSettledToolCallIds(sessionManager: SessionManager): Set<string> {
	const settled = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") {
			continue;
		}
		const message = entry.message;
		if (message.isError && messageText(message.content).startsWith("Operation aborted")) {
			continue;
		}
		settled.add(message.toolCallId);
	}
	return settled;
}

/** ToolCall ids present anywhere in the transcript; an edge without one is stranded (design §3). */
function collectToolCallIds(sessionManager: SessionManager): Set<string> {
	const ids = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		for (const block of entry.message.content) {
			if (block.type === "toolCall") {
				ids.add(block.id);
			}
		}
	}
	return ids;
}

interface HydratedChildState {
	status: Exclude<SubagentRegistryStatus, "running">;
	task?: string;
	output?: string;
	error?: string;
	finishedAt: number;
}

/** Terminal state of a child run derived from its persisted transcript alone. */
function deriveHydratedChildState(child: SessionManager, fallbackTime: number): HydratedChildState {
	// The task comes from the raw entry stream, not the built context: a child
	// that auto-compacted mid-run replaces its early messages with a summary,
	// and the summary must not masquerade as the original task.
	let task: string | undefined;
	for (const entry of child.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			task = messageText(entry.message.content) || undefined;
			break;
		}
	}
	const messages = child.buildSessionContext().messages;
	const last = messages.at(-1);
	const finishedAt = typeof last?.timestamp === "number" ? last.timestamp : fallbackTime;
	if (last?.role === "assistant") {
		const assistant = last as AssistantMessage;
		if (assistant.stopReason === "error") {
			return {
				status: "failed",
				...(task !== undefined ? { task } : {}),
				error: assistant.errorMessage || "The run failed before producing a result.",
				finishedAt,
			};
		}
		if (assistant.stopReason === "stop" || assistant.stopReason === "length") {
			const output = messageText(assistant.content);
			return {
				status: "completed",
				...(task !== undefined ? { task } : {}),
				...(output ? { output } : {}),
				finishedAt,
			};
		}
	}
	return {
		status: "aborted",
		...(task !== undefined ? { task } : {}),
		error: "Interrupted before completion: the runtime closed mid-turn.",
		finishedAt,
	};
}

class LocalSubagentHandle implements SubagentHandle {
	readonly id: string;
	readonly sessionId: string;
	private readonly client: InProcessRpcClient;
	private readonly abortRuntime: (source?: AgentAbortSource) => Promise<void>;
	private readonly removeFromManager: (id: string) => void;
	private readonly onPromptAccepted: (message: string) => void;
	private readonly onPromptFailed: (error: unknown) => Promise<void>;
	private readonly onAbortRequested: () => void;
	private readonly onTerminal: () => void;
	private readonly onDispose: () => Promise<void>;
	private waitForIdle: (() => Promise<void>) | undefined;
	private readonly eventListeners = new Set<SubagentEventListener>();
	private readonly endPromise: Promise<SubagentResult>;
	private resolveEnd: (result: SubagentResult) => void = () => {};
	private rejectEnd: (error: Error) => void = () => {};
	private latestEndEvent: SubagentEndEvent | undefined;
	private settlementWatcherStarted = false;
	private promptStarted = false;
	private promptAccepted = false;
	private promptMessageObserved = false;
	private endSettled = false;
	private ownershipSettled = false;
	private abortRequested = false;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: {
		id: string;
		sessionId: string;
		client: InProcessRpcClient;
		abortRuntime: (source?: AgentAbortSource) => Promise<void>;
		removeFromManager: (id: string) => void;
		onPromptAccepted: (message: string) => void;
		onPromptFailed: (error: unknown) => Promise<void>;
		onAbortRequested: () => void;
		onTerminal: () => void;
		onDispose: () => Promise<void>;
		waitForIdle: () => Promise<void>;
	}) {
		this.id = options.id;
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.abortRuntime = options.abortRuntime;
		this.removeFromManager = options.removeFromManager;
		this.onPromptAccepted = options.onPromptAccepted;
		this.onPromptFailed = options.onPromptFailed;
		this.onAbortRequested = options.onAbortRequested;
		this.onTerminal = options.onTerminal;
		this.onDispose = options.onDispose;
		this.waitForIdle = options.waitForIdle;
		this.endPromise = new Promise<SubagentResult>((resolve, reject) => {
			this.resolveEnd = resolve;
			this.rejectEnd = reject;
		});
		void this.endPromise.catch(() => {});
	}

	async prompt(message: string): Promise<void> {
		this.assertOpen();
		this.promptStarted = true;
		try {
			await this.client.prompt(message, undefined, () => {
				// Publish before marking acceptance: publishing can itself fail
				// (daemon hosts re-check preconditions when committing the runtime
				// registration), and a publish failure must take the unpublished
				// rollback path below, which disposes this handle.
				this.onPromptAccepted(message);
				this.promptAccepted = true;
			});
		} catch (error) {
			await this.onPromptFailed(error).catch(() => undefined);
			this.settleOwnership();
			if (!this.promptAccepted) {
				// An unpublished prompt failure rolled the start back; daemon hosts
				// dispose the prepared child runtime, so the handle cannot be
				// retried. Dispose it so later calls fail with a clear
				// disposed-handle error instead of generic disposed-session errors.
				await this.dispose().catch(() => undefined);
			}
			throw error;
		}
	}

	async abort(source?: AgentAbortSource): Promise<void> {
		this.assertOpen();
		this.abortRequested = true;
		this.onAbortRequested();
		// Abort the in-process runtime directly so cancellation is signalled before
		// concurrent disposal can close the loopback transport.
		await this.abortRuntime(source);
	}

	async getState(): Promise<RpcSessionState> {
		this.assertOpen();
		return this.client.getState();
	}

	async getTranscript(options: { limit?: number; beforeEntryId?: string } = {}): Promise<RpcTranscriptResponse> {
		this.assertOpen();
		return this.client.getTranscript(options);
	}

	async getSessionStats(): Promise<SessionStats> {
		this.assertOpen();
		return this.client.getSessionStats();
	}

	waitForEnd(): Promise<SubagentResult> {
		return this.endPromise;
	}

	onEvent(listener: SubagentEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		this.disposed = true;
		this.waitForIdle = undefined;
		const abortInFlightRun = !this.endSettled && !this.abortRequested;
		if (abortInFlightRun) {
			// Disposing a still-running child must not orphan its turn: when the
			// runtime is retained (daemon hosts keep child runtimes attachable),
			// client.stop() only closes the loopback transport and the child would
			// keep running on a result nobody can receive. Abort the runtime
			// directly — the public abort() asserts the handle is still open — and
			// do it fire-and-forget so a slow-to-cancel child cannot wedge
			// disposal (and with it a lease handoff). Skipped when an abort was
			// already requested through the handle so the runtime is signalled
			// exactly once. Mark the abort request before rejecting the end
			// promise so the manager's terminal handler records "aborted" rather
			// than "failed".
			this.onAbortRequested();
			void this.abortRuntime().catch(() => undefined);
		}
		this.settleOwnership();
		if (!this.endSettled) {
			this.endSettled = true;
			this.rejectEnd(new Error(`Subagent ${this.id} was disposed before completion`));
		}
		this.disposePromise = Promise.resolve().then(async () => {
			try {
				await this.client.stop();
			} finally {
				try {
					await this.onDispose();
				} finally {
					this.eventListeners.clear();
					this.removeFromManager(this.id);
				}
			}
		});
		return this.disposePromise;
	}

	handleEvent(event: SubagentEvent): void {
		if (this.disposed) {
			return;
		}
		if (
			event.type === "message_start" &&
			(event.message.role === "user" || event.message.role === "custom") &&
			this.promptStarted
		) {
			this.promptMessageObserved = true;
		}
		if (event.type === "agent_end" && this.promptMessageObserved) {
			this.latestEndEvent = event;
		}
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Listener failures should not break the child RPC event stream.
			}
		}
		const shouldWatchSettlement =
			(event.type === "agent_end" && this.promptMessageObserved) ||
			(event.type === "agent_settled" && this.promptAccepted);
		if (shouldWatchSettlement && !this.settlementWatcherStarted && !this.disposed && !this.endSettled) {
			this.settlementWatcherStarted = true;
			void this.settleAfterIdle();
		}
	}

	private async settleAfterIdle(): Promise<void> {
		const waitForIdle = this.waitForIdle;
		this.waitForIdle = undefined;
		if (!waitForIdle) {
			return;
		}
		try {
			await waitForIdle();
		} catch (error) {
			if (!this.disposed && !this.endSettled) {
				this.endSettled = true;
				this.settleOwnership();
				this.rejectEnd(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}

		if (this.disposed || this.endSettled) {
			return;
		}
		const latestEndEvent = this.latestEndEvent;
		if (!this.promptMessageObserved || !latestEndEvent) {
			this.endSettled = true;
			this.settleOwnership();
			this.rejectEnd(new Error(`Subagent ${this.id} settled without an agent result`));
			return;
		}
		this.endSettled = true;
		this.settleOwnership();
		const event = latestEndEvent.willRetry ? { ...latestEndEvent, willRetry: false } : latestEndEvent;
		this.resolveEnd({ id: this.id, sessionId: this.sessionId, event });
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error(`Subagent ${this.id} is disposed`);
		}
	}

	private settleOwnership(): void {
		if (this.ownershipSettled) return;
		this.ownershipSettled = true;
		this.onTerminal();
	}
}

export class SubagentManager {
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly workspaceName?: string;
	private readonly baseRef?: string;
	private readonly resourceLoader?: ResourceLoader;
	private readonly parentSessionManager?: SessionManager;
	private hydrationPromise: Promise<void> | undefined;
	private readonly allowedTools?: string[];
	private readonly subagentContext?: SubagentRuntimeContext;
	private readonly delegationLimits?: SubagentDelegationScopeLimits;
	private readonly turnLimits?: SubagentTurnLimits;
	private readonly requestTimeoutMs?: number;
	private readonly retainRuntimeOnDispose: boolean;
	private readonly onRuntimeCreated?: (
		event: SubagentRuntimeCreatedEvent,
	) => SubagentRuntimeRegistration | Promise<SubagentRuntimeRegistration> | Promise<void> | void;
	private readonly handles = new Map<string, LocalSubagentHandle>();
	private readonly activities = new Map<string, MutableSubagentActivity>();
	private readonly activityListeners = new Set<SubagentActivityListener>();
	private childStartCount = 0;
	private reservedChildStartCount = 0;
	private readonly batchAdmissions = new WeakMap<SubagentSpawnBatchLease, SubagentBatchAdmissionState>();
	private disposePromise: Promise<void> | undefined;
	private pendingStartCount = 0;
	private readonly pendingStartWaiters = new Set<() => void>();
	/** Lazily created when this manager belongs to the root session; children share it via context. */
	private ownedRegistry: SubagentRegistry | undefined;

	constructor(options: SubagentManagerOptions) {
		this.createRuntime = options.createRuntime;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.workspaceName = options.workspaceName;
		this.baseRef = options.baseRef;
		this.resourceLoader = options.resourceLoader;
		this.parentSessionManager = options.parentSessionManager;
		this.allowedTools = normalizeUniqueNames(options.allowedTools);
		this.subagentContext = options.subagentContext;
		this.delegationLimits = options.delegationLimits;
		this.turnLimits = options.turnLimits;
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.retainRuntimeOnDispose = options.retainRuntimeOnDispose ?? false;
		this.onRuntimeCreated = options.onRuntimeCreated;
	}

	isSubagentRuntime(): boolean {
		return this.subagentContext !== undefined;
	}

	createDelegationScope(options: SubagentDelegationScopeOptions = {}): SubagentDelegationScopeLease {
		this.assertNotDisposed();
		const inherited = this.subagentContext?.delegationScope;
		if (inherited) {
			return { scope: inherited, owned: false };
		}
		return {
			scope: new SubagentDelegationScope({
				limits: this.delegationLimits,
				turnLimits: this.turnLimits,
				...options,
			}),
			owned: true,
		};
	}

	/** All delegated runs recorded in this runtime tree's session-wide registry. */
	listDelegations(): SubagentRegistryRecord[] {
		return this.getRegistry().list();
	}

	/** Delegated runs annotated with follow safety relative to this runtime. */
	listDelegationsForCaller(): SubagentRegistryRecord[] {
		return this.getRegistry().listForFollower(this.subagentContext?.subagentId);
	}

	prepareSpawnConfirmation(
		requestKey: string,
		proposal: SubagentSpawnCapacityProposal,
		options?: { reissuePending?: boolean },
	): SubagentSpawnPreflight {
		validateCapacityProposal(proposal);
		const scopeLease = this.createDelegationScope();
		const capacity = this.createSpawnCapacitySnapshot(proposal, "advisory", scopeLease.scope);
		if (scopeLease.owned) {
			scopeLease.scope.dispose();
		}
		const registry = this.getRegistry();
		if (!capacity.fits) {
			registry.cancelPendingSpawnConfirmation(requestKey);
			return {
				...registry.inspectSpawnConfirmation(requestKey, this.subagentContext?.subagentId),
				capacity,
			};
		}
		return {
			...registry.prepareSpawnConfirmation(requestKey, this.subagentContext?.subagentId, undefined, options),
			capacity,
		};
	}

	claimSpawnConfirmation(
		requestKey: string,
		token: string,
		proposal: SubagentSpawnCapacityProposal,
		options: { signal?: AbortSignal } = {},
	): SubagentSpawnAdmissionResult {
		validateCapacityProposal(proposal);
		const registry = this.getRegistry();
		const confirmation = registry.claimSpawnConfirmation(requestKey, token);
		if (!confirmation) {
			return { status: "invalid" };
		}

		const scopeLease = this.createDelegationScope(options);
		const advisory = this.createSpawnCapacitySnapshot(proposal, "advisory", scopeLease.scope);
		if (!advisory.fits) {
			confirmation.release();
			if (scopeLease.owned) {
				scopeLease.scope.dispose();
			}
			return {
				status: "capacity-rejected",
				preflight: {
					...registry.inspectSpawnConfirmation(requestKey, this.subagentContext?.subagentId),
					capacity: { ...advisory, phase: "admission-rejected" },
				},
			};
		}

		const caller = this.reserveCallerBatch(proposal.requestedStarts);
		let tree: SubagentDelegationBatchReservation;
		try {
			tree = scopeLease.scope.reserveBatch({
				requestedStarts: proposal.requestedStarts,
				peakActiveDescendants: proposal.peakConcurrentStarts,
				depth: (this.subagentContext?.depth ?? 0) + 1,
			});
		} catch (error) {
			caller.release();
			confirmation.release();
			if (scopeLease.owned) {
				scopeLease.scope.dispose();
			}
			throw error;
		}

		const capacity = this.createSpawnCapacitySnapshot(proposal, "admitted", scopeLease.scope, true);
		let released = false;
		let lease: SubagentSpawnBatchLease;
		lease = {
			scope: scopeLease.scope,
			capacity,
			release: () => {
				if (released) return;
				released = true;
				this.batchAdmissions.delete(lease);
				tree.release();
				caller.release();
				confirmation.release();
				if (scopeLease.owned) {
					scopeLease.scope.dispose();
				}
			},
		};
		this.batchAdmissions.set(lease, { caller, tree });
		return { status: "admitted", capacity, lease };
	}

	/** Result of an existing run in the tree, waiting for completion when still running. */
	followDelegation(subagentId: string, options: { signal?: AbortSignal } = {}): Promise<SubagentFollowResult> {
		return this.getRegistry().follow(this.subagentContext?.subagentId, subagentId, options.signal);
	}

	/**
	 * §5 resume: reload an interrupted recovered run from its child transcript
	 * and prompt it to finish its original task. The run re-registers under
	 * its original id through the live pipeline, so settlement, list, and
	 * follow behave as for any run started by this process. Depth, policy,
	 * and delegation-scope checks apply as for a new start; a start failure
	 * restores the interrupted record.
	 */
	async resumeDelegation(
		subagentId: string,
		options: { signal?: AbortSignal; allowedTools?: string[] } = {},
	): Promise<SubagentFollowResult> {
		await this.ensureRegistryHydrated();
		const claim = this.getRegistry().claimResume(subagentId);
		if (!claim) {
			const preview =
				subagentId.length <= RESUME_ID_PREVIEW_CHARS
					? subagentId
					: `${subagentId.slice(0, RESUME_ID_PREVIEW_CHARS - 1)}…`;
			throw new Error(
				`Subagent run "${preview}" is not a resumable interrupted recovery. Use { follow: "<id>" } for completed runs or { list: true } to inspect the registry.`,
			);
		}
		let handle: SubagentHandle;
		try {
			if (!existsSync(claim.childSessionFile)) {
				throw new Error("The interrupted run's transcript no longer exists; it cannot be resumed.");
			}
			handle = await this.startByName(claim.agentName, {
				sessionManager: SessionManager.open(claim.childSessionFile),
				resumeSubagentId: subagentId,
				...(claim.task !== undefined ? { resumeTaskLabel: claim.task } : {}),
				...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
			});
		} catch (error) {
			claim.rollback();
			throw error;
		}
		const onAbort = () => {
			void handle.abort().catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// An abort that landed while the runtime was being prepared no-ops
			// against the idle session; honor it before spending a turn.
			if (options.signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const completion = handle.waitForEnd();
			await handle.prompt(SUBAGENT_RESUME_PROMPT);
			await completion;
		} catch (error) {
			// A published run settles through the live pipeline and is reported
			// below. An unpublished failure (prompt rejected before acceptance,
			// pre-prompt abort) never re-registered the id: restore the record
			// and surface the real cause instead of an unknown-id follow error.
			if (this.getRegistry().get(subagentId) === undefined) {
				claim.rollback();
				throw error;
			}
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			await handle.dispose().catch(() => undefined);
		}
		return this.followDelegation(subagentId, options);
	}

	private getRegistry(): SubagentRegistry {
		if (this.subagentContext) {
			return this.subagentContext.registry;
		}
		this.ownedRegistry ??= new SubagentRegistry();
		return this.ownedRegistry;
	}

	async start(options: SubagentStartOptions = {}): Promise<SubagentHandle> {
		const finishStart = this.beginStart();
		let releaseReservation = (): void => undefined;
		let scopeLease: SubagentDelegationScopeLease | undefined;
		let treeReservation: SubagentDelegationReservation | undefined;
		try {
			releaseReservation = this.reserveChildStart(undefined);
			scopeLease = this.resolveDelegationScope(options.delegationScope);
			treeReservation = scopeLease.scope.reserve("subagent", (this.subagentContext?.depth ?? 0) + 1);
			return await this.startRuntime(options, undefined, {
				scopeLease,
				reservation: treeReservation,
			});
		} catch (error) {
			releaseReservation();
			treeReservation?.rollback();
			if (scopeLease?.owned) scopeLease.scope.dispose();
			throw error;
		} finally {
			finishStart();
		}
	}

	listDefinitions(options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition[] {
		const resourceLoader = options.resourceLoader ?? this.resourceLoader;
		return resourceLoader?.getSubagents().definitions ?? [];
	}

	/**
	 * Definitions permitted by this runtime's delegation policy (`allowedSubagents`),
	 * ignoring exhaustible depth and child-start budgets. Callers use this to distinguish
	 * never-permitted names from exhausted budgets, which report precise errors on start.
	 */
	listPermittedDefinitions(options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition[] {
		const definitions = this.listDefinitions(options);
		const allowedSubagents = normalizeUniqueNames(this.subagentContext?.allowedSubagents);
		if (!allowedSubagents) {
			return definitions;
		}
		const allowedNames = new Set(allowedSubagents);
		return definitions.filter((definition) => allowedNames.has(definition.name));
	}

	/** Definitions this runtime may delegate to right now, including depth and child-start budgets. */
	listAvailableDefinitions(options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition[] {
		const context = this.subagentContext;
		if (
			context &&
			((context.maxSubagentDepth !== undefined && context.depth >= context.maxSubagentDepth) ||
				(context.maxChildAgents !== undefined &&
					this.childStartCount + this.reservedChildStartCount >= context.maxChildAgents))
		) {
			return [];
		}
		return this.listPermittedDefinitions(options);
	}

	/** List active and recently completed child runs, newest and active first. */
	listActivities(): SubagentActivity[] {
		return Array.from(this.activities.values())
			.sort((left, right) => {
				if (left.status === "running" && right.status !== "running") return -1;
				if (left.status !== "running" && right.status === "running") return 1;
				return right.startedAt - left.startedAt;
			})
			.map((activity) => this.snapshotActivity(activity));
	}

	/** Subscribe to live child activity changes. Snapshots remain available after handle disposal. */
	subscribeActivities(listener: SubagentActivityListener): () => void {
		this.activityListeners.add(listener);
		return () => {
			this.activityListeners.delete(listener);
		};
	}

	getDefinition(agentName: string, options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition {
		return this.resolveDefinition(agentName, options.resourceLoader);
	}

	async startByName(agentName: string, options: SubagentStartByNameOptions = {}): Promise<SubagentHandle> {
		const finishStart = this.beginStart();
		let releaseReservation = (): void => undefined;
		let scopeLease: SubagentDelegationScopeLease | undefined;
		let treeReservation: SubagentDelegationReservation | undefined;
		try {
			const definition = this.getDefinition(agentName, { resourceLoader: options.resourceLoader });
			if (options.spawnBatchLease) {
				const admission = this.batchAdmissions.get(options.spawnBatchLease);
				if (!admission) {
					throw new Error("Cannot start subagent: the spawn batch admission is invalid or released.");
				}
				releaseReservation = admission.caller.reserve();
				scopeLease = { scope: options.spawnBatchLease.scope, owned: false };
				treeReservation = admission.tree.reserve(definition.name);
			} else {
				releaseReservation = this.reserveChildStart(definition.name);
				scopeLease = this.resolveDelegationScope(options.delegationScope);
				treeReservation = scopeLease.scope.reserve(definition.name, (this.subagentContext?.depth ?? 0) + 1);
			}
			return await this.startRuntime(
				options,
				{
					definition,
					allowedTools: options.allowedTools ?? this.allowedTools,
				},
				{
					scopeLease,
					reservation: treeReservation,
				},
			);
		} catch (error) {
			releaseReservation();
			treeReservation?.rollback();
			if (scopeLease?.owned) scopeLease.scope.dispose();
			throw error;
		} finally {
			finishStart();
		}
	}

	async dispose(): Promise<void> {
		if (!this.disposePromise) {
			this.disposePromise = (async () => {
				await this.waitForPendingStarts();
				const handles = Array.from(this.handles.values());
				try {
					await Promise.allSettled(handles.map((handle) => handle.dispose()));
				} finally {
					this.activityListeners.clear();
				}
			})();
		}
		await this.disposePromise;
	}

	private createSpawnCapacitySnapshot(
		proposal: SubagentSpawnCapacityProposal,
		phase: SubagentSpawnCapacityPhase,
		scope: SubagentDelegationScope,
		admitted = false,
	): SubagentSpawnCapacitySnapshot {
		const context = this.subagentContext;
		const callerDepth = context?.depth ?? 0;
		const callerDepthReserved = this.reservedChildStartCount > 0 ? 1 : 0;
		const caller = {
			maxChildAgents: capacityLimitSnapshot(
				context?.maxChildAgents,
				this.childStartCount,
				this.reservedChildStartCount,
			),
			depth: capacityLimitSnapshot(context?.maxSubagentDepth, callerDepth, callerDepthReserved),
		};
		const tree = scope.capacitySnapshot();
		const constraints: SubagentSpawnCapacityConstraint[] = [];
		if (tree.disposed) constraints.push("delegation-scope-disposed");
		if (tree.aborted) constraints.push("delegation-scope-aborted");
		if (caller.maxChildAgents.remaining !== null && caller.maxChildAgents.remaining < proposal.requestedStarts) {
			constraints.push("caller-max-child-agents");
		}
		if (caller.depth.maximum !== null && callerDepth + 1 > caller.depth.maximum) {
			constraints.push("caller-max-subagent-depth");
		}
		if (tree.maxStarts.remaining !== null && tree.maxStarts.remaining < proposal.requestedStarts) {
			constraints.push("tree-max-starts");
		}
		if (
			tree.maxActiveDescendants.remaining !== null &&
			tree.maxActiveDescendants.remaining < proposal.peakConcurrentStarts
		) {
			constraints.push("tree-max-active-descendants");
		}
		if (tree.maxDepth.maximum !== null && callerDepth + 1 > tree.maxDepth.maximum) {
			constraints.push("tree-max-depth");
		}
		return {
			phase,
			proposal: { ...proposal },
			caller,
			tree,
			fits: admitted || constraints.length === 0,
			constraints: admitted ? [] : constraints,
		};
	}

	private reserveCallerBatch(requestedStarts: number): SubagentCallerBatchReservation {
		const context = this.subagentContext;
		if (
			context?.maxChildAgents !== undefined &&
			this.childStartCount + this.reservedChildStartCount + requestedStarts > context.maxChildAgents
		) {
			throw new Error(
				`Subagent "${context.agentName}" cannot reserve ${requestedStarts} child starts within maxChildAgents ${context.maxChildAgents}.`,
			);
		}
		if (context?.maxSubagentDepth !== undefined && context.depth >= context.maxSubagentDepth) {
			throw new Error(
				`Subagent "${context.agentName}" cannot reserve child starts at maxSubagentDepth ${context.maxSubagentDepth}.`,
			);
		}

		let remainingStarts = requestedStarts;
		let released = false;
		this.reservedChildStartCount += remainingStarts;
		return {
			reserve: () => {
				if (released || remainingStarts <= 0) {
					throw new Error("Cannot start subagent: the admitted caller reservation has no remaining permits.");
				}
				remainingStarts -= 1;
				this.reservedChildStartCount = Math.max(0, this.reservedChildStartCount - 1);
				this.childStartCount += 1;
				let rolledBack = false;
				return () => {
					if (rolledBack) return;
					rolledBack = true;
					this.childStartCount = Math.max(0, this.childStartCount - 1);
					if (!released) {
						remainingStarts += 1;
						this.reservedChildStartCount += 1;
					}
				};
			},
			release: () => {
				if (released) return;
				released = true;
				this.reservedChildStartCount = Math.max(0, this.reservedChildStartCount - remainingStarts);
				remainingStarts = 0;
			},
		};
	}

	private reserveChildStart(agentName: string | undefined): () => void {
		const context = this.subagentContext;
		if (context) {
			if (!agentName) {
				throw new Error(`Subagent "${context.agentName}" cannot start unnamed child subagents.`);
			}

			if (context.maxSubagentDepth !== undefined && context.depth >= context.maxSubagentDepth) {
				throw new Error(
					`Subagent "${context.agentName}" cannot delegate to "${agentName}": maxSubagentDepth ${context.maxSubagentDepth} reached at depth ${context.depth}.`,
				);
			}

			const allowedSubagents = normalizeUniqueNames(context.allowedSubagents);
			if (allowedSubagents && allowedSubagents.length === 0) {
				throw new Error(
					`Subagent "${context.agentName}" cannot delegate to "${agentName}": no child subagents are allowed.`,
				);
			}
			if (allowedSubagents && !allowedSubagents.includes(agentName)) {
				throw new Error(
					`Subagent "${context.agentName}" cannot delegate to "${agentName}". Allowed subagents: ${allowedSubagents.join(", ")}.`,
				);
			}

			if (
				context.maxChildAgents !== undefined &&
				this.childStartCount + this.reservedChildStartCount >= context.maxChildAgents
			) {
				throw new Error(
					`Subagent "${context.agentName}" cannot start more than ${context.maxChildAgents} child subagent${context.maxChildAgents === 1 ? "" : "s"}.`,
				);
			}
		}

		this.childStartCount += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.childStartCount = Math.max(0, this.childStartCount - 1);
		};
	}

	private assertNotDisposed(): void {
		if (this.disposePromise) throw new Error("Subagent manager is disposed");
	}

	private beginStart(): () => void {
		this.assertNotDisposed();
		this.pendingStartCount += 1;
		let finished = false;
		return () => {
			if (finished) return;
			finished = true;
			this.pendingStartCount = Math.max(0, this.pendingStartCount - 1);
			if (this.pendingStartCount === 0) {
				for (const resolve of this.pendingStartWaiters) resolve();
				this.pendingStartWaiters.clear();
			}
		};
	}

	private waitForPendingStarts(): Promise<void> {
		if (this.pendingStartCount === 0) return Promise.resolve();
		return new Promise((resolve) => this.pendingStartWaiters.add(resolve));
	}

	private resolveDelegationScope(requested: SubagentDelegationScope | undefined): SubagentDelegationScopeLease {
		const inherited = this.subagentContext?.delegationScope;
		if (inherited) return { scope: inherited, owned: false };
		if (requested) return { scope: requested, owned: false };
		return {
			scope: new SubagentDelegationScope({ limits: this.delegationLimits, turnLimits: this.turnLimits }),
			owned: true,
		};
	}

	/**
	 * Every child joins the session tree, definition-backed or not: unnamed SDK
	 * starts share the same registry, delegation scope, and depth accounting, and
	 * are fail-closed for nested delegation because only a definition can declare
	 * an `allowedSubagents` policy.
	 */
	private createChildSubagentContext(
		id: string,
		definition: SubagentDefinition | undefined,
		delegationScope: SubagentDelegationScope,
	): SubagentRuntimeContext {
		const parentPath = this.subagentContext?.path ?? [];
		const agentName = definition?.name ?? "subagent";
		const inheritedMaxDepth = this.subagentContext?.maxSubagentDepth;
		const definitionMaxDepth = definition?.maxSubagentDepth;
		const maxSubagentDepth =
			inheritedMaxDepth === undefined
				? definitionMaxDepth
				: definitionMaxDepth === undefined
					? inheritedMaxDepth
					: Math.min(inheritedMaxDepth, definitionMaxDepth);
		return {
			depth: (this.subagentContext?.depth ?? 0) + 1,
			agentName,
			subagentId: id,
			path: [...parentPath, agentName],
			delegationScope,
			registry: this.getRegistry(),
			allowedSubagents: definition?.allowedSubagents ?? [],
			...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
			...(definition?.maxChildAgents !== undefined ? { maxChildAgents: definition.maxChildAgents } : {}),
		};
	}

	private async startRuntime(
		options: SubagentStartOptions,
		definitionOptions?: {
			definition: SubagentDefinition;
			allowedTools?: string[];
		},
		delegation?: {
			scopeLease: SubagentDelegationScopeLease;
			reservation: SubagentDelegationReservation;
		},
	): Promise<SubagentHandle> {
		const cwd = options.cwd ?? this.cwd;
		const agentDir = options.agentDir ?? this.agentDir;
		const sessionManager = options.sessionManager ?? this.createDefaultChildSessionManager(cwd);
		const id = options.resumeSubagentId ?? `sa_${randomUUID()}`;
		if (!delegation) {
			throw new Error("Subagent delegation scope is required");
		}
		const subagentContext = this.createChildSubagentContext(
			id,
			definitionOptions?.definition,
			delegation.scopeLease.scope,
		);
		const runtime = await this.createChildRuntime({ cwd, agentDir, sessionManager, subagentContext });
		const turnBudget = new SubagentTurnBudget(delegation.scopeLease.scope.turnLimits);
		let requiresFinalTurnReport = false;
		let stopAfterTurnForBudget = false;
		let pendingBudgetDelivery: string | undefined;
		let finalResponseSatisfiedBudget = false;
		const abortForTurnBudget = (): void => {
			stopAfterTurnForBudget = true;
			this.markActivityAbortRequested(id);
			void runtime.session.abort().catch(() => undefined);
		};
		// AgentSession installs these hooks exactly once in its constructor and
		// throws on any reinstall (see AgentSession._installAgentToolHooks), so the
		// budget wrappers chained here cannot be silently dropped. The wiring
		// persists for the runtime's whole lifetime — re-prompted children keep
		// their report-only posture — and the originals are restored on dispose (or
		// spawn failure), but only while the budget wrapper is still the installed
		// hook.
		const originalBeforeToolCall = runtime.session.agent.beforeToolCall;
		const originalNextAction = runtime.session.agent.nextAction;
		const budgetBeforeToolCall: NonNullable<typeof originalBeforeToolCall> = async (context, signal) => {
			if (requiresFinalTurnReport) {
				// This block reason is the guaranteed instruction channel for the
				// report stage; the steer message below is only best-effort.
				return {
					block: true,
					reason: "This subagent's turn budget is exhausted. Do not use tools; return your best final report now.",
				};
			}
			return originalBeforeToolCall?.(context, signal);
		};
		const budgetNextAction: NonNullable<typeof originalNextAction> = async (context, signal) => {
			if (context.requestAuthority === "final_response") {
				pendingBudgetDelivery = undefined;
				finalResponseSatisfiedBudget = true;
				return originalNextAction ? await originalNextAction(context, signal) : context.defaultAction;
			}
			if (pendingBudgetDelivery !== undefined) {
				const content = pendingBudgetDelivery;
				pendingBudgetDelivery = undefined;
				return {
					type: "request",
					reason: "delivery",
					deliveries: [
						{
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: content }],
									timestamp: Date.now(),
								},
							],
						},
					],
				};
			}
			// A budget stop deliberately skips proactive compaction: auto-resume
			// would contradict the terminal budget decision.
			if (stopAfterTurnForBudget && context.completedTurn) return { type: "stop" };
			return originalNextAction ? await originalNextAction(context, signal) : context.defaultAction;
		};
		runtime.session.agent.beforeToolCall = budgetBeforeToolCall;
		runtime.session.agent.nextAction = budgetNextAction;
		const unsubscribeSessionAccounting = runtime.session.subscribe(
			(event) => {
				if (event.type === "turn_end") {
					// turn_end also fires for error/aborted turns; those deliberately
					// consume budget so a flaky child still converges on its report
					// stage instead of retrying without bound.
					delegation.scopeLease.scope.recordTurn();
					if (finalResponseSatisfiedBudget) {
						finalResponseSatisfiedBudget = false;
						return;
					}
					const requestedTool =
						event.message.role === "assistant" &&
						event.message.content.some((content) => content.type === "toolCall");
					if (requiresFinalTurnReport) {
						stopAfterTurnForBudget = true;
						if (requestedTool) abortForTurnBudget();
						return;
					}
					const turnBudgetEvent = turnBudget.recordTurn();
					if (!turnBudgetEvent) return;
					if (turnBudgetEvent.stage === "exceeded") {
						// Defensive backstop only: both final-report branches below keep
						// requiresFinalTurnReport set, which short-circuits before
						// recordTurn, so this handler never advances the budget past
						// maxTurns itself.
						abortForTurnBudget();
						return;
					}
					if (turnBudgetEvent.stage === "warning") {
						if (!requestedTool) return;
						pendingBudgetDelivery = `This subagent has used ${turnBudgetEvent.turnsUsed} of its ${turnBudgetEvent.maxTurns} allowed turns. Stop broad exploration, finish the current line of inquiry, and begin synthesizing a report.`;
						return;
					}
					if (!requestedTool) {
						// The child finished naturally at its limit. Keep the report-only
						// posture so a later re-prompt yields tool-blocked one-turn
						// replies instead of burning a turn into the exceeded backstop.
						requiresFinalTurnReport = true;
						stopAfterTurnForBudget = true;
						return;
					}
					requiresFinalTurnReport = true;
					pendingBudgetDelivery = `This subagent has reached its ${turnBudgetEvent.maxTurns}-turn limit. Do not call any more tools. Return your best final report now, including useful findings, evidence, and any unresolved gaps.`;
					return;
				}
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				const usage = event.message.usage;
				delegation.scopeLease.scope.recordUsage(
					usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
					usage.cost.total,
				);
			},
			{ monitorGitContext: false },
		);
		const teardownBudgetWiring = (): void => {
			unsubscribeSessionAccounting();
			// Restore each hook only while the budget wrapper is still installed;
			// if another wrapper chained over it after spawn, reassigning the
			// original here would silently discard that wrapper's chain.
			if (runtime.session.agent.beforeToolCall === budgetBeforeToolCall) {
				runtime.session.agent.beforeToolCall = originalBeforeToolCall;
			}
			if (runtime.session.agent.nextAction === budgetNextAction) {
				runtime.session.agent.nextAction = originalNextAction;
			}
		};
		let client: InProcessRpcClient | undefined;
		let runtimeRegistration: SubagentRuntimeRegistration | undefined;
		let rollbackRuntimeRegistrationPromise: Promise<void> | undefined;
		let published = false;
		const rollbackRuntimeRegistration = (): Promise<void> => {
			if (published) return Promise.resolve();
			if (!rollbackRuntimeRegistrationPromise) {
				const registration = runtimeRegistration;
				runtimeRegistration = undefined;
				rollbackRuntimeRegistrationPromise = registration?.rollback().catch(() => undefined) ?? Promise.resolve();
			}
			return rollbackRuntimeRegistrationPromise;
		};
		try {
			if (definitionOptions) {
				await this.applyDefinitionToRuntime(
					runtime,
					definitionOptions.definition,
					definitionOptions.allowedTools,
					subagentContext,
				);
			}

			let handle: LocalSubagentHandle | undefined;
			client = await createInProcessRpcClient(runtime, {
				disposeRuntimeOnClose: !this.retainRuntimeOnDispose,
				requestTimeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
				onEvent: (event) => {
					this.recordActivityEvent(id, event);
					handle?.handleEvent(event);
				},
			});
			runtimeRegistration = await this.notifyRuntimeCreated({
				id,
				runtime,
				definition: definitionOptions?.definition,
			});
			const publish = (message: string): void => {
				if (published) return;
				runtimeRegistration?.commit();
				runtimeRegistration = undefined;
				published = true;
				this.recordSpawnEdge(options.spawnRecord, id, definitionOptions?.definition, runtime);
				this.getRegistry().register({
					id,
					...(this.subagentContext ? { parentId: this.subagentContext.subagentId } : {}),
					agent: {
						name: definitionOptions?.definition.name ?? "subagent",
						...(definitionOptions?.definition.source ? { source: definitionOptions.definition.source } : {}),
					},
					path: subagentContext.path,
				});
				this.getRegistry().setTask(id, options.resumeTaskLabel ?? message);
				this.registerActivity(id, runtime, definitionOptions?.definition, message);
			};
			handle = new LocalSubagentHandle({
				id,
				sessionId: runtime.session.sessionId,
				client,
				abortRuntime: (source) => runtime.session.abort(source),
				removeFromManager: (handleId) => {
					this.handles.delete(handleId);
				},
				onPromptAccepted: publish,
				onPromptFailed: async (error) => {
					if (published) {
						this.finishActivity(id, "failed", errorMessage(error));
						return;
					}
					await rollbackRuntimeRegistration();
				},
				onAbortRequested: () => this.markActivityAbortRequested(id),
				// Turn-budget wiring outlives the first terminal: scope accounting on
				// a disposed scope is a guarded no-op, while the per-runtime turn
				// posture keeps applying to re-prompts until the runtime is disposed.
				onTerminal: () => {
					delegation.reservation.release();
					if (delegation.scopeLease.owned) delegation.scopeLease.scope.dispose();
				},
				onDispose: async () => {
					teardownBudgetWiring();
					await rollbackRuntimeRegistration();
				},
				waitForIdle: async () => {
					await runtime.session.waitForIdle();
					await runtime.session.sessionManager.flush();
				},
			});
			delegation.reservation.commit(id, () => {
				void runtime.session.abort();
			});
			this.handles.set(id, handle);
			void handle.waitForEnd().then(
				(result) => {
					const terminal = getTerminalActivityResult(
						result.event,
						this.activities.get(id)?.abortRequested === true,
					);
					this.finishActivity(id, terminal.status, terminal.error);
					const output = getFinalAssistantText(result.event);
					this.getRegistry().complete(id, terminal.status, {
						...(output !== undefined ? { output } : {}),
						...(terminal.error !== undefined ? { error: terminal.error } : {}),
					});
				},
				(error: unknown) => {
					const activity = this.activities.get(id);
					const status = activity?.abortRequested ? "aborted" : "failed";
					const message = status === "failed" ? errorMessage(error) : undefined;
					this.finishActivity(id, status, message);
					this.getRegistry().complete(id, status, message !== undefined ? { error: message } : {});
				},
			);
			return handle;
		} catch (error) {
			teardownBudgetWiring();
			await client?.stop().catch(() => undefined);
			await rollbackRuntimeRegistration();
			await runtime.dispose().catch(() => undefined);
			throw error;
		}
	}

	private registerActivity(
		id: string,
		runtime: AgentSessionRuntime,
		definition: SubagentDefinition | undefined,
		task: string,
	): void {
		const now = Date.now();
		const activity: MutableSubagentActivity = {
			id,
			sessionId: runtime.session.sessionId,
			agent: {
				name: definition?.name ?? "subagent",
				source: definition?.source,
			},
			task,
			status: "running",
			startedAt: now,
			updatedAt: now,
			finishedAt: undefined,
			abortRequested: false,
			events: [],
			droppedEvents: 0,
			transcript: [],
			sessionStats: undefined,
			error: undefined,
			runtime,
			nextSequence: 0,
		};
		this.activities.set(id, activity);
		this.trimActivities();
		this.notifyActivity(activity);
	}

	private markActivityAbortRequested(id: string): void {
		const activity = this.activities.get(id);
		if (!activity || activity.status !== "running") return;
		activity.abortRequested = true;
		activity.updatedAt = Date.now();
		this.notifyActivity(activity);
	}

	private recordActivityEvent(id: string, event: SubagentEvent): void {
		const activity = this.activities.get(id);
		if (!activity) return;
		const now = Date.now();
		const previous = activity.events[activity.events.length - 1];
		const coalesceMessageUpdate = previous?.event.type === "message_update" && event.type === "message_update";
		const coalesceToolUpdate =
			previous?.event.type === "tool_execution_update" &&
			event.type === "tool_execution_update" &&
			previous.event.toolCallId === event.toolCallId;
		if (previous && (coalesceMessageUpdate || coalesceToolUpdate)) {
			previous.timestamp = now;
			previous.event = event;
		} else {
			activity.events.push({ sequence: activity.nextSequence, timestamp: now, event });
			activity.nextSequence += 1;
			if (activity.events.length > MAX_RETAINED_ACTIVITY_EVENTS) {
				activity.events.shift();
				activity.droppedEvents += 1;
			}
		}
		activity.updatedAt = now;
		this.notifyActivity(activity);
	}

	private finishActivity(id: string, status: Exclude<SubagentActivityStatus, "running">, error?: string): void {
		const activity = this.activities.get(id);
		if (!activity || activity.status !== "running") return;
		const runtime = activity.runtime;
		if (runtime) {
			activity.transcript = [...runtime.session.messages];
			activity.sessionStats = runtime.session.getSessionStats();
		}
		const now = Date.now();
		activity.runtime = undefined;
		activity.status = status;
		activity.finishedAt = now;
		activity.updatedAt = now;
		activity.error = error;
		this.notifyActivity(activity);
		this.trimActivities();
	}

	private snapshotActivity(activity: MutableSubagentActivity): SubagentActivity {
		const runtime = activity.runtime;
		const transcript = runtime ? [...runtime.session.messages] : [...activity.transcript];
		const sessionStats = runtime ? runtime.session.getSessionStats() : activity.sessionStats;
		return {
			id: activity.id,
			sessionId: activity.sessionId,
			agent: { ...activity.agent },
			...(activity.task !== undefined ? { task: activity.task } : {}),
			status: activity.status,
			startedAt: activity.startedAt,
			updatedAt: activity.updatedAt,
			...(activity.finishedAt !== undefined ? { finishedAt: activity.finishedAt } : {}),
			abortRequested: activity.abortRequested,
			events: activity.events.map((entry) => ({ ...entry })),
			droppedEvents: activity.droppedEvents,
			transcript,
			...(sessionStats ? { sessionStats } : {}),
			...(activity.error ? { error: activity.error } : {}),
		};
	}

	private notifyActivity(activity: MutableSubagentActivity): void {
		for (const listener of this.activityListeners) {
			try {
				listener(activity.id);
			} catch {
				// Observer failures must not affect child execution.
			}
		}
	}

	private trimActivities(): void {
		while (this.activities.size > MAX_RETAINED_ACTIVITIES) {
			let oldestTerminal: MutableSubagentActivity | undefined;
			for (const activity of this.activities.values()) {
				if (activity.status !== "running") {
					oldestTerminal = activity;
					break;
				}
			}
			if (!oldestTerminal) return;
			this.activities.delete(oldestTerminal.id);
		}
	}

	private createDefaultChildSessionManager(cwd: string): SessionManager {
		if (!this.parentSessionManager?.isPersisted()) {
			return SessionManager.inMemory(cwd);
		}
		const parentSession = this.parentSessionManager.getSessionFile();
		return SessionManager.create(cwd, this.parentSessionManager.getSessionDir(), {
			origin: "subagent",
			...(parentSession ? { parentSession } : {}),
		});
	}

	private recordSpawnEdge(
		spawnRecord: SubagentSpawnRecordContext | undefined,
		id: string,
		definition: SubagentDefinition | undefined,
		runtime: AgentSessionRuntime,
	): void {
		if (!spawnRecord || !this.parentSessionManager?.isPersisted()) return;
		// Both identity fields come from the runtime's own session manager: a
		// factory that swaps managers must not produce an edge whose id and file
		// disagree.
		const childSessionManager = runtime.session.sessionManager;
		const childSessionFile = childSessionManager.getSessionFile();
		try {
			this.parentSessionManager.appendSubagentSpawn({
				toolCallId: spawnRecord.toolCallId,
				requestKey: spawnRecord.requestKey,
				subagentId: id,
				agent: definition?.name ?? "subagent",
				childSessionId: childSessionManager.getSessionId(),
				...(childSessionFile !== undefined ? { childSessionFile } : {}),
			});
		} catch {
			// The child is already running: losing the recovery edge must not turn
			// an accepted spawn into a failure. A fail-stopped parent transcript has
			// already lost recoverability wholesale.
		}
	}

	/**
	 * Recover pre-restart delegation records from persisted transcripts into
	 * the registry (issue #129, design §3). Root-manager only — descendants
	 * share the root registry. Lazy and idempotent; awaited from the async
	 * model-facing paths before registry reads. Failures are contained per
	 * edge: an unreadable child transcript records an unrecoverable run
	 * instead of failing hydration.
	 */
	async ensureRegistryHydrated(): Promise<void> {
		if (this.subagentContext || !this.parentSessionManager?.isPersisted()) {
			return;
		}
		this.hydrationPromise ??= this.hydrateSpawnEdges(
			this.getRegistry(),
			this.parentSessionManager,
			[],
			undefined,
			new Set([this.parentSessionManager.getSessionFile() ?? ""]),
		).catch((error) => {
			// Per-edge failures are contained inside the walk; an unexpected
			// rejection here must not brick every later registry read on a
			// memoized failure — drop the memo so the next read retries.
			this.hydrationPromise = undefined;
			throw error;
		});
		return this.hydrationPromise;
	}

	private async hydrateSpawnEdges(
		registry: SubagentRegistry,
		sessionManager: SessionManager,
		ancestorPath: string[],
		parentRegistryId: string | undefined,
		visitedFiles: Set<string>,
	): Promise<void> {
		const settledToolCallIds = collectSettledToolCallIds(sessionManager);
		const presentToolCallIds = collectToolCallIds(sessionManager);
		for (const edge of sessionManager.getSubagentSpawnEntries()) {
			if (
				typeof edge.subagentId !== "string" ||
				edge.subagentId.length === 0 ||
				typeof edge.toolCallId !== "string" ||
				typeof edge.agent !== "string"
			) {
				continue;
			}
			// A settled edge needs no record, but its transcript can hold
			// unsettled descendant edges (e.g. a grandchild that completed while
			// its parent's failure was captured as a task error), so the walk
			// still descends into every child transcript.
			const settled = settledToolCallIds.has(edge.toolCallId) || registry.get(edge.subagentId) !== undefined;
			const path = [...ancestorPath, edge.agent];
			const parsedStart = Date.parse(edge.timestamp);
			const startedAt = Number.isNaN(parsedStart) ? Date.now() : parsedStart;
			const base = {
				id: edge.subagentId,
				...(parentRegistryId !== undefined ? { parentId: parentRegistryId } : {}),
				agent: { name: edge.agent },
				path,
				...(presentToolCallIds.has(edge.toolCallId) ? {} : { stranded: true }),
				startedAt,
			};
			if (typeof edge.childSessionFile !== "string") {
				if (!settled) {
					registry.hydrate({
						...base,
						status: "failed",
						error: "Child session was not persisted; its result is unrecoverable.",
						finishedAt: startedAt,
					});
				}
				continue;
			}
			if (visitedFiles.has(edge.childSessionFile)) {
				if (!settled) {
					registry.hydrate({
						...base,
						status: "failed",
						error: "Child transcript is already attributed to another edge; its result is unrecoverable.",
						finishedAt: startedAt,
					});
				}
				continue;
			}
			visitedFiles.add(edge.childSessionFile);
			// One macrotask per child keeps multi-megabyte transcript loads from
			// monopolizing the event loop (the #46/#123 lesson).
			await new Promise((resolve) => setImmediate(resolve));
			let child: SessionManager;
			try {
				// open() treats a missing path as a fresh session, so absence needs
				// an explicit check to classify the edge as unrecoverable.
				if (!existsSync(edge.childSessionFile)) {
					throw new Error("child transcript file does not exist");
				}
				child = SessionManager.open(edge.childSessionFile);
			} catch {
				if (!settled) {
					registry.hydrate({
						...base,
						status: "failed",
						error: "Child transcript is missing or unreadable; its result is unrecoverable.",
						finishedAt: startedAt,
					});
				}
				continue;
			}
			if (!settled) {
				const state = deriveHydratedChildState(child, startedAt);
				registry.hydrate({
					...base,
					status: state.status,
					...(state.task !== undefined ? { task: state.task } : {}),
					...(state.output !== undefined ? { output: state.output } : {}),
					...(state.error !== undefined ? { error: state.error } : {}),
					childSessionFile: edge.childSessionFile,
					finishedAt: state.finishedAt,
				});
			}
			await this.hydrateSpawnEdges(registry, child, path, edge.subagentId, visitedFiles);
		}
	}

	private async notifyRuntimeCreated(options: {
		id: string;
		runtime: AgentSessionRuntime;
		definition?: SubagentDefinition;
	}): Promise<SubagentRuntimeRegistration | undefined> {
		if (!this.onRuntimeCreated) {
			return undefined;
		}
		return (
			(await this.onRuntimeCreated({
				id: options.id,
				sessionId: options.runtime.session.sessionId,
				runtime: options.runtime,
				...(options.definition ? { definition: options.definition } : {}),
				...(this.parentSessionManager ? { parentSessionId: this.parentSessionManager.getSessionId() } : {}),
				...(this.parentSessionManager?.getSessionFile()
					? { parentSessionFile: this.parentSessionManager.getSessionFile() }
					: {}),
			})) ?? undefined
		);
	}

	private resolveDefinition(
		agentName: string,
		resourceLoaderOverride: ResourceLoader | undefined,
	): SubagentDefinition {
		const resourceLoader = resourceLoaderOverride ?? this.resourceLoader;
		if (!resourceLoader) {
			throw new SubagentDefinitionNotFoundError(agentName, []);
		}

		const result = resourceLoader.getSubagents();
		const definition = result.definitions.find((candidate) => candidate.name === agentName.trim());
		if (!definition) {
			throw new SubagentDefinitionNotFoundError(
				agentName,
				result.definitions.map((candidate) => candidate.name),
				result.diagnostics,
			);
		}
		return definition;
	}

	private async applyDefinitionToRuntime(
		runtime: AgentSessionRuntime,
		definition: SubagentDefinition,
		allowedTools: string[] | undefined,
		subagentContext: SubagentRuntimeContext | undefined,
	): Promise<void> {
		const allowedSubagents = normalizeUniqueNames(definition.allowedSubagents) ?? [];
		const activeTools = resolveEffectiveTools({
			requestedTools: definition.tools,
			excludedTools:
				allowedSubagents.length === 0
					? [...(definition.excludedTools ?? []), "subagent"]
					: definition.excludedTools,
			allowedTools,
			defaultTools: runtime.session.getActiveToolNames(),
		});
		if (activeTools) {
			runtime.session.setActiveToolsByName(activeTools);
		}
		runtime.session.appendSystemPromptContext(definition.systemPrompt);
		if (runtime.session.getActiveToolNames().includes(SUBAGENT_REGISTRY_TOOL_NAME)) {
			const snapshot = formatDelegationSnapshot(
				this.getRegistry().snapshotForFollower(
					DELEGATION_SNAPSHOT_MAX_RECORDS,
					subagentContext?.subagentId,
					this.subagentContext?.subagentId,
				),
			);
			if (snapshot) {
				runtime.session.appendSystemPromptContext(snapshot);
			}
		}

		let thinkingLevel = this.validateThinkingLevel(definition);
		if (definition.model) {
			const availableModels = await runtime.session.modelRegistry.getAvailable();
			const resolved = parseModelPattern(definition.model, availableModels, {
				allowInvalidThinkingLevelFallback: false,
			});
			if (!resolved.model) {
				throw new SubagentDefinitionConfigurationError(
					definition.name,
					"model",
					`model reference "${definition.model}" is not available or is not configured`,
				);
			}
			await runtime.session.setModel(resolved.model, { persistDefault: false });
			thinkingLevel ??= resolved.thinkingLevel;
		}

		if (thinkingLevel) {
			runtime.session.setThinkingLevel(thinkingLevel, { persistDefault: false });
		}
	}

	private validateThinkingLevel(definition: SubagentDefinition): ThinkingLevel | undefined {
		if (!definition.thinking) {
			return undefined;
		}
		// Discovery keeps invalid frontmatter as diagnostics, but definition-backed starts fail
		// before prompting so callers get a clear configuration error for this subagent.
		if (!isThinkingLevel(definition.thinking)) {
			throw new SubagentDefinitionConfigurationError(
				definition.name,
				"thinking",
				`"${definition.thinking}" is not a supported thinking level`,
			);
		}
		return definition.thinking;
	}

	private async createChildRuntime(options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		subagentContext?: SubagentRuntimeContext;
	}): Promise<AgentSessionRuntime> {
		return createAgentSessionRuntime(this.createRuntime, {
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: options.sessionManager,
			workspaceName: this.workspaceName,
			baseRef: this.baseRef,
			...(options.subagentContext ? { subagentContext: options.subagentContext } : {}),
		});
	}
}
