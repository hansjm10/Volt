import { describe, expect, it } from "vitest";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/loopback-transport.ts";
import { RpcTransportClient } from "../src/modes/rpc/rpc-transport-client.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("RPC subscription usage client", () => {
	it("sends get_subscription_usage and returns the typed report", async () => {
		const pair = createLoopbackRpcTransportPair();
		const detachServer = pair.server.onValue?.((value) => {
			if (!isRecord(value) || value.type !== "get_subscription_usage" || typeof value.id !== "string") {
				throw new Error("Unexpected RPC command");
			}
			pair.server.write({
				id: value.id,
				type: "response",
				command: "get_subscription_usage",
				success: true,
				data: {
					status: "providers",
					providers: [
						{
							providerId: "openai-codex",
							result: {
								status: "success",
								snapshot: {
									providerId: "openai-codex",
									fetchedAt: 1_800_000_000_000,
									limits: [{ id: "weekly", label: "Weekly", usedPercent: 25 }],
								},
							},
						},
					],
				},
			});
		});
		if (!detachServer) throw new Error("Loopback transport does not support structured values");
		const client = new RpcTransportClient({ transport: pair.client });
		await client.start();

		await expect(client.getSubscriptionUsage()).resolves.toEqual({
			status: "providers",
			providers: [
				{
					providerId: "openai-codex",
					result: {
						status: "success",
						snapshot: {
							providerId: "openai-codex",
							fetchedAt: 1_800_000_000_000,
							limits: [{ id: "weekly", label: "Weekly", usedPercent: 25 }],
						},
					},
				},
			],
		});

		detachServer();
		await client.stop();
	});
});
