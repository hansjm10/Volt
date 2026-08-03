import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir, getPackageDir, VERSION } from "../config.ts";
import { type ControlSocketProbe, probeControlSocket } from "./control-server.ts";
import { type PidfileContents, readPidfile } from "./main.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "./paths.ts";
import { verifyPidfileProcess } from "./process-identity.ts";
import { type InvalidVoltdStateFile, inspectVoltdStateFiles } from "./state.ts";

const SPAWN_HEALTH_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
const SPAWN_HEALTH_POLL_MS = 100;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 75_000;
const DAEMON_EXIT_POLL_MS = 200;

export type DaemonProbeState =
	| "healthy"
	| "shutting-down"
	| "protocol-mismatch"
	| "auth-failed"
	| "unresponsive"
	| "not-running";

export interface DaemonProbeResult {
	healthy: boolean;
	state: DaemonProbeState;
	pid?: number;
	version?: string;
	protocolVersion?: number;
	startedAtMs?: number;
	socketPath: string;
	authToken?: string;
}

function daemonProbeFromSocketProbe(
	socketPath: string,
	probe: ControlSocketProbe,
	authToken: string | undefined,
): DaemonProbeResult {
	if (probe.kind === "healthy") {
		return {
			healthy: true,
			state: "healthy",
			pid: probe.status.pid,
			version: probe.status.version,
			protocolVersion: probe.status.protocolVersion,
			startedAtMs: probe.status.startedAtMs,
			socketPath,
			...(authToken === undefined ? {} : { authToken }),
		};
	}
	if (probe.kind === "live-rejected") {
		const state: DaemonProbeState =
			probe.reason === "protocol_mismatch"
				? "protocol-mismatch"
				: probe.reason === "auth_failed"
					? "auth-failed"
					: probe.reason === "shutting_down"
						? "shutting-down"
						: "unresponsive";
		return {
			healthy: false,
			state,
			...(probe.version === undefined ? {} : { version: probe.version }),
			...(probe.protocolVersion === undefined ? {} : { protocolVersion: probe.protocolVersion }),
			socketPath,
			...(authToken === undefined ? {} : { authToken }),
		};
	}
	if (probe.kind === "unresponsive") {
		return { healthy: false, state: "unresponsive", socketPath, ...(authToken === undefined ? {} : { authToken }) };
	}
	return { healthy: false, state: "not-running", socketPath, ...(authToken === undefined ? {} : { authToken }) };
}

/**
 * Probe the pidfile-published daemon endpoint first, then fall back to the
 * legacy default socket path for older daemons and pre-start diagnostics.
 */
export async function probeDaemon(agentDir: string = getAgentDir()): Promise<DaemonProbeResult> {
	const paths = getDaemonPaths(agentDir);
	const pidfile = readPidfile(paths.pidfilePath);
	if (pidfile) {
		const pidfileProbe = await probeControlSocket(pidfile.socketPath, {
			version: VERSION,
			...(pidfile.token === undefined ? {} : { authToken: pidfile.token }),
		});
		const pidfileResult = daemonProbeFromSocketProbe(pidfile.socketPath, pidfileProbe, pidfile.token);
		if (pidfileResult.state !== "not-running") {
			return pidfileResult;
		}
	}
	const probe = await probeControlSocket(paths.socketPath, { version: VERSION });
	const result = daemonProbeFromSocketProbe(paths.socketPath, probe, undefined);
	if (result.state !== "not-running") {
		return result;
	}
	return { healthy: false, state: "not-running", socketPath: paths.socketPath };
}

export function resolveDaemonCliInvocation(): { nodeArgs: string[]; entry: string } {
	const packageDir = getPackageDir();
	const sourceEntry = join(packageDir, "src", "cli.ts");
	if (existsSync(sourceEntry)) {
		return { nodeArgs: ["--conditions", "volt-source"], entry: sourceEntry };
	}
	return { nodeArgs: [], entry: join(packageDir, "dist", "cli.js") };
}

export interface SpawnDaemonResult {
	ok: boolean;
	pid?: number;
	socketPath: string;
	error?: string;
}

export interface PublishedDaemonEndpoint {
	socketPath: string;
	authToken?: string;
}

/** Read the latest complete pidfile endpoint without probing or auto-starting. */
export function readPublishedDaemonEndpoint(agentDir: string = getAgentDir()): PublishedDaemonEndpoint | undefined {
	const pidfile = readPidfile(getDaemonPaths(agentDir).pidfilePath);
	if (!pidfile) {
		return undefined;
	}
	return {
		socketPath: pidfile.socketPath,
		...(pidfile.token === undefined ? {} : { authToken: pidfile.token }),
	};
}

export interface WaitForDaemonExitOptions {
	agentDir?: string;
	pid?: number;
	pidfile?: PidfileContents;
	socketPath?: string;
	timeoutMs?: number;
}

export type PublishedDaemonGenerationState = "current" | "retired" | "unverifiable";

