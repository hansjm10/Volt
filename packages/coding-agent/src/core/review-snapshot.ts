import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";
import { terminateProcessTree } from "../utils/shell.ts";
import {
	captureReviewGitHubContext,
	type ReviewGitHubContext,
	type ReviewPullRequestIdentity,
} from "./github-pr-context.ts";

export type { ReviewPullRequestIdentity } from "./github-pr-context.ts";

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

export interface ReviewSnapshotSearchOptions {
	revision: ReviewSnapshotRevision;
	query: string;
	prefix?: string;
	ignoreCase?: boolean;
	fileIndex?: number;
	lineIndex?: number;
	limit: number;
	maxFiles: number;
	signal?: AbortSignal;
}

export interface ReviewSnapshotSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface ReviewSnapshotSearchResult {
	matches: ReviewSnapshotSearchMatch[];
	filesScanned: number;
	skippedPaths: Array<{ path: string; reason: string }>;
	nextFileIndex: number;
	nextLineIndex: number;
	complete: boolean;
}

export interface ReviewSnapshot {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	githubContext?: ReviewGitHubContext;
	identity: ReviewSnapshotIdentity;
	changedFiles: ReviewChangedFile[];
	root: string;
	readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined>;
	listFiles(options?: ReviewSnapshotListOptions): Promise<ReviewSnapshotTreeEntry[]>;
	search(options: ReviewSnapshotSearchOptions): Promise<ReviewSnapshotSearchResult>;
	materializeHead(): Promise<string>;
	dispose(): Promise<void>;
}

export interface ReviewSnapshotResolutionError {
	error: string;
	remoteError?: string;
	cancelled?: true;
}

export interface ResolveReviewSnapshotOptions {
	maxCommitRefBytes: number;
	maxPullRequestNumber: number;
	limits?: Partial<ReviewSnapshotLimits>;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
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
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	failure?: CommandOutputLimitFailure;
}

interface GitSource {
	cwd: string;
	env?: Record<string, string>;
	objectDirectories: string[];
	limits: ReviewSnapshotLimits;
	signal?: AbortSignal;
}

interface SnapshotInit {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	githubContext?: ReviewGitHubContext;
	identity: ReviewSnapshotIdentity;
	root: string;
	source: GitSource;
	temporaryDirectories: string[];
	limits: ReviewSnapshotLimits;
}

const CANONICAL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_STABLE_CAPTURE_ATTEMPTS = 3;
const SEARCH_PATH_CHUNK_MAX_COUNT = 256;
const SEARCH_PATH_CHUNK_MAX_BYTES = 24 * 1024;
const SEARCH_MANIFEST_MAX_ENTRIES = 250_000;
const SEARCH_MANIFEST_MAX_PATH_BYTES = 16 * 1024 * 1024;
const SEARCH_MANIFEST_CACHE_MAX_ENTRIES = 2;
const SEARCH_RESULT_MAX_MATCHES = 250_000;
const SEARCH_RESULT_MAX_BYTES = 64 * 1024 * 1024;
const SEARCH_RESULT_CACHE_MAX_ENTRIES = 16;
const SEARCH_RESULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SEARCH_RESULT_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const SEARCH_READ_MAX_BYTES = 256 * 1024 * 1024;
const SEARCH_FALLBACK_READ_MAX_BYTES = 64 * 1024 * 1024;
const GIT_BINARY_PROBE_BYTES = 8_000;
const REVIEW_BINARY_PROBE_BYTES = 8_192;
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
		});
		let stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr: Buffer[] = [];
		let stderrBytes = 0;
		let failure: CommandOutputLimitFailure | undefined;
		let processError: string | undefined;
		let settled = false;
		const onAbort = (): void => {
			proc.stdin?.destroy();
			if (proc.pid) void terminateProcessTree(proc.pid);
			else proc.kill();
		};
		const finish = (result: CommandResult): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
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
			if (error.name === "AbortError") {
				processError = error.message;
				return;
			}
			finish({ ok: false, exitCode: null, stdout: Buffer.concat(stdout), stderr: error.message });
		});
		proc.on("close", (code) => {
			if (failure) {
				finish({ ok: false, exitCode: code, stdout: Buffer.alloc(0), stderr: "", failure });
				return;
			}
			finish({
				ok: code === 0 && processError === undefined,
				exitCode: code,
				stdout: Buffer.concat(stdout, stdoutBytes),
				stderr: processError ?? Buffer.concat(stderr, stderrBytes).toString("utf8"),
			});
		});
		proc.stdin?.on("error", () => {});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		else if (options.input !== undefined) proc.stdin?.end(options.input);
	});
}

async function git(
	source: Pick<GitSource, "cwd" | "env" | "limits" | "signal">,
	args: string[],
	input?: Buffer | string,
	maxStdoutBytes = source.limits.maxMetadataBytes,
): Promise<CommandResult> {
	throwIfResolutionCancelled(source.signal);
	const result = await runCommand("git", args, source.cwd, {
		env: source.env,
		input,
		signal: source.signal,
		maxStdoutBytes,
		maxStderrBytes: source.limits.maxStderrBytes,
	});
	throwIfResolutionCancelled(source.signal);
	return result;
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

class ReviewSnapshotResolutionCancelledError extends Error {
	constructor() {
		super("Review snapshot resolution was cancelled.");
		this.name = "ReviewSnapshotResolutionCancelledError";
	}
}

function throwIfResolutionCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ReviewSnapshotResolutionCancelledError();
}

function commandOptions(
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): { signal?: AbortSignal; maxStdoutBytes: number; maxStderrBytes: number } {
	return { signal, maxStdoutBytes: limits.maxMetadataBytes, maxStderrBytes: limits.maxStderrBytes };
}

