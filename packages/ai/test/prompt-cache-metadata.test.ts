import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

describe("generated prompt-cache metadata", () => {
	it("captures direct Anthropic retention", () => {
		expect(getModel("anthropic", "claude-haiku-4-5").promptCache).toEqual({
			modes: ["explicit"],
			retention: { short: { ttlSeconds: 300 }, long: { ttlSeconds: 3600 } },
			refreshesOnHit: true,
		});
	});

	it("uses OpenAI model allowlists for extended and GPT-5.6 retention", () => {
		expect(getModel("openai", "gpt-4.1").promptCache?.retention.long).toEqual({ ttlSeconds: 86_400 });
		expect(getModel("openai", "gpt-4o-mini").promptCache).toEqual({
			modes: ["implicit"],
			retention: { short: {} },
		});
		expect(getModel("openai", "gpt-5.6-sol").promptCache).toEqual({
			modes: ["implicit", "explicit"],
			retention: { short: { ttlSeconds: 1800 } },
			refreshesOnHit: true,
		});
	});

	it("applies Azure policies after cloning OpenAI models", () => {
		expect(getModel("azure-openai-responses", "gpt-4.1").promptCache?.retention.long).toEqual({
			ttlSeconds: 86_400,
		});
		expect(getModel("azure-openai-responses", "gpt-5.6-sol").promptCache?.modes).toEqual(["implicit", "explicit"]);
	});

	it("distinguishes Bedrock short-only and long regional model IDs", () => {
		expect(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1").promptCache?.retention.long).toBeUndefined();
		expect(getModel("amazon-bedrock", "eu.anthropic.claude-opus-4-7").promptCache?.retention.long).toEqual({
			ttlSeconds: 3600,
		});
		expect(getModel("amazon-bedrock", "us.anthropic.claude-opus-5").promptCache).toBeUndefined();
	});

	it("captures established short caching with undocumented TTLs", () => {
		expect(getModel("mistral", "mistral-medium-3.5").promptCache).toEqual({
			modes: ["implicit"],
			retention: { short: {} },
		});
		expect(getModel("fireworks", "accounts/fireworks/models/kimi-k2p6").promptCache?.retention.short).toEqual({});
		expect(getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6").promptCache?.retention.short).toEqual({});
		expect(getModel("openai-codex", "gpt-5.4").promptCache?.retention.short).toEqual({});
	});

	it("leaves dynamically routed providers unknown", () => {
		expect(getModel("openrouter", "auto").promptCache).toBeUndefined();
		expect(getModel("opencode", "gpt-5.4").promptCache).toBeUndefined();
	});
});
