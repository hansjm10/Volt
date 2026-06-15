import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import iroh from "@number0/iroh";
import {
	ALPN,
	ALPN_TEXT,
	decodeTicketPayload,
	getFlag,
	hasFlag,
	parseFlags,
	readJsonlFromIroh,
	readLineFromIroh,
	serializeJsonLine,
	toBytes,
	writeIrohStream,
} from "./common.mjs";

const { Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh;
const DEFAULT_STATE_PATH = resolve(homedir(), ".volt", "agent", "remote", "iroh-sidecar-client.json");

function printUsage() {
	console.error(`Usage: npm run client -- <ticket> [options]

Options:
  --message <text>       Send one prompt and print streamed text deltas.
  --get-state            Send get_state instead of prompt.
  --client-label <label> Client label sent during pairing. Defaults to this process.
  --state <path>         Client state path. Defaults to ~/.volt/agent/remote/iroh-sidecar-client.json.
  --timeout-ms <ms>      Exit if no completion arrives before timeout. Defaults to 30000.
  --verbose              Print non-text RPC events.
`);
}

async function readState(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return { clientSecretKey: undefined };
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

async function bindEndpoint(relayMode, state, statePath) {
	const builder = Endpoint.builder();
	if (relayMode === "default") {
		presetN0(builder);
	} else {
		presetMinimal(builder);
		builder.relayMode(RelayMode.disabled());
	}
	if (state.clientSecretKey) {
		builder.secretKey(state.clientSecretKey);
	}
	const endpoint = await builder.bind();
	if (!state.clientSecretKey) {
		state.clientSecretKey = endpoint.secretKey().toBytes();
		await writeState(statePath, state);
	}
	if (relayMode === "default") {
		await endpoint.online();
	}
	return endpoint;
}

function createCommand(flags) {
	if (hasFlag(flags, "get-state")) {
		return { id: "state-1", type: "get_state" };
	}

	const message = getFlag(flags, "message", "hello from the Iroh client");
	return { id: "prompt-1", type: "prompt", message };
}

function printRpcLine(line, state) {
	if (line.trim().length === 0) return;

	let event;
	try {
		event = JSON.parse(line);
	} catch {
		console.error(`non-JSON RPC line: ${line}`);
		return;
	}

	if (event.type === "response") {
		if (!event.success) {
			console.error(`\n${event.command} failed: ${event.error}`);
			state.done = true;
			return;
		}
		if (event.command === "get_state") {
			console.log(JSON.stringify(event.data, null, 2));
			state.done = true;
		}
		return;
	}

	if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
		state.sawText = true;
		return;
	}

	if (event.type === "agent_end") {
		if (state.sawText) process.stdout.write("\n");
		state.done = true;
		return;
	}

	if (event.type === "extension_ui_request") {
		console.error(`\nextension UI request not handled by PoC client: ${event.method}`);
		return;
	}

	if (state.verbose) {
		console.error(JSON.stringify(event));
	}
}

async function main() {
	const { flags, positionals } = parseFlags(process.argv.slice(2));
	if (hasFlag(flags, "help") || positionals.length !== 1) {
		printUsage();
		return;
	}

	const payload = decodeTicketPayload(positionals[0]);
	if (payload.expiresAt && Date.now() > payload.expiresAt) {
		throw new Error("Pairing ticket has expired");
	}
	if (payload.alpn !== ALPN_TEXT) {
		throw new Error(`Unsupported ticket ALPN: ${payload.alpn}`);
	}

	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const clientState = await readState(statePath);
	const endpoint = await bindEndpoint(payload.relayMode ?? "disabled", clientState, statePath);
	const endpointTicket = EndpointTicket.fromString(payload.irohTicket);
	const connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
	const stream = await connection.openBi();

	await stream.send.writeAll(
		toBytes(
			serializeJsonLine({
				type: "volt_iroh_hello",
				protocol: ALPN_TEXT,
				workspace: payload.workspace,
				secret: payload.secret,
				clientLabel: getFlag(flags, "client-label", `node-${process.pid}`),
				clientNodeId: endpoint.id().toString(),
			}),
		),
	);

	const handshake = await readLineFromIroh(stream.recv);
	if (handshake.line === undefined) {
		throw new Error("Host closed before handshake response");
	}
	const handshakeResponse = JSON.parse(handshake.line);
	if (handshakeResponse.type !== "volt_iroh_handshake" || !handshakeResponse.success) {
		throw new Error(handshakeResponse.error ?? "Handshake rejected");
	}

	const state = {
		done: false,
		sawText: false,
		verbose: hasFlag(flags, "verbose"),
	};
	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});
	const reader = readJsonlFromIroh(
		stream.recv,
		(line) => {
			printRpcLine(line, state);
			if (state.done) resolveDone();
		},
		handshake.rest,
	).catch((error) => {
		if (!state.done) throw error;
	});

	await writeIrohStream(stream.send, Buffer.from(serializeJsonLine(createCommand(flags)), "utf8"));

	const timeoutMs = Number(getFlag(flags, "timeout-ms", "30000"));
	let timeoutId;
	const timeout = new Promise((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
	});

	await Promise.race([done, reader, timeout]);
	clearTimeout(timeoutId);

	connection.close(0n, Array.from(Buffer.from("done", "utf8")));
	await endpoint.close();
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
