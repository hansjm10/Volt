import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/volt-agent-core";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStats } from "../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../src/core/rpc/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	type SubagentDefinition,
	SubagentDefinitionNotFoundError,
	type SubagentEvent,
	type SubagentHandle,
	SubagentManager,
	type SubagentResult,
} from "../src/core/subagents/index.ts";
import {
	createSubagentTool,
	DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES,
	DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS,
	type SubagentToolDetails,
	type SubagentToolManager,
} from "../src/core/tools/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface CleanupContext {
	cleanup(): Promise<void> | void;
}

function createDefinition(name: string, overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
	const filePath = join(tmpdir(), `${name}.md`);
	return {
		name,
		description: overrides.description ?? `${name} description`,
		systemPrompt: overrides.systemPrompt ?? `${name} instructions`,
		source: overrides.source ?? "user",
		sourceInfo: overrides.sourceInfo ?? createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		filePath,
		...(overrides.tools ? { tools: overrides.tools } : {}),
		...(overrides.model ? { model: overrides.model } : {}),
		...(overrides.thinking ? { thinking: overrides.thinking } : {}),
	};
}

function createSubagentResourceLoader(definitions: SubagentDefinition[]): ResourceLoader {
	return {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions, diagnostics: [] }),
	};
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function createStats(sessionId: string): SessionStats {
	return {
		sessionFile: undefined,
		sessionId,
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		cost: 0,
	};
}

function createSubagentResult(options: {
	id: string;
	sessionId: string;
	text: string;
	stopReason?: "error" | "aborted";
	errorMessage?: string;
}): SubagentResult {
	const message = fauxAssistantMessage(options.text, {
		...(options.stopReason ? { stopReason: options.stopReason } : {}),
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
	}) as AgentMessage;
	return {
		id: options.id,
		sessionId: options.sessionId,
		event: { type: "agent_end", messages: [message], willRetry: false },
	};
}

