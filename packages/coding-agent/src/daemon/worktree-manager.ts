import { createHash, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import { IROH_REMOTE_WORKTREE_ID_PATTERN } from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import {
	type IrohRemoteHostStateManager,
	isIrohRemoteWorktreeParentWorkspaceNotFoundError,
	isIrohRemoteWorktreePersistenceError,
} from "../core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, readSessionHeader } from "../core/session-manager.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import type { ControlRequest, ControlWorktreeStatus } from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import { resolveWorkspaceDirectory, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";

/** join(agentDir, "worktrees") — sibling of sessions/, daemon/, trust.json. */
export function getWorktreesRoot(agentDir: string): string {
	return join(resolve(agentDir), "worktrees");
}

export const WORKTREE_ID_PATTERN = IROH_REMOTE_WORKTREE_ID_PATTERN;
const MAX_RECOVERY_CHECKOUTS = 32;
const RECOVERY_PURGE_MARKER = ".volt-safe-to-purge.json";

/**
 * Encode a workspace path into the per-workspace worktrees directory segment,
 * reusing the `--<encoded-cwd>--` scheme from the session dirs so the layout
 * survives workspace renames. Long encodings are shortened with a hash suffix
 * to stay clear of Windows MAX_PATH limits.
 */
function getWorkspaceWorktreesSegment(workspacePath: string): string {
	const encoded = resolve(workspacePath)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
	if (encoded.length <= 80) {
		return `--${encoded}--`;
	}
	const digest = createHash("sha1").update(encoded).digest("hex").slice(0, 8);
	return `--${encoded.slice(0, 72)}-${digest}--`;
}

/** Per-workspace directory holding that workspace's worktree checkouts. */
export function getWorkspaceWorktreesDir(agentDir: string, workspacePath: string): string {
	return join(getWorktreesRoot(agentDir), getWorkspaceWorktreesSegment(workspacePath));
}

/**
 * Deterministic checkout path; the ONLY producer of checkout paths. Validates
 * the id and asserts the resolved path stays under the worktrees root — never
 * accepts a caller-supplied path.
 */
export function getWorktreeCheckoutPath(agentDir: string, workspacePath: string, worktreeId: string): string {
	if (!WORKTREE_ID_PATTERN.test(worktreeId)) {
		throw new Error(`invalid worktree id: ${worktreeId}`);
	}
	const root = resolve(getWorktreesRoot(agentDir));
	const checkoutPath = resolve(join(getWorkspaceWorktreesDir(agentDir, workspacePath), worktreeId));
	const rootPrefix = `${root}${sep}`;
	const contained =
		process.platform === "win32"
			? checkoutPath.toLowerCase().startsWith(rootPrefix.toLowerCase())
			: checkoutPath.startsWith(rootPrefix);
	if (!contained) {
		throw new Error("worktree checkout path escapes the worktrees root");
	}
	return checkoutPath;
}

/**
 * Convert a path relative to a daemon-managed worktree checkout back into the
 * registered-workspace-relative path used on the remote protocol. Nested repo
 * worktrees store sourceRootRelativePath (e.g. `Volt`), so a worktree cwd of
 * `packages/coding-agent` displays as `Volt/packages/coding-agent`.
 */
export function getRegisteredWorkingDirectoryForWorktree(
	worktree: Pick<IrohRemoteWorkspaceWorktree, "sourceRootRelativePath">,
	worktreeRelativePath?: string,
): string | undefined {
	if (worktree.sourceRootRelativePath === undefined) {
		return worktreeRelativePath;
	}
	return worktreeRelativePath === undefined
		? worktree.sourceRootRelativePath
		: posix.join(worktree.sourceRootRelativePath, worktreeRelativePath);
}

/** win32-aware "path is inside root" prefix check on resolved paths. */
function isPathContained(root: string, path: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	const rootPrefix = `${resolvedRoot}${sep}`;
	if (process.platform === "win32") {
		const lowerPath = resolvedPath.toLowerCase();
		return lowerPath === resolvedRoot.toLowerCase() || lowerPath.startsWith(rootPrefix.toLowerCase());
	}
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootPrefix);
}

/** True when path is inside the daemon's worktrees root (a daemon-managed checkout or below). */
export function isPathUnderWorktreesRoot(agentDir: string, path: string): boolean {
	const root = resolve(getWorktreesRoot(agentDir));
	const resolved = resolve(path);
	return resolved !== root && isPathContained(root, resolved);
}

/**
 * Resolve the PARENT checkout of a daemon-managed worktree from the checkout's
 * `.git` gitdir pointer (`gitdir: <parent>/.git/worktrees/<id>`), without a
 * daemon round-trip or a git subprocess. Returns undefined when the path is
 * not under the worktrees root or the pointer cannot be parsed. Used by the
 * TUI to pin trust decisions to the parent workspace path — trust entries are
 * never prompted for or persisted on worktree paths (design §5.1.9/§5.2.1).
 */
export function resolveWorktreeParentCheckout(agentDir: string, path: string): string | undefined {
	if (!isPathUnderWorktreesRoot(agentDir, path)) {
		return undefined;
	}
	const root = resolve(getWorktreesRoot(agentDir));
	const relativeSegments = resolve(path)
		.slice(root.length + 1)
		.split(sep)
		.filter((segment) => segment.length > 0);
	if (relativeSegments.length < 2) {
		return undefined;
	}
	// Layout: <root>/<encoded-workspace-segment>/<worktreeId>/...
	const checkoutPath = join(root, relativeSegments[0] ?? "", relativeSegments[1] ?? "");
	let gitFileContents: string;
	try {
		gitFileContents = readFileSync(join(checkoutPath, ".git"), "utf8");
	} catch {
		return undefined;
	}
	const match = gitFileContents.match(/^gitdir:\s*(.+)\s*$/m);
	if (!match?.[1]) {
		return undefined;
	}
	const gitDir = match[1].trim();
	if (!isAbsolute(gitDir)) {
		return undefined;
	}
	// gitDir is <parent>/.git/worktrees/<name>; the parent checkout is three levels up.
	const worktreesDir = dirname(resolve(gitDir));
	const dotGitDir = dirname(worktreesDir);
	if (worktreesDir.split(sep).pop() !== "worktrees" || dotGitDir.split(sep).pop() !== ".git") {
		return undefined;
	}
	return dirname(dotGitDir);
}

export type WorktreeRelayGate = { ok: true } | { ok: false; reason: "checkout_missing" | "tui_not_capable" };

/**
 * Gate a worktree-bound conversation relay: the checkout must exist and the
 * owning TUI must have advertised the worktrees control capability. Old TUIs
 * (no capability) are never offered worktree-session relays (design §5.2.3).
 */
export function evaluateWorktreeRelayGate(
	worktree: { path: string } | undefined,
	tuiCapabilities: ReadonlySet<string> | undefined,
	worktreesCapability: string,
): WorktreeRelayGate {
	if (worktree === undefined) {
		return { ok: true };
	}
	if (!existsSync(worktree.path)) {
		return { ok: false, reason: "checkout_missing" };
	}
	if (tuiCapabilities === undefined || !tuiCapabilities.has(worktreesCapability)) {
		return { ok: false, reason: "tui_not_capable" };
	}
	return { ok: true };
}

export type WorktreeError =
	| "not_a_git_repository"
	| "worktree_exists"
	| "worktree_branch_conflict"
	| "worktree_not_found"
	| "worktree_dirty"
	| "worktree_busy"
	| "worktree_limit_reached"
	| "worktree_source_unregistered"
	| "invalid_worktree_id"
	| "invalid_working_directory"
	| "nested_git_repository_unsupported"
	| "git_failed";

export type WorktreeGitRunner = (
	args: string[],
	cwd: string,
	options?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>;

export interface WorktreeManagerOptions {
	agentDir: string;
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	/** Injectable for tests; defaults to a spawnProcess/waitForChildProcess wrapper. */
	runGit?: WorktreeGitRunner;
	/** Max worktrees per workspace (default 16). */
	maxWorktreesPerWorkspace?: number;
	/** Seam for "is a runtime using this worktree" (wired to IntegratedRuntimeRegistry). */
	hasActiveRuntimeForSession?: (workspaceName: string, sessionId: string) => boolean;
	reserveSessionsForRemoval?: (workspaceName: string, sessionIds: string[]) => (() => void) | undefined;
	/** Durable-write seam (VoltdStateStore.flush); records must survive a crash the moment they exist. */
	flushState?: () => Promise<void>;
	now?: () => number;
}

export interface WorktreeStatus extends IrohRemoteWorkspaceWorktree {
	/** Checkout directory exists and `git worktree list` still knows it. */
	available: boolean;
	/** `git status --porcelain` non-empty, i.e. has uncommitted work (best-effort; undefined when unavailable). */
	dirty?: boolean;
	/** Branch commits vs the base ref (`git rev-list --left-right --count`); undefined when unavailable. */
	aheadBehind?: { ahead: number; behind: number };
}

export type WorktreeResult<T> = ({ ok: true } & T) | { ok: false; error: WorktreeError; detail?: string };

export interface WorktreeRuntimePreparation {
	publish<T>(publish: () => T): Promise<T>;
	release(): Promise<void>;
}

interface WorktreeSourceResolution {
	/** Selected directory under the registered workspace, preserving the remote relative path. */
	workspaceDirectory: WorkspaceDirectoryResolution;
	/** Git repository root used as `git worktree add` cwd. Host-local; never sent on the wire. */
	sourceRootPath: string;
	/** Registered-workspace-relative git repository root. Undefined means the registered workspace root. */
	sourceRootRelativePath?: string;
	/** Selected cwd relative to the git repository root. Undefined means the repo root. */
	workingDirectoryRelativePath?: string;
}

const DEFAULT_MAX_WORKTREES_PER_WORKSPACE = 16;

const SLUG_ADJECTIVES = ["amber", "brisk", "calm", "dusky", "eager", "fresh", "keen", "lucid", "quiet", "swift"];
const SLUG_NOUNS = ["basin", "cedar", "delta", "ember", "grove", "harbor", "mesa", "ridge", "summit", "vale"];

function generateWorktreeIdSlug(): string {
	const adjective = SLUG_ADJECTIVES[randomInt(SLUG_ADJECTIVES.length)];
	const noun = SLUG_NOUNS[randomInt(SLUG_NOUNS.length)];
	return `${adjective}-${noun}-${String(randomInt(100)).padStart(2, "0")}`;
}

/** Default runner: no shell, argv only, captured stdio. */
export function createDefaultWorktreeGitRunner(): WorktreeGitRunner {
	return async (args, cwd, options = {}) => {
		try {
			const child = spawnProcess("git", args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			const code = await waitForChildProcess(child);
			return { ok: code === 0, code, stdout, stderr };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const detail = message.includes("ENOENT") ? "git not found on daemon PATH; see docs/daemon.md" : message;
			return { ok: false, code: null, stdout: "", stderr: detail };
		}
	};
}

/**
 * Basic `git check-ref-format`-equivalent syntax gate for branch/baseRef
 * values. Rejects option injection (leading '-') and git-invalid ref
 * sequences; values are always passed as separate argv entries.
 */
export function isValidGitRefSyntax(ref: string): boolean {
	if (ref.length === 0 || ref.length > 255 || ref.startsWith("-")) {
		return false;
	}
	if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)) {
		return false;
	}
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) {
		return false;
	}
	if (ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) {
		return false;
	}
	return true;
}

