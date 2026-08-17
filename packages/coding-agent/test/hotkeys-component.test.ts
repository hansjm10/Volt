import { visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { HotkeysComponent } from "../src/modes/interactive/components/hotkeys.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("HotkeysComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps title, position, and controls visible in a constrained viewport", () => {
		const component = new HotkeysComponent(
			[
				{
					title: "Navigation",
					entries: Array.from({ length: 10 }, (_, index) => ({
						key: `Key ${index + 1}`,
						action: `Action ${index + 1}`,
					})),
				},
				{ title: "Editing", entries: [{ key: "Enter", action: "Send message" }] },
			],
			() => 24,
			() => {},
			() => {},
		);

		const lines = component.render(80);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("Keyboard Shortcuts");
		expect(text).toContain("1–12/13");
		expect(text).toContain("NAVIGATION");
		expect(text).toContain("close");
		expect(text).toContain("scroll");
		expect(text).toContain("page");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});
