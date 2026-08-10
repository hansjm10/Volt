import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runRipgrepJson } from "../utils/ripgrep.ts";
import {
	normalizeReviewPath,
	pathWithinRoot,
	type ReviewSnapshot,
	type ReviewSnapshotRevision,
	type ReviewSnapshotSearchEntry,
} from "./review-snapshot.ts";
import { REVIEW_TOOL_MAX_SEARCH_FILES_PER_PAGE } from "./review-tools.ts";

export interface RipgrepReviewSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface RipgrepReviewSearchPage {
	matches: RipgrepReviewSearchMatch[];
	filesScanned: number;
	skippedPaths: Array<{ path: string; reason: string }>;
	complete: boolean;
	nextFileIndex: number;
	nextLineIndex: number;
}

export interface RipgrepReviewSearchRequest {
	query: string;
	revision: ReviewSnapshotRevision;
	prefix?: string;
	ignoreCase: boolean;
	fileIndex: number;
	lineIndex: number;
	limit: number;
	signal?: AbortSignal;
}

export interface RipgrepReviewSearchStats {
	ripgrepRuns: number;
	resultCacheHits: number;
	cachedQueries: number;
}

interface CachedSearch {
	entries: ReviewSnapshotSearchEntry[];
	matchesByPath: Map<string, RipgrepReviewSearchMatch[]>;
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

export class RipgrepReviewSearch {
	private readonly snapshot: ReviewSnapshot;
	private readonly ripgrepPath: string;
	private readonly cache = new Map<string, Promise<CachedSearch>>();
	private ripgrepRuns = 0;
	private resultCacheHits = 0;

	constructor(snapshot: ReviewSnapshot, ripgrepPath: string) {
		this.snapshot = snapshot;
		this.ripgrepPath = ripgrepPath;
	}

	async page(request: RipgrepReviewSearchRequest): Promise<RipgrepReviewSearchPage> {
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
		const matches: RipgrepReviewSearchMatch[] = [];
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
			const lineCount = entry.lineCount ?? 0;
			if (matches.length < request.limit || nextLineIndex >= lineCount) {
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

	stats(): RipgrepReviewSearchStats {
		return {
			ripgrepRuns: this.ripgrepRuns,
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
		const materialized = await this.snapshot.materializeSearch(revision);
		throwIfAborted(signal);
		const entries = materialized.entries.filter(
			(entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`),
		);
		const searchableEntries = entries.filter((entry) => entry.skippedReason === undefined);
		const matchesByPath = new Map<string, RipgrepReviewSearchMatch[]>();
		if (query.includes("\n") || searchableEntries.length === 0) return { entries, matchesByPath };

		const requiresJavascriptOnly = query.includes("\0");
		if (!requiresJavascriptOnly) {
			const searchPath = prefix ? join(materialized.directory, ...prefix.split("/")) : materialized.directory;
			if (!pathWithinRoot(materialized.directory, searchPath)) {
				throw new Error("Review search path escaped the materialized snapshot.");
			}
			const args = [
				"--json",
				"--line-number",
				"--color=never",
				"--no-config",
				"--hidden",
				"--no-ignore",
				"--no-follow",
				"--text",
				"--fixed-strings",
				...(ignoreCase ? ["--ignore-case"] : []),
				"--",
				query,
				searchPath,
			];
			const entryPaths = new Set(entries.map((entry) => entry.path));
			const deduplicated = new Set<string>();
			const needle = ignoreCase ? query.toLocaleLowerCase() : query;
			this.ripgrepRuns++;
			const result = await runRipgrepJson(this.ripgrepPath, args, {
				...(signal ? { signal } : {}),
				onMatch: (match) => {
					const absolutePath = isAbsolute(match.path) ? match.path : resolve(materialized.directory, match.path);
					if (!pathWithinRoot(materialized.directory, absolutePath)) {
						throw new Error(`ripgrep returned a path outside the review snapshot: ${match.path}`);
					}
					const path = relative(materialized.directory, absolutePath).replaceAll("\\", "/");
					if (!entryPaths.has(path) || match.lineText === undefined) return undefined;
					const identity = `${path}\0${match.lineNumber}`;
					if (deduplicated.has(identity)) return undefined;
					const line = match.lineText.endsWith("\n") ? match.lineText.slice(0, -1) : match.lineText;
					const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
					if (!haystack.includes(needle)) return undefined;
					deduplicated.add(identity);
					const fileMatches = matchesByPath.get(path) ?? [];
					fileMatches.push({ path, line: match.lineNumber, text: line.slice(0, 500) });
					matchesByPath.set(path, fileMatches);
					return undefined;
				},
			});
			if (result.exitCode !== 0 && result.exitCode !== 1) {
				throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
			}
		}

		const javascriptEntries = requiresJavascriptOnly
			? searchableEntries
			: ignoreCase
				? /[^\x00-\x7f]/u.test(query)
					? searchableEntries
					: searchableEntries.filter((entry) => entry.ascii === false)
				: [];
		await this.scanWithJavascript(
			materialized.directory,
			javascriptEntries,
			query,
			ignoreCase,
			signal,
			matchesByPath,
		);
		for (const [path, matches] of matchesByPath) {
			matches.sort((left, right) => left.line - right.line);
			matchesByPath.set(path, matches);
		}
		return { entries, matchesByPath };
	}

	private async scanWithJavascript(
		directory: string,
		entries: ReviewSnapshotSearchEntry[],
		query: string,
		ignoreCase: boolean,
		signal: AbortSignal | undefined,
		matchesByPath: Map<string, RipgrepReviewSearchMatch[]>,
	): Promise<void> {
		const needle = ignoreCase ? query.toLocaleLowerCase() : query;
		for (const entry of entries) {
			throwIfAborted(signal);
			matchesByPath.delete(entry.path);
			const filePath = join(directory, ...entry.path.split("/"));
			if (!pathWithinRoot(directory, filePath)) {
				throw new Error(`Review search path escaped the materialized snapshot: ${entry.path}`);
			}
			const lines = (await readFile(filePath, "utf8")).split("\n");
			const matches: RipgrepReviewSearchMatch[] = [];
			for (const [index, line] of lines.entries()) {
				const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
				if (haystack.includes(needle))
					matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
			}
			if (matches.length > 0) matchesByPath.set(entry.path, matches);
		}
	}
}
