import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../src/core/mcp/types.ts";
import {
	createPlanExecutionPrompt,
	PLAN_MAX_SERIALIZED_BYTES,
	parsePlanningState,
	StalePlanRevisionError,
} from "../src/core/planning.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: "stop" | "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("native planning state", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-planning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createPlanningSession(
		options: { tools?: string[]; excludeTools?: string[]; mcpManager?: McpManager } = {},
	) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-api-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			authStorage,
			settingsManager,
			sessionManager,
			resourceLoader,
			agentMode: "plan",
			...(options.tools ? { tools: options.tools } : {}),
			...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
			...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
			customTools: [
				{
					name: "mutate_everything",
					label: "Mutate everything",
					description: "Test mutation tool",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text" as const, text: "mutated" }],
						details: {},
					}),
				},
			],
		});
	}

	it("keeps Plan tools read-only and restores the exact requested Build set", async () => {
		const { session } = await createPlanningSession();
		const planTools = session.getActiveToolNames();
		expect(await session.agent.transformContext?.([])).toEqual([]);
		expect(planTools).toEqual([
			"read",
			"web_search",
			"web_fetch",
			"grep",
			"find",
			"ls",
			"inspect",
			"lsp",
			"update_plan",
			"submit_plan",
		]);
		expect(planTools).not.toContain("bash");
		expect(planTools).not.toContain("mutate_everything");

		const submitBeforeResearch = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "submit-early", name: "submit_plan", arguments: {} },
			args: {},
		} as never);
		expect(submitBeforeResearch).toMatchObject({ block: true });

		const readOnlyLspCall = {
			type: "toolCall" as const,
			id: "lsp-read",
			name: "lsp",
			arguments: { action: "diagnostics" },
		};
		const readOnlyLsp = await session.agent.beforeToolCall?.({
			toolCall: readOnlyLspCall,
			args: { action: "diagnostics" },
		} as never);
		expect(readOnlyLsp).toBeUndefined();
		await session.agent.afterToolCall?.({
			toolCall: readOnlyLspCall,
			args: { action: "diagnostics" },
			result: { content: [{ type: "text", text: "No diagnostics" }] },
			isError: false,
		} as never);
		const submitAfterResearch = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "submit-after-read", name: "submit_plan", arguments: {} },
			args: {},
		} as never);
		expect(submitAfterResearch).toBeUndefined();

		const mutatingLsp = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "lsp-fix", name: "lsp", arguments: { action: "fix" } },
			args: { action: "fix" },
		} as never);
		expect(mutatingLsp).toMatchObject({ block: true });

		await session.setAgentMode("build");
		const buildTools = session.getActiveToolNames();
		expect(buildTools).toContain("mutate_everything");
		expect(buildTools).not.toContain("update_plan");
		expect(buildTools).not.toContain("submit_plan");

		await session.setAgentMode("plan");
		expect(session.getActiveToolNames()).toEqual(planTools);
		session.dispose();
	});

	it("routes direct feedback for a ready Build plan through the Plan delivery seam", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({ steps: [{ text: "Implement the approved change" }] });
		const researchCall = {
			type: "toolCall" as const,
			id: "direct-feedback-research",
			name: "ls",
			arguments: { path: "." },
		};
		expect(
			await session.agent.beforeToolCall?.({
				toolCall: researchCall,
				args: researchCall.arguments,
			} as never),
		).toBeUndefined();
		await session.agent.afterToolCall?.({
			toolCall: researchCall,
			args: researchCall.arguments,
			result: { content: [{ type: "text", text: "files" }] },
			isError: false,
		} as never);
		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Approved change",
			summary: "Implement the approved change.",
		});
		await session.setAgentMode("build");
		expect(session.planningState.plan).toMatchObject({ id: ready.id, phase: "ready" });

		let requestTools: string[] = [];
		session.agent.streamFn = (_model, context) => {
			requestTools = (context.tools ?? []).map((tool) => tool.name);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					seq: 1,
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "I will revise it." }], "stop"),
				});
			});
			return stream;
		};

		await session.prompt("Revise the approved plan");

		expect(session.planningState).toMatchObject({
			mode: "plan",
			plan: { id: ready.id, phase: "draft", revision: ready.revision + 1 },
		});
		expect(requestTools).toContain("update_plan");
		expect(requestTools).not.toContain("mutate_everything");
		const feedbackIndex = session.messages.findIndex(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((content) => content.type === "text" && content.text === "Revise the approved plan"),
		);
		expect(session.messages[feedbackIndex - 1]).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
			content: expect.stringContaining("Phase: draft"),
		});
		await session.dispose();
	});

	it.each(["steer", "followUp"] as const)(
		"returns queued %s feedback to draft and preserves same-generation research",
		async (streamingBehavior) => {
			const { session } = await createPlanningSession();
			session.setSessionName("Queued plan feedback");
			const draft = session.updatePlan({ steps: [{ text: "Implement the researched change" }] });
			const researchCall = {
				type: "toolCall" as const,
				id: `feedback-research-${streamingBehavior}`,
				name: "lsp",
				arguments: { action: "diagnostics" },
			};
			expect(
				await session.agent.beforeToolCall?.({
					toolCall: researchCall,
					args: { action: "diagnostics" },
				} as never),
			).toBeUndefined();
			await session.agent.afterToolCall?.({
				toolCall: researchCall,
				args: { action: "diagnostics" },
				result: { content: [{ type: "text", text: "No diagnostics" }] },
				isError: false,
			} as never);

			const firstRequestStarted = createDeferred<void>();
			const releaseFirstRequest = createDeferred<void>();
			let request = 0;
			session.agent.streamFn = () => {
				const current = request++;
				const stream = new MockAssistantStream();
				const respond = (): void => {
					if (current === 0) {
						stream.push({
							type: "done",
							seq: 1,
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `submit-before-${streamingBehavior}`,
										name: "submit_plan",
										arguments: {
											planId: draft.id,
											expectedRevision: draft.revision,
											title: "Researched change",
											summary: "Implement the researched change.",
										},
									},
								],
								"toolUse",
							),
						});
						return;
					}
					const currentPlan = session.planningState.plan!;
					if (current === 1) {
						expect(currentPlan.phase).toBe("draft");
						stream.push({
							type: "done",
							seq: 1,
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `update-after-${streamingBehavior}`,
										name: "update_plan",
										arguments: {
											planId: currentPlan.id,
											expectedRevision: currentPlan.revision,
											title: currentPlan.title,
											summary: currentPlan.summary,
											steps: [
												...currentPlan.steps.map((step) => ({ id: step.id, text: step.text })),
												{ text: "Add verification coverage" },
											],
										},
									},
								],
								"toolUse",
							),
						});
						return;
					}
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `submit-after-${streamingBehavior}`,
									name: "submit_plan",
									arguments: {
										planId: currentPlan.id,
										expectedRevision: currentPlan.revision,
										title: currentPlan.title,
										summary: currentPlan.summary,
									},
								},
							],
							"toolUse",
						),
					});
				};
				if (current === 0) {
					firstRequestStarted.resolve();
					void releaseFirstRequest.promise.then(respond);
				} else {
					queueMicrotask(respond);
				}
				return stream;
			};

			const run = session.prompt("Submit the researched plan");
			await firstRequestStarted.promise;
			await session.prompt("Add verification coverage", { streamingBehavior });
			releaseFirstRequest.resolve();
			await run;

			expect(request).toBe(3);
			expect(session.planningState.plan).toMatchObject({
				phase: "ready",
				steps: [{ text: "Implement the researched change" }, { text: "Add verification coverage" }],
			});
			const feedbackIndex = session.messages.findIndex(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(
						(content) => content.type === "text" && content.text === "Add verification coverage",
					),
			);
			expect(session.messages[feedbackIndex - 1]).toMatchObject({
				role: "custom",
				customType: "volt-plan-checkpoint",
				content: expect.stringContaining("Phase: draft"),
			});
			await session.dispose();
		},
	);

	it.each(["steer", "followUp"] as const)(
		"refreshes queued %s feedback from a ready Build plan onto the Plan tool surface",
		async (streamingBehavior) => {
			const { session } = await createPlanningSession();
			const draft = session.updatePlan({ steps: [{ text: "Implement the approved change" }] });
			const initialResearchCall = {
				type: "toolCall" as const,
				id: `initial-build-feedback-research-${streamingBehavior}`,
				name: "ls",
				arguments: { path: "." },
			};
			expect(
				await session.agent.beforeToolCall?.({
					toolCall: initialResearchCall,
					args: initialResearchCall.arguments,
				} as never),
			).toBeUndefined();
			await session.agent.afterToolCall?.({
				toolCall: initialResearchCall,
				args: initialResearchCall.arguments,
				result: { content: [{ type: "text", text: "agent/" }] },
				isError: false,
			} as never);
			const ready = session.submitPlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				title: "Approved change",
				summary: "Implement the approved change.",
			});
			await session.setAgentMode("build");

			const firstRequestStarted = createDeferred<void>();
			const releaseFirstRequest = createDeferred<void>();
			const requestContexts: Array<{ systemPrompt: string; tools: string[] }> = [];
			let request = 0;
			session.agent.streamFn = (_model, context) => {
				const current = request++;
				requestContexts.push({
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				const stream = new MockAssistantStream();
				const respond = (): void => {
					if (current === 0) {
						stream.push({
							type: "done",
							seq: 1,
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "Build turn complete" }], "stop"),
						});
						return;
					}
					const currentPlan = session.planningState.plan!;
					if (current === 1) {
						stream.push({
							type: "done",
							seq: 1,
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `build-feedback-research-${streamingBehavior}`,
										name: "ls",
										arguments: { path: "." },
									},
								],
								"toolUse",
							),
						});
						return;
					}
					if (current === 2) {
						stream.push({
							type: "done",
							seq: 1,
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `update-build-feedback-${streamingBehavior}`,
										name: "update_plan",
										arguments: {
											planId: currentPlan.id,
											expectedRevision: currentPlan.revision,
											title: currentPlan.title,
											summary: currentPlan.summary,
											steps: [
												...currentPlan.steps.map((step) => ({ id: step.id, text: step.text })),
												{ text: "Add verification coverage" },
											],
										},
									},
								],
								"toolUse",
							),
						});
						return;
					}
					stream.push({
						type: "done",
						seq: 1,
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `submit-build-feedback-${streamingBehavior}`,
									name: "submit_plan",
									arguments: {
										planId: currentPlan.id,
										expectedRevision: currentPlan.revision,
										title: currentPlan.title,
										summary: currentPlan.summary,
									},
								},
							],
							"toolUse",
						),
					});
				};
				if (current === 0) {
					firstRequestStarted.resolve();
					void releaseFirstRequest.promise.then(respond);
				} else {
					queueMicrotask(respond);
				}
				return stream;
			};

			const run = session.agent.prompt("Continue Build work");
			await firstRequestStarted.promise;
			await session.prompt("Add verification coverage", { streamingBehavior });
			releaseFirstRequest.resolve();
			await run;

			expect(request).toBe(4);
			expect(requestContexts[0]!.systemPrompt).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
			expect(requestContexts[0]!.tools).toContain("update_plan");
			expect(requestContexts[0]!.tools).not.toContain("mutate_everything");
			expect(requestContexts[1]!.systemPrompt).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
			expect(requestContexts[1]!.tools).toContain("update_plan");
			expect(requestContexts[1]!.tools).toContain("submit_plan");
			expect(requestContexts[1]!.tools).not.toContain("mutate_everything");
			expect(session.planningState).toMatchObject({
				mode: "plan",
				plan: {
					id: ready.id,
					phase: "ready",
					steps: [{ text: "Implement the approved change" }, { text: "Add verification coverage" }],
				},
			});
			await session.dispose();
		},
	);

	it("requires fresh research after tree navigation restores a draft branch", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({ steps: [{ text: "Implement the researched change" }] });
		session.sessionManager.appendMessage({ role: "user", content: "Prepare the plan", timestamp: 1 });
		const branchPointId = session.sessionManager.appendMessage(
			createAssistantMessage([{ type: "text", text: "I will research it." }], "stop"),
		);
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		const researchCall = {
			type: "toolCall" as const,
			id: "research-before-navigation",
			name: "lsp",
			arguments: { action: "diagnostics" },
		};
		expect(
			await session.agent.beforeToolCall?.({
				toolCall: researchCall,
				args: { action: "diagnostics" },
			} as never),
		).toBeUndefined();
		await session.agent.afterToolCall?.({
			toolCall: researchCall,
			args: { action: "diagnostics" },
			result: { content: [{ type: "text", text: "No diagnostics" }] },
			isError: false,
		} as never);
		session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Researched change",
			summary: "Implement the researched change.",
		});

		await session.navigateTree(branchPointId, { summarize: false });
		expect(session.planningState).toMatchObject({
			mode: "plan",
			plan: { id: draft.id, revision: draft.revision, phase: "draft" },
		});
		const submitCall = {
			type: "toolCall" as const,
			id: "submit-after-navigation",
			name: "submit_plan",
			arguments: {
				planId: draft.id,
				expectedRevision: draft.revision,
				title: "Researched change",
				summary: "Implement the researched change.",
			},
		};
		expect(
			await session.agent.beforeToolCall?.({
				toolCall: submitCall,
				args: submitCall.arguments,
			} as never),
		).toMatchObject({ block: true });

		const freshResearchCall = { ...researchCall, id: "research-after-navigation" };
		expect(
			await session.agent.beforeToolCall?.({
				toolCall: freshResearchCall,
				args: { action: "diagnostics" },
			} as never),
		).toBeUndefined();
		await session.agent.afterToolCall?.({
			toolCall: freshResearchCall,
			args: { action: "diagnostics" },
			result: { content: [{ type: "text", text: "No diagnostics" }] },
			isError: false,
		} as never);
		expect(
			await session.agent.beforeToolCall?.({
				toolCall: submitCall,
				args: submitCall.arguments,
			} as never),
		).toBeUndefined();
		await session.dispose();
	});

	it("does not count a protocol-level MCP failure as successful Plan research", async () => {
		const source = sourceForMcpConfigPath(join(agentDir, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		});
		const merged = createEmptyMcpMergedConfig();
		mergeMcpConfigFile(
			merged,
			{
				servers: {
					fake: {
						command: "fake-mcp",
						trustedReads: { tools: ["read_note"] },
					},
				},
			},
			source,
		);
		const manager = new McpManager({
			config: finalizeMcpConfig(merged),
			clientFactory: {
				connect: async () =>
					({
						getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
						listTools: async () => ({
							tools: [
								{
									name: "read_note",
									description: "Read a note",
									inputSchema: { type: "object" },
									annotations: { readOnlyHint: true },
								},
							],
						}),
						listResources: async () => ({ resources: [] }),
						readResource: async () => ({ contents: [] }),
						listPrompts: async () => ({ prompts: [] }),
						getPrompt: async () => ({ messages: [] }),
						callTool: async () => ({
							content: [{ type: "text", text: "read failed" }],
							isError: true,
						}),
						close: async () => undefined,
					}) as McpClientConnection,
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
		});
		await manager.connectServer("fake");
		const { session } = await createPlanningSession({ mcpManager: manager });
		const draft = session.updatePlan({ steps: [{ text: "Implement the researched change" }] });
		const toolEvents: Array<{ toolName: string; result: unknown; isError: boolean }> = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				toolEvents.push({ toolName: event.toolName, result: event.result, isError: event.isError });
			}
		});
		let request = 0;
		session.agent.streamFn = () => {
			const current = request;
			request += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (current === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "mcp-failed-read",
								name: "mcp",
								arguments: { action: "call", server: "fake", tool: "read_note" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
					return;
				}
				if (current === 1) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "submit-after-mcp-failure",
								name: "submit_plan",
								arguments: {
									planId: draft.id,
									expectedRevision: draft.revision,
									title: "Blocked plan",
									summary: "This must remain blocked after failed research.",
								},
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
					return;
				}
				const message = createAssistantMessage([{ type: "text", text: "blocked" }], "stop");
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		};

		await session.prompt("Research before submitting the plan");
		unsubscribe();

		expect(toolEvents).toEqual([
			expect.objectContaining({
				toolName: "mcp",
				isError: true,
				result: expect.objectContaining({
					isError: true,
					details: {
						result: expect.objectContaining({ action: "call", status: "failed", content: "read failed" }),
					},
				}),
			}),
			expect.objectContaining({
				toolName: "submit_plan",
				isError: true,
				result: expect.objectContaining({
					content: [
						expect.objectContaining({
							text: expect.stringContaining("requires at least one successful read operation"),
						}),
					],
				}),
			}),
		]);
		expect(
			session.messages.find((message) => message.role === "toolResult" && message.toolName === "mcp"),
		).toMatchObject({
			isError: true,
			details: {
				result: expect.objectContaining({ action: "call", status: "failed", content: "read failed" }),
			},
		});
		expect(session.planningState.plan).toMatchObject({ id: draft.id, phase: "draft" });
		await session.dispose();
	});

	it("restores skipped eager MCP direct tools before retained-context execution enters Build", async () => {
		const source = sourceForMcpConfigPath(join(agentDir, "mcp-direct.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		});
		const merged = createEmptyMcpMergedConfig();
		mergeMcpConfigFile(
			merged,
			{
				servers: {
					fake: {
						command: "fake-mcp",
						lifecycle: "eager",
						directTools: ["read_note"],
					},
				},
			},
			source,
		);
		let connections = 0;
		const manager = new McpManager({
			config: finalizeMcpConfig(merged),
			clientFactory: {
				connect: async () => {
					connections += 1;
					return {
						getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
						listTools: async () => ({
							tools: [
								{
									name: "read_note",
									description: "Read a note",
									inputSchema: { type: "object" },
									annotations: { readOnlyHint: true },
								},
							],
						}),
						listResources: async () => ({ resources: [] }),
						readResource: async () => ({ contents: [] }),
						listPrompts: async () => ({ prompts: [] }),
						getPrompt: async () => ({ messages: [] }),
						callTool: async () => ({ content: [{ type: "text", text: "read" }] }),
						close: async () => undefined,
					} as McpClientConnection;
				},
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
		});
		await manager.startEagerServers(undefined, { trustedReadsOnly: true });
		expect(connections).toBe(0);
		expect(manager.getDirectToolCandidates()).toEqual([]);

		const directToolName = "mcp__fake__read_note";
		const { session } = await createPlanningSession({ mcpManager: manager, tools: ["mcp", directToolName] });
		expect(session.getActiveToolNames()).not.toContain(directToolName);
		const draft = session.updatePlan({ steps: [{ text: "Implement with the MCP context" }] });
		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Use restored MCP",
			summary: "Retain context and restore the full Build tool surface.",
		});
		const activated = await session.activatePlan(ready.id, ready.revision, {
			id: "execution-mcp-restore",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		});

		expect(activated.planning.mode).toBe("build");
		expect(connections).toBe(1);
		expect(session.getActiveToolNames()).toContain(directToolName);
		expect(session.getToolDefinition(directToolName)).toBeDefined();

		session.setActiveToolsByName(["mcp"]);
		await session.setAgentMode("plan");
		await session.setAgentMode("build");
		expect(session.getActiveToolNames()).not.toContain(directToolName);
		await session.dispose();
	});

	it("serializes concurrent toggles so each derives its target from committed state", async () => {
		const source = sourceForMcpConfigPath(join(agentDir, "mcp-toggle.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		});
		const merged = createEmptyMcpMergedConfig();
		mergeMcpConfigFile(
			merged,
			{
				servers: {
					fake: {
						command: "fake-mcp",
						lifecycle: "eager",
					},
				},
			},
			source,
		);
		const metadataStarted = createDeferred<void>();
		const finishMetadata = createDeferred<void>();
		const manager = new McpManager({
			config: finalizeMcpConfig(merged),
			clientFactory: {
				connect: async () =>
					({
						getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
						listTools: async () => {
							metadataStarted.resolve();
							await finishMetadata.promise;
							return { tools: [] };
						},
						listResources: async () => ({ resources: [] }),
						readResource: async () => ({ contents: [] }),
						listPrompts: async () => ({ prompts: [] }),
						getPrompt: async () => ({ messages: [] }),
						callTool: async () => ({ content: [] }),
						close: async () => undefined,
					}) as McpClientConnection,
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
		});
		const { session } = await createPlanningSession({ mcpManager: manager });
		const committedModes: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "planning_state_changed") committedModes.push(event.planning.mode);
		});

		const firstToggle = session.toggleAgentMode();
		const secondToggle = session.toggleAgentMode();
		await metadataStarted.promise;
		expect(session.agentMode).toBe("plan");
		finishMetadata.resolve();
		const [first, second] = await Promise.all([firstToggle, secondToggle]);

		expect(first.mode).toBe("build");
		expect(second.mode).toBe("plan");
		expect(session.agentMode).toBe("plan");
		expect(committedModes).toEqual(["build", "plan"]);
		unsubscribe();
		await session.dispose();
	});

	it("preserves allowlist and exclusion policy across Plan and Build profiles", async () => {
		const allowed = await createPlanningSession({ tools: ["read", "bash", "mutate_everything"] });
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "update_plan", "submit_plan"]);
		await allowed.session.setAgentMode("build");
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "bash", "mutate_everything"]);
		allowed.session.dispose();

		const excluded = await createPlanningSession({ excludeTools: ["read", "inspect"] });
		expect(excluded.session.getActiveToolNames()).not.toContain("read");
		expect(excluded.session.getActiveToolNames()).not.toContain("inspect");
		await excluded.session.setAgentMode("build");
		expect(excluded.session.getActiveToolNames()).not.toContain("read");
		expect(excluded.session.getActiveToolNames()).not.toContain("inspect");
		excluded.session.dispose();
	});

	it("freezes approved scope, tracks progress separately, and requires reapproval for replanning", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
			steps: [{ text: "Inspect the architecture" }, { text: "Implement the workflow" }],
		});
		expect(draft.revision).toBe(1);
		expect(draft.steps.every((step) => step.id.length > 0 && step.status === "pending")).toBe(true);
		const draftPolicy = session.state.systemPrompt;
		expect(draftPolicy).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
		expect(draftPolicy).not.toContain(draft.id);
		expect(draftPolicy).not.toContain("Revision:");
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				title: draft.title,
				summary: draft.summary,
				steps: draft.steps.map((step) => ({ id: step.id, text: step.text })),
			}),
		).toThrow("made no changes");
		expect(() =>
			session.submitPlan({
				planId: draft.id,
				expectedRevision: 0,
				title: "Implement native planning",
				summary: "Wire the shared state through every surface.",
			}),
		).toThrow(StalePlanRevisionError);

		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
		});
		expect(ready.phase).toBe("ready");
		expect(ready.revision).toBe(2);
		expect(session.state.systemPrompt).toBe(draftPolicy);

		await session.setAgentMode("build");
		expect(session.planningState.plan).toMatchObject({ id: draft.id, phase: "ready" });
		await session.setAgentMode("plan");
		const changed = session.changePlan(draft.id, ready.revision);
		expect(changed).toMatchObject({ mode: "plan", plan: { phase: "draft", revision: 3 } });

		const readyAgain = session.submitPlan({
			planId: draft.id,
			expectedRevision: 3,
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
		});
		const execution = {
			id: "execution-1",
			approvedRevision: readyAgain.revision,
			strategy: "retain_context" as const,
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		};
		const activated = await session.activatePlan(draft.id, readyAgain.revision, execution);
		expect(activated).toMatchObject({
			activated: true,
			planning: { mode: "build", plan: { phase: "active" } },
		});
		expect(session.getActiveToolNames()).toContain("update_plan_progress");
		expect(session.getActiveToolNames()).toContain("request_replan");
		expect(session.getActiveToolNames()).not.toContain("update_plan");
		expect(session.getActiveToolNames()).not.toContain("submit_plan");
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: activated.planning.plan!.revision,
				steps: [{ text: "Replace the approved scope" }],
			}),
		).toThrow("only in Plan mode");

		const active = session.planningState.plan!;
		const executionPolicy = session.state.systemPrompt;
		const executionTools = session.getActiveToolNames();
		expect(executionPolicy).toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
		expect(executionPolicy).not.toContain(active.id);
		expect(executionPolicy).not.toContain("Revision:");
		const progressTool = session.state.tools.find((tool) => tool.name === "update_plan_progress")!;
		const progressResult = await progressTool.execute("progress-1", {
			planId: active.id,
			expectedRevision: active.revision,
			updates: [{ id: active.steps[0]!.id, status: "completed", note: "Architecture inspected" }],
		});
		const progressText = progressResult.content.find((content) => content.type === "text")?.text ?? "";
		expect(progressText).toContain(`"planId":"${active.id}"`);
		expect(progressText).not.toContain(active.summary!);
		expect(progressText).not.toContain("execution");
		const progressed = session.planningState.plan!;
		expect(progressed.steps.map((step) => ({ id: step.id, text: step.text }))).toEqual(
			active.steps.map((step) => ({ id: step.id, text: step.text })),
		);
		expect(progressed.steps[0]).toMatchObject({ status: "completed", note: "Architecture inspected" });
		expect(session.state.systemPrompt).toBe(executionPolicy);
		expect(session.getActiveToolNames()).toEqual(executionTools);
		expect(() =>
			session.updatePlanProgress({
				planId: progressed.id,
				expectedRevision: progressed.revision,
				updates: [{ id: "unknown", status: "completed" }],
			}),
		).toThrow("unknown step id");

		const replanning = session.requestReplan({
			planId: progressed.id,
			expectedRevision: progressed.revision,
			reason: "Implementation revealed a required verification step",
		});
		expect(replanning).toMatchObject({
			mode: "plan",
			plan: { phase: "draft", revision: progressed.revision + 1 },
		});
		expect(replanning.plan?.execution).toBeUndefined();
		expect(() => parsePlanningState(replanning)).not.toThrow();

		const revised = session.updatePlan({
			planId: replanning.plan!.id,
			expectedRevision: replanning.plan!.revision,
			title: replanning.plan!.title,
			summary: replanning.plan!.summary,
			steps: [
				...replanning.plan!.steps.map((step) => ({ id: step.id, text: step.text })),
				{ text: "Verify the coordinated surfaces" },
			],
		});
		expect(revised.steps[0]).toMatchObject({ status: "completed", note: "Architecture inspected" });
		expect(revised.steps.at(-1)).toMatchObject({ status: "pending" });

		const revisedReady = session.submitPlan({
			planId: revised.id,
			expectedRevision: revised.revision,
			title: revised.title!,
			summary: revised.summary!,
		});
		const reactivated = await session.activatePlan(revised.id, revisedReady.revision, {
			...execution,
			id: "execution-2",
			approvedRevision: revisedReady.revision,
		});
		const reactivatedPlan = reactivated.planning.plan!;
		const executionCheckpoint = createPlanExecutionPrompt(reactivatedPlan);
		expect(executionCheckpoint).toContain("[x] Inspect the architecture — Architecture inspected");
		expect(executionCheckpoint).toContain(`Revision: ${reactivatedPlan.revision}`);
		const completed = session.updatePlanProgress({
			planId: reactivatedPlan.id,
			expectedRevision: reactivatedPlan.revision,
			updates: reactivatedPlan.steps
				.filter((step) => step.status !== "completed")
				.map((step) => ({ id: step.id, status: "completed" as const })),
		});
		expect(completed.phase).toBe("completed");
		expect(session.getActiveToolNames()).not.toContain("update_plan_progress");
		expect(session.getActiveToolNames()).not.toContain("request_replan");
		await session.dispose();
	});

	it("rejects id-less duplicate drafts and non-ready handoffs", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({
			title: "Harden lifecycle",
			summary: "Guard the transition boundaries.",
			steps: [{ text: "Audit transitions" }, { text: "Add guards" }],
		});
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				steps: draft.steps.map((step) => ({ text: step.text })),
			}),
		).toThrow("made no changes");
		expect(session.planningState.plan).toMatchObject({ id: draft.id, revision: draft.revision });

		const execution = {
			id: "handoff-1",
			approvedRevision: draft.revision,
			strategy: "new_session" as const,
			sourceSessionId: session.sessionId,
			targetSessionId: "target-session",
		};
		await expect(session.markPlanHandedOff(draft.id, draft.revision, execution)).rejects.toThrow(
			"Only a ready plan can be handed off",
		);

		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Harden lifecycle",
			summary: "Guard the transition boundaries.",
		});
		const handedOff = await session.markPlanHandedOff(draft.id, ready.revision, {
			...execution,
			approvedRevision: ready.revision,
		});
		expect(handedOff).toMatchObject({ mode: "build", plan: { phase: "handed_off" } });
		await session.dispose();
	});

	it("refuses synchronous plan mutations while a queued transition is suspended", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({
			title: "Guarded",
			summary: "Synchronous mutators must not interleave with suspended transitions.",
			steps: [{ text: "Hold the boundary" }],
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const internals = session as unknown as { _prepareUnrestrictedMcpForBuild(): Promise<void> };
		const original = internals._prepareUnrestrictedMcpForBuild.bind(session);
		internals._prepareUnrestrictedMcpForBuild = async () => {
			await gate;
			await original();
		};
		const transition = session.setAgentMode("build");
		await new Promise((resolve) => setImmediate(resolve));
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				steps: [{ text: "Rewrite mid-transition" }],
			}),
		).toThrow("while a planning transition is in progress");
		release();
		await transition;
		expect(session.planningState).toMatchObject({ mode: "build", plan: { id: draft.id, revision: draft.revision } });
		await session.dispose();
	});

	it("turns manual Plan-mode re-entry during execution into a valid draft", async () => {
		const { session } = await createPlanningSession();
		await session.setAgentMode("plan");
		const draft = session.updatePlan({ steps: [{ text: "Implement the approved change" }] });
		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Approved change",
			summary: "Implement and verify the approved change.",
		});
		await session.activatePlan(ready.id, ready.revision, {
			id: "execution-manual-replan",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		});

		const replanning = await session.setAgentMode("plan");
		expect(replanning).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
		expect(replanning.plan?.execution).toBeUndefined();
		expect(() => parsePlanningState(replanning)).not.toThrow();
		const checkpoints = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining(`Revision: ${replanning.plan!.revision}`),
			display: false,
		});
		expect(session.getActiveToolNames()).toContain("update_plan");
		expect(session.getActiveToolNames()).not.toContain("update_plan_progress");
		await session.dispose();
	});

	it("restores a missing canonical plan checkpoint once", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		sessionManager.appendMessage({ role: "user", content: "Continue the active plan", timestamp: 1 });
		sessionManager.appendPlanningState({
			mode: "build",
			plan: {
				id: "restored-plan",
				revision: 7,
				phase: "active",
				title: "Restored plan",
				summary: "Resume from durable state.",
				steps: [{ id: "restored-step", text: "Finish the implementation", status: "in_progress", note: "Started" }],
				execution: {
					id: "restored-execution",
					approvedRevision: 6,
					strategy: "retain_context",
					sourceSessionId: sessionManager.getSessionId(),
					targetSessionId: sessionManager.getSessionId(),
				},
			},
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		const checkpoints = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining("Revision: 7"),
			display: false,
		});
		expect(session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
			content: expect.stringContaining("[>] Finish the implementation — Started"),
		});
		expect(session.state.systemPrompt).not.toContain("restored-plan");
		await session.dispose();
	});

	it("rejects too many steps and oversized semantic state", () => {
		expect(() =>
			parsePlanningState({
				mode: "plan",
				plan: {
					id: "plan",
					revision: 1,
					phase: "draft",
					steps: Array.from({ length: 65 }, (_, index) => ({
						id: `step-${index}`,
						text: `Step ${index}`,
						status: "pending",
					})),
				},
			}),
		).toThrow("at most 64 steps");

		expect(() =>
			parsePlanningState({
				mode: "plan",
				plan: {
					id: "plan",
					revision: 1,
					phase: "draft",
					summary: "x".repeat(PLAN_MAX_SERIALIZED_BYTES),
					steps: [],
				},
			}),
		).toThrow("byte limit");
	});
});
