import { Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcSafeNonNegativeIntegerSchema } from "./primitives.ts";

export const RpcSubscriptionUsageErrorCodeSchema = stringEnum([
	"unauthorized",
	"rate_limited",
	"timeout",
	"unavailable",
	"malformed_response",
]);

export const RpcSubscriptionUsageLimitSchema = Type.Object(
	{
		id: Type.String(),
		label: Type.String(),
		usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
		resetsAt: Type.Optional(RpcSafeNonNegativeIntegerSchema),
		windowDurationMs: Type.Optional(RpcSafeNonNegativeIntegerSchema),
		limitReached: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const RpcSubscriptionUsageSnapshotSchema = Type.Object(
	{
		providerId: Type.String(),
		fetchedAt: RpcSafeNonNegativeIntegerSchema,
		plan: Type.Optional(Type.String()),
		limits: Type.Array(RpcSubscriptionUsageLimitSchema),
	},
	{ additionalProperties: false },
);

export const RpcSubscriptionUsageResultSchema = Type.Union([
	Type.Object(
		{ status: Type.Literal("success"), snapshot: RpcSubscriptionUsageSnapshotSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			status: Type.Literal("error"),
			error: Type.Object(
				{ code: RpcSubscriptionUsageErrorCodeSchema, message: Type.String() },
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);

export const RpcSubscriptionUsageProviderReportSchema = Type.Object(
	{
		providerId: Type.String(),
		result: RpcSubscriptionUsageResultSchema,
	},
	{ additionalProperties: false },
);

export const RpcSubscriptionUsageReportSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("providers"),
			providers: Type.Array(RpcSubscriptionUsageProviderReportSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object({ status: Type.Literal("no_subscription") }, { additionalProperties: false }),
	Type.Object({ status: Type.Literal("unsupported") }, { additionalProperties: false }),
]);