export class WorktreeManager {
	private readonly agentDir: string;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly auditLogger: IrohRemoteAuditLogger;
	private readonly runGit: WorktreeGitRunner;
	private readonly maxWorktreesPerWorkspace: number;
	private readonly hasActiveRuntimeForSession: ((workspaceName: string, sessionId: string) => boolean) | undefined;
	private readonly reserveSessionsForRemoval:
		| ((workspaceName: string, sessionIds: string[]) => (() => void) | undefined)
		| undefined;
	private readonly flushState: (() => Promise<void>) | undefined;
	private readonly now: () => number;
	private readonly runtimePreparations = new Map<string, symbol>();

	constructor(options: WorktreeManagerOptions) {
		this.agentDir = options.agentDir;
		this.stateManager = options.stateManager;
		this.auditLogger = options.auditLogger;
		this.runGit = options.runGit ?? createDefaultWorktreeGitRunner();
		this.maxWorktreesPerWorkspace = options.maxWorktreesPerWorkspace ?? DEFAULT_MAX_WORKTREES_PER_WORKSPACE;
		this.hasActiveRuntimeForSession = options.hasActiveRuntimeForSession;
		this.reserveSessionsForRemoval = options.reserveSessionsForRemoval;
		this.flushState = options.flushState;
		this.now = options.now ?? Date.now;
	}

