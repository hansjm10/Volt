/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type JsonObject,
	streamSimple,
	type Tool,
	type ToolResultMessage,
	type ToolSetSnapshotAuthority,
	validateToolArguments,
} from "@hansjm10/volt-ai";
import { canonicalizeMessageReplacement, UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY } from "./message-replacement.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopDeliveryOutcome,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentMessage,
	AgentPreparedRequestDecision,
	AgentRequestAuthority,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PreparedProviderRequest,
	PreparedProviderStreamOptions,
	PrepareRequestContext,
	StreamFn,
	ToolBatchDisposition,
} from "./types.ts";

type PassiveAgentEventSink = (event: AgentEvent) => void;
type AsyncPassiveAgentEventSink = (event: AgentEvent) => Promise<void>;
type ReplacingAgentEventSink = (event: AgentEvent) => AgentMessage | undefined;
type AsyncReplacingAgentEventSink = (event: AgentEvent) => Promise<AgentMessage | undefined>;

export type AgentEventSink =
	| PassiveAgentEventSink
	| AsyncPassiveAgentEventSink
	| ReplacingAgentEventSink
	| AsyncReplacingAgentEventSink;

type AgentEventSinkResult = Awaited<ReturnType<AgentEventSink>>;

/** Delivery settlement that stops the current low-level loop before a provider request. */
export class AgentDeliverySettlementError extends Error {
	readonly outcome: "retained" | "terminally_failed";
	readonly deliveryId: string | undefined;
	readonly settlementError: Error;

	constructor(outcome: "retained" | "terminally_failed", deliveryId: string | undefined, settlementError: Error) {
		super(settlementError.message);
		this.name = "AgentDeliverySettlementError";
		this.outcome = outcome;
		this.deliveryId = deliveryId;
		this.settlementError = settlementError;
	}
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		(error: unknown) => {
			stream.fail(error);
		},
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without an initial delivery.
 * The next-action dispatcher may still attach a user delivery before the first
 * request, including when the retained transcript ends with an assistant.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		(error: unknown) => {
			stream.fail(error);
		},
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };
	const initialAction: AgentLoopNextAction = {
		type: "request",
		reason: prompts.length > 0 ? "delivery" : "continuation",
		...(prompts.length > 0 ? { deliveries: [{ messages: prompts }] } : {}),
	};

	await emit({ type: "agent_start" });
	await runDispatchedLoop(currentContext, newMessages, config, initialAction, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };
	await emit({ type: "agent_start" });
	await runDispatchedLoop(
		currentContext,
		newMessages,
		config,
		{ type: "request", reason: "continuation" },
		signal,
		emit,
		streamFn,
	);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** Main request state machine shared by prompt and continuation runs. */
