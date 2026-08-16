import { describe, expect, it } from "vitest";
import { calculateCost } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "tiered-model",
	name: "Tiered Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 5,
		output: 10,
		cacheRead: 0.5,
		cacheWrite: 6,
		tiers: [
			{ inputTokensAbove: 400000, input: 20, output: 40, cacheRead: 2, cacheWrite: 24 },
			{ inputTokensAbove: 272000, input: 10, output: 20, cacheRead: 1, cacheWrite: 12 },
		],
	},
	contextWindow: 1000000,
	maxTokens: 128000,
};

function createUsage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 100000,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 100000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("calculateCost pricing tiers", () => {
	it("uses base rates at the threshold", () => {
		const cost = calculateCost(model, createUsage(200000, 72000, 0));

		expect(cost).toMatchObject({ input: 1, output: 1, cacheRead: 0.036, cacheWrite: 0 });
	});

	it("applies the highest matching tier to the full request", () => {
		const cost = calculateCost(model, createUsage(300000, 100000, 1));

		expect(cost.input).toBeCloseTo(6, 10);
		expect(cost.output).toBeCloseTo(4, 10);
		expect(cost.cacheRead).toBeCloseTo(0.2, 10);
		expect(cost.cacheWrite).toBeCloseTo(0.000024, 10);
	});
});
