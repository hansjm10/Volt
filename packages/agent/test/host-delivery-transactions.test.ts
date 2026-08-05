import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage } from "../src/index.ts";

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
		queueMicrotask(() => {
			this.push({ type: "done", seq: 1, reason: "stop", message });
		});
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

function createUserMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function getUserTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
}

describe("Agent host delivery transactions", () => {
	it("retains a one-shot host delivery when preparation fails", async () => {
		let initialActionCalls = 0;
		let preparationCalls = 0;
		let failPreparation = true;
		let providerCalls = 0;
		const preparedIds: string[] = [];
		const agent = new Agent({
			initialState: { messages: [createAssistantMessage("tail")] },
			nextAction: (context) => {
				if (context.completedTurn) return context.defaultAction;
				initialActionCalls++;
				if (initialActionCalls > 1) return context.defaultAction;
				return {
					type: "request",
					reason: "delivery",
					deliveries: [{ messages: [createUserMessage("retained after preparation failure")] }],
				};
			},
			prepareDelivery: (delivery) => {
				preparationCalls++;
				preparedIds.push(delivery.deliveryId);
				if (failPreparation) throw new Error("transient host preparation failure");
				return { messages: [...delivery.messages] };
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});

		await agent.continue();
		expect(agent.state.errorMessage).toBe("transient host preparation failure");
		expect(providerCalls).toBe(0);

		failPreparation = false;
		await agent.continue();

		expect(initialActionCalls).toBe(1);
		expect(preparationCalls).toBe(2);
		expect(new Set(preparedIds).size).toBe(1);
		expect(providerCalls).toBe(1);
		expect(getUserTexts(agent.state.messages)).toEqual(["retained after preparation failure"]);
	});

	it("retains a one-shot host delivery when its begin commit fails", async () => {
		let attached = false;
		let failCommit = true;
		let providerCalls = 0;
		const preparedIds: string[] = [];
		const agent = new Agent({
			initialState: { messages: [createAssistantMessage("tail")] },
			nextAction: (context) => {
				if (attached) return context.defaultAction;
				attached = true;
				return {
					type: "request",
					reason: "delivery",
					deliveries: [{ messages: [createUserMessage("retained after begin failure")] }],
				};
			},
			prepareDelivery: (delivery) => {
				preparedIds.push(delivery.deliveryId);
				return {
					messages: [...delivery.messages],
					commit: () => {
						if (failCommit) throw new Error("transient host begin failure");
					},
				};
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});

		await agent.continue();
		expect(agent.state.errorMessage).toBe("transient host begin failure");
		expect(providerCalls).toBe(0);

		failCommit = false;
		await agent.continue();

		expect(preparedIds).toHaveLength(2);
		expect(new Set(preparedIds).size).toBe(1);
		expect(providerCalls).toBe(1);
		expect(getUserTexts(agent.state.messages)).toEqual(["retained after begin failure"]);
	});

	it("assigns unique dispatcher identities when host deliveries reuse an id", async () => {
		let attached = false;
		const preparedIds: string[] = [];
		const committedTexts: string[] = [];
		const deliveryStartIds: string[] = [];
		const agent = new Agent({
			initialState: { messages: [createAssistantMessage("tail")] },
			nextAction: (context) => {
				if (attached) return context.defaultAction;
				attached = true;
				return {
					type: "request",
					reason: "delivery",
					deliveries: [
						{ deliveryId: "caller-reused-id", messages: [createUserMessage("first")] },
						{ deliveryId: "caller-reused-id", messages: [createUserMessage("second")] },
					],
				};
			},
			prepareDelivery: (delivery) => {
				preparedIds.push(delivery.deliveryId);
				const text = getUserTexts(delivery.messages)[0]!;
				return {
					messages: [...delivery.messages],
					commit: () => committedTexts.push(text),
				};
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage("done")),
		});
		agent.subscribe((event) => {
			if (event.type === "delivery_start" && event.deliveryId) deliveryStartIds.push(event.deliveryId);
		});

		await agent.continue();

		expect(preparedIds).toHaveLength(2);
		expect(new Set(preparedIds).size).toBe(2);
		expect(preparedIds).not.toContain("caller-reused-id");
		expect(deliveryStartIds).toEqual(preparedIds);
		expect(committedTexts).toEqual(["first", "second"]);
		expect(getUserTexts(agent.state.messages)).toEqual(["first", "second"]);
	});

	it("retries multi-delivery preparation from an unchanged host action", async () => {
		let completed = false;
		let failSecondPreparation = true;
		const sourceAction = {
			type: "request" as const,
			reason: "delivery" as const,
			deliveries: [
				{ messages: [createUserMessage("first source")] },
				{ messages: [createUserMessage("second source")] },
			],
		};
		let deliveryPreparationIndex = 0;
		let providerUserTexts: string[] = [];
		const agent = new Agent({
			initialState: { messages: [createAssistantMessage("tail")] },
			nextAction: (context) => (completed ? context.defaultAction : sourceAction),
			prepareDelivery: (delivery) => {
				deliveryPreparationIndex++;
				if (failSecondPreparation && deliveryPreparationIndex === 2) {
					throw new Error("second host preparation failed");
				}
				return {
					messages: [createUserMessage(`prepared ${getUserTexts(delivery.messages)[0]}`), ...delivery.messages],
				};
			},
			streamFn: (_model, context) => {
				completed = true;
				providerUserTexts = getUserTexts(context.messages as AgentMessage[]);
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});

		await agent.continue();
		expect(agent.state.errorMessage).toBe("second host preparation failed");
		expect(sourceAction.deliveries.map((delivery) => getUserTexts(delivery.messages))).toEqual([
			["first source"],
			["second source"],
		]);

		failSecondPreparation = false;
		await agent.continue();

		expect(providerUserTexts).toEqual([
			"prepared first source",
			"first source",
			"prepared second source",
			"second source",
		]);
		expect(sourceAction.deliveries.map((delivery) => getUserTexts(delivery.messages))).toEqual([
			["first source"],
			["second source"],
		]);
	});
});
