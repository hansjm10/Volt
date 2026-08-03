import type { ChildProcess } from "node:child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";
import { discoverGitWorktree, type GitWorktreeLocation, getGitRepositoryDisplayName } from "./git-repository.ts";
import type { RpcGitContext } from "./rpc/types.ts";
import { RPC_GIT_CONTEXT_REF_MAX_CHARS, RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS } from "./rpc/wire-limits.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 2500;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const WATCH_RETRY_MS = 5000;
const WATCH_DEBOUNCE_MS = 100;
const MAX_OPERATION_MARKER_BYTES = 4096;

const STATUS_ARGS = [
	"--no-pager",
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=",
	"-c",
	"color.ui=false",
	"-c",
	"color.status=false",
	"-c",
	"status.relativePaths=false",
	"status",
	"--porcelain=v2",
	"--branch",
	"-z",
	"--untracked-files=all",
	"--ignored=no",
] as const;

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type GitHead = RpcGitContext["head"];
type GitComparison = Exclude<RpcGitContext["upstream"], null>;
type GitStatusCounts = RpcGitContext["status"];
type GitChangeCounts = GitStatusCounts["staged"];
type GitOperation = Exclude<RpcGitContext["operation"], null>;
type SnapshotContent = Omit<RpcGitContext, "revision" | "observedAt" | "stale">;

export interface ParsedGitStatus {
	readonly head: GitHead;
	readonly upstream: GitComparison | null;
	readonly status: GitStatusCounts;
}

export interface GitContextProviderOptions {
	readonly workspaceName?: string;
	readonly baseRef?: string;
	readonly commandTimeoutMs?: number;
	readonly maxStdoutBytes?: number;
	readonly maxStderrBytes?: number;
	readonly pollIntervalMs?: number;
}

export type GitContextListener = (snapshot: RpcGitContext | null) => void;

export interface GitContextSubscriptionOptions {
	/** False for internal event bridges that must not keep a dormant provider polling. */
	readonly monitor?: boolean;
}

type GitCommandErrorKind = "invalid" | "cancelled" | "timeout" | "output" | "spawn" | "exit";

class GitCommandError extends Error {
	readonly kind: GitCommandErrorKind;

	constructor(message: string, kind: GitCommandErrorKind = "invalid") {
		super(message);
		this.name = "GitCommandError";
		this.kind = kind;
	}
}

function emptyChangeCounts(): GitChangeCounts {
	return { added: 0, modified: 0, deleted: 0, renamed: 0 };
}

function incrementChangeCount(counts: GitChangeCounts, status: string): void {
	switch (status) {
		case "A":
		case "C":
			counts.added++;
			break;
		case "M":
		case "T":
			counts.modified++;
			break;
		case "D":
			counts.deleted++;
			break;
		case "R":
			counts.renamed++;
			break;
	}
}

function checkedRef(value: string, label: string): string {
	if (!value || value.length > RPC_GIT_CONTEXT_REF_MAX_CHARS || /[\0\r\n]/.test(value)) {
		throw new GitCommandError(`Invalid ${label} in Git status output`);
	}
	return value;
}

function checkedOid(value: string): string {
	if (!OID_PATTERN.test(value)) throw new GitCommandError("Invalid object ID in Git status output");
	return value;
}

/** Incremental `git status --porcelain=v2 --branch -z` record consumer that never retains paths. */
export class GitStatusParser {
	private oid: string | null = null;
	private unborn = false;
	private branchName: string | null = null;
	private upstreamRef: string | null = null;
	private ahead = 0;
	private behind = 0;
	private readonly staged = emptyChangeCounts();
	private readonly unstaged = emptyChangeCounts();
	private untracked = 0;
	private conflicted = 0;
	private total = 0;
	private expectRenameSource = false;

