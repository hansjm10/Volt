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

export type McpTransportKind = "stdio" | "streamable-http" | "sse";
export type McpLifecycle = "lazy" | "eager" | "keep-alive";
export type McpRisk = "read" | "write" | "destructive" | "unknown";
export type McpSourceScope = "user" | "project" | "temporary";
export type McpServerStatus =
	| "disabled"
	| "untrusted"
	| "cold"
	| "discovering"
	| "connecting"
	| "connected"
	| "ready"
	| "needs_auth"
	| "authenticating"
	| "error"
	| "disconnecting"
	| "disconnected";
export type McpAuthState = "none" | "required" | "pending" | "authenticated" | "failed";
export type McpRecentCallStatus = "started" | "completed" | "failed" | "cancelled";
export type McpCallerSurface = "model" | "tui" | "rpc" | "mobile" | "print" | "json" | "unknown";
export type McpMetadataCategory = "tools" | "resources" | "prompts";

export interface McpSettings {
	enabled: boolean;
	mode: "proxy";
	idleTimeoutMs: number;
	connectTimeoutMs: number;
	metadataTimeoutMs: number;
	callTimeoutMs: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	directTools: boolean;
	resources: "explicit" | "disabled";
	prompts: "user-preview" | "model" | "disabled";
	metadataRefreshMs: number;
}

export interface McpAuthConfig {
	type?: "none" | "bearer" | "oauth" | "env";
	token?: string;
	env?: string;
	flow?: "browser" | "device" | "auto";
	scope?: string;
	clientId?: string;
	clientSecret?: string;
	clientMetadataUrl?: string;
	resourceMetadataUrl?: string;
	tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
}

export interface McpTrustedReadsConfig {
	resources: boolean;
	tools: string[];
}

export interface McpServerConfig {
	enabled: boolean;
	displayName?: string;
	transport: McpTransportKind;
	lifecycle: McpLifecycle;
	includeTools: string[];
	excludeTools: string[];
	directTools: boolean | string[];
	trustedReads: McpTrustedReadsConfig;
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
	idleTimeoutMs?: number;
	metadataRefreshMs?: number;
	command?: string;
	args: string[];
	cwd?: string;
	env: Record<string, string>;
	envAllowlist: string[];
	url?: string;
	headers: Record<string, string>;
	auth?: McpAuthConfig;
}

export interface McpConfigSource {
	path: string;
	scope: McpSourceScope;
	label: string;
	baseDir: string;
	precedence: number;
	shared: boolean;
}

export interface McpConfigDiagnostic {
	severity: "info" | "warning" | "error";
	message: string;
	path?: string;
	serverId?: string;
}

export interface McpResolvedServerConfig extends McpServerConfig {
	id: string;
	displayName: string;
	source: McpConfigSource;
	definedIn: McpConfigSource[];
}

export interface McpResolvedConfig {
	settings: McpSettings;
	servers: Record<string, McpResolvedServerConfig>;
	diagnostics: McpConfigDiagnostic[];
	sources: McpConfigSource[];
}

export interface McpToolMetadata {
	server: string;
	tool: SdkTool;
	risk: McpRisk;
	metadataHash: string;
	lastSeenAt: string;
}

export interface McpDirectToolCandidate extends McpToolMetadata {
	directToolName: string;
}

export interface McpServerMetadata {
	server: string;
	serverVersion?: string;
	metadataHash: string;
	configHash?: string;
	tools: SdkTool[];
	resources: Resource[];
	prompts: Prompt[];
	toolsLastSeenAt: string;
	resourcesLastSeenAt: string;
	promptsLastSeenAt: string;
}

export interface McpMetadataRefreshResult {
	metadata: McpServerMetadata;
	toolsResult: ListToolsResult;
	resourcesResult?: ListResourcesResult;
	promptsResult?: ListPromptsResult;
}

export interface McpRecentCallSummary {
	id: string;
	timestamp: string;
	server: string;
	tool: string;
	risk: McpRisk;
	status: McpRecentCallStatus;
	durationMs?: number;
	outputBytes?: number;
	truncated?: boolean;
}

export interface McpToolSummary {
	server: string;
	name: string;
	title?: string;
	description?: string;
	risk: McpRisk;
	trustedRead: boolean;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, unknown>;
	metadataHash: string;
	lastSeenAt: string;
	stale: boolean;
	direct: boolean;
}

export interface McpResourceSummary {
	server: string;
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	size?: number;
}

export interface McpPromptSummary {
	server: string;
	name: string;
	title?: string;
	description?: string;
	arguments?: Prompt["arguments"];
}

