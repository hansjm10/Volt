#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ALPN,
	ALPN_TEXT,
	decodeTicketPayload,
	encodeTicketPayload,
	readJsonlFromIroh,
	readLineFromIroh,
	serializeJsonLine,
	TICKET_PREFIX,
	toBytes,
} from "../packages/coding-agent/examples/remote/iroh-sidecar/common.mjs";

const requireModule = createRequire(import.meta.url);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceCliScript = join(repoRoot, "scripts", "run-coding-agent-source.mjs");
const sidecarDir = join(repoRoot, "packages", "coding-agent", "examples", "remote", "iroh-sidecar");
const hostScript = join(repoRoot, "packages", "coding-agent", "src", "remote", "iroh-host.mjs");
const clientScript = join(sidecarDir, "client.mjs");
const PROCESS_TIMEOUT_MS = 15_000;
const TICKET_TIMEOUT_MS = 10_000;
const SOURCE_IMPORT_CONDITION_ARGS = ["--conditions", "volt-source"];
const DEFAULT_TEST_ALLOW_TOOLS = "read,grep,find,ls";

let Endpoint;
let EndpointTicket;
let RelayMode;
let presetMinimal;
let presetN0;

async function assertInstalled() {
	try {
		requireModule.resolve("@number0/iroh/package.json");
	} catch {
		throw new Error("The optional @number0/iroh dependency is not installed. Run: npm run iroh:poc:install");
	}
	await access(hostScript);
}

