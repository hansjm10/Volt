/**
 * Wire projections of upstream types (volt-ai) that cross the RPC boundary
 * inside assistant messages, stream frames, and model catalogs. Every schema
 * here is pinned to its upstream type in type-assertions.ts, so an upstream
 * shape change fails typecheck until the contract is updated consciously.
 */

import type { JsonObject } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import type { RpcModel } from "../types.ts";
import { opaque, openStringEnum, stringEnum } from "./helpers.ts";

export const RpcTextContentSchema = Type.Object(
	{
		type: Type.Literal("text"),
		text: Type.String(),
		textSignature: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcThinkingContentSchema = Type.Object(
	{
		type: Type.Literal("thinking"),
		thinking: Type.String(),
		thinkingSignature: Type.Optional(Type.String()),
		redacted: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const RpcToolCallSchema = Type.Object(
	{
		type: Type.Literal("toolCall"),
		id: Type.String(),
		name: Type.String(),
		arguments: Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown())),
		thoughtSignature: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcAssistantContentSchema = Type.Union([
	RpcTextContentSchema,
	RpcThinkingContentSchema,
	RpcToolCallSchema,
]);

const rpcServiceTierSchema = stringEnum(["auto", "default", "flex", "scale", "priority"]);

export const RpcUsageSchema = Type.Object(
	{
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cacheWrite1h: Type.Optional(Type.Number()),
		totalTokens: Type.Number(),
		cost: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
				total: Type.Number(),
			},
			{ additionalProperties: false },
		),
		serviceTier: Type.Optional(
			Type.Object(
				{
					requested: Type.Optional(rpcServiceTierSchema),
					effective: Type.Optional(rpcServiceTierSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const RpcStopReasonSchema = stringEnum(["stop", "length", "toolUse", "error", "aborted"]);

export const RpcApiSchema = openStringEnum([
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
]);

export const RpcDiagnosticErrorInfoSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		message: Type.String(),
		stack: Type.Optional(Type.String()),
		code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	},
	{ additionalProperties: false },
);

export const RpcAssistantMessageDiagnosticSchema = Type.Object(
	{
		type: Type.String(),
		timestamp: Type.Number(),
		error: Type.Optional(RpcDiagnosticErrorInfoSchema),
		details: Type.Optional(Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()))),
	},
	{ additionalProperties: false },
);

export const RpcAssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.Array(RpcAssistantContentSchema),
		api: RpcApiSchema,
		provider: Type.String(),
		model: Type.String(),
		responseModel: Type.Optional(Type.String()),
		responseId: Type.Optional(Type.String()),
		diagnostics: Type.Optional(Type.Array(RpcAssistantMessageDiagnosticSchema)),
		usage: RpcUsageSchema,
		stopReason: RpcStopReasonSchema,
		errorMessage: Type.Optional(Type.String()),
		timestamp: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RpcActiveToolCallStateSchema = Type.Object(
	{
		contentIndex: Type.Integer(),
		argsText: Type.String(),
	},
	{ additionalProperties: false },
);

const modelThinkingLevelMapSchema = Type.Object(
	{
		off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		max: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);

const rpcModelCostTierSchema = Type.Object(
	{
		inputTokensAbove: Type.Number(),
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
	},
	{ additionalProperties: false },
);

/**
 * Shared properties of the model catalog entry. `compat` is deliberately
 * opaque: ~27 provider-tuning fields that clients never interpret.
 */
export const rpcModelProperties = {
	id: Type.String(),
	name: Type.String(),
	api: RpcApiSchema,
	provider: Type.String(),
	baseUrl: Type.String(),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(modelThinkingLevelMapSchema),
	input: Type.Array(stringEnum(["text", "image"])),
	cost: Type.Object(
		{
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
			tiers: Type.Optional(Type.Array(rpcModelCostTierSchema)),
		},
		{ additionalProperties: false },
	),
	contextWindow: Type.Number(),
	maxTokens: Type.Number(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(
		opaque<NonNullable<RpcModel["compat"]>>("provider compatibility tuning; clients never interpret this"),
	),
};

export const RpcModelSchema = Type.Object(rpcModelProperties, { additionalProperties: false });

// ============================================================================
// Slim assistant stream events (message_update payloads)
// ============================================================================

const contentIndexSchema = Type.Integer();

/**
 * The nine incremental assistant events carried by `message_update` frames:
 * the upstream AssistantMessageEvent variants minus their `seq`, `snapshot`,
 * and `toolState` fields (pinned to SlimAssistantEvent).
 */
export const RpcSlimAssistantEventSchema = Type.Union([
	Type.Object({ type: Type.Literal("text_start"), contentIndex: contentIndexSchema }, { additionalProperties: false }),
	Type.Object(
		{ type: Type.Literal("text_delta"), contentIndex: contentIndexSchema, delta: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("text_end"), contentIndex: contentIndexSchema, content: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("thinking_start"),
			contentIndex: contentIndexSchema,
			redacted: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("thinking_delta"), contentIndex: contentIndexSchema, delta: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("thinking_end"),
			contentIndex: contentIndexSchema,
			content: Type.String(),
			redacted: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("toolcall_start"),
			contentIndex: contentIndexSchema,
			id: Type.String(),
			name: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("toolcall_delta"),
			contentIndex: contentIndexSchema,
			argsTextDelta: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("toolcall_end"), contentIndex: contentIndexSchema, toolCall: RpcToolCallSchema },
		{ additionalProperties: false },
	),
]);
