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
	createIrohRemoteOutboundFilteredRpcTransport,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	getIrohRemoteRpcFilterResult,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH,
	IROH_REMOTE_REDACTED_EXPORT_PATH,
	IROH_REMOTE_REDACTED_HOST_PATH,
	IROH_REMOTE_REDACTED_SESSION_FILE,
	type IrohRemoteAuditEvent,
	IrohRemoteAuditLogger,
	IrohRemoteClientEngine,
	type IrohRemoteHandshakeResponse,
	type IrohRemoteHello,
	IrohRemoteHostEngine,
	type IrohRemoteHostState,
	IrohRemoteHostStateManager,
	type IrohRemoteTicketPayload,
	type IrohRemoteWorkspace,
	parseIrohRemoteHandshakeResponseLine,
	parseIrohRemoteHelloLine,
	parseIrohRemoteHostState,
	parseIrohRemoteTicketPayload,
	parseIrohRemoteWorkspaceSpec,
	pipeIrohRemoteOutboundJsonlReadable,
	readIrohRemoteHandshakeLine,
	readIrohRemoteHostState,
	sanitizeIrohRemoteOutbound,
	sanitizeIrohRemoteOutboundJsonLine,
	selectIrohRemoteWorkspace,
	serializeIrohRemoteRpcFilterRejection,
	writeIrohRemoteHandshakeResponse,
	writeIrohRemoteHello,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/index.ts";
import type {
	IrohBytes,
	IrohRecvStreamLike,
	IrohSendStreamLike,
	RpcCloseHandler,
	RpcLineHandler,
	RpcTransport,
} from "../src/core/rpc/index.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

class ManualRpcTransport implements RpcTransport {
	readonly writes: object[] = [];
	readonly writeResults: Array<void | Promise<void>> = [];
	readonly lineHandlers = new Set<RpcLineHandler>();
	readonly closeHandlers = new Set<RpcCloseHandler>();
	closeCalls = 0;
	flushCalls = 0;
	waitForBackpressureCalls = 0;

	write(value: object): void | Promise<void> {
		this.writes.push(value);
		return this.writeResults.shift();
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

	emitClose(error?: Error): void {
		for (const handler of this.closeHandlers) {
			handler(error);
		}
	}
}

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

class ManualIrohRecvStream implements IrohRecvStreamLike {
	readonly readLimits: number[] = [];
	readonly stopCalls: bigint[] = [];
	stopError: Error | undefined;
	private readonly queue: QueuedIrohRead[] = [];
	private readonly readers: Array<(value: IrohBytes | undefined) => void> = [];

	read(sizeLimit: number): Promise<IrohBytes | undefined> {
		this.readLimits.push(sizeLimit);
		const queued = this.queue.shift();
		if (queued) {
			return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
		}
		return new Promise((resolve) => {
			this.readers.push(resolve);
		});
	}

	push(bytes: IrohBytes): void {
		this.enqueue({ type: "data", bytes });
	}

	end(): void {
		this.enqueue({ type: "end" });
	}

	stop(errorCode: bigint): void {
		this.stopCalls.push(errorCode);
		if (this.stopError) {
			throw this.stopError;
		}
		this.end();
	}

	private enqueue(queued: QueuedIrohRead): void {
		const reader = this.readers.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}
		reader(queued.type === "data" ? queued.bytes : undefined);
	}
}

