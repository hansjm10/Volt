import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	AnthropicMessagesCompat,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { createToolSetSnapshot } from "../utils/tool-state.ts";

import { resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses VOLT_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("VOLT_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model),
	};
}

function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	if (
		model.provider !== "anthropic" ||
		model.baseUrl.trim().replace(/\/+$/, "") !== ANTHROPIC_BASE_URL ||
		model.id.includes("haiku")
	) {
		return false;
	}
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimpleAnthropic()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimpleAnthropic()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
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
		let usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		let stopReason: StopReason = "stop";
		let stopErrorMessage: string | undefined;
		let nextContentIndex = 0;
		type AnthropicBlockKind = "text" | "thinking" | "toolCall";
		const blocksByRawIndex = new Map<number, { contentIndex: number; kind: AnthropicBlockKind }>();
		const registerBlock = (rawIndex: number, kind: AnthropicBlockKind) => {
			const block = { contentIndex: nextContentIndex, kind };
			nextContentIndex += 1;
			blocksByRawIndex.set(rawIndex, block);
			return block.contentIndex;
		};
		const resolveBlock = (rawIndex: number, kind: AnthropicBlockKind) => {
			const block = blocksByRawIndex.get(rawIndex);
			return block?.contentIndex ?? registerBlock(rawIndex, kind);
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				if (!apiKey) {
					throw new Error(`No API key for provider: ${model.provider}`);
				}

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
					options?.env,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams === undefined) {
				options?.reportToolSetSnapshot?.({ kind: "known", snapshot: createToolSetSnapshot(context.tools) });
			} else {
				options?.reportToolSetSnapshot?.({ kind: "unknown" });
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			const response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				if (event.type === "message_start") {
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					usage = {
						...usage,
						input: event.message.usage.input_tokens || 0,
						output: event.message.usage.output_tokens || 0,
						cacheRead: event.message.usage.cache_read_input_tokens || 0,
						cacheWrite: event.message.usage.cache_creation_input_tokens || 0,
						cacheWrite1h: event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
					};
					// Anthropic doesn't provide total_tokens, compute from components
					usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					calculateCost(model, usage);
					normalizer.push({ type: "meta", patch: { responseId: event.message.id, usage } });
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const contentIndex = registerBlock(event.index, "text");
						normalizer.push({ type: "text_start", contentIndex });
					} else if (event.content_block.type === "thinking") {
						const contentIndex = registerBlock(event.index, "thinking");
						normalizer.push({ type: "thinking_start", contentIndex });
					} else if (event.content_block.type === "redacted_thinking") {
						const contentIndex = registerBlock(event.index, "thinking");
						normalizer.push({
							type: "thinking_start",
							contentIndex,
							content: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
						});
					} else if (event.content_block.type === "tool_use") {
						const contentIndex = registerBlock(event.index, "toolCall");
						normalizer.push({
							type: "toolcall_start",
							contentIndex,
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
						});
						const seededArgs = JSON.stringify(event.content_block.input ?? {});
						if (seededArgs !== "{}") {
							normalizer.push({ type: "toolcall_delta", contentIndex, argsTextDelta: seededArgs });
						}
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const contentIndex = resolveBlock(event.index, "text");
						normalizer.push({ type: "text_delta", contentIndex, delta: event.delta.text });
					} else if (event.delta.type === "thinking_delta") {
						const contentIndex = resolveBlock(event.index, "thinking");
						normalizer.push({ type: "thinking_delta", contentIndex, delta: event.delta.thinking });
					} else if (event.delta.type === "input_json_delta") {
						const contentIndex = resolveBlock(event.index, "toolCall");
						normalizer.push({
							type: "toolcall_delta",
							contentIndex,
							argsTextDelta: event.delta.partial_json,
						});
					} else if (event.delta.type === "signature_delta") {
						const contentIndex = resolveBlock(event.index, "thinking");
						normalizer.push({
							type: "thinking_delta",
							contentIndex,
							delta: "",
							signatureDelta: event.delta.signature,
						});
					}
				} else if (event.type === "content_block_stop") {
					const block = blocksByRawIndex.get(event.index);
					if (block?.kind === "text") {
						normalizer.push({ type: "text_end", contentIndex: block.contentIndex });
					} else if (block?.kind === "thinking") {
						normalizer.push({ type: "thinking_end", contentIndex: block.contentIndex });
					} else if (block?.kind === "toolCall") {
						normalizer.push({ type: "toolcall_end", contentIndex: block.contentIndex });
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						stopReason = stopReasonResult.stopReason;
						stopErrorMessage = stopReasonResult.errorMessage;
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage.input_tokens != null) {
						usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					// Anthropic doesn't provide total_tokens, compute from components
					usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					calculateCost(model, usage);
					normalizer.push({ type: "meta", patch: { usage } });
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (stopReason === "aborted" || stopReason === "error") {
				throw new Error(stopErrorMessage || "An unknown error occurred");
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

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7+ and Fable 5 support "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const effectiveLevel = level === "max" ? clampThinkingLevel(model, level) : level;
	const mapped = effectiveLevel ? model.thinkingLevelMap?.[effectiveLevel] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (effectiveLevel) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	env?: ProviderEnv,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model, env),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const sessionAffinityHeaders: Record<string, string | null> =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const client = new Anthropic({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const normalizeToolName = isOAuthToken ? toClaudeCodeName : (name: string) => name;
	const toolPlacement = splitDeferredTools(
		{ ...context, messages: transformedMessages },
		compat.supportsToolReferences,
		normalizeToolName,
	);
	let immediateTools = toolPlacement.immediate;
	let deferredTools = [...toolPlacement.deferred.values()];
	if (immediateTools.length === 0 && deferredTools.length > 0) {
		immediateTools = deferredTools;
		deferredTools = [];
	}
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(
			transformedMessages,
			isOAuthToken,
			cacheControl,
			compat.allowEmptySignature,
			toolPlacement.anchors,
		),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (immediateTools.length > 0 || deferredTools.length > 0) {
		params.tools = [
			...convertTools(
				immediateTools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsCacheControlOnTools ? cacheControl : undefined,
			),
			...convertTools(deferredTools, isOAuthToken, compat.supportsEagerToolInputStreaming, undefined, true),
		];
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(
	msg: ToolResultMessage,
	isOAuthToken: boolean,
	anchoredTools: readonly Tool[],
): { toolResult: ContentBlockParam; siblingContent: ContentBlockParam[] } {
	const references: Array<{ type: "tool_reference"; tool_name: string }> = anchoredTools.map((tool) => ({
		type: "tool_reference",
		tool_name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
	}));
	const convertedContent = convertContentBlocks(msg.content);
	return {
		toolResult: {
			type: "tool_result",
			tool_use_id: msg.toolCallId,
			content: references.length > 0 ? references : convertedContent,
			is_error: msg.isError,
		},
		siblingContent:
			references.length === 0
				? []
				: typeof convertedContent === "string"
					? convertedContent.trim().length > 0
						? [{ type: "text", text: convertedContent }]
						: []
					: convertedContent.filter((block) => block.type !== "text" || block.text.trim().length > 0),
	};
}

function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	deferredToolAnchors: ReadonlyMap<number, Tool[]> = new Map(),
): MessageParam[] {
	const params: MessageParam[] = [];

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			const siblingContent: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const converted = convertToolResult(
					transformedMessages[j] as ToolResultMessage,
					isOAuthToken,
					deferredToolAnchors.get(j) ?? [],
				);
				toolResults.push(converted.toolResult);
				siblingContent.push(...converted.siblingContent);
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			// Displaced reference-bearing results must follow every tool_result block.
			params.push({
				role: "user",
				content: [...toolResults, ...siblingContent],
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
	deferLoading = false,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(deferLoading ? { defer_loading: true } : {}),
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
