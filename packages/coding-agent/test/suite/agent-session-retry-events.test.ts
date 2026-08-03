import type { AgentMessage, AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("reports cancellation when aborting an active retry response", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("x".repeat(20_000)),
		]);

		let retryStarted = false;
		const retryUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					retryStarted = true;
				}
				if (retryStarted && event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const prompt = harness.session.prompt("abort retry response");
		await retryUpdate;
		await harness.session.abort();
		await prompt;

		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: "Retry cancelled" }),
		]);
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("clears retry state when abort arrives from a later retry candidate agent_end", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		let endCount = 0;
		let abortPromise: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" && ++endCount === 2) {
				abortPromise = harness.session.abort();
			}
		});

		await harness.session.prompt("abort second retry candidate");
		await abortPromise;

		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: "Retry cancelled" }),
		]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not start a retry when abort arrives from the retry candidate agent_end", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		let abortPromise: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") {
				abortPromise = harness.session.abort();
			}
		});

		await harness.session.prompt("abort before retry setup");
		await abortPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("keeps the session busy during retry backoff and rejects an overlapping prompt", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const checkCompaction = vi.spyOn(
			harness.session as unknown as {
				_checkCompaction: (message: unknown, skipAbortedCheck?: boolean) => Promise<boolean>;
			},
			"_checkCompaction",
		);
		const promptPromise = harness.session.prompt("first prompt");
		await sawRetryStart;

		expect(harness.session.isStreaming).toBe(true);
		await expect(harness.session.prompt("overlapping prompt")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		const abortPromise = harness.session.abort();
		await expect(
			harness.session.prompt("do not strand this prompt", { streamingBehavior: "followUp" }),
		).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
		expect(harness.session.pendingMessageCount).toBe(0);
		await abortPromise;
		await promptPromise;

		expect(checkCompaction).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits extension events before public event subscribers", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_start", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
					volt.on("message_end", async (event) => {
						order.push(`extension:${event.type}:${event.message.role}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_end") {
				order.push(`public:${event.type}:${event.message.role}`);
			}
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(order).toEqual([
			"extension:message_start:user",
			"public:message_start:user",
			"extension:message_end:user",
			"public:message_end:user",
			"extension:message_start:assistant",
			"public:message_start:assistant",
			"extension:message_end:assistant",
			"public:message_end:assistant",
		]);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end then agent_settled for error responses", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.prompt("hi");

		expect(harness.events[harness.events.length - 2]?.type).toBe("agent_end");
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
	});

	it("settles after resumed overflow recovery when new prompt construction fails", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.session.setSessionName("resumed recovery test");

		const previousUser = {
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: Date.now() - 1,
		} satisfies AgentMessage;
		const overflow = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		harness.sessionManager.appendMessage(previousUser);
		harness.sessionManager.appendMessage(overflow);
		harness.session.agent.state.messages = [previousUser, overflow];
		harness.faux.setSimpleResponses([fauxAssistantMessage("compacted context")]);
		harness.setResponses([fauxAssistantMessage("recovered previous turn")]);

		const beforeAgentStart = vi
			.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart")
			.mockRejectedValue(new Error("message construction failed"));
		const lifecycle: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_end" || event.type === "agent_settled") {
				lifecycle.push(event.type);
			}
		});

		try {
			const promptPromise = harness.session.prompt("new prompt");
			const idlePromise = harness.session.waitForIdle();

			expect(harness.session.isBusy).toBe(true);
			await expect(promptPromise).rejects.toThrow("message construction failed");
			await expect(idlePromise).resolves.toBeUndefined();
			expect(lifecycle).toEqual(["agent_end", "agent_settled"]);
		} finally {
			beforeAgentStart.mockRestore();
		}
	});

	it("emits agent_end then agent_settled for aborted runs and persists the aborted assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		expect(harness.events[harness.events.length - 2]?.type).toBe("agent_end");
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