async function repositoryRoot(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryObjectDirectory(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "objects"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryObjectFormat(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<"sha1" | "sha256" | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand("git", ["rev-parse", "--show-object-format"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	const format = text(result).trim();
	return result.ok && (format === "sha1" || format === "sha256") ? format : undefined;
}

async function repositoryIsShallow(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--is-shallow-repository"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	const shallow = text(result).trim();
	return result.ok && (shallow === "true" || shallow === "false") ? shallow === "true" : undefined;
}

async function repositoryIndexFile(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function detectBaseBranch(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const originHead = await runCommand(
		"git",
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
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
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		throwIfOutputLimited("git rev-parse failed", exists);
		if (exists.ok) return candidate;
	}
	return undefined;
}

type ResolvedBranchBase =
	| { kind: "local"; ref: string; displayRef: string }
	| { kind: "remote"; remote: string; remoteRef: string; displayRef: string };

async function listConfiguredRemotes(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string[]> {
	const result = await runCommand("git", ["remote"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git remote failed", result);
	if (!result.ok) throw new Error(`git remote failed: ${commandError(result)}`);
	return text(result)
		.split("\n")
		.map((remote) => remote.trim())
		.filter(Boolean)
		.sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function remoteBranchFromTrackingRef(
	ref: string,
	remotes: readonly string[],
): { remote: string; remoteRef: string } | undefined {
	for (const remote of remotes) {
		const prefix = `refs/remotes/${remote}/`;
		if (!ref.startsWith(prefix) || ref.length === prefix.length) continue;
		return { remote, remoteRef: `refs/heads/${ref.slice(prefix.length)}` };
	}
	return undefined;
}

async function refExists(
	ref: string,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await runCommand(
		"git",
		["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok;
}

async function resolveBranchBase(
	base: string,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<ResolvedBranchBase | undefined> {
	throwIfResolutionCancelled(signal);
	const remotes = await listConfiguredRemotes(cwd, limits, signal);
	const symbolic = await runCommand(
		"git",
		["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", base],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", symbolic);
	const fullRef = symbolic.ok ? text(symbolic).trim() : "";

	// Full refs intentionally preserve local or cached Git state. Short names use
	// the authoritative remote-backed behavior below when one can be identified.
	if (base.startsWith("refs/")) {
		return symbolic.ok ? { kind: "local", ref: base, displayRef: base } : undefined;
	}

	if (fullRef.startsWith("refs/remotes/")) {
		const remoteBranch = remoteBranchFromTrackingRef(fullRef, remotes);
		if (remoteBranch) return { kind: "remote", ...remoteBranch, displayRef: base };
	}

	for (const remote of remotes) {
		const prefix = `${remote}/`;
		if (!base.startsWith(prefix) || base.length === prefix.length) continue;
		return {
			kind: "remote",
			remote,
			remoteRef: `refs/heads/${base.slice(prefix.length)}`,
			displayRef: base,
		};
	}

	if (fullRef === `refs/heads/${base}`) {
		const branchName = fullRef.slice("refs/heads/".length);
		const upstream = await runCommand(
			"git",
			["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)", fullRef],
			cwd,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		throwIfOutputLimited("git for-each-ref failed", upstream);
		if (!upstream.ok) throw new Error(`git for-each-ref failed: ${commandError(upstream)}`);
		const [upstreamRemote, upstreamRemoteRef, upstreamShort] = text(upstream).trim().split("\0");
		if (upstreamRemote && upstreamRemote !== "." && upstreamRemoteRef?.startsWith("refs/heads/")) {
			return {
				kind: "remote",
				remote: upstreamRemote,
				remoteRef: upstreamRemoteRef,
				displayRef: upstreamShort || `${upstreamRemote}/${upstreamRemoteRef.slice("refs/heads/".length)}`,
			};
		}

		const matchingRemotes: string[] = [];
		for (const remote of remotes) {
			if (await refExists(`refs/remotes/${remote}/${branchName}`, cwd, limits, signal)) matchingRemotes.push(remote);
		}
		const remote = matchingRemotes.includes("origin")
			? "origin"
			: matchingRemotes.length === 1
				? matchingRemotes[0]
				: undefined;
		if (remote) {
			return {
				kind: "remote",
				remote,
				remoteRef: `refs/heads/${branchName}`,
				displayRef: `${remote}/${branchName}`,
			};
		}
		return { kind: "local", ref: fullRef, displayRef: base };
	}

	if (symbolic.ok) return { kind: "local", ref: base, displayRef: base };

	const matchingRemotes: string[] = [];
	for (const remote of remotes) {
		if (await refExists(`refs/remotes/${remote}/${base}`, cwd, limits, signal)) matchingRemotes.push(remote);
	}
	const remote = matchingRemotes.includes("origin")
		? "origin"
		: matchingRemotes.length === 1
			? matchingRemotes[0]
			: undefined;
	return remote
		? { kind: "remote", remote, remoteRef: `refs/heads/${base}`, displayRef: `${remote}/${base}` }
		: undefined;
}

function normalizePullRequestNumber(value: string | undefined, maximum: number): string | undefined {
	const number = value?.trim();
	if (!number) return undefined;
	if (!/^[1-9]\d*$/.test(number)) return undefined;
	const numeric = Number(number);
	return Number.isSafeInteger(numeric) && numeric <= maximum ? number : undefined;
}

async function createLocalSource(root: string, limits: ReviewSnapshotLimits, signal?: AbortSignal): Promise<GitSource> {
	const objects = await repositoryObjectDirectory(root, limits, signal);
	if (!objects) throw new Error("Could not resolve the Git object directory.");
	return { cwd: root, objectDirectories: [objects], limits, signal };
}

async function createRemoteBranchSource(
	root: string,
	remote: string,
	remoteRef: string,
	headCommit: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{
	source?: GitSource;
	baseCommit?: string;
	temporaryDirectory?: string;
	error?: ReviewSnapshotResolutionError;
}> {
	throwIfResolutionCancelled(signal);
	const [localObjects, objectFormat, remoteUrlResult] = await Promise.all([
		repositoryObjectDirectory(root, limits, signal),
		repositoryObjectFormat(root, limits, signal),
		runCommand("git", ["remote", "get-url", remote], root, commandOptions(limits, signal)),
	]);
	throwIfResolutionCancelled(signal);
	if (!localObjects) {
		return {
			error: {
				error: "Could not resolve the Git object directory.",
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	}
	if (!objectFormat) {
		return {
			error: {
				error: "Could not resolve the Git object format.",
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	}
	if (!remoteUrlResult.ok || !text(remoteUrlResult).trim()) {
		return {
			error: {
				error: `Could not resolve Git remote "${remote}": ${commandError(remoteUrlResult)}`,
				remoteError: "Could not resolve the review base remote.",
			},
		};
	}

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-branch-"));
	let retainTemporaryDirectory = false;
	try {
		const init = await runCommand(
			"git",
			["init", "--bare", `--object-format=${objectFormat}`],
			temporaryDirectory,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		if (!init.ok) {
			return {
				error: {
					...commandFailure("git init failed", init),
					remoteError: "Could not prepare the isolated review base.",
				},
			};
		}

		const objects = join(temporaryDirectory, "objects");
		await mkdir(join(objects, "info"), { recursive: true });
		await writeFile(join(objects, "info", "alternates"), `${resolve(localObjects)}\n`, "utf8");
		throwIfResolutionCancelled(signal);
		const source: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: [objects, localObjects],
			limits,
			signal,
		};
		const pinHead = await git(source, ["update-ref", "refs/review/head", headCommit]);
		if (!pinHead.ok) {
			return {
				error: {
					...commandFailure("git update-ref failed", pinHead),
					remoteError: "Could not capture the review branch endpoints.",
				},
			};
		}
		const fetch = await git(source, [
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
			"--force",
			text(remoteUrlResult).trim(),
			`+${remoteRef}:refs/review/base`,
		]);
		if (!fetch.ok) {
			return {
				error: {
					error: `git fetch failed: ${commandError(fetch)}`,
					remoteError: "Could not refresh the review base branch.",
				},
			};
		}
		const baseCommit = await requireCanonicalCommit(source, "refs/review/base");
		const pinnedHead = await requireCanonicalCommit(source, "refs/review/head");
		if (!baseCommit || pinnedHead !== headCommit) {
			return {
				error: {
					error: "Could not pin the fetched branch review endpoints.",
					remoteError: "Could not capture the review branch endpoints.",
				},
			};
		}
		retainTemporaryDirectory = true;
		return { source, baseCommit, temporaryDirectory };
	} catch (error) {
		if (error instanceof ReviewSnapshotResolutionCancelledError || signal?.aborted) throw error;
		return {
			error: {
				error: error instanceof Error ? error.message : String(error),
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	} finally {
		if (!retainTemporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

async function createUncommittedSource(
	root: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{ source: GitSource; temporaryDirectory: string; originalIndex: string }> {
	const originalObjects = await repositoryObjectDirectory(root, limits, signal);
	if (!originalObjects) throw new Error("Could not resolve the Git object directory.");
	const originalIndex = await repositoryIndexFile(root, limits, signal);
	if (!originalIndex) throw new Error("Could not resolve the Git index file.");
	throwIfResolutionCancelled(signal);
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
		signal,
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

function untrackedWindowsNullDevicePathspecs(status: Buffer): string[] {
	if (process.platform !== "win32") return [];
	return status
		.toString("utf8")
		.split("\0")
		.filter((entry) => entry.startsWith("? "))
		.map((entry) => entry.slice(2))
		.filter((path) => path.split("/").some((segment) => /^nul(?:\..*)?$/i.test(segment)))
		.map((path) => `:(top,exclude,literal)${path}`);
}

async function stageWorktree(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
	status: Buffer,
): Promise<ReviewSnapshotResolutionError | undefined> {
	const seedError = await seedTemporaryIndex(source, originalIndex, baseTree);
	if (seedError) return seedError;
	// Git Bash can create a literal NUL file, but Git for Windows resolves that
	// name as the null device and cannot index it. Exclude only untracked NUL
	// paths; tracked entries remain preserved in Volt's copied index.
	const addArgs = ["add", "-A", "--", ...untrackedWindowsNullDevicePathspecs(status)];
	let add = await git(source, addArgs);
	if (add.ok) return undefined;
	if (!/fatal: will not add file alias .* already exists in index/i.test(add.stderr)) {
		return commandFailure("git add failed", add);
	}

	// A case-insensitive filesystem can check out case-only aliases from the
	// same tree, but Git refuses to refresh them with core.ignorecase enabled.
	// The retry only mutates Volt's temporary index, never the user's index.
	const retrySeedError = await seedTemporaryIndex(source, originalIndex, baseTree);
	if (retrySeedError) return retrySeedError;
	add = await git(source, ["-c", "core.ignorecase=false", ...addArgs]);
	return add.ok ? undefined : commandFailure("git add failed", add);
}

async function captureWorktreeTree(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
): Promise<{ tree?: string; error?: ReviewSnapshotResolutionError }> {
	for (let attempt = 1; attempt <= MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
		const before = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!before.ok) return { error: commandFailure("git status failed", before) };
		const firstStageError = await stageWorktree(source, originalIndex, baseTree, before.stdout);
		if (firstStageError) return { error: firstStageError };
		const firstTreeResult = await git(source, ["write-tree"]);
		if (!firstTreeResult.ok) return { error: commandFailure("git write-tree failed", firstTreeResult) };
		const after = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!after.ok) return { error: commandFailure("git status failed", after) };
		const secondStageError = await stageWorktree(source, originalIndex, baseTree, after.stdout);
		if (secondStageError) return { error: secondStageError };
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
	pullRequest: ReviewPullRequestIdentity,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{ source?: GitSource; temporaryDirectory?: string; error?: ReviewSnapshotResolutionError }> {
	throwIfResolutionCancelled(signal);
	const [localObjects, objectFormat, sourceIsShallow, originResult] = await Promise.all([
		repositoryObjectDirectory(root, limits, signal),
		repositoryObjectFormat(root, limits, signal),
		repositoryIsShallow(root, limits, signal),
		runCommand("git", ["remote", "get-url", "origin"], root, commandOptions(limits, signal)),
	]);
	throwIfResolutionCancelled(signal);
	if (!localObjects) return { error: { error: "Could not resolve the Git object directory." } };
	if (!objectFormat) return { error: { error: "Could not resolve the Git object format." } };
	if (!originResult.ok || !text(originResult).trim()) {
		return { error: { error: "Could not resolve the origin remote for the pull request snapshot." } };
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-pr-"));
	let retainTemporaryDirectory = false;
	try {
		const init = await runCommand(
			"git",
			["init", "--bare", `--object-format=${objectFormat}`],
			temporaryDirectory,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		if (!init.ok) return { error: commandFailure("git init failed", init) };
		const objects = join(temporaryDirectory, "objects");
		const alternatesPath = join(objects, "info", "alternates");
		const borrowLocalObjects = sourceIsShallow === false;
		if (borrowLocalObjects) {
			await mkdir(join(objects, "info"), { recursive: true });
			await writeFile(alternatesPath, `${resolve(localObjects)}\n`, "utf8");
		}
		throwIfResolutionCancelled(signal);
		const fetchSource: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: borrowLocalObjects ? [objects, localObjects] : [objects],
			limits,
			signal,
		};
		const fetch = await git(fetchSource, [
			"fetch",
			"--no-tags",
			"--force",
			text(originResult).trim(),
			`+refs/heads/${pullRequest.baseRefName}:refs/review/base`,
			`+refs/pull/${pullRequest.number}/head:refs/review/head`,
		]);
		if (!fetch.ok) {
			return {
				error: {
					error: `git fetch failed: ${commandError(fetch)}`,
					remoteError: "Could not fetch the exact pull request snapshot.",
				},
			};
		}
		const fetchedBase = await requireCanonicalCommit(fetchSource, "refs/review/base");
		const fetchedHead = await requireCanonicalCommit(fetchSource, "refs/review/head");
		if (fetchedBase !== pullRequest.baseRefOid || fetchedHead !== pullRequest.headRefOid) {
			return {
				error: {
					error: "The pull request moved while Volt captured it. Retry the review.",
					remoteError: "The pull request changed while Volt captured it. Retry the review.",
				},
			};
		}
		const repack = await git(fetchSource, ["repack", "-a", "-d"]);
		if (!repack.ok) {
			return {
				error: {
					error: `git repack failed: ${commandError(repack)}`,
					remoteError: "Could not make the pull request snapshot self-contained.",
				},
			};
		}
		await rm(alternatesPath, { force: true });
		throwIfResolutionCancelled(signal);
		const source: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: [objects],
			limits,
			signal,
		};
		const detachedBase = await requireCanonicalCommit(source, "refs/review/base");
		const detachedHead = await requireCanonicalCommit(source, "refs/review/head");
		if (detachedBase !== pullRequest.baseRefOid || detachedHead !== pullRequest.headRefOid) {
			return {
				error: {
					error: "The pull request snapshot remained dependent on local Git objects.",
					remoteError: "Could not make the pull request snapshot self-contained.",
				},
			};
		}
		retainTemporaryDirectory = true;
		return { source, temporaryDirectory };
	} finally {
		if (!retainTemporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
	}
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

interface ParsedReviewSnapshotTree {
	entries: Map<string, ReviewSnapshotTreeEntry>;
	pathspecUnsafeEntries: Set<ReviewSnapshotTreeEntry>;
}

function parseTree(stdout: Buffer): ParsedReviewSnapshotTree {
	const entries = new Map<string, ReviewSnapshotTreeEntry>();
	const pathspecUnsafeEntries = new Set<ReviewSnapshotTreeEntry>();
	let start = 0;
	while (start < stdout.length) {
		const nul = stdout.indexOf(0, start);
		const token = stdout.subarray(start, nul < 0 ? stdout.length : nul);
		start = nul < 0 ? stdout.length : nul + 1;
		if (token.length === 0) continue;
		const tab = token.indexOf(9);
		if (tab < 0) continue;
		const metadata = token.subarray(0, tab).toString("utf8").split(/\s+/);
		const pathBytes = token.subarray(tab + 1);
		const path = pathBytes.toString("utf8");
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
		const entry: ReviewSnapshotTreeEntry = {
			path,
			mode,
			type,
			oid,
			...(Number.isSafeInteger(size) && size !== undefined && size >= 0 ? { size } : {}),
		};
		entries.set(path, entry);
		if (!Buffer.from(path, "utf8").equals(pathBytes)) pathspecUnsafeEntries.add(entry);
	}
	return { entries, pathspecUnsafeEntries };
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
	return content.subarray(0, Math.min(content.length, REVIEW_BINARY_PROBE_BYTES)).includes(0);
}

function countLines(content: Buffer): number {
	if (content.length === 0) return 0;
	let lines = 1;
	for (const byte of content) if (byte === 10) lines++;
	if (content.at(-1) === 10) lines--;
	return lines;
}

type SearchManifestEntryKind = "text" | "unclassified" | "empty" | "binary" | "symlink" | "oversized" | "unavailable";

interface SearchManifestEntry {
	entry: ReviewSnapshotTreeEntry;
	kind: SearchManifestEntryKind;
	pathspecSafe: boolean;
	reason?: string;
}

interface SearchManifest {
	tree: string;
	entries: SearchManifestEntry[];
}

interface SearchComputation {
	result: ReviewSnapshotSearchResult;
	retainedBytes: number;
}

interface SearchCacheEntry {
	computation: SearchComputation;
	bytes: number;
}

interface SearchInflight {
	key: string;
	controller: AbortController;
	promise: Promise<SearchComputation>;
	waiters: number;
	settled: boolean;
}

interface SearchBlobRequest {
	oid: string;
	size: number;
}

interface SearchBlobReadState {
	contents: Map<string, Buffer | undefined>;
	readBytes: number;
	fallbackOids: Set<string>;
	fallbackBytes: number;
}

interface SearchPathChunks {
	chunks: string[][];
	fallbackPaths: Set<string>;
}

interface GitGrepPathResult {
	matches: Set<string>;
	fallbackPaths: Set<string>;
}

function searchAbortError(): Error {
	return new Error("Review snapshot search was aborted.");
}

function throwIfSearchAborted(signal: AbortSignal): void {
	if (signal.aborted) throw searchAbortError();
}

function searchTree(identity: ReviewSnapshotIdentity, revision: ReviewSnapshotRevision): string {
	return revision === "base" ? identity.baseTree : identity.headTree;
}

function literalSearchPathspec(path: string): string {
	return `:(top,literal)${path}`;
}

function chunkSearchPaths(paths: string[]): SearchPathChunks {
	const chunks: string[][] = [];
	const fallbackPaths = new Set<string>();
	let chunk: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const pathBytes = Buffer.byteLength(literalSearchPathspec(path), "utf8") + 1;
		if (pathBytes > SEARCH_PATH_CHUNK_MAX_BYTES) {
			fallbackPaths.add(path);
			continue;
		}
		if (
			chunk.length > 0 &&
			(chunk.length >= SEARCH_PATH_CHUNK_MAX_COUNT || bytes + pathBytes > SEARCH_PATH_CHUNK_MAX_BYTES)
		) {
			chunks.push(chunk);
			chunk = [];
			bytes = 0;
		}
		chunk.push(path);
		bytes += pathBytes;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return { chunks, fallbackPaths };
}

function parseGitGrepPaths(stdout: Buffer, tree: string, allowedPaths: ReadonlySet<string>): string[] {
	if (stdout.length === 0) return [];
	if (stdout.at(-1) !== 0) throw new Error("git grep returned a non-NUL-terminated path list.");
	const prefix = `${tree}:`;
	const paths: string[] = [];
	let start = 0;
	for (let index = 0; index < stdout.length; index++) {
		if (stdout[index] !== 0) continue;
		const token = stdout.subarray(start, index).toString("utf8");
		start = index + 1;
		if (!token.startsWith(prefix)) throw new Error("git grep returned a path outside the requested snapshot tree.");
		const path = token.slice(prefix.length);
		if (!allowedPaths.has(path)) throw new Error(`git grep returned an unexpected snapshot path: ${path}`);
		paths.push(path);
	}
	return paths;
}

async function gitGrepPaths(
	source: GitSource,
	tree: string,
	paths: string[],
	options: {
		pattern: string;
		binaryMode: "exclude" | "text";
		ignoreCase?: boolean;
		perl?: boolean;
		optional?: boolean;
		signal: AbortSignal;
	},
): Promise<GitGrepPathResult | undefined> {
	const matches = new Set<string>();
	const { chunks, fallbackPaths } = chunkSearchPaths(paths);
	for (const chunk of chunks) {
		throwIfSearchAborted(options.signal);
		const allowedPaths = new Set(chunk);
		const result = await runCommand(
			"git",
			[
				"grep",
				"--no-color",
				"--full-name",
				options.perl ? "-P" : "-F",
				options.binaryMode === "text" ? "--text" : "-I",
				"-l",
				"-z",
				...(options.ignoreCase ? ["-i"] : []),
				"-e",
				options.pattern,
				tree,
				"--",
				...chunk.map(literalSearchPathspec),
			],
			source.cwd,
			{
				env: {
					...source.env,
					GIT_LITERAL_PATHSPECS: "0",
					GIT_GLOB_PATHSPECS: "0",
					GIT_NOGLOB_PATHSPECS: "0",
					GIT_ICASE_PATHSPECS: "0",
					...(options.perl ? { LC_ALL: "C" } : {}),
				},
				signal: options.signal,
				maxStdoutBytes: source.limits.maxMetadataBytes,
				maxStderrBytes: source.limits.maxStderrBytes,
			},
		);
		throwIfSearchAborted(options.signal);
		if (result.failure) {
			if (options.optional) return undefined;
			throw new Error(`git grep failed: ${commandError(result)}`);
		}
		if (result.exitCode === 1) {
			if (result.stdout.length > 0) throw new Error("git grep returned output with a no-match exit status.");
			continue;
		}
		if (result.exitCode !== 0) {
			if (options.optional) return undefined;
			throw new Error(`git grep failed: ${commandError(result)}`);
		}
		for (const path of parseGitGrepPaths(result.stdout, tree, allowedPaths)) matches.add(path);
		if (matches.size > SEARCH_MANIFEST_MAX_ENTRIES) {
			throw new Error(`Review snapshot search exceeded the ${SEARCH_MANIFEST_MAX_ENTRIES} path result limit.`);
		}
	}
	return { matches, fallbackPaths };
}

async function buildSearchManifest(
	source: GitSource,
	identity: ReviewSnapshotIdentity,
	treeEntries: Map<string, ReviewSnapshotTreeEntry>,
	pathspecUnsafeEntries: ReadonlySet<ReviewSnapshotTreeEntry>,
	revision: ReviewSnapshotRevision,
	prefix: string,
	signal: AbortSignal,
): Promise<SearchManifest> {
	throwIfSearchAborted(signal);
	const entries = [...treeEntries.values()]
		.filter(
			(entry) => entry.type === "blob" && (!prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
		)
		.sort((left, right) => left.path.localeCompare(right.path));
	if (entries.length > SEARCH_MANIFEST_MAX_ENTRIES) {
		throw new Error(`Review snapshot search manifest exceeds the ${SEARCH_MANIFEST_MAX_ENTRIES} file limit.`);
	}
	const pathBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.path, "utf8"), 0);
	if (pathBytes > SEARCH_MANIFEST_MAX_PATH_BYTES) {
		throw new Error(
			`Review snapshot search manifest paths exceed the ${formatByteLimit(SEARCH_MANIFEST_MAX_PATH_BYTES)} limit.`,
		);
	}
	const tree = searchTree(identity, revision);
	const ordinaryEntries = entries.filter(
		(entry) =>
			entry.mode !== "120000" &&
			entry.size !== undefined &&
			entry.size > 0 &&
			entry.size <= source.limits.maxBlobBytes,
	);
	const pathspecEntries = ordinaryEntries.filter((entry) => !pathspecUnsafeEntries.has(entry));
	const classification = await gitGrepPaths(
		source,
		tree,
		pathspecEntries.map((entry) => entry.path),
		{ pattern: "", binaryMode: "exclude", signal },
	);
	if (!classification) throw new Error("git grep did not return a required classification set.");
	const ambiguousEntries = pathspecEntries.filter(
		(entry) =>
			classification.fallbackPaths.has(entry.path) ||
			!classification.matches.has(entry.path) ||
			(entry.size ?? 0) > GIT_BINARY_PROBE_BYTES,
	);
	const nulPaths = await gitGrepPaths(
		source,
		tree,
		ambiguousEntries.map((entry) => entry.path),
		{ pattern: "\\x00", binaryMode: "text", perl: true, optional: true, signal },
	);
	const ambiguousPaths = new Set<string>();
	const binaryPaths = new Set<string>();
	for (const entry of ordinaryEntries) {
		if (pathspecUnsafeEntries.has(entry) || classification.fallbackPaths.has(entry.path)) {
			ambiguousPaths.add(entry.path);
			continue;
		}
		if (classification.matches.has(entry.path) && (entry.size ?? 0) <= GIT_BINARY_PROBE_BYTES) continue;
		if (nulPaths === undefined || nulPaths.fallbackPaths.has(entry.path)) {
			ambiguousPaths.add(entry.path);
			continue;
		}
		if (!nulPaths.matches.has(entry.path)) continue;
		if ((entry.size ?? 0) <= REVIEW_BINARY_PROBE_BYTES) binaryPaths.add(entry.path);
		else ambiguousPaths.add(entry.path);
	}
	return {
		tree,
		entries: entries.map((entry): SearchManifestEntry => {
			const pathspecSafe = !pathspecUnsafeEntries.has(entry);
			if (entry.size === undefined) {
				return {
					entry,
					kind: "unavailable",
					pathspecSafe,
					reason: "Git did not report a blob size, so the file was not read.",
				};
			}
			if (entry.size > source.limits.maxBlobBytes) {
				return {
					entry,
					kind: "oversized",
					pathspecSafe,
					reason: `Blob size ${entry.size} bytes exceeds the ${formatByteLimit(source.limits.maxBlobBytes)} snapshot read limit.`,
				};
			}
			if (entry.mode === "120000") return { entry, kind: "symlink", pathspecSafe };
			if (entry.size === 0) return { entry, kind: "empty", pathspecSafe };
			if (binaryPaths.has(entry.path)) {
				return { entry, kind: "binary", pathspecSafe, reason: "Binary content was not searched." };
			}
			if (ambiguousPaths.has(entry.path)) return { entry, kind: "unclassified", pathspecSafe };
			return { entry, kind: "text", pathspecSafe };
		}),
	};
}

function directGitSearchQuery(query: string): boolean {
	for (let index = 0; index < query.length; index++) {
		const code = query.charCodeAt(index);
		if (code === 0 || code === 10 || code > 0x7f) return false;
	}
	return true;
}

function searchBlobBatchBytes(request: SearchBlobRequest): number {
	return request.oid.length + 1 + 4 + 1 + String(request.size).length + 1 + request.size + 1;
}

interface SearchBlobProcessResult {
	exitCode: number | null;
}

class SearchBlobReader {
	private process: ChildProcess | undefined;
	private processResult: Promise<SearchBlobProcessResult> | undefined;
	private processError: Error | undefined;
	private inputError: Error | undefined;
	private outputError: Error | undefined;
	private outputEnded = false;
	private outputChunks: Buffer[] = [];
	private outputBytes = 0;
	private outputLimit = 0;
	private outputWaiter: (() => void) | undefined;
	private stderrChunks: Buffer[] = [];
	private stderrBytes = 0;
	private stderrLimited = false;
	private closing = false;

	private readonly source: GitSource;
	private readonly state: SearchBlobReadState;
	private readonly fallbackOids: ReadonlySet<string>;
	private readonly signal: AbortSignal;

	constructor(source: GitSource, state: SearchBlobReadState, fallbackOids: ReadonlySet<string>, signal: AbortSignal) {
		this.source = source;
		this.state = state;
		this.fallbackOids = fallbackOids;
		this.signal = signal;
	}

	async read(entry: ReviewSnapshotTreeEntry): Promise<Buffer | undefined> {
		if (this.state.contents.has(entry.oid)) return this.state.contents.get(entry.oid);
		if (entry.size === undefined) {
			throw new Error("Review snapshot search could not schedule a selected blob read.");
		}
		const request = { oid: entry.oid, size: entry.size };
		const maxBatchBytes = Math.max(this.source.limits.maxMetadataBytes, this.source.limits.maxBlobBytes + 256);
		if (searchBlobBatchBytes(request) > maxBatchBytes) {
			throw new Error(`Snapshot blob ${request.oid} exceeds the bounded batch-read output limit.`);
		}
		this.reserve(request);
		throwIfSearchAborted(this.signal);
		this.outputLimit = maxBatchBytes;
		const process = this.start();
		try {
			await new Promise<void>((resolveWrite, reject) => {
				try {
					process.stdin?.write(`${request.oid}\n`, (error) => {
						if (error) reject(error);
						else resolveWrite();
					});
				} catch (error) {
					reject(error);
				}
			});
			throwIfSearchAborted(this.signal);
			const content = await this.readResponse(request);
			throwIfSearchAborted(this.signal);
			this.state.contents.set(request.oid, content);
			this.outputLimit = 0;
			return content;
		} catch (error) {
			process.kill();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (!this.process || !this.processResult) return;
		throwIfSearchAborted(this.signal);
		this.process.stdin?.end();
		const result = await this.processResult;
		throwIfSearchAborted(this.signal);
		this.throwOutputError();
		if (this.outputBytes > 0) throw new Error("git cat-file --batch returned unexpected trailing output.");
		this.throwProcessFailure(result);
	}

	async dispose(): Promise<void> {
		this.closing = true;
		if (!this.process || !this.processResult) return;
		this.process.stdin?.destroy();
		this.process.kill();
		await this.processResult;
	}

	private reserve(request: SearchBlobRequest): void {
		const readBytes = this.state.readBytes + request.size;
		if (!Number.isSafeInteger(readBytes) || readBytes > SEARCH_READ_MAX_BYTES) {
			throw new Error(
				`Review snapshot search blob reads exceed the ${formatByteLimit(SEARCH_READ_MAX_BYTES)} aggregate limit.`,
			);
		}
		let fallbackBytes = this.state.fallbackBytes;
		const reserveFallback = this.fallbackOids.has(request.oid) && !this.state.fallbackOids.has(request.oid);
		if (reserveFallback) {
			const fallbackLimit = Math.min(SEARCH_FALLBACK_READ_MAX_BYTES, this.source.limits.maxMetadataBytes);
			fallbackBytes += request.size;
			if (!Number.isSafeInteger(fallbackBytes) || fallbackBytes > fallbackLimit) {
				throw new Error(
					`Review snapshot semantic fallback exceeds the ${formatByteLimit(fallbackLimit)} aggregate read limit.`,
				);
			}
		}
		this.state.readBytes = readBytes;
		if (reserveFallback) {
			this.state.fallbackOids.add(request.oid);
			this.state.fallbackBytes = fallbackBytes;
		}
	}

	private start(): ChildProcess {
		if (this.process) return this.process;
		const child = spawnProcess("git", ["cat-file", "--batch"], {
			cwd: this.source.cwd,
			env: this.source.env ? { ...process.env, ...this.source.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
			signal: this.signal,
		});
		if (!child.stdin || !child.stdout || !child.stderr) {
			child.kill();
			throw new Error("git cat-file --batch did not provide the required pipes.");
		}
		this.process = child;
		child.stdin.on("error", (error) => {
			this.inputError = error;
			this.wakeOutput();
		});
		child.stdout.on("data", (data: Buffer) => {
			if (this.outputError) return;
			if (this.outputLimit === 0) {
				this.outputError = new Error("git cat-file --batch returned unexpected trailing output.");
				child.kill();
				this.wakeOutput();
				return;
			}
			const nextBytes = this.outputBytes + data.length;
			if (!Number.isSafeInteger(nextBytes) || nextBytes > this.outputLimit) {
				this.outputError = new Error(
					`git cat-file --batch failed: stdout exceeded the ${formatByteLimit(this.outputLimit)} capture limit`,
				);
				child.kill();
				this.wakeOutput();
				return;
			}
			this.outputChunks.push(data);
			this.outputBytes = nextBytes;
			this.wakeOutput();
		});
		const finishOutput = (): void => {
			this.outputEnded = true;
			this.wakeOutput();
		};
		child.stdout.once("end", finishOutput);
		child.stdout.once("close", finishOutput);
		child.stdout.once("error", (error) => {
			this.outputError = error;
			finishOutput();
		});
		child.stderr.on("data", (data: Buffer) => {
			if (this.stderrLimited) return;
			this.stderrBytes += data.length;
			if (this.stderrBytes > this.source.limits.maxStderrBytes) {
				this.stderrLimited = true;
				this.stderrChunks = [];
				child.kill();
				return;
			}
			this.stderrChunks.push(data);
		});
		this.processResult = new Promise((resolveResult) => {
			child.once("error", (error) => {
				this.processError = error;
				this.wakeOutput();
			});
			child.once("close", (exitCode) => {
				finishOutput();
				resolveResult({ exitCode });
			});
		});
		return child;
	}

	private async readResponse(request: SearchBlobRequest): Promise<Buffer | undefined> {
		const expectedHeader = `${request.oid} blob ${request.size}`;
		const missingHeader = `${request.oid} missing`;
		const header = await this.readHeader(Math.max(expectedHeader.length, missingHeader.length));
		if (header === missingHeader) {
			if (this.outputBytes > 0) throw new Error("git cat-file --batch returned unexpected trailing output.");
			return undefined;
		}
		if (header !== expectedHeader) {
			throw new Error(`git cat-file --batch returned unexpected metadata for ${request.oid}.`);
		}
		const response = await this.readBytesExactly(request.size + 1, request.oid);
		if (response.at(-1) !== 10) {
			throw new Error(`git cat-file --batch returned truncated content for ${request.oid}.`);
		}
		if (this.outputBytes > 0) throw new Error("git cat-file --batch returned unexpected trailing output.");
		return response.subarray(0, request.size);
	}

	private async readHeader(maxBytes: number): Promise<string> {
		while (true) {
			this.throwOutputError();
			const newline = this.findOutputByte(10);
			if (newline >= 0) {
				if (newline > maxBytes) throw new Error("git cat-file --batch returned unexpected object metadata.");
				const header = this.takeOutputBytes(newline).toString("utf8");
				this.takeOutputBytes(1);
				return header;
			}
			if (this.outputBytes > maxBytes) {
				throw new Error("git cat-file --batch returned unexpected object metadata.");
			}
			if (this.outputEnded || this.processError) {
				await this.throwUnexpectedEnd("git cat-file --batch returned a truncated object header.");
			}
			await this.waitForOutputChange(this.outputBytes);
		}
	}

	private async readBytesExactly(bytes: number, oid: string): Promise<Buffer> {
		while (this.outputBytes < bytes) {
			this.throwOutputError();
			if (this.outputEnded || this.processError) {
				await this.throwUnexpectedEnd(`git cat-file --batch returned truncated content for ${oid}.`);
			}
			await this.waitForOutputChange(this.outputBytes);
		}
		return this.takeOutputBytes(bytes);
	}

	private async waitForOutputChange(previousBytes: number): Promise<void> {
		while (this.outputBytes === previousBytes && !this.outputEnded && !this.outputError && !this.processError) {
			await new Promise<void>((resolveWait) => {
				this.outputWaiter = resolveWait;
			});
		}
		this.throwOutputError();
	}

	private async throwUnexpectedEnd(message: string): Promise<never> {
		throwIfSearchAborted(this.signal);
		if (!this.processResult) throw new Error(message);
		const result = await this.processResult;
		throwIfSearchAborted(this.signal);
		this.throwProcessFailure(result);
		throw new Error(message);
	}

	private throwOutputError(): void {
		if (this.outputError) throw this.outputError;
	}

	private throwProcessFailure(result: SearchBlobProcessResult): void {
		if (this.stderrLimited) {
			throw new Error(
				`git cat-file --batch failed: stderr exceeded the ${formatByteLimit(this.source.limits.maxStderrBytes)} capture limit`,
			);
		}
		const processError = this.processError ?? this.inputError;
		if (processError) throw new Error(`git cat-file --batch failed: ${processError.message}`);
		if (result.exitCode !== 0) {
			const stderr = Buffer.concat(this.stderrChunks, this.stderrBytes).toString("utf8").trim();
			throw new Error(`git cat-file --batch failed: ${stderr || "command exited unsuccessfully"}`);
		}
	}

	private findOutputByte(byte: number): number {
		let offset = 0;
		for (const chunk of this.outputChunks) {
			const index = chunk.indexOf(byte);
			if (index >= 0) return offset + index;
			offset += chunk.length;
		}
		return -1;
	}

	private takeOutputBytes(bytes: number): Buffer {
		const parts: Buffer[] = [];
		let remaining = bytes;
		while (remaining > 0) {
			const chunk = this.outputChunks[0];
			if (!chunk) throw new Error("git cat-file --batch output accounting failed.");
			if (chunk.length <= remaining) {
				parts.push(chunk);
				this.outputChunks.shift();
				remaining -= chunk.length;
			} else {
				parts.push(chunk.subarray(0, remaining));
				this.outputChunks[0] = chunk.subarray(remaining);
				remaining = 0;
			}
		}
		this.outputBytes -= bytes;
		return parts.length === 1 ? (parts[0] ?? Buffer.alloc(0)) : Buffer.concat(parts, bytes);
	}

	private wakeOutput(): void {
		const waiter = this.outputWaiter;
		this.outputWaiter = undefined;
		waiter?.();
	}
}

function searchComputationResult(computation: SearchComputation): ReviewSnapshotSearchResult {
	return {
		...computation.result,
		matches: computation.result.matches.map((match) => ({ ...match })),
		skippedPaths: computation.result.skippedPaths.map((skipped) => ({ ...skipped })),
	};
}

function assertSearchResultBytes(retainedBytes: number): void {
	if (retainedBytes > SEARCH_RESULT_MAX_BYTES) {
		throw new Error(
			`Review snapshot search results exceed the ${formatByteLimit(SEARCH_RESULT_MAX_BYTES)} retained result limit.`,
		);
	}
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
	readonly githubContext?: ReviewGitHubContext;
	readonly identity: ReviewSnapshotIdentity;
	readonly root: string;
	readonly changedFiles: ReviewChangedFile[];
	private readonly source: GitSource;
	private readonly limits: ReviewSnapshotLimits;
	private readonly temporaryDirectories: string[];
	private readonly materializedDirectories: string[] = [];
	private readonly treeEntries = new Map<ReviewSnapshotRevision, Map<string, ReviewSnapshotTreeEntry>>();
	private readonly pathspecUnsafeEntries = new Map<ReviewSnapshotRevision, ReadonlySet<ReviewSnapshotTreeEntry>>();
	private readonly searchManifests = new Map<string, Promise<SearchManifest>>();
	private readonly searchResults = new Map<string, SearchCacheEntry>();
	private readonly searchInflight = new Map<string, SearchInflight>();
	private readonly activeSearchWork = new Set<Promise<unknown>>();
	private readonly disposalController = new AbortController();
	private searchResultCacheBytes = 0;
	private disposed = false;

	private constructor(
		init: SnapshotInit,
		changedFiles: ReviewChangedFile[],
		baseInventory: ParsedReviewSnapshotTree,
		headInventory: ParsedReviewSnapshotTree,
	) {
		this.description = init.description;
		this.workflowDescription = init.workflowDescription;
		this.diffCommand = init.diffCommand;
		this.extraContext = init.extraContext;
		this.githubContext = init.githubContext;
		this.identity = init.identity;
		this.root = init.root;
		this.source = init.source;
		this.limits = init.limits;
		this.temporaryDirectories = init.temporaryDirectories;
		this.changedFiles = changedFiles;
		this.treeEntries.set("base", baseInventory.entries);
		this.treeEntries.set("head", headInventory.entries);
		this.pathspecUnsafeEntries.set("base", baseInventory.pathspecUnsafeEntries);
		this.pathspecUnsafeEntries.set("head", headInventory.pathspecUnsafeEntries);
	}

	static async create(init: SnapshotInit): Promise<GitReviewSnapshot> {
		const baseTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.baseTree]);
		const headTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.headTree]);
		if (!baseTreeResult.ok || !headTreeResult.ok) {
			throw new Error(
				`Could not inventory review snapshot trees: ${commandError(baseTreeResult.ok ? headTreeResult : baseTreeResult)}`,
			);
		}
		const baseInventory = parseTree(baseTreeResult.stdout);
		const headInventory = parseTree(headTreeResult.stdout);
		const changedFiles = await buildChangedFiles(
			init.source,
			init.identity.baseTree,
			init.identity.headTree,
			baseInventory.entries,
			headInventory.entries,
		);
		return new GitReviewSnapshot(init, changedFiles, baseInventory, headInventory);
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

	async search(options: ReviewSnapshotSearchOptions): Promise<ReviewSnapshotSearchResult> {
		this.assertActive();
		if (!options.query) throw new Error("Review snapshot search query must not be empty.");
		for (const [name, value, minimum] of [
			["fileIndex", options.fileIndex ?? 0, 0],
			["lineIndex", options.lineIndex ?? 0, 0],
			["limit", options.limit, 1],
			["maxFiles", options.maxFiles, 1],
		] as const) {
			if (!Number.isSafeInteger(value) || value < minimum) {
				throw new Error(`Review snapshot search ${name} is outside its supported range.`);
			}
		}
		if (options.signal?.aborted) throw searchAbortError();
		const prefix = options.prefix === undefined || options.prefix === "" ? "" : normalizeReviewPath(options.prefix);
		const normalized: ReviewSnapshotSearchOptions = {
			...options,
			prefix,
			ignoreCase: options.ignoreCase ?? false,
			fileIndex: options.fileIndex ?? 0,
			lineIndex: options.lineIndex ?? 0,
		};
		const key = JSON.stringify([
			options.revision,
			prefix,
			options.query,
			normalized.ignoreCase,
			normalized.fileIndex,
			normalized.lineIndex,
			normalized.limit,
			normalized.maxFiles,
		]);
		const cached = this.takeCachedSearchResult(key);
		if (cached) return searchComputationResult(cached);
		let inflight = this.searchInflight.get(key);
		if (inflight?.controller.signal.aborted && !inflight.settled) {
			if (this.searchInflight.get(key) === inflight) this.searchInflight.delete(key);
			inflight = undefined;
		}
		if (!inflight) inflight = this.startSearchComputation(key, normalized);
		const computation = await this.waitForSearchComputation(inflight, options.signal);
		return searchComputationResult(computation);
	}

	private startSearchComputation(key: string, options: ReviewSnapshotSearchOptions): SearchInflight {
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, this.disposalController.signal]);
		const promise = this.computeSearch(options, signal);
		const inflight: SearchInflight = { key, controller, promise, waiters: 0, settled: false };
		this.searchInflight.set(key, inflight);
		this.trackSearchWork(promise);
		void promise.then(
			(computation) => {
				inflight.settled = true;
				if (this.searchInflight.get(key) === inflight) this.searchInflight.delete(key);
				if (!this.disposed && !controller.signal.aborted) this.cacheSearchResult(key, computation);
			},
			() => {
				inflight.settled = true;
				if (this.searchInflight.get(key) === inflight) this.searchInflight.delete(key);
			},
		);
		return inflight;
	}

	private waitForSearchComputation(
		inflight: SearchInflight,
		signal: AbortSignal | undefined,
	): Promise<SearchComputation> {
		inflight.waiters++;
		return new Promise((resolveResult, reject) => {
			let settled = false;
			const release = (aborted: boolean): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				inflight.waiters--;
				if (aborted && inflight.waiters === 0 && !inflight.settled) {
					if (this.searchInflight.get(inflight.key) === inflight) this.searchInflight.delete(inflight.key);
					inflight.controller.abort();
				}
			};
			const onAbort = (): void => {
				release(true);
				reject(searchAbortError());
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			void inflight.promise.then(
				(computation) => {
					release(false);
					resolveResult(computation);
				},
				(error: unknown) => {
					release(false);
					reject(error);
				},
			);
		});
	}

	private async computeSearch(options: ReviewSnapshotSearchOptions, signal: AbortSignal): Promise<SearchComputation> {
		const manifest = await this.waitForSearchPromise(
			this.getSearchManifest(options.revision, options.prefix ?? ""),
			signal,
		);
		throwIfSearchAborted(signal);
		const entries = manifest.entries;
		const firstFileIndex = options.fileIndex ?? 0;
		const pageEntries = entries.slice(firstFileIndex, firstFileIndex + options.maxFiles);
		const textEntries = pageEntries.filter((entry) => entry.kind === "text");
		const fallbackEntries = pageEntries.filter((entry) => entry.kind === "unclassified" || entry.kind === "symlink");
		const selectedPaths = new Set<string>();
		const fallbackPaths = new Set<string>();
		const ignoreCase = options.ignoreCase === true;
		if (directGitSearchQuery(options.query)) {
			const pathspecTextEntries = textEntries.filter((entry) => entry.pathspecSafe);
			for (const { entry, pathspecSafe } of textEntries) {
				if (pathspecSafe) continue;
				selectedPaths.add(entry.path);
				fallbackPaths.add(entry.path);
			}
			const directMatches = await gitGrepPaths(
				this.source,
				manifest.tree,
				pathspecTextEntries.map(({ entry }) => entry.path),
				{ pattern: options.query, binaryMode: "text", ignoreCase, signal },
			);
			if (!directMatches) throw new Error("git grep did not return a required candidate set.");
			for (const path of directMatches.matches) selectedPaths.add(path);
			for (const path of directMatches.fallbackPaths) {
				selectedPaths.add(path);
				fallbackPaths.add(path);
			}
			if (ignoreCase) {
				const nonAsciiPaths = await gitGrepPaths(
					this.source,
					manifest.tree,
					pathspecTextEntries.map(({ entry }) => entry.path),
					{ pattern: "[^\\x00-\\x7f]", binaryMode: "text", perl: true, optional: true, signal },
				);
				for (const { entry } of nonAsciiPaths === undefined
					? pathspecTextEntries
					: pathspecTextEntries.filter(
							({ entry }) =>
								nonAsciiPaths.matches.has(entry.path) || nonAsciiPaths.fallbackPaths.has(entry.path),
						)) {
					selectedPaths.add(entry.path);
					fallbackPaths.add(entry.path);
				}
			}
		} else {
			for (const { entry } of textEntries) {
				selectedPaths.add(entry.path);
				fallbackPaths.add(entry.path);
			}
		}
		for (const { entry } of fallbackEntries) {
			selectedPaths.add(entry.path);
			fallbackPaths.add(entry.path);
		}
		const fallbackOids = new Set(
			pageEntries.filter(({ entry }) => fallbackPaths.has(entry.path)).map(({ entry }) => entry.oid),
		);
		const readState: SearchBlobReadState = {
			contents: new Map<string, Buffer | undefined>(),
			readBytes: 0,
			fallbackOids: new Set<string>(),
			fallbackBytes: 0,
		};
		const blobReader = new SearchBlobReader(this.source, readState, fallbackOids, signal);

		const matches: ReviewSnapshotSearchMatch[] = [];
		const skippedPaths: Array<{ path: string; reason: string }> = [];
		let nextFileIndex = firstFileIndex;
		let nextLineIndex = options.lineIndex ?? 0;
		let filesScanned = 0;
		let retainedBytes = 0;
		const needle = ignoreCase ? options.query.toLocaleLowerCase() : options.query;
		try {
			while (nextFileIndex < entries.length && filesScanned < options.maxFiles && matches.length < options.limit) {
				throwIfSearchAborted(signal);
				const manifestEntry = entries[nextFileIndex];
				const { entry } = manifestEntry;
				filesScanned++;
				if (manifestEntry.reason) {
					skippedPaths.push({ path: entry.path, reason: manifestEntry.reason });
					retainedBytes +=
						Buffer.byteLength(entry.path, "utf8") + Buffer.byteLength(manifestEntry.reason, "utf8") + 32;
					assertSearchResultBytes(retainedBytes);
					nextFileIndex++;
					nextLineIndex = 0;
					continue;
				}
				if (!selectedPaths.has(entry.path)) {
					nextFileIndex++;
					nextLineIndex = 0;
					continue;
				}
				if (!readState.contents.has(entry.oid)) {
					await blobReader.read(entry);
					throwIfSearchAborted(signal);
				}
				const content = readState.contents.get(entry.oid);
				let skipReason: string | undefined;
				if (content === undefined) {
					skipReason = `Could not read the snapshot blob: object ${entry.oid} is unavailable.`;
				} else if (isBinary(content)) {
					skipReason = "Binary content was not searched.";
				}
				if (skipReason) {
					skippedPaths.push({ path: entry.path, reason: skipReason });
					retainedBytes += Buffer.byteLength(entry.path, "utf8") + Buffer.byteLength(skipReason, "utf8") + 32;
					assertSearchResultBytes(retainedBytes);
					nextFileIndex++;
					nextLineIndex = 0;
					continue;
				}
				if (content === undefined) throw new Error("Review snapshot search content was unexpectedly unavailable.");
				const lines = content.toString("utf8").split("\n");
				while (nextLineIndex < lines.length && matches.length < options.limit) {
					const line = lines[nextLineIndex] ?? "";
					const haystack = ignoreCase ? line.toLocaleLowerCase() : line;
					if (haystack.includes(needle)) {
						const match = { path: entry.path, line: nextLineIndex + 1, text: line.slice(0, 500) };
						matches.push(match);
						retainedBytes += Buffer.byteLength(match.path, "utf8") + Buffer.byteLength(match.text, "utf8") + 32;
						assertSearchResultBytes(retainedBytes);
						if (matches.length > SEARCH_RESULT_MAX_MATCHES) {
							throw new Error(
								`Review snapshot search exceeds the ${SEARCH_RESULT_MAX_MATCHES} retained match limit.`,
							);
						}
					}
					nextLineIndex++;
				}
				if (nextLineIndex >= lines.length) {
					nextFileIndex++;
					nextLineIndex = 0;
				}
			}
			const computation = {
				result: {
					matches,
					filesScanned,
					skippedPaths,
					nextFileIndex,
					nextLineIndex,
					complete: nextFileIndex >= entries.length,
				},
				retainedBytes,
			};
			await blobReader.close();
			return computation;
		} catch (error) {
			await blobReader.dispose();
			throw error;
		}
	}

	private getSearchManifest(revision: ReviewSnapshotRevision, prefix: string): Promise<SearchManifest> {
		this.assertActive();
		const key = JSON.stringify([revision, prefix]);
		const existing = this.searchManifests.get(key);
		if (existing) {
			this.searchManifests.delete(key);
			this.searchManifests.set(key, existing);
			return existing;
		}
		const entries = this.treeEntries.get(revision);
		const pathspecUnsafeEntries = this.pathspecUnsafeEntries.get(revision);
		if (!entries || !pathspecUnsafeEntries) {
			throw new Error(`Review snapshot ${revision} tree inventory is unavailable.`);
		}
		const promise = buildSearchManifest(
			this.source,
			this.identity,
			entries,
			pathspecUnsafeEntries,
			revision,
			prefix,
			this.disposalController.signal,
		);
		this.searchManifests.set(key, promise);
		while (this.searchManifests.size > SEARCH_MANIFEST_CACHE_MAX_ENTRIES) {
			const oldestKey = this.searchManifests.keys().next().value;
			if (oldestKey === undefined) break;
			this.searchManifests.delete(oldestKey);
		}
		this.trackSearchWork(promise);
		void promise.then(undefined, () => {
			if (this.searchManifests.get(key) === promise) this.searchManifests.delete(key);
		});
		return promise;
	}

	private waitForSearchPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal.aborted) return Promise.reject(searchAbortError());
		return new Promise((resolveResult, reject) => {
			let settled = false;
			const finish = (): boolean => {
				if (settled) return false;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				return true;
			};
			const onAbort = (): void => {
				if (!finish()) return;
				reject(searchAbortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void promise.then(
				(value) => {
					if (finish()) resolveResult(value);
				},
				(error: unknown) => {
					if (finish()) reject(error);
				},
			);
		});
	}

	private trackSearchWork(promise: Promise<unknown>): void {
		this.activeSearchWork.add(promise);
		void promise.then(
			() => this.activeSearchWork.delete(promise),
			() => this.activeSearchWork.delete(promise),
		);
	}

	private takeCachedSearchResult(key: string): SearchComputation | undefined {
		const cached = this.searchResults.get(key);
		if (!cached) return undefined;
		this.searchResults.delete(key);
		this.searchResults.set(key, cached);
		return cached.computation;
	}

	private cacheSearchResult(key: string, computation: SearchComputation): void {
		if (computation.retainedBytes > SEARCH_RESULT_CACHE_MAX_ENTRY_BYTES) return;
		const existing = this.searchResults.get(key);
		if (existing) {
			this.searchResults.delete(key);
			this.searchResultCacheBytes -= existing.bytes;
		}
		const cached = { computation, bytes: computation.retainedBytes };
		this.searchResults.set(key, cached);
		this.searchResultCacheBytes += cached.bytes;
		while (
			this.searchResults.size > SEARCH_RESULT_CACHE_MAX_ENTRIES ||
			this.searchResultCacheBytes > SEARCH_RESULT_CACHE_MAX_BYTES
		) {
			const oldestKey = this.searchResults.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.searchResults.get(oldestKey);
			this.searchResults.delete(oldestKey);
			if (oldest) this.searchResultCacheBytes -= oldest.bytes;
		}
	}

	async materializeHead(): Promise<string> {
		this.assertActive();
		const directory = await mkdtemp(join(tmpdir(), "volt-review-checkout-"));
		this.materializedDirectories.push(directory);
		const init = await runCommand("git", ["init"], directory, commandOptions(this.limits, this.source.signal));
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
				...commandOptions(this.limits, this.source.signal),
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
		const reset = await runCommand(
			"git",
			["reset", "--hard", commitOid],
			directory,
			commandOptions(this.limits, this.source.signal),
		);
		if (!reset.ok) throw new Error(`Could not materialize review checkout: ${commandError(reset)}`);
		return directory;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.disposalController.abort();
		while (this.activeSearchWork.size > 0) {
			await Promise.allSettled([...this.activeSearchWork]);
		}
		this.searchInflight.clear();
		this.searchManifests.clear();
		this.searchResults.clear();
		this.searchResultCacheBytes = 0;
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
	const pendingTemporaryDirectories = new Set<string>();
	try {
		throwIfResolutionCancelled(options.signal);
		const limits = normalizeSnapshotLimits(options.limits);
		options.onProgress?.("Resolving repository…");
		const root = await repositoryRoot(cwd, limits, options.signal);
		if (!root) return { error: "Not inside a git repository." };
		switch (target.kind) {
			case "uncommitted": {
				options.onProgress?.("Capturing uncommitted changes…");
				const { source, temporaryDirectory, originalIndex } = await createUncommittedSource(
					root,
					limits,
					options.signal,
				);
				pendingTemporaryDirectories.add(temporaryDirectory);
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
				options.onProgress?.("Resolving branch history…");
				const localSource = await createLocalSource(root, limits, options.signal);
				const headCommit = await requireCanonicalCommit(localSource, "HEAD");
				if (!headCommit) return { error: "Could not resolve the branch head." };
				const requestedBase = target.base ?? (await detectBaseBranch(root, limits, options.signal));
				if (!requestedBase) return { error: "Could not detect a base branch. Use /review branch <base>." };
				const resolvedBase = await resolveBranchBase(requestedBase, root, limits, options.signal);
				if (!resolvedBase) return { error: `Base branch "${requestedBase}" not found.` };

				let source = localSource;
				let baseCommit: string | undefined;
				const temporaryDirectories: string[] = [];
				if (resolvedBase.kind === "remote") {
					options.onProgress?.(`Refreshing ${resolvedBase.displayRef}…`);
					const fetched = await createRemoteBranchSource(
						root,
						resolvedBase.remote,
						resolvedBase.remoteRef,
						headCommit,
						limits,
						options.signal,
					);
					if (!fetched.source || !fetched.baseCommit || !fetched.temporaryDirectory) {
						return fetched.error ?? { error: "Could not refresh the review base branch." };
					}
					source = fetched.source;
					baseCommit = fetched.baseCommit;
					temporaryDirectories.push(fetched.temporaryDirectory);
					pendingTemporaryDirectories.add(fetched.temporaryDirectory);
				} else {
					baseCommit = await requireCanonicalCommit(source, resolvedBase.ref);
				}
				if (!baseCommit) return { error: "Could not resolve the branch base." };
				const cleanupTemporaryDirectories = async (): Promise<void> => {
					for (const directory of temporaryDirectories) {
						pendingTemporaryDirectories.delete(directory);
						await rm(directory, { recursive: true, force: true }).catch(() => {});
					}
				};
				const mergeBaseResult = await git(source, ["merge-base", baseCommit, headCommit]);
				const mergeBaseCommit = text(mergeBaseResult).trim();
				if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
					await cleanupTemporaryDirectories();
					return {
						error: `git merge-base failed: ${commandError(mergeBaseResult)}`,
						remoteError: "Could not resolve the branch merge base.",
					};
				}
				const baseTree = await requireCanonicalTree(source, mergeBaseCommit);
				const headTree = await requireCanonicalTree(source, headCommit);
				if (!baseTree || !headTree) {
					await cleanupTemporaryDirectories();
					return { error: "Could not resolve the branch trees." };
				}
				if (baseTree === headTree) {
					await cleanupTemporaryDirectories();
					return { error: `No changes between ${resolvedBase.displayRef} and HEAD.` };
				}
				const logResult = await git(source, ["log", "--oneline", `${mergeBaseCommit}..${headCommit}`]);
				init = {
					description: `branch changes vs ${resolvedBase.displayRef}`,
					diffCommand: `git diff --no-textconv --no-ext-diff ${resolvedBase.displayRef}...HEAD`,
					extraContext: logResult.ok && text(logResult).trim() ? `Commits:\n${text(logResult).trim()}` : undefined,
					identity: { kind: target.kind, baseCommit, mergeBaseCommit, headCommit, baseTree, headTree },
					root,
					source,
					temporaryDirectories,
					limits,
				};
				break;
			}
			case "commit": {
				options.onProgress?.("Resolving commit…");
				const ref = target.sha?.trim();
				if (!ref) return { error: "Missing commit ref." };
				if (Buffer.byteLength(ref, "utf8") > options.maxCommitRefBytes) {
					return { error: `Commit ref exceeds ${options.maxCommitRefBytes} UTF-8 bytes.` };
				}
				const source = await createLocalSource(root, limits, options.signal);
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
				const captured = await captureReviewGitHubContext({
					cwd: root,
					...(normalized ? { number: normalized } : {}),
					maxPullRequestNumber: options.maxPullRequestNumber,
					signal: options.signal,
					onProgress: options.onProgress,
				});
				if (!captured.ok) return captured;
				const { pullRequest } = captured;
				options.onProgress?.("Fetching pull request history…");
				const fetched = await createPullRequestSource(root, pullRequest, limits, options.signal);
				if (!fetched.source || !fetched.temporaryDirectory)
					return fetched.error ?? { error: "Could not fetch pull request snapshot." };
				pendingTemporaryDirectories.add(fetched.temporaryDirectory);
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
				init = {
					description: `PR #${pullRequest.number} (${pullRequest.title})`,
					workflowDescription: `PR #${pullRequest.number}`,
					diffCommand: `gh pr diff ${pullRequest.number}`,
					githubContext: captured.context,
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
		options.onProgress?.("Building review snapshot…");
		const snapshot = await GitReviewSnapshot.create(init);
		if (options.signal?.aborted) {
			await snapshot.dispose();
			throw new ReviewSnapshotResolutionCancelledError();
		}
		return snapshot;
	} catch (error) {
		for (const directory of pendingTemporaryDirectories) {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
		if (error instanceof ReviewSnapshotResolutionCancelledError || options.signal?.aborted) {
			return { error: "Review cancelled.", cancelled: true };
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
