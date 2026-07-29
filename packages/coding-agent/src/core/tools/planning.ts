import { randomUUID } from "node:crypto";
import { type Component, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import { type Static, Type } from "typebox";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import {
	appendWrappedPlanLine,
	getPlanProgress,
	planPhaseLabel,
	renderPlanContentLines,
} from "../../modes/interactive/components/plan-content.ts";
import type {
	AgentToolResult,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../extensions/types.ts";
import type { PlanningState, PlanState, PlanStepStatus } from "../planning.ts";
import type { Theme } from "../theme/runtime.ts";
import { getTextOutput } from "./render-utils.ts";

const planStepInputSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ description: "Existing canonical step id; omit for a new step" })),
		text: Type.String({ description: "Concrete implementation step" }),
	},
	{ additionalProperties: false },
);

const updatePlanSchema = Type.Object(
	{
		planId: Type.Optional(Type.String({ description: "Current canonical plan id" })),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
		title: Type.Optional(Type.String()),
		summary: Type.Optional(Type.String()),
		steps: Type.Array(planStepInputSchema, { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const submitPlanSchema = Type.Object(
	{
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
		title: Type.String({ description: "Concise plan title" }),
		summary: Type.String({
			description: "Decision-complete summary of findings, chosen approach, assumptions, and verification criteria",
		}),
	},
	{ additionalProperties: false },
);

const planProgressUpdateSchema = Type.Object(
	{
		id: Type.String({ description: "Existing approved step id" }),
		status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
		note: Type.Optional(Type.String({ description: "Concise execution evidence; an empty string clears it" })),
	},
	{ additionalProperties: false },
);

const updatePlanProgressSchema = Type.Object(
	{
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
		updates: Type.Array(planProgressUpdateSchema, { minItems: 1, maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const requestReplanSchema = Type.Object(
	{
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
		reason: Type.String({ description: "Implementation evidence that requires changing the approved scope" }),
	},
	{ additionalProperties: false },
);

export const NATIVE_PLAN_TOOL_NAMES = new Set(["update_plan", "submit_plan", "update_plan_progress", "request_replan"]);

export interface PlanningToolController {
	getPlanningState(): PlanningState;
	flushPlanningState(): Promise<void>;
	updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: Array<{ id?: string; text: string }>;
	}): PlanState;
	submitPlan(input: { planId: string; expectedRevision: number; title: string; summary: string }): PlanState;
	updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): PlanState;
	requestReplan(input: { planId: string; expectedRevision: number; reason: string }): PlanningState;
}

function stateResultText(state: PlanningState): string {
	if (!state.plan) {
		return JSON.stringify({ mode: state.mode, plan: null });
	}
	return JSON.stringify({
		mode: state.mode,
		planId: state.plan.id,
		revision: state.plan.revision,
		phase: state.plan.phase,
		steps: state.plan.steps,
	});
}

class PlanningToolResultComponent implements Component {
	private result: AgentToolResult<PlanningState>;
	private expanded: boolean;
	private currentTheme: Theme;
	private isError: boolean;
	private showImages: boolean;
	private includePlanContext: boolean;

	constructor(
		result: AgentToolResult<PlanningState>,
		expanded: boolean,
		currentTheme: Theme,
		isError: boolean,
		showImages: boolean,
		includePlanContext: boolean,
	) {
		this.result = result;
		this.expanded = expanded;
		this.currentTheme = currentTheme;
		this.isError = isError;
		this.showImages = showImages;
		this.includePlanContext = includePlanContext;
	}

	setState(
		result: AgentToolResult<PlanningState>,
		expanded: boolean,
		currentTheme: Theme,
		isError: boolean,
		showImages: boolean,
		includePlanContext: boolean,
	): void {
		this.result = result;
		this.expanded = expanded;
		this.currentTheme = currentTheme;
		this.isError = isError;
		this.showImages = showImages;
		this.includePlanContext = includePlanContext;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.isError) {
			const output = getTextOutput(this.result, this.showImages) || "Planning tool failed";
			const lines: string[] = [];
			appendWrappedPlanLine(lines, "", this.currentTheme.fg("error", output), width);
			return lines;
		}

		const planning = this.result.details;
		if (!planning.plan) {
			return [truncateToWidth(this.currentTheme.fg("muted", "No active plan"), width, "")];
		}

		const plan = planning.plan;
		const progress = getPlanProgress(plan);
		const phaseColor =
			plan.phase === "ready"
				? "warning"
				: plan.phase === "completed"
					? "success"
					: plan.phase === "draft"
						? "muted"
						: "accent";
		const status = `${this.currentTheme.bold(this.currentTheme.fg(phaseColor, planPhaseLabel(plan)))}${this.currentTheme.fg(
			"dim",
			this.expanded
				? ` · revision ${plan.revision}`
				: ` · revision ${plan.revision} · ${progress.completed}/${progress.total} complete`,
		)}`;
		const lines: string[] = [];
		const expandKey = keyText("app.tools.expand");
		const expandHint = expandKey ? this.currentTheme.fg("dim", ` · ${expandKey} details`) : "";
		appendWrappedPlanLine(lines, "", this.expanded ? status : `${status}${expandHint}`, width);
		if (this.expanded) {
			if (this.includePlanContext) lines.push("");
			lines.push(
				...renderPlanContentLines(plan, width, this.currentTheme, {
					includeTitle: this.includePlanContext,
					includeSummary: this.includePlanContext,
					includeChecklistHeader: true,
				}),
			);
		}
		return lines;
	}

	invalidate(): void {
		// Theme and state are refreshed through setState when the tool row invalidates.
	}
}

type PlanningResultContext = Pick<ToolRenderContext<unknown, unknown>, "isError" | "lastComponent" | "showImages">;

function renderPlanningResult(
	result: AgentToolResult<PlanningState>,
	options: ToolRenderResultOptions,
	currentTheme: Theme,
	context: PlanningResultContext,
	includePlanContext = true,
): Component {
	const component =
		context.lastComponent instanceof PlanningToolResultComponent
			? context.lastComponent
			: new PlanningToolResultComponent(
					result,
					options.expanded,
					currentTheme,
					context.isError,
					context.showImages,
					includePlanContext,
				);
	component.setState(result, options.expanded, currentTheme, context.isError, context.showImages, includePlanContext);
	return component;
}

class PlanningToolCallComponent implements Component {
	private label: string;
	private detail: string | undefined;
	private expanded: boolean;
	private currentTheme: Theme;

	constructor(label: string, detail: string | undefined, expanded: boolean, currentTheme: Theme) {
		this.label = label;
		this.detail = detail;
		this.expanded = expanded;
		this.currentTheme = currentTheme;
	}

	setState(label: string, detail: string | undefined, expanded: boolean, currentTheme: Theme): void {
		this.label = label;
		this.detail = detail;
		this.expanded = expanded;
		this.currentTheme = currentTheme;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const label = this.currentTheme.fg("toolTitle", this.currentTheme.bold(this.label));
		if (!this.detail) return [truncateToWidth(label, width, "")];
		const inline = `${label}${this.currentTheme.fg("muted", ` · ${this.detail}`)}`;
		if (!this.expanded || visibleWidth(inline) + " [success]".length <= width) {
			return [truncateToWidth(inline, width)];
		}
		const lines = [truncateToWidth(label, width, "")];
		appendWrappedPlanLine(lines, "  ", this.currentTheme.fg("muted", this.detail), width);
		return lines;
	}

	invalidate(): void {
		// Theme and state are refreshed through setState when the tool row invalidates.
	}
}

function renderPlanningCall(
	label: string,
	detail: string | undefined,
	expanded: boolean,
	currentTheme: Theme,
	lastComponent: Component | undefined,
): Component {
	const component =
		lastComponent instanceof PlanningToolCallComponent
			? lastComponent
			: new PlanningToolCallComponent(label, detail, expanded, currentTheme);
	component.setState(label, detail, expanded, currentTheme);
	return component;
}

function updatePlanCallDetail(args: Partial<Static<typeof updatePlanSchema>> | undefined): string | undefined {
	const stepCount = Array.isArray(args?.steps) ? args.steps.length : undefined;
	return stepCount === undefined ? undefined : `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
}

function progressCallDetail(args: Partial<Static<typeof updatePlanProgressSchema>> | undefined): string | undefined {
	if (!Array.isArray(args?.updates)) return undefined;
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const update of args.updates) {
		if (update?.status === "pending" || update?.status === "in_progress" || update?.status === "completed") {
			counts[update.status] += 1;
		}
	}
	const labels = [
		counts.completed > 0 ? `${counts.completed} completed` : undefined,
		counts.in_progress > 0 ? `${counts.in_progress} in progress` : undefined,
		counts.pending > 0 ? `${counts.pending} pending` : undefined,
	].filter((value): value is string => value !== undefined);
	return labels.join(" · ") || `${args.updates.length} ${args.updates.length === 1 ? "update" : "updates"}`;
}

export function createPlanningToolDefinitions(
	controller: PlanningToolController,
): [
	ToolDefinition<typeof updatePlanSchema, PlanningState>,
	ToolDefinition<typeof submitPlanSchema, PlanningState>,
	ToolDefinition<typeof updatePlanProgressSchema, PlanningState>,
	ToolDefinition<typeof requestReplanSchema, PlanningState>,
] {
	return [
		{
			name: "update_plan",
			label: "update plan",
			description:
				"Create or completely replace the ordered implementation checklist while planning. Use canonical step ids when retaining unchanged steps. Approved execution scope cannot be changed with this tool.",
			promptSnippet: "Create or replace the draft implementation checklist",
			parameters: updatePlanSchema,
			renderCall(args, currentTheme, context) {
				return renderPlanningCall(
					"update plan",
					updatePlanCallDetail(args as Partial<Static<typeof updatePlanSchema>> | undefined),
					context.expanded,
					currentTheme,
					context.lastComponent,
				);
			},
			renderResult(result, options, currentTheme, context) {
				return renderPlanningResult(result, options, currentTheme, context, false);
			},
			async execute(_toolCallId, input) {
				controller.updatePlan({
					...input,
					steps: input.steps.map((step) => ({
						id: step.id?.trim() || undefined,
						text: step.text.trim(),
					})),
				});
				await controller.flushPlanningState();
				const planning = controller.getPlanningState();
				return {
					content: [{ type: "text", text: stateResultText(planning) }],
					details: planning,
					isError: false,
					terminate: false,
				};
			},
		},
		{
			name: "submit_plan",
			label: "submit plan",
			description:
				"Submit a researched, decision-complete draft for user approval. Requires the exact canonical plan id and revision plus a non-empty title and summary. This ends the planning run.",
			promptSnippet: "Submit a researched, decision-complete plan for user approval",
			parameters: submitPlanSchema,
			renderCall(args, currentTheme, context) {
				const title = typeof args?.title === "string" ? args.title.trim() : "";
				return renderPlanningCall(
					"submit plan",
					title || undefined,
					context.expanded,
					currentTheme,
					context.lastComponent,
				);
			},
			renderResult: renderPlanningResult,
			async execute(_toolCallId, input) {
				controller.submitPlan({
					planId: input.planId,
					expectedRevision: input.expectedRevision,
					title: input.title.trim(),
					summary: input.summary.trim(),
				});
				await controller.flushPlanningState();
				const planning = controller.getPlanningState();
				return {
					content: [{ type: "text", text: stateResultText(planning) }],
					details: planning,
					isError: false,
					terminate: true,
				};
			},
		},
		{
			name: "update_plan_progress",
			label: "update plan progress",
			description:
				"Update only status and execution evidence for existing approved step ids. The approved title, summary, step text, order, and scope are immutable.",
			promptSnippet: "Update progress on existing approved plan steps",
			parameters: updatePlanProgressSchema,
			renderCall(args, currentTheme, context) {
				return renderPlanningCall(
					"update plan progress",
					progressCallDetail(args as Partial<Static<typeof updatePlanProgressSchema>> | undefined),
					context.expanded,
					currentTheme,
					context.lastComponent,
				);
			},
			renderResult(result, options, currentTheme, context) {
				return renderPlanningResult(result, options, currentTheme, context, false);
			},
			async execute(_toolCallId, input) {
				const plan = controller.updatePlanProgress({
					planId: input.planId,
					expectedRevision: input.expectedRevision,
					updates: input.updates.map((update) => ({
						id: update.id.trim(),
						status: update.status,
						...(update.note === undefined ? {} : { note: update.note.trim() }),
					})),
				});
				await controller.flushPlanningState();
				const planning = controller.getPlanningState();
				return {
					content: [{ type: "text", text: stateResultText(planning) }],
					details: planning,
					isError: false,
					terminate: plan.phase === "completed",
				};
			},
		},
		{
			name: "request_replan",
			label: "request replan",
			description:
				"Pause approved execution when implementation evidence requires a structural plan change. This returns the plan to draft, ends the execution run, and requires new user approval.",
			promptSnippet: "Pause execution and request approval for a revised plan",
			parameters: requestReplanSchema,
			renderCall(args, currentTheme, context) {
				const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
				return renderPlanningCall(
					"request replan",
					reason || undefined,
					context.expanded,
					currentTheme,
					context.lastComponent,
				);
			},
			renderResult: renderPlanningResult,
			async execute(_toolCallId, input) {
				controller.requestReplan({
					planId: input.planId,
					expectedRevision: input.expectedRevision,
					reason: input.reason.trim(),
				});
				await controller.flushPlanningState();
				const planning = controller.getPlanningState();
				return {
					content: [{ type: "text", text: stateResultText(planning) }],
					details: planning,
					isError: false,
					terminate: true,
				};
			},
		},
	];
}

export function canonicalizePlanSteps(
	steps: Array<{ id?: string; text: string }>,
	previous?: PlanState,
): PlanState["steps"] {
	const previousSteps = new Map(previous?.steps.map((step) => [step.id, step]) ?? []);
	const used = new Set<string>();
	return steps.map((step) => {
		const requestedId = step.id?.trim();
		const retained = requestedId && !used.has(requestedId) ? previousSteps.get(requestedId) : undefined;
		const id = retained?.id ?? randomUUID();
		const text = step.text.trim();
		const preserveProgress = retained?.text === text;
		used.add(id);
		return {
			id,
			text,
			status: preserveProgress ? retained.status : "pending",
			...(preserveProgress && retained.note ? { note: retained.note } : {}),
		};
	});
}
