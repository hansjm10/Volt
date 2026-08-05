import { spawnProcess } from "../utils/child-process.ts";
import type { PidfileContents } from "./main.ts";

/**
 * Process-identity verification for the pidfile SIGTERM fallbacks: a pidfile
 * outlives its daemon, and the recorded pid can be recycled by an unrelated
 * process. Before killing, verify the live process (a) started when the
 * pidfile says the daemon started and (b) has a voltd-looking command line.
 *
 * Platform-aware by design (Windows daemon support is planned): POSIX queries
 * `ps -o etime=,args=`; Windows queries Win32_Process via PowerShell CIM.
 */

export type ProcessQueryRunner = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

export interface ProcessIdentity {
	/** Absolute process start time; undefined when the platform query lacks it. */
	startTimeMs?: number;
	commandLine: string;
}

export type PidfileVerification = "match" | "mismatch" | "gone";
export type ProcessCreationVerification = "match" | "mismatch" | "gone" | "unknown";

export interface VerifyPidfileOptions {
	runner?: ProcessQueryRunner;
	platform?: NodeJS.Platform;
	now?: number;
	/** Allowed |actual start - pidfile.startedAtMs| skew (spawn-to-record delay, etime rounding). */
	toleranceMs?: number;
	/** Injectable liveness probe (kill(pid, 0)). */
	isProcessAlive?: (pid: number) => "alive" | "gone";
}

export const DEFAULT_START_TIME_TOLERANCE_MS = 15_000;

/**
 * Command-line markers that identify a voltd process. Linux rewrites argv to the
 * process title ("voltd"); macOS and Windows report the original invocation
 * (`... daemon run --foreground`).
 *
 * The bare "voltd" marker is matched as a whole path/argv token, not a bare
 * substring: an unrelated but same-user process whose command line merely
 * contains the string (e.g. `tail -f /var/log/voltd.log`, `vim voltd.ts`,
 * `node .../voltd-cli/x.js`) must not satisfy the identity check and be signalled.
 */
const VOLTD_COMMAND_MARKERS = [/(?:^|[\s/\\])voltd(?=$|[\s/\\])/, "daemon run --foreground"] as const;

const defaultRunner: ProcessQueryRunner = (command, args) =>
	new Promise((resolve) => {
		const child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error) => resolve({ code: 127, output: error.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});

function defaultIsProcessAlive(pid: number): "alive" | "gone" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		// EPERM: the pid exists but belongs to another user — alive (and almost
		// certainly not our daemon; the identity check will refuse it).
		return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
			? "alive"
			: "gone";
	}
}

