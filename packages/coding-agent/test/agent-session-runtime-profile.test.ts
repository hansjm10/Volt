import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createAgentSessionTestControl } from "./agent-session-test-control.ts";
import {
	createTestAgentSessionRuntimeConfig,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./utilities.ts";

function getRuntimeProfile(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): string | undefined {
	if (!("profile" in options)) {
		return undefined;
	}
	const profile = options.profile;
	return typeof profile === "string" ? profile : undefined;
}

describe("AgentSessionRuntime profile propagation", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("keeps an interactive profile switch across new session runtime creation", async () => {
		const tempDir = join(tmpdir(), `volt-runtime-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const settings = {
			defaultProfile: "base",
			profiles: {
				base: { theme: "base-theme" },
				switched: { theme: "switched-theme" },
			},
		} satisfies Partial<Settings>;

		let runtimeProfileDuringReplacement: string | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			const runtimeProfile = getRuntimeProfile(runtimeOptions);
			if (runtimeOptions.sessionStartEvent?.reason === "new") {
				runtimeProfileDuringReplacement = runtimeProfile;
			}
			const settingsManager = SettingsManager.inMemory(settings, { profile: runtimeProfile });
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				authStorage,
				settingsManager,
				resourceLoaderOptions: {
					extensionFactories: [
						(volt) => {
							volt.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: runtimeOptions.sessionManager,
					sessionStartEvent: runtimeOptions.sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(runtime.services.settingsManager.getActiveProfile()).toBe("base");
		runtime.services.settingsManager.setActiveProfile("switched");

		await runtime.newSession();

		expect(runtimeProfileDuringReplacement).toBe("switched");
		expect(runtime.services.settingsManager.getActiveProfile()).toBe("switched");
		expect(runtime.services.settingsManager.getTheme()).toBe("switched-theme");
	});

	it("refreshes snapshotted agent settings after a profile reload", async () => {
		const faux = registerFauxProvider({
			models: [{ id: "profile-runtime-model", reasoning: true }],
		});
		const settingsManager = SettingsManager.inMemory({
			defaultProfile: "base",
			transport: "sse",
			thinkingBudgets: { low: 1000, high: 4000 },
			retry: { provider: { maxRetryDelayMs: 1000 } },
			profiles: {
				base: {},
				switched: {
					transport: "websocket",
					thinkingBudgets: { low: 2000, high: 8000 },
					retry: { provider: { maxRetryDelayMs: 250 } },
				},
			},
		} satisfies Partial<Settings>);
		const session = new AgentSession({
			...createTestAgentSessionRuntimeConfig({ model: faux.getModel(), thinkingLevel: "low" }),
			streamOptions: {
				transport: settingsManager.getTransport(),
				thinkingBudgets: settingsManager.getThinkingBudgets(),
				maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
			},
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			resourceLoader: createTestResourceLoader(),
		});

		cleanups.push(() => {
			session.dispose();
			faux.unregister();
		});

		let streamOptions = createAgentSessionTestControl(session).getStreamOptions();
		expect(streamOptions.transport).toBe("sse");
		expect(streamOptions.thinkingBudgets).toEqual({ low: 1000, high: 4000 });
		expect(streamOptions.maxRetryDelayMs).toBe(1000);

		settingsManager.setActiveProfile("switched");
		await session.reload();

		streamOptions = createAgentSessionTestControl(session).getStreamOptions();
		expect(streamOptions.transport).toBe("websocket");
		expect(streamOptions.thinkingBudgets).toEqual({ low: 2000, high: 8000 });
		expect(streamOptions.maxRetryDelayMs).toBe(250);
	});

	it("drops providers registered by extensions that disappear after a profile reload", async () => {
		const faux = registerFauxProvider({
			models: [{ id: "profile-provider-host-model", reasoning: false }],
		});
		const providerName = "profile-extension-provider";
		const providerModelId = "profile-only-model";
		let currentExtensionsResult = await createTestExtensionsResult([
			(volt) => {
				volt.registerProvider(providerName, {
					baseUrl: "http://localhost:0/profile-extension",
					apiKey: "profile-extension-key",
					api: "profile-extension-api",
					models: [
						{
							id: providerModelId,
							name: "Profile-only model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
				});
			},
		]);
		const resourceLoader = createTestResourceLoader({ extensionsResult: currentExtensionsResult });
		resourceLoader.getExtensions = () => currentExtensionsResult;
		resourceLoader.reload = async () => {
			currentExtensionsResult = await createTestExtensionsResult([]);
		};
		const settingsManager = SettingsManager.inMemory(
			{
				profiles: {
					withProvider: {},
					withoutProvider: {},
				},
			},
			{ profile: "withProvider" },
		);
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const session = new AgentSession({
			...createTestAgentSessionRuntimeConfig({ model: faux.getModel() }),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader,
		});

		cleanups.push(() => {
			modelRegistry.unregisterProvider(providerName);
			session.dispose();
			faux.unregister();
		});

		expect(modelRegistry.find(providerName, providerModelId)).toBeDefined();

		settingsManager.setActiveProfile("withoutProvider");
		await session.reload();

		expect(modelRegistry.find(providerName, providerModelId)).toBeUndefined();
	});

	it("switches away from the current extension provider model when it disappears after reload", async () => {
		const providerName = "removed-extension-provider";
		const providerModelId = "removed-extension-model";
		const fallbackProviderName = "reload-fallback-provider";
		const fallbackModelId = "reload-fallback-model";
		let currentExtensionsResult = await createTestExtensionsResult([
			(volt) => {
				volt.registerProvider(providerName, {
					baseUrl: "http://localhost:0/removed-extension",
					apiKey: "removed-extension-key",
					api: "removed-extension-api",
					models: [
						{
							id: providerModelId,
							name: "Removed extension model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
				});
			},
		]);
		const resourceLoader = createTestResourceLoader({ extensionsResult: currentExtensionsResult });
		resourceLoader.getExtensions = () => currentExtensionsResult;
		resourceLoader.reload = async () => {
			currentExtensionsResult = await createTestExtensionsResult([
				(volt) => {
					volt.registerProvider(fallbackProviderName, {
						baseUrl: "http://localhost:0/reload-fallback",
						apiKey: "reload-fallback-key",
						api: "reload-fallback-api",
						models: [
							{
								id: fallbackModelId,
								name: "Reload fallback model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 16384,
							},
						],
					});
				},
			]);
		};
		const settingsManager = SettingsManager.inMemory();
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const initialModel = modelRegistry.getAll()[0];
		if (!initialModel) {
			throw new Error("No initial model was registered");
		}
		const session = new AgentSession({
			...createTestAgentSessionRuntimeConfig({ model: initialModel }),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader,
		});

		cleanups.push(() => {
			modelRegistry.unregisterProvider(providerName);
			modelRegistry.unregisterProvider(fallbackProviderName);
			session.dispose();
		});

		const extensionModel = modelRegistry.find(providerName, providerModelId);
		expect(extensionModel).toBeDefined();
		await session.setModel(extensionModel!, { persistDefault: false });
		session.setThinkingLevel("high", { persistDefault: false });
		session.setFastModeEnabled(true);
		expect(session.model?.provider).toBe(providerName);

		await session.reload();

		expect(modelRegistry.find(providerName, providerModelId)).toBeUndefined();
		expect(session.model?.provider).toBe(fallbackProviderName);
		expect(session.model?.id).toBe(fallbackModelId);
		expect(session.model?.reasoning).toBe(false);
		expect(session.fastModeEnabled).toBe(true);
		expect(session.thinkingLevel).toBe("off");
	});
});