function loadIroh() {
	({ Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = requireModule("@number0/iroh/index.js"));
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function collectProcess(child) {
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

function formatExit(code, signal) {
	return signal ?? code ?? "unknown";
}

function spawnScript(script, args) {
	const child = spawn(process.execPath, [...SOURCE_IMPORT_CONDITION_ARGS, script, ...args], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { child, output: collectProcess(child) };
}

function spawnSourceCli(args, env = {}) {
	const child = spawn(process.execPath, [sourceCliScript, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { child, output: collectProcess(child) };
}

function waitForExit(child, label, output, options = {}) {
	const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
	const expectSuccess = options.expectSuccess ?? true;

	return new Promise((resolveExit, rejectExit) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (child.exitCode === null) child.kill();
			rejectExit(new Error(`${label} timed out after ${timeoutMs}ms\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`));
		}, timeoutMs);

		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectExit(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (expectSuccess && code !== 0) {
				rejectExit(
					new Error(`${label} exited with ${formatExit(code, signal)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`),
				);
				return;
			}
			resolveExit({ code, signal });
		});
	});
}

async function waitForFirstStdoutLine(child, output, label) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < TICKET_TIMEOUT_MS) {
		const newlineIndex = output.stdout.indexOf("\n");
		if (newlineIndex !== -1) {
			return output.stdout.slice(0, newlineIndex).trim();
		}
		if (child.exitCode !== null) {
			throw new Error(`${label} exited before printing a ticket:\n${output.stderr}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} did not print a ticket within ${TICKET_TIMEOUT_MS}ms:\n${output.stderr}`);
}

async function stopProcess(child) {
	if (child.exitCode !== null) return;
	child.kill();
	await new Promise((resolveStop) => {
		child.once("exit", resolveStop);
		setTimeout(resolveStop, 500);
	});
}

function hasFlagArg(args, name) {
	return args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function withDefaultTestAllowTools(args) {
	return hasFlagArg(args, "allow-tools") ? args : ["--allow-tools", DEFAULT_TEST_ALLOW_TOOLS, ...args];
}

function startHost(args) {
	return spawnScript(hostScript, withDefaultTestAllowTools(args));
}

function startSourceCliRemoteHost(args, env = {}) {
	return spawnSourceCli(["remote", "host", ...withDefaultTestAllowTools(args)], env);
}

async function runHostCommand(args) {
	const host = spawnScript(hostScript, args);
	await waitForExit(host.child, `host ${args.join(" ")}`, host.output);
	return host.output;
}

async function runClient(ticket, clientStatePath, args, options = {}) {
	const client = spawnScript(clientScript, [ticket, "--state", clientStatePath, ...args]);
	const exit = await waitForExit(client.child, options.label ?? "client", client.output, {
		expectSuccess: options.expectSuccess ?? true,
		timeoutMs: options.timeoutMs,
	});
	return { ...client.output, exit };
}

async function bindRawClientEndpoint(relayMode) {
	const builder = Endpoint.builder();
	if (relayMode === "default") {
		presetN0(builder);
	} else {
		presetMinimal(builder);
		builder.relayMode(RelayMode.disabled());
	}
	const endpoint = await builder.bind();
	if (relayMode === "default") await endpoint.online();
	return endpoint;
}

async function runRawRpcClient(ticket, command, options = {}) {
	const payload = decodeTicketPayload(ticket);
	const endpoint = await bindRawClientEndpoint(payload.relayMode ?? "disabled");
	let connection;
	try {
		const endpointTicket = EndpointTicket.fromString(payload.irohTicket);
		connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
		const stream = await connection.openBi();
		await stream.send.writeAll(
			toBytes(
				serializeJsonLine({
					type: "volt_iroh_hello",
					protocol: ALPN_TEXT,
					workspace: payload.workspace,
					secret: payload.secret,
					clientLabel: options.clientLabel ?? `raw-node-${process.pid}`,
					clientNodeId: endpoint.id().toString(),
				}),
			),
		);

		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) throw new Error("Host closed before raw RPC handshake response");
		const handshakeResponse = JSON.parse(handshake.line);
		if (handshakeResponse.type !== "volt_iroh_handshake" || !handshakeResponse.success) {
			throw new Error(handshakeResponse.error ?? "Raw RPC handshake rejected");
		}

		await stream.send.writeAll(toBytes(serializeJsonLine(command)));
		if (options.finishSend) await stream.send.finish();

		const lines = [];
		let timeoutId;
		try {
			await Promise.race([
				readJsonlFromIroh(stream.recv, (line) => lines.push(line), handshake.rest),
				new Promise((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error(`raw RPC client timed out after ${PROCESS_TIMEOUT_MS}ms`)),
						PROCESS_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			clearTimeout(timeoutId);
		}
		return lines;
	} finally {
		if (connection) connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await endpoint.close();
	}
}

async function runRawHandshakeLine(ticket, line) {
	const payload = decodeTicketPayload(ticket);
	const endpoint = await bindRawClientEndpoint(payload.relayMode ?? "disabled");
	let connection;
	try {
		const endpointTicket = EndpointTicket.fromString(payload.irohTicket);
		connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
		const stream = await connection.openBi();
		await stream.send.writeAll(toBytes(`${line}\n`));

		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) throw new Error("Host closed before raw handshake response");
		return JSON.parse(handshake.line);
	} finally {
		if (connection) connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await endpoint.close();
	}
}

async function openRawAuthorizedClientOnEndpoint(endpoint, ticket, options = {}) {
	const payload = decodeTicketPayload(ticket);
	let connection;
	try {
		const endpointTicket = EndpointTicket.fromString(payload.irohTicket);
		try {
			connection = await endpoint.connect(endpointTicket.endpointAddr(), ALPN);
		} catch (error) {
			throw new Error(`Raw RPC connect failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		let stream;
		try {
			stream = await connection.openBi();
		} catch (error) {
			throw new Error(`Raw RPC stream open failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		await stream.send.writeAll(
			toBytes(
				serializeJsonLine({
					type: "volt_iroh_hello",
					protocol: ALPN_TEXT,
					workspace: payload.workspace,
					secret: payload.secret,
					clientLabel: options.clientLabel ?? `raw-node-${process.pid}`,
					clientNodeId: endpoint.id().toString(),
				}),
			),
		);

		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) throw new Error("Host closed before raw RPC handshake response");
		const handshakeResponse = JSON.parse(handshake.line);
		if (handshakeResponse.type !== "volt_iroh_handshake") {
			throw new Error(`Unexpected raw RPC handshake response: ${JSON.stringify(handshakeResponse)}`);
		}
		if (handshakeResponse.success !== true && options.expectSuccess !== false) {
			throw new Error(handshakeResponse.error ?? "Raw RPC handshake rejected");
		}
		return {
			connection,
			handshakeResponse,
			nodeId: endpoint.id().toString(),
			rest: handshake.rest,
			stream,
		};
	} catch (error) {
		if (connection) connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		throw error;
	}
}

async function openRawAuthorizedStreamOnConnection(rawClient, ticket, options = {}) {
	const payload = decodeTicketPayload(ticket);
	const stream = await rawClient.connection.openBi();
	await stream.send.writeAll(
		toBytes(
			serializeJsonLine({
				type: "volt_iroh_hello",
				protocol: ALPN_TEXT,
				workspace: payload.workspace,
				secret: payload.secret,
				clientLabel: options.clientLabel ?? `raw-node-${process.pid}`,
				clientNodeId: rawClient.nodeId,
			}),
		),
	);
	const handshake = await readLineFromIroh(stream.recv);
	if (handshake.line === undefined) throw new Error("Host closed before raw RPC handshake response");
	const handshakeResponse = JSON.parse(handshake.line);
	if (handshakeResponse.type !== "volt_iroh_handshake") {
		throw new Error(`Unexpected raw RPC handshake response: ${JSON.stringify(handshakeResponse)}`);
	}
	if (handshakeResponse.success !== true && options.expectSuccess !== false) {
		throw new Error(handshakeResponse.error ?? "Raw RPC handshake rejected");
	}
	return { handshakeResponse, rest: handshake.rest, stream };
}

async function openRawAuthorizedClient(ticket, options = {}) {
	const payload = decodeTicketPayload(ticket);
	const endpoint = await bindRawClientEndpoint(payload.relayMode ?? "disabled");
	try {
		const rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, options);
		return { ...rawClient, endpoint, ownsEndpoint: true };
	} catch (error) {
		await endpoint.close();
		throw error;
	}
}

function closeRawConnection(connection) {
	if (!connection) return;
	connection.close(0n, Array.from(Buffer.from("done", "utf8")));
}

async function closeRawAuthorizedClient(rawClient) {
	if (!rawClient) return;
	closeRawConnection(rawClient.connection);
	if (rawClient.ownsEndpoint !== false) {
		await rawClient.endpoint.close();
	}
}

async function readRawRpcResponse(rawClient, command, label, timeoutMs = PROCESS_TIMEOUT_MS) {
	await rawClient.stream.send.writeAll(toBytes(serializeJsonLine(command)));
	const lines = [];
	let timeoutId;
	try {
		while (true) {
			const lineRead = await Promise.race([
				readLineFromIroh(rawClient.stream.recv, rawClient.rest),
				new Promise((_, reject) => {
					timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			]);
			clearTimeout(timeoutId);
			rawClient.rest = lineRead.rest;
			if (lineRead.line === undefined) {
				throw new Error(`${label} closed before response ${command.id ?? command.type}`);
			}
			lines.push(lineRead.line);
			const event = JSON.parse(lineRead.line);
			if (event.type === "response" && event.id === command.id) {
				return { event, lines };
			}
		}
	} finally {
		clearTimeout(timeoutId);
	}
}

async function readRawRpcEvent(rawClient, label, timeoutMs = PROCESS_TIMEOUT_MS) {
	let timeoutId;
	try {
		const lineRead = await Promise.race([
			readLineFromIroh(rawClient.stream.recv, rawClient.rest),
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
		clearTimeout(timeoutId);
		rawClient.rest = lineRead.rest;
		if (lineRead.line === undefined) {
			throw new Error(`${label} closed before next event`);
		}
		return { event: JSON.parse(lineRead.line), line: lineRead.line };
	} finally {
		clearTimeout(timeoutId);
	}
}

async function waitForRawConnectionClosed(connection, label, timeoutMs = 2000) {
	let timeoutId;
	try {
		await Promise.race([
			connection.closed().catch(() => {}),
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`${label} did not close within ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function withStateDir(name, callback) {
	const stateDir = await mkdtemp(join(tmpdir(), `volt-iroh-sidecar-${name}-`));
	try {
		return await callback({
			clientStatePath: join(stateDir, "client.json"),
			hostStatePath: join(stateDir, "host.json"),
			stateDir,
		});
	} finally {
		await rm(stateDir, { force: true, recursive: true });
	}
}

function getDefaultAuditPath(hostStatePath) {
	return hostStatePath.endsWith(".json")
		? `${hostStatePath.slice(0, -".json".length)}.audit.jsonl`
		: `${hostStatePath}.audit.jsonl`;
}

async function readAuditEvents(auditPath) {
	const text = await readFile(auditPath, "utf8");
	return text
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

async function waitForAuditEvent(auditPath, predicate, label, timeoutMs = PROCESS_TIMEOUT_MS) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		let events = [];
		try {
			events = await readAuditEvents(auditPath);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const event = events.find(predicate);
		if (event) return event;
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} audit event did not appear within ${timeoutMs}ms`);
}

async function findSessionFileById(directory, sessionId) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await findSessionFileById(entryPath, sessionId);
			if (nested) return nested;
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) {
			return entryPath;
		}
	}
	return undefined;
}

async function getOnlySessionDirectory(agentDir, label) {
	const sessionsRoot = join(agentDir, "sessions");
	const entries = await readdir(sessionsRoot, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsRoot, entry.name));
	assert(directories.length === 1, `${label}: expected one session directory`);
	return directories[0];
}

async function ensureSessionFileForId(agentDir, workspacePath, sessionId, label) {
	const existing = await findSessionFileById(join(agentDir, "sessions"), sessionId);
	if (existing) return existing;
	const sessionDir = await getOnlySessionDirectory(agentDir, label);
	const sessionFile = join(sessionDir, `2026-06-21T00-00-00-000Z_${sessionId}.jsonl`);
	await writeFile(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-06-21T00:00:00.000Z",
			cwd: workspacePath,
		})}\n`,
	);
	return sessionFile;
}

function createDeferred() {
	let resolve = () => {};
	const promise = new Promise((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

async function startFakeOpenAICompletionsServer(responseText) {
	const requestStarted = createDeferred();
	const releaseResponse = createDeferred();
	const requestBodies = [];
	let requestCount = 0;
	const server = createServer(async (req, res) => {
		if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/chat/completions")) {
			res.writeHead(404).end();
			return;
		}

		let body = "";
		for await (const chunk of req) {
			body += chunk.toString();
		}
		requestCount += 1;
		requestBodies.push(JSON.parse(body));
		requestStarted.resolve();

		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		await releaseResponse.promise;
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-iroh-active-detach",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake-integrated",
				choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-iroh-active-detach",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake-integrated",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});

	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	assert(address && typeof address === "object", "Fake OpenAI server did not bind to a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		get requestBodies() {
			return requestBodies;
		},
		get requestCount() {
			return requestCount;
		},
		releaseResponse: releaseResponse.resolve,
		waitForRequest: () => requestStarted.promise,
		async close() {
			releaseResponse.resolve();
			await new Promise((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}

async function createFakeSourceVolt(stateDir) {
	const sourceDir = join(stateDir, "fake-source-volt");
	const scriptsDir = join(sourceDir, "scripts");
	const logPath = join(stateDir, "fake-source-volt-rpc.jsonl");
	await mkdir(scriptsDir, { recursive: true });
	await writeFile(
		join(scriptsDir, "run-coding-agent-source.mjs"),
		`import { appendFile } from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
await appendFile(logPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");

function write(value) {
	process.stdout.write(JSON.stringify(value) + "\\n");
}

function messageFor(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake-source-volt",
		provider: "iroh-poc",
		model: "fake-source",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function writePromptResponse(command) {
	if (command.message === "handled without agent end") {
		write({ id: command.id, type: "response", command: "prompt", success: true });
		return;
	}
	if (command.message === "retry cancelled without agent end") {
		write({ id: command.id, type: "response", command: "prompt", success: true });
		write({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 1000,
			errorMessage: "retryable",
		});
		write({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: "Retry cancelled",
		});
		return;
	}
	const responseText = "fake source Volt response: " + command.message;
	const message = messageFor(responseText);
	write({ id: command.id, type: "response", command: "prompt", success: true });
	setTimeout(() => {
		write({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: responseText,
				partial: message,
			},
		});
		write({ type: "agent_end", messages: [message] });
	}, 50);
}

function writeStateResponse(command) {
	write({
		id: command.id,
		type: "response",
		command: "get_state",
		success: true,
		data: {
			model: { provider: "iroh-poc", id: "fake-source", name: "Fake Source Volt" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionId: "fake-source-session",
			sessionName: "Fake Source Volt RPC",
			autoCompactionEnabled: false,
			messageCount: 0,
			pendingMessageCount: 0,
		},
	});
}

function writeQueuedInputResponse(command) {
	write({ id: command.id, type: "response", command: command.type, success: true });
	write({
		type: "queue_update",
		steering: command.type === "steer" ? [command.message] : [],
		followUp: command.type === "follow_up" ? [command.message] : [],
	});
}

function handleLine(line) {
	if (line.trim().length === 0) return;
	let command;
	try {
		command = JSON.parse(line);
	} catch (error) {
		write({
			type: "response",
			command: "parse",
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (command.type === "prompt") {
		writePromptResponse(command);
		return;
	}
	if (command.type === "get_state") {
		writeStateResponse(command);
		return;
	}
	if (command.type === "steer" || command.type === "follow_up") {
		writeQueuedInputResponse(command);
		return;
	}
	write({
		id: command.id,
		type: "response",
		command: command.type ?? "unknown",
		success: false,
		error: "fake source Volt does not implement " + command.type,
	});
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const newlineIndex = buffer.indexOf("\\n");
		if (newlineIndex === -1) break;
		let line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line.endsWith("\\r")) line = line.slice(0, -1);
		handleLine(line);
	}
});
process.stdin.on("end", () => {
	process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
	);
	return { logPath, sourceDir };
}

async function createIntegratedVoltAgentDir(stateDir, options = {}) {
	const agentDir = join(stateDir, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					"iroh-integrated-test": {
						api: "openai-completions",
						apiKey: "test-key",
						baseUrl: options.baseUrl ?? "http://127.0.0.1:9/v1",
						models: [
							{
								id: "fake-integrated",
								name: "Fake Integrated Volt",
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				defaultProvider: "iroh-integrated-test",
				defaultModel: "fake-integrated",
			},
			null,
			2,
		)}\n`,
	);
	return agentDir;
}

async function runHostClientOnce({ clientArgs, clientStatePath, hostArgs, hostStatePath, label }) {
	const host = startHost(["--state", hostStatePath, "--once", ...hostArgs]);
	try {
		const ticket = await waitForFirstStdoutLine(host.child, host.output, `${label} host`);
		const clientOutput = await runClient(ticket, clientStatePath, clientArgs, { label: `${label} client` });
		await waitForExit(host.child, `${label} host`, host.output);
		return { clientOutput, hostOutput: host.output, ticket };
	} finally {
		await stopProcess(host.child);
	}
}

async function expectHostClientFailure({ clientArgs, clientStatePath, hostArgs, hostStatePath, label }) {
	const host = startHost(["--state", hostStatePath, "--once", ...hostArgs]);
	try {
		const ticket = await waitForFirstStdoutLine(host.child, host.output, `${label} host`);
		const clientOutput = await runClient(ticket, clientStatePath, clientArgs, {
			expectSuccess: false,
			label: `${label} client`,
		});
		await waitForExit(host.child, `${label} host`, host.output);
		assert(clientOutput.exit.code !== 0, `${label} client unexpectedly succeeded`);
		return { clientOutput, hostOutput: host.output, ticket };
	} finally {
		await stopProcess(host.child);
	}
}

async function promptRoundTripScenario() {
	await withStateDir("prompt", async ({ clientStatePath, hostStatePath }) => {
		const message = "smoke with JSON line separators \u2028 and \u2029";
		const { clientOutput } = await runHostClientOnce({
			clientArgs: ["--message", message, "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: [],
			hostStatePath,
			label: "prompt round trip",
		});
		const expected = `fake RPC response over Iroh: ${message}`;
		assert(
			clientOutput.stdout.includes(expected),
			`Expected client output to contain ${JSON.stringify(expected)}, got:\n${clientOutput.stdout}`,
		);
	});
}

async function rawHalfClosePromptScenario() {
	await withStateDir("raw-half-close", async ({ hostStatePath }) => {
		const message = "half-close prompt";
		const host = startHost(["--state", hostStatePath, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "raw half-close host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "prompt-half-close", type: "prompt", message },
				{ finishSend: true },
			);
			await waitForExit(host.child, "raw half-close host", host.output);
			const expected = `fake RPC response over Iroh: ${message}`;
			assert(
				lines.join("\n").includes(expected),
				`Expected raw half-close response to contain ${JSON.stringify(expected)}, got:\n${lines.join("\n")}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function pairStreamAbortRelaunchReconnectScenario() {
	await withStateDir("pair-stream-abort-relaunch-reconnect", async ({ hostStatePath }) => {
		const endpoint = await bindRawClientEndpoint("disabled");
		let rawClient;
		try {
			const host = startHost(["--state", hostStatePath, "--once"]);
			try {
				const ticket = await waitForFirstStdoutLine(host.child, host.output, "pair stream abort host");
				rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
					clientLabel: "pair stream abort client",
				});
				const prompt = await readRawRpcResponse(
					rawClient,
					{ id: "prompt-abort", type: "prompt", message: "abortable streaming prompt" },
					"pair stream abort prompt response",
				);
				assert(prompt.event.success === true, `Expected prompt to start, got:\n${prompt.lines.join("\n")}`);

				let sawTextDelta = false;
				for (let index = 0; index < 20; index += 1) {
					const { event } = await readRawRpcEvent(rawClient, "pair stream abort text delta");
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						sawTextDelta = true;
						break;
					}
				}
				assert(sawTextDelta, "Expected prompt stream to produce a text delta before abort");

				const abort = await readRawRpcResponse(
					rawClient,
					{ id: "abort-stream", type: "abort" },
					"pair stream abort response",
				);
				assert(abort.event.success === true, `Expected abort success, got:\n${abort.lines.join("\n")}`);

				const postAbortEvents = abort.lines.map((line) => JSON.parse(line));
				let postAbortTextDeltaCount = postAbortEvents.filter(
					(event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta",
				).length;
				let agentEnd = postAbortEvents.find((event) => event.type === "agent_end");
				for (let index = 0; !agentEnd && index < 20; index += 1) {
					const { event } = await readRawRpcEvent(rawClient, "pair stream abort completion");
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						postAbortTextDeltaCount += 1;
					}
					if (event.type === "agent_end") agentEnd = event;
				}
				assert(agentEnd, "Expected aborted prompt to finish with agent_end");
				assert(postAbortTextDeltaCount === 0, "Expected no text deltas after abort acknowledgement");
				assert(
					agentEnd.messages?.[0]?.stopReason === "aborted",
					`Expected aborted stopReason, got:\n${JSON.stringify(agentEnd)}`,
				);

				closeRawConnection(rawClient.connection);
				rawClient = undefined;
				await waitForExit(host.child, "pair stream abort host", host.output);
			} finally {
				closeRawConnection(rawClient?.connection);
				rawClient = undefined;
				await stopProcess(host.child);
			}

			const reconnectHost = startHost(["--state", hostStatePath, "--no-pairing", "--once"]);
			try {
				const reconnectTicket = await waitForFirstStdoutLine(
					reconnectHost.child,
					reconnectHost.output,
					"pair stream abort reconnect host",
				);
				rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, reconnectTicket, {
					clientLabel: "pair stream abort client",
				});
				const state = await readRawRpcResponse(
					rawClient,
					{ id: "state-after-relaunch", type: "get_state" },
					"pair stream abort reconnect get_state",
				);
				assert(state.event.success === true, `Expected reconnect get_state success, got:\n${state.lines.join("\n")}`);
				assert(
					state.event.data?.remoteHost?.hostNodeId,
					`Expected reconnect get_state to include remoteHost metadata, got:\n${JSON.stringify(state.event)}`,
				);
				closeRawConnection(rawClient.connection);
				rawClient = undefined;
				await waitForExit(reconnectHost.child, "pair stream abort reconnect host", reconnectHost.output);
			} finally {
				closeRawConnection(rawClient?.connection);
				rawClient = undefined;
				await stopProcess(reconnectHost.child);
			}
		} finally {
			closeRawConnection(rawClient?.connection);
			await endpoint.close();
		}
	});
}

async function halfClosedSourceVoltPromptScenario() {
	await withStateDir("source-half-close", async ({ hostStatePath, stateDir }) => {
		const { sourceDir } = await createFakeSourceVolt(stateDir);
		const message = "half-close source prompt";
		const host = startHost(["--state", hostStatePath, "--source-volt", sourceDir, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "source half-close host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "prompt-source-half-close", type: "prompt", message },
				{ finishSend: true },
			);
			await waitForExit(host.child, "source half-close host", host.output);
			const expected = `fake source Volt response: ${message}`;
			assert(
				lines.join("\n").includes(expected),
				`Expected source Volt half-close response to contain ${JSON.stringify(expected)}, got:\n${lines.join("\n")}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function halfClosedSourceVoltHandledPromptScenario() {
	await withStateDir("source-handled-half-close", async ({ hostStatePath, stateDir }) => {
		const { sourceDir } = await createFakeSourceVolt(stateDir);
		const host = startHost(["--state", hostStatePath, "--source-volt", sourceDir, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "source handled half-close host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "prompt-source-handled-half-close", type: "prompt", message: "handled without agent end" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "source handled half-close host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "prompt-source-handled-half-close");
			assert(response, `Expected handled prompt response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected handled prompt success, got:\n${JSON.stringify(response)}`);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function halfClosedSourceVoltRetryCancelledScenario() {
	await withStateDir("source-retry-cancelled-half-close", async ({ hostStatePath, stateDir }) => {
		const { sourceDir } = await createFakeSourceVolt(stateDir);
		const host = startHost(["--state", hostStatePath, "--source-volt", sourceDir, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "source retry cancelled half-close host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "prompt-source-retry-cancelled", type: "prompt", message: "retry cancelled without agent end" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "source retry cancelled half-close host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "prompt-source-retry-cancelled");
			assert(response, `Expected retry-cancelled prompt response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected retry-cancelled prompt success, got:\n${JSON.stringify(response)}`);
			assert(
				responses.some((event) => event.type === "auto_retry_end" && event.success === false),
				`Expected retry cancellation event, got:\n${lines.join("\n")}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function halfClosedSourceVoltQueuedSteerScenario() {
	await withStateDir("source-queued-steer-half-close", async ({ hostStatePath, stateDir }) => {
		const { sourceDir } = await createFakeSourceVolt(stateDir);
		const host = startHost(["--state", hostStatePath, "--source-volt", sourceDir, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "source queued steer half-close host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "steer-source-queued", type: "steer", message: "queued steer without agent start" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "source queued steer half-close host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "steer-source-queued");
			assert(response, `Expected queued steer response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected queued steer success, got:\n${JSON.stringify(response)}`);
			assert(
				responses.some(
					(event) =>
						event.type === "queue_update" &&
						Array.isArray(event.steering) &&
						event.steering.includes("queued steer without agent start"),
				),
				`Expected queued steer update, got:\n${lines.join("\n")}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function rawCommandFilterScenario() {
	await withStateDir("raw-filter", async ({ hostStatePath, stateDir }) => {
		const host = startHost(["--state", hostStatePath, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "raw command filter host");
			const privateCommandPath = join(stateDir, "private-command");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "path-filter", type: privateCommandPath },
				{ finishSend: true },
			);
			await waitForExit(host.child, "raw command filter host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "path-filter");
			assert(response, `Expected host-side path denial response, got:\n${lines.join("\n")}`);
			assert(response.success === false, `Expected path denial to fail, got:\n${JSON.stringify(response)}`);
			assert(response.command === "[redacted host path]", `Expected redacted command, got:\n${JSON.stringify(response)}`);
			assert(
				response.error === "RPC command not allowed over remote host: [redacted host path]",
				`Expected redacted host-side denial, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function integratedRawCommandFilterScenario() {
	await withStateDir("integrated-filter", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`integrated-filter=${workspacePath}`,
			"--integrated-volt",
			"--once",
		]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "integrated raw command filter host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "bash-integrated-1", type: "bash", command: "echo blocked" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "integrated raw command filter host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "bash-integrated-1");
			assert(response, `Expected integrated host-side bash denial response, got:\n${lines.join("\n")}`);
			assert(response.success === false, `Expected integrated bash denial to fail, got:\n${JSON.stringify(response)}`);
			assert(
				response.error === "RPC command not allowed over remote host: bash",
				`Expected integrated host-side bash denial, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function integratedVoltGetStateScenario() {
	await withStateDir("integrated-volt", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`integrated=${workspacePath}`,
			"--integrated-volt",
			"--once",
		]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "integrated Volt host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "state-integrated", type: "get_state" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "integrated Volt host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "state-integrated");
			assert(response, `Expected integrated get_state response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected integrated get_state success, got:\n${JSON.stringify(response)}`);
			assert(
				response.data?.model?.provider === "iroh-integrated-test" &&
					response.data?.model?.id === "fake-integrated",
				`Expected integrated fake model state, got:\n${JSON.stringify(response)}`,
			);
			assert(
				response.data?.remoteHost?.workspace === "integrated" &&
					response.data?.remoteHost?.hostNodeId &&
					response.data?.remoteHost?.relayMode === "disabled" &&
					response.data?.remoteHost?.hostName &&
					response.data?.remoteHost?.userName &&
					response.data?.remoteHost?.cwd === "/workspace",
				`Expected integrated remote host metadata, got:\n${JSON.stringify(response.data?.remoteHost)}`,
			);

			const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
			for (const eventType of [
				"runtime_started",
				"runtime_stopped",
				"remote_runtime_started",
				"remote_subscriber_attached",
				"remote_subscriber_detached",
				"remote_runtime_detached",
				"remote_runtime_stopped",
			]) {
				assert(
					auditEvents.some((event) => event.type === eventType && event.success === true),
					`Expected successful audit event ${eventType}, got:\n${JSON.stringify(auditEvents)}`,
				);
			}
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function integratedVoltReconnectSessionScenario() {
	await withStateDir("integrated-reconnect", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const canonicalWorkspacePath = await realpath(workspacePath);
		const workspaceArg = `reconnect=${workspacePath}`;

		const initial = await runHostClientOnce({
			clientArgs: ["--get-state", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--agent-dir", agentDir, "--workspace", workspaceArg, "--integrated-volt"],
			hostStatePath,
			label: "integrated reconnect initial",
		});
		const initialState = JSON.parse(initial.clientOutput.stdout);
		const initialSessionId = initialState.sessionId;
		assert(initialSessionId, "Reconnect initial get_state did not include a session id");
		const initialSessionFile = await ensureSessionFileForId(
			agentDir,
			canonicalWorkspacePath,
			initialSessionId,
			"integrated reconnect initial",
		);

		const hostStateAfterInitial = JSON.parse(await readFile(hostStatePath, "utf8"));
		assert(
			hostStateAfterInitial.clients?.[0]?.lastSessionIdByWorkspace?.reconnect === initialSessionId,
			"Initial reconnect state did not record the remote session id",
		);

		const resumed = await runHostClientOnce({
			clientArgs: ["--get-state", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--agent-dir", agentDir, "--workspace", workspaceArg, "--integrated-volt", "--no-pairing"],
			hostStatePath,
			label: "integrated reconnect resumed",
		});
		const resumedState = JSON.parse(resumed.clientOutput.stdout);
		assert(
			resumedState.sessionId === initialSessionId,
			`Expected reconnect to resume ${initialSessionId}, got ${resumedState.sessionId}`,
		);

		await rm(initialSessionFile, { force: true });
		const missingFallback = await runHostClientOnce({
			clientArgs: ["--get-state", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--agent-dir", agentDir, "--workspace", workspaceArg, "--integrated-volt", "--no-pairing"],
			hostStatePath,
			label: "integrated reconnect missing session",
		});
		const missingState = JSON.parse(missingFallback.clientOutput.stdout);
		assert(
			missingState.sessionId && missingState.sessionId !== initialSessionId,
			"Expected missing-session reconnect to create a replacement session id",
		);

		const finalHostState = JSON.parse(await readFile(hostStatePath, "utf8"));
		assert(
			finalHostState.clients?.[0]?.lastSessionIdByWorkspace?.reconnect === missingState.sessionId,
			"Missing-session reconnect did not record the replacement session id",
		);
		const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
		assert(
			auditEvents.some((event) => event.type === "session_resumed" && event.details?.sessionId === initialSessionId),
			"Expected session_resumed audit event for reconnect",
		);
		assert(
			auditEvents.some(
				(event) =>
					event.type === "session_missing_on_resume" &&
					event.success === false &&
					event.details?.requestedSessionId === initialSessionId,
			),
			"Expected session_missing_on_resume audit event for deleted session",
		);
		assert(
			auditEvents.some(
				(event) =>
					event.type === "session_created" &&
					event.details?.reason === "missing_on_resume" &&
					event.details?.sessionId === missingState.sessionId,
			),
			"Expected session_created audit event for missing-session replacement",
		);
	});
}

async function integratedVoltDetachReattachRuntimeScenario() {
	await withStateDir("integrated-detach-reattach", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const workspaceArg = `detach=${workspacePath}`;
		const auditPath = getDefaultAuditPath(hostStatePath);
		const endpoint = await bindRawClientEndpoint("disabled");
		let rawClient;
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			workspaceArg,
			"--integrated-volt",
			"--no-pairing",
		]);
		try {
			await waitForFirstStdoutLine(host.child, host.output, "integrated detach host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"detach",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"detach client",
			]);
			await waitForExit(pairCommand.child, "integrated detach pair command", pairCommand.output);
			const ticket = pairCommand.output.stdout.trim();
			assert(ticket.startsWith(TICKET_PREFIX), `Expected detach pair command ticket, got:\n${pairCommand.output.stdout}`);

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "detach client",
			});
			const firstState = await readRawRpcResponse(
				rawClient,
				{ id: "state-detach-first", type: "get_state" },
				"integrated detach first get_state",
			);
			assert(firstState.event.success === true, `Expected first get_state success, got:\n${firstState.lines.join("\n")}`);
			const sessionId = firstState.event.data?.sessionId;
			assert(sessionId, `Expected first get_state session id, got:\n${JSON.stringify(firstState.event)}`);

			closeRawConnection(rawClient.connection);
			rawClient = undefined;
			await waitForAuditEvent(
				auditPath,
				(event) => event.type === "remote_runtime_detached" && event.details?.sessionId === sessionId,
				"integrated detach runtime detached",
			);
			const detachedAuditEvents = await readAuditEvents(auditPath);
			assert(
				!detachedAuditEvents.some((event) => event.type === "remote_runtime_stopped"),
				`Runtime stopped instead of remaining detached:\n${JSON.stringify(detachedAuditEvents)}`,
			);

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "detach client",
			});
			const secondState = await readRawRpcResponse(
				rawClient,
				{ id: "state-detach-second", type: "get_state" },
				"integrated detach second get_state",
			);
			assert(secondState.event.success === true, `Expected second get_state success, got:\n${secondState.lines.join("\n")}`);
			assert(
				secondState.event.data?.sessionId === sessionId,
				`Expected reattach to keep session ${sessionId}, got:\n${JSON.stringify(secondState.event)}`,
			);

			closeRawConnection(rawClient.connection);
			rawClient = undefined;
			await waitForAuditEvent(
				auditPath,
				(event) => event.type === "remote_runtime_reattached" && event.details?.sessionId === sessionId,
				"integrated detach runtime reattached",
			);
			await waitForAuditEvent(
				auditPath,
				(event) => event.type === "remote_subscriber_detached" && event.details?.subscriberId === "subscriber-2",
				"integrated detach second subscriber detached",
			);

			const auditEvents = await readAuditEvents(auditPath);
			assert(
				auditEvents.filter((event) => event.type === "remote_runtime_started").length === 1,
				`Expected one runtime start for detach/reattach, got:\n${JSON.stringify(auditEvents)}`,
			);
			assert(
				auditEvents.filter((event) => event.type === "remote_subscriber_attached").length === 2,
				`Expected two subscriber attach events, got:\n${JSON.stringify(auditEvents)}`,
			);
			assert(
				auditEvents.filter((event) => event.type === "remote_subscriber_detached").length === 2,
				`Expected two subscriber detach events, got:\n${JSON.stringify(auditEvents)}`,
			);
		} finally {
			closeRawConnection(rawClient?.connection);
			await endpoint.close();
			await stopProcess(host.child);
		}
	});
}

async function integratedVoltDetachedRuntimeTtlScenario() {
	await withStateDir("integrated-detached-ttl", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const workspaceArg = `ttl=${workspacePath}`;
		const auditPath = getDefaultAuditPath(hostStatePath);
		const endpoint = await bindRawClientEndpoint("disabled");
		let rawClient;
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			workspaceArg,
			"--integrated-volt",
			"--no-pairing",
			"--detached-runtime-ttl-ms",
			"100",
		]);
		try {
			await waitForFirstStdoutLine(host.child, host.output, "integrated detached ttl host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"ttl",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"ttl client",
			]);
			await waitForExit(pairCommand.child, "integrated detached ttl pair command", pairCommand.output);
			const ticket = pairCommand.output.stdout.trim();
			assert(ticket.startsWith(TICKET_PREFIX), `Expected detached ttl pair command ticket, got:\n${pairCommand.output.stdout}`);

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "ttl client",
			});
			const state = await readRawRpcResponse(
				rawClient,
				{ id: "state-detached-ttl", type: "get_state" },
				"integrated detached ttl get_state",
			);
			assert(state.event.success === true, `Expected detached ttl get_state success, got:\n${state.lines.join("\n")}`);
			const sessionId = state.event.data?.sessionId;
			assert(sessionId, `Expected detached ttl session id, got:\n${JSON.stringify(state.event)}`);

			closeRawConnection(rawClient.connection);
			rawClient = undefined;
			await waitForAuditEvent(
				auditPath,
				(event) => event.type === "remote_runtime_detached" && event.details?.sessionId === sessionId,
				"integrated detached ttl runtime detached",
			);
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "remote_runtime_retention_expired" &&
					event.details?.sessionId === sessionId &&
					event.details?.ttlMs === 100,
				"integrated detached ttl retention expired",
			);
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "remote_runtime_stopped" &&
					event.details?.sessionId === sessionId &&
					event.details?.reason === "detached_runtime_ttl_expired",
				"integrated detached ttl runtime stopped",
			);
		} finally {
			closeRawConnection(rawClient?.connection);
			await endpoint.close();
			await stopProcess(host.child);
		}
	});
}

async function integratedVoltActiveDetachReconnectTranscriptScenario() {
	await withStateDir("integrated-active-detach-reconnect", async ({ hostStatePath, stateDir }) => {
		const responseText = "detached active completion";
		const fakeOpenAI = await startFakeOpenAICompletionsServer(responseText);
		const agentDir = await createIntegratedVoltAgentDir(stateDir, { baseUrl: fakeOpenAI.baseUrl });
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const workspaceArg = `active-detach=${workspacePath}`;
		const auditPath = getDefaultAuditPath(hostStatePath);
		const endpoint = await bindRawClientEndpoint("disabled");
		const differentEndpoint = await bindRawClientEndpoint("disabled");
		let rawClient;
		let differentClient;
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			workspaceArg,
			"--integrated-volt",
			"--no-pairing",
		]);
		try {
			await waitForFirstStdoutLine(host.child, host.output, "integrated active detach host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"active-detach",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"active detach client",
			]);
			await waitForExit(pairCommand.child, "integrated active detach pair command", pairCommand.output);
			const ticket = pairCommand.output.stdout.trim();
			assert(ticket.startsWith(TICKET_PREFIX), `Expected active detach pair command ticket, got:\n${pairCommand.output.stdout}`);

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "active detach client",
			});
			const initialState = await readRawRpcResponse(
				rawClient,
				{ id: "state-active-detach-initial", type: "get_state" },
				"integrated active detach initial get_state",
			);
			assert(initialState.event.success === true, `Expected initial get_state success, got:\n${initialState.lines.join("\n")}`);
			const sessionId = initialState.event.data?.sessionId;
			assert(sessionId, `Expected initial session id, got:\n${JSON.stringify(initialState.event)}`);

			const prompt = await readRawRpcResponse(
				rawClient,
				{ id: "prompt-active-detach", type: "prompt", message: "recover while detached" },
				"integrated active detach prompt",
			);
			assert(prompt.event.success === true, `Expected active detach prompt success, got:\n${prompt.lines.join("\n")}`);
			await fakeOpenAI.waitForRequest();
			assert(fakeOpenAI.requestCount === 1, `Expected one fake OpenAI request, got ${fakeOpenAI.requestCount}`);

			closeRawConnection(rawClient.connection);
			rawClient = undefined;
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "remote_runtime_detached" &&
					event.details?.sessionId === sessionId &&
					event.details?.active === true,
				"integrated active detach runtime detached",
			);

			differentClient = await openRawAuthorizedClientOnEndpoint(differentEndpoint, ticket, {
				clientLabel: "different active detach client",
				expectSuccess: false,
			});
			assert(
				differentClient.handshakeResponse.success === false &&
					differentClient.handshakeResponse.outcome === "pairing_secret_consumed" &&
					differentClient.handshakeResponse.error === "pairing ticket has already been used",
				`Expected different node to be rejected, got:\n${JSON.stringify(differentClient.handshakeResponse)}`,
			);
			closeRawConnection(differentClient.connection);
			differentClient = undefined;

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "active detach client",
			});
			const reattachedState = await readRawRpcResponse(
				rawClient,
				{ id: "state-active-detach-reattached", type: "get_state" },
				"integrated active detach reattached get_state",
			);
			assert(
				reattachedState.event.success === true,
				`Expected reattached get_state success, got:\n${reattachedState.lines.join("\n")}`,
			);
			assert(
				reattachedState.event.data?.sessionId === sessionId,
				`Expected reattached session ${sessionId}, got:\n${JSON.stringify(reattachedState.event)}`,
			);
			assert(
				reattachedState.event.data?.isStreaming === true,
				`Expected reattached runtime to still be streaming, got:\n${JSON.stringify(reattachedState.event)}`,
			);

			fakeOpenAI.releaseResponse();
			let agentEnd;
			for (let index = 0; !agentEnd && index < 20; index += 1) {
				const { event } = await readRawRpcEvent(rawClient, "integrated active detach completion");
				if (event.type === "agent_end") agentEnd = event;
			}
			assert(agentEnd, "Expected active detached prompt to finish after reconnect");

			const transcript = await readRawRpcResponse(
				rawClient,
				{ id: "transcript-active-detach", type: "get_transcript", limit: 20 },
				"integrated active detach transcript",
			);
			assert(transcript.event.success === true, `Expected transcript success, got:\n${transcript.lines.join("\n")}`);
			assert(
				transcript.event.data?.sessionId === sessionId,
				`Expected transcript session ${sessionId}, got:\n${JSON.stringify(transcript.event)}`,
			);
			const transcriptItems = transcript.event.data?.items ?? [];
			assert(
				transcriptItems.some((item) => item.role === "user" && item.text === "recover while detached"),
				`Expected detached user prompt in transcript, got:\n${JSON.stringify(transcriptItems)}`,
			);
			assert(
				transcriptItems.some((item) => item.role === "assistant" && item.text === responseText),
				`Expected detached assistant response in transcript, got:\n${JSON.stringify(transcriptItems)}`,
			);

			const revokeCommand = spawnSourceCli(["remote", "revoke", rawClient.nodeId, "--state", hostStatePath]);
			await waitForExit(revokeCommand.child, "integrated active detach revoke command", revokeCommand.output);
			await waitForRawConnectionClosed(rawClient.connection, "integrated active detach revoked client");
			rawClient = undefined;

			const revokedClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
				clientLabel: "active detach client",
				expectSuccess: false,
			});
			assert(
				revokedClient.handshakeResponse.success === false &&
					revokedClient.handshakeResponse.outcome === "client_revoked" &&
					revokedClient.handshakeResponse.error === "client is revoked",
				`Expected revoked node to be rejected, got:\n${JSON.stringify(revokedClient.handshakeResponse)}`,
			);
			closeRawConnection(revokedClient.connection);
		} finally {
			closeRawConnection(rawClient?.connection);
			closeRawConnection(differentClient?.connection);
			await endpoint.close();
			await differentEndpoint.close();
			await stopProcess(host.child);
			await fakeOpenAI.close();
		}
	});
}

async function duplicateActiveConnectionScenario() {
	await withStateDir("duplicate-active", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const workspaceArg = `duplicate=${workspacePath}`;
		const endpoint = await bindRawClientEndpoint("disabled");
		let firstClient;
		let duplicateStream;
		try {
			const host = startHost([
				"--state",
				hostStatePath,
				"--agent-dir",
				agentDir,
				"--workspace",
				workspaceArg,
				"--integrated-volt",
				"--once",
			]);
			try {
				const ticket = await waitForFirstStdoutLine(host.child, host.output, "duplicate active host");
				firstClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
					clientLabel: "duplicate active client",
				});
				const firstState = await readRawRpcResponse(
					firstClient,
					{ id: "state-duplicate-first", type: "get_state" },
					"duplicate active first get_state",
				);
				assert(firstState.event.success === true, "Expected first duplicate-active client get_state to succeed");

				duplicateStream = await openRawAuthorizedStreamOnConnection(firstClient, ticket, {
					clientLabel: "duplicate active client",
					expectSuccess: false,
				});
				assert(
					duplicateStream.handshakeResponse.success === false &&
						duplicateStream.handshakeResponse.error === "client already connected",
					`Expected duplicate handshake rejection, got ${JSON.stringify(duplicateStream.handshakeResponse)}`,
				);
				await Promise.resolve(duplicateStream.stream.send.finish?.()).catch(() => {});
				duplicateStream = undefined;

				const stillUsable = await readRawRpcResponse(
					firstClient,
					{ id: "state-duplicate-still-usable", type: "get_state" },
					"duplicate active first client after rejection",
				);
				assert(stillUsable.event.success === true, "Expected first duplicate-active client to remain usable");
				closeRawConnection(firstClient.connection);
				firstClient = undefined;
				await waitForExit(host.child, "duplicate active host", host.output);
			} finally {
				await Promise.resolve(duplicateStream?.stream?.send?.finish?.()).catch(() => {});
				closeRawConnection(firstClient?.connection);
				await stopProcess(host.child);
			}

			const reconnectHost = startHost([
				"--state",
				hostStatePath,
				"--agent-dir",
				agentDir,
				"--workspace",
				workspaceArg,
				"--integrated-volt",
				"--no-pairing",
				"--once",
			]);
			try {
				const reconnectTicket = await waitForFirstStdoutLine(
					reconnectHost.child,
					reconnectHost.output,
					"duplicate active reconnect host",
				);
				firstClient = await openRawAuthorizedClientOnEndpoint(endpoint, reconnectTicket, {
					clientLabel: "duplicate active client",
				});
				const reconnectState = await readRawRpcResponse(
					firstClient,
					{ id: "state-duplicate-reconnect", type: "get_state" },
					"duplicate active reconnect get_state",
				);
				assert(reconnectState.event.success === true, "Expected reconnect after duplicate-active close to succeed");
				closeRawConnection(firstClient.connection);
				firstClient = undefined;
				await waitForExit(reconnectHost.child, "duplicate active reconnect host", reconnectHost.output);
			} finally {
				closeRawConnection(firstClient?.connection);
				await stopProcess(reconnectHost.child);
			}

			const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
			assert(
				auditEvents.some(
					(event) =>
						event.type === "duplicate_connection_rejected" &&
						event.clientNodeId === endpoint.id().toString() &&
						event.workspace === "duplicate" &&
						event.success === false &&
						event.error === "client already connected",
				),
				"Expected duplicate_connection_rejected audit event",
			);
		} finally {
			await Promise.resolve(duplicateStream?.stream?.send?.finish?.()).catch(() => {});
			closeRawConnection(firstClient?.connection);
			await endpoint.close();
		}
	});
}

async function integratedVoltProfileScenario() {
	await withStateDir("integrated-profile", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					defaultProvider: "missing-provider",
					defaultModel: "missing-model",
					profiles: {
						remote: {
							defaultProvider: "iroh-integrated-test",
							defaultModel: "fake-integrated",
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--profile",
			"remote",
			"--workspace",
			`profile=${workspacePath}`,
			"--integrated-volt",
			"--once",
		]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "integrated profile host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "state-profile", type: "get_state" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "integrated profile host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "state-profile");
			assert(response, `Expected integrated profile get_state response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected integrated profile success, got:\n${JSON.stringify(response)}`);
			assert(
				response.data?.model?.provider === "iroh-integrated-test" &&
					response.data?.model?.id === "fake-integrated",
				`Expected profile-selected fake model state, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function integratedVoltEnvProfileScenario() {
	await withStateDir("integrated-env-profile", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		await mkdir(join(agentDir, "commands"), { recursive: true });
		await writeFile(join(agentDir, "commands", "agent.md"), "agent prompt\n");
		await mkdir(join(workspacePath, ".volt", "commands"), { recursive: true });
		await writeFile(join(workspacePath, ".volt", "commands", "project.md"), "project prompt\n");
		await writeFile(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					defaultProvider: "missing-provider",
					defaultModel: "missing-model",
					profiles: {
						remote: {
							defaultProvider: "iroh-integrated-test",
							defaultModel: "fake-integrated",
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const host = startSourceCliRemoteHost(
			[
				"--state",
				hostStatePath,
				"--agent-dir",
				agentDir,
				"--workspace",
				`env-profile=${workspacePath}`,
				"--once",
			],
			{ VOLT_PROFILE: "remote" },
		);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "integrated env profile host");
			assert(ticket.startsWith(TICKET_PREFIX), `Expected first stdout line to be a ticket, got:\n${host.output.stdout}`);
			const lines = await runRawRpcClient(ticket, { id: "state-env-profile", type: "get_state" }, { finishSend: true });
			await waitForExit(host.child, "integrated env profile host", host.output);
			await access(join(agentDir, "prompts", "agent.md"));
			await access(join(workspacePath, ".volt", "prompts", "project.md"));
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "state-env-profile");
			assert(response, `Expected integrated env profile get_state response, got:\n${lines.join("\n")}`);
			assert(response.success === true, `Expected integrated env profile success, got:\n${JSON.stringify(response)}`);
			assert(
				response.data?.model?.provider === "iroh-integrated-test" &&
					response.data?.model?.id === "fake-integrated",
				`Expected env profile-selected fake model state, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function malformedHandshakeScenario() {
	await withStateDir("malformed-handshake", async ({ hostStatePath }) => {
		const cases = [
			{ line: "{", error: "Failed to parse Iroh remote handshake" },
			{ line: "null", error: "Iroh remote handshake must be an object" },
			{ line: "x".repeat(16 * 1024 + 1), error: "Iroh remote handshake line exceeds maximum size of 16384 bytes" },
			{
				line: JSON.stringify({
					type: "volt_iroh_hello",
					protocol: ALPN_TEXT,
					workspace: "Volt",
					secret: "secret",
					clientLabel: {},
				}),
				error: "handshake clientLabel must be a non-empty string",
			},
		];
		for (const testCase of cases) {
			const host = startHost(["--state", hostStatePath, "--once"]);
			try {
				const ticket = await waitForFirstStdoutLine(host.child, host.output, "malformed handshake host");
				const response = await runRawHandshakeLine(ticket, testCase.line);
				await waitForExit(host.child, "malformed handshake host", host.output);
				assert(response.type === "volt_iroh_handshake", `Expected handshake response, got:\n${JSON.stringify(response)}`);
				assert(response.success === false, `Expected handshake failure, got:\n${JSON.stringify(response)}`);
				assert(
					response.error.includes(testCase.error),
					`Expected ${JSON.stringify(testCase.error)}, got:\n${JSON.stringify(response)}`,
				);
			} finally {
				await stopProcess(host.child);
			}
		}
	});
}

async function getStateScenario() {
	await withStateDir("state", async ({ clientStatePath, hostStatePath }) => {
		const { clientOutput } = await runHostClientOnce({
			clientArgs: ["--get-state", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: [],
			hostStatePath,
			label: "get state",
		});
		const state = JSON.parse(clientOutput.stdout);
		assert(state.model.provider === "iroh-poc", `Expected fake provider state, got:\n${clientOutput.stdout}`);
		assert(state.sessionName === "Iroh PoC fake RPC", `Expected fake session state, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.workspace, `Expected remote host workspace, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.hostNodeId, `Expected remote host node id, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.relayMode === "disabled", `Expected remote host relay mode, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.hostName, `Expected remote host name, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.userName, `Expected remote host user, got:\n${clientOutput.stdout}`);
		assert(state.remoteHost?.cwd === "/workspace", `Expected remote host cwd, got:\n${clientOutput.stdout}`);
	});
}

async function statusCommandScenario() {
	await withStateDir("status", async ({ clientStatePath, hostStatePath }) => {
		await runHostClientOnce({
			clientArgs: ["--message", "status", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: [],
			hostStatePath,
			label: "status initial pairing",
		});

		const statusCommand = spawnSourceCli(["remote", "status", "--state", hostStatePath]);
		await waitForExit(statusCommand.child, "remote status command", statusCommand.output);
		const statusText = statusCommand.output.stdout;
		const status = JSON.parse(statusText);
		assert(status.statePath === hostStatePath, `Expected status state path, got:\n${statusText}`);
		assert(status.auditPath === getDefaultAuditPath(hostStatePath), `Expected status audit path, got:\n${statusText}`);
		assert(
			status.warning?.includes("Persisted state only"),
			`Expected persisted-state-only warning, got:\n${statusText}`,
		);
		assert(status.liveStatus?.available === false, `Expected no live status, got:\n${statusText}`);
		assert(status.clientCount === 1, `Expected one status client, got:\n${statusText}`);
		assert(status.revokedClientCount === 0, `Expected no revoked status clients, got:\n${statusText}`);
		assert(status.workspaces?.[0]?.name, `Expected status workspace, got:\n${statusText}`);
		const client = status.clients?.[0];
		assert(client?.nodeId && client.label, `Expected status client identity, got:\n${statusText}`);
		assert(client.allowedTools === "read,grep,find,ls", `Expected status client tools, got:\n${statusText}`);
		assert(
			Array.isArray(client.allowedWorkspaces) && client.allowedWorkspaces.length === 1,
			`Expected status client workspaces, got:\n${statusText}`,
		);
		assert(typeof client.pairedAt === "number", `Expected status pairedAt, got:\n${statusText}`);
		assert(typeof client.lastSeenAt === "number", `Expected status lastSeenAt, got:\n${statusText}`);
		for (const forbidden of [
			"hostSecretKey",
			"consumedPairingSecretHashes",
			"pairingSecretTombstones",
			"pendingPairingTickets",
			"sha256:",
		]) {
			assert(!statusText.includes(forbidden), `Status leaked ${forbidden}:\n${statusText}`);
		}
	});
}

async function pairCommandScenario() {
	await withStateDir("pair-command", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const host = startHost([
			"--state",
			hostStatePath,
			"--workspace",
			`pair-command=${workspacePath}`,
			"--no-pairing",
			"--once",
		]);
		try {
			await waitForFirstStdoutLine(host.child, host.output, "pair command host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"pair-command",
				"--allow-tools",
				"read,grep,find,ls",
				"--label",
				"scenario client",
				"--ttl",
				"30s",
			]);
			await waitForExit(pairCommand.child, "remote pair command", pairCommand.output);
			const pairStdoutLines = pairCommand.output.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
			assert(
				pairStdoutLines.length === 1 && pairStdoutLines[0].startsWith(TICKET_PREFIX),
				`Expected pair command stdout to contain only a ticket, got:\nstdout:\n${pairCommand.output.stdout}\nstderr:\n${pairCommand.output.stderr}`,
			);

			const clientOutput = await runClient(
				pairStdoutLines[0],
				clientStatePath,
				["--message", "pair command", "--timeout-ms", "10000"],
				{ label: "pair command client" },
			);
			await waitForExit(host.child, "pair command host", host.output);
			assert(
				clientOutput.stdout.includes("fake RPC response over Iroh: pair command"),
				`Expected pair command client response, got:\n${clientOutput.stdout}`,
			);

			const hostState = JSON.parse(await readFile(hostStatePath, "utf8"));
			assert(
				hostState.clients?.[0]?.allowedTools === "read,grep,find,ls",
				`Expected pair command client to persist requested tools, got:\n${JSON.stringify(hostState)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function activeRevocationScenario() {
	await withStateDir("active-revoke", async ({ hostStatePath }) => {
		const host = startHost(["--state", hostStatePath, "--once"]);
		let rawClient;
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "active revocation host");
			rawClient = await openRawAuthorizedClient(ticket, { clientLabel: "active revocation client" });
			const startedAt = Date.now();
			const revokeCommand = spawnSourceCli(["remote", "revoke", rawClient.nodeId, "--state", hostStatePath]);
			await waitForExit(revokeCommand.child, "active revocation command", revokeCommand.output);
			await waitForRawConnectionClosed(rawClient.connection, "active revocation client");
			const elapsedMs = Date.now() - startedAt;
			assert(elapsedMs < 1000, `Expected active revocation within 1000ms, took ${elapsedMs}ms`);
			await waitForExit(host.child, "active revocation host", host.output);
			assert(
				revokeCommand.output.stderr.includes(`Active connection revoked for ${rawClient.nodeId}`),
				`Expected active revocation diagnostic, got:\n${revokeCommand.output.stderr}`,
			);
			const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
			assert(
				auditEvents.some(
					(event) =>
						event.type === "active_connection_revoked" &&
						event.clientNodeId === rawClient.nodeId &&
						event.success === true &&
						event.details?.closeReason === "revoked",
				),
				`Expected active_connection_revoked audit event, got:\n${JSON.stringify(auditEvents)}`,
			);
		} finally {
			await closeRawAuthorizedClient(rawClient);
			await stopProcess(host.child);
		}
	});
}

async function pairingAndRevocationScenario() {
	await withStateDir("pairing", async ({ clientStatePath, hostStatePath, stateDir }) => {
		await runHostClientOnce({
			clientArgs: ["--message", "pair", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: [],
			hostStatePath,
			label: "initial pairing",
		});

		const pairedOutput = await runHostCommand(["clients", "--state", hostStatePath]);
		const pairedClients = JSON.parse(pairedOutput.stdout);
		assert(pairedClients.length === 1, `Expected one paired client, got:\n${pairedOutput.stdout}`);
		const pairedClient = pairedClients[0];
		assert(typeof pairedClient.nodeId === "string" && pairedClient.nodeId.length > 0, "Paired client has no node id");

		const noPairingSuccess = await runHostClientOnce({
			clientArgs: ["--message", "paired", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--no-pairing"],
			hostStatePath,
			label: "paired no-pairing",
		});
		assert(
			noPairingSuccess.clientOutput.stdout.includes("fake RPC response over Iroh: paired"),
			`Expected paired client to connect without a pairing secret, got:\n${noPairingSuccess.clientOutput.stdout}`,
		);
		const noPairingPayload = decodeTicketPayload(noPairingSuccess.ticket);
		assert(
			noPairingPayload.expiresAt === undefined,
			`Expected paired-client ticket to omit expiresAt, got:\n${JSON.stringify(noPairingPayload)}`,
		);

		const unpairedClientStatePath = join(stateDir, "unpaired-client.json");
		const unpairedFailure = await expectHostClientFailure({
			clientArgs: ["--message", "unpaired", "--timeout-ms", "10000"],
			clientStatePath: unpairedClientStatePath,
			hostArgs: ["--no-pairing"],
			hostStatePath,
			label: "unpaired no-pairing",
		});
		assert(
			unpairedFailure.clientOutput.stderr.includes("client_unknown: client is not paired"),
			`Expected unpaired client rejection, got:\n${unpairedFailure.clientOutput.stderr}`,
		);

		await runHostCommand(["revoke", pairedClient.nodeId, "--state", hostStatePath]);
		const revokedFailure = await expectHostClientFailure({
			clientArgs: ["--message", "revoked", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--no-pairing"],
			hostStatePath,
			label: "revoked client",
		});
		assert(
			revokedFailure.clientOutput.stderr.includes("client_revoked: client is revoked"),
			`Expected revoked client rejection, got:\n${revokedFailure.clientOutput.stderr}`,
		);
	});
}

async function auditLogScenario() {
	await withStateDir("audit", async ({ clientStatePath, hostStatePath, stateDir }) => {
		await runHostClientOnce({
			clientArgs: ["--message", "audit", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: [],
			hostStatePath,
			label: "audit initial pairing",
		});

		const pairedOutput = await runHostCommand(["clients", "--state", hostStatePath]);
		const pairedClients = JSON.parse(pairedOutput.stdout);
		assert(
			pairedClients.length === 1,
			`Expected one paired client before audit revocation, got:\n${pairedOutput.stdout}`,
		);

		const unpairedClientStatePath = join(stateDir, "unpaired-client.json");
		await expectHostClientFailure({
			clientArgs: ["--message", "unpaired audit", "--timeout-ms", "10000"],
			clientStatePath: unpairedClientStatePath,
			hostArgs: ["--no-pairing"],
			hostStatePath,
			label: "audit unpaired rejection",
		});

		await runHostCommand(["revoke", pairedClients[0].nodeId, "--state", hostStatePath]);

		const agentDir = join(stateDir, "agent-with-invalid-settings");
		const workspacePath = join(stateDir, "runtime-workspace");
		await mkdir(agentDir, { recursive: true });
		await mkdir(workspacePath, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					httpIdleTimeoutMs: -1,
				},
				null,
				2,
			)}\n`,
		);
		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`runtime=${workspacePath}`,
			"--integrated-volt",
			"--once",
		]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "audit runtime failure host");
			let runtimeError;
			try {
				await runRawRpcClient(ticket, { id: "state-runtime-failure", type: "get_state" }, { finishSend: true });
			} catch (error) {
				runtimeError = error;
			}
			assert(runtimeError, "Expected integrated runtime failure client to fail");
			await waitForExit(host.child, "audit runtime failure host", host.output);
		} finally {
			await stopProcess(host.child);
		}

		const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
		const eventTypes = auditEvents.map((event) => event.type);
		for (const eventType of [
			"pairing_ticket_created",
			"pairing_ticket_consumed",
			"client_connected",
			"client_authorized",
			"client_rejected",
			"client_revoked",
			"child_started",
			"child_stopped",
			"client_disconnected",
			"runtime_failure",
		]) {
			assert(eventTypes.includes(eventType), `Expected audit event ${eventType}, got:\n${JSON.stringify(auditEvents)}`);
		}
		assert(
			auditEvents.every((event) => typeof event.timestamp === "number"),
			`Expected every audit event to include a timestamp, got:\n${JSON.stringify(auditEvents)}`,
		);
		assert(
			auditEvents.some((event) => event.type === "runtime_failure" && event.success === false && event.error),
			`Expected failed runtime audit event with an error, got:\n${JSON.stringify(auditEvents)}`,
		);
		assert(
			auditEvents.some((event) => event.type === "client_rejected" && event.success === false),
			`Expected rejected client audit event, got:\n${JSON.stringify(auditEvents)}`,
		);
		assert(
			auditEvents.some((event) => event.type === "child_started" && event.success === true),
			`Expected successful child start audit event, got:\n${JSON.stringify(auditEvents)}`,
		);
		assert(
			auditEvents.some((event) => event.type === "child_stopped" && event.success === true),
			`Expected successful child stop audit event, got:\n${JSON.stringify(auditEvents)}`,
		);
	});
}

async function pairedClientPersistedToolsScenario() {
	await withStateDir("paired-tools", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const { logPath, sourceDir } = await createFakeSourceVolt(stateDir);
		await runHostClientOnce({
			clientArgs: ["--message", "pair read-only", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--source-volt", sourceDir],
			hostStatePath,
			label: "paired tools initial",
		});

		const pairedState = JSON.parse(await readFile(hostStatePath, "utf8"));
		const pairedClient = pairedState.clients?.[0];
		assert(
			pairedClient?.allowedTools === "read,grep,find,ls",
			`Expected paired client to persist read-only tools, got:\n${JSON.stringify(pairedState)}`,
		);

		await runHostClientOnce({
			clientArgs: ["--message", "paired unsafe host defaults", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--source-volt", sourceDir, "--no-pairing", "--allow-tools", "bash", "--yes"],
			hostStatePath,
			label: "paired tools persisted allowlist",
		});

		const entries = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
		assert(entries.length === 2, `Expected two fake source Volt invocations, got:\n${JSON.stringify(entries)}`);
		const secondArgs = entries[1].argv;
		const toolsIndex = secondArgs.indexOf("--tools");
		assert(toolsIndex !== -1, `Expected second invocation to include --tools, got:\n${secondArgs.join(" ")}`);
		assert(
			secondArgs[toolsIndex + 1] === "read,grep,find,ls",
			`Expected persisted read-only tool allowlist despite unsafe host defaults, got:\n${secondArgs.join(" ")}`,
		);
	});
}

async function unsafeToolGateScenario() {
	await withStateDir("unsafe-tools", async ({ clientStatePath, hostStatePath }) => {
		const rejectedHost = startHost(["--state", hostStatePath, "--allow-tools", "bash", "--once"]);
		const rejectedExit = await waitForExit(rejectedHost.child, "unsafe tool rejection host", rejectedHost.output, {
			expectSuccess: false,
		});
		assert(rejectedExit.code !== 0, "Unsafe tool rejection host unexpectedly succeeded");
		assert(
			rejectedHost.output.stderr.includes("Pass --yes to accept unsafe remote tool grants"),
			`Expected --yes guidance for unsafe tool rejection, got:\n${rejectedHost.output.stderr}`,
		);
		assert(
			rejectedHost.output.stdout.trim().length === 0,
			`Unsafe rejected host printed a ticket:\n${rejectedHost.output.stdout}`,
		);

		const { clientOutput } = await runHostClientOnce({
			clientArgs: ["--message", "unsafe accepted", "--timeout-ms", "10000"],
			clientStatePath,
			hostArgs: ["--allow-tools", "read,grep,find,ls,bash", "--yes"],
			hostStatePath,
			label: "unsafe accepted",
		});
		assert(
			clientOutput.stdout.includes("fake RPC response over Iroh: unsafe accepted"),
			`Expected unsafe accepted client response, got:\n${clientOutput.stdout}`,
		);

		const auditEvents = await readAuditEvents(getDefaultAuditPath(hostStatePath));
		assert(
			auditEvents.some(
				(event) =>
					event.type === "unsafe_tools_enabled" &&
					event.success === true &&
					event.details?.approval === "yes_flag" &&
					Array.isArray(event.details?.unsafeTools) &&
					event.details.unsafeTools.includes("bash"),
			),
			`Expected unsafe_tools_enabled audit event, got:\n${JSON.stringify(auditEvents)}`,
		);
	});
}

async function pairingTicketWorkspaceBindingScenario() {
	await withStateDir("workspace-binding", async ({ clientStatePath, hostStatePath, stateDir }) => {
		await writeFile(
			hostStatePath,
			`${JSON.stringify(
				{
					workspaces: [{ name: "private", path: stateDir, allowedTools: "bash" }],
					clients: [],
				},
				null,
				2,
			)}\n`,
		);

		const host = startHost(["--state", hostStatePath, "--workspace", `safe=${stateDir}`, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "workspace-bound ticket host");
			const tamperedPayload = decodeTicketPayload(ticket);
			tamperedPayload.workspace = "private";
			const tamperedTicket = encodeTicketPayload(tamperedPayload);
			const clientOutput = await runClient(tamperedTicket, clientStatePath, ["--message", "private"], {
				expectSuccess: false,
				label: "workspace-bound ticket client",
			});
			await waitForExit(host.child, "workspace-bound ticket host", host.output);
			assert(clientOutput.exit.code !== 0, "Workspace-bound ticket client unexpectedly succeeded");
			assert(
				clientOutput.stderr.includes("workspace_unavailable: workspace not allowed: private"),
				`Expected workspace-bound ticket rejection, got:\n${clientOutput.stderr}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function runningWorkspaceAuthorizationScenario() {
	await withStateDir("running-workspace", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const { logPath, sourceDir } = await createFakeSourceVolt(stateDir);
		const runningWorkspace = join(stateDir, "running");
		const savedWorkspace = join(stateDir, "saved");
		await mkdir(runningWorkspace, { recursive: true });
		await mkdir(savedWorkspace, { recursive: true });
		const canonicalRunningWorkspace = await realpath(runningWorkspace);

		const host = startHost([
			"--state",
			hostStatePath,
			"--workspace",
			`safe=${runningWorkspace}`,
			"--source-volt",
			sourceDir,
			"--once",
		]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "running workspace host");
			await writeFile(
				hostStatePath,
				`${JSON.stringify(
					{
						workspaces: [{ name: "safe", path: savedWorkspace, allowedTools: "bash" }],
						clients: [],
					},
					null,
					2,
				)}\n`,
			);

			const clientOutput = await runClient(ticket, clientStatePath, ["--message", "running workspace", "--timeout-ms", "10000"], {
				label: "running workspace client",
			});
			await waitForExit(host.child, "running workspace host", host.output);
			assert(
				clientOutput.stdout.includes("fake source Volt response: running workspace"),
				`Expected running workspace client response, got:\n${clientOutput.stdout}`,
			);

			const entries = (await readFile(logPath, "utf8"))
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line));
			assert(entries.length === 1, `Expected one fake source Volt invocation, got:\n${JSON.stringify(entries)}`);
			assert(
				entries[0].cwd === canonicalRunningWorkspace,
				`Expected RPC child to run in ${canonicalRunningWorkspace}, got:\n${JSON.stringify(entries[0])}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function expiredTicketScenario() {
	await withStateDir("expired", async ({ clientStatePath }) => {
		const ticket = encodeTicketPayload({
			alpn: ALPN_TEXT,
			expiresAt: Date.now() - 1,
			irohTicket: "not-needed-for-expired-ticket",
			workspace: "volt",
		});
		const clientOutput = await runClient(ticket, clientStatePath, ["--message", "expired"], {
			expectSuccess: false,
			label: "expired ticket client",
		});
		assert(clientOutput.exit.code !== 0, "Expired ticket client unexpectedly succeeded");
		assert(
			clientOutput.stderr.includes("Pairing ticket has expired"),
			`Expected expired ticket rejection, got:\n${clientOutput.stderr}`,
		);
	});
}

async function missingWorkspaceScenario() {
	await withStateDir("missing-workspace", async ({ hostStatePath, stateDir }) => {
		const missingWorkspace = join(stateDir, "missing");
		const host = startHost(["--state", hostStatePath, "--workspace", `missing=${missingWorkspace}`, "--once"]);
		const exit = await waitForExit(host.child, "missing workspace host", host.output, { expectSuccess: false });
		assert(exit.code !== 0, "Missing workspace host unexpectedly succeeded");
		assert(
			host.output.stderr.includes("Workspace path does not exist"),
			`Expected missing workspace preflight failure, got:\n${host.output.stderr}`,
		);
		assert(host.output.stdout.trim().length === 0, `Host printed a ticket before preflight failure:\n${host.output.stdout}`);
	});
}

const scenarios = [
	["prompt round trip", promptRoundTripScenario],
	["raw half-close prompt", rawHalfClosePromptScenario],
	["pair stream abort relaunch reconnect", pairStreamAbortRelaunchReconnectScenario],
	["source Volt half-close prompt", halfClosedSourceVoltPromptScenario],
	["source Volt handled half-close prompt", halfClosedSourceVoltHandledPromptScenario],
	["source Volt retry-cancelled half-close prompt", halfClosedSourceVoltRetryCancelledScenario],
	["source Volt queued steer half-close", halfClosedSourceVoltQueuedSteerScenario],
	["raw command filter", rawCommandFilterScenario],
	["integrated raw command filter", integratedRawCommandFilterScenario],
	["integrated Volt get_state", integratedVoltGetStateScenario],
	["integrated Volt reconnect session", integratedVoltReconnectSessionScenario],
	["integrated Volt detach reattach runtime", integratedVoltDetachReattachRuntimeScenario],
	["integrated Volt detached runtime TTL", integratedVoltDetachedRuntimeTtlScenario],
	["integrated Volt active detach reconnect transcript", integratedVoltActiveDetachReconnectTranscriptScenario],
	["duplicate active connection", duplicateActiveConnectionScenario],
	["integrated Volt profile", integratedVoltProfileScenario],
	["integrated Volt env profile", integratedVoltEnvProfileScenario],
	["malformed handshake", malformedHandshakeScenario],
	["get_state", getStateScenario],
	["status command", statusCommandScenario],
	["pair command", pairCommandScenario],
	["active revocation", activeRevocationScenario],
	["pairing and revocation", pairingAndRevocationScenario],
	["audit log", auditLogScenario],
	["paired client persisted tools", pairedClientPersistedToolsScenario],
	["unsafe tool gates", unsafeToolGateScenario],
	["pairing ticket workspace binding", pairingTicketWorkspaceBindingScenario],
	["running workspace authorization", runningWorkspaceAuthorizationScenario],
	["expired ticket", expiredTicketScenario],
	["missing workspace preflight", missingWorkspaceScenario],
];

async function main() {
	await assertInstalled();
	loadIroh();
	for (const [name, runScenario] of scenarios) {
		process.stdout.write(`Running ${name}... `);
		await runScenario();
		process.stdout.write("passed\n");
	}
	console.log("Iroh remote host scenario tests passed.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
