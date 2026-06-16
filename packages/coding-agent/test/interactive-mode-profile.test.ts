import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import { type Model, registerFauxProvider } from "@earendil-works/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
