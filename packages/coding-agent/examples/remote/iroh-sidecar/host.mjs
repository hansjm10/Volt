import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import iroh from "@number0/iroh";
import {
	ALPN,
	ALPN_TEXT,
	encodeTicketPayload,
	getFlag,
	hasFlag,
	parseFlags,
	pipeIrohRecvToNodeWritable,
	pipeNodeReadableToIrohSend,
	readLineFromIroh,
	serializeJsonLine,
	toBytes,
} from "./common.mjs";

const { Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh;
const DEFAULT_ALLOW_TOOLS = "read,grep,find,ls";
const DEFAULT_STATE_PATH = resolve(homedir(), ".volt", "agent", "remote", "iroh-sidecar-host.json");
const HANDSHAKE_MAX_LINE_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;

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
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return { hostSecretKey: undefined, workspaces: [], clients: [] };
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
	const endpoint = await builder.bind();
	if (!state.hostSecretKey) {
		state.hostSecretKey = endpoint.secretKey().toBytes();
		await writeState(statePath, state);
	}
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
		if (allowTools) args.push("--tools", allowTools);
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
	if (allowTools) args.push("--tools", allowTools);
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

function findClient(state, nodeId) {
	return state.clients.find((client) => client.nodeId === nodeId);
}

function getClientWorkspace(client, workspaceName) {
	const allowedWorkspaces = client.allowedWorkspaces ?? [];
	return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(workspaceName);
}

async function authorizeClient({ hello, options, remoteId, state }) {
	const latestState = await readState(options.statePath);
	state.hostSecretKey = latestState.hostSecretKey;
	state.workspaces = latestState.workspaces ?? [];
	state.clients = latestState.clients ?? [];

	const now = Date.now();
	const existingClient = findClient(state, remoteId);
	const hasPairingSecret = Boolean(options.pairingSecret && hello.secret === options.pairingSecret);
	const pairingSecretExpired =
		hasPairingSecret && options.pairingExpiresAt !== undefined && now > options.pairingExpiresAt;
	if (!existingClient && pairingSecretExpired) {
		options.pairingSecret = undefined;
		options.pairingExpiresAt = undefined;
		return { error: "pairing ticket has expired" };
	}

	const requestedWorkspace = typeof hello.workspace === "string" ? hello.workspace : undefined;
	if (requestedWorkspace !== options.workspace.name) {
		return { error: `workspace not allowed: ${requestedWorkspace ?? "<missing>"}` };
	}

	const workspace = state.workspaces.find((entry) => entry.name === requestedWorkspace);
	if (!workspace) {
		return { error: `workspace not allowed: ${requestedWorkspace}` };
	}

	if (!existingClient && !hasPairingSecret) {
		return { error: "client is not paired" };
	}

	if (!existingClient) {
		const client = {
			nodeId: remoteId,
			label: hello.clientLabel || remoteId.slice(0, 12),
			allowedWorkspaces: [workspace.name],
			allowedTools: workspace.allowedTools ?? options.allowTools,
			pairedAt: now,
			lastSeenAt: now,
		};
		state.clients.push(client);
		await writeState(options.statePath, state);
		options.pairingSecret = undefined;
		options.pairingExpiresAt = undefined;
		console.error(`paired client: ${client.label} (${remoteId})`);
		return { client, workspace, allowTools: client.allowedTools };
	}

	if (!getClientWorkspace(existingClient, workspace.name)) {
		return { error: `client is not allowed to use workspace: ${workspace.name}` };
	}
	existingClient.lastSeenAt = now;
	if (hello.clientLabel) existingClient.label = hello.clientLabel;
	await writeState(options.statePath, state);
	return {
		client: existingClient,
		workspace,
		allowTools: existingClient.allowedTools ?? workspace.allowedTools ?? options.allowTools,
	};
}

async function handleConnection(incoming, options, state) {
	const accepting = await incoming.accept();
	const connection = await accepting.connect();
	const remoteId = connection.remoteId().toString();
	console.error(`client connected: ${remoteId}`);

	let child;
	try {
		const stream = await withTimeout(connection.acceptBi(), HANDSHAKE_TIMEOUT_MS, "handshake timed out");
		const handshake = await withTimeout(
			readLineFromIroh(stream.recv, Buffer.alloc(0), { maxLineBytes: HANDSHAKE_MAX_LINE_BYTES }),
			HANDSHAKE_TIMEOUT_MS,
			"handshake timed out",
		);
		if (handshake.line === undefined) {
			await sendHandshakeError(stream, "missing handshake");
			return;
		}

		const hello = JSON.parse(handshake.line);
		if (hello.type !== "volt_iroh_hello") {
			await sendHandshakeError(stream, "unexpected handshake type");
			return;
		}
		if (hello.protocol !== ALPN_TEXT) {
			await sendHandshakeError(stream, `unsupported protocol: ${hello.protocol}`);
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

		const clientToChild = pipeIrohRecvToNodeWritable(stream.recv, child.stdin, handshake.rest).catch((error) => {
			if (!child.killed) child.kill();
			throw error;
		});
		const childToClient = pipeNodeReadableToIrohSend(child.stdout, stream.send);
		const childExit = new Promise((resolveChildExit) => {
			child.once("exit", (code, signal) => resolveChildExit({ code, signal }));
		});
		const childError = new Promise((_, rejectChildError) => {
			child.once("error", (error) => {
				rejectChildError(new Error(`RPC child error (${childCommand}): ${error.message}`));
			});
		});

		await Promise.race([clientToChild, childToClient, childExit, childError]);
	} finally {
		if (child && !child.killed) child.kill();
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await waitForConnectionClose(connection);
		console.error(`client disconnected: ${remoteId}`);
	}
}

function createTicketPayload(endpoint, options, includePairingSecret) {
	return {
		alpn: ALPN_TEXT,
		expiresAt: options.ticketExpiresAt,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		secret: includePairingSecret ? options.pairingSecret : undefined,
		workspace: options.workspace.name,
	};
}

async function serve(flags) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const state = await readState(statePath);
	const allowTools = getFlag(flags, "allow-tools", DEFAULT_ALLOW_TOOLS);
	const workspace = selectWorkspace(state, getFlag(flags, "workspace"), allowTools);

	const relayMode = getFlag(flags, "relay", "disabled");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}

	const pairingEnabled = !hasFlag(flags, "no-pairing");
	const sourceVolt = getFlag(flags, "source-volt");
	const ticketExpiresAt = Date.now() + PAIRING_TICKET_TTL_MS;
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
	await writeState(statePath, state);

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
	const state = await readState(statePath);
	console.log(JSON.stringify(state.clients, null, 2));
}

async function revokeClient(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to revoke");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const state = await readState(statePath);
	const before = state.clients.length;
	state.clients = state.clients.filter((client) => client.nodeId !== nodeId);
	await writeState(statePath, state);
	if (state.clients.length === before) {
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
