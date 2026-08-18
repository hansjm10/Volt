import { visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { StartupHeaderComponent } from "../src/modes/interactive/components/logo.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createHeader(widthRows: number): StartupHeaderComponent {
	return new StartupHeaderComponent({
		version: "1.2.3",
		compactInstructions: "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
		expandedInstructions: "Expanded help",
		expansionHint: "Press ctrl+o for resources.",
		onboarding: "Ask Volt for help.",
		getTerminalRows: () => widthRows,
	});
}

describe("StartupHeaderComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps normal terminals focused on the compact startup lockup", () => {
		const lines = createHeader(36).render(120).lines;
		const text = lines.map(stripAnsi).join("\n");

		expect(text).toContain("VOLT v1.2.3");
		expect(text).not.toContain("______");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("does not orphan a compact shortcut action at narrow widths", () => {
		const lines = createHeader(24).render(80).lines.map(stripAnsi);

		expect(lines.some((line) => line.trim() === "more")).toBe(false);
		expect(lines.join("\n")).toContain("ctrl+o more");
	});

	it("uses the full wordmark only when both width and height are spacious", () => {
		const lines = createHeader(45).render(160).lines;
		const text = lines.map(stripAnsi).join("\n");

		expect(text).toContain("______");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
	});
});
