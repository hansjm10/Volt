import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type { AssistantStreamNormalizer } from "../stream/normalizer.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	ServiceTier,
	StopReason,
	TextContent,
	TextSignatureV1,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	transformedMessages?: Message[];
	deferredToolAnchors?: ReadonlyMap<number, Tool[]>;
	deferredToolStrict?: boolean | null;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	deferLoading?: boolean;
}

type OpenAIFunctionTool = Extract<OpenAITool, { type: "function" }>;

export interface ProcessResponsesStreamResult {
	stopReason: StopReason;
	responseId?: string;
	responseItems: ResponseInput;
}

// =============================================================================
// Message conversion
// =============================================================================

export function transformResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
	allowedToolCallProviders: ReadonlySet<string>,
): Message[] {
	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	return transformMessages(messages, model, (id, _targetModel, source) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	});
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const transformedMessages =
		options?.transformedMessages ?? transformResponsesMessages(model, context.messages, allowedToolCallProviders);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const [sourceMessageIndex, msg] of transformedMessages.entries()) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});

			const deferredTools = options?.deferredToolAnchors?.get(sourceMessageIndex) ?? [];
			if (deferredTools.length > 0) {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `volt_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						strict: options?.deferredToolStrict,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map(
		(tool): OpenAIFunctionTool => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
			strict,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		}),
	);
}

// =============================================================================
// Stream processing
// =============================================================================

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	normalizer: AssistantStreamNormalizer,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<ProcessResponsesStreamResult> {
	type SupportedOutputItem = ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall;
	type OutputState =
		| {
				kind: "reasoning";
				contentIndex: number;
				ended: boolean;
				outputIndex?: number;
				itemId?: string;
				hasSummaryPart: boolean;
				item: ResponseReasoningItem;
		  }
		| {
				kind: "message";
				contentIndex: number;
				ended: boolean;
				outputIndex?: number;
				itemId?: string;
				activeContentKind?: "output_text" | "refusal";
				item: ResponseOutputMessage;
		  }
		| {
				kind: "function_call";
				contentIndex: number;
				ended: boolean;
				outputIndex?: number;
				itemId?: string;
				callId: string;
				name: string;
				authoritativeArguments?: string;
				item: ResponseFunctionToolCall;
		  };

	const states: OutputState[] = [];
	const statesByOutputIndex = new Map<number, OutputState>();
	const statesByItemId = new Map<string, OutputState>();
	let currentState: OutputState | undefined;
	let nextContentIndex = 0;
	let stopReason: StopReason = "stop";
	let responseId: string | undefined;
	let sawToolCall = false;

	const eventOutputIndex = (event: ResponseStreamEvent): number | undefined => {
		const value = (event as { output_index?: unknown }).output_index;
		return typeof value === "number" ? value : undefined;
	};
	const eventItemId = (event: ResponseStreamEvent): string | undefined => {
		const value = (event as { item_id?: unknown }).item_id;
		return typeof value === "string" ? value : undefined;
	};
	const rememberState = (state: OutputState): void => {
		states.push(state);
		if (state.outputIndex !== undefined) statesByOutputIndex.set(state.outputIndex, state);
		if (state.itemId) statesByItemId.set(state.itemId, state);
		currentState = state;
	};
	const findState = <Kind extends OutputState["kind"]>(
		event: ResponseStreamEvent,
		kind: Kind,
	): Extract<OutputState, { kind: Kind }> | undefined => {
		const outputIndex = eventOutputIndex(event);
		const itemId = eventItemId(event);
		const state =
			(outputIndex === undefined ? undefined : statesByOutputIndex.get(outputIndex)) ??
			(itemId === undefined ? undefined : statesByItemId.get(itemId)) ??
			currentState;
		return state?.kind === kind ? (state as Extract<OutputState, { kind: Kind }>) : undefined;
	};
	const toolCallId = (state: Extract<OutputState, { kind: "function_call" }>): string | undefined => {
		const itemId = state.item.id ?? state.itemId;
		return itemId ? `${state.callId}|${itemId}` : undefined;
	};
	const updateToolCallIdentity = (
		state: Extract<OutputState, { kind: "function_call" }>,
		event: ResponseStreamEvent,
	): void => {
		const itemId = eventItemId(event);
		if (!state.itemId && itemId) {
			state.itemId = itemId;
			state.item = { ...state.item, id: itemId };
			statesByItemId.set(itemId, state);
		}
	};
	const createState = (event: ResponseStreamEvent, item: SupportedOutputItem): OutputState => {
		const outputIndex = eventOutputIndex(event);
		const itemId = "id" in item && typeof item.id === "string" ? item.id : eventItemId(event);
		const contentIndex = nextContentIndex++;
		if (item.type === "reasoning") {
			const state: OutputState = {
				kind: "reasoning",
				contentIndex,
				ended: false,
				outputIndex,
				itemId,
				hasSummaryPart: false,
				item,
			};
			rememberState(state);
			normalizer.push({ type: "thinking_start", contentIndex });
			return state;
		}
		if (item.type === "message") {
			const lastPart = item.content[item.content.length - 1];
			const activeContentKind =
				lastPart?.type === "output_text" || lastPart?.type === "refusal" ? lastPart.type : undefined;
			const state: OutputState = {
				kind: "message",
				contentIndex,
				ended: false,
				outputIndex,
				itemId,
				activeContentKind,
				item,
			};
			rememberState(state);
			normalizer.push({ type: "text_start", contentIndex });
			return state;
		}

		const state: OutputState = {
			kind: "function_call",
			contentIndex,
			ended: false,
			outputIndex,
			itemId,
			callId: item.call_id,
			name: item.name,
			item,
		};
		rememberState(state);
		sawToolCall = true;
		const id = toolCallId(state);
		normalizer.push({ type: "toolcall_start", contentIndex, id, name: item.name });
		if (item.arguments) {
			normalizer.push({
				type: "toolcall_delta",
				contentIndex,
				argsTextDelta: item.arguments,
				id,
				name: item.name,
			});
		}
		return state;
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			responseId = event.response.id;
			normalizer.push({ type: "meta", patch: { responseId } });
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning" || item.type === "message" || item.type === "function_call") {
				createState(event, item);
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const state = findState(event, "reasoning");
			if (state) state.hasSummaryPart = true;
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const state = findState(event, "reasoning");
			if (state?.hasSummaryPart) {
				normalizer.push({ type: "thinking_delta", contentIndex: state.contentIndex, delta: event.delta });
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const state = findState(event, "reasoning");
			if (state?.hasSummaryPart) {
				normalizer.push({ type: "thinking_delta", contentIndex: state.contentIndex, delta: "\n\n" });
			}
		} else if (event.type === "response.reasoning_text.delta") {
			const state = findState(event, "reasoning");
			if (state) {
				normalizer.push({ type: "thinking_delta", contentIndex: state.contentIndex, delta: event.delta });
			}
		} else if (event.type === "response.content_part.added") {
			const state = findState(event, "message");
			if (state && (event.part.type === "output_text" || event.part.type === "refusal")) {
				state.activeContentKind = event.part.type;
			}
		} else if (event.type === "response.output_text.delta") {
			const state = findState(event, "message");
			if (state?.activeContentKind === "output_text") {
				normalizer.push({ type: "text_delta", contentIndex: state.contentIndex, delta: event.delta });
			}
		} else if (event.type === "response.refusal.delta") {
			const state = findState(event, "message");
			if (state?.activeContentKind === "refusal") {
				normalizer.push({ type: "text_delta", contentIndex: state.contentIndex, delta: event.delta });
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const state = findState(event, "function_call");
			if (state) {
				updateToolCallIdentity(state, event);
				normalizer.push({
					type: "toolcall_delta",
					contentIndex: state.contentIndex,
					argsTextDelta: event.delta,
					id: toolCallId(state),
					name: state.name,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const state = findState(event, "function_call");
			if (state) {
				updateToolCallIdentity(state, event);
				state.authoritativeArguments = event.arguments;
				state.name = event.name || state.name;
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			if (item.type === "reasoning") {
				let state = findState(event, "reasoning");
				if (!state) {
					state = createState(event, item) as Extract<OutputState, { kind: "reasoning" }>;
				}
				state.item = item;
				currentState = state;
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				if (!state.ended) {
					normalizer.push({
						type: "thinking_end",
						contentIndex: state.contentIndex,
						content: summaryText || contentText,
						thinkingSignature: JSON.stringify(item),
					});
					state.ended = true;
				}
			} else if (item.type === "message") {
				let state = findState(event, "message");
				if (!state) {
					state = createState(event, item) as Extract<OutputState, { kind: "message" }>;
				}
				state.item = item;
				currentState = state;
				const content = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				if (!state.ended) {
					normalizer.push({
						type: "text_end",
						contentIndex: state.contentIndex,
						content,
						textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined),
					});
					state.ended = true;
				}
			} else if (item.type === "function_call") {
				let state = findState(event, "function_call");
				if (!state) {
					state = createState(event, item) as Extract<OutputState, { kind: "function_call" }>;
				}
				state.callId = item.call_id;
				state.name = item.name;
				if (item.id) state.itemId = item.id;
				const argumentsJson = item.arguments || state.authoritativeArguments || "{}";
				state.item = {
					...item,
					...(item.id || state.itemId ? { id: item.id ?? state.itemId } : {}),
					arguments: argumentsJson,
				};
				currentState = state;
				const toolCall: ToolCall = {
					type: "toolCall",
					id: toolCallId(state) ?? item.call_id,
					name: state.name,
					arguments: parseStreamingJson(argumentsJson),
				};
				if (!state.ended) {
					normalizer.push({ type: "toolcall_end", contentIndex: state.contentIndex, toolCall });
					state.ended = true;
				}
			}
		} else if (event.type === "response.completed") {
			const response = event.response;
			for (const state of states) {
				if (state.kind !== "function_call" || state.ended || state.authoritativeArguments === undefined) {
					continue;
				}
				state.item = {
					...state.item,
					name: state.name,
					arguments: state.authoritativeArguments,
				};
				normalizer.push({
					type: "toolcall_end",
					contentIndex: state.contentIndex,
					toolCall: {
						type: "toolCall",
						id: toolCallId(state) ?? state.callId,
						name: state.name,
						arguments: parseStreamingJson(state.authoritativeArguments),
					},
				});
				state.ended = true;
			}
			if (response?.id) {
				responseId = response.id;
			}
			let usage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, usage);
			const requestedServiceTier = options?.serviceTier ?? undefined;
			const responseServiceTier = response?.service_tier ?? undefined;
			const effectiveServiceTier = responseServiceTier ?? requestedServiceTier;
			if (requestedServiceTier !== undefined || effectiveServiceTier !== undefined) {
				usage.serviceTier = {
					...(requestedServiceTier === undefined ? {} : { requested: requestedServiceTier satisfies ServiceTier }),
					...(effectiveServiceTier === undefined ? {} : { effective: effectiveServiceTier satisfies ServiceTier }),
				};
			}
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(responseServiceTier, requestedServiceTier)
					: effectiveServiceTier;
				options.applyServiceTierPricing(usage, serviceTier);
			}
			normalizer.push({ type: "meta", patch: { responseId, usage } });
			stopReason = mapStopReason(response?.status);
			if (sawToolCall && stopReason === "stop") {
				stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}

	return {
		stopReason,
		...(responseId === undefined ? {} : { responseId }),
		responseItems: states.map((state) => {
			if (state.kind === "reasoning") {
				return state.item;
			}
			if (state.kind === "message") {
				const text = state.item.content
					.map((part) => (part.type === "output_text" ? part.text : part.refusal))
					.join("");
				return {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: sanitizeSurrogates(text), annotations: [] }],
					status: "completed",
					id: state.item.id,
					...(state.item.phase == null ? {} : { phase: state.item.phase }),
				} satisfies ResponseOutputMessage;
			}
			return {
				type: "function_call",
				...(state.item.id === undefined ? {} : { id: state.item.id }),
				call_id: state.item.call_id,
				name: state.item.name,
				arguments: state.item.arguments,
			} satisfies ResponseFunctionToolCall;
		}),
	};
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
