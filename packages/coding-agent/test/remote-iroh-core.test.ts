import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	assertIrohRemoteHandshakeHostIdentity,
	assertIrohRemoteTicketNotExpired,
	assertIrohRemoteTicketPayloadHostIdentity,
	authorizeIrohRemoteClient,
	createEmptyIrohRemoteHostState,
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteHandshakeFailure,
	createIrohRemoteHandshakeSuccess,
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteSanitizedReconnectTicket,
	createIrohRemoteSanitizedReconnectTicketPayload,
	createIrohRemoteTicketQrCode,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
	decodeIrohRemoteTicketPayload,
	encodeIrohRemoteTicketPayload,
	formatIrohRemoteTicketQrCode,
	formatIrohRemoteTicketQrCodeTerminal,
	getIrohRemoteRpcFilterResult,
	getIrohRemoteUnsafeAllowedTools,
	hashIrohRemotePairingSecret,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES,
	IROH_REMOTE_OUTCOMES,
	IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH,
	IROH_REMOTE_REDACTED_EXPORT_PATH,
	IROH_REMOTE_REDACTED_HOST_PATH,
	IROH_REMOTE_REDACTED_SESSION_FILE,
	IROH_REMOTE_RPC_PASSTHROUGH_TYPES,
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
	writeError: Error | undefined;

	write(value: object): void | Promise<void> {
		this.writes.push(value);
		if (this.writeError) {
			throw this.writeError;
		}
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

function makeHelloWithoutLabel(workspace: string, secret?: string): IrohRemoteHello {
	return parseIrohRemoteHelloLine(
		JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace,
			secret,
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

	test("creates sanitized reconnect tickets and verifies ticket host identity", () => {
		const payload: IrohRemoteTicketPayload = {
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 1000,
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node",
			relayMode: "default",
			secret: "pairing-secret",
			workspace: "volt",
		};
		const sanitizedPayload = createIrohRemoteSanitizedReconnectTicketPayload(payload);

		expect(sanitizedPayload).toEqual({
			alpn: IROH_REMOTE_ALPN,
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node",
			relayMode: "default",
			workspace: "volt",
		});
		expect(JSON.stringify(sanitizedPayload)).not.toContain("pairing-secret");
		expect(createIrohRemoteSanitizedReconnectTicket(encodeIrohRemoteTicketPayload(payload))).toBe(
			encodeIrohRemoteTicketPayload(sanitizedPayload),
		);
		expect(() => assertIrohRemoteTicketPayloadHostIdentity(payload, "host-node")).not.toThrow();
		expect(() => assertIrohRemoteTicketPayloadHostIdentity(payload, "other-host")).toThrow(
			"host_identity_mismatch: expected other-host, got host-node",
		);
		try {
			assertIrohRemoteTicketPayloadHostIdentity(payload, "other-host");
			throw new Error("expected host identity mismatch");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "host_identity_mismatch" });
		}
		expect(() => createIrohRemoteSanitizedReconnectTicketPayload({ ...payload, nodeId: undefined })).toThrow(
			"saved_host_invalid: ticket nodeId is required for saved-host reconnect",
		);
		try {
			createIrohRemoteSanitizedReconnectTicketPayload({ ...payload, nodeId: undefined });
			throw new Error("expected saved host invalid");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "saved_host_invalid" });
		}
		expect(() => createIrohRemoteSanitizedReconnectTicketPayload({ ...payload, relayMode: undefined })).toThrow(
			"saved_host_invalid: ticket relayMode is required for saved-host reconnect",
		);
		expect(() => assertIrohRemoteTicketPayloadHostIdentity({ ...payload, nodeId: undefined }, "host-node")).toThrow(
			"saved_host_invalid: ticket nodeId is required for host identity verification",
		);
	});

	test("renders remote tickets as QR codes", () => {
		const ticket = "volt+iroh://v1/mock-ticket";
		const qrCode = createIrohRemoteTicketQrCode(ticket);

		expect(qrCode.version).toBe(2);
		expect(qrCode.size).toBe(25);
		expect(qrCode.modules).toHaveLength(qrCode.size);
		expect(qrCode.modules.every((row) => row.length === qrCode.size)).toBe(true);
		expect(qrCode.modules[0][0]).toBe(true);
		expect(qrCode.modules[7][7]).toBe(false);
		expect(qrCode.modules[qrCode.size - 8][8]).toBe(true);

		const formatted = formatIrohRemoteTicketQrCode(ticket);
		const terminal = formatIrohRemoteTicketQrCodeTerminal(ticket);

		expect(formatted).toBe(terminal);
		expect(terminal.split("\n")).toHaveLength(15);
		expect(terminal).toContain("▄▄▄▄▄▄▄");
		expect(terminal).toContain("█ ▄▄▄▄▄ █");
		expect(terminal).not.toContain("\x1b[47m");
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
		const hostHandshakeSuccess = createIrohRemoteHandshakeSuccess({
			workspace: "volt",
			hostNodeId: "host-node",
			clientNodeId: "client",
			child: "volt",
		});
		expect(hostHandshakeSuccess).toEqual({
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			hostNodeId: "host-node",
			clientNodeId: "client",
			child: "volt",
		});
		expect(() => assertIrohRemoteHandshakeHostIdentity(hostHandshakeSuccess, "host-node")).not.toThrow();
		expect(() => assertIrohRemoteHandshakeHostIdentity(hostHandshakeSuccess, "other-host")).toThrow(
			"host_identity_mismatch: expected other-host, got host-node",
		);
		try {
			assertIrohRemoteHandshakeHostIdentity(hostHandshakeSuccess, "other-host");
			throw new Error("expected host identity mismatch");
		} catch (error) {
			expect(error).toMatchObject({ outcome: "host_identity_mismatch" });
		}
		expect(() =>
			assertIrohRemoteHandshakeHostIdentity(createIrohRemoteHandshakeFailure("client is not paired"), "host-node"),
		).toThrow("host_identity_mismatch: expected host-node, got <missing>");
		expect(
			createIrohRemoteHandshakeFailure("client is not paired", {
				hostNodeId: "host-node",
				outcome: "client_unknown",
			}),
		).toEqual({
			type: "volt_iroh_handshake",
			success: false,
			outcome: "client_unknown",
			hostNodeId: "host-node",
			error: "client is not paired",
		});
		expect(
			parseIrohRemoteHandshakeResponseLine(
				JSON.stringify({
					type: "volt_iroh_handshake",
					success: true,
					workspace: "volt",
					hostNodeId: "host-node",
					clientNodeId: "client",
				}),
			),
		).toEqual({
			type: "volt_iroh_handshake",
			success: true,
			workspace: "volt",
			hostNodeId: "host-node",
			clientNodeId: "client",
			child: undefined,
		});
		expect(() => parseIrohRemoteHandshakeResponseLine(JSON.stringify({ type: "volt_iroh_handshake" }))).toThrow(
			"handshake response success must be a boolean",
		);
		expect(() =>
			parseIrohRemoteHandshakeResponseLine(
				JSON.stringify({
					type: "volt_iroh_handshake",
					success: false,
					outcome: "unknown_outcome",
					error: "client is not paired",
				}),
			),
		).toThrow("handshake response outcome must be a known Iroh remote outcome");
	});

	test("pins protocol v1 ticket and handshake compatibility vectors", () => {
		const payload: IrohRemoteTicketPayload = {
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 1790000000000,
			irohTicket: "iroh-endpoint-ticket",
			nodeId: "host-node-id",
			relayMode: "disabled",
			secret: "one-time-secret",
			workspace: "volt",
		};
		const ticket =
			"volt+iroh://v1/eyJhbHBuIjoidm9sdC1ycGMvMCIsImV4cGlyZXNBdCI6MTc5MDAwMDAwMDAwMCwiaXJvaFRpY2tldCI6Imlyb2gtZW5kcG9pbnQtdGlja2V0Iiwibm9kZUlkIjoiaG9zdC1ub2RlLWlkIiwicmVsYXlNb2RlIjoiZGlzYWJsZWQiLCJzZWNyZXQiOiJvbmUtdGltZS1zZWNyZXQiLCJ3b3Jrc3BhY2UiOiJ2b2x0In0";

		expect(encodeIrohRemoteTicketPayload(payload)).toBe(ticket);
		expect(decodeIrohRemoteTicketPayload(ticket)).toEqual(payload);
		expect(parseIrohRemoteTicketPayload({ ...payload, unknownFutureField: "ignored" })).toEqual(payload);

		const helloLine =
			'{"type":"volt_iroh_hello","protocol":"volt-rpc/0","workspace":"volt","secret":"one-time-secret","clientLabel":"Jordan iPhone","clientNodeId":"client-claimed-node-id"}';
		expect(parseIrohRemoteHelloLine(helloLine)).toEqual({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "one-time-secret",
			clientLabel: "Jordan iPhone",
			clientNodeId: "client-claimed-node-id",
		});
		expect(parseIrohRemoteHelloLine(`${helloLine.slice(0, -1)},"unknownFutureField":"ignored"}`)).toEqual({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "one-time-secret",
			clientLabel: "Jordan iPhone",
			clientNodeId: "client-claimed-node-id",
		});

		const success = createIrohRemoteHandshakeSuccess({
			workspace: "volt",
			hostNodeId: "host-node-id",
			clientNodeId: "authoritative-client-node-id",
			child: "volt",
		});
		const successLine =
			'{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"host-node-id","clientNodeId":"authoritative-client-node-id","child":"volt"}';
		expect(JSON.stringify(success)).toBe(successLine);
		expect(parseIrohRemoteHandshakeResponseLine(successLine)).toEqual(success);
		expect(
			parseIrohRemoteHandshakeResponseLine(`${successLine.slice(0, -1)},"unknownFutureField":"ignored"}`),
		).toEqual(success);

		const failure = createIrohRemoteHandshakeFailure("client is not paired", { outcome: "client_unknown" });
		const failureLine =
			'{"type":"volt_iroh_handshake","success":false,"outcome":"client_unknown","error":"client is not paired"}';
		expect(JSON.stringify(failure)).toBe(failureLine);
		expect(parseIrohRemoteHandshakeResponseLine(failureLine)).toEqual(failure);
	});

	test("pins protocol v1 LF framing and initial RPC input preservation", async () => {
		const unicodeLineSeparators = String.fromCharCode(0x2028, 0x2029);
		const line = JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "one-time-secret",
			clientLabel: `line separator client with unicode separators ${unicodeLineSeparators}`,
		});
		const initialRpcInput = '{"id":"prompt-1","type":"prompt","message":"kept after hello"}\n';
		const recv = new ManualIrohRecvStream();
		recv.push(Buffer.from(`${line}\n${initialRpcInput}`));

		await expect(
			readIrohRemoteHandshakeLine(recv, { maxLineBytes: 512, readLimit: 1024, timeoutMs: 1000 }),
		).resolves.toEqual({
			line,
			rest: Buffer.from(initialRpcInput),
		});
	});

	test("pins protocol v1 remote command and redaction compatibility vectors", () => {
		expect(Array.from(IROH_REMOTE_OUTCOMES)).toEqual([
			"host_unreachable",
			"pairing_secret_expired",
			"pairing_secret_consumed",
			"client_unknown",
			"client_revoked",
			"workspace_unavailable",
			"workspace_forbidden",
			"host_identity_mismatch",
			"saved_host_invalid",
		]);
		expect(Array.from(IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES)).toEqual([
			"pairing_secret_expired",
			"pairing_secret_consumed",
			"client_unknown",
			"client_revoked",
			"workspace_unavailable",
			"workspace_forbidden",
		]);
		expect(Array.from(IROH_REMOTE_RPC_PASSTHROUGH_TYPES)).toEqual([
			"prompt",
			"steer",
			"follow_up",
			"abort",
			"new_session",
			"get_state",
			"get_transcript",
			"list_sessions",
			"switch_session_by_id",
			"extension_ui_response",
		]);
		for (const type of IROH_REMOTE_RPC_PASSTHROUGH_TYPES) {
			const result = getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${type}-1`, type }));
			expect(result).toEqual({ allowed: true, command: { id: `${type}-1`, type } });
		}
		expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: "bash-1", type: "bash" }))).toEqual({
			allowed: false,
			response: {
				id: "bash-1",
				type: "response",
				command: "bash",
				success: false,
				error: "RPC command not allowed over remote host: bash",
			},
		});
		for (const command of [
			"get_messages",
			"switch_session",
			"get_commands",
			"get_last_assistant_text",
			"get_available_models",
		] as const) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${command}-1`, type: command }))).toEqual({
				allowed: false,
				response: {
					id: `${command}-1`,
					type: "response",
					command,
					success: false,
					error: `RPC command not allowed over remote host: ${command}`,
				},
			});
		}

		const workspacePath = "/Users/jordan/project";
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "response",
					command: "get_state",
					success: true,
					data: {
						cwd: `${workspacePath}/src`,
						sessionFile: "/Users/jordan/.volt/agent/sessions/project/session.jsonl",
						exportPath: "/Users/jordan/.volt/agent/exports/Volt-session-session.html",
						message: `inside ${workspacePath}/src/index.ts outside /Users/jordan/.volt/auth.json`,
						content: [
							{
								type: "image",
								data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
								mimeType: "image/jpeg",
							},
							{
								type: "text",
								text: "Read /Users/jordan/.volt/auth.json",
								textSignature: "/opaque/text-signature",
							},
						],
					},
				},
				{ workspacePath },
			),
		).toEqual({
			type: "response",
			command: "get_state",
			success: true,
			data: {
				cwd: "/workspace/src",
				exportPath: IROH_REMOTE_REDACTED_EXPORT_PATH,
				message: `inside /workspace/src/index.ts outside ${IROH_REMOTE_REDACTED_HOST_PATH}`,
				content: [
					{
						type: "image",
						data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
						mimeType: "image/jpeg",
					},
					{
						type: "text",
						text: `Read ${IROH_REMOTE_REDACTED_HOST_PATH}`,
						textSignature: "/opaque/text-signature",
					},
				],
			},
		});
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
				pairingSecretTombstones: [
					{
						secretHash: "sha256:used",
						workspace: "volt",
						outcome: "pairing_secret_consumed",
						createdAt: 5,
						expiresAt: 40,
						consumedAt: 20,
						clientNodeId: "client-node",
						retainUntil: 100,
					},
				],
				workspaces: [{ name: "volt", path: stateDir, allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS }],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["volt"],
						allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
						pairedAt: 10,
						lastSeenAt: 20,
						lastSessionIdByWorkspace: { volt: "session-one" },
					},
				],
				revokedClients: [
					{
						nodeId: "revoked-node",
						label: "revoked phone",
						allowedWorkspaces: ["volt"],
						allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
						pairedAt: 11,
						lastSeenAt: 21,
						revokedAt: 31,
						lastSessionIdByWorkspace: { volt: "revoked-session" },
						rePairApprovedAt: 41,
					},
				],
				pendingPairingTickets: [
					{
						secretHash: "sha256:pending",
						workspace: "volt",
						allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
						createdAt: 30,
						expiresAt: 40,
						labelHint: "tablet",
					},
				],
			};
			await writeIrohRemoteHostState(statePath, state);

			expect(await readIrohRemoteHostState(statePath)).toEqual(state);
			const parsedLegacyState = parseIrohRemoteHostState({
				...state,
				clients: [
					{
						nodeId: "legacy-client",
						label: "old phone",
						allowedWorkspaces: ["volt"],
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
				pairingSecretTombstones: undefined,
				revokedClients: undefined,
				pendingPairingTickets: undefined,
			});
			expect(parsedLegacyState.clients[0].allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
			expect(parsedLegacyState.clients[0].lastSessionIdByWorkspace).toBeUndefined();
			expect(parsedLegacyState.pairingSecretTombstones).toEqual([]);
			expect(parsedLegacyState.revokedClients).toEqual([]);
			expect(parsedLegacyState.pendingPairingTickets).toEqual([]);
			expect((await readFile(statePath, "utf8")).endsWith("\n")).toBe(true);
			expect((await stat(statePath)).isFile()).toBe(true);
			await writeFile(statePath, JSON.stringify({ ...state, clients: [{ nodeId: "missing fields" }] }));
			expect(() => parseIrohRemoteHostState({ ...state, hostSecretKey: [999] })).toThrow(
				"hostSecretKey must contain byte values",
			);
			expect(() =>
				parseIrohRemoteHostState({
					...state,
					clients: [{ ...state.clients[0], lastSessionIdByWorkspace: { volt: "" } }],
				}),
			).toThrow("client last session id must be a non-empty string");
			expect(() =>
				parseIrohRemoteHostState({
					...state,
					pairingSecretTombstones: [{ ...state.pairingSecretTombstones![0], outcome: "pairing_secret_unknown" }],
				}),
			).toThrow("pairing secret tombstone outcome must be pairing_secret_consumed or pairing_secret_expired");
			expect(() =>
				parseIrohRemoteHostState({
					...state,
					revokedClients: [{ ...state.revokedClients![0], rePairApprovedAt: Number.NaN }],
				}),
			).toThrow("revoked client rePairApprovedAt must be a finite number");
			await expect(readIrohRemoteHostState(statePath)).rejects.toThrow("client label must be a non-empty string");
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("detects unsafe remote tool grants", () => {
		expect(getIrohRemoteUnsafeAllowedTools(DEFAULT_IROH_REMOTE_ALLOW_TOOLS)).toEqual(["bash", "edit", "write"]);
		expect(getIrohRemoteUnsafeAllowedTools("read,bash, edit,write,bash,custom")).toEqual(["bash", "edit", "write"]);
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
			allowedWorkspaces: [],
			allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			pairedAt: 100,
			lastSeenAt: 100,
		});
		expect(state.pairingSecretTombstones).toEqual([
			{
				secretHash: hashIrohRemotePairingSecret("secret"),
				workspace: "volt",
				outcome: "pairing_secret_consumed",
				expiresAt: 200,
				consumedAt: 100,
				clientNodeId: "client-node",
				retainUntil: 100 + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
			},
		]);
		expect(
			authorizeIrohRemoteClient(state, makeHello("volt", "secret", "second phone"), "other-client", {
				allowTools: "read",
				pairingSecret: "secret",
				workspace,
				now: 125,
			}),
		).toEqual({
			ok: false,
			error: "pairing ticket has already been used",
			outcome: "pairing_secret_consumed",
			pairingSecretExpired: false,
		});
		const recovered = authorizeIrohRemoteClient(state, makeHello("volt", "secret", "recovery phone"), "client-node", {
			allowTools: "read",
			pairingSecret: "secret",
			workspace,
			now: 140,
		});
		if (!recovered.ok) {
			throw new Error(recovered.error);
		}
		expect(recovered.paired).toBe(false);
		expect(recovered.pairingSecretConsumed).toBe(false);
		expect(recovered.client.label).toBe("recovery phone");
		expect(recovered.client.lastSeenAt).toBe(140);
		expect(state.pairingSecretTombstones).toHaveLength(1);

		const persisted = authorizeIrohRemoteClient(state, makeHello("volt", undefined, "renamed phone"), "client-node", {
			allowTools: "bash",
			workspace,
			now: 150,
		});
		if (!persisted.ok) {
			throw new Error(persisted.error);
		}
		expect(persisted.paired).toBe(false);
		expect(persisted.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(persisted.client.label).toBe("renamed phone");
		expect(persisted.client.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(persisted.client.lastSeenAt).toBe(150);

		const legacyState = parseIrohRemoteHostState({
			workspaces: [workspace],
			clients: [
				{
					nodeId: "legacy-client",
					label: "old phone",
					allowedWorkspaces: ["volt"],
					pairedAt: 10,
					lastSeenAt: 20,
				},
			],
		});
		const legacyPersisted = authorizeIrohRemoteClient(
			legacyState,
			makeHello("volt", undefined, "old phone"),
			"legacy-client",
			{
				allowTools: "bash",
				workspace,
				now: 175,
			},
		);
		if (!legacyPersisted.ok) {
			throw new Error(legacyPersisted.error);
		}
		expect(legacyPersisted.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(legacyPersisted.client.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);

		const unpairedState = createEmptyIrohRemoteHostState();
		expect(
			authorizeIrohRemoteClient(unpairedState, makeHello("volt"), "other-client", {
				allowTools: "read",
				workspace,
				now: 150,
			}),
		).toEqual({
			ok: false,
			error: "client is not paired",
			outcome: "client_unknown",
			pairingSecretExpired: false,
		});
		expect(
			authorizeIrohRemoteClient(createEmptyIrohRemoteHostState(), makeHello("volt", "secret"), "other-client", {
				allowTools: "read",
				pairingExpiresAt: 100,
				pairingSecret: "secret",
				workspace,
				now: 101,
			}),
		).toEqual({
			ok: false,
			error: "pairing ticket has expired",
			outcome: "pairing_secret_expired",
			pairingSecretExpired: true,
		});
		expect(
			authorizeIrohRemoteClient(createEmptyIrohRemoteHostState(), makeHello("private", "secret"), "other-client", {
				allowTools: "read",
				pairingSecret: "secret",
				workspace,
				now: 100,
			}),
		).toEqual({
			ok: false,
			error: "workspace not allowed: private",
			outcome: "workspace_unavailable",
			pairingSecretExpired: false,
		});
	});

	test("host state manager and engines pair, authorize, list, revoke, and audit clients", async () => {
		const sink = new InMemoryAuditSink();
		const auditLogger = new IrohRemoteAuditLogger({ now: () => 500, sink });
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			auditLogger,
			hostNodeId: "host-node",
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
			hostNodeId: "host-node",
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
				allowedWorkspaces: [],
			}),
		]);
		clients[0].allowedWorkspaces.push("mutated");
		expect(await hostEngine.listClients()).toEqual([expect.objectContaining({ allowedWorkspaces: [] })]);

		const rejectedRecv = new ManualIrohRecvStream();
		const rejectedSend = new ManualIrohSendStream();
		rejectedRecv.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
					secret: "secret",
					clientLabel: "second phone",
				})}\n`,
			),
		);
		const rejectedHandshake = await hostEngine.readHandshake(
			{ recv: rejectedRecv, send: rejectedSend },
			"second-client",
		);
		expect(rejectedHandshake).toMatchObject({
			ok: false,
			error: "pairing ticket has already been used",
			response: {
				type: "volt_iroh_handshake",
				success: false,
				outcome: "pairing_secret_consumed",
				hostNodeId: "host-node",
				error: "pairing ticket has already been used",
			},
			responseWritten: true,
		});
		expect(rejectedSend.writtenText()).toBe(`${JSON.stringify(rejectedHandshake.response)}\n`);

		await expect(hostEngine.setClientLastSessionId("client-node", "volt", "session-one")).resolves.toEqual(
			expect.objectContaining({
				nodeId: "client-node",
				lastSessionIdByWorkspace: { volt: "session-one" },
			}),
		);
		const clientWithSession = (await hostEngine.listClients())[0];
		clientWithSession.lastSessionIdByWorkspace!.volt = "mutated";
		expect(await hostEngine.listClients()).toEqual([
			expect.objectContaining({ lastSessionIdByWorkspace: { volt: "session-one" } }),
		]);

		const rejected = await hostEngine.authorizeHello(makeHello("volt", "secret", "second phone"), "second-client");
		expect(rejected).toEqual({
			ok: false,
			error: "pairing ticket has already been used",
			outcome: "pairing_secret_consumed",
			pairingSecretExpired: false,
		});

		await expect(hostEngine.revokeClient("client-node")).resolves.toEqual({
			revoked: true,
			client: expect.objectContaining({ nodeId: "client-node" }),
			revokedClient: expect.objectContaining({
				nodeId: "client-node",
				label: "phone",
				allowedWorkspaces: [],
				allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
				pairedAt: 100,
				lastSeenAt: 100,
				revokedAt: 100,
				lastSessionIdByWorkspace: { volt: "session-one" },
			}),
		});
		await expect(hostEngine.listClients()).resolves.toEqual([]);
		await expect(stateManager.listRevokedClients()).resolves.toEqual([
			expect.objectContaining({ nodeId: "client-node", revokedAt: 100 }),
		]);
		expect(sink.events.map((event) => event.type)).toEqual([
			"pairing_ticket_created",
			"pairing_ticket_consumed",
			"client_authorized",
			"clients_listed",
			"clients_listed",
			"client_rejected",
			"clients_listed",
			"clients_listed",
			"client_rejected",
			"client_revoked",
			"clients_listed",
		]);
	});

	test("host engine uses pair-time tools for new clients and persisted tools for reconnects", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			allowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			now: () => 100,
			stateManager,
			workspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});
		hostEngine.setAllowTools("bash");

		const paired = await hostEngine.authorizeHello(makeHello("volt", "secret", "phone"), "client-node");
		if (!paired.ok) {
			throw new Error(paired.error);
		}
		expect(paired.paired).toBe(true);
		expect(paired.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(paired.client.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);

		const restartedHostEngine = new IrohRemoteHostEngine({
			allowTools: "bash",
			now: () => 200,
			stateManager,
			workspace,
		});
		const reconnected = await restartedHostEngine.authorizeHello(
			makeHello("volt", undefined, "renamed phone"),
			"client-node",
		);
		if (!reconnected.ok) {
			throw new Error(reconnected.error);
		}
		expect(reconnected.paired).toBe(false);
		expect(reconnected.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(reconnected.client.label).toBe("renamed phone");
		expect(reconnected.client.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(reconnected.client.lastSeenAt).toBe(200);
	});

	test("host engine authorizes paired clients across registered workspaces without another pairing secret", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const alphaWorkspace: IrohRemoteWorkspace = { name: "alpha", path: "/alpha" };
		const betaWorkspace: IrohRemoteWorkspace = { name: "beta", path: "/beta" };
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 100,
			stateManager,
			workspace: alphaWorkspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "secret",
		});
		const paired = await hostEngine.authorizeHello(makeHello("alpha", "secret"), "client-node");
		if (!paired.ok) {
			throw new Error(paired.error);
		}
		expect(paired.client.allowedWorkspaces).toEqual([]);

		await stateManager.upsertWorkspace(betaWorkspace);
		const restartedHostEngine = new IrohRemoteHostEngine({
			now: () => 200,
			stateManager,
			workspace: alphaWorkspace,
		});
		const reconnected = await restartedHostEngine.authorizeHello(makeHello("beta"), "client-node");
		if (!reconnected.ok) {
			throw new Error(reconnected.error);
		}

		expect(reconnected.paired).toBe(false);
		expect(reconnected.workspace).toEqual(betaWorkspace);
		expect(reconnected.client.allowedWorkspaces).toEqual([]);
		expect(reconnected.client.lastSeenAt).toBe(200);
		expect((await stateManager.getState()).clients).toEqual([
			expect.objectContaining({ nodeId: "client-node", allowedWorkspaces: [] }),
		]);
	});

	test("normalizes legacy active workspace grants on successful registered workspace authorization", async () => {
		const stateManager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [
					{ name: "alpha", path: "/alpha" },
					{ name: "beta", path: "/beta" },
				],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["alpha"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			},
		});
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 200,
			stateManager,
			workspace: { name: "alpha", path: "/alpha" },
		});

		const authorized = await hostEngine.authorizeHello(makeHello("beta"), "client-node");
		if (!authorized.ok) {
			throw new Error(authorized.error);
		}

		expect(authorized.workspace).toEqual({ name: "beta", path: "/beta" });
		expect(authorized.client.allowedWorkspaces).toEqual([]);
		expect(authorized.client.lastSeenAt).toBe(200);
		expect((await stateManager.getState()).clients).toEqual([
			expect.objectContaining({ nodeId: "client-node", allowedWorkspaces: [] }),
		]);
	});

	test("rejects unknown and stale registered workspaces without normalizing legacy clients", async () => {
		const stateManager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [{ name: "alpha", path: "/alpha" }],
				clients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["alpha"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
					},
				],
			},
		});
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 200,
			stateManager,
			validateWorkspace: (workspace) => workspace.name !== "alpha",
			workspace: { name: "alpha", path: "/alpha" },
		});

		await expect(hostEngine.authorizeHello(makeHello("missing"), "client-node")).resolves.toEqual({
			ok: false,
			error: "workspace not allowed: missing",
			outcome: "workspace_unavailable",
			pairingSecretExpired: false,
		});
		await expect(hostEngine.authorizeHello(makeHello("alpha"), "client-node")).resolves.toEqual({
			ok: false,
			error: "workspace not allowed: alpha",
			outcome: "workspace_unavailable",
			pairingSecretExpired: false,
		});
		expect((await stateManager.getState()).clients).toEqual([
			expect.objectContaining({ nodeId: "client-node", allowedWorkspaces: ["alpha"] }),
		]);
	});

	test("revoked legacy workspace grants stay revoked for every registered workspace", async () => {
		const stateManager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [
					{ name: "alpha", path: "/alpha" },
					{ name: "beta", path: "/beta" },
				],
				revokedClients: [
					{
						nodeId: "client-node",
						label: "phone",
						allowedWorkspaces: ["alpha"],
						allowedTools: "read",
						pairedAt: 10,
						lastSeenAt: 20,
						revokedAt: 30,
					},
				],
			},
		});
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 200,
			stateManager,
			workspace: { name: "alpha", path: "/alpha" },
		});

		await expect(hostEngine.authorizeHello(makeHello("beta"), "client-node")).resolves.toEqual({
			ok: false,
			error: "client is revoked",
			outcome: "client_revoked",
			pairingSecretExpired: false,
		});
		expect(await stateManager.listRevokedClients()).toEqual([
			expect.objectContaining({ nodeId: "client-node", allowedWorkspaces: ["alpha"] }),
		]);
	});

	test("host engine restart with the same state authorizes saved reconnects and preserves host identity", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-host-restart-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			const firstHostEngine = new IrohRemoteHostEngine({
				hostNodeId: "host-node",
				now: () => 100,
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});
			await firstHostEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				nodeId: "host-node",
				relayMode: "disabled",
				secret: "secret",
			});

			const pairRecv = new ManualIrohRecvStream();
			const pairSend = new ManualIrohSendStream();
			pairRecv.push(
				Buffer.from(
					`${JSON.stringify({
						type: "volt_iroh_hello",
						protocol: IROH_REMOTE_ALPN,
						workspace: "volt",
						secret: "secret",
						clientLabel: "phone",
					})}\n`,
				),
			);
			const pairedHandshake = await firstHostEngine.readHandshake({ recv: pairRecv, send: pairSend }, "client-node");
			if (!pairedHandshake.ok) {
				throw new Error(pairedHandshake.error);
			}
			expect(pairedHandshake.authorization.paired).toBe(true);
			expect(pairedHandshake.response.hostNodeId).toBe("host-node");

			const restartedHostEngine = new IrohRemoteHostEngine({
				hostNodeId: "host-node",
				now: () => 200,
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});
			const reconnectRecv = new ManualIrohRecvStream();
			const reconnectSend = new ManualIrohSendStream();
			reconnectRecv.push(
				Buffer.from(
					`${JSON.stringify({
						type: "volt_iroh_hello",
						protocol: IROH_REMOTE_ALPN,
						workspace: "volt",
						clientLabel: "phone renamed",
					})}\n`,
				),
			);
			const reconnectHandshake = await restartedHostEngine.readHandshake(
				{ recv: reconnectRecv, send: reconnectSend },
				"client-node",
			);
			if (!reconnectHandshake.ok) {
				throw new Error(reconnectHandshake.error);
			}

			expect(reconnectHandshake.authorization.paired).toBe(false);
			expect(reconnectHandshake.authorization.client.label).toBe("phone renamed");
			expect(reconnectHandshake.authorization.client.lastSeenAt).toBe(200);
			expect(reconnectHandshake.response).toEqual({
				type: "volt_iroh_handshake",
				success: true,
				workspace: "volt",
				hostNodeId: "host-node",
				clientNodeId: "client-node",
				child: undefined,
			});
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("revoked clients require explicit approval and a fresh pairing secret to re-pair", async () => {
		let now = 100;
		const sink = new InMemoryAuditSink();
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			auditLogger: new IrohRemoteAuditLogger({ now: () => now, sink }),
			now: () => now,
			stateManager,
			workspace,
		});
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			labelHint: "phone hint",
			secret: "initial-secret",
			ttlMs: 1000,
		});
		const paired = await hostEngine.authorizeHello(makeHello("volt", "initial-secret", "phone"), "client-node");
		if (!paired.ok) {
			throw new Error(paired.error);
		}
		await stateManager.setClientLastSessionId("client-node", "volt", "session-one");

		now = 150;
		await expect(hostEngine.revokeClient("client-node")).resolves.toEqual({
			revoked: true,
			client: expect.objectContaining({ nodeId: "client-node" }),
			revokedClient: expect.objectContaining({
				nodeId: "client-node",
				label: "phone",
				allowedWorkspaces: [],
				allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
				pairedAt: 100,
				lastSeenAt: 100,
				lastSessionIdByWorkspace: { volt: "session-one" },
				revokedAt: 150,
			}),
		});
		await expect(hostEngine.authorizeHello(makeHello("volt"), "client-node")).resolves.toEqual({
			ok: false,
			error: "client is revoked",
			outcome: "client_revoked",
			pairingSecretExpired: false,
		});

		now = 160;
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			labelHint: "approved phone",
			secret: "repair-secret",
			ttlMs: 1000,
		});
		await expect(
			hostEngine.authorizeHello(makeHello("volt", "repair-secret", "phone"), "client-node"),
		).resolves.toEqual({
			ok: false,
			error: "client is revoked",
			outcome: "client_revoked",
			pairingSecretExpired: false,
		});
		expect((await stateManager.getState()).pendingPairingTickets).toEqual([
			expect.objectContaining({ secretHash: hashIrohRemotePairingSecret("repair-secret") }),
		]);

		now = 170;
		await expect(hostEngine.approveClientRePair("client-node")).resolves.toEqual({
			approved: true,
			revokedClient: expect.objectContaining({ nodeId: "client-node", rePairApprovedAt: 170 }),
		});
		await expect(hostEngine.authorizeHello(makeHello("volt"), "client-node")).resolves.toEqual({
			ok: false,
			error: "client is revoked",
			outcome: "client_revoked",
			pairingSecretExpired: false,
		});

		now = 180;
		const repaired = await hostEngine.authorizeHello(
			makeHello("volt", "repair-secret", "phone repaired"),
			"client-node",
		);
		if (!repaired.ok) {
			throw new Error(repaired.error);
		}
		expect(repaired.paired).toBe(true);
		expect(repaired.pairingSecretConsumed).toBe(true);
		expect(repaired.client).toMatchObject({
			nodeId: "client-node",
			label: "phone repaired",
			allowedWorkspaces: [],
			pairedAt: 180,
			lastSeenAt: 180,
		});
		expect((await stateManager.getState()).revokedClients).toEqual([]);
		expect(sink.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "client_rejected",
					clientNodeId: "client-node",
					error: "client is revoked",
				}),
				expect.objectContaining({ type: "client_repair_approved", clientNodeId: "client-node", success: true }),
				expect.objectContaining({ type: "pairing_ticket_consumed", clientNodeId: "client-node", success: true }),
			]),
		);
	});

	test("host engine stores pair-time policy, relay hints, TTLs, and label hints", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			allowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			now: () => 100,
			stateManager,
			workspace,
		});
		const pairing = await hostEngine.pair({
			allowTools: "read,bash",
			irohTicket: "iroh-endpoint-ticket",
			labelHint: "tablet",
			nodeId: "host-node",
			relayMode: "default",
			secret: "secret",
			ttlMs: 25,
		});

		expect(pairing.payload).toMatchObject({
			expiresAt: 125,
			relayMode: "default",
			workspace: "volt",
		});
		expect(await stateManager.getState()).toMatchObject({
			pendingPairingTickets: [
				{
					secretHash: hashIrohRemotePairingSecret("secret"),
					workspace: "volt",
					allowedTools: "read,bash",
					createdAt: 100,
					expiresAt: 125,
					labelHint: "tablet",
				},
			],
		});

		const paired = await hostEngine.authorizeHello(makeHelloWithoutLabel("volt", "secret"), "client-node");
		if (!paired.ok) {
			throw new Error(paired.error);
		}
		expect(paired.allowTools).toBe("read,bash");
		expect(paired.client).toMatchObject({
			label: "tablet",
			allowedTools: "read,bash",
			allowedWorkspaces: [],
		});
		expect((await stateManager.getState()).pendingPairingTickets).toEqual([]);
		expect((await stateManager.getState()).pairingSecretTombstones).toEqual([
			{
				secretHash: hashIrohRemotePairingSecret("secret"),
				workspace: "volt",
				outcome: "pairing_secret_consumed",
				createdAt: 100,
				expiresAt: 125,
				consumedAt: 100,
				clientNodeId: "client-node",
				labelHint: "tablet",
				retainUntil: 100 + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
			},
		]);
		await expect(hostEngine.authorizeHello(makeHello("volt", "secret"), "other-client")).resolves.toEqual({
			ok: false,
			error: "pairing ticket has already been used",
			outcome: "pairing_secret_consumed",
			pairingSecretExpired: false,
		});
	});

	test("host engine rejects pending pairing tickets bound to another workspace", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await stateManager.upsertWorkspace({ name: "safe", path: "/workspace" });
		await stateManager.upsertWorkspace({ name: "private", path: "/private" });
		await stateManager.addPendingPairingTicket({
			secretHash: hashIrohRemotePairingSecret("secret"),
			workspace: "private",
			allowedTools: "read",
			createdAt: 100,
			expiresAt: 200,
		});
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 125,
			stateManager,
			workspace: { name: "safe", path: "/workspace" },
		});

		await expect(hostEngine.authorizeHello(makeHello("safe", "secret"), "client-node")).resolves.toEqual({
			ok: false,
			error: "pairing ticket is not valid for workspace: safe",
			outcome: "workspace_forbidden",
			pairingSecretExpired: false,
		});
		expect(await stateManager.getState()).toMatchObject({
			pairingSecretTombstones: [],
			pendingPairingTickets: [
				{
					secretHash: hashIrohRemotePairingSecret("secret"),
					workspace: "private",
					allowedTools: "read",
					createdAt: 100,
					expiresAt: 200,
				},
			],
		});

		const privateHostEngine = new IrohRemoteHostEngine({
			now: () => 150,
			stateManager,
			workspace: { name: "private", path: "/private" },
		});
		const paired = await privateHostEngine.authorizeHello(makeHello("private", "secret"), "client-node");
		if (!paired.ok) {
			throw new Error(paired.error);
		}
		expect(paired.paired).toBe(true);
	});

	test("host engine persists pending pairing hashes, rejects expired pending tickets, and audits lifecycle", async () => {
		const sink = new InMemoryAuditSink();
		const auditLogger = new IrohRemoteAuditLogger({ now: () => 700, sink });
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const hostEngine = new IrohRemoteHostEngine({
			auditLogger,
			now: () => 100,
			stateManager,
			workspace,
		});
		const secret = "raw-pairing-secret";
		await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret,
			ttlMs: 50,
		});

		const pendingState = await stateManager.getState();
		expect(JSON.stringify(pendingState)).not.toContain(secret);
		expect(pendingState.pendingPairingTickets).toEqual([
			{
				secretHash: hashIrohRemotePairingSecret(secret),
				workspace: "volt",
				allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
				createdAt: 100,
				expiresAt: 150,
			},
		]);

		const restartedHostEngine = new IrohRemoteHostEngine({
			auditLogger,
			now: () => 200,
			stateManager,
			workspace,
		});
		const expired = await restartedHostEngine.authorizeHello(makeHello("volt", secret, "late phone"), "late-client");
		expect(expired).toEqual({
			ok: false,
			error: "pairing ticket has expired",
			expiredPairingTickets: [
				{
					secretHash: hashIrohRemotePairingSecret(secret),
					workspace: "volt",
					allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
					createdAt: 100,
					expiresAt: 150,
				},
			],
			outcome: "pairing_secret_expired",
			pairingSecretExpired: true,
		});
		expect((await stateManager.getState()).pendingPairingTickets).toEqual([]);
		expect((await stateManager.getState()).pairingSecretTombstones).toEqual([
			{
				secretHash: hashIrohRemotePairingSecret(secret),
				workspace: "volt",
				outcome: "pairing_secret_expired",
				createdAt: 100,
				expiresAt: 150,
				expiredAt: 200,
				retainUntil: 200 + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
			},
		]);
		const retainedExpiredHostEngine = new IrohRemoteHostEngine({
			auditLogger,
			now: () => 250,
			stateManager,
			workspace,
		});
		await expect(
			retainedExpiredHostEngine.authorizeHello(makeHello("volt", secret), "later-client"),
		).resolves.toEqual({
			ok: false,
			error: "pairing ticket has expired",
			outcome: "pairing_secret_expired",
			pairingSecretExpired: true,
		});
		const prunedExpiredHostEngine = new IrohRemoteHostEngine({
			auditLogger,
			now: () => 201 + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
			stateManager,
			workspace,
		});
		await expect(prunedExpiredHostEngine.authorizeHello(makeHello("volt", secret), "later-client")).resolves.toEqual({
			ok: false,
			error: "client is not paired",
			outcome: "client_unknown",
			pairingSecretExpired: false,
		});
		expect((await stateManager.getState()).pairingSecretTombstones).toEqual([]);
		expect(sink.events.map((event) => event.type)).toEqual([
			"pairing_ticket_created",
			"pairing_ticket_expired",
			"client_rejected",
			"client_rejected",
			"client_rejected",
		]);
		expect(sink.events).toEqual([
			expect.objectContaining({ type: "pairing_ticket_created", workspace: "volt" }),
			expect.objectContaining({
				type: "pairing_ticket_expired",
				workspace: "volt",
				success: false,
				details: expect.objectContaining({ createdAt: 100, expiresAt: 150 }),
			}),
			expect.objectContaining({ type: "client_rejected", error: "pairing ticket has expired" }),
			expect.objectContaining({ type: "client_rejected", error: "pairing ticket has expired" }),
			expect.objectContaining({ type: "client_rejected", error: "client is not paired" }),
		]);
	});

	test("host state manager returns defensive copies", async () => {
		const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
		const initialState: IrohRemoteHostState = {
			hostSecretKey: [1, 2, 3],
			pairingSecretTombstones: [
				{
					secretHash: "sha256:consumed",
					workspace: "volt",
					outcome: "pairing_secret_consumed",
					createdAt: 1,
					expiresAt: 200,
					consumedAt: 10,
					clientNodeId: "client-node",
					retainUntil: 300,
				},
			],
			workspaces: [{ ...workspace }],
			clients: [
				{
					nodeId: "client-node",
					label: "phone",
					allowedWorkspaces: ["volt"],
					allowedTools: "read",
					pairedAt: 1,
					lastSeenAt: 1,
					lastSessionIdByWorkspace: { volt: "session-one" },
				},
			],
			revokedClients: [
				{
					nodeId: "revoked-node",
					label: "revoked phone",
					allowedWorkspaces: ["volt"],
					allowedTools: "read",
					pairedAt: 2,
					lastSeenAt: 3,
					revokedAt: 4,
					lastSessionIdByWorkspace: { volt: "revoked-session" },
				},
			],
			pendingPairingTickets: [
				{
					secretHash: "sha256:pending",
					workspace: "volt",
					allowedTools: "read",
					createdAt: 1,
					expiresAt: 200,
				},
			],
		};
		const stateManager = new IrohRemoteHostStateManager({ initialState });
		initialState.workspaces[0].path = "/mutated-before-load";
		initialState.clients[0].lastSessionIdByWorkspace!.volt = "mutated-before-load";
		initialState.revokedClients![0].lastSessionIdByWorkspace!.volt = "mutated-before-load";
		initialState.revokedClients![0].allowedWorkspaces.push("mutated-before-load");
		initialState.hostSecretKey?.push(4);
		initialState.pairingSecretTombstones?.push({
			secretHash: "sha256:leaked-tombstone",
			workspace: "leaked",
			outcome: "pairing_secret_expired",
			createdAt: 1,
			expiresAt: 2,
			expiredAt: 3,
			retainUntil: 4,
		});
		initialState.pendingPairingTickets?.push({
			secretHash: "sha256:leaked",
			workspace: "leaked",
			allowedTools: "bash",
			createdAt: 1,
			expiresAt: 200,
		});

		const loaded = await stateManager.load();
		loaded.hostSecretKey?.push(5);
		loaded.workspaces[0].path = "/mutated-loaded";
		loaded.pairingSecretTombstones?.push({
			secretHash: "sha256:loaded-tombstone-leak",
			workspace: "loaded-leak",
			outcome: "pairing_secret_expired",
			createdAt: 1,
			expiresAt: 2,
			expiredAt: 3,
			retainUntil: 4,
		});
		loaded.pendingPairingTickets?.push({
			secretHash: "sha256:loaded-leak",
			workspace: "loaded-leak",
			allowedTools: "bash",
			createdAt: 1,
			expiresAt: 200,
		});
		loaded.clients[0].lastSessionIdByWorkspace!.volt = "mutated-session";
		loaded.revokedClients?.push({
			nodeId: "loaded-revoked-leak",
			label: "loaded revoked leak",
			allowedWorkspaces: ["loaded-leak"],
			allowedTools: "bash",
			pairedAt: 1,
			lastSeenAt: 2,
			revokedAt: 3,
		});
		loaded.revokedClients![0].lastSessionIdByWorkspace!.volt = "mutated-revoked-session";
		loaded.clients.push({
			nodeId: "leaked-client",
			label: "leaked",
			allowedWorkspaces: [],
			allowedTools: "read",
			pairedAt: 1,
			lastSeenAt: 1,
		});
		expect(await stateManager.getState()).toEqual({
			hostSecretKey: [1, 2, 3],
			pairingSecretTombstones: [
				{
					secretHash: "sha256:consumed",
					workspace: "volt",
					outcome: "pairing_secret_consumed",
					createdAt: 1,
					expiresAt: 200,
					consumedAt: 10,
					clientNodeId: "client-node",
					retainUntil: 300,
				},
			],
			workspaces: [{ name: "volt", path: "/workspace" }],
			clients: [
				{
					nodeId: "client-node",
					label: "phone",
					allowedWorkspaces: ["volt"],
					allowedTools: "read",
					pairedAt: 1,
					lastSeenAt: 1,
					lastSessionIdByWorkspace: { volt: "session-one" },
				},
			],
			revokedClients: [
				{
					nodeId: "revoked-node",
					label: "revoked phone",
					allowedWorkspaces: ["volt"],
					allowedTools: "read",
					pairedAt: 2,
					lastSeenAt: 3,
					revokedAt: 4,
					lastSessionIdByWorkspace: { volt: "revoked-session" },
				},
			],
			pendingPairingTickets: [
				{
					secretHash: "sha256:pending",
					workspace: "volt",
					allowedTools: "read",
					createdAt: 1,
					expiresAt: 200,
				},
			],
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
		expect(state.clients[0].allowedWorkspaces).toEqual([]);
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

	test("host engine pairs registered workspaces and rejects unavailable pair workspaces", async () => {
		const stateManager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await stateManager.upsertWorkspace({ name: "safe", path: "/workspace" });
		await stateManager.upsertWorkspace({ name: "private", path: "/private", allowedTools: "read" });
		await stateManager.upsertWorkspace({ name: "stale", path: "/stale" });
		const hostEngine = new IrohRemoteHostEngine({
			now: () => 100,
			stateManager,
			validateWorkspace: (workspace) => workspace.name !== "stale",
			workspace: { name: "safe", path: "/workspace" },
		});

		const pairing = await hostEngine.pair({
			irohTicket: "iroh-endpoint-ticket",
			secret: "private-secret",
			ttlMs: 1000,
			workspace: "private",
		});
		expect(pairing.payload.workspace).toBe("private");
		expect(await stateManager.getState()).toMatchObject({
			pendingPairingTickets: [
				{
					secretHash: hashIrohRemotePairingSecret("private-secret"),
					workspace: "private",
					allowedTools: "read",
					createdAt: 100,
					expiresAt: 1100,
				},
			],
		});
		await expect(
			hostEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				secret: "missing-secret",
				workspace: "missing",
			}),
		).rejects.toThrow("workspace_unavailable: workspace not registered: missing");
		await expect(
			hostEngine.pair({
				irohTicket: "iroh-endpoint-ticket",
				secret: "stale-secret",
				workspace: "stale",
			}),
		).rejects.toThrow("workspace_unavailable: workspace path is unavailable: stale");
		expect((await stateManager.getState()).pendingPairingTickets).toHaveLength(1);
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
		expect(second).toEqual({
			ok: false,
			error: "pairing ticket has already been used",
			outcome: "pairing_secret_consumed",
			pairingSecretExpired: false,
		});
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
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});

			await expect(secondEngine.authorizeHello(makeHello("volt", "secret"), "second-client")).resolves.toEqual({
				ok: false,
				error: "pairing ticket has already been used",
				outcome: "pairing_secret_consumed",
				pairingSecretExpired: false,
			});
			const recovered = await secondEngine.authorizeHello(makeHello("volt", "secret", "recovered"), "first-client");
			if (!recovered.ok) {
				throw new Error(recovered.error);
			}
			expect(recovered.paired).toBe(false);
			expect(recovered.pairingSecretConsumed).toBe(false);
			const savedState = await readIrohRemoteHostState(statePath);
			expect(savedState.clients).toEqual([expect.objectContaining({ nodeId: "first-client" })]);
			expect(savedState.pairingSecretTombstones).toEqual([
				expect.objectContaining({
					secretHash: hashIrohRemotePairingSecret("secret"),
					outcome: "pairing_secret_consumed",
					clientNodeId: "first-client",
				}),
			]);
		} finally {
			await rm(stateDir, { force: true, recursive: true });
		}
	});

	test("persists runtime-only pairing secret consumption across host engine restart", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "volt-iroh-core-runtime-pairing-consumption-"));
		try {
			const statePath = join(stateDir, "host.json");
			const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
			const firstEngine = new IrohRemoteHostEngine({
				now: () => 100,
				pairingExpiresAt: 200,
				pairingSecret: "runtime-secret",
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});
			const paired = await firstEngine.authorizeHello(makeHello("volt", "runtime-secret"), "first-client");
			if (!paired.ok) {
				throw new Error(paired.error);
			}
			expect(paired.paired).toBe(true);
			expect((await readIrohRemoteHostState(statePath)).pairingSecretTombstones).toEqual([
				{
					secretHash: hashIrohRemotePairingSecret("runtime-secret"),
					workspace: "volt",
					outcome: "pairing_secret_consumed",
					expiresAt: 200,
					consumedAt: 100,
					clientNodeId: "first-client",
					retainUntil: 100 + DEFAULT_IROH_REMOTE_PAIRING_SECRET_TOMBSTONE_RETENTION_MS,
				},
			]);

			const restartedEngine = new IrohRemoteHostEngine({
				now: () => 125,
				stateManager: new IrohRemoteHostStateManager({ statePath }),
				workspace,
			});
			await expect(
				restartedEngine.authorizeHello(makeHello("volt", "runtime-secret"), "second-client"),
			).resolves.toEqual({
				ok: false,
				error: "pairing ticket has already been used",
				outcome: "pairing_secret_consumed",
				pairingSecretExpired: false,
			});
			await expect(
				restartedEngine.authorizeHello(makeHello("volt", "runtime-secret", "recovered"), "first-client"),
			).resolves.toMatchObject({
				ok: true,
				paired: false,
				pairingSecretConsumed: false,
			});
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
			expect(authorization).toEqual({
				ok: false,
				error: "client is revoked",
				outcome: "client_revoked",
				pairingSecretExpired: false,
			});
			const savedState = await readIrohRemoteHostState(statePath);
			expect(savedState.clients).toEqual([]);
			expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
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
				expect(authorization).toEqual({
					ok: false,
					error: "client is revoked",
					outcome: "client_revoked",
					pairingSecretExpired: false,
				});
			}
			const savedState = await readIrohRemoteHostState(statePath);
			expect(savedState.clients).toEqual([]);
			expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
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

			const savedState = await readIrohRemoteHostState(statePath);
			expect(savedState.clients).toEqual([]);
			expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
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

			const savedState = await readIrohRemoteHostState(statePath);
			expect(savedState.clients).toEqual([]);
			expect(savedState.revokedClients).toEqual([expect.objectContaining({ nodeId: "client-node" })]);
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
			hostNodeId: "host-node",
			clientNodeId: "client-node",
			child: "volt",
		};
		const recv = new ManualIrohRecvStream();
		recv.push(Buffer.from(`${JSON.stringify(response)}\n{"type":"response"}\n`));
		await writeIrohRemoteHandshakeResponse(send, response);

		await expect(
			clientEngine.readHandshakeResponse(recv, { expectedHostNodeId: "host-node", timeoutMs: 1000 }),
		).resolves.toEqual({
			response,
			initialInput: Buffer.from('{"type":"response"}\n'),
		});
		expect(send.writtenText()).toBe(`${JSON.stringify(hello)}\n${JSON.stringify(response)}\n`);
		expect(sink.events.map((event) => event.type)).toEqual(["ticket_loaded", "handshake_response_received"]);

		const mismatched = new ManualIrohRecvStream();
		mismatched.push(Buffer.from(`${JSON.stringify({ ...response, hostNodeId: "other-host" })}\n`));
		await expect(
			clientEngine.readHandshakeResponse(mismatched, { expectedHostNodeId: "host-node", timeoutMs: 1000 }),
		).rejects.toThrow("host_identity_mismatch: expected host-node, got other-host");

		const missing = new ManualIrohRecvStream();
		missing.push(
			Buffer.from(
				`${JSON.stringify({
					type: "volt_iroh_handshake",
					success: true,
					workspace: "volt",
					clientNodeId: "client-node",
				})}\n`,
			),
		);
		await expect(
			clientEngine.readHandshakeResponse(missing, { expectedHostNodeId: "host-node", timeoutMs: 1000 }),
		).rejects.toThrow("host_identity_mismatch: expected host-node, got <missing>");
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
				error: "RPC command not allowed over remote host: bash",
			},
			expect.objectContaining({ type: "response", command: "parse", success: false }),
		]);
		expect(inner.waitForBackpressureCalls).toBe(1);
		expect(inner.flushCalls).toBe(1);
		expect(inner.closeCalls).toBe(1);
	});

	test("routes remote command filter rejections through outbound and close-deferring layers", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteFilteredRpcTransport({
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: createIrohRemoteOutboundFilteredRpcTransport({
					transport: inner,
					workspacePath: "/Users/jordan/project",
				}),
				waitForPromptCompletion: () => Promise.resolve(),
			}),
		});
		const forwardedLines: string[] = [];
		transport.onLine((line) => {
			forwardedLines.push(line);
		});

		inner.emitLine(JSON.stringify({ id: "private-command", type: "/Users/jordan/private" }));
		await transport.waitForBackpressure?.();

		expect(forwardedLines).toEqual([]);
		expect(inner.writes).toEqual([
			expect.objectContaining({
				id: "private-command",
				type: "response",
				command: IROH_REMOTE_REDACTED_HOST_PATH,
				success: false,
				error: `RPC command not allowed over remote host: ${IROH_REMOTE_REDACTED_HOST_PATH}`,
			}),
		]);
	});

	test("sanitizes representative remote-safe RPC event views", () => {
		const workspacePath = "/Users/jordan/project";
		const sessionFile = "/Users/jordan/.volt/agent/sessions/project/session.jsonl";
		const exportPath = "/Users/jordan/.volt/agent/exports/Volt-session-session.html";
		const bashOutputPath = join(tmpdir(), "volt-bash-deadbeef.log");

		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "response",
					command: "get_state",
					success: true,
					data: {
						cwd: `${workspacePath}/src`,
						sessionFile,
						sessionPath: sessionFile,
						message: `Workspace ${workspacePath}/src/index.ts private /Users/jordan/.volt/auth.json`,
					},
				},
				{ workspacePath },
			),
		).toEqual({
			type: "response",
			command: "get_state",
			success: true,
			data: {
				cwd: "/workspace/src",
				sessionPath: IROH_REMOTE_REDACTED_SESSION_FILE,
				message: `Workspace /workspace/src/index.ts private ${IROH_REMOTE_REDACTED_HOST_PATH}`,
			},
		});
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "response",
					command: "export_html",
					success: true,
					data: { path: exportPath, message: `Exported ${exportPath}` },
				},
				{ workspacePath },
			),
		).toEqual({
			type: "response",
			command: "export_html",
			success: true,
			data: { path: IROH_REMOTE_REDACTED_EXPORT_PATH, message: `Exported ${IROH_REMOTE_REDACTED_EXPORT_PATH}` },
		});
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "response",
					command: "bash",
					success: true,
					data: {
						fullOutputPath: bashOutputPath,
						outputPath: bashOutputPath,
						stdout: `Wrote ${bashOutputPath}`,
						stderr: "opened file://localhost/Users/jordan/.volt/auth.json",
					},
				},
				{ workspacePath },
			),
		).toEqual({
			type: "response",
			command: "bash",
			success: true,
			data: {
				outputPath: IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH,
				stdout: `Wrote ${IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH}`,
				stderr: `opened ${IROH_REMOTE_REDACTED_HOST_PATH}`,
			},
		});
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "response",
					command: "get_transcript",
					success: true,
					data: {
						sessionId: "session-one",
						items: [
							{
								id: "entry-one",
								role: "tool",
								toolName: "read",
								status: "completed",
								path: `${workspacePath}/src/index.ts`,
								summary: `Read ${workspacePath}/src/index.ts and /Users/jordan/.volt/auth.json`,
								timestamp: "2026-06-22T15:00:00.000Z",
							},
						],
						hasMore: false,
						nextBeforeEntryId: null,
					},
				},
				{ workspacePath },
			),
		).toEqual({
			type: "response",
			command: "get_transcript",
			success: true,
			data: {
				sessionId: "session-one",
				items: [
					{
						id: "entry-one",
						role: "tool",
						toolName: "read",
						status: "completed",
						path: "/workspace/src/index.ts",
						summary: `Read /workspace/src/index.ts and ${IROH_REMOTE_REDACTED_HOST_PATH}`,
						timestamp: "2026-06-22T15:00:00.000Z",
					},
				],
				hasMore: false,
				nextBeforeEntryId: null,
			},
		});
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "extension_ui_request",
					id: "extension-confirm-1",
					method: "confirm",
					title: `Use ${workspacePath}/src/index.ts`,
					message: "Approve /Users/jordan/.volt/auth.json?",
				},
				{ workspacePath },
			),
		).toEqual({
			type: "extension_ui_request",
			id: "extension-confirm-1",
			method: "confirm",
			title: "Use /workspace/src/index.ts",
			message: `Approve ${IROH_REMOTE_REDACTED_HOST_PATH}?`,
		});
		expect(
			sanitizeIrohRemoteOutbound(
				{
					type: "event",
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: `Read ${workspacePath}/src/index.ts and /Users/jordan/.volt/auth.json`,
								textSignature: "/opaque/text-signature",
							},
							{
								type: "thinking",
								thinking: "Saw /Users/jordan/.volt/auth.json",
								thinkingSignature: "/opaque/thinking-signature",
							},
							{
								type: "image",
								data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
								mimeType: "image/jpeg",
							},
							{
								type: "toolCall",
								id: "tool-call-1",
								name: "read",
								arguments: { path: "/Users/jordan/.volt/auth.json", cwd: `${workspacePath}/src` },
								thoughtSignature: "/opaque/thought-signature",
							},
						],
					},
				},
				{ workspacePath },
			),
		).toEqual({
			type: "event",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Read /workspace/src/index.ts and ${IROH_REMOTE_REDACTED_HOST_PATH}`,
						textSignature: "/opaque/text-signature",
					},
					{
						type: "thinking",
						thinking: `Saw ${IROH_REMOTE_REDACTED_HOST_PATH}`,
						thinkingSignature: "/opaque/thinking-signature",
					},
					{
						type: "image",
						data: "/9j/4AAQSkZJRgABAQAAAQABAAD=",
						mimeType: "image/jpeg",
					},
					{
						type: "toolCall",
						id: "tool-call-1",
						name: "read",
						arguments: { path: IROH_REMOTE_REDACTED_HOST_PATH, cwd: "/workspace/src" },
						thoughtSignature: "/opaque/thought-signature",
					},
				],
			},
		});
	});

	test("sanitizes remote outbound host paths", () => {
		const workspacePath = "/Users/jordan/project";
		const sessionFile = "/Users/jordan/.volt/agent/sessions/project/session.jsonl";
		const exportPath = "/Users/jordan/.volt/agent/exports/Volt-session-session.html";
		const bashOutputPath = join(tmpdir(), "volt-bash-deadbeef.log");

		const sanitized = sanitizeIrohRemoteOutbound(
			{
				id: "/Users/jordan/private/request-id",
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
			id: string;
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

		expect(sanitized.id).toBe("/Users/jordan/private/request-id");
		expect(sanitized.data.sessionFile).toBeUndefined();
		expect(sanitized.data.sessionPath).toBe(IROH_REMOTE_REDACTED_SESSION_FILE);
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
		const spacedRelativeSeparatorSanitized = sanitizeIrohRemoteOutbound(
			{ message: "Updated Sources / Example.swift, Sources /Example.swift, and Sources/Example.swift" },
			{ workspacePath },
		) as { message: string };
		expect(spacedRelativeSeparatorSanitized.message).toBe(
			"Updated Sources / Example.swift, Sources /Example.swift, and Sources/Example.swift",
		);
		const strictRootPathSanitized = sanitizeIrohRemoteOutbound({ path: "/" }, { workspacePath }) as {
			path: string;
		};
		expect(strictRootPathSanitized.path).toBe(IROH_REMOTE_REDACTED_HOST_PATH);

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
			id: "/Users/jordan/private/request-id",
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
				id: "/Users/jordan/private/request-id",
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

	test("defers clean remote close until unknown command error responses are written", async () => {
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

		inner.emitLine(JSON.stringify({ id: "unknown-1", type: "unknown_rpc" }));
		inner.emitClose();
		await nextTick();
		expect(closed).toBe(false);

		transport.write({ id: "unknown-1", type: "response", command: "unknown_rpc", success: false });
		await nextTick();

		expect(closed).toBe(true);
	});

	test("does not hang clean remote close after synchronous response write failures", async () => {
		const inner = new ManualRpcTransport();
		const writeError = new Error("send closed");
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

		inner.writeError = writeError;
		expect(() => transport.write({ id: "state-1", type: "response", command: "get_state", success: true })).toThrow(
			writeError,
		);
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

	test("matches duplicate id-less prompt-like responses one pending command at a time", async () => {
		const inner = new ManualRpcTransport();
		const firstCompletion = createDeferredVoid();
		const secondCompletion = createDeferredVoid();
		const completions = [firstCompletion, secondCompletion];
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => {
				const completion = completions.shift();
				if (!completion) {
					throw new Error("unexpected prompt completion wait");
				}
				return completion.promise;
			},
		});
		let closed = false;
		transport.onLine(() => {});
		transport.onClose?.(() => {
			closed = true;
		});

		inner.emitLine(JSON.stringify({ type: "steer", message: "first" }));
		inner.emitLine(JSON.stringify({ type: "steer", message: "second" }));
		inner.emitClose();
		await nextTick();
		expect(closed).toBe(false);

		transport.write({ type: "response", command: "steer", success: true });
		transport.write({ type: "response", command: "steer", success: true });
		await nextTick();
		expect(closed).toBe(false);

		firstCompletion.resolve();
		await nextTick();
		expect(closed).toBe(false);

		secondCompletion.resolve();
		await nextTick();

		expect(closed).toBe(true);
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
			error: "RPC command not allowed over remote host: bash",
		});
		expect(serializeIrohRemoteRpcFilterRejection(rejected.response)).toBe(`${JSON.stringify(rejected.response)}\n`);

		const parseFailure = getIrohRemoteRpcFilterResult("{");
		if (parseFailure.allowed) {
			throw new Error("invalid JSON should have been rejected");
		}
		expect(parseFailure.response.command).toBe("parse");
		expect(parseFailure.response.error).toContain("Failed to parse command");

		const missingType = getIrohRemoteRpcFilterResult(JSON.stringify({ id: "missing-type" }));
		if (missingType.allowed) {
			throw new Error("missing type should have been rejected");
		}
		expect(missingType.response).toEqual({
			id: "missing-type",
			type: "response",
			command: "unknown",
			success: false,
			error: "RPC command must be a JSON object with a string type",
		});

		const numericType = getIrohRemoteRpcFilterResult(JSON.stringify({ id: "numeric-type", type: 1 }));
		if (numericType.allowed) {
			throw new Error("numeric type should have been rejected");
		}
		expect(numericType.response).toEqual({
			id: "numeric-type",
			type: "response",
			command: "unknown",
			success: false,
			error: "RPC command must be a JSON object with a string type",
		});
	});
});
