import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	JsonObject,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@hansjm10/volt-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `disposition`: if provided, replaces the tool-result disposition
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: JsonValue;
	isError?: boolean;
	disposition?: AgentToolDisposition;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated JSON tool arguments for the target tool schema. */
	args: JsonObject;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: JsonObject;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<unknown>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Known local authority that interrupted an active run. */
export type AgentAbortSource =
	| "keyboard_interrupt"
	| "host_action"
	| "remote_request"
	| "session_replacement"
	| "disposal";

/** Immutable result of an abort request. */
export interface AgentAbortAcceptance {
	readonly runId: string | undefined;
	readonly accepted: boolean;
	readonly source: AgentAbortSource | undefined;
}

/** Minimum immutable lifecycle state exposed for structural teardown. */
export interface AgentRunSnapshot {
	readonly runId: string;
	readonly source: AgentAbortSource | undefined;
	readonly diagnosticTimestamp: number | undefined;
	readonly requestAccepted: boolean;
	readonly phase: "open" | "terminal_event_settling" | "settled";
}

/** Delivery class used by the stateful orchestrator's inbox. */
export type AgentDeliveryKind = "prompt" | "steer" | "followUp";

/** Stable pending delivery passed to `prepareDelivery`. */
export interface AgentDelivery {
	/** Runtime inbox identity; never substitutes for an ID carried by a message. */
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
	readonly messages: readonly AgentMessage[];
}

/** Result returned by a host participant after the orchestrator crosses the revocation cutoff. */
export type AgentDeliveryParticipantOutcome =
	| { readonly outcome: "committed" }
	| { readonly outcome: "retained"; readonly error: Error }
	| { readonly outcome: "terminally_failed"; readonly error: Error };

/** Reentrant-safe lifecycle capability available only while participant work settles. */
export interface AgentDeliveryTransactionContext {
	/** Record abort intent without awaiting the orchestrator run that invoked this participant. */
	requestAbort(source?: AgentAbortSource): AgentAbortAcceptance;
}

/** Host durability work attached to one orchestrator-owned delivery attempt. */
export interface AgentDeliveryTransactionParticipant {
	/**
	 * Settle the orchestrator's commit decision exactly once.
	 *
	 * Throwing or rejecting is classified as `terminally_failed`; safe replay
	 * requires an explicit `retained` result.
	 */
	settle(
		context: AgentDeliveryTransactionContext,
	): AgentDeliveryParticipantOutcome | Promise<AgentDeliveryParticipantOutcome>;
}

/** Side-effect-free messages plus work settled only after delivery ownership transfers. */
export interface AgentDeliveryPreparation {
	messages: AgentMessage[];
	participant?: AgentDeliveryTransactionParticipant;
}

interface AgentDeliveryAttemptBase {
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
}

export type AgentDeliveryFailure = AgentDeliveryAttemptBase &
	(
		| { readonly outcome: "retained"; readonly phase: "preparation" | "settlement"; readonly error: Error }
		| { readonly outcome: "terminally_failed"; readonly phase: "settlement"; readonly error: Error }
	);

/** Explicit terminal result for one orchestrator-owned delivery attempt. */
export type AgentDeliveryAttemptResult =
	| (AgentDeliveryAttemptBase & { readonly outcome: "committed" | "revoked" })
	| (AgentDeliveryAttemptBase & { readonly outcome: "retained" })
	| AgentDeliveryFailure;

/** Explicit outcome of one bounded orchestrator run. */
export type AgentRunResult =
	| { readonly status: "completed"; readonly deliveries: readonly AgentDeliveryAttemptResult[] }
	| {
			readonly status: "delivery_failed";
			readonly deliveries: readonly AgentDeliveryAttemptResult[];
			readonly failure: AgentDeliveryFailure;
	  };

/** Disposition requested by a finalized tool result. */
export type AgentToolDisposition = "stop" | "final_response";

/** Reduced disposition for a complete tool-call batch. */
export type ToolBatchDisposition = "continue" | AgentToolDisposition;

/** A completed successful turn available to the next-action dispatcher. */
export interface AgentLoopCompletedTurn {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Canonical disposition reduced from every finalized result in the batch. */
	disposition: ToolBatchDisposition;
}

/** One stable delivery whose messages enter context together before a request. */
export interface AgentLoopDelivery {
	/** Runtime identity propagated on the delivery lifecycle and message events. */
	deliveryId?: string;
	/** Ordered messages contributed by this delivery. */
	messages: AgentMessage[];
}

/** Explicit result of the orchestrator-owned commit decision for one delivery attempt. */
export type AgentLoopDeliveryOutcome =
	| { readonly outcome: "committed" }
	| { readonly outcome: "retained"; readonly error: Error }
	| { readonly outcome: "revoked" }
	| { readonly outcome: "terminally_failed"; readonly error: Error };

/** Authority that keeps a request valid when no attached delivery is admitted. */
export type AgentLoopRequestReason = "delivery" | "continuation" | "final_response";