	addRecord(record: string): void {
		if (this.expectRenameSource) {
			if (!record) throw new GitCommandError("Rename status record omitted its source path");
			this.expectRenameSource = false;
			return;
		}
		if (!record) return;
		if (record.startsWith("# branch.oid ")) {
			const value = record.slice("# branch.oid ".length);
			if (value === "(initial)") this.unborn = true;
			else this.oid = checkedOid(value);
			return;
		}
		if (record.startsWith("# branch.head ")) {
			this.branchName = checkedRef(record.slice("# branch.head ".length), "branch name");
			return;
		}
		if (record.startsWith("# branch.upstream ")) {
			this.upstreamRef = checkedRef(record.slice("# branch.upstream ".length), "upstream ref");
			return;
		}
		if (record.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
			if (!match) throw new GitCommandError("Invalid upstream comparison in Git status output");
			this.ahead = Number(match[1]);
			this.behind = Number(match[2]);
			if (!Number.isSafeInteger(this.ahead) || !Number.isSafeInteger(this.behind)) {
				throw new GitCommandError("Upstream comparison exceeds the safe integer range");
			}
			return;
		}

		if (record.startsWith("1 ") || record.startsWith("2 ")) {
			const x = record[2];
			const y = record[3];
			if (!x || !y || !".MADRCUT".includes(x) || !".MADRCUT".includes(y)) {
				throw new GitCommandError("Invalid ordinary status record");
			}
			incrementChangeCount(this.staged, x);
			incrementChangeCount(this.unstaged, y);
			this.total++;
			if (record.startsWith("2 ")) this.expectRenameSource = true;
			return;
		}
		if (record.startsWith("u ")) {
			this.conflicted++;
			this.total++;
			return;
		}
		if (record.startsWith("? ")) {
			this.untracked++;
			this.total++;
			return;
		}
		if (record.startsWith("! ") || record.startsWith("# ")) return;
		throw new GitCommandError("Unknown record in Git status output");
	}

	finish(): ParsedGitStatus {
		if (this.expectRenameSource) throw new GitCommandError("Rename status record omitted its source path");
		if (!this.branchName) throw new GitCommandError("Git status output omitted branch.head");
		let head: GitHead;
		if (this.unborn) {
			if (this.branchName === "(detached)") throw new GitCommandError("Invalid detached unborn HEAD");
			head = { kind: "unborn", name: this.branchName };
		} else if (this.branchName === "(detached)") {
			head = { kind: "detached", oid: checkedOid(this.oid ?? "") };
		} else {
			head = { kind: "branch", name: this.branchName, oid: checkedOid(this.oid ?? "") };
		}

		const status: GitStatusCounts = {
			staged: this.staged,
			unstaged: this.unstaged,
			untracked: this.untracked,
			conflicted: this.conflicted,
			total: this.total,
			clean: this.total === 0,
		};
		return Object.freeze({
			head: Object.freeze(head),
			upstream: this.upstreamRef
				? Object.freeze({ ref: this.upstreamRef, ahead: this.ahead, behind: this.behind })
				: null,
			status: freezeStatus(status),
		});
	}
}

/** Parse one complete `git status --porcelain=v2 --branch -z` result without retaining paths. */
export function parseGitStatusPorcelainV2(output: Buffer | string): ParsedGitStatus {
	const parser = new GitStatusParser();
	for (const record of (typeof output === "string" ? output : output.toString("utf8")).split("\0")) {
		parser.addRecord(record);
	}
	return parser.finish();
}

function freezeStatus(status: GitStatusCounts): GitStatusCounts {
	return Object.freeze({
		...status,
		staged: Object.freeze({ ...status.staged }),
		unstaged: Object.freeze({ ...status.unstaged }),
	});
}

function freezeOperation(operation: GitOperation | null): GitOperation | null {
	return operation ? Object.freeze({ ...operation }) : null;
}

function freezeSnapshot(snapshot: RpcGitContext): RpcGitContext {
	return Object.freeze({
		...snapshot,
		head: Object.freeze({ ...snapshot.head }),
		upstream: snapshot.upstream ? Object.freeze({ ...snapshot.upstream }) : null,
		base: snapshot.base ? Object.freeze({ ...snapshot.base }) : null,
		status: freezeStatus(snapshot.status),
		operation: freezeOperation(snapshot.operation),
	});
}

