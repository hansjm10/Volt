import { Buffer } from "node:buffer";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Prompt, Resource, Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { ensurePrivateDirectorySync, hardenPrivateRegularFileSync } from "../../utils/private-files.ts";
import { hashMcpMetadata } from "./config.ts";
import type { McpMetadataCategory, McpServerMetadata } from "./types.ts";

const DEFAULT_METADATA_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_METADATA_CACHE_MAX_SERVERS = 64;
const DEFAULT_METADATA_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_METADATA_FRESHNESS = new Date(0).toISOString();

interface MetadataCacheFile {
	version: 2;
	servers: Record<string, McpServerMetadata>;
}

export interface McpMetadataCacheOptions {
	agentDir: string;
	maxBytes?: number;
	maxServers?: number;
	maxAgeMs?: number;
	now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: unknown): McpServerMetadata | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.server !== "string" || typeof value.metadataHash !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.tools) || !Array.isArray(value.resources) || !Array.isArray(value.prompts)) {
		return undefined;
	}
	if (
		typeof value.toolsLastSeenAt !== "string" ||
		typeof value.resourcesLastSeenAt !== "string" ||
		typeof value.promptsLastSeenAt !== "string"
	) {
		return undefined;
	}
	return {
		server: value.server,
		metadataHash: value.metadataHash,
		...(typeof value.serverVersion === "string" ? { serverVersion: value.serverVersion } : {}),
		...(typeof value.configHash === "string" ? { configHash: value.configHash } : {}),
		tools: value.tools as SdkTool[],
		resources: value.resources as Resource[],
		prompts: value.prompts as Prompt[],
		toolsLastSeenAt: value.toolsLastSeenAt,
		resourcesLastSeenAt: value.resourcesLastSeenAt,
		promptsLastSeenAt: value.promptsLastSeenAt,
	};
}

function parseCacheFile(value: unknown): MetadataCacheFile {
	if (!isRecord(value) || value.version !== 2 || !isRecord(value.servers)) {
		return { version: 2, servers: {} };
	}
	const servers: Record<string, McpServerMetadata> = {};
	for (const [server, entry] of Object.entries(value.servers)) {
		const parsed = parseMetadata(entry);
		if (parsed) {
			servers[server] = parsed;
		}
	}
	return { version: 2, servers };
}

function latestSeenAt(metadata: McpServerMetadata): number {
	const timestamps = [metadata.toolsLastSeenAt, metadata.resourcesLastSeenAt, metadata.promptsLastSeenAt]
		.map((value) => Date.parse(value))
		.filter(Number.isFinite);
	return timestamps.length > 0 ? Math.max(...timestamps) : Number.NaN;
}

export class McpMetadataCache {
	private path: string;
	private servers: Map<string, McpServerMetadata>;
	private maxBytes: number;
	private maxServers: number;
	private maxAgeMs: number;
	private now: () => number;

	constructor(options: McpMetadataCacheOptions) {
		this.path = join(options.agentDir, "mcp", "metadata-cache.json");
		this.servers = new Map();
		this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_METADATA_CACHE_MAX_BYTES);
		this.maxServers = Math.max(1, options.maxServers ?? DEFAULT_METADATA_CACHE_MAX_SERVERS);
		this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_METADATA_CACHE_MAX_AGE_MS);
		this.now = options.now ?? Date.now;
		this.load();
	}

	get(server: string): McpServerMetadata | undefined {
		const metadata = this.servers.get(server);
		return metadata ? structuredClone(metadata) : undefined;
	}

	getAll(): McpServerMetadata[] {
		return Array.from(this.servers.values(), (metadata) => structuredClone(metadata));
	}

	set(
		server: string,
		metadata: Omit<
			McpServerMetadata,
			"metadataHash" | "toolsLastSeenAt" | "resourcesLastSeenAt" | "promptsLastSeenAt"
		>,
		refreshedCategories: readonly McpMetadataCategory[],
	): McpServerMetadata {
		if (refreshedCategories.length === 0) {
			throw new Error("MCP metadata writes require at least one refreshed category");
		}
		const refreshed = new Set(refreshedCategories);
		const current = this.servers.get(server);
		const identityMatches =
			current !== undefined &&
			current.serverVersion === metadata.serverVersion &&
			current.configHash === metadata.configHash;
		const refreshedAt = new Date(this.now()).toISOString();
		const next: McpServerMetadata = {
			...metadata,
			server,
			metadataHash: hashMcpMetadata({
				tools: metadata.tools,
				resources: metadata.resources,
				prompts: metadata.prompts,
				serverVersion: metadata.serverVersion,
				configHash: metadata.configHash,
			}),
			toolsLastSeenAt: refreshed.has("tools")
				? refreshedAt
				: identityMatches
					? current.toolsLastSeenAt
					: RESET_METADATA_FRESHNESS,
			resourcesLastSeenAt: refreshed.has("resources")
				? refreshedAt
				: identityMatches
					? current.resourcesLastSeenAt
					: RESET_METADATA_FRESHNESS,
			promptsLastSeenAt: refreshed.has("prompts")
				? refreshedAt
				: identityMatches
					? current.promptsLastSeenAt
					: RESET_METADATA_FRESHNESS,
		};
		this.servers.set(server, next);
		this.save();
		return structuredClone(next);
	}

	delete(server: string): void {
		this.servers.delete(server);
		this.save();
	}

	private load(): void {
		if (!existsSync(this.path)) {
			return;
		}
		try {
			hardenPrivateRegularFileSync(this.path);
			if (lstatSync(this.path).size > this.maxBytes) {
				return;
			}
			const parsed = parseCacheFile(JSON.parse(readFileSync(this.path, "utf-8")) as unknown);
			this.servers = new Map(
				Object.entries(parsed.servers).filter(([server, metadata]) => server === metadata.server),
			);
			this.prune();
		} catch {
			this.servers = new Map();
		}
	}

	private save(): void {
		this.prune();
		const serialized = this.serialize();
		if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) return;
		const dir = dirname(this.path);
		ensurePrivateDirectorySync(dir);
		writeDurableAtomicFileSync(this.path, serialized);
	}

	private prune(): void {
		const cutoff = this.now() - this.maxAgeMs;
		const sorted = () =>
			Array.from(this.servers.entries()).sort((left, right) => {
				const leftTime = latestSeenAt(left[1]);
				const rightTime = latestSeenAt(right[1]);
				return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
			});
		for (const [server, metadata] of sorted()) {
			const seenAt = latestSeenAt(metadata);
			if (!Number.isFinite(seenAt) || seenAt < cutoff) {
				this.servers.delete(server);
			}
		}
		while (this.servers.size > this.maxServers) {
			const oldest = sorted()[0];
			if (!oldest) break;
			this.servers.delete(oldest[0]);
		}
		while (this.serializedBytes() > this.maxBytes) {
			const oldest = sorted()[0];
			if (!oldest) break;
			this.servers.delete(oldest[0]);
		}
	}

	private serializedBytes(): number {
		return Buffer.byteLength(this.serialize(), "utf8");
	}

	private serialize(): string {
		return `${JSON.stringify({ version: 2, servers: Object.fromEntries(this.servers.entries()) }, null, 2)}\n`;
	}
}
