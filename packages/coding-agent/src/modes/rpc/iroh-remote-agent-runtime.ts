import { join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir } from "../../config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "../../core/auth-guidance.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import {
	type IrohRemoteRuntimeToolPolicy,
	parseIrohRemoteAllowTools,
	usesDefaultIrohRemoteAllowTools,
} from "../../core/remote/iroh/index.ts";
import { getDefaultSessionDir, type SessionManager, type SessionReference } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	SubagentManager,
	type SubagentRuntimeCreatedEvent,
	type SubagentRuntimeRegistration,
} from "../../core/subagents/index.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	type ResolvedSessionTargetWithManager,
	resolveIrohRemoteSessionTarget,
} from "../../daemon/session-target.ts";
import { runMigrations } from "../../migrations.ts";
import { resolvePath } from "../../utils/paths.ts";

export interface IrohRemoteAgentRuntimeOptions {
	/** Legacy unresolved grant used by direct callers. Daemon runtimes pass toolPolicy instead. */
	allowTools?: string;
	/** Pre-composed client/workspace/daemon policy. Preserves an explicit deny-all. */
	toolPolicy?: IrohRemoteRuntimeToolPolicy;
	agentDir?: string;
	conversationTarget?: IrohRemoteAgentRuntimeConversationTarget;
	/** Runtime working directory for tools/session state. */
	cwd: string;
	/** Project/config root for .volt resources. Defaults to cwd. */
	projectCwd?: string;
	/** Host-owned workspace display name for Git context. */
	workspaceName?: string;
	/** Trusted managed-worktree base ref for Git context. */
	baseRef?: string;
	onSubagentRuntimeCreated?: (
		event: IrohRemoteSubagentRuntimeCreatedEvent,
	) => SubagentRuntimeRegistration | Promise<SubagentRuntimeRegistration> | Promise<void> | void;
	profile?: string;
	projectTrusted?: boolean;
	/**
	 * Pre-resolved session target (daemon path); skips internal target resolution.
	 * Ownership transfers here until success: failed created targets are discarded,
	 * while failed resumed targets are only closed.
	 */
	resolvedSessionTarget?: ResolvedSessionTargetWithManager<SessionManager>;
	resumeSessionId?: string;
	sessionDir?: string;
	/** Validate the resolved session cwd before services/tools are created. */
	validateCwd?: (cwd: string) => Promise<void> | void;
}

export interface IrohRemoteSubagentRuntimeCreatedEvent extends SubagentRuntimeCreatedEvent {
	parentSessionId: string;
	parentSessionRef?: SessionReference;
}

export type IrohRemoteAgentRuntimeConversationTarget =
	| {
			target: "last";
			resumeSessionId?: string;
	  }
	| {
			target: "new";
			sessionId?: string;
	  }
	| {
			target: "session";
			sessionId: string;
	  };

export type IrohRemoteAgentRuntimeSessionSelection =
	| {
			kind: "created";
			sessionRef?: SessionReference;
			sessionId: string;
	  }
	| {
			kind: "created_after_missing";
			requestedSessionId: string;
			sessionRef?: SessionReference;
			sessionId: string;
	  }
	| {
			kind: "resumed";
			requestedSessionId: string;
			sessionRef?: SessionReference;
			sessionId: string;
	  };

export interface IrohRemoteAgentRuntimeResult {
	runtime: AgentSessionRuntime;
	sessionSelection: IrohRemoteAgentRuntimeSessionSelection;
}

export async function createIrohRemoteAgentRuntime(
	options: IrohRemoteAgentRuntimeOptions,
): Promise<AgentSessionRuntime> {
	return (await createIrohRemoteAgentRuntimeWithSessionSelection(options)).runtime;
}

export async function createIrohRemoteAgentRuntimeWithSessionSelection(
	options: IrohRemoteAgentRuntimeOptions,
): Promise<IrohRemoteAgentRuntimeResult> {
	const agentDir = resolvePath(options.agentDir ?? getAgentDir());
	const projectCwd = resolvePath(options.projectCwd ?? options.cwd);
	runIrohRemoteStartupMigrations(projectCwd, agentDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const tools = options.toolPolicy ? [...options.toolPolicy.tools] : parseIrohRemoteAllowTools(options.allowTools);
	const allowUnlistedExtensionTools =
		options.toolPolicy?.allowUnlistedExtensionTools ?? usesDefaultIrohRemoteAllowTools(options.allowTools);
	const projectTrusted = options.projectTrusted ?? false;

	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const profile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : options.profile;
		const settingsManager = SettingsManager.create(projectCwd, runtimeOptions.agentDir, {
			profile,
			projectTrusted,
		});
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
		const services = await createAgentSessionServices({
			authStorage,
			cwd: runtimeOptions.cwd,
			projectCwd,
			agentDir: runtimeOptions.agentDir,
			settingsManager,
			workspaceName: runtimeOptions.workspaceName ?? options.workspaceName,
			baseRef: runtimeOptions.baseRef ?? options.baseRef,
		});
		const subagentManager = new SubagentManager({
			createRuntime,
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			workspaceName: services.workspaceName,
			baseRef: services.baseRef,
			resourceLoader: services.resourceLoader,
			parentSessionManager: runtimeOptions.sessionManager,
			...(runtimeOptions.subagentContext ? { subagentContext: runtimeOptions.subagentContext } : {}),
			retainRuntimeOnDispose: options.onSubagentRuntimeCreated !== undefined,
			onRuntimeCreated: options.onSubagentRuntimeCreated
				? (event) =>
						options.onSubagentRuntimeCreated?.({
							...event,
							parentSessionId: runtimeOptions.sessionManager.getSessionId(),
							...(runtimeOptions.sessionManager.getSessionRef() === undefined
								? {}
								: { parentSessionRef: runtimeOptions.sessionManager.getSessionRef() }),
						})
				: undefined,
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			tools,
			allowUnlistedExtensionTools,
			subagentToolManager: subagentManager,
		});
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};

	const sessionTarget = await createIrohRemoteSessionManager(options, agentDir);
	let runtime: AgentSessionRuntime | undefined;
	try {
		await options.validateCwd?.(sessionTarget.sessionManager.getCwd());
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionTarget.sessionManager.getCwd(),
			agentDir,
			sessionManager: sessionTarget.sessionManager,
			profile: options.profile,
		});
		const errors = runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (errors.length > 0) {
			throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (!runtime.session.model) {
			throw new Error(formatNoModelsAvailableMessage());
		}
		return { runtime, sessionSelection: sessionTarget.selection };
	} catch (error) {
		return cleanupFailedIrohRemoteAgentRuntime(error, runtime, sessionTarget.sessionManager, sessionTarget.selection);
	}
}

