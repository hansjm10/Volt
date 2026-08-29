import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import {
	RELAY_TOKEN_TTL_MS,
	type RelayOutcome,
	type RelayPendingRejection,
	RelayRegistry,
} from "../src/daemon/relay-stream.ts";
import { connectRawRelayClient, FakePhoneIrohStream } from "./relay-doubles.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";

interface RelayHarness {
	socketPath: string;
	registry: RelayRegistry;
	server: ControlServer;
}

const cleanups: Array<() => Promise<void> | void> = [];

async function startRelayHarness(): Promise<RelayHarness> {
	const endpoint = createTestSocketEndpoint("volt-relay");
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
		// server.close() waits for open sockets; active relay owners hold theirs.
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		endpoint.cleanup();
	});
	return { socketPath: endpoint.socketPath, registry, server };
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
	vi.useRealTimers();
});

const RELAY_AUTHORIZATION = {
	clientNodeId: "n-phone-a",
	workspaceName: "ws",
	workspacePath: "/tmp/ws",
	workspaceNames: ["ws", "beta"],
	workspaces: [
		{ name: "ws", status: "available" as const },
		{ name: "beta", status: "available" as const },
		{ name: "offline", status: "missing" as const },
	],
	allowedTools: "read",
	rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
};

const HANDSHAKE_VERBATIM = {
	hello: {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation: { target: "session", sessionId: "s-1" },
		clientInfo: { label: "phône 📱", nested: [1, 2, { deep: true }], nullish: null },
	},
	response: { child: "volt", features: ["multi_streams.v1", "conversation_streams.v1"] },
	initialInput: [104, 105, 10],
};

