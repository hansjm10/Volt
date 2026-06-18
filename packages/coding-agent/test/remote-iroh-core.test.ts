import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	assertIrohRemoteTicketNotExpired,
	authorizeIrohRemoteClient,
	createEmptyIrohRemoteHostState,
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteHandshakeFailure,
	createIrohRemoteHandshakeSuccess,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	getIrohRemoteRpcFilterResult,
	IROH_REMOTE_ALPN,
	type IrohRemoteHello,
	type IrohRemoteHostState,
	type IrohRemoteTicketPayload,
	type IrohRemoteWorkspace,
	parseIrohRemoteHelloLine,
	parseIrohRemoteHostState,
	parseIrohRemoteTicketPayload,
	parseIrohRemoteWorkspaceSpec,
	readIrohRemoteHostState,
	selectIrohRemoteWorkspace,
	serializeIrohRemoteRpcFilterRejection,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/index.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../src/core/rpc/index.ts";

class ManualRpcTransport implements RpcTransport {
	readonly writes: object[] = [];
	readonly lineHandlers = new Set<RpcLineHandler>();
	readonly closeHandlers = new Set<RpcCloseHandler>();
	closeCalls = 0;
	flushCalls = 0;
	waitForBackpressureCalls = 0;

	write(value: object): void {
		this.writes.push(value);
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	onClose(handler: RpcCloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	async waitForBackpressure(): Promise<void> {
		this.waitForBackpressureCalls++;
	}

	async flush(): Promise<void> {
		this.flushCalls++;
	}

	close(): void {
		this.closeCalls++;
	}

	emitLine(line: string): void {
		for (const handler of this.lineHandlers) {
			handler(line);
		}
	}
}

function makeHello(workspace: string, secret?: string, clientLabel = "phone"): IrohRemoteHello {
	return parseIrohRemoteHelloLine(
		JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace,
			secret,
			clientLabel,
			clientNodeId: "client-claimed-id",
		}),
	);
}

