import { Mistral } from "@mistralai/mistralai";
import type {
	ChatCompletionStreamRequest,
	ChatCompletionStreamRequestMessage,
	CompletionEvent,
	ContentChunk,
	FunctionTool,
} from "@mistralai/mistralai/models/components";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import type { JsonObject } from "../utils/json-value.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

/**
 * Provider-specific options for the Mistral API.
 */
type MistralReasoningEffort = "none" | "high";

export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}

/**
 * Stream responses from Mistral using `chat.stream`.
 */
export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({
		type: "start",
		init: {
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
		},
	});

	(async () => {
		const streamState = createMistralStreamState();

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// Intentionally per-request: avoids shared SDK mutable state across concurrent consumers.
			const mistral = new Mistral({
				apiKey,
				serverURL: model.baseUrl,
			});

			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));

			let payload = buildChatPayload(model, context, transformedMessages, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as ChatCompletionStreamRequest;
			}
			const mistralStream = await mistral.chat.stream(payload, buildRequestOptions(model, options));
			await consumeChatStream(model, normalizer, mistralStream, streamState);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (streamState.stopReason === "aborted" || streamState.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			normalizer.push({ type: "done", reason: streamState.stopReason, usage: streamState.usage });
		} catch (error) {
			normalizer.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: formatMistralError(error),
				usage: streamState.usage,
			});
		} finally {
			normalizer.end();
		}
	})();

	return normalizer.stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	const shouldUseReasoning = model.reasoning && reasoning !== undefined;

	return streamMistral(model, context, {
		...base,
		promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
		reasoningEffort:
			shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : undefined,
	} satisfies MistralOptions);
};

function createMistralToolCallIdNormalizer(): (id: string) => string {
	const idMap = new Map<string, string>();
	const reverseMap = new Map<string, string>();

	return (id: string): string => {
		const existing = idMap.get(id);
		if (existing) return existing;

		let attempt = 0;
		while (true) {
			const candidate = deriveMistralToolCallId(id, attempt);
			const owner = reverseMap.get(candidate);
			if (!owner || owner === id) {
				idMap.set(id, candidate);
				reverseMap.set(candidate, id);
				return candidate;
			}
			attempt++;
		}
	};
}

