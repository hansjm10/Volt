import { describe, expect, test } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
describe("UserMessageComponent", () => {
	test("renders a quiet user-message rail while preserving OSC 133 zones", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20).lines;

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(stripAnsi(lines[1])).toContain("│ hello");
		expect(stripAnsi(lines[1])).not.toContain("YOU");
		expect(lines[1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});
});
