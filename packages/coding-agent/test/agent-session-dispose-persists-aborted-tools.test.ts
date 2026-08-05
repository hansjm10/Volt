/**
 * Tests that AgentSession.dispose() persists terminal markers for in-flight
 * tool calls before disconnecting from the agent.
 *
 * Regression for a production incident where a daemon runtime was disposed
 * mid-tool-call by a lease handoff (daemon -> TUI): the agent loop's
 * synthesized "Operation aborted" tool result was emitted after dispose had
 * disconnected the session's listeners, so the transcript kept a dangling
 * toolCall with no result. Resuming the session rendered an empty subagent
 * tree and the model was shown a synthetic "No result provided" stub.
 */

import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type Static, Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";

const hangToolSchema = Type.Object({});

function createHangingTool(onStarted: () => void, name = "hang"): AgentTool<typeof hangToolSchema> {
	return {
		name,
		label: name,
		description: "Hangs until aborted",
		parameters: hangToolSchema,
		execute: (_toolCallId, _params: Static<typeof hangToolSchema>, signal) => {
			onStarted();
			return new Promise((_resolve, reject) => {
				const onAbort = () => reject(new Error("Operation aborted"));
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}

describe("AgentSession dispose with in-flight tool calls", () => {
	it("persists an aborted toolResult for a dangling toolCall on dispose", async () => {
		let toolStarted = false;
		// The trailing "ok" is a terminal response for any post-abort provider
		// call: the faux stream fn ignores abort signals and wraps around its
		// response list, so an all-toolCall list would loop forever.
		const harness = createHarness({
			responses: [{ toolCalls: [{ id: "tc-hang-1", name: "hang", args: {} }] }, "ok"],
			baseToolsOverride: {
				hang: createHangingTool(() => {
					toolStarted = true;
				}),
			},
		});
		try {
			const promptPromise = harness.session.prompt("run the hanging tool").catch(() => {});

			// Wait until the assistant message carrying the toolCall is persisted
			// and the tool is actually executing.
			await vi.waitFor(() => {
				expect(toolStarted).toBe(true);
				const context = harness.sessionManager.buildSessionContext();
				const hasPersistedToolCall = context.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.content.some((block) => block.type === "toolCall" && block.id === "tc-hang-1"),
				);
				expect(hasPersistedToolCall).toBe(true);
			});

			const disposal = harness.session.dispose();
			expect(harness.session.dispose()).toBe(disposal);
			await Promise.all([disposal, promptPromise]);

			const context = harness.sessionManager.buildSessionContext();
			const toolResults = context.messages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]).toMatchObject({
				toolCallId: "tc-hang-1",
				toolName: "hang",
				isError: true,
			});
			expect(toolResults[0]?.content).toEqual([
				{ type: "text", text: "Operation aborted: the session closed before this tool call completed." },
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("attaches child sessions from durable spawn edges to a dangling subagent call", async () => {
		let toolStarted = false;
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{
							id: "tc-subagent-1",
							name: "subagent",
							args: {
								tasks: [
									{ agent: "researcher", task: "audit one" },
									{ agent: "researcher", task: "audit two" },
								],
							},
						},
					],
				},
				"ok",
			],
			baseToolsOverride: {
				subagent: createHangingTool(() => {
					toolStarted = true;
				}, "subagent"),
			},
		});
		try {
			const promptPromise = harness.session.prompt("delegate the audits").catch(() => {});
			await vi.waitFor(() => {
				expect(toolStarted).toBe(true);
				const context = harness.sessionManager.buildSessionContext();
				const hasPersistedToolCall = context.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.content.some((block) => block.type === "toolCall" && block.id === "tc-subagent-1"),
				);
				expect(hasPersistedToolCall).toBe(true);
			});

			// The real subagent tool records these at the publish commit point.
			harness.sessionManager.appendSubagentSpawn({
				toolCallId: "tc-subagent-1",
				subagentId: "sa_one",
				agent: "researcher",
				childSessionId: "child-session-1",
				requestKey: "rk-1",
			});
			harness.sessionManager.appendSubagentSpawn({
				toolCallId: "tc-subagent-1",
				subagentId: "sa_two",
				agent: "researcher",
				childSessionId: "child-session-2",
				requestKey: "rk-1",
			});

			await Promise.all([harness.session.dispose(), promptPromise]);

			const context = harness.sessionManager.buildSessionContext();
			const toolResults = context.messages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]).toMatchObject({
				toolCallId: "tc-subagent-1",
				toolName: "subagent",
				isError: true,
				details: {
					mode: "parallel",
					status: "aborted",
					childSessions: [
						{
							index: 0,
							subagentId: "sa_one",
							sessionId: "child-session-1",
							agent: { name: "researcher" },
							status: "aborted",
						},
						{
							index: 1,
							subagentId: "sa_two",
							sessionId: "child-session-2",
							agent: { name: "researcher" },
							status: "aborted",
						},
					],
				},
			});
		} finally {
			harness.cleanup();
		}
	});

	it("does not append tool results when disposing an idle session", async () => {
		const harness = createHarness({ responses: ["ok"] });
		try {
			await harness.session.prompt("hello");
			const before = harness.sessionManager.buildSessionContext().messages.length;
			await harness.session.dispose();
			const after = harness.sessionManager.buildSessionContext().messages.length;
			expect(after).toBe(before);
		} finally {
			harness.cleanup();
		}
	});

	it("does not duplicate results for completed tool calls on busy dispose", async () => {
		// First tool call completes normally; second hangs. Dispose must only
		// synthesize a result for the hanging call.
		let hangStarted = false;
		const quickTool: AgentTool<typeof hangToolSchema> = {
			name: "quick",
			label: "quick",
			description: "Completes immediately",
			parameters: hangToolSchema,
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
		};
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ id: "tc-quick-1", name: "quick", args: {} }] },
				{ toolCalls: [{ id: "tc-hang-2", name: "hang", args: {} }] },
				"ok",
			],
			baseToolsOverride: {
				quick: quickTool,
				hang: createHangingTool(() => {
					hangStarted = true;
				}),
			},
		});
		try {
			const promptPromise = harness.session.prompt("run tools").catch(() => {});
			await vi.waitFor(() => {
				expect(hangStarted).toBe(true);
			});

			await Promise.all([harness.session.dispose(), promptPromise]);

			const context = harness.sessionManager.buildSessionContext();
			const toolResults = context.messages.filter((message) => message.role === "toolResult");
			const quickResults = toolResults.filter((result) => result.toolCallId === "tc-quick-1");
			const hangResults = toolResults.filter((result) => result.toolCallId === "tc-hang-2");
			expect(quickResults).toHaveLength(1);
			expect(quickResults[0]?.isError).toBe(false);
			expect(hangResults).toHaveLength(1);
			expect(hangResults[0]?.isError).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("fences an in-flight extension handler from appending after disposal drains", async () => {
		let releaseAssistant!: () => void;
		let markAssistantEntered!: () => void;
		const assistantEntered = new Promise<void>((resolve) => {
			markAssistantEntered = resolve;
		});
		const assistantGate = new Promise<void>((resolve) => {
			releaseAssistant = resolve;
		});
		const harness = await createHarnessWithExtensions({
			responses: ["late assistant"],
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "assistant") return;
						markAssistantEntered();
						await assistantGate;
					});
				},
			],
		});
		try {
			const prompt = harness.session.prompt("start").catch(() => {});
			await assistantEntered;
			await harness.session.dispose();
			const disposedMessages = harness.sessionManager.buildSessionContext().messages;
			expect(disposedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(disposedMessages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "aborted",
				diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
			});

			releaseAssistant();
			await prompt;
			expect(harness.sessionManager.buildSessionContext().messages).toEqual(disposedMessages);
		} finally {
			releaseAssistant();
			harness.cleanup();
		}
	});

	it("prevents client-input WAL transitions after the final disposal watermark", async () => {
		const harness = createHarness({ responses: ["ok"] });
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		const flush = vi.spyOn(harness.sessionManager, "flush").mockReturnValue(flushGate);
		try {
			const prompt = harness.session.prompt("admission race", { clientMessageId: "dispose-admission-race" });
			await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());

			const disposal = harness.session.dispose();
			expect(flush).toHaveBeenCalledTimes(2);
			releaseFlush();
			await disposal;
			await expect(prompt).rejects.toThrow("disposed");
			expect(harness.sessionManager.getClientInput("dispose-admission-race")?.state).toBe("accepted");
		} finally {
			releaseFlush();
			harness.cleanup();
		}
	});

	it("does not resolve disposal until the persistence watermark drains", async () => {
		const harness = createHarness({ responses: ["ok"] });
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		vi.spyOn(harness.sessionManager, "flush").mockReturnValue(flushGate);
		try {
			let settled = false;
			const rawDisposal = harness.session.dispose();
			expect(harness.session.dispose()).toBe(rawDisposal);
			const disposal = rawDisposal.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			releaseFlush();
			await disposal;
			expect(settled).toBe(true);
		} finally {
			releaseFlush();
			harness.cleanup();
		}
	});
});