export interface McpServerSummary {
	id: string;
	displayName: string;
	sourceScope: McpSourceScope;
	sourceLabel: string;
	enabled: boolean;
	activeInSession: boolean;
	transport: "stdio" | "streamable_http" | "sse";
	lifecycle: "lazy" | "eager" | "keep_alive";
	status: McpServerStatus;
	authState: McpAuthState;
	toolCounts: { cached: number; live?: number; enabled?: number };
	resourceCount?: number;
	promptCount?: number;
	recentCalls: McpRecentCallSummary[];
	lastError?: string;
	lastConnectedAt?: string;
	capabilities: {
		canEnable: boolean;
		canConnect: boolean;
		canDisconnect: boolean;
		canRefresh: boolean;
		canAuthenticate: boolean;
		canPersistChanges: boolean;
	};
}

export interface McpCallProgress {
	progress: number;
	total?: number;
	message?: string;
}

export interface McpAuthRequestDetails {
	flow: "browser" | "device";
	authorizationUrl?: string;
	redirectUrl?: string;
	verificationUri?: string;
	verificationUriComplete?: string;
	userCode?: string;
	expiresAt?: string;
	intervalMs?: number;
	message?: string;
}

/**
 * Lifecycle events emitted by the MCP manager. These flow through
 * AgentSession's event stream so TUI, RPC, daemon, and mobile clients
 * observe MCP state changes without polling.
 */
export type McpManagerEvent =
	| { type: "mcp_servers_changed"; servers: McpServerSummary[] }
	| { type: "mcp_server_status_changed"; server: McpServerSummary }
	| { type: "mcp_auth_request"; serverId: string; auth: McpAuthRequestDetails }
	| {
			type: "mcp_auth_update";
			serverId: string;
			status: string;
			authState: McpAuthState;
			message?: string;
			server?: McpServerSummary;
	  }
	| { type: "mcp_call_start"; call: McpRecentCallSummary }
	| {
			type: "mcp_call_update";
			call: Pick<McpRecentCallSummary, "id" | "server" | "tool">;
			progress: McpCallProgress;
	  }
	| { type: "mcp_call_end"; call: McpRecentCallSummary; cacheId?: string };

export type McpManagerEventListener = (event: McpManagerEvent) => void;

export interface McpGatewayInput {
	action:
		| "status"
		| "list_servers"
		| "search"
		| "describe"
		| "call"
		| "connect"
		| "disconnect"
		| "set_enabled"
		| "auth"
		| "poll_auth"
		| "cancel_auth"
		| "logout"
		| "list_tools"
		| "list_resources"
		| "read_resource"
		| "list_prompts"
		| "get_prompt"
		| "read_cache";
	server?: string;
	query?: string;
	tool?: string;
	enabled?: boolean;
	flow?: "browser" | "device";
	redirectUrl?: string;
	code?: string;
	state?: string;
	arguments?: Record<string, unknown>;
	argumentsJson?: string;
	resourceUri?: string;
	prompt?: string;
	cacheId?: string;
	limit?: number;
	cursor?: string;
}

export interface McpSearchMatch {
	server: string;
	tool: string;
	title: string;
	summary: string;
	risk: McpRisk;
	trustedRead: boolean;
	metadataHash: string;
	call: string;
	describe: string;
	score: number;
}

export interface McpOutputTruncation {
	truncated: boolean;
	returnedBytes: number;
	totalBytes: number;
	returnedLines: number;
	totalLines: number;
}

export interface McpCacheReference {
	id: string;
	read: string;
}

export interface McpGatewayCallResult {
	action: "call";
	server: string;
	tool: string;
	status: "completed" | "failed";
	risk: McpRisk;
	content: string;
	isError?: boolean;
	truncation?: McpOutputTruncation;
	cache?: McpCacheReference;
}

export interface McpClientConnection {
	listTools(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<ListToolsResult>;
	listResources(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<ListResourcesResult>;
	readResource(params: { uri: string }, options: McpRequestOptions): Promise<ReadResourceResult>;
	listPrompts(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<ListPromptsResult>;
	getPrompt(
		params: { name: string; arguments?: Record<string, unknown> },
		options: McpRequestOptions,
	): Promise<GetPromptResult>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		options: McpRequestOptions,
	): Promise<CallToolResult>;
	getServerVersion(): { name: string; version: string } | undefined;
	close(): Promise<void>;
}

export interface McpRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	resetTimeoutOnProgress?: boolean;
	onProgress?: (progress: McpCallProgress) => void;
}

export interface McpClientFactory {
	connect(server: McpResolvedServerConfig, options: McpRequestOptions): Promise<McpClientConnection>;
}

export interface McpGatewayExecutionContext {
	mode: "tui" | "rpc" | "json" | "print" | "unknown";
	caller?: "model" | "user";
	restrictedTrustedRead?: boolean;
}