	private async quarantineCheckout(checkoutPath: string, worktreeId: string): Promise<string> {
		const recoveryRoot = join(getWorktreesRoot(this.agentDir), "recovery");
		ensurePrivateDirectorySync(recoveryRoot);
		const recoveries = await readdir(recoveryRoot, { withFileTypes: true });
		if (recoveries.filter((entry) => entry.isDirectory()).length >= MAX_RECOVERY_CHECKOUTS) {
			throw new Error(
				`worktree recovery quota of ${MAX_RECOVERY_CHECKOUTS} checkouts is full; run worktree prune --purge-recovery`,
			);
		}
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const recoveryPath = join(
				recoveryRoot,
				`${worktreeId}-${this.now()}-${randomInt(0x1000000).toString(16).padStart(6, "0")}`,
			);
			if (existsSync(recoveryPath)) continue;
			await rename(checkoutPath, recoveryPath);
			return recoveryPath;
		}
		throw new Error("could not allocate a unique worktree recovery path");
	}

	private async markRecoverySafeToPurge(recoveryPath: string, workspaceName: string): Promise<void> {
		await writeDurableAtomicFile(join(recoveryPath, RECOVERY_PURGE_MARKER), `${JSON.stringify({ workspaceName })}\n`);
	}

	async listRecoveryCheckouts(): Promise<string[]> {
		const recoveryRoot = join(getWorktreesRoot(this.agentDir), "recovery");
		if (!existsSync(recoveryRoot)) return [];
		return (await readdir(recoveryRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(recoveryRoot, entry.name))
			.sort();
	}

	/** git worktree add; persists the record durably after git succeeds. */
	async create(
		workspace: IrohRemoteWorkspace,
		options: { id?: string; branch?: string; baseRef?: string; workingDirectory?: string; signal?: AbortSignal } = {},
	): Promise<WorktreeResult<{ worktree: IrohRemoteWorkspaceWorktree }>> {
		const id = options.id ?? generateWorktreeIdSlug();
		if (!WORKTREE_ID_PATTERN.test(id)) {
			return { ok: false, error: "invalid_worktree_id" };
		}
		const branch = options.branch ?? `volt/${id}`;
		const baseRef = options.baseRef ?? "HEAD";
		if (!isValidGitRefSyntax(branch)) {
			return { ok: false, error: "git_failed", detail: "invalid branch ref syntax" };
		}
		if (!isValidGitRefSyntax(baseRef)) {
			return { ok: false, error: "git_failed", detail: "invalid baseRef ref syntax" };
		}

		try {
			const result = await this.stateManager.runWorkspaceWorktreeLifecycle<
				WorktreeResult<{ worktree: IrohRemoteWorkspaceWorktree }>
			>(workspace.name, async ({ workspace: registeredWorkspace, worktrees: existing }) => {
				if (existing.length >= this.maxWorktreesPerWorkspace) {
					return { result: { ok: false, error: "worktree_limit_reached" } };
				}
				const checkoutPath = getWorktreeCheckoutPath(this.agentDir, registeredWorkspace.path, id);
				if (existing.some((entry) => entry.id === id) || existsSync(checkoutPath)) {
					return { result: { ok: false, error: "worktree_exists" } };
				}
				const source = await this.resolveCreateSource(
					registeredWorkspace,
					options.workingDirectory,
					options.signal,
				);
				if (!source.ok) return { result: source };
				const repoCheck = await this.runGit(["rev-parse", "--git-common-dir"], source.source.sourceRootPath, {
					signal: options.signal,
				});
				if (!repoCheck.ok) {
					return {
						result: this.mapGitFailure(repoCheck.stderr, registeredWorkspace, checkoutPath, [
							source.source.sourceRootPath,
						]),
					};
				}
				const recordedBaseRef =
					options.baseRef ?? (await this.resolveDefaultBaseRef(source.source.sourceRootPath, options.signal));
				await mkdir(getWorkspaceWorktreesDir(this.agentDir, registeredWorkspace.path), {
					recursive: true,
					mode: 0o700,
				});
				options.signal?.throwIfAborted();
				const added = await this.runGit(
					["worktree", "add", checkoutPath, "-b", branch, baseRef],
					source.source.sourceRootPath,
					{ signal: options.signal },
				);
				if (!added.ok) {
					return {
						result: this.mapGitFailure(added.stderr, registeredWorkspace, checkoutPath, [
							source.source.sourceRootPath,
						]),
					};
				}
				const worktree: IrohRemoteWorkspaceWorktree = {
					id,
					workspaceName: registeredWorkspace.name,
					path: checkoutPath,
					...(source.source.sourceRootRelativePath === undefined
						? {}
						: { sourceRootRelativePath: source.source.sourceRootRelativePath }),
					branch,
					...(recordedBaseRef === undefined ? {} : { baseRef: recordedBaseRef }),
					createdAt: this.now(),
					sessionIds: [],
				};
				return { result: { ok: true, worktree }, worktree };
			});
			if (result.ok) await this.flushState?.();
			return result;
		} catch (error) {
			if (isIrohRemoteWorktreeParentWorkspaceNotFoundError(error)) {
				return { ok: false, error: "worktree_source_unregistered" };
			}
			if (isIrohRemoteWorktreePersistenceError(error)) {
				return { ok: false, error: "git_failed", detail: "worktree state could not be persisted" };
			}
			throw error;
		}
	}

	/** Adopt an existing git worktree checkout into daemon state; local control socket only. */
	async adopt(
		workspace: IrohRemoteWorkspace,
		options: { path: string; id?: string; baseRef?: string },
	): Promise<WorktreeResult<{ worktree: IrohRemoteWorkspaceWorktree }>> {
		const requestedPath = resolve(options.path);
		if (options.id !== undefined && !WORKTREE_ID_PATTERN.test(options.id)) {
			return { ok: false, error: "invalid_worktree_id" };
		}
		if (options.baseRef !== undefined && !isValidGitRefSyntax(options.baseRef)) {
			return { ok: false, error: "git_failed", detail: "invalid baseRef ref syntax" };
		}
		if (!existsSync(requestedPath)) {
			return { ok: false, error: "worktree_not_found", detail: "checkout path does not exist" };
		}

		try {
			const result = await this.stateManager.runWorkspaceWorktreeLifecycle<
				WorktreeResult<{ worktree: IrohRemoteWorkspaceWorktree }>
			>(workspace.name, async ({ workspace: registeredWorkspace, worktrees: existing }) => {
				if (existing.length >= this.maxWorktreesPerWorkspace) {
					return { result: { ok: false, error: "worktree_limit_reached" } };
				}

				const topLevel = await this.runGit(["rev-parse", "--show-toplevel"], requestedPath);
				if (!topLevel.ok) {
					return {
						result: this.mapGitFailure(topLevel.stderr, registeredWorkspace, requestedPath, [requestedPath]),
					};
				}
				const targetRootPath = await realpathOrResolve(topLevel.stdout.trim());
				if (existing.some((entry) => entry.id === options.id || isSamePath(entry.path, targetRootPath))) {
					return { result: { ok: false, error: "worktree_exists" } };
				}
				const id =
					options.id ?? deriveAdoptedWorktreeId(targetRootPath, new Set(existing.map((entry) => entry.id)));
				if (!WORKTREE_ID_PATTERN.test(id)) {
					return { result: { ok: false, error: "invalid_worktree_id" } };
				}

				const gitList = await this.runGit(["worktree", "list", "--porcelain"], targetRootPath);
				if (!gitList.ok) {
					return {
						result: this.mapGitFailure(gitList.stderr, registeredWorkspace, targetRootPath, [
							requestedPath,
							targetRootPath,
						]),
					};
				}
				const entries = parseWorktreeListEntries(gitList.stdout);
				const targetEntry = await findWorktreeListEntryByPath(entries, targetRootPath);
				if (targetEntry === undefined) {
					return {
						result: {
							ok: false,
							error: "worktree_not_found",
							detail: "checkout is not listed by git worktree",
						},
					};
				}
				const workspaceRootPath = await realpathOrResolve(registeredWorkspace.path);
				const sourceRootPath = await findAdoptSourceRootPath(entries, workspaceRootPath, targetRootPath);
				if (sourceRootPath === undefined) {
					return {
						result: {
							ok: false,
							error: "worktree_source_unregistered",
							detail: "worktree source checkout is not inside the registered workspace",
						},
					};
				}
				const sourceRootRelativePath = await findWorkspaceRelativePathForRealpath(
					workspaceRootPath,
					undefined,
					sourceRootPath,
				);
				if (sourceRootRelativePath === null) {
					return {
						result: {
							ok: false,
							error: "worktree_source_unregistered",
							detail: "worktree source checkout is not inside the registered workspace",
						},
					};
				}
				const branch = targetEntry.branch ?? targetEntry.detached ?? "HEAD";
				if (!isValidGitRefSyntax(branch)) {
					return {
						result: { ok: false, error: "git_failed", detail: "invalid worktree branch ref syntax" },
					};
				}
				const baseRef = options.baseRef ?? (await this.resolveDefaultBaseRef(sourceRootPath));

				const worktree: IrohRemoteWorkspaceWorktree = {
					id,
					workspaceName: registeredWorkspace.name,
					path: targetRootPath,
					...(sourceRootRelativePath === undefined ? {} : { sourceRootRelativePath }),
					branch,
					...(baseRef === undefined ? {} : { baseRef }),
					createdAt: this.now(),
					sessionIds: [],
				};
				return { result: { ok: true, worktree }, worktree };
			});
			if (result.ok) {
				try {
					await this.flushState?.();
				} catch {
					return {
						ok: false,
						error: "git_failed",
						detail: "worktree state could not be flushed; the existing checkout and daemon record were preserved",
					};
				}
			}
			return result;
		} catch (error) {
			if (isIrohRemoteWorktreeParentWorkspaceNotFoundError(error)) {
				return { ok: false, error: "worktree_source_unregistered" };
			}
			if (isIrohRemoteWorktreePersistenceError(error)) {
				return {
					ok: false,
					error: "git_failed",
					detail: "worktree state could not be persisted; the existing checkout was left unchanged",
				};
			}
			throw error;
		}
	}

	async validateWorkingDirectory(
		workspace: IrohRemoteWorkspace,
		workingDirectory?: string,
	): Promise<WorktreeResult<{ directory: WorkspaceDirectoryResolution }>> {
		const resolved = await resolveWorkspaceDirectory(workspace.path, workingDirectory);
		if (!resolved.ok) {
			return { ok: false, error: "invalid_working_directory", detail: resolved.error };
		}
		return { ok: true, directory: resolved.value };
	}

	async resolveWorktreeWorkingDirectory(
		workspace: IrohRemoteWorkspace,
		worktree: IrohRemoteWorkspaceWorktree,
		workingDirectory?: string,
	): Promise<WorktreeResult<{ directory: WorkspaceDirectoryResolution }>> {
		if (workingDirectory === undefined) {
			const rootDirectory = await resolveWorkspaceDirectory(worktree.path);
			return rootDirectory.ok
				? { ok: true, directory: rootDirectory.value }
				: { ok: false, error: "invalid_working_directory", detail: rootDirectory.error };
		}
		const parentDirectory = await this.validateWorkingDirectory(workspace, workingDirectory);
		if (!parentDirectory.ok) {
			return parentDirectory;
		}
		const sourceRootPath = await this.resolveRecordSourceRootPath(workspace, worktree);
		if (sourceRootPath === undefined || !isPathContained(sourceRootPath, parentDirectory.directory.absolutePath)) {
			return {
				ok: false,
				error: "invalid_working_directory",
				detail: "workingDirectory is outside the worktree source repository",
			};
		}
		const worktreeRelativePath = getContainedRelativePath(sourceRootPath, parentDirectory.directory.absolutePath);
		if (worktreeRelativePath === null) {
			return {
				ok: false,
				error: "invalid_working_directory",
				detail: "workingDirectory is outside the worktree source repository",
			};
		}
		const worktreeDirectory = await resolveWorkspaceDirectory(worktree.path, worktreeRelativePath);
		return worktreeDirectory.ok
			? { ok: true, directory: worktreeDirectory.value }
			: { ok: false, error: "invalid_working_directory", detail: worktreeDirectory.error };
	}

	private async resolveCreateSource(
		workspace: IrohRemoteWorkspace,
		workingDirectory?: string,
		signal?: AbortSignal,
	): Promise<WorktreeResult<{ source: WorktreeSourceResolution }>> {
		const workspaceDirectory = await this.validateWorkingDirectory(workspace, workingDirectory);
		if (!workspaceDirectory.ok) {
			return workspaceDirectory;
		}
		const topLevel = await this.runGit(
			["-C", workspaceDirectory.directory.absolutePath, "rev-parse", "--show-toplevel"],
			workspace.path,
			{ signal },
		);
		if (!topLevel.ok) {
			const detail = sanitizeGitDetail(topLevel.stderr, [
				workspace.path,
				workspaceDirectory.directory.absolutePath,
				getWorktreesRoot(this.agentDir),
			]);
			return {
				ok: false,
				error: topLevel.stderr.toLowerCase().includes("not a git repository")
					? "not_a_git_repository"
					: "git_failed",
				...(detail.length === 0 ? {} : { detail }),
			};
		}
		const workspaceRootPath = await realpathOrResolve(workspace.path);
		const sourceRootPath = await realpathOrResolve(topLevel.stdout.trim());
		if (!isPathContained(workspaceRootPath, sourceRootPath)) {
			return {
				ok: false,
				error: "invalid_working_directory",
				detail: "git repository is outside the registered workspace",
			};
		}
		const sourceRootRelativePath = await findWorkspaceRelativePathForRealpath(
			workspaceRootPath,
			workspaceDirectory.directory.relativePath,
			sourceRootPath,
		);
		if (sourceRootRelativePath === null) {
			return {
				ok: false,
				error: "invalid_working_directory",
				detail: "git repository is outside the registered workspace",
			};
		}
		const workingDirectoryRelativePath = getContainedRelativePath(
			sourceRootPath,
			workspaceDirectory.directory.absolutePath,
		);
		if (workingDirectoryRelativePath === null) {
			return {
				ok: false,
				error: "invalid_working_directory",
				detail: "workingDirectory is outside the source repository",
			};
		}
		return {
			ok: true,
			source: {
				workspaceDirectory: workspaceDirectory.directory,
				sourceRootPath,
				...(sourceRootRelativePath === undefined ? {} : { sourceRootRelativePath }),
				...(workingDirectoryRelativePath === undefined ? {} : { workingDirectoryRelativePath }),
			},
		};
	}

	async list(workspace: IrohRemoteWorkspace): Promise<WorktreeStatus[]> {
		const records = await this.stateManager.listWorktrees(workspace.name);
		const gitListBySourceRoot = new Map<string, Set<string> | undefined>();
		const statuses: WorktreeStatus[] = [];
		for (const record of records) {
			const sourceRootPath = await this.resolveRecordSourceRootPath(workspace, record);
			const knownCheckouts =
				sourceRootPath === undefined
					? undefined
					: await this.getKnownWorktreeCheckouts(sourceRootPath, gitListBySourceRoot);
			const onDisk = existsSync(record.path);
			const available =
				onDisk &&
				sourceRootPath !== undefined &&
				(knownCheckouts === undefined || knownCheckouts.has(resolve(record.path)));
			let dirty: boolean | undefined;
			let aheadBehind: { ahead: number; behind: number } | undefined;
			if (available) {
				// --no-optional-locks is a git-level option and must precede the subcommand.
				const status = await this.runGit(
					["-C", record.path, "--no-optional-locks", "status", "--porcelain"],
					sourceRootPath,
				);
				dirty = status.ok ? status.stdout.trim().length > 0 : undefined;
				aheadBehind = await this.computeAheadBehind(sourceRootPath, record);
			}
			statuses.push({
				...record,
				available,
				...(dirty === undefined ? {} : { dirty }),
				...(aheadBehind === undefined ? {} : { aheadBehind }),
			});
		}
		return statuses;
	}

	private async getKnownWorktreeCheckouts(
		sourceRootPath: string,
		cache: Map<string, Set<string> | undefined>,
	): Promise<Set<string> | undefined> {
		const key = resolve(sourceRootPath);
		if (cache.has(key)) {
			return cache.get(key);
		}
		const gitList = await this.runGit(["worktree", "list", "--porcelain"], sourceRootPath);
		const knownCheckouts = gitList.ok ? parseWorktreeListCheckouts(gitList.stdout) : undefined;
		cache.set(key, knownCheckouts);
		return knownCheckouts;
	}

	private async resolveRecordSourceRootPath(
		workspace: IrohRemoteWorkspace,
		record: IrohRemoteWorkspaceWorktree,
	): Promise<string | undefined> {
		const resolved = await resolveWorkspaceDirectory(workspace.path, record.sourceRootRelativePath);
		return resolved.ok ? resolved.value.absolutePath : undefined;
	}

	/** Concrete base for a defaulted create: current branch name, else commit sha. */
	private async resolveDefaultBaseRef(sourceRootPath: string, signal?: AbortSignal): Promise<string | undefined> {
		const symbolic = await this.runGit(["symbolic-ref", "--short", "-q", "HEAD"], sourceRootPath, { signal });
		const shortRef = symbolic.ok ? symbolic.stdout.trim() : "";
		if (shortRef.length > 0 && isValidGitRefSyntax(shortRef)) {
			return shortRef;
		}
		const sha = await this.runGit(["rev-parse", "HEAD"], sourceRootPath, { signal });
		const shaValue = sha.ok ? sha.stdout.trim() : "";
		return /^[0-9a-f]{4,64}$/i.test(shaValue) ? shaValue : undefined;
	}

	/**
	 * Merge-back guidance (design §5.3): branch commits relative to the base
	 * ref, computed read-only in the source checkout. `left...right` with
	 * left = base and right = branch yields "behind<TAB>ahead".
	 */
	private async computeAheadBehind(
		sourceRootPath: string,
		record: IrohRemoteWorkspaceWorktree,
	): Promise<{ ahead: number; behind: number } | undefined> {
		const baseRef = record.baseRef ?? "HEAD";
		const counted = await this.runGit(
			["rev-list", "--left-right", "--count", `${baseRef}...${record.branch}`],
			sourceRootPath,
		);
		if (!counted.ok) {
			return undefined;
		}
		const match = counted.stdout.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match?.[1] || !match[2]) {
			return undefined;
		}
		return { behind: Number.parseInt(match[1], 10), ahead: Number.parseInt(match[2], 10) };
	}

	private async hasSubmoduleData(
		checkoutPath: string,
		sourceRootPath: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		const submodules = await this.runGit(["-C", checkoutPath, "submodule", "status", "--recursive"], sourceRootPath, {
			signal,
		});
		if (!submodules.ok) return true;
		for (const line of submodules.stdout.split(/\r?\n/)) {
			if (line.length === 0) continue;
			if (!line.startsWith("-")) return true;
			const match = /^-([0-9a-f]{64}|[0-9a-f]{40}) (.+)$/i.exec(line);
			if (!match?.[2]) return true;
			const submodulePath = match[2];
			if (submodulePath.length === 0 || submodulePath.startsWith('"')) return true;
			const absolutePath = resolve(checkoutPath, submodulePath);
			if (getContainedRelativePath(checkoutPath, absolutePath) === null) return true;
			try {
				if (existsSync(absolutePath) && (await readdir(absolutePath)).length > 0) return true;
			} catch {
				return true;
			}
		}
		return false;
	}

	/** Refuses dirty/busy unless force; `git worktree remove [--force]`, then drops the record. */
	async remove(
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
		options: { force?: boolean } = {},
	): Promise<WorktreeResult<Record<never, never>>> {
		const force = options.force === true;
		let preservedRecovery = false;
		let cleanRecoveryPath: string | undefined;
		let releaseSessionRemoval: (() => void) | undefined;
		try {
			const result = await this.stateManager.runWorkspaceWorktreeLifecycle<WorktreeResult<Record<never, never>>>(
				workspace.name,
				async (current) => {
					const record = current.worktrees.find((entry) => entry.id === worktreeId);
					if (!record) {
						return { result: { ok: false, error: "worktree_not_found" } };
					}
					if (this.runtimePreparations.has(`${current.workspace.name}\0${worktreeId}`)) {
						return { result: { ok: false, error: "worktree_busy" } };
					}
					if (record.sessionIds.length > 0) {
						releaseSessionRemoval = this.reserveSessionsForRemoval?.(current.workspace.name, record.sessionIds);
						if (!releaseSessionRemoval) {
							return { result: { ok: false, error: "worktree_busy" } };
						}
					}
					const sourceRootPath = await this.resolveRecordSourceRootPath(current.workspace, record);
					if (existsSync(record.path)) {
						if (sourceRootPath === undefined) {
							return {
								result: {
									ok: false,
									error: "not_a_git_repository",
									detail: "worktree source repository is unavailable",
								},
							};
						}
						if (!force) {
							const status = await this.runGit(
								["-C", record.path, "--no-optional-locks", "status", "--porcelain", "--ignored=matching"],
								sourceRootPath,
							);
							if (
								!status.ok ||
								status.stdout.trim().length > 0 ||
								(await this.hasSubmoduleData(record.path, sourceRootPath))
							) {
								return { result: { ok: false, error: "worktree_dirty", detail: "dirty" } };
							}
						}
						if (force) {
							const removed = await this.runGit(["worktree", "remove", "--force", record.path], sourceRootPath);
							if (!removed.ok) {
								return {
									result: this.mapGitFailure(removed.stderr, current.workspace, record.path, [sourceRootPath]),
								};
							}
						} else {
							try {
								const recoveryPath = await this.quarantineCheckout(record.path, record.id);
								const finalStatus = await this.runGit(
									["-C", recoveryPath, "--no-optional-locks", "status", "--porcelain", "--ignored=matching"],
									sourceRootPath,
								);
								if (
									!finalStatus.ok ||
									finalStatus.stdout.trim().length > 0 ||
									(await this.hasSubmoduleData(recoveryPath, sourceRootPath))
								) {
									preservedRecovery = true;
									return {
										result: {
											ok: false,
											error: "worktree_dirty",
											detail: `checkout changed during removal and was preserved at ${recoveryPath}`,
										},
										worktree: { ...record, path: recoveryPath },
									};
								}
								cleanRecoveryPath = recoveryPath;
							} catch (error) {
								return {
									result: {
										ok: false,
										error: "git_failed",
										detail: error instanceof Error ? error.message : String(error),
									},
								};
							}
							await this.runGit(["worktree", "prune"], sourceRootPath).catch(() => undefined);
						}
					} else if (sourceRootPath !== undefined) {
						// Checkout vanished out-of-band: clear the stale gitdir entry best-effort.
						await this.runGit(["worktree", "prune"], sourceRootPath).catch(() => undefined);
					}
					return { result: { ok: true }, removeWorktreeIds: [worktreeId] };
				},
			);
			if (result.ok || preservedRecovery) {
				await this.flushState?.();
			}
			if (result.ok && cleanRecoveryPath) {
				await this.markRecoverySafeToPurge(cleanRecoveryPath, workspace.name).catch(() => undefined);
			}
			return result;
		} catch (error) {
			if (isIrohRemoteWorktreeParentWorkspaceNotFoundError(error)) {
				return { ok: false, error: "worktree_source_unregistered" };
			}
			if (isIrohRemoteWorktreePersistenceError(error)) {
				return { ok: false, error: "git_failed", detail: "worktree removal state could not be persisted" };
			}
			throw error;
		} finally {
			releaseSessionRemoval?.();
		}
	}

	/**
	 * Reconcile persisted records vs filesystem vs `git worktree list`. Drops
	 * records without checkouts, quarantines unrecognized checkout directories
	 * (rename, never delete), and runs `git worktree prune` in each known source checkout.
	 */
	async prune(
		workspace: IrohRemoteWorkspace,
		options: { signal?: AbortSignal; purgeRecovery?: boolean } = {},
	): Promise<{ removedRecords: string[]; orphanCheckouts: string[]; purgedRecoveryCheckouts?: string[] }> {
		const { signal } = options;
		if (signal?.aborted) return { removedRecords: [], orphanCheckouts: [] };
		let purgedRecoveryCheckouts: string[] | undefined;
		let completed = false;
		const result = await this.stateManager.runWorkspaceWorktreeLifecycle<{
			removedRecords: string[];
			orphanCheckouts: string[];
		}>(workspace.name, async (current) => {
			if (options.purgeRecovery) {
				const ownedPaths = new Set(current.allWorktrees.map((record) => resolve(record.path)));
				purgedRecoveryCheckouts = [];
				for (const recoveryPath of await this.listRecoveryCheckouts()) {
					if (ownedPaths.has(resolve(recoveryPath))) continue;
					let marker: { workspaceName?: unknown };
					try {
						marker = JSON.parse(readFileSync(join(recoveryPath, RECOVERY_PURGE_MARKER), "utf8")) as {
							workspaceName?: unknown;
						};
					} catch {
						continue;
					}
					if (marker.workspaceName !== workspace.name) continue;
					await rm(recoveryPath, { recursive: true, force: true });
					purgedRecoveryCheckouts.push(basename(recoveryPath));
				}
			}
			const removedRecords: string[] = [];
			const orphanCheckouts: string[] = [];
			const outcome = () => ({
				result: { removedRecords, orphanCheckouts },
				...(removedRecords.length === 0 ? {} : { removeWorktreeIds: removedRecords }),
			});
			const sourceRootPaths = new Set<string>();
			for (const record of current.worktrees) {
				const sourceRootPath = await this.resolveRecordSourceRootPath(current.workspace, record);
				if (signal?.aborted) return outcome();
				if (sourceRootPath !== undefined) sourceRootPaths.add(sourceRootPath);
				if (!existsSync(record.path)) removedRecords.push(record.id);
			}
			const parentSourceRootPath = await this.resolveRecordSourceRootPath(current.workspace, {
				id: "root",
				workspaceName: current.workspace.name,
				path: current.workspace.path,
				branch: "HEAD",
				createdAt: 0,
				sessionIds: [],
			});
			if (signal?.aborted) return outcome();
			if (parentSourceRootPath !== undefined) sourceRootPaths.add(parentSourceRootPath);
			const workspaceDir = getWorkspaceWorktreesDir(this.agentDir, current.workspace.path);
			const recordedPaths = new Set(current.worktrees.map((record) => resolve(record.path)));
			if (existsSync(workspaceDir)) {
				for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
					if (signal?.aborted) return outcome();
					if (!entry.isDirectory() || entry.name.includes(".orphan-")) continue;
					const entryPath = resolve(join(workspaceDir, entry.name));
					if (recordedPaths.has(entryPath)) continue;
					try {
						await rename(entryPath, `${entryPath}.orphan-${this.now()}`);
						orphanCheckouts.push(entry.name);
					} catch {
						// Quarantine is best-effort; a busy directory stays put for the next prune.
					}
				}
			}
			for (const sourceRootPath of sourceRootPaths) {
				if (signal?.aborted) return outcome();
				await this.runGit(["worktree", "prune"], sourceRootPath, { signal }).catch(() => undefined);
			}
			completed = signal?.aborted !== true;
			return outcome();
		});
		if (result.removedRecords.length > 0) await this.flushState?.();
		if (completed) {
			await this.logAudit({
				type: "worktree_pruned",
				workspace: workspace.name,
				success: true,
				details: result,
			});
		}
		return purgedRecoveryCheckouts === undefined ? result : { ...result, purgedRecoveryCheckouts };
	}

	/**
	 * Retention removal (design §5.3): remove a worktree ONLY when it is not
	 * busy, has no uncommitted work, and its branch is fully merged into the
	 * base ref. Never forces; a skip returns the reason for the audit trail.
	 */
	async removeIfCleanAndMerged(
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
	): Promise<{ removed: true } | { removed: false; reason: string }> {
		const record = (await this.stateManager.listWorktrees(workspace.name)).find((entry) => entry.id === worktreeId);
		if (!record) {
			return { removed: false, reason: "worktree_not_found" };
		}
		if (
			this.hasActiveRuntimeForSession &&
			record.sessionIds.some((sessionId) => this.hasActiveRuntimeForSession?.(workspace.name, sessionId))
		) {
			return { removed: false, reason: "busy" };
		}
		if (!existsSync(record.path)) {
			return { removed: false, reason: "checkout_missing" };
		}
		const sourceRootPath = await this.resolveRecordSourceRootPath(workspace, record);
		if (sourceRootPath === undefined) {
			return { removed: false, reason: "source_unavailable" };
		}
		const status = await this.runGit(
			["-C", record.path, "--no-optional-locks", "status", "--porcelain", "--ignored=matching"],
			sourceRootPath,
		);
		if (!status.ok || status.stdout.trim().length > 0 || (await this.hasSubmoduleData(record.path, sourceRootPath))) {
			return { removed: false, reason: "dirty" };
		}
		const merged = await this.runGit(
			["merge-base", "--is-ancestor", record.branch, record.baseRef ?? "HEAD"],
			sourceRootPath,
		);
		if (!merged.ok) {
			return { removed: false, reason: "unmerged" };
		}
		const removedResult = await this.remove(workspace, worktreeId, { force: false });
		if (!removedResult.ok) {
			return { removed: false, reason: removedResult.error };
		}
		return { removed: true };
	}

	/** Lookup used by conversation open/resume and relay preamble resolution. */
	async resolveSessionWorktree(
		workspaceName: string,
		sessionId: string,
	): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		const bound = await this.stateManager.findWorktreeForSession(workspaceName, sessionId);
		if (bound) return bound;
		return this.resolveSessionWorktreeByStoredCwd(workspaceName, sessionId);
	}

	/**
	 * Binding-miss fallback (#83): worktrees[].sessionIds historically only
	 * recorded ids bound at creation, so rekeyed descendants (fork/new),
	 * subagent sessions, and pre-fix stranded sessions can live under a
	 * checkout without a binding. Resolve those from the session file's stored
	 * cwd — a header-only read of the filename-matching candidate in the
	 * parent-keyed session dir — and self-heal the durable binding. Anything
	 * ambiguous or unreadable fails closed to undefined (current behavior).
	 */
	private async resolveSessionWorktreeByStoredCwd(
		workspaceName: string,
		sessionId: string,
	): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		const worktrees = await this.stateManager.listWorktrees(workspaceName);
		if (worktrees.length === 0) {
			return undefined;
		}
		const state = await this.stateManager.getState();
		const workspace = state.workspaces.find((entry) => entry.name === workspaceName);
		if (!workspace) {
			return undefined;
		}
		const sessionDir = getDefaultSessionDirPath(workspace.path, this.agentDir);
		let candidates: string[];
		try {
			// Read-only lookup: reject a symlinked leaf without re-hardening a
			// directory this daemon-side path does not own (mirrors the
			// findForResume/findMostRecentSession read paths), and fail closed on
			// any fs error instead of letting it escape resolveSessionWorktree.
			ensurePrivateDirectorySync(sessionDir, { hardenExisting: false });
			candidates = (await readdir(sessionDir)).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
		} catch {
			return undefined;
		}
		const candidate = candidates.length === 1 ? candidates[0] : undefined;
		if (candidate === undefined) {
			return undefined;
		}
		const header = readSessionHeader(join(sessionDir, candidate));
		if (header?.id !== sessionId || typeof header.cwd !== "string" || header.cwd.length === 0) {
			return undefined;
		}
		const cwdReal = await realpathOrResolve(header.cwd);
		let match: { worktree: IrohRemoteWorkspaceWorktree; checkoutPath: string } | undefined;
		for (const worktree of worktrees) {
			const checkoutPath = await realpathOrResolve(worktree.path);
			if (!isPathContained(checkoutPath, cwdReal)) {
				continue;
			}
			// Adopted worktrees may nest; prefer the most specific containing checkout.
			if (match === undefined || checkoutPath.length > match.checkoutPath.length) {
				match = { worktree, checkoutPath };
			}
		}
		if (match === undefined) {
			return undefined;
		}
		// Self-heal so future lookups, session badging, and worktree busy checks
		// hit the persisted binding. Resolution must not fail because this durable
		// write did; the next lookup simply falls back again.
		await this.bindSession(workspaceName, match.worktree.id, sessionId).catch(() => undefined);
		return match.worktree;
	}

	async beginRuntimePreparation(workspaceName: string, worktreeId: string): Promise<WorktreeRuntimePreparation> {
		const key = `${workspaceName}\0${worktreeId}`;
		const token = Symbol(key);
		await this.stateManager.runWorkspaceWorktreeLifecycle(workspaceName, async (current) => {
			const record = current.worktrees.find((entry) => entry.id === worktreeId);
			if (!record || !existsSync(record.path) || this.runtimePreparations.has(key)) {
				throw new Error(`Worktree ${worktreeId} is unavailable for runtime preparation`);
			}
			this.runtimePreparations.set(key, token);
			return { result: undefined };
		});
		let settled = false;
		return {
			publish: <T>(publish: () => T) =>
				this.stateManager.runWorkspaceWorktreeLifecycle(workspaceName, async (current) => {
					const record = current.worktrees.find((entry) => entry.id === worktreeId);
					if (settled || this.runtimePreparations.get(key) !== token || !record || !existsSync(record.path)) {
						throw new Error(`Worktree ${worktreeId} is unavailable for runtime publication`);
					}
					const result = publish();
					settled = true;
					this.runtimePreparations.delete(key);
					return { result };
				}),
			release: async () => {
				if (settled) return;
				try {
					await this.stateManager.runWorkspaceWorktreeLifecycle(workspaceName, async () => {
						if (this.runtimePreparations.get(key) === token) this.runtimePreparations.delete(key);
						settled = true;
						return { result: undefined };
					});
				} finally {
					if (this.runtimePreparations.get(key) === token) this.runtimePreparations.delete(key);
					settled = true;
				}
			},
		};
	}

	async bindSession(
		workspaceName: string,
		worktreeId: string,
		sessionId: string,
		afterPersistWhileLocked?: () => Promise<void>,
	): Promise<void> {
		await this.stateManager.runWorkspaceWorktreeLifecycle(workspaceName, async (current) => {
			const record = current.worktrees.find((entry) => entry.id === worktreeId);
			if (record === undefined) {
				throw new Error(`Worktree ${worktreeId} is unavailable for session binding`);
			}
			const bound = structuredClone(record);
			if (!bound.sessionIds.includes(sessionId)) bound.sessionIds.push(sessionId);
			return {
				result: undefined,
				worktree: bound,
				afterPersistWhileLocked:
					afterPersistWhileLocked === undefined
						? undefined
						: async () => {
								await this.flushState?.();
								await afterPersistWhileLocked();
							},
			};
		});
		if (afterPersistWhileLocked === undefined) await this.flushState?.();
	}

	async findWorktree(workspaceName: string, worktreeId: string): Promise<IrohRemoteWorkspaceWorktree | undefined> {
		const records = await this.stateManager.listWorktrees(workspaceName);
		return records.find((entry) => entry.id === worktreeId);
	}

	/**
	 * Compatibility guard for post-unregister callers. Workspace unregister is
	 * deliberately non-destructive: persisted worktrees block the state mutation,
	 * and unknown checkout directories are preserved for manual reconciliation.
	 */
	async cleanupUnregisteredWorkspace(workspace: IrohRemoteWorkspace): Promise<void> {
		const workspaceDir = getWorkspaceWorktreesDir(this.agentDir, workspace.path);
		if (!existsSync(workspaceDir)) {
			return;
		}
		let preservedEntryCount = 0;
		try {
			preservedEntryCount = (await readdir(workspaceDir)).length;
		} catch {
			// Inspection is best-effort. Failure still leaves every path untouched.
		}
		const persistedWorktreeIds = (await this.stateManager.listWorktrees(workspace.name))
			.map((worktree) => worktree.id)
			.sort();
		await this.logAudit({
			type: "worktree_unregister_cleanup_skipped",
			workspace: workspace.name,
			success: false,
			error: "workspace unregister never removes worktree checkouts",
			details: {
				persistedWorktreeIds,
				preservedEntryCount,
				reason: "non_destructive_workspace_unregister",
			},
		});
	}

	private mapGitFailure(
		stderr: string,
		workspace: IrohRemoteWorkspace,
		checkoutPath: string,
		extraPaths: string[] = [],
	): { ok: false; error: WorktreeError; detail: string } {
		const detail = sanitizeGitDetail(stderr, [
			checkoutPath,
			workspace.path,
			...extraPaths,
			getWorktreesRoot(this.agentDir),
		]);
		const lower = stderr.toLowerCase();
		if (lower.includes("not a git repository")) {
			return { ok: false, error: "not_a_git_repository", detail };
		}
		if (lower.includes("already exists")) {
			return lower.includes("branch") || lower.includes("-b")
				? { ok: false, error: "worktree_branch_conflict", detail }
				: { ok: false, error: "worktree_exists", detail };
		}
		if (lower.includes("contains modified or untracked files")) {
			return { ok: false, error: "worktree_dirty", detail };
		}
		return { ok: false, error: "git_failed", detail };
	}

	private async logAudit(event: Parameters<IrohRemoteAuditLogger["log"]>[0]): Promise<void> {
		try {
			await this.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort.
		}
	}
}

