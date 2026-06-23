import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { connect as connectNet, createServer } from "node:net";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import {
	createIrohRemoteHandshakeFailure,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	encodeIrohRemoteTicketPayload,
	formatIrohRemoteTicketQrCode,
	getIrohRemoteControlPath,
	getIrohRemoteRpcFilterResult,
	getIrohRemoteUnsafeAllowedTools,
	IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE,
	IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
	getAgentDir,
	IROH_REMOTE_ALPN,
	IrohRemoteAuditLogger,
	IrohRemoteHostEngine,
	IrohRemoteHostStateManager,
	parseIrohRemoteWorkspaceSpec,
	parseIrohRemoteControlRequest,
	pipeIrohRemoteOutboundJsonlReadable,
	readIrohRemoteHostState,
	requestIrohRemoteActiveRevocation,
	sanitizeIrohRemoteOutboundJsonLine,
	selectIrohRemoteWorkspace,
	serializeIrohRemoteRpcFilterRejection,
	writeIrohRemoteHandshakeResponse,
	writeIrohRemoteHostState,
	createIrohRemoteAgentRuntimeWithSessionSelection,
	parseIntegratedDetachedRuntimeTtlMs,
	runIrohRemoteRpcMode,
	scheduleDetachedRuntimeRetention,
} from "@earendil-works/volt-coding-agent";
import nativeAdapter from "./iroh-native-adapter.cjs";

const { loadIroh } = nativeAdapter;
let Endpoint;
let EndpointTicket;
let RelayMode;
let presetMinimal;
let presetN0;
const HOST_ENTRYPOINT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HOST_ENTRYPOINT_DIR, "..", "..");
const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const CONTROL_REQUEST_MAX_BYTES = 16 * 1024;
const DEFAULT_READ_LIMIT = 64 * 1024;
const DEFAULT_STATE_PATH = join(getAgentDir(), "remote", "iroh-host.json");
const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const PROMPT_COMPLETION_RPC_TYPES = new Set(["prompt", "steer", "follow_up"]);
const RESPONSE_COMPLETION_RPC_TYPES = new Set([
	"abort",
	"new_session",
	"get_state",
	"get_transcript",
	"list_sessions",
	"switch_session_by_id",
]);
const PROMPT_COMPLETION_SETTLE_MS = 100;
const BOOLEAN_FLAGS = new Set([
	"approve",
	"help",
	"integrated-volt",
	"mobile",
	"no-pairing",
	"once",
	"register-workspace",
	"use-volt",
	"yes",
]);
const VALUE_FLAGS = new Set([
	"agent-dir",
	"allow-tools",
	"audit",
	"detached-runtime-ttl-ms",
	"profile",
	"relay",
	"source-volt",
	"state",
	"volt-bin",
	"workspace",
]);
function parseFlags(argv) {
	const flags = new Map();
	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const equalsIndex = arg.indexOf("=");
		if (equalsIndex !== -1) {
			const name = arg.slice(2, equalsIndex);
			const value = arg.slice(equalsIndex + 1);
			if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
				throw new Error(`Unknown option: --${name}`);
			}
			if (VALUE_FLAGS.has(name) && value.length === 0) {
				throw new Error(`--${name} requires a value`);
			}
			flags.set(name, value);
			continue;
		}

		const name = arg.slice(2);
		if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
			throw new Error(`Unknown option: --${name}`);
		}
		if (BOOLEAN_FLAGS.has(name)) {
			flags.set(name, "true");
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(name, next);
			index += 1;
			continue;
		}

		throw new Error(`--${name} requires a value`);
	}

	return { flags, positionals };
}

function getFlag(flags, name, fallback) {
	return flags.get(name) ?? fallback;
}

function hasFlag(flags, name) {
	return flags.has(name) && flags.get(name) !== "false";
}

async function writeNodeStream(writable, chunk) {
	if (writable.write(chunk)) return;
	await once(writable, "drain");
}

async function readLineFromIroh(recv, initial = Buffer.alloc(0), options = {}) {
	const maxLineBytes = options.maxLineBytes;
	const readLimit = Math.min(DEFAULT_READ_LIMIT, maxLineBytes === undefined ? DEFAULT_READ_LIMIT : maxLineBytes + 1);
	let buffer = Buffer.from(initial);

	while (true) {
		const newlineIndex = buffer.indexOf(10);
		if (newlineIndex !== -1) {
			let lineBuffer = buffer.subarray(0, newlineIndex);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			if (maxLineBytes !== undefined && lineBuffer.length > maxLineBytes) {
				throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
			}
			return {
				line: lineBuffer.toString("utf8"),
				rest: buffer.subarray(newlineIndex + 1),
			};
		}

		if (maxLineBytes !== undefined && buffer.length > maxLineBytes) {
			throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
		}

		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: buffer };
		}
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	}
}

function formatIrohLoadError(error) {
	const detail = error instanceof Error ? error.message : error ? String(error) : "unknown native adapter error";
	return [
		"The optional @number0/iroh native adapter is not available.",
		`Native adapter error: ${detail}`,
		"Install Volt with optional dependencies enabled for this platform, then retry `volt remote host`.",
		"If optional dependencies were omitted, reinstall without `--omit=optional`.",
	].join("\n");
}

function ensureIrohAvailable() {
	const { iroh, irohLoadError } = loadIroh();
	if (!iroh) {
		throw new Error(formatIrohLoadError(irohLoadError));
	}
	({ Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh);
}

function printUsage() {
	console.error(`Usage: volt remote host [serve] [options]
       volt remote host --register-workspace [path|name=path] [options]
       volt remote clients [options]
       volt remote revoke <node-id> [options]
       volt remote approve-repair <node-id> [options]

Serve options:
  --workspace <name=path>    Workspace exposed to the client. Defaults to saved workspace or cwd.
  --register-workspace       Register cwd, path, or name=path in host state and exit.
  --mobile                   Mobile-facing host mode. Defaults relay to default and skips startup pairing.
  --relay <disabled|default> Iroh relay preset. Defaults to disabled, or default with --mobile.
  --state <path>             Host state path. Defaults to ~/.volt/agent/remote/iroh-host.json.
  --audit <path>             Host audit JSONL path. Defaults to <state>.audit.jsonl.
  --use-volt                 Spawn volt --mode rpc instead of the fake RPC child.
  --source-volt <repo-root>  Spawn Volt from a source checkout. Implies --use-volt.
  --integrated-volt          Run Volt's runtime in-process over Iroh.
  --volt-bin <path>          Volt executable for --use-volt. Defaults to volt.
  --allow-tools <list>       Tool allowlist passed to Volt. Defaults to read,bash,edit,write,grep,find,ls.
                              bash, edit, or write can modify host state and require confirmation.
  --profile <name>           Volt settings profile for integrated Volt runtime.
  --agent-dir <path>         Volt agent config directory for integrated Volt runtime.
  --detached-runtime-ttl-ms <ms>
                              Retain idle detached integrated runtimes for this many milliseconds. Defaults to 30 minutes.
  --approve                  Trust project-local Volt settings/resources for integrated Volt runtime.
  --no-pairing               Reject unpaired clients and print a paired-client ticket.
  --once                     Exit after the first client disconnects.
  --yes                      Accept unsafe remote tool grants for noninteractive startup.

Client management:
  clients                    Print paired clients from state.
  revoke <node-id>           Remove a paired client from state.
  approve-repair <node-id>   Allow a revoked client node ID to re-pair.
`);
}

async function withStateFileLock(statePath, operation) {
	await mkdir(dirname(statePath), { recursive: true });
	let release;
	let lockCompromised = false;
	let lockCompromisedError;
	const throwIfCompromised = () => {
		if (lockCompromised) {
			throw lockCompromisedError ?? new Error("Iroh remote host state lock was compromised");
		}
	};

	try {
		release = await lockfile.lock(statePath, {
			lockfilePath: `${statePath}.lock`,
			realpath: false,
			retries: {
				retries: 10,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 10000,
				randomize: true,
			},
			stale: 30000,
			onCompromised: (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			},
		});

		throwIfCompromised();
		const result = await operation();
		throwIfCompromised();
		return result;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Ignore unlock errors after a compromised lock.
			}
		}
	}
}

