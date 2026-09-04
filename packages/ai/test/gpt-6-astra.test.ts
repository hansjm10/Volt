import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";

describe("GPT-6 Astra model metadata", () => {
	it("exposes the documented OpenAI API capabilities and pricing", () => {
		const model = getModel("openai", "gpt-6-astra");

		expect(model).toMatchObject({
			name: "GPT-6 Astra",
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		expect(model.promptCache).toEqual({
			modes: ["implicit", "explicit"],
			retention: { short: { ttlSeconds: 1_800 } },
			refreshesOnHit: true,
		});
	});

	it.each(["openai", "azure-openai-responses", "openai-codex"] as const)(
		"supports only documented reasoning levels through %s",
		(provider) => {
			const model = getModel(provider, "gpt-6-astra");

			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
			expect(clampThinkingLevel(model, "off")).toBe("low");
			expect(clampThinkingLevel(model, "minimal")).toBe("low");
		},
	);
});
