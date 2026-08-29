/**
 * §12.3.3 dual-frontend integration: a TUI-owned conversation served over the
 * daemon's byte relay. Real control server on a tmpdir socket, real relay
 * redemption via createDaemonClient().openRelay(), real relay-socket adapter,
 * real runIrohRemoteRpcMode — only the phone transport and the session runtime
 * are doubles.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { writeIrohRemoteHandshakeResponse } from "../src/core/remote/iroh/handshake-reader.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { RpcConversationAuthority } from "../src/core/rpc/types.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import type { ControlRequest, RelayPreamble } from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import {
	handleIntegratedConversationRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
} from "../src/daemon/conversation-commands.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type IntegratedConversationSessionSelection,
} from "../src/daemon/handshake-responses.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { type RelayLifecycleOwner, type RelayOutcome, RelayRegistry } from "../src/daemon/relay-stream.ts";
import {
	createDaemonAttach,
	createRelayWorkspaceUnregisterRetirement,
	createTuiRelayAuthorization,
	type DaemonAttach,
	type DaemonRelayOffer,
	type OpenedRelay,
} from "../src/modes/interactive/daemon-attach.ts";
import { adaptRelaySocketToIrohStream } from "../src/modes/interactive/relay-stream-adapter.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { createTestIrohConversationOptions, createTestSession } from "./iroh-stream-doubles.ts";
import { FakePhoneIrohStream } from "./relay-doubles.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";

const SESSION_ID = "s-relay";
const WORKSPACE = { name: "ws", path: "/tmp/ws" };
const RPC_GRANT = createIrohRemotePresetAccess("full").rpcGrant;
const RELAY_WORKSPACE_NAMES = [WORKSPACE.name, "beta"];
const RELAY_WORKSPACES: RelayPreamble["authorization"]["workspaces"] = [
	{ name: WORKSPACE.name, status: "available" },
	{ name: "beta", status: "available" },
	{ name: "offline", status: "missing" },
];

function createRelayWorkspaceMetadata(): Pick<RelayPreamble["authorization"], "workspaceNames" | "workspaces"> {
	return {
		workspaceNames: [...RELAY_WORKSPACE_NAMES],
		workspaces: RELAY_WORKSPACES.map((workspace) => ({ ...workspace })),
	};
}

function getPhoneConversationAuthority(phone: FakePhoneIrohStream): RpcConversationAuthority {
	const bootstrap = phone
		.receivedFrames()
		.slice()
		.reverse()
		.find((frame) => frame.type === "conversation_bootstrap");
	const conversation = bootstrap?.conversation as Record<string, unknown> | undefined;
	const delivery = bootstrap?.delivery as Record<string, unknown> | undefined;
	const transcript = bootstrap?.transcript as Record<string, unknown> | undefined;
	if (
		typeof conversation?.sessionId !== "string" ||
		typeof delivery?.subscriptionId !== "string" ||
		typeof transcript?.branchEpoch !== "string"
	) {
		throw new Error("Phone has not received a complete conversation authority bootstrap");
	}
	return {
		sessionId: conversation.sessionId,
		subscriptionId: delivery.subscriptionId,
		branchEpoch: transcript.branchEpoch,
	};
}

function createStableSessionRunner<TSession>(getSession: () => TSession) {
	return {
		async runWithStableSession<TResult>(
			operation: (session: TSession) => Promise<TResult> | TResult,
		): Promise<TResult> {
			const session = getSession();
			return operation(session);
		},
		runSessionInterruption<TResult>(operation: (session: TSession) => TResult): TResult {
			return operation(getSession());
		},
	};
}

function createFanoutSession(sessionId: string) {
	const session = createTestSession(sessionId, null);
	const subscribers = new Set<(event: AgentSessionEvent) => void>();
	session.subscribe = vi.fn((handler: (event: AgentSessionEvent) => void) => {
		subscribers.add(handler);
		return () => {
			subscribers.delete(handler);
		};
	});
	const abort = vi.fn(async () => {});
	return {
		session: Object.assign(session, { abort, getAvailableThinkingLevels: () => [session.thinkingLevel] }),
		abort,
		emit(event: AgentSessionEvent) {
			for (const handler of Array.from(subscribers)) {
				handler(event);
			}
		},
	};
}

function createPhoneHello(sessionId: string): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: WORKSPACE.name,
		mode: "conversation",
		conversation: { target: "session", sessionId },
	} as IrohRemoteHello;
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

interface DaemonHarness {
	socketPath: string;
	registry: RelayRegistry;
	server: ControlServer;
}

async function startDaemonHarness(): Promise<DaemonHarness> {
	const endpoint = createTestSocketEndpoint("volt-dualfe");
	const registry = new RelayRegistry();
	let server: ControlServer;
	try {
		server = await startControlServer({
			socketPath: endpoint.socketPath,
			version: "0.0.0-test",
			handlers: {
				onRequest: () => {},
				relayAdmission: {
					admitRelay: (hello, socket, bufferedRemainder) =>
						registry.admit(hello.relayId, hello.relayToken, socket, bufferedRemainder),
				},
			},
		});
	} catch (error) {
		endpoint.cleanup();
		throw error;
	}
	cleanups.push(async () => {
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		endpoint.cleanup();
	});
	return { socketPath: endpoint.socketPath, registry, server };
}

interface OwnedRelayDaemonHarness {
	agentDir: string;
	workspaceDir: string;
	registry: RelayRegistry;
	broker: LeaseBroker;
	server: ControlServer;
	attach: DaemonAttach;
}

async function startOwnedRelayDaemonHarness(): Promise<OwnedRelayDaemonHarness> {
	const agentDir = mkdtempSync(join(tmpdir(), "volt-dualfe-owned-"));
	const workspaceDir = mkdtempSync(join(tmpdir(), "volt-dualfe-owned-ws-"));
	const paths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const authToken = randomUUID();
	const registry = new RelayRegistry();
	let workspaceRegistered = true;
	let server: ControlServer;
	const broker = new LeaseBroker({
		isRuntimeStreaming: () => false,
		waitForRuntimeIdle: async () => {},
		disposeRuntime: async () => {},
		closePhoneStreams: () => {},
		closeRelays: (record, reason) => {
			for (const relayId of Array.from(record.relayIds)) {
				void registry.get(relayId)?.close(reason);
			}
		},
		beginTuiLeaseHandoff: () => {},
		commitTuiLeaseHandoff: () => {},
		cancelTuiLeaseHandoff: () => {},
		releaseTuiLease: () => {},
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
		audit: () => {},
	});
	const handleRequest = async (connection: ControlConnection, request: ControlRequest): Promise<void> => {
		switch (request.type) {
			case "status":
				connection.send({
					type: "status_result",
					id: request.id,
					version: "0.0.0-test",
					protocolVersion: 1,
					pid: process.pid,
					startedAtMs: 0,
					leases: broker.list().map((record) => ({
						workspaceName: record.workspaceName,
						sessionId: record.sessionId,
						state: record.state,
						relayCount: record.relayIds.size,
						streamCount: record.streamCount,
					})),
					phoneConnections: registry.activeCount(),
					remoteTransport: { state: "ready" },
					workspaces: workspaceRegistered ? [{ name: WORKSPACE.name, path: workspaceDir }] : [],
					clients: [],
					keepAwake: { enabled: false, state: "disabled" },
				});
				return;
			case "lease_acquire": {
				const outcome = await broker.acquireForTui({
					connectionId: connection.connectionId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					force: request.force,
				});
				connection.send(
					outcome.kind === "granted"
						? {
								type: "lease_granted",
								id: request.id,
								workspaceName: request.workspaceName,
								sessionId: request.sessionId,
								handoff: outcome.handoff,
							}
						: {
								type: "lease_denied",
								id: request.id,
								reason: outcome.kind === "denied" ? outcome.reason : "draining_elsewhere",
							},
				);
				return;
			}
			case "lease_release": {
				const released = broker.releaseFromTui(
					connection.connectionId,
					request.workspaceName,
					request.sessionId,
					request.reason,
				);
				connection.send(
					released.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: released.code, message: "lease not held" },
				);
				return;
			}
			case "relay_rpc": {
				const authorized = registry.authorizeRpc(request.relayId, connection.connectionId, {
					clientNodeId: request.clientNodeId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
				});
				if (!authorized.ok) {
					connection.send({
						type: "error",
						id: request.id,
						code: authorized.code,
						message: authorized.message,
					});
					return;
				}
				if (request.command.type !== "unregister_workspace") {
					connection.send({ type: "error", id: request.id, code: "unsupported", message: request.command.type });
					return;
				}
				workspaceRegistered = false;
				connection.send({
					type: "relay_rpc_result",
					id: request.id,
					response: {
						type: "response",
						id: request.command.id,
						command: "unregister_workspace",
						success: true,
						data: { removedWorkspace: WORKSPACE.name, workspaceNames: [], workspaces: [] },
					},
					workspaceMetadata: { workspaceNames: [], workspaces: [] },
				});
				return;
			}
			default:
				connection.send({ type: "error", id: request.id, code: "unsupported", message: request.type });
		}
	};
	server = await startControlServer({
		socketPath: paths.socketPath,
		version: "0.0.0-test",
		authToken,
		handlers: {
			onRequest: handleRequest,
			onConnectionClosed: (connection) => broker.releaseAllForConnection(connection.connectionId),
			relayAdmission: {
				admitRelay: (hello, socket, bufferedRemainder) =>
					registry.admit(hello.relayId, hello.relayToken, socket, bufferedRemainder),
			},
		},
	});
	writeFileSync(
		paths.pidfilePath,
		`${JSON.stringify({
			pid: process.pid,
			version: "0.0.0-test",
			startedAtMs: Date.now(),
			socketPath: paths.socketPath,
			token: authToken,
		})}\n`,
		{ mode: 0o600 },
	);
	const attach = createDaemonAttach({ cwd: workspaceDir, agentDir, autoStart: false });
	await attach.start();
	expect(await attach.acquire(SESSION_ID)).toMatchObject({ kind: "granted" });
	cleanups.push(async () => {
		await attach.dispose();
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});
	return { agentDir, workspaceDir, registry, broker, server, attach };
}

/** Daemon side of one phone attach: the phone stream paused behind a minted relay offer. */
function mintPhoneRelay(registry: RelayRegistry, clientNodeId: string, streamId: string) {
	const phone = new FakePhoneIrohStream();
	const settle = vi.fn();
	const relay = registry.mint({
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		ownerControlConnectionId: "control-tui",
		connectionId: `conn-${clientNodeId}`,
		streamId,
		stream: phone,
		preamble: {
			handshake: { hello: createPhoneHello(SESSION_ID), response: HANDSHAKE_RESPONSE },
			authorization: {
				clientNodeId,
				workspaceName: WORKSPACE.name,
				workspacePath: WORKSPACE.path,
				...createRelayWorkspaceMetadata(),
				allowedTools: "",
				rpcGrant: RPC_GRANT,
			},
			hostNodeId: "n-daemon-host",
			relayMode: "development",
			connectionId: `conn-${clientNodeId}`,
			streamId,
			resolvedTarget: {
				sessionId: SESSION_ID,
				selection: "resumed",
				requestedSessionId: SESSION_ID,
				workspaceName: WORKSPACE.name,
				workspacePath: WORKSPACE.path,
			},
		},
		rejectPending: () => {},
		onSettled: settle,
	});
	return { phone, relay, settle };
}

