import {
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
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentLoopRequestUpdate,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PendingToolExecution,
	PrepareRequestContext,
	QueueMode,
	ShouldStopAfterTurnContext,
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

/** Delivery class used by the Agent-owned inbox. */
export type AgentDeliveryKind = "prompt" | "steer" | "followUp";

/** Stable pending delivery passed to `prepareDelivery`. */
export interface AgentDelivery {
	/** Runtime inbox identity; never substitutes for an ID carried by a message. */
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
	readonly messages: readonly AgentMessage[];
}

/** Side-effect-free messages plus work committed only after delivery ownership transfers. */
export interface AgentDeliveryPreparation {
	messages: AgentMessage[];
	commit?: () => void;
}

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
	/** Temporary bridge while consumers migrate to `prepareRequest`. */
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Temporary bridge while queued consumers migrate to `prepareDelivery`. */
	prepareQueuedMessages?: (
		messages: AgentMessage[],
		delivery: "steer" | "followUp",
		signal?: AbortSignal,
	) => Promise<AgentMessage[]> | AgentMessage[];
	/** Temporary bridge while consumers migrate to `nextAction`. */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	/** Stage a leased inbox delivery before its irrevocable begin boundary. */
	prepareDelivery?: (
		delivery: AgentDelivery,
		signal?: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	/** Compose host policy into the dispatcher's single action at each request boundary. */
	nextAction?: (
		context: AgentLoopNextActionContext,
		signal?: AbortSignal,
	) => AgentLoopNextAction | Promise<AgentLoopNextAction>;
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
	providerRequestPending: boolean;
	pendingToolContinuation: boolean;
	drainFollowUpsFirst?: boolean;
};

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
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
	private readonly preparedDeliveryCommits = new Map<string, () => void>();
	private legacyQueuePreparationError?: unknown;
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;
	private pausedState?: Pick<DispatcherStartState, "providerRequestPending" | "pendingToolContinuation">;

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
	/** Temporary bridge while consumers migrate to `prepareRequest`. */
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Temporary bridge while queued consumers migrate to `prepareDelivery`. */
	public prepareQueuedMessages?: (
		messages: AgentMessage[],
		delivery: "steer" | "followUp",
		signal?: AbortSignal,
	) => Promise<AgentMessage[]> | AgentMessage[];
	/** Temporary bridge while consumers migrate to `nextAction`. */
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	/** Stage one dispatcher-owned delivery before it enters model context. */
	public prepareDelivery?: (
		delivery: AgentDelivery,
		signal?: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	/** Resolve a request, resumable pause, or terminal stop at each dispatcher boundary. */
	public nextAction?: (
		context: AgentLoopNextActionContext,
		signal?: AbortSignal,
	) => AgentLoopNextAction | Promise<AgentLoopNextAction>;
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
		this.prepareNextTurn = options.prepareNextTurn;
		this.prepareQueuedMessages = options.prepareQueuedMessages;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.prepareDelivery = options.prepareDelivery;
		this.nextAction = options.nextAction;
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

	/** Queue a delivery to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): string {
		return this.enqueueDelivery("steer", [message]);
	}

	/** Queue a delivery to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): string {
		return this.enqueueDelivery("followUp", [message]);
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

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
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
		this.preparedDeliveryCommits.clear();
		this.pausedState = undefined;
	}

	/** Start a new prompt through the same inbox dispatcher used by queued input. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
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
		this.legacyQueuePreparationError = undefined;
		this.enqueueDelivery("prompt", this.normalizePromptInput(input, images));
		await this.runDispatcher({
			firstDecision: true,
			providerRequestPending: false,
			pendingToolContinuation: false,
		});
		this.legacyQueuePreparationError = undefined;
	}

	/** Resume dispatcher state or a provider-ready transcript. */
	async continue(options: { drainFollowUps?: boolean } = {}): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage && !this.hasQueuedMessages()) {
			throw new Error("No messages to continue from");
		}
		const pausedState = this.pausedState;
		this.pausedState = undefined;
		this.legacyQueuePreparationError = undefined;
		const initialMessageCount = this._state.messages.length;
		const assistantTail = lastMessage?.role === "assistant";
		if (assistantTail && !this.hasQueuedMessages() && !this.nextAction) {
			throw new Error("Cannot continue from message role: assistant");
		}
		await this.runDispatcher({
			firstDecision: true,
			providerRequestPending: pausedState?.providerRequestPending ?? (lastMessage !== undefined && !assistantTail),
			pendingToolContinuation: pausedState?.pendingToolContinuation ?? false,
			drainFollowUpsFirst: options.drainFollowUps === true,
		});
		const preparationError = this.legacyQueuePreparationError;
		this.legacyQueuePreparationError = undefined;
		if (preparationError !== undefined) throw preparationError;
		if (assistantTail && this._state.messages.length === initialMessageCount) {
			throw new Error("Cannot continue from message role: assistant");
		}
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

	private async runDispatcher(startState: DispatcherStartState): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
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
		const pendingToolContinuation = isFirstDecision
			? startState.pendingToolContinuation
			: context.pendingToolContinuation;
		let selected: PendingDelivery[] = [];
		const immediate = this.selectPendingDeliveries("prompt", "all");
		if (immediate.length > 0) {
			selected = [...immediate, ...this.selectPendingDeliveries("steer", this.steeringQueueMode)];
		} else {
			selected = this.selectPendingDeliveries("steer", this.steeringQueueMode);
		}

		const providerRequestPending = isFirstDecision && startState.providerRequestPending;
		if (
			selected.length === 0 &&
			((isFirstDecision && startState.drainFollowUpsFirst) || (!pendingToolContinuation && !providerRequestPending))
		) {
			selected = this.selectPendingDeliveries("followUp", this.followUpQueueMode);
		}
		const hasIndependentContinuation = pendingToolContinuation || providerRequestPending;
		const suggestedAction: AgentLoopNextAction =
			selected.length > 0
				? { type: "request", reason: hasIndependentContinuation ? "continuation" : "delivery" }
				: hasIndependentContinuation
					? { type: "request", reason: "continuation" }
					: { type: "stop" };

		if (this.signal?.aborted) {
			this.pausedState = { providerRequestPending, pendingToolContinuation };
			return { type: "pause", pendingToolContinuation };
		}
		const hookContext: AgentLoopNextActionContext = {
			...context,
			pendingToolContinuation,
			defaultAction: suggestedAction,
		};
		if (
			context.completedTurn &&
			(await this.shouldStopAfterTurn?.(
				{
					...context.completedTurn,
					context: context.context,
					newMessages: context.newMessages,
				},
				this.signal,
			))
		) {
			return { type: "stop" };
		}
		const action = this.nextAction ? await this.nextAction(hookContext, this.signal) : suggestedAction;
		if (action.type === "pause") {
			this.pausedState = {
				providerRequestPending,
				pendingToolContinuation: action.pendingToolContinuation ?? pendingToolContinuation,
			};
			return {
				...action,
				pendingToolContinuation: action.pendingToolContinuation ?? pendingToolContinuation,
			};
		}
		if (action.type === "stop") {
			this.pausedState = undefined;
			return action;
		}

		this.pausedState = undefined;
		const leasedDeliveries = selected.length > 0 ? await this.prepareLeasedDeliveries(selected) : [];
		const deliveries = [...leasedDeliveries, ...(action.deliveries ?? [])];
		return {
			type: "request",
			reason: action.reason,
			...(deliveries.length > 0 ? { deliveries } : {}),
		};
	}

	private async prepareLeasedDeliveries(selected: PendingDelivery[]): Promise<AgentLoopDelivery[]> {
		const lease = this.inbox.lease(selected);
		this.activeLease = lease;
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			let preparation = this.prepareDelivery
				? await this.prepareDelivery(
						{
							deliveryId: delivery.deliveryId,
							kind: delivery.kind,
							messages: delivery.messages.slice(),
						},
						this.signal,
					)
				: { messages: delivery.messages.slice() };
			if (delivery.kind !== "prompt" && this.prepareQueuedMessages) {
				try {
					preparation = {
						...preparation,
						messages: await this.prepareQueuedMessages(preparation.messages, delivery.kind, this.signal),
					};
				} catch (error) {
					this.legacyQueuePreparationError = error;
					throw error;
				}
			}
			if (
				this.activeLease !== lease ||
				!lease.deliveries.some((candidate) => candidate.deliveryId === delivery.deliveryId)
			) {
				continue;
			}
			if (preparation.messages.length === 0) {
				throw new Error("prepareDelivery must retain at least one message for an admitted delivery");
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

	private beginActiveDelivery(delivery: AgentLoopDelivery): boolean {
		if (delivery.deliveryId === undefined) return true;
		if (!this.activeLease?.owns(delivery.deliveryId)) return true;
		const commit = this.preparedDeliveryCommits.get(delivery.deliveryId);
		if (!this.activeLease.begin(delivery.deliveryId, commit)) return false;
		this.preparedDeliveryCommits.delete(delivery.deliveryId);
		return true;
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
			beginDelivery: (delivery) => this.beginActiveDelivery(delivery),
			prepareRequest: async (context) => {
				const prepared = this.prepareRequest
					? await this.prepareRequest(context, this.signal)
					: context.completedTurn
						? await this.prepareNextTurn?.(this.signal)
						: undefined;
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

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			this.rollbackActiveLease();
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.rollbackActiveLease();
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
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
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
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
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		let emittedEvent = event;
		for (const listener of this.listeners) {
			const replacement = await listener(emittedEvent, signal);
			if (emittedEvent.type === "message_end" && replacement) {
				if (replacement.role !== emittedEvent.message.role) {
					throw new Error("message_end listeners must return a message with the same role");
				}
				emittedEvent = { ...emittedEvent, message: replacement };
			}
		}

		if (emittedEvent.type === "message_end") {
			this._state.messages.push(emittedEvent.message);
			return emittedEvent.message;
		}
	}
}