async function runDispatchedLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	initialAction: AgentLoopNextAction,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let completedTurn: AgentLoopNextActionContext["completedTurn"];
	let requestAuthority: AgentRequestAuthority = "provider";
	let defaultAction = initialAction;
	let admittedPreparedRequest = initialConfig.preparedRequest;

	while (true) {
		if (signal?.aborted) {
			if (completedTurn) {
				await emitBoundaryAbort(currentContext, newMessages, config, emit);
			}
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		let requestContext: PrepareRequestContext;
		let preparedRequest: PreparedProviderRequest | undefined;
		if (admittedPreparedRequest) {
			preparedRequest = admittedPreparedRequest;
			admittedPreparedRequest = undefined;
			completedTurn = preparedRequest.completedTurn;
			requestAuthority = preparedRequest.requestAuthority;
			defaultAction = preparedRequest.defaultAction;
			requestContext = {
				context: currentContext,
				newMessages,
				...(completedTurn === undefined ? {} : { completedTurn }),
				requestAuthority,
				defaultAction,
				reason: preparedRequest.reason,
				deliveries: preparedRequest.deliveries.map(clonePreparedDelivery),
			};
			currentContext = {
				...currentContext,
				systemPrompt: preparedRequest.providerContext.systemPrompt ?? "",
				messages: currentContext.messages,
			};
			config = { ...config, model: preparedRequest.model };
		} else {
			const actionContext: AgentLoopNextActionContext = {
				context: currentContext,
				newMessages,
				...(completedTurn === undefined ? {} : { completedTurn }),
				requestAuthority,
				defaultAction,
			};
			const hostAction = await resolveNextAction(config, actionContext);
			if (signal?.aborted && completedTurn) {
				await emitBoundaryAbort(currentContext, newMessages, config, emit);
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			const action =
				requestAuthority === "final_response" && hostAction.type !== "pause"
					? ({ type: "request", reason: "final_response" } as const)
					: hostAction;

			if (action.type !== "request") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const finalizedDeliveries = await emitDeliveries(
				"deliveries" in action ? (action.deliveries ?? []) : [],
				currentContext,
				newMessages,
				emit,
				signal,
				config.beginDelivery,
			);
			if (action.reason === "delivery" && finalizedDeliveries.length === 0) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			requestContext = {
				...actionContext,
				context: currentContext,
				reason: action.reason,
				deliveries: finalizedDeliveries,
			};

			const hostAuthority = config.getRequestAuthority?.();
			const requestSnapshot = signal?.aborted ? undefined : await config.prepareRequest?.(requestContext);
			if (requestSnapshot) {
				currentContext = requestSnapshot.context ?? currentContext;
				config = {
					...config,
					model: requestSnapshot.model ?? config.model,
				};
				if (requestSnapshot.thinkingLevel === "off") {
					delete config.reasoning;
				} else if (requestSnapshot.thinkingLevel !== undefined) {
					config.reasoning = requestSnapshot.thinkingLevel;
				}
			}

			const providerAgentContext =
				requestContext.reason === "final_response"
					? {
							...currentContext,
							tools: [],
							systemPrompt: `${currentContext.systemPrompt}\n\n[VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY]\nProvide one final assistant response summarizing the completed work and verification. Do not call tools or begin additional implementation.`,
						}
					: currentContext;
			preparedRequest = signal?.aborted
				? undefined
				: await materializePreparedProviderRequest(
						providerAgentContext,
						requestContext,
						config,
						hostAuthority,
						signal,
					);
			if (preparedRequest) {
				const admission: AgentPreparedRequestDecision = (await config.admitPreparedRequest?.(preparedRequest)) ?? {
					type: "admit",
				};
				if (admission.type === "pause") {
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
			}
		}

		const isFinalResponse = requestContext.reason === "final_response";

		let turnStarted = false;
		if (preparedRequest && !signal?.aborted) {
			if (!Object.is(config.getRequestAuthority?.(), preparedRequest.hostAuthority)) {
				throw new Error("Prepared provider request host authority is stale");
			}
			config.consumePreparedRequest?.(preparedRequest.checkpointId);
			await emit({ type: "turn_start" });
			turnStarted = true;
		}
		const message =
			preparedRequest === undefined || signal?.aborted
				? undefined
				: await streamPreparedAssistantResponse(currentContext, preparedRequest, signal, emit, streamFn);
		if (!message) {
			if (!turnStarted) await emit({ type: "turn_start" });
			const requestModel = preparedRequest?.model ?? config.model;
			const preflightAbortedMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				timestamp: Date.now(),
			} satisfies AssistantMessage;
			currentContext.messages.push(preflightAbortedMessage);
			await emit({ type: "message_start", message: preflightAbortedMessage });
			const replacement = await emit({ type: "message_end", message: preflightAbortedMessage });
			const abortedMessage = resolveMessageReplacement(preflightAbortedMessage, replacement);
			currentContext.messages[currentContext.messages.length - 1] = abortedMessage;
			newMessages.push(abortedMessage);
			await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		newMessages.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const toolCalls = message.content.filter((content) => content.type === "toolCall");
		const toolResults: ToolResultMessage[] = [];
		let disposition: ToolBatchDisposition = "continue";
		if (toolCalls.length > 0) {
			if (isFinalResponse) {
				for (const toolCall of toolCalls) {
					const result: ToolResultMessage = {
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: "Tools are disabled for the final response." }],
						details: {},
						isError: true,
						timestamp: Date.now(),
					};
					toolResults.push(await emitCompletedMessage(result, emit));
				}
			} else {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				disposition = executedToolBatch.disposition;
			}
			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}
		}

		const abortedBeforeTurnEnd = signal?.aborted === true;
		await emit({ type: "turn_end", message, toolResults });
		completedTurn = { message, toolResults, disposition };
		if (signal?.aborted) {
			if (toolCalls.length > 0 || !abortedBeforeTurnEnd) {
				await emitBoundaryAbort(currentContext, newMessages, config, emit);
			}
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		if (isFinalResponse) {
			requestAuthority = "provider";
			defaultAction = { type: "stop" };
		} else if (disposition === "final_response") {
			requestAuthority = "final_response";
			defaultAction = { type: "request", reason: "final_response" };
		} else if (toolCalls.length > 0 && disposition === "continue") {
			requestAuthority = "tool_continuation";
			defaultAction = { type: "request", reason: "continuation" };
		} else {
			requestAuthority = "provider";
			defaultAction = { type: "stop" };
		}
	}
}

