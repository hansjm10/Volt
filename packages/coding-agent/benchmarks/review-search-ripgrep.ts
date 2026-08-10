import { performance } from "node:perf_hooks";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	RipgrepReviewSearch,
	type RipgrepReviewSearchMatch,
	type RipgrepReviewSearchRequest,
} from "../src/core/review-search-ripgrep.ts";
import { type ReviewSnapshot, resolveReviewSnapshot } from "../src/core/review-snapshot.ts";
import { createReviewSnapshotTools, ReviewCoverageTracker } from "../src/core/review-tools.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

interface SearchSummary {
	matches: RipgrepReviewSearchMatch[];
	skippedPaths: Array<{ path: string; reason: string }>;
	pages: number;
	filesScanned: number;
}

interface Measurement {
	wallMs: number;
	cpuMs: number;
	rssDeltaBytes: number;
	result: SearchSummary;
}

interface BenchmarkCase {
	name: string;
	request: Omit<RipgrepReviewSearchRequest, "fileIndex" | "lineIndex" | "limit" | "signal">;
	cacheState: "cold-tree" | "warm-tree" | "warm-result";
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
	const definition = tools.find((candidate) => candidate.name === name);
	if (!definition) throw new Error(`Missing tool ${name}`);
	return definition;
}

async function execute(definition: ToolDefinition, params: unknown) {
	return definition.execute("benchmark", params, undefined, undefined, {} as never);
}

async function currentSearch(snapshot: ReviewSnapshot, request: BenchmarkCase["request"]): Promise<SearchSummary> {
	const search = tool(createReviewSnapshotTools(snapshot, new ReviewCoverageTracker()), "review_search");
	const matches: RipgrepReviewSearchMatch[] = [];
	const skippedPaths: Array<{ path: string; reason: string }> = [];
	let filesScanned = 0;
	let pages = 0;
	let cursor: string | undefined;
	do {
		const result = await execute(search, {
			query: request.query,
			revision: request.revision,
			...(request.prefix ? { path: request.prefix } : {}),
			ignoreCase: request.ignoreCase,
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		const details = result.details as {
			matches: RipgrepReviewSearchMatch[];
			filesScanned: number;
			skippedPaths: Array<{ path: string; reason: string }>;
			nextCursor?: string;
		};
		matches.push(...details.matches);
		skippedPaths.push(...details.skippedPaths);
		filesScanned += details.filesScanned;
		pages++;
		cursor = details.nextCursor;
	} while (cursor);
	return { matches, skippedPaths, pages, filesScanned };
}

async function ripgrepSearch(search: RipgrepReviewSearch, request: BenchmarkCase["request"]): Promise<SearchSummary> {
	const matches: RipgrepReviewSearchMatch[] = [];
	const skippedPaths: Array<{ path: string; reason: string }> = [];
	let filesScanned = 0;
	let pages = 0;
	let fileIndex = 0;
	let lineIndex = 0;
	let complete = false;
	while (!complete) {
		const page = await search.page({ ...request, fileIndex, lineIndex, limit: 100 });
		matches.push(...page.matches);
		skippedPaths.push(...page.skippedPaths);
		filesScanned += page.filesScanned;
		pages++;
		complete = page.complete;
		fileIndex = page.nextFileIndex;
		lineIndex = page.nextLineIndex;
	}
	return { matches, skippedPaths, pages, filesScanned };
}

async function measure(run: () => Promise<SearchSummary>): Promise<Measurement> {
	const rssBefore = process.memoryUsage.rss();
	const cpuBefore = process.cpuUsage();
	const started = performance.now();
	const result = await run();
	const wallMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuBefore);
	return {
		wallMs: Number(wallMs.toFixed(2)),
		cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
		rssDeltaBytes: process.memoryUsage.rss() - rssBefore,
		result,
	};
}

function resultCounts(result: SearchSummary) {
	return {
		matches: result.matches.length,
		skippedPaths: result.skippedPaths.length,
		pages: result.pages,
		filesScanned: result.filesScanned,
	};
}

function assertEquivalent(name: string, current: SearchSummary, ripgrep: SearchSummary): void {
	if (JSON.stringify(current) !== JSON.stringify(ripgrep)) {
		throw new Error(
			`${name} output mismatch: current=${JSON.stringify(resultCounts(current))}, ripgrep=${JSON.stringify(resultCounts(ripgrep))}`,
		);
	}
}

const rgPath = await ensureTool("rg", true);
if (!rgPath) throw new Error("ripgrep is required for this benchmark");
const resolved = await resolveReviewSnapshot({ kind: "commit", sha: "HEAD" }, process.cwd(), {
	maxCommitRefBytes: 1_024,
	maxPullRequestNumber: 2_147_483_647,
});
if ("error" in resolved) throw new Error(resolved.error);
const snapshot = resolved;
const ripgrep = new RipgrepReviewSearch(snapshot, rgPath);
const benchmarkPrefix = process.argv[2] ?? "packages/coding-agent/src/core/tools";
const cases: BenchmarkCase[] = [
	{
		name: "head-no-match-cold-full-tree",
		request: {
			query: "volt-review-search-ripgrep-definitely-absent-7cb7db38",
			revision: "head",
			ignoreCase: false,
		},
		cacheState: "cold-tree",
	},
	{
		name: "head-rare-warm-tree",
		request: { query: "createGrepTool", revision: "head", prefix: benchmarkPrefix, ignoreCase: false },
		cacheState: "warm-tree",
	},
	{
		name: "head-dense-warm-tree",
		request: { query: "import", revision: "head", prefix: benchmarkPrefix, ignoreCase: false },
		cacheState: "warm-tree",
	},
	{
		name: "base-rare-cold",
		request: { query: "createGrepTool", revision: "base", prefix: benchmarkPrefix, ignoreCase: false },
		cacheState: "cold-tree",
	},
	{
		name: "head-rare-repeated",
		request: { query: "createGrepTool", revision: "head", prefix: benchmarkPrefix, ignoreCase: false },
		cacheState: "warm-result",
	},
];

try {
	const results = [];
	for (const benchmarkCase of cases) {
		console.error(`Running ${benchmarkCase.name}...`);
		const current = await measure(() => currentSearch(snapshot, benchmarkCase.request));
		const rg = await measure(() => ripgrepSearch(ripgrep, benchmarkCase.request));
		assertEquivalent(benchmarkCase.name, current.result, rg.result);
		results.push({
			name: benchmarkCase.name,
			cacheState: benchmarkCase.cacheState,
			current: { ...current, result: resultCounts(current.result) },
			ripgrep: { ...rg, result: resultCounts(rg.result) },
			speedup: Number((current.wallMs / rg.wallMs).toFixed(2)),
		});
	}
	const [base, head] = await Promise.all([snapshot.materializeSearch("base"), snapshot.materializeSearch("head")]);
	console.log(
		JSON.stringify(
			{
				repository: snapshot.root,
				scopedPrefix: benchmarkPrefix,
				trees: { base: snapshot.identity.baseTree, head: snapshot.identity.headTree },
				materialization: {
					base: { files: base.materializedFiles, bytes: base.materializedBytes },
					head: { files: head.materializedFiles, bytes: head.materializedBytes },
				},
				ripgrepStats: ripgrep.stats(),
				results,
			},
			null,
			2,
		),
	);
} finally {
	await snapshot.dispose();
}