async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function getContainedRelativePath(root: string, child: string): string | null | undefined {
	const relativePath = relative(resolve(root), resolve(child));
	if (relativePath.length === 0 || relativePath === ".") {
		return undefined;
	}
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return null;
	}
	return relativePath.split(sep).join("/");
}

async function findWorkspaceRelativePathForRealpath(
	workspaceRootPath: string,
	selectedRelativePath: string | undefined,
	targetRealpath: string,
): Promise<string | null | undefined> {
	const selectedSegments = selectedRelativePath?.split("/") ?? [];
	for (let count = selectedSegments.length; count >= 0; count -= 1) {
		const candidateRelativePath = count === 0 ? undefined : selectedSegments.slice(0, count).join("/");
		const candidatePath =
			candidateRelativePath === undefined ? workspaceRootPath : resolve(workspaceRootPath, candidateRelativePath);
		try {
			const candidateRealpath = await realpath(candidatePath);
			if (isSamePath(candidateRealpath, targetRealpath)) {
				return candidateRelativePath;
			}
		} catch {
			// Ignore missing ancestors and fall back to the canonical realpath-relative form below.
		}
	}
	return getContainedRelativePath(workspaceRootPath, targetRealpath);
}

function isSamePath(left: string, right: string): boolean {
	const resolvedLeft = resolve(left);
	const resolvedRight = resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

interface GitWorktreeListEntry {
	path: string;
	branch?: string;
	detached?: string;
}

function parseWorktreeListEntries(porcelainOutput: string): GitWorktreeListEntry[] {
	const entries: GitWorktreeListEntry[] = [];
	let current: GitWorktreeListEntry | undefined;
	const pushCurrent = () => {
		if (current !== undefined) {
			entries.push(current);
			current = undefined;
		}
	};
	for (const line of porcelainOutput.split("\n")) {
		if (line.length === 0) {
			pushCurrent();
			continue;
		}
		if (line.startsWith("worktree ")) {
			pushCurrent();
			current = { path: line.slice("worktree ".length).trim() };
			continue;
		}
		if (current === undefined) {
			continue;
		}
		if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			continue;
		}
		if (line.startsWith("detached ")) {
			current.detached = line.slice("detached ".length).trim();
		}
	}
	pushCurrent();
	return entries;
}

