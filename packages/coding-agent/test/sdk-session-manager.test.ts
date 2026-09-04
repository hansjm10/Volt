import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, getModel, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { GitContextProvider } from "../src/core/git-context-provider.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { createEmptyMcpMergedConfig, finalizeMcpConfig } from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";
import { createTestResourceLoader } from "./utilities.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function toDisplayPath(path: string): string {
	return path.replace(/\\/g, "/");
}

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];
	const fauxProviders: FauxProviderRegistration[] = [];
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `volt-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		while (sessions.length > 0) {
			const session = sessions.pop()!;
			session.dispose();
			await session.waitForClosed();
		}
		await managerOwner.drain();
		vi.restoreAllMocks();
		while (fauxProviders.length > 0) fauxProviders.pop()?.unregister();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionRef = session.sessionManager.getSessionRef();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionRef?.sessionDirectory).toBe(expectedSessionDir);
		expect(sessionRef?.sessionId).toBe(session.sessionManager.getSessionId());
		expect(existsSync(join(expectedSessionDir, "sessions.sqlite"))).toBe(true);

		session.dispose();
		await session.waitForClosed();
	});

	it("closes the default persisted manager and retains its row when setup fails", async () => {
		const setupError = new Error("injected resource reload failure");
		let closedManager: SessionManager | undefined;
		const closePersistence = SessionManager.prototype.closePersistence;
		vi.spyOn(SessionManager.prototype, "closePersistence").mockImplementation(function (
			this: SessionManager,
		): Promise<void> {
			closedManager = this;
			return closePersistence.call(this);
		});
		vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(setupError);

		await expect(createAgentSession({ cwd, agentDir, disableMcp: true })).rejects.toBe(setupError);

		expect(closedManager).toBeDefined();
		const manager = closedManager;
		if (!manager) throw new Error("Expected the default session manager to be closed");
		const sessionRef = manager.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted session reference");
		expect(() => manager.appendSessionInfo("late write")).toThrow("Session persistence is closed");
		const reopened = await SessionManager.open(sessionRef);
		await reopened.closePersistence();
		expect(await SessionManager.list(cwd, sessionRef.sessionDirectory)).toEqual([]);
		expect(
			await SessionManager.list(cwd, sessionRef.sessionDirectory, undefined, {
				includeMessageFreeDurable: true,
			}),
		).toEqual([expect.objectContaining({ ref: sessionRef })]);
	});

	it("consumes and closes an explicit persisted manager when setup fails", async () => {
		const setupError = new Error("injected resource reload failure");
		const sessionManager = await SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
		const sessionRef = sessionManager.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted session reference");
		vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(setupError);

		await expect(createAgentSession({ cwd, agentDir, sessionManager, disableMcp: true })).rejects.toBe(setupError);

		expect(() => sessionManager.appendSessionInfo("late write")).toThrow("Session persistence is closed");
		const reopened = await SessionManager.open(sessionRef);
		reopened.appendSessionInfo("reopened after failed setup");
		await reopened.flush();
		await reopened.closePersistence();
		expect(
			await SessionManager.list(cwd, sessionRef.sessionDirectory, undefined, {
				includeMessageFreeDurable: true,
			}),
		).toEqual([expect.objectContaining({ ref: sessionRef, name: "reopened after failed setup" })]);
	});

	it("does not create later construction resources when extension setup fails", async () => {
		const setupError = new Error("injected extension result failure");
		const resourceLoader = createTestResourceLoader();
		vi.spyOn(resourceLoader, "getExtensions").mockImplementation(() => {
			throw setupError;
		});
		const disposeGitContext = vi.spyOn(GitContextProvider.prototype, "dispose");

		await expect(
			createAgentSession({ cwd, agentDir, resourceLoader, disableMcp: true, noTools: "all" }),
		).rejects.toBe(setupError);

		expect(disposeGitContext).not.toHaveBeenCalled();
	});

	it("preserves every acquired-resource cleanup failure from partial construction", async () => {
		const constructionError = new Error("injected late construction failure");
		const lspCleanupError = new Error("injected LSP cleanup failure");
		const gitEventCleanupError = new Error("injected Git event cleanup failure");
		const gitObservationCleanupError = new Error("injected Git observation cleanup failure");
		const mcpListenerCleanupError = new Error("injected MCP listener cleanup failure");
		const resourceLoader = createTestResourceLoader();
		vi.spyOn(resourceLoader, "getSystemPrompt").mockImplementation(() => {
			throw constructionError;
		});

		const listenerCleanupCalls = {
			gitEvent: 0,
			gitObservation: 0,
			mcp: 0,
		};
		const gitContextProvider = new GitContextProvider(cwd);
		vi.spyOn(gitContextProvider, "refresh").mockResolvedValue({ status: "definitive", gitContext: null });
		vi.spyOn(gitContextProvider, "subscribeObservations").mockReturnValue(() => {
			listenerCleanupCalls.gitObservation++;
			throw gitObservationCleanupError;
		});
		vi.spyOn(gitContextProvider, "subscribe").mockReturnValue(() => {
			listenerCleanupCalls.gitEvent++;
			throw gitEventCleanupError;
		});
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
		vi.spyOn(mcpManager, "subscribe").mockReturnValue(() => {
			listenerCleanupCalls.mcp++;
			throw mcpListenerCleanupError;
		});
		let mcpManagerDisposeCalls = 0;
		const disposeMcpManager = mcpManager.dispose.bind(mcpManager);
		vi.spyOn(mcpManager, "dispose").mockImplementation(async () => {
			mcpManagerDisposeCalls++;
			await disposeMcpManager();
		});
		let gitContextProviderDisposeCalls = 0;
		const disposeGitContextProvider = gitContextProvider.dispose.bind(gitContextProvider);
		vi.spyOn(gitContextProvider, "dispose").mockImplementation(() => {
			gitContextProviderDisposeCalls++;
			disposeGitContextProvider();
		});
		let lspDisposeCalls = 0;
		const disposeLspManager = LspManager.prototype.dispose;
		vi.spyOn(LspManager.prototype, "dispose").mockImplementation(function (this: LspManager): void {
			lspDisposeCalls++;
			disposeLspManager.call(this);
			throw lspCleanupError;
		});

		let thrown: unknown;
		try {
			await createAgentSession({
				cwd,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: SettingsManager.inMemory({ lsp: { enabled: true } }),
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
			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("Expected construction cleanup aggregation");
			expect(thrown.errors[0]).toBe(constructionError);
			expect(thrown.errors.slice(1)).toHaveLength(4);
			for (const cleanupError of [
				lspCleanupError,
				gitEventCleanupError,
				gitObservationCleanupError,
				mcpListenerCleanupError,
			]) {
				expect(thrown.errors.slice(1)).toContain(cleanupError);
			}
			expect(listenerCleanupCalls).toEqual({ gitEvent: 1, gitObservation: 1, mcp: 1 });
			expect(lspDisposeCalls).toBe(1);
			expect(gitContextProviderDisposeCalls).toBe(0);
			expect(mcpManagerDisposeCalls).toBe(0);
		} finally {
			disposeGitContextProvider();
			await disposeMcpManager();
		}
	});

	it("preserves setup and cleanup errors when default manager close fails", async () => {
		const setupError = new Error("injected resource reload failure");
		const cleanupError = new Error("injected close failure");
		vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValue(setupError);
		vi.spyOn(SessionManager.prototype, "closePersistence").mockRejectedValue(cleanupError);

		let thrown: unknown;
		try {
			await createAgentSession({ cwd, agentDir, disableMcp: true });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).message).toBe("Agent session setup failed and its manager could not be closed");
		expect((thrown as AggregateError).errors).toEqual([setupError, cleanupError]);
	});

	it("uses agentDir and session identity for generated image artifacts", async () => {
		const token = codexToken();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai-codex", token);
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider("openai-codex", {
			baseUrl: "https://chatgpt.com/backend-api",
			apiKey: token,
			api: "openai-codex-responses",
			models: [
				{
					id: "gpt-codex-image-output",
					name: "GPT Codex Image Output",
					api: "openai-codex-responses",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
					baseUrl: "https://chatgpt.com/backend-api",
				},
			],
		});
		const model = modelRegistry.find("openai-codex", "gpt-codex-image-output");
		expect(model).toBeDefined();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			disableMcp: true,
		});
		sessions.push(session);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		const imageGen = session.state.tools.find((tool) => tool.name === "image_gen");
		expect(imageGen).toBeDefined();
		const result = await imageGen!.execute("sdk/output", { prompt: "A fox" });
		const expectedPath = join(agentDir, "generated_images", sessionManager.getSessionId(), "sdk_output.png");

		expect(result.details).toMatchObject({ outputPath: expectedPath });
		expect(readFileSync(expectedPath)).toEqual(Buffer.from(PNG_BASE64, "base64"));
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
		await session.waitForClosed();
	});

	it("persists a model policy when Fast mode is pre-seeded for a new session", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "default-model", reasoning: true },
				{ id: "later-default", reasoning: true },
			],
		});
		fauxProviders.push(faux);
		const model = faux.getModel("default-model")!;
		const laterDefault = faux.getModel("later-default")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const sessionManager = await SessionManager.create(cwd, agentDir);
		sessionManager.appendFastModeChange(true);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: model.provider,
				defaultModel: model.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(session);

		expect(session.model?.id).toBe(model.id);
		expect(session.fastModeEnabled).toBe(true);
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: model.provider,
			modelId: model.id,
		});

		const sessionRef = sessionManager.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted session reference");
		const resumed = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: laterDefault.provider,
				defaultModel: laterDefault.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager: await SessionManager.open(sessionRef, agentDir),
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(resumed.session);

		expect(resumed.session.model?.id).toBe(model.id);
		expect(resumed.session.fastModeEnabled).toBe(true);
	});

	it("uses scoped-model bootstrap when Fast mode is pre-seeded for a new session", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "default-model", reasoning: true },
				{ id: "scoped-model", reasoning: true },
			],
		});
		fauxProviders.push(faux);
		const defaultModel = faux.getModel("default-model")!;
		const scopedModel = faux.getModel("scoped-model")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(defaultModel.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(defaultModel.provider, {
			baseUrl: defaultModel.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendFastModeChange(true);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: defaultModel.provider,
				defaultModel: defaultModel.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
			scopedModels: [{ model: scopedModel }],
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(session);

		expect(session.model?.id).toBe(scopedModel.id);
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: scopedModel.provider,
			modelId: scopedModel.id,
		});
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${toDisplayPath(sessionCwd)}`);

		const bashTool = session.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: process.platform === "win32" ? "pwd -W" : "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
		await session.waitForClosed();
	});
});
