import {
	type AssistantMessage,
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
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateMessagesTokens,
	prepareCompaction,
} from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessPromptOptions,
	AgentHarnessResources,
	AgentHarnessRunResult,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	PromptTemplate,
	Session,
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
	if (Object.hasOwn(patch, "maxRetries")) {
		if (patch.maxRetries === undefined) delete result.maxRetries;
		else result.maxRetries = patch.maxRetries;
	}
	if (Object.hasOwn(patch, "maxRetryDelayMs")) {
		if (patch.maxRetryDelayMs === undefined) delete result.maxRetryDelayMs;
		else result.maxRetryDelayMs = patch.maxRetryDelayMs;
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
		"Agent run failed and failure reporting failed",
	);
	return new AgentHarnessError("unknown", cause.message, cause);
}

interface AgentHarnessDeliveryEventState {
	remainingMessages: Set<AgentMessage>;
}

interface AgentHarnessRunEventState {
	id: string;
	abortController: AbortController;
	abortSource?: AgentAbortSource;
	requestAccepted: boolean;
	deliverySettlement: Promise<void> | undefined;
	deliveryOrder: Map<string, number>;
	deliveryOutcomes: Map<string, AgentDeliveryAttemptResult>;
	deliveryFailure?: AgentDeliveryFailure;
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
}

type PendingDelivery = InboxDelivery<AgentDeliveryKind, AgentMessage>;

