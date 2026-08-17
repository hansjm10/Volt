import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Editor } from "../src/index.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("TUI stop cleanup", () => {
	it("restores the main screen and capabilities when fullscreen transcript rendering throws", async () => {
		const savedCapabilities = { images: "iterm2" as const, trueColor: true, hyperlinks: true };
		setCapabilities(savedCapabilities);
		try {
			const terminal = new VirtualTerminal(40, 6);
			terminal.write("shell prompt");
			await terminal.flush();

			let throwOnRender = false;
			const component: Component = {
				render: () => {
					if (throwOnRender) throw new Error("stop render failed");
					return ["fullscreen content"];
				},
				invalidate: () => {},
			};
			const tui = new TuiAltScreen(terminal);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(getCapabilities().images, null);

			throwOnRender = true;
			assert.throws(() => tui.stop(), /stop render failed/);
			await terminal.flush();

			assert.ok(terminal.getViewport().some((line) => line.includes("shell prompt")));
			assert.deepStrictEqual(getCapabilities(), savedCapabilities);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains the glyph under a focused editor cursor when regular mode stops", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("alpha");
		editor.handleInput("\x01");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		tui.stop();
		await terminal.flush();

		const retainedOutput = terminal.getScrollBuffer();
		assert.ok(
			retainedOutput.some((line) => line.includes("alpha")),
			`expected retained output to contain the complete draft: ${JSON.stringify(retainedOutput)}`,
		);
	});
});
