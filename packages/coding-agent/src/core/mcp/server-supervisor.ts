import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool as SdkTool,
} from "@modelcontextprotocol/sdk/types.js";
import { getMcpServerAuthState } from "./auth.ts";
import {
	getServerTimeoutMs,
	hashMcpServerConfig,
	mcpLifecycleToDto,
	mcpTransportToDto,
	serverMatchesToolFilters,
} from "./config.ts";
import type { McpMetadataCache } from "./metadata-cache.ts";
import type { McpOAuthStore } from "./oauth-store.ts";
import { redactMcpText } from "./safety.ts";
import type {
	McpAuthState,
	McpCallProgress,
	McpClientConnection,
	McpClientFactory,
	McpMetadataCategory,
	McpRecentCallSummary,
	McpRequestOptions,
	McpResolvedServerConfig,
	McpServerMetadata,
	McpServerStatus,
	McpServerSummary,
	McpSettings,
} from "./types.ts";

const MAX_RECENT_CALLS = 25;

export interface McpServerSupervisorOptions {
	server: McpResolvedServerConfig;
	settings: McpSettings;
	clientFactory: McpClientFactory;
	metadataCache: McpMetadataCache;
	oauthStore?: McpOAuthStore;
	/** Fired whenever status or auth state actually changes value. */
	onStateChanged?: (supervisor: McpServerSupervisor) => void;
}

export interface McpMetadataRefreshOptions {
	tools?: boolean;
	resources?: boolean;
	prompts?: boolean;
	strict?: boolean;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function messageFromError(error: unknown): string {
	return redactMcpText(error instanceof Error ? error.message : String(error));
}

function requestOptions(signal: AbortSignal | undefined, timeout: number): McpRequestOptions {
	return { signal, timeout, resetTimeoutOnProgress: true };
}

function uniqueByName<T extends { name: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		if (seen.has(item.name)) {
			continue;
		}
		seen.add(item.name);
		result.push(item);
	}
	return result;
}

export class McpServerSupervisor {
	readonly server: McpResolvedServerConfig;
	private settings: McpSettings;
	private clientFactory: McpClientFactory;
	private metadataCache: McpMetadataCache;
	private oauthStore: McpOAuthStore | undefined;
	private connection: McpClientConnection | undefined;
	private statusValue: McpServerStatus;
	private authStateValue: McpAuthState;
	private lastErrorValue: string | undefined;
	private lastConnectedAtValue: string | undefined;
	private liveToolCountValue: number | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private connecting: Promise<McpClientConnection> | undefined;
	private metadataCommitQueue: Promise<void> = Promise.resolve();
	private connectGeneration = 0;
	private recentCallsValue: McpRecentCallSummary[] = [];
	private onStateChanged: ((supervisor: McpServerSupervisor) => void) | undefined;

	constructor(options: McpServerSupervisorOptions) {
		this.server = options.server;
		this.settings = options.settings;
		this.clientFactory = options.clientFactory;
		this.metadataCache = options.metadataCache;
		this.oauthStore = options.oauthStore;
		this.onStateChanged = options.onStateChanged;
		this.authStateValue = getMcpServerAuthState(this.server, process.env, this.oauthStore);
		this.statusValue = this.server.enabled ? "cold" : "disabled";
	}

	setStateChangedListener(listener: ((supervisor: McpServerSupervisor) => void) | undefined): void {
		this.onStateChanged = listener;
	}

	private setState(next: { status?: McpServerStatus; authState?: McpAuthState }): void {
		let changed = false;
		if (next.status !== undefined && next.status !== this.statusValue) {
			this.statusValue = next.status;
			changed = true;
		}
		if (next.authState !== undefined && next.authState !== this.authStateValue) {
			this.authStateValue = next.authState;
			changed = true;
		}
		if (changed) {
			this.onStateChanged?.(this);
		}
	}

	get status(): McpServerStatus {
		return this.statusValue;
	}

	get authState(): McpAuthState {
		return this.authStateValue;
	}

	get lastError(): string | undefined {
		return this.lastErrorValue;
	}

	get recentCalls(): McpRecentCallSummary[] {
		return [...this.recentCallsValue];
	}

	get cachedMetadata(): McpServerMetadata | undefined {
		return this.metadataCache.get(this.server.id);
	}

	get isConnected(): boolean {
		return this.connection !== undefined;
	}

	refreshAuthState(): McpAuthState {
		const authState = getMcpServerAuthState(this.server, process.env, this.oauthStore);
		let status = this.statusValue;
		if (authState === "required" && this.server.enabled) {
			status = "needs_auth";
		} else if (this.statusValue === "needs_auth" && this.server.enabled) {
			status = "cold";
		}
		this.setState({ status, authState });
		return this.authStateValue;
	}

