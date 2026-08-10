import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function installNodeCommandShim(directory: string, command: string, source: string): void {
	const fixture = join(directory, `fake-${command}.mjs`);
	writeFileSync(fixture, source);
	if (process.platform === "win32") {
		writeFileSync(
			join(directory, `${command}.cmd`),
			`@echo off\r\n"${process.execPath}" "${fixture}" %*\r\nexit /b %errorlevel%\r\n`,
		);
		return;
	}
	const executable = join(directory, command);
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
	chmodSync(executable, 0o755);
}

function createSymlinkFixture(repository: string, path: string, target: string): void {
	try {
		symlinkSync(target, join(repository, path));
		return;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (process.platform !== "win32" || code !== "EPERM") throw error;
	}
	writeFileSync(join(repository, path), target);
	const oid = git(repository, "hash-object", "-w", "--", path);
	git(repository, "update-index", "--add", "--cacheinfo", `120000,${oid},${path}`);
}

describe("review snapshots", () => {
	const tempDirectories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];
	const initialPath = process.env.PATH;
	const initialGitTrace = process.env.GIT_TRACE;

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (initialPath === undefined) delete process.env.PATH;
		else process.env.PATH = initialPath;
		if (initialGitTrace === undefined) delete process.env.GIT_TRACE;
		else process.env.GIT_TRACE = initialGitTrace;
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

	async function resolve(
		target: Parameters<typeof resolveReviewSnapshot>[0],
		cwd: string,
		limits?: NonNullable<Parameters<typeof resolveReviewSnapshot>[2]["limits"]>,
	): Promise<ReviewSnapshot> {
		const result = await resolveReviewSnapshot(target, cwd, { ...OPTIONS, ...(limits ? { limits } : {}) });
		if ("error" in result) throw new Error(result.error);
		snapshots.push(result);
		return result;
	}

	async function readAvailableFile(snapshot: ReviewSnapshot, revision: "base" | "head", path: string) {
		const file = await snapshot.readFile(revision, path);
		if (!file || !file.available) throw new Error(`Expected ${path} to be available`);
		return file;
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
		git(repository, "add", "script.sh");
		git(repository, "update-index", "--chmod=+x", "--", "script.sh");
		createSymlinkFixture(repository, "link.txt", "tracked.txt");
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
		expect((await readAvailableFile(snapshot, "head", "untracked.txt")).content.toString()).toBe("untracked\n");
		expect((await readAvailableFile(snapshot, "head", "script.sh")).entry.mode).toBe("100755");
		expect((await readAvailableFile(snapshot, "head", "link.txt")).entry.mode).toBe("120000");

		writeFileSync(join(repository, "untracked.txt"), "mutated later\n");
		expect((await readAvailableFile(snapshot, "head", "untracked.txt")).content.toString()).toBe("untracked\n");
		expect(snapshot.identity.headTree).toBe(originalTree);

		const checkout = await snapshot.materializeHead();
		expect(readFileSync(join(checkout, "tracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("after\n");
		expect(readFileSync(join(checkout, "untracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("untracked\n");
	});

	it.runIf(process.platform === "win32")(
		"ignores untracked NUL device paths while capturing unrelated changes",
		async () => {
			const repository = createRepository();
			writeFileSync(join(repository, "NUL"), "discarded shell output\n");
			writeFileSync(join(repository, "other.txt"), "uncommitted\n");

			const snapshot = await resolve({ kind: "uncommitted" }, repository);
			expect(snapshot.changedFiles.map(({ path, status }) => ({ path, status }))).toEqual([
				{ path: "other.txt", status: "added" },
			]);
			expect((await readAvailableFile(snapshot, "head", "other.txt")).content.toString()).toBe("uncommitted\n");
			expect(readFileSync(join(repository, "NUL"), "utf8")).toBe("discarded shell output\n");
		},
	);

	it.runIf(process.platform === "win32")(
		"captures unrelated changes when the index contains case-only aliases",
		async () => {
			const repository = createRepository(false);
			const upperPath = "HHHC_Shared/PDFVerification/BasePdfVerification.cs";
			const lowerPath = "HHHC_Shared/PdfVerification/BasePdfVerification.cs";
			mkdirSync(join(repository, "HHHC_Shared", "PDFVerification"), { recursive: true });
			writeFileSync(join(repository, upperPath), "fixture\n");
			const oid = git(repository, "hash-object", "-w", "--", upperPath);
			git(repository, "config", "core.ignorecase", "false");
			git(repository, "update-index", "--add", "--cacheinfo", `100644,${oid},${upperPath}`);
			git(repository, "update-index", "--add", "--cacheinfo", `100644,${oid},${lowerPath}`);
			git(repository, "commit", "-m", "add case aliases");
			git(repository, "config", "core.ignorecase", "true");
			writeFileSync(join(repository, "other.txt"), "uncommitted\n");

			const snapshot = await resolve({ kind: "uncommitted" }, repository);
			expect(snapshot.changedFiles.map(({ path, status }) => ({ path, status }))).toEqual([
				{ path: "other.txt", status: "added" },
			]);
			expect((await readAvailableFile(snapshot, "head", upperPath)).content.toString()).toBe("fixture\n");
			expect((await readAvailableFile(snapshot, "head", lowerPath)).content.toString()).toBe("fixture\n");
		},
	);

	it("preserves ignored tracked files in uncommitted snapshots", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "tracked.log"), "tracked\n");
		git(repository, "add", "tracked.log");
		git(repository, "commit", "-m", "add tracked log");
		writeFileSync(join(repository, ".gitignore"), "*.log\n");
		git(repository, "add", ".gitignore");
		git(repository, "commit", "-m", "ignore log files");
		writeFileSync(join(repository, "visible.txt"), "visible\n");

		const snapshot = await resolve({ kind: "uncommitted" }, repository);
		expect(snapshot.changedFiles.map(({ path, status }) => ({ path, status }))).toEqual([
			{ path: "visible.txt", status: "added" },
		]);
		expect((await readAvailableFile(snapshot, "head", "tracked.log")).content.toString()).toBe("tracked\n");
	});

	it("preserves sparse tracked files and staged excluded deletions", async () => {
		const repository = createRepository();
		mkdirSync(join(repository, "included"));
		mkdirSync(join(repository, "excluded"));
		writeFileSync(join(repository, "included", "kept.txt"), "kept\n");
		writeFileSync(join(repository, "excluded", "unchanged.txt"), "unchanged\n");
		writeFileSync(join(repository, "excluded", "staged-delete.txt"), "delete\n");
		git(repository, "add", "included", "excluded");
		git(repository, "commit", "-m", "add sparse fixtures");
		rmSync(join(repository, "excluded", "staged-delete.txt"));
		git(repository, "add", "--", "excluded/staged-delete.txt");
		git(repository, "sparse-checkout", "init", "--cone");
		git(repository, "sparse-checkout", "set", "included");
		expect(existsSync(join(repository, "excluded", "unchanged.txt"))).toBe(false);
		writeFileSync(join(repository, "included", "visible.txt"), "visible\n");

		const snapshot = await resolve({ kind: "uncommitted" }, repository);
		expect(
			snapshot.changedFiles
				.map(({ path, status }) => ({ path, status }))
				.sort((left, right) => left.path.localeCompare(right.path)),
		).toEqual([
			{ path: "excluded/staged-delete.txt", status: "deleted" },
			{ path: "included/visible.txt", status: "added" },
		]);
		expect((await readAvailableFile(snapshot, "head", "excluded/unchanged.txt")).content.toString()).toBe(
			"unchanged\n",
		);
		expect(await snapshot.readFile("head", "excluded/staged-delete.txt")).toBeUndefined();
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

	it("classifies incompressible binary content without requesting a binary patch", async () => {
		const repository = createRepository();
		const binary = randomBytes(256 * 1024);
		binary[0] = 0;
		writeFileSync(join(repository, "binary.dat"), binary);
		const traceDirectory = join(tmpdir(), `volt-review-git-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(traceDirectory);
		tempDirectories.push(traceDirectory);
		const log = join(traceDirectory, "commands.log");
		process.env.GIT_TRACE = log;

		const snapshot = await resolve({ kind: "uncommitted" }, repository, { maxPatchBytes: 128 });
		expect(snapshot.changedFiles.find((file) => file.path === "binary.dat")).toMatchObject({
			binary: true,
			reviewable: false,
			hunks: [],
			unsupportedReason: "Binary content has no reviewable text hunks.",
		});
		const commands = readFileSync(log, "utf8");
		expect(commands).not.toContain("--binary");
		expect(commands).not.toMatch(/diff .* -- binary\.dat/);
	});

	it("rejects over-limit per-file patches without retaining partial hunks", async () => {
		const repository = createRepository();
		writeFileSync(
			join(repository, "large.txt"),
			Array.from({ length: 40 }, (_, index) => `old-${index}-${"a".repeat(20)}`).join("\n") + "\n",
		);
		git(repository, "add", "large.txt");
		git(repository, "commit", "-m", "add large text");
		writeFileSync(
			join(repository, "large.txt"),
			Array.from({ length: 40 }, (_, index) => `new-${index}-${"b".repeat(20)}`).join("\n") + "\n",
		);

		const snapshot = await resolve({ kind: "uncommitted" }, repository, { maxPatchBytes: 256 });
		expect(snapshot.changedFiles.find((file) => file.path === "large.txt")).toMatchObject({
			binary: false,
			reviewable: false,
			hunks: [],
			unsupportedReason: "Text patch exceeds the 256 bytes per-file review limit.",
		});
	});

	it("rejects aggregate patch exhaustion without retaining the over-budget file", async () => {
		const repository = createRepository();
		for (const path of ["a.txt", "b.txt"]) {
			writeFileSync(
				join(repository, path),
				Array.from({ length: 10 }, (_, index) => `old-${index}-${"a".repeat(10)}`).join("\n") + "\n",
			);
		}
		git(repository, "add", "a.txt", "b.txt");
		git(repository, "commit", "-m", "add aggregate fixtures");
		for (const path of ["a.txt", "b.txt"]) {
			writeFileSync(
				join(repository, path),
				Array.from({ length: 10 }, (_, index) => `new-${index}-${"b".repeat(10)}`).join("\n") + "\n",
			);
		}

		const snapshot = await resolve({ kind: "uncommitted" }, repository, {
			maxPatchBytes: 2_048,
			maxRetainedPatchBytes: 600,
		});
		const fixtures = snapshot.changedFiles.filter((file) => file.path === "a.txt" || file.path === "b.txt");
		expect(fixtures.filter((file) => file.reviewable)).toHaveLength(1);
		expect(fixtures.filter((file) => !file.reviewable)).toMatchObject([
			{
				hunks: [],
				unsupportedReason: "Text patch exceeds the 600 bytes aggregate review budget.",
			},
		]);
	});

	it("preserves ordinary text, rename, and binary classifications with stable hunk ids", async () => {
		const repository = createRepository();
		const renameLines = Array.from({ length: 40 }, (_, index) => `rename line ${index}`);
		writeFileSync(join(repository, "old-name.txt"), `${renameLines.join("\n")}\n`);
		writeFileSync(join(repository, "existing.bin"), Buffer.from([0, 1, 2, 3]));
		git(repository, "add", "old-name.txt", "existing.bin");
		git(repository, "commit", "-m", "add rename and binary fixtures");
		writeFileSync(join(repository, "tracked.txt"), "ordinary text change\n");
		git(repository, "mv", "old-name.txt", "new-name.txt");
		renameLines[20] = "renamed and changed";
		writeFileSync(join(repository, "new-name.txt"), `${renameLines.join("\n")}\n`);
		writeFileSync(join(repository, "existing.bin"), Buffer.from([0, 4, 5, 6]));

		const first = await resolve({ kind: "uncommitted" }, repository);
		const second = await resolve({ kind: "uncommitted" }, repository);
		expect(first.changedFiles.find((file) => file.path === "tracked.txt")).toMatchObject({
			status: "modified",
			binary: false,
			reviewable: true,
		});
		expect(first.changedFiles.find((file) => file.path === "new-name.txt")).toMatchObject({
			status: "renamed",
			previousPath: "old-name.txt",
			binary: false,
			reviewable: true,
		});
		expect(first.changedFiles.find((file) => file.path === "existing.bin")).toMatchObject({
			binary: true,
			reviewable: false,
			unsupportedReason: "Binary content has no reviewable text hunks.",
		});
		expect(first.changedFiles.map((file) => [file.path, file.hunks.map((hunk) => hunk.id)])).toEqual(
			second.changedFiles.map((file) => [file.path, file.hunks.map((hunk) => hunk.id)]),
		);
	});

	it("rejects oversized on-demand blobs before invoking cat-file", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "large-context.txt"), "x".repeat(256));
		git(repository, "add", "large-context.txt");
		git(repository, "commit", "-m", "add large context");
		writeFileSync(join(repository, "tracked.txt"), "after\n");
		const traceDirectory = join(tmpdir(), `volt-review-cat-log-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(traceDirectory);
		tempDirectories.push(traceDirectory);
		const log = join(traceDirectory, "commands.log");
		process.env.GIT_TRACE = log;

		const snapshot = await resolve({ kind: "uncommitted" }, repository, { maxBlobBytes: 64 });
		const file = await snapshot.readFile("head", "large-context.txt");
		expect(file).toMatchObject({
			available: false,
			reason: "oversized",
			entry: { path: "large-context.txt", size: 256 },
			message: expect.stringContaining("64 bytes"),
		});
		if (!file) throw new Error("Expected an unavailable file result");
		expect(readFileSync(log, "utf8")).not.toContain(`cat-file blob ${file.entry.oid}`);
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
		expect(
			snapshot.changedFiles
				.flatMap((file) => file.hunks)
				.map((hunk) => hunk.patch)
				.join("\n"),
		).toContain("+feature");

		git(repository, "checkout", "main");
		expect((await readAvailableFile(snapshot, "head", "tracked.txt")).content.toString()).toBe("feature\n");
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
		expect(
			mergeSnapshot.changedFiles
				.flatMap((file) => file.hunks)
				.map((hunk) => hunk.patch)
				.join("\n"),
		).toContain("+feature");
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
		const ghOutput = join(bin, "gh-output.json");
		writeFileSync(
			ghOutput,
			`${JSON.stringify({ number: 7, title: "Snapshot", body: "Body", baseRefName: "main", headRefName: "feature", url: "https://example.test/pr/7", baseRefOid: baseOid, headRefOid: headOid })}\n`,
		);
		installNodeCommandShim(
			bin,
			"gh",
			`import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(ghOutput)}, "utf8"));\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const snapshot = await resolve({ kind: "pr", number: "7" }, repository);
		expect(snapshot.identity.pullRequest).toMatchObject({ number: 7, baseRefOid: baseOid, headRefOid: headOid });
		expect(
			snapshot.changedFiles
				.flatMap((file) => file.hunks)
				.map((hunk) => hunk.patch)
				.join("\n"),
		).toContain("+pull request");

		writeFileSync(ghOutput, readFileSync(ghOutput, "utf8").replace(headOid, baseOid));
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
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Unable to locate git executable");
		const bin = join(repository, "unstable-bin");
		mkdirSync(bin);
		installNodeCommandShim(
			bin,
			"git",
			`import { appendFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "status") appendFileSync(${JSON.stringify(join(repository, "unstable.txt"))}, "change\\n");\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exitCode = result.status ?? 1;\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const result = await resolveReviewSnapshot({ kind: "uncommitted" }, repository, OPTIONS);
		expect(result).toMatchObject({
			error: "Working tree changed while Volt captured the review snapshot. Retry the review.",
		});
	});

	it("returns a distinct error when bounded metadata output is exceeded", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "tracked.txt"), "after\n");
		const result = await resolveReviewSnapshot({ kind: "uncommitted" }, repository, {
			...OPTIONS,
			limits: { maxMetadataBytes: 8 },
		});
		expect(result).toMatchObject({ error: expect.stringMatching(/stdout exceeded the 8 bytes capture limit/i) });
	});

	it("rejects unsafe repository paths", () => {
		expect(() => normalizeReviewPath("../secret")).toThrow(/traverse/);
		expect(() => normalizeReviewPath("/absolute")).toThrow(/relative/);
		expect(() => normalizeReviewPath("a//b")).toThrow(/traverse/);
		expect(normalizeReviewPath("./src/file.ts")).toBe("src/file.ts");
	});
});
