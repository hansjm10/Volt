import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ReviewSnapshot,
	type ReviewSnapshotSearchOptions,
	type ReviewSnapshotSearchResult,
	resolveReviewSnapshot,
} from "../src/core/review-snapshot.ts";

const OPTIONS = { maxCommitRefBytes: 1_024, maxPullRequestNumber: 2_147_483_647 };
const MAX_SEARCH_BLOB_BYTES = 8 * 1024 * 1024;

function run(cwd: string, command: string, ...args: string[]): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
	return run(cwd, "git", ...args);
}

function gitWithInput(cwd: string, input: string | Buffer, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function writeFixture(repository: string, path: string, content: string | Buffer): void {
	mkdirSync(dirname(join(repository, path)), { recursive: true });
	writeFileSync(join(repository, path), content);
}

function createBlobTree(repository: string, entries: Array<{ path: string; oid: string }>): string {
	const input = Buffer.from(
		`${[...entries]
			.sort((left, right) => left.path.localeCompare(right.path))
			.map(({ path, oid }) => `100644 blob ${oid}\t${path}`)
			.join("\0")}\0`,
		"utf8",
	);
	return gitWithInput(repository, input, "mktree", "-z");
}

function createContextCommit(repository: string, entries: Array<{ path: string; oid: string }>): string {
	const baseMarkerOid = gitWithInput(repository, "before\n", "hash-object", "-w", "--stdin");
	const headMarkerOid = gitWithInput(repository, "after\n", "hash-object", "-w", "--stdin");
	const baseTree = createBlobTree(repository, [...entries, { path: "tracked.txt", oid: baseMarkerOid }]);
	const baseCommit = git(repository, "commit-tree", baseTree, "-m", "search context base");
	const headTree = createBlobTree(repository, [...entries, { path: "tracked.txt", oid: headMarkerOid }]);
	return git(repository, "commit-tree", headTree, "-p", baseCommit, "-m", "search context head");
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

async function resolveSnapshot(
	repository: string,
	limits?: NonNullable<Parameters<typeof resolveReviewSnapshot>[2]["limits"]>,
	target: Parameters<typeof resolveReviewSnapshot>[0] = { kind: "uncommitted" },
): Promise<ReviewSnapshot> {
	const result = await resolveReviewSnapshot(target, repository, limits ? { ...OPTIONS, limits } : OPTIONS);
	if ("error" in result) throw new Error(result.error);
	return result;
}

async function legacySearchPage(
	snapshot: ReviewSnapshot,
	options: ReviewSnapshotSearchOptions,
): Promise<ReviewSnapshotSearchResult> {
	const entries = (
		await snapshot.listFiles({
			revision: options.revision,
			...(options.prefix ? { prefix: options.prefix } : {}),
		})
	).filter((entry) => entry.type === "blob");
	const matches: ReviewSnapshotSearchResult["matches"] = [];
	const skippedPaths: ReviewSnapshotSearchResult["skippedPaths"] = [];
	let nextFileIndex = options.fileIndex ?? 0;
	let nextLineIndex = options.lineIndex ?? 0;
	let filesScanned = 0;
	const needle = options.ignoreCase ? options.query.toLocaleLowerCase() : options.query;
	while (nextFileIndex < entries.length && filesScanned < options.maxFiles && matches.length < options.limit) {
		const entry = entries[nextFileIndex];
		filesScanned++;
		const file = await snapshot.readFile(options.revision, entry.path);
		if (!file) {
			skippedPaths.push({ path: entry.path, reason: "The snapshot entry was unavailable." });
			nextFileIndex++;
			nextLineIndex = 0;
			continue;
		}
		if (!file.available) {
			skippedPaths.push({ path: entry.path, reason: file.message });
			nextFileIndex++;
			nextLineIndex = 0;
			continue;
		}
		if (file.binary) {
			skippedPaths.push({ path: entry.path, reason: "Binary content was not searched." });
			nextFileIndex++;
			nextLineIndex = 0;
			continue;
		}
		const lines = file.content.toString("utf8").split("\n");
		while (nextLineIndex < lines.length && matches.length < options.limit) {
			const line = lines[nextLineIndex] ?? "";
			const haystack = options.ignoreCase ? line.toLocaleLowerCase() : line;
			if (haystack.includes(needle)) {
				matches.push({ path: entry.path, line: nextLineIndex + 1, text: line.slice(0, 500) });
			}
			nextLineIndex++;
		}
		if (nextLineIndex >= lines.length) {
			nextFileIndex++;
			nextLineIndex = 0;
		}
	}
	return {
		matches,
		filesScanned,
		skippedPaths,
		nextFileIndex,
		nextLineIndex,
		complete: nextFileIndex >= entries.length,
	};
}

async function compareEveryPage(
	snapshot: ReviewSnapshot,
	options: Omit<ReviewSnapshotSearchOptions, "fileIndex" | "lineIndex">,
): Promise<ReviewSnapshotSearchResult[]> {
	const pages: ReviewSnapshotSearchResult[] = [];
	let fileIndex = 0;
	let lineIndex = 0;
	for (let pageIndex = 0; pageIndex < 1_000; pageIndex++) {
		const pageOptions = { ...options, fileIndex, lineIndex };
		const expected = await legacySearchPage(snapshot, pageOptions);
		const actual = await snapshot.search(pageOptions);
		expect(actual).toEqual(expected);
		pages.push(actual);
		if (actual.complete) return pages;
		expect([actual.nextFileIndex, actual.nextLineIndex]).not.toEqual([fileIndex, lineIndex]);
		fileIndex = actual.nextFileIndex;
		lineIndex = actual.nextLineIndex;
	}
	throw new Error("Search pagination did not complete.");
}

function allMatches(pages: ReviewSnapshotSearchResult[]): ReviewSnapshotSearchResult["matches"] {
	return pages.flatMap((page) => page.matches);
}

function allSkipped(pages: ReviewSnapshotSearchResult[]): ReviewSnapshotSearchResult["skippedPaths"] {
	return pages.flatMap((page) => page.skippedPaths);
}

function installGitShim(directory: string, realGit: string, modeFile: string, logFile: string): void {
	const source = join(directory, "fake-git.mjs");
	writeFileSync(
		source,
		`import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, "args " + JSON.stringify(args) + "\\n");
const mode = existsSync(${JSON.stringify(modeFile)}) ? readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "";
let terminating = false;
process.on("SIGTERM", () => {
	if (terminating) return;
	terminating = true;
	appendFileSync(${JSON.stringify(logFile)}, "term\\n");
	setTimeout(() => {
		appendFileSync(${JSON.stringify(logFile)}, "term-done\\n");
		process.exit(143);
	}, 100);
});
if (args[0] === "grep" && mode) {
	if (mode === "fail-once") {
		rmSync(${JSON.stringify(modeFile)}, { force: true });
		process.stderr.write("injected grep failure\\n");
		process.exit(2);
	}
	if (mode === "reject-out-of-scope" && args.includes(":(top,literal)outside/binary.dat")) {
		process.stderr.write("injected out-of-scope classification failure\\n");
		process.exit(2);
	}
	if (mode === "reject-over-budget-pathspec" && args.some((arg) => Buffer.byteLength(arg, "utf8") > 24 * 1024)) {
		process.stderr.write("injected over-budget argv failure\\n");
		process.exit(2);
	}
	if (mode === "fail-pcre" && args.includes("-P")) {
		process.stderr.write("injected PCRE failure\\n");
		process.exit(2);
	}
	if (mode === "flood") {
		process.stdout.write("x".repeat(8192));
		await delay(500);
	}
	if (mode === "delay") await delay(500);
}
if (args[0] === "cat-file" && args[1] === "--batch" && !terminating) {
	const child = spawn(${JSON.stringify(realGit)}, args, { stdio: ["pipe", "inherit", "inherit"] });
	child.stdin.on("error", () => {});
	child.once("error", (error) => {
		process.stderr.write(error.message + "\\n");
		process.exit(1);
	});
	child.once("exit", (code) => process.exit(code ?? 1));
	process.stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		let newline;
		while ((newline = input.indexOf("\\n")) >= 0) {
			const oid = input.slice(0, newline);
			input = input.slice(newline + 1);
			appendFileSync(${JSON.stringify(logFile)}, "batch " + process.pid + " " + JSON.stringify(oid) + "\\n");
			if (mode === "delay-batch") await delay(500);
			if (!terminating) child.stdin.write(oid + "\\n");
		}
	}
	if (!terminating) child.stdin.end(input);
} else if (!terminating) {
	const child = spawn(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
	child.once("error", (error) => {
		process.stderr.write(error.message + "\\n");
		process.exit(1);
	});
	child.once("exit", (code) => process.exit(code ?? 1));
}
`,
	);
	if (process.platform === "win32") {
		writeFileSync(
			join(directory, "git.cmd"),
			`@echo off\r\n"${process.execPath}" "${source}" %*\r\nexit /b %errorlevel%\r\n`,
		);
		return;
	}
	const executable = join(directory, "git");
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
	chmodSync(executable, 0o755);
}

function readShimArgs(logFile: string): string[][] {
	if (!existsSync(logFile)) return [];
	return readFileSync(logFile, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("args "))
		.map((line) => JSON.parse(line.slice(5)) as unknown)
		.filter((value): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

interface ShimBatchRequest {
	processId: number;
	oid: string;
}

function readShimBatchRequests(logFile: string): ShimBatchRequest[] {
	if (!existsSync(logFile)) return [];
	const requests: ShimBatchRequest[] = [];
	for (const line of readFileSync(logFile, "utf8").split("\n")) {
		const match = /^batch (\d+) (.+)$/u.exec(line);
		if (!match) continue;
		const processId = Number(match[1]);
		const oid = JSON.parse(match[2] ?? "") as unknown;
		if (Number.isSafeInteger(processId) && typeof oid === "string") requests.push({ processId, oid });
	}
	return requests;
}

async function waitForShimArgs(logFile: string, predicate: (args: string[]) => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (readShimArgs(logFile).some(predicate)) return;
		await delay(10);
	}
	throw new Error("Timed out waiting for the Git shim command.");
}

async function waitForShimBatchRequests(logFile: string, count: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (readShimBatchRequests(logFile).length >= count) return;
		await delay(10);
	}
	throw new Error("Timed out waiting for the Git shim batch request.");
}

function grepPattern(args: string[]): string | undefined {
	if (args[0] !== "grep") return undefined;
	const patternIndex = args.indexOf("-e");
	return patternIndex < 0 ? undefined : args[patternIndex + 1];
}

describe("direct-tree review snapshot search", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];
	const initialPath = process.env.PATH;
	const initialGitTrace = process.env.GIT_TRACE;
	const initialGitLiteralPathspecs = process.env.GIT_LITERAL_PATHSPECS;
	const initialTmpdir = process.env.TMPDIR;
	const initialTemp = process.env.TEMP;
	const initialTmp = process.env.TMP;

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (initialPath === undefined) delete process.env.PATH;
		else process.env.PATH = initialPath;
		if (initialGitTrace === undefined) delete process.env.GIT_TRACE;
		else process.env.GIT_TRACE = initialGitTrace;
		if (initialGitLiteralPathspecs === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
		else process.env.GIT_LITERAL_PATHSPECS = initialGitLiteralPathspecs;
		if (initialTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = initialTmpdir;
		if (initialTemp === undefined) delete process.env.TEMP;
		else process.env.TEMP = initialTemp;
		if (initialTmp === undefined) delete process.env.TMP;
		else process.env.TMP = initialTmp;
	});

	function createRepository(): string {
		const repository = join(tmpdir(), `volt-review-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(repository, { recursive: true });
		directories.push(repository);
		git(repository, "init", "--initial-branch=main");
		git(repository, "config", "user.email", "review@example.com");
		git(repository, "config", "user.name", "Review Test");
		git(repository, "config", "commit.gpgsign", "false");
		return repository;
	}

	it("matches the legacy observable result across semantic fallbacks and every cursor page", async () => {
		const repository = createRepository();
		const supportsNewlinePaths = process.platform !== "win32";
		writeFixture(repository, ".gitignore", "*.ignored\n");
		writeFixture(repository, ".hidden.txt", "hidden needle\n");
		writeFixture(repository, ".kept.ignored", "ignored base-only needle\n");
		writeFixture(repository, "-leading.txt", "leading needle\n");
		writeFixture(repository, "base-deleted.txt", "base-only needle\n");
		writeFixture(repository, "binary.dat", Buffer.from([0, 110, 101, 101, 100, 108, 101]));
		writeFixture(repository, "crlf.txt", "first\r\nCRLF needle\r\n");
		writeFixture(repository, "duplicate-a.txt", "duplicate needle\n");
		writeFixture(repository, "duplicate-b.txt", "duplicate needle\n");
		writeFixture(repository, "empty.txt", "");
		writeFixture(
			repository,
			"invalid-utf8.txt",
			Buffer.from([0x62, 0x61, 0x64, 0xff, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a]),
		);
		writeFixture(
			repository,
			"late-nul.txt",
			Buffer.concat([Buffer.from("x".repeat(8_192)), Buffer.from("\0needle\nafter")]),
		);
		if (supportsNewlinePaths) writeFixture(repository, "line\nbreak.txt", "newline path needle\n");
		writeFixture(repository, "long.txt", `${"needle ".padEnd(600, "x")}\n`);
		writeFixture(repository, "multiline.txt", "alpha\nbeta\n");
		writeFixture(repository, "no-final.txt", "no-final needle");
		writeFixture(repository, "ordinary.txt", "base-only needle\nsecond needle\n");
		writeFixture(repository, "oversized.txt", "o".repeat(13 * 1_024));
		writeFixture(repository, "scope/inside.txt", "scoped needle\n");
		writeFixture(repository, "scope/outside.dat", Buffer.from([0, 1, 2]));
		writeFixture(repository, "unicode-路径.txt", "İSTANBUL CAFÉ Straße needle\n");
		createSymlinkFixture(repository, "symlink.txt", "needle-target");
		writeFixture(repository, "CaseOnly/Alias.txt", "upper probe\n");
		writeFixture(repository, "CaseOnly/alias.txt", "lower probe\n");
		const caseSensitiveFileSystem = readFileSync(join(repository, "CaseOnly/Alias.txt"), "utf8") === "upper probe\n";
		writeFixture(repository, "CaseOnly/Alias.txt", "case alias needle\n");
		if (caseSensitiveFileSystem) writeFixture(repository, "CaseOnly/alias.txt", "case alias needle\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "add", "-f", "--", ".kept.ignored");
		if (!caseSensitiveFileSystem) {
			const oid = git(repository, "hash-object", "-w", "--", "CaseOnly/Alias.txt");
			git(repository, "config", "core.ignorecase", "false");
			git(repository, "update-index", "--add", "--cacheinfo", `100644,${oid},CaseOnly/alias.txt`);
		}
		git(repository, "commit", "-m", "semantic base");
		if (!caseSensitiveFileSystem) git(repository, "config", "core.ignorecase", "true");
		writeFixture(repository, ".kept.ignored", "ignored head-only needle\n");
		writeFixture(repository, "head-added.txt", "head-only needle\n");
		writeFixture(repository, "ordinary.txt", "head-only needle\nsecond needle\n");
		rmSync(join(repository, "base-deleted.txt"));

		const snapshot = await resolveSnapshot(repository, { maxBlobBytes: 12 * 1_024 });
		snapshots.push(snapshot);
		const common = { limit: 1, maxFiles: 4 };
		const basePages = await compareEveryPage(snapshot, {
			...common,
			revision: "base",
			query: "base-only",
		});
		const headPages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "head-only",
		});
		const needlePages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "needle",
		});
		const scopedPages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			prefix: "scope",
			query: "needle",
		});
		const unicodeCasePages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "i",
			ignoreCase: true,
		});
		const nonAsciiPages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "é",
			ignoreCase: true,
		});
		const nulPages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "\0needle",
		});
		const multilinePages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "alpha\nbeta",
		});
		const invalidPages = await compareEveryPage(snapshot, {
			...common,
			revision: "head",
			query: "�",
		});

		expect(allMatches(basePages).map((match) => match.path)).toContain("base-deleted.txt");
		expect(allMatches(headPages).map((match) => match.path)).toEqual(
			expect.arrayContaining([".kept.ignored", "head-added.txt", "ordinary.txt"]),
		);
		const needlePaths = allMatches(needlePages).map((match) => match.path);
		expect(needlePaths).toEqual(
			expect.arrayContaining([
				".hidden.txt",
				"-leading.txt",
				"CaseOnly/Alias.txt",
				"CaseOnly/alias.txt",
				"crlf.txt",
				"duplicate-a.txt",
				"duplicate-b.txt",
				...(supportsNewlinePaths ? ["line\nbreak.txt"] : []),
				"no-final.txt",
				"symlink.txt",
				"unicode-路径.txt",
			]),
		);
		expect(allMatches(needlePages).find((match) => match.path === "long.txt")?.text).toHaveLength(500);
		expect(allMatches(scopedPages).map((match) => match.path)).toEqual(["scope/inside.txt"]);
		expect(allMatches(unicodeCasePages).map((match) => match.path)).toContain("unicode-路径.txt");
		expect(allMatches(nonAsciiPages).map((match) => match.path)).toContain("unicode-路径.txt");
		expect(allMatches(nulPages)).toMatchObject([{ path: "late-nul.txt", line: 1 }]);
		expect(allMatches(multilinePages)).toEqual([]);
		expect(allMatches(invalidPages)).toMatchObject([{ path: "invalid-utf8.txt", line: 1 }]);
		expect(allSkipped(needlePages)).toEqual(
			expect.arrayContaining([
				{ path: "binary.dat", reason: "Binary content was not searched." },
				{ path: "oversized.txt", reason: expect.stringContaining("12 KiB") },
			]),
		);
	});

	it("returns bounded pages without retaining every repository match", async () => {
		const repository = createRepository();
		writeFixture(repository, "dense.txt", "before\n");
		git(repository, "add", "dense.txt");
		git(repository, "commit", "-m", "dense search base");
		writeFixture(repository, "dense.txt", "x\n".repeat(250_001));
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		const firstPage = await snapshot.search({
			revision: "head",
			query: "x",
			limit: 100,
			maxFiles: 200,
		});
		expect(firstPage).toMatchObject({
			filesScanned: 1,
			nextFileIndex: 0,
			nextLineIndex: 100,
			complete: false,
		});
		expect(firstPage.matches).toEqual(
			Array.from({ length: 100 }, (_, index) => ({ path: "dense.txt", line: index + 1, text: "x" })),
		);

		const secondPage = await snapshot.search({
			revision: "head",
			query: "x",
			fileIndex: firstPage.nextFileIndex,
			lineIndex: firstPage.nextLineIndex,
			limit: 100,
			maxFiles: 200,
		});
		expect(secondPage).toMatchObject({
			filesScanned: 1,
			nextFileIndex: 0,
			nextLineIndex: 200,
			complete: false,
		});
		expect(secondPage.matches).toEqual(
			Array.from({ length: 100 }, (_, index) => ({ path: "dense.txt", line: index + 101, text: "x" })),
		);
	});

	it("stops candidate blob reads after an early bounded page is full", async () => {
		const repository = createRepository();
		const content = Buffer.alloc(MAX_SEARCH_BLOB_BYTES, 0x78);
		const entries: Array<{ path: string; oid: string }> = [];
		for (let index = 0; index < 33; index++) {
			content.fill(0x78);
			content.write(
				index === 0 ? "needle\n".repeat(50) : index === 1 ? "needle\nsecond-only-é\n" : "needle\n",
				0,
				"utf8",
			);
			content.write(String(index).padStart(2, "0"), content.length - 2, "utf8");
			entries.push({
				path: `candidate-${String(index).padStart(2, "0")}.txt`,
				oid: gitWithInput(repository, content, "hash-object", "-w", "--stdin"),
			});
		}
		const headCommit = createContextCommit(repository, entries);
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha: headCommit });
		snapshots.push(snapshot);
		const firstOid = entries[0]?.oid;
		const secondOid = entries[1]?.oid;
		if (!firstOid || !secondOid) throw new Error("Expected two candidate blob OIDs.");
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		const result = await snapshot.search({
			revision: "head",
			query: "needle",
			limit: 50,
			maxFiles: 200,
		});
		expect(result).toMatchObject({
			filesScanned: 1,
			nextFileIndex: 0,
			nextLineIndex: 50,
			complete: false,
		});
		expect(result.matches).toEqual(
			Array.from({ length: 50 }, (_, index) => ({
				path: "candidate-00.txt",
				line: index + 1,
				text: "needle",
			})),
		);
		const firstPageBatches = readShimArgs(log).filter((args) => args[0] === "cat-file" && args[1] === "--batch");
		expect(firstPageBatches).toHaveLength(1);
		expect(readShimBatchRequests(log)).toEqual([{ processId: expect.any(Number), oid: firstOid }]);

		const secondCandidatePage = await snapshot.search({
			revision: "head",
			query: "second-only-é",
			limit: 1,
			maxFiles: 200,
		});
		expect(secondCandidatePage).toMatchObject({
			matches: [{ path: "candidate-01.txt", line: 2, text: "second-only-é" }],
			filesScanned: 2,
			nextFileIndex: 1,
			nextLineIndex: 2,
			complete: false,
		});
		const allBatchRequests = readShimBatchRequests(log);
		const secondPageRequests = allBatchRequests.slice(1);
		expect(readShimArgs(log).filter((args) => args[0] === "cat-file" && args[1] === "--batch")).toHaveLength(2);
		expect(secondPageRequests.map(({ oid }) => oid)).toEqual([firstOid, secondOid]);
		expect(new Set(secondPageRequests.map(({ processId }) => processId)).size).toBe(1);
	});

	it("reports binaries whose first NUL falls after Git's binary probe", async () => {
		const repository = createRepository();
		writeFixture(
			repository,
			"probe-gap.bin",
			Buffer.concat([Buffer.alloc(8_000, 0x78), Buffer.from([0]), Buffer.from("tail")]),
		);
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "binary probe fixture");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		await expect(
			snapshot.search({
				revision: "head",
				prefix: "probe-gap.bin",
				query: "absent",
				limit: 50,
				maxFiles: 200,
			}),
		).resolves.toMatchObject({
			matches: [],
			filesScanned: 1,
			skippedPaths: [{ path: "probe-gap.bin", reason: "Binary content was not searched." }],
			complete: true,
		});
	});

	it("returns an early bounded page before later manifest classification blobs are read", async () => {
		const repository = createRepository();
		const entries: Array<{ path: string; oid: string }> = [
			{
				path: "a-early.txt",
				oid: gitWithInput(repository, "needle\n", "hash-object", "-w", "--stdin"),
			},
		];
		const content = Buffer.alloc(MAX_SEARCH_BLOB_BYTES, 0x78);
		content[0] = 0;
		for (let index = 0; index < 33; index++) {
			content.write(String(index).padStart(2, "0"), content.length - 2, "utf8");
			entries.push({
				path: `binary-${String(index).padStart(2, "0")}.dat`,
				oid: gitWithInput(repository, content, "hash-object", "-w", "--stdin"),
			});
		}
		const headCommit = createContextCommit(repository, entries);
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha: headCommit });
		snapshots.push(snapshot);

		await expect(
			snapshot.search({ revision: "head", query: "needle", limit: 1, maxFiles: 200 }),
		).resolves.toMatchObject({
			matches: [{ path: "a-early.txt", line: 1, text: "needle" }],
			filesScanned: 1,
			nextFileIndex: 0,
			nextLineIndex: 1,
			complete: false,
		});
	});

	it("disables configured color in machine-parsed Git grep output", async () => {
		const repository = createRepository();
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "initial");
		writeFixture(repository, "tracked.txt", "after color-safe needle\n");
		git(repository, "config", "color.grep", "always");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		await expect(
			snapshot.search({ revision: "head", query: "color-safe", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [{ path: "tracked.txt", line: 1 }] });
	});

	it("neutralizes inherited literal pathspec mode for generated Git grep pathspecs", async () => {
		const repository = createRepository();
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "initial");
		writeFixture(repository, "tracked.txt", "after pathspec-safe needle\n");
		process.env.GIT_LITERAL_PATHSPECS = "1";
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		await expect(
			snapshot.search({ revision: "head", query: "pathspec-safe", limit: 100, maxFiles: 200 }),
		).resolves.toEqual({
			matches: [{ path: "tracked.txt", line: 1, text: "after pathspec-safe needle" }],
			filesScanned: 1,
			skippedPaths: [],
			nextFileIndex: 1,
			nextLineIndex: 0,
			complete: true,
		});
	});

	it("uses blob bytes instead of diff attributes to classify searchable text", async () => {
		const repository = createRepository();
		writeFixture(repository, ".gitattributes", "*.generated -diff\n*.forced binary\n");
		writeFixture(repository, "binary.generated", Buffer.from([0, 1, 2, 3]));
		writeFixture(repository, "text.generated", "generated attribute needle\n");
		writeFixture(repository, "text.forced", "forced attribute needle\n");
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "attribute fixtures");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		const pages = await compareEveryPage(snapshot, {
			revision: "head",
			query: "attribute needle",
			limit: 1,
			maxFiles: 2,
		});
		expect(allMatches(pages).map((match) => match.path)).toEqual(["text.forced", "text.generated"]);
		expect(allSkipped(pages)).toContainEqual({
			path: "binary.generated",
			reason: "Binary content was not searched.",
		});
	});

	it("scopes manifests before classifying snapshot blobs", async () => {
		const repository = createRepository();
		writeFixture(repository, "outside/binary.dat", Buffer.from([0, 1, 2, 3]));
		writeFixture(repository, "scope/exact.txt", "scoped needle exact\n");
		writeFixture(repository, "scope/nested/child.txt", "scoped needle child\n");
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "scoped search fixtures");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		writeFileSync(mode, "reject-out-of-scope");

		const exact = await snapshot.search({
			revision: "head",
			prefix: "scope/exact.txt",
			query: "scoped needle",
			limit: 100,
			maxFiles: 200,
		});
		expect(exact.matches.map((match) => match.path)).toEqual(["scope/exact.txt"]);

		const directory = await snapshot.search({
			revision: "head",
			prefix: "scope",
			query: "scoped needle",
			limit: 100,
			maxFiles: 200,
		});
		expect(directory.matches.map((match) => match.path)).toEqual(["scope/exact.txt", "scope/nested/child.txt"]);
		const classificationGreps = readShimArgs(log).filter((args) => grepPattern(args) === "");
		expect(classificationGreps).toHaveLength(2);
		expect(classificationGreps.some((args) => args.includes(":(top,literal)outside/binary.dat"))).toBe(false);
	});

	it("searches non-UTF-8 tree paths through their blob OIDs", async () => {
		const repository = createRepository();
		const invalidPathOid = gitWithInput(repository, "invalid pathname needle\n", "hash-object", "-w", "--stdin");
		const baseOrdinaryOid = gitWithInput(repository, "ordinary before\n", "hash-object", "-w", "--stdin");
		const headOrdinaryOid = gitWithInput(repository, "ordinary after\n", "hash-object", "-w", "--stdin");
		const treeInput = (ordinaryOid: string) =>
			Buffer.concat([
				Buffer.from(`100644 blob ${invalidPathOid}\tinvalid-`, "utf8"),
				Buffer.from([0xff]),
				Buffer.from(`.txt\0` + `100644 blob ${ordinaryOid}\tordinary.txt\0`, "utf8"),
			]);
		const baseTree = gitWithInput(repository, treeInput(baseOrdinaryOid), "mktree", "-z");
		const baseCommit = git(repository, "commit-tree", baseTree, "-m", "invalid path base");
		const headTree = gitWithInput(repository, treeInput(headOrdinaryOid), "mktree", "-z");
		const headCommit = git(repository, "commit-tree", headTree, "-p", baseCommit, "-m", "ordinary change");
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha: headCommit });
		snapshots.push(snapshot);

		const result = await snapshot.search({
			revision: "head",
			query: "pathname needle",
			limit: 100,
			maxFiles: 200,
		});
		expect(result.matches).toEqual([{ path: "invalid-�.txt", line: 1, text: "invalid pathname needle" }]);
		expect(result.skippedPaths).toEqual([]);
	});

	it("searches over-budget tree paths by blob OID without passing them in Git argv", async () => {
		const repository = createRepository();
		const overBudgetPath = `${"p".repeat(24 * 1024)}.txt`;
		const overBudgetOid = gitWithInput(repository, "oversized-name needle\n", "hash-object", "-w", "--stdin");
		const baseOrdinaryOid = gitWithInput(repository, "ordinary before needle\n", "hash-object", "-w", "--stdin");
		const headOrdinaryOid = gitWithInput(repository, "ordinary after needle\n", "hash-object", "-w", "--stdin");
		const treeInput = (ordinaryOid: string) =>
			Buffer.from(
				`100644 blob ${ordinaryOid}\tordinary.txt\0` + `100644 blob ${overBudgetOid}\t${overBudgetPath}\0`,
				"utf8",
			);
		const baseTree = gitWithInput(repository, treeInput(baseOrdinaryOid), "mktree", "-z");
		const baseCommit = git(repository, "commit-tree", baseTree, "-m", "oversized path base");
		const headTree = gitWithInput(repository, treeInput(headOrdinaryOid), "mktree", "-z");
		const headCommit = git(repository, "commit-tree", headTree, "-p", baseCommit, "-m", "ordinary change");
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha: headCommit });
		snapshots.push(snapshot);
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		writeFileSync(mode, "reject-over-budget-pathspec");

		const result = await snapshot.search({
			revision: "head",
			query: "needle",
			limit: 100,
			maxFiles: 200,
		});
		expect(result.matches.map((match) => match.path)).toEqual(["ordinary.txt", overBudgetPath]);
		const grepArgs = readShimArgs(log).filter((args) => args[0] === "grep");
		expect(grepArgs.length).toBeGreaterThan(0);
		expect(grepArgs.some((args) => args.some((arg) => Buffer.byteLength(arg, "utf8") > 24 * 1024))).toBe(false);

		const grepCount = grepArgs.length;
		await expect(
			snapshot.search({
				revision: "head",
				prefix: overBudgetPath,
				query: "needle",
				limit: 100,
				maxFiles: 200,
			}),
		).resolves.toMatchObject({ matches: [{ path: overBudgetPath, line: 1 }] });
		expect(readShimArgs(log).filter((args) => args[0] === "grep")).toHaveLength(grepCount);
	});

	it("reuses manifests and completed results without per-file cold no-match processes", async () => {
		const repository = createRepository();
		for (let index = 0; index < 300; index++) {
			writeFixture(repository, `files/${String(index).padStart(3, "0")}.txt`, "ordinary text\n");
		}
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "search inventory");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);
		const trace = join(repository, "git-trace.log");
		process.env.GIT_TRACE = trace;
		const search = (query: string, fileIndex = 0) =>
			snapshot.search({ revision: "head", query, fileIndex, limit: 100, maxFiles: 200 });

		const firstPage = await search("not-present-cold");
		expect(firstPage).toMatchObject({ filesScanned: 200, nextFileIndex: 200, complete: false });
		const secondPage = await search("not-present-cold", firstPage.nextFileIndex);
		expect(secondPage).toMatchObject({ filesScanned: 101, complete: true });
		const coldTrace = readFileSync(trace, "utf8");
		const coldGreps = coldTrace.split("\n").filter((line) => line.includes("built-in: git grep ")).length;
		expect(coldGreps).toBeGreaterThan(0);
		expect(coldGreps).toBeLessThan(10);
		expect(coldTrace).not.toContain("cat-file blob");
		expect(coldTrace).not.toContain("cat-file --batch");

		await search("not-present-cold");
		expect(readFileSync(trace, "utf8")).toBe(coldTrace);

		await Promise.all([search("concurrent-miss"), search("concurrent-miss")]);
		const concurrentTrace = readFileSync(trace, "utf8");
		const concurrentGreps = concurrentTrace.split("\n").filter((line) => line.includes("built-in: git grep ")).length;
		expect(concurrentGreps - coldGreps).toBeGreaterThan(0);
		expect(concurrentGreps - coldGreps).toBeLessThanOrEqual(2);
	});

	it("fails bounded grep output and failed work without poisoning retries or caches", async () => {
		const repository = createRepository();
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "initial");
		writeFixture(repository, "tracked.txt", "İ after needle\n");
		const snapshot = await resolveSnapshot(repository, { maxMetadataBytes: 1_024, maxBlobBytes: 512 });
		snapshots.push(snapshot);
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		writeFileSync(mode, "fail-once");
		await expect(snapshot.search({ revision: "head", query: "needle", limit: 100, maxFiles: 200 })).rejects.toThrow(
			/git grep failed.*injected grep failure/i,
		);
		await expect(
			snapshot.search({ revision: "head", query: "needle", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [{ path: "tracked.txt", line: 1 }] });
		const afterRetry = readShimArgs(log).length;
		await snapshot.search({ revision: "head", query: "needle", limit: 100, maxFiles: 200 });
		expect(readShimArgs(log)).toHaveLength(afterRetry);

		writeFileSync(mode, "flood");
		await expect(
			snapshot.search({ revision: "head", query: "different", limit: 100, maxFiles: 200 }),
		).rejects.toThrow(/stdout exceeded the 1 KiB capture limit/i);
		rmSync(mode, { force: true });
		await expect(
			snapshot.search({ revision: "head", query: "different", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [] });

		writeFileSync(mode, "fail-pcre");
		await expect(
			snapshot.search({
				revision: "head",
				query: "i",
				ignoreCase: true,
				limit: 100,
				maxFiles: 200,
			}),
		).resolves.toMatchObject({ matches: [{ path: "tracked.txt", line: 1 }] });
		rmSync(mode, { force: true });
	});

	it("bounds aggregate semantic fallback reads", async () => {
		const repository = createRepository();
		const firstFallbackContent = `${"a".repeat(699)}1`;
		writeFixture(repository, "a-duplicate.txt", firstFallbackContent);
		writeFixture(repository, "a.txt", firstFallbackContent);
		writeFixture(repository, "b.txt", `${"b".repeat(699)}2`);
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "fallback inventory");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository, { maxMetadataBytes: 1_024, maxBlobBytes: 1_024 });
		snapshots.push(snapshot);
		const trace = join(repository, "git-trace.log");
		process.env.GIT_TRACE = trace;

		await expect(snapshot.search({ revision: "head", query: "é", limit: 100, maxFiles: 200 })).rejects.toThrow(
			/semantic fallback exceeds the 1 KiB aggregate read limit/i,
		);
		const catFileBatches = readFileSync(trace, "utf8")
			.split("\n")
			.filter((line) => line.includes("built-in: git cat-file --batch"));
		expect(catFileBatches).toHaveLength(1);
	});

	it("isolates caller cancellation, retries cancelled work, and drains searches before disposal", async () => {
		const repository = createRepository();
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "tracked.txt");
		git(repository, "commit", "-m", "initial");
		writeFixture(repository, "tracked.txt", "after needle\n");
		const snapshotTemporaryRoot = mkdtempSync(join(tmpdir(), "volt-review-search-owned-"));
		directories.push(snapshotTemporaryRoot);
		process.env.TMPDIR = snapshotTemporaryRoot;
		process.env.TEMP = snapshotTemporaryRoot;
		process.env.TMP = snapshotTemporaryRoot;
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);
		const snapshotTemporaryDirectories = readdirSync(snapshotTemporaryRoot)
			.filter((entry) => entry.startsWith("volt-review-snapshot-"))
			.map((entry) => join(snapshotTemporaryRoot, entry));
		expect(snapshotTemporaryDirectories).toHaveLength(1);
		const snapshotTemporaryDirectory = snapshotTemporaryDirectories[0];
		if (!snapshotTemporaryDirectory) throw new Error("Expected one owned review snapshot directory.");
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;

		writeFileSync(mode, "delay");
		const manifestController = new AbortController();
		const cancelledManifestWait = snapshot.search({
			revision: "head",
			query: "needle",
			limit: 100,
			maxFiles: 200,
			signal: manifestController.signal,
		});
		await waitForShimArgs(log, (args) => grepPattern(args) === "");
		manifestController.abort();
		await expect(cancelledManifestWait).rejects.toThrow(/aborted/i);
		rmSync(mode, { force: true });
		await expect(
			snapshot.search({ revision: "head", query: "needle", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [{ path: "tracked.txt", line: 1 }] });
		expect(readShimArgs(log).filter((args) => grepPattern(args) === "")).toHaveLength(1);

		writeFileSync(mode, "delay");
		const queryController = new AbortController();
		const cancelledQuery = snapshot.search({
			revision: "head",
			query: "cancelled-query",
			limit: 100,
			maxFiles: 200,
			signal: queryController.signal,
		});
		await waitForShimArgs(log, (args) => grepPattern(args) === "cancelled-query");
		queryController.abort();
		await expect(cancelledQuery).rejects.toThrow(/aborted/i);
		rmSync(mode, { force: true });
		await expect(
			snapshot.search({ revision: "head", query: "cancelled-query", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [] });
		expect(readShimArgs(log).filter((args) => grepPattern(args) === "cancelled-query")).toHaveLength(2);
		const terminationsBeforeBlobReads = readFileSync(log, "utf8").split("term-done\n").length - 1;

		writeFileSync(mode, "delay-batch");
		const batchRequestCount = readShimBatchRequests(log).length;
		const blobController = new AbortController();
		const cancelledBlobRead = snapshot.search({
			revision: "head",
			query: "cancelled-é",
			limit: 100,
			maxFiles: 200,
			signal: blobController.signal,
		});
		await waitForShimBatchRequests(log, batchRequestCount + 1);
		blobController.abort();
		await expect(cancelledBlobRead).rejects.toThrow(/aborted/i);
		rmSync(mode, { force: true });
		await expect(
			snapshot.search({ revision: "head", query: "cancelled-é", limit: 100, maxFiles: 200 }),
		).resolves.toMatchObject({ matches: [] });

		writeFileSync(mode, "delay-batch");
		const disposalBatchCount = readShimBatchRequests(log).length;
		const activeSearch = snapshot.search({
			revision: "head",
			query: "dispose-é",
			limit: 100,
			maxFiles: 200,
		});
		await waitForShimBatchRequests(log, disposalBatchCount + 1);
		const disposal = snapshot.dispose();
		await expect(activeSearch).rejects.toThrow(/aborted/i);
		await disposal;
		if (process.platform !== "win32") {
			const terminationsAfterBlobReads = readFileSync(log, "utf8").split("term-done\n").length - 1;
			expect(terminationsAfterBlobReads - terminationsBeforeBlobReads).toBeGreaterThanOrEqual(2);
		}
		expect(existsSync(snapshotTemporaryDirectory)).toBe(false);
	});
});