function mintTestRelay(
	registry: RelayRegistry,
	phone: FakePhoneIrohStream,
	onSettled: (outcome: RelayOutcome) => Promise<void> | void,
	now?: number,
	rejectPending: (rejection: RelayPendingRejection) => Promise<void> | void = () => {},
	observePhysicalTask?: (task: Promise<unknown>) => void,
) {
	return registry.mint({
		workspaceName: "ws",
		sessionId: "s-1",
		clientNodeId: "n-phone-a",
		ownerControlConnectionId: "control-1",
		connectionId: "conn-1",
		streamId: "st-1",
		stream: phone,
		preamble: {
			handshake: HANDSHAKE_VERBATIM,
			authorization: RELAY_AUTHORIZATION,
			hostNodeId: "n-host-1",
			relayMode: "development",
			connectionId: "conn-1",
			streamId: "st-1",
			resolvedTarget: {
				sessionId: "s-1",
				sessionFilePath: "/tmp/ws/.sessions/s-1.jsonl",
				selection: "resumed",
				requestedSessionId: "s-1",
				workspaceName: "ws",
				workspacePath: "/tmp/ws",
			},
		},
		...(now === undefined ? {} : { now }),
		rejectPending,
		onSettled,
		...(observePhysicalTask === undefined ? {} : { observePhysicalTask }),
	});
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve = (_value: T): void => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("relay framing (§12.2.3)", () => {
	it("acks the relay hello then writes the preamble exactly: verbatim handshake plus authorization subset", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		expect(client.messages[0]).toEqual({ type: "hello_ack", ok: true });
		expect(client.messages[1]).toEqual({
			type: "relay_preamble",
			relayId: relay.relayId,
			handshake: HANDSHAKE_VERBATIM,
			authorization: RELAY_AUTHORIZATION,
			hostNodeId: "n-host-1",
			relayMode: "development",
			connectionId: "conn-1",
			streamId: "st-1",
			resolvedTarget: {
				sessionId: "s-1",
				sessionFilePath: "/tmp/ws/.sessions/s-1.jsonl",
				selection: "resumed",
				requestedSessionId: "s-1",
				workspaceName: "ws",
				workspacePath: "/tmp/ws",
			},
		});
		expect(relay.phase).toBe("active");
		expect(registry.get(relay.relayId)).toBe(relay);
		expect(registry.activeCount()).toBe(1);
		expect(registry.forConversation("n-phone-a", "ws", "s-1", "active")[0]).toBe(relay);
		expect(relay).toMatchObject({
			connectionId: "conn-1",
			streamId: "st-1",
		});
		expect(settle).not.toHaveBeenCalled();
	});

	it("authorizes relay RPC only for the active relay owner and exact conversation scope", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const relay = mintTestRelay(registry, new FakePhoneIrohStream(), vi.fn());
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		const scope = { clientNodeId: "n-phone-a", workspaceName: "ws", sessionId: "s-1" };
		expect(registry.authorizeRpc(relay.relayId, "control-1", scope)).toMatchObject({
			ok: true,
			relay: { relayId: relay.relayId },
		});
		expect(registry.authorizeRpc(relay.relayId, "wrong-owner", scope)).toEqual({
			ok: false,
			code: "not_held",
			message: "relay is not owned by this control connection",
		});
		expect(registry.authorizeRpc(relay.relayId, "control-1", { ...scope, sessionId: "other" })).toEqual({
			ok: false,
			code: "session_mismatch",
			message: "relay RPC scope does not match active relay",
		});
		expect(registry.authorizeRpc("missing-relay", "control-1", scope)).toEqual({
			ok: false,
			code: "not_found",
			message: "active relay not found",
		});

		await relay.close("tui_disconnected");
		expect(registry.authorizeRpc(relay.relayId, "control-1", scope)).toEqual({
			ok: false,
			code: "not_found",
			message: "active relay not found",
		});
	});

	it("pumps raw binary bytes transparently in both directions, including bytes buffered with the hello", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		// Random binary (contains 0x0a newlines with near-certainty at this size);
		// the relay must never re-frame or reinterpret it.
		const trailing = randomBytes(1024);
		const client = connectRawRelayClient(socketPath, relay);
		client.socket.on("connect", () => {
			// Lands in the same stream as (usually the same chunk as) the hello: the
			// server must hand it to the pump as bufferedRemainder, not decode it.
			client.socket.write(trailing);
		});
		await vi.waitFor(() => expect(phone.receivedBytes().equals(trailing)).toBe(true));

		// TUI -> phone: chunk sizes straddle the 64 KiB relay read limit.
		const toPhone = [randomBytes(3), randomBytes(70_000), randomBytes(257)];
		for (const chunk of toPhone) {
			client.socket.write(chunk);
		}
		const expectedPhoneBytes = Buffer.concat([trailing, ...toPhone]);
		await vi.waitFor(() => expect(phone.receivedBytes().equals(expectedPhoneBytes)).toBe(true));

		// Phone -> TUI.
		const toTui = [randomBytes(129_537), randomBytes(1), randomBytes(4096)];
		for (const chunk of toTui) {
			phone.sendBytes(chunk);
		}
		const expectedTuiBytes = Buffer.concat(toTui);
		await vi.waitFor(() => expect(client.rawReceived().equals(expectedTuiBytes)).toBe(true));

		expect(settle).not.toHaveBeenCalled();
		expect(phone.finished).toBe(false);
	});

	it("propagates a TUI-side close to the phone's send side", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		client.socket.end();
		await vi.waitFor(() => {
			expect(phone.finished).toBe(true);
			expect(settle).toHaveBeenCalledTimes(1);
		});
		expect(registry.activeCount()).toBe(0);
	});

	it("fences on TUI EOF while the ordered raw write tail owns FIN and stop settlement", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const writeGate = createDeferred<void>();
		const readGate = createDeferred<Buffer | undefined>();
		const stopGate = createDeferred<void>();
		const observerGate = createDeferred<void>();
		const writtenChunks: Buffer[] = [];
		const finish = vi.fn(async () => {});
		const reset = vi.fn(async () => {});
		const stop = vi.fn(() => stopGate.promise);
		phone.send.writeAll = vi.fn((bytes: Array<number>) => {
			writtenChunks.push(Buffer.from(bytes));
			return writeGate.promise;
		});
		phone.send.finish = finish;
		phone.send.reset = reset;
		phone.recv.read = vi.fn(() => readGate.promise);
		phone.recv.stop = stop;
		const onSettled = vi.fn(() => observerGate.promise);
		const relay = mintTestRelay(registry, phone, onSettled);
		let didSettle = false;
		void relay.settled.then(() => {
			didSettle = true;
		});

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));
		const tail = Buffer.from("tail admitted before EOF", "utf8");
		client.socket.write(tail);
		await vi.waitFor(() => expect(phone.send.writeAll).toHaveBeenCalledTimes(1));

		client.socket.end();
		await vi.waitFor(() => expect(relay.phase).toBe("closed"));
		// Lookup and application ownership are fenced synchronously. The observer
		// is the application barrier; raw write/FIN/read/stop settlement is separate.
		expect(registry.get(relay.relayId)).toBeUndefined();
		expect(finish).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(didSettle).toBe(false);

		writeGate.resolve(undefined);
		await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
		expect(Buffer.concat(writtenChunks)).toEqual(tail);
		expect(reset).not.toHaveBeenCalled();
		// FIN starts only after the admitted raw write completes, while the raw read
		// and stop promises may remain pending under bounded daemon disposal.
		expect(onSettled).toHaveBeenCalledTimes(1);
		observerGate.resolve(undefined);
		expect(await relay.settled).toMatchObject({ reason: "tui_disconnected", bytesUp: tail.length, bytesDown: 0 });
		expect(didSettle).toBe(true);

		readGate.resolve(Buffer.from("phone bytes returned after fence", "utf8"));
		await Promise.resolve();
		stopGate.resolve(undefined);
		await Promise.resolve();
		expect(client.rawReceived()).toEqual(Buffer.alloc(0));
		expect(finish).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("propagates phone EOF to the TUI and settles phone_disconnected with byte counts", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		const up = randomBytes(2048); // TUI -> phone
		const down = randomBytes(512); // phone -> TUI
		client.socket.write(up);
		phone.sendBytes(down);
		await vi.waitFor(() => {
			expect(phone.receivedBytes().equals(up)).toBe(true);
			expect(client.rawReceived().equals(down)).toBe(true);
		});

		phone.end();
		await vi.waitFor(() => {
			expect(client.ended()).toBe(true);
			expect(settle).toHaveBeenCalledTimes(1);
		});
		const outcome = settle.mock.calls[0]?.[0] as RelayOutcome;
		expect(outcome.reason).toBe("phone_disconnected");
		expect(outcome.bytesUp).toBe(up.length);
		expect(outcome.bytesDown).toBe(down.length);
		expect(registry.activeCount()).toBe(0);
	});

	it("rejects reused, wrong, expired, and unknown tokens with bad_relay_token", async () => {
		const { socketPath, registry } = await startRelayHarness();

		// Single-use: a second redemption of an admitted relay is rejected.
		const phoneA = new FakePhoneIrohStream();
		const relayA = mintTestRelay(registry, phoneA, vi.fn());
		const clientA = connectRawRelayClient(socketPath, relayA);
		await vi.waitFor(() => expect(clientA.messages).toHaveLength(2));
		const reuse = connectRawRelayClient(socketPath, relayA);
		await reuse.closed;
		expect(reuse.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);

		// A wrong token is rejected without consuming the offer.
		const phoneB = new FakePhoneIrohStream();
		const relayB = mintTestRelay(registry, phoneB, vi.fn());
		const wrongToken = connectRawRelayClient(socketPath, {
			relayId: relayB.relayId,
			relayToken: "not-the-token",
		});
		await wrongToken.closed;
		expect(wrongToken.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
		const retryB = connectRawRelayClient(socketPath, relayB);
		await vi.waitFor(() => expect(retryB.messages).toHaveLength(2));
		expect(retryB.messages[0]).toEqual({ type: "hello_ack", ok: true });

		// Expired token.
		const phoneC = new FakePhoneIrohStream();
		const relayC = mintTestRelay(registry, phoneC, vi.fn(), Date.now() - RELAY_TOKEN_TTL_MS - 1);
		const expired = connectRawRelayClient(socketPath, relayC);
		await expired.closed;
		expect(expired.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);

		// Unknown relayId.
		const unknown = connectRawRelayClient(socketPath, { relayId: "rl-nope", relayToken: "nope" });
		await unknown.closed;
		expect(unknown.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
	});

	it("owns offer expiry and settles the expiry-vs-redemption race exactly once", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const registry = new RelayRegistry();
		const rejectPending = vi.fn(async () => {});
		const onSettled = vi.fn();
		const relay = mintTestRelay(registry, new FakePhoneIrohStream(), onSettled, undefined, rejectPending);

		expect(relay.phase).toBe("offered");
		expect(registry.get(relay.relayId)).toBe(relay);
		await vi.advanceTimersByTimeAsync(RELAY_TOKEN_TTL_MS);

		expect(relay.phase).toBe("closed");
		expect(registry.get(relay.relayId)).toBeUndefined();
		// Expiry synchronously removed the owner from the token index, so a
		// same-tick redemption cannot promote it while rejection I/O settles.
		expect(registry.admit(relay.relayId, relay.relayToken, {} as never, Buffer.alloc(0))).toBe(false);
		expect(await relay.settled).toEqual({ reason: "error", bytesUp: 0, bytesDown: 0, durationMs: 0 });
		expect(rejectPending).toHaveBeenCalledTimes(1);
		expect(rejectPending).toHaveBeenCalledWith({ message: "relay offer expired; retry", retryAfterMs: 1000 });
		expect(onSettled).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(RELAY_TOKEN_TTL_MS);
		await relay.close("host_shutdown", { pendingMessage: "daemon shutting down" });
		expect(rejectPending).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("fences and settles an offered owner exactly once", async () => {
		const registry = new RelayRegistry();
		const phone = new FakePhoneIrohStream();
		let finishPendingRejection: () => void = () => {};
		const pendingRejection = new Promise<void>((resolve) => {
			finishPendingRejection = resolve;
		});
		const rejectPending = vi.fn(() => pendingRejection);
		const onSettled = vi.fn();
		const relay = mintTestRelay(registry, phone, onSettled, undefined, rejectPending);

		expect(registry.forConversation("n-phone-a", "ws", "s-1", "offered")).toEqual([relay]);
		const firstClose = relay.close("workspace_unregistered", { pendingMessage: "workspace unregistered" });
		const duplicateClose = relay.close("host_shutdown", { pendingMessage: "daemon shutting down" });

		// Closing fences lookup and redemption synchronously, before rejection I/O.
		expect(firstClose).toBe(duplicateClose);
		expect(relay.phase).toBe("closed");
		expect(registry.get(relay.relayId)).toBeUndefined();
		expect(registry.forConversation("n-phone-a", "ws", "s-1")).toHaveLength(0);
		await vi.waitFor(() => expect(rejectPending).toHaveBeenCalledTimes(1));
		expect(await relay.settled).toEqual({
			reason: "workspace_unregistered",
			bytesUp: 0,
			bytesDown: 0,
			durationMs: 0,
		});
		expect(rejectPending).toHaveBeenCalledWith({ message: "workspace unregistered" });
		expect(onSettled).toHaveBeenCalledTimes(1);
		finishPendingRejection();
		await pendingRejection;
	});

	it("does not admit a revoked pending offer containing a buffered prompt", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const relay = mintTestRelay(registry, phone, vi.fn());
		const bufferedPrompt = Buffer.from(
			`${JSON.stringify({ id: "p1", type: "prompt", clientMessageId: "client-p1", message: "do not run" })}\n`,
		);
		(relay.preamble.handshake as { initialInput: number[] }).initialInput = Array.from(bufferedPrompt);

		// Revocation uses this same synchronous owner close before acknowledging
		// the control request. The stale token must never expose initialInput.
		void relay.close("error", { pendingMessage: "client revoked; re-pair required" });
		expect(registry.get(relay.relayId)).toBeUndefined();
		const client = connectRawRelayClient(socketPath, relay);
		await client.closed;

		expect(client.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
		expect(client.rawReceived()).toEqual(Buffer.alloc(0));
		expect(registry.activeCount()).toBe(0);
	});

	it("settles with tui_disconnected when the TUI destroys the relay socket", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2)); // ack + preamble

		client.socket.destroy();
		await vi.waitFor(() => expect(settle).toHaveBeenCalled());
		const outcome = settle.mock.calls[0]?.[0] as RelayOutcome;
		expect(outcome.reason).toBe("tui_disconnected");
	});

	it("keeps one owner through redemption and settles competing active closes once", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const onSettled = vi.fn();
		const relay = mintTestRelay(registry, phone, onSettled);
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(relay.phase).toBe("active"));

		expect(registry.get(relay.relayId)).toBe(relay);
		const firstClose = relay.close("host_shutdown");
		client.socket.destroy();
		phone.end();
		const duplicateClose = relay.close("error", { error: "late close" });

		expect(firstClose).toBe(duplicateClose);
		expect(await relay.settled).toMatchObject({ reason: "host_shutdown" });
		expect(relay.phase).toBe("closed");
		expect(registry.get(relay.relayId)).toBeUndefined();
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("settles a redeemed abortive close while stalled raw reset/stop remain physically owned", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const writeGate = createDeferred<void>();
		const readGate = createDeferred<undefined>();
		const resetGate = createDeferred<void>();
		const stopGate = createDeferred<void>();
		const observerGate = createDeferred<void>();
		const physicalTasks: Promise<unknown>[] = [];
		let resetSettled = false;
		let stopSettled = false;
		void resetGate.promise.then(() => {
			resetSettled = true;
		});
		void stopGate.promise.then(() => {
			stopSettled = true;
		});
		const finish = vi.fn(async () => {});
		const reset = vi.fn(() => {
			writeGate.resolve(undefined);
			return resetGate.promise;
		});
		const stop = vi.fn(() => {
			readGate.resolve(undefined);
			return stopGate.promise;
		});
		phone.send.writeAll = vi.fn(() => writeGate.promise);
		phone.send.finish = finish;
		phone.send.reset = reset;
		phone.recv.read = vi.fn(() => readGate.promise);
		phone.recv.stop = stop;
		const onSettled = vi.fn(() => observerGate.promise);
		const relay = mintTestRelay(registry, phone, onSettled, undefined, undefined, (task) => {
			physicalTasks.push(task);
		});
		let didSettle = false;
		void relay.settled.then(() => {
			didSettle = true;
		});

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));
		client.socket.write("in-flight");
		await vi.waitFor(() => expect(phone.send.writeAll).toHaveBeenCalledTimes(1));

		const firstClose = relay.close("host_shutdown");
		const duplicateClose = relay.close("error", { error: "late error" });
		client.socket.destroy();
		expect(firstClose).toBe(duplicateClose);
		expect(relay.phase).toBe("closed");
		expect(registry.get(relay.relayId)).toBeUndefined();
		expect(reset).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(finish).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
		expect(didSettle).toBe(false);
		observerGate.resolve(undefined);
		expect(await relay.settled).toMatchObject({ reason: "host_shutdown", bytesUp: 9 });
		expect(didSettle).toBe(true);
		// Native terminal receipts are still pending and externally owned after the
		// relay's application/onSettled barrier has completed.
		expect(physicalTasks.length).toBeGreaterThan(0);
		expect({ resetSettled, stopSettled }).toEqual({ resetSettled: false, stopSettled: false });
		resetGate.resolve(undefined);
		stopGate.resolve(undefined);
		await Promise.resolve();
		expect({ resetSettled, stopSettled }).toEqual({ resetSettled: true, stopSettled: true });
		expect(reset).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("pauses the TUI socket while a phone write is in flight (backpressure)", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		// Gate writeAll so a second chunk can only be pulled once the first write
		// completes; without backpressure the pump reads ahead unboundedly.
		const writeGates: Array<() => void> = [];
		const writtenChunks: Buffer[] = [];
		phone.send.writeAll = (bytes: Array<number>) => {
			writtenChunks.push(Buffer.from(bytes));
			return new Promise<void>((resolve) => {
				writeGates.push(resolve);
			});
		};
		const relay = mintTestRelay(registry, phone, vi.fn());
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2)); // ack + preamble

		client.socket.write("first");
		await vi.waitFor(() => expect(writtenChunks).toHaveLength(1));
		client.socket.write("second");
		// The daemon-side socket is paused while "first" is in flight; "second"
		// must stay buffered in the socket, not in the write queue.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(writtenChunks).toHaveLength(1);

		writeGates.shift()?.();
		await vi.waitFor(() => expect(writtenChunks).toHaveLength(2));
		expect(Buffer.concat(writtenChunks).toString("utf8")).toBe("firstsecond");
		for (const gate of writeGates.splice(0)) {
			gate();
		}
	});
});
