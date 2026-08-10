import {
	normalizeReviewPath,
	type ReviewSnapshot,
	type ReviewSnapshotRevision,
	type ReviewSnapshotSearchEntry,
} from "./review-snapshot.ts";
import { REVIEW_TOOL_MAX_SEARCH_FILES_PER_PAGE } from "./review-tools.ts";

export interface GitGrepReviewSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface GitGrepReviewSearchPage {
	matches: GitGrepReviewSearchMatch[];
	filesScanned: number;
	skippedPaths: Array<{ path: string; reason: string }>;
	complete: boolean;
	nextFileIndex: number;
	nextLineIndex: number;
}

export interface GitGrepReviewSearchRequest {
	query: string;
	revision: ReviewSnapshotRevision;
	prefix?: string;
	ignoreCase: boolean;
	fileIndex: number;
	lineIndex: number;
	limit: number;
	signal?: AbortSignal;
}

export interface GitGrepReviewSearchStats {
	gitGrepRuns: number;
	javascriptFallbackRuns: number;
	resultCacheHits: number;
	cachedQueries: number;
}

interface CachedSearch {
	entries: ReviewSnapshotSearchEntry[];
	matchesByPath: Map<string, GitGrepReviewSearchMatch[]>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Review inspection was aborted.");
}

function cacheKey(
	revision: ReviewSnapshotRevision,
	prefix: string | undefined,
	query: string,
	ignoreCase: boolean,
): string {
	return JSON.stringify([revision, prefix ?? null, query, ignoreCase]);
}

export class GitGrepReviewSearch {
	private readonly snapshot: ReviewSnapshot;
	private readonly cache = new Map<string, Promise<CachedSearch>>();
	private readonly lineCounts = new Map<string, Promise<number>>();
	private gitGrepRuns = 0;
	private javascriptFallbackRuns = 0;
	private resultCacheHits = 0;

	constructor(snapshot: ReviewSnapshot) {
		this.snapshot = snapshot;
	}

	async page(request: GitGrepReviewSearchRequest): Promise<GitGrepReviewSearchPage> {
		throwIfAborted(request.signal);
		if (!Number.isSafeInteger(request.fileIndex) || request.fileIndex < 0) {
			throw new Error("Search file index must be a non-negative integer.");
		}
		if (!Number.isSafeInteger(request.lineIndex) || request.lineIndex < 0) {
			throw new Error("Search line index must be a non-negative integer.");
		}
		if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
			throw new Error("Search limit must be a positive integer.");
		}
		const prefix = request.prefix ? normalizeReviewPath(request.prefix) : undefined;
		const search = await this.search(request.revision, prefix, request.query, request.ignoreCase, request.signal);
		throwIfAborted(request.signal);
		const matches: GitGrepReviewSearchMatch[] = [];
		const skippedPaths: Array<{ path: string; reason: string }> = [];
		let nextFileIndex = request.fileIndex;
		let nextLineIndex = request.lineIndex;
		let filesScanned = 0;

		while (
			nextFileIndex < search.entries.length &&
			filesScanned < REVIEW_TOOL_MAX_SEARCH_FILES_PER_PAGE &&
			matches.length < request.limit
		) {
			throwIfAborted(request.signal);
			const entry = search.entries[nextFileIndex];
			filesScanned++;
			if (entry.skippedReason !== undefined) {
				skippedPaths.push({ path: entry.path, reason: entry.skippedReason });
				nextFileIndex++;
				nextLineIndex = 0;
				continue;
			}

			const fileMatches = search.matchesByPath.get(entry.path) ?? [];
			for (const match of fileMatches) {
				if (match.line <= nextLineIndex) continue;
				matches.push(match);
				nextLineIndex = match.line;
				if (matches.length >= request.limit) break;
			}
			if (matches.length < request.limit) {
				nextFileIndex++;
				nextLineIndex = 0;
				continue;
			}
			const lineCount = await this.lineCount(request.revision, entry.path);
			if (nextLineIndex >= lineCount) {
				nextFileIndex++;
				nextLineIndex = 0;
			}
		}