async function emitBoundaryAbort(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
): Promise<void> {
	const marker = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	} satisfies AssistantMessage;
	await emit({ type: "turn_start" });
	await emit({ type: "message_start", message: marker });
	const replacement = await emit({ type: "message_end", message: marker });
	const finalizedMarker = resolveMessageReplacement(marker, replacement);
	currentContext.messages.push(finalizedMarker);
	newMessages.push(finalizedMarker);
	await emit({ type: "turn_end", message: finalizedMarker, toolResults: [] });
}

async function resolveNextAction(
	config: AgentLoopConfig,
	context: AgentLoopNextActionContext,
): Promise<AgentLoopNextAction> {
	return config.nextAction ? await config.nextAction(context) : context.defaultAction;
}

async function emitDeliveries(
	deliveries: AgentLoopDelivery[],
	context: AgentContext,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	beginDelivery:
		| ((delivery: AgentLoopDelivery) => AgentLoopDeliveryOutcome | Promise<AgentLoopDeliveryOutcome>)
		| undefined,
): Promise<AgentLoopDelivery[]> {
	const finalizedDeliveries: AgentLoopDelivery[] = [];
	for (const delivery of deliveries) {
		if (signal?.aborted) continue;
		const settlement = beginDelivery ? await beginDelivery(delivery) : { outcome: "committed" as const };
		if (settlement.outcome === "revoked") continue;
		if (settlement.outcome === "retained" || settlement.outcome === "terminally_failed") {
			throw new AgentDeliverySettlementError(settlement.outcome, delivery.deliveryId, settlement.error);
		}
		const canonicalDeliveryMessages = delivery.messages.map((message) =>
			canonicalizeMessageReplacement(message, undefined, UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY),
		);
		await emit({
			type: "delivery_start",
			...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
			messages: canonicalDeliveryMessages,
		});
		const finalizedMessages: AgentMessage[] = [];
		for (const message of canonicalDeliveryMessages) {
			const finalizedMessage = await emitCompletedMessage(message, emit, delivery.deliveryId);
			context.messages.push(finalizedMessage);
			newMessages.push(finalizedMessage);
			finalizedMessages.push(finalizedMessage);
		}
		finalizedDeliveries.push({
			...delivery,
			messages: finalizedMessages,
		});
	}
	return finalizedDeliveries;
}

function clonePreparedDelivery(delivery: AgentLoopDelivery): AgentLoopDelivery {
	return {
		...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
		messages: structuredClone(delivery.messages),
	};
}

function clonePreparedStreamOptions(
	config: AgentLoopConfig,
	resolvedApiKey: string | undefined,
): PreparedProviderStreamOptions {
	return {
		...(config.temperature === undefined ? {} : { temperature: config.temperature }),
		...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
		...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
		...(config.transport === undefined ? {} : { transport: config.transport }),
		...(config.cacheRetention === undefined ? {} : { cacheRetention: config.cacheRetention }),
		...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
		...(config.onPayload === undefined ? {} : { onPayload: config.onPayload }),
		...(config.onResponse === undefined ? {} : { onResponse: config.onResponse }),
		...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
		...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
		...(config.websocketConnectTimeoutMs === undefined
			? {}
			: { websocketConnectTimeoutMs: config.websocketConnectTimeoutMs }),
		...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
		...(config.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: config.maxRetryDelayMs }),
		...(config.metadata === undefined ? {} : { metadata: structuredClone(config.metadata) }),
		...(config.env === undefined ? {} : { env: { ...config.env } }),
		...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
		...(config.inferenceSpeed === undefined ? {} : { inferenceSpeed: config.inferenceSpeed }),
		...(config.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...config.thinkingBudgets } }),
	};
}

async function materializeProviderContext(
	context: Pick<AgentContext, "systemPrompt" | "tools">,
	messages: readonly AgentMessage[],
	transformContext: AgentLoopConfig["transformContext"],
	convertToLlm: AgentLoopConfig["convertToLlm"],
	signal?: AbortSignal,
): Promise<Context | undefined> {
	let transformedMessages = [...messages];
	if (transformContext) transformedMessages = await transformContext(transformedMessages, signal);
	if (signal?.aborted) return undefined;
	const providerMessages = await convertToLlm(transformedMessages);
	if (signal?.aborted) return undefined;
	if (providerMessages.at(-1)?.role === "assistant") {
		throw new Error("Cannot request with an assistant message at the provider transcript tail");
	}
	return {
		...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
		messages: providerMessages,
		...(context.tools === undefined
			? {}
			: {
					tools: context.tools.map(
						(tool): Tool => ({
							name: tool.name,
							description: tool.description,
							parameters: structuredClone(tool.parameters),
						}),
					),
				}),
	};
}

