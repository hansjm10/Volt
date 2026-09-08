import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type Usage,
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
	usage?: Partial<Usage>,
	diagnostics?: AssistantMessage["diagnostics"],
) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = fauxAssistantMessage(text, { stopReason, errorMessage });
		message.usage = { ...message.usage, ...usage };
		if (diagnostics !== undefined) message.diagnostics = diagnostics;
		if (stopReason === "error" || stopReason === "aborted")
			stream.push({ type: "error", seq: 1, reason: stopReason, error: message });
		else stream.push({ type: "done", seq: 1, reason: stopReason, message });
	});
	return stream;
}
const retry = { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 30_000 };
const options = (streamFn: StreamFn, signal = new AbortController().signal) => ({
	context: async () => context,
	sourceMessageCount: context.messages.length,
	retainedMessageCount: 0,
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
	it("sends the full unchanged native context plus a bounded checkpoint request", async () => {
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const source = {
			...context,
			messages: [...context.messages, { role: "user" as const, content: "x".repeat(600_000), timestamp: 2 }],
		};
		const result = await compactContext(preparation(), model, {
			...options((_model, request, requestOptions) => {
				calls.push({ context: request, options: requestOptions });
				return streamResponse(undefined, "stop", undefined, {
					input: 1000,
					output: 300,
					cacheRead: 68000,
					cacheWrite: 1000,
					totalTokens: 70300,
				});
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
		expect(result.details.requests).toEqual([
			{
				strategy: "native",
				attempt: 1,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: { input: 1000, output: 300, cacheRead: 68000, cacheWrite: 1000, totalTokens: 70300 },
			},
		]);
	});

	it("keeps retained messages and signatures untouched while appending a bounded summary boundary", async () => {
		const retained: AssistantMessage = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "thinking", thinking: "Recent reasoning", thinkingSignature: "unchanged-reasoning-signature" },
				{
					type: "text",
					text: `RETAINED-BEGIN ${"recent content ".repeat(2000)} RETAINED-END`,
					textSignature: "unchanged-text-signature",
				},
			],
		};
		const source: Context = { ...context, messages: [...context.messages, retained] };
		const original = structuredClone(source);
		let request: Context | undefined;
		await compactContext(preparation(), model, {
			...options((_model, sent) => {
				request = sent;
				return streamResponse();
			}),
			context: async () => source,
			sourceMessageCount: source.messages.length,
			retainedMessageCount: 1,
		});
		expect(source).toEqual(original);
		expect(request?.messages.slice(0, -1)).toEqual(original.messages);
		expect(request?.messages.at(-2)).toEqual(retained);
		const instruction = request?.messages.at(-1)?.content;
		expect(typeof instruction).toBe("string");
		expect(instruction).toContain("Summarize only the older history");
		expect(instruction).toContain("last 1 saved conversation messages");
		expect(instruction).toContain("RETAINED-BEGIN");
		expect(instruction).not.toContain("RETAINED-END");
		expect(instruction!.length).toBeLessThan(4096);
	});

	it.each(["preflight", "provider"] as const)(
		"keeps the fallback older-only when the full warm context exceeds the %s budget",
		async (overflow) => {
			const retained = { role: "user" as const, content: `RECENT-ONLY ${"r".repeat(160_000)}`, timestamp: 2 };
			const source: Context = { ...context, messages: [...context.messages, retained] };
			const calls: Context[] = [];
			const result = await compactContext(
				preparation(),
				overflow === "preflight" ? { ...model, contextWindow: 40_000 } : model,
				{
					...options((_model, request) => {
						calls.push(request);
						return overflow === "provider" && calls.length === 1
							? streamResponse("", "error", "Your input exceeds the context window of this model")
							: streamResponse("Older-only checkpoint");
					}),
					context: async () => source,
					sourceMessageCount: source.messages.length,
					retainedMessageCount: 1,
				},
			);
			expect(calls).toHaveLength(overflow === "preflight" ? 1 : 2);
			if (overflow === "provider") expect(calls[0].messages.slice(0, -1)).toEqual(source.messages);
			expect(JSON.stringify(calls.at(-1))).toContain("Original goal");
			expect(JSON.stringify(calls.at(-1))).not.toContain("RECENT-ONLY");
			expect(result.firstKeptEntryId).toBe("kept");
			expect(result.details.requests?.at(-1)?.strategy).toBe("chunked");
		},
	);

	it("copies provider token counts without retaining mutable response usage", async () => {
		const response = fauxAssistantMessage("checkpoint");
		response.usage = { ...response.usage, input: 100, cacheRead: 900, totalTokens: 1000 };
		const result = await compactContext(
			preparation(),
			model,
			options(() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", seq: 1, reason: "stop", message: response });
				return stream;
			}),
		);
		expect(result.details.requests?.[0].usage).not.toBe(response.usage);
		response.usage.cacheRead = 0;
		expect(result.details.requests?.[0].usage).toEqual({
			input: 100,
			output: 0,
			cacheRead: 900,
			cacheWrite: 0,
			totalTokens: 1000,
		});
	});

	it("owns only redacted Codex request diagnostics without raw errors or undefined properties", async () => {
		const details = { payload: { sha256: "a".repeat(64) }, transport: { sseAttempts: 1 } };
		const expectedDetails = structuredClone(details);
		const response = fauxAssistantMessage("checkpoint");
		response.diagnostics = [
			{ type: "codex_request", timestamp: 1, details, error: { message: "RAW TRANSPORT ERROR" } },
			{ type: "websocket_fallback", timestamp: 2, error: { message: "UNRELATED ERROR" } },
			{ type: "codex_request", timestamp: 3, details: undefined },
		];
		const result = await compactContext(
			preparation(),
			model,
			options(() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", seq: 1, reason: "stop", message: response });
				return stream;
			}),
		);
		const captured = result.details.requests?.[0].diagnostics;
		expect(captured).not.toBe(response.diagnostics);
		expect(captured?.[0]).not.toBe(response.diagnostics[0]);
		expect(captured?.[0].details).not.toBe(details);
		response.diagnostics[0].timestamp = 99;
		details.payload.sha256 = "mutated";
		details.transport.sseAttempts = 99;
		response.diagnostics.length = 0;
		expect(captured).toEqual([
			{ type: "codex_request", timestamp: 1, details: expectedDetails },
			{ type: "codex_request", timestamp: 3 },
		]);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
		expect(result.summary).not.toContain("codex_request");
	});

	it("omits malformed diagnostic records without failing a valid summary or losing valid records", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const invalidDetails: unknown[] = [
			cyclic,
			{ count: NaN },
			{ count: Infinity },
			{ count: -0 },
			{ missing: undefined },
			{ date: new Date() },
			{ callback: () => "invalid" },
			Object.defineProperty({}, "count", {
				enumerable: true,
				get: () => {
					throw new Error("Invalid diagnostic getter");
				},
			}),
			null,
			"not an object",
			42,
			[],
		];
		const valid = { type: "codex_request", timestamp: 1, details: { sha256: "b".repeat(64) } };
		const response = Object.assign(fauxAssistantMessage("valid checkpoint"), {
			diagnostics: [
				valid,
				...invalidDetails.map((details) => ({ type: "codex_request", timestamp: 2, details })),
				...[undefined, null, "3", NaN, Infinity, -0].map((timestamp) => ({ type: "codex_request", timestamp })),
				null,
				undefined,
				{ type: 42, timestamp: 3 },
				{ type: "unrelated", timestamp: 4, details: cyclic },
				{ type: "codex_request", timestamp: 5 },
			],
		});
		const result = await compactContext(
			preparation(),
			model,
			options(() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", seq: 1, reason: "stop", message: response });
				return stream;
			}),
		);
		expect(result.summary).toContain("valid checkpoint");
		expect(result.details.requests?.[0].diagnostics).toEqual([valid, { type: "codex_request", timestamp: 5 }]);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
	});

	it.each([undefined, null, "invalid", {}, [], [{ type: "unrelated", timestamp: 1 }]])(
		"omits unavailable diagnostics (%j) without failing a valid summary",
		async (diagnostics) => {
			const response = Object.assign(fauxAssistantMessage("valid checkpoint"), { diagnostics });
			const result = await compactContext(
				preparation(),
				model,
				options(() => {
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", seq: 1, reason: "stop", message: response });
					return stream;
				}),
			);
			expect(result.summary).toContain("valid checkpoint");
			expect(result.details.requests?.[0]).not.toHaveProperty("diagnostics");
		},
	);

	it.each([NaN, Infinity, -1, -0, 0.5])("omits invalid usage (%s) without failing a valid summary", async (output) => {
		const result = await compactContext(
			preparation(),
			model,
			options(() => streamResponse("valid checkpoint", "stop", undefined, { output })),
		);
		expect(result.summary).toContain("valid checkpoint");
		expect(result.details.requests).toEqual([
			{ strategy: "native", attempt: 1, provider: model.provider, model: model.id, stopReason: "stop" },
		]);
	});

	it("keeps reported errors, missing responses, and successful retries separate", async () => {
		let calls = 0;
		const result = await compactContext(
			preparation(),
			model,
			options(() => {
				calls++;
				if (calls === 1)
					return streamResponse("", "error", "service unavailable", { input: 10, totalTokens: 10 }, [
						{ type: "codex_request", timestamp: 1, details: { sseAttempts: 1 } },
					]);
				if (calls === 2) throw new Error("service unavailable");
				return streamResponse(
					"retry checkpoint",
					"stop",
					undefined,
					{ input: 20, cacheRead: 80, totalTokens: 100 },
					[{ type: "codex_request", timestamp: 3, details: { sseAttempts: 1 } }],
				);
			}),
		);
		expect(calls).toBe(3);
		expect(result.details.requests).toEqual([
			{
				strategy: "native",
				attempt: 1,
				provider: model.provider,
				model: model.id,
				stopReason: "error",
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
				diagnostics: [{ type: "codex_request", timestamp: 1, details: { sseAttempts: 1 } }],
			},
			{ strategy: "native", attempt: 2, provider: model.provider, model: model.id },
			{
				strategy: "native",
				attempt: 3,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: { input: 20, output: 0, cacheRead: 80, cacheWrite: 0, totalTokens: 100 },
				diagnostics: [{ type: "codex_request", timestamp: 3, details: { sseAttempts: 1 } }],
			},
		]);
	});

	it("records each chunk and retry without inventing a native preflight request", async () => {
		const prepared = preparation();
		prepared.messagesToSummarize = Array.from({ length: 3 }, (_, index) => ({
			role: "user",
			content: `${index}: ${"source".repeat(500)}`,
			timestamp: index + 1,
		}));
		let calls = 0;
		const result = await compactContext(
			prepared,
			{ ...model, contextWindow: 16_384 },
			options(() => {
				calls++;
				return streamResponse(
					calls === 1 ? "" : `checkpoint ${calls}`,
					calls === 1 ? "error" : "stop",
					calls === 1 ? "service unavailable" : undefined,
					{ input: calls * 10, cacheRead: calls * 100, totalTokens: calls * 110 },
					[{ type: "codex_request", timestamp: calls, details: { sha256: String(calls).repeat(64) } }],
				);
			}),
		);
		expect(calls).toBe(4);
		expect(result.summary).toContain("checkpoint 4");
		expect(result.details.requests).toEqual(
			Array.from({ length: 4 }, (_, index) => ({
				strategy: "chunked",
				attempt: index + 1,
				provider: model.provider,
				model: model.id,
				stopReason: index === 0 ? "error" : "stop",
				usage: {
					input: (index + 1) * 10,
					output: 0,
					cacheRead: (index + 1) * 100,
					cacheWrite: 0,
					totalTokens: (index + 1) * 110,
				},
				diagnostics: [
					{ type: "codex_request", timestamp: index + 1, details: { sha256: String(index + 1).repeat(64) } },
				],
			})),
		);
	});

	it("keeps parallel split fallback records in dispatch order", async () => {
		const prepared = preparation();
		prepared.isSplitTurn = true;
		prepared.turnPrefixMessages = [{ role: "user", content: "turn prefix", timestamp: 2 }];
		const historyStream = createAssistantMessageEventStream();
		let calls = 0;
		const result = await compactContext(
			prepared,
			{ ...model, contextWindow: 16_384 },
			options(() => {
				calls++;
				if (calls === 1) return historyStream;
				const prefixStream = streamResponse("Prefix checkpoint", "stop", undefined, {
					input: 200,
					totalTokens: 200,
				});
				void prefixStream.result().then(() => {
					const message = fauxAssistantMessage("History checkpoint");
					message.usage = { ...message.usage, input: 100, totalTokens: 100 };
					historyStream.push({ type: "done", seq: 1, reason: "stop", message });
				});
				return prefixStream;
			}),
		);
		expect(calls).toBe(2);
		expect(result.summary).toContain("History checkpoint");
		expect(result.summary).toContain("Prefix checkpoint");
		expect(result.details.requests).toMatchObject([
			{ strategy: "chunked", attempt: 1, usage: { input: 100 } },
			{ strategy: "chunked", attempt: 2, usage: { input: 200 } },
		]);
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
		expect(result.details.requests).toMatchObject(
			overflow === "preflight"
				? [{ strategy: "chunked", attempt: 1, stopReason: "stop" }]
				: [
						{ strategy: "native", attempt: 1, stopReason: "error" },
						{ strategy: "chunked", attempt: 2, stopReason: "stop" },
					],
		);
	});

	it.each([
		{ name: "length-stop overflow", stopReason: "length", usage: { input: model.contextWindow, output: 0 } },
		{
			name: "length-stop overflow at the detection threshold",
			stopReason: "length",
			usage: { input: model.contextWindow * 0.99, output: 0 },
		},
		{
			name: "cached length-stop overflow",
			stopReason: "length",
			usage: { input: model.contextWindow * 0.01, cacheRead: model.contextWindow * 0.98, output: 0 },
		},
		{ name: "silent overflow", stopReason: "stop", usage: { input: model.contextWindow + 1, output: 0 } },
	] as const)("uses chunking for $name before validating an empty response", async ({ stopReason, usage }) => {
		const calls: Context[] = [];
		const result = await compactContext(
			preparation(),
			model,
			options((_model, request) => {
				calls.push(request);
				return calls.length === 1
					? streamResponse("", stopReason, undefined, usage, [
							{ type: "codex_request", timestamp: 1, details: { sseAttempts: 1 } },
						])
					: streamResponse("Recovered checkpoint");
			}),
		);
		expect(calls).toHaveLength(2);
		expect(calls[0].messages.slice(0, -1)).toEqual(context.messages);
		expect(calls[0].systemPrompt).toBe(context.systemPrompt);
		expect(calls[1].systemPrompt).not.toBe(context.systemPrompt);
		expect(calls[1].messages[0].content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Original goal") })]),
		);
		expect(result.summary).toContain("Recovered checkpoint");
		expect(result.firstKeptEntryId).toBe("kept");
		expect(result.details.requests).toMatchObject([
			{
				strategy: "native",
				attempt: 1,
				stopReason,
				usage,
				diagnostics: [{ type: "codex_request", timestamp: 1, details: { sseAttempts: 1 } }],
			},
			{ strategy: "chunked", attempt: 2, stopReason: "stop" },
		]);
	});

	it.each([
		{ input: model.contextWindow * 0.99 - 1, output: 0 },
		{ input: model.contextWindow, output: 1 },
	])("rejects non-overflow length stops with usage %j without changing strategies", async (usage) => {
		const stream = vi.fn(() => streamResponse(usage.output === 0 ? "" : "partial", "length", undefined, usage));
		await expect(compactContext(preparation(), model, options(stream))).rejects.toThrow("truncated");
		expect(stream).toHaveBeenCalledTimes(1);
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

	it.each([
		{ name: "truncated", text: "partial", stopReason: "length", input: 0, error: "truncated" },
		{ name: "length-stop overflow", text: "", stopReason: "length", input: 16_384, error: "truncated" },
		{ name: "empty", text: "", stopReason: "stop", input: 0, error: "empty summary" },
		{ name: "tool-calling", text: "", stopReason: "toolUse", input: 0, error: "tool call" },
		{ name: "overlong", text: "x".repeat(16_385), stopReason: "stop", input: 0, error: "character limit" },
	] as const)(
		"rejects $name summaries in the bounded chunked fallback",
		async ({ text, stopReason, input, error }) => {
			const calls: SimpleStreamOptions[] = [];
			await expect(
				compactContext(
					preparation(),
					{ ...model, contextWindow: 16_384 },
					options((_model, _context, opts) => {
						calls.push(opts!);
						return streamResponse(text, stopReason, undefined, { input, output: 0 });
					}),
				),
			).rejects.toThrow(error);
			expect(calls).toHaveLength(1);
			expect(calls[0].maxTokens).toBeLessThanOrEqual(4096);
		},
	);

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
