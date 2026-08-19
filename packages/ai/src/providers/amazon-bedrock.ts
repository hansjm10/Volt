import type { Agent as HttpsAgent } from "node:https";
import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DocumentType, MetadataBearer } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	CacheRetention,
	Context,
	ImageContent,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingLevel,
	Tool,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { resolvePromptCacheRetention, supportsPromptCacheMode } from "./prompt-cache.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: ThinkingLevel;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude's thinking content is returned in responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking content is redacted but the signature still travels back
	 *   for multi-turn continuity, reducing time-to-first-text-token.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.8 and Mythos Preview is
	 * "omitted". We default to "summarized" here to keep behavior consistent with
	 * older Claude 4 models. Only applies to Claude models on Bedrock.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** Key-value pairs attached to the inference request for cost allocation tagging.
	 * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
	 * Tags appear in AWS Cost Explorer split cost allocation data.
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** Bearer token for Bedrock API key authentication.
	 * When set, bypasses SigV4 signing and sends Authorization: Bearer <token> instead.
	 * Requires `bedrock:CallWithBearerToken` IAM permission on the token's identity.
	 * Set via AWS_BEARER_TOKEN_BEDROCK env var or pass directly.
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type BedrockBlockKind = "text" | "thinking" | "toolCall";

interface BedrockStreamBlock {
	contentIndex: number;
	kind: BedrockBlockKind;
}

interface BedrockStreamState {
	blocksByRawIndex: Map<number, BedrockStreamBlock>;
	nextContentIndex: number;
}

