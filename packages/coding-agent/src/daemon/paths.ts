import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/** Unix domain socket paths are capped around 104 (macOS) / 108 (Linux) bytes. */
const MAX_SOCKET_PATH_BYTES = 100;
const WINDOWS_CONTROL_SECRET_FILE = "control-secret.json";
const WINDOWS_CONTROL_SECRET_BYTES = 32;
const WINDOWS_PIPE_DIGEST_HEX_CHARS = 32;
const WINDOWS_PIPE_RANDOM_BYTES = 16;

interface WindowsControlSecret {
	pipeSecret: string;
}

/**
 * Node's net module has no filesystem unix sockets on Windows: a string path
 * passed to server.listen()/createConnection() is a named pipe, which must live
 * in the flat, machine-wide \\.\pipe\ namespace. A filesystem path such as
 * ...\daemon\voltd.sock makes CreateNamedPipe fail with EACCES. Derive the pipe
 * name from a per-agent secret so another local user cannot pre-create the
 * daemon's predictable endpoint before startup.
 */
function getWindowsNamedPipePath(agentDir: string): string {
	const secret = getOrCreateWindowsControlSecret(agentDir);
	const digest = createHash("sha256")
		.update(agentDir.toLowerCase())
		.update("\0")
		.update(secret.pipeSecret)
		.digest("hex")
		.slice(0, WINDOWS_PIPE_DIGEST_HEX_CHARS);
	return `\\\\.\\pipe\\voltd-${digest}`;
}

function createWindowsControlSecret(): WindowsControlSecret {
	return { pipeSecret: randomBytes(WINDOWS_CONTROL_SECRET_BYTES).toString("hex") };
}

function serializeWindowsControlSecret(secret: WindowsControlSecret): string {
	return `${JSON.stringify({ version: 1, pipeSecret: secret.pipeSecret })}\n`;
}

