import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #124: transient outage retry budget", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("recovers after four consecutive transient failures with default max retries", async () => {
		harness = await createHarness({ settings: { retry: { baseDelayMs: 1 } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("continue the task");

		expect(harness.faux.state.callCount).toBe(5);
		expect(
			harness.eventsOfType("auto_retry_start").map(({ attempt, maxAttempts }) => [attempt, maxAttempts]),
		).toEqual([
			[1, 6],
			[2, 6],
			[3, 6],
			[4, 6],
		]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});
});
