import { describe, expect, it } from "vitest";
import type { IrohHomeRelayWatchCallback } from "../src/daemon/iroh-native.ts";
import { IrohRelayRecoveryMonitor } from "../src/daemon/iroh-relay-recovery.ts";

describe("Iroh relay recovery confirmation", () => {
	it("retries when reconnect mutation succeeds without a connected watcher generation", async () => {
		let watcher: IrohHomeRelayWatchCallback | undefined;
		let recoveries = 0;
		const logs: string[] = [];
		const monitor = new IrohRelayRecoveryMonitor({
			watchHomeRelay(callback) {
				watcher = callback;
				return {
					async stop() {
						watcher = undefined;
					},
				};
			},
			async recover() {
				recoveries++;
				if (recoveries === 2) watcher?.(null, ["https://relay.example"]);
			},
			log(_level, message) {
				logs.push(message);
			},
			recoveryDelayMs: 1,
			retryDelayMs: 1,
			confirmationTimeoutMs: 5,
		});
		monitor.start();
		watcher?.(null, ["https://relay.example"]);
		watcher?.(null, []);

		await expect.poll(() => recoveries, { timeout: 1_000 }).toBe(2);
		expect(logs).toContain("Iroh relay registration recovery failed");
		expect(logs).toContain("Iroh relay registration recovered");
		await monitor.stop();
	});

	it("fences pending confirmation when the monitor stops", async () => {
		let watcher: IrohHomeRelayWatchCallback | undefined;
		const monitor = new IrohRelayRecoveryMonitor({
			watchHomeRelay(callback) {
				watcher = callback;
				return { async stop() {} };
			},
			async recover() {},
			log() {},
			confirmationTimeoutMs: 1_000,
		});
		monitor.start();
		watcher?.(null, ["https://relay.example"]);
		const confirmation = monitor.confirmReconnect(async () => {});
		await Promise.resolve();
		await monitor.stop();
		await expect(confirmation).rejects.toThrow("stopped before reconnect confirmation");
	});
});