function deriveMistralToolCallId(id: string, attempt: number): string {
	const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	const seedBase = normalized || id;
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	return shortHash(seed)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const sdkError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof sdkError.statusCode === "number" ? sdkError.statusCode : undefined;
		const bodyText = typeof sdkError.body === "string" ? sdkError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function buildRequestOptions(model: Model<"mistral-conversations">, options?: MistralOptions) {
	const requestOptions: {
		signal?: AbortSignal;
		retries: { strategy: "none" };
		headers?: Record<string, string>;
	} = {
		retries: { strategy: "none" },
	};
	if (options?.signal) requestOptions.signal = options.signal;

	const headers: Record<string, string> = {};
	if (model.headers) Object.assign(headers, model.headers);
	if (options?.headers) Object.assign(headers, options.headers);

	// Mistral infrastructure uses `x-affinity` for KV-cache reuse (prefix caching).
	// Respect explicit caller-provided header values.
	if (options?.sessionId && !headers["x-affinity"]) {
		headers["x-affinity"] = options.sessionId;
	}

	if (Object.keys(headers).length > 0) {
		requestOptions.headers = headers;
	}

	return requestOptions;
}

function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: Context,
	messages: Message[],
	options?: MistralOptions,
): ChatCompletionStreamRequest {
	const payload: ChatCompletionStreamRequest = {
		model: model.id,
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;

	if (context.systemPrompt) {
		payload.messages.unshift({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	return payload;
}

interface MistralContentBlockState {
	kind: "text" | "thinking";
	contentIndex: number;
}

interface MistralToolBlockState {
	contentIndex: number;
	id: string;
	name: string;
	authoritativeArguments?: JsonObject;
}

interface MistralStreamState {
	usage: Usage;
	stopReason: StopReason;
	responseId?: string;
	nextContentIndex: number;
	currentBlock: MistralContentBlockState | null;
	toolBlocksByKey: Map<string, MistralToolBlockState>;
}

function createMistralStreamState(): MistralStreamState {
	return {
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		nextContentIndex: 0,
		currentBlock: null,
		toolBlocksByKey: new Map(),
	};
}

async function consumeChatStream(
	model: Model<"mistral-conversations">,
	normalizer: AssistantStreamNormalizer,
	mistralStream: AsyncIterable<CompletionEvent>,
	state: MistralStreamState,
): Promise<void> {
	for await (const event of mistralStream) {
		const chunk = event.data;
		// Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
		// mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
		if (!state.responseId && chunk.id) {
			state.responseId = chunk.id;
			normalizer.push({ type: "meta", patch: { responseId: chunk.id } });
		}

		if (chunk.usage) {
			state.usage = {
				input: chunk.usage.promptTokens || 0,
				output: chunk.usage.completionTokens || 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens:
					chunk.usage.totalTokens || (chunk.usage.promptTokens || 0) + (chunk.usage.completionTokens || 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			calculateCost(model, state.usage);
			normalizer.push({ type: "meta", patch: { usage: state.usage } });
		}

		const choice = chunk.choices[0];
		if (!choice) continue;

		if (choice.finishReason) {
			state.stopReason = mapChatStopReason(choice.finishReason);
		}

		const delta = choice.delta;
		if (delta.content !== null && delta.content !== undefined) {
			const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
			for (const item of contentItems) {
				if (typeof item === "string") {
					emitMistralTextDelta(normalizer, state, sanitizeSurrogates(item));
					continue;
				}

				if (item.type === "thinking") {
					const deltaText = item.thinking
						.map((part) => ("text" in part ? part.text : ""))
						.filter((text) => text.length > 0)
						.join("");
					const thinkingDelta = sanitizeSurrogates(deltaText);
					if (!thinkingDelta) continue;
					emitMistralThinkingDelta(normalizer, state, thinkingDelta);
					continue;
				}

				if (item.type === "text") {
					emitMistralTextDelta(normalizer, state, sanitizeSurrogates(item.text));
				}
			}
		}

		for (const toolCall of delta.toolCalls || []) {
			finishMistralContentBlock(normalizer, state);
			const callId =
				toolCall.id && toolCall.id !== "null"
					? toolCall.id
					: deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
			const key = `${callId}:${toolCall.index || 0}`;
			let block = state.toolBlocksByKey.get(key);
			if (!block) {
				block = {
					contentIndex: state.nextContentIndex,
					id: callId,
					name: toolCall.function.name,
				};
				state.nextContentIndex += 1;
				state.toolBlocksByKey.set(key, block);
				normalizer.push({
					type: "toolcall_start",
					contentIndex: block.contentIndex,
					id: block.id,
					name: block.name,
				});
			}

			const argumentsValue = toolCall.function.arguments;
			if (typeof argumentsValue === "string") {
				normalizer.push({
					type: "toolcall_delta",
					contentIndex: block.contentIndex,
					argsTextDelta: argumentsValue,
				});
			} else {
				const authoritativeArguments = toMistralToolArguments(argumentsValue);
				if (block.authoritativeArguments === undefined) {
					normalizer.push({
						type: "toolcall_delta",
						contentIndex: block.contentIndex,
						argsTextDelta: JSON.stringify(authoritativeArguments),
					});
				}
				block.authoritativeArguments = authoritativeArguments;
			}
		}
	}

	finishMistralContentBlock(normalizer, state);
	for (const block of state.toolBlocksByKey.values()) {
		normalizer.push({
			type: "toolcall_end",
			contentIndex: block.contentIndex,
			...(block.authoritativeArguments === undefined
				? {}
				: {
						toolCall: {
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.authoritativeArguments,
						} satisfies ToolCall,
					}),
		});
	}
}

function emitMistralTextDelta(normalizer: AssistantStreamNormalizer, state: MistralStreamState, delta: string): void {
	if (state.currentBlock?.kind !== "text") {
		finishMistralContentBlock(normalizer, state);
		state.currentBlock = { kind: "text", contentIndex: state.nextContentIndex };
		state.nextContentIndex += 1;
		normalizer.push({ type: "text_start", contentIndex: state.currentBlock.contentIndex });
	}
	normalizer.push({ type: "text_delta", contentIndex: state.currentBlock.contentIndex, delta });
}

function emitMistralThinkingDelta(
	normalizer: AssistantStreamNormalizer,
	state: MistralStreamState,
	delta: string,
): void {
	if (state.currentBlock?.kind !== "thinking") {
		finishMistralContentBlock(normalizer, state);
		state.currentBlock = { kind: "thinking", contentIndex: state.nextContentIndex };
		state.nextContentIndex += 1;
		normalizer.push({ type: "thinking_start", contentIndex: state.currentBlock.contentIndex });
	}
	normalizer.push({ type: "thinking_delta", contentIndex: state.currentBlock.contentIndex, delta });
}

function finishMistralContentBlock(normalizer: AssistantStreamNormalizer, state: MistralStreamState): void {
	const block = state.currentBlock;
	if (!block) return;
	if (block.kind === "text") {
		normalizer.push({ type: "text_end", contentIndex: block.contentIndex });
	} else {
		normalizer.push({ type: "thinking_end", contentIndex: block.contentIndex });
	}
	state.currentBlock = null;
}

function toMistralToolArguments(value: unknown): JsonObject {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as JsonObject;
	}
	return {};
}

function toFunctionTools(tools: Tool[]): Array<FunctionTool & { type: "function" }> {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: stripSymbolKeys(tool.parameters) as Record<string, unknown>,
			strict: false,
		},
	}));
}

function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripSymbolKeys(item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stripSymbolKeys(entry);
		}
		return result;
	}

	return value;
}