function parseWorktreeListCheckouts(porcelainOutput: string): Set<string> {
	return new Set(parseWorktreeListEntries(porcelainOutput).map((entry) => resolve(entry.path)));
}

async function findWorktreeListEntryByPath(
	entries: readonly GitWorktreeListEntry[],
	path: string,
): Promise<GitWorktreeListEntry | undefined> {
	for (const entry of entries) {
		if (isSamePath(await realpathOrResolve(entry.path), path)) {
			return entry;
		}
	}
	return undefined;
}

async function findAdoptSourceRootPath(
	entries: readonly GitWorktreeListEntry[],
	workspaceRootPath: string,
	targetRootPath: string,
): Promise<string | undefined> {
	for (const entry of entries) {
		const entryPath = await realpathOrResolve(entry.path);
		if (!isSamePath(entryPath, targetRootPath) && isPathContained(workspaceRootPath, entryPath)) {
			return entryPath;
		}
	}
	return undefined;
}

function deriveAdoptedWorktreeId(path: string, usedIds: ReadonlySet<string>): string {
	const baseName = basename(path)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 64);
	const base = WORKTREE_ID_PATTERN.test(baseName) ? baseName : "adopted";
	for (let index = 0; index < 100; index++) {
		const suffix = index === 0 ? "" : `-${index}`;
		const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
		if (WORKTREE_ID_PATTERN.test(candidate) && !usedIds.has(candidate)) {
			return candidate;
		}
	}
	return generateWorktreeIdSlug();
}

