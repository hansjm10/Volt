import {
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	createAssistantMessageEventStream,
	estimateToolDefinitionTokens,
	type ImageContent,
	type JsonValue,
	type Model,
	streamSimple,
	type UserMessage,
} from "@hansjm10/volt-ai";
import { runAgentLoop } from "../agent-loop.ts";
import { DeliveryInbox, type DeliveryLease, type InboxDelivery } from "../delivery-inbox.ts";
import type {
	AgentAbortAcceptance,
	AgentAbortSource,
	AgentContext,
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
	AgentMessage,
	AgentRequestAuthority,
	AgentRunResult,
	AgentRunSnapshot,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { AgentDeliveryPreparationReplayMismatchError } from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateMessagesTokens,
	prepareCompaction,
} from "./compaction/compaction.ts";
import { createCustomMessage, convertToLlm as defaultConvertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import type {
	AgentHarnessContextProjectionToken,
	AgentHarnessContextRebaseOptions,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessNextActionPolicy,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessPromptOptions,
	AgentHarnessResources,
	AgentHarnessRunOptions,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
	SessionTreeEntry,
	Skill,
} from "./types.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError, toError } from "./types.ts";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
	if (images) content.push(...images);
	return { role: "user", content, timestamp: Date.now() };
}

function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => structuredClone(message));
}

function cloneRunOptions(options: AgentHarnessRunOptions): AgentHarnessRunOptions {
	return {
		...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
		...(options.context === undefined ? {} : { context: cloneAgentMessages(options.context) }),
	};
}

function clonePromptOptions(options: AgentHarnessPromptOptions | undefined): AgentHarnessPromptOptions | undefined {
	if (options === undefined) return undefined;
	return {
		...cloneRunOptions(options),
		...(options.images === undefined ? {} : { images: structuredClone(options.images) }),
	};
}

function cloneNextAction(action: AgentLoopNextAction): AgentLoopNextAction {
	if (action.type === "stop") return { type: "stop" };
	if (action.type === "pause") {
		return {
			type: "pause",
			...(action.requestAuthority === undefined ? {} : { requestAuthority: action.requestAuthority }),
		};
	}
	return {
		type: "request",
		reason: action.reason,
		...(action.deliveries === undefined
			? {}
			: {
					deliveries: action.deliveries.map((delivery) => ({
						...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
						messages: cloneAgentMessages(delivery.messages),
					})),
				}),
	};
}

function cloneNextActionContext(
	context: AgentLoopNextActionContext,
	defaultAction: AgentLoopNextAction,
): AgentLoopNextActionContext {
	return {
		context: {
			systemPrompt: context.context.systemPrompt,
			messages: cloneAgentMessages(context.context.messages),
			...(context.context.tools === undefined ? {} : { tools: [...context.context.tools] }),
		},
		newMessages: cloneAgentMessages(context.newMessages),
		...(context.completedTurn === undefined
			? {}
			: {
					completedTurn: {
						message: structuredClone(context.completedTurn.message),
						toolResults: context.completedTurn.toolResults.map((message) => structuredClone(message)),
						disposition: context.completedTurn.disposition,
					},
				}),
		requestAuthority: context.requestAuthority,
		defaultAction: cloneNextAction(defaultAction),
	};
}

function areStructurallyEqual(
	left: unknown,
	right: unknown,
	leftSeen = new WeakMap<object, object>(),
	rightSeen = new WeakMap<object, object>(),
): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
	const priorRight = leftSeen.get(left);
	const priorLeft = rightSeen.get(right);
	if (priorRight !== undefined || priorLeft !== undefined) return priorRight === right && priorLeft === left;
	leftSeen.set(left, right);
	rightSeen.set(right, left);
	if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => areStructurallyEqual(value, right[index], leftSeen, rightSeen));
	}
	const prototype = Object.getPrototypeOf(left);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	const rightRecord = right as Record<string, unknown>;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			areStructurallyEqual((left as Record<string, unknown>)[key], rightRecord[key], leftSeen, rightSeen),
	);
}

function createFailureMessage(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createAbortedAssistantStream(model: Model<any>) {
	const stream = createAssistantMessageEventStream();
	const message = createFailureMessage(model, new Error("Request was aborted"), true);
	stream.push({ type: "error", seq: 0, reason: "aborted", error: message });
	return stream;
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		...(streamOptions?.headers ? { headers: { ...streamOptions.headers } } : {}),
		...(streamOptions?.metadata ? { metadata: { ...streamOptions.metadata } } : {}),
		...(streamOptions?.env ? { env: { ...streamOptions.env } } : {}),
		...(streamOptions?.thinkingBudgets ? { thinkingBudgets: { ...streamOptions.thinkingBudgets } } : {}),
	};
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	let hasHeaders = false;
	for (const entry of headers) {
		if (!entry) continue;
		Object.assign(merged, entry);
		hasHeaders = true;
	}
	return hasHeaders ? merged : undefined;
}

function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;

	if (Object.hasOwn(patch, "transport")) {
		if (patch.transport === undefined) delete result.transport;
		else result.transport = patch.transport;
	}
	if (Object.hasOwn(patch, "timeoutMs")) {
		if (patch.timeoutMs === undefined) delete result.timeoutMs;
		else result.timeoutMs = patch.timeoutMs;
	}
	if (Object.hasOwn(patch, "websocketConnectTimeoutMs")) {
		if (patch.websocketConnectTimeoutMs === undefined) delete result.websocketConnectTimeoutMs;
		else result.websocketConnectTimeoutMs = patch.websocketConnectTimeoutMs;
	}
	if (Object.hasOwn(patch, "maxRetries")) {
		if (patch.maxRetries === undefined) delete result.maxRetries;
		else result.maxRetries = patch.maxRetries;
	}
	if (Object.hasOwn(patch, "maxRetryDelayMs")) {
		if (patch.maxRetryDelayMs === undefined) delete result.maxRetryDelayMs;
		else result.maxRetryDelayMs = patch.maxRetryDelayMs;
	}
	if (Object.hasOwn(patch, "inferenceSpeed")) {
		if (patch.inferenceSpeed === undefined) delete result.inferenceSpeed;
		else result.inferenceSpeed = patch.inferenceSpeed;
	}
	if (Object.hasOwn(patch, "thinkingBudgets")) {
		if (patch.thinkingBudgets === undefined) delete result.thinkingBudgets;
		else result.thinkingBudgets = { ...patch.thinkingBudgets };
	}
	if (Object.hasOwn(patch, "cacheRetention")) {
		if (patch.cacheRetention === undefined) delete result.cacheRetention;
		else result.cacheRetention = patch.cacheRetention;
	}

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			delete result.headers;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			if (Object.keys(headers).length > 0) result.headers = headers;
			else delete result.headers;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			delete result.metadata;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			if (Object.keys(metadata).length > 0) result.metadata = metadata;
			else delete result.metadata;
		}
	}

	if (Object.hasOwn(patch, "env")) {
		if (patch.env === undefined) {
			delete result.env;
		} else {
			const env = { ...(result.env ?? {}) };
			for (const [key, value] of Object.entries(patch.env)) {
				if (value === undefined) delete env[key];
				else env[key] = value;
			}
			if (Object.keys(env).length > 0) result.env = env;
			else delete result.env;
		}
	}

	return result;
}

const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

