import { Type } from "typebox";
import {
	RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS,
	RPC_GIT_CONTEXT_OID_MAX_CHARS,
	RPC_GIT_CONTEXT_OID_PATTERN,
	RPC_GIT_CONTEXT_REF_MAX_CHARS,
	RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
} from "../wire-limits.ts";
import { stringEnum } from "./helpers.ts";
import { RpcSafeNonNegativeIntegerSchema } from "./primitives.ts";

export const RpcGitObjectIdSchema = Type.String({
	minLength: 40,
	maxLength: RPC_GIT_CONTEXT_OID_MAX_CHARS,
	pattern: RPC_GIT_CONTEXT_OID_PATTERN,
});

export const RpcGitRefSchema = Type.String({
	minLength: 1,
	maxLength: RPC_GIT_CONTEXT_REF_MAX_CHARS,
});

export const RpcGitHeadSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("branch"),
			name: RpcGitRefSchema,
			oid: RpcGitObjectIdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("detached"),
			oid: RpcGitObjectIdSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("unborn"),
			name: RpcGitRefSchema,
		},
		{ additionalProperties: false },
	),
]);

export const RpcGitComparisonSchema = Type.Object(
	{
		ref: RpcGitRefSchema,
		ahead: RpcSafeNonNegativeIntegerSchema,
		behind: RpcSafeNonNegativeIntegerSchema,
	},
	{ additionalProperties: false },
);

export const RpcGitChangeCountsSchema = Type.Object(
	{
		added: RpcSafeNonNegativeIntegerSchema,
		modified: RpcSafeNonNegativeIntegerSchema,
		deleted: RpcSafeNonNegativeIntegerSchema,
		renamed: RpcSafeNonNegativeIntegerSchema,
	},
	{ additionalProperties: false },
);

export const RpcGitStatusCountsSchema = Type.Object(
	{
		staged: RpcGitChangeCountsSchema,
		unstaged: RpcGitChangeCountsSchema,
		untracked: RpcSafeNonNegativeIntegerSchema,
		conflicted: RpcSafeNonNegativeIntegerSchema,
		/** Number of unique changed paths; a dual-state path contributes once here. */
		total: RpcSafeNonNegativeIntegerSchema,
		clean: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const RpcGitOperationSchema = Type.Object(
	{
		kind: stringEnum(["merge", "rebase", "cherry_pick", "revert", "bisect", "sequencer"]),
		step: Type.Optional(RpcSafeNonNegativeIntegerSchema),
		total: Type.Optional(RpcSafeNonNegativeIntegerSchema),
	},
	{ additionalProperties: false },
);

/** Path-free, host-observed Git metadata for the active session worktree. */
export const RpcGitContextSchema = Type.Object(
	{
		repository: Type.String({
			minLength: 1,
			maxLength: RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
		}),
		head: RpcGitHeadSchema,
		upstream: Type.Union([RpcGitComparisonSchema, Type.Null()]),
		base: Type.Union([RpcGitComparisonSchema, Type.Null()]),
		status: RpcGitStatusCountsSchema,
		operation: Type.Union([RpcGitOperationSchema, Type.Null()]),
		/** Monotonic only within the lifetime of one provider instance. */
		revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		observedAt: Type.String({
			minLength: 1,
			maxLength: RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS,
		}),
		stale: Type.Boolean(),
	},
	{ additionalProperties: false },
);
