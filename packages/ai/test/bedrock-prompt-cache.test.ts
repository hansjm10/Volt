import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };
		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}
	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.ts";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

interface CachePoint {
	cachePoint?: { type: string; ttl?: string };
}

interface BedrockPayload {
	system?: CachePoint[];
	messages: Array<{ content?: CachePoint[] }>;
}

const context: Context = {
	systemPrompt: "Stable system prompt",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	cacheRetention: "none" | "short" | "long",
	env?: Record<string, string>,
): Promise<BedrockPayload> {
	let captured: BedrockPayload | undefined;
	const stream = streamBedrock(model, context, {
		cacheRetention,
		env,
		onPayload: (payload) => {
			captured = payload as BedrockPayload;
			return payload;
		},
	});
	for await (const event of stream) {
		if (event.type === "error") break;
	}
	if (!captured) throw new Error("Expected Bedrock payload capture");
	return captured;
}

function lastSystemCachePoint(payload: BedrockPayload): CachePoint["cachePoint"] {
	return payload.system?.at(-1)?.cachePoint;
}

describe("Bedrock prompt-cache metadata", () => {
	it("uses 1h only for documented long-retention regional model IDs", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-5-20251101-v1:0");
		const payload = await capturePayload(model, "long");
		expect(lastSystemCachePoint(payload)).toEqual({ type: "default", ttl: "1h" });
	});

	it("falls back to 5m for short-only Bedrock models", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");
		const payload = await capturePayload(model, "long");
		expect(lastSystemCachePoint(payload)).toEqual({ type: "default" });
	});

	it("omits cache points when model metadata is unknown", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-5");
		const payload = await capturePayload(model, "long");
		expect(lastSystemCachePoint(payload)).toBeUndefined();
		expect(payload.messages.at(-1)?.content?.at(-1)?.cachePoint).toBeUndefined();
	});

	it("keeps AWS_BEDROCK_FORCE_CACHE short-only", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-5");
		const model = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/example",
			promptCache: undefined,
		};
		const payload = await capturePayload(model, "long", { AWS_BEDROCK_FORCE_CACHE: "1" });
		expect(lastSystemCachePoint(payload)).toEqual({ type: "default" });
	});
});
