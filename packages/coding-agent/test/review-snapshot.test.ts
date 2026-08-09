import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeReviewPath, type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";

const OPTIONS = { maxCommitRefBytes: 1_024, maxPullRequestNumber: 2_147_483_647 };

function run(cwd: string, command: string, ...args: string[]): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
	return run(cwd, "git", ...args);
}

describe("review snapshots", () => {
	const tempDirectories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];
	const initialPath = process.env.PATH;

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (initialPath === undefined) delete process.env.PATH;
		else process.env.PATH = initialPath;
	});

	function createRepository(withCommit = true): string {
		const directory = join(
			tmpdir(),
			`volt-review-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(directory, { recursive: true });
		tempDirectories.push(directory);
		git(directory, "init", "--initial-branch=main");
		git(directory, "config", "user.email", "review@example.com");
		git(directory, "config", "user.name", "Review Test");
		git(directory, "config", "commit.gpgsign", "false");
		if (withCommit) {
			writeFileSync(join(directory, "tracked.txt"), "before\n");
			git(directory, "add", "tracked.txt");
			git(directory, "commit", "-m", "initial");
		}
		return directory;
	}

	async function resolve(target: Parameters<typeof resolveReviewSnapshot>[0], cwd: string): Promise<ReviewSnapshot> {
		const result = await resolveReviewSnapshot(target, cwd, OPTIONS);
		if ("error" in result) throw new Error(result.error);
		snapshots.push(result);
		return result;
	}

	it("captures staged, unstaged, untracked, deleted, binary, executable, and symlink state immutably", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "deleted.txt"), "delete me\n");
		git(repository, "add", "deleted.txt");
		git(repository, "commit", "-m", "add deleted fixture");
		writeFileSync(join(repository, "tracked.txt"), "after\n");
		writeFileSync(join(repository, "staged.txt"), "staged\n");
		git(repository, "add", "staged.txt");
		writeFileSync(join(repository, "untracked.txt"), "untracked\n");
		writeFileSync(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		writeFileSync(join(repository, "script.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
		symlinkSync("tracked.txt", join(repository, "link.txt"));
		rmSync(join(repository, "deleted.txt"));

		const snapshot = await resolve({ kind: "uncommitted" }, repository);
		const originalTree = snapshot.identity.headTree;
		expect(snapshot.changedFiles.map((file) => file.path).sort()).toEqual([
			"binary.dat",
			"deleted.txt",
			"link.txt",
			"script.sh",
			"staged.txt",
			"tracked.txt",
			"untracked.txt",
		]);
		expect(snapshot.changedFiles.find((file) => file.path === "deleted.txt")).toMatchObject({ status: "deleted" });
		expect(snapshot.changedFiles.find((file) => file.path === "binary.dat")).toMatchObject({
			binary: true,
			reviewable: false,
		});
		expect((await snapshot.readFile("head", "untracked.txt"))?.content.toString()).toBe("untracked\n");
		expect((await snapshot.readFile("head", "script.sh"))?.entry.mode).toBe("100755");
		expect((await snapshot.readFile("head", "link.txt"))?.entry.mode).toBe("120000");

		writeFileSync(join(repository, "untracked.txt"), "mutated later\n");
		expect((await snapshot.readFile("head", "untracked.txt"))?.content.toString()).toBe("untracked\n");
		expect(snapshot.identity.headTree).toBe(originalTree);

		const checkout = await snapshot.materializeHead();
		expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("after\n");
		expect(readFileSync(join(checkout, "untracked.txt"), "utf8")).toBe("untracked\n");
	});

	it("tracks changed source lines that resemble diff file headers", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "tracked.txt"), "prefix\n--old marker\nold tail\nsuffix\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "add diff marker fixture");
		writeFileSync(join(repository, "tracked.txt"), "prefix\n++new marker\nnew tail\nsuffix\n");

		const snapshot = await resolve({ kind: "uncommitted" }, repository);
		const hunk = snapshot.changedFiles.find((file) => file.path === "tracked.txt")?.hunks[0];
		expect(hunk).toMatchObject({
			baseChangedLines: [{ startLine: 2, endLine: 3 }],
			headChangedLines: [{ startLine: 2, endLine: 3 }],
		});
	});

	it("uses merge-base and captured HEAD identities for branch reviews", async () => {
		const repository = createRepository();
		git(repository, "checkout", "-b", "feature");
		writeFileSync(join(repository, "tracked.txt"), "feature\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "feature");
		const expectedHead = git(repository, "rev-parse", "HEAD");
		const expectedMergeBase = git(repository, "merge-base", "main", "HEAD");

		const snapshot = await resolve({ kind: "branch", base: "main" }, repository);
		expect(snapshot.identity).toMatchObject({
			kind: "branch",
			headCommit: expectedHead,
			mergeBaseCommit: expectedMergeBase,
		});
		expect(snapshot.diff).toContain("+feature");

		git(repository, "checkout", "main");
		expect((await snapshot.readFile("head", "tracked.txt"))?.content.toString()).toBe("feature\n");
	});

	it("reviews root commits against an empty tree and merge commits against first parent", async () => {
		const rootRepository = createRepository(false);
		writeFileSync(join(rootRepository, "root.txt"), "root\n");
		git(rootRepository, "add", "root.txt");
		git(rootRepository, "commit", "-m", "root");
		const rootSnapshot = await resolve({ kind: "commit", sha: "HEAD" }, rootRepository);
		expect(rootSnapshot.changedFiles[0]).toMatchObject({ path: "root.txt", status: "added" });

		const mergeRepository = createRepository();
		git(mergeRepository, "checkout", "-b", "feature");
		writeFileSync(join(mergeRepository, "feature.txt"), "feature\n");
		git(mergeRepository, "add", "feature.txt");
		git(mergeRepository, "commit", "-m", "feature");
		git(mergeRepository, "checkout", "main");
		git(mergeRepository, "merge", "--no-ff", "feature", "-m", "merge");
		const mergeParent = git(mergeRepository, "rev-parse", "HEAD^1");
		const mergeSnapshot = await resolve({ kind: "commit", sha: "HEAD" }, mergeRepository);
		expect(mergeSnapshot.identity.baseCommit).toBe(mergeParent);
		expect(mergeSnapshot.diff).toContain("+feature");
	});

	it("verifies fetched pull request base and head OIDs and rejects moved metadata", async () => {
		const repository = createRepository();
		const remote = join(tmpdir(), `volt-review-snapshot-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(remote, { recursive: true });
		tempDirectories.push(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(repository, "remote", "add", "origin", remote);
		git(repository, "push", "origin", "main");
		git(repository, "checkout", "-b", "feature");
		writeFileSync(join(repository, "tracked.txt"), "pull request\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "pull request");
		git(repository, "push", "origin", "HEAD:refs/pull/7/head");
		const baseOid = git(repository, "rev-parse", "main");
		const headOid = git(repository, "rev-parse", "HEAD");

		const bin = join(repository, "bin");
		mkdirSync(bin);
		const gh = join(bin, "gh");
		writeFileSync(
			gh,
			`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ number: 7, title: "Snapshot", body: "Body", baseRefName: "main", headRefName: "feature", url: "https://example.test/pr/7", baseRefOid: baseOid, headRefOid: headOid })}'\n`,
		);
		chmodSync(gh, 0o755);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const snapshot = await resolve({ kind: "pr", number: "7" }, repository);
		expect(snapshot.identity.pullRequest).toMatchObject({ number: 7, baseRefOid: baseOid, headRefOid: headOid });
		expect(snapshot.diff).toContain("+pull request");

		writeFileSync(gh, readFileSync(gh, "utf8").replace(headOid, baseOid));
		const moved = await resolveReviewSnapshot({ kind: "pr", number: "7" }, repository, OPTIONS);
		expect(moved).toMatchObject({ error: "The pull request moved while Volt captured it. Retry the review." });
	});

	it("classifies submodule entries as unsupported", async () => {
		const dependency = createRepository();
		const repository = createRepository();
		git(repository, "-c", "protocol.file.allow=always", "submodule", "add", dependency, "vendor/dependency");
		git(repository, "commit", "-am", "add dependency");

		const snapshot = await resolve({ kind: "commit", sha: "HEAD" }, repository);
		expect(snapshot.changedFiles.find((file) => file.path === "vendor/dependency")).toMatchObject({
			reviewable: false,
			unsupportedReason: "Submodule changes require review in the submodule repository.",
			head: { type: "commit", mode: "160000" },
		});
	});

	it("fails closed when uncommitted state changes throughout capture", async () => {
		const repository = createRepository();
		const realGit = run(repository, "which", "git");
		const bin = join(repository, "unstable-bin");
		mkdirSync(bin);
		const wrapper = join(bin, "git");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nif [ "$1" = "status" ]; then printf 'change\\n' >> '${join(repository, "unstable.txt")}'; fi\nexec '${realGit}' "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const result = await resolveReviewSnapshot({ kind: "uncommitted" }, repository, OPTIONS);
		expect(result).toMatchObject({
			error: "Working tree changed while Volt captured the review snapshot. Retry the review.",
		});
	});

	it("rejects unsafe repository paths", () => {
		expect(() => normalizeReviewPath("../secret")).toThrow(/traverse/);
		expect(() => normalizeReviewPath("/absolute")).toThrow(/relative/);
		expect(() => normalizeReviewPath("a//b")).toThrow(/traverse/);
		expect(normalizeReviewPath("./src/file.ts")).toBe("src/file.ts");
	});
});
