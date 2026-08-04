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
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PendingToolExecution,
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
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareQueuedMessages?: (
		messages: AgentMessage[],
		delivery: "steer" | "followUp",
		signal?: AbortSignal,
	) => Promise<AgentMessage[]> | AgentMessage[];
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
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

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	private clearGeneration = 0;
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	async drainPrepared(
		prepare: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>,
	): Promise<AgentMessage[]> {
		const messages = this.mode === "all" ? this.messages.splice(0) : this.messages.splice(0, 1);
		if (messages.length === 0) {
			return messages;
		}
		const clearGeneration = this.clearGeneration;
		try {
			const prepared = await prepare(messages);
			return this.clearGeneration === clearGeneration ? prepared : [];
		} catch (error) {
			if (this.clearGeneration === clearGeneration) {
				this.messages.unshift(...messages);
			}
			throw error;
		}
	}

	clear(): void {
		this.messages = [];
		this.clearGeneration++;
	}
}

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
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

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
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** Prepare drained user queues immediately before their messages enter model context. */
	public prepareQueuedMessages?: (
		messages: AgentMessage[],
		delivery: "steer" | "followUp",
		signal?: AbortSignal,
	) => Promise<AgentMessage[]> | AgentMessage[];
	/**
	 * Asks the host whether the loop should stop gracefully after the current turn.
	 * See {@link AgentLoopConfig.shouldStopAfterTurn} for the loop contract.
	 */
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
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
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
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

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
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
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(options: { drainFollowUps?: boolean } = {}): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		const activeRun = this.reserveRun();
		try {
			const signal = activeRun.abortController.signal;
			const queuedSteering = await this.drainQueuedMessagesForDelivery(this.steeringQueue, "steer", signal);
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true }, activeRun);
				return;
			}

			if (lastMessage.role === "assistant" || options.drainFollowUps) {
				const queuedFollowUps = await this.drainQueuedMessagesForDelivery(this.followUpQueue, "followUp", signal);
				if (queuedFollowUps.length > 0) {
					await this.runPromptMessages(queuedFollowUps, {}, activeRun);
					return;
				}
			}

			if (lastMessage.role === "assistant") {
				throw new Error("Cannot continue from message role: assistant");
			}

			await this.runContinuation(activeRun);
		} catch (error) {
			this.finishRun(activeRun);
			throw error;
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

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
		activeRun?: ActiveRun,
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		}, activeRun);
	}

	private async runContinuation(activeRun?: ActiveRun): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		}, activeRun);
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private async drainQueuedMessagesForDelivery(
		queue: PendingMessageQueue,
		delivery: "steer" | "followUp",
		signal = this.signal,
	): Promise<AgentMessage[]> {
		return await queue.drainPrepared(async (messages) =>
			this.prepareQueuedMessages ? await this.prepareQueuedMessages(messages, delivery, signal) : messages,
		);
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
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
			prepareNextTurn: async ({ context }) => {
				const prepared = await this.prepareNextTurn?.(this.signal);
				return {
					context: prepared?.context ?? {
						...context,
						systemPrompt: this._state.systemPrompt,
						tools: this._state.tools.slice(),
					},
					model: prepared?.model ?? this._state.model,
					thinkingLevel: prepared?.thinkingLevel ?? this._state.thinkingLevel,
				};
			},
			shouldStopAfterTurn: async (context) => (await this.shouldStopAfterTurn?.(context, this.signal)) === true,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return await this.drainQueuedMessagesForDelivery(this.steeringQueue, "steer");
			},
			getFollowUpMessages: async () => await this.drainQueuedMessagesForDelivery(this.followUpQueue, "followUp"),
		};
	}

	private reserveRun(): ActiveRun {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		const activeRun = { promise, resolve: resolvePromise, abortController };
		this.activeRun = activeRun;
		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;
		return activeRun;
	}

	private releaseRun(activeRun: ActiveRun): void {
		if (this.activeRun !== activeRun) return;
		this.activeRun = undefined;
		activeRun.resolve();
	}

	private async runWithLifecycle(
		executor: (signal: AbortSignal) => Promise<void>,
		activeRun = this.reserveRun(),
	): Promise<void> {
		if (this.activeRun !== activeRun) {
			throw new Error("Agent run ownership was lost before execution.");
		}

		try {
			await executor(activeRun.abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, activeRun.abortController.signal.aborted);
		} finally {
			this.finishRun(activeRun);
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

	private finishRun(activeRun: ActiveRun): void {
		if (this.activeRun !== activeRun) return;
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.pendingToolExecutions = new Map<string, PendingToolExecution>();
		this.releaseRun(activeRun);
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
