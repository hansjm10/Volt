import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
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

function printUsage() {
	console.error(`Usage: npm run host -- [serve] [options]
       npm run host -- clients [options]
       npm run host -- revoke <node-id> [options]

Serve options:
  --workspace <name=path>    Workspace exposed to the client. Defaults to saved workspace or cwd.
  --relay <disabled|default> Iroh relay preset. Defaults to disabled for local tests.
  --state <path>             Host state path. Defaults to ~/.volt/agent/remote/iroh-sidecar-host.json.
  --use-volt                 Spawn volt --mode rpc instead of the fake RPC child.
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
		return state.workspaces[0];
	}
	return upsertWorkspace(state, parseWorkspace(undefined), allowTools);
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

function spawnRpcChild(options, workspace, allowTools) {
	if (!options.useVolt) {
		const fakeRpcPath = fileURLToPath(new URL("./fake-rpc.mjs", import.meta.url));
		return spawn(process.execPath, [fakeRpcPath], {
			cwd: workspace.path,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	const voltBin = process.platform === "win32" && options.voltBin === "volt" ? "volt.cmd" : options.voltBin;
	const args = ["--mode", "rpc"];
	if (allowTools) args.push("--tools", allowTools);
	return spawn(voltBin, args, {
		cwd: workspace.path,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function attachChildLogging(child) {
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.trim().length > 0) process.stderr.write(`[volt-rpc] ${line}\n`);
		}
	});
}

async function sendHandshakeError(send, message) {
	await send.writeAll(toBytes(serializeJsonLine({ type: "volt_iroh_handshake", success: false, error: message })));
	await send.finish();
}

function findClient(state, nodeId) {
	return state.clients.find((client) => client.nodeId === nodeId);
}

function getClientWorkspace(client, workspaceName) {
	const allowedWorkspaces = client.allowedWorkspaces ?? [];
	return allowedWorkspaces.length === 0 || allowedWorkspaces.includes(workspaceName);
}

async function authorizeClient({ hello, options, remoteId, state }) {
	const workspace = state.workspaces.find((entry) => entry.name === hello.workspace);
	if (!workspace) {
		return { error: `workspace not allowed: ${hello.workspace}` };
	}

	const existingClient = findClient(state, remoteId);
	const validPairingSecret = Boolean(options.pairingSecret && hello.secret === options.pairingSecret);
	if (!existingClient && !validPairingSecret) {
		return { error: "client is not paired" };
	}

	if (!existingClient) {
		const now = Date.now();
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
		console.error(`paired client: ${client.label} (${remoteId})`);
		return { client, workspace, allowTools: client.allowedTools };
	}

	if (!getClientWorkspace(existingClient, workspace.name)) {
		return { error: `client is not allowed to use workspace: ${workspace.name}` };
	}
	existingClient.lastSeenAt = Date.now();
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
		const stream = await connection.acceptBi();
		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) {
			await sendHandshakeError(stream.send, "missing handshake");
			return;
		}

		const hello = JSON.parse(handshake.line);
		if (hello.type !== "volt_iroh_hello") {
			await sendHandshakeError(stream.send, "unexpected handshake type");
			return;
		}
		if (hello.protocol !== ALPN_TEXT) {
			await sendHandshakeError(stream.send, `unsupported protocol: ${hello.protocol}`);
			return;
		}

		const authorization = await authorizeClient({ hello, options, remoteId, state });
		if (authorization.error) {
			await sendHandshakeError(stream.send, authorization.error);
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

		child = spawnRpcChild(options, authorization.workspace, authorization.allowTools);
		attachChildLogging(child);

		const clientToChild = pipeIrohRecvToNodeWritable(stream.recv, child.stdin, handshake.rest).catch((error) => {
			if (!child.killed) child.kill();
			throw error;
		});
		const childToClient = pipeNodeReadableToIrohSend(child.stdout, stream.send);
		const childExit = new Promise((resolveChildExit) => {
			child.once("exit", (code, signal) => resolveChildExit({ code, signal }));
		});

		await Promise.race([clientToChild, childToClient, childExit]);
	} finally {
		if (child && !child.killed) child.kill();
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		console.error(`client disconnected: ${remoteId}`);
	}
}

function createTicketPayload(endpoint, options, includePairingSecret) {
	return {
		alpn: ALPN_TEXT,
		expiresAt: Date.now() + 10 * 60 * 1000,
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
	await writeState(statePath, state);

	const relayMode = getFlag(flags, "relay", "disabled");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}

	const pairingEnabled = !hasFlag(flags, "no-pairing");
	const options = {
		allowTools,
		relayMode,
		pairingSecret: pairingEnabled ? randomBytes(24).toString("base64url") : undefined,
		once: hasFlag(flags, "once"),
		statePath,
		useVolt: hasFlag(flags, "use-volt"),
		voltBin: getFlag(flags, "volt-bin", "volt"),
		workspace,
	};

	const endpoint = await bindEndpoint(relayMode, state, statePath);
	const ticket = encodeTicketPayload(createTicketPayload(endpoint, options, pairingEnabled));

	console.error(`host id: ${endpoint.id().toString()}`);
	console.error(`state: ${statePath}`);
	console.error(`workspace: ${workspace.name} -> ${workspace.path}`);
	console.error(`child: ${options.useVolt ? "volt --mode rpc" : "fake-rpc"}`);
	console.error(`pairing: ${pairingEnabled ? "enabled" : "disabled"}`);
	console.error(pairingEnabled ? "pairing ticket:" : "paired-client ticket:");
	console.log(ticket);

	while (true) {
		const incoming = await endpoint.acceptNext();
		if (!incoming) break;
		await handleConnection(incoming, options, state).catch((error) => {
			console.error(error instanceof Error ? error.stack : String(error));
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
