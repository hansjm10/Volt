import { Buffer } from "node:buffer";

export const IROH_REMOTE_ALPN = "volt-rpc/0";
export const IROH_REMOTE_TICKET_PREFIX = "volt+iroh://v1/";
export const IROH_REMOTE_HELLO_TYPE = "volt_iroh_hello";
export const IROH_REMOTE_HANDSHAKE_TYPE = "volt_iroh_handshake";
export const IROH_REMOTE_MULTI_STREAMS_FEATURE = "multi_streams.v1";
export const IROH_REMOTE_CONVERSATION_STREAMS_FEATURE = "conversation_streams.v1";
export const IROH_REMOTE_WORKTREES_FEATURE = "worktrees.v1";
export const IROH_REMOTE_WORKING_DIRECTORIES_FEATURE = "working_directories.v1";
export const IROH_REMOTE_AGENT_SETTLED_FEATURE = "agent_settled.v1";
export const IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE = "session_runtime_state.v1";
export const IROH_REMOTE_PLANNING_STATE_FEATURE = "planning_state.v1";
export const IROH_REMOTE_HOST_FEATURES = [
	IROH_REMOTE_MULTI_STREAMS_FEATURE,
	IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
	IROH_REMOTE_WORKTREES_FEATURE,
	IROH_REMOTE_WORKING_DIRECTORIES_FEATURE,
	IROH_REMOTE_AGENT_SETTLED_FEATURE,
	IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE,
	IROH_REMOTE_PLANNING_STATE_FEATURE,
] as const;

/** Daemon-managed worktree ids: lowercase slug, unique per workspace. */
export const IROH_REMOTE_WORKTREE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isIrohRemoteWorktreeId(value: unknown): value is string {
	return typeof value === "string" && IROH_REMOTE_WORKTREE_ID_PATTERN.test(value);
}

export function isIrohRemoteWorkingDirectory(value: unknown): value is string {
	return typeof value === "string" && getIrohRemoteWorkingDirectoryValidationError(value) === undefined;
}

export function getIrohRemoteWorkingDirectoryValidationError(value: string): string | undefined {
	if (value.length === 0) {
		return "workingDirectory must be omitted for the workspace root";
	}
	if (value.length > 4096 || Buffer.byteLength(value, "utf8") > 8192) {
		return "workingDirectory exceeds maximum length";
	}
	if (value.includes("\0") || hasAsciiControlCharacter(value)) {
		return "workingDirectory must not contain control characters";
	}
	if (value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
		return "workingDirectory must be a relative POSIX path";
	}
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git") {
			return "workingDirectory must not contain empty, '.', '..', or '.git' path segments";
		}
	}
	return undefined;
}
export const DEFAULT_IROH_REMOTE_ALLOW_TOOLS =
	"read,bash,edit,write,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp";
export const IROH_REMOTE_UNSAFE_TOOL_NAMES = ["bash", "edit", "write", "web_search", "web_fetch"] as const;
export const IROH_REMOTE_OUTCOMES = [
	"host_unreachable",
	"invalid_workspace",
	"invalid_conversation_target",
	"conversation_streams_unsupported",
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_missing",
	"workspace_forbidden",
	"workspace_authorization_removed",
	"workspace_unregistered",
	"session_unavailable",
	"duplicate_conversation_connection",
	"conversation_in_use",
	"host_identity_mismatch",
	"saved_host_invalid",
] as const;
export const IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES = [
	"invalid_workspace",
	"invalid_conversation_target",
	"conversation_streams_unsupported",
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_missing",
	"workspace_forbidden",
	"workspace_authorization_removed",
	"workspace_unregistered",
	"session_unavailable",
	"duplicate_conversation_connection",
	"conversation_in_use",
] as const;

const IROH_REMOTE_UNSAFE_TOOL_NAME_SET = new Set<string>(IROH_REMOTE_UNSAFE_TOOL_NAMES);
const IROH_REMOTE_OUTCOME_SET = new Set<string>(IROH_REMOTE_OUTCOMES);
const IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOME_SET = new Set<string>(IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES);

export type IrohRemoteRelayMode = "disabled" | "development" | "production";
export type IrohRemoteHostFeature = (typeof IROH_REMOTE_HOST_FEATURES)[number];
export type IrohRemoteOutcome = (typeof IROH_REMOTE_OUTCOMES)[number];
export type IrohRemoteHostHandshakeFailureOutcome = (typeof IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES)[number];

export function isIrohRemoteRelayMode(value: unknown): value is IrohRemoteRelayMode {
	return value === "disabled" || value === "development" || value === "production";
}

export function isIrohRemoteRelayUrls(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((url) => typeof url === "string" && url.length > 0);
}

export function isIrohRemoteOutcome(value: unknown): value is IrohRemoteOutcome {
	return typeof value === "string" && IROH_REMOTE_OUTCOME_SET.has(value);
}

export function isIrohRemoteHostHandshakeFailureOutcome(
	value: unknown,
): value is IrohRemoteHostHandshakeFailureOutcome {
	return typeof value === "string" && IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOME_SET.has(value);
}

export class IrohRemoteOutcomeError extends Error {
	readonly outcome: IrohRemoteOutcome;

	constructor(outcome: IrohRemoteOutcome, message: string) {
		super(`${outcome}: ${message}`);
		this.name = "IrohRemoteOutcomeError";
		this.outcome = outcome;
	}
}

