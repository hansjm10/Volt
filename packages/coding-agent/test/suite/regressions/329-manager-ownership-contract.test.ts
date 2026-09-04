import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../../src/config.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { GitContextProvider } from "../../../src/core/git-context-provider.ts";
import { createEmptyMcpMergedConfig, finalizeMcpConfig } from "../../../src/core/mcp/config.ts";
import { McpManager } from "../../../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../../../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../../../src/core/mcp/output-store.ts";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import { main } from "../../../src/main.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const ENVIRONMENT_KEYS = [
	"HOME",
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	"VOLT_EXPERIMENTAL",
	"VOLT_OFFLINE",
	"VOLT_PROFILE",
	"VOLT_SKIP_VERSION_CHECK",
	"VOLT_STARTUP_BENCHMARK",
] as const;

function restoreProperty(target: object, property: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, property, descriptor);
	} else {
		Reflect.deleteProperty(target, property);
	}
}

async function isPersistenceClosed(manager: SessionManager): Promise<boolean> {
	try {
		await manager.materialize();
		return false;
	} catch {
		return true;
	}
}

describe("PR #329 manager ownership contract", () => {
	let harness: Harness;
	let previousCwd: string;
	let previousExitCode: string | number | null | undefined;
	let previousEnvironment: Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;
	let stdinIsTTYDescriptor: PropertyDescriptor | undefined;
	let stdoutIsTTYDescriptor: PropertyDescriptor | undefined;

	beforeEach(async () => {
		previousCwd = process.cwd();
		previousExitCode = process.exitCode;
		previousEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof ENVIRONMENT_KEYS)[number],
			string | undefined
		>;
		stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		harness = await createHarness({ settings: { lsp: { enabled: false } } });
		process.env.HOME = harness.tempDir;
		delete process.env.VOLT_EXPERIMENTAL;
		delete process.env.VOLT_PROFILE;
		delete process.env.VOLT_STARTUP_BENCHMARK;
	});

	afterEach(async () => {
		restoreStdout();
		stopThemeWatcher();
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		for (const key of ENVIRONMENT_KEYS) {
			const value = previousEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		restoreProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
		vi.restoreAllMocks();
		await harness.cleanupAsync();
	});

	function prepareCli(mode: "interactive" | "print"): string[] {
		const workspace = join(harness.tempDir, `${mode}-workspace`);
		const agentDir = join(harness.tempDir, `${mode}-agent`);
		mkdirSync(workspace, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = harness.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify({
				providers: {
					[model.provider]: {
						api: harness.faux.api,
						apiKey: "faux-key",
						baseUrl: model.baseUrl,
						models: harness.faux.models,
					},
				},
			})}\n`,
		);
		process.chdir(workspace);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_SESSION_DIR] = join(harness.tempDir, `${mode}-sessions`);
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		return [
			...(mode === "print" ? ["--print"] : []),
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			"--provider",
			model.provider,
			"--model",
			model.id,
			"--api-key",
			"faux-key",
		];
	}

	it("disposes the transferred CLI runtime exactly once when interactive initialization rejects", async () => {
		const initializationError = new Error("injected interactive initialization failure");
		let cliRuntime: AgentSessionRuntime | undefined;
		let cliManager: SessionManager | undefined;
		let runtimeDisposeCalls = 0;
		let managerCloseCalls = 0;
		let managerClosed = false;
		const disposeRuntime = AgentSessionRuntime.prototype.dispose;
		const setBeforeSessionInvalidate = AgentSessionRuntime.prototype.setBeforeSessionInvalidate;
		const closePersistence = SessionManager.prototype.closePersistence;
		vi.spyOn(AgentSessionRuntime.prototype, "setBeforeSessionInvalidate").mockImplementation(function (
			this: AgentSessionRuntime,
			callback,
		): void {
			cliRuntime = this;
			cliManager = this.session.sessionManager;
			setBeforeSessionInvalidate.call(this, callback);
		});
		vi.spyOn(AgentSessionRuntime.prototype, "dispose").mockImplementation(function (
			this: AgentSessionRuntime,
		): Promise<void> {
			if (this === cliRuntime) runtimeDisposeCalls++;
			return disposeRuntime.call(this);
		});
		vi.spyOn(SessionManager.prototype, "closePersistence").mockImplementation(function (
			this: SessionManager,
		): Promise<void> {
			if (this === cliManager) managerCloseCalls++;
			return closePersistence.call(this);
		});
		vi.spyOn(InteractiveMode.prototype, "init").mockRejectedValue(initializationError);

		let thrown: unknown;
		try {
			await main(prepareCli("interactive"));
		} catch (error) {
			thrown = error;
		}

		try {
			expect(thrown).toBe(initializationError);
			expect(cliRuntime).toBeDefined();
			expect(cliManager).toBeDefined();
			expect.soft(runtimeDisposeCalls, "The transferred CLI runtime must be finalized exactly once").toBe(1);
			expect.soft(managerCloseCalls, "The runtime-owned session manager must be finalized exactly once").toBe(1);
			if (cliManager) {
				managerClosed = await isPersistenceClosed(cliManager);
				expect.soft(managerClosed, "The transferred CLI session manager must be closed").toBe(true);
				const sessionRef = cliManager.getSessionRef();
				expect(sessionRef).toBeDefined();
				if (sessionRef) {
					expect(await SessionManager.findForResume(sessionRef.sessionDirectory, sessionRef.sessionId)).toEqual(
						sessionRef,
					);
				}
			}
		} finally {
			if (cliRuntime && runtimeDisposeCalls === 0) {
				cliRuntime.setBeforeSessionInvalidate(undefined);
				cliRuntime.setRebindSession(undefined);
				await disposeRuntime.call(cliRuntime);
			} else if (cliManager && !managerClosed) {
				await closePersistence.call(cliManager);
			}
		}
	});

	it("disposes CLI-created Git services when setup fails before AgentSession ownership", async () => {
		const setupError = new Error("injected service-based session setup failure");
		let cliManager: SessionManager | undefined;
		let serviceGitContext: GitContextProvider | undefined;
		let serviceGitDisposeCalls = 0;
		let managerClosed = false;
		const harnessGitContext = harness.session.gitContextProvider;
		const createSessionManager = SessionManager.create.bind(SessionManager);
		const flush = SessionManager.prototype.flush;
		const refreshGitContext = GitContextProvider.prototype.refresh;
		const disposeGitContext = GitContextProvider.prototype.dispose;
		vi.spyOn(SessionManager, "create").mockImplementation(async (...args) => {
			const manager = await createSessionManager(...args);
			cliManager ??= manager;
			return manager;
		});
		vi.spyOn(GitContextProvider.prototype, "refresh").mockImplementation(function (
			this: GitContextProvider,
			signal?: AbortSignal,
		) {
			if (this !== harnessGitContext && cliManager) serviceGitContext ??= this;
			return refreshGitContext.call(this, signal);
		});
		vi.spyOn(GitContextProvider.prototype, "dispose").mockImplementation(function (this: GitContextProvider): void {
			if (this === serviceGitContext) serviceGitDisposeCalls++;
			disposeGitContext.call(this);
		});
		vi.spyOn(SessionManager.prototype, "flush").mockImplementation(function (this: SessionManager): Promise<void> {
			if (this === cliManager && serviceGitContext) return Promise.reject(setupError);
			return flush.call(this);
		});

		let thrown: unknown;
		try {
			await main(prepareCli("print"));
		} catch (error) {
			thrown = error;
		}

		try {
			expect(thrown).toBe(setupError);
			expect(cliManager).toBeDefined();
			expect(serviceGitContext).toBeDefined();
			expect(serviceGitContext).not.toBe(harnessGitContext);
			expect
				.soft(serviceGitDisposeCalls, "The untransferred CLI Git provider must be finalized exactly once")
				.toBe(1);
			if (cliManager) {
				managerClosed = await isPersistenceClosed(cliManager);
				expect.soft(managerClosed, "The CLI session manager must be closed after setup failure").toBe(true);
				const sessionRef = cliManager.getSessionRef();
				expect(sessionRef).toBeDefined();
				if (sessionRef) {
					expect(await SessionManager.findForResume(sessionRef.sessionDirectory, sessionRef.sessionId)).toEqual(
						sessionRef,
					);
				}
			}
		} finally {
			if (serviceGitContext && serviceGitDisposeCalls === 0) {
				disposeGitContext.call(serviceGitContext);
			}
			if (cliManager && !managerClosed) await cliManager.closePersistence();
		}
	});

	it("disposes an SDK-owned MCP manager when persistence fails before AgentSession construction", async () => {
		const cwd = join(harness.tempDir, "sdk-mcp-workspace");
		const agentDir = join(harness.tempDir, "sdk-mcp-agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			`${JSON.stringify({ servers: { inert: { command: "unused", lifecycle: "lazy" } } })}\n`,
		);
		const setupError = new Error("injected post-MCP persistence failure");
		const sessionManager = await SessionManager.create(cwd, join(harness.tempDir, "sdk-mcp-sessions"));
		const sessionRef = sessionManager.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted SDK session reference");
		let sdkMcpManager: McpManager | undefined;
		let sdkMcpDisposeCalls = 0;
		let persistenceFailureInjected = false;
		let managerClosed = false;
		const startEagerServers = McpManager.prototype.startEagerServers;
		const disposeMcp = McpManager.prototype.dispose;
		vi.spyOn(McpManager.prototype, "startEagerServers").mockImplementation(function (
			this: McpManager,
			signal?: AbortSignal,
			options: { trustedReadsOnly?: boolean } = {},
		): Promise<void> {
			sdkMcpManager = this;
			return startEagerServers.call(this, signal, options);
		});
		vi.spyOn(McpManager.prototype, "dispose").mockImplementation(function (this: McpManager): Promise<void> {
			if (this === sdkMcpManager) sdkMcpDisposeCalls++;
			return disposeMcp.call(this);
		});
		const flush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			if (sdkMcpManager) {
				persistenceFailureInjected = true;
				throw setupError;
			}
			await flush();
		});

		let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let thrown: unknown;
		try {
			created = await createAgentSession({
				cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				model: harness.getModel(),
				settingsManager: SettingsManager.inMemory({ lsp: { enabled: false } }),
				resourceLoader: createTestResourceLoader(),
				sessionManager,
				noTools: "all",
				projectTrusted: false,
			});
		} catch (error) {
			thrown = error;
		}

		try {
			expect(sdkMcpManager).toBeDefined();
			if (persistenceFailureInjected) {
				expect(thrown).toBe(setupError);
				expect.soft(sdkMcpDisposeCalls, "The SDK-owned MCP manager must be finalized exactly once").toBe(1);
				managerClosed = await isPersistenceClosed(sessionManager);
				expect
					.soft(managerClosed, "The consumed SDK session manager must be closed after setup failure")
					.toBe(true);
				expect(await SessionManager.findForResume(sessionRef.sessionDirectory, sessionRef.sessionId)).toEqual(
					sessionRef,
				);
			} else {
				expect(thrown).toBeUndefined();
				expect(created).toBeDefined();
			}
		} finally {
			if (created) {
				created.session.dispose();
				await created.session.waitForClosed();
				managerClosed = true;
			} else if (sdkMcpManager && sdkMcpDisposeCalls === 0) {
				await disposeMcp.call(sdkMcpManager);
			}
			if (!managerClosed) await sessionManager.closePersistence();
		}
	});

	it("finalizes acquired Git and MCP listeners when partial AgentSession construction fails", async () => {
		const cwd = join(harness.tempDir, "partial-session-workspace");
		mkdirSync(cwd, { recursive: true });
		const agentDir = join(harness.tempDir, "partial-session-agent");
		mkdirSync(agentDir, { recursive: true });
		const constructionError = new Error("injected late AgentSession construction failure");
		const resourceLoader = createTestResourceLoader();
		vi.spyOn(resourceLoader, "getSystemPrompt").mockImplementation(() => {
			throw constructionError;
		});
		const acquiredListenerFinalizers: Array<{ label: string; calls: number }> = [];
		const acquireListener = (label: string): (() => void) => {
			const finalizer = { label, calls: 0 };
			acquiredListenerFinalizers.push(finalizer);
			return () => {
				finalizer.calls++;
			};
		};
		const gitContextProvider = new GitContextProvider(cwd);
		vi.spyOn(gitContextProvider, "subscribeObservations").mockImplementation(() =>
			acquireListener("Git observation listener"),
		);
		vi.spyOn(gitContextProvider, "subscribe").mockImplementation(() => acquireListener("Git event listener"));
		vi.spyOn(gitContextProvider, "refresh").mockResolvedValue({ status: "definitive", gitContext: null });
		const mcpManager = new McpManager({
			config: finalizeMcpConfig(createEmptyMcpMergedConfig()),
			clientFactory: {
				connect: async () => {
					throw new Error("Inert MCP manager must not connect");
				},
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 1024, maxOutputLines: 10 }),
		});
		vi.spyOn(mcpManager, "subscribe").mockImplementation(() => acquireListener("MCP event listener"));

		let thrown: unknown;
		try {
			await createAgentSession({
				cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				model: harness.getModel(),
				settingsManager: SettingsManager.inMemory({ lsp: { enabled: false } }),
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
				gitContextProvider,
				mcpManager,
				noTools: "all",
			});
		} catch (error) {
			thrown = error;
		}

		try {
			expect(thrown).toBe(constructionError);
			for (const finalizer of acquiredListenerFinalizers) {
				expect.soft(finalizer.calls, `${finalizer.label} must be finalized exactly once`).toBe(1);
			}
		} finally {
			gitContextProvider.dispose();
			await mcpManager.dispose();
		}
	});
});
