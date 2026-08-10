import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "branch"; base?: string }
	| { kind: "pr"; number?: string }
	| { kind: "commit"; sha?: string };

export type ReviewSnapshotRevision = "base" | "head";
export type ReviewSnapshotSide = ReviewSnapshotRevision;
export type ReviewChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ReviewSnapshotTreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	oid: string;
	size?: number;
}

export interface ReviewSnapshotLineRange {
	startLine: number;
	endLine: number;
}

export interface ReviewSnapshotHunk {
	id: string;
	path: string;
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	baseChangedLines: ReviewSnapshotLineRange[];
	headChangedLines: ReviewSnapshotLineRange[];
	patch: string;
}

export interface ReviewChangedFile {
	path: string;
	previousPath?: string;
	status: ReviewChangedFileStatus;
	base?: ReviewSnapshotTreeEntry;
	head?: ReviewSnapshotTreeEntry;
	hunks: ReviewSnapshotHunk[];
	binary: boolean;
	reviewable: boolean;
	unsupportedReason?: string;
}

export interface ReviewPullRequestIdentity {
	number: number;
	title: string;
	body: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	baseRefOid: string;
	headRefOid: string;
}

export interface ReviewSnapshotIdentity {
	kind: ReviewTarget["kind"];
	baseTree: string;
	headTree: string;
	baseCommit?: string;
	mergeBaseCommit?: string;
	headCommit?: string;
	pullRequest?: ReviewPullRequestIdentity;
}

export type ReviewSnapshotFile =
	| {
			available: true;
			entry: ReviewSnapshotTreeEntry;
			content: Buffer;
			binary: boolean;
			lineCount?: number;
	  }
	| {
			available: false;
			entry: ReviewSnapshotTreeEntry;
			reason: "oversized" | "output-limit" | "read-failed";
			message: string;
	  };

export interface ReviewSnapshotPage {
	text: string;
	startByte: number;
	endByte: number;
	totalBytes: number;
	nextOffset?: number;
}

export interface ReviewSnapshotListOptions {
	revision?: ReviewSnapshotRevision;
	prefix?: string;
}

export interface ReviewSnapshot {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	identity: ReviewSnapshotIdentity;
	changedFiles: ReviewChangedFile[];
	root: string;
	readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined>;
	listFiles(options?: ReviewSnapshotListOptions): Promise<ReviewSnapshotTreeEntry[]>;
	materializeHead(): Promise<string>;
	dispose(): Promise<void>;
}

export interface ReviewSnapshotResolutionError {
	error: string;
	remoteError?: string;
}

export interface ResolveReviewSnapshotOptions {
	maxCommitRefBytes: number;
	maxPullRequestNumber: number;
	limits?: Partial<ReviewSnapshotLimits>;
}

interface ReviewSnapshotLimits {
	maxMetadataBytes: number;
	maxStderrBytes: number;
	maxPatchBytes: number;
	maxRetainedPatchBytes: number;
	maxBlobBytes: number;
}

interface CommandOutputLimitFailure {
	kind: "output-limit";
	stream: "stdout" | "stderr";
	limit: number;
}

interface CommandResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	failure?: CommandOutputLimitFailure;
}

interface GitSource {
	cwd: string;
	env?: Record<string, string>;
	objectDirectories: string[];
	limits: ReviewSnapshotLimits;
}

interface SnapshotInit {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	identity: ReviewSnapshotIdentity;
	root: string;
	source: GitSource;
	temporaryDirectories: string[];
	limits: ReviewSnapshotLimits;
}

interface PullRequestView {
	number: number;
	title: string;
	body: string;
	baseRefName: string;
	headRefName: string;
	url: string;
	baseRefOid: string;
	headRefOid: string;
}

const CANONICAL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_STABLE_CAPTURE_ATTEMPTS = 3;
const DEFAULT_REVIEW_SNAPSHOT_LIMITS: ReviewSnapshotLimits = {
	maxMetadataBytes: 32 * 1024 * 1024,
	maxStderrBytes: 64 * 1024,
	maxPatchBytes: 4 * 1024 * 1024,
	maxRetainedPatchBytes: 32 * 1024 * 1024,
	maxBlobBytes: 8 * 1024 * 1024,
};

function normalizeLimit(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
	return value;
}

function normalizeSnapshotLimits(overrides: Partial<ReviewSnapshotLimits> | undefined): ReviewSnapshotLimits {
	return {
		maxMetadataBytes: normalizeLimit(
			overrides?.maxMetadataBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxMetadataBytes,
			"maxMetadataBytes",
		),
		maxStderrBytes: normalizeLimit(
			overrides?.maxStderrBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxStderrBytes,
			"maxStderrBytes",
		),
		maxPatchBytes: normalizeLimit(
			overrides?.maxPatchBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxPatchBytes,
			"maxPatchBytes",
		),
		maxRetainedPatchBytes: normalizeLimit(
			overrides?.maxRetainedPatchBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxRetainedPatchBytes,
			"maxRetainedPatchBytes",
		),
		maxBlobBytes: normalizeLimit(
			overrides?.maxBlobBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxBlobBytes,
			"maxBlobBytes",
		),
	};
}

