/**
 * Daemon keep-awake plumbing over the control socket: keep_awake_set spawns the
 * platform child (fake spawn injected via VoltdConfig.keepAwake), replies with
 * keep_awake_result, broadcasts keep_awake_changed, surfaces in status_result,
 * persists in voltd state, and re-applies on the next daemon start.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent, ControlResponse } from "../src/daemon/control-protocol.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";

class FakeChild extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	killed = false;
	unref = vi.fn();
	kill(): boolean {
		this.killed = true;
		this.exitCode = 0;
		return true;
	}
}

function createFakeSpawn() {
	const children: FakeChild[] = [];
	const spawn = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
	return { spawn: spawn as any, children };
}

describe("voltd keep_awake_set", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-keep-awake-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function waitForHealthy(): Promise<DaemonProbeResult> {
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		return status;
	}

	it("toggles, broadcasts, persists, and re-applies on restart", async () => {
		const paths = getDaemonPaths(agentDir);
		const fake = createFakeSpawn();
		const daemon = runVoltDaemon({
			agentDir,
			foreground: false,
			keepAwake: { platform: "darwin", spawn: fake.spawn },
		});
		const daemonStatus = await waitForHealthy();
		expect(fake.spawn).not.toHaveBeenCalled();

		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: daemonStatus.socketPath,
			client: "tui",
			version: "test",
			authToken: daemonStatus.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});

		// Enable: child spawned, result reports active, change broadcast to clients.
		const enabled = await client.request({ type: "keep_awake_set", enabled: true });
		expect(enabled.type).toBe("keep_awake_result");
		expect((enabled as Extract<ControlResponse, { type: "keep_awake_result" }>).keepAwake).toMatchObject({
			enabled: true,
			state: "active",
			method: "caffeinate",
		});
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		expect(fake.spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-s"], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
		});
		await vi.waitFor(() => {
			expect(events.some((event) => event.type === "keep_awake_changed")).toBe(true);
		});

		// Visible in status_result.
		const status = await client.request({ type: "status" });
		expect(status.type).toBe("status_result");
		expect((status as Extract<ControlResponse, { type: "status_result" }>).keepAwake).toMatchObject({
			enabled: true,
			state: "active",
		});

		// Guard rejects a malformed toggle.
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
		expect(fake.children[0]?.killed).toBe(true);

		// Persisted in voltd state...
		expect(existsSync(paths.statePath)).toBe(true);
		const persisted = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
			settings?: { keepAwakeEnabled?: boolean };
		};
		expect(persisted.settings?.keepAwakeEnabled).toBe(true);

		// ...and re-applied on the next daemon start (child spawned without a request).
		const restartFake = createFakeSpawn();
		const restarted = runVoltDaemon({
			agentDir,
			foreground: false,
			keepAwake: { platform: "darwin", spawn: restartFake.spawn },
		});
		const restartStatus = await waitForHealthy();
		expect(restartFake.spawn).toHaveBeenCalledTimes(1);

		// Disable: child killed, persisted off.
		const stopClient = createDaemonClient({
			socketPath: restartStatus.socketPath,
			client: "cli",
			version: "test",
			authToken: restartStatus.authToken,
			reconnect: false,
		});
		const disabled = await stopClient.request({ type: "keep_awake_set", enabled: false });
		expect(disabled.type).toBe("keep_awake_result");
		expect((disabled as Extract<ControlResponse, { type: "keep_awake_result" }>).keepAwake).toMatchObject({
			enabled: false,
			state: "disabled",
		});
		expect(restartFake.children[0]?.killed).toBe(true);
		await stopClient.request({ type: "shutdown" });
		await stopClient.close();
		await expect(restarted).resolves.toBe(0);

		const persistedOff = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
			settings?: { keepAwakeEnabled?: boolean };
		};
		expect(persistedOff.settings?.keepAwakeEnabled).toBeFalsy();
	}, 30_000);
});
