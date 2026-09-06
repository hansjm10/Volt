import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcConversationIdentifierSchema as Identifier } from "./primitives.ts";

export const RpcReviewGeneralSchema = Type.Object(
	{
		runId: Identifier,
		sourceSessionId: Identifier,
		generalSessionId: Identifier,
		generalSessionGeneration: Identifier,
		generalRevision: Type.Integer({ minimum: 0 }),
		generalAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type RpcReviewGeneral = Static<typeof RpcReviewGeneralSchema>;

export const RpcReviewDiscussionLinkSchema = Type.Object(
	{
		discussionId: Identifier,
		runId: Identifier,
		findingId: Identifier,
		sourceSessionId: Identifier,
		sessionId: Identifier,
	},
	{ additionalProperties: false },
);

export const RpcReviewDiscussionSchema = Type.Object(
	{
		...RpcReviewDiscussionLinkSchema.properties,
		currentSessionId: Identifier,
		sourceAvailable: Type.Boolean(),
		available: Type.Boolean(),
		status: stringEnum([
			"idle",
			"running",
			"pending",
			"completed",
			"failed",
			"cancelled",
			"interrupted",
			"unavailable",
		]),
	},
	{ additionalProperties: false },
);

export const RpcStartReviewDiscussionsSchema = Type.Object(
	{
		runId: Identifier,
		requestId: Identifier,
		results: Type.Array(
			Type.Union([
				Type.Object(
					{
						findingId: Identifier,
						outcome: stringEnum(["created", "existing"]),
						discussion: RpcReviewDiscussionSchema,
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						findingId: Identifier,
						outcome: Type.Literal("failed"),
						errorCode: stringEnum(["unknown_finding", "source_unavailable", "launch_failed"]),
						discussion: Type.Optional(RpcReviewDiscussionSchema),
					},
					{ additionalProperties: false },
				),
			]),
			{ maxItems: 50 },
		),
	},
	{ additionalProperties: false },
);

export const RpcListReviewDiscussionsSchema = Type.Object(
	{
		runId: Identifier,
		discussions: Type.Array(RpcReviewDiscussionSchema, { maxItems: 50 }),
		nextCursor: Type.Optional(Type.String({ maxLength: 32 })),
	},
	{ additionalProperties: false },
);

export const RpcResetReviewDiscussionSchema = Type.Object(
	{
		requestId: Identifier,
		status: stringEnum(["reset", "conflict", "busy"]),
		discussion: RpcReviewDiscussionSchema,
	},
	{ additionalProperties: false },
);

export type RpcReviewDiscussionLink = Static<typeof RpcReviewDiscussionLinkSchema>;
export type RpcReviewDiscussion = Static<typeof RpcReviewDiscussionSchema>;
export type RpcStartReviewDiscussions = Static<typeof RpcStartReviewDiscussionsSchema>;
export type RpcListReviewDiscussions = Static<typeof RpcListReviewDiscussionsSchema>;
export type RpcResetReviewDiscussion = Static<typeof RpcResetReviewDiscussionSchema>;
