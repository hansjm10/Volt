import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PlanningState, PlanState, PlanStepStatus } from "../planning.ts";

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
export const PLAN_MODE_READ_ONLY_TOOL_NAMES = ["read", "web_search", "web_fetch", "grep", "find", "ls", "lsp"] as const;

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
