import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { ImageContent } from "@earendil-works/volt-ai";

const RPC_QUEUE_MODES = ["all", "one-at-a-time"] as const;
const RPC_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ThinkingLevel[];
const RPC_STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
const RPC_UI_ACTION_SCOPES = ["primary", "palette", "all"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && allowed.some((allowedValue) => allowedValue === value);
}

function isRpcQueueMode(value: unknown): value is (typeof RPC_QUEUE_MODES)[number] {
	return isOneOf(value, RPC_QUEUE_MODES);
}

function isRpcThinkingLevel(value: unknown): value is ThinkingLevel {
	return isOneOf(value, RPC_THINKING_LEVELS);
}

function isRpcStreamingBehavior(value: unknown): value is (typeof RPC_STREAMING_BEHAVIORS)[number] {
	return isOneOf(value, RPC_STREAMING_BEHAVIORS);
}

function isRpcUiActionScope(value: unknown): value is (typeof RPC_UI_ACTION_SCOPES)[number] {
	return isOneOf(value, RPC_UI_ACTION_SCOPES);
}

function isRpcImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isRpcImageContentArray(value: unknown): value is ImageContent[] {
	return Array.isArray(value) && value.every(isRpcImageContent);
}

function isRpcLiveActivityRegistration(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.activityId === "string" &&
		typeof value.pushToken === "string" &&
		(value.tokenHash === undefined || typeof value.tokenHash === "string") &&
		(value.tokenEnvironment === undefined ||
			value.tokenEnvironment === "development" ||
			value.tokenEnvironment === "production")
	);
}

function isRpcRegisterPushTargetArgs(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.provider === "fcm" &&
		value.platform === "ios" &&
		typeof value.pushTargetId === "string" &&
		typeof value.pushTargetAuthToken === "string" &&
		typeof value.enabled === "boolean" &&
		(value.relayUrl === undefined || typeof value.relayUrl === "string") &&
		(value.tokenHash === undefined || typeof value.tokenHash === "string") &&
		(value.liveActivity === undefined || isRpcLiveActivityRegistration(value.liveActivity))
	);
}

function validateRequiredField(
	command: Record<string, unknown>,
	field: string,
	isValid: (value: unknown) => boolean,
	expected: string,
): string | undefined {
	if (command[field] === undefined) {
		return `Invalid RPC command payload: "${field}" is required`;
	}
	if (!isValid(command[field])) {
		return `Invalid RPC command payload: "${field}" must be ${expected}`;
	}
	return undefined;
}

function validateOptionalField(
	command: Record<string, unknown>,
	field: string,
	isValid: (value: unknown) => boolean,
	expected: string,
): string | undefined {
	if (command[field] !== undefined && !isValid(command[field])) {
		return `Invalid RPC command payload: "${field}" must be ${expected}`;
	}
	return undefined;
}

export function validateRpcCommandPayload(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	switch (value.type) {
		case "prompt":
			return (
				validateRequiredField(value, "message", isString, "a string") ??
				validateOptionalField(value, "images", isRpcImageContentArray, "an array of image objects") ??
				validateOptionalField(value, "streamingBehavior", isRpcStreamingBehavior, '"steer" or "followUp"')
			);
		case "steer":
		case "follow_up":
			return (
				validateRequiredField(value, "message", isString, "a string") ??
				validateOptionalField(value, "images", isRpcImageContentArray, "an array of image objects")
			);
		case "new_session":
			return validateOptionalField(value, "parentSession", isString, "a string");
		case "set_client_capabilities":
			return validateRequiredField(value, "features", isStringArray, "an array of strings");
		case "get_ui_actions":
			return validateOptionalField(value, "scope", isRpcUiActionScope, '"primary", "palette", or "all"');
		case "get_ui_action_completions":
			return (
				validateRequiredField(value, "action", isString, "a string") ??
				validateRequiredField(value, "argument", isString, "a string") ??
				validateOptionalField(value, "prefix", isString, "a string")
			);
		case "invoke_ui_action":
			return (
				validateRequiredField(value, "action", isString, "a string") ??
				validateOptionalField(value, "args", isRecord, "an object") ??
				validateOptionalField(value, "streamingBehavior", isRpcStreamingBehavior, '"steer" or "followUp"')
			);
		case "register_push_target":
			return validateRequiredField(value, "args", isRpcRegisterPushTargetArgs, "a push target registration object");
		case "unregister_workspace":
			return (
				validateRequiredField(
					value,
					"name",
					(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
					"a non-empty workspace name",
				) ??
				validateOptionalField(value, "path", () => false, "omitted") ??
				validateOptionalField(value, "workspacePath", () => false, "omitted")
			);
		case "get_transcript":
			return (
				validateOptionalField(value, "beforeEntryId", isString, "a string") ??
				validateOptionalField(value, "limit", isNumber, "a number")
			);
		case "subagent_start":
			return (
				validateRequiredField(value, "agent", isString, "a string") ??
				validateRequiredField(value, "prompt", isString, "a string")
			);
		case "subagent_abort":
		case "subagent_get_state":
		case "subagent_dispose":
			return validateRequiredField(value, "subagentId", isString, "a string");
		case "subagent_get_transcript":
			return (
				validateRequiredField(value, "subagentId", isString, "a string") ??
				validateOptionalField(value, "beforeEntryId", isString, "a string") ??
				validateOptionalField(value, "limit", isNumber, "a number")
			);
		case "set_model":
			return (
				validateRequiredField(value, "provider", isString, "a string") ??
				validateRequiredField(value, "modelId", isString, "a string")
			);
		case "set_thinking_level":
			return validateRequiredField(value, "level", isRpcThinkingLevel, "a supported thinking level");
		case "set_steering_mode":
		case "set_follow_up_mode":
			return validateRequiredField(value, "mode", isRpcQueueMode, '"all" or "one-at-a-time"');
		case "compact":
			return validateOptionalField(value, "customInstructions", isString, "a string");
		case "set_auto_compaction":
		case "set_auto_retry":
			return validateRequiredField(value, "enabled", isBoolean, "a boolean");
		case "bash":
			return (
				validateRequiredField(value, "command", isString, "a string") ??
				validateOptionalField(value, "excludeFromContext", isBoolean, "a boolean")
			);
		case "export_html":
			return validateOptionalField(value, "outputPath", isString, "a string");
		case "switch_session":
			return validateRequiredField(value, "sessionPath", isString, "a string");
		case "switch_session_by_id":
			return validateRequiredField(value, "sessionId", isString, "a string");
		case "fork":
			return validateRequiredField(value, "entryId", isString, "a string");
		case "set_session_name":
			return validateRequiredField(value, "name", isString, "a string");
		default:
			return undefined;
	}
}
