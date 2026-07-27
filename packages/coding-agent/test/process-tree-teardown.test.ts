/**
 * Process-tree teardown (#125).
 *
 * Signalling the process group misses any child that made itself a group leader
 * via setsid/setpgid — which test runners and daemons routinely do, and why a
 * `swiftpm-testing-helper` outlived its agent session by several hours.
 *
 * The victims here deliberately IGNORE SIGTERM and the tests pass `isExited: ()
 * => true`, because that is the production shape: the `sh -c` leader dies on
 * SIGTERM instantly, so any teardown that decides whether to escalate from the
 * leader's status alone will skip SIGKILL and leak the descendant.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { terminateProcessTree } from "../src/utils/shell.ts";

const isPosix = process.platform !== "win32";
const hasPerl = (() => {
	if (!isPosix) return false;
	try {
		execFileSync("perl", ["-e", "1"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

/** Distinctive sleep durations so probes never collide with real processes. */
const ESCAPED_MARKER = "4751";
const GROUPED_MARKER = "4752";
const PLAIN_MARKER = "4753";
const DEEP_MARKER = "4754";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pgrepFull(pattern: string): number[] {
	try {
		const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
		return out
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((pid) => Number.isInteger(pid) && pid > 1);
	} catch {
		return [];
	}
}

function pgidOf(pid: number): number | undefined {
	try {
		const out = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
		const pgid = Number.parseInt(out.trim(), 10);
		return Number.isInteger(pgid) ? pgid : undefined;
	} catch {
		return undefined;
	}
}

async function poll(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

function cleanup(child: ChildProcess | undefined, markers: string[]) {
	if (child?.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const marker of markers) {
		for (const pid of pgrepFull(`sleep ${marker}`)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

/** Spawn a detached shell whose child ignores SIGTERM, optionally escaping the group. */
function spawnStubbornTree(marker: string, escapeGroup: boolean): ChildProcess {
	const escapePrefix = escapeGroup ? "setpgrp(0,0); " : "";
	return spawn("/bin/sh", ["-c", `perl -e '$SIG{TERM}="IGNORE"; ${escapePrefix}exec("sleep","${marker}")' & wait`], {
		detached: true,
		stdio: "ignore",
	});
}

describe.runIf(isPosix)("terminateProcessTree", () => {
	test.runIf(hasPerl)(
		"force-kills a SIGTERM-ignoring descendant that left the process group",
		async () => {
			let child: ChildProcess | undefined;
			try {
				child = spawnStubbornTree(ESCAPED_MARKER, true);
				const shellPid = child.pid as number;

				expect(await poll(() => pgrepFull(`sleep ${ESCAPED_MARKER}`).length > 0, 5000)).toBe(true);
				const escapedPid = pgrepFull(`sleep ${ESCAPED_MARKER}`)[0];

				// Precondition: assert the escape is real, so a perl that failed to
				// change process group cannot let this test pass for the wrong reason.
				expect(pgidOf(escapedPid)).not.toBe(pgidOf(shellPid));

				// isExited: () => true is the production shape — the leader is already
				// gone by the time the grace period elapses.
				await terminateProcessTree(shellPid, () => true);

				expect(await poll(() => !pidAlive(escapedPid), 5000)).toBe(true);
			} finally {
				cleanup(child, [ESCAPED_MARKER]);
			}
		},
		30000,
	);

	test.runIf(hasPerl)(
		"force-kills a SIGTERM-ignoring child inside the process group",
		async () => {
			let child: ChildProcess | undefined;
			try {
				child = spawnStubbornTree(GROUPED_MARKER, false);
				const shellPid = child.pid as number;

				expect(await poll(() => pgrepFull(`sleep ${GROUPED_MARKER}`).length > 0, 5000)).toBe(true);
				const victimPid = pgrepFull(`sleep ${GROUPED_MARKER}`)[0];

				await terminateProcessTree(shellPid, () => true);

				expect(await poll(() => !pidAlive(victimPid), 5000)).toBe(true);
			} finally {
				cleanup(child, [GROUPED_MARKER]);
			}
		},
		30000,
	);

	// The enumeration is breadth-first, so anything that stops the walk early
	// drops whole levels — and the deepest levels are where escaped descendants
	// live. This guards the traversal reaching past the first generation.
	test("reaps a descendant several levels deep", async () => {
		let child: ChildProcess | undefined;
		try {
			child = spawn("/bin/sh", ["-c", `/bin/sh -c '/bin/sh -c "sleep ${DEEP_MARKER}" ' & wait`], {
				detached: true,
				stdio: "ignore",
			});
			const shellPid = child.pid as number;
			expect(await poll(() => pgrepFull(`sleep ${DEEP_MARKER}`).length > 0, 5000)).toBe(true);
			const deepPid = pgrepFull(`sleep ${DEEP_MARKER}`)[0];

			await terminateProcessTree(shellPid, () => true);

			expect(await poll(() => !pidAlive(deepPid), 5000)).toBe(true);
		} finally {
			cleanup(child, [DEEP_MARKER]);
		}
	}, 30000);

	// Needs no perl, so the teardown fix keeps coverage on minimal CI images.
	test("reaps ordinary same-group children", async () => {
		let child: ChildProcess | undefined;
		try {
			child = spawn("/bin/sh", ["-c", `sleep ${PLAIN_MARKER} & sleep ${PLAIN_MARKER}`], {
				detached: true,
				stdio: "ignore",
			});
			const shellPid = child.pid as number;
			expect(await poll(() => pgrepFull(`sleep ${PLAIN_MARKER}`).length > 0, 5000)).toBe(true);

			await terminateProcessTree(shellPid, () => false);

			expect(await poll(() => pgrepFull(`sleep ${PLAIN_MARKER}`).length === 0, 5000)).toBe(true);
		} finally {
			cleanup(child, [PLAIN_MARKER]);
		}
	}, 30000);
});
