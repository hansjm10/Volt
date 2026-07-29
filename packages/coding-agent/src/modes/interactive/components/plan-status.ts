import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { PlanningState, PlanState } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
import {
	appendWrappedPlanLine,
	getCurrentPlanStep,
	getPlanProgress,
	planPhaseLabel,
	renderPlanContentLines,
	usesAsciiPlanMarkers,
} from "./plan-content.ts";

/** Bounded one/two-line branch-local plan summary kept directly above the editor. */
export class PlanStatusComponent implements Component {
	private planning: PlanningState;

	constructor(planning: PlanningState) {
		this.planning = planning;
	}

	setPlanning(planning: PlanningState): void {
		this.planning = planning;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const plan = this.planning.plan;
		if (!plan && this.planning.mode === "build") return [];

		const mark = usesAsciiPlanMarkers() ? "PLAN" : "◆ PLAN";
		if (!plan) {
			return [
				truncateToWidth(
					`${theme.bold(theme.fg("accent", mark))}${theme.fg("dim", " · DRAFT · Agent tools are read-only")}`,
					width,
				),
			];
		}

		const { completed, total, percent } = getPlanProgress(plan);
		const left = theme.bold(
			theme.fg(plan.phase === "ready" ? "warning" : "accent", `${mark} ${planPhaseLabel(plan)}`),
		);
		const right = theme.fg("dim", `${completed}/${total} · ${percent}%`);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		const lines = [truncateToWidth(`${left}${gap}${right}`, width)];
		if (width < 100) return lines;

		const step = getCurrentPlanStep(plan);
		if (plan.phase === "handed_off" && plan.execution) {
			lines.push(truncateToWidth(theme.fg("muted", ` Execution session: ${plan.execution.targetSessionId}`), width));
		} else if (step) {
			lines.push(truncateToWidth(theme.fg("muted", ` Current · ${step}`), width));
		} else if (plan.phase === "ready") {
			lines.push(truncateToWidth(theme.fg("muted", " Choose how to execute or return to editing"), width));
		}
		return lines;
	}
}

export type PlanDetailsAction = "retain_context" | "new_session" | "change";

/**
 * Scrollable plan viewer. It lives above the normal editor, so even the compact
 * ready-state selector never displaces draft feedback input.
 */
export class PlanDetailsComponent implements Component {
	private static readonly RESERVED_OUTSIDE_ROWS = 7;
	private plan: PlanState;
	private readonly getTerminalRows: () => number;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private actionIndex = 0;
	private scrollOffset = 0;
	private lastPageSize = 1;
	private lastMaxScroll = 0;

	constructor(options: {
		plan: PlanState;
		getTerminalRows: () => number;
		onAction: (action: PlanDetailsAction) => void;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.plan = options.plan;
		this.getTerminalRows = options.getTerminalRows;
		this.onAction = options.onAction;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
	}

	setPlan(plan: PlanState): void {
		if (plan.id !== this.plan.id) this.scrollOffset = 0;
		this.plan = plan;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const compact = width < 100;
		const border = new DynamicBorder().render(width)[0]!;
		const titleLines: string[] = [];
		appendWrappedPlanLine(titleLines, " ", theme.bold(theme.fg("accent", this.plan.title ?? "Plan Details")), width);

		const bodyContent = renderPlanContentLines(this.plan, width, theme);
		const footer = this.renderFooter(width, compact, border);
		const headerRows = 2 + titleLines.length;
		const targetRows = Math.max(
			headerRows + footer.length + 2,
			this.getTerminalRows() - PlanDetailsComponent.RESERVED_OUTSIDE_ROWS,
		);
		const pageSize = Math.max(2, targetRows - headerRows - footer.length);
		const maxScroll = Math.max(0, bodyContent.length - pageSize);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		this.lastPageSize = pageSize;
		this.lastMaxScroll = maxScroll;
		const end = Math.min(bodyContent.length, this.scrollOffset + pageSize);

		const progress = getPlanProgress(this.plan);
		const position = maxScroll > 0 ? ` · rows ${this.scrollOffset + 1}–${end}/${bodyContent.length}` : "";
		const metadata = truncateToWidth(
			` ${theme.fg("dim", `${progress.completed}/${progress.total} complete${position}`)}`,
			width,
			"",
		);

		return [border, ...titleLines, metadata, ...bodyContent.slice(this.scrollOffset, end), ...footer];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (this.plan.phase === "ready") {
			if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.up")) {
				this.actionIndex = (this.actionIndex + 2) % 3;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.down")) {
				this.actionIndex = (this.actionIndex + 1) % 3;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				this.onAction((["retain_context", "new_session", "change"] as const)[this.actionIndex]!);
				return;
			}
		} else if (kb.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}

		if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollBy(-this.lastPageSize);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollBy(this.lastPageSize);
		}
	}

	private renderFooter(width: number, compact: boolean, border: string): string[] {
		const lines: string[] = [];
		if (this.plan.phase === "ready") {
			const actions = ["Execute Plan", "Execute Plan & Clear Context", "Change Plan"];
			lines.push("");
			if (compact) {
				lines.push(
					...actions.map((label, index) =>
						truncateToWidth(
							` ${index === this.actionIndex ? theme.bold(theme.fg("accent", `> ${label}`)) : theme.fg("muted", `  ${label}`)}`,
							width,
						),
					),
				);
			} else {
				lines.push(
					truncateToWidth(
						` ${actions
							.map((label, index) =>
								index === this.actionIndex
									? theme.bold(theme.fg("accent", `[ ${label} ]`))
									: theme.fg("muted", label),
							)
							.join(theme.fg("dim", "   "))}`,
						width,
					),
				);
			}
		}

		const actionHints =
			this.plan.phase === "ready"
				? `${rawKeyHint("←/→", "choose")}  ${keyHint("tui.select.confirm", "confirm")}  `
				: `${rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "scroll")}  `;
		const pageHint = rawKeyHint(`${keyText("tui.editor.pageUp")}/${keyText("tui.editor.pageDown")}`, "page");
		lines.push(truncateToWidth(` ${actionHints}${pageHint}  ${keyHint("tui.select.cancel", "close")}`, width, ""));
		lines.push(border);
		return lines;
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.lastMaxScroll, this.scrollOffset + delta));
		this.requestRender();
	}
}
