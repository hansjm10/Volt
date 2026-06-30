import { existsSync } from "node:fs";
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
	IrohRemoteOutcomeError,
	isIrohRemoteSessionId,
	parseIrohRemoteAllowTools,
	usesDefaultIrohRemoteAllowTools,
} from "../../core/remote/iroh/index.ts";
import { getDefaultSessionDir, SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { SubagentManager } from "../../core/subagents/index.ts";
import { runMigrations } from "../../migrations.ts";
import { resolvePath } from "../../utils/paths.ts";

export interface IrohRemoteAgentRuntimeOptions {
	allowTools?: string;
	agentDir?: string;
	conversationTarget?: IrohRemoteAgentRuntimeConversationTarget;
	cwd: string;
	profile?: string;
	projectTrusted?: boolean;
	resumeSessionId?: string;
	sessionDir?: string;
}

export type IrohRemoteAgentRuntimeConversationTarget =
	| {
			target: "last";
			resumeSessionId?: string;
	  }
	| {
			target: "new";
	  }
	| {
			target: "session";
			sessionId: string;
	  };

export type IrohRemoteAgentRuntimeSessionSelection =
	| {
			kind: "created";
			sessionFile?: string;
			sessionId: string;
	  }
	| {
			kind: "created_after_missing";
			requestedSessionId: string;
			sessionFile?: string;
			sessionId: string;
	  }
	| {
			kind: "resumed";
			requestedSessionId: string;
			sessionFile?: string;
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
	runIrohRemoteStartupMigrations(options.cwd, agentDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const tools = parseIrohRemoteAllowTools(options.allowTools);
	const allowUnlistedExtensionTools = usesDefaultIrohRemoteAllowTools(options.allowTools);
	const projectTrusted = options.projectTrusted ?? false;

	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const profile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : options.profile;
		const settingsManager = SettingsManager.create(runtimeOptions.cwd, runtimeOptions.agentDir, {
			profile,
			projectTrusted,
		});
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
		const services = await createAgentSessionServices({
			authStorage,
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			settingsManager,
		});
		const subagentManager = new SubagentManager({
			createRuntime,
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			resourceLoader: services.resourceLoader,
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
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir,
		sessionManager: sessionTarget.sessionManager,
		profile: options.profile,
	});
	const errors = runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) {
		await runtime.dispose();
		throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
	}
	if (!runtime.session.model) {
		await runtime.dispose();
		throw new Error(formatNoModelsAvailableMessage());
	}
	return { runtime, sessionSelection: sessionTarget.selection };
}

async function createIrohRemoteSessionManager(
	options: IrohRemoteAgentRuntimeOptions,
	agentDir: string,
): Promise<{ sessionManager: SessionManager; selection: IrohRemoteAgentRuntimeSessionSelection }> {
	const sessionDir = options.sessionDir ?? getDefaultSessionDir(options.cwd, agentDir);
	const target = getConversationTarget(options);
	if (target.target === "new") {
		const sessionManager = SessionManager.create(options.cwd, sessionDir);
		return {
			sessionManager,
			selection: {
				kind: "created",
				sessionFile: sessionManager.getSessionFile(),
				sessionId: sessionManager.getSessionId(),
			},
		};
	}

	const resumeSessionId = target.target === "last" ? target.resumeSessionId : target.sessionId;
	if (!resumeSessionId) {
		const sessionManager = SessionManager.create(options.cwd, sessionDir);
		return {
			sessionManager,
			selection: {
				kind: "created",
				sessionFile: sessionManager.getSessionFile(),
				sessionId: sessionManager.getSessionId(),
			},
		};
	}

	if (!isIrohRemoteSessionId(resumeSessionId)) {
		if (target.target === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		const sessionManager = SessionManager.create(options.cwd, sessionDir);
		return {
			sessionManager,
			selection: {
				kind: "created_after_missing",
				requestedSessionId: resumeSessionId,
				sessionFile: sessionManager.getSessionFile(),
				sessionId: sessionManager.getSessionId(),
			},
		};
	}

	const existingSession = await findExistingIrohRemoteSession(options.cwd, sessionDir, resumeSessionId);
	if (!existingSession) {
		if (target.target === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		const sessionManager = SessionManager.create(options.cwd, sessionDir);
		return {
			sessionManager,
			selection: {
				kind: "created_after_missing",
				requestedSessionId: resumeSessionId,
				sessionFile: sessionManager.getSessionFile(),
				sessionId: sessionManager.getSessionId(),
			},
		};
	}

	const sessionManager = SessionManager.open(existingSession.path, sessionDir, options.cwd);
	return {
		sessionManager,
		selection: {
			kind: "resumed",
			requestedSessionId: resumeSessionId,
			sessionFile: sessionManager.getSessionFile(),
			sessionId: sessionManager.getSessionId(),
		},
	};
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

async function findExistingIrohRemoteSession(cwd: string, sessionDir: string, sessionId: string) {
	return (await SessionManager.list(cwd, sessionDir)).find(
		(session) => session.id === sessionId && existsSync(session.path),
	);
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
