import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { getAgentDir } from "../config.ts";
import {
	IROH_REMOTE_ALPN,
	IrohRemoteClientEngine,
	type IrohRemoteRelayMode,
	isIrohRemoteRelayMode,
} from "../core/remote/iroh/index.ts";
import { createIrohRpcTransport, type IrohBiStreamLike } from "../core/rpc/index.ts";
import { type RpcClientEvent, type RpcExtensionUIRequest, RpcTransportClient } from "../modes/index.ts";
import { resolvePath } from "../utils/paths.ts";

const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const DEFAULT_CLIENT_LABEL = `node-${process.pid}`;
const DEFAULT_TIMEOUT_MS = 30_000;
const DONE_REASON = Array.from(Buffer.from("done", "utf8"));
const FIRE_AND_FORGET_EXTENSION_UI_METHODS = new Set([
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);
const BOOLEAN_FLAGS = new Set(["get-state", "help", "interactive", "verbose"]);
const VALUE_FLAGS = new Set(["client-label", "message", "state", "timeout-ms"]);

export type IrohRemoteClientMode = "get-state" | "interactive" | "message";

export interface ParsedIrohRemoteClientArgs {
	clientLabel: string;
	error?: string;
	help: boolean;
	message?: string;
	mode?: IrohRemoteClientMode;
	positionals: string[];
	statePath: string;
	timeoutMs: number;
	ticket?: string;
	verbose: boolean;
}

export interface IrohRemoteClientRpcSessionOptions {
	message?: string;
	mode: IrohRemoteClientMode;
	timeoutMs: number;
	verbose: boolean;
}

export interface IrohRemoteClientIo {
	error: Writable;
	input: Readable;
	inputIsTTY: boolean;
	output: Writable;
}

export interface IrohRemoteClientRunOptions extends IrohRemoteClientRpcSessionOptions {
	clientLabel: string;
	statePath: string;
	ticket: string;
}

interface IrohRemoteClientState {
	clientSecretKey?: number[];
}

interface IrohNativeAdapter {
	loadIroh(): {
		iroh?: unknown;
		irohLoadError?: unknown;
	};
}

interface IrohEndpointBuilder {
	bind(): Promise<IrohEndpoint>;
	relayMode(mode: unknown): void;
	secretKey(secretKey: readonly number[]): void;
}

interface IrohEndpoint {
	close(): Promise<void>;
	connect(endpointAddr: unknown, alpn: readonly number[]): Promise<IrohConnection>;
	id(): { toString(): string };
	online(): Promise<void>;
	secretKey(): { toBytes(): number[] };
}

interface IrohEndpointConstructor {
	builder(): IrohEndpointBuilder;
}

interface IrohEndpointTicket {
	endpointAddr(): unknown;
}

interface IrohEndpointTicketConstructor {
	fromString(ticket: string): IrohEndpointTicket;
}

interface IrohConnection {
	close(errorCode: bigint, reason: readonly number[]): void;
	closed?(): Promise<void>;
	openBi(): Promise<IrohBiStreamLike>;
}

interface IrohModule {
	Endpoint: IrohEndpointConstructor;
	EndpointTicket: IrohEndpointTicketConstructor;
	RelayMode: {
		disabled(): unknown;
	};
	presetMinimal(builder: IrohEndpointBuilder): void;
	presetN0(builder: IrohEndpointBuilder): void;
}

interface IrohRemoteClientConnection {
	client: RpcTransportClient;
	close(): Promise<void>;
}

const requireNativeAdapter = createRequire(import.meta.url);
const nativeAdapter = requireNativeAdapter("./iroh-native-adapter.cjs") as IrohNativeAdapter;

export function getDefaultIrohRemoteClientStatePath(): string {
	return join(getAgentDir(), "remote", "iroh-client.json");
}

export function getIrohRemoteClientUsage(): string {
	return `Usage: volt remote client <ticket> [options]

Options:
  --message <text>       Send one prompt and print streamed text deltas.
  --get-state            Print the remote RPC session state as JSON.
  --interactive          Keep the Iroh connection open and read prompts from stdin.
  --client-label <label> Client label sent during pairing. Defaults to ${DEFAULT_CLIENT_LABEL}.
  --state <path>         Client state path. Defaults to ~/.volt/agent/remote/iroh-client.json.
  --timeout-ms <ms>      Command timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --verbose              Print non-text RPC events.
`;
}

export function parseIrohRemoteClientArgs(args: readonly string[], stdinIsTTY: boolean): ParsedIrohRemoteClientArgs {
	const flags = new Map<string, string>();
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg.startsWith("--")) {
			if (arg === "-h") {
				flags.set("help", "true");
				continue;
			}
			positionals.push(arg);
			continue;
		}

		const eqIndex = arg.indexOf("=");
		const name = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
		if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
			return parseRemoteClientError(positionals, `Unknown remote client option: --${name}`);
		}

		if (eqIndex !== -1) {
			const value = arg.slice(eqIndex + 1);
			if (VALUE_FLAGS.has(name) && value.length === 0) {
				return parseRemoteClientError(positionals, `--${name} requires a value`);
			}
			flags.set(name, value);
			continue;
		}

		if (BOOLEAN_FLAGS.has(name)) {
			flags.set(name, "true");
			continue;
		}

		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			return parseRemoteClientError(positionals, `--${name} requires a value`);
		}
		flags.set(name, value);
		index++;
	}

	const statePath = resolvePath(flags.get("state") ?? getDefaultIrohRemoteClientStatePath());
	const timeoutMs = Number(flags.get("timeout-ms") ?? String(DEFAULT_TIMEOUT_MS));
	const clientLabel = flags.get("client-label") ?? DEFAULT_CLIENT_LABEL;
	const help = flagEnabled(flags, "help");
	const message = flags.get("message");
	const getState = flagEnabled(flags, "get-state");
	const interactive = flagEnabled(flags, "interactive");
	const verbose = flagEnabled(flags, "verbose");

	const base: ParsedIrohRemoteClientArgs = {
		clientLabel,
		help,
		message,
		positionals,
		statePath,
		timeoutMs,
		ticket: positionals[0],
		verbose,
	};

	if (help) {
		return base;
	}
	if (positionals.length === 0) {
		return { ...base, error: "Missing remote client ticket" };
	}
	if (positionals.length > 1) {
		return { ...base, error: `Unexpected remote client argument: ${positionals[1]}` };
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return { ...base, error: "--timeout-ms must be a positive number" };
	}
	if (!clientLabel.trim()) {
		return { ...base, error: "--client-label requires a non-empty value" };
	}

	const requestedModes = [message !== undefined, getState, interactive].filter(Boolean);
	if (requestedModes.length > 1) {
		return { ...base, error: "Choose only one of --message, --get-state, or --interactive" };
	}
	if (message !== undefined) {
		return { ...base, mode: "message" };
	}
	if (getState) {
		return { ...base, mode: "get-state" };
	}
	if (interactive || stdinIsTTY) {
		return { ...base, mode: "interactive" };
	}
	return {
		...base,
		error: "remote client requires --message, --get-state, or --interactive when stdin is not a TTY",
	};
}

