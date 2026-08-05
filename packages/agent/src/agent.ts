import {
	type AssistantMessage,
	type ImageContent,
	type InferenceSpeed,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@hansjm10/volt-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { DeliveryInbox, type DeliveryLease, type InboxDelivery } from "./delivery-inbox.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentAbortAcceptance,
	AgentAbortSource,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentLoopRequestUpdate,
	AgentMessage,
	AgentRequestAuthority,
	AgentRunSnapshot,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PendingToolExecution,
	PrepareRequestContext,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type RuntimeStateKeys =
	| "isStreaming"
	| "streamingMessage"
	| "pendingToolCalls"
	| "pendingToolExecutions"
	| "errorMessage";

type MutableAgentState = Omit<AgentState, RuntimeStateKeys> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	pendingToolExecutions: Map<string, PendingToolExecution>;
	errorMessage?: string;
};

function createMutableAgentState(initialState?: Partial<Omit<AgentState, RuntimeStateKeys>>): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		pendingToolExecutions: new Map<string, PendingToolExecution>(),
		errorMessage: undefined,
	};
}

/** Delivery source prepared by the Agent dispatcher. */
export type AgentDeliveryKind = "prompt" | "steer" | "followUp" | "host";

/** Stable delivery passed to `prepareDelivery`. */
export interface AgentDelivery {
	/** Runtime dispatcher identity; never substitutes for an ID carried by a message. */
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
	readonly messages: readonly AgentMessage[];
}

/** Side-effect-free messages plus work committed only after delivery ownership transfers. */
export interface AgentDeliveryPreparation {
	messages: AgentMessage[];
	/**
	 * Cross the delivery owner's durability boundary.
	 *
	 * This callback may be asynchronous, but it must not call lifecycle methods
	 * that wait for the active Agent run (including AgentSession abort/dispose).
	 */
	commit?: () => void | Promise<void>;
}

export interface AgentDeliveryFailure {
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
	readonly phase: "prepare" | "commit";
	readonly error: Error;
}

/** Explicit outcome of one bounded Agent run. */
export type AgentRunResult =
	| { readonly status: "completed" }
	| { readonly status: "delivery_failed"; readonly failure: AgentDeliveryFailure };

