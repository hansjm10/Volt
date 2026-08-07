import { setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PlanningState, PlanPhase, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsAction } from "../src/modes/interactive/components/plan-status.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function planning(phase: PlanPhase, stepCount = 3): PlanningState {
	const execution =
		phase === "active" || phase === "completed" || phase === "handed_off"
			? {
					id: "execution-1",
					approvedRevision: 4,
					strategy: "new_session" as const,
					sourceSessionId: "source-session",
					targetSessionId: "target-session",
				}
			: undefined;
	const plan: PlanState = {
		id: "plan-1",
		revision: 4,
		phase,
		title: `${phase} lifecycle title`,
		summary: `Canonical ${phase} lifecycle summary`,
		steps: Array.from({ length: stepCount }, (_, index) => ({
			id: `step-${index + 1}`,
			text: `Lifecycle step ${index + 1}`,
			status: index === 0 ? ("completed" as const) : index === 1 ? ("in_progress" as const) : ("pending" as const),
			...(index === 0 ? { note: "Observed verification note" } : {}),
		})),
		...(execution ? { execution } : {}),
	};
	return { mode: phase === "draft" || phase === "ready" ? "plan" : "build", plan };
}

function createInspector(
	state: PlanningState,
	options: {
		actions?: PlanDetailsAction[];
		onReturnFocus?: () => void;
		onToggleFocus?: () => void;
		requestRender?: () => void;
	} = {},
): PlanInspectorComponent {
	const inspector = new PlanInspectorComponent({
		planning: state,
		onAction: (action) => options.actions?.push(action),
		onReturnFocus: options.onReturnFocus ?? (() => undefined),
		onToggleFocus: options.onToggleFocus ?? (() => undefined),
		requestRender: options.requestRender ?? (() => undefined),
	});
	inspector.setViewportRows(22);
	return inspector;
}

function text(inspector: PlanInspectorComponent, width = 60): string {
	return inspector.render(width).map(stripAnsi).join("\n");
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PlanInspectorComponent", () => {
	it("renders empty Plan-mode draft state from PlanningState", () => {
		const output = text(createInspector({ mode: "plan", plan: null }));
		expect(output).toContain("PLAN · DRAFT");
		expect(output).toContain("No structured plan yet");
		expect(output.replace(/\s+/g, " ")).toContain("initial research orientation");
	});

	it("renders every canonical lifecycle without proof-of-concept controls", () => {
		for (const phase of ["draft", "ready", "active", "completed", "handed_off"] as const) {
			const output = text(createInspector(planning(phase)));
			expect(output).toContain(`${phase} lifecycle title`);
			expect(output).toContain(`Canonical ${phase} lifecycle summary`);
			expect(output).toContain("1. ");
			expect(output).toContain("Observed verification note");
			expect(output).not.toContain("Elapsed");
			expect(output).not.toContain("Pause");
			expect(output).not.toContain("Maximize");
			if (phase === "active") expect(output).toContain("EXECUTING");
			if (phase === "completed") expect(output).toContain("COMPLETE");
			if (phase === "handed_off") expect(output).toContain("Execution session: target-session");
		}
	});

	it("shows progress and focused state while bounding every line", () => {
		const inspector = createInspector(planning("active"));
		inspector.focused = true;
		const lines = inspector.render(48);
		const output = lines.map(stripAnsi).join("\n");
		expect(output).toContain("FOCUSED");
		expect(output).toContain("1/3 complete · 33%");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
	});

	it("routes ready actions without changing planning state", () => {
		const actions: PlanDetailsAction[] = [];
		const state = planning("ready");
		const inspector = createInspector(state, { actions });
		inspector.render(60);
		inspector.handleInput("\r");
		inspector.handleInput("\x1b[C");
		inspector.render(60);
		inspector.handleInput("\r");
		inspector.handleInput("\x1b[C");
		inspector.render(60);
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session", "change"]);
		expect(state.plan?.phase).toBe("ready");
	});

	it("keeps the selected ready action visible before accepting confirmation", () => {
		const actions: PlanDetailsAction[] = [];
		const inspector = createInspector(planning("ready"), { actions });
		inspector.setViewportRows(7);
		let output = text(inspector, 48);
		expect(output).toContain("> Execute Plan");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);

		inspector.handleInput("\x1b[C");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);
		output = text(inspector, 48);
		expect(output).toContain("> Execute Plan & Clear Context");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session"]);

		inspector.setViewportRows(3);
		text(inspector, 48);
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session"]);
	});

	it("scrolls long wrapped content and reports page position", () => {
		const state = planning("active", 30);
		state.plan!.steps[0]!.text =
			"A very long completed lifecycle step that wraps across several rows before the remaining checklist can be shown";
		const inspector = createInspector(state);
		inspector.setViewportRows(16);
		const before = text(inspector, 48);
		expect(before).toContain("rows 1–");
		expect(before).toContain("very long completed lifecycle");
		inspector.handleInput("\x1b[6~");
		const after = text(inspector, 48);
		expect(after).toMatch(/rows (?!1–)\d+–/);
		expect(after).not.toContain("active lifecycle title");
	});

	it("routes focus controls through configurable keybindings", () => {
		const toggled = vi.fn();
		const returned = vi.fn();
		setKeybindings(new KeybindingsManager({ "app.plan.togglePane": "alt+x" }));
		try {
			const inspector = createInspector(planning("active"), {
				onToggleFocus: toggled,
				onReturnFocus: returned,
			});
			inspector.handleInput("\x1bx");
			inspector.handleInput("\x1b");
			expect(toggled).toHaveBeenCalledTimes(1);
			expect(returned).toHaveBeenCalledTimes(1);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	it("uses ASCII status markers when requested", () => {
		vi.stubEnv("VOLT_ASCII", "1");
		const output = text(createInspector(planning("active")));
		expect(output).toContain("[x]");
		expect(output).toContain("[>]");
		expect(output).toContain("[ ]");
	});
});