export async function runIrohRemoteClient(
	options: IrohRemoteClientRunOptions,
	io: IrohRemoteClientIo = createDefaultIo(),
): Promise<number> {
	const connection = await openIrohRemoteClientConnection(options);
	try {
		return await runIrohRemoteClientRpcSession(connection.client, options, io);
	} finally {
		await connection.close();
	}
}

export async function runIrohRemoteClientRpcSession(
	client: RpcTransportClient,
	options: IrohRemoteClientRpcSessionOptions,
	io: IrohRemoteClientIo = createDefaultIo(),
): Promise<number> {
	const renderer = new RemoteClientEventRenderer(io, options.verbose);
	const unsubscribe = client.onEvent((event) => {
		renderer.handleEvent(client, event);
	});

	try {
		if (options.mode === "get-state") {
			io.output.write(`${JSON.stringify(await client.getState(), null, 2)}\n`);
			return 0;
		}
		if (options.mode === "message") {
			await sendPromptAndWait(client, options.message ?? "", options.timeoutMs);
			renderer.finishPromptLine();
			return 0;
		}
		await runInteractiveClient(client, options.timeoutMs, io, renderer);
		return 0;
	} finally {
		unsubscribe();
	}
}

function parseRemoteClientError(positionals: string[], error: string): ParsedIrohRemoteClientArgs {
	return {
		clientLabel: DEFAULT_CLIENT_LABEL,
		error,
		help: false,
		positionals,
		statePath: getDefaultIrohRemoteClientStatePath(),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		verbose: false,
	};
}

function flagEnabled(flags: Map<string, string>, name: string): boolean {
	return flags.has(name) && flags.get(name) !== "false";
}

