import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createDaemonClient, type DaemonClient } from "../../../src/daemon/control-client.ts";
import type { IrohEndpointBuilderLike, IrohEndpointLike, IrohModuleLike } from "../../../src/daemon/iroh-native.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../../../src/daemon/main.ts";
import { getDaemonPaths } from "../../../src/daemon/paths.ts";
import { probeDaemon } from "../../../src/daemon/spawn.ts";
import { createHarness } from "../harness.ts";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function createDeferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function clearRelayEnvironment(): () => void {
	const originalRelayEnvironment = {
		mode: process.env.VOLT_IROH_RELAY_MODE,
		urls: process.env.VOLT_IROH_RELAY_URLS,
		authToken: process.env.VOLT_IROH_RELAY_AUTH_TOKEN,
	};
	delete process.env.VOLT_IROH_RELAY_MODE;
	delete process.env.VOLT_IROH_RELAY_URLS;
	delete process.env.VOLT_IROH_RELAY_AUTH_TOKEN;
	return () => {
		for (const [name, value] of Object.entries({
			VOLT_IROH_RELAY_MODE: originalRelayEnvironment.mode,
			VOLT_IROH_RELAY_URLS: originalRelayEnvironment.urls,
			VOLT_IROH_RELAY_AUTH_TOKEN: originalRelayEnvironment.authToken,
		})) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	};
}

function createFakeIroh(endpoint: IrohEndpointLike): IrohModuleLike {
	const builder: IrohEndpointBuilderLike = {
		relayMode(_mode: unknown) {},
		secretKey(_key: number[]) {},
		alpns(_alpns: number[][]) {},
		bind: () => Promise.resolve(endpoint),
	};
	return {
		Endpoint: { builder: () => builder },
		EndpointTicket: { fromAddr: () => ({ toString: () => "test-endpoint-ticket" }) },
		RelayMap: { empty: () => ({ insert(_config) {} }) },
		RelayMode: {
			disabled: () => ({}),
			custom: (_map) => ({}),
			customFromUrls: (_urls) => ({}),
		},
		presetMinimal(_builder) {},
		presetN0(_builder) {},
		presetN0DisableRelay(_builder) {},
	};
}

test("production relay startup times out with actionable diagnostics", async () => {
	const harness = await createHarness();
	const onlineGate = createDeferred();
	const disposeStarted = createDeferred();
	const restoreRelayEnvironment = clearRelayEnvironment();

	let endpointCloseCalls = 0;
	const endpoint: IrohEndpointLike = {
		id: () => ({ toString: () => "test-host-node" }),
		addr: () => ({ nodeId: "test-host-node" }),
		online: () => onlineGate.promise,
		close: async () => {
			endpointCloseCalls++;
		},
		acceptNext: () => Promise.resolve(undefined),
		secretKey: () => ({ toBytes: () => [1, 2, 3, 4] }),
	};
	const iroh = createFakeIroh(endpoint);

	let control: DaemonClient | undefined;
	let daemonStopped = false;
	const daemon = runVoltDaemon({ agentDir: harness.tempDir, foreground: false, extensionDisposeTimeoutMs: 2_000 }, [
		createIrohDaemonService(
			{ relayMode: "production", relayUrls: ["https://relay.example.com"] },
			{ endpointOnlineTimeoutMs: 1_000, loadIrohModule: () => ({ iroh }) },
		),
		() => ({
			async dispose() {
				disposeStarted.resolve();
			},
		}),
	]);

	try {
		await expect.poll(async () => (await probeDaemon(harness.tempDir)).healthy, { timeout: 2_000 }).toBe(true);
		const status = await probeDaemon(harness.tempDir);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await control.connect();

		const logPath = getDaemonPaths(harness.tempDir).logPath;
		await expect
			.poll(() => readFileSync(logPath, "utf8"), { timeout: 1_000 })
			.toContain("iroh endpoint bound; waiting for relay connection");
		const pairResponsePromise = control.request({ type: "pair_request" });
		const pairResponse = await pairResponsePromise;

		expect(pairResponse).toMatchObject({ type: "error", code: "iroh_unavailable" });
		if (pairResponse.type !== "error") {
			throw new Error("pair request unexpectedly succeeded");
		}
		expect(pairResponse.message).toContain("did not establish a relay connection within 1s");
		expect(pairResponse.message).toContain("No production relay auth token is configured");
		expect(pairResponse.message).toContain("VOLT_IROH_RELAY_AUTH_TOKEN");
		expect(pairResponse.message).toContain("restart the daemon");
		expect(pairResponse.message).not.toContain("did not become ready within 15s");
		await expect.poll(() => endpointCloseCalls).toBe(1);

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain('"relayMode":"production"');
		expect(log).toContain('"relayAuthConfigured":false');
		expect(log).toContain("failed to start iroh endpoint: Iroh endpoint did not establish a relay connection");
		expect(await control.request({ type: "status" })).toMatchObject({ type: "status_result" });

		let daemonSettled = false;
		void daemon.then(() => {
			daemonSettled = true;
		});
		expect(await control.request({ type: "shutdown" })).toMatchObject({ type: "ok" });
		await disposeStarted.promise;
		await Promise.resolve();
		expect(daemonSettled).toBe(false);

		onlineGate.resolve();
		await expect(daemon).resolves.toBe(0);
		daemonStopped = true;
	} finally {
		onlineGate.resolve();
		if (!daemonStopped) {
			await control?.request({ type: "shutdown" }).catch(() => {});
			await daemon;
		}
		await control?.close();
		restoreRelayEnvironment();
		harness.cleanup();
	}
}, 10_000);