function mintOwnedPhoneRelay(harness: OwnedRelayDaemonHarness, clientNodeId: string, streamId: string) {
	const record = harness.broker.lookup(WORKSPACE.name, SESSION_ID);
	const ownerControlConnectionId = record?.tuiConnectionId;
	if (!ownerControlConnectionId) {
		throw new Error("TUI lease has no control owner");
	}
	const phone = new FakePhoneIrohStream();
	let framesAtSettlement: Array<Record<string, unknown>> = [];
	const settle = vi.fn((outcome: RelayOutcome) => {
		framesAtSettlement = phone.receivedFrames();
		harness.broker.unregisterRelay(WORKSPACE.name, SESSION_ID, relay.relayId);
		harness.server.sendTo(ownerControlConnectionId, {
			type: "relay_closed",
			relayId: relay.relayId,
			reason: outcome.reason,
		});
	});
	const relay = harness.registry.mint({
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		ownerControlConnectionId,
		connectionId: `conn-${clientNodeId}`,
		streamId,
		stream: phone,
		preamble: {
			handshake: { hello: createPhoneHello(SESSION_ID), response: HANDSHAKE_RESPONSE },
			authorization: {
				clientNodeId,
				workspaceName: WORKSPACE.name,
				workspacePath: harness.workspaceDir,
				...createRelayWorkspaceMetadata(),
				allowedTools: "",
				rpcGrant: RPC_GRANT,
			},
			hostNodeId: "n-daemon-host",
			relayMode: "development",
			connectionId: `conn-${clientNodeId}`,
			streamId,
			resolvedTarget: {
				sessionId: SESSION_ID,
				selection: "resumed",
				requestedSessionId: SESSION_ID,
				workspaceName: WORKSPACE.name,
				workspacePath: harness.workspaceDir,
			},
		},
		rejectPending: () => {},
		onSettled: settle,
	});
	if (!harness.broker.registerRelay(WORKSPACE.name, SESSION_ID, relay.relayId)) {
		throw new Error("TUI lease rejected relay registration");
	}
	harness.server.sendTo(ownerControlConnectionId, {
		type: "relay_offer",
		relayId: relay.relayId,
		relayToken: relay.relayToken,
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		connectionId: relay.connectionId,
		streamId,
	});
	return { phone, relay, settle, framesAtSettlement: () => framesAtSettlement };
}

