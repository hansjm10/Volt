import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, ThinkingLevel } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model, type ToolResultMessage } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function distinctPngData(suffix: number): string {
	return Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.from([suffix])]).toString("base64");
}

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(volt) => {
					volt.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("exposes image_gen only for Codex models and preserves its requested state across switches", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fauxModel = harness.getModel();
		harness.authStorage.setRuntimeApiKey("openai-codex", "codex-key");
		harness.session.modelRegistry.registerProvider("openai-codex", {
			baseUrl: "https://chatgpt.com/backend-api",
			apiKey: "codex-key",
			api: "openai-codex-responses",
			models: [
				{
					id: "gpt-codex-test",
					name: "GPT Codex Test",
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
		const codexModel = harness.session.modelRegistry.find("openai-codex", "gpt-codex-test");
		expect(codexModel).toBeDefined();

		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("image_gen");
		expect(harness.session.getActiveToolNames()).not.toContain("image_gen");
		expect(harness.session.getToolDefinition("image_gen")).toBeUndefined();

		await harness.session.setModel(codexModel!, { persistDefault: false });
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("image_gen");
		expect(harness.session.getActiveToolNames()).toContain("image_gen");
		expect(harness.session.getToolDefinition("image_gen")).toBeDefined();
		expect(harness.session.systemPrompt).toContain("- image_gen: Generate or edit images with GPT Image 2");

		await harness.session.setModel(fauxModel, { persistDefault: false });
		expect(harness.session.getActiveToolNames()).not.toContain("image_gen");
		await harness.session.setModel(codexModel!, { persistDefault: false });
		expect(harness.session.getActiveToolNames()).toContain("image_gen");

		harness.session.setActiveToolsByName(
			harness.session.getActiveToolNames().filter((toolName) => toolName !== "image_gen"),
		);
		await harness.session.setModel(fauxModel, { persistDefault: false });
		await harness.session.setModel(codexModel!, { persistDefault: false });
		expect(harness.session.getActiveToolNames()).not.toContain("image_gen");
	});

	it("edits RPC attachments and earlier conversation images from a session-scoped agentDir", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const generatedImageData = distinctPngData(1);
		const customImageData = distinctPngData(2);
		const rpcImageData = distinctPngData(3);

		harness.setResponses([fauxAssistantMessage("seeded"), fauxAssistantMessage("ready to edit")]);
		await harness.session.prompt("seed conversation");
		const priorGeneratedResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "generated-image-call",
			toolName: "image_gen",
			content: [
				{ type: "text", text: "Generated image" },
				{ type: "image", mimeType: "image/png", data: generatedImageData },
			],
			details: {},
			isError: false,
			timestamp: Date.now(),
		};
		harness.session.agent.state.messages.push(priorGeneratedResult);
		harness.session.agent.state.messages.push({
			role: "custom",
			customType: "reference_image",
			content: [{ type: "image", mimeType: "image/png", data: customImageData }],
			display: false,
			timestamp: Date.now(),
		});
		await harness.session.prompt("Edit these attached references", {
			images: [{ type: "image", mimeType: "image/png", data: rpcImageData }],
			clientMessageId: "rpc-image-edit",
			source: "rpc",
		});

		const token = codexToken();
		harness.authStorage.setRuntimeApiKey("openai-codex", token);
		harness.session.modelRegistry.registerProvider("openai-codex", {
			baseUrl: "https://chatgpt.com/backend-api",
			apiKey: token,
			api: "openai-codex-responses",
			models: [
				{
					id: "gpt-codex-image-edit",
					name: "GPT Codex Image Edit",
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
		const codexModel = harness.session.modelRegistry.find("openai-codex", "gpt-codex-image-edit");
		expect(codexModel).toBeDefined();
		await harness.session.setModel(codexModel!, { persistDefault: false });

		const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(init?.body as string) as { images: Array<{ image_url: string }> };
			expect(body.images).toEqual([
				{ image_url: `data:image/png;base64,${generatedImageData}` },
				{ image_url: `data:image/png;base64,${customImageData}` },
				{ image_url: `data:image/png;base64,${rpcImageData}` },
			]);
			return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetcher);

		const imageGen = harness.session.agent.state.tools.find((tool) => tool.name === "image_gen");
		expect(imageGen).toBeDefined();
		const result = await imageGen!.execute("call/rpc edit", {
			prompt: "Combine the references",
			num_last_images_to_include: 3,
		});
		const expectedOutputPath = join(
			harness.tempDir,
			"generated_images",
			harness.sessionManager.getSessionId(),
			"call_rpc_edit.png",
		);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({
			operation: "edit",
			outputPath: expectedOutputPath,
			referencedConversationImageCount: 3,
		});
		expect(await readFile(expectedOutputPath)).toEqual(Buffer.from(PNG_BASE64, "base64"));
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("clamps xhigh to the highest supported level and excludes xhigh from available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);

		expect(harness.session.getAvailableThinkingLevels()).toEqual(["off", "minimal", "low", "medium", "high"]);
		harness.session.setThinkingLevel("xhigh");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.eventsOfType("thinking_level_changed").map((event) => event.level)).toEqual(["high"]);
	});

	it("setModel persists the choice as the default model and provider", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.settingsManager.getDefaultProvider()).toBe(nextModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
	});

	it("keeps Fast mode enabled across explicit model, thinking, and scoped-model changes", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;

		harness.session.setThinkingLevel("high", { persistDefault: false });
		harness.session.setFastModeEnabled(true);
		harness.session.setThinkingLevel("low", { persistDefault: false });
		expect(harness.session.fastModeEnabled).toBe(true);
		expect(harness.session.thinkingLevel).toBe("low");

		await harness.session.setModel(modelTwo, { persistDefault: false });
		expect(harness.session.fastModeEnabled).toBe(true);
		expect(harness.session.thinkingLevel).toBe("low");

		harness.session.setThinkingLevel("high", { persistDefault: false });
		harness.session.setScopedModels([{ model: modelOne }]);
		expect(harness.session.fastModeEnabled).toBe(true);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("re-authorizes restrictive-profile arguments after extension mutation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", async (event) => {
						if (event.toolName === "lsp") {
							event.input.action = "fix";
						}
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const args = { action: "diagnostics" };

		const decision = await harness.session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "mutated-lsp", name: "lsp", arguments: args },
			args,
		} as never);

		expect(args.action).toBe("fix");
		expect(decision).toMatchObject({
			block: true,
			reason: expect.stringContaining("workspace.write"),
		});
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", async () => ({
						content: [{ type: "text", text: "patched result" }],
						details: { patched: true },
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.details?.patched === true),
		).toBeDefined();
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(volt) => {
					extensionApi = volt;
					volt.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("does not start a custom turn from an input hook during prompt preflight", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", async () => {
						volt.sendMessage(
							{ customType: "preflight", content: "must not race", display: false },
							{ triggerTurn: true },
						);
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original prompt"), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("hello");
		await Promise.resolve();

		expect(getAssistantTexts(harness)).toEqual(["original prompt"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["input", "before_agent_start"] as const)(
		"aborting during %s preflight starts no run and preserves nextTurn context",
		async (hook) => {
			let shouldAbort = true;
			const harness = await createHarness({
				extensionFactories: [
					(volt) => {
						if (hook === "input") {
							volt.on("input", async (_event, ctx) => {
								if (shouldAbort) {
									shouldAbort = false;
									ctx.abort();
								}
								return { action: "continue" };
							});
						} else {
							volt.on("before_agent_start", async (_event, ctx) => {
								if (shouldAbort) {
									shouldAbort = false;
									ctx.abort();
								}
							});
						}
					},
				],
			});
			harnesses.push(harness);
			await harness.session.sendCustomMessage(
				{ customType: "next-turn", content: "carry this", display: true, details: {} },
				{ deliverAs: "nextTurn" },
			);
			let sawCarriedContext = false;
			harness.setResponses([
				(context) => {
					sawCarriedContext = context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "carry this"),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await expect(harness.session.prompt("aborted prompt")).rejects.toThrow("Prompt aborted");
			await harness.session.abort();
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
			expect(harness.session.messages).toEqual([]);
			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(harness.getPendingResponseCount()).toBe(1);

			harness.session.setSessionName("accepted prompt");
			await harness.session.prompt("accepted prompt");
			expect(sawCarriedContext).toBe(true);
		},
	);

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("preserves before_agent_start instructions across ready-plan mutation requests", async () => {
		const extensionInstruction = "extension-ready-plan-instruction";
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}\n\n${extensionInstruction}`,
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Revise the implementation" }] });
		const ready = harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Ready plan",
			summary: "Revise the implementation.",
		});
		await harness.session.setAgentMode("build");

		const requestContexts: Array<{ systemPrompt: string; tools: string[] }> = [];
		harness.setResponses([
			(context) => {
				requestContexts.push({
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				const current = harness.session.planningState.plan!;
				return fauxAssistantMessage(
					fauxToolCall("update_plan", {
						planId: current.id,
						expectedRevision: current.revision,
						title: current.title,
						summary: current.summary,
						steps: [...current.steps.map((step) => ({ id: step.id, text: step.text })), { text: "Verify it" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requestContexts.push({
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Revise the ready plan");

		expect(harness.session.planningState).toMatchObject({
			mode: "plan",
			plan: {
				id: ready.id,
				phase: "draft",
				revision: ready.revision + 2,
				steps: [{ text: "Revise the implementation" }, { text: "Verify it" }],
			},
		});
		expect(requestContexts).toHaveLength(2);
		for (const context of requestContexts) {
			expect(context.systemPrompt).toContain(extensionInstruction);
			expect(context.systemPrompt).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
			expect(context.tools).toContain("update_plan");
			expect(context.tools).toContain("submit_plan");
		}
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					volt.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
