import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { getAgentDir, VERSION } from "../config.ts";
import { createDaemonClient } from "./control-client.ts";
import type { ControlKeepAwakeStatus, ControlResponse, RemoteTransportHealth } from "./control-protocol.ts";
import { createIrohDaemonService } from "./iroh-service.ts";
import { type PidfileContents, readPidfile, runVoltDaemon } from "./main.ts";
import { getDaemonPaths } from "./paths.ts";
import { verifyPidfileProcess } from "./process-identity.ts";
import { installDaemonService, uninstallDaemonService } from "./service-install.ts";
import {
	classifyPublishedDaemonGeneration,
	DAEMON_SHUTDOWN_TIMEOUT_MS,
	ensureDaemonRunning,
	probeDaemon,
	waitForDaemonExit,
} from "./spawn.ts";
import { inspectVoltdStateFiles, regenerateInvalidVoltdState } from "./state.ts";

const STOP_TIMEOUT_MS = DAEMON_SHUTDOWN_TIMEOUT_MS; // 60s drain cap + margin
const STOP_SIGNAL_GRACE_TIMEOUT_MS = 5_000;
const DEFAULT_LOG_TAIL_LINES = 200;

type StatusResult = ControlResponse & { type: "status_result" };

function printDaemonUsage(): void {
	console.error(`Usage: volt daemon <command>

Commands:
  start                 Start the background daemon (no-op if already running).
  stop                  Ask the daemon to shut down gracefully.
  status [--json]       Show daemon status; exit 0 only when phone transport is ready.
  restart               Stop then start; persistent state survives.
  regenerate-state      Back up invalid state and regenerate it after confirmation.
  keep-awake [on|off]   Prevent the host from sleeping while voltd runs; no arg prints state.
  logs [-f] [-n N]      Tail the daemon log (default ${DEFAULT_LOG_TAIL_LINES} lines).
  install-service       Register a login service (launchd/systemd) that starts the daemon.
  uninstall-service     Remove the login service.
  run --foreground      Run the daemon in this process (internal; used by start).
`);
}

async function requestStatus(agentDir: string): Promise<StatusResult | undefined> {
	const probe = await probeDaemon(agentDir);
	if (!probe.healthy) {
		return undefined;
	}
	const client = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: VERSION,
		authToken: probe.authToken,
		reconnect: false,
	});
	try {
		const statusProbe = await client.request({ type: "status" });
		return statusProbe.type === "status_result" ? statusProbe : undefined;
	} finally {
		await client.close();
	}
}

async function daemonStart(agentDir: string): Promise<void> {
	const result = await ensureDaemonRunning(agentDir);
	if (!result.healthy) {
		if (result.state === "protocol-mismatch") {
			console.error(
				"Error: a different voltd protocol version is already running; stop it before starting this version.",
			);
		} else if (result.state === "unresponsive") {
			console.error("Error: voltd socket is occupied but not responding; not starting a second daemon.");
		} else if (result.state === "auth-failed") {
			console.error("Error: voltd rejected the local daemon metadata; not starting a second daemon.");
		} else if (result.state === "shutting-down") {
			console.error("Error: existing voltd did not finish shutting down within the timeout.");
		} else {
			console.error(`Error: ${result.error ?? "failed to start voltd (daemon did not become healthy within 5s)."}`);
			if (result.invalidState) {
				console.error("Run `volt daemon regenerate-state` to review and confirm regeneration.");
			}
		}
		console.error(`Check the log: ${getDaemonPaths(agentDir).logPath}`);
		process.exitCode = 1;
		return;
	}
	console.error(
		`voltd ${result.version ?? VERSION} ${result.spawned ? "started" : "already running"} (pid ${result.pid})`,
	);
	console.error(`socket: ${result.socketPath}`);
}

export type DaemonStopSignalResult = "sent" | "refused" | "gone";
export type DaemonStopEscalationResult = "exited" | "refused" | "timeout";

