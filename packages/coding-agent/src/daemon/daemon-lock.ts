import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProcessCreationVerification, verifyVoltdProcessIdentity } from "./process-identity.ts";

const LOCK_OWNER_FILE = "owner.json";
const EMPTY_LOCK_CLAIM_DIR = ".stale-claim";
const EMPTY_LOCK_STALE_MS = 10_000;
const MAX_ACQUIRE_ATTEMPTS = 8;
export const DAEMON_LOCK_START_TIME_TOLERANCE_MS = 2_000;

export interface DaemonLockOwner {
	pid: number;
	/** Process creation time, used with pid to detect pid reuse. */
	startedAtMs: number;
	token: string;
}

export interface DaemonLock {
	owner: DaemonLockOwner;
	release(): void;
}

export type AcquireDaemonLockResult =
	| { ok: true; lock: DaemonLock }
	| { ok: false; owner?: DaemonLockOwner; reason: "held" | "contended" };

export interface AcquireDaemonLockOptions {
	/** Injectable for deterministic contention and process-identity tests. */
	verifyOwner?(owner: DaemonLockOwner): Promise<ProcessCreationVerification>;
	/** Injectable retirement rename for deterministic filesystem-capacity tests. */
	retireGeneration?(lockDirPath: string, retiredPath: string): void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function ownerPath(lockDirPath: string): string {
	return join(lockDirPath, LOCK_OWNER_FILE);
}

function parseDaemonLockOwner(contents: string): DaemonLockOwner | undefined {
	try {
		const parsed = JSON.parse(contents) as Partial<DaemonLockOwner>;
		if (
			!Number.isInteger(parsed.pid) ||
			typeof parsed.startedAtMs !== "number" ||
			!Number.isFinite(parsed.startedAtMs) ||
			typeof parsed.token !== "string" ||
			parsed.token.length === 0
		) {
			return undefined;
		}
		return { pid: parsed.pid as number, startedAtMs: parsed.startedAtMs, token: parsed.token };
	} catch {
		return undefined;
	}
}

export function readDaemonLockOwner(lockDirPath: string): DaemonLockOwner | undefined {
	try {
		return parseDaemonLockOwner(readFileSync(ownerPath(lockDirPath), "utf8"));
	} catch {
		return undefined;
	}
}

function sameOwner(left: DaemonLockOwner | undefined, right: DaemonLockOwner): boolean {
	return left?.pid === right.pid && left.startedAtMs === right.startedAtMs && left.token === right.token;
}

function ownerIdentity(owner: DaemonLockOwner): string {
	return `${owner.token}\0${owner.pid}\0${owner.startedAtMs}`;
}

function emptyLockLooksFresh(lockDirPath: string, nowMs: number): boolean {
	try {
		return nowMs - statSync(lockDirPath).mtimeMs < EMPTY_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function getMalformedLockIdentity(lockDirPath: string): string | undefined {
	try {
		const stats = lstatSync(lockDirPath, { bigint: true });
		if (stats.isDirectory()) {
			return undefined;
		}
		return `malformed\0${stats.dev}\0${stats.ino}\0${stats.mode}\0${stats.size}\0${stats.birthtimeMs}\0${stats.ctimeMs}`;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Make an abandoned empty/malformed lock non-empty without a partial-write
 * window. The complete marker directory also gives all contenders a stable
 * generation identity for the deterministic retirement path.
 */
function getEmptyLockIdentity(lockDirPath: string): string | undefined {
	const claimPath = join(lockDirPath, EMPTY_LOCK_CLAIM_DIR);
	try {
		mkdirSync(claimPath, { mode: 0o700 });
	} catch (error) {
		if (!isErrnoException(error) || error.code !== "EEXIST") {
			if (isErrnoException(error) && error.code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
	}
	try {
		const stats = statSync(claimPath, { bigint: true });
		return `empty\0${stats.dev}\0${stats.ino}\0${stats.birthtimeMs}\0${stats.ctimeMs}`;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function retiredLockPath(lockDirPath: string, identity: string): string {
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
	return `${lockDirPath}.retired-${digest}`;
}

/**
 * Atomically move one lock generation to its permanent deterministic tombstone.
 * Graceful release and stale takeover use the same destination. Once either
 * wins, delayed operations for that generation cannot rename a replacement
 * over the retained non-empty directory on POSIX or Windows.
 */
function retireLockGeneration(
	lockDirPath: string,
	identity: string,
	retireGeneration: (lockDirPath: string, retiredPath: string) => void = renameSync,
): "retired" | "retry" | "contended" {
	const retiredPath = retiredLockPath(lockDirPath, identity);
	try {
		retireGeneration(lockDirPath, retiredPath);
		return "retired";
	} catch (error) {
		if (!isErrnoException(error)) {
			throw error;
		}
		if (error.code === "ENOENT") {
			return "retry";
		}
		if (error.code === "ENOSPC" || error.code === "EDQUOT") {
			// Leave the current generation in place. Shutdown must not crash when
			// the filesystem cannot allocate retirement metadata, and a later start
			// can safely retry stale retirement after capacity is restored.
			return "contended";
		}
		if (existsSync(retiredPath)) {
			return "contended";
		}
		if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(error.code ?? "")) {
			return "contended";
		}
		throw error;
	}
}

function candidateLockPath(lockDirPath: string, token: string): string {
	return `${lockDirPath}.candidate-${token}`;
}

/** Build a complete private generation before exposing it at the shared path. */
function createLockCandidate(lockDirPath: string, owner: DaemonLockOwner): string {
	const candidatePath = candidateLockPath(lockDirPath, owner.token);
	mkdirSync(candidatePath, { mode: 0o700 });
	try {
		writeFileSync(ownerPath(candidatePath), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
		return candidatePath;
	} catch (error) {
		rmSync(candidatePath, { recursive: true, force: true });
		throw error;
	}
}

function tryPublishCandidate(candidatePath: string, lockDirPath: string): boolean {
	try {
		renameSync(candidatePath, lockDirPath);
		return true;
	} catch (error) {
		if (!isErrnoException(error)) {
			throw error;
		}
		if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM", "EACCES", "EBUSY"].includes(error.code ?? "")) {
			return false;
		}
		throw error;
	}
}

function createDaemonLock(
	lockDirPath: string,
	owner: DaemonLockOwner,
	retireGeneration?: AcquireDaemonLockOptions["retireGeneration"],
): DaemonLock {
	let released = false;
	return {
		owner,
		release() {
			if (released) {
				return;
			}
			released = true;
			retireLockGeneration(lockDirPath, ownerIdentity(owner), retireGeneration);
		},
	};
}

export async function acquireDaemonLock(
	lockDirPath: string,
	options: AcquireDaemonLockOptions = {},
): Promise<AcquireDaemonLockResult> {
	const owner: DaemonLockOwner = {
		pid: process.pid,
		startedAtMs: Date.now() - process.uptime() * 1000,
		token: randomUUID(),
	};
	const verifyOwner =
		options.verifyOwner ??
		((existingOwner: DaemonLockOwner) =>
			verifyVoltdProcessIdentity(existingOwner, { toleranceMs: DAEMON_LOCK_START_TIME_TOLERANCE_MS }));
	const candidatePath = createLockCandidate(lockDirPath, owner);
	let published = false;

	try {
		for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
			if (tryPublishCandidate(candidatePath, lockDirPath)) {
				published = true;
				return { ok: true, lock: createDaemonLock(lockDirPath, owner, options.retireGeneration) };
			}

			const existingOwner = readDaemonLockOwner(lockDirPath);
			if (existingOwner) {
				const verification = await verifyOwner(existingOwner);
				// The async identity query gives another process time to release or
				// replace the generation. Revalidate before every terminal decision.
				if (!sameOwner(readDaemonLockOwner(lockDirPath), existingOwner)) {
					continue;
				}
				if (verification === "match" || verification === "unknown") {
					return { ok: false, owner: existingOwner, reason: "held" };
				}
				const result = retireLockGeneration(lockDirPath, ownerIdentity(existingOwner), options.retireGeneration);
				if (result === "contended") {
					return { ok: false, reason: "contended" };
				}
				continue;
			}

			if (emptyLockLooksFresh(lockDirPath, Date.now())) {
				return { ok: false, reason: "contended" };
			}
			const malformedIdentity = getMalformedLockIdentity(lockDirPath);
			if (malformedIdentity) {
				const result = retireLockGeneration(lockDirPath, malformedIdentity, options.retireGeneration);
				if (result === "contended") {
					return { ok: false, reason: "contended" };
				}
				continue;
			}
			const emptyIdentity = getEmptyLockIdentity(lockDirPath);
			if (!emptyIdentity) {
				continue;
			}
			if (readDaemonLockOwner(lockDirPath)) {
				continue;
			}
			const result = retireLockGeneration(lockDirPath, emptyIdentity, options.retireGeneration);
			if (result === "contended") {
				return { ok: false, reason: "contended" };
			}
		}
		return { ok: false, reason: "contended" };
	} finally {
		if (!published) {
			rmSync(candidatePath, { recursive: true, force: true });
		}
	}
}