async function openIrohRemoteClientConnection(
	options: IrohRemoteClientRunOptions,
): Promise<IrohRemoteClientConnection> {
	const iroh = loadIrohModule();
	const ticketEngine = new IrohRemoteClientEngine();
	const { payload } = await ticketEngine.createHelloFromTicket(options.ticket);
	const state = await readClientState(options.statePath);
	const endpoint = await bindEndpoint(iroh, payload.relayMode ?? "disabled", state, options.statePath);
	const endpointTicket = iroh.EndpointTicket.fromString(payload.irohTicket);
	const connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
	const stream = await connection.openBi();
	const clientEngine = new IrohRemoteClientEngine({
		clientLabel: options.clientLabel,
		clientNodeId: endpoint.id().toString(),
	});

	await clientEngine.writeHello(stream, payload);
	const handshake = await clientEngine.readHandshakeResponse(stream.recv);
	if (!handshake.response.success) {
		throw new Error(handshake.response.error);
	}

	const transport = createIrohRpcTransport({ stream, initialInput: handshake.initialInput });
	const client = new RpcTransportClient({ transport, requestTimeoutMs: options.timeoutMs });
	await client.start();

	return {
		client,
		close: async () => {
			const failures: Error[] = [];
			try {
				await client.stop();
			} catch (error: unknown) {
				failures.push(toError(error));
			}
			try {
				connection.close(0n, DONE_REASON);
			} catch (error: unknown) {
				failures.push(toError(error));
			}
			if (connection.closed) {
				await Promise.race([connection.closed().catch(() => {}), delay(500)]);
			}
			try {
				await endpoint.close();
			} catch (error: unknown) {
				failures.push(toError(error));
			}
			if (failures.length > 0) {
				throw failures[0];
			}
		},
	};
}

function loadIrohModule(): IrohModule {
	const { iroh, irohLoadError } = nativeAdapter.loadIroh();
	if (!iroh) {
		throw new Error(formatIrohLoadError(irohLoadError));
	}
	return iroh as IrohModule;
}

function formatIrohLoadError(error: unknown): string {
	const detail = error instanceof Error ? error.message : error ? String(error) : "unknown native adapter error";
	return [
		"The optional @number0/iroh native adapter is not available.",
		`Native adapter error: ${detail}`,
		"Install Volt with optional dependencies enabled for this platform, then retry `volt remote client`.",
		"If optional dependencies were omitted, reinstall without `--omit=optional`.",
	].join("\n");
}

async function bindEndpoint(
	iroh: IrohModule,
	relayMode: IrohRemoteRelayMode,
	state: IrohRemoteClientState,
	statePath: string,
): Promise<IrohEndpoint> {
	if (!isIrohRemoteRelayMode(relayMode)) {
		throw new Error("ticket relayMode must be disabled or default");
	}

	const builder = iroh.Endpoint.builder();
	if (relayMode === "default") {
		iroh.presetN0(builder);
	} else {
		iroh.presetMinimal(builder);
		builder.relayMode(iroh.RelayMode.disabled());
	}
	if (state.clientSecretKey) {
		builder.secretKey(state.clientSecretKey);
	}
	const endpoint = await builder.bind();
	if (!state.clientSecretKey) {
		state.clientSecretKey = endpoint.secretKey().toBytes();
		await writeClientState(statePath, state);
	}
	if (relayMode === "default") {
		await endpoint.online();
	}
	return endpoint;
}

async function readClientState(path: string): Promise<IrohRemoteClientState> {
	try {
		return parseClientState(JSON.parse(await readFile(path, "utf8")));
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) {
			return {};
		}
		throw error;
	}
}

async function writeClientState(path: string, state: IrohRemoteClientState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(tempPath, path);
}

function parseClientState(value: unknown): IrohRemoteClientState {
	if (!isRecord(value)) {
		throw new Error("Iroh remote client state must be an object");
	}
	const clientSecretKey = value.clientSecretKey;
	if (clientSecretKey === undefined) {
		return {};
	}
	if (
		!Array.isArray(clientSecretKey) ||
		!clientSecretKey.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
	) {
		throw new Error("Iroh remote client state clientSecretKey must be a byte array");
	}
	return { clientSecretKey };
}

