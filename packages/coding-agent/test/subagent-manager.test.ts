import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxModelDefinition,
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ResourceDiagnostic, ResourceLoader } from "../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	type SubagentDefinition,
	SubagentDefinitionConfigurationError,
	SubagentDefinitionNotFoundError,
	SubagentManager,
} from "../src/core/subagents/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface TestManagerContext {
	manager: SubagentManager;
	getDisposedSessionCount(): number;
}

interface CreateTestManagerOptions {
	responseText?: string;
	responses?: FauxResponseStep[];
	models?: FauxModelDefinition[];
	initialModelId?: string;
	noTools?: "all" | false;
	resourceLoader?: ResourceLoader;
	allowedTools?: string[];
}

function createDefinition(
	overrides: Partial<SubagentDefinition> & Pick<SubagentDefinition, "name">,
): SubagentDefinition {
	const filePath = join(tmpdir(), `${overrides.name}.md`);
	return {
		name: overrides.name,
		description: overrides.description ?? `${overrides.name} description`,
		systemPrompt: overrides.systemPrompt ?? `${overrides.name} instructions`,
		source: overrides.source ?? "user",
		sourceInfo: overrides.sourceInfo ?? createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		filePath,
		...(overrides.tools ? { tools: overrides.tools } : {}),
		...(overrides.model ? { model: overrides.model } : {}),
		...(overrides.thinking ? { thinking: overrides.thinking } : {}),
	};
}

function createSubagentResourceLoader(
	definitions: SubagentDefinition[],
	diagnostics: ResourceDiagnostic[] = [],
): ResourceLoader {
	return {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions, diagnostics }),
	};
}

