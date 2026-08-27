import { Type } from "typebox";
import type { PlanState } from "../../planning.ts";
import { stringEnum } from "./helpers.ts";

export const RpcAgentModeSchema = stringEnum(["build", "plan"]);
export const RpcPlanPhaseSchema = stringEnum(["draft", "ready", "active", "completed", "handed_off"]);
export const RpcPlanStepStatusSchema = stringEnum(["pending", "in_progress", "completed"]);
export const RpcPlanExecutionStrategySchema = stringEnum(["retain_context", "new_session"]);

export const RpcPlanSubstepSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		status: RpcPlanStepStatusSchema,
		note: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcPlanStepSchema = Type.Union([
	RpcPlanSubstepSchema,
	Type.Object(
		{
			id: Type.String({ minLength: 1 }),
			text: Type.String({ minLength: 1 }),
			status: RpcPlanStepStatusSchema,
			substeps: Type.Array(RpcPlanSubstepSchema, { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export const RpcPlanExecutionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		approvedRevision: Type.Integer({ minimum: 0 }),
		strategy: RpcPlanExecutionStrategySchema,
		sourceSessionId: Type.String({ minLength: 1 }),
		targetSessionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const rpcPlanStateFields = {
	id: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 0 }),
	title: Type.Optional(Type.String({ minLength: 1 })),
	summary: Type.Optional(Type.String({ minLength: 1 })),
	steps: Type.Array(RpcPlanStepSchema),
};

export const RpcPlanStateSchema = Type.Unsafe<PlanState>(
	Type.Union([
		Type.Object(
			{
				...rpcPlanStateFields,
				phase: stringEnum(["draft", "ready"]),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				...rpcPlanStateFields,
				phase: stringEnum(["active", "completed", "handed_off"]),
				execution: RpcPlanExecutionSchema,
			},
			{ additionalProperties: false },
		),
	]),
);

export const RpcPlanningStateSchema = Type.Object(
	{
		mode: RpcAgentModeSchema,
		plan: Type.Union([RpcPlanStateSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export const RpcPlanningStateChangedEventSchema = Type.Object(
	{
		type: Type.Literal("planning_state_changed"),
		planning: RpcPlanningStateSchema,
		delivery: Type.Optional(
			Type.Object(
				{
					subscriptionId: Type.String(),
					cursor: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const RpcPlanExecutionResultSchema = Type.Object(
	{
		planning: RpcPlanningStateSchema,
		selectedSessionId: Type.String(),
		started: Type.Boolean(),
	},
	{ additionalProperties: false },
);
