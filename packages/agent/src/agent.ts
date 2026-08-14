import {
	type AssistantMessage,
	type ImageContent,
	type InferenceSpeed,
	type JsonValue,
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
	AgentDelivery,
	AgentDeliveryAttemptResult,
	AgentDeliveryFailure,
	AgentDeliveryKind,
	AgentDeliveryParticipantOutcome,
	AgentDeliveryPreparation,
	AgentDeliveryTransactionParticipant,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopDeliveryOutcome,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentLoopRequestUpdate,
	AgentMessage,
	AgentRequestAuthority,
	AgentRunResult,
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

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => structuredClone(message));
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
	streamingMessage: AgentMessage | undefined;
	pendingToolCalls: Set<string>;
	pendingToolExecutions: Map<string, PendingToolExecution>;
	errorMessage: string | undefined;
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
		set tools(nextTools: AgentTool<any, any>[]) {
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
	/** Stage a leased inbox delivery before its irrevocable begin boundary. */
	prepareDelivery?: (
		delivery: AgentDelivery,
		signal?: AbortSignal,
	) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation;
	/** Observe revocation so host projections can release delivery-coupled state. */
	deliveryRevoked?: (delivery: AgentDelivery) => void;
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
	requestAuthority: AgentRequestAuthority;
	providerRequestPending: boolean;
	drainFollowUpsFirst?: boolean;
};

