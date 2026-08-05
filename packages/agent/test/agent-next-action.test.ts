import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { agentLoopContinue, runAgentLoop, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => this.push({ type: "done", seq: 1, reason: "stop", message }));
	}
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

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
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

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

describe("agent loop next-action protocol", () => {
	it("resolves one action per request boundary and prepares only authorized requests", async () => {
		let actionCalls = 0;
		let preparationCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: (context) => {
					actionCalls++;
					if (context.completedTurn) return { type: "stop" };
					expect(context.defaultAction.type).toBe("request");
					return {
						type: "request",
						reason: "delivery",
						deliveries: [{ deliveryId: "initial", messages: [createUserMessage("delivered")] }],
					};
				},
				prepareRequest: ({ deliveries }) => {
					preparationCalls++;
					expect(deliveries.map((delivery) => delivery.deliveryId)).toEqual(["initial"]);
					return undefined;
				},
			},
			(event) => {
				events.push(event);
			},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		);

		expect(actionCalls).toBe(2);
		expect(preparationCalls).toBe(1);
		expect(providerCalls).toBe(1);
		expect(
			events.flatMap<{ type: string; deliveryId: string | undefined }>((event) => {
				if (event.type === "delivery_start") return [{ type: event.type, deliveryId: event.deliveryId }];
				if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
					return [{ type: event.type, deliveryId: event.deliveryId }];
				}
				return [];
			}),
		).toEqual([
			{ type: "delivery_start", deliveryId: "initial" },
			{ type: "message_start", deliveryId: "initial" },
			{ type: "message_end", deliveryId: "initial" },
		]);
	});

	it("emits delivery lifecycle for anonymous initial deliveries", async () => {
		const prompt = createUserMessage("hello");
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				prepareRequest: () => undefined,
			},
			(event) => {
				events.push(event);
			},
			undefined,
			() => new MockAssistantStream(createAssistantMessage("done")),
		);

		expect(events.filter((event) => event.type === "delivery_start")).toEqual([
			{ type: "delivery_start", deliveryId: undefined, messages: [prompt] },
		]);
	});

	it("admits a delivery before continuing from an assistant transcript tail", async () => {
		let providerCalls = 0;
		let providerRoles: Message["role"][] = [];
		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(
			{ systemPrompt: "", messages: [createAssistantMessage("paused")] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: (context) =>
					context.completedTurn
						? { type: "stop" }
						: {
								type: "request",
								reason: "delivery",
								deliveries: [{ deliveryId: "resume", messages: [createUserMessage("resume")] }],
							},
			},
			undefined,
			(_model, context) => {
				providerCalls++;
				providerRoles = context.messages.map((message) => message.role);
				return new MockAssistantStream(createAssistantMessage("resumed"));
			},
		);

		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(providerCalls).toBe(1);
		expect(providerRoles).toEqual(["assistant", "user"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(events.some((event) => event.type === "delivery_start" && event.deliveryId === "resume")).toBe(true);
	});

	it("rejects an assistant-tail request without an admitted user delivery", async () => {
		let providerCalls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm,
			nextAction: () => ({ type: "request", reason: "continuation" }),
		};
		const streamFn = () => {
			providerCalls++;
			return new MockAssistantStream(createAssistantMessage("unexpected"));
		};
		await expect(
			runAgentLoopContinue(
				{ systemPrompt: "", messages: [createAssistantMessage("paused")] },
				config,
				() => {},
				undefined,
				streamFn,
			),
		).rejects.toThrow("Cannot request with an assistant message at the provider transcript tail");

		const stream = agentLoopContinue(
			{ systemPrompt: "", messages: [createAssistantMessage("paused")] },
			config,
			undefined,
			streamFn,
		);
		await expect(
			(async () => {
				for await (const _event of stream) {
					// Drain until the deferred request validation rejects.
				}
			})(),
		).rejects.toThrow("Cannot request with an assistant message at the provider transcript tail");
		await expect(stream.result()).rejects.toThrow(
			"Cannot request with an assistant message at the provider transcript tail",
		);
		expect(providerCalls).toBe(0);
	});

	it("does not open a turn or request when admission rejects every delivery", async () => {
		let preparationCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[createUserMessage("revoked")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				beginDelivery: () => false,
				prepareRequest: () => {
					preparationCalls++;
					return undefined;
				},
			},
			(event) => {
				events.push(event);
			},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(preparationCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
	});

	it("does not begin a later delivery after the run aborts", async () => {
		const abortController = new AbortController();
		const begunDeliveryIds: Array<string | undefined> = [];
		let actionCalls = 0;
		let providerCalls = 0;
		const messages = await runAgentLoop(
			[createUserMessage("default")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: () =>
					actionCalls++ === 0
						? {
								type: "request",
								reason: "delivery",
								deliveries: [
									{ deliveryId: "first", messages: [createUserMessage("first")] },
									{ deliveryId: "second", messages: [createUserMessage("second")] },
								],
							}
						: { type: "stop" },
				beginDelivery: (delivery) => {
					begunDeliveryIds.push(delivery.deliveryId);
					return true;
				},
			},
			(event) => {
				if (event.type === "delivery_start" && event.deliveryId === "first") {
					abortController.abort();
				}
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(begunDeliveryIds).toEqual(["first"]);
		expect(providerCalls).toBe(0);
		expect(messages.flatMap((message) => (message.role === "user" ? [message.content] : []))).toEqual(["first"]);
	});

	it("settles pause without preparing or opening a request", async () => {
		let preparationCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop(
			[createUserMessage("paused")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: () => ({ type: "pause" }),
				prepareRequest: () => {
					preparationCalls++;
					return undefined;
				},
			},
			(event) => {
				events.push(event);
			},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(messages).toEqual([]);
		expect(preparationCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
	});

	it("does not prepare or issue a provider request after turn_start observes an abort", async () => {
		const abortController = new AbortController();
		let transformCalls = 0;
		let conversionCalls = 0;
		let credentialCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				transformContext: async (messages) => {
					transformCalls++;
					return messages;
				},
				convertToLlm: (messages) => {
					conversionCalls++;
					return convertToLlm(messages);
				},
				getApiKey: () => {
					credentialCalls++;
					return "unused";
				},
				prepareRequest: () => undefined,
			},
			(event) => {
				events.push(event);
				if (event.type === "turn_start") abortController.abort();
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(transformCalls).toBe(0);
		expect(conversionCalls).toBe(0);
		expect(credentialCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("completes an admitted request with an aborted turn when delivery finalization aborts", async () => {
		const abortController = new AbortController();
		const prompt = createUserMessage("hello");
		let preparationCalls = 0;
		let transformCalls = 0;
		let conversionCalls = 0;
		let credentialCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				transformContext: async (contextMessages) => {
					transformCalls++;
					return contextMessages;
				},
				convertToLlm: (contextMessages) => {
					conversionCalls++;
					return convertToLlm(contextMessages);
				},
				getApiKey: () => {
					credentialCalls++;
					return "unused";
				},
				prepareRequest: () => {
					preparationCalls++;
					return undefined;
				},
			},
			(event) => {
				events.push(event);
				if (event.type === "message_end" && event.message.role === "user") abortController.abort();
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(preparationCalls).toBe(0);
		expect(transformCalls).toBe(0);
		expect(conversionCalls).toBe(0);
		expect(credentialCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual([
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
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(prompt);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model: "mock",
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});
		expect(events.at(-1)).toEqual({ type: "agent_end", messages });
	});

	it("completes an admitted request with the prepared snapshot when preparation aborts", async () => {
		const abortController = new AbortController();
		const prompt = createUserMessage("hello");
		const activeModel = { ...createModel(), id: "prepared-model" };
		let transformCalls = 0;
		let conversionCalls = 0;
		let credentialCalls = 0;
		let providerCalls = 0;
		let preparedContext: { systemPrompt: string; messages: AgentMessage[] } | undefined;
		let markPreparationStarted: (() => void) | undefined;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		let releasePreparation: (() => void) | undefined;
		const preparationReleased = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const events: AgentEvent[] = [];
		const run = runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				transformContext: async (contextMessages) => {
					transformCalls++;
					return contextMessages;
				},
				convertToLlm: (contextMessages) => {
					conversionCalls++;
					return convertToLlm(contextMessages);
				},
				getApiKey: () => {
					credentialCalls++;
					return "unused";
				},
				prepareRequest: async ({ context }) => {
					preparedContext = { systemPrompt: "prepared", messages: [...context.messages] };
					markPreparationStarted?.();
					await preparationReleased;
					return { context: preparedContext, model: activeModel };
				},
			},
			(event) => {
				events.push(event);
				if (
					(event.type === "message_start" || event.type === "message_end") &&
					event.message.role === "assistant"
				) {
					expect(preparedContext?.messages.at(-1)).toBe(event.message);
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					return {
						...event.message,
						content: [{ type: "text", text: "rewritten abort" }],
						errorMessage: "rewritten abort error",
					};
				}
				return undefined;
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		await preparationStarted;
		abortController.abort();
		releasePreparation?.();
		const messages = await run;

		expect(transformCalls).toBe(0);
		expect(conversionCalls).toBe(0);
		expect(credentialCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual([
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
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(prompt);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "rewritten abort" }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			stopReason: "aborted",
			errorMessage: "rewritten abort error",
		});
		expect(preparedContext?.messages).toEqual(messages);
		expect(events.at(-1)).toEqual({ type: "agent_end", messages });
	});

	it("returns an aborted assistant when abort occurs during request preflight", async () => {
		const abortController = new AbortController();
		const activeModel = { ...createModel(), id: "active-model" };
		let transformCalls = 0;
		let conversionCalls = 0;
		let credentialCalls = 0;
		let providerCalls = 0;
		let preparedMessages: AgentMessage[] | undefined;
		let markTransformStarted: (() => void) | undefined;
		const transformStarted = new Promise<void>((resolve) => {
			markTransformStarted = resolve;
		});
		let releaseTransform: (() => void) | undefined;
		const transformReleased = new Promise<void>((resolve) => {
			releaseTransform = resolve;
		});
		const events: AgentEvent[] = [];
		const run = runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				transformContext: async (messages) => {
					transformCalls++;
					markTransformStarted?.();
					await transformReleased;
					return messages;
				},
				convertToLlm: (messages) => {
					conversionCalls++;
					return convertToLlm(messages);
				},
				getApiKey: () => {
					credentialCalls++;
					return "unused";
				},
				prepareRequest: ({ context }) => {
					preparedMessages = [...context.messages];
					return { context: { ...context, messages: preparedMessages }, model: activeModel };
				},
			},
			(event) => {
				events.push(event);
				if (
					(event.type === "message_start" || event.type === "message_end") &&
					event.message.role === "assistant"
				) {
					expect(preparedMessages?.at(-1)).toBe(event.message);
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					return {
						...event.message,
						content: [{ type: "text", text: "rewritten abort" }],
						errorMessage: "rewritten abort error",
					};
				}
				return undefined;
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		await transformStarted;
		abortController.abort();
		releaseTransform?.();
		const messages = await run;

		expect(transformCalls).toBe(1);
		expect(conversionCalls).toBe(0);
		expect(credentialCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(events.map((event) => event.type)).toEqual([
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

		const assistantStart = events.find(
			(event) => event.type === "message_start" && event.message.role === "assistant",
		);
		expect(assistantStart).toMatchObject({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: activeModel.api,
				provider: activeModel.provider,
				model: activeModel.id,
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
		const assistant = messages.at(-1);
		expect(assistant).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "rewritten abort" }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			stopReason: "aborted",
			errorMessage: "rewritten abort error",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		if (assistant?.role !== "assistant") throw new Error("Expected aborted assistant result");
		expect(preparedMessages).toEqual(messages);
		const turnEnd = events.find((event) => event.type === "turn_end");
		const agentEnd = events.find((event) => event.type === "agent_end");
		expect(turnEnd).toMatchObject({ type: "turn_end", message: assistant, toolResults: [] });
		expect(agentEnd).toMatchObject({ type: "agent_end", messages });
	});

	it("does not resolve another action after turn_end observes an abort", async () => {
		const abortController = new AbortController();
		let actionCalls = 0;
		let providerCalls = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: (context) => {
					actionCalls++;
					return context.defaultAction;
				},
			},
			(event) => {
				events.push(event);
				if (event.type === "turn_end") abortController.abort();
			},
			abortController.signal,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		);

		expect(actionCalls).toBe(1);
		expect(providerCalls).toBe(1);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("passes only admitted deliveries to request preparation", async () => {
		let actionCalls = 0;
		let preparedDeliveryIds: Array<string | undefined> = [];
		let providerUserTexts: string[] = [];
		const messages = await runAgentLoop(
			[createUserMessage("default")],
			{ systemPrompt: "", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: () =>
					actionCalls++ === 0
						? {
								type: "request",
								reason: "delivery",
								deliveries: [
									{ deliveryId: "revoked", messages: [createUserMessage("revoked")] },
									{ deliveryId: "admitted", messages: [createUserMessage("admitted")] },
								],
							}
						: { type: "stop" },
				beginDelivery: (delivery) => delivery.deliveryId !== "revoked",
				prepareRequest: ({ deliveries }) => {
					preparedDeliveryIds = deliveries.map((delivery) => delivery.deliveryId);
					return undefined;
				},
			},
			() => {},
			undefined,
			(_model, context) => {
				providerUserTexts = context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				);
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		);

		expect(preparedDeliveryIds).toEqual(["admitted"]);
		expect(providerUserTexts).toEqual(["admitted"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("keeps continuation authority when every attached delivery is revoked", async () => {
		let actionCalls = 0;
		let preparationCalls = 0;
		let providerCalls = 0;
		const messages = await runAgentLoopContinue(
			{ systemPrompt: "", messages: [createUserMessage("existing")] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: () =>
					actionCalls++ === 0
						? {
								type: "request",
								reason: "continuation",
								deliveries: [{ deliveryId: "revoked", messages: [createUserMessage("ignored")] }],
							}
						: { type: "stop" },
				beginDelivery: () => false,
				prepareRequest: ({ deliveries }) => {
					preparationCalls++;
					expect(deliveries).toEqual([]);
					return undefined;
				},
			},
			() => {},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("continued"));
			},
		);

		expect(preparationCalls).toBe(1);
		expect(providerCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["assistant"]);
	});

	it("applies request state replacements after deliveries finalize", async () => {
		let actionCalls = 0;
		let providerSnapshot:
			| {
					modelId: string;
					systemPrompt: string | undefined;
					reasoning: string | undefined;
					roles: Message["role"][];
			  }
			| undefined;
		const replacementModel = { ...createModel(), id: "replacement", reasoning: true };
		await runAgentLoop(
			[createUserMessage("hello")],
			{ systemPrompt: "initial", messages: [] },
			{
				model: createModel(),
				convertToLlm,
				nextAction: (context) => {
					actionCalls++;
					return context.completedTurn ? { type: "stop" } : context.defaultAction;
				},
				prepareRequest: ({ context, deliveries }) => {
					expect(deliveries).toHaveLength(1);
					expect(context.messages.map((message) => message.role)).toEqual(["user"]);
					return {
						context: { ...context, systemPrompt: "prepared" },
						model: replacementModel,
						thinkingLevel: "high",
					};
				},
			},
			() => {},
			undefined,
			(model, context, options) => {
				providerSnapshot = {
					modelId: model.id,
					systemPrompt: context.systemPrompt,
					reasoning: options?.reasoning,
					roles: context.messages.map((message) => message.role),
				};
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		);

		expect(actionCalls).toBe(2);
		expect(providerSnapshot).toEqual({
			modelId: "replacement",
			systemPrompt: "prepared",
			reasoning: "high",
			roles: ["user"],
		});
	});
});
