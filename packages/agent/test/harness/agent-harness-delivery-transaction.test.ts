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
	it("awaits preparation and participant settlement before publishing or invoking the provider", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		const events: string[] = [];
		let deliveryId = "";
		const { harness, registration } = createHarness({
			prepareDelivery: async (delivery, signal) => {
				deliveryId = delivery.deliveryId;
				expect(signal?.aborted).toBe(false);
				preparationStarted.resolve();
				await releasePreparation.promise;
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
		});
		registration.setResponses([() => fauxAssistantMessage("done")]);
		harness.subscribe((event) => {
			events.push(event.type);
		});

		const prompting = harness.runPrompt("transactional prompt");
		await preparationStarted.promise;
		expect(harness.canPrepareDelivery(deliveryId)).toBe(true);
		expect(events).toEqual(["agent_start"]);
		expect(registration.state.callCount).toBe(0);
		releasePreparation.resolve();

		await settlementStarted.promise;
		expect(harness.canPrepareDelivery(deliveryId)).toBe(false);
		expect(await harness.discardPendingPrompt()).toEqual([]);
		expect(events).toEqual(["agent_start"]);
		expect(registration.state.callCount).toBe(0);
		releaseSettlement.resolve();

		const result = await prompting;
		expect(result).toMatchObject({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "committed" }],
			response: { role: "assistant", content: [{ type: "text", text: "done" }] },
		});
		expect(events).toContain("delivery_start");
		expect(registration.state.callCount).toBe(1);
	});

	it("binds next-turn and before-start additions into one stable prompt delivery", async () => {
		const prepared: AgentDelivery[] = [];
		const deliveryEvents: Array<{ deliveryId: string | undefined; texts: string[] }> = [];
		const { harness, registration } = createHarness({
			prepareDelivery: (delivery) => {
				prepared.push(delivery);
				return { messages: [...delivery.messages] };
			},
		});
		registration.setResponses([() => fauxAssistantMessage("done")]);
		await harness.nextTurn("next-turn context");
		harness.on("before_agent_start", () => ({
			messages: [{ role: "user", content: "hook context", timestamp: Date.now() }],
		}));
		harness.subscribe((event) => {
			if (event.type === "delivery_start") {
				deliveryEvents.push({ deliveryId: event.deliveryId, texts: getUserTexts(event.messages) });
			}
		});

		const result = await harness.runPrompt("prompt");

		expect(prepared).toHaveLength(1);
		expect(prepared[0]).toMatchObject({ kind: "prompt" });
		expect(getUserTexts(prepared[0]!.messages)).toEqual(["next-turn context", "prompt", "hook context"]);
		expect(deliveryEvents).toEqual([
			{ deliveryId: prepared[0]!.deliveryId, texts: ["next-turn context", "prompt", "hook context"] },
		]);
		expect(result.deliveries).toEqual([
			{ deliveryId: prepared[0]!.deliveryId, kind: "prompt", outcome: "committed" },
		]);
	});

	it("retains a rolled-back delivery for explicit continuation with the same identity and no implicit retry", async () => {
		const deliveryIds: string[] = [];
		let settlementCalls = 0;
		const { harness, registration, session } = createHarness({
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
		});
		registration.setResponses([() => fauxAssistantMessage("retried")]);

		const failed = await harness.runPrompt("retry me");
		expect(failed).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement", error: { message: "definitive rollback" } },
			response: undefined,
		});
		expect(settlementCalls).toBe(1);
		expect(registration.state.callCount).toBe(0);
		expect(harness.hasPendingPrompt()).toBe(true);
		expect((await session.buildContext()).messages).toEqual([]);

		const retried = await harness.continue();
		expect(retried).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(new Set(deliveryIds)).toHaveLength(1);
		expect(settlementCalls).toBe(2);
		expect(registration.state.callCount).toBe(1);
		expect(harness.hasQueuedMessages()).toBe(false);
	});

	it("reports preparation failure as retained without leaking input or invoking a participant", async () => {
		let failPreparation = true;
		let participantCalls = 0;
		const attemptedTexts: string[][] = [];
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => {
				attemptedTexts.push(getUserTexts(delivery.messages));
				const user = delivery.messages.find((message) => message.role === "user");
				if (failPreparation && user?.role === "user" && Array.isArray(user.content)) {
					const text = user.content.find((content) => content.type === "text");
					if (text?.type === "text") text.text = "mutated attempt";
					throw new Error("preparation failed");
				}
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
		registration.setResponses([() => fauxAssistantMessage("done")]);

		const failed = await harness.runPrompt("immutable input");
		expect(failed).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "preparation", error: { message: "preparation failed" } },
			response: undefined,
		});
		expect(participantCalls).toBe(0);
		expect(registration.state.callCount).toBe(0);
		expect((await session.buildContext()).messages).toEqual([]);

		failPreparation = false;
		await harness.continue();
		expect(attemptedTexts).toEqual([["immutable input"], ["immutable input"]]);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["immutable input"]);
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
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => ({ messages: [...delivery.messages], participant: { settle } }),
		});
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		const result = await harness.runPrompt("unsafe retry");

		expect(result).toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
			response: { role: "assistant", stopReason: "error" },
		});
		expect(harness.hasQueuedMessages()).toBe(false);
		expect(registration.state.callCount).toBe(0);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual([]);
	});

	it("revokes a delivery while preparation is pending and never invokes its participant", async () => {
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

		const prompting = harness.runPrompt("revoke me");
		await preparationStarted.promise;
		expect(await harness.discardPendingPrompt()).toEqual([deliveryId]);
		releasePreparation.resolve();

		expect(await prompting).toEqual({
			status: "completed",
			deliveries: [{ deliveryId, kind: "prompt", outcome: "revoked" }],
			response: undefined,
		});
		expect(participantCalls).toBe(0);
		expect(revoked).toHaveLength(1);
		expect(revoked[0]).not.toBeUndefined();
		expect(getUserTexts(revoked[0]!.messages)).toEqual(["revoke me"]);
		expect((await session.buildContext()).messages).toEqual([]);
	});

	it("lets abort retain revocable work but preserves a committed settlement winner", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		let participantCalls = 0;
		const first = createHarness({
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
		const prompting = first.harness.runPrompt("retain before commit");
		await preparationStarted.promise;
		const aborting = first.harness.abort("remote_request");
		releasePreparation.resolve();
		const [retained] = await Promise.all([prompting, aborting]);
		expect(retained).toMatchObject({
			status: "completed",
			deliveries: [{ outcome: "retained" }],
			response: undefined,
		});
		expect(participantCalls).toBe(0);
		expect(first.harness.hasPendingPrompt()).toBe(true);
		expect((await first.session.buildContext()).messages).toEqual([]);

		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		const second = createHarness({
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
		});
		second.registration.setResponses([() => fauxAssistantMessage("unexpected")]);
		const committing = second.harness.runPrompt("commit before abort");
		await settlementStarted.promise;
		const abortCommitted = second.harness.abort("remote_request");
		releaseSettlement.resolve();
		const [committed] = await Promise.all([committing, abortCommitted]);
		expect(committed).toMatchObject({
			status: "completed",
			deliveries: [{ outcome: "committed" }],
			response: { role: "assistant", stopReason: "aborted" },
		});
		expect(second.registration.state.callCount).toBe(0);
		expect(getUserTexts((await second.session.buildContext()).messages as AgentMessage[])).toEqual([
			"commit before abort",
		]);
	});

	it("accepts reentrant abort synchronously with a stable run ID and first-source authority", async () => {
		const acceptances: Array<{ runId: string | undefined; accepted: boolean; source: string | undefined }> = [];
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: (context) => {
						acceptances.push(context.requestAbort("host_action"));
						acceptances.push(context.requestAbort("disposal"));
						return { outcome: "committed" };
					},
				},
			}),
		});
		registration.setResponses([() => fauxAssistantMessage("unexpected")]);

		const result = await harness.runPrompt("commit reentrantly");

		expect(acceptances).toHaveLength(2);
		expect(acceptances[0]).toMatchObject({ accepted: true, source: "host_action" });
		expect(acceptances[1]).toEqual(acceptances[0]);
		expect(acceptances[0]!.runId).toEqual(expect.any(String));
		expect(result).toMatchObject({ deliveries: [{ outcome: "committed" }], response: { stopReason: "aborted" } });
		expect(registration.state.callCount).toBe(0);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["commit reentrantly"]);
	});

	it("preserves a committed FIFO prefix when a later participant retains", async () => {
		let retainSecond = true;
		let settlementCalls = 0;
		const { harness, registration, session } = createHarness({
			steeringMode: "all",
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						settlementCalls++;
						return getUserTexts(delivery.messages).includes("second") && retainSecond
							? { outcome: "retained", error: new Error("retain second") }
							: { outcome: "committed" };
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
			deliveries: [{ kind: "prompt", outcome: "committed" }, { outcome: "committed" }, { outcome: "retained" }],
			response: { role: "assistant", stopReason: "error" },
		});
		expect(settlementCalls).toBe(3);
		expect(registration.state.callCount).toBe(0);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual(["prompt", "first"]);
		expect(harness.hasQueuedMessages()).toBe(true);

		retainSecond = false;
		const retried = await harness.continue();
		expect(retried).toMatchObject({ status: "completed", deliveries: [{ outcome: "committed" }] });
		expect(settlementCalls).toBe(4);
		expect(registration.state.callCount).toBe(1);
		expect(getUserTexts((await session.buildContext()).messages as AgentMessage[])).toEqual([
			"prompt",
			"first",
			"second",
		]);
	});

	it("isolates immutable committed delivery and queue projections from failing observers", async () => {
		const laterEvents: Array<{ type: string; texts: string[] }> = [];
		const { harness, registration, session } = createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						const user = delivery.messages.find((message) => message.role === "user");
						if (user?.role === "user" && Array.isArray(user.content)) {
							const text = user.content.find((content) => content.type === "text");
							if (text?.type === "text") text.text = "mutated after preparation";
						}
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
			if (event.type === "queue_update" && event.steer.length === 0) throw new Error("queue observer failed");
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

	it("does not recommit input while continuing after a tool result", async () => {
		let settlementCalls = 0;
		const { harness, registration } = createHarness({
			tools: [calculateTool],
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						settlementCalls++;
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
	});
});
