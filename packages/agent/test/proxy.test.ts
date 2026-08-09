import type { AssistantMessage, AssistantMessageEvent, Context, Model, Usage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model = {
	id: "proxy-model",
	name: "Proxy Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 4_000,
} satisfies Model<"openai-responses">;

const context: Context = { messages: [] };

const usage: Usage = {
	input: 3,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createSseResponse(events: ProxyAssistantMessageEvent[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function readStream(events: ProxyAssistantMessageEvent[], signal?: AbortSignal) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => createSseResponse(events)),
	);
	const stream = streamProxy(model, context, {
		authToken: "proxy-token",
		proxyUrl: "https://proxy.example",
		...(signal === undefined ? {} : { signal }),
	});
	const received: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		received.push(event);
	}
	return { events: received, message: await stream.result() };
}

function getText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("proxy stream normalization", () => {
	it("reconstructs immutable snapshots, signatures, tool arguments, and usage", async () => {
		const { events, message } = await readStream([
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "hel" },
			{ type: "text_delta", contentIndex: 0, delta: "lo" },
			{ type: "text_end", contentIndex: 0, contentSignature: "text-signature" },
			{ type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"query":' },
			{ type: "toolcall_delta", contentIndex: 1, delta: '"volt"}' },
			{ type: "toolcall_end", contentIndex: 1 },
			{ type: "done", reason: "toolUse", usage },
		]);

		expect(message).toMatchObject({ stopReason: "toolUse", usage });
		expect(message.content).toEqual([
			{ type: "text", text: "hello", textSignature: "text-signature" },
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "volt" } },
		]);
		const firstTextDelta = events.find((event) => event.type === "text_delta");
		expect(firstTextDelta?.type === "text_delta" ? firstTextDelta.snapshot.content[0] : undefined).toEqual({
			type: "text",
			text: "hel",
		});
		expect(firstTextDelta?.type === "text_delta" && Object.isFrozen(firstTextDelta.snapshot)).toBe(true);
		expect(events.every((event) => Object.isFrozen(event))).toBe(true);
	});

	it("synthesizes a terminal error when the proxy source ends mid-message", async () => {
		const { events, message } = await readStream([
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Assistant stream ended without a terminal fragment");
		expect(getText(message)).toBe("partial");
	});

	it("reports local cancellation as an aborted terminal message", async () => {
		const controller = new AbortController();
		controller.abort();
		const { events, message } = await readStream([{ type: "start" }], controller.signal);

		expect(events.at(-1)?.type).toBe("error");
		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("Request aborted by user");
	});
});
