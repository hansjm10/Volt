import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type {
	McpAuthConfig,
	McpConfigDiagnostic,
	McpConfigSource,
	McpLifecycle,
	McpResolvedConfig,
	McpResolvedServerConfig,
	McpSettings,
	McpTransportKind,
} from "./types.ts";

export const DEFAULT_MCP_SETTINGS: McpSettings = {
	enabled: true,
	mode: "proxy",
	idleTimeoutMs: 600_000,
	connectTimeoutMs: 15_000,
	metadataTimeoutMs: 10_000,
	callTimeoutMs: 600_000,
	maxOutputBytes: 50 * 1024,
	maxOutputLines: 2000,
	directTools: false,
	resources: "explicit",
	prompts: "user-preview",
	metadataRefreshMs: 24 * 60 * 60 * 1000,
};

export interface McpRawConfigFile {
	version?: number;
	settings?: Record<string, unknown>;
	servers?: Record<string, unknown>;
}

export interface McpMergedConfigData {
	settings: Record<string, unknown>;
	servers: Map<string, Record<string, unknown>>;
	serverSources: Map<string, McpConfigSource>;
	serverDefinedIn: Map<string, McpConfigSource[]>;
	diagnostics: McpConfigDiagnostic[];
	sources: McpConfigSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			result[key] = entry;
		}
	}
	return result;
}

function asTransport(value: unknown, fallback: McpTransportKind): McpTransportKind {
	return value === "stdio" || value === "streamable-http" || value === "sse" ? value : fallback;
}

function asLifecycle(value: unknown): McpLifecycle {
	return value === "eager" || value === "keep-alive" || value === "lazy" ? value : "lazy";
}

function asDirectTools(value: unknown): boolean | string[] {
	if (typeof value === "boolean") {
		return value;
	}
	if (isStringArray(value)) {
		return [...value];
	}
	return false;
}

function asTrustedReads(value: unknown): { resources: boolean; tools: string[] } {
	if (!isRecord(value)) {
		return { resources: false, tools: [] };
	}
	const tools = isStringArray(value.tools)
		? [...new Set(value.tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0))]
		: [];
	return {
		resources: asBoolean(value.resources) ?? false,
		tools,
	};
}

function asAuthConfig(value: unknown): McpAuthConfig | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const type = value.type;
	const auth: McpAuthConfig = {};
	if (type === "none" || type === "bearer" || type === "oauth" || type === "env") {
		auth.type = type;
	}
	if (typeof value.token === "string") {
		auth.token = value.token;
	}
	if (typeof value.env === "string") {
		auth.env = value.env;
	}
	if (value.flow === "browser" || value.flow === "device" || value.flow === "auto") {
		auth.flow = value.flow;
	}
	if (typeof value.scope === "string") {
		auth.scope = value.scope;
	}
	if (typeof value.clientId === "string") {
		auth.clientId = value.clientId;
	}
	if (typeof value.clientSecret === "string") {
		auth.clientSecret = value.clientSecret;
	}
	if (typeof value.clientMetadataUrl === "string") {
		auth.clientMetadataUrl = value.clientMetadataUrl;
	}
	if (typeof value.resourceMetadataUrl === "string") {
		auth.resourceMetadataUrl = value.resourceMetadataUrl;
	}
	if (
		value.tokenEndpointAuthMethod === "client_secret_basic" ||
		value.tokenEndpointAuthMethod === "client_secret_post" ||
		value.tokenEndpointAuthMethod === "none"
	) {
		auth.tokenEndpointAuthMethod = value.tokenEndpointAuthMethod;
	}
	return Object.keys(auth).length > 0 ? auth : undefined;
}