/** Parse ps etime ("[[dd-]hh:]mm:ss") into elapsed milliseconds. */
export function parseElapsedTime(value: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const [, days, hours, minutes, seconds] = match;
	return (Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000;
}

async function queryPosixProcess(
	pid: number,
	runner: ProcessQueryRunner,
	now: () => number,
): Promise<ProcessIdentity | undefined> {
	// etime (not the Linux-only etimes) is in the POSIX ps keyword set and has a
	// fixed, locale-independent format.
	const result = await runner("ps", ["-p", String(pid), "-o", "etime=,args="]);
	if (result.code !== 0) {
		return undefined;
	}
	const line = result.output.split("\n").find((candidate) => candidate.trim().length > 0);
	if (!line) {
		return undefined;
	}
	const trimmed = line.trim();
	const separatorIndex = trimmed.search(/\s/);
	const etime = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
	const commandLine = separatorIndex === -1 ? "" : trimmed.slice(separatorIndex + 1).trim();
	const elapsedMs = parseElapsedTime(etime);
	return {
		...(elapsedMs === undefined ? {} : { startTimeMs: now() - elapsedMs }),
		commandLine,
	};
}

async function queryWindowsProcess(pid: number, runner: ProcessQueryRunner): Promise<ProcessIdentity | undefined> {
	// CIM gives both an absolute creation time and the original command line.
	const script =
		`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
		`if ($p) { ConvertTo-Json -Compress @{ startMs = [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds(); commandLine = [string]$p.CommandLine } }`;
	const result = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
	if (result.code !== 0) {
		return undefined;
	}
	const jsonLine = result.output.split("\n").find((candidate) => candidate.trim().startsWith("{"));
	if (!jsonLine) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(jsonLine.trim()) as { startMs?: unknown; commandLine?: unknown };
		return {
			...(typeof parsed.startMs === "number" && Number.isFinite(parsed.startMs)
				? { startTimeMs: parsed.startMs }
				: {}),
			commandLine: typeof parsed.commandLine === "string" ? parsed.commandLine : "",
		};
	} catch {
		return undefined;
	}
}

function commandLineLooksLikeVoltd(commandLine: string): boolean {
	return VOLTD_COMMAND_MARKERS.some((marker) =>
		typeof marker === "string" ? commandLine.includes(marker) : marker.test(commandLine),
	);
}

type ProcessIdentityLookup = { kind: "found"; identity: ProcessIdentity } | { kind: "gone" } | { kind: "unknown" };

async function lookupProcessIdentity(pid: number, options: VerifyPidfileOptions): Promise<ProcessIdentityLookup> {
	const runner = options.runner ?? defaultRunner;
	const platform = options.platform ?? process.platform;
	const now = () => options.now ?? Date.now();
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	if (isProcessAlive(pid) === "gone") {
		return { kind: "gone" };
	}
	const identity =
		platform === "win32" ? await queryWindowsProcess(pid, runner) : await queryPosixProcess(pid, runner, now);
	if (identity) {
		return { kind: "found", identity };
	}
	// The process may have exited between the liveness probe and the query.
	// Otherwise its identity is unavailable and callers must fail closed.
	return isProcessAlive(pid) === "gone" ? { kind: "gone" } : { kind: "unknown" };
}

function processStartTimeMatches(startedAtMs: number, identity: ProcessIdentity, toleranceMs: number): boolean {
	return (
		identity.startTimeMs !== undefined &&
		startedAtMs > 0 &&
		Math.abs(identity.startTimeMs - startedAtMs) <= toleranceMs
	);
}

/**
 * Verify only process creation identity. Unlike pidfile verification, this
 * distinguishes a verifiable recycled PID from an unavailable OS query so
 * startup-lock recovery can reap the former while failing closed on the latter.
 */
export async function verifyProcessCreationTime(
	record: { pid: number; startedAtMs: number },
	options: VerifyPidfileOptions = {},
): Promise<ProcessCreationVerification> {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return "mismatch";
	}
	const lookup = await lookupProcessIdentity(record.pid, options);
	if (lookup.kind !== "found") {
		return lookup.kind;
	}
	if (record.startedAtMs <= 0 || lookup.identity.startTimeMs === undefined) {
		return "unknown";
	}
	const toleranceMs = options.toleranceMs ?? DEFAULT_START_TIME_TOLERANCE_MS;
	return processStartTimeMatches(record.startedAtMs, lookup.identity, toleranceMs) ? "match" : "mismatch";
}

/** Verify both process creation identity and the voltd command marker. */
export async function verifyVoltdProcessIdentity(
	record: { pid: number; startedAtMs: number },
	options: VerifyPidfileOptions = {},
): Promise<ProcessCreationVerification> {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return "mismatch";
	}
	const lookup = await lookupProcessIdentity(record.pid, options);
	if (lookup.kind !== "found") {
		return lookup.kind;
	}
	if (record.startedAtMs <= 0 || lookup.identity.startTimeMs === undefined) {
		return "unknown";
	}
	const toleranceMs = options.toleranceMs ?? DEFAULT_START_TIME_TOLERANCE_MS;
	if (!processStartTimeMatches(record.startedAtMs, lookup.identity, toleranceMs)) {
		return "mismatch";
	}
	// Matching creation evidence is conclusive enough to fail closed, but some
	// supported hosts (notably direct runVoltDaemon() calls on Windows) do not
	// expose a voltd marker in the immutable process command line.
	return commandLineLooksLikeVoltd(lookup.identity.commandLine) ? "match" : "unknown";
}

/**
 * Verify that pidfile.pid still refers to the daemon that wrote the pidfile.
 *
 * - "gone": no such process (or it exited mid-check) — safe to treat as stopped.
 * - "match": alive, start time within tolerance of startedAtMs, and a
 *   voltd-looking command line — safe to signal.
 * - "mismatch": alive but unverifiable or verifiably different (recycled pid,
 *   another user's process, ps/powershell unavailable) — do NOT signal.
 */
export async function verifyPidfileProcess(
	pidfile: Pick<PidfileContents, "pid" | "startedAtMs">,
	options: VerifyPidfileOptions = {},
): Promise<PidfileVerification> {
	if (!Number.isInteger(pidfile.pid) || pidfile.pid <= 0) {
		return "mismatch";
	}
	const lookup = await lookupProcessIdentity(pidfile.pid, options);
	if (lookup.kind === "gone") {
		return "gone";
	}
	if (lookup.kind === "unknown") {
		return "mismatch";
	}
	// A match REQUIRES verifying the process start time against the pidfile, not
	// just a voltd-looking command line. Without that check (a legacy pidfile
	// missing startedAtMs, or the OS not reporting a start time) a recycled pid
	// whose command line merely contains a voltd marker must not be signalled.
	const toleranceMs = options.toleranceMs ?? DEFAULT_START_TIME_TOLERANCE_MS;
	if (!processStartTimeMatches(pidfile.startedAtMs, lookup.identity, toleranceMs)) {
		return "mismatch";
	}
	return commandLineLooksLikeVoltd(lookup.identity.commandLine) ? "match" : "mismatch";
}
