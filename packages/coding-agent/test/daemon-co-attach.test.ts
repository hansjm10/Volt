import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type {
	AgentSessionReplacementTarget,
	AgentSessionReplacementTransaction,
	AgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteLiveActivityRegistration,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import {
	ConversationCoordinatorRegistry,
	type ConversationCoordinatorRekeyReservation,
} from "../src/daemon/conversation-coordinator.ts";
import { type IntegratedRuntimeEntry, IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import {
	collectClientAuthorityInvalidationRuntimes,
	collectClientAuthorityInvalidationStreams,
} from "../src/daemon/iroh-service.ts";
import { type DaemonRuntimeOwnerCapability, LeaseBroker } from "../src/daemon/lease-broker.ts";
import {
	createTestSession,
	parseWrittenObjects,
	startIrohRpcMode,
	withCurrentConversationAuthority,
} from "./iroh-stream-doubles.ts";

let fixtureRoot: string;
let workspacePath: string;
let agentDir: string;

function createConversationAuthorityEffects(coordinators: ConversationCoordinatorRegistry) {
	const rekeys = new Map<string, ConversationCoordinatorRekeyReservation>();
	return {
		beginTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.getOrCreate(workspaceName, sessionId).beginTuiLeaseHandoff(connectionId);
		},
		commitTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			const coordinator = coordinators.get(workspaceName, sessionId);
			if (!coordinator) throw new Error("missing test conversation coordinator");
			coordinator.commitTuiLeaseHandoff(connectionId);
		},
		cancelTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.get(workspaceName, sessionId)?.cancelTuiLeaseHandoff(connectionId);
		},
		releaseTuiLease: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.get(workspaceName, sessionId)?.releaseTuiLease(connectionId);
		},
		prepareTuiLeaseRekey: (
			transactionId: string,
			workspaceName: string,
			oldSessionId: string,
			newSessionId: string,
			connectionId: string,
		) => {
			const coordinator = coordinators.get(workspaceName, oldSessionId);
			if (!coordinator || coordinator.tuiLeaseConnectionId !== connectionId) {
				throw new Error("missing test TUI lease authority");
			}
			rekeys.set(transactionId, coordinators.prepareRekey(coordinator, newSessionId));
		},
		commitTuiLeaseRekey: (transactionId: string) => {
			const reservation = rekeys.get(transactionId);
			if (!reservation) throw new Error("missing test coordinator rekey reservation");
			coordinators.commitRekey(reservation);
			rekeys.delete(transactionId);
		},
		rollbackTuiLeaseRekey: (transactionId: string) => {
			const reservation = rekeys.get(transactionId);
			if (!reservation) return;
			coordinators.rollbackRekey(reservation);
			rekeys.delete(transactionId);
		},
	};
}

beforeAll(async () => {
	fixtureRoot = await mkdtemp(join(tmpdir(), "volt-daemon-co-attach-"));
	workspacePath = fixtureRoot;
	agentDir = join(fixtureRoot, "agent");
});

afterAll(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

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
		session: Object.assign(session, { abort }),
		abort,
		emit(event: AgentSessionEvent) {
			for (const handler of Array.from(subscribers)) {
				handler(event);
			}
		},
	};
}

function createAuthorization(clientNodeId: string, allowTools = "read"): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools,
		client: {
			nodeId: clientNodeId,
			label: clientNodeId,
			allowedWorkspaces: ["ws"],
			allowedTools: allowTools,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

function createHello(
	target: IrohRemoteHello["mode"] extends never ? never : { target: "new" } | { target: "session"; sessionId: string },
): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation: target,
	} as IrohRemoteHello;
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

function installTestLeaseOwner(entry: IntegratedRuntimeEntry, id: string): DaemonRuntimeOwnerCapability {
	const owner = { id };
	entry.coordinator.installLeaseOwner(owner);
	return owner;
}

