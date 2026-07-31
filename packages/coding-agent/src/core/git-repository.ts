import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS } from "./rpc/wire-limits.ts";

const MAX_GIT_POINTER_BYTES = 4096;

export interface GitWorktreeLocation {
	readonly worktreeRoot: string;
	readonly gitDir: string;
	readonly commonGitDir: string;
	readonly headPath: string;
	readonly indexPath: string;
	readonly currentRefPath: string | null;
	readonly reftableDir: string | null;
}

function readSmallTextFile(path: string): string | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function resolveGitDirectory(worktreeRoot: string, markerPath: string): string | null {
	try {
		if (statSync(markerPath).isDirectory()) return markerPath;
	} catch {
		return null;
	}

	const marker = readSmallTextFile(markerPath);
	const match = marker?.match(/^gitdir:\s*(.+?)\s*$/i);
	if (!match?.[1]) return null;
	return resolve(worktreeRoot, match[1]);
}

function resolveCommonGitDirectory(gitDir: string): string {
	const commonDir = readSmallTextFile(join(gitDir, "commondir"))?.trim();
	return commonDir ? resolve(gitDir, commonDir) : gitDir;
}

function resolveCurrentRefPath(gitDir: string, commonGitDir: string): string | null {
	const head = readSmallTextFile(join(gitDir, "HEAD"));
	const match = head?.match(/^ref:\s*(.+?)\s*$/);
	if (!match?.[1]) return null;

	const ref = match[1];
	const candidateRoot = ref.startsWith("refs/bisect/") || ref.startsWith("refs/worktree/") ? gitDir : commonGitDir;
	const candidate = resolve(candidateRoot, ref);
	const relativePath = relative(candidateRoot, candidate);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
	return candidate;
}

/** Locate the ordinary or linked Git worktree containing cwd without invoking Git. */
export function discoverGitWorktree(cwd: string): GitWorktreeLocation | null {
	let current = resolve(cwd);
	while (true) {
		const markerPath = join(current, ".git");
		if (existsSync(markerPath)) {
			const gitDir = resolveGitDirectory(current, markerPath);
			if (!gitDir || !existsSync(join(gitDir, "HEAD"))) return null;
			const commonGitDir = resolveCommonGitDirectory(gitDir);
			if (!existsSync(commonGitDir)) return null;
			const reftableDir = join(commonGitDir, "reftable");
			return Object.freeze({
				worktreeRoot: current,
				gitDir,
				commonGitDir,
				headPath: join(gitDir, "HEAD"),
				indexPath: join(gitDir, "index"),
				currentRefPath: resolveCurrentRefPath(gitDir, commonGitDir),
				reftableDir: existsSync(reftableDir) ? reftableDir : null,
			});
		}

		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function isUnsafeDisplayName(value: string): boolean {
	return (
		/[\0-\x1f\x7f]/.test(value) ||
		value.startsWith("/") ||
		value.startsWith("\\\\") ||
		/^[A-Za-z]:[\\/]/.test(value) ||
		/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
	);
}

/** Derive a bounded display-only name without exposing an absolute path or URL. */
export function getGitRepositoryDisplayName(location: GitWorktreeLocation, override?: string): string {
	const preferred = override?.trim();
	if (preferred && !isUnsafeDisplayName(preferred)) {
		return preferred.slice(0, RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS);
	}

	const commonName = basename(location.commonGitDir);
	const rawName = commonName === ".git" ? basename(dirname(location.commonGitDir)) : commonName.replace(/\.git$/, "");
	return (rawName || "repository").slice(0, RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS);
}
