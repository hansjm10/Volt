#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import iroh from "../packages/coding-agent/examples/remote/iroh-sidecar/node_modules/@number0/iroh/index.js";
import {
	ALPN,
	ALPN_TEXT,
	decodeTicketPayload,
	encodeTicketPayload,
	readJsonlFromIroh,
	readLineFromIroh,
	serializeJsonLine,
	toBytes,
} from "../packages/coding-agent/examples/remote/iroh-sidecar/common.mjs";

const { Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sidecarDir = join(repoRoot, "packages", "coding-agent", "examples", "remote", "iroh-sidecar");
const hostScript = join(sidecarDir, "host.mjs");
const clientScript = join(sidecarDir, "client.mjs");
const irohPackageJson = join(sidecarDir, "node_modules", "@number0", "iroh", "package.json");
const PROCESS_TIMEOUT_MS = 15_000;
const TICKET_TIMEOUT_MS = 10_000;

async function assertInstalled() {
	try {
		await access(irohPackageJson);
	} catch {
		throw new Error("Iroh sidecar dependencies are not installed. Run: npm run iroh:poc:install");
	}
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
	const child = spawn(process.execPath, [script, ...args], {
		cwd: repoRoot,
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

function startHost(args) {
	return spawnScript(hostScript, args);
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

async function rawCommandFilterScenario() {
	await withStateDir("raw-filter", async ({ hostStatePath }) => {
		const host = startHost(["--state", hostStatePath, "--once"]);
		try {
			const ticket = await waitForFirstStdoutLine(host.child, host.output, "raw command filter host");
			const lines = await runRawRpcClient(
				ticket,
				{ id: "bash-1", type: "bash", command: "echo blocked" },
				{ finishSend: true },
			);
			await waitForExit(host.child, "raw command filter host", host.output);
			const responses = lines.map((line) => JSON.parse(line));
			const response = responses.find((event) => event.id === "bash-1");
			assert(response, `Expected host-side bash denial response, got:\n${lines.join("\n")}`);
			assert(response.success === false, `Expected bash denial to fail, got:\n${JSON.stringify(response)}`);
			assert(
				response.error === "RPC command not allowed over remote sidecar: bash",
				`Expected host-side bash denial, got:\n${JSON.stringify(response)}`,
			);
		} finally {
			await stopProcess(host.child);
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

		const unpairedClientStatePath = join(stateDir, "unpaired-client.json");
		const unpairedFailure = await expectHostClientFailure({
			clientArgs: ["--message", "unpaired", "--timeout-ms", "10000"],
			clientStatePath: unpairedClientStatePath,
			hostArgs: ["--no-pairing"],
			hostStatePath,
			label: "unpaired no-pairing",
		});
		assert(
			unpairedFailure.clientOutput.stderr.includes("client is not paired"),
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
			revokedFailure.clientOutput.stderr.includes("client is not paired"),
			`Expected revoked client rejection, got:\n${revokedFailure.clientOutput.stderr}`,
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
				clientOutput.stderr.includes("workspace not allowed: private"),
				`Expected workspace-bound ticket rejection, got:\n${clientOutput.stderr}`,
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
	["raw command filter", rawCommandFilterScenario],
	["get_state", getStateScenario],
	["pairing and revocation", pairingAndRevocationScenario],
	["pairing ticket workspace binding", pairingTicketWorkspaceBindingScenario],
	["expired ticket", expiredTicketScenario],
	["missing workspace preflight", missingWorkspaceScenario],
];

async function main() {
	await assertInstalled();
	for (const [name, runScenario] of scenarios) {
		process.stdout.write(`Running ${name}... `);
		await runScenario();
		process.stdout.write("passed\n");
	}
	console.log("Iroh sidecar scenario tests passed.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
