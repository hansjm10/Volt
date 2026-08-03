/**
 * Shared leaf schemas of the RPC wire contract.
 *
 * Byte budgets appear as `x-volt-max-utf8-bytes` annotations only: JSON Schema
 * `maxLength` counts code points, not UTF-8 bytes, so byte limits are enforced
 * by the layered checks in rpc-command-validation.ts and documented here for
 * clients. `x-volt-expected` carries the human phrasing validation errors use.
 */

import { Type } from "typebox";
import {
	RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE,
	RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN,
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_WIRE_MAX_SAFE_INTEGER,
} from "../wire-limits.ts";
import { stringEnum } from "./helpers.ts";

/** Matches exactly the trimmed non-empty strings: no surrounding whitespace, at least one character. */
export const RPC_TRIMMED_NON_EMPTY_PATTERN = "^\\S(?:[\\s\\S]*\\S)?$";

/**
 * A conversation-scoped identifier: session, subscription, branch epoch,
 * workflow, and recovery-request ids. Trimmed, non-empty, and (layered) at
 * most 256 UTF-8 bytes.
 */
export const RpcConversationIdentifierSchema = Type.String({
	pattern: RPC_TRIMMED_NON_EMPTY_PATTERN,
	"x-volt-max-utf8-bytes": RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	"x-volt-expected": "be a non-empty string",
});

/** Durable client-supplied message identity. The pattern is the complete grammar. */
export const RpcClientMessageIdSchema = Type.String({
	pattern: RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN,
	"x-volt-expected": `match ${RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE}`,
});

export const RpcSafeNonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: RPC_WIRE_MAX_SAFE_INTEGER,
	"x-volt-expected": "be a safe non-negative integer",
});

/**
 * Optimistic authority captured from one ordered-conversation bootstrap.
 * Exactly these three fields; each trimmed, non-empty, and byte-bounded by the
 * layered check.
 */
export const RpcConversationAuthoritySchema = Type.Object(
	{
		sessionId: RpcConversationIdentifierSchema,
		subscriptionId: RpcConversationIdentifierSchema,
		branchEpoch: RpcConversationIdentifierSchema,
	},
	{ additionalProperties: false },
);

export const RpcAssistantStreamPositionSchema = Type.Object(
	{
		epoch: RpcSafeNonNegativeIntegerSchema,
		seq: RpcSafeNonNegativeIntegerSchema,
	},
	{
		additionalProperties: false,
		"x-volt-expected": "be a safe non-negative epoch/seq position",
	},
);

export const RpcConversationDiscontinuityReasonSchema = stringEnum([
	"cursor_gap",
	"assistant_position_gap",
	"reducer_divergence",
]);

/** `branch_rebase` retains conversation identity; `session_rebind` replaces it. */
export const RpcConversationBootstrapReasonSchema = stringEnum([
	"bootstrap",
	"branch_rebase",
	"session_rebind",
	"resync",
	"overflow",
]);

/** Wire projection of volt-ai's ImageContent (pinned in type-assertions.ts). */
export const RpcImageContentSchema = Type.Object(
	{
		type: Type.Literal("image"),
		data: Type.String({ "x-volt-max-utf8-bytes": RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES }),
		mimeType: Type.String({ "x-volt-max-utf8-bytes": RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES }),
	},
	{ additionalProperties: false },
);

export const RpcConversationInputImagesSchema = Type.Array(RpcImageContentSchema, {
	"x-volt-max-items": RPC_CONVERSATION_INPUT_MAX_IMAGES,
	"x-volt-expected": "be an array of image objects",
});

/** Wire projection of volt-agent-core's seven-level ThinkingLevel (pinned in type-assertions.ts). */
export const RpcThinkingLevelSchema = stringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
	"x-volt-expected": "be a supported thinking level",
});

export const RpcStreamingBehaviorSchema = stringEnum(["steer", "followUp"]);

export const RpcQueueModeSchema = stringEnum(["all", "one-at-a-time"]);

export const RpcUiActionListScopeSchema = stringEnum(["primary", "palette", "all"]);

// ============================================================================
// Push registration
// ============================================================================

export const RpcPushProviderSchema = stringEnum(["fcm"]);
export const RpcPushPlatformSchema = stringEnum(["ios"]);

export const RpcRegisterPushTargetArgsSchema = Type.Object(
	{
		provider: RpcPushProviderSchema,
		platform: RpcPushPlatformSchema,
		pushTargetId: Type.String(),
		pushTargetAuthToken: Type.String(),
		relayUrl: Type.Optional(Type.String()),
		tokenHash: Type.Optional(Type.String()),
		enabled: Type.Boolean(),
	},
	{
		additionalProperties: false,
		"x-volt-expected": "be a push target registration object",
	},
);
