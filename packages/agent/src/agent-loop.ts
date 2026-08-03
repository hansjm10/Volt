/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@hansjm10/volt-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
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
	).then((messages) => {
		stream.end(messages);
	});

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
	).then((messages) => {
		stream.end(messages);
	});

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
	await runLoop(currentContext, newMessages, config, initialAction, signal, emit, streamFn);
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
	await runLoop(
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
async function runLoop(
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
	let pendingToolContinuation = false;
	let defaultAction = initialAction;

	while (true) {
		if (signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const actionContext: AgentLoopNextActionContext = {
			context: currentContext,
			newMessages,
			completedTurn,
			pendingToolContinuation,
			defaultAction,
		};
		const resolvedAction = config.nextAction ? await config.nextAction(actionContext) : defaultAction;
		const action =
			resolvedAction.type === "pause" && resolvedAction.pendingToolContinuation === undefined
				? { ...resolvedAction, pendingToolContinuation }
				: resolvedAction;

		if (action.type !== "request") {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		if (signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		await emit({ type: "turn_start" });
		if (signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		const finalizedDeliveries = await emitDeliveries(
			action.deliveries ?? [],
			currentContext,
			newMessages,
			emit,
			config.beginDelivery,
		);
		if (action.reason === "delivery" && finalizedDeliveries.length === 0) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}
		if (signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const requestSnapshot = await config.prepareRequest?.({
			...actionContext,
			context: currentContext,
			deliveries: finalizedDeliveries,
		});
		if (requestSnapshot) {
			currentContext = requestSnapshot.context ?? currentContext;
			config = {
				...config,
				model: requestSnapshot.model ?? config.model,
				reasoning:
					requestSnapshot.thinkingLevel === undefined
						? config.reasoning
						: requestSnapshot.thinkingLevel === "off"
							? undefined
							: requestSnapshot.thinkingLevel,
			};
		}
		if (signal?.aborted) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
		newMessages.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const toolCalls = message.content.filter((content) => content.type === "toolCall");
		const toolResults: ToolResultMessage[] = [];
		let toolBatchTerminated = false;
		if (toolCalls.length > 0) {
			const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
			toolResults.push(...executedToolBatch.messages);
			toolBatchTerminated = executedToolBatch.terminate;
			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}
		}

		await emit({ type: "turn_end", message, toolResults });
		completedTurn = { message, toolResults, toolBatchTerminated };
		pendingToolContinuation = toolCalls.length > 0 && !toolBatchTerminated;
		defaultAction = pendingToolContinuation ? { type: "request", reason: "continuation" } : { type: "stop" };
	}
}

async function emitDeliveries(
	deliveries: AgentLoopDelivery[],
	context: AgentContext,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
	beginDelivery?: (delivery: AgentLoopDelivery) => boolean,
): Promise<AgentLoopDelivery[]> {
	const finalizedDeliveries: AgentLoopDelivery[] = [];
	for (const delivery of deliveries) {
		if (beginDelivery && !beginDelivery(delivery)) continue;
		await emit({ type: "delivery_start", deliveryId: delivery.deliveryId, messages: delivery.messages });
		const finalizedMessages: AgentMessage[] = [];
		for (const message of delivery.messages) {
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

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);
	if (llmMessages.at(-1)?.role === "assistant") {
		throw new Error("Cannot request with an assistant message at the provider transcript tail");
	}

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.snapshot;
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
					partialMessage = event.snapshot;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: partialMessage,
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: finalMessage });
				}
				const replacement = await emit({ type: "message_end", message: finalMessage });
				const emittedMessage = resolveMessageReplacement(finalMessage, replacement);
				context.messages[context.messages.length - 1] = emittedMessage;
				return emittedMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: finalMessage });
	}
	const replacement = await emit({ type: "message_end", message: finalMessage });
	const emittedMessage = resolveMessageReplacement(finalMessage, replacement);
	context.messages[context.messages.length - 1] = emittedMessage;
	return emittedMessage;
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
	terminate: boolean;
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
		terminate: shouldTerminateToolBatch(finalizedCalls),
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
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		messages.push(await emitCompletedMessage(toolResultMessage, emit));
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
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

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
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
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
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
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
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
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitCompletedMessage<MessageType extends AgentMessage>(
	message: MessageType,
	emit: AgentEventSink,
	deliveryId?: string,
): Promise<MessageType> {
	await emit({ type: "message_start", message, deliveryId });
	const replacement = await emit({ type: "message_end", message, deliveryId });
	return resolveMessageReplacement(message, replacement);
}

function resolveMessageReplacement<MessageType extends AgentMessage>(
	message: MessageType,
	replacement: AgentEventSinkResult,
): MessageType {
	if (replacement === undefined) {
		return message;
	}
	if (replacement.role !== message.role) {
		throw new Error("message_end listeners must return a message with the same role");
	}
	return replacement as MessageType;
}
