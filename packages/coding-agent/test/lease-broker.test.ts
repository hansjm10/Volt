import { describe, expect, it, vi } from "vitest";
import {
	type DaemonRuntimeOwnerCapability,
	LeaseBroker,
	type LeaseBrokerEffects,
	type LeaseRecord,
} from "../src/daemon/lease-broker.ts";

interface Harness {
	broker: LeaseBroker;
	effects: {
		streaming: Set<string>;
		idleWaiters: Map<string, Array<() => void>>;
		disposed: Array<{ key: string; reason: string }>;
		closedStreams: Array<{ key: string; reason: string }>;
		closedRelays: Array<{ key: string; reason: string }>;
		handoffs: Array<{
			phase: "begin" | "commit" | "cancel" | "release" | "prepare_rekey" | "commit_rekey" | "rollback_rekey";
			key: string;
			connectionId: string;
			newKey?: string;
		}>;
		audits: Array<{ type: string; details: Record<string, unknown> }>;
		drainStarted: string[];
		drainEnded: Array<{ key: string; reason: string }>;
	};
	/** Resolve all pending waitForRuntimeIdle calls for a key. */
	finishTurn(workspaceName: string, sessionId: string): Promise<void>;
	/** Make the next disposeRuntime call reject with the given error. */
	failNextDispose(error: Error): void;
}

const NOOP_CONVERSATION_AUTHORITY_EFFECTS = {
	beginTuiLeaseHandoff: () => {},
	commitTuiLeaseHandoff: () => {},
	cancelTuiLeaseHandoff: () => {},
	releaseTuiLease: () => {},
	prepareTuiLeaseRekey: () => {},
	commitTuiLeaseRekey: () => {},
	rollbackTuiLeaseRekey: () => {},
};

function key(workspaceName: string, sessionId: string): string {
	return `${workspaceName}/${sessionId}`;
}

const daemonRuntimeOwners = new WeakMap<LeaseBroker, Map<string, DaemonRuntimeOwnerCapability>>();

function rememberDaemonRuntimeOwner(
	broker: LeaseBroker,
	workspaceName: string,
	sessionId: string,
	owner: DaemonRuntimeOwnerCapability,
): DaemonRuntimeOwnerCapability {
	let owners = daemonRuntimeOwners.get(broker);
	if (!owners) {
		owners = new Map();
		daemonRuntimeOwners.set(broker, owners);
	}
	owners.set(key(workspaceName, sessionId), owner);
	return owner;
}

function getDaemonRuntimeOwner(
	broker: LeaseBroker,
	workspaceName: string,
	sessionId: string,
): DaemonRuntimeOwnerCapability {
	const owner = daemonRuntimeOwners.get(broker)?.get(key(workspaceName, sessionId));
	if (!owner) {
		throw new Error(`Missing test daemon runtime owner for ${workspaceName}/${sessionId}`);
	}
	return owner;
}

function attachDaemonRuntime(
	broker: LeaseBroker,
	workspaceName: string,
	sessionId: string,
): DaemonRuntimeOwnerCapability {
	const begun = broker.beginDaemonAttach(workspaceName, sessionId);
	if (begun.kind === "retry") {
		throw new Error(`Cannot attach daemon runtime while a lease rekey reserves ${workspaceName}/${sessionId}`);
	}
	if (begun.kind === "relay") {
		throw new Error(`Cannot attach daemon runtime while ${workspaceName}/${sessionId} is TUI-owned`);
	}
	const committed = broker.commitDaemonRuntime(begun.claim, workspaceName, sessionId);
	if (!committed.ok) {
		throw new Error(`Cannot commit daemon runtime: ${committed.reason}`);
	}
	const finalized = broker.finalizeDaemonRuntimeCommit(committed.token);
	if (finalized.kind === "fenced") {
		throw new Error("Cannot publish a fenced daemon runtime");
	}
	return rememberDaemonRuntimeOwner(broker, workspaceName, sessionId, finalized.owner);
}

function updateDaemonRuntimeStreamCount(
	broker: LeaseBroker,
	workspaceName: string,
	sessionId: string,
	liveStreams: number,
): boolean {
	return broker.onDaemonRuntimeStreamCountChanged(
		getDaemonRuntimeOwner(broker, workspaceName, sessionId),
		workspaceName,
		sessionId,
		liveStreams,
	);
}

function disposeDaemonRuntime(broker: LeaseBroker, workspaceName: string, sessionId: string, reason: string): boolean {
	return broker.onDaemonRuntimeDisposed(
		getDaemonRuntimeOwner(broker, workspaceName, sessionId),
		workspaceName,
		sessionId,
		reason,
	);
}

