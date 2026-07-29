import { type InspectionToolInput, resolveInspectionCommand } from "./tools/inspect.ts";

export const OPERATION_CAPABILITIES = [
	"workspace.read",
	"workspace.write",
	"network.read",
	"network.write",
	"process.inspect",
	"process.execute",
	"integration.discover",
	"integration.read",
	"integration.prompt",
	"integration.write",
	"session.plan",
	"session.execution",
	"delegation.spawn",
] as const;

export type OperationCapability = (typeof OPERATION_CAPABILITIES)[number];

export interface OperationGrantProfile {
	id: string;
	capabilities: ReadonlySet<OperationCapability>;
}

export interface ResolvedOperation {
	kind: "resolved";
	capabilities: readonly OperationCapability[];
}

export interface UnknownOperation {
	kind: "unknown";
	reason: string;
}

export type OperationResolution = ResolvedOperation | UnknownOperation;

export interface ToolOperationResolver {
	advertisedCapabilitySets: readonly (readonly OperationCapability[])[];
	resolve(args: unknown): OperationResolution;
}

export interface IntegrationReadAuthority {
	hasTrustedReads(serverId: string): boolean;
	hasTrustedToolReads(serverId: string): boolean;
	hasTrustedResourceReads(serverId: string): boolean;
	isTrustedToolRead(serverId: string, toolName: string): boolean;
}

export interface OperationAuthorizationDecision {
	allowed: boolean;
	resolution: OperationResolution;
	missingCapabilities: readonly OperationCapability[];
	reason?: string;
}

function resolved(...capabilities: OperationCapability[]): ResolvedOperation {
	return { kind: "resolved", capabilities };
}

function unknown(reason: string): UnknownOperation {
	return { kind: "unknown", reason };
}

function staticResolver(...capabilities: OperationCapability[]): ToolOperationResolver {
	return {
		advertisedCapabilitySets: [capabilities],
		resolve: () => resolved(...capabilities),
	};
}

const STATIC_RESOLVERS = new Map<string, ToolOperationResolver>([
	["read", staticResolver("workspace.read")],
	["grep", staticResolver("workspace.read")],
	["find", staticResolver("workspace.read")],
	["ls", staticResolver("workspace.read")],
	["web_search", staticResolver("network.read")],
	["web_fetch", staticResolver("network.read")],
	["edit", staticResolver("workspace.write")],
	["write", staticResolver("workspace.write")],
	["bash", staticResolver("process.execute")],
	["subagent", staticResolver("delegation.spawn")],
	["update_plan", staticResolver("session.plan")],
	["submit_plan", staticResolver("session.plan")],
	["update_plan_progress", staticResolver("session.execution")],
	["request_replan", staticResolver("session.execution")],
]);

const READ_ONLY_LSP_ACTIONS = new Set([
	"definition",
	"references",
	"implementations",
	"type-definition",
	"callers",
	"callees",
	"hover",
	"symbols",
	"diagnostics",
]);
const WRITE_LSP_ACTIONS = new Set(["rename", "fix"]);

const LSP_RESOLVER: ToolOperationResolver = {
	advertisedCapabilitySets: [["workspace.read"], ["workspace.write"]],
	resolve(args) {
		const action =
			typeof args === "object" && args !== null && "action" in args
				? (args as { action?: unknown }).action
				: undefined;
		if (typeof action !== "string") {
			return unknown("LSP action is missing or invalid");
		}
		if (READ_ONLY_LSP_ACTIONS.has(action)) return resolved("workspace.read");
		if (WRITE_LSP_ACTIONS.has(action)) return resolved("workspace.write");
		return unknown(`LSP action is unknown: ${JSON.stringify(action)}`);
	},
};

const INSPECTION_RESOLVER: ToolOperationResolver = {
	advertisedCapabilitySets: [
		["workspace.read", "process.inspect"],
		["network.read", "process.inspect"],
	],
	resolve(args) {
		try {
			const command = resolveInspectionCommand(args as InspectionToolInput);
			return command.kind === "workspace-read"
				? resolved("workspace.read", "process.inspect")
				: resolved("network.read", "process.inspect");
		} catch (error) {
			return unknown(error instanceof Error ? error.message : String(error));
		}
	},
};

