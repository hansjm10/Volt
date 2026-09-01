import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "source-cli-runner.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
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
		child.on("error", reject);
		child.on("close", resolvePromise);
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

describe("--session-id read-only commands", () => {
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

describe("--session-id validation", () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});
