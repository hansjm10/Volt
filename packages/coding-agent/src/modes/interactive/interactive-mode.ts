/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentAbortSource, AgentMessage, ThinkingLevel } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	getProviders,
	type ImageContent,
	type Message,
	type Model,
	modelsAreEqual,
	type OAuthProviderId,
	type OAuthSelectPrompt,
	type SubscriptionUsageError,
} from "@hansjm10/volt-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	RenderSuspensionLease,
	SlashCommand,
	Terminal,
	TuiMainScreenRenderState,
	TuiMode,
} from "@hansjm10/volt-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	isKeyRelease,
	isViewportTUI,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	getShareViewerUrl,
	isStandaloneBinary,
	VERSION,
} from "../../config.ts";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
	QueueClearPersistenceError,
} from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ProjectTrustContext,
	ToolInfo,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import {
	BUILTIN_HOST_ACTION_REGISTRY,
	CONTEXT_COMPACT_SLASH_ALIAS,
	type HostActionInvocationContext,
	REVIEW_EXPORT_FEEDBACK_ACTION_ID,
	REVIEW_FEEDBACK_ACTION_ID,
	REVIEW_FIX_ACTION_ID,
	REVIEW_PUBLISH_ACTION_ID,
	REVIEW_RERUN_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_SLASH_ALIAS,
	THINKING_FAST_MODE_SLASH_ALIAS,
} from "../../core/host-actions.ts";
import type { HostActionRequest, HostActionUpdate, HostInteraction } from "../../core/host-interaction.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { defaultModelPerProvider, findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "../../core/package-manager.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import { parseIrohRemoteRpcGrant } from "../../core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../../core/remote/iroh/handshake.ts";
import { writeIrohRemoteHandshakeResponse } from "../../core/remote/iroh/handshake-reader.ts";
import { createIrohRemoteRpcErrorResponse } from "../../core/remote/iroh/rpc-command-filter.ts";
import { IrohRemoteHostStateManager } from "../../core/remote/iroh/state-manager.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import {
	createReviewSeedMessage,
	formatReviewWorkflowSummary,
	listBaseBranches,
	listRecentCommits,
	parseReviewCommandArgs,
	probeCurrentBranchPullRequest,
	REMOTE_REVIEW_TOOL_NAMES,
	REVIEW_USAGE,
	type ReviewRunControls,
	type ReviewTarget,
	type ReviewWorkflowHooks,
	reviewTargetForRerun,
	runReviewWorkflow,
	stripReviewEnvelopeForDisplay,
} from "../../core/review.ts";
import { publishReviewRun } from "../../core/review-publish.ts";
import {
	acknowledgeReviewRun,
	appendReviewFindingTransition,
	appendReviewPublication,
	appendReviewRun,
	exportReviewFeedback,
	getReviewRun,
} from "../../core/review-state.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { getDefaultSessionDir, type SessionContext, SessionManager } from "../../core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { SubscriptionUsageService } from "../../core/subscription-usage.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { DaemonClientClosedError } from "../../daemon/control-client.ts";
import { RELAY_RPC_COMMAND_TYPES } from "../../daemon/control-protocol.ts";
import {
	getRpcResponseId,
	handleIntegratedConversationRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
	type RemoteSessionListCursorEntry,
} from "../../daemon/conversation-commands.ts";
import {
	createRemoteConversationExternalProjector,
	createRemoteConversationSnapshotBuilder,
} from "../../daemon/conversation-projection.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type IntegratedConversationSessionSelection,
} from "../../daemon/handshake-responses.ts";
import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "../../daemon/worktree-manager.ts";
import {
	findCatalogPackage,
	loadDefaultStoreCatalog,
	type StoreCatalog,
	type StoreCatalogPackage,
	searchCatalogPackages,
} from "../../store/catalog.ts";
import { inspectStorePackage } from "../../store/inspector.ts";
import { buildStoreInstallPlan, type StoreInstallScope } from "../../store/install-plan.ts";
import {
	formatStoreInstallPlanTarget,
	formatStoreProgressMessage,
	formatStoreSourceSummary,
	renderCatalogSearch,
	renderStoreInstallPlan,
	renderStoreShow,
} from "../../store/render.ts";
import { resolveStoreSource } from "../../store/resolver.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	type StoreScopeTarget,
	storeTargetMatchesUpdateSource,
} from "../../store/targets.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { resolvePath } from "../../utils/paths.ts";
import {
	createPrivateTempDirectorySync,
	ensurePrivateDirectorySync,
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
	writePrivateNewFileSync,
} from "../../utils/private-files.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewVoltVersion, type LatestVoltRelease } from "../../utils/version-check.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import { runIrohRemoteRpcMode } from "../rpc/iroh-remote-rpc-mode.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent } from "./components/footer.ts";
import { type HotkeySection, HotkeysComponent } from "./components/hotkeys.ts";
import { PlanInspectorComponent } from "./components/plan-inspector.ts";
import { type PlanDetailsAction, PlanDetailsComponent, PlanStatusComponent } from "./components/plan-status.ts";
import { createRemoteControlBackend, RemoteControlCenterComponent } from "./components/remote-control-center.ts";
import { ResponsivePlanLayoutComponent } from "./components/responsive-plan-layout.ts";
import { isCoalescableAssistantUpdate, StreamingRenderCoalescer } from "./components/streaming-render-coalescer.ts";
import { VoltAnnouncementComponent } from "./components/volt-announcement.ts";
import {
	type AcquireOutcome,
	createDaemonAttach,
	createDisabledDaemonAttach,
	createRelayWorkspaceUnregisterRetirement,
	type DaemonAttach,
	type DaemonRelayOffer,
	type DaemonWorktreeControl,
	getRelayServingSanitizerOptions,
	type OpenedRelay,
	openDaemonWorktreeControl,
	type RelayWorkspaceUnregisterRetirement,
} from "./daemon-attach.ts";
import { DrainViewerComponent } from "./drain-viewer.ts";
import { collectPromptImageAttachments, MAX_PROMPT_IMAGE_ATTACHMENTS } from "./prompt-image-attachments.ts";
import { adaptRelaySocketToIrohStream } from "./relay-stream-adapter.ts";

function isAsciiOnlyTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM ?? "";
	return process.env.VOLT_ASCII === "1" || process.env.TERM === "linux" || termProgram === "";
}

import {
	detectTerminalBackgroundTheme,
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getCurrentThemeName,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	theme,
} from "../../core/theme/runtime.ts";
import {
	editorTopBorderLabelForState,
	formatKeyText,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { StartupHeaderComponent } from "./components/logo.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { type ReviewToolSelectorOption, ReviewToolsSelectorComponent } from "./components/review-tools-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { SubagentInspectorComponent } from "./components/subagent-inspector.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

/** Display-only renderer for an isolated child session streamed inline into the transcript. */
interface InlineSessionRenderer {
	onSessionEvent: (event: AgentSessionEvent) => void;
	dispose: () => void;
}

interface ActiveViewDescriptor {
	regularComponents: readonly Component[];
	fullscreenRoot: Component;
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";
const TURN_DONE_ALERT_BUSY_RETRY_MS = 250;
const STDOUT_FLUSH_TIMEOUT_MS = 1000;

/** Format an elapsed duration for the working indicator, e.g. "42s", "3m 12s", "1h 4m". */
function formatElapsedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Explicit model scope patterns from CLI, preserved across profile switches. */
	modelScopePatterns?: string[];
	/** Cwd to trust after reload if it gained a .volt directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode for this invocation. */
	tuiMode?: TuiMode;
}

interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
}