function formatByteLimit(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
	return `${bytes} bytes`;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	options: {
		env?: Record<string, string>;
		input?: Buffer | string;
		signal?: AbortSignal;
		maxStdoutBytes?: number;
		maxStderrBytes?: number;
	} = {},
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxMetadataBytes;
		const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxStderrBytes;
		const proc = spawnProcess(command, args, {
			cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : process.env,
			signal: options.signal,
		});
		let stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr: Buffer[] = [];
		let stderrBytes = 0;
		let failure: CommandOutputLimitFailure | undefined;
		let settled = false;
		const finish = (result: CommandResult): void => {
			if (settled) return;
			settled = true;
			resolveResult(result);
		};
		const exceed = (stream: CommandOutputLimitFailure["stream"], limit: number): void => {
			if (failure) return;
			failure = { kind: "output-limit", stream, limit };
			stdout = [];
			stderr = [];
			proc.kill();
		};
		proc.stdout?.on("data", (data: Buffer) => {
			if (failure) return;
			stdoutBytes += data.length;
			if (stdoutBytes > maxStdoutBytes) exceed("stdout", maxStdoutBytes);
			else stdout.push(data);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			if (failure) return;
			stderrBytes += data.length;
			if (stderrBytes > maxStderrBytes) exceed("stderr", maxStderrBytes);
			else stderr.push(data);
		});
		proc.on("error", (error) => {
			if (failure) return;
			finish({ ok: false, stdout: Buffer.concat(stdout), stderr: error.message });
		});
		proc.on("close", (code) => {
			if (failure) {
				finish({ ok: false, stdout: Buffer.alloc(0), stderr: "", failure });
				return;
			}
			finish({
				ok: code === 0,
				stdout: Buffer.concat(stdout, stdoutBytes),
				stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
			});
		});
		if (options.input !== undefined) proc.stdin?.end(options.input);
	});
}

function git(
	source: Pick<GitSource, "cwd" | "env" | "limits">,
	args: string[],
	input?: Buffer | string,
	maxStdoutBytes = source.limits.maxMetadataBytes,
): Promise<CommandResult> {
	return runCommand("git", args, source.cwd, {
		env: source.env,
		input,
		maxStdoutBytes,
		maxStderrBytes: source.limits.maxStderrBytes,
	});
}

function text(result: CommandResult): string {
	return result.stdout.toString("utf8");
}

function commandError(result: CommandResult): string {
	if (result.failure) {
		return `${result.failure.stream} exceeded the ${formatByteLimit(result.failure.limit)} capture limit`;
	}
	return result.stderr.trim() || "command exited unsuccessfully";
}

function throwIfOutputLimited(prefix: string, result: CommandResult): void {
	if (result.failure) throw new Error(`${prefix}: ${commandError(result)}`);
}

function commandFailure(prefix: string, result: CommandResult): ReviewSnapshotResolutionError {
	return { error: `${prefix}: ${commandError(result)}` };
}

async function requireCanonicalCommit(
	source: Pick<GitSource, "cwd" | "env" | "limits">,
	ref: string,
): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	throwIfOutputLimited("git rev-parse failed", result);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function requireCanonicalTree(
	source: Pick<GitSource, "cwd" | "env" | "limits">,
	ref: string,
): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]);
	throwIfOutputLimited("git rev-parse failed", result);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function createEmptyTree(source: Pick<GitSource, "cwd" | "env" | "limits">): Promise<string> {
	const result = await git(source, ["mktree"], "");
	const oid = text(result).trim();
	if (!result.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid)) {
		throw new Error(`Could not create an empty review tree: ${commandError(result)}`);
	}
	return oid;
}

function commandOptions(limits: ReviewSnapshotLimits): { maxStdoutBytes: number; maxStderrBytes: number } {
	return { maxStdoutBytes: limits.maxMetadataBytes, maxStderrBytes: limits.maxStderrBytes };
}

async function repositoryRoot(cwd: string, limits: ReviewSnapshotLimits): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd, commandOptions(limits));
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryObjectDirectory(cwd: string, limits: ReviewSnapshotLimits): Promise<string | undefined> {
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "objects"],
		cwd,
		commandOptions(limits),
	);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryIndexFile(cwd: string, limits: ReviewSnapshotLimits): Promise<string | undefined> {
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		cwd,
		commandOptions(limits),
	);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function detectBaseBranch(cwd: string, limits: ReviewSnapshotLimits): Promise<string | undefined> {
	const originHead = await runCommand(
		"git",
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		cwd,
		commandOptions(limits),
	);
	throwIfOutputLimited("git symbolic-ref failed", originHead);
	if (originHead.ok) {
		const ref = text(originHead).trim();
		if (ref) return ref;
	}
	for (const candidate of ["main", "master"]) {
		const exists = await runCommand(
			"git",
			["rev-parse", "--verify", "--quiet", candidate],
			cwd,
			commandOptions(limits),
		);
		throwIfOutputLimited("git rev-parse failed", exists);
		if (exists.ok) return candidate;
	}
	return undefined;
}

async function resolveBaseRef(base: string, cwd: string, limits: ReviewSnapshotLimits): Promise<string | undefined> {
	const direct = await runCommand("git", ["rev-parse", "--verify", "--quiet", base], cwd, commandOptions(limits));
	throwIfOutputLimited("git rev-parse failed", direct);
	if (direct.ok) return base;
	if (!base.startsWith("origin/")) {
		const remote = `origin/${base}`;
		const remoteExists = await runCommand(
			"git",
			["rev-parse", "--verify", "--quiet", remote],
			cwd,
			commandOptions(limits),
		);
		throwIfOutputLimited("git rev-parse failed", remoteExists);
		if (remoteExists.ok) return remote;
	}
	return undefined;
}