function syncState(target, source) {
	target.hostSecretKey = source.hostSecretKey;
	target.pairingSecretTombstones = source.pairingSecretTombstones ?? [];
	target.workspaces = source.workspaces ?? [];
	target.clients = source.clients ?? [];
	target.revokedClients = source.revokedClients ?? [];
	target.pendingPairingTickets = source.pendingPairingTickets ?? [];
}

function getDefaultAuditPath(statePath) {
	return statePath.endsWith(".json")
		? `${statePath.slice(0, -".json".length)}.audit.jsonl`
		: `${statePath}.audit.jsonl`;
}

function createAuditLogger(flags, statePath) {
	const auditPath = resolve(getFlag(flags, "audit", getDefaultAuditPath(statePath)));
	return { auditLogger: new IrohRemoteAuditLogger({ path: auditPath }), auditPath };
}

async function logAudit(auditLogger, event) {
	try {
		await auditLogger.log(event);
	} catch {
		// Audit logging is best-effort and must not change remote runtime behavior.
	}
}

function formatUnsafeToolWarning(unsafeTools) {
	const formattedTools = unsafeTools.join(", ");
	return [
		`Unsafe remote tools requested: ${formattedTools}.`,
		"These tools can modify files or run shell commands on the host through a paired remote client.",
	].join("\n");
}

async function confirmUnsafeRemoteToolGrant(options) {
	const unsafeTools = getIrohRemoteUnsafeAllowedTools(options.allowTools);
	if (unsafeTools.length === 0) return;

	const warning = formatUnsafeToolWarning(unsafeTools);
	let approval = "yes_flag";
	if (!options.yes) {
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			throw new Error(`${warning}\nPass --yes to accept unsafe remote tool grants in noninteractive contexts.`);
		}
		const readline = createInterface({ input: process.stdin, output: process.stderr });
		let answer;
		try {
			answer = await readline.question(`${warning}\nType yes to continue: `);
		} finally {
			readline.close();
		}
		if (answer.trim().toLowerCase() !== "yes") {
			throw new Error("Unsafe remote tool grant was not accepted.");
		}
		approval = "tty_confirmation";
	}

	await logAudit(options.auditLogger, {
		type: "unsafe_tools_enabled",
		workspace: options.workspaceName,
		success: true,
		details: {
			allowTools: options.allowTools,
			approval,
			context: options.context,
			unsafeTools,
		},
	});
}

async function assertWorkspaceDirectory(workspace) {
	let workspaceStat;
	try {
		workspaceStat = await stat(workspace.path);
	} catch (error) {
		if (error && error.code === "ENOENT") {
			throw new Error(`Workspace path does not exist: ${workspace.path}`);
		}
		throw error;
	}
	if (!workspaceStat.isDirectory()) {
		throw new Error(`Workspace path is not a directory: ${workspace.path}`);
	}
	workspace.path = await realpath(workspace.path);
}

async function isWorkspaceDirectoryAvailable(workspace) {
	try {
		const workspaceStat = await stat(workspace.path);
		return workspaceStat.isDirectory();
	} catch {
		return false;
	}
}

function getRegisterWorkspacePositionals(positionals) {
	return positionals[0] === "serve" ? positionals.slice(1) : positionals;
}

function getRegisterWorkspaceSpec(flags, positionals) {
	const registerPositionals = getRegisterWorkspacePositionals(positionals);
	if (registerPositionals.length > 1) {
		throw new Error(`Unexpected workspace registration argument: ${registerPositionals[1]}`);
	}

	const workspaceFlag = getFlag(flags, "workspace");
	if (registerPositionals.length === 1 && workspaceFlag !== undefined) {
		throw new Error("Workspace registration accepts either a positional workspace spec or --workspace, not both");
	}
	return registerPositionals[0] ?? workspaceFlag;
}

async function registerWorkspace(flags, positionals) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const spec = getRegisterWorkspaceSpec(flags, positionals);
	const workspace = parseIrohRemoteWorkspaceSpec(spec, process.cwd());
	const useRealpathBasename = spec === undefined || !spec.includes("=");
	await assertWorkspaceDirectory(workspace);
	if (useRealpathBasename) {
		workspace.name = basename(workspace.path) || "workspace";
	}

	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const savedWorkspace = await stateManager.upsertWorkspace(workspace, getFlag(flags, "allow-tools"));
	console.error(`registered workspace: ${savedWorkspace.name} -> ${savedWorkspace.path}`);
}

function getPlatformVoltBin(voltBin) {
	return process.platform === "win32" && voltBin === "volt" ? "volt.cmd" : voltBin;
}

