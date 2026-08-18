/**
 * Finding P9: once a {kind:"truncated"} viewer event latches this.truncated,
 * handleViewerEvent short-circuits at `if (this.truncated) return;` (drain-viewer.ts:89)
 * BEFORE the switch, so a subsequent `agent_end` never reaches the case that sets
 * the loader message to the "finished" label. This test asserts the CORRECT behavior:
 * after truncated -> agent_end the loader should reflect the remote turn finishing.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getMarkdownTheme, initTheme } from "../src/core/theme/runtime.ts";
import { DrainViewerComponent, type DrainViewerOptions } from "../src/modes/interactive/drain-viewer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Minimal TUI double: the Loader only needs requestRender().
const tuiDouble = { requestRender: vi.fn() } as never;

function makeViewer(): DrainViewerComponent {
	const options: DrainViewerOptions = {
		markdownTheme: getMarkdownTheme(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		showImages: false,
		imageWidthCells: 40,
		cwd: "/tmp",
		getToolDefinition: () => undefined,
	};
	return new DrainViewerComponent(tuiDouble, options);
}

const viewers: DrainViewerComponent[] = [];

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	// Stop any spinner intervals to avoid leaked timers between tests.
	for (const v of viewers.splice(0)) {
		v.finish();
	}
});

describe("P9: truncated latch must not swallow agent_end loader update", () => {
	it("updates the loader to the finished label after truncated then agent_end", () => {
		const viewer = makeViewer();
		viewers.push(viewer);

		const initial = stripAnsi(viewer.render(80).lines.join("\n"));
		// Sanity: the initial attaching label is present.
		expect(initial).toContain("finishing remote turn");

		// Daemon reports the buffer overflowed: spinner-only from here on.
		viewer.handleViewerEvent({ kind: "truncated" });

		// The remote turn then finishes. The correct behavior is for the loader
		// message to advance to the "finished / taking over" label.
		viewer.handleViewerEvent({ type: "agent_end" });

		const rendered = stripAnsi(viewer.render(80).lines.join("\n"));
		// EXPECTED (bug absent): agent_end updated the loader message.
		expect(rendered).toContain("Remote turn finished");
	});
});
