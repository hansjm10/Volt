import { describe, expect, it, vi } from "vitest";
import {
	IrohRemotePushRelayHttpClient,
	MAX_IROH_REMOTE_PUSH_TARGET_REVOCATION_CONCURRENCY,
	MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT,
	revokeIrohRemoteClientPushTargets,
} from "../src/core/remote/iroh/push.ts";
import type { IrohRemotePushTarget } from "../src/core/remote/iroh/state.ts";

function createPushTarget(index: number): IrohRemotePushTarget {
	return {
		id: `target-${index}`,
		provider: "fcm",
		platform: "ios",
		pushTargetAuthToken: `target-auth-${index}`,
		enabled: true,
		createdAt: index,
		updatedAt: index,
	};
}

describe("Iroh push relay target revocation", () => {
	it("posts only target credentials to the fixed revoke route", async () => {
		const fetcher = vi.fn(
			async (_input: string, _init: RequestInit) => new Response('{"status":"revoked"}', { status: 200 }),
		);
		const client = new IrohRemotePushRelayHttpClient({
			baseUrl: "https://push.example.test/root",
			fetcher,
		});

		await expect(
			client.revokePushTarget({ pushTargetId: "target-1", pushTargetAuthToken: "target-secret" }),
		).resolves.toEqual({ status: "revoked" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://push.example.test/root/v1/push-targets/revoke");
		const serializedBody = String(init?.body);
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				"content-length": String(Buffer.byteLength(serializedBody, "utf8")),
				"content-type": "application/json",
			},
		});
		expect(Buffer.byteLength(serializedBody, "utf8")).toBeLessThanOrEqual(16 * 1024);
		expect(JSON.parse(serializedBody)).toEqual({
			pushTargetId: "target-1",
			pushTargetAuthToken: "target-secret",
		});
	});

	it("treats missing and expired relay targets as already absent", async () => {
		for (const status of [404, 410]) {
			const client = new IrohRemotePushRelayHttpClient({
				baseUrl: "https://push.example.test",
				fetcher: async () => new Response('{"error":"gone"}', { status }),
			});
			await expect(
				client.revokePushTarget({ pushTargetId: "target-1", pushTargetAuthToken: "target-secret" }),
			).resolves.toEqual({ status: "already_absent" });
		}
	});

	it("parses an idempotent 2xx revoke response without misreporting it", async () => {
		const client = new IrohRemotePushRelayHttpClient({
			baseUrl: "https://push.example.test",
			fetcher: async () => new Response('{"status":"already_revoked"}', { status: 200 }),
		});
		await expect(
			client.revokePushTarget({ pushTargetId: "target-1", pushTargetAuthToken: "target-secret" }),
		).resolves.toEqual({ status: "already_absent" });
	});

	it("rejects oversized or malformed successful revoke responses", async () => {
		for (const body of ["x".repeat(1025), '{"status":"surprise"}']) {
			const client = new IrohRemotePushRelayHttpClient({
				baseUrl: "https://push.example.test",
				fetcher: async () => new Response(body, { status: 200 }),
			});
			await expect(
				client.revokePushTarget({ pushTargetId: "target-1", pushTargetAuthToken: "target-secret" }),
			).rejects.toThrow();
		}
	});

	it("keeps local revocation cleanup bounded and summarizes remote failures", async () => {
		const pushTargets = Array.from({ length: MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT + 3 }, (_, index) =>
			createPushTarget(index),
		);
		const revokePushTarget = vi.fn(async ({ pushTargetId }: { pushTargetId: string }) => {
			if (pushTargetId === "target-1") throw new Error("relay unavailable");
			return pushTargetId === "target-2"
				? ({ status: "already_absent" } as const)
				: ({ status: "revoked" } as const);
		});

		await expect(
			revokeIrohRemoteClientPushTargets({ pushTargets }, { sendNotification: vi.fn(), revokePushTarget }),
		).resolves.toEqual({
			attempted: MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT,
			revoked: MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT - 2,
			alreadyAbsent: 1,
			failed: 1,
			skipped: 3,
		});
		expect(revokePushTarget).toHaveBeenCalledTimes(MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT);
	});

	it("runs relay cleanup with bounded concurrency", async () => {
		let inFlight = 0;
		let maximumInFlight = 0;
		const revokePushTarget = vi.fn(async () => {
			inFlight += 1;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return { status: "revoked" } as const;
		});
		const pushTargets = Array.from({ length: 12 }, (_, index) => createPushTarget(index));

		await revokeIrohRemoteClientPushTargets({ pushTargets }, { sendNotification: vi.fn(), revokePushTarget });

		expect(maximumInFlight).toBe(MAX_IROH_REMOTE_PUSH_TARGET_REVOCATION_CONCURRENCY);
	});

	it("does not throw when a relay implementation cannot revoke", async () => {
		await expect(
			revokeIrohRemoteClientPushTargets({ pushTargets: [createPushTarget(1)] }, { sendNotification: vi.fn() }),
		).resolves.toEqual({ attempted: 1, revoked: 0, alreadyAbsent: 0, failed: 1, skipped: 0 });
	});
});