test("production relay rejection includes actionable diagnostics", async () => {
	const harness = await createHarness();
	const restoreRelayEnvironment = clearRelayEnvironment();
	let endpointCloseCalls = 0;
	const endpoint: IrohEndpointLike = {
		id: () => ({ toString: () => "test-host-node" }),
		addr: () => ({ nodeId: "test-host-node" }),
		online: () => Promise.reject(new Error("relay authentication rejected")),
		close: async () => {
			endpointCloseCalls++;
		},
		acceptNext: () => Promise.resolve(undefined),
		secretKey: () => ({ toBytes: () => [1, 2, 3, 4] }),
	};
	const iroh = createFakeIroh(endpoint);
	let control: DaemonClient | undefined;
	let daemonStopped = false;
	const daemon = runVoltDaemon({ agentDir: harness.tempDir, foreground: false }, [
		createIrohDaemonService(
			{ relayMode: "production", relayUrls: ["https://relay.example.com"] },
			{ endpointOnlineTimeoutMs: 1_000, loadIrohModule: () => ({ iroh }) },
		),
	]);

	try {
		await expect.poll(async () => (await probeDaemon(harness.tempDir)).healthy, { timeout: 2_000 }).toBe(true);
		const status = await probeDaemon(harness.tempDir);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await control.connect();

		const pairResponse = await control.request({ type: "pair_request" });
		expect(pairResponse).toMatchObject({ type: "error", code: "iroh_unavailable" });
		if (pairResponse.type !== "error") {
			throw new Error("pair request unexpectedly succeeded");
		}
		expect(pairResponse.message).toContain("relay connection failed: relay authentication rejected");
		expect(pairResponse.message).toContain("No production relay auth token is configured");
		expect(pairResponse.message).toContain("VOLT_IROH_RELAY_AUTH_TOKEN");
		expect(pairResponse.message).toContain("restart the daemon");
		await expect.poll(() => endpointCloseCalls).toBe(1);

		const log = readFileSync(getDaemonPaths(harness.tempDir).logPath, "utf8");
		expect(log).toContain("failed to start iroh endpoint: Iroh endpoint relay connection failed");
		expect(log).toContain("relay authentication rejected");
		expect(await control.request({ type: "status" })).toMatchObject({ type: "status_result" });

		expect(await control.request({ type: "shutdown" })).toMatchObject({ type: "ok" });
		await expect(daemon).resolves.toBe(0);
		daemonStopped = true;
	} finally {
		if (!daemonStopped) {
			await control?.request({ type: "shutdown" }).catch(() => {});
			await daemon;
		}
		await control?.close();
		restoreRelayEnvironment();
		harness.cleanup();
	}
}, 10_000);
