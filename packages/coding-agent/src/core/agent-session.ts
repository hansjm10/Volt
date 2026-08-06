/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentAbortSource,
	AgentDelivery,
	AgentDeliveryKind,
	AgentDeliveryParticipantOutcome,
	AgentDeliveryPreparation,
	AgentDeliveryTransactionContext,
	AgentDeliveryTransactionParticipant,
	AgentEvent,
	AgentLoopNextActionContext,
	AgentMessage,
	AgentRunResult,
	AgentRunSnapshot,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@hansjm10/volt-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "@hansjm10/volt-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	completeSimple,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	streamSimple,
} from "@hansjm10/volt-ai";
import { getAgentDir } from "../config.ts";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-write.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../utils/private-files.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateMessagesTokens,
	generateBranchSummary,
	prepareCompaction,
	type SummarizationRetryOptions,
	shouldCompact,
} from "./compaction/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionMessageRoleMismatchError,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { GitContextProvider } from "./git-context-provider.ts";
import type { HostInteraction } from "./host-interaction.ts";
import { resolveLspConfig } from "./lsp/config.ts";
import { LspManager, type LspServerStatus } from "./lsp/manager.ts";
import { createMcpDirectToolDefinitions } from "./mcp/direct-tools.ts";
import type { McpManager } from "./mcp/manager.ts";
import type { McpManagerEvent } from "./mcp/types.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	isToolVisibleUnderGrant,
	type OperationResolution,
	operationProvidesResearchEvidence,
	RESEARCH_OPERATION_GRANT_PROFILE,
	resolverCanProvideResearchEvidence,
	type ToolOperationResolver,
} from "./operation-authorization.ts";
import {
	type AgentMode,
	assertPlanRevision,
	clonePlanningState,
	formatPlanCheckpoint,
	formatPlanPolicy,
	PLAN_CHECKPOINT_CUSTOM_TYPE,
	type PlanExecution,
	type PlanningState,
	type PlanState,
	type PlanStepStatus,
	parsePlanningState,
} from "./planning.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { isTransientProviderError } from "./provider-errors.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { RpcGitContext, UiActionStateDescriptor } from "./rpc/types.ts";
import type {
	BranchSummaryEntry,
	ClientInputCommand,
	ClientInputRecord,
	CompactionEntry,
	SessionManager,
} from "./session-manager.ts";
import {
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	CURRENT_SESSION_VERSION,
	createClientInputSemanticDigest,
	getLatestCompactionEntry,
	RUNTIME_QUEUE_ENTRY_ID_PREFIX,
	SessionAtomicAppendError,
	type SessionHeader,
} from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "./subagents/tool-names.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { getThemeByName, theme } from "./theme/runtime.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import {
	BRAVE_SEARCH_AUTH_PROVIDER,
	createAllToolDefinitions,
	createDefaultWebSearchOperations,
	DEFAULT_ACTIVE_TOOL_NAMES,
	extractUrls,
	isCodexImageGenerationModel,
	type SubagentToolDetails,
	type SubagentToolManager,
	type SubagentToolMode,
} from "./tools/index.ts";
import { canonicalizePlanSteps, createPlanningToolDefinitions, NATIVE_PLAN_TOOL_NAMES } from "./tools/planning.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => structuredClone(message));
}

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface ActiveCompaction {
	reason: CompactionReason;
	startedAt: number;
}

/**
 * One user message waiting in an agent queue.
 *
 * `queueEntryId` is the runtime dequeue identity for every producer. A remote
 * caller's durable idempotency identity is retained separately so locally
 * queued TUI input never accidentally becomes a durable client receipt.
 */
export interface AgentSessionQueuedMessage {
	readonly queueEntryId: string;
	readonly clientMessageId?: string;
	readonly text: string;
}

function createRuntimeQueueEntryId(): string {
	return `${RUNTIME_QUEUE_ENTRY_ID_PREFIX}${randomUUID()}`;
}

/** The queue identity projection retains every admitted entry inside its wire budget. */
export const AGENT_SESSION_MAX_QUEUED_MESSAGES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			/**
			 * Emitted once tracked prompt work fully settles. When an agent run starts,
			 * this follows its final `agent_end` plus any automatic retries,
			 * overflow/threshold compaction, and queued-message continuations.
			 * Equivalent to `waitForIdle()` resolving for that work.
			 */
			type: "agent_settled";
	  }
	| {
			type: "queue_update";
			steering: readonly AgentSessionQueuedMessage[];
			followUp: readonly AgentSessionQueuedMessage[];
	  }
	| {
			type: "client_input_outcome";
			clientMessageId: string;
			outcome: "failed";
			reason: "queue_cleared" | "dispatch_failed";
	  }
	| { type: "compaction_start"; reason: CompactionReason }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "planning_state_changed"; planning: PlanningState }
	| { type: "git_context_changed"; gitContext: RpcGitContext | null }
	| {
			type: "ui_action_state_changed";
			action: string;
			state: UiActionStateDescriptor;
	  }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| McpManagerEvent;

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/**
 * A committed change to the conversation generation.
 *
 * Unlike SessionManager's low-level leaf notification, this fires only after
 * the active leaf and Agent message context describe the same branch.
 */
export interface ConversationGenerationChange {
	previousLeafId: string | null;
	nextLeafId: string | null;
}

export type ConversationGenerationListener = (change: ConversationGenerationChange) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	gitContextProvider?: GitContextProvider;
	cwd: string;
	/** Global config directory used for session-owned artifacts. Default: ~/.volt/agent */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: read, bash, edit, write, web_search, and subagent when a manager is supplied. */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Allow extension and SDK custom tools even when they are absent from allowedToolNames. */
	allowUnlistedExtensionTools?: boolean;
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional host interaction bridge for blocking host-initiated actions. */
	hostInteraction?: HostInteraction;
	/** Optional manager enabling the built-in subagent tool when selected. */
	subagentToolManager?: SubagentToolManager;
	/** Optional manager enabling the native MCP gateway tool when configured. */
	mcpManager?: McpManager;
	/** Factory used to rebuild the default MCP manager on session reload. */
	mcpManagerFactory?: () => Promise<McpManager | undefined> | McpManager | undefined;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export type PromptAdmissionOutcome = "admitted" | "completed";

export type PromptPreflightResult = { success: true; outcome: PromptAdmissionOutcome } | { success: false };

export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Stable remote-client identity persisted with the resulting user message. */
	clientMessageId?: string;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (result: PromptPreflightResult) => void;
	/**
	 * Internal mutation lease asserted at async preflight boundaries.
	 *
	 * Remote callers use this to prove the conversation generation they targeted
	 * is still current before prompt admission can mutate durable branch state.
	 */
	assertConversationGenerationCurrent?: () => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Lifetime session statistics for /session and RPC consumers. */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	/** Current retained model context, separate from lifetime token totals. */
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface DefaultPersistenceOptions {
	persistDefault?: boolean;
}

interface PreparedQueueEntry {
	kind: "steer" | "followUp";
	entry: AgentSessionQueuedMessage;
}

interface PreparedDeliverySnapshot {
	messages: AgentMessage[];
	queueEntries: PreparedQueueEntry[];
	error?: Error;
}

interface LiveClientInputOperation {
	command: ClientInputCommand;
	semanticDigest: string;
	accepted: Promise<PromptAdmissionOutcome>;
	resolveAccepted(outcome: PromptAdmissionOutcome): void;
	rejectAccepted(error: Error): void;
	acceptanceSettled: boolean;
	acceptedForDispatch: boolean;
	dispatchBoundaryPersisted: boolean;
	completion: Promise<void>;
	attachCompletion(completion: Promise<void>): void;
	rejectCompletion(error: Error): void;
	/** Owns a durable queue admission, including while its flush is still pending. */
	queued: boolean;
}

type ClientInputAdmission =
	| { kind: "none" }
	| { kind: "completed" }
	| { kind: "live"; operation: LiveClientInputOperation }
	| { kind: "start"; operation: LiveClientInputOperation };

type PromptDispatchOutcome = "handled" | "queued" | "run";

export class ClientInputConflictError extends Error {
	readonly code = "client_input_conflict";
}

export class ClientInputOutcomeAmbiguousError extends Error {
	readonly code = "client_input_outcome_ambiguous";
}

/**
 * Raised when {@link AgentSession.clearQueue} revoked the runtime queues but their
 * cancellation could not be made durable. The queues are already gone, so the
 * captured text is carried on the error: it is the only remaining copy of what the
 * user typed, and callers restoring input to an editor must recover it from here.
 */
export class QueueClearPersistenceError extends Error {
	readonly code = "queue_clear_persistence_failed";
	readonly steering: string[];
	readonly followUp: string[];

	constructor(cause: Error, queues: { steering: string[]; followUp: string[] }) {
		super(cause.message, { cause });
		this.steering = queues.steering;
		this.followUp = queues.followUp;
	}
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_COMPACTION_SUMMARY_RETRIES = 3;
const MAX_COMPACTION_RETRY_DELAY_MS = 30_000;

// ============================================================================
// AgentSession Class
// ============================================================================

/** Custom-message type of the persisted §4 subagent recovery notice (issue #129). */
export const SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE = "subagent_recovery";
const SUBAGENT_RECOVERY_NOTICE_MAX_LISTED = 8;
const SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS = 80;

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly gitContextProvider: GitContextProvider;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _unsubscribeGitContext?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _eventListenerGitObservations = new Set<() => void>();
	private readonly _conversationGenerationListeners = new Set<ConversationGenerationListener>();
	private _conversationGenerationRevision = 0;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: AgentSessionQueuedMessage[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: AgentSessionQueuedMessage[] = [];
	/** Correlates queue projections with Agent-owned logical delivery identities. */
	private readonly _queueDeliveryIds = new Map<string, string>();
	/** Reuses one transformed payload and queue-ownership snapshot across retained attempts. */
	private readonly _preparedDeliveryExtensions = new Map<string, PreparedDeliverySnapshot>();
	/** Assigns the current ready-plan transition to the first eligible prepared delivery. */
	private _readyPlanTransitionDeliveryId: string | undefined;
	/** Invalidates extension preparation that finishes after Agent revokes its delivery. */
	private readonly _preparingDeliveryExtensions = new Map<string, object>();
	/** Host cleanup started by synchronous Agent revocation callbacks. */
	private readonly _deliveryRevocationSettlements = new Set<Promise<void>>();
	private _agentDeliveryRevocationSuppressionDepth = 0;
	private readonly _suppressedAgentDeliveryRevocations = new Map<string, AgentDelivery>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Tracks core agent runs, including retry and compaction continuations. */
	private _activePromptRuns = new Set<Promise<void>>();
	/** Tracks complete prompt calls, including pre-prompt recovery and message construction. */
	private _activePromptTransactions = new Map<symbol, Promise<void>>();
	/** Tracks standalone session operations such as manual compaction and tree navigation. */
	private _activeSessionOperations = new Set<Promise<unknown>>();
	/** Reserves the persistence leaf while manual compaction aborts and joins an earlier run. */
	private _manualCompactionAdmissionInProgress = false;
	/** Fences session replacement and fresh mutations across asynchronous runtime reload. */
	private _reloadInProgress = false;
	private _resumeRecoveredClientInputsPromise: Promise<void> | undefined;
	/** Blocks newer input from overtaking durable queue entries restored at construction. */
	private _recoveredClientInputReplayPending = false;
	/** Runtime joins for durable client-input receipts; survives physical transport replacement. */
	private readonly _liveClientInputs = new Map<string, LiveClientInputOperation>();
	/** Maps core-only dequeue identities to the external semantic ID, or null for local input. */
	private readonly _dequeuedQueueClientMessageIds = new Map<string, string | null>();
	/** Fatal host error swallowed into agent-core's synthetic error turn. */
	private _agentEventFatalError: Error | undefined;
	private _extensionCommandTransactions = new Set<symbol>();
	private _activeExtensionCommandHandlers = 0;

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _activeCompaction: ActiveCompaction | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	/**
	 * Coordinates the agent-loop stop with its mandatory compaction. A failed
	 * compaction returns to idle but never resumes the interrupted run.
	 */
	private _proactiveCompactionState: "idle" | "scheduled" | "compacting" = "idle";
	private _drainFollowUpsOnNextContinuation = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/** Incremented by abort() so in-flight session continuations cannot start a new core run. */
	private _abortGeneration = 0;
	private _abortPromise: Promise<void> | undefined;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _allowUnlistedExtensionTools: boolean;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _disposed = false;
	private _disposePromise?: Promise<void>;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;
	private _fastModeEnabled = false;
	private _planningState: PlanningState;
	private _planningTransitionQueue: Promise<void> = Promise.resolve();
	private _planningTransitionInFlight = false;
	private _requestedBuildToolNames: string[] = [];
	private _planningRuntimeInitialized = false;
	/** Conversation generation whose successful read currently satisfies the Plan research gate. */
	private _planResearchGeneration: number | undefined;
	/** Guards the install-once agent hook contract; see _installAgentToolHooks. */
	private _agentToolHooksInstalled = false;
	private _trustedHostToolNames: Set<string> = new Set();
	private _authorizedOperationResolutions: Map<string, OperationResolution> = new Map();

	// LSP diagnostics manager (created unless lsp.enabled is false)
	private _lspManager?: LspManager;
	private _hostInteraction?: HostInteraction;
	private _subagentToolManager?: SubagentToolManager;
	private _subagentRecoveryNoticeDone = false;
	private _mcpManager?: McpManager;
	private _mcpManagerFactory?: () => Promise<McpManager | undefined> | McpManager | undefined;
	private _unsubscribeMcpManager?: () => void;
	private _directMcpToolNames: Set<string> = new Set();

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this.gitContextProvider = config.gitContextProvider ?? new GitContextProvider(config.cwd);
		if (!config.gitContextProvider) void this.gitContextProvider.refresh();
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = resolvePath(config.agentDir ?? getAgentDir());
		this._modelRegistry = config.modelRegistry;
		const restoredContext = this.sessionManager.buildSessionContext();
		this._restoreFastModePolicy(restoredContext.fastMode);
		this._planningState = clonePlanningState(restoredContext.planning);
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._allowUnlistedExtensionTools = config.allowUnlistedExtensionTools ?? false;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._hostInteraction = config.hostInteraction;
		this._subagentToolManager = config.subagentToolManager;
		this._mcpManager = config.mcpManager;
		this._mcpManagerFactory = config.mcpManagerFactory;
		this._attachMcpManagerEvents();

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._unsubscribeGitContext = this.gitContextProvider.subscribe(
			(gitContext) => {
				this._emit({ type: "git_context_changed", gitContext });
			},
			{ monitor: false },
		);
		this._installAgentToolHooks();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._planningRuntimeInitialized = true;
		this._syncPlanningRuntime();
		this._recoverDurableQueuedClientInputs();
	}

	private _assertConversationAuthorityAvailable(): void {
		this.sessionManager.assertConversationAuthorityAvailable();
	}

