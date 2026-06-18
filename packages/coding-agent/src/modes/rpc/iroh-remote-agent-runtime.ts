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
	sessionDir?: string;
}

export async function createIrohRemoteAgentRuntime(
	options: IrohRemoteAgentRuntimeOptions,
): Promise<AgentSessionRuntime> {
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

	const sessionManager = SessionManager.create(
		options.cwd,
		options.sessionDir ?? getDefaultSessionDir(options.cwd, agentDir),
	);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir,
		sessionManager,
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
	return runtime;
}

function parseAllowTools(allowTools: string | undefined): string[] | undefined {
	const tools = allowTools
		?.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	return tools && tools.length > 0 ? tools : undefined;
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
