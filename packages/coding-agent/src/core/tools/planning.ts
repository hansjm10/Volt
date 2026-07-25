import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PlanningState, PlanState, PlanStepStatus } from "../planning.ts";

const planStepInputSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ description: "Existing canonical step id; omit for a new step" })),
		text: Type.String({ description: "Concrete checklist step" }),
		status: Type.Optional(
			Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
		),
		note: Type.Optional(Type.String({ description: "Optional concise progress note" })),
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
		title: Type.String(),
		summary: Type.String(),
	},
	{ additionalProperties: false },
);

export const NATIVE_PLAN_TOOL_NAMES = new Set(["update_plan", "submit_plan"]);
export const PLAN_MODE_READ_ONLY_TOOL_NAMES = ["read", "web_search", "web_fetch", "grep", "find", "ls"] as const;

export interface PlanningToolController {
	getPlanningState(): PlanningState;
	updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: Array<{ id?: string; text: string; status?: PlanStepStatus; note?: string }>;
	}): PlanState;
	submitPlan(input: { planId: string; expectedRevision: number; title: string; summary: string }): PlanState;
}

function stateResultText(state: PlanningState): string {
	return JSON.stringify(state);
}

export function createPlanningToolDefinitions(
	controller: PlanningToolController,
): [ToolDefinition<typeof updatePlanSchema, PlanningState>, ToolDefinition<typeof submitPlanSchema, PlanningState>] {
	return [
		{
			name: "update_plan",
			label: "update plan",
			description:
				"Create or replace the ordered structured checklist. Use canonical step ids returned by the prior call when retaining steps. During approved execution, keep statuses and structure current.",
			promptSnippet: "Create or update the structured plan checklist",
			parameters: updatePlanSchema,
			async execute(_toolCallId, input) {
				controller.updatePlan({
					...input,
					steps: input.steps.map((step) => ({
						...step,
						id: step.id?.trim() || undefined,
						text: step.text.trim(),
						note: step.note?.trim() || undefined,
					})),
				});
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
				"Submit the current non-empty checklist for user approval. Requires the exact canonical plan id and revision plus a non-empty title and summary. This ends the planning run.",
			promptSnippet: "Submit a complete plan for user approval",
			parameters: submitPlanSchema,
			async execute(_toolCallId, input) {
				controller.submitPlan({
					planId: input.planId,
					expectedRevision: input.expectedRevision,
					title: input.title.trim(),
					summary: input.summary.trim(),
				});
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
	steps: Array<{ id?: string; text: string; status?: PlanStepStatus; note?: string }>,
	previous?: PlanState,
): PlanState["steps"] {
	const previousIds = new Set(previous?.steps.map((step) => step.id) ?? []);
	const used = new Set<string>();
	return steps.map((step) => {
		const requestedId = step.id?.trim();
		const id = requestedId && previousIds.has(requestedId) && !used.has(requestedId) ? requestedId : randomUUID();
		used.add(id);
		return {
			id,
			text: step.text.trim(),
			status: step.status ?? "pending",
			...(step.note?.trim() ? { note: step.note.trim() } : {}),
		};
	});
}
