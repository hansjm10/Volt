/**
 * §12.3.2 turn-boundary handoff + §12.3.6 reconnect/re-acquire, exercised
 * through the real control plane: startControlServer + LeaseBroker +
 * ViewerFeedRegistry on the daemon side (request routing mirrors
 * iroh-service), createDaemonAttach on the TUI side. The runtime/session is a
 * double with a controllable turn.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlEvent, ControlRequest } from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { ViewerFeedRegistry } from "../src/daemon/viewer-feed.ts";
import { type AcquireOutcome, createDaemonAttach, type DaemonAttach } from "../src/modes/interactive/daemon-attach.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function publishDaemonRuntime(broker: LeaseBroker, workspaceName: string, sessionId: string) {
	const begun = broker.beginDaemonAttach(workspaceName, sessionId);
	if (begun.kind !== "proceed") throw new Error(`daemon attach did not proceed: ${begun.kind}`);
	const committed = broker.commitDaemonRuntime(begun.claim, workspaceName, sessionId);
	if (!committed.ok) throw new Error(`daemon runtime commit failed: ${committed.reason}`);
	const finalized = broker.finalizeDaemonRuntimeCommit(committed.token);
	if (finalized.kind === "fenced") throw new Error("daemon runtime publication was fenced");
	return finalized.owner;
}

function createDrainableSession() {
	const handlers = new Set<(event: unknown) => void>();
	let idle = deferred();
	const abort = vi.fn(async () => {
		idle.resolve();
	});
	return {
		isStreaming: false,
		abort,
		subscribe(handler: (event: unknown) => void) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		emit(event: unknown) {
			for (const handler of Array.from(handlers)) {
				handler(event);
			}
		},
		waitForIdle(): Promise<void> {
			return this.isStreaming ? idle.promise : Promise.resolve();
		},
		endTurn() {
			this.isStreaming = false;
			idle.resolve();
			idle = deferred();
		},
	};
}

interface DaemonHalf {
	server: ControlServer;
	broker: LeaseBroker;
	session: ReturnType<typeof createDrainableSession>;
	disposed: Array<{ reason: string }>;
	closedStreams: Array<{ reason: string }>;
	workspaces: Array<{ name: string; path: string }>;
	close(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

/**
 * Daemon-side half: routes control requests to the broker/feeds exactly like
 * iroh-service.handleRequest does. `warmOnAcquire` simulates a daemon that
 * owned an idle runtime in a reconnect gap (immediate warm grant).
 */
