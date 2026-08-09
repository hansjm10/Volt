import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";

const tiers = [
	{
		inputTokensAbove: 272000,
		input: 10,
		output: 20,
		cacheRead: 1,
		cacheWrite: 12,
	},
];

describe("model cost pricing tiers", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-model-cost-tiers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		clearApiKeyCache();
	});

	it("loads tiers for custom models and model overrides", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://example.com/v1",
						apiKey: "test-key",
						api: "openai-responses",
						models: [
							{
								id: "tiered-model",
								cost: { input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6, tiers },
							},
						],
					},
					openai: {
						modelOverrides: {
							"gpt-5.4": { cost: { tiers } },
						},
					},
				},
			}),
		);

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("custom", "tiered-model")?.cost.tiers).toEqual(tiers);
		expect(registry.find("openai", "gpt-5.4")?.cost.tiers).toEqual(tiers);
	});

	it("preserves tiers from extension-registered providers", () => {
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("extension-provider", {
			baseUrl: "https://example.com/v1",
			apiKey: "test-key",
			api: "openai-responses",
			models: [
				{
					id: "tiered-model",
					name: "Tiered Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6, tiers },
					contextWindow: 1000000,
					maxTokens: 128000,
				},
			],
		});

		expect(registry.find("extension-provider", "tiered-model")?.cost.tiers).toEqual(tiers);
	});
});
