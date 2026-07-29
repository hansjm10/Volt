import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectGitOperation, GitContextProvider, parseGitStatusPorcelainV2 } from "../src/core/git-context-provider.ts";
import { discoverGitWorktree, getGitRepositoryDisplayName } from "../src/core/git-repository.ts";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = `${SHA1}0123456789abcdef01234567`;
const originalPath = process.env.PATH;
const tempDirectories: string[] = [];

function tempDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${label}-`));
	tempDirectories.push(directory);
	return directory;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initRepository(label = "git-context"): string {
	const directory = tempDirectory(label);
	git(directory, "init", "--initial-branch=main");
	git(directory, "config", "user.email", "volt@example.invalid");
	git(directory, "config", "user.name", "Volt Test");
	return directory;
}

function commitFile(repository: string, name: string, content: string, message = name): void {
	writeFileSync(join(repository, name), content);
	git(repository, "add", "--", name);
	git(repository, "commit", "-m", message);
}

function createSyntheticWorktree(label = "synthetic-git-context"): string {
	const directory = tempDirectory(label);
	mkdirSync(join(directory, ".git"));
	writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
	return directory;
}

function installFakeGit(script: string): string {
	const binDirectory = tempDirectory("fake-git-bin");
	const executable = join(binDirectory, "git");
	writeFileSync(executable, `#!/bin/sh\n${script}\n`);
	chmodSync(executable, 0o755);
	process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;
	return binDirectory;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	process.env.PATH = originalPath;
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("parseGitStatusPorcelainV2", () => {
	it("counts mixed and overlapping path states without retaining names", () => {
		const output = [
			`# branch.oid ${SHA1}`,
			"# branch.head feature/context",
			"# branch.upstream origin/feature/context",
			"# branch.ab +12 -3",
			`1 A. N... 000000 100644 100644 ${SHA1} ${SHA1} added name`,
			`1 .M N... 100644 100644 100644 ${SHA1} ${SHA1} modified name`,
			`1 MT N... 100644 100644 100644 ${SHA1} ${SHA1} dual state`,
			`2 C. N... 100644 100644 100644 ${SHA1} ${SHA1} C100 copied strange\nname`,
			"source strange name",
			`2 .R N... 100644 100644 100644 ${SHA1} ${SHA1} R100 renamed destination`,
			"renamed source",
			`u UU N... 100644 100644 100644 100644 ${SHA1} ${SHA1} ${SHA1} conflict`,
			"? untracked path",
			"! ignored path",
			"",
		].join("\0");

		const parsed = parseGitStatusPorcelainV2(output);
		expect(parsed).toEqual({
			head: { kind: "branch", name: "feature/context", oid: SHA1 },
			upstream: { ref: "origin/feature/context", ahead: 12, behind: 3 },
			status: {
				staged: { added: 2, modified: 1, deleted: 0, renamed: 0 },
				unstaged: { added: 0, modified: 2, deleted: 0, renamed: 1 },
				untracked: 1,
				conflicted: 1,
				total: 7,
				clean: false,
			},
		});
		expect(JSON.stringify(parsed)).not.toContain("strange");
		expect(Object.isFrozen(parsed.status.staged)).toBe(true);
	});

	it("parses detached SHA-256 and unborn HEAD variants", () => {
		expect(parseGitStatusPorcelainV2(`# branch.oid ${SHA256}\0# branch.head (detached)\0`)).toMatchObject({
			head: { kind: "detached", oid: SHA256 },
			upstream: null,
			status: { clean: true, total: 0 },
		});
		expect(parseGitStatusPorcelainV2("# branch.oid (initial)\0# branch.head main\0")).toMatchObject({
			head: { kind: "unborn", name: "main" },
			upstream: null,
			status: { clean: true, total: 0 },
		});
	});
});

describe("Git repository discovery", () => {
	it("discovers linked worktrees and derives the common repository name", () => {
		const repository = initRepository("common-repository");
		commitFile(repository, "tracked.txt", "base\n");
		const worktree = tempDirectory("linked-worktree");
		git(repository, "worktree", "add", "-b", "linked", worktree);

		const location = discoverGitWorktree(worktree);
		expect(location).not.toBeNull();
		expect(location?.gitDir).not.toBe(location?.commonGitDir);
		expect(getGitRepositoryDisplayName(location!)).toBe(basename(repository));
		expect(getGitRepositoryDisplayName(location!, "managed workspace")).toBe("managed workspace");
	});

	it("recognizes reftable metadata and operation marker progress", () => {
		const repository = createSyntheticWorktree("reftable-repository");
		mkdirSync(join(repository, ".git", "reftable"));
		writeFileSync(join(repository, ".git", "reftable", "tables.list"), "0\n");
		const location = discoverGitWorktree(repository)!;
		expect(location.reftableDir).toBe(join(repository, ".git", "reftable"));

		mkdirSync(join(location.gitDir, "rebase-merge"));
		writeFileSync(join(location.gitDir, "rebase-merge", "msgnum"), "2\n");
		writeFileSync(join(location.gitDir, "rebase-merge", "end"), "5\n");
		expect(detectGitOperation(location)).toEqual({ kind: "rebase", step: 2, total: 5 });
		rmSync(join(location.gitDir, "rebase-merge"), { recursive: true });

		for (const [marker, kind] of [
			["MERGE_HEAD", "merge"],
			["CHERRY_PICK_HEAD", "cherry_pick"],
			["REVERT_HEAD", "revert"],
			["BISECT_LOG", "bisect"],
		] as const) {
			writeFileSync(join(location.gitDir, marker), "marker\n");
			expect(detectGitOperation(location)).toEqual({ kind });
			rmSync(join(location.gitDir, marker));
		}
		mkdirSync(join(location.gitDir, "sequencer"));
		writeFileSync(join(location.gitDir, "sequencer", "todo"), "pick something\n");
		expect(detectGitOperation(location)).toEqual({ kind: "sequencer" });
	});
});

