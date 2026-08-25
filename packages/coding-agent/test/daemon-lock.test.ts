import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AcquireDaemonLockResult,
	acquireDaemonLock,
	type DaemonLockOwner,
	readDaemonLockOwner,
} from "../src/daemon/daemon-lock.ts";

const tempDirs: string[] = [];

function createLockPath(): { parentDir: string; lockDirPath: string } {
	const parentDir = mkdtempSync(join(tmpdir(), "voltd-lock-"));
	tempDirs.push(parentDir);
	return { parentDir, lockDirPath: join(parentDir, "voltd.lock") };
}

function seedLock(lockDirPath: string, owner: DaemonLockOwner): void {
	mkdirSync(lockDirPath, { mode: 0o700 });
	writeFileSync(join(lockDirPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function acquiredResults(results: AcquireDaemonLockResult[]): Array<Extract<AcquireDaemonLockResult, { ok: true }>> {
	return results.filter((result): result is Extract<AcquireDaemonLockResult, { ok: true }> => result.ok);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("daemon startup lock", () => {
	it("atomically serializes concurrent takeover of one stale generation", async () => {
		const { parentDir, lockDirPath } = createLockPath();
		const staleOwner: DaemonLockOwner = { pid: 4242, startedAtMs: 1, token: "stale-owner" };
		seedLock(lockDirPath, staleOwner);

		const contenderCount = 8;
		let staleChecks = 0;
		let releaseChecks: () => void = () => {};
		let allChecking: () => void = () => {};
		const checkGate = new Promise<void>((resolve) => {
			releaseChecks = resolve;
		});
		const allCheckingGate = new Promise<void>((resolve) => {
			allChecking = resolve;
		});
		const verifyOwner = async (owner: DaemonLockOwner) => {
			if (owner.token !== staleOwner.token) {
				return "match" as const;
			}
			staleChecks++;
			if (staleChecks === contenderCount) {
				allChecking();
			}
			await checkGate;
			return "gone" as const;
		};

		const attempts = Array.from({ length: contenderCount }, () => acquireDaemonLock(lockDirPath, { verifyOwner }));
		await allCheckingGate;
		releaseChecks();
		const results = await Promise.all(attempts);
		const acquired = acquiredResults(results);

		expect(acquired).toHaveLength(1);
		expect(readDaemonLockOwner(lockDirPath)?.token).toBe(acquired[0]?.lock.owner.token);
		expect(readdirSync(parentDir).some((entry) => entry.startsWith("voltd.lock.retired-"))).toBe(true);

		const later = await acquireDaemonLock(lockDirPath, { verifyOwner });
		expect(later.ok).toBe(false);
		if (!later.ok) {
			expect(later.owner?.token).toBe(acquired[0]?.lock.owner.token);
		}
		acquired[0]?.lock.release();
	});

	it("reclaims a lock whose live pid has a different creation time", async () => {
		const { lockDirPath } = createLockPath();
		const staleOwner: DaemonLockOwner = { pid: process.pid, startedAtMs: 1, token: "recycled-pid" };
		seedLock(lockDirPath, staleOwner);

		const result = await acquireDaemonLock(lockDirPath, {
			verifyOwner: async (owner) => {
				expect(owner).toEqual(staleOwner);
				return "mismatch";
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			result.lock.release();
		}
	});

	it("fails closed when a live lock owner's creation identity is unavailable", async () => {
		const { lockDirPath } = createLockPath();
		const owner: DaemonLockOwner = { pid: 4242, startedAtMs: 1, token: "unknown-owner" };
		seedLock(lockDirPath, owner);

		const result = await acquireDaemonLock(lockDirPath, { verifyOwner: async () => "unknown" });

		expect(result).toEqual({ ok: false, owner, reason: "held" });
		expect(readDaemonLockOwner(lockDirPath)).toEqual(owner);
	});

	it("recovers an abandoned lock with a partial stale-claim artifact", async () => {
		const { parentDir, lockDirPath } = createLockPath();
		mkdirSync(lockDirPath, { mode: 0o700 });
		writeFileSync(join(lockDirPath, ".stale-claim"), "");
		const staleTime = new Date(Date.now() - 60_000);
		utimesSync(lockDirPath, staleTime, staleTime);

		const result = await acquireDaemonLock(lockDirPath);

		expect(result.ok).toBe(true);
		const tombstoneName = readdirSync(parentDir).find((entry) => entry.startsWith("voltd.lock.retired-"));
		expect(tombstoneName).toBeDefined();
		expect(readdirSync(join(parentDir, tombstoneName as string))).toContain(".stale-claim");
		if (result.ok) {
			result.lock.release();
		}
	});

	it("recovers a stale malformed non-directory lock node", async () => {
		const { lockDirPath } = createLockPath();
		writeFileSync(lockDirPath, "corrupt");
		const staleTime = new Date(Date.now() - 60_000);
		utimesSync(lockDirPath, staleTime, staleTime);

		const result = await acquireDaemonLock(lockDirPath);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(readDaemonLockOwner(lockDirPath)).toEqual(result.lock.owner);
			result.lock.release();
		}
	});

	it("retries when a matching owner releases during identity verification", async () => {
		const { lockDirPath } = createLockPath();
		const first = await acquireDaemonLock(lockDirPath);
		expect(first.ok).toBe(true);
		if (!first.ok) {
			return;
		}
		let verificationStarted: () => void = () => {};
		let finishVerification: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			verificationStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finishVerification = resolve;
		});
		const pending = acquireDaemonLock(lockDirPath, {
			verifyOwner: async () => {
				verificationStarted();
				await gate;
				return "match";
			},
		});

		await started;
		first.lock.release();
		finishVerification();
		const second = await pending;
		expect(second.ok).toBe(true);
		if (second.ok) {
			second.lock.release();
		}
	});

	it.each(["ENOSPC", "EDQUOT"] as const)(
		"defers %s retirement during release and stale takeover without throwing",
		async (code) => {
			const retirementError = Object.assign(new Error(`${code} injected`), { code });
			const retireGeneration = () => {
				throw retirementError;
			};
			const owned = createLockPath();
			const acquired = await acquireDaemonLock(owned.lockDirPath, { retireGeneration });
			expect(acquired.ok).toBe(true);
			if (acquired.ok) {
				expect(() => acquired.lock.release()).not.toThrow();
				expect(readDaemonLockOwner(owned.lockDirPath)).toEqual(acquired.lock.owner);
			}

			const stale = createLockPath();
			const staleOwner: DaemonLockOwner = { pid: 4242, startedAtMs: 1, token: `stale-${code}` };
			seedLock(stale.lockDirPath, staleOwner);
			const takeover = await acquireDaemonLock(stale.lockDirPath, {
				retireGeneration,
				verifyOwner: async () => "gone",
			});
			expect(takeover).toEqual({ ok: false, reason: "contended" });
			expect(readDaemonLockOwner(stale.lockDirPath)).toEqual(staleOwner);
		},
	);

	it("an old release cannot remove a replacement lock after stale takeover", async () => {
		const { lockDirPath } = createLockPath();
		const first = await acquireDaemonLock(lockDirPath);
		expect(first.ok).toBe(true);
		if (!first.ok) {
			return;
		}
		const second = await acquireDaemonLock(lockDirPath, { verifyOwner: async () => "mismatch" });
		expect(second.ok).toBe(true);
		if (!second.ok) {
			return;
		}

		first.lock.release();
		expect(readDaemonLockOwner(lockDirPath)?.token).toBe(second.lock.owner.token);
		second.lock.release();
	});
});