function parsePullRequestView(stdout: string, maximum: number): PullRequestView | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.number !== "number" ||
		!Number.isInteger(record.number) ||
		record.number < 1 ||
		record.number > maximum ||
		typeof record.title !== "string" ||
		typeof record.body !== "string" ||
		typeof record.baseRefName !== "string" ||
		typeof record.headRefName !== "string" ||
		typeof record.url !== "string" ||
		typeof record.baseRefOid !== "string" ||
		typeof record.headRefOid !== "string" ||
		!CANONICAL_GIT_OBJECT_ID_PATTERN.test(record.baseRefOid) ||
		!CANONICAL_GIT_OBJECT_ID_PATTERN.test(record.headRefOid)
	) {
		return undefined;
	}
	return {
		number: record.number,
		title: record.title,
		body: record.body,
		baseRefName: record.baseRefName,
		headRefName: record.headRefName,
		url: record.url,
		baseRefOid: record.baseRefOid,
		headRefOid: record.headRefOid,
	};
}

function normalizePullRequestNumber(value: string | undefined, maximum: number): string | undefined {
	const number = value?.trim();
	if (!number) return undefined;
	if (!/^[1-9]\d*$/.test(number)) return undefined;
	const numeric = Number(number);
	return Number.isSafeInteger(numeric) && numeric <= maximum ? number : undefined;
}

async function createLocalSource(root: string, limits: ReviewSnapshotLimits): Promise<GitSource> {
	const objects = await repositoryObjectDirectory(root, limits);
	if (!objects) throw new Error("Could not resolve the Git object directory.");
	return { cwd: root, objectDirectories: [objects], limits };
}

async function createUncommittedSource(
	root: string,
	limits: ReviewSnapshotLimits,
): Promise<{ source: GitSource; temporaryDirectory: string; originalIndex: string }> {
	const originalObjects = await repositoryObjectDirectory(root, limits);
	if (!originalObjects) throw new Error("Could not resolve the Git object directory.");
	const originalIndex = await repositoryIndexFile(root, limits);
	if (!originalIndex) throw new Error("Could not resolve the Git index file.");
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-snapshot-"));
	const objects = join(temporaryDirectory, "objects");
	await mkdir(objects, { recursive: true });
	const source: GitSource = {
		cwd: root,
		env: {
			GIT_INDEX_FILE: join(temporaryDirectory, "index"),
			GIT_OBJECT_DIRECTORY: objects,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects,
		},
		objectDirectories: [objects, originalObjects],
		limits,
	};
	return { source, temporaryDirectory, originalIndex };
}

