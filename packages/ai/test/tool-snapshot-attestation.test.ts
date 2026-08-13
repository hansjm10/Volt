import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.ts";
import type {
	AssistantMessageEventStream,
	Context,
	SimpleStreamOptions,
	ToolSetSnapshotAuthority,
} from "../src/types.ts";
import { createToolSetSnapshot } from "../src/utils/tool-state.ts";

const tool = {
	name: "attested_tool",
	description: "Tool represented by the provider payload",
	parameters: Type.Object({ query: Type.String() }),
};

const context: Context = {
	systemPrompt: "Use the available tool when needed.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [tool],
};

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

type ProviderCase = {
	name: string;
	stream: (options: SimpleStreamOptions) => AssistantMessageEventStream;
};

const providers: ProviderCase[] = [
	{
		name: "Anthropic Messages",
		stream: (options) =>
			streamSimpleAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
				...options,
				apiKey: "test-key",
			}),
	},
	{
		name: "OpenAI Responses",
		stream: (options) =>
			streamSimpleOpenAIResponses(getModel("openai", "gpt-4o-mini"), context, {
				...options,
				apiKey: "test-key",
			}),
	},
	{
		name: "OpenAI Codex Responses",
		stream: (options) =>
			streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-5.4"), context, {
				...options,
				apiKey: codexToken(),
				transport: "sse",
			}),
	},
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("provider tool snapshot attestation", () => {
	it.each(providers)("$name reports known authority only for an unchanged payload", async ({ stream }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message: "test request stopped" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const unchanged: ToolSetSnapshotAuthority[] = [];
		await stream({
			onPayload: () => undefined,
			reportToolSetSnapshot: (authority) => unchanged.push(authority),
		}).result();
		expect(unchanged).toEqual([{ kind: "known", snapshot: createToolSetSnapshot([tool]) }]);

		const replaced: ToolSetSnapshotAuthority[] = [];
		await stream({
			onPayload: () => ({ replaced: true }),
			reportToolSetSnapshot: (authority) => replaced.push(authority),
		}).result();
		expect(replaced).toEqual([{ kind: "unknown" }]);
	});
});