async function startDaemonHalf(
	socketPath: string,
	options: { authToken?: string; workspaces?: Array<{ name: string; path: string }> } = {},
): Promise<DaemonHalf> {
	const session = createDrainableSession();
	const disposed: Array<{ reason: string }> = [];
	const closedStreams: Array<{ reason: string }> = [];
	const workspaces = [...(options.workspaces ?? [])];
	let server: ControlServer | undefined;
	const feeds = new ViewerFeedRegistry({
		sendTo: (connectionId, event) => server?.sendTo(connectionId, event) ?? false,
	});
	const broker = new LeaseBroker({
		isRuntimeStreaming: () => session.isStreaming,
		waitForRuntimeIdle: () => session.waitForIdle(),
		disposeRuntime: async (_ws, _sid, reason) => {
			disposed.push({ reason });
		},
		closePhoneStreams: (_ws, _sid, reason) => {
			closedStreams.push({ reason });
		},
		closeRelays: () => {},
		beginTuiLeaseHandoff: () => {},
		commitTuiLeaseHandoff: () => {},
		cancelTuiLeaseHandoff: () => {},
		releaseTuiLease: () => {},
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
		onDrainStarted: (record, viewerFeedId) => {
			if (record.tuiConnectionId) {
				feeds.start(viewerFeedId, record.tuiConnectionId, session);
			}
		},
		onDrainEnded: (_record, viewerFeedId, reason) => {
			feeds.end(viewerFeedId, reason);
		},
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
					phoneConnections: 0,
					workspaces,
					clients: [],
					keepAwake: { enabled: false, state: "disabled" },
				});
				return;
			case "workspace_register":
				workspaces.push({ name: request.name, path: request.path });
				connection.send({ type: "ok", id: request.id });
				return;
			case "lease_acquire": {
				const outcome = await broker.acquireForTui({
					connectionId: connection.connectionId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					force: request.force,
				});
				if (outcome.kind === "granted") {
					connection.send({
						type: "lease_granted",
						id: request.id,
						workspaceName: request.workspaceName,
						sessionId: request.sessionId,
						handoff: outcome.handoff,
					});
					return;
				}
				if (outcome.kind === "denied") {
					connection.send({ type: "lease_denied", id: request.id, reason: outcome.reason });
					return;
				}
				connection.send({ type: "lease_pending", id: request.id, viewerFeedId: outcome.viewerFeedId });
				outcome.granted.then(
					(granted) => {
						connection.send({
							type: "lease_granted",
							id: request.id,
							workspaceName: request.workspaceName,
							sessionId: request.sessionId,
							handoff: granted.handoff,
						});
					},
					(error: unknown) => {
						connection.send({
							type: "error",
							id: request.id,
							code: "drain_failed",
							message: error instanceof Error ? error.message : String(error),
						});
					},
				);
				return;
			}
			case "lease_release": {
				const result = broker.releaseFromTui(
					connection.connectionId,
					request.workspaceName,
					request.sessionId,
					request.reason,
				);
				connection.send(
					result.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: result.code, message: "lease not held" },
				);
				return;
			}
			case "lease_rekey_prepare": {
				const result = broker.prepareTuiRekey(
					request.workspaceName,
					request.oldSessionId,
					request.newSessionId,
					connection.connectionId,
				);
				connection.send(
					result.ok
						? { type: "lease_rekey_prepared", id: request.id, transactionId: result.reservation.id }
						: {
								type: "error",
								id: request.id,
								code: result.code,
								message: `conversation lease rekey preflight failed: ${result.code}`,
							},
				);
				return;
			}
			case "lease_rekey_commit": {
				const result = broker.commitTuiRekey(request.transactionId, connection.connectionId);
				connection.send(
					result.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: result.code, message: "rekey commit failed" },
				);
				return;
			}
			case "lease_rekey_rollback": {
				const result = broker.rollbackTuiRekey(request.transactionId, connection.connectionId);
				connection.send(
					result.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: result.code, message: "rekey rollback failed" },
				);
				return;
			}
			case "lease_rekey_dispose": {
				const result = broker.disposeTuiRekey(request.transactionId, connection.connectionId);
				connection.send(
					result.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: result.code, message: "rekey dispose failed" },
				);
				return;
			}
			case "viewer_subscribe":
				connection.send(
					feeds.subscribe(request.viewerFeedId, connection.connectionId)
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" },
				);
				return;
			case "viewer_abort":
				connection.send(
					(await feeds.abort(request.viewerFeedId, connection.connectionId))
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: "not_found", message: "unknown viewer feed" },
				);
				return;
			default:
				connection.send({ type: "error", id: request.id, code: "unsupported", message: request.type });
		}
	};

	server = await startControlServer({
		socketPath,
		version: "0.0.0-test",
		authToken: options.authToken,
		handlers: {
			onRequest: handleRequest,
			onConnectionClosed: (connection) => broker.releaseAllForConnection(connection.connectionId),
		},
	});
	const half: DaemonHalf = {
		server,
		broker,
		session,
		disposed,
		closedStreams,
		workspaces,
		close: async () => {
			await server?.close();
		},
	};
	return half;
}