function createHarness(): Harness {
	const streaming = new Set<string>();
	const idleWaiters = new Map<string, Array<() => void>>();
	const disposed: Array<{ key: string; reason: string }> = [];
	const closedStreams: Array<{ key: string; reason: string }> = [];
	const closedRelays: Array<{ key: string; reason: string }> = [];
	const handoffs: Harness["effects"]["handoffs"] = [];
	const audits: Array<{ type: string; details: Record<string, unknown> }> = [];
	const drainStarted: string[] = [];
	const drainEnded: Array<{ key: string; reason: string }> = [];
	const preparedRekeys = new Map<string, { key: string; newKey: string }>();
	let viewerFeedSequence = 0;
	let pendingDisposeError: Error | undefined;

	const effects: LeaseBrokerEffects = {
		isRuntimeStreaming: (ws, sid) => streaming.has(key(ws, sid)),
		waitForRuntimeIdle: (ws, sid) => {
			if (!streaming.has(key(ws, sid))) {
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				const waiters = idleWaiters.get(key(ws, sid)) ?? [];
				waiters.push(resolve);
				idleWaiters.set(key(ws, sid), waiters);
			});
		},
		disposeRuntime: async (ws, sid, reason) => {
			if (pendingDisposeError) {
				const error = pendingDisposeError;
				pendingDisposeError = undefined;
				throw error;
			}
			disposed.push({ key: key(ws, sid), reason });
		},
		closePhoneStreams: (ws, sid, reason) => {
			closedStreams.push({ key: key(ws, sid), reason });
		},
		closeRelays: (record: LeaseRecord, reason) => {
			closedRelays.push({ key: key(record.workspaceName, record.sessionId), reason });
		},
		beginTuiLeaseHandoff: (ws, sid, connectionId) => {
			handoffs.push({ phase: "begin", key: key(ws, sid), connectionId });
		},
		commitTuiLeaseHandoff: (ws, sid, connectionId) => {
			handoffs.push({ phase: "commit", key: key(ws, sid), connectionId });
		},
		cancelTuiLeaseHandoff: (ws, sid, connectionId) => {
			handoffs.push({ phase: "cancel", key: key(ws, sid), connectionId });
		},
		releaseTuiLease: (ws, sid, connectionId) => {
			handoffs.push({ phase: "release", key: key(ws, sid), connectionId });
		},
		prepareTuiLeaseRekey: (transactionId, ws, oldSid, newSid, connectionId) => {
			preparedRekeys.set(transactionId, { key: key(ws, oldSid), newKey: key(ws, newSid) });
			handoffs.push({
				phase: "prepare_rekey",
				key: key(ws, oldSid),
				connectionId,
				newKey: key(ws, newSid),
			});
		},
		commitTuiLeaseRekey: (transactionId, connectionId) => {
			const prepared = preparedRekeys.get(transactionId);
			if (!prepared) throw new Error("missing prepared test rekey");
			handoffs.push({ phase: "commit_rekey", ...prepared, connectionId });
			preparedRekeys.delete(transactionId);
		},
		rollbackTuiLeaseRekey: (transactionId, connectionId) => {
			const prepared = preparedRekeys.get(transactionId);
			if (!prepared) return;
			handoffs.push({ phase: "rollback_rekey", ...prepared, connectionId });
			preparedRekeys.delete(transactionId);
		},
		onDrainStarted: (_record, viewerFeedId) => {
			drainStarted.push(viewerFeedId);
		},
		onDrainEnded: (record, _viewerFeedId, reason) => {
			drainEnded.push({ key: key(record.workspaceName, record.sessionId), reason });
		},
		audit: (event) => {
			audits.push({ type: event.type, details: event.details });
		},
		generateViewerFeedId: () => `vf-${++viewerFeedSequence}`,
	};

	return {
		broker: new LeaseBroker(effects),
		effects: {
			streaming,
			idleWaiters,
			disposed,
			closedStreams,
			closedRelays,
			handoffs,
			audits,
			drainStarted,
			drainEnded,
		},
		async finishTurn(ws, sid) {
			streaming.delete(key(ws, sid));
			for (const resolve of idleWaiters.get(key(ws, sid)) ?? []) {
				resolve();
			}
			idleWaiters.delete(key(ws, sid));
			// Let the drain continuation run.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
		failNextDispose(error: Error) {
			pendingDisposeError = error;
		},
	};
}