/** Only ESRCH proves the captured pid disappeared; every other signal error fails closed. */
export function classifyDaemonSignalError(error: unknown): Exclude<DaemonStopSignalResult, "sent"> {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
		? "gone"
		: "refused";
}

export interface DaemonStopEscalationOptions {
	/** Whether shutdown has already been requested over a healthy control path. */
	gracefulShutdownRequested: boolean;
	gracefulTimeoutMs: number;
	signalGraceTimeoutMs: number;
	waitForExit(timeoutMs: number): Promise<"exited" | "timeout">;
	sendSignal(signal: "SIGTERM" | "SIGKILL"): Promise<DaemonStopSignalResult>;
}

/** Request one graceful drain, then TERM/short grace/KILL against the same daemon identity. */
export async function escalateDaemonExit(options: DaemonStopEscalationOptions): Promise<DaemonStopEscalationResult> {
	if (!options.gracefulShutdownRequested) {
		const gracefulSignalResult = await options.sendSignal("SIGTERM");
		if (gracefulSignalResult === "refused") {
			return "refused";
		}
		if (gracefulSignalResult === "gone") {
			return "exited";
		}
	}
	if ((await options.waitForExit(options.gracefulTimeoutMs)) === "exited") {
		return "exited";
	}
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const signalResult = await options.sendSignal(signal);
		if (signalResult === "refused") {
			return "refused";
		}
		if (signalResult === "gone") {
			return "exited";
		}
		if ((await options.waitForExit(options.signalGraceTimeoutMs)) === "exited") {
			return "exited";
		}
	}
	return "timeout";
}

/**
 * Signal the daemon identity captured before shutdown began. The published
 * generation and OS process identity are rechecked before each signal, failing
 * closed when either cannot be established. A process signal is not atomic
 * with these checks, so they narrow rather than eliminate the PID-reuse race.
 */