function readSmallMarker(path: string): string | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_OPERATION_MARKER_BYTES) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function readProgress(directory: string, stepName: string, totalName: string): Pick<GitOperation, "step" | "total"> {
	const step = Number.parseInt(readSmallMarker(join(directory, stepName))?.trim() ?? "", 10);
	const total = Number.parseInt(readSmallMarker(join(directory, totalName))?.trim() ?? "", 10);
	return {
		...(Number.isSafeInteger(step) && step >= 0 ? { step } : {}),
		...(Number.isSafeInteger(total) && total >= 0 ? { total } : {}),
	};
}

export function detectGitOperation(location: GitWorktreeLocation): GitOperation | null {
	const rebaseMerge = join(location.gitDir, "rebase-merge");
	if (existsSync(rebaseMerge)) return { kind: "rebase", ...readProgress(rebaseMerge, "msgnum", "end") };
	const rebaseApply = join(location.gitDir, "rebase-apply");
	if (existsSync(rebaseApply)) return { kind: "rebase", ...readProgress(rebaseApply, "next", "last") };
	if (existsSync(join(location.gitDir, "MERGE_HEAD"))) return { kind: "merge" };
	if (existsSync(join(location.gitDir, "CHERRY_PICK_HEAD"))) return { kind: "cherry_pick" };
	if (existsSync(join(location.gitDir, "REVERT_HEAD"))) return { kind: "revert" };
	if (existsSync(join(location.gitDir, "BISECT_LOG"))) return { kind: "bisect" };
	if (existsSync(join(location.gitDir, "sequencer", "todo"))) return { kind: "sequencer" };
	return null;
}

function createGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CEILING_DIRECTORIES",
	]) {
		delete environment[key];
	}
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_PAGER = "cat";
	environment.LC_ALL = "C";
	return environment;
}

interface RunGitOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	readonly signal?: AbortSignal;
	readonly children: Set<ChildProcess>;
	/**
	 * Consume NUL-delimited stdout records as they stream instead of buffering
	 * stdout, so total output size is unbounded while `maxStdoutBytes` bounds
	 * only one pending record. A thrown GitCommandError terminates the command.
	 */
	readonly onStdoutRecord?: (record: string) => void;
}

function runGit(args: readonly string[], options: RunGitOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new GitCommandError("Git command cancelled", "cancelled"));
			return;
		}

		const child = spawnProcess("git", [...args], {
			cwd: options.cwd,
			env: createGitEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		options.children.add(child);
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let terminalError: GitCommandError | null = null;
		let forceKillTimer: NodeJS.Timeout | null = null;

		const terminate = (error: GitCommandError): void => {
			if (terminalError) return;
			terminalError = error;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
			forceKillTimer.unref?.();
		};
		const timeout = setTimeout(
			() => terminate(new GitCommandError("Git command timed out", "timeout")),
			Math.max(1, options.timeoutMs),
		);
		timeout.unref?.();
		const onAbort = (): void => terminate(new GitCommandError("Git command cancelled", "cancelled"));
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const onStdoutRecord = options.onStdoutRecord;
		let pendingRecord: Buffer = Buffer.alloc(0);
		const consumeRecords = (chunk: Buffer): void => {
			const buffer = pendingRecord.length === 0 ? chunk : Buffer.concat([pendingRecord, chunk]);
			let start = 0;
			try {
				for (let index = buffer.indexOf(0, start); index !== -1; index = buffer.indexOf(0, start)) {
					onStdoutRecord?.(buffer.subarray(start, index).toString("utf8"));
					start = index + 1;
				}
			} catch (error) {
				terminate(error instanceof GitCommandError ? error : new GitCommandError("Invalid Git command output"));
				return;
			}
			pendingRecord = buffer.subarray(start);
			if (pendingRecord.length > options.maxStdoutBytes) {
				terminate(new GitCommandError("Git command output exceeded its bound", "output"));
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (terminalError) return;
			if (onStdoutRecord) {
				consumeRecords(chunk);
				return;
			}
			stdoutBytes += chunk.length;
			if (stdoutBytes > options.maxStdoutBytes) {
				terminate(new GitCommandError("Git command output exceeded its bound", "output"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > options.maxStderrBytes)
				terminate(new GitCommandError("Git command stderr exceeded its bound", "output"));
		});
		child.once("error", () => terminate(new GitCommandError("Unable to start Git command", "spawn")));
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", onAbort);
			options.children.delete(child);
			if (terminalError) {
				reject(terminalError);
				return;
			}
			if (code !== 0) {
				reject(new GitCommandError("Git command failed", "exit"));
				return;
			}
			if (onStdoutRecord && pendingRecord.length > 0) {
				try {
					onStdoutRecord(pendingRecord.toString("utf8"));
				} catch (error) {
					reject(error instanceof GitCommandError ? error : new GitCommandError("Invalid Git command output"));
					return;
				}
			}
			resolve(Buffer.concat(stdout, stdoutBytes));
		});
	});
}