		return {
			matches,
			filesScanned,
			skippedPaths,
			complete: nextFileIndex >= search.entries.length,
			nextFileIndex,
			nextLineIndex,
		};
	}

	stats(): GitGrepReviewSearchStats {
		return {
			gitGrepRuns: this.gitGrepRuns,
			javascriptFallbackRuns: this.javascriptFallbackRuns,
			resultCacheHits: this.resultCacheHits,
			cachedQueries: this.cache.size,
		};
	}

	private async search(
		revision: ReviewSnapshotRevision,
		prefix: string | undefined,
		query: string,
		ignoreCase: boolean,
		signal: AbortSignal | undefined,
	): Promise<CachedSearch> {
		const key = cacheKey(revision, prefix, query, ignoreCase);
		const cached = this.cache.get(key);
		if (cached) {
			this.resultCacheHits++;
			return cached;
		}
		const result = this.runSearch(revision, prefix, query, ignoreCase, signal);
		this.cache.set(key, result);
		try {
			return await result;
		} catch (error) {
			this.cache.delete(key);
			throw error;
		}
	}

	private async runSearch(
		revision: ReviewSnapshotRevision,
		prefix: string | undefined,
		query: string,
		ignoreCase: boolean,
		signal: AbortSignal | undefined,
	): Promise<CachedSearch> {
		const manifest = await this.snapshot.inspectSearch(revision);
		throwIfAborted(signal);
		const entries = manifest.entries.filter(
			(entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`),
		);
		const matchesByPath = new Map<string, GitGrepReviewSearchMatch[]>();
		if (query.includes("\n") || entries.every((entry) => entry.skippedReason !== undefined)) {
			return { entries, matchesByPath };
		}
		if (query.includes("\0") || /[^\x00-\x7f]/u.test(query)) {
			this.javascriptFallbackRuns++;
			await this.scanWithJavascript(revision, entries, query, ignoreCase, signal, matchesByPath);
			return { entries, matchesByPath };
		}

		this.gitGrepRuns++;
		const results = await this.snapshot.gitGrep({
			revision,
			query,
			...(prefix ? { prefix } : {}),
			...(ignoreCase ? { ignoreCase: true } : {}),
			...(signal ? { signal } : {}),
		});
		const searchablePaths = new Set(
			entries.filter((entry) => entry.skippedReason === undefined).map((entry) => entry.path),
		);
		for (const match of results) {
			if (!searchablePaths.has(match.path)) continue;
			const fileMatches = matchesByPath.get(match.path) ?? [];
			fileMatches.push(match);
			matchesByPath.set(match.path, fileMatches);
		}
		const javascriptEntries = entries.filter(
			(entry) =>
				entry.skippedReason === undefined && (entry.mode === "120000" || (ignoreCase && entry.ascii !== true)),
		);
		if (javascriptEntries.length > 0) {
			this.javascriptFallbackRuns++;
			await this.scanWithJavascript(revision, javascriptEntries, query, ignoreCase, signal, matchesByPath);
		}
		for (const matches of matchesByPath.values()) matches.sort((left, right) => left.line - right.line);
		return { entries, matchesByPath };
	}

	private async scanWithJavascript(
		revision: ReviewSnapshotRevision,
		entries: ReviewSnapshotSearchEntry[],
		query: string,
		ignoreCase: boolean,
		signal: AbortSignal | undefined,
		matchesByPath: Map<string, GitGrepReviewSearchMatch[]>,
	): Promise<void> {
		const needle = ignoreCase ? query.toLocaleLowerCase() : query;
		for (const entry of entries) {
			throwIfAborted(signal);
			if (entry.skippedReason !== undefined) continue;
			matchesByPath.delete(entry.path);
			const file = await this.snapshot.readFile(revision, entry.path);
			if (!file?.available || file.binary) continue;
			const lines = file.content.toString("utf8").split("\n");
			this.lineCounts.set(`${revision}\0${entry.path}`, Promise.resolve(lines.length));
			const matches: GitGrepReviewSearchMatch[] = [];
			for (const [index, line] of lines.entries()) {
				const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
				if (haystack.includes(needle))
					matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
			}
			if (matches.length > 0) matchesByPath.set(entry.path, matches);
		}
	}

	private async lineCount(revision: ReviewSnapshotRevision, path: string): Promise<number> {
		const key = `${revision}\0${path}`;
		const cached = this.lineCounts.get(key);
		if (cached) return cached;
		const result = (async () => {
			const file = await this.snapshot.readFile(revision, path);
			if (!file?.available || file.binary) throw new Error(`Could not read git grep match path ${path}.`);
			return file.content.toString("utf8").split("\n").length;
		})();
		this.lineCounts.set(key, result);
		try {
			return await result;
		} catch (error) {
			this.lineCounts.delete(key);
			throw error;
		}
	}
}
