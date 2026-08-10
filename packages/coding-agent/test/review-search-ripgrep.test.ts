import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	RipgrepReviewSearch,
	type RipgrepReviewSearchMatch,
	type RipgrepReviewSearchRequest,
} from "../src/core/review-search-ripgrep.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";
import { createReviewSnapshotTools, ReviewCoverageTracker } from "../src/core/review-tools.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

interface ComparablePage {
	matches: RipgrepReviewSearchMatch[];
	filesScanned: number;
	skippedPaths: Array<{ path: string; reason: string }>;
	complete: boolean;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
	const definition = tools.find((candidate) => candidate.name === name);
	if (!definition) throw new Error(`Missing tool ${name}`);
	return definition;
}

async function execute(definition: ToolDefinition, params: unknown) {
	return definition.execute("call", params, undefined, undefined, {} as never);
}

function addSymlink(repository: string, path: string, target: string): void {
	try {
		symlinkSync(target, join(repository, path));
		git(repository, "add", "--", path);
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

async function currentPages(
	snapshot: ReviewSnapshot,
	request: Omit<RipgrepReviewSearchRequest, "fileIndex" | "lineIndex" | "signal">,
): Promise<ComparablePage[]> {
	const search = tool(createReviewSnapshotTools(snapshot, new ReviewCoverageTracker()), "review_search");
	const pages: ComparablePage[] = [];
	let cursor: string | undefined;
	do {
		const result = await execute(search, {
			query: request.query,
			revision: request.revision,
			...(request.prefix ? { path: request.prefix } : {}),
			ignoreCase: request.ignoreCase,
			limit: request.limit,
			...(cursor ? { cursor } : {}),
		});
		const details = result.details as {
			matches: RipgrepReviewSearchMatch[];
			filesScanned: number;
			skippedPaths: Array<{ path: string; reason: string }>;
			nextCursor?: string;
		};
		cursor = details.nextCursor;
		pages.push({
			matches: details.matches,
			filesScanned: details.filesScanned,
			skippedPaths: details.skippedPaths,
			complete: cursor === undefined,
		});
	} while (cursor);
	return pages;
}

async function ripgrepPages(
	search: RipgrepReviewSearch,
	request: Omit<RipgrepReviewSearchRequest, "fileIndex" | "lineIndex" | "signal">,
): Promise<ComparablePage[]> {
	const pages: ComparablePage[] = [];
	let fileIndex = 0;
	let lineIndex = 0;
	do {
		const page = await search.page({ ...request, fileIndex, lineIndex });
		pages.push({
			matches: page.matches,
			filesScanned: page.filesScanned,
			skippedPaths: page.skippedPaths,
			complete: page.complete,
		});
		fileIndex = page.nextFileIndex;
		lineIndex = page.nextLineIndex;
	} while (!pages.at(-1)?.complete);
	return pages;
}

const ripgrepPath = getToolPath("rg");

describe.skipIf(!ripgrepPath)("ripgrep review search proof of concept", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(): Promise<ReviewSnapshot> {
		const directory = join(tmpdir(), `volt-review-search-rg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(directory, "src"), { recursive: true });
		directories.push(directory);
		git(directory, "init", "--initial-branch=main");
		git(directory, "config", "user.email", "review@example.com");
		git(directory, "config", "user.name", "Review Test");
		writeFileSync(join(directory, ".gitignore"), "*.log\n");
		writeFileSync(join(directory, ".hidden.txt"), "Needle hidden\n");
		writeFileSync(join(directory, "src", "one.ts"), "Needle base\nother\n");
		writeFileSync(join(directory, "src", "two.ts"), "needle two\nneedle three\n");
		writeFileSync(join(directory, "tracked.log"), "Needle ignored\n");
		writeFileSync(join(directory, "unicode.txt"), "İ\nΟΣ\n");
		writeFileSync(join(directory, "crlf.txt"), "Needle CRLF\r\n");
		writeFileSync(join(directory, "invalid-utf8.txt"), Buffer.from([0x66, 0x80, 0x6f, 0x0a]));
		writeFileSync(join(directory, "late-nul.txt"), Buffer.concat([Buffer.alloc(8_192, 97), Buffer.from("\0tail\n")]));
		writeFileSync(join(directory, "large.txt"), "x".repeat(20_000));
		writeFileSync(join(directory, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		git(
			directory,
			"add",
			".gitignore",
			".hidden.txt",
			"src",
			"unicode.txt",
			"crlf.txt",
			"invalid-utf8.txt",
			"late-nul.txt",
			"large.txt",
			"binary.dat",
		);
		git(directory, "add", "--force", "tracked.log");
		addSymlink(directory, "link.txt", "src/one.ts");
		git(directory, "commit", "-m", "fixtures");
		writeFileSync(join(directory, "src", "one.ts"), "Needle head\nother\n");
		const resolved = await resolveReviewSnapshot({ kind: "uncommitted" }, directory, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: 2_147_483_647,
			limits: { maxBlobBytes: 10_000 },
		});
		if ("error" in resolved) throw new Error(resolved.error);
		snapshots.push(resolved);
		return resolved;
	}

	it("matches current paging, hidden/ignored behavior, and skip reporting", async () => {
		const snapshot = await setup();
		const search = new RipgrepReviewSearch(snapshot, ripgrepPath!);
		const cases: Array<Omit<RipgrepReviewSearchRequest, "fileIndex" | "lineIndex" | "signal">> = [
			{ query: "needle", revision: "head", ignoreCase: true, limit: 1 },
			{ query: "Needle base", revision: "base", ignoreCase: false, limit: 2 },
			{ query: "Needle hidden", revision: "head", prefix: ".hidden.txt", ignoreCase: false, limit: 1 },
			{ query: "Needle ignored", revision: "head", prefix: "tracked.log", ignoreCase: false, limit: 1 },
			{ query: "src/one.ts", revision: "head", prefix: "link.txt", ignoreCase: false, limit: 1 },
			{ query: "x", revision: "head", prefix: "binary.dat", ignoreCase: false, limit: 1 },
			{ query: "x", revision: "head", prefix: "large.txt", ignoreCase: false, limit: 1 },
			{ query: "\0tail", revision: "head", prefix: "late-nul.txt", ignoreCase: false, limit: 1 },
			{ query: "i̇", revision: "head", prefix: "unicode.txt", ignoreCase: true, limit: 1 },
			{ query: "οσ", revision: "head", prefix: "unicode.txt", ignoreCase: true, limit: 1 },
			{ query: "CRLF\r", revision: "head", prefix: "crlf.txt", ignoreCase: false, limit: 1 },
			{ query: "�", revision: "head", prefix: "invalid-utf8.txt", ignoreCase: false, limit: 1 },
			{ query: "missing", revision: "head", ignoreCase: false, limit: 3 },
			{ query: "Needle\nhead", revision: "head", ignoreCase: false, limit: 1 },
		];
		for (const request of cases) {
			expect(await ripgrepPages(search, request), JSON.stringify(request)).toEqual(
				await currentPages(snapshot, request),
			);
		}
	});

	it("materializes raw tracked text once without Git metadata or symlinks", async () => {
		const snapshot = await setup();
		const first = await snapshot.materializeSearch("head");
		const second = await snapshot.materializeSearch("head");
		expect(second).toBe(first);
		expect(existsSync(join(first.directory, ".git"))).toBe(false);
		expect(readFileSync(join(first.directory, "tracked.log"), "utf8")).toBe("Needle ignored\n");
		expect(lstatSync(join(first.directory, "link.txt")).isFile()).toBe(true);
		expect(readFileSync(join(first.directory, "link.txt"), "utf8")).toBe("src/one.ts");
		expect(existsSync(join(first.directory, "binary.dat"))).toBe(false);
		expect(existsSync(join(first.directory, "large.txt"))).toBe(false);
		expect(first.entries.find((entry) => entry.path === "binary.dat")?.skippedReason).toMatch(/binary/i);
		expect(first.entries.find((entry) => entry.path === "large.txt")?.skippedReason).toMatch(/10000 bytes/i);
		expect(first.materializedFiles).toBeGreaterThan(0);
		expect(first.materializedBytes).toBeGreaterThan(0);
	});

	it("reuses the cached ripgrep result for repeated pages and searches", async () => {
		const snapshot = await setup();
		const search = new RipgrepReviewSearch(snapshot, ripgrepPath!);
		const request = { query: "needle", revision: "head" as const, ignoreCase: true, limit: 1 };
		await ripgrepPages(search, request);
		const afterFirst = search.stats();
		await ripgrepPages(search, request);
		const afterSecond = search.stats();
		expect(afterFirst.ripgrepRuns).toBe(1);
		expect(afterSecond.ripgrepRuns).toBe(1);
		expect(afterSecond.resultCacheHits).toBeGreaterThan(afterFirst.resultCacheHits);
	});
});