function deepFreezeCanonical<T>(value: T, visited = new WeakSet<object>()): T {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	if (typeof value === "function" || visited.has(value)) return value;
	visited.add(value);
	for (const nested of Object.values(value)) deepFreezeCanonical(nested, visited);
	return Object.freeze(value);
}

function freezePreparedProviderRequest(input: PreparedProviderRequest): PreparedProviderRequest {
	const providerContext = deepFreezeCanonical(structuredClone(input.providerContext)) as Readonly<Context>;
	const model = deepFreezeCanonical(structuredClone(input.model));
	const streamOptions = deepFreezeCanonical({ ...input.streamOptions });
	const completedTurn =
		input.completedTurn === undefined ? undefined : deepFreezeCanonical(structuredClone(input.completedTurn));
	const defaultAction = deepFreezeCanonical(structuredClone(input.defaultAction));
	const deliveries = deepFreezeCanonical(input.deliveries.map(clonePreparedDelivery));
	return Object.freeze({
		...input,
		providerContext,
		model,
		streamOptions,
		...(completedTurn === undefined ? {} : { completedTurn }),
		defaultAction,
		deliveries,
	});
}

async function materializePreparedProviderRequest(
	context: AgentContext,
	requestContext: PrepareRequestContext,
	config: AgentLoopConfig,
	hostAuthority: unknown,
	signal?: AbortSignal,
): Promise<PreparedProviderRequest | undefined> {
	const providerContext = await materializeProviderContext(
		context,
		context.messages,
		config.transformContext,
		config.convertToLlm,
		signal,
	);
	if (!providerContext || signal?.aborted) return undefined;
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	if (signal?.aborted) return undefined;
	if (!Object.is(config.getRequestAuthority?.(), hostAuthority)) {
		throw new Error("Prepared provider request host authority is stale");
	}
	return freezePreparedProviderRequest({
		checkpointId: globalThis.crypto.randomUUID(),
		requestId: globalThis.crypto.randomUUID(),
		attempt: 0,
		runId: config.runId ?? globalThis.crypto.randomUUID(),
		hostAuthority,
		providerContext,
		model: config.model,
		streamOptions: clonePreparedStreamOptions(config, resolvedApiKey),
		...(requestContext.completedTurn === undefined ? {} : { completedTurn: requestContext.completedTurn }),
		defaultAction: requestContext.defaultAction,
		requestAuthority: requestContext.requestAuthority,
		reason: requestContext.reason,
		deliveries: requestContext.deliveries,
	});
}

/** Derive one compaction successor without repeating delivery, preparation, or option resolution. */
export async function rematerializePreparedProviderRequest(
	request: PreparedProviderRequest,
	messages: readonly AgentMessage[],
	options: {
		transformContext?: AgentLoopConfig["transformContext"];
		convertToLlm: AgentLoopConfig["convertToLlm"];
	},
): Promise<PreparedProviderRequest> {
	const providerContext = await materializeProviderContext(
		{
			systemPrompt: request.providerContext.systemPrompt ?? "",
			...(request.providerContext.tools === undefined
				? {}
				: { tools: [...request.providerContext.tools] as AgentTool<any, any>[] }),
		},
		messages,
		options.transformContext,
		options.convertToLlm,
	);
	if (!providerContext) throw new Error("Prepared provider request replacement was aborted");
	return freezePreparedProviderRequest({
		...request,
		checkpointId: globalThis.crypto.randomUUID(),
		attempt: request.attempt + 1,
		providerContext,
	});
}

/** Take immutable ownership of one provider-reported attestation. */
function ownToolSetSnapshotAuthority(authority: ToolSetSnapshotAuthority): ToolSetSnapshotAuthority {
	if (authority.kind === "unknown") return UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY;
	return Object.freeze({
		kind: "known",
		snapshot: deepFreezeCanonical(structuredClone(authority.snapshot)),
	});
}

