import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { visibleWidth } from "../src/utils.ts";

const theme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "→ ",
	hint: (text) => text,
	section: (text) => text,
};

describe("SettingsList", () => {
	it("renders section headings while keeping every line within width", () => {
		const width = 36;
		const list = new SettingsList(
			[
				{ id: "one", label: "First", currentValue: "true", section: "Agent" },
				{ id: "two", label: "Second", currentValue: "false", section: "Agent" },
				{ id: "three", label: "Third", currentValue: "auto", section: "Interface" },
			],
			5,
			theme,
			() => {},
			() => {},
		);

		const lines = list.render(width).lines;
		assert.ok(lines.some((line) => line.includes("AGENT")));
		assert.ok(lines.some((line) => line.includes("INTERFACE")));
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width);
		}
	});
});