describe("daemon co-attach (one runtime per conversation)", () => {
	it("two phones with distinct clientNodeIds share one runtime, both stream, and abort keeps streams open", async () => {
		const fanout = createFanoutSession("s-co");
		const dispose = vi.fn(async () => {});
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const runtimeHost = {
			cwd: workspacePath,
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			runSessionInterruption: <T>(operation: (session: AgentSessionRuntime["session"]) => T): T =>
				operation(fanout.session as unknown as AgentSessionRuntime["session"]),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime: runtimeHost,
				sessionSelection: { kind: "created", sessionId: "s-co" },
			}),
		});

		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");

		// Phone A creates the runtime.
		const first = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		expect(first.created).toBe(true);
		await expect(
			registry.commitEntry(first.entry, first.sessionSelection, phoneB, first.attachClaim),
		).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		expect(first.entry.lifecycle).toBe("prepared");
		await registry.commitEntry(first.entry, first.sessionSelection, phoneA, first.attachClaim);

		// Phone B (different clientNodeId) attaches to the SAME runtime — no
		// conversation_in_use rejection.
		const second = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-co" }), response: HANDSHAKE_RESPONSE },
			phoneB,
		);
		expect(second.created).toBe(false);
		expect(second.entry).toBe(first.entry);
		expect(second.sessionSelection).toEqual({
			kind: "resumed",
			requestedSessionId: "s-co",
			sessionId: "s-co",
		});
		await registry.commitEntry(second.entry, second.sessionSelection, phoneB, second.attachClaim);

		const subscriberA = await registry.attachSubscriber(first.entry, first.attachClaim);
		const subscriberB = await registry.attachSubscriber(first.entry, second.attachClaim);
		first.attachClaim.release();
		second.attachClaim.release();
		expect(first.entry.subscribers.size).toBe(2);
		expect([subscriberA.clientNodeId, subscriberB.clientNodeId]).toEqual(["n-phone-a", "n-phone-b"]);
		expect(
			auditEvents.filter((event) => event.type === "remote_subscriber_attached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-a", "n-phone-b"]);

		// Serve both phones from the same runtime.
		const modeA = await startIrohRpcMode(runtimeHost, fanout.session);
		fanout.session.bindExtensions.mockClear();
		const modeB = await startIrohRpcMode(runtimeHost, fanout.session);

		// A session event fans out to both streams.
		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send).some((frame) => frame.type === "agent_start")).toBe(true);
			expect(parseWrittenObjects(modeB.send).some((frame) => frame.type === "agent_start")).toBe(true);
		});

		// Abort from phone B stops the turn; BOTH streams stay open and the
		// runtime stays live (no dispose, no stream invalidation).
		modeB.recv.pushLine(JSON.stringify(withCurrentConversationAuthority(modeB.send, { id: "a1", type: "abort" })));
		await vi.waitFor(() => {
			const responses = parseWrittenObjects(modeB.send).filter((frame) => frame.command === "abort");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});
		expect(fanout.abort).toHaveBeenCalled();
		expect(modeA.send.finished).toBe(false);
		expect(modeB.send.finished).toBe(false);
		expect(dispose).not.toHaveBeenCalled();

		// Both streams still receive events after the abort.
		fanout.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send).some((frame) => frame.type === "agent_end")).toBe(true);
			expect(parseWrittenObjects(modeB.send).some((frame) => frame.type === "agent_end")).toBe(true);
		});

		modeA.recv.end();
		modeB.recv.end();
		await modeA.modePromise;
		await modeB.modePromise;
		expect(dispose).not.toHaveBeenCalled();

		await registry.detachSubscriber(first.entry, subscriberB, "phone_b_closed");
		await registry.detachSubscriber(first.entry, subscriberA, "phone_a_closed");
		expect(
			auditEvents.filter((event) => event.type === "remote_subscriber_detached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-b", "n-phone-a"]);
		expect(
			auditEvents.filter((event) => event.type === "remote_runtime_detached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-a"]);
		await registry.stopAll("test_cleanup");
	});

	it("attributes a co-attaching client's pre-subscriber detach to that client", async () => {
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("s-pre-subscriber", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-pre-subscriber" },
			}),
		});
		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");

		const creatorAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(
			creatorAttach.entry,
			creatorAttach.sessionSelection,
			phoneA,
			creatorAttach.attachClaim,
		);
		const coattach = await registry.getOrCreateEntry(
			{
				hello: createHello({ target: "session", sessionId: "s-pre-subscriber" }),
				response: HANDSHAKE_RESPONSE,
			},
			phoneB,
		);
		await registry.commitEntry(coattach.entry, coattach.sessionSelection, phoneB, coattach.attachClaim);
		expect(creatorAttach.entry.subscribers.size).toBe(0);
		expect(creatorAttach.entry.detachedAt).toBeUndefined();

		await registry.detachWithoutSubscriber(creatorAttach.entry, coattach.attachClaim, "phone_b_attach_failed");

		expect(auditEvents.filter((event) => event.type === "remote_runtime_detached")).toEqual([
			expect.objectContaining({
				clientNodeId: "n-phone-b",
				details: expect.objectContaining({ reason: "phone_b_attach_failed" }),
			}),
		]);
		creatorAttach.attachClaim.release();
		coattach.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("cancels provisional attach without waiting for runtime creation and disposes a late result", async () => {
		const abortController = new AbortController();
		const dispose = vi.fn(async () => {});
		const lateRuntime = {
			cwd: workspacePath,
			session: createTestSession("late-runtime", null),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		type RuntimeResult = {
			runtime: AgentSessionRuntime;
			sessionSelection: { kind: "created"; sessionId: string };
		};
		let resolveRuntime = (_result: RuntimeResult): void => {};
		const createRuntime = vi.fn(
			() =>
				new Promise<RuntimeResult>((resolve) => {
					resolveRuntime = resolve;
				}),
		);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime,
		});
		const authorization = createAuthorization("n-cancelled-attach");
		const pending = registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			authorization,
			{ signal: abortController.signal },
		);
		await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

		abortController.abort();
		await expect(pending).rejects.toThrow("Conversation attach cancelled because daemon admission closed");
		expect(registry.size).toBe(0);
		expect(dispose).not.toHaveBeenCalled();

		resolveRuntime({
			runtime: lateRuntime,
			sessionSelection: { kind: "created", sessionId: "late-runtime" },
		});
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		expect(registry.size).toBe(0);
		expect(registry.findOwner("ws", "late-runtime")).toBeUndefined();
	});

	it("starts recovered input only on the committed winner after subscriber admission", async () => {
		const sessionId = "recovery-race";
		const starts = [vi.fn(async () => {}), vi.fn(async () => {})];
		const disposes = [vi.fn(async () => {}), vi.fn(async () => {})];
		const runtimes = starts.map(
			(startRecoveredClientInputs, index) =>
				({
					cwd: workspacePath,
					session: createTestSession(sessionId, null),
					dispose: disposes[index],
					startRecoveredClientInputs,
					setRebindSession: vi.fn(),
					listSessions: vi.fn(async () => []),
				}) as unknown as AgentSessionRuntime,
		);
		let runtimeCalls = 0;
		let releaseFactoryBarrier = (): void => {};
		const factoryBarrier = new Promise<void>((resolve) => {
			releaseFactoryBarrier = resolve;
		});
		const createRuntime = vi.fn(async () => {
			const runtime = runtimes[runtimeCalls++]!;
			if (runtimeCalls === runtimes.length) releaseFactoryBarrier();
			await factoryBarrier;
			return {
				runtime,
				sessionSelection: { kind: "resumed" as const, requestedSessionId: sessionId, sessionId },
			};
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime,
		});
		const authorization = createAuthorization("n-recovery-race");
		const open = () =>
			registry.getOrCreateEntry(
				{ hello: createHello({ target: "session", sessionId }), response: HANDSHAKE_RESPONSE },
				authorization,
			);
		const results = await Promise.allSettled([open(), open()]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof open>>> => result.status === "fulfilled",
		);
		expect(fulfilled).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = fulfilled[0]!.value;
		const winnerIndex = runtimes.indexOf(winner.entry.runtime);
		const loserIndex = winnerIndex === 0 ? 1 : 0;
		expect(starts[0]).not.toHaveBeenCalled();
		expect(starts[1]).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(disposes[loserIndex]).toHaveBeenCalledOnce());

		await registry.commitEntry(winner.entry, winner.sessionSelection, authorization, winner.attachClaim);
		expect(() =>
			registry.startRecoveredClientInputs(winner.entry, winner.attachClaim, {
				id: "not-admitted",
				clientNodeId: authorization.client.nodeId,
				attachedAt: Date.now(),
			}),
		).toThrow(/subscriber is not owned/);
		const subscriber = await registry.attachSubscriber(winner.entry, winner.attachClaim);
		await registry.startRecoveredClientInputs(winner.entry, winner.attachClaim, subscriber);
		expect(starts[winnerIndex]).toHaveBeenCalledOnce();
		expect(starts[loserIndex]).not.toHaveBeenCalled();
		await registry.detachSubscriber(winner.entry, subscriber, "test_cleanup");
		winner.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("never starts recovered input for an attach cancelled before ownership commit", async () => {
		const startRecoveredClientInputs = vi.fn(async () => {});
		const dispose = vi.fn(async () => {});
		const sessionId = "recovery-cancelled";
		const runtime = {
			cwd: workspacePath,
			session: createTestSession(sessionId, null),
			dispose,
			startRecoveredClientInputs,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "resumed", requestedSessionId: sessionId, sessionId },
			}),
		});
		const authorization = createAuthorization("n-recovery-cancelled");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId }), response: HANDSHAKE_RESPONSE },
			authorization,
		);

		await registry.abortPreparedEntry(prepared.entry, prepared.sessionSelection, prepared.attachClaim);
		expect(startRecoveredClientInputs).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
		expect(() =>
			registry.startRecoveredClientInputs(prepared.entry, prepared.attachClaim, {
				id: "never-admitted",
				clientNodeId: authorization.client.nodeId,
				attachedAt: Date.now(),
			}),
		).toThrow(/stale|ownership changed/);
	});

	it("cannot publish a prepared runtime after attach admission closes during persistence", async () => {
		const abortController = new AbortController();
		let resolvePersistence = (): void => {};
		const persistence = new Promise<void>((resolve) => {
			resolvePersistence = resolve;
		});
		const setClientLastSessionId = vi.fn(async () => {
			await persistence;
			return undefined;
		});
		const dispose = vi.fn(async () => {});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("cancelled-commit", null),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "cancelled-commit" },
			}),
		});
		const authorization = createAuthorization("n-cancelled-commit");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			authorization,
			{ signal: abortController.signal },
		);
		const committing = registry.commitEntry(
			created.entry,
			created.sessionSelection,
			authorization,
			created.attachClaim,
			abortController.signal,
		);
		await vi.waitFor(() => expect(setClientLastSessionId).toHaveBeenCalledOnce());
		expect(registry.size).toBe(1);
		expect(created.entry.lifecycle).toBe("prepared");

		abortController.abort();
		await expect(committing).rejects.toThrow("Conversation attach cancelled because daemon admission closed");
		expect(registry.size).toBe(0);
		expect(created.entry.lifecycle).toBe("prepared");

		await registry.abortPreparedEntry(created.entry, created.sessionSelection, created.attachClaim);
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.lifecycle).toBe("retired");

		resolvePersistence();
		await Promise.resolve();
		expect(registry.size).toBe(0);
		expect(registry.findOwner("ws", "cancelled-commit")).toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("rejects co-attach when an existing runtime exceeds the attaching client's grant", async () => {
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("s-policy", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-policy" },
			}),
		});
		const broadPhone = createAuthorization("n-phone-broad", "read,bash");
		const narrowPhone = createAuthorization("n-phone-narrow", "read");
		const equallyBroadPhone = createAuthorization("n-phone-equal", "read,bash,edit");

		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			broadPhone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, broadPhone, created.attachClaim);
		created.attachClaim.release();

		await expect(
			registry.getOrCreateEntry(
				{ hello: createHello({ target: "session", sessionId: "s-policy" }), response: HANDSHAKE_RESPONSE },
				narrowPhone,
			),
		).rejects.toMatchObject({ outcome: "conversation_in_use" });

		const attached = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-policy" }), response: HANDSHAKE_RESPONSE },
			equallyBroadPhone,
		);
		expect(attached.created).toBe(false);
		expect(attached.entry).toBe(created.entry);
		attached.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("rekeys once and persists the reconnect target for every co-attached client", async () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const setClientLastSessionId = vi.fn(async () => ({}) as never);
		const onRuntimeRekeyed = vi.fn();
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("shared-old", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			onRuntimeRekeyed,
			onRuntimeDisposed: (entry) => {
				entry.coordinator.clearLeaseOwner();
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "shared-old" },
			}),
		});
		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phoneA, created.attachClaim);
		installTestLeaseOwner(created.entry, "shared-owner");
		created.attachClaim.release();
		setClientLastSessionId.mockClear();
		const streamA = {
			clientNodeId: "n-phone-a",
			workspaceName: "ws",
			sessionId: "shared-old",
			connectionId: "conn-a",
			streamId: "stream-a",
			close: vi.fn(),
		};
		const streamB = {
			clientNodeId: "n-phone-b",
			workspaceName: "ws",
			sessionId: "shared-old",
			connectionId: "conn-b",
			streamId: "stream-b",
			close: vi.fn(),
		};
		activeStreams.register(streamA);
		activeStreams.register(streamB);

		await registry.handleSessionChanged(created.entry, streamA, { sessionId: "shared-new" }, phoneA);
		expect(onRuntimeRekeyed).toHaveBeenCalledOnce();
		expect(streamA.sessionId).toBe("shared-new");
		expect(streamB.sessionId).toBe("shared-new");
		expect(setClientLastSessionId.mock.calls).toEqual(
			expect.arrayContaining([
				["n-phone-a", "ws", "shared-new"],
				["n-phone-b", "ws", "shared-new"],
			]),
		);
		expect(setClientLastSessionId).toHaveBeenCalledTimes(2);

		await registry.handleSessionChanged(created.entry, streamB, { sessionId: "shared-new" }, phoneB);
		expect(onRuntimeRekeyed).toHaveBeenCalledOnce();
		expect(setClientLastSessionId).toHaveBeenCalledTimes(2);
		activeStreams.unregister(streamA);
		activeStreams.unregister(streamB);
		await registry.stopAll("test_cleanup");
	});

	it("retires live activities for every client and every owned rekey identity", async () => {
		const oldSessionId = "activity-shared-old";
		const newSessionId = "activity-shared-new";
		const keepSessionId = "activity-unrelated";
		const registration = (sessionId: string, activityId: string): IrohRemoteLiveActivityRegistration => ({
			workspaceName: "ws",
			sessionId,
			activityId,
			tokenHash: "a".repeat(64),
			tokenEnvironment: "production",
			platform: "ios",
			pushTargetId: `target-${activityId}`,
			createdAt: 1,
			updatedAt: 2,
		});
		const phoneA = createAuthorization("n-activity-a");
		const phoneB = createAuthorization("n-activity-b");
		const untrackedPhone = createAuthorization("n-activity-untracked");
		const stateManager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [{ name: "ws", path: workspacePath }],
				clients: [
					{
						...phoneA.client,
						liveActivities: [registration(oldSessionId, "a-old"), registration(newSessionId, "a-new")],
					},
					{
						...phoneB.client,
						liveActivities: [
							registration(oldSessionId, "b-old"),
							registration(newSessionId, "b-new"),
							registration(keepSessionId, "b-keep"),
						],
					},
					{
						...untrackedPhone.client,
						liveActivities: [
							registration(oldSessionId, "untracked-old"),
							registration(keepSessionId, "untracked-keep"),
						],
					},
				],
			},
		});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession(oldSessionId, null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager,
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: stateManager.setClientLastSessionId.bind(stateManager),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: oldSessionId },
			}),
		});
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phoneA, created.attachClaim);
		const subscriberA = await registry.attachSubscriber(created.entry, created.attachClaim);
		const coattach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: oldSessionId }), response: HANDSHAKE_RESPONSE },
			phoneB,
		);
		await registry.commitEntry(coattach.entry, coattach.sessionSelection, phoneB, coattach.attachClaim);
		const subscriberB = await registry.attachSubscriber(coattach.entry, coattach.attachClaim);
		created.attachClaim.release();
		coattach.attachClaim.release();
		expect(created.entry.recordedSessionIdsByClient.has(phoneB.client.nodeId)).toBe(false);

		await registry.handleSessionChanged(created.entry, undefined, { sessionId: newSessionId }, phoneA);
		expect(created.entry.previousSessionIds.has(oldSessionId)).toBe(true);
		expect(created.entry.recordedSessionIdsByClient.has(phoneB.client.nodeId)).toBe(false);
		await registry.detachSubscriber(created.entry, subscriberB, "test_cleanup");
		await registry.detachSubscriber(created.entry, subscriberA, "test_cleanup");
		await registry.stopEntry(created.entry, "test_cleanup");

		const state = await stateManager.getState();
		const activitiesByClient = Object.fromEntries(
			state.clients.map((client) => [
				client.nodeId,
				(client.liveActivities ?? []).map((activity) => activity.sessionId),
			]),
		);
		expect(activitiesByClient).toEqual({
			"n-activity-a": [],
			"n-activity-b": [keepSessionId],
			"n-activity-untracked": [keepSessionId],
		});
	});

	it("preflights daemon-owned rekeys and bulk-commits every attached client", async () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const stateManager = new IrohRemoteHostStateManager();
		const setClientsLastSessionId = vi.spyOn(stateManager, "setClientsLastSessionId").mockResolvedValue([]);
		const leaseCommit = vi.fn();
		const leaseRollback = vi.fn();
		let prepareReplacement:
			| ((target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>)
			| undefined;
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("shared-old", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn((prepare) => {
				prepareReplacement = prepare;
			}),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager,
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			prepareRuntimeRekey: () => ({ commit: leaseCommit, rollback: leaseRollback }),
			onRuntimeDisposed: (entry) => {
				entry.coordinator.clearLeaseOwner();
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "shared-old" },
			}),
		});
		const phoneA = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phoneA, created.attachClaim);
		installTestLeaseOwner(created.entry, "preflight-owner");
		created.attachClaim.release();
		const streamA = {
			clientNodeId: "n-phone-a",
			workspaceName: "ws",
			sessionId: "shared-old",
			connectionId: "conn-a",
			streamId: "stream-a",
			close: vi.fn(),
		};
		const streamB = {
			clientNodeId: "n-phone-b",
			workspaceName: "ws",
			sessionId: "shared-old",
			connectionId: "conn-b",
			streamId: "stream-b",
			close: vi.fn(),
		};
		activeStreams.register(streamA);
		activeStreams.register(streamB);

		const transaction = await prepareReplacement?.({ previousSessionId: "shared-old", sessionId: "shared-new" });
		expect(transaction).toBeDefined();
		expect(created.entry.sessionId).toBe("shared-old");
		await transaction?.commit();

		expect(leaseCommit).toHaveBeenCalledOnce();
		expect(leaseRollback).not.toHaveBeenCalled();
		expect(setClientsLastSessionId).toHaveBeenCalledOnce();
		expect(setClientsLastSessionId).toHaveBeenCalledWith(
			expect.arrayContaining(["n-phone-a", "n-phone-b"]),
			"ws",
			"shared-new",
		);
		expect(created.entry.sessionId).toBe("shared-new");
		expect(streamA.sessionId).toBe("shared-new");
		expect(streamB.sessionId).toBe("shared-new");
		await expect(prepareReplacement?.({ previousSessionId: "shared-new", sessionId: "shared-next" })).rejects.toThrow(
			"daemon runtime session replacement already in progress",
		);

		await transaction?.finalize?.();
		const nextTransaction = await prepareReplacement?.({
			previousSessionId: "shared-new",
			sessionId: "shared-next",
		});
		expect(nextTransaction).toBeDefined();
		await nextTransaction?.rollback();
		expect(leaseRollback).toHaveBeenCalledOnce();
		activeStreams.unregister(streamA);
		activeStreams.unregister(streamB);
		await registry.stopAll("test_cleanup");
	});

	it("compensates persisted session ownership when stop fences a replacement commit await", async () => {
		let prepareReplacement:
			| ((target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>)
			| undefined;
		let releasePersistence!: () => void;
		let markPersistenceStarted!: () => void;
		const persistenceStarted = new Promise<void>((resolve) => {
			markPersistenceStarted = resolve;
		});
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		let releaseRetirement!: () => void;
		let markRetirementStarted!: () => void;
		const retirementStarted = new Promise<void>((resolve) => {
			markRetirementStarted = resolve;
		});
		const retirementGate = new Promise<void>((resolve) => {
			releaseRetirement = resolve;
		});
		const dispose = vi.fn(async () => {});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("persist-race-old", null),
			dispose,
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn((prepare) => {
				prepareReplacement = prepare;
			}),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const persistedSessionIds: string[] = [];
		const stateManager = new IrohRemoteHostStateManager();
		vi.spyOn(stateManager, "setClientsLastSessionId").mockImplementation(
			async (_clientIds, _workspace, sessionId) => {
				persistedSessionIds.push(sessionId);
				if (sessionId === "persist-race-new") {
					markPersistenceStarted();
					await persistenceGate;
				}
				return [];
			},
		);
		const leaseCommit = vi.fn();
		const leaseRollback = vi.fn();
		const onRuntimeDisposed = vi.fn((entry: IntegratedRuntimeEntry) => {
			entry.coordinator.clearLeaseOwner();
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager,
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			prepareRuntimeRekey: () => ({ commit: leaseCommit, rollback: leaseRollback }),
			beforeRuntimeStop: async () => {
				markRetirementStarted();
				await retirementGate;
			},
			onRuntimeDisposed,
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "persist-race-old" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		installTestLeaseOwner(created.entry, "persist-race-owner");
		created.attachClaim.release();
		const transaction = await prepareReplacement?.({
			previousSessionId: "persist-race-old",
			sessionId: "persist-race-new",
		});
		expect(transaction).toBeDefined();

		const committing = transaction!.commit();
		await persistenceStarted;
		const stopping = registry.stopEntry(created.entry, "host_shutdown");
		await retirementStarted;
		expect(created.entry.lifecycle).toBe("retiring");
		releasePersistence();
		await expect(committing).rejects.toThrow("ownership changed before session replacement commit");
		expect(persistedSessionIds).toEqual(["persist-race-new", "persist-race-old"]);
		expect(leaseCommit).not.toHaveBeenCalled();
		expect(created.entry.sessionId).toBe("persist-race-old");

		await transaction!.dispose();
		expect(leaseRollback).toHaveBeenCalledOnce();
		releaseRetirement();
		await stopping;
		expect(dispose).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledWith(created.entry, "host_shutdown");
		expect(registry.findOwner("ws", "persist-race-old")).toBeUndefined();
		expect(registry.findOwner("ws", "persist-race-new")).toBeUndefined();
	});

	it("rejects a daemon-owned rekey collision before invalidating either runtime", async () => {
		let prepareSourceReplacement:
			| ((target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>)
			| undefined;
		const sourceDispose = vi.fn(async () => {});
		const targetDispose = vi.fn(async () => {});
		const sourceRuntime = {
			cwd: workspacePath,
			session: createTestSession("source-session", null),
			dispose: sourceDispose,
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn((prepare) => {
				prepareSourceReplacement = prepare;
			}),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const targetRuntime = {
			cwd: workspacePath,
			session: createTestSession("target-session", null),
			dispose: targetDispose,
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const prepareRuntimeRekey = vi.fn(() => ({ commit: vi.fn(), rollback: vi.fn() }));
		let createCount = 0;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			prepareRuntimeRekey,
			createRuntime: async () => {
				const runtime = createCount++ === 0 ? sourceRuntime : targetRuntime;
				return {
					runtime,
					sessionSelection: { kind: "created", sessionId: runtime.session.sessionId },
				};
			},
		});
		const phone = createAuthorization("n-phone-a");
		const source = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(source.entry, source.sessionSelection, phone, source.attachClaim);
		source.attachClaim.release();
		const target = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(target.entry, target.sessionSelection, phone, target.attachClaim);
		target.attachClaim.release();

		await expect(
			prepareSourceReplacement?.({ previousSessionId: "source-session", sessionId: "target-session" }),
		).rejects.toThrow("conversation runtime already active");
		expect(prepareRuntimeRekey).not.toHaveBeenCalled();
		expect(sourceDispose).not.toHaveBeenCalled();
		expect(targetDispose).not.toHaveBeenCalled();
		expect(registry.findOwner("ws", "source-session")).toBe(source.entry);
		expect(registry.findOwner("ws", "target-session")).toBe(target.entry);
		await registry.stopAll("test_cleanup");
	});

	it("releases a committed reservation when projection publication fails", async () => {
		let prepareReplacement:
			| ((target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>)
			| undefined;
		const sourceRuntime = {
			cwd: workspacePath,
			session: createTestSession("publication-old", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn((prepare) => {
				prepareReplacement = prepare;
			}),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const replacementRuntime = {
			cwd: workspacePath,
			session: createTestSession("publication-new", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const onRuntimeDisposed = vi.fn((entry: IntegratedRuntimeEntry) => {
			entry.coordinator.clearLeaseOwner();
		});
		const retireTransport = vi.fn();
		const stateManager = new IrohRemoteHostStateManager();
		vi.spyOn(stateManager, "setClientsLastSessionId").mockResolvedValue([]);
		let createCount = 0;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager,
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			prepareRuntimeRekey: () => ({ commit: vi.fn(), rollback: vi.fn() }),
			onRuntimeDisposed,
			createRuntime: async () => {
				const runtime = createCount++ === 0 ? sourceRuntime : replacementRuntime;
				return {
					runtime,
					sessionSelection: { kind: "created", sessionId: runtime.session.sessionId },
				};
			},
		});
		const phone = createAuthorization("n-phone-a");
		const source = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(source.entry, source.sessionSelection, phone, source.attachClaim);
		installTestLeaseOwner(source.entry, "publication-owner");
		source.entry.coordinator.registerTransport({
			id: "publication-stream",
			kind: "direct",
			clientNodeId: phone.client.nodeId,
			connectionId: "publication-connection",
			close: retireTransport,
		});
		const sourceSubscriber = await registry.attachSubscriber(source.entry, source.attachClaim);
		source.attachClaim.release();
		const capturedAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "publication-old" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-phone-b"),
		);

		await expect(
			prepareReplacement?.({
				previousSessionId: "publication-old",
				sessionId: "publication-new",
			}),
		).rejects.toThrow("daemon runtime attach is still publishing");
		capturedAttach.attachClaim.release();

		const transaction = await prepareReplacement?.({
			previousSessionId: "publication-old",
			sessionId: "publication-new",
		});
		await transaction?.commit();
		await transaction?.dispose();
		expect(retireTransport).toHaveBeenCalledWith("session_replacement_failed");
		expect(retireTransport.mock.invocationCallOrder[0]).toBeLessThan(onRuntimeDisposed.mock.invocationCallOrder[0]!);
		expect(source.entry.subscribers.has(sourceSubscriber)).toBe(true);
		expect(onRuntimeDisposed).toHaveBeenCalledWith(source.entry, "session_replacement_failed");
		expect(registry.findOwner("ws", "publication-old")).toBeUndefined();
		expect(registry.findOwner("ws", "publication-new")).toBeUndefined();
		await expect(
			registry.commitEntry(
				capturedAttach.entry,
				capturedAttach.sessionSelection,
				createAuthorization("n-phone-b"),
				capturedAttach.attachClaim,
			),
		).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		await expect(registry.attachSubscriber(capturedAttach.entry, capturedAttach.attachClaim)).rejects.toMatchObject({
			outcome: "duplicate_conversation_connection",
		});
		expect(registry.findOwner("ws", "publication-new")).toBeUndefined();

		const replacement = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(replacement.entry, replacement.sessionSelection, phone, replacement.attachClaim);
		replacement.attachClaim.release();
		expect(registry.findOwner("ws", "publication-new")).toBe(replacement.entry);
		await registry.detachSubscriber(source.entry, sourceSubscriber, "retirement_settled");
		await registry.stopAll("test_cleanup");
	});

	it("closes streams and removes the runtime when an ownership rekey is rejected", async () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const dispose = vi.fn(async () => {});
		const close = vi.fn(async () => {});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("owned-old", null),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			onRuntimeRekeyed: () => {
				throw new Error("target lease occupied");
			},
			onRuntimeDisposed: (entry) => {
				entry.coordinator.clearLeaseOwner();
			},
			beforeRuntimeStop: async (entry, reason) => {
				for (const stream of activeStreams.entriesForConversationKey(entry.workspaceName, entry.sessionId)) {
					await stream.close(reason);
					activeStreams.unregister(stream);
				}
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "owned-old" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		installTestLeaseOwner(created.entry, "owned-rekey-owner");
		created.attachClaim.release();
		activeStreams.register({
			clientNodeId: "n-phone-a",
			workspaceName: "ws",
			sessionId: "owned-old",
			connectionId: "conn-a",
			streamId: "stream-a",
			close,
		});

		await expect(
			registry.handleSessionChanged(created.entry, undefined, { sessionId: "occupied-new" }, phone),
		).rejects.toThrow("target lease occupied");
		expect(close).toHaveBeenCalledWith("session_rekey_failed");
		expect(dispose).toHaveBeenCalledOnce();
		expect(registry.findOwner("ws", "owned-old")).toBeUndefined();
		expect(registry.findOwner("ws", "occupied-new")).toBeUndefined();
	});

	it("disposes and releases ownership even when ancillary live-activity cleanup fails", async () => {
		const dispose = vi.fn(async () => {});
		const onRuntimeDisposed = vi.fn();
		const stateManager = new IrohRemoteHostStateManager();
		stateManager.removeLiveActivitiesForWorkspaceSessions = vi.fn(async () => {
			throw new Error("state write failed");
		});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("cleanup-session", null),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager,
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			onRuntimeDisposed,
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "cleanup-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();

		await registry.stopEntry(created.entry, "test_cleanup_failure");
		expect(dispose).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledWith(created.entry, "test_cleanup_failure");
		expect(registry.findOwner("ws", "cleanup-session")).toBeUndefined();
	});

	it("does not resurrect a runtime stopped while commit audit publication is paused", async () => {
		let releaseAudit!: () => void;
		let markAuditStarted!: () => void;
		const auditStarted = new Promise<void>((resolve) => {
			markAuditStarted = resolve;
		});
		const auditGate = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		let releaseRetirement!: () => void;
		let markRetirementStarted!: () => void;
		const retirementStarted = new Promise<void>((resolve) => {
			markRetirementStarted = resolve;
		});
		const retirementGate = new Promise<void>((resolve) => {
			releaseRetirement = resolve;
		});
		const dispose = vi.fn(async () => {});
		const onRuntimeDisposed = vi.fn();
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: async (event) => {
						if (event.type === "session_created") {
							markAuditStarted();
							await auditGate;
						}
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				markRetirementStarted();
				await retirementGate;
			},
			onRuntimeDisposed,
			createRuntime: async () => ({
				runtime: {
					cwd: workspacePath,
					session: createTestSession("commit-stop-race", null),
					dispose,
					setRebindSession: vi.fn(),
					listSessions: vi.fn(async () => []),
				} as unknown as AgentSessionRuntime,
				sessionSelection: { kind: "created", sessionId: "commit-stop-race" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);

		const committing = registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		await auditStarted;
		const stopping = registry.stopEntry(created.entry, "access_updated");
		await retirementStarted;
		expect(created.entry.lifecycle).toBe("retiring");
		let abortSettled = false;
		const abortingFailedAttach = committing
			.catch(() => registry.abortPreparedEntry(created.entry, created.sessionSelection, created.attachClaim))
			.then(() => {
				abortSettled = true;
			});
		releaseAudit();

		await expect(committing).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		await Promise.resolve();
		expect(abortSettled).toBe(false);
		releaseRetirement();
		await abortingFailedAttach;
		await stopping;
		expect(dispose).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledWith(created.entry, "access_updated");
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "commit-stop-race")).toBeUndefined();
	});

	it("serializes an idle TUI handoff behind paused cross-layer runtime publication", async () => {
		let releasePublication!: () => void;
		let markPublicationStarted!: () => void;
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const runtimeDispose = vi.fn(async () => {});
		let registry!: IntegratedRuntimeRegistry;
		const disposeRuntime = vi.fn(async (workspaceName: string, sessionId: string, reason: string) => {
			const entry = registry.findOwner(workspaceName, sessionId);
			if (entry) {
				await registry.stopEntry(entry, reason);
			}
		});
		const coordinators = new ConversationCoordinatorRegistry();
		const broker = new LeaseBroker({
			...createConversationAuthorityEffects(coordinators),
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime,
			closePhoneStreams: () => {},
			closeRelays: () => {},
			audit: () => {},
		});
		coordinators.bindLeaseBroker(broker);
		registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			coordinators,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => {
				markPublicationStarted();
				await publicationGate;
				return undefined;
			}),
			createRuntime: async () => ({
				runtime: {
					cwd: workspacePath,
					session: createTestSession("publication-handoff", null),
					dispose: runtimeDispose,
					setRebindSession: vi.fn(),
					listSessions: vi.fn(async () => []),
				} as unknown as AgentSessionRuntime,
				sessionSelection: { kind: "created", sessionId: "publication-handoff" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		const begun = broker.beginDaemonAttach("ws", "publication-handoff");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		const brokerCommit = prepared.entry.coordinator.commitDaemonRuntime(begun.claim).outcome;
		expect(brokerCommit.ok).toBe(true);
		if (!brokerCommit.ok) return;

		const publishing = registry.commitEntry(prepared.entry, prepared.sessionSelection, phone, prepared.attachClaim);
		await publicationStarted;
		let handoffSettled = false;
		const handoff = broker
			.acquireForTui({ connectionId: "tui-publication", workspaceName: "ws", sessionId: "publication-handoff" })
			.then((outcome) => {
				handoffSettled = true;
				return outcome;
			});
		await Promise.resolve();
		expect(handoffSettled).toBe(false);
		expect(disposeRuntime).not.toHaveBeenCalled();
		expect(prepared.entry.lifecycle).toBe("prepared");

		releasePublication();
		await publishing;
		const finalization = prepared.entry.coordinator.finalizeDaemonRuntimeCommit(brokerCommit.token);
		expect(finalization.kind).toBe("finalized");
		prepared.attachClaim.release();

		expect(await handoff).toEqual({ kind: "granted", handoff: "warm" });
		expect(disposeRuntime).toHaveBeenCalledOnce();
		expect(runtimeDispose).toHaveBeenCalledOnce();
		expect(prepared.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "publication-handoff")).toBeUndefined();
		expect(broker.lookup("ws", "publication-handoff")?.state).toBe("tui-owned");
		expect(broker.releaseFromTui("tui-publication", "ws", "publication-handoff")).toEqual({ ok: true });
	});

	it("settles failed publication only after its prepared runtime cleanup has finished", async () => {
		let releaseRuntimeDispose!: () => void;
		let markRuntimeDisposeStarted!: () => void;
		const runtimeDisposeStarted = new Promise<void>((resolve) => {
			markRuntimeDisposeStarted = resolve;
		});
		const runtimeDisposeGate = new Promise<void>((resolve) => {
			releaseRuntimeDispose = resolve;
		});
		const runtimeDispose = vi.fn(async () => {
			markRuntimeDisposeStarted();
			await runtimeDisposeGate;
		});
		const keyBasedDispose = vi.fn(async () => {});
		const coordinators = new ConversationCoordinatorRegistry();
		const broker = new LeaseBroker({
			...createConversationAuthorityEffects(coordinators),
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime: keyBasedDispose,
			closePhoneStreams: () => {},
			closeRelays: () => {},
			audit: () => {},
		});
		coordinators.bindLeaseBroker(broker);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			coordinators,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => {
				throw new Error("session persistence failed");
			}),
			createRuntime: async () => ({
				runtime: {
					cwd: workspacePath,
					session: createTestSession("publication-failed", null),
					dispose: runtimeDispose,
					setRebindSession: vi.fn(),
					listSessions: vi.fn(async () => []),
				} as unknown as AgentSessionRuntime,
				sessionSelection: { kind: "created", sessionId: "publication-failed" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		const begun = broker.beginDaemonAttach("ws", "publication-failed");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		const brokerCommit = prepared.entry.coordinator.commitDaemonRuntime(begun.claim).outcome;
		expect(brokerCommit.ok).toBe(true);
		if (!brokerCommit.ok) return;

		await expect(
			registry.commitEntry(prepared.entry, prepared.sessionSelection, phone, prepared.attachClaim),
		).rejects.toThrow("session persistence failed");
		let handoffSettled = false;
		const handoff = broker
			.acquireForTui({ connectionId: "tui-failed", workspaceName: "ws", sessionId: "publication-failed" })
			.then((outcome) => {
				handoffSettled = true;
				return outcome;
			});

		// This mirrors the service transaction's failure ordering: clean up the
		// prepared registry/runtime owner first, then settle the broker token last.
		const aborting = registry.abortPreparedEntry(prepared.entry, prepared.sessionSelection, prepared.attachClaim);
		await runtimeDisposeStarted;
		await Promise.resolve();
		expect(handoffSettled).toBe(false);
		expect(keyBasedDispose).not.toHaveBeenCalled();

		releaseRuntimeDispose();
		await aborting;
		expect(registry.findOwner("ws", "publication-failed")).toBeUndefined();
		expect(broker.rollbackDaemonRuntimeCommit(brokerCommit.token)).toBe(false);

		expect(await handoff).toEqual({ kind: "granted", handoff: "none" });
		expect(runtimeDispose).toHaveBeenCalledOnce();
		expect(keyBasedDispose).not.toHaveBeenCalled();
		expect(broker.lookup("ws", "publication-failed")?.state).toBe("tui-owned");
		expect(broker.releaseFromTui("tui-failed", "ws", "publication-failed")).toEqual({ ok: true });
	});

	it("rolls back a provisional subscriber stopped while attach audit publication is paused", async () => {
		let pauseSubscriberAudit = false;
		let releaseAudit!: () => void;
		let markAuditStarted!: () => void;
		const auditStarted = new Promise<void>((resolve) => {
			markAuditStarted = resolve;
		});
		const auditGate = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		const dispose = vi.fn(async () => {});
		let attachSettled: Promise<void> = Promise.resolve();
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: async (event) => {
						if (pauseSubscriberAudit && event.type === "remote_subscriber_attached") {
							markAuditStarted();
							await auditGate;
						}
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				await attachSettled;
			},
			createRuntime: async () => ({
				runtime: {
					cwd: workspacePath,
					session: createTestSession("attach-stop-race", null),
					dispose,
					setRebindSession: vi.fn(),
					listSessions: vi.fn(async () => []),
				} as unknown as AgentSessionRuntime,
				sessionSelection: { kind: "created", sessionId: "attach-stop-race" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		const capturedAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "attach-stop-race" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-phone-b"),
		);

		pauseSubscriberAudit = true;
		const attaching = registry.attachSubscriber(created.entry, capturedAttach.attachClaim);
		attachSettled = attaching.then(
			() => undefined,
			() => undefined,
		);
		await auditStarted;
		expect(created.entry.subscribers.size).toBe(1);
		const stopping = registry.stopEntry(created.entry, "access_updated");
		expect(created.entry.lifecycle).toBe("retiring");
		releaseAudit();

		await expect(attaching).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		await stopping;
		expect(created.entry.subscribers.size).toBe(0);
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "attach-stop-race")).toBeUndefined();
	});

	it("fences a captured attach before awaiting owner retirement", async () => {
		let releaseRetirement!: () => void;
		let markRetirementStarted!: () => void;
		const retirementStarted = new Promise<void>((resolve) => {
			markRetirementStarted = resolve;
		});
		const retirementGate = new Promise<void>((resolve) => {
			releaseRetirement = resolve;
		});
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("retiring-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				markRetirementStarted();
				await retirementGate;
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "retiring-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		const capturedAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "retiring-session" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-phone-b"),
		);
		const capturedGeneration = created.entry.generation;

		const stopping = registry.stopEntry(created.entry, "access_updated");
		await retirementStarted;
		expect(created.entry.lifecycle).toBe("retiring");
		expect(created.entry.generation).toBeGreaterThan(capturedGeneration);
		await expect(registry.attachSubscriber(created.entry, capturedAttach.attachClaim)).rejects.toMatchObject({
			outcome: "duplicate_conversation_connection",
		});
		await expect(
			registry.commitEntry(
				created.entry,
				capturedAttach.sessionSelection,
				createAuthorization("n-phone-b"),
				capturedAttach.attachClaim,
			),
		).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });

		releaseRetirement();
		await stopping;
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "retiring-session")).toBeUndefined();
	});

	it("does not let attachable subagent sessions overwrite the client's last top-level session", async () => {
		const parentRuntime = {
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const childRuntime = {
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const setClientLastSessionId = vi.fn(async () => undefined);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			createRuntime: async () => ({
				runtime: parentRuntime,
				sessionSelection: { kind: "created", sessionId: "parent-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");

		const parent = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(parent.entry, parent.sessionSelection, phone, parent.attachClaim);
		parent.attachClaim.release();
		expect(setClientLastSessionId).toHaveBeenLastCalledWith("n-phone-a", "ws", "parent-session");

		setClientLastSessionId.mockClear();
		const registration = await registry.registerSubagentRuntime(
			{ id: "sa-child", parentSessionId: "parent-session", runtime: childRuntime, sessionId: "child-session" },
			phone,
		);
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		registration.commit();
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		setClientLastSessionId.mockClear();
		const child = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "child-session" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		expect(child.created).toBe(false);
		expect(child.entry).toMatchObject({ parentSessionId: "parent-session", subagentId: "sa-child" });
		await registry.commitEntry(child.entry, child.sessionSelection, phone, child.attachClaim);
		child.attachClaim.release();
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		await registry.handleSessionChanged(child.entry, undefined, { sessionId: "child-session-rekeyed" }, phone);
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		await registry.stopAll("test_cleanup");
	});

	it("disposes a prepared subagent runtime that is rolled back before prompt acceptance", async () => {
		const parentRuntime = {
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const childDispose = vi.fn(async () => {});
		const childRuntime = {
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			dispose: childDispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime: parentRuntime,
				sessionSelection: { kind: "created", sessionId: "parent-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const parent = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(parent.entry, parent.sessionSelection, phone, parent.attachClaim);
		parent.attachClaim.release();

		const registration = await registry.registerSubagentRuntime(
			{ id: "sa-child", parentSessionId: "parent-session", runtime: childRuntime, sessionId: "child-session" },
			phone,
		);

		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		await registration.rollback();
		await registration.rollback();

		expect(childDispose).toHaveBeenCalledOnce();
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		registration.commit();
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		await registry.stopAll("test_cleanup");
	});

	it("invalidates the whole shared runtime when any attached client is updated or revoked", () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const makeStream = (clientNodeId: string, sessionId: string) => ({
			clientNodeId,
			workspaceName: "ws",
			sessionId,
			connectionId: `conn-${clientNodeId}-${sessionId}`,
			streamId: `stream-${clientNodeId}-${sessionId}`,
			close: vi.fn(),
		});
		const creatorStream = makeStream("n-creator", "s-shared");
		const attachedStream = makeStream("n-attached", "s-shared");
		const attachedOtherStream = makeStream("n-attached", "s-other");
		activeStreams.register(creatorStream);
		activeStreams.register(attachedStream);
		activeStreams.register(attachedOtherStream);
		const runtimes = [
			{ clientNodeId: "n-creator", workspaceName: "ws", sessionId: "s-shared" },
			{ clientNodeId: "n-other", workspaceName: "ws", sessionId: "s-other" },
		];

		expect([...collectClientAuthorityInvalidationStreams(activeStreams, runtimes, "n-creator")]).toEqual([
			creatorStream,
			attachedStream,
		]);
		expect([...collectClientAuthorityInvalidationStreams(activeStreams, runtimes, "n-attached")]).toEqual([
			attachedStream,
			attachedOtherStream,
			creatorStream,
		]);
		expect([...collectClientAuthorityInvalidationRuntimes(activeStreams, runtimes, "n-attached")]).toEqual(runtimes);
	});

	it("selects and stops a two-client runtime even while its turn is blocking", async () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const abort = vi.fn(async () => {});
		const session = Object.assign(createTestSession("s-blocking", null), {
			abort,
			isBusy: true,
			isStreaming: true,
			waitForIdle: vi.fn(() => new Promise<void>(() => {})),
		});
		const dispose = vi.fn(async () => {
			await abort();
		});
		const runtime = {
			cwd: workspacePath,
			session,
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		let registry!: IntegratedRuntimeRegistry;
		registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async (entry, reason) => {
				for (const stream of activeStreams.entriesForConversationKey(entry.workspaceName, entry.sessionId)) {
					await stream.close(reason);
					activeStreams.unregister(stream);
				}
				for (const subscriber of [...entry.subscribers]) {
					await registry.detachSubscriber(entry, subscriber, reason);
				}
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-blocking" },
			}),
		});
		const creator = createAuthorization("n-creator");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			creator,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, creator, created.attachClaim);
		await registry.attachSubscriber(created.entry, created.attachClaim);
		const coattach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-blocking" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-attached"),
		);
		await registry.attachSubscriber(created.entry, coattach.attachClaim);
		created.attachClaim.release();
		coattach.attachClaim.release();
		for (const clientNodeId of ["n-creator", "n-attached"]) {
			activeStreams.register({
				clientNodeId,
				workspaceName: "ws",
				sessionId: "s-blocking",
				connectionId: `conn-${clientNodeId}`,
				streamId: `stream-${clientNodeId}`,
				close: vi.fn(),
			});
		}

		const affected = collectClientAuthorityInvalidationRuntimes(activeStreams, registry.values(), "n-attached");
		expect([...affected]).toEqual([created.entry]);
		for (const entry of affected) {
			await registry.stopEntry(entry, "access_updated");
		}

		expect(session.waitForIdle).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.subscribers.size).toBe(0);
		expect(registry.findOwner("ws", "s-blocking")).toBeUndefined();
	});

	it("retains a detached runtime while prompt preflight is busy", async () => {
		vi.useFakeTimers();
		try {
			let resolveIdle = () => {};
			const idle = new Promise<void>((resolve) => {
				resolveIdle = resolve;
			});
			const session = Object.assign(createTestSession("s-busy", null), {
				isBusy: true,
				isStreaming: false,
				waitForIdle: vi.fn(() => idle),
			});
			const dispose = vi.fn(async () => {});
			const runtimeHost = {
				cwd: workspacePath,
				session,
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			} as unknown as AgentSessionRuntime;
			const registry = new IntegratedRuntimeRegistry({
				agentDir,
				auditLogger: new IrohRemoteAuditLogger(),
				stateManager: new IrohRemoteHostStateManager(),
				activeStreams: new IrohRemoteActiveStreamRegistry(),
				detachedRuntimeTtlMs: () => 1000,
				getAllowTools: () => undefined,
				getProjectTrustedForWorkspace: () => false,
				setClientLastSessionId: vi.fn(async () => undefined),
				createRuntime: async () => ({
					runtime: runtimeHost,
					sessionSelection: { kind: "created", sessionId: "s-busy" },
				}),
			});
			const phone = createAuthorization("n-phone-a");
			const created = await registry.getOrCreateEntry(
				{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
				phone,
			);
			await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
			const subscriber = await registry.attachSubscriber(created.entry, created.attachClaim);
			created.attachClaim.release();
			await registry.detachSubscriber(created.entry, subscriber, "test_detach");

			expect(session.waitForIdle).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(5000);
			expect(dispose).not.toHaveBeenCalled();

			session.isBusy = false;
			resolveIdle();
			await vi.advanceTimersByTimeAsync(999);
			expect(dispose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(dispose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores stopEntry for a stale reference whose key now belongs to a replacement runtime", async () => {
		// Regression guard: stopEntry used to delete by key alone, so a stale
		// entry reference could evict a replacement runtime from the registry
		// while leaving it running unmanaged.
		const makeRuntimeHost = (sessionId: string, dispose: ReturnType<typeof vi.fn>) =>
			({
				cwd: workspacePath,
				session: createTestSession(sessionId, null),
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			}) as unknown as AgentSessionRuntime;
		const disposeA = vi.fn(async () => {});
		const disposeB = vi.fn(async () => {});
		let nextRuntime = makeRuntimeHost("s-stale", disposeA);

		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime: nextRuntime,
				sessionSelection: { kind: "created", sessionId: "s-stale" },
			}),
		});
		const phone = createAuthorization("n-phone-a");

		const first = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(first.entry, first.sessionSelection, phone, first.attachClaim);
		await registry.stopEntry(first.entry, "test_stop");
		expect(disposeA).toHaveBeenCalledTimes(1);
		expect(registry.findOwner("ws", "s-stale")).toBeUndefined();

		// A replacement runtime takes over the same (workspace, sessionId) key.
		nextRuntime = makeRuntimeHost("s-stale", disposeB);
		const second = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(second.entry, second.sessionSelection, phone, second.attachClaim);
		second.attachClaim.release();
		expect(second.entry).not.toBe(first.entry);

		// A stale stop of the FIRST entry must not evict the replacement.
		await registry.stopEntry(first.entry, "stale_stop");
		expect(registry.findOwner("ws", "s-stale")).toBe(second.entry);
		expect(disposeB).not.toHaveBeenCalled();
		expect(disposeA).toHaveBeenCalledTimes(1);
	});
});
