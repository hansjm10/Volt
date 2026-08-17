import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/index.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Editor frame", () => {
	it("renders a responsive top-border label without changing the frame width", () => {
		const width = 40;
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme, {
			topBorderLabel: "ASK VOLT",
		});

		const topBorder = editor.render(width)[0]!;
		const plainBorder = stripVTControlCharacters(topBorder);

		assert.ok(plainBorder.startsWith("╭─ ASK VOLT "));
		assert.ok(plainBorder.endsWith("╮"));
		assert.strictEqual(visibleWidth(topBorder), width);
	});

	it("updates and removes the top-border label", () => {
		const width = 24;
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme);

		editor.setTopBorderLabel("SHELL");
		assert.ok(stripVTControlCharacters(editor.render(width)[0]!).startsWith("╭─ SHELL "));

		editor.setTopBorderLabel(undefined);
		assert.strictEqual(stripVTControlCharacters(editor.render(width)[0]!), `╭${"─".repeat(width - 2)}╮`);
	});

	it("shows the placeholder only while the editor is empty", () => {
		const width = 40;
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme, {
			placeholder: "Type a request or / for commands",
		});

		assert.ok(stripVTControlCharacters(editor.render(width)[1]!).includes("Type a request"));

		editor.setText("hello");
		assert.ok(!stripVTControlCharacters(editor.render(width)[1]!).includes("Type a request"));
	});
});
