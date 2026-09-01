import { Buffer } from "node:buffer";
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES } from "../src/core/rpc/types.ts";
import { RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN } from "../src/core/rpc/wire-limits.ts";
import { isValidClientMessageId } from "../src/core/session-manager.ts";
import {
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	validateRpcCommandPayload,
} from "../src/modes/rpc/rpc-command-validation.ts";

const clientMessageId = "client-message-1";

const invalidPayloadCases: Array<{ name: string; payload: unknown; error: string }> = [
	{
		name: "rejects missing prompt client message identities",
		payload: { type: "prompt", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing steer client message identities",
		payload: { type: "steer", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing follow-up client message identities",
		payload: { type: "follow_up", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing prompt messages",
		payload: { type: "prompt", clientMessageId },
		error: 'Invalid RPC command payload: "message" is required',
	},
	{
		name: "rejects non-string prompt messages",
		payload: { type: "prompt", clientMessageId, message: 1 },
		error: 'Invalid RPC command payload: "message" must be a string',
	},
	{
		name: "rejects invalid prompt images",
		payload: { type: "prompt", clientMessageId, message: "hello", images: [{ type: "image", data: "abc" }] },
		error: 'Invalid RPC command payload: "images[0].mimeType" is required',
	},
	{
		name: "rejects invalid prompt streaming behavior",
		payload: { type: "prompt", clientMessageId, message: "hello", streamingBehavior: "queue" },
		error: 'Invalid RPC command payload: "streamingBehavior" must be "steer" or "followUp"',
	},
	{
		name: "rejects invalid steer images",
		payload: { type: "steer", clientMessageId, message: "hello", images: "image" },
		error: 'Invalid RPC command payload: "images" must be an array of image objects',
	},
	{
		name: "rejects invalid new-session parents",
		payload: { type: "new_session", parentSessionId: 1 },
		error: 'Invalid RPC command payload: "parentSessionId" must be a non-empty string',
	},
	{
		name: "rejects invalid client capability lists",
		payload: { type: "set_client_capabilities", features: ["host_action_requests.v1", 1] },
		error: 'Invalid RPC command payload: "features[1]" must be a string',
	},
	{
		name: "rejects non-array client capability lists",
		payload: { type: "set_client_capabilities", features: "host_action_requests.v1" },
		error: 'Invalid RPC command payload: "features" must be an array of strings',
	},
	{
		name: "rejects incomplete discontinuity reports",
		payload: { type: "report_stream_discontinuity" },
		error: 'Invalid RPC command payload: "id" is required',
	},
	{
		name: "rejects unsafe discontinuity cursors",
		payload: {
			id: "recovery-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: Number.MAX_SAFE_INTEGER + 1,
			reason: "cursor_gap",
		},
		error: 'Invalid RPC command payload: "lastAppliedCursor" must be a safe non-negative integer',
	},
	{
		name: "rejects invalid discontinuity reasons",
		payload: {
			id: "recovery-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: 4,
			reason: "unknown",
		},
		error: 'Invalid RPC command payload: "reason" must be "cursor_gap", "assistant_position_gap", or "reducer_divergence"',
	},
	{
		name: "rejects invalid UI action scopes",
		payload: { type: "get_ui_actions", scope: "secondary" },
		error: 'Invalid RPC command payload: "scope" must be "primary", "palette", or "all"',
	},
	{
		name: "rejects incomplete UI action completion requests",
		payload: { type: "get_ui_action_completions", action: "review" },
		error: 'Invalid RPC command payload: "argument" is required',
	},
	{
		name: "rejects UI action invocations without a correlation id",
		payload: { type: "invoke_ui_action", action: "review" },
		error: 'Invalid RPC command payload: "id" is required',
	},
	{
		name: "rejects UI action invocations with a non-string correlation id",
		payload: { id: 7, type: "invoke_ui_action", action: "review" },
		error: 'Invalid RPC command payload: "id" must be a non-empty string',
	},
	{
		name: "rejects UI action invocations with an empty correlation id",
		payload: { id: "", type: "invoke_ui_action", action: "review" },
		error: 'Invalid RPC command payload: "id" must be a non-empty string',
	},
	{
		name: "rejects UI action invocations with a padded correlation id",
		payload: { id: " invoke-review ", type: "invoke_ui_action", action: "review" },
		error: 'Invalid RPC command payload: "id" must be a non-empty string',
	},
	{
		name: "rejects UI action invocation ids beyond the identifier byte bound",
		payload: { id: "é".repeat(129), type: "invoke_ui_action", action: "review" },
		error: 'Invalid RPC command payload: "id" exceeds the 256-byte UTF-8 limit',
	},
	{
		name: "rejects invalid UI action invocation args",
		payload: { id: "invoke-review", type: "invoke_ui_action", action: "review", args: [] },
		error: 'Invalid RPC command payload: "args" must be an object',
	},
	{
		name: "rejects cancellation commands without a workflowId",
		payload: { type: "cancel_workflow" },
		error: 'Invalid RPC command payload: "workflowId" is required',
	},
	{
		name: "rejects review workflow commands with an empty runId",
		payload: { type: "get_review_result", runId: "   " },
		error: 'Invalid RPC command payload: "runId" must be a non-empty string',
	},
	{
		name: "rejects review run ids beyond the identifier byte bound",
		payload: { type: "open_review_session", runId: "r".repeat(300) },
		error: 'Invalid RPC command payload: "runId" exceeds the 256-byte UTF-8 limit',
	},
	{
		name: "rejects review finding id arrays beyond the identifier byte bound",
		payload: { type: "open_review_session", runId: "review:one", findingIds: ["f".repeat(300)] },
		error: 'Invalid RPC command payload: "findingIds[0]" exceeds the 256-byte UTF-8 limit',
	},
	{
		name: "rejects acknowledgment review ids beyond the identifier byte bound",
		payload: { type: "acknowledge_review", runId: "r".repeat(300) },
		error: 'Invalid RPC command payload: "runId" exceeds the 256-byte UTF-8 limit',
	},
	{
		name: "rejects review finding ids beyond the identifier byte bound",
		payload: {
			type: "record_review_finding_outcome",
			runId: "review:one",
			findingId: "f".repeat(300),
			status: "accepted",
		},
		error: 'Invalid RPC command payload: "findingId" exceeds the 256-byte UTF-8 limit',
	},
	{
		name: "rejects incomplete push target registrations",
		payload: { type: "register_push_target", args: { provider: "fcm", platform: "ios", enabled: true } },
		error: 'Invalid RPC command payload: "args.pushTargetId" is required',
	},
	{
		name: "rejects non-object push target registrations",
		payload: { type: "register_push_target", args: "registration" },
		error: 'Invalid RPC command payload: "args" must be a push target registration object',
	},
	{
		name: "rejects unknown push providers",
		payload: {
			type: "register_push_target",
			args: {
				provider: "apns",
				platform: "ios",
				pushTargetId: "target",
				pushTargetAuthToken: "token",
				enabled: true,
			},
		},
		error: 'Invalid RPC command payload: "args.provider" must be "fcm"',
	},
	{
		name: "rejects invalid transcript pagination",
		payload: { type: "get_transcript", limit: "10" },
		error: 'Invalid RPC command payload: "limit" must be a number',
	},
	{
		name: "rejects invalid MCP resource cursor",
		payload: { type: "list_mcp_resources", server: "docs", cursor: 1 },
		error: 'Invalid RPC command payload: "cursor" must be a string',
	},
	{
		name: "rejects invalid MCP prompt cursor",
		payload: { type: "list_mcp_prompts", server: "docs", cursor: 1 },
		error: 'Invalid RPC command payload: "cursor" must be a string',
	},
	{
		name: "rejects invalid model providers",
		payload: { type: "set_model", provider: 1, modelId: "model" },
		error: 'Invalid RPC command payload: "provider" must be a string',
	},
	{
		name: "rejects invalid thinking levels",
		payload: { type: "set_thinking_level", level: "bad" },
		error: 'Invalid RPC command payload: "level" must be a supported thinking level',
	},
	{
		name: "rejects invalid queue modes",
		payload: { type: "set_steering_mode", mode: "latest" },
		error: 'Invalid RPC command payload: "mode" must be "all" or "one-at-a-time"',
	},
	{
		name: "rejects invalid compaction instructions",
		payload: { type: "compact", customInstructions: false },
		error: 'Invalid RPC command payload: "customInstructions" must be a string',
	},
	{
		name: "rejects invalid boolean state mutations",
		payload: { type: "set_auto_retry", enabled: "true" },
		error: 'Invalid RPC command payload: "enabled" must be a boolean',
	},
	{
		name: "rejects invalid bash commands",
		payload: { type: "bash", command: 1 },
		error: 'Invalid RPC command payload: "command" must be a string',
	},
	{
		name: "rejects invalid export paths",
		payload: { type: "export_html", outputPath: 1 },
		error: 'Invalid RPC command payload: "outputPath" must be a string',
	},
	{
		name: "rejects invalid switch-session IDs",
		payload: { type: "switch_session", sessionId: 1 },
		error: 'Invalid RPC command payload: "sessionId" must be a string',
	},
	{
		name: "rejects invalid switch-session IDs",
		payload: { type: "switch_session_by_id", sessionId: 1 },
		error: 'Invalid RPC command payload: "sessionId" must be a string',
	},
	{
		name: "rejects invalid fork entry IDs",
		payload: { type: "fork", entryId: 1 },
		error: 'Invalid RPC command payload: "entryId" must be a string',
	},
	{
		name: "rejects invalid session names",
		payload: { type: "set_session_name", name: 1 },
		error: 'Invalid RPC command payload: "name" must be a string',
	},
	{
		name: "rejects unknown fields on known commands",
		payload: { type: "get_state", bogusField: true },
		error: 'Invalid RPC command payload: "bogusField" is not a recognized field',
	},
	{
		name: "rejects legacy unregister-workspace path fields",
		payload: { type: "unregister_workspace", name: "workspace", path: "/tmp/workspace" },
		error: 'Invalid RPC command payload: "path" is not a recognized field',
	},
	{
		name: "rejects blank workspace names",
		payload: { type: "unregister_workspace", name: "   " },
		error: 'Invalid RPC command payload: "name" must be a non-empty workspace name',
	},
	{
		name: "rejects invalid keep-awake toggles",
		payload: { type: "set_keep_awake", enabled: "on" },
		error: 'Invalid RPC command payload: "enabled" must be a boolean',
	},
	{
		name: "rejects device log uploads without content",
		payload: { type: "upload_device_logs", fileName: "device.log" },
		error: 'Invalid RPC command payload: "content" is required',
	},
	{
		name: "rejects invalid web search keys",
		payload: { type: "set_web_search_key", apiKey: 7 },
		error: 'Invalid RPC command payload: "apiKey" must be a string or null',
	},
	{
		name: "rejects invalid discontinuity assistant positions",
		payload: {
			id: "recovery-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: 4,
			assistantPosition: { epoch: 2, seq: -1 },
			reason: "cursor_gap",
		},
		error: 'Invalid RPC command payload: "assistantPosition.seq" must be a safe non-negative integer',
	},
];

describe("RPC command payload validation", () => {
	test.each(invalidPayloadCases)("$name", ({ payload, error }) => {
		expect(validateRpcCommandPayload(payload)).toBe(error);
	});

	test("allows non-command and valid command payloads to continue through dispatch", () => {
		expect(validateRpcCommandPayload("not an object")).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "future_command", message: 1 })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "set_thinking_level", level: "max" })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "cancel_workflow", workflowId: "review:one" })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "get_review_result", runId: "review:one" })).toBeUndefined();
		expect(
			validateRpcCommandPayload({ type: "open_review_session", runId: "review:one", findingIds: ["finding:one"] }),
		).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "acknowledge_review", runId: "review:one" })).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				type: "record_review_finding_outcome",
				runId: "review:one",
				findingId: "finding:one",
				status: "accepted",
			}),
		).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "rerun_review", runId: "review:one" })).toBeUndefined();
		expect(
			validateRpcCommandPayload({ type: "publish_review", runId: "review:one", confirmed: true }),
		).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "export_review_feedback" })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "list_review_workflows" })).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				id: "é".repeat(128),
				type: "invoke_ui_action",
				action: "review.uncommitted",
				args: {},
			}),
		).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				id: "recovery-1",
				type: "report_stream_discontinuity",
				sessionId: "session-1",
				subscriptionId: "subscription-1",
				lastAppliedCursor: 4,
				assistantPosition: { epoch: 2, seq: 9 },
				reason: "assistant_position_gap",
			}),
		).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				type: "register_push_target",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "target-id",
					pushTargetAuthToken: "auth-token",
					enabled: true,
					relayUrl: "https://example.com",
					tokenHash: "token-hash",
				},
			}),
		).toBeUndefined();
	});

	test("bounds conversation text by UTF-8 bytes for prompt, steer, and follow-up", () => {
		const oversizedUnicode = "🧪".repeat(Math.floor(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES / 4) + 1);
		for (const type of ["prompt", "steer", "follow_up"]) {
			expect(validateRpcCommandPayload({ type, clientMessageId, message: oversizedUnicode })).toBe(
				`Invalid RPC command payload: "message" exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "a".repeat(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES),
			}),
		).toBeUndefined();
	});

	test("bounds serialized conversation text even when images are omitted", () => {
		const escapedText = "\u0000".repeat(400 * 1024);
		expect(Buffer.byteLength(escapedText, "utf8")).toBeLessThan(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES);
		expect(Buffer.byteLength(JSON.stringify({ message: escapedText, images: [] }), "utf8")).toBeGreaterThan(
			RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
		);
		for (const type of ["prompt", "steer", "follow_up"]) {
			expect(validateRpcCommandPayload({ type, clientMessageId, message: escapedText })).toBe(
				`Invalid RPC command payload: conversation input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`,
			);
		}
	});

	test("bounds ordered-conversation authority identifiers", () => {
		const oversized = "🧪".repeat(Math.floor(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES / 4) + 1);
		for (const field of ["id", "sessionId", "subscriptionId"] as const) {
			const command = {
				id: "recovery-1",
				type: "report_stream_discontinuity",
				sessionId: "session-1",
				subscriptionId: "subscription-1",
				lastAppliedCursor: 4,
				reason: "cursor_gap",
				[field]: oversized,
			};
			expect(validateRpcCommandPayload(command)).toBe(
				`Invalid RPC command payload: "${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		expect(validateRpcCommandPayload({ type: "get_transcript", branchEpoch: oversized })).toBe(
			`Invalid RPC command payload: "branchEpoch" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);
	});

	test("accepts only the exact bounded conversation-authority tuple", () => {
		const authority = {
			sessionId: "s".repeat(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES),
			subscriptionId: "p".repeat(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES),
			branchEpoch: "b".repeat(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES),
		};
		expect(validateRpcCommandPayload({ type: "abort", conversationAuthority: authority })).toBeUndefined();
		// Authority remains optional on the transport-neutral RPC contract.
		expect(validateRpcCommandPayload({ type: "abort" })).toBeUndefined();

		expect(validateRpcCommandPayload({ type: "abort", conversationAuthority: null })).toBe(
			'Invalid RPC command payload: "conversationAuthority" must be an object',
		);
		expect(
			validateRpcCommandPayload({
				type: "abort",
				conversationAuthority: { sessionId: "session", subscriptionId: "subscription" },
			}),
		).toBe(
			'Invalid RPC command payload: "conversationAuthority" must contain exactly "sessionId", "subscriptionId", and "branchEpoch"',
		);
		expect(
			validateRpcCommandPayload({
				type: "abort",
				conversationAuthority: { ...authority, extra: "not-authority" },
			}),
		).toBe(
			'Invalid RPC command payload: "conversationAuthority" must contain exactly "sessionId", "subscriptionId", and "branchEpoch"',
		);
		expect(
			validateRpcCommandPayload({
				type: "abort",
				conversationAuthority: { ...authority, branchEpoch: " branch" },
			}),
		).toBe(
			'Invalid RPC command payload: "conversationAuthority.branchEpoch" must not contain surrounding whitespace',
		);

		for (const field of ["sessionId", "subscriptionId", "branchEpoch"] as const) {
			expect(
				validateRpcCommandPayload({
					type: "abort",
					conversationAuthority: { ...authority, [field]: "🧪".repeat(65) },
				}),
			).toBe(
				`Invalid RPC command payload: "conversationAuthority.${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
	});

	test("requires canonical bounded ASCII client message identities", () => {
		const invalidClientMessageIds = [
			" client-message-1",
			"client-message-1 ",
			"client\nmessage",
			"client\0message",
			'client"message',
			"client\\message",
			"client-méssage",
			`client-${"x".repeat(250)}`,
		];
		const expected = 'Invalid RPC command payload: "clientMessageId" must match [A-Za-z0-9][A-Za-z0-9._:-]{0,255}';
		for (const type of ["prompt", "steer", "follow_up"]) {
			for (const invalidClientMessageId of invalidClientMessageIds) {
				expect(validateRpcCommandPayload({ type, clientMessageId: invalidClientMessageId, message: "hi" })).toBe(
					expected,
				);
			}
		}
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId: `A${"x".repeat(255)}`,
				message: "hi",
			}),
		).toBeUndefined();
	});

	test("schema clientMessageId grammar agrees with isValidClientMessageId", () => {
		const schemaPattern = new RegExp(RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN);
		const candidates = fc.oneof(
			fc.string({ maxLength: 300 }),
			fc.string({ unit: "binary", maxLength: 300 }),
			fc.stringMatching(/^[A-Za-z0-9._:-]{0,300}$/),
			fc.stringMatching(/^[A-Za-z0-9._:-]{0,40}$/).map((suffix) => `local-queue:${suffix}`),
		);
		fc.assert(
			fc.property(candidates, (value) => {
				expect(schemaPattern.test(value)).toBe(isValidClientMessageId(value));
				const structuralError = validateRpcCommandPayload({
					type: "prompt",
					clientMessageId: value,
					message: "hi",
				});
				expect(structuralError === undefined).toBe(isValidClientMessageId(value));
			}),
		);
	});

	test("bounds image count, per-image data, aggregate payload, and serialized input", () => {
		const image = { type: "image", mimeType: "image/png", data: "a" } as const;
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "image count",
				images: Array.from({ length: RPC_CONVERSATION_INPUT_MAX_IMAGES + 1 }, () => image),
			}),
		).toBe(`Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-image limit`);

		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "one image",
				images: [{ ...image, data: "a".repeat(RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES + 1) }],
			}),
		).toBe(
			`Invalid RPC command payload: "images[0].data" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);

		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "aggregate images",
				images: [
					{ ...image, data: "a".repeat(800 * 1024) },
					{ ...image, data: "b".repeat(800 * 1024) },
				],
			}),
		).toBe(
			`Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 payload limit`,
		);

		const mimeBytes = Buffer.byteLength(image.mimeType, "utf8");
		const combinedDataBytes = RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES - mimeBytes * 2;
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "m".repeat(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES),
				images: [
					{ ...image, data: "a".repeat(Math.floor(combinedDataBytes / 2)) },
					{ ...image, data: "b".repeat(Math.ceil(combinedDataBytes / 2)) },
				],
			}),
		).toBe(
			`Invalid RPC command payload: conversation input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`,
		);
	});
});
