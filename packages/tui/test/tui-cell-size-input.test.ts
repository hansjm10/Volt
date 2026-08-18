import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TuiMainScreen } from "../src/index.ts";
import { getCellDimensions, resetCapabilitiesCache, setCellDimensions } from "../src/terminal-image.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
	if (value === undefined) Reflect.deleteProperty(process.env, name);
	else Reflect.set(process.env, name, value);
}

function withImageTerminal<T>(fn: () => T): T {
	const {
		TERM_PROGRAM: prevTermProgram,
		TERM: prevTerm,
		GHOSTTY_RESOURCES_DIR: prevGhosttyResourcesDir,
	} = process.env;

	Reflect.set(process.env, "TERM_PROGRAM", "ghostty");
	Reflect.deleteProperty(process.env, "TERM");
	Reflect.deleteProperty(process.env, "GHOSTTY_RESOURCES_DIR");
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		restoreEnvironmentVariable("TERM_PROGRAM", prevTermProgram);
		restoreEnvironmentVariable("TERM", prevTerm);
		restoreEnvironmentVariable("GHOSTTY_RESOURCES_DIR", prevGhosttyResourcesDir);
		resetCapabilitiesCache();
	}
}

describe("TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});
});
