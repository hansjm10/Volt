import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { JsonObject } from "../utils/json-value.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({
		type: "start",
		init: { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() },
	});

	void (async () => {
		let usage = createEmptyUsage();
		let stopReason: StopReason = "stop";
		let responseId: string | undefined;
		let nextContentIndex = 0;
		let currentBlock: { type: "text" | "thinking"; contentIndex: number; signature?: string } | undefined;
		const toolCallIds = new Set<string>();
		let hasToolCalls = false;

		const closeCurrentBlock = () => {
			if (!currentBlock) {
				return;
			}
			if (currentBlock.type === "text") {
				normalizer.push({
					type: "text_end",
					contentIndex: currentBlock.contentIndex,
					textSignature: currentBlock.signature,
				});
			} else {
				normalizer.push({
					type: "thinking_end",
					contentIndex: currentBlock.contentIndex,
					thinkingSignature: currentBlock.signature,
				});
			}
			currentBlock = undefined;
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await client.models.generateContentStream(params);

			for await (const chunk of googleStream) {
				// @google/genai documents GenerateContentResponse.responseId as an output-only field
				// used to identify each response. Keep the first non-empty one from the stream.
				if (!responseId && chunk.responseId) {
					responseId = chunk.responseId;
					normalizer.push({ type: "meta", patch: { responseId } });
				}
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							const blockType = isThinking ? "thinking" : "text";
							if (!currentBlock || currentBlock.type !== blockType) {
								closeCurrentBlock();
								currentBlock = { type: blockType, contentIndex: nextContentIndex++ };
								normalizer.push({ type: `${blockType}_start`, contentIndex: currentBlock.contentIndex });
							}
							currentBlock.signature = retainThoughtSignature(currentBlock.signature, part.thoughtSignature);
							normalizer.push({
								type: `${blockType}_delta`,
								contentIndex: currentBlock.contentIndex,
								delta: part.text,
							});
						}

						if (part.functionCall) {
							closeCurrentBlock();

							// Generate unique ID if not provided or if it's a duplicate
							const providedId = part.functionCall.id;
							const needsNewId = !providedId || toolCallIds.has(providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;
							toolCallIds.add(toolCallId);
							hasToolCalls = true;
							const contentIndex = nextContentIndex++;
							const args = (part.functionCall.args as JsonObject | undefined) ?? {};
							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: args,
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};
							normalizer.push({
								type: "toolcall_start",
								contentIndex,
								id: toolCall.id,
								name: toolCall.name,
							});
							normalizer.push({
								type: "toolcall_delta",
								contentIndex,
								argsTextDelta: JSON.stringify(args),
							});
							normalizer.push({ type: "toolcall_end", contentIndex, toolCall });
						}
					}
				}

				if (candidate?.finishReason) {
					stopReason = hasToolCalls ? "toolUse" : mapStopReason(candidate.finishReason);
				}

				if (chunk.usageMetadata) {
					usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, usage);
					normalizer.push({ type: "meta", patch: { usage } });
				}
			}

			closeCurrentBlock();

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (stopReason === "aborted" || stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			normalizer.push({ type: "done", reason: stopReason, usage });
		} catch (error) {
			normalizer.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : JSON.stringify(error),
				usage,
			});
		} finally {
			normalizer.end();
		}
	})();

	return normalizer.stream;
};

function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamGoogle(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const googleModel = model as Model<"google-generative-ai">;

	if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {
		return streamGoogle(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, googleModel),
			},
		} satisfies GoogleOptions);
	}

	return streamGoogle(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(googleModel, effort, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

function isGemma4Model(model: Model<"google-generative-ai">): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	const id = model.id.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to volt.
	if (isGemini3ProModel(model)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}
	if (isGemma4Model(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getThinkingLevel(effort: ClampedThinkingLevel, model: Model<"google-generative-ai">): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	if (isGemma4Model(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	return -1;
}
