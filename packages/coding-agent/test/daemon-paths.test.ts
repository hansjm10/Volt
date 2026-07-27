import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDaemonControlSocketPath,
	ensureDaemonDirs,
	getDaemonPaths,
	getDaemonSocketPath,
	isWindowsNamedPipePath,
} from "../src/daemon/paths.ts";

// Unix permission semantics only.
const posixIt = process.platform === "win32" ? it.skip : it;
const win32It = process.platform === "win32" ? it : it.skip;

describe("daemon fallback socket dir hardening", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	posixIt("assigns distinct stable fallback sockets to long agent directories", () => {
		const longRoot = join(tmpdir(), "a".repeat(120));
		const firstAgentDir = join(longRoot, "first-agent");
		const secondAgentDir = join(longRoot, "second-agent");

		const firstSocketPath = getDaemonSocketPath(firstAgentDir);
		const secondSocketPath = getDaemonSocketPath(secondAgentDir);

		expect(firstSocketPath).toBe(getDaemonSocketPath(firstAgentDir));
		expect(firstSocketPath).not.toBe(secondSocketPath);
		expect(Buffer.byteLength(firstSocketPath, "utf8")).toBeLessThanOrEqual(100);
		expect(Buffer.byteLength(secondSocketPath, "utf8")).toBeLessThanOrEqual(100);
	});

	posixIt("tightens loose permissions on a pre-existing fallback socket dir we own", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const socketDir = join(dir, "run");
		// Simulates an attacker-guessable /tmp fallback dir created ahead of the
		// daemon with group/other access.
		mkdirSync(socketDir);
		chmodSync(socketDir, 0o755);
		const paths = { ...getDaemonPaths(agentDir), socketPath: join(socketDir, "voltd.sock") };
		ensureDaemonDirs(paths);
		expect(statSync(socketDir).mode & 0o777).toBe(0o700);
	});

	posixIt("refuses a fallback socket path whose parent is not a directory", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const socketDir = join(dir, "run");
		writeFileSync(socketDir, "not a dir");
		const paths = { ...getDaemonPaths(agentDir), socketPath: join(socketDir, "voltd.sock") };
		expect(() => ensureDaemonDirs(paths)).toThrow();
	});
});

describe("windows named-pipe control socket", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	it("classifies named-pipe paths and rejects filesystem paths", () => {
		expect(isWindowsNamedPipePath("\\\\.\\pipe\\voltd-abc123")).toBe(true);
		expect(isWindowsNamedPipePath("\\\\?\\pipe\\voltd-abc123")).toBe(true);
		expect(isWindowsNamedPipePath("C:\\Users\\x\\.volt\\agent\\daemon\\voltd.sock")).toBe(false);
		expect(isWindowsNamedPipePath("/home/x/.volt/agent/daemon/voltd.sock")).toBe(false);
	});

	it("ensureDaemonDirs skips the (nonexistent) pipe parent directory", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const paths = { ...getDaemonPaths(agentDir), socketPath: "\\\\.\\pipe\\voltd-regression" };
		expect(() => ensureDaemonDirs(paths)).not.toThrow();
		expect(statSync(paths.daemonDir).isDirectory()).toBe(true);
	});

	win32It("getDaemonSocketPath returns a stable secret-derived pipe path per agent dir", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const socketPath = getDaemonSocketPath(agentDir);
		expect(isWindowsNamedPipePath(socketPath)).toBe(true);
		expect(getDaemonSocketPath(agentDir)).toBe(socketPath);
		expect(getDaemonSocketPath(join(dir, "other-agent"))).not.toBe(socketPath);
	});

	win32It("createDaemonControlSocketPath returns fresh per-instance pipe paths", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const first = createDaemonControlSocketPath(agentDir);
		const second = createDaemonControlSocketPath(agentDir);
		expect(isWindowsNamedPipePath(first)).toBe(true);
		expect(isWindowsNamedPipePath(second)).toBe(true);
		expect(first).not.toBe(second);
	});
});
