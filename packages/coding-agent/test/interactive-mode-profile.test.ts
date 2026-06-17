import { Agent, type ThinkingLevel } from "@earendil-works/volt-agent-core";
import { type Model, registerFauxProvider } from "@earendil-works/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

type ProfileSelectorContext = {
	settingsManager: {
		getActiveProfile: () => string | undefined;
		getProfileNames: () => string[];
	};
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showExtensionInput: (title: string, placeholder?: string) => Promise<string | undefined>;
	switchProfile: (profileName: string) => Promise<void>;
	createAndSwitchProfile: (profileName: string, options?: { forceReload?: boolean }) => Promise<void>;
	showStatus: (message: string) => void;
};

type ScopedModelUpdate = { model: Model<string>; thinkingLevel?: ThinkingLevel };
type DefaultPersistenceOptions = { persistDefault?: boolean };
type SetModelOptions = DefaultPersistenceOptions;

type ReloadRuntimeResourcesOptions = {
	action: string;
	progressMessage: string;
	successMessage: (savedImplicitProjectTrust: boolean) => string;
};

type SwitchProfileContext = {
	settingsManager: {
		getActiveProfile: () => string | undefined;
		setActiveProfile: (profileName: string) => void;
		getDefaultProvider: () => string | undefined;
		getDefaultModel: () => string | undefined;
		getDefaultThinkingLevel: () => ThinkingLevel | undefined;
		getEnabledModels: () => string[] | undefined;
		getWarnings: () => { anthropicExtraUsage?: boolean };
	};
	reloadRuntimeResources: (options: ReloadRuntimeResourcesOptions) => Promise<boolean>;
	applyScopedModelsFromSettings: () => Promise<void>;
	session: {
		model: Model<string> | undefined;
		thinkingLevel: ThinkingLevel;
		scopedModels: ReadonlyArray<ScopedModelUpdate>;
		modelRegistry: {
			find: (provider: string, modelId: string) => Model<string> | undefined;
			getAvailable: () => Model<string>[];
			hasConfiguredAuth: (model: Model<string>) => boolean;
		};
		setModel: (model: Model<string>, options?: SetModelOptions) => Promise<void>;
		setThinkingLevel: (level: ThinkingLevel, options?: DefaultPersistenceOptions) => void;
	};
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type ApplyScopedModelsContext = {
	options: { modelScopePatterns?: string[] };
	settingsManager: {
		getEnabledModels: () => string[] | undefined;
	};
	session: {
		modelRegistry: {
			getAvailable: () => Model<string>[];
		};
		setScopedModels: (scopedModels: ScopedModelUpdate[]) => void;
	};
	updateAvailableProviderCount: () => Promise<void>;
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
};

type InteractiveModeProfilePrivate = {
	showProfileSelector(this: ProfileSelectorContext): Promise<void>;
	switchProfile(
		this: SwitchProfileContext,
		profileName: string,
		options?: { created?: boolean; forceReload?: boolean },
	): Promise<void>;
	applyScopedModelsFromSettings(this: ApplyScopedModelsContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeProfilePrivate;

function createProfileSelectorContext(selection: string | undefined): ProfileSelectorContext {
	return {
		settingsManager: {
			getActiveProfile: () => "work",
			getProfileNames: () => ["dev", "work"],
		},
		showExtensionSelector: vi.fn(async () => selection),
		showExtensionInput: vi.fn(async () => undefined),
		switchProfile: vi.fn(async () => {}),
		createAndSwitchProfile: vi.fn(async () => {}),
		showStatus: vi.fn(),
	};
}

describe("InteractiveMode profile selector", () => {
	it("shows the current profile and switches to a selected profile", async () => {
		const context = createProfileSelectorContext("1. dev");

		await interactiveModePrototype.showProfileSelector.call(context);

		expect(context.showExtensionSelector).toHaveBeenCalledWith("Current profile: work", [
			"1. dev",
			"2. work (current)",
			"Create new profile",
			"Cancel",
		]);
		expect(context.switchProfile).toHaveBeenCalledWith("dev");
	});

	it("offers to create the current profile when it is selected but undefined", async () => {
		const context = createProfileSelectorContext('Create "work"');
		context.settingsManager.getProfileNames = () => ["dev"];

		await interactiveModePrototype.showProfileSelector.call(context);

		expect(context.showExtensionSelector).toHaveBeenCalledWith("Current profile: work", [
			"1. dev",
			'Create "work"',
			"Create new profile",
			"Cancel",
		]);
		expect(context.createAndSwitchProfile).toHaveBeenCalledWith("work", { forceReload: true });
	});

	it("reapplies the selected profile default model when switching profiles", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "profile-a-model", reasoning: false },
				{ id: "profile-b-model", reasoning: false },
			],
		});
		try {
			const profileAModel = faux.getModel("profile-a-model");
			const profileBModel = faux.getModel("profile-b-model");
			if (!profileAModel || !profileBModel) {
				throw new Error("Faux models were not registered");
			}

			let activeProfile = "profile-b";
			const setModel = vi.fn<(model: Model<string>, options?: SetModelOptions) => Promise<void>>(async () => {});
			const context = Object.create(InteractiveMode.prototype) as SwitchProfileContext;
			Object.defineProperties(context, {
				settingsManager: {
					value: {
						getActiveProfile: () => activeProfile,
						setActiveProfile: (profileName: string) => {
							activeProfile = profileName;
						},
						getDefaultProvider: () => profileAModel.provider,
						getDefaultModel: () => profileAModel.id,
						getDefaultThinkingLevel: () => undefined,
						getEnabledModels: () => undefined,
						getWarnings: () => ({}),
					},
				},
				reloadRuntimeResources: { value: vi.fn(async (_options: ReloadRuntimeResourcesOptions) => true) },
				applyScopedModelsFromSettings: { value: vi.fn(async () => {}) },
				session: {
					value: {
						model: profileBModel,
						thinkingLevel: "off",
						scopedModels: [],
						modelRegistry: {
							find: (provider: string, modelId: string) =>
								[profileAModel, profileBModel].find(
									(model) => model.provider === provider && model.id === modelId,
								),
							getAvailable: () => [profileAModel, profileBModel],
							hasConfiguredAuth: () => true,
						},
						setModel,
						setThinkingLevel: vi.fn(),
					},
				},
				footer: { value: { invalidate: vi.fn() } },
				updateEditorBorderColor: { value: vi.fn() },
				showStatus: { value: vi.fn() },
				showWarning: { value: vi.fn() },
			});

			await interactiveModePrototype.switchProfile.call(context, "profile-a");

			expect(setModel).toHaveBeenCalledWith(profileAModel, { persistDefault: false });
		} finally {
			faux.unregister();
		}
	});

	it("falls back to the first scoped model when a switched profile default is out of scope", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "scoped-model", reasoning: false },
				{ id: "profile-default-model", reasoning: false },
				{ id: "previous-model", reasoning: false },
			],
		});
		try {
			const scopedModel = faux.getModel("scoped-model");
			const profileDefaultModel = faux.getModel("profile-default-model");
			const previousModel = faux.getModel("previous-model");
			if (!scopedModel || !profileDefaultModel || !previousModel) {
				throw new Error("Faux models were not registered");
			}

			let activeProfile = "previous";
			const scopedModels: ScopedModelUpdate[] = [];
			const session = {
				model: previousModel,
				thinkingLevel: "off" as ThinkingLevel,
				get scopedModels() {
					return scopedModels;
				},
				modelRegistry: {
					find: (provider: string, modelId: string) =>
						[scopedModel, profileDefaultModel, previousModel].find(
							(model) => model.provider === provider && model.id === modelId,
						),
					getAvailable: () => [scopedModel, profileDefaultModel, previousModel],
					hasConfiguredAuth: () => true,
				},
				setModel: vi.fn(async (model: Model<string>, _options?: SetModelOptions) => {
					session.model = model;
				}),
				setThinkingLevel: vi.fn(),
			};
			const context = Object.create(InteractiveMode.prototype) as SwitchProfileContext;
			Object.defineProperties(context, {
				settingsManager: {
					value: {
						getActiveProfile: () => activeProfile,
						setActiveProfile: (profileName: string) => {
							activeProfile = profileName;
						},
						getDefaultProvider: () => profileDefaultModel.provider,
						getDefaultModel: () => profileDefaultModel.id,
						getDefaultThinkingLevel: () => undefined,
						getEnabledModels: () => [scopedModel.id],
						getWarnings: () => ({}),
					},
				},
				reloadRuntimeResources: { value: vi.fn(async (_options: ReloadRuntimeResourcesOptions) => true) },
				applyScopedModelsFromSettings: {
					value: vi.fn(async () => {
						scopedModels.splice(0, scopedModels.length, { model: scopedModel });
					}),
				},
				session: { value: session },
				footer: { value: { invalidate: vi.fn() } },
				updateEditorBorderColor: { value: vi.fn() },
				showStatus: { value: vi.fn() },
				showWarning: { value: vi.fn() },
			});

			await interactiveModePrototype.switchProfile.call(context, "scoped");

			expect(session.setModel).toHaveBeenCalledWith(scopedModel, { persistDefault: false });
			expect(session.model).toBe(scopedModel);
			expect(session.setModel).not.toHaveBeenCalledWith(profileDefaultModel, { persistDefault: false });
		} finally {
			faux.unregister();
		}
	});

	it("falls back to the first scoped model when a switched profile has no default model", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "enabled-profile-model", reasoning: false },
				{ id: "previous-model", reasoning: false },
			],
		});
		try {
			const enabledProfileModel = faux.getModel("enabled-profile-model");
			const previousModel = faux.getModel("previous-model");
			if (!enabledProfileModel || !previousModel) {
				throw new Error("Faux models were not registered");
			}

			let activeProfile = "previous";
			const scopedModels: ScopedModelUpdate[] = [];
			const session = {
				model: previousModel,
				thinkingLevel: "off" as ThinkingLevel,
				get scopedModels() {
					return scopedModels;
				},
				modelRegistry: {
					find: (provider: string, modelId: string) =>
						[enabledProfileModel, previousModel].find(
							(model) => model.provider === provider && model.id === modelId,
						),
					getAvailable: () => [enabledProfileModel, previousModel],
					hasConfiguredAuth: () => true,
				},
				setModel: vi.fn(async (model: Model<string>, _options?: SetModelOptions) => {
					session.model = model;
				}),
				setThinkingLevel: vi.fn(),
			};
			const context = Object.create(InteractiveMode.prototype) as SwitchProfileContext;
			Object.defineProperties(context, {
				settingsManager: {
					value: {
						getActiveProfile: () => activeProfile,
						setActiveProfile: (profileName: string) => {
							activeProfile = profileName;
						},
						getDefaultProvider: () => undefined,
						getDefaultModel: () => undefined,
						getDefaultThinkingLevel: () => undefined,
						getEnabledModels: () => [enabledProfileModel.id],
						getWarnings: () => ({}),
					},
				},
				reloadRuntimeResources: { value: vi.fn(async (_options: ReloadRuntimeResourcesOptions) => true) },
				applyScopedModelsFromSettings: {
					value: vi.fn(async () => {
						scopedModels.splice(0, scopedModels.length, { model: enabledProfileModel });
					}),
				},
				session: { value: session },
				footer: { value: { invalidate: vi.fn() } },
				updateEditorBorderColor: { value: vi.fn() },
				showStatus: { value: vi.fn() },
				showWarning: { value: vi.fn() },
			});

			await interactiveModePrototype.switchProfile.call(context, "enabled-only");

			expect(session.setModel).toHaveBeenCalledWith(enabledProfileModel, { persistDefault: false });
			expect(session.model).toBe(enabledProfileModel);
		} finally {
			faux.unregister();
		}
	});

	it("does not persist inherited defaults while applying a switched profile model", async () => {
		const provider = "profile-defaults-test";
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(provider, {
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "profile-defaults-test-api",
			models: [
				{
					id: "inherited-profile-model",
					name: "Inherited profile model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
				{
					id: "previous-profile-model",
					name: "Previous profile model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		});
		const inheritedModel = modelRegistry.find(provider, "inherited-profile-model") as Model<string> | undefined;
		const previousModel = modelRegistry.find(provider, "previous-profile-model") as Model<string> | undefined;
		if (!inheritedModel || !previousModel) {
			throw new Error("Profile test models were not registered");
		}

		const settingsManager = SettingsManager.inMemory(
			{
				defaultProvider: inheritedModel.provider,
				defaultModel: inheritedModel.id,
				defaultThinkingLevel: "high",
				profiles: {
					inherited: {},
					previous: {
						defaultProvider: previousModel.provider,
						defaultModel: previousModel.id,
					},
				},
			},
			{ profile: "previous" },
		);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: previousModel,
					systemPrompt: "You are a helpful assistant.",
					tools: [],
					thinkingLevel: "off",
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const setModel = vi.fn<(model: Model<string>, options?: SetModelOptions) => Promise<void>>(
				async (model, options) => {
					await session.setModel(model, options);
				},
			);
			const context = Object.create(InteractiveMode.prototype) as SwitchProfileContext;
			Object.defineProperties(context, {
				settingsManager: { value: settingsManager },
				reloadRuntimeResources: { value: vi.fn(async (_options: ReloadRuntimeResourcesOptions) => true) },
				applyScopedModelsFromSettings: { value: vi.fn(async () => {}) },
				session: {
					value: {
						model: previousModel,
						get thinkingLevel() {
							return session.thinkingLevel;
						},
						scopedModels: [],
						modelRegistry: {
							find: (candidateProvider: string, modelId: string) =>
								[inheritedModel, previousModel].find(
									(model) => model.provider === candidateProvider && model.id === modelId,
								),
							getAvailable: () => [inheritedModel, previousModel],
							hasConfiguredAuth: (model: Model<string>) => modelRegistry.hasConfiguredAuth(model),
						},
						setModel,
						setThinkingLevel: (level: ThinkingLevel, options?: DefaultPersistenceOptions) => {
							session.setThinkingLevel(level, options);
						},
					},
				},
				footer: { value: { invalidate: vi.fn() } },
				updateEditorBorderColor: { value: vi.fn() },
				showStatus: { value: vi.fn() },
				showWarning: { value: vi.fn() },
			});

			await interactiveModePrototype.switchProfile.call(context, "inherited");

			expect(setModel).toHaveBeenCalledWith(inheritedModel, { persistDefault: false });
			expect(session.model).toBe(inheritedModel);
			expect(session.thinkingLevel).toBe("high");
			const inheritedProfile = settingsManager.getGlobalSettings().profiles?.inherited;
			expect(inheritedProfile?.defaultProvider).toBeUndefined();
			expect(inheritedProfile?.defaultModel).toBeUndefined();
			expect(inheritedProfile?.defaultThinkingLevel).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("applies profile default thinking when switching profiles on the same model", async () => {
		const provider = "profile-thinking-test";
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(provider, {
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "profile-thinking-test-api",
			models: [
				{
					id: "shared-reasoning-model",
					name: "Shared reasoning model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		});
		const reasoningModel = modelRegistry.find(provider, "shared-reasoning-model") as Model<string> | undefined;
		if (!reasoningModel) {
			throw new Error("Profile thinking test model was not registered");
		}

		const settingsManager = SettingsManager.inMemory(
			{
				defaultProvider: reasoningModel.provider,
				defaultModel: reasoningModel.id,
				profiles: {
					fast: {
						defaultProvider: reasoningModel.provider,
						defaultModel: reasoningModel.id,
						defaultThinkingLevel: "low",
					},
					deep: {
						defaultProvider: reasoningModel.provider,
						defaultModel: reasoningModel.id,
						defaultThinkingLevel: "high",
					},
				},
			},
			{ profile: "fast" },
		);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: reasoningModel,
					systemPrompt: "You are a helpful assistant.",
					tools: [],
					thinkingLevel: "low",
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const setModel = vi.spyOn(session, "setModel");
			const context = Object.create(InteractiveMode.prototype) as SwitchProfileContext;
			Object.defineProperties(context, {
				settingsManager: { value: settingsManager },
				reloadRuntimeResources: { value: vi.fn(async (_options: ReloadRuntimeResourcesOptions) => true) },
				applyScopedModelsFromSettings: { value: vi.fn(async () => {}) },
				session: { value: session },
				footer: { value: { invalidate: vi.fn() } },
				updateEditorBorderColor: { value: vi.fn() },
				showStatus: { value: vi.fn() },
				showWarning: { value: vi.fn() },
			});

			await interactiveModePrototype.switchProfile.call(context, "deep");

			expect(setModel).not.toHaveBeenCalled();
			expect(session.model).toBe(reasoningModel);
			expect(session.thinkingLevel).toBe("high");
		} finally {
			session.dispose();
		}
	});

	it("keeps explicit CLI model scope ahead of profile model settings", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "cli-model", reasoning: false },
				{ id: "profile-model", reasoning: false },
			],
		});
		try {
			const cliModel = faux.getModel("cli-model");
			const profileModel = faux.getModel("profile-model");
			if (!cliModel || !profileModel) {
				throw new Error("Faux models were not registered");
			}
			const setScopedModels = vi.fn<(scopedModels: ScopedModelUpdate[]) => void>();
			const context: ApplyScopedModelsContext = {
				options: { modelScopePatterns: [cliModel.id] },
				settingsManager: {
					getEnabledModels: () => [profileModel.id],
				},
				session: {
					modelRegistry: {
						getAvailable: () => [cliModel, profileModel],
					},
					setScopedModels,
				},
				updateAvailableProviderCount: vi.fn(async () => {}),
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
			};

			await interactiveModePrototype.applyScopedModelsFromSettings.call(context);

			expect(setScopedModels).toHaveBeenCalledWith([{ model: cliModel, thinkingLevel: undefined }]);
		} finally {
			faux.unregister();
		}
	});
});
