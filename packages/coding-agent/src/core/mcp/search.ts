import { serverMatchesToolFilters, serverTrustsToolRead } from "./config.ts";
import { classifyMcpToolRisk, isMcpToolTrustedReadCandidate } from "./safety.ts";
import type { McpResolvedServerConfig, McpSearchMatch, McpServerMetadata } from "./types.ts";

const DEFAULT_MCP_SEARCH_LIMIT = 8;
const MAX_MCP_SEARCH_LIMIT = 20;

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_MCP_SEARCH_LIMIT;
	}
	return Math.max(1, Math.min(MAX_MCP_SEARCH_LIMIT, Math.floor(limit)));
}

function boundedSummary(value: string | undefined): string {
	const normalized = (value ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "No description.";
	}
	return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function scoreTool(
	queryTokens: string[],
	name: string,
	title: string | undefined,
	description: string | undefined,
): number {
	const nameText = name.toLowerCase();
	const titleText = (title ?? "").toLowerCase();
	const descriptionText = (description ?? "").toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (nameText === token) score += 20;
		if (nameText.includes(token)) score += 8;
		if (titleText.includes(token)) score += 5;
		if (descriptionText.includes(token)) score += 2;
	}
	return score;
}

function callSnippet(server: string, tool: string): string {
	return `mcp({"action":"call","server":"${server}","tool":"${tool}","arguments":{...}})`;
}

function describeSnippet(server: string, tool: string): string {
	return `mcp({"action":"describe","server":"${server}","tool":"${tool}"})`;
}

export function searchMcpMetadata(options: {
	query: string;
	limit?: number;
	servers: Record<string, McpResolvedServerConfig>;
	metadata: McpServerMetadata[];
}): McpSearchMatch[] {
	const queryTokens = tokenize(options.query);
	if (queryTokens.length === 0) {
		return [];
	}
	const matches: McpSearchMatch[] = [];
	for (const metadata of options.metadata) {
		const server = options.servers[metadata.server];
		if (!server || !server.enabled) {
			continue;
		}
		for (const tool of metadata.tools) {
			if (!serverMatchesToolFilters(server, tool.name)) {
				continue;
			}
			const title = tool.title ?? tool.name;
			const score = scoreTool(queryTokens, tool.name, title, tool.description);
			if (score <= 0) {
				continue;
			}
			matches.push({
				server: metadata.server,
				tool: tool.name,
				title,
				summary: boundedSummary(tool.description),
				risk: classifyMcpToolRisk(tool),
				trustedRead: serverTrustsToolRead(server, tool.name) && isMcpToolTrustedReadCandidate(tool),
				metadataHash: metadata.metadataHash,
				call: callSnippet(metadata.server, tool.name),
				describe: describeSnippet(metadata.server, tool.name),
				score,
			});
		}
	}
	return matches
		.sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))
		.slice(0, normalizeLimit(options.limit));
}
