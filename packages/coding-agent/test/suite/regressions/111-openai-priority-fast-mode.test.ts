import { fauxAssistantMessage, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #111 OpenAI Priority fast mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates the persisted fast-mode policy to normal agent turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("fast"), fauxAssistantMessage("standard")]);

		const observed: Array<SimpleStreamOptions["inferenceSpeed"]> = [];
		const originalStreamFn = harness.control.getStreamFn();
		harness.control.setStreamFn((model, context, options) => {
			observed.push(options?.inferenceSpeed);
			return originalStreamFn(model, context, options);
		});
		const thinkingLevel = harness.session.thinkingLevel;

		await harness.session.setFastModeEnabled(true);
		expect(harness.control.getInferenceSpeed()).toBe("fast");
		await harness.session.prompt("use priority processing");

		await harness.session.setFastModeEnabled(false);
		expect(harness.control.getInferenceSpeed()).toBe("standard");
		await harness.session.prompt("use standard processing");

		expect(observed).toEqual(["fast", "standard"]);
		expect(harness.session.thinkingLevel).toBe(thinkingLevel);
	});
});
