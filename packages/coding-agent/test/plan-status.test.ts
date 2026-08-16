import { TuiAltScreen, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	type PlanDetailsAction,
	PlanDetailsComponent,
	PlanStatusComponent,
} from "../src/modes/interactive/components/plan-status.ts";

function readyPlan(stepCount = 12): PlanState {
	return {
		id: "plan-1",
		revision: 4,
		phase: "ready",
		title: "Native Plan Mode",
		summary: "Keep planning durable and responsive.",
		steps: Array.from({ length: stepCount }, (_, index) => ({
			id: `step-${index + 1}`,
			text: `Plan step ${index + 1}`,
			status: index < 4 ? ("completed" as const) : index === 4 ? ("in_progress" as const) : ("pending" as const),
		})),
	};
}

function longPlan(): PlanState {
	return {
		...readyPlan(3),
		title: "A deliberately long Plan title that must wrap instead of disappearing beyond the terminal edge",
		summary:
			"Keep every decision-complete finding visible in compact terminals, including the final summary words SUMMARY_TAIL.",
		steps: [
			{
				id: "step-1",
				text: "Render a long completed checklist item across multiple visual rows without truncating its final token STEP_TAIL",
				status: "completed",
				note: "Verified with deterministic narrow and wide captures NOTE_TAIL",
			},
			{
				id: "step-2",
				text: "Keep the active implementation step visually distinct",
				status: "in_progress",
			},
			{ id: "step-3", text: "Leave remaining work visible", status: "pending" },
		],
	};
}

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalized(lines: string[]): string {
	return plain(lines).replace(/\s+/g, " ");
}

function createDetails(
	plan: PlanState,
	widthRows = 24,
	onAction: (action: PlanDetailsAction) => void = () => undefined,
) {
	return new PlanDetailsComponent({
		plan,
		getTerminalRows: () => widthRows,
		onAction,
		onClose: () => undefined,
		requestRender: () => undefined,
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Plan TUI components", () => {
	it("hides an empty Build status and bounds the strip at narrow widths", () => {
		initTheme("dark");
		expect(new PlanStatusComponent({ mode: "build", plan: null }).render(80)).toEqual([]);

		const rendered = new PlanStatusComponent({ mode: "plan", plan: readyPlan() }).render(80);
		expect(rendered).toHaveLength(1);
		expect(plain(rendered)).toContain("PLAN READY");
		expect(plain(rendered)).toContain("4/12 · 33%");
	});

	it("wraps all authored plan content at compact and wide widths", () => {
		initTheme("dark");
		for (const width of [80, 120]) {
			const details = createDetails(longPlan(), 60);
			const rendered = details.render(width);
			const text = normalized(rendered);
			expect(text).toContain("SUMMARY_TAIL");
			expect(text).toContain("STEP_TAIL");
			expect(text).toContain("NOTE_TAIL");
			expect(text).toContain("Execute Plan");
			expect(text).toContain("Execute Plan & Clear Context");
			expect(text).toContain("Change Plan");
			for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("uses terminal height for the rendered-row viewport and reports its position", () => {
		initTheme("light");
		const details = createDetails(readyPlan(40), 36);
		const rendered = plain(details.render(120));
		expect(rendered).toContain("rows 1–22/42");
		expect(rendered).toContain("Plan step 20");
		expect(rendered).not.toContain("Plan step 21");
	});

	it("scrolls by rendered visual rows rather than logical checklist items", () => {
		initTheme("light");
		let renders = 0;
		const plan = readyPlan(30);
		plan.summary = "A summary that occupies the first rendered body row.";
		plan.steps[0]!.text =
			"A first checklist item that wraps over several visual rows at compact width and therefore consumes viewport space before later steps.";
		const details = new PlanDetailsComponent({
			plan,
			getTerminalRows: () => 24,
			onAction: () => undefined,
			onClose: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});
		const before = plain(details.render(80));
		expect(before).toContain("rows 1–8/");
		expect(before).toContain("first checklist item");

		details.handleInput("\u001b[6~");
		const after = plain(details.render(80));
		expect(renders).toBe(1);
		expect(after).toContain("rows 9–16/");
		expect(after).not.toContain("A summary that occupies");
		expect(after).toContain("Plan step 6");
	});

	it("keeps fullscreen plan headers and actions fixed while its body scrolls", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(80, 16);
		const details = createDetails(readyPlan(40), 16);
		details.setFullscreenActive(true);
		const tui = new TuiAltScreen(terminal, false, "/tmp", { mouse: false });
		tui.addChild(details);
		tui.setLayoutRoot(details.getFullscreenLayout());
		tui.setFocus(details);
		tui.start();
		try {
			await terminal.waitForRender();
			const before = plain(terminal.getViewport());
			expect(before).toContain("Native Plan Mode");
			expect(before).toContain("Execute Plan");
			expect(before).toContain("Plan step 1");

			terminal.sendInput("\u001b[6~");
			await terminal.waitForRender();
			const after = plain(terminal.getViewport());
			expect(after).toContain("Native Plan Mode");
			expect(after).toContain("Execute Plan");
			expect(after).not.toContain("Plan step 1");
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("moves through ready actions and confirms the exact selected strategy", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		let renders = 0;
		const details = new PlanDetailsComponent({
			plan: readyPlan(),
			getTerminalRows: () => 36,
			onAction: (action) => actions.push(action),
			onClose: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});

		details.handleInput("\u001b[C");
		details.handleInput("\r");
		details.handleInput("\u001b[C");
		details.handleInput("\r");

		expect(renders).toBe(2);
		expect(actions).toEqual(["new_session", "change"]);
	});

	it("renders Unicode markers normally and ASCII markers when requested", () => {
		initTheme("dark");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("TERM_PROGRAM", "iTerm.app");
		vi.stubEnv("VOLT_ASCII", "0");
		const unicode = plain(createDetails(longPlan(), 60).render(120));
		expect(unicode).toContain("✓");
		expect(unicode).toContain("→");
		expect(unicode).toContain("○");

		vi.stubEnv("VOLT_ASCII", "1");
		const ascii = plain(createDetails(longPlan(), 60).render(120));
		expect(ascii).toContain("[x]");
		expect(ascii).toContain("[>]");
		expect(ascii).toContain("[ ]");
	});
});
