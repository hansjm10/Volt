import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { Personality } from "../src/core/personality.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createTestSession } from "./utilities.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createConfig(personality: Personality): SettingsConfig {
	return {
		autoCompact: true,
		personality,
		showImages: false,
		imageWidthCells: 80,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300_000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium"],
		availableModels: [],
		currentTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: true,
		warnings: {},
	};
}

function createCallbacks(onPersonalityChange: (personality: Personality) => void): SettingsCallbacks {
	return {
		onAutoCompactChange: () => {},
		onPersonalityChange,
		onShowImagesChange: () => {},
		onImageWidthCellsChange: () => {},
		onAutoResizeImagesChange: () => {},
		onBlockImagesChange: () => {},
		onEnableSkillCommandsChange: () => {},
		onSteeringModeChange: () => {},
		onFollowUpModeChange: () => {},
		onTransportChange: () => {},
		onHttpIdleTimeoutMsChange: () => {},
		onThinkingLevelChange: () => {},
		onReviewModelChange: () => {},
		onThemeChange: () => {},
		onHideThinkingBlockChange: () => {},
		onCollapseChangelogChange: () => {},
		onEnableInstallTelemetryChange: () => {},
		onDoubleEscapeActionChange: () => {},
		onTreeFilterModeChange: () => {},
		onShowHardwareCursorChange: () => {},
		onEditorPaddingXChange: () => {},
		onAutocompleteMaxVisibleChange: () => {},
		onQuietStartupChange: () => {},
		onDefaultProjectTrustChange: () => {},
		onClearOnShrinkChange: () => {},
		onShowTerminalProgressChange: () => {},
		onWarningsChange: () => {},
		onCancel: () => {},
	};
}

describe("SettingsSelectorComponent", () => {
	test("changes the active session personality", () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		try {
			session.settingsManager.ensureGlobalProfile("delivery");
			session.settingsManager.setActiveProfile("delivery");
			const onPersonalityChange = vi.fn((personality: Personality) => session.setPersonality(personality));
			const selector = new SettingsSelectorComponent(
				createConfig(session.settingsManager.getPersonality()),
				createCallbacks(onPersonalityChange),
			);
			const settingsList = selector.getSettingsList();

			for (const character of "personality") {
				settingsList.handleInput(character);
			}
			const initialRender = stripAnsi(settingsList.render(100).join("\n"));
			expect(initialRender).toContain("Personality");
			expect(initialRender).toContain("default");

			settingsList.handleInput("\n");

			expect(onPersonalityChange).toHaveBeenCalledWith("pragmatic");
			expect(session.settingsManager.getPersonality()).toBe("pragmatic");
			expect(session.settingsManager.getGlobalSettings().profiles?.delivery?.personality).toBe("pragmatic");
			expect(session.systemPrompt).toContain("you are pragmatic, direct, and solutions-oriented");
			expect(stripAnsi(settingsList.render(100).join("\n"))).toContain("pragmatic");
		} finally {
			cleanup();
		}
	});
});
