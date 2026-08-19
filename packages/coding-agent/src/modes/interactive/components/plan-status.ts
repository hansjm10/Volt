import {
	type Component,
	createRenderFrame,
	getKeybindings,
	type RenderFrame,
	ScrollView,
	type ScrollViewScrollbar,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
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

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const plan = this.planning.plan;
		if (!plan && this.planning.mode === "build") return createRenderFrame([]);

		const mark = usesAsciiPlanMarkers() ? "PLAN" : "◆ PLAN";
		if (!plan) {
			return createRenderFrame([
				truncateToWidth(
					`${theme.bold(theme.fg("accent", mark))}${theme.fg("dim", " · DRAFT · Agent tools are read-only")}`,
					width,
				),
			]);
		}

		const { completed, total, percent } = getPlanProgress(plan);
		const left = theme.bold(
			theme.fg(plan.phase === "ready" ? "warning" : "accent", `${mark} ${planPhaseLabel(plan)}`),
		);
		const right = theme.fg("dim", `${completed}/${total} · ${percent}%`);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		const lines = [truncateToWidth(`${left}${gap}${right}`, width)];
		if (width < 100) return createRenderFrame(lines);

		const step = getCurrentPlanStep(plan);
		if (plan.phase === "handed_off" && plan.execution) {
			lines.push(truncateToWidth(theme.fg("muted", ` Execution session: ${plan.execution.targetSessionId}`), width));
		} else if (step) {
			lines.push(truncateToWidth(theme.fg("muted", ` Current · ${step}`), width));
		} else if (plan.phase === "ready") {
			lines.push(truncateToWidth(theme.fg("muted", " Choose how to execute or return to editing"), width));
		}
		return createRenderFrame(lines);
	}
}

export type PlanDetailsAction = "retain_context" | "new_session" | "change";

class PlanDetailsSection implements Component {
	private readonly renderSection: (width: number) => string[];

	constructor(renderSection: (width: number) => string[]) {
		this.renderSection = renderSection;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): RenderFrame {
		return createRenderFrame(this.renderSection(width));
	}
}

/**
 * Scrollable plan viewer. Regular mode keeps its bounded native-scrollback
 * rendering; fullscreen mode uses a fixed header/actions layout around one
 * body ScrollView while sharing the same plan, action, and scroll state.
 */
export class PlanDetailsComponent implements Component {
	private static readonly RESERVED_OUTSIDE_ROWS = 7;
	private plan: PlanState;
	private readonly getTerminalRows: () => number;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly bodyScroll: ScrollView;
	private readonly fullscreenLayout: VStack;
	private actionIndex = 0;
	private regularPageSize = 1;
	private fullscreenActive = false;

	constructor(options: {
		plan: PlanState;
		getTerminalRows: () => number;
		fullscreenScrollbar?: ScrollViewScrollbar;
		onAction: (action: PlanDetailsAction) => void;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.plan = options.plan;
		this.getTerminalRows = options.getTerminalRows;
		this.onAction = options.onAction;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;

		const body = new PlanDetailsSection((width) => renderPlanContentLines(this.plan, width, theme));
		this.bodyScroll = new ScrollView(body, {
			overscroll: "contain",
			scrollbar: options.fullscreenScrollbar ?? "auto",
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		const header = new PlanDetailsSection((width) => this.renderFullscreenHeader(width));
		const actions = new PlanDetailsSection((width) =>
			this.renderFooter(width, width < 100, this.renderBorder(width)),
		);
		this.fullscreenLayout = new VStack([
			{ component: header, shrink: 1, minSize: 0 },
			{ component: this.bodyScroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: actions, shrink: 1, minSize: 0 },
		]);
	}

	setPlan(plan: PlanState): void {
		if (plan.id !== this.plan.id) this.bodyScroll.scrollToStart();
		this.plan = plan;
	}

	setFullscreenActive(active: boolean): void {
		this.fullscreenActive = active;
	}

	setFullscreenScrollbar(scrollbar: ScrollViewScrollbar): void {
		this.bodyScroll.setScrollbar(scrollbar);
	}

	getFullscreenLayout(): Component {
		return this.fullscreenLayout;
	}

	invalidate(): void {
		this.fullscreenLayout.invalidate();
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const compact = width < 100;
		const border = this.renderBorder(width);
		const titleLines = this.renderTitle(width);
		const bodyContent = renderPlanContentLines(this.plan, width, theme);
		const footer = this.renderFooter(width, compact, border);
		const headerRows = 2 + titleLines.length;
		const targetRows = Math.max(
			headerRows + footer.length + 2,
			this.getTerminalRows() - PlanDetailsComponent.RESERVED_OUTSIDE_ROWS,
		);
		const pageSize = Math.max(2, targetRows - headerRows - footer.length);
		this.regularPageSize = pageSize;
		this.bodyScroll.updateLayout(bodyContent.length, pageSize, this.requestRender);
		const end = Math.min(bodyContent.length, this.bodyScroll.scrollTop + pageSize);

		return createRenderFrame([
			border,
			...titleLines,
			this.renderMetadata(width, bodyContent.length, end),
			...bodyContent.slice(this.bodyScroll.scrollTop, end),
			...footer,
		]);
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
			this.bodyScroll.scrollBy(-1);
			return;
		} else if (kb.matches(data, "tui.select.down")) {
			this.bodyScroll.scrollBy(1);
			return;
		}

		const pageSize = Math.max(1, this.fullscreenActive ? this.bodyScroll.viewportHeight : this.regularPageSize);
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.bodyScroll.scrollBy(-pageSize);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.bodyScroll.scrollBy(pageSize);
		}
	}

	private renderBorder(width: number): string {
		return new DynamicBorder().render(width).lines[0] ?? "";
	}

	private renderTitle(width: number): string[] {
		const lines: string[] = [];
		appendWrappedPlanLine(lines, " ", theme.bold(theme.fg("accent", this.plan.title ?? "Plan Details")), width);
		return lines;
	}

	private renderFullscreenHeader(width: number): string[] {
		const bodyLength = renderPlanContentLines(this.plan, width, theme).length;
		const end = Math.min(bodyLength, this.bodyScroll.scrollTop + this.bodyScroll.viewportHeight);
		return [this.renderBorder(width), ...this.renderTitle(width), this.renderMetadata(width, bodyLength, end)];
	}

	private renderMetadata(width: number, bodyLength: number, end: number): string {
		const progress = getPlanProgress(this.plan);
		const maxScroll = Math.max(0, bodyLength - Math.max(1, this.bodyScroll.viewportHeight));
		const position = maxScroll > 0 ? ` · rows ${this.bodyScroll.scrollTop + 1}–${end}/${bodyLength}` : "";
		return truncateToWidth(
			` ${theme.fg("dim", `${progress.completed}/${progress.total} complete${position}`)}`,
			width,
			"",
		);
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
}
