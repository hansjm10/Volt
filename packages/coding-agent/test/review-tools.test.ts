import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";
import { createReviewSnapshotTools, ReviewCoverageTracker } from "../src/core/review-tools.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

describe("review snapshot tools", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(): Promise<{
		snapshot: ReviewSnapshot;
		tracker: ReviewCoverageTracker;
		tools: ToolDefinition[];
	}> {
		const directory = join(tmpdir(), `volt-review-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(directory, "src"), { recursive: true });
		directories.push(directory);
		git(directory, "init", "--initial-branch=main");
		git(directory, "config", "user.email", "review@example.com");
		git(directory, "config", "user.name", "Review Test");
		writeFileSync(join(directory, "src", "one.ts"), "export const one = 1;\n");
		writeFileSync(join(directory, "src", "two.ts"), "export const two = 2;\n");
		git(directory, "add", "src");
		git(directory, "commit", "-m", "initial");
		writeFileSync(join(directory, "src", "one.ts"), `export const one = "${"x".repeat(200)}";\n`);
		writeFileSync(join(directory, "src", "two.ts"), "export const two = one + 2;\nexport const three = one + 2;\n");
		const resolved = await resolveReviewSnapshot({ kind: "uncommitted" }, directory, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: 2_147_483_647,
		});
		if ("error" in resolved) throw new Error(resolved.error);
		snapshots.push(resolved);
		const tracker = new ReviewCoverageTracker();
		return { snapshot: resolved, tracker, tools: createReviewSnapshotTools(resolved, tracker) };
	}

	function tool(tools: ToolDefinition[], name: string): ToolDefinition {
		const definition = tools.find((candidate) => candidate.name === name);
		if (!definition) throw new Error(`Missing tool ${name}`);
		return definition;
	}

	async function execute(definition: ToolDefinition, params: unknown, signal?: AbortSignal) {
		return definition.execute("call", params, signal, undefined, {} as never);
	}

	function resultText(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
		return result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n");
	}

	it("pages changed files and requires full per-file diff coverage", async () => {
		const { snapshot, tracker, tools } = await setup();
		const changed = tool(tools, "review_changed_files");
		const first = await execute(changed, { limit: 1 });
		const firstDetails = first.details as { nextCursor?: string };
		expect(firstDetails.nextCursor).toBeTruthy();
		expect(tracker.snapshot().changedFileInventoryComplete).toBe(false);
		await execute(changed, { cursor: firstDetails.nextCursor, limit: 1 });
		expect(tracker.snapshot().changedFileInventoryComplete).toBe(true);

		const diff = tool(tools, "review_diff");
		let cursor: string | undefined;
		do {
			const page = await execute(diff, { path: "src/one.ts", ...(cursor ? { cursor } : {}), maxBytes: 64 });
			cursor = (page.details as { nextCursor?: string }).nextCursor;
		} while (cursor);
		const coverage = tracker.snapshot();
		expect(coverage.diffFilesFullyRead).toEqual(["src/one.ts"]);
		expect(coverage.hunksInspected).toEqual(
			snapshot.changedFiles.find((file) => file.path === "src/one.ts")?.hunks.map((hunk) => hunk.id),
		);
	});

	it("reads base/head files and searches the immutable snapshot", async () => {
		const { tracker, tools } = await setup();
		const read = tool(tools, "review_file");
		expect(resultText(await execute(read, { path: "src/one.ts", revision: "base" }))).toContain(
			"1: export const one = 1;",
		);
		expect(resultText(await execute(read, { path: "src/one.ts", revision: "head" }))).toContain(
			'1: export const one = "xxx',
		);
		let searchCursor: string | undefined;
		const searchLines: number[] = [];
		do {
			const search = await execute(tool(tools, "review_search"), {
				query: "one + 2",
				path: "src",
				revision: "head",
				limit: 1,
				...(searchCursor ? { cursor: searchCursor } : {}),
			});
			const details = search.details as { matches: Array<{ line: number }>; nextCursor?: string };
			searchLines.push(...details.matches.map((match) => match.line));
			searchCursor = details.nextCursor;
		} while (searchCursor);
		expect(searchLines).toEqual([1, 2]);
		expect(tracker.snapshot()).toMatchObject({ filesRead: ["src/one.ts"], searchesRun: 3 });
	});

	it("binds opaque cursors to a tool operation and snapshot", async () => {
		const { tools } = await setup();
		const page = await execute(tool(tools, "review_changed_files"), { limit: 1 });
		const cursor = (page.details as { nextCursor?: string }).nextCursor;
		await expect(execute(tool(tools, "review_tree"), { cursor })).rejects.toThrow(/another operation/);
		if (!cursor) throw new Error("Expected a cursor");
		const tampered = `${cursor.slice(0, -1)}x`;
		await expect(execute(tool(tools, "review_changed_files"), { cursor: tampered })).rejects.toThrow(/invalid/);

		const search = await execute(tool(tools, "review_search"), {
			query: "one + 2",
			path: "src",
			revision: "head",
			ignoreCase: false,
			limit: 1,
		});
		const searchCursor = (search.details as { nextCursor?: string }).nextCursor;
		if (!searchCursor) throw new Error("Expected a search cursor");
		await expect(
			execute(tool(tools, "review_search"), {
				query: "one + 2",
				path: "other",
				revision: "head",
				ignoreCase: false,
				cursor: searchCursor,
			}),
		).rejects.toThrow(/path does not match/);
		await expect(
			execute(tool(tools, "review_search"), {
				query: "one + 2",
				path: "src",
				revision: "base",
				ignoreCase: false,
				cursor: searchCursor,
			}),
		).rejects.toThrow(/revision does not match/);

		const tree = await execute(tool(tools, "review_tree"), { prefix: "src", revision: "head", limit: 1 });
		const treeCursor = (tree.details as { nextCursor?: string }).nextCursor;
		if (!treeCursor) throw new Error("Expected a tree cursor");
		await expect(
			execute(tool(tools, "review_tree"), { prefix: "other", revision: "head", cursor: treeCursor }),
		).rejects.toThrow(/prefix does not match/);
	});

	it("rejects unsafe paths and aborts without reading", async () => {
		const { tools } = await setup();
		await expect(execute(tool(tools, "review_file"), { path: "../secret" })).rejects.toThrow(/traverse/);
		const controller = new AbortController();
		controller.abort();
		await expect(execute(tool(tools, "review_tree"), {}, controller.signal)).rejects.toThrow(/aborted/);
	});
});
