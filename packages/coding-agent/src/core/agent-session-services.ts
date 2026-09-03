import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Model } from "@hansjm10/volt-ai";
import { getAgentDir } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { GitContextProvider } from "./git-context-provider.ts";
import type { HostInteraction } from "./host-interaction.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { AgentMode } from "./planning.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSessionForRuntime } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { SubagentToolManager } from "./tools/index.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	/** Runtime working directory for tools and session metadata. */
	cwd: string;
	/** Project/config root for .volt resources. Defaults to cwd. */
	projectCwd?: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	profile?: string;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	/** Optional host-owned display name for Git context. */
	workspaceName?: string;
	/** Optional trusted local base ref for managed-worktree divergence. */
	baseRef?: string;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	agentMode?: AgentMode;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	allowUnlistedExtensionTools?: CreateAgentSessionOptions["allowUnlistedExtensionTools"];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	hostInteraction?: HostInteraction;
	subagentToolManager?: SubagentToolManager;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	/** Canonical project root used by project-scoped services. */
	projectCwd: string;
	/** Original absolute project-root spelling retained for lexical LSP validation. */
	lexicalProjectCwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	gitContextProvider: GitContextProvider;
	workspaceName?: string;
	baseRef?: string;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const lexicalProjectCwd = resolvePath(options.projectCwd ?? cwd);
	const projectCwd = canonicalizePath(lexicalProjectCwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager =
		options.settingsManager ?? SettingsManager.create(projectCwd, agentDir, { profile: options.profile });
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd: projectCwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);
	// Fire-and-forget initial scan: session creation never waits for Git, and
	// state reads serve null until the first scan lands.
	const gitContextProvider = new GitContextProvider(cwd, {
		workspaceName: options.workspaceName,
		baseRef: options.baseRef,
	});
	void gitContextProvider.refresh();

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		projectCwd,
		lexicalProjectCwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		gitContextProvider,
		workspaceName: options.workspaceName,
		baseRef: options.baseRef,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This helper is intended for a CreateAgentSessionRuntimeFactory callback. The
 * enclosing runtime operation owns manager cleanup until this returns; this
 * function therefore does not close the manager on pre-session failure.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSessionForRuntime({
		cwd: options.services.cwd,
		projectCwd: options.services.lexicalProjectCwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		gitContextProvider: options.services.gitContextProvider,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		agentMode: options.agentMode,
		scopedModels: options.scopedModels,
		tools: options.tools,
		allowUnlistedExtensionTools: options.allowUnlistedExtensionTools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
		hostInteraction: options.hostInteraction,
		subagentToolManager: options.subagentToolManager,
	});
}
