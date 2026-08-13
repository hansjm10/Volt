import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	estimateToolDefinitionTokens,
	fauxAssistantMessage,
	fauxToolCall,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../../src/core/compaction/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #237: message-anchored tool loading", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("restores persisted branch tools and keeps temporarily unavailable names requested", async () => {
		const sessionManager = SessionManager.inMemory();
		const first = await createHarness({
			sessionManager,
			initialActiveToolNames: ["baseline_tool"],
			extensionFactories: [
				(volt) => {
					for (const name of ["baseline_tool", "selected_tool", "late_tool"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(first);
		first.session.setActiveToolsByName(["selected_tool", "late_tool"]);
		expect(sessionManager.buildSessionContext().toolSelection).toEqual({
			kind: "explicit",
			requestedNames: ["selected_tool", "late_tool"],
		});

		const second = await createHarness({
			sessionManager,
			initialActiveToolNames: ["baseline_tool"],
			extensionFactories: [
				(volt) => {
					for (const name of ["baseline_tool", "selected_tool"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(second);

		expect(second.session.getActiveToolNames()).toEqual(["selected_tool"]);
		expect(sessionManager.buildSessionContext().toolSelection).toEqual({
			kind: "explicit",
			requestedNames: ["selected_tool", "late_tool"],
		});
		await second.session.reload();
		expect(second.session.getActiveToolNames()).toEqual(["selected_tool"]);
		expect(sessionManager.buildSessionContext().toolSelection).toEqual({
			kind: "explicit",
			requestedNames: ["selected_tool", "late_tool"],
		});

		const third = await createHarness({
			sessionManager,
			initialActiveToolNames: ["baseline_tool"],
			extensionFactories: [
				(volt) => {
					for (const name of ["baseline_tool", "selected_tool", "late_tool"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(third);
		expect(third.session.getActiveToolNames()).toEqual(["selected_tool", "late_tool"]);
	});

	it("reactivates restored unavailable intent when an extension registers the tool later", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendActiveToolsChange(["late_tool"]);
		let registerLateTool: (() => void) | undefined;
		const harness = await createHarness({
			sessionManager,
			extensionFactories: [
				(volt) => {
					registerLateTool = () => {
						volt.registerTool({
							name: "late_tool",
							label: "Late Tool",
							description: "Registered after restored intent is applied",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
						});
					};
				},
			],
		});
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext().toolSelection).toEqual({
			kind: "explicit",
			requestedNames: ["late_tool"],
		});
		registerLateTool?.();

		expect(harness.session.getActiveToolNames()).toEqual(["late_tool"]);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "active_tools_change")).toHaveLength(1);
		expect(sessionManager.buildSessionContext().toolSelection).toEqual({
			kind: "explicit",
			requestedNames: ["late_tool"],
		});
	});

	it("restores active tools independently when navigating branches", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					for (const name of ["tool_a", "tool_b"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(harness);
		const branchPoint = harness.sessionManager.appendMessage({ role: "user", content: "branch", timestamp: 1 });
		harness.session.setActiveToolsByName(["tool_a"]);
		const branchA = harness.sessionManager.getLeafId()!;
		harness.sessionManager.branch(branchPoint);
		harness.session.setActiveToolsByName(["tool_b"]);
		const branchB = harness.sessionManager.getLeafId()!;

		await harness.session.navigateTree(branchA, { summarize: false });
		expect(harness.session.getActiveToolNames()).toEqual(["tool_a"]);
		await harness.session.navigateTree(branchB, { summarize: false });
		expect(harness.session.getActiveToolNames()).toEqual(["tool_b"]);
	});

	it("records additive active-tool changes on the introducing tool result", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "load_more_tools",
						label: "Load More Tools",
						description: "Load more tools",
						parameters: Type.Object({}),
						execute: async () => {
							volt.setActiveTools([...volt.getActiveTools(), "after_load"]);
							return { content: [{ type: "text", text: "loaded" }], details: {} };
						},
					});
					volt.registerTool({
						name: "after_load",
						label: "After Load",
						description: "Tool available after loading",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "after" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["load_more_tools"]);

		const observedMarkers: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
			(context) => {
				observedMarkers.push(
					context.messages
						.filter((message) => message.role === "toolResult")
						.flatMap((message) =>
							message.toolSetTransition?.kind === "additive"
								? message.toolSetTransition.added.map((definition) => definition.name)
								: [],
						),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["load_more_tools", "after_load"]);
		expect(observedMarkers).toEqual([["after_load"]]);
	});

	it("records tools registered during execution on the introducing result", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["register_late_tool"],
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "register_late_tool",
						label: "Register Late Tool",
						description: "Registers a tool during execution",
						parameters: Type.Object({}),
						execute: async () => {
							volt.registerTool({
								name: "late_tool",
								label: "Late Tool",
								description: "Registered after startup",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
							});
							return { content: [{ type: "text", text: "registered" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);

		let addedNames: string[] | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("register_late_tool", {}), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "register_late_tool",
				);
				addedNames =
					result?.role === "toolResult" && result.toolSetTransition?.kind === "additive"
						? result.toolSetTransition.added.map((definition) => definition.name)
						: undefined;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("register it");

		expect(harness.session.getActiveToolNames()).toEqual(["register_late_tool", "late_tool"]);
		expect(harness.sessionManager.buildSessionContext().toolSelection).toEqual({ kind: "inherit" });
		expect(addedNames).toEqual(["late_tool"]);

		const branch = harness.sessionManager.getBranch();
		const assistantCall = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((content) => content.type === "toolCall"),
		);
		const toolResult = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(assistantCall).toBeDefined();
		expect(toolResult).toBeDefined();

		await harness.session.navigateTree(assistantCall!.id, { summarize: false });
		expect(harness.session.getActiveToolNames()).toEqual(["register_late_tool", "late_tool"]);
		await harness.session.navigateTree(toolResult!.id, { summarize: false });
		expect(harness.session.getActiveToolNames()).toEqual(["register_late_tool", "late_tool"]);
	});

	it("omits the marker when an active-tool change removes an existing tool", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "switch_tools",
						label: "Switch Tools",
						description: "Replace one active tool with another",
						parameters: Type.Object({}),
						execute: async () => {
							volt.setActiveTools(["switch_tools", "new_tool"]);
							return { content: [{ type: "text", text: "switched" }], details: {} };
						},
					});
					for (const name of ["old_tool", "new_tool"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["switch_tools", "old_tool"]);

		let transitionKind: "additive" | "reset" | undefined;
		let requestTools: string[] | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" }),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				const result = results[results.length - 1];
				transitionKind = result?.role === "toolResult" ? result.toolSetTransition?.kind : undefined;
				requestTools = context.tools?.map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("switch");

		expect(transitionKind).toBe("reset");
		expect(requestTools).toEqual(["switch_tools", "new_tool"]);
	});

	it("preserves markerless replacement accounting across tree navigation", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1_000 } },
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "loader",
						label: "Loader",
						description: "Replaces a small tool with a large tool",
						parameters: Type.Object({}),
						execute: async () => {
							volt.setActiveTools(["loader", "large_tool"]);
							return {
								content: [{ type: "text", text: "loaded" }],
								details: {},
								disposition: "stop",
							};
						},
					});
					volt.registerTool({
						name: "small_tool",
						label: "Small Tool",
						description: "small",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "small" }], details: {} }),
					});
					volt.registerTool({
						name: "large_tool",
						label: "Large Tool",
						description: "x".repeat(50_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "large" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["loader", "small_tool"]);

		let transitionKind: "additive" | "reset" | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				transitionKind = event.message.toolSetTransition?.kind;
			}
		});
		harness.setResponses([
			{
				...fauxAssistantMessage(fauxToolCall("loader", {}), { stopReason: "toolUse" }),
				usage: {
					input: 10_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);

		await harness.session.prompt("replace the small tool");

		const usageBeforeNavigation = harness.session.getContextUsage()?.tokens;
		const branch = harness.sessionManager.getBranch();
		const assistantEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const toolResultEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(transitionKind).toBe("reset");
		expect(usageBeforeNavigation).toBeGreaterThan(10_000);
		expect(assistantEntry).toBeDefined();
		expect(toolResultEntry).toBeDefined();

		await harness.session.navigateTree(assistantEntry!.id, { summarize: false });
		await harness.session.navigateTree(toolResultEntry!.id, { summarize: false });

		expect(harness.session.getContextUsage()?.tokens).toBe(usageBeforeNavigation);
	});

	it("attributes an additive activation only to the parallel tool that introduced it", async () => {
		let releaseUnrelated: (() => void) | undefined;
		const activation = new Promise<void>((resolve) => {
			releaseUnrelated = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "unrelated_tool",
						label: "Unrelated Tool",
						description: "Waits for another tool to activate a tool",
						parameters: Type.Object({}),
						execute: async () => {
							await activation;
							return { content: [{ type: "text", text: "unrelated" }], details: {} };
						},
					});
					volt.registerTool({
						name: "parallel_loader",
						label: "Parallel Loader",
						description: "Activates a tool while a sibling call is running",
						parameters: Type.Object({}),
						execute: async () => {
							volt.setActiveTools([...volt.getActiveTools(), "parallel_added"]);
							releaseUnrelated?.();
							return { content: [{ type: "text", text: "loaded" }], details: {} };
						},
					});
					volt.registerTool({
						name: "parallel_added",
						label: "Parallel Added",
						description: "Added by the loader",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "added" }], details: {} }),
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["unrelated_tool", "parallel_loader"]);

		const markers = new Map<string, string[] | undefined>();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("unrelated_tool", {}), fauxToolCall("parallel_loader", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				for (const message of context.messages) {
					if (message.role === "toolResult") {
						markers.set(
							message.toolName,
							message.toolSetTransition?.kind === "additive"
								? message.toolSetTransition.added.map((definition) => definition.name)
								: undefined,
						);
					}
				}
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("load in parallel");

		expect(markers.get("unrelated_tool")).toBeUndefined();
		expect(markers.get("parallel_loader")).toEqual(["parallel_added"]);
	});

	it("attributes concurrent additive activations to their respective loader results", async () => {
		let startedCount = 0;
		let releaseBothStarted: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			releaseBothStarted = resolve;
		});
		const waitForBothToStart = async () => {
			startedCount++;
			if (startedCount === 2) releaseBothStarted?.();
			await bothStarted;
		};
		let releaseFirstActivation: (() => void) | undefined;
		const firstActivation = new Promise<void>((resolve) => {
			releaseFirstActivation = resolve;
		});
		let releaseSecondActivation: (() => void) | undefined;
		const secondActivation = new Promise<void>((resolve) => {
			releaseSecondActivation = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "loader_a",
						label: "Loader A",
						description: "Activates tool A while loader B is running",
						parameters: Type.Object({}),
						execute: async () => {
							await waitForBothToStart();
							volt.setActiveTools([...volt.getActiveTools(), "tool_a"]);
							releaseFirstActivation?.();
							await secondActivation;
							return { content: [{ type: "text", text: "loaded A" }], details: {} };
						},
					});
					volt.registerTool({
						name: "loader_b",
						label: "Loader B",
						description: "Activates tool B while loader A is running",
						parameters: Type.Object({}),
						execute: async () => {
							await waitForBothToStart();
							await firstActivation;
							volt.setActiveTools([...volt.getActiveTools(), "tool_b"]);
							releaseSecondActivation?.();
							return { content: [{ type: "text", text: "loaded B" }], details: {} };
						},
					});
					for (const name of ["tool_a", "tool_b"]) {
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
						});
					}
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["loader_a", "loader_b"]);

		const markers = new Map<string, string[] | undefined>();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("loader_a", {}), fauxToolCall("loader_b", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				for (const message of context.messages) {
					if (message.role === "toolResult") {
						markers.set(
							message.toolName,
							message.toolSetTransition?.kind === "additive"
								? message.toolSetTransition.added.map((definition) => definition.name)
								: undefined,
						);
					}
				}
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("load both in parallel");

		expect(markers.get("loader_a")).toEqual(["tool_a"]);
		expect(markers.get("loader_b")).toEqual(["tool_b"]);
	});

	it.each(["additive", "replacement"] as const)(
		"compacts before continuing after %s live tool growth",
		async (changeKind) => {
			let preparationTokensBefore: number | undefined;
			let firstKeptEntryId: string | undefined;
			const historyIds: string[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 1_000 }],
				settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 10_000 } },
				extensionFactories: [
					(volt) => {
						volt.registerTool({
							name: "loader",
							label: "Loader",
							description: "Activates a large tool",
							parameters: Type.Object({}),
							execute: async () => {
								volt.setActiveTools(
									changeKind === "additive"
										? [...volt.getActiveTools(), "large_tool"]
										: ["loader", "large_tool"],
								);
								return { content: [{ type: "text", text: "loaded" }], details: {} };
							},
						});
						volt.registerTool({
							name: "small_tool",
							label: "Small Tool",
							description: "small",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "small" }], details: {} }),
						});
						volt.registerTool({
							name: "large_tool",
							label: "Large Tool",
							description: "x".repeat(50_000),
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "large" }], details: {} }),
						});
						volt.on("session_before_compact", async (event) => {
							preparationTokensBefore = event.preparation.tokensBefore;
							firstKeptEntryId = event.preparation.firstKeptEntryId;
							return {
								compaction: {
									summary: "compacted before live tool continuation",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setActiveToolsByName(changeKind === "additive" ? ["loader"] : ["loader", "small_tool"]);
			for (let index = 0; index < 12; index++) {
				historyIds.push(
					harness.sessionManager.appendMessage({
						role: "user",
						content: [{ type: "text", text: String(index % 10).repeat(4000) }],
						timestamp: Date.now() + index,
					}),
				);
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			const timeline: string[] = [];
			const requestTools: string[][] = [];
			let observedAddedToolNames: string[] | undefined;
			let contextUsageAfterToolChange: number | null | undefined;
			let estimatedTokensAfter: number | undefined;
			let expectedEstimateAfter: number | undefined;
			let continuationEstimate: number | undefined;
			harness.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "toolResult") {
					contextUsageAfterToolChange = harness.session.getContextUsage()?.tokens;
				}
				if (event.type === "compaction_start") timeline.push("compaction");
				if (event.type === "compaction_end") {
					estimatedTokensAfter = event.result?.estimatedTokensAfter;
					if (harness.session.model) {
						harness.session.agent.state.model = {
							...harness.session.model,
							contextWindow: 40_000,
						};
					}
					expectedEstimateAfter =
						estimateMessagesTokens(harness.session.messages) +
						estimateToolDefinitionTokens(harness.session.agent.state.tools);
				}
			});
			let requestCount = 0;
			harness.session.agent.streamFn = (model, context) => {
				requestCount++;
				timeline.push(`request:${requestCount}`);
				requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
				if (requestCount === 2) {
					const result = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "loader",
					);
					observedAddedToolNames =
						result?.role === "toolResult" && result.toolSetTransition?.kind === "additive"
							? result.toolSetTransition.added.map((definition) => definition.name)
							: undefined;
					continuationEstimate =
						estimateMessagesTokens(context.messages) + estimateToolDefinitionTokens(context.tools);
				}
				const response: AssistantMessage =
					requestCount === 1
						? {
								...fauxAssistantMessage(fauxToolCall("loader", {}), { stopReason: "toolUse" }),
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: {
									input: 10_000,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 10_000,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							}
						: {
								...fauxAssistantMessage("done"),
								api: model.api,
								provider: model.provider,
								model: model.id,
							};
				const stream = createAssistantMessageEventStream();
				const reason = requestCount === 1 ? "toolUse" : "stop";
				queueMicrotask(() => stream.push({ type: "done", seq: 1, reason, message: response }));
				return stream;
			};

			await harness.session.prompt("load the large tool");

			expect(timeline).toEqual(["request:1", "compaction", "request:2"]);
			expect(requestTools).toEqual(
				changeKind === "additive"
					? [["loader"], ["loader", "large_tool"]]
					: [
							["loader", "small_tool"],
							["loader", "large_tool"],
						],
			);
			expect(observedAddedToolNames).toEqual(changeKind === "additive" ? ["large_tool"] : undefined);
			expect(contextUsageAfterToolChange).toBeGreaterThan(20_000);
			expect(historyIds.indexOf(firstKeptEntryId!)).toBeGreaterThanOrEqual(5);
			expect(preparationTokensBefore).toBeGreaterThan(20_000);
			expect(estimatedTokensAfter).toBe(expectedEstimateAfter);
			expect(continuationEstimate).toBeLessThan(20_000);
		},
	);

	it("compacts a run-ending response before restoring tools omitted by prepareRequest", async () => {
		const timeline: string[] = [];
		let prepareRequestCalls = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 } },
			prepareRequest: ({ context }) => {
				prepareRequestCalls++;
				if (prepareRequestCalls !== 1) return undefined;
				return { context: { systemPrompt: context.systemPrompt, messages: context.messages } };
			},
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "large_tool",
						label: "Large Tool",
						description: "x".repeat(40_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "large" }], details: {} }),
					});
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "compacted before restoring prepared tools",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_tool"]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") timeline.push("compaction");
		});

		const requestTools: string[][] = [];
		let requestCount = 0;
		harness.session.agent.streamFn = (model, context) => {
			requestCount++;
			timeline.push(`request:${requestCount}`);
			requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
			const totalTokens = requestCount === 1 ? 10_000 : 100;
			const message: AssistantMessage = {
				...fauxAssistantMessage(requestCount === 1 ? "tool-free response" : "tools restored"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: totalTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", seq: 1, reason: "stop", message }));
			return stream;
		};

		await harness.session.prompt("x".repeat(8_000));

		expect(timeline).toEqual(["request:1", "compaction"]);
		expect(requestTools).toEqual([[]]);

		await harness.session.prompt("continue with restored tools");

		expect(timeline).toEqual(["request:1", "compaction", "request:2"]);
		expect(requestTools).toEqual([[], ["large_tool"]]);
		expect(prepareRequestCalls).toBe(2);
	});

	it("compacts a queued continuation before restoring tools omitted by prepareRequest", async () => {
		const timeline: string[] = [];
		let prepareRequestCalls = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 } },
			prepareRequest: ({ context }) => {
				prepareRequestCalls++;
				if (prepareRequestCalls !== 1) return undefined;
				return { context: { systemPrompt: context.systemPrompt, messages: context.messages } };
			},
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "large_tool",
						label: "Large Tool",
						description: "x".repeat(40_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "large" }], details: {} }),
					});
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "compacted before the queued prepared-tool continuation",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_tool"]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") timeline.push("compaction");
		});

		const requestTools: string[][] = [];
		let requestCount = 0;
		harness.session.agent.streamFn = (model, context) => {
			requestCount++;
			timeline.push(`request:${requestCount}`);
			requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
			if (requestCount === 1) {
				harness.session.agent.followUp({
					role: "user",
					content: [{ type: "text", text: "queued continuation" }],
					timestamp: Date.now(),
				});
			}
			const totalTokens = requestCount === 1 ? 10_000 : 100;
			const message: AssistantMessage = {
				...fauxAssistantMessage(requestCount === 1 ? "tool-free response" : "continued with tools"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: totalTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", seq: 1, reason: "stop", message }));
			return stream;
		};

		await harness.session.prompt("x".repeat(8_000));

		expect(timeline).toEqual(["request:1", "compaction", "request:2"]);
		expect(requestTools).toEqual([[], ["large_tool"]]);
		expect(prepareRequestCalls).toBe(2);
	});

	it("compacts a run-ending small-to-large replacement before the next provider request", async () => {
		const timeline: string[] = [];
		let prepareRequestCalls = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1_000 } },
			prepareRequest: ({ context }) => {
				prepareRequestCalls++;
				return { context: { ...context, tools: context.tools?.slice() } };
			},
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "loader",
						label: "Loader",
						description: "Replaces a small tool with a large tool and ends the batch",
						parameters: Type.Object({}),
						execute: async () => {
							volt.setActiveTools(["loader", "large_tool"]);
							return {
								content: [{ type: "text", text: "loaded" }],
								details: {},
								disposition: "stop",
							};
						},
					});
					volt.registerTool({
						name: "small_tool",
						label: "Small Tool",
						description: "small",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "small" }], details: {} }),
					});
					volt.registerTool({
						name: "large_tool",
						label: "Large Tool",
						description: "x".repeat(50_000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "large" }], details: {} }),
					});
					volt.on("session_before_compact", async (event) => {
						return {
							compaction: {
								summary: "compacted after the terminating replacement",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["loader", "small_tool"]);
		for (let index = 0; index < 12; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: String(index % 10).repeat(4000) }],
				timestamp: Date.now() + index,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let observedTransitionKind: "additive" | "reset" | undefined;
		let safeContinuationEstimate: number | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") timeline.push("compaction");
			if (event.type === "message_end" && event.message.role === "toolResult") {
				observedTransitionKind = event.message.toolSetTransition?.kind;
			}
		});
		let requestCount = 0;
		harness.session.agent.streamFn = (model, context) => {
			requestCount++;
			timeline.push(`request:${requestCount}`);
			if (requestCount === 2) {
				safeContinuationEstimate =
					estimateMessagesTokens(context.messages) + estimateToolDefinitionTokens(context.tools);
			}
			const message: AssistantMessage = {
				...fauxAssistantMessage(
					requestCount === 1 ? fauxToolCall("loader", {}) : "continued safely after compaction",
					{ stopReason: requestCount === 1 ? "toolUse" : "stop" },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: requestCount === 1 ? 10_000 : 100,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: requestCount === 1 ? 10_000 : 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					seq: 1,
					reason: requestCount === 1 ? "toolUse" : "stop",
					message,
				}),
			);
			return stream;
		};

		await harness.session.prompt("replace the small tool and stop");

		expect(requestCount).toBe(1);
		expect(timeline).toEqual(["request:1", "compaction"]);
		expect(observedTransitionKind).toBe("reset");

		await harness.session.prompt("continue after compaction");

		expect(timeline).toEqual(["request:1", "compaction", "request:2"]);
		expect(prepareRequestCalls).toBe(2);
		expect(safeContinuationEstimate).toBeLessThan(19_000);
	});
});
