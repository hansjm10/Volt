import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@hansjm10/volt-tui";
import type { PlanState, PlanStepStatus } from "../../../core/planning.ts";
import type { Theme } from "../../../core/theme/runtime.ts";

export interface PlanProgress {
	completed: number;
	total: number;
	percent: number;
}

export interface RenderPlanContentOptions {
	includeTitle?: boolean;
	includeSummary?: boolean;
	includeChecklistHeader?: boolean;
}

export function usesAsciiPlanMarkers(): boolean {
	const termProgram = process.env.TERM_PROGRAM ?? "";
	return process.env.VOLT_ASCII === "1" || process.env.TERM === "linux" || termProgram === "";
}

export function planPhaseLabel(plan: PlanState): string {
	switch (plan.phase) {
		case "ready":
			return "READY";
		case "active":
			return "EXECUTING";
		case "completed":
			return "COMPLETE";
		case "handed_off":
			return "HANDED OFF";
		default:
			return "DRAFT";
	}
}

export function getPlanProgress(plan: PlanState): PlanProgress {
	const total = plan.steps.length;
	const completed = plan.steps.filter((step) => step.status === "completed").length;
	return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

export function getCurrentPlanStep(plan: PlanState): string | undefined {
	return (
		plan.steps.find((step) => step.status === "in_progress") ?? plan.steps.find((step) => step.status === "pending")
	)?.text;
}

export function appendWrappedPlanLine(lines: string[], prefix: string, content: string, width: number): void {
	if (width <= 0) return;
	const safePrefix = truncateToWidth(prefix, Math.max(0, width - 1), "");
	const prefixWidth = visibleWidth(safePrefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(content, contentWidth);
	for (let index = 0; index < wrapped.length; index += 1) {
		const linePrefix = index === 0 ? safePrefix : " ".repeat(prefixWidth);
		lines.push(truncateToWidth(`${linePrefix}${wrapped[index] ?? ""}`, width, ""));
	}
}

function planStepMarker(status: PlanStepStatus): string {
	if (usesAsciiPlanMarkers()) {
		return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
	}
	return status === "completed" ? "✓" : status === "in_progress" ? "→" : "○";
}

function markerColor(status: PlanStepStatus): "success" | "accent" | "dim" {
	return status === "completed" ? "success" : status === "in_progress" ? "accent" : "dim";
}

export function renderPlanContentLines(
	plan: PlanState,
	width: number,
	currentTheme: Theme,
	options: RenderPlanContentOptions = {},
): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];

	if (options.includeTitle && plan.title) {
		appendWrappedPlanLine(lines, " ", currentTheme.bold(currentTheme.fg("accent", plan.title)), width);
	}
	if (options.includeSummary !== false && plan.summary) {
		appendWrappedPlanLine(lines, " ", currentTheme.fg("muted", plan.summary), width);
	}
	if ((options.includeTitle && plan.title) || (options.includeSummary !== false && plan.summary)) {
		lines.push("");
	}

	if (options.includeChecklistHeader) {
		const progress = getPlanProgress(plan);
		appendWrappedPlanLine(
			lines,
			" ",
			`${currentTheme.bold(currentTheme.fg("text", "Checklist"))}${currentTheme.fg(
				"dim",
				` · ${progress.completed}/${progress.total} complete`,
			)}`,
			width,
		);
	}

	if (plan.steps.length === 0) {
		appendWrappedPlanLine(lines, " ", currentTheme.fg("dim", "No checklist steps yet."), width);
		return lines;
	}

	for (const step of plan.steps) {
		const marker = currentTheme.fg(markerColor(step.status), planStepMarker(step.status));
		const textColor = step.status === "in_progress" ? "accent" : step.status === "completed" ? "muted" : "text";
		const prefix = ` ${marker} `;
		appendWrappedPlanLine(lines, prefix, currentTheme.fg(textColor, step.text), width);
		if (step.note) {
			appendWrappedPlanLine(
				lines,
				" ".repeat(visibleWidth(prefix)),
				currentTheme.fg("muted", `Note: ${step.note}`),
				width,
			);
		}
	}
	return lines;
}