async function signalPidfileDaemon(
	pidfile: PidfileContents,
	pidfilePath: string,
	signal: "SIGTERM" | "SIGKILL",
	context: string,
): Promise<DaemonStopSignalResult> {
	const requireCurrentGeneration = (): DaemonStopSignalResult | undefined => {
		const generationState = classifyPublishedDaemonGeneration(pidfile, readPidfile(pidfilePath));
		if (generationState === "retired") {
			return "gone";
		}
		if (generationState === "unverifiable") {
			console.error(`Error: voltd pidfile generation is not verifiable; not sending ${signal}.`);
			process.exitCode = 1;
			return "refused";
		}
		return undefined;
	};
	const initialGenerationResult = requireCurrentGeneration();
	if (initialGenerationResult) {
		return initialGenerationResult;
	}
	const verification = await verifyPidfileProcess(pidfile);
	if (verification === "mismatch") {
		console.error(
			`Error: pid ${pidfile.pid} from the pidfile is not verifiable as voltd (recycled pid?); not sending ${signal}.`,
		);
		console.error(`Remove ${pidfilePath} if it is stale.`);
		process.exitCode = 1;
		return "refused";
	}
	if (verification === "gone") {
		return "gone";
	}
	const finalGenerationResult = requireCurrentGeneration();
	if (finalGenerationResult) {
		return finalGenerationResult;
	}
	try {
		process.kill(pidfile.pid, signal);
		console.error(`${context}; sent ${signal} to pid ${pidfile.pid}`);
		return "sent";
	} catch (error) {
		const result = classifyDaemonSignalError(error);
		if (result === "gone") {
			// Process exited between verification and signal.
			return result;
		}
		console.error(
			`Error: failed to send ${signal} to verified voltd pid ${pidfile.pid}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
		return result;
	}
}

async function daemonStop(agentDir: string): Promise<void> {
	const paths = getDaemonPaths(agentDir);
	const probe = await probeDaemon(agentDir);
	const pidfile = readPidfile(paths.pidfilePath);
	if (!probe.healthy && probe.state === "not-running" && !pidfile) {
		console.error("voltd is not running");
		return;
	}

	if (probe.healthy) {
		const client = createDaemonClient({
			socketPath: probe.socketPath,
			client: "cli",
			version: VERSION,
			authToken: probe.authToken,
			reconnect: false,
		});
		try {
			await client.request({ type: "shutdown" });
		} catch {
			// The daemon may close the socket before the ok lands; fall through to the poll.
		} finally {
			await client.close();
		}
	} else if (probe.state === "shutting-down") {
		console.error("voltd is already draining; waiting for exit");
	}

	const target: PidfileContents | undefined =
		probe.healthy && probe.pid !== undefined && probe.startedAtMs !== undefined
			? {
					pid: probe.pid,
					version: probe.version ?? VERSION,
					startedAtMs: probe.startedAtMs,
					socketPath: probe.socketPath,
					...(probe.authToken === undefined ? {} : { token: probe.authToken }),
				}
			: pidfile;
	const result = await escalateDaemonExit({
		gracefulShutdownRequested: probe.healthy || probe.state === "shutting-down",
		gracefulTimeoutMs: STOP_TIMEOUT_MS,
		signalGraceTimeoutMs: STOP_SIGNAL_GRACE_TIMEOUT_MS,
		waitForExit: (timeoutMs) =>
			waitForDaemonExit({
				agentDir,
				pid: target?.pid,
				pidfile: target,
				socketPath: probe.socketPath,
				timeoutMs,
			}),
		sendSignal: async (signal) => {
			if (!target) {
				console.error(`Error: voltd has no verifiable process identity; not sending ${signal}.`);
				process.exitCode = 1;
				return "refused";
			}
			return signalPidfileDaemon(
				target,
				paths.pidfilePath,
				signal,
				signal === "SIGTERM" ? "voltd did not stop gracefully" : "voltd did not stop after SIGTERM",
			);
		},
	});
	if (result === "exited") {
		console.error("voltd stopped");
		return;
	}
	if (result === "refused") {
		return;
	}
	console.error("Error: voltd did not stop after SIGKILL");
	process.exitCode = 1;
}

function formatKeepAwake(keepAwake: ControlKeepAwakeStatus | undefined): string {
	// Older daemons predate the field; report that instead of guessing "off".
	if (!keepAwake) {
		return "unknown (daemon predates keep-awake)";
	}
	if (!keepAwake.enabled) {
		return "off";
	}
	return keepAwake.state === "active" ? "on (active)" : `on (degraded: ${keepAwake.reason ?? "unknown"})`;
}

function formatRemoteTransport(health: RemoteTransportHealth | undefined): string {
	if (!health) return "unavailable (status missing from daemon)";
	const version = health.wrapperVersion === undefined ? "" : ` · wrapper ${health.wrapperVersion}`;
	const reason = health.reasonCode === undefined ? "" : ` · ${health.reasonCode}`;
	return `${health.state}${version}${reason}`;
}

function formatUptime(startedAtMs: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}h${minutes}m${seconds}s` : minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

async function daemonStatus(agentDir: string, json: boolean): Promise<void> {
	const status = await requestStatus(agentDir);
	if (!status) {
		if (json) {
			console.log(JSON.stringify({ running: false }));
		} else {
			console.error("voltd is not running");
		}
		process.exitCode = 1;
		return;
	}
	if (json) {
		console.log(JSON.stringify({ running: true, ...status, id: undefined, type: undefined }));
		if (status.remoteTransport?.state !== "ready") process.exitCode = 1;
		return;
	}
	console.error(`voltd ${status.version} (protocol ${status.protocolVersion})`);
	console.error(`pid: ${status.pid}`);
	console.error(`uptime: ${formatUptime(status.startedAtMs)}`);
	console.error(`keep awake: ${formatKeepAwake(status.keepAwake)}`);
	console.error(`remote transport: ${formatRemoteTransport(status.remoteTransport)}`);
	if (status.remoteTransport?.message) console.error(`  ${status.remoteTransport.message}`);
	console.error(`phone connections: ${status.phoneConnections}`);
	console.error(`workspaces: ${status.workspaces.length}`);
	for (const workspace of status.workspaces) {
		console.error(`  ${workspace.name} -> ${workspace.path}`);
	}
	console.error(`paired clients: ${status.clients.length}`);
	for (const client of status.clients) {
		console.error(`  ${client.clientNodeId}${client.label ? ` (${client.label})` : ""}`);
	}
	console.error(`leases: ${status.leases.length}`);
	for (const lease of status.leases) {
		console.error(
			`  ${lease.workspaceName}/${lease.sessionId}: ${lease.state} (streams ${lease.streamCount}, relays ${lease.relayCount})`,
		);
	}
	if (status.remoteTransport?.state !== "ready") process.exitCode = 1;
}

async function daemonKeepAwake(agentDir: string, args: string[]): Promise<void> {
	const mode = args[0];
	if (mode !== undefined && mode !== "on" && mode !== "off" && mode !== "status") {
		console.error("Error: volt daemon keep-awake takes on, off, or no argument");
		process.exitCode = 1;
		return;
	}
	if (mode === undefined || mode === "status") {
		const status = await requestStatus(agentDir);
		if (!status) {
			console.error("voltd is not running");
			process.exitCode = 1;
			return;
		}
		console.error(`keep awake: ${formatKeepAwake(status.keepAwake)}`);
		return;
	}
	const probe = await probeDaemon(agentDir);
	if (!probe.healthy) {
		console.error("voltd is not running");
		process.exitCode = 1;
		return;
	}
	const client = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: VERSION,
		authToken: probe.authToken,
		reconnect: false,
	});
	try {
		const response = await client.request({ type: "keep_awake_set", enabled: mode === "on" });
		if (response.type === "error") {
			console.error(`Error: ${response.message}`);
			process.exitCode = 1;
			return;
		}
		if (response.type !== "keep_awake_result") {
			console.error("Error: this voltd version does not support keep-awake; restart the daemon after upgrading");
			process.exitCode = 1;
			return;
		}
		console.error(`keep awake: ${formatKeepAwake(response.keepAwake)}`);
		if (response.keepAwake.enabled && response.keepAwake.state === "degraded") {
			process.exitCode = 1;
		}
	} finally {
		await client.close();
	}
}

function tailLines(content: string, count: number): string[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines.slice(-count);
}

async function promptConfirm(message: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	return new Promise((resolve) => {
		const readline = createInterface({ input: process.stdin, output: process.stdout });
		readline.question(`${message} [y/N] `, (answer) => {
			readline.close();
			resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
		});
	});
}

async function daemonRegenerateState(agentDir: string): Promise<void> {
	const probe = await probeDaemon(agentDir);
	if (probe.healthy || probe.state !== "not-running") {
		console.error(`Error: voltd must be fully stopped before regenerating state (currently ${probe.state}).`);
		process.exitCode = 1;
		return;
	}
	const invalidState = inspectVoltdStateFiles(agentDir);
	if (!invalidState) {
		console.error("Daemon state is valid; regeneration is not needed.");
		return;
	}
	console.error(invalidState.error);
	console.error("Regeneration preserves validated identity/settings when safe and drops invalid access records.");
	console.error("If the identity cannot be preserved, all phones will need to pair again.");
	if (!(await promptConfirm("Back up the invalid file and regenerate daemon state?"))) {
		console.error("Daemon state was not changed.");
		process.exitCode = 1;
		return;
	}
	const { backupPath, preservedIdentity } = await regenerateInvalidVoltdState(agentDir);
	console.error(`Backed up invalid daemon state to ${backupPath}`);
	console.error(preservedIdentity ? "Preserved the Iroh identity." : "A new Iroh identity will be created.");
	console.error("Run `volt daemon start` to create fresh state.");
}

async function daemonLogs(agentDir: string, args: string[]): Promise<void> {
	const paths = getDaemonPaths(agentDir);
	const follow = args.includes("-f") || args.includes("--follow");
	let lineCount = DEFAULT_LOG_TAIL_LINES;
	const nIndex = args.indexOf("-n");
	if (nIndex !== -1) {
		const parsed = Number(args[nIndex + 1]);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			console.error("Error: -n requires a positive integer");
			process.exitCode = 1;
			return;
		}
		lineCount = parsed;
	}
	if (!existsSync(paths.logPath)) {
		console.error(`No daemon log at ${paths.logPath}`);
		process.exitCode = 1;
		return;
	}
	for (const line of tailLines(readFileSync(paths.logPath, "utf8"), lineCount)) {
		console.log(line);
	}
	if (!follow) {
		return;
	}
	let offset = statSync(paths.logPath).size;
	while (true) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		let size: number;
		try {
			size = statSync(paths.logPath).size;
		} catch {
			continue;
		}
		if (size < offset) {
			offset = 0; // rotated
		}
		if (size === offset) {
			continue;
		}
		const handle = await open(paths.logPath, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - offset), 0, size - offset, offset);
			process.stdout.write(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		} finally {
			await handle.close();
		}
	}
}

