import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import {
	normalizeReviewPath,
	pageUtf8,
	type ReviewChangedFile,
	type ReviewSnapshot,
	type ReviewSnapshotRevision,
	type ReviewSnapshotTreeEntry,
} from "./review-snapshot.ts";

export const REVIEW_SNAPSHOT_TOOL_NAMES = [
	"review_changed_files",
	"review_diff",
	"review_file",
	"review_search",
	"review_tree",
] as const;

export const REVIEW_TOOL_DEFAULT_PAGE_BYTES = 32 * 1024;
export const REVIEW_TOOL_MAX_PAGE_BYTES = 64 * 1024;
export const REVIEW_TOOL_MAX_LIST_ENTRIES = 100;
export const REVIEW_TOOL_MAX_SEARCH_MATCHES = 100;
export const REVIEW_TOOL_MAX_SEARCH_FILES_PER_PAGE = 200;

interface CursorPayload {
	kind: string;
	snapshot: string;
	state: Record<string, string | number | boolean | null>;
}

interface DiffCoverageState {
	totalBytes: number;
	intervals: Array<{ start: number; end: number }>;
	hunkIds: string[];
}

export interface ReviewObservedCoverage {
	changedFileInventoryComplete: boolean;
	filesRead: string[];
	hunksInspected: string[];
	searchesRun: number;
	treePagesRead: number;
	diffFilesFullyRead: string[];
}

export class ReviewCoverageTracker {
	private changedFileInventoryCompleteValue = false;
	private readonly filesReadValue = new Set<string>();
	private readonly hunksInspectedValue = new Set<string>();
	private readonly diffCoverage = new Map<string, DiffCoverageState>();
	private searchesRunValue = 0;
	private treePagesReadValue = 0;

	recordChangedFilePage(complete: boolean): void {
		if (complete) this.changedFileInventoryCompleteValue = true;
	}

	recordFile(path: string): void {
		this.filesReadValue.add(path);
	}

	recordDiffPage(path: string, start: number, end: number, totalBytes: number, hunkIds: string[]): void {
		const current = this.diffCoverage.get(path) ?? { totalBytes, intervals: [], hunkIds };
		current.totalBytes = totalBytes;
		current.hunkIds = hunkIds;
		current.intervals.push({ start, end });
		current.intervals.sort((left, right) => left.start - right.start);
		const merged: Array<{ start: number; end: number }> = [];
		for (const interval of current.intervals) {
			const previous = merged.at(-1);
			if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
			else merged.push({ ...interval });
		}
		current.intervals = merged;
		this.diffCoverage.set(path, current);
		if (merged.length === 1 && merged[0]?.start === 0 && merged[0].end >= totalBytes) {
			for (const hunkId of hunkIds) this.hunksInspectedValue.add(hunkId);
		}
	}

	recordSearch(): void {
		this.searchesRunValue++;
	}

	recordTreePage(): void {
		this.treePagesReadValue++;
	}

	snapshot(): ReviewObservedCoverage {
		return {
			changedFileInventoryComplete: this.changedFileInventoryCompleteValue,
			filesRead: [...this.filesReadValue].sort(),
			hunksInspected: [...this.hunksInspectedValue].sort(),
			searchesRun: this.searchesRunValue,
			treePagesRead: this.treePagesReadValue,
			diffFilesFullyRead: [...this.diffCoverage.entries()]
				.filter(
					([, state]) =>
						state.intervals.length === 1 &&
						state.intervals[0]?.start === 0 &&
						state.intervals[0].end >= state.totalBytes,
				)
				.map(([path]) => path)
				.sort(),
		};
	}
}

class ReviewCursorCodec {
	private readonly secret = randomBytes(32);
	private readonly snapshotId: string;

	constructor(snapshot: ReviewSnapshot) {
		this.snapshotId = snapshot.identity.headTree;
	}

	encode(kind: string, state: CursorPayload["state"]): string {
		const payload = Buffer.from(
			JSON.stringify({ kind, snapshot: this.snapshotId, state } satisfies CursorPayload),
			"utf8",
		).toString("base64url");
		const signature = createHash("sha256").update(this.secret).update(payload).digest("base64url").slice(0, 22);
		return `${payload}.${signature}`;
	}