/** Compare a captured daemon generation with the generation currently published on disk. */
export function classifyPublishedDaemonGeneration(
	target: PidfileContents,
	current: PidfileContents | undefined,
): PublishedDaemonGenerationState {
	if (!current) {
		return "unverifiable";
	}
	if (!target.token || !current.token) {
		return "unverifiable";
	}
	if (target.token !== current.token) {
		return "retired";
	}
	return target.pid === current.pid &&
		target.startedAtMs === current.startedAtMs &&
		target.socketPath === current.socketPath
		? "current"
		: "unverifiable";
}

function processIsGone(pid: number | undefined): boolean {
	if (!pid || pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM");
	}
}

export async function waitForDaemonExit(options: WaitForDaemonExitOptions = {}): Promise<"exited" | "timeout"> {
	const agentDir = options.agentDir ?? getAgentDir();
	const paths = getDaemonPaths(agentDir);
	const deadline = Date.now() + (options.timeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS);
	const targetPid = options.pid ?? options.pidfile?.pid;
	const socketPath = options.socketPath ?? options.pidfile?.socketPath ?? paths.socketPath;
	while (Date.now() < deadline) {
		if (
			options.pidfile &&
			classifyPublishedDaemonGeneration(options.pidfile, readPidfile(paths.pidfilePath)) === "retired"
		) {
			return "exited";
		}
		const socketProbe = await probeControlSocket(socketPath, {
			version: VERSION,
			timeoutMs: 500,
			...(options.pidfile?.token === undefined ? {} : { authToken: options.pidfile.token }),
		});
		if (processIsGone(targetPid) && socketProbe.kind === "no-listener") {
			return "exited";
		}
		await new Promise((resolve) => setTimeout(resolve, DAEMON_EXIT_POLL_MS));
	}
	return "timeout";
}

/** Spawn a detached daemon and wait (up to 5s) for the socket to answer a status probe. */
export async function spawnDetachedDaemon(agentDir: string = getAgentDir()): Promise<SpawnDaemonResult> {
	const paths: DaemonPaths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const { nodeArgs, entry } = resolveDaemonCliInvocation();
	const logFd = openSync(paths.logPath, "a", 0o600);
	const child = spawn(process.execPath, [...nodeArgs, entry, "daemon", "run", "--foreground"], {
		detached: true,
		windowsHide: true,
		stdio: ["ignore", logFd, logFd],
		cwd: agentDir,
		env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
	});
	// An unhandled "error" event would crash the calling CLI process; capture it
	// and surface it through the health-wait result instead.
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	child.unref();
	// The child received duplicated descriptors at spawn; close the parent copy.
	closeSync(logFd);

	const deadline = Date.now() + SPAWN_HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (spawnError) {
			return { ok: false, socketPath: paths.socketPath, error: `failed to spawn voltd: ${spawnError.message}` };
		}
		const probe = await probeDaemon(agentDir);
		if (probe.healthy) {
			return { ok: true, pid: probe.pid, socketPath: probe.socketPath };
		}
		await new Promise((resolve) => setTimeout(resolve, SPAWN_HEALTH_POLL_MS));
	}
	return { ok: false, socketPath: paths.socketPath, error: "daemon did not become healthy within 5s" };
}

export interface EnsureDaemonResult extends DaemonProbeResult {
	spawned: boolean;
	error?: string;
	invalidState?: InvalidVoltdStateFile;
}

/** Probe the socket; if no healthy daemon answers, spawn one detached. */
export async function ensureDaemonRunning(agentDir: string = getAgentDir()): Promise<EnsureDaemonResult> {
	let probe = await probeDaemon(agentDir);
	if (probe.healthy) {
		return { ...probe, spawned: false };
	}
	if (probe.state === "protocol-mismatch" || probe.state === "auth-failed") {
		return { ...probe, spawned: false };
	}
	if (probe.state === "unresponsive") {
		const paths = getDaemonPaths(agentDir);
		const pidfile = readPidfile(paths.pidfilePath);
		if (pidfile?.socketPath === probe.socketPath && (await verifyPidfileProcess(pidfile)) === "match") {
			return { ...probe, spawned: false };
		}
	}
	if (probe.state === "shutting-down") {
		await waitForDaemonExit({ agentDir, socketPath: probe.socketPath });
		probe = await probeDaemon(agentDir);
		if (probe.state !== "not-running") {
			return { ...probe, spawned: false };
		}
	}
	const invalidState = inspectVoltdStateFiles(agentDir);
	if (invalidState) {
		return {
			healthy: false,
			state: "not-running",
			socketPath: probe.socketPath,
			spawned: false,
			error: invalidState.error,
			invalidState,
		};
	}
	const spawned = await spawnDetachedDaemon(agentDir);
	if (!spawned.ok) {
		return {
			healthy: false,
			state: "not-running",
			socketPath: spawned.socketPath,
			spawned: true,
			...(spawned.error === undefined ? {} : { error: spawned.error }),
		};
	}
	const healthyProbe = await probeDaemon(agentDir);
	return { ...healthyProbe, spawned: true };
}