function freshControlSocketPath(paths: DaemonPaths, label: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\voltd-handoff-${label}-${randomUUID()}`;
	}
	return join(paths.daemonDir, `voltd-handoff-${label}.sock`);
}

function publishDaemonEndpoint(paths: DaemonPaths, socketPath: string, token: string): void {
	writeFileSync(
		paths.pidfilePath,
		`${JSON.stringify({ pid: process.pid, version: "0.0.0-test", startedAtMs: Date.now(), socketPath, token })}\n`,
		{ mode: 0o600 },
	);
}

async function startTuiHalf(
	agentDir: string,
	cwd: string,
): Promise<{
	attach: DaemonAttach;
	events: ControlEvent[];
	reacquired: Array<{ sessionId: string; outcome: AcquireOutcome }>;
}> {
	const events: ControlEvent[] = [];
	const reacquired: Array<{ sessionId: string; outcome: AcquireOutcome }> = [];
	const attach = createDaemonAttach({ cwd, agentDir, autoStart: false });
	attach.onEvent((event) => events.push(event));
	attach.onReacquired((sessionId, outcome) => reacquired.push({ sessionId, outcome }));
	cleanups.push(() => attach.dispose());
	await attach.start();
	return { attach, events, reacquired };
}

describe("turn-boundary handoff (§12.3.2)", () => {
	it("rejects a colliding rekey before runtime replacement and commits a reserved target", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-rekey-cleanup-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-rekey-cleanup-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const daemon = await startDaemonHalf(paths.socketPath, { workspaces: [{ name: "ws", path: cwd }] });
		cleanups.push(() => daemon.close());

		const first = await startTuiHalf(agentDir, cwd);
		const second = await startTuiHalf(agentDir, cwd);
		expect(await first.attach.acquire("old")).toMatchObject({ kind: "granted" });
		expect(await second.attach.acquire("occupied")).toMatchObject({ kind: "granted" });

		await expect(first.attach.prepareRekey("old", "occupied")).rejects.toThrow(/target_in_use/);
		expect(daemon.broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(daemon.broker.lookup("ws", "occupied")?.state).toBe("tui-owned");

		const transaction = await first.attach.prepareRekey("old", "fresh-new");
		expect(transaction).toBeDefined();
		expect(daemon.broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(await second.attach.acquire("fresh-new")).toMatchObject({ kind: "denied" });
		await transaction?.commit();
		expect(daemon.broker.lookup("ws", "old")).toBeUndefined();
		expect(daemon.broker.lookup("ws", "fresh-new")?.state).toBe("tui-owned");
	}, 20_000);

	it("commits local session tracking while disconnected and reacquires only the replacement", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-rekey-disconnected-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-rekey-disconnected-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const tui = await startTuiHalf(agentDir, cwd);
		expect(await tui.attach.acquire("old")).toEqual({ kind: "noop" });

		const transaction = await tui.attach.prepareRekey("old", "new");
		expect(transaction).toBeDefined();
		await transaction?.commit();

		const daemon = await startDaemonHalf(paths.socketPath, { workspaces: [{ name: "ws", path: cwd }] });
		cleanups.push(() => daemon.close());
		await vi.waitFor(() => {
			expect(daemon.broker.lookup("ws", "new")?.state).toBe("tui-owned");
		});
		expect(daemon.broker.lookup("ws", "old")).toBeUndefined();
	}, 20_000);

	it("advances a connected unheld attach without releasing another TUI's source lease", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-rekey-unheld-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-rekey-unheld-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const daemon = await startDaemonHalf(paths.socketPath, { workspaces: [{ name: "ws", path: cwd }] });
		cleanups.push(() => daemon.close());
		const owner = await startTuiHalf(agentDir, cwd);
		const unheld = await startTuiHalf(agentDir, cwd);
		expect(await owner.attach.acquire("old")).toMatchObject({ kind: "granted" });
		expect(await unheld.attach.acquire("old")).toMatchObject({ kind: "denied" });

		const transaction = await unheld.attach.prepareRekey("old", "new");
		expect(transaction).toBeDefined();
		await transaction?.commit();
		expect(daemon.broker.lookup("ws", "old")?.state).toBe("tui-owned");
		expect(daemon.broker.lookup("ws", "new")?.state).toBe("tui-owned");
	}, 20_000);

	it("reacquires the old lease when a prepared rekey rolls back after reconnect", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-rekey-rollback-reconnect-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-rekey-rollback-reconnect-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const first = await startDaemonHalf(paths.socketPath, { workspaces: [{ name: "ws", path: cwd }] });
		const tui = await startTuiHalf(agentDir, cwd);
		expect(await tui.attach.acquire("old")).toMatchObject({ kind: "granted" });
		const transaction = await tui.attach.prepareRekey("old", "new");
		expect(transaction).toBeDefined();

		await first.close();
		const second = await startDaemonHalf(paths.socketPath, { workspaces: [{ name: "ws", path: cwd }] });
		cleanups.push(() => second.close());
		await vi.waitFor(() => expect(tui.attach.connectionState()).toBe("connected"), { timeout: 10_000 });
		expect(second.broker.lookup("ws", "old")).toBeUndefined();

		await transaction?.rollback();
		await vi.waitFor(() => expect(second.broker.lookup("ws", "old")?.state).toBe("tui-owned"), {
			timeout: 10_000,
		});
	}, 20_000);

	it("connects every already-running TUI when a daemon appears without auto-start", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-late-daemon-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-late-daemon-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);

		const first = await startTuiHalf(agentDir, cwd);
		const second = await startTuiHalf(agentDir, cwd);
		expect(first.attach.connectionState()).toBe("reconnecting");
		expect(second.attach.connectionState()).toBe("reconnecting");
		expect(await first.attach.acquire("s-1")).toEqual({ kind: "noop" });
		expect(await second.attach.acquire("s-2")).toEqual({ kind: "noop" });

		const daemon = await startDaemonHalf(paths.socketPath, {
			workspaces: [{ name: "ws", path: cwd }],
		});
		cleanups.push(() => daemon.close());

		await vi.waitFor(
			() => {
				expect(first.reacquired.at(-1)).toMatchObject({ sessionId: "s-1", outcome: { kind: "granted" } });
				expect(second.reacquired.at(-1)).toMatchObject({ sessionId: "s-2", outcome: { kind: "granted" } });
			},
			{ timeout: 10_000 },
		);
		expect(daemon.broker.lookup("ws", "s-1")?.state).toBe("tui-owned");
		expect(daemon.broker.lookup("ws", "s-2")?.state).toBe("tui-owned");
		expect(await first.attach.listRuntimeStates("ws")).toEqual(
			new Map([
				["s-1", "tui-owned"],
				["s-2", "tui-owned"],
			]),
		);
	}, 20_000);

	it("drains a mid-turn daemon runtime to the TUI: pending, viewer feed, abort, warm grant, phone streams transferred", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-handoff-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-handoff-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const daemon = await startDaemonHalf(paths.socketPath);
		cleanups.push(() => daemon.close());

		const { attach, events } = await startTuiHalf(agentDir, cwd);
		const workspaceName = attach.workspaceName();
		expect(workspaceName).toBeDefined();
		expect(daemon.workspaces.some((workspace) => workspace.name === workspaceName)).toBe(true);

		// A daemon runtime is mid-turn with one phone attached.
		daemon.session.isStreaming = true;
		const runtimeOwner = publishDaemonRuntime(daemon.broker, workspaceName as string, "s-1");
		daemon.broker.onDaemonRuntimeStreamCountChanged(runtimeOwner, workspaceName as string, "s-1", 1);

		const outcome = await attach.acquire("s-1");
		expect(outcome.kind).toBe("pending");
		const pending = outcome as Extract<AcquireOutcome, { kind: "pending" }>;

		// Events emitted before viewer_subscribe are buffered...
		daemon.session.emit({ type: "message_delta", n: 1 });
		await attach.viewerSubscribe(pending.viewerFeedId);
		// ...and events after it stream live.
		daemon.session.emit({ type: "message_delta", n: 2 });
		await vi.waitFor(() => {
			const feedEvents = events.filter((event) => event.type === "viewer_event");
			expect(feedEvents.map((event) => (event.event as { n: number }).n)).toEqual([1, 2]);
			expect(feedEvents.map((event) => event.seq)).toEqual([0, 1]);
		});

		// Abort from the TUI stops the remote turn (non-destructive).
		await attach.viewerAbort(pending.viewerFeedId);
		expect(daemon.session.abort).toHaveBeenCalledTimes(1);

		// Turn ends -> drain completes: warm grant, runtime disposed via the
		// normal quit path, phone streams closed lease_transferred, viewer ends.
		daemon.session.endTurn();
		const granted = await pending.granted;
		expect(granted.handoff).toBe("warm");
		expect(daemon.disposed).toEqual([{ reason: "lease_transferred_to_tui" }]);
		expect(daemon.closedStreams).toEqual([{ reason: "lease_transferred" }]);
		await vi.waitFor(() => {
			expect(events.some((event) => event.type === "viewer_end" && event.reason === "granted")).toBe(true);
		});
		expect(daemon.broker.lookup(workspaceName as string, "s-1")?.state).toBe("tui-owned");

		// TUI -> daemon: release makes the lease unowned; the next phone attach
		// lazily resumes (registry-level) and the broker records daemon-active.
		await attach.release("s-1");
		expect(daemon.broker.lookup(workspaceName as string, "s-1")?.state ?? "unowned").toBe("unowned");
		publishDaemonRuntime(daemon.broker, workspaceName as string, "s-1");
		expect(daemon.broker.lookup(workspaceName as string, "s-1")?.state).toBe("daemon-active");
	}, 20_000);

	it("keeps reconnecting when auto-start probes stale discovery credentials", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-ar-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-ar-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const socketPath = freshControlSocketPath(paths, "a");
		const currentToken = randomUUID();
		const daemon = await startDaemonHalf(socketPath, { authToken: currentToken });
		cleanups.push(() => daemon.close());
		publishDaemonEndpoint(paths, socketPath, "stale-token");

		const attach = createDaemonAttach({ cwd, agentDir, autoStart: true });
		cleanups.push(() => attach.dispose());
		await attach.start();
		expect(attach.connectionState()).toBe("reconnecting");

		publishDaemonEndpoint(paths, socketPath, currentToken);
		await vi.waitFor(
			() => {
				expect(attach.connectionState()).toBe("connected");
				expect(attach.workspaceName()).toBeDefined();
			},
			{ timeout: 10_000 },
		);
	}, 20_000);

	it("re-discovers rotated endpoint credentials and re-acquires after a daemon restart (§12.3.6)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-reacq-"));
		const cwd = mkdtempSync(join(tmpdir(), "volt-reacq-ws-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const firstSocketPath = freshControlSocketPath(paths, "first");
		const firstToken = randomUUID();
		const first = await startDaemonHalf(firstSocketPath, { authToken: firstToken });
		publishDaemonEndpoint(paths, firstSocketPath, firstToken);

		const { attach, reacquired } = await startTuiHalf(agentDir, cwd);
		const workspaceName = attach.workspaceName() as string;
		const initial = await attach.acquire("s-1");
		expect(initial).toEqual({ kind: "granted", handoff: "none" });

		// Daemon dies and removes its discovery metadata. The replacement rotates
		// both its control endpoint (as Windows always does) and auth token. While
		// the TUI is disconnected, the replacement also spins up a runtime for the
		// phone, so re-acquisition lands as a warm grant.
		await first.close();
		rmSync(paths.pidfilePath, { force: true });
		const secondSocketPath = freshControlSocketPath(paths, "second");
		const secondToken = randomUUID();
		const second = await startDaemonHalf(secondSocketPath, {
			authToken: secondToken,
			workspaces: [{ name: workspaceName, path: cwd }],
		});
		cleanups.push(() => second.close());
		publishDaemonRuntime(second.broker, workspaceName, "s-1");
		publishDaemonEndpoint(paths, secondSocketPath, secondToken);

		await vi.waitFor(
			() => {
				expect(reacquired.length).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 10_000 },
		);
		expect(reacquired[0]?.sessionId).toBe("s-1");
		expect(reacquired[0]?.outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(second.disposed).toEqual([{ reason: "lease_transferred_to_tui" }]);
		expect(second.closedStreams).toEqual([{ reason: "lease_transferred" }]);
	}, 20_000);
});