const EMPTY_TEXT_PLACEHOLDER = "<empty>";

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({
		type: "start",
		init: {
			api: "bedrock-converse-stream",
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
		const streamState: BedrockStreamState = { blocksByRawIndex: new Map(), nextContentIndex: 0 };

		try {
			const config: BedrockRuntimeClientConfig = {
				profile: options.profile || getProviderEnvValue("AWS_PROFILE", options.env),
			};
			const configuredRegion = getConfiguredBedrockRegion(options);
			const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
			const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
			const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
				model.baseUrl,
				configuredRegion,
				hasAmbientConfiguredProfile,
			);

			// Only pin standard AWS Bedrock runtime endpoints when no region or ambient AWS_PROFILE is configured.
			// This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
			// catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
			if (useExplicitEndpoint) {
				config.endpoint = model.baseUrl;
			}

			// Resolve bearer token for Bedrock API key auth.
			const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
			const bearerToken =
				options.bearerToken || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || undefined;
			const useBearerToken = bearerToken !== undefined && !skipAuth;

			// in Node.js/Bun environment only
			if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
				// Region resolution: ARN-embedded > explicit option > env vars > SDK default chain.
				// When the model ID is an inference profile ARN, extract the region from it.
				// This avoids conflicts with AWS_REGION set for other services.
				const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
				if (arnRegionMatch) {
					config.region = arnRegionMatch[1];
				} else if (configuredRegion) {
					config.region = configuredRegion;
				} else if (endpointRegion && useExplicitEndpoint) {
					config.region = endpointRegion;
				} else if (!hasAmbientConfiguredProfile) {
					config.region = "us-east-1";
				}

				// Support proxies that don't need authentication
				if (skipAuth) {
					config.credentials = {
						accessKeyId: "dummy-access-key",
						secretAccessKey: "dummy-secret-key",
					};
				}

				const credentials = getConfiguredBedrockCredentials(options.env);
				if (!skipAuth && credentials) {
					config.credentials = credentials;
				}

				const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
				if (proxyUrl) {
					// Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
					// on `http2` module and has no support for http agent.
					// Use NodeHttpHandler to support HTTP(S) proxy agents.
					config.requestHandler = new NodeHttpHandler({
						httpAgent: new HttpProxyAgent(proxyUrl),
						httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
					});
				} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
					// Some custom endpoints require HTTP/1.1 instead of HTTP/2
					config.requestHandler = new NodeHttpHandler();
				}
			} else {
				// Non-Node environment (browser): fall back to us-east-1 since
				// there's no config file resolution available.
				config.region =
					configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
			}

			if (useBearerToken) {
				config.token = { token: bearerToken };
				config.authSchemePreference = ["httpBearerAuth"];
			}

			const client = new BedrockRuntimeClient(config);
			if (options.headers && Object.keys(options.headers).length > 0) {
				addCustomHeadersMiddleware(client, options.headers);
			}
			const forcePromptCache = getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", options.env) === "1";
			const cacheRetention =
				forcePromptCache || supportsPromptCacheMode(model, "explicit")
					? resolvePromptCacheRetention(model, options.cacheRetention, options.env, {
							forceShort: forcePromptCache,
						})
					: "none";
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention),
				system: buildSystemPrompt(context.systemPrompt, cacheRetention),
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(context.tools, options.toolChoice),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			if (response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			for await (const item of response.stream!) {
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, streamState, normalizer);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, streamState, normalizer);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, streamState, normalizer);
				} else if (item.messageStop) {
					stopReason = mapStopReason(item.messageStop.stopReason);
				} else if (item.metadata) {
					const metadataUsage = parseMetadataUsage(item.metadata, model);
					if (metadataUsage) {
						usage = metadataUsage;
						normalizer.push({ type: "meta", patch: { usage } });
					}
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (stopReason === "error" || stopReason === "aborted") {
				throw new Error("An unknown error occurred");
			}

			normalizer.push({ type: "done", reason: stopReason, usage });
		} catch (error) {
			normalizer.push({
				type: "error",
				reason: options.signal?.aborted ? "aborted" : "error",
				errorMessage: formatBedrockError(error),
				usage,
			});
		} finally {
			normalizer.end();
		}
	})();

	return normalizer.stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Some models reject the account/profile's configured Bedrock data retention mode
 * (e.g. "data retention mode 'default' is not available for this model"). Point
 * users at the AWS docs explaining how to configure a supported mode.
 */
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
function formatBedrockError(error: unknown): string {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	const dataRetentionHint = /data retention mode/i.test(message)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${message}${dataRetentionHint}`;
	}
	return `${message}${dataRetentionHint}`;
}

/**
 * Header keys that must never be overwritten by caller-supplied headers.
 * `host` and `x-amz-*` participate in the SigV4 canonical request; `authorization`
 * is owned by SigV4 or the bearer-token path (config.token + authSchemePreference).
 * Compared case-insensitively (caller key is lower-cased before lookup).
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * Attach caller-supplied headers to the outgoing Bedrock request via a Smithy
 * `build`-step middleware. The `build` step runs after request serialisation but
 * before SigV4 signing, so injected headers are covered by the signature. Reserved
 * SigV4 / auth headers (`x-amz-*`, `authorization`, `host`) are silently skipped;
 * all other caller headers override any existing same-named header on the request.
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "volt-ai-custom-headers", priority: "low" });
}

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning) {
		return streamBedrock(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return streamBedrock(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined means the caller did not request an output cap; let the helper use the model cap.
		// Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		return streamBedrock(model, context, {
			...base,
			maxTokens: adjusted.maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return streamBedrock(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	state: BedrockStreamState,
	normalizer: AssistantStreamNormalizer,
): void {
	const rawIndex = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const contentIndex = registerBedrockBlock(state, rawIndex, "toolCall");
		normalizer.push({
			type: "toolcall_start",
			contentIndex,
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
		});
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	state: BedrockStreamState,
	normalizer: AssistantStreamNormalizer,
): void {
	const rawIndex = event.contentBlockIndex!;
	const delta = event.delta;

	if (delta?.text !== undefined) {
		const { contentIndex, created } = resolveBedrockBlock(state, rawIndex, "text");
		if (created) {
			normalizer.push({ type: "text_start", contentIndex });
		}
		normalizer.push({ type: "text_delta", contentIndex, delta: delta.text });
	} else if (delta?.toolUse) {
		const { contentIndex } = resolveBedrockBlock(state, rawIndex, "toolCall");
		normalizer.push({
			type: "toolcall_delta",
			contentIndex,
			argsTextDelta: delta.toolUse.input || "",
		});
	} else if (delta?.reasoningContent) {
		const { contentIndex, created } = resolveBedrockBlock(state, rawIndex, "thinking");
		if (created) {
			normalizer.push({ type: "thinking_start", contentIndex });
		}
		const text = delta.reasoningContent.text ?? "";
		const signature = delta.reasoningContent.signature;
		if (text || signature) {
			normalizer.push({
				type: "thinking_delta",
				contentIndex,
				delta: text,
				...(signature === undefined ? {} : { signatureDelta: signature }),
			});
		}
	}
}

function parseMetadataUsage(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
): Usage | undefined {
	if (!event.usage) return undefined;
	const usage: Usage = {
		input: event.usage.inputTokens || 0,
		output: event.usage.outputTokens || 0,
		cacheRead: event.usage.cacheReadInputTokens || 0,
		cacheWrite: event.usage.cacheWriteInputTokens || 0,
		totalTokens: event.usage.totalTokens || (event.usage.inputTokens || 0) + (event.usage.outputTokens || 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	state: BedrockStreamState,
	normalizer: AssistantStreamNormalizer,
): void {
	const block = state.blocksByRawIndex.get(event.contentBlockIndex!);
	if (!block) return;

	switch (block.kind) {
		case "text":
			normalizer.push({ type: "text_end", contentIndex: block.contentIndex });
			break;
		case "thinking":
			normalizer.push({ type: "thinking_end", contentIndex: block.contentIndex });
			break;
		case "toolCall":
			normalizer.push({ type: "toolcall_end", contentIndex: block.contentIndex });
			break;
	}
}

function registerBedrockBlock(state: BedrockStreamState, rawIndex: number, kind: BedrockBlockKind): number {
	const contentIndex = state.nextContentIndex;
	state.nextContentIndex += 1;
	state.blocksByRawIndex.set(rawIndex, { contentIndex, kind });
	return contentIndex;
}

function resolveBedrockBlock(
	state: BedrockStreamState,
	rawIndex: number,
	kind: BedrockBlockKind,
): { contentIndex: number; created: boolean } {
	const block = state.blocksByRawIndex.get(rawIndex);
	if (block) {
		return { contentIndex: block.contentIndex, created: false };
	}
	return { contentIndex: registerBedrockBlock(state, rawIndex, kind), created: true };
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("sonnet-4-6") ||
			s.includes("fable-5"),
	);
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some((s) => s.includes("opus-4-7") || s.includes("opus-4-8") || s.includes("fable-5"));
}

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	const effectiveLevel = level === "max" ? clampThinkingLevel(model, level) : level;
	if (effectiveLevel === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = effectiveLevel ? model.thinkingLevelMap?.[effectiveLevel] : undefined;
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

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

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	if (cacheRetention !== "none") {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				result.push({
					role: ConversationRole.USER,
					content,
				});
				break;
			}
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// Skip empty text blocks
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as unknown as DocumentType },
							});
							break;
						case "thinking": {
							// Skip empty thinking blocks
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// Only Anthropic models support the signature field in reasoningText.
							// For other models, we omit the signature to avoid errors like:
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// Signatures arrive after thinking deltas. If a partial or externally
								// persisted message lacks a signature, Bedrock rejects the replayed
								// reasoning block. Fall back to plain text, matching Anthropic.
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// Add current tool result with all content blocks combined
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: convertToolResultContent(m.content),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// Look ahead for consecutive toolResult messages
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: convertToolResultContent(nextMsg.content),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				continue;
		}
	}

	if (cacheRetention !== "none" && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters as unknown as DocumentType },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasAmbientConfiguredProfile;
}

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock currently rejects the Claude thinking.display field.
		// Omit it there until the GovCloud Converse schema catches up.
		const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // Claude doesn't support xhigh here, clamp to high
						max: 16384, // Token-budget providers don't support max, clamp to high
					};

					// Custom budgets omit native-effort-only levels, so use high for xhigh/max.
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	return { source: { bytes }, format };
}
