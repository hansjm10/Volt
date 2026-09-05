import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	Image,
	type RenderFrame,
	ScrollView,
	setKeybindings,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../../tui/src/terminal-image.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PlanningState, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { usesAsciiPlanMarkers } from "../src/modes/interactive/components/plan-content.ts";
import { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsAction } from "../src/modes/interactive/components/plan-status.ts";
import {
	getResponsivePlanDimensions,
	ResponsivePlanLayoutComponent,
} from "../src/modes/interactive/components/responsive-plan-layout.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class LinesComponent implements Component {
	lines: string[];
	images: RenderFrame["images"] = [];
	widths: number[] = [];

	constructor(lines: string[], images: RenderFrame["images"] = []) {
		this.lines = lines;
		this.images = images;
	}

	render(width: number): RenderFrame {
		this.widths.push(width);
		return createRenderFrame(this.lines, this.images);
	}

	invalidate(): void {}
}

class FullWidthFooter implements Component {
	render(width: number): RenderFrame {
		return createRenderFrame(["F".repeat(width)]);
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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
	fullscreenConversation?: Component;
	footer?: Component;
	actions?: PlanDetailsAction[];
	requestViewportReset?: () => void;
	onSplitChange?: (split: boolean, preserveScrollback: boolean) => void;
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
		fullscreenConversation: options.fullscreenConversation ?? new LinesComponent(["FULLSCREEN_CONVERSATION"]),
		inspector,
		footer: options.footer ?? new FullWidthFooter(),
		getTerminalColumns: () => options.columns,
		getTerminalRows: () => rows,
		requestViewportReset: options.requestViewportReset ?? (() => undefined),
		onSplitChange: (split, preserveScrollback) => {
			splitChanges.push(split);
			preserveScrollbackChanges.push(preserveScrollback);
			options.onSplitChange?.(split, preserveScrollback);
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

	it("keeps research and working drafts compact until the plan is reviewable", () => {
		expect(getResponsivePlanDimensions(160, 30, { mode: "build", plan: null })).toBeUndefined();
		expect(getResponsivePlanDimensions(160, 30, { mode: "plan", plan: null })).toBeUndefined();
		expect(getResponsivePlanDimensions(160, 30, { mode: "plan", plan: plan("draft") })).toBeUndefined();
		expect(getResponsivePlanDimensions(160, 30, { mode: "plan", plan: plan("ready") })).toBeDefined();
		expect(getResponsivePlanDimensions(160, 30, { mode: "build", plan: plan("active") })).toBeDefined();
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
			const rendered = layout.render(columns).lines.map(stripAnsi);
			expect(rendered).toContain("COMPACT_PLAN_STATUS");
			expect(rendered.at(-1)).toBe("F".repeat(columns));
		}
	});

	it("keeps a working draft in compact flow even when the terminal can split", () => {
		const compactOnly = new LinesComponent(["COMPACT_WORKING_DRAFT"]);
		const planning: PlanningState = { mode: "plan", plan: plan("draft") };
		const { layout } = createLayout({ columns: 160, rows: 30, planning, compact: [compactOnly] });
		const rendered = layout.render(160).lines.map(stripAnsi).join("\n");
		expect(rendered).toContain("COMPACT_WORKING_DRAFT");
		expect(rendered).not.toContain("Responsive Plan");
	});

	it("pins controls and inspector while retaining older conversation rows in scrollback", () => {
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR_TOP", "EDITOR_BOTTOM"]);
		const { layout } = createLayout({ columns: 160, rows: 24, transcript, controls: [editor] });
		const rendered = layout.render(160).lines.map(stripAnsi);
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

	it("uses native fullscreen layout, plan scrolling, and compact resize fallback", async () => {
		const readyPlan = plan("ready");
		readyPlan.steps = Array.from({ length: 40 }, (_, index) => ({
			id: `step-${index + 1}`,
			text: `Fullscreen plan step ${index + 1}`,
			status: index < 4 ? ("completed" as const) : index === 4 ? ("in_progress" as const) : ("pending" as const),
		}));
		const planning: PlanningState = { mode: "plan", plan: readyPlan };
		const terminal = new VirtualTerminal(160, 30);
		const { layout, inspector, splitChanges } = createLayout({
			columns: 160,
			rows: 30,
			planning,
			fullscreenConversation: new LinesComponent(["FULLSCREEN_CONVERSATION"]),
		});
		const tui = new TuiAltScreen(terminal, false, "/tmp", { mouse: false });
		tui.addChild(layout);
		tui.setLayoutRoot(layout.getFullscreenLayout());
		inspector.setFullscreenActive(true);
		tui.setFocus(inspector);
		tui.start();
		try {
			await terminal.waitForRender();
			const before = terminal.getViewport().map(stripAnsi).join("\n");
			expect(before).toContain("FULLSCREEN_CONVERSATION");
			expect(before).toContain("Responsive Plan");
			expect(before).toContain("rows 1–");
			expect(before).toContain("Execute Plan");
			expect(before).toContain(usesAsciiPlanMarkers() ? "|" : "│");
			expect(terminal.getViewport().at(-1)).toBe("F".repeat(160));

			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			const scrolled = terminal.getViewport().map(stripAnsi).join("\n");
			expect(scrolled).not.toContain("rows 1–");
			expect(scrolled).toContain("Fullscreen plan step 35");

			terminal.resize(128, 30);
			await terminal.waitForRender();
			const compact = terminal.getViewport().map(stripAnsi).join("\n");
			expect(compact).toContain("FULLSCREEN_CONVERSATION");
			expect(compact).not.toContain("Responsive Plan");
			expect(terminal.getViewport().at(-1)).toBe("F".repeat(128));
			expect(splitChanges).toEqual([false]);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps the selected plan pane searchable while the search overlay owns focus", async () => {
		const columns = 160;
		const rows = 30;
		const planning: PlanningState = { mode: "build", plan: plan("active") };
		const conversation = new ScrollView(new LinesComponent(["CONVERSATION ONLY"]));
		const terminal = new VirtualTerminal(columns, rows);
		const { layout, inspector } = createLayout({
			columns,
			rows,
			planning,
			fullscreenConversation: conversation,
		});
		const tui = new TuiAltScreen(terminal, false, "/tmp", { mouse: false });
		tui.addChild(layout);
		tui.setLayoutRoot(layout.getFullscreenLayout());
		inspector.setFullscreenActive(true);
		inspector.setSelected(true);
		tui.setFocus(inspector);
		tui.start();
		try {
			await terminal.waitForRender();
			expect(inspector.focused).toBe(true);

			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("Current work");
			await terminal.waitForRender();

			expect(inspector.focused).toBe(false);
			expect(terminal.getViewport().some((line) => line.includes("Find transcript") && line.includes("1/1"))).toBe(
				true,
			);

			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(inspector.focused).toBe(true);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps the fullscreen conversation dock aligned with the inspector footer", async () => {
		const columns = 191;
		const rows = 40;
		const planning: PlanningState = { mode: "plan", plan: plan("ready") };
		const compactStatus = new LinesComponent(["COMPACT_STATUS_TOP", "COMPACT_STATUS_BOTTOM"]);
		const editor = new LinesComponent(["EDITOR_TOP", "EDITOR_BOTTOM"]);
		const conversationBody = new LinesComponent(["FULLSCREEN_CONVERSATION"]);
		const terminal = new VirtualTerminal(columns, rows);
		let layout: ResponsivePlanLayoutComponent;
		const conversationDock = new VStack([
			{
				component: compactStatus,
				shrink: 2,
				minSize: 0,
				visible: () => !layout.isTerminalSplit(),
			},
			{ component: editor, shrink: 1, minSize: 1 },
		]);
		const fullscreenConversation = new VStack([
			{ component: conversationBody, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: conversationDock, shrink: 1, minSize: 0 },
		]);
		({ layout } = createLayout({
			columns,
			rows,
			planning,
			fullscreenConversation,
		}));
		const tui = new TuiAltScreen(terminal, false, "/tmp", { mouse: false });
		tui.addChild(layout);
		tui.setLayoutRoot(layout.getFullscreenLayout());
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport().map(stripAnsi);
			const editorBottomRow = viewport.findIndex((line) => line.includes("EDITOR_BOTTOM"));
			const inspectorFooterRow = viewport.findIndex((line) => line.includes("scroll") && line.includes("page"));
			const appFooterRow = viewport.findIndex((line) => line === "F".repeat(columns));
			expect(viewport.join("\n")).not.toContain("COMPACT_STATUS");
			expect(editorBottomRow).toBe(inspectorFooterRow);
			expect(inspectorFooterRow).toBe(appFooterRow - 1);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("leaves rows scrolled out of the viewport undecorated so scrollback stays readable", () => {
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR_TOP", "EDITOR_BOTTOM"]);
		const { layout } = createLayout({ columns: 160, rows: 24, transcript, controls: [editor] });
		const rendered = layout.render(160).lines.map(stripAnsi);
		const historical = rendered.slice(0, rendered.length - 24);
		const viewport = rendered.slice(-24);

		const divider = usesAsciiPlanMarkers() ? "|" : "\u2502";
		expect(historical.length).toBeGreaterThan(0);
		// Scrolled-off rows keep only conversation text: no divider and no plan-pane padding.
		for (const line of historical) {
			expect(line).not.toContain(divider);
			expect(line).toBe(line.trimEnd());
		}
		expect(historical).toContain("message-1");
		// The divider still separates the two live panes inside the viewport.
		expect(viewport.some((line) => line.includes(divider))).toBe(true);
	});

	it("keeps rows byte-identical once they scroll out of the viewport", () => {
		const lines: string[] = [];
		const transcript = new LinesComponent(lines);
		const editor = new LinesComponent(["EDITOR_TOP", "EDITOR_BOTTOM"]);
		const rows = 24;
		const { layout } = createLayout({ columns: 160, rows, transcript, controls: [editor] });

		let previous: readonly string[] = [];
		for (let index = 1; index <= 60; index++) {
			lines.push(`message-${index}`);
			const current = layout.render(160).lines;
			if (previous.length > 0) {
				// Rows above the previous viewport are already committed to terminal scrollback
				// and cannot be repainted, so they must never change between frames.
				const frozenRows = Math.max(0, previous.length - rows);
				for (let row = 0; row < frozenRows; row++) {
					expect(current[row]).toBe(previous[row]);
				}
			}
			previous = current;
		}
	});

	it("preserves committed history when the working loader disappears", async () => {
		const columns = 160;
		const rows = 24;
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
		const workingLoader = new LinesComponent(["WORKING"]);
		const editor = new LinesComponent(["EDITOR"]);
		const { layout } = createLayout({
			columns,
			rows,
			transcript,
			controls: [workingLoader, editor],
		});
		const initialLines = layout.render(columns).lines;
		const historicalRows = initialLines.length - rows;
		const committedHistory = initialLines.slice(0, historicalRows);
		const terminal = new LoggingVirtualTerminal(columns, rows);
		terminal.write("SHELL_SENTINEL\r\n");
		const tui = new TuiMainScreen(terminal);
		tui.addChild(layout);
		tui.start();
		try {
			await terminal.waitForRender();
			const initialFullRedraws = tui.fullRedraws;
			terminal.clearWrites();

			workingLoader.lines = [];
			tui.requestRender();
			await terminal.waitForRender();

			const currentLines = layout.render(columns).lines;
			expect(currentLines).toHaveLength(initialLines.length);
			expect(currentLines.slice(0, historicalRows)).toEqual(committedHistory);
			expect(tui.fullRedraws).toBe(initialFullRedraws);
			expect(terminal.getWrites()).not.toContain("\x1b[3J");
			expect(terminal.getScrollBuffer().join("\n")).toContain("SHELL_SENTINEL");
		} finally {
			tui.stop();
		}
	});

	it("preserves committed history when visible transcript rows contract", async () => {
		const columns = 160;
		const rows = 24;
		const transcript = new LinesComponent(Array.from({ length: 90 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR"]);
		const { layout } = createLayout({ columns, rows, transcript, controls: [editor] });
		const initialLines = layout.render(columns).lines;
		const historicalRows = initialLines.length - rows;
		const committedHistory = initialLines.slice(0, historicalRows);
		const terminal = new LoggingVirtualTerminal(columns, rows);
		terminal.write("SHELL_SENTINEL\r\n");
		const tui = new TuiMainScreen(terminal);
		tui.addChild(layout);
		tui.start();
		try {
			await terminal.waitForRender();
			const initialFullRedraws = tui.fullRedraws;
			terminal.clearWrites();

			transcript.lines.splice(historicalRows + 2, 10);
			tui.requestRender();
			await terminal.waitForRender();

			const currentLines = layout.render(columns).lines;
			expect(currentLines).toHaveLength(initialLines.length);
			expect(currentLines.slice(0, historicalRows)).toEqual(committedHistory);
			expect(tui.fullRedraws).toBe(initialFullRedraws);
			expect(terminal.getWrites()).not.toContain("\x1b[3J");
			expect(terminal.getScrollBuffer().join("\n")).toContain("SHELL_SENTINEL");
		} finally {
			tui.stop();
		}
	});

	it("rebases the viewport when contraction changes already committed transcript rows", async () => {
		const columns = 160;
		const rows = 24;
		const transcript = new LinesComponent(Array.from({ length: 90 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR"]);
		const terminal = new LoggingVirtualTerminal(columns, rows);
		terminal.write("SHELL_SENTINEL\r\n");
		const tui = new TuiMainScreen(terminal);
		let viewportResets = 0;
		const { layout } = createLayout({
			columns,
			rows,
			transcript,
			controls: [editor],
			requestViewportReset: () => {
				viewportResets += 1;
				tui.resetViewportOnNextRender();
			},
		});
		tui.addChild(layout);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.clearWrites();

			transcript.lines.splice(10, 10);
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = layout.render(columns).lines.slice(-rows).map(stripAnsi);
			expect(viewportResets).toBe(1);
			expect(viewport.join("\n")).toContain("message-90");
			expect(terminal.getWrites()).toContain("\x1b[2J\x1b[H");
			expect(terminal.getWrites()).not.toContain("\x1b[3J");
			expect(terminal.getScrollBuffer().join("\n")).toContain("SHELL_SENTINEL");
		} finally {
			tui.stop();
		}
	});

	it("does not rebase growing transcripts when streaming moves end markers", async () => {
		const columns = 160;
		const rows = 24;
		const endMarker = "\x1b]133;D\x07";
		const transcript = new LinesComponent([`assistant chunk${endMarker}`]);
		const controls = [new LinesComponent(Array.from({ length: rows - 1 }, (_, index) => `CONTROL_${index + 1}`))];
		const terminal = new LoggingVirtualTerminal(columns, rows);
		const tui = new TuiMainScreen(terminal);
		let viewportResets = 0;
		const { layout } = createLayout({
			columns,
			rows,
			transcript,
			controls,
			requestViewportReset: () => {
				viewportResets += 1;
				tui.resetViewportOnNextRender();
			},
		});
		tui.addChild(layout);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.clearWrites();

			transcript.lines = ["assistant chunk", `continued${endMarker}`];
			tui.requestRender();
			await terminal.waitForRender();

			expect(viewportResets).toBe(0);
			expect(terminal.getScrollBuffer().map(stripAnsi).join("\n")).toContain("continued");
		} finally {
			tui.stop();
		}
	});

	it("keeps the live transcript tail visible when contraction crosses committed history", async () => {
		const columns = 160;
		const rows = 24;
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["EDITOR"]);
		const terminal = new LoggingVirtualTerminal(columns, rows);
		terminal.write("SHELL_SENTINEL\r\n");
		const tui = new TuiMainScreen(terminal);
		const { layout } = createLayout({
			columns,
			rows,
			transcript,
			controls: [editor],
			requestViewportReset: () => tui.resetViewportOnNextRender(),
		});
		tui.addChild(layout);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.clearWrites();

			transcript.lines = Array.from({ length: 5 }, (_, index) => `collapsed-message-${index + 1}`);
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = layout.render(columns).lines.slice(-rows).map(stripAnsi);
			const newestLine = viewport.find((line) => line.includes("collapsed-message-5"));
			expect(newestLine).toBeDefined();
			expect(newestLine).toContain(usesAsciiPlanMarkers() ? "|" : "\u2502");
			expect(terminal.getWrites()).toContain("\x1b[2J\x1b[H");
			expect(terminal.getWrites()).not.toContain("\x1b[3J");
			expect(terminal.getScrollBuffer().join("\n")).toContain("SHELL_SENTINEL");
		} finally {
			tui.stop();
		}
	});

	it("renders extensions at conversation width and a custom footer at full width", () => {
		const header = new LinesComponent(["EXTENSION_HEADER"]);
		const widget = new LinesComponent(["EXTENSION_WIDGET"]);
		const editor = new LinesComponent(["EXTENSION_EDITOR"]);
		const footer = new LinesComponent(["EXTENSION_FOOTER"]);
		const planning: PlanningState = { mode: "plan", plan: plan("ready") };
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
			fullscreenConversation: new LinesComponent(["FULLSCREEN_CONVERSATION"]),
			inspector,
			footer,
			getTerminalColumns: () => 129,
			getTerminalRows: () => 24,
			requestViewportReset: () => undefined,
			onSplitChange: () => undefined,
		});
		const rendered = layout.render(129).lines.map(stripAnsi).join("\n");
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
		const transcript = new LinesComponent(
			["before", image, "", "", "after"],
			[
				{
					top: 1,
					anchor: 1,
					left: 0,
					columns: 2,
					rows: 3,
					protocol: "kitty",
					imageId: 42,
					sequence: image,
					exactSequence: true,
				},
			],
		);
		const { layout } = createLayout({ columns: 129, rows: 24, transcript });
		const rendered = layout.render(129).lines;
		const imageIndex = rendered.findIndex((line) => line.includes("i=42"));
		expect(imageIndex).toBeGreaterThanOrEqual(0);
		expect(rendered[imageIndex]).toBe(image);
		expect(rendered[imageIndex + 1]).toBe("");
		expect(rendered[imageIndex + 2]).toBe("");
		expect(stripAnsi(rendered[imageIndex + 3] ?? "")).toContain("after");
	});

	it("preserves multi-row iTerm protocol rows in the viewport and historical scrollback", () => {
		const image = `\x1b[2A\x1b]1337;File=inline=1;width=60;height=auto:${"iVBORw0KGgoAAAANSUhEUg".repeat(8)}\x07`;
		const transcript = new LinesComponent(
			["before", "", "", image, "after"],
			[
				{
					top: 1,
					anchor: 3,
					left: 0,
					columns: 60,
					rows: 3,
					protocol: "iterm2",
					sequence: image,
					exactSequence: true,
				},
			],
		);
		const { layout } = createLayout({ columns: 129, rows: 24, transcript });

		const visible = layout.render(129).lines.slice(-24);
		expect(visible.find((line) => line.includes("\x1b]1337;File="))).toBe(image);

		transcript.lines.push(...Array.from({ length: 30 }, (_, index) => `later-${index + 1}`));
		const rendered = layout.render(129).lines;
		const historical = rendered.slice(0, rendered.length - 24);
		expect(historical.find((line) => line.includes("\x1b]1337;File="))).toBe(image);
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
			const output = layout.render(129).lines.map(stripAnsi).join("\n");
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
		expect(layout.render(160).lines.map(stripAnsi).join("\n")).toContain("Current work");
		transcript.lines.push("assistant chunk 2");
		const updated = plan("active");
		updated.steps[1] = { ...updated.steps[1]!, status: "completed", note: "Stream-safe update" };
		updated.steps[2] = { ...updated.steps[2]!, status: "in_progress" };
		const nextPlanning = { mode: "build" as const, plan: updated };
		inspector.setPlanning(nextPlanning);
		layout.setPlanning(nextPlanning);
		const output = layout.render(160).lines.map(stripAnsi).join("\n");
		expect(output).toContain("assistant chunk 2");
		expect(output).toContain("Stream-safe update");
		expect(output).toContain("Remaining work");
	});

	it("does not replay a partial iTerm2 block during a row-triggered viewport reset", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			try {
				const columns = 129;
				const image = new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ maxWidthCells: 2, maxHeightCells: 3 },
					{ widthPx: 20, heightPx: 30 },
				);
				const transcriptFrame = concatRenderFrames([
					createRenderFrame(["before-image"]),
					image.render(80),
					createRenderFrame(Array.from({ length: 19 }, (_, index) => `later-${index + 1}`)),
				]);
				const transcript = new LinesComponent([...transcriptFrame.lines], transcriptFrame.images);
				const terminal = new LoggingVirtualTerminal(columns, 24);
				terminal.write("SHELL_SENTINEL\r\n");
				const tui = new TuiMainScreen(terminal);
				const { layout, setRows } = createLayout({
					columns,
					rows: 24,
					transcript,
					onSplitChange: (_split, preserveScrollback) => {
						if (preserveScrollback) tui.resetViewportOnNextRender();
					},
				});
				tui.addChild(layout);
				tui.start();
				try {
					await terminal.waitForRender();
					expect(terminal.getWrites()).toContain("\x1b]1337;File=");
					terminal.clearWrites();

					setRows(23);
					terminal.resize(columns, 23);
					await terminal.waitForRender();

					const writes = terminal.getWrites();
					expect(writes).toContain("\x1b[2J\x1b[H");
					expect(writes).not.toContain("\x1b]1337;File=");
					expect(terminal.getViewport().map(stripAnsi).join("\n")).toContain("later-19");
					expect(terminal.getScrollBuffer().join("\n")).toContain("SHELL_SENTINEL");
				} finally {
					tui.stop();
				}
			} finally {
				resetCapabilitiesCache();
				setCellDimensions({ widthPx: 9, heightPx: 18 });
			}
		});
	});

	it("preserves Termux scrollback when a row resize crosses the split breakpoint", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const columns = 129;
			const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `message-${index + 1}`));
			const compactStatus = new LinesComponent(["COMPACT_PLAN_STATUS"]);
			const editor = new LinesComponent(["EDITOR"]);
			const terminal = new LoggingVirtualTerminal(columns, 24);
			terminal.write("SHELL_SENTINEL\r\n");
			const tui = new TuiMainScreen(terminal);
			const { layout, setRows } = createLayout({
				columns,
				rows: 24,
				transcript,
				controls: [editor],
				compact: [transcript, compactStatus, editor],
				onSplitChange: (_split, preserveScrollback) => {
					if (preserveScrollback) tui.resetViewportOnNextRender();
				},
			});
			tui.addChild(layout);
			tui.start();
			try {
				await terminal.waitForRender();
				expect(terminal.getViewport().map(stripAnsi).join("\n")).not.toContain("COMPACT_PLAN_STATUS");
				terminal.clearWrites();

				setRows(23);
				terminal.resize(columns, 23);
				await terminal.waitForRender();

				const writes = terminal.getWrites();
				const viewport = terminal.getViewport().map(stripAnsi).join("\n");
				expect(writes).toContain("\x1b[2J\x1b[H");
				expect(writes).not.toContain("\x1b[3J");
				expect(viewport).toContain("COMPACT_PLAN_STATUS");
				expect(viewport).toContain("message-40");
				expect(terminal.getScrollBuffer().map(stripAnsi).join("\n")).toContain("SHELL_SENTINEL");
			} finally {
				tui.stop();
			}
		});
	});

	it("requests scrollback preservation for row-only layout transitions", () => {
		const { layout, setRows, splitChanges, preserveScrollbackChanges } = createLayout({
			columns: 129,
			rows: 24,
		});
		layout.render(129).lines;
		setRows(23);
		layout.render(129).lines;
		setRows(24);
		layout.render(129).lines;
		expect(splitChanges).toEqual([false, true]);
		expect(preserveScrollbackChanges).toEqual([true, true]);
	});

	it("does not request scrollback preservation for width-triggered layout transitions", () => {
		const { layout, splitChanges, preserveScrollbackChanges } = createLayout({ columns: 129, rows: 24 });
		layout.render(129).lines;
		layout.render(128).lines;
		layout.render(129).lines;
		expect(splitChanges).toEqual([false, true]);
		expect(preserveScrollbackChanges).toEqual([false, false]);
	});

	it("requests scrollback preservation for state-only layout transitions", () => {
		const compactPlanning: PlanningState = { mode: "plan", plan: plan("draft") };
		const { layout, inspector, splitChanges, preserveScrollbackChanges } = createLayout({
			columns: 160,
			rows: 24,
			planning: compactPlanning,
		});
		layout.render(160).lines;
		const splitPlanning: PlanningState = { mode: "plan", plan: plan("ready") };
		layout.setPlanning(splitPlanning);
		inspector.setPlanning(splitPlanning);
		layout.render(160).lines;
		layout.setPlanning(compactPlanning);
		inspector.setPlanning(compactPlanning);
		layout.render(160).lines;
		expect(splitChanges).toEqual([true, false]);
		expect(preserveScrollbackChanges).toEqual([true, true]);
	});
});
