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
		tuiMode: "regular",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
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
		onTuiModeChange: () => {},
		onFullscreenExitOutputChange: () => {},
		onFullscreenScrollbarChange: () => {},
		onWarningsChange: () => {},
		onCancel: () => {},
	};
}

describe("SettingsSelectorComponent", () => {
	test("cycles through fullscreen settings", () => {
		const onTuiModeChange = vi.fn();
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const callbacks = createCallbacks(() => undefined);
		callbacks.onTuiModeChange = onTuiModeChange;
		callbacks.onFullscreenExitOutputChange = onExitOutputChange;
		callbacks.onFullscreenScrollbarChange = onScrollbarChange;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(createConfig("default"), callbacks).getSettingsList();
			for (const character of label.replaceAll(" ", "")) list.handleInput(character);
			for (let index = 0; index < count; index++) list.handleInput(" ");
		};

		cycle("TUI mode", 1);
		expect(onTuiModeChange).toHaveBeenCalledWith("fullscreen");
		onExitOutputChange.mockClear();
		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls).toEqual([["resume-hint"], ["transcript"]]);
		onScrollbarChange.mockClear();
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

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
			expect(stripAnsi(settingsList.render(100).join("\n"))).toContain("pragmatic");
		} finally {
			cleanup();
		}
	});

	test("changes the context warning threshold from the warnings settings", () => {
		const config = createConfig("default");
		config.warnings = { contextTokens: 350_000 };
		const onWarningsChange = vi.fn();
		const callbacks = createCallbacks(() => {});
		callbacks.onWarningsChange = onWarningsChange;
		const settingsList = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		for (const character of "warnings") {
			settingsList.handleInput(character);
		}
		settingsList.handleInput("\n");
		expect(stripAnsi(settingsList.render(100).join("\n"))).toContain("Context usage");
		expect(stripAnsi(settingsList.render(100).join("\n"))).toContain("350k");

		settingsList.handleInput("\x1b[B");
		settingsList.handleInput("\n");

		expect(onWarningsChange).toHaveBeenCalledWith({ contextTokens: 500_000 });
	});
});
