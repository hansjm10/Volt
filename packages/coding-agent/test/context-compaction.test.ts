import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionPreparation } from "../src/core/compaction/compaction.ts";
import { COMPACTION_TIMEOUT_MS, compactContext } from "../src/core/compaction/context-compaction.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-test",
	name: "Summary Test",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "https://test.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
	systemPrompt: "UNCHANGED SYSTEM",
	tools: [{ name: "read", description: "UNCHANGED TOOL", parameters: { type: "object" } }],
	messages: [{ role: "user", content: "Original goal", timestamp: 1 }],
};
function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: context.messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 580_000,
		previousSummary: "Prior constraint",
		fileOps: { read: new Set(["src/example.ts"]), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 500_000, keepRecentTokens: 20_000 },
	};
}
function streamResponse(
	text = "## Goal\nPreserve original goal",
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
	errorMessage?: string,
) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = fauxAssistantMessage(text, { stopReason, errorMessage });
		if (stopReason === "error" || stopReason === "aborted")
			stream.push({ type: "error", seq: 1, reason: stopReason, error: message });
		else stream.push({ type: "done", seq: 1, reason: stopReason, message });
	});
	return stream;
}
const retry = { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 30_000 };
const options = (streamFn: StreamFn, signal = new AbortController().signal) => ({
	context: async () => context,
	streamFn,
	signal,
	thinkingLevel: "high" as const,
	retry,
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("cache-preserving compaction", () => {
	it("sends one unchanged native prefix plus a bounded checkpoint request", async () => {
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const source = {
			...context,
			messages: [...context.messages, { role: "user" as const, content: "x".repeat(600_000), timestamp: 2 }],
		};
		const result = await compactContext(preparation(), model, {
			...options((_model, request, requestOptions) => {
				calls.push({ context: request, options: requestOptions });
				return streamResponse();
			}),
			context: async () => source,
			customInstructions: "Keep the active deadline",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].context.messages.slice(0, -1)).toEqual(source.messages);
		expect(calls[0].context.systemPrompt).toBe(source.systemPrompt);
		expect(calls[0].context.tools).toEqual(source.tools);
		expect(calls[0].context.messages.at(-1)?.content).toContain("Keep the active deadline");
		expect(calls[0].options).toMatchObject({ maxTokens: 4096, maxRetries: 0, reasoning: "high" });
		expect(result).toMatchObject({
			firstKeptEntryId: "kept",
			tokensBefore: 580_000,
			details: { readFiles: ["src/example.ts"], modifiedFiles: [] },
		});
		expect(result.summary).toContain("<read-files>");
	});

	it.each(["preflight", "provider"] as const)("uses chunking only for %s overflow", async (overflow) => {
		const calls: Context[] = [];
		const opts = options((_model, request) => {
			calls.push(request);
			if (overflow === "provider" && calls.length === 1)
				return streamResponse("", "error", "Your input exceeds the context window of this model");
			return streamResponse();
		});
		const result = await compactContext(
			preparation(),
			overflow === "preflight" ? { ...model, contextWindow: 16_384 } : model,
			opts,
		);
		expect(calls).toHaveLength(overflow === "preflight" ? 1 : 2);
		expect(calls.at(-1)?.systemPrompt).not.toBe(context.systemPrompt);
		expect(calls.at(-1)?.messages[0].content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("<previous-summary>") })]),
		);
		expect(result.summary).toContain("Preserve original goal");
	});

	it("keeps split context in a single request", async () => {
		const prepared = preparation();
		prepared.isSplitTurn = true;
		prepared.turnPrefixMessages = [{ role: "user", content: "prefix task", timestamp: 2 }];
		const source = { ...context, messages: [...context.messages, ...prepared.turnPrefixMessages] } as Context;
		const stream = vi.fn(() => streamResponse());
		await compactContext(prepared, model, { ...options(stream), context: async () => source });
		expect(stream).toHaveBeenCalledTimes(1);
	});

	it.each(["insufficient_quota", "invalid api key", "invalid request"])(
		"does not retry or change strategies after %s",
		async (message) => {
			const stream = vi.fn(() => streamResponse("", "error", message));
			await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow(message);
			expect(stream).toHaveBeenCalledTimes(1);
		},
	);

	it("bounds transient retries at two while retaining the same native request", async () => {
		const calls: Context[] = [];
		await expect(
			compactContext(
				preparation(),
				model,
				options((_model, request) => {
					calls.push(request);
					return streamResponse("", "error", "service unavailable");
				}),
			),
		).rejects.toThrow("failed after 3 attempts");
		expect(calls).toHaveLength(3);
		expect(calls[1]).toEqual(calls[0]);
		expect(calls[2]).toEqual(calls[0]);
	});

	it.each(["length", "toolUse", "aborted"] as const)(
		"rejects %s results instead of committing partial context",
		async (stopReason) => {
			const stream = vi.fn(() => streamResponse("partial", stopReason));
			await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow();
			expect(stream).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects empty text and overlong terminal text even if the provider ignores maxTokens", async () => {
		for (const text of ["", "x".repeat(16_385)]) {
			const stream = vi.fn(() => streamResponse(text));
			await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow();
			expect(stream).toHaveBeenCalledTimes(1);
		}
	});

	it("stops oversized streaming text without waiting for a terminal message", async () => {
		let requestSignal: AbortSignal | undefined;
		const stream: StreamFn = (_model, _request, opts) => {
			requestSignal = opts?.signal;
			const output = createAssistantMessageEventStream();
			output.push({
				type: "text_delta",
				seq: 1,
				contentIndex: 0,
				delta: "x".repeat(16_385),
				snapshot: fauxAssistantMessage(""),
				toolState: [],
			});
			return output;
		};
		await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow("character limit");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("rejects a streamed tool call immediately without waiting for arguments", async () => {
		let requestSignal: AbortSignal | undefined;
		const stream: StreamFn = (_model, _request, opts) => {
			requestSignal = opts?.signal;
			const output = createAssistantMessageEventStream();
			output.push({
				type: "toolcall_start",
				seq: 1,
				contentIndex: 0,
				id: "never-execute",
				name: "bash",
				snapshot: fauxAssistantMessage(""),
				toolState: [],
			});
			return output;
		};
		await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow("tool call");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("applies summary validation and fixed budgets to the oversized fallback too", async () => {
		const calls: SimpleStreamOptions[] = [];
		await expect(
			compactContext(
				preparation(),
				{ ...model, contextWindow: 16_384 },
				options((_model, _context, opts) => {
					calls.push(opts!);
					return streamResponse("partial", "length");
				}),
			),
		).rejects.toThrow("truncated");
		expect(calls).toHaveLength(1);
		expect(calls[0].maxTokens).toBeLessThanOrEqual(4096);
	});

	it.each(["provider", "context", "fallback"] as const)(
		"bounds an uncooperative %s with the overall deadline",
		async (stage) => {
			vi.useFakeTimers();
			let requestSignal: AbortSignal | undefined;
			const stream = vi.fn((_model, _context, opts) => {
				requestSignal = opts?.signal;
				return createAssistantMessageEventStream();
			});
			const opts = options(stream);
			const promise = compactContext(
				preparation(),
				stage === "fallback" ? { ...model, contextWindow: 16_384 } : model,
				{
					...opts,
					context: stage === "context" ? () => new Promise<Context>(() => {}) : opts.context,
				},
			);
			const assertion = expect(promise).rejects.toThrow("timed out after five minutes");
			await vi.advanceTimersByTimeAsync(COMPACTION_TIMEOUT_MS + 1);
			await assertion;
			if (stage !== "context") expect(requestSignal?.aborted).toBe(true);
			else expect(stream).not.toHaveBeenCalled();
		},
	);

	it("cancels a request and backoff without another attempt", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const stream = vi.fn(() => streamResponse("", "error", "service unavailable"));
		const promise = compactContext(preparation(), model, {
			...options(stream, controller.signal),
			retry: { ...retry, baseDelayMs: 10_000 },
		});
		const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		await assertion;
		expect(stream).toHaveBeenCalledTimes(1);
	});
});