function locationKey(location: GitWorktreeLocation | null): string {
	if (!location) return "";
	return [location.gitDir, location.commonGitDir, location.currentRefPath ?? "", location.reftableDir ?? ""].join(
		"\0",
	);
}

function contentKey(snapshot: SnapshotContent): string {
	return JSON.stringify(snapshot);
}

function safeBaseRef(baseRef: string | undefined): string | null {
	const value = baseRef?.trim();
	if (!value || value.length > RPC_GIT_CONTEXT_REF_MAX_CHARS || /[\0\r\n]/.test(value)) return null;
	return value;
}

export class GitContextProvider {
	private readonly cwd: string;
	private readonly options: Required<
		Pick<GitContextProviderOptions, "commandTimeoutMs" | "maxStdoutBytes" | "maxStderrBytes" | "pollIntervalMs">
	> &
		Pick<GitContextProviderOptions, "workspaceName" | "baseRef">;
	private readonly listeners = new Set<GitContextListener>();
	private readonly children = new Set<ChildProcess>();
	private cachedSnapshot: RpcGitContext | null = null;
	private currentLocation: GitWorktreeLocation | null = null;
	private refreshPromise: Promise<RpcGitContext | null> | null = null;
	private scheduledRefresh: NodeJS.Timeout | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private watchRetryTimer: NodeJS.Timeout | null = null;
	private watchers: FSWatcher[] = [];
	private revision = 0;
	private pollDelayMs: number;
	private observationCount = 0;
	private rerunRequested = false;
	private disposed = false;

	constructor(cwd: string, options: GitContextProviderOptions = {}) {
		this.cwd = cwd;
		this.options = {
			workspaceName: options.workspaceName,
			baseRef: safeBaseRef(options.baseRef) ?? undefined,
			commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
			maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
			maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
			pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		};
		this.pollDelayMs = this.options.pollIntervalMs;
	}

	static async create(cwd: string, options: GitContextProviderOptions = {}): Promise<GitContextProvider> {
		const provider = new GitContextProvider(cwd, options);
		await provider.refresh();
		return provider;
	}

	getSnapshot(): RpcGitContext | null {
		return this.cachedSnapshot;
	}