/** Strip host paths from git stderr before it lands in an RPC detail field. */
function sanitizeGitDetail(stderr: string, paths: string[]): string {
	let detail = stderr.trim();
	for (const path of paths) {
		while (detail.includes(path)) {
			detail = detail.replace(path, "<redacted>");
		}
	}
	return detail;
}

export interface WorktreeRetentionSweeperOptions {
	manager: WorktreeManager;
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	/** Resolved at sweep time so settings changes apply without a restart. */
	getRetentionPolicy: () => { enabled: boolean; ttlMs: number } | undefined;
	/** Injectable timers (tests). */
	setTimer?: (callback: () => void, ttlMs: number) => NodeJS.Timeout;
	clearTimer?: (timer: NodeJS.Timeout) => void;
}

/**
 * Opt-in worktree retention (design §5.3): when a worktree-bound runtime is
 * disposed, schedule a TTL sweep that removes the worktree ONLY when it is
 * clean and fully merged into its base ref; otherwise the skip is audited as
 * worktree_retention_skipped_dirty and the checkout stays put.
 */
export class WorktreeRetentionSweeper {
	private readonly options: WorktreeRetentionSweeperOptions;
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private disposed = false;

	constructor(options: WorktreeRetentionSweeperOptions) {
		this.options = options;
	}

