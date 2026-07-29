import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@hansjm10/volt-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@hansjm10/volt-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { GitContextProvider } from "./git-context-provider.ts";
import type { HostInteraction } from "./host-interaction.ts";
import { resolveLspConfig } from "./lsp/config.ts";
import { McpAuditLogger } from "./mcp/audit.ts";
import { DefaultMcpClientFactory } from "./mcp/client-factory.ts";
import { loadMcpConfig } from "./mcp/config-loader.ts";
import { McpConfigWriter } from "./mcp/config-writer.ts";
import { McpManager } from "./mcp/manager.ts";
import { McpMetadataCache } from "./mcp/metadata-cache.ts";
import { McpOAuthStore } from "./mcp/oauth-store.ts";
import { McpOutputStore } from "./mcp/output-store.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import {
	type AgentMode,
	formatPlanCheckpoint,
	PLAN_CHECKPOINT_CUSTOM_TYPE,
	PLAN_EXECUTION_CUSTOM_TYPE,
	type PlanningState,
} from "./planning.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "./subagents/tool-names.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createInspectionTool,
	createLspTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createSubagentRegistryTool,
	createSubagentTool,
	createWebFetchTool,
	createWebSearchTool,
	createWriteTool,
	DEFAULT_ACTIVE_TOOL_NAMES,
	type SubagentToolManager,
	withFileMutationQueue,
} from "./tools/index.ts";

function hasCanonicalPlanningMessage(messages: AgentMessage[], planning: PlanningState, checkpoint: string): boolean {
	const plan = planning.plan;
	if (!plan) return true;
	return messages.some((message) => {
		if (
			message.role === "custom" &&
			(message.customType === PLAN_CHECKPOINT_CUSTOM_TYPE || message.customType === PLAN_EXECUTION_CUSTOM_TYPE)
		) {
			return typeof message.content === "string" && message.content.includes(checkpoint);
		}
		if (message.role !== "toolResult") return false;
		const details = message.details as { plan?: { id?: unknown; revision?: unknown } } | undefined;
		return details?.plan?.id === plan.id && details.plan.revision === plan.revision;
	});
}

function planningStateNeedsCheckpoint(planning: PlanningState): boolean {
	return planning.plan !== null && (planning.mode === "plan" || planning.plan.phase === "active");
}

