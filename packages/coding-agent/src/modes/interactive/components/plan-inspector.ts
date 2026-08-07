import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { PlanningState, PlanStepStatus } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
import { appendWrappedPlanLine, getPlanProgress, planPhaseLabel, usesAsciiPlanMarkers } from "./plan-content.ts";
import type { PlanDetailsAction } from "./plan-status.ts";

const READY_ACTIONS: ReadonlyArray<{ label: string; action: PlanDetailsAction }> = [
	{ label: "Execute Plan", action: "retain_context" },
	{ label: "Execute Plan & Clear Context", action: "new_session" },
	{ label: "Change Plan", action: "change" },
];

function stepMarker(status: PlanStepStatus): string {
	if (usesAsciiPlanMarkers()) {
		return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
	}
	return status === "completed" ? "✓" : status === "in_progress" ? "→" : "○";
}

function stepColor(status: PlanStepStatus): "success" | "accent" | "dim" {
	return status === "completed" ? "success" : status === "in_progress" ? "accent" : "dim";
}

function fitSides(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "");
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "");
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return truncateToWidth(`${fittedLeft}${gap}${right}`, width, "");
}

/** Persistent, focusable rendering of canonical branch-local planning state. */
export class PlanInspectorComponent implements Component, Focusable {
	focused = false;
	private planning: PlanningState;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onReturnFocus: () => void;
	private readonly onToggleFocus: () => void;
	private readonly requestRender: () => void;
	private actionIndex = 0;
	private scrollOffset = 0;
	private viewportRows = 1;
	private lastPageSize = 1;
	private lastMaxScroll = 0;
	private selectedActionVisible = false;

	constructor(options: {
		planning: PlanningState;
		onAction: (action: PlanDetailsAction) => void;
		onReturnFocus: () => void;
		onToggleFocus: () => void;
		requestRender: () => void;
	}) {
		this.planning = options.planning;
		this.onAction = options.onAction;
		this.onReturnFocus = options.onReturnFocus;
		this.onToggleFocus = options.onToggleFocus;
		this.requestRender = options.requestRender;
	}

	setPlanning(planning: PlanningState): void {
		if (planning.plan?.id !== this.planning.plan?.id) {
			this.scrollOffset = 0;
			this.actionIndex = 0;
		}
		this.planning = planning;
		this.selectedActionVisible = false;
	}