type ActiveRun = {
	id: string;
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
	turnOpen: boolean;
	messages: AgentMessage[];
	abortSource?: AgentAbortSource;
	diagnosticTimestamp?: number;
	requestAccepted: boolean;
	deliverySettlement: Promise<void> | undefined;
	deliveryOrder: Map<string, number>;
	deliveryOutcomes: Map<string, AgentDeliveryAttemptResult>;
	deliveryFailure?: AgentDeliveryFailure;
	observationalDeliveryIds: Set<string>;
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
	private activeLease: DeliveryLease<AgentDeliveryKind, AgentMessage> | undefined;
	private readonly leasedDeliveryKinds = new Map<string, AgentDeliveryKind>();
	private readonly preparedDeliveryParticipants = new Map<string, AgentDeliveryTransactionParticipant>();
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;
	private pausedState: Pick<DispatcherStartState, "requestAuthority" | "providerRequestPending"> | undefined;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined;
	public streamFn: StreamFn;
	public getApiKey: ((provider: string) => Promise<string | undefined> | string | undefined) | undefined;
	public onPayload: SimpleStreamOptions["onPayload"] | undefined;
	public onResponse: SimpleStreamOptions["onResponse"] | undefined;
	public beforeToolCall:
		| ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>)
		| undefined;
	public afterToolCall:
		| ((context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>)
		| undefined;
	/** Stage one dispatcher-owned delivery before it enters model context. */
	public prepareDelivery:
		| ((
				delivery: AgentDelivery,
				signal?: AbortSignal,
		  ) => Promise<AgentDeliveryPreparation> | AgentDeliveryPreparation)
		| undefined;
	/** Observe delivery revocation without changing Agent-owned state. */
	public deliveryRevoked: ((delivery: AgentDelivery) => void) | undefined;
	/** Resolve a request, resumable pause, or terminal stop at each dispatcher boundary. */
	public nextAction:
		| ((
				context: AgentLoopNextActionContext,
				signal?: AbortSignal,
		  ) => AgentLoopNextAction | Promise<AgentLoopNextAction>)
		| undefined;
	/** Refresh runtime state immediately before an actual provider request. */
	public prepareRequest:
		| ((
				context: PrepareRequestContext,
				signal?: AbortSignal,
		  ) => Promise<AgentLoopRequestUpdate | undefined> | AgentLoopRequestUpdate | undefined)
		| undefined;
	private activeRun: ActiveRun | undefined;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId: string | undefined;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets: ThinkingBudgets | undefined;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Provider-neutral inference speed preference forwarded to primary model turns. */
	public inferenceSpeed: InferenceSpeed | undefined;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs: number | undefined;
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
		this.deliveryRevoked = options.deliveryRevoked;
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

	/** Returns true when an initial prompt is retained for explicit retry. */
	hasPendingPrompt(): boolean {
		return this.inbox.hasPending("prompt");
	}

	/** Returns true while a delivery being prepared remains revocable and current. */
	canPrepareDelivery(deliveryId: string): boolean {
		return this.activeLease?.canPrepare(deliveryId) ?? false;
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

	/** Settlement boundary for the active delivery participant, if one is running. */
	get activeDeliverySettlement(): Promise<void> | undefined {
		return this.activeRun?.deliverySettlement;
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
		if (this.activeRun) {
			throw new Error("Cannot reset Agent while a run is active; abort it and wait for idle first");
		}
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.pendingToolExecutions = new Map<string, PendingToolExecution>();
		this._state.errorMessage = undefined;
		this.inbox.reset();
		this.activeLease = undefined;
		this.leasedDeliveryKinds.clear();
		this.preparedDeliveryParticipants.clear();
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
			return { status: "completed", deliveries: [] };
		}
		return await this.runDispatcher({
			firstDecision: true,
			requestAuthority: pausedState?.requestAuthority ?? "provider",
			providerRequestPending:
				pausedState?.providerRequestPending ?? (lastMessage !== undefined && lastMessage.role !== "assistant"),
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
		return this.inbox.enqueue(kind, cloneAgentMessages(messages)).deliveryId;
	}

	private clearDeliveries(kind: AgentDeliveryKind): string[] {
		const revoked = this.inbox.revoke(kind);
		for (const delivery of revoked) {
			this.recordDeliveryOutcome({
				deliveryId: delivery.deliveryId,
				kind: delivery.kind,
				outcome: "revoked",
			});
			this.preparedDeliveryParticipants.delete(delivery.deliveryId);
			try {
				this.deliveryRevoked?.({
					deliveryId: delivery.deliveryId,
					kind: delivery.kind,
					messages: cloneAgentMessages(delivery.messages),
				});
			} catch {
				// Revocation is authoritative; observational host cleanup cannot undo it.
			}
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
		const runtimeAction = context.defaultAction;
		const providerRequestPending = isFirstDecision
			? startState.providerRequestPending
			: runtimeAction.type === "request";

		if (this.signal?.aborted) {
			this.pausedState = { requestAuthority, providerRequestPending };
			return { type: "pause", requestAuthority };
		}

		if (requestAuthority === "final_response") {
			const hookContext = { ...context, requestAuthority, defaultAction: runtimeAction };
			const action = this.nextAction ? await this.nextAction(hookContext, this.signal) : runtimeAction;
			if (action.type === "pause") {
				this.pausedState = { requestAuthority, providerRequestPending };
				return { ...action, requestAuthority };
			}
			// Keep final-response authority until the completed response reaches the
			// next dispatcher boundary. A host retry or compaction continuation starts
			// a fresh core run before that boundary when this request fails.
			this.pausedState = { requestAuthority, providerRequestPending: true };
			return { type: "request", reason: "final_response" };
		}

		let selected: PendingDelivery[] = [];
		const immediate = this.selectPendingDeliveries("prompt", "all");
		if (immediate.length > 0) {
			selected = [...immediate, ...this.selectPendingDeliveries("steer", this.steeringQueueMode)];
		} else {
			selected = this.selectPendingDeliveries("steer", this.steeringQueueMode);
		}
		const hasIndependentRequest = runtimeAction.type === "request" && providerRequestPending;
		if (selected.length === 0 && ((isFirstDecision && startState.drainFollowUpsFirst) || !hasIndependentRequest)) {
			selected = this.selectPendingDeliveries("followUp", this.followUpQueueMode);
		}
		const suggestedAction: AgentLoopNextAction =
			selected.length > 0
				? { type: "request", reason: hasIndependentRequest ? "continuation" : "delivery" }
				: hasIndependentRequest
					? runtimeAction
					: { type: "stop" };
		const hookContext = { ...context, requestAuthority, defaultAction: suggestedAction };
		const action = this.nextAction ? await this.nextAction(hookContext, this.signal) : suggestedAction;
		if (action.type === "pause") {
			this.pausedState = {
				requestAuthority: action.requestAuthority ?? requestAuthority,
				providerRequestPending: hasIndependentRequest,
			};
			return { ...action, requestAuthority: action.requestAuthority ?? requestAuthority };
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
		for (const delivery of selected) {
			this.leasedDeliveryKinds.set(delivery.deliveryId, delivery.kind);
			const run = this.activeRun;
			if (run && !run.deliveryOrder.has(delivery.deliveryId)) {
				run.deliveryOrder.set(delivery.deliveryId, run.deliveryOrder.size);
			}
		}
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			if (!lease.canPrepare(delivery.deliveryId)) continue;
			let preparation: AgentDeliveryPreparation;
			try {
				preparation = this.prepareDelivery
					? await this.prepareDelivery(
							{
								deliveryId: delivery.deliveryId,
								kind: delivery.kind,
								messages: cloneAgentMessages(delivery.messages),
							},
							this.signal,
						)
					: { messages: cloneAgentMessages(delivery.messages) };
			} catch (error) {
				if (!lease.canPrepare(delivery.deliveryId)) continue;
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (this.activeLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
			if (preparation.messages.length === 0) {
				const error = new Error("prepareDelivery must retain at least one message for an admitted delivery");
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (preparation.participant) {
				this.preparedDeliveryParticipants.set(delivery.deliveryId, preparation.participant);
			}
			deliveries.push({
				deliveryId: delivery.deliveryId,
				// Participant settlement cannot mutate the prepared provider payload.
				messages: cloneAgentMessages(preparation.messages),
			});
		}
		return deliveries;
	}

	private async beginActiveDelivery(delivery: AgentLoopDelivery): Promise<AgentLoopDeliveryOutcome> {
		if (delivery.deliveryId === undefined) return { outcome: "committed" };
		const kind = this.leasedDeliveryKinds.get(delivery.deliveryId);
		if (kind === undefined) return { outcome: "committed" };
		const lease = this.activeLease;
		if (!lease?.owns(delivery.deliveryId) || !lease.begin(delivery.deliveryId)) {
			this.recordDeliveryOutcome({ deliveryId: delivery.deliveryId, kind, outcome: "revoked" });
			return { outcome: "revoked" };
		}

		const run = this.activeRun;
		if (run) run.requestAccepted = true;
		let settleDeliveryParticipant = (): void => undefined;
		const settlement = new Promise<void>((resolve) => {
			settleDeliveryParticipant = resolve;
		});
		if (run) run.deliverySettlement = settlement;

		let outcome: AgentDeliveryParticipantOutcome;
		const participant = this.preparedDeliveryParticipants.get(delivery.deliveryId);
		try {
			if (participant) {
				try {
					outcome = await participant.settle({ requestAbort: (source) => this.abort(source) });
				} catch (error) {
					outcome = { outcome: "terminally_failed", error: toError(error) };
				}
			} else {
				outcome = { outcome: "committed" };
			}

			if (!lease.settle(delivery.deliveryId, outcome.outcome)) {
				outcome = {
					outcome: "terminally_failed",
					error: new Error(`Delivery settlement lost Agent ownership: ${delivery.deliveryId}`),
				};
			}
			const result =
				outcome.outcome === "committed"
					? ({ deliveryId: delivery.deliveryId, kind, outcome: "committed" } as const)
					: ({
							deliveryId: delivery.deliveryId,
							kind,
							outcome: outcome.outcome,
							phase: "settlement",
							error: outcome.error,
						} satisfies AgentDeliveryFailure);
			this.recordDeliveryOutcome(result);
			if (outcome.outcome === "retained" && run?.messages.length === 0) {
				run.requestAccepted = false;
			}
			if (outcome.outcome === "committed") {
				run?.observationalDeliveryIds.add(delivery.deliveryId);
			}
			return outcome;
		} finally {
			this.preparedDeliveryParticipants.delete(delivery.deliveryId);
			settleDeliveryParticipant();
			if (run && this.activeRun === run && run.deliverySettlement === settlement) {
				run.deliverySettlement = undefined;
			}
		}
	}

	private recordDeliveryFailure(
		delivery: Pick<PendingDelivery, "deliveryId" | "kind">,
		phase: AgentDeliveryFailure["phase"],
		outcome: AgentDeliveryFailure["outcome"],
		error: unknown,
	): void {
		this.recordDeliveryOutcome({
			deliveryId: delivery.deliveryId,
			kind: delivery.kind,
			outcome,
			phase,
			error: toError(error),
		} as AgentDeliveryFailure);
	}

	private recordDeliveryOutcome(outcome: AgentDeliveryAttemptResult): void {
		const run = this.activeRun;
		if (!run || run.deliveryOutcomes.has(outcome.deliveryId)) return;
		run.deliveryOutcomes.set(outcome.deliveryId, Object.freeze(outcome));
		if ("error" in outcome && run.deliveryFailure === undefined) {
			run.deliveryFailure = outcome;
		}
	}

	private rollbackActiveLease(): void {
		const restored = this.inbox.rollbackActiveLease();
		for (const delivery of restored) {
			this.recordDeliveryOutcome({
				deliveryId: delivery.deliveryId,
				kind: delivery.kind,
				outcome: "retained",
			});
		}
		this.activeLease = undefined;
		this.preparedDeliveryParticipants.clear();
	}

	private createLoopConfig(startState: DispatcherStartState): AgentLoopConfig {
		return {
			model: this._state.model,
			...(this._state.thinkingLevel === "off" ? {} : { reasoning: this._state.thinkingLevel }),
			...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
			...(this.onPayload === undefined ? {} : { onPayload: this.onPayload }),
			...(this.onResponse === undefined ? {} : { onResponse: this.onResponse }),
			transport: this.transport,
			...(this.inferenceSpeed === undefined ? {} : { inferenceSpeed: this.inferenceSpeed }),
			...(this.thinkingBudgets === undefined ? {} : { thinkingBudgets: this.thinkingBudgets }),
			...(this.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.maxRetryDelayMs }),
			toolExecution: this.toolExecution,
			...(this.beforeToolCall === undefined ? {} : { beforeToolCall: this.beforeToolCall }),
			...(this.afterToolCall === undefined ? {} : { afterToolCall: this.afterToolCall }),
			nextAction: async (context) => await this.resolveNextAction(context, startState),
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
			...(this.transformContext === undefined ? {} : { transformContext: this.transformContext }),
			...(this.getApiKey === undefined ? {} : { getApiKey: this.getApiKey }),
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
			messages: [],
			requestAccepted: false,
			deliveryOrder: new Map(),
			deliveryOutcomes: new Map(),
			observationalDeliveryIds: new Set(),
			deliverySettlement: undefined,
			phase: "open",
		};

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		let deliveries: readonly AgentDeliveryAttemptResult[] = [];
		let deliveryFailure: AgentDeliveryFailure | undefined;
		try {
			await executor(abortController.signal);
		} catch (error) {
			this.rollbackActiveLease();
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.rollbackActiveLease();
			const run = this.activeRun;
			deliveries = Object.freeze(
				[...(run?.deliveryOutcomes.values() ?? [])].sort(
					(left, right) =>
						(run?.deliveryOrder.get(left.deliveryId) ?? Number.MAX_SAFE_INTEGER) -
						(run?.deliveryOrder.get(right.deliveryId) ?? Number.MAX_SAFE_INTEGER),
				),
			);
			deliveryFailure = this.activeRun?.deliveryFailure;
			this.leasedDeliveryKinds.clear();
			this.finishRun();
		}
		return deliveryFailure
			? { status: "delivery_failed", deliveries, failure: deliveryFailure }
			: { status: "completed", deliveries };
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const run = this.activeRun;
		const hasCommittedDelivery = [...(run?.deliveryOutcomes.values() ?? [])].some(
			(outcome) => outcome.outcome === "committed",
		);
		const retainedBeforeAnyCommit = run?.deliveryFailure?.outcome === "retained" && !hasCommittedDelivery;
		if (aborted && (!run?.requestAccepted || retainedBeforeAnyCommit)) {
			await this.processEvents({ type: "agent_end", messages: run?.messages.slice() ?? [] });
			return;
		}
		if (!this.activeRun?.turnOpen) {
			await this.processEvents({ type: "turn_start" });
		}
		const deliveryFailure = this.activeRun?.deliveryFailure;
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			...(deliveryFailure
				? {
						diagnostics: [
							{
								type: "delivery_transaction_failure",
								timestamp: Date.now(),
								error: { name: deliveryFailure.error.name, message: deliveryFailure.error.message },
								details: {
									deliveryId: deliveryFailure.deliveryId,
									kind: deliveryFailure.kind,
									outcome: deliveryFailure.outcome,
									phase: deliveryFailure.phase,
								},
							},
						],
					}
				: {}),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		const replacement = await this.processEvents({ type: "message_end", message: failureMessage });
		const finalizedMessage = replacement?.role === "assistant" ? replacement : failureMessage;
		await this.processEvents({ type: "turn_end", message: finalizedMessage, toolResults: [] });
		await this.processEvents({
			type: "agent_end",
			messages: this.activeRun?.messages.slice() ?? [finalizedMessage],
		});
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
				pendingToolExecutions.set(event.toolCallId, { ...existing, latestDetails: details as JsonValue });
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
		if (event.type === "agent_end") {
			for (const listener of this.listeners) {
				try {
					await listener(structuredClone(event), signal);
				} catch {
					// Terminal publication is observational and cannot alter run settlement.
				}
			}
			return undefined;
		}
		const isObservationalDeliveryProjection =
			(event.type === "delivery_start" || event.type === "message_start" || event.type === "message_end") &&
			event.deliveryId !== undefined &&
			this.activeRun?.observationalDeliveryIds.has(event.deliveryId) === true;
		if (isObservationalDeliveryProjection) {
			for (const listener of this.listeners) {
				try {
					await listener(structuredClone(event), signal);
				} catch {
					// Committed delivery publication is observational and cannot alter settlement.
				}
			}
			if (event.type === "message_end") {
				this._state.messages.push(event.message);
				this.activeRun?.messages.push(event.message);
				return event.message;
			}
			return undefined;
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
			this.activeRun?.messages.push(finalizedEvent.message);
			return finalizedEvent.message;
		}
		if (emittedEvent.type === "agent_end" && this.activeRun) {
			this.activeRun.phase = "settled";
		}
		return undefined;
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
							diagnostic.details["source"] === run?.abortSource,
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
