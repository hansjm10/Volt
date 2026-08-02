import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS, normalizeIrohRemoteAllowTools } from "./protocol.ts";

export const IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION = 1 as const;

export const IROH_REMOTE_RPC_CAPABILITIES = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"model.select.v1",
	"integrations.manage.v1",
	"worktrees.manage.v1",
	"host.manage.v1",
	"workspace.manage.v1",
	"diagnostics.upload.v1",
] as const;

export type IrohRemoteRpcCapability = (typeof IROH_REMOTE_RPC_CAPABILITIES)[number];

export interface IrohRemoteRpcGrant {
	schemaVersion: typeof IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION;
	revision: number;
	capabilities: IrohRemoteRpcCapability[];
}

export const IROH_REMOTE_ACCESS_PRESET_NAMES = ["coding", "review", "chat", "full"] as const;
export type IrohRemoteAccessPresetName = (typeof IROH_REMOTE_ACCESS_PRESET_NAMES)[number];

export interface IrohRemoteAccessPreset {
	readonly name: IrohRemoteAccessPresetName;
	readonly allowedTools: string;
	readonly capabilities: readonly IrohRemoteRpcCapability[];
}

const STANDARD_CAPABILITIES = Object.freeze<IrohRemoteRpcCapability[]>([
	"conversation.observe.v1",
	"conversation.control.v1",
	"model.select.v1",
	// A paired device is the user's own; host-action responses, keep-awake, and
	// capability advertisement (host_action_requests.v1) work out of the box.
	"host.manage.v1",
]);

export const IROH_REMOTE_ACCESS_PRESETS: Readonly<Record<IrohRemoteAccessPresetName, IrohRemoteAccessPreset>> =
	Object.freeze({
		coding: Object.freeze({
			name: "coding",
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			capabilities: STANDARD_CAPABILITIES,
		}),
		review: Object.freeze({
			name: "review",
			allowedTools: "read,grep,find,ls",
			capabilities: STANDARD_CAPABILITIES,
		}),
		chat: Object.freeze({ name: "chat", allowedTools: "", capabilities: STANDARD_CAPABILITIES }),
		full: Object.freeze({
			name: "full",
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			capabilities: Object.freeze([...IROH_REMOTE_RPC_CAPABILITIES]),
		}),
	});

const CAPABILITY_SET = new Set<string>(IROH_REMOTE_RPC_CAPABILITIES);
const PRESET_NAME_SET = new Set<string>(IROH_REMOTE_ACCESS_PRESET_NAMES);

export function isIrohRemoteAccessPresetName(value: unknown): value is IrohRemoteAccessPresetName {
	return typeof value === "string" && PRESET_NAME_SET.has(value);
}

export function getIrohRemoteAccessPreset(name: IrohRemoteAccessPresetName): IrohRemoteAccessPreset {
	return IROH_REMOTE_ACCESS_PRESETS[name];
}

export function createIrohRemoteRpcGrant(
	capabilities: readonly IrohRemoteRpcCapability[],
	revision = 1,
): IrohRemoteRpcGrant {
	return parseIrohRemoteRpcGrant({
		schemaVersion: IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION,
		revision,
		capabilities: [...capabilities],
	});
}

export function createIrohRemotePresetAccess(
	name: IrohRemoteAccessPresetName,
	revision = 1,
): { allowedTools: string; rpcGrant: IrohRemoteRpcGrant } {
	const preset = getIrohRemoteAccessPreset(name);
	return {
		allowedTools: preset.allowedTools,
		rpcGrant: createIrohRemoteRpcGrant(preset.capabilities, revision),
	};
}

export function createIrohRemoteExplicitAccess(
	allowedTools: readonly string[],
	rpcCapabilities: readonly IrohRemoteRpcCapability[],
	revision = 1,
): { allowedTools: string; rpcGrant: IrohRemoteRpcGrant } {
	return {
		allowedTools: normalizeIrohRemoteAllowTools(allowedTools.join(",")),
		rpcGrant: createIrohRemoteRpcGrant(rpcCapabilities, revision),
	};
}

export function parseIrohRemoteRpcCapabilities(value: unknown, label = "rpc capabilities"): IrohRemoteRpcCapability[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	const capabilities: IrohRemoteRpcCapability[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !CAPABILITY_SET.has(entry)) {
			throw new Error(`${label} contains unknown capability: ${String(entry)}`);
		}
		if (seen.has(entry)) {
			throw new Error(`${label} must not contain duplicates: ${entry}`);
		}
		seen.add(entry);
		capabilities.push(entry as IrohRemoteRpcCapability);
	}
	return capabilities;
}

