import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	getDefaultSessionDir,
	SessionManager,
} from "../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

const cliPath = resolve(__dirname, "source-cli-runner.mjs");
const CLI_TIMEOUT_MS = 50_000;
const TEST_TIMEOUT_MS = 60_000;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tempDirs: string[] = [];
const managerOwner = createSessionManagerTestOwner();

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-session-id-readonly-"));
	tempDirs.push(dir);
	return dir;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

interface CliResult extends CliDirs {
	code: number | null;
	stderr: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => Promise<void> | void,
): Promise<CliResult> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDirPath = join(tempRoot, "project");
	const sessionDir = join(tempRoot, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDirPath, { recursive: true });
	const dirs: CliDirs = { agentDir, projectDir: realpathSync(projectDirPath), sessionDir };
	await setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...resolvedArgs], {
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

		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CLI_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms: ${resolvedArgs.join(" ")}`));
				return;
			}
			resolvePromise(exitCode);
		});
	});

	return { code, stderr, ...dirs };
}

async function hasSessionWithId(result: CliResult, sessionId: string): Promise<boolean> {
	const sessionDir = getDefaultSessionDir(result.projectDir, result.agentDir);
	return (await SessionManager.findForResume(sessionDir, sessionId)) !== undefined;
}

async function writeSession(sessionDir: string, cwd: string, id: string): Promise<void> {
	const manager = await SessionManager.create(cwd, sessionDir, { id });
	await manager.flush();
}

function writeSnapshot(path: string, cwd: string, id: string): void {
	const messageId = "snapshot-message";
	writeFileSync(
		path,
		`${[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
				id,
				timestamp: "2026-09-01T00:00:00.000Z",
				cwd,
			},
			{
				type: "message",
				id: messageId,
				parentId: null,
				ordinal: 1,
				timestamp: "2026-09-01T00:00:01.000Z",
				message: { role: "user", content: "snapshot message", timestamp: Date.parse("2026-09-01T00:00:01.000Z") },
			},
			{
				type: "leaf",
				id: "snapshot-leaf",
				parentId: messageId,
				ordinal: 2,
				timestamp: "2026-09-01T00:00:02.000Z",
				targetId: messageId,
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

async function listSessionIds(sessionDir: string): Promise<string[]> {
	const sessions = await SessionManager.listAll(sessionDir, undefined, { includeMessageFreeDurable: true });
	return sessions.map((session) => session.id);
}

describe("--session-id read-only commands", { timeout: TEST_TIMEOUT_MS }, () => {
	it("does not reserve a session for --help", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(await hasSessionWithId(result, "read-only-help")).toBe(false);
	});

	it("does not reserve a session for --list-models", async () => {
		const result = await runCli(["--session-id", "read-only-models", "--list-models"]);

		expect(result.code).toBe(0);
		expect(await hasSessionWithId(result, "read-only-models")).toBe(false);
	});

	it("rejects an existing fork target session id", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--fork", "source-id", "--session-id", "existing-id", "-p", "hi"],
			async (dirs) => {
				await writeSession(dirs.sessionDir, dirs.projectDir, "source-id");
				await writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session already exists with id 'existing-id'");
	});
});

describe("--fork path session identity", { timeout: TEST_TIMEOUT_MS }, () => {
	it("generates a fresh session id", async () => {
		const snapshotId = "snapshot-session-id";
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--fork",
				join(dirs.projectDir, "snapshot.jsonl"),
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => writeSnapshot(join(dirs.projectDir, "snapshot.jsonl"), dirs.projectDir, snapshotId),
		);

		expect(result.code).toBe(1);
		const sessionIds = await listSessionIds(result.sessionDir);
		expect(sessionIds).toHaveLength(1);
		expect(sessionIds[0]).toMatch(UUID_V7_RE);
		expect(sessionIds[0]).not.toBe(snapshotId);
	});

	it("preserves an explicitly requested session id", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--fork",
				join(dirs.projectDir, "snapshot.jsonl"),
				"--session-id",
				"requested-fork-id",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => writeSnapshot(join(dirs.projectDir, "snapshot.jsonl"), dirs.projectDir, "snapshot-session-id"),
		);

		expect(result.code).toBe(1);
		expect(await listSessionIds(result.sessionDir)).toEqual(["requested-fork-id"]);
	});
});

describe("--session-id validation", { timeout: TEST_TIMEOUT_MS }, () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});
