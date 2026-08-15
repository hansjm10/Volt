import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { isControlRequest, isControlResponse } from "../src/daemon/control-protocol.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { getWorktreesRoot } from "../src/daemon/worktree-manager.ts";
import { main } from "../src/main.ts";

describe("worktree control protocol shapes", () => {
	it("accepts well-formed worktree_* requests and rejects malformed ones", () => {
		expect(isControlRequest({ type: "worktree_create", id: "1", workspaceName: "ws" })).toBe(true);
		expect(
			isControlRequest({
				type: "worktree_create",
				id: "1",
				workspaceName: "ws",
				worktreeName: "fix-login",
				branch: "volt/fix-login",
				baseRef: "main",
			}),
		).toBe(true);
		expect(isControlRequest({ type: "worktree_create", id: "1" })).toBe(false);
		expect(isControlRequest({ type: "worktree_create", id: "1", workspaceName: "ws", branch: 42 })).toBe(false);

		expect(isControlRequest({ type: "worktree_adopt", id: "1", workspaceName: "ws", path: "/tmp/wt" })).toBe(true);
		expect(
			isControlRequest({
				type: "worktree_adopt",
				id: "1",
				workspaceName: "ws",
				path: "/tmp/wt",
				worktreeName: "manual",
				baseRef: "main",
			}),
		).toBe(true);
		expect(isControlRequest({ type: "worktree_adopt", id: "1", workspaceName: "ws" })).toBe(false);
		expect(isControlRequest({ type: "worktree_adopt", id: "1", workspaceName: "ws", path: 42 })).toBe(false);

		expect(isControlRequest({ type: "worktree_list", id: "1" })).toBe(true);
		expect(isControlRequest({ type: "worktree_list", id: "1", workspaceName: "ws" })).toBe(true);
		expect(isControlRequest({ type: "worktree_list", id: "1", workspaceName: 42 })).toBe(false);

		expect(isControlRequest({ type: "worktree_remove", id: "1", workspaceName: "ws", worktreeId: "x" })).toBe(true);
		expect(
			isControlRequest({ type: "worktree_remove", id: "1", workspaceName: "ws", worktreeId: "x", force: true }),
		).toBe(true);
		expect(isControlRequest({ type: "worktree_remove", id: "1", workspaceName: "ws" })).toBe(false);
		expect(
			isControlRequest({ type: "worktree_remove", id: "1", workspaceName: "ws", worktreeId: "x", force: "yes" }),
		).toBe(false);

		expect(isControlRequest({ type: "worktree_prune", id: "1" })).toBe(true);
		expect(isControlRequest({ type: "worktree_prune", id: "1", workspaceName: "ws" })).toBe(true);
	});

	it("accepts well-formed worktree_* responses", () => {
		expect(isControlResponse({ type: "worktree_result", id: "1", worktree: { id: "x" } })).toBe(true);
		expect(isControlResponse({ type: "worktree_result", id: "1", worktree: "x" })).toBe(false);
		expect(isControlResponse({ type: "worktrees_result", id: "1", worktrees: [] })).toBe(true);
		expect(isControlResponse({ type: "worktrees_result", id: "1", worktrees: {} })).toBe(false);
		expect(isControlResponse({ type: "worktree_prune_result", id: "1", results: [] })).toBe(true);
	});
});

/**
 * `volt remote worktree *` drives the daemon skeleton over the control socket
 * (fallback worktree manager, no iroh endpoint) against a real git repo,
 * mirroring remote-cli.test.ts.
 */
