import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemoteHandshakeSuccess,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HOST_FEATURES,
	type IrohRemoteHello,
	IrohRemoteHostEngine,
	IrohRemoteHostStateManager,
	type IrohRemoteWorkspace,
	parseIrohRemoteHandshakeResponseLine,
	parseIrohRemoteHelloLine,
} from "../src/core/remote/iroh/index.ts";
import type { IrohBytes, IrohRecvStreamLike, IrohSendStreamLike } from "../src/core/rpc/index.ts";

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

class ManualIrohRecvStream implements IrohRecvStreamLike {
	private readonly queue: QueuedIrohRead[] = [];

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		const queued = this.queue.shift();
		if (!queued) {
			return Promise.resolve(undefined);
		}
		return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
	}

	push(bytes: IrohBytes): void {
		this.queue.push({ type: "data", bytes });
	}

	stop(_errorCode: bigint): void {
		this.queue.length = 0;
	}
}

class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];

	async writeAll(bytes: Array<number>): Promise<void> {
		this.writes.push(bytes);
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

function parseHello(fields: Record<string, unknown>): IrohRemoteHello {
	return parseIrohRemoteHelloLine(
		JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			...fields,
		}),
	);
}

function responseLine(fields: Record<string, unknown>): string {
	return JSON.stringify({
		type: "volt_iroh_handshake",
		success: true,
		workspace: "volt",
		hostNodeId: "host-node",
		clientNodeId: "client-node",
		features: [...IROH_REMOTE_HOST_FEATURES],
		...fields,
	});
}

async function createPairedHostEngine(): Promise<IrohRemoteHostEngine> {
	const workspace: IrohRemoteWorkspace = { name: "volt", path: "/workspace" };
	const hostEngine = new IrohRemoteHostEngine({
		hostNodeId: "host-node",
		now: () => 100,
		stateManager: new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() }),
		workspace,
	});
	await hostEngine.pair({
		irohTicket: "iroh-endpoint-ticket",
		nodeId: "host-node",
		relayMode: "disabled",
		secret: "secret",
	});
	return hostEngine;
}

async function readHandshakeForHello(
	hostEngine: IrohRemoteHostEngine,
	hello: Record<string, unknown>,
	options: Parameters<IrohRemoteHostEngine["readHandshake"]>[2] = {},
) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	recv.push(Buffer.from(`${JSON.stringify(hello)}\n`));
	const handshake = await hostEngine.readHandshake({ recv, send }, "client-node", options);
	const written = send.writtenText().trim();
	return { handshake, written: written.length === 0 ? undefined : JSON.parse(written) };
}

