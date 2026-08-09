import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

export interface ReviewSnapshotFile {
	entry: ReviewSnapshotTreeEntry;
	content: Buffer;
	binary: boolean;
	lineCount?: number;
}

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
	diff: string;
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
}

interface CommandResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
}

interface GitSource {
	cwd: string;
	env?: Record<string, string>;
	objectDirectories: string[];
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

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	options: { env?: Record<string, string>; input?: Buffer | string; signal?: AbortSignal } = {},
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : process.env,
			signal: options.signal,
		});
		const stdout: Buffer[] = [];
		let stderr = "";
		proc.stdout?.on("data", (data: Buffer) => stdout.push(data));
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			resolveResult({ ok: false, stdout: Buffer.concat(stdout), stderr: error.message });
		});
		proc.on("close", (code) => {
			resolveResult({ ok: code === 0, stdout: Buffer.concat(stdout), stderr });
		});
		if (options.input !== undefined) {
			proc.stdin?.end(options.input);
		}
	});
}

function git(source: Pick<GitSource, "cwd" | "env">, args: string[], input?: Buffer | string): Promise<CommandResult> {
	return runCommand("git", args, source.cwd, { env: source.env, input });
}

function text(result: CommandResult): string {
	return result.stdout.toString("utf8");
}

function commandFailure(prefix: string, result: CommandResult): ReviewSnapshotResolutionError {
	return { error: `${prefix}: ${result.stderr.trim()}` };
}

async function requireCanonicalCommit(
	source: Pick<GitSource, "cwd" | "env">,
	ref: string,
): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function requireCanonicalTree(source: Pick<GitSource, "cwd" | "env">, ref: string): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function createEmptyTree(source: Pick<GitSource, "cwd" | "env">): Promise<string> {
	const result = await git(source, ["mktree"], "");
	const oid = text(result).trim();
	if (!result.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid)) {
		throw new Error(`Could not create an empty review tree: ${result.stderr.trim()}`);
	}
	return oid;
}