/** The dispatcher's explicit decision at a request boundary. */
export type AgentLoopNextAction =
	| {
			type: "request";
			/** Delivery-dependent requests stop when every attached delivery is revoked. */
			reason: AgentLoopRequestReason;
			deliveries?: AgentLoopDelivery[];
	  }
	| {
			type: "pause";
			/** Request authority retained when a higher-level dispatcher resumes. */
			requestAuthority?: AgentRequestAuthority;
	  }
	| { type: "stop" };

/** Authority for a provider request at the current dispatch boundary. */
export type AgentRequestAuthority = "provider" | "tool_continuation" | "final_response";

/** Context passed whenever the loop resolves its next action. */
export interface AgentLoopNextActionContext {
	/** Current context before any messages from the next action are delivered. */
	context: AgentContext;
	/** Messages produced by this loop invocation so far. */
	newMessages: AgentMessage[];
	/** The successful turn that just ended. Undefined before the first request. */
	completedTurn?: AgentLoopCompletedTurn;
	/** Authority currently permitting a provider request. */
	requestAuthority: AgentRequestAuthority;
	/** The loop's request-or-stop decision when no host dispatcher overrides it. */
	defaultAction: AgentLoopNextAction;
}

/** Context passed immediately before a provider request. */
export interface PrepareRequestContext extends AgentLoopNextActionContext {
	/** Resolved reason for the imminent provider request. */
	reason: AgentLoopRequestReason;
	/** Deliveries already finalized, emitted, and appended to `context`. */
	deliveries: AgentLoopDelivery[];
}

/** Replacement runtime state for an imminent provider request. */
export interface AgentLoopRequestUpdate {
	/** Context for the provider request. */
	context?: AgentContext;
	/** Model for the provider request. */
	model?: Model<any>;
	/** Thinking level for the provider request. */
	thinkingLevel?: ThinkingLevel;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Resolve the action before the first request and once after every successful `turn_end`.
	 *
	 * Returning `request` may attach deliveries that are emitted into context before
	 * request preparation. `pause` ends this invocation while retaining continuation
	 * intent for a higher-level dispatcher. `stop` ends it terminally.
	 */
	nextAction?: (context: AgentLoopNextActionContext) => AgentLoopNextAction | Promise<AgentLoopNextAction>;

	/**
	 * Cross the orchestrator-owned revocation cutoff and settle one delivery attempt.
	 *
	 * The hook may await host durability. `committed` publishes the delivery,
	 * `revoked` skips it, and retained or terminal failure stops the current run.
	 * Queue ownership remains with the orchestrator throughout settlement.
	 */
	beginDelivery?: (delivery: AgentLoopDelivery) => AgentLoopDeliveryOutcome | Promise<AgentLoopDeliveryOutcome>;

	/**
	 * Prepare runtime state for an imminent provider request.
	 *
	 * This runs only for a resolved `request`, after all attached deliveries are
	 * finalized and emitted into context, and immediately before context conversion
	 * and provider invocation. It never runs for `pause` or `stop`.
	 */
	prepareRequest?: (
		context: PrepareRequestContext,
	) => AgentLoopRequestUpdate | undefined | Promise<AgentLoopRequestUpdate | undefined>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `disposition` replaces the tool-result disposition
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model thinking-level
 * metadata from @hansjm10/volt-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@hansjm10/volt-agent-core" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** Tool call currently being executed by the runtime. */
export interface PendingToolExecution {
	toolCallId: string;
	toolName: string;
	args: JsonObject;
	/** JSON details from the newest tool_execution_update, when the tool reported any. */
	latestDetails?: JsonValue;
}

/**
 * Public state projection shared by stateful agent runtimes.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any, any>[]);
	get tools(): AgentTool<any, any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the runtime is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage: AgentMessage | undefined;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Tool calls currently executing, keyed by tool call id. */
	readonly pendingToolExecutions: ReadonlyMap<string, PendingToolExecution>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage: string | undefined;
}

/** Final or partial result produced by a tool. */
export type AgentToolResult<T = unknown> = {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Marks a resolved final result as failed while preserving its structured content and details. */
	isError?: boolean;
	/** Controls whether the batch stops or performs one bounded tool-free response. */
	disposition?: AgentToolDisposition;
} & ([T] extends [never]
	? { details?: never }
	: [unknown] extends [T]
		? { /** Optional details for a dynamically typed tool. */ details?: T }
		: [undefined] extends [T]
			? { /** Details may be omitted by this tool. */ details?: Exclude<T, undefined> }
			: { /** Concrete details guaranteed by this tool. */ details: T });

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = unknown> = {
	bivarianceHack(partialResult: AgentToolResult<T>): void;
}["bivarianceHack"];

/** Tool definition used by an agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?(args: unknown): Static<TParameters>;
	/** Execute the tool call. Throw on unstructured failure, or return `isError: true` to preserve structured failure details. */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	): Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any, any>[];
}

/**
 * Events emitted by the low-level loop and stateful orchestrators for UI updates.
 *
 * `agent_end` is the last low-level event emitted for a run. Stateful
 * orchestrators may include awaited terminal listeners in their idle barrier.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Delivery lifecycle - ownership is irrevocable before this event is emitted
	| { type: "delivery_start"; deliveryId?: string; messages: AgentMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage; deliveryId?: string }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage; deliveryId?: string }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: JsonObject;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
	  };