export function normalizeIrohRemoteAllowTools(allowTools: string | undefined): string {
	const tools = parseIrohRemoteAllowToolNames(allowTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
	return tools.join(",");
}

export function parseIrohRemoteAllowTools(allowTools: string | undefined): string[] {
	const normalized = normalizeIrohRemoteAllowTools(allowTools);
	return normalized.length === 0 ? [] : normalized.split(",");
}

export function usesDefaultIrohRemoteAllowTools(allowTools: string | undefined): boolean {
	const tools = new Set(parseIrohRemoteAllowTools(allowTools));
	const defaultTools = new Set(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
	return tools.size === defaultTools.size && Array.from(tools).every((tool) => defaultTools.has(tool));
}

/**
 * Reduce a grant to its persistence representation. A persisted grant never has
 * default-grant semantics: default-equivalent grants (set equality, so order,
 * duplicates, and whitespace do not matter) are represented as `undefined` and
 * resolve against the CURRENT default at use time, so new builtin tools reach
 * default-grant clients without per-record migrations. The empty string is a
 * real grant (deny-all), never collapsed to `undefined`.
 */
export function canonicalizePersistedIrohRemoteAllowTools(allowTools: string | undefined): string | undefined {
	if (allowTools === undefined || usesDefaultIrohRemoteAllowTools(allowTools)) {
		return undefined;
	}
	return uniqueIrohRemoteAllowToolNames(parseIrohRemoteAllowToolNames(allowTools)).join(",");
}

export interface IrohRemoteRuntimeToolPolicy {
	tools: string[];
	allowUnlistedExtensionTools: boolean;
}

export interface ResolveIrohRemoteRuntimeToolPolicyOptions {
	/** Persisted pair-time grant. This is always the maximum authority. */
	clientAllowTools: string;
	/** Optional legacy workspace ceiling. Missing means no additional restriction. */
	workspaceAllowTools?: string;
	/** Exact daemon ceiling. Null means unrestricted; an empty array denies every tool. */
	daemonAllowTools: readonly string[] | null;
}

/**
 * Compose daemon-owned runtime policy without letting a host or workspace
 * policy widen the grant persisted for a paired client.
 *
 * Default grants permit extension tools that are not known until resource
 * loading. That wildcard applies only to non-default tool names, and survives
 * only when every present policy layer has default-grant semantics.
 */
export function resolveIrohRemoteRuntimeToolPolicy(
	options: ResolveIrohRemoteRuntimeToolPolicyOptions,
): IrohRemoteRuntimeToolPolicy {
	const defaultTools = new Set(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
	const layers: Array<{ tools: string[]; toolSet: Set<string>; allowUnlistedExtensionTools: boolean }> = [];
	const addStringLayer = (allowTools: string): void => {
		const tools = uniqueIrohRemoteAllowToolNames(parseIrohRemoteAllowTools(allowTools));
		layers.push({
			tools,
			toolSet: new Set(tools),
			allowUnlistedExtensionTools: usesDefaultIrohRemoteAllowTools(allowTools),
		});
	};

	addStringLayer(options.clientAllowTools);
	if (options.workspaceAllowTools !== undefined) {
		addStringLayer(options.workspaceAllowTools);
	}
	if (options.daemonAllowTools !== null) {
		const tools = uniqueIrohRemoteAllowToolNames(options.daemonAllowTools);
		layers.push({ tools, toolSet: new Set(tools), allowUnlistedExtensionTools: false });
	}

	const candidates = uniqueIrohRemoteAllowToolNames(layers.flatMap((layer) => layer.tools));
	return {
		tools: candidates.filter((tool) =>
			layers.every(
				(layer) => layer.toolSet.has(tool) || (layer.allowUnlistedExtensionTools && !defaultTools.has(tool)),
			),
		),
		allowUnlistedExtensionTools: layers.every((layer) => layer.allowUnlistedExtensionTools),
	};
}

/** Return whether every tool permitted by policy is also permitted by ceiling. */
export function isIrohRemoteRuntimeToolPolicyWithin(
	policy: IrohRemoteRuntimeToolPolicy,
	ceiling: IrohRemoteRuntimeToolPolicy,
): boolean {
	if (policy.allowUnlistedExtensionTools && !ceiling.allowUnlistedExtensionTools) {
		return false;
	}
	const defaultTools = new Set(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
	const ceilingTools = new Set(ceiling.tools);
	return policy.tools.every(
		(tool) => ceilingTools.has(tool) || (ceiling.allowUnlistedExtensionTools && !defaultTools.has(tool)),
	);
}

function hasAsciiControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function parseIrohRemoteAllowToolNames(allowTools: string): string[] {
	return allowTools
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
}

function uniqueIrohRemoteAllowToolNames(toolNames: readonly string[]): string[] {
	const tools: string[] = [];
	const seen = new Set<string>();
	for (const toolName of toolNames) {
		const tool = toolName.trim();
		if (tool.length === 0 || seen.has(tool)) {
			continue;
		}
		seen.add(tool);
		tools.push(tool);
	}
	return tools;
}

export function getIrohRemoteUnsafeAllowedTools(allowTools: string): string[] {
	const unsafeTools: string[] = [];
	const seenUnsafeTools = new Set<string>();
	for (const toolName of allowTools.split(",")) {
		const normalizedToolName = toolName.trim();
		if (!IROH_REMOTE_UNSAFE_TOOL_NAME_SET.has(normalizedToolName) || seenUnsafeTools.has(normalizedToolName)) {
			continue;
		}
		seenUnsafeTools.add(normalizedToolName);
		unsafeTools.push(normalizedToolName);
	}
	return unsafeTools;
}
