import { beforeEach, describe, expect, it, vi } from "vitest";

const mistralMock = vi.hoisted(() => ({
	requestOptions: undefined as { headers?: Record<string, string> } | undefined,
}));

vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		chat = {
			stream: async (_payload: unknown, requestOptions: { headers?: Record<string, string> }) => {
				mistralMock.requestOptions = requestOptions;
				throw new Error("captured");
			},
		};
	},
}));

import { getModel } from "../src/models.ts";
import { streamMistral } from "../src/providers/mistral.ts";

async function captureHeaders(cacheRetention: "none" | "short" | "long", knownMetadata = true) {
	const baseModel = getModel("mistral", "mistral-medium-3.5");
	const model = knownMetadata ? baseModel : { ...baseModel, promptCache: undefined };
	await streamMistral(
		model,
		{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
		{ apiKey: "test", sessionId: "mistral-session", cacheRetention },
	).result();
	return mistralMock.requestOptions?.headers;
}

describe("Mistral prompt-cache affinity", () => {
	beforeEach(() => {
		mistralMock.requestOptions = undefined;
	});

	it("sends affinity for declared short caching", async () => {
		expect(await captureHeaders("short")).toMatchObject({ "x-affinity": "mistral-session" });
	});

	it("falls long back to the declared short tier", async () => {
		expect(await captureHeaders("long")).toMatchObject({ "x-affinity": "mistral-session" });
	});

	it("omits affinity for none and unknown metadata", async () => {
		expect(await captureHeaders("none")).toBeUndefined();
		expect(await captureHeaders("short", false)).toBeUndefined();
	});
});
