/**
 * Tests that an aborted run does not silently issue another provider request
 * between turns, while queued steering messages remain available to resume.
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

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = () => {};
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
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

	it("persists sourced abort provenance when a canceled tool batch requests stop", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "noop_tool",
			label: "Noop Tool",
			description: "Stops after cancellation",
			parameters: toolSchema,
			async execute() {
				agent.abort("host_action");
				return {
					content: [{ type: "text", text: "stopped" }],
					details: undefined,
					disposition: "stop",
				};
			},
		};
		let streamCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantToolUseMessage(),
					});
				});
				return stream;
			},
		});

		await agent.prompt("run stopping tool");

		expect(streamCalls).toBe(1);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [
				expect.objectContaining({
					type: "runtime_abort",
					details: { source: "host_action" },
				}),
			],
		});
	});

	it("persists sourced abort provenance when cancellation lands during plain turn settlement", async () => {
		const turnEndStarted = createDeferred();
		const releaseTurnEnd = createDeferred();
		let providerCalls = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "stop",
						message: createAssistantMessage("completed"),
					});
				});
				return stream;
			},
		});
		agent.subscribe(async (event) => {
			if (event.type !== "turn_end") return;
			agent.followUp({
				role: "user",
				content: [{ type: "text", text: "queued after completion" }],
				timestamp: Date.now(),
			});
			turnEndStarted.resolve();
			await releaseTurnEnd.promise;
		});

		const prompting = agent.prompt("complete normally");
		await turnEndStarted.promise;
		expect(agent.abort("remote_request")).toMatchObject({ accepted: true, source: "remote_request" });
		releaseTurnEnd.resolve();
		await prompting;

		const abortSources = agent.state.messages.flatMap((message) =>
			message.role === "assistant"
				? (message.diagnostics ?? []).flatMap((diagnostic) =>
						diagnostic.type === "runtime_abort" &&
						diagnostic.details &&
						typeof diagnostic.details === "object" &&
						"source" in diagnostic.details
							? [diagnostic.details.source]
							: [],
					)
				: [],
		);
		expect(providerCalls).toBe(1);
		expect(abortSources).toEqual(["remote_request"]);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("keeps queued steering messages pending for a resume after abort", async () => {
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

		// Abort is terminal for this run, so it must neither lease the queued
		// steering delivery nor start another provider request.
		expect(streamCalls).toBe(1);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "text" && part.text === "steered input"),
			),
		).toBe(false);

		await agent.continue();

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
