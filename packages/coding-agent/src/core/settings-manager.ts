import type { Transport } from "@earendil-works/volt-ai";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import type { LspSettings } from "./lsp/config.ts";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

export interface ProfileStorageSettings {
	/** Reserved for future per-profile auth isolation. Ignored by the MVP. */
	authDir?: string;
	/** Reserved for future per-profile session isolation. Ignored by the MVP. */
	sessionDir?: string;
}

export type ProfileSettings = Omit<
	Settings,
	| "lastChangelogVersion"
	| "defaultProfile"
	| "profiles"
	| "defaultProjectTrust"
	| "enableInstallTelemetry"
	| "enableAnalytics"
	| "trackingId"
	| "sessionDir"
> & {
	/** Reserved for future per-profile storage isolation. Ignored by the MVP. */
	storage?: ProfileStorageSettings;
};

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: store package metadata and optionally filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			scripts?: "never" | "allow";
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProfile?: string;
	profiles?: Record<string, ProfileSettings>;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	reviewModel?: string; // Model for /review, e.g. "anthropic/claude-opus-4-5" (falls back to the session model)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	lsp?: LspSettings; // LSP diagnostics after edit/write (see docs/lsp.md)
}

/** Deep merge records: overrides take precedence, nested objects merge recursively, arrays replace. */
function deepMergeRecord(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };

	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		if (isSettingsRecord(baseValue) && isSettingsRecord(overrideValue)) {
			result[key] = deepMergeRecord(baseValue, overrideValue);
		} else {
			result[key] = overrideValue;
		}
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively. */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeRecord(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function normalizeProfileName(profile: string | undefined): string | undefined {
	const trimmed = profile?.trim();
	return trimmed ? trimmed : undefined;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOwnEnumerableProperty(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function getOwnProfileSettings(settings: Settings, profileName: string): ProfileSettings | undefined {
	const profiles = settings.profiles;
	if (!isSettingsRecord(profiles) || !Object.hasOwn(profiles, profileName)) {
		return undefined;
	}

	const profile = profiles[profileName];
	return isSettingsRecord(profile) ? (profile as ProfileSettings) : undefined;
}

function cloneProfiles(profiles: Settings["profiles"]): Record<string, ProfileSettings> {
	const cloned: Record<string, ProfileSettings> = {};
	if (!isSettingsRecord(profiles)) {
		return cloned;
	}

	for (const [profileName, profile] of Object.entries(profiles)) {
		defineOwnEnumerableProperty(cloned, profileName, profile);
	}
	return cloned;
}

function sanitizeProfileSettings(profile: ProfileSettings | undefined): Settings {
	if (!profile) {
		return {};
	}

	const sanitized = structuredClone(profile) as Record<string, unknown>;
	delete sanitized.lastChangelogVersion;
	delete sanitized.defaultProfile;
	delete sanitized.profiles;
	delete sanitized.defaultProjectTrust;
	delete sanitized.enableInstallTelemetry;
	delete sanitized.enableAnalytics;
	delete sanitized.trackingId;
	delete sanitized.sessionDir;
	delete sanitized.storage;
	return sanitized as Settings;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
	profile?: string;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

interface ModifiedSetting {
	field: keyof Settings;
	nestedKey?: string;
}

type ModifiedProfileNestedFields = Map<string, Map<keyof Settings, Set<string>>>;

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private globalEffectiveSettings: Settings = {};
	private projectEffectiveSettings: Settings = {};
	private settings: Settings = {};
	private requestedProfile: string | undefined;
	private activeProfile: string | undefined;
	private reportedMissingProfiles = new Set<string>();
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProfileFields = new Map<string, Set<keyof Settings>>(); // Track global profile field modifications
	private modifiedProfileNestedFields: ModifiedProfileNestedFields = new Map(); // Track global profile nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private modifiedProjectProfileFields = new Map<string, Set<keyof Settings>>(); // Track project profile field modifications
	private modifiedProjectProfileNestedFields: ModifiedProfileNestedFields = new Map(); // Track project profile nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private sessionOverrides: Settings = {}; // Runtime overrides (e.g. CLI flags), reapplied on every re-merge

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		profile?: string,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.requestedProfile = normalizeProfileName(profile);
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.mergeEffectiveSettings();
	}

	private applyProfile(settings: Settings, profileName: string | undefined): Settings {
		if (!profileName) {
			return settings;
		}
		return deepMergeSettings(settings, sanitizeProfileSettings(getOwnProfileSettings(settings, profileName)));
	}

	private reportMissingProfile(profileName: string): void {
		if (!this.projectTrusted || this.reportedMissingProfiles.has(profileName)) {
			return;
		}
		if (
			getOwnProfileSettings(this.globalSettings, profileName) ||
			getOwnProfileSettings(this.projectSettings, profileName)
		) {
			return;
		}
		this.reportedMissingProfiles.add(profileName);
		this.recordError("global", new Error(`Profile "${profileName}" was selected but is not defined`));
	}

	/** Re-merge effective settings from global, project, profile overlays, and session overrides */
	private mergeEffectiveSettings(): void {
		const baseSettings = deepMergeSettings(this.globalSettings, this.projectSettings);
		const profileName = this.requestedProfile ?? normalizeProfileName(baseSettings.defaultProfile);
		this.activeProfile = profileName;
		this.globalEffectiveSettings = this.applyProfile(this.globalSettings, profileName);
		this.projectEffectiveSettings = this.projectTrusted ? this.applyProfile(this.projectSettings, profileName) : {};

		let merged = deepMergeSettings(this.globalEffectiveSettings, this.projectEffectiveSettings);
		if (Object.keys(this.sessionOverrides).length > 0) {
			merged = deepMergeSettings(merged, this.sessionOverrides);
		}
		this.settings = merged;
		if (profileName) {
			this.reportMissingProfile(profileName);
		}
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			options.profile,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getGlobalEffectiveSettings(): Settings {
		return structuredClone(this.globalEffectiveSettings);
	}

	getProjectEffectiveSettings(): Settings {
		return structuredClone(this.projectEffectiveSettings);
	}

	getActiveProfile(): string | undefined {
		return this.activeProfile;
	}

	getRequestedProfile(): string | undefined {
		return this.requestedProfile;
	}

	getProfileNames(): string[] {
		const names = new Set<string>();
		const addProfileNames = (profiles: Settings["profiles"]) => {
			if (!isSettingsRecord(profiles)) {
				return;
			}
			for (const [profileName, profile] of Object.entries(profiles)) {
				if (isSettingsRecord(profile)) {
					names.add(profileName);
				}
			}
		};

		addProfileNames(this.globalSettings.profiles);
		if (this.projectTrusted) {
			addProfileNames(this.projectSettings.profiles);
		}
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	hasProfile(profile: string): boolean {
		const profileName = normalizeProfileName(profile);
		if (!profileName) {
			return false;
		}
		return (
			getOwnProfileSettings(this.globalSettings, profileName) !== undefined ||
			(this.projectTrusted && getOwnProfileSettings(this.projectSettings, profileName) !== undefined)
		);
	}

	ensureGlobalProfile(profile: string): string {
		const profileName = normalizeProfileName(profile);
		if (!profileName) {
			throw new Error("Profile name cannot be empty");
		}
		if (getOwnProfileSettings(this.globalSettings, profileName)) {
			return profileName;
		}

		this.globalSettings.profiles = cloneProfiles(this.globalSettings.profiles);
		defineOwnEnumerableProperty(this.globalSettings.profiles, profileName, {});
		this.markProfileModified(profileName);
		this.save();
		return profileName;
	}

	setActiveProfile(profile: string | undefined): void {
		this.requestedProfile = normalizeProfileName(profile);
		this.reportedMissingProfiles.clear();
		this.mergeEffectiveSettings();
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
		this.modifiedProjectProfileFields.clear();
		this.modifiedProjectProfileNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.mergeEffectiveSettings();
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.mergeEffectiveSettings();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProfileFields.clear();
		this.modifiedProfileNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
		this.modifiedProjectProfileFields.clear();
		this.modifiedProjectProfileNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.mergeEffectiveSettings();
	}

	/** Apply additional overrides on top of current settings. Overrides persist across reload() and re-merges. */
	applyOverrides(overrides: Partial<Settings>): void {
		this.sessionOverrides = deepMergeSettings(this.sessionOverrides, overrides);
		this.mergeEffectiveSettings();
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private trackProfileNestedField(
		modifiedNestedFields: ModifiedProfileNestedFields,
		profileName: string,
		field: keyof Settings,
		nestedKey: string,
	): void {
		let profileNestedFields = modifiedNestedFields.get(profileName);
		if (!profileNestedFields) {
			profileNestedFields = new Map();
			modifiedNestedFields.set(profileName, profileNestedFields);
		}
		if (!profileNestedFields.has(field)) {
			profileNestedFields.set(field, new Set());
		}
		profileNestedFields.get(field)!.add(nestedKey);
	}

	private markProfileModified(profileName: string, field?: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add("profiles");
		if (!this.modifiedProfileFields.has(profileName)) {
			this.modifiedProfileFields.set(profileName, new Set());
		}
		if (field !== undefined) {
			this.modifiedProfileFields.get(profileName)!.add(field);
			if (nestedKey) {
				this.trackProfileNestedField(this.modifiedProfileNestedFields, profileName, field, nestedKey);
			}
		}
	}

	private markProjectProfileModified(profileName: string, field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add("profiles");
		if (!this.modifiedProjectProfileFields.has(profileName)) {
			this.modifiedProjectProfileFields.set(profileName, new Set());
		}
		this.modifiedProjectProfileFields.get(profileName)!.add(field);
		if (nestedKey) {
			this.trackProfileNestedField(this.modifiedProjectProfileNestedFields, profileName, field, nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			this.modifiedProfileFields.clear();
			this.modifiedProfileNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
		this.modifiedProjectProfileFields.clear();
		this.modifiedProjectProfileNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private cloneModifiedProfileFields(source: Map<string, Set<keyof Settings>>): Map<string, Set<keyof Settings>> {
		const snapshot = new Map<string, Set<keyof Settings>>();
		for (const [profileName, fields] of source.entries()) {
			snapshot.set(profileName, new Set(fields));
		}
		return snapshot;
	}

	private cloneModifiedProfileNestedFields(source: ModifiedProfileNestedFields): ModifiedProfileNestedFields {
		const snapshot: ModifiedProfileNestedFields = new Map();
		for (const [profileName, profileNestedFields] of source.entries()) {
			const clonedNestedFields = new Map<keyof Settings, Set<string>>();
			for (const [field, nestedFields] of profileNestedFields.entries()) {
				clonedNestedFields.set(field, new Set(nestedFields));
			}
			snapshot.set(profileName, clonedNestedFields);
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
		modifiedProfileFields: Map<string, Set<keyof Settings>>,
		modifiedProfileNestedFields: ModifiedProfileNestedFields,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (field === "profiles" && modifiedProfileFields.size > 0) {
					const currentProfiles = isSettingsRecord(currentFileSettings.profiles)
						? currentFileSettings.profiles
						: {};
					const snapshotProfiles = isSettingsRecord(snapshotSettings.profiles) ? snapshotSettings.profiles : {};
					const mergedProfiles: Record<string, unknown> = {};
					for (const [profileName, profile] of Object.entries(currentProfiles)) {
						defineOwnEnumerableProperty(mergedProfiles, profileName, profile);
					}

					for (const [profileName, profileFields] of modifiedProfileFields.entries()) {
						const currentProfile: Record<string, unknown> =
							Object.hasOwn(currentProfiles, profileName) && isSettingsRecord(currentProfiles[profileName])
								? currentProfiles[profileName]
								: {};
						const snapshotProfile: Record<string, unknown> =
							Object.hasOwn(snapshotProfiles, profileName) && isSettingsRecord(snapshotProfiles[profileName])
								? snapshotProfiles[profileName]
								: {};
						if (profileFields.size === 0) {
							defineOwnEnumerableProperty(mergedProfiles, profileName, snapshotProfile);
							continue;
						}
						const mergedProfile: Record<string, unknown> = {};
						const profileNestedFields = modifiedProfileNestedFields.get(profileName);
						for (const [profileField, profileValue] of Object.entries(currentProfile)) {
							defineOwnEnumerableProperty(mergedProfile, profileField, profileValue);
						}
						for (const profileField of profileFields) {
							const nestedModified = profileNestedFields?.get(profileField);
							const snapshotValue = snapshotProfile[profileField];
							if (nestedModified && isSettingsRecord(snapshotValue)) {
								const baseNested = isSettingsRecord(currentProfile[profileField])
									? currentProfile[profileField]
									: {};
								const mergedNested: Record<string, unknown> = { ...baseNested };
								for (const nestedKey of nestedModified) {
									mergedNested[nestedKey] = snapshotValue[nestedKey];
								}
								defineOwnEnumerableProperty(mergedProfile, profileField, mergedNested);
							} else {
								defineOwnEnumerableProperty(mergedProfile, profileField, snapshotValue);
							}
						}
						defineOwnEnumerableProperty(mergedProfiles, profileName, mergedProfile);
					}

					mergedSettings.profiles = mergedProfiles as Record<string, ProfileSettings>;
				} else if (modifiedNestedFields.has(field) && isSettingsRecord(value)) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = isSettingsRecord(currentFileSettings[field]) ? currentFileSettings[field] : {};
					const mergedNested: Record<string, unknown> = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = value[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.mergeEffectiveSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);
		const modifiedProfileFields = this.cloneModifiedProfileFields(this.modifiedProfileFields);
		const modifiedProfileNestedFields = this.cloneModifiedProfileNestedFields(this.modifiedProfileNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings(
				"global",
				snapshotGlobalSettings,
				modifiedFields,
				modifiedNestedFields,
				modifiedProfileFields,
				modifiedProfileNestedFields,
			);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.mergeEffectiveSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		const modifiedProfileFields = this.cloneModifiedProfileFields(this.modifiedProjectProfileFields);
		const modifiedProfileNestedFields = this.cloneModifiedProfileNestedFields(
			this.modifiedProjectProfileNestedFields,
		);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings(
				"project",
				snapshotProjectSettings,
				modifiedFields,
				modifiedNestedFields,
				modifiedProfileFields,
				modifiedProfileNestedFields,
			);
		});
	}

	private updateProfileSettings(settings: Settings, profileName: string, update: (settings: Settings) => void): void {
		settings.profiles = cloneProfiles(settings.profiles);
		const profileSettings = structuredClone(getOwnProfileSettings(settings, profileName) ?? {}) as Settings;
		update(profileSettings);
		defineOwnEnumerableProperty(settings.profiles, profileName, profileSettings);
	}

	private updateGlobalSettings(field: keyof Settings, update: (settings: Settings) => void, nestedKey?: string): void {
		this.updateGlobalSettingsFields([{ field, nestedKey }], update);
	}

	private updateGlobalSettingsFields(modifiedSettings: ModifiedSetting[], update: (settings: Settings) => void): void {
		if (this.activeProfile) {
			this.updateProfileSettings(this.globalSettings, this.activeProfile, update);
			for (const modifiedSetting of modifiedSettings) {
				this.markProfileModified(this.activeProfile, modifiedSetting.field, modifiedSetting.nestedKey);
			}
		} else {
			update(this.globalSettings);
			for (const modifiedSetting of modifiedSettings) {
				this.markModified(modifiedSetting.field, modifiedSetting.nestedKey);
			}
		}
		this.save();
	}

	private updateProjectSettings(
		field: keyof Settings,
		update: (settings: Settings) => void,
		nestedKey?: string,
	): void {
		this.updateProjectSettingsFields([{ field, nestedKey }], update);
	}

	private updateProjectSettingsFields(
		modifiedSettings: ModifiedSetting[],
		update: (settings: Settings) => void,
	): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		if (this.activeProfile) {
			this.updateProfileSettings(projectSettings, this.activeProfile, update);
			for (const modifiedSetting of modifiedSettings) {
				this.markProjectProfileModified(this.activeProfile, modifiedSetting.field, modifiedSetting.nestedKey);
			}
		} else {
			update(projectSettings);
			for (const modifiedSetting of modifiedSettings) {
				this.markProjectModified(modifiedSetting.field, modifiedSetting.nestedKey);
			}
		}
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.updateGlobalSettings("defaultProvider", (settings) => {
			settings.defaultProvider = provider;
		});
	}

	setDefaultModel(modelId: string): void {
		this.updateGlobalSettings("defaultModel", (settings) => {
			settings.defaultModel = modelId;
		});
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.updateGlobalSettingsFields([{ field: "defaultProvider" }, { field: "defaultModel" }], (settings) => {
			settings.defaultProvider = provider;
			settings.defaultModel = modelId;
		});
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.updateGlobalSettings("steeringMode", (settings) => {
			settings.steeringMode = mode;
		});
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.updateGlobalSettings("followUpMode", (settings) => {
			settings.followUpMode = mode;
		});
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.updateGlobalSettings("theme", (settings) => {
			settings.theme = theme;
		});
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.updateGlobalSettings("defaultThinkingLevel", (settings) => {
			settings.defaultThinkingLevel = level;
		});
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.updateGlobalSettings("transport", (settings) => {
			settings.transport = transport;
		});
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.updateGlobalSettings(
			"compaction",
			(settings) => {
				if (!settings.compaction) {
					settings.compaction = {};
				}
				settings.compaction.enabled = enabled;
			},
			"enabled",
		);
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.updateGlobalSettings(
			"retry",
			(settings) => {
				if (!settings.retry) {
					settings.retry = {};
				}
				settings.retry.enabled = enabled;
			},
			"enabled",
		);
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.updateGlobalSettings("httpIdleTimeoutMs", (settings) => {
			settings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		});
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.updateGlobalSettings("hideThinkingBlock", (settings) => {
			settings.hideThinkingBlock = hide;
		});
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.updateGlobalSettings("shellPath", (settings) => {
			settings.shellPath = path;
		});
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.updateGlobalSettings("quietStartup", (settings) => {
			settings.quietStartup = quiet;
		});
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.updateGlobalSettings("shellCommandPrefix", (settings) => {
			settings.shellCommandPrefix = prefix;
		});
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.updateGlobalSettings("npmCommand", (settings) => {
			settings.npmCommand = command ? [...command] : undefined;
		});
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.updateGlobalSettings("collapseChangelog", (settings) => {
			settings.collapseChangelog = collapse;
		});
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.updateGlobalSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.updateGlobalSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.updateGlobalSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.updateGlobalSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.updateGlobalSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.updateGlobalSettings("enableSkillCommands", (settings) => {
			settings.enableSkillCommands = enabled;
		});
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.updateGlobalSettings(
			"terminal",
			(settings) => {
				if (!settings.terminal) {
					settings.terminal = {};
				}
				settings.terminal.showImages = show;
			},
			"showImages",
		);
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		this.updateGlobalSettings(
			"terminal",
			(settings) => {
				if (!settings.terminal) {
					settings.terminal = {};
				}
				settings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
			},
			"imageWidthCells",
		);
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.VOLT_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		this.updateGlobalSettings(
			"terminal",
			(settings) => {
				if (!settings.terminal) {
					settings.terminal = {};
				}
				settings.terminal.clearOnShrink = enabled;
			},
			"clearOnShrink",
		);
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		this.updateGlobalSettings(
			"terminal",
			(settings) => {
				if (!settings.terminal) {
					settings.terminal = {};
				}
				settings.terminal.showTerminalProgress = enabled;
			},
			"showTerminalProgress",
		);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.updateGlobalSettings(
			"images",
			(settings) => {
				if (!settings.images) {
					settings.images = {};
				}
				settings.images.autoResize = enabled;
			},
			"autoResize",
		);
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.updateGlobalSettings(
			"images",
			(settings) => {
				if (!settings.images) {
					settings.images = {};
				}
				settings.images.blockImages = blocked;
			},
			"blockImages",
		);
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getReviewModel(): string | undefined {
		return this.settings.reviewModel;
	}

	setReviewModel(modelReference: string | undefined): void {
		this.updateGlobalSettings("reviewModel", (settings) => {
			settings.reviewModel = modelReference;
		});
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.updateGlobalSettings("enabledModels", (settings) => {
			settings.enabledModels = patterns;
		});
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.updateGlobalSettings("doubleEscapeAction", (settings) => {
			settings.doubleEscapeAction = action;
		});
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.updateGlobalSettings("treeFilterMode", (settings) => {
			settings.treeFilterMode = mode;
		});
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.VOLT_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.updateGlobalSettings("showHardwareCursor", (settings) => {
			settings.showHardwareCursor = enabled;
		});
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.updateGlobalSettings("editorPaddingX", (settings) => {
			settings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		});
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.updateGlobalSettings("autocompleteMaxVisible", (settings) => {
			settings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		});
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getLspSettings(): LspSettings | undefined {
		return this.settings.lsp ? structuredClone(this.settings.lsp) : undefined;
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.updateGlobalSettings("warnings", (settings) => {
			settings.warnings = { ...warnings };
		});
	}
}
