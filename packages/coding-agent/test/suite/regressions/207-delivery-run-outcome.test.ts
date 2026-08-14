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
		await harness?.session.dispose();
		harness?.cleanup();
		harness = undefined;
	});

	it("does not automatically retry a retained delivery after the run settles", async () => {
		let failPreparation = true;
		let preparationAttempts = 0;
		harness = await createHarness({
			prepareDelivery: (delivery) => {
				preparationAttempts++;
				if (failPreparation) throw new Error("injected retained attempt");
				return { messages: [...delivery.messages] };
			},
		});
		harness.setResponses([fauxAssistantMessage("explicit retry completed")]);

		await expect(harness.session.prompt("bounded retained prompt")).resolves.toBeUndefined();

		expect(preparationAttempts).toBe(1);
		expect(harness.session.state.errorMessage).toBe("injected retained attempt");
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		failPreparation = false;
		await harness.control.continue();

		expect(preparationAttempts).toBe(2);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["bounded retained prompt"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("settles an active provider retry when a queued delivery is retained", async () => {
		let failDelivery = true;
		const retryStarted = deferred();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		const retryDecisions: boolean[] = [];
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } },
			prepareDelivery: (delivery) => {
				if (failDelivery && delivery.kind === "steer") {
					throw new Error("retained during provider retry");
				}
				return { messages: [...delivery.messages] };
			},
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
