import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createToolSetSnapshot,
	EventStream,
	getModel,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolUpdateCallback,
	type PreparedProviderRequest,
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
		const forgedSnapshot = createToolSetSnapshot([]);
		let laterListenerSnapshot: AssistantMessage["toolSetSnapshot"];
		agent.subscribe((event) => {
			events.push(event.type);
			if (event.type === "message_end" && event.message.role === "assistant") {
				return { ...event.message, toolSetSnapshot: forgedSnapshot };
			}
			return undefined;
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				laterListenerSnapshot = event.message.toolSetSnapshot;
			}
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"delivery_start",
			"message_start",
			"message_end",
			"turn_start",
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
		expect(lastMessage.toolSetSnapshot).toBeUndefined();
		expect(laterListenerSnapshot).toBeUndefined();
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("feeds prepared user-message replacements into the current model context", async () => {
		let providerUserText: string | undefined;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: delivery.messages.map((message) =>
					message.role === "user"
						? { ...message, content: [{ type: "text", text: "rewritten user message" }] }
						: message,
				),
			}),
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
		const protectedTransition = {
			kind: "additive" as const,
			added: [{ name: "late_tool", fingerprint: "late-fingerprint" }],
		};
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "replaceable_tool",
			label: "Replaceable Tool",
			description: "Returns content that a listener replaces",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "original tool result" }],
					details: {},
					toolSetTransition: protectedTransition,
				};
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
				const replacement = {
					...event.message,
					content: [{ type: "text", text: "rewritten tool result" }],
				};
				delete replacement.toolSetTransition;
				return replacement;
			}
			return undefined;
		});

		await agent.prompt("run the tool");

		expect(providerToolText).toBe("rewritten tool result");
		const storedToolResult = agent.state.messages.find((message) => message.role === "toolResult");
		expect(storedToolResult?.role).toBe("toolResult");
		if (storedToolResult?.role !== "toolResult") throw new Error("Expected tool result");
		expect(storedToolResult.content[0]).toEqual({ type: "text", text: "rewritten tool result" });
		expect(storedToolResult.toolSetTransition).toEqual(protectedTransition);
	});

	it.each([
		{ label: "an unchanged payload hook", replacePayload: false },
		{ label: "a provider tool replacement", replacePayload: true },
	])("records request tool state after $label", async ({ replacePayload }) => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "request_tool",
			label: "Request Tool",
			description: "Tool represented by the Agent request",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }] };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			onPayload: async () => (replacePayload ? { tools: [{ name: "replacement_tool" }] } : undefined),
			streamFn: async (model, _context, options) => {
				const replacement = await options?.onPayload?.({ tools: [{ name: tool.name }] }, model);
				options?.reportToolSetSnapshot?.(
					replacement === undefined
						? { kind: "known", snapshot: createToolSetSnapshot([tool]) }
						: { kind: "unknown" },
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		let laterListenerSnapshot: AssistantMessage["toolSetSnapshot"];
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
			return {
				...event.message,
				content: [{ type: "text", text: "first replacement" }],
				toolSetSnapshot: createToolSetSnapshot(replacePayload ? [tool] : []),
			};
		});
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
			laterListenerSnapshot = event.message.toolSetSnapshot;
			return { ...event.message, content: [{ type: "text", text: "second replacement" }] };
		});

		await agent.prompt("hello");

		const assistant = agent.state.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("Expected assistant message");
		expect(assistant.content).toEqual([{ type: "text", text: "second replacement" }]);
		if (replacePayload) {
			expect(laterListenerSnapshot).toBeUndefined();
			expect(assistant.toolSetSnapshot).toBeUndefined();
			expect(Object.hasOwn(assistant, "toolSetSnapshot")).toBe(false);
		} else {
			expect(laterListenerSnapshot).toEqual(createToolSetSnapshot([tool]));
			expect(assistant.toolSetSnapshot).toEqual(createToolSetSnapshot([tool]));
		}
	});

	it("strips caller-authored assistant snapshots before delivery observation and persistence", async () => {
		const forgedSnapshot = createToolSetSnapshot([]);
		const forgedAssistant = { ...createAssistantMessage("historical"), toolSetSnapshot: forgedSnapshot };
		const observedSnapshots: Array<AssistantMessage["toolSetSnapshot"]> = [];
		let providerSnapshot: AssistantMessage["toolSetSnapshot"];
		const agent = new Agent({
			streamFn: (_model, context) => {
				const historical = context.messages.find((message) => message.role === "assistant");
				providerSnapshot = historical?.role === "assistant" ? historical.toolSetSnapshot : undefined;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "delivery_start") {
				for (const message of event.messages) {
					if (message.role === "assistant") observedSnapshots.push(message.toolSetSnapshot);
				}
			}
			if (
				(event.type === "message_start" || event.type === "message_end") &&
				event.deliveryId !== undefined &&
				event.message.role === "assistant"
			) {
				observedSnapshots.push(event.message.toolSetSnapshot);
			}
		});

		await agent.prompt([
			forgedAssistant,
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() },
		]);

		expect(observedSnapshots).toEqual([undefined, undefined, undefined]);
		expect(providerSnapshot).toBeUndefined();
		const storedHistorical = agent.state.messages.find(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "text" && part.text === "historical"),
		);
		if (storedHistorical?.role !== "assistant") throw new Error("Expected stored historical assistant");
		expect(storedHistorical.toolSetSnapshot).toBeUndefined();
		expect(Object.hasOwn(storedHistorical, "toolSetSnapshot")).toBe(false);
	});

	it("resumes a paused prepared request before draining another one-at-a-time delivery", async () => {
		const requests: string[][] = [];
		let pauseOnce = true;
		const agent = new Agent({
			nextAction: (context) => (context.completedTurn ? { type: "stop" } : context.defaultAction),
			admitPreparedRequest: (request) => {
				if (pauseOnce && request.deliveries.length > 0) {
					pauseOnce = false;
					return {
						type: "pause",
						reason: "compaction",
						estimatedTokens: 1,
						attempt: request.attempt,
					};
				}
				return { type: "admit" };
			},
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		agent.followUp({ role: "user", content: "first", timestamp: 1 });
		agent.followUp({ role: "user", content: "second", timestamp: 2 });

		const paused = await agent.continue();
		expect(requests).toEqual([]);
		if (paused.status !== "paused") throw new Error("Expected a paused provider request");
		await agent.replacePreparedRequestMessages(paused.pause.checkpointId, agent.state.messages);
		await agent.continue();
		expect(requests).toEqual([["first"]]);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("clears a paused prepared request when replacement conversion fails", async () => {
		let conversionCount = 0;
		const requests: string[][] = [];
		const agent = new Agent({
			convertToLlm: (messages) => {
				conversionCount++;
				if (conversionCount === 2) throw new Error("replacement conversion failed");
				return messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				);
			},
			admitPreparedRequest: (request) => ({
				type: "pause",
				reason: "compaction",
				estimatedTokens: 1,
				attempt: request.attempt,
			}),
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		const paused = await agent.prompt("first");
		if (paused.status !== "paused") throw new Error("Expected a paused provider request");
		await expect(
			agent.replacePreparedRequestMessages(paused.pause.checkpointId, agent.state.messages),
		).rejects.toThrow("replacement conversion failed");
		agent.convertToLlm = (messages) =>
			messages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			);
		agent.admitPreparedRequest = () => ({ type: "admit" });
		await agent.prompt("second");

		expect(requests).toHaveLength(1);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "text" && part.text === "second"),
			),
		).toBe(true);
	});

	it("owns one immutable prepared request and derives one exact compaction successor", async () => {
		let deliveryPreparations = 0;
		let requestPreparations = 0;
		let transformations = 0;
		let conversions = 0;
		let apiKeyResolutions = 0;
		let providerCalls = 0;
		const admissions: PreparedProviderRequest[] = [];
		const authority = {};
		const agent = new Agent({
			getRequestAuthority: () => authority,
			getApiKey: () => {
				apiKeyResolutions++;
				return "prepared-key";
			},
			prepareDelivery: (delivery) => {
				deliveryPreparations++;
				return { messages: [...delivery.messages] };
			},
			prepareRequest: ({ context }) => {
				requestPreparations++;
				return { context: { ...context, systemPrompt: "prepared system" } };
			},
			transformContext: async (messages) => {
				transformations++;
				return messages.map((message) =>
					message.role === "user" ? { ...message, content: `transformed-${transformations}` } : message,
				);
			},
			convertToLlm: (messages) => {
				conversions++;
				return messages
					.filter(
						(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					)
					.map((message) =>
						message.role === "user" ? { ...message, content: `converted-${conversions}` } : message,
					);
			},
			admitPreparedRequest: (request) => {
				admissions.push(request);
				return request.attempt === 0
					? {
							type: "pause",
							reason: "compaction",
							estimatedTokens: 10,
							attempt: request.attempt,
						}
					: { type: "admit" };
			},
			nextAction: (context) => (context.completedTurn ? { type: "stop" } : context.defaultAction),
			streamFn: (_model, context, options) => {
				providerCalls++;
				expect(context).toEqual(admissions[1]?.providerContext);
				expect(options?.apiKey).toBe("prepared-key");
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		const paused = await agent.prompt("original");
		if (paused.status !== "paused") throw new Error("Expected a paused provider request");
		agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });
		await expect(agent.continue()).resolves.toEqual({ status: "paused", deliveries: [], pause: paused.pause });
		expect({ deliveryPreparations, requestPreparations, transformations, conversions, apiKeyResolutions }).toEqual({
			deliveryPreparations: 1,
			requestPreparations: 1,
			transformations: 1,
			conversions: 1,
			apiKeyResolutions: 1,
		});
		expect(providerCalls).toBe(0);
		const original = agent.getPreparedRequest(paused.pause.checkpointId);
		expect(original).toBe(admissions[0]);
		expect(Object.isFrozen(original)).toBe(true);
		expect(Object.isFrozen(original?.providerContext)).toBe(true);
		expect(original?.providerContext).toMatchObject({
			systemPrompt: "prepared system",
			messages: [expect.objectContaining({ role: "user", content: "converted-1" })],
		});

		const compactedMessages: AgentMessage[] = [
			{ role: "user", content: "compacted transcript", timestamp: Date.now() },
		];
		const replacement = await agent.replacePreparedRequestMessages(paused.pause.checkpointId, compactedMessages);
		expect(replacement.type).toBe("admit");
		const successor = replacement.checkpoint;
		expect(successor.requestId).toBe(original?.requestId);
		expect(successor.checkpointId).not.toBe(original?.checkpointId);
		expect(successor.runId).toBe(original?.runId);
		expect(successor.attempt).toBe(1);
		expect(successor.deliveries).toEqual(original?.deliveries);
		expect(successor.streamOptions).toEqual(original?.streamOptions);
		expect(successor.providerContext.messages).toEqual([
			expect.objectContaining({ role: "user", content: "converted-2" }),
		]);
		expect({ deliveryPreparations, requestPreparations, transformations, conversions, apiKeyResolutions }).toEqual({
			deliveryPreparations: 1,
			requestPreparations: 1,
			transformations: 2,
			conversions: 2,
			apiKeyResolutions: 1,
		});
		await expect(agent.replacePreparedRequestMessages(paused.pause.checkpointId, compactedMessages)).rejects.toThrow(
			"unavailable or no longer paused",
		);
		expect(agent.hasQueuedMessages()).toBe(true);

		await expect(agent.continue()).resolves.toMatchObject({ status: "completed" });
		expect(providerCalls).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.getPreparedRequest()).toBeUndefined();
	});

	it.each(["abort", "reset", "new prompt", "discard"] as const)(
		"invalidates a paused checkpoint on %s",
		async (action) => {
			let pause = true;
			const agent = new Agent({
				admitPreparedRequest: (request) =>
					pause
						? {
								type: "pause",
								reason: "compaction",
								estimatedTokens: 1,
								attempt: request.attempt,
							}
						: { type: "admit" },
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
					});
					return stream;
				},
			});
			const result = await agent.prompt("first");
			if (result.status !== "paused") throw new Error("Expected a paused provider request");
			if (action === "abort") agent.abort();
			if (action === "reset") agent.reset();
			if (action === "discard") agent.discardPendingPrompt();
			if (action === "new prompt") {
				pause = false;
				await agent.prompt("second");
			}
			expect(agent.getPreparedRequest(result.pause.checkpointId)).toBeUndefined();
			await expect(
				agent.replacePreparedRequestMessages(result.pause.checkpointId, agent.state.messages),
			).rejects.toThrow("unavailable or no longer paused");
		},
	);

	it("rejects fresh preparation when host authority changes before materialization", async () => {
		let authority: object = {};
		let providerCalls = 0;
		const agent = new Agent({
			getRequestAuthority: () => authority,
			prepareRequest: async () => {
				authority = {};
				return undefined;
			},
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		await agent.prompt("first");

		expect(providerCalls).toBe(0);
		expect(agent.state.errorMessage).toBe("Prepared provider request host authority is stale");
		expect(agent.getPreparedRequest()).toBeUndefined();
	});

	it("rejects a paused checkpoint after host authority changes", async () => {
		let authority: object = {};
		const agent = new Agent({
			getRequestAuthority: () => authority,
			admitPreparedRequest: (request) => ({
				type: "pause",
				reason: "compaction",
				estimatedTokens: 1,
				attempt: request.attempt,
			}),
		});
		const result = await agent.prompt("first");
		if (result.status !== "paused") throw new Error("Expected a paused provider request");
		authority = {};

		await expect(
			agent.replacePreparedRequestMessages(result.pause.checkpointId, agent.state.messages),
		).rejects.toThrow("host authority is stale");
		expect(agent.getPreparedRequest()).toBeUndefined();
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

	it("rejects abort requests once agent_end settlement begins", async () => {
		const agentEndStarted = createDeferred();
		const releaseAgentEnd = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("completed") });
				});
				return stream;
			},
		});
		agent.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			agentEndStarted.resolve();
			await releaseAgentEnd.promise;
		});

		const prompting = agent.prompt("complete normally");
		await agentEndStarted.promise;
		expect(agent.abort("remote_request")).toMatchObject({ accepted: false, source: undefined });
		releaseAgentEnd.resolve();
		await prompting;

		const assistants = agent.state.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).toMatchObject({ stopReason: "stop" });
		expect(assistants[0]?.diagnostics?.filter((diagnostic) => diagnostic.type === "runtime_abort") ?? []).toEqual([]);
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
					disposition: "stop",
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
					disposition: "stop",
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
					disposition: "stop",
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

	it("resumes an initial prompt that was aborted during agent_start", async () => {
		let abortFirstStart = true;
		let providerCalls = 0;
		let providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			streamFn: (_model, context) => {
				providerCalls++;
				providerUserTexts = context.messages.map(getUserText).filter((text) => text !== undefined);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "agent_start" && abortFirstStart) {
				abortFirstStart = false;
				agent.abort();
			}
		});

		await agent.prompt("Initial prompt");

		expect(providerCalls).toBe(0);
		expect(agent.state.messages).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(true);
		await expect(agent.prompt("Replacement prompt")).rejects.toThrow("Agent has a retained prompt");

		await agent.continue();

		expect(providerCalls).toBe(1);
		expect(providerUserTexts).toEqual(["Initial prompt"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("can discard an initial prompt retained after abort", async () => {
		let abortFirstStart = true;
		const providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
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
		agent.subscribe((event) => {
			if (event.type === "agent_start" && abortFirstStart) {
				abortFirstStart = false;
				agent.abort();
			}
		});

		await agent.prompt("Canceled prompt");
		expect(agent.discardPendingPrompt()).toHaveLength(1);
		await agent.prompt("Replacement prompt");

		expect(providerUserTexts).toEqual(["Replacement prompt"]);
	});

	it("claims the dispatcher before asynchronous direct delivery preparation", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const agent = new Agent({
			prepareDelivery: async (delivery) => {
				if (delivery.kind === "prompt") {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { messages: [...delivery.messages] };
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		const firstPrompt = agent.prompt("first");
		await preparationStarted.promise;
		await expect(agent.prompt("second")).rejects.toThrow("Agent is already processing a prompt");
		releasePreparation.resolve();
		await firstPrompt;
	});

	it("keeps a fresh prompt delivery-dependent through asynchronous preparation", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const requestReasons: string[] = [];
		const providerUserTexts: Array<string | undefined> = [];
		const revokedDeliveryIds: string[] = [];
		let preparingDeliveryId: string | undefined;
		let blockFirstPrompt = true;
		const agent = new Agent({
			deliveryRevoked: (delivery) => revokedDeliveryIds.push(delivery.deliveryId),
			prepareDelivery: async (delivery) => {
				if (delivery.kind === "prompt" && blockFirstPrompt) {
					blockFirstPrompt = false;
					preparingDeliveryId = delivery.deliveryId;
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { messages: [...delivery.messages] };
			},
			prepareRequest: (context) => {
				requestReasons.push(context.reason);
				return undefined;
			},
			streamFn: (_model, context) => {
				providerUserTexts.push(
					context.messages
						.map((message) => getUserText(message as AgentMessage))
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

		const revokedPrompt = agent.prompt("revoked");
		await preparationStarted.promise;
		expect(agent.canPrepareDelivery(preparingDeliveryId!)).toBe(true);
		expect(agent.discardPendingPrompt()).toHaveLength(1);
		expect(revokedDeliveryIds).toEqual([preparingDeliveryId]);
		expect(agent.canPrepareDelivery(preparingDeliveryId!)).toBe(false);
		releasePreparation.resolve();
		await revokedPrompt;

		expect(requestReasons).toEqual([]);
		expect(providerUserTexts).toEqual([]);
		expect(agent.state.messages).toEqual([]);

		await agent.prompt("replacement");
		expect(requestReasons).toEqual(["delivery"]);
		expect(providerUserTexts).toEqual(["replacement"]);
	});

	it("preserves a provider-ready continuation when a fresh prompt is revoked", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const requestReasons: string[] = [];
		const providerUserTexts: Array<Array<string | undefined>> = [];
		const existing = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "existing" }],
			timestamp: Date.now(),
		};
		const agent = new Agent({
			initialState: { messages: [existing] },
			prepareDelivery: async (delivery) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return { messages: [...delivery.messages] };
			},
			prepareRequest: (context) => {
				requestReasons.push(context.reason);
				return undefined;
			},
			streamFn: (_model, context) => {
				providerUserTexts.push(context.messages.map((message) => getUserText(message as AgentMessage)));
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		const prompting = agent.prompt("revoked");
		await preparationStarted.promise;
		expect(agent.discardPendingPrompt()).toHaveLength(1);
		releasePreparation.resolve();
		await prompting;

		expect(requestReasons).toEqual(["continuation"]);
		expect(providerUserTexts).toEqual([["existing"]]);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("restores follow-up messages when loop preparation fails and delivers them on retry", async () => {
		let failPreparation = true;
		let providerCalls = 0;
		const lifecycleEvents: string[] = [];
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				if (delivery.kind === "followUp" && failPreparation) {
					throw new Error("queue preparation failed");
				}
				return { messages: [...delivery.messages] };
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
		agent.subscribe((event) => {
			if (event.type === "turn_start" || event.type === "turn_end") lifecycleEvents.push(event.type);
		});

		await agent.prompt("Initial");

		expect(lifecycleEvents).toEqual(["turn_start", "turn_end", "turn_start", "turn_end"]);
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
			prepareDelivery: async (delivery) => {
				if (delivery.kind !== "steer") return { messages: [...delivery.messages] };
				preparedBatches.push(delivery.messages.map(getUserText));
				if (failPreparation) {
					preparationStarted.resolve();
					await releasePreparation.promise;
					throw new Error("queue preparation failed");
				}
				return { messages: [...delivery.messages] };
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
		await preparationStarted.promise;
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Second steering" }],
			timestamp: Date.now() + 1,
		});
		releasePreparation.resolve();
		await continuation;

		expect(agent.state.errorMessage).toBe("queue preparation failed");
		expect(agent.hasQueuedMessages()).toBe(true);

		failPreparation = false;
		await agent.continue();

		expect(preparedBatches).toEqual([["First steering"], ["First steering"], ["Second steering"]]);
		expect(providerUserTexts).toEqual(["First steering", "Second steering"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("restores a delivery when its participant explicitly retains", async () => {
		let failCommit = true;
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						failCommit
							? { outcome: "retained", error: new Error("settlement failed") }
							: { outcome: "committed" },
				},
			}),
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "retry me" }],
			timestamp: Date.now(),
		});

		await agent.continue();
		expect(agent.state.errorMessage).toBe("settlement failed");
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(providerCalls).toBe(0);

		failCommit = false;
		await agent.continue();
		expect(agent.state.messages.map(getUserText).filter(Boolean)).toEqual(["retry me"]);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(providerCalls).toBe(1);
	});

	it("keeps default committed batch deliveries authoritative when an observer fails", async () => {
		const delivered: string[] = [];
		let laterAgentEndUserTexts: string[] = [];
		let failFirst = true;
		const agent = new Agent({
			steeringMode: "all",
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];
		const firstId = agent.steer({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		});
		const secondId = agent.steer({
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: Date.now() + 1,
		});
		const seenDeliveryIds: string[] = [];
		agent.subscribe((event) => {
			if (event.type === "agent_end") {
				const user = event.messages.find((message) => message.role === "user");
				if (user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated terminal snapshot";
				}
				throw new Error("terminal observer failed");
			}
			if (event.type !== "message_start" || event.message.role !== "user") return;
			const text = getUserText(event.message);
			if (text) delivered.push(text);
			if (event.deliveryId) seenDeliveryIds.push(event.deliveryId);
			if (failFirst) {
				failFirst = false;
				throw new Error("pre-delivery listener failed");
			}
		});
		agent.subscribe((event) => {
			if (event.type === "agent_end") {
				laterAgentEndUserTexts = event.messages.map(getUserText).filter((text) => text !== undefined);
			}
		});

		const result = await agent.continue();

		expect(result).toMatchObject({
			status: "completed",
			deliveries: [{ outcome: "committed" }, { outcome: "committed" }],
		});
		expect(agent.state.errorMessage).toBeUndefined();
		expect(delivered).toEqual(["first", "second"]);
		expect(seenDeliveryIds).toEqual([firstId, secondId]);
		expect(secondId).not.toBe(firstId);
		expect(agent.state.messages.map(getUserText).filter(Boolean)).toEqual(["first", "second"]);
		expect(laterAgentEndUserTexts).toEqual(["first", "second"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("does not emit deliveries revoked after an all-mode action resolves", async () => {
		const deliveredUserTexts: string[] = [];
		let providerUserTexts: Array<string | undefined> = [];
		let revokedIds: string[] = [];
		const agent = new Agent({
			steeringMode: "all",
			streamFn: (_model, context) => {
				providerUserTexts = context.messages.map(getUserText).filter((text) => text !== undefined);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];
		const firstId = agent.steer({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		});
		const secondId = agent.steer({
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: Date.now() + 1,
		});
		agent.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user") return;
			const text = getUserText(event.message);
			if (text) deliveredUserTexts.push(text);
			if (text === "first") revokedIds = agent.clearSteeringQueue();
		});

		await agent.continue();

		expect(deliveredUserTexts).toEqual(["first"]);
		expect(revokedIds).toEqual([secondId]);
		expect(revokedIds).not.toContain(firstId);
		expect(providerUserTexts).toEqual(["first"]);
		expect(agent.state.messages.map(getUserText).filter((text) => text !== undefined)).toEqual(["first"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("does not revoke a committed delivery during turn_start", async () => {
		let stagedCommits = 0;
		let providerCalls = 0;
		let revokedIds: string[] = [];
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						stagedCommits++;
						return { outcome: "committed" };
					},
				},
			}),
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "committed" }],
			timestamp: Date.now(),
		});
		agent.subscribe((event) => {
			if (event.type === "turn_start") revokedIds = agent.clearSteeringQueue();
		});

		await agent.continue();

		expect(revokedIds).toEqual([]);
		expect(stagedCommits).toBe(1);
		expect(providerCalls).toBe(1);
		expect(agent.state.messages.map(getUserText).filter(Boolean)).toEqual(["committed"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("settles a participant before publishing delivery_start", async () => {
		let committed = false;
		let observedCommitted = false;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						committed = true;
						return { outcome: "committed" };
					},
				},
			}),
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "delivery_start") observedCommitted = committed;
		});

		await agent.prompt("commit me");

		expect(observedCommitted).toBe(true);
	});

	it("continue() is a no-op for an assistant tail without queued delivery or host policy", async () => {
		let providerCalls = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("unexpected") });
				});
				return stream;
			},
		});
		const tail = createAssistantMessage("already complete");
		agent.state.messages = [tail];

		await expect(agent.continue()).resolves.toEqual({ status: "completed", deliveries: [] });

		expect(providerCalls).toBe(0);
		expect(agent.state.messages).toEqual([tail]);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("treats the canonical nextAction default as a no-op at an assistant tail", async () => {
		let providerCalls = 0;
		const tail = createAssistantMessage("already complete");
		const agent = new Agent({
			initialState: { messages: [tail] },
			nextAction: (context) => context.defaultAction,
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("unexpected") });
				});
				return stream;
			},
		});

		await agent.continue();

		expect(providerCalls).toBe(0);
		expect(agent.state.messages).toEqual([tail]);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("allows nextAction to attach the required user delivery from an assistant tail", async () => {
		let attached = false;
		let providerUserTexts: Array<string | undefined> = [];
		const agent = new Agent({
			nextAction: (context) => {
				if (attached) return context.defaultAction;
				attached = true;
				return {
					type: "request",
					reason: "delivery",
					deliveries: [
						{
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "host delivery" }],
									timestamp: Date.now(),
								},
							],
						},
					],
				};
			},
			streamFn: (_model, context) => {
				providerUserTexts = context.messages.map(getUserText).filter((text) => text !== undefined);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];

		await agent.continue();

		expect(providerUserTexts).toEqual(["host delivery"]);
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

		await expect(agent.continue()).resolves.toMatchObject({ status: "completed" });

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages.at(-1)?.role).toBe("assistant");
	});

	it("continue() resumes a provider-ready tool result before draining follow-up", async () => {
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
				toolName: "completed_operation",
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

		await agent.continue();

		expect(sawFollowUp).toBe(true);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"toolResult",
			"assistant",
			"user",
			"assistant",
		]);
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

		await expect(agent.continue()).resolves.toMatchObject({ status: "completed" });

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("stops after the current turn when nextAction returns stop", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema> = {
			name: "noop_tool",
			label: "Noop Tool",
			description: "Returns ok",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
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
		agent.nextAction = (context, signal) => {
			if (!context.completedTurn) return context.defaultAction;
			hookCalls.push({
				toolResultCount: context.completedTurn.toolResults.length,
				hasSignal: signal !== undefined,
			});
			return { type: "stop" };
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

	it("treats an irrevocably started delivery as an accepted request for abort settlement", async () => {
		let deliverySnapshotAccepted = false;
		let providerCalls = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("unexpected") });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type !== "delivery_start") return;
			deliverySnapshotAccepted = agent.activeRunSnapshot?.requestAccepted === true;
			agent.abort("disposal");
		});

		await agent.prompt("abort after delivery admission");

		expect(deliverySnapshotAccepted).toBe(true);
		expect(providerCalls).toBe(0);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
		});
	});

	it("keeps sourced cancellation marker-free when next-action preflight fails before admission", async () => {
		let agent!: Agent;
		agent = new Agent({
			nextAction: async () => {
				agent.abort("host_action");
				throw new Error("cancelled preflight");
			},
		});

		await agent.prompt("never admit this delivery");

		expect(agent.state.messages).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("persists the first known local abort source on the terminal assistant", async () => {
		const requestStarted = createDeferred();
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				options?.signal?.addEventListener(
					"abort",
					() => {
						const message = { ...createAssistantMessage(""), stopReason: "aborted" as const };
						stream.push({ type: "error", seq: 1, reason: "aborted", error: message });
					},
					{ once: true },
				);
				requestStarted.resolve();
				return stream;
			},
		});

		const prompting = agent.prompt("abort me");
		await requestStarted.promise;
		const first = agent.abort("host_action");
		const second = agent.abort("disposal");
		await prompting;

		expect(first).toMatchObject({ accepted: true, source: "host_action" });
		expect(second).toMatchObject({ accepted: true, source: "host_action", runId: first.runId });
		const assistant = agent.state.messages.at(-1);
		expect(assistant).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "host_action" } })],
		});
	});

	it("allows a known abort authority to fill an earlier unattributed cancellation", async () => {
		const requestStarted = createDeferred();
		const releaseAbort = createDeferred();
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				options?.signal?.addEventListener(
					"abort",
					() => {
						void releaseAbort.promise.then(() => {
							const message = { ...createAssistantMessage(""), stopReason: "aborted" as const };
							stream.push({ type: "error", seq: 1, reason: "aborted", error: message });
						});
					},
					{ once: true },
				);
				requestStarted.resolve();
				return stream;
			},
		});

		const prompting = agent.prompt("abort me");
		await requestStarted.promise;
		expect(agent.abort()).toMatchObject({ accepted: true, source: undefined });
		expect(agent.abort("remote_request")).toMatchObject({ accepted: true, source: "remote_request" });
		releaseAbort.resolve();
		await prompting;

		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "remote_request" } })],
		});
	});

	it("does not fabricate abort provenance for provider outcomes", async () => {
		for (const stopReason of ["stop", "aborted"] as const) {
			const agent = new Agent({
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message = { ...createAssistantMessage(stopReason), stopReason };
						if (stopReason === "aborted") {
							stream.push({ type: "error", seq: 1, reason: "aborted", error: message });
						} else {
							stream.push({ type: "done", seq: 1, reason: "stop", message });
						}
					});
					return stream;
				},
			});

			await agent.prompt("provider outcome");
			const assistant = agent.state.messages.at(-1);
			expect(assistant).toMatchObject({ role: "assistant", stopReason });
			if (assistant?.role !== "assistant") throw new Error("expected assistant outcome");
			expect(assistant.diagnostics?.filter((diagnostic) => diagnostic.type === "runtime_abort") ?? []).toEqual([]);
		}
	});

	it("re-canonicalizes a terminal message when abort lands during an awaited listener", async () => {
		const terminalListenerStarted = createDeferred();
		const releaseTerminalListener = createDeferred();
		let laterListenerMessage: AssistantMessage | undefined;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("completed") });
				});
				return stream;
			},
		});
		agent.subscribe(async (event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			terminalListenerStarted.resolve();
			await releaseTerminalListener.promise;
		});
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				laterListenerMessage = event.message;
			}
		});

		const prompting = agent.prompt("race terminal listener");
		await terminalListenerStarted.promise;
		expect(agent.abort("remote_request")).toMatchObject({ accepted: true, source: "remote_request" });
		releaseTerminalListener.resolve();
		await prompting;

		const expectedTerminalMessage = {
			role: "assistant",
			stopReason: "stop",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "remote_request" } })],
		};
		expect(laterListenerMessage).toMatchObject(expectedTerminalMessage);
		expect(agent.state.messages.at(-1)).toMatchObject(expectedTerminalMessage);
	});

	it("re-canonicalizes runtime abort diagnostics across message replacements without mutating snapshots", async () => {
		const requestStarted = createDeferred();
		const replacementDiagnostics: NonNullable<AssistantMessage["diagnostics"]> = [
			{ type: "extension_one", timestamp: 1, details: { retained: true } },
			{ type: "runtime_abort", timestamp: 2, details: { source: "disposal" } },
		];
		let secondListenerInput: AssistantMessage | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				options?.signal?.addEventListener(
					"abort",
					() => {
						const message = { ...createAssistantMessage(""), stopReason: "aborted" as const };
						stream.push({ type: "error", seq: 1, reason: "aborted", error: message });
					},
					{ once: true },
				);
				requestStarted.resolve();
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
			return { ...event.message, diagnostics: replacementDiagnostics } as AssistantMessage;
		});
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
			secondListenerInput = event.message;
			const diagnostics: NonNullable<AssistantMessage["diagnostics"]> = [
				...(event.message.diagnostics ?? []),
				{ type: "extension_two", timestamp: 3, details: { retained: true } },
				{ type: "runtime_abort", timestamp: 4, details: { source: "keyboard_interrupt" } },
			];
			return { ...event.message, diagnostics };
		});

		const prompting = agent.prompt("abort with replacements");
		await requestStarted.promise;
		agent.abort("session_replacement");
		await prompting;

		expect(replacementDiagnostics).toEqual([
			{ type: "extension_one", timestamp: 1, details: { retained: true } },
			{ type: "runtime_abort", timestamp: 2, details: { source: "disposal" } },
		]);
		expect(secondListenerInput?.diagnostics).toEqual([
			{ type: "extension_one", timestamp: 1, details: { retained: true } },
			expect.objectContaining({ type: "runtime_abort", details: { source: "session_replacement" } }),
		]);
		const assistant = agent.state.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("expected assistant outcome");
		expect(assistant.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"extension_one",
			"extension_two",
			"runtime_abort",
		]);
		expect(assistant.diagnostics?.at(-1)).toMatchObject({
			details: { source: "session_replacement" },
		});
	});
});