describe("LeaseBroker", () => {
	it("grants unowned acquires immediately with handoff none", async () => {
		const { broker, effects } = createHarness();
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "none" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.handoffs).toEqual([
			{ phase: "begin", key: "ws/s1", connectionId: "c-1" },
			{ phase: "commit", key: "ws/s1", connectionId: "c-1" },
		]);
	});

	it("denies force acquires with force_unsupported", async () => {
		const { broker, effects } = createHarness();
		const outcome = await broker.acquireForTui({
			connectionId: "c-1",
			workspaceName: "ws",
			sessionId: "s1",
			force: true,
		});
		expect(outcome).toEqual({ kind: "denied", reason: "force_unsupported" });
		expect(effects.audits.at(-1)?.type).toBe("lease_denied");
	});

	it("is idempotent for the owning connection and denies other TUIs", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		const again = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(again.kind).toBe("granted");
		const other = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(other).toEqual({ kind: "denied", reason: "held_by_tui" });
	});

	it("lets a TUI preempt a provisional daemon attach before commit", async () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "none" });
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed).toEqual({ ok: false, reason: "tui_owned", tuiConnectionId: "c-1" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("pins an unowned lease while a provisional daemon attach is in flight", async () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.releaseFromTui("c-1", "ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("unowned");
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it.each(["older", "newer"] as const)(
		"keeps daemon ownership when the %s co-attach finalizes and its peer rolls back",
		(finalizedAttach) => {
			const { broker } = createHarness();
			const olderAttach = broker.beginDaemonAttach("ws", "s1");
			const newerAttach = broker.beginDaemonAttach("ws", "s1");
			expect(olderAttach.kind).toBe("proceed");
			expect(newerAttach.kind).toBe("proceed");
			if (olderAttach.kind !== "proceed" || newerAttach.kind !== "proceed") {
				return;
			}

			const olderCommit = broker.commitDaemonRuntime(olderAttach.claim, "ws", "s1");
			const newerCommit = broker.commitDaemonRuntime(newerAttach.claim, "ws", "s1");
			expect(olderCommit.ok).toBe(true);
			expect(newerCommit.ok).toBe(true);
			if (!olderCommit.ok || !newerCommit.ok) {
				return;
			}

			const finalized = finalizedAttach === "older" ? olderCommit.token : newerCommit.token;
			const failed = finalizedAttach === "older" ? newerCommit.token : olderCommit.token;
			expect(broker.finalizeDaemonRuntimeCommit(finalized)).toMatchObject({ kind: "finalized" });
			expect(broker.rollbackDaemonRuntimeCommit(failed)).toBe(false);
			expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
			expect(broker.lookup("ws", "s1")?.pendingDaemonAttaches).toBe(0);
		},
	);

	it.each(["older-first", "newer-first"] as const)(
		"restores the stable base when both co-attaches roll back %s",
		(rollbackOrder) => {
			const { broker } = createHarness();
			const olderAttach = broker.beginDaemonAttach("ws", "s1");
			const newerAttach = broker.beginDaemonAttach("ws", "s1");
			expect(olderAttach.kind).toBe("proceed");
			expect(newerAttach.kind).toBe("proceed");
			if (olderAttach.kind !== "proceed" || newerAttach.kind !== "proceed") {
				return;
			}
			const olderCommit = broker.commitDaemonRuntime(olderAttach.claim, "ws", "s1");
			const newerCommit = broker.commitDaemonRuntime(newerAttach.claim, "ws", "s1");
			expect(olderCommit.ok).toBe(true);
			expect(newerCommit.ok).toBe(true);
			if (!olderCommit.ok || !newerCommit.ok) {
				return;
			}

			const first = rollbackOrder === "older-first" ? olderCommit.token : newerCommit.token;
			const last = rollbackOrder === "older-first" ? newerCommit.token : olderCommit.token;
			expect(broker.rollbackDaemonRuntimeCommit(first)).toBe(false);
			expect(broker.rollbackDaemonRuntimeCommit(last)).toBe(true);
			expect(broker.lookup("ws", "s1")).toBeUndefined();
		},
	);

	it("restores an existing daemon-active base when every co-attach fails", () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		const olderAttach = broker.beginDaemonAttach("ws", "s1");
		const newerAttach = broker.beginDaemonAttach("ws", "s1");
		expect(olderAttach.kind).toBe("proceed");
		expect(newerAttach.kind).toBe("proceed");
		if (olderAttach.kind !== "proceed" || newerAttach.kind !== "proceed") {
			return;
		}
		const owner = getDaemonRuntimeOwner(broker, "ws", "s1");
		const olderCommit = broker.commitDaemonRuntime(olderAttach.claim, "ws", "s1", owner);
		const newerCommit = broker.commitDaemonRuntime(newerAttach.claim, "ws", "s1", owner);
		expect(olderCommit.ok).toBe(true);
		expect(newerCommit.ok).toBe(true);
		if (!olderCommit.ok || !newerCommit.ok) {
			return;
		}

		expect(broker.rollbackDaemonRuntimeCommit(newerCommit.token)).toBe(false);
		expect(broker.rollbackDaemonRuntimeCommit(olderCommit.token)).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("restores daemon ownership from the live stream count when the stable base changes mid-commit", () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1", getDaemonRuntimeOwner(broker, "ws", "s1"));
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		// The pre-existing stream closes while this co-attach is provisional.
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		expect(broker.rollbackDaemonRuntimeCommit(committed.token)).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		expect(broker.lookup("ws", "s1")?.streamCount).toBe(0);
	});

	it("fences a noncurrent commit cohort so it cannot revive after a session-key ABA", () => {
		const { broker } = createHarness();
		const owner = attachDaemonRuntime(broker, "ws", "old");
		const begun = broker.beginDaemonAttach("ws", "old");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "old", owner);
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		expect(broker.rekeyDaemonRuntime(owner, "ws", "old", "new")).toEqual({ ok: true });
		rememberDaemonRuntimeOwner(broker, "ws", "new", owner);
		const staleFinalization = broker.finalizeDaemonRuntimeCommit(committed.token);
		expect(staleFinalization).toMatchObject({
			kind: "fenced",
			lease: { kind: "rekeyed", state: "daemon-active", sessionId: "new" },
		});
		if (staleFinalization.kind !== "fenced") return;
		expect(staleFinalization.generation.expected).toBeTypeOf("number");
		expect(staleFinalization.generation.current).toBe((staleFinalization.generation.expected ?? 0) + 1);
		expect(broker.rekeyDaemonRuntime(owner, "ws", "new", "old")).toEqual({ ok: true });
		rememberDaemonRuntimeOwner(broker, "ws", "old", owner);

		const freshAttach = broker.beginDaemonAttach("ws", "old");
		expect(freshAttach.kind).toBe("proceed");
		if (freshAttach.kind !== "proceed") {
			return;
		}
		const freshCommit = broker.commitDaemonRuntime(freshAttach.claim, "ws", "old", owner);
		expect(freshCommit.ok).toBe(true);
		if (!freshCommit.ok) {
			return;
		}
		expect(broker.rollbackDaemonRuntimeCommit(freshCommit.token)).toBe(true);
		expect(broker.lookup("ws", "old")?.state).toBe("daemon-active");
	});

	it("fences a disposed runtime cohort even when another attach claim pins its record", () => {
		const { broker } = createHarness();
		const staleAttach = broker.beginDaemonAttach("ws", "s1");
		const pinningAttach = broker.beginDaemonAttach("ws", "s1");
		expect(staleAttach.kind).toBe("proceed");
		expect(pinningAttach.kind).toBe("proceed");
		if (staleAttach.kind !== "proceed" || pinningAttach.kind !== "proceed") {
			return;
		}
		const staleCommit = broker.commitDaemonRuntime(staleAttach.claim, "ws", "s1");
		expect(staleCommit.ok).toBe(true);
		if (!staleCommit.ok) {
			return;
		}

		expect(broker.onDaemonRuntimeDisposed(staleCommit.owner, "ws", "s1", "runtime_replaced")).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("unowned");
		const freshAttach = broker.beginDaemonAttach("ws", "s1");
		expect(freshAttach.kind).toBe("proceed");
		if (freshAttach.kind !== "proceed") {
			return;
		}
		const freshCommit = broker.commitDaemonRuntime(freshAttach.claim, "ws", "s1");
		expect(freshCommit.ok).toBe(true);
		if (!freshCommit.ok) {
			return;
		}

		expect(broker.rollbackDaemonRuntimeCommit(freshCommit.token)).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("unowned");
		expect(broker.finalizeDaemonRuntimeCommit(staleCommit.token)).toMatchObject({
			kind: "fenced",
			lease: { kind: "exact", state: "unowned" },
		});
		broker.abortDaemonAttach(pinningAttach.claim);
		expect(broker.lookup("ws", "s1")).toBeUndefined();
	});

	it("waits for a busy daemon publication before beginning a TUI drain", async () => {
		const { broker, effects } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		effects.streaming.add("ws/s1");
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1", getDaemonRuntimeOwner(broker, "ws", "s1"));
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		let acquireSettled = false;
		const acquirePromise = broker
			.acquireForTui({
				connectionId: "c-1",
				workspaceName: "ws",
				sessionId: "s1",
			})
			.then((outcome) => {
				acquireSettled = true;
				return outcome;
			});
		await new Promise((resolve) => setImmediate(resolve));
		expect(acquireSettled).toBe(false);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.drainStarted).toEqual([]);

		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({
			kind: "finalized",
			owner: committed.owner,
		});
		const acquire = await acquirePromise;
		expect(acquire.kind).toBe("pending");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		expect(broker.isDaemonRuntimeOwnerCurrent(committed.owner, "ws", "s1")).toBe(true);
		expect(broker.releaseFromTui("c-1", "ws", "s1")).toEqual({ ok: true });
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("does not dispose an idle runtime before its provisional publication settles", async () => {
		const { broker, effects } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		let acquireSettled = false;
		const acquirePromise = broker
			.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" })
			.then((outcome) => {
				acquireSettled = true;
				return outcome;
			});
		await new Promise((resolve) => setImmediate(resolve));
		expect(acquireSettled).toBe(false);
		expect(effects.closedStreams).toEqual([]);
		expect(effects.disposed).toEqual([]);

		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({ kind: "finalized" });
		await expect(acquirePromise).resolves.toEqual({ kind: "granted", handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.closedStreams).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
		expect(effects.disposed).toEqual([{ key: "ws/s1", reason: "lease_transferred_to_tui" }]);
	});

	it("grants an unowned TUI lease only after every provisional co-attach rolls back", async () => {
		const { broker, effects } = createHarness();
		const firstAttach = broker.beginDaemonAttach("ws", "s1");
		const secondAttach = broker.beginDaemonAttach("ws", "s1");
		expect(firstAttach.kind).toBe("proceed");
		expect(secondAttach.kind).toBe("proceed");
		if (firstAttach.kind !== "proceed" || secondAttach.kind !== "proceed") {
			return;
		}
		const firstCommit = broker.commitDaemonRuntime(firstAttach.claim, "ws", "s1");
		const secondCommit = broker.commitDaemonRuntime(secondAttach.claim, "ws", "s1");
		expect(firstCommit.ok).toBe(true);
		expect(secondCommit.ok).toBe(true);
		if (!firstCommit.ok || !secondCommit.ok) {
			return;
		}

		let acquireSettled = false;
		const acquirePromise = broker
			.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" })
			.then((outcome) => {
				acquireSettled = true;
				return outcome;
			});
		await new Promise((resolve) => setImmediate(resolve));
		expect(acquireSettled).toBe(false);
		expect(broker.rollbackDaemonRuntimeCommit(firstCommit.token)).toBe(false);
		await new Promise((resolve) => setImmediate(resolve));
		expect(acquireSettled).toBe(false);

		expect(broker.rollbackDaemonRuntimeCommit(secondCommit.token)).toBe(true);
		await expect(acquirePromise).resolves.toEqual({ kind: "granted", handoff: "none" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.closedStreams).toEqual([]);
		expect(effects.disposed).toEqual([]);
	});

	it("cancels a TUI acquire waiting for publication when its connection dies", async () => {
		const { broker, effects } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		const acquirePromise = broker.acquireForTui({
			connectionId: "c-1",
			workspaceName: "ws",
			sessionId: "s1",
		});
		await new Promise((resolve) => setImmediate(resolve));
		broker.releaseAllForConnection("c-1");
		await expect(acquirePromise).resolves.toEqual({ kind: "denied", reason: "draining_elsewhere" });

		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({ kind: "finalized" });
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.closedStreams).toEqual([]);
		expect(effects.disposed).toEqual([]);
	});

	it("rolls back only the current daemon commit token and rejects replay", () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		expect(broker.rollbackDaemonRuntimeCommit(committed.token)).toBe(true);
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		expect(broker.rollbackDaemonRuntimeCommit(committed.token)).toBe(false);
		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({
			kind: "fenced",
			lease: { kind: "missing" },
		});
	});

	it("finalizes a daemon commit token once and fences stale settlement", () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		if (!committed.ok) {
			return;
		}

		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({ kind: "finalized" });
		expect(broker.finalizeDaemonRuntimeCommit(committed.token)).toMatchObject({ kind: "already_finalized" });
		expect(broker.rollbackDaemonRuntimeCommit(committed.token)).toBe(false);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("reports a sibling commit as already finalized after its cohort publishes", () => {
		const { broker } = createHarness();
		const firstAttach = broker.beginDaemonAttach("ws", "s1");
		const secondAttach = broker.beginDaemonAttach("ws", "s1");
		expect(firstAttach.kind).toBe("proceed");
		expect(secondAttach.kind).toBe("proceed");
		if (firstAttach.kind !== "proceed" || secondAttach.kind !== "proceed") {
			return;
		}
		const firstCommit = broker.commitDaemonRuntime(firstAttach.claim, "ws", "s1");
		const secondCommit = broker.commitDaemonRuntime(secondAttach.claim, "ws", "s1");
		expect(firstCommit.ok).toBe(true);
		expect(secondCommit.ok).toBe(true);
		if (!firstCommit.ok || !secondCommit.ok) {
			return;
		}

		expect(broker.finalizeDaemonRuntimeCommit(firstCommit.token)).toMatchObject({
			kind: "finalized",
			generation: 1,
		});
		expect(broker.finalizeDaemonRuntimeCommit(secondCommit.token)).toMatchObject({
			kind: "already_finalized",
			generation: 1,
		});
	});

	it("shares one durable owner across co-attaches and existing-runtime reattach", () => {
		const { broker } = createHarness();
		const firstAttach = broker.beginDaemonAttach("ws", "s1");
		const secondAttach = broker.beginDaemonAttach("ws", "s1");
		expect(firstAttach.kind).toBe("proceed");
		expect(secondAttach.kind).toBe("proceed");
		if (firstAttach.kind !== "proceed" || secondAttach.kind !== "proceed") {
			return;
		}
		const firstCommit = broker.commitDaemonRuntime(firstAttach.claim, "ws", "s1");
		const secondCommit = broker.commitDaemonRuntime(secondAttach.claim, "ws", "s1");
		expect(firstCommit.ok).toBe(true);
		expect(secondCommit.ok).toBe(true);
		if (!firstCommit.ok || !secondCommit.ok) {
			return;
		}
		expect(secondCommit.owner).toBe(firstCommit.owner);

		const finalized = broker.finalizeDaemonRuntimeCommit(firstCommit.token);
		expect(finalized).toMatchObject({ kind: "finalized", owner: firstCommit.owner });
		expect(broker.finalizeDaemonRuntimeCommit(secondCommit.token)).toMatchObject({
			kind: "already_finalized",
			owner: firstCommit.owner,
		});

		const reattach = broker.beginDaemonAttach("ws", "s1");
		expect(reattach.kind).toBe("proceed");
		if (reattach.kind !== "proceed") {
			return;
		}
		const reattachCommit = broker.commitDaemonRuntime(reattach.claim, "ws", "s1", firstCommit.owner);
		expect(reattachCommit).toMatchObject({ ok: true, owner: firstCommit.owner });
		if (!reattachCommit.ok) {
			return;
		}
		expect(broker.finalizeDaemonRuntimeCommit(reattachCommit.token)).toMatchObject({
			kind: "finalized",
			owner: firstCommit.owner,
		});
	});

	it("rejects stale same-key stream and disposal callbacks after runtime replacement", () => {
		const { broker } = createHarness();
		const staleOwner = attachDaemonRuntime(broker, "ws", "s1");
		expect(broker.onDaemonRuntimeStreamCountChanged(staleOwner, "ws", "s1", 1)).toBe(true);

		const replacementAttach = broker.beginDaemonAttach("ws", "s1");
		expect(replacementAttach.kind).toBe("proceed");
		if (replacementAttach.kind !== "proceed") {
			return;
		}
		const replacementCommit = broker.commitDaemonRuntime(replacementAttach.claim, "ws", "s1");
		expect(replacementCommit.ok).toBe(true);
		if (!replacementCommit.ok) {
			return;
		}
		const replacementFinalize = broker.finalizeDaemonRuntimeCommit(replacementCommit.token);
		expect(replacementFinalize).toMatchObject({ kind: "finalized", owner: replacementCommit.owner });
		expect(replacementCommit.owner).not.toBe(staleOwner);

		// The old runtime detaches and disposes after the replacement owns the same
		// key. Neither callback may mutate or drop the replacement's lease record.
		expect(broker.onDaemonRuntimeStreamCountChanged(staleOwner, "ws", "s1", 0)).toBe(false);
		expect(broker.onDaemonRuntimeDisposed(staleOwner, "ws", "s1", "runtime_replaced")).toBe(false);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "s1")?.streamCount).toBe(1);
		const staleReattach = broker.beginDaemonAttach("ws", "s1");
		expect(staleReattach.kind).toBe("proceed");
		if (staleReattach.kind !== "proceed") {
			return;
		}
		expect(broker.commitDaemonRuntime(staleReattach.claim, "ws", "s1", staleOwner)).toEqual({
			ok: false,
			reason: "runtime_owner_fenced",
		});

		expect(broker.onDaemonRuntimeStreamCountChanged(replacementCommit.owner, "ws", "s1", 0)).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		expect(broker.onDaemonRuntimeDisposed(replacementCommit.owner, "ws", "s1", "detached_runtime_ttl_expired")).toBe(
			true,
		);
		expect(broker.lookup("ws", "s1")).toBeUndefined();
	});

	it("keeps the durable owner capability continuous through daemon rekey", () => {
		const { broker } = createHarness();
		const owner = attachDaemonRuntime(broker, "ws", "old");
		expect(broker.onDaemonRuntimeStreamCountChanged(owner, "ws", "old", 1)).toBe(true);
		const prepared = broker.prepareDaemonRekey(owner, "ws", "old", "new");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) {
			return;
		}
		expect(broker.commitDaemonRekey(prepared.reservation.id)).toMatchObject({ ok: true });

		expect(broker.isDaemonRuntimeOwnerCurrent(owner, "ws", "old")).toBe(false);
		expect(broker.isDaemonRuntimeOwnerCurrent(owner, "ws", "new")).toBe(true);
		expect(broker.onDaemonRuntimeStreamCountChanged(owner, "ws", "old", 0)).toBe(false);
		expect(broker.onDaemonRuntimeDisposed(owner, "ws", "old", "stale_old_key")).toBe(false);
		expect(broker.onDaemonRuntimeStreamCountChanged(owner, "ws", "new", 0)).toBe(true);
		expect(broker.lookup("ws", "new")?.state).toBe("daemon-detached");
	});

	it("tracks daemon runtime attach/stream-count/dispose transitions", () => {
		const { broker, effects } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 2);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		// Retention TTL fired in the registry: disposal reason maps to retention_expired.
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		disposeDaemonRuntime(broker, "ws", "s1", "detached_runtime_ttl_expired");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		const release = effects.audits.find((event) => event.type === "lease_released");
		expect(release?.details.reason).toBe("retention_expired");
	});

	it("grants warm immediately for an idle daemon runtime and disposes it", async () => {
		const { broker, effects } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
		expect(effects.closedStreams).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
	});

	it("delivers lease-transfer stream terminals before disposing the runtime feed", async () => {
		const effectsOrder: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			closePhoneStreams: async () => {
				effectsOrder.push("close-streams");
			},
			disposeRuntime: async () => {
				effectsOrder.push("dispose-runtime");
			},
			closeRelays: () => {},
			audit: () => {},
		});
		attachDaemonRuntime(broker, "ws", "s1");

		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(effectsOrder).toEqual(["close-streams", "dispose-runtime"]);
	});

	it("grants warm for a detached daemon runtime", async () => {
		const { broker, effects } = createHarness();
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(effects.disposed).toHaveLength(1);
	});

	it("drains a detached mid-turn daemon runtime instead of abandoning the turn", async () => {
		// Regression: a TUI acquire while every phone was detached used to
		// dispose the runtime mid-turn, discarding in-flight (e.g. subagent)
		// results and leaving a dangling tool call in the transcript.
		const harness = createHarness();
		const { broker, effects } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		expect(effects.disposed).toHaveLength(0);

		await harness.finishTurn("ws", "s1");
		await expect(outcome.granted).resolves.toEqual({ handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
	});

	it("returns a cancelled detached drain to daemon-detached with the turn still running", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const released = broker.releaseFromTui("c-1", "ws", "s1");
		expect(released).toEqual({ ok: true });
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		// The runtime was never disposed: the turn keeps running on the daemon.
		expect(effects.disposed).toHaveLength(0);
	});

	it("drains a mid-turn daemon runtime before granting", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		expect(outcome.viewerFeedId).toBe("vf-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		expect(broker.isDraining("ws", "s1")).toBe(true);
		expect(effects.drainStarted).toEqual(["vf-1"]);
		expect(effects.disposed).toHaveLength(0);

		// Same connection re-acquire is idempotent (same pending drain).
		const again = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(again.kind).toBe("pending");
		if (again.kind === "pending") {
			expect(again.viewerFeedId).toBe("vf-1");
		}
		// A different TUI is denied while the drain is pending.
		const other = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(other).toEqual({ kind: "denied", reason: "draining_elsewhere" });

		await harness.finishTurn("ws", "s1");
		await expect(outcome.granted).resolves.toEqual({ handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
		expect(effects.closedStreams).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
		expect(effects.drainEnded).toEqual([{ key: "ws/s1", reason: "granted" }]);
	});

	it("stays draining when the last phone stream detaches mid-drain", async () => {
		const harness = createHarness();
		const { broker } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		harness.effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		await harness.finishTurn("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("cancels the drain when the requesting connection dies", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.drainEnded).toEqual([{ key: "ws/s1", reason: "cancelled" }]);
		expect(effects.handoffs).toEqual([
			{ phase: "begin", key: "ws/s1", connectionId: "c-1" },
			{ phase: "cancel", key: "ws/s1", connectionId: "c-1" },
		]);

		// The turn ending later must NOT grant anything.
		await harness.finishTurn("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.disposed).toHaveLength(0);
		expect(grantedRejected).toHaveBeenCalled();
	});

	it("cancels pending coordinator authority when waiting for runtime idle fails", async () => {
		const handoffs: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => true,
			waitForRuntimeIdle: async () => {
				throw new Error("runtime idle wait failed");
			},
			disposeRuntime: async () => {},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			beginTuiLeaseHandoff: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`begin:${connectionId}`);
			},
			cancelTuiLeaseHandoff: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`cancel:${connectionId}`);
			},
			audit: () => {},
		});
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);

		const outcome = await broker.acquireForTui({
			connectionId: "c-1",
			workspaceName: "ws",
			sessionId: "s1",
		});
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") return;
		await expect(outcome.granted).rejects.toThrow("runtime idle wait failed");

		expect(handoffs).toEqual(["begin:c-1", "cancel:c-1"]);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "s1")?.tuiConnectionId).toBeUndefined();
	});

	it("reverts to daemon-detached when a cancelled drain had zero streams", async () => {
		const harness = createHarness();
		const { broker } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		harness.effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0);
		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
	});

	it("retires workspace-unregistered TUI leases and all relays with the terminal reason", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.registerRelay("ws", "s1", "rl-1");
		broker.registerRelay("ws", "s1", "rl-2");
		const released = broker.releaseFromTui("c-1", "ws", "s1", "workspace_unregistered");
		expect(released).toEqual({ ok: true });
		expect(effects.closedRelays).toEqual([{ key: "ws/s1", reason: "workspace_unregistered" }]);
		expect(effects.handoffs.at(-1)).toEqual({ phase: "release", key: "ws/s1", connectionId: "c-1" });
		expect(effects.audits.at(-1)?.details.reason).toBe("workspace_unregistered");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
	});

	it("rejects lease_release for keys the connection does not hold", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(broker.releaseFromTui("c-2", "ws", "s1")).toEqual({ ok: false, code: "not_held" });
		expect(broker.releaseFromTui("c-1", "ws", "other")).toEqual({ ok: false, code: "not_held" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("implicitly releases all leases when a connection dies", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s2" });
		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		expect(broker.lookup("ws", "s2")).toBeUndefined();
		const reasons = effects.audits
			.filter((event) => event.type === "lease_released")
			.map((event) => event.details.reason);
		expect(reasons).toEqual(["connection_lost", "connection_lost"]);
	});

	it("reserves then atomically rekeys a TUI lease and closes its relays", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		broker.registerRelay("ws", "old", "rl-1");
		const prepared = broker.prepareTuiRekey("ws", "old", "new", "c-1");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(broker.lookup("ws", "new")).toBeUndefined();
		expect(broker.beginDaemonAttach("ws", "old")).toMatchObject({ kind: "retry" });
		expect(broker.beginDaemonAttach("ws", "new")).toMatchObject({ kind: "retry" });
		expect(() => attachDaemonRuntime(broker, "ws", "new")).toThrow(/lease rekey reserves/);
		expect(await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "new" })).toMatchObject({
			kind: "denied",
		});

		expect(broker.commitTuiRekey(prepared.reservation.id, "c-1")).toMatchObject({ ok: true });
		expect(broker.lookup("ws", "old")).toBeUndefined();
		expect(broker.lookup("ws", "new")?.state).toBe("tui-owned");
		expect(effects.handoffs.slice(-2)).toEqual([
			{
				phase: "prepare_rekey",
				key: "ws/old",
				newKey: "ws/new",
				connectionId: "c-1",
			},
			{
				phase: "commit_rekey",
				key: "ws/old",
				newKey: "ws/new",
				connectionId: "c-1",
			},
		]);
		expect(effects.closedRelays).toEqual([{ key: "ws/old", reason: "session_rekeyed_reconnect" }]);
		expect(broker.commitTuiRekey(prepared.reservation.id, "c-1")).toEqual({ ok: false, code: "not_found" });
	});

	it("rolls back both rekey reservations when coordinator commit fails", async () => {
		const authorityEvents: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime: async () => {},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			prepareTuiLeaseRekey: (transactionId) => {
				authorityEvents.push(`prepare:${transactionId}`);
			},
			commitTuiLeaseRekey: (transactionId) => {
				authorityEvents.push(`commit:${transactionId}`);
				throw new Error("coordinator target changed");
			},
			rollbackTuiLeaseRekey: (transactionId) => {
				authorityEvents.push(`rollback:${transactionId}`);
			},
			audit: () => {},
		});
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		const prepared = broker.prepareTuiRekey("ws", "old", "new", "c-1");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		expect(broker.commitTuiRekey(prepared.reservation.id, "c-1")).toEqual({
			ok: false,
			code: "authority_commit_failed",
		});
		expect(authorityEvents).toEqual([
			`prepare:${prepared.reservation.id}`,
			`commit:${prepared.reservation.id}`,
			`rollback:${prepared.reservation.id}`,
		]);
		expect(broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(broker.lookup("ws", "new")).toBeUndefined();
		expect(broker.commitTuiRekey(prepared.reservation.id, "c-1")).toEqual({ ok: false, code: "not_found" });
	});

	it("rejects unauthorized or colliding TUI rekey preflights without moving either lease", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "occupied" });

		expect(broker.prepareTuiRekey("ws", "old", "new", "c-2")).toEqual({ ok: false, code: "not_held" });
		expect(broker.prepareTuiRekey("ws", "old", "occupied", "c-1")).toEqual({
			ok: false,
			code: "target_in_use",
		});
		expect(broker.lookup("ws", "old")?.tuiConnectionId).toBe("c-1");
		expect(broker.lookup("ws", "occupied")?.tuiConnectionId).toBe("c-1");
		expect(broker.lookup("ws", "new")).toBeUndefined();
	});

	it("rolls back a prepared rekey or disposes its source without leaking the target reservation", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });

		const rolledBack = broker.prepareTuiRekey("ws", "old", "new", "c-1");
		expect(rolledBack.ok).toBe(true);
		if (!rolledBack.ok) return;
		expect(broker.rollbackTuiRekey(rolledBack.reservation.id, "c-1")).toMatchObject({ ok: true });
		expect(broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "new" })).toMatchObject({
			kind: "granted",
		});
		broker.releaseFromTui("c-2", "ws", "new");

		const disposed = broker.prepareTuiRekey("ws", "old", "new", "c-1");
		expect(disposed.ok).toBe(true);
		if (!disposed.ok) return;
		expect(broker.disposeTuiRekey(disposed.reservation.id, "c-1")).toMatchObject({ ok: true });
		expect(broker.lookup("ws", "old")).toBeUndefined();
		expect(broker.lookup("ws", "new")).toBeUndefined();
	});

	it("clears a prepared target and its source lease when the owning connection dies", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		expect(broker.prepareTuiRekey("ws", "old", "new", "c-1").ok).toBe(true);

		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "old")).toBeUndefined();
		expect(await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "new" })).toMatchObject({
			kind: "granted",
		});
	});

	it("rekeys daemon leases keeping state", () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "old");
		updateDaemonRuntimeStreamCount(broker, "ws", "old", 1);
		const owner = getDaemonRuntimeOwner(broker, "ws", "old");
		expect(broker.rekeyDaemonRuntime(owner, "ws", "old", "new")).toEqual({ ok: true });
		rememberDaemonRuntimeOwner(broker, "ws", "new", owner);
		expect(broker.lookup("ws", "new")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "new")?.streamCount).toBe(1);
	});

	it("reserves both daemon lease keys until a daemon rekey commits", async () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "old");
		updateDaemonRuntimeStreamCount(broker, "ws", "old", 1);
		const prepared = broker.prepareDaemonRekey(getDaemonRuntimeOwner(broker, "ws", "old"), "ws", "old", "new");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		expect(broker.beginDaemonAttach("ws", "old")).toMatchObject({ kind: "retry" });
		expect(broker.beginDaemonAttach("ws", "new")).toMatchObject({ kind: "retry" });
		expect(await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" })).toMatchObject({
			kind: "denied",
		});
		expect(await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "new" })).toMatchObject({
			kind: "denied",
		});

		expect(broker.commitDaemonRekey(prepared.reservation.id)).toMatchObject({ ok: true });
		expect(broker.lookup("ws", "old")).toBeUndefined();
		expect(broker.lookup("ws", "new")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "new")?.streamCount).toBe(1);
	});

	it("rejects a daemon attach that began before the source rekey reservation", () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "old");
		const begun = broker.beginDaemonAttach("ws", "old");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		const prepared = broker.prepareDaemonRekey(getDaemonRuntimeOwner(broker, "ws", "old"), "ws", "old", "new");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		expect(broker.commitDaemonRuntime(begun.claim, "ws", "old")).toEqual({ ok: false, reason: "draining" });
		expect(broker.lookup("ws", "old")?.pendingDaemonAttaches).toBe(0);
		expect(broker.rollbackDaemonRekey(prepared.reservation.id)).toMatchObject({ ok: true });
	});

	it("rejects a relay that reaches registration after its source rekey reservation", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		const prepared = broker.prepareTuiRekey("ws", "old", "new", "c-1");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		expect(broker.registerRelay("ws", "old", "late-relay")).toBe(false);
		expect(broker.lookup("ws", "old")?.relayIds.size).toBe(0);
		expect(broker.rollbackTuiRekey(prepared.reservation.id, "c-1")).toMatchObject({ ok: true });
	});

	it("rolls back daemon target reservations without disturbing either owner", () => {
		const { broker } = createHarness();
		attachDaemonRuntime(broker, "ws", "old");
		attachDaemonRuntime(broker, "ws", "occupied");
		expect(broker.prepareDaemonRekey(getDaemonRuntimeOwner(broker, "ws", "old"), "ws", "old", "occupied")).toEqual({
			ok: false,
			code: "target_in_use",
		});
		const prepared = broker.prepareDaemonRekey(getDaemonRuntimeOwner(broker, "ws", "old"), "ws", "old", "new");
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(broker.rollbackDaemonRekey(prepared.reservation.id)).toMatchObject({ ok: true });
		expect(broker.lookup("ws", "old")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "occupied")?.state).toBe("daemon-active");
		expect(() => attachDaemonRuntime(broker, "ws", "new")).not.toThrow();
	});

	it("settles an attach claim against the same record after that record is rekeyed", () => {
		const { broker } = createHarness();
		const owner = attachDaemonRuntime(broker, "ws", "old");
		const begun = broker.beginDaemonAttach("ws", "old");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		expect(broker.lookup("ws", "old")?.pendingDaemonAttaches).toBe(1);

		expect(broker.rekeyDaemonRuntime(owner, "ws", "old", "new")).toEqual({ ok: true });
		broker.abortDaemonAttach(begun.claim);
		expect(broker.lookup("ws", "new")?.pendingDaemonAttaches).toBe(0);
		expect(broker.lookup("ws", "new")?.state).toBe("daemon-active");
	});

	it("routes a phone attach after TUI release through unowned (lazy resume)", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.releaseFromTui("c-1", "ws", "s1");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		// Next conversation-stream arrival finds unowned and lazily resumes.
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("returns the lease to unowned when the connection dies during drain disposal", async () => {
		// Regression: cancellation used to no-op once runDrain cleared record.drain
		// before its disposal awaits, leaving the lease permanently tui-owned by a
		// dead connection.
		const streaming = new Set<string>(["s1"]);
		let releaseIdle: () => void = () => {};
		let releaseDispose: () => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const drainEnded: string[] = [];
		const audits: string[] = [];
		const handoffs: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => streaming.has("s1"),
			waitForRuntimeIdle: () =>
				new Promise((resolve) => {
					releaseIdle = resolve;
				}),
			disposeRuntime: async () => {
				disposeEntered();
				await new Promise<void>((resolve) => {
					releaseDispose = resolve;
				});
			},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			beginTuiLeaseHandoff: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`begin:${connectionId}`);
			},
			releaseTuiLease: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`release:${connectionId}`);
			},
			onDrainEnded: (_record, _viewerFeedId, reason) => {
				drainEnded.push(reason);
			},
			audit: (event) => {
				audits.push(event.type);
			},
		});
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		// The turn ends; runDrain passes its cancelled-check and enters disposal.
		streaming.delete("s1");
		releaseIdle();
		await disposeEnteredPromise;

		// The requesting TUI's control connection dies mid-disposal.
		broker.releaseAllForConnection("c-1");
		expect(drainEnded).toEqual(["cancelled"]);
		expect(handoffs).toEqual(["begin:c-1"]);

		// Disposal completes: the lease must NOT be granted to the dead owner.
		releaseDispose();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(grantedRejected).toHaveBeenCalled();
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		expect(audits.at(-1)).toBe("lease_released");
		expect(handoffs).toEqual(["begin:c-1", "release:c-1"]);

		// The conversation is acquirable again.
		const again = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(again).toEqual({ kind: "granted", handoff: "none" });
	});

	it("drops the lease when a cancelled drain then fails disposal", async () => {
		// Regression: the cancelled + disposal-error branch of runDrain set the state
		// to "unowned" but did not zero record.streamCount, so dropIfUnowned (which
		// requires streamCount === 0) left an undroppable ghost record that handed a
		// phantom stream count to the next acquire.
		const streaming = new Set<string>(["s1"]);
		let releaseIdle: () => void = () => {};
		let rejectDispose: (error: Error) => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const drainEnded: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => streaming.has("s1"),
			waitForRuntimeIdle: () =>
				new Promise((resolve) => {
					releaseIdle = resolve;
				}),
			disposeRuntime: () =>
				new Promise<void>((_resolve, reject) => {
					disposeEntered();
					rejectDispose = reject;
				}),
			closePhoneStreams: () => {},
			closeRelays: () => {},
			onDrainEnded: (_record, _viewerFeedId, reason) => {
				drainEnded.push(reason);
			},
			audit: () => {},
		});
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1);

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		// The turn ends; runDrain passes its cancelled-check and enters disposal.
		streaming.delete("s1");
		releaseIdle();
		await disposeEnteredPromise;

		// The requesting TUI dies mid-disposal, then disposal itself fails.
		broker.releaseAllForConnection("c-1");
		rejectDispose(new Error("state-manager write failed"));
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(grantedRejected).toHaveBeenCalled();
		expect(drainEnded).toEqual(["cancelled"]);
		// The record must be dropped, not stranded as an unowned ghost with a stale
		// stream count.
		expect(broker.lookup("ws", "s1")).toBeUndefined();

		// A fresh acquire starts from a clean record (no phantom stream count).
		const again = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(again).toEqual({ kind: "granted", handoff: "none" });
		expect(broker.lookup("ws", "s1")?.streamCount).toBe(0);
	});

	it("drops the lease when the connection dies while an idle runtime is disposed during acquire", async () => {
		let releaseDispose: () => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const audits: string[] = [];
		const handoffs: string[] = [];
		const broker = new LeaseBroker({
			...NOOP_CONVERSATION_AUTHORITY_EFFECTS,
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime: async () => {
				disposeEntered();
				await new Promise<void>((resolve) => {
					releaseDispose = resolve;
				});
			},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			beginTuiLeaseHandoff: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`begin:${connectionId}`);
			},
			releaseTuiLease: (_workspaceName, _sessionId, connectionId) => {
				handoffs.push(`release:${connectionId}`);
			},
			audit: (event) => {
				audits.push(event.type);
			},
		});
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0); // daemon-detached

		const acquire = broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		await disposeEnteredPromise;
		broker.releaseAllForConnection("c-1");
		expect(handoffs).toEqual(["begin:c-1", "release:c-1"]);
		releaseDispose();

		const outcome = await acquire;
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		// No lease_acquired must be recorded for the dead connection after the
		// implicit release.
		expect(audits.at(-1)).toBe("lease_released");
		expect(handoffs).toEqual(["begin:c-1", "release:c-1"]);
	});

	it("does not wedge the lease when drain disposal fails", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 1); // daemon-active
		effects.streaming.add(key("ws", "s1"));

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		let grantSettled: "resolved" | "rejected" | undefined;
		void outcome.granted.then(
			() => {
				grantSettled = "resolved";
			},
			() => {
				grantSettled = "rejected";
			},
		);

		harness.failNextDispose(new Error("state-manager write failed"));
		await harness.finishTurn("ws", "s1");

		// The grant promise must settle (rejected) rather than hang forever, and the
		// lease must not be stuck in daemon-draining.
		expect(grantSettled).toBe("rejected");
		const record = broker.lookup("ws", "s1");
		expect(record?.state).not.toBe("daemon-draining");
		expect(record?.drain).toBeUndefined();
		expect(effects.drainEnded.at(-1)?.reason).toBe("error");
	});

	it("reverts to daemon-owned when an idle-grant disposal fails", async () => {
		const harness = createHarness();
		const { broker } = harness;
		attachDaemonRuntime(broker, "ws", "s1");
		updateDaemonRuntimeStreamCount(broker, "ws", "s1", 0); // daemon-detached, idle

		harness.failNextDispose(new Error("state-manager write failed"));
		await expect(broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" })).rejects.toThrow(
			"state-manager write failed",
		);

		// The premature tui-owned flip must not survive the disposal failure.
		const record = broker.lookup("ws", "s1");
		expect(record?.state).not.toBe("tui-owned");
		expect(record?.tuiConnectionId).toBeUndefined();
	});
});