/** Stream an already materialized provider request. */
async function streamPreparedAssistantResponse(
	context: AgentContext,
	request: PreparedProviderRequest,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	const streamFunction = streamFn || streamSimple;
	const llmContext = structuredClone(request.providerContext) as Context;
	let toolSetSnapshotAuthority: ToolSetSnapshotAuthority = UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY;
	const response = await streamFunction(request.model, llmContext, {
		...request.streamOptions,
		...(signal === undefined ? {} : { signal }),
		reportToolSetSnapshot: (authority) => {
			toolSetSnapshotAuthority = ownToolSetSnapshotAuthority(authority);
		},
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	const finalizeMessage = async (rawMessage: AssistantMessage): Promise<AssistantMessage> => {
		const finalMessage = canonicalizeMessageReplacement(rawMessage, undefined, toolSetSnapshotAuthority);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: finalMessage });
		}
		const replacement = await emit({ type: "message_end", message: finalMessage });
		const emittedMessage = resolveAssistantMessageReplacement(finalMessage, replacement, toolSetSnapshotAuthority);
		context.messages[context.messages.length - 1] = emittedMessage;
		return emittedMessage;
	};

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = canonicalizeMessageReplacement(event.snapshot, undefined, toolSetSnapshotAuthority);
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: partialMessage });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = canonicalizeMessageReplacement(event.snapshot, undefined, toolSetSnapshotAuthority);
					context.messages[context.messages.length - 1] = partialMessage;
					const canonicalEvent = { ...event, snapshot: partialMessage } as AssistantMessageEvent;
					await emit({
						type: "message_update",
						assistantMessageEvent: canonicalEvent,
						message: partialMessage,
					});
				}
				break;

			case "done":
			case "error":
				return await finalizeMessage(await response.result());
		}
	}

	return await finalizeMessage(await response.result());
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	disposition: ToolBatchDisposition;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		const finalizedToolResultMessage = await emitCompletedMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(finalizedToolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		disposition: reduceToolBatchDisposition(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const hasResetTransition = orderedFinalizedCalls.some(
		(finalized) => finalized.result.toolSetTransition?.kind === "reset",
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(
			hasResetTransition && finalized.result.toolSetTransition?.kind === "additive"
				? { ...finalized, result: { ...finalized.result, toolSetTransition: { kind: "reset" } } }
				: finalized,
		);
		messages.push(await emitCompletedMessage(toolResultMessage, emit));
	}

	return {
		messages,
		disposition: reduceToolBatchDisposition(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any, any>;
	args: JsonObject;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function reduceToolBatchDisposition(finalizedCalls: FinalizedToolCallOutcome[]): ToolBatchDisposition {
	if (finalizedCalls.some((finalized) => !finalized.isError && finalized.result.disposition === "final_response")) {
		return "final_response";
	}
	if (finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.disposition === "stop")) {
		return "stop";
	}
	return "continue";
}

function prepareToolCallArguments(tool: AgentTool<any, any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as JsonObject,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall) as JsonObject;
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					).then(() => {}),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				const details = afterResult.details !== undefined ? afterResult.details : result.details;
				const disposition = afterResult.disposition ?? result.disposition;
				result = {
					content: afterResult.content ?? result.content,
					...(details === undefined ? {} : { details }),
					...(result.toolSetTransition === undefined ? {} : { toolSetTransition: result.toolSetTransition }),
					...(disposition === undefined ? {} : { disposition }),
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		...(finalized.result.details === undefined ? {} : { details: finalized.result.details }),
		...(finalized.result.toolSetTransition === undefined
			? {}
			: { toolSetTransition: finalized.result.toolSetTransition }),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitCompletedMessage<MessageType extends AgentMessage>(
	message: MessageType,
	emit: AgentEventSink,
	deliveryId?: string,
): Promise<MessageType> {
	const delivery = deliveryId === undefined ? {} : { deliveryId };
	const canonicalMessage = canonicalizeMessageReplacement(message, undefined, UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY);
	await emit({ type: "message_start", message: canonicalMessage, ...delivery });
	const replacement = await emit({ type: "message_end", message: canonicalMessage, ...delivery });
	return resolveMessageReplacement(canonicalMessage, replacement);
}

function resolveAssistantMessageReplacement(
	message: AssistantMessage,
	replacement: AgentEventSinkResult,
	authority: ToolSetSnapshotAuthority,
): AssistantMessage {
	return canonicalizeMessageReplacement(message, replacement ?? undefined, authority);
}

function resolveMessageReplacement<MessageType extends AgentMessage>(
	message: MessageType,
	replacement: AgentEventSinkResult,
): MessageType {
	return canonicalizeMessageReplacement(message, replacement ?? undefined, UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY);
}
