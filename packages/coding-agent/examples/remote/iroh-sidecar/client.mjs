import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import iroh from "@number0/iroh/index.js";
import {
	assertIrohRemoteTicketNotExpired,
	decodeIrohRemoteTicketPayload,
	IrohRemoteClientEngine,
	serializeJsonLine,
} from "@earendil-works/volt-coding-agent";
import {
	ALPN,
	getFlag,
	hasFlag,
	parseFlags,
	readJsonlFromIroh,
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
const PROMPT_COMPLETION_SETTLE_MS = 100;

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
		failed: false,
		pendingCompaction: false,
		pendingQueueMessages: false,
		promptCompletionTimer: undefined,
		responseResolvers: new Map(),
		retryInProgress: false,
		sawText: false,
		verbose: hasFlag(flags, "verbose"),
		waitingForContinuation: false,
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

function markDone(state) {
	if (state.done) return;
	state.done = true;
	state.resolveDone?.();
}

function clearPromptCompletionTimer(state) {
	if (!state.promptCompletionTimer) return;
	clearTimeout(state.promptCompletionTimer);
	state.promptCompletionTimer = undefined;
}

function hasPendingPromptContinuation(state) {
	return state.waitingForContinuation || state.retryInProgress || state.pendingCompaction || state.pendingQueueMessages;
}

function finishCurrentPrompt(state) {
	clearPromptCompletionTimer(state);
	if (!state.currentPrompt) return;
	if (state.currentPrompt.sawText) process.stdout.write("\n");
	state.currentPrompt.resolve();
	state.currentPrompt = undefined;
}

function finishOneShotPrompt(state) {
	clearPromptCompletionTimer(state);
	if (state.sawText) process.stdout.write("\n");
	markDone(state);
}

function finishPrompt(state) {
	if (state.currentPrompt) {
		finishCurrentPrompt(state);
		return;
	}
	finishOneShotPrompt(state);
}

function schedulePromptCompletion(state) {
	clearPromptCompletionTimer(state);
	state.promptCompletionTimer = setTimeout(() => {
		state.promptCompletionTimer = undefined;
		if (hasPendingPromptContinuation(state)) return;
		finishPrompt(state);
	}, PROMPT_COMPLETION_SETTLE_MS);
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
				state.failed = true;
				clearPromptCompletionTimer(state);
				markDone(state);
			}
			return;
		}
		if (event.command === "get_state") {
			console.log(JSON.stringify(event.data, null, 2));
			markDone(state);
		}
		return;
	}

	if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
		markTextSeen(state);
		return;
	}

	if (event.type === "agent_start") {
		state.waitingForContinuation = false;
		clearPromptCompletionTimer(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "queue_update") {
		state.pendingQueueMessages =
			(event.steering?.length ?? 0) > 0 || (event.followUp?.length ?? 0) > 0;
		if (state.pendingQueueMessages) clearPromptCompletionTimer(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "auto_retry_start") {
		state.retryInProgress = true;
		state.waitingForContinuation = false;
		clearPromptCompletionTimer(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "auto_retry_end") {
		state.retryInProgress = false;
		state.waitingForContinuation = false;
		if (event.success === false && !hasPendingPromptContinuation(state)) schedulePromptCompletion(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "compaction_start") {
		state.pendingCompaction = true;
		state.waitingForContinuation = false;
		clearPromptCompletionTimer(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "compaction_end") {
		state.pendingCompaction = false;
		state.waitingForContinuation = event.willRetry === true;
		if (!state.waitingForContinuation && !hasPendingPromptContinuation(state)) schedulePromptCompletion(state);
		if (state.verbose) console.error(JSON.stringify(event));
		return;
	}

	if (event.type === "agent_end") {
		if (event.willRetry) {
			state.waitingForContinuation = true;
			clearPromptCompletionTimer(state);
			return;
		}
		state.waitingForContinuation = false;
		if (!hasPendingPromptContinuation(state)) schedulePromptCompletion(state);
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
		state.resolveDone = resolve;
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
				if (state.promptCompletionTimer) {
					finishPrompt(state);
					return;
				}
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
		clearPromptCompletionTimer(state);
	}

	if (state.failed) process.exitCode = 1;
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
		clearPromptCompletionTimer(state);
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

	const payload = decodeIrohRemoteTicketPayload(positionals[0]);
	assertIrohRemoteTicketNotExpired(payload);

	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const clientState = await readState(statePath);
	const endpoint = await bindEndpoint(payload.relayMode ?? "disabled", clientState, statePath);
	const endpointTicket = EndpointTicket.fromString(payload.irohTicket);
	const connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
	const stream = await connection.openBi();
	const clientEngine = new IrohRemoteClientEngine({
		clientLabel: getFlag(flags, "client-label", `node-${process.pid}`),
		clientNodeId: endpoint.id().toString(),
	});

	await clientEngine.writeHello(stream, payload);
	const handshake = await clientEngine.readHandshakeResponse(stream.recv);
	if (!handshake.response.success) {
		throw new Error(handshake.response.error);
	}

	if (hasFlag(flags, "interactive")) {
		await runInteractive(stream, flags, handshake.initialInput);
	} else {
		await runOneShot(stream, flags, handshake.initialInput);
	}

	connection.close(0n, Array.from(Buffer.from("done", "utf8")));
	await endpoint.close();
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
