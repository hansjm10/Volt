import { homedir } from "node:os";
import * as path from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.scheduleTurnDoneAlert", () => {
	function createFakeThis(options?: {
		alertMode?: "off" | "bell";
		streaming?: boolean;
		compacting?: boolean;
		retrying?: boolean;
		focusState?: "focused" | "unfocused" | "unknown";
	}) {
		return {
			settingsManager: { getTurnDoneAlert: vi.fn(() => options?.alertMode ?? "bell") },
			session: {
				isStreaming: options?.streaming ?? false,
				isCompacting: options?.compacting ?? false,
				isRetrying: options?.retrying ?? false,
			},
			ui: { terminal: { alert: vi.fn(), focusState: options?.focusState ?? "unknown" } },
			shutdownRequested: false,
			isShuttingDown: false,
			turnDoneAlertTimer: undefined,
			clearTurnDoneAlertTimer: (InteractiveMode as any).prototype.clearTurnDoneAlertTimer,
			scheduleTurnDoneAlertTimer: (InteractiveMode as any).prototype.scheduleTurnDoneAlertTimer,
		};
	}

	test("rings the terminal bell after agent_end when enabled and idle", () => {
		vi.useFakeTimers();
		try {
			const fakeThis = createFakeThis();

			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "stop" }],
			});

			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();
			vi.runOnlyPendingTimers();
			expect(fakeThis.ui.terminal.alert).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("waits until post-run compaction is idle", () => {
		vi.useFakeTimers();
		try {
			const fakeThis = createFakeThis({ compacting: true });

			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "stop" }],
			});

			vi.advanceTimersByTime(0);
			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();
			fakeThis.session.isCompacting = false;
			vi.advanceTimersByTime(250);
			expect(fakeThis.ui.terminal.alert).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("clears queued alerts when a later agent_end suppresses the alert", () => {
		vi.useFakeTimers();
		try {
			const fakeThis = createFakeThis({ compacting: true });

			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "stop" }],
			});
			vi.advanceTimersByTime(0);
			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();

			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "aborted" }],
			});
			fakeThis.session.isCompacting = false;
			vi.advanceTimersByTime(250);
			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();

			fakeThis.session.isCompacting = true;
			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "stop" }],
			});
			vi.advanceTimersByTime(0);
			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: true,
				messages: [{ role: "assistant", stopReason: "error" }],
			});
			fakeThis.session.isCompacting = false;
			vi.advanceTimersByTime(250);
			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("suppresses the alert while the terminal reports focus", () => {
		vi.useFakeTimers();
		try {
			const fakeThis = createFakeThis({ focusState: "focused" });

			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "stop" }],
			});

			vi.runOnlyPendingTimers();
			expect(fakeThis.ui.terminal.alert).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("alerts when the terminal is unfocused or focus reporting is unsupported", () => {
		vi.useFakeTimers();
		try {
			for (const focusState of ["unfocused", "unknown"] as const) {
				const fakeThis = createFakeThis({ focusState });

				(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(fakeThis, {
					type: "agent_end",
					willRetry: false,
					messages: [{ role: "assistant", stopReason: "stop" }],
				});

				vi.runOnlyPendingTimers();
				expect(fakeThis.ui.terminal.alert).toHaveBeenCalledTimes(1);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("skips retrying and aborted turns", () => {
		vi.useFakeTimers();
		try {
			const retryingThis = createFakeThis();
			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(retryingThis, {
				type: "agent_end",
				willRetry: true,
				messages: [{ role: "assistant", stopReason: "error" }],
			});

			const abortedThis = createFakeThis();
			(InteractiveMode as any).prototype.scheduleTurnDoneAlert.call(abortedThis, {
				type: "agent_end",
				willRetry: false,
				messages: [{ role: "assistant", stopReason: "aborted" }],
			});

			vi.runOnlyPendingTimers();
			expect(retryingThis.ui.terminal.alert).not.toHaveBeenCalled();
			expect(abortedThis.ui.terminal.alert).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		(
			InteractiveMode as unknown as {
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode plan pane integration", () => {
	test("routes a customized pane key before default and extension-derived editor input", () => {
		let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const togglePlanPaneFocus = vi.fn();
		const fakeThis = {
			mainViewVisible: true,
			keybindings: new KeybindingsManager({ "app.plan.togglePane": "alt+x" }),
			ui: {
				addInputListener: vi.fn((next: typeof listener) => {
					listener = next;
					return () => undefined;
				}),
				isOverlayFocused: () => false,
			},
			planPaneInputUnsubscribe: undefined,
			togglePlanPaneFocus,
		};

		(InteractiveMode as any).prototype.setupPlanPaneInputRouting.call(fakeThis);

		expect(listener?.("\x1bx")).toEqual({ consume: true });
		expect(togglePlanPaneFocus).toHaveBeenCalledTimes(1);
	});

	test("handles a Kitty pane shortcut without retriggering on release", async () => {
		const terminal = new VirtualTerminal(160, 30);
		const ui = new TUI(terminal);
		const extensionEditor = new TestFocusableComponent("EXTENSION_EDITOR");
		const root = new Container();
		root.addChild(extensionEditor);
		const togglePlanPaneFocus = vi.fn();
		const fakeThis = {
			mainViewVisible: true,
			keybindings: new KeybindingsManager(),
			ui,
			planPaneInputUnsubscribe: undefined,
			togglePlanPaneFocus,
		};
		(InteractiveMode as any).prototype.setupPlanPaneInputRouting.call(fakeThis);
		ui.addChild(root);
		ui.setFocus(extensionEditor);
		ui.start();
		try {
			terminal.sendInput("\x1b[112;3u");
			await flushTui(ui, terminal);
			expect(togglePlanPaneFocus).toHaveBeenCalledTimes(1);
			expect(extensionEditor.inputs).toEqual([]);

			terminal.sendInput("\x1b[112;3:3u");
			await flushTui(ui, terminal);
			expect(togglePlanPaneFocus).toHaveBeenCalledTimes(1);
			expect(extensionEditor.inputs).toEqual([]);
		} finally {
			ui.stop();
		}
	});

	test("leaves the pane shortcut and ready autofocus with a focused overlay", async () => {
		const terminal = new VirtualTerminal(160, 30);
		const ui = new TUI(terminal);
		const editor = new TestFocusableComponent("EDITOR");
		const inspector = new TestFocusableComponent("PLAN_INSPECTOR");
		const overlay = new TestFocusableComponent("CAPTURING_OVERLAY");
		const root = new Container();
		root.addChild(editor);
		root.addChild(inspector);
		ui.addChild(root);
		ui.setFocus(editor);
		const togglePlanPaneFocus = vi.fn();
		const fakeThis = {
			mainViewVisible: true,
			keybindings: new KeybindingsManager({ "app.plan.togglePane": "alt+x" }),
			ui,
			planPaneInputUnsubscribe: undefined,
			togglePlanPaneFocus,
			mainView: { isSplit: () => true },
			planInspector: inspector,
			planPaneReturnFocus: undefined,
			getConversationFocusTarget: () => editor,
		};
		(
			InteractiveMode as unknown as {
				prototype: {
					setupPlanPaneInputRouting: (this: typeof fakeThis) => void;
					focusPlanInspector: (this: typeof fakeThis) => void;
				};
			}
		).prototype.setupPlanPaneInputRouting.call(fakeThis);
		ui.showOverlay(overlay);
		ui.start();
		try {
			terminal.sendInput("\x1bx");
			await flushTui(ui, terminal);
			expect(togglePlanPaneFocus).not.toHaveBeenCalled();
			expect(overlay.inputs).toEqual(["\x1bx"]);

			(
				InteractiveMode as unknown as {
					prototype: { focusPlanInspector: (this: typeof fakeThis) => void };
				}
			).prototype.focusPlanInspector.call(fakeThis);
			expect(overlay.focused).toBe(true);
			expect(inspector.focused).toBe(false);
			terminal.sendInput("\r");
			await flushTui(ui, terminal);
			expect(overlay.inputs).toEqual(["\x1bx", "\r"]);
			expect(inspector.inputs).toEqual([]);
		} finally {
			ui.stop();
		}
	});

	test("restores non-overlay custom UI focus after returning from the plan inspector", async () => {
		const terminal = new VirtualTerminal(160, 30);
		const ui = new TUI(terminal);
		const editor = new TestFocusableComponent("EDITOR");
		const custom = new TestFocusableComponent("CUSTOM");
		const inspector = new TestFocusableComponent("PLAN_INSPECTOR");
		const editorContainer = new Container();
		const root = new Container();
		type FocusHarness = {
			editor: TestFocusableComponent;
			editorContainer: Container;
			extensionSelector: undefined;
			extensionInput: undefined;
			extensionEditor: undefined;
			keybindings: object;
			ui: TUI;
			mainViewVisible: boolean;
			mainView: { isSplit: () => boolean };
			planInspector: TestFocusableComponent;
			planPaneReturnFocus: Component | undefined;
			getConversationFocusTarget: () => Component;
			focusPlanInspector: () => void;
			focusConversation: () => void;
			togglePlanPaneFocus: () => void;
		};
		const methods = (
			InteractiveMode as unknown as {
				prototype: {
					getConversationFocusTarget: (this: FocusHarness) => Component;
					focusPlanInspector: (this: FocusHarness) => void;
					focusConversation: (this: FocusHarness) => void;
					togglePlanPaneFocus: (this: FocusHarness) => void;
					showExtensionCustom: <T>(
						this: FocusHarness,
						factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
					) => Promise<T>;
				};
			}
		).prototype;
		const fakeThis: FocusHarness = {
			editor,
			editorContainer,
			extensionSelector: undefined,
			extensionInput: undefined,
			extensionEditor: undefined,
			keybindings: {},
			ui,
			mainViewVisible: true,
			mainView: { isSplit: () => true },
			planInspector: inspector,
			planPaneReturnFocus: undefined,
			getConversationFocusTarget: () => methods.getConversationFocusTarget.call(fakeThis),
			focusPlanInspector: () => methods.focusPlanInspector.call(fakeThis),
			focusConversation: () => methods.focusConversation.call(fakeThis),
			togglePlanPaneFocus: () => methods.togglePlanPaneFocus.call(fakeThis),
		};
		const showCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
		): Promise<T> => methods.showExtensionCustom.call(fakeThis, factory) as Promise<T>;
		let closeCustom: (value: string) => void = () => {
			throw new Error("closeCustom was not initialized");
		};

		editorContainer.addChild(editor);
		root.addChild(editorContainer);
		root.addChild(inspector);
		ui.addChild(root);
		ui.setFocus(editor);
		ui.start();
		const customPromise = showCustom<string>((_tui, _theme, _keybindings, done) => {
			closeCustom = done;
			return custom;
		});
		try {
			await flushTui(ui, terminal);
			expect(custom.focused).toBe(true);

			fakeThis.togglePlanPaneFocus();
			expect(inspector.focused).toBe(true);
			fakeThis.togglePlanPaneFocus();
			expect(custom.focused).toBe(true);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			fakeThis.togglePlanPaneFocus();
			expect(inspector.focused).toBe(true);
			fakeThis.focusConversation();
			expect(custom.focused).toBe(true);
			terminal.sendInput("y");
			await flushTui(ui, terminal);

			expect(custom.inputs).toEqual(["x", "y"]);
			expect(editor.inputs).toEqual([]);
		} finally {
			closeCustom("done");
			await customPromise;
			ui.stop();
		}
	});

	test("moves focus from compact Plan Details to the inspector when the split appears", async () => {
		const terminal = new VirtualTerminal(160, 30);
		const ui = new TUI(terminal);
		const planDetails = new TestFocusableComponent("PLAN_DETAILS");
		const inspector = new TestFocusableComponent("PLAN_INSPECTOR");
		const detailsContainer = new Container();
		detailsContainer.addChild(planDetails);
		const root = new Container();
		root.addChild(detailsContainer);
		root.addChild(inspector);
		ui.addChild(root);
		ui.setFocus(planDetails);
		const fakeThis = {
			ui,
			planDetails,
			planInspector: inspector,
			closePlanDetails: vi.fn(() => detailsContainer.clear()),
			focusPlanInspector: vi.fn(() => ui.setFocus(inspector)),
			focusConversation: vi.fn(),
			showPlanDetails: vi.fn(),
			session: { planningState: { mode: "build", plan: { phase: "active" } } },
		};
		ui.start();
		try {
			(
				InteractiveMode as unknown as {
					prototype: {
						handlePlanSplitChange: (this: typeof fakeThis, split: boolean, preserveScrollback: boolean) => void;
					};
				}
			).prototype.handlePlanSplitChange.call(fakeThis, true, false);
			terminal.sendInput("x");
			await flushTui(ui, terminal);
			expect(detailsContainer.children).toEqual([]);
			expect(planDetails.focused).toBe(false);
			expect(inspector.focused).toBe(true);
			expect(planDetails.inputs).toEqual([]);
			expect(inspector.inputs).toEqual(["x"]);
		} finally {
			ui.stop();
		}
	});

	test("recovers conversation focus when a resize removes the split", () => {
		const focusConversation = vi.fn();
		const fakeThis = {
			planInspector: { focused: true },
			planDetails: undefined,
			session: { planningState: { mode: "build", plan: null } },
			focusConversation,
			showPlanDetails: vi.fn(),
		};

		(InteractiveMode as any).prototype.handlePlanSplitChange.call(fakeThis, false);

		expect(focusConversation).toHaveBeenCalledTimes(1);
	});

	test("focuses the persistent inspector for /plan-details in wide layout", () => {
		const focusPlanInspector = vi.fn();
		const fakeThis = {
			mainView: { isSplit: () => true },
			ui: { terminal: { columns: 160, rows: 30 } },
			focusPlanInspector,
		};

		(InteractiveMode as any).prototype.showPlanDetails.call(fakeThis);

		expect(focusPlanInspector).toHaveBeenCalledTimes(1);
	});

	test("keeps the responsive main view atomic for full-screen selector replacement", async () => {
		const terminal = new VirtualTerminal(160, 30);
		const ui = new TUI(terminal);
		const mainView = new TestFocusableComponent("MAIN_VIEW");
		const editor = new TestFocusableComponent("EDITOR");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		let closeSelector: () => void = () => undefined;
		const fakeThis = {
			mainView,
			mainViewVisible: true,
			dismissSubagentInspector: undefined,
			ui,
			editor,
			editorContainer,
			getMainViewComponents: () => [mainView],
		};
		ui.addChild(mainView);
		ui.setFocus(editor);
		ui.start();
		try {
			(InteractiveMode as any).prototype.showSelector.call(fakeThis, (done: () => void) => {
				closeSelector = done;
				const selector = new TestFocusableComponent("FULL_SCREEN_SELECTOR");
				return { component: selector, focus: selector };
			});
			await flushTui(ui, terminal);
			expect(fakeThis.mainViewVisible).toBe(false);
			expect(ui.children).not.toContain(mainView);
			closeSelector();
			await flushTui(ui, terminal);
			expect(fakeThis.mainViewVisible).toBe(true);
			expect(ui.children).toContain(mainView);
			expect(editor.focused).toBe(true);
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.volt/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.volt/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.volt/extensions",
				}),
			},
			{
				path: "/tmp/project/.volt/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.volt/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.volt/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.volt/npm/node_modules/volt-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.volt/npm/node_modules/volt-markdown-preview/extensions/index.ts",
					{
						source: "npm:volt-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.volt/npm/node_modules/volt-markdown-preview",
					},
				),
			},
			{
				path: "/tmp/project/.volt/npm/node_modules/@scope/volt-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.volt/npm/node_modules/@scope/volt-scoped/extensions/index.ts", {
					source: "npm:@scope/volt-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.volt/npm/node_modules/@scope/volt-scoped",
				}),
			},
			{
				path: "/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/volt-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/volt-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.volt/git/github.com/HazAT/volt-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("shows a compact resource count by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toBe("RESOURCES  1 skill");
		expect(output).not.toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("SKILLS");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("SKILLS");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("uses a plural extension count in compact mode", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toBe("RESOURCES  2 extensions");
		expect(output).not.toContain("answer.ts");
		expect(output).not.toContain("btw.ts");
	});

	test("counts mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe("RESOURCES  8 extensions");
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"EXTENSIONS
   project
     /tmp/project/.volt/extensions/answer.ts
     /tmp/project/.volt/extensions/local-index
     git:github.com/HazAT/volt-interactive-subagents
       extensions
       extensions/subagents
     npm:@scope/volt-scoped
       extensions
     npm:volt-markdown-preview
       extensions
   user
     /tmp/agent/extensions/user-index
   path
     /tmp/temp/cli-extension.ts"`);
	});

	test("summarizes context files by count in compact mode", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "volt");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".volt", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(output).toBe("RESOURCES  2 context");
		expect(output).not.toContain("AGENTS.md");
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "volt");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".volt", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("CONTEXT");
		expect(output).toContain("~/.volt/agent/AGENTS.md");
		expect(output).toContain("~/Development/volt/AGENTS.md");
		expect(output).not.toContain("~/.volt/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
