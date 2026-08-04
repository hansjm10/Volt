import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { agentLoopContinue, runAgentLoop } from "../src/agent-loop.ts";
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
		expect(events.some((event) => event.type === "delivery_start" && event.deliveryId === "initial")).toBe(true);
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

	it("does not prepare or invoke a delivery-dependent request when admission rejects every delivery", async () => {
		let preparationCalls = 0;
		let providerCalls = 0;
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
			() => {},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		);

		expect(preparationCalls).toBe(0);
		expect(providerCalls).toBe(0);
	});

	it("keeps legacy follow-up polling operational during the stacked migration", async () => {
		let providerCalls = 0;
		let followUpAvailable = true;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm,
			getFollowUpMessages: async () => {
				if (!followUpAvailable) return [];
				followUpAvailable = false;
				return [createUserMessage("follow up")];
			},
		};
		const messages = await runAgentLoop(
			[createUserMessage("initial")],
			{ systemPrompt: "", messages: [] },
			config,
			() => {},
			undefined,
			() => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage(`response ${providerCalls}`));
			},
		);

		expect(providerCalls).toBe(2);
		expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
	});
});
