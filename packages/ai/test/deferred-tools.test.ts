import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../src/types.ts";
import { splitDeferredTools, supportsOpenAIToolSearch } from "../src/utils/deferred-tools.ts";
import { createToolSetSnapshot, fingerprintToolDefinition } from "../src/utils/tool-state.ts";

const toolSchema = Type.Object({});
const loaderTool: Tool<typeof toolSchema> = {
	name: "load_tools",
	description: "Activates more tools.",
	parameters: toolSchema,
};
const deferredTool: Tool<typeof toolSchema> = {
	name: "late_tool",
	description: "A large tool definition loaded after the conversation starts.",
	parameters: toolSchema,
};

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeContext<TApi extends AssistantMessage["api"]>(
	model: Model<TApi>,
	resultContent: ToolResultMessage["content"] = [{ type: "text", text: "The late tool is ready." }],
): Context {
	return {
		systemPrompt: "Use the available tools.",
		messages: [
			{ role: "user", content: "Load the late tool.", timestamp: 1 },
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "toolCall", id: "call_1|fc_1", name: loaderTool.name, arguments: {} }],
				usage: zeroUsage(),
				stopReason: "toolUse",
				toolSetSnapshot: createToolSetSnapshot([loaderTool]),
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: loaderTool.name,
				content: resultContent,
				toolSetTransition: { kind: "additive", added: [fingerprintToolDefinition(deferredTool)] },
				isError: false,
				timestamp: 3,
			},
		],
		tools: [loaderTool, deferredTool],
	};
}