export type AgentRequestAction = Extract<AgentLoopNextAction, { type: "request" }>;
export type AgentRequestGateDecision = "proceed" | "pause";

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, RuntimeStateKeys>>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Stage an inbox-owned delivery before its irrevocable begin boundary. */
	prepareDelivery?: (
		delivery: AgentDelivery,
		signal?: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	/** Compose host policy into the dispatcher's single action at each request boundary. */
	nextAction?: (
		context: AgentLoopNextActionContext,
		signal?: AbortSignal,
	) => AgentLoopNextAction | Promise<AgentLoopNextAction>;
	/** Pause after policy resolves while retaining the exact request for a later continuation. */
	requestGate?: (
		context: AgentLoopNextActionContext,
		action: AgentRequestAction,
		signal?: AbortSignal,
	) => AgentRequestGateDecision | Promise<AgentRequestGateDecision>;
	/** Refresh runtime state after deliveries finalize and only when a provider request will occur. */
	prepareRequest?: (
		context: PrepareRequestContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopRequestUpdate | undefined> | AgentLoopRequestUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	inferenceSpeed?: InferenceSpeed;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
}

type PassiveAgentEventListener = (event: AgentEvent, signal: AbortSignal) => void;
type AsyncPassiveAgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void>;
type ReplacingAgentEventListener = (event: AgentEvent, signal: AbortSignal) => AgentMessage | undefined;
type AsyncReplacingAgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<AgentMessage | undefined>;

export type AgentEventListener =
	| PassiveAgentEventListener
	| AsyncPassiveAgentEventListener
	| ReplacingAgentEventListener
	| AsyncReplacingAgentEventListener;

type PendingDelivery = InboxDelivery<AgentDeliveryKind, AgentMessage>;

type DispatcherStartState = {
	firstDecision: boolean;
	requestAuthority: AgentRequestAuthority;
	providerRequestPending: boolean;
	retainedRequest?: AgentRequestAction;
	drainFollowUpsFirst?: boolean;
};

type PausedDispatcherState = Pick<DispatcherStartState, "requestAuthority" | "providerRequestPending"> & {
	retainedRequest?: AgentRequestAction;
};

type ActiveRun = {
	id: string;
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
	turnOpen: boolean;
	abortSource?: AgentAbortSource;
	diagnosticTimestamp?: number;
	requestAccepted: boolean;
	deliveryCommitInProgress: boolean;
	deliveryFailure?: AgentDeliveryFailure;
	phase: "open" | "terminal_event_settling" | "settled";
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<AgentEventListener>();
	private readonly inbox = new DeliveryInbox<AgentDeliveryKind, AgentMessage>(
		() => `local-queue:${globalThis.crypto.randomUUID()}`,
	);
	private activeLease?: DeliveryLease<AgentDeliveryKind, AgentMessage>;
	private pendingDeliverySelection: PendingDelivery[] = [];
	private readonly preparedDeliveryCommits = new Map<string, () => void | Promise<void>>();
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;
	private pausedState?: PausedDispatcherState;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	/** Stage one inbox-owned delivery before it enters model context. */
	public prepareDelivery?: (
		delivery: AgentDelivery,
		signal?: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	/** Resolve a request, resumable pause, or terminal stop at each dispatcher boundary. */
	public nextAction?: (
		context: AgentLoopNextActionContext,
		signal?: AbortSignal,
	) => AgentLoopNextAction | Promise<AgentLoopNextAction>;
	/** Pause after action resolution without discarding the resolved request. */
	public requestGate?: (
		context: AgentLoopNextActionContext,
		action: AgentRequestAction,
		signal?: AbortSignal,
	) => AgentRequestGateDecision | Promise<AgentRequestGateDecision>;
	/** Refresh runtime state immediately before an actual provider request. */
	public prepareRequest?: (
		context: PrepareRequestContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopRequestUpdate | undefined> | AgentLoopRequestUpdate | undefined;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Provider-neutral inference speed preference forwarded to primary model turns. */
	public inferenceSpeed?: InferenceSpeed;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareDelivery = options.prepareDelivery;
		this.nextAction = options.nextAction;
		this.requestGate = options.requestGate;
		this.prepareRequest = options.prepareRequest;
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.inferenceSpeed = options.inferenceSpeed;
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering deliveries are claimed. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueueMode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	/** Controls how queued follow-up deliveries are claimed. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueueMode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	/** Admit host-owned work into the same inbox used by all other delivery sources. */
	hostDelivery(messages: AgentMessage | readonly AgentMessage[]): string {
		return this.enqueueDelivery("host", Array.isArray(messages) ? [...messages] : [messages]);
	}

	/** Queue a delivery to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): string {
		return this.enqueueDelivery("steer", [message]);
	}

	/** Queue a delivery to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): string {
		return this.enqueueDelivery("followUp", [message]);
	}

	/** Remove queued host deliveries whose commit boundary has not been crossed. */
	clearHostQueue(): string[] {
		return this.clearDeliveries("host");
	}

	/** Remove queued steering deliveries whose begin boundary has not been crossed. */
	clearSteeringQueue(): string[] {
		return this.clearDeliveries("steer");
	}

	/** Remove queued follow-up deliveries whose begin boundary has not been crossed. */
	clearFollowUpQueue(): string[] {
		return this.clearDeliveries("followUp");
	}

	/** Remove all still-revocable steering and follow-up deliveries. */
	clearAllQueues(): string[] {
		return [...this.clearSteeringQueue(), ...this.clearFollowUpQueue()];
	}

	/** Dispatcher identities for one still-revocable inbox kind. */
	getPendingDeliveryIds(kind: AgentDeliveryKind): string[] {
		return this.inbox.list(kind).map((delivery) => delivery.deliveryId);
	}

	/** Discard an initial prompt whose delivery has not committed. */
	discardPendingPrompt(): string[] {
		return this.clearDeliveries("prompt");
	}

	/** Returns true when the inbox has a pending or leased delivery. */
	hasQueuedMessages(): boolean {
		return this.inbox.hasPending();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, recording the first known local authority. */
	abort(source?: AgentAbortSource): AgentAbortAcceptance {
		const run = this.activeRun;
		if (!run || run.phase === "settled") {
			return Object.freeze({ runId: run?.id, accepted: false, source: run?.abortSource });
		}
		if (source !== undefined && run.abortSource === undefined) {
			run.abortSource = source;
			run.diagnosticTimestamp = Date.now();
		}
		run.abortController.abort();
		return Object.freeze({ runId: run.id, accepted: true, source: run.abortSource });
	}

	/** True while the active run is awaiting its delivery owner's commit callback. */
	get isDeliveryCommitInProgress(): boolean {
		return this.activeRun?.deliveryCommitInProgress === true;
	}

	/** Immutable lifecycle snapshot for structural teardown. */
	get activeRunSnapshot(): AgentRunSnapshot | undefined {
		const run = this.activeRun;
		return run
			? Object.freeze({
					runId: run.id,
					source: run.abortSource,
					diagnosticTimestamp: run.diagnosticTimestamp,
					requestAccepted: run.requestAccepted,
					phase: run.phase,
				})
			: undefined;
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.pendingToolExecutions = new Map<string, PendingToolExecution>();
		this._state.errorMessage = undefined;
		this.inbox.reset();
		this.activeLease = undefined;
		this.pendingDeliverySelection = [];
		this.preparedDeliveryCommits.clear();
		this.pausedState = undefined;
	}

	/** Start a new prompt through the same inbox dispatcher used by queued input. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<AgentRunResult>;
	async prompt(input: string, images?: ImageContent[]): Promise<AgentRunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<AgentRunResult> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		if (this.inbox.hasPending("prompt")) {
			throw new Error(
				"Agent has a retained prompt. Call continue() to resume it or discardPendingPrompt() to cancel it.",
			);
		}
		this.pausedState = undefined;
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		this.enqueueDelivery("prompt", this.normalizePromptInput(input, images));
		return await this.runDispatcher({
			firstDecision: true,
			requestAuthority: "provider",
			providerRequestPending: lastMessage !== undefined && lastMessage.role !== "assistant",
		});
	}

	/** Resume dispatcher state or a provider-ready transcript. */
	async continue(options: { drainFollowUps?: boolean } = {}): Promise<AgentRunResult> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage && !this.hasQueuedMessages()) {
			throw new Error("No messages to continue from");
		}
		const pausedState = this.pausedState;
		this.pausedState = undefined;
		if (lastMessage?.role === "assistant" && !this.hasQueuedMessages() && !this.nextAction && !pausedState) {
			return { status: "completed" };
		}
		return await this.runDispatcher({
			firstDecision: true,
			requestAuthority: pausedState?.requestAuthority ?? "provider",
			providerRequestPending:
				pausedState?.providerRequestPending ?? (lastMessage !== undefined && lastMessage.role !== "assistant"),
			retainedRequest: pausedState?.retainedRequest,
			drainFollowUpsFirst: options.drainFollowUps === true || lastMessage?.role === "assistant",
		});
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runDispatcher(startState: DispatcherStartState): Promise<AgentRunResult> {
		return await this.runWithLifecycle(async (signal) => {
			const context = this.createContextSnapshot();
			const config = this.createLoopConfig(startState);
			if (context.messages.length === 0) {
				await runAgentLoop([], context, config, (event) => this.processEvents(event), signal, this.streamFn);
				return;
			}
			await runAgentLoopContinue(context, config, (event) => this.processEvents(event), signal, this.streamFn);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private enqueueDelivery(kind: AgentDeliveryKind, messages: AgentMessage[]): string {
		return this.inbox.enqueue(kind, messages).deliveryId;
	}

	private clearDeliveries(kind: AgentDeliveryKind): string[] {
		const revoked = this.inbox.revoke(kind);
		for (const delivery of revoked) {
			this.preparedDeliveryCommits.delete(delivery.deliveryId);
		}
		return revoked.map((delivery) => delivery.deliveryId);
	}

	private selectPendingDeliveries(kind: AgentDeliveryKind, mode: QueueMode): PendingDelivery[] {
		return [...this.inbox.select(kind, mode)];
	}

	private async resolveNextAction(
		context: AgentLoopNextActionContext,
		startState: DispatcherStartState,
	): Promise<AgentLoopNextAction> {
		const isFirstDecision = startState.firstDecision;
		startState.firstDecision = false;
		const requestAuthority = isFirstDecision ? startState.requestAuthority : context.requestAuthority;
		const retainedRequest = isFirstDecision ? startState.retainedRequest : undefined;
		const runtimeAction = context.defaultAction;
		const providerRequestPending = isFirstDecision
			? startState.providerRequestPending
			: runtimeAction.type === "request";

		if (this.signal?.aborted) {
			this.pausedState = { requestAuthority, providerRequestPending, retainedRequest };
			return { type: "pause", requestAuthority };
		}

		if (requestAuthority === "final_response") {
			const hookContext = { ...context, requestAuthority, defaultAction: runtimeAction };
			const resolvedAction =
				retainedRequest ?? (this.nextAction ? await this.nextAction(hookContext, this.signal) : runtimeAction);
			if (resolvedAction.type === "pause") {
				this.pausedState = { requestAuthority, providerRequestPending };
				return { ...resolvedAction, requestAuthority };
			}
			const action = { type: "request", reason: "final_response" } as const;
			if ((await this.requestGate?.(hookContext, action, this.signal)) === "pause") {
				this.pausedState = { requestAuthority, providerRequestPending: true, retainedRequest: action };
				return { type: "pause", requestAuthority };
			}
			// Keep final-response authority until the completed response reaches the
			// next dispatcher boundary. A host retry or compaction continuation starts
			// a fresh core run before that boundary when this request fails.
			this.pausedState = { requestAuthority, providerRequestPending: true };
			return action;
		}

		const hasIndependentRequest = runtimeAction.type === "request" && providerRequestPending;
		const selectForBoundary = (): PendingDelivery[] => {
			const prompt = this.selectPendingDeliveries("prompt", "all");
			const host = this.selectPendingDeliveries("host", "all");
			const steering = this.selectPendingDeliveries("steer", this.steeringQueueMode);
			let selected = prompt.length > 0 ? [...prompt, ...host, ...steering] : [...host, ...steering];
			if (selected.length === 0 && ((isFirstDecision && startState.drainFollowUpsFirst) || !hasIndependentRequest)) {
				selected = this.selectPendingDeliveries("followUp", this.followUpQueueMode);
			}
			return selected;
		};
		const suggestedDeliveries = selectForBoundary();
		const suggestedAction: AgentLoopNextAction =
			suggestedDeliveries.length > 0
				? { type: "request", reason: hasIndependentRequest ? "continuation" : "delivery" }
				: hasIndependentRequest
					? runtimeAction
					: { type: "stop" };
		const hookContext = { ...context, requestAuthority, defaultAction: suggestedAction };
		const action =
			retainedRequest ?? (this.nextAction ? await this.nextAction(hookContext, this.signal) : suggestedAction);
		if (action.type === "pause") {
			this.pendingDeliverySelection = [];
			this.pausedState = {
				requestAuthority: action.requestAuthority ?? requestAuthority,
				providerRequestPending: hasIndependentRequest,
			};
			return { ...action, requestAuthority: action.requestAuthority ?? requestAuthority };
		}
		if (action.type === "stop") {
			this.pendingDeliverySelection = [];
			this.pausedState = undefined;
			return action;
		}
		if ((await this.requestGate?.(hookContext, action, this.signal)) === "pause") {
			this.pendingDeliverySelection = [];
			this.pausedState = {
				requestAuthority,
				providerRequestPending: true,
				retainedRequest: action,
			};
			return { type: "pause", requestAuthority };
		}

		this.pausedState = undefined;
		// Re-select after host policy runs so a policy hook may atomically enqueue a
		// host delivery without carrying its payload in the returned action.
		this.pendingDeliverySelection = selectForBoundary();
		return action;
	}

	private async prepareResolvedDeliveries(): Promise<AgentLoopDelivery[]> {
		const selected = this.pendingDeliverySelection;
		this.pendingDeliverySelection = [];
		return selected.length > 0 ? await this.prepareLeasedDeliveries(selected) : [];
	}

	private async prepareLeasedDeliveries(selected: PendingDelivery[]): Promise<AgentLoopDelivery[]> {
		const lease = this.inbox.lease(selected);
		this.activeLease = lease;
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			if (this.activeLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
			let preparation: AgentDeliveryPreparation;
			try {
				preparation = this.prepareDelivery
					? await this.prepareDelivery(
							{
								deliveryId: delivery.deliveryId,
								kind: delivery.kind,
								messages: delivery.messages.slice(),
							},
							this.signal,
						)
					: { messages: delivery.messages.slice() };
			} catch (error) {
				if (this.activeLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
				this.recordDeliveryFailure(delivery, "prepare", error);
				throw error;
			}
			if (this.activeLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
			if (preparation.messages.length === 0) {
				const error = new Error("prepareDelivery must retain at least one message for an admitted delivery");
				this.recordDeliveryFailure(delivery, "prepare", error);
				throw error;
			}
			if (preparation.commit) {
				this.preparedDeliveryCommits.set(delivery.deliveryId, preparation.commit);
			}
			deliveries.push({
				deliveryId: delivery.deliveryId,
				messages: preparation.messages,
			});
		}
		return deliveries;
	}

	private async beginActiveDelivery(delivery: AgentLoopDelivery): Promise<boolean> {
		const deliveryId = delivery.deliveryId;
		if (deliveryId === undefined) return true;
		const ownsLeasedDelivery = this.activeLease?.owns(deliveryId) === true;
		const deliveryKind = this.activeLease?.deliveries.find((candidate) => candidate.deliveryId === deliveryId)?.kind;
		const commit = this.preparedDeliveryCommits.get(deliveryId);
		if (!ownsLeasedDelivery) return true;
		const run = this.activeRun;
		const requestWasAccepted = run?.requestAccepted ?? false;
		if (run) {
			run.requestAccepted = true;
			run.deliveryCommitInProgress = true;
		}
		try {
			if (!(await this.activeLease?.begin(deliveryId, commit))) {
				if (run && this.activeRun === run) run.requestAccepted = requestWasAccepted;
				return false;
			}
			this.preparedDeliveryCommits.delete(deliveryId);
			return true;
		} catch (error) {
			if (deliveryKind !== undefined) {
				this.recordDeliveryFailure(
					{ deliveryId, kind: deliveryKind, messages: delivery.messages },
					"commit",
					error,
				);
			}
			if (run && this.activeRun === run) run.requestAccepted = requestWasAccepted;
			throw error;
		} finally {
			if (run && this.activeRun === run) run.deliveryCommitInProgress = false;
		}
	}

	private recordDeliveryFailure(delivery: AgentDelivery, phase: "prepare" | "commit", error: unknown): void {
		const run = this.activeRun;
		if (!run || run.deliveryFailure) return;
		run.deliveryFailure = Object.freeze({
			deliveryId: delivery.deliveryId,
			kind: delivery.kind,
			phase,
			error: error instanceof Error ? error : new Error(String(error)),
		});
	}

	private rollbackActiveLease(): void {
		this.inbox.rollbackActiveLease();
		this.activeLease = undefined;
		this.preparedDeliveryCommits.clear();
	}

	private createLoopConfig(startState: DispatcherStartState): AgentLoopConfig {
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			inferenceSpeed: this.inferenceSpeed,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			nextAction: async (context) => await this.resolveNextAction(context, startState),
			prepareDeliveries: async () => await this.prepareResolvedDeliveries(),
			beginDelivery: (delivery) => this.beginActiveDelivery(delivery),
			prepareRequest: async (context) => {
				const prepared = await this.prepareRequest?.(context, this.signal);
				return {
					context: prepared?.context ?? {
						...context.context,
						systemPrompt: this._state.systemPrompt,
						tools: this._state.tools.slice(),
					},
					model: prepared?.model ?? this._state.model,
					thinkingLevel: prepared?.thinkingLevel ?? this._state.thinkingLevel,
				};
			},
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<AgentRunResult> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = {
			id: globalThis.crypto.randomUUID(),
			promise,
			resolve: resolvePromise,
			abortController,
			turnOpen: false,
			requestAccepted: false,
			deliveryCommitInProgress: false,
			phase: "open",
		};

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		let deliveryFailure: AgentDeliveryFailure | undefined;
		try {
			await executor(abortController.signal);
		} catch (error) {
			this.rollbackActiveLease();
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.rollbackActiveLease();
			deliveryFailure = this.activeRun?.deliveryFailure;
			this.finishRun();
		}
		return deliveryFailure ? { status: "delivery_failed", failure: deliveryFailure } : { status: "completed" };
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		if (aborted && !this.activeRun?.requestAccepted) {
			await this.processEvents({ type: "agent_end", messages: [] });
			return;
		}
		if (!this.activeRun?.turnOpen) {
			await this.processEvents({ type: "turn_start" });
		}
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		const replacement = await this.processEvents({ type: "message_end", message: failureMessage });
		const finalizedMessage = replacement?.role === "assistant" ? replacement : failureMessage;
		await this.processEvents({ type: "turn_end", message: finalizedMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [finalizedMessage] });
	}

	private finishRun(): void {
		if (this.activeRun) this.activeRun.phase = "settled";
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.pendingToolExecutions = new Map<string, PendingToolExecution>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<AgentMessage | undefined> {
		switch (event.type) {
			case "delivery_start":
				if (this.activeRun) this.activeRun.requestAccepted = true;
				break;

			case "turn_start":
				if (this.activeRun) {
					this.activeRun.turnOpen = true;
					this.activeRun.requestAccepted = true;
				}
				break;

			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				if (this.activeRun && event.message.role === "assistant" && event.message.stopReason !== "toolUse") {
					this.activeRun.phase = "terminal_event_settling";
				}
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;

				const pendingToolExecutions = new Map(this._state.pendingToolExecutions);
				pendingToolExecutions.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				this._state.pendingToolExecutions = pendingToolExecutions;
				break;
			}

			case "tool_execution_update": {
				const existing = this._state.pendingToolExecutions.get(event.toolCallId);
				const details = (event.partialResult as { details?: unknown } | undefined)?.details;
				if (!existing || details === undefined) {
					break;
				}
				const pendingToolExecutions = new Map(this._state.pendingToolExecutions);
				pendingToolExecutions.set(event.toolCallId, { ...existing, latestDetails: details });
				this._state.pendingToolExecutions = pendingToolExecutions;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;

				const pendingToolExecutions = new Map(this._state.pendingToolExecutions);
				pendingToolExecutions.delete(event.toolCallId);
				this._state.pendingToolExecutions = pendingToolExecutions;
				break;
			}

			case "turn_end":
				if (this.activeRun) {
					this.activeRun.turnOpen = false;
					this.activeRun.phase = "open";
				}
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				if (this.activeRun) this.activeRun.phase = "settled";
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		let emittedEvent = this.decorateRuntimeAbort(event);
		for (const listener of this.listeners) {
			const replacement = await listener(emittedEvent, signal);
			if (emittedEvent.type === "message_end" && replacement) {
				if (replacement.role !== emittedEvent.message.role) {
					throw new Error("message_end listeners must return a message with the same role");
				}
				const previousEvent = emittedEvent;
				emittedEvent = this.decorateRuntimeAbort({ ...emittedEvent, message: replacement }, previousEvent);
			} else {
				// Cancellation can land while this listener is awaited. Make its
				// provenance visible to every later listener, even without replacement.
				emittedEvent = this.decorateRuntimeAbort(emittedEvent);
			}
		}

		if (emittedEvent.type === "message_end") {
			// An abort can be accepted while an awaited listener settles without
			// returning a replacement. Re-canonicalize at the persistence boundary.
			const finalizedEvent = this.decorateRuntimeAbort(emittedEvent);
			if (finalizedEvent.type !== "message_end") {
				throw new Error("Runtime abort decoration changed the event type");
			}
			this._state.messages.push(finalizedEvent.message);
			return finalizedEvent.message;
		}
		if (emittedEvent.type === "agent_end" && this.activeRun) {
			this.activeRun.phase = "settled";
		}
	}

	private decorateRuntimeAbort(event: AgentEvent, previousEvent?: AgentEvent): AgentEvent {
		if (event.type !== "message_end" || event.message.role !== "assistant") return event;
		const run = this.activeRun;
		const message = event.message as AssistantMessage;
		const previousOwnedDiagnostic =
			previousEvent?.type === "message_end" && previousEvent.message.role === "assistant"
				? previousEvent.message.diagnostics?.some(
						(diagnostic) =>
							diagnostic.type === "runtime_abort" &&
							diagnostic.timestamp === run?.diagnosticTimestamp &&
							diagnostic.details &&
							typeof diagnostic.details === "object" &&
							"source" in diagnostic.details &&
							diagnostic.details.source === run?.abortSource,
					)
				: false;
		if (
			(message.stopReason !== "aborted" && !previousOwnedDiagnostic && run?.phase !== "terminal_event_settling") ||
			!run?.abortController.signal.aborted ||
			run.abortSource === undefined ||
			run.diagnosticTimestamp === undefined
		) {
			return event;
		}
		return {
			...event,
			message: {
				...message,
				diagnostics: [
					...(message.diagnostics ?? []).filter((diagnostic) => diagnostic.type !== "runtime_abort"),
					{
						type: "runtime_abort",
						timestamp: run.diagnosticTimestamp,
						details: { source: run.abortSource },
					},
				],
			},
		};
	}
}
