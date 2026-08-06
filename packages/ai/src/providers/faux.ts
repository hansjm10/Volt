import { registerApiProvider, unregisterApiProviders } from "../api-registry.ts";
import { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.ts";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? randomId("tool"),
		name,
		arguments: arguments_,
	};
}

function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") {
		return [fauxText(content)];
	}
	return Array.isArray(content) ? content : [content];
}

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeFauxAssistantContent(content),
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? Date.now(),
	};
}

export interface FauxProviderState {
	/** Turn requests: `stream`/`complete` calls and agent turns via `streamSimple`. */
	callCount: number;
	/** Auxiliary simple completions (no `context.tools`): naming, compaction, summaries. */
	simpleCallCount: number;
}

export type FauxResponseFactory = (
	context: Context,
	options: StreamOptions | undefined,
	state: FauxProviderState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface RegisterFauxProviderOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	tokensPerSecond?: number;
	tokenSize?: {
		min?: number;
		max?: number;
	};
}

export interface FauxProviderRegistration {
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	/**
	 * Responses served to `streamSimple`/`completeSimple` consumers (session
	 * naming, compaction, branch summaries). These run on a separate queue so a
	 * fire-and-forget background completion can never steal a queued turn
	 * response from `setResponses`; when this queue is empty the simple request
	 * resolves to an error message, which those consumers treat as a no-op.
	 */
	setSimpleResponses: (responses: FauxResponseStep[]) => void;
	appendSimpleResponses: (responses: FauxResponseStep[]) => void;
	getPendingSimpleResponseCount: () => number;
	unregister: () => void;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			return `[image:${block.mimeType}:${block.data.length}]`;
		})
		.join("\n");
}

function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			if (block.type === "thinking") {
				return block.thinking;
			}
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		return contentToText(message.content);
	}
	if (message.role === "assistant") {
		return assistantContentToText(message.content);
	}
	return toolResultToText(message);
}

function serializeContext(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) {
		parts.push(`system:${context.systemPrompt}`);
	}
	for (const message of context.messages) {
		parts.push(`${message.role}:${messageToText(message)}`);
	}
	if (context.tools?.length) {
		parts.push(`tools:${JSON.stringify(context.tools)}`);
	}
	return parts.join("\n\n");
}

function commonPrefixLength(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) {
		index++;
	}
	return index;
}

function withUsageEstimate(
	message: AssistantMessage,
	context: Context,
	options: StreamOptions | undefined,
	promptCache: Map<string, string>,
): AssistantMessage {
	const promptText = serializeContext(context);
	const promptTokens = estimateTokens(promptText);
	const outputTokens = estimateTokens(assistantContentToText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;

	if (sessionId && options?.cacheRetention !== "none") {
		const previousPrompt = promptCache.get(sessionId);
		if (previousPrompt) {
			const cachedChars = commonPrefixLength(previousPrompt, promptText);
			cacheRead = estimateTokens(previousPrompt.slice(0, cachedChars));
			cacheWrite = estimateTokens(promptText.slice(cachedChars));
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			cacheWrite = promptTokens;
		}
		promptCache.set(sessionId, promptText);
	}

	return {
		...message,
		usage: {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(index, index + charSize));
		index += charSize;
	}
	return chunks.length > 0 ? chunks : [""];
}

function cloneMessage(message: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
	const cloned = structuredClone(message);
	return {
		...cloned,
		api,
		provider,
		model: modelId,
		timestamp: cloned.timestamp ?? Date.now(),
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

function createErrorMessage(error: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0) {
		return new Promise((resolve) => queueMicrotask(resolve));
	}
	const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function streamWithDeltas(
	normalizer: AssistantStreamNormalizer,
	message: AssistantMessage,
	minTokenSize: number,
	maxTokenSize: number,
	tokensPerSecond: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	normalizer.push({
		type: "start",
		init: {
			api: message.api,
			provider: message.provider,
			model: message.model,
			timestamp: message.timestamp,
			...(message.responseId === undefined ? {} : { responseId: message.responseId }),
			...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
			...(message.diagnostics === undefined ? {} : { diagnostics: message.diagnostics }),
			usage: message.usage,
		},
	});

	if (signal?.aborted) {
		normalizer.push({ type: "error", reason: "aborted", errorMessage: "Request was aborted", usage: message.usage });
		return;
	}

	for (let index = 0; index < message.content.length; index++) {
		if (signal?.aborted) {
			normalizer.push({
				type: "error",
				reason: "aborted",
				errorMessage: "Request was aborted",
				usage: message.usage,
			});
			return;
		}

		const block = message.content[index];

		if (block.type === "thinking") {
			normalizer.push({
				type: "thinking_start",
				contentIndex: index,
				...(block.redacted
					? {
							content: block.thinking,
							thinkingSignature: block.thinkingSignature,
							redacted: true,
						}
					: {}),
			});
			if (block.redacted) {
				normalizer.push({
					type: "thinking_end",
					contentIndex: index,
					content: block.thinking,
					thinkingSignature: block.thinkingSignature,
					redacted: true,
				});
				continue;
			}
			for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					normalizer.push({
						type: "error",
						reason: "aborted",
						errorMessage: "Request was aborted",
						usage: message.usage,
					});
					return;
				}
				normalizer.push({ type: "thinking_delta", contentIndex: index, delta: chunk });
			}
			normalizer.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
				...(block.redacted === undefined ? {} : { redacted: block.redacted }),
			});
			continue;
		}

		if (block.type === "text") {
			normalizer.push({ type: "text_start", contentIndex: index });
			for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					normalizer.push({
						type: "error",
						reason: "aborted",
						errorMessage: "Request was aborted",
						usage: message.usage,
					});
					return;
				}
				normalizer.push({ type: "text_delta", contentIndex: index, delta: chunk });
			}
			normalizer.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
			});
			continue;
		}

		normalizer.push({ type: "toolcall_start", contentIndex: index, id: block.id, name: block.name });
		for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), minTokenSize, maxTokenSize)) {
			await scheduleChunk(chunk, tokensPerSecond);
			if (signal?.aborted) {
				normalizer.push({
					type: "error",
					reason: "aborted",
					errorMessage: "Request was aborted",
					usage: message.usage,
				});
				return;
			}
			normalizer.push({ type: "toolcall_delta", contentIndex: index, argsTextDelta: chunk });
		}
		normalizer.push({ type: "toolcall_end", contentIndex: index, toolCall: block });
	}

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		normalizer.push({
			type: "error",
			reason: message.stopReason,
			errorMessage: message.errorMessage ?? "An unknown error occurred",
			usage: message.usage,
		});
		return;
	}

	normalizer.push({ type: "done", reason: message.stopReason, usage: message.usage });
}