function isSecretHex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function readWindowsControlSecret(secretPath: string): WindowsControlSecret | undefined {
	try {
		const parsed = JSON.parse(readFileSync(secretPath, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const pipeSecret = (parsed as { pipeSecret?: unknown }).pipeSecret;
		return isSecretHex(pipeSecret) ? { pipeSecret: pipeSecret.toLowerCase() } : undefined;
	} catch {
		return undefined;
	}
}

function chmodControlSecret(secretPath: string): void {
	try {
		chmodSync(secretPath, 0o600);
	} catch {
		// Best effort: Windows ignores POSIX-style mode bits, but Unix-like test
		// environments and future runtimes still benefit from owner-only mode.
	}
}

function createWindowsControlSecretFile(secretPath: string): WindowsControlSecret {
	const secret = createWindowsControlSecret();
	try {
		writeFileSync(secretPath, serializeWindowsControlSecret(secret), { mode: 0o600, flag: "wx" });
		chmodControlSecret(secretPath);
		return secret;
	} catch (error) {
		if (isErrnoException(error) && error.code === "EEXIST") {
			const racedSecret = readWindowsControlSecret(secretPath);
			if (racedSecret) {
				return racedSecret;
			}
			return replaceWindowsControlSecretFile(secretPath);
		}
		throw error;
	}
}

function replaceWindowsControlSecretFile(secretPath: string): WindowsControlSecret {
	const secret = createWindowsControlSecret();
	const tempPath = join(
		dirname(secretPath),
		`.${WINDOWS_CONTROL_SECRET_FILE}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(tempPath, serializeWindowsControlSecret(secret), { mode: 0o600, flag: "wx" });
		chmodControlSecret(tempPath);
		renameSync(tempPath, secretPath);
		chmodControlSecret(secretPath);
		return secret;
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function getOrCreateWindowsControlSecret(agentDir: string): WindowsControlSecret {
	const secretPath = getDaemonControlSecretPath(agentDir);
	const existingSecret = readWindowsControlSecret(secretPath);
	if (existingSecret) {
		return existingSecret;
	}
	mkdirSync(getDaemonDir(agentDir), { recursive: true, mode: 0o700 });
	return createWindowsControlSecretFile(secretPath);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** True for Windows named-pipe socket paths (\\.\pipe\... or \\?\pipe\...). */
export function isWindowsNamedPipePath(socketPath: string): boolean {
	return /^\\\\[.?]\\pipe\\/.test(socketPath);
}

export interface DaemonPaths {
	daemonDir: string;
	socketPath: string;
	pidfilePath: string;
	lockDirPath: string;
	logPath: string;
	statePath: string;
	workStatePath: string;
	auditPath: string;
}

export function getDaemonDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon");
}

export function getDaemonControlSecretPath(agentDir: string = getAgentDir()): string {
	return join(getDaemonDir(agentDir), WINDOWS_CONTROL_SECRET_FILE);
}

export function rotateWindowsDaemonSocketSecret(agentDir: string = getAgentDir()): string {
	if (process.platform !== "win32") {
		return getDaemonSocketPath(agentDir);
	}
	mkdirSync(getDaemonDir(agentDir), { recursive: true, mode: 0o700 });
	replaceWindowsControlSecretFile(getDaemonControlSecretPath(agentDir));
	return getWindowsNamedPipePath(agentDir);
}

function getFallbackSocketPath(agentDir: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const scope = createHash("sha256").update(agentDir).digest("hex").slice(0, 32);
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (runtimeDir) {
		const runtimePath = join(runtimeDir, `voltd-${uid}-${scope}.sock`);
		if (Buffer.byteLength(runtimePath, "utf8") <= MAX_SOCKET_PATH_BYTES) {
			return runtimePath;
		}
	}
	return join(`/tmp/voltd-${uid}`, `voltd-${scope}.sock`);
}

/**
 * Actual daemon listen endpoint for a new instance. Windows named pipes cannot
 * be unlinked, so default daemons use a fresh pipe name and publish it through
 * the pidfile. POSIX keeps the stable socket path because stale files can be
 * removed from a private directory.
 */
export function createDaemonControlSocketPath(agentDir: string = getAgentDir()): string {
	if (process.platform !== "win32") {
		return getDaemonSocketPath(agentDir);
	}
	const scope = createHash("sha256").update(agentDir.toLowerCase()).digest("hex").slice(0, 16);
	return `\\\\.\\pipe\\voltd-${scope}-${randomBytes(WINDOWS_PIPE_RANDOM_BYTES).toString("hex")}`;
}

/**
 * Default socket path lives in the daemon dir; when the agent dir is nested
 * deep enough to overflow the platform socket-path limit, fall back to a
 * runtime dir. The actual path is recorded in the pidfile, which clients read
 * when the default probe fails.
 */
export function getDaemonSocketPath(agentDir: string = getAgentDir()): string {
	if (process.platform === "win32") {
		return getWindowsNamedPipePath(agentDir);
	}
	const defaultPath = join(getDaemonDir(agentDir), "voltd.sock");
	if (Buffer.byteLength(defaultPath, "utf8") <= MAX_SOCKET_PATH_BYTES) {
		return defaultPath;
	}
	return getFallbackSocketPath(agentDir);
}

export function getDaemonPaths(agentDir: string = getAgentDir()): DaemonPaths {
	const daemonDir = getDaemonDir(agentDir);
	return {
		daemonDir,
		socketPath: getDaemonSocketPath(agentDir),
		pidfilePath: join(daemonDir, "voltd.pid"),
		lockDirPath: join(daemonDir, "voltd.lock"),
		logPath: join(daemonDir, "voltd.log"),
		statePath: join(daemonDir, "state.json"),
		workStatePath: join(daemonDir, "work-state.json"),
		auditPath: join(daemonDir, "audit.jsonl"),
	};
}

/** Create the daemon dir (0700) and, for fallback sockets, the socket's parent dir. */
export function ensureDaemonDirs(paths: DaemonPaths): void {
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	// Named pipes have no parent directory on disk to create or harden.
	if (isWindowsNamedPipePath(paths.socketPath)) {
		return;
	}
	if (!paths.socketPath.startsWith(paths.daemonDir)) {
		const socketDir = dirname(paths.socketPath);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		assertPrivateSocketDir(socketDir);
	}
}

/**
 * The fallback socket dir lives under a shared parent (/tmp or
 * XDG_RUNTIME_DIR) at a predictable path, and mkdir with recursive silently
 * accepts a pre-existing directory without touching its mode. Verify the
 * directory is ours before placing the socket in it, and tighten loose
 * permissions on one we own.
 */
function assertPrivateSocketDir(dir: string): void {
	if (process.platform === "win32") {
		return;
	}
	const stats = lstatSync(dir);
	if (!stats.isDirectory()) {
		throw new Error(`voltd socket directory ${dir} is not a directory`);
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
	if (stats.uid !== uid) {
		throw new Error(`refusing to use voltd socket directory ${dir}: owned by uid ${stats.uid}, not ${uid}`);
	}
	if ((stats.mode & 0o077) !== 0) {
		chmodSync(dir, 0o700);
	}
}
