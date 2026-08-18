import { randomUUID } from "node:crypto";
import { type Component, createRenderFrame, type RenderFrame, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
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
		text: Type.String({
			description:
				"Self-contained candidate implementation outcome naming the concrete behavior or interface to change and relevant subsystems, files, or symbols when useful; refine it as research changes",
		}),
	},
	{ additionalProperties: false },
);

const updatePlanSchema = Type.Object(
	{
		planId: Type.Optional(Type.String({ description: "Current canonical plan id" })),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
		title: Type.Optional(
			Type.String({ description: "Concise title naming the concrete task, feature, defect, or reviewed surface" }),
		),
		summary: Type.Optional(
			Type.String({
				description:
					"Compact, self-contained handoff covering the objective and context, concrete findings or current state, constraints, decisions, assumptions, unresolved questions, and verification intent; do not rely on prior conversation",
			}),
		),
		steps: Type.Array(planStepInputSchema, { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const submitPlanSchema = Type.Object(
	{
		planId: Type.String(),
		expectedRevision: Type.Integer({ minimum: 0 }),
		title: Type.String({
			description: "Concise title naming the concrete task, feature, defect, or reviewed surface",
		}),
		summary: Type.String({
			description:
				"Compact but complete handoff covering why the work is needed, the objective or review target, concrete findings and current state, chosen approach and constraints, remaining assumptions, and acceptance and verification criteria; it must be understandable without the planning transcript",
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

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		if (this.isError) {
			const output = getTextOutput(this.result, this.showImages) || "Planning tool failed";
			const lines: string[] = [];
			appendWrappedPlanLine(lines, "", this.currentTheme.fg("error", output), width);
			return createRenderFrame(lines);
		}

		const planning = this.result.details;
		if (!planning?.plan) {
			return createRenderFrame([truncateToWidth(this.currentTheme.fg("muted", "No active plan"), width, "")]);
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
		return createRenderFrame(lines);
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

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const label = this.currentTheme.fg("toolTitle", this.currentTheme.bold(this.label));
		if (!this.detail) return createRenderFrame([truncateToWidth(label, width, "")]);
		const inline = `${label}${this.currentTheme.fg("muted", ` · ${this.detail}`)}`;
		if (!this.expanded || visibleWidth(inline) + " [success]".length <= width) {
			return createRenderFrame([truncateToWidth(inline, width)]);
		}
		const lines = [truncateToWidth(label, width, "")];
		appendWrappedPlanLine(lines, "  ", this.currentTheme.fg("muted", this.detail), width);
		return createRenderFrame(lines);
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
				"Create or replace the current working draft after an initial orientation. The title, summary, and checklist form a handoff artifact that may be executed in a fresh session without the planning transcript. Keep them compact but self-contained, explicitly name referenced reviews and findings, and revise them whenever material evidence changes the context, scope, approach, ordering, or verification. Preserve canonical step ids only for unchanged steps. Approved execution scope cannot be changed with this tool.",
			promptSnippet: "Create or refine the self-contained working plan as research changes understanding",
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
				};
			},
		},
		{
			name: "submit_plan",
			label: "submit plan",
			description:
				"Finalize and submit a researched, decision-complete, self-contained handoff artifact for user approval. Resolve discoverable facts, remove investigation-only steps and resolved questions, explicitly name the objective or review target and findings that drive the work, and record the chosen approach, remaining assumptions, acceptance criteria, and verification. The submitted title, summary, and checklist must be sufficient for execution without the planning transcript. Provide the exact canonical plan id and revision plus a non-empty title and summary. This ends the planning run.",
			promptSnippet: "Submit a self-contained, decision-complete plan for user approval",
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
					disposition: "stop",
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
					...(plan.phase === "completed" ? { disposition: "final_response" as const } : {}),
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
					disposition: "stop",
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