export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	const api = options.api ?? randomId(DEFAULT_API);
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const sourceId = randomId("faux-provider");
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	let pendingResponses: FauxResponseStep[] = [];
	let pendingSimpleResponses: FauxResponseStep[] = [];
	const tokensPerSecond = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0, simpleCallCount: 0 };
	const promptCache = new Map<string, string>();

	const modelDefinitions = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
	const models = modelDefinitions.map((definition) => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
	})) as [Model<string>, ...Model<string>[]];

	const createQueueStream =
		(takeStep: () => FauxResponseStep | undefined, recordCall: () => void): StreamFunction<string, StreamOptions> =>
		(requestModel, context, streamOptions) => {
			const normalizer = new AssistantStreamNormalizer();
			const step = takeStep();
			recordCall();

			queueMicrotask(async () => {
				try {
					await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
					if (!step) {
						let message = createErrorMessage(
							new Error("No more faux responses queued"),
							api,
							provider,
							requestModel.id,
						);
						message = withUsageEstimate(message, context, streamOptions, promptCache);
						await streamWithDeltas(
							normalizer,
							message,
							minTokenSize,
							maxTokenSize,
							tokensPerSecond,
							streamOptions?.signal,
						);
						return;
					}

					const resolved =
						typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
					let message = cloneMessage(resolved, api, provider, requestModel.id);
					message = withUsageEstimate(message, context, streamOptions, promptCache);
					await streamWithDeltas(
						normalizer,
						message,
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						streamOptions?.signal,
					);
				} catch (error) {
					const message = createErrorMessage(error, api, provider, requestModel.id);
					normalizer.push({
						type: "start",
						init: {
							api: message.api,
							provider: message.provider,
							model: message.model,
							timestamp: message.timestamp,
							usage: message.usage,
						},
					});
					normalizer.push({
						type: "error",
						reason: "error",
						errorMessage: message.errorMessage ?? "An unknown error occurred",
						usage: message.usage,
					});
				} finally {
					normalizer.end();
				}
			});

			return normalizer.stream;
		};

	const stream = createQueueStream(
		() => pendingResponses.shift(),
		() => state.callCount++,
	);
	// Agent turns also arrive via streamSimple (agent-core's StreamFn), always
	// with a tools array in the context. Auxiliary simple completions (session
	// naming, compaction, branch summaries) never set context.tools; route them
	// to their own queue and counter so a fire-and-forget background completion
	// can never race a test's queued turn responses or call-count assertions.
	// Empty simple queue = error message, which best-effort callers treat as a
	// no-op.
	const streamAuxiliary = createQueueStream(
		() => pendingSimpleResponses.shift(),
		() => state.simpleCallCount++,
	);
	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, streamOptions) =>
		context.tools === undefined
			? streamAuxiliary(requestModel, context, streamOptions)
			: stream(requestModel, context, streamOptions);

	registerApiProvider({ api, stream, streamSimple }, sourceId);

	function getModel(): Model<string>;
	function getModel(requestedModelId: string): Model<string> | undefined;
	function getModel(requestedModelId?: string): Model<string> | undefined {
		if (!requestedModelId) {
			return models[0];
		}
		return models.find((candidate) => candidate.id === requestedModelId);
	}

	return {
		api,
		models,
		getModel,
		state,
		setResponses(responses) {
			pendingResponses = [...responses];
		},
		appendResponses(responses) {
			pendingResponses.push(...responses);
		},
		getPendingResponseCount() {
			return pendingResponses.length;
		},
		setSimpleResponses(responses) {
			pendingSimpleResponses = [...responses];
		},
		appendSimpleResponses(responses) {
			pendingSimpleResponses.push(...responses);
		},
		getPendingSimpleResponseCount() {
			return pendingSimpleResponses.length;
		},
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}
