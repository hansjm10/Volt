import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

const cliPath = resolve(__dirname, "source-cli-runner.mjs");
const CLI_TIMEOUT_MS = 30_000;
const tempDirs: string[] = [];
const managerOwner = createSessionManagerTestOwner();

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-startup-session-name-"));
	tempDirs.push(dir);
	return dir;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
	sessionRef: SessionReference;
}

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

async function readSessionInfoNames(sessionRef: SessionReference): Promise<string[]> {
	const manager = await SessionManager.open(sessionRef);
	return manager
		.getEntries()
		.filter((entry) => entry.type === "session_info")
		.map((entry) => entry.name ?? "");
}

async function runCli(args: string[], dirs: CliDirs): Promise<CliResult> {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd: dirs.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: dirs.agentDir,
			VOLT_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, CLI_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stderr });
		});
	});
}

async function setup(): Promise<CliDirs> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDirPath = join(tempRoot, "project");
	const sessionDir = join(tempRoot, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDirPath, { recursive: true });
	const projectDir = realpathSync(projectDirPath);
	const manager = await SessionManager.create(projectDir, sessionDir, { id: "existing-session" });
	manager.appendMessage({ role: "user", content: "existing session", timestamp: 1 });
	manager.appendCustomMessageEntry("test.persist", "persist existing session", false);
	await manager.flush();
	const sessionRef = manager.getSessionRef();
	if (!sessionRef) throw new Error("expected persisted startup session reference");
	return { agentDir, projectDir, sessionDir, sessionRef };
}

describe("startup session name", () => {
	it("sets --name on the selected session before runtime model validation", async () => {
		const dirs = await setup();
		const result = await runCli(
			[
				"--session-dir",
				dirs.sessionDir,
				"--session",
				dirs.sessionRef.sessionId,
				"--name",
				"  CLI Named Session  ",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			dirs,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(await readSessionInfoNames(dirs.sessionRef)).toEqual(["CLI Named Session"]);
	});

	it("rejects empty --name values without appending session metadata", async () => {
		const dirs = await setup();
		const result = await runCli(
			[
				"--session-dir",
				dirs.sessionDir,
				"--session",
				dirs.sessionRef.sessionId,
				"--name",
				"   ",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			dirs,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain("--name requires a non-empty value");
		expect(await readSessionInfoNames(dirs.sessionRef)).toEqual([]);
	});
});