export interface DaemonCommandOptions {
	agentDir?: string;
	/** Standalone releases omit the native Iroh adapter. */
	isStandaloneBinary: boolean;
}

/** Router for `volt daemon <command>`; returns true when the args were handled. */
export async function handleDaemonCommand(args: string[], options: DaemonCommandOptions): Promise<boolean> {
	if (args[0] !== "daemon") {
		return false;
	}
	const command = args[1];
	if (command === undefined || command === "--help" || command === "-h") {
		printDaemonUsage();
		return true;
	}
	if (options.isStandaloneBinary) {
		console.error("Error: volt daemon is not available from the standalone binary release.");
		console.error(
			"Use a Node.js npm install or source checkout with the required Iroh wrapper and optional platform binding.",
		);
		process.exitCode = 1;
		return true;
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const rest = args.slice(2);

	switch (command) {
		case "start":
			await daemonStart(agentDir);
			return true;
		case "stop":
			await daemonStop(agentDir);
			return true;
		case "status":
			await daemonStatus(agentDir, rest.includes("--json"));
			return true;
		case "restart":
			await daemonStop(agentDir);
			if ((process.exitCode ?? 0) === 0) {
				await daemonStart(agentDir);
			}
			return true;
		case "regenerate-state":
			await daemonRegenerateState(agentDir);
			return true;
		case "keep-awake":
			await daemonKeepAwake(agentDir, rest);
			return true;
		case "logs":
			await daemonLogs(agentDir, rest);
			return true;
		case "install-service": {
			const result = await installDaemonService({ agentDir });
			for (const message of result.messages) {
				console.error(message);
			}
			if (!result.ok) {
				process.exitCode = 1;
			}
			return true;
		}
		case "uninstall-service": {
			const result = await uninstallDaemonService({ agentDir });
			for (const message of result.messages) {
				console.error(message);
			}
			if (!result.ok) {
				process.exitCode = 1;
			}
			return true;
		}
		case "run": {
			if (!rest.includes("--foreground")) {
				console.error("Error: volt daemon run requires --foreground");
				process.exitCode = 1;
				return true;
			}
			const code = await runVoltDaemon({ agentDir, foreground: true }, [createIrohDaemonService()]);
			// The run loop resolves after durable quiescing and bounded native disposal, but
			// the native iroh handle can keep the event loop alive afterwards (notably
			// on Windows), leaving a zombie that clients still probe as "draining".
			// Exit deterministically now that teardown is complete.
			process.exit(code);
			return true;
		}
		default:
			console.error(`Error: Unknown daemon command: ${command}`);
			printDaemonUsage();
			process.exitCode = 1;
			return true;
	}
}
