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
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../../core/remote/iroh/index.ts";
import { getDefaultSessionDir, SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { runMigrations } from "../../migrations.ts";
import { resolvePath } from "../../utils/paths.ts";

export interface IrohRemoteAgentRuntimeOptions {
	allowTools?: string;
	agentDir?: string;
	cwd: string;
	profile?: string;
	projectTrusted?: boolean;
	resumeSessionId?: string;
	sessionDir?: string;
}

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
	const tools = parseAllowTools(options.allowTools);
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
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			tools,
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
	if (!options.resumeSessionId) {
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

	const existingSession = (await SessionManager.list(options.cwd, sessionDir)).find(
		(session) => session.id === options.resumeSessionId && existsSync(session.path),
	);
	if (!existingSession) {
		const sessionManager = SessionManager.create(options.cwd, sessionDir);
		return {
			sessionManager,
			selection: {
				kind: "created_after_missing",
				requestedSessionId: options.resumeSessionId,
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
			requestedSessionId: options.resumeSessionId,
			sessionFile: sessionManager.getSessionFile(),
			sessionId: sessionManager.getSessionId(),
		},
	};
}

function parseAllowTools(allowTools: string | undefined): string[] {
	const requestedAllowTools = allowTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS;
	const tools = requestedAllowTools
		?.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	return tools && tools.length > 0 ? tools : DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",");
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
