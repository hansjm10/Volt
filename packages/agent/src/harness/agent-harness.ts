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
import { DeliveryInbox, type DeliveryLease } from "../delivery-inbox.ts";
import {
	createExplicitToolSelection,
	deriveToolSelection,
	type ToolSelection,
	toolSelectionsEqual,
} from "../tool-selection.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
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
	AgentHarnessResources,
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
	errors: Error[];
}

interface AgentHarnessRunEventState {
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
	private runAbortController: AbortController | undefined;
	private runPromise: Promise<void> | undefined;
	private pendingSessionWrites: PendingSessionWrite[] = [];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private baselineToolNames: string[];
	private toolSelection: ToolSelection = { kind: "inherit" };
	private effectiveToolNames: string[];
	private readonly deliveryInbox = new DeliveryInbox<"steer" | "followUp", UserMessage>();
	private activeDeliveryLease: DeliveryLease<"steer" | "followUp", UserMessage> | undefined;
	private readonly committedDeliveryIds = new Set<string>();
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
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		const configuredActiveToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(configuredActiveToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(configuredActiveToolNames);
		this.baselineToolNames = [...configuredActiveToolNames];
		this.effectiveToolNames = [...configuredActiveToolNames];
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

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown | undefined> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		let modified = false;
		if (!handlers || handlers.size === 0) return undefined;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
					modified = true;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return modified ? current : undefined;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: this.deliveryInbox.list("steer").flatMap((delivery) => [...delivery.messages]),
			followUp: this.deliveryInbox.list("followUp").flatMap((delivery) => [...delivery.messages]),
			nextTurn: [...this.nextTurnQueue],
		});
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
		await this.restoreToolSelection(context.toolSelection);
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.getActiveTools();
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
				...(streamOptions?.reportToolSetSnapshot === undefined
					? {}
					: { reportToolSetSnapshot: streamOptions.reportToolSetSnapshot }),
				...(signal === undefined ? {} : { signal }),
				sessionId: turnState.sessionId,
				...(requestOptions.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs }),
				...(requestOptions.transport === undefined ? {} : { transport: requestOptions.transport }),
				...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			});
		};
	}

	private leaseQueuedDeliveries(
		kind: "steer" | "followUp",
		mode: QueueMode,
	): Array<{ deliveryId: string; messages: AgentMessage[] }> {
		const selected = this.deliveryInbox.select(kind, mode);
		if (selected.length === 0) return [];
		const lease = this.deliveryInbox.lease(selected);
		this.activeDeliveryLease = lease;
		return lease.deliveries.map((delivery) => ({
			deliveryId: delivery.deliveryId,
			messages: [...delivery.messages],
		}));
	}

	private beginDelivery(deliveryId: string | undefined): boolean {
		if (deliveryId === undefined || !this.activeDeliveryLease?.owns(deliveryId)) return true;
		const delivery = this.activeDeliveryLease.begin(deliveryId);
		if (!delivery) return false;
		if (!this.activeDeliveryLease.settle(deliveryId, "committed")) return false;
		this.committedDeliveryIds.add(deliveryId);
		return true;
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
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
			nextAction: async (context) => {
				if (context.requestAuthority === "final_response") return context.defaultAction;
				const initialDeliveries =
					context.completedTurn === undefined && context.defaultAction.type === "request"
						? (context.defaultAction.deliveries ?? [])
						: [];
				const steering = this.leaseQueuedDeliveries("steer", this.steeringQueueMode);
				if (initialDeliveries.length > 0 || steering.length > 0) {
					return {
						type: "request",
						reason:
							context.defaultAction.type === "request" && context.defaultAction.reason === "continuation"
								? "continuation"
								: "delivery",
						deliveries: [...initialDeliveries, ...steering],
					};
				}
				if (context.defaultAction.type === "request") {
					return context.defaultAction;
				}
				const followUp = this.leaseQueuedDeliveries("followUp", this.followUpQueueMode);
				return followUp.length > 0
					? { type: "request", reason: "delivery", deliveries: followUp }
					: { type: "stop" };
			},
			beginDelivery: (delivery) => ({
				outcome: this.beginDelivery(delivery.deliveryId) ? "committed" : "revoked",
			}),
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

	private async restoreToolSelection(selection: ToolSelection): Promise<void> {
		const derived = deriveToolSelection(this.tools, this.baselineToolNames, selection);
		const selectionChanged = !toolSelectionsEqual(selection, this.toolSelection);
		const effectiveChanged =
			derived.effectiveNames.length !== this.effectiveToolNames.length ||
			derived.effectiveNames.some((name, index) => name !== this.effectiveToolNames[index]);
		this.toolSelection = selection;
		if (!selectionChanged && !effectiveChanged) return;
		const previousToolNames = [...this.tools.keys()];
		const previousActiveToolNames = [...this.effectiveToolNames];
		this.effectiveToolNames = derived.effectiveNames;
		await this.emitOwn({
			type: "tools_update",
			toolNames: previousToolNames,
			previousToolNames,
			activeToolNames: [...this.effectiveToolNames],
			previousActiveToolNames,
			source: "restore",
		});
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
			for (const message of event.messages) {
				if (!state.admittedMessageSet.has(message)) {
					state.admittedMessageSet.add(message);
					state.admittedMessages.push(message);
				}
				state.messageDeliveryIds.set(message, event.deliveryId);
			}
			const deliveryState: AgentHarnessDeliveryEventState = {
				remainingMessages: new Set(event.messages),
				errors: [],
			};
			state.deliveries.set(event.deliveryId, deliveryState);
			if (event.deliveryId !== undefined && this.committedDeliveryIds.delete(event.deliveryId)) {
				try {
					await this.emitQueueUpdate();
				} catch (error) {
					deliveryState.errors.push(toError(error));
				}
			}
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				deliveryState.errors.push(toError(error));
			}
			if (deliveryState.remainingMessages.size === 0) {
				state.deliveries.delete(event.deliveryId);
				if (deliveryState.errors.length > 0) {
					throw combineEventErrors(deliveryState.errors, "Delivery notifications failed");
				}
			}
			return;
		}
		if (event.type === "message_start") {
			state.startedMessages.add(event.message);
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				const deliveryState = state.deliveries.get(event.deliveryId);
				if (!deliveryState?.remainingMessages.has(event.message)) throw error;
				deliveryState.errors.push(toError(error));
			}
			return;
		}
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
			if (!state.persistedMessageSet.has(event.message)) {
				state.persistedMessageSet.add(event.message);
				state.persistedMessages.push(event.message);
			}
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			const deliveryState = state.deliveries.get(event.deliveryId);
			if (deliveryState?.remainingMessages.delete(event.message)) {
				if (eventError) deliveryState.errors.push(toError(eventError));
				if (deliveryState.remainingMessages.size === 0) {
					state.deliveries.delete(event.deliveryId);
					if (deliveryState.errors.length > 0) {
						throw combineEventErrors(deliveryState.errors, "Delivery notifications failed");
					}
				}
				return;
			}
			if (eventError) throw eventError;
			return;
		}
		if (event.type === "turn_start") {
			state.hasTurnStarted = true;
			state.turnOpen = true;
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

		if (!state.turnOpen) await attempt({ type: "turn_start" });
		const failureError = aborted ? new Error("Request was aborted") : error;
		const failureMessage = createFailureMessage(model, failureError, aborted);
		await attempt({ type: "message_start", message: failureMessage });
		await attempt({ type: "message_end", message: failureMessage });
		await attempt({ type: "turn_end", message: failureMessage, toolResults: [] });
		const terminalMessages = [...state.persistedMessages];
		await attempt({ type: "agent_end", messages: terminalMessages });

		if (settlementErrors.length > 0) {
			throw combineEventErrors(settlementErrors, "Agent failure settlement notifications failed");
		}
		return terminalMessages;
	}

	private async executeTurn(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		let activeTurnState = turnState;
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHookError(error);
			}
			messages = [...queuedMessages, messages[0]!];
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			...(options?.images === undefined ? {} : { images: options.images }),
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		const abortController = new AbortController();
		const getTurnState = () => activeTurnState;
		const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
			activeTurnState = nextTurnState;
		};
		this.runAbortController = abortController;
		const runEventState: AgentHarnessRunEventState = {
			admittedMessages: [...messages],
			admittedMessageSet: new Set(messages),
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
		let terminalMessages: AgentMessage[] | undefined;
		const runResultPromise = (async () => {
			try {
				return await runAgentLoop(
					messages,
					this.createContext(turnState, beforeResult?.systemPrompt),
					this.createLoopConfig(getTurnState, setTurnState),
					async (event) => {
						if (event.type === "agent_end" && abortController.signal.aborted && !runEventState.hasTurnStarted) {
							const abortError = new Error("Request was aborted");
							try {
								terminalMessages = await this.settleRunFailure(
									runEventState,
									activeTurnState.model,
									abortError,
									true,
									abortController.signal,
								);
							} catch (settlementError) {
								throw createFailureSettlementError(abortError, settlementError);
							}
							return;
						}
						await this.handleAgentEvent(event, runEventState, abortController.signal);
					},
					abortController.signal,
					this.createStreamFn(getTurnState),
				);
			} catch (error) {
				if (runEventState.settlementStarted || runEventState.terminalEmitted) throw error;
				try {
					terminalMessages = await this.settleRunFailure(
						runEventState,
						activeTurnState.model,
						error,
						abortController.signal.aborted,
						abortController.signal,
					);
					return terminalMessages;
				} catch (settlementError) {
					throw createFailureSettlementError(error, settlementError);
				}
			}
		})();
		try {
			const loopMessages = await runResultPromise;
			const newMessages = terminalMessages ?? loopMessages;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			try {
				await this.flushPendingSessionWrites();
			} finally {
				this.deliveryInbox.rollbackActiveLease();
				this.activeDeliveryLease = undefined;
				this.committedDeliveryIds.clear();
				this.runAbortController = undefined;
			}
		}
	}

	async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.createTurnState();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.deliveryInbox.enqueue("steer", [createUserMessage(text, options?.images)]);
		await this.emitQueueUpdate();
	}

	async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.deliveryInbox.enqueue("followUp", [createUserMessage(text, options?.images)]);
		await this.emitQueueUpdate();
	}

	async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
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
			await this.restoreToolSelection((await this.session.buildContext()).toolSelection);
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
			if (activeToolNames !== undefined) this.validateToolNames(activeToolNames, nextTools);
			const nextSelection =
				activeToolNames === undefined ? this.toolSelection : createExplicitToolSelection(activeToolNames);
			const nextBaselineToolNames = tools.map((tool) => tool.name);
			const derived = deriveToolSelection(nextTools, nextBaselineToolNames, nextSelection);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.effectiveToolNames];
			if (activeToolNames !== undefined) {
				if (this.phase === "idle") {
					await this.session.appendActiveToolsChange(derived.requestedNames);
				} else {
					this.pendingSessionWrites.push({
						type: "active_tools_change",
						activeToolNames: [...derived.requestedNames],
					});
				}
			}
			this.tools = nextTools;
			this.baselineToolNames = nextBaselineToolNames;
			this.toolSelection = nextSelection;
			this.effectiveToolNames = derived.effectiveNames;
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.effectiveToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.effectiveToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			this.validateToolNames(toolNames);
			const nextSelection = createExplicitToolSelection(toolNames);
			const derived = deriveToolSelection(this.tools, this.baselineToolNames, nextSelection);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.effectiveToolNames];
			if (this.phase === "idle") {
				await this.session.appendActiveToolsChange(derived.requestedNames);
			} else {
				this.pendingSessionWrites.push({
					type: "active_tools_change",
					activeToolNames: [...derived.requestedNames],
				});
			}
			this.toolSelection = nextSelection;
			this.effectiveToolNames = derived.effectiveNames;
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.effectiveToolNames],
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

	async abort(): Promise<AbortResult> {
		const clearedSteer = this.deliveryInbox.revoke("steer").flatMap((delivery) => [...delivery.messages]);
		const clearedFollowUp = this.deliveryInbox.revoke("followUp").flatMap((delivery) => [...delivery.messages]);
		this.runAbortController?.abort();
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
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
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