	/** Hooked to IntegratedRuntimeRegistry.onRuntimeDisposed for worktree-bound entries. */
	onRuntimeDisposed(workspaceName: string, worktreeId: string): void {
		if (this.disposed) {
			return;
		}
		const policy = this.options.getRetentionPolicy();
		if (policy === undefined || !policy.enabled) {
			return;
		}
		const key = `${workspaceName}\0${worktreeId}`;
		const existing = this.timers.get(key);
		if (existing !== undefined) {
			(this.options.clearTimer ?? clearTimeout)(existing);
		}
		const timer = (this.options.setTimer ?? setTimeout)(() => {
			this.timers.delete(key);
			void this.sweep(workspaceName, worktreeId);
		}, policy.ttlMs);
		timer.unref?.();
		this.timers.set(key, timer);
	}

	private async sweep(workspaceName: string, worktreeId: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		try {
			const state = await this.options.stateManager.getState();
			const workspace = state.workspaces.find((entry) => entry.name === workspaceName);
			if (!workspace) {
				return;
			}
			const result = await this.options.manager.removeIfCleanAndMerged(workspace, worktreeId);
			if (result.removed) {
				await this.options.auditLogger.log({
					type: "worktree_retention_removed",
					workspace: workspaceName,
					success: true,
					details: { worktreeId },
				});
				return;
			}
			if (result.reason === "worktree_not_found") {
				return;
			}
			await this.options.auditLogger.log({
				type: "worktree_retention_skipped_dirty",
				workspace: workspaceName,
				success: false,
				details: { worktreeId, reason: result.reason },
			});
		} catch {
			// Retention is best-effort; the next disposal reschedules.
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) {
			(this.options.clearTimer ?? clearTimeout)(timer);
		}
		this.timers.clear();
	}
}

export type WorktreeControlRequest = Extract<
	ControlRequest,
	{
		type:
			| "worktree_create"
			| "worktree_adopt"
			| "worktree_list"
			| "worktree_remove"
			| "worktree_prune"
			| "worktree_resolve"
			| "worktree_bind";
	}
