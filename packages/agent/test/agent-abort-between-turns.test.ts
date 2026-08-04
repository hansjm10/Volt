/**
 * Tests that an aborted run does not silently issue another provider request
 * between turns, while queued steering messages still get delivered.
 *
 * Regression: abort() only flips the run's AbortController; the loop had no
 * abort check between turns, so a tool that finished after abort() caused a
 * fresh transformContext + provider request from an aborted (possibly
 * disposed) session.
 */

import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAssistantToolUseMessage(): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "call-1", name: "noop_tool", arguments: {} }],
		stopReason: "toolUse",
	};
}

function createNoopTool(onExecute?: () => void): AgentTool<ReturnType<typeof Type.Object>> {
	return {
		name: "noop_tool",
		label: "Noop Tool",
		description: "Does nothing",
		parameters: Type.Object({}),
		async execute() {
			onExecute?.();
			return {
				content: [{ type: "text", text: "ok" }],
				details: undefined,
			};
		},
	};
}

describe("abort between turns", () => {
	it("does not issue another provider request after abort during tool execution", async () => {
		let streamCalls = 0;
		const events: AgentEvent[] = [];

		const agent = new Agent({
			initialState: { tools: [createNoopTool(() => agent.abort())] },
			streamFn: () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				const message = streamCalls === 1 ? createAssistantToolUseMessage() : createAssistantMessage("extra turn");
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
						message,
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("run tool");

		// The tool aborted the run; the loop must end without a second
		// provider request instead of starting another turn.
		expect(streamCalls).toBe(1);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("still delivers queued steering messages after abort", async () => {
		let streamCalls = 0;
		const tool = createNoopTool(() => {
			agent.steer({ role: "user", content: [{ type: "text", text: "steered input" }], timestamp: Date.now() });
			agent.abort();
		});

		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: (_model, context) => {
				streamCalls++;
				const stream = new MockAssistantStream();
				const message = streamCalls === 1 ? createAssistantToolUseMessage() : createAssistantMessage("steer reply");
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
						message,
					});
				});
				void context;
				return stream;
			},
		});

		await agent.prompt("run tool");

		// Queued user input survives abort by contract: the steering message is
		// injected and streamed even though the signal is aborted.
		expect(streamCalls).toBe(2);
		const userMessages = agent.state.messages.filter((message) => message.role === "user");
		expect(
			userMessages.some((message) =>
				(Array.isArray(message.content) ? message.content : []).some(
					(part) => part.type === "text" && part.text === "steered input",
				),
			),
		).toBe(true);
	});
});