async function runInteractiveClient(
	client: RpcTransportClient,
	timeoutMs: number,
	io: IrohRemoteClientIo,
	renderer: RemoteClientEventRenderer,
): Promise<void> {
	let promptRunning = false;
	const rl = createInterface({ input: io.input, output: io.output, terminal: io.inputIsTTY });
	if (io.inputIsTTY) {
		io.error.write("Interactive Volt over Iroh. Type /quit to exit, /state for state, Ctrl+C to abort or exit.\n");
		rl.setPrompt("volt> ");
		rl.prompt();
	}

	rl.on("SIGINT", () => {
		if (!promptRunning) {
			rl.close();
			return;
		}
		io.error.write("\nSending abort.\n");
		void client.abort().catch((error: unknown) => {
			io.error.write(`${toError(error).message}\n`);
		});
	});

	try {
		for await (const line of rl) {
			const text = line.trim();
			if (text.length === 0) {
				if (io.inputIsTTY) rl.prompt();
				continue;
			}
			if (text === "/quit" || text === "/exit") {
				break;
			}
			if (text === "/abort") {
				await client.abort();
				if (io.inputIsTTY) rl.prompt();
				continue;
			}
			if (text === "/state") {
				io.output.write(`${JSON.stringify(await client.getState(), null, 2)}\n`);
				if (io.inputIsTTY) rl.prompt();
				continue;
			}

			promptRunning = true;
			try {
				await sendPromptAndWait(client, text, timeoutMs);
				renderer.finishPromptLine();
			} finally {
				promptRunning = false;
			}
			if (io.inputIsTTY) rl.prompt();
		}
	} finally {
		rl.close();
	}
}

function sendPromptAndWait(client: RpcTransportClient, message: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let finalAgentEndSeen = false;
		let promptAccepted = false;
		let settled = false;
		let unsubscribe = (): void => {};

		const cleanup = (): void => {
			clearTimeout(timer);
			unsubscribe();
		};
		const rejectAndCleanup = (error: unknown): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(toError(error));
		};
		const resolveIfDone = (): void => {
			if (settled || !promptAccepted || !finalAgentEndSeen) {
				return;
			}
			settled = true;
			cleanup();
			resolve();
		};

		const timer = setTimeout(() => {
			rejectAndCleanup(new Error(`Timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		unsubscribe = client.onEvent((event) => {
			if (event.type === "agent_start" || event.type === "auto_retry_start" || event.type === "compaction_start") {
				finalAgentEndSeen = false;
				return;
			}
			if (event.type === "compaction_end" && event.willRetry) {
				finalAgentEndSeen = false;
				return;
			}
			if (event.type === "agent_end") {
				finalAgentEndSeen = !event.willRetry;
				resolveIfDone();
			}
		});

		void client.prompt(message).then(() => {
			promptAccepted = true;
			resolveIfDone();
		}, rejectAndCleanup);
	});
}

class RemoteClientEventRenderer {
	private readonly error: Writable;
	private readonly output: Writable;
	private readonly verbose: boolean;
	private sawText = false;

	constructor(io: IrohRemoteClientIo, verbose: boolean) {
		this.error = io.error;
		this.output = io.output;
		this.verbose = verbose;
	}

	handleEvent(client: RpcTransportClient, event: RpcClientEvent): void {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			this.output.write(event.assistantMessageEvent.delta);
			this.sawText = true;
			return;
		}

		if (event.type === "tool_execution_start") {
			this.error.write(`\n[tool:start] ${event.toolName}${formatToolArgs(event.args)}\n`);
			return;
		}
		if (event.type === "tool_execution_end") {
			this.error.write(`[tool:end] ${event.toolName} ${event.isError ? "error" : "ok"}\n`);
			return;
		}
		if (event.type === "extension_ui_request") {
			queueMicrotask(() => {
				void this.handleExtensionUiRequest(client, event);
			});
			return;
		}
		if (event.type === "extension_error") {
			this.error.write(`\n[extension:error] ${event.error}\n`);
			return;
		}
		if (this.verbose) {
			this.error.write(`${safeStringify(event)}\n`);
		}
	}

	finishPromptLine(): void {
		if (!this.sawText) {
			return;
		}
		this.output.write("\n");
		this.sawText = false;
	}

	private async handleExtensionUiRequest(client: RpcTransportClient, event: RpcExtensionUIRequest): Promise<void> {
		if (FIRE_AND_FORGET_EXTENSION_UI_METHODS.has(event.method)) {
			if (this.verbose) {
				this.error.write(`${safeStringify(event)}\n`);
			}
			return;
		}
		this.error.write(`\n[extension-ui] ${event.method} request cancelled by remote client\n`);
		try {
			await client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: event.id,
				cancelled: true,
			});
		} catch (error: unknown) {
			if (this.verbose) {
				this.error.write(`[extension-ui] failed to send cancellation: ${toError(error).message}\n`);
			}
		}
	}
}

function createDefaultIo(): IrohRemoteClientIo {
	return {
		error: process.stderr,
		input: process.stdin,
		inputIsTTY: Boolean(process.stdin.isTTY),
		output: process.stdout,
	};
}

function formatToolArgs(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		if (!text || text === "{}") {
			return "";
		}
		return ` ${text.length > 240 ? `${text.slice(0, 237)}...` : text}`;
	} catch {
		return "";
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, ms);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