/**
 * TUI side of one relay offer, mirroring InteractiveMode.serveRelayConversation:
 * redeem the token, adapt the socket, write the handshake response, then serve
 * the stream from the shared in-process runtime via runIrohRemoteRpcMode.
 */
async function serveRelayFromTui(
	client: DaemonClient,
	relay: RelayLifecycleOwner,
	runtimeHost: AgentSessionRuntime,
	tuiSessionId: string,
) {
	const opened = await client.openRelay({ relayId: relay.relayId, relayToken: relay.relayToken });
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	const handshake = opened.preamble.handshake as { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess };
	const authorizationSubset = opened.preamble.authorization;
	const authorization = createTuiRelayAuthorization(authorizationSubset);
	// The phone verifies the saved host node id in the relayed handshake
	// response, so the TUI must echo the daemon's identity from the preamble.
	const responseContext = { hostNodeId: opened.preamble.hostNodeId, relayMode: opened.preamble.relayMode };
	const resolvedTarget = opened.preamble.resolvedTarget;
	const sessionSelection: IntegratedConversationSessionSelection =
		resolvedTarget.selection === "created"
			? { kind: "created", sessionId: resolvedTarget.sessionId }
			: {
					kind: resolvedTarget.selection,
					requestedSessionId: resolvedTarget.requestedSessionId ?? resolvedTarget.sessionId,
					sessionId: resolvedTarget.sessionId,
				};

	const handshakeResponse = createIntegratedConversationHandshakeResponse(
		{ hello: handshake.hello, response: handshake.response },
		authorization,
		tuiSessionId,
		sessionSelection,
		responseContext,
	);
	await writeIrohRemoteHandshakeResponse(relayedStream.send, handshakeResponse);
	const conversationOptions = createTestIrohConversationOptions(runtimeHost);

	const done = runIrohRemoteRpcMode(runtimeHost, {
		...conversationOptions,
		stream: relayedStream,
		disposeRuntimeOnClose: false,
		workspaceName: WORKSPACE.name,
		workspacePath: WORKSPACE.path,
		rpcGrant: authorizationSubset.rpcGrant,
		suppressExtensionUiRequests: true,
		decorateOutbound: (value) => decorateRemoteHostState(value, authorization, responseContext),
		remoteCommandHandler: (command) =>
			handleIntegratedConversationRpcCommand(
				command as { type: string } & Record<string, unknown>,
				authorization,
				{
					stateManager: new IrohRemoteHostStateManager(),
					sessionListCursors: new Map(),
					sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
				},
				runtimeHost,
			),
	}).finally(() => {
		relayedStream.close();
	});
	return { relayedStream, done };
}