async function cleanupFailedIrohRemoteAgentRuntime(
	error: unknown,
	runtime: AgentSessionRuntime | undefined,
	sessionManager: SessionManager,
	selection: IrohRemoteAgentRuntimeSessionSelection,
): Promise<never> {
	const cleanupErrors: unknown[] = [];
	if (runtime) {
		try {
			await runtime.dispose();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
	}
	try {
		if (selection.kind === "resumed") {
			await sessionManager.closePersistence();
		} else {
			await sessionManager.discardPersistence();
		}
	} catch (cleanupError) {
		if (!cleanupErrors.includes(cleanupError)) cleanupErrors.push(cleanupError);
	}
	if (cleanupErrors.length === 0) throw error;

	const aggregate = new AggregateError(
		[error, ...cleanupErrors],
		error instanceof Error ? error.message : String(error),
	);
	if (typeof error === "object" && error !== null) {
		const metadata = error as {
			outcome?: unknown;
			retryAfterMs?: unknown;
			sessionId?: unknown;
			workspace?: unknown;
		};
		Object.assign(aggregate, {
			...(typeof metadata.outcome === "string" ? { outcome: metadata.outcome } : {}),
			...(typeof metadata.retryAfterMs === "number" ? { retryAfterMs: metadata.retryAfterMs } : {}),
			...(typeof metadata.sessionId === "string" ? { sessionId: metadata.sessionId } : {}),
			...(typeof metadata.workspace === "string" ? { workspace: metadata.workspace } : {}),
		});
	}
	throw aggregate;
}

async function createIrohRemoteSessionManager(
	options: IrohRemoteAgentRuntimeOptions,
	agentDir: string,
): Promise<{ sessionManager: SessionManager; selection: IrohRemoteAgentRuntimeSessionSelection }> {
	const resolved =
		options.resolvedSessionTarget ??
		(await resolveIrohRemoteSessionTarget(
			getSessionTarget(options),
			{ name: "", path: options.cwd },
			createSessionManagerTargetStore(
				options.cwd,
				options.sessionDir ?? getDefaultSessionDir(options.projectCwd ?? options.cwd, agentDir),
				{ listAll: true, preserveSessionCwd: true },
			),
		));
	return {
		sessionManager: resolved.sessionManager,
		selection: toSessionSelection(resolved),
	};
}

function toSessionSelection(
	resolved: ResolvedSessionTargetWithManager<SessionManager>,
): IrohRemoteAgentRuntimeSessionSelection {
	if (resolved.selection === "created") {
		return {
			kind: "created",
			...(resolved.sessionRef === undefined ? {} : { sessionRef: resolved.sessionRef }),
			sessionId: resolved.sessionId,
		};
	}
	return {
		kind: resolved.selection,
		requestedSessionId: resolved.requestedSessionId ?? resolved.sessionId,
		...(resolved.sessionRef === undefined ? {} : { sessionRef: resolved.sessionRef }),
		sessionId: resolved.sessionId,
	};
}

function getSessionTarget(options: IrohRemoteAgentRuntimeOptions): IrohRemoteSessionTarget {
	const target = getConversationTarget(options);
	if (target.target === "last") {
		return target.resumeSessionId === undefined
			? { kind: "last" }
			: { kind: "last", resumeSessionId: target.resumeSessionId };
	}
	if (target.target === "session") {
		return { kind: "session", sessionId: target.sessionId };
	}
	return target.sessionId === undefined ? { kind: "last" } : { kind: "new", sessionId: target.sessionId };
}

function getConversationTarget(options: IrohRemoteAgentRuntimeOptions): IrohRemoteAgentRuntimeConversationTarget {
	if (options.conversationTarget !== undefined) {
		return options.conversationTarget;
	}
	if (options.resumeSessionId !== undefined) {
		return { target: "last", resumeSessionId: options.resumeSessionId };
	}
	return { target: "new" };
}

function runIrohRemoteStartupMigrations(cwd: string, agentDir: string): void {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousLog = console.log;
	try {
		process.env[ENV_AGENT_DIR] = agentDir;
		console.log = (...data: Parameters<typeof console.log>) => console.error(...data);
		runMigrations(cwd);
	} finally {
		console.log = previousLog;
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	}
}
