import { describe, expect, it, vi } from "vitest";
import {
	CONVERSATION_CLIENT_NODE_ID_MAX_UTF8_BYTES,
	ConversationCoordinator,
	ConversationCoordinatorRegistry,
	type ConversationTransportOwner,
} from "../src/daemon/conversation-coordinator.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createTransport(
	id: string,
	close: ConversationTransportOwner["close"] = () => {},
	kind: ConversationTransportOwner["kind"] = "direct",
): ConversationTransportOwner {
	return {
		id,
		kind,
		clientNodeId: `client-${id}`,
		connectionId: `connection-${id}`,
		close,
	};
}

function createLeaseBroker(): LeaseBroker {
	return new LeaseBroker({
		isRuntimeStreaming: () => false,
		waitForRuntimeIdle: async () => {},
		disposeRuntime: async () => {},
		closePhoneStreams: async () => {},
		closeRelays: () => {},
		beginTuiLeaseHandoff: () => {},
		commitTuiLeaseHandoff: () => {},
		cancelTuiLeaseHandoff: () => {},
		releaseTuiLease: () => {},
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
		audit: () => {},
	});
}

/** Broker wired to real coordinators exactly like IrohDaemonService wires its effects. */
function createCoordinatorWiredLeaseBroker(registry: ConversationCoordinatorRegistry): LeaseBroker {
	const broker = new LeaseBroker({
		isRuntimeStreaming: () => false,
		waitForRuntimeIdle: async () => {},
		disposeRuntime: async (workspaceName, sessionId, reason) => {
			await registry.get(workspaceName, sessionId)?.beginRuntimeRetirement(reason, () => {}).settled;
		},
		closePhoneStreams: async (workspaceName, sessionId, reason) => {
			await registry.get(workspaceName, sessionId)?.closeTransports(reason, (owner) => owner.kind === "direct");
		},
		closeRelays: (record, reason) => {
			for (const relayId of Array.from(record.relayIds)) {
				void registry.get(record.workspaceName, record.sessionId)?.closeTransport(relayId, reason);
			}
		},
		beginTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
			(
				registry.get(workspaceName, sessionId) ?? registry.getOrCreate(workspaceName, sessionId)
			).beginTuiLeaseHandoff(connectionId);
		},
		commitTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
			const coordinator = registry.get(workspaceName, sessionId);
			if (!coordinator) throw new Error("TUI handoff lost its conversation coordinator");
			coordinator.commitTuiLeaseHandoff(connectionId);
		},
		cancelTuiLeaseHandoff: (workspaceName, sessionId, connectionId) => {
			registry.get(workspaceName, sessionId)?.cancelTuiLeaseHandoff(connectionId);
		},
		releaseTuiLease: (workspaceName, sessionId, connectionId) => {
			registry.get(workspaceName, sessionId)?.releaseTuiLease(connectionId);
		},
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
		audit: () => {},
	});
	registry.bindLeaseBroker(broker);
	return broker;
}