	decode(cursor: string, kind: string): CursorPayload["state"] {
		const [payload, signature, extra] = cursor.split(".");
		if (!payload || !signature || extra !== undefined) throw new Error("Review cursor is invalid.");
		const expected = createHash("sha256").update(this.secret).update(payload).digest("base64url").slice(0, 22);
		if (signature !== expected) throw new Error("Review cursor is invalid or belongs to another review.");
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		} catch {
			throw new Error("Review cursor is invalid.");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review cursor is invalid.");
		const record = value as Record<string, unknown>;
		if (
			record.kind !== kind ||
			record.snapshot !== this.snapshotId ||
			!record.state ||
			typeof record.state !== "object" ||
			Array.isArray(record.state)
		) {
			throw new Error("Review cursor is invalid or belongs to another operation.");
		}
		return record.state as CursorPayload["state"];
	}
}

interface ChangedFileDetails {
	kind: "changed_files";
	paths: string[];
	complete: boolean;
	nextCursor?: string;
}

interface DiffDetails {
	kind: "diff";
	path: string;
	startByte: number;
	endByte: number;
	totalBytes: number;
	hunkIds: string[];
	nextCursor?: string;
}

interface FileDetails {
	kind: "file";
	path: string;
	revision: ReviewSnapshotRevision;
	startLine: number;
	endLine: number;
	totalLines: number;
	nextCursor?: string;
}

interface SearchMatch {
	path: string;
	line: number;
	text: string;
}

interface SearchDetails {
	kind: "search";
	query: string;
	revision: ReviewSnapshotRevision;
	matches: SearchMatch[];
	filesScanned: number;
	skippedPaths: Array<{ path: string; reason: string }>;
	nextCursor?: string;
}

interface TreeDetails {
	kind: "tree";
	revision: ReviewSnapshotRevision;
	paths: string[];
	complete: boolean;
	nextCursor?: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Review inspection was aborted.");
}

function clampInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Limit must be a positive integer.");
	return Math.min(value, maximum);
}

function revisionValue(value: string | undefined): ReviewSnapshotRevision {
	if (value === undefined || value === "head") return "head";
	if (value === "base") return "base";
	throw new Error('Revision must be "base" or "head".');
}

function changedFileText(file: ReviewChangedFile): string {
	const location = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
	const metadata = [
		`${location} [${file.status}]`,
		`  base: ${file.base ? `${file.base.mode} ${file.base.oid}` : "absent"}`,
		`  head: ${file.head ? `${file.head.mode} ${file.head.oid}` : "absent"}`,
		`  reviewable: ${file.reviewable ? "yes" : "no"}`,
	];
	if (file.unsupportedReason) metadata.push(`  unchecked: ${file.unsupportedReason}`);
	for (const hunk of file.hunks) {
		metadata.push(`  hunk ${hunk.id}: ${hunk.header}`);
	}
	return metadata.join("\n");
}

function pathDiffText(file: ReviewChangedFile): string {
	return [changedFileText(file), ...file.hunks.flatMap((hunk) => ["", `--- hunk ${hunk.id} ---`, hunk.patch])].join(
		"\n",
	);
}

function numberedLines(
	content: string,
	startLine: number,
	maximumLines: number,
): { text: string; endLine: number; totalLines: number } {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalLines = lines.length;
	if (startLine > Math.max(totalLines, 1)) throw new Error("Start line exceeds the file length.");
	const selected = lines.slice(startLine - 1, startLine - 1 + maximumLines);
	return {
		text: selected.map((line, index) => `${startLine + index}: ${line}`).join("\n"),
		endLine: startLine + Math.max(0, selected.length - 1),
		totalLines,
	};
}

function stringState(state: CursorPayload["state"], key: string): string | undefined {
	const value = state[key];
	return typeof value === "string" ? value : undefined;
}

