import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
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
const FIRE_AND_FORGET_EXTENSION_UI_METHODS = new Set([
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);

function printUsage() {
	console.error(`Usage: npm run client -- <ticket> [options]

Options:
  --message <text>       Send one prompt and print streamed text deltas.
  --get-state            Send get_state instead of prompt.
  --interactive          Keep the Iroh connection open and read prompts from stdin.
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

function createRpcState(flags) {
	return {
		currentPrompt: undefined,
		done: false,
		responseResolvers: new Map(),
		sawText: false,
		verbose: hasFlag(flags, "verbose"),
	};
}

function formatToolArgs(args) {
	try {
		const text = JSON.stringify(args);
		if (!text || text === "{}") return "";
		return ` ${text.length > 240 ? `${text.slice(0, 237)}...` : text}`;
	} catch {
		return "";
	}
}

function finishCurrentPrompt(state) {
	if (!state.currentPrompt) return;
	if (state.currentPrompt.sawText) process.stdout.write("\n");
	state.currentPrompt.resolve();
	state.currentPrompt = undefined;
}

function finishCurrentPromptWithError(state, message) {
	console.error(`\n${message}`);
	finishCurrentPrompt(state);
}

function markTextSeen(state) {
	if (state.currentPrompt) {
		state.currentPrompt.sawText = true;
		return;
	}
	state.sawText = true;
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
		const resolver = state.responseResolvers.get(event.id);
		if (resolver) {
			state.responseResolvers.delete(event.id);
			resolver(event);
			return;
		}

		if (!event.success) {
			const message = `${event.command} failed: ${event.error}`;
			if (state.currentPrompt?.id === event.id) {
				finishCurrentPromptWithError(state, message);
			} else {
				console.error(`\n${message}`);
				state.done = true;
			}
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
		markTextSeen(state);
		return;
	}

	if (event.type === "agent_end") {
		if (state.currentPrompt) {
			finishCurrentPrompt(state);
			return;
		}
		if (state.sawText) process.stdout.write("\n");
		state.done = true;
		return;
	}

	if (event.type === "tool_execution_start") {
		console.error(`\n[tool:start] ${event.toolName}${formatToolArgs(event.args)}`);
		return;
	}

	if (event.type === "tool_execution_end") {
		console.error(`[tool:end] ${event.toolName} ${event.isError ? "error" : "ok"}`);
		return;
	}

	if (event.type === "extension_ui_request") {
		if (FIRE_AND_FORGET_EXTENSION_UI_METHODS.has(event.method)) {
			if (state.verbose) console.error(JSON.stringify(event));
			return;
		}

		console.error(`\nextension UI request not handled by PoC client: ${event.method}`);
		return;
	}

	if (state.verbose) {
		console.error(JSON.stringify(event));
	}
}

async function sendRpcCommand(send, command) {
	await writeIrohStream(send, Buffer.from(serializeJsonLine(command), "utf8"));
}

function waitForResponse(state, id) {
	return new Promise((resolveResponse) => {
		state.responseResolvers.set(id, resolveResponse);
	});
}

async function sendCommandAndWaitForResponse(send, state, command) {
	const response = waitForResponse(state, command.id);
	await sendRpcCommand(send, command);
	return await response;
}

async function sendPromptAndWait(send, state, text, id) {
	if (state.currentPrompt) {
		throw new Error("Cannot send a prompt while another prompt is running");
	}

	const completion = new Promise((resolvePrompt) => {
		state.currentPrompt = { id, resolve: resolvePrompt, sawText: false, abortRequested: false };
	});

	try {
		await sendRpcCommand(send, { id, type: "prompt", message: text });
	} catch (error) {
		state.currentPrompt = undefined;
		throw error;
	}
	await completion;
}

async function runOneShot(stream, flags, initialRest) {
	const state = createRpcState(flags);
	let readerDone = false;
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
		initialRest,
	)
		.then(() => {
			readerDone = true;
			if (!state.done) {
				throw new Error("Connection closed before the RPC command completed");
			}
		})
		.catch((error) => {
			if (!state.done) throw error;
		});

	await sendRpcCommand(stream.send, createCommand(flags));

	const timeoutMs = Number(getFlag(flags, "timeout-ms", "30000"));
	let timeoutId;
	const timeout = new Promise((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
	});

	try {
		while (!state.done) {
			await Promise.race([done, reader, timeout]);
			if (readerDone && !state.done) {
				throw new Error("Connection closed before the RPC command completed");
			}
		}
	} finally {
		clearTimeout(timeoutId);
	}
}

async function runInteractive(stream, flags, initialRest) {
	const state = createRpcState(flags);
	let nextId = 1;
	let closing = false;
	let rl;
	const reader = readJsonlFromIroh(stream.recv, (line) => printRpcLine(line, state), initialRest).catch((error) => {
		if (!closing) {
			console.error(error instanceof Error ? error.message : String(error));
			rl?.close();
		}
	});

	rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
	if (process.stdin.isTTY) {
		console.error("Interactive Volt over Iroh. Type /quit to exit, /state for state, Ctrl+C to abort or exit.");
		rl.setPrompt("volt> ");
		rl.prompt();
	}

	rl.on("SIGINT", () => {
		if (!state.currentPrompt) {
			rl.close();
			return;
		}
		if (state.currentPrompt.abortRequested) {
			console.error("\nExiting.");
			rl.close();
			return;
		}
		state.currentPrompt.abortRequested = true;
		console.error("\nSending abort. Press Ctrl+C again to exit.");
		void sendRpcCommand(stream.send, { id: `abort-${nextId++}`, type: "abort" }).catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
		});
	});

	try {
		for await (const line of rl) {
			const text = line.trim();
			if (text.length === 0) {
				if (process.stdin.isTTY) rl.prompt();
				continue;
			}
			if (text === "/quit" || text === "/exit") break;
			if (text === "/abort") {
				await sendRpcCommand(stream.send, { id: `abort-${nextId++}`, type: "abort" });
				if (process.stdin.isTTY) rl.prompt();
				continue;
			}
			if (text === "/state") {
				const response = await sendCommandAndWaitForResponse(stream.send, state, {
					id: `state-${nextId++}`,
					type: "get_state",
				});
				if (response.success) {
					console.log(JSON.stringify(response.data, null, 2));
				} else {
					console.error(`${response.command} failed: ${response.error}`);
				}
				if (process.stdin.isTTY) rl.prompt();
				continue;
			}

			await sendPromptAndWait(stream.send, state, text, `prompt-${nextId++}`);
			if (process.stdin.isTTY) rl.prompt();
		}
	} finally {
		closing = true;
		rl.close();
	}

	await Promise.race([
		reader,
		new Promise((resolveDelay) => {
			setTimeout(resolveDelay, 100);
		}),
	]);
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

	if (hasFlag(flags, "interactive")) {
		await runInteractive(stream, flags, handshake.rest);
	} else {
		await runOneShot(stream, flags, handshake.rest);
	}

	connection.close(0n, Array.from(Buffer.from("done", "utf8")));
	await endpoint.close();
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
