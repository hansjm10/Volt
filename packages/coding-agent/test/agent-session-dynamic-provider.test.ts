import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAgentSessionTestControl } from "./agent-session-test-control.ts";

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		createAgentSessionTestControl(session).setStreamFn(async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		});
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(volt) => {
				volt.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("selects a valid top-level provider while diagnosing an earlier invalid registration", async () => {
		const provider = "initial-extension-provider";
		const modelId = "initial-extension-model";
		const settingsManager = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: modelId });
		const sessionManager = SessionManager.inMemory(tempDir);
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(volt) => {
					volt.registerProvider("invalid-extension-provider", {
						streamSimple: () => {
							throw new Error("should not run");
						},
					});
					volt.registerProvider(provider, {
						baseUrl: "http://localhost:8080/initial",
						apiKey: "extension-key",
						api: "openai-completions",
						models: [
							{
								id: modelId,
								name: "Initial Extension Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 4096,
								maxTokens: 1024,
							},
						],
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session, extensionsResult } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			disableMcp: true,
			noTools: "all",
		});
		try {
			expect(session.model).toMatchObject({ provider, id: modelId, baseUrl: "http://localhost:8080/initial" });
			expect(extensionsResult.runtime.pendingProviderRegistrations).toEqual([]);
			expect(extensionsResult.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						error: 'Provider invalid-extension-provider: "api" is required when registering streamSimple.',
					}),
				]),
			);
		} finally {
			session.dispose();
			await session.waitForClosed();
		}
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(volt) => {
				volt.on("session_start", () => {
					volt.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(volt) => {
				volt.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						volt.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});
});
