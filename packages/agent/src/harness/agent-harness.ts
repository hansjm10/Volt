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
	AgentDeliveryCommitOutcome,
	AgentDeliveryFailure,
	AgentDeliveryKind,
	AgentDeliveryOwner,
	AgentDeliveryPreparationOutcome,
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
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateMessagesTokens,
	prepareCompaction,
} from "./compaction/compaction.ts";
import { createCustomMessage, convertToLlm as defaultConvertToLlm } from "./messages.ts";
import { HarnessOperationCoordinator, type HarnessOperationLease } from "./operation-coordinator.ts";
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
	CanonicalCommitResult,
	ExecutionEnv,
	NavigateTreeResult,
	PendingSessionWrite,
	ProjectionAdvance,
	ProjectionCursor,
	PromptTemplate,
	Session,
	SessionMutationBatch,
	SessionMutationReceipt,
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

function areStructurallyEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => areStructurallyEqual(value, right[index]))
		);
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			areStructurallyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
	);
}

function isSameModel(left: Model<any> | undefined, right: Model<any> | undefined): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.provider === right.provider &&
			left.id === right.id &&
			left.api === right.api)
	);
}

function cloneRunOptions(options: AgentHarnessRunOptions): AgentHarnessRunOptions {
	return {
		...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
		...(options.context === undefined ? {} : { context: cloneAgentMessages(options.context) }),
		...(options.deliveryOwner === undefined ? {} : { deliveryOwner: options.deliveryOwner }),
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
	basisCursor: ProjectionCursor;
	ownedOverlayMessages: AgentMessage[];
	overlayEpoch: number;
	mode: "tail_append" | "replacement";
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
	operation: HarnessOperationLease;
	requestAccepted: boolean;
	deliverySettlement: Promise<void> | undefined;
	deliveryOrder: Map<string, number>;
	deliveryOutcomes: Map<string, AgentDeliveryAttemptResult>;
	deliveryFailure?: AgentDeliveryFailure;
	deliveryFailureDiagnostic?: AssistantMessageDiagnostic;
	canonicalAuthorityRetired?: boolean;
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
	operation: HarnessOperationLease;
}

export interface AgentHarnessRunReservation {
	readonly reservationId: string;
}

export interface AgentHarnessStructuralOperationContext {
	readonly signal: AbortSignal;
	readonly streamFn: StreamFn;
	sealAndCommit(batch: SessionMutationBatch): Promise<CanonicalCommitResult>;
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

function isTurnProviderRequestState(
	state: AgentHarnessProviderRequestState,
): state is AgentHarnessTurnState<Skill, PromptTemplate, AgentTool> {
	return "messages" in state;
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
	private readonly operations = new HarnessOperationCoordinator();
	private readonly closeDrains = new Set<Promise<void>>();
	private readonly closeDrainErrors: Error[] = [];
	private closePromise: Promise<void> | undefined;
	private readonly runReservations = new Map<string, HarnessOperationLease>();
	private activeRun: AgentHarnessRunEventState | undefined;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any> | undefined;
	private thinkingLevel: ThinkingLevel;
	private runtimeConfigurationEpoch = 0;
	private runtimeConfigurationBarrier: Promise<void> = Promise.resolve();
	private providerAdmissionBarrier: Promise<void> = Promise.resolve();
	private releaseProviderAdmission: (() => void) | undefined;
	private providerHookConfigurationAttempt = false;
	private providerHookPendingWrites: PendingSessionWrite[] | undefined;
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
	private readonly leasedDeliveries = new Map<string, PendingDelivery>();
	private readonly leasedDeliveryKinds = new Map<string, AgentDeliveryKind>();
	private readonly leasedDeliveryEpochs = new Map<string, number>();
	private readonly deliveryOwners = new Map<string, AgentDeliveryOwner>();
	private readonly deliveryAttemptIds = new Map<string, string>();
	private readonly deliveryPreparationSettlements = new Map<string, Promise<void>>();
	private readonly deliveryOwnerFinalizationBarriers = new Map<string, Promise<void>>();
	private readonly deliveryRevocationFinalizers = new Map<string, Promise<void>>();
	private readonly deliveryPreparationStates = new Map<string, AgentHarnessDeliveryPreparationState>();
	private readonly defaultDeliveryOwner: AgentDeliveryOwner;
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
		this.defaultDeliveryOwner = options.deliveryOwner ?? this.createDefaultDeliveryOwner();
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

	private createDefaultDeliveryOwner(): AgentDeliveryOwner {
		return {
			prepareLogical: (context) => ({
				outcome: "prepared",
				messages: cloneAgentMessages(context.sourceMessages),
			}),
			commitAttempt: async (context) => {
				try {
					const snapshot = await this.session.getBranchSnapshot();
					const attribution = {
						deliveryId: context.deliveryId,
						epoch: context.epoch,
						attemptId: context.attemptId,
					};
					const commit = await this.session.commitBatch({
						guard: { kind: "exact", cursor: snapshot.cursor },
						mutations: context.preparedMessages.map((message) => ({
							kind: "append" as const,
							entry: { type: "message" as const, message: structuredClone(message) },
						})),
						deliveryAttribution: attribution,
					});
					if (commit.outcome === "committed") return { outcome: "committed", receipt: commit.receipt };
					if (commit.outcome === "uncertain") {
						return { outcome: "terminally_failed", error: commit.error, authority: "retired" };
					}
					const current = await this.session.getBranchSnapshot();
					const noEffect = await this.session.commitBatch({
						guard: { kind: "descendant", cursor: current.cursor },
						mutations: [],
						deliveryAttribution: attribution,
					});
					if (noEffect.outcome === "committed") {
						return { outcome: "retained", error: commit.error, noEffectReceipt: noEffect.receipt };
					}
					return {
						outcome: "terminally_failed",
						error: noEffect.error,
						...(noEffect.outcome === "uncertain" ? { authority: "retired" as const } : {}),
					};
				} catch (error) {
					return { outcome: "terminally_failed", error: toError(error) };
				}
			},
			finish: () => undefined,
		};
	}

	private assertNotDisposed(): void {
		if (!this.operations.isOpen) throw new AgentHarnessError("invalid_state", "AgentHarness is disposed");
	}

	private async waitForProviderAdmission(): Promise<void> {
		await this.providerAdmissionBarrier;
	}

	private beginProviderAdmission(): void {
		if (this.releaseProviderAdmission) {
			throw new AgentHarnessError("invalid_state", "Provider admission is already active");
		}
		this.providerAdmissionBarrier = new Promise<void>((resolve) => {
			this.releaseProviderAdmission = resolve;
		});
	}

	private endProviderAdmission(): void {
		const release = this.releaseProviderAdmission;
		this.releaseProviderAdmission = undefined;
		release?.();
	}

	private orderRuntimeConfigurationWrite(write: () => Promise<void>): Promise<void> {
		const ordered = this.runtimeConfigurationBarrier.catch(() => {}).then(write);
		this.runtimeConfigurationBarrier = ordered;
		return ordered;
	}

	private trackCloseDrain(drain: Promise<void>): void {
		this.closeDrains.add(drain);
		void drain.then(
			() => this.closeDrains.delete(drain),
			(error) => {
				this.closeDrains.delete(drain);
				if (this.operations.isClosing) this.closeDrainErrors.push(toError(error));
			},
		);
	}

	private trackAdmittedMutation<TResult>(mutation: Promise<TResult>): Promise<TResult> {
		this.trackCloseDrain(mutation.then(() => undefined));
		return mutation;
	}

	private async drainClose(): Promise<void> {
		await this.operations.waitForIdle();
		for (;;) {
			const drains = [...this.closeDrains];
			if (drains.length === 0) break;
			await Promise.allSettled(drains);
		}
		if (this.closeDrainErrors.length > 0) {
			throw new AggregateError(this.closeDrainErrors, "AgentHarness close drains failed");
		}
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
				if (result?.block === true) current.block = true;
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
				const result = await handler(structuredClone(current), state.operation.abortGate.signal);
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
		const signal = this.activeRun?.operation.abortGate.signal;
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
	): Promise<{
		options: AgentHarnessStreamOptions;
		patches: readonly AgentHarnessStreamOptionsPatch[];
	}> {
		const handlers = this.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		const patches: AgentHarnessStreamOptionsPatch[] = [];
		if (!handlers || handlers.size === 0) return { options: current, patches };
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
					const patch = structuredClone(result.streamOptions);
					patches.push(patch);
					current = applyStreamOptionsPatch(current, patch);
				}
				if (signal?.aborted) break;
			} catch (error) {
				if (signal?.aborted) break;
				throw normalizeHookError(error);
			}
		}
		return { options: current, patches };
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
		if (passive) await this.emitPassive(event, this.activeRun?.operation.abortGate.signal);
		else await this.emitOwn(event, this.activeRun?.operation.abortGate.signal);
	}

	private admitBoundedRun(operation?: HarnessOperationLease): AgentHarnessBoundedRun {
		const admitted = operation ?? this.operations.reserve("turn");
		if (!admitted) throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.operations.start(admitted);
		const state: AgentHarnessRunEventState = {
			id: admitted.id,
			operation: admitted,
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
		this.activeRun = state;
		return { state, operation: admitted };
	}

	private finishBoundedRun(run: AgentHarnessBoundedRun): void {
		if (this.activeRun === run.state) this.activeRun = undefined;
		this.operations.finish(run.operation);
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
			if (signal?.aborted) {
				return createAbortedAssistantStream(model);
			}

			const requestState = getRequestState();
			let logicalHookWrites: PendingSessionWrite[] | undefined;
			for (;;) {
				const configurationBarrier = this.runtimeConfigurationBarrier;
				await configurationBarrier;
				if (signal?.aborted) return createAbortedAssistantStream(model);
				if (configurationBarrier !== this.runtimeConfigurationBarrier) continue;
				const configurationEpoch = this.runtimeConfigurationEpoch;
				const admittedModel = this.model ?? model;
				let admittedContext = context;
				let admittedReasoning = isTurnProviderRequestState(requestState)
					? this.thinkingLevel === "off"
						? undefined
						: this.thinkingLevel
					: streamOptions?.reasoning;
				let admittedAuth:
					| { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> }
					| undefined;
				try {
					admittedAuth = await this.getApiKeyAndHeaders?.(admittedModel);
				} catch (error) {
					if (signal?.aborted) return createAbortedAssistantStream(admittedModel);
					throw error;
				}
				if (signal?.aborted) return createAbortedAssistantStream(admittedModel);
				const headers = mergeHeaders(this.streamOptions.headers, admittedAuth?.headers);
				const env = mergeHeaders(this.streamOptions.env, admittedAuth?.env);
				const hookOptions: AgentHarnessStreamOptions = {
					...this.streamOptions,
					...(headers === undefined ? {} : { headers }),
					...(env === undefined ? {} : { env }),
				};
				let hookResult: { patches: readonly AgentHarnessStreamOptionsPatch[] };
				let hookWrites: PendingSessionWrite[] = [];
				this.providerHookConfigurationAttempt = true;
				this.providerHookPendingWrites = [];
				try {
					hookResult = await this.emitBeforeProviderRequest(
						admittedModel,
						requestState.sessionId,
						hookOptions,
						signal,
					);
				} finally {
					hookWrites = this.providerHookPendingWrites ?? [];
					this.providerHookPendingWrites = undefined;
					this.providerHookConfigurationAttempt = false;
				}
				if (logicalHookWrites === undefined) {
					logicalHookWrites = structuredClone(hookWrites);
				} else if (!areStructurallyEqual(logicalHookWrites, hookWrites)) {
					const error = new AgentHarnessError(
						"invalid_state",
						"before_provider_request produced different Harness mutations during configuration retry",
					);
					if (this.activeRun) this.activeRun.canonicalAuthorityRetired = true;
					this.requestClose("session_replacement");
					throw error;
				}
				if (signal?.aborted) return createAbortedAssistantStream(admittedModel);
				if (
					configurationEpoch !== this.runtimeConfigurationEpoch ||
					configurationBarrier !== this.runtimeConfigurationBarrier
				) {
					continue;
				}
				let requestOptions = hookOptions;
				for (const patch of hookResult.patches) {
					requestOptions = applyStreamOptionsPatch(requestOptions, patch);
				}
				let hookCommitBasis: ProjectionCursor | undefined;
				if (isTurnProviderRequestState(requestState)) {
					await this.flushPendingSessionWrites();
					const canonicalSnapshot = await this.session.getBranchSnapshot();
					hookCommitBasis = canonicalSnapshot.cursor;
					const projection = await this.requireValidContextProjection();
					const baseMessages = projection ? projection.ownedOverlayMessages : canonicalSnapshot.context.messages;
					const hookMessages = logicalHookWrites.flatMap((write) =>
						write.type === "message" ? [write.message] : [],
					);
					const freshMessages = [...baseMessages, ...hookMessages];
					const retainsPreparedPrefix =
						requestState.messages.length <= freshMessages.length &&
						requestState.messages.every((message, index) => areStructurallyEqual(message, freshMessages[index]));
					const appendedMessages = freshMessages.slice(requestState.messages.length);
					const llmMessages = retainsPreparedPrefix
						? [
								...context.messages,
								...(appendedMessages.length === 0
									? []
									: await this.convertMessages(cloneAgentMessages(appendedMessages))),
							]
						: await this.convertMessages(cloneAgentMessages(freshMessages));
					const activeTools = this.activeToolNames
						.map((name) => this.tools.get(name))
						.filter((tool): tool is TTool => tool !== undefined);
					const preparedTools = context.tools ?? [];
					const preparedToolsMatch =
						preparedTools.length === requestState.activeTools.length &&
						preparedTools.every((tool, index) => tool === requestState.activeTools[index]);
					admittedContext = {
						systemPrompt:
							context.systemPrompt === requestState.systemPrompt
								? requestState.systemPrompt
								: (context.systemPrompt ?? requestState.systemPrompt),
						messages: llmMessages,
						tools: preparedToolsMatch ? activeTools : preparedTools,
					};
					admittedReasoning = this.thinkingLevel === "off" ? undefined : this.thinkingLevel;
				} else if (logicalHookWrites.length > 0) {
					hookCommitBasis = (await this.session.getBranchSnapshot()).cursor;
				}
				if (
					configurationEpoch !== this.runtimeConfigurationEpoch ||
					configurationBarrier !== this.runtimeConfigurationBarrier
				) {
					continue;
				}
				this.beginProviderAdmission();
				if (configurationEpoch !== this.runtimeConfigurationEpoch) {
					this.endProviderAdmission();
					continue;
				}
				try {
					if (logicalHookWrites.length > 0) {
						if (!hookCommitBasis) {
							throw new AgentHarnessError("invalid_state", "Provider hook mutation basis is unavailable");
						}
						const commit = await this.session.commitBatch({
							guard: { kind: "exact", cursor: hookCommitBasis },
							mutations: logicalHookWrites.map((entry) => ({ kind: "append" as const, entry })),
						});
						if (commit.outcome === "rolled_back") {
							this.endProviderAdmission();
							continue;
						}
						if (commit.outcome === "uncertain") {
							if (this.activeRun) this.activeRun.canonicalAuthorityRetired = true;
							this.requestClose("session_replacement");
							throw commit.error;
						}
						this.applyVerifiedProjectionAdvance(commit.advance);
					}
					if (signal?.aborted) return createAbortedAssistantStream(admittedModel);
					const response = this.streamFn(admittedModel, admittedContext, {
						...(requestOptions.cacheRetention === undefined
							? {}
							: { cacheRetention: requestOptions.cacheRetention }),
						...(requestOptions.env === undefined ? {} : { env: requestOptions.env }),
						...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
						...(requestOptions.inferenceSpeed === undefined
							? {}
							: { inferenceSpeed: requestOptions.inferenceSpeed }),
						...(requestOptions.maxRetries === undefined ? {} : { maxRetries: requestOptions.maxRetries }),
						...(requestOptions.maxRetryDelayMs === undefined
							? {}
							: { maxRetryDelayMs: requestOptions.maxRetryDelayMs }),
						...(requestOptions.metadata === undefined ? {} : { metadata: requestOptions.metadata }),
						...(requestOptions.thinkingBudgets === undefined
							? {}
							: { thinkingBudgets: requestOptions.thinkingBudgets }),
						onPayload: async (payload) => await this.emitBeforeProviderPayload(admittedModel, payload),
						onResponse: async (response) => {
							const headers = { ...(response.headers as Record<string, string>) };
							await this.emitOwn({ type: "after_provider_response", status: response.status, headers }, signal);
						},
						...(streamOptions?.maxTokens === undefined ? {} : { maxTokens: streamOptions.maxTokens }),
						...(admittedReasoning === undefined ? {} : { reasoning: admittedReasoning }),
						...(signal === undefined ? {} : { signal }),
						sessionId: requestState.sessionId,
						...(streamOptions?.temperature === undefined ? {} : { temperature: streamOptions.temperature }),
						...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
						...(requestOptions.transport === undefined ? {} : { transport: requestOptions.transport }),
						...(requestOptions.websocketConnectTimeoutMs === undefined
							? {}
							: { websocketConnectTimeoutMs: requestOptions.websocketConnectTimeoutMs }),
						...(admittedAuth?.apiKey === undefined ? {} : { apiKey: admittedAuth.apiKey }),
					});
					this.endProviderAdmission();
					return response;
				} finally {
					if (this.releaseProviderAdmission) this.endProviderAdmission();
				}
			}
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
			let advance: ProjectionAdvance;
			try {
				advance = await this.session.advanceProjection(projection.basisCursor);
			} catch (error) {
				if (this.contextProjection !== projection) continue;
				throw this.recordContextProjectionInvalid(projection, normalizeHarnessError(error, "session"));
			}
			if (this.contextProjection !== projection) continue;
			if (advance.branchRelation === "diverged" || advance.messages.kind === "rewrite") {
				throw this.recordContextProjectionInvalid(projection, this.staleContextProjectionError());
			}
			const updated: AgentHarnessContextProjection = {
				...projection,
				basisCursor: advance.cursor,
				ownedOverlayMessages:
					advance.messages.kind === "append"
						? [...projection.ownedOverlayMessages, ...cloneAgentMessages(advance.messages.values)]
						: projection.ownedOverlayMessages,
				overlayEpoch: projection.overlayEpoch + 1,
			};
			this.contextProjection = updated;
			return updated;
		}
	}

	private async advanceContextProjection(_entryId?: string, _messages?: readonly AgentMessage[]): Promise<void> {
		if (!this.contextProjection) return;
		await this.requireValidContextProjection();
	}

	async rebaseContinuationContext(
		options: AgentHarnessContextRebaseOptions,
	): Promise<AgentHarnessContextProjectionToken> {
		this.assertNotDisposed();
		const source = options.source;
		const project = options.project;
		const mutation = (async () => {
			try {
				const snapshot = await this.session.getBranchSnapshot();
				const canonicalMessages = Object.freeze(cloneAgentMessages(snapshot.context.messages));
				const projectedMessages = project ? project(canonicalMessages) : canonicalMessages;
				const ownedMessages = cloneAgentMessages(projectedMessages);
				const token = Object.freeze({
					projectionId: `harness-context:${globalThis.crypto.randomUUID()}`,
					source,
					anchorLeafId: snapshot.cursor.branchIdentity,
				});
				this.contextProjection = {
					token,
					basisCursor: snapshot.cursor,
					ownedOverlayMessages: ownedMessages,
					overlayEpoch: (this.contextProjection?.overlayEpoch ?? 0) + 1,
					mode: source === "compaction" ? "replacement" : "tail_append",
				};
				return token;
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		})();
		return await this.trackAdmittedMutation(mutation);
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

		if (run.operation.abortGate.signal.aborted) {
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

	private async prepareLeasedDeliveries(selected: PendingDelivery[]): Promise<AgentLoopDelivery[]> {
		const lease = this.deliveryInbox.lease(selected);
		this.activeDeliveryLease = lease;
		for (const delivery of lease.deliveries) {
			this.leasedDeliveries.set(delivery.deliveryId, delivery);
			this.leasedDeliveryKinds.set(delivery.deliveryId, delivery.kind);
			this.leasedDeliveryEpochs.set(delivery.deliveryId, delivery.epoch);
			const run = this.activeRun;
			if (run && !run.deliveryOrder.has(delivery.deliveryId)) {
				run.deliveryOrder.set(delivery.deliveryId, run.deliveryOrder.size);
			}
		}

		const run = this.activeRun;
		if (!run) throw new AgentHarnessError("invalid_state", "Delivery preparation requires an active run");
		const signal = run.operation.abortGate.signal;
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			const attempt = lease.prepare(delivery.deliveryId);
			if (!attempt) continue;
			this.deliveryAttemptIds.set(delivery.deliveryId, attempt.attemptId);
			const owner = this.deliveryOwners.get(delivery.deliveryId);
			if (!owner) {
				throw new AgentHarnessError("delivery", `Delivery ${delivery.deliveryId} has no owner`);
			}
			const preparationState = this.deliveryPreparationStates.get(delivery.deliveryId) ?? {};
			if (!this.deliveryPreparationStates.has(delivery.deliveryId)) {
				this.deliveryPreparationStates.set(delivery.deliveryId, preparationState);
			}
			const sourceMessages = preparationState.preflight?.messages ?? delivery.messages;
			if (preparationState.preparedMessages === undefined) {
				let preparation: AgentDeliveryPreparationOutcome;
				let resolvePreparationSettlement = (): void => undefined;
				const preparationSettlement = new Promise<void>((resolve) => {
					resolvePreparationSettlement = resolve;
				});
				this.deliveryPreparationSettlements.set(delivery.deliveryId, preparationSettlement);
				try {
					preparation = await owner.prepareLogical(
						Object.freeze({
							deliveryId: delivery.deliveryId,
							kind: delivery.kind,
							epoch: delivery.epoch,
							attemptId: attempt.attemptId,
							sourceMessages: Object.freeze(cloneAgentMessages(sourceMessages)),
							signal,
							requestAbort: (source?: AgentAbortSource) => this.abort(source),
							requestClose: (source?: AgentAbortSource) => this.requestClose(source),
						}),
					);
				} catch (error) {
					preparation = { outcome: "terminally_failed" as const, error: toError(error) };
				}
				resolvePreparationSettlement();
				if (this.deliveryPreparationSettlements.get(delivery.deliveryId) === preparationSettlement) {
					this.deliveryPreparationSettlements.delete(delivery.deliveryId);
				}
				if (!lease.owns(delivery.deliveryId)) continue;
				if (preparation.outcome !== "prepared") {
					await this.settlePreparationFailure(
						lease,
						delivery,
						attempt.attemptId,
						preparation.outcome,
						preparation.error,
					);
					return deliveries;
				}
				let ownedMessages: AgentMessage[];
				try {
					ownedMessages = cloneAgentMessages(preparation.messages);
				} catch (error) {
					const failure = toError(error);
					await this.settlePreparationFailure(lease, delivery, attempt.attemptId, "terminally_failed", failure);
					return deliveries;
				}
				if (ownedMessages.length === 0) {
					const error = new Error("Delivery preparation must retain at least one message");
					await this.settlePreparationFailure(lease, delivery, attempt.attemptId, "terminally_failed", error);
					return deliveries;
				}
				preparationState.preparedMessages = ownedMessages;
			}
			const preparedMessages = preparationState.preparedMessages;
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
					if (this.activeDeliveryLease !== lease || !lease.owns(delivery.deliveryId)) continue;
					preparationState.reducedMessages = cloneAgentMessages(reducedMessages);
				} catch (error) {
					if (!lease.owns(delivery.deliveryId)) continue;
					await this.settlePreparationFailure(lease, delivery, attempt.attemptId, "terminally_failed", error);
					return deliveries;
				}
			}
			if (!lease.completePreparation(delivery.deliveryId, attempt.attemptId, "prepared")) continue;
			deliveries.push({
				deliveryId: delivery.deliveryId,
				messages: cloneAgentMessages(preparationState.reducedMessages),
			});
		}
		return deliveries;
	}

	private async beginActiveDelivery(delivery: AgentLoopDelivery): Promise<AgentLoopDeliveryOutcome> {
		if (!this.operations.isOpen) return { outcome: "revoked" };
		if (delivery.deliveryId === undefined) return { outcome: "committed" };
		const kind = this.leasedDeliveryKinds.get(delivery.deliveryId);
		if (kind === undefined) return { outcome: "committed" };
		const lease = this.activeDeliveryLease;
		const attemptId = this.deliveryAttemptIds.get(delivery.deliveryId);
		const owner = this.deliveryOwners.get(delivery.deliveryId);
		if (!lease?.owns(delivery.deliveryId) || !attemptId || !owner) {
			this.recordDeliveryOutcome({ deliveryId: delivery.deliveryId, kind, outcome: "revoked" });
			return { outcome: "revoked" };
		}
		// All fallible projection validation happens before the irrevocable cutoff.
		await this.requireValidContextProjection();
		if (!lease.beginCommit(delivery.deliveryId, attemptId)) {
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

		let outcome: AgentDeliveryCommitOutcome;
		try {
			try {
				outcome = await owner.commitAttempt(
					Object.freeze({
						deliveryId: delivery.deliveryId,
						kind,
						epoch: this.leasedDeliveryEpochs.get(delivery.deliveryId) ?? 0,
						attemptId,
						preparedMessages: Object.freeze(cloneAgentMessages(delivery.messages)),
						signal: run?.operation.abortGate.signal ?? new AbortController().signal,
						requestAbort: (source?: AgentAbortSource) => this.abort(source),
						requestClose: (source?: AgentAbortSource) => this.requestClose(source),
					}),
				);
			} catch (error) {
				outcome = { outcome: "terminally_failed", error: toError(error) };
			}
			if (outcome.outcome === "terminally_failed" && outcome.authority === "retired") {
				if (run) run.canonicalAuthorityRetired = true;
				this.requestClose("session_replacement");
			}
			const verified = this.verifyDeliveryOutcome(
				delivery.deliveryId,
				kind,
				this.leasedDeliveryEpochs.get(delivery.deliveryId) ?? 0,
				attemptId,
				delivery.messages,
				outcome,
			);
			outcome = verified.outcome;
			const ownedDelivery = this.leasedDeliveries.get(delivery.deliveryId);
			const finishError = ownedDelivery
				? await this.finishDeliveryOwner(ownedDelivery, attemptId, outcome)
				: undefined;
			if (finishError) {
				if (outcome.outcome === "committed") {
					this.invalidateContinuationContext();
					this.closeDrainErrors.push(finishError);
					this.requestClose("session_replacement");
				} else {
					outcome = {
						outcome: "terminally_failed",
						error: new AggregateError(
							["error" in outcome ? outcome.error : new Error("Delivery failed"), finishError],
							"Delivery outcome and owner finalization failed",
						),
					};
				}
			}

			if (!lease.settleCommit(delivery.deliveryId, attemptId, outcome.outcome)) {
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
				if (verified.advance) this.applyVerifiedProjectionAdvance(verified.advance);
			}
			return outcome;
		} finally {
			this.deliveryAttemptIds.delete(delivery.deliveryId);
			finishSettlement();
			if (run && this.activeRun === run && run.deliverySettlement === settlement) {
				run.deliverySettlement = undefined;
			}
		}
	}

	private verifyDeliveryOutcome(
		deliveryId: string,
		_kind: AgentDeliveryKind,
		epoch: number,
		attemptId: string,
		messages: readonly AgentMessage[],
		outcome: AgentDeliveryCommitOutcome,
	): { outcome: AgentDeliveryCommitOutcome; advance?: ProjectionAdvance } {
		if (outcome.outcome === "terminally_failed") return { outcome };
		const rawReceipt = outcome.outcome === "committed" ? outcome.receipt : outcome.noEffectReceipt;
		const resolved = this.session.resolveMutationReceipt(rawReceipt as SessionMutationReceipt);
		const attribution = resolved?.deliveryAttribution;
		const attributed =
			attribution?.deliveryId === deliveryId && attribution.epoch === epoch && attribution.attemptId === attemptId;
		const expectedMessages = outcome.outcome === "committed" ? "append" : "unchanged";
		const exactMessages =
			resolved?.advance.messages.kind === "unchanged"
				? expectedMessages === "unchanged"
				: resolved?.advance.messages.kind === "append"
					? expectedMessages === "append" && areStructurallyEqual(resolved.advance.messages.values, messages)
					: false;
		const exactRetainedEffect =
			outcome.outcome !== "retained" ||
			(resolved?.advance.branchRelation === "same" && resolved.appendedEntryIds.length === 0);
		if (
			resolved &&
			attributed &&
			exactMessages &&
			exactRetainedEffect &&
			!resolved.advance.persistedPolicyChanged &&
			resolved.advance.branchRelation !== "diverged"
		) {
			return { outcome, advance: resolved.advance };
		}
		const error = new AgentHarnessError(
			"delivery",
			`Delivery owner returned an invalid canonical receipt for ${deliveryId} (${[
				resolved ? undefined : "unknown receipt",
				attributed ? undefined : "attribution mismatch",
				exactMessages ? undefined : "message effect mismatch",
				exactRetainedEffect ? undefined : "retained receipt changed canonical state",
				resolved?.advance.persistedPolicyChanged ? "persisted policy changed" : undefined,
				resolved?.advance.branchRelation === "diverged" ? "branch diverged" : undefined,
			]
				.filter((reason) => reason !== undefined)
				.join(", ")})`,
		);
		this.requestClose("session_replacement");
		return { outcome: { outcome: "terminally_failed", error } };
	}

	private applyVerifiedProjectionAdvance(advance: ProjectionAdvance): void {
		const projection = this.contextProjection;
		if (!projection || projection.invalidError) return;
		if (advance.branchRelation === "diverged" || advance.messages.kind === "rewrite") {
			this.recordContextProjectionInvalid(projection, this.staleContextProjectionError());
			return;
		}
		this.contextProjection = {
			...projection,
			basisCursor: advance.cursor,
			ownedOverlayMessages:
				advance.messages.kind === "append"
					? [...projection.ownedOverlayMessages, ...cloneAgentMessages(advance.messages.values)]
					: projection.ownedOverlayMessages,
			overlayEpoch: projection.overlayEpoch + 1,
		};
	}

	private async finishDeliveryOwner(
		delivery: Pick<PendingDelivery, "deliveryId" | "kind" | "epoch">,
		attemptId: string | undefined,
		result:
			| { outcome: "committed"; receipt: unknown }
			| { outcome: "retained"; error: Error; noEffectReceipt?: unknown }
			| { outcome: "terminally_failed"; error: Error; failureReceipt?: unknown }
			| { outcome: "revoked" },
	): Promise<Error | undefined> {
		const owner = this.deliveryOwners.get(delivery.deliveryId);
		if (!owner) return undefined;
		const receipt =
			result.outcome === "committed"
				? result.receipt
				: result.outcome === "retained"
					? result.noEffectReceipt
					: result.outcome === "terminally_failed"
						? result.failureReceipt
						: undefined;
		const previous = this.deliveryOwnerFinalizationBarriers.get(delivery.deliveryId);
		const execute = async (): Promise<Error | undefined> => {
			try {
				await owner.finish(
					Object.freeze({
						deliveryId: delivery.deliveryId,
						kind: delivery.kind,
						epoch: delivery.epoch,
						attemptId,
						outcome: result.outcome,
						...(receipt === undefined ? {} : { receipt }),
						...("error" in result ? { error: result.error } : {}),
					}),
				);
			} catch (error) {
				return toError(error);
			}
			return undefined;
		};
		const finalization = previous ? previous.catch(() => {}).then(execute) : execute();
		const barrier = finalization.then(() => undefined);
		this.deliveryOwnerFinalizationBarriers.set(delivery.deliveryId, barrier);
		const error = await finalization;
		if (this.deliveryOwnerFinalizationBarriers.get(delivery.deliveryId) === barrier) {
			this.deliveryOwnerFinalizationBarriers.delete(delivery.deliveryId);
		}
		if (result.outcome !== "retained") this.deliveryOwners.delete(delivery.deliveryId);
		return error;
	}

	private async settlePreparationFailure(
		lease: DeliveryLease<AgentDeliveryKind, AgentMessage>,
		delivery: PendingDelivery,
		attemptId: string,
		outcome: "retained" | "terminally_failed",
		error: unknown,
	): Promise<void> {
		const failure = toError(error);
		const finishError = await this.finishDeliveryOwner(delivery, attemptId, { outcome, error: failure });
		const finalOutcome = finishError ? "terminally_failed" : outcome;
		const finalError = finishError
			? new AggregateError([failure, finishError], "Delivery preparation and owner finalization failed")
			: failure;
		if (finishError) this.deliveryOwners.delete(delivery.deliveryId);
		const completed = lease.completePreparation(delivery.deliveryId, attemptId, finalOutcome);
		if (finishError) {
			this.activeRun?.deliveryOutcomes.delete(delivery.deliveryId);
			this.recordDeliveryFailure(delivery, "preparation", finalOutcome, finalError);
		} else if (completed) {
			this.recordDeliveryFailure(delivery, "preparation", finalOutcome, finalError);
		}
		if (finishError) this.requestClose("session_replacement");
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

	private async rollbackActiveLease(): Promise<void> {
		const lease = this.activeDeliveryLease;
		const restored = this.deliveryInbox.rollbackActiveLease();
		const finalizerErrors: Error[] = [];
		for (const delivery of restored) {
			const attemptId = this.deliveryAttemptIds.get(delivery.deliveryId);
			this.deliveryAttemptIds.delete(delivery.deliveryId);
			const finishError = await this.finishDeliveryOwner(delivery, attemptId, {
				outcome: "retained",
				error: new Error("Delivery attempt ended before commit"),
			});
			if (finishError) {
				lease?.settleRollback(delivery.deliveryId, "terminally_failed");
				finalizerErrors.push(finishError);
				this.deliveryOwners.delete(delivery.deliveryId);
				this.recordDeliveryFailure(delivery, "settlement", "terminally_failed", finishError);
			} else {
				lease?.settleRollback(delivery.deliveryId, "retained");
				this.recordDeliveryOutcome({
					deliveryId: delivery.deliveryId,
					kind: delivery.kind,
					outcome: "retained",
				});
			}
		}
		this.activeDeliveryLease = undefined;
		if (finalizerErrors.length > 0) {
			const error = new AggregateError(finalizerErrors, "Delivery rollback owner finalization failed");
			this.closeDrainErrors.push(error);
			this.requestClose("session_replacement");
			throw error;
		}
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
			prepareRequest: async () => {
				await this.flushPendingSessionWrites();
				await this.runtimeConfigurationBarrier;
				const projection = await this.requireValidContextProjection();
				const contextMessages = projection
					? projection.ownedOverlayMessages
					: (await this.session.getBranchSnapshot()).context.messages;
				const nextTurnState = await this.createTurnState(
					run.operation.abortGate.signal,
					contextMessages,
					systemPromptOverride,
				);
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
			state.operation.abortGate.signal.aborted &&
			state.operation.abortSource !== undefined &&
			state.operation.diagnosticTimestamp !== undefined
		) {
			message = {
				...message,
				diagnostics: [
					...(message.diagnostics ?? []).filter((diagnostic) => diagnostic.type !== "runtime_abort"),
					{
						type: "runtime_abort",
						timestamp: state.operation.diagnosticTimestamp,
						details: { source: state.operation.abortSource },
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
			const isTerminalAssistant = event.message.role === "assistant" && event.message.stopReason !== "toolUse";
			const sealsOperation = isTerminalAssistant && !this.hasQueuedMessages();
			if (sealsOperation) {
				state.phase = "terminal_event_settling";
			}
			const observational = event.deliveryId !== undefined && state.observationalDeliveryIds.has(event.deliveryId);
			const finalizedEvent = observational
				? this.decorateRuntimeDiagnostics(event, state)
				: await this.emitMessageEnd(event, state);
			if (finalizedEvent.type !== "message_end") {
				throw new AgentHarnessError("invalid_state", "Runtime diagnostic decoration changed the event type");
			}
			if (sealsOperation) this.operations.sealTerminal(state.operation);
			if (!observational) {
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
			this.operations.beginNotifications(state.operation);
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
		if (state.canonicalAuthorityRetired) {
			state.terminalEmitted = true;
			state.phase = "settled";
			this.operations.beginNotifications(state.operation);
			await this.emitPassive({ type: "agent_end", messages: [] }, signal);
			await this.emitPassive({ type: "settled", nextTurnCount: 0 }, signal);
			return [];
		}
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

	private enqueueDelivery(
		kind: AgentDeliveryKind,
		messages: readonly AgentMessage[],
		owner: AgentDeliveryOwner = this.defaultDeliveryOwner,
	): string {
		const delivery = this.deliveryInbox.enqueue(kind, cloneAgentMessages(messages));
		this.deliveryOwners.set(delivery.deliveryId, owner);
		return delivery.deliveryId;
	}

	/** Admit a stable owner before a low-level delivery becomes visible to dispatch. */
	admitDelivery(kind: AgentDeliveryKind, messages: readonly AgentMessage[], owner: AgentDeliveryOwner): string {
		this.assertNotDisposed();
		if (messages.length === 0) {
			throw new AgentHarnessError("invalid_argument", "A delivery must contain at least one message");
		}
		return this.enqueueDelivery(kind, messages, owner);
	}

	private enqueuePublishedDelivery(
		kind: "steer" | "followUp",
		messages: readonly AgentMessage[],
		owner?: AgentDeliveryOwner,
	): { deliveryId: string; publication: Promise<void> } {
		const deliveryId = this.enqueueDelivery(kind, messages, owner);
		const publication = this.emitQueueUpdate(true);
		this.trackCloseDrain(publication);
		void publication.catch(() => {});
		return { deliveryId, publication };
	}

	private async admitPromptDelivery(
		messages: readonly AgentMessage[],
		beforeStart?: { text: string; options?: AgentHarnessPromptOptions },
		systemPromptOverride?: string,
		owner?: AgentDeliveryOwner,
	): Promise<string> {
		if (messages.length === 0) {
			throw new AgentHarnessError("invalid_argument", "A prompt delivery must contain at least one message");
		}
		const nextTurnCount = this.nextTurnQueue.length;
		const admittedMessages = [
			...cloneAgentMessages(this.nextTurnQueue.slice(0, nextTurnCount)),
			...cloneAgentMessages(messages),
		];
		const deliveryId = this.enqueueDelivery("prompt", admittedMessages, owner);
		this.deliveryPreparationStates.set(deliveryId, {
			admittedMessages: cloneAgentMessages(admittedMessages),
			...(beforeStart === undefined
				? {}
				: {
						beforeStart: {
							text: beforeStart.text,
							...(beforeStart.options === undefined
								? {}
								: { options: clonePromptOptions(beforeStart.options)! }),
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
		const abortGate = runEventState.operation.abortGate;
		if (this.contextProjection) {
			await this.requireValidContextProjection();
		}
		runEventState.continuationCandidate = {
			requestAuthority: startState.requestAuthority,
			providerRequestPending: startState.providerRequestPending,
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
		};
		if (abortGate.signal.aborted && this.hasQueuedMessages()) {
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
					async (event) => await this.handleAgentEvent(event, runEventState, abortGate.signal),
					abortGate.signal,
					this.createPolicyStreamFn(getTurnState),
				);
			} catch (error) {
				try {
					await this.rollbackActiveLease();
				} catch (rollbackError) {
					throw createFailureSettlementError(error, rollbackError);
				}
				if (runEventState.settlementStarted || runEventState.terminalEmitted) throw error;
				try {
					terminalMessages = await this.settleRunFailure(
						runEventState,
						activeTurnState.model,
						error,
						abortGate.signal.aborted,
						abortGate.signal,
					);
				} catch (settlementError) {
					throw createFailureSettlementError(error, settlementError);
				}
			}
		} finally {
			this.endProviderAdmission();
			try {
				await this.flushPendingSessionWrites();
			} finally {
				await this.rollbackActiveLease();
				deliveries = Object.freeze(
					[...runEventState.deliveryOutcomes.values()].sort(
						(left, right) =>
							(runEventState.deliveryOrder.get(left.deliveryId) ?? Number.MAX_SAFE_INTEGER) -
							(runEventState.deliveryOrder.get(right.deliveryId) ?? Number.MAX_SAFE_INTEGER),
					),
				);
				deliveryFailure = runEventState.deliveryFailure;
				this.leasedDeliveryKinds.clear();
				this.leasedDeliveryEpochs.clear();
				this.leasedDeliveries.clear();
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
			deliveryOwner?: AgentDeliveryOwner;
		},
		operation?: HarnessOperationLease,
	): Promise<AgentHarnessExecutionResult> {
		this.assertNotDisposed();
		if (this.operations.current && this.operations.current !== operation) {
			throw new AgentHarnessError("busy", "AgentHarness is busy");
		}
		if (this.hasPendingPrompt()) {
			throw new AgentHarnessError(
				"invalid_state",
				"AgentHarness has a retained prompt; call continue() or discardPendingPrompt() before starting another",
			);
		}
		this.continuationState = undefined;
		this.invalidateContinuationContext();
		const run = this.admitBoundedRun(operation);
		try {
			const baseTurnState = await this.createTurnState(
				run.state.operation.abortGate.signal,
				undefined,
				undefined,
				true,
			);
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
				invocation.deliveryOwner,
			);
			const baseContextMessages =
				invocation.context === undefined ? baseTurnState.messages : cloneAgentMessages(invocation.context);
			const preflight = await this.preparePromptPreflight(
				deliveryId,
				{ ...baseTurnState, messages: baseContextMessages },
				run.state.operation.abortGate.signal,
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
				...(ownedOptions.deliveryOwner === undefined ? {} : { deliveryOwner: ownedOptions.deliveryOwner }),
			}))
		).result;
	}

	/** Synchronously reserve exclusive run ownership before host preflight awaits. */
	reserveRun(): AgentHarnessRunReservation {
		this.assertNotDisposed();
		const operation = this.operations.reserve("turn");
		if (!operation) throw new AgentHarnessError("busy", "AgentHarness is busy");
		const reservation = Object.freeze({ reservationId: operation.id });
		this.runReservations.set(reservation.reservationId, operation);
		return reservation;
	}

	cancelReservedRun(reservation: AgentHarnessRunReservation): boolean {
		const operation = this.runReservations.get(reservation.reservationId);
		if (!operation || this.operations.current !== operation || operation.phase !== "admitted") return false;
		this.runReservations.delete(reservation.reservationId);
		this.operations.finish(operation);
		return true;
	}

	/** Atomically replace a reserved turn with compaction and a fresh turn successor. */
	async runCompactionBeforeReserved<TResult>(
		reservation: AgentHarnessRunReservation,
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
	): Promise<{ result: TResult; reservation: AgentHarnessRunReservation }> {
		const operation = this.runReservations.get(reservation.reservationId);
		if (!operation || this.operations.current !== operation || operation.phase !== "admitted") {
			throw new AgentHarnessError("invalid_state", "Harness run reservation is not active");
		}
		this.runReservations.delete(reservation.reservationId);
		if (!this.operations.reclassify(operation, "compaction")) {
			throw new AgentHarnessError("invalid_state", "Harness reservation could not enter compaction");
		}
		const successor = this.operations.reserveSuccessor("turn");
		if (!successor) throw new AgentHarnessError("busy", "A successor operation is already reserved");
		let result: TResult;
		try {
			result = await this.executeStructuralOperation(operation, strategy);
		} catch (error) {
			await successor.ready;
			if (this.operations.current === successor.lease) this.operations.finish(successor.lease);
			throw error;
		}
		await successor.ready;
		if (this.operations.current !== successor.lease) {
			throw new AgentHarnessError("invalid_state", "Reserved turn successor was cancelled");
		}
		const next = Object.freeze({ reservationId: successor.lease.id });
		this.runReservations.set(next.reservationId, successor.lease);
		return { result, reservation: next };
	}

	async runReserved(
		reservation: AgentHarnessRunReservation,
		input: AgentMessage | readonly AgentMessage[],
		options: AgentHarnessRunOptions = {},
	): Promise<AgentRunResult> {
		const operation = this.runReservations.get(reservation.reservationId);
		if (!operation || this.operations.current !== operation || operation.phase !== "admitted") {
			throw new AgentHarnessError("invalid_state", "Harness run reservation is not active");
		}
		this.runReservations.delete(reservation.reservationId);
		const messages = cloneAgentMessages(Array.isArray(input) ? input : [input]);
		const ownedOptions = cloneRunOptions(options);
		return (
			await this.startPromptRun(
				() => ({
					messages,
					...(ownedOptions.systemPrompt === undefined ? {} : { systemPrompt: ownedOptions.systemPrompt }),
					...(ownedOptions.context === undefined ? {} : { context: ownedOptions.context }),
					...(ownedOptions.deliveryOwner === undefined ? {} : { deliveryOwner: ownedOptions.deliveryOwner }),
				}),
				operation,
			)
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
				...(ownedOptions?.deliveryOwner === undefined ? {} : { deliveryOwner: ownedOptions.deliveryOwner }),
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
				...(ownedOptions?.deliveryOwner === undefined ? {} : { deliveryOwner: ownedOptions.deliveryOwner }),
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
		return await this.continueWithOperation(options);
	}

	async continueReserved(
		reservation: AgentHarnessRunReservation,
		options: { drainFollowUps?: boolean; context?: readonly AgentMessage[] } = {},
	): Promise<AgentRunResult> {
		const operation = this.runReservations.get(reservation.reservationId);
		if (!operation || this.operations.current !== operation || operation.phase !== "admitted") {
			throw new AgentHarnessError("invalid_state", "Harness run reservation is not active");
		}
		this.runReservations.delete(reservation.reservationId);
		return await this.continueWithOperation(options, operation);
	}

	private async continueWithOperation(
		options: { drainFollowUps?: boolean; context?: readonly AgentMessage[] } = {},
		reservedOperation?: HarnessOperationLease,
	): Promise<AgentRunResult> {
		const ownedContext = options.context === undefined ? undefined : cloneAgentMessages(options.context);
		const drainFollowUps = options.drainFollowUps === true;
		this.assertNotDisposed();
		if (this.operations.current && this.operations.current !== reservedOperation) {
			throw new AgentHarnessError("busy", "AgentHarness is busy");
		}
		const reservation = reservedOperation ?? this.operations.reserve("turn");
		if (!reservation) throw new AgentHarnessError("busy", "AgentHarness is busy");
		let boundedRun: AgentHarnessBoundedRun | undefined;
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
			const projection = await this.requireValidContextProjection();
			const contextMessages = projection?.ownedOverlayMessages ?? (await this.session.buildContext()).messages;
			const lastMessage = contextMessages.at(-1);
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
			const run = this.admitBoundedRun(reservation);
			boundedRun = run;
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
					run.state.operation.abortGate.signal,
					contextMessages,
					resolvedSystemPrompt,
					pendingPrompt !== undefined,
				);
				if (pendingPrompt !== undefined) {
					const preflight = await this.preparePromptPreflight(
						pendingPrompt.deliveryId,
						turnState,
						run.state.operation.abortGate.signal,
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
		} finally {
			if (!boundedRun) this.operations.finish(reservation);
		}
	}

	queueSteer(message: AgentMessage, owner?: AgentDeliveryOwner): string {
		this.assertNotDisposed();
		return this.enqueuePublishedDelivery("steer", [message], owner).deliveryId;
	}

	queueFollowUp(message: AgentMessage, owner?: AgentDeliveryOwner): string {
		this.assertNotDisposed();
		return this.enqueuePublishedDelivery("followUp", [message], owner).deliveryId;
	}

	async steer(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		this.assertNotDisposed();
		if (!this.operations.current) throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		const enqueued = this.enqueuePublishedDelivery(
			"steer",
			[createUserMessage(text, options?.images)],
			options?.deliveryOwner,
		);
		await enqueued.publication;
		return enqueued.deliveryId;
	}

	async followUp(text: string, options?: AgentHarnessPromptOptions): Promise<string> {
		this.assertNotDisposed();
		if (!this.operations.current) throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		const enqueued = this.enqueuePublishedDelivery(
			"followUp",
			[createUserMessage(text, options?.images)],
			options?.deliveryOwner,
		);
		await enqueued.publication;
		return enqueued.deliveryId;
	}

	async nextTurn(text: string, options?: AgentHarnessPromptOptions): Promise<void> {
		this.assertNotDisposed();
		this.nextTurnQueue.push(...cloneAgentMessages([createUserMessage(text, options?.images)]));
		await this.trackAdmittedMutation(this.emitQueueUpdate());
	}

	hasQueuedMessages(): boolean {
		return this.deliveryInbox.hasPending();
	}

	hasPendingPrompt(): boolean {
		return this.deliveryInbox.hasPending("prompt");
	}

	private revokeDeliveries(kind: AgentDeliveryKind): readonly PendingDelivery[] {
		const revoked = this.deliveryInbox.revoke(kind);
		for (const delivery of revoked) {
			this.recordDeliveryOutcome({
				deliveryId: delivery.deliveryId,
				kind: delivery.kind,
				outcome: "revoked",
			});
			this.deliveryPreparationStates.delete(delivery.deliveryId);
			const attemptId = this.deliveryAttemptIds.get(delivery.deliveryId);
			this.deliveryAttemptIds.delete(delivery.deliveryId);
			const preparationSettlement = this.deliveryPreparationSettlements.get(delivery.deliveryId);
			const finalizer = (async () => {
				await preparationSettlement;
				return await this.finishDeliveryOwner(delivery, attemptId, { outcome: "revoked" });
			})().then((error) => {
				if (error) {
					this.requestClose("session_replacement");
					throw error;
				}
			});
			this.deliveryRevocationFinalizers.set(delivery.deliveryId, finalizer);
			void finalizer.then(
				() => {
					if (this.deliveryRevocationFinalizers.get(delivery.deliveryId) === finalizer) {
						this.deliveryRevocationFinalizers.delete(delivery.deliveryId);
					}
				},
				() => {
					if (this.deliveryRevocationFinalizers.get(delivery.deliveryId) === finalizer) {
						this.deliveryRevocationFinalizers.delete(delivery.deliveryId);
					}
				},
			);
			this.trackCloseDrain(finalizer);
			void finalizer.catch(() => {});
		}
		return revoked;
	}

	private clearDeliveryKinds(kinds: readonly AgentDeliveryKind[]): Promise<string[]> {
		this.assertNotDisposed();
		const revoked = kinds.flatMap((kind) => this.revokeDeliveries(kind));
		const finalizers = revoked.flatMap((delivery) => {
			const finalizer = this.deliveryRevocationFinalizers.get(delivery.deliveryId);
			return finalizer ? [finalizer] : [];
		});
		const mutation = (async () => {
			if (revoked.length > 0) await this.emitQueueUpdate();
			await Promise.all(finalizers);
			return revoked.map((delivery) => delivery.deliveryId);
		})();
		return this.trackAdmittedMutation(mutation);
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
		if (revoked.length > 0) {
			const publication = this.emitQueueUpdate(true);
			this.trackCloseDrain(publication);
			void publication.catch(() => {});
		}
		return revoked.map((delivery) => delivery.deliveryId);
	}

	async discardPendingPrompt(): Promise<string[]> {
		return await this.clearDeliveryKinds(["prompt"]);
	}

	/** Terminally fence the Harness without joining an in-flight callback or operation. */
	requestClose(source: AgentAbortSource = "disposal"): void {
		if (!this.operations.requestClose(source)) return;
		for (const [reservationId, reservation] of this.runReservations) {
			this.runReservations.delete(reservationId);
			if (this.operations.current === reservation && reservation.phase === "admitted") {
				this.operations.finish(reservation);
			}
		}
		this.closePromise = this.drainClose();
		void this.closePromise.catch(() => {});
		this.endProviderAdmission();
		const revoked = (["prompt", "steer", "followUp"] as const).flatMap((kind) => this.revokeDeliveries(kind));
		const hadNextTurnMessages = this.nextTurnQueue.length > 0;
		this.nextTurnQueue = [];
		this.pendingSessionWrites = [];
		// A delivery that crossed its commit boundary remains owned by the active
		// operation. The operation's finalizer releases its lease and preparation.
		this.continuationState = undefined;
		if (this.activeRun) delete this.activeRun.continuationCandidate;
		this.invalidateContinuationContext();
		if (revoked.length > 0 || hadNextTurnMessages) {
			this.trackCloseDrain(this.emitQueueUpdate(true));
		}
	}

	/** Fence-only alias retained as the conventional resource lifecycle method. */
	dispose(source: AgentAbortSource = "disposal"): void {
		this.requestClose(source);
	}

	waitForClosed(): Promise<void> {
		return this.closePromise ?? this.operations.waitForClosed();
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		this.assertNotDisposed();
		let ownedMessage: AgentMessage;
		try {
			ownedMessage = structuredClone(message);
		} catch (error) {
			throw normalizeHarnessError(
				new SessionError("invalid_entry", "Failed to materialize canonical mutation batch", toError(error)),
				"session",
			);
		}
		const mutation = (async () => {
			try {
				if (!this.operations.current) {
					const entryId = await this.session.appendMessage(ownedMessage);
					await this.advanceContextProjection(entryId, [ownedMessage]);
				} else {
					const write = { type: "message" as const, message: ownedMessage };
					if (this.providerHookPendingWrites) this.providerHookPendingWrites.push(write);
					else this.pendingSessionWrites.push(write);
				}
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		})();
		await this.trackAdmittedMutation(mutation);
	}

	private async executeStructuralOperation<TResult>(
		operation: HarnessOperationLease,
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
	): Promise<TResult> {
		this.operations.start(operation);
		try {
			let committed = false;
			const streamFn = await this.createStructuralStreamFn();
			const context: AgentHarnessStructuralOperationContext = Object.freeze({
				signal: operation.abortGate.signal,
				streamFn,
				sealAndCommit: async (batch: SessionMutationBatch) => {
					if (committed)
						throw new AgentHarnessError("invalid_state", "Structural commit capability was already used");
					if (operation.abortGate.signal.aborted || this.operations.current !== operation) {
						throw new AgentHarnessError("invalid_state", "Structural operation lost ownership before commit");
					}
					this.operations.sealTerminal(operation);
					committed = true;
					return await this.session.commitBatch(batch);
				},
			});
			return await strategy(context);
		} finally {
			this.operations.finish(operation);
		}
	}

	async runCompactionOperation<TResult>(
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
	): Promise<TResult> {
		this.assertNotDisposed();
		const operation = this.operations.reserve("compaction");
		if (!operation) throw new AgentHarnessError("busy", "Compaction requires idle harness");
		return await this.executeStructuralOperation(operation, strategy);
	}

	async runTreeOperation<TResult>(
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
	): Promise<TResult> {
		this.assertNotDisposed();
		const operation = this.operations.reserve("branch_summary");
		if (!operation) throw new AgentHarnessError("busy", "Tree navigation requires idle harness");
		return await this.executeStructuralOperation(operation, strategy);
	}

	/**
	 * Reserve tree navigation as the successor to pre-provider work and fence that
	 * work before changing the canonical branch. Accepted provider requests remain
	 * non-preemptible and must settle before navigation can be retried.
	 */
	async requestTreeOperation<TResult>(
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
	): Promise<TResult> {
		this.assertNotDisposed();
		const current = this.operations.current;
		if (!current) return await this.runTreeOperation(strategy);
		if (current.kind === "branch_summary" || (current.kind === "turn" && this.activeRun?.requestAccepted === true)) {
			throw new AgentHarnessError("busy", "Tree navigation cannot preempt the active operation");
		}

		const successor =
			current.kind === "compaction"
				? (this.operations.reserveSuccessorReplacing("turn", "branch_summary") ??
					this.operations.reserveSuccessor("branch_summary"))
				: this.operations.reserveSuccessor("branch_summary");
		if (!successor) throw new AgentHarnessError("busy", "A successor operation is already reserved");
		this.abort("host_action");

		// Prompt preflight owns an admitted reservation but has not crossed into
		// canonical/provider work. Revoke it synchronously so navigation can commit
		// the new generation; its eventual runReserved call then fails closed.
		if (current.kind === "turn" && current.phase === "admitted") {
			for (const [reservationId, operation] of this.runReservations) {
				if (operation === current) this.runReservations.delete(reservationId);
			}
			this.operations.finish(current);
		}

		await successor.ready;
		if (this.operations.current !== successor.lease || !this.operations.isOpen) {
			throw new AgentHarnessError("invalid_state", "Tree navigation reservation was cancelled");
		}
		return await this.executeStructuralOperation(successor.lease, strategy);
	}

	/** Reserve compaction behind the active operation before requesting its abort. */
	async requestCompaction<TResult>(
		strategy: (context: AgentHarnessStructuralOperationContext) => Promise<TResult> | TResult,
		abortSource: AgentAbortSource = "host_action",
	): Promise<TResult> {
		this.assertNotDisposed();
		if (!this.operations.current) return await this.runCompactionOperation(strategy);
		const successor = this.operations.reserveSuccessor("compaction");
		if (!successor) throw new AgentHarnessError("busy", "A successor operation is already reserved");
		this.abort(abortSource);
		await successor.ready;
		if (this.operations.current !== successor.lease || !this.operations.isOpen) {
			throw new AgentHarnessError("invalid_state", "Compaction reservation was cancelled");
		}
		return await this.executeStructuralOperation(successor.lease, strategy);
	}

	async compact(customInstructions?: string): Promise<{
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		estimatedTokensAfter: number;
		details?: JsonValue;
	}> {
		this.assertNotDisposed();
		const operation = this.operations.reserve("compaction");
		if (!operation) throw new AgentHarnessError("busy", "compact() requires idle harness");
		this.operations.start(operation);
		try {
			const model = this.model;
			if (!model) throw new AgentHarnessError("invalid_state", "No model set for compaction");
			const basis = await this.session.getBranchSnapshot();
			const branchEntries = [...basis.entries];
			const activeTools = this.getActiveTools();
			const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS, {
				tools: activeTools,
				contextWindow: model.contextWindow,
			});
			if (!preparationResult.ok) throw preparationResult.error;
			const preparation = preparationResult.value;
			if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
			const signal = operation.abortGate.signal;
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
			if (signal.aborted || this.operations.current !== operation) {
				throw new AgentHarnessError("compaction", "Compaction aborted before commit");
			}
			this.operations.sealTerminal(operation);
			const commit = await this.session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				mutations: [
					{
						kind: "append",
						entry: {
							type: "compaction",
							summary: result.summary,
							firstKeptEntryId: result.firstKeptEntryId,
							tokensBefore: result.tokensBefore,
							...(result.details === undefined ? {} : { details: result.details }),
							...(provided === undefined ? {} : { fromHook: true }),
						},
					},
				],
			});
			if (commit.outcome !== "committed") throw commit.error;
			const entryId = commit.appendedEntryIds[0]!;
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
			this.operations.finish(operation);
		}
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		this.assertNotDisposed();
		const operation = this.operations.reserve("branch_summary");
		if (!operation) throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
		this.operations.start(operation);
		try {
			const basis = await this.session.getBranchSnapshot();
			const oldLeafId = basis.cursor.branchIdentity;
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
			const signal = operation.abortGate.signal;
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
			if (signal.aborted || this.operations.current !== operation) return { cancelled: true };
			this.operations.sealTerminal(operation);
			const summaryLabel = hookResult?.label ?? options?.label;
			const commit = await this.session.commitBatch({
				guard: { kind: "exact", cursor: basis.cursor },
				mutations: [
					{
						kind: "move_with_summary",
						leafId: newLeafId,
						...(summaryText === undefined
							? {}
							: {
									summary: {
										summary: summaryText,
										...(summaryDetails === undefined ? {} : { details: summaryDetails }),
										...(hookResult?.summary === undefined ? {} : { fromHook: true }),
										...(summaryLabel === undefined ? {} : { label: summaryLabel }),
									},
								}),
					},
					...(summaryText !== undefined || summaryLabel === undefined || newLeafId === null
						? []
						: [
								{
									kind: "append" as const,
									entry: { type: "label" as const, targetId: newLeafId, label: summaryLabel },
								},
							]),
				],
			});
			if (commit.outcome !== "committed") throw commit.error;
			this.invalidateContinuationContext();
			if (summaryText) {
				for (const entryId of commit.appendedEntryIds) {
					const entry = await this.session.getEntry(entryId);
					if (entry?.type === "branch_summary") {
						summaryEntry = entry;
						break;
					}
				}
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
			this.operations.finish(operation);
		}
	}

	getModel(): Model<any> | undefined {
		return this.model;
	}

	async setModelAndThinkingLevel(
		model: Model<any> | undefined,
		level: ThinkingLevel,
		options: { persist?: boolean } = {},
	): Promise<void> {
		this.assertNotDisposed();
		if (this.providerHookConfigurationAttempt && isSameModel(this.model, model) && this.thinkingLevel === level) {
			return;
		}
		const previousModel = this.model;
		const previousLevel = this.thinkingLevel;
		++this.runtimeConfigurationEpoch;
		const transaction = this.orderRuntimeConfigurationWrite(async () => {
			await this.waitForProviderAdmission();
			if (options.persist !== false) {
				const basis = await this.session.getBranchSnapshot();
				const commit = await this.session.commitBatch({
					guard: { kind: "descendant", cursor: basis.cursor },
					mutations: [
						...(model === undefined
							? []
							: [
									{
										kind: "append" as const,
										entry: {
											type: "model_change" as const,
											provider: model.provider,
											modelId: model.id,
										},
									},
								]),
						{
							kind: "append",
							entry: { type: "thinking_level_change", thinkingLevel: level },
						},
					],
				});
				if (commit.outcome !== "committed") throw commit.error;
				this.applyVerifiedProjectionAdvance(commit.advance);
			}
			this.model = model;
			this.thinkingLevel = level;
		});
		const mutation = (async () => {
			try {
				await transaction;
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
			await this.emitOwn({
				type: "model_update",
				model,
				previousModel,
				source: options.persist === false ? "restore" : "set",
			});
			await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
		})();
		await this.trackAdmittedMutation(mutation);
	}

	async setModel(model: Model<any> | undefined, options: { persist?: boolean } = {}): Promise<void> {
		this.assertNotDisposed();
		if (this.providerHookConfigurationAttempt && isSameModel(this.model, model)) return;
		const previousModel = this.model;
		++this.runtimeConfigurationEpoch;
		const transaction = this.orderRuntimeConfigurationWrite(async () => {
			await this.waitForProviderAdmission();
			if (options.persist !== false && model) {
				const entryId = await this.session.appendModelChange(model.provider, model.id);
				await this.advanceContextProjection(entryId);
			}
			this.model = model;
		});
		const mutation = (async () => {
			try {
				await transaction;
				await this.emitOwn({
					type: "model_update",
					model,
					previousModel,
					source: options.persist === false ? "restore" : "set",
				});
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		})();
		await this.trackAdmittedMutation(mutation);
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel, options: { persist?: boolean } = {}): Promise<void> {
		this.assertNotDisposed();
		if (this.providerHookConfigurationAttempt && this.thinkingLevel === level) return;
		const previousLevel = this.thinkingLevel;
		++this.runtimeConfigurationEpoch;
		const transaction = this.orderRuntimeConfigurationWrite(async () => {
			await this.waitForProviderAdmission();
			if (options.persist !== false) {
				const entryId = await this.session.appendThinkingLevelChange(level);
				await this.advanceContextProjection(entryId);
			}
			this.thinkingLevel = level;
		});
		const mutation = (async () => {
			try {
				await transaction;
				await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
			} catch (error) {
				throw normalizeHarnessError(error, "session");
			}
		})();
		await this.trackAdmittedMutation(mutation);
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		this.assertNotDisposed();
		const replayActiveToolNames = activeToolNames ?? this.activeToolNames;
		if (
			this.providerHookConfigurationAttempt &&
			tools.length === this.tools.size &&
			tools.every((tool) => this.tools.get(tool.name) === tool) &&
			replayActiveToolNames.length === this.activeToolNames.length &&
			replayActiveToolNames.every((name, index) => name === this.activeToolNames[index])
		) {
			return;
		}
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			let nextActiveToolNames: string[] = [];
			let previousToolNames: string[] = [];
			let previousActiveToolNames: string[] = [];
			++this.runtimeConfigurationEpoch;
			const transaction = this.orderRuntimeConfigurationWrite(async () => {
				await this.waitForProviderAdmission();
				nextActiveToolNames = activeToolNames ? [...activeToolNames] : [...this.activeToolNames];
				this.validateToolNames(nextActiveToolNames, nextTools);
				previousToolNames = [...this.tools.keys()];
				previousActiveToolNames = [...this.activeToolNames];
				if (this.persistActiveToolChanges) {
					const entryId = await this.session.appendActiveToolsChange(nextActiveToolNames);
					await this.advanceContextProjection(entryId);
				}
				this.tools = nextTools;
				this.activeToolNames = [...nextActiveToolNames];
			});
			const mutation = (async () => {
				await transaction;
				await this.emitOwn({
					type: "tools_update",
					toolNames: [...this.tools.keys()],
					previousToolNames,
					activeToolNames: [...this.activeToolNames],
					previousActiveToolNames,
					source: "set",
				});
			})();
			await this.trackAdmittedMutation(mutation);
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		this.assertNotDisposed();
		if (
			this.providerHookConfigurationAttempt &&
			toolNames.length === this.activeToolNames.length &&
			toolNames.every((name, index) => name === this.activeToolNames[index])
		) {
			return;
		}
		try {
			const nextToolNames = [...toolNames];
			let previousToolNames: string[] = [];
			let previousActiveToolNames: string[] = [];
			++this.runtimeConfigurationEpoch;
			const transaction = this.orderRuntimeConfigurationWrite(async () => {
				await this.waitForProviderAdmission();
				this.validateToolNames(nextToolNames);
				previousToolNames = [...this.tools.keys()];
				previousActiveToolNames = [...this.activeToolNames];
				if (this.persistActiveToolChanges) {
					const entryId = await this.session.appendActiveToolsChange(nextToolNames);
					await this.advanceContextProjection(entryId);
				}
				this.activeToolNames = [...nextToolNames];
			});
			const mutation = (async () => {
				await transaction;
				await this.emitOwn({
					type: "tools_update",
					toolNames: [...this.tools.keys()],
					previousToolNames,
					activeToolNames: [...this.activeToolNames],
					previousActiveToolNames,
					source: "set",
				});
			})();
			await this.trackAdmittedMutation(mutation);
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
		await this.trackAdmittedMutation(
			this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources }),
		);
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.assertNotDisposed();
		const next = cloneStreamOptions(streamOptions);
		if (this.providerHookConfigurationAttempt && areStructurallyEqual(this.streamOptions, next)) return;
		++this.runtimeConfigurationEpoch;
		const transaction = this.orderRuntimeConfigurationWrite(async () => {
			await this.waitForProviderAdmission();
			this.streamOptions = cloneStreamOptions(next);
		});
		await this.trackAdmittedMutation(transaction);
	}

	getPhase(): AgentHarnessPhase {
		const operation = this.operations.current;
		if (!operation) return "idle";
		return operation.kind === "turn" ? "turn" : operation.kind;
	}

	isReservedOrRunning(): boolean {
		return this.operations.current !== undefined;
	}

	get signal(): AbortSignal | undefined {
		return this.operations.current?.abortGate.signal;
	}

	get activeRunSnapshot(): AgentRunSnapshot | undefined {
		const run = this.activeRun;
		return run
			? Object.freeze({
					runId: run.id,
					source: run.operation.abortSource,
					diagnosticTimestamp: run.operation.diagnosticTimestamp,
					requestAccepted: run.requestAccepted,
					phase: run.phase,
				})
			: undefined;
	}

	abort(source?: AgentAbortSource): AgentAbortAcceptance {
		const operation = this.operations.current;
		const acceptance = this.operations.requestAbort(source);
		if (operation?.kind === "turn" && operation.phase === "admitted") {
			let cancelledReservation = false;
			for (const [reservationId, reservation] of this.runReservations) {
				if (reservation !== operation) continue;
				this.runReservations.delete(reservationId);
				cancelledReservation = true;
			}
			if (cancelledReservation) this.operations.finish(operation);
		}
		return acceptance;
	}

	waitForIdle(): Promise<void> {
		return this.operations.waitForIdle();
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