	setViewportRows(rows: number): void {
		const nextRows = Math.max(0, rows);
		if (nextRows !== this.viewportRows) this.selectedActionVisible = false;
		this.viewportRows = nextRows;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		if (width <= 0 || this.viewportRows <= 0) {
			this.selectedActionVisible = false;
			return [];
		}

		const body = this.renderBody(width);
		const footer = this.renderFooter(width);
		const headerRows = Math.min(2, this.viewportRows);
		const footerRows = Math.min(footer.length, Math.max(0, this.viewportRows - headerRows - 1));
		const pageSize = Math.max(1, this.viewportRows - headerRows - footerRows);
		const maxScroll = Math.max(0, body.length - pageSize);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		this.lastPageSize = pageSize;
		this.lastMaxScroll = maxScroll;
		const end = Math.min(body.length, this.scrollOffset + pageSize);
		const page = body.slice(this.scrollOffset, end);
		const plan = this.planning.plan;
		const phase = plan ? planPhaseLabel(plan) : "DRAFT";
		const marker = usesAsciiPlanMarkers() ? "PLAN" : "◆ PLAN";
		const focus = this.focused
			? theme.bold(theme.fg("accent", "FOCUSED"))
			: theme.fg("dim", `${keyText("app.plan.togglePane")} focus`);
		const header = [
			fitSides(
				theme.bold(theme.fg(plan?.phase === "ready" ? "warning" : "accent", `${marker} · ${phase}`)),
				focus,
				width,
			),
			this.renderMetadata(width, body.length, end),
		].slice(0, headerRows);
		const visibleFooter = this.selectVisibleFooter(footer, footerRows);
		this.selectedActionVisible = plan?.phase === "ready" && visibleFooter.includes(footer[this.actionIndex] ?? "");
		const padding = Array.from(
			{ length: Math.max(0, this.viewportRows - header.length - page.length - visibleFooter.length) },
			() => "",
		);
		return [...header, ...page, ...padding, ...visibleFooter].map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.plan.togglePane")) {
			this.onToggleFocus();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onReturnFocus();
			return;
		}
		if (this.planning.plan?.phase === "ready") {
			if (kb.matches(data, "tui.editor.cursorLeft")) {
				this.actionIndex = (this.actionIndex + READY_ACTIONS.length - 1) % READY_ACTIONS.length;
				this.selectedActionVisible = false;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.editor.cursorRight")) {
				this.actionIndex = (this.actionIndex + 1) % READY_ACTIONS.length;
				this.selectedActionVisible = false;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				if (this.selectedActionVisible) this.onAction(READY_ACTIONS[this.actionIndex]!.action);
				return;
			}
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollBy(1);
		} else if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollBy(-this.lastPageSize);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollBy(this.lastPageSize);
		}
	}

	private renderMetadata(width: number, bodyRows: number, end: number): string {
		const plan = this.planning.plan;
		const mode = this.planning.mode === "plan" ? "Plan mode" : "Build mode";
		const position = bodyRows > this.lastPageSize ? ` · rows ${this.scrollOffset + 1}–${end}/${bodyRows}` : "";
		if (!plan) return truncateToWidth(theme.fg("dim", ` ${mode}${position}`), width, "");
		const progress = getPlanProgress(plan);
		return truncateToWidth(
			theme.fg(
				"dim",
				` ${mode} · ${progress.completed}/${progress.total} complete · ${progress.percent}%${position}`,
			),
			width,
			"",
		);
	}

	private renderBody(width: number): string[] {
		const plan = this.planning.plan;
		const lines: string[] = [];
		if (!plan) {
			appendWrappedPlanLine(lines, " ", theme.bold(theme.fg("text", "No structured plan yet")), width);
			lines.push("");
			appendWrappedPlanLine(
				lines,
				" ",
				theme.fg("muted", "Volt will create a working draft after its initial research orientation."),
				width,
			);
			return lines;
		}

		appendWrappedPlanLine(lines, " ", theme.bold(theme.fg("text", plan.title ?? "Untitled plan")), width);
		if (plan.summary) {
			lines.push("");
			appendWrappedPlanLine(lines, " ", theme.fg("muted", plan.summary), width);
		}
		if (plan.phase === "handed_off" && plan.execution) {
			lines.push("");
			appendWrappedPlanLine(
				lines,
				" ",
				theme.fg("accent", `Execution session: ${plan.execution.targetSessionId}`),
				width,
			);
		}
		lines.push("");
		appendWrappedPlanLine(lines, " ", theme.bold(theme.fg("text", "Checklist")), width);
		if (plan.steps.length === 0) {
			appendWrappedPlanLine(lines, " ", theme.fg("dim", "No checklist steps yet."), width);
			return lines;
		}
		for (const [index, step] of plan.steps.entries()) {
			const marker = theme.fg(stepColor(step.status), stepMarker(step.status));
			const textColor = step.status === "in_progress" ? "accent" : step.status === "completed" ? "muted" : "text";
			const prefix = ` ${index + 1}. ${marker} `;
			appendWrappedPlanLine(lines, prefix, theme.fg(textColor, step.text), width);
			if (step.note) {
				appendWrappedPlanLine(
					lines,
					" ".repeat(visibleWidth(prefix)),
					theme.fg("muted", `Note: ${step.note}`),
					width,
				);
			}
		}
		return lines;
	}

	private selectVisibleFooter(footer: readonly string[], rows: number): string[] {
		if (rows <= 0) return [];
		if (this.planning.plan?.phase !== "ready" || rows >= footer.length) return footer.slice(-rows);

		const selectedAction = footer[this.actionIndex];
		const actionHint = footer[READY_ACTIONS.length];
		const scrollHint = footer.at(-1);
		if (!selectedAction || !actionHint || !scrollHint) return footer.slice(-rows);
		if (rows === 1) return [selectedAction];
		if (rows === 2) return [selectedAction, actionHint];
		if (rows === 3) return [selectedAction, actionHint, scrollHint];
		return [...footer.slice(0, READY_ACTIONS.length), actionHint].slice(0, rows);
	}

	private renderFooter(width: number): string[] {
		const lines: string[] = [];
		if (this.planning.plan?.phase === "ready") {
			for (const [index, item] of READY_ACTIONS.entries()) {
				const label = index === this.actionIndex ? `> ${item.label}` : `  ${item.label}`;
				lines.push(
					truncateToWidth(
						index === this.actionIndex ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label),
						width,
						"",
					),
				);
			}
			lines.push(
				truncateToWidth(` ${rawKeyHint("←/→", "choose")}  ${keyHint("tui.select.confirm", "confirm")}`, width, ""),
			);
		}
		lines.push(
			truncateToWidth(
				` ${rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "scroll")}  ${rawKeyHint(`${keyText("tui.editor.pageUp")}/${keyText("tui.editor.pageDown")}`, "page")}`,
				width,
				"",
			),
		);
		return lines;
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.lastMaxScroll, this.scrollOffset + delta));
		this.requestRender();
	}
}
