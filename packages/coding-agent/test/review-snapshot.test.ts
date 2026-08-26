import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReviewGitHubContext } from "../src/core/github-pr-context.ts";
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

function processIsAlive(pidPath: string): boolean {
	const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
	if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid process ID in ${pidPath}`);
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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

interface GitHubShimConfig {
	view: Record<string, unknown>;
	finalHeadOid?: string;
	graphql?: Record<string, unknown>;
	maximumGraphqlRequests?: number;
	graphqlGatePath?: string;
}

function graphqlKey(operation: string, id: string, cursor: string | null, manualOnly: boolean | null = null): string {
	return JSON.stringify([operation, id, cursor, manualOnly]);
}

function graphqlConnection(field: string, nodes: unknown[], hasNextPage = false, endCursor?: string): object {
	return {
		data: {
			node: {
				[field]: {
					nodes,
					pageInfo: { hasNextPage, endCursor: endCursor ?? null },
				},
			},
		},
	};
}

function installGitHubShim(directory: string, config: GitHubShimConfig): string {
	const bin = join(directory, "bin");
	mkdirSync(bin, { recursive: true });
	const configPath = join(bin, "gh-config.json");
	const logPath = join(bin, "gh-requests.jsonl");
	writeFileSync(configPath, JSON.stringify(config));
	installNodeCommandShim(
		bin,
		"gh",
		`import { appendFileSync, existsSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1];
  process.stdout.write(JSON.stringify(fields === "headRefOid" ? { headRefOid: config.finalHeadOid ?? config.view.headRefOid } : config.view));
} else if (args[0] === "api" && args[1] === "graphql") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const operation = /query\\s+(Volt\\w+)/.exec(request.query)?.[1];
  const variables = request.variables ?? {};
  const key = JSON.stringify([operation, variables.id, variables.cursor ?? null, variables.manualOnly ?? null]);
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ operation, variables }) + "\\n");
  const initialOperations = new Set(["VoltReviewLinkedIssues", "VoltReviewPullRequestComments", "VoltReviewPullRequestReviews", "VoltReviewThreads"]);
  if (config.graphqlGatePath && variables.cursor == null && initialOperations.has(operation)) {
    while (!existsSync(config.graphqlGatePath)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const requestCount = readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").length;
  if (config.maximumGraphqlRequests !== undefined && requestCount > config.maximumGraphqlRequests) {
    process.stderr.write("GraphQL request limit exceeded");
    process.exitCode = 1;
  } else {
    const configured = config.graphql?.[key];
    if (configured) process.stdout.write(JSON.stringify(configured));
    else {
      const fields = {
        VoltReviewLinkedIssues: "closingIssuesReferences",
        VoltReviewPullRequestComments: "comments",
        VoltReviewPullRequestReviews: "reviews",
        VoltReviewThreads: "reviewThreads",
        VoltReviewThreadComments: "comments",
        VoltReviewIssueComments: "comments"
      };
      const field = fields[operation];
      process.stdout.write(JSON.stringify({ data: { node: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    }
  }
} else process.exitCode = 1;
`,
	);
	return logPath;
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

	function createStaleBranchFixture(remoteName: string): {
		repository: string;
		remote: string;
		staleBase: string;
		authoritativeBase: string;
		headCommit: string;
	} {
		const repository = createRepository();
		const remote = join(tmpdir(), `volt-review-branch-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(remote, { recursive: true });
		tempDirectories.push(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(repository, "remote", "add", remoteName, remote);
		git(repository, "push", "-u", remoteName, "main");
		if (remoteName === "origin") git(repository, "remote", "set-head", "origin", "main");
		const staleBase = git(repository, "rev-parse", "main");

		writeFileSync(join(repository, "upstream.txt"), "already merged upstream\n");
		git(repository, "add", "upstream.txt");
		git(repository, "commit", "-m", "upstream change");
		const authoritativeBase = git(repository, "rev-parse", "HEAD");
		git(repository, "push", remoteName, "main");

		git(repository, "checkout", "-b", "feature");
		writeFileSync(join(repository, "feature.txt"), "feature only\n");
		git(repository, "add", "feature.txt");
		git(repository, "commit", "-m", "feature change");
		const headCommit = git(repository, "rev-parse", "HEAD");
		git(repository, "branch", "-f", "main", staleBase);
		git(repository, "update-ref", `refs/remotes/${remoteName}/main`, staleBase);
		rmSync(join(repository, ".git", "FETCH_HEAD"), { force: true });
		return { repository, remote, staleBase, authoritativeBase, headCommit };
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

	it("refreshes short branch bases without changing stale workspace refs", async () => {
		const { repository, staleBase, authoritativeBase, headCommit } = createStaleBranchFixture("origin");
		for (const target of [
			{ kind: "branch" as const, base: "main" },
			{ kind: "branch" as const, base: "origin/main" },
			{ kind: "branch" as const },
		]) {
			const snapshot = await resolve(target, repository);
			expect(snapshot.description).toBe("branch changes vs origin/main");
			expect(snapshot.identity).toMatchObject({
				baseCommit: authoritativeBase,
				mergeBaseCommit: authoritativeBase,
				headCommit,
			});
			expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["feature.txt"]);
		}

		for (const base of ["refs/heads/main", "refs/remotes/origin/main"]) {
			const snapshot = await resolve({ kind: "branch", base }, repository);
			expect(snapshot.description).toBe(`branch changes vs ${base}`);
			expect(snapshot.identity.baseCommit).toBe(staleBase);
			expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["feature.txt", "upstream.txt"]);
		}

		expect(git(repository, "rev-parse", "main")).toBe(staleBase);
		expect(git(repository, "rev-parse", "origin/main")).toBe(staleBase);
		expect(git(repository, "rev-parse", "HEAD")).toBe(headCommit);
		expect(existsSync(join(repository, ".git", "FETCH_HEAD"))).toBe(false);
	});

	it("resolves relative filesystem URLs before refreshing branch bases", async () => {
		const { repository, remote, staleBase, authoritativeBase } = createStaleBranchFixture("origin");
		const relativeRemote = relative(repository, remote);
		git(repository, "remote", "set-url", "origin", relativeRemote);

		const snapshot = await resolve({ kind: "branch", base: "main" }, repository);
		expect(snapshot.identity).toMatchObject({
			baseCommit: authoritativeBase,
			mergeBaseCommit: authoritativeBase,
		});
		expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["feature.txt"]);
		expect(git(repository, "remote", "get-url", "origin")).toBe(relativeRemote);
		expect(git(repository, "rev-parse", "main")).toBe(staleBase);
		expect(git(repository, "rev-parse", "origin/main")).toBe(staleBase);
	});

	it("refreshes a configured non-origin upstream for a plain branch name", async () => {
		const { repository, staleBase, authoritativeBase } = createStaleBranchFixture("upstream");
		const snapshot = await resolve({ kind: "branch", base: "main" }, repository);
		expect(snapshot.description).toBe("branch changes vs upstream/main");
		expect(snapshot.identity).toMatchObject({
			baseCommit: authoritativeBase,
			mergeBaseCommit: authoritativeBase,
		});
		expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["feature.txt"]);
		expect(git(repository, "rev-parse", "main")).toBe(staleBase);
		expect(git(repository, "rev-parse", "upstream/main")).toBe(staleBase);
	});

	it("fails a remote base refresh without falling back and removes the temporary source", async () => {
		const { repository, staleBase } = createStaleBranchFixture("origin");
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Unable to locate git executable");
		const bin = join(repository, "failed-branch-fetch-bin");
		const temporaryDirectoryPath = join(repository, "failed-branch-fetch-directory");
		mkdirSync(bin);
		installNodeCommandShim(
			bin,
			"git",
			`import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "fetch" && process.cwd().includes("volt-review-branch-")) {\n  writeFileSync(${JSON.stringify(temporaryDirectoryPath)}, process.cwd());\n  process.stderr.write("forced branch fetch failure\\n");\n  process.exitCode = 1;\n} else {\n  const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });\n  if (result.error) throw result.error;\n  process.exitCode = result.status ?? 1;\n}\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const result = await resolveReviewSnapshot({ kind: "branch", base: "main" }, repository, OPTIONS);
		expect(result).toMatchObject({
			error: expect.stringContaining("forced branch fetch failure"),
			remoteError: "Could not refresh the review base branch.",
		});
		expect(git(repository, "rev-parse", "main")).toBe(staleBase);
		const temporaryDirectory = readFileSync(temporaryDirectoryPath, "utf8");
		expect(existsSync(temporaryDirectory)).toBe(false);
	});

	it("cancels a remote base fetch and removes the temporary source", async () => {
		const { repository } = createStaleBranchFixture("origin");
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Unable to locate git executable");
		const bin = join(repository, "delayed-branch-fetch-bin");
		const startedPath = join(repository, "delayed-branch-fetch-started");
		const temporaryDirectoryPath = join(repository, "delayed-branch-fetch-directory");
		mkdirSync(bin);
		installNodeCommandShim(
			bin,
			"git",
			`import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "fetch" && process.cwd().includes("volt-review-branch-")) {\n  writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));\n  writeFileSync(${JSON.stringify(temporaryDirectoryPath)}, process.cwd());\n  setInterval(() => {}, 1_000);\n} else {\n  const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });\n  if (result.error) throw result.error;\n  process.exitCode = result.status ?? 1;\n}\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		const controller = new AbortController();
		const resolution = resolveReviewSnapshot({ kind: "branch", base: "main" }, repository, {
			...OPTIONS,
			signal: controller.signal,
		});
		try {
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
			controller.abort();
			await expect(resolution).resolves.toEqual({ error: "Review cancelled.", cancelled: true });
			await vi.waitFor(() => expect(processIsAlive(startedPath)).toBe(false));
			const temporaryDirectory = readFileSync(temporaryDirectoryPath, "utf8");
			expect(existsSync(temporaryDirectory)).toBe(false);
		} finally {
			controller.abort();
		}
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

	it("fetches PR snapshots from relative remotes without borrowing from shallow repositories", async () => {
		const seed = createRepository();
		const omittedParentOid = git(seed, "rev-parse", "HEAD");
		writeFileSync(join(seed, "tracked.txt"), "base\n");
		git(seed, "commit", "-am", "base");
		const baseOid = git(seed, "rev-parse", "HEAD");
		const remote = join(tmpdir(), `volt-review-snapshot-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(remote, { recursive: true });
		tempDirectories.push(remote);
		git(remote, "init", "--bare", "--initial-branch=main");
		git(seed, "remote", "add", "origin", remote);
		git(seed, "push", "origin", "main");
		git(seed, "checkout", "-b", "feature");
		writeFileSync(join(seed, "tracked.txt"), "pull request\n");
		git(seed, "commit", "-am", "pull request");
		const headOid = git(seed, "rev-parse", "HEAD");
		git(seed, "push", "origin", "HEAD:refs/pull/8/head");

		const repository = join(
			tmpdir(),
			`volt-review-snapshot-shallow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(repository, { recursive: true });
		tempDirectories.push(repository);
		git(repository, "init", "--initial-branch=main");
		git(repository, "remote", "add", "origin", relative(repository, remote));
		git(repository, "fetch", "--depth=1", "origin", "main");
		git(repository, "checkout", "-B", "main", "FETCH_HEAD");
		expect(git(repository, "rev-parse", "--is-shallow-repository")).toBe("true");
		expect(spawnSync("git", ["cat-file", "-e", `${omittedParentOid}^{commit}`], { cwd: repository }).status).not.toBe(
			0,
		);

		installGitHubShim(repository, {
			view: {
				id: "PR_node_8",
				number: 8,
				title: "Shallow snapshot",
				body: "Body",
				baseRefName: "main",
				headRefName: "feature",
				url: "https://example.test/pr/8",
				baseRefOid: baseOid,
				headRefOid: headOid,
			},
		});
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const snapshot = await resolve({ kind: "pr", number: "8" }, repository);
		expect(snapshot.identity.pullRequest).toMatchObject({ number: 8, baseRefOid: baseOid, headRefOid: headOid });
		expect((await readAvailableFile(snapshot, "base", "tracked.txt")).content.toString()).toBe("base\n");
		expect((await readAvailableFile(snapshot, "head", "tracked.txt")).content.toString()).toBe("pull request\n");

		const localObjects = git(repository, "rev-parse", "--path-format=absolute", "--git-path", "objects");
		const unavailableLocalObjects = `${localObjects}-unavailable`;
		renameSync(localObjects, unavailableLocalObjects);
		try {
			expect((await readAvailableFile(snapshot, "base", "tracked.txt")).content.toString()).toBe("base\n");
			expect((await readAvailableFile(snapshot, "head", "tracked.txt")).content.toString()).toBe("pull request\n");
			const checkout = await snapshot.materializeHead();
			expect(readFileSync(join(checkout, "tracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("pull request\n");
		} finally {
			renameSync(unavailableLocalObjects, localObjects);
		}
	});

	it("detaches fetched PR snapshots from borrowed local objects and rejects moved metadata", async () => {
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
		const localObjects = git(repository, "rev-parse", "--path-format=absolute", "--git-path", "objects");
		git(repository, "checkout", "main");
		git(repository, "branch", "-D", "feature");
		git(repository, "reflog", "expire", "--expire=now", "--all");
		git(repository, "gc", "--prune=now");
		expect(spawnSync("git", ["cat-file", "-e", `${headOid}^{commit}`], { cwd: repository }).status).not.toBe(0);

		const config: GitHubShimConfig = {
			view: {
				id: "PR_node_7",
				number: 7,
				title: "Snapshot",
				body: "Body",
				baseRefName: "main",
				headRefName: "feature",
				url: "https://example.test/pr/7",
				baseRefOid: baseOid,
				headRefOid: headOid,
			},
		};
		installGitHubShim(repository, config);
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Unable to locate git executable");
		const alternatesLog = join(repository, "fetch-alternates.log");
		installNodeCommandShim(
			join(repository, "bin"),
			"git",
			`import { appendFileSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "fetch") appendFileSync(${JSON.stringify(alternatesLog)}, readFileSync(join(process.cwd(), "objects", "info", "alternates"), "utf8"));\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exitCode = result.status ?? 1;\n`,
		);
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const snapshot = await resolve({ kind: "pr", number: "7" }, repository);
		expect(readFileSync(alternatesLog, "utf8").trim()).toBe(resolvePath(localObjects));
		expect(snapshot.identity.pullRequest).toMatchObject({ number: 7, baseRefOid: baseOid, headRefOid: headOid });
		expect(snapshot.githubContext?.manifest).toMatchObject({ status: "complete", fingerprint: expect.any(String) });
		expect(
			snapshot.changedFiles
				.flatMap((file) => file.hunks)
				.map((hunk) => hunk.patch)
				.join("\n"),
		).toContain("+pull request");

		const unavailableLocalObjects = `${localObjects}-unavailable`;
		renameSync(localObjects, unavailableLocalObjects);
		try {
			expect((await readAvailableFile(snapshot, "base", "tracked.txt")).content.toString()).toBe("before\n");
			expect((await readAvailableFile(snapshot, "head", "tracked.txt")).content.toString()).toBe("pull request\n");
			const checkout = await snapshot.materializeHead();
			expect(readFileSync(join(checkout, "tracked.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("pull request\n");
		} finally {
			renameSync(unavailableLocalObjects, localObjects);
		}

		config.finalHeadOid = baseOid;
		writeFileSync(join(repository, "bin", "gh-config.json"), JSON.stringify(config));
		const moved = await resolveReviewSnapshot({ kind: "pr", number: "7" }, repository, OPTIONS);
		expect(moved).toMatchObject({
			error: "The pull request moved while Volt captured its GitHub context. Retry the review.",
		});
	});

	it("keeps the GitHub context fingerprint stable across pull request code revisions", async () => {
		const repository = createRepository();
		const view = {
			id: "PR_fingerprint",
			number: 7,
			title: "Stable context",
			body: "Stable body",
			baseRefName: "main",
			headRefName: "feature",
			url: "https://example.test/pr/7",
			baseRefOid: "a".repeat(40),
			headRefOid: "b".repeat(40),
		};
		const configPath = join(repository, "bin", "gh-config.json");
		installGitHubShim(repository, { view });
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;
		const captureFingerprint = async (): Promise<string> => {
			const captured = await captureReviewGitHubContext({
				cwd: repository,
				number: "7",
				maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
			});
			expect(captured.ok).toBe(true);
			if (!captured.ok) throw new Error(captured.error);
			return captured.context.manifest.fingerprint;
		};

		const initialFingerprint = await captureFingerprint();
		view.headRefOid = "c".repeat(40);
		writeFileSync(configPath, JSON.stringify({ view }));
		expect(await captureFingerprint()).toBe(initialFingerprint);

		view.baseRefOid = "d".repeat(40);
		writeFileSync(configPath, JSON.stringify({ view }));
		expect(await captureFingerprint()).toBe(initialFingerprint);

		view.title = "Changed context";
		writeFileSync(configPath, JSON.stringify({ view }));
		expect(await captureFingerprint()).not.toBe(initialFingerprint);
	});

	it("captures paged linked issues, PR discussion, reviews, threads, replies, and issue comments", async () => {
		const repository = createRepository();
		const oid = "a".repeat(40);
		const issue = (id: string, number: number, title: string) => ({
			id,
			number,
			title,
			body: `Issue ${number} body`,
			url: `https://example.test/issues/${number}`,
			state: number === 1 ? "OPEN" : "CLOSED",
			stateReason: number === 1 ? null : "COMPLETED",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-02T00:00:00Z",
			author: { __typename: "User", login: `issue-author-${number}` },
			repository: { nameWithOwner: "volt/example" },
		});
		const comment = (id: string, body: string) => ({
			id,
			body,
			url: `https://example.test/comments/${id}`,
			createdAt: "2026-01-03T00:00:00Z",
			updatedAt: "2026-01-03T00:00:00Z",
			authorAssociation: "CONTRIBUTOR",
			isMinimized: false,
			minimizedReason: null,
			author: { __typename: "User", login: "reviewer" },
		});
		const graphql: Record<string, unknown> = {
			[graphqlKey("VoltReviewLinkedIssues", "PR_node_7", null, false)]: graphqlConnection(
				"closingIssuesReferences",
				[issue("issue-1", 1, "First linked issue")],
				true,
				"issues-page-2",
			),
			[graphqlKey("VoltReviewLinkedIssues", "PR_node_7", "issues-page-2", false)]: graphqlConnection(
				"closingIssuesReferences",
				[issue("issue-2", 2, "Manual linked issue")],
			),
			[graphqlKey("VoltReviewLinkedIssues", "PR_node_7", null, true)]: graphqlConnection("closingIssuesReferences", [
				issue("issue-2", 2, "Manual linked issue"),
			]),
			[graphqlKey("VoltReviewPullRequestComments", "PR_node_7", null)]: graphqlConnection(
				"comments",
				[comment("pr-comment-1", "First PR comment")],
				true,
				"pr-comments-page-2",
			),
			[graphqlKey("VoltReviewPullRequestComments", "PR_node_7", "pr-comments-page-2")]: graphqlConnection(
				"comments",
				[comment("pr-comment-2", "Second PR comment")],
			),
			[graphqlKey("VoltReviewPullRequestReviews", "PR_node_7", null)]: graphqlConnection("reviews", [
				{
					...comment("review-1", "Submitted review summary"),
					state: "APPROVED",
					submittedAt: "2026-01-04T00:00:00Z",
					commit: { oid },
				},
			]),
			[graphqlKey("VoltReviewThreads", "PR_node_7", null)]: graphqlConnection("reviewThreads", [
				{
					id: "thread-1",
					isResolved: true,
					isOutdated: false,
					path: "src/value.ts",
					line: 4,
					startLine: 4,
					originalLine: 3,
					originalStartLine: 3,
					diffSide: "RIGHT",
					comments: {
						nodes: [
							{
								...comment("thread-comment-pending-root", "Pending inline root"),
								state: "PENDING",
								diffHunk: "@@ -1 +1 @@",
								replyTo: null,
							},
							{
								...comment("thread-comment-1", "Inline root"),
								state: "SUBMITTED",
								diffHunk: "@@ -1 +1 @@",
								replyTo: null,
							},
						],
						pageInfo: { hasNextPage: true, endCursor: "thread-replies" },
					},
				},
			]),
			[graphqlKey("VoltReviewThreadComments", "thread-1", "thread-replies")]: graphqlConnection("comments", [
				{
					...comment("thread-comment-pending-reply", "Pending inline reply"),
					state: "PENDING",
					diffHunk: "@@ -1 +1 @@",
					replyTo: { id: "thread-comment-1" },
				},
				{
					...comment("thread-comment-2", "Inline reply"),
					state: "SUBMITTED",
					diffHunk: "@@ -1 +1 @@",
					replyTo: { id: "thread-comment-1" },
				},
			]),
			[graphqlKey("VoltReviewIssueComments", "issue-1", null)]: graphqlConnection("comments", [
				comment("issue-comment-1", "Linked issue discussion"),
			]),
		};
		const graphqlGatePath = join(repository, "release-initial-graphql");
		const logPath = installGitHubShim(repository, {
			view: {
				id: "PR_node_7",
				number: 7,
				title: "Context PR",
				body: "PR body",
				baseRefName: "main",
				headRefName: "feature",
				url: "https://example.test/pr/7",
				baseRefOid: oid,
				headRefOid: oid,
			},
			graphql,
			graphqlGatePath,
		});
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const capturePromise = captureReviewGitHubContext({
			cwd: repository,
			number: "7",
			maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
		});
		await vi.waitFor(() => {
			const initialRequests = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { variables?: { cursor?: unknown } })
				.filter((request) => request.variables?.cursor === null);
			expect(initialRequests).toHaveLength(5);
		});
		writeFileSync(graphqlGatePath, "release\n");
		const captured = await capturePromise;
		expect(captured.ok).toBe(true);
		if (!captured.ok) throw new Error(captured.error);
		expect(captured.context.manifest).toMatchObject({
			status: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 6,
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(captured.context.linkedIssues).toMatchObject([
			{ number: 1, relationship: "closing", state: "OPEN" },
			{ number: 2, relationship: "manual", state: "CLOSED" },
		]);
		expect(captured.context.discussionEntries.map((entry) => entry.kind)).toEqual([
			"pr-comment",
			"pr-comment",
			"review-summary",
			"review-thread-comment",
			"review-thread-comment",
			"linked-issue-comment",
		]);
		expect(captured.context.rendered).toContain("Manual linked issue");
		expect(captured.context.rendered).toContain("Inline reply");
		expect(captured.context.rendered).toContain("Linked issue discussion");
		expect(captured.context.rendered).not.toContain("Pending inline root");
		expect(captured.context.rendered).not.toContain("Pending inline reply");
		expect(
			captured.context.discussionEntries.filter((entry) => entry.kind === "review-thread-comment"),
		).toMatchObject([
			{ id: "thread-comment-1", state: "SUBMITTED" },
			{ id: "thread-comment-2", state: "SUBMITTED" },
		]);
		expect(captured.context.manifest.limitations).toEqual([]);
		const requests = readFileSync(logPath, "utf8");
		expect(requests).toContain('"cursor":"issues-page-2"');
		expect(requests).toContain('"cursor":"pr-comments-page-2"');
		expect(requests).toContain('"cursor":"thread-replies"');
	});

	it("stops GitHub pagination when a connection repeats its cursor", async () => {
		const repository = createRepository();
		const oid = "e".repeat(40);
		const view = {
			id: "PR_cursor_cycle",
			number: 10,
			title: "Cursor cycle",
			body: "Body",
			baseRefName: "main",
			headRefName: "feature",
			url: "https://example.test/pr/10",
			baseRefOid: oid,
			headRefOid: oid,
		};
		const linkedIssue = {
			id: "issue-cycle",
			number: 1,
			title: "Linked issue",
			body: "Issue body",
			url: "https://example.test/issues/1",
			state: "OPEN",
			stateReason: null,
			repository: { nameWithOwner: "volt/example" },
		};
		const comment = (id: string, body: string) => ({
			id,
			body,
			url: `https://example.test/comments/${id}`,
		});
		const threadComment = {
			...comment("thread-comment-cycle", "Thread comment"),
			state: "SUBMITTED",
			diffHunk: "@@ -1 +1 @@",
			replyTo: null,
		};
		const thread = (paginateComments: boolean) => ({
			id: "thread-cycle",
			isResolved: false,
			isOutdated: false,
			path: "src/value.ts",
			line: 1,
			comments: {
				nodes: [threadComment],
				pageInfo: {
					hasNextPage: paginateComments,
					endCursor: paginateComments ? "thread-comments-repeat" : null,
				},
			},
		});
		const graphql: Record<string, unknown> = {
			[graphqlKey("VoltReviewLinkedIssues", view.id, null, false)]: graphqlConnection(
				"closingIssuesReferences",
				[linkedIssue],
				true,
				"linked-issues-repeat",
			),
			[graphqlKey("VoltReviewLinkedIssues", view.id, "linked-issues-repeat", false)]: graphqlConnection(
				"closingIssuesReferences",
				[linkedIssue],
				true,
				"linked-issues-repeat",
			),
			[graphqlKey("VoltReviewPullRequestComments", view.id, null)]: graphqlConnection(
				"comments",
				[comment("pr-comment-cycle", "PR comment")],
				true,
				"pr-comments-repeat",
			),
			[graphqlKey("VoltReviewPullRequestComments", view.id, "pr-comments-repeat")]: graphqlConnection(
				"comments",
				[comment("pr-comment-cycle", "PR comment")],
				true,
				"pr-comments-repeat",
			),
			[graphqlKey("VoltReviewThreads", view.id, null)]: graphqlConnection(
				"reviewThreads",
				[thread(true)],
				true,
				"review-threads-repeat",
			),
			[graphqlKey("VoltReviewThreadComments", "thread-cycle", "thread-comments-repeat")]: graphqlConnection(
				"comments",
				[threadComment],
				true,
				"thread-comments-repeat",
			),
			[graphqlKey("VoltReviewThreads", view.id, "review-threads-repeat")]: graphqlConnection(
				"reviewThreads",
				[thread(false)],
				true,
				"review-threads-repeat",
			),
			[graphqlKey("VoltReviewIssueComments", linkedIssue.id, null)]: graphqlConnection(
				"comments",
				[comment("issue-comment-cycle", "Issue comment")],
				true,
				"issue-comments-repeat",
			),
			[graphqlKey("VoltReviewIssueComments", linkedIssue.id, "issue-comments-repeat")]: graphqlConnection(
				"comments",
				[comment("issue-comment-cycle", "Issue comment")],
				true,
				"issue-comments-repeat",
			),
		};
		const logPath = installGitHubShim(repository, { view, graphql, maximumGraphqlRequests: 16 });
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const captured = await captureReviewGitHubContext({
			cwd: repository,
			number: "10",
			maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
		});
		expect(captured.ok).toBe(true);
		if (!captured.ok) throw new Error(captured.error);
		expect(captured.context.manifest).toMatchObject({
			status: "incomplete",
			linkedIssueCount: 1,
			discussionEntryCount: 3,
		});
		expect(captured.context.manifest.limitations).toEqual([
			{ code: "invalid-api-response", source: "linked-issues", count: 1 },
			{ code: "invalid-api-response", source: "pr-comments", count: 1 },
			{ code: "invalid-api-response", source: "review-thread-comments", count: 1 },
			{ code: "invalid-api-response", source: "review-threads", count: 1 },
			{ code: "invalid-api-response", source: "linked-issue-comments", count: 1 },
		]);
		const requests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						operation?: unknown;
						variables?: { cursor?: unknown };
					},
			);
		const requestCount = (operation: string, cursor: string): number =>
			requests.filter((request) => request.operation === operation && request.variables?.cursor === cursor).length;
		expect(requestCount("VoltReviewLinkedIssues", "linked-issues-repeat")).toBe(1);
		expect(requestCount("VoltReviewPullRequestComments", "pr-comments-repeat")).toBe(1);
		expect(requestCount("VoltReviewThreadComments", "thread-comments-repeat")).toBe(1);
		expect(requestCount("VoltReviewThreads", "review-threads-repeat")).toBe(1);
		expect(requestCount("VoltReviewIssueComments", "issue-comments-repeat")).toBe(1);
	});

	it("enforces GitHub context text, issue, discussion, and aggregate limits", async () => {
		const repository = createRepository();
		const oid = "b".repeat(40);
		const linkedIssues = Array.from({ length: 20 }, (_, index) => ({
			id: `issue-${index + 1}`,
			number: index + 1,
			title: `Issue ${index + 1}`,
			body: "body",
			url: `https://example.test/issues/${index + 1}`,
			state: "OPEN",
			stateReason: null,
			repository: { nameWithOwner: "volt/example" },
		}));
		const graphql: Record<string, unknown> = {
			[graphqlKey("VoltReviewLinkedIssues", "PR_node_limits", null, false)]: graphqlConnection(
				"closingIssuesReferences",
				linkedIssues,
				true,
				"issue-overflow",
			),
		};
		for (let page = 0; page < 10; page++) {
			const cursor = page === 0 ? null : `discussion-${page}`;
			const nextCursor = `discussion-${page + 1}`;
			graphql[graphqlKey("VoltReviewPullRequestComments", "PR_node_limits", cursor)] = graphqlConnection(
				"comments",
				Array.from({ length: 20 }, (_, index) => ({
					id: `comment-${page * 20 + index}`,
					body: page === 0 && index === 0 ? "x".repeat(33 * 1024) : "z".repeat(1_300),
					url: `https://example.test/comments/${page * 20 + index}`,
					authorAssociation: "NONE",
					author: { __typename: "User", login: "commenter" },
				})),
				true,
				nextCursor,
			);
		}
		graphql[graphqlKey("VoltReviewPullRequestComments", "PR_node_limits", "discussion-10")] = graphqlConnection(
			"comments",
			[{ id: "comment-overflow", body: "overflow" }],
		);
		installGitHubShim(repository, {
			view: {
				id: "PR_node_limits",
				number: 8,
				title: "Limits",
				body: "Body",
				baseRefName: "main",
				headRefName: "feature",
				url: "https://example.test/pr/8",
				baseRefOid: oid,
				headRefOid: oid,
			},
			graphql,
		});
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const captured = await captureReviewGitHubContext({
			cwd: repository,
			number: "8",
			maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
		});
		expect(captured.ok).toBe(true);
		if (!captured.ok) throw new Error(captured.error);
		expect(captured.context.manifest).toMatchObject({
			status: "incomplete",
			linkedIssueCount: 20,
			discussionEntryCount: 200,
		});
		expect(captured.context.manifest.limitations.map((limitation) => limitation.code)).toEqual(
			expect.arrayContaining(["linked-issue-limit", "discussion-limit", "text-limit", "aggregate-limit"]),
		);
		expect(Buffer.byteLength(captured.context.rendered, "utf8")).toBeLessThanOrEqual(256 * 1024);
		expect(Buffer.byteLength(captured.context.discussionEntries[0]?.body ?? "", "utf8")).toBeLessThanOrEqual(
			32 * 1024,
		);
	});

	it("distinguishes an exact discussion cap from later-source overflow", async () => {
		const repository = createRepository();
		const oid = "d".repeat(40);
		const view = {
			id: "PR_discussion_boundary",
			number: 9,
			title: "Discussion boundary",
			body: "Body",
			baseRefName: "main",
			headRefName: "feature",
			url: "https://example.test/pr/9",
			baseRefOid: oid,
			headRefOid: oid,
		};
		const comments = Array.from({ length: 200 }, (_, index) => ({
			id: `comment-${index}`,
			body: `comment ${index}`,
		}));
		const graphql: Record<string, unknown> = {
			[graphqlKey("VoltReviewPullRequestComments", view.id, null)]: graphqlConnection("comments", comments),
		};
		const configPath = join(repository, "bin", "gh-config.json");
		installGitHubShim(repository, { view, graphql });
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;

		const capture = async () => {
			const captured = await captureReviewGitHubContext({
				cwd: repository,
				number: "9",
				maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
			});
			expect(captured.ok).toBe(true);
			if (!captured.ok) throw new Error(captured.error);
			return captured.context;
		};
		const exact = await capture();
		expect(exact.manifest).toMatchObject({
			status: "complete",
			discussionEntryCount: 200,
			limitations: [],
		});

		graphql[graphqlKey("VoltReviewPullRequestReviews", view.id, null)] = graphqlConnection("reviews", [
			{
				id: "review-overflow",
				body: "Later submitted review",
				state: "COMMENTED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid },
			},
		]);
		writeFileSync(configPath, JSON.stringify({ view, graphql }));
		const overflow = await capture();
		expect(overflow.manifest).toMatchObject({
			status: "incomplete",
			discussionEntryCount: 200,
		});
		expect(overflow.manifest.limitations.map((limitation) => limitation.code)).toContain("discussion-limit");
		expect(overflow.discussionEntries.some((entry) => entry.id === "review-overflow")).toBe(false);
	});

	it("fails closed when manifest byte convergence crosses the aggregate boundary", async () => {
		const repository = createRepository();
		const oid = "c".repeat(40);
		const view = {
			id: "PR_boundary",
			number: 274,
			title: "Boundary",
			body: "Body",
			baseRefName: "main",
			headRefName: "feature",
			url: "https://example.test/pr/274",
			baseRefOid: oid,
			headRefOid: oid,
		};
		const configPath = join(repository, "bin", "gh-config.json");
		const configFor = (finalBodyBytes: number): GitHubShimConfig => ({
			view,
			graphql: {
				[graphqlKey("VoltReviewPullRequestComments", "PR_boundary", null)]: graphqlConnection("comments", [
					...Array.from({ length: 7 }, (_, index) => ({
						id: `comment-${index}`,
						body: "x".repeat(32 * 1024),
					})),
					{ id: "comment-final", body: "y".repeat(finalBodyBytes) },
				]),
			},
		});
		installGitHubShim(repository, configFor(31_637));
		process.env.PATH = `${join(repository, "bin")}${delimiter}${initialPath ?? ""}`;
		const capture = async () => {
			const captured = await captureReviewGitHubContext({
				cwd: repository,
				number: "274",
				maxPullRequestNumber: OPTIONS.maxPullRequestNumber,
			});
			expect(captured.ok).toBe(true);
			if (!captured.ok) throw new Error(captured.error);
			expect(captured.context.manifest.renderedBytes).toBe(Buffer.byteLength(captured.context.rendered, "utf8"));
			if (captured.context.manifest.status === "complete") {
				expect(captured.context.manifest.renderedLinkedIssueCount).toBe(captured.context.manifest.linkedIssueCount);
				expect(captured.context.manifest.renderedDiscussionEntryCount).toBe(
					captured.context.manifest.discussionEntryCount,
				);
			}
			return captured.context;
		};

		const atLimit = await capture();
		expect(atLimit.manifest).toMatchObject({
			status: "complete",
			discussionEntryCount: 8,
			renderedDiscussionEntryCount: 8,
			renderedBytes: 256 * 1024,
			limitations: [],
		});

		writeFileSync(configPath, JSON.stringify(configFor(31_638)));
		const overLimit = await capture();
		expect(overLimit.manifest).toMatchObject({
			status: "incomplete",
			discussionEntryCount: 8,
			renderedDiscussionEntryCount: 7,
		});
		expect(overLimit.manifest.limitations.map((limitation) => limitation.code)).toContain("aggregate-limit");
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

	it("kills an in-flight Git command and classifies preparation cancellation", async () => {
		const repository = createRepository();
		writeFileSync(join(repository, "tracked.txt"), "after\n");
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Unable to locate git executable");
		const bin = join(repository, "delayed-git-bin");
		const startedPath = join(repository, "delayed-git-started");
		mkdirSync(bin);
		installNodeCommandShim(
			bin,
			"git",
			`import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "rev-parse" && args[1] === "--show-toplevel") {\n  writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));\n  setInterval(() => {}, 1_000);\n} else {\n  const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });\n  if (result.error) throw result.error;\n  process.exitCode = result.status ?? 1;\n}\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		const controller = new AbortController();
		const resolution = resolveReviewSnapshot({ kind: "uncommitted" }, repository, {
			...OPTIONS,
			signal: controller.signal,
		});
		try {
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
			controller.abort();
			await expect(resolution).resolves.toEqual({ error: "Review cancelled.", cancelled: true });
			await vi.waitFor(() => expect(processIsAlive(startedPath)).toBe(false));
		} finally {
			controller.abort();
		}
	});

	it("kills an in-flight GitHub CLI command during PR preparation", async () => {
		const repository = createRepository();
		const bin = join(repository, "delayed-gh-bin");
		const startedPath = join(repository, "delayed-gh-started");
		mkdirSync(bin);
		installNodeCommandShim(
			bin,
			"gh",
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(startedPath)}, String(process.pid));\nsetInterval(() => {}, 1_000);\n`,
		);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		const controller = new AbortController();
		const resolution = resolveReviewSnapshot({ kind: "pr", number: "7" }, repository, {
			...OPTIONS,
			signal: controller.signal,
		});
		try {
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));
			controller.abort();
			await expect(resolution).resolves.toEqual({ error: "Review cancelled.", cancelled: true });
			await vi.waitFor(() => expect(processIsAlive(startedPath)).toBe(false));
		} finally {
			controller.abort();
		}
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
