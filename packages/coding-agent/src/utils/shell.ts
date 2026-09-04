import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	// One process-table read shared across every tracked child: this runs from
	// shutdown signal handlers, and a snapshot per child would multiply the
	// blocking cost by the number of in-flight commands.
	const table = process.platform === "win32" ? undefined : readChildrenByParent();
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid, table);
	}
	trackedDetachedChildPids.clear();
}

/** Grace period between SIGTERM and SIGKILL when tearing down a process tree. */
const SIGKILL_ESCALATION_MS = 200;
/** Cap on the process-table read so enumeration cannot stall a shutdown path. */
const PROCESS_TABLE_TIMEOUT_MS = 1000;

/**
 * Guard every signalling entry point: `process.kill(-1, ...)` would signal every
 * process the user can reach, and pid 1 is init.
 */
function isSignalablePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1;
}

/** Deliver a signal, tolerating a target that has already exited. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
	if (!isSignalablePid(pid)) return;
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone, or not ours to signal.
	}
}

function isProcessAlive(pid: number): boolean {
	if (!isSignalablePid(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the whole process table once and index it by parent.
 *
 * Deliberately one spawn rather than a `pgrep -P` per node: this runs on abort,
 * timeout, and shutdown signal handlers, and a per-node walk costs ~18ms each,
 * which on a large build tree blocks the event loop for seconds.
 */
function readChildrenByParent(): Map<number, number[]> | undefined {
	const result = spawnSync("ps", ["-Ao", "pid=,ppid="], {
		encoding: "utf8",
		timeout: PROCESS_TABLE_TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error || typeof result.stdout !== "string") return undefined;
	const childrenByParent = new Map<number, number[]>();
	for (const line of result.stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		const pid = Number.parseInt(fields[0] ?? "", 10);
		const ppid = Number.parseInt(fields[1] ?? "", 10);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const siblings = childrenByParent.get(ppid);
		if (siblings) siblings.push(pid);
		else childrenByParent.set(ppid, [pid]);
	}
	return childrenByParent;
}

/**
 * Collect every descendant of `pid`, deepest first.
 *
 * Signalling the process group is the primary mechanism, but a child that calls
 * setsid/setpgid becomes its own group leader and is no longer a member of the
 * group we signal — test runners and daemons do this routinely, and such a
 * child survives the group kill entirely. Walking parentage catches those.
 *
 * This must run BEFORE anything is killed: once an intermediate parent dies its
 * children are reparented to init and the ppid trail back to us is gone.
 */
function collectDescendantPids(pid: number, table?: Map<number, number[]>): number[] {
	if (process.platform === "win32") return [];
	const childrenByParent = table ?? readChildrenByParent();
	// No usable process table: fall back to group-only signalling, i.e. the
	// behavior that predated the sweep.
	if (!childrenByParent) return [];
	const collected: number[] = [];
	const seen = new Set<number>([pid]);
	const queue: number[] = [pid];
	// Deliberately uncapped. A breadth-first cap truncates whole levels, which
	// would drop exactly the deep escaped descendants the group kill cannot
	// reach — the failure this sweep exists to prevent, reappearing on any tree
	// large enough to hit the limit. `seen` bounds the walk to each pid once,
	// and the table is already in memory, so the traversal is map lookups.
	while (queue.length > 0) {
		const parent = queue.shift();
		if (parent === undefined) break;
		for (const childPid of childrenByParent.get(parent) ?? []) {
			if (!isSignalablePid(childPid) || seen.has(childPid)) continue;
			seen.add(childPid);
			collected.push(childPid);
			queue.push(childPid);
		}
	}
	// Deepest first, so a parent cannot spawn replacements while we work upward.
	return collected.reverse();
}

function killWindowsTree(pid: number): void {
	try {
		spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
	} catch {
		// Ignore errors if taskkill fails
	}
}

function terminateWindowsTree(pid: number): Promise<void> {
	return new Promise((resolveTermination) => {
		let taskkill: ReturnType<typeof spawn>;
		try {
			taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			resolveTermination();
			return;
		}
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			taskkill.removeListener("error", finish);
			taskkill.removeListener("close", finish);
			resolveTermination();
		};
		taskkill.once("error", finish);
		taskkill.once("close", finish);
	});
}

/** Signal the process group, then each descendant that escaped it. */
function signalProcessTree(pid: number, descendants: number[], signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// Fall back to the leader alone if the group is already gone.
		signalPid(pid, signal);
	}
	for (const descendant of descendants) signalPid(descendant, signal);
}

/**
 * Kill a process and all its children (cross-platform), synchronously.
 *
 * Stays synchronous because shutdown signal handlers cannot await; use
 * {@link terminateProcessTree} anywhere a graceful stop can be awaited.
 */
export function killProcessTree(pid: number, table?: Map<number, number[]>): void {
	if (!isSignalablePid(pid)) return;
	if (process.platform === "win32") {
		killWindowsTree(pid);
		return;
	}
	signalProcessTree(pid, collectDescendantPids(pid, table), "SIGKILL");
}

/**
 * Kill a process tree, giving it a brief chance to exit on SIGTERM first so it
 * can remove temp files and reap its own children before being force-killed.
 */
export async function terminateProcessTree(pid: number, isExited?: () => boolean): Promise<void> {
	if (!isSignalablePid(pid)) return;
	if (process.platform === "win32") {
		await terminateWindowsTree(pid);
		return;
	}

	const descendants = collectDescendantPids(pid);
	signalProcessTree(pid, descendants, "SIGTERM");

	await new Promise((resolve) => setTimeout(resolve, SIGKILL_ESCALATION_MS));

	// The leader exiting says nothing about the rest of the tree: a descendant
	// that ignores SIGTERM routinely outlives the shell that spawned it, which
	// is the whole reason this sweep exists. So the force phase is skipped only
	// when nothing is left alive — never on the leader's status alone.
	// Re-checking liveness here also keeps SIGKILL off pids that already exited
	// and may have been recycled during the grace period.
	const survivors = descendants.filter(isProcessAlive);
	const leaderAlive = isExited?.() === true ? false : isProcessAlive(pid);
	if (!leaderAlive && survivors.length === 0) return;
	signalProcessTree(pid, survivors, "SIGKILL");
}
