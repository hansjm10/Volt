import { randomUUID } from "node:crypto";
import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAuditLogger } from "./audit.ts";
import {
	getMcpDirectToolName,
	getServerTimeoutMs,
	hashMcpServerConfig,
	serverHasTrustedReads,
	serverHasTrustedToolReads,
	serverMatchesToolFilters,
	serverTrustsResourceReads,
	serverTrustsToolRead,
} from "./config.ts";
import type { McpConfigWriter } from "./config-writer.ts";
import type { McpMetadataCache } from "./metadata-cache.ts";
import {
	completeMcpOAuthBrowserAuth,
	type McpOAuthPendingDeviceFlow,
	pollMcpOAuthDeviceAuth,
	startMcpOAuthBrowserAuth,
	startMcpOAuthDeviceAuth,
} from "./oauth-flow.ts";
import type { McpOAuthStore } from "./oauth-store.ts";
import type { McpOutputStore } from "./output-store.ts";
import { classifyMcpToolRisk, isMcpToolTrustedReadCandidate } from "./safety.ts";
import { searchMcpMetadata } from "./search.ts";
import { type McpMetadataRefreshOptions, McpServerSupervisor } from "./server-supervisor.ts";
import type {
	McpCallerSurface,
	McpClientFactory,
	McpDirectToolCandidate,
	McpGatewayCallResult,
	McpGatewayExecutionContext,
	McpGatewayInput,
	McpManagerEvent,
	McpManagerEventListener,
	McpMetadataCategory,
	McpPromptSummary,
	McpRecentCallStatus,
	McpResolvedConfig,
	McpResolvedServerConfig,
	McpResourceSummary,
	McpRisk,
	McpSearchMatch,
	McpServerMetadata,
	McpServerSummary,
	McpToolSummary,
} from "./types.ts";

export interface McpManagerOptions {
	config: McpResolvedConfig;
	clientFactory: McpClientFactory;
	metadataCache: McpMetadataCache;
	outputStore: McpOutputStore;
	auditLogger?: McpAuditLogger;
	configWriter?: McpConfigWriter;
	oauthStore?: McpOAuthStore;
	sessionId?: string;
	workspaceId?: string;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf-8");
}

function compactText(value: string | undefined, maxLength = 220): string {
	const normalized = (value ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function parseArguments(input: McpGatewayInput): Record<string, unknown> {
	if (input.arguments !== undefined) {
		return input.arguments;
	}
	if (input.argumentsJson !== undefined) {
		const parsed = JSON.parse(input.argumentsJson) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("MCP argumentsJson must parse to an object");
		}
		return parsed as Record<string, unknown>;
	}
	return {};
}

function requireString(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`MCP ${label} is required`);
	}
	return trimmed;
}

function makeCallId(): string {
	return `mcpcall_${randomUUID().replace(/-/g, "")}`;
}

