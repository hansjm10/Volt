import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolUpdateCallback,
} from "../src/index.ts";

// Mock stream that mimics AssistantMessageEventStream
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

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getUserText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.find((part) => part.type === "text")?.text;
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("feeds finalized user-message replacements into the current model context", async () => {
		let providerUserText: string | undefined;
		const agent = new Agent({
			streamFn: (_model, context) => {
				const userMessage = context.messages.find((message) => message.role === "user");
				if (userMessage?.role === "user") {
					providerUserText =
						typeof userMessage.content === "string"
							? userMessage.content
							: userMessage.content.find((part) => part.type === "text")?.text;
				}
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				return {
					...event.message,
					content: [{ type: "text", text: "rewritten user message" }],
				};
			}
			return undefined;
		});

		await agent.prompt("original user message");

		expect(providerUserText).toBe("rewritten user message");
		const firstMessage = agent.state.messages[0];
		expect(firstMessage?.role).toBe("user");
		if (firstMessage?.role !== "user" || typeof firstMessage.content === "string") {
			throw new Error("Expected structured user message");
		}
		expect(firstMessage.content[0]).toEqual({ type: "text", text: "rewritten user message" });
	});

	it("feeds finalized tool-result replacements into the next model context", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "replaceable_tool",
			label: "Replaceable Tool",
			description: "Returns content that a listener replaces",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "original tool result" }], details: {} };
			},
		};
		let providerToolText: string | undefined;
		let callIndex = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						stream.push({
							type: "done",
							seq: 1,
							reason: "toolUse",
							message: createAssistantToolUseMessage([
								{ type: "toolCall", id: "replace-call", name: tool.name, arguments: {} },
							]),
						});
					} else {
						const toolResult = context.messages
							.slice()
							.reverse()
							.find((message) => message.role === "toolResult");
						if (toolResult?.role === "toolResult") {
							providerToolText = toolResult.content.find((part) => part.type === "text")?.text;
						}
						stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
					}
					callIndex++;
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				return {
					...event.message,
					content: [{ type: "text", text: "rewritten tool result" }],
				};
			}
			return undefined;
		});

		await agent.prompt("run the tool");

		expect(providerToolText).toBe("rewritten tool result");
		const storedToolResult = agent.state.messages.find((message) => message.role === "toolResult");
		expect(storedToolResult?.role).toBe("toolResult");
		if (storedToolResult?.role !== "toolResult") throw new Error("Expected tool result");
		expect(storedToolResult.content[0]).toEqual({ type: "text", text: "rewritten tool result" });
	});

	it("uses a finalized replacement throughout thrown-run failure lifecycle events", async () => {
		let turnEndText: string | undefined;
		let agentEndText: string | undefined;
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				return {
					...event.message,
					content: [{ type: "text", text: "rewritten failure" }],
					errorMessage: "rewritten provider error",
				};
			}
			if (event.type === "turn_end" && event.message.role === "assistant") {
				turnEndText = event.message.content.find((part) => part.type === "text")?.text;
			}
			if (event.type === "agent_end") {
				const message = event.messages
					.slice()
					.reverse()
					.find((candidate) => candidate.role === "assistant");
				if (message?.role === "assistant") {
					agentEndText = message.content.find((part) => part.type === "text")?.text;
				}
			}
			return undefined;
		});

		await agent.prompt("hello");

		expect(turnEndText).toBe("rewritten failure");
		expect(agentEndText).toBe("rewritten failure");
		const finalMessage = agent.state.messages
			.slice()
			.reverse()
			.find((message) => message.role === "assistant");
		expect(finalMessage?.role).toBe("assistant");
		if (finalMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.errorMessage).toBe("rewritten provider error");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({
								type: "error",
								seq: 1,
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should ignore tool updates after the tool execution settles", async () => {
		const toolSchema = Type.Object({});
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => {
			unhandledRejections.push(error);
		};
		const tool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "delayed_tool",
			label: "Delayed Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				delayedUpdate = onUpdate;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { status: "running" },
				});
				return {
					content: [{ type: "text", text: "ok" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		process.on("unhandledRejection", onUnhandledRejection);
		try {
			await agent.prompt("run tool");
			const eventCountAfterPrompt = events.length;

			delayedUpdate?.({
				content: [{ type: "text", text: "late" }],
				details: { status: "late" },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
			expect(events).toHaveLength(eventCountAfterPrompt);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("should ignore a settled parallel tool update while another tool is still running", async () => {
		const toolSchema = Type.Object({});
		const slowStarted = createDeferred();
		const settledToolEnded = createDeferred();
		const releaseSlow = createDeferred();
		let settledToolUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const settledTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "settled_tool",
			label: "Settled Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				settledToolUpdate = onUpdate;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const slowTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Keeps the agent run active",
			parameters: toolSchema,
			async execute() {
				slowStarted.resolve();
				await releaseSlow.promise;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [settledTool, slowTool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "settled_tool", arguments: {} },
							{ type: "toolCall", id: "call-2", name: "slow_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				settledToolEnded.resolve();
			}
		});

		const promptPromise = agent.prompt("run tools");
		await Promise.all([slowStarted.promise, settledToolEnded.promise]);
		const eventCountBeforeLateUpdate = events.length;

		settledToolUpdate?.({
			content: [{ type: "text", text: "late" }],
			details: { status: "late" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toHaveLength(eventCountBeforeLateUpdate);

		releaseSlow.resolve();
		await promptPromise;
		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(0);
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.state.messages.push(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({
								type: "error",
								seq: 1,
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({
								type: "error",
								seq: 1,
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("reserves run ownership before preparing messages for concurrent continue calls", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		let shouldBlockPreparation = true;
		const providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			prepareQueuedMessages: async (messages, delivery) => {
				if (delivery === "steer" && shouldBlockPreparation) {
					shouldBlockPreparation = false;
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return messages;
			},
			shouldStopAfterTurn: () => true,
			streamFn: (_model, context) => {
				providerUserTexts.push(
					context.messages
						.map(getUserText)
						.filter((text) => text !== undefined)
						.at(-1),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
			createAssistantMessage("Initial response"),
		];
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "First steering" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Second steering" }],
			timestamp: Date.now() + 1,
		});

		const firstContinuation = agent.continue();
		await preparationStarted.promise;
		expect(agent.state.isStreaming).toBe(true);
		expect(agent.signal).toBeDefined();
		let idleResolved = false;
		const idle = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);
		expect(idleResolved).toBe(false);
		expect(agent.hasQueuedMessages()).toBe(true);

		releasePreparation.resolve();
		await Promise.all([firstContinuation, idle]);

		expect(providerUserTexts).toEqual(["First steering"]);
		expect(agent.hasQueuedMessages()).toBe(true);

		await agent.continue();

		expect(providerUserTexts).toEqual(["First steering", "Second steering"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("rejects prompt admission while continue queue preparation owns the run", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			prepareQueuedMessages: async (messages, delivery) => {
				if (delivery === "steer") {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return messages;
			},
			streamFn: (_model, context) => {
				providerUserTexts.push(
					context.messages
						.map(getUserText)
						.filter((text) => text !== undefined)
						.at(-1),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
			createAssistantMessage("Initial response"),
		];
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Queued steering" }],
			timestamp: Date.now(),
		});

		const continuation = agent.continue();
		await preparationStarted.promise;

		await expect(agent.prompt("Concurrent prompt")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		releasePreparation.resolve();
		await continuation;

		expect(providerUserTexts).toEqual(["Queued steering"]);
		expect(agent.state.messages.map(getUserText).filter((text) => text !== undefined)).toEqual([
			"Initial",
			"Queued steering",
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it.each([
		{
			name: "steering queue clear",
			delivery: "steer" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.steer(message),
			clear: (agent: Agent) => agent.clearSteeringQueue(),
		},
		{
			name: "follow-up queue clear",
			delivery: "followUp" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.followUp(message),
			clear: (agent: Agent) => agent.clearFollowUpQueue(),
		},
		{
			name: "all-queues clear",
			delivery: "steer" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.steer(message),
			clear: (agent: Agent) => agent.clearAllQueues(),
		},
	])("discards successfully prepared messages after $name", async ({ delivery, enqueue, clear }) => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		let shouldBlockPreparation = true;
		const providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			prepareQueuedMessages: async (messages, currentDelivery) => {
				if (currentDelivery === delivery && shouldBlockPreparation) {
					shouldBlockPreparation = false;
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return messages;
			},
			streamFn: (_model, context) => {
				providerUserTexts.push(
					context.messages
						.map(getUserText)
						.filter((text) => text !== undefined)
						.at(-1),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
			createAssistantMessage("Initial response"),
		];
		enqueue(agent, {
			role: "user",
			content: [{ type: "text", text: "Cleared message" }],
			timestamp: Date.now(),
		});

		const continuation = agent.continue();
		const clearedContinuation = expect(continuation).rejects.toThrow("Cannot continue from message role: assistant");
		await preparationStarted.promise;
		clear(agent);
		enqueue(agent, {
			role: "user",
			content: [{ type: "text", text: "Replacement message" }],
			timestamp: Date.now() + 1,
		});
		releasePreparation.resolve();
		await clearedContinuation;

		expect(providerUserTexts).toEqual([]);
		expect(agent.state.messages.map(getUserText).filter((text) => text !== undefined)).toEqual(["Initial"]);
		expect(agent.hasQueuedMessages()).toBe(true);

		await agent.continue();

		expect(providerUserTexts).toEqual(["Replacement message"]);
		expect(agent.state.messages.map(getUserText).filter((text) => text !== undefined)).toEqual([
			"Initial",
			"Replacement message",
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it.each([
		{
			name: "steering queue clear",
			delivery: "steer" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.steer(message),
			clear: (agent: Agent) => agent.clearSteeringQueue(),
		},
		{
			name: "follow-up queue clear",
			delivery: "followUp" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.followUp(message),
			clear: (agent: Agent) => agent.clearFollowUpQueue(),
		},
		{
			name: "all-queues clear",
			delivery: "steer" as const,
			enqueue: (agent: Agent, message: AgentMessage) => agent.steer(message),
			clear: (agent: Agent) => agent.clearAllQueues(),
		},
	])("does not restore prepared messages after $name", async ({ delivery, enqueue, clear }) => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const agent = new Agent({
			prepareQueuedMessages: async (messages, currentDelivery) => {
				if (currentDelivery === delivery) {
					preparationStarted.resolve();
					await releasePreparation.promise;
					throw new Error("queue preparation failed");
				}
				return messages;
			},
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
			createAssistantMessage("Initial response"),
		];
		enqueue(agent, {
			role: "user",
			content: [{ type: "text", text: "Queued message" }],
			timestamp: Date.now(),
		});

		const continuation = agent.continue();
		const preparationFailure = expect(continuation).rejects.toThrow("queue preparation failed");
		await preparationStarted.promise;

		expect(agent.state.isStreaming).toBe(true);
		clear(agent);
		releasePreparation.resolve();
		await preparationFailure;

		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.signal).toBeUndefined();
	});

	it("restores follow-up messages when loop preparation fails and delivers them on retry", async () => {
		let failPreparation = true;
		let providerCalls = 0;
		const agent = new Agent({
			prepareQueuedMessages: (messages, delivery) => {
				if (delivery === "followUp" && failPreparation) {
					throw new Error("queue preparation failed");
				}
				return messages;
			},
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await agent.prompt("Initial");

		expect(providerCalls).toBe(1);
		expect(agent.state.errorMessage).toBe("queue preparation failed");
		expect(agent.hasQueuedMessages()).toBe(true);

		failPreparation = false;
		await agent.continue();

		expect(providerCalls).toBe(2);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages.map(getUserText).filter((text) => text !== undefined)).toEqual([
			"Initial",
			"Queued follow-up",
		]);
	});

	it("restores steering ahead of messages enqueued while continue preparation is pending", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		let failPreparation = true;
		const preparedBatches: Array<Array<string | undefined>> = [];
		const providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			prepareQueuedMessages: async (messages, delivery) => {
				if (delivery !== "steer") return messages;
				preparedBatches.push(messages.map(getUserText));
				if (failPreparation) {
					preparationStarted.resolve();
					await releasePreparation.promise;
					throw new Error("queue preparation failed");
				}
				return messages;
			},
			streamFn: (_model, context) => {
				providerUserTexts.push(
					context.messages
						.map(getUserText)
						.filter((text) => text !== undefined)
						.at(-1),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "Initial" }], timestamp: Date.now() - 10 },
			createAssistantMessage("Initial response"),
		];
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "First steering" }],
			timestamp: Date.now(),
		});

		const continuation = agent.continue();
		const preparationFailure = expect(continuation).rejects.toThrow("queue preparation failed");
		await preparationStarted.promise;
		let idleResolved = false;
		const idle = agent.waitForIdle().then(() => {
			idleResolved = true;
		});
		expect(idleResolved).toBe(false);
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Second steering" }],
			timestamp: Date.now() + 1,
		});
		releasePreparation.resolve();
		await preparationFailure;
		await idle;

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.signal).toBeUndefined();
		expect(agent.hasQueuedMessages()).toBe(true);

		failPreparation = false;
		await agent.continue();

		expect(preparedBatches).toEqual([["First steering"], ["First steering"], ["Second steering"]]);
		expect(providerUserTexts).toEqual(["First steering", "Second steering"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() can drain a queued follow-up after a terminating tool batch", async () => {
		let sawFollowUp = false;
		const agent = new Agent({
			streamFn: (_model, context) => {
				sawFollowUp = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "Queued follow-up"),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "terminate",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await agent.continue({ drainFollowUps: true });

		expect(sawFollowUp).toBe(true);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["toolResult", "user", "assistant"]);
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("stops after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, undefined> = {
			name: "noop_tool",
			label: "Noop Tool",
			description: "Returns ok",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		let llmCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				llmCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: `call-${llmCalls}`, name: "noop_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});

		// Assigned after construction, mirroring how hosts install session hooks.
		const hookCalls: Array<{ toolResultCount: number; hasSignal: boolean }> = [];
		agent.shouldStopAfterTurn = (context, signal) => {
			hookCalls.push({ toolResultCount: context.toolResults.length, hasSignal: signal !== undefined });
			return true;
		};

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			timestamp: Date.now(),
		});

		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("run tool");

		// The loop exits after the first turn: one LLM call, no queue polling.
		expect(llmCalls).toBe(1);
		expect(hookCalls).toEqual([{ toolResultCount: 1, hasSignal: true }]);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(agent.state.messages.at(-1)?.role).toBe("toolResult");
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});

	it("should retain the latest tool update details on the pending execution", async () => {
		const toolSchema = Type.Object({});
		const updated = createDeferred();
		const release = createDeferred();
		const tool: AgentTool<typeof toolSchema, { step: string }> = {
			name: "tracked_tool",
			label: "Tracked Tool",
			description: "Reports structured progress",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				onUpdate?.({
					content: [{ type: "text", text: "first" }],
					details: { step: "first" },
				});
				onUpdate?.({
					content: [{ type: "text", text: "second" }],
					details: { step: "second" },
				});
				updated.resolve();
				await release.promise;
				return {
					content: [{ type: "text", text: "ok" }],
					details: { step: "done" },
				};
			},
		};
		let streamCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				streamCalls += 1;
				const finalTurn = streamCalls > 1;
				queueMicrotask(() => {
					if (finalTurn) {
						stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
						return;
					}
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "tracked_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});

		const prompting = agent.prompt("run tool");
		await updated.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		const pending = agent.state.pendingToolExecutions.get("call-1");
		expect(pending?.toolName).toBe("tracked_tool");
		expect(pending?.latestDetails).toEqual({ step: "second" });

		release.resolve();
		await prompting;
		expect(agent.state.pendingToolExecutions.size).toBe(0);
	});
});
