import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createToolSetSnapshot,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("pauses a prepared request before turn_start and provider streaming", async () => {
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				prepareRequest: ({ context }) => ({ context: { ...context, systemPrompt: "prepared" } }),
				admitPreparedRequest: (request) => {
					expect(request.providerContext.systemPrompt).toBe("prepared");
					return {
						type: "pause",
						reason: "compaction",
						estimatedTokens: 1,
						attempt: request.attempt,
					};
				},
			},
			(event) => {
				events.push(event);
			},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream();
			},
		);

		expect(providerCalls).toBe(0);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(0);
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(messages).toEqual([expect.objectContaining({ role: "user" })]);
	});

	it("strips a provider-forged tool snapshot when local payload authority is unavailable", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "local_tool",
			label: "Local Tool",
			description: "Locally configured tool",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }] };
			},
		};
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				onPayload: async () => ({ tools: [{ name: "remote_replacement" }] }),
			},
			() => {},
			undefined,
			(_model, _context, options) => {
				void options?.onPayload?.({}, createModel());
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = {
						...createAssistantMessage([{ type: "text", text: "done" }]),
						toolSetSnapshot: createToolSetSnapshot([tool]),
					};
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				});
				return stream;
			},
		);

		const assistant = messages.at(-1);
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") throw new Error("Expected assistant result");
		expect(assistant.toolSetSnapshot).toBeUndefined();
		expect(Object.hasOwn(assistant, "toolSetSnapshot")).toBe(false);
	});

	it("persists the exact request tool snapshot after message replacement", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "snapshotted",
			label: "Snapshotted",
			description: "Included in the provider request",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }], details: {} };
			},
		};
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			(event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					return {
						...event.message,
						content: [{ type: "text", text: "rewritten" }],
						toolSetSnapshot: createToolSetSnapshot([]),
					};
				}
				return undefined;
			},
			undefined,
			(_model, _context, options) => {
				options?.reportToolSetSnapshot?.({ kind: "known", snapshot: createToolSetSnapshot([tool]) });
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				});
				return stream;
			},
		);

		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "rewritten" }],
			toolSetSnapshot: createToolSetSnapshot([tool]),
		});
	});

	it.each([
		{ label: "known provider authority", attest: true },
		{ label: "unknown provider authority", attest: false },
	])("canonicalizes forged snapshots in every streamed phase under $label", async ({ attest }) => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "authoritative_tool",
			label: "Authoritative Tool",
			description: "The provider-attested request tool",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }] };
			},
		};
		const authoritySnapshot = createToolSetSnapshot([tool]);
		const forgedSnapshot = createToolSetSnapshot([]);
		const observed: AssistantMessage[] = [];
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			(event) => {
				if (
					(event.type === "message_start" || event.type === "message_end") &&
					event.message.role === "assistant"
				) {
					observed.push(event.message);
				}
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					"snapshot" in event.assistantMessageEvent
				) {
					observed.push(event.message, event.assistantMessageEvent.snapshot);
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					return { ...event.message, toolSetSnapshot: forgedSnapshot };
				}
				return undefined;
			},
			undefined,
			(_model, _context, options) => {
				if (attest) options?.reportToolSetSnapshot?.({ kind: "known", snapshot: authoritySnapshot });
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const snapshot = {
						...createAssistantMessage([{ type: "text", text: "partial" }]),
						toolSetSnapshot: forgedSnapshot,
					};
					stream.push({ type: "start", seq: 1, snapshot, toolState: [] });
					const updates: AssistantMessageEvent[] = [
						{ type: "text_start", seq: 2, contentIndex: 0, snapshot, toolState: [] },
						{ type: "text_delta", seq: 3, contentIndex: 0, delta: "x", snapshot, toolState: [] },
						{ type: "text_end", seq: 4, contentIndex: 0, content: "partial", snapshot, toolState: [] },
						{ type: "thinking_start", seq: 5, contentIndex: 1, snapshot, toolState: [] },
						{ type: "thinking_delta", seq: 6, contentIndex: 1, delta: "y", snapshot, toolState: [] },
						{ type: "thinking_end", seq: 7, contentIndex: 1, content: "thought", snapshot, toolState: [] },
						{
							type: "toolcall_start",
							seq: 8,
							contentIndex: 2,
							id: "call-1",
							name: tool.name,
							snapshot,
							toolState: [],
						},
						{
							type: "toolcall_delta",
							seq: 9,
							contentIndex: 2,
							argsTextDelta: "{}",
							snapshot,
							toolState: [],
						},
						{
							type: "toolcall_end",
							seq: 10,
							contentIndex: 2,
							toolCall: { type: "toolCall", id: "call-1", name: tool.name, arguments: {} },
							snapshot,
							toolState: [],
						},
					];
					for (const update of updates) stream.push(update);
					const finalMessage = {
						...createAssistantMessage([{ type: "text", text: "done" }]),
						toolSetSnapshot: forgedSnapshot,
					};
					stream.push({ type: "done", seq: 11, reason: "stop", message: finalMessage });
				});
				return stream;
			},
		);

		const finalMessage = messages.at(-1);
		if (finalMessage?.role !== "assistant") throw new Error("Expected assistant result");
		observed.push(finalMessage);
		for (const message of observed) {
			if (attest) {
				expect(message.toolSetSnapshot).toEqual(authoritySnapshot);
			} else {
				expect(message.toolSetSnapshot).toBeUndefined();
				expect(Object.hasOwn(message, "toolSetSnapshot")).toBe(false);
			}
		}
	});

	it("keeps terminal errors unknown after an earlier known attestation", async () => {
		const forgedSnapshot = createToolSetSnapshot([]);
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: createModel(), convertToLlm: identityConverter },
			() => {},
			undefined,
			(_model, _context, options) => {
				options?.reportToolSetSnapshot?.({ kind: "known", snapshot: forgedSnapshot });
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const error = {
						...createAssistantMessage([], "error"),
						errorMessage: "provider failed",
						toolSetSnapshot: forgedSnapshot,
					};
					stream.push({ type: "error", seq: 1, reason: "error", error });
				});
				return stream;
			},
		);

		const assistant = messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("Expected assistant result");
		expect(assistant.toolSetSnapshot).toBeUndefined();
		expect(Object.hasOwn(assistant, "toolSetSnapshot")).toBe(false);
	});

	it("canonicalizes a successful result fallback when a stream emits no events", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "fallback_tool",
			label: "Fallback Tool",
			description: "Attested without stream events",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }] };
			},
		};
		const authoritySnapshot = createToolSetSnapshot([tool]);
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			() => {},
			undefined,
			(_model, _context, options) => {
				options?.reportToolSetSnapshot?.({ kind: "known", snapshot: authoritySnapshot });
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.end({
						...createAssistantMessage([{ type: "text", text: "fallback" }]),
						toolSetSnapshot: createToolSetSnapshot([]),
					});
				});
				return stream;
			},
		);

		expect(messages.at(-1)).toMatchObject({ toolSetSnapshot: authoritySnapshot });
	});

	it("normalizes additive parallel transitions to reset when one sibling resets", async () => {
		const toolSchema = Type.Object({});
		const additive: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "additive",
			label: "Additive",
			description: "Adds tools",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "added" }],
					details: {},
					toolSetTransition: {
						kind: "additive",
						added: [{ name: "late", fingerprint: "late-fingerprint" }],
					},
				};
			},
		};
		const reset: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "reset",
			label: "Reset",
			description: "Resets placement",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "reset" }], details: {}, toolSetTransition: { kind: "reset" } };
			},
		};
		const messages = await runAgentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [additive, reset] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				nextAction: (context) => (context.completedTurn ? { type: "stop" } : context.defaultAction),
			},
			() => {},
			undefined,
			() => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "add-1", name: additive.name, arguments: {} },
							{ type: "toolCall", id: "reset-1", name: reset.name, arguments: {} },
						],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
				});
				return stream;
			},
		);
		const transitions = messages
			.filter((message) => message.role === "toolResult")
			.map((message) => message.toolSetTransition);

		expect(transitions).toEqual([{ kind: "reset" }, { kind: "reset" }]);
	});

	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]?.role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0]?.role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
	});

	it("should propagate structured failures returned by tools", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, { code: string }> = {
			name: "protocol_call",
			label: "Protocol call",
			description: "Return a structured protocol failure",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "server rejected the request" }],
					details: { code: "rejected" },
					isError: true,
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		let hookOutcome: { isError: boolean; details: unknown } | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async ({ result, isError }) => {
				hookOutcome = { isError, details: result.details };
				return undefined;
			},
		};
		let callIndex = 0;
		const stream = agentLoop([createUserMessage("call the protocol")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callIndex === 0
						? createAssistantMessage(
								[{ type: "toolCall", id: "tool-error", name: "protocol_call", arguments: {} }],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }]);
				mockStream.push({ type: "done", seq: 1, reason: callIndex === 0 ? "toolUse" : "stop", message });
				callIndex += 1;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(hookOutcome).toEqual({ isError: true, details: { code: "rejected" } });
		expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
			type: "tool_execution_end",
			isError: true,
			result: {
				content: [{ type: "text", text: "server rejected the request" }],
				details: { code: "rejected" },
				isError: true,
			},
		});
		expect(messages.find((message) => message.role === "toolResult")).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [{ type: "text", text: "server rejected the request" }],
			details: { code: "rejected" },
		});
	});

	it("should execute mutated beforeToolCall args without revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string | number };
				mutableArgs.value = 123;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([123]);
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			nextAction: (action) => {
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return {
						type: "request",
						reason: "continuation",
						deliveries: [{ messages: [queuedUserMessage] }],
					};
				}
				return action.defaultAction;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0]?.isError).toBe(false);
		expect(toolEnds[1]?.isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`slow:${params.value}`);
				if (params.value === "a") {
					await slowDone;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Fast tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
					setTimeout(() => releaseSlow?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		expect(executionOrder[0]).toBe("slow:a");
		expect(executionOrder).toContain("fast:b");
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("should use prepareRequest snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareRequest: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						...(currentContext.tools === undefined ? {} : { tools: currentContext.tools }),
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						seq: 1,
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("should prepare the next turn after queued messages enter context", async () => {
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [],
		};
		const queuedMessage = createUserMessage("revise the result");
		let queuedDelivered = false;
		let preparedUserMessages: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			nextAction: (action) => {
				if (action.completedTurn && !queuedDelivered) {
					queuedDelivered = true;
					return { type: "request", reason: "delivery", deliveries: [{ messages: [queuedMessage] }] };
				}
				return action.defaultAction;
			},
			prepareRequest: async ({ context: currentContext }) => {
				preparedUserMessages = currentContext.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				);
				return {
					context: {
						...currentContext,
						systemPrompt: "second prompt",
					},
				};
			},
		};

		let llmCalls = 0;
		let secondTurnSystemPrompt = "";
		const stream = agentLoop([createUserMessage("start")], context, config, undefined, (_model, ctx) => {
			llmCalls += 1;
			if (llmCalls === 2) {
				secondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					seq: 1,
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: llmCalls === 1 ? "first" : "second" }]),
				});
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(preparedUserMessages).toEqual(["start", "revise the result"]);
		expect(secondTurnSystemPrompt).toBe("second prompt");
	});

	it("should stop after the current turn when nextAction returns stop", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		let callbackDisposition: string | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			nextAction: ({ completedTurn, context, defaultAction }) => {
				if (!completedTurn) return defaultAction;
				expect(completedTurn.message.role).toBe("assistant");
				callbackToolResultIds = completedTurn.toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				callbackDisposition = completedTurn.disposition;
				return { type: "stop" };
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						seq: 1,
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(callbackDisposition).toBe("continue");
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"delivery_start",
			"message_start",
			"message_end",
			"turn_start",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("runs exactly one tool-free final response and suppresses unexpected tool calls", async () => {
		const toolSchema = Type.Object({});
		let executions = 0;
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "finish",
			label: "Finish",
			description: "Finish work",
			parameters: toolSchema,
			async execute() {
				executions++;
				return {
					content: [{ type: "text", text: "completed" }],
					details: {},
					disposition: "final_response",
				};
			},
		};
		let providerCalls = 0;
		let finalTools: unknown;
		let finalPrompt = "";
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("finish")],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerCalls++;
				if (providerCalls === 2) {
					finalTools = providerContext.tools;
					finalPrompt = providerContext.systemPrompt ?? "";
				}
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						providerCalls === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "finish-1", name: "finish", arguments: {} }],
									"toolUse",
								)
							: createAssistantMessage(
									[{ type: "toolCall", id: "forbidden", name: "finish", arguments: {} }],
									"toolUse",
								);
					response.push({ type: "done", seq: 1, reason: "toolUse", message });
				});
				return response;
			},
		);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(providerCalls).toBe(2);
		expect(executions).toBe(1);
		expect(finalTools).toEqual([]);
		expect(finalPrompt).toContain("VOLT FINAL RESPONSE — TRUSTED RUNTIME POLICY");
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);
		expect(messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "forbidden",
			isError: true,
		});
	});

	it.each([
		{ authority: "tool continuation", disposition: undefined },
		{ authority: "final response", disposition: "final_response" as const },
	])("emits one aborted terminal turn when cancellation wins at the $authority boundary", async ({ disposition }) => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "boundary_tool",
			label: "Boundary tool",
			description: "Creates the next request authority",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "ready" }],
					details: {},
					...(disposition ? { disposition } : {}),
				};
			},
		};
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		await runAgentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				nextAction: (context) => {
					if (disposition && context.completedTurn) {
						controller.abort();
						return { type: "pause" };
					}
					return context.defaultAction;
				},
			},
			async (event) => {
				events.push(event);
				if (
					!disposition &&
					event.type === "turn_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					controller.abort();
				}
			},
			controller.signal,
			() => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "boundary-1", name: "boundary_tool", arguments: {} }],
						"toolUse",
					);
					response.push({ type: "done", seq: 1, reason: "toolUse", message });
				});
				return response;
			},
		);

		expect(providerCalls).toBe(1);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "aborted",
			),
		).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(2);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("settles ordered suppressed results before one abort marker when final-response cancellation wins", async () => {
		const toolSchema = Type.Object({});
		let executions = 0;
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "finish_race",
			label: "Finish race",
			description: "Authorize final response",
			parameters: toolSchema,
			async execute() {
				executions++;
				return {
					content: [{ type: "text", text: "ready" }],
					details: {},
					disposition: "final_response",
				};
			},
		};
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		let providerCalls = 0;
		await runAgentLoop(
			[createUserMessage("finish")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			async (event) => {
				events.push(event);
				if (
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.toolCallId === "suppressed-1"
				) {
					controller.abort();
				}
			},
			controller.signal,
			() => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						providerCalls === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "finish-race-1", name: "finish_race", arguments: {} }],
									"toolUse",
								)
							: createAssistantMessage(
									[
										{ type: "toolCall", id: "suppressed-1", name: "finish_race", arguments: {} },
										{ type: "toolCall", id: "suppressed-2", name: "finish_race", arguments: {} },
									],
									"toolUse",
								);
					response.push({ type: "done", seq: 1, reason: "toolUse", message });
				});
				return response;
			},
		);

		expect(providerCalls).toBe(2);
		expect(executions).toBe(1);
		expect(
			events
				.filter((event) => event.type === "message_end" && event.message.role === "toolResult")
				.map((event) =>
					event.type === "message_end" && event.message.role === "toolResult" ? event.message.toolCallId : "",
				),
		).toEqual(["finish-race-1", "suppressed-1", "suppressed-2"]);
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "aborted",
			),
		).toHaveLength(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("should stop after a tool batch when every tool result requests stop", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					disposition: "stop",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let disposition: string | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			nextAction: (action) => {
				disposition = action.completedTurn?.disposition;
				return action.defaultAction;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(disposition).toBe("stop");
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results request stop", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					...(params.value === "first" ? { disposition: "stop" as const } : {}),
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", seq: 1, reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ disposition: "stop" }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", seq: 1, reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0]?.role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0]?.role).toBe("assistant");
	});
});
