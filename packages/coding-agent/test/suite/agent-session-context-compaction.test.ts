import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()!.cleanupAsync();
});

describe("AgentSession cache-preserving compaction", () => {
	it("preserves the preceding provider prefix, tool definitions, reasoning, routing and Fast mode", async () => {
		const harness = await createHarness({
			models: [{ id: "large", reasoning: true, contextWindow: 1_000_000, maxTokens: 32_768 }],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { provider: { maxRetries: 9 } } },
			extensionFactories: [
				(volt) => {
					volt.on("before_agent_start", () => ({ systemPrompt: "EXTENSION SYSTEM" }));
					volt.on("context", (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? {
										...message,
										content:
											typeof message.content === "string"
												? `${message.content} [context hook]`
												: message.content,
									}
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.setSessionName("compaction test");
		await harness.session.setThinkingLevel("high");
		harness.session.setTransport("sse");
		harness.session.setFastModeEnabled(true);
		const old = harness.sessionManager.appendMessage({ role: "user", content: "Early goal", timestamp: 1 });
		harness.sessionManager.appendCompaction("PRIOR-ONLY-CONSTRAINT", old, 580_000);
		harness.sessionManager.appendMessage({
			role: "user",
			content: `OLD-SOURCE-START\n${"native source content\n".repeat(28_000)}\nOLD-SOURCE-END`,
			timestamp: 2,
		});
		let normal: Context | undefined;
		let normalOptions: SimpleStreamOptions | undefined;
		harness.setResponses([
			(context, options) => {
				normal = context;
				normalOptions = options as SimpleStreamOptions;
				return fauxAssistantMessage("Recent answer retained verbatim");
			},
		]);
		await harness.session.prompt("Latest request");
		let summaryCalls = 0;
		harness.setResponses([
			(context, rawOptions) => {
				summaryCalls++;
				const options = rawOptions as SimpleStreamOptions;
				expect(context.systemPrompt).toBe(normal!.systemPrompt);
				expect(context.tools).toEqual(normal!.tools);
				expect(context.messages.slice(0, -1)).toEqual(normal!.messages);
				expect(JSON.stringify(context.messages)).toContain("PRIOR-ONLY-CONSTRAINT");
				expect(JSON.stringify(context.messages)).toContain("OLD-SOURCE-END");
				expect(options).toMatchObject({
					maxTokens: 4096,
					maxRetries: 0,
					reasoning: normalOptions!.reasoning,
					sessionId: normalOptions!.sessionId,
					transport: "sse",
					inferenceSpeed: "fast",
				});
				return fauxAssistantMessage("## Goal\nPRIOR-ONLY-CONSTRAINT\nPreserve the current task");
			},
		]);
		const result = await harness.session.compact("Preserve the deadline");
		expect(summaryCalls).toBe(1);
		expect(result.summary).toContain("PRIOR-ONLY-CONSTRAINT");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Recent answer retained verbatim" }],
		});
	});

	it.each(["length", "toolUse", "empty"] as const)(
		"keeps the original branch intact after a %s summary",
		async (failure) => {
			const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
			harnesses.push(harness);
			harness.session.setSessionName("compaction test");
			harness.sessionManager.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("Recent answer"));
			const entries = harness.sessionManager.getEntries();
			const leaf = harness.sessionManager.getLeafId();
			harness.setResponses([
				failure === "toolUse"
					? fauxAssistantMessage([fauxToolCall("bash", { command: "must never execute" })], {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage(failure === "empty" ? "" : "partial summary", {
							stopReason: failure === "length" ? "length" : "stop",
						}),
			]);
			await expect(harness.session.compact()).rejects.toThrow();
			expect(harness.sessionManager.getLeafId()).toBe(leaf);
			expect(harness.sessionManager.getEntries()).toEqual(entries);
			expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect(harness.session.isCompacting).toBe(false);
		},
	);

	it("uses the same one-pass path for automatic compaction", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "Original", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("recent"));
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.tools).toBeDefined();
				return fauxAssistantMessage("automatic checkpoint");
			},
		]);
		const internal = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
		};
		await internal._runAutoCompaction("threshold", false);
		expect(calls).toBe(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			result: { summary: "automatic checkpoint" },
		});
	});

	it("summarizes split prefixes and ignores empty branch summaries when locating the retained tail", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		const user = harness.sessionManager.appendMessage({ role: "user", content: "Original turn", timestamp: 1 });
		harness.sessionManager.branchWithSummary(user, "", { readFiles: [], modifiedFiles: [] });
		harness.sessionManager.appendMessage(fauxAssistantMessage("EARLY-PREFIX-CONTEXT"));
		harness.sessionManager.appendMessage(fauxAssistantMessage("RETAINED-SUFFIX"));
		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.settingsManager.getCompactionSettings(),
		);
		expect(preparation?.isSplitTurn).toBe(true);
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(JSON.stringify(context.messages)).toContain("EARLY-PREFIX-CONTEXT");
				expect(JSON.stringify(context.messages)).not.toContain("RETAINED-SUFFIX");
				return fauxAssistantMessage("split checkpoint");
			},
		]);
		await harness.session.compact();
		expect(calls).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "RETAINED-SUFFIX" }],
		});
	});
});