describe("Iroh remote core helpers", () => {
	test("encodes, decodes, validates, and expires remote tickets", () => {
		const payload: IrohRemoteTicketPayload = {
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 1000,
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node",
			relayMode: "default",
			secret: "pairing-secret",
			workspace: "volt",
		};

		const ticket = encodeIrohRemoteTicketPayload(payload);

		expect(ticket.startsWith("volt+iroh://v1/")).toBe(true);
		expect(decodeIrohRemoteTicketPayload(ticket)).toEqual(payload);
		expect(() => decodeIrohRemoteTicketPayload("not-a-ticket")).toThrow("Expected ticket prefix");
		expect(() => parseIrohRemoteTicketPayload({ ...payload, alpn: "other" })).toThrow("Unsupported ticket ALPN");
		expect(() => parseIrohRemoteTicketPayload({ ...payload, relayMode: "custom" })).toThrow(
			"ticket relayMode must be disabled or default",
		);
		expect(() => assertIrohRemoteTicketNotExpired(payload, 1001)).toThrow("Pairing ticket has expired");
	});

	test("parses handshakes and creates handshake responses", () => {
		const hello = makeHello("volt", "secret", "Jordan iPhone");

		expect(hello).toEqual({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "secret",
			clientLabel: "Jordan iPhone",
			clientNodeId: "client-claimed-id",
		});
		expect(() => parseIrohRemoteHelloLine(JSON.stringify({ type: "wrong", protocol: IROH_REMOTE_ALPN }))).toThrow(
			"unexpected handshake type",
		);
		expect(() => parseIrohRemoteHelloLine(JSON.stringify({ type: "volt_iroh_hello", protocol: "wrong" }))).toThrow(
			"unsupported protocol: wrong",
		);
		expect(createIrohRemoteHandshakeSuccess({ workspace: "volt", clientNodeId: "client", child: "volt" })).toEqual({
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			clientNodeId: "client",
			child: "volt",
		});
		expect(createIrohRemoteHandshakeFailure("client is not paired")).toEqual({
			type: "volt_iroh_handshake",
			success: false,
			error: "client is not paired",
		});
	});

	test("reads, writes, and validates host state", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-"));
		try {
			const statePath = join(stateDir, "host.json");
			await expect(readIrohRemoteHostState(statePath)).resolves.toEqual(createEmptyIrohRemoteHostState());

			const state: IrohRemoteHostState = {
				hostSecretKey: [1, 2, 3],
				workspaces: [{ name: "volt", path: stateDir, allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS }],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			};
			await writeIrohRemoteHostState(statePath, state);

			expect(await readIrohRemoteHostState(statePath)).toEqual(state);
			expect((await readFile(statePath, "utf8")).endsWith("\n")).toBe(true);
			expect((await stat(statePath)).isFile()).toBe(true);
			await writeFile(statePath, JSON.stringify({ ...state, clients: [{ nodeId: "missing fields" }] }));
			expect(() => parseIrohRemoteHostState({ ...state, hostSecretKey: [999] })).toThrow(
				"hostSecretKey must contain byte values",
			);
			await expect(readIrohRemoteHostState(statePath)).rejects.toThrow("client label must be a non-empty string");
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("selects and upserts workspace definitions", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-workspace-"));
		try {
			const state = createEmptyIrohRemoteHostState();
			const defaultWorkspace = selectIrohRemoteWorkspace(
				state,
				undefined,
				DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
				stateDir,
			);

			expect(defaultWorkspace).toEqual({
				name: defaultWorkspace.name,
				path: stateDir,
				allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			});
			expect(state.workspaces).toHaveLength(1);
			expect(parseIrohRemoteWorkspaceSpec("safe=.", stateDir)).toEqual({ name: "safe", path: stateDir });
			expect(selectIrohRemoteWorkspace(state, `safe=${stateDir}`, "read", stateDir)).toEqual({
				name: "safe",
				path: stateDir,
				allowedTools: "read",
			});
			expect(state.workspaces).toHaveLength(2);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("authorizes pairing, persisted clients, workspace binding, and expiry", () => {
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const state = createEmptyIrohRemoteHostState();
		const paired = authorizeIrohRemoteClient(state, makeHello("volt", "secret"), "client-node", {
			allowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			pairingExpiresAt: 200,
			pairingSecret: "secret",
			workspace,
			now: 100,
		});

		if (!paired.ok) {
			throw new Error(paired.error);
		}
		expect(paired.paired).toBe(true);
		expect(paired.pairingSecretConsumed).toBe(true);
		expect(paired.client).toMatchObject({
			nodeId: "client-node",
			label: "phone",
			allowedWorkspaces: ["volt"],
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			pairedAt: 100,
			lastSeenAt: 100,
		});

		const persisted = authorizeIrohRemoteClient(state, makeHello("volt", undefined, "renamed phone"), "client-node", {
			allowTools: "read",
			workspace,
			now: 150,
		});
		if (!persisted.ok) {
			throw new Error(persisted.error);
		}
		expect(persisted.paired).toBe(false);
		expect(persisted.client.label).toBe("renamed phone");
		expect(persisted.client.allowedTools).toBe("read");
		expect(persisted.client.lastSeenAt).toBe(150);

		const unpairedState = createEmptyIrohRemoteHostState();
		expect(
			authorizeIrohRemoteClient(unpairedState, makeHello("volt"), "other-client", {
				allowTools: "read",
				workspace,
				now: 150,
			}),
		).toEqual({ ok: false, error: "client is not paired", pairingSecretExpired: false });
		expect(
			authorizeIrohRemoteClient(createEmptyIrohRemoteHostState(), makeHello("volt", "secret"), "other-client", {
				allowTools: "read",
				pairingExpiresAt: 100,
				pairingSecret: "secret",
				workspace,
				now: 101,
			}),
		).toEqual({ ok: false, error: "pairing ticket has expired", pairingSecretExpired: true });
		expect(
			authorizeIrohRemoteClient(createEmptyIrohRemoteHostState(), makeHello("private", "secret"), "other-client", {
				allowTools: "read",
				pairingSecret: "secret",
				workspace,
				now: 100,
			}),
		).toEqual({ ok: false, error: "workspace not allowed: private", pairingSecretExpired: false });
	});

	test("wraps RPC transports with the remote command filter", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteFilteredRpcTransport({ transport: inner });
		const forwardedLines: string[] = [];
		transport.onLine((line) => {
			forwardedLines.push(line);
		});

		const promptLine = JSON.stringify({ id: "prompt-1", type: "prompt", message: "hi" });
		inner.emitLine(promptLine);
		inner.emitLine(JSON.stringify({ id: "bash-1", type: "bash", command: "pwd" }));
		inner.emitLine("{");
		await transport.waitForBackpressure?.();
		await transport.flush?.();
		await transport.close();

		expect(forwardedLines).toEqual([promptLine]);
		expect(inner.writes).toEqual([
			{
				id: "bash-1",
				type: "response",
				command: "bash",
				success: false,
				error: "RPC command not allowed over remote sidecar: bash",
			},
			expect.objectContaining({ type: "response", command: "parse", success: false }),
		]);
		expect(inner.waitForBackpressureCalls).toBe(1);
		expect(inner.flushCalls).toBe(1);
		expect(inner.closeCalls).toBe(1);
	});

	test("filters remote RPC commands before forwarding to Volt RPC", () => {
		const prompt = getIrohRemoteRpcFilterResult(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hi" }));
		if (!prompt.allowed) {
			throw new Error(prompt.response.error);
		}
		expect(prompt.command).toMatchObject({ id: "prompt-1", type: "prompt", message: "hi" });

		const rejected = getIrohRemoteRpcFilterResult(JSON.stringify({ id: "bash-1", type: "bash", command: "pwd" }));
		if (rejected.allowed) {
			throw new Error("bash should have been rejected");
		}
		expect(rejected.response).toEqual({
			id: "bash-1",
			type: "response",
			command: "bash",
			success: false,
			error: "RPC command not allowed over remote sidecar: bash",
		});
		expect(serializeIrohRemoteRpcFilterRejection(rejected.response)).toBe(`${JSON.stringify(rejected.response)}\n`);

		const parseFailure = getIrohRemoteRpcFilterResult("{");
		if (parseFailure.allowed) {
			throw new Error("invalid JSON should have been rejected");
		}
		expect(parseFailure.response.command).toBe("parse");
		expect(parseFailure.response.error).toContain("Failed to parse command");
	});
});