	private _isConversationAuthorityAvailable(): boolean {
		return this.sessionManager.getConversationAuthorityStatus().status === "available";
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setHostInteraction(hostInteraction: HostInteraction | undefined): void {
		this._hostInteraction = hostInteraction;
		this._lspManager?.setHostInteraction(hostInteraction);
	}

	/** LSP status for the /lsp command. */
	getLspStatus(): { enabled: boolean; servers: LspServerStatus[]; traceFile?: string } {
		return {
			enabled: this._lspManager !== undefined,
			servers: this._lspManager?.getStatus() ?? [],
			traceFile: this._lspManager?.getTraceFile(),
		};
	}

	/** Enable or disable LSP protocol tracing at runtime. */
	setLspTraceFile(filePath: string | undefined): Promise<void> {
		return this._lspManager?.setTraceFile(filePath) ?? Promise.resolve();
	}

	/** Stop LSP tracing from a synchronous process teardown path. */
	closeLspTraceSync(): void {
		this._lspManager?.closeTraceSync();
	}

	/** Stop all running language servers; they respawn lazily on next use. Returns the number stopped. */
	restartLspServers(): number {
		return this._lspManager?.restart() ?? 0;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers, env: result.env };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers, env: result.env } : {};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 *
	 * Install-once is an enforced contract: external wrappers — e.g. the SubagentManager per-child
	 * turn budget — chain and later restore `agent.beforeToolCall`/`agent.nextAction`.
	 * Reinstalling any of these hooks after construction would silently discard such wrappers, so a
	 * second call throws instead.
	 */
	private _installAgentToolHooks(): void {
		if (this._agentToolHooksInstalled) {
			throw new Error(
				"Agent tool hooks are installed exactly once per AgentSession; reinstalling would silently drop external hook wrappers such as the subagent turn budget.",
			);
		}
		this._agentToolHooksInstalled = true;
		const deliveryRevoked = this.agent.deliveryRevoked;
		this.agent.deliveryRevoked = (delivery) => {
			try {
				deliveryRevoked?.(delivery);
			} finally {
				if (this._agentDeliveryRevocationSuppressionDepth > 0) {
					this._suppressedAgentDeliveryRevocations.set(delivery.deliveryId, delivery);
				} else {
					this._handleAgentDeliveryRevoked(delivery);
				}
			}
		};
		const prepareDelivery = this.agent.prepareDelivery;
		this.agent.prepareDelivery = async (delivery, signal): Promise<AgentDeliveryPreparation> => {
			this._assertConversationAuthorityAvailable();
			const prepared = prepareDelivery
				? await prepareDelivery(delivery, signal)
				: { messages: [...delivery.messages] };
			if (this._disposed) throw new Error("Session disposed during delivery preparation");
			if (!this.agent.canPrepareDelivery(delivery.deliveryId)) return prepared;
			let deliverySnapshot = this._preparedDeliveryExtensions.get(delivery.deliveryId);
			if (!deliverySnapshot) {
				const normalized = this._normalizePreparedDeliveryMessages(cloneAgentMessages(prepared.messages));
				const preparationToken = {};
				this._preparingDeliveryExtensions.set(delivery.deliveryId, preparationToken);
				try {
					const preparedExtension = await this._prepareDeliveryExtensionMessages(normalized.messages);
					if (this._disposed) throw new Error("Session disposed during delivery preparation");
					deliverySnapshot = {
						...preparedExtension,
						messages: cloneAgentMessages(preparedExtension.messages),
						queueEntries: normalized.queueEntries.map(({ kind, entry }) => ({ kind, entry: { ...entry } })),
					};
					if (
						this._preparingDeliveryExtensions.get(delivery.deliveryId) === preparationToken &&
						this.agent.canPrepareDelivery(delivery.deliveryId)
					) {
						this._preparedDeliveryExtensions.set(delivery.deliveryId, deliverySnapshot);
					}
				} finally {
					if (this._preparingDeliveryExtensions.get(delivery.deliveryId) === preparationToken) {
						this._preparingDeliveryExtensions.delete(delivery.deliveryId);
					}
				}
			}
			const queueEntries = deliverySnapshot.queueEntries.map(({ kind, entry }) => ({ kind, entry: { ...entry } }));
			const canOwnReadyPlanTransition =
				deliverySnapshot.messages.some((message) => message.role === "user") &&
				(delivery.kind !== "prompt" || this._sessionPromptOwnsInitialDelivery) &&
				this._deliveryOwnsReadyPlanTransition(delivery.kind, queueEntries) &&
				this._planningState.plan?.phase === "ready";
			if (canOwnReadyPlanTransition && this._readyPlanTransitionDeliveryId === undefined) {
				this._readyPlanTransitionDeliveryId = delivery.deliveryId;
			}
			const readyPlan =
				canOwnReadyPlanTransition && this._readyPlanTransitionDeliveryId === delivery.deliveryId
					? this._planningState.plan
					: undefined;
			const nextPlanningState = readyPlan
				? parsePlanningState({
						mode: "plan",
						plan: {
							...readyPlan,
							revision: readyPlan.revision + 1,
							phase: "draft",
						},
					})
				: undefined;
			const checkpoint = nextPlanningState ? this._createPlanningCheckpointMessage(nextPlanningState) : undefined;
			const extensionMessages = cloneAgentMessages(deliverySnapshot.messages);
			const messages = checkpoint ? [checkpoint, ...extensionMessages] : extensionMessages;
			const participant: AgentDeliveryTransactionParticipant = {
				settle: async (context) =>
					await this._settleDeliveryParticipant({
						deliveryId: delivery.deliveryId,
						messages,
						queueEntries,
						upstream: prepared.participant,
						context,
						preparationError: deliverySnapshot.error,
						...(readyPlan && nextPlanningState ? { readyPlan, nextPlanningState } : {}),
					}),
			};
			return { messages, participant };
		};
		const nextAction = this.agent.nextAction;
		this.agent.nextAction = async (context, signal) => {
			this._assertConversationAuthorityAvailable();
			if (this._shouldStopForProactiveCompaction(context)) return { type: "stop" };
			return nextAction ? await nextAction(context, signal) : context.defaultAction;
		};
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			this._assertConversationAuthorityAvailable();
			if (!this.getActiveToolNames().includes(toolCall.name)) {
				return {
					block: true,
					reason:
						this._planningState.mode === "plan"
							? `The active research capability profile does not expose ${toolCall.name}.`
							: `Tool ${toolCall.name} is no longer active for this session.`,
				};
			}

			const runner = this._extensionRunner;
			let extensionDecision: { block?: boolean; reason?: string } | undefined;
			if (runner.hasHandlers("tool_call")) {
				try {
					extensionDecision = await runner.emitToolCall({
						type: "tool_call",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
					});
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
				if (extensionDecision?.block) {
					return extensionDecision;
				}
			}

			if (this._planningState.mode === "plan") {
				const decision = authorizeToolOperation(
					this._getTrustedOperationResolver(toolCall.name),
					args,
					RESEARCH_OPERATION_GRANT_PROFILE,
				);
				if (!decision.allowed) {
					return {
						block: true,
						reason: `The research capability profile blocked ${toolCall.name}: ${decision.reason ?? "operation denied"}.`,
					};
				}
				if (
					toolCall.name === "submit_plan" &&
					this._planResearchGeneration !== this._conversationGenerationRevision
				) {
					const researchToolAvailable = Array.from(this._toolRegistry.keys()).some((name) =>
						resolverCanProvideResearchEvidence(
							this._getTrustedOperationResolver(name),
							RESEARCH_OPERATION_GRANT_PROFILE,
						),
					);
					return {
						block: true,
						reason: researchToolAvailable
							? "Plan mode requires at least one successful read operation before submitting a plan."
							: "Plan mode requires research evidence before submitting, but this session exposes no research-capable tools, so submit_plan cannot succeed. Tell the user their host configuration disables every builtin read tool.",
					};
				}
				this._authorizedOperationResolutions.set(toolCall.id, decision.resolution);
			}
			return extensionDecision;
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			this._assertConversationAuthorityAvailable();
			const resolution = this._authorizedOperationResolutions.get(toolCall.id);
			this._authorizedOperationResolutions.delete(toolCall.id);
			if (
				!isError &&
				this._planningState.mode === "plan" &&
				resolution !== undefined &&
				operationProvidesResearchEvidence(resolution)
			) {
				this._planResearchGeneration = this._conversationGenerationRevision;
			}
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		if (this.sessionManager.getConversationAuthorityStatus().status !== "available") return;
		if (event.type === "tool_execution_end" || event.type === "agent_settled") {
			this.gitContextProvider.scheduleRefresh();
		}
		for (const listener of this._eventListeners) {
			listener(event);
		}
	}

	private _emitQueueUpdate(): void {
		if (this.sessionManager.getConversationAuthorityStatus().status !== "available") return;
		const event: AgentSessionEvent = {
			type: "queue_update",
			steering: this._steeringMessages.map((entry) => ({ ...entry })),
			followUp: this._followUpMessages.map((entry) => ({ ...entry })),
		};
		for (const listener of this._eventListeners) {
			try {
				listener(event);
			} catch {
				// Queue admission is already authoritative in the durable WAL and
				// agent core. A projection observer cannot roll it back or turn a
				// successful enqueue into a failed receipt.
			}
		}
	}

	private _emitClientInputOutcome(
		clientMessageId: string,
		outcome: "failed",
		reason: "queue_cleared" | "dispatch_failed",
	): void {
		if (this.sessionManager.getConversationAuthorityStatus().status !== "available") return;
		const event: AgentSessionEvent = { type: "client_input_outcome", clientMessageId, outcome, reason };
		for (const listener of this._eventListeners) {
			try {
				listener(event);
			} catch {
				// The durable receipt is already terminal. Projection delivery can
				// recover through replay/bootstrap and must never roll that back.
			}
		}
	}

	private _recoverDurableQueuedClientInputs(): void {
		const recovery = this.sessionManager.getClientInputRecoveryPlan();
		const records = recovery.records;
		this._recoveredClientInputReplayPending = recovery.kind !== "idle";
		if (records.length > AGENT_SESSION_MAX_QUEUED_MESSAGES) {
			throw new Error(
				`Recoverable client input queue exceeds the ${AGENT_SESSION_MAX_QUEUED_MESSAGES}-message limit`,
			);
		}
		for (const record of records) {
			const queuedInput = record.queuedInput;
			if (!queuedInput) continue;
			this._restoreQueuedClientInput(record.clientMessageId, queuedInput);
			const operation = this._createLiveClientInputOperation(record.command, record.semanticDigest);
			operation.queued = true;
			operation.resolveAccepted("admitted");
			this._liveClientInputs.set(record.clientMessageId, operation);
		}
	}

	private _ambiguousRecoveredClientInputError(clientMessageId: string): ClientInputOutcomeAmbiguousError {
		return new ClientInputOutcomeAmbiguousError(
			`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} crossed its durable dispatch boundary before restart but has no canonical or terminal record; later queued input remains fenced`,
		);
	}

	private _restoreQueuedClientInput(
		clientMessageId: string,
		queuedInput: { delivery: "steer" | "follow_up"; message: string; images: ImageContent[] },
	): void {
		const queueEntryId = createRuntimeQueueEntryId();
		const entry: AgentSessionQueuedMessage = {
			queueEntryId,
			clientMessageId,
			text: queuedInput.message,
		};
		const message = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: queuedInput.message },
				...queuedInput.images.map((image) => ({ ...image })),
			],
			clientMessageId: queueEntryId,
			timestamp: Date.now(),
		};
		if (queuedInput.delivery === "steer") {
			this._steeringMessages.push(entry);
			this._queueDeliveryIds.set(queueEntryId, this.agent.steer(message));
		} else {
			this._followUpMessages.push(entry);
			this._queueDeliveryIds.set(queueEntryId, this.agent.followUp(message));
		}
	}

	private _reconcileRecoveredClientInputOperations(records: readonly ClientInputRecord[]): void {
		const recoverableClientMessageIds = new Set(records.map((record) => record.clientMessageId));
		for (const [clientMessageId, operation] of this._liveClientInputs) {
			if (recoverableClientMessageIds.has(clientMessageId)) {
				operation.queued = true;
				continue;
			}
			// The recovery plan is the durable authority once replay has stopped.
			// In particular, a promoted receipt that reached `started` must not
			// remain as a pre-resolved `admitted` operation and outrank its durable
			// ambiguity fence on a same-ID retry.
			this._liveClientInputs.delete(clientMessageId);
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;
	/** True until the active Agent run reaches its terminal `agent_end` boundary. */
	private _agentConversationMutationInFlight = false;
	private _activeAgentRunId: string | undefined;
	private _persistedTerminalAgentRunId: string | undefined;
	private _sessionPromptOwnsInitialDelivery = false;

	private _normalizePreparedDeliveryMessages(messages: readonly AgentMessage[]): {
		messages: AgentMessage[];
		queueEntries: PreparedQueueEntry[];
	} {
		const queueEntries: PreparedQueueEntry[] = [];
		const normalizedMessages = messages.map((message) => {
			if (message.role !== "user" || message.clientMessageId === undefined) return message;
			const steering = this._steeringMessages.find((entry) => entry.queueEntryId === message.clientMessageId);
			const followUp = steering
				? undefined
				: this._followUpMessages.find((entry) => entry.queueEntryId === message.clientMessageId);
			const entry = steering ?? followUp;
			if (!entry) return message;
			if (!queueEntries.some((candidate) => candidate.entry.queueEntryId === entry.queueEntryId)) {
				queueEntries.push({ kind: steering ? "steer" : "followUp", entry });
			}
			const normalizedMessage = { ...message } as AgentMessage & { clientMessageId?: string };
			if (entry.clientMessageId === undefined) {
				delete normalizedMessage.clientMessageId;
			} else {
				normalizedMessage.clientMessageId = entry.clientMessageId;
			}
			return normalizedMessage;
		});
		return { messages: normalizedMessages, queueEntries };
	}

	private async _prepareDeliveryExtensionMessages(messages: readonly AgentMessage[]): Promise<{
		messages: AgentMessage[];
		error?: Error;
	}> {
		this._assertConversationAuthorityAvailable();
		if (!this._extensionRunner.hasHandlers("message_start") && !this._extensionRunner.hasHandlers("message_end")) {
			return { messages: [...messages] };
		}
		const prepared: AgentMessage[] = [];
		try {
			for (const message of messages) {
				await this._emitExtensionEvent({ type: "message_start", message });
				const replacement = await this._emitExtensionEvent({ type: "message_end", message });
				const identityPreservingReplacement =
					message.role === "user" && replacement?.role === "user" && message.clientMessageId !== undefined
						? { ...replacement, clientMessageId: message.clientMessageId }
						: replacement;
				prepared.push(identityPreservingReplacement ?? message);
			}
			return { messages: prepared };
		} catch (error) {
			return { messages: [...messages], error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	private _handleAgentDeliveryRevoked(delivery: AgentDelivery): void {
		this._preparingDeliveryExtensions.delete(delivery.deliveryId);
		this._preparedDeliveryExtensions.delete(delivery.deliveryId);
		this._releaseReadyPlanTransition(delivery.deliveryId);
		const queueEntries: PreparedQueueEntry[] = [];
		for (const entry of this._steeringMessages) {
			if (this._queueDeliveryIds.get(entry.queueEntryId) === delivery.deliveryId) {
				queueEntries.push({ kind: "steer", entry });
			}
		}
		for (const entry of this._followUpMessages) {
			if (this._queueDeliveryIds.get(entry.queueEntryId) === delivery.deliveryId) {
				queueEntries.push({ kind: "followUp", entry });
			}
		}
		const queueEntryIds = new Set(queueEntries.map(({ entry }) => entry.queueEntryId));
		const directClientMessageIds = delivery.messages.flatMap((message) =>
			message.role === "user" && message.clientMessageId !== undefined && !queueEntryIds.has(message.clientMessageId)
				? [message.clientMessageId]
				: [],
		);
		const revocationError = new Error("Delivery was revoked before canonical commitment");
		const settlement = (async () => {
			this._finishCommittedQueueEntries(queueEntries);
			for (const { entry } of queueEntries) {
				if (entry.clientMessageId === undefined) continue;
				const operation = this._liveClientInputs.get(entry.clientMessageId);
				if (!operation) continue;
				try {
					await this._failLiveClientInput(entry.clientMessageId, operation, revocationError);
				} catch (error) {
					this._agentEventFatalError ??= error instanceof Error ? error : new Error(String(error));
				}
			}
			for (const clientMessageId of directClientMessageIds) {
				const operation = this._liveClientInputs.get(clientMessageId);
				if (!operation) continue;
				try {
					if (this.sessionManager.getClientInput(clientMessageId)?.state === "started") {
						this.sessionManager.rollbackClientInput(clientMessageId);
						await this.sessionManager.flush();
					}
					operation.rejectAccepted(revocationError);
					operation.rejectCompletion(revocationError);
					this._liveClientInputs.delete(clientMessageId);
					this._agentEventFatalError ??= revocationError;
				} catch (error) {
					const terminalError = error instanceof Error ? error : new Error(String(error));
					await this._terminallyFailDelivery(delivery.messages, [], terminalError);
					this._agentEventFatalError ??= terminalError;
				}
			}
		})();
		this._deliveryRevocationSettlements.add(settlement);
		void settlement.finally(() => this._deliveryRevocationSettlements.delete(settlement));
	}

	private async _drainDeliveryRevocations(): Promise<void> {
		while (this._deliveryRevocationSettlements.size > 0) {
			await Promise.all([...this._deliveryRevocationSettlements]);
		}
	}

	private _clearAgentQueues(): string[] {
		this._agentDeliveryRevocationSuppressionDepth++;
		let revokedDeliveryIds: string[];
		try {
			revokedDeliveryIds = this.agent.clearAllQueues();
		} finally {
			this._agentDeliveryRevocationSuppressionDepth--;
		}
		if (this._agentDeliveryRevocationSuppressionDepth === 0) {
			const suppressed = [...this._suppressedAgentDeliveryRevocations.values()];
			this._suppressedAgentDeliveryRevocations.clear();
			revokedDeliveryIds = [
				...new Set([
					...revokedDeliveryIds,
					...suppressed.filter((delivery) => delivery.kind !== "prompt").map((delivery) => delivery.deliveryId),
				]),
			];
			for (const delivery of suppressed) {
				if (delivery.kind === "prompt") this._handleAgentDeliveryRevoked(delivery);
			}
		}
		for (const deliveryId of revokedDeliveryIds) {
			this._preparingDeliveryExtensions.delete(deliveryId);
			this._preparedDeliveryExtensions.delete(deliveryId);
			this._releaseReadyPlanTransition(deliveryId);
		}
		return revokedDeliveryIds;
	}

	private _releaseReadyPlanTransition(deliveryId: string): void {
		if (this._readyPlanTransitionDeliveryId === deliveryId) {
			this._readyPlanTransitionDeliveryId = undefined;
		}
	}

	private _completePreparedDelivery(deliveryId: string): void {
		this._preparedDeliveryExtensions.delete(deliveryId);
		this._releaseReadyPlanTransition(deliveryId);
	}

	private _hasRetainedDirectInput(clientMessageId: string): boolean {
		if (!this.agent.hasPendingPrompt()) return false;
		return [...this._preparedDeliveryExtensions.values()].some(({ messages }) =>
			messages.some((message) => message.role === "user" && message.clientMessageId === clientMessageId),
		);
	}

	private _deliveryOwnsReadyPlanTransition(
		kind: AgentDeliveryKind,
		queueEntries: readonly PreparedQueueEntry[],
	): boolean {
		if (kind === "prompt" || queueEntries.length === 0) return true;
		const first = kind === "steer" ? this._steeringMessages[0] : this._followUpMessages[0];
		return (
			first !== undefined && queueEntries.some((candidate) => candidate.entry.queueEntryId === first.queueEntryId)
		);
	}

	private async _settleDeliveryParticipant(input: {
		deliveryId: string;
		messages: readonly AgentMessage[];
		queueEntries: readonly PreparedQueueEntry[];
		upstream: AgentDeliveryTransactionParticipant | undefined;
		context: AgentDeliveryTransactionContext;
		preparationError?: Error;
		readyPlan?: PlanState;
		nextPlanningState?: PlanningState;
	}): Promise<AgentDeliveryParticipantOutcome> {
		let terminalOutcomeRequired = false;
		let planningPublished = false;
		try {
			if (input.preparationError) {
				const terminalError = await this._terminallyFailDelivery(
					input.messages,
					input.queueEntries,
					input.preparationError,
				);
				this._completePreparedDelivery(input.deliveryId);
				this._agentEventFatalError ??= terminalError;
				return { outcome: "terminally_failed", error: terminalError };
			}
			if (input.upstream) {
				const outcome = await input.upstream.settle(input.context);
				if (outcome.outcome === "retained") {
					return await this._settleRetainedDirectInput(input.messages, outcome.error);
				}
				if (outcome.outcome === "terminally_failed") {
					const terminalError = await this._terminallyFailDelivery(
						input.messages,
						input.queueEntries,
						outcome.error,
					);
					this._completePreparedDelivery(input.deliveryId);
					return { outcome: "terminally_failed", error: terminalError };
				}
				terminalOutcomeRequired = true;
			}

			if (input.readyPlan && input.nextPlanningState) {
				const current = this._planningState.plan;
				if (
					current?.phase !== "ready" ||
					current.id !== input.readyPlan.id ||
					current.revision !== input.readyPlan.revision
				) {
					throw new Error("Ready plan changed before delivery settlement");
				}
				try {
					await this.sessionManager.appendAtomically(
						() => {
							this.sessionManager.appendPlanningState(input.nextPlanningState!);
							this._startCommittedClientInputs(input.messages);
							for (const message of input.messages) {
								this._persistCommittedDeliveryMessage(message);
							}
						},
						() => {
							this._publishCommittedPlanningState(input.nextPlanningState!);
							planningPublished = true;
						},
					);
					terminalOutcomeRequired = true;
				} catch (error) {
					if (
						error instanceof SessionAtomicAppendError &&
						(error.authority === "reconciliation_required" ||
							error.effect === "uncertain" ||
							error.effect === "committed")
					) {
						terminalOutcomeRequired = true;
					}
					throw error;
				}
			} else {
				const boundaryAppended = this._startCommittedClientInputs(input.messages);
				if (boundaryAppended) {
					terminalOutcomeRequired = true;
					await this.sessionManager.flush();
				}
				for (const message of input.messages) {
					this._persistCommittedDeliveryMessage(message);
					terminalOutcomeRequired = true;
				}
				await this.sessionManager.flush();
			}

			if (input.nextPlanningState && !planningPublished) {
				this._publishCommittedPlanningState(input.nextPlanningState);
			}
			this._finishCommittedQueueEntries(input.queueEntries);
			for (const message of input.messages) {
				if (message.role === "user" && message.clientMessageId !== undefined) {
					this._completeLiveClientInput(message.clientMessageId, "admitted");
				}
			}
			this._completePreparedDelivery(input.deliveryId);
			return { outcome: "committed" };
		} catch (error) {
			const settlementError = error instanceof Error ? error : new Error(String(error));
			if (!terminalOutcomeRequired) {
				return await this._settleRetainedDirectInput(input.messages, settlementError);
			}
			const terminalError = await this._terminallyFailDelivery(input.messages, input.queueEntries, settlementError);
			this._completePreparedDelivery(input.deliveryId);
			return { outcome: "terminally_failed", error: terminalError };
		}
	}

	private async _settleRetainedDirectInput(
		messages: readonly AgentMessage[],
		error: Error,
	): Promise<AgentDeliveryParticipantOutcome> {
		const directInputs = messages.flatMap((message) => {
			if (message.role !== "user" || message.clientMessageId === undefined) return [];
			const operation = this._liveClientInputs.get(message.clientMessageId);
			return operation && !operation.queued ? [{ clientMessageId: message.clientMessageId, operation }] : [];
		});
		if (directInputs.length === 0) return { outcome: "retained", error };
		try {
			for (const { clientMessageId } of directInputs) {
				if (this.sessionManager.getClientInput(clientMessageId)?.state === "started") {
					this.sessionManager.rollbackClientInput(clientMessageId);
				}
			}
			await this.sessionManager.flush();
		} catch (rollbackError) {
			const terminalError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
			await this._terminallyFailDelivery(messages, [], terminalError);
			return { outcome: "terminally_failed", error: terminalError };
		}
		for (const { clientMessageId, operation } of directInputs) {
			operation.rejectAccepted(error);
			operation.rejectCompletion(error);
			this._liveClientInputs.delete(clientMessageId);
		}
		this._agentEventFatalError ??= error;
		return { outcome: "retained", error };
	}

	private async _terminallyFailDelivery(
		messages: readonly AgentMessage[],
		queueEntries: readonly PreparedQueueEntry[],
		error: Error,
	): Promise<Error> {
		let terminalError = error;
		for (const message of messages) {
			if (message.role !== "user" || message.clientMessageId === undefined) continue;
			const operation = this._liveClientInputs.get(message.clientMessageId);
			if (!operation) continue;
			try {
				await this._failLiveClientInput(message.clientMessageId, operation, terminalError);
			} catch (failureError) {
				terminalError = failureError instanceof Error ? failureError : new Error(String(failureError));
			}
		}
		this._finishCommittedQueueEntries(queueEntries);
		return terminalError;
	}

	private _startCommittedClientInputs(messages: readonly AgentMessage[]): boolean {
		let appended = false;
		for (const message of messages) {
			if (message.role !== "user" || message.clientMessageId === undefined) continue;
			const record = this.sessionManager.getClientInput(message.clientMessageId);
			if (record?.state !== "accepted") continue;
			this.sessionManager.transitionClientInput(message.clientMessageId, "started");
			appended = true;
		}
		return appended;
	}

	private _persistCommittedDeliveryMessage(message: AgentMessage): void {
		if (message.role === "custom") {
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			this.sessionManager.appendMessage(message);
		}
	}

	private _publishCommittedPlanningState(next: PlanningState): void {
		if (
			this._planningState.mode !== "plan" ||
			this._planResearchGeneration !== this._conversationGenerationRevision
		) {
			this._planResearchGeneration = undefined;
		}
		this._planningState = clonePlanningState(next);
		this._syncPlanningRuntime();
		this._emit({ type: "planning_state_changed", planning: clonePlanningState(this._planningState) });
	}

	private _finishCommittedQueueEntries(queueEntries: readonly PreparedQueueEntry[]): void {
		let changed = false;
		for (const { kind, entry } of queueEntries) {
			const queue = kind === "steer" ? this._steeringMessages : this._followUpMessages;
			const index = queue.findIndex((candidate) => candidate.queueEntryId === entry.queueEntryId);
			if (index !== -1) {
				queue.splice(index, 1);
				this._queueDeliveryIds.delete(entry.queueEntryId);
				changed = true;
			}
			if (entry.clientMessageId !== undefined) {
				const operation = this._liveClientInputs.get(entry.clientMessageId);
				if (operation) operation.queued = false;
			}
		}
		if (changed) this._emitQueueUpdate();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<AgentMessage | undefined> => {
		if (this._disposed) return undefined;
		if (event.type === "agent_start") {
			this._activeAgentRunId = this.agent.activeRunSnapshot?.runId;
			this._persistedTerminalAgentRunId = undefined;
		}
		if (event.type === "agent_end") {
			// All message/tool persistence for this run precedes agent_end. A branch
			// rebase may now proceed while post-run extension/compaction work winds
			// down; the captured run generation fences those continuations.
			this._agentConversationMutationInFlight = false;
			// Aborted tool calls can skip afterToolCall, leaving their plan-mode
			// authorization records behind; no record outlives its run.
			this._authorizedOperationResolutions.clear();
		}
		if (!this._isConversationAuthorityAvailable()) {
			// Agent may emit a synthetic transaction-failure message after the
			// persistence proof failed. It is runtime diagnostics, not a canonical
			// transcript commit, so do not expose it through message lifecycle events.
			return event.type === "message_end" ? event.message : undefined;
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user" && event.deliveryId === undefined) {
			this._overflowRecoveryAttempted = false;
			this._proactiveCompactionState = "idle";
			const queueEntryId = event.message.clientMessageId;
			if (queueEntryId !== undefined) {
				// Check steering queue first. Queue identity, never display text,
				// owns dequeue so duplicate messages cannot remove each other.
				const steeringIndex = this._steeringMessages.findIndex((entry) => entry.queueEntryId === queueEntryId);
				if (steeringIndex !== -1) {
					const entry = this._steeringMessages[steeringIndex]!;
					const operation = entry.clientMessageId ? this._liveClientInputs.get(entry.clientMessageId) : undefined;
					this._dequeuedQueueClientMessageIds.set(queueEntryId, entry.clientMessageId ?? null);
					try {
						await this._markClientInputDispatchStarted(entry.clientMessageId, operation);
					} catch (error) {
						const dispatchError = error instanceof Error ? error : new Error(String(error));
						this._fenceFailedQueuedDispatch(entry, operation, dispatchError);
						throw dispatchError;
					}
					if (
						this._disposed ||
						!this._steeringMessages.some((candidate) => candidate.queueEntryId === entry.queueEntryId) ||
						(entry.clientMessageId !== undefined &&
							(this._liveClientInputs.get(entry.clientMessageId) !== operation ||
								this.sessionManager.getClientInput(entry.clientMessageId)?.state === "failed"))
					) {
						this._dequeuedQueueClientMessageIds.delete(queueEntryId);
						this.agent.abort();
						return undefined;
					}
					this._startDequeuedClientInput(entry);
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.findIndex((entry) => entry.queueEntryId === queueEntryId);
					if (followUpIndex !== -1) {
						const entry = this._followUpMessages[followUpIndex]!;
						const operation = entry.clientMessageId
							? this._liveClientInputs.get(entry.clientMessageId)
							: undefined;
						this._dequeuedQueueClientMessageIds.set(queueEntryId, entry.clientMessageId ?? null);
						try {
							await this._markClientInputDispatchStarted(entry.clientMessageId, operation);
						} catch (error) {
							const dispatchError = error instanceof Error ? error : new Error(String(error));
							this._fenceFailedQueuedDispatch(entry, operation, dispatchError);
							throw dispatchError;
						}
						if (
							this._disposed ||
							!this._followUpMessages.some((candidate) => candidate.queueEntryId === entry.queueEntryId) ||
							(entry.clientMessageId !== undefined &&
								(this._liveClientInputs.get(entry.clientMessageId) !== operation ||
									this.sessionManager.getClientInput(entry.clientMessageId)?.state === "failed"))
						) {
							this._dequeuedQueueClientMessageIds.delete(queueEntryId);
							this.agent.abort();
							return undefined;
						}
						this._startDequeuedClientInput(entry);
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		let normalizedEvent = event;
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			event.deliveryId === undefined &&
			event.message.role === "user" &&
			event.message.clientMessageId !== undefined &&
			this._dequeuedQueueClientMessageIds.has(event.message.clientMessageId)
		) {
			const runtimeQueueEntryId = event.message.clientMessageId;
			const externalClientMessageId = this._dequeuedQueueClientMessageIds.get(runtimeQueueEntryId);
			const normalizedMessage = { ...event.message } as AgentMessage & { clientMessageId?: string };
			if (externalClientMessageId == null) {
				delete normalizedMessage.clientMessageId;
			} else {
				normalizedMessage.clientMessageId = externalClientMessageId;
			}
			normalizedEvent = { ...event, message: normalizedMessage } as AgentEvent;
			if (event.type === "message_end") {
				this._dequeuedQueueClientMessageIds.delete(runtimeQueueEntryId);
			}
		}
		if (
			normalizedEvent.type === "message_start" &&
			normalizedEvent.deliveryId === undefined &&
			normalizedEvent.message.role === "user" &&
			normalizedEvent.message.clientMessageId !== undefined
		) {
			await this._markClientInputDispatchStarted(
				normalizedEvent.message.clientMessageId,
				this._liveClientInputs.get(normalizedEvent.message.clientMessageId),
			);
			if (this._disposed) return undefined;
		}

		// Extensions can functionally replace a finalized message. Feed the
		// replacement back to agent-core so the current loop uses it for context,
		// tool execution, retry classification, and later lifecycle events.
		const isDeliveryProjection = "deliveryId" in normalizedEvent && normalizedEvent.deliveryId !== undefined;
		let replacement: AgentMessage | undefined;
		try {
			replacement = isDeliveryProjection ? undefined : await this._emitExtensionEvent(normalizedEvent);
			if (this._disposed) return undefined;
		} catch (error) {
			if (this._disposed) return undefined;
			let fatalError = error instanceof Error ? error : new Error(String(error));
			if (
				error instanceof ExtensionMessageRoleMismatchError &&
				normalizedEvent.type === "message_end" &&
				normalizedEvent.message.role === "user" &&
				normalizedEvent.message.clientMessageId !== undefined
			) {
				const clientMessageId = normalizedEvent.message.clientMessageId;
				const operation = this._liveClientInputs.get(clientMessageId);
				if (operation) {
					try {
						await this._failLiveClientInput(clientMessageId, operation, fatalError);
					} catch (transitionError) {
						fatalError = transitionError instanceof Error ? transitionError : new Error(String(transitionError));
					}
				}
			}
			if (error instanceof ExtensionMessageRoleMismatchError) {
				this._agentEventFatalError ??= fatalError;
			}
			throw fatalError;
		}
		const identityPreservingReplacement =
			normalizedEvent.type === "message_end" &&
			normalizedEvent.message.role === "user" &&
			replacement?.role === "user" &&
			normalizedEvent.message.clientMessageId !== undefined
				? { ...replacement, clientMessageId: normalizedEvent.message.clientMessageId }
				: replacement;
		const runSnapshot = this.agent.activeRunSnapshot;
		const normalizedAssistantMessage =
			normalizedEvent.type === "message_end" && normalizedEvent.message.role === "assistant"
				? normalizedEvent.message
				: undefined;
		const canonicalRuntimeAbort = normalizedAssistantMessage
			? (normalizedAssistantMessage.diagnostics?.find((diagnostic) => diagnostic.type === "runtime_abort") ??
				(normalizedAssistantMessage.stopReason !== "toolUse" &&
				this.agent.signal?.aborted &&
				runSnapshot?.source !== undefined &&
				runSnapshot.diagnosticTimestamp !== undefined
					? {
							type: "runtime_abort" as const,
							timestamp: runSnapshot.diagnosticTimestamp,
							details: { source: runSnapshot.source },
						}
					: undefined))
			: undefined;
		const replacementCandidate =
			identityPreservingReplacement ?? (canonicalRuntimeAbort ? normalizedAssistantMessage : undefined);
		const runtimePreservingReplacement =
			replacementCandidate?.role === "assistant" && canonicalRuntimeAbort
				? {
						...replacementCandidate,
						diagnostics: [
							...(replacementCandidate.diagnostics ?? []).filter(
								(diagnostic) => diagnostic.type !== "runtime_abort",
							),
							canonicalRuntimeAbort,
						],
					}
				: replacementCandidate;
		const handledEvent =
			normalizedEvent.type === "message_end" && runtimePreservingReplacement
				? { ...normalizedEvent, message: runtimePreservingReplacement }
				: normalizedEvent;

		if (!this._isConversationAuthorityAvailable()) {
			return handledEvent.type === "message_end" ? handledEvent.message : undefined;
		}

		// Notify all listeners
		this._emit(
			handledEvent.type === "agent_end"
				? { ...handledEvent, willRetry: this._willRetryAfterAgentEnd(handledEvent) }
				: handledEvent,
		);
		if (handledEvent.type === "delivery_start") {
			const userMessage = handledEvent.messages.find((message) => message.role === "user");
			if (userMessage) {
				this._maybeGenerateSessionName(
					this._extractUserMessageText(userMessage.content),
					this._captureConversationGenerationAssertion(),
				);
			}
		}

		if (this._disposed) return undefined;

		// Handle session persistence
		if (handledEvent.type === "message_end") {
			if (handledEvent.deliveryId !== undefined) {
				return handledEvent.message;
			}
			// Check if this is a custom message from extensions
			if (handledEvent.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					handledEvent.message.customType,
					handledEvent.message.content,
					handledEvent.message.display,
					handledEvent.message.details,
				);
			} else if (
				handledEvent.message.role === "user" ||
				handledEvent.message.role === "assistant" ||
				handledEvent.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(handledEvent.message);
				if (
					handledEvent.message.role === "assistant" &&
					handledEvent.message.stopReason !== "toolUse" &&
					this._activeAgentRunId
				) {
					this._persistedTerminalAgentRunId = this._activeAgentRunId;
				}
			}
			if (handledEvent.message.role === "user" && handledEvent.message.clientMessageId !== undefined) {
				await this.sessionManager.flush();
				this._completeLiveClientInput(handledEvent.message.clientMessageId, "admitted");
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (handledEvent.message.role === "assistant") {
				this._lastAssistantMessage = handledEvent.message;

				const assistantMsg = handledEvent.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry state immediately when the retry response completes.
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this._settleRetry(true);
				} else if (assistantMsg.stopReason === "aborted") {
					this._settleRetry(false, "Retry cancelled");
				}
			}
			return handledEvent.message;
		}
	};

	private _fenceFailedQueuedDispatch(
		entry: AgentSessionQueuedMessage,
		operation: LiveClientInputOperation | undefined,
		error: Error,
	): void {
		this._dequeuedQueueClientMessageIds.delete(entry.queueEntryId);
		const steeringIndex = this._steeringMessages.findIndex(
			(candidate) => candidate.queueEntryId === entry.queueEntryId,
		);
		if (steeringIndex !== -1) {
			this._steeringMessages.splice(steeringIndex, 1);
		}
		const followUpIndex = this._followUpMessages.findIndex(
			(candidate) => candidate.queueEntryId === entry.queueEntryId,
		);
		if (followUpIndex !== -1) {
			this._followUpMessages.splice(followUpIndex, 1);
		}
		if (
			entry.clientMessageId !== undefined &&
			operation !== undefined &&
			this._liveClientInputs.get(entry.clientMessageId) === operation
		) {
			operation.queued = false;
			operation.rejectAccepted(error);
			operation.rejectCompletion(error);
			this._liveClientInputs.delete(entry.clientMessageId);
		}
		this._emitQueueUpdate();
		this.agent.abort();
	}

	private _startDequeuedClientInput(entry: AgentSessionQueuedMessage): void {
		const clientMessageId = entry.clientMessageId;
		if (clientMessageId === undefined) return;
		// A dequeued input stays durably recoverable until its canonical identified
		// user append. Only clearQueue's still-owned entries may become failed.
		const operation = this._liveClientInputs.get(clientMessageId);
		if (operation) operation.queued = false;
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				if (message.diagnostics?.some((diagnostic) => diagnostic.type === "delivery_transaction_failure")) {
					return false;
				}
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _settleRetry(success: boolean, finalError?: string): void {
		if (this._retryAttempt === 0) {
			return;
		}
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success,
			attempt,
			...(finalError ? { finalError } : {}),
		});
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<AgentMessage | undefined> {
		this._assertConversationAuthorityAvailable();
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			return replacement;
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
		return undefined;
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener, options: { monitorGitContext?: boolean } = {}): () => void {
		this._eventListeners.push(listener);
		const releaseGitObservation =
			options.monitorGitContext === false ? undefined : this.gitContextProvider.retainObservation();
		if (releaseGitObservation) this._eventListenerGitObservations.add(releaseGitObservation);
		let unsubscribed = false;

		// Return unsubscribe function for this specific listener
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
			if (releaseGitObservation) {
				this._eventListenerGitObservations.delete(releaseGitObservation);
				releaseGitObservation();
			}
		};
	}

	/**
	 * Observe conversation-generation commits such as tree navigation.
	 *
	 * The callback runs synchronously after both the SessionManager branch and
	 * Agent message context have been rebuilt, giving snapshot consumers one
	 * atomic read boundary for the new generation.
	 */
	subscribeConversationGenerationChanges(listener: ConversationGenerationListener): () => void {
		this._conversationGenerationListeners.add(listener);
		return () => {
			this._conversationGenerationListeners.delete(listener);
		};
	}

	/** Monotonic capability generation for branch-sensitive host mutations. */
	get conversationGenerationRevision(): number {
		return this._conversationGenerationRevision;
	}

	private _notifyConversationGenerationChange(change: ConversationGenerationChange): void {
		if (change.previousLeafId === change.nextLeafId) {
			return;
		}
		for (const listener of this._conversationGenerationListeners) {
			try {
				listener(change);
			} catch {
				// The branch and Agent context are already authoritative. A projection
				// observer cannot make a committed navigation appear to have failed.
			}
		}
	}

	/** Capture a branch-local mutation lease, optionally layered over transport authority. */
	private _captureConversationGenerationAssertion(assertExternalAuthorityCurrent?: () => void): () => void {
		const expectedRevision = this._conversationGenerationRevision;
		return () => {
			this._assertConversationAuthorityAvailable();
			// Keep the transport's stable stale-authority error when one is available.
			assertExternalAuthorityCurrent?.();
			if (this._conversationGenerationRevision !== expectedRevision) {
				throw new Error("Conversation generation changed during a branch-local mutation");
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._disposed || this._unsubscribeAgent) return; // Disposed or already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(source: AgentAbortSource = "disposal"): Promise<void> {
		return this._dispose(source, false);
	}

	/** Retire a generation whose recorded reconciliation failure is already authoritative. */
	disposeForSessionReplacement(): Promise<void> {
		return this._dispose("session_replacement", true);
	}

	private _dispose(source: AgentAbortSource, acceptReconciliationRequired: boolean): Promise<void> {
		if (this._disposePromise) {
			return this._disposePromise;
		}
		const deliverySettlement = this.agent.activeDeliverySettlement;
		if (deliverySettlement) {
			this._disposePromise = deliverySettlement.then(() => {
				this._disposePromise = undefined;
				return this._dispose(source, acceptReconciliationRequired);
			});
			return this._disposePromise;
		}
		const runBeforeAbort = this.agent.activeRunSnapshot;
		const abortAcceptance = this.agent.abort(source);
		const runAfterAbort = this.agent.activeRunSnapshot;
		this._disposed = true;

		try {
			// Persist terminal markers for in-flight tool calls before disconnecting.
			this._persistAbortedResultsForDanglingToolCalls();
			this._persistDisposalAbortMarker(runBeforeAbort, runAfterAbort, abortAcceptance.accepted);
			// Bash results completed during a turn were intentionally deferred for
			// transcript ordering. Place them after synthesized tool results before
			// sealing the final persistence watermark.
			this._flushPendingBashMessages();
		} catch {
			// Persistence failures are reflected by the final drain promise.
		}
		this._dequeuedQueueClientMessageIds.clear();
		const disposalError = new Error("Session disposed before client input completed");
		for (const operation of this._liveClientInputs.values()) {
			operation.rejectAccepted(disposalError);
			operation.rejectCompletion(disposalError);
		}
		this._liveClientInputs.clear();
		const persistenceDrain = acceptReconciliationRequired
			? this.sessionManager.drainPersistence().then(() => undefined)
			: this.sessionManager.closePersistence();
		let subagentDrain: Promise<void>;
		let mcpDrain: Promise<void>;
		try {
			subagentDrain = this._subagentToolManager?.dispose?.() ?? Promise.resolve();
		} catch (error) {
			subagentDrain = Promise.reject(error);
		}
		try {
			mcpDrain = this._mcpManager?.dispose() ?? Promise.resolve();
		} catch (error) {
			mcpDrain = Promise.reject(error);
		}
		this._disposePromise = Promise.allSettled([persistenceDrain, subagentDrain, mcpDrain]).then((results) => {
			const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (rejected) throw rejected.reason;
		});

		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			// Drain queued steering/follow-up messages so a run that settles after
			// dispose cannot restart via the queued-message continuation path.
			this._clearAgentQueues();
			this._preparingDeliveryExtensions.clear();
			this._preparedDeliveryExtensions.clear();
			this._readyPlanTransitionDeliveryId = undefined;
			this._lspManager?.dispose();
			this._unsubscribeMcpManager?.();
			this._unsubscribeMcpManager = undefined;
		} catch {
			// Dispose must continue even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		// Unsubscribe the extension error listener: it may be wired to a live
		// transport (RPC extension_error stream), and this session's generation
		// must not surface anything there after dispose.
		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = undefined;
		// Detach the Agent's payload/context hooks from this generation's runner.
		// Guarded so a replacement generation's runner is never cleared.
		if (this._extensionRunnerRef?.current === this._extensionRunner) {
			this._extensionRunnerRef.current = undefined;
		}
		this._disconnectFromAgent();
		this._unsubscribeGitContext?.();
		this._unsubscribeGitContext = undefined;
		for (const releaseObservation of this._eventListenerGitObservations) releaseObservation();
		this._eventListenerGitObservations.clear();
		this.gitContextProvider.dispose();
		this._eventListeners = [];
		this._conversationGenerationListeners.clear();
		cleanupSessionResources(this.sessionId);
		this._disposePromise ??= this.sessionManager.flush();
		return this._disposePromise;
	}

	private _persistDisposalAbortMarker(
		before: AgentRunSnapshot | undefined,
		after: AgentRunSnapshot | undefined,
		abortAccepted: boolean,
	): void {
		if (
			!before?.requestAccepted ||
			!abortAccepted ||
			!after ||
			after.runId !== before.runId ||
			this._persistedTerminalAgentRunId === before.runId ||
			after.source === undefined ||
			after.diagnosticTimestamp === undefined
		) {
			return;
		}
		const model = this.model ?? this.agent.state.model;
		const marker: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
			diagnostics: [
				{
					type: "runtime_abort",
					timestamp: after.diagnosticTimestamp,
					details: { source: after.source },
				},
			],
		};
		this.sessionManager.appendMessage(marker);
		this._persistedTerminalAgentRunId = before.runId;
	}

	/**
	 * Append an aborted toolResult for every persisted toolCall on the current
	 * session path that has no persisted result, so a transcript closed mid-call
	 * resumes coherently instead of with a dangling call. Persistence-only: no
	 * events are emitted (dispose is tearing the listeners down), and the agent
	 * loop's own late aborted results are dropped by the _disposed guard.
	 */
	private _persistAbortedResultsForDanglingToolCalls(): void {
		if (!this.isBusy) {
			return;
		}
		try {
			const context = this.sessionManager.buildSessionContext();
			const resolvedToolCallIds = new Set<string>();
			for (const message of context.messages) {
				if (message.role === "toolResult") {
					resolvedToolCallIds.add(message.toolCallId);
				}
			}
			for (const message of context.messages) {
				if (message.role !== "assistant") {
					continue;
				}
				const toolCalls = (message as AssistantMessage).content.filter(
					(block): block is ToolCall => block.type === "toolCall",
				);
				for (const toolCall of toolCalls) {
					if (resolvedToolCallIds.has(toolCall.id)) {
						continue;
					}
					const details = this._subagentDetailsForAbortedCall(toolCall);
					const abortedResult: ToolResultMessage = {
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [
							{ type: "text", text: "Operation aborted: the session closed before this tool call completed." },
						],
						...(details ? { details } : {}),
						isError: true,
						timestamp: Date.now(),
					};
					this.sessionManager.appendMessage(abortedResult);
				}
			}
		} catch {
			// Best-effort: a persistence failure must not block dispose.
		}
	}

	/**
	 * One-shot per session lifetime (issue #129, design §4): the first model
	 * turn after a reload surfaces completed-but-unclaimed subagent results
	 * recovered by registry hydration as one compact context message, injected
	 * into live agent state so the model sees it this turn. Deduplication is
	 * durable — the notice is itself a persisted custom message listing the
	 * offered run ids, so a later restart never re-offers them even though
	 * in-memory claim state does not survive (a run claimed without ever being
	 * offered can therefore be offered once after another restart — a benign
	 * duplicate). The reverse skew also exists: a persisted notice whose turn
	 * was fence-canceled, or that the user immediately branched away from,
	 * records its ids as offered without the model acting on them — those runs
	 * stay visible through registry list and the spawn-confirmation preflight.
	 */
	private async _maybeAppendSubagentRecoveryNotice(): Promise<void> {
		if (this._subagentRecoveryNoticeDone) {
			return;
		}
		const manager = this._subagentToolManager;
		if (typeof manager?.ensureRegistryHydrated !== "function" || typeof manager.listDelegations !== "function") {
			this._subagentRecoveryNoticeDone = true;
			return;
		}
		// Child runtimes share the root registry: recovered root work must not
		// leak a false notice (with root-only follow syntax) into a child's
		// fresh transcript.
		if (manager.isSubagentRuntime?.() === true) {
			this._subagentRecoveryNoticeDone = true;
			return;
		}
		// The offer is only actionable while the subagent tool is active; with
		// it excluded (tool policy, no definitions) nothing is persisted, so
		// the burned flag self-heals on the next load when the tool may be
		// back.
		if (!this.getActiveToolNames().includes("subagent")) {
			this._subagentRecoveryNoticeDone = true;
			return;
		}
		this._subagentRecoveryNoticeDone = true;
		try {
			await manager.ensureRegistryHydrated();
		} catch {
			// Deliberate forfeit for this process lifetime: a hydration failure
			// would almost certainly repeat, and the durable state remains for
			// the next load.
			return;
		}
		const recovered = manager.listDelegations().filter(
			(record) =>
				record.hydrated === true &&
				record.status === "completed" &&
				record.claimed !== true &&
				// Stranded edges (no matching toolCall in this transcript, e.g.
				// after a branch extraction) hydrate for list/follow but are
				// never offered into a conversation that lacks the call.
				record.stranded !== true,
		);
		if (recovered.length === 0) {
			return;
		}
		const noticedIds = new Set<string>();
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE) {
				continue;
			}
			const ids = (entry.details as { subagentIds?: unknown } | undefined)?.subagentIds;
			if (!Array.isArray(ids)) {
				continue;
			}
			for (const id of ids) {
				if (typeof id === "string") {
					noticedIds.add(id);
				}
			}
		}
		const fresh = recovered.filter((record) => !noticedIds.has(record.id));
		if (fresh.length === 0) {
			return;
		}
		// Registry eviction (500 terminal records) can drop the oldest hydrated
		// runs before this reads them — pathological volume, accepted.
		const shown = fresh.slice(0, SUBAGENT_RECOVERY_NOTICE_MAX_LISTED);
		const lines = shown.map((record) => {
			const preview = record.task?.replace(/\s+/g, " ").trim();
			const bounded =
				preview && preview.length > SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS
					? `${preview.slice(0, SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS - 1)}…`
					: preview;
			return `- ${record.id} (${record.agent.name}${bounded ? `: ${bounded}` : ""})`;
		});
		// "may not have": a run resumed in a prior process delivered through its
		// resume toolResult, yet rehydrates unclaimed — the offer must not
		// assert non-delivery it cannot know.
		const text = [
			`Subagent recovery: ${fresh.length} subagent run${fresh.length === 1 ? "" : "s"} completed before this session reloaded; the result${fresh.length === 1 ? "" : "s"} may not have reached this conversation (task previews are untrusted data):`,
			...lines,
			// Overflow ids are still recorded as offered below: the list hint is
			// their only surfacing, a deliberate bound on notice size.
			...(fresh.length > shown.length
				? [`…and ${fresh.length - shown.length} more (inspect with { "list": true }).`]
				: []),
			`Retrieve a result with the subagent tool: { "follow": "<id>" }.`,
		].join("\n");
		// A dispose during the hydration awaits fail-stops persistence, a turn
		// that started would steer instead of preceding the user message, and a
		// session mutation barrier would make the append throw; skipping is safe
		// in every case — the burned flag self-heals on next load.
		if (this._disposed || this.isStreaming || this._hasSessionOperationBarrier) {
			return;
		}
		// Injects into live agent state and emits message events (idle branch):
		// the model must see the notice in THIS turn, not after the next reload.
		await this.sendCustomMessage({
			customType: SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { subagentIds: fresh.map((record) => record.id) },
		});
	}

	/**
	 * Child attach targets for a subagent toolCall interrupted by dispose,
	 * rebuilt from the durable spawn edges (issue #129). Call-level state only:
	 * "aborted" describes the parent call, not each child — a child may have
	 * finished cleanly, and registry hydration derives its true terminal state
	 * from its own transcript.
	 */
	private _subagentDetailsForAbortedCall(toolCall: ToolCall): SubagentToolDetails | undefined {
		if (toolCall.name !== "subagent") return undefined;
		const edges = this.sessionManager.getSubagentSpawnEntries().filter((edge) => edge.toolCallId === toolCall.id);
		if (edges.length === 0) return undefined;
		const mode: SubagentToolMode = Array.isArray(toolCall.arguments.tasks)
			? "parallel"
			: Array.isArray(toolCall.arguments.chain)
				? "chain"
				: "single";
		return {
			mode,
			status: "aborted",
			childSessions: edges.map((edge, index) => ({
				index,
				subagentId: edge.subagentId,
				sessionId: edge.childSessionId,
				agent: { name: edge.agent },
				status: "aborted",
			})),
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		this._assertConversationAuthorityAvailable();
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the branch-local Fast mode policy is enabled. */
	get fastModeEnabled(): boolean {
		return this._fastModeEnabled;
	}

	get agentMode(): AgentMode {
		this._assertConversationAuthorityAvailable();
		return this._planningState.mode;
	}

	get planningState(): PlanningState {
		this._assertConversationAuthorityAvailable();
		return clonePlanningState(this._planningState);
	}

	getPlanningState(): PlanningState {
		return this.planningState;
	}

	flushPlanningState(): Promise<void> {
		return this.sessionManager.flush();
	}

	/** Whether the session is processing a response or a session-level continuation. */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this._activePromptRuns.size > 0;
	}

	/** Whether any tracked prompt or standalone session operation is still active. */
	get isBusy(): boolean {
		return this.isStreaming || this._activePromptTransactions.size > 0 || this._activeSessionOperations.size > 0;
	}

	private get _hasSessionOperationBarrier(): boolean {
		return (
			this._reloadInProgress || this._manualCompactionAdmissionInProgress || this._activeSessionOperations.size > 0
		);
	}

	/**
	 * Whether pre-provider input or an asynchronous session mutation can still
	 * commit against the current SessionManager. Identified extension command
	 * transactions are excluded because they are the control path that may
	 * intentionally initiate runtime replacement; their contexts are invalidated
	 * at replacement commit.
	 */
	get hasActiveSessionMutation(): boolean {
		const hasNonCommandPromptTransaction = [...this._activePromptTransactions.keys()].some(
			(transactionId) => !this._extensionCommandTransactions.has(transactionId),
		);
		return this._hasSessionOperationBarrier || hasNonCommandPromptTransaction;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/**
	 * Append fixed context to this session's base system prompt.
	 * Used by subagent runtimes to apply a selected definition before any turns run.
	 */
	appendSystemPromptContext(context: string): void {
		this._assertConversationAuthorityAvailable();
		const trimmed = context.trim();
		if (!trimmed) {
			return;
		}
		this._baseSystemPrompt = [this._baseSystemPrompt, trimmed].filter(Boolean).join("\n\n");
		this._applyTrustedPlanningInstructionsToSystemPrompt();
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	getSubagentToolManager(): SubagentToolManager | undefined {
		this._assertConversationAuthorityAvailable();
		return this._subagentToolManager;
	}

	async disposeSubagentToolManager(): Promise<void> {
		await this._subagentToolManager?.dispose?.();
	}

	getMcpManager(): McpManager | undefined {
		this._assertConversationAuthorityAvailable();
		return this._mcpManager;
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values())
			.filter(({ definition }) => this._isToolVisibleToCurrentMode(definition.name))
			.map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo,
			}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		if (!this._isToolVisibleToCurrentMode(name)) {
			return undefined;
		}
		return this._toolDefinitions.get(name)?.definition;
	}

	private _getTrustedOperationResolver(name: string): ToolOperationResolver | undefined {
		const source = this._toolDefinitions.get(name)?.sourceInfo;
		if (source?.source !== "builtin" || !this._trustedHostToolNames.has(name)) {
			return undefined;
		}
		return getTrustedToolOperationResolver(name, {
			...(this._mcpManager ? { integrationReadAuthority: this._mcpManager } : {}),
		});
	}

	private _isToolAvailableToCurrentModel(name: string): boolean {
		return name !== "image_gen" || isCodexImageGenerationModel(this.model);
	}

	private _isToolVisibleToCurrentMode(name: string): boolean {
		if (!this._isToolAvailableToCurrentModel(name)) {
			return false;
		}
		if (this._planningState.mode === "plan" || NATIVE_PLAN_TOOL_NAMES.has(name)) {
			return this.getActiveToolNames().includes(name);
		}
		return true;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this._assertConversationAuthorityAvailable();
		if (this._planningRuntimeInitialized) {
			this._requestedBuildToolNames = [...new Set(toolNames.filter((name) => !NATIVE_PLAN_TOOL_NAMES.has(name)))];
			this._syncPlanningRuntime();
			return;
		}
		this._setEffectiveToolsByName(toolNames);
	}

	private _setEffectiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool && this._isToolAvailableToCurrentModel(name)) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private _syncPlanningRuntime(): void {
		if (!this._planningRuntimeInitialized) {
			return;
		}
		const effective = [
			...new Set(
				this._planningState.mode === "plan"
					? Array.from(this._toolRegistry.keys()).filter((name) =>
							isToolVisibleUnderGrant(this._getTrustedOperationResolver(name), RESEARCH_OPERATION_GRANT_PROFILE),
						)
					: this._planningState.plan?.phase === "active"
						? [...this._requestedBuildToolNames, "update_plan_progress", "request_replan"]
						: [...this._requestedBuildToolNames],
			),
		];
		const availableEffective = effective.filter(
			(name) => this._toolRegistry.has(name) && this._isToolAvailableToCurrentModel(name),
		);
		const active = this.getActiveToolNames();
		if (
			active.length !== availableEffective.length ||
			active.some((name, index) => name !== availableEffective[index])
		) {
			this._setEffectiveToolsByName(effective);
		}
		this._applyTrustedPlanningInstructionsToSystemPrompt();
	}

	private async _prepareUnrestrictedMcpForBuild(): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (!this._mcpManager) {
			return;
		}
		await this._mcpManager.startEagerServers();
		const previousDirectToolNames = this._directMcpToolNames;
		const directDefinitions = createMcpDirectToolDefinitions(this._mcpManager);
		for (const name of previousDirectToolNames) {
			this._baseToolDefinitions.delete(name);
		}
		for (const definition of directDefinitions) {
			this._baseToolDefinitions.set(definition.name, definition as ToolDefinition);
		}
		this._directMcpToolNames = new Set(directDefinitions.map((definition) => definition.name));

		const previouslyRequestedDirectTools = new Set(
			this._requestedBuildToolNames.filter((name) => previousDirectToolNames.has(name)),
		);
		const requestedBuildTools = this._requestedBuildToolNames.filter((name) => !previousDirectToolNames.has(name));
		for (const definition of directDefinitions) {
			const wasPreviouslyAvailable = previousDirectToolNames.has(definition.name);
			if (
				wasPreviouslyAvailable
					? previouslyRequestedDirectTools.has(definition.name)
					: (this._allowedToolNames === undefined || this._allowedToolNames.has(definition.name)) &&
						!this._excludedToolNames?.has(definition.name)
			) {
				requestedBuildTools.push(definition.name);
			}
		}
		const requestedBuildToolNames = [...new Set(requestedBuildTools)];
		this._refreshToolRegistry({ activeToolNames: requestedBuildToolNames });
		this.setActiveToolsByName(requestedBuildToolNames.filter((name) => this._toolRegistry.has(name)));
	}

	private _applyTrustedPlanningInstructionsToSystemPrompt(systemPrompt = this._baseSystemPrompt): void {
		const policy = formatPlanPolicy(this._planningState.mode, this._planningState.plan?.phase);
		const next = policy ? [systemPrompt, policy].filter(Boolean).join("\n\n") : systemPrompt;
		if (this.agent.state.systemPrompt !== next) {
			this.agent.state.systemPrompt = next;
		}
	}

	private _planningStateNeedsCheckpoint(state: PlanningState): boolean {
		return state.plan !== null && (state.mode === "plan" || state.plan.phase === "active");
	}

	private _appendPlanningCheckpointEntry(state: PlanningState): boolean {
		if (!this._planningStateNeedsCheckpoint(state)) return false;
		const content = formatPlanCheckpoint(state);
		if (!content) return false;
		this.sessionManager.appendCustomMessageEntry(PLAN_CHECKPOINT_CUSTOM_TYPE, content, false, undefined);
		return true;
	}

	private _createPlanningCheckpointMessage(state: PlanningState): CustomMessage | undefined {
		if (!this._planningStateNeedsCheckpoint(state)) return undefined;
		const content = formatPlanCheckpoint(state);
		if (!content) return undefined;
		return {
			role: "custom",
			customType: PLAN_CHECKPOINT_CUSTOM_TYPE,
			content,
			display: false,
			details: undefined,
			timestamp: Date.now(),
		};
	}

	private _deliverPlanningCheckpoint(state: PlanningState): void {
		const message = this._createPlanningCheckpointMessage(state);
		if (!message) return;
		if (this.isStreaming) {
			this.agent.steer(message);
			return;
		}
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _commitPlanningState(next: PlanningState): PlanningState {
		this._assertConversationAuthorityAvailable();
		const parsed = parsePlanningState(next);
		this.sessionManager.appendPlanningState(parsed);
		this._planningState = clonePlanningState(parsed);
		this._syncPlanningRuntime();
		const snapshot = clonePlanningState(this._planningState);
		this._emit({ type: "planning_state_changed", planning: snapshot });
		return snapshot;
	}

	private _draftFromExecutedPlan(plan: PlanState): PlanState {
		return {
			id: plan.id,
			revision: plan.revision + 1,
			phase: "draft",
			...(plan.title ? { title: plan.title } : {}),
			...(plan.summary ? { summary: plan.summary } : {}),
			steps: plan.steps.map((step) => ({ ...step })),
		};
	}

	/**
	 * Queued transitions may suspend at an await (MCP restoration) while the
	 * event loop keeps running, so they must re-validate planning state after
	 * every await before committing, and the synchronous mutators refuse to
	 * commit while a queued transition is suspended mid-flight.
	 */
	private _enqueuePlanningTransition<T>(transition: () => Promise<T>): Promise<T> {
		this._assertConversationAuthorityAvailable();
		const result = this._planningTransitionQueue.then(async () => {
			this._assertConversationAuthorityAvailable();
			this._planningTransitionInFlight = true;
			try {
				return await transition();
			} finally {
				this._planningTransitionInFlight = false;
			}
		});
		this._planningTransitionQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private _assertNoPlanningTransitionInFlight(action: string): void {
		this._assertConversationAuthorityAvailable();
		if (this._planningTransitionInFlight) {
			throw new Error(`${action} is unavailable while a planning transition is in progress; retry once it settles`);
		}
	}

	setAgentMode(mode: AgentMode): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._setAgentMode(mode));
	}

	private async _setAgentMode(mode: AgentMode): Promise<PlanningState> {
		if (mode === "build" && this._planningState.mode === "plan") {
			await this._prepareUnrestrictedMcpForBuild();
		}
		if (mode === this._planningState.mode) {
			return this.planningState;
		}
		const plan = this._planningState.plan;
		if (mode === "plan") {
			this._planResearchGeneration = undefined;
		}
		if (mode === "plan" && plan?.phase === "active") {
			const next = this._commitPlanningState({ mode, plan: this._draftFromExecutedPlan(plan) });
			this._deliverPlanningCheckpoint(next);
			return next;
		}
		if (mode === "plan" && (plan?.phase === "completed" || plan?.phase === "handed_off")) {
			return this._commitPlanningState({ mode, plan: null });
		}
		const next = this._commitPlanningState({ ...clonePlanningState(this._planningState), mode });
		if (mode === "plan" && next.plan?.phase === "draft") {
			this._deliverPlanningCheckpoint(next);
		}
		return next;
	}

	toggleAgentMode(): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._setAgentMode(this.agentMode === "plan" ? "build" : "plan"));
	}

	updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: Array<{ id?: string; text: string }>;
	}): PlanState {
		this._assertNoPlanningTransitionInFlight("update_plan");
		if (this._planningState.mode !== "plan") {
			throw new Error("update_plan is available only in Plan mode");
		}
		if (input.steps.length > 64) {
			throw new Error("Plans may contain at most 64 steps");
		}
		for (const step of input.steps) {
			if (!step.text.trim()) {
				throw new Error("Plan steps must have non-empty text");
			}
		}
		const previous = this._planningState.plan;
		if (previous) {
			if (previous.phase !== "draft") {
				throw new Error("Only a draft plan can be updated");
			}
			if (input.planId === undefined || input.expectedRevision === undefined) {
				throw new Error("Updating an existing plan requires planId and expectedRevision");
			}
			assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		} else if (input.planId !== undefined || input.expectedRevision !== undefined) {
			throw new Error("A new plan must not provide planId or expectedRevision");
		}
		const title = input.title?.trim() || previous?.title;
		const summary = input.summary?.trim() || previous?.summary;
		const steps = canonicalizePlanSteps(input.steps, previous ?? undefined);
		if (
			previous &&
			previous.title === title &&
			previous.summary === summary &&
			previous.steps.length === steps.length &&
			// Ids are deliberately ignored: identical text/status/note in the same
			// order is the same checklist, and rejecting it keeps a resend without
			// canonical ids from churning step ids and burning a revision.
			previous.steps.every((step, index) => {
				const next = steps[index];
				return (
					next !== undefined && step.text === next.text && step.status === next.status && step.note === next.note
				);
			})
		) {
			throw new Error("Plan update made no changes; continue research or submit the current draft");
		}
		const plan: PlanState = {
			id: previous?.id ?? randomUUID(),
			revision: (previous?.revision ?? 0) + 1,
			phase: "draft",
			...(title ? { title } : {}),
			...(summary ? { summary } : {}),
			steps,
		};
		this._commitPlanningState({ mode: "plan", plan });
		return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
	}

	updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): PlanState {
		this._assertNoPlanningTransitionInFlight("update_plan_progress");
		if (this._planningState.mode !== "build" || this._planningState.plan?.phase !== "active") {
			throw new Error("update_plan_progress is available only during approved plan execution");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (input.updates.length === 0) {
			throw new Error("At least one plan progress update is required");
		}
		const updates = new Map<string, { status: PlanStepStatus; note?: string }>();
		const knownIds = new Set(this._planningState.plan.steps.map((step) => step.id));
		for (const update of input.updates) {
			const id = update.id.trim();
			if (!id || !knownIds.has(id)) {
				throw new Error(`Plan progress references an unknown step id: ${update.id}`);
			}
			if (updates.has(id)) {
				throw new Error(`Plan progress duplicates step id: ${id}`);
			}
			updates.set(id, {
				status: update.status,
				...(update.note === undefined ? {} : { note: update.note }),
			});
		}
		const steps = this._planningState.plan.steps.map((step) => {
			const update = updates.get(step.id);
			if (!update) return { ...step };
			const note = update.note === undefined ? step.note : update.note.trim() || undefined;
			return {
				id: step.id,
				text: step.text,
				status: update.status,
				...(note ? { note } : {}),
			};
		});
		if (
			this._planningState.plan.steps.every((step, index) => {
				const next = steps[index];
				return next !== undefined && step.status === next.status && step.note === next.note;
			})
		) {
			throw new Error("Plan progress update made no changes");
		}
		const plan: PlanState = {
			...this._planningState.plan,
			revision: this._planningState.plan.revision + 1,
			phase: steps.every((step) => step.status === "completed") ? "completed" : "active",
			steps,
		};
		this._commitPlanningState({ mode: "build", plan });
		return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
	}

	requestReplan(input: { planId: string; expectedRevision: number; reason: string }): PlanningState {
		this._assertNoPlanningTransitionInFlight("request_replan");
		if (this._planningState.mode !== "build" || this._planningState.plan?.phase !== "active") {
			throw new Error("request_replan is available only during approved plan execution");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (!input.reason.trim()) {
			throw new Error("request_replan requires implementation evidence");
		}
		this._planResearchGeneration = undefined;
		return this._commitPlanningState({
			mode: "plan",
			plan: this._draftFromExecutedPlan(this._planningState.plan),
		});
	}

	submitPlan(input: { planId: string; expectedRevision: number; title: string; summary: string }): PlanState {
		this._assertNoPlanningTransitionInFlight("submit_plan");
		if (this._planningState.mode !== "plan") {
			throw new Error("submit_plan is available only in Plan mode");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (this._planningState.plan.phase !== "draft") {
			throw new Error("Only a draft plan can be submitted");
		}
		if (this._planningState.plan.steps.length === 0) {
			throw new Error("A plan must contain at least one checklist step");
		}
		if (!input.title.trim() || !input.summary.trim()) {
			throw new Error("A submitted plan requires a non-empty title and summary");
		}
		const plan: PlanState = {
			...this._planningState.plan,
			revision: this._planningState.plan.revision + 1,
			phase: "ready",
			title: input.title.trim(),
			summary: input.summary.trim(),
		};
		this._commitPlanningState({ mode: "plan", plan });
		return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
	}

	changePlan(planId: string, expectedRevision: number): PlanningState {
		return this._changeReadyPlanToDraft(planId, expectedRevision, true);
	}

	private _changeReadyPlanToDraft(
		planId: string,
		expectedRevision: number,
		deliverCheckpoint: boolean,
	): PlanningState {
		this._assertNoPlanningTransitionInFlight("changePlan");
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be changed");
		}
		// Only same-generation Plan feedback can reuse the successful read that
		// supported the ready plan. Build entry and branch navigation fail closed.
		if (
			this._planningState.mode !== "plan" ||
			this._planResearchGeneration !== this._conversationGenerationRevision
		) {
			this._planResearchGeneration = undefined;
		}
		const next = this._commitPlanningState({
			mode: "plan",
			plan: {
				...this._planningState.plan,
				revision: this._planningState.plan.revision + 1,
				phase: "draft",
			},
		});
		if (deliverCheckpoint) {
			this._deliverPlanningCheckpoint(next);
		}
		return next;
	}

	discardPlan(planId: string, expectedRevision: number): PlanningState {
		this._assertNoPlanningTransitionInFlight("discardPlan");
		assertPlanRevision(this._planningState, planId, expectedRevision);
		this._planResearchGeneration = undefined;
		return this._commitPlanningState({ mode: this._planningState.mode, plan: null });
	}

	activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		return this._enqueuePlanningTransition(() => this._activatePlan(planId, expectedRevision, execution));
	}

	private async _activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		let currentPlan = this._planningState.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		if (this._planningState.mode === "plan") {
			await this._prepareUnrestrictedMcpForBuild();
		}
		currentPlan = this._planningState.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		return {
			planning: this._commitPlanningState({
				mode: "build",
				plan: {
					...this._planningState.plan,
					revision: this._planningState.plan.revision + 1,
					phase: "active",
					execution,
				},
			}),
			activated: true,
		};
	}

	markPlanHandedOff(planId: string, expectedRevision: number, execution: PlanExecution): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._markPlanHandedOff(planId, expectedRevision, execution));
	}

	private async _markPlanHandedOff(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<PlanningState> {
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be handed off");
		}
		if (this._planningState.mode === "plan") {
			await this._prepareUnrestrictedMcpForBuild();
			assertPlanRevision(this._planningState, planId, expectedRevision);
			if (this._planningState.plan.phase !== "ready") {
				throw new Error("Only a ready plan can be handed off");
			}
		}
		return this._commitPlanningState({
			mode: "build",
			plan: {
				...this._planningState.plan,
				revision: this._planningState.plan.revision + 1,
				phase: "handed_off",
				execution,
			},
		});
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** Active context compaction metadata, if compaction is currently running. */
	get activeCompaction(): ActiveCompaction | undefined {
		return this._activeCompaction ? { ...this._activeCompaction } : undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		this._assertConversationAuthorityAvailable();
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._assertConversationAuthorityAvailable();
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	private async _beginClientInput(
		command: ClientInputCommand,
		message: string,
		images: ImageContent[] | undefined,
		clientMessageId: string | undefined,
		streamingBehavior?: "steer" | "followUp",
	): Promise<ClientInputAdmission> {
		if (clientMessageId === undefined) {
			return { kind: "none" };
		}
		const abortGeneration = this._abortGeneration;
		const input = {
			message,
			...(images === undefined ? {} : { images }),
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		};
		const semanticDigest = createClientInputSemanticDigest(command, input);
		const live = this._liveClientInputs.get(clientMessageId);
		if (live) {
			if (live.command !== command || live.semanticDigest !== semanticDigest) {
				throw new ClientInputConflictError(
					`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
				);
			}
			return { kind: "live", operation: live };
		}

		const reservation = this.sessionManager.reserveClientInput(clientMessageId, command, input);
		const record = reservation.record;
		if (record.command !== command || record.semanticDigest !== semanticDigest) {
			throw new ClientInputConflictError(
				`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
			);
		}
		if (record.state === "completed") {
			return { kind: "completed" };
		}
		if (record.state === "failed") {
			throw new Error(record.error ?? "client_input_failed: the original input failed before commit");
		}
		if (record.state === "started") {
			throw new ClientInputOutcomeAmbiguousError(
				`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} started before the host restarted but has no durable terminal record; it was not replayed`,
			);
		}

		// Accepted remains recoverable throughout abortable preflight. Immediate
		// and queued input complete only through their canonical identified user
		// append, so a daemon restart never guesses whether provider work began.
		const operation = this._createLiveClientInputOperation(command, semanticDigest, command === "prompt");
		this._liveClientInputs.set(clientMessageId, operation);
		try {
			// A newly accepted remote identity is not acknowledged until its receipt
			// and every earlier commit have reached the durable queue watermark.
			await this.sessionManager.flush();
			if (this._disposed) {
				throw new Error("Session disposed before client input admission completed");
			}
			if (abortGeneration !== this._abortGeneration) {
				throw new Error("Client input admission was aborted before its receipt became durable");
			}
		} catch (error) {
			if (this._liveClientInputs.get(clientMessageId) === operation) {
				this._liveClientInputs.delete(clientMessageId);
			}
			const persistenceError = error instanceof Error ? error : new Error(String(error));
			operation.rejectAccepted(persistenceError);
			operation.rejectCompletion(persistenceError);
			throw persistenceError;
		}
		return { kind: "start", operation };
	}

	private _createLiveClientInputOperation(
		command: ClientInputCommand,
		semanticDigest: string,
		completionPending = false,
	): LiveClientInputOperation {
		let resolveAccepted!: (outcome: PromptAdmissionOutcome) => void;
		let rejectAccepted!: (error: Error) => void;
		const accepted = new Promise<PromptAdmissionOutcome>((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		void accepted.catch(() => {});
		let resolveCompletion!: () => void;
		let rejectCompletionPromise!: (error: unknown) => void;
		const completion = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletionPromise = reject;
		});
		void completion.catch(() => {});
		let completionAttached = !completionPending;
		if (!completionPending) resolveCompletion();
		const operation: LiveClientInputOperation = {
			command,
			semanticDigest,
			accepted,
			acceptanceSettled: false,
			acceptedForDispatch: false,
			dispatchBoundaryPersisted: false,
			completion,
			attachCompletion(nextCompletion) {
				if (completionAttached) return;
				completionAttached = true;
				void nextCompletion.then(resolveCompletion, rejectCompletionPromise);
			},
			rejectCompletion(error) {
				rejectCompletionPromise(error);
			},
			queued: false,
			resolveAccepted(outcome) {
				if (operation.acceptanceSettled) return;
				operation.acceptanceSettled = true;
				operation.acceptedForDispatch = true;
				resolveAccepted(outcome);
			},
			rejectAccepted(error) {
				if (operation.acceptanceSettled) return;
				operation.acceptanceSettled = true;
				rejectAccepted(error);
			},
		};
		return operation;
	}

	private async _failLiveClientInput(
		clientMessageId: string,
		operation: LiveClientInputOperation,
		error: Error,
		reason: "queue_cleared" | "dispatch_failed" = "dispatch_failed",
	): Promise<void> {
		const current = this._liveClientInputs.get(clientMessageId);
		if (current !== operation) return;
		const admissionWasAcknowledged = operation.acceptanceSettled;
		let reportedError = error;
		let terminalPersisted = false;
		try {
			const record = this.sessionManager.transitionClientInput(clientMessageId, "failed", error.message);
			await this.sessionManager.flush();
			terminalPersisted = record.state === "failed";
		} catch (transitionError) {
			reportedError =
				transitionError instanceof Error
					? transitionError
					: new Error(`Failed to persist client input failure: ${transitionError}`);
		}
		operation.rejectAccepted(reportedError);
		this._liveClientInputs.delete(clientMessageId);
		if (terminalPersisted && admissionWasAcknowledged) {
			this._emitClientInputOutcome(clientMessageId, "failed", reason);
		}
		if (reportedError !== error) {
			throw reportedError;
		}
	}

	private _completeLiveClientInput(clientMessageId: string, outcome: PromptAdmissionOutcome): void {
		const operation = this._liveClientInputs.get(clientMessageId);
		if (!operation) return;
		operation.resolveAccepted(outcome);
		this._liveClientInputs.delete(clientMessageId);
	}

	private async _markClientInputDispatchStarted(
		clientMessageId: string | undefined,
		operation: LiveClientInputOperation | undefined,
		abortGeneration = this._abortGeneration,
	): Promise<void> {
		if (clientMessageId === undefined || operation === undefined) {
			return;
		}
		if (this._disposed) {
			throw new Error("Session disposed before client input dispatch");
		}
		if (abortGeneration !== this._abortGeneration) {
			throw new Error("Client input was aborted before its dispatch boundary");
		}
		const record = this.sessionManager.getClientInput(clientMessageId);
		// The durable record is authoritative. An input hook may already have
		// crossed a dispatch boundary, then queued an exact transformed payload and
		// thereby re-admitted the same receipt to accepted. Its later dequeue must
		// persist a second started boundary even though the in-memory operation saw
		// the earlier one.
		if (record?.state === "accepted") {
			this.sessionManager.transitionClientInput(clientMessageId, "started");
			await this.sessionManager.flush();
			if (this._disposed) {
				throw new Error("Session disposed before client input dispatch");
			}
			if (abortGeneration !== this._abortGeneration) {
				throw new Error("Client input was aborted while persisting its dispatch boundary");
			}
		} else if (operation.dispatchBoundaryPersisted) {
			return;
		}
		operation.dispatchBoundaryPersisted = true;
		operation.acceptedForDispatch = true;
	}

	private _observeLivePrompt(
		operation: LiveClientInputOperation,
		preflightResult: ((result: PromptPreflightResult) => void) | undefined,
	): Promise<void> {
		void operation.accepted.then(
			(outcome) => preflightResult?.({ success: true, outcome }),
			() => preflightResult?.({ success: false }),
		);
		return operation.accepted.then(() => operation.completion);
	}

	/**
	 * Replays recoverable queued client input after the runtime is fully ready.
	 * The first steering input (or first follow-up when no steering exists)
	 * becomes a fresh prompt; remaining inputs keep their original queue class
	 * and drain behind that run. Interrupted provider/tool work is never resumed.
	 */
	resumeRecoveredClientInputs(): Promise<void> {
		if (this._resumeRecoveredClientInputsPromise) {
			return this._resumeRecoveredClientInputsPromise;
		}
		if (this.isBusy || this._disposed) {
			return Promise.reject(new Error("Cannot resume recovered client input while the agent runtime is busy"));
		}
		const abortGeneration = this._abortGeneration;
		const resume = this._trackPromptTransaction(async () => {
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Recovered client input resume was aborted before it started");
			}
			const recovery = this.sessionManager.getClientInputRecoveryPlan();
			if (recovery.kind === "blocked") {
				this._recoveredClientInputReplayPending = true;
				throw this._ambiguousRecoveredClientInputError(recovery.blocker.clientMessageId);
			}
			const records = recovery.records;
			const ordered = [
				...records.filter((record) => record.queuedInput?.delivery === "steer"),
				...records.filter((record) => record.queuedInput?.delivery === "follow_up"),
			];
			const first = ordered[0];
			if (!first?.queuedInput) {
				this._recoveredClientInputReplayPending = false;
				return;
			}
			// Constructor hydration makes the complete queue visible to bootstrap.
			// Rebuild it here with the promoted first input removed, without using
			// clearQueue (which correctly marks user-cleared receipts failed).
			this._clearAgentQueues();
			this._steeringMessages = [];
			this._followUpMessages = [];
			this._queueDeliveryIds.clear();
			for (const record of ordered.slice(1)) {
				if (record.queuedInput) {
					this._restoreQueuedClientInput(record.clientMessageId, record.queuedInput);
				}
			}
			this._emitQueueUpdate();
			const firstOperation = this._liveClientInputs.get(first.clientMessageId);
			if (firstOperation) firstOperation.queued = false;

			const firstMessage: AgentMessage = {
				role: "user",
				content: [
					{ type: "text", text: first.queuedInput.message },
					...first.queuedInput.images.map((image) => ({ ...image })),
				],
				clientMessageId: first.clientMessageId,
				timestamp: Date.now(),
			};
			try {
				await this._runAgentPrompt(
					firstMessage,
					abortGeneration,
					this._hasRetainedDirectInput(first.clientMessageId),
				);
				if (this.sessionManager.getClientInput(first.clientMessageId)?.state !== "completed") {
					throw new Error("Recovered client input stopped before its canonical user message committed");
				}
				const remainingRecovery = this.sessionManager.getClientInputRecoveryPlan();
				if (remainingRecovery.kind === "blocked") {
					throw this._ambiguousRecoveredClientInputError(remainingRecovery.blocker.clientMessageId);
				}
				if (remainingRecovery.records.length > 0) {
					throw new Error("Recovered client input stopped before the durable queue fully drained");
				}
				this._recoveredClientInputReplayPending = false;
			} catch (error) {
				// Rebuild from durable accepted receipts. A canonical identified user
				// append removes its receipt from this query, so completed inputs cannot
				// be resurrected; anything still accepted becomes attach-visible again.
				this._clearAgentQueues();
				this._steeringMessages = [];
				this._followUpMessages = [];
				this._queueDeliveryIds.clear();
				const remainingRecovery = this.sessionManager.getClientInputRecoveryPlan();
				const recoverableRecords = remainingRecovery.records;
				this._recoveredClientInputReplayPending = remainingRecovery.kind !== "idle";
				this._reconcileRecoveredClientInputOperations(recoverableRecords);
				for (const record of recoverableRecords) {
					if (!record.queuedInput || this._hasRetainedDirectInput(record.clientMessageId)) continue;
					this._restoreQueuedClientInput(record.clientMessageId, record.queuedInput);
				}
				this._emitQueueUpdate();
				throw error;
			}
		});
		this._resumeRecoveredClientInputsPromise = resume;
		void resume.catch(() => {
			if (this._resumeRecoveredClientInputsPromise === resume) {
				this._resumeRecoveredClientInputsPromise = undefined;
			}
		});
		return resume;
	}

	private _assertRecoveredClientInputOrdering(clientMessageId: string | undefined): void {
		if (!this._recoveredClientInputReplayPending) return;
		const recovery = this.sessionManager.getClientInputRecoveryPlan();
		if (recovery.kind === "idle") {
			// Queue cancellation/terminalization is authoritative and releases the
			// fence even after a previous replay attempt failed.
			this._recoveredClientInputReplayPending = false;
			return;
		}
		// Idempotent retries for an already-restored receipt may still join/replay
		// their original outcome. Only a distinct input could overtake the queue.
		if (
			clientMessageId !== undefined &&
			(recovery.records.some((record) => record.clientMessageId === clientMessageId) ||
				(recovery.kind === "blocked" && recovery.blocker.clientMessageId === clientMessageId))
		) {
			return;
		}
		if (recovery.kind === "blocked") {
			throw new Error(
				`Ambiguous recovered client input ${JSON.stringify(recovery.blocker.clientMessageId)} must be resolved before later or fresh input can be admitted`,
			);
		}
		throw new Error("Recovered client input must finish replaying before fresh input can be admitted");
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		abortGeneration = this._abortGeneration,
		resumeRetainedPrompt = false,
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot start an agent run while a session mutation is active");
		}
		if (this._disposed || abortGeneration !== this._abortGeneration) {
			return;
		}
		// Turn-start seam: every fresh-input turn passes through here (direct
		// prompts, recovered-input replay, triggered custom messages), behind
		// the admission and generation fences.
		const conversationGenerationRevision = this._conversationGenerationRevision;
		await this._maybeAppendSubagentRecoveryNotice();
		// The hook's hydration awaits reopen the fence window: an abort,
		// dispose, compaction, or tree navigation that landed during them must
		// cancel this run, not be outrun by it.
		if (
			this._disposed ||
			abortGeneration !== this._abortGeneration ||
			conversationGenerationRevision !== this._conversationGenerationRevision
		) {
			return;
		}
		this._proactiveCompactionState = "idle";
		this._drainFollowUpsOnNextContinuation = false;
		const run = (async () => {
			this._agentConversationMutationInFlight = true;
			try {
				this._sessionPromptOwnsInitialDelivery = true;
				let result: AgentRunResult;
				try {
					result = await this._runAgentOperation(() =>
						resumeRetainedPrompt ? this.agent.continue() : this.agent.prompt(messages),
					);
				} finally {
					this._sessionPromptOwnsInitialDelivery = false;
				}
				while (await this._handlePostAgentRun(result, abortGeneration, conversationGenerationRevision)) {
					result = await this._continueAgent();
				}
			} finally {
				this._agentConversationMutationInFlight = false;
				this._flushPendingBashMessages();
			}
		})();
		this._activePromptRuns.add(run);
		try {
			await run;
		} finally {
			this._activePromptRuns.delete(run);
			this._emitAgentSettledIfIdle();
		}
	}

	private async _runAgentOperation<T>(operation: () => Promise<T>): Promise<T> {
		this._assertConversationAuthorityAvailable();
		if (this._agentEventFatalError) {
			const staleError = this._agentEventFatalError;
			this._agentEventFatalError = undefined;
			throw staleError;
		}
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			await this._drainDeliveryRevocations();
			const fatalError = this._agentEventFatalError;
			this._agentEventFatalError = undefined;
			throw fatalError ?? error;
		}
		await this._drainDeliveryRevocations();
		const fatalError = this._agentEventFatalError;
		this._agentEventFatalError = undefined;
		if (fatalError) {
			throw fatalError;
		}
		return result;
	}

	private async _continueAgent(): Promise<AgentRunResult> {
		this._assertConversationAuthorityAvailable();
		const drainFollowUps = this._drainFollowUpsOnNextContinuation;
		this._drainFollowUpsOnNextContinuation = false;
		this._agentConversationMutationInFlight = true;
		try {
			return await this._runAgentOperation(() => this.agent.continue({ drainFollowUps }));
		} finally {
			this._agentConversationMutationInFlight = false;
		}
	}

	private _trackPromptTransaction(operation: (transactionId: symbol) => Promise<void>): Promise<void> {
		this._assertConversationAuthorityAvailable();
		const transactionId = Symbol("promptTransaction");
		const transaction = Promise.resolve().then(() => {
			this._assertConversationAuthorityAvailable();
			return operation(transactionId);
		});
		this._activePromptTransactions.set(transactionId, transaction);
		return transaction.finally(() => {
			this._activePromptTransactions.delete(transactionId);
			this._extensionCommandTransactions.delete(transactionId);
			this._emitAgentSettledIfIdle();
		});
	}

	private _trackSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
		this._assertConversationAuthorityAvailable();
		const tracked = Promise.resolve().then(() => {
			this._assertConversationAuthorityAvailable();
			return operation();
		});
		this._activeSessionOperations.add(tracked);
		return tracked.finally(() => {
			this._activeSessionOperations.delete(tracked);
			this._emitAgentSettledIfIdle();
		});
	}

	private _emitAgentSettledIfIdle(): void {
		if (
			this._activePromptRuns.size === 0 &&
			this._activePromptTransactions.size === 0 &&
			this._activeSessionOperations.size === 0
		) {
			this._emit({ type: "agent_settled" });
		}
	}

	/** Wait for the agent and any session-level prompt work to settle. */
	async waitForIdle(): Promise<void> {
		await this._waitForIdle();
	}

	private async _waitForIdle(excludeExtensionCommands = false): Promise<void> {
		while (true) {
			const promptTransactions = [...this._activePromptTransactions.entries()]
				.filter(
					([transactionId]) => !excludeExtensionCommands || !this._extensionCommandTransactions.has(transactionId),
				)
				.map(([, transaction]) => transaction);
			const sessionWork = [...this._activePromptRuns, ...promptTransactions, ...this._activeSessionOperations];
			if (sessionWork.length > 0) {
				await Promise.allSettled(sessionWork);
				continue;
			}

			await this.agent.waitForIdle();
			const hasOtherTransactions = [...this._activePromptTransactions.keys()].some(
				(transactionId) => !excludeExtensionCommands || !this._extensionCommandTransactions.has(transactionId),
			);
			if (this._activePromptRuns.size === 0 && !hasOtherTransactions && this._activeSessionOperations.size === 0) {
				return;
			}
		}
	}

	private async _handlePostAgentRun(
		result: AgentRunResult,
		abortGeneration = this._abortGeneration,
		conversationGenerationRevision = this._conversationGenerationRevision,
	): Promise<boolean> {
		// A retained or terminal delivery failure settles this run. Queue presence
		// cannot authorize an implicit retry; only a later explicit continuation can.
		if (result.status === "delivery_failed") {
			this._lastAssistantMessage = undefined;
			this._settleRetry(false, result.failure.error.message);
			return false;
		}
		// Disposal stops all continuations. Abort stops automatic retry/compaction
		// resurrection, but intentionally preserves messages queued before abort.
		if (this._disposed) {
			return false;
		}
		if (abortGeneration !== this._abortGeneration) {
			this._lastAssistantMessage = undefined;
			this._settleRetry(false, "Retry cancelled");
			return false;
		}
		if (conversationGenerationRevision !== this._conversationGenerationRevision) {
			// The provider run belongs to a branch that is no longer active. Its
			// persisted messages remain historical truth, but it cannot compact,
			// retry, or continue against the newly selected branch.
			this._lastAssistantMessage = undefined;
			this._proactiveCompactionState = "idle";
			this._settleRetry(false, "Conversation branch changed");
			return false;
		}
		const conversationGenerationChanged = (): boolean =>
			conversationGenerationRevision !== this._conversationGenerationRevision;
		const abandonStaleConversationRun = (): false => {
			this._proactiveCompactionState = "idle";
			this._settleRetry(false, "Conversation branch changed");
			return false;
		};
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._proactiveCompactionState === "scheduled") {
			this._proactiveCompactionState = "compacting";
			// The run was interrupted mid-task by _shouldStopForProactiveCompaction,
			// so resume it only after mandatory compaction succeeds. A failure
			// rejects the prompt and leaves the durable transcript retryable.
			const shouldContinue = await this._runAutoCompaction("threshold", false, true);
			if (conversationGenerationChanged()) {
				return abandonStaleConversationRun();
			}
			if (!shouldContinue) {
				return false;
			}
			return !this._disposed && abortGeneration === this._abortGeneration;
		}

		if (this._isRetryableError(msg)) {
			const willRetry = await this._prepareRetry(msg, abortGeneration);
			if (conversationGenerationChanged()) {
				return abandonStaleConversationRun();
			}
			if (willRetry) {
				return !this._disposed && abortGeneration === this._abortGeneration;
			}
		}
		if (this._disposed) {
			return false;
		}
		if (abortGeneration !== this._abortGeneration) {
			return false;
		}

		if (msg.stopReason === "error") {
			this._settleRetry(false, msg.errorMessage);
		}

		const compacted = await this._checkCompaction(msg);
		if (conversationGenerationChanged()) {
			return abandonStaleConversationRun();
		}
		if (this._disposed || abortGeneration !== this._abortGeneration) {
			return false;
		}
		if (compacted) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via volt.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._disposed) {
			throw new Error("Cannot prompt a disposed session");
		}
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot prompt while a session mutation is active");
		}
		const assertConversationGenerationCurrent = this._captureConversationGenerationAssertion(
			options?.assertConversationGenerationCurrent,
		);
		assertConversationGenerationCurrent();
		this._assertRecoveredClientInputOrdering(options?.clientMessageId);
		const admission: ClientInputAdmission =
			options?.clientMessageId === undefined
				? { kind: "none" }
				: await this._beginClientInput(
						"prompt",
						text,
						options.images,
						options.clientMessageId,
						options.streamingBehavior,
					);
		try {
			assertConversationGenerationCurrent();
		} catch (error) {
			if (admission.kind === "start" && options?.clientMessageId !== undefined) {
				if (this._liveClientInputs.get(options.clientMessageId) === admission.operation) {
					this._liveClientInputs.delete(options.clientMessageId);
				}
				const normalized = error instanceof Error ? error : new Error(String(error));
				admission.operation.rejectAccepted(normalized);
				admission.operation.rejectCompletion(normalized);
			}
			throw error;
		}
		const isRunning = this.isStreaming;
		const shouldQueue = isRunning || this._activePromptTransactions.size > 0 || this._abortPromise !== undefined;
		const allowQueue = isRunning && this._abortPromise === undefined;
		const abortGeneration = this._abortGeneration;
		if (admission.kind === "completed") {
			options?.preflightResult?.({ success: true, outcome: "completed" });
			return Promise.resolve();
		}
		if (admission.kind === "live") {
			return this._observeLivePrompt(admission.operation, options?.preflightResult);
		}

		const operation = admission.kind === "start" ? admission.operation : undefined;
		const clientMessageId = options?.clientMessageId;
		const originalPreflightResult = options?.preflightResult;
		const authorityOptions: PromptOptions = {
			...options,
			assertConversationGenerationCurrent,
		};
		const promptOptions = operation
			? {
					...authorityOptions,
					preflightResult: (result: PromptPreflightResult) => {
						if (result.success) {
							operation.resolveAccepted(result.outcome);
						} else {
							operation.rejectAccepted(new Error("Client input prompt preflight failed"));
						}
					},
				}
			: authorityOptions;
		if (operation) {
			void operation.accepted.then(
				(outcome) => originalPreflightResult?.({ success: true, outcome }),
				() => originalPreflightResult?.({ success: false }),
			);
		}
		if (operation && clientMessageId !== undefined && !shouldQueue && this._hasRetainedDirectInput(clientMessageId)) {
			const completion = this._trackPromptTransaction(async () => {
				await this._runAgentPrompt([], abortGeneration, true);
			});
			operation.attachCompletion(completion);
			return completion.finally(() => {
				if (!operation.queued && this._liveClientInputs.get(clientMessageId) === operation) {
					this._liveClientInputs.delete(clientMessageId);
				}
			});
		}
		const completion = this._trackPromptTransaction(async (transactionId) => {
			try {
				const outcome = await this._prompt(
					text,
					promptOptions,
					shouldQueue,
					allowQueue,
					abortGeneration,
					transactionId,
					operation,
				);
				if (operation && clientMessageId && outcome === "handled") {
					this.sessionManager.transitionClientInput(clientMessageId, "completed");
					await this.sessionManager.flush();
					this._completeLiveClientInput(clientMessageId, "completed");
				} else if (!operation && outcome === "handled") {
					// Local/prompt-backed UI actions have no durable client identity, but
					// their completed handler is still an authoritative admission boundary.
					promptOptions?.preflightResult?.({ success: true, outcome: "admitted" });
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				if (operation && clientMessageId && !operation.acceptedForDispatch) {
					await this._failLiveClientInput(clientMessageId, operation, normalized);
				}
				throw normalized;
			}
		});
		if (operation) {
			operation.attachCompletion(completion);
			void completion
				.finally(() => {
					if (clientMessageId && this._liveClientInputs.get(clientMessageId) === operation && !operation.queued) {
						this._liveClientInputs.delete(clientMessageId);
					}
				})
				.catch(() => {});
		}
		return completion;
	}

	private async _prompt(
		text: string,
		options: PromptOptions | undefined,
		shouldQueue: boolean,
		allowQueue: boolean,
		abortGeneration: number,
		transactionId: symbol,
		operation: LiveClientInputOperation | undefined,
	): Promise<PromptDispatchOutcome> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const assertConversationGenerationCurrent = (): void => {
			options?.assertConversationGenerationCurrent?.();
		};
		let messages: AgentMessage[] | undefined;

		try {
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before preflight started");
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via volt.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text, transactionId, () =>
					this._markClientInputDispatchStarted(options?.clientMessageId, operation, abortGeneration),
				);
				assertConversationGenerationCurrent();
				if (handled) {
					// Extension command executed, no prompt to send
					return "handled";
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				// Input hooks are arbitrary side-effect boundaries. Persist ambiguity
				// before entering them. A later durable queued payload safely returns
				// this receipt to recoverable `accepted`; a crash in between never
				// re-executes an uncertain hook.
				await this._markClientInputDispatchStarted(options?.clientMessageId, operation, abortGeneration);
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					shouldQueue ? options?.streamingBehavior : undefined,
				);
				assertConversationGenerationCurrent();
				if (this._disposed || abortGeneration !== this._abortGeneration) {
					throw new Error("Prompt aborted during input preflight");
				}
				if (inputResult.action === "handled") {
					return "handled";
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// Queue only behind an active agent run. During preflight or abort,
			// reject promptly so an accepted message cannot be stranded.
			if (shouldQueue) {
				assertConversationGenerationCurrent();
				if (allowQueue && !this.isStreaming) {
					throw new Error(
						"Agent finished processing while queued prompt preflight was running. Resubmit the prompt.",
					);
				}
				if (!allowQueue || !options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, options.clientMessageId, operation);
				} else {
					await this._queueSteer(expandedText, currentImages, options.clientMessageId, operation);
				}
				preflightResult?.({ success: true, outcome: "admitted" });
				return "queued";
			}

			// Flush any pending bash messages before the new prompt
			assertConversationGenerationCurrent();
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Deterministic model/auth preflight is complete. Everything below can
			// invoke side-effect-capable compaction, before_agent_start, and message
			// hooks. Persist the ambiguous dispatch boundary before any of them so a
			// crash never replays extension or provider side effects.
			await this._markClientInputDispatchStarted(options?.clientMessageId, operation, abortGeneration);

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this._findLastAssistantMessage();
			if (
				lastAssistant &&
				(await this._checkCompaction(lastAssistant, false, assertConversationGenerationCurrent))
			) {
				assertConversationGenerationCurrent();
				// dispose() or abort() can land during the _checkCompaction await.
				// agent.continue() mints a fresh controller, so it must not run for a
				// disposed generation or an aborted prompt transaction.
				if (this._disposed || abortGeneration !== this._abortGeneration) {
					throw new Error("Prompt aborted before recovery could continue");
				}
				try {
					const continuationConversationGenerationRevision = this._conversationGenerationRevision;
					let result = await this._continueAgent();
					assertConversationGenerationCurrent();
					while (
						await this._handlePostAgentRun(result, abortGeneration, continuationConversationGenerationRevision)
					) {
						assertConversationGenerationCurrent();
						result = await this._continueAgent();
						assertConversationGenerationCurrent();
					}
				} finally {
					assertConversationGenerationCurrent();
					this._flushPendingBashMessages();
				}
			}
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before the agent run started");
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				...(options?.clientMessageId === undefined ? {} : { clientMessageId: options.clientMessageId }),
				timestamp: Date.now(),
			});

			// Snapshot pending "nextTurn" context. It is consumed only after preflight
			// is accepted so aborting an extension hook cannot lose queued context.
			const pendingNextTurnMessages = [...this._pendingNextTurnMessages];
			messages.push(...pendingNextTurnMessages);

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before the agent run started");
			}

			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply the per-turn extension prompt before appending trusted planning instructions.
			this._applyTrustedPlanningInstructionsToSystemPrompt(result?.systemPrompt);

			this._pendingNextTurnMessages.splice(0, pendingNextTurnMessages.length);
		} catch (error) {
			preflightResult?.({ success: false });
			throw error;
		}

		if (!messages) {
			return "handled";
		}

		if (this._disposed || abortGeneration !== this._abortGeneration) {
			preflightResult?.({ success: false });
			throw new Error("Prompt aborted before the agent run started");
		}
		assertConversationGenerationCurrent();
		if (!operation) {
			// Identified inputs acknowledge through their canonical user commit.
			// Unidentified local/UI-action prompts still need a bounded admission
			// signal so their caller need not hold lifecycle ownership for the full
			// provider turn.
			preflightResult?.({ success: true, outcome: "admitted" });
		}
		await this._runAgentPrompt(messages, abortGeneration);
		return "run";
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(
		text: string,
		transactionId: symbol,
		onWillExecute?: () => Promise<void>,
	): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;
		this._extensionCommandTransactions.add(transactionId);
		// A command handler is an arbitrary side-effect boundary with no canonical
		// user append. Persist `started` first so a crash can only replay an
		// explicit ambiguous outcome, never execute the handler twice.
		await onWillExecute?.();

		// Command transactions must not wait on themselves or each other.
		// waitForIdle still waits for active runs and non-command prompt work.
		const ctx = this._extensionRunner.createCommandContext(() => this._waitForIdle(true));

		try {
			this._activeExtensionCommandHandlers++;
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		} finally {
			this._activeExtensionCommandHandlers--;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], clientMessageId?: string): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this._disposed) {
			throw new Error("Cannot queue input on a disposed session");
		}
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot queue input while a session mutation is active");
		}
		this._assertRecoveredClientInputOrdering(clientMessageId);
		const admission: ClientInputAdmission =
			clientMessageId === undefined
				? { kind: "none" }
				: await this._beginClientInput("steer", text, images, clientMessageId);
		if (admission.kind === "completed") return;
		if (admission.kind === "live") {
			await admission.operation.accepted;
			return;
		}
		const operation = admission.kind === "start" ? admission.operation : undefined;
		try {
			// Check for extension commands (cannot be queued)
			if (text.startsWith("/")) {
				this._throwIfExtensionCommand(text);
			}

			// Expand skill commands and prompt templates
			let expandedText = this._expandSkillCommand(text);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

			await this._queueSteer(expandedText, images, clientMessageId, operation);
			operation?.resolveAccepted("admitted");
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (operation && clientMessageId) {
				await this._failLiveClientInput(clientMessageId, operation, normalized);
			}
			throw normalized;
		}
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], clientMessageId?: string): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this._disposed) {
			throw new Error("Cannot queue input on a disposed session");
		}
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot queue input while a session mutation is active");
		}
		this._assertRecoveredClientInputOrdering(clientMessageId);
		const admission: ClientInputAdmission =
			clientMessageId === undefined
				? { kind: "none" }
				: await this._beginClientInput("follow_up", text, images, clientMessageId);
		if (admission.kind === "completed") return;
		if (admission.kind === "live") {
			await admission.operation.accepted;
			return;
		}
		const operation = admission.kind === "start" ? admission.operation : undefined;
		try {
			// Check for extension commands (cannot be queued)
			if (text.startsWith("/")) {
				this._throwIfExtensionCommand(text);
			}

			// Expand skill commands and prompt templates
			let expandedText = this._expandSkillCommand(text);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

			await this._queueFollowUp(expandedText, images, clientMessageId, operation);
			operation?.resolveAccepted("admitted");
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (operation && clientMessageId) {
				await this._failLiveClientInput(clientMessageId, operation, normalized);
			}
			throw normalized;
		}
	}

	/**
	 * Persist queue ownership before runtime publication so clearQueue can revoke
	 * an admission while its durability watermark is still pending.
	 */
	private async _persistQueuedClientInputAdmission(
		delivery: "steer" | "follow_up",
		text: string,
		images: ImageContent[] | undefined,
		clientMessageId: string,
		operation: LiveClientInputOperation | undefined,
	): Promise<void> {
		if (operation === undefined || this._liveClientInputs.get(clientMessageId) !== operation) {
			throw new Error("Client input lost queue admission ownership before persistence");
		}
		this.sessionManager.markClientInputQueued(clientMessageId, {
			delivery,
			message: text,
			...(images === undefined ? {} : { images }),
		});
		// clearQueue must see the admission before the durability await so its
		// successful return also revokes work that has not reached agent-core yet.
		operation.queued = true;
		await this.sessionManager.flush();
		if (this._disposed) {
			throw new Error("Session disposed before queued input admission completed");
		}
		if (
			this._liveClientInputs.get(clientMessageId) !== operation ||
			!operation.queued ||
			this.sessionManager.getClientInput(clientMessageId)?.state !== "accepted"
		) {
			throw new Error("Queued input admission was cleared before runtime publication");
		}
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(
		text: string,
		images?: ImageContent[],
		clientMessageId?: string,
		operation?: LiveClientInputOperation,
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this.pendingMessageCount >= AGENT_SESSION_MAX_QUEUED_MESSAGES) {
			throw new Error(`Agent queue is limited to ${AGENT_SESSION_MAX_QUEUED_MESSAGES} messages`);
		}
		if (clientMessageId !== undefined) {
			await this._persistQueuedClientInputAdmission("steer", text, images, clientMessageId, operation);
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const queueEntryId = createRuntimeQueueEntryId();
		const deliveryId = this.agent.steer({
			role: "user",
			content,
			clientMessageId: queueEntryId,
			timestamp: Date.now(),
		});
		this._queueDeliveryIds.set(queueEntryId, deliveryId);
		this._steeringMessages.push({
			queueEntryId,
			...(clientMessageId === undefined ? {} : { clientMessageId }),
			text,
		});
		this._emitQueueUpdate();
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images?: ImageContent[],
		clientMessageId?: string,
		operation?: LiveClientInputOperation,
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this.pendingMessageCount >= AGENT_SESSION_MAX_QUEUED_MESSAGES) {
			throw new Error(`Agent queue is limited to ${AGENT_SESSION_MAX_QUEUED_MESSAGES} messages`);
		}
		if (clientMessageId !== undefined) {
			await this._persistQueuedClientInputAdmission("follow_up", text, images, clientMessageId, operation);
		}
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		const queueEntryId = createRuntimeQueueEntryId();
		const deliveryId = this.agent.followUp({
			role: "user",
			content,
			clientMessageId: queueEntryId,
			timestamp: Date.now(),
		});
		this._queueDeliveryIds.set(queueEntryId, deliveryId);
		this._followUpMessages.push({
			queueEntryId,
			...(clientMessageId === undefined ? {} : { clientMessageId }),
			text,
		});
		this._emitQueueUpdate();
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		await this._sendCustomMessage(message, options, false);
	}

	private async _sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		allowDuringPromptTransaction: boolean,
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot append a custom message while a session mutation is active");
		}
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._activePromptTransactions.size > 0 && !allowDuringPromptTransaction) {
				throw new Error("Agent is already processing a prompt transaction");
			}
			if (allowDuringPromptTransaction) {
				await this._runAgentPrompt(appMessage);
			} else {
				const abortGeneration = this._abortGeneration;
				await this._trackPromptTransaction(() => this._runAgentPrompt(appMessage, abortGeneration));
			}
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 *
	 * Durability is awaited only when clearing actually records something: queued
	 * input with a durable client identity. Runtime ownership is revoked before that
	 * await, so a persistence failure cannot put the text back. It is instead carried
	 * on the thrown {@link QueueClearPersistenceError} for callers that must not lose it.
	 * @returns Object with steering and followUp arrays
	 * @throws QueueClearPersistenceError when the cleared state could not be persisted
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const revokedDeliveryIds = new Set(this._clearAgentQueues());
		const revokedSteering = this._steeringMessages.filter((entry) => {
			const deliveryId = this._queueDeliveryIds.get(entry.queueEntryId);
			return deliveryId !== undefined && revokedDeliveryIds.has(deliveryId);
		});
		const revokedFollowUp = this._followUpMessages.filter((entry) => {
			const deliveryId = this._queueDeliveryIds.get(entry.queueEntryId);
			return deliveryId !== undefined && revokedDeliveryIds.has(deliveryId);
		});
		const revokedEntries = [...revokedSteering, ...revokedFollowUp];
		const revokedQueueEntryIds = new Set(revokedEntries.map((entry) => entry.queueEntryId));
		const projectedClientMessageIds = new Set(
			[...this._steeringMessages, ...this._followUpMessages].flatMap((entry) =>
				entry.clientMessageId === undefined ? [] : [entry.clientMessageId],
			),
		);
		const revokedClientMessageIds = new Set(
			revokedEntries.flatMap((entry) => (entry.clientMessageId === undefined ? [] : [entry.clientMessageId])),
		);
		const queuedOperations = [...this._liveClientInputs].filter(
			([clientMessageId, operation]) =>
				operation.queued &&
				(revokedClientMessageIds.has(clientMessageId) || !projectedClientMessageIds.has(clientMessageId)),
		);
		const steering = revokedSteering.map((entry) => entry.text);
		const followUp = revokedFollowUp.map((entry) => entry.text);
		const terminalError = new Error("client_input_failed: queued input was cleared before canonical consumption");
		let persistenceError: Error | undefined;

		try {
			for (const [clientMessageId] of queuedOperations) {
				this.sessionManager.transitionClientInput(clientMessageId, "failed", terminalError.message);
			}
		} catch (error) {
			persistenceError = error instanceof Error ? error : new Error(String(error));
		}

		this._steeringMessages = this._steeringMessages.filter((entry) => !revokedQueueEntryIds.has(entry.queueEntryId));
		this._followUpMessages = this._followUpMessages.filter((entry) => !revokedQueueEntryIds.has(entry.queueEntryId));
		for (const entry of revokedEntries) this._queueDeliveryIds.delete(entry.queueEntryId);
		if (revokedEntries.length > 0) this._emitQueueUpdate();
		for (const [clientMessageId, operation] of queuedOperations) {
			operation.queued = false;
			if (this._liveClientInputs.get(clientMessageId) === operation) {
				this._liveClientInputs.delete(clientMessageId);
			}
		}

		// Runtime-only queue entries carry a local-queue identity and never reach the
		// WAL, so clearing them appends nothing. Awaiting the durable watermark in
		// that case records no cancellation and only inherits an unrelated earlier
		// failure, which would fail the one action a fail-stopped session still owes
		// the user: handing their unsent text back.
		if (queuedOperations.length > 0 && persistenceError === undefined) {
			try {
				await this.sessionManager.flush();
			} catch (error) {
				persistenceError = error instanceof Error ? error : new Error(String(error));
			}
		}

		if (persistenceError !== undefined) {
			for (const [, operation] of queuedOperations) {
				operation.rejectAccepted(persistenceError);
				operation.rejectCompletion(persistenceError);
			}
			throw new QueueClearPersistenceError(persistenceError, { steering, followUp });
		}

		for (const [clientMessageId, operation] of queuedOperations) {
			const admissionWasAcknowledged = operation.acceptanceSettled;
			operation.rejectAccepted(terminalError);
			if (admissionWasAcknowledged) {
				this._emitClientInputOutcome(clientMessageId, "failed", "queue_cleared");
			}
		}
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		this._assertConversationAuthorityAvailable();
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertConversationAuthorityAvailable();
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertConversationAuthorityAvailable();
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	abort(source?: AgentAbortSource): Promise<void> {
		this.agent.abort(source);
		if (this._abortPromise) {
			return this._abortPromise;
		}
		this._abortGeneration += 1;
		this.abortRetry();
		this.abortCompaction();
		const idlePromise = this.waitForIdle();
		const abortPromise = idlePromise.finally(() => {
			if (this._abortPromise === abortPromise) {
				this._abortPromise = undefined;
			}
		});
		this._abortPromise = abortPromise;
		return abortPromise;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session, and persists as the default unless disabled.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options?: DefaultPersistenceOptions): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const persistDefault = options?.persistDefault !== false;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.agent.state.model = model;
		this._syncPlanningRuntime();
		if (persistDefault) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		this.setThinkingLevel(thinkingLevel, { persistDefault });
		await Promise.all([this.sessionManager.flush(), this.settingsManager.flush()]);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		this._assertConversationAuthorityAvailable();
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.agent.state.model = next.model;
		this._syncPlanningRuntime();
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
		this.setThinkingLevel(thinkingLevel);
		await Promise.all([this.sessionManager.flush(), this.settingsManager.flush()]);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.agent.state.model = nextModel;
		this._syncPlanningRuntime();
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
		this.setThinkingLevel(thinkingLevel);
		await Promise.all([this.sessionManager.flush(), this.settingsManager.flush()]);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes. Settings persistence can be disabled.
	 */
	setThinkingLevel(level: ThinkingLevel, options?: DefaultPersistenceOptions): void {
		this._assertConversationAuthorityAvailable();
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		const persistDefault = options?.persistDefault !== false;

		if (!isChanging) {
			return;
		}

		this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		this.agent.state.thinkingLevel = effectiveLevel;

		if (persistDefault && (this.supportsThinking() || effectiveLevel !== "off")) {
			this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
		}
		this._emit({ type: "thinking_level_changed", level: effectiveLevel });
		void this._extensionRunner.emit({
			type: "thinking_level_select",
			level: effectiveLevel,
			previousLevel,
		});
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	/** Commit a branch-local Fast mode transition before publishing its settled state. */
	setFastModeEnabled(enabled: boolean): void {
		this._assertConversationAuthorityAvailable();
		if (enabled === this._fastModeEnabled) {
			return;
		}

		this.sessionManager.appendFastModeChange(enabled);
		this._fastModeEnabled = enabled;
		this.agent.inferenceSpeed = enabled ? "fast" : "standard";
		this._emitFastModeStateChanged();
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? "medium";
		}
		return this.thinkingLevel;
	}

	private _restoreFastModePolicy(policy: { enabled: boolean }): void {
		this._fastModeEnabled = policy.enabled;
		this.agent.inferenceSpeed = policy.enabled ? "fast" : "standard";
	}

	private _emitFastModeStateChanged(): void {
		this._emitCommittedEvent({
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: {
				type: "boolean",
				value: this._fastModeEnabled,
				label: this._fastModeEnabled ? "Fast mode enabled" : "Fast mode disabled",
			},
		});
	}

	private _emitCommittedEvent(event: AgentSessionEvent): void {
		if (this.sessionManager.getConversationAuthorityStatus().status !== "available") return;
		for (const listener of this._eventListeners) {
			try {
				listener(event);
			} catch {
				// Durable state is authoritative; observers cannot roll back a committed transition.
			}
		}
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	private syncAgentRuntimeSettingsFromSettings(): void {
		this.syncQueueModesFromSettings();
		this.agent.transport = this.settingsManager.getTransport();
		this.agent.thinkingBudgets = this.settingsManager.getThinkingBudgets();
		this.agent.maxRetryDelayMs = this.settingsManager.getProviderRetrySettings().maxRetryDelayMs;
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._assertConversationAuthorityAvailable();
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._assertConversationAuthorityAvailable();
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private _getSummarizationRetryOptions(): SummarizationRetryOptions {
		const settings = this.settingsManager.getRetrySettings();
		return {
			maxRetries: settings.enabled ? Math.min(MAX_COMPACTION_SUMMARY_RETRIES, Math.max(0, settings.maxRetries)) : 0,
			baseDelayMs: Math.max(0, settings.baseDelayMs),
			maxDelayMs: Math.min(
				MAX_COMPACTION_RETRY_DELAY_MS,
				Math.max(0, this.settingsManager.getProviderRetrySettings().maxRetryDelayMs),
			),
		};
	}

	private _getSummarizationThinkingLevel(): ThinkingLevel | undefined {
		if (!this.model?.reasoning) {
			return undefined;
		}

		const level = clampThinkingLevel(this.model, "minimal");
		return level === "off" ? undefined : level;
	}

	/**
	 * Shared epilogue for manual and auto compaction: rebuild the session
	 * context from the new boundary, update agent state, notify extensions,
	 * and assemble the CompactionResult.
	 *
	 * When `dropTrailingErrorMessage` is set (auto-compaction retry), a
	 * trailing assistant error message is removed before the retry so it is
	 * excluded from both the retained context and estimatedTokensAfter.
	 */
	private async _finalizeCompaction(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details: unknown,
		fromExtension: boolean,
		dropTrailingErrorMessage = false,
		assertConversationGenerationCurrent?: () => void,
	): Promise<CompactionResult> {
		assertConversationGenerationCurrent?.();
		if (this._appendPlanningCheckpointEntry(this._planningState)) {
			await this.sessionManager.flush();
		}
		const newEntries = this.sessionManager.getEntries();
		const sessionContext = this.sessionManager.buildSessionContext();
		let messages = sessionContext.messages;
		if (dropTrailingErrorMessage) {
			const lastIndex =
				messages.at(-1)?.role === "custom" &&
				(messages.at(-1) as CustomMessage).customType === PLAN_CHECKPOINT_CUSTOM_TYPE
					? messages.length - 2
					: messages.length - 1;
			const candidate = messages[lastIndex];
			if (candidate?.role === "assistant" && (candidate as AssistantMessage).stopReason === "error") {
				messages = [...messages.slice(0, lastIndex), ...messages.slice(lastIndex + 1)];
			}
		}
		this.agent.state.messages = messages;
		const estimatedTokensAfter = estimateMessagesTokens(messages);

		// Get the saved compaction entry for the extension event
		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;

		if (this._extensionRunner && savedCompactionEntry) {
			assertConversationGenerationCurrent?.();
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
			assertConversationGenerationCurrent?.();
		}

		return {
			summary,
			firstKeptEntryId,
			tokensBefore,
			estimatedTokensAfter,
			details,
		};
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(
		customInstructions?: string,
		assertConversationGenerationCurrent?: () => void,
	): Promise<CompactionResult> {
		if (this._hasSessionOperationBarrier || this.isBashRunning) {
			throw new Error("Cannot compact while another session mutation or bash run is active");
		}
		const assertConversationCurrent = this._captureConversationGenerationAssertion(
			assertConversationGenerationCurrent,
		);
		assertConversationCurrent();
		// Reserve synchronously before abort() yields. The tracked compaction cannot
		// be installed until abort has joined prior prompt work because waitForIdle
		// includes tracked session operations and would otherwise wait on itself.
		this._manualCompactionAdmissionInProgress = true;
		this._disconnectFromAgent();
		try {
			await this.abort(this._extensionMode === "rpc" ? "remote_request" : "host_action");
			assertConversationCurrent();
		} catch (error) {
			this._manualCompactionAdmissionInProgress = false;
			this._reconnectToAgent();
			throw error;
		}
		// Install the tracked operation in the same turn before releasing the
		// admission reservation, leaving no replacement window between the two.
		const compaction = this._trackSessionOperation(() =>
			this._compact(customInstructions, assertConversationCurrent),
		);
		this._manualCompactionAdmissionInProgress = false;
		return compaction;
	}

	private async _compact(
		customInstructions?: string,
		assertConversationGenerationCurrent?: () => void,
	): Promise<CompactionResult> {
		this._compactionAbortController = new AbortController();
		this._activeCompaction = { reason: "manual", startedAt: Date.now() };
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			assertConversationGenerationCurrent?.();
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getCompactionRequestAuth(this.model);
			assertConversationGenerationCurrent?.();

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				assertConversationGenerationCurrent?.();
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;
				assertConversationGenerationCurrent?.();

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				assertConversationGenerationCurrent?.();
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this._getSummarizationThinkingLevel(),
					this.agent.streamFn,
					env,
					this._getSummarizationRetryOptions(),
				);
				assertConversationGenerationCurrent?.();
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			assertConversationGenerationCurrent?.();
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			await this.sessionManager.flush();
			this._proactiveCompactionState = "idle";
			const compactionResult = await this._finalizeCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				false,
				assertConversationGenerationCurrent,
			);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._activeCompaction = undefined;
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Agent-loop hook: stop the run after the current turn when live context
	 * usage crosses the compaction threshold, so threshold compaction runs
	 * mid-task instead of only after the full agent/tool loop finishes.
	 * _handlePostAgentRun always resumes an interrupted run.
	 *
	 * Contract: must not throw.
	 */
	private _shouldStopForProactiveCompaction(context: AgentLoopNextActionContext): boolean {
		try {
			if (this._disposed) return false;
			if (context.requestAuthority === "final_response") return false;
			const hasQueuedMessages = this.agent.hasQueuedMessages();
			if (context.completedTurn?.disposition === "stop" && hasQueuedMessages) {
				this._drainFollowUpsOnNextContinuation = true;
			}
			if (this._proactiveCompactionState !== "idle" || !context.completedTurn) return false;
			// Only interrupt turns that would otherwise continue with another LLM
			// call. Queued steering/follow-up messages also force a continuation,
			// including after a plain response or a terminating tool batch.
			const willContinueForTools =
				context.completedTurn.toolResults.length > 0 && context.completedTurn.disposition === "continue";
			if (!willContinueForTools && !hasQueuedMessages) return false;
			const message = context.completedTurn.message;
			if (message.stopReason === "aborted" || message.stopReason === "error") return false;
			const settings = this.settingsManager.getCompactionSettings();
			if (!settings.enabled) return false;
			const model = this.model;
			if (!model || message.provider !== model.provider || message.model !== model.id) return false;
			// Provider usage predates this turn's tool execution. Estimate from the
			// live context so newly appended tool results are included before the
			// loop starts another provider request.
			const contextTokens = estimateContextTokens(context.context.messages).tokens;
			if (!shouldCompact(contextTokens, model.contextWindow ?? 0, settings)) return false;
			this._proactiveCompactionState = "scheduled";
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact; continue only when a length stop produced no visible output
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		assertConversationGenerationCurrent?: () => void,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true, false, assertConversationGenerationCurrent);
		}

		// Case 2: Threshold - context is getting large. Estimate from the live
		// context so tool results and other messages appended after provider usage
		// are included. For error messages, require a prior successful usage source.
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			// A lone aborted response may not be considered a trustworthy estimate
			// source, but its provider usage is still better than a character-only
			// fallback for the pre-prompt recovery check.
			contextTokens =
				estimate.lastUsageIndex === null ? calculateContextTokens(assistantMessage.usage) : estimate.tokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			const continueAfterCompaction =
				assistantMessage.stopReason === "length" &&
				!assistantMessage.content.some(
					(content) => (content.type === "text" && content.text.trim().length > 0) || content.type === "toolCall",
				);
			if (continueAfterCompaction) {
				return await this._runAutoCompaction("threshold", false, true, assertConversationGenerationCurrent);
			}
			return await this._runAutoCompaction("threshold", false, false, assertConversationGenerationCurrent);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		continueAfterCompaction = false,
		assertConversationGenerationCurrent?: () => void,
	): Promise<boolean> {
		this._assertConversationAuthorityAvailable();
		const settings = this.settingsManager.getCompactionSettings();
		const abortGeneration = this._abortGeneration;
		const canContinue = (): boolean => !this._disposed && abortGeneration === this._abortGeneration;
		let conversationGenerationAssertionFailed = false;
		const hasExternalAuthorityAssertion = assertConversationGenerationCurrent !== undefined;
		const assertCapturedConversationCurrent = this._captureConversationGenerationAssertion(
			assertConversationGenerationCurrent,
		);
		const assertConversationCurrent = (): void => {
			try {
				assertCapturedConversationCurrent();
			} catch (error) {
				conversationGenerationAssertionFailed = true;
				throw error;
			}
		};
		this._autoCompactionAbortController = new AbortController();
		this._activeCompaction = { reason, startedAt: Date.now() };

		try {
			this._emit({ type: "compaction_start", reason });
			assertConversationCurrent();
			if (!this.model) {
				throw new Error("Auto-compaction requires a selected model");
			}

			const { apiKey, headers, env } = await this._getCompactionRequestAuth(this.model);
			assertConversationCurrent();

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				throw new Error("Auto-compaction could not find a safe compaction boundary");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				assertConversationCurrent();
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;
				assertConversationCurrent();

				if (extensionResult?.cancel) {
					throw new Error("Auto-compaction was cancelled by an extension");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				assertConversationCurrent();
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this._getSummarizationThinkingLevel(),
					this.agent.streamFn,
					env,
					this._getSummarizationRetryOptions(),
				);
				assertConversationCurrent();
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			assertConversationCurrent();
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			await this.sessionManager.flush();
			this._proactiveCompactionState = "idle";
			const result = await this._finalizeCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				willRetry,
				assertConversationCurrent,
			);
			this._emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry: canContinue() && (willRetry || continueAfterCompaction),
			});

			if (willRetry || continueAfterCompaction) {
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			if (conversationGenerationAssertionFailed) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				if (hasExternalAuthorityAssertion) {
					throw error;
				}
				return false;
			}
			const aborted =
				this._autoCompactionAbortController.signal.aborted ||
				(error instanceof Error && error.name === "AbortError");
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				...(aborted
					? {}
					: {
							errorMessage:
								reason === "overflow"
									? `Context overflow recovery failed: ${errorMessage}`
									: `Auto-compaction failed: ${errorMessage}`,
						}),
			});
			if (aborted) {
				return false;
			}
			throw error;
		} finally {
			this._proactiveCompactionState = "idle";
			this._activeCompaction = undefined;
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (refreshedModel) {
			if (refreshedModel !== currentModel) {
				this.agent.state.model = refreshedModel;
				this._syncPlanningRuntime();
			}
			return;
		}

		const scopedFallback = this._scopedModels
			.map((scoped) => this._modelRegistry.find(scoped.model.provider, scoped.model.id))
			.find((model) => model !== undefined && this._modelRegistry.hasConfiguredAuth(model));
		const fallbackModel = scopedFallback ?? this._modelRegistry.getAvailable()[0];
		if (!fallbackModel) {
			(this.agent.state as unknown as { model: Model<any> | undefined }).model = undefined;
			this._syncPlanningRuntime();
			return;
		}

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.sessionManager.appendModelChange(fallbackModel.provider, fallbackModel.id);
		this.agent.state.model = fallbackModel;
		this._syncPlanningRuntime();
		this.setThinkingLevel(thinkingLevel, { persistDefault: false });
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this._sendCustomMessage(message, options, this._activeExtensionCommandHandlers > 0).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isBusy,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this._planningRuntimeInitialized
			? [...this._requestedBuildToolNames]
			: this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const allowUnlistedExtensionTools = this._allowUnlistedExtensionTools;
		const excludedToolNames = this._excludedToolNames;
		const isExcludedTool = (name: string): boolean => excludedToolNames?.has(name) === true;
		const isAllowedListedTool = (name: string): boolean =>
			NATIVE_PLAN_TOOL_NAMES.has(name) ||
			((!allowedToolNames || allowedToolNames.has(name)) && !isExcludedTool(name));
		const isAllowedExtensionTool = (name: string): boolean =>
			!isExcludedTool(name) && (!allowedToolNames || allowUnlistedExtensionTools || allowedToolNames.has(name));

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter(
			(tool) => isAllowedExtensionTool(tool.definition.name) && !NATIVE_PLAN_TOOL_NAMES.has(tool.definition.name),
		);
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedListedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedListedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._toolRegistry.has(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
			if (allowUnlistedExtensionTools) {
				for (const tool of wrappedExtensionTools) {
					nextActiveToolNames.push(tool.name);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		const resolvedRequestedToolNames = [...new Set(nextActiveToolNames)];
		if (!this._planningRuntimeInitialized) {
			this._requestedBuildToolNames = resolvedRequestedToolNames.filter((name) => !NATIVE_PLAN_TOOL_NAMES.has(name));
		}
		this.setActiveToolsByName(resolvedRequestedToolNames);
	}

	/**
	 * URLs that web_fetch is permitted to read.
	 *
	 * Only top-level user messages and structured results from successful
	 * web_search calls count. Delegated prompts, assistant messages, and rendered
	 * tool output are excluded because they can contain model- or attacker-chosen
	 * URLs.
	 */
	private _collectFetchableUrls(): string[] {
		const urls: string[] = [];
		// A delegated task is persisted as a user-role message so it can start the
		// child turn, but its author is the parent model. It must not grant the
		// child permission to fetch model-constructed URLs.
		const trustUserMessageUrls = this._subagentToolManager?.isSubagentRuntime?.() !== true;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") {
				continue;
			}
			const message = entry.message;
			if (message.role === "user" && trustUserMessageUrls) {
				if (typeof message.content === "string") {
					urls.push(...extractUrls(message.content));
					continue;
				}
				for (const part of message.content) {
					if (part.type === "text") {
						urls.push(...extractUrls(part.text));
					}
				}
			} else if (message.role === "toolResult" && message.toolName === "web_search" && !message.isError) {
				const details: unknown = message.details;
				if (
					typeof details !== "object" ||
					details === null ||
					!("results" in details) ||
					!Array.isArray(details.results)
				) {
					continue;
				}
				for (const result of details.results) {
					if (typeof result === "object" && result !== null && "url" in result && typeof result.url === "string") {
						urls.push(result.url);
					}
				}
			}
		}
		return urls;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();

		this._lspManager?.dispose();
		this._lspManager = undefined;
		const lspConfig = resolveLspConfig(this.settingsManager.getLspSettings());
		if (lspConfig.enabled) {
			this._lspManager = new LspManager({
				cwd: this._cwd,
				config: lspConfig,
				hostInteraction: this._hostInteraction,
			});
		}

		const directMcpToolDefinitions = this._mcpManager ? createMcpDirectToolDefinitions(this._mcpManager) : [];
		this._directMcpToolNames = new Set(directMcpToolDefinitions.map((definition) => definition.name));
		const isSubagentRuntime = this._subagentToolManager?.isSubagentRuntime?.() === true;
		const subagentToolManager =
			this._subagentToolManager &&
			(this._subagentToolManager.listAvailableDefinitions === undefined ||
				this._subagentToolManager.listAvailableDefinitions().length > 0)
				? this._subagentToolManager
				: undefined;
		const subagentRegistryManager =
			isSubagentRuntime &&
			(this._subagentToolManager?.listDelegations !== undefined ||
				this._subagentToolManager?.followDelegation !== undefined)
				? this._subagentToolManager
				: undefined;
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
					edit: { diagnosticsProvider: this._lspManager },
					write: { diagnosticsProvider: this._lspManager },
					imageGen: {
						modelContext: async () => {
							const model = this.model;
							if (!isCodexImageGenerationModel(model)) return undefined;
							const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
							if (!auth.ok) throw new Error(auth.error);
							return { model, apiKey: auth.apiKey, headers: auth.headers };
						},
						recentImages: (count) => {
							const images: ImageContent[] = [];
							for (let messageIndex = this.agent.state.messages.length - 1; messageIndex >= 0; messageIndex--) {
								const message = this.agent.state.messages[messageIndex];
								if (message.role !== "user" && message.role !== "custom" && message.role !== "toolResult") {
									continue;
								}
								if (!Array.isArray(message.content)) continue;
								for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
									const content = message.content[contentIndex];
									if (content.type !== "image") continue;
									images.push(content);
									if (images.length === count) return images.reverse();
								}
							}
							return images.reverse();
						},
						outputRoot: join(this._agentDir, "generated_images", this.sessionManager.getSessionId()),
					},
					webSearch: {
						operations: createDefaultWebSearchOperations({
							fallbackBraveApiKey: () =>
								this._modelRegistry.authStorage.getApiKey(BRAVE_SEARCH_AUTH_PROVIDER, {
									includeFallback: false,
								}),
							modelContext: async () => {
								const model = this.model;
								if (!model) {
									return undefined;
								}
								if (model.provider !== "openai" && model.provider !== "openai-codex") {
									return { model };
								}
								const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
								if (!auth.ok) {
									throw new Error(auth.error);
								}
								return {
									model,
									apiKey: auth.apiKey,
									headers: auth.headers,
									sessionId: this.sessionManager.getSessionId(),
								};
							},
						}),
					},
					webFetch: {
						urlPolicy: { type: "conversation", urls: () => this._collectFetchableUrls() },
					},
					lsp: { provider: this._lspManager },
					...(subagentToolManager
						? {
								subagent: {
									manager: subagentToolManager,
									getAllowedTools: () => {
										const activeToolNames = this.getActiveToolNames();
										if (
											!isSubagentRuntime &&
											(this._allowedToolNames === undefined ||
												this._allowedToolNames.has(SUBAGENT_REGISTRY_TOOL_NAME)) &&
											!this._excludedToolNames?.has(SUBAGENT_REGISTRY_TOOL_NAME)
										) {
											return [...activeToolNames, SUBAGENT_REGISTRY_TOOL_NAME];
										}
										return activeToolNames;
									},
									includeRegistryModes: !isSubagentRuntime,
								},
							}
						: {}),
					...(subagentRegistryManager
						? {
								subagentRegistry: {
									manager: subagentRegistryManager,
									getAllowedTools: () => this.getActiveToolNames(),
								},
							}
						: {}),
					...(this._mcpManager
						? {
								mcp: {
									manager: this._mcpManager,
									isRestrictedTrustedRead: () => this._planningState.mode === "plan",
								},
							}
						: {}),
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		this._trustedHostToolNames = new Set(this._baseToolsOverride ? [] : Object.keys(baseToolDefinitions));
		for (const definition of createPlanningToolDefinitions(this)) {
			this._baseToolDefinitions.set(definition.name, definition as ToolDefinition);
			this._trustedHostToolNames.add(definition.name);
		}
		for (const definition of directMcpToolDefinitions) {
			this._baseToolDefinitions.set(definition.name, definition as ToolDefinition);
		}

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		// May be undefined during construction (first _buildRuntime call).
		const previousRunner: ExtensionRunner | undefined = this._extensionRunner;
		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		// Honor the documented contract: a ctx/volt captured before reload must
		// not be used after reload. No-ops when the new runner shares the old
		// runtime (project-trust rebuild), so live generations are unaffected.
		previousRunner?.invalidateStaleGeneration(extensionsResult.runtime);
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: [
					...DEFAULT_ACTIVE_TOOL_NAMES,
					...(subagentToolManager ? ["subagent"] : []),
					...(this._mcpManager ? ["mcp"] : []),
					...directMcpToolDefinitions.map((definition) => definition.name),
					...(this._lspManager ? ["lsp"] : []),
				];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		this._assertConversationAuthorityAvailable();
		if (this.isStreaming || this.isBashRunning || this.hasActiveSessionMutation) {
			throw new Error(
				"Cannot reload while active session work still owns this runtime; abort or wait for it to finish",
			);
		}
		this._reloadInProgress = true;
		try {
			const previousFlagValues = this._extensionRunner.getFlagValues();
			await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
			await this.sessionManager.flush();
			await this.settingsManager.reload();
			this.syncAgentRuntimeSettingsFromSettings();
			this._modelRegistry.clearRegisteredProviders();
			await this._resourceLoader.reload();
			await this._reloadMcpManager();
			const activeToolNames = this._planningRuntimeInitialized
				? [...this._requestedBuildToolNames]
				: this.getActiveToolNames();
			if (this._mcpManager?.isEnabled() && !this._allowedToolNames && !this._excludedToolNames?.has("mcp")) {
				if (!activeToolNames.includes("mcp")) {
					activeToolNames.push("mcp");
				}
				for (const candidate of this._mcpManager.getDirectToolCandidates()) {
					if (
						!this._excludedToolNames?.has(candidate.directToolName) &&
						!activeToolNames.includes(candidate.directToolName)
					) {
						activeToolNames.push(candidate.directToolName);
					}
				}
			}
			this._buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
			this._refreshCurrentModelFromRegistry();

			const hasBindings =
				this._extensionUIContext ||
				this._extensionCommandContextActions ||
				this._extensionShutdownHandler ||
				this._extensionErrorListener;
			if (hasBindings) {
				await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
				await this.extendResourcesFromExtensions("reload");
			}
			await this.sessionManager.flush();
		} finally {
			this._reloadInProgress = false;
		}
	}

	private async _reloadMcpManager(): Promise<void> {
		if (!this._mcpManagerFactory) {
			return;
		}
		const previousManager = this._mcpManager;
		const nextManager = await this._mcpManagerFactory();
		if (previousManager && previousManager !== nextManager) {
			await previousManager.dispose();
		}
		this._mcpManager = nextManager;
		this._attachMcpManagerEvents();
		if (previousManager !== nextManager) {
			this._emit({ type: "mcp_servers_changed", servers: nextManager?.listServers() ?? [] });
		}
	}

	/** Forward MCP manager lifecycle events into the session event stream. */
	private _attachMcpManagerEvents(): void {
		this._unsubscribeMcpManager?.();
		this._unsubscribeMcpManager = this._mcpManager?.subscribe((event) => {
			this._emit(event);
		});
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		return isTransientProviderError(err);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage, abortGeneration: number): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._disposed || abortGeneration !== this._abortGeneration) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		if (this._disposed || abortGeneration !== this._abortGeneration) {
			this._settleRetry(false, "Retry cancelled");
			return false;
		}

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._settleRetry(false, "Retry cancelled");
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return !this._disposed && abortGeneration === this._abortGeneration;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._assertConversationAuthorityAvailable();
		if (this._disposed) {
			throw new Error("Cannot execute bash on a disposed session");
		}
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot execute bash while a session mutation is active");
		}
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._assertConversationAuthorityAvailable();
		if (this._disposed) return;
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
		this.gitContextProvider.scheduleRefresh();
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;
		this._assertConversationAuthorityAvailable();

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}

	private _sessionNameGenerationInFlight = false;

	/**
	 * Best-effort, fire-and-forget: name an unnamed session from the user's
	 * prompt with a single tiny completion, so session lists show "Fix login
	 * crash" instead of a session-id prefix. Runs concurrently with the turn;
	 * an explicit name set in the meantime wins (checked again before commit).
	 * Never throws and never blocks or fails the prompt itself.
	 */
	private _maybeGenerateSessionName(userText: string, assertConversationGenerationCurrent?: () => void): void {
		if (this._sessionNameGenerationInFlight || this.sessionManager.getSessionName()) {
			return;
		}
		const model = this.model;
		const request = userText.trim();
		if (!model || !request) {
			return;
		}

		this._sessionNameGenerationInFlight = true;
		void (async () => {
			try {
				const { apiKey, headers, env } = await this._getCompactionRequestAuth(model);
				const promptText =
					`Write a short title (3-6 words, plain text, no quotes, no trailing punctuation) ` +
					`for a coding session that starts with this request:\n\n<request>\n${request.slice(0, 2000)}\n</request>\n\n` +
					`Reply with only the title.`;
				const options: SimpleStreamOptions = { maxTokens: 64, apiKey, headers, env };
				const response = await completeSimple(
					model,
					{
						systemPrompt: "You title coding assistant sessions.",
						messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
					},
					options,
				);
				if (response.stopReason === "error") {
					return;
				}
				const name = AgentSession._sanitizeGeneratedSessionName(
					response.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join(" "),
				);
				assertConversationGenerationCurrent?.();
				if (name && !this._disposed && !this.sessionManager.getSessionName()) {
					this.setSessionName(name);
				}
			} catch {
				// Naming is cosmetic; the session keeps its id-derived fallback.
			} finally {
				this._sessionNameGenerationInFlight = false;
			}
		})();
	}

	private static _sanitizeGeneratedSessionName(raw: string): string | undefined {
		const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
		const name = firstLine
			.trim()
			.replace(/^["'`#*\s]+|["'`*\s.]+$/g, "")
			.replace(/\s+/g, " ");
		if (!name) {
			return undefined;
		}
		return name.length > 60 ? `${name.slice(0, 57)}…` : name;
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming || this.isBashRunning) {
			return Promise.reject(
				new Error(
					"Cannot navigate the session tree while an agent or bash run is active; abort or wait for it to finish",
				),
			);
		}
		if (this._hasSessionOperationBarrier) {
			return Promise.reject(new Error("Cannot navigate the session tree while another session mutation is active"));
		}
		return this._trackSessionOperation(() => this._navigateTree(targetId, options));
	}

	private async _navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();
		const assertConversationGenerationCurrent = this._captureConversationGenerationAssertion();
		const assertNavigationCanCommit = (): void => {
			assertConversationGenerationCurrent();
			if (this._agentConversationMutationInFlight) {
				throw new Error(
					"Cannot navigate the session tree while the agent is processing; abort the active run first",
				);
			}
		};

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}
		assertNavigationCanCommit();

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// No provider run or competing navigation may have started while an
			// extension or branch summarizer was awaiting. Otherwise late agent
			// events could be persisted onto the newly selected branch.
			assertNavigationCanCommit();

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			const conversationGenerationChange = {
				previousLeafId: oldLeafId,
				nextLeafId: this.sessionManager.getLeafId(),
			};
			if (conversationGenerationChange.previousLeafId !== conversationGenerationChange.nextLeafId) {
				// Invalidate prompt authority and runtime-only research evidence as soon
				// as the in-memory leaf changes. Observer notification remains behind the
				// durability boundary below.
				this._conversationGenerationRevision++;
				this._planResearchGeneration = undefined;
			}

			// Summary and label entries must be durable before the new branch state
			// and its extension events are published.
			await this.sessionManager.flush();

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			const previousModel = this.model;
			const previousThinkingLevel = this.thinkingLevel;
			const previousPlanningState = clonePlanningState(this._planningState);
			const wasFastModeEnabled = this._fastModeEnabled;
			this.agent.state.messages = sessionContext.messages;
			if (sessionContext.model) {
				const restoredModel = this._modelRegistry.find(sessionContext.model.provider, sessionContext.model.modelId);
				if (restoredModel && this._modelRegistry.hasConfiguredAuth(restoredModel)) {
					this.agent.state.model = restoredModel;
				}
			}
			const restoredThinkingLevel = THINKING_LEVELS.includes(sessionContext.thinkingLevel as ThinkingLevel)
				? (sessionContext.thinkingLevel as ThinkingLevel)
				: previousThinkingLevel;
			const availableThinkingLevels = this.getAvailableThinkingLevels();
			this.agent.state.thinkingLevel = availableThinkingLevels.includes(restoredThinkingLevel)
				? restoredThinkingLevel
				: this._clampThinkingLevel(restoredThinkingLevel, availableThinkingLevels);
			this._restoreFastModePolicy(sessionContext.fastMode);
			this._planningState = clonePlanningState(sessionContext.planning);
			this._syncPlanningRuntime();
			if (JSON.stringify(previousPlanningState) !== JSON.stringify(this._planningState)) {
				this._emitCommittedEvent({ type: "planning_state_changed", planning: this.planningState });
			}
			if (this.thinkingLevel !== previousThinkingLevel) {
				this._emitCommittedEvent({ type: "thinking_level_changed", level: this.thinkingLevel });
				void this._extensionRunner.emit({
					type: "thinking_level_select",
					level: this.thinkingLevel,
					previousLevel: previousThinkingLevel,
				});
			}
			if (wasFastModeEnabled !== this._fastModeEnabled) {
				this._emitFastModeStateChanged();
			}
			if (this.model) {
				await this._emitModelSelect(this.model, previousModel, "restore");
			}
			this._notifyConversationGenerationChange(conversationGenerationChange);

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		// Agent state is the retained model context after compaction. The append-only
		// session entries preserve every message and therefore the lifetime totals.
		const entries = this.sessionManager.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userMessages = messages.filter((message) => message.role === "user").length;
		const assistantMessages = messages.filter((message) => message.role === "assistant").length;
		const toolResults = messages.filter((message) => message.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((content) => content.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: messages.length + entries.filter((entry) => entry.type === "custom_message").length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		await this.sessionManager.flush();
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeDurableAtomicFileSync(filePath, `${lines.join("\n")}\n`, {
			directoryMode: PRIVATE_DIRECTORY_MODE,
			fileMode: PRIVATE_FILE_MODE,
		});
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this._sendCustomMessage(message, options, true);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
