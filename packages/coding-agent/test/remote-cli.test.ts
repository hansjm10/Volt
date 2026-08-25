import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { main } from "../src/main.ts";

/**
 * `volt remote *` is a control client of the voltd daemon. These tests run the
 * daemon skeleton in-process (no Iroh endpoint) and drive the CLI through
 * main(), mirroring how the commands run in production.
 */
describe("remote CLI (daemon control client)", () => {
	let agentDir: string;
	let workspaceDir: string;
	let daemon: Promise<number> | undefined;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-remote-cli-")));
		workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		daemon = runVoltDaemon({ agentDir, foreground: false });
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
	}, 30_000);

	afterAll(async () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		await main(["daemon", "stop"]);
		delete process.env[ENV_AGENT_DIR];
		await daemon;
		rmSync(agentDir, { recursive: true, force: true });
	}, 90_000);

	beforeEach(() => {
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	function loggedLines(spy: ReturnType<typeof vi.spyOn>): string {
		return spy.mock.calls.map((call) => call.join(" ")).join("\n");
	}

	it("rejects volt remote host with removal guidance", async () => {
		await main(["remote", "host"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain('"volt remote host" has been replaced by the background daemon');
		expect(loggedLines(errorSpy)).toContain("volt daemon start");
	});

	it("registers, lists, and unregisters workspaces over the control socket", async () => {
		await main(["remote", "workspace", "add", workspaceDir, "--name", "ws"]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(loggedLines(errorSpy)).toContain("registered workspace: ws");

		logSpy.mockClear();
		await main(["remote", "workspace", "list"]);
		const listed = JSON.parse(loggedLines(logSpy)) as Array<{ name: string; path: string }>;
		expect(listed.some((workspace) => workspace.name === "ws")).toBe(true);

		await main(["remote", "workspace", "remove", "ws"]);
		expect(process.exitCode ?? 0).toBe(0);

		logSpy.mockClear();
		await main(["remote", "workspace", "list"]);
		const afterRemove = JSON.parse(loggedLines(logSpy)) as Array<{ name: string }>;
		expect(afterRemove.some((workspace) => workspace.name === "ws")).toBe(false);
	});

	it("rejects workspace registration for a missing path", async () => {
		await main(["remote", "workspace", "add", join(agentDir, "does-not-exist")]);
		expect(process.exitCode).toBe(1);
	});

	it("prints daemon status and exits nonzero when phone transport is unavailable", async () => {
		await main(["remote", "workspace", "add", workspaceDir, "--name", "status-ws"]);
		logSpy.mockClear();
		await main(["remote", "status", "--json"]);
		const status = JSON.parse(loggedLines(logSpy)) as {
			workspaces: Array<{ name: string }>;
			clients: unknown[];
			leases: unknown[];
			remotePolicy: { allowTools: string[] | null; detachedRuntimeTtlMs: number };
			remoteTransport: { state: string; reasonCode?: string };
		};
		expect(status.workspaces.some((workspace) => workspace.name === "status-ws")).toBe(true);
		expect(Array.isArray(status.clients)).toBe(true);
		expect(Array.isArray(status.leases)).toBe(true);
		expect(status.remotePolicy).toEqual({ allowTools: null, detachedRuntimeTtlMs: 30 * 60 * 1000 });
		expect(status.remoteTransport).toMatchObject({ state: "unavailable", reasonCode: "extension_missing" });
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		logSpy.mockClear();
		await main(["daemon", "status", "--json"]);
		const daemonStatus = JSON.parse(loggedLines(logSpy)) as {
			remoteTransport: { state: string; reasonCode?: string };
		};
		expect(daemonStatus.remoteTransport).toMatchObject({ state: "unavailable", reasonCode: "extension_missing" });
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		await main(["remote", "workspace", "remove", "status-ws"]);
	});

	it("blocks pairing before workspace mutation when phone transport is unavailable", async () => {
		await main(["remote", "pair", "--workspace", "missing"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("phone transport is unavailable");
		expect(loggedLines(errorSpy)).toContain("Phone transport is not enabled in this daemon");
	});

	it("lists paired clients as JSON", async () => {
		logSpy.mockClear();
		await main(["remote", "clients"]);
		expect(JSON.parse(loggedLines(logSpy))).toEqual([]);
	});

	it("reports missing clients on revoke and approve-repair", async () => {
		await main(["remote", "revoke", "missing-node"]);
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		await main(["remote", "approve-repair", "missing-node"]);
		expect(process.exitCode).toBe(1);
	});

	it("validates RPC access preset arguments before contacting the daemon", async () => {
		await main(["remote", "pair", "--access", "admin"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("--access requires coding, review, chat, or full");

		process.exitCode = undefined;
		errorSpy.mockClear();
		await main(["remote", "access", "node", "set", "admin"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("remote access <node-id> set coding|review|chat|full");
	});

	it("requires a node id for revoke", async () => {
		await main(["remote", "revoke"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("Missing node id");
	});

	it("prints usage for unknown remote commands", async () => {
		await main(["remote", "bogus"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("Unknown remote command");
	});

	it("fails fast when the daemon is not running", async () => {
		const emptyAgentDir = mkdtempSync(join(tmpdir(), "volt-remote-none-"));
		process.env[ENV_AGENT_DIR] = emptyAgentDir;
		try {
			await main(["remote", "status"]);
			expect(process.exitCode).toBe(1);
			expect(loggedLines(errorSpy)).toContain("voltd is not running");
		} finally {
			rmSync(emptyAgentDir, { recursive: true, force: true });
		}
	});
});