describe("subagent tool", () => {
	const cleanups: CleanupContext[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.cleanup();
		}
	});

	async function createSession(options: {
		tools?: string[];
		responses?: FauxResponseStep[];
		manager?: SubagentToolManager | false;
		noTools?: "all" | "builtin";
		excludeTools?: string[];
	}) {
		const tempDir = join(tmpdir(), `subagent-tool-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const manager =
			options.manager === false
				? undefined
				: (options.manager ??
					({
						getDefinition: () => createDefinition("scout"),
						startByName: async () => {
							throw new Error("not implemented");
						},
					} satisfies SubagentToolManager));
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
			tools: options.tools,
			noTools: options.noTools,
			excludeTools: options.excludeTools,
			...(manager ? { subagentToolManager: manager } : {}),
		});
		cleanups.push({
			cleanup: () => {
				created.session.dispose();
				faux.unregister();
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			},
		});
		return created.session;
	}

	async function createRealManager(options: { definitions: SubagentDefinition[]; responses: FauxResponseStep[] }) {
		const tempDir = join(tmpdir(), `subagent-tool-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses(options.responses);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const resourceLoader = createSubagentResourceLoader(options.definitions);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
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
				model: faux.getModel(),
				noTools: "all",
			});
			return { ...result, services, diagnostics: services.diagnostics };
		};

		const manager = new SubagentManager({
			createRuntime,
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader,
			requestTimeoutMs: 5_000,
		});
		cleanups.push({
			cleanup: async () => {
				await manager.dispose();
				faux.unregister();
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			},
		});
		return manager;
	}

	function createCompletedHandle(
		text: string,
		options: {
			id?: string;
			sessionId?: string;
			stopReason?: "error" | "aborted";
			errorMessage?: string;
			resultPromise?: Promise<SubagentResult>;
			onPrompt?: (task: string) => void;
			onAbort?: () => void;
			onDispose?: () => void;
		} = {},
	): SubagentHandle {
		const id = options.id ?? "sa_fake";
		const sessionId = options.sessionId ?? "session_fake";
		const result = createSubagentResult({
			id,
			sessionId,
			text,
			...(options.stopReason ? { stopReason: options.stopReason } : {}),
			...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		});
		return {
			id: result.id,
			sessionId: result.sessionId,
			prompt: async (task) => {
				options.onPrompt?.(task);
			},
			abort: async () => {
				options.onAbort?.();
			},
			getState: async (): Promise<RpcSessionState> => {
				throw new Error("not used");
			},
			getTranscript: async (): Promise<RpcTranscriptResponse> => {
				throw new Error("not used");
			},
			getSessionStats: async () => createStats(result.sessionId),
			waitForEnd: async () => options.resultPromise ?? result,
			dispose: async () => {
				options.onDispose?.();
			},
			onEvent: () => () => undefined,
		};
	}

	function createControlledHandle(options: {
		id: string;
		sessionId: string;
		agent: string;
		prompts: Array<{ agent: string; task: string }>;
	}): { handle: SubagentHandle; complete(result: SubagentResult): void; emit(event: SubagentEvent): void } {
		const listeners = new Set<(event: SubagentEvent) => void>();
		const completion = createDeferred<SubagentResult>();
		return {
			handle: {
				id: options.id,
				sessionId: options.sessionId,
				prompt: async (task) => {
					options.prompts.push({ agent: options.agent, task });
				},
				abort: async () => undefined,
				getState: async (): Promise<RpcSessionState> => {
					throw new Error("not used");
				},
				getTranscript: async (): Promise<RpcTranscriptResponse> => {
					throw new Error("not used");
				},
				getSessionStats: async () => createStats(options.sessionId),
				waitForEnd: async () => completion.promise,
				dispose: async () => undefined,
				onEvent: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			},
			complete: (result) => {
				completion.resolve(result);
			},
			emit: (event) => {
				for (const listener of listeners) {
					listener(event);
				}
			},
		};
	}

	it("activates the built-in subagent tool by default when a manager is available", async () => {
		const defaultSession = await createSession({});
		expect(defaultSession.getAllTools().map((tool) => tool.name)).toContain("subagent");
		expect(defaultSession.getActiveToolNames()).toContain("subagent");

		const withoutManagerSession = await createSession({ manager: false });
		expect(withoutManagerSession.getAllTools().map((tool) => tool.name)).not.toContain("subagent");
		expect(withoutManagerSession.getActiveToolNames()).not.toContain("subagent");
	});

	it("respects explicit subagent tool policy opt-outs and allowlists", async () => {
		const noToolsSession = await createSession({ noTools: "all" });
		expect(noToolsSession.getAllTools()).toEqual([]);
		expect(noToolsSession.getActiveToolNames()).toEqual([]);

		const noBuiltinSession = await createSession({ noTools: "builtin" });
		expect(noBuiltinSession.getActiveToolNames()).not.toContain("subagent");

		const excludedSession = await createSession({ excludeTools: ["subagent"] });
		expect(excludedSession.getAllTools().map((tool) => tool.name)).not.toContain("subagent");
		expect(excludedSession.getActiveToolNames()).not.toContain("subagent");

		const allowlistedSession = await createSession({ tools: ["subagent"] });
		expect(allowlistedSession.getAllTools().map((tool) => tool.name)).toEqual(["subagent"]);
		expect(allowlistedSession.getActiveToolNames()).toEqual(["subagent"]);

		const strictReadSession = await createSession({ tools: ["read"] });
		expect(strictReadSession.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
		expect(strictReadSession.getActiveToolNames()).toEqual(["read"]);
	});

	it("delegates a single task and returns the child final text", async () => {
		const manager = await createRealManager({
			definitions: [createDefinition("scout", { source: "project" })],
			responses: [fauxAssistantMessage("child final answer")],
		});
		const tool = createSubagentTool(process.cwd(), { manager, getAllowedTools: () => [] });

		const result = await tool.execute("call-1", { agent: "scout", task: "inspect auth" });

		expect(textFromResult(result)).toBe("child final answer");
		expect(result.details).toMatchObject({
			agent: { name: "scout", source: "project" },
			status: "completed",
		});
		expect(result.details.subagentId).toMatch(/^sa_/);
		expect(result.details.sessionId).toBeTruthy();
		expect(result.details.usage?.messages.assistant).toBe(1);
	});

	it("emits live progress updates for a single child and a final partial", async () => {
		const prompts: Array<{ agent: string; task: string }> = [];
		const controlled = createControlledHandle({
			id: "sa_scout",
			sessionId: "session_scout",
			agent: "scout",
			prompts,
		});
		const manager = {
			getDefinition: () => createDefinition("scout", { source: "project" }),
			startByName: vi.fn(async () => controlled.handle),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const updates: AgentToolResult<SubagentToolDetails>[] = [];

		const execution = tool.execute("call-1", { agent: "scout", task: "inspect auth" }, undefined, (update) =>
			updates.push(update),
		);
		await waitUntil(() => prompts.length === 1);
		controlled.emit({ type: "tool_execution_start", toolCallId: "child-read", toolName: "read", args: {} });
		controlled.complete(
			createSubagentResult({ id: "sa_scout", sessionId: "session_scout", text: "child final answer" }),
		);

		const result = await execution;
		const lastUpdate = updates.at(-1);

		expect(textFromResult(result)).toBe("child final answer");
		expect(updates[0]?.details).toMatchObject({
			mode: "single",
			status: "running",
			subagentId: "sa_scout",
			agent: { name: "scout", source: "project" },
		});
		expect(updates.some((update) => textFromResult(update).includes("tool read started"))).toBe(true);
		expect(lastUpdate).toBeDefined();
		if (!lastUpdate) {
			throw new Error("expected final subagent update");
		}
		expect(textFromResult(lastUpdate)).toBe("child final answer");
		expect(lastUpdate.details).toMatchObject({
			mode: "single",
			status: "completed",
			output: { text: "child final answer" },
		});
	});

	it("emits stable ordered live progress updates for parallel children", async () => {
		const prompts: Array<{ agent: string; task: string }> = [];
		const controls = new Map([
			["first", createControlledHandle({ id: "sa_first", sessionId: "session_first", agent: "first", prompts })],
			["second", createControlledHandle({ id: "sa_second", sessionId: "session_second", agent: "second", prompts })],
		]);
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				const controlled = controls.get(agentName);
				if (!controlled) {
					throw new Error(`unexpected agent ${agentName}`);
				}
				return controlled.handle;
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const updates: AgentToolResult<SubagentToolDetails>[] = [];

		const execution = tool.execute(
			"call-1",
			{
				tasks: [
					{ agent: "first", task: "one" },
					{ agent: "second", task: "two" },
				],
			},
			undefined,
			(update) => updates.push(update),
		);
		await waitUntil(() => prompts.length === 2);

		const runningUpdate = updates.find(
			(update) => update.details.mode === "parallel" && update.details.summary?.running === 2,
		);
		expect(runningUpdate?.details.tasks?.map((task) => task.agent.name)).toEqual(["first", "second"]);
		controls
			.get("second")
			?.complete(createSubagentResult({ id: "sa_second", sessionId: "session_second", text: "second done" }));
		await waitUntil(() =>
			updates.some(
				(update) => update.details.mode === "parallel" && update.details.tasks?.[1]?.status === "completed",
			),
		);

		const afterSecond = updates.find(
			(update) => update.details.mode === "parallel" && update.details.tasks?.[1]?.status === "completed",
		);
		expect(afterSecond?.details.tasks?.map((task) => task.status)).toEqual(["running", "completed"]);
		controls
			.get("first")
			?.complete(createSubagentResult({ id: "sa_first", sessionId: "session_first", text: "first done" }));

		const result = await execution;
		const lastUpdate = updates.at(-1);

		expect(textFromResult(result)).toContain("Parallel subagents: 2/2 completed");
		expect(lastUpdate).toBeDefined();
		if (!lastUpdate) {
			throw new Error("expected final parallel subagent update");
		}
		expect(textFromResult(lastUpdate)).toContain("Parallel subagents: 2/2 completed");
		expect(lastUpdate.details).toMatchObject({
			mode: "parallel",
			status: "completed",
			summary: { total: 2, completed: 2, failed: 0, aborted: 0 },
		});
		expect(lastUpdate.details.tasks?.map((task) => task.agent.name)).toEqual(["first", "second"]);
	});

	it("emits chain progress with completed prior steps and the current running step", async () => {
		const prompts: Array<{ agent: string; task: string }> = [];
		const controls = new Map([
			["first", createControlledHandle({ id: "sa_first", sessionId: "session_first", agent: "first", prompts })],
			["second", createControlledHandle({ id: "sa_second", sessionId: "session_second", agent: "second", prompts })],
		]);
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				const controlled = controls.get(agentName);
				if (!controlled) {
					throw new Error(`unexpected agent ${agentName}`);
				}
				return controlled.handle;
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const updates: AgentToolResult<SubagentToolDetails>[] = [];

		const execution = tool.execute(
			"call-1",
			{
				chain: [
					{ agent: "first", task: "produce seed" },
					{ agent: "second", task: "use {previous}" },
				],
			},
			undefined,
			(update) => updates.push(update),
		);
		await waitUntil(() => prompts.length === 1);
		expect(updates.find((update) => update.details.mode === "chain")?.details).toMatchObject({
			mode: "chain",
			status: "running",
			summary: { total: 2, completed: 0, running: 1 },
			steps: [{ index: 0, agent: { name: "first" }, status: "running" }],
		});

		controls
			.get("first")
			?.complete(createSubagentResult({ id: "sa_first", sessionId: "session_first", text: "first output" }));
		await waitUntil(() => prompts.length === 2);

		const secondRunning = updates.find(
			(update) =>
				update.details.mode === "chain" &&
				update.details.steps?.map((step) => step.status).join(",") === "completed,running",
		);
		expect(secondRunning?.details.summary).toMatchObject({ total: 2, completed: 1, running: 1 });
		expect(secondRunning?.details.steps?.map((step) => step.agent.name)).toEqual(["first", "second"]);
		expect(prompts[1]).toEqual({ agent: "second", task: "use first output" });

		controls
			.get("second")
			?.complete(createSubagentResult({ id: "sa_second", sessionId: "session_second", text: "second output" }));

		const result = await execution;
		const lastUpdate = updates.at(-1);

		expect(textFromResult(result)).toBe("second output");
		expect(lastUpdate).toBeDefined();
		if (!lastUpdate) {
			throw new Error("expected final chain subagent update");
		}
		expect(textFromResult(lastUpdate)).toBe("second output");
		expect(lastUpdate.details).toMatchObject({
			mode: "chain",
			status: "completed",
			summary: { total: 2, completed: 2, failed: 0, aborted: 0 },
		});
	});

	it("delegates parallel tasks and returns per-task details", async () => {
		const manager = {
			getDefinition: (agentName: string) =>
				createDefinition(agentName, { source: agentName === "planner" ? "project" : "user" }),
			startByName: vi.fn(async (agentName: string) =>
				createCompletedHandle(`${agentName} output`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
				}),
			),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const result = await tool.execute("call-1", {
			tasks: [
				{ agent: "scout", task: "inspect auth" },
				{ agent: "planner", task: "plan fix" },
			],
		});
		const text = textFromResult(result);

		expect(text).toContain("Parallel subagents: 2/2 completed");
		expect(text).toContain("### 1. scout — completed");
		expect(text).toContain("scout output");
		expect(text).toContain("### 2. planner — completed");
		expect(result.details).toMatchObject({
			mode: "parallel",
			status: "completed",
			summary: { total: 2, completed: 2, failed: 0, aborted: 0 },
			tasks: [
				{
					index: 0,
					subagentId: "sa_scout",
					sessionId: "session_scout",
					agent: { name: "scout", source: "user" },
					status: "completed",
				},
				{
					index: 1,
					subagentId: "sa_planner",
					sessionId: "session_planner",
					agent: { name: "planner", source: "project" },
					status: "completed",
				},
			],
		});
	});

	it("keeps parallel results in input order even when children finish out of order", async () => {
		const completions = new Map<string, Deferred<SubagentResult>>();
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				const completion = createDeferred<SubagentResult>();
				completions.set(agentName, completion);
				return createCompletedHandle(`${agentName} fallback`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					resultPromise: completion.promise,
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const execution = tool.execute("call-1", {
			tasks: [
				{ agent: "first", task: "one" },
				{ agent: "second", task: "two" },
				{ agent: "third", task: "three" },
			],
		});
		await waitUntil(() => startOrder.length === 3);
		completions
			.get("second")
			?.resolve(createSubagentResult({ id: "sa_second", sessionId: "session_second", text: "second done" }));
		completions
			.get("third")
			?.resolve(createSubagentResult({ id: "sa_third", sessionId: "session_third", text: "third done" }));
		completions
			.get("first")
			?.resolve(createSubagentResult({ id: "sa_first", sessionId: "session_first", text: "first done" }));

		const result = await execution;
		const text = textFromResult(result);

		expect(result.details.tasks?.map((task) => task.agent.name)).toEqual(["first", "second", "third"]);
		expect(text.indexOf("### 1. first — completed")).toBeLessThan(text.indexOf("### 2. second — completed"));
		expect(text.indexOf("### 2. second — completed")).toBeLessThan(text.indexOf("### 3. third — completed"));
	});

	it("limits parallel child startup concurrency", async () => {
		const completions: Deferred<SubagentResult>[] = [];
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				const completion = createDeferred<SubagentResult>();
				completions.push(completion);
				return createCompletedHandle(`${agentName} fallback`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					resultPromise: completion.promise,
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const taskCount = DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY + 1;
		const tasks = Array.from({ length: taskCount }, (_value, index) => ({
			agent: `agent-${index}`,
			task: `task-${index}`,
		}));

		const execution = tool.execute("call-1", { tasks });
		await waitUntil(() => startOrder.length === DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY);
		expect(startOrder).toHaveLength(DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY);

		completions[0]?.resolve(
			createSubagentResult({ id: "sa_agent-0", sessionId: "session_agent-0", text: "agent-0 done" }),
		);
		await waitUntil(() => startOrder.length === taskCount);

		for (let index = 1; index < completions.length; index++) {
			completions[index]?.resolve(
				createSubagentResult({
					id: `sa_agent-${index}`,
					sessionId: `session_agent-${index}`,
					text: `agent-${index} done`,
				}),
			);
		}
		const result = await execution;

		expect(result.details.summary).toMatchObject({ total: taskCount, completed: taskCount });
	});

	it("returns a mixed-status parallel result for partial child failures", async () => {
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				if (agentName === "bad") {
					return createCompletedHandle("", {
						id: "sa_bad",
						sessionId: "session_bad",
						stopReason: "error",
						errorMessage: "child failed",
					});
				}
				return createCompletedHandle("child succeeded", { id: "sa_good", sessionId: "session_good" });
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const result = await tool.execute("call-1", {
			tasks: [
				{ agent: "good", task: "succeed" },
				{ agent: "bad", task: "fail" },
			],
		});

		expect(textFromResult(result)).toContain("Parallel subagents: 1/2 completed, 1 failed");
		expect(result.details).toMatchObject({
			mode: "parallel",
			status: "partial",
			summary: { total: 2, completed: 1, failed: 1, aborted: 0 },
			tasks: [{ status: "completed" }, { status: "failed", error: { message: "child failed" } }],
		});
	});

	it("returns a failed parallel result rather than throwing when all child tasks fail", async () => {
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) =>
				createCompletedHandle("", {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					stopReason: "error",
					errorMessage: `${agentName} failed`,
				}),
			),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const result = await tool.execute("call-1", {
			tasks: [
				{ agent: "first", task: "fail first" },
				{ agent: "second", task: "fail second" },
			],
		});

		expect(textFromResult(result)).toContain("Parallel subagents: 0/2 completed, 2 failed");
		expect(result.details).toMatchObject({
			mode: "parallel",
			status: "failed",
			summary: { total: 2, completed: 0, failed: 2 },
			tasks: [
				{ status: "failed", error: { message: "first failed" } },
				{ status: "failed", error: { message: "second failed" } },
			],
		});
	});

	it("aborts and disposes active parallel children when the parent signal aborts", async () => {
		const aborts: string[] = [];
		const disposes: string[] = [];
		const prompts: string[] = [];
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				return createCompletedHandle(`${agentName} never`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					resultPromise: new Promise<SubagentResult>(() => undefined),
					onPrompt: () => prompts.push(agentName),
					onAbort: () => aborts.push(agentName),
					onDispose: () => disposes.push(agentName),
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const controller = new AbortController();
		const taskCount = DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY + 1;
		const tasks = Array.from({ length: taskCount }, (_value, index) => ({
			agent: `agent-${index}`,
			task: `task-${index}`,
		}));

		const execution = tool.execute("call-1", { tasks }, controller.signal);
		await waitUntil(() => prompts.length === DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY);
		controller.abort();

		await expect(execution).rejects.toThrow("Operation aborted");
		expect(startOrder).toHaveLength(DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY);
		expect(aborts.sort()).toEqual([...startOrder].sort());
		expect(disposes.sort()).toEqual([...startOrder].sort());
	});

	it("truncates each parallel task output independently", async () => {
		const longText = "x".repeat(128);
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) =>
				createCompletedHandle(`${agentName}:${longText}`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
				}),
			),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager, maxOutputBytes: 32 });

		const result = await tool.execute("call-1", {
			tasks: [
				{ agent: "one", task: "summarize one" },
				{ agent: "two", task: "summarize two" },
			],
		});
		const output = textFromResult(result);

		expect(output.match(/\[Subagent output truncated:/g)).toHaveLength(2);
		expect(result.details.tasks?.map((task) => task.output?.truncated)).toEqual([true, true]);
		expect(result.details.tasks?.map((task) => task.output?.maxBytes)).toEqual([32, 32]);
	});

	it("runs chain steps sequentially and substitutes previous output", async () => {
		const completions = new Map<string, Deferred<SubagentResult>>();
		const prompts: Array<{ agent: string; task: string }> = [];
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) =>
				createDefinition(agentName, { source: agentName === "second" ? "project" : "user" }),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				const completion = createDeferred<SubagentResult>();
				completions.set(agentName, completion);
				return createCompletedHandle(`${agentName} fallback`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					resultPromise: completion.promise,
					onPrompt: (task) => prompts.push({ agent: agentName, task }),
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const execution = tool.execute("call-1", {
			chain: [
				{ agent: "first", task: "produce seed" },
				{ agent: "second", task: "use {previous}" },
				{ agent: "third", task: "finish after {previous}" },
			],
		});
		await waitUntil(() => prompts.length === 1);
		expect(startOrder).toEqual(["first"]);
		expect(prompts[0]).toEqual({ agent: "first", task: "produce seed" });

		completions
			.get("first")
			?.resolve(createSubagentResult({ id: "sa_first", sessionId: "session_first", text: "first output" }));
		await waitUntil(() => prompts.length === 2);
		expect(startOrder).toEqual(["first", "second"]);
		expect(prompts[1]).toEqual({ agent: "second", task: "use first output" });

		completions
			.get("second")
			?.resolve(createSubagentResult({ id: "sa_second", sessionId: "session_second", text: "second output" }));
		await waitUntil(() => prompts.length === 3);
		expect(startOrder).toEqual(["first", "second", "third"]);
		expect(prompts[2]).toEqual({ agent: "third", task: "finish after second output" });

		completions
			.get("third")
			?.resolve(createSubagentResult({ id: "sa_third", sessionId: "session_third", text: "final output" }));
		const result = await execution;

		expect(textFromResult(result)).toBe("final output");
		expect(result.details).toMatchObject({
			mode: "chain",
			status: "completed",
			summary: { total: 3, completed: 3, failed: 0, aborted: 0 },
			steps: [
				{ index: 0, subagentId: "sa_first", agent: { name: "first", source: "user" }, status: "completed" },
				{ index: 1, subagentId: "sa_second", agent: { name: "second", source: "project" }, status: "completed" },
				{ index: 2, subagentId: "sa_third", agent: { name: "third", source: "user" }, status: "completed" },
			],
		});
	});

	it("stops chain execution at the first failed step", async () => {
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				if (agentName === "bad") {
					return createCompletedHandle("", {
						id: "sa_bad",
						sessionId: "session_bad",
						stopReason: "error",
						errorMessage: "bad failed",
					});
				}
				return createCompletedHandle(`${agentName} output`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const result = await tool.execute("call-1", {
			chain: [
				{ agent: "good", task: "succeed" },
				{ agent: "bad", task: "fail after {previous}" },
				{ agent: "skipped", task: "must not run" },
			],
		});

		expect(startOrder).toEqual(["good", "bad"]);
		expect(textFromResult(result)).toContain("Chain stopped at step 2 (bad) — failed");
		expect(result.details).toMatchObject({
			mode: "chain",
			status: "partial",
			summary: { total: 2, completed: 1, failed: 1, stoppedAt: 1 },
			steps: [
				{ index: 0, agent: { name: "good" }, status: "completed" },
				{ index: 1, agent: { name: "bad" }, status: "failed", error: { message: "bad failed" } },
			],
		});
	});

	it("truncates each chain step output independently", async () => {
		const longText = "x".repeat(128);
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) =>
				createCompletedHandle(`${agentName}:${longText}`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
				}),
			),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager, maxOutputBytes: 32 });

		const result = await tool.execute("call-1", {
			chain: [
				{ agent: "one", task: "summarize one" },
				{ agent: "two", task: "summarize two" },
			],
		});

		expect(textFromResult(result)).toContain("[Subagent output truncated:");
		expect(result.details.steps?.map((step) => step.output?.truncated)).toEqual([true, true]);
		expect(result.details.steps?.map((step) => step.output?.maxBytes)).toEqual([32, 32]);
	});

	it("aborts and disposes the active chain child", async () => {
		const aborts: string[] = [];
		const disposes: string[] = [];
		const prompts: string[] = [];
		const startOrder: string[] = [];
		const manager = {
			getDefinition: (agentName: string) => createDefinition(agentName),
			startByName: vi.fn(async (agentName: string) => {
				startOrder.push(agentName);
				return createCompletedHandle(`${agentName} never`, {
					id: `sa_${agentName}`,
					sessionId: `session_${agentName}`,
					resultPromise: new Promise<SubagentResult>(() => undefined),
					onPrompt: () => prompts.push(agentName),
					onAbort: () => aborts.push(agentName),
					onDispose: () => disposes.push(agentName),
				});
			}),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const controller = new AbortController();

		const execution = tool.execute(
			"call-1",
			{
				chain: [
					{ agent: "first", task: "slow" },
					{ agent: "second", task: "must not start" },
				],
			},
			controller.signal,
		);
		await waitUntil(() => prompts.length === 1);
		controller.abort();

		await expect(execution).rejects.toThrow("Operation aborted");
		expect(startOrder).toEqual(["first"]);
		expect(aborts).toEqual(["first"]);
		expect(disposes).toEqual(["first"]);
	});

	it("rejects ambiguous subagent tool modes", async () => {
		const manager = {
			getDefinition: () => createDefinition("scout"),
			startByName: async () => createCompletedHandle("unused"),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		await expect(
			tool.execute("call-1", {
				agent: "scout",
				task: "single",
				tasks: [{ agent: "scout", task: "parallel" }],
			}),
		).rejects.toThrow(/exactly one mode/);
		await expect(
			tool.execute("call-1", {
				tasks: [{ agent: "scout", task: "parallel" }],
				chain: [{ agent: "scout", task: "chain" }],
			}),
		).rejects.toThrow(/exactly one mode/);
		await expect(tool.execute("call-1", { tasks: [] })).rejects.toThrow(/at least one task/);
		await expect(tool.execute("call-1", { chain: [] })).rejects.toThrow(/at least one step/);
	});

	it("rejects parallel task lists above the maximum", async () => {
		const manager = {
			getDefinition: () => createDefinition("scout"),
			startByName: async () => createCompletedHandle("unused"),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const tasks = Array.from({ length: DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS + 1 }, (_value, index) => ({
			agent: "scout",
			task: `task-${index}`,
		}));

		await expect(tool.execute("call-1", { tasks })).rejects.toThrow(`Max is ${DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS}`);
	});

	it("throws for unknown agents and is reported as a tool error", async () => {
		const manager = {
			getDefinition: (agentName: string) => {
				throw new SubagentDefinitionNotFoundError(agentName, []);
			},
			startByName: async () => createCompletedHandle("unused"),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		await expect(tool.execute("call-1", { agent: "missing", task: "work" })).rejects.toThrow(
			/Subagent definition "missing" was not found/,
		);

		const session = await createSession({
			tools: ["subagent"],
			manager,
			responses: [
				fauxAssistantMessage(fauxToolCall("subagent", { agent: "missing", task: "work" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("handled error"),
			],
		});
		const events: Array<{ type: string; toolName?: string; isError?: boolean }> = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				events.push({ type: event.type, toolName: event.toolName, isError: event.isError });
			}
		});
		await session.prompt("delegate");
		unsubscribe();

		expect(events).toContainEqual({ type: "tool_execution_end", toolName: "subagent", isError: true });
		expect(session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	it("aborts and disposes the child when the parent tool signal aborts", async () => {
		let abortCalled = false;
		let disposeCalled = false;
		let promptStarted = false;
		let resolvePromptStarted: () => void = () => undefined;
		const promptStartedPromise = new Promise<void>((resolve) => {
			resolvePromptStarted = resolve;
		});
		const handle: SubagentHandle = {
			id: "sa_abort",
			sessionId: "session_abort",
			prompt: async () => {
				promptStarted = true;
				resolvePromptStarted();
				await new Promise<never>(() => undefined);
			},
			abort: async () => {
				abortCalled = true;
			},
			getState: async (): Promise<RpcSessionState> => {
				throw new Error("not used");
			},
			getTranscript: async (): Promise<RpcTranscriptResponse> => {
				throw new Error("not used");
			},
			getSessionStats: async () => {
				throw new Error("not used");
			},
			waitForEnd: async () => new Promise<SubagentResult>(() => undefined),
			dispose: async () => {
				disposeCalled = true;
			},
			onEvent: () => () => undefined,
		};
		const manager = {
			getDefinition: () => createDefinition("scout"),
			startByName: async () => handle,
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });
		const controller = new AbortController();

		const execution = tool.execute("call-1", { agent: "scout", task: "slow" }, controller.signal);
		await promptStartedPromise;
		controller.abort();

		await expect(execution).rejects.toThrow("Operation aborted");
		expect(promptStarted).toBe(true);
		expect(abortCalled).toBe(true);
		expect(disposeCalled).toBe(true);
	});

	it("disposes the child after terminal failure details are returned", async () => {
		let disposeCalled = false;
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "child failed" }) as AgentMessage;
		const result = {
			id: "sa_failed",
			sessionId: "session_failed",
			event: { type: "agent_end", messages: [message], willRetry: false },
		} satisfies SubagentResult;
		const handle: SubagentHandle = {
			id: result.id,
			sessionId: result.sessionId,
			prompt: async () => undefined,
			abort: async () => undefined,
			getState: async (): Promise<RpcSessionState> => {
				throw new Error("not used");
			},
			getTranscript: async (): Promise<RpcTranscriptResponse> => {
				throw new Error("not used");
			},
			getSessionStats: async () => ({
				sessionFile: undefined,
				sessionId: result.sessionId,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
			waitForEnd: async () => result,
			dispose: async () => {
				disposeCalled = true;
			},
			onEvent: () => () => undefined,
		};
		const manager = {
			getDefinition: () => createDefinition("scout"),
			startByName: async () => handle,
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const toolResult = await tool.execute("call-1", { agent: "scout", task: "fail" });

		expect(textFromResult(toolResult)).toBe("child failed");
		expect(toolResult.details).toMatchObject({ status: "failed", error: { message: "child failed" } });
		expect(disposeCalled).toBe(true);
	});

	it("truncates model-visible child output", async () => {
		const longText = "x".repeat(DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES + 1024);
		const manager = {
			getDefinition: () => createDefinition("scout"),
			startByName: vi.fn(async () => createCompletedHandle(longText)),
		} satisfies SubagentToolManager;
		const tool = createSubagentTool(process.cwd(), { manager });

		const result = await tool.execute("call-1", { agent: "scout", task: "summarize" });
		const output = textFromResult(result);

		expect(output.length).toBeLessThan(longText.length);
		expect(output).toContain("[Subagent output truncated:");
		expect(result.details.output).toMatchObject({
			bytes: DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES + 1024,
			truncated: true,
			maxBytes: DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES,
		});
	});
});