describe("GitContextProvider", () => {
	it("returns null for a non-Git cwd and parses an unborn repository", async () => {
		const nonGit = await GitContextProvider.create(tempDirectory("not-git"));
		expect(nonGit.getSnapshot()).toBeNull();
		nonGit.dispose();

		const repository = initRepository("unborn-repository");
		const provider = await GitContextProvider.create(repository);
		expect(provider.getSnapshot()).toMatchObject({
			repository: basename(repository),
			head: { kind: "unborn", name: "main" },
			status: { clean: true, total: 0 },
			stale: false,
			revision: 1,
		});
		provider.dispose();
	});

	it("reports exact real-repository mixed status and excludes ignored files", async () => {
		const repository = initRepository("mixed-repository");
		writeFileSync(join(repository, ".gitignore"), "ignored.log\n");
		writeFileSync(join(repository, "first.txt"), "first\n");
		writeFileSync(join(repository, "dual.txt"), "dual\n");
		git(repository, "add", ".gitignore", "first.txt", "dual.txt");
		git(repository, "commit", "-m", "base");

		writeFileSync(join(repository, "first.txt"), "first changed\n");
		writeFileSync(join(repository, "dual.txt"), "dual staged\n");
		git(repository, "add", "dual.txt");
		writeFileSync(join(repository, "dual.txt"), "dual staged and unstaged\n");
		writeFileSync(join(repository, "added.txt"), "added\n");
		git(repository, "add", "added.txt");
		writeFileSync(join(repository, "untracked.txt"), "untracked\n");
		writeFileSync(join(repository, "ignored.log"), "ignored\n");

		const provider = await GitContextProvider.create(repository);
		expect(provider.getSnapshot()?.status).toEqual({
			staged: { added: 1, modified: 1, deleted: 0, renamed: 0 },
			unstaged: { added: 0, modified: 2, deleted: 0, renamed: 0 },
			untracked: 1,
			conflicted: 0,
			total: 4,
			clean: false,
		});
		provider.dispose();
	});

	it("counts staged renames and conflicts without exposing unusual paths", async () => {
		const repository = initRepository("conflict-repository");
		commitFile(repository, "odd original.txt", "base\n");
		git(repository, "mv", "odd original.txt", "odd destination →.txt");
		let provider = await GitContextProvider.create(repository);
		expect(provider.getSnapshot()?.status.staged.renamed).toBe(1);
		expect(JSON.stringify(provider.getSnapshot())).not.toContain(repository);
		expect(JSON.stringify(provider.getSnapshot())).not.toContain("odd destination");
		provider.dispose();

		git(repository, "reset", "--hard", "HEAD");
		git(repository, "switch", "-c", "side");
		writeFileSync(join(repository, "odd original.txt"), "side\n");
		git(repository, "commit", "-am", "side");
		git(repository, "switch", "main");
		writeFileSync(join(repository, "odd original.txt"), "main\n");
		git(repository, "commit", "-am", "main");
		try {
			git(repository, "merge", "side");
		} catch {
			// Expected content conflict.
		}
		provider = await GitContextProvider.create(repository);
		expect(provider.getSnapshot()?.status).toMatchObject({ conflicted: 1, total: 1, clean: false });
		provider.dispose();
	});

	it("reports detached HEAD and coherent managed-base divergence", async () => {
		const repository = initRepository("base-repository");
		commitFile(repository, "tracked.txt", "root\n", "root");
		git(repository, "branch", "base");
		writeFileSync(join(repository, "tracked.txt"), "main\n");
		git(repository, "commit", "-am", "main");
		git(repository, "switch", "base");
		writeFileSync(join(repository, "tracked.txt"), "base\n");
		git(repository, "commit", "-am", "base");
		git(repository, "switch", "main");

		const provider = await GitContextProvider.create(repository, {
			workspaceName: "managed-workspace",
			baseRef: "base",
		});
		expect(provider.getSnapshot()).toMatchObject({
			repository: "managed-workspace",
			head: { kind: "branch", name: "main" },
			base: { ref: "base", ahead: 1, behind: 1 },
		});
		provider.dispose();

		git(repository, "switch", "--detach");
		const detached = await GitContextProvider.create(repository);
		expect(detached.getSnapshot()?.head).toMatchObject({ kind: "detached" });
		detached.dispose();
	});

	it("deduplicates unchanged scans and emits immutable full replacements", async () => {
		const repository = initRepository("dedupe-repository");
		commitFile(repository, "tracked.txt", "base\n");
		const provider = await GitContextProvider.create(repository);
		const events: Array<ReturnType<GitContextProvider["getSnapshot"]>> = [];
		const unsubscribe = provider.subscribe((snapshot) => events.push(snapshot));
		const original = provider.getSnapshot();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await provider.refresh();
		expect(events).toEqual([]);
		expect(provider.getSnapshot()?.revision).toBe(original?.revision);
		expect(provider.getSnapshot()?.observedAt).not.toBe(original?.observedAt);

		writeFileSync(join(repository, "tracked.txt"), "changed\n");
		await provider.refresh();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ revision: 2, stale: false, status: { clean: false } });
		expect(Object.isFrozen(events[0])).toBe(true);
		unsubscribe();
		provider.dispose();
	});

	it("retains the last good snapshot across failure and recovery", async () => {
		const repository = initRepository("stale-repository");
		commitFile(repository, "tracked.txt", "base\n");
		const provider = await GitContextProvider.create(repository);
		const good = provider.getSnapshot()!;
		const events: Array<ReturnType<GitContextProvider["getSnapshot"]>> = [];
		provider.subscribe((snapshot) => events.push(snapshot));

		installFakeGit("exit 1");
		await provider.refresh();
		expect(provider.getSnapshot()).toMatchObject({
			head: good.head,
			observedAt: good.observedAt,
			stale: true,
			revision: 2,
		});
		process.env.PATH = originalPath;
		await provider.refresh();
		expect(provider.getSnapshot()).toMatchObject({ stale: false, revision: 3 });
		expect(events.map((event) => event?.stale)).toEqual([true, false]);
		provider.dispose();
	});

	it("bounds timeout and output failures", async () => {
		const repository = createSyntheticWorktree("bounded-repository");
		installFakeGit("sleep 2");
		let provider = await GitContextProvider.create(repository, { commandTimeoutMs: 25 });
		expect(provider.getSnapshot()).toBeNull();
		provider.dispose();

		installFakeGit("head -c 2048 /dev/zero");
		provider = await GitContextProvider.create(repository, { maxStdoutBytes: 64 });
		expect(provider.getSnapshot()).toBeNull();
		provider.dispose();
	});

	it("coalesces concurrent refreshes and stops observer polling on disposal", async () => {
		const repository = createSyntheticWorktree("coalesced-repository");
		const countFile = join(tempDirectory("git-count"), "calls");
		installFakeGit(
			`echo call >> ${JSON.stringify(countFile)}\nsleep 0.05\nprintf '# branch.oid ${SHA1}\\0# branch.head main\\0'`,
		);
		const provider = await GitContextProvider.create(repository, { pollIntervalMs: 25 });
		const unsubscribe = provider.subscribe(() => undefined);
		expect((provider as unknown as { watchers: unknown[] }).watchers.length).toBeGreaterThan(0);
		await Promise.all([provider.refresh(), provider.refresh(), provider.refresh()]);
		expect(gitCallCount(countFile)).toBe(2);
		await waitFor(() => {
			try {
				return Number(gitCallCount(countFile)) >= 3;
			} catch {
				return false;
			}
		});
		unsubscribe();
		provider.dispose();
		expect((provider as unknown as { pollTimer: unknown; watchers: unknown[] }).watchers).toEqual([]);
		expect((provider as unknown as { pollTimer: unknown }).pollTimer).toBeNull();
		const countAfterDispose = gitCallCount(countFile);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(gitCallCount(countFile)).toBe(countAfterDispose);
	});

	it("never includes configured remote URLs or absolute worktree paths", async () => {
		const repository = initRepository("private-repository");
		commitFile(repository, "tracked.txt", "base\n");
		git(repository, "remote", "add", "origin", "https://secret.example/token/repository.git");
		const provider = await GitContextProvider.create(repository);
		const serialized = JSON.stringify(provider.getSnapshot());
		expect(serialized).not.toContain(repository);
		expect(serialized).not.toContain("secret.example");
		expect(serialized).not.toContain("https://");
		provider.dispose();

		const unsafeOverride = await GitContextProvider.create(repository, {
			workspaceName: "workspace https://secret.example/token/repository.git",
		});
		expect(JSON.stringify(unsafeOverride.getSnapshot())).not.toContain("secret.example");
		unsafeOverride.dispose();
	});
});

function gitCallCount(path: string): number {
	return Number.parseInt(execFileSync("wc", ["-l", path], { encoding: "utf8" }).trim(), 10);
}