async function serveOwnedRelayFromTui(
	daemonAttach: DaemonAttach,
	offer: DaemonRelayOffer,
	openRelay: () => Promise<OpenedRelay>,
	runtimeHost: AgentSessionRuntime,
): Promise<void> {
	const opened = await openRelay();
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	const handshake = opened.preamble.handshake as { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess };
	const authorizationSubset = opened.preamble.authorization;
	const authorization = createTuiRelayAuthorization(authorizationSubset);
	const responseContext = { hostNodeId: opened.preamble.hostNodeId, relayMode: opened.preamble.relayMode };
	const resolvedTarget = opened.preamble.resolvedTarget;
	const sessionSelection: IntegratedConversationSessionSelection =
		resolvedTarget.selection === "created"
			? { kind: "created", sessionId: resolvedTarget.sessionId }
			: {
					kind: resolvedTarget.selection,
					requestedSessionId: resolvedTarget.requestedSessionId ?? resolvedTarget.sessionId,
					sessionId: resolvedTarget.sessionId,
				};
	const handshakeResponse = createIntegratedConversationHandshakeResponse(
		{ hello: handshake.hello, response: handshake.response },
		authorization,
		SESSION_ID,
		sessionSelection,
		responseContext,
	);
	await writeIrohRemoteHandshakeResponse(relayedStream.send, handshakeResponse);
	const conversationOptions = createTestIrohConversationOptions(runtimeHost);
	let relayedSessionId = offer.sessionId;
	const retirement = createRelayWorkspaceUnregisterRetirement(daemonAttach, () => relayedSessionId);
	try {
		await runIrohRemoteRpcMode(runtimeHost, {
			...conversationOptions,
			stream: relayedStream,
			disposeRuntimeOnClose: false,
			workspaceName: WORKSPACE.name,
			workspacePath: authorizationSubset.workspacePath,
			rpcGrant: authorizationSubset.rpcGrant,
			isRpcIngressOpen: retirement.isIngressOpen,
			suppressExtensionUiRequests: true,
			decorateOutbound: (value) => decorateRemoteHostState(value, authorization, responseContext),
			onResponseWritten: retirement.onResponseWritten,
			remoteCommandHandler: async (command) => {
				if (command.type === "unregister_workspace") {
					const forwarded = await daemonAttach.forwardRelayRpc(
						authorizationSubset.clientNodeId,
						relayedSessionId,
						command as { type: string } & Record<string, unknown>,
					);
					if (!forwarded) {
						return undefined;
					}
					retirement.observeForwardedResponse(command, forwarded.response);
					if (forwarded.workspaceMetadata) {
						authorization.workspaceNames = [...forwarded.workspaceMetadata.workspaceNames];
						authorization.workspaces = forwarded.workspaceMetadata.workspaces.map((workspace) => ({
							...workspace,
						}));
					}
					return forwarded.response;
				}
				return handleIntegratedConversationRpcCommand(
					command as { type: string } & Record<string, unknown>,
					authorization,
					{
						stateManager: new IrohRemoteHostStateManager(),
						sessionListCursors: new Map(),
						sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
					},
					runtimeHost,
				);
			},
			onSessionChanged: (session) => {
				relayedSessionId = session.sessionId;
			},
		});
	} finally {
		await retirement.finalize();
		relayedStream.close();
		opened.finished();
	}
}

