import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness as createSuiteHarness } from "./suite/harness.ts";
import { createHarness } from "./test-harness.ts";
import { createTestSession } from "./utilities.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("test factory system prompts", () => {
	it("forwards explicit prompts through the general harness resource loader", async () => {
		const harness = createHarness({
			systemPrompt: "GENERAL_PROMPT_SENTINEL",
			responses: ["ok"],
		});
		cleanups.push(harness.cleanup);

		await harness.session.prompt("hello");

		expect(harness.faux.contexts[0]?.systemPrompt).toContain("GENERAL_PROMPT_SENTINEL");
	});

	it("forwards explicit prompts through the suite harness resource loader", async () => {
		let capturedPrompt: string | undefined;
		const harness = await createSuiteHarness({ systemPrompt: "SUITE_PROMPT_SENTINEL" });
		cleanups.push(harness.cleanup);
		harness.setResponses([
			(context) => {
				capturedPrompt = context.systemPrompt;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("hello");

		expect(capturedPrompt).toContain("SUITE_PROMPT_SENTINEL");
	});

	it("forwards explicit and default prompts through createTestSession resources", () => {
		const explicit = createTestSession({ inMemory: true, systemPrompt: "UTILITY_PROMPT_SENTINEL" });
		cleanups.push(explicit.cleanup);
		const defaults = createTestSession({ inMemory: true });
		cleanups.push(defaults.cleanup);

		expect(explicit.session.systemPrompt).toContain("UTILITY_PROMPT_SENTINEL");
		expect(defaults.session.systemPrompt).toContain("You are a test assistant.");
	});
});