async function seedTemporaryIndex(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
): Promise<ReviewSnapshotResolutionError | undefined> {
	const temporaryIndex = source.env?.GIT_INDEX_FILE;
	if (!temporaryIndex) return { error: "Could not resolve the temporary Git index file." };
	try {
		await rm(temporaryIndex, { force: true });
		await copyFile(originalIndex, temporaryIndex);
		// A copied index receives a fresh filesystem timestamp while retaining
		// cached entry timestamps. Backdate it so Git treats every tracked entry
		// as potentially racily clean and re-hashes same-size worktree rewrites.
		// Use the earliest nonzero timestamp because Git treats zero as unset.
		await utimes(temporaryIndex, 1, 1);
		return undefined;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code !== "ENOENT") {
			return {
				error: `Could not seed the temporary Git index: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	const readTree = await git(source, ["read-tree", baseTree]);
	return readTree.ok ? undefined : commandFailure("git read-tree failed", readTree);
}

async function captureWorktreeTree(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
): Promise<{ tree?: string; error?: ReviewSnapshotResolutionError }> {
	for (let attempt = 1; attempt <= MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
		const before = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!before.ok) return { error: commandFailure("git status failed", before) };
		const firstSeedError = await seedTemporaryIndex(source, originalIndex, baseTree);
		if (firstSeedError) return { error: firstSeedError };
		const add = await git(source, ["add", "-A", "--"]);
		if (!add.ok) return { error: commandFailure("git add failed", add) };
		const firstTreeResult = await git(source, ["write-tree"]);
		if (!firstTreeResult.ok) return { error: commandFailure("git write-tree failed", firstTreeResult) };
		const after = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!after.ok) return { error: commandFailure("git status failed", after) };
		const secondSeedError = await seedTemporaryIndex(source, originalIndex, baseTree);
		if (secondSeedError) return { error: secondSeedError };
		const secondAdd = await git(source, ["add", "-A", "--"]);
		if (!secondAdd.ok) return { error: commandFailure("git add failed", secondAdd) };
		const secondTreeResult = await git(source, ["write-tree"]);
		if (!secondTreeResult.ok) return { error: commandFailure("git write-tree failed", secondTreeResult) };
		const firstTree = text(firstTreeResult).trim();
		const secondTree = text(secondTreeResult).trim();
		if (
			before.stdout.equals(after.stdout) &&
			firstTree === secondTree &&
			CANONICAL_GIT_OBJECT_ID_PATTERN.test(secondTree)
		) {
			return { tree: secondTree };
		}
	}
	return { error: { error: "Working tree changed while Volt captured the review snapshot. Retry the review." } };
}

async function createPullRequestSource(
	root: string,
	pullRequest: PullRequestView,
	limits: ReviewSnapshotLimits,
): Promise<{ source?: GitSource; temporaryDirectory?: string; error?: ReviewSnapshotResolutionError }> {
	const originResult = await runCommand("git", ["remote", "get-url", "origin"], root, commandOptions(limits));
	if (!originResult.ok || !text(originResult).trim()) {
		return { error: { error: "Could not resolve the origin remote for the pull request snapshot." } };
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-pr-"));
	const init = await runCommand("git", ["init", "--bare"], temporaryDirectory, commandOptions(limits));
	if (!init.ok) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		return { error: commandFailure("git init failed", init) };
	}
	const source: GitSource = {
		cwd: temporaryDirectory,
		objectDirectories: [join(temporaryDirectory, "objects")],
		limits,
	};
	const fetch = await git(source, [
		"fetch",
		"--no-tags",
		"--force",
		text(originResult).trim(),
		`+${pullRequest.baseRefOid}:refs/review/base`,
		`+refs/pull/${pullRequest.number}/head:refs/review/head`,
	]);
	if (!fetch.ok) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		return {
			error: {
				error: `git fetch failed: ${commandError(fetch)}`,
				remoteError: "Could not fetch the exact pull request snapshot.",
			},
		};
	}
	const fetchedBase = await requireCanonicalCommit(source, "refs/review/base");
	const fetchedHead = await requireCanonicalCommit(source, "refs/review/head");
	if (fetchedBase !== pullRequest.baseRefOid || fetchedHead !== pullRequest.headRefOid) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		return {
			error: {
				error: "The pull request moved while Volt captured it. Retry the review.",
				remoteError: "The pull request changed while Volt captured it. Retry the review.",
			},
		};
	}
	return { source, temporaryDirectory };
}

function statusFromGit(value: string): ReviewChangedFileStatus {
	switch (value[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "type-changed";
		default:
			return "modified";
	}
}

interface NameStatusEntry {
	path: string;
	previousPath?: string;
	status: ReviewChangedFileStatus;
}

function parseNameStatus(stdout: Buffer): NameStatusEntry[] {
	const tokens = stdout.toString("utf8").split("\0");
	const entries: NameStatusEntry[] = [];
	let index = 0;
	while (index < tokens.length) {
		const statusToken = tokens[index++];
		if (!statusToken) continue;
		if (statusToken.startsWith("R") || statusToken.startsWith("C")) {
			const previousPath = tokens[index++];
			const path = tokens[index++];
			if (previousPath && path) entries.push({ path, previousPath, status: statusFromGit(statusToken) });
			continue;
		}
		const path = tokens[index++];
		if (path) entries.push({ path, status: statusFromGit(statusToken) });
	}
	return entries;
}

function parseBinaryPathsFromNumstat(stdout: Buffer): Set<string> {
	const binaryPaths = new Set<string>();
	for (const token of stdout.toString("utf8").split("\0")) {
		if (!token) continue;
		const firstTab = token.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : token.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		if (token.slice(0, firstTab) === "-" && token.slice(firstTab + 1, secondTab) === "-") {
			binaryPaths.add(token.slice(secondTab + 1));
		}
	}
	return binaryPaths;
}

function parseTree(stdout: Buffer): Map<string, ReviewSnapshotTreeEntry> {
	const entries = new Map<string, ReviewSnapshotTreeEntry>();
	for (const token of stdout.toString("utf8").split("\0")) {
		if (!token) continue;
		const tab = token.indexOf("\t");
		if (tab < 0) continue;
		const metadata = token.slice(0, tab).split(/\s+/);
		const path = token.slice(tab + 1);
		const [mode, type, oid, sizeText] = metadata;
		if (
			!mode ||
			(type !== "blob" && type !== "tree" && type !== "commit") ||
			!oid ||
			!CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid)
		) {
			continue;
		}
		const size = sizeText && sizeText !== "-" ? Number(sizeText) : undefined;
		entries.set(path, {
			path,
			mode,
			type,
			oid,
			...(Number.isSafeInteger(size) && size !== undefined && size >= 0 ? { size } : {}),
		});
	}
	return entries;
}

function collectLineRanges(lines: number[]): ReviewSnapshotLineRange[] {
	const ranges: ReviewSnapshotLineRange[] = [];
	for (const line of lines) {
		const previous = ranges.at(-1);
		if (previous && previous.endLine + 1 === line) previous.endLine = line;
		else ranges.push({ startLine: line, endLine: line });
	}
	return ranges;
}

function parseHunks(path: string, patch: string): ReviewSnapshotHunk[] {
	const lines = patch.split("\n");
	const hunks: ReviewSnapshotHunk[] = [];
	const headerPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
	let index = 0;
	while (index < lines.length) {
		const match = headerPattern.exec(lines[index] ?? "");
		if (!match) {
			index++;
			continue;
		}
		const header = lines[index] ?? "";
		const oldStart = Number(match[1]);
		const oldCount = Number(match[2] ?? "1");
		const newStart = Number(match[3]);
		const newCount = Number(match[4] ?? "1");
		const hunkLines = [header];
		const baseLines: number[] = [];
		const headLines: number[] = [];
		let oldLine = oldStart;
		let newLine = newStart;
		index++;
		while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
			const line = lines[index] ?? "";
			if (line.startsWith("diff --git ")) break;
			hunkLines.push(line);
			if (line.startsWith("-")) {
				baseLines.push(oldLine++);
			} else if (line.startsWith("+")) {
				headLines.push(newLine++);
			} else if (!line.startsWith("\\")) {
				oldLine++;
				newLine++;
			}
			index++;
		}
		const patchText = hunkLines.join("\n");
		const id = createHash("sha256")
			.update(path)
			.update("\0")
			.update(header)
			.update("\0")
			.update(patchText)
			.digest("hex")
			.slice(0, 20);
		hunks.push({
			id,
			path,
			header,
			oldStart,
			oldCount,
			newStart,
			newCount,
			baseChangedLines: collectLineRanges(baseLines),
			headChangedLines: collectLineRanges(headLines),
			patch: patchText,
		});
	}
	return hunks;
}

function isBinary(content: Buffer): boolean {
	return content.subarray(0, Math.min(content.length, 8_192)).includes(0);
}

function countLines(content: Buffer): number {
	if (content.length === 0) return 0;
	let lines = 1;
	for (const byte of content) if (byte === 10) lines++;
	if (content.at(-1) === 10) lines--;
	return lines;
}

async function buildChangedFiles(
	source: GitSource,
	baseTree: string,
	headTree: string,
	baseEntries: Map<string, ReviewSnapshotTreeEntry>,
	headEntries: Map<string, ReviewSnapshotTreeEntry>,
): Promise<ReviewChangedFile[]> {
	const statusResult = await git(source, ["diff", "--name-status", "-z", "--find-renames", baseTree, headTree]);
	if (!statusResult.ok) throw new Error(`git diff --name-status failed: ${commandError(statusResult)}`);
	const numstatResult = await git(source, ["diff", "--numstat", "-z", "--no-renames", baseTree, headTree]);
	if (!numstatResult.ok) throw new Error(`git diff --numstat failed: ${commandError(numstatResult)}`);
	const binaryPaths = parseBinaryPathsFromNumstat(numstatResult.stdout);
	const changed: ReviewChangedFile[] = [];
	let retainedPatchBytes = 0;
	for (const statusEntry of parseNameStatus(statusResult.stdout)) {
		const basePath = statusEntry.previousPath ?? statusEntry.path;
		const base = baseEntries.get(basePath);
		const head = headEntries.get(statusEntry.path);
		const binary = binaryPaths.has(basePath) || binaryPaths.has(statusEntry.path);
		const oversized = [base, head].some(
			(entry) => entry?.type === "blob" && (entry.size === undefined || entry.size > source.limits.maxBlobBytes),
		);
		let hunks: ReviewSnapshotHunk[] = [];
		let unsupportedReason: string | undefined;
		if (base?.type === "commit" || head?.type === "commit") {
			unsupportedReason = "Submodule changes require review in the submodule repository.";
		} else if (binary) {
			unsupportedReason = "Binary content has no reviewable text hunks.";
		} else if (oversized) {
			unsupportedReason = `File content exceeds the ${formatByteLimit(source.limits.maxBlobBytes)} snapshot blob limit.`;
		} else {
			const pathspecs = statusEntry.previousPath ? [statusEntry.previousPath, statusEntry.path] : [statusEntry.path];
			const patchResult = await git(
				source,
				[
					"diff",
					"--no-color",
					"--no-textconv",
					"--no-ext-diff",
					`--unified=${DEFAULT_DIFF_CONTEXT_LINES}`,
					"--find-renames",
					baseTree,
					headTree,
					"--",
					...pathspecs,
				],
				undefined,
				source.limits.maxPatchBytes,
			);
			if (patchResult.failure?.stream === "stdout") {
				unsupportedReason = `Text patch exceeds the ${formatByteLimit(source.limits.maxPatchBytes)} per-file review limit.`;
			} else if (!patchResult.ok) {
				throw new Error(`git diff failed for ${statusEntry.path}: ${commandError(patchResult)}`);
			} else {
				const parsedHunks = parseHunks(statusEntry.path, text(patchResult));
				const patchBytes = parsedHunks.reduce((total, hunk) => total + Buffer.byteLength(hunk.patch, "utf8"), 0);
				if (retainedPatchBytes + patchBytes > source.limits.maxRetainedPatchBytes) {
					unsupportedReason = `Text patch exceeds the ${formatByteLimit(source.limits.maxRetainedPatchBytes)} aggregate review budget.`;
				} else {
					hunks = parsedHunks;
					retainedPatchBytes += patchBytes;
					if (hunks.length === 0) {
						unsupportedReason = "The change has no textual diff hunk (for example, a mode-only change).";
					}
				}
			}
		}
		changed.push({
			...statusEntry,
			...(base ? { base } : {}),
			...(head ? { head } : {}),
			hunks,
			binary,
			reviewable: unsupportedReason === undefined,
			...(unsupportedReason ? { unsupportedReason } : {}),
		});
	}
	return changed;
}

class GitReviewSnapshot implements ReviewSnapshot {
	readonly description: string;
	readonly workflowDescription?: string;
	readonly diffCommand: string;
	readonly extraContext?: string;
	readonly identity: ReviewSnapshotIdentity;
	readonly root: string;
	readonly changedFiles: ReviewChangedFile[];
	private readonly source: GitSource;
	private readonly limits: ReviewSnapshotLimits;
	private readonly temporaryDirectories: string[];
	private readonly materializedDirectories: string[] = [];
	private readonly treeEntries = new Map<ReviewSnapshotRevision, Map<string, ReviewSnapshotTreeEntry>>();
	private disposed = false;

	private constructor(
		init: SnapshotInit,
		changedFiles: ReviewChangedFile[],
		baseEntries: Map<string, ReviewSnapshotTreeEntry>,
		headEntries: Map<string, ReviewSnapshotTreeEntry>,
	) {
		this.description = init.description;
		this.workflowDescription = init.workflowDescription;
		this.diffCommand = init.diffCommand;
		this.extraContext = init.extraContext;
		this.identity = init.identity;
		this.root = init.root;
		this.source = init.source;
		this.limits = init.limits;
		this.temporaryDirectories = init.temporaryDirectories;
		this.changedFiles = changedFiles;
		this.treeEntries.set("base", baseEntries);
		this.treeEntries.set("head", headEntries);
	}

	static async create(init: SnapshotInit): Promise<GitReviewSnapshot> {
		const baseTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.baseTree]);
		const headTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.headTree]);
		if (!baseTreeResult.ok || !headTreeResult.ok) {
			throw new Error(
				`Could not inventory review snapshot trees: ${commandError(baseTreeResult.ok ? headTreeResult : baseTreeResult)}`,
			);
		}
		const baseEntries = parseTree(baseTreeResult.stdout);
		const headEntries = parseTree(headTreeResult.stdout);
		const changedFiles = await buildChangedFiles(
			init.source,
			init.identity.baseTree,
			init.identity.headTree,
			baseEntries,
			headEntries,
		);
		return new GitReviewSnapshot(init, changedFiles, baseEntries, headEntries);
	}

	async readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined> {
		this.assertActive();
		const normalized = normalizeReviewPath(path);
		const entry = this.treeEntries.get(revision)?.get(normalized);
		if (!entry || entry.type !== "blob") return undefined;
		if (entry.size === undefined) {
			return {
				available: false,
				entry,
				reason: "read-failed",
				message: "Git did not report a blob size, so the file was not read.",
			};
		}
		if (entry.size > this.limits.maxBlobBytes) {
			return {
				available: false,
				entry,
				reason: "oversized",
				message: `Blob size ${entry.size} bytes exceeds the ${formatByteLimit(this.limits.maxBlobBytes)} snapshot read limit.`,
			};
		}
		const result = await git(this.source, ["cat-file", "blob", entry.oid], undefined, this.limits.maxBlobBytes);
		if (result.failure) {
			return {
				available: false,
				entry,
				reason: "output-limit",
				message:
					result.failure.stream === "stdout"
						? `Blob output exceeded the ${formatByteLimit(result.failure.limit)} snapshot read limit.`
						: `Blob read stderr exceeded the ${formatByteLimit(result.failure.limit)} capture limit.`,
			};
		}
		if (!result.ok) {
			return {
				available: false,
				entry,
				reason: "read-failed",
				message: `Could not read the snapshot blob: ${commandError(result)}.`,
			};
		}
		const content = result.stdout;
		const binary = isBinary(content);
		return {
			available: true,
			entry,
			content,
			binary,
			...(binary ? {} : { lineCount: countLines(content) }),
		};
	}

	async listFiles(options: ReviewSnapshotListOptions = {}): Promise<ReviewSnapshotTreeEntry[]> {
		this.assertActive();
		const revision = options.revision ?? "head";
		const prefix = options.prefix === undefined || options.prefix === "" ? "" : normalizeReviewPath(options.prefix);
		return [...(this.treeEntries.get(revision)?.values() ?? [])]
			.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	async materializeHead(): Promise<string> {
		this.assertActive();
		const directory = await mkdtemp(join(tmpdir(), "volt-review-checkout-"));
		this.materializedDirectories.push(directory);
		const init = await runCommand("git", ["init"], directory, commandOptions(this.limits));
		if (!init.ok) throw new Error(`Could not initialize review checkout: ${commandError(init)}`);
		const alternatesPath = join(directory, ".git", "objects", "info", "alternates");
		await mkdir(join(directory, ".git", "objects", "info"), { recursive: true });
		await writeFile(
			alternatesPath,
			`${this.source.objectDirectories.map((path) => resolve(path)).join("\n")}\n`,
			"utf8",
		);
		const commit = await runCommand(
			"git",
			["commit-tree", this.identity.headTree, "-m", "Volt review snapshot"],
			directory,
			{
				...commandOptions(this.limits),
				env: {
					GIT_AUTHOR_NAME: "Volt Review",
					GIT_AUTHOR_EMAIL: "review@localhost",
					GIT_COMMITTER_NAME: "Volt Review",
					GIT_COMMITTER_EMAIL: "review@localhost",
				},
			},
		);
		const commitOid = text(commit).trim();
		if (!commit.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(commitOid)) {
			throw new Error(`Could not create review checkout commit: ${commandError(commit)}`);
		}
		const reset = await runCommand("git", ["reset", "--hard", commitOid], directory, commandOptions(this.limits));
		if (!reset.ok) throw new Error(`Could not materialize review checkout: ${commandError(reset)}`);
		return directory;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const directory of [...this.materializedDirectories, ...this.temporaryDirectories].reverse()) {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Review snapshot is no longer available.");
	}
}

export function normalizeReviewPath(path: string): string {
	if (path.includes("\0")) throw new Error("Review paths must not contain NUL bytes.");
	if (isAbsolute(path)) throw new Error("Review paths must be repository-relative.");
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized || normalized === ".") throw new Error("Review path must identify a repository entry.");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error("Review path must not traverse outside the repository.");
	}
	return segments.join("/");
}

export function pageUtf8(textValue: string, offset: number, maxBytes: number): ReviewSnapshotPage {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Page offset must be a non-negative integer.");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Page size must be a positive integer.");
	const buffer = Buffer.from(textValue, "utf8");
	if (offset > buffer.length) throw new Error("Page offset exceeds the content length.");
	let end = Math.min(buffer.length, offset + maxBytes);
	while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	if (end === offset && end < buffer.length) {
		end = Math.min(buffer.length, offset + maxBytes);
		while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end++;
	}
	return {
		text: buffer.subarray(offset, end).toString("utf8"),
		startByte: offset,
		endByte: end,
		totalBytes: buffer.length,
		...(end < buffer.length ? { nextOffset: end } : {}),
	};
}

export function pathWithinRoot(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

export async function resolveReviewSnapshot(
	target: ReviewTarget,
	cwd: string,
	options: ResolveReviewSnapshotOptions,
): Promise<ReviewSnapshot | ReviewSnapshotResolutionError> {
	let init: SnapshotInit | undefined;
	try {
		const limits = normalizeSnapshotLimits(options.limits);
		const root = await repositoryRoot(cwd, limits);
		if (!root) return { error: "Not inside a git repository." };
		switch (target.kind) {
			case "uncommitted": {
				const { source, temporaryDirectory, originalIndex } = await createUncommittedSource(root, limits);
				const headCommit = await requireCanonicalCommit(source, "HEAD");
				const baseTree = headCommit
					? await requireCanonicalTree(source, headCommit)
					: await createEmptyTree(source);
				if (!baseTree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return { error: "Could not resolve the base tree for uncommitted changes." };
				}
				const captured = await captureWorktreeTree(source, originalIndex, baseTree);
				if (!captured.tree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return {
						...captured.error,
						remoteError: "Could not capture the uncommitted changes snapshot.",
					} as ReviewSnapshotResolutionError;
				}
				if (captured.tree === baseTree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return { error: "No uncommitted changes to review." };
				}
				init = {
					description: "uncommitted changes",
					diffCommand: "git diff --no-textconv --no-ext-diff HEAD",
					identity: {
						kind: target.kind,
						baseTree,
						headTree: captured.tree,
						...(headCommit ? { baseCommit: headCommit } : {}),
					},
					root,
					source,
					temporaryDirectories: [temporaryDirectory],
					limits,
				};
				break;
			}
			case "branch": {
				const requestedBase = target.base ?? (await detectBaseBranch(root, limits));
				if (!requestedBase) return { error: "Could not detect a base branch. Use /review branch <base>." };
				const baseRef = await resolveBaseRef(requestedBase, root, limits);
				if (!baseRef) return { error: `Base branch "${requestedBase}" not found.` };
				const source = await createLocalSource(root, limits);
				const baseCommit = await requireCanonicalCommit(source, baseRef);
				const headCommit = await requireCanonicalCommit(source, "HEAD");
				if (!baseCommit || !headCommit) return { error: "Could not resolve the branch endpoints." };
				const mergeBaseResult = await git(source, ["merge-base", baseCommit, headCommit]);
				const mergeBaseCommit = text(mergeBaseResult).trim();
				if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
					return {
						error: `git merge-base failed: ${commandError(mergeBaseResult)}`,
						remoteError: "Could not resolve the branch merge base.",
					};
				}
				const baseTree = await requireCanonicalTree(source, mergeBaseCommit);
				const headTree = await requireCanonicalTree(source, headCommit);
				if (!baseTree || !headTree) return { error: "Could not resolve the branch trees." };
				if (baseTree === headTree) return { error: `No changes between ${baseRef} and HEAD.` };
				const logResult = await git(source, ["log", "--oneline", `${mergeBaseCommit}..${headCommit}`]);
				init = {
					description: `branch changes vs ${baseRef}`,
					diffCommand: `git diff --no-textconv --no-ext-diff ${baseRef}...HEAD`,
					extraContext: logResult.ok && text(logResult).trim() ? `Commits:\n${text(logResult).trim()}` : undefined,
					identity: { kind: target.kind, baseCommit, mergeBaseCommit, headCommit, baseTree, headTree },
					root,
					source,
					temporaryDirectories: [],
					limits,
				};
				break;
			}
			case "commit": {
				const ref = target.sha?.trim();
				if (!ref) return { error: "Missing commit ref." };
				if (Buffer.byteLength(ref, "utf8") > options.maxCommitRefBytes) {
					return { error: `Commit ref exceeds ${options.maxCommitRefBytes} UTF-8 bytes.` };
				}
				const source = await createLocalSource(root, limits);
				const headCommit = await requireCanonicalCommit(source, ref);
				if (!headCommit) return { error: "Commit ref was not found or does not resolve to a commit." };
				const headTree = await requireCanonicalTree(source, headCommit);
				if (!headTree) return { error: "Could not resolve the commit tree." };
				const parentCommit = await requireCanonicalCommit(source, `${headCommit}^1`);
				const baseTree = parentCommit
					? await requireCanonicalTree(source, parentCommit)
					: await createEmptyTree(source);
				if (!baseTree) return { error: "Could not resolve the commit base tree." };
				const showResult = await git(source, ["show", "-s", "--format=%h %s", headCommit]);
				init = {
					description: `commit ${headCommit}`,
					workflowDescription: `commit ${headCommit}`,
					diffCommand: `git show --stat --patch --diff-merges=first-parent --no-textconv --no-ext-diff ${headCommit}`,
					extraContext: showResult.ok ? `Commit: ${text(showResult).trim()}` : undefined,
					identity: {
						kind: target.kind,
						...(parentCommit ? { baseCommit: parentCommit } : {}),
						headCommit,
						baseTree,
						headTree,
					},
					root,
					source,
					temporaryDirectories: [],
					limits,
				};
				break;
			}
			case "pr": {
				const normalized = normalizePullRequestNumber(target.number, options.maxPullRequestNumber);
				if (target.number?.trim() && !normalized) {
					return {
						error: `PR number must be a canonical positive decimal no greater than ${options.maxPullRequestNumber}.`,
					};
				}
				const numberArgs = normalized ? [normalized] : [];
				const viewResult = await runCommand(
					"gh",
					[
						"pr",
						"view",
						...numberArgs,
						"--json",
						"number,title,body,baseRefName,headRefName,url,baseRefOid,headRefOid",
					],
					root,
					commandOptions(limits),
				);
				if (!viewResult.ok) {
					const stderr = commandError(viewResult);
					if (/ENOENT|not found|not recognized/i.test(stderr)) {
						return { error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
					}
					return {
						error: `gh pr view failed: ${stderr}`,
						remoteError: "Could not load pull request metadata with GitHub CLI.",
					};
				}
				const pullRequest = parsePullRequestView(text(viewResult), options.maxPullRequestNumber);
				if (!pullRequest) return { error: "Could not parse gh pr view output." };
				const fetched = await createPullRequestSource(root, pullRequest, limits);
				if (!fetched.source || !fetched.temporaryDirectory)
					return fetched.error ?? { error: "Could not fetch pull request snapshot." };
				const source = fetched.source;
				const mergeBaseResult = await git(source, ["merge-base", pullRequest.baseRefOid, pullRequest.headRefOid]);
				const mergeBaseCommit = text(mergeBaseResult).trim();
				if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return {
						error: "Could not resolve the pull request merge base.",
						remoteError: "Could not resolve the pull request merge base.",
					};
				}
				const baseTree = await requireCanonicalTree(source, mergeBaseCommit);
				const headTree = await requireCanonicalTree(source, pullRequest.headRefOid);
				if (!baseTree || !headTree) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return { error: "Could not resolve pull request trees." };
				}
				if (baseTree === headTree) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return { error: `PR #${pullRequest.number} has an empty diff.` };
				}
				const bodyText = pullRequest.body.trim();
				init = {
					description: `PR #${pullRequest.number} (${pullRequest.title})`,
					workflowDescription: `PR #${pullRequest.number}`,
					diffCommand: `gh pr diff ${pullRequest.number}`,
					extraContext: [
						`PR #${pullRequest.number}: ${pullRequest.title}`,
						`Base branch: ${pullRequest.baseRefName}`,
						`Head branch: ${pullRequest.headRefName}`,
						`URL: ${pullRequest.url}`,
						bodyText ? `Description:\n${bodyText}` : undefined,
					]
						.filter((line): line is string => line !== undefined)
						.join("\n"),
					identity: {
						kind: target.kind,
						baseCommit: pullRequest.baseRefOid,
						mergeBaseCommit,
						headCommit: pullRequest.headRefOid,
						baseTree,
						headTree,
						pullRequest,
					},
					root,
					source,
					temporaryDirectories: [fetched.temporaryDirectory],
					limits,
				};
				break;
			}
		}
		if (!init) return { error: "Could not initialize the review snapshot." };
		return await GitReviewSnapshot.create(init);
	} catch (error) {
		if (init) {
			for (const directory of init.temporaryDirectories)
				await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export async function readReviewPolicyFile(
	snapshot: ReviewSnapshot,
	revision: ReviewSnapshotRevision,
	path: string,
): Promise<string | undefined> {
	const file = await snapshot.readFile(revision, path);
	if (!file) return undefined;
	if (!file.available) throw new Error(`Could not load snapshot policy ${path}: ${file.message}`);
	if (file.binary) throw new Error(`Could not load snapshot policy ${path}: policy content is binary.`);
	return file.content.toString("utf8");
}

export async function readUserReviewPolicy(agentDir: string): Promise<string | undefined> {
	try {
		return await readFile(join(agentDir, "REVIEW.md"), "utf8");
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}