>;

export interface WorktreeControlRequestHooks {
	manager: WorktreeManager;
	stateManager: IrohRemoteHostStateManager;
	bindWorktreeSession?: (
		workspaceName: string,
		worktreeId: string,
		sessionId: string,
		acquireLease: boolean,
	) => Promise<boolean>;
	/** Force-remove hook that stops bound runtimes first (wired by the iroh service). */
	removeWorktree?: (
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
		force: boolean,
	) => Promise<WorktreeResult<Record<never, never>>>;
}

export function isWorktreeControlRequest(request: ControlRequest): request is WorktreeControlRequest {
	return (
		request.type === "worktree_create" ||
		request.type === "worktree_adopt" ||
		request.type === "worktree_list" ||
		request.type === "worktree_remove" ||
		request.type === "worktree_prune" ||
		request.type === "worktree_resolve" ||
		request.type === "worktree_bind"
	);
}

/**
 * Shared `worktree_*` control-socket handler: used by the daemon skeleton
 * (main.ts fallback) and the iroh service (which layers runtime-aware remove
 * on top via hooks.removeWorktree). Control responses MAY include checkout
 * paths — the no-paths rule applies to the iroh wire, not the local socket.
 */
export async function handleWorktreeControlRequest(
	connection: ControlConnection,
	request: WorktreeControlRequest,
	hooks: WorktreeControlRequestHooks,
): Promise<void> {
	const state = await hooks.stateManager.getState();
	const findWorkspace = (name: string): IrohRemoteWorkspace | undefined =>
		state.workspaces.find((workspace) => workspace.name === name);
	const sendWorkspaceNotFound = (name: string) => {
		connection.send({
			type: "error",
			id: request.id,
			code: "not_found",
			message: `No registered workspace named ${name}`,
		});
	};

	if (request.type === "worktree_create") {
		const workspace = findWorkspace(request.workspaceName);
		if (!workspace) {
			sendWorkspaceNotFound(request.workspaceName);
			return;
		}
		const created = await hooks.manager.create(workspace, {
			...(request.worktreeName === undefined ? {} : { id: request.worktreeName }),
			...(request.branch === undefined ? {} : { branch: request.branch }),
			...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
		});
		if (!created.ok) {
			connection.send({
				type: "error",
				id: request.id,
				code: created.error,
				message: created.detail ?? created.error,
			});
			return;
		}
		connection.send({
			type: "worktree_result",
			id: request.id,
			worktree: toControlWorktreeStatus(created.worktree, true),
		});
		return;
	}

	if (request.type === "worktree_adopt") {
		const workspace = findWorkspace(request.workspaceName);
		if (!workspace) {
			sendWorkspaceNotFound(request.workspaceName);
			return;
		}
		const adopted = await hooks.manager.adopt(workspace, {
			path: request.path,
			...(request.worktreeName === undefined ? {} : { id: request.worktreeName }),
			...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
		});
		if (!adopted.ok) {
			connection.send({
				type: "error",
				id: request.id,
				code: adopted.error,
				message: adopted.detail ?? adopted.error,
			});
			return;
		}
		connection.send({
			type: "worktree_result",
			id: request.id,
			worktree: toControlWorktreeStatus(adopted.worktree, true),
		});
		return;
	}

	if (request.type === "worktree_list") {
		const workspaces = resolveRequestWorkspaces(state.workspaces, request.workspaceName);
		if (!workspaces.ok) {
			sendWorkspaceNotFound(workspaces.missing);
			return;
		}
		const worktrees: ControlWorktreeStatus[] = [];
		for (const workspace of workspaces.workspaces) {
			for (const status of await hooks.manager.list(workspace)) {
				worktrees.push(toControlWorktreeStatus(status, status.available, status.dirty));
			}
		}
		connection.send({ type: "worktrees_result", id: request.id, worktrees });
		return;
	}

	if (request.type === "worktree_resolve") {
		const worktrees = await hooks.stateManager.listWorktrees();
		const match = worktrees
			.filter((worktree) => isPathContained(worktree.path, request.path))
			.sort((left, right) => right.path.length - left.path.length)[0];
		const workspace = match ? findWorkspace(match.workspaceName) : undefined;
		if (!match || !workspace) {
			connection.send({
				type: "error",
				id: request.id,
				code: "not_found",
				message: "path is not inside a daemon-managed worktree",
			});
			return;
		}
		connection.send({
			type: "worktree_resolve_result",
			id: request.id,
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			worktreeId: match.id,
			worktreePath: match.path,
		});
		return;
	}

	if (request.type === "worktree_bind") {
		const workspace = findWorkspace(request.workspaceName);
		if (!workspace) {
			sendWorkspaceNotFound(request.workspaceName);
			return;
		}
		const record = await hooks.manager.findWorktree(request.workspaceName, request.worktreeId);
		if (!record) {
			connection.send({
				type: "error",
				id: request.id,
				code: "worktree_not_found",
				message: `No worktree ${request.worktreeId} in workspace ${request.workspaceName}`,
			});
			return;
		}
		let bound = true;
		if (hooks.bindWorktreeSession) {
			bound = await hooks.bindWorktreeSession(
				request.workspaceName,
				request.worktreeId,
				request.sessionId,
				request.acquireLease === true,
			);
		} else {
			await hooks.manager.bindSession(request.workspaceName, request.worktreeId, request.sessionId);
		}
		if (!bound) {
			connection.send({
				type: "error",
				id: request.id,
				code: "worktree_busy",
				message: `Worktree ${request.worktreeId} is unavailable for lease acquisition`,
			});
			return;
		}
		connection.send({ type: "ok", id: request.id });
		return;
	}

	if (request.type === "worktree_remove") {
		const workspace = findWorkspace(request.workspaceName);
		if (!workspace) {
			sendWorkspaceNotFound(request.workspaceName);
			return;
		}
		const force = request.force === true;
		const removed = hooks.removeWorktree
			? await hooks.removeWorktree(workspace, request.worktreeId, force)
			: await hooks.manager.remove(workspace, request.worktreeId, { force });
		if (!removed.ok) {
			connection.send({
				type: "error",
				id: request.id,
				code: removed.error,
				message: removed.detail ?? removed.error,
			});
			return;
		}
		connection.send({ type: "ok", id: request.id });
		return;
	}

	const workspaces = resolveRequestWorkspaces(state.workspaces, request.workspaceName);
	if (!workspaces.ok) {
		sendWorkspaceNotFound(workspaces.missing);
		return;
	}
	const results: Array<{
		workspaceName: string;
		removedRecords: string[];
		orphanCheckouts: string[];
		purgedRecoveryCheckouts?: string[];
	}> = [];
	for (const workspace of workspaces.workspaces) {
		const pruned = await hooks.manager.prune(workspace, { purgeRecovery: request.purgeRecovery === true });
		results.push({ workspaceName: workspace.name, ...pruned });
	}
	connection.send({ type: "worktree_prune_result", id: request.id, results });
}

function resolveRequestWorkspaces(
	workspaces: IrohRemoteWorkspace[],
	workspaceName: string | undefined,
): { ok: true; workspaces: IrohRemoteWorkspace[] } | { ok: false; missing: string } {
	if (workspaceName === undefined) {
		return { ok: true, workspaces };
	}
	const workspace = workspaces.find((entry) => entry.name === workspaceName);
	return workspace ? { ok: true, workspaces: [workspace] } : { ok: false, missing: workspaceName };
}

function toControlWorktreeStatus(
	worktree: IrohRemoteWorkspaceWorktree & Partial<Pick<WorktreeStatus, "aheadBehind">>,
	available?: boolean,
	dirty?: boolean,
): ControlWorktreeStatus {
	return {
		id: worktree.id,
		workspaceName: worktree.workspaceName,
		path: worktree.path,
		branch: worktree.branch,
		...(worktree.baseRef === undefined ? {} : { baseRef: worktree.baseRef }),
		createdAt: worktree.createdAt,
		sessionIds: [...worktree.sessionIds],
		...(available === undefined ? {} : { available }),
		...(dirty === undefined ? {} : { dirty }),
		...(worktree.aheadBehind === undefined ? {} : { aheadBehind: worktree.aheadBehind }),
	};
}