function getCallerSurface(ctx: McpGatewayExecutionContext): McpCallerSurface {
	if (ctx.mode === "tui") return "tui";
	if (ctx.mode === "rpc") return "rpc";
	if (ctx.mode === "print") return "print";
	if (ctx.mode === "json") return "json";
	return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetadataStale(
	metadata: McpServerMetadata | undefined,
	maxAgeMs: number,
	categories: readonly McpMetadataCategory[],
): boolean {
	if (!metadata) {
		return true;
	}
	const now = Date.now();
	return categories.some((category) => {
		const value =
			category === "tools"
				? metadata.toolsLastSeenAt
				: category === "resources"
					? metadata.resourcesLastSeenAt
					: metadata.promptsLastSeenAt;
		const seenAt = Date.parse(value);
		return !Number.isFinite(seenAt) || now - seenAt > maxAgeMs;
	});
}

const ALL_METADATA_CATEGORIES: readonly McpMetadataCategory[] = Object.freeze(["tools", "resources", "prompts"]);
const TOOL_METADATA_CATEGORIES: readonly McpMetadataCategory[] = Object.freeze(["tools"]);
const RESTRICTED_TOOL_METADATA_REFRESH: McpMetadataRefreshOptions = Object.freeze({
	tools: true,
	resources: false,
	prompts: false,
	strict: true,
});

function getRestrictedMetadataRefresh(server: McpResolvedServerConfig): McpMetadataRefreshOptions {
	return {
		tools: serverHasTrustedToolReads(server),
		resources: serverTrustsResourceReads(server),
		prompts: false,
		strict: true,
	};
}

function isDirectToolEnabled(
	serverDirectTools: boolean | string[],
	settingsDirectTools: boolean,
	toolName: string,
): boolean {
	if (Array.isArray(serverDirectTools)) {
		return serverDirectTools.includes(toolName);
	}
	return serverDirectTools || settingsDirectTools;
}

function toToolSummary(
	serverId: string,
	metadata: McpServerMetadata,
	server: McpResolvedServerConfig,
	settingsDirectTools: boolean,
	stale: boolean,
): McpToolSummary[] {
	return metadata.tools.map((tool) => ({
		server: serverId,
		name: tool.name,
		...(tool.title ? { title: tool.title } : {}),
		...(tool.description ? { description: compactText(tool.description, 800) } : {}),
		risk: classifyMcpToolRisk(tool),
		trustedRead: serverTrustsToolRead(server, tool.name) && isMcpToolTrustedReadCandidate(tool),
		inputSchema: tool.inputSchema,
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		...(tool.annotations ? { annotations: tool.annotations } : {}),
		metadataHash: metadata.metadataHash,
		lastSeenAt: metadata.toolsLastSeenAt,
		stale,
		direct: isDirectToolEnabled(server.directTools, settingsDirectTools, tool.name),
	}));
}

function contentPartToText(part: unknown): string | undefined {
	if (!isRecord(part) || typeof part.type !== "string") {
		return undefined;
	}
	if (part.type === "text" && typeof part.text === "string") {
		return part.text;
	}
	if (part.type === "image") {
		const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/unknown";
		const data = typeof part.data === "string" ? part.data : "";
		return `[MCP image: ${mimeType}, ${data.length} base64 chars]`;
	}
	if (part.type === "audio") {
		const mimeType = typeof part.mimeType === "string" ? part.mimeType : "audio/unknown";
		const data = typeof part.data === "string" ? part.data : "";
		return `[MCP audio: ${mimeType}, ${data.length} base64 chars]`;
	}
	if (part.type === "resource" && isRecord(part.resource)) {
		const resource = part.resource;
		const uri = typeof resource.uri === "string" ? resource.uri : "resource";
		if (typeof resource.text === "string") {
			return `[MCP resource ${uri}]\n${resource.text}`;
		}
		if (typeof resource.blob === "string") {
			return `[MCP binary resource ${uri}: ${resource.blob.length} base64 chars]`;
		}
	}
	if (part.type === "resource_link") {
		const uri = typeof part.uri === "string" ? part.uri : "";
		const name = typeof part.name === "string" ? part.name : "resource";
		return `[MCP resource link: ${name}${uri ? ` ${uri}` : ""}]`;
	}
	return `[Unsupported MCP content: ${part.type}]`;
}

function callToolResultToText(result: CallToolResult): string {
	const parts = result.content.map(contentPartToText).filter((part): part is string => part !== undefined);
	if (result.structuredContent !== undefined) {
		parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	}
	return parts.join("\n\n").trim() || "(no MCP tool output)";
}

function readResourceResultToText(result: ReadResourceResult): string {
	return result.contents
		.map((content) => {
			if ("text" in content) {
				return `[${content.uri}]\n${content.text}`;
			}
			return `[${content.uri}] binary ${content.blob.length} base64 chars`;
		})
		.join("\n\n");
}

function getPromptResultToText(result: GetPromptResult): string {
	const lines: string[] = [];
	if (result.description) {
		lines.push(result.description);
	}
	for (const message of result.messages) {
		lines.push(`## ${message.role}`);
		const content = message.content;
		const text = contentPartToText(content);
		lines.push(text ?? JSON.stringify(content));
	}
	return lines.join("\n\n").trim();
}

export class McpManager {
	private config: McpResolvedConfig;
	private supervisors: Map<string, McpServerSupervisor>;
	private metadataCache: McpMetadataCache;
	private outputStore: McpOutputStore;
	private auditLogger: McpAuditLogger | undefined;
	private configWriter: McpConfigWriter | undefined;
	private oauthStore: McpOAuthStore | undefined;
	private pendingDeviceAuth: Map<string, McpOAuthPendingDeviceFlow> = new Map();
	private sessionId: string | undefined;
	private workspaceId: string | undefined;
	private eventListeners: Set<McpManagerEventListener> = new Set();

	constructor(options: McpManagerOptions) {
		this.config = options.config;
		this.metadataCache = options.metadataCache;
		this.outputStore = options.outputStore;
		this.auditLogger = options.auditLogger;
		this.configWriter = options.configWriter;
		this.oauthStore = options.oauthStore;
		this.sessionId = options.sessionId;
		this.workspaceId = options.workspaceId;
		this.supervisors = new Map(
			Object.values(this.config.servers).map((server) => [
				server.id,
				new McpServerSupervisor({
					server,
					settings: this.config.settings,
					clientFactory: options.clientFactory,
					metadataCache: this.metadataCache,
					oauthStore: this.oauthStore,
					onStateChanged: (supervisor) =>
						this.emit({ type: "mcp_server_status_changed", server: supervisor.getSummary() }),
				}),
			]),
		);
	}

	/** Subscribe to MCP lifecycle events. Returns an unsubscribe function. */
	subscribe(listener: McpManagerEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	private emit(event: McpManagerEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Listener failures must never break MCP operations.
			}
		}
	}

	private emitAuthUpdate(serverId: string, status: string, message?: string): void {
		const supervisor = this.supervisors.get(serverId);
		this.emit({
			type: "mcp_auth_update",
			serverId,
			status,
			authState: supervisor?.authState ?? "none",
			...(message ? { message } : {}),
			...(supervisor ? { server: supervisor.getSummary() } : {}),
		});
	}

	isEnabled(): boolean {
		return this.config.settings.enabled && Object.keys(this.config.servers).length > 0;
	}

	getDiagnostics() {
		return [...this.config.diagnostics];
	}

	listServers(): McpServerSummary[] {
		return Array.from(this.supervisors.values(), (supervisor) => supervisor.getSummary());
	}

	getServer(id: string): McpServerSummary {
		return this.getSupervisor(id).getSummary();
	}

	getDirectToolCandidates(): McpDirectToolCandidate[] {
		const candidates: McpDirectToolCandidate[] = [];
		for (const supervisor of this.supervisors.values()) {
			if (!supervisor.server.enabled) {
				continue;
			}
			const metadata = supervisor.cachedMetadata;
			if (!metadata || this.isSupervisorMetadataStale(supervisor, metadata, TOOL_METADATA_CATEGORIES)) {
				continue;
			}
			const toolsLastSeenAt = metadata.toolsLastSeenAt;
			for (const tool of metadata.tools) {
				if (
					!serverMatchesToolFilters(supervisor.server, tool.name) ||
					!isDirectToolEnabled(supervisor.server.directTools, this.config.settings.directTools, tool.name)
				) {
					continue;
				}
				candidates.push({
					server: supervisor.server.id,
					tool,
					risk: classifyMcpToolRisk(tool),
					metadataHash: metadata.metadataHash,
					lastSeenAt: toolsLastSeenAt,
					directToolName: getMcpDirectToolName(supervisor.server.id, tool.name),
				});
			}
		}
		return candidates;
	}

	async startEagerServers(signal?: AbortSignal, options: { trustedReadsOnly?: boolean } = {}): Promise<void> {
		const eager = Array.from(this.supervisors.values()).filter(
			(supervisor) =>
				supervisor.server.enabled &&
				(!options.trustedReadsOnly || serverHasTrustedReads(supervisor.server)) &&
				(supervisor.server.lifecycle === "eager" || supervisor.server.lifecycle === "keep-alive"),
		);
		await Promise.allSettled(
			eager.map((supervisor) =>
				supervisor.refreshMetadata(
					signal,
					options.trustedReadsOnly ? getRestrictedMetadataRefresh(supervisor.server) : undefined,
				),
			),
		);
	}

	hasTrustedReads(serverId: string): boolean {
		const server = this.findServerConfig(serverId);
		return server?.enabled === true && serverHasTrustedReads(server);
	}

	hasTrustedToolReads(serverId: string): boolean {
		const server = this.findServerConfig(serverId);
		return server?.enabled === true && serverHasTrustedToolReads(server);
	}

	hasTrustedResourceReads(serverId: string): boolean {
		const server = this.findServerConfig(serverId);
		return server?.enabled === true && serverTrustsResourceReads(server);
	}

	isTrustedToolRead(serverId: string, toolName: string): boolean {
		const server = this.findServerConfig(serverId);
		const supervisor = this.findSupervisor(serverId);
		if (!server || !server.enabled || !supervisor || !serverTrustsToolRead(server, toolName)) {
			return false;
		}
		const metadata = supervisor.cachedMetadata;
		if (!metadata || this.isSupervisorMetadataStale(supervisor, metadata, TOOL_METADATA_CATEGORIES)) {
			return false;
		}
		const tool = metadata.tools.find((entry) => entry.name === toolName);
		return tool !== undefined && serverMatchesToolFilters(server, tool.name) && isMcpToolTrustedReadCandidate(tool);
	}

	async dispose(): Promise<void> {
		await Promise.allSettled(Array.from(this.supervisors.values(), (supervisor) => supervisor.disconnect()));
	}

	async handleGatewayInput(
		input: McpGatewayInput,
		context: McpGatewayExecutionContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		switch (input.action) {
			case "status":
				return {
					action: "status",
					enabled: this.isEnabled(),
					diagnostics: this.getDiagnostics(),
					servers: this.listServers(),
				};
			case "list_servers":
				return { action: "list_servers", servers: this.listServers() };
			case "search":
				return this.search(input.query ?? "", input.limit);
			case "describe":
				return this.describe(requireString(input.server, "server"), requireString(input.tool, "tool"), signal, {
					restrictedTrustedRead: context.restrictedTrustedRead,
				});
			case "connect":
				return this.connectServer(requireString(input.server, "server"), signal, {
					restrictedTrustedRead: context.restrictedTrustedRead,
				});
			case "disconnect":
				return this.disconnectServer(requireString(input.server, "server"));
			case "set_enabled":
				if (typeof input.enabled !== "boolean") {
					throw new Error("MCP enabled boolean is required");
				}
				return this.setServerEnabled(requireString(input.server, "server"), input.enabled);
			case "auth":
				if (input.code) {
					return this.completeServerBrowserAuth(requireString(input.server, "server"), {
						redirectUrl: requireString(input.redirectUrl, "redirectUrl"),
						code: input.code,
						state: input.state,
					});
				}
				return this.startServerAuth(requireString(input.server, "server"), {
					flow: input.flow,
					redirectUrl: input.redirectUrl,
				});
			case "poll_auth":
				return this.pollServerAuth(requireString(input.server, "server"));
			case "cancel_auth":
				return this.cancelServerAuth(requireString(input.server, "server"));
			case "logout":
				return this.logoutServer(requireString(input.server, "server"));
			case "list_tools":
				return this.listTools(requireString(input.server, "server"), signal, {
					restrictedTrustedRead: context.restrictedTrustedRead,
				});
			case "call":
				return this.callTool(input, context, signal);
			case "list_resources":
				return this.listResources(requireString(input.server, "server"), input.cursor, signal);
			case "read_resource":
				return this.readResource(
					requireString(input.server, "server"),
					requireString(input.resourceUri, "resourceUri"),
					context,
					signal,
				);
			case "list_prompts":
				return this.listPrompts(requireString(input.server, "server"), input.cursor, signal);
			case "get_prompt":
				return this.getPrompt(
					requireString(input.server, "server"),
					requireString(input.prompt, "prompt"),
					input,
					context,
					signal,
				);
			case "read_cache":
				return this.readCache(requireString(input.cacheId, "cacheId"), input, context);
		}
	}

	async connectServer(
		serverId: string,
		signal?: AbortSignal,
		options: { restrictedTrustedRead?: boolean } = {},
	): Promise<{ action: "connect"; server: McpServerSummary }> {
		const supervisor = this.getSupervisor(serverId);
		if (options.restrictedTrustedRead && !serverHasTrustedReads(supervisor.server)) {
			throw new Error(`MCP server has no configured trusted reads: ${serverId}`);
		}
		await supervisor.refreshMetadata(
			signal,
			options.restrictedTrustedRead ? getRestrictedMetadataRefresh(supervisor.server) : undefined,
		);
		return { action: "connect", server: supervisor.getSummary() };
	}

	async disconnectServer(serverId: string): Promise<{ action: "disconnect"; server: McpServerSummary }> {
		const supervisor = this.getSupervisor(serverId);
		await supervisor.disconnect();
		return { action: "disconnect", server: supervisor.getSummary() };
	}

	async setServerEnabled(
		serverId: string,
		enabled: boolean,
	): Promise<{ action: "set_enabled"; server: McpServerSummary; persisted?: { path: string; scope: string } }> {
		const supervisor = this.getSupervisor(serverId);
		if (!this.configWriter) {
			throw new Error("MCP config persistence is not available");
		}
		const persisted = this.configWriter.setServerEnabled(supervisor.server, enabled);
		await supervisor.setEnabled(enabled);
		this.emit({ type: "mcp_servers_changed", servers: this.listServers() });
		return { action: "set_enabled", server: supervisor.getSummary(), persisted };
	}

	async startServerAuth(
		serverId: string,
		options: { flow?: "browser" | "device"; redirectUrl?: string } = {},
	): Promise<unknown> {
		const supervisor = this.requireOAuthSupervisor(serverId);
		if (!this.oauthStore) {
			throw new Error("MCP OAuth storage is not available");
		}
		const flow = options.flow ?? supervisor.server.auth?.flow ?? "browser";
		if (flow === "auto") {
			return this.startServerAuth(serverId, { ...options, flow: "browser" });
		}
		if (flow === "device") {
			const { result, pending } = await startMcpOAuthDeviceAuth({
				server: supervisor.server,
				store: this.oauthStore,
			});
			this.pendingDeviceAuth.set(serverId, pending);
			supervisor.refreshAuthState();
			this.emit({
				type: "mcp_auth_request",
				serverId: supervisor.server.id,
				auth: {
					flow: "device",
					verificationUri: result.verificationUri,
					...(result.verificationUriComplete ? { verificationUriComplete: result.verificationUriComplete } : {}),
					userCode: result.userCode,
					expiresAt: result.expiresAt,
					intervalMs: result.intervalMs,
					message: result.message,
				},
			});
			return result;
		}
		const redirectUrl = options.redirectUrl?.trim();
		if (!redirectUrl) {
			throw new Error("MCP OAuth browser flow requires a redirectUrl");
		}
		const result = await startMcpOAuthBrowserAuth({
			server: supervisor.server,
			store: this.oauthStore,
			redirectUrl,
		});
		supervisor.refreshAuthState();
		if (result.status === "pending") {
			this.emit({
				type: "mcp_auth_request",
				serverId: supervisor.server.id,
				auth: {
					flow: "browser",
					...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
					redirectUrl: result.redirectUrl,
					message: result.message,
				},
			});
		} else {
			this.emitAuthUpdate(supervisor.server.id, result.status, result.message);
		}
		return result;
	}

	async completeServerBrowserAuth(
		serverId: string,
		options: { redirectUrl: string; code: string; state?: string },
	): Promise<unknown> {
		const supervisor = this.requireOAuthSupervisor(serverId);
		if (!this.oauthStore) {
			throw new Error("MCP OAuth storage is not available");
		}
		const result = await completeMcpOAuthBrowserAuth({
			server: supervisor.server,
			store: this.oauthStore,
			redirectUrl: options.redirectUrl,
			code: options.code,
			state: options.state,
		});
		supervisor.refreshAuthState();
		this.emitAuthUpdate(supervisor.server.id, result.status, result.message);
		return result;
	}

	async pollServerAuth(serverId: string): Promise<unknown> {
		const supervisor = this.requireOAuthSupervisor(serverId);
		if (!this.oauthStore) {
			throw new Error("MCP OAuth storage is not available");
		}
		const pending = this.pendingDeviceAuth.get(serverId);
		if (!pending) {
			throw new Error(`No pending MCP OAuth device flow for ${serverId}`);
		}
		const { result, pending: nextPending } = await pollMcpOAuthDeviceAuth({
			server: supervisor.server,
			store: this.oauthStore,
			pending,
		});
		if (nextPending) {
			this.pendingDeviceAuth.set(serverId, nextPending);
		} else {
			this.pendingDeviceAuth.delete(serverId);
		}
		supervisor.refreshAuthState();
		if (result.status !== "pending") {
			this.emitAuthUpdate(supervisor.server.id, result.status, result.message);
		}
		return result;
	}

	cancelServerAuth(serverId: string): { action: "auth"; server: string; status: "cancelled"; message: string } {
		this.pendingDeviceAuth.delete(serverId);
		this.emitAuthUpdate(serverId, "cancelled", "MCP OAuth flow cancelled.");
		return { action: "auth", server: serverId, status: "cancelled", message: "MCP OAuth flow cancelled." };
	}

	async logoutServer(serverId: string): Promise<{
		action: "auth";
		server: string;
		status: "logged_out";
		serverSummary: McpServerSummary;
	}> {
		const supervisor = this.requireOAuthSupervisor(serverId);
		if (!this.oauthStore) {
			throw new Error("MCP OAuth storage is not available");
		}
		await supervisor.disconnect();
		this.oauthStore.clear(supervisor.server, "all");
		this.pendingDeviceAuth.delete(serverId);
		supervisor.refreshAuthState();
		this.emitAuthUpdate(supervisor.server.id, "logged_out");
		return {
			action: "auth",
			server: serverId,
			status: "logged_out",
			serverSummary: supervisor.getSummary(),
		};
	}

	async listTools(
		serverId: string,
		signal?: AbortSignal,
		options: { restrictedTrustedRead?: boolean } = {},
	): Promise<{
		action: "list_tools";
		server: string;
		tools: McpToolSummary[];
		metadataHash?: string;
		stale: boolean;
	}> {
		const supervisor = this.getSupervisor(serverId);
		if (options.restrictedTrustedRead && !serverHasTrustedToolReads(supervisor.server)) {
			throw new Error(`MCP server has no configured trusted tool reads: ${serverId}`);
		}
		const metadata = options.restrictedTrustedRead
			? await supervisor.refreshMetadata(signal, RESTRICTED_TOOL_METADATA_REFRESH)
			: await this.getFreshToolMetadata(supervisor, signal).catch(() => supervisor.cachedMetadata);
		if (!metadata) {
			return { action: "list_tools", server: supervisor.server.id, tools: [], stale: true };
		}
		const stale = this.isSupervisorMetadataStale(supervisor, metadata, TOOL_METADATA_CATEGORIES);
		return {
			action: "list_tools",
			server: supervisor.server.id,
			tools: toToolSummary(
				supervisor.server.id,
				metadata,
				supervisor.server,
				this.config.settings.directTools,
				stale,
			),
			metadataHash: metadata.metadataHash,
			stale,
		};
	}

	search(
		query: string,
		limit?: number,
	): { action: "search"; query: string; matches: McpSearchMatch[]; notices?: string[] } {
		const freshMetadata: McpServerMetadata[] = [];
		const missingOrStale: string[] = [];
		for (const supervisor of this.supervisors.values()) {
			const metadata = supervisor.cachedMetadata;
			if (!metadata || this.isSupervisorMetadataStale(supervisor, metadata, TOOL_METADATA_CATEGORIES)) {
				missingOrStale.push(supervisor.server.id);
				continue;
			}
			freshMetadata.push(metadata);
		}
		const matches = searchMcpMetadata({
			query,
			limit,
			servers: this.config.servers,
			metadata: freshMetadata,
		});
		return {
			action: "search",
			query,
			matches,
			...(missingOrStale.length > 0
				? {
						notices: [
							`Metadata missing or stale for ${missingOrStale.join(", ")}; use action=connect to refresh.`,
						],
					}
				: {}),
		};
	}

	async describe(
		serverId: string,
		toolName: string,
		signal?: AbortSignal,
		options: { restrictedTrustedRead?: boolean } = {},
	): Promise<unknown> {
		const supervisor = this.getSupervisor(serverId);
		if (options.restrictedTrustedRead && !serverHasTrustedToolReads(supervisor.server)) {
			throw new Error(`MCP server has no configured trusted tool reads: ${serverId}`);
		}
		const metadata = options.restrictedTrustedRead
			? await supervisor.refreshMetadata(signal, RESTRICTED_TOOL_METADATA_REFRESH)
			: await this.getFreshToolMetadata(supervisor, signal).catch(() => supervisor.cachedMetadata);
		if (!metadata) {
			return {
				action: "describe",
				server: serverId,
				tool: toolName,
				status: "metadata_missing",
				message: `No cached metadata for ${serverId}. Use mcp({"action":"connect","server":"${serverId}"}) first.`,
			};
		}
		const tool = metadata.tools.find((entry) => entry.name === toolName);
		if (!tool) {
			throw new Error(`MCP tool not found in cached metadata: ${serverId}.${toolName}`);
		}
		return {
			server: serverId,
			tool: tool.name,
			description: tool.description ?? "",
			risk: classifyMcpToolRisk(tool),
			trustedRead: serverTrustsToolRead(supervisor.server, tool.name) && isMcpToolTrustedReadCandidate(tool),
			inputSchema: tool.inputSchema,
			annotations: tool.annotations ?? {},
			metadataHash: metadata.metadataHash,
		};
	}

	async listResources(
		serverId: string,
		cursor: string | undefined,
		signal?: AbortSignal,
	): Promise<{ action: "list_resources"; server: string; resources: McpResourceSummary[]; nextCursor?: string }> {
		if (this.config.settings.resources === "disabled") {
			throw new Error("MCP resources are disabled by config");
		}
		const result = await this.getSupervisor(serverId).listResources(cursor, signal);
		return {
			action: "list_resources",
			server: serverId,
			resources: result.resources.map((resource) => ({
				server: serverId,
				uri: resource.uri,
				name: resource.name,
				description: compactText(resource.description),
				mimeType: resource.mimeType,
				size: resource.size,
			})),
			nextCursor: result.nextCursor,
		};
	}

	async readResource(
		serverId: string,
		uri: string,
		context: McpGatewayExecutionContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.config.settings.resources === "disabled") {
			throw new Error("MCP resources are disabled by config");
		}
		const startedAt = Date.now();
		try {
			const result = await this.getSupervisor(serverId).readResource(uri, signal);
			const text = readResourceResultToText(result);
			const shaped = this.outputStore.shapeOutput(text);
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: uri,
				kind: "resource",
				risk: "read",
				status: "completed",
				durationMs: Date.now() - startedAt,
				resultSize: byteLength(text),
				cacheId: shaped.cache?.id,
			});
			return { action: "read_resource", server: serverId, resourceUri: uri, ...shaped };
		} catch (error) {
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: uri,
				kind: "resource",
				risk: "read",
				status: signal?.aborted ? "cancelled" : "failed",
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async listPrompts(
		serverId: string,
		cursor: string | undefined,
		signal?: AbortSignal,
	): Promise<{ action: "list_prompts"; server: string; prompts: McpPromptSummary[]; nextCursor?: string }> {
		if (this.config.settings.prompts === "disabled") {
			throw new Error("MCP prompts are disabled by config");
		}
		const result = await this.getSupervisor(serverId).listPrompts(cursor, signal);
		return {
			action: "list_prompts",
			server: serverId,
			prompts: result.prompts.map((prompt) => ({
				server: serverId,
				name: prompt.name,
				title: prompt.title,
				description: compactText(prompt.description),
				arguments: prompt.arguments,
			})),
			nextCursor: result.nextCursor,
		};
	}

	async getPrompt(
		serverId: string,
		name: string,
		input: McpGatewayInput,
		context: McpGatewayExecutionContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.config.settings.prompts === "disabled") {
			throw new Error("MCP prompts are disabled by config");
		}
		if (context.caller !== "user" && this.config.settings.prompts !== "model") {
			throw new Error('MCP prompt content is not exposed to the model unless settings.prompts is "model"');
		}
		const args = parseArguments(input);
		const startedAt = Date.now();
		try {
			const result = await this.getSupervisor(serverId).getPrompt(name, args, signal);
			const text = getPromptResultToText(result);
			const shaped = this.outputStore.shapeOutput(text);
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: name,
				kind: "prompt",
				risk: "read",
				status: "completed",
				durationMs: Date.now() - startedAt,
				resultSize: byteLength(text),
				cacheId: shaped.cache?.id,
				arguments: args,
			});
			return { action: "get_prompt", server: serverId, prompt: name, ...shaped };
		} catch (error) {
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: name,
				kind: "prompt",
				risk: "read",
				status: signal?.aborted ? "cancelled" : "failed",
				durationMs: Date.now() - startedAt,
				arguments: args,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async readCache(
		cacheId: string,
		input: Pick<McpGatewayInput, "cursor" | "limit">,
		context: McpGatewayExecutionContext,
	): Promise<unknown> {
		const startedAt = Date.now();
		try {
			const chunk = this.outputStore.read(cacheId, input);
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: "cache",
				item: cacheId,
				kind: "cache",
				risk: "read",
				status: "completed",
				durationMs: Date.now() - startedAt,
				resultSize: byteLength(chunk.content),
				cacheId,
			});
			return { action: "read_cache", ...chunk };
		} catch (error) {
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: "cache",
				item: cacheId,
				kind: "cache",
				risk: "read",
				status: "failed",
				durationMs: Date.now() - startedAt,
				cacheId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async callTool(
		input: McpGatewayInput,
		context: McpGatewayExecutionContext,
		signal?: AbortSignal,
	): Promise<McpGatewayCallResult> {
		const serverId = requireString(input.server, "server");
		const toolName = requireString(input.tool, "tool");
		const args = parseArguments(input);
		const supervisor = this.getSupervisor(serverId);
		const metadata = context.restrictedTrustedRead
			? await supervisor.refreshMetadata(signal, RESTRICTED_TOOL_METADATA_REFRESH)
			: await this.getFreshToolMetadata(supervisor, signal);
		const tool = metadata.tools.find((entry) => entry.name === toolName);
		if (!tool || !serverMatchesToolFilters(supervisor.server, tool.name)) {
			throw new Error(`MCP tool not available: ${serverId}.${toolName}`);
		}
		const risk = classifyMcpToolRisk(tool);
		if (
			context.restrictedTrustedRead &&
			(!supervisor.server.enabled ||
				!serverTrustsToolRead(supervisor.server, tool.name) ||
				tool.annotations?.readOnlyHint !== true ||
				risk !== "read")
		) {
			throw new Error(`MCP tool is not an effectively trusted read: ${serverId}.${toolName}`);
		}
		const callId = makeCallId();
		const startedAt = Date.now();
		let status: McpRecentCallStatus = "completed";
		this.emit({
			type: "mcp_call_start",
			call: {
				id: callId,
				timestamp: new Date(startedAt).toISOString(),
				server: serverId,
				tool: toolName,
				risk,
				status: "started",
			},
		});
		try {
			const result = await supervisor.callTool(toolName, args, signal, (progress) =>
				this.emit({
					type: "mcp_call_update",
					call: { id: callId, server: serverId, tool: toolName },
					progress,
				}),
			);
			const text = callToolResultToText(result);
			const shaped = this.outputStore.shapeOutput(text);
			status = result.isError ? "failed" : "completed";
			const outputBytes = byteLength(text);
			const recent = {
				id: callId,
				timestamp: new Date(startedAt).toISOString(),
				server: serverId,
				tool: toolName,
				risk,
				status,
				durationMs: Date.now() - startedAt,
				outputBytes,
				truncated: shaped.truncation?.truncated ?? false,
			};
			supervisor.recordCall(recent);
			this.emit({
				type: "mcp_call_end",
				call: recent,
				...(shaped.cache ? { cacheId: shaped.cache.id } : {}),
			});
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: toolName,
				kind: "tool",
				risk,
				status,
				durationMs: recent.durationMs,
				resultSize: outputBytes,
				cacheId: shaped.cache?.id,
				arguments: args,
			});
			return {
				action: "call",
				server: serverId,
				tool: toolName,
				status: result.isError ? "failed" : "completed",
				risk,
				content: shaped.content,
				...(result.isError ? { isError: true } : {}),
				...(shaped.truncation ? { truncation: shaped.truncation } : {}),
				...(shaped.cache ? { cache: shaped.cache } : {}),
			};
		} catch (error) {
			status = signal?.aborted ? "cancelled" : "failed";
			const durationMs = Date.now() - startedAt;
			const recent = {
				id: callId,
				timestamp: new Date(startedAt).toISOString(),
				server: serverId,
				tool: toolName,
				risk,
				status,
				durationMs,
			};
			supervisor.recordCall(recent);
			this.emit({ type: "mcp_call_end", call: recent });
			await this.writeAudit({
				callerSurface: getCallerSurface(context),
				server: serverId,
				item: toolName,
				kind: "tool",
				risk,
				status,
				durationMs,
				arguments: args,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private isSupervisorMetadataStale(
		supervisor: McpServerSupervisor,
		metadata: McpServerMetadata | undefined,
		categories: readonly McpMetadataCategory[] = ALL_METADATA_CATEGORIES,
	): boolean {
		if (metadata && metadata.configHash !== hashMcpServerConfig(supervisor.server)) {
			return true;
		}
		return isMetadataStale(
			metadata,
			getServerTimeoutMs(supervisor.server, this.config.settings, "refresh"),
			categories,
		);
	}

	private async getFreshToolMetadata(
		supervisor: McpServerSupervisor,
		signal?: AbortSignal,
	): Promise<McpServerMetadata> {
		const cached = supervisor.cachedMetadata;
		if (cached && !this.isSupervisorMetadataStale(supervisor, cached, TOOL_METADATA_CATEGORIES)) {
			return cached;
		}
		return supervisor.refreshMetadata(signal, RESTRICTED_TOOL_METADATA_REFRESH);
	}

	private findSupervisor(serverId: string): McpServerSupervisor | undefined {
		const normalized = serverId.trim().toLowerCase();
		return this.supervisors.get(normalized) ?? this.supervisors.get(serverId);
	}

	private findServerConfig(serverId: string): McpResolvedServerConfig | undefined {
		const normalized = serverId.trim().toLowerCase();
		return this.config.servers[normalized] ?? this.config.servers[serverId];
	}

	private getSupervisor(serverId: string): McpServerSupervisor {
		const supervisor = this.findSupervisor(serverId);
		if (!supervisor) {
			throw new Error(`MCP server not found: ${serverId}`);
		}
		return supervisor;
	}

	private requireOAuthSupervisor(serverId: string): McpServerSupervisor {
		const supervisor = this.getSupervisor(serverId);
		if (supervisor.server.auth?.type !== "oauth") {
			throw new Error(`MCP server does not use OAuth: ${serverId}`);
		}
		if (supervisor.server.transport === "stdio") {
			throw new Error(`MCP OAuth is only available for HTTP/SSE servers: ${serverId}`);
		}
		return supervisor;
	}

	private async writeAudit(input: {
		callerSurface: McpCallerSurface;
		server: string;
		item: string;
		kind: "tool" | "resource" | "prompt" | "cache";
		risk: McpRisk;
		status: McpRecentCallStatus;
		durationMs?: number;
		resultSize?: number;
		cacheId?: string;
		arguments?: Record<string, unknown>;
		error?: string;
	}): Promise<void> {
		await this.auditLogger?.write({
			...input,
			workspaceId: this.workspaceId,
			sessionId: this.sessionId,
		});
	}
}
