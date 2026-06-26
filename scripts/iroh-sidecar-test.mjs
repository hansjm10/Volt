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

async function waitForFirstStdoutLine(child, output, label, timeoutMs = TICKET_TIMEOUT_MS) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const newlineIndex = output.stdout.indexOf("\n");
		if (newlineIndex !== -1) {
			return output.stdout.slice(0, newlineIndex).trim();
		}
		if (child.exitCode !== null) {
			throw new Error(`${label} exited before printing a ticket:\n${output.stderr}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} did not print a ticket within ${timeoutMs}ms:\n${output.stderr}`);
}

async function waitForHostReady(child, output, label) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < TICKET_TIMEOUT_MS) {
		if (/(^|\n)control: /.test(output.stderr)) {
			return;
		}
		if (child.exitCode !== null) {
			throw new Error(`${label} exited before becoming ready:\n${output.stderr}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} was not ready within ${TICKET_TIMEOUT_MS}ms:\n${output.stderr}`);
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

function withDefaultTestRelay(args) {
	if (hasFlagArg(args, "relay") || hasFlagArg(args, "mobile")) return args;
	return ["--relay", "disabled", ...args];
}

function startHost(args, options = {}) {
	const hostArgs = options.preserveRelayDefault ? args : withDefaultTestRelay(args);
	return spawnScript(hostScript, withDefaultTestAllowTools(hostArgs));
}

function startSourceCliRemoteHost(args, env = {}) {
	return spawnSourceCli(["remote", "host", ...withDefaultTestAllowTools(withDefaultTestRelay(args))], env);
}

async function runHostCommand(args) {
	const host = spawnScript(hostScript, args);
	await waitForExit(host.child, `host ${args.join(" ")}`, host.output);
	return host.output;
}

async function runClient(ticket, clientStatePath, args, options = {}) {
	const helloArgs = options.helloMode === "conversation" ? [] : ["--legacy-workspace-hello"];
	const client = spawnScript(clientScript, [ticket, "--state", clientStatePath, ...helloArgs, ...args]);
	const exit = await waitForExit(client.child, options.label ?? "client", client.output, {
		expectSuccess: options.expectSuccess ?? true,
		timeoutMs: options.timeoutMs,
	});
	return { ...client.output, exit };
}

async function bindRawClientEndpoint(relayMode, secretKey) {
	const builder = Endpoint.builder();
	if (relayMode === "default") {
		presetN0(builder);
	} else {
		presetMinimal(builder);
		builder.relayMode(RelayMode.disabled());
	}
	if (secretKey) {
		builder.secretKey(secretKey);
	}
	const endpoint = await builder.bind();
	if (relayMode === "default") await endpoint.online();
	return endpoint;
}

function getHostClientHelloMode(hostArgs) {
	return hasFlagArg(hostArgs, "integrated-volt") ? "conversation" : "legacyWorkspace";
}

function createRawHello(payload, clientLabel, clientNodeId, options = {}) {
	const hello = {
		type: "volt_iroh_hello",
		protocol: ALPN_TEXT,
		workspace: payload.workspace,
		secret: payload.secret,
		clientLabel,
		clientNodeId,
	};
	if (options.helloMode === "conversation") {
		return { ...hello, conversation: options.conversation ?? { target: "last" } };
	}
	if (options.helloMode === "workspaceDiscovery") {
		return { ...hello, workspaceDiscovery: { purpose: "list_sessions" } };
	}
	if (options.helloMode === "workspaceManagement") {
		return { ...hello, workspaceManagement: { purpose: "unregister_workspace" } };
	}
	return hello;
}

function assertConversationHandshakeResponse(handshakeResponse, label, options = {}) {
	const expectedTarget = options.conversation?.target ?? "last";
	assert(
		handshakeResponse.hostNodeId &&
			Array.isArray(handshakeResponse.features) &&
			handshakeResponse.features.includes("multi_streams.v1") &&
			handshakeResponse.features.includes("conversation_streams.v1") &&
			typeof handshakeResponse.sessionId === "string" &&
			handshakeResponse.sessionId.length > 0 &&
			handshakeResponse.conversation?.target === expectedTarget &&
			handshakeResponse.conversation?.sessionId === handshakeResponse.sessionId &&
			["resumed", "created", "created_missing_last"].includes(handshakeResponse.conversation?.selection),
		`Expected ${label} conversation handshake metadata, got:\n${JSON.stringify(handshakeResponse)}`,
	);
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
				serializeJsonLine(
					createRawHello(
						payload,
						options.clientLabel ?? `raw-node-${process.pid}`,
						endpoint.id().toString(),
						options,
					),
				),
			),
		);

		const handshake = await readLineFromIroh(stream.recv);
		if (handshake.line === undefined) throw new Error("Host closed before raw RPC handshake response");
		const handshakeResponse = JSON.parse(handshake.line);
		if (handshakeResponse.type !== "volt_iroh_handshake" || !handshakeResponse.success) {
			throw new Error(handshakeResponse.error ?? "Raw RPC handshake rejected");
		}
		if (options.helloMode === "conversation") {
			assertConversationHandshakeResponse(handshakeResponse, "raw RPC", options);
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
				serializeJsonLine(
					createRawHello(
						payload,
						options.clientLabel ?? `raw-node-${process.pid}`,
						endpoint.id().toString(),
						options,
					),
				),
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
		if (handshakeResponse.success === true && options.helloMode === "conversation") {
			assertConversationHandshakeResponse(handshakeResponse, "raw authorized client", options);
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
			serializeJsonLine(
				createRawHello(payload, options.clientLabel ?? `raw-node-${process.pid}`, rawClient.nodeId, options),
			),
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
	if (handshakeResponse.success === true && options.helloMode === "conversation") {
		assertConversationHandshakeResponse(handshakeResponse, "raw authorized stream", options);
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

async function closeRawStream(rawClient) {
	if (!rawClient) return;
	if (rawClient.stream?.send?.reset) {
		await Promise.resolve(rawClient.stream.send.reset(0n)).catch(() => {});
	} else {
		await Promise.resolve(rawClient.stream?.send?.finish?.()).catch(() => {});
	}
	await Promise.resolve(rawClient.stream?.recv?.stop?.(0n)).catch(() => {});
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

async function withOperationTimeout(promise, label, timeoutMs = PROCESS_TIMEOUT_MS) {
	const trackedPromise = Promise.resolve(promise);
	trackedPromise.catch(() => {});
	let timeoutId;
	try {
		return await Promise.race([
			trackedPromise,
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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

async function waitForFakeOpenAIRequestCount(fakeOpenAI, expectedCount, label, timeoutMs = PROCESS_TIMEOUT_MS) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (fakeOpenAI.requestCount >= expectedCount) {
			return;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`${label} expected ${expectedCount} fake OpenAI request(s), got ${fakeOpenAI.requestCount}`);
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
		const clientOutput = await runClient(ticket, clientStatePath, clientArgs, {
			helloMode: getHostClientHelloMode(hostArgs),
			label: `${label} client`,
		});
		await waitForExit(host.child, `${label} host`, host.output);
		return { clientOutput, hostOutput: host.output, ticket };
	} finally {
		await stopProcess(host.child);
	}
}

async function readStartupTicketPayload({ hostArgs, hostStatePath, label, preserveRelayDefault = false }) {
	const host = startHost(["--state", hostStatePath, ...hostArgs], { preserveRelayDefault });
	try {
		const ticket = await waitForFirstStdoutLine(host.child, host.output, `${label} host`);
		return decodeTicketPayload(ticket);
	} finally {
		await stopProcess(host.child);
	}
}

async function assertNoPendingPairingTickets(hostStatePath, label) {
	const state = JSON.parse(await readFile(hostStatePath, "utf8"));
	const pendingTicketCount = state.pendingPairingTickets?.length ?? 0;
	assert(pendingTicketCount === 0, `${label} created ${pendingTicketCount} pending pairing ticket(s)`);
}

async function expectHostClientFailure({ clientArgs, clientStatePath, hostArgs, hostStatePath, label }) {
	const host = startHost(["--state", hostStatePath, "--once", ...hostArgs]);
	try {
		const ticket = await waitForFirstStdoutLine(host.child, host.output, `${label} host`);
		const clientOutput = await runClient(ticket, clientStatePath, clientArgs, {
			expectSuccess: false,
			helloMode: getHostClientHelloMode(hostArgs),
			label: `${label} client`,
		});
		await waitForExit(host.child, `${label} host`, host.output);
		assert(clientOutput.exit.code !== 0, `${label} client unexpectedly succeeded`);
		return { clientOutput, hostOutput: host.output, ticket };
	} finally {
		await stopProcess(host.child);
	}
}

function createSecretFreeWorkspaceTicket(ticket, workspace) {
	const payload = decodeTicketPayload(ticket);
	delete payload.expiresAt;
	delete payload.secret;
	payload.workspace = workspace;
	return encodeTicketPayload(payload);
}

async function runHostClientWithTicketOnce({
	clientArgs,
	clientTimeoutMs,
	clientStatePath,
	expectSuccess = true,
	hostArgs,
	hostExitTimeoutMs,
	hostReadyTimeoutMs,
	hostStatePath,
	label,
	refreshEndpointTicket = false,
	ticket,
	waitForHostExit = true,
}) {
	const host = startHost(["--state", hostStatePath, "--once", ...hostArgs]);
	try {
		const hostTicket = await waitForFirstStdoutLine(host.child, host.output, `${label} host`, hostReadyTimeoutMs);
		let clientTicket = ticket;
		if (refreshEndpointTicket) {
			const hostPayload = decodeTicketPayload(hostTicket);
			const clientPayload = decodeTicketPayload(ticket);
			clientPayload.irohTicket = hostPayload.irohTicket;
			clientPayload.nodeId = hostPayload.nodeId;
			clientPayload.relayMode = hostPayload.relayMode;
			clientTicket = encodeTicketPayload(clientPayload);
		}
		const clientOutput = await runClient(clientTicket, clientStatePath, clientArgs, {
			expectSuccess,
			helloMode: getHostClientHelloMode(hostArgs),
			label: `${label} client`,
			timeoutMs: clientTimeoutMs,
		});
		if (waitForHostExit) {
			await waitForExit(host.child, `${label} host`, host.output, { timeoutMs: hostExitTimeoutMs });
		}
		if (!expectSuccess) {
			assert(clientOutput.exit.code !== 0, `${label} client unexpectedly succeeded`);
		}
		return { clientOutput, hostOutput: host.output };
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
			assert(response.command === privateCommandPath, `Expected raw command path, got:\n${JSON.stringify(response)}`);
			assert(
				response.error === `RPC command not allowed over remote host: ${privateCommandPath}`,
				`Expected raw host-side denial, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
		}
	});
}

async function nonIntegratedStreamModeUnsupportedScenario() {
	await withStateDir("non-integrated-stream-mode-unsupported", async ({ stateDir }) => {
		for (const helloMode of ["conversation", "workspaceDiscovery", "workspaceManagement"]) {
			const hostStatePath = join(stateDir, `${helloMode}.json`);
			const host = startHost(["--state", hostStatePath, "--once"]);
			let rawClient;
			try {
				const ticket = await waitForFirstStdoutLine(host.child, host.output, `${helloMode} unsupported host`);
				rawClient = await openRawAuthorizedClient(ticket, {
					clientLabel: `${helloMode} unsupported client`,
					expectSuccess: false,
					helloMode,
				});
				assert(
					rawClient.handshakeResponse.success === false &&
						rawClient.handshakeResponse.outcome === "conversation_streams_unsupported",
					`Expected ${helloMode} to fail with conversation_streams_unsupported, got:\n${JSON.stringify(
						rawClient.handshakeResponse,
					)}`,
				);
				await waitForExit(host.child, `${helloMode} unsupported host`, host.output);
			} finally {
				await closeRawAuthorizedClient(rawClient);
				await stopProcess(host.child);
			}
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
				{ finishSend: true, helloMode: "conversation" },
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
		const metadataWorkspacePath = join(stateDir, "metadata-workspace");
		await mkdir(workspacePath, { recursive: true });
		await mkdir(metadataWorkspacePath, { recursive: true });
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
			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`metadata-extra=${metadataWorkspacePath}`,
			]);
			await waitForExit(registerCommand.child, "remote metadata workspace register command", registerCommand.output);
			const lines = await runRawRpcClient(
				ticket,
				{ id: "state-integrated", type: "get_state" },
				{ finishSend: true, helloMode: "conversation" },
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
			const remoteHostMetadata = JSON.stringify(response.data?.remoteHost ?? null);
			assert(
				response.data?.remoteHost?.workspace === "integrated" &&
					JSON.stringify(response.data?.remoteHost?.workspaceNames) ===
						JSON.stringify(["integrated", "metadata-extra"]) &&
					JSON.stringify(response.data?.remoteHost?.workspaces) ===
						JSON.stringify([
							{ name: "integrated", status: "available" },
							{ name: "metadata-extra", status: "available" },
						]) &&
					response.data?.remoteHost?.hostNodeId &&
					response.data?.remoteHost?.relayMode === "disabled" &&
					response.data?.remoteHost?.hostName &&
					response.data?.remoteHost?.userName &&
					response.data?.remoteHost?.cwd === "/workspace",
				`Expected integrated remote host metadata, got:\n${JSON.stringify(response.data?.remoteHost)}`,
			);
			assert(
				!remoteHostMetadata.includes(workspacePath) && !remoteHostMetadata.includes(metadataWorkspacePath),
				`Expected remote host metadata to omit host paths, got:\n${remoteHostMetadata}`,
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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
				helloMode: "conversation",
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

async function integratedVoltMultiWorkspaceRuntimeIsolationScenario() {
	await withStateDir("integrated-multi-workspace-runtime", async ({ hostStatePath, stateDir }) => {
		const responseText = "multi workspace completion";
		const fakeOpenAI = await startFakeOpenAICompletionsServer(responseText);
		const agentDir = await createIntegratedVoltAgentDir(stateDir, { baseUrl: fakeOpenAI.baseUrl });
		const alphaWorkspacePath = join(stateDir, "alpha-workspace");
		const betaWorkspacePath = join(stateDir, "beta-workspace");
		await mkdir(alphaWorkspacePath, { recursive: true });
		await mkdir(betaWorkspacePath, { recursive: true });
		const endpoint = await bindRawClientEndpoint("disabled");
		let rawClient;
		let betaClient;

		async function registerWorkspace(name, workspacePath) {
			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`${name}=${workspacePath}`,
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
			]);
			await waitForExit(registerCommand.child, `register ${name} runtime workspace`, registerCommand.output);
			assert(
				registerCommand.output.stderr.includes(`registered workspace: ${name} ->`),
				`Expected ${name} registration confirmation, got:\n${registerCommand.output.stderr}`,
			);
		}

		await registerWorkspace("alpha", alphaWorkspacePath);
		await registerWorkspace("beta", betaWorkspacePath);

		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`alpha=${alphaWorkspacePath}`,
			"--integrated-volt",
			"--no-pairing",
		]);
		try {
			await waitForHostReady(host.child, host.output, "integrated multi-workspace runtime host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"alpha",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"multi-workspace runtime client",
			]);
			await waitForExit(pairCommand.child, "integrated multi-workspace runtime pair command", pairCommand.output);
			const alphaTicket = pairCommand.output.stdout.trim();
			assert(
				alphaTicket.startsWith(TICKET_PREFIX),
				`Expected runtime isolation pair command ticket, got:\n${pairCommand.output.stdout}`,
			);
			const betaTicket = createSecretFreeWorkspaceTicket(alphaTicket, "beta");

			rawClient = await openRawAuthorizedClientOnEndpoint(endpoint, alphaTicket, {
				clientLabel: "multi-workspace runtime client",
				helloMode: "conversation",
			});
			const betaStream = await openRawAuthorizedStreamOnConnection(rawClient, betaTicket, {
				clientLabel: "multi-workspace runtime client",
				helloMode: "conversation",
			});
			betaClient = {
				connection: rawClient.connection,
				handshakeResponse: betaStream.handshakeResponse,
				nodeId: rawClient.nodeId,
				rest: betaStream.rest,
				stream: betaStream.stream,
			};

			const alphaState = await readRawRpcResponse(
				rawClient,
				{ id: "state-runtime-alpha-initial", type: "get_state" },
				"integrated multi-workspace alpha initial get_state",
			);
			const betaState = await readRawRpcResponse(
				betaClient,
				{ id: "state-runtime-beta-initial", type: "get_state" },
				"integrated multi-workspace beta initial get_state",
			);
			assert(alphaState.event.success === true, `Expected alpha get_state success, got:\n${alphaState.lines.join("\n")}`);
			assert(betaState.event.success === true, `Expected beta get_state success, got:\n${betaState.lines.join("\n")}`);
			const alphaSessionId = alphaState.event.data?.sessionId;
			const betaInitialSessionId = betaState.event.data?.sessionId;
			assert(alphaSessionId, `Expected alpha session id, got:\n${JSON.stringify(alphaState.event)}`);
			assert(betaInitialSessionId, `Expected beta session id, got:\n${JSON.stringify(betaState.event)}`);
			assert(
				alphaSessionId !== betaInitialSessionId,
				`Expected independent workspace sessions, got alpha=${alphaSessionId} beta=${betaInitialSessionId}`,
			);

			const betaNewSession = await readRawRpcResponse(
				betaClient,
				{ id: "new-session-runtime-beta", type: "new_session" },
				"integrated multi-workspace beta new_session",
			);
			assert(
				betaNewSession.event.success === true,
				`Expected beta new_session success, got:\n${betaNewSession.lines.join("\n")}`,
			);
			const betaNewState = await readRawRpcResponse(
				betaClient,
				{ id: "state-runtime-beta-new", type: "get_state" },
				"integrated multi-workspace beta get_state after new_session",
			);
			const betaNewSessionId = betaNewState.event.data?.sessionId;
			assert(betaNewSessionId, `Expected beta new session id, got:\n${JSON.stringify(betaNewState.event)}`);
			assert(
				betaNewSessionId !== betaInitialSessionId,
				`Expected beta new_session to change only beta session, got ${betaNewSessionId}`,
			);
			const alphaAfterBetaNew = await readRawRpcResponse(
				rawClient,
				{ id: "state-runtime-alpha-after-beta-new", type: "get_state" },
				"integrated multi-workspace alpha get_state after beta new_session",
			);
			assert(
				alphaAfterBetaNew.event.data?.sessionId === alphaSessionId,
				`Expected alpha session to remain ${alphaSessionId}, got:\n${JSON.stringify(alphaAfterBetaNew.event)}`,
			);

			let hostState = JSON.parse(await readFile(hostStatePath, "utf8"));
			assert(
				hostState.clients?.[0]?.lastSessionIdByWorkspace?.alpha === alphaSessionId &&
					hostState.clients?.[0]?.lastSessionIdByWorkspace?.beta === betaNewSessionId,
				`Expected per-workspace last session IDs after beta new_session, got:\n${JSON.stringify(hostState.clients)}`,
			);

			const alphaList = await readRawRpcResponse(
				rawClient,
				{ id: "list-runtime-alpha", type: "list_sessions" },
				"integrated multi-workspace alpha list_sessions",
			);
			const alphaSessions = alphaList.event.data?.sessions ?? [];
			assert(
				alphaSessions.some((session) => session.sessionId === alphaSessionId) &&
					!alphaSessions.some((session) => session.sessionId === betaInitialSessionId || session.sessionId === betaNewSessionId),
				`Expected alpha list_sessions to stay workspace-scoped, got:\n${JSON.stringify(alphaList.event)}`,
			);
			const betaList = await readRawRpcResponse(
				betaClient,
				{ id: "list-runtime-beta", type: "list_sessions" },
				"integrated multi-workspace beta list_sessions",
			);
			const betaSessions = betaList.event.data?.sessions ?? [];
			assert(
				betaSessions.some((session) => session.sessionId === betaNewSessionId) &&
					!betaSessions.some((session) => session.sessionId === alphaSessionId),
				`Expected beta list_sessions to stay workspace-scoped, got:\n${JSON.stringify(betaList.event)}`,
			);

			const alphaSwitchToBeta = await readRawRpcResponse(
				rawClient,
				{ id: "switch-runtime-alpha-to-beta", type: "switch_session_by_id", sessionId: betaNewSessionId },
				"integrated multi-workspace alpha switch_session_by_id beta",
			);
			assert(
				alphaSwitchToBeta.event.success === false &&
					alphaSwitchToBeta.event.error === `Session not found in current workspace: ${betaNewSessionId}`,
				`Expected alpha to reject beta session switch, got:\n${JSON.stringify(alphaSwitchToBeta.event)}`,
			);
			const betaSwitchCurrent = await readRawRpcResponse(
				betaClient,
				{ id: "switch-runtime-beta-current", type: "switch_session_by_id", sessionId: betaNewSessionId },
				"integrated multi-workspace beta switch_session_by_id current",
			);
			assert(
				betaSwitchCurrent.event.success === true,
				`Expected beta switch_session_by_id success, got:\n${JSON.stringify(betaSwitchCurrent.event)}`,
			);
			hostState = JSON.parse(await readFile(hostStatePath, "utf8"));
			assert(
				hostState.clients?.[0]?.lastSessionIdByWorkspace?.alpha === alphaSessionId &&
					hostState.clients?.[0]?.lastSessionIdByWorkspace?.beta === betaNewSessionId,
				`Expected beta session switch to preserve per-workspace last session IDs, got:\n${JSON.stringify(hostState.clients)}`,
			);

			const alphaPrompt = await readRawRpcResponse(
				rawClient,
				{ id: "prompt-runtime-alpha", type: "prompt", message: "alpha should abort" },
				"integrated multi-workspace alpha prompt",
			);
			const betaPrompt = await readRawRpcResponse(
				betaClient,
				{ id: "prompt-runtime-beta", type: "prompt", message: "beta should finish" },
				"integrated multi-workspace beta prompt",
			);
			assert(alphaPrompt.event.success === true, `Expected alpha prompt success, got:\n${alphaPrompt.lines.join("\n")}`);
			assert(betaPrompt.event.success === true, `Expected beta prompt success, got:\n${betaPrompt.lines.join("\n")}`);
			await waitForFakeOpenAIRequestCount(fakeOpenAI, 2, "integrated multi-workspace runtime prompts");

			const alphaAbort = await readRawRpcResponse(
				rawClient,
				{ id: "abort-runtime-alpha", type: "abort" },
				"integrated multi-workspace alpha abort",
			);
			assert(alphaAbort.event.success === true, `Expected alpha abort success, got:\n${alphaAbort.lines.join("\n")}`);
			const betaStreaming = await readRawRpcResponse(
				betaClient,
				{ id: "state-runtime-beta-streaming", type: "get_state" },
				"integrated multi-workspace beta get_state while alpha aborted",
			);
			assert(
				betaStreaming.event.data?.sessionId === betaNewSessionId && betaStreaming.event.data?.isStreaming === true,
				`Expected beta to keep streaming after alpha abort, got:\n${JSON.stringify(betaStreaming.event)}`,
			);

			fakeOpenAI.releaseResponse();
			let betaAgentEnd;
			for (let index = 0; !betaAgentEnd && index < 20; index += 1) {
				const { event } = await readRawRpcEvent(betaClient, "integrated multi-workspace beta completion");
				if (event.type === "agent_end") betaAgentEnd = event;
			}
			assert(betaAgentEnd, "Expected beta prompt to finish after alpha abort");
			assert(
				betaAgentEnd.messages?.some((message) => message.role === "assistant" && message.stopReason === "stop"),
				`Expected beta prompt to stop normally, got:\n${JSON.stringify(betaAgentEnd)}`,
			);

			const betaTranscript = await readRawRpcResponse(
				betaClient,
				{ id: "transcript-runtime-beta", type: "get_transcript", limit: 20 },
				"integrated multi-workspace beta transcript",
			);
			const betaItems = betaTranscript.event.data?.items ?? [];
			assert(
				betaItems.some((item) => item.role === "user" && item.text === "beta should finish") &&
					betaItems.some((item) => item.role === "assistant" && item.text === responseText),
				`Expected beta transcript to contain only beta completion, got:\n${JSON.stringify(betaTranscript.event)}`,
			);
		} finally {
			await Promise.resolve(betaClient?.stream?.send?.finish?.()).catch(() => {});
			closeRawConnection(rawClient?.connection);
			await endpoint.close();
			await stopProcess(host.child);
			await fakeOpenAI.close();
		}
	});
}

async function nativeIrohMultiStreamLifecycleScenario() {
	await withStateDir("native-multi-stream-lifecycle", async ({ hostStatePath, stateDir }) => {
		const responseText = "native multi-stream completion";
		const fakeOpenAI = await startFakeOpenAICompletionsServer(responseText);
		const agentDir = await createIntegratedVoltAgentDir(stateDir, { baseUrl: fakeOpenAI.baseUrl });
		const alphaWorkspacePath = join(stateDir, "alpha-workspace");
		const betaWorkspacePath = join(stateDir, "beta-workspace");
		await mkdir(alphaWorkspacePath, { recursive: true });
		await mkdir(betaWorkspacePath, { recursive: true });
		const auditPath = getDefaultAuditPath(hostStatePath);
		const endpoint = await bindRawClientEndpoint("disabled");
		let alphaClient;
		let betaClient;
		let reattachedAlphaClient;
		let revokedClient;

		async function registerWorkspace(name, workspacePath) {
			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`${name}=${workspacePath}`,
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
			]);
			await waitForExit(registerCommand.child, `native multi-stream register ${name}`, registerCommand.output);
			assert(
				registerCommand.output.stderr.includes(`registered workspace: ${name} ->`),
				`Expected ${name} registration confirmation`,
			);
		}

		await registerWorkspace("alpha", alphaWorkspacePath);
		await registerWorkspace("beta", betaWorkspacePath);

		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`alpha=${alphaWorkspacePath}`,
			"--integrated-volt",
			"--no-pairing",
		]);
		try {
			await waitForHostReady(host.child, host.output, "native multi-stream lifecycle host");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"alpha",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"native multi-stream client",
			]);
			await waitForExit(pairCommand.child, "native multi-stream pair command", pairCommand.output);
			const alphaTicket = pairCommand.output.stdout.trim();
			assert(
				alphaTicket.startsWith(TICKET_PREFIX),
				"Expected native multi-stream pair command to emit a ticket",
			);
			const alphaReconnectTicket = createSecretFreeWorkspaceTicket(alphaTicket, "alpha");
			const betaTicket = createSecretFreeWorkspaceTicket(alphaTicket, "beta");

			alphaClient = await openRawAuthorizedClientOnEndpoint(endpoint, alphaTicket, {
				clientLabel: "native multi-stream client",
				helloMode: "conversation",
			});
			assert(
				alphaClient.handshakeResponse.features?.includes("multi_streams.v1"),
				`Expected alpha handshake to advertise multi_streams.v1, got ${JSON.stringify(alphaClient.handshakeResponse)}`,
			);
			const betaStream = await openRawAuthorizedStreamOnConnection(alphaClient, betaTicket, {
				clientLabel: "native multi-stream client",
				helloMode: "conversation",
			});
			assert(
				betaStream.handshakeResponse.features?.includes("multi_streams.v1"),
				`Expected beta handshake to advertise multi_streams.v1, got ${JSON.stringify(betaStream.handshakeResponse)}`,
			);
			betaClient = {
				connection: alphaClient.connection,
				handshakeResponse: betaStream.handshakeResponse,
				nodeId: alphaClient.nodeId,
				rest: betaStream.rest,
				stream: betaStream.stream,
			};

			const alphaState = await readRawRpcResponse(
				alphaClient,
				{ id: "state-native-alpha-initial", type: "get_state" },
				"native multi-stream alpha initial get_state",
			);
			const betaState = await readRawRpcResponse(
				betaClient,
				{ id: "state-native-beta-initial", type: "get_state" },
				"native multi-stream beta initial get_state",
			);
			const alphaSessionId = alphaState.event.data?.sessionId;
			const betaSessionId = betaState.event.data?.sessionId;
			assert(
				alphaState.event.success === true &&
					alphaState.event.data?.remoteHost?.workspace === "alpha" &&
					alphaSessionId,
				`Expected alpha get_state success with workspace alpha, got ${JSON.stringify(alphaState.event)}`,
			);
			assert(
				betaState.event.success === true && betaState.event.data?.remoteHost?.workspace === "beta" && betaSessionId,
				`Expected beta get_state success with workspace beta, got ${JSON.stringify(betaState.event)}`,
			);
			assert(
				alphaSessionId !== betaSessionId,
				`Expected distinct alpha and beta sessions, got alpha=${alphaSessionId} beta=${betaSessionId}`,
			);

			const alphaPrompt = await readRawRpcResponse(
				alphaClient,
				{ id: "prompt-native-alpha", type: "prompt", message: "alpha keeps running after stream close" },
				"native multi-stream alpha prompt",
			);
			const betaPrompt = await readRawRpcResponse(
				betaClient,
				{ id: "prompt-native-beta", type: "prompt", message: "beta abort is isolated" },
				"native multi-stream beta prompt",
			);
			assert(alphaPrompt.event.success === true, "Expected alpha prompt to start");
			assert(betaPrompt.event.success === true, "Expected beta prompt to start");
			await waitForFakeOpenAIRequestCount(fakeOpenAI, 2, "native multi-stream concurrent prompts");

			await closeRawStream(alphaClient);
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "remote_runtime_detached" &&
					event.workspace === "alpha" &&
					event.details?.sessionId === alphaSessionId &&
					event.details?.active === true,
				"native multi-stream alpha active detach",
			);

			const betaAfterAlphaClose = await readRawRpcResponse(
				betaClient,
				{ id: "state-native-beta-after-alpha-close", type: "get_state" },
				"native multi-stream beta get_state after alpha close",
			);
			assert(
				betaAfterAlphaClose.event.data?.sessionId === betaSessionId &&
					betaAfterAlphaClose.event.data?.isStreaming === true,
				`Expected beta stream to remain active after alpha closed, got ${JSON.stringify(betaAfterAlphaClose.event)}`,
			);

			const betaAbort = await readRawRpcResponse(
				betaClient,
				{ id: "abort-native-beta", type: "abort" },
				"native multi-stream beta abort",
			);
			assert(betaAbort.event.success === true, `Expected beta abort success, got ${JSON.stringify(betaAbort.event)}`);
			const betaAfterAbort = await readRawRpcResponse(
				betaClient,
				{ id: "state-native-beta-after-abort", type: "get_state" },
				"native multi-stream beta get_state after abort",
			);
			assert(
				betaAfterAbort.event.data?.sessionId === betaSessionId &&
					betaAfterAbort.event.data?.isStreaming === false,
				`Expected beta to stop streaming after abort, got ${JSON.stringify(betaAfterAbort.event)}`,
			);

			const reattachedAlphaStream = await openRawAuthorizedStreamOnConnection(betaClient, alphaReconnectTicket, {
				clientLabel: "native multi-stream client",
				helloMode: "conversation",
			});
			reattachedAlphaClient = {
				connection: betaClient.connection,
				handshakeResponse: reattachedAlphaStream.handshakeResponse,
				nodeId: betaClient.nodeId,
				rest: reattachedAlphaStream.rest,
				stream: reattachedAlphaStream.stream,
			};
			const alphaReattachedState = await readRawRpcResponse(
				reattachedAlphaClient,
				{ id: "state-native-alpha-reattached", type: "get_state" },
				"native multi-stream alpha reattached get_state",
			);
			assert(
				alphaReattachedState.event.data?.sessionId === alphaSessionId &&
					alphaReattachedState.event.data?.isStreaming === true,
				`Expected alpha to keep streaming after beta abort, got ${JSON.stringify(alphaReattachedState.event)}`,
			);

			fakeOpenAI.releaseResponse();
			let alphaAgentEnd;
			for (let index = 0; !alphaAgentEnd && index < 20; index += 1) {
				const { event } = await readRawRpcEvent(
					reattachedAlphaClient,
					"native multi-stream alpha completion after beta abort",
				);
				if (event.type === "agent_end") alphaAgentEnd = event;
			}
			assert(alphaAgentEnd, "Expected alpha prompt to finish after beta abort");
			assert(
				alphaAgentEnd.messages?.some((message) => message.role === "assistant" && message.stopReason === "stop"),
				`Expected alpha prompt to stop normally, got ${JSON.stringify(alphaAgentEnd)}`,
			);

			const revokeCommand = spawnSourceCli(["remote", "revoke", betaClient.nodeId, "--state", hostStatePath]);
			await waitForExit(revokeCommand.child, "native multi-stream revoke command", revokeCommand.output);
			assert(
				revokeCommand.output.stderr.includes(`Active connection revoked for ${betaClient.nodeId}`),
				"Expected active revocation diagnostic for native multi-stream client",
			);
			await waitForRawConnectionClosed(betaClient.connection, "native multi-stream revoked connection");
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "active_connection_revoked" &&
					event.clientNodeId === betaClient.nodeId &&
					event.workspace === "alpha" &&
					event.success === true,
				"native multi-stream alpha revocation",
			);
			await waitForAuditEvent(
				auditPath,
				(event) =>
					event.type === "active_connection_revoked" &&
					event.clientNodeId === betaClient.nodeId &&
					event.workspace === "beta" &&
					event.success === true,
				"native multi-stream beta revocation",
			);

			revokedClient = await openRawAuthorizedClientOnEndpoint(endpoint, alphaReconnectTicket, {
				clientLabel: "native multi-stream client",
				helloMode: "conversation",
				expectSuccess: false,
			});
			assert(
				revokedClient.handshakeResponse.success === false &&
					revokedClient.handshakeResponse.outcome === "client_revoked",
				`Expected revoked native multi-stream client to be rejected, got ${JSON.stringify(revokedClient.handshakeResponse)}`,
			);
		} finally {
			await closeRawStream(alphaClient);
			await closeRawStream(reattachedAlphaClient);
			await closeRawStream(betaClient);
			closeRawConnection(revokedClient?.connection);
			closeRawConnection(betaClient?.connection ?? alphaClient?.connection ?? reattachedAlphaClient?.connection);
			await endpoint.close();
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
		let replacementEndpoint;
		let firstClient;
		let replacementClient;
		let duplicateStream;
		let firstSessionId;
		try {
			const host = startHost([
				"--state",
				hostStatePath,
				"--agent-dir",
				agentDir,
				"--workspace",
				workspaceArg,
				"--integrated-volt",
			]);
			try {
				const ticket = await waitForFirstStdoutLine(host.child, host.output, "duplicate active host");
				firstClient = await openRawAuthorizedClientOnEndpoint(endpoint, ticket, {
					clientLabel: "duplicate active client",
					helloMode: "conversation",
				});
				const firstState = await readRawRpcResponse(
					firstClient,
					{ id: "state-duplicate-first", type: "get_state" },
					"duplicate active first get_state",
				);
				assert(firstState.event.success === true, "Expected first duplicate-active client get_state to succeed");
				firstSessionId = firstState.event.data?.sessionId;
				assert(firstSessionId, `Expected first duplicate-active session id, got ${JSON.stringify(firstState.event)}`);

				duplicateStream = await openRawAuthorizedStreamOnConnection(firstClient, ticket, {
					clientLabel: "duplicate active client",
					helloMode: "conversation",
					expectSuccess: false,
				});
				assert(
					duplicateStream.handshakeResponse.success === false &&
						duplicateStream.handshakeResponse.outcome === "duplicate_conversation_connection" &&
						duplicateStream.handshakeResponse.workspace === "duplicate" &&
						duplicateStream.handshakeResponse.sessionId === firstSessionId &&
						duplicateStream.handshakeResponse.retryAfterMs === 500,
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

				const reconnectPayload = decodeTicketPayload(ticket);
				delete reconnectPayload.expiresAt;
				delete reconnectPayload.secret;
				const reconnectTicket = encodeTicketPayload(reconnectPayload);
				replacementEndpoint = await bindRawClientEndpoint("disabled", endpoint.secretKey().toBytes());
				replacementClient = await withOperationTimeout(
					openRawAuthorizedClientOnEndpoint(replacementEndpoint, reconnectTicket, {
						clientLabel: "duplicate active client",
						helloMode: "conversation",
						expectSuccess: false,
					}),
					"duplicate active replacement connect",
					2000,
				);
				assert(
					replacementClient.handshakeResponse.success === false &&
						replacementClient.handshakeResponse.outcome === "duplicate_conversation_connection" &&
						replacementClient.handshakeResponse.workspace === "duplicate" &&
						replacementClient.handshakeResponse.sessionId === firstSessionId,
					`Expected active replacement to be rejected, got ${JSON.stringify(replacementClient.handshakeResponse)}`,
				);
				closeRawConnection(replacementClient.connection);
				replacementClient = undefined;

				closeRawConnection(firstClient.connection);
				await waitForRawConnectionClosed(firstClient.connection, "duplicate active first closed before reconnect");
				firstClient = undefined;

				replacementClient = await withOperationTimeout(
					openRawAuthorizedClientOnEndpoint(replacementEndpoint, reconnectTicket, {
						clientLabel: "duplicate active client",
						helloMode: "conversation",
					}),
					"duplicate active reconnect after close",
					2000,
				);
				const replacementState = await readRawRpcResponse(
					replacementClient,
					{ id: "state-duplicate-replacement", type: "get_state" },
					"duplicate active replacement get_state",
				);
				assert(replacementState.event.success === true, "Expected replacement duplicate-active client to succeed");

				closeRawConnection(replacementClient.connection);
				replacementClient = undefined;
			} finally {
				await Promise.resolve(duplicateStream?.stream?.send?.finish?.()).catch(() => {});
				closeRawConnection(replacementClient?.connection);
				closeRawConnection(firstClient?.connection);
				await replacementEndpoint?.close();
				replacementEndpoint = undefined;
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
					helloMode: "conversation",
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
						event.error === "duplicate conversation connection" &&
						event.details?.sessionId === firstSessionId &&
						event.details?.retryAfterMs === 500,
				),
				"Expected duplicate_connection_rejected audit event",
			);
			assert(
				!auditEvents.some((event) => event.type === "duplicate_connection_replaced"),
				"Did not expect duplicate_connection_replaced audit event",
			);
		} finally {
			await Promise.resolve(duplicateStream?.stream?.send?.finish?.()).catch(() => {});
			closeRawConnection(replacementClient?.connection);
			await replacementEndpoint?.close();
			closeRawConnection(firstClient?.connection);
			await endpoint.close();
		}
	});
}

async function integratedVoltSameWorkspaceConversationOwnershipScenario() {
	await withStateDir("integrated-same-workspace-conversations", async ({ hostStatePath, stateDir }) => {
		const agentDir = await createIntegratedVoltAgentDir(stateDir);
		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const endpoint = await bindRawClientEndpoint("disabled");
		const secondEndpoint = await bindRawClientEndpoint("disabled");
		let firstClient;
		let newSessionClient;
		let duplicateSessionStream;
		let secondClient;
		let reattachedClient;

		async function pairClient(label) {
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"same",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				label,
			]);
			await waitForExit(pairCommand.child, `${label} pair command`, pairCommand.output);
			const ticket = pairCommand.output.stdout.trim();
			assert(ticket.startsWith(TICKET_PREFIX), `Expected ${label} pair command ticket, got:\n${pairCommand.output.stdout}`);
			return ticket;
		}

		const host = startHost([
			"--state",
			hostStatePath,
			"--agent-dir",
			agentDir,
			"--workspace",
			`same=${workspacePath}`,
			"--integrated-volt",
			"--no-pairing",
		]);
		try {
			await waitForHostReady(host.child, host.output, "integrated same-workspace conversations host");
			const firstTicket = await pairClient("same workspace first client");
			const secondTicket = await pairClient("same workspace second client");

			firstClient = await openRawAuthorizedClientOnEndpoint(endpoint, firstTicket, {
				clientLabel: "same workspace first client",
				helloMode: "conversation",
			});
			const firstState = await readRawRpcResponse(
				firstClient,
				{ id: "state-same-first", type: "get_state" },
				"same workspace first get_state",
			);
			const firstSessionId = firstState.event.data?.sessionId;
			assert(
				firstState.event.success === true && firstSessionId,
				`Expected first same-workspace state with session, got ${JSON.stringify(firstState.event)}`,
			);

			const newSessionStream = await openRawAuthorizedStreamOnConnection(firstClient, firstTicket, {
				clientLabel: "same workspace first client",
				helloMode: "conversation",
				conversation: { target: "new" },
			});
			newSessionClient = {
				connection: firstClient.connection,
				handshakeResponse: newSessionStream.handshakeResponse,
				nodeId: firstClient.nodeId,
				rest: newSessionStream.rest,
				stream: newSessionStream.stream,
			};
			const newSessionState = await readRawRpcResponse(
				newSessionClient,
				{ id: "state-same-new", type: "get_state" },
				"same workspace new-session get_state",
			);
			const newSessionId = newSessionState.event.data?.sessionId;
			assert(
				newSessionState.event.success === true && newSessionId && newSessionId !== firstSessionId,
				`Expected same workspace target:new to create a distinct concurrent session, got ${JSON.stringify(newSessionState.event)}`,
			);

			const firstStillUsable = await readRawRpcResponse(
				firstClient,
				{ id: "state-same-first-still-usable", type: "get_state" },
				"same workspace first still usable",
			);
			assert(
				firstStillUsable.event.data?.sessionId === firstSessionId,
				`Expected first same-workspace stream to remain on ${firstSessionId}, got ${JSON.stringify(firstStillUsable.event)}`,
			);

			duplicateSessionStream = await openRawAuthorizedStreamOnConnection(firstClient, firstTicket, {
				clientLabel: "same workspace first client",
				helloMode: "conversation",
				conversation: { target: "session", sessionId: firstSessionId },
				expectSuccess: false,
			});
			assert(
				duplicateSessionStream.handshakeResponse.success === false &&
					duplicateSessionStream.handshakeResponse.outcome === "duplicate_conversation_connection" &&
					duplicateSessionStream.handshakeResponse.workspace === "same" &&
					duplicateSessionStream.handshakeResponse.sessionId === firstSessionId &&
					duplicateSessionStream.handshakeResponse.retryAfterMs === 500,
				`Expected same-session duplicate rejection with identity details, got ${JSON.stringify(
					duplicateSessionStream.handshakeResponse,
				)}`,
			);
			await Promise.resolve(duplicateSessionStream.stream.send.finish?.()).catch(() => {});
			duplicateSessionStream = undefined;

			secondClient = await openRawAuthorizedClientOnEndpoint(secondEndpoint, secondTicket, {
				clientLabel: "same workspace second client",
				helloMode: "conversation",
				conversation: { target: "session", sessionId: firstSessionId },
				expectSuccess: false,
			});
			assert(
				secondClient.handshakeResponse.success === false &&
					secondClient.handshakeResponse.outcome === "conversation_in_use" &&
					secondClient.handshakeResponse.workspace === "same" &&
					secondClient.handshakeResponse.sessionId === firstSessionId,
				`Expected cross-client same-session ownership rejection, got ${JSON.stringify(secondClient.handshakeResponse)}`,
			);
			closeRawConnection(secondClient.connection);
			secondClient = undefined;

			await closeRawStream(firstClient);
			reattachedClient = await openRawAuthorizedStreamOnConnection(newSessionClient, firstTicket, {
				clientLabel: "same workspace first client",
				helloMode: "conversation",
				conversation: { target: "session", sessionId: firstSessionId },
			});
			const reattached = {
				connection: newSessionClient.connection,
				handshakeResponse: reattachedClient.handshakeResponse,
				nodeId: newSessionClient.nodeId,
				rest: reattachedClient.rest,
				stream: reattachedClient.stream,
			};
			const reattachedState = await readRawRpcResponse(
				reattached,
				{ id: "state-same-reattached", type: "get_state" },
				"same workspace reattached get_state",
			);
			assert(
				reattachedState.event.data?.sessionId === firstSessionId,
				`Expected detached same-session reattach while another same-workspace session is active, got ${JSON.stringify(
					reattachedState.event,
				)}`,
			);
			await closeRawStream(reattached);
			reattachedClient = undefined;
		} finally {
			await Promise.resolve(duplicateSessionStream?.stream?.send?.finish?.()).catch(() => {});
			await closeRawStream(reattachedClient);
			closeRawConnection(secondClient?.connection);
			await closeRawStream(newSessionClient);
			closeRawConnection(firstClient?.connection ?? newSessionClient?.connection);
			await endpoint.close();
			await secondEndpoint.close();
			await stopProcess(host.child);
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
				{ finishSend: true, helloMode: "conversation" },
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
			const lines = await runRawRpcClient(
				ticket,
				{ id: "state-env-profile", type: "get_state" },
				{ finishSend: true, helloMode: "conversation" },
			);
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
					conversation: { target: "last" },
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

async function relayDefaultPolicyScenario() {
	await withStateDir("relay-policy", async ({ stateDir }) => {
		const barePayload = await readStartupTicketPayload({
			hostArgs: ["--once"],
			hostStatePath: join(stateDir, "bare-host.json"),
			label: "bare relay policy",
			preserveRelayDefault: true,
		});
		assert(
			barePayload.relayMode === "default",
			`Expected bare host ticket relay default, got:\n${JSON.stringify(barePayload)}`,
		);

		const mobileStatePath = join(stateDir, "mobile-host.json");
		const mobileHost = startHost(["--state", mobileStatePath, "--mobile"]);
		try {
			await waitForHostReady(mobileHost.child, mobileHost.output, "mobile relay policy host");
			assert(
				mobileHost.output.stdout.trim() === "",
				`Expected mobile startup to avoid printing a ticket, got:\n${mobileHost.output.stdout}`,
			);
			assert(
				mobileHost.output.stderr.includes("startup ticket: disabled"),
				`Expected mobile startup ticket diagnostic, got:\n${mobileHost.output.stderr}`,
			);
			await assertNoPendingPairingTickets(mobileStatePath, "mobile startup");
		} finally {
			await stopProcess(mobileHost.child);
		}

		const mobileNoPairingPayload = await readStartupTicketPayload({
			hostArgs: ["--mobile", "--no-pairing", "--once"],
			hostStatePath: join(stateDir, "mobile-no-pairing-host.json"),
			label: "mobile no-pairing relay policy",
		});
		assert(
			mobileNoPairingPayload.relayMode === "default",
			`Expected explicit mobile paired-client ticket relay default, got:\n${JSON.stringify(mobileNoPairingPayload)}`,
		);
		assert(
			mobileNoPairingPayload.secret === undefined && mobileNoPairingPayload.expiresAt === undefined,
			`Expected explicit mobile paired-client ticket to omit pairing secret, got:\n${JSON.stringify(mobileNoPairingPayload)}`,
		);

		const optOutPayload = await readStartupTicketPayload({
			hostArgs: ["--relay", "disabled", "--no-pairing", "--once"],
			hostStatePath: join(stateDir, "opt-out-host.json"),
			label: "relay opt-out policy",
		});
		assert(
			optOutPayload.relayMode === "disabled",
			`Expected relay opt-out ticket relay disabled, got:\n${JSON.stringify(optOutPayload)}`,
		);

		const workspacePath = join(stateDir, "workspace");
		await mkdir(workspacePath, { recursive: true });
		const pairStatePath = join(stateDir, "mobile-pair-host.json");
		const clientStatePath = join(stateDir, "mobile-client.json");
		const host = startHost([
			"--state",
			pairStatePath,
			"--mobile",
			"--workspace",
			`mobile=${workspacePath}`,
		]);
		let pairTicket;
		try {
			await waitForHostReady(host.child, host.output, "mobile explicit pair host");
			assert(
				host.output.stdout.trim() === "",
				`Expected explicit mobile pair host startup to avoid printing a ticket, got:\n${host.output.stdout}`,
			);
			await assertNoPendingPairingTickets(pairStatePath, "mobile explicit pair startup");
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				pairStatePath,
				"--workspace",
				"mobile",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"mobile client",
			]);
			await waitForExit(pairCommand.child, "mobile relay policy pair command", pairCommand.output);
			pairTicket = pairCommand.output.stdout.trim();
			assert(pairTicket.startsWith(TICKET_PREFIX), `Expected pair command ticket, got:\n${pairCommand.output.stdout}`);
			const pairPayload = decodeTicketPayload(pairTicket);
			assert(
				pairPayload.relayMode === "default",
				`Expected mobile pair command ticket relay default, got:\n${JSON.stringify(pairPayload)}`,
			);
			assert(
				typeof pairPayload.secret === "string" && pairPayload.secret.length > 0,
				`Expected mobile pair command ticket to include pairing secret, got:\n${JSON.stringify(pairPayload)}`,
			);
			assert(
				typeof pairPayload.expiresAt === "number",
				`Expected mobile pair command ticket to include expiry, got:\n${JSON.stringify(pairPayload)}`,
			);
			await runClient(pairTicket, clientStatePath, ["--message", "mobile pair", "--timeout-ms", "10000"], {
				label: "mobile explicit pair client",
			});
		} finally {
			await stopProcess(host.child);
		}

		const restartHost = startHost([
			"--state",
			pairStatePath,
			"--mobile",
			"--workspace",
			`mobile=${workspacePath}`,
		]);
		try {
			await waitForHostReady(restartHost.child, restartHost.output, "mobile reconnect host");
			assert(
				restartHost.output.stdout.trim() === "",
				`Expected mobile restart to avoid printing a ticket, got:\n${restartHost.output.stdout}`,
			);
			await assertNoPendingPairingTickets(pairStatePath, "mobile restart");
			const reconnectPayload = decodeTicketPayload(pairTicket);
			delete reconnectPayload.secret;
			delete reconnectPayload.expiresAt;
			const reconnectTicket = encodeTicketPayload(reconnectPayload);
			await runClient(reconnectTicket, clientStatePath, ["--message", "mobile reconnect", "--timeout-ms", "10000"], {
				label: "mobile reconnect client",
			});
		} finally {
			await stopProcess(restartHost.child);
		}
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
			Array.isArray(client.allowedWorkspaces) && client.allowedWorkspaces.length === 0,
			`Expected status client wildcard workspaces, got:\n${statusText}`,
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
		const registeredWorkspacePath = join(stateDir, "registered-workspace");
		const staleWorkspacePath = join(stateDir, "stale-workspace");
		await mkdir(workspacePath, { recursive: true });
		await mkdir(registeredWorkspacePath, { recursive: true });
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
			const stateWithStaleWorkspace = JSON.parse(await readFile(hostStatePath, "utf8"));
			stateWithStaleWorkspace.workspaces.push({
				name: "stale",
				path: staleWorkspacePath,
				allowedTools: DEFAULT_TEST_ALLOW_TOOLS,
			});
			await writeFile(hostStatePath, `${JSON.stringify(stateWithStaleWorkspace, null, 2)}\n`);
			const stalePairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"stale",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
			]);
			const stalePairExit = await waitForExit(stalePairCommand.child, "remote stale pair command", stalePairCommand.output, {
				expectSuccess: false,
			});
			assert(stalePairExit.code !== 0, "Stale workspace pair command unexpectedly succeeded");
			assert(
				stalePairCommand.output.stderr.includes("workspace_unavailable: workspace path is unavailable: stale"),
				`Expected stale workspace_unavailable pair rejection, got:\n${stalePairCommand.output.stderr}`,
			);
			const stateAfterStalePair = JSON.parse(await readFile(hostStatePath, "utf8"));
			assert(
				!(stateAfterStalePair.pendingPairingTickets ?? []).some((ticket) => ticket.workspace === "stale"),
				`Expected stale pair rejection to create no ticket, got:\n${JSON.stringify(stateAfterStalePair)}`,
			);

			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`registered=${registeredWorkspacePath}`,
			]);
			await waitForExit(registerCommand.child, "remote register workspace command", registerCommand.output);
			assert(
				registerCommand.output.stderr.includes("registered workspace: registered ->"),
				`Expected workspace registration confirmation, got:\n${registerCommand.output.stderr}`,
			);
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"registered",
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
			assert(
				decodeTicketPayload(pairStdoutLines[0]).workspace === "registered",
				`Expected registered workspace ticket, got:\n${pairStdoutLines[0]}`,
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
			assert(
				hostState.clients?.[0]?.allowedWorkspaces?.length === 0,
				`Expected pair command client to persist wildcard workspaces, got:\n${JSON.stringify(hostState)}`,
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

async function multiWorkspaceReconnectScenario() {
	await withStateDir("multi-workspace", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const { logPath, sourceDir } = await createFakeSourceVolt(stateDir);
		const alphaWorkspacePath = join(stateDir, "alpha-workspace");
		const betaWorkspacePath = join(stateDir, "beta-workspace");
		await mkdir(alphaWorkspacePath, { recursive: true });
		await mkdir(betaWorkspacePath, { recursive: true });
		const canonicalAlphaWorkspacePath = await realpath(alphaWorkspacePath);
		const canonicalBetaWorkspacePath = await realpath(betaWorkspacePath);

		async function registerWorkspace(name, workspacePath) {
			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`${name}=${workspacePath}`,
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
			]);
			await waitForExit(registerCommand.child, `register ${name} workspace`, registerCommand.output);
			assert(
				registerCommand.output.stderr.includes(`registered workspace: ${name} ->`),
				`Expected ${name} registration confirmation, got:\n${registerCommand.output.stderr}`,
			);
		}

		const hostArgs = ["--source-volt", sourceDir, "--relay", "default", "--no-pairing"];
		const relayHostReadyTimeoutMs = 30_000;
		const relayHostExitTimeoutMs = 30_000;
		const relayClientTimeoutMs = 30_000;
		await registerWorkspace("alpha", alphaWorkspacePath);

		let pairTicket;
		const pairHost = startHost(["--state", hostStatePath, "--once", ...hostArgs]);
		try {
			await waitForFirstStdoutLine(
				pairHost.child,
				pairHost.output,
				"multi-workspace pair host",
				relayHostReadyTimeoutMs,
			);
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				"alpha",
				"--relay",
				"default",
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				"multi-workspace client",
			]);
			await waitForExit(pairCommand.child, "multi-workspace pair command", pairCommand.output);
			const pairStdoutLines = pairCommand.output.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
			assert(
				pairStdoutLines.length === 1 && pairStdoutLines[0].startsWith(TICKET_PREFIX),
				`Expected multi-workspace pair command to emit one ticket, got:\nstdout:\n${pairCommand.output.stdout}\nstderr:\n${pairCommand.output.stderr}`,
			);
			pairTicket = pairStdoutLines[0];
			const pairPayload = decodeTicketPayload(pairTicket);
			assert(pairPayload.workspace === "alpha", `Expected alpha pairing ticket, got:\n${JSON.stringify(pairPayload)}`);
			assert(pairPayload.relayMode === "default", `Expected relay default ticket, got:\n${JSON.stringify(pairPayload)}`);
			assert(pairPayload.secret, `Expected initial pairing ticket to include a secret, got:\n${JSON.stringify(pairPayload)}`);

			const initialPairOutput = await runClient(
				pairTicket,
				clientStatePath,
				["--message", "multi workspace pair", "--timeout-ms", "10000"],
				{ label: "multi-workspace initial pair client", timeoutMs: relayClientTimeoutMs },
			);
			assert(
				initialPairOutput.stdout.includes("fake source Volt response: multi workspace pair"),
				`Expected initial pair response, got:\n${initialPairOutput.stdout}`,
			);
		} finally {
			await stopProcess(pairHost.child);
		}
		assert(pairTicket, "Pair command did not produce a ticket");

		await registerWorkspace("beta", betaWorkspacePath);

		const alphaReconnectTicket = createSecretFreeWorkspaceTicket(pairTicket, "alpha");
		const betaReconnectTicket = createSecretFreeWorkspaceTicket(pairTicket, "beta");
		for (const [name, ticket] of [
			["alpha", alphaReconnectTicket],
			["beta", betaReconnectTicket],
		]) {
			const payload = decodeTicketPayload(ticket);
			assert(payload.workspace === name, `Expected ${name} reconnect ticket, got:\n${JSON.stringify(payload)}`);
			assert(payload.relayMode === "default", `Expected ${name} reconnect relay default, got:\n${JSON.stringify(payload)}`);
			assert(payload.secret === undefined, `Expected ${name} reconnect ticket to omit secret, got:\n${JSON.stringify(payload)}`);
			assert(
				payload.expiresAt === undefined,
				`Expected ${name} reconnect ticket to omit expiresAt, got:\n${JSON.stringify(payload)}`,
			);
		}

		const refreshed = await runHostClientWithTicketOnce({
			clientArgs: ["--get-state", "--timeout-ms", "10000"],
			clientTimeoutMs: relayClientTimeoutMs,
			clientStatePath,
			hostArgs,
			hostExitTimeoutMs: relayHostExitTimeoutMs,
			hostReadyTimeoutMs: relayHostReadyTimeoutMs,
			hostStatePath,
			label: "multi-workspace metadata refresh",
			refreshEndpointTicket: true,
			ticket: alphaReconnectTicket,
			waitForHostExit: false,
		});
		const refreshedState = JSON.parse(refreshed.clientOutput.stdout);
		assert(
			refreshedState.remoteHost?.workspace === "alpha" &&
				JSON.stringify(refreshedState.remoteHost?.workspaceNames) === JSON.stringify(["alpha", "beta"]) &&
				JSON.stringify(refreshedState.remoteHost?.workspaces) ===
					JSON.stringify([
						{ name: "alpha", status: "available" },
						{ name: "beta", status: "available" },
					]),
			`Expected refreshed workspace names alpha,beta, got:\n${refreshed.clientOutput.stdout}`,
		);

		const betaOutput = await runHostClientWithTicketOnce({
			clientArgs: ["--message", "multi workspace beta", "--timeout-ms", "10000"],
			clientTimeoutMs: relayClientTimeoutMs,
			clientStatePath,
			hostArgs,
			hostExitTimeoutMs: relayHostExitTimeoutMs,
			hostReadyTimeoutMs: relayHostReadyTimeoutMs,
			hostStatePath,
			label: "multi-workspace beta reconnect",
			refreshEndpointTicket: true,
			ticket: betaReconnectTicket,
			waitForHostExit: false,
		});
		assert(
			betaOutput.clientOutput.stdout.includes("fake source Volt response: multi workspace beta"),
			`Expected beta reconnect response, got:\n${betaOutput.clientOutput.stdout}`,
		);

		const alphaOutput = await runHostClientWithTicketOnce({
			clientArgs: ["--message", "multi workspace alpha", "--timeout-ms", "10000"],
			clientTimeoutMs: relayClientTimeoutMs,
			clientStatePath,
			hostArgs,
			hostExitTimeoutMs: relayHostExitTimeoutMs,
			hostReadyTimeoutMs: relayHostReadyTimeoutMs,
			hostStatePath,
			label: "multi-workspace alpha reconnect",
			refreshEndpointTicket: true,
			ticket: alphaReconnectTicket,
			waitForHostExit: false,
		});
		assert(
			alphaOutput.clientOutput.stdout.includes("fake source Volt response: multi workspace alpha"),
			`Expected alpha reconnect response, got:\n${alphaOutput.clientOutput.stdout}`,
		);

		const entries = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
		const expectedCwds = [
			canonicalAlphaWorkspacePath,
			canonicalAlphaWorkspacePath,
			canonicalBetaWorkspacePath,
			canonicalAlphaWorkspacePath,
		];
		assert(
			JSON.stringify(entries.map((entry) => entry.cwd)) === JSON.stringify(expectedCwds),
			`Expected child cwd sequence ${JSON.stringify(expectedCwds)}, got:\n${JSON.stringify(entries)}`,
		);

		const pairedOutput = await runHostCommand(["clients", "--state", hostStatePath]);
		const pairedClients = JSON.parse(pairedOutput.stdout);
		assert(pairedClients.length === 1, `Expected one multi-workspace client, got:\n${pairedOutput.stdout}`);
		assert(
			Array.isArray(pairedClients[0].allowedWorkspaces) && pairedClients[0].allowedWorkspaces.length === 0,
			`Expected multi-workspace client to have wildcard workspace grant, got:\n${pairedOutput.stdout}`,
		);
		await runHostCommand(["revoke", pairedClients[0].nodeId, "--state", hostStatePath]);

		for (const [name, ticket] of [
			["beta", betaReconnectTicket],
			["alpha", alphaReconnectTicket],
		]) {
			const revoked = await runHostClientWithTicketOnce({
				clientArgs: ["--get-state", "--timeout-ms", "10000"],
				clientTimeoutMs: relayClientTimeoutMs,
				clientStatePath,
				expectSuccess: false,
				hostArgs,
				hostExitTimeoutMs: relayHostExitTimeoutMs,
				hostReadyTimeoutMs: relayHostReadyTimeoutMs,
				hostStatePath,
				label: `multi-workspace revoked ${name} reconnect`,
				refreshEndpointTicket: true,
				ticket,
				waitForHostExit: false,
			});
			assert(
				revoked.clientOutput.stderr.includes("client_revoked: client is revoked"),
				`Expected revoked ${name} reconnect to fail with client_revoked, got:\n${revoked.clientOutput.stderr}`,
			);
		}

		const finalEntries = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
		assert(
			finalEntries.length === expectedCwds.length,
			`Expected revoked reconnects not to start child processes, got:\n${JSON.stringify(finalEntries)}`,
		);
	});
}

async function runningWorkspaceUnregisterScenario() {
	await withStateDir("running-unregister", async ({ clientStatePath, hostStatePath, stateDir }) => {
		const { sourceDir } = await createFakeSourceVolt(stateDir);
		const alphaWorkspacePath = join(stateDir, "alpha-workspace");
		const betaWorkspacePath = join(stateDir, "beta-workspace");
		await mkdir(alphaWorkspacePath, { recursive: true });
		await mkdir(betaWorkspacePath, { recursive: true });
		const canonicalAlphaWorkspacePath = await realpath(alphaWorkspacePath);
		const canonicalBetaWorkspacePath = await realpath(betaWorkspacePath);

		async function registerWorkspace(name, workspacePath) {
			const registerCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--register-workspace",
				`${name}=${workspacePath}`,
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
			]);
			await waitForExit(registerCommand.child, `running unregister register ${name}`, registerCommand.output);
		}

		async function createPairTicket(workspace, label) {
			const pairCommand = spawnSourceCli([
				"remote",
				"pair",
				"--state",
				hostStatePath,
				"--workspace",
				workspace,
				"--allow-tools",
				DEFAULT_TEST_ALLOW_TOOLS,
				"--label",
				label,
			]);
			await waitForExit(pairCommand.child, `running unregister pair ${workspace}`, pairCommand.output);
			const pairStdoutLines = pairCommand.output.stdout
				.trim()
				.split("\n")
				.filter((line) => line.length > 0);
			assert(
				pairStdoutLines.length === 1 && pairStdoutLines[0].startsWith(TICKET_PREFIX),
				`Expected running unregister pair command to emit one ticket, got:\nstdout:\n${pairCommand.output.stdout}\nstderr:\n${pairCommand.output.stderr}`,
			);
			return pairStdoutLines[0];
		}

		function assertRemoteHostWorkspaces(metadata, expectedNames, label) {
			const expectedWorkspaces = expectedNames.map((name) => ({ name, status: "available" }));
			assert(
				JSON.stringify(metadata?.workspaceNames) === JSON.stringify(expectedNames),
				`Expected ${label} workspaceNames ${JSON.stringify(expectedNames)}, got:\n${JSON.stringify(metadata)}`,
			);
			assert(
				JSON.stringify(metadata?.workspaces) === JSON.stringify(expectedWorkspaces),
				`Expected ${label} workspaces ${JSON.stringify(expectedWorkspaces)}, got:\n${JSON.stringify(metadata)}`,
			);
			const metadataText = JSON.stringify(metadata ?? null);
			for (const workspacePath of [canonicalAlphaWorkspacePath, canonicalBetaWorkspacePath, stateDir]) {
				assert(
					!metadataText.includes(workspacePath),
					`Expected ${label} metadata to omit host path ${workspacePath}, got:\n${metadataText}`,
				);
			}
		}

		await registerWorkspace("alpha", alphaWorkspacePath);
		await registerWorkspace("beta", betaWorkspacePath);

		const host = startHost([
			"--state",
			hostStatePath,
			"--workspace",
			`alpha=${alphaWorkspacePath}`,
			"--source-volt",
			sourceDir,
			"--no-pairing",
		]);
		let rawClient;
		try {
			await waitForFirstStdoutLine(host.child, host.output, "running unregister host");
			const initialPairTicket = await createPairTicket("alpha", "running unregister active client");
			rawClient = await openRawAuthorizedClient(initialPairTicket, {
				clientLabel: "running unregister active client",
			});
			const initialStateResponse = await readRawRpcResponse(
				rawClient,
				{ id: "running-unregister-state-before", type: "get_state" },
				"running unregister initial get_state",
			);
			assertRemoteHostWorkspaces(initialStateResponse.event.data?.remoteHost, ["alpha", "beta"], "initial");

			const unregisterCommand = spawnSourceCli([
				"remote",
				"host",
				"--state",
				hostStatePath,
				"--unregister-workspace",
				"beta",
			]);
			await waitForExit(unregisterCommand.child, "running unregister command", unregisterCommand.output);
			assert(
				unregisterCommand.output.stderr.includes("Unregistered workspace beta"),
				`Expected unregister confirmation, got:\n${unregisterCommand.output.stderr}`,
			);
			const stateAfterUnregister = JSON.parse(await readFile(hostStatePath, "utf8"));
			assert(
				JSON.stringify(stateAfterUnregister.workspaces?.map((workspace) => workspace.name)) === JSON.stringify(["alpha"]),
				`Expected beta removed from host state, got:\n${JSON.stringify(stateAfterUnregister.workspaces)}`,
			);

			const activeStateResponse = await readRawRpcResponse(
				rawClient,
				{ id: "running-unregister-active-state-after", type: "get_state" },
				"running unregister active get_state after unregister",
			);
			assert(
				activeStateResponse.event.success === true,
				`Expected active connection to remain usable after unregister, got:\n${JSON.stringify(activeStateResponse.event)}`,
			);

			const futurePairTicket = await createPairTicket("alpha", "running unregister future client");
			const futureClientOutput = await runClient(
				futurePairTicket,
				clientStatePath,
				["--get-state", "--timeout-ms", "10000"],
				{ label: "running unregister future get_state" },
			);
			const futureState = JSON.parse(futureClientOutput.stdout);
			assertRemoteHostWorkspaces(futureState.remoteHost, ["alpha"], "future");
		} finally {
			await closeRawAuthorizedClient(rawClient);
			await stopProcess(host.child);
		}
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
				await runRawRpcClient(
					ticket,
					{ id: "state-runtime-failure", type: "get_state" },
					{ finishSend: true, helloMode: "conversation" },
				);
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
				clientOutput.stderr.includes(
					"workspace_authorization_removed: pairing ticket is not valid for workspace: private",
				),
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
		const canonicalSavedWorkspace = await realpath(savedWorkspace);

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
				entries[0].cwd === canonicalSavedWorkspace,
				`Expected RPC child to run in ${canonicalSavedWorkspace}, got:\n${JSON.stringify(entries[0])}`,
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
	["non-integrated stream mode unsupported", nonIntegratedStreamModeUnsupportedScenario],
	["integrated raw command filter", integratedRawCommandFilterScenario],
	["integrated Volt get_state", integratedVoltGetStateScenario],
	["integrated Volt reconnect session", integratedVoltReconnectSessionScenario],
	["integrated Volt detach reattach runtime", integratedVoltDetachReattachRuntimeScenario],
	["integrated Volt detached runtime TTL", integratedVoltDetachedRuntimeTtlScenario],
	["integrated Volt active detach reconnect transcript", integratedVoltActiveDetachReconnectTranscriptScenario],
	["integrated Volt multi-workspace runtime isolation", integratedVoltMultiWorkspaceRuntimeIsolationScenario],
	["native Iroh multi-stream lifecycle", nativeIrohMultiStreamLifecycleScenario],
	["duplicate active connection", duplicateActiveConnectionScenario],
	["integrated Volt same-workspace conversation ownership", integratedVoltSameWorkspaceConversationOwnershipScenario],
	["integrated Volt profile", integratedVoltProfileScenario],
	["integrated Volt env profile", integratedVoltEnvProfileScenario],
	["malformed handshake", malformedHandshakeScenario],
	["get_state", getStateScenario],
	["relay default policy", relayDefaultPolicyScenario],
	["status command", statusCommandScenario],
	["pair command", pairCommandScenario],
	["active revocation", activeRevocationScenario],
	["pairing and revocation", pairingAndRevocationScenario],
	["multi-workspace reconnect", multiWorkspaceReconnectScenario],
	["running workspace unregister", runningWorkspaceUnregisterScenario],
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
	const scenarioFilter = process.env.VOLT_IROH_SCENARIO;
	const selectedScenarios = scenarioFilter
		? scenarios.filter(([name]) => name.includes(scenarioFilter))
		: scenarios;
	assert(selectedScenarios.length > 0, `No Iroh remote host scenario matches ${JSON.stringify(scenarioFilter)}`);
	for (const [name, runScenario] of selectedScenarios) {
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