class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];
	failWrites = false;

	async writeAll(bytes: Array<number>): Promise<void> {
		if (this.failWrites) {
			throw new Error("send failed");
		}
		this.writes.push(bytes);
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

class InMemoryAuditSink {
	readonly events: IrohRemoteAuditEvent[] = [];

	write(event: IrohRemoteAuditEvent): void {
		this.events.push(event);
	}
}

class FailingAuditSink {
	write(_event: IrohRemoteAuditEvent): void {
		throw new Error("audit failed");
	}
}

interface DeferredVoid {
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

function createDeferredVoid(): DeferredVoid {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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
		expect(
			parseIrohRemoteHandshakeResponseLine(
				JSON.stringify({ type: "volt_iroh_handshake", success: true, workspace: "volt", clientNodeId: "client" }),
			),
		).toEqual({
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			clientNodeId: "client",
			child: undefined,
		});
		expect(() => parseIrohRemoteHandshakeResponseLine(JSON.stringify({ type: "volt_iroh_handshake" }))).toThrow(
			"handshake response success must be a boolean",
		);
	});

	test("reads bounded Iroh remote handshake lines and preserves RPC bytes", async () => {
		const recv = new ManualIrohRecvStream();
		recv.push(Buffer.from('{"type":"volt_iroh_hello"}\r\n{"id":"prompt-1"}\n'));

		await expect(
			readIrohRemoteHandshakeLine(recv, { maxLineBytes: 64, readLimit: 1024, timeoutMs: 1000 }),
		).resolves.toEqual({
			line: '{"type":"volt_iroh_hello"}',
			rest: Buffer.from('{"id":"prompt-1"}\n'),
		});
		expect(recv.readLimits).toEqual([65]);

		const oversized = new ManualIrohRecvStream();
		oversized.push(Buffer.from("abcdef"));
		await expect(readIrohRemoteHandshakeLine(oversized, { maxLineBytes: 4, timeoutMs: 1000 })).rejects.toThrow(
			"Iroh remote handshake line exceeds maximum size of 4 bytes",
		);

		const hanging = new ManualIrohRecvStream();
		await expect(readIrohRemoteHandshakeLine(hanging, { timeoutMs: 1 })).rejects.toThrow(
			"Iroh remote handshake timed out",
		);
		expect(hanging.stopCalls).toEqual([0n]);

		const throwingStop = new ManualIrohRecvStream();
		throwingStop.stopError = new Error("stop failed");
		await expect(readIrohRemoteHandshakeLine(throwingStop, { timeoutMs: 1 })).rejects.toThrow(
			"Iroh remote handshake timed out",
		);
		expect(throwingStop.stopCalls).toEqual([0n]);
	});

	test("reads, writes, and validates host state", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-"));
		try {
			const statePath = join(stateDir, "host.json");
			await expect(readIrohRemoteHostState(statePath)).resolves.toEqual(createEmptyIrohRemoteHostState());

			const state: IrohRemoteHostState = {
				hostSecretKey: [1, 2, 3],
				consumedPairingSecretHashes: ["sha256:used"],
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
		expect(state.consumedPairingSecretHashes).toHaveLength(1);
		expect(state.consumedPairingSecretHashes[0]).toMatch(/^sha256:/);
		expect(
			authorizeIrohRemoteClient(state, makeHello("volt", "secret", "second phone"), "other-client", {
				allowTools: "read",
				pairingSecret: "secret",
				workspace,
				now: 125,
			}),
		).toEqual({ ok: false, error: "pairing ticket has already been used", pairingSecretExpired: false });

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

	test("host state manager and engines pair, authorize, list, revoke, and audit clients", async () => {
		const sink = new InMemoryAuditSink();
		const auditLogger = new IrohRemoteAuditLogger({ now: () => 500, sink });
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			auditLogger,
			now: () => 100,
			stateManager,
			workspace,
		});

		const pairing = await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node",
			relayMode: "disabled",
			secret: "secret",
			ttlMs: 1000,
		});

		expect(pairing.payload).toEqual({
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 1100,
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node",
			relayMode: "disabled",
			secret: "secret",
			workspace: "volt",
		});
		expect(decodeIrohRemoteTicketPayload(pairing.ticket)).toEqual(pairing.payload);

		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		recv.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
					secret: "secret",
					clientLabel: "phone",
				})}\n{"id":"state-1","type":"get_state"}\n`,
			),
		);

		const handshake = await hostEngine.readHandshake({ recv, send }, "client-node", { child: "volt" });
		if (!handshake.ok) {
			throw new Error(handshake.error);
		}
		expect(handshake.response).toEqual({
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			clientNodeId: "client-node",
			child: "volt",
		});
		expect(handshake.responseWritten).toBe(true);
		expect(handshake.responseWriteError).toBeUndefined();
		expect(handshake.initialInput).toEqual(Buffer.from('{"id":"state-1","type":"get_state"}\n'));
		expect(send.writtenText()).toBe(`${JSON.stringify(handshake.response)}\n`);

		const clients = await hostEngine.listClients();
		expect(clients).toEqual([
			expect.objectContaining({
				nodeId: "client-node",
				label: "phone",
				allowedWorkspaces: ["volt"],
			}),
		]);
		clients[0].allowedWorkspaces.push("mutated");
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ allowedWorkspaces: ["volt"] })]);

		const rejected = await hostEngine.authorizeHello(makeHello("volt", "secret", "second phone"), "second-client");
		expect(rejected).toEqual({ ok: false, error: "client is not paired", pairingSecretExpired: false });

		await expect(hostEngine.revokeClient("client-node")).resolves.toEqual({
			revoked: true,
			client: expect.objectContaining({ nodeId: "client-node" }),
		});
		await expect(hostEngine.listClients()).resolves.toEqual([]);
		expect(sink.events.map((event) => event.type)).toEqual([
			"pairing_ticket_created",
			"client_authorized",
			"clients_listed",
			"clients_listed",
			"client_rejected",
			"client_revoked",
			"clients_listed",
		]);
	});

	test("host state manager returns defensive copies", async () => {
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const initialState: IrohRemoteHostState = {
			hostSecretKey: [1, 2, 3],
			consumedPairingSecretHashes: [],
			workspaces: [{ ...workspace }],
			clients: [],
		};
		const stateManager = new IrohRemoteHostStateManager({ initialState });
		initialState.workspaces[0].path = "/mutated-before-load";
		initialState.hostSecretKey?.push(4);

		const loaded = await stateManager.load();
		loaded.hostSecretKey?.push(5);
		loaded.workspaces[0].path = "/mutated-loaded";
		loaded.clients.push({
			nodeId: "leaked-client",
			label: "leaked",
			allowedWorkspaces: [],
			pairedAt: 1,
			lastSeenAt: 1,
		});
		expect(await stateManager.getState()).toEqual({
			hostSecretKey: [1, 2, 3],
			consumedPairingSecretHashes: [],
			workspaces: [{ name: "volt", path: "/workspace" }],
			clients: [],
		});

		const authorized = await stateManager.authorizeClient(makeHello("volt", "secret"), "client-node", {
			allowTools: "read",
			pairingSecret: "secret",
			workspace,
			now: 100,
		});
		if (!authorized.ok) {
			throw new Error(authorized.error);
		}
		authorized.client.allowedWorkspaces.push("mutated");
		authorized.workspace.path = "/mutated-workspace";

		const state = await stateManager.getState();
		expect(state.clients[0].allowedWorkspaces).toEqual(["volt"]);
		expect(state.workspaces[0].path).toBe("/workspace");
	});

	test("host state manager rejects ambiguous initial state and file path options", () => {
		expect(
			() =>
				new IrohRemoteHostStateManager({
					initialState: createEmptyIrohRemoteHostState(),
					statePath: "/tmp/volt-iroh-host-state.json",
				}),
		).toThrow("Cannot provide both initialState and statePath for Iroh remote host state manager");
	});

	test("host engine audit failures do not turn committed authorization into handshake failure", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			auditLogger: new IrohRemoteAuditLogger({ sink: new FailingAuditSink() }),
			now: () => 100,
			stateManager,
			workspace,
		});
		await expect(
			hostEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				secret: "secret",
			}),
		).resolves.toMatchObject({ secret: "secret" });

		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		recv.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
					secret: "secret",
				})}\n`,
			),
		);

		const handshake = await hostEngine.readHandshake({ recv, send }, "client-node");

		if (!handshake.ok) {
			throw new Error(handshake.error);
		}
		expect(handshake.response.success).toBe(true);
		expect(handshake.responseWritten).toBe(true);
		expect(handshake.responseWriteError).toBeUndefined();
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
	});

	test("host engine can defer writing successful handshakes", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 100,
			stateManager,
			workspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		recv.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
					secret: "secret",
				})}\n{"id":"state-1","type":"get_state"}\n`,
			),
		);

		const handshake = await hostEngine.readHandshake({ recv, send }, "client-node", {
			child: "volt",
			writeSuccessResponse: false,
		});

		if (!handshake.ok) {
			throw new Error(handshake.error);
		}
		expect(handshake.response.success).toBe(true);
		expect(handshake.responseWritten).toBe(false);
		expect(handshake.initialInput).toEqual(Buffer.from('{"id":"state-1","type":"get_state"}\n'));
		expect(send.writtenText()).toBe("");
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
	});

	test("host engine send failures do not turn committed authorization into handshake failure", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 100,
			stateManager,
			workspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		send.failWrites = true;
		recv.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
					secret: "secret",
				})}\n`,
			),
		);

		const handshake = await hostEngine.readHandshake({ recv, send }, "client-node");

		if (!handshake.ok) {
			throw new Error(handshake.error);
		}
		expect(handshake.response.success).toBe(true);
		expect(handshake.responseWritten).toBe(false);
		expect(handshake.responseWriteError).toBe("send failed");
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
	});

	test("host engine rejects pair-time workspace mismatches", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const hostEngine = new IrohRemoteHostEngine({
			stateManager,
			workspace: { name: "safe", path: "/workspace" },
		});

		await expect(
			hostEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				workspace: "private",
			}),
		).rejects.toThrow("pairing workspace does not match host workspace: private");
	});

	test("host engine snapshots workspace options at construction", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			stateManager,
			workspace,
		});
		workspace.name = "mutated";
		workspace.path = "/mutated";

		const pairing = await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});
		expect(pairing.payload.workspace).toBe("volt");
		await expect(hostEngine.authorizeHello(makeHello("volt", "secret"), "client-node")).resolves.toMatchObject({
			ok: true,
		});
	});

	test("serializes host authorization so pairing secrets stay one-time under concurrency", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 100,
			stateManager,
			workspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});

		const [first, second] = await Promise.all([
			hostEngine.authorizeHello(makeHello("volt", "secret", "first phone"), "first-client"),
			hostEngine.authorizeHello(makeHello("volt", "secret", "second phone"), "second-client"),
		]);

		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, error: "client is not paired", pairingSecretExpired: false });
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ nodeId: "first-client" })]);
	});

	test("persists consumed pairing secrets across host engine instances", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-pairing-consumption-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			const firstEngine = new IrohRemoteHostEngine({
				now: () => 100,
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});
			await firstEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				secret: "secret",
			});
			await expect(firstEngine.authorizeHello(makeHello("volt", "secret"), "first-client")).resolves.toMatchObject({
				ok: true,
			});

			const secondEngine = new IrohRemoteHostEngine({
				now: () => 125,
				pairingSecret: "secret",
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});

			await expect(secondEngine.authorizeHello(makeHello("volt", "secret"), "second-client")).resolves.toEqual({
				ok: false,
				error: "pairing ticket has already been used",
				pairingSecretExpired: false,
			});
			expect((await readIrohRemoteHostState(statePath)).clients).toEqual([
				expect.objectContaining({ nodeId: "first-client" }),
			]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("serializes host state mutations so revocation is not overwritten by stale authorization", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-manager-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			await writeIrohRemoteHostState(statePath, {
				hostSecretKey: undefined,
				consumedPairingSecretHashes: [],
				workspaces: [workspace],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			});
			const stateManager = new IrohRemoteHostStateManager({ statePath });

			const [revocation, authorization] = await Promise.all([
				stateManager.revokeClient("client-node"),
				stateManager.authorizeClient(makeHello("volt"), "client-node", {
					allowTools: "read",
					workspace,
					now: 200,
				}),
			]);

			expect(revocation.revoked).toBe(true);
			expect(authorization).toEqual({ ok: false, error: "client is not paired", pairingSecretExpired: false });
			expect((await readIrohRemoteHostState(statePath)).clients).toEqual([]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("serializes file-backed state mutations across manager instances", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-lock-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			await writeIrohRemoteHostState(statePath, {
				hostSecretKey: undefined,
				consumedPairingSecretHashes: [],
				workspaces: [workspace],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			});
			const firstManager = new IrohRemoteHostStateManager({ statePath });
			const secondManager = new IrohRemoteHostStateManager({ statePath });

			const [revocation, authorization] = await Promise.all([
				firstManager.revokeClient("client-node"),
				secondManager.authorizeClient(makeHello("volt"), "client-node", {
					allowTools: "read",
					workspace,
					now: 200,
				}),
			]);

			expect(revocation.revoked).toBe(true);
			if (authorization.ok) {
				expect(authorization.client.nodeId).toBe("client-node");
			} else {
				expect(authorization).toEqual({ ok: false, error: "client is not paired", pairingSecretExpired: false });
			}
			expect((await readIrohRemoteHostState(statePath)).clients).toEqual([]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("file-backed state manager reads and saves current file state instead of stale cache", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-cache-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			await writeIrohRemoteHostState(statePath, {
				hostSecretKey: undefined,
				consumedPairingSecretHashes: [],
				workspaces: [workspace],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			});
			const firstManager = new IrohRemoteHostStateManager({ statePath });
			const secondManager = new IrohRemoteHostStateManager({ statePath });

			expect((await firstManager.load()).clients).toHaveLength(1);
			await secondManager.revokeClient("client-node");
			expect((await firstManager.getState()).clients).toEqual([]);
			await firstManager.save();

			expect((await readIrohRemoteHostState(statePath)).clients).toEqual([]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("file-backed state manager rejects explicit stale snapshot saves", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-state-explicit-save-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			await writeIrohRemoteHostState(statePath, {
				hostSecretKey: undefined,
				consumedPairingSecretHashes: [],
				workspaces: [workspace],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			});
			const firstManager = new IrohRemoteHostStateManager({ statePath });
			const secondManager = new IrohRemoteHostStateManager({ statePath });

			const snapshot = await firstManager.load();
			await secondManager.revokeClient("client-node");
			await expect(firstManager.save(snapshot)).rejects.toThrow(
				"Cannot save explicit Iroh remote host state snapshots for file-backed state",
			);

			expect((await readIrohRemoteHostState(statePath)).clients).toEqual([]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("client engine creates hello messages and parses handshake responses", async () => {
		const sink = new InMemoryAuditSink();
		const clientEngine = new IrohRemoteClientEngine({
			auditLogger: new IrohRemoteAuditLogger({ now: () => 700, sink }),
			clientLabel: "phone",
			clientNodeId: "client-node",
			now: () => 100,
		});
		const ticket = encodeIrohRemoteTicketPayload({
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 200,
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
			workspace: "volt",
		});

		const { hello, payload } = await clientEngine.createHelloFromTicket(ticket);
		expect(payload.workspace).toBe("volt");
		expect(hello).toEqual({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "secret",
			clientLabel: "phone",
			clientNodeId: "client-node",
		});

		const send = new ManualIrohSendStream();
		await writeIrohRemoteHello(send, hello);
		expect(send.writtenText()).toBe(`${JSON.stringify(hello)}\n`);

		const response: IrohRemoteHandshakeResponse = {
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			clientNodeId: "client-node",
			child: "volt",
		};
		const recv = new ManualIrohRecvStream();
		recv.push(Buffer.from(`${JSON.stringify(response)}\n{"type":"response"}\n`));
		await writeIrohRemoteHandshakeResponse(send, response);

		await expect(clientEngine.readHandshakeResponse(recv, { timeoutMs: 1000 })).resolves.toEqual({
			response,
			initialInput: Buffer.from('{"type":"response"}\n'),
		});
		expect(send.writtenText()).toBe(`${JSON.stringify(hello)}\n${JSON.stringify(response)}\n`);
		expect(sink.events.map((event) => event.type)).toEqual(["ticket_loaded", "handshake_response_received"]);
	});

	test("client engine audit failures do not fail protocol progress", async () => {
		const clientEngine = new IrohRemoteClientEngine({
			auditLogger: new IrohRemoteAuditLogger({ sink: new FailingAuditSink() }),
			clientLabel: "phone",
			clientNodeId: "client-node",
			now: () => 100,
		});
		const payload: IrohRemoteTicketPayload = {
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 200,
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
			workspace: "volt",
		};
		const ticket = encodeIrohRemoteTicketPayload(payload);

		await expect(clientEngine.createHelloFromTicket(ticket)).resolves.toMatchObject({ payload });

		const send = new ManualIrohSendStream();
		await expect(clientEngine.writeHello({ recv: new ManualIrohRecvStream(), send }, payload)).resolves.toEqual({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "secret",
			clientLabel: "phone",
			clientNodeId: "client-node",
		});
		expect(send.writtenText()).toContain("volt_iroh_hello");

		const response: IrohRemoteHandshakeResponse = {
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			clientNodeId: "client-node",
		};
		const recv = new ManualIrohRecvStream();
		recv.push(Buffer.from(`${JSON.stringify(response)}\n`));

		await expect(clientEngine.readHandshakeResponse(recv, { timeoutMs: 1000 })).resolves.toEqual({
			response,
			initialInput: Buffer.alloc(0),
		});
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

	test("sanitizes remote outbound host paths", () => {
		const workspacePath = "/Users/jordan/project";
		const sessionFile = "/Users/jordan/.volt/agent/sessions/project/session.jsonl";
		const exportPath = "/Users/jordan/.volt/agent/exports/Volt-session-session.html";
		const bashOutputPath = join(tmpdir(), "volt-bash-deadbeef.log");

		const sanitized = sanitizeIrohRemoteOutbound(
			{
				type: "response",
				command: "get_state",
				success: true,
				data: {
					sessionFile,
					sessionPath: sessionFile,
					sourceInfo: { path: `${workspacePath}/src/index.ts` },
					remotePathList: { path: "/workspace/bin:/Users/jordan/.volt/auth.json" },
					tildeSessionPath: "~/.volt/agent/sessions/proj/session.jsonl",
					tildeUserSessionPath: "~jordan/.volt/agent/sessions/proj/session.jsonl",
					outsidePath: "/Users/jordan/.volt/agent/auth.json",
					outputPath: `${workspacePath}/bin:/Users/jordan/.volt/auth.json`,
					networkPath: "\\\\server\\share\\auth.json",
					message: `Workspace ${workspacePath}/src/index.ts, sibling ${workspacePath}-private/file.ts, outside /Users/jordan/.volt/agent/auth.json, pipe |/Users/jordan/.volt/agent/auth.json|, pathList PATH=${workspacePath}/bin:/Users/jordan/.volt/auth.json;/Users/jordan/.volt/other.json,/Users/jordan/.volt/third.json, remoteList /workspace/bin:/Users/jordan/.volt/remote.json, label path:/Users/jordan/.volt/agent/auth.json, numeric 1:/Users/jordan/.volt/agent/auth.json, windows path:C:\\Users\\jordan\\.volt\\agent\\auth.json, unc \\\\server\\share\\auth.json, tilde ~/.volt/auth.json, tildeExport ~/Volt-session-abc.html, file file://localhost/Users/jordan/.volt/agent/auth.json, fileRoot file:///Users/jordan/.volt/agent/auth.json, fileCase FILE:///Users/jordan/.volt/agent/auth.json, url https://example.com/Users/jordan/file, workspaceUrl https://example.com/Users/jordan/project/src/index.ts, relative src/index.ts, full output: ${bashOutputPath}, export: ${exportPath}, session: ${sessionFile}`,
					keyedPaths: {
						"/Users/jordan/.volt/agent/auth.json": "key value",
						"|/Users/jordan/.volt/agent/leading.json": "leading pipe key value",
						"|/Users/jordan/.volt/agent/auth.json|": "pipe key value",
						"/Users/jordan/project/src/index.ts": "workspace key value",
						"/Users/jordan/secrets.json": "second redacted key value",
					},
					keyedSpacedPath: { "/Users/jordan/Secret Key": "spaced key value" },
					keyedPathSuffix: { "/Users/jordan/privatePath": "suffix key value" },
					ordinaryKeys: { constructor: 1, toString: 2 },
					details: {
						fullOutputPath: bashOutputPath,
						note: `Full output: ${bashOutputPath}`,
					},
				},
			},
			{ workspacePath },
		) as {
			data: {
				details: Record<string, unknown>;
				keyedSpacedPath: Record<string, string>;
				message: string;
				networkPath: string;
				ordinaryKeys: Record<string, number>;
				outsidePath: string;
				outputPath: string;
				keyedPathSuffix: Record<string, string>;
				keyedPaths: Record<string, string>;
				remotePathList: { path: string };
				sessionFile?: string;
				sessionPath: string;
				sourceInfo: { path: string };
				tildeSessionPath: string;
				tildeUserSessionPath: string;
			};
		};

		expect(sanitized.data.sessionFile).toBeUndefined();
		expect(sanitized.data.sessionPath).toBe(IROH_REMOTE_REDACTED_HOST_PATH);
		expect(sanitized.data.tildeSessionPath).toBe(IROH_REMOTE_REDACTED_SESSION_FILE);
		expect(sanitized.data.tildeUserSessionPath).toBe(IROH_REMOTE_REDACTED_SESSION_FILE);
		expect(sanitized.data.sourceInfo.path).toBe("/workspace/src/index.ts");
		expect(sanitized.data.outsidePath).toBe(IROH_REMOTE_REDACTED_HOST_PATH);
		expect(sanitized.data.outputPath).toBe(`/workspace/bin:${IROH_REMOTE_REDACTED_HOST_PATH}`);
		expect(sanitized.data.remotePathList.path).toBe(`/workspace/bin:${IROH_REMOTE_REDACTED_HOST_PATH}`);
		expect(sanitized.data.networkPath).toBe(IROH_REMOTE_REDACTED_HOST_PATH);
		expect(sanitized.data.details.fullOutputPath).toBeUndefined();
		expect(sanitized.data.details.note).toBe(`Full output: ${IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH}`);
		expect(sanitized.data.message).toBe(
			`Workspace /workspace/src/index.ts, sibling ${IROH_REMOTE_REDACTED_HOST_PATH}, outside ${IROH_REMOTE_REDACTED_HOST_PATH}, pipe |${IROH_REMOTE_REDACTED_HOST_PATH}|, pathList PATH=/workspace/bin:${IROH_REMOTE_REDACTED_HOST_PATH};${IROH_REMOTE_REDACTED_HOST_PATH},${IROH_REMOTE_REDACTED_HOST_PATH}, remoteList /workspace/bin:${IROH_REMOTE_REDACTED_HOST_PATH}, label path:${IROH_REMOTE_REDACTED_HOST_PATH}, numeric 1:${IROH_REMOTE_REDACTED_HOST_PATH}, windows path:${IROH_REMOTE_REDACTED_HOST_PATH}, unc ${IROH_REMOTE_REDACTED_HOST_PATH}, tilde ${IROH_REMOTE_REDACTED_HOST_PATH}, tildeExport ${IROH_REMOTE_REDACTED_EXPORT_PATH}, file ${IROH_REMOTE_REDACTED_HOST_PATH}, fileRoot ${IROH_REMOTE_REDACTED_HOST_PATH}, fileCase ${IROH_REMOTE_REDACTED_HOST_PATH}, url https://example.com/Users/jordan/file, workspaceUrl https://example.com/Users/jordan/project/src/index.ts, relative src/index.ts, full output: ${IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH}, export: ${IROH_REMOTE_REDACTED_EXPORT_PATH}, session: ${IROH_REMOTE_REDACTED_SESSION_FILE}`,
		);
		expect(sanitized.data.keyedPaths).toEqual({
			[IROH_REMOTE_REDACTED_HOST_PATH]: "key value",
			[`|${IROH_REMOTE_REDACTED_HOST_PATH}`]: "leading pipe key value",
			[`|${IROH_REMOTE_REDACTED_HOST_PATH}|`]: "pipe key value",
			"/workspace/src/index.ts": "workspace key value",
			[`${IROH_REMOTE_REDACTED_HOST_PATH} (2)`]: "second redacted key value",
		});
		expect(sanitized.data.keyedPathSuffix).toEqual({
			[IROH_REMOTE_REDACTED_HOST_PATH]: "suffix key value",
		});
		expect(sanitized.data.keyedSpacedPath).toEqual({
			[IROH_REMOTE_REDACTED_HOST_PATH]: "spaced key value",
		});
		expect(sanitized.data.ordinaryKeys).toEqual({ constructor: 1, toString: 2 });

		const spacedWorkspacePath = "/Users/Jordan Hans/project";
		const spacedSanitized = sanitizeIrohRemoteOutbound(
			{
				message: `Opened ${spacedWorkspacePath}/src/index.ts and outside /Users/Jordan Hans/.volt/auth.json`,
			},
			{ workspacePath: spacedWorkspacePath },
		) as { message: string };
		expect(spacedSanitized.message).toBe(
			`Opened /workspace/src/index.ts and outside ${IROH_REMOTE_REDACTED_HOST_PATH}`,
		);
		const terminalSpacedSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Owner path /Users/Jordan Hans" },
			{ workspacePath: spacedWorkspacePath },
		) as { message: string };
		expect(terminalSpacedSanitized.message).toBe(`Owner path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const terminalSecretKeySanitized = sanitizeIrohRemoteOutbound(
			{ message: "Secret path /Users/jordan/Secret Key" },
			{ workspacePath },
		) as { message: string };
		expect(terminalSecretKeySanitized.message).toBe(`Secret path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const spacedProjectSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/My Project" },
			{ workspacePath },
		) as { message: string };
		expect(spacedProjectSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const lowercaseSpacedProjectSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/my project" },
			{ workspacePath },
		) as { message: string };
		expect(lowercaseSpacedProjectSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const multiWordPathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/my project data/file.txt" },
			{ workspacePath },
		) as { message: string };
		expect(multiWordPathSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const terminalMultiWordPathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/my project data" },
			{ workspacePath },
		) as { message: string };
		expect(terminalMultiWordPathSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const apostrophePathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/John's Project/auth.json" },
			{ workspacePath },
		) as { message: string };
		expect(apostrophePathSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const spacedApostrophePathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/O' Brien/auth.json" },
			{ workspacePath },
		) as { message: string };
		expect(spacedApostrophePathSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const terminalSpacedApostrophePathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Project path /Users/jordan/O' Brien" },
			{ workspacePath },
		) as { message: string };
		expect(terminalSpacedApostrophePathSanitized.message).toBe(`Project path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const configSpacedPathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Config path /Users/jordan/.config/app data" },
			{ workspacePath },
		) as { message: string };
		expect(configSpacedPathSanitized.message).toBe(`Config path ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const spacedThenProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Owner path /Users/Jordan Hans missing" },
			{ workspacePath: spacedWorkspacePath },
		) as { message: string };
		expect(spacedThenProseSanitized.message).toBe(`Owner path ${IROH_REMOTE_REDACTED_HOST_PATH} missing`);

		const adjacentPathSanitized = sanitizeIrohRemoteOutbound(
			{ message: `${workspacePath}/src /Users/jordan/.volt/auth.json` },
			{ workspacePath },
		) as { message: string };
		expect(adjacentPathSanitized.message).toBe(`/workspace/src ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const adjacentColonPathSanitized = sanitizeIrohRemoteOutbound(
			{ message: "/Users/jordan/.volt/auth.json 1:/Users/jordan/.volt/other.json" },
			{ workspacePath },
		) as { message: string };
		expect(adjacentColonPathSanitized.message).toBe(
			`${IROH_REMOTE_REDACTED_HOST_PATH} 1:${IROH_REMOTE_REDACTED_HOST_PATH}`,
		);

		const suffixSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/.volt/auth.json suffix" },
			{ workspacePath },
		) as { message: string };
		expect(suffixSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} suffix`);
		const directoryThenProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/project suffix" },
			{ workspacePath },
		) as { message: string };
		expect(directoryThenProseSanitized.message).toBe("prefix /workspace suffix");
		const workspaceThenUppercaseProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/project Missing" },
			{ workspacePath },
		) as { message: string };
		expect(workspaceThenUppercaseProseSanitized.message).toBe("prefix /workspace Missing");
		const parenthesizedSuffixSanitized = sanitizeIrohRemoteOutbound(
			{ message: "(/Users/jordan/.volt/auth.json missing)" },
			{ workspacePath },
		) as { message: string };
		expect(parenthesizedSuffixSanitized.message).toBe(`(${IROH_REMOTE_REDACTED_HOST_PATH} missing)`);
		const slashProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "/Users/jordan/.volt/auth.json and/or missing" },
			{ workspacePath },
		) as { message: string };
		expect(slashProseSanitized.message).toBe(`${IROH_REMOTE_REDACTED_HOST_PATH} and/or missing`);
		const privateSlashProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private and/missing" },
			{ workspacePath },
		) as { message: string };
		expect(privateSlashProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} and/missing`);
		const privateUppercaseProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private Missing" },
			{ workspacePath },
		) as { message: string };
		expect(privateUppercaseProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} Missing`);
		const privateFailedProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private failed" },
			{ workspacePath },
		) as { message: string };
		expect(privateFailedProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} failed`);
		const privateNotFoundProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private not found" },
			{ workspacePath },
		) as { message: string };
		expect(privateNotFoundProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} not found`);
		const privateExistsProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private exists" },
			{ workspacePath },
		) as { message: string };
		expect(privateExistsProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} exists`);
		const multiWordPathThenProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/my project data missing" },
			{ workspacePath },
		) as { message: string };
		expect(multiWordPathThenProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} missing`);
		const privateDataThenProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private data missing" },
			{ workspacePath },
		) as { message: string };
		expect(privateDataThenProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} missing`);
		const privateKeySanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private key" },
			{ workspacePath },
		) as { message: string };
		expect(privateKeySanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} key`);
		const backtickedPrivateKeySanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix `/Users/jordan/private key`" },
			{ workspacePath },
		) as { message: string };
		expect(backtickedPrivateKeySanitized.message).toBe(`prefix \`${IROH_REMOTE_REDACTED_HOST_PATH}\``);
		const clientFilesSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/client files" },
			{ workspacePath },
		) as { message: string };
		expect(clientFilesSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} files`);
		const privateCrashedProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/private crashed badly" },
			{ workspacePath },
		) as { message: string };
		expect(privateCrashedProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} crashed badly`);
		const fooUnavailableSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/foo unavailable" },
			{ workspacePath },
		) as { message: string };
		expect(fooUnavailableSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} unavailable`);
		const tildeUserSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix ~jordan/.volt/auth.json" },
			{ workspacePath },
		) as { message: string };
		expect(tildeUserSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH}`);
		const configSpacedProseSanitized = sanitizeIrohRemoteOutbound(
			{ message: "prefix /Users/jordan/.config/app data missing" },
			{ workspacePath },
		) as { message: string };
		expect(configSpacedProseSanitized.message).toBe(`prefix ${IROH_REMOTE_REDACTED_HOST_PATH} missing`);
		const singleQuotedSanitized = sanitizeIrohRemoteOutbound(
			{ message: "path '/Users/jordan/.volt/auth.json' done" },
			{ workspacePath },
		) as { message: string };
		expect(singleQuotedSanitized.message).toBe(`path '${IROH_REMOTE_REDACTED_HOST_PATH}' done`);
		const backtickedSanitized = sanitizeIrohRemoteOutbound(
			{ message: "path `/Users/jordan/.volt/auth.json` done" },
			{ workspacePath },
		) as { message: string };
		expect(backtickedSanitized.message).toBe(`path \`${IROH_REMOTE_REDACTED_HOST_PATH}\` done`);

		const keyEdgeSanitized = sanitizeIrohRemoteOutbound(
			{
				"/Users/jordan/private key": "key",
				__proto__: { leaked: true },
			},
			{ workspacePath },
		) as Record<string, unknown>;
		expect(keyEdgeSanitized).toEqual({
			[IROH_REMOTE_REDACTED_HOST_PATH]: "key",
			__proto__: { leaked: true },
		});
		expect(Object.getPrototypeOf(keyEdgeSanitized)).toBeNull();

		const ordinaryDataSanitized = sanitizeIrohRemoteOutbound(
			{ type: "response", data: "/Users/jordan/.volt/auth.json" },
			{ workspacePath },
		) as { data: string };
		expect(ordinaryDataSanitized.data).toBe(IROH_REMOTE_REDACTED_HOST_PATH);

		const opaqueContentSanitized = sanitizeIrohRemoteOutbound(
			{
				content: [
					{
						type: "text",
						text: "Read /Users/jordan/.volt/auth.json",
						textSignature: "/opaque/text-signature",
					},
					{
						type: "thinking",
						thinking: "Saw /Users/jordan/.volt/auth.json",
						thinkingSignature: "/opaque/thinking-signature",
					},
					{
						type: "toolCall",
						id: "tool-call-1",
						name: "read",
						arguments: { path: "/Users/jordan/.volt/auth.json" },
						thoughtSignature: "/opaque/thought-signature",
					},
				],
			},
			{ workspacePath },
		) as {
			content: [
				{ text: string; textSignature: string },
				{ thinking: string; thinkingSignature: string },
				{ arguments: { path: string }; thoughtSignature: string },
			];
		};
		expect(opaqueContentSanitized.content).toEqual([
			{
				type: "text",
				text: `Read ${IROH_REMOTE_REDACTED_HOST_PATH}`,
				textSignature: "/opaque/text-signature",
			},
			{
				type: "thinking",
				thinking: `Saw ${IROH_REMOTE_REDACTED_HOST_PATH}`,
				thinkingSignature: "/opaque/thinking-signature",
			},
			{
				type: "toolCall",
				id: "tool-call-1",
				name: "read",
				arguments: { path: IROH_REMOTE_REDACTED_HOST_PATH },
				thoughtSignature: "/opaque/thought-signature",
			},
		]);

		const remoteWorkspaceSanitized = sanitizeIrohRemoteOutbound({ cwd: "/workspace/src" }, { workspacePath }) as {
			cwd: string;
		};
		expect(remoteWorkspaceSanitized.cwd).toBe("/workspace/src");
	});

	test("sanitizes remote outbound JSONL lines for sidecar spawned children", () => {
		const line = `${JSON.stringify({
			type: "response",
			command: "get_messages",
			success: true,
			data: {
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Read /Users/jordan/project/src/index.ts and /Users/jordan/.volt/auth.json",
							},
							{
								type: "image",
								data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
								mimeType: "image/jpeg",
							},
						],
					},
				],
			},
		})}\n`;

		expect(sanitizeIrohRemoteOutboundJsonLine(line, { workspacePath: "/Users/jordan/project" })).toBe(
			`${JSON.stringify({
				type: "response",
				command: "get_messages",
				success: true,
				data: {
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "text", text: `Read /workspace/src/index.ts and ${IROH_REMOTE_REDACTED_HOST_PATH}` },
								{
									type: "image",
									data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
									mimeType: "image/jpeg",
								},
							],
						},
					],
				},
			})}\n`,
		);
		expect(sanitizeIrohRemoteOutboundJsonLine("not json\n", { workspacePath: "/Users/jordan/project" })).toBe(
			"not json\n",
		);
		expect(
			sanitizeIrohRemoteOutboundJsonLine(
				"not json path:/Users/jordan/.volt/agent/auth.json pipe |/Users/jordan/.volt/agent/auth.json| file:file://localhost/Users/jordan/.volt/agent/auth.json url:https://example.com/Users/jordan/file\n",
				{
					workspacePath: "/Users/jordan/project",
				},
			),
		).toBe(
			`not json path:${IROH_REMOTE_REDACTED_HOST_PATH} pipe |${IROH_REMOTE_REDACTED_HOST_PATH}| file:${IROH_REMOTE_REDACTED_HOST_PATH} url:https://example.com/Users/jordan/file\n`,
		);
		expect(
			sanitizeIrohRemoteOutboundJsonLine("not json 1:/Users/jordan/.volt/agent/auth.json\n", {
				workspacePath: "/Users/jordan/project",
			}),
		).toBe(`not json 1:${IROH_REMOTE_REDACTED_HOST_PATH}\n`);
		expect(
			sanitizeIrohRemoteOutboundJsonLine('not json {\\"message\\":\\"\\\\\\\\server\\\\share\\\\auth.json\\"}\n', {
				workspacePath: "/Users/jordan/project",
			}),
		).toBe(`not json {\\"message\\":\\"${IROH_REMOTE_REDACTED_HOST_PATH}\\"}\n`);
	});

	test("pipes remote outbound JSONL chunks through the shared sanitizer", async () => {
		const workspacePath = "/Users/jordan/project";
		const eventLine = `${JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: {
				cwd: `${workspacePath}/src`,
				message: `using /Users/jordan/.volt/agent/sessions/project/session.jsonl`,
			},
		})}\n`;
		const partialLine = "child failed at /Users/jordan/.volt/agent/auth.json";
		const writes: string[] = [];
		const observedLines: string[] = [];

		async function* readable(): AsyncIterable<string | Uint8Array> {
			yield Buffer.from(eventLine.slice(0, 19), "utf8");
			yield Buffer.from(eventLine.slice(19), "utf8");
			yield partialLine;
		}

		await pipeIrohRemoteOutboundJsonlReadable(readable(), {
			workspacePath,
			writeLine(line) {
				writes.push(line);
			},
			onLine(line) {
				observedLines.push(line);
			},
		});

		expect(writes).toEqual([
			`${JSON.stringify({
				type: "response",
				command: "get_state",
				success: true,
				data: {
					cwd: "/workspace/src",
					message: `using ${IROH_REMOTE_REDACTED_SESSION_FILE}`,
				},
			})}\n`,
			`child failed at ${IROH_REMOTE_REDACTED_HOST_PATH}`,
		]);
		expect(observedLines).toEqual(writes);
	});

	test("wraps RPC transports with the remote outbound filter", () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteOutboundFilteredRpcTransport({
			transport: inner,
			workspacePath: "/Users/jordan/project",
		});

		transport.write({
			type: "response",
			command: "get_session_stats",
			success: true,
			data: {
				sessionFile: "/Users/jordan/.volt/agent/sessions/project/session.jsonl",
				cwd: "/Users/jordan/project",
			},
		});

		expect(inner.writes).toEqual([
			{
				type: "response",
				command: "get_session_stats",
				success: true,
				data: { cwd: "/workspace" },
			},
		]);
	});

	test("surfaces asynchronous filter rejection write failures from close", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteFilteredRpcTransport({ transport: inner });
		const write = createDeferredVoid();
		const writeError = new Error("rejection write failed");
		inner.writeResults.push(write.promise);
		transport.onLine(() => {
			throw new Error("rejected commands must not be forwarded");
		});

		inner.emitLine(JSON.stringify({ id: "bash-1", type: "bash", command: "pwd" }));
		write.reject(writeError);
		await nextTick();

		await expect(transport.close()).rejects.toBe(writeError);
		expect(inner.closeCalls).toBe(1);
	});

	test("defers clean remote close until one-shot command responses are written", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => Promise.resolve(),
		});
		let closed = false;
		transport.onLine(() => {});
		transport.onClose?.(() => {
			closed = true;
		});

		inner.emitLine(JSON.stringify({ id: "state-1", type: "get_state" }));
		inner.emitClose();
		await nextTick();
		expect(closed).toBe(false);

		transport.write({ id: "state-1", type: "response", command: "get_state", success: true });
		await nextTick();

		expect(closed).toBe(true);
	});

	test("defers clean remote close until prompt completion after preflight success", async () => {
		const inner = new ManualRpcTransport();
		const promptCompletion = createDeferredVoid();
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => promptCompletion.promise,
		});
		let closed = false;
		transport.onLine(() => {});
		transport.onClose?.(() => {
			closed = true;
		});

		inner.emitLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hi" }));
		inner.emitClose();
		await nextTick();
		expect(closed).toBe(false);

		transport.write({ id: "prompt-1", type: "response", command: "prompt", success: true });
		await nextTick();
		expect(closed).toBe(false);

		promptCompletion.resolve();
		await nextTick();

		expect(closed).toBe(true);
	});

	test.each(["steer", "follow_up"] as const)(
		"defers clean remote close until %s completion after success",
		async (command) => {
			const inner = new ManualRpcTransport();
			const promptCompletion = createDeferredVoid();
			const transport = createIrohRemoteCloseDeferringRpcTransport({
				transport: inner,
				waitForPromptCompletion: () => promptCompletion.promise,
			});
			let closed = false;
			transport.onLine(() => {});
			transport.onClose?.(() => {
				closed = true;
			});

			inner.emitLine(JSON.stringify({ id: `${command}-1`, type: command, message: "hi" }));
			inner.emitClose();
			await nextTick();
			expect(closed).toBe(false);

			transport.write({ id: `${command}-1`, type: "response", command, success: true });
			await nextTick();
			expect(closed).toBe(false);

			promptCompletion.resolve();
			await nextTick();

			expect(closed).toBe(true);
		},
	);

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