function isPathCommand(command) {
	return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function getExecutableCandidates(command) {
	if (process.platform !== "win32") return [command];

	const lowerCommand = command.toLowerCase();
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension.length > 0);
	if (extensions.some((extension) => lowerCommand.endsWith(extension.toLowerCase()))) {
		return [command];
	}
	return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function isExecutable(path) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findExecutable(command) {
	const candidates = getExecutableCandidates(command);
	if (isPathCommand(command)) {
		for (const candidate of candidates) {
			const candidatePath = isAbsolute(candidate) ? candidate : resolve(candidate);
			if (await isExecutable(candidatePath)) return candidatePath;
		}
		return undefined;
	}

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
	for (const pathEntry of pathEntries) {
		for (const candidate of candidates) {
			const candidatePath = join(pathEntry, candidate);
			if (await isExecutable(candidatePath)) return candidatePath;
		}
	}
	return undefined;
}

function sourceCheckoutVoltBinHint(workspace) {
	if (process.platform === "win32") {
		return "If testing a source checkout on Windows, run from an environment that can execute volt-test.sh or pass a built volt.cmd path.";
	}
	return `If testing a source checkout, pass --volt-bin ${resolve(workspace.path, "volt-test.sh")}.`;
}

async function resolveSourceVoltRunner(sourceVolt) {
	const runnerPath = resolve(sourceVolt, "scripts", "run-coding-agent-source.mjs");
	try {
		const runnerStat = await stat(runnerPath);
		if (runnerStat.isFile()) return runnerPath;
	} catch (error) {
		if (error && error.code !== "ENOENT") throw error;
	}
	throw new Error(`Volt source runner is not available: ${runnerPath}`);
}

async function preflightRpcChild(options, workspace) {
	await assertWorkspaceDirectory(workspace);
	if (options.integratedVolt) {
		return;
	}
	if (options.sourceVolt) {
		options.resolvedSourceVoltRunner = await resolveSourceVoltRunner(options.sourceVolt);
		return;
	}
	if (!options.useVolt) return;

	const voltBin = getPlatformVoltBin(options.voltBin);
	const resolvedVoltBin = await findExecutable(voltBin);
	if (!resolvedVoltBin) {
		throw new Error(
			`Volt executable is not available: ${voltBin}. Install Volt globally or pass --volt-bin <path>. ${sourceCheckoutVoltBinHint(workspace)}`,
		);
	}
	options.resolvedVoltBin = resolvedVoltBin;
}

async function bindEndpoint(relayMode, state, statePath) {
	const endpoint = await withStateFileLock(statePath, async () => {
		syncState(state, await readIrohRemoteHostState(statePath));
		const builder = Endpoint.builder();
		if (relayMode === "default") {
			presetN0(builder);
		} else {
			presetMinimal(builder);
			builder.relayMode(RelayMode.disabled());
		}
		if (state.hostSecretKey) {
			builder.secretKey(state.hostSecretKey);
		}
		builder.alpns([ALPN]);
		const boundEndpoint = await builder.bind();
		if (!state.hostSecretKey) {
			state.hostSecretKey = boundEndpoint.secretKey().toBytes();
			await writeIrohRemoteHostState(statePath, state);
		}
		return boundEndpoint;
	});
	if (relayMode === "default") {
		await endpoint.online();
	}
	return endpoint;
}

function isWindowsCommandShim(command) {
	if (process.platform !== "win32") return false;
	const lowerCommand = command.toLowerCase();
	return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}

function spawnProcess(command, args, options) {
	if (!isWindowsCommandShim(command)) {
		return spawn(command, args, options);
	}
	return spawn(process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}

function spawnRpcChild(options, workspace, allowTools) {
	if (options.sourceVolt) {
		const runnerPath = options.resolvedSourceVoltRunner ?? resolve(options.sourceVolt, "scripts", "run-coding-agent-source.mjs");
		const args = [runnerPath, "--mode", "rpc"];
		if (allowTools !== undefined) args.push("--tools", allowTools);
		return {
			command: process.execPath,
			args,
			child: spawnProcess(process.execPath, args, {
				cwd: workspace.path,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		};
	}

	if (!options.useVolt) {
		const fakeRpcPath = join(PACKAGE_DIR, "examples", "remote", "iroh-sidecar", "fake-rpc.mjs");
		const args = [fakeRpcPath];
		return {
			command: process.execPath,
			args,
			child: spawnProcess(process.execPath, args, {
				cwd: workspace.path,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		};
	}

	const voltBin = options.resolvedVoltBin ?? getPlatformVoltBin(options.voltBin);
	const args = ["--mode", "rpc"];
	if (allowTools !== undefined) args.push("--tools", allowTools);
	return {
		command: voltBin,
		args,
		child: spawnProcess(voltBin, args, {
			cwd: workspace.path,
			stdio: ["pipe", "pipe", "pipe"],
		}),
	};
}

function formatCommand(command, args) {
	return [command, ...args].join(" ");
}

async function waitForChildSpawn(child, commandText, workspace) {
	await new Promise((resolveSpawn, rejectSpawn) => {
		const cleanup = () => {
			child.off("spawn", handleSpawn);
			child.off("error", handleError);
		};
		const handleSpawn = () => {
			cleanup();
			resolveSpawn();
		};
		const handleError = (error) => {
			cleanup();
			rejectSpawn(
				new Error(`Failed to spawn RPC child (${commandText}) in ${workspace.path}: ${error.message}`),
			);
		};
		child.once("spawn", handleSpawn);
		child.once("error", handleError);
	});
}

function attachChildLogging(child) {
	if (!child.stderr) return;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.trim().length > 0) process.stderr.write(`[volt-rpc] ${line}\n`);
		}
	});
}

async function waitForChildExitOrTimeout(child) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	await Promise.race([
		once(child, "exit").then(() => true),
		new Promise((resolveDelay) => {
			setTimeout(() => resolveDelay(false), 500);
		}),
	]);
	return child.exitCode !== null || child.signalCode !== null;
}

async function logRpcChildStopped(child, childCommand, authorization, options) {
	const stopped = await waitForChildExitOrTimeout(child);
	await logAudit(options.auditLogger, {
		type: "child_stopped",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: stopped,
		error: stopped ? undefined : "RPC child did not exit before audit timeout",
		details: {
			command: childCommand,
			exitCode: child.exitCode,
			killed: child.killed,
			pid: child.pid,
			signal: child.signalCode,
		},
	});
}

async function sendHandshakeError(stream, message, options) {
	await writeIrohRemoteHandshakeResponse(
		stream.send,
		createIrohRemoteHandshakeFailure(message, { hostNodeId: options.hostNodeId }),
	);
	await stream.send.finish?.();
	await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

async function waitForConnectionClose(connection) {
	await Promise.race([
		connection.closed().catch(() => {}),
		new Promise((resolveDelay) => {
			setTimeout(resolveDelay, 500);
		}),
	]);
}

async function withTimeout(promise, timeoutMs, message) {
	let timeoutId;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function isExpectedApplicationClose(error) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ConnectionLost(ApplicationClosed") &&
		message.includes("error_code: 0") &&
		(message.includes('reason: b"done"') ||
			message.includes(`reason: b"${ACTIVE_REVOKE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${ACTIVE_REPLACE_CLOSE_REASON}"`))
	);
}

function createIrohSendQueue(send) {
	let pendingWrite = Promise.resolve();
	let finishPromise;
	return {
		write(chunk) {
			if (chunk.length === 0 || finishPromise) return pendingWrite;
			const bytes = Array.from(Buffer.from(chunk));
			pendingWrite = pendingWrite.then(() => send.writeAll(bytes));
			return pendingWrite;
		},
		async finish() {
			finishPromise ??= pendingWrite.then(() => send.finish());
			await finishPromise;
		},
	};
}

function getCurrentUserName() {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME;
	}
}

function createRemoteHostMetadata(authorization, options) {
	return {
		workspace: authorization.workspace.name,
		hostNodeId: options.hostNodeId,
		relayMode: options.relayMode,
		hostName: hostname(),
		userName: getCurrentUserName(),
		cwd: "/workspace",
	};
}

function decorateRemoteHostState(value, authorization, options) {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value.type !== "response" ||
		value.command !== "get_state" ||
		value.success !== true ||
		typeof value.data !== "object" ||
		value.data === null ||
		Array.isArray(value.data)
	) {
		return value;
	}
	return {
		...value,
		data: {
			...value.data,
			remoteHost: createRemoteHostMetadata(authorization, options),
		},
	};
}

