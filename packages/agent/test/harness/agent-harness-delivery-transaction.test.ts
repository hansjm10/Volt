import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentDelivery, AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

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

function createHarness(
	options: Omit<ConstructorParameters<typeof AgentHarness>[0], "env" | "session" | "model"> & {
		session?: Session;
		registration?: ReturnType<typeof registerFauxProvider>;
	} = {},
): { harness: AgentHarness; registration: ReturnType<typeof registerFauxProvider>; session: Session } {
	const registration = options.registration ?? registerFauxProvider();
	registrations.push(registration);
	const session = options.session ?? new Session(new InMemorySessionStorage());
	const { registration: _registration, session: _session, ...harnessOptions } = options;
	return {
		harness: new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			...harnessOptions,
		}),
		registration,
		session,
	};
}

describe("AgentHarness delivery transactions", () => {
	it("awaits side-effect-free preparation and participant durability before publication or provider work", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		const events: string[] = [];
		let deliveryId = "";
		const session = new Session(new InMemorySessionStorage());
		const { harness, registration } = createHarness({
			session,
			prepareDelivery: async (delivery, signal) => {
				deliveryId = delivery.deliveryId;
				expect(signal.aborted).toBe(false);
				preparationStarted.resolve();
				await releasePreparation.promise;
				return {
					messages: [...delivery.messages],
					participant: {
						settle: async () => {
							settlementStarted.resolve();
							await releaseSettlement.promise;
							for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
							return { outcome: "committed" };
						},
					},
				};
			},
		});
		registration.setResponses([() => fauxAssistantMessage("done")]);
		harness.subscribe((event) => {
			events.push(event.type);
		});

		const running = harness.runPrompt("transactional prompt");
		await preparationStarted.promise;
		expect(harness.canPrepareDelivery(deliveryId)).toBe(true);
		expect(events).toEqual(["agent_start"]);
		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);
		releasePreparation.resolve();

		await settlementStarted.promise;
		expect(harness.canPrepareDelivery(deliveryId)).toBe(false);
		expect(await harness.discardPendingPrompt()).toEqual([]);
		expect(events).toEqual(["agent_start"]);
		expect(registration.state.callCount).toBe(0);
		releaseSettlement.resolve();

		expect(await running).toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "committed" }],
		});
		expect(events).toContain("delivery_start");
		expect(registration.state.callCount).toBe(1);
	});

	it("admits structured messages through the same stable prompt delivery", async () => {
		const prepared: AgentDelivery[] = [];
		const requestTexts: string[] = [];
		const { harness, registration } = createHarness({
			prepareDelivery: (delivery) => {
				prepared.push(delivery);
				return { messages: [...delivery.messages] };
			},
		});
		registration.setResponses([
			(context) => {
				requestTexts.push(...getUserTexts(context.messages as AgentMessage[]));
				return fauxAssistantMessage("done");
			},
		]);
		const message = { role: "user", content: "structured input", timestamp: Date.now() } as const;

		const result = await harness.run(message);

		expect(result).toMatchObject({ status: "completed", deliveries: [{ kind: "prompt", outcome: "committed" }] });
		expect(prepared).toHaveLength(1);
		expect(getUserTexts(prepared[0]!.messages)).toEqual(["structured input"]);
		expect(requestTexts).toEqual(["structured input"]);
	});

	it("retains an immutable attempt for explicit retry with the same delivery identity", async () => {
		const deliveryIds: string[] = [];
		const attemptedTexts: string[][] = [];
		let settlementCalls = 0;
		const session = new Session(new InMemorySessionStorage());
		const { harness, registration } = createHarness({
			session,
			prepareDelivery: (delivery) => {
				deliveryIds.push(delivery.deliveryId);
				attemptedTexts.push(getUserTexts(delivery.messages));
				const user = delivery.messages.find((message) => message.role === "user");
				if (settlementCalls === 0 && user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated attempt copy";
				}
				return {
					messages: [...delivery.messages],
					participant: {
						settle: async () => {
							settlementCalls++;
							if (settlementCalls === 1) {
								return { outcome: "retained", error: new Error("definitive rollback") };
							}
							for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
							return { outcome: "committed" };
						},
					},
				};
			},
		});
		registration.setResponses([() => fauxAssistantMessage("retried")]);

		const failed = await harness.runPrompt("immutable input");
		expect(failed).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement", error: { message: "definitive rollback" } },
		});
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(true);
		expect((await session.buildContext()).messages).toEqual([]);

		const retried = await harness.continue();
		expect(retried).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(new Set(deliveryIds)).toHaveLength(1);
		expect(attemptedTexts).toEqual([["immutable input"], ["immutable input"]]);
		expect(settlementCalls).toBe(2);
		expect(registration.state.callCount).toBe(1);
	});

	it("revokes a leased delivery while preparation is pending without settling its participant", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let deliveryId = "";
		let participantCalls = 0;
		const revoked: AgentDelivery[] = [];
		const { harness, session } = createHarness({
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
			deliveryRevoked: (delivery) => revoked.push(delivery),
		});

		const running = harness.runPrompt("revoke me");
		await preparationStarted.promise;
		expect(await harness.discardPendingPrompt()).toEqual([deliveryId]);
		releasePreparation.resolve();

		expect(await running).toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "revoked" }],
		});
		expect(participantCalls).toBe(0);
		expect(revoked).toHaveLength(1);
		expect(getUserTexts(revoked[0]!.messages)).toEqual(["revoke me"]);
		expect((await session.buildContext()).messages).toEqual([]);
	});

	it.each([
		{
			name: "an explicit terminal outcome",
			settle: () => ({ outcome: "terminally_failed" as const, error: new Error("durability ambiguous") }),
		},
		{
			name: "a rejected participant",
			settle: () => Promise.reject(new Error("participant crashed")),
		},
	])("terminally fences $name", async ({ settle }) => {
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => ({ messages: [...delivery.messages], participant: { settle } }),
		});
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		const result = await harness.runPrompt("unsafe retry");

		expect(result).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
		expect(harness.hasQueuedMessages()).toBe(false);
		expect(registration.state.callCount).toBe(0);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual([]);
	});

	it("preserves a committed FIFO prefix when a later participant retains", async () => {
		let retainSecond = true;
		const session = new Session(new InMemorySessionStorage());
		const { harness, registration } = createHarness({
			session,
			steeringMode: "all",
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						if (getUserTexts(delivery.messages).includes("second") && retainSecond) {
							return { outcome: "retained", error: new Error("retain second") };
						}
						for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
						return { outcome: "committed" };
					},
				},
			}),
		});
		registration.setResponses([() => fauxAssistantMessage("retried")]);
		let queued = false;
		harness.subscribe(async (event) => {
			if (event.type === "agent_start" && !queued) {
				queued = true;
				await harness.steer("first");
				await harness.steer("second");
			}
		});

		const failed = await harness.runPrompt("prompt");
		expect(failed).toMatchObject({
			status: "delivery_failed",
			deliveries: [{ outcome: "committed" }, { outcome: "committed" }, { outcome: "retained" }],
		});
		expect(registration.state.callCount).toBe(0);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["prompt", "first"]);
		expect(harness.hasQueuedMessages()).toBe(true);

		retainSecond = false;
		const retried = await harness.continue();
		expect(retried).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(registration.state.callCount).toBe(1);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual([
			"prompt",
			"first",
			"second",
		]);
	});

	it("treats committed delivery publication as cloned passive observation", async () => {
		const laterEvents: Array<{ type: string; texts: string[] }> = [];
		const session = new Session(new InMemorySessionStorage());
		const { harness, registration } = createHarness({
			session,
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
						return { outcome: "committed" };
					},
				},
			}),
		});
		let providerTexts: string[] = [];
		registration.setResponses([
			(context) => {
				providerTexts = getUserTexts(context.messages as AgentMessage[]);
				return fauxAssistantMessage("done");
			},
		]);
		harness.subscribe((event) => {
			if (
				(event.type === "delivery_start" || event.type === "message_start" || event.type === "message_end") &&
				"deliveryId" in event &&
				event.deliveryId
			) {
				const messages = event.type === "delivery_start" ? event.messages : [event.message];
				const user = messages.find((message) => message.role === "user");
				if (user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated observer snapshot";
				}
				throw new Error("delivery observer failed");
			}
		});
		harness.subscribe((event) => {
			if (
				(event.type === "delivery_start" || event.type === "message_start" || event.type === "message_end") &&
				"deliveryId" in event &&
				event.deliveryId
			) {
				laterEvents.push({
					type: event.type,
					texts: getUserTexts(event.type === "delivery_start" ? event.messages : [event.message]),
				});
			}
		});

		const result = await harness.runPrompt("authoritative input");

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(providerTexts).toEqual(["authoritative input"]);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["authoritative input"]);
		expect(laterEvents).toEqual([
			{ type: "delivery_start", texts: ["authoritative input"] },
			{ type: "message_start", texts: ["authoritative input"] },
			{ type: "message_end", texts: ["authoritative input"] },
		]);
	});

	it("persists participant-owned and Harness-owned deliveries exactly once", async () => {
		const participantSession = new Session(new InMemorySessionStorage());
		const participant = createHarness({
			session: participantSession,
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						for (const message of delivery.messages) {
							await participantSession.appendMessage(structuredClone(message));
						}
						return { outcome: "committed" };
					},
				},
			}),
		});
		participant.registration.setResponses([() => fauxAssistantMessage("done")]);
		await participant.harness.runPrompt("participant-owned");

		const harnessOwned = createHarness();
		harnessOwned.registration.setResponses([() => fauxAssistantMessage("done")]);
		await harnessOwned.harness.runPrompt("harness-owned");

		expect(getUserTexts((await participantSession.buildContext()).messages as AgentMessage[])).toEqual([
			"participant-owned",
		]);
		expect(getUserTexts((await harnessOwned.session.buildContext()).messages as AgentMessage[])).toEqual([
			"harness-owned",
		]);
	});

	it("continues provider and tool work without recommitting participant-owned input", async () => {
		let settlementCalls = 0;
		const session = new Session(new InMemorySessionStorage());
		const { harness, registration } = createHarness({
			session,
			tools: [calculateTool],
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						settlementCalls++;
						for (const message of delivery.messages) await session.appendMessage(structuredClone(message));
						return { outcome: "committed" };
					},
				},
			}),
		});
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);

		const result = await harness.runPrompt("use a tool");

		expect(result).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(registration.state.callCount).toBe(2);
		expect(settlementCalls).toBe(1);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["use a tool"]);
	});
});
