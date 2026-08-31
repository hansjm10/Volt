import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemoteHandshakeSuccess,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HOST_FEATURES,
	IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE,
	type IrohRemoteHello,
	IrohRemoteHostEngine,
	IrohRemoteHostStateManager,
	type IrohRemoteWorkspace,
	parseIrohRemoteHandshakeResponseLine,
	parseIrohRemoteHelloLine,
} from "../src/core/remote/iroh/index.ts";
import type { IrohBytes, IrohRecvStreamLike } from "../src/core/rpc/index.ts";

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
	recv.push(Buffer.from(`${JSON.stringify(hello)}\n`));
	return hostEngine.readHandshake(recv, "client-node", options);
}

describe("Iroh remote handshake stream modes", () => {
	test("parses exactly one hello stream mode", () => {
		expect(parseHello({ conversation: { target: "last" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "last" },
		});
		expect(parseHello({ conversation: { target: "new", sessionId: "new-session" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "new", sessionId: "new-session" },
		});
		expect(parseHello({ conversation: { target: "session", sessionId: "abc_123-id" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "session", sessionId: "abc_123-id" },
		});
		expect(parseHello({ workspaceDiscovery: { purpose: "list_sessions" } })).toMatchObject({
			mode: "workspaceDiscovery",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		expect(parseHello({ workspaceDiscovery: { purpose: "agent_options" } })).toMatchObject({
			mode: "workspaceDiscovery",
			workspaceDiscovery: { purpose: "agent_options" },
		});
		expect(parseHello({ workspaceDiscovery: { purpose: "session_contexts" } })).toMatchObject({
			mode: "workspaceDiscovery",
			workspaceDiscovery: { purpose: "session_contexts" },
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
			{ conversation: { target: "new" } },
			{ conversation: { target: "new", sessionId: "ABC" } },
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
			["new", "resumed"],
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
			parseIrohRemoteHandshakeResponseLine(
				responseLine({
					sessionId: "def456",
					conversation: {
						target: "session",
						sessionId: "def456",
						selection: "session_rekeyed",
						requestedSessionId: "abc123",
					},
				}),
			),
		).toMatchObject({
			success: true,
			sessionId: "def456",
			conversation: {
				target: "session",
				sessionId: "def456",
				selection: "session_rekeyed",
				requestedSessionId: "abc123",
			},
		});

		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceDiscovery: { purpose: "list_sessions" } })),
		).toMatchObject({ success: true, workspaceDiscovery: { purpose: "list_sessions" } });
		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceDiscovery: { purpose: "agent_options" } })),
		).toMatchObject({ success: true, workspaceDiscovery: { purpose: "agent_options" } });
		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceDiscovery: { purpose: "session_contexts" } })),
		).toMatchObject({ success: true, workspaceDiscovery: { purpose: "session_contexts" } });
		expect(
			parseIrohRemoteHandshakeResponseLine(
				responseLine({ workspaceManagement: { purpose: "unregister_workspace" } }),
			),
		).toMatchObject({ success: true, workspaceManagement: { purpose: "unregister_workspace" } });

		for (const invalid of [
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
				sessionId: "def456",
				conversation: { target: "session", sessionId: "def456", selection: "session_rekeyed" },
			}),
			responseLine({
				sessionId: "abc123",
				conversation: {
					target: "session",
					sessionId: "abc123",
					selection: "session_rekeyed",
					requestedSessionId: "abc123",
				},
			}),
			responseLine({
				sessionId: "abc123",
				conversation: {
					target: "last",
					sessionId: "abc123",
					selection: "session_rekeyed",
					requestedSessionId: "def456",
				},
			}),
			responseLine({
				sessionId: "abc123",
				conversation: {
					target: "session",
					sessionId: "abc123",
					selection: "resumed",
					requestedSessionId: "def456",
				},
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

	test("host engine returns stable mode success and malformed-mode failure responses", async () => {
		const hostEngine = await createPairedHostEngine();
		const baseHello = {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			secret: "secret",
			clientLabel: "phone",
		};

		const invalid = await readHandshakeForHello(hostEngine, baseHello);
		expect(invalid).toMatchObject({
			ok: false,
			response: {
				success: false,
				outcome: "invalid_conversation_target",
			},
		});

		const deferredConversation = await readHandshakeForHello(hostEngine, {
			...baseHello,
			conversation: { target: "last" },
		});
		expect(deferredConversation).toMatchObject({
			ok: true,
			response: {
				success: true,
			},
		});
		if (!deferredConversation.ok) {
			throw new Error(deferredConversation.error);
		}
		expect(deferredConversation.response).not.toHaveProperty("sessionId");
		expect(deferredConversation.response).not.toHaveProperty("conversation");

		const conversation = await readHandshakeForHello(
			hostEngine,
			{ ...baseHello, conversation: { target: "session", sessionId: "abc123" } },
			{ conversationSession: { sessionId: "abc123", selection: "resumed" } },
		);
		expect(conversation).toMatchObject({
			ok: true,
			response: {
				success: true,
				sessionId: "abc123",
				conversation: { target: "session", sessionId: "abc123", selection: "resumed" },
			},
		});

		const rekeyedConversation = await readHandshakeForHello(
			hostEngine,
			{ ...baseHello, conversation: { target: "session", sessionId: "abc123" } },
			{
				conversationSession: {
					sessionId: "def456",
					selection: "session_rekeyed",
					requestedSessionId: "abc123",
				},
			},
		);
		expect(rekeyedConversation).toMatchObject({
			ok: true,
			response: {
				success: true,
				sessionId: "def456",
				conversation: {
					target: "session",
					sessionId: "def456",
					selection: "session_rekeyed",
					requestedSessionId: "abc123",
				},
			},
		});

		const discovery = await readHandshakeForHello(hostEngine, {
			...baseHello,
			secret: undefined,
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		expect(discovery).toMatchObject({
			ok: true,
			response: {
				success: true,
				features: expect.arrayContaining([IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE]),
				workspaceDiscovery: { purpose: "list_sessions" },
			},
		});
		expect(discovery.response).not.toHaveProperty("sessionId");
		expect(discovery.response).not.toHaveProperty("conversation");

		const management = await readHandshakeForHello(hostEngine, {
			...baseHello,
			secret: undefined,
			workspaceManagement: { purpose: "unregister_workspace" },
		});
		expect(management).toMatchObject({
			ok: true,
			response: {
				success: true,
				workspaceManagement: { purpose: "unregister_workspace" },
			},
		});
		expect(management.response).not.toHaveProperty("sessionId");
		expect(management.response).not.toHaveProperty("conversation");

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
