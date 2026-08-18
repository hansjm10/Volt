import { describe, expect, test } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("renders default extension messages as a quiet labeled transcript entry", () => {
		initTheme("dark");
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "session",
			content: "Context compacted",
			display: true,
			timestamp: 0,
		});

		const lines = component.render(40).lines.map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("session");
		expect(lines[2]).toContain("Context compacted");
	});
});
