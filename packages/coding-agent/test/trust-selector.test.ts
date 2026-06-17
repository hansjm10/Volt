import { setKeybindings } from "@earendil-works/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getProjectTrustOptions, getProjectTrustParentPath } from "../src/core/trust-manager.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function getProjectTrustPath(cwd: string): string {
	const savedPath = getProjectTrustOptions(cwd)[0]?.savedPath;
	if (savedPath === undefined) {
		throw new Error("Missing default project trust path");
	}
	return savedPath;
}

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("marks the saved trusted decision", () => {
		const cwd = "/project";
		const trustPath = getProjectTrustPath(cwd);
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: trustPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (${trustPath})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("Trust ✓");
		expect(output).not.toContain("Do not trust ✓");
	});

	it("selects a trust decision", () => {
		const cwd = "/project";
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [{ path: getProjectTrustPath(cwd), decision: true }],
		});
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project/nested",
			savedDecision: { path: "/parent", decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Saved decision: trusted (inherited from /parent)");
	});

	it("adds a trust parent option", () => {
		const cwd = "/parent/project";
		const trustPath = getProjectTrustPath(cwd);
		const parentPath = getProjectTrustParentPath(cwd)!;
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
		expect(output).toContain(`Trust parent folder (${parentPath}) ✓`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
		});
	});
});