function normalizeHarnessError(error: unknown, fallbackCode: AgentHarnessError["code"]): AgentHarnessError {
	if (error instanceof AgentHarnessError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentHarnessError("session", cause.message, cause);
	if (cause instanceof CompactionError) return new AgentHarnessError("compaction", cause.message, cause);
	if (cause instanceof BranchSummaryError) return new AgentHarnessError("branch_summary", cause.message, cause);
	return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
	return normalizeHarnessError(error, "hook");
}

function combineEventErrors(errors: readonly Error[], message: string): Error {
	return errors.length === 1 ? errors[0]! : new AggregateError(errors, message);
}

function createFailureSettlementError(runError: unknown, settlementError: unknown): AgentHarnessError {
	const cause = new AggregateError(
		[toError(runError), toError(settlementError)],
		"Harness run failed and failure reporting failed",
	);
	return new AgentHarnessError("unknown", cause.message, cause);
}

interface AgentHarnessDeliveryEventState {
	remainingMessages: Set<AgentMessage>;
}

interface AgentHarnessContinuationState {
	requestAuthority: AgentRequestAuthority;
	providerRequestPending: boolean;
	systemPrompt?: string;
}

interface AgentHarnessContextProjection {
	token: AgentHarnessContextProjectionToken;
	anchorLeafId: string | null;
	messages: AgentMessage[];
	invalidError?: AgentHarnessError;
}

interface AgentHarnessDeliveryPreparationState {
	admittedMessages?: AgentMessage[];
	beforeStart?: { text: string; options?: AgentHarnessPromptOptions };
	systemPromptOverride?: string;
	resolvedSystemPrompt?: string;
	preflight?: { messages: AgentMessage[]; systemPrompt: string; systemPromptOverride?: string };
	preparedMessages?: AgentMessage[];
	reducedMessages?: AgentMessage[];
}

interface AgentHarnessRunEventState {
	id: string;
	abortController: AbortController;
	abortSource?: AgentAbortSource;
	diagnosticTimestamp?: number;
	requestAccepted: boolean;
	deliverySettlement: Promise<void> | undefined;
	deliveryOrder: Map<string, number>;
	deliveryOutcomes: Map<string, AgentDeliveryAttemptResult>;
	deliveryFailure?: AgentDeliveryFailure;
	deliveryFailureDiagnostic?: AssistantMessageDiagnostic;
	observationalDeliveryIds: Set<string>;
	admittedMessages: AgentMessage[];
	admittedMessageSet: Set<AgentMessage>;
	messageDeliveryIds: Map<AgentMessage, string | undefined>;
	startedMessages: Set<AgentMessage>;
	persistedMessages: AgentMessage[];
	persistedMessageSet: Set<AgentMessage>;
	deliveries: Map<string | undefined, AgentHarnessDeliveryEventState>;
	hasTurnStarted: boolean;
	turnOpen: boolean;
	settlementStarted: boolean;
	terminalEmitted: boolean;
	phase: "open" | "terminal_event_settling" | "settled";
	continuationCandidate?: AgentHarnessContinuationState;
}

interface AgentHarnessBoundedRun {
	state: AgentHarnessRunEventState;
	idlePromise: Promise<void>;
	finishIdle(): void;
}

type PendingDelivery = InboxDelivery<AgentDeliveryKind, AgentMessage>;

type DispatcherStartState = {
	firstDecision: boolean;
	requestAuthority: AgentRequestAuthority;
	providerRequestPending: boolean;
	drainFollowUpsFirst?: boolean;
};

interface AgentHarnessExecutionResult {
	result: AgentRunResult;
	response: AssistantMessage | undefined;
}

interface AgentHarnessProviderRequestState {
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
}

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> extends AgentHarnessProviderRequestState {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

/**
 * Coordinates runtime policy, provider dispatch, queues, lifecycle, and persistence around the stateless agent loop.
 * Session owns canonical history, while structural helpers own summarization mechanics behind Harness-wrapped streams.
 * All model requests, including structural work, use the Harness policy stream rather than direct completion helpers.
 * Assistant-tail no-op continuations return before model-backed turn snapshots are created.
 */
export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	private phase: AgentHarnessPhase = "idle";
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private activeRun: AgentHarnessRunEventState | undefined;
	private runPromise: Promise<void> | undefined;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any> | undefined;
	private thinkingLevel: ThinkingLevel;
	private readonly persistActiveToolChanges: boolean;
	private readonly streamFn: StreamFn;
	private readonly convertMessages: NonNullable<AgentHarnessOptions["convertToLlm"]>;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private readonly deliveryInbox = new DeliveryInbox<AgentDeliveryKind, AgentMessage>(
		() => `harness-delivery:${globalThis.crypto.randomUUID()}`,
	);
	private activeDeliveryLease: DeliveryLease<AgentDeliveryKind, AgentMessage> | undefined;
	private readonly leasedDeliveryKinds = new Map<string, AgentDeliveryKind>();
	private readonly deliveryAttemptParticipants = new Map<string, AgentDeliveryTransactionParticipant>();
	private readonly deliveryPreparationStates = new Map<string, AgentHarnessDeliveryPreparationState>();
	private readonly prepareDelivery: AgentHarnessOptions["prepareDelivery"];
	private readonly deliveryRevoked: AgentHarnessOptions["deliveryRevoked"];
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();
	private nextActionPolicies = new Set<{ policy: AgentHarnessNextActionPolicy }>();
	private continuationState: AgentHarnessContinuationState | undefined;
	private contextProjection: AgentHarnessContextProjection | undefined;

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		this.streamFn = options.streamFn ?? streamSimple;
		this.convertMessages = options.convertToLlm ?? defaultConvertToLlm;
		this.prepareDelivery = options.prepareDelivery;
		this.deliveryRevoked = options.deliveryRevoked;
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.persistActiveToolChanges = options.persistActiveToolChanges ?? true;
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private assertNotDisposed(): void {
		if (this.disposed) throw new AgentHarnessError("invalid_state", "AgentHarness is disposed");
	}

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const handler of this.getHandlers(event.type) ?? []) {
			try {
				await handler(structuredClone(event), signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		await this.emitPassive(event, signal);
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		await this.emitPassive(event, signal);
	}

	private async emitPassive(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(structuredClone(event), signal);
			} catch {
				// Finalized projections are observational and cannot alter runtime state.
			}
		}
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	private async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const handlers = this.getHandlers("context");
		let current = cloneAgentMessages(messages);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "context", messages: cloneAgentMessages(current) });
				if (result?.messages) current = cloneAgentMessages(result.messages);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitToolCall(event: {
		type: "tool_call";
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
	}): Promise<{ block?: boolean; reason?: string } | undefined> {
		const handlers = this.getHandlers("tool_call");
		if (!handlers || handlers.size === 0) return undefined;
		const current: { block?: boolean; reason?: string } = {};
		for (const handler of handlers) {
			try {
				const result = await handler(structuredClone({ ...event, ...current }));
				if (result?.block !== undefined) current.block = result.block;
				if (result?.reason !== undefined) current.reason = result.reason;
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitToolResult(event: Extract<AgentHarnessOwnEvent, { type: "tool_result" }>): Promise<{
		content: typeof event.content;
		details?: JsonValue;
		isError: boolean;
		disposition?: "stop" | "final_response";
	}> {
		const handlers = this.getHandlers("tool_result");
		if (!handlers || handlers.size === 0) {
			return {
				content: event.content,
				...(event.details === undefined ? {} : { details: event.details }),
				isError: event.isError,
			};
		}
		const current = {
			content: structuredClone(event.content),
			...(event.details === undefined ? {} : { details: structuredClone(event.details) }),
			isError: event.isError,
		} as {
			content: typeof event.content;
			details?: JsonValue;
			isError: boolean;
			disposition?: "stop" | "final_response";
		};
		for (const handler of handlers) {
			try {
				const result = await handler({
					...event,
					content: structuredClone(current.content),
					...(current.details === undefined ? {} : { details: structuredClone(current.details) }),
					isError: current.isError,
				});
				if (result?.content !== undefined) current.content = structuredClone(result.content);
				if (result?.details !== undefined) current.details = structuredClone(result.details);
				if (result?.isError !== undefined) current.isError = result.isError;
				if (result?.disposition !== undefined) current.disposition = result.disposition;
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitMessageEnd(
		event: Extract<AgentEvent, { type: "message_end" }>,
		state: AgentHarnessRunEventState,
	): Promise<Extract<AgentEvent, { type: "message_end" }>> {
		let current = this.decorateRuntimeDiagnostics(event, state);
		if (current.type !== "message_end") {
			throw new AgentHarnessError("invalid_state", "Runtime diagnostic decoration changed the event type");
		}
		for (const handler of this.getHandlers("message_end") ?? []) {
			try {
				const result = await handler(structuredClone(current), state.abortController.signal);
				if (result?.message) {
					if (result.message.role !== current.message.role) {
						throw new AgentHarnessError("hook", "message_end hooks must preserve the message role");
					}
					current = { ...current, message: structuredClone(result.message) };
				}
				const decorated = this.decorateRuntimeDiagnostics(current, state);
				if (decorated.type !== "message_end") {
					throw new AgentHarnessError("invalid_state", "Runtime diagnostic decoration changed the event type");
				}
				current = decorated;
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async reduceNextAction(
		context: AgentLoopNextActionContext,
		initialAction: AgentLoopNextAction,
	): Promise<AgentLoopNextAction> {
		const signal = this.activeRun?.abortController.signal;
		if (!signal) return cloneNextAction(initialAction);
		let current = cloneNextAction(initialAction);
		for (const handler of this.getHandlers("next_action") ?? []) {
			try {
				const pendingResult = handler({
					...cloneNextActionContext(context, current),
					type: "next_action",
					signal,
				});
				const result = pendingResult instanceof Promise ? await pendingResult : pendingResult;
				if (result !== undefined) current = cloneNextAction(result);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		for (const registration of this.nextActionPolicies) {
			try {
				const pendingResult = registration.policy(cloneNextActionContext(context, current), signal);
				const result = pendingResult instanceof Promise ? await pendingResult : pendingResult;
				if (result !== undefined) current = cloneNextAction(result);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
		signal?: AbortSignal,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			if (signal?.aborted) break;
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
				if (signal?.aborted) break;
			} catch (error) {
				if (signal?.aborted) break;
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async emitQueueUpdate(passive = false): Promise<void> {
		const event = {
			type: "queue_update" as const,
			steer: cloneAgentMessages(this.deliveryInbox.list("steer").flatMap((delivery) => delivery.messages)),
			followUp: cloneAgentMessages(this.deliveryInbox.list("followUp").flatMap((delivery) => delivery.messages)),
			nextTurn: cloneAgentMessages(this.nextTurnQueue),
		};
		if (passive) await this.emitPassive(event, this.activeRun?.abortController.signal);
		else await this.emitOwn(event, this.activeRun?.abortController.signal);
	}

	private admitBoundedRun(): AgentHarnessBoundedRun {
		const state: AgentHarnessRunEventState = {
			id: `harness-run:${globalThis.crypto.randomUUID()}`,
			abortController: new AbortController(),
			requestAccepted: false,
			deliverySettlement: undefined,
			deliveryOrder: new Map(),
			deliveryOutcomes: new Map(),
			observationalDeliveryIds: new Set(),
			admittedMessages: [],
			admittedMessageSet: new Set(),
			messageDeliveryIds: new Map(),
			startedMessages: new Set(),
			persistedMessages: [],
			persistedMessageSet: new Set(),
			deliveries: new Map(),
			hasTurnStarted: false,
			turnOpen: false,
			settlementStarted: false,
			terminalEmitted: false,
			phase: "open",
		};
		let finishIdle = (): void => undefined;
		const idlePromise = new Promise<void>((resolve) => {
			finishIdle = resolve;
		});
		this.phase = "turn";
		this.activeRun = state;
		this.runPromise = idlePromise;
		return { state, idlePromise, finishIdle };
	}

	private finishBoundedRun(run: AgentHarnessBoundedRun): void {
		this.activeRun = undefined;
		this.runPromise = undefined;
		this.phase = "idle";
		run.finishIdle();
	}

	private async createTurnState(
		signal: AbortSignal,
		contextOverride?: readonly AgentMessage[],
		systemPromptOverride?: string,
		deferSystemPrompt = false,
	): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = contextOverride === undefined ? await this.session.buildContext() : { messages: contextOverride };
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const model = this.model;
		if (!model) throw new AgentHarnessError("invalid_state", "No model set for AgentHarness run");
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		const baseState = {
			messages: [...context.messages],
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt: "You are a helpful assistant.",
			model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
		const systemPrompt =
			systemPromptOverride ??
			(deferSystemPrompt
				? typeof this.systemPrompt === "string"
					? this.systemPrompt
					: baseState.systemPrompt
				: await this.resolveConfiguredSystemPrompt(baseState, signal));
		return { ...baseState, systemPrompt };
	}

	private async resolveConfiguredSystemPrompt(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		signal: AbortSignal,
	): Promise<string> {
		if (typeof this.systemPrompt === "string") return this.systemPrompt;
		if (!this.systemPrompt) return "You are a helpful assistant.";
		return await this.systemPrompt({
			env: this.env,
			session: this.session,
			model: turnState.model,
			thinkingLevel: turnState.thinkingLevel,
			activeTools: turnState.activeTools,
			resources: turnState.resources,
			signal,
		});
	}

	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	private createPolicyStreamFn(getRequestState: () => AgentHarnessProviderRequestState): StreamFn {
		return async (model, context, streamOptions) => {
			const signal = streamOptions?.signal;
			if (signal?.aborted) return createAbortedAssistantStream(model);

			const requestState = getRequestState();
			let auth: { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> } | undefined;
			try {
				auth = await this.getApiKeyAndHeaders?.(model);
			} catch (error) {
				if (signal?.aborted) return createAbortedAssistantStream(model);
				throw error;
			}
			if (signal?.aborted) return createAbortedAssistantStream(model);

			const headers = mergeHeaders(requestState.streamOptions.headers, auth?.headers);
			const env = mergeHeaders(requestState.streamOptions.env, auth?.env);
			const snapshotOptions: AgentHarnessStreamOptions = {
				...requestState.streamOptions,
				...(headers === undefined ? {} : { headers }),
				...(env === undefined ? {} : { env }),
			};
			const requestOptions = await this.emitBeforeProviderRequest(
				model,
				requestState.sessionId,
				snapshotOptions,
				signal,
			);
			if (signal?.aborted) return createAbortedAssistantStream(model);

			return await this.streamFn(model, context, {
				...(requestOptions.cacheRetention === undefined ? {} : { cacheRetention: requestOptions.cacheRetention }),
				...(requestOptions.env === undefined ? {} : { env: requestOptions.env }),
				...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
				...(requestOptions.inferenceSpeed === undefined ? {} : { inferenceSpeed: requestOptions.inferenceSpeed }),
				...(requestOptions.maxRetries === undefined ? {} : { maxRetries: requestOptions.maxRetries }),
				...(requestOptions.maxRetryDelayMs === undefined
					? {}
					: { maxRetryDelayMs: requestOptions.maxRetryDelayMs }),
				...(requestOptions.metadata === undefined ? {} : { metadata: requestOptions.metadata }),
				...(requestOptions.thinkingBudgets === undefined
					? {}
					: { thinkingBudgets: requestOptions.thinkingBudgets }),
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn({ type: "after_provider_response", status: response.status, headers }, signal);
				},
				...(streamOptions?.maxTokens === undefined ? {} : { maxTokens: streamOptions.maxTokens }),
				...(streamOptions?.reasoning === undefined ? {} : { reasoning: streamOptions.reasoning }),
				...(signal === undefined ? {} : { signal }),
				sessionId: requestState.sessionId,
				...(streamOptions?.temperature === undefined ? {} : { temperature: streamOptions.temperature }),
				...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
				...(requestOptions.transport === undefined ? {} : { transport: requestOptions.transport }),
				...(requestOptions.websocketConnectTimeoutMs === undefined
					? {}
					: { websocketConnectTimeoutMs: requestOptions.websocketConnectTimeoutMs }),
				...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			});
		};
	}

	private async createStructuralStreamFn(): Promise<StreamFn> {
		const sessionMetadata = await this.session.getMetadata();
		const requestState: AgentHarnessProviderRequestState = {
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
		};
		return this.createPolicyStreamFn(() => requestState);
	}

	private selectPendingDeliveries(kind: AgentDeliveryKind, mode: QueueMode): PendingDelivery[] {
		return [...this.deliveryInbox.select(kind, mode)];
	}

	private promoteContinuationCandidate(run: AgentHarnessRunEventState): void {
		const candidate = run.continuationCandidate;
		if (!candidate) return;
		this.continuationState = { ...candidate };
	}

	private recordContextProjectionInvalid(
		projection: AgentHarnessContextProjection,
		error: AgentHarnessError,
	): AgentHarnessError {
		if (this.contextProjection !== projection) return error;
		if (projection.invalidError) return projection.invalidError;
		this.contextProjection = { ...projection, invalidError: error };
		return error;
	}

	private staleContextProjectionError(): AgentHarnessError {
		return new AgentHarnessError(
			"invalid_state",
			"Continuation context projection anchor no longer matches the canonical session branch",
		);
	}

	private async requireValidContextProjection(): Promise<AgentHarnessContextProjection | undefined> {
		for (;;) {
			const projection = this.contextProjection;
			if (!projection) return undefined;
			if (projection.invalidError) throw projection.invalidError;
			let currentLeafId: string | null;
			try {
				currentLeafId = await this.session.getLeafId();
			} catch (error) {
				if (this.contextProjection !== projection) continue;
				throw this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
			}
			if (this.contextProjection !== projection) continue;
			if (currentLeafId !== projection.anchorLeafId) {
				let branch: SessionTreeEntry[];
				try {
					branch = currentLeafId === null ? [] : await this.session.getBranch(currentLeafId);
				} catch (error) {
					if (this.contextProjection !== projection) continue;
					throw this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
				}
				if (this.contextProjection !== projection) continue;
				const anchorIndex =
					projection.anchorLeafId === null
						? -1
						: branch.findIndex((entry) => entry.id === projection.anchorLeafId);
				const appendedEntries = branch.slice(anchorIndex + 1);
				if (
					(projection.anchorLeafId !== null && anchorIndex === -1) ||
					appendedEntries.some((entry) => entry.type !== "label" && entry.type !== "session_info")
				) {
					throw this.recordContextProjectionInvalid(projection, this.staleContextProjectionError());
				}
				// Labels and session metadata extend canonical history without changing
				// provider context. Advance only the validation watermark; all other
				// external writes remain fail-closed.
				this.contextProjection = { ...projection, anchorLeafId: currentLeafId };
				continue;
			}
			return projection;
		}
	}

	private async advanceContextProjection(entryId: string, messages: readonly AgentMessage[] = []): Promise<void> {
		const projection = this.contextProjection;
		if (!projection || projection.invalidError) return;
		let appendedMessages: AgentMessage[];
		try {
			appendedMessages = cloneAgentMessages(messages);
		} catch (error) {
			this.recordContextProjectionInvalid(
				projection,
				new AgentHarnessError(
					"invalid_state",
					"Continuation context projection could not own persisted messages",
					toError(error),
				),
			);
			return;
		}
		let entry: SessionTreeEntry | undefined;
		try {
			entry = await this.session.getEntry(entryId);
		} catch (error) {
			if (this.contextProjection === projection) {
				this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
			}
			return;
		}
		if (this.contextProjection !== projection) return;
		if (!entry || entry.parentId !== projection.anchorLeafId) {
			this.recordContextProjectionInvalid(projection, this.staleContextProjectionError());
			return;
		}
		this.contextProjection = {
			...projection,
			anchorLeafId: entryId,
			messages: [...projection.messages, ...appendedMessages],
		};
	}

	private async advanceContextProjectionToLeaf(
		anchorLeafId: string | null,
		messages: readonly AgentMessage[],
	): Promise<void> {
		const projection = this.contextProjection;
		if (!projection || projection.invalidError) return;
		let appendedMessages: AgentMessage[];
		try {
			appendedMessages = cloneAgentMessages(messages);
		} catch (error) {
			this.recordContextProjectionInvalid(
				projection,
				new AgentHarnessError(
					"invalid_state",
					"Continuation context projection could not own persisted messages",
					toError(error),
				),
			);
			return;
		}
		let branch: SessionTreeEntry[];
		try {
			branch = anchorLeafId === null ? [] : await this.session.getBranch(anchorLeafId);
		} catch (error) {
			if (this.contextProjection === projection) {
				this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
			}
			return;
		}
		if (this.contextProjection !== projection) return;
		const extendsProjection =
			projection.anchorLeafId === null
				? branch.length === 0 || branch[0]?.parentId === null
				: branch.some((entry) => entry.id === projection.anchorLeafId);
		if (!extendsProjection) {
			this.recordContextProjectionInvalid(projection, this.staleContextProjectionError());
			return;
		}
		this.contextProjection = {
			...projection,
			anchorLeafId,
			messages: [...projection.messages, ...appendedMessages],
		};
	}

	async rebaseContinuationContext(
		options: AgentHarnessContextRebaseOptions,
	): Promise<AgentHarnessContextProjectionToken> {
		this.assertNotDisposed();
		try {
			const canonicalContext = await this.session.buildContext();
			const canonicalMessages = Object.freeze(cloneAgentMessages(canonicalContext.messages));
			const projectedMessages = options.project ? options.project(canonicalMessages) : canonicalMessages;
			const ownedMessages = cloneAgentMessages(projectedMessages);
			const currentLeafId = await this.session.getLeafId();
			if (currentLeafId !== canonicalContext.anchorLeafId) {
				throw new AgentHarnessError("invalid_state", "Session branch changed while rebasing continuation context");
			}
			const token = Object.freeze({
				projectionId: `harness-context:${globalThis.crypto.randomUUID()}`,
				source: options.source,
				anchorLeafId: canonicalContext.anchorLeafId,
			});
			this.contextProjection = {
				token,
				anchorLeafId: canonicalContext.anchorLeafId,
				messages: ownedMessages,
			};
			return token;
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	clearContinuationContext(token: AgentHarnessContextProjectionToken): boolean {
		if (this.contextProjection?.token !== token) return false;
		this.contextProjection = undefined;
		return true;
	}

	invalidateContinuationContext(): void {
		this.contextProjection = undefined;
	}

	private async resolveNextAction(
		context: AgentLoopNextActionContext,
		startState: DispatcherStartState,
		systemPrompt: string,
	): Promise<AgentLoopNextAction> {
		const isFirstDecision = startState.firstDecision;
		startState.firstDecision = false;
		const requestAuthority = isFirstDecision ? startState.requestAuthority : context.requestAuthority;
		const runtimeAction = context.defaultAction;
		const providerRequestPending = isFirstDecision
			? startState.providerRequestPending
			: runtimeAction.type === "request";
		const run = this.activeRun;
		if (!run) throw new AgentHarnessError("invalid_state", "Next-action dispatch requires an active run");
		run.continuationCandidate = {
			requestAuthority,
			providerRequestPending,
			systemPrompt,
		};

		if (run.abortController.signal.aborted) {
			this.promoteContinuationCandidate(run);
			return { type: "pause", requestAuthority };
		}

		if (requestAuthority === "final_response") {
			const finalResponseAction: AgentLoopNextAction =
				runtimeAction.type === "request" ? { type: "request", reason: "final_response" } : runtimeAction;
			const action = await this.reduceNextAction({ ...context, requestAuthority }, finalResponseAction);
			this.continuationState = {
				requestAuthority,
				providerRequestPending: action.type === "pause" ? providerRequestPending : true,
				systemPrompt,
			};
			return action.type === "pause"
				? { ...action, requestAuthority }
				: { type: "request", reason: "final_response" };
		}

		let selected: PendingDelivery[] = [];
		const prompts = this.selectPendingDeliveries("prompt", "all");
		if (prompts.length > 0) {
			selected = [...prompts, ...this.selectPendingDeliveries("steer", this.steeringQueueMode)];
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
		const action = await this.reduceNextAction(
			{ ...context, requestAuthority, defaultAction: suggestedAction },
			suggestedAction,
		);
		if (action.type === "pause") {
			this.continuationState = {
				requestAuthority: action.requestAuthority ?? requestAuthority,
				providerRequestPending: hasIndependentRequest,
				systemPrompt,
			};
			return { ...action, requestAuthority: action.requestAuthority ?? requestAuthority };
		}
		if (action.type === "stop") {
			this.continuationState = undefined;
			return action;
		}
		const leasedDeliveries = selected.length > 0 ? await this.prepareLeasedDeliveries(selected) : [];
		const deliveries = [...leasedDeliveries, ...(action.deliveries ?? [])];
		this.continuationState = undefined;
		return {
			type: "request",
			reason: action.reason,
			...(deliveries.length > 0 ? { deliveries } : {}),
		};
	}

	private terminallyFailPreparationReplay(
		lease: DeliveryLease<AgentDeliveryKind, AgentMessage>,
		delivery: PendingDelivery,
		error: AgentDeliveryPreparationReplayMismatchError,
	): void {
		if (this.activeDeliveryLease !== lease || !lease.canPrepare(delivery.deliveryId)) {
			throw new AgentHarnessError(
				"invalid_state",
				`Delivery preparation replay lost AgentHarness ownership: ${delivery.deliveryId}`,
			);
		}
		if (!lease.begin(delivery.deliveryId) || !lease.settle(delivery.deliveryId, "terminally_failed")) {
			throw new AgentHarnessError(
				"invalid_state",
				`Delivery preparation replay could not be terminally fenced: ${delivery.deliveryId}`,
			);
		}
		this.deliveryAttemptParticipants.delete(delivery.deliveryId);
		this.deliveryPreparationStates.delete(delivery.deliveryId);
		this.continuationState = undefined;
		if (this.activeRun) delete this.activeRun.continuationCandidate;
		this.invalidateContinuationContext();
		this.recordDeliveryFailure(delivery, "preparation", "terminally_failed", error);
	}

	private async prepareLeasedDeliveries(selected: PendingDelivery[]): Promise<AgentLoopDelivery[]> {
		const lease = this.deliveryInbox.lease(selected);
		this.activeDeliveryLease = lease;
		for (const delivery of lease.deliveries) {
			this.leasedDeliveryKinds.set(delivery.deliveryId, delivery.kind);
			const run = this.activeRun;
			if (run && !run.deliveryOrder.has(delivery.deliveryId)) {
				run.deliveryOrder.set(delivery.deliveryId, run.deliveryOrder.size);
			}
		}

		const run = this.activeRun;
		if (!run) throw new AgentHarnessError("invalid_state", "Delivery preparation requires an active run");
		const signal = run.abortController.signal;
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			if (!lease.canPrepare(delivery.deliveryId)) continue;
			const preparationState = this.deliveryPreparationStates.get(delivery.deliveryId) ?? {};
			if (!this.deliveryPreparationStates.has(delivery.deliveryId)) {
				this.deliveryPreparationStates.set(delivery.deliveryId, preparationState);
			}
			const sourceMessages = preparationState.preflight?.messages ?? delivery.messages;
			let preparation: AgentDeliveryPreparation;
			try {
				preparation = this.prepareDelivery
					? await this.prepareDelivery(
							{
								deliveryId: delivery.deliveryId,
								kind: delivery.kind,
								messages: cloneAgentMessages(sourceMessages),
							},
							signal,
						)
					: { messages: cloneAgentMessages(sourceMessages) };
			} catch (error) {
				if (!lease.canPrepare(delivery.deliveryId)) continue;
				if (error instanceof AgentDeliveryPreparationReplayMismatchError) {
					this.terminallyFailPreparationReplay(lease, delivery, error);
					throw error;
				}
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (this.activeDeliveryLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
			let preparedMessages: AgentMessage[];
			try {
				preparedMessages = cloneAgentMessages(preparation.messages);
			} catch (error) {
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (preparedMessages.length === 0) {
				const error = new Error("prepareDelivery must retain at least one message for an admitted delivery");
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (
				preparationState.preparedMessages !== undefined &&
				!areStructurallyEqual(preparationState.preparedMessages, preparedMessages)
			) {
				const error = new AgentDeliveryPreparationReplayMismatchError(delivery.deliveryId);
				this.terminallyFailPreparationReplay(lease, delivery, error);
				throw error;
			}
			preparationState.preparedMessages ??= cloneAgentMessages(preparedMessages);
			if (preparationState.reducedMessages === undefined) {
				try {
					const reducedMessages: AgentMessage[] = [];
					for (const message of preparedMessages) {
						const reduced = await this.emitMessageEnd(
							{ type: "message_end", deliveryId: delivery.deliveryId, message: structuredClone(message) },
							run,
						);
						reducedMessages.push(structuredClone(reduced.message));
					}
					if (this.activeDeliveryLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
					preparationState.reducedMessages = cloneAgentMessages(reducedMessages);
				} catch (error) {
					if (!lease.canPrepare(delivery.deliveryId)) continue;
					this.recordDeliveryFailure(delivery, "preparation", "retained", error);
					throw error;
				}
			}
			if (preparation.participant) {
				this.deliveryAttemptParticipants.set(delivery.deliveryId, preparation.participant);
			}
			deliveries.push({
				deliveryId: delivery.deliveryId,
				messages: cloneAgentMessages(preparationState.reducedMessages),
			});
		}
		return deliveries;
	}

	private async beginActiveDelivery(delivery: AgentLoopDelivery): Promise<AgentLoopDeliveryOutcome> {
		if (this.disposed) return { outcome: "revoked" };
		if (delivery.deliveryId === undefined) return { outcome: "committed" };
		const kind = this.leasedDeliveryKinds.get(delivery.deliveryId);
		if (kind === undefined) return { outcome: "committed" };
		const lease = this.activeDeliveryLease;
		if (!lease?.owns(delivery.deliveryId) || !lease.begin(delivery.deliveryId)) {
			this.recordDeliveryOutcome({ deliveryId: delivery.deliveryId, kind, outcome: "revoked" });
			return { outcome: "revoked" };
		}

		const run = this.activeRun;
		if (run) run.requestAccepted = true;
		let finishSettlement = (): void => undefined;
		const settlement = new Promise<void>((resolve) => {
			finishSettlement = resolve;
		});
		if (run) run.deliverySettlement = settlement;

		let outcome: AgentDeliveryParticipantOutcome;
		const participant = this.deliveryAttemptParticipants.get(delivery.deliveryId);
		try {
			await this.requireValidContextProjection();
			if (participant) {
				try {
					outcome = await participant.settle(
						Object.freeze({
							deliveryId: delivery.deliveryId,
							kind,
							messages: Object.freeze(cloneAgentMessages(delivery.messages)),
							requestAbort: (source?: AgentAbortSource) => this.abort(source),
						}),
					);
				} catch (error) {
					outcome = { outcome: "terminally_failed", error: toError(error) };
				}
			} else {
				try {
					for (const message of delivery.messages) {
						const entryId = await this.session.appendMessage(message);
						await this.advanceContextProjection(entryId, [message]);
					}
					outcome = { outcome: "committed" };
				} catch (error) {
					outcome = { outcome: "terminally_failed", error: toError(error) };
				}
			}

			if (!lease.settle(delivery.deliveryId, outcome.outcome)) {
				outcome = {
					outcome: "terminally_failed",
					error: new Error(`Delivery settlement lost AgentHarness ownership: ${delivery.deliveryId}`),
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
			if (outcome.outcome === "retained" && run?.persistedMessages.length === 0) {
				run.requestAccepted = false;
			}
			if (outcome.outcome === "committed") {
				run?.observationalDeliveryIds.add(delivery.deliveryId);
				if (participant) {
					let committedLeafId: string | null | undefined;
					try {
						committedLeafId = await this.session.getLeafId();
					} catch (error) {
						const projection = this.contextProjection;
						if (projection) {
							this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
						}
					}
					if (committedLeafId !== undefined) {
						await this.advanceContextProjectionToLeaf(committedLeafId, delivery.messages);
					}
				}
			}
			return outcome;
		} finally {
			this.deliveryAttemptParticipants.delete(delivery.deliveryId);
			finishSettlement();
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
		if (outcome.outcome === "committed" || outcome.outcome === "terminally_failed" || outcome.outcome === "revoked") {
			this.deliveryPreparationStates.delete(outcome.deliveryId);
		}
		const run = this.activeRun;
		if (!run || run.deliveryOutcomes.has(outcome.deliveryId)) return;
		run.deliveryOutcomes.set(outcome.deliveryId, Object.freeze(outcome));
		if ("error" in outcome && run.deliveryFailure === undefined) {
			run.deliveryFailure = outcome;
			run.deliveryFailureDiagnostic = createAssistantMessageDiagnostic(
				"delivery_transaction_failure",
				outcome.error,
				{
					deliveryId: outcome.deliveryId,
					kind: outcome.kind,
					outcome: outcome.outcome,
					phase: outcome.phase,
				},
			);
		}
		if (outcome.outcome === "retained") this.promoteContinuationCandidate(run);
	}

	private rollbackActiveLease(): void {
		const restored = this.deliveryInbox.rollbackActiveLease();
		for (const delivery of restored) {
			this.recordDeliveryOutcome({
				deliveryId: delivery.deliveryId,
				kind: delivery.kind,
				outcome: "retained",
			});
		}
		this.activeDeliveryLease = undefined;
		this.deliveryAttemptParticipants.clear();
	}

	private createLoopConfig(
		run: AgentHarnessRunEventState,
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
		startState: DispatcherStartState,
		systemPromptOverride?: string,
	): AgentLoopConfig {
		const turnState = getTurnState();
		return {
			model: turnState.model,
			...(turnState.thinkingLevel === "off" ? {} : { reasoning: turnState.thinkingLevel }),
			convertToLlm: async (messages) => await this.convertMessages(cloneAgentMessages(messages)),
			transformContext: async (messages) => await this.emitContext(messages),
			beforeToolCall: async ({ toolCall, args }) =>
				await this.emitToolCall({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
				}),
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const details = result.details as JsonValue | undefined;
				return await this.emitToolResult({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
					content: result.content,
					...(details === undefined ? {} : { details }),
					isError,
				});
			},
			nextAction: async (context) =>
				await this.resolveNextAction(context, startState, systemPromptOverride ?? getTurnState().systemPrompt),
			beginDelivery: async (delivery) => await this.beginActiveDelivery(delivery),
			prepareRequest: async ({ context }) => {
				const flushedMessages = await this.flushPendingSessionWrites();
				const projection = await this.requireValidContextProjection();
				const contextMessages = projection ? projection.messages : [...context.messages, ...flushedMessages];
				const nextTurnState = await this.createTurnState(
					run.abortController.signal,
					contextMessages,
					systemPromptOverride,
				);
				if ((await this.requireValidContextProjection()) !== projection) {
					throw new AgentHarnessError(
						"invalid_state",
						"Continuation context projection changed during request preparation",
					);
				}
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState, systemPromptOverride),
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
		};
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private async flushPendingSessionWrites(): Promise<AgentMessage[]> {
		if (this.disposed) {
			this.pendingSessionWrites = [];
			return [];
		}
		const providerVisibleMessages: AgentMessage[] = [];
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			let entryId: string | undefined;
			let projectedMessages: AgentMessage[] = [];
			if (write.type === "message") {
				entryId = await this.session.appendMessage(write.message);
				projectedMessages = [write.message];
			} else if (write.type === "model_change") {
				entryId = await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				entryId = await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "active_tools_change") {
				entryId = await this.session.appendActiveToolsChange(write.activeToolNames);
			} else if (write.type === "custom") {
				entryId = await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				entryId = await this.session.appendCustomMessageEntry(
					write.customType,
					write.content,
					write.display,
					write.details,
				);
				const entry = await this.session.getEntry(entryId);
				if (entry?.type === "custom_message") {
					projectedMessages = [
						createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
					];
				}
			} else if (write.type === "label") {
				entryId = await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				entryId = await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
				this.invalidateContinuationContext();
			}
			this.pendingSessionWrites.shift();
			if (entryId !== undefined) {
				await this.advanceContextProjection(entryId, projectedMessages);
				providerVisibleMessages.push(...cloneAgentMessages(projectedMessages));
			}
		}
		return providerVisibleMessages;
	}

	private decorateRuntimeDiagnostics(event: AgentEvent, state: AgentHarnessRunEventState): AgentEvent {
		if (event.type !== "message_end" || event.message.role !== "assistant") return event;
		let message = event.message;
		if (
			(message.stopReason === "aborted" || state.phase === "terminal_event_settling") &&
			state.abortController.signal.aborted &&
			state.abortSource !== undefined &&
			state.diagnosticTimestamp !== undefined
		) {
			message = {
				...message,
				diagnostics: [
					...(message.diagnostics ?? []).filter((diagnostic) => diagnostic.type !== "runtime_abort"),
					{
						type: "runtime_abort",
						timestamp: state.diagnosticTimestamp,
						details: { source: state.abortSource },
					},
				],
			};
		}
		if (state.settlementStarted && state.deliveryFailureDiagnostic) {
			message = {
				...message,
				diagnostics: [
					...(message.diagnostics ?? []).filter(
						(diagnostic) => diagnostic.type !== "delivery_transaction_failure",
					),
					state.deliveryFailureDiagnostic,
				],
			};
		}
		return {
			...event,
			message,
		};
	}

	private async handleAgentEvent(
		event: AgentEvent,
		state: AgentHarnessRunEventState,
		signal?: AbortSignal,
	): Promise<AgentMessage | undefined> {
		if (this.disposed) {
			if (event.type === "turn_start") state.turnOpen = true;
			else if (event.type === "turn_end") state.turnOpen = false;
			else if (event.type === "agent_end") {
				state.terminalEmitted = true;
				state.phase = "settled";
			} else if (event.type === "message_end") {
				return event.message;
			}
			return undefined;
		}
		if (event.type === "delivery_start") {
			state.requestAccepted = true;
			for (const message of event.messages) {
				if (!state.admittedMessageSet.has(message)) {
					state.admittedMessageSet.add(message);
					state.admittedMessages.push(message);
				}
				state.messageDeliveryIds.set(message, event.deliveryId);
			}
			state.deliveries.set(event.deliveryId, { remainingMessages: new Set(event.messages) });
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			if (observational) {
				if (event.deliveryId !== undefined && this.leasedDeliveryKinds.get(event.deliveryId) !== "prompt") {
					await this.emitQueueUpdate(true);
				}
				await this.emitPassive(event, signal);
			} else {
				await this.emitAny(event, signal);
			}
			return undefined;
		}
		if (event.type === "message_start") {
			state.startedMessages.add(event.message);
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			if (observational) await this.emitPassive(event, signal);
			else await this.emitAny(event, signal);
			return undefined;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant" && event.message.stopReason !== "toolUse") {
				state.phase = "terminal_event_settling";
			}
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			const finalizedEvent = observational
				? this.decorateRuntimeDiagnostics(event, state)
				: await this.emitMessageEnd(event, state);
			if (finalizedEvent.type !== "message_end") {
				throw new AgentHarnessError("invalid_state", "Runtime diagnostic decoration changed the event type");
			}
			if (!observational && !this.disposed) {
				const entryId = await this.session.appendMessage(finalizedEvent.message);
				await this.advanceContextProjection(entryId, [finalizedEvent.message]);
			}
			if (!state.persistedMessageSet.has(event.message)) {
				state.persistedMessageSet.add(event.message);
				state.persistedMessages.push(finalizedEvent.message);
			}
			const deliveryState = state.deliveries.get(finalizedEvent.deliveryId);
			if (deliveryState?.remainingMessages.delete(event.message) && deliveryState.remainingMessages.size === 0) {
				state.deliveries.delete(finalizedEvent.deliveryId);
			}
			await this.emitAny(finalizedEvent, signal);
			return finalizedEvent.message;
		}
		if (event.type === "turn_start") {
			state.hasTurnStarted = true;
			state.turnOpen = true;
			state.requestAccepted = true;
			await this.emitAny(event, signal);
			return undefined;
		}
		if (event.type === "turn_end") {
			state.turnOpen = false;
			state.phase = "open";
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.pendingSessionWrites.length > 0;
			await this.flushPendingSessionWrites();
			if (eventError) throw eventError;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return undefined;
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			state.terminalEmitted = true;
			state.phase = "settled";
			await this.emitPassive(event, signal);
			await this.emitPassive({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return undefined;
		}
		await this.emitAny(event, signal);
		return undefined;
	}

	private async settleRunFailure(
		state: AgentHarnessRunEventState,
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		if (state.settlementStarted || state.terminalEmitted) {
			throw new AgentHarnessError("invalid_state", "Harness failure settlement already started");
		}
		state.settlementStarted = true;
		const settlementErrors: Error[] = [];
		const attempt = async (event: AgentEvent): Promise<AgentMessage | undefined> => {
			try {
				return await this.handleAgentEvent(event, state, signal);
			} catch (eventError) {
				settlementErrors.push(toError(eventError));
				return undefined;
			}
		};

		for (const message of state.admittedMessages) {
			if (state.persistedMessageSet.has(message)) continue;
			const deliveryId = state.messageDeliveryIds.get(message);
			const delivery = deliveryId === undefined ? {} : { deliveryId };
			if (!state.startedMessages.has(message)) {
				await attempt({ type: "message_start", message, ...delivery });
			}
			if (!state.persistedMessageSet.has(message)) {
				await attempt({ type: "message_end", message, ...delivery });
			}
		}

		const outcomes = [...state.deliveryOutcomes.values()];
		const hasCommittedDelivery = outcomes.some((outcome) => outcome.outcome === "committed");
		const retainedBeforeAnyCommit = state.deliveryFailure?.outcome === "retained" && !hasCommittedDelivery;
		if (!retainedBeforeAnyCommit && !(aborted && !state.requestAccepted)) {
			if (!state.turnOpen) await attempt({ type: "turn_start" });
			const failureError = aborted ? new Error("Request was aborted") : error;
			const failureMessage = createFailureMessage(model, failureError, aborted);
			await attempt({ type: "message_start", message: failureMessage });
			const finalizedFailureMessage =
				(await attempt({ type: "message_end", message: failureMessage })) ?? failureMessage;
			await attempt({ type: "turn_end", message: finalizedFailureMessage, toolResults: [] });
		}
		const terminalMessages = [...state.persistedMessages];
		await attempt({ type: "agent_end", messages: terminalMessages });

		if (settlementErrors.length > 0) {
			throw combineEventErrors(settlementErrors, "Harness failure settlement notifications failed");
		}
		return terminalMessages;
	}

	private enqueueDelivery(kind: AgentDeliveryKind, messages: readonly AgentMessage[]): string {
		return this.deliveryInbox.enqueue(kind, cloneAgentMessages(messages)).deliveryId;
	}

	private enqueuePublishedDelivery(
		kind: "steer" | "followUp",
		messages: readonly AgentMessage[],
	): { deliveryId: string; publication: Promise<void> } {
		const deliveryId = this.enqueueDelivery(kind, messages);
		const publication = this.emitQueueUpdate(true);
		void publication.catch(() => {});
		return { deliveryId, publication };
	}

	private async admitPromptDelivery(
		messages: readonly AgentMessage[],
		beforeStart?: { text: string; options?: AgentHarnessPromptOptions },
		systemPromptOverride?: string,
	): Promise<string> {
		if (messages.length === 0) {
			throw new AgentHarnessError("invalid_argument", "A prompt delivery must contain at least one message");
		}
		const nextTurnCount = this.nextTurnQueue.length;
		const admittedMessages = [
			...cloneAgentMessages(this.nextTurnQueue.slice(0, nextTurnCount)),
			...cloneAgentMessages(messages),
		];
		const deliveryId = this.enqueueDelivery("prompt", admittedMessages);
		this.deliveryPreparationStates.set(deliveryId, {
			admittedMessages: cloneAgentMessages(admittedMessages),
			...(beforeStart === undefined
				? {}
				: {
						beforeStart: {
							text: beforeStart.text,
							...(beforeStart.options === undefined ? {} : { options: structuredClone(beforeStart.options) }),
						},
					}),
			...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
		});
		if (nextTurnCount > 0) {
			this.nextTurnQueue.splice(0, nextTurnCount);
			await this.emitQueueUpdate(true);
		}
		return deliveryId;
	}

	private async preparePromptPreflight(
		deliveryId: string,
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		signal: AbortSignal,
	): Promise<{ messages: AgentMessage[]; systemPrompt: string; systemPromptOverride?: string }> {
		const state = this.deliveryPreparationStates.get(deliveryId);
		if (!state?.admittedMessages) {
			throw new AgentHarnessError(
				"invalid_state",
				`Prompt delivery ${deliveryId} has no admitted preparation state`,
			);
		}
		if (state.preflight) {
			return {
				messages: cloneAgentMessages(state.preflight.messages),
				systemPrompt: state.preflight.systemPrompt,
				...(state.preflight.systemPromptOverride === undefined
					? {}
					: { systemPromptOverride: state.preflight.systemPromptOverride }),
			};
		}
		if (state.resolvedSystemPrompt === undefined) {
			state.resolvedSystemPrompt =
				state.systemPromptOverride ?? (await this.resolveConfiguredSystemPrompt(turnState, signal));
		}
		if (this.deliveryPreparationStates.get(deliveryId) !== state) {
			throw new AgentHarnessError("delivery", `Prompt delivery ${deliveryId} was revoked during preflight`);
		}
		let messages = cloneAgentMessages(state.admittedMessages);
		let systemPrompt = state.resolvedSystemPrompt;
		let systemPromptOverride = state.systemPromptOverride;
		if (state.beforeStart) {
			const beforeResult = await this.emitHook({
				type: "before_agent_start",
				prompt: state.beforeStart.text,
				...(state.beforeStart.options?.images === undefined
					? {}
					: { images: structuredClone(state.beforeStart.options.images) }),
				systemPrompt,
				resources: turnState.resources,
				signal,
			});
			messages = [...messages, ...cloneAgentMessages(beforeResult?.messages ?? [])];
			if (beforeResult?.systemPrompt !== undefined) {
				systemPrompt = beforeResult.systemPrompt;
				systemPromptOverride = beforeResult.systemPrompt;
			}
		}
		if (this.deliveryPreparationStates.get(deliveryId) !== state) {
			throw new AgentHarnessError("delivery", `Prompt delivery ${deliveryId} was revoked during preflight`);
		}
		state.preflight = {
			messages: cloneAgentMessages(messages),
			systemPrompt,
			...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
		};
		return { messages, systemPrompt, ...(systemPromptOverride === undefined ? {} : { systemPromptOverride }) };
	}

	private async executeTurn(
		runEventState: AgentHarnessRunEventState,
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		startState: DispatcherStartState,
		systemPrompt?: string,
	): Promise<AgentHarnessExecutionResult> {
		let activeTurnState = turnState;
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		const abortController = runEventState.abortController;
		if (this.contextProjection) {
			await this.requireValidContextProjection();
		} else {
			await this.rebaseContinuationContext({ source: "explicit" });
		}
		runEventState.continuationCandidate = {
			requestAuthority: startState.requestAuthority,
			providerRequestPending: startState.providerRequestPending,
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
		};
		if (abortController.signal.aborted && this.hasQueuedMessages()) {
			this.promoteContinuationCandidate(runEventState);
		}

		let loopMessages: AgentMessage[] = [];
		let terminalMessages: AgentMessage[] | undefined;
		let deliveries: readonly AgentDeliveryAttemptResult[] = [];
		let deliveryFailure: AgentDeliveryFailure | undefined;
		try {
			try {
				loopMessages = await runAgentLoop(
					[],
					this.createContext(turnState, systemPrompt),
					this.createLoopConfig(runEventState, getTurnState, setTurnState, startState, systemPrompt),
					async (event) => await this.handleAgentEvent(event, runEventState, abortController.signal),
					abortController.signal,
					this.createPolicyStreamFn(getTurnState),
				);
			} catch (error) {
				this.rollbackActiveLease();
				if (runEventState.settlementStarted || runEventState.terminalEmitted) throw error;
				try {
					terminalMessages = await this.settleRunFailure(
						runEventState,
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
				} catch (settlementError) {
					throw createFailureSettlementError(error, settlementError);
				}
			}
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.rollbackActiveLease();
				deliveries = Object.freeze(
					[...runEventState.deliveryOutcomes.values()].sort(
						(left, right) =>
							(runEventState.deliveryOrder.get(left.deliveryId) ?? Number.MAX_SAFE_INTEGER) -
							(runEventState.deliveryOrder.get(right.deliveryId) ?? Number.MAX_SAFE_INTEGER),
					),
				);
				deliveryFailure = runEventState.deliveryFailure;
				this.leasedDeliveryKinds.clear();
			}
		}

		const newMessages = terminalMessages ?? loopMessages;
		let response: AssistantMessage | undefined;
		for (let index = newMessages.length - 1; index >= 0; index--) {
			const message = newMessages[index]!;
			if (message.role === "assistant") {
				response = message;
				break;
			}
		}
		const result: AgentRunResult = deliveryFailure
			? { status: "delivery_failed", deliveries, failure: deliveryFailure }
			: { status: "completed", deliveries };
		return { result, response };
	}

	private async startPromptRun(
		resolveInvocation: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			messages: readonly AgentMessage[];
			beforeStart?: { text: string; options?: AgentHarnessPromptOptions };
			systemPrompt?: string;
			context?: readonly AgentMessage[];
		},
	): Promise<AgentHarnessExecutionResult> {
		this.assertNotDisposed();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		if (this.hasPendingPrompt()) {
			throw new AgentHarnessError(
				"invalid_state",
				"AgentHarness has a retained prompt; call continue() or discardPendingPrompt() before starting another",
			);
		}
		this.continuationState = undefined;
		this.invalidateContinuationContext();
		const run = this.admitBoundedRun();
		try {
			const baseTurnState = await this.createTurnState(run.state.abortController.signal, undefined, undefined, true);
			const invocation = resolveInvocation(baseTurnState);
			if (invocation.context !== undefined) {
				await this.rebaseContinuationContext({
					source: "explicit",
					project: () => invocation.context!,
				});
			}
			const deliveryId = await this.admitPromptDelivery(
				invocation.messages,
				invocation.beforeStart,
				invocation.systemPrompt,
			);
			const baseContextMessages =
				invocation.context === undefined ? baseTurnState.messages : cloneAgentMessages(invocation.context);
			const preflight = await this.preparePromptPreflight(
				deliveryId,
				{ ...baseTurnState, messages: baseContextMessages },
				run.state.abortController.signal,
			);
			const turnState = {
				...baseTurnState,
				messages: baseContextMessages,
				systemPrompt: preflight.systemPrompt,
			};
			const lastMessage = turnState.messages.at(-1);
			return await this.executeTurn(
				run.state,
				turnState,
				{
					firstDecision: true,
					requestAuthority: "provider",
					providerRequestPending: lastMessage !== undefined && lastMessage.role !== "assistant",
				},
				preflight.systemPromptOverride,
			);
		} catch (error) {
			throw normalizeHarnessError(error, "unknown");
		} finally {
			this.finishBoundedRun(run);
		}
	}

	private requireResponse(execution: AgentHarnessExecutionResult, operation: string): AssistantMessage {
		if (execution.response) return execution.response;
		throw new AgentHarnessError("delivery", `${operation} completed without an assistant response`);
	}

	async run(
		input: AgentMessage | readonly AgentMessage[],
		options: AgentHarnessRunOptions = {},
	): Promise<AgentRunResult> {
		const messages = cloneAgentMessages(Array.isArray(input) ? input : [input]);
		const ownedOptions = cloneRunOptions(options);
		return (
			await this.startPromptRun(() => ({
				messages,
				...(ownedOptions.systemPrompt === undefined ? {} : { systemPrompt: ownedOptions.systemPrompt }),
				...(ownedOptions.context === undefined ? {} : { context: ownedOptions.context }),
			}))
		).result;
	}

	async runPrompt(text: string, options?: AgentHarnessPromptOptions): Promise<AgentRunResult> {
		const ownedOptions = clonePromptOptions(options);
		const messages = [createUserMessage(text, ownedOptions?.images)];
		const beforeStart = { text, ...(ownedOptions === undefined ? {} : { options: ownedOptions }) };
		return (
			await this.startPromptRun(() => ({
				messages,
				beforeStart,
				...(ownedOptions?.systemPrompt === undefined ? {} : { systemPrompt: ownedOptions.systemPrompt }),
				...(ownedOptions?.context === undefined ? {} : { context: ownedOptions.context }),
			}))
		).result;
	}

	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		const ownedOptions = clonePromptOptions(options);
		const messages = [createUserMessage(text, ownedOptions?.images)];
		const beforeStart = { text, ...(ownedOptions === undefined ? {} : { options: ownedOptions }) };
		return this.requireResponse(
			await this.startPromptRun(() => ({
				messages,
				beforeStart,
				...(ownedOptions?.systemPrompt === undefined ? {} : { systemPrompt: ownedOptions.systemPrompt }),
				...(ownedOptions?.context === undefined ? {} : { context: ownedOptions.context }),
			})),
			"prompt()",
		);
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		const execution = await this.startPromptRun((turnState) => {
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			const text = formatSkillInvocation(skill, additionalInstructions);
			return { messages: [createUserMessage(text)], beforeStart: { text } };
		});
		return this.requireResponse(execution, "skill()");
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		const ownedArgs = [...args];
		const execution = await this.startPromptRun((turnState) => {
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			const text = formatPromptTemplateInvocation(template, ownedArgs);
			return { messages: [createUserMessage(text)], beforeStart: { text } };
		});
		return this.requireResponse(execution, "promptFromTemplate()");
	}

	async continue(
		options: { drainFollowUps?: boolean; context?: readonly AgentMessage[] } = {},
	): Promise<AgentRunResult> {
		const ownedContext = options.context === undefined ? undefined : cloneAgentMessages(options.context);
		const drainFollowUps = options.drainFollowUps === true;
		this.assertNotDisposed();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		try {
			if (ownedContext !== undefined) {
				await this.rebaseContinuationContext({
					source: "explicit",
					project: () => ownedContext,
				});
			}
			const continuationState = this.continuationState;
			const hasNextActionReducers =
				(this.getHandlers("next_action")?.size ?? 0) > 0 || this.nextActionPolicies.size > 0;
			let projection = await this.requireValidContextProjection();
			let contextMessages = projection?.messages ?? (await this.session.buildContext()).messages;
			let lastMessage = contextMessages.at(-1);
			if (!lastMessage && !this.hasQueuedMessages()) {
				throw new AgentHarnessError("invalid_state", "No messages to continue from");
			}
			if (
				lastMessage?.role === "assistant" &&
				!this.hasQueuedMessages() &&
				!hasNextActionReducers &&
				continuationState === undefined
			) {
				return { status: "completed", deliveries: [] };
			}
			if (!projection) {
				await this.rebaseContinuationContext({ source: "explicit" });
				projection = await this.requireValidContextProjection();
				if (!projection)
					throw new AgentHarnessError("invalid_state", "Continuation context rebase was not installed");
				contextMessages = projection.messages;
				lastMessage = contextMessages.at(-1);
				if (!lastMessage && !this.hasQueuedMessages()) {
					throw new AgentHarnessError("invalid_state", "No messages to continue from");
				}
				if (
					lastMessage?.role === "assistant" &&
					!this.hasQueuedMessages() &&
					!hasNextActionReducers &&
					continuationState === undefined
				) {
					this.invalidateContinuationContext();
					return { status: "completed", deliveries: [] };
				}
			}
			const run = this.admitBoundedRun();
			try {
				const pendingPrompt = this.deliveryInbox.list("prompt")[0];
				const promptPreparation =
					pendingPrompt === undefined ? undefined : this.deliveryPreparationStates.get(pendingPrompt.deliveryId);
				let systemPromptOverride = continuationState?.systemPrompt;
				const resolvedSystemPrompt =
					systemPromptOverride ??
					promptPreparation?.preflight?.systemPrompt ??
					promptPreparation?.resolvedSystemPrompt;
				let turnState = await this.createTurnState(
					run.state.abortController.signal,
					contextMessages,
					resolvedSystemPrompt,
					pendingPrompt !== undefined,
				);
				if (pendingPrompt !== undefined) {
					const preflight = await this.preparePromptPreflight(
						pendingPrompt.deliveryId,
						turnState,
						run.state.abortController.signal,
					);
					systemPromptOverride ??= preflight.systemPromptOverride;
					turnState = { ...turnState, systemPrompt: preflight.systemPrompt };
				}
				return (
					await this.executeTurn(
						run.state,
						turnState,
						{
							firstDecision: true,
							requestAuthority: continuationState?.requestAuthority ?? "provider",
							providerRequestPending:
								continuationState?.providerRequestPending ??
								(lastMessage !== undefined && lastMessage.role !== "assistant"),
							drainFollowUpsFirst: drainFollowUps || lastMessage?.role === "assistant",
						},
						systemPromptOverride,
					)
				).result;
			} finally {
				this.finishBoundedRun(run);
			}
		} catch (error) {
			throw normalizeHarnessError(error, "unknown");
		}
	}

	queueSteer(message: AgentMessage): string {
		this.assertNotDisposed();
		return this.enqueuePublishedDelivery("steer", [message]).deliveryId;
	}

	queueFollowUp(message: AgentMessage): string {
		this.assertNotDisposed();
		return this.enqueuePublishedDelivery("followUp", [message]).deliveryId;
	}

	async steer(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		this.assertNotDisposed();
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		const enqueued = this.enqueuePublishedDelivery("steer", [createUserMessage(text, options?.images)]);
		await enqueued.publication;
		return enqueued.deliveryId;
	}

	async followUp(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		this.assertNotDisposed();
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		const enqueued = this.enqueuePublishedDelivery("followUp", [createUserMessage(text, options?.images)]);
		await enqueued.publication;
		return enqueued.deliveryId;
	}

	async nextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		this.assertNotDisposed();
		this.nextTurnQueue.push(...cloneAgentMessages([createUserMessage(text, options?.images)]));
		await this.emitQueueUpdate();
	}

	hasQueuedMessages(): boolean {
		return this.deliveryInbox.hasPending();
	}

	hasPendingPrompt(): boolean {
		return this.deliveryInbox.hasPending("prompt");
	}

	canPrepareDelivery(deliveryId: string): boolean {
		return this.activeDeliveryLease?.canPrepare(deliveryId) ?? false;
	}

	private revokeDeliveries(kind: AgentDeliveryKind): readonly PendingDelivery[] {
		const revoked = this.deliveryInbox.revoke(kind);
		for (const delivery of revoked) {
			this.recordDeliveryOutcome({
				deliveryId: delivery.deliveryId,
				kind: delivery.kind,
				outcome: "revoked",
			});
			this.deliveryAttemptParticipants.delete(delivery.deliveryId);
			this.deliveryPreparationStates.delete(delivery.deliveryId);
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
		return revoked;
	}

	private async clearDeliveryKinds(kinds: readonly AgentDeliveryKind[]): Promise<string[]> {
		this.assertNotDisposed();
		const revoked = kinds.flatMap((kind) => this.revokeDeliveries(kind));
		if (revoked.length > 0) await this.emitQueueUpdate();
		return revoked.map((delivery) => delivery.deliveryId);
	}

	async clearSteeringQueue(): Promise<string[]> {
		return await this.clearDeliveryKinds(["steer"]);
	}

	async clearFollowUpQueue(): Promise<string[]> {
		return await this.clearDeliveryKinds(["followUp"]);
	}

	async clearAllQueues(): Promise<string[]> {
		return await this.clearDeliveryKinds(["steer", "followUp"]);
	}

	/** Revoke queued steer/follow-up ownership synchronously and publish the projection passively. */
	revokeAllQueues(): string[] {
		this.assertNotDisposed();
		const revoked = (["steer", "followUp"] as const).flatMap((kind) => this.revokeDeliveries(kind));
		if (revoked.length > 0) void this.emitQueueUpdate(true).catch(() => {});
		return revoked.map((delivery) => delivery.deliveryId);
	}

	async discardPendingPrompt(): Promise<string[]> {
		return await this.clearDeliveryKinds(["prompt"]);
	}

	/** Terminally fence the Harness without joining an in-flight callback or run. */
	dispose(source: AgentAbortSource = "disposal"): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = Promise.resolve();
		this.abort(source);
		const revoked = (["prompt", "steer", "followUp"] as const).flatMap((kind) => this.revokeDeliveries(kind));
		const hadNextTurnMessages = this.nextTurnQueue.length > 0;
		this.nextTurnQueue = [];
		this.pendingSessionWrites = [];
		this.deliveryInbox.reset();
		this.activeDeliveryLease = undefined;
		this.leasedDeliveryKinds.clear();
		this.deliveryAttemptParticipants.clear();
		this.deliveryPreparationStates.clear();
		this.continuationState = undefined;
		if (this.activeRun) delete this.activeRun.continuationCandidate;
		this.invalidateContinuationContext();
		if (revoked.length > 0 || hadNextTurnMessages) {
			void this.emitQueueUpdate(true).catch(() => {
				// Revocation is authoritative; passive disposal projection cannot undo it.
			});
		}
		return this.disposePromise;
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		this.assertNotDisposed();
		try {
			if (this.phase === "idle") {
				const entryId = await this.session.appendMessage(message);
				await this.advanceContextProjection(entryId, [message]);
			} else {
				this.pendingSessionWrites.push({ type: "message", message });
			}
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	async compact(customInstructions?: string): Promise<{
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		estimatedTokensAfter: number;
		details?: JsonValue;
	}> {
		this.assertNotDisposed();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const branchEntries = await this.session.getBranch();
			const activeTools = this.getActiveTools();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS, {
				tools: activeTools,
				contextWindow: model.contextWindow,
			});
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				...(customInstructions === undefined ? {} : { customInstructions }),
				signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(
						preparation,
						model,
						undefined,
						undefined,
						customInstructions,
						signal,
						this.thinkingLevel,
						await this.createStructuralStreamFn(),
					);
			if (!compactResult.ok) throw compactResult.error;
			const result = compactResult.value;
			const entryId = await this.session.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				provided === undefined ? undefined : true,
			);
			const entry = await this.session.getEntry(entryId);
			if (entry?.type === "compaction") {
				await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
			}
			const rebuiltContext = await this.session.buildContext();
			if (this.hasQueuedMessages() || this.continuationState) {
				await this.rebaseContinuationContext({ source: "compaction" });
			} else {
				this.invalidateContinuationContext();
			}
			const estimatedTokensAfter =
				estimateMessagesTokens(rebuiltContext.messages) + estimateToolDefinitionTokens(activeTools);
			return { ...result, estimatedTokensAfter };
		} catch (error) {
			throw normalizeHarnessError(error, "compaction");
		} finally {
			this.phase = "idle";
		}
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		this.assertNotDisposed();
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.phase = "branch_summary";
		try {
			const oldLeafId = await this.session.getLeafId();
			if (oldLeafId === targetId) return { cancelled: false };
			const targetEntry = await this.session.getEntry(targetId);
			if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
			const { entries, commonAncestorId } = await collectEntriesForBranchSummary(this.session, oldLeafId, targetId);
			const preparation = {
				targetId,
				oldLeafId,
				commonAncestorId,
				entriesToSummarize: entries,
				userWantsSummary: options?.summarize ?? false,
				...(options?.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
				...(options?.replaceInstructions === undefined ? {} : { replaceInstructions: options.replaceInstructions }),
				...(options?.label === undefined ? {} : { label: options.label }),
			};
			const signal = new AbortController().signal;
			const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
			if (hookResult?.cancel) return { cancelled: true };
			let summaryEntry: NavigateTreeResult["summaryEntry"];
			let summaryText: string | undefined = hookResult?.summary?.summary;
			let summaryDetails: JsonValue | undefined = hookResult?.summary?.details;
			if (!summaryText && options?.summarize && entries.length > 0) {
				const model = this.model;
				if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
				const customInstructions = hookResult?.customInstructions ?? options?.customInstructions;
				const replaceInstructions = hookResult?.replaceInstructions ?? options?.replaceInstructions;
				const branchSummary = await generateBranchSummary(entries, {
					model,
					signal,
					streamFn: await this.createStructuralStreamFn(),
					...(customInstructions === undefined ? {} : { customInstructions }),
					...(replaceInstructions === undefined ? {} : { replaceInstructions }),
				});
				if (!branchSummary.ok) {
					if (branchSummary.error.code === "aborted") return { cancelled: true };
					throw new AgentHarnessError("branch_summary", branchSummary.error.message, branchSummary.error);
				}
				summaryText = branchSummary.value.summary;
				summaryDetails = {
					readFiles: branchSummary.value.readFiles,
					modifiedFiles: branchSummary.value.modifiedFiles,
				};
			}
			let editorText: string | undefined;
			let newLeafId: string | null;
			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				const content = targetEntry.message.content;
				editorText =
					typeof content === "string"
						? content
						: content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { readonly type: "text"; readonly text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}
			const summaryId = await this.session.moveTo(
				newLeafId,
				summaryText
					? {
							summary: summaryText,
							...(summaryDetails === undefined ? {} : { details: summaryDetails }),
							...(hookResult?.summary === undefined ? {} : { fromHook: true }),
						}
					: undefined,
			);
			this.invalidateContinuationContext();
			if (summaryId) {
				const entry = await this.session.getEntry(summaryId);
				if (entry?.type === "branch_summary") summaryEntry = entry;
			}
			await this.emitOwn({
				type: "session_tree",
				newLeafId: await this.session.getLeafId(),
				oldLeafId,
				...(summaryEntry === undefined ? {} : { summaryEntry }),
				...(hookResult?.summary === undefined ? {} : { fromHook: true }),
			});
			return {
				cancelled: false,
				...(editorText === undefined ? {} : { editorText }),
				...(summaryEntry === undefined ? {} : { summaryEntry }),
			};
		} catch (error) {
			throw normalizeHarnessError(error, "branch_summary");
		} finally {
			this.phase = "idle";
		}
	}

	getModel(): Model<any> | undefined {
		return this.model;
	}

	async setModel(model: Model<any> | undefined, options: { persist?: boolean } = {}): Promise<void> {
		this.assertNotDisposed();
		try {
			const previousModel = this.model;
			if (options.persist !== false && model) {
				if (this.phase === "idle") {
					const entryId = await this.session.appendModelChange(model.provider, model.id);
					await this.advanceContextProjection(entryId);
				} else {
					this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
				}
			}
			this.model = model;
			await this.emitOwn({
				type: "model_update",
				model,
				previousModel,
				source: options.persist === false ? "restore" : "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel, options: { persist?: boolean } = {}): Promise<void> {
		this.assertNotDisposed();
		try {
			const previousLevel = this.thinkingLevel;
			if (options.persist !== false) {
				if (this.phase === "idle") {
					const entryId = await this.session.appendThinkingLevelChange(level);
					await this.advanceContextProjection(entryId);
				} else {
					this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
				}
			}
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		this.assertNotDisposed();
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.persistActiveToolChanges) {
				if (this.phase === "idle") {
					const entryId = await this.session.appendActiveToolsChange(nextActiveToolNames);
					await this.advanceContextProjection(entryId);
				} else {
					this.pendingSessionWrites.push({
						type: "active_tools_change",
						activeToolNames: [...nextActiveToolNames],
					});
				}
			}
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		this.assertNotDisposed();
		try {
			this.validateToolNames(toolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.persistActiveToolChanges) {
				if (this.phase === "idle") {
					const entryId = await this.session.appendActiveToolsChange(toolNames);
					await this.advanceContextProjection(entryId);
				} else {
					this.pendingSessionWrites.push({ type: "active_tools_change", activeToolNames: [...toolNames] });
				}
			}
			this.activeToolNames = [...toolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	registerNextActionPolicy(policy: AgentHarnessNextActionPolicy): () => void {
		this.assertNotDisposed();
		const registration = { policy };
		this.nextActionPolicies.add(registration);
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			this.nextActionPolicies.delete(registration);
		};
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.assertNotDisposed();
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.assertNotDisposed();
		this.followUpQueueMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			...(this.resources.skills === undefined ? {} : { skills: this.resources.skills.slice() }),
			...(this.resources.promptTemplates === undefined
				? {}
				: { promptTemplates: this.resources.promptTemplates.slice() }),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		this.assertNotDisposed();
		const previousResources = this.getResources();
		this.resources = {
			...(resources.skills === undefined ? {} : { skills: resources.skills.slice() }),
			...(resources.promptTemplates === undefined ? {} : { promptTemplates: resources.promptTemplates.slice() }),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.assertNotDisposed();
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	getPhase(): AgentHarnessPhase {
		return this.phase;
	}

	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	get activeDeliverySettlement(): Promise<void> | undefined {
		return this.activeRun?.deliverySettlement;
	}

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

	waitForIdle(): Promise<void> {
		return this.runPromise ?? Promise.resolve();
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessEvent<TSkill, TPromptTemplate>, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}
}