function stringArgument(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null || !(key in args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	return value.trim();
}

function createMcpResolver(authority: IntegrationReadAuthority): ToolOperationResolver {
	return {
		advertisedCapabilitySets: [
			["integration.discover"],
			["integration.read"],
			["integration.prompt"],
			["integration.write"],
		],
		resolve(args) {
			const action = stringArgument(args, "action");
			if (!action) return unknown("MCP action is missing or invalid");
			if (action === "status" || action === "list_servers" || action === "search") {
				return resolved("integration.discover");
			}
			if (action === "read_cache") {
				// Cached output was already observed when the originating call ran, so
				// replaying it is recall, not fresh research evidence, and it needs no
				// per-server trust.
				return resolved("integration.discover");
			}
			if (
				action === "disconnect" ||
				action === "set_enabled" ||
				action === "auth" ||
				action === "poll_auth" ||
				action === "cancel_auth" ||
				action === "logout"
			) {
				return resolved("integration.write");
			}
			if (action === "list_prompts" || action === "get_prompt") {
				return resolved("integration.prompt");
			}
			const server = stringArgument(args, "server");
			if (!server) return unknown(`MCP ${action} requires a server`);
			if (action === "list_resources" || action === "read_resource") {
				return authority.hasTrustedResourceReads(server)
					? resolved("integration.read")
					: unknown(`MCP resource reads are not trusted for server ${server}`);
			}
			if (action === "call") {
				const tool = stringArgument(args, "tool");
				if (!tool) return unknown("MCP call requires a tool");
				return authority.isTrustedToolRead(server, tool)
					? resolved("integration.read")
					: unknown(`MCP tool is not an explicitly trusted read: ${server}.${tool}`);
			}
			if (action === "connect") {
				return authority.hasTrustedReads(server)
					? resolved("integration.read")
					: unknown(`MCP server has no configured trusted reads: ${server}`);
			}
			if (action === "describe" || action === "list_tools") {
				return authority.hasTrustedToolReads(server)
					? resolved("integration.read")
					: unknown(`MCP server has no configured trusted tool reads: ${server}`);
			}
			return unknown(`MCP action is unknown: ${JSON.stringify(action)}`);
		},
	};
}

export const RESEARCH_OPERATION_GRANT_PROFILE: OperationGrantProfile = Object.freeze({
	id: "research",
	capabilities: new Set<OperationCapability>([
		"workspace.read",
		"network.read",
		"process.inspect",
		"integration.discover",
		"integration.read",
		"session.plan",
	]),
});

export function getTrustedToolOperationResolver(
	toolName: string,
	options: { integrationReadAuthority?: IntegrationReadAuthority } = {},
): ToolOperationResolver | undefined {
	if (toolName === "lsp") return LSP_RESOLVER;
	if (toolName === "inspect") return INSPECTION_RESOLVER;
	if (toolName === "mcp" && options.integrationReadAuthority) {
		return createMcpResolver(options.integrationReadAuthority);
	}
	return STATIC_RESOLVERS.get(toolName);
}

export function isToolVisibleUnderGrant(
	resolver: ToolOperationResolver | undefined,
	profile: OperationGrantProfile,
): boolean {
	if (!resolver) return false;
	return resolver.advertisedCapabilitySets.some((capabilities) =>
		capabilities.every((capability) => profile.capabilities.has(capability)),
	);
}

export function authorizeToolOperation(
	resolver: ToolOperationResolver | undefined,
	args: unknown,
	profile: OperationGrantProfile,
): OperationAuthorizationDecision {
	if (!resolver) {
		const resolution = unknown("Operation has no trusted host resolver");
		return {
			allowed: false,
			resolution,
			missingCapabilities: [],
			reason: resolution.reason,
		};
	}
	const resolution = resolver.resolve(args);
	if (resolution.kind === "unknown") {
		return {
			allowed: false,
			resolution,
			missingCapabilities: [],
			reason: resolution.reason,
		};
	}
	const missingCapabilities = resolution.capabilities.filter((capability) => !profile.capabilities.has(capability));
	return {
		allowed: missingCapabilities.length === 0,
		resolution,
		missingCapabilities,
		...(missingCapabilities.length > 0
			? { reason: `Missing operation capabilities: ${missingCapabilities.join(", ")}` }
			: {}),
	};
}

const RESEARCH_EVIDENCE_CAPABILITIES = new Set<OperationCapability>([
	"workspace.read",
	"network.read",
	"integration.read",
]);

export function operationProvidesResearchEvidence(resolution: OperationResolution): boolean {
	return (
		resolution.kind === "resolved" &&
		resolution.capabilities.some((capability) => RESEARCH_EVIDENCE_CAPABILITIES.has(capability))
	);
}

/** Whether a tool can execute at least one operation under the profile that would count as research evidence. */
export function resolverCanProvideResearchEvidence(
	resolver: ToolOperationResolver | undefined,
	profile: OperationGrantProfile,
): boolean {
	if (!resolver) return false;
	return resolver.advertisedCapabilitySets.some(
		(capabilities) =>
			capabilities.every((capability) => profile.capabilities.has(capability)) &&
			capabilities.some((capability) => RESEARCH_EVIDENCE_CAPABILITIES.has(capability)),
	);
}
