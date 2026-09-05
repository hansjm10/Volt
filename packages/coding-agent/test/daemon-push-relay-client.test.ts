import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_IROH_REMOTE_PUSH_RELAY_URL,
	type IrohRemotePushRelayHttpClient,
} from "../src/core/remote/iroh/push.ts";
import { createDaemonPushRelayClient } from "../src/daemon/push-relay-client.ts";

const notification = {
	pushTargetId: "target-1",
	pushTargetAuthToken: "target-secret",
	eventId: "event-1",
	hostNodeId: "a".repeat(64),
	kind: "conversation_completed",
	title: "Done",
	body: "Agent finished",
	data: {
		eventId: "event-1",
		hostNodeId: "a".repeat(64),
		kind: "conversation_completed",
	},
};

async function sendBothRequests(client: IrohRemotePushRelayHttpClient): Promise<void> {
	await expect(client.sendNotification(notification)).resolves.toEqual({ status: "sent" });
	await expect(client.revokePushTarget(notification)).resolves.toEqual({ status: "revoked" });
}

function captureRequests() {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => new Response('{"status":"revoked"}', { status: 200 }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("daemon push relay credential destination", () => {
	it.each([
		"https://custom.example.test/root",
		"http://us-central1-volt-3fae7.cloudfunctions.net/pushRelay",
		"https://us-central1-volt-3fae7.cloudfunctions.net:8443/pushRelay",
		"https://us-central1-volt-3fae7.cloudfunctions.net/otherFunction",
		`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}-custom`,
		`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}/child`,
		`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}?custom=1`,
		`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}#custom`,
		"https://us-central1-volt-3fae7.cloudfunctions.net.evil.test/pushRelay",
		"https://us-central1-volt-3fae7.cloudfunctions.net@evil.test/pushRelay",
		"https://user@us-central1-volt-3fae7.cloudfunctions.net/pushRelay",
	])("never sends managed credentials to %s", async (baseUrl) => {
		const fetcher = captureRequests();
		const getManagedAccessToken = vi.fn(() => "managed.jwt.signature");
		for (const token of ["custom-shared-token", undefined]) {
			const client = createDaemonPushRelayClient({}, getManagedAccessToken, {
				VOLT_PUSH_RELAY_URL: baseUrl,
				VOLT_PUSH_RELAY_AUTH_TOKEN: token,
			});
			await sendBothRequests(client);
			const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
			const calls = fetcher.mock.calls.slice(-2);
			expect(calls.map(([url]) => url)).toEqual([
				new URL("v1/notifications", base).href,
				new URL("v1/push-targets/revoke", base).href,
			]);
			for (const [, init] of calls) {
				expect(new Headers(init?.headers).get("authorization")).toBe(token ? `Bearer ${token}` : null);
			}
		}
		expect(getManagedAccessToken).not.toHaveBeenCalled();
	});

	it("preserves explicit custom URL and token precedence over the environment", async () => {
		const fetcher = captureRequests();
		const getManagedAccessToken = vi.fn(() => "managed.jwt.signature");
		const client = createDaemonPushRelayClient(
			{ pushRelayUrl: "https://custom.example.test/root", pushRelayAuthToken: "config-token" },
			getManagedAccessToken,
			{
				VOLT_PUSH_RELAY_URL: DEFAULT_IROH_REMOTE_PUSH_RELAY_URL,
				VOLT_PUSH_RELAY_AUTH_TOKEN: "env-token",
			},
		);
		await sendBothRequests(client);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://custom.example.test/root/v1/notifications",
			"https://custom.example.test/root/v1/push-targets/revoke",
		]);
		for (const [, init] of fetcher.mock.calls) {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer config-token");
		}
		expect(getManagedAccessToken).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		DEFAULT_IROH_REMOTE_PUSH_RELAY_URL,
		`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}/`,
		"https://US-CENTRAL1-VOLT-3FAE7.CLOUDFUNCTIONS.NET:443/pushRelay/",
	])("reads the current managed token for both routes at %s", async (pushRelayUrl) => {
		const fetcher = captureRequests();
		let managedToken: string | undefined = "first.jwt.signature";
		const client = createDaemonPushRelayClient({ pushRelayUrl }, () => managedToken, {});
		await sendBothRequests(client);
		managedToken = "second.jwt.signature";
		await sendBothRequests(client);
		managedToken = undefined;
		await sendBothRequests(client);

		expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([
			"Bearer first.jwt.signature",
			"Bearer first.jwt.signature",
			"Bearer second.jwt.signature",
			"Bearer second.jwt.signature",
			null,
			null,
		]);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
			Array.from({ length: 3 }, () => [
				`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}/v1/notifications`,
				`${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}/v1/push-targets/revoke`,
			]).flat(),
		);
	});
});
