import { setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { Component } from "../../tui/src/tui.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PlanningState, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsAction } from "../src/modes/interactive/components/plan-status.ts";
import {
	getResponsivePlanDimensions,
	ResponsivePlanLayoutComponent,
} from "../src/modes/interactive/components/responsive-plan-layout.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class LinesComponent implements Component {
	lines: string[];
	widths: number[] = [];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.widths.push(width);
		return this.lines;
	}

	invalidate(): void {}
}

class FullWidthFooter implements Component {
	render(width: number): string[] {
		return ["F".repeat(width)];
	}

	invalidate(): void {}
}

function plan(phase: PlanState["phase"] = "active"): PlanState {
	const execution =
		phase === "active" || phase === "completed" || phase === "handed_off"
			? {
					id: "execution-1",
					approvedRevision: 2,
					strategy: "retain_context" as const,
					sourceSessionId: "source-session",
					targetSessionId: "target-session",
				}
			: undefined;
	return {
		id: "plan-1",
		revision: 2,
		phase,
		title: "Responsive Plan",
		summary: "Keep the conversation and canonical plan visible.",
		steps: [
			{ id: "step-1", text: "Finished work", status: "completed", note: "Verified" },
			{ id: "step-2", text: "Current work", status: "in_progress" },
			{ id: "step-3", text: "Remaining work", status: "pending" },
		],
		...(execution ? { execution } : {}),
	};
}

