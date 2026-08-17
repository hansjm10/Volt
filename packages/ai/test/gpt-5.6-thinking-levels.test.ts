import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";

describe("GPT-5.6 thinking level metadata", () => {
	it("clamps minimal to low for the direct OpenAI GPT-5.6 alias", () => {
		const model = getModel("openai", "gpt-5.6");

		expect(model.thinkingLevelMap).toMatchObject({
			off: "none",
			minimal: null,
			xhigh: "xhigh",
			max: "max",
		});
		expect(getSupportedThinkingLevels(model)).not.toContain("minimal");
		expect(clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("keeps the Codex GPT-5.6 Sol metadata", () => {
		const model = getModel("openai-codex", "gpt-5.6-sol");

		expect(model.contextWindow).toBe(1_000_000);
		expect(model.thinkingLevelMap?.minimal).toBe("low");
		expect(clampThinkingLevel(model, "minimal")).toBe("minimal");
	});
});