async function capturePayload<TApi extends AssistantMessage["api"]>(
	model: Model<TApi>,
	context = makeContext(model),
): Promise<Record<string, unknown>> {
	let capturedPayload: Record<string, unknown> | undefined;
	const codexToken = `e30.${btoa(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
	)}.signature`;
	const stream = streamSimple(model, context, {
		apiKey: model.api === "openai-codex-responses" ? codexToken : "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as Record<string, unknown>;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

describe("message-anchored deferred tools", () => {
	it("splits only marked, unused tools from the request prefix", () => {
		const model = getModel("openai", "gpt-5.4");
		const placement = splitDeferredTools(makeContext(model), true);

		expect(placement.immediate.map((tool) => tool.name)).toEqual([loaderTool.name]);
		expect([...placement.deferred]).toEqual([[deferredTool.name, deferredTool]]);
	});

	it.each([
		[
			"missing snapshot",
			(context: Context) => {
				const assistant = context.messages[1];
				if (assistant.role === "assistant") delete assistant.toolSetSnapshot;
			},
		],
		[
			"definition mismatch",
			(context: Context) => {
				const result = context.messages[2];
				if (result.role === "toolResult") {
					result.toolSetTransition = {
						kind: "additive",
						added: [{ name: deferredTool.name, fingerprint: "wrong" }],
					};
				}
			},
		],
		[
			"reset transition",
			(context: Context) => {
				const result = context.messages[2];
				if (result.role === "toolResult") result.toolSetTransition = { kind: "reset" };
			},
		],
	])("keeps tools eager for %s", (_label, mutate) => {
		const model = getModel("openai", "gpt-5.4");
		const context = makeContext(model);
		mutate(context);

		const placement = splitDeferredTools(context, true);
		expect(placement.immediate.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(placement.deferred.size).toBe(0);
		expect(placement.anchors.size).toBe(0);
	});

	it("keeps every tool eager when deferred loading is disabled", () => {
		const model = getModel("openai", "gpt-5.4");
		const placement = splitDeferredTools(makeContext(model), false);

		expect(placement.immediate.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(placement.deferred.size).toBe(0);
	});

	it("keeps a previously used tool eager even when a later result marks it added", () => {
		const model = getModel("openai", "gpt-5.4");
		const context = makeContext(model);
		const assistant = context.messages[1];
		if (assistant.role !== "assistant") throw new Error("Expected assistant message");
		assistant.content.push({ type: "toolCall", id: "call_2|fc_2", name: deferredTool.name, arguments: {} });

		const placement = splitDeferredTools(context, true);
		expect(placement.immediate.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(placement.deferred.size).toBe(0);
	});

	it("emits Anthropic deferred definitions and tool references for supported models", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const payload = await capturePayload({ ...model, baseUrl: `${model.baseUrl}/` });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(tools.map((tool) => [tool.name, tool.defer_loading])).toEqual([
			[loaderTool.name, undefined],
			[deferredTool.name, true],
		]);
		expect(messages.at(-1)?.content).toEqual([
			expect.objectContaining({
				type: "tool_result",
				content: [{ type: "tool_reference", tool_name: deferredTool.name }],
			}),
			expect.objectContaining({ type: "text", text: "The late tool is ready." }),
		]);
	});

	it("omits empty displaced content from Anthropic reference-bearing results", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const [emptyPayload, blankPayload] = await Promise.all([
			capturePayload(model, makeContext(model, [])),
			capturePayload(model, makeContext(model, [{ type: "text", text: " \n\t " }])),
		]);

		for (const payload of [emptyPayload, blankPayload]) {
			const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
			expect(messages.at(-1)?.content).toEqual([
				expect.objectContaining({
					type: "tool_result",
					content: [{ type: "tool_reference", tool_name: deferredTool.name }],
				}),
			]);
		}
	});

	it("preserves images while omitting blank displaced text from Anthropic results", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const payload = await capturePayload(
			model,
			makeContext(model, [
				{ type: "text", text: " \n\t " },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			]),
		);
		const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(messages.at(-1)?.content).toEqual([
			expect.objectContaining({
				type: "tool_result",
				content: [{ type: "tool_reference", tool_name: deferredTool.name }],
			}),
			expect.objectContaining({
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "ZmFrZQ==",
				},
			}),
		]);
	});

	it("falls back to eager Anthropic definitions for unsupported models", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-haiku-4-5"));
		const tools = payload.tools as Array<Record<string, unknown>>;
		const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(tools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(tools.every((tool) => tool.defer_loading === undefined)).toBe(true);
		expect(messages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			content: "The late tool is ready.",
		});
	});

	it("keeps Anthropic definitions eager on custom endpoints", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const payload = await capturePayload({ ...model, baseUrl: "https://proxy.example.com" });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(tools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(tools.every((tool) => tool.defer_loading === undefined)).toBe(true);
		expect(messages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			content: "The late tool is ready.",
		});
	});

	it("honors explicit Anthropic tool-reference overrides", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const optedIn = await capturePayload({
			...model,
			baseUrl: "https://proxy.example.com",
			compat: { ...model.compat, supportsToolReferences: true },
		});
		const optedInTools = optedIn.tools as Array<Record<string, unknown>>;
		const optedInMessages = optedIn.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(optedInTools.map((tool) => [tool.name, tool.defer_loading])).toEqual([
			[loaderTool.name, undefined],
			[deferredTool.name, true],
		]);
		expect(optedInMessages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			content: [{ type: "tool_reference", tool_name: deferredTool.name }],
		});

		const optedOut = await capturePayload({
			...model,
			compat: { ...model.compat, supportsToolReferences: false },
		});
		const optedOutTools = optedOut.tools as Array<Record<string, unknown>>;
		const optedOutMessages = optedOut.messages as Array<{ content: Array<Record<string, unknown>> }>;

		expect(optedOutTools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(optedOutTools.every((tool) => tool.defer_loading === undefined)).toBe(true);
		expect(optedOutMessages.at(-1)?.content[0]).toMatchObject({
			type: "tool_result",
			content: "The late tool is ready.",
		});
	});

	it("emits OpenAI client tool-search items after the introducing result", async () => {
		const model = getModel("openai", "gpt-5.4");
		const payload = await capturePayload({ ...model, baseUrl: `${model.baseUrl}/` });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const input = payload.input as Array<Record<string, unknown>>;

		expect(tools.map((tool) => [tool.name, tool.strict])).toEqual([[loaderTool.name, false]]);
		expect(input.slice(-3).map((item) => item.type)).toEqual([
			"function_call_output",
			"tool_search_call",
			"tool_search_output",
		]);
		expect(input.at(-1)).toMatchObject({
			type: "tool_search_output",
			tools: [{ type: "function", name: deferredTool.name, strict: false, defer_loading: true }],
		});
	});

	it.each([
		{ provider: "OpenAI Responses", model: getModel("openai", "gpt-5.4"), transform: "dropped assistant" },
		{
			provider: "OpenAI Codex Responses",
			model: getModel("openai-codex", "gpt-5.4"),
			transform: "dropped assistant",
		},
		{ provider: "OpenAI Responses", model: getModel("openai", "gpt-5.4"), transform: "synthetic result" },
		{
			provider: "OpenAI Codex Responses",
			model: getModel("openai-codex", "gpt-5.4"),
			transform: "synthetic result",
		},
	] as const)("anchors $provider tools after a $transform transcript transform", async ({ model, transform }) => {
		const context = makeContext(model);
		if (transform === "dropped assistant") {
			const assistant = context.messages[1];
			if (assistant.role !== "assistant") throw new Error("Expected assistant message");
			assistant.content = [{ type: "text", text: "Preparing tools." }];
			assistant.stopReason = "stop";
			context.messages.splice(2, 0, {
				...assistant,
				content: [{ type: "text", text: "Incomplete response." }],
				stopReason: "error",
				timestamp: 2.5,
			});
		} else {
			context.messages.splice(2, 0, { role: "user", content: "Continue.", timestamp: 2.5 });
		}

		const payload = await capturePayload(model, context);
		const tools = payload.tools as Array<Record<string, unknown>>;
		const input = payload.input as Array<Record<string, unknown>>;
		const resultIndex = input.map((item) => item.type).lastIndexOf("function_call_output");

		expect(tools.map((tool) => tool.name)).toEqual([loaderTool.name]);
		expect(input.slice(resultIndex, resultIndex + 3).map((item) => item.type)).toEqual([
			"function_call_output",
			"tool_search_call",
			"tool_search_output",
		]);
		expect(input[resultIndex + 2]).toMatchObject({
			type: "tool_search_output",
			tools: [{ type: "function", name: deferredTool.name, defer_loading: true }],
		});
	});

	it.each([
		{ provider: "openai", model: getModel("openai", "gpt-5.4") },
		{ provider: "anthropic", model: getModel("anthropic", "claude-opus-4-8") },
	])("anchors a reactivated $provider deferred tool at its latest activation", async ({ model }) => {
		const context = makeContext(model);
		context.messages.push(
			{ role: "user", content: "Remove the late tool.", timestamp: 4 },
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "toolCall", id: "call_2|fc_2", name: loaderTool.name, arguments: {} }],
				usage: zeroUsage(),
				stopReason: "toolUse",
				toolSetSnapshot: createToolSetSnapshot([loaderTool, deferredTool]),
				timestamp: 5,
			},
			{
				role: "toolResult",
				toolCallId: "call_2|fc_2",
				toolName: loaderTool.name,
				content: [{ type: "text", text: "The late tool was removed." }],
				toolSetTransition: { kind: "reset" },
				isError: false,
				timestamp: 6,
			},
			{ role: "user", content: "Reactivate the late tool.", timestamp: 7 },
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "toolCall", id: "call_3|fc_3", name: loaderTool.name, arguments: {} }],
				usage: zeroUsage(),
				stopReason: "toolUse",
				toolSetSnapshot: createToolSetSnapshot([loaderTool]),
				timestamp: 8,
			},
			{
				role: "toolResult",
				toolCallId: "call_3|fc_3",
				toolName: loaderTool.name,
				content: [{ type: "text", text: "The late tool is ready again." }],
				toolSetTransition: { kind: "additive", added: [fingerprintToolDefinition(deferredTool)] },
				isError: false,
				timestamp: 9,
			},
		);

		const payload = await capturePayload(model, context);
		if (model.api === "anthropic-messages") {
			const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
			const referenceIndexes = messages.flatMap((message, messageIndex) =>
				Array.isArray(message.content) &&
				message.content.some(
					(block) =>
						block.type === "tool_result" &&
						Array.isArray(block.content) &&
						block.content.some(
							(item) =>
								typeof item === "object" && item !== null && "type" in item && item.type === "tool_reference",
						),
				)
					? [messageIndex]
					: [],
			);
			expect(referenceIndexes).toEqual([messages.length - 1]);
			return;
		}

		const input = payload.input as Array<Record<string, unknown>>;
		const initialResultIndex = input.findIndex(
			(item) => item.type === "function_call_output" && item.call_id === "call_1",
		);
		const reactivationResultIndex = input.findIndex(
			(item) => item.type === "function_call_output" && item.call_id === "call_3",
		);

		expect(initialResultIndex).toBeGreaterThan(-1);
		expect(reactivationResultIndex).toBeGreaterThan(initialResultIndex);
		expect(
			input
				.slice(initialResultIndex + 1, reactivationResultIndex)
				.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output"),
		).toBe(false);
		expect(input.slice(reactivationResultIndex, reactivationResultIndex + 3).map((item) => item.type)).toEqual([
			"function_call_output",
			"tool_search_call",
			"tool_search_output",
		]);
		expect(input.filter((item) => item.type === "tool_search_call")).toHaveLength(1);
		expect(input.filter((item) => item.type === "tool_search_output")).toHaveLength(1);
		expect(input[reactivationResultIndex + 2]).toMatchObject({
			type: "tool_search_output",
			call_id: input[reactivationResultIndex + 1].call_id,
			tools: [{ type: "function", name: deferredTool.name, defer_loading: true }],
		});
	});

	it("keeps OpenAI Responses definitions eager on custom endpoints", async () => {
		const model = getModel("openai", "gpt-5.4");
		const payload = await capturePayload({ ...model, baseUrl: "https://proxy.example.com/v1" });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const input = payload.input as Array<Record<string, unknown>>;

		expect(tools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(input.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(false);
		expect(input.at(-1)).toMatchObject({ type: "function_call_output", output: "The late tool is ready." });
	});

	it("uses the same tool-search placement for OpenAI Codex Responses", async () => {
		const model = getModel("openai-codex", "gpt-5.4");
		const payload = await capturePayload({ ...model, baseUrl: `${model.baseUrl}/` });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const input = payload.input as Array<Record<string, unknown>>;

		expect(tools.map((tool) => [tool.name, tool.strict])).toEqual([[loaderTool.name, null]]);
		expect(input.at(-1)).toMatchObject({
			type: "tool_search_output",
			tools: [{ type: "function", name: deferredTool.name, strict: null, defer_loading: true }],
		});
	});

	it("keeps OpenAI Codex Responses definitions eager on custom endpoints", async () => {
		const model = getModel("openai-codex", "gpt-5.4");
		const payload = await capturePayload({ ...model, baseUrl: "https://proxy.example.com/backend-api" });
		const tools = payload.tools as Array<Record<string, unknown>>;
		const input = payload.input as Array<Record<string, unknown>>;

		expect(tools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(input.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(false);
		expect(input.at(-1)).toMatchObject({ type: "function_call_output", output: "The late tool is ready." });
	});

	it("honors explicit OpenAI tool-search overrides", async () => {
		const model = getModel("openai", "gpt-5.4");
		const optedIn = await capturePayload({
			...model,
			baseUrl: "https://proxy.example.com/v1",
			compat: { ...model.compat, supportsToolSearch: true },
		});
		const optedInTools = optedIn.tools as Array<Record<string, unknown>>;
		const optedInInput = optedIn.input as Array<Record<string, unknown>>;

		expect(optedInTools.map((tool) => tool.name)).toEqual([loaderTool.name]);
		expect(optedInInput.at(-1)).toMatchObject({ type: "tool_search_output" });

		const optedOut = await capturePayload({
			...model,
			compat: { ...model.compat, supportsToolSearch: false },
		});
		const optedOutTools = optedOut.tools as Array<Record<string, unknown>>;
		const optedOutInput = optedOut.input as Array<Record<string, unknown>>;

		expect(optedOutTools.map((tool) => tool.name)).toEqual([loaderTool.name, deferredTool.name]);
		expect(optedOutInput.some((item) => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(
			false,
		);
		expect(optedOutInput.at(-1)).toMatchObject({
			type: "function_call_output",
			output: "The late tool is ready.",
		});
	});

	it("does not enable tool search for older models unless compat explicitly opts in", () => {
		const model = getModel("openai", "gpt-5.2");
		expect(supportsOpenAIToolSearch(model)).toBe(false);
		expect(supportsOpenAIToolSearch({ ...model, compat: { supportsToolSearch: true } })).toBe(true);
		expect(
			supportsOpenAIToolSearch({ ...getModel("openai", "gpt-5.4"), compat: { supportsToolSearch: false } }),
		).toBe(false);
	});
});