describe("dual-frontend relayed conversation (§12.3.3)", () => {
	it("falls back to one reasoned release when unregister response delivery never completes", async () => {
		const release = vi.fn(async () => {});
		const retirement = createRelayWorkspaceUnregisterRetirement({ release }, () => SESSION_ID);
		retirement.observeForwardedResponse(
			{ type: "unregister_workspace" },
			{ type: "response", command: "unregister_workspace", success: true },
		);
		expect(retirement.isIngressOpen()).toBe(false);
		expect(release).not.toHaveBeenCalled();

		await retirement.finalize();
		await retirement.finalize();
		expect(release).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledWith(SESSION_ID, "workspace_unregistered");
	});

	it("serves two co-attached phones from one TUI runtime: prompts land, events fan out, abort keeps both relays open", async () => {
		const { socketPath, registry } = await startDaemonHarness();
		const fanout = createFanoutSession(SESSION_ID);
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			...createStableSessionRunner(() => fanout.session),
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: false,
		});
		cleanups.push(() => client.close());

		// Two phones with distinct clientNodeIds attach concurrently; the daemon
		// mints one relay offer each and the TUI redeems and serves both.
		const attachA = mintPhoneRelay(registry, "n-phone-a", "st-1");
		const attachB = mintPhoneRelay(registry, "n-phone-b", "st-2");
		const [servedA, servedB] = await Promise.all([
			serveRelayFromTui(client, attachA.relay, runtimeHost, SESSION_ID),
			serveRelayFromTui(client, attachB.relay, runtimeHost, SESSION_ID),
		]);
		expect(registry.activeCount()).toBe(2);

		// Both phones receive the TUI-written handshake success over the relay.
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				const frames = attach.phone.receivedFrames();
				const first = frames[0];
				expect(first?.success).toBe(true);
				expect(first?.sessionId).toBe(SESSION_ID);
				// Saved-host identity verification: the relayed handshake response
				// must prove the daemon's node id, not the TUI's absence of one.
				expect(first?.hostNodeId).toBe("n-daemon-host");
				expect(first).toMatchObject({
					remoteHost: {
						workspaceNames: RELAY_WORKSPACE_NAMES,
						workspaces: RELAY_WORKSPACES,
					},
				});
				expect(frames[1]).toMatchObject({
					type: "conversation_bootstrap",
					delivery: { cursor: 0 },
					conversation: { sessionId: SESSION_ID },
					reason: "bootstrap",
				});
			}
		});

		// The TUI keeps using the preamble catalog before any command is forwarded
		// to daemon-owned state.
		attachA.phone.sendLine({ id: "initial-state", type: "get_state" });
		await vi.waitFor(() => {
			const stateResponse = attachA.phone
				.receivedFrames()
				.find((frame) => frame.id === "initial-state" && frame.command === "get_state");
			expect(stateResponse).toMatchObject({
				success: true,
				data: {
					remoteHost: {
						workspaceNames: RELAY_WORKSPACE_NAMES,
						workspaces: RELAY_WORKSPACES,
					},
				},
			});
		});

		// Phone A prompts; the TUI's in-process runtime receives it.
		attachA.phone.sendLine({
			id: "p1",
			type: "prompt",
			clientMessageId: "client-message-p1",
			message: "hello from phone a",
			conversationAuthority: getPhoneConversationAuthority(attachA.phone),
		});
		await vi.waitFor(() => {
			expect(fanout.session.prompt).toHaveBeenCalledWith("hello from phone a", expect.anything());
			const responses = attachA.phone.receivedFrames().filter((frame) => frame.command === "prompt");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});

		// A streamed turn (including the user entry for the phone prompt) fans
		// out to BOTH phones through their relays.
		fanout.emit({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hello from phone a" }] },
		} as unknown as AgentSessionEvent);
		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				const frames = attach.phone.receivedFrames();
				const userEntry = frames.find((frame) => frame.type === "message_start");
				expect((userEntry?.message as Record<string, unknown> | undefined)?.role).toBe("user");
				expect(frames.some((frame) => frame.type === "agent_start")).toBe(true);
			}
		});

		// A committed action-state transition uses the same ordered conversation
		// feed and reaches every co-attached phone with per-subscriber cursors.
		fanout.emit({
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
		} as unknown as AgentSessionEvent);
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				const actionEvent = attach.phone.receivedFrames().find((frame) => frame.type === "ui_action_state_changed");
				expect(actionEvent).toMatchObject({
					type: "ui_action_state_changed",
					action: "thinking.fast_mode",
					state: { type: "boolean", value: true, label: "Fast mode enabled" },
					delivery: { subscriptionId: expect.any(String), cursor: expect.any(Number) },
				});
			}
		});

		// Abort from phone B stops the turn; both relays and streams stay open.
		attachB.phone.sendLine({
			id: "a1",
			type: "abort",
			conversationAuthority: getPhoneConversationAuthority(attachB.phone),
		});
		await vi.waitFor(() => {
			const responses = attachB.phone.receivedFrames().filter((frame) => frame.command === "abort");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});
		expect(fanout.abort).toHaveBeenCalled();
		expect(registry.activeCount()).toBe(2);
		expect(attachA.phone.finished).toBe(false);
		expect(attachB.phone.finished).toBe(false);
		expect(attachA.settle).not.toHaveBeenCalled();
		expect(attachB.settle).not.toHaveBeenCalled();

		// Both phones keep receiving events after the abort.
		fanout.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				expect(attach.phone.receivedFrames().some((frame) => frame.type === "agent_end")).toBe(true);
			}
		});
		expect(dispose).not.toHaveBeenCalled();

		// Phone A hangs up: its relay settles phone_disconnected and its serving
		// loop ends, while phone B stays attached and live.
		attachA.phone.end();
		await servedA.done;
		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(registry.activeCount()).toBe(1);
		});
		expect(attachA.settle.mock.calls[0]?.[0]?.reason).toBe("phone_disconnected");

		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			const frames = attachB.phone.receivedFrames().filter((frame) => frame.type === "agent_start");
			expect(frames.length).toBeGreaterThanOrEqual(2);
		});
		expect(attachB.settle).not.toHaveBeenCalled();

		attachB.phone.end();
		await servedB.done;
		await vi.waitFor(() => expect(registry.activeCount()).toBe(0));
		expect(dispose).not.toHaveBeenCalled();
	});

	it("delivers relay unregister before retiring every relay, lease record, and local relay tracker", async () => {
		const harness = await startOwnedRelayDaemonHarness();
		const fanout = createFanoutSession(SESSION_ID);
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			...createStableSessionRunner(() => fanout.session),
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const relayServers: Promise<void>[] = [];
		harness.attach.onRelayOffer((offer, openRelay) => {
			relayServers.push(serveOwnedRelayFromTui(harness.attach, offer, openRelay, runtimeHost));
		});

		const attachA = mintOwnedPhoneRelay(harness, "n-phone-a", "st-unregister-1");
		const attachB = mintOwnedPhoneRelay(harness, "n-phone-b", "st-unregister-2");
		await vi.waitFor(() => {
			expect(harness.attach.relayCount()).toBe(2);
			expect(harness.registry.activeCount()).toBe(2);
			expect(relayServers).toHaveLength(2);
			for (const attach of [attachA, attachB]) {
				expect(attach.phone.receivedFrames().some((frame) => frame.type === "conversation_bootstrap")).toBe(true);
			}
		});

		attachA.phone.sendLine({
			id: "remove-relayed-workspace",
			type: "unregister_workspace",
			workspaceName: WORKSPACE.name,
		});
		attachA.phone.sendLine({ id: "pipelined-after-unregister", type: "get_state" });

		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(attachB.settle).toHaveBeenCalledTimes(1);
			expect(harness.registry.activeCount()).toBe(0);
			expect(harness.attach.relayCount()).toBe(0);
		});
		await Promise.all(relayServers);

		const unregisterResponse = attachA.phone
			.receivedFrames()
			.find((frame) => frame.command === "unregister_workspace");
		expect(unregisterResponse).toMatchObject({
			id: "remove-relayed-workspace",
			type: "response",
			command: "unregister_workspace",
			success: true,
			data: { removedWorkspace: WORKSPACE.name, workspaceNames: [], workspaces: [] },
		});
		expect(
			attachA
				.framesAtSettlement()
				.some((frame) => frame.command === "unregister_workspace" && frame.success === true),
		).toBe(true);
		expect(attachA.phone.receivedFrames().some((frame) => frame.id === "pipelined-after-unregister")).toBe(false);
		expect(attachA.settle.mock.calls[0]?.[0]?.reason).toBe("workspace_unregistered");
		expect(attachB.settle.mock.calls[0]?.[0]?.reason).toBe("workspace_unregistered");
		expect(harness.broker.lookup(WORKSPACE.name, SESSION_ID)).toBeUndefined();
		expect(await harness.attach.listRuntimeStates(WORKSPACE.name)).toEqual(new Map());
		expect(dispose).not.toHaveBeenCalled();
	}, 20_000);
});