function toChatMessages(messages: Message[], supportsImages: boolean): ChatCompletionStreamRequestMessage[] {
	const result: ChatCompletionStreamRequestMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			const hadImages = msg.content.some((item) => item.type === "image");
			const content: ContentChunk[] = msg.content
				.filter((item) => item.type === "text" || supportsImages)
				.map((item) => {
					if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
					return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
				});
			if (content.length > 0) {
				result.push({ role: "user", content });
				continue;
			}
			if (hadImages && !supportsImages) {
				result.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const contentParts: ContentChunk[] = [];
			const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					continue;
				}
				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						contentParts.push({
							type: "thinking",
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					continue;
				}
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
				});
			}

			const assistantMessage: ChatCompletionStreamRequestMessage = { role: "assistant" };
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			continue;
		}

		const toolContent: ContentChunk[] = [];
		const textResult = msg.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
			.join("\n");
		const hasImages = msg.content.some((part) => part.type === "image");
		const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
		toolContent.push({ type: "text", text: toolText });
		for (const part of msg.content) {
			if (!supportsImages) continue;
			if (part.type !== "image") continue;
			toolContent.push({
				type: "image_url",
				imageUrl: `data:${part.mimeType};base64,${part.data}`,
			});
		}
		result.push({
			role: "tool",
			toolCallId: msg.toolCallId,
			name: msg.toolName,
			content: toolContent,
		});
	}

	return result;
}

function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	const trimmed = text.trim();
	const errorPrefix = isError ? "[tool error] " : "";

	if (trimmed.length > 0) {
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	if (hasImages) {
		if (supportsImages) {
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		return isError
			? "[tool error] (image omitted: model does not support images)"
			: "(image omitted: model does not support images)";
	}

	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
	return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}

function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
	return model.reasoning && !usesReasoningEffort(model);
}

function mapReasoningEffort(
	model: Model<"mistral-conversations">,
	level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): MistralReasoningEffort {
	return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

function mapToolChoice(
	choice: MistralOptions["toolChoice"],
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice as any;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}

function mapChatStopReason(reason: string | null): StopReason {
	if (reason === null) return "stop";
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
		case "model_length":
			return "length";
		case "tool_calls":
			return "toolUse";
		case "error":
			return "error";
		default:
			return "stop";
	}
}