describe("ConversationCoordinator", () => {
	it("keeps one stable authority across rekey aliases", () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session-a");
		coordinator.activateRuntime();

		registry.rekey(coordinator, "session-b");

		expect(registry.get("workspace", "session-a")).toBe(coordinator);
		expect(registry.get("workspace", "session-b")).toBe(coordinator);
		expect(coordinator.sessionId).toBe("session-b");
		expect(coordinator.previousSessionIds).toEqual(new Set(["session-a"]));
		expect(registry.values()).toEqual([coordinator]);
	});

	it("reserves a rekey target until the same authority commits or rolls back", () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.getOrCreate("workspace", "session-a");
		coordinator.beginTuiLeaseHandoff("tui");
		coordinator.commitTuiLeaseHandoff("tui");
		const rolledBack = registry.prepareRekey(coordinator, "session-b");

		expect(() => registry.getOrCreate("workspace", "session-b")).toThrow("rekey target is reserved");
		expect(registry.rollbackRekey(rolledBack)).toBe(true);
		expect(coordinator.sessionId).toBe("session-a");

		const committed = registry.prepareRekey(coordinator, "session-b");
		registry.commitRekey(committed);
		expect(registry.get("workspace", "session-a")).toBe(coordinator);
		expect(registry.get("workspace", "session-b")).toBe(coordinator);
		expect(coordinator.sessionId).toBe("session-b");
	});

	it("fences attach claims synchronously when retirement begins", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		const claim = coordinator.createAttachClaim("client-node");
		const generation = coordinator.generation;

		const retirement = coordinator.beginRuntimeRetirement("test", () => {});

		expect(coordinator.runtimeLifecycle).toBe("retiring");
		expect(coordinator.generation).toBeGreaterThan(generation);
		expect(claim.released).toBe(true);
		expect(coordinator.isAttachClaimCurrent(claim)).toBe(false);
		await retirement.settled;
		expect(coordinator.runtimeLifecycle).toBe("retired");
	});

	it("bounds client identity before retaining an attach claim", () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();

		expect(() => coordinator.createAttachClaim("")).toThrow("must be a non-empty string");
		expect(() => coordinator.createAttachClaim(" client-node ")).toThrow("without surrounding whitespace");
		expect(() =>
			coordinator.createAttachClaim("🧪".repeat(Math.floor(CONVERSATION_CLIENT_NODE_ID_MAX_UTF8_BYTES / 4) + 1)),
		).toThrow(`${CONVERSATION_CLIENT_NODE_ID_MAX_UTF8_BYTES}-byte UTF-8 limit`);
		expect(coordinator.attachClaims.size).toBe(0);

		const clientNodeId = "client-node";
		const claim = coordinator.createAttachClaim(clientNodeId);
		expect(claim.clientNodeId).toBe(clientNodeId);
		expect(coordinator.attachClaims).toEqual(new Set([claim]));
	});

	it("owns one terminal barrier across transport close and runtime finalization", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		const closeGate = deferred();
		const events: string[] = [];
		const close = vi.fn(async () => {
			events.push("transport_close_started");
			await closeGate.promise;
			events.push("transport_close_settled");
		});
		coordinator.registerTransport(createTransport("stream", close));

		const first = coordinator.beginRuntimeRetirement("shutdown", () => {
			events.push("runtime_finalized");
		});
		const second = coordinator.beginRuntimeRetirement("duplicate", () => {
			throw new Error("must not run");
		});

		expect(second).toBe(first);
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
		expect(events).toEqual(["transport_close_started"]);
		closeGate.resolve();
		await first.settled;
		expect(events).toEqual(["transport_close_started", "transport_close_settled", "runtime_finalized"]);
		expect(coordinator.transportCount).toBe(0);
		expect(registry.size).toBe(0);
	});

	it("fences a transport synchronously while retaining it through physical close settlement", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		const closeGate = deferred();
		const close = vi.fn(() => closeGate.promise);
		coordinator.registerTransport(createTransport("stream", close));

		const closing = coordinator.closeTransport("stream", "host_shutdown");

		expect(close).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledWith("host_shutdown");
		expect(coordinator.transportCount).toBe(1);
		closeGate.resolve();
		await expect(closing).resolves.toBe(true);
		expect(coordinator.transportCount).toBe(0);
	});

	it("can finalize concurrently when retirement originates inside its own transport", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		const closeGate = deferred();
		const finalize = vi.fn();
		coordinator.registerTransport(createTransport("stream", () => closeGate.promise));

		const retirement = coordinator.beginRuntimeRetirement("replacement_failed", finalize, {
			finalizationOrder: "concurrent",
		});

		await retirement.finalization;
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(coordinator.runtimeLifecycle).toBe("retiring");
		let terminalSettled = false;
		void retirement.settled.then(() => {
			terminalSettled = true;
		});
		await Promise.resolve();
		expect(terminalSettled).toBe(false);
		closeGate.resolve();
		await retirement.settled;
		expect(terminalSettled).toBe(true);
	});

	it("is the exactly-once closer for relay-only conversations", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.getOrCreate("workspace", "session");
		coordinator.beginTuiLeaseHandoff("tui-connection");
		coordinator.commitTuiLeaseHandoff("tui-connection");
		const close = vi.fn();
		coordinator.registerTransport(createTransport("relay", close, "relay"));

		const [first, second] = await Promise.all([
			coordinator.closeTransport("relay", "host_shutdown"),
			coordinator.closeTransport("relay", "client_revoked"),
		]);

		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith("host_shutdown");
		expect(registry.size).toBe(1);
		expect(coordinator.releaseTuiLease("tui-connection")).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("rejects a daemon runtime reservation while relay ownership is still live", () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.getOrCreate("workspace", "session");
		coordinator.beginTuiLeaseHandoff("tui-connection");
		coordinator.commitTuiLeaseHandoff("tui-connection");
		coordinator.registerTransport(createTransport("relay", () => {}, "relay"));

		expect(() => registry.reserveRuntime("workspace", "session")).toThrow(
			"conversation transports are still retiring",
		);
	});

	it("owns daemon lease publication, stream count, and exact release", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const broker = createLeaseBroker();
		registry.bindLeaseBroker(broker);
		const coordinator = registry.reserveRuntime("workspace", "session");
		const attach = broker.beginDaemonAttach("workspace", "session");
		expect(attach.kind).toBe("proceed");
		if (attach.kind !== "proceed") return;

		const publication = coordinator.commitDaemonRuntime(attach.claim);
		expect(publication.outcome.ok).toBe(true);
		if (!publication.outcome.ok) return;
		coordinator.activateRuntime();
		coordinator.registerTransport(createTransport("stream"));
		coordinator.markTransportLeaseActive("stream", true);
		expect(coordinator.finalizeDaemonRuntimeCommit(publication.outcome.token).kind).toBe("finalized");
		expect(coordinator.syncDaemonRuntimeStreamCount()).toBe(true);
		expect(broker.lookup("workspace", "session")).toMatchObject({ state: "daemon-active", streamCount: 1 });

		await coordinator.beginRuntimeRetirement("test", () => {}).settled;

		expect(broker.lookup("workspace", "session")).toBeUndefined();
		expect(coordinator.leaseOwner).toBeUndefined();
		expect(registry.size).toBe(0);
	});

	it("keeps the same authority non-vacant through a pending daemon-to-TUI handoff", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const broker = createLeaseBroker();
		registry.bindLeaseBroker(broker);
		const coordinator = registry.reserveRuntime("workspace", "session");
		const attach = broker.beginDaemonAttach("workspace", "session");
		expect(attach.kind).toBe("proceed");
		if (attach.kind !== "proceed") return;
		const publication = coordinator.commitDaemonRuntime(attach.claim);
		expect(publication.outcome.ok).toBe(true);
		if (!publication.outcome.ok) return;
		coordinator.activateRuntime();
		expect(coordinator.finalizeDaemonRuntimeCommit(publication.outcome.token).kind).toBe("finalized");

		coordinator.beginTuiLeaseHandoff("tui-connection");
		await coordinator.beginRuntimeRetirement("lease_transferred_to_tui", () => {}).settled;

		expect(registry.get("workspace", "session")).toBe(coordinator);
		expect(coordinator.pendingTuiLeaseConnectionId).toBe("tui-connection");
		expect(coordinator.leaseOwner).toBeUndefined();
		coordinator.commitTuiLeaseHandoff("tui-connection");
		expect(registry.get("workspace", "session")).toBe(coordinator);
		expect(coordinator.tuiLeaseConnectionId).toBe("tui-connection");
		expect(coordinator.releaseTuiLease("tui-connection")).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("retains a fenced lease capability when terminal broker release fails", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const broker = createLeaseBroker();
		registry.bindLeaseBroker(broker);
		const coordinator = registry.reserveRuntime("workspace", "session");
		const attach = broker.beginDaemonAttach("workspace", "session");
		expect(attach.kind).toBe("proceed");
		if (attach.kind !== "proceed") return;
		const publication = coordinator.commitDaemonRuntime(attach.claim);
		expect(publication.outcome.ok).toBe(true);
		if (!publication.outcome.ok) return;
		coordinator.activateRuntime();
		expect(coordinator.finalizeDaemonRuntimeCommit(publication.outcome.token).kind).toBe("finalized");
		const owner = publication.outcome.owner;
		expect(broker.onDaemonRuntimeDisposed(owner, "workspace", "session", "external_fence")).toBe(true);

		const retirementError = await coordinator
			.beginRuntimeRetirement("shutdown", () => {})
			.settled.catch((error: unknown) => error);
		expect(retirementError).toBeInstanceOf(AggregateError);
		expect((retirementError as AggregateError).errors).toEqual([
			expect.objectContaining({
				message: "conversation runtime lease release was fenced for workspace/session",
			}),
		]);

		expect(coordinator.leaseOwner).toBe(owner);
		expect(coordinator.runtimeLifecycle).toBe("retired");
		expect(coordinator.isVacant).toBe(false);
		expect(registry.get("workspace", "session")).toBe(coordinator);
		// The retained capability keeps the authority reserved: no re-preparation.
		expect(() => registry.reserveRuntime("workspace", "session")).toThrow("conversation runtime already reserved");
	});

	it("relays phone attaches through the stable authority after a warm daemon-to-TUI handoff", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const broker = createCoordinatorWiredLeaseBroker(registry);
		const coordinator = registry.reserveRuntime("workspace", "session");
		const attach = broker.beginDaemonAttach("workspace", "session");
		expect(attach.kind).toBe("proceed");
		if (attach.kind !== "proceed") return;
		const publication = coordinator.commitDaemonRuntime(attach.claim);
		expect(publication.outcome.ok).toBe(true);
		if (!publication.outcome.ok) return;
		coordinator.activateRuntime();
		expect(coordinator.finalizeDaemonRuntimeCommit(publication.outcome.token).kind).toBe("finalized");

		// Idle warm handoff: the daemon runtime retires, then the TUI lease commits.
		await expect(
			broker.acquireForTui({ connectionId: "tui-connection", workspaceName: "workspace", sessionId: "session" }),
		).resolves.toEqual({ kind: "granted", handoff: "warm" });
		expect(coordinator.runtimeLifecycle).toBe("retired");
		expect(coordinator.tuiLeaseConnectionId).toBe("tui-connection");

		// A reconnecting phone routes to a TUI relay (issue #81: this must not be
		// permanently rejected with "conversation owner changed; retry").
		const relayAttach = broker.beginDaemonAttach("workspace", "session");
		expect(relayAttach).toEqual({ kind: "relay", tuiConnectionId: "tui-connection" });
		const releaseTransport = coordinator.registerTransport(createTransport("relay-1", () => {}, "relay"));
		expect(coordinator.registerRelayLease("relay-1")).toBe(true);

		// Direct transports still require an active daemon runtime.
		expect(() => coordinator.registerTransport(createTransport("direct-1"))).toThrow(
			"direct conversation transport requires an active daemon runtime",
		);

		coordinator.unregisterRelayLease("relay-1");
		releaseTransport();
		expect(broker.releaseFromTui("tui-connection", "workspace", "session")).toEqual({ ok: true });
		expect(registry.size).toBe(0);
	});

	it("keeps fencing relay transports while runtime retirement is in flight", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		const closeGate = deferred();
		coordinator.registerTransport(createTransport("stream", () => closeGate.promise));

		const retirement = coordinator.beginRuntimeRetirement("lease_transferred_to_tui", () => {});

		expect(coordinator.runtimeLifecycle).toBe("retiring");
		expect(() => coordinator.registerTransport(createTransport("relay-1", () => {}, "relay"))).toThrow(
			"conversation is retiring",
		);
		closeGate.resolve();
		await retirement.settled;
	});

	it("reports retiring transports when a daemon reservation races relay closure after TUI release", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.reserveRuntime("workspace", "session");
		coordinator.activateRuntime();
		coordinator.beginTuiLeaseHandoff("tui-connection");
		await coordinator.beginRuntimeRetirement("lease_transferred_to_tui", () => {}).settled;
		coordinator.commitTuiLeaseHandoff("tui-connection");
		const closeGate = deferred();
		coordinator.registerTransport(createTransport("relay-1", () => closeGate.promise, "relay"));

		// The TUI releases while its relay transport is still closing: a racing
		// daemon reservation must fail on the transports, not on a phantom runtime.
		const closing = coordinator.closeTransport("relay-1", "lease_transferred");
		coordinator.releaseTuiLease("tui-connection");
		expect(registry.get("workspace", "session")).toBe(coordinator);
		expect(() => registry.reserveRuntime("workspace", "session")).toThrow(
			"conversation transports are still retiring",
		);

		closeGate.resolve();
		await closing;
		expect(registry.size).toBe(0);
		expect(registry.reserveRuntime("workspace", "session")).not.toBe(coordinator);
	});

	it("re-prepares a retired authority once transports and lease authority are gone", async () => {
		const coordinator = new ConversationCoordinator("workspace", "session");
		coordinator.prepareRuntime();
		coordinator.activateRuntime();
		await coordinator.beginRuntimeRetirement("test", () => {}).settled;
		expect(coordinator.runtimeLifecycle).toBe("retired");
		expect(coordinator.retirement).toBeDefined();

		coordinator.prepareRuntime();

		expect(coordinator.runtimeLifecycle).toBe("prepared");
		expect(coordinator.retirement).toBeUndefined();
		coordinator.activateRuntime();
		await coordinator.beginRuntimeRetirement("again", () => {}).settled;
		expect(coordinator.runtimeLifecycle).toBe("retired");
	});

	it("keeps a TUI lease anchored across relay settlement and rekey", async () => {
		const registry = new ConversationCoordinatorRegistry();
		const coordinator = registry.getOrCreate("workspace", "session-a");
		coordinator.beginTuiLeaseHandoff("tui");
		coordinator.commitTuiLeaseHandoff("tui");
		coordinator.registerTransport(createTransport("relay", () => {}, "relay"));

		await coordinator.closeTransport("relay", "session_rekeyed_reconnect");
		registry.rekey(coordinator, "session-b");

		expect(registry.get("workspace", "session-a")).toBe(coordinator);
		expect(registry.get("workspace", "session-b")).toBe(coordinator);
		expect(coordinator.tuiLeaseConnectionId).toBe("tui");
		expect(coordinator.releaseTuiLease("tui")).toBe(true);
		expect(registry.size).toBe(0);
		expect(registry.get("workspace", "session-a")).toBeUndefined();
		expect(registry.get("workspace", "session-b")).toBeUndefined();
		const replacement = registry.getOrCreate("workspace", "session-a");
		expect(replacement).not.toBe(coordinator);
		expect(replacement.sessionId).toBe("session-a");
	});
});