function numberState(state: CursorPayload["state"], key: string): number | undefined {
	const value = state[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function treeEntryText(entry: ReviewSnapshotTreeEntry): string {
	return `${entry.mode} ${entry.type} ${entry.oid}${entry.size === undefined ? "" : ` ${entry.size}`}\t${entry.path}`;
}

export function createReviewSnapshotTools(snapshot: ReviewSnapshot, tracker: ReviewCoverageTracker): ToolDefinition[] {
	const cursors = new ReviewCursorCodec(snapshot);
	const changedFilesTool = defineTool({
		name: "review_changed_files",
		label: "review_changed_files",
		description:
			"List the immutable review snapshot's changed files, statuses, blob identities, reviewability, and hunk ids. Page until complete before finalizing.",
		promptSnippet: "List changed files and hunk ids from the exact immutable review snapshot",
		parameters: Type.Object({
			cursor: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_TOOL_MAX_LIST_ENTRIES })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const limit = clampInteger(params.limit, 50, REVIEW_TOOL_MAX_LIST_ENTRIES);
			const state = params.cursor ? cursors.decode(params.cursor, "changed-files") : {};
			const start = numberState(state, "index") ?? 0;
			const selected = snapshot.changedFiles.slice(start, start + limit);
			const nextIndex = start + selected.length;
			const complete = nextIndex >= snapshot.changedFiles.length;
			const nextCursor = complete ? undefined : cursors.encode("changed-files", { index: nextIndex });
			tracker.recordChangedFilePage(complete);
			const details: ChangedFileDetails = {
				kind: "changed_files",
				paths: selected.map((file) => file.path),
				complete,
				...(nextCursor ? { nextCursor } : {}),
			};
			return {
				content: [
					{
						type: "text",
						text: `${selected.map(changedFileText).join("\n\n")}${nextCursor ? `\n\nNext cursor: ${nextCursor}` : ""}`,
					},
				],
				details,
			};
		},
	});

	const diffTool = defineTool({
		name: "review_diff",
		label: "review_diff",
		description:
			"Read a UTF-8 byte page of the exact snapshot diff. Pass a changed path and page through the full per-file diff so host coverage can prove every hunk was inspected.",
		promptSnippet: "Read paged diff hunks from the exact immutable review snapshot",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			cursor: Type.Optional(Type.String()),
			maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_TOOL_MAX_PAGE_BYTES })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const state = params.cursor ? cursors.decode(params.cursor, "diff") : {};
			const cursorPath = stringState(state, "path");
			const requestedPath = params.path ? normalizeReviewPath(params.path) : cursorPath;
			if (!requestedPath) throw new Error("A changed path is required for the first diff page.");
			if (params.cursor && params.path && requestedPath !== cursorPath)
				throw new Error("Diff cursor path does not match the requested path.");
			const offset = numberState(state, "offset") ?? 0;
			const maxBytes = clampInteger(params.maxBytes, REVIEW_TOOL_DEFAULT_PAGE_BYTES, REVIEW_TOOL_MAX_PAGE_BYTES);
			const file = snapshot.changedFiles.find(
				(candidate) => candidate.path === requestedPath || candidate.previousPath === requestedPath,
			);
			if (!file) throw new Error(`Path is not changed in this review snapshot: ${requestedPath}`);
			const content = pathDiffText(file);
			const page = pageUtf8(content, offset, maxBytes);
			const nextCursor =
				page.nextOffset === undefined
					? undefined
					: cursors.encode("diff", { offset: page.nextOffset, path: requestedPath });
			const hunkIds = file.hunks.map((hunk) => hunk.id);
			tracker.recordDiffPage(file.path, page.startByte, page.endByte, page.totalBytes, hunkIds);
			const details: DiffDetails = {
				kind: "diff",
				path: file.path,
				startByte: page.startByte,
				endByte: page.endByte,
				totalBytes: page.totalBytes,
				hunkIds,
				...(nextCursor ? { nextCursor } : {}),
			};
			return {
				content: [{ type: "text", text: `${page.text}${nextCursor ? `\n\nNext cursor: ${nextCursor}` : ""}` }],
				details,
			};
		},
	});

	const fileTool = defineTool({
		name: "review_file",
		label: "review_file",
		description:
			"Read numbered lines from a base or head file in the exact immutable review snapshot. This never reads the live worktree.",
		promptSnippet: "Read base/head files from the exact immutable review snapshot",
		parameters: Type.Object({
			path: Type.String(),
			revision: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("head")])),
			startLine: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
			cursor: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const state = params.cursor ? cursors.decode(params.cursor, "file") : {};
			const path = normalizeReviewPath(params.path);
			const cursorPath = stringState(state, "path");
			if (cursorPath && cursorPath !== path) throw new Error("File cursor path does not match the requested path.");
			const revision = revisionValue(params.revision ?? stringState(state, "revision"));
			const cursorRevision = stringState(state, "revision");
			if (cursorRevision && cursorRevision !== revision)
				throw new Error("File cursor revision does not match the request.");
			const startLine = params.cursor ? (numberState(state, "line") ?? 1) : (params.startLine ?? 1);
			const limit = clampInteger(params.limit, 400, 2_000);
			const file = await snapshot.readFile(revision, path);
			if (!file) throw new Error(`File does not exist in the ${revision} snapshot: ${path}`);
			if (!file.available)
				throw new Error(`File is unavailable in the ${revision} snapshot: ${path}. ${file.message}`);
			if (file.binary) throw new Error(`File is binary in the ${revision} snapshot: ${path}`);
			const selected = numberedLines(file.content.toString("utf8"), startLine, limit);
			const complete = selected.endLine >= selected.totalLines;
			const nextCursor = complete
				? undefined
				: cursors.encode("file", { path, revision, line: selected.endLine + 1 });
			tracker.recordFile(path);
			const details: FileDetails = {
				kind: "file",
				path,
				revision,
				startLine,
				endLine: selected.endLine,
				totalLines: selected.totalLines,
				...(nextCursor ? { nextCursor } : {}),
			};
			return {
				content: [{ type: "text", text: `${selected.text}${nextCursor ? `\n\nNext cursor: ${nextCursor}` : ""}` }],
				details,
			};
		},
	});

	const searchTool = defineTool({
		name: "review_search",
		label: "review_search",
		description:
			"Search literal text across base or head snapshot files. Results and scanning are paged and never consult the live worktree.",
		promptSnippet: "Search exact immutable snapshot file contents",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 500 }),
			path: Type.Optional(Type.String()),
			revision: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("head")])),
			ignoreCase: Type.Optional(Type.Boolean()),
			cursor: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_TOOL_MAX_SEARCH_MATCHES })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const state = params.cursor ? cursors.decode(params.cursor, "search") : {};
			const cursorRevision = stringState(state, "revision");
			const revision = revisionValue(params.revision ?? cursorRevision);
			if (cursorRevision && cursorRevision !== revision)
				throw new Error("Search cursor revision does not match the request.");
			const cursorPrefix = state.prefix === null ? undefined : stringState(state, "prefix");
			const prefix = params.path ? normalizeReviewPath(params.path) : cursorPrefix;
			if (params.cursor && prefix !== cursorPrefix)
				throw new Error("Search cursor path does not match the request.");
			const cursorQuery = stringState(state, "query");
			if (cursorQuery && cursorQuery !== params.query)
				throw new Error("Search cursor query does not match the request.");
			const cursorIgnoreCase = state.ignoreCase === true;
			const ignoreCase = params.ignoreCase ?? cursorIgnoreCase;
			if (params.cursor && params.ignoreCase !== undefined && ignoreCase !== cursorIgnoreCase)
				throw new Error("Search cursor case sensitivity does not match the request.");
			const fileIndex = numberState(state, "fileIndex") ?? 0;
			const lineIndex = numberState(state, "lineIndex") ?? 0;
			const limit = clampInteger(params.limit, 50, REVIEW_TOOL_MAX_SEARCH_MATCHES);
			const search = await snapshot.search({
				revision,
				query: params.query,
				...(prefix ? { prefix } : {}),
				ignoreCase,
				fileIndex,
				lineIndex,
				limit,
				maxFiles: REVIEW_TOOL_MAX_SEARCH_FILES_PER_PAGE,
				...(signal ? { signal } : {}),
			});
			const { matches, filesScanned, skippedPaths, nextFileIndex, nextLineIndex, complete } = search;
			const nextCursor = complete
				? undefined
				: cursors.encode("search", {
						query: params.query,
						revision,
						prefix: prefix ?? null,
						ignoreCase,
						fileIndex: nextFileIndex,
						lineIndex: nextLineIndex,
					});
			tracker.recordSearch();
			const details: SearchDetails = {
				kind: "search",
				query: params.query,
				revision,
				matches,
				filesScanned,
				skippedPaths,
				...(nextCursor ? { nextCursor } : {}),
			};
			return {
				content: [
					{
						type: "text",
						text: `${matches.length === 0 ? "No matches in this page." : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")}${skippedPaths.length === 0 ? "" : `\n\nSkipped paths:\n${skippedPaths.map((entry) => `${entry.path}: ${entry.reason}`).join("\n")}`}${nextCursor ? `\n\nNext cursor: ${nextCursor}` : ""}`,
					},
				],
				details,
			};
		},
	});

	const treeTool = defineTool({
		name: "review_tree",
		label: "review_tree",
		description:
			"List base or head snapshot tree entries under a repository-relative prefix. Page until complete when mapping surrounding code.",
		promptSnippet: "List exact immutable snapshot tree entries",
		parameters: Type.Object({
			prefix: Type.Optional(Type.String()),
			revision: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("head")])),
			cursor: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_TOOL_MAX_LIST_ENTRIES })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const state = params.cursor ? cursors.decode(params.cursor, "tree") : {};
			const cursorRevision = stringState(state, "revision");
			const revision = revisionValue(params.revision ?? cursorRevision);
			if (cursorRevision && cursorRevision !== revision)
				throw new Error("Tree cursor revision does not match the request.");
			const cursorPrefix = state.prefix === null ? undefined : stringState(state, "prefix");
			const prefix = params.prefix ? normalizeReviewPath(params.prefix) : cursorPrefix;
			if (params.cursor && cursorPrefix !== prefix)
				throw new Error("Tree cursor prefix does not match the request.");
			const start = numberState(state, "index") ?? 0;
			const limit = clampInteger(params.limit, 100, REVIEW_TOOL_MAX_LIST_ENTRIES);
			const entries = await snapshot.listFiles({ revision, ...(prefix ? { prefix } : {}) });
			const selected = entries.slice(start, start + limit);
			const nextIndex = start + selected.length;
			const complete = nextIndex >= entries.length;
			const nextCursor = complete
				? undefined
				: cursors.encode("tree", { revision, prefix: prefix ?? null, index: nextIndex });
			tracker.recordTreePage();
			const details: TreeDetails = {
				kind: "tree",
				revision,
				paths: selected.map((entry) => entry.path),
				complete,
				...(nextCursor ? { nextCursor } : {}),
			};
			return {
				content: [
					{
						type: "text",
						text: `${selected.map(treeEntryText).join("\n")}${nextCursor ? `\n\nNext cursor: ${nextCursor}` : ""}`,
					},
				],
				details,
			};
		},
	});

	return [changedFilesTool, diffTool, fileTool, searchTool, treeTool] satisfies ToolDefinition[];
}

export function reviewSnapshotToolGuidelines(commandCapable: boolean): string[] {
	return [
		"Call review_changed_files and page to completion before finalizing.",
		"Call review_diff with each in-scope reviewable changed path and page every file diff to completion; a partial diff page leaves the review incomplete.",
		"Use review_file, review_search, and review_tree for surrounding code. These tools read the immutable base/head snapshot, never the live worktree.",
		commandCapable
			? "Optional command tools run in a disposable checkout of the captured head tree; report command failures rather than assuming the user's live dependencies are present."
			: "No command-capable tool is available. Verify statically and state runtime checks as residual risk; do not ask for or claim test execution.",
	];
}
