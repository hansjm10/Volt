import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { getFastInferenceServiceTier, supportsFastInference } from "../src/providers/openai-fast-inference.ts";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, ServiceTier } from "../src/types.ts";

const context: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

afterEach(() => {
	vi.restoreAllMocks();
});

function completedSSE(serviceTier: ServiceTier): string {
	return `${[
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				service_tier: serviceTier,
				usage: {
					input_tokens: 2_000_000,
					output_tokens: 1_000_000,
					total_tokens: 3_000_000,
					input_tokens_details: { cached_tokens: 1_000_000 },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
}

function mockSSE(serviceTier: ServiceTier): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(completedSSE(serviceTier), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
}

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

describe("OpenAI fast inference eligibility", () => {
	it("requires a supported model on a canonical OpenAI endpoint", () => {
		const astra = getModel("openai", "gpt-6-astra");
		const codexAstra = getModel("openai-codex", "gpt-6-astra");
		const canonical = getModel("openai", "gpt-5.6");
		const direct = getModel("openai", "gpt-5.4");
		const codex = getModel("openai-codex", "gpt-5.4");

		expect(supportsFastInference(astra)).toBe(true);
		expect(supportsFastInference(codexAstra)).toBe(true);
		expect(supportsFastInference(canonical)).toBe(true);
		expect(supportsFastInference(direct)).toBe(true);
		expect(supportsFastInference(codex)).toBe(true);
		expect(supportsFastInference({ ...direct, id: "gpt-5.4-pro" })).toBe(false);
		expect(supportsFastInference({ ...direct, baseUrl: "https://gateway.example/v1" })).toBe(false);
		expect(supportsFastInference({ ...direct, provider: "github-copilot" })).toBe(false);
	});

	it("maps only eligible models to explicit default or priority tiers", () => {
		const model = getModel("openai", "gpt-5.4");

		expect(getFastInferenceServiceTier(model, "fast")).toBe("priority");
		expect(getFastInferenceServiceTier(model, "standard")).toBe("default");
		expect(getFastInferenceServiceTier(model, undefined)).toBeUndefined();
		expect(getFastInferenceServiceTier({ ...model, baseUrl: "https://gateway.example/v1" }, "fast")).toBeUndefined();
	});
});

describe("OpenAI Responses fast inference", () => {
	it("sends priority and applies the GPT-6 Astra rates", async () => {
		const model = getModel("openai", "gpt-6-astra");
		let payload: { service_tier?: string } | undefined;
		mockSSE("priority");

		const result = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-key",
			inferenceSpeed: "fast",
			onPayload: (value) => {
				payload = value as { service_tier?: string };
			},
		}).result();

		expect(payload?.service_tier).toBe("priority");
		expect(result.usage.serviceTier).toEqual({ requested: "priority", effective: "priority" });
		expect(result.usage.cost).toEqual({ input: 20, output: 100, cacheRead: 2, cacheWrite: 0, total: 122 });
	});

	it("sends priority and applies the canonical GPT-5.6 rates", async () => {
		const model = getModel("openai", "gpt-5.6");
		let payload: { service_tier?: string } | undefined;
		mockSSE("priority");

		const result = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-key",
			inferenceSpeed: "fast",
			onPayload: (value) => {
				payload = value as { service_tier?: string };
			},
		}).result();

		expect(payload?.service_tier).toBe("priority");
		expect(result.usage.serviceTier).toEqual({ requested: "priority", effective: "priority" });
		expect(result.usage.cost).toEqual({ input: 10, output: 60, cacheRead: 1, cacheWrite: 0, total: 71 });
	});

	it("sends priority and applies the published direct OpenAI rates", async () => {
		const model = getModel("openai", "gpt-5-mini");
		let payload: { service_tier?: string } | undefined;
		mockSSE("priority");

		const result = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-key",
			inferenceSpeed: "fast",
			onPayload: (value) => {
				payload = value as { service_tier?: string };
			},
		}).result();

		expect(payload?.service_tier).toBe("priority");
		expect(result.usage.serviceTier).toEqual({ requested: "priority", effective: "priority" });
		expect(result.usage.cost).toEqual({ input: 0.45, output: 3.6, cacheRead: 0.045, cacheWrite: 0, total: 4.095 });
	});

	it("records a priority request downgrade and charges the effective default tier", async () => {
		const model = getModel("openai", "gpt-5-mini");
		mockSSE("default");

		const result = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-key",
			inferenceSpeed: "fast",
		}).result();

		expect(result.usage.serviceTier).toEqual({ requested: "priority", effective: "default" });
		expect(result.usage.cost).toEqual({
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: 0,
			total: model.cost.input + model.cost.output + model.cost.cacheRead,
		});
	});

	it("sends default when fast mode is off", async () => {
		const model = getModel("openai", "gpt-5.4");
		let payload: { service_tier?: string } | undefined;
		mockSSE("default");

		const result = await streamSimpleOpenAIResponses(model, context, {
			apiKey: "test-key",
			inferenceSpeed: "standard",
			onPayload: (value) => {
				payload = value as { service_tier?: string };
			},
		}).result();

		expect(payload?.service_tier).toBe("default");
		expect(result.usage.serviceTier).toEqual({ requested: "default", effective: "default" });
	});
});

describe("OpenAI Codex fast inference", () => {
	it("sends priority while preserving the raw effective service tier", async () => {
		const model = getModel("openai-codex", "gpt-5.4");
		let payload: { service_tier?: string } | undefined;
		mockSSE("default");

		const result = await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			inferenceSpeed: "fast",
			transport: "sse",
			onPayload: (value) => {
				payload = value as { service_tier?: string };
			},
		}).result();

		expect(payload?.service_tier).toBe("priority");
		expect(result.usage.serviceTier).toEqual({ requested: "priority", effective: "default" });
		expect(result.usage.cost.input).toBe(model.cost.input * 2);
		expect(result.usage.cost.output).toBe(model.cost.output * 2);
		expect(result.usage.cost.cacheRead).toBe(model.cost.cacheRead * 2);
	});
});
