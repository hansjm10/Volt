import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function createUserMessage(text: string): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("regression #199: delivery transaction failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("awaits asynchronous commit durability before delivery publication", async () => {
		const commitStarted = deferred();
		const finishCommit = deferred();
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: async () => {
					commitStarted.resolve();
					await finishCommit.promise;
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("committed")]);
		let deliveryStarts = 0;
		harness.session.subscribe((event) => {
			if (event.type === "delivery_start") deliveryStarts++;
		});

		const prompt = harness.session.prompt("wait for durable commit");
		await commitStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(deliveryStarts).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		finishCommit.resolve();
		await prompt;
		expect(deliveryStarts).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns an explicit failure and retains a delivery after commit rejection", async () => {
		let commitAttempts = 0;
		let failCommit = true;
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				commit: async () => {
					commitAttempts++;
					await Promise.resolve();
					if (failCommit) throw new Error("asynchronous durability failure");
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("retried")]);

		const failedRun = await harness.session.agent.prompt(createUserMessage("retry after commit rejection"));

		expect(failedRun).toMatchObject({
			status: "delivery_failed",
			failure: {
				kind: "prompt",
				phase: "commit",
				error: expect.objectContaining({ message: "asynchronous durability failure" }),
			},
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).toEqual([]);

		failCommit = false;
		expect(await harness.session.agent.continue()).toEqual({ status: "completed" });

		expect(commitAttempts).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness)).toEqual(["retry after commit rejection"]);
	});

	it.each(["steer", "followUp", "host"] as const)(
		"bounds automatic continuation after a %s delivery commit fails",
		async (kind) => {
			let queuedCommitAttempts = 0;
			let harness!: Harness;
			harness = await createHarness({
				prepareDelivery: (delivery) => ({
					messages: [...delivery.messages],
					commit: () => {
						if (delivery.kind !== kind) return;
						queuedCommitAttempts++;
						throw new Error("persistent queued commit failure");
					},
				}),
			});
			harnesses.push(harness);
			harness.setResponses([
				() => {
					const queuedMessage = createUserMessage("retained queued input");
					if (kind === "steer") harness.session.agent.steer(queuedMessage);
					else if (kind === "followUp") harness.session.agent.followUp(queuedMessage);
					else harness.session.agent.hostDelivery(queuedMessage);
					return fauxAssistantMessage("initial response");
				},
			]);

			await harness.session.prompt("start one bounded run");

			expect(queuedCommitAttempts).toBe(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(
				harness.session.messages.filter(
					(message) => message.role === "assistant" && message.errorMessage === "persistent queued commit failure",
				),
			).toHaveLength(1);
		},
	);

	it.each(["dispose", "abort"] as const)(
		"rejects reentrant %s from an asynchronous commit instead of deadlocking",
		async (lifecycleOperation) => {
			let harness!: Harness;
			harness = await createHarness({
				prepareDelivery: (delivery) => ({
					messages: [...delivery.messages],
					commit: async () => {
						if (lifecycleOperation === "dispose") await harness.session.dispose("disposal");
						else await harness.session.abort();
					},
				}),
			});
			harnesses.push(harness);

			const result = await harness.session.agent.prompt(createUserMessage(`reject reentrant ${lifecycleOperation}`));

			expect(result).toMatchObject({
				status: "delivery_failed",
				failure: {
					phase: "commit",
					error: expect.objectContaining({
						message: expect.stringContaining(
							lifecycleOperation === "dispose" ? "Cannot dispose" : "Cannot await",
						),
					}),
				},
			});
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			await harness.session.dispose("disposal");
		},
	);

	it("drains pending host deliveries during disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.hostDelivery(createUserMessage("stale host delivery"));
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		await harness.session.dispose("disposal");

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});