describe("remote CLI worktree commands (daemon control client)", () => {
	let agentDir: string;
	let workspaceDir: string;
	let daemon: Promise<number> | undefined;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-remote-worktree-")));
		workspaceDir = join(agentDir, "repo");
		mkdirSync(workspaceDir, { recursive: true });
		const git = (args: string[], cwd: string = workspaceDir) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		git(["init", "--initial-branch=main"]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "Test"]);
		writeFileSync(join(workspaceDir, "readme.md"), "hello\n");
		git(["add", "readme.md"]);
		git(["commit", "-m", "init"]);

		daemon = runVoltDaemon({ agentDir, foreground: false });
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);

		process.env[ENV_AGENT_DIR] = agentDir;
		await main(["remote", "workspace", "add", workspaceDir, "--name", "repo"]);
		delete process.env[ENV_AGENT_DIR];
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

	it("adds, lists, removes, and prunes worktrees end-to-end", async () => {
		await main(["remote", "worktree", "add", "--workspace", "repo", "--name", "fix-login", "--base", "main"]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(loggedLines(errorSpy)).toContain("created worktree fix-login (branch volt/fix-login)");

		// The checkout lands under the daemon-managed worktrees root.
		const worktreesRoot = getWorktreesRoot(agentDir);
		logSpy.mockClear();
		await main(["remote", "worktree", "list", "--workspace", "repo", "--json"]);
		const listed = JSON.parse(loggedLines(logSpy)) as Array<{
			id: string;
			workspaceName: string;
			path: string;
			branch: string;
			available?: boolean;
			dirty?: boolean;
		}>;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: "fix-login",
			workspaceName: "repo",
			branch: "volt/fix-login",
			available: true,
			dirty: false,
		});
		// Control-socket responses MAY carry paths (trusted local plane).
		expect(listed[0]?.path.startsWith(worktreesRoot)).toBe(true);
		expect(existsSync(listed[0]?.path ?? "")).toBe(true);

		// Duplicate id is a clean error, not a second checkout.
		process.exitCode = undefined;
		await main(["remote", "worktree", "add", "--workspace", "repo", "--name", "fix-login"]);
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		await main(["remote", "worktree", "remove", "fix-login", "--workspace", "repo"]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(loggedLines(errorSpy)).toContain("removed worktree fix-login");
		expect(existsSync(listed[0]?.path ?? "")).toBe(false);

		logSpy.mockClear();
		await main(["remote", "worktree", "list", "--workspace", "repo", "--json"]);
		expect(JSON.parse(loggedLines(logSpy))).toEqual([]);

		await main(["remote", "worktree", "prune", "--workspace", "repo"]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(loggedLines(errorSpy)).toContain("repo: removed 0 record(s), quarantined 0 orphan checkout(s)");
	}, 30_000);

	it("adopts a manually-created git worktree", async () => {
		const manualPath = join(agentDir, "manual-existing");
		const git = (args: string[], cwd: string = workspaceDir) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		git(["worktree", "add", manualPath, "-b", "manual-existing", "main"]);

		await main([
			"remote",
			"worktree",
			"adopt",
			manualPath,
			"--workspace",
			"repo",
			"--name",
			"manual-existing",
			"--base",
			"main",
		]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(loggedLines(errorSpy)).toContain("adopted worktree manual-existing (branch manual-existing)");

		logSpy.mockClear();
		await main(["remote", "worktree", "list", "--workspace", "repo", "--json"]);
		const listed = JSON.parse(loggedLines(logSpy)) as Array<{ id: string; path: string; available?: boolean }>;
		const adopted = listed.find((entry) => entry.id === "manual-existing");
		expect(adopted).toMatchObject({ id: "manual-existing", path: realpathSync.native(manualPath), available: true });

		process.exitCode = undefined;
		await main(["remote", "worktree", "remove", "manual-existing", "--workspace", "repo"]);
		expect(process.exitCode ?? 0).toBe(0);
		expect(existsSync(manualPath)).toBe(false);
	}, 30_000);

	it("diff shows the worktree branch against its recorded base and errors on unknown ids", async () => {
		await main(["remote", "worktree", "add", "--workspace", "repo", "--name", "diff-me", "--base", "main"]);
		expect(process.exitCode ?? 0).toBe(0);

		// Committed work in the worktree so the diff is non-empty but the tree is clean.
		logSpy.mockClear();
		await main(["remote", "worktree", "list", "--workspace", "repo", "--json"]);
		const listed = JSON.parse(loggedLines(logSpy)) as Array<{ id: string; path: string; baseRef?: string }>;
		const worktree = listed.find((entry) => entry.id === "diff-me");
		expect(worktree?.baseRef).toBe("main");
		const git = (args: string[], cwd: string) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		writeFileSync(join(worktree?.path ?? "", "feature.txt"), "work\n");
		git(["add", "feature.txt"], worktree?.path ?? "");
		git(["commit", "-m", "feature"], worktree?.path ?? "");

		// The read-only diff run succeeds (output goes to the inherited stdout).
		process.exitCode = undefined;
		await main(["remote", "worktree", "diff", "diff-me", "--workspace", "repo"]);
		expect(process.exitCode ?? 0).toBe(0);

		// aheadBehind reaches the CLI after the commit.
		logSpy.mockClear();
		await main(["remote", "worktree", "list", "--workspace", "repo", "--json"]);
		const relisted = JSON.parse(loggedLines(logSpy)) as Array<{
			id: string;
			aheadBehind?: { ahead: number; behind: number };
		}>;
		expect(relisted.find((entry) => entry.id === "diff-me")?.aheadBehind).toEqual({ ahead: 1, behind: 0 });

		process.exitCode = undefined;
		await main(["remote", "worktree", "diff", "ghost-tree", "--workspace", "repo"]);
		expect(process.exitCode).toBe(1);
		expect(loggedLines(errorSpy)).toContain("no worktree ghost-tree in workspace repo");

		process.exitCode = undefined;
		await main(["remote", "worktree", "remove", "diff-me", "--workspace", "repo", "--force"]);
		expect(process.exitCode ?? 0).toBe(0);
	}, 30_000);

	it("defaults --workspace via the cwd prefix match without auto-registering", async () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(workspaceDir);
			await main(["remote", "worktree", "add", "--name", "cwd-default"]);
			expect(process.exitCode ?? 0).toBe(0);
			expect(loggedLines(errorSpy)).toContain("created worktree cwd-default");
			await main(["remote", "worktree", "remove", "cwd-default"]);
			expect(process.exitCode ?? 0).toBe(0);
		} finally {
			process.chdir(originalCwd);
		}
	}, 30_000);

	it("fails cleanly when the cwd matches no registered workspace", async () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(tmpdir());
			await main(["remote", "worktree", "add", "--name", "nowhere"]);
			expect(process.exitCode).toBe(1);
			expect(loggedLines(errorSpy)).toContain("no registered workspace matches the current directory");
		} finally {
			process.chdir(originalCwd);
		}
	}, 30_000);

	it("reports unknown workspaces and unknown worktree ids as errors", async () => {
		await main(["remote", "worktree", "add", "--workspace", "ghost"]);
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		await main(["remote", "worktree", "remove", "ghost-tree", "--workspace", "repo"]);
		expect(process.exitCode).toBe(1);
	}, 30_000);

	it("documents the worktree command group in the remote usage text", async () => {
		await main(["remote", "worktree", "bogus"]);
		expect(process.exitCode).toBe(1);
		const usage = loggedLines(errorSpy);
		expect(usage).toContain("Unknown worktree command");
		expect(usage).toContain("worktree add [--workspace <name>] [--name <id>] [--branch <ref>] [--base <ref>]");
		expect(usage).toContain("worktree adopt <path> [--workspace <name>] [--name <id>] [--base <ref>]");
		expect(usage).toContain("worktree list [--workspace <name>] [--json]");
		expect(usage).toContain("worktree remove <id> [--workspace <name>] [--force]");
		expect(usage).toContain("worktree prune [--workspace <name>]");
		expect(usage).toContain("worktree diff <id> [--workspace <name>]");
	});
});
