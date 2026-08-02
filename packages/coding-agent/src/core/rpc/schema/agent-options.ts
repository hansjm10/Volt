import { Type } from "typebox";
import { RpcAgentModeSchema } from "./planning.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";
import { RpcCatalogModelSchema } from "./session.ts";

export const RpcAgentOptionsModelSelectionSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		modelId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const RpcAgentOptionsDefaultConfigSchema = Type.Object(
	{
		model: RpcAgentOptionsModelSelectionSchema,
		thinkingLevel: RpcThinkingLevelSchema,
		fastModeEnabled: Type.Boolean(),
		agentMode: RpcAgentModeSchema,
	},
	{ additionalProperties: false },
);

export const RpcAgentOptionsSchema = Type.Object(
	{
		workspaceName: Type.String({ minLength: 1 }),
		models: Type.Array(RpcCatalogModelSchema),
		defaultConfig: RpcAgentOptionsDefaultConfigSchema,
	},
	{ additionalProperties: false },
);