describe("Iroh remote handshake stream modes", () => {
	test("parses exactly one hello stream mode", () => {
		expect(parseHello({ conversation: { target: "last" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "last" },
		});
		expect(parseHello({ conversation: { target: "new" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "new" },
		});
		expect(parseHello({ conversation: { target: "session", sessionId: "abc_123-id" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "session", sessionId: "abc_123-id" },
		});
		expect(parseHello({ workspaceDiscovery: { purpose: "list_sessions" } })).toMatchObject({
			mode: "workspaceDiscovery",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		expect(parseHello({ workspaceManagement: { purpose: "unregister_workspace" } })).toMatchObject({
			mode: "workspaceManagement",
			workspaceManagement: { purpose: "unregister_workspace" },
		});
		expect(() =>
			parseIrohRemoteHelloLine(
				JSON.stringify({
					type: "volt_iroh_hello",
					protocol: IROH_REMOTE_ALPN,
					workspace: "volt",
				}),
			),
		).toThrow("Iroh remote hello must include exactly one stream mode");

		for (const invalid of [
			{},
			{ conversation: { target: "last" }, workspaceDiscovery: { purpose: "list_sessions" } },
			{ conversation: { target: "last", sessionId: "abc" } },
			{ conversation: { target: "new", sessionId: "abc" } },
			{ conversation: { target: "session" } },
			{ conversation: { target: "session", sessionId: "ABC" } },
			{ conversation: { target: "unknown" } },
			{ workspaceDiscovery: { purpose: "unknown" } },
			{ workspaceManagement: { purpose: "unknown" } },
			{ workspaceDiscovery: { purpose: "list_sessions", extra: true } },
		]) {
			expect(() => parseHello(invalid)).toThrow();
		}
		expect(() => parseHello({ workspace: "bad\nworkspace", conversation: { target: "last" } })).toThrow(
			"handshake workspace must not contain ASCII control characters",
		);
	});

	test("parses handshake mode metadata and target selection matrices", () => {
		for (const [target, selection] of [
			["new", "created"],
			["session", "resumed"],
			["last", "resumed"],
			["last", "created"],
			["last", "created_missing_last"],
		]) {
			expect(
				parseIrohRemoteHandshakeResponseLine(
					responseLine({
						sessionId: "abc123",
						conversation: { target, sessionId: "abc123", selection },
					}),
				),
			).toMatchObject({
				success: true,
				sessionId: "abc123",
				conversation: { target, sessionId: "abc123", selection },
			});
		}

		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceDiscovery: { purpose: "list_sessions" } })),
		).toMatchObject({ success: true, workspaceDiscovery: { purpose: "list_sessions" } });
		expect(
			parseIrohRemoteHandshakeResponseLine(
				responseLine({ workspaceManagement: { purpose: "unregister_workspace" } }),
			),
		).toMatchObject({ success: true, workspaceManagement: { purpose: "unregister_workspace" } });

		for (const invalid of [
			responseLine({
				sessionId: "abc123",
				conversation: { target: "new", sessionId: "abc123", selection: "resumed" },
			}),
			responseLine({
				sessionId: "abc123",
				conversation: { target: "session", sessionId: "abc123", selection: "created" },
			}),
			responseLine({
				sessionId: "abc123",
				conversation: { target: "last", sessionId: "other", selection: "resumed" },
			}),
			responseLine({
				sessionId: "abc123",
				workspaceDiscovery: { purpose: "list_sessions" },
			}),
			responseLine({
				workspaceDiscovery: { purpose: "list_sessions" },
				workspaceManagement: { purpose: "unregister_workspace" },
			}),
			responseLine({
				sessionId: "abc123",
				conversation: { target: "last", sessionId: "abc123", selection: "resumed" },
				features: ["multi_streams.v1"],
			}),
			responseLine({
				hostNodeId: undefined,
				sessionId: "abc123",
				conversation: { target: "last", sessionId: "abc123", selection: "resumed" },
			}),
			responseLine({
				sessionId: "abc123",
				conversation: { target: "last", sessionId: "abc123", selection: "resumed", extra: true },
			}),
			responseLine({
				workspaceDiscovery: { purpose: "list_sessions", extra: true },
			}),
			responseLine({
				workspaceManagement: { purpose: "unregister_workspace", extra: true },
			}),
		]) {
			expect(() => parseIrohRemoteHandshakeResponseLine(invalid)).toThrow();
		}
	});

	test("host engine emits stable mode success and malformed-mode failure responses", async () => {
		const hostEngine = await createPairedHostEngine();
		const baseHello = {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "secret",
			clientLabel: "phone",
		};

		const invalid = await readHandshakeForHello(hostEngine, baseHello);
		expect(invalid.handshake).toMatchObject({
			ok: false,
			response: {
				success: false,
				outcome: "invalid_conversation_target",
			},
		});
		expect(invalid.written).toMatchObject({
			success: false,
			outcome: "invalid_conversation_target",
		});

		const unsupportedConversation = await readHandshakeForHello(hostEngine, {
			...baseHello,
			conversation: { target: "last" },
		});
		expect(unsupportedConversation.handshake).toMatchObject({
			ok: false,
			response: {
				success: false,
				outcome: "conversation_streams_unsupported",
			},
		});
		expect(unsupportedConversation.written).toMatchObject({
			success: false,
			outcome: "conversation_streams_unsupported",
		});

		const conversation = await readHandshakeForHello(
			hostEngine,
			{ ...baseHello, conversation: { target: "session", sessionId: "abc123" } },
			{ conversationSession: { sessionId: "abc123", selection: "resumed" } },
		);
		expect(conversation.handshake).toMatchObject({
			ok: true,
			response: {
				success: true,
				sessionId: "abc123",
				conversation: { target: "session", sessionId: "abc123", selection: "resumed" },
			},
		});

		const discovery = await readHandshakeForHello(hostEngine, {
			...baseHello,
			secret: undefined,
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		expect(discovery.handshake).toMatchObject({
			ok: true,
			response: {
				success: true,
				workspaceDiscovery: { purpose: "list_sessions" },
			},
		});
		expect(discovery.handshake.response).not.toHaveProperty("sessionId");
		expect(discovery.handshake.response).not.toHaveProperty("conversation");

		const management = await readHandshakeForHello(hostEngine, {
			...baseHello,
			secret: undefined,
			workspaceManagement: { purpose: "unregister_workspace" },
		});
		expect(management.handshake).toMatchObject({
			ok: true,
			response: {
				success: true,
				workspaceManagement: { purpose: "unregister_workspace" },
			},
		});
		expect(management.handshake.response).not.toHaveProperty("sessionId");
		expect(management.handshake.response).not.toHaveProperty("conversation");

		expect(
			createIrohRemoteHandshakeSuccess({
				workspace: "volt",
				hostNodeId: "host-node",
				clientNodeId: "client-node",
				features: [...IROH_REMOTE_HOST_FEATURES],
				sessionId: "abc123",
				conversation: { target: "new", sessionId: "abc123", selection: "created" },
			}),
		).toMatchObject({
			sessionId: "abc123",
			conversation: { target: "new", sessionId: "abc123", selection: "created" },
		});
	});
});