function createLayout(options: {
	columns: number;
	rows: number;
	planning?: PlanningState;
	transcript?: LinesComponent;
	controls?: LinesComponent[];
	compact?: LinesComponent[];
	footer?: Component;
	actions?: PlanDetailsAction[];
}) {
	let rows = options.rows;
	const planning = options.planning ?? { mode: "build", plan: plan() };
	const transcript = options.transcript ?? new LinesComponent(["conversation"]);
	const controls = options.controls ?? [new LinesComponent(["editor"])];
	const compact = options.compact ?? [transcript, ...controls];
	const inspector = new PlanInspectorComponent({
		planning,
		onAction: (action) => options.actions?.push(action),
		onReturnFocus: () => undefined,
		onToggleFocus: () => undefined,
		requestRender: () => undefined,
	});
	const splitChanges: boolean[] = [];
	const preserveScrollbackChanges: boolean[] = [];
	const layout = new ResponsivePlanLayoutComponent({
		planning,
		transcriptComponents: [transcript],
		controlComponents: controls,
		compactComponents: compact,
		inspector,
		footer: options.footer ?? new FullWidthFooter(),
		getTerminalRows: () => rows,
		onSplitChange: (split, preserveScrollback) => {
			splitChanges.push(split);
			preserveScrollbackChanges.push(preserveScrollback);
		},
	});
	return {
		layout,
		inspector,
		transcript,
		controls,
		splitChanges,
		preserveScrollbackChanges,
		setRows: (next: number) => {
			rows = next;
		},
	};
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("responsive plan dimensions", () => {
	const planning: PlanningState = { mode: "build", plan: plan() };

	it("uses the exact column and row boundaries", () => {
		expect(getResponsivePlanDimensions(128, 24, planning)).toBeUndefined();
		expect(getResponsivePlanDimensions(129, 23, planning)).toBeUndefined();
		expect(getResponsivePlanDimensions(129, 24, planning)).toEqual({
			conversationColumns: 80,
			dividerColumns: 1,
			planColumns: 48,
		});
	});

	it("caps the plan pane at 40 percent and 72 columns while preserving 80 conversation columns", () => {
		expect(getResponsivePlanDimensions(130, 24, planning)).toEqual({
			conversationColumns: 80,
			dividerColumns: 1,
			planColumns: 49,
		});
		expect(getResponsivePlanDimensions(180, 24, planning)).toEqual({
			conversationColumns: 107,
			dividerColumns: 1,
			planColumns: 72,
		});
		expect(getResponsivePlanDimensions(220, 24, planning)).toEqual({
			conversationColumns: 147,
			dividerColumns: 1,
			planColumns: 72,
		});
	});

	it("requires Plan mode or canonical plan state", () => {
		expect(getResponsivePlanDimensions(160, 30, { mode: "build", plan: null })).toBeUndefined();
		expect(getResponsivePlanDimensions(160, 30, { mode: "plan", plan: null })).toBeDefined();
	});
});

describe("ResponsivePlanLayoutComponent", () => {
	it("retains compact flow below either breakpoint", () => {
		const compactOnly = new LinesComponent(["COMPACT_PLAN_STATUS"]);
		for (const [columns, rows] of [
			[128, 24],
			[129, 23],
		] as const) {
			const { layout } = createLayout({ columns, rows, compact: [compactOnly] });
			const rendered = layout.render(columns).map(stripAnsi);
			expect(rendered).toContain("COMPACT_PLAN_STATUS");
			expect(rendered.at(-1)).toBe("F".repeat(columns));
		}
	});

	it("pins controls and inspector while retaining older conversation rows in scrollback", () => {
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR_TOP", "EDITOR_BOTTOM"]);
		const { layout } = createLayout({ columns: 160, rows: 24, transcript, controls: [editor] });
		const rendered = layout.render(160).map(stripAnsi);
		const viewport = rendered.slice(-24);
		const output = rendered.join("\n");
		expect(rendered.length).toBeGreaterThan(24);
		expect(output).toContain("message-1");
		expect(viewport.join("\n")).toContain("message-40");
		expect(viewport.join("\n")).toContain("EDITOR_BOTTOM");
		expect(viewport.join("\n")).toContain("Responsive Plan");
		expect(viewport.at(-1)).toBe("F".repeat(160));
		for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
	});

	it("renders extensions at conversation width and a custom footer at full width", () => {
		const header = new LinesComponent(["EXTENSION_HEADER"]);
		const widget = new LinesComponent(["EXTENSION_WIDGET"]);
		const editor = new LinesComponent(["EXTENSION_EDITOR"]);
		const footer = new LinesComponent(["EXTENSION_FOOTER"]);
		const planning: PlanningState = { mode: "plan", plan: plan("draft") };
		const inspector = new PlanInspectorComponent({
			planning,
			onAction: () => undefined,
			onReturnFocus: () => undefined,
			onToggleFocus: () => undefined,
			requestRender: () => undefined,
		});
		const layout = new ResponsivePlanLayoutComponent({
			planning,
			transcriptComponents: [header],
			controlComponents: [widget, editor],
			compactComponents: [header, widget, editor],
			inspector,
			footer,
			getTerminalRows: () => 24,
			onSplitChange: () => undefined,
		});
		const rendered = layout.render(129).map(stripAnsi).join("\n");
		expect(rendered).toContain("EXTENSION_HEADER");
		expect(rendered).toContain("EXTENSION_WIDGET");
		expect(rendered).toContain("EXTENSION_EDITOR");
		expect(rendered).toContain("EXTENSION_FOOTER");
		expect(header.widths).toEqual([80]);
		expect(widget.widths).toEqual([80]);
		expect(editor.widths).toEqual([80]);
		expect(footer.widths).toEqual([129]);
	});

	it("preserves Kitty image placement and reserved rows without composing pane text over them", () => {
		const image = "\x1b_Ga=T,f=100,q=2,C=1,c=2,r=3,i=42;AAAA\x1b\\";
		const transcript = new LinesComponent(["before", image, "", "", "after"]);
		const { layout } = createLayout({ columns: 129, rows: 24, transcript });
		const rendered = layout.render(129);
		const imageIndex = rendered.findIndex((line) => line.includes("i=42"));
		expect(imageIndex).toBeGreaterThanOrEqual(0);
		expect(rendered[imageIndex]).toBe(image);
		expect(rendered[imageIndex + 1]).toBe("");
		expect(rendered[imageIndex + 2]).toBe("");
		expect(stripAnsi(rendered[imageIndex + 3] ?? "")).toContain("after");
	});

	it("keeps the selected ready action visible beside constrained Kitty and iTerm images", () => {
		const blankImageRows = Array.from({ length: 15 }, () => "");
		const kittyImage = ["\x1b_Ga=T,f=100,q=2,C=1,c=2,r=16,i=42;AAAA\x1b\\", ...blankImageRows];
		const iTermImage = [...blankImageRows, "\x1b[15A\x1b]1337;File=inline=1:AAAA\x07"];
		for (const imageBlock of [kittyImage, iTermImage]) {
			const transcript = new LinesComponent(["before", ...imageBlock, "after"]);
			const planning: PlanningState = { mode: "plan", plan: plan("ready") };
			const controls = [new LinesComponent(["CONTROL_1", "CONTROL_2", "CONTROL_3"])];
			const actions: PlanDetailsAction[] = [];
			const { layout, inspector } = createLayout({
				columns: 129,
				rows: 24,
				transcript,
				planning,
				controls,
				actions,
			});
			const output = layout.render(129).map(stripAnsi).join("\n");
			expect(output).toContain("> Execute Plan");
			expect(output).toContain("CONTROL_3");
			inspector.handleInput("\r");
			expect(actions).toEqual(["retain_context"]);
		}
	});

	it("keeps the inspector present through streaming-like transcript and plan updates", () => {
		const transcript = new LinesComponent(["assistant chunk 1"]);
		const planning: PlanningState = { mode: "build", plan: plan("active") };
		const { layout, inspector } = createLayout({ columns: 160, rows: 24, planning, transcript });
		expect(layout.render(160).map(stripAnsi).join("\n")).toContain("Current work");
		transcript.lines.push("assistant chunk 2");
		const updated = plan("active");
		updated.steps[1] = { ...updated.steps[1]!, status: "completed", note: "Stream-safe update" };
		updated.steps[2] = { ...updated.steps[2]!, status: "in_progress" };
		const nextPlanning = { mode: "build" as const, plan: updated };
		inspector.setPlanning(nextPlanning);
		layout.setPlanning(nextPlanning);
		const output = layout.render(160).map(stripAnsi).join("\n");
		expect(output).toContain("assistant chunk 2");
		expect(output).toContain("Stream-safe update");
		expect(output).toContain("Remaining work");
	});

	it("reports resize transitions without requesting state-only scrollback preservation", () => {
		const { layout, setRows, splitChanges, preserveScrollbackChanges } = createLayout({
			columns: 129,
			rows: 24,
		});
		layout.render(129);
		setRows(23);
		layout.render(129);
		setRows(24);
		layout.render(129);
		expect(splitChanges).toEqual([false, true]);
		expect(preserveScrollbackChanges).toEqual([false, false]);
	});

	it("requests scrollback preservation for state-only layout transitions", () => {
		const initial: PlanningState = { mode: "build", plan: null };
		const { layout, inspector, splitChanges, preserveScrollbackChanges } = createLayout({
			columns: 160,
			rows: 24,
			planning: initial,
		});
		layout.render(160);
		const splitPlanning: PlanningState = { mode: "plan", plan: null };
		layout.setPlanning(splitPlanning);
		inspector.setPlanning(splitPlanning);
		layout.render(160);
		layout.setPlanning(initial);
		inspector.setPlanning(initial);
		layout.render(160);
		expect(splitChanges).toEqual([true, false]);
		expect(preserveScrollbackChanges).toEqual([true, true]);
	});
});
