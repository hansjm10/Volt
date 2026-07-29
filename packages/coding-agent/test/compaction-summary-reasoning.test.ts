import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, Model } from "@hansjm10/volt-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@hansjm10/volt-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@hansjm10/volt-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192, contextWindow = 200000): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("bounds serialized summary input to the selected model context", async () => {
		const contextWindow = 16_000;
		const maxOutputTokens = 2_000;
		await generateSummary(
			[{ role: "user", content: "x".repeat(200_000), timestamp: Date.now() }],
			createModel(false, maxOutputTokens, contextWindow),
			2_500,
			"test-key",
		);

		const requestContext = completeSimpleMock.mock.calls[0][1];
		const userContent = requestContext.messages[0].content[0].text as string;
		expect(userContent).toContain("characters truncated");
		expect(requestContext.systemPrompt.length + userContent.length).toBeLessThanOrEqual(
			contextWindow - maxOutputTokens - 1024,
		);
	});

	it("preserves source conversation and clamps output on 8k models", async () => {
		await generateSummary(
			[{ role: "user", content: "SOURCE ".repeat(10_000), timestamp: Date.now() }],
			createModel(false, 8_192, 8_192),
			16_384,
			"test-key",
		);

		const requestContext = completeSimpleMock.mock.calls[0][1];
		const userContent = requestContext.messages[0].content[0].text as string;
		expect(userContent).toContain("[User]: SOURCE");
		expect(completeSimpleMock.mock.calls[0][2]?.maxTokens).toBeLessThan(8_192);
	});

	it("reduces text output to preserve constrained reasoning", async () => {
		await generateSummary(
			messages,
			createModel(true, 16_384, 16_384),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ reasoning: "medium" });
		expect(completeSimpleMock.mock.calls[0][2]?.maxTokens).toBeLessThan(8_192);
	});

	it("rejects an aborted history summary instead of returning partial text", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: "partial summary" }],
			stopReason: "aborted",
		});

		const summary = generateSummary(messages, createModel(false), 2_000, "test-key");

		await expect(summary).rejects.toMatchObject({ name: "AbortError", message: "Summarization cancelled" });
	});

	it("retries only transient summarization failures", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				stopReason: "error",
				errorMessage: "server is overloaded request-id=req_retry",
			})
			.mockResolvedValueOnce(mockSummaryResponse);

		await expect(
			generateSummary(
				messages,
				createModel(false),
				2_000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
			),
		).resolves.toContain("Test summary");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);

		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage: "insufficient_quota",
		});

		await expect(
			generateSummary(
				messages,
				createModel(false),
				2_000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
			),
		).rejects.toThrow("insufficient_quota");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"server error: Your input exceeds the context window of this model",
		"maximum context is 128000; requested 150000 tokens",
		"request too large for 1050000 context window",
		"invalid value: 5000",
	])("does not retry deterministic summarization failure: %s", async (errorMessage) => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage,
		});

		await expect(
			generateSummary(
				messages,
				createModel(false),
				2_000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
			),
		).rejects.toThrow(errorMessage);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("aborts compaction retry backoff without issuing another request", async () => {
		vi.useFakeTimers();
		const abortController = new AbortController();
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage: "service unavailable",
		});

		const summary = generateSummary(
			messages,
			createModel(false),
			2_000,
			"test-key",
			undefined,
			abortController.signal,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ maxRetries: 2, baseDelayMs: 60_000, maxDelayMs: 60_000 },
		);
		await vi.waitFor(() => expect(completeSimpleMock).toHaveBeenCalledTimes(1));
		abortController.abort();

		await expect(summary).rejects.toMatchObject({ name: "AbortError", message: "Summarization cancelled" });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("rejects an aborted turn-prefix summary instead of compacting with partial text", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: "partial turn prefix" }],
			stopReason: "aborted",
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 60_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 },
		};

		const result = compact(preparation, createModel(false), "test-key");

		await expect(result).rejects.toMatchObject({
			name: "AbortError",
			message: "Turn prefix summarization cancelled",
		});
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("chunks a long turn prefix chronologically", async () => {
		const longPrefix = Array.from({ length: 90 }, (_, index) => ({
			role: "user" as const,
			content: `prefix-${index} ${"x".repeat(2_000)}`,
			timestamp: Date.now() + index,
		}));
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: longPrefix,
			isSplitTurn: true,
			tokensBefore: 250_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		};
		let responseIndex = 0;
		completeSimpleMock.mockImplementation(async () => ({
			...mockSummaryResponse,
			content: [{ type: "text", text: `prefix summary ${responseIndex++}` }],
		}));

		await compact(preparation, createModel(false, 128_000, 272_000), "test-key");

		expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
		const prompts = completeSimpleMock.mock.calls.map((call) => call[1].messages[0].content[0].text as string);
		expect(prompts[0]).toContain("prefix-0");
		expect(prompts.at(-1)).toContain("prefix-89");
		expect(prompts.slice(1).every((prompt) => prompt.includes("<previous-summary>"))).toBe(true);
		expect(prompts.every((prompt) => prompt.length < 80_000)).toBe(true);
	});

	it("retries only the failed split-summary branch", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 60_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 },
		};
		let historyAttempts = 0;
		let prefixAttempts = 0;
		completeSimpleMock.mockImplementation(async (_model, context) => {
			const prompt = context.messages[0].content[0].text as string;
			if (prompt.includes("PREFIX of a turn")) {
				prefixAttempts += 1;
				if (prefixAttempts === 1) {
					return {
						...mockSummaryResponse,
						stopReason: "error",
						errorMessage: "service unavailable",
					};
				}
				return { ...mockSummaryResponse, content: [{ type: "text", text: "prefix recovered" }] };
			}
			historyAttempts += 1;
			return mockSummaryResponse;
		});

		await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
		);

		expect(historyAttempts).toBe(1);
		expect(prefixAttempts).toBe(2);
	});

	it("cancels and settles a split-summary sibling after terminal failure", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 60_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 },
		};
		let historyAborted = false;
		completeSimpleMock.mockImplementation((_model, context, options) => {
			const prompt = context.messages[0].content[0].text as string;
			if (prompt.includes("PREFIX of a turn")) {
				return Promise.resolve({
					...mockSummaryResponse,
					stopReason: "error",
					errorMessage: "insufficient_quota",
				});
			}
			return new Promise<AssistantMessage>((_resolve, reject) => {
				const abort = (): void => {
					historyAborted = true;
					const error = new Error("history cancelled");
					error.name = "AbortError";
					reject(error);
				};
				if (options.signal?.aborted) {
					abort();
				} else {
					options.signal?.addEventListener("abort", abort, { once: true });
				}
			});
		});

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow("insufficient_quota");
		expect(historyAborted).toBe(true);
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});
});