async function repositoryRoot(cwd: string): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryObjectDirectory(cwd: string): Promise<string | undefined> {
	const result = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], cwd);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function detectBaseBranch(cwd: string): Promise<string | undefined> {
	const originHead = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (originHead.ok) {
		const ref = text(originHead).trim();
		if (ref) return ref;
	}
	for (const candidate of ["main", "master"]) {
		const exists = await runCommand("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
		if (exists.ok) return candidate;
	}
	return undefined;
}

async function resolveBaseRef(base: string, cwd: string): Promise<string | undefined> {
	const direct = await runCommand("git", ["rev-parse", "--verify", "--quiet", base], cwd);
	if (direct.ok) return base;
	if (!base.startsWith("origin/")) {
		const remote = `origin/${base}`;
		const remoteExists = await runCommand("git", ["rev-parse", "--verify", "--quiet", remote], cwd);
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

async function createLocalSource(root: string): Promise<GitSource> {
	const objects = await repositoryObjectDirectory(root);
	if (!objects) throw new Error("Could not resolve the Git object directory.");
	return { cwd: root, objectDirectories: [objects] };
}

async function createUncommittedSource(root: string): Promise<{ source: GitSource; temporaryDirectory: string }> {
	const originalObjects = await repositoryObjectDirectory(root);
	if (!originalObjects) throw new Error("Could not resolve the Git object directory.");
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
	};
	return { source, temporaryDirectory };
}

async function resetTemporaryIndex(source: GitSource): Promise<void> {
	const indexPath = source.env?.GIT_INDEX_FILE;
	if (indexPath) await rm(indexPath, { force: true });
}

async function captureWorktreeTree(
	source: GitSource,
): Promise<{ tree?: string; error?: ReviewSnapshotResolutionError }> {
	for (let attempt = 1; attempt <= MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
		const before = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!before.ok) return { error: commandFailure("git status failed", before) };
		await resetTemporaryIndex(source);
		const add = await git(source, ["add", "-A", "--"]);
		if (!add.ok) return { error: commandFailure("git add failed", add) };
		const firstTreeResult = await git(source, ["write-tree"]);
		if (!firstTreeResult.ok) return { error: commandFailure("git write-tree failed", firstTreeResult) };
		const after = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!after.ok) return { error: commandFailure("git status failed", after) };
		await resetTemporaryIndex(source);
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
): Promise<{ source?: GitSource; temporaryDirectory?: string; error?: ReviewSnapshotResolutionError }> {
	const originResult = await runCommand("git", ["remote", "get-url", "origin"], root);
	if (!originResult.ok || !text(originResult).trim()) {
		return { error: { error: "Could not resolve the origin remote for the pull request snapshot." } };
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-pr-"));
	const init = await runCommand("git", ["init", "--bare"], temporaryDirectory);
	if (!init.ok) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		return { error: commandFailure("git init failed", init) };
	}
	const source: GitSource = {
		cwd: temporaryDirectory,
		objectDirectories: [join(temporaryDirectory, "objects")],
	};
	const fetch = await git(source, [
		"fetch",
		"--no-tags",
		"--force",
		text(originResult).trim(),
		`+refs/heads/${pullRequest.baseRefName}:refs/review/base`,
		`+refs/pull/${pullRequest.number}/head:refs/review/head`,
	]);
	if (!fetch.ok) {
		await rm(temporaryDirectory, { recursive: true, force: true });
		return {
			error: {
				error: `git fetch failed: ${fetch.stderr.trim()}`,
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

async function diffTrees(source: GitSource, baseTree: string, headTree: string): Promise<CommandResult> {
	return git(source, [
		"diff",
		"--binary",
		"--no-color",
		"--no-textconv",
		"--no-ext-diff",
		`--unified=${DEFAULT_DIFF_CONTEXT_LINES}`,
		"--find-renames",
		baseTree,
		headTree,
	]);
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

async function readBlob(source: GitSource, oid: string): Promise<Buffer | undefined> {
	const result = await git(source, ["cat-file", "blob", oid]);
	return result.ok ? result.stdout : undefined;
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
	if (!statusResult.ok) throw new Error(`git diff --name-status failed: ${statusResult.stderr.trim()}`);
	const changed: ReviewChangedFile[] = [];
	for (const statusEntry of parseNameStatus(statusResult.stdout)) {
		const pathspecs = statusEntry.previousPath ? [statusEntry.previousPath, statusEntry.path] : [statusEntry.path];
		const patchResult = await git(source, [
			"diff",
			"--binary",
			"--no-color",
			"--no-textconv",
			"--no-ext-diff",
			`--unified=${DEFAULT_DIFF_CONTEXT_LINES}`,
			"--find-renames",
			baseTree,
			headTree,
			"--",
			...pathspecs,
		]);
		if (!patchResult.ok) throw new Error(`git diff failed for ${statusEntry.path}: ${patchResult.stderr.trim()}`);
		const base = baseEntries.get(statusEntry.previousPath ?? statusEntry.path);
		const head = headEntries.get(statusEntry.path);
		const contentEntry = head?.type === "blob" ? head : base?.type === "blob" ? base : undefined;
		const content = contentEntry ? await readBlob(source, contentEntry.oid) : undefined;
		const binary = content ? isBinary(content) : false;
		const hunks = binary ? [] : parseHunks(statusEntry.path, text(patchResult));
		let unsupportedReason: string | undefined;
		if (base?.type === "commit" || head?.type === "commit")
			unsupportedReason = "Submodule changes require review in the submodule repository.";
		else if (binary) unsupportedReason = "Binary content has no reviewable text hunks.";
		else if (hunks.length === 0)
			unsupportedReason = "The change has no textual diff hunk (for example, a mode-only change).";
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
	readonly diff: string;
	private readonly source: GitSource;
	private readonly temporaryDirectories: string[];
	private readonly materializedDirectories: string[] = [];
	private readonly treeEntries = new Map<ReviewSnapshotRevision, Map<string, ReviewSnapshotTreeEntry>>();
	private disposed = false;

	private constructor(
		init: SnapshotInit,
		changedFiles: ReviewChangedFile[],
		diff: string,
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
		this.temporaryDirectories = init.temporaryDirectories;
		this.changedFiles = changedFiles;
		this.diff = diff;
		this.treeEntries.set("base", baseEntries);
		this.treeEntries.set("head", headEntries);
	}

	static async create(init: SnapshotInit): Promise<GitReviewSnapshot> {
		const baseTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.baseTree]);
		const headTreeResult = await git(init.source, ["ls-tree", "-r", "-z", "-l", init.identity.headTree]);
		if (!baseTreeResult.ok || !headTreeResult.ok) {
			throw new Error(
				`Could not inventory review snapshot trees: ${(baseTreeResult.ok ? headTreeResult : baseTreeResult).stderr.trim()}`,
			);
		}
		const baseEntries = parseTree(baseTreeResult.stdout);
		const headEntries = parseTree(headTreeResult.stdout);
		const diffResult = await diffTrees(init.source, init.identity.baseTree, init.identity.headTree);
		if (!diffResult.ok) throw new Error(`git diff failed: ${diffResult.stderr.trim()}`);
		const changedFiles = await buildChangedFiles(
			init.source,
			init.identity.baseTree,
			init.identity.headTree,
			baseEntries,
			headEntries,
		);
		return new GitReviewSnapshot(init, changedFiles, text(diffResult), baseEntries, headEntries);
	}

	async readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined> {
		this.assertActive();
		const normalized = normalizeReviewPath(path);
		const entry = this.treeEntries.get(revision)?.get(normalized);
		if (!entry || entry.type !== "blob") return undefined;
		const content = await readBlob(this.source, entry.oid);
		if (!content) return undefined;
		const binary = isBinary(content);
		return { entry, content, binary, ...(binary ? {} : { lineCount: countLines(content) }) };
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
		const init = await runCommand("git", ["init"], directory);
		if (!init.ok) throw new Error(`Could not initialize review checkout: ${init.stderr.trim()}`);
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
			throw new Error(`Could not create review checkout commit: ${commit.stderr.trim()}`);
		}
		const reset = await runCommand("git", ["reset", "--hard", commitOid], directory);
		if (!reset.ok) throw new Error(`Could not materialize review checkout: ${reset.stderr.trim()}`);
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
	const root = await repositoryRoot(cwd);
	if (!root) return { error: "Not inside a git repository." };
	let init: SnapshotInit | undefined;
	try {
		switch (target.kind) {
			case "uncommitted": {
				const { source, temporaryDirectory } = await createUncommittedSource(root);
				const headCommit = await requireCanonicalCommit(source, "HEAD");
				const baseTree = headCommit
					? await requireCanonicalTree(source, headCommit)
					: await createEmptyTree(source);
				if (!baseTree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return { error: "Could not resolve the base tree for uncommitted changes." };
				}
				const captured = await captureWorktreeTree(source);
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
				};
				break;
			}
			case "branch": {
				const requestedBase = target.base ?? (await detectBaseBranch(root));
				if (!requestedBase) return { error: "Could not detect a base branch. Use /review branch <base>." };
				const baseRef = await resolveBaseRef(requestedBase, root);
				if (!baseRef) return { error: `Base branch "${requestedBase}" not found.` };
				const source = await createLocalSource(root);
				const baseCommit = await requireCanonicalCommit(source, baseRef);
				const headCommit = await requireCanonicalCommit(source, "HEAD");
				if (!baseCommit || !headCommit) return { error: "Could not resolve the branch endpoints." };
				const mergeBaseResult = await git(source, ["merge-base", baseCommit, headCommit]);
				const mergeBaseCommit = text(mergeBaseResult).trim();
				if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
					return {
						error: `git merge-base failed: ${mergeBaseResult.stderr.trim()}`,
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
				};
				break;
			}
			case "commit": {
				const ref = target.sha?.trim();
				if (!ref) return { error: "Missing commit ref." };
				if (Buffer.byteLength(ref, "utf8") > options.maxCommitRefBytes) {
					return { error: `Commit ref exceeds ${options.maxCommitRefBytes} UTF-8 bytes.` };
				}
				const source = await createLocalSource(root);
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
				);
				if (!viewResult.ok) {
					const stderr = viewResult.stderr.trim();
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
				const fetched = await createPullRequestSource(root, pullRequest);
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
				};
				break;
			}
		}
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
	if (!file || file.binary) return undefined;
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
