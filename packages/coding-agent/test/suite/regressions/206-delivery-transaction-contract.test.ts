import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createUserMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = harness.session.updatePlan({
		title: "Delivery transaction contract",
		summary: "Keep planning feedback in the delivery transaction.",
		steps: [{ text: "Apply the committed feedback" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

function checkpointCount(harness: Harness): number {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint").length;
}

function planningChangeCount(harness: Harness): number {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change").length;
}

describe("regression #206: coding-agent delivery transaction contract", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("settles an identified RPC prompt only after canonical client-input durability", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("durably admitted")]);
		const clientMessageId = "contract-direct-rpc";
		const canonicalFlushStarted = deferred();
		const releaseCanonicalFlush = deferred();
		const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
		let gatedCanonicalFlush = false;
		vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
			const watermark = originalFlush();
			if (!gatedCanonicalFlush && harness.sessionManager.getClientInput(clientMessageId)?.state === "completed") {
				gatedCanonicalFlush = true;
				canonicalFlushStarted.resolve();
				return watermark.then(() => releaseCanonicalFlush.promise);
			}
			return watermark;
		});
		const preflightResults: PromptPreflightResult[] = [];

		const prompt = harness.session.prompt("durable direct prompt", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await canonicalFlushStarted.promise;

		expect(preflightResults).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(
			harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.clientMessageId === clientMessageId,
				),
		).toHaveLength(1);

		releaseCanonicalFlush.resolve();
		await prompt;

		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.clientMessageId === clientMessageId,
				),
		).toHaveLength(1);
	});

	it.each(["steer", "followUp"] as const)(
		"settles identified %s from durable queue admission through one canonical message",
		async (kind) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const clientMessageId = `contract-${kind}`;
			const text = `${kind} delivery`;
			harness.setResponses([fauxAssistantMessage(`${kind} committed`)]);

			if (kind === "steer") await harness.session.steer(text, undefined, clientMessageId);
			else await harness.session.followUp(text, undefined, clientMessageId);

			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({
				state: "accepted",
				queuedInput: { delivery: kind === "steer" ? "steer" : "follow_up", message: text },
			});
			expect(getUserTexts(harness)).toEqual([]);

			await harness.session.agent.continue();

			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(harness)).toEqual([text]);
			expect(
				harness.sessionManager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.clientMessageId === clientMessageId,
					),
			).toHaveLength(1);
		},
	);

	it("retains a direct delivery after preparation failure and commits it on explicit retry", async () => {
		let failPreparation = true;
		const preparedDeliveryIds: string[] = [];
		const harness = await createHarness({
			prepareDelivery: (delivery) => {
				preparedDeliveryIds.push(delivery.deliveryId);
				if (failPreparation) throw new Error("injected preparation failure");
				return { messages: [...delivery.messages] };
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("explicit retry committed")]);

		await harness.session.agent.prompt(createUserMessage("retain direct prompt"));

		expect(harness.session.agent.state.errorMessage).toBe("injected preparation failure");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		failPreparation = false;
		await harness.session.agent.continue();

		expect(new Set(preparedDeliveryIds)).toHaveLength(1);
		expect(getUserTexts(harness)).toEqual(["retain direct prompt"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"settles a failed %s attempt while retaining its accepted client input for explicit retry",
		async (kind) => {
			let failPreparation = true;
			const preparedDeliveryIds: string[] = [];
			const harness = await createHarness({
				prepareDelivery: (delivery) => {
					preparedDeliveryIds.push(delivery.deliveryId);
					if (failPreparation && delivery.kind === kind) {
						throw new Error(`injected ${kind} preparation failure`);
					}
					return { messages: [...delivery.messages] };
				},
			});
			harnesses.push(harness);
			const clientMessageId = `contract-retained-${kind}`;
			const text = `retained ${kind}`;
			harness.setResponses([fauxAssistantMessage("retained input committed")]);

			if (kind === "steer") await harness.session.steer(text, undefined, clientMessageId);
			else await harness.session.followUp(text, undefined, clientMessageId);
			await expect(harness.session.agent.continue()).resolves.toMatchObject({
				status: "delivery_failed",
				failure: { kind, outcome: "retained", phase: "preparation" },
			});

			expect(harness.session.agent.state.errorMessage).toBe(`injected ${kind} preparation failure`);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);

			failPreparation = false;
			await harness.session.agent.continue();

			expect(new Set(preparedDeliveryIds)).toHaveLength(1);
			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(harness)).toEqual([text]);
		},
	);

	it("keeps transcript and planning unchanged when planning commit rejects synchronously, then discards explicitly", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		const clientMessageId = "contract-durability-discard";
		const checkpointBaseline = checkpointCount(harness);
		const planningBaseline = planningChangeCount(harness);
		const outcomes: object[] = [];
		const appendPlanningState = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendPlanningState").mockImplementation((planning) => {
			if (planning.plan?.phase === "draft") {
				throw new Error("injected planning commit failure");
			}
			return appendPlanningState(planning);
		});
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") outcomes.push(event);
		});
		await harness.session.steer("discard retained feedback", undefined, clientMessageId);

		await expect(harness.session.agent.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});

		expect(harness.session.agent.state.errorMessage).toBe("injected planning commit failure");
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(planningChangeCount(harness)).toBe(planningBaseline);
		expect(checkpointCount(harness)).toBe(checkpointBaseline);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);

		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["discard retained feedback"],
			followUp: [],
		});
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "failed" });
		expect(outcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId,
				outcome: "failed",
				reason: "queue_cleared",
			},
		]);
	});

	it("lets an external abort win before commit without revoking retained feedback", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const harness = await createHarness({
			prepareDelivery: async (delivery) => {
				if (delivery.kind === "steer") {
					preparationStarted.resolve();
					await releasePreparation.promise;
				}
				return { messages: [...delivery.messages] };
			},
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		const clientMessageId = "contract-abort-before-commit";
		const checkpointBaseline = checkpointCount(harness);
		await harness.session.steer("retain after external abort", undefined, clientMessageId);

		const attempt = harness.session.agent.continue();
		await preparationStarted.promise;
		const abort = harness.session.abort("remote_request");
		releasePreparation.resolve();
		await Promise.all([attempt, abort]);

		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(checkpointCount(harness)).toBe(checkpointBaseline);
		expect(getUserTexts(harness)).toEqual([]);

		await harness.session.clearQueue();
	});

	it("preserves the committed winner when external abort races canonical durability", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "contract-abort-during-durability";
		const canonicalFlushStarted = deferred();
		const releaseCanonicalFlush = deferred();
		const originalFlush = harness.sessionManager.flush.bind(harness.sessionManager);
		let gatedCanonicalFlush = false;
		vi.spyOn(harness.sessionManager, "flush").mockImplementation(() => {
			const watermark = originalFlush();
			if (!gatedCanonicalFlush && harness.sessionManager.getClientInput(clientMessageId)?.state === "completed") {
				gatedCanonicalFlush = true;
				canonicalFlushStarted.resolve();
				return watermark.then(() => releaseCanonicalFlush.promise);
			}
			return watermark;
		});
		const preflightResults: PromptPreflightResult[] = [];

		const prompt = harness.session.prompt("commit before external abort", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await canonicalFlushStarted.promise;
		const abort = harness.session.abort("remote_request");
		expect(preflightResults).toEqual([]);
		releaseCanonicalFlush.resolve();
		await Promise.all([prompt, abort]);

		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(getUserTexts(harness)).toEqual(["commit before external abort"]);
		expect(checkpointCount(harness)).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("preserves delivery and planning state when disposal is requested during participant settlement", async () => {
		let harness!: Harness;
		let disposal: Promise<void> | undefined;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						disposal = harness.session.dispose("disposal");
						return { outcome: "committed" };
					},
				},
			}),
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "contract-reentrant-dispose";

		await harness.session.prompt("commit before reentrant disposal", { clientMessageId });
		await disposal;

		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(checkpointCount(harness)).toBe(1);
		expect(getUserTexts(harness)).toEqual(["commit before reentrant disposal"]);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "assistant" && message.stopReason === "aborted"),
		).toHaveLength(1);
	});

	it("commits one ready-to-draft transition and checkpoint for an all-mode batch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.setSteeringMode("all");
		const planningBaseline = planningChangeCount(harness);
		const checkpointBaseline = checkpointCount(harness);
		harness.setResponses([fauxAssistantMessage("batch committed")]);

		await harness.session.steer("first batch feedback", undefined, "contract-batch-first");
		await harness.session.steer("second batch feedback", undefined, "contract-batch-second");
		await harness.session.agent.continue();

		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(getUserTexts(harness)).toEqual(["first batch feedback", "second batch feedback"]);
		expect(harness.sessionManager.getClientInput("contract-batch-first")).toMatchObject({ state: "completed" });
		expect(harness.sessionManager.getClientInput("contract-batch-second")).toMatchObject({ state: "completed" });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("preserves a committed all-mode prefix when a later delivery is retained", async () => {
		let failSecondCommit = true;
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						if (
							failSecondCommit &&
							delivery.messages.some(
								(message) =>
									message.role === "user" &&
									JSON.stringify(message.content).includes("second partial feedback"),
							)
						) {
							return { outcome: "retained", error: new Error("injected second delivery settlement failure") };
						}
						return { outcome: "committed" };
					},
				},
			}),
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.setSteeringMode("all");
		const planningBaseline = planningChangeCount(harness);
		const checkpointBaseline = checkpointCount(harness);
		harness.setResponses([fauxAssistantMessage("retained suffix committed")]);

		await harness.session.steer("first partial feedback", undefined, "contract-partial-first");
		await harness.session.steer("second partial feedback", undefined, "contract-partial-second");
		await harness.session.agent.continue();

		expect(getUserTexts(harness)).toEqual(["first partial feedback"]);
		expect(harness.sessionManager.getClientInput("contract-partial-first")).toMatchObject({ state: "completed" });
		expect(harness.sessionManager.getClientInput("contract-partial-second")).toMatchObject({ state: "accepted" });
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(harness.getPendingResponseCount()).toBe(1);

		failSecondCommit = false;
		await harness.session.agent.continue();

		expect(getUserTexts(harness)).toEqual(["first partial feedback", "second partial feedback"]);
		expect(harness.sessionManager.getClientInput("contract-partial-second")).toMatchObject({ state: "completed" });
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	// Participant-level acceptance remains covered by Agent; these cases pin
	// coding-agent's persistence, planning, and client-input integration.
});
