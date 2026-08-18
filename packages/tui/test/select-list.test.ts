import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

const lineAt = (lines: readonly string[], index: number): string => {
	const line = lines[index];
	assert.ok(line, `Expected rendered line at index ${index}`);
	return line;
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100).lines;

		assert.ok(rendered.length > 0);
		const firstLine = lineAt(rendered, 0);
		assert.ok(!firstLine.includes("\n"));
		assert.ok(firstLine.includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80).lines;

		assert.equal(
			visibleIndexOf(lineAt(rendered, 0), "short description"),
			visibleIndexOf(lineAt(rendered, 1), "long description"),
		);
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80).lines;

		assert.equal(lineAt(rendered, 0).indexOf("first"), 14);
		assert.equal(lineAt(rendered, 1).indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80).lines;

		assert.equal(visibleIndexOf(lineAt(rendered, 0), "first"), 22);
		assert.equal(visibleIndexOf(lineAt(rendered, 1), "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80).lines;

		assert.ok(lineAt(rendered, 0).includes("…"));
		assert.equal(visibleIndexOf(lineAt(rendered, 0), "first"), visibleIndexOf(lineAt(rendered, 1), "second"));
	});
});
