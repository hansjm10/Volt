import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("regression #207: delivery run outcomes", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("does not automatically retry a retained delivery after the run settles", async () => {
		let retainSettlement = true;
		let preparationAttempts = 0;
		let settlementAttempts = 0;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				preparationAttempts++;
				return {
					messages: [...delivery.messages],
					participant: {
						settle: () => {
							settlementAttempts++;
							return retainSettlement
								? { outcome: "retained", error: new Error("injected retained attempt") }
								: { outcome: "committed" };
						},
					},
				};
			},
		});
		harness.setResponses([fauxAssistantMessage("explicit retry completed")]);

		await expect(harness.session.prompt("bounded retained prompt")).resolves.toBeUndefined();

		expect(preparationAttempts).toBe(1);
		expect(settlementAttempts).toBe(1);
		expect(harness.session.state.errorMessage).toBe("injected retained attempt");
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		retainSettlement = false;
		await harness.control.continue();

		expect(preparationAttempts).toBe(1);
		expect(settlementAttempts).toBe(2);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["bounded retained prompt"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not classify an ambiguous delivery failure as a transient provider retry", async () => {
		const retryDecisions: boolean[] = [];
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => ({ outcome: "terminally_failed", error: new Error("overloaded_error") }),
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage("unexpected provider retry")]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") retryDecisions.push(event.willRetry);
		});

		await expect(harness.session.prompt("ambiguous delivery")).resolves.toBeUndefined();

		expect(retryDecisions).toEqual([false]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			diagnostics: [{ type: "delivery_transaction_failure" }],
		});
	});

	it("settles an active provider retry when a queued delivery is retained", async () => {
		let failDelivery = true;
		const retryStarted = deferred();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		const retryDecisions: boolean[] = [];
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } },
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () =>
						failDelivery && delivery.kind === "steer"
							? { outcome: "retained", error: new Error("retained during provider retry") }
							: { outcome: "committed" },
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("explicit retry completed"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") retryDecisions.push(event.willRetry);
			if (event.type === "auto_retry_start") retryStarted.resolve();
			if (event.type === "auto_retry_end") {
				retryEnds.push({ success: event.success, ...(event.finalError ? { finalError: event.finalError } : {}) });
			}
		});

		const prompt = harness.session.prompt("provider retry origin");
		await retryStarted.promise;
		await harness.session.steer("retained retry input");
		await prompt;

		expect(retryEnds).toEqual([{ success: false, finalError: "retained during provider retry" }]);
		expect(retryDecisions).toEqual([true, false]);
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);

		failDelivery = false;
		await harness.control.continue();

		expect(retryEnds).toEqual([{ success: false, finalError: "retained during provider retry" }]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
