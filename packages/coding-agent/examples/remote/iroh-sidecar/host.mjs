import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import iroh from "@number0/iroh";
import lockfile from "proper-lockfile";
import {
	ALPN,
	ALPN_TEXT,
	encodeTicketPayload,
	getFlag,
	hasFlag,
	parseFlags,
	readLineFromIroh,
	serializeJsonLine,
	toBytes,
	writeNodeStream,
} from "./common.mjs";

const { Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh;
const DEFAULT_ALLOW_TOOLS = "read,grep,find,ls";
const DEFAULT_STATE_PATH = resolve(homedir(), ".volt", "agent", "remote", "iroh-sidecar-host.json");
const HANDSHAKE_MAX_LINE_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;
const REMOTE_RPC_PASSTHROUGH_TYPES = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"get_state",
	"extension_ui_response",
]);
const PROMPT_COMPLETION_RPC_TYPES = new Set(["prompt", "steer", "follow_up"]);
const RESPONSE_COMPLETION_RPC_TYPES = new Set(["abort", "get_state"]);
const PROMPT_COMPLETION_SETTLE_MS = 100;

function printUsage() {
	console.error(`Usage: npm run host -- [serve] [options]
       npm run host -- clients [options]
       npm run host -- revoke <node-id> [options]

Serve options:
  --workspace <name=path>    Workspace exposed to the client. Defaults to saved workspace or cwd.
  --relay <disabled|default> Iroh relay preset. Defaults to disabled for local tests.
  --state <path>             Host state path. Defaults to ~/.volt/agent/remote/iroh-sidecar-host.json.
  --use-volt                 Spawn volt --mode rpc instead of the fake RPC child.
  --source-volt <repo-root>  Spawn Volt from a source checkout. Implies --use-volt.
  --volt-bin <path>          Volt executable for --use-volt. Defaults to volt.
  --allow-tools <list>       Tool allowlist passed to Volt. Defaults to read,grep,find,ls.
  --no-pairing               Reject unpaired clients and print a paired-client ticket.
  --once                     Exit after the first client disconnects.

Client management:
  clients                    Print paired clients from state.
  revoke <node-id>           Remove a paired client from state.
`);
}

function parseWorkspace(value) {
	if (!value) {
		const cwd = process.cwd();
		return { name: basename(cwd) || "workspace", path: cwd };
	}

	const separatorIndex = value.indexOf("=");
	if (separatorIndex === -1) {
		const path = resolve(value);
		return { name: basename(path) || "workspace", path };
	}

	const name = value.slice(0, separatorIndex).trim();
	const path = resolve(value.slice(separatorIndex + 1));
	if (!name) throw new Error("Workspace name cannot be empty");
	return { name, path };
}

async function readState(path) {
	try {
		const state = JSON.parse(await readFile(path, "utf8"));
		return {
			hostSecretKey: state.hostSecretKey,
			consumedPairingSecretHashes: state.consumedPairingSecretHashes ?? [],
			workspaces: state.workspaces ?? [],
			clients: state.clients ?? [],
		};
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return { hostSecretKey: undefined, consumedPairingSecretHashes: [], workspaces: [], clients: [] };
		}
		throw error;
	}
}

async function writeState(path, state) {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(tempPath, path);
}