export function parseIrohRemoteRpcGrant(value: unknown, label = "rpc grant"): IrohRemoteRpcGrant {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const grant = value as Record<string, unknown>;
	if (grant.schemaVersion !== IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION) {
		throw new Error(`${label} schemaVersion must be ${IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION}`);
	}
	if (typeof grant.revision !== "number" || !Number.isSafeInteger(grant.revision) || grant.revision < 1) {
		throw new Error(`${label} revision must be a safe integer greater than or equal to 1`);
	}
	return {
		schemaVersion: IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION,
		revision: grant.revision,
		capabilities: parseIrohRemoteRpcCapabilities(grant.capabilities, `${label} capabilities`),
	};
}

export function cloneIrohRemoteRpcGrant(grant: IrohRemoteRpcGrant): IrohRemoteRpcGrant {
	return { schemaVersion: 1, revision: grant.revision, capabilities: [...grant.capabilities] };
}

const BASELINE_COMMANDS = new Set(["register_push_target", "register_live_activity", "unregister_live_activity"]);
const OBSERVE_COMMANDS = new Set([
	"get_state",
	"get_transcript",
	"get_review_result",
	"list_review_workflows",
	"report_stream_discontinuity",
	"get_message_images",
	"get_transcript_entry_text",
	"get_ui_capabilities",
	"get_ui_actions",
	"get_ui_action_completions",
	"list_sessions",
	"list_worktrees",
	"list_workspace_directories",
	"get_keep_awake",
]);
const CONTROL_COMMANDS = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"switch_session_by_id",
	"invoke_ui_action",
	"cancel_workflow",
	"open_review_session",
	"extension_ui_response",
]);
const MCP_COMMANDS = new Set([
	"get_mcp_capabilities",
	"list_mcp_servers",
	"get_mcp_server",
	"connect_mcp_server",
	"refresh_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_recent_calls",
	"list_mcp_tools",
	"get_mcp_tool",
	"list_mcp_resources",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
	"disconnect_mcp_server",
	"start_mcp_server_auth",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"set_web_search_key",
	"get_web_search_status",
]);
const HOST_COMMANDS = new Set(["get_pending_host_actions", "host_action_response", "set_keep_awake"]);

export function getIrohRemoteRpcCommandCapabilities(
	command: Record<string, unknown> & { type: string },
): readonly IrohRemoteRpcCapability[] | undefined {
	if (command.type === "set_client_capabilities") {
		return Array.isArray(command.features) && command.features.includes("host_action_requests.v1")
			? ["host.manage.v1"]
			: [];
	}
	if (BASELINE_COMMANDS.has(command.type)) return [];
	if (OBSERVE_COMMANDS.has(command.type)) return ["conversation.observe.v1"];
	if (CONTROL_COMMANDS.has(command.type)) return ["conversation.control.v1"];
	if (MCP_COMMANDS.has(command.type)) return ["integrations.manage.v1"];
	if (HOST_COMMANDS.has(command.type)) return ["host.manage.v1"];
	if (command.type === "get_available_models") return ["model.select.v1"];
	if (command.type === "set_model" || command.type === "set_thinking_level") {
		return command.persistDefault === false ? ["model.select.v1"] : ["model.select.v1", "host.manage.v1"];
	}
	if (command.type === "create_worktree" || command.type === "remove_worktree") {
		return ["worktrees.manage.v1"];
	}
	if (command.type === "get_agent_options") return ["model.select.v1"];
	if (command.type === "unregister_workspace") return ["workspace.manage.v1"];
	if (command.type === "upload_device_logs") return ["diagnostics.upload.v1"];
	return undefined;
}

export function getIrohRemoteStreamCapability(options: {
	mode: "conversation" | "workspaceDiscovery" | "workspaceManagement";
	purpose?: string;
}): IrohRemoteRpcCapability | undefined {
	if (options.mode === "conversation") return "conversation.observe.v1";
	if (options.mode === "workspaceDiscovery") {
		return options.purpose === "agent_options" ? "model.select.v1" : "conversation.observe.v1";
	}
	// Worktree management is command-sensitive: the stream itself has no wider
	// gate than each parsed command.
	if (options.purpose === "manage_worktrees") return undefined;
	if (options.purpose === "unregister_workspace") return "workspace.manage.v1";
	return undefined;
}

export function getMissingIrohRemoteRpcCapability(
	grant: IrohRemoteRpcGrant,
	required: readonly IrohRemoteRpcCapability[],
): IrohRemoteRpcCapability | undefined {
	const granted = new Set(grant.capabilities);
	return required.find((capability) => !granted.has(capability));
}

export function hasIrohRemoteRpcCapability(grant: IrohRemoteRpcGrant, capability: IrohRemoteRpcCapability): boolean {
	return grant.capabilities.includes(capability);
}