	subscribe(listener: GitContextListener, options: GitContextSubscriptionOptions = {}): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		const releaseObservation = options.monitor === false ? undefined : this.retainObservation();
		return () => {
			this.listeners.delete(listener);
			releaseObservation?.();
		};
	}

	/** Keep filesystem watches and low-frequency polling active for one live observer. */
	retainObservation(): () => void {
		if (this.disposed) return () => undefined;
		this.observationCount++;
		if (this.observationCount === 1) this.startMonitoring();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.observationCount = Math.max(0, this.observationCount - 1);
			if (this.observationCount === 0) this.stopMonitoring();
		};
	}

	/**
	 * Scan now, or join the scan already in flight. A join also schedules one
	 * follow-up scan, so a change landing mid-scan is never silently dropped.
	 */
	refresh(signal?: AbortSignal): Promise<RpcGitContext | null> {
		if (this.disposed) return Promise.resolve(this.cachedSnapshot);
		if (this.refreshPromise) {
			this.rerunRequested = true;
			return this.refreshPromise;
		}
		const refresh = this.performRefresh(signal);
		const wrapped = refresh.finally(() => {
			if (this.refreshPromise === wrapped) this.refreshPromise = null;
			if (this.rerunRequested) {
				this.rerunRequested = false;
				if (!this.disposed) this.scheduleRefresh(0);
			}
		});
		this.refreshPromise = wrapped;
		return wrapped;
	}

	scheduleRefresh(delayMs = WATCH_DEBOUNCE_MS): void {
		if (this.disposed) return;
		if (this.scheduledRefresh) clearTimeout(this.scheduledRefresh);
		this.scheduledRefresh = setTimeout(
			() => {
				this.scheduledRefresh = null;
				void this.refresh();
			},
			Math.max(0, delayMs),
		);
		this.scheduledRefresh.unref?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		this.observationCount = 0;
		this.stopMonitoring();
		if (this.scheduledRefresh) clearTimeout(this.scheduledRefresh);
		this.scheduledRefresh = null;
		for (const child of this.children) child.kill("SIGKILL");
		this.children.clear();
	}

	private async performRefresh(signal?: AbortSignal): Promise<RpcGitContext | null> {
		try {
			const location = discoverGitWorktree(this.cwd);
			this.updateLocation(location);
			if (!location) {
				this.pollDelayMs = this.options.pollIntervalMs;
				this.replaceSnapshot(null);
				return this.cachedSnapshot;
			}

			const statusParser = new GitStatusParser();
			await runGit(STATUS_ARGS, {
				cwd: location.worktreeRoot,
				timeoutMs: this.options.commandTimeoutMs,
				maxStdoutBytes: this.options.maxStdoutBytes,
				maxStderrBytes: this.options.maxStderrBytes,
				signal,
				children: this.children,
				onStdoutRecord: (record) => statusParser.addRecord(record),
			});
			const parsed = statusParser.finish();
			const base = await this.readBaseComparison(location, parsed.head, signal);
			const content: SnapshotContent = {
				repository: getGitRepositoryDisplayName(location, this.options.workspaceName).slice(
					0,
					RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
				),
				head: parsed.head,
				upstream: parsed.upstream,
				base,
				status: parsed.status,
				operation: freezeOperation(detectGitOperation(location)),
			};
			this.applySuccessfulContent(content);
			this.pollDelayMs = this.options.pollIntervalMs;
		} catch (error) {
			if (this.disposed) return this.cachedSnapshot;
			if (!(error instanceof GitCommandError && error.kind === "cancelled")) {
				this.pollDelayMs = Math.min(
					Math.max(this.pollDelayMs * 2, this.options.pollIntervalMs),
					MAX_POLL_INTERVAL_MS,
				);
			}
			this.markStale();
		} finally {
			this.scheduleNextPoll();
		}
		return this.cachedSnapshot;
	}

	private async readBaseComparison(
		location: GitWorktreeLocation,
		head: GitHead,
		signal?: AbortSignal,
	): Promise<GitComparison | null> {
		const baseRef = this.options.baseRef;
		if (!baseRef || head.kind === "unborn") return null;
		try {
			const output = await runGit(
				[
					"--no-pager",
					"--no-optional-locks",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.hooksPath=",
					"rev-list",
					"--left-right",
					"--count",
					"--end-of-options",
					`${baseRef}...${head.oid}`,
					"--",
				],
				{
					cwd: location.worktreeRoot,
					timeoutMs: this.options.commandTimeoutMs,
					maxStdoutBytes: 1024,
					maxStderrBytes: this.options.maxStderrBytes,
					signal,
					children: this.children,
				},
			);
			const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output.toString("utf8"));
			if (!match) throw new GitCommandError("Invalid base comparison output");
			const behind = Number(match[1]);
			const ahead = Number(match[2]);
			if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return null;
			return Object.freeze({ ref: baseRef, ahead, behind });
		} catch (error) {
			if (error instanceof GitCommandError && error.kind === "exit") return null;
			throw error;
		}
	}

	private applySuccessfulContent(content: SnapshotContent): void {
		const observedAt = new Date().toISOString();
		const current = this.cachedSnapshot;
		if (current) {
			const currentContent: SnapshotContent = {
				repository: current.repository,
				head: current.head,
				upstream: current.upstream,
				base: current.base,
				status: current.status,
				operation: current.operation,
			};
			if (!current.stale && contentKey(currentContent) === contentKey(content)) {
				this.cachedSnapshot = freezeSnapshot({ ...current, observedAt });
				return;
			}
		}

		this.revision++;
		this.replaceSnapshot(
			freezeSnapshot({
				...content,
				revision: this.revision,
				observedAt,
				stale: false,
			}),
		);
	}

	private markStale(): void {
		const current = this.cachedSnapshot;
		if (!current || current.stale) return;
		this.revision++;
		this.replaceSnapshot(freezeSnapshot({ ...current, revision: this.revision, stale: true }));
	}

	private replaceSnapshot(snapshot: RpcGitContext | null): void {
		const previous = this.cachedSnapshot;
		this.cachedSnapshot = snapshot;
		if (previous === snapshot) return;
		if (previous && snapshot && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// Collection is authoritative; an observer cannot turn a successful scan stale.
			}
		}
	}

	private updateLocation(location: GitWorktreeLocation | null): void {
		if (locationKey(location) === locationKey(this.currentLocation)) return;
		this.currentLocation = location;
		if (this.observationCount > 0) this.restartWatchers();
	}

	private startMonitoring(): void {
		this.restartWatchers();
		this.scheduleNextPoll();
	}

	private stopMonitoring(): void {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.watchRetryTimer) clearTimeout(this.watchRetryTimer);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.watchRetryTimer = null;
		this.pollTimer = null;
	}

	private restartWatchers(): void {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.watchRetryTimer) clearTimeout(this.watchRetryTimer);
		this.watchRetryTimer = null;
		const location = this.currentLocation;
		if (!location || this.disposed || this.observationCount === 0) return;

		const watchSpecs = new Map<string, Set<string> | null>();
		const addFiltered = (path: string): void => {
			const directory = dirname(path);
			const names = watchSpecs.get(directory);
			if (names === null) return;
			const nextNames = names ?? new Set<string>();
			nextNames.add(basename(path));
			watchSpecs.set(directory, nextNames);
		};
		addFiltered(location.headPath);
		addFiltered(location.indexPath);
		if (location.currentRefPath) addFiltered(location.currentRefPath);
		addFiltered(join(location.commonGitDir, "packed-refs"));
		watchSpecs.set(location.gitDir, null);
		if (location.reftableDir) watchSpecs.set(location.reftableDir, null);

		try {
			for (const [directory, names] of watchSpecs) {
				if (!existsSync(directory)) continue;
				const watcher = watch(directory, (_event, filename) => {
					const name = filename?.toString();
					if (!names || !name || names.has(name)) this.scheduleRefresh();
				});
				watcher.on("error", () => this.handleWatcherError());
				this.watchers.push(watcher);
			}
		} catch {
			this.handleWatcherError();
		}
	}

	private handleWatcherError(): void {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.watchRetryTimer || this.disposed || this.observationCount === 0) return;
		this.watchRetryTimer = setTimeout(() => {
			this.watchRetryTimer = null;
			this.restartWatchers();
		}, WATCH_RETRY_MS);
		this.watchRetryTimer.unref?.();
	}

	private scheduleNextPoll(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
		if (this.disposed || this.observationCount === 0) return;
		this.pollTimer = setTimeout(
			() => {
				this.pollTimer = null;
				void this.refresh();
			},
			Math.max(1, this.pollDelayMs),
		);
		this.pollTimer.unref?.();
	}
}