/** Construct the requested interactive renderer over a shared terminal. */
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch {
					return false;
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable TUI reference used by components while the concrete renderer changes. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private renderer: TuiMainScreen | TuiAltScreen;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private sessionRenderSuspension: RenderSuspensionLease | undefined;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private planStatusContainer: Container;
	private planDetailsContainer: Container;
	private documentContainer: Container;
	private footerContainer: Container;
	private fullscreenTranscript: ScrollView;
	private fullscreenFlexibleSlot: VStack;
	private fullscreenConversationRoot: VStack;
	private conversationView: ActiveViewDescriptor;
	private activeView: ActiveViewDescriptor;
	private planStatus: PlanStatusComponent;
	private planDetails: PlanDetailsComponent | undefined;
	private planInspector: PlanInspectorComponent;
	private mainView: ResponsivePlanLayoutComponent;
	private planPaneReturnFocus: Component | undefined;
	private planPaneInputUnsubscribe: (() => void) | undefined;
	private readyPlanFocusKey: string | undefined;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	private loadingAnimation: Loader | undefined = undefined;
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private turnStartedAt: number | undefined = undefined;
	private workingElapsedTimer: ReturnType<typeof setInterval> | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;
	private activeInteractiveReview = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private streamingRenderCoalescer: StreamingRenderCoalescer<AssistantMessage> | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];
	private scratchDirectories = new Set<string>();
	private clipboardScratchFiles = new Map<string, string>();
	private lspTraceScratchDirectory: string | undefined;

	// Track editor modes that affect the border treatment and label.
	private isBashMode = false;
	private editorHasText = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;
	private turnDoneAlertTimer: ReturnType<typeof setTimeout> | undefined = undefined;

	// Daemon integration (conversation leases + byte relay). Supported TUIs keep
	// a reconnecting client even when auto-start is off, so a daemon started by
	// another process can discover every already-running agent.
	private daemonAttach: DaemonAttach = createDisabledDaemonAttach();
	private daemonRelayServers = new Set<Promise<void>>();
	/** list_sessions cursor state shared across relayed phone conversations. */
	private readonly relaySessionListCursors = new Map<string, RemoteSessionListCursorEntry>();
	/**
	 * Inert state manager for relayed conversation commands: state-touching
	 * commands (RELAY_RPC_COMMAND_TYPES) are forwarded to the daemon; nothing
	 * served locally reads or writes host state.
	 */
	private readonly relayStateManager = new IrohRemoteHostStateManager();
	private daemonLeaseSessionId: string | undefined;
	/** Set once the user explicitly picks a theme this session; daemon theme_snapshot broadcasts then stop applying (local explicit choice wins). */
	private localThemeOverride = false;
	/** Read-only attach overlay while a remote turn drains (§6.3). */
	private drainViewer: DrainViewerComponent | undefined;
	private drainViewerFeedId: string | undefined;
	private dismissSubagentInspector: (() => void) | undefined;
	/** Timestamp of the last quit warning (phone attached + turn streaming). */
	private lastQuitWarningAt = 0;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionSelectorRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionInputRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionEditorRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private readonly subscriptionUsageService = new SubscriptionUsageService();

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.beginSessionReplacementUi();
		});
		this.runtimeHost.setRebindSession(async (session) => {
			await this.rebindReplacementSession(session);
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			onRightClickPaste: this.onRightClickPaste,
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.planStatusContainer = new Container();
		this.planDetailsContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.footerContainer = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			topBorderLabel: this.session.agentMode === "plan" ? "PLAN · AGENT READ-ONLY" : "ASK VOLT · BUILD",
			placeholder: "Type a request or / for commands",
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.planStatus = new PlanStatusComponent(this.session.planningState);
		this.planStatusContainer.addChild(this.planStatus);
		this.planInspector = new PlanInspectorComponent({
			planning: this.session.planningState,
			fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
			onAction: (action) => {
				void this.handlePlanDetailsAction(action);
			},
			onReturnFocus: () => this.focusConversation(),
			onToggleFocus: () => this.togglePlanPaneFocus(),
			requestRender: () => this.ui.requestRender(),
		});
		this.footerDataProvider = new FooterDataProvider(this.session.gitContextProvider);
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerContainer.addChild(this.footer);
		this.fullscreenTranscript = new ScrollView(this.documentContainer, {
			follow: "end",
			primary: true,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		this.fullscreenFlexibleSlot = new VStack([
			{ component: this.fullscreenTranscript, grow: 1, shrink: 1, minSize: 0 },
		]);
		const fullscreenDock = new VStack([
			{ component: this.pendingMessagesContainer, shrink: 4, minSize: 0 },
			{ component: this.statusContainer, shrink: 4, minSize: 0 },
			{ component: this.widgetContainerAbove, shrink: 3, minSize: 0 },
			{
				component: this.planStatusContainer,
				shrink: 2,
				minSize: 0,
				visible: () => !this.mainView.isTerminalSplit(),
			},
			{ component: this.editorContainer, shrink: 1, minSize: 1 },
			{ component: this.widgetContainerBelow, shrink: 3, minSize: 0 },
		]);
		this.fullscreenConversationRoot = new VStack([
			{ component: this.fullscreenFlexibleSlot, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: fullscreenDock, shrink: 1, minSize: 0 },
		]);
		this.mainView = new ResponsivePlanLayoutComponent({
			planning: this.session.planningState,
			transcriptComponents: [this.headerContainer, this.chatContainer],
			controlComponents: [
				this.pendingMessagesContainer,
				this.statusContainer,
				this.widgetContainerAbove,
				this.editorContainer,
				this.widgetContainerBelow,
			],
			compactComponents: [
				this.headerContainer,
				this.chatContainer,
				this.pendingMessagesContainer,
				this.statusContainer,
				this.widgetContainerAbove,
				this.planStatusContainer,
				this.planDetailsContainer,
				this.editorContainer,
				this.widgetContainerBelow,
			],
			fullscreenConversation: this.fullscreenConversationRoot,
			inspector: this.planInspector,
			footer: this.footerContainer,
			getTerminalColumns: () => this.ui.terminal.columns,
			getTerminalRows: () => this.ui.terminal.rows,
			requestViewportReset: () => {
				if (this.renderer instanceof TuiMainScreen) this.renderer.resetViewportOnNextRender();
			},
			onSplitChange: (split, preserveScrollback) => this.handlePlanSplitChange(split, preserveScrollback),
		});
		this.conversationView = {
			regularComponents: [this.mainView],
			fullscreenRoot: this.mainView.getFullscreenLayout(),
		};
		this.activeView = this.conversationView;

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
		this.session.setHostInteraction(this.createHostInteraction());
	}

	private async detectThemeIfUnset(): Promise<void> {
		if (this.settingsManager.getTheme()) {
			return;
		}

		const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
		const result = setTheme(detection.theme, true);
		if (!result.success) {
			return;
		}

		if (detection.confidence === "high") {
			this.settingsManager.setTheme(detection.theme);
			await this.settingsManager.flush();
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const profileCommand = slashCommands.find((command) => command.name === "profile");
		if (profileCommand) {
			profileCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const currentProfile = this.settingsManager.getActiveProfile();
				const items = this.settingsManager.getProfileNames().map((name) => ({
					name,
					isCurrent: name === currentProfile,
				}));
				const filtered = fuzzyFilter(items, prefix, (item) => item.name);
				if (filtered.length === 0) return null;
				return filtered.map((item) => ({
					value: item.name,
					label: item.name,
					description: item.isCurrent ? "current profile" : "profile",
				}));
			};
		}

		const reviewCommand = slashCommands.find((command) => command.name === "review");
		if (reviewCommand) {
			reviewCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const options = ["tools", "uncommitted", "branch", "pr", "commit"];
				const normalized = prefix.trim().toLowerCase();
				const filtered = options.filter((option) => option.startsWith(normalized));
				if (filtered.length === 0) return null;
				return filtered.map((value) => ({ value, label: value }));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Mount the conversation through the renderer-aware view descriptor.
		this.renderWidgets(); // Initialize with default spacer
		this.activateView(this.conversationView, this.editor, false);

		this.setupKeyHandlers();
		this.setupPlanPaneInputRouting();
		this.setupEditorSubmitHandler();
		this.refreshPlanningUi();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		await this.detectThemeIfUnset();

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.plan.togglePane", "to focus the plan pane"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`Volt can explain its own features and look up its docs. Ask it how to use or extend Volt.`,
			);
			this.builtInHeader = new StartupHeaderComponent({
				version: this.version,
				compactInstructions,
				expandedInstructions,
				expansionHint: compactOnboarding,
				onboarding,
				expanded: this.getStartupExpansionState(),
				getTerminalRows: () => this.ui.terminal.rows,
			});

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession(this.session);

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();

		// Start the daemon integration (conversation leases + byte relay). Never
		// blocks startup: failures are silent no-ops.
		await this.initDaemonAttach().catch(() => {});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		checkForNewVoltVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				const images = await this.collectPromptImages(userInput);
				await this.session.prompt(userInput, images ? { images } : undefined);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.VOLT_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Volt works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.VOLT_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		const reportInstallUrl = process.env.VOLT_REPORT_INSTALL_URL;
		if (!reportInstallUrl) {
			return;
		}

		const url = new URL(reportInstallUrl);
		url.searchParams.set("version", version);
		void fetch(url, {
			headers: {
				"User-Agent": getVoltUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string) => theme.bold(theme.fg("accent", name.toUpperCase()));

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const sections: Array<{ name: string; count: number; noun: string; body: string }> = [];
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				sections.push({
					name: "Context",
					count: contextFiles.length,
					noun: "context",
					body: contextFiles.map((file) => theme.fg("dim", `  ${this.formatDisplayPath(file.path)}`)).join("\n"),
				});
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				sections.push({
					name: "Skills",
					count: skills.length,
					noun: skills.length === 1 ? "skill" : "skills",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					}),
				});
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((template) => [template.filePath, template]));
				sections.push({
					name: "Prompts",
					count: templates.length,
					noun: templates.length === 1 ? "prompt" : "prompts",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						formatPackagePath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					}),
				});
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				sections.push({
					name: "Extensions",
					count: extensions.length,
					noun: extensions.length === 1 ? "extension" : "extensions",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						formatPackagePath: (item) =>
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					}),
				});
			}

			const customThemes = themesResult.themes.filter((loadedTheme) => loadedTheme.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				sections.push({
					name: "Themes",
					count: customThemes.length,
					noun: customThemes.length === 1 ? "theme" : "themes",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					}),
				});
			}

			if (sections.length > 0) {
				const resourceSummary = sections.map((section) => `${section.count} ${section.noun}`).join(" · ");
				const resourceDetails = sections
					.map((section) => `${sectionHeader(section.name)}\n${section.body}`)
					.join("\n\n");
				this.chatContainer.addChild(
					new ExpandableText(
						() => `${theme.bold(theme.fg("accent", "RESOURCES"))}${theme.fg("muted", `  ${resourceSummary}`)}`,
						() => resourceDetails,
						this.getStartupExpansionState(),
						1,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(session: AgentSession): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				void this.restoreQueuedMessagesToEditor({ abortSource: "host_action" }).catch((error) => {
					this.showError(`Failed to persist queued-message cancellation: ${String(error)}`);
				});
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();
					try {
						const result = await this.runtimeHost.newSession(options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled, seeded: result.seeded };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isBusy) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	/**
	 * Start the daemon integration (conversation leases + byte relay). On
	 * supported platforms, remote.background controls auto-start only; the TUI
	 * still waits for a daemon started later by another process.
	 */
	private async initDaemonAttach(): Promise<void> {
		const remoteBackground = this.settingsManager.getRemoteSettings().background === true;
		if (process.platform === "win32" || isStandaloneBinary) {
			return;
		}
		this.daemonAttach = createDaemonAttach({
			cwd: this.sessionManager.getCwd(),
			agentDir: getAgentDir(),
			autoStart: remoteBackground,
		});
		this.daemonAttach.onRelayOffer((offer, openRelay) => {
			void this.serveRelayConversation(offer, openRelay);
		});
		this.daemonAttach.onRelayCountChange(() => this.updatePhoneFooterIndicator());
		this.daemonAttach.onReacquired((_sessionId, outcome) => {
			void this.handleReacquireOutcome(outcome);
		});
		this.daemonAttach.onEvent((event) => {
			if (event.type === "theme_snapshot") {
				this.applyDaemonThemeSnapshot(event.themeName);
			}
			if (event.type === "viewer_event" && event.viewerFeedId === this.drainViewerFeedId) {
				this.drainViewer?.handleViewerEvent(event.event);
			}
			if (
				event.type === "viewer_end" &&
				event.viewerFeedId === this.drainViewerFeedId &&
				event.reason !== "granted"
			) {
				this.exitDrainViewer(event.reason);
			}
		});
		await this.daemonAttach.start();
		const acquireOutcome = await this.acquireCurrentSessionLease();
		this.runtimeHost.setPrepareSessionReplacement(async ({ previousSessionId, sessionId, cwd }) => {
			const rekey = await this.daemonAttach.prepareRekey(previousSessionId, sessionId, cwd);
			if (!rekey) {
				return undefined;
			}
			return {
				commit: async () => {
					await rekey.commit();
					this.daemonLeaseSessionId = sessionId;
				},
				rollback: () => rekey.rollback(),
				dispose: async () => {
					await rekey.dispose();
					this.daemonLeaseSessionId = undefined;
				},
			};
		});
		if (acquireOutcome.kind === "granted" || acquireOutcome.kind === "noop") {
			// UI subscriptions and the daemon ownership decision are both complete.
			// Drain any restored durable queue before startup input can overtake it.
			await this.runtimeHost.startRecoveredClientInputs();
		}
	}

	private async acquireCurrentSessionLease(): Promise<AcquireOutcome> {
		if (this.daemonAttach.connectionState() === "disabled") {
			return { kind: "noop" };
		}
		this.daemonLeaseSessionId = this.session.sessionId;
		const outcome = await this.daemonAttach.acquire(this.session.sessionId);
		if (outcome.kind === "denied") {
			// Multi-TUI is a non-goal: another TUI owns the session. Continue in a
			// plain read-from-file open (no live view); the user may retry on action.
			this.showWarning("This conversation is open in another desktop window; live sharing is disabled here.");
		}
		if (outcome.kind === "pending") {
			this.enterDrainViewer(outcome);
		}
		this.updatePhoneFooterIndicator();
		return outcome;
	}

	private async handleReacquireOutcome(outcome: AcquireOutcome): Promise<void> {
		if (outcome.kind === "granted" && (outcome.handoff === "warm" || outcome.handoff === "cold")) {
			// The daemon spun up a runtime during the reconnect gap; absorb any file
			// changes it appended.
			await this.absorbRemoteSessionChangesFromDisk();
			this.renderCurrentSessionState();
			this.ui.requestRender();
		}
		if (outcome.kind === "pending") {
			// A remote turn is mid-flight; watch it finish behind the current
			// transcript, then take over warm.
			this.enterDrainViewer(outcome);
		}
		if (outcome.kind === "granted") {
			await this.runtimeHost.startRecoveredClientInputs().catch(() => undefined);
		}
	}

	/**
	 * Read-only attach overlay while the daemon drains a mid-flight remote turn
	 * (§6.3): viewer events render through the normal message/tool components;
	 * the editor keeps accepting text but never submits; esc stops the remote
	 * turn. On grant the session file is reloaded (authoritative) and whatever
	 * was typed stays in the editor, un-submitted.
	 */
	private enterDrainViewer(pending: Extract<AcquireOutcome, { kind: "pending" }>): void {
		if (this.drainViewer) {
			return;
		}
		this.drainViewerFeedId = pending.viewerFeedId;
		this.drainViewer = new DrainViewerComponent(this.ui, {
			markdownTheme: this.getMarkdownThemeWithSettings(),
			hideThinkingBlock: this.hideThinkingBlock,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			showImages: this.settingsManager.getShowImages(),
			imageWidthCells: this.settingsManager.getImageWidthCells(),
			cwd: this.sessionManager.getCwd(),
			getToolDefinition: (toolName) => this.getRegisteredToolDefinition(toolName),
		});
		this.chatContainer.addChild(this.drainViewer);
		this.ui.requestRender();
		void this.daemonAttach.viewerSubscribe(pending.viewerFeedId);
		pending.granted.then(
			() => {
				void this.finishDrainViewerGrant();
			},
			(error: unknown) => {
				// A transient control-socket drop rejects the grant with
				// DaemonClientClosedError, but the reconnect path
				// (ensureLeaseAfterConnected) re-acquires and re-enters the drain
				// viewer. Tear down the current overlay so that re-enter's guard
				// passes, but do NOT tell the user the handoff failed — it is still in
				// progress. Only a genuine drain failure (a plain Error) surfaces.
				this.exitDrainViewer(error instanceof DaemonClientClosedError ? "reconnecting" : "error");
			},
		);
	}

	/**
	 * Absorb transcript entries another owner (the daemon, during a drain handoff
	 * or a reconnect gap) appended to the session file. session.reload() only
	 * reloads settings/resources — NOT the conversation — so re-open the session
	 * file to pull in the appended turns, rebuilding the in-process transcript and
	 * model context. Falls back to a settings reload when there is no session file
	 * or the re-open is cancelled.
	 */
	private async absorbRemoteSessionChangesFromDisk(): Promise<void> {
		const sessionFile = this.session.sessionFile;
		if (!sessionFile) {
			await this.session.reload().catch(() => {});
			return;
		}
		try {
			const result = await this.runtimeHost.switchSession(sessionFile, {
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				await this.session.reload().catch(() => {});
			}
		} catch {
			await this.session.reload().catch(() => {});
		}
	}

	private async finishDrainViewerGrant(): Promise<void> {
		const viewer = this.drainViewer;
		this.drainViewer = undefined;
		this.drainViewerFeedId = undefined;
		viewer?.finish("Remote turn finished — taking over…");
		// Load what the remote turn wrote; the file is the source of truth. The
		// re-render drops the viewer component; editor text survives un-submitted.
		await this.absorbRemoteSessionChangesFromDisk();
		this.renderCurrentSessionState();
		this.showStatus("Attached — the remote turn finished and this desktop now owns the session.");
		this.ui.requestRender();
		await this.runtimeHost.startRecoveredClientInputs().catch(() => undefined);
	}

	private exitDrainViewer(reason: "cancelled" | "error" | "reconnecting"): void {
		const viewer = this.drainViewer;
		if (!viewer) {
			return;
		}
		this.drainViewer = undefined;
		this.drainViewerFeedId = undefined;
		viewer.finish();
		if (reason === "error") {
			this.showWarning(
				"Attaching failed while a remote turn was streaming; the phone keeps the session. Use /reload to retry.",
			);
		}
		this.ui.requestRender();
	}

	private isDrainViewerActive(): boolean {
		return this.drainViewer !== undefined;
	}

	/**
	 * Serve a relayed phone conversation from this TUI's in-process runtime
	 * (§5.6 step 7-9). The daemon has already authenticated the phone and
	 * resolved the session target; the TUI writes the handshake response itself.
	 */
	private async serveRelayConversation(offer: DaemonRelayOffer, openRelay: () => Promise<OpenedRelay>): Promise<void> {
		let opened: OpenedRelay;
		try {
			opened = await openRelay();
		} catch {
			return;
		}
		const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
		const preamble = opened.preamble;
		const handshake = preamble.handshake as {
			hello: IrohRemoteHello;
			response: IrohRemoteHandshakeSuccess;
			initialInput?: number[];
		};
		const authorizationSubset = preamble.authorization;
		const rpcGrant = parseIrohRemoteRpcGrant(authorizationSubset.rpcGrant, "relay rpcGrant");
		// Worktree-bound conversations sanitize with the worktree checkout as the
		// root; the parent checkout and the worktrees root must also redact.
		const sanitizerOptions = getRelayServingSanitizerOptions(authorizationSubset, getAgentDir());
		const authorization = {
			ok: true as const,
			allowTools: "",
			client: {
				nodeId: authorizationSubset.clientNodeId,
				label: authorizationSubset.clientNodeId,
				allowedWorkspaces: [authorizationSubset.workspaceName],
				allowedTools: "",
				rpcGrant,
				pairedAt: 0,
				lastSeenAt: 0,
			},
			paired: true,
			pairingSecretConsumed: false,
			workspace: { name: authorizationSubset.workspaceName, path: authorizationSubset.workspacePath },
			workspaceNames: [authorizationSubset.workspaceName],
			workspaces: [{ name: authorizationSubset.workspaceName, status: "available" as const }],
		} satisfies IrohRemoteClientAuthorizationSuccess;

		// The daemon's identity from the preamble: the phone verifies the saved
		// host node id in the handshake response and every notification destination.
		const hostNodeId = preamble.hostNodeId;
		if (hostNodeId === undefined) {
			throw new Error("Relay preamble omitted the daemon host node ID");
		}
		const responseContext = {
			hostNodeId,
			relayMode: preamble.relayMode,
			relayUrls: preamble.relayUrls,
		};
		const sessionSelection: IntegratedConversationSessionSelection =
			preamble.resolvedTarget.selection === "created"
				? { kind: "created", sessionId: preamble.resolvedTarget.sessionId }
				: {
						kind: preamble.resolvedTarget.selection,
						requestedSessionId: preamble.resolvedTarget.requestedSessionId ?? preamble.resolvedTarget.sessionId,
						sessionId: preamble.resolvedTarget.sessionId,
					};

		const server = (async () => {
			let workspaceUnregisterRetirement: RelayWorkspaceUnregisterRetirement | undefined;
			try {
				// The TUI writes the handshake success response itself, keeping
				// construction identical to the daemon-owned path.
				const handshakeResponse = createIntegratedConversationHandshakeResponse(
					{ hello: handshake.hello, response: handshake.response },
					authorization,
					this.session.sessionId,
					sessionSelection,
					responseContext,
					preamble.resolvedTarget.worktreeId,
					preamble.resolvedTarget.workingDirectory,
				);
				await writeIrohRemoteHandshakeResponse(relayedStream.send, handshakeResponse);

				// The relayed runtime's session id can change in place (resume/new/fork
				// over the same relay). Track the rolling id so each rekey passes the
				// correct previous id; the immutable offer.sessionId would be stale after
				// the first change and the daemon's lookup would silently no-op, leaving
				// the lease keyed on an old session id.
				let relayedSessionId = offer.sessionId;
				workspaceUnregisterRetirement = createRelayWorkspaceUnregisterRetirement(
					this.daemonAttach,
					() => relayedSessionId,
				);
				await runIrohRemoteRpcMode(this.runtimeHost, {
					rpcGrant,
					hostNodeId,
					isRpcIngressOpen: workspaceUnregisterRetirement.isIngressOpen,
					clientNodeId: authorizationSubset.clientNodeId,
					stream: relayedStream,
					disposeRuntimeOnClose: false,
					workspaceName: authorization.workspace.name,
					workspacePath: sanitizerOptions.workspacePath,
					...(sanitizerOptions.remoteWorkspacePath === undefined
						? {}
						: { remoteWorkspacePath: sanitizerOptions.remoteWorkspacePath }),
					...(sanitizerOptions.additionalRedactedPaths === undefined
						? {}
						: { additionalRedactedPaths: sanitizerOptions.additionalRedactedPaths }),
					suppressExtensionUiRequests: true,
					decorateOutbound: (value) => decorateRemoteHostState(value, authorization, responseContext),
					buildConversationSnapshot: createRemoteConversationSnapshotBuilder({
						authorization,
						runtime: this.runtimeHost,
					}),
					projectConversationExternal: createRemoteConversationExternalProjector({
						authorization,
						runtime: this.runtimeHost,
					}),
					onReady: () => {
						void this.runtimeHost.startRecoveredClientInputs().catch(() => undefined);
					},
					onResponseWritten: (response) => workspaceUnregisterRetirement?.onResponseWritten(response),
					initialInput: handshake.initialInput,
					notificationDelivery: {
						deliverNotification: (notification) =>
							this.daemonAttach.relayNotificationDelivery.deliverNotification(
								authorizationSubset.clientNodeId,
								relayedSessionId,
								notification,
							),
					},
					remoteCommandHandler: async (command) => {
						const rpcCommand = command as { type: string } & Record<string, unknown>;
						if (RELAY_RPC_COMMAND_TYPES.has(rpcCommand.type)) {
							// State-touching commands (push targets and workspace
							// unregister) must run against the daemon's state;
							// the TUI has no host state of its own.
							const forwarded = await this.daemonAttach.forwardRelayRpc(
								authorizationSubset.clientNodeId,
								relayedSessionId,
								rpcCommand,
							);
							if (!forwarded) {
								return createIrohRemoteRpcErrorResponse(
									getRpcResponseId(rpcCommand),
									rpcCommand.type,
									"daemon_unavailable",
								);
							}
							workspaceUnregisterRetirement?.observeForwardedResponse(rpcCommand, forwarded.response);
							if (forwarded.workspaceMetadata) {
								authorization.workspaceNames = [...forwarded.workspaceMetadata.workspaceNames];
								authorization.workspaces = forwarded.workspaceMetadata.workspaces.map((workspace) => ({
									...workspace,
								})) as typeof authorization.workspaces;
							}
							return forwarded.response;
						}
						return handleIntegratedConversationRpcCommand(
							rpcCommand,
							authorization,
							{
								stateManager: this.relayStateManager,
								sessionListCursors: this.relaySessionListCursors,
								sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
								getConversationBranchEpoch: () => this.runtimeHost.conversationProjectionFeed.branchEpoch,
								isConversationTranscriptCursorValid: (cursor) =>
									this.runtimeHost.conversationProjectionFeed.isTranscriptCursorValid(cursor),
								registerConversationTranscriptCursor: (cursor) =>
									this.runtimeHost.conversationProjectionFeed.registerTranscriptCursor(cursor),
								listRuntimeStates: (workspaceName) => this.daemonAttach.listRuntimeStates(workspaceName),
							},
							this.runtimeHost,
						);
					},
					onSessionChanged: (session) => {
						relayedSessionId = session.sessionId;
					},
				});
			} catch {
				// Relay teardown surfaces to the phone via the daemon's close reason.
			} finally {
				await workspaceUnregisterRetirement?.finalize();
				relayedStream.close();
				opened.finished();
			}
		})();
		this.daemonRelayServers.add(server);
		void server.finally(() => this.daemonRelayServers.delete(server));
		this.updatePhoneFooterIndicator();
		await server;
	}

	/**
	 * Apply a daemon-broadcast theme change (theme_set control request or an
	 * extension setTheme in a daemon-owned runtime) unless the user explicitly
	 * picked a theme in this TUI session.
	 */
	private applyDaemonThemeSnapshot(themeName: string): void {
		if (this.localThemeOverride || getCurrentThemeName() === themeName) {
			return;
		}
		const result = setTheme(themeName, true);
		if (result.success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	private updatePhoneFooterIndicator(): void {
		const count = this.daemonAttach.relayCount();
		const label = count >= 1 ? (isAsciiOnlyTerminal() ? `[phone ${count}]` : `📱 ${count}`) : undefined;
		this.footerDataProvider.setExtensionStatus("__phone_attached", label);
		this.footer.invalidate();
		this.ui.requestRender();
	}

	private async releaseDaemonLeaseOnQuit(): Promise<void> {
		if (this.daemonAttach.connectionState() === "disabled") {
			return;
		}
		try {
			await this.daemonAttach.release(this.session.sessionId);
			await this.daemonAttach.dispose();
		} catch {
			// Daemon-side implicit release on disconnect covers any failure here.
		}
	}

	private applyFullscreenScrollbarSetting(mode = this.settingsManager.getFullscreenScrollbar()): void {
		this.fullscreenTranscript.setScrollbar(mode);
		this.planInspector.setFullscreenScrollbar(mode);
		this.planDetails?.setFullscreenScrollbar(mode);
	}

	private applyRuntimeSettings(session: AgentSession): void {
		const settingsManager = session.settingsManager;
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting(settingsManager.getFullscreenScrollbar());
		this.footer.setSession(session);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.footerDataProvider.setGitContextProvider(session.gitContextProvider);
		this.hideThinkingBlock = settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(settingsManager.getClearOnShrink());
		const editorPaddingX = settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private beginSessionReplacementUi(): void {
		this.sessionRenderSuspension ??= this.ui.suspendRendering();
		this.dismissSubagentInspector?.();
		this.resetExtensionUI();
	}

	private async rebindReplacementSession(session: AgentSession): Promise<void> {
		await this.rebindCurrentSession(session);
		this.ui.requestRender(true);
		const suspension = this.sessionRenderSuspension;
		this.sessionRenderSuspension = undefined;
		suspension?.release();
	}

	private async rebindCurrentSession(session: AgentSession): Promise<void> {
		if (this.session !== session) {
			throw new Error("Agent session changed before interactive rebind");
		}
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings(session);
		session.setHostInteraction(this.createHostInteraction());
		await this.bindCurrentSessionExtensions(session);
		if (this.session !== session) {
			throw new Error("Agent session changed during interactive rebind");
		}
		this.subscribeToAgent(session);
		await this.updateAvailableProviderCount();
		this.closePlanDetails();
		this.refreshPlanningUi();
		this.updateTerminalTitle();
		await this.reconcileDaemonLease();
	}

	/**
	 * Keep the daemon lease pointed at the currently open session. Called after
	 * every session (re)bind: releases the previous lease and acquires the new
	 * one when the session id changed (/new, resume, fork, tree navigation).
	 */
	private async reconcileDaemonLease(): Promise<void> {
		if (this.daemonAttach.connectionState() === "disabled") {
			return;
		}
		const sessionId = this.session.sessionId;
		if (this.daemonLeaseSessionId === sessionId) {
			return;
		}
		const previous = this.daemonLeaseSessionId;
		this.daemonLeaseSessionId = sessionId;
		if (previous !== undefined) {
			await this.daemonAttach.release(previous).catch(() => {});
		}
		await this.acquireCurrentSessionLease();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingRenderCoalescer?.dispose();
		this.streamingRenderCoalescer = undefined;
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.disposePendingTools();
		this.renderInitialMessages();
		this.refreshPlanningUi();
	}

	/**
	 * Discarded tool rows never see a terminal render, so their renderer
	 * resources (e.g. the subagent repaint interval) must be released here.
	 */
	private disposePendingTools(): void {
		for (const component of this.pendingTools.values()) {
			component.dispose();
		}
		this.pendingTools.clear();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isBusy,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.signal,
			abort: () => {
				void this.restoreQueuedMessagesToEditor({ abortSource: "host_action" }).catch((error) => {
					this.showError(`Failed to persist queued-message cancellation: ${String(error)}`);
				});
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private getWorkingLoaderMessage(): string {
		const base = this.workingMessage ?? this.defaultWorkingMessage;
		if (this.turnStartedAt === undefined) return base;
		const elapsed = formatElapsedDuration(Date.now() - this.turnStartedAt);
		return `${base} (${elapsed} · ${keyText("app.interrupt")} to interrupt)`;
	}

	private startWorkingElapsedTicker(): void {
		this.stopWorkingElapsedTicker();
		this.workingElapsedTimer = setInterval(() => {
			this.loadingAnimation?.setMessage(this.getWorkingLoaderMessage());
		}, 1000);
	}

	private stopWorkingElapsedTicker(): void {
		if (this.workingElapsedTimer) {
			clearInterval(this.workingElapsedTimer);
			this.workingElapsedTimer = undefined;
		}
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	private stopWorkingLoader(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	private clearTurnDoneAlertTimer(): void {
		if (!this.turnDoneAlertTimer) return;
		clearTimeout(this.turnDoneAlertTimer);
		this.turnDoneAlertTimer = undefined;
	}

	private scheduleTurnDoneAlert(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		this.clearTurnDoneAlertTimer();
		if (this.settingsManager.getTurnDoneAlert() === "off" || event.willRetry || this.shutdownRequested) {
			return;
		}

		let stopReason: AssistantMessage["stopReason"] | undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message?.role === "assistant") {
				stopReason = (message as AssistantMessage).stopReason;
				break;
			}
		}
		if (stopReason === "aborted") {
			return;
		}

		this.scheduleTurnDoneAlertTimer(0);
	}

	private scheduleTurnDoneAlertTimer(delayMs: number): void {
		this.turnDoneAlertTimer = setTimeout(() => {
			this.turnDoneAlertTimer = undefined;
			if (this.settingsManager.getTurnDoneAlert() === "off" || this.shutdownRequested || this.isShuttingDown) {
				return;
			}
			if (this.session.isStreaming || this.session.isCompacting || this.session.isRetrying) {
				this.scheduleTurnDoneAlertTimer(TURN_DONE_ALERT_BUSY_RETRY_MS);
				return;
			}

			// Skip the alert when the terminal reports that it is focused - the user
			// is already looking at it. Terminals without focus reporting stay
			// "unknown" and keep alerting as before.
			if (this.ui.terminal.focusState === "focused") {
				return;
			}

			if (this.settingsManager.getTurnDoneAlert() === "notify") {
				const dir = path.basename(this.sessionManager.getCwd());
				this.ui.terminal.notify("Volt", `Finished responding · ${dir}`);
			} else {
				this.ui.terminal.alert();
			}
		}, delayMs);
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearTurnDoneAlertTimer();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(this.getWorkingLoaderMessage());
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			// Create and mount a custom footer inside the stable footer container.
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			// Restore the built-in footer without changing top-level composition.
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createHostInteraction(): HostInteraction {
		return {
			requestAction: (request, options) => this.requestHostAction(request, options),
			updateAction: (update) => this.updateHostAction(update),
		};
	}

	private async requestHostAction(
		request: HostActionRequest,
		options?: { signal?: AbortSignal },
	): Promise<{ decision: "approved" | "denied" | "dismissed" }> {
		if (options?.signal?.aborted) {
			return { decision: "dismissed" };
		}
		const details = [request.message, request.commandPreview ? `Command: ${request.commandPreview}` : undefined]
			.filter((line): line is string => line !== undefined && line.length > 0)
			.join("\n\n");
		const confirmed = await this.showExtensionConfirm(request.title, details, {
			signal: options?.signal,
			timeout: request.timeoutMs,
		});
		return { decision: confirmed ? "approved" : "denied" };
	}

	private updateHostAction(update: HostActionUpdate): void {
		if (update.status === "running") {
			this.showStatus(update.message ?? "Running host action...");
		} else if (update.status === "completed") {
			this.showStatus(update.message ?? "Host action completed");
		} else if (update.status === "failed") {
			this.showWarning(update.message ?? "Host action failed");
		} else if (update.status === "cancelled") {
			this.showStatus(update.message ?? "Host action cancelled");
		}
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(this.getWorkingLoaderMessage());
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.localThemeOverride = true;
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.localThemeOverride = true;
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelectorRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.activateView(this.createDedicatedView(this.extensionSelector), this.extensionSelector);
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		const restore = this.extensionSelectorRestore;
		this.extensionSelectorRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		// A missing daemon-managed worktree checkout refuses takeover with a clear
		// error instead of resurrecting the session in another directory (§5.2.3).
		if (isPathUnderWorktreesRoot(this.runtimeHost.services.agentDir, error.issue.sessionCwd)) {
			this.showError(
				`This session ran in a daemon-managed worktree whose checkout is missing: ${error.issue.sessionCwd}. ` +
					"Recreate the worktree (volt remote worktree add) or remove the session; refusing to open it in another directory.",
			);
			return undefined;
		}
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInputRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.activateView(this.createDedicatedView(this.extensionInput), this.extensionInput);
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		const restore = this.extensionInputRestore;
		this.extensionInputRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditorRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.activateView(this.createDedicatedView(this.extensionEditor), this.extensionEditor);
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		const restore = this.extensionEditorRestore;
		this.extensionEditorRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			newEditor.setTopBorderLabel?.(
				editorTopBorderLabelForState({
					bashMode: this.isBashMode,
					streaming: this.session.isStreaming,
					hasText: currentText.length > 0,
					agentMode: this.session.agentMode,
				}),
			);

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();

		const restoreView = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.activateView(previousView, previousFocus ?? this.editor, false);
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreView();
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								return typeof options.overlayOptions === "function"
									? options.overlayOptions()
									: options.overlayOptions;
							}
							// Fallback: use component's width property if available
							const width = (component as { width?: number }).width;
							return width ? { width } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.activateView(this.createDedicatedView(component), component);
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreView();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	private createScratchDirectory(prefix: string): string {
		const directoryPath = createPrivateTempDirectorySync(path.join(os.tmpdir(), prefix));
		this.scratchDirectories.add(directoryPath);
		return directoryPath;
	}

	private removeScratchDirectory(directoryPath: string): void {
		try {
			fs.rmSync(directoryPath, { recursive: true, force: true });
			this.scratchDirectories.delete(directoryPath);
			if (this.lspTraceScratchDirectory === directoryPath) {
				this.lspTraceScratchDirectory = undefined;
			}
			for (const [filePath, scratchDirectory] of this.clipboardScratchFiles) {
				if (scratchDirectory === directoryPath) {
					this.clipboardScratchFiles.delete(filePath);
				}
			}
		} catch {
			// Cleanup is retried during shutdown.
		}
	}

	private cleanupClipboardScratchFilesInText(text: string): void {
		this.cleanupClipboardScratchFiles(
			[...this.clipboardScratchFiles.keys()].filter((filePath) => text.includes(filePath)),
		);
	}

	private cleanupClipboardScratchFiles(filePaths: readonly string[]): void {
		for (const filePath of filePaths) {
			const directoryPath = this.clipboardScratchFiles.get(filePath);
			if (directoryPath) {
				this.removeScratchDirectory(directoryPath);
			}
		}
	}

	private cleanupAllScratchDirectories(): void {
		for (const directoryPath of [...this.scratchDirectories]) {
			this.removeScratchDirectory(directoryPath);
		}
	}

	private async closeLspTrace(): Promise<void> {
		await this.session.setLspTraceFile(undefined);
		if (this.lspTraceScratchDirectory) {
			this.removeScratchDirectory(this.lspTraceScratchDirectory);
		}
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.isDrainViewerActive()) {
				// Stop the draining remote turn (non-destructive abort); the drain
				// then completes and the handoff proceeds.
				const feedId = this.drainViewerFeedId;
				if (feedId) {
					void this.daemonAttach.viewerAbort(feedId);
					this.showStatus("Stopping the remote turn…");
				}
				return;
			}
			if (this.session.isStreaming) {
				void this.restoreQueuedMessagesToEditor({ abortSource: "keyboard_interrupt" }).catch((error) => {
					this.showError(`Failed to persist queued-message cancellation: ${String(error)}`);
				});
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.mode.toggle", () => this.runKeyAction(() => this.toggleAgentMode()));
		this.defaultEditor.onAction("app.model.cycleForward", () => this.runKeyAction(() => this.cycleModel("forward")));
		this.defaultEditor.onAction("app.model.cycleBackward", () =>
			this.runKeyAction(() => this.cycleModel("backward")),
		);

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.runKeyAction(() => this.openExternalEditor()));
		this.defaultEditor.onAction("app.message.followUp", () => this.runKeyAction(() => this.handleFollowUp()));
		this.defaultEditor.onAction("app.message.dequeue", () => this.runKeyAction(() => this.handleDequeue()));
		this.defaultEditor.onAction("app.session.new", () => this.runKeyAction(() => this.handleClearCommand()));
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());
		this.defaultEditor.onAction("app.subagents.open", () => this.showSubagentInspector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			const hadText = this.editorHasText;
			this.isBashMode = text.trimStart().startsWith("!");
			this.editorHasText = text.length > 0;
			if (wasBashMode !== this.isBashMode || (this.session.isStreaming && hadText !== this.editorHasText)) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private setupPlanPaneInputRouting(): void {
		this.planPaneInputUnsubscribe?.();
		this.planPaneInputUnsubscribe = this.ui.addInputListener((data) => {
			if (
				isKeyRelease(data) ||
				this.activeView !== this.conversationView ||
				!this.keybindings.matches(data, "app.plan.togglePane")
			) {
				return undefined;
			}
			const focused = this.ui.getFocusedComponent();
			if (
				focused !== this.planInspector &&
				focused !== this.planDetails &&
				(focused === null || !this.editorContainer.children.includes(focused))
			) {
				return undefined;
			}
			this.togglePlanPaneFocus();
			return { consume: true };
		});
	}

	private createHostActionContext(): HostActionInvocationContext {
		return {
			session: this.session,
			abortRun: () => this.session.abort("host_action"),
			compactContext: (customInstructions) => this.session.compact(customInstructions),
			newSession: (newSessionOptions) => this.runtimeHost.newSession(newSessionOptions),
			renameSession: (name) => {
				this.session.setSessionName(name);
			},
			setFastModeEnabled: (enabled) => {
				this.session.setFastModeEnabled(enabled);
			},
			setAgentMode: (mode) => this.session.setAgentMode(mode),
			executePlan: (planId, expectedRevision, strategy) =>
				this.runtimeHost.executePlan(planId, expectedRevision, strategy),
			changePlan: (planId, expectedRevision) => this.session.changePlan(planId, expectedRevision),
			discardPlan: (planId, expectedRevision) => this.session.discardPlan(planId, expectedRevision),
			runReviewAction: (target, reviewOptions) =>
				this.runInteractiveReviewWorkflow(target, {
					tools: reviewOptions.remote ? REMOTE_REVIEW_TOOL_NAMES : this.getReviewToolsForRun(),
					requireConfirmation: reviewOptions.requireConfirmation,
					requireProjectTrust: reviewOptions.remote,
					controls: reviewOptions.controls,
					...(reviewOptions.parentRunId ? { parentRunId: reviewOptions.parentRunId } : {}),
				}),
			runReviewLifecycleAction: (action, args) => this.runInteractiveReviewLifecycleAction(action, args),
		};
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Clipboard paste is best-effort.
		}
	}

	private async handleClipboardImagePaste(): Promise<void> {
		let scratchDirectory: string | undefined;
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			scratchDirectory = this.createScratchDirectory("volt-clipboard-");
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = path.join(scratchDirectory, `image.${ext}`);
			writePrivateNewFileSync(filePath, Buffer.from(image.bytes));
			this.clipboardScratchFiles.set(filePath, scratchDirectory);

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			if (scratchDirectory) {
				this.removeScratchDirectory(scratchDirectory);
			}
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	/**
	 * Scan submitted prompt text for image file paths and load them as
	 * attachments. Returns undefined for text-only models (paths stay plain
	 * text) and for extension commands, which manage their own input.
	 */
	private async collectPromptImages(text: string): Promise<ImageContent[] | undefined> {
		if (this.isExtensionCommand(text)) {
			return undefined;
		}
		let result: Awaited<ReturnType<typeof collectPromptImageAttachments>>;
		try {
			result = await collectPromptImageAttachments(text, process.cwd(), this.session.model);
		} catch {
			return undefined;
		}
		if (!result) {
			return undefined;
		}
		try {
			if (result.attachedPaths.length > 0) {
				const names = result.attachedPaths.map((filePath) => path.basename(filePath));
				this.showStatus(`[attached ${names.join(", ")} as image${names.length > 1 ? "s" : ""}]`);
			}
			if (result.cappedPaths.length > 0) {
				this.showWarning(
					`Only the first ${MAX_PROMPT_IMAGE_ATTACHMENTS} images were attached; ${result.cappedPaths.length} more left as plain text.`,
				);
			}
			if (result.failedPaths.length > 0) {
				this.showWarning(
					`Could not attach ${result.failedPaths.map((filePath) => path.basename(filePath)).join(", ")} (unreadable or too large); left as plain text.`,
				);
			}
			return result.images.length > 0 ? result.images : undefined;
		} finally {
			// Attached images have already been copied into the model payload. Capped
			// or failed paths remain available as plain-text file references.
			this.cleanupClipboardScratchFiles(result.attachedPaths);
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			if (this.isDrainViewerActive()) {
				// Read-only while the remote turn drains: keep the text in the editor
				// (it lands un-submitted once the handoff completes).
				this.showStatus("Attaching — input will stay in the editor until the remote turn finishes.");
				return;
			}

			// Handle commands
			if (text === "/plan") {
				this.editor.setText("");
				this.refreshPlanningUi(await this.session.setAgentMode("plan"));
				this.showStatus("Plan mode: agent tools are read-only");
				return;
			}
			if (text === "/build") {
				this.editor.setText("");
				this.refreshPlanningUi(await this.session.setAgentMode("build"));
				this.showStatus("Build mode");
				return;
			}
			if (text === "/plan-details") {
				this.editor.setText("");
				this.showPlanDetails();
				return;
			}
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/profile" || text.startsWith("/profile ")) {
				const profileName = text.startsWith("/profile ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleProfileCommand(profileName);
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/fast" || text.startsWith("/fast ")) {
				this.editor.setText("");
				await this.handleFastCommand(text);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				await this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/usage") {
				this.editor.setText("");
				await this.handleUsageCommand();
				return;
			}
			if (text === "/lsp" || text.startsWith("/lsp ")) {
				await this.handleLspCommand(text.startsWith("/lsp ") ? text.slice(5).trim() : undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/mcp" || text.startsWith("/mcp ")) {
				await this.handleMcpCommand(text.startsWith("/mcp ") ? text.slice(5).trim() : undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/remote") {
				this.showRemoteControlCenter();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/subagents") {
				this.showSubagentInspector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/worktree" || text.startsWith("/worktree ")) {
				const worktreeArgs = text === "/worktree" ? "" : text.slice("/worktree ".length).trim();
				this.editor.setText("");
				await this.handleWorktreeCommand(worktreeArgs);
				return;
			}
			if (text === "/store" || text.startsWith("/store ")) {
				const args = text === "/store" ? "" : text.slice(7).trim();
				this.editor.setText("");
				await this.handleStoreInteractiveCommand(args);
				return;
			}
			if (text === "/extensions") {
				this.editor.setText("");
				await this.handleExtensionsInteractiveCommand();
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/clear") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/review" || text.startsWith("/review ")) {
				const reviewArgs = text.startsWith("/review ") ? text.slice(8) : "";
				this.editor.setText("");
				await this.handleReviewCommand(reviewArgs);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/voltannouncement") {
				this.handleVoltAnnouncement();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				if (!this.confirmQuitWithAttachedPhone()) {
					return;
				}
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				const images = await this.collectPromptImages(text);
				await this.session.prompt(text, { streamingBehavior: "steer", images });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(session: AgentSession): void {
		this.unsubscribe = session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				this.disposePendingTools();
				this.turnStartedAt = event.startedAt;
				this.startWorkingElapsedTicker();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.updateEditorBorderColor(true);
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "planning_state_changed":
				this.refreshPlanningUi(event.planning);
				break;

			case "ui_action_state_changed":
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingRenderCoalescer?.dispose();
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingRenderCoalescer = new StreamingRenderCoalescer((message) => {
						this.streamingComponent?.updateContent(message);
						this.ui.requestRender();
					});
					this.streamingRenderCoalescer.commitNow(this.streamingMessage);
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					if (isCoalescableAssistantUpdate(event.assistantMessageEvent.type)) {
						this.streamingRenderCoalescer?.update(this.streamingMessage);
					} else {
						this.streamingRenderCoalescer?.commitNow(this.streamingMessage);
					}

					if (event.assistantMessageEvent.type.startsWith("toolcall_")) {
						for (const content of this.streamingMessage.content) {
							if (content.type === "toolCall") {
								if (!this.pendingTools.has(content.id)) {
									const component = new ToolExecutionComponent(
										content.name,
										content.id,
										content.arguments,
										{
											showImages: this.settingsManager.getShowImages(),
											imageWidthCells: this.settingsManager.getImageWidthCells(),
										},
										this.getRegisteredToolDefinition(content.name),
										this.ui,
										this.sessionManager.getCwd(),
									);
									component.setExpanded(this.toolOutputExpanded);
									this.chatContainer.addChild(component);
									this.pendingTools.set(content.id, component);
								} else {
									const component = this.pendingTools.get(content.id);
									component?.updateArgs(content.arguments);
								}
							}
						}
					}
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage = { ...this.streamingMessage, errorMessage };
					}
					if (this.streamingRenderCoalescer) {
						this.streamingRenderCoalescer.finish(this.streamingMessage);
					} else {
						this.streamingComponent.updateContent(this.streamingMessage);
					}

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.disposePendingTools();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingRenderCoalescer = undefined;
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.stopWorkingElapsedTicker();
				this.turnStartedAt = undefined;
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				this.streamingRenderCoalescer?.dispose();
				this.streamingRenderCoalescer = undefined;
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.disposePendingTools();

				this.scheduleTurnDoneAlert(event);
				this.updateEditorBorderColor(false);

				this.ui.requestRender();
				break;

			case "agent_settled":
				await this.checkShutdownRequested();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				const retryMessage = (seconds: number) =>
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.disposePendingTools();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					"This project is not trusted. Project .volt resources and packages are ignored. Use /trust to save a trust decision, then restart volt.",
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		if (!this.confirmQuitWithAttachedPhone()) {
			return;
		}
		void this.shutdown();
	}

	/**
	 * Quit seam (§6.2): when a phone is attached over a relay and a turn is
	 * streaming, quitting kills the turn (the daemon resumes from the file, not
	 * the in-flight state). Require a second quit within 3s to confirm.
	 */
	private confirmQuitWithAttachedPhone(): boolean {
		if (!this.session.isStreaming || this.daemonAttach.relayCount() < 1) {
			return true;
		}
		const now = Date.now();
		if (now - this.lastQuitWarningAt < 3000) {
			return true;
		}
		this.lastQuitWarningAt = now;
		this.showWarning(
			"A phone is attached and a turn is streaming; quitting will kill the turn. Quit again to confirm.",
		);
		return false;
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async flushStdout(): Promise<void> {
		await new Promise<void>((resolve) => {
			let settled = false;
			const timeout = setTimeout(settle, STDOUT_FLUSH_TIMEOUT_MS);
			function settle() {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				process.stdout.off("error", settle);
				resolve();
			}
			process.stdout.once("error", settle);
			try {
				process.stdout.write("", settle);
			} catch {
				settle();
			}
		});
	}

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		const rememberActiveProfile = async () => {
			this.settingsManager.rememberActiveProfile();
			await this.settingsManager.flush();
		};
		await this.closeLspTrace().catch(() => {});
		this.cleanupAllScratchDirectories();

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			// Hand the session back to the daemon only after the runtime finished
			// writing the session file, so the daemon's lazy resume sees final state.
			await this.releaseDaemonLeaseOnQuit();
			await rememberActiveProfile();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			await this.flushStdout();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();
		// Hand the session back to the daemon only after the runtime finished
		// writing the session file, so the daemon's lazy resume sees final state.
		await this.releaseDaemonLeaseOnQuit();
		await rememberActiveProfile();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		await this.flushStdout();
		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		this.session.closeLspTraceSync();
		this.cleanupAllScratchDirectories();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		this.session.closeLspTraceSync();
		this.cleanupAllScratchDirectories();
		console.error("volt exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in volt) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode without printing a fullscreen transcript).
			this.ui.stop({ preserveScreen: this.ui.mode === "fullscreen" });

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			const images = await this.collectPromptImages(text);
			await this.session.prompt(text, { streamingBehavior: "followUp", images });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	/**
	 * Run an async keybinding handler from CustomEditor's synchronous `() => void`
	 * dispatch. Without this the returned promise is dropped, and a rejection
	 * becomes an unhandled rejection that Node raises as an uncaught exception —
	 * tearing the TUI down through uncaughtCrash instead of reporting the error.
	 */
	private runKeyAction(action: () => Promise<void>): void {
		void action().catch((error) => {
			this.showError(error instanceof Error ? error.message : String(error));
		});
	}

	private async handleDequeue(): Promise<void> {
		let restored: number;
		try {
			restored = await this.restoreQueuedMessagesToEditor();
		} catch (error) {
			if (error instanceof QueueClearPersistenceError) {
				// The text is back in the editor; only its cancellation is unrecorded.
				this.showError(`Failed to persist queued-message cancellation: ${error.message}`);
				return;
			}
			throw error;
		}
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(streaming = this.session.isStreaming): void {
		this.editor.borderColor = this.isBashMode
			? theme.getBashModeBorderColor()
			: theme.getThinkingBorderColor(this.session.thinkingLevel || "off");
		this.editor.setTopBorderLabel?.(
			editorTopBorderLabelForState({
				bashMode: this.isBashMode,
				streaming,
				hasText: this.editor.getText().length > 0,
				agentMode: this.session.agentMode,
			}),
		);
		this.ui.requestRender();
	}

	private async toggleAgentMode(): Promise<void> {
		const planning = await this.session.toggleAgentMode();
		this.refreshPlanningUi(planning);
		this.showStatus(planning.mode === "plan" ? "Plan mode: agent tools are read-only" : "Build mode");
	}

	private refreshPlanningUi(planning = this.session.planningState): void {
		this.planStatus.setPlanning(planning);
		this.planInspector.setPlanning(planning);
		this.mainView.setPlanning(planning);
		const plan = planning.plan;
		const split = this.mainView.isTerminalSplit();
		if (split && this.planDetails) {
			this.focusPlanInspector();
			this.closePlanDetails({ focusConversation: false });
		} else if (this.planDetails && plan) {
			this.planDetails.setPlan(plan);
		} else if (this.planDetails && !plan) {
			this.closePlanDetails();
		}
		if (!split) this.focusConversation(true);
		this.updateEditorBorderColor();
		if (plan?.phase === "ready") {
			const readyKey = `${plan.id}:${plan.revision}`;
			if (split) {
				if (this.readyPlanFocusKey !== readyKey && this.focusPlanInspector()) this.readyPlanFocusKey = readyKey;
			} else if (!this.planDetails && this.activeView === this.conversationView) {
				this.showPlanDetails();
				this.readyPlanFocusKey = readyKey;
			}
		} else {
			this.readyPlanFocusKey = undefined;
		}
		this.ui.requestRender();
	}

	private showPlanDetails(): void {
		if (this.mainView.isTerminalSplit()) {
			this.focusPlanInspector();
			return;
		}
		const plan = this.session.planningState.plan;
		if (!plan) {
			this.showStatus("No structured plan yet");
			return;
		}
		this.planDetailsContainer.clear();
		this.planDetails = new PlanDetailsComponent({
			plan,
			getTerminalRows: () => this.ui.terminal.rows,
			fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
			onAction: (action) => {
				void this.handlePlanDetailsAction(action);
			},
			onClose: () => this.closePlanDetails(),
			requestRender: () => this.ui.requestRender(),
		});
		this.planDetailsContainer.addChild(this.planDetails);
		this.fullscreenFlexibleSlot.clear();
		this.fullscreenFlexibleSlot.addChild(this.planDetails.getFullscreenLayout(), {
			grow: 1,
			shrink: 1,
			minSize: 0,
		});
		this.planDetails.setFullscreenActive(this.ui.mode === "fullscreen");
		this.fullscreenTranscript.setPrimary(false);
		if (!this.ui.retargetFocus(this.getConversationFocusTarget(), this.planDetails)) {
			this.ui.setFocus(this.planDetails);
		}
		this.ui.requestRender();
	}

	private closePlanDetails(options: { focusConversation?: boolean } = {}): void {
		const closingDetails = this.planDetails;
		this.planDetailsContainer.clear();
		this.planDetails = undefined;
		this.fullscreenFlexibleSlot.clear();
		this.fullscreenFlexibleSlot.addChild(this.fullscreenTranscript, { grow: 1, shrink: 1, minSize: 0 });
		if (options.focusConversation !== false && this.activeView === this.conversationView) {
			this.focusConversation();
		} else {
			if (closingDetails && this.ui.getFocusedComponent() === closingDetails) {
				this.fullscreenTranscript.setPrimary(true);
				this.ui.setFocus(this.getConversationFocusTarget());
			}
			this.ui.requestRender();
		}
	}

	private getConversationFocusTarget(): Component {
		const saved = this.planPaneReturnFocus;
		if (saved && this.editorContainer.children.includes(saved)) return saved;
		return this.editorContainer.children[0] ?? (this.editor as Component);
	}

	private focusPlanInspector(): boolean {
		if (this.activeView !== this.conversationView || !this.mainView.isTerminalSplit()) {
			return false;
		}
		const focused = this.ui.getFocusedComponent();
		let focusSource: Component | undefined;
		let retargeted = false;
		if (focused !== this.planInspector) {
			if (focused === this.planDetails || (focused !== null && this.editorContainer.children.includes(focused))) {
				focusSource = focused;
			} else {
				const focusSources: Component[] = [...this.editorContainer.children];
				if (this.planDetails) focusSources.unshift(this.planDetails);
				for (const source of focusSources) {
					if (!this.ui.retargetFocus(source, this.planInspector)) continue;
					focusSource = source;
					retargeted = true;
					break;
				}
				if (!retargeted) return false;
			}
		}
		if (!this.planInspector.focused) {
			this.planPaneReturnFocus =
				focusSource && this.editorContainer.children.includes(focusSource)
					? focusSource
					: this.getConversationFocusTarget();
			this.fullscreenTranscript.setPrimary(false);
			this.planInspector.setFullscreenActive(this.ui.mode === "fullscreen");
			this.planInspector.setSelected(true);
			if (!retargeted) this.ui.setFocus(this.planInspector);
		}
		this.ui.requestRender();
		return true;
	}

	private focusConversation(onlyFromPlanInspector = false): boolean {
		const target = this.getConversationFocusTarget();
		const wasInspectorFocused = this.planInspector.focused;
		const retargeted = this.ui.retargetFocus(this.planInspector, target);
		if (!retargeted) {
			if (onlyFromPlanInspector && !wasInspectorFocused) return false;
			this.ui.setFocus(target);
		}
		this.planInspector.setSelected(false);
		this.fullscreenTranscript.setPrimary(true);
		this.planPaneReturnFocus = undefined;
		this.ui.requestRender();
		return true;
	}

	private togglePlanPaneFocus(): void {
		if (this.mainView.isTerminalSplit()) {
			if (this.planInspector.focused) this.focusConversation();
			else this.focusPlanInspector();
			return;
		}
		if (this.planDetails) this.closePlanDetails();
		else if (this.session.planningState.plan) this.showPlanDetails();
	}

	private handlePlanSplitChange(split: boolean, preserveScrollback: boolean): void {
		if (preserveScrollback && this.renderer instanceof TuiMainScreen) {
			this.renderer.resetViewportOnNextRender();
		}
		this.planInspector.setFullscreenActive(split && this.ui.mode === "fullscreen");
		if (split) {
			const hadPlanDetails = this.planDetails !== undefined;
			if (hadPlanDetails || this.session.planningState.plan?.phase === "ready") this.focusPlanInspector();
			if (hadPlanDetails) this.closePlanDetails({ focusConversation: false });
			return;
		}
		this.fullscreenTranscript.setPrimary(true);
		this.focusConversation(true);
		if (
			this.session.planningState.plan?.phase === "ready" &&
			!this.planDetails &&
			this.activeView === this.conversationView
		) {
			this.showPlanDetails();
		}
	}

	private async handlePlanDetailsAction(action: PlanDetailsAction): Promise<void> {
		const plan = this.session.planningState.plan;
		if (!plan || plan.phase !== "ready") {
			this.showWarning("The ready plan changed; reopen Plan Details");
			this.closePlanDetails();
			return;
		}
		try {
			if (action === "change") {
				this.session.changePlan(plan.id, plan.revision);
				this.closePlanDetails();
				this.editor.setText("");
				this.showStatus("Describe the changes you want in the normal composer");
				return;
			}
			this.closePlanDetails();
			const result = await this.runtimeHost.executePlan(plan.id, plan.revision, action);
			this.showStatus(
				action === "new_session"
					? `Executing plan in session ${result.selectedSessionId}`
					: result.started
						? "Plan execution started"
						: "Plan execution was already started",
			);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
			this.refreshPlanningUi();
		}
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingRenderCoalescer?.commitNow(this.streamingMessage);
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		let scratchDirectory: string;
		try {
			scratchDirectory = this.createScratchDirectory("volt-editor-");
		} catch (error) {
			this.showError(
				`Failed to create private editor file: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const tmpFile = path.join(scratchDirectory, "draft.volt.md");
		let tuiStopped = false;

		try {
			// Write current content to temp file
			writePrivateNewFileSync(tmpFile, currentText);

			// Stop TUI to release terminal without printing a fullscreen transcript.
			this.ui.stop({ preserveScreen: this.ui.mode === "fullscreen" });
			tuiStopped = true;

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			this.removeScratchDirectory(scratchDirectory);

			if (tuiStopped) {
				// Restart TUI and force a full render because external editors use the alternate screen.
				this.ui.start();
				this.ui.requestRender(true);
			}
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.cleanupClipboardScratchFilesInText(this.editor.getText());
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestVoltRelease): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages().map((message) => message.text),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages().map((message) => message.text),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/** Drain the compaction queue, which is local state and cannot fail to clear. */
	private drainCompactionQueue(): { steering: string[]; followUp: string[] } {
		const steering = this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
		const followUp = this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return { steering, followUp };
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 *
	 * When the session queue was revoked but its cancellation could not be
	 * persisted, the compaction queue is drained too and both sets are re-thrown
	 * on the error, so a caller recovering the text sees every queued message
	 * rather than half of them.
	 */
	private async clearAllQueues(): Promise<{ steering: string[]; followUp: string[] }> {
		let session: { steering: string[]; followUp: string[] };
		try {
			session = await this.session.clearQueue();
		} catch (error) {
			if (error instanceof QueueClearPersistenceError) {
				const compaction = this.drainCompactionQueue();
				throw new QueueClearPersistenceError(error, {
					steering: [...error.steering, ...compaction.steering],
					followUp: [...error.followUp, ...compaction.followUp],
				});
			}
			// The session queue was never revoked, so nothing was lost and the
			// compaction queue stays where it is.
			throw error;
		}
		const compaction = this.drainCompactionQueue();
		return {
			steering: [...session.steering, ...compaction.steering],
			followUp: [...session.followUp, ...compaction.followUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private async restoreQueuedMessagesToEditor(options?: {
		abortSource?: AgentAbortSource;
		currentText?: string;
	}): Promise<number> {
		let queues: Awaited<ReturnType<InteractiveMode["clearAllQueues"]>>;
		try {
			queues = await this.clearAllQueues();
		} catch (error) {
			if (error instanceof QueueClearPersistenceError) {
				// The queues were already revoked when persistence failed, so the
				// error carries the only remaining copy of what the user typed. Put
				// it back before letting the caller report the failure.
				this.putQueuedTextInEditor([...error.steering, ...error.followUp], options?.currentText);
			}
			throw error;
		} finally {
			if (options?.abortSource) {
				void this.session.abort(options.abortSource).catch((error: unknown) => {
					this.showError(`Failed to abort the active run: ${String(error)}`);
				});
			}
		}
		return this.putQueuedTextInEditor([...queues.steering, ...queues.followUp], options?.currentText);
	}

	/** Prepend cleared queue text to the editor, keeping any draft already there. */
	private putQueuedTextInEditor(allQueued: string[], currentText?: string): number {
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const draftText = currentText ?? this.editor.getText();
		const combinedText = [queuedText, draftText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			void this.session.clearQueue().catch((clearError) => {
				this.showError(`Failed to persist queued-message cancellation: ${String(clearError)}`);
			});
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (!options?.willRetry) {
				// compaction_end is emitted before the active prompt transaction is
				// released. Wait for that boundary so the first queued input is not
				// rejected as a concurrent prompt and left without another flush trigger.
				await this.session.waitForIdle();
			}

			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text, await this.collectPromptImages(message.text));
					} else {
						await this.session.steer(message.text, await this.collectPromptImages(message.text));
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const firstPromptImages = await this.collectPromptImages(firstPrompt.text);
			const promptPromise = this.session
				.prompt(firstPrompt.text, firstPromptImages ? { images: firstPromptImages } : undefined)
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text, await this.collectPromptImages(message.text));
				} else {
					await this.session.steer(message.text, await this.collectPromptImages(message.text));
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Renderer-aware view composition
	// =========================================================================

	private createDedicatedView(component: Component): ActiveViewDescriptor {
		return {
			regularComponents: [component],
			fullscreenRoot: new VStack([{ component, grow: 1, shrink: 1, minSize: 0 }]),
		};
	}

	private stopInteractiveTui(fullscreenExitOutput: "transcript" | "resume-hint"): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.activateView(this.conversationView, null, false);
			const suspension = this.sessionRenderSuspension;
			this.sessionRenderSuspension = undefined;
			suspension?.release();
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		const previousSuspension = this.sessionRenderSuspension;
		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		const nextSuspension = previousSuspension ? nextUi.suspendRendering() : undefined;

		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.activateView(this.activeView, focus, false);
		nextUi.invalidate();
		if (startRenderer) nextUi.start();
		this.setupPlanPaneInputRouting();
		this.rebindExtensionTerminalInputListeners();
		if (
			startRenderer &&
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}

		if (previousSuspension) {
			this.sessionRenderSuspension = nextSuspension;
			previousSuspension.release();
		}
		return true;
	}

	private activateView(view: ActiveViewDescriptor, focus: Component | null, forceRender = true): void {
		this.ui.clear();
		for (const component of view.regularComponents) this.ui.addChild(component);
		if (isViewportTUI(this.ui)) this.ui.setLayoutRoot(view.fullscreenRoot);
		this.activeView = view;
		const split = view === this.conversationView && this.mainView?.isTerminalSplit() === true;
		this.planInspector?.setFullscreenActive(split && this.ui.mode === "fullscreen");
		this.planDetails?.setFullscreenActive(view === this.conversationView && !split && this.ui.mode === "fullscreen");
		if (view === this.conversationView && this.fullscreenTranscript) {
			this.fullscreenTranscript.setPrimary(focus !== this.planInspector && this.planDetails === undefined);
		}
		this.ui.setFocus(focus);
		this.ui.requestRender(forceRender);
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector as a temporary viewport so transcript and startup content
	 * cannot consume the rows needed for its title, controls, and close action.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		this.dismissSubagentInspector?.();
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		let component: Component | undefined;
		let dispose: (() => void) | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			dispose?.();
			if (!component) return;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.activateView(previousView, previousFocus ?? this.editor);
		};
		const created = create(done);
		component = created.component;
		dispose = created.dispose;
		if (closed) {
			dispose?.();
			return;
		}
		this.activateView(this.createDedicatedView(component), created.focus);
	}

	private showSubagentInspector(): void {
		const manager = this.session.getSubagentToolManager();
		if (!manager?.listActivities || !manager.subscribeActivities) {
			this.showWarning("Subagent conversations are unavailable for this session.");
			return;
		}

		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		let closed = false;
		let view: SubagentInspectorComponent;
		const close = () => {
			if (closed) return;
			closed = true;
			view.dispose();
			this.activateView(previousView, previousFocus ?? this.editor);
			if (this.dismissSubagentInspector === close) this.dismissSubagentInspector = undefined;
		};
		view = new SubagentInspectorComponent(
			{
				listActivities: () => manager.listActivities?.() ?? [],
				subscribeActivities: (listener) => manager.subscribeActivities?.(listener) ?? (() => undefined),
			},
			this.ui,
			close,
		);

		this.activateView(this.createDedicatedView(view), view);
		this.dismissSubagentInspector = close;
	}

	private showRemoteControlCenter(): void {
		this.showSelector((done) => {
			const center = new RemoteControlCenterComponent(createRemoteControlBackend(getAgentDir()), {
				getTerminalRows: () => this.ui.terminal.rows,
				getCurrentWorkspaceName: () => this.daemonAttach.workspaceName(),
				getCurrentWorkspacePath: () => this.runtimeHost.services.cwd,
				currentSessionId: this.session.sessionId,
				requestRender: () => this.ui.requestRender(),
				copyText: copyToClipboard,
				onClose: done,
			});
			void center.start();
			return { component: center, focus: center, dispose: () => center.dispose() };
		});
	}

	private showSettingsSelector(): void {
		this.session.modelRegistry.refresh();
		const availableModels = this.session.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					personality: this.settingsManager.getPersonality(),
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					reviewModel: this.settingsManager.getReviewModel(),
					availableModels,
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					turnDoneAlert: this.settingsManager.getTurnDoneAlert(),
					tuiMode: this.ui.mode,
					fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
					fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
					warnings: this.settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onPersonalityChange: (personality) => {
						this.session.setPersonality(personality);
						this.showStatus(`Personality: ${personality}`);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.setTransport(transport);
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onReviewModelChange: (modelReference) => {
						this.settingsManager.setReviewModel(modelReference);
						this.showStatus(`Review model: ${modelReference ?? "session model"}`);
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.localThemeOverride = true;
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onTurnDoneAlertChange: (mode) => {
						this.settingsManager.setTurnDoneAlert(mode);
					},
					onTuiModeChange: (mode) => {
						if (!this.switchTuiMode(mode)) {
							selector.getSettingsList().updateValue("tui-mode", this.ui.mode);
							this.showStatus("Close active overlays before changing TUI mode");
							return;
						}
						this.settingsManager.setTuiMode(mode);
						this.showStatus(`TUI mode: ${mode}`);
					},
					onFullscreenExitOutputChange: (output) => {
						this.settingsManager.setFullscreenExitOutput(output);
					},
					onFullscreenScrollbarChange: (mode) => {
						this.settingsManager.setFullscreenScrollbar(mode);
						this.applyFullscreenScrollbarSetting(mode);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
				this.ui.terminal.rows,
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private getStorePackageManager(): DefaultPackageManager {
		const packageManager = new DefaultPackageManager({
			cwd: this.sessionManager.getCwd(),
			agentDir: this.runtimeHost.services.agentDir,
			settingsManager: this.settingsManager,
		});
		packageManager.setProgressCallback((event) => {
			if (event.type === "start" && event.message) {
				this.showStatus(formatStoreProgressMessage(event.source, event.message));
			}
		});
		return packageManager;
	}

	private async loadStoreCatalog(required: boolean): Promise<StoreCatalog | undefined> {
		try {
			const result = await loadDefaultStoreCatalog({ agentDir: this.runtimeHost.services.agentDir });
			for (const warning of result.warnings) {
				this.showWarning(warning);
			}
			return result.catalog;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (required) {
				this.showError(message);
				return undefined;
			}
			this.showWarning(`${message}; continuing without catalog metadata.`);
			return { schemaVersion: 1, packages: [] };
		}
	}

	private showStoreText(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private formatStorePackageOption(pkg: StoreCatalogPackage, index: number): string {
		const verified = pkg.verified ? " verified" : "";
		return `${index + 1}. ${pkg.id} - ${pkg.name}${verified}`;
	}

	private getStorePackageTitle(input: string, catalog: StoreCatalog): string {
		const pkg = findCatalogPackage(catalog, input);
		return pkg ? `${pkg.id} - ${pkg.name}` : input;
	}

	private async handleStoreInteractiveCommand(args: string): Promise<void> {
		const parts = args.split(/\s+/).filter((part) => part.length > 0);
		const command = parts[0];
		const input = parts.slice(1).join(" ");

		if (!command) {
			await this.showStoreCatalogBrowser();
			return;
		}
		if (command === "search") {
			await this.showStoreCatalogBrowser(input);
			return;
		}
		if (command === "show") {
			if (!input) {
				this.showWarning("Usage: /store show <id|source>");
				return;
			}
			await this.showStorePackageDetails(input);
			return;
		}
		if (command === "install") {
			if (!input) {
				this.showWarning("Usage: /store install <id|source>");
				return;
			}
			await this.showStoreInstallFlow(input);
			return;
		}
		if (command === "remove") {
			if (!input) {
				this.showWarning("Usage: /store remove <id|source>");
				return;
			}
			await this.showStoreRemoveFlow(input);
			return;
		}
		if (command === "update") {
			await this.showStoreUpdateFlow(input || undefined);
			return;
		}

		await this.showStoreCatalogBrowser(args);
	}

	private async promptStoreCatalogSearch(catalog: StoreCatalog): Promise<void> {
		const value = await this.showExtensionInput("Store search", "Search packages");
		if (value === undefined) {
			this.showStatus("Store search cancelled");
			return;
		}
		await this.showStoreCatalogBrowser(value.trim(), catalog);
	}

	private async showStoreCatalogBrowser(query = "", catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(true));
		if (!storeCatalog) {
			return;
		}

		const matches = searchCatalogPackages(storeCatalog, query).slice(0, 50);
		if (matches.length === 0) {
			this.showStoreText(renderCatalogSearch(matches, query));
			return;
		}

		const labels = new Map<string, StoreCatalogPackage>();
		const options = matches.map((pkg, index) => {
			const label = this.formatStorePackageOption(pkg, index);
			labels.set(label, pkg);
			return label;
		});
		const searchLabel = query.trim() ? "Search again" : "Search";
		options.push(searchLabel, "Cancel");

		const selection = await this.showExtensionSelector("Store packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === searchLabel) {
			await this.promptStoreCatalogSearch(storeCatalog);
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showStorePackageActions(pkg.id, storeCatalog);
		}
	}

	private async showStorePackageActions(input: string, catalog: StoreCatalog): Promise<void> {
		const title = this.getStorePackageTitle(input, catalog);
		const action = await this.showExtensionSelector(`Store: ${title}`, [
			"Show details",
			"Install for user",
			"Install for project",
			"Remove",
			"Update",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			await this.showStorePackageDetails(input, catalog);
			await this.showStorePackageActions(input, catalog);
			return;
		}
		if (action === "Install for user") {
			await this.showStoreInstallFlow(input, "user", catalog);
			return;
		}
		if (action === "Install for project") {
			await this.showStoreInstallFlow(input, "project", catalog);
			return;
		}
		if (action === "Remove") {
			await this.showStoreRemoveFlow(input, undefined, catalog);
			return;
		}
		if (action === "Update") {
			await this.showStoreUpdateFlow(input, catalog);
		}
	}

	private async showStorePackageDetails(input: string, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.showStatus(`Inspecting ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.sessionManager.getCwd(),
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			this.showStoreText(renderStoreShow(resolved, inspection));
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreInstallFlow(
		input: string,
		scope: StoreInstallScope = "user",
		catalog?: StoreCatalog,
	): Promise<void> {
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			this.showWarning("Project is not trusted. Use /trust, then restart volt before installing project packages.");
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.showStatus(`Preparing store install for ${formatStoreSourceSummary(input)}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.sessionManager.getCwd(),
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope,
				scriptPolicy: "never",
			});
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.showStoreText(renderStoreInstallPlan(plan));

			const confirmed = await this.showExtensionConfirm(
				"Store install",
				`Install ${targetLabel} to ${scope} scope? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.showStatus("Store install cancelled");
				return;
			}

			const packageManager = this.getStorePackageManager();
			await packageManager.installAndPersist(plan.source, {
				local: scope === "project",
				scripts: "never",
			});
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, scope)) {
				return;
			}
			await this.offerStoreReload(`Installed ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreRemoveFlow(input: string, local?: boolean, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const packageManager = this.getStorePackageManager();
			const selection = chooseStoreRemoveTarget(packageManager, resolved.source, local ?? false);
			if (selection.conflict === "both-scopes") {
				this.showWarning("Package is installed in both user and project scopes. Use /extensions to pick one.");
				return;
			}
			if (!selection.target) {
				this.showWarning(`No matching package found for ${input}`);
				return;
			}
			await this.removeInstalledStorePackage(
				packageManager,
				selection.target,
				selection.target.actionSource ?? selection.target.source,
			);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreUpdateFlow(input?: string, catalog?: StoreCatalog): Promise<void> {
		const packageManager = this.getStorePackageManager();
		if (!input) {
			const confirmed = await this.showExtensionConfirm("Store update", "Update all installed packages?");
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(undefined, { scripts: "never" });
				this.showStatus("Updated packages. Run /reload to load resource changes.");
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		const catalogPackage = findCatalogPackage(storeCatalog, input);
		if (!catalogPackage) {
			const inputLabel = formatStoreSourceSummary(input);
			const confirmed = await this.showExtensionConfirm("Store update", `Update ${inputLabel}?`);
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(input, { scripts: "never" });
				this.showStatus(`Updated ${inputLabel}. Run /reload to load resource changes.`);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		try {
			this.showStatus(`Preparing store update for ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const selection = chooseStoreUpdateTarget(packageManager, resolved.source);
			if (selection.conflict === "both-scopes") {
				this.showWarning("Package is installed in both user and project scopes. Use /extensions to pick one.");
				return;
			}
			if (!selection.target) {
				this.showWarning(`No matching installed package found for catalog ID ${input}`);
				return;
			}
			if (storeTargetMatchesUpdateSource(selection.target, resolved.source)) {
				const targetLabel = formatStoreSourceSummary(selection.target.source);
				const confirmed = await this.showExtensionConfirm("Store update", `Update ${targetLabel}?`);
				if (!confirmed) {
					this.showStatus("Store update cancelled");
					return;
				}
				await packageManager.update(selection.target.actionSource ?? selection.target.source, {
					local: selection.target.scope === "project",
					scripts: "never",
				});
				this.showStatus(`Updated ${targetLabel}. Run /reload to load resource changes.`);
				return;
			}

			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.sessionManager.getCwd(),
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope: selection.target.scope,
				scriptPolicy: "never",
			});
			const currentLabel = formatStoreSourceSummary(selection.target.source);
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.showStoreText(renderStoreInstallPlan(plan));
			const confirmed = await this.showExtensionConfirm(
				"Store update",
				`Update ${currentLabel} to ${targetLabel}? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			await packageManager.installAndPersist(plan.source, {
				local: selection.target.scope === "project",
				scripts: "never",
			});
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, selection.target.scope)) {
				return;
			}
			await this.offerStoreReload(`Updated ${currentLabel} to ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleExtensionsInteractiveCommand(): Promise<void> {
		const packageManager = this.getStorePackageManager();
		const packages = packageManager.listConfiguredPackages();
		if (packages.length === 0) {
			this.showStatus("No packages installed");
			return;
		}

		const labels = new Map<string, ConfiguredPackage>();
		const options = packages.map((pkg, index) => {
			const filtered = pkg.filtered ? " filtered" : "";
			const label = `${index + 1}. ${pkg.scope} - ${formatStoreSourceSummary(pkg.source)}${filtered}`;
			labels.set(label, pkg);
			return label;
		});
		options.push("Update all", "Cancel");

		const selection = await this.showExtensionSelector("Installed packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === "Update all") {
			await this.showStoreUpdateFlow();
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showInstalledStorePackageActions(packageManager, pkg);
		}
	}

	private async showInstalledStorePackageActions(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const action = await this.showExtensionSelector(`${pkg.scope}: ${sourceLabel}`, [
			"Show details",
			"Update",
			"Remove",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			this.showStoreText(
				[
					"Installed package",
					`Source: ${sourceLabel}`,
					`Scope: ${pkg.scope}`,
					`Filtered: ${pkg.filtered ? "yes" : "no"}`,
					`Installed path: ${pkg.installedPath ?? "not installed"}`,
				].join("\n"),
			);
			await this.showInstalledStorePackageActions(packageManager, pkg);
			return;
		}
		if (action === "Update") {
			await this.updateInstalledStorePackage(packageManager, pkg);
			return;
		}
		if (action === "Remove") {
			await this.removeInstalledStorePackage(
				packageManager,
				{ source: pkg.source, scope: pkg.scope },
				pkg.actionSource,
			);
		}
	}

	private async updateInstalledStorePackage(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const confirmed = await this.showExtensionConfirm("Store update", `Update ${sourceLabel}?`);
		if (!confirmed) {
			this.showStatus("Store update cancelled");
			return;
		}
		try {
			await packageManager.update(pkg.actionSource, { local: pkg.scope === "project", scripts: "never" });
			this.showStatus(`Updated ${sourceLabel}. Run /reload to load resource changes.`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeInstalledStorePackage(
		packageManager: DefaultPackageManager,
		target: StoreScopeTarget,
		removeSource = target.source,
	): Promise<void> {
		if (target.scope === "project" && !this.settingsManager.isProjectTrusted()) {
			this.showWarning("Project is not trusted. Use /trust, then restart volt before removing project packages.");
			return;
		}
		const targetLabel = formatStoreSourceSummary(target.source);
		const confirmed = await this.showExtensionConfirm(
			"Store remove",
			`Remove ${targetLabel} from ${target.scope} scope?`,
		);
		if (!confirmed) {
			this.showStatus("Store remove cancelled");
			return;
		}
		try {
			const removed = await packageManager.removeAndPersist(removeSource, {
				local: target.scope === "project",
			});
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, removeSource, target.scope)) {
				return;
			}
			if (!removed) {
				this.showWarning(`No matching package found for ${targetLabel}`);
				return;
			}
			await this.offerStoreReload(`Removed ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private reportStoreSettingsErrors(
		packageManager: DefaultPackageManager,
		source: string,
		scope: StoreInstallScope,
	): boolean {
		const settingsErrors = this.settingsManager.drainErrors();
		if (settingsErrors.length === 0) {
			return false;
		}
		const installedPath = packageManager.getInstalledPath(source, scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			this.showWarning(`${errorScope} settings: ${error.message}`);
		}
		if (installedPath) {
			this.showWarning(`Package was installed at ${installedPath}, but settings persistence failed.`);
		}
		return true;
	}

	private async offerStoreReload(message: string): Promise<void> {
		const action = await this.showExtensionSelector(message, ["Reload now", "Later"]);
		if (action === "Reload now") {
			await this.handleReloadCommand();
			return;
		}
		this.showStatus(`${message}. Run /reload to load resource changes.`);
	}

	private async handleProfileCommand(profileName?: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before switching profiles.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before switching profiles.");
			return;
		}

		if (profileName) {
			if (!this.settingsManager.hasProfile(profileName)) {
				this.showWarning(`Profile "${profileName}" is not defined. Run /profile to create it.`);
				return;
			}
			await this.switchProfile(profileName);
			return;
		}

		await this.showProfileSelector();
	}

	private async showProfileSelector(): Promise<void> {
		const currentProfile = this.settingsManager.getActiveProfile();
		const profileNames = this.settingsManager.getProfileNames();
		const profileByLabel = new Map<string, string>();
		const options: string[] = [];

		for (const [index, profileName] of profileNames.entries()) {
			const currentSuffix = profileName === currentProfile ? " (current)" : "";
			const label = `${index + 1}. ${profileName}${currentSuffix}`;
			profileByLabel.set(label, profileName);
			options.push(label);
		}

		const createCurrentLabel =
			currentProfile && !profileNames.includes(currentProfile) ? `Create "${currentProfile}"` : undefined;
		if (createCurrentLabel) {
			options.push(createCurrentLabel);
		}
		options.push("Create new profile", "Cancel");

		const currentLabel = currentProfile ?? "none";
		const selection = await this.showExtensionSelector(`Current profile: ${currentLabel}`, options);
		if (!selection || selection === "Cancel") {
			return;
		}

		const selectedProfile = profileByLabel.get(selection);
		if (selectedProfile) {
			await this.switchProfile(selectedProfile);
			return;
		}

		if (selection === createCurrentLabel && currentProfile) {
			await this.createAndSwitchProfile(currentProfile, { forceReload: true });
			return;
		}

		const createdProfile = await this.showExtensionInput("Create profile", "Profile name");
		if (createdProfile === undefined) {
			this.showStatus("Profile creation cancelled");
			return;
		}
		await this.createAndSwitchProfile(createdProfile);
	}

	private async createAndSwitchProfile(profileName: string, options?: { forceReload?: boolean }): Promise<void> {
		const normalizedProfile = profileName.trim();
		if (!normalizedProfile) {
			this.showWarning("Profile name cannot be empty");
			return;
		}

		try {
			const profileExists = this.settingsManager.hasProfile(normalizedProfile);
			const createdProfile = profileExists
				? normalizedProfile
				: this.settingsManager.ensureGlobalProfile(normalizedProfile);
			if (!profileExists) {
				await this.settingsManager.flush();
			}
			await this.switchProfile(createdProfile, { created: !profileExists, forceReload: options?.forceReload });
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async applyProfileDefaultThinkingLevel(thinkingLevelOverride?: ThinkingLevel): Promise<boolean> {
		const defaultThinkingLevel = thinkingLevelOverride ?? this.settingsManager.getDefaultThinkingLevel();
		if (defaultThinkingLevel === undefined) {
			return false;
		}

		const previousThinkingLevel = this.session.thinkingLevel;
		await this.session.setThinkingLevel(defaultThinkingLevel, { persistDefault: false });
		return this.session.thinkingLevel !== previousThinkingLevel;
	}

	private async applyProfileDefaultModel(): Promise<void> {
		const defaultProvider = this.settingsManager.getDefaultProvider();
		const defaultModel = this.settingsManager.getDefaultModel();
		if (!defaultProvider && !defaultModel) {
			const scopedModels = this.session.scopedModels;
			const selectedScopedModel = this.session.model
				? (scopedModels.find((scoped) => modelsAreEqual(scoped.model, this.session.model)) ?? scopedModels[0])
				: scopedModels[0];
			if (selectedScopedModel && !modelsAreEqual(this.session.model, selectedScopedModel.model)) {
				if (!this.session.modelRegistry.hasConfiguredAuth(selectedScopedModel.model)) {
					this.showWarning(
						`Could not apply profile model ${selectedScopedModel.model.provider}/${selectedScopedModel.model.id}: credentials are not configured`,
					);
					return;
				}
				try {
					await this.session.setModel(selectedScopedModel.model, { persistDefault: false });
					await this.applyProfileDefaultThinkingLevel(selectedScopedModel.thinkingLevel);
					this.footer.invalidate();
					this.updateEditorBorderColor();
					void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedScopedModel.model);
					this.checkDaxnutsEasterEgg(selectedScopedModel.model);
				} catch (error: unknown) {
					this.showWarning(
						`Could not apply profile model ${selectedScopedModel.model.provider}/${selectedScopedModel.model.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			if (await this.applyProfileDefaultThinkingLevel(selectedScopedModel?.thinkingLevel)) {
				this.footer.invalidate();
				this.updateEditorBorderColor();
			}
			return;
		}
		if (!defaultProvider || !defaultModel) {
			this.showWarning("Could not apply profile default model: defaultProvider/defaultModel is incomplete");
			return;
		}

		const model = this.session.modelRegistry.find(defaultProvider, defaultModel);
		if (!model) {
			this.showWarning(`Could not apply profile default model ${defaultProvider}/${defaultModel}: model not found`);
			return;
		}

		const scopedModels = this.session.scopedModels;
		const scopedDefaultModel =
			scopedModels.length > 0 ? scopedModels.find((scoped) => modelsAreEqual(scoped.model, model)) : undefined;
		const selectedScopedModel = scopedModels.length > 0 ? (scopedDefaultModel ?? scopedModels[0]) : undefined;
		const selectedModel = selectedScopedModel?.model ?? model;
		const selectedThinkingLevel = selectedScopedModel?.thinkingLevel;

		if (modelsAreEqual(this.session.model, selectedModel)) {
			if (await this.applyProfileDefaultThinkingLevel(selectedThinkingLevel)) {
				this.footer.invalidate();
				this.updateEditorBorderColor();
			}
			return;
		}
		if (!this.session.modelRegistry.hasConfiguredAuth(selectedModel)) {
			this.showWarning(
				`Could not apply profile model ${selectedModel.provider}/${selectedModel.id}: credentials are not configured`,
			);
			return;
		}

		try {
			await this.session.setModel(selectedModel, { persistDefault: false });
			await this.applyProfileDefaultThinkingLevel(selectedThinkingLevel);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} catch (error: unknown) {
			this.showWarning(
				`Could not apply profile model ${selectedModel.provider}/${selectedModel.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async switchProfile(
		profileName: string,
		options?: { created?: boolean; forceReload?: boolean },
	): Promise<void> {
		const normalizedProfile = profileName.trim();
		if (!normalizedProfile) {
			this.showWarning("Profile name cannot be empty");
			return;
		}
		if (!options?.forceReload && this.settingsManager.getActiveProfile() === normalizedProfile) {
			this.showStatus(`Current profile: ${normalizedProfile}`);
			return;
		}

		this.settingsManager.setActiveProfile(normalizedProfile);
		const reloaded = await this.reloadRuntimeResources({
			action: "switching profiles",
			progressMessage: `Switching profile to ${normalizedProfile}...`,
			successMessage: (savedImplicitProjectTrust) => {
				const createdPrefix = options?.created ? `Created profile ${normalizedProfile}. ` : "";
				const trustSuffix = savedImplicitProjectTrust ? "; saved project trust" : "";
				return `${createdPrefix}Profile: ${normalizedProfile}. Reloaded keybindings, extensions, skills, prompts, themes${trustSuffix}`;
			},
		});
		if (!reloaded) {
			return;
		}
		try {
			await this.applyScopedModelsFromSettings();
		} catch (error: unknown) {
			this.showWarning(
				`Could not apply profile model scope: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await this.applyProfileDefaultModel();
	}

	private async applyScopedModelsFromSettings(): Promise<void> {
		const patterns = this.options.modelScopePatterns ?? this.settingsManager.getEnabledModels();
		if (patterns && patterns.length > 0) {
			const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
			this.session.setScopedModels(
				scopedModels.map((scopedModel) => ({
					model: scopedModel.model,
					thinkingLevel: scopedModel.thinkingLevel,
				})),
			);
		} else {
			this.session.setScopedModels([]);
		}
		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			return;
		}

		try {
			const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		// Trust entries are never persisted for daemon-managed worktree paths.
		if (isPathUnderWorktreesRoot(this.runtimeHost.services.agentDir, cwd)) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * /worktree — open a new session inside a daemon-managed git worktree
	 * (§5.2.1): ensures the daemon is running, creates (or picks) a worktree via
	 * the control socket, then starts a new session with cwd = the worktree
	 * checkout and sessionDir = the PARENT workspace's default session dir, so
	 * the session stays listed and lease-keyed under the parent workspace.
	 */
	private async handleWorktreeCommand(args: string): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting) {
			this.showWarning("Wait for the current response to finish before switching to a worktree.");
			return;
		}
		const parts = args.split(/\s+/).filter((part) => part.length > 0);
		let createRequested = false;
		let requestedName: string | undefined;
		if (parts.length > 0) {
			if (parts[0] !== "new" || parts.length > 2) {
				this.showWarning("Usage: /worktree [new [name]]");
				return;
			}
			createRequested = true;
			requestedName = parts[1];
		}

		const agentDir = this.runtimeHost.services.agentDir;
		this.showStatus("Contacting voltd…");
		const opened = await openDaemonWorktreeControl({ cwd: this.sessionManager.getCwd(), agentDir });
		if (!opened.ok) {
			this.showError(`Worktrees need the volt daemon: ${opened.error}`);
			return;
		}
		const control: DaemonWorktreeControl = opened.control;
		let restoreWorktreeContext: (() => void) | undefined;
		try {
			let target: { id: string; path: string; branch: string; baseRef?: string } | undefined;
			if (createRequested) {
				const created = await control.createWorktree(requestedName);
				if (!created.ok) {
					this.showError(`Failed to create worktree: ${created.error}`);
					return;
				}
				target = created.worktree;
			} else {
				const worktrees = (await control.listWorktrees()).filter((worktree) => worktree.available !== false);
				const createLabel = "Create new worktree";
				const labels = worktrees.map((worktree) => `${worktree.id} (${worktree.branch})`);
				const selection = await this.showExtensionSelector(
					`Open a session in a worktree of ${control.workspaceName}`,
					[createLabel, ...labels],
				);
				if (selection === undefined) {
					this.showStatus("Worktree selection cancelled");
					return;
				}
				if (selection === createLabel) {
					const created = await control.createWorktree(undefined);
					if (!created.ok) {
						this.showError(`Failed to create worktree: ${created.error}`);
						return;
					}
					target = created.worktree;
				} else {
					target = worktrees[labels.indexOf(selection)];
				}
			}
			if (!target) {
				this.showError("No worktree selected");
				return;
			}

			const sessionDir = getDefaultSessionDir(control.workspacePath, agentDir);
			restoreWorktreeContext = this.daemonAttach.setWorktreeContext(control.workspaceName, target.id);
			const result = await this.runtimeHost.newSession({
				cwd: target.path,
				sessionDir,
				workspaceName: control.workspaceName,
				baseRef: target.baseRef,
				setup: async (sessionManager) => {
					const bound = await control.bindSession(target.id, sessionManager.getSessionId());
					if (!bound) throw new Error(`Worktree ${target.id} is unavailable for session binding`);
				},
			});
			if (result.cancelled) {
				this.showStatus("Worktree session cancelled");
				return;
			}
			restoreWorktreeContext = undefined;
			this.renderCurrentSessionState();
			this.showStatus(`New session in worktree ${target.id} (branch ${target.branch}) — ${target.path}`);
			this.ui.requestRender();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			restoreWorktreeContext?.();
			await control.close().catch(() => {});
		}
	}

	private showTrustSelector(): void {
		const agentDir = this.runtimeHost.services.agentDir;
		const sessionCwd = this.sessionManager.getCwd();
		// Worktree sessions pin trust to the PARENT checkout; entries are never
		// prompted for or persisted on worktree paths (§5.2.1).
		const worktreeParent = resolveWorktreeParentCheckout(agentDir, sessionCwd);
		if (worktreeParent === undefined && isPathUnderWorktreesRoot(agentDir, sessionCwd)) {
			this.showWarning(
				"This session runs in a daemon-managed worktree and its parent checkout could not be resolved; trust decisions are managed on the parent workspace.",
			);
			return;
		}
		const cwd = worktreeParent ?? sessionCwd;
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart volt for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.renderCurrentSessionState();
			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const currentSessionFile = this.sessionManager.getSessionFile();
						if (currentSessionFile && path.resolve(currentSessionFile) === path.resolve(sessionFilePath)) {
							this.session.setSessionName(next);
							await this.sessionManager.flush();
							return;
						}
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
						await mgr.flush();
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean; seeded: boolean }> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.renderCurrentSessionState();
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true, seeded: false };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private showLoginAuthTypeSelector(): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel],
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType: "oauth" | "api_key"): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					if (providerOption.authType === "oauth") {
						await this.showLoginDialog(providerOption.id, providerOption.name);
					} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
						this.showBedrockSetupDialog(providerOption.id, providerOption.name);
					} else {
						await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
					}
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		const restoreEditor = () => this.activateView(previousView, previousFocus ?? this.editor);

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			() => restoreEditor(),
			providerName,
			"Amazon Bedrock setup",
		);
		dialog.showInfo([
			theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
			theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);

		this.activateView(this.createDedicatedView(dialog), dialog);
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.activateView(this.createDedicatedView(dialog), dialog);

		const restoreEditor = () => this.activateView(previousView, previousFocus ?? this.editor);

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const previousView = this.activeView;
			const previousFocus = this.ui.getFocusedComponent();
			const restoreDialog = () => this.activateView(previousView, previousFocus ?? dialog);
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.activateView(this.createDedicatedView(selector), selector);
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.activateView(this.createDedicatedView(dialog), dialog);

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore the view that opened the login flow.
		const restoreEditor = () => this.activateView(previousView, previousFocus ?? this.editor);

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onDeviceCode: (info) => {
					dialog.showDeviceCode(info);
					dialog.showWaiting("Waiting for authentication...");
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async reloadRuntimeResources(options?: {
		action?: string;
		progressMessage?: string;
		successMessage?: (savedImplicitProjectTrust: boolean) => string;
	}): Promise<boolean> {
		const action = options?.action ?? "reloading";
		if (this.session.isStreaming) {
			this.showWarning(`Wait for the current response to finish before ${action}.`);
			return false;
		}
		if (this.session.isCompacting) {
			this.showWarning(`Wait for compaction to finish before ${action}.`);
			return false;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg(
					"muted",
					options?.progressMessage ?? "Reloading keybindings, extensions, skills, prompts, themes...",
				),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.session.setTransport(this.settingsManager.getTransport());
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.applyFullscreenScrollbarSetting();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				options?.successMessage?.(savedImplicitProjectTrust) ??
					(savedImplicitProjectTrust
						? "Reloaded keybindings, extensions, skills, prompts, themes; saved project trust"
						: "Reloaded keybindings, extensions, skills, prompts, themes"),
			);
			return true;
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private async handleReloadCommand(): Promise<void> {
		await this.reloadRuntimeResources();
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = await this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.renderCurrentSessionState();
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.renderCurrentSessionState();
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		let scratchDirectory: string;
		try {
			scratchDirectory = this.createScratchDirectory("volt-share-");
		} catch (error: unknown) {
			this.showError(
				`Failed to create private share file: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return;
		}
		const tmpFile = path.join(scratchDirectory, "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.removeScratchDirectory(scratchDirectory);
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.removeScratchDirectory(scratchDirectory);
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.once("error", (error) => resolve({ stdout, stderr: error.message, code: null }));
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		} finally {
			restoreEditor();
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleNameCommand(text: string): Promise<void> {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		const response = await BUILTIN_HOST_ACTION_REGISTRY.invokeBySlashAlias(
			SESSION_RENAME_SLASH_ALIAS,
			this.createHostActionContext(),
			{
				name,
			},
		);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", response.message ?? `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handleFastCommand(text: string): Promise<void> {
		const argument = text.slice(`/${THINKING_FAST_MODE_SLASH_ALIAS}`.length).trim();
		let enabled: boolean;
		if (argument === "") {
			enabled = !this.session.fastModeEnabled;
		} else if (argument === "on") {
			enabled = true;
		} else if (argument === "off") {
			enabled = false;
		} else {
			this.showWarning("Usage: /fast [on|off]");
			return;
		}

		try {
			const response = await BUILTIN_HOST_ACTION_REGISTRY.invokeBySlashAlias(
				THINKING_FAST_MODE_SLASH_ALIAS,
				this.createHostActionContext(),
				{ enabled },
			);
			if (enabled) {
				this.showWarning(response.message ?? "Fast mode enabled. Priority processing may cost more.");
			} else {
				this.showStatus(response.message ?? "Fast mode disabled");
			}
		} catch (error: unknown) {
			this.showWarning(error instanceof Error ? error.message : String(error));
		}
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private formatSubscriptionUsageError(error: SubscriptionUsageError): string {
		switch (error.code) {
			case "unauthorized":
				return "Authentication failed. Run /login to reconnect this subscription.";
			case "rate_limited":
				return "Usage status is rate limited. Try again later.";
			case "timeout":
				return "Usage status request timed out.";
			case "malformed_response":
				return "Usage status returned an unsupported response.";
			case "unavailable":
				return "Usage status is temporarily unavailable.";
		}
	}

	private formatSubscriptionPlan(plan: string): string {
		return plan
			.split(/[_-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	private formatRemainingPercent(usedPercent: number): string {
		const remaining = Math.max(0, 100 - usedPercent);
		return Number.isInteger(remaining) ? remaining.toFixed(0) : remaining.toFixed(1);
	}

	private async handleUsageCommand(): Promise<void> {
		const report = await this.subscriptionUsageService.fetch(
			this.session.modelRegistry.authStorage,
			this.session.model?.provider,
		);
		if (report.status === "no_subscription") {
			this.showStatus("No subscription login is configured. Use /login to connect a supported provider.");
			return;
		}
		if (report.status === "unsupported") {
			this.showStatus("Stored subscription credentials do not expose quota usage in Volt.");
			return;
		}

		const sections: string[] = [];
		for (const provider of report.providers) {
			const providerName = this.session.modelRegistry.getProviderDisplayName(provider.providerId);
			if (provider.result.status === "error") {
				sections.push(
					`${theme.bold(providerName)}\n  ${theme.fg("warning", this.formatSubscriptionUsageError(provider.result.error))}`,
				);
				continue;
			}

			const snapshot = provider.result.snapshot;
			const heading = snapshot.plan
				? `${providerName} · ${this.formatSubscriptionPlan(snapshot.plan)}`
				: providerName;
			const lines = snapshot.limits.map((limit) => {
				let line = `${theme.fg("dim", `${limit.label}:`)} ${this.formatRemainingPercent(limit.usedPercent)}% remaining`;
				if (limit.resetsAt !== undefined) {
					line += ` · resets ${new Date(limit.resetsAt).toLocaleString()}`;
				}
				if (limit.limitReached) {
					line += ` · ${theme.fg("warning", "limit reached")}`;
				}
				return `  ${line}`;
			});
			sections.push(`${theme.bold(heading)}\n${lines.join("\n")}`);
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.bold("Subscription Usage")}\n\n${sections.join("\n\n")}`, 1, 0));
		this.ui.requestRender();
	}

	private async handleLspCommand(args?: string): Promise<void> {
		const formatIdle = (idleMs: number): string => {
			const seconds = Math.floor(idleMs / 1000);
			if (seconds < 60) return `${seconds}s`;
			return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		};

		let info: string;
		const status = this.session.getLspStatus();
		if (args === "restart") {
			const count = this.session.restartLspServers();
			info = status.enabled
				? `Stopped ${count} language server${count === 1 ? "" : "s"}. Servers respawn on next use.`
				: "LSP is disabled. Run with --lsp or set lsp.enabled=true in settings.";
		} else if (args === "trace" || args?.startsWith("trace ")) {
			if (!status.enabled) {
				info = "LSP is disabled. Run with --lsp or set lsp.enabled=true in settings.";
			} else {
				const traceArg = args === "trace" ? undefined : args.slice(6).trim();
				if (traceArg === "off") {
					await this.closeLspTrace();
					info = "LSP tracing disabled.";
				} else {
					await this.closeLspTrace();
					let tracePath: string;
					if (traceArg && traceArg.length > 0) {
						tracePath = resolvePath(traceArg, this.session.sessionManager.getCwd());
					} else {
						const scratchDirectory = this.createScratchDirectory("volt-lsp-trace-");
						this.lspTraceScratchDirectory = scratchDirectory;
						tracePath = path.join(scratchDirectory, "trace.log");
					}
					try {
						await this.session.setLspTraceFile(tracePath);
						info = `LSP tracing enabled: ${tracePath}\nUse /lsp trace off to disable.`;
					} catch (error) {
						if (this.lspTraceScratchDirectory) {
							this.removeScratchDirectory(this.lspTraceScratchDirectory);
						}
						info = `Failed to enable LSP tracing: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}
		} else if (!status.enabled) {
			info = "LSP is disabled. Run with --lsp or set lsp.enabled=true in settings.";
		} else if (status.servers.length === 0) {
			info = `${theme.bold("LSP Servers")}\n\nNo servers running. Servers spawn on first use of a matching file.`;
		} else {
			info = `${theme.bold("LSP Servers")}\n`;
			for (const server of status.servers) {
				info += `\n${theme.bold(server.name)} ${server.alive ? theme.fg("success", "running") : theme.fg("error", "dead")}\n`;
				info += `${theme.fg("dim", "Root:")} ${server.root}\n`;
				info += `${theme.fg("dim", "Open documents:")} ${server.openDocuments}\n`;
				info += `${theme.fg("dim", "Idle:")} ${formatIdle(server.idleMs)}\n`;
			}
			if (status.traceFile) {
				info += `\n${theme.fg("dim", "Trace:")} ${status.traceFile}\n`;
			}
			info += `\n${theme.fg("dim", "Use /lsp restart to restart servers, /lsp trace [path|off] to toggle tracing.")}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleMcpCommand(args?: string): Promise<void> {
		const manager = this.session.getMcpManager();
		let info: string;
		if (!manager) {
			info = "MCP is not configured. Add servers to ~/.volt/agent/mcp.json, .mcp.json, or .volt/mcp.json.";
		} else {
			const [action, server] = (args ?? "").split(/\s+/, 2);
			try {
				if ((action === "connect" || action === "refresh") && server) {
					await manager.connectServer(server);
					await this.session.reload();
				} else if (action === "disconnect" && server) {
					await manager.disconnectServer(server);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				info = `${theme.bold("MCP Servers")}\n\n${theme.fg("error", message)}`;
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(info, 1, 0));
				this.ui.requestRender();
				return;
			}

			const currentManager = this.session.getMcpManager() ?? manager;
			const servers = currentManager.listServers();
			info = `${theme.bold("MCP Servers")}\n`;
			if (servers.length === 0) {
				info += "\nNo MCP servers configured.";
			} else {
				for (const entry of servers) {
					const statusColor =
						entry.status === "ready" || entry.status === "connected"
							? "success"
							: entry.status === "error" || entry.status === "needs_auth"
								? "error"
								: "muted";
					info += `\n${theme.bold(entry.displayName)} ${theme.fg("dim", `(${entry.id})`)} ${theme.fg(statusColor, entry.status)}\n`;
					info += `${theme.fg("dim", "Source:")} ${entry.sourceLabel} (${entry.sourceScope})\n`;
					info += `${theme.fg("dim", "Transport:")} ${entry.transport} ${theme.fg("dim", "Lifecycle:")} ${entry.lifecycle}\n`;
					info += `${theme.fg("dim", "Tools:")} ${entry.toolCounts.enabled ?? entry.toolCounts.cached} enabled / ${entry.toolCounts.cached} cached`;
					if (entry.resourceCount !== undefined || entry.promptCount !== undefined) {
						info += ` ${theme.fg("dim", "Resources:")} ${entry.resourceCount ?? 0} ${theme.fg("dim", "Prompts:")} ${entry.promptCount ?? 0}`;
					}
					if (entry.lastError) {
						info += `\n${theme.fg("error", entry.lastError)}`;
					}
					info += "\n";
				}
				info += `\n${theme.fg("dim", "Use /mcp connect <server>, /mcp refresh <server>, or /mcp disconnect <server>.")}`;
			}
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const toggleAgentMode = this.getAppKeyDisplay("app.mode.toggle");
		const togglePlanPane = this.getAppKeyDisplay("app.plan.togglePane");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const openSubagents = this.getAppKeyDisplay("app.subagents.open");

		const sections: HotkeySection[] = [
			{
				title: "Essential workflow",
				entries: [
					{ key: submit, action: "Send message / steer active turn" },
					{ key: interrupt, action: "Stop current response or tool" },
					{ key: followUp, action: "Queue follow-up message" },
					{ key: dequeue, action: "Restore queued messages" },
					{ key: expandTools, action: "Toggle tool output expansion" },
					{ key: selectModel, action: "Open model selector" },
					{ key: toggleAgentMode, action: "Toggle Build / Plan mode" },
					{ key: togglePlanPane, action: "Switch conversation / plan pane focus" },
					{ key: cycleThinkingLevel, action: "Cycle thinking level" },
					{ key: openSubagents, action: "Switch to subagent conversations" },
				],
			},
			{
				title: "Navigation",
				entries: [
					{ key: `${cursorUp} / ${cursorDown}`, action: "Move vertically / browse history" },
					{ key: `${cursorLeft} / ${cursorRight}`, action: "Move horizontally" },
					{ key: cursorWordLeft, action: "Move one word left" },
					{ key: cursorWordRight, action: "Move one word right" },
					{ key: cursorLineStart, action: "Start of line" },
					{ key: cursorLineEnd, action: "End of line" },
					{ key: jumpForward, action: "Jump forward to character" },
					{ key: jumpBackward, action: "Jump backward to character" },
					{ key: `${pageUp} / ${pageDown}`, action: "Scroll by page" },
				],
			},
			{
				title: "Editing",
				entries: [
					{ key: submit, action: "Send message" },
					{
						key: newLine,
						action: `New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""}`,
					},
					{ key: deleteWordBackward, action: "Delete word backwards" },
					{ key: deleteWordForward, action: "Delete word forwards" },
					{ key: deleteToLineStart, action: "Delete to start of line" },
					{ key: deleteToLineEnd, action: "Delete to end of line" },
					{ key: yank, action: "Paste the most-recently-deleted text" },
					{ key: yankPop, action: "Cycle through deleted text after pasting" },
					{ key: undo, action: "Undo" },
				],
			},
			{
				title: "Application",
				entries: [
					{ key: tab, action: "Path completion / accept autocomplete" },
					{ key: interrupt, action: "Cancel autocomplete / abort streaming" },
					{ key: clear, action: "Clear editor (first) / exit (second)" },
					{ key: exit, action: "Exit when editor is empty" },
					{ key: suspend, action: "Suspend to background" },
					{ key: toggleAgentMode, action: "Toggle Build / Plan mode" },
					{ key: togglePlanPane, action: "Switch conversation / plan pane focus" },
					{ key: cycleThinkingLevel, action: "Cycle thinking level" },
					{ key: `${cycleModelForward} / ${cycleModelBackward}`, action: "Cycle models" },
					{ key: selectModel, action: "Open model selector" },
					{ key: expandTools, action: "Toggle tool output expansion" },
					{ key: toggleThinking, action: "Toggle thinking block visibility" },
					{ key: externalEditor, action: "Edit message in external editor" },
					{ key: followUp, action: "Queue follow-up message" },
					{ key: dequeue, action: "Restore queued messages" },
					{ key: pasteImage, action: "Paste image from clipboard" },
					{ key: openSubagents, action: "Switch to subagent conversations" },
					{ key: "/", action: "Slash commands" },
					{ key: "!", action: "Run bash command" },
					{ key: "!!", action: "Run bash command (excluded from context)" },
				],
			},
		];

		const shortcuts = this.session.extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			sections.push({
				title: "Extensions",
				entries: Array.from(shortcuts, ([key, shortcut]) => ({
					key: formatKeyText(key, { capitalize: true }),
					action: shortcut.description ?? shortcut.extensionPath,
				})),
			});
		}

		this.showSelector((done) => {
			const hotkeys = new HotkeysComponent(
				sections,
				() => this.ui.terminal.rows,
				() => {
					done();
					this.ui.requestRender();
				},
				() => this.ui.requestRender(),
			);
			return { component: hotkeys, focus: hotkeys };
		});
	}

	private async handleClearCommand(): Promise<void> {
		if (this.session.isStreaming) {
			// Abort deliberately before the session switch so the in-flight turn is
			// stopped and persisted, instead of relying on dispose-time teardown.
			await this.session.abort("session_replacement");
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const response = await BUILTIN_HOST_ACTION_REGISTRY.invokeBySlashAlias(
				SESSION_NEW_SLASH_ALIAS,
				this.createHostActionContext(),
			);
			if (response.status === "cancelled") {
				return;
			}
			this.renderCurrentSessionState();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width).lines;

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		try {
			ensurePrivateDirectorySync(path.dirname(debugLogPath), { hardenExisting: false });
			writeDurableAtomicFileSync(debugLogPath, debugData, {
				directoryMode: PRIVATE_DIRECTORY_MODE,
				fileMode: PRIVATE_FILE_MODE,
			});
		} catch (error) {
			this.showError(`Failed to write debug log: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleVoltAnnouncement(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new VoltAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async promptForReviewTarget(): Promise<ReviewTarget | undefined> {
		const branchLabel = "Against base branch";
		const uncommittedLabel = "Uncommitted changes";
		const prLabel = "GitHub pull request";
		const commitLabel = "Specific commit";
		const currentPullRequest = await probeCurrentBranchPullRequest(this.sessionManager.getCwd());
		const currentPullRequestLabel = currentPullRequest
			? `Current PR #${currentPullRequest.number} — ${currentPullRequest.title}`
			: undefined;
		const choice = await this.showExtensionSelector("Review what?", [
			...(currentPullRequestLabel ? [currentPullRequestLabel] : []),
			branchLabel,
			uncommittedLabel,
			prLabel,
			commitLabel,
		]);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === currentPullRequestLabel && currentPullRequest) {
			return { kind: "pr", number: String(currentPullRequest.number) };
		}
		if (choice === branchLabel) {
			const base = await this.promptForReviewBaseBranch();
			if (!base) {
				return undefined;
			}
			return { kind: "branch", base };
		}
		if (choice === uncommittedLabel) {
			return { kind: "uncommitted" };
		}
		if (choice === prLabel) {
			const number = await this.showExtensionInput("PR number (empty for current branch's PR)", "123");
			if (number === undefined) {
				return undefined;
			}
			return { kind: "pr", number: number.trim() || undefined };
		}
		// Commit: the SHA is picked from the recent-commit list in handleReviewCommand.
		return { kind: "commit" };
	}

	/** Show logical local/upstream base branches and return the selected target. */
	private async promptForReviewBaseBranch(): Promise<string | undefined> {
		const branches = await listBaseBranches(this.sessionManager.getCwd());
		if ("error" in branches) {
			this.showError(branches.error);
			return undefined;
		}
		if (branches.length === 0) {
			this.showError("No branches to review against.");
			return undefined;
		}
		return this.showExtensionSelector("Select base branch", branches);
	}

	/** Show a recent-commit picker and return the selected SHA. */
	private async promptForReviewCommit(): Promise<string | undefined> {
		const commits = await listRecentCommits(this.sessionManager.getCwd());
		if ("error" in commits) {
			this.showError(commits.error);
			return undefined;
		}
		if (commits.length === 0) {
			this.showError("No commits to review.");
			return undefined;
		}
		const labels = commits.map((commit) => `${commit.sha} ${commit.subject} (${commit.date})`);
		const choice = await this.showExtensionSelector("Review which commit?", labels);
		if (choice === undefined) {
			return undefined;
		}
		return commits[labels.indexOf(choice)]?.sha;
	}

	private formatReviewToolSource(tool: ToolInfo): string {
		const source = tool.sourceInfo.source.trim();
		if (source === "builtin") {
			return "builtin";
		}
		if (source === "sdk") {
			return "custom";
		}
		const prefix =
			tool.sourceInfo.scope === "user" ? "user" : tool.sourceInfo.scope === "project" ? "project" : "temporary";
		return source ? `${prefix}:${source}` : prefix;
	}

	private getReviewToolsForRun(): string[] {
		const unavailableInReview = new Set(["read", "grep", "find", "ls", "edit", "write"]);
		const availableToolNames = new Set(
			this.session
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !unavailableInReview.has(name)),
		);
		const configuredTools = this.settingsManager.getReviewTools() ?? [];
		const selectedTools = configuredTools.filter((name) => availableToolNames.has(name));
		if (selectedTools.length !== configuredTools.length) {
			this.showWarning("Some configured auxiliary review tools are unavailable and were omitted.");
		}
		return [...new Set(selectedTools)];
	}

	private async showReviewToolsSelector(options: ReviewToolSelectorOption[]): Promise<string[] | undefined> {
		return new Promise((resolve) => {
			const previousView = this.activeView;
			const previousFocus = this.ui.getFocusedComponent();
			const restoreView = () => this.activateView(previousView, previousFocus ?? this.editor);

			const selector = new ReviewToolsSelectorComponent(
				options,
				(toolNames) => {
					restoreView();
					resolve(toolNames);
				},
				() => {
					restoreView();
					resolve(undefined);
				},
			);

			this.activateView(this.createDedicatedView(selector), selector);
		});
	}

	private async configureReviewTools(): Promise<void> {
		const unavailableInReview = new Set(["read", "grep", "find", "ls", "edit", "write"]);
		const tools = this.session.getAllTools().filter((tool) => !unavailableInReview.has(tool.name));
		if (tools.length === 0) {
			this.showError("No auxiliary tools are available to configure for review. Snapshot tools remain enabled.");
			return;
		}

		const activeTools = new Set(this.session.getActiveToolNames());
		const configuredTools = this.settingsManager.getReviewTools();
		const selectedTools = new Set(configuredTools ?? []);
		const options = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			source: this.formatReviewToolSource(tool),
			active: activeTools.has(tool.name),
			selected: selectedTools.has(tool.name),
		}));

		const selected = await this.showReviewToolsSelector(options);
		if (selected === undefined) {
			this.showStatus("Review tool selection cancelled");
			return;
		}
		this.settingsManager.setReviewTools(selected);
		this.showStatus(
			selected.length > 0
				? `Auxiliary review tools saved: ${selected.join(", ")}`
				: "Auxiliary review tools disabled; immutable snapshot tools remain active.",
		);
	}

	private async handleReviewCommand(argsText: string): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting) {
			this.showWarning("Wait for the current response to finish before starting a review.");
			return;
		}

		const parsedArgs = parseReviewCommandArgs(argsText);
		if (parsedArgs.error) {
			this.showError(parsedArgs.error);
			return;
		}
		if (parsedArgs.configureTools) {
			await this.configureReviewTools();
			return;
		}

		let target = parsedArgs.target;
		if (!target) {
			target = await this.promptForReviewTarget();
			if (!target) {
				this.showStatus("Review cancelled");
				return;
			}
		}
		if (target.kind === "commit" && !target.sha) {
			const sha = await this.promptForReviewCommit();
			if (!sha) {
				this.showStatus("Review cancelled");
				return;
			}
			target = { kind: "commit", sha };
		}

		await this.runInteractiveReviewWorkflow(target, {
			tools: this.getReviewToolsForRun(),
			requireConfirmation: false,
			requireProjectTrust: false,
			controls: parsedArgs.controls,
		});
	}

	private createReviewWorkflowHooks(): ReviewWorkflowHooks {
		const loader = new BorderedLoader(this.ui, theme, "Preparing review…");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		let baseMessage = "Preparing review…";
		let reviewRenderer: InlineSessionRenderer | undefined;
		let cleanedUp = false;
		return {
			signal: loader.signal,
			onProgress: (message) => {
				loader.setMessage(reviewRenderer ? `${baseMessage} ${message}` : message);
				this.ui.requestRender();
			},
			onPrepared: (resolution, model) => {
				baseMessage = `Reviewing ${resolution.description} with ${model.id}…`;
				loader.setMessage(baseMessage);
				this.editorContainer.clear();
				this.editorContainer.addChild(loader);
				this.ui.setFocus(loader);
				// Render the isolated review session live in the transcript so it reads like
				// a normal conversation. This remains transient and is removed on handoff.
				reviewRenderer = this.createInlineSessionRenderer({
					headerText: theme.fg("accent", `Reviewing ${resolution.description} with ${model.id}`),
					transformAssistantMessage: (message) => ({
						...message,
						content: message.content.map((part) =>
							part.type === "text" ? { ...part, text: stripReviewEnvelopeForDisplay(part.text) } : part,
						),
					}),
				});
				this.ui.requestRender();
			},
			onSessionEvent: (event) => reviewRenderer?.onSessionEvent(event),
			onUsage: (usage) => {
				this.footer.setTransientUsage(usage);
				this.ui.requestRender();
			},
			cleanup: () => {
				if (cleanedUp) return;
				cleanedUp = true;
				this.footer.setTransientUsage(undefined);
				reviewRenderer?.dispose();
				loader.dispose();
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
				this.ui.setFocus(this.editor);
				this.ui.requestRender();
			},
		};
	}

	/**
	 * Build a scoped, display-only renderer for an isolated child session's event
	 * stream (review runs and subagent conversations). It reuses the normal
	 * assistant/tool components but keeps its own streaming/pending-tool state so
	 * it never collides with the main session's live rendering.
	 */
	private createInlineSessionRenderer(options: {
		headerText: string;
		transformAssistantMessage?: (message: AssistantMessage) => AssistantMessage;
	}): InlineSessionRenderer {
		const group = new Container();
		const header = new Text(options.headerText, 1, 0);
		group.addChild(new Spacer(1));
		group.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		group.addChild(header);
		group.addChild(new Spacer(1));
		this.chatContainer.addChild(group);

		let streaming: AssistantMessageComponent | undefined;
		let streamingRenderCoalescer: StreamingRenderCoalescer<AssistantMessage> | undefined;
		const pending = new Map<string, ToolExecutionComponent>();
		const toolOptions = () => ({
			showImages: this.settingsManager.getShowImages(),
			imageWidthCells: this.settingsManager.getImageWidthCells(),
		});

		const forDisplay = options.transformAssistantMessage ?? ((message: AssistantMessage) => message);

		const upsertToolCalls = (message: AssistantMessage): void => {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const existing = pending.get(part.id);
				if (existing) {
					existing.updateArgs(part.arguments);
					continue;
				}
				const component = new ToolExecutionComponent(
					part.name,
					part.id,
					part.arguments,
					toolOptions(),
					this.getRegisteredToolDefinition(part.name),
					this.ui,
					this.sessionManager.getCwd(),
				);
				component.setExpanded(this.toolOutputExpanded);
				group.addChild(component);
				pending.set(part.id, component);
			}
		};

		const onSessionEvent = (event: AgentSessionEvent): void => {
			switch (event.type) {
				case "message_start":
					if (event.message.role === "assistant") {
						streamingRenderCoalescer?.dispose();
						streaming = new AssistantMessageComponent(
							undefined,
							this.hideThinkingBlock,
							this.getMarkdownThemeWithSettings(),
							this.hiddenThinkingLabel,
						);
						group.addChild(streaming);
						streamingRenderCoalescer = new StreamingRenderCoalescer((message: AssistantMessage) => {
							streaming?.updateContent(forDisplay(message));
							this.ui.requestRender();
						});
						streamingRenderCoalescer.commitNow(event.message);
					}
					break;
				case "message_update":
					if (streaming && event.message.role === "assistant") {
						if (isCoalescableAssistantUpdate(event.assistantMessageEvent.type)) {
							streamingRenderCoalescer?.update(event.message);
						} else {
							streamingRenderCoalescer?.commitNow(event.message);
						}
						if (event.assistantMessageEvent.type.startsWith("toolcall_")) {
							upsertToolCalls(event.message);
						}
					}
					return;
				case "message_end":
					if (streaming && event.message.role === "assistant") {
						streamingRenderCoalescer?.finish(event.message);
						streamingRenderCoalescer = undefined;
						for (const component of pending.values()) {
							component.setArgsComplete();
						}
						streaming = undefined;
					}
					return;
				case "tool_execution_start": {
					let component = pending.get(event.toolCallId);
					if (!component) {
						component = new ToolExecutionComponent(
							event.toolName,
							event.toolCallId,
							event.args,
							toolOptions(),
							this.getRegisteredToolDefinition(event.toolName),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						group.addChild(component);
						pending.set(event.toolCallId, component);
					}
					component.markExecutionStarted();
					break;
				}
				case "tool_execution_update": {
					pending.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
					break;
				}
				case "tool_execution_end": {
					const component = pending.get(event.toolCallId);
					if (component) {
						component.updateResult({ ...event.result, isError: event.isError });
						pending.delete(event.toolCallId);
					}
					break;
				}
				default:
					return;
			}
			this.ui.requestRender();
		};

		return {
			onSessionEvent,
			dispose: () => {
				streamingRenderCoalescer?.dispose();
				streamingRenderCoalescer = undefined;
				for (const component of pending.values()) {
					component.dispose();
				}
				pending.clear();
				this.chatContainer.removeChild(group);
				this.ui.requestRender();
			},
		};
	}

	private async runInteractiveReviewLifecycleAction(
		action: string,
		args: Record<string, unknown>,
	): Promise<Awaited<ReturnType<NonNullable<HostActionInvocationContext["runReviewLifecycleAction"]>>>> {
		const runId = typeof args.runId === "string" ? args.runId : undefined;
		const record = runId ? getReviewRun(this.session.sessionManager, runId) : undefined;
		if (action !== REVIEW_EXPORT_FEEDBACK_ACTION_ID && !record)
			throw new Error(`Unknown durable review run: ${runId ?? "missing"}`);
		if (action === REVIEW_FIX_ACTION_ID) {
			if (!record?.result) throw new Error(`Review run has no findings result: ${runId}`);
			const requestedFindingIds =
				typeof args.findingIds === "string" && args.findingIds.trim().length > 0
					? args.findingIds
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean)
					: undefined;
			const requestedIds = requestedFindingIds ?? record.result.findings.map((finding) => finding.id);
			const selectedIds = new Set(requestedIds);
			const unknown = requestedIds.filter(
				(findingId) => !record.result?.findings.some((finding) => finding.id === findingId),
			);
			if (unknown.length > 0) throw new Error(`Unknown finding ids: ${unknown.join(", ")}`);
			const selectedResult = {
				...record.result,
				findings: record.result.findings.filter((finding) => selectedIds.has(finding.id)),
			};
			const sourceSessionManager = this.session.sessionManager;
			const seedMessage = createReviewSeedMessage(record.target, { parsed: selectedResult });
			let targetSessionManager: SessionManager | undefined;
			let acknowledgedAt: number | undefined;
			const opened = await this.runtimeHost.newSession({
				setup: async (sessionManager) => {
					targetSessionManager = sessionManager;
					appendReviewRun(sessionManager, record);
				},
				withSession: async (context) => {
					await context.sendMessage(seedMessage);
					if (!targetSessionManager) throw new Error("Review session was not initialized");
					acknowledgedAt = acknowledgeReviewRun(
						targetSessionManager,
						record.runId,
						record.acknowledgedAt ?? Date.now(),
					).acknowledgedAt;
				},
			});
			if (!opened.cancelled && !opened.seeded)
				throw new Error("The review session opened without the selected findings.");
			if (opened.seeded && requestedFindingIds === undefined) {
				if (acknowledgedAt === undefined) throw new Error("Review session was seeded without acknowledgment");
				const sourceSessionFile = sourceSessionManager.getSessionFile();
				const acknowledgmentManager = sourceSessionFile
					? SessionManager.open(sourceSessionFile, sourceSessionManager.getSessionDir())
					: sourceSessionManager;
				acknowledgeReviewRun(acknowledgmentManager, record.runId, acknowledgedAt);
				await acknowledgmentManager.flush();
				if (sourceSessionFile) sourceSessionManager.setSessionFile(sourceSessionFile);
			}
			if (!opened.cancelled) this.renderCurrentSessionState();
			return {
				action,
				status: opened.cancelled ? "cancelled" : "completed",
				stateChanged: !opened.cancelled,
				actionsChanged: !opened.cancelled,
				message: opened.cancelled
					? "Review fix session cancelled"
					: `Opened ${selectedResult.findings.length} selected review finding${selectedResult.findings.length === 1 ? "" : "s"}`,
			};
		}
		if (action === REVIEW_FEEDBACK_ACTION_ID) {
			if (!record?.result) throw new Error(`Review run has no findings result: ${runId}`);
			const findingId = typeof args.findingId === "string" ? args.findingId : "";
			if (!record.result.findings.some((finding) => finding.id === findingId))
				throw new Error(`Unknown finding: ${findingId}`);
			const status = args.status;
			if (status !== "accepted" && status !== "fixed" && status !== "dismissed")
				throw new Error("Review outcome must be accepted, fixed, or dismissed.");
			const reason = args.reason;
			if (
				status === "dismissed" &&
				reason !== "false_positive" &&
				reason !== "intentional" &&
				reason !== "not_actionable" &&
				reason !== "other"
			)
				throw new Error("Dismissed findings require an explicit reason.");
			appendReviewFindingTransition(this.session.sessionManager, {
				runId: record.runId,
				findingId,
				status,
				...(reason === "false_positive" ||
				reason === "intentional" ||
				reason === "not_actionable" ||
				reason === "other"
					? { reason }
					: {}),
				...(typeof args.note === "string" ? { note: args.note } : {}),
			});
			await this.session.sessionManager.flush();
			return {
				action,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
				message: `Finding ${findingId} marked ${status}`,
			};
		}
		if (action === REVIEW_RERUN_ACTION_ID) {
			if (!record) throw new Error(`Unknown durable review run: ${runId}`);
			const target = reviewTargetForRerun(record);
			const rerun = await this.runInteractiveReviewWorkflow(target, {
				tools: this.getReviewToolsForRun(),
				requireConfirmation: true,
				requireProjectTrust: false,
				controls: { ...record.options, scopeMode: args.scopeMode === "full" ? "full" : "incremental" },
				parentRunId: record.runId,
			});
			return {
				action,
				status: rerun.status === "completed" ? "completed" : "cancelled",
				stateChanged: rerun.status === "completed",
				actionsChanged: true,
				message: rerun.status === "completed" ? formatReviewWorkflowSummary(rerun) : "Review rerun cancelled",
			};
		}
		if (action === REVIEW_PUBLISH_ACTION_ID) {
			if (!record) throw new Error(`Unknown durable review run: ${runId}`);
			const confirmed = await this.showExtensionConfirm(
				"Publish pull request review",
				`Publish complete review ${record.runId} to GitHub? The PR head will be rechecked first.`,
			);
			if (!confirmed) return { action, status: "cancelled", message: "Review publishing cancelled" };
			const published = await publishReviewRun(this.sessionManager.getCwd(), record);
			appendReviewPublication(this.session.sessionManager, { runId: record.runId, ...published });
			await this.session.sessionManager.flush();
			return {
				action,
				status: "completed",
				message: published.url ? `Review published: ${published.url}` : "Review published",
			};
		}
		if (action === REVIEW_EXPORT_FEEDBACK_ACTION_ID) {
			const requestedPath =
				typeof args.path === "string"
					? args.path
					: await this.showExtensionInput("Export review feedback", "review-feedback.json");
			if (!requestedPath?.trim())
				return { action, status: "cancelled", message: "Review feedback export cancelled" };
			const outputPath = path.resolve(this.sessionManager.getCwd(), requestedPath.trim());
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(
				outputPath,
				`${JSON.stringify(exportReviewFeedback(this.session.sessionManager), null, 2)}\n`,
				{ mode: 0o600 },
			);
			return { action, status: "completed", message: `Review feedback exported to ${outputPath}` };
		}
		throw new Error(`Unsupported review lifecycle action: ${action}`);
	}

	private async runInteractiveReviewWorkflow(
		target: ReviewTarget,
		options: {
			tools: readonly string[];
			requireConfirmation: boolean;
			requireProjectTrust: boolean;
			controls?: Partial<ReviewRunControls>;
			parentRunId?: string;
		},
	): Promise<Awaited<ReturnType<NonNullable<HostActionInvocationContext["runReviewAction"]>>>> {
		if (this.activeInteractiveReview) {
			this.showWarning("A review is already running. Cancel it before starting another.");
			return { status: "cancelled" };
		}
		this.activeInteractiveReview = true;
		try {
			const result = await runReviewWorkflow({
				target,
				controls: options.controls,
				...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
				cwd: this.sessionManager.getCwd(),
				agentDir: this.runtimeHost.services.agentDir,
				session: this.session,
				newSession: (newSessionOptions) => this.runtimeHost.newSession(newSessionOptions),
				authStorage: this.session.modelRegistry.authStorage,
				settingsManager: this.settingsManager,
				tools: options.tools,
				requireConfirmation: options.requireConfirmation,
				requireProjectTrust: options.requireProjectTrust,
				confirm: ({ title, message }) => this.showExtensionConfirm(title, message),
				onReviewModelWarning: (message) => this.showWarning(message),
				createHooks: () => this.createReviewWorkflowHooks(),
			});

			if (result.status !== "completed") {
				this.showStatus("Review cancelled");
				return result;
			}

			if (result.sessionSwitchCancelled) {
				this.showStatus("Review complete (session switch was cancelled; findings added to this session)");
				return result;
			}
			this.renderCurrentSessionState();
			this.showStatus(
				`${formatReviewWorkflowSummary(result)} This is a fresh session seeded with the review. Tell me which findings to fix (e.g. "fix 1 and 3").`,
			);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(
				message.includes("git") || message.includes("repository") ? `${message} ${REVIEW_USAGE}` : message,
			);
			return { status: "cancelled" };
		} finally {
			this.activeInteractiveReview = false;
		}
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			await BUILTIN_HOST_ACTION_REGISTRY.invokeBySlashAlias(
				CONTEXT_COMPACT_SLASH_ALIAS,
				this.createHostActionContext(),
				{
					customInstructions,
				},
			);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.clearTurnDoneAlertTimer();
		this.stopWorkingElapsedTicker();
		this.streamingRenderCoalescer?.dispose();
		this.streamingRenderCoalescer = undefined;
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.planPaneInputUnsubscribe?.();
		this.planPaneInputUnsubscribe = undefined;
		this.dismissSubagentInspector?.();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.session.closeLspTraceSync();
		this.cleanupAllScratchDirectories();
		this.unregisterSignalHandlers();
	}
}
