import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type AgentTool } from "../src/index.ts";

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
		queueMicrotask(() =>
			this.push({ type: "done", seq: 1, reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
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

function createToolUseMessage(): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "call-1", name: "finish", arguments: {} }],
		stopReason: "toolUse",
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function getUserTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
	});
}

describe("Agent delivery transaction participant", () => {
	it("awaits host settlement before publishing or invoking the provider", async () => {
		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		const events: string[] = [];
		let providerCalls = 0;
		let deliveryId = "";
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				deliveryId = delivery.deliveryId;
				return {
					messages: [...delivery.messages],
					participant: {
						settle: async () => {
							settlementStarted.resolve();
							await releaseSettlement.promise;
							return { outcome: "committed" };
						},
					},
				};
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});
		agent.subscribe((event) => {
			events.push(event.type);
		});

		const prompting = agent.prompt("transactional prompt");
		await settlementStarted.promise;

		expect(events).toEqual(["agent_start"]);
		expect(providerCalls).toBe(0);
		expect(agent.clearAllQueues()).toEqual([]);
		expect(() => agent.reset()).toThrow("Cannot reset Agent while a run is active");

		releaseSettlement.resolve();
		const result = await prompting;

		expect(result).toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "committed" }],
		});
		expect(events).toContain("delivery_start");
		expect(providerCalls).toBe(1);
		expect(getUserTexts(agent.state.messages)).toEqual(["transactional prompt"]);
	});

	it("retains a definitively rolled-back attempt for explicit retry with the same identity", async () => {
		let settlementCalls = 0;
		const deliveryIds: string[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				deliveryIds.push(delivery.deliveryId);
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							settlementCalls++;
							return settlementCalls === 1
								? { outcome: "retained", error: new Error("definitive rollback") }
								: { outcome: "committed" };
						},
					},
				};
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("retried"));
			},
		});

		const failed = await agent.prompt("retry me");

		expect(failed).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement", error: { message: "definitive rollback" } },
		});
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(providerCalls).toBe(0);
		expect(settlementCalls).toBe(1);

		const retried = await agent.continue();

		expect(retried).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(new Set(deliveryIds)).toHaveLength(1);
		expect(settlementCalls).toBe(2);
		expect(providerCalls).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(agent.state.messages)).toEqual(["retry me"]);
	});

	it.each([
		{
			name: "an explicit ambiguous outcome",
			settle: () => ({ outcome: "terminally_failed" as const, error: new Error("durability ambiguous") }),
		},
		{
			name: "an unexpected participant rejection",
			settle: () => Promise.reject(new Error("participant crashed")),
		},
	])("terminally fences $name", async ({ settle }) => {
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: { settle },
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		});

		const result = await agent.prompt("unsafe retry");

		expect(result).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(providerCalls).toBe(0);
	});

	it("reports preparation failure as retained without invoking a participant", async () => {
		let failPreparation = true;
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				if (failPreparation) throw new Error("preparation failed");
				return { messages: [...delivery.messages] };
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});

		const failed = await agent.prompt("prepare me");
		expect(failed).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "preparation", error: { message: "preparation failed" } },
		});
		expect(providerCalls).toBe(0);
		expect(agent.hasQueuedMessages()).toBe(true);

		failPreparation = false;
		await agent.continue();
		expect(providerCalls).toBe(1);
	});

	it("retains the immutable admitted payload when failed preparation mutates its attempt copy", async () => {
		const attemptedTexts: string[][] = [];
		let failPreparation = true;
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				attemptedTexts.push(getUserTexts(delivery.messages));
				const user = delivery.messages.find((message) => message.role === "user");
				if (failPreparation && user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated attempt";
					throw new Error("reject mutated preparation");
				}
				return { messages: [...delivery.messages] };
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage("done")),
		});

		await agent.prompt("immutable input");
		failPreparation = false;
		await agent.continue();

		expect(attemptedTexts).toEqual([["immutable input"], ["immutable input"]]);
		expect(getUserTexts(agent.state.messages)).toEqual(["immutable input"]);
	});

	it("leaves host planning state unchanged when deterministic preparation fails", async () => {
		let planPhase: "ready" | "draft" = "ready";
		let failPreparation = true;
		const agent = new Agent({
			prepareDelivery: (delivery) => {
				if (failPreparation) throw new Error("deterministic preflight failure");
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							planPhase = "draft";
							return { outcome: "committed" };
						},
					},
				};
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage("done")),
		});
		agent.steer({ role: "user", content: "plan feedback", timestamp: Date.now() });

		await agent.continue();
		expect(planPhase).toBe("ready");
		expect(agent.hasQueuedMessages()).toBe(true);

		failPreparation = false;
		await agent.continue();
		expect(planPhase).toBe("draft");
	});

	it("reports a delivery revoked while preparation is pending", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let participantCalls = 0;
		let deliveryId = "";
		const agent = new Agent({
			prepareDelivery: async (delivery) => {
				deliveryId = delivery.deliveryId;
				preparationStarted.resolve();
				await releasePreparation.promise;
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							participantCalls++;
							return { outcome: "committed" };
						},
					},
				};
			},
		});

		const prompting = agent.prompt("revoke me");
		await preparationStarted.promise;
		expect(agent.discardPendingPrompt()).toEqual([deliveryId]);
		releasePreparation.resolve();

		expect(await prompting).toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "revoked" }],
		});
		expect(participantCalls).toBe(0);
		expect(agent.state.messages).toEqual([]);
	});

	it("lets external abort win before the commit decision and retains the delivery", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let participantCalls = 0;
		const agent = new Agent({
			prepareDelivery: async (delivery) => {
				preparationStarted.resolve();
				await releasePreparation.promise;
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							participantCalls++;
							return { outcome: "committed" };
						},
					},
				};
			},
		});

		const prompting = agent.prompt("retain before commit");
		await preparationStarted.promise;
		agent.abort("remote_request");
		releasePreparation.resolve();
		const result = await prompting;

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "retained" }] });
		expect(participantCalls).toBe(0);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.state.messages).toEqual([]);
	});

	it("preserves a committed winner when external abort races durability", async () => {
		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						settlementStarted.resolve();
						await releaseSettlement.promise;
						return { outcome: "committed" };
					},
				},
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		});

		const prompting = agent.prompt("commit before abort");
		await settlementStarted.promise;
		let teardownSettled = false;
		const externalTeardown = (async () => {
			expect(agent.abort("remote_request")).toMatchObject({ accepted: true, source: "remote_request" });
			await agent.waitForIdle();
			teardownSettled = true;
		})();
		expect(agent.clearAllQueues()).toEqual([]);
		expect(teardownSettled).toBe(false);
		releaseSettlement.resolve();
		const result = await prompting;
		await externalTeardown;

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(teardownSettled).toBe(true);
		expect(providerCalls).toBe(0);
		expect(getUserTexts(agent.state.messages)).toEqual(["commit before abort"]);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("uses the participant lifecycle capability for reentrant abort without deadlock", async () => {
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: (context) => {
						expect(context.requestAbort("host_action")).toMatchObject({ accepted: true, source: "host_action" });
						return { outcome: "committed" };
					},
				},
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("unexpected"));
			},
		});

		const result = await agent.prompt("commit reentrantly");

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(providerCalls).toBe(0);
		expect(getUserTexts(agent.state.messages)).toEqual(["commit reentrantly"]);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("retains without an abort marker when participant rollback wins reentrant abort", async () => {
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: (context) => {
						context.requestAbort("disposal");
						return { outcome: "retained", error: new Error("rolled back") };
					},
				},
			}),
			streamFn: () => new MockAssistantStream(createAssistantMessage("unused")),
		});

		const result = await agent.prompt("retain after reentrant abort");

		expect(result).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});
		expect(agent.state.messages).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("preserves a committed batch prefix when a later participant retains", async () => {
		let retainSecond = true;
		let providerCalls = 0;
		let agentEndMessages: AgentMessage[] = [];
		const agent = new Agent({
			steeringMode: "all",
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						getUserTexts(delivery.messages).includes("second") && retainSecond
							? { outcome: "retained", error: new Error("retain second") }
							: { outcome: "committed" },
				},
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});
		agent.state.messages = [createAssistantMessage("tail")];
		agent.subscribe((event) => {
			if (event.type === "agent_end") agentEndMessages = event.messages;
		});
		agent.steer({ role: "user", content: "first", timestamp: Date.now() });
		agent.steer({ role: "user", content: "second", timestamp: Date.now() + 1 });

		const failed = await agent.continue();

		expect(failed).toMatchObject({
			status: "delivery_failed",
			deliveries: [{ outcome: "committed" }, { outcome: "retained" }],
		});
		expect(getUserTexts(agent.state.messages)).toEqual(["first"]);
		expect(getUserTexts(agentEndMessages)).toEqual(["first"]);
		expect(agentEndMessages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(providerCalls).toBe(0);

		retainSecond = false;
		await agent.continue();

		expect(getUserTexts(agent.state.messages)).toEqual(["first", "second"]);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(providerCalls).toBe(1);
	});

	it("keeps committed delivery projections authoritative when observers fail or replace", async () => {
		const laterObserverEvents: string[] = [];
		let laterAgentEndUserTexts: string[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: { settle: () => ({ outcome: "committed" }) },
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage("done"));
			},
		});
		agent.subscribe((event) => {
			if (event.type === "delivery_start") throw new Error("synchronous observer failure");
			if (event.type === "agent_end") {
				const user = event.messages.find((message) => message.role === "user");
				if (user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated terminal snapshot";
				}
				throw new Error("terminal observer failure");
			}
			if (
				event.type === "message_start" &&
				event.deliveryId &&
				event.message.role === "user" &&
				Array.isArray(event.message.content)
			) {
				const text = event.message.content.find((content) => content.type === "text");
				if (text?.type === "text") text.text = "mutated observer snapshot";
			}
			if (event.type === "message_end" && event.deliveryId && event.message.role === "user") {
				return { ...event.message, content: "observer replacement" };
			}
		});
		agent.subscribe(async (event) => {
			if (event.type === "message_start" && event.deliveryId) {
				await Promise.resolve();
				throw new Error("asynchronous observer failure");
			}
		});
		agent.subscribe((event) => {
			if ("deliveryId" in event && event.deliveryId) laterObserverEvents.push(event.type);
			if (event.type === "agent_end") laterAgentEndUserTexts = getUserTexts(event.messages);
		});

		const result = await agent.prompt("authoritative input");

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(providerCalls).toBe(1);
		expect(getUserTexts(agent.state.messages)).toEqual(["authoritative input"]);
		expect(laterObserverEvents).toEqual(["delivery_start", "message_start", "message_end"]);
		expect(laterAgentEndUserTexts).toEqual(["authoritative input"]);
	});

	it("continues provider work without recommitting client input or host planning state", async () => {
		let settlementCalls = 0;
		let providerCalls = 0;
		const tool: AgentTool = {
			name: "finish",
			label: "Finish",
			description: "Finish the test tool call",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "finished" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						settlementCalls++;
						return { outcome: "committed" };
					},
				},
			}),
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(
					providerCalls === 1 ? createToolUseMessage() : createAssistantMessage("done"),
				);
			},
		});

		const result = await agent.prompt("use a tool");

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(providerCalls).toBe(2);
		expect(settlementCalls).toBe(1);
	});
});
