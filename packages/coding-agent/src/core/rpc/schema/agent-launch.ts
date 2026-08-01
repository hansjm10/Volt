import { Type } from "typebox";
import { RpcAgentModeSchema } from "./planning.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";
import { RpcCatalogModelSchema } from "./session.ts";

export const RpcAgentLaunchModelSelectionSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		modelId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchConfigSchema = Type.Object(
	{
		model: Type.Optional(RpcAgentLaunchModelSelectionSchema),
		thinkingLevel: Type.Optional(RpcThinkingLevelSchema),
		fastModeEnabled: Type.Boolean(),
		agentMode: RpcAgentModeSchema,
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchConfiguredConfigSchema = Type.Object(
	{
		kind: Type.Literal("configured"),
		model: RpcAgentLaunchModelSelectionSchema,
		thinkingLevel: RpcThinkingLevelSchema,
		fastModeEnabled: Type.Boolean(),
		agentMode: RpcAgentModeSchema,
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchWorkspacePlacementSchema = Type.Object(
	{
		kind: Type.Literal("workspace"),
		workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchExistingWorktreePlacementSchema = Type.Object(
	{
		kind: Type.Literal("existing_worktree"),
		worktreeId: Type.String({ minLength: 1 }),
		workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchNewWorktreePlacementSchema = Type.Object(
	{
		kind: Type.Literal("new_worktree"),
		worktreeName: Type.Optional(Type.String({ minLength: 1 })),
		branch: Type.Optional(Type.String({ minLength: 1 })),
		baseRef: Type.Optional(Type.String({ minLength: 1 })),
		workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchPlacementSchema = Type.Union([
	RpcAgentLaunchWorkspacePlacementSchema,
	RpcAgentLaunchExistingWorktreePlacementSchema,
	RpcAgentLaunchNewWorktreePlacementSchema,
]);

export const RpcAgentLaunchResolvedWorkspacePlacementSchema = Type.Object(
	{
		kind: Type.Literal("workspace"),
		workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchResolvedWorktreePlacementSchema = Type.Object(
	{
		kind: Type.Literal("worktree"),
		worktreeId: Type.String({ minLength: 1 }),
		branch: Type.String({ minLength: 1 }),
		created: Type.Boolean(),
		workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchResolvedPlacementSchema = Type.Union([
	RpcAgentLaunchResolvedWorkspacePlacementSchema,
	RpcAgentLaunchResolvedWorktreePlacementSchema,
]);

export const RpcAgentLaunchErrorSchema = Type.Union([
	Type.Object({ kind: Type.Literal("invalid_request"), message: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("stale_catalog"), message: Type.String(), currentRevision: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("model_unavailable"), message: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("thinking_level_unsupported"), message: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("fast_mode_unsupported"), message: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("placement_unavailable"), message: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("cleanup_required"), message: Type.String(), worktreeId: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("launch_conflict"), message: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("authorization_changed"), message: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("host_shutdown"), message: Type.String() }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("internal_error"), message: Type.String() }, { additionalProperties: false }),
]);

export const RpcAgentLaunchSuccessSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("created"), Type.Literal("existing")]),
		launchId: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
		placement: RpcAgentLaunchResolvedPlacementSchema,
		config: RpcAgentLaunchConfiguredConfigSchema,
	},
	{ additionalProperties: false },
);

export const RpcAgentLaunchResultSchema = Type.Union([
	RpcAgentLaunchSuccessSchema,
	Type.Object(
		{
			kind: Type.Literal("error"),
			error: RpcAgentLaunchErrorSchema,
		},
		{ additionalProperties: false },
	),
]);

export const RpcAgentLaunchOptionsSchema = Type.Object(
	{
		workspaceName: Type.String({ minLength: 1 }),
		revision: Type.String({ minLength: 1 }),
		models: Type.Array(RpcCatalogModelSchema),
		defaultConfig: RpcAgentLaunchConfiguredConfigSchema,
	},
	{ additionalProperties: false },
);