async function withStateFileLock(statePath, operation) {
	await mkdir(dirname(statePath), { recursive: true });
	let release;
	let lockCompromised = false;
	let lockCompromisedError;
	const throwIfCompromised = () => {
		if (lockCompromised) {
			throw lockCompromisedError ?? new Error("Iroh sidecar host state lock was compromised");
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
	target.consumedPairingSecretHashes = source.consumedPairingSecretHashes ?? [];
	target.workspaces = source.workspaces ?? [];
	target.clients = source.clients ?? [];
}

function upsertWorkspace(state, workspace, allowTools) {
	const existing = state.workspaces.find((entry) => entry.name === workspace.name);
	const savedWorkspace = {
		name: workspace.name,
		path: workspace.path,
		allowedTools: allowTools,
	};
	if (existing) {
		Object.assign(existing, savedWorkspace);
		return existing;
	}
	state.workspaces.push(savedWorkspace);
	return savedWorkspace;
}

function selectWorkspace(state, requestedWorkspace, allowTools) {
	if (requestedWorkspace) {
		return upsertWorkspace(state, parseWorkspace(requestedWorkspace), allowTools);
	}
	if (state.workspaces.length > 0) {
		const workspace = state.workspaces[0];
		workspace.allowedTools = allowTools;
		return workspace;
	}
	return upsertWorkspace(state, parseWorkspace(undefined), allowTools);
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
		syncState(state, await readState(statePath));
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
			await writeState(statePath, state);
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
		const fakeRpcPath = fileURLToPath(new URL("./fake-rpc.mjs", import.meta.url));
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

async function sendHandshakeError(stream, message) {
	await stream.send.writeAll(toBytes(serializeJsonLine({ type: "volt_iroh_handshake", success: false, error: message })));
	await stream.send.finish();
	await stream.recv.stop(0n).catch(() => {});
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

function isExpectedDoneClose(error) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ConnectionLost(ApplicationClosed") &&
		message.includes("error_code: 0") &&
		message.includes('reason: b"done"')
	);
}

function createIrohSendQueue(send) {
	let pendingWrite = Promise.resolve();
	let finishPromise;
	return {
		write(chunk) {
			if (chunk.length === 0 || finishPromise) return pendingWrite;
			const bytes = typeof chunk === "string" ? toBytes(chunk) : Array.from(Buffer.from(chunk));
			pendingWrite = pendingWrite.then(() => send.writeAll(bytes));
			return pendingWrite;
		},
		async finish() {
			finishPromise ??= pendingWrite.then(() => send.finish());
			await finishPromise;
		},
	};
}

function createRemoteRpcCompletionTracker(sendQueue) {
	let clientInputEnded = false;
	let pendingPromptCompletions = 0;
	let completionSettled = false;
	let pendingCompaction = false;
	let pendingQueueMessages = false;
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
	const clearPromptCompletionTimer = () => {
		if (!promptCompletionTimer) return;
		clearTimeout(promptCompletionTimer);
		promptCompletionTimer = undefined;
	};
	const hasPendingPromptContinuation = () => {
		return waitingForContinuation || retryInProgress || pendingCompaction || pendingQueueMessages;
	};
	const completePendingPromptCompletion = () => {
		clearPromptCompletionTimer();
		if (pendingPromptCompletions > 0) pendingPromptCompletions -= 1;
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
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "queue_update") {
				pendingQueueMessages =
					(event.steering?.length ?? 0) > 0 || (event.followUp?.length ?? 0) > 0;
				if (pendingQueueMessages) clearPromptCompletionTimer();
				return;
			}

			if (event.type === "auto_retry_start") {
				retryInProgress = true;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "auto_retry_end") {
				retryInProgress = false;
				waitingForContinuation = false;
				if (event.success === false && !hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type === "compaction_start") {
				pendingCompaction = true;
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
			if (PROMPT_COMPLETION_RPC_TYPES.has(event.command) && event.success === false) {
				completePendingPromptCompletion();
			} else if (typeof event.id === "string" && pendingResponseIds.delete(event.id)) {
				// The response id completed a one-shot command.
			} else if (RESPONSE_COMPLETION_RPC_TYPES.has(event.command)) {
				completePendingResponseCommand(event.command);
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
				pendingPromptCompletions += 1;
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

function createRpcErrorResponse(id, command, error) {
	return serializeJsonLine({ id, type: "response", command, success: false, error });
}

function getRemoteRpcFilterResult(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		return {
			allowed: false,
			response: createRpcErrorResponse(
				undefined,
				"parse",
				`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
			),
		};
	}

	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
		return {
			allowed: false,
			response: createRpcErrorResponse(undefined, "unknown", "RPC command must be a JSON object with a string type"),
		};
	}

	if (REMOTE_RPC_PASSTHROUGH_TYPES.has(parsed.type)) {
		return { allowed: true, command: parsed };
	}

	return {
		allowed: false,
		response: createRpcErrorResponse(
			typeof parsed.id === "string" ? parsed.id : undefined,
			parsed.type,
			`RPC command not allowed over remote sidecar: ${parsed.type}`,
		),
	};
}

async function writeRemoteRpcLineToChild(line, writable, writeToClient, rpcCompletionTracker) {
	const filterResult = getRemoteRpcFilterResult(line);
	if (!filterResult.allowed) {
		await writeToClient(filterResult.response);
		return;
	}
	rpcCompletionTracker.registerForwardedCommand(filterResult.command);
	await writeNodeStream(writable, Buffer.from(`${line}\n`, "utf8"));
}

async function pipeFilteredIrohRpcToNodeWritable(recv, writable, initial, writeToClient, rpcCompletionTracker) {
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
				);
			}
			rpcCompletionTracker.markClientInputEnded();
			return;
		}

		await writeRemoteRpcLineToChild(result.line, writable, writeToClient, rpcCompletionTracker);
		buffer = result.rest;
	}
}

async function pipeNodeJsonlReadableToIrohSend(readable, sendQueue, onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	for await (const chunk of readable) {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = buffer.slice(0, newlineIndex + 1);
			buffer = buffer.slice(newlineIndex + 1);
			await sendQueue.write(line);
			onLine(line);
		}
	}

	buffer += decoder.end();
	if (buffer.length > 0) {
		await sendQueue.write(buffer);
		onLine(buffer);
	}
	await sendQueue.finish();
}

function findClient(state, nodeId) {
	return state.clients.find((client) => client.nodeId === nodeId);
}

function getClientWorkspace(client, workspaceName) {
	const allowedWorkspaces = client.allowedWorkspaces ?? [];
	return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(workspaceName);
}

function hashPairingSecret(secret) {
	return `sha256:${createHash("sha256").update(secret, "utf8").digest("base64url")}`;
}

function expectString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value, label) {
	if (value === undefined) {
		return undefined;
	}
	return expectString(value, label);
}

function parseHandshakeHello(line) {
	let hello;
	try {
		hello = JSON.parse(line);
	} catch (error) {
		throw new Error(`Failed to parse Iroh remote handshake: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof hello !== "object" || hello === null || Array.isArray(hello)) {
		throw new Error("Iroh remote handshake must be an object");
	}
	if (hello.type !== "volt_iroh_hello") {
		throw new Error("unexpected handshake type");
	}
	if (hello.protocol !== ALPN_TEXT) {
		throw new Error(`unsupported protocol: ${typeof hello.protocol === "string" ? hello.protocol : "<missing>"}`);
	}
	return {
		type: "volt_iroh_hello",
		protocol: ALPN_TEXT,
		workspace: expectString(hello.workspace, "handshake workspace"),
		secret: expectOptionalString(hello.secret, "handshake secret"),
		clientLabel: expectOptionalString(hello.clientLabel, "handshake clientLabel"),
		clientNodeId: expectOptionalString(hello.clientNodeId, "handshake clientNodeId"),
	};
}

async function authorizeClient({ hello, options, remoteId, state }) {
	return await withStateFileLock(options.statePath, async () => {
		syncState(state, await readState(options.statePath));
		upsertWorkspace(state, options.workspace, options.allowTools);

		const now = Date.now();
		const workspace = options.workspace;
		const existingClient = findClient(state, remoteId);
		const matchingPairingSecret =
			options.pairingSecret !== undefined && hello.secret === options.pairingSecret
				? options.pairingSecret
				: undefined;
		const hasPairingSecret = matchingPairingSecret !== undefined;
		const pairingSecretHash =
			matchingPairingSecret !== undefined ? hashPairingSecret(matchingPairingSecret) : undefined;
		const pairingSecretExpired =
			hasPairingSecret && options.pairingExpiresAt !== undefined && now > options.pairingExpiresAt;
		if (!existingClient && pairingSecretExpired) {
			options.pairingSecret = undefined;
			options.pairingExpiresAt = undefined;
			return { error: "pairing ticket has expired" };
		}

		const requestedWorkspace = typeof hello.workspace === "string" ? hello.workspace : undefined;
		if (requestedWorkspace !== workspace.name) {
			return { error: `workspace not allowed: ${requestedWorkspace ?? "<missing>"}` };
		}

		if (!existingClient && pairingSecretHash && state.consumedPairingSecretHashes.includes(pairingSecretHash)) {
			return { error: "pairing ticket has already been used" };
		}

		if (!existingClient && !hasPairingSecret) {
			return { error: "client is not paired" };
		}

		const currentAllowTools = options.allowTools;
		if (!existingClient) {
			if (!pairingSecretHash) {
				return { error: "client is not paired" };
			}
			const client = {
				nodeId: remoteId,
				label: hello.clientLabel || remoteId.slice(0, 12),
				allowedWorkspaces: [workspace.name],
				allowedTools: currentAllowTools,
				pairedAt: now,
				lastSeenAt: now,
			};
			state.consumedPairingSecretHashes.push(pairingSecretHash);
			state.clients.push(client);
			await writeState(options.statePath, state);
			options.pairingSecret = undefined;
			options.pairingExpiresAt = undefined;
			console.error(`paired client: ${client.label} (${remoteId})`);
			return { client, workspace, allowTools: currentAllowTools };
		}

		if (!getClientWorkspace(existingClient, workspace.name)) {
			return { error: `client is not allowed to use workspace: ${workspace.name}` };
		}
		existingClient.lastSeenAt = now;
		existingClient.allowedTools = currentAllowTools;
		if (hello.clientLabel) existingClient.label = hello.clientLabel;
		await writeState(options.statePath, state);
		return {
			client: existingClient,
			workspace,
			allowTools: currentAllowTools,
		};
	});
}

async function handleConnection(incoming, options, state) {
	const accepting = await incoming.accept();
	const connection = await accepting.connect();
	const remoteId = connection.remoteId().toString();
	console.error(`client connected: ${remoteId}`);

	let child;
	try {
		const stream = await withTimeout(connection.acceptBi(), HANDSHAKE_TIMEOUT_MS, "handshake timed out");
		let handshake;
		try {
			handshake = await withTimeout(
				readLineFromIroh(stream.recv, Buffer.alloc(0), { maxLineBytes: HANDSHAKE_MAX_LINE_BYTES }),
				HANDSHAKE_TIMEOUT_MS,
				"handshake timed out",
			);
		} catch (error) {
			await sendHandshakeError(stream, error instanceof Error ? error.message : String(error));
			return;
		}
		if (handshake.line === undefined) {
			await sendHandshakeError(stream, "missing handshake");
			return;
		}

		let hello;
		try {
			hello = parseHandshakeHello(handshake.line);
		} catch (error) {
			await sendHandshakeError(stream, error instanceof Error ? error.message : String(error));
			return;
		}

		const authorization = await authorizeClient({ hello, options, remoteId, state });
		if (authorization.error) {
			await sendHandshakeError(stream, authorization.error);
			return;
		}

		const spawnedChild = spawnRpcChild(options, authorization.workspace, authorization.allowTools);
		child = spawnedChild.child;
		const childCommand = formatCommand(spawnedChild.command, spawnedChild.args);
		attachChildLogging(child);
		try {
			await waitForChildSpawn(child, childCommand, authorization.workspace);
		} catch (error) {
			await sendHandshakeError(stream, error instanceof Error ? error.message : String(error));
			return;
		}

		await stream.send.writeAll(
			toBytes(
				serializeJsonLine({
					type: "volt_iroh_handshake",
					success: true,
					workspace: authorization.workspace.name,
					clientNodeId: remoteId,
					child: options.useVolt ? "volt" : "fake-rpc",
				}),
			),
		);

		const sendQueue = createIrohSendQueue(stream.send);
		const rpcCompletionTracker = createRemoteRpcCompletionTracker(sendQueue);
		const clientToChild = pipeFilteredIrohRpcToNodeWritable(
			stream.recv,
			child.stdin,
			handshake.rest,
			(chunk) => sendQueue.write(chunk),
			rpcCompletionTracker,
		).catch((error) => {
			if (!child.killed) child.kill();
			throw error;
		});
		const childToClient = pipeNodeJsonlReadableToIrohSend(child.stdout, sendQueue, (line) => {
			rpcCompletionTracker.markChildOutputLine(line);
		});
		const childError = new Promise((_, rejectChildError) => {
			child.once("error", (error) => {
				rejectChildError(new Error(`RPC child error (${childCommand}): ${error.message}`));
			});
		});
		const clientToChildFailure = clientToChild.then(() => new Promise(() => {}));

		await Promise.race([childToClient, childError, clientToChildFailure, rpcCompletionTracker.completion]);
	} finally {
		if (child && child.exitCode === null && !child.killed) child.kill();
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await waitForConnectionClose(connection);
		console.error(`client disconnected: ${remoteId}`);
	}
}

function createTicketPayload(endpoint, options, includePairingSecret) {
	return {
		alpn: ALPN_TEXT,
		expiresAt: includePairingSecret ? options.ticketExpiresAt : undefined,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		secret: includePairingSecret ? options.pairingSecret : undefined,
		workspace: options.workspace.name,
	};
}

async function serve(flags) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const state = await withStateFileLock(statePath, () => readState(statePath));
	const allowTools = getFlag(flags, "allow-tools", DEFAULT_ALLOW_TOOLS);
	const workspace = selectWorkspace(state, getFlag(flags, "workspace"), allowTools);

	const relayMode = getFlag(flags, "relay", "disabled");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}

	const pairingEnabled = !hasFlag(flags, "no-pairing");
	const sourceVolt = getFlag(flags, "source-volt");
	const ticketExpiresAt = pairingEnabled ? Date.now() + PAIRING_TICKET_TTL_MS : undefined;
	const options = {
		allowTools,
		relayMode,
		pairingSecret: pairingEnabled ? randomBytes(24).toString("base64url") : undefined,
		pairingExpiresAt: pairingEnabled ? ticketExpiresAt : undefined,
		ticketExpiresAt,
		once: hasFlag(flags, "once"),
		sourceVolt: sourceVolt ? resolve(sourceVolt) : undefined,
		statePath,
		useVolt: Boolean(sourceVolt) || hasFlag(flags, "use-volt"),
		voltBin: getFlag(flags, "volt-bin", "volt"),
		workspace,
	};
	await preflightRpcChild(options, workspace);
	await withStateFileLock(statePath, async () => {
		syncState(state, await readState(statePath));
		Object.assign(workspace, upsertWorkspace(state, workspace, allowTools));
		await writeState(statePath, state);
	});

	const endpoint = await bindEndpoint(relayMode, state, statePath);
	const ticket = encodeTicketPayload(createTicketPayload(endpoint, options, pairingEnabled));

	console.error(`host id: ${endpoint.id().toString()}`);
	console.error(`state: ${statePath}`);
	console.error(`workspace: ${workspace.name} -> ${workspace.path}`);
	console.error(
		`child: ${options.sourceVolt ? `${process.execPath} ${options.resolvedSourceVoltRunner} --mode rpc` : options.useVolt ? `${options.resolvedVoltBin ?? getPlatformVoltBin(options.voltBin)} --mode rpc` : "fake-rpc"}`,
	);
	console.error(`pairing: ${pairingEnabled ? "enabled" : "disabled"}`);
	console.error(pairingEnabled ? "pairing ticket:" : "paired-client ticket:");
	console.log(ticket);

	while (true) {
		const incoming = await endpoint.acceptNext();
		if (!incoming) break;
		await handleConnection(incoming, options, state).catch((error) => {
			if (!isExpectedDoneClose(error)) {
				console.error(error instanceof Error ? error.stack : String(error));
			}
		});
		if (options.once) break;
	}

	await endpoint.close();
}

async function listClients(flags) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const state = await withStateFileLock(statePath, () => readState(statePath));
	console.log(JSON.stringify(state.clients, null, 2));
}

async function revokeClient(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to revoke");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const revoked = await withStateFileLock(statePath, async () => {
		const state = await readState(statePath);
		const before = state.clients.length;
		state.clients = state.clients.filter((client) => client.nodeId !== nodeId);
		if (state.clients.length === before) {
			return false;
		}
		await writeState(statePath, state);
		return true;
	});
	if (!revoked) {
		console.error(`No client found for ${nodeId}`);
		return;
	}
	console.error(`Revoked ${nodeId}`);
}

async function main() {
	const { flags, positionals } = parseFlags(process.argv.slice(2));
	if (hasFlag(flags, "help")) {
		printUsage();
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

	throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