type DispatcherStartState = {
	firstDecision: boolean;
	requestAuthority: AgentRequestAuthority;
	providerRequestPending: boolean;
	drainFollowUpsFirst?: boolean;
};

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	private phase: AgentHarnessPhase = "idle";
	private activeRun: AgentHarnessRunEventState | undefined;
	private runPromise: Promise<void> | undefined;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
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
	private readonly preparedDeliveryParticipants = new Map<string, AgentDeliveryTransactionParticipant>();
	private readonly prepareDelivery: AgentHarnessOptions["prepareDelivery"];
	private readonly deliveryRevoked: AgentHarnessOptions["deliveryRevoked"];
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
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
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	private async emitPassive(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(structuredClone(event), signal);
			} catch {
				// Committed delivery projections are observational and cannot alter settlement.
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

	private startRunPromise(): () => void {
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			finish();
		};
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
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

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const signal = streamOptions?.signal;
			if (signal?.aborted) return createAbortedAssistantStream(model);

			const turnState = getTurnState();
			let auth: { apiKey: string; headers?: Record<string, string> } | undefined;
			try {
				auth = await this.getApiKeyAndHeaders?.(model);
			} catch (error) {
				if (signal?.aborted) return createAbortedAssistantStream(model);
				throw error;
			}
			if (signal?.aborted) return createAbortedAssistantStream(model);

			const headers = mergeHeaders(turnState.streamOptions.headers, auth?.headers);
			const snapshotOptions: AgentHarnessStreamOptions = {
				...turnState.streamOptions,
				...(headers === undefined ? {} : { headers }),
			};
			const requestOptions = await this.emitBeforeProviderRequest(
				model,
				turnState.sessionId,
				snapshotOptions,
				signal,
			);
			if (signal?.aborted) return createAbortedAssistantStream(model);

			return streamSimple(model, context, {
				...(requestOptions.cacheRetention === undefined ? {} : { cacheRetention: requestOptions.cacheRetention }),
				...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
				...(requestOptions.maxRetries === undefined ? {} : { maxRetries: requestOptions.maxRetries }),
				...(requestOptions.maxRetryDelayMs === undefined
					? {}
					: { maxRetryDelayMs: requestOptions.maxRetryDelayMs }),
				...(requestOptions.metadata === undefined ? {} : { metadata: requestOptions.metadata }),
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn({ type: "after_provider_response", status: response.status, headers }, signal);
				},
				...(streamOptions?.reasoning === undefined ? {} : { reasoning: streamOptions.reasoning }),
				...(signal === undefined ? {} : { signal }),
				sessionId: turnState.sessionId,
				...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
				...(requestOptions.transport === undefined ? {} : { transport: requestOptions.transport }),
				...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			});
		};
	}

	private selectPendingDeliveries(kind: AgentDeliveryKind, mode: QueueMode): PendingDelivery[] {
		return [...this.deliveryInbox.select(kind, mode)];
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

		if (requestAuthority === "final_response") return runtimeAction;
		if (this.activeRun?.abortController.signal.aborted) return { type: "stop" };

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
		if (selected.length === 0) return hasIndependentRequest ? runtimeAction : { type: "stop" };

		const deliveries = await this.prepareLeasedDeliveries(selected);
		return {
			type: "request",
			reason: hasIndependentRequest ? "continuation" : "delivery",
			...(deliveries.length > 0 ? { deliveries } : {}),
		};
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

		const signal = this.activeRun?.abortController.signal;
		if (!signal) throw new AgentHarnessError("invalid_state", "Delivery preparation requires an active run");
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
							signal,
						)
					: { messages: cloneAgentMessages(delivery.messages) };
			} catch (error) {
				if (!lease.canPrepare(delivery.deliveryId)) continue;
				this.recordDeliveryFailure(delivery, "preparation", "retained", error);
				throw error;
			}
			if (this.activeDeliveryLease !== lease || !lease.canPrepare(delivery.deliveryId)) continue;
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
				messages: cloneAgentMessages(preparation.messages),
			});
		}
		return deliveries;
	}

	private async beginActiveDelivery(delivery: AgentLoopDelivery): Promise<AgentLoopDeliveryOutcome> {
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
		const participant = this.preparedDeliveryParticipants.get(delivery.deliveryId);
		try {
			if (participant) {
				try {
					outcome = await participant.settle({ requestAbort: (source) => this.requestAbort(source) });
				} catch (error) {
					outcome = { outcome: "terminally_failed", error: toError(error) };
				}
			} else {
				outcome = { outcome: "committed" };
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
			if (outcome.outcome === "committed") run?.observationalDeliveryIds.add(delivery.deliveryId);
			return outcome;
		} finally {
			this.preparedDeliveryParticipants.delete(delivery.deliveryId);
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
		const run = this.activeRun;
		if (!run || run.deliveryOutcomes.has(outcome.deliveryId)) return;
		run.deliveryOutcomes.set(outcome.deliveryId, Object.freeze(outcome));
		if ("error" in outcome && run.deliveryFailure === undefined) run.deliveryFailure = outcome;
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
		this.preparedDeliveryParticipants.clear();
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
		startState: DispatcherStartState,
	): AgentLoopConfig {
		const turnState = getTurnState();
		let firstRequest = true;
		return {
			model: turnState.model,
			...(turnState.thinkingLevel === "off" ? {} : { reasoning: turnState.thinkingLevel }),
			convertToLlm,
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
				});
				return result
					? {
							...(result.block === undefined ? {} : { block: result.block }),
							...(result.reason === undefined ? {} : { reason: result.reason }),
						}
					: undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const details = result.details as JsonValue | undefined;
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
					content: result.content,
					...(details === undefined ? {} : { details }),
					isError,
				});
				return patch
					? {
							...(patch.content === undefined ? {} : { content: patch.content }),
							...(patch.details === undefined ? {} : { details: patch.details }),
							...(patch.isError === undefined ? {} : { isError: patch.isError }),
							...(patch.disposition === undefined ? {} : { disposition: patch.disposition }),
						}
					: undefined;
			},
			nextAction: async (context) => await this.resolveNextAction(context, startState),
			beginDelivery: async (delivery) => await this.beginActiveDelivery(delivery),
			prepareRequest: async ({ context }) => {
				await this.flushPendingSessionWrites();
				if (firstRequest) {
					firstRequest = false;
					return {
						context,
						model: getTurnState().model,
						thinkingLevel: getTurnState().thinkingLevel,
					};
				}
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState),
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

	private async flushPendingSessionWrites(): Promise<void> {
		while (this.pendingSessionWrites.length > 0) {
			const write = this.pendingSessionWrites[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "active_tools_change") {
				await this.session.appendActiveToolsChange(write.activeToolNames);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			this.pendingSessionWrites.shift();
		}
	}

	private async handleAgentEvent(
		event: AgentEvent,
		state: AgentHarnessRunEventState,
		signal?: AbortSignal,
	): Promise<void> {
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
			return;
		}
		if (event.type === "message_start") {
			state.startedMessages.add(event.message);
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			if (observational) await this.emitPassive(event, signal);
			else await this.emitAny(event, signal);
			return;
		}
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
			if (!state.persistedMessageSet.has(event.message)) {
				state.persistedMessageSet.add(event.message);
				state.persistedMessages.push(event.message);
			}
			const deliveryState = state.deliveries.get(event.deliveryId);
			if (deliveryState?.remainingMessages.delete(event.message) && deliveryState.remainingMessages.size === 0) {
				state.deliveries.delete(event.deliveryId);
			}
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			if (observational) await this.emitPassive(event, signal);
			else await this.emitAny(event, signal);
			return;
		}
		if (event.type === "turn_start") {
			state.hasTurnStarted = true;
			state.turnOpen = true;
			state.requestAccepted = true;
			await this.emitAny(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			state.turnOpen = false;
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
			return;
		}
		if (event.type === "agent_end") {
			await this.flushPendingSessionWrites();
			this.phase = "idle";
			state.terminalEmitted = true;
			await this.emitAny(event, signal);
			await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async settleRunFailure(
		state: AgentHarnessRunEventState,
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
	): Promise<AgentMessage[]> {
		if (state.settlementStarted || state.terminalEmitted) {
			throw new AgentHarnessError("invalid_state", "Agent failure settlement already started");
		}
		state.settlementStarted = true;
		const settlementErrors: Error[] = [];
		const attempt = async (event: AgentEvent): Promise<void> => {
			try {
				await this.handleAgentEvent(event, state, signal);
			} catch (eventError) {
				settlementErrors.push(toError(eventError));
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
			await attempt({ type: "message_end", message: failureMessage });
			await attempt({ type: "turn_end", message: failureMessage, toolResults: [] });
		}
		const terminalMessages = [...state.persistedMessages];
		await attempt({ type: "agent_end", messages: terminalMessages });

		if (settlementErrors.length > 0) {
			throw combineEventErrors(settlementErrors, "Agent failure settlement notifications failed");
		}
		return terminalMessages;
	}

	private enqueueDelivery(kind: AgentDeliveryKind, messages: readonly AgentMessage[]): string {
		return this.deliveryInbox.enqueue(kind, cloneAgentMessages(messages)).deliveryId;
	}

	private async enqueuePromptDelivery(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: AgentHarnessPromptOptions,
	): Promise<string | undefined> {
		const nextTurnCount = this.nextTurnQueue.length;
		const nextTurnMessages = cloneAgentMessages(this.nextTurnQueue.slice(0, nextTurnCount));
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			...(options?.images === undefined ? {} : { images: structuredClone(options.images) }),
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		this.enqueueDelivery("prompt", [
			...nextTurnMessages,
			createUserMessage(text, options?.images),
			...(beforeResult?.messages ?? []),
		]);
		if (nextTurnCount > 0) {
			this.nextTurnQueue.splice(0, nextTurnCount);
			await this.emitQueueUpdate(true);
		}
		return beforeResult?.systemPrompt;
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		startState: DispatcherStartState,
		systemPrompt?: string,
	): Promise<AgentHarnessRunResult> {
		let activeTurnState = turnState;
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		const abortController = new AbortController();
		const runEventState: AgentHarnessRunEventState = {
			id: `harness-run:${globalThis.crypto.randomUUID()}`,
			abortController,
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
		};
		this.activeRun = runEventState;

		let loopMessages: AgentMessage[] = [];
		let terminalMessages: AgentMessage[] | undefined;
		let deliveries: readonly AgentDeliveryAttemptResult[] = [];
		let deliveryFailure: AgentDeliveryFailure | undefined;
		try {
			try {
				loopMessages = await runAgentLoop(
					[],
					this.createContext(turnState, systemPrompt),
					this.createLoopConfig(getTurnState, setTurnState, startState),
					async (event) => await this.handleAgentEvent(event, runEventState, abortController.signal),
					abortController.signal,
					this.createStreamFn(getTurnState),
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
				this.activeRun = undefined;
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
		return deliveryFailure
			? { status: "delivery_failed", deliveries, failure: deliveryFailure, response }
			: { status: "completed", deliveries, response };
	}

	private async startPromptRun(
		resolveInvocation: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			text: string;
			options?: AgentHarnessPromptOptions;
		},
	): Promise<AgentHarnessRunResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		if (this.hasPendingPrompt()) {
			throw new AgentHarnessError(
				"invalid_state",
				"AgentHarness has a retained prompt; call continue() or discardPendingPrompt() before starting another",
			);
		}
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const invocation = resolveInvocation(turnState);
			const systemPrompt = await this.enqueuePromptDelivery(turnState, invocation.text, invocation.options);
			const lastMessage = turnState.messages.at(-1);
			return await this.executeTurn(
				turnState,
				{
					firstDecision: true,
					requestAuthority: "provider",
					providerRequestPending: lastMessage !== undefined && lastMessage.role !== "assistant",
				},
				systemPrompt,
			);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	private requireResponse(result: AgentHarnessRunResult, operation: string): AssistantMessage {
		if (result.response) return result.response;
		throw new AgentHarnessError("delivery", `${operation} completed without an assistant response`);
	}

	async runPrompt(text: string, options?: AgentHarnessPromptOptions): Promise<AgentHarnessRunResult> {
		return await this.startPromptRun(() => ({ text, ...(options === undefined ? {} : { options }) }));
	}

	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		return this.requireResponse(await this.runPrompt(text, options), "prompt()");
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		const result = await this.startPromptRun((turnState) => {
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return { text: formatSkillInvocation(skill, additionalInstructions) };
		});
		return this.requireResponse(result, "skill()");
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		const result = await this.startPromptRun((turnState) => {
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return { text: formatPromptTemplateInvocation(template, args) };
		});
		return this.requireResponse(result, "promptFromTemplate()");
	}

	async continue(options: { drainFollowUps?: boolean } = {}): Promise<AgentHarnessRunResult> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const lastMessage = turnState.messages.at(-1);
			if (!lastMessage && !this.hasQueuedMessages()) {
				throw new AgentHarnessError("invalid_state", "No messages to continue from");
			}
			if (lastMessage?.role === "assistant" && !this.hasQueuedMessages()) {
				this.phase = "idle";
				return { status: "completed", deliveries: [], response: undefined };
			}
			return await this.executeTurn(turnState, {
				firstDecision: true,
				requestAuthority: "provider",
				providerRequestPending: lastMessage !== undefined && lastMessage.role !== "assistant",
				drainFollowUpsFirst: options.drainFollowUps === true || lastMessage?.role === "assistant",
			});
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async steer(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		const deliveryId = this.enqueueDelivery("steer", [createUserMessage(text, options?.images)]);
		await this.emitQueueUpdate();
		return deliveryId;
	}

	async followUp(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		const deliveryId = this.enqueueDelivery("followUp", [createUserMessage(text, options?.images)]);
		await this.emitQueueUpdate();
		return deliveryId;
	}

	async nextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
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
		return revoked;
	}

	private async clearDeliveryKinds(kinds: readonly AgentDeliveryKind[]): Promise<string[]> {
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

	async discardPendingPrompt(): Promise<string[]> {
		return await this.clearDeliveryKinds(["prompt"]);
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		try {
			if (this.phase === "idle") {
				await this.session.appendMessage(message);
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
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.phase = "compaction";
		try {
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const auth = await this.getApiKeyAndHeaders?.(model);
			if (!auth) throw new AgentHarnessError("auth", "No auth available for compaction");
			const branchEntries = await this.session.getBranch();
			const activeTools = this.getActiveTools();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS, {
				tools: activeTools,
				contextWindow: model.contextWindow,
			});
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const hookResult = await this.emitHook({
				type: "session_before_compact",
				preparation,
				branchEntries,
				...(customInstructions === undefined ? {} : { customInstructions }),
				signal: new AbortController().signal,
			});
			if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled");
			const provided = hookResult?.compaction;
			const compactResult = provided
				? { ok: true as const, value: provided }
				: await compact(
						preparation,
						model,
						auth.apiKey,
						auth.headers,
						customInstructions,
						undefined,
						this.thinkingLevel,
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
				const auth = await this.getApiKeyAndHeaders?.(model);
				if (!auth) throw new AgentHarnessError("auth", "No auth available for branch summary");
				const customInstructions = hookResult?.customInstructions ?? options?.customInstructions;
				const replaceInstructions = hookResult?.replaceInstructions ?? options?.replaceInstructions;
				const branchSummary = await generateBranchSummary(entries, {
					model,
					apiKey: auth.apiKey,
					...(auth.headers === undefined ? {} : { headers: auth.headers }),
					signal: new AbortController().signal,
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

	getModel(): Model<any> {
		return this.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			if (this.phase === "idle") {
				await this.session.appendModelChange(model.provider, model.id);
			} else {
				this.pendingSessionWrites.push({ type: "model_change", provider: model.provider, modelId: model.id });
			}
			this.model = model;
			await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			if (this.phase === "idle") {
				await this.session.appendThinkingLevelChange(level);
			} else {
				this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
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
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(nextActiveToolNames);
			} else {
				this.pendingSessionWrites.push({ type: "active_tools_change", activeToolNames: [...nextActiveToolNames] });
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
		try {
			this.validateToolNames(toolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(toolNames);
			} else {
				this.pendingSessionWrites.push({ type: "active_tools_change", activeToolNames: [...toolNames] });
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

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
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
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	private requestAbort(source?: AgentAbortSource): AgentAbortAcceptance {
		const run = this.activeRun;
		if (!run || run.terminalEmitted) {
			return Object.freeze({ runId: run?.id, accepted: false, source: run?.abortSource });
		}
		if (source !== undefined && run.abortSource === undefined) run.abortSource = source;
		run.abortController.abort();
		return Object.freeze({ runId: run.id, accepted: true, source: run.abortSource });
	}

	async abort(source?: AgentAbortSource): Promise<AbortResult> {
		const clearedSteer = cloneAgentMessages(this.revokeDeliveries("steer").flatMap((delivery) => delivery.messages));
		const clearedFollowUp = cloneAgentMessages(
			this.revokeDeliveries("followUp").flatMap((delivery) => delivery.messages),
		);
		this.requestAbort(source);
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({
				type: "abort",
				clearedSteer: cloneAgentMessages(clearedSteer),
				clearedFollowUp: cloneAgentMessages(clearedFollowUp),
			});
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		await this.runPromise;
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
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
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