describe("SubagentManager", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createTestManager(options: CreateTestManagerOptions = {}): Promise<TestManagerContext> {
		const tempDir = join(tmpdir(), `subagent-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ models: options.models });
		if (options.models) {
			writeFileSync(
				join(tempDir, "models.json"),
				JSON.stringify({
					providers: {
						[faux.getModel().provider]: {
							api: faux.api,
							baseUrl: "http://localhost:0",
							apiKey: "faux-key",
							models: options.models,
						},
					},
				}),
				"utf-8",
			);
		}
		faux.setResponses(options.responses ?? [fauxAssistantMessage(options.responseText ?? "child complete")]);
		const initialModel = options.initialModelId ? faux.getModel(options.initialModelId) : faux.getModel();
		if (!initialModel) {
			throw new Error(`Missing faux model ${options.initialModelId}`);
		}

		const authStorage = AuthStorage.inMemory();
		for (const model of faux.models) {
			authStorage.setRuntimeApiKey(model.provider, "faux-key");
		}
		let disposedSessionCount = 0;

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: initialModel,
				...(options.noTools === false ? {} : { noTools: options.noTools ?? "all" }),
			});
			const originalDispose = result.session.dispose.bind(result.session);
			result.session.dispose = () => {
				disposedSessionCount += 1;
				originalDispose();
			};
			return {
				...result,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const manager = new SubagentManager({
			createRuntime,
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: options.resourceLoader,
			allowedTools: options.allowedTools,
			requestTimeoutMs: 5_000,
		});

		cleanups.push(async () => {
			await manager.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return {
			manager,
			getDisposedSessionCount: () => disposedSessionCount,
		};
	}

	it("creates an isolated child and exposes its session id", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();

		expect(handle.id).toMatch(/^sa_/);
		expect(handle.sessionId).toBeTruthy();
		await expect(handle.getState()).resolves.toMatchObject({ sessionId: handle.sessionId });
	});

	it("prompts the child and waits for terminal agent_end", async () => {
		const { manager } = await createTestManager({ responseText: "child result text" });
		const handle = await manager.start();

		const completion = handle.waitForEnd();
		await handle.prompt("run child task");
		const result = await completion;

		expect(result.id).toBe(handle.id);
		expect(result.sessionId).toBe(handle.sessionId);
		expect(result.event.type).toBe("agent_end");
		expect(result.event.willRetry).toBe(false);

		const transcript = await handle.getTranscript();
		expect(transcript.sessionId).toBe(handle.sessionId);
		expect(
			transcript.items.some((item) => item.role === "assistant" && item.text.includes("child result text")),
		).toBe(true);
	});

	it("starts by definition name and applies the definition body as child prompt context", async () => {
		let observedSystemPrompt: string | undefined;
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "scout", systemPrompt: "Always answer as the scout subagent.", tools: ["read"] }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			noTools: false,
			responses: [
				(context) => {
					observedSystemPrompt = context.systemPrompt;
					return fauxAssistantMessage(
						context.systemPrompt?.includes("scout subagent") ? "scout prompt observed" : "prompt missing",
					);
				},
			],
		});

		const handle = await manager.startByName("scout");
		const completion = handle.waitForEnd();
		await handle.prompt("use definition body");
		await completion;

		expect(observedSystemPrompt).toContain("Always answer as the scout subagent.");
		const transcript = await handle.getTranscript();
		expect(transcript.items.some((item) => item.role === "assistant" && item.text === "scout prompt observed")).toBe(
			true,
		);
	});

	it("intersects definition tools with the inherited allowed tool policy", async () => {
		let observedToolNames: string[] = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "worker", tools: ["read", "bash", "write"] }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			allowedTools: ["read", "grep"],
			noTools: false,
			responses: [
				(context) => {
					observedToolNames = context.tools?.map((tool) => tool.name).sort() ?? [];
					return fauxAssistantMessage("tools captured");
				},
			],
		});

		const handle = await manager.startByName("worker");
		const completion = handle.waitForEnd();
		await handle.prompt("list tools");
		await completion;

		expect(observedToolNames).toEqual(["read"]);
	});

	it("applies definition model and thinking before the child starts", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "planner", model: "specialist-model", thinking: "high" }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			models: [
				{ id: "base-model", name: "Base", reasoning: false },
				{ id: "specialist-model", name: "Specialist", reasoning: true },
			],
			initialModelId: "base-model",
		});

		const handle = await manager.startByName("planner");
		const state = await handle.getState();

		expect(state.model).toMatchObject({ id: "specialist-model" });
		expect(state.thinkingLevel).toBe("high");
	});

	it("throws clear definition errors when no definitions are present", async () => {
		const resourceLoader = createSubagentResourceLoader([]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("scout")).rejects.toBeInstanceOf(SubagentDefinitionNotFoundError);
		await expect(manager.startByName("scout")).rejects.toMatchObject({ availableNames: [] });
		expect(getDisposedSessionCount()).toBe(0);
	});

	it("throws clear definition errors for missing names and invalid thinking", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "bad-thinking", thinking: "turbo" }),
		]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("missing")).rejects.toBeInstanceOf(SubagentDefinitionNotFoundError);
		await expect(manager.startByName("missing")).rejects.toMatchObject({
			availableNames: ["bad-thinking"],
		});
		await expect(manager.startByName("bad-thinking")).rejects.toBeInstanceOf(SubagentDefinitionConfigurationError);
		expect(getDisposedSessionCount()).toBe(1);
	});

	it("disposes the child runtime when a definition model is unavailable", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "bad-model", model: "missing-model" }),
		]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("bad-model")).rejects.toMatchObject({
			name: "SubagentDefinitionConfigurationError",
			field: "model",
		});
		expect(getDisposedSessionCount()).toBe(1);
	});

	it("emits observable child RPC events", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();
		const eventTypes: string[] = [];
		handle.onEvent((event) => {
			eventTypes.push(event.type);
		});

		const completion = handle.waitForEnd();
		await handle.prompt("observe child task");
		await completion;

		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("agent_end");
	});

	it("allows abort calls through the handle", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();

		await expect(handle.abort()).resolves.toBeUndefined();
	});

	it("disposes the child runtime through the RPC client", async () => {
		const { manager, getDisposedSessionCount } = await createTestManager();
		const handle = await manager.start();

		await handle.dispose();

		expect(getDisposedSessionCount()).toBe(1);
		await expect(handle.getState()).rejects.toThrow(`Subagent ${handle.id} is disposed`);
		await expect(handle.waitForEnd()).rejects.toThrow(`Subagent ${handle.id} was disposed before completion`);
	});
});
