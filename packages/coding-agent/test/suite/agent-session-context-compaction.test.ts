import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionDetails, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const sessionDirectories: string[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()!.cleanupAsync();
	while (sessionDirectories.length) {
		await rm(sessionDirectories.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("AgentSession cache-preserving compaction", () => {
	it("preserves the provider prefix and policy while persisting compaction request usage and diagnostics", async () => {
		const sessionDirectory = await mkdtemp(join(tmpdir(), "volt-compaction-usage-"));
		sessionDirectories.push(sessionDirectory);
		const harness = await createHarness({
			sessionManager: await SessionManager.create(sessionDirectory, sessionDirectory),
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
		const savedEntries = harness.sessionManager.getEntries();
		const retainedEntry = harness.sessionManager.getLeafEntry()!;
		const latestAssistant = harness.session.messages.at(-1)!;
		expect(retainedEntry).toMatchObject({ type: "message", message: latestAssistant });
		let summaryCalls = 0;
		const diagnostics = [
			{
				type: "codex_request",
				timestamp: 123,
				details: { payload: { sha256: "a".repeat(64) }, transport: { sseAttempts: 1 } },
			},
		];
		harness.setResponses([
			(context, rawOptions) => {
				summaryCalls++;
				const options = rawOptions as SimpleStreamOptions;
				expect(context.systemPrompt).toBe(normal!.systemPrompt);
				expect(context.tools).toEqual(normal!.tools);
				expect(context.messages.slice(0, -1)).toEqual([...normal!.messages, latestAssistant]);
				expect(JSON.stringify(context.messages)).toContain("PRIOR-ONLY-CONSTRAINT");
				expect(JSON.stringify(context.messages)).toContain("OLD-SOURCE-END");
				expect(context.messages.at(-1)?.role).toBe("user");
				const instruction = getMessageText(context.messages.at(-1));
				expect(instruction).toContain("Summary scope:");
				expect(instruction).toContain("last 1 saved conversation messages");
				expect(instruction).toContain("Additional focus: Preserve the deadline");
				expect(instruction).not.toContain("[context hook]");
				expect(options).toMatchObject({
					maxTokens: 4096,
					maxRetries: 0,
					reasoning: normalOptions!.reasoning,
					sessionId: normalOptions!.sessionId,
					transport: "sse",
					inferenceSpeed: "fast",
				});
				for (const message of context.messages) expect(message).not.toHaveProperty("diagnostics");
				const message = fauxAssistantMessage("## Goal\nPRIOR-ONLY-CONSTRAINT\nPreserve the current task");
				message.diagnostics = diagnostics;
				return message;
			},
		]);
		const result = await harness.session.compact("Preserve the deadline");
		expect(summaryCalls).toBe(1);
		expect(result.summary).toContain("PRIOR-ONLY-CONSTRAINT");
		expect(result.firstKeptEntryId).toBe(retainedEntry.id);
		expect(harness.session.messages.slice(1)).toEqual([latestAssistant]);
		expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		const details = result.details as CompactionDetails;
		expect(details.requests).toEqual([
			{
				strategy: "native",
				attempt: 1,
				provider: harness.getModel().provider,
				model: "large",
				stopReason: "stop",
				usage: {
					input: expect.any(Number),
					output: expect.any(Number),
					cacheRead: expect.any(Number),
					cacheWrite: expect.any(Number),
					totalTokens: expect.any(Number),
				},
				diagnostics,
			},
		]);
		expect(details.requests?.[0].usage?.cacheRead).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.details).toEqual(details);
		const savedDetails = structuredClone(details);
		diagnostics[0].details.transport.sseAttempts = 99;
		expect(details).toEqual(savedDetails);
		harness.setResponses([
			(context) => {
				for (const message of context.messages) expect(message).not.toHaveProperty("diagnostics");
				expect(JSON.stringify(context)).not.toContain(diagnostics[0].details.payload.sha256);
				expect(JSON.stringify(context)).not.toContain("codex_request");
				return fauxAssistantMessage("Continued after compaction");
			},
		]);
		await harness.session.prompt("Continue the current task");
		await harness.sessionManager.flush();
		const reopened = await SessionManager.open(harness.sessionManager.getSessionRef()!);
		try {
			expect(
				reopened
					.getBranch()
					.filter((entry) => entry.type === "compaction")
					.at(-1),
			).toMatchObject({
				summary: result.summary,
				firstKeptEntryId: retainedEntry.id,
				details,
			});
			expect(reopened.getEntry(retainedEntry.id)).toEqual(retainedEntry);
			expect(reopened.buildSessionContext().messages[1]).toEqual(latestAssistant);
			// Usage and diagnostics stay host metadata, not part of the synthetic summary or provider context.
			expect(reopened.buildSessionContext().messages[0]).toEqual({
				role: "compactionSummary",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				timestamp: expect.any(Number),
			});
		} finally {
			await reopened.closePersistence();
		}
	});

	it("persists normal request diagnostics for comparison after reopening the session", async () => {
		const sessionDirectory = await mkdtemp(join(tmpdir(), "volt-normal-request-diagnostics-"));
		sessionDirectories.push(sessionDirectory);
		const harness = await createHarness({
			sessionManager: await SessionManager.create(sessionDirectory, sessionDirectory),
		});
		harnesses.push(harness);
		harness.session.setSessionName("normal request diagnostics test");
		const response = fauxAssistantMessage("Normal reply");
		response.diagnostics = [
			{
				type: "codex_request",
				timestamp: 123,
				details: { transport: "websocket", requestMode: "delta", hashes: { inputItems: ["b".repeat(64)] } },
			},
		];
		harness.setResponses([response]);
		await harness.session.prompt("Warm the prefix");
		await harness.sessionManager.flush();
		const reopened = await SessionManager.open(harness.sessionManager.getSessionRef()!);
		try {
			expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				diagnostics: response.diagnostics,
			});
		} finally {
			await reopened.closePersistence();
		}
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
			result: {
				summary: "automatic checkpoint",
				details: {
					requests: [
						{
							strategy: "native",
							attempt: 1,
							stopReason: "stop",
							usage: { input: expect.any(Number), cacheRead: expect.any(Number) },
						},
					],
				},
			},
		});
	});

	it.each(["rewrite", "filter"] as const)(
		"passes full history through the context hook once when it performs a %s",
		async (transformation) => {
			const hookInputs: AgentMessage[][] = [];
			let hookOutput: AgentMessage[] | undefined;
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 12 } },
				extensionFactories: [
					(volt) => {
						volt.on("context", (event) => {
							hookInputs.push(structuredClone(event.messages));
							const messages =
								transformation === "filter"
									? event.messages.filter((message) => message.role !== "assistant")
									: event.messages;
							if (transformation === "rewrite") {
								for (const message of messages) {
									const text = `HOOK-REWRITE: ${getMessageText(message).replaceAll("RAW-RETAINED", "REDACTED")}`;
									if (message.role === "user") message.content = text;
									else if (message.role === "assistant") message.content = [{ type: "text", text }];
								}
							}
							hookOutput = structuredClone(messages);
							return { messages };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.sessionManager.appendMessage({ role: "user", content: "Older goal ".repeat(100), timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("Older answer"));
			const firstKeptEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: "RAW-RETAINED-REQUEST",
				timestamp: 2,
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage("RAW-RETAINED-ANSWER"));
			const savedEntries = harness.sessionManager.getEntries();
			const originalHistory = harness.sessionManager.buildSessionContext().messages;
			let calls = 0;
			harness.setResponses([
				(context) => {
					calls++;
					expect(context.messages.slice(0, -1)).toEqual(convertToLlm(hookOutput!));
					expect(context.messages.slice(0, -1)).toHaveLength(transformation === "filter" ? 2 : 4);
					expect(context.messages.at(-1)?.role).toBe("user");
					const instruction = getMessageText(context.messages.at(-1));
					expect(instruction).toContain("Summary scope:");
					expect(instruction).toContain("last 2 saved conversation messages");
					if (transformation === "rewrite") {
						expect(instruction).toContain("Retained suffix starts with");
						expect(instruction).toContain("HOOK-REWRITE: REDACTED-REQUEST");
						expect(instruction).toContain("HOOK-REWRITE: REDACTED-ANSWER");
						expect(JSON.stringify(context)).not.toContain("RAW-RETAINED");
					} else {
						expect(instruction).toContain("no exact boundary excerpt is available");
						expect(instruction).not.toContain("Retained suffix starts with");
						expect(JSON.stringify(context)).not.toContain("RAW-RETAINED-ANSWER");
					}
					return fauxAssistantMessage("hook checkpoint");
				},
			]);
			const result = await harness.session.compact();
			expect(calls).toBe(1);
			expect(hookInputs).toEqual([originalHistory]);
			expect(result.firstKeptEntryId).toBe(firstKeptEntryId);
			expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-2));
			expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		},
	);

	it("keeps retained-only file operations out of the checkpoint despite including them in the native request", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "Inspect and update files", timestamp: 1 });
		for (const calls of [
			[
				fauxToolCall("read", { path: "older-read.ts" }),
				fauxToolCall("edit", { path: "older-edit.ts", oldText: "before", newText: "after" }),
			],
			[
				fauxToolCall("read", { path: "retained-read.ts" }),
				fauxToolCall("write", { path: "retained-write.ts", content: "new file" }),
			],
		]) {
			harness.sessionManager.appendMessage(fauxAssistantMessage(calls, { stopReason: "toolUse" }));
			for (const call of calls) {
				harness.sessionManager.appendMessage({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: `Saved ${call.name} result` }],
					isError: false,
					timestamp: 2,
				});
			}
		}
		const savedEntries = harness.sessionManager.getEntries();
		const retainedEntry = harness.sessionManager.getBranch().at(-3)!;
		const originalHistory = harness.sessionManager.buildSessionContext().messages;
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.messages.slice(0, -1)).toEqual(convertToLlm(originalHistory));
				expect(getMessageText(context.messages.at(-1))).toContain("last 3 saved conversation messages");
				return fauxAssistantMessage("file checkpoint");
			},
		]);
		const result = await harness.session.compact();
		expect(calls).toBe(1);
		expect(result.firstKeptEntryId).toBe(retainedEntry.id);
		expect(result.details).toMatchObject({ readFiles: ["older-read.ts"], modifiedFiles: ["older-edit.ts"] });
		expect(result.summary).toBe(
			"file checkpoint\n\n<read-files>\nolder-read.ts\n</read-files>\n\n<modified-files>\nolder-edit.ts\n</modified-files>",
		);
		expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-3));
		expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
	});

	it("includes the split-turn suffix while ignoring empty branch summaries when locating the retained tail", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		const user = harness.sessionManager.appendMessage({ role: "user", content: "Original turn", timestamp: 1 });
		harness.sessionManager.branchWithSummary(user, "", { readFiles: [], modifiedFiles: [] });
		harness.sessionManager.appendMessage(fauxAssistantMessage("EARLY-PREFIX-CONTEXT"));
		const retainedEntryId = harness.sessionManager.appendMessage(fauxAssistantMessage("RETAINED-SUFFIX"));
		const originalHistory = harness.sessionManager.buildSessionContext().messages;
		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.settingsManager.getCompactionSettings(),
		);
		expect(preparation?.isSplitTurn).toBe(true);
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.messages.slice(0, -1)).toEqual(convertToLlm(originalHistory));
				expect(JSON.stringify(context.messages.slice(0, -1))).toContain("EARLY-PREFIX-CONTEXT");
				expect(context.messages.at(-2)).toEqual(originalHistory.at(-1));
				const instruction = getMessageText(context.messages.at(-1));
				expect(instruction).toContain("Summary scope:");
				expect(instruction).toContain("last 1 saved conversation messages");
				expect(instruction).toContain("Retained suffix starts with");
				expect(instruction).toContain(JSON.stringify("[Assistant]: RETAINED-SUFFIX"));
				return fauxAssistantMessage("split checkpoint");
			},
		]);
		const result = await harness.session.compact();
		expect(calls).toBe(1);
		expect(result.firstKeptEntryId).toBe(retainedEntryId);
		expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-1));
	});
});