	async connect(signal?: AbortSignal): Promise<McpClientConnection> {
		if (!this.server.enabled) {
			throw new Error(`MCP server is disabled: ${this.server.id}`);
		}
		if (this.connection) {
			this.resetIdleTimer();
			return this.connection;
		}
		if (this.connecting) {
			return this.connecting;
		}
		const preConnectAuthState = getMcpServerAuthState(this.server, process.env, this.oauthStore);
		if (preConnectAuthState === "required") {
			this.setState({ status: "needs_auth", authState: preConnectAuthState });
			throw new Error(`MCP server needs authentication: ${this.server.id}`);
		}
		this.setState({ status: "connecting", authState: preConnectAuthState });
		this.lastErrorValue = undefined;
		const timeout = getServerTimeoutMs(this.server, this.settings, "connect");
		const generation = ++this.connectGeneration;
		this.connecting = this.clientFactory
			.connect(this.server, requestOptions(signal, timeout))
			.then(async (connection) => {
				if (generation !== this.connectGeneration) {
					await connection.close().catch(() => undefined);
					const error = new Error(`MCP connection cancelled: ${this.server.id}`);
					error.name = "AbortError";
					throw error;
				}
				this.connection = connection;
				this.connecting = undefined;
				this.lastConnectedAtValue = new Date().toISOString();
				this.setState({
					status: "connected",
					authState: this.authStateValue === "none" ? "none" : "authenticated",
				});
				this.resetIdleTimer();
				return connection;
			})
			.catch((error) => {
				this.connecting = undefined;
				this.connection = undefined;
				if (generation !== this.connectGeneration || isAbortError(error)) {
					this.setState({ status: this.server.enabled ? "disconnected" : "disabled" });
					throw error;
				}
				this.lastErrorValue = messageFromError(error);
				this.setState({ status: this.authStateValue === "required" ? "needs_auth" : "error" });
				throw error;
			});
		return this.connecting;
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.server.enabled === enabled) {
			return;
		}
		this.server.enabled = enabled;
		if (!enabled) {
			await this.disconnect();
			this.setState({ status: "disabled" });
			return;
		}
		this.lastErrorValue = undefined;
		this.setState({ status: "cold", authState: getMcpServerAuthState(this.server, process.env, this.oauthStore) });
	}

	async disconnect(): Promise<void> {
		this.clearIdleTimer();
		this.connectGeneration++;
		this.connecting = undefined;
		if (!this.connection) {
			this.setState({ status: this.server.enabled ? "disconnected" : "disabled" });
			return;
		}
		const connection = this.connection;
		this.connection = undefined;
		this.setState({ status: "disconnecting" });
		try {
			await connection.close();
			this.setState({ status: this.server.enabled ? "disconnected" : "disabled" });
		} catch (error) {
			this.lastErrorValue = messageFromError(error);
			this.setState({ status: "error" });
		}
	}

	async refreshMetadata(signal?: AbortSignal, options: McpMetadataRefreshOptions = {}): Promise<McpServerMetadata> {
		const refreshTools = options.tools ?? true;
		const refreshResources = options.resources ?? true;
		const refreshPrompts = options.prompts ?? true;
		const refreshedCategories: McpMetadataCategory[] = [];
		if (refreshTools) refreshedCategories.push("tools");
		if (refreshResources) refreshedCategories.push("resources");
		if (refreshPrompts) refreshedCategories.push("prompts");
		if (refreshedCategories.length === 0) {
			throw new Error(`MCP metadata refresh requires at least one category: ${this.server.id}`);
		}
		const connection = await this.connect(signal);
		this.setState({ status: "discovering" });
		try {
			const tools = refreshTools ? await this.listAllTools(connection, signal) : undefined;
			const resources = refreshResources
				? options.strict
					? await this.listAllResources(connection, signal)
					: await this.listAllResources(connection, signal).catch((): Resource[] => [])
				: undefined;
			const prompts = refreshPrompts
				? options.strict
					? await this.listAllPrompts(connection, signal)
					: await this.listAllPrompts(connection, signal).catch((): Prompt[] => [])
				: undefined;
			const serverVersion = connection.getServerVersion();
			const metadata = await this.commitMetadata(() => {
				const cached = this.cachedMetadata;
				return this.metadataCache.set(
					this.server.id,
					{
						server: this.server.id,
						...(serverVersion ? { serverVersion: `${serverVersion.name}@${serverVersion.version}` } : {}),
						configHash: hashMcpServerConfig(this.server),
						tools: refreshTools
							? uniqueByName(tools ?? []).filter((tool) => serverMatchesToolFilters(this.server, tool.name))
							: (cached?.tools ?? []),
						resources: refreshResources ? (resources ?? []) : (cached?.resources ?? []),
						prompts: refreshPrompts ? (prompts ?? []) : (cached?.prompts ?? []),
					},
					refreshedCategories,
				);
			});
			if (refreshTools) {
				this.liveToolCountValue = metadata.tools.length;
			}
			this.setState({ status: "ready" });
			this.resetIdleTimer();
			return metadata;
		} catch (error) {
			this.lastErrorValue = messageFromError(error);
			this.setState({ status: isAbortError(error) ? "disconnected" : "error" });
			throw error;
		}
	}

	async listResources(cursor: string | undefined, signal?: AbortSignal): Promise<ListResourcesResult> {
		const connection = await this.connect(signal);
		const result = await connection.listResources(
			cursor ? { cursor } : undefined,
			requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "metadata")),
		);
		this.resetIdleTimer();
		return result;
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		const connection = await this.connect(signal);
		const result = await connection.readResource(
			{ uri },
			requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "call")),
		);
		this.resetIdleTimer();
		return result;
	}

	async listPrompts(cursor: string | undefined, signal?: AbortSignal): Promise<ListPromptsResult> {
		const connection = await this.connect(signal);
		const result = await connection.listPrompts(
			cursor ? { cursor } : undefined,
			requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "metadata")),
		);
		this.resetIdleTimer();
		return result;
	}

	async getPrompt(
		name: string,
		args: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<GetPromptResult> {
		const connection = await this.connect(signal);
		const result = await connection.getPrompt(
			{ name, ...(args ? { arguments: args } : {}) },
			requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "call")),
		);
		this.resetIdleTimer();
		return result;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onProgress?: (progress: McpCallProgress) => void,
	): Promise<CallToolResult> {
		const connection = await this.connect(signal);
		const result = await connection.callTool(
			{ name, arguments: args },
			{
				...requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "call")),
				...(onProgress ? { onProgress } : {}),
			},
		);
		this.resetIdleTimer();
		return result;
	}

	recordCall(call: McpRecentCallSummary): void {
		this.recentCallsValue = [call, ...this.recentCallsValue].slice(0, MAX_RECENT_CALLS);
	}

	findCachedTool(toolName: string): SdkTool | undefined {
		return this.cachedMetadata?.tools.find((tool) => tool.name === toolName);
	}

	getSummary(): McpServerSummary {
		const cachedMetadata = this.cachedMetadata;
		return {
			id: this.server.id,
			displayName: this.server.displayName,
			sourceScope: this.server.source.scope,
			sourceLabel: this.server.source.label,
			enabled: this.server.enabled,
			activeInSession: this.server.enabled,
			transport: mcpTransportToDto(this.server.transport),
			lifecycle: mcpLifecycleToDto(this.server.lifecycle),
			status: this.statusValue,
			authState: this.authStateValue,
			toolCounts: {
				cached: cachedMetadata?.tools.length ?? 0,
				...(this.liveToolCountValue !== undefined ? { live: this.liveToolCountValue } : {}),
				enabled:
					cachedMetadata?.tools.filter((tool) => serverMatchesToolFilters(this.server, tool.name)).length ?? 0,
			},
			resourceCount: cachedMetadata?.resources.length,
			promptCount: cachedMetadata?.prompts.length,
			recentCalls: this.recentCalls,
			...(this.lastErrorValue ? { lastError: this.lastErrorValue } : {}),
			...(this.lastConnectedAtValue ? { lastConnectedAt: this.lastConnectedAtValue } : {}),
			capabilities: {
				canEnable: true,
				canConnect: this.server.enabled && !this.connection,
				canDisconnect: this.connection !== undefined,
				canRefresh: this.server.enabled,
				canAuthenticate: this.authStateValue === "required" || this.authStateValue === "failed",
				canPersistChanges: !this.server.source.shared,
			},
		};
	}

	private async listAllTools(connection: McpClientConnection, signal: AbortSignal | undefined): Promise<SdkTool[]> {
		const tools: SdkTool[] = [];
		let cursor: string | undefined;
		do {
			const result: ListToolsResult = await connection.listTools(
				cursor ? { cursor } : undefined,
				requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "metadata")),
			);
			tools.push(...result.tools);
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	private async listAllResources(
		connection: McpClientConnection,
		signal: AbortSignal | undefined,
	): Promise<Resource[]> {
		const resources: Resource[] = [];
		let cursor: string | undefined;
		do {
			const result: ListResourcesResult = await connection.listResources(
				cursor ? { cursor } : undefined,
				requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "metadata")),
			);
			resources.push(...result.resources);
			cursor = result.nextCursor;
		} while (cursor);
		return resources;
	}

	private async listAllPrompts(connection: McpClientConnection, signal: AbortSignal | undefined): Promise<Prompt[]> {
		const prompts: Prompt[] = [];
		let cursor: string | undefined;
		do {
			const result: ListPromptsResult = await connection.listPrompts(
				cursor ? { cursor } : undefined,
				requestOptions(signal, getServerTimeoutMs(this.server, this.settings, "metadata")),
			);
			prompts.push(...result.prompts);
			cursor = result.nextCursor;
		} while (cursor);
		return prompts;
	}

	private async commitMetadata(commit: () => McpServerMetadata): Promise<McpServerMetadata> {
		const result = this.metadataCommitQueue.then(commit, commit);
		this.metadataCommitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private resetIdleTimer(): void {
		this.clearIdleTimer();
		if (!this.connection || this.server.lifecycle === "keep-alive") {
			return;
		}
		const timeoutMs = getServerTimeoutMs(this.server, this.settings, "idle");
		this.idleTimer = setTimeout(() => {
			void this.disconnect();
		}, timeoutMs);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