function createRemoteRpcCompletionTracker(sendQueue) {
	let clientInputEnded = false;
	let pendingPromptCompletions = 0;
	let completionSettled = false;
	let runningAgent = false;
	let pendingCompaction = false;
	let promptCompletionTimer;
	let retryInProgress = false;
	let waitingForContinuation = false;
	const pendingResponseIds = new Set();
	const pendingResponseCommands = new Map();
	let resolveCompletion;
	let rejectCompletion;
	const completion = new Promise((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	const getPendingResponseCommandCount = () => {
		let count = 0;
		for (const value of pendingResponseCommands.values()) count += value;
		return count;
	};
	const addPendingResponseCommand = (command) => {
		pendingResponseCommands.set(command, (pendingResponseCommands.get(command) ?? 0) + 1);
	};
	const completePendingResponseCommand = (command) => {
		const count = pendingResponseCommands.get(command) ?? 0;
		if (count <= 1) {
			pendingResponseCommands.delete(command);
			return;
		}
		pendingResponseCommands.set(command, count - 1);
	};
	const completePendingResponse = (event) => {
		if (typeof event.id === "string" && pendingResponseIds.delete(event.id)) {
			return true;
		}
		if (pendingResponseCommands.has(event.command)) {
			completePendingResponseCommand(event.command);
			return true;
		}
		return false;
	};
	const clearPromptCompletionTimer = () => {
		if (!promptCompletionTimer) return;
		clearTimeout(promptCompletionTimer);
		promptCompletionTimer = undefined;
	};
	const hasPendingPromptContinuation = () => {
		return runningAgent || waitingForContinuation || retryInProgress || pendingCompaction;
	};
	const completePendingPromptCompletion = () => {
		clearPromptCompletionTimer();
		if (pendingPromptCompletions > 0) pendingPromptCompletions -= 1;
		if (pendingPromptCompletions > 0 && !hasPendingPromptContinuation()) {
			schedulePendingPromptCompletion();
			return;
		}
		maybeComplete();
	};
	const schedulePendingPromptCompletion = () => {
		if (pendingPromptCompletions <= 0) {
			maybeComplete();
			return;
		}
		clearPromptCompletionTimer();
		promptCompletionTimer = setTimeout(() => {
			promptCompletionTimer = undefined;
			if (hasPendingPromptContinuation()) return;
			completePendingPromptCompletion();
		}, PROMPT_COMPLETION_SETTLE_MS);
	};
	const maybeComplete = () => {
		if (
			completionSettled ||
			!clientInputEnded ||
			pendingPromptCompletions > 0 ||
			pendingResponseIds.size > 0 ||
			getPendingResponseCommandCount() > 0
		) {
			return;
		}
		completionSettled = true;
		clearPromptCompletionTimer();
		sendQueue.finish().then(resolveCompletion, rejectCompletion);
	};

	return {
		completion,
		markChildOutputLine(line) {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof event !== "object" || event === null || typeof event.type !== "string") return;

			if (event.type === "agent_start") {
				runningAgent = true;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "queue_update") {
				if (hasPendingPromptContinuation()) {
					clearPromptCompletionTimer();
				} else {
					schedulePendingPromptCompletion();
				}
				return;
			}

			if (event.type === "auto_retry_start") {
				retryInProgress = true;
				runningAgent = true;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "auto_retry_end") {
				retryInProgress = false;
				runningAgent = false;
				waitingForContinuation = false;
				if (event.success === false && !hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type === "compaction_start") {
				pendingCompaction = true;
				runningAgent = false;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "compaction_end") {
				pendingCompaction = false;
				waitingForContinuation = event.willRetry === true;
				if (!waitingForContinuation && !hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type === "agent_end") {
				runningAgent = false;
				if (event.willRetry) {
					waitingForContinuation = true;
					clearPromptCompletionTimer();
					return;
				}
				waitingForContinuation = false;
				if (!hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type !== "response" || typeof event.command !== "string") return;
			const completedTrackedResponse = completePendingResponse(event);
			if (completedTrackedResponse && PROMPT_COMPLETION_RPC_TYPES.has(event.command) && event.success === true) {
				pendingPromptCompletions += 1;
				if (!hasPendingPromptContinuation()) schedulePendingPromptCompletion();
			}
			maybeComplete();
		},
		markClientInputEnded() {
			clientInputEnded = true;
			maybeComplete();
		},
		registerForwardedCommand(command) {
			if (typeof command?.type !== "string") return;
			if (PROMPT_COMPLETION_RPC_TYPES.has(command.type)) {
				if (typeof command.id === "string") {
					pendingResponseIds.add(command.id);
					return;
				}
				addPendingResponseCommand(command.type);
				return;
			}
			if (!RESPONSE_COMPLETION_RPC_TYPES.has(command.type)) return;
			if (typeof command.id === "string") {
				pendingResponseIds.add(command.id);
				return;
			}
			addPendingResponseCommand(command.type);
		},
	};
}

async function writeRemoteRpcLineToChild(line, writable, writeToClient, rpcCompletionTracker, sanitizerOptions) {
	const filterResult = getIrohRemoteRpcFilterResult(line);
	if (!filterResult.allowed) {
		await writeToClient(
			sanitizeIrohRemoteOutboundJsonLine(serializeIrohRemoteRpcFilterRejection(filterResult.response), sanitizerOptions),
		);
		return;
	}
	rpcCompletionTracker.registerForwardedCommand(filterResult.command);
	await writeNodeStream(writable, Buffer.from(`${line}\n`, "utf8"));
}

async function pipeFilteredIrohRpcToNodeWritable(
	recv,
	writable,
	initial,
	writeToClient,
	rpcCompletionTracker,
	sanitizerOptions,
) {
	let buffer = Buffer.from(initial);

	while (true) {
		const result = await readLineFromIroh(recv, buffer);
		if (result.line === undefined) {
			if (result.rest.length > 0) {
				await writeRemoteRpcLineToChild(
					result.rest.toString("utf8"),
					writable,
					writeToClient,
					rpcCompletionTracker,
					sanitizerOptions,
				);
			}
			rpcCompletionTracker.markClientInputEnded();
			return;
		}

		await writeRemoteRpcLineToChild(result.line, writable, writeToClient, rpcCompletionTracker, sanitizerOptions);
		buffer = result.rest;
	}
}

async function runSpawnedRpcConnection(stream, handshake, authorization, options) {
	const spawnedChild = spawnRpcChild(options, authorization.workspace, authorization.allowTools);
	const child = spawnedChild.child;
	const childCommand = formatCommand(spawnedChild.command, spawnedChild.args);
	attachChildLogging(child);
	try {
		await waitForChildSpawn(child, childCommand, authorization.workspace);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await logAudit(options.auditLogger, {
			type: "child_start_failed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: message,
			details: { command: childCommand },
		});
		await sendHandshakeError(stream, message, options);
		return child;
	}

	await logAudit(options.auditLogger, {
		type: "child_started",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: true,
		details: { command: childCommand, pid: child.pid },
	});
	await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);

	const sendQueue = createIrohSendQueue(stream.send);
	const rpcCompletionTracker = createRemoteRpcCompletionTracker(sendQueue);
	const clientToChild = pipeFilteredIrohRpcToNodeWritable(
		stream.recv,
		child.stdin,
		handshake.initialInput,
		(chunk) => sendQueue.write(chunk),
		rpcCompletionTracker,
		{ workspacePath: authorization.workspace.path },
	).catch((error) => {
		if (!child.killed) child.kill();
		throw error;
	});
	const childToClient = pipeIrohRemoteOutboundJsonlReadable(child.stdout, {
		decorate: (value) => decorateRemoteHostState(value, authorization, options),
		workspacePath: authorization.workspace.path,
		writeLine: (line) => sendQueue.write(line),
		onLine: (line) => {
			rpcCompletionTracker.markChildOutputLine(line);
		},
	}).then(() => sendQueue.finish());
	const childError = new Promise((_, rejectChildError) => {
		child.once("error", (error) => {
			rejectChildError(new Error(`RPC child error (${childCommand}): ${error.message}`));
		});
	});
	const clientToChildFailure = clientToChild.then(() => new Promise(() => {}));

	try {
		await Promise.race([childToClient, childError, clientToChildFailure, rpcCompletionTracker.completion]);
	} finally {
		if (child.exitCode === null && !child.killed) child.kill();
		await logRpcChildStopped(child, childCommand, authorization, options);
	}
	return child;
}

async function runIntegratedVoltConnection(stream, handshake, authorization, options) {
	let entry;
	try {
		({ entry } = await getOrCreateIntegratedRuntimeEntry(authorization, options));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await logAudit(options.auditLogger, {
			type: "runtime_failure",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: message,
			details: { runtime: "integrated-volt" },
		});
		await sendHandshakeError(stream, message, options);
		return;
	}

	let subscriber;
	let subscriberError;
	try {
		await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
		subscriber = await attachIntegratedRuntimeSubscriber(entry, options);
		const rpcMode = runIrohRemoteRpcMode(entry.runtime, {
			decorateOutbound: (value) => decorateRemoteHostState(value, authorization, options),
			disposeRuntimeOnClose: false,
			onSessionChanged: async (session) => {
				if (session.sessionId === entry.recordedSessionId) return;
				entry.recordedSessionId = session.sessionId;
				await recordRemoteSessionChange(session, authorization, options);
			},
			stream,
			initialInput: handshake.initialInput,
			workspacePath: authorization.workspace.path,
		});
		await rpcMode;
	} catch (error) {
		subscriberError = error;
	} finally {
		if (subscriber) {
			await detachIntegratedRuntimeSubscriber(
				entry,
				subscriber,
				options,
				subscriberError ? "transport_error" : "transport_closed",
				subscriberError,
			);
		}
	}
}

async function recordRemoteSessionChange(session, authorization, options) {
	try {
		const client = await options.hostEngine.setClientLastSessionId(
			authorization.client.nodeId,
			authorization.workspace.name,
			session.sessionId,
		);
		await logAudit(options.auditLogger, {
			type: "session_changed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: client !== undefined,
			error: client ? undefined : "client not found",
			details: { reason: "remote_rpc_session_change", sessionId: session.sessionId },
		});
	} catch (error) {
		await logAudit(options.auditLogger, {
			type: "session_changed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			details: { reason: "remote_rpc_session_change", sessionId: session.sessionId },
		});
	}
}

async function logRemoteSessionSelection(selection, authorization, options) {
	const common = {
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
	};
	if (selection.kind === "resumed") {
		await logAudit(options.auditLogger, {
			...common,
			type: "session_resumed",
			success: true,
			details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
		});
		return;
	}
	if (selection.kind === "created_after_missing") {
		await logAudit(options.auditLogger, {
			...common,
			type: "session_missing_on_resume",
			success: false,
			error: "session not found",
			details: { requestedSessionId: selection.requestedSessionId },
		});
		await logAudit(options.auditLogger, {
			...common,
			type: "session_created",
			success: true,
			details: { reason: "missing_on_resume", sessionId: selection.sessionId },
		});
		return;
	}
	await logAudit(options.auditLogger, {
		...common,
		type: "session_created",
		success: true,
		details: { reason: "new_client_connection", sessionId: selection.sessionId },
	});
}

function getIntegratedRuntimeRegistryKey(authorization) {
	return `${authorization.client.nodeId}\0${authorization.workspace.name}`;
}

function getIntegratedRuntimeDetails(entry, extraDetails = {}) {
	return {
		runtime: "integrated-volt",
		sessionId: entry.runtime.session.sessionId,
		subscriberCount: entry.subscribers.size,
		active: entry.runtime.session.isStreaming,
		...extraDetails,
	};
}

async function logIntegratedRuntimeAudit(options, entry, type, details = {}, success = true, error) {
	await logAudit(options.auditLogger, {
		type,
		clientNodeId: entry.clientNodeId,
		workspace: entry.workspaceName,
		success,
		error,
		details: getIntegratedRuntimeDetails(entry, details),
	});
}

async function createIntegratedRuntimeEntry(authorization, options) {
	let runtime;
	try {
		const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
		const runtimeResult = await createIrohRemoteAgentRuntimeWithSessionSelection({
			agentDir: options.agentDir,
			allowTools: authorization.allowTools,
			cwd: authorization.workspace.path,
			profile: options.profile,
			projectTrusted: options.projectTrusted,
			resumeSessionId: previousSessionId,
		});
		runtime = runtimeResult.runtime;
		const entry = {
			key: getIntegratedRuntimeRegistryKey(authorization),
			clientNodeId: authorization.client.nodeId,
			workspaceName: authorization.workspace.name,
			runtime,
			recordedSessionId: runtime.session.sessionId,
			subscribers: new Set(),
			detachedAt: undefined,
			detachedRuntimeRetention: undefined,
		};
		options.integratedRuntimes.set(entry.key, entry);
		await options.hostEngine.setClientLastSessionId(
			authorization.client.nodeId,
			authorization.workspace.name,
			runtime.session.sessionId,
		);
		await logRemoteSessionSelection(runtimeResult.sessionSelection, authorization, options);
		await logAudit(options.auditLogger, {
			type: "runtime_started",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: true,
			details: getIntegratedRuntimeDetails(entry),
		});
		await logIntegratedRuntimeAudit(options, entry, "remote_runtime_started", { reason: "created" });
		return entry;
	} catch (error) {
		if (runtime) {
			await runtime.dispose().catch(() => {});
		}
		throw error;
	}
}

async function getOrCreateIntegratedRuntimeEntry(authorization, options) {
	const key = getIntegratedRuntimeRegistryKey(authorization);
	const existing = options.integratedRuntimes.get(key);
	if (existing) {
		return { entry: existing, created: false };
	}
	return { entry: await createIntegratedRuntimeEntry(authorization, options), created: true };
}

let integratedRuntimeSubscriberSequence = 0;

async function attachIntegratedRuntimeSubscriber(entry, options) {
	const wasDetached = entry.subscribers.size === 0 && entry.detachedAt !== undefined;
	cancelIntegratedRuntimeRetention(entry);
	const subscriber = {
		id: `subscriber-${++integratedRuntimeSubscriberSequence}`,
		attachedAt: Date.now(),
	};
	entry.subscribers.add(subscriber);
	if (wasDetached) {
		entry.detachedAt = undefined;
		await logIntegratedRuntimeAudit(options, entry, "remote_runtime_reattached", {
			reason: "subscriber_attached",
			subscriberId: subscriber.id,
		});
	}
	await logIntegratedRuntimeAudit(options, entry, "remote_subscriber_attached", {
		subscriberId: subscriber.id,
	});
	return subscriber;
}

async function detachIntegratedRuntimeSubscriber(entry, subscriber, options, reason, error) {
	if (!entry.subscribers.delete(subscriber)) {
		return;
	}
	const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
	await logIntegratedRuntimeAudit(
		options,
		entry,
		"remote_subscriber_detached",
		{ reason, subscriberId: subscriber.id },
		errorMessage === undefined,
		errorMessage,
	);
	if (entry.subscribers.size > 0) {
		return;
	}
	entry.detachedAt = Date.now();
	await logIntegratedRuntimeAudit(options, entry, "remote_runtime_detached", {
		detachedAt: entry.detachedAt,
		reason,
	});
	scheduleIntegratedRuntimeRetention(entry, options, reason);
}

async function stopIntegratedRuntimeEntry(entry, options, reason) {
	if (!options.integratedRuntimes.has(entry.key)) {
		return;
	}
	cancelIntegratedRuntimeRetention(entry);
	options.integratedRuntimes.delete(entry.key);
	const wasActive = entry.runtime.session.isStreaming;
	let stopSuccess = true;
	let stopError;
	try {
		await entry.runtime.dispose();
	} catch (error) {
		stopSuccess = false;
		stopError = error instanceof Error ? error.message : String(error);
	}
	await logAudit(options.auditLogger, {
		type: "runtime_stopped",
		clientNodeId: entry.clientNodeId,
		workspace: entry.workspaceName,
		success: stopSuccess,
		error: stopError,
		details: getIntegratedRuntimeDetails(entry, { active: wasActive, reason }),
	});
	await logIntegratedRuntimeAudit(
		options,
		entry,
		"remote_runtime_stopped",
		{ active: wasActive, reason },
		stopSuccess,
		stopError,
	);
}

function cancelIntegratedRuntimeRetention(entry) {
	if (!entry.detachedRuntimeRetention) {
		return;
	}
	entry.detachedRuntimeRetention.cancel();
	entry.detachedRuntimeRetention = undefined;
}

function isIntegratedRuntimeDetached(entry, options) {
	return (
		options.integratedRuntimes.get(entry.key) === entry &&
		entry.subscribers.size === 0 &&
		entry.detachedAt !== undefined
	);
}

function scheduleIntegratedRuntimeRetention(entry, options, detachReason) {
	cancelIntegratedRuntimeRetention(entry);
	entry.detachedRuntimeRetention = scheduleDetachedRuntimeRetention({
		ttlMs: options.detachedRuntimeTtlMs,
		isDetached: () => isIntegratedRuntimeDetached(entry, options),
		isActive: () => entry.runtime.session.isStreaming,
		waitForIdle: () => entry.runtime.session.waitForIdle(),
		onExpire: async () => {
			if (!isIntegratedRuntimeDetached(entry, options) || entry.runtime.session.isStreaming) {
				return;
			}
			await logIntegratedRuntimeAudit(options, entry, "remote_runtime_retention_expired", {
				detachedAt: entry.detachedAt,
				detachReason,
				reason: "detached_runtime_ttl_expired",
				ttlMs: options.detachedRuntimeTtlMs,
			});
			await stopIntegratedRuntimeEntry(entry, options, "detached_runtime_ttl_expired");
		},
		onError: (error) => {
			void logIntegratedRuntimeAudit(
				options,
				entry,
				"remote_runtime_retention_expired",
				{
					detachedAt: entry.detachedAt,
					detachReason,
					reason: "detached_runtime_ttl_error",
					ttlMs: options.detachedRuntimeTtlMs,
				},
				false,
				error instanceof Error ? error.message : String(error),
			);
		},
	});
}

async function stopIntegratedRuntimes(options, reason) {
	for (const entry of Array.from(options.integratedRuntimes.values())) {
		await stopIntegratedRuntimeEntry(entry, options, reason);
	}
}

function registerActiveConnection(options, authorization, connection) {
	const entry = {
		clientNodeId: authorization.client.nodeId,
		connection,
		workspace: authorization.workspace.name,
	};
	let entries = options.activeConnections.get(entry.clientNodeId);
	if (!entries) {
		entries = new Set();
		options.activeConnections.set(entry.clientNodeId, entries);
	}
	entries.add(entry);
	return () => {
		entries.delete(entry);
		if (entries.size === 0 && options.activeConnections.get(entry.clientNodeId) === entries) {
			options.activeConnections.delete(entry.clientNodeId);
		}
	};
}

function getActiveConnectionsForAuthorization(options, authorization) {
	const entries = options.activeConnections.get(authorization.client.nodeId) ?? [];
	const matchingEntries = [];
	for (const entry of entries) {
		if (entry.workspace === authorization.workspace.name) {
			matchingEntries.push(entry);
		}
	}
	return matchingEntries;
}

async function replaceActiveConnectionForAuthorization(options, authorization) {
	const entries = options.activeConnections.get(authorization.client.nodeId);
	const matchingEntries = getActiveConnectionsForAuthorization(options, authorization);
	if (matchingEntries.length === 0) {
		return { replaced: false, closedCount: 0 };
	}

	const closeReason = Array.from(Buffer.from(ACTIVE_REPLACE_CLOSE_REASON, "utf8"));
	for (const entry of matchingEntries) {
		entries.delete(entry);
		entry.connection.close(0n, closeReason);
	}
	if (entries.size === 0 && options.activeConnections.get(authorization.client.nodeId) === entries) {
		options.activeConnections.delete(authorization.client.nodeId);
	}

	await logAudit(options.auditLogger, {
		type: "duplicate_connection_replaced",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: true,
		details: {
			closeReason: ACTIVE_REPLACE_CLOSE_REASON,
			closedCount: matchingEntries.length,
			source: "active_connection_registry",
		},
	});
	return { replaced: true, closedCount: matchingEntries.length };
}

async function rejectDuplicateActiveConnection(stream, authorization, options) {
	const error = "client already connected";
	await logAudit(options.auditLogger, {
		type: "duplicate_connection_rejected",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: false,
		error,
		details: { source: "active_connection_registry" },
	});
	await writeIrohRemoteHandshakeResponse(
		stream.send,
		createIrohRemoteHandshakeFailure(error, { hostNodeId: options.hostNodeId }),
	);
	await stream.send.finish?.();
	await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

function getHandshakeChildLabel(options) {
	return options.integratedVolt || options.useVolt ? "volt" : "fake-rpc";
}

function startDuplicateStreamRejectionLoop(connection, remoteId, options) {
	let stopped = false;
	const loop = async () => {
		while (!stopped) {
			let stream;
			try {
				stream = await connection.acceptBi();
			} catch {
				return;
			}
			if (stopped) {
				await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
				await Promise.resolve(stream.send.finish?.()).catch(() => {});
				return;
			}
			void rejectDuplicateStream(stream, remoteId, options);
		}
	};
	void loop().catch(() => {});
	return () => {
		stopped = true;
	};
}

async function rejectDuplicateStream(stream, remoteId, options) {
	const handshake = await options.hostEngine.readHandshake(stream, remoteId, {
		child: getHandshakeChildLabel(options),
		maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
		timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
		writeSuccessResponse: false,
	});
	if (!handshake.ok) {
		await stream.send.finish?.();
		await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
		return;
	}
	await rejectDuplicateActiveConnection(stream, handshake.authorization, options);
}

async function closeActiveConnectionsForClient(options, nodeId) {
	const entries = Array.from(options.activeConnections.get(nodeId) ?? []);
	if (entries.length === 0) {
		await logAudit(options.auditLogger, {
			type: "active_connection_revoked",
			clientNodeId: nodeId,
			success: false,
			error: "no active connection found",
			details: {
				closeReason: ACTIVE_REVOKE_CLOSE_REASON,
				source: "control_channel",
			},
		});
		return { closed: false, closedCount: 0 };
	}

	const closeReason = Array.from(Buffer.from(ACTIVE_REVOKE_CLOSE_REASON, "utf8"));
	for (const entry of entries) {
		entry.connection.close(0n, closeReason);
		await logAudit(options.auditLogger, {
			type: "active_connection_revoked",
			clientNodeId: nodeId,
			workspace: entry.workspace,
			success: true,
			details: {
				closeReason: ACTIVE_REVOKE_CLOSE_REASON,
				source: "control_channel",
			},
		});
	}
	return { closed: true, closedCount: entries.length };
}

async function handleConnection(incoming, options) {
	const accepting = await incoming.accept();
	const connection = await accepting.connect();
	const remoteId = connection.remoteId().toString();
	console.error(`client connected: ${remoteId}`);
	await logAudit(options.auditLogger, {
		type: "client_connected",
		clientNodeId: remoteId,
		workspace: options.workspace.name,
		success: true,
	});

	let child;
	let removeActiveConnection;
	let stopDuplicateStreamRejectionLoop;
	try {
		const stream = await withTimeout(
			connection.acceptBi(),
			DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			"handshake timed out",
		);
		const handshake = await options.hostEngine.readHandshake(stream, remoteId, {
			child: getHandshakeChildLabel(options),
			maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
			timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
			writeSuccessResponse: false,
		});
		if (!handshake.ok) {
			await stream.send.finish?.();
			await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
			return;
		}

		if (handshake.authorization.paired) {
			console.error(`paired client: ${handshake.authorization.client.label} (${remoteId})`);
		}
		await replaceActiveConnectionForAuthorization(options, handshake.authorization);
		removeActiveConnection = registerActiveConnection(options, handshake.authorization, connection);
		stopDuplicateStreamRejectionLoop = startDuplicateStreamRejectionLoop(connection, remoteId, options);

		if (options.integratedVolt) {
			await runIntegratedVoltConnection(stream, handshake, handshake.authorization, options);
			return;
		}
		child = await runSpawnedRpcConnection(stream, handshake, handshake.authorization, options);
	} finally {
		stopDuplicateStreamRejectionLoop?.();
		removeActiveConnection?.();
		if (child && child.exitCode === null && !child.killed) child.kill();
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await waitForConnectionClose(connection);
		console.error(`client disconnected: ${remoteId}`);
		await logAudit(options.auditLogger, {
			type: "client_disconnected",
			clientNodeId: remoteId,
			workspace: options.workspace.name,
			success: true,
		});
	}
}

function listenServer(server, controlPath) {
	return new Promise((resolveListen, rejectListen) => {
		const cleanup = () => {
			server.off("error", handleError);
		};
		const handleError = (error) => {
			cleanup();
			rejectListen(error);
		};
		server.once("error", handleError);
		server.listen(controlPath, () => {
			cleanup();
			resolveListen();
		});
	});
}

function canConnectToControlPath(controlPath) {
	return new Promise((resolveConnect) => {
		const socket = connectNet(controlPath);
		let settled = false;
		const finish = (canConnect) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveConnect(canConnect);
		};
		const timeout = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function listenOnControlPath(server, controlPath) {
	if (process.platform !== "win32") {
		await mkdir(dirname(controlPath), { recursive: true });
	}
	try {
		await listenServer(server, controlPath);
		return;
	} catch (error) {
		if (process.platform === "win32" || error?.code !== "EADDRINUSE") throw error;
		if (await canConnectToControlPath(controlPath)) {
			throw new Error(`Iroh remote host control channel is already active for this state path: ${controlPath}`);
		}
		await rm(controlPath, { force: true });
		await listenServer(server, controlPath);
	}
}

function readLineFromControlSocket(socket) {
	return new Promise((resolveLine, rejectLine) => {
		let buffer = "";
		const cleanup = () => {
			socket.off("data", handleData);
			socket.off("end", handleEnd);
			socket.off("error", handleError);
		};
		const handleData = (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > CONTROL_REQUEST_MAX_BYTES) {
				cleanup();
				rejectLine(new Error(`Control request exceeds ${CONTROL_REQUEST_MAX_BYTES} bytes`));
				return;
			}
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			cleanup();
			resolveLine(buffer.slice(0, newlineIndex));
		};
		const handleEnd = () => {
			cleanup();
			rejectLine(new Error("Control request ended before a line was received"));
		};
		const handleError = (error) => {
			cleanup();
			rejectLine(error);
		};
		socket.setEncoding("utf8");
		socket.on("data", handleData);
		socket.once("end", handleEnd);
		socket.once("error", handleError);
	});
}

function createControlErrorResponse(type, message) {
	return {
		type,
		success: false,
		error: message,
	};
}

function getControlResponseType(request) {
	if (request.type === IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE) {
		return IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE;
	}
	return IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
}

async function resolvePairControlWorkspace(request, options) {
	const state = await options.stateManager.getState();
	const workspace = state.workspaces.find((entry) => entry.name === request.workspace);
	if (!workspace) {
		return { error: `workspace_unavailable: workspace not registered: ${request.workspace}` };
	}
	if (!(await isWorkspaceDirectoryAvailable(workspace))) {
		return { error: `workspace_unavailable: workspace path is unavailable: ${request.workspace}` };
	}
	return { workspace };
}

async function createPairControlSuccessResponse(request, endpoint, options) {
	const workspaceResult = await resolvePairControlWorkspace(request, options);
	if (workspaceResult.error) {
		return createControlErrorResponse(IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE, workspaceResult.error);
	}
	const workspace = workspaceResult.workspace;
	if (request.relayMode !== undefined && request.relayMode !== options.relayMode) {
		return createControlErrorResponse(
			IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
			`running host relay mode is ${options.relayMode}; cannot create a ${request.relayMode} ticket`,
		);
	}

	const allowTools = request.allowTools ?? workspace.allowedTools ?? options.allowTools;
	const unsafeTools = getIrohRemoteUnsafeAllowedTools(allowTools);
	if (unsafeTools.length > 0) {
		if (!request.unsafeApproval) {
			return createControlErrorResponse(
				IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
				"Unsafe remote tool grants require confirmation or --yes.",
			);
		}
		await logAudit(options.auditLogger, {
			type: "unsafe_tools_enabled",
			workspace: workspace.name,
			success: true,
			details: {
				allowTools,
				approval: request.unsafeApproval,
				context: "pair_command",
				unsafeTools,
			},
		});
	}

	const pairing = await options.hostEngine.pair({
		allowTools,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		labelHint: request.labelHint,
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		ttlMs: request.ttlMs,
		workspace: workspace.name,
	});
	return {
		type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
		success: true,
		expiresAt: pairing.expiresAt,
		ticket: pairing.ticket,
	};
}

async function createRevokeControlSuccessResponse(request, options) {
	const result = await closeActiveConnectionsForClient(options, request.nodeId);
	return {
		type: IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
		success: true,
		closed: result.closed,
		closedCount: result.closedCount,
	};
}

async function createControlSuccessResponse(request, endpoint, options) {
	if (request.type === IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE) {
		return await createPairControlSuccessResponse(request, endpoint, options);
	}
	return await createRevokeControlSuccessResponse(request, options);
}

async function handlePairControlConnection(socket, endpoint, options) {
	let responseType = IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
	try {
		const line = await readLineFromControlSocket(socket);
		const request = parseIrohRemoteControlRequest(JSON.parse(line));
		responseType = getControlResponseType(request);
		const response = await createControlSuccessResponse(request, endpoint, options);
		socket.end(`${JSON.stringify(response)}\n`);
	} catch (error) {
		socket.end(
			`${JSON.stringify(createControlErrorResponse(responseType, error instanceof Error ? error.message : String(error)))}\n`,
		);
	}
}

async function startPairControlServer(endpoint, options) {
	const controlPath = getIrohRemoteControlPath(options.statePath);
	const server = createServer((socket) => {
		handlePairControlConnection(socket, endpoint, options).catch((error) => {
			socket.end(`${JSON.stringify(createPairControlErrorResponse(error instanceof Error ? error.message : String(error)))}\n`);
		});
	});
	await listenOnControlPath(server, controlPath);
	return { controlPath, server };
}

async function closePairControlServer(controlServer) {
	if (!controlServer) return;
	await new Promise((resolveClose) => {
		controlServer.server.close(() => resolveClose());
	});
	if (process.platform !== "win32") {
		await rm(controlServer.controlPath, { force: true });
	}
}

function createTicketPayload(endpoint, options, includePairingSecret) {
	return {
		alpn: IROH_REMOTE_ALPN,
		expiresAt: includePairingSecret ? options.ticketExpiresAt : undefined,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		secret: includePairingSecret ? options.pairingSecret : undefined,
		workspace: options.workspace.name,
	};
}

function printTicket(ticket, label) {
	if (process.stderr.isTTY) {
		try {
			console.error(`${label} QR:`);
			console.error(formatIrohRemoteTicketQrCode(ticket));
		} catch (error) {
			console.error(`Could not render ${label} QR: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.error(`${label}:`);
	console.log(ticket);
}

function getRelayMode(flags) {
	const relayMode = getFlag(flags, "relay", hasFlag(flags, "mobile") ? "default" : "disabled");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}
	return relayMode;
}

function getStartupTicketMode(flags) {
	if (hasFlag(flags, "no-pairing")) {
		return "paired-client";
	}
	if (hasFlag(flags, "mobile")) {
		return "none";
	}
	return "pairing";
}

async function serve(flags) {
	ensureIrohAvailable();
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger, auditPath } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const state = await stateManager.load();
	const allowTools = getFlag(flags, "allow-tools", DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
	const workspace = selectIrohRemoteWorkspace(state, getFlag(flags, "workspace"), allowTools, process.cwd());

	const relayMode = getRelayMode(flags);
	const startupTicketMode = getStartupTicketMode(flags);
	const startupPairingEnabled = startupTicketMode === "pairing";
	const sourceVolt = getFlag(flags, "source-volt");
	const ticketExpiresAt = startupPairingEnabled
		? Date.now() + DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS
		: undefined;
	const options = {
		activeConnections: new Map(),
		agentDir: getFlag(flags, "agent-dir"),
		allowTools,
		auditLogger,
		detachedRuntimeTtlMs: parseIntegratedDetachedRuntimeTtlMs(getFlag(flags, "detached-runtime-ttl-ms")),
		hostEngine: undefined,
		integratedVolt: hasFlag(flags, "integrated-volt"),
		integratedRuntimes: new Map(),
		profile: getFlag(flags, "profile"),
		relayMode,
		hostNodeId: undefined,
		projectTrusted: hasFlag(flags, "approve"),
		ticketExpiresAt,
		once: hasFlag(flags, "once"),
		sourceVolt: sourceVolt ? resolve(sourceVolt) : undefined,
		stateManager,
		statePath,
		useVolt: Boolean(sourceVolt) || hasFlag(flags, "use-volt"),
		voltBin: getFlag(flags, "volt-bin", "volt"),
		workspace,
	};
	await confirmUnsafeRemoteToolGrant({
		allowTools,
		auditLogger,
		context: startupPairingEnabled ? "host_startup_pairing" : "host_startup",
		workspaceName: workspace.name,
		yes: hasFlag(flags, "yes"),
	});
	await preflightRpcChild(options, workspace);
	Object.assign(workspace, await stateManager.upsertWorkspace(workspace, allowTools));

	const endpoint = await bindEndpoint(relayMode, state, statePath);
	options.hostNodeId = endpoint.id().toString();
	const hostEngine = new IrohRemoteHostEngine({
		allowTools,
		auditLogger,
		hostNodeId: options.hostNodeId,
		stateManager,
		validateWorkspace: isWorkspaceDirectoryAvailable,
		workspace,
	});
	options.hostEngine = hostEngine;
	const endpointTicket = EndpointTicket.fromAddr(endpoint.addr()).toString();
	let ticket;
	let ticketLabel;
	if (startupTicketMode === "pairing") {
		ticket = (
			await hostEngine.pair({
				expiresAt: ticketExpiresAt,
				irohTicket: endpointTicket,
				nodeId: endpoint.id().toString(),
				relayMode,
			})
		).ticket;
		ticketLabel = "pairing ticket";
	} else if (startupTicketMode === "paired-client") {
		ticket = encodeIrohRemoteTicketPayload(createTicketPayload(endpoint, options, false));
		ticketLabel = "paired-client ticket";
	}
	const controlServer = await startPairControlServer(endpoint, options);

	console.error(`host id: ${endpoint.id().toString()}`);
	console.error(`state: ${statePath}`);
	console.error(`audit: ${auditPath}`);
	console.error(`control: ${controlServer.controlPath}`);
	console.error(`workspace: ${workspace.name} -> ${workspace.path}`);
	console.error(
		`child: ${options.integratedVolt ? "in-process volt remote host" : options.sourceVolt ? `${process.execPath} ${options.resolvedSourceVoltRunner} --mode rpc` : options.useVolt ? `${options.resolvedVoltBin ?? getPlatformVoltBin(options.voltBin)} --mode rpc` : "fake-rpc"}`,
	);
	console.error(`pairing: ${startupPairingEnabled ? "enabled" : "disabled"}`);
	if (ticket !== undefined && ticketLabel !== undefined) {
		printTicket(ticket, ticketLabel);
	} else {
		console.error("startup ticket: disabled; run `volt remote pair` to create a pairing ticket.");
	}

	const connectionTasks = new Set();
	try {
		while (true) {
			const incoming = await endpoint.acceptNext();
			if (!incoming) break;
			const task = handleConnection(incoming, options).catch((error) => {
				if (!isExpectedApplicationClose(error)) {
					console.error(error instanceof Error ? error.stack : String(error));
				}
			}).finally(() => {
				connectionTasks.delete(task);
			});
			connectionTasks.add(task);
			if (options.once) {
				await task;
				break;
			}
		}
	} finally {
		await closePairControlServer(controlServer);
		try {
			await endpoint.close();
		} finally {
			await Promise.allSettled(connectionTasks);
			await stopIntegratedRuntimes(options, "host_shutdown");
		}
	}
}

async function listClients(flags) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	console.log(JSON.stringify(await stateManager.listClients(), null, 2));
}

async function revokeClient(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to revoke");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const result = await stateManager.revokeClient(nodeId);
	await logAudit(auditLogger, {
		type: "client_revoked",
		clientNodeId: nodeId,
		success: result.revoked,
		error: result.revoked ? undefined : "client not found",
	});
	if (!result.revoked) {
		console.error(`No client found for ${nodeId}`);
		return;
	}
	try {
		const activeRevocation = await requestIrohRemoteActiveRevocation({
			statePath,
			request: {
				type: IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
				nodeId,
			},
		});
		if (activeRevocation.success && activeRevocation.closed) {
			console.error(`Active connection revoked for ${nodeId}`);
		} else if (activeRevocation.success) {
			console.error(`No active live connection found for ${nodeId}`);
		} else {
			console.error(`Active live revocation unavailable for ${nodeId}: ${activeRevocation.error}`);
		}
	} catch (error) {
		console.error(
			`Active live revocation unavailable for ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	console.error(`Revoked ${nodeId}`);
}

async function approveClientRePair(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to approve for re-pair");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const result = await stateManager.approveClientRePair(nodeId);
	await logAudit(auditLogger, {
		type: "client_repair_approved",
		clientNodeId: nodeId,
		success: result.approved,
		error: result.approved ? undefined : "revoked client not found",
	});
	if (!result.approved) {
		console.error(`No revoked client found for ${nodeId}`);
		return;
	}
	console.error(`Approved re-pair for ${nodeId}`);
}

async function main() {
	const { flags, positionals } = parseFlags(process.argv.slice(2));
	if (hasFlag(flags, "help")) {
		printUsage();
		return;
	}

	if (hasFlag(flags, "register-workspace")) {
		await registerWorkspace(flags, positionals);
		return;
	}

	const command = positionals[0] ?? "serve";
	if (command === "serve") {
		await serve(flags);
		return;
	}
	if (command === "clients") {
		await listClients(flags);
		return;
	}
	if (command === "revoke") {
		await revokeClient(flags, positionals[1]);
		return;
	}
	if (command === "approve-repair") {
		await approveClientRePair(flags, positionals[1]);
		return;
	}

	throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
