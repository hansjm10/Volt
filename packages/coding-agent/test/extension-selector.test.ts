import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function makeOptions(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `branch-${String(i).padStart(2, "0")}`);
}

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("windows long lists and shows a position indicator", () => {
		const options = makeOptions(40);
		const selector = new ExtensionSelectorComponent(
			"Select base branch",
			options,
			() => {},
			() => {},
		);

		const rendered = stripAnsi(selector.render(80).lines.join("\n"));
		const shown = options.filter((option) => rendered.includes(option));

		// Only a bounded window is rendered, not the entire 40-item list.
		expect(shown.length).toBeLessThan(options.length);
		expect(shown.length).toBeGreaterThanOrEqual(10);
		expect(rendered).toContain("(1/40)");
	});

	it("renders all options without an indicator for short lists", () => {
		const options = ["Uncommitted changes", "Against base branch", "GitHub pull request"];
		const selector = new ExtensionSelectorComponent(
			"Review what?",
			options,
			() => {},
			() => {},
		);

		const rendered = stripAnsi(selector.render(80).lines.join("\n"));

		for (const option of options) {
			expect(rendered).toContain(option);
		}
		expect(rendered).not.toMatch(/\(\d+\/\d+\)/);
	});

	it("scrolls the window as the selection moves down", () => {
		const options = makeOptions(40);
		const selector = new ExtensionSelectorComponent(
			"Select base branch",
			options,
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(80).lines.join("\n"))).toContain("branch-00");

		// Move the selection to the last item.
		for (let i = 0; i < options.length - 1; i++) {
			selector.handleInput("j");
		}

		const scrolled = stripAnsi(selector.render(80).lines.join("\n"));
		expect(scrolled).toContain("branch-39");
		expect(scrolled).not.toContain("branch-00");
		expect(scrolled).toContain("(40/40)");
	});
});
