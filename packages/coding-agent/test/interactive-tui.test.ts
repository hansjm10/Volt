import type { Component, RenderSuspensionLease, Terminal, TUI, TuiMode } from "@hansjm10/volt-tui";
import { Container, isViewportTUI, VStack } from "@hansjm10/volt-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});

	it("keeps a stable reference and active view while replacing renderers", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		const view = { regularComponents: [component], fullscreenRoot: component };
		renderer.addChild(component);
		renderer.setFocus(component);

		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			activeView: view,
			conversationView: view,
			planDetails: undefined,
			mainScreenRenderState: undefined,
			sessionRenderSuspension: undefined as RenderSuspensionLease | undefined,
			options: { tuiMode: "regular" as TuiMode },
			onRightClickPaste: () => undefined,
			extensionTerminalInputSubscriptions: new Set<{
				handler: (data: string) => { consume?: boolean } | undefined;
				unsubscribe: () => void;
			}>(),
		});
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const prototype = InteractiveMode.prototype as unknown as {
			switchTuiMode(this: typeof context, mode: TuiMode, restoreProgress?: boolean): boolean;
			stopInteractiveTui(this: typeof context, output: "transcript" | "resume-hint"): void;
		};

		renderer.start();
		await terminal.waitForRender();
		const terminalInput = vi.fn((_data: string) => ({ consume: true }));
		context.extensionTerminalInputSubscriptions.add({
			handler: terminalInput,
			unsubscribe: stableUi.addInputListener(terminalInput),
		});
		context.sessionRenderSuspension = stableUi.suspendRendering();
		expect(prototype.switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);
		expect(context.renderer.getRenderMetrics().frames).toBe(0);
		context.sessionRenderSuspension?.release();
		context.sessionRenderSuspension = undefined;
		await terminal.waitForRender();
		expect(context.renderer.getRenderMetrics().frames).toBeGreaterThan(0);
		terminal.sendInput("x");
		await terminal.waitForRender();
		expect(terminalInput).toHaveBeenCalledWith("x");

		prototype.stopInteractiveTui.call(context, "resume-hint");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 2]);
	});

	it("prints the regular transcript when fullscreen exit output requests it", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const component = { render: () => ["FINAL TRANSCRIPT"], invalidate: () => {} } satisfies Component;
		const view = { regularComponents: [component], fullscreenRoot: component };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			activeView: view,
			conversationView: view,
			planDetails: undefined,
			mainScreenRenderState: undefined,
			sessionRenderSuspension: undefined,
			options: { tuiMode: "fullscreen" as TuiMode },
			onRightClickPaste: () => undefined,
			extensionTerminalInputSubscriptions: new Set(),
		});
		const stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		renderer.addChild(component);
		if (!isViewportTUI(renderer)) throw new Error("expected fullscreen renderer");
		renderer.setLayoutRoot(component);
		renderer.start();
		await terminal.waitForRender();

		const prototype = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: typeof context, output: "transcript" | "resume-hint"): void;
		};
		prototype.stopInteractiveTui.call(context, "transcript");
		await terminal.flush();

		expect(context.renderer.mode).toBe("regular");
		expect(terminal.getScrollBuffer().join("\n")).toContain("FINAL TRANSCRIPT");
		expect([terminal.startCount, terminal.stopCount]).toEqual([1, 2]);
	});
});

describe("InteractiveMode active views", () => {
	it("mounts a bounded fullscreen selector and restores the conversation descriptor", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const main = { render: () => ["MAIN"], invalidate: () => {} } satisfies Component;
		const editor = {
			focused: false,
			render: () => ["EDITOR"],
			invalidate: () => {},
		} satisfies Component & { focused: boolean };
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const conversationView = {
			regularComponents: [main, editorContainer],
			fullscreenRoot: new VStack([{ component: main, basis: 0, grow: 1, minSize: 0 }, editorContainer]),
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			ui,
			activeView: conversationView,
			conversationView,
			planDetails: undefined,
			editor,
			editorContainer,
			dismissSubagentInspector: undefined,
		});
		const prototype = InteractiveMode.prototype as unknown as {
			activateView(this: typeof context, view: typeof conversationView, focus: Component | null): void;
			showSelector(
				this: typeof context,
				create: (done: () => void) => { component: Component; focus: Component },
			): void;
		};
		prototype.activateView.call(context, conversationView, editor);
		ui.start();
		try {
			await terminal.waitForRender();
			let close: () => void = () => undefined;
			const selector = {
				focused: false,
				render: () => ["SELECTOR"],
				invalidate: () => {},
			} satisfies Component & { focused: boolean };
			prototype.showSelector.call(context, (done) => {
				close = done;
				return { component: selector, focus: selector };
			});
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("SELECTOR");
			expect(terminal.getViewport().join("\n")).not.toContain("MAIN");
			expect(selector.focused).toBe(true);

			close();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("MAIN");
			expect(editor.focused).toBe(true);
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});
});

describe("createInteractiveTuiReference", () => {
	it("rebinds a previously-read method after renderer replacement", () => {
		const regularRequestRender = vi.fn();
		const fullscreenRequestRender = vi.fn();
		let renderer = { requestRender: regularRequestRender } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const requestRender = tui.requestRender;

		requestRender();
		renderer = { requestRender: fullscreenRequestRender } as unknown as TUI;
		requestRender(true);

		expect(regularRequestRender).toHaveBeenCalledOnce();
		expect(fullscreenRequestRender).toHaveBeenCalledWith(true);
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		const clipboard = await import("../src/utils/clipboard.ts");
		const readClipboardText = vi.spyOn(clipboard, "readClipboardText").mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
		readClipboardText.mockRestore();
	});
});