function clampMs(value: unknown, fallback: number, min: number, max: number): number {
	const numeric = asFiniteNumber(value);
	if (numeric === undefined) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function deepMergeRecord(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			continue;
		}
		if (value === null) {
			delete result[key];
			continue;
		}
		const baseValue = base[key];
		if (isRecord(baseValue) && isRecord(value)) {
			result[key] = deepMergeRecord(baseValue, value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function normalizeMcpServerId(id: string): string {
	const normalized = id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return normalized || "server";
}

export function normalizeMcpDirectToolSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || "tool";
}

export function getMcpDirectToolName(serverId: string, toolName: string): string {
	return `mcp__${normalizeMcpDirectToolSegment(serverId)}__${normalizeMcpDirectToolSegment(toolName)}`;
}

export function getMcpSourceLabel(source: McpConfigSource): string {
	return source.label;
}

export function sourceForMcpConfigPath(
	path: string,
	source: Omit<McpConfigSource, "baseDir" | "path">,
): McpConfigSource {
	return {
		...source,
		path: resolvePath(path),
		baseDir: dirname(resolvePath(path)),
	};
}

export function createEmptyMcpMergedConfig(): McpMergedConfigData {
	return {
		settings: {},
		servers: new Map(),
		serverSources: new Map(),
		serverDefinedIn: new Map(),
		diagnostics: [],
		sources: [],
	};
}

export function mergeMcpConfigFile(
	merged: McpMergedConfigData,
	rawConfig: McpRawConfigFile,
	source: McpConfigSource,
): void {
	merged.sources.push(source);
	if (rawConfig.settings && isRecord(rawConfig.settings)) {
		merged.settings = deepMergeRecord(merged.settings, rawConfig.settings);
	}
	if (!rawConfig.servers || !isRecord(rawConfig.servers)) {
		return;
	}

	const normalizedIds = new Map<string, string>();
	for (const rawId of Object.keys(rawConfig.servers)) {
		const normalized = normalizeMcpServerId(rawId);
		const existingRawId = normalizedIds.get(normalized);
		if (existingRawId && existingRawId !== rawId) {
			merged.diagnostics.push({
				severity: "warning",
				message: `MCP server id ${JSON.stringify(rawId)} collides with ${JSON.stringify(existingRawId)} after normalization`,
				path: source.path,
				serverId: normalized,
			});
		}
		normalizedIds.set(normalized, rawId);
	}

	for (const [rawId, rawServer] of Object.entries(rawConfig.servers)) {
		const normalizedId = normalizeMcpServerId(rawId);
		if (rawServer === null) {
			merged.servers.delete(normalizedId);
			merged.serverSources.delete(normalizedId);
			merged.serverDefinedIn.delete(normalizedId);
			continue;
		}
		if (!isRecord(rawServer)) {
			merged.diagnostics.push({
				severity: "warning",
				message: `MCP server ${JSON.stringify(rawId)} ignored because it is not an object`,
				path: source.path,
				serverId: normalizedId,
			});
			continue;
		}
		const previousSource = merged.serverSources.get(normalizedId);
		const canMergeWithExisting = previousSource?.scope === source.scope;
		const current = canMergeWithExisting ? (merged.servers.get(normalizedId) ?? {}) : {};
		merged.servers.set(normalizedId, deepMergeRecord(current, rawServer));
		merged.serverSources.set(normalizedId, source);
		const definedIn = canMergeWithExisting ? (merged.serverDefinedIn.get(normalizedId) ?? []) : [];
		definedIn.push(source);
		merged.serverDefinedIn.set(normalizedId, definedIn);
	}
}

function inferTransport(server: Record<string, unknown>): McpTransportKind {
	if (typeof server.transport === "string") {
		return asTransport(server.transport, "stdio");
	}
	if (typeof server.url === "string") {
		return "streamable-http";
	}
	return "stdio";
}

function normalizeSettings(settings: Record<string, unknown>): McpSettings {
	const directTools = asBoolean(settings.directTools) ?? DEFAULT_MCP_SETTINGS.directTools;
	const resources = settings.resources === "disabled" ? "disabled" : "explicit";
	const prompts =
		settings.prompts === "disabled" || settings.prompts === "model" || settings.prompts === "user-preview"
			? settings.prompts
			: DEFAULT_MCP_SETTINGS.prompts;
	return {
		enabled: asBoolean(settings.enabled) ?? DEFAULT_MCP_SETTINGS.enabled,
		mode: "proxy",
		idleTimeoutMs: clampMs(settings.idleTimeoutMs, DEFAULT_MCP_SETTINGS.idleTimeoutMs, 1_000, 60 * 60 * 1000),
		connectTimeoutMs: clampMs(settings.connectTimeoutMs, DEFAULT_MCP_SETTINGS.connectTimeoutMs, 1_000, 120_000),
		metadataTimeoutMs: clampMs(settings.metadataTimeoutMs, DEFAULT_MCP_SETTINGS.metadataTimeoutMs, 1_000, 120_000),
		callTimeoutMs: clampMs(settings.callTimeoutMs, DEFAULT_MCP_SETTINGS.callTimeoutMs, 1_000, 60 * 60 * 1000),
		maxOutputBytes: clampMs(settings.maxOutputBytes, DEFAULT_MCP_SETTINGS.maxOutputBytes, 1024, 10 * 1024 * 1024),
		maxOutputLines: clampMs(settings.maxOutputLines, DEFAULT_MCP_SETTINGS.maxOutputLines, 1, 200_000),
		directTools,
		resources,
		prompts,
		metadataRefreshMs: clampMs(
			settings.metadataRefreshMs,
			DEFAULT_MCP_SETTINGS.metadataRefreshMs,
			1_000,
			30 * 24 * 60 * 60 * 1000,
		),
	};
}

function normalizeServer(
	id: string,
	server: Record<string, unknown>,
	source: McpConfigSource,
	definedIn: McpConfigSource[],
	diagnostics: McpConfigDiagnostic[],
): McpResolvedServerConfig | undefined {
	const transport = inferTransport(server);
	const command = typeof server.command === "string" ? server.command.trim() : undefined;
	const url = typeof server.url === "string" ? server.url.trim() : undefined;
	const enabled = asBoolean(server.enabled) ?? true;
	if (enabled && transport === "stdio" && !command) {
		diagnostics.push({
			severity: "error",
			message: `MCP server ${id} is enabled but has no stdio command`,
			path: source.path,
			serverId: id,
		});
		return undefined;
	}
	if (enabled && (transport === "streamable-http" || transport === "sse") && !url) {
		diagnostics.push({
			severity: "error",
			message: `MCP server ${id} is enabled but has no URL`,
			path: source.path,
			serverId: id,
		});
		return undefined;
	}

	return {
		id,
		enabled,
		displayName:
			typeof server.displayName === "string" && server.displayName.trim().length > 0
				? server.displayName.trim()
				: id,
		transport,
		lifecycle: asLifecycle(server.lifecycle),
		includeTools: isStringArray(server.includeTools) ? [...server.includeTools] : [],
		excludeTools: isStringArray(server.excludeTools) ? [...server.excludeTools] : [],
		directTools: asDirectTools(server.directTools),
		trustedReads: asTrustedReads(server.trustedReads),
		connectTimeoutMs: asFiniteNumber(server.connectTimeoutMs),
		callTimeoutMs: asFiniteNumber(server.callTimeoutMs),
		idleTimeoutMs: asFiniteNumber(server.idleTimeoutMs),
		metadataRefreshMs: asFiniteNumber(server.metadataRefreshMs),
		...(command ? { command } : {}),
		args: isStringArray(server.args) ? [...server.args] : [],
		...(typeof server.cwd === "string" && server.cwd.trim().length > 0 ? { cwd: server.cwd.trim() } : {}),
		env: asStringRecord(server.env),
		envAllowlist: isStringArray(server.envAllowlist) ? [...server.envAllowlist] : [],
		...(url ? { url } : {}),
		headers: asStringRecord(server.headers),
		auth: asAuthConfig(server.auth),
		source,
		definedIn,
	};
}

export function finalizeMcpConfig(merged: McpMergedConfigData): McpResolvedConfig {
	const settings = normalizeSettings(merged.settings);
	const diagnostics = [...merged.diagnostics];
	const servers: Record<string, McpResolvedServerConfig> = {};
	for (const [id, rawServer] of merged.servers.entries()) {
		const source = merged.serverSources.get(id);
		if (!source) {
			continue;
		}
		const normalized = normalizeServer(
			id,
			rawServer,
			source,
			merged.serverDefinedIn.get(id) ?? [source],
			diagnostics,
		);
		if (normalized) {
			servers[id] = normalized;
		}
	}
	return { settings, servers, diagnostics, sources: [...merged.sources] };
}

export function serverMatchesToolFilters(server: McpResolvedServerConfig, toolName: string): boolean {
	if (server.includeTools.length > 0 && !server.includeTools.includes(toolName)) {
		return false;
	}
	return !server.excludeTools.includes(toolName);
}

export function serverHasTrustedToolReads(server: McpResolvedServerConfig): boolean {
	return server.trustedReads.tools.some((toolName) => serverMatchesToolFilters(server, toolName));
}

export function serverHasTrustedReads(server: McpResolvedServerConfig): boolean {
	return server.trustedReads.resources || serverHasTrustedToolReads(server);
}

export function serverTrustsResourceReads(server: McpResolvedServerConfig): boolean {
	return server.trustedReads.resources;
}

export function serverTrustsToolRead(server: McpResolvedServerConfig, toolName: string): boolean {
	return server.trustedReads.tools.includes(toolName) && serverMatchesToolFilters(server, toolName);
}

export function getServerTimeoutMs(
	server: McpResolvedServerConfig,
	settings: McpSettings,
	kind: "connect" | "metadata" | "call" | "idle" | "refresh",
): number {
	switch (kind) {
		case "connect":
			return server.connectTimeoutMs ?? settings.connectTimeoutMs;
		case "metadata":
			return settings.metadataTimeoutMs;
		case "call":
			return server.callTimeoutMs ?? settings.callTimeoutMs;
		case "idle":
			return server.idleTimeoutMs ?? settings.idleTimeoutMs;
		case "refresh":
			return server.metadataRefreshMs ?? settings.metadataRefreshMs;
	}
}

export function mcpTransportToDto(transport: McpTransportKind): "stdio" | "streamable_http" | "sse" {
	return transport === "streamable-http" ? "streamable_http" : transport;
}

export function mcpLifecycleToDto(lifecycle: McpLifecycle): "lazy" | "eager" | "keep_alive" {
	return lifecycle === "keep-alive" ? "keep_alive" : lifecycle;
}

export function getMcpProjectConfigPaths(cwd: string): string[] {
	return [resolvePath(".mcp.json", cwd), resolvePath(`${CONFIG_DIR_NAME}/mcp.json`, cwd)];
}

export function hashMcpMetadata(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function hashMcpServerConfig(server: McpResolvedServerConfig): string {
	return hashMcpMetadata({
		id: server.id,
		enabled: server.enabled,
		displayName: server.displayName,
		transport: server.transport,
		lifecycle: server.lifecycle,
		includeTools: server.includeTools,
		excludeTools: server.excludeTools,
		directTools: server.directTools,
		trustedReads: server.trustedReads,
		connectTimeoutMs: server.connectTimeoutMs,
		callTimeoutMs: server.callTimeoutMs,
		idleTimeoutMs: server.idleTimeoutMs,
		metadataRefreshMs: server.metadataRefreshMs,
		command: server.command,
		args: server.args,
		cwd: server.cwd,
		env: server.env,
		envAllowlist: server.envAllowlist,
		url: server.url,
		headers: server.headers,
		auth: server.auth,
		sourceScope: server.source.scope,
		sourcePath: server.source.path,
	});
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}