export interface CreateAgentSessionOptions {
	/** Runtime working directory for tools and session metadata. Default: process.cwd() */
	cwd?: string;
	/** Project/config root for .volt resources. Defaults to cwd. */
	projectCwd?: string;
	/** Global config directory. Default: ~/.volt/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Initial agent workflow mode. Defaults to Build; an existing branch restores its persisted mode. */
	agentMode?: AgentMode;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write,
	 *   web_search, and subagent when a manager is supplied) but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, volt enables the default built-in tools (read, bash, edit, write,
	 * web_search, and subagent when a manager is supplied) and leaves extension/custom tools enabled
	 * unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Allow extension and SDK custom tools even when they are absent from `tools`. */
	allowUnlistedExtensionTools?: boolean;
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;
	/** Shared cwd-bound Git context provider. A bounded provider is created when omitted. */
	gitContextProvider?: GitContextProvider;

	/** Settings profile to apply when creating the default SettingsManager. */
	profile?: string;
	/**
	 * Whether project-local resources should be trusted when this SDK call creates
	 * trust-sensitive runtime helpers. CLI modes pass an already-resolved
	 * SettingsManager; bare SDK calls default MCP project config to untrusted.
	 */
	projectTrusted?: boolean;
	/** Settings manager. Default: SettingsManager.create(projectCwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional host interaction bridge for blocking host-initiated actions. */
	hostInteraction?: HostInteraction;
	/** Optional manager enabling the built-in subagent tool when selected. */
	subagentToolManager?: SubagentToolManager;
	/** Optional manager enabling the native MCP gateway tool when selected. */
	mcpManager?: McpManager;
	/**
	 * Skip MCP entirely for this session: no default MCP manager is created, no
	 * MCP servers are started, and the native MCP gateway/direct tools are
	 * unavailable. Overrides `mcpManager` when both are set. Used by isolated
	 * sessions (e.g. the built-in reviewer) that must not spin up the user's MCP
	 * servers.
	 */
	disableMcp?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createInspectionTool,
	createLspTool,
	createSubagentRegistryTool,
	createSubagentTool,
	createWebFetchTool,
	createWebSearchTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@hansjm10/volt-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const projectCwd = resolvePath(options.projectCwd ?? cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager =
		options.settingsManager ??
		SettingsManager.create(projectCwd, agentDir, {
			profile: options.profile,
			...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
		});
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	await sessionManager.flush();

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd: projectCwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing branch state to restore, including message-free durable policy.
	let existingSession = sessionManager.buildSessionContext();
	if (options.agentMode !== undefined && existingSession.planning.mode !== options.agentMode) {
		sessionManager.appendPlanningState({ ...existingSession.planning, mode: options.agentMode });
		await sessionManager.flush();
		existingSession = sessionManager.buildSessionContext();
	}
	if (options.sessionStartEvent?.reason !== "new" && planningStateNeedsCheckpoint(existingSession.planning)) {
		const checkpoint = formatPlanCheckpoint(existingSession.planning);
		if (checkpoint && !hasCanonicalPlanningMessage(existingSession.messages, existingSession.planning, checkpoint)) {
			sessionManager.appendCustomMessageEntry(PLAN_CHECKPOINT_CUSTOM_TYPE, checkpoint, false, undefined);
			await sessionManager.flush();
			existingSession = sessionManager.buildSessionContext();
		}
	}
	const existingBranch = sessionManager.getBranch();
	const hasExistingSessionState = existingBranch.length > 0;
	const isNewSession = !hasExistingSessionState || options.sessionStartEvent?.reason === "new";
	const hasExistingMessages = existingSession.messages.length > 0;
	const hasThinkingEntry = existingBranch.some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// Restore branch-local model state even before the first conversation message.
	if (!model && hasExistingSessionState && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: options.scopedModels ?? [],
			isContinuing: !isNewSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// Restore branch-local thinking state even before the first conversation message.
	if (thinkingLevel === undefined && hasExistingSessionState) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const createDefaultMcpManager = async (): Promise<McpManager | undefined> => {
		const mcpProjectTrusted =
			options.projectTrusted ?? (options.settingsManager ? settingsManager.isProjectTrusted() : false);
		const mcpConfig = loadMcpConfig({ cwd: projectCwd, agentDir, projectTrusted: mcpProjectTrusted });
		if (!mcpConfig.settings.enabled || Object.keys(mcpConfig.servers).length === 0) {
			return undefined;
		}
		const mcpOAuthStore = McpOAuthStore.create(agentDir);
		const manager = new McpManager({
			config: mcpConfig,
			clientFactory: new DefaultMcpClientFactory({ cwd: projectCwd, oauthStore: mcpOAuthStore }),
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({
				agentDir,
				maxOutputBytes: mcpConfig.settings.maxOutputBytes,
				maxOutputLines: mcpConfig.settings.maxOutputLines,
				sessionId: sessionManager.getSessionId(),
				workspaceId: projectCwd,
			}),
			auditLogger: new McpAuditLogger(agentDir),
			configWriter: new McpConfigWriter({ cwd: projectCwd, agentDir, projectTrusted: mcpProjectTrusted }),
			oauthStore: mcpOAuthStore,
			sessionId: sessionManager.getSessionId(),
			workspaceId: projectCwd,
		});
		await manager
			.startEagerServers(undefined, {
				trustedReadsOnly: sessionManager.buildSessionContext().planning.mode === "plan",
			})
			.catch(() => undefined);
		return manager;
	};
	const mcpManager = options.disableMcp ? undefined : (options.mcpManager ?? (await createDefaultMcpManager()));

	const defaultActiveToolNames: string[] = [...DEFAULT_ACTIVE_TOOL_NAMES];
	const isSubagentRuntime = options.subagentToolManager?.isSubagentRuntime?.() === true;
	if (options.subagentToolManager) {
		defaultActiveToolNames.push("subagent");
		if (isSubagentRuntime) {
			defaultActiveToolNames.push(SUBAGENT_REGISTRY_TOOL_NAME);
		}
	}
	if (mcpManager?.isEnabled()) {
		defaultActiveToolNames.push("mcp");
		defaultActiveToolNames.push(...mcpManager.getDirectToolCandidates().map((candidate) => candidate.directToolName));
	}
	if (resolveLspConfig(settingsManager.getLspSettings()).enabled) {
		defaultActiveToolNames.push("lsp");
	}
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const env = auth.env || options?.env ? { ...(auth.env ?? {}), ...(options?.env ?? {}) } : undefined;
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				env,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers: mergeProviderAttributionHeaders(
					model,
					settingsManager,
					options?.sessionId,
					auth.headers,
					options?.headers,
				),
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		inferenceSpeed: existingSession.fastMode.enabled ? "fast" : "standard",
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			return runner ? runner.emitContext(messages) : messages;
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages independently from branch-local model/thinking/Fast policy.
	if (hasExistingMessages) {
		agent.state.messages = existingSession.messages;
	}
	// Persist explicit startup overrides and fill any policy dimensions that were
	// absent from setup-only sessions (for example a pre-seeded Fast policy).
	if (model && (options.model !== undefined || existingSession.model === null)) {
		sessionManager.appendModelChange(model.provider, model.id);
	}
	if (options.thinkingLevel !== undefined || !hasThinkingEntry) {
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}
	await sessionManager.flush();

	const gitContextProvider = options.gitContextProvider ?? (await GitContextProvider.create(cwd));
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		gitContextProvider,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		allowUnlistedExtensionTools: options.allowUnlistedExtensionTools,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		hostInteraction: options.hostInteraction,
		subagentToolManager: options.subagentToolManager,
		mcpManager,
		mcpManagerFactory: options.disableMcp || options.mcpManager ? undefined : createDefaultMcpManager,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
