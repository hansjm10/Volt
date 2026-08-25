import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../src/core/remote/iroh/protocol.ts";
import {
	CONTROL_MAX_LINE_BYTES,
	type ControlEvent,
	ControlFrameTooLargeError,
	ControlLineDecoder,
	type ControlRequest,
	type ControlResponse,
	createControlClientStatus,
	encodeControlLine,
	type HelloAck,
	type HelloMessage,
	isControlEvent,
	isControlRequest,
	isControlResponse,
	isHelloAck,
	isRelayPreamble,
	PROTOCOL_VERSION,
	parseHelloMessage,
	type RelayPreamble,
} from "../src/daemon/control-protocol.ts";

const RPC_GRANT = {
	schemaVersion: 1 as const,
	revision: 1,
	capabilities: ["conversation.observe.v1" as const],
};

function roundTrip(message: object): unknown {
	const decoder = new ControlLineDecoder();
	const messages = decoder.push(encodeControlLine(message));
	expect(messages).toHaveLength(1);
	return messages[0];
}

describe("control protocol framing", () => {
	it("round-trips every request type", () => {
		const requests: ControlRequest[] = [
			{ type: "status", id: "1" },
			{ type: "shutdown", id: "2" },
			{ type: "lease_acquire", id: "3", workspaceName: "volt", sessionId: "s-1" },
			{ type: "lease_acquire", id: "3b", workspaceName: "volt", sessionId: "s-1", force: true },
			{
				type: "lease_release",
				id: "4",
				workspaceName: "volt",
				sessionId: "s-1",
				reason: "workspace_unregistered",
			},
			{
				type: "lease_rekey_prepare",
				id: "5",
				workspaceName: "volt",
				oldSessionId: "s-1",
				newSessionId: "s-2",
			},
			{ type: "lease_rekey_commit", id: "5a", transactionId: "tx-1" },
			{ type: "lease_rekey_rollback", id: "5b", transactionId: "tx-1" },
			{ type: "lease_rekey_dispose", id: "5c", transactionId: "tx-1" },
			{ type: "pair_request", id: "6", access: "coding" },
			{
				type: "client_access_update",
				id: "6a",
				clientNodeId: "n-1",
				expectedRevision: 1,
				access: "review",
			},
			{ type: "pair_cancel", id: "6b", requestId: "pair-1" },
			{ type: "clients_list", id: "7" },
			{ type: "relay_credential_revoke", id: "7b" },
			{ type: "client_revoke", id: "8", clientNodeId: "n-1" },
			{ type: "client_approve_repair", id: "8b", clientNodeId: "n-1" },
			{ type: "workspace_register", id: "9", name: "volt", path: "/tmp/volt" },
			{ type: "workspace_unregister", id: "10", name: "volt" },
			{ type: "theme_set", id: "11", theme: "dark" },
			{ type: "keep_awake_set", id: "11b", enabled: true },
			{ type: "keep_awake_set", id: "11c", enabled: false },
			{ type: "viewer_subscribe", id: "12", viewerFeedId: "vf-1" },
			{ type: "viewer_unsubscribe", id: "13", viewerFeedId: "vf-1" },
			{ type: "viewer_abort", id: "14", viewerFeedId: "vf-1" },
			{
				type: "relay_rpc",
				id: "15",
				relayId: "rl-1",
				clientNodeId: "n-1",
				workspaceName: "volt",
				sessionId: "s-1",
				command: { type: "register_push_target", id: "rpc-1", args: { token: "t" } },
			},
			{
				type: "relay_notification_delivery",
				id: "16",
				clientNodeId: "n-1",
				workspaceName: "volt",
				sessionId: "s-1",
				notification: {
					eventId: "plan:s-1:run-1:ready",
					hostNodeId: "a".repeat(64),
					kind: "plan_ready",
					title: "Your plan is ready",
					body: "Open Volt to review and approve it.",
					sessionId: "s-1",
					workspaceName: "volt",
					planId: "plan-1",
				},
			},
		];
		for (const request of requests) {
			const decoded = roundTrip(request);
			expect(decoded).toEqual(request);
			expect(isControlRequest(decoded), `request ${request.type}`).toBe(true);
		}
	});

	it("round-trips every response type", () => {
		const responses: ControlResponse[] = [
			{ type: "ok", id: "1" },
			{ type: "error", id: "2", code: "not_held", message: "lease not held" },
			{ type: "lease_granted", id: "3", workspaceName: "volt", sessionId: "s-1", handoff: "warm" },
			{ type: "lease_pending", id: "4", viewerFeedId: "vf-1" },
			{ type: "lease_denied", id: "5", reason: "held_by_tui" },
			{ type: "lease_rekey_prepared", id: "5a", transactionId: "tx-1" },
			{
				type: "status_result",
				id: "6",
				version: "1.0.0",
				protocolVersion: PROTOCOL_VERSION,
				pid: 42,
				startedAtMs: 1000,
				capabilities: ["pair_cancel"],
				leases: [{ workspaceName: "volt", sessionId: "s-1", state: "tui-owned", relayCount: 1, streamCount: 0 }],
				phoneConnections: 1,
				remoteTransport: { state: "ready", wrapperVersion: "1.1.1-volt.2" },
				workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: ["read", "bash"] }],
				clients: [
					{
						clientNodeId: "n-1",
						label: "phone",
						pairedAtMs: 5,
						lastSeenAtMs: 10,
						allowedTools: ["read"],
						rpcGrant: RPC_GRANT,
					},
				],
				revokedClients: [
					{
						clientNodeId: "n-2",
						label: "old phone",
						pairedAtMs: 1,
						lastSeenAtMs: 2,
						revokedAtMs: 3,
						rpcGrant: RPC_GRANT,
					},
				],
				remotePolicy: { allowTools: ["read", "bash"], detachedRuntimeTtlMs: 1_800_000 },
				keepAwake: { enabled: true, state: "active", method: "caffeinate" },
			},
			{
				type: "keep_awake_result",
				id: "6b",
				keepAwake: { enabled: true, state: "degraded", reason: "caffeinate exited" },
			},
			{ type: "clients_result", id: "7", clients: [] },
			{
				type: "client_access_updated",
				id: "7a",
				client: {
					clientNodeId: "n-1",
					pairedAtMs: 5,
					allowedTools: ["read"],
					rpcGrant: { ...RPC_GRANT, revision: 2 },
				},
			},
			{ type: "pair_started", id: "8", requestId: "pr-1" },
			{
				type: "relay_rpc_result",
				id: "9",
				response: { type: "response", command: "register_push_target", success: true },
				workspaceMetadata: { workspaceNames: ["volt"], workspaces: [{ name: "volt", status: "available" }] },
			},
			{ type: "relay_push_delivery_result", id: "10", status: "sent" },
		];
		for (const response of responses) {
			const decoded = roundTrip(response);
			expect(decoded).toEqual(response);
			expect(isControlResponse(decoded), `response ${response.type}`).toBe(true);
		}
	});

	it("requires structured remote transport health on status responses", () => {
		const base = { type: "status_result", id: "status" };
		expect(isControlResponse(base)).toBe(false);
		expect(isControlResponse({ ...base, remoteTransport: { state: "ready" } })).toBe(true);
		expect(
			isControlResponse({
				...base,
				remoteTransport: {
					state: "unavailable",
					reasonCode: "native_binding_missing",
					message: "Phone transport is unavailable on this platform.",
					wrapperVersion: "1.1.1-volt.2",
				},
			}),
		).toBe(true);
		expect(isControlResponse({ ...base, remoteTransport: { state: "healthy" } })).toBe(false);
		expect(isControlResponse({ ...base, remoteTransport: { state: "unavailable", reasonCode: "secret" } })).toBe(
			false,
		);
	});

	it("rejects a prepared-rekey response without its transaction id", () => {
		expect(isControlResponse({ type: "lease_rekey_prepared", id: "5a" })).toBe(false);
	});

	it("rejects lease release without a recognized reason", () => {
		const request = { type: "lease_release", id: "4", workspaceName: "volt", sessionId: "s-1" };
		expect(isControlRequest(request)).toBe(false);
		expect(isControlRequest({ ...request, reason: "workspace_removed" })).toBe(false);
	});

	it("rejects pair_request with a malformed workspace", () => {
		expect(isControlRequest({ type: "pair_request", id: "x", workspaceName: 42 })).toBe(false);
	});

	it("rejects keep_awake_set without a boolean enabled", () => {
		expect(isControlRequest({ type: "keep_awake_set", id: "x", enabled: "yes" })).toBe(false);
		expect(isControlRequest({ type: "keep_awake_set", id: "x" })).toBe(false);
	});

	it("rejects malformed relay delivery messages", () => {
		expect(
			isControlRequest({
				type: "relay_notification_delivery",
				id: "x",
				clientNodeId: "n-1",
				workspaceName: "volt",
				sessionId: "s-1",
				notification: { eventId: "e-1", kind: "conversation_completed", title: "Volt finished" },
			}),
		).toBe(false);
		const reviewNotificationRequest = {
			type: "relay_notification_delivery",
			id: "review",
			clientNodeId: "n-1",
			workspaceName: "volt",
			sessionId: "s-1",
			notification: {
				eventId: "review:one:completed",
				hostNodeId: "a".repeat(64),
				kind: "review_completed",
				title: "Your review is ready",
				body: "PR #151 completed with 4 findings.",
				sessionId: "s-1",
				workspaceName: "volt",
				workflowId: "review:one",
			},
		};
		expect(isControlRequest(reviewNotificationRequest)).toBe(true);
		expect(
			isControlRequest({
				...reviewNotificationRequest,
				notification: { ...reviewNotificationRequest.notification, planId: "plan-1" },
			}),
		).toBe(false);
		for (const notification of [
			{ ...reviewNotificationRequest.notification, title: "Review\nready" },
			{ ...reviewNotificationRequest.notification, body: "Open /Users/private/review.diff" },
			{ ...reviewNotificationRequest.notification, workspaceName: "private/path" },
			{ ...reviewNotificationRequest.notification, workflowId: "w".repeat(129) },
			{ ...reviewNotificationRequest.notification, hostNodeId: "A".repeat(64) },
		]) {
			expect(isControlRequest({ ...reviewNotificationRequest, notification })).toBe(false);
		}
		expect(
			isControlRequest({
				...reviewNotificationRequest,
				notification: {
					...reviewNotificationRequest.notification,
					workspaceName: undefined,
					workspace: "volt",
				},
			}),
		).toBe(false);
		expect(isControlResponse({ type: "relay_push_delivery_result", id: "x", status: "maybe" })).toBe(false);
	});

	it("round-trips every event type", () => {
		const events: ControlEvent[] = [
			{
				type: "relay_offer",
				relayId: "rl-1",
				relayToken: "tok",
				workspaceName: "volt",
				sessionId: "s-1",
				clientNodeId: "n-1",
				connectionId: "ic-1",
				streamId: "st-1",
			},
			{ type: "relay_closed", relayId: "rl-1", reason: "phone_disconnected" },
			{ type: "viewer_event", viewerFeedId: "vf-1", seq: 0, event: { type: "agent_end" } },
			{ type: "viewer_end", viewerFeedId: "vf-1", reason: "granted" },
			{ type: "theme_snapshot", themeName: "dark", tokens: { accent: "#ff0000" } },
			{ type: "keep_awake_changed", keepAwake: { enabled: true, state: "active", method: "caffeinate" } },
			{ type: "pairing_progress", requestId: "pr-1", phase: "waiting" },
			{ type: "daemon_shutdown" },
		];
		for (const event of events) {
			const decoded = roundTrip(event);
			expect(decoded).toEqual(event);
			expect(isControlEvent(decoded), `event ${event.type}`).toBe(true);
		}
	});

	it("round-trips hellos, acks, and relay preambles", () => {
		const controlHello: HelloMessage = {
			type: "hello",
			role: "control",
			protocolVersion: PROTOCOL_VERSION,
			pid: 4242,
			version: "0.9.0",
			client: "tui",
		};
		const relayHello: HelloMessage = {
			type: "hello",
			role: "relay",
			protocolVersion: PROTOCOL_VERSION,
			relayId: "rl-7",
			relayToken: "tK",
		};
		expect(parseHelloMessage(roundTrip(controlHello))).toEqual(controlHello);
		expect(parseHelloMessage(roundTrip(relayHello))).toEqual(relayHello);
		expect(parseHelloMessage({ type: "hello", role: "control" })).toBeUndefined();
		expect(parseHelloMessage({ type: "nope" })).toBeUndefined();

		const ack: HelloAck = { type: "hello_ack", ok: true, connectionId: "c-1", version: "0.9.0", protocolVersion: 1 };
		expect(isHelloAck(roundTrip(ack))).toBe(true);

		const preamble: RelayPreamble = {
			type: "relay_preamble",
			relayId: "rl-7",
			handshake: { workspace: "volt" },
			authorization: {
				clientNodeId: "n-1",
				workspaceName: "volt",
				workspacePath: "/tmp/volt",
				allowedTools: "read",
				rpcGrant: RPC_GRANT,
			},
			connectionId: "ic-3",
			streamId: "st-9",
			resolvedTarget: {
				sessionId: "s-abc",
				selection: "resumed",
				requestedSessionId: "s-abc",
				workspaceName: "volt",
				workspacePath: "/tmp/volt",
			},
		};
		expect(isRelayPreamble(roundTrip(preamble))).toBe(true);
		const rekeyedPreamble: RelayPreamble = {
			...preamble,
			resolvedTarget: {
				...preamble.resolvedTarget,
				sessionId: "s-def",
				selection: "session_rekeyed",
				requestedSessionId: "s-abc",
			},
		};
		expect(isRelayPreamble(roundTrip(rekeyedPreamble))).toBe(true);
		expect(
			isRelayPreamble({
				...preamble,
				authorization: { ...preamble.authorization, rpcGrant: undefined },
			}),
		).toBe(false);
	});

	it("buffers partial lines across pushes", () => {
		const decoder = new ControlLineDecoder();
		const line = encodeControlLine({ type: "status", id: "1" });
		const first = line.subarray(0, 5);
		const second = line.subarray(5);
		expect(decoder.push(first)).toEqual([]);
		expect(decoder.push(Buffer.concat([second, encodeControlLine({ type: "ok", id: "2" })]))).toEqual([
			{ type: "status", id: "1" },
			{ type: "ok", id: "2" },
		]);
	});

	it("skips blank lines and exposes the raw remainder", () => {
		const decoder = new ControlLineDecoder();
		const messages = decoder.push(Buffer.from('\n{"type":"ok","id":"1"}\nRAWBYTES', "utf8"));
		expect(messages).toEqual([{ type: "ok", id: "1" }]);
		expect(decoder.drainRemainder().toString("utf8")).toBe("RAWBYTES");
		expect(decoder.drainRemainder().length).toBe(0);
	});

	it("enforces the 8 MiB line cap", () => {
		const decoder = new ControlLineDecoder();
		const oversized = Buffer.alloc(CONTROL_MAX_LINE_BYTES + 2, 0x61);
		expect(() => decoder.push(oversized)).toThrow(ControlFrameTooLargeError);

		const withNewline = Buffer.concat([Buffer.alloc(CONTROL_MAX_LINE_BYTES + 1, 0x61), Buffer.from("\n")]);
		const freshDecoder = new ControlLineDecoder();
		expect(() => freshDecoder.push(withNewline)).toThrow(ControlFrameTooLargeError);
	});
});

describe("createControlClientStatus", () => {
	const baseClient = {
		nodeId: "client-node",
		label: "phone",
		allowedWorkspaces: [],
		rpcGrant: RPC_GRANT,
		pairedAt: 100,
		lastSeenAt: 200,
	};

	it("reports a tracking client as the resolved default with usesDefaultTools", () => {
		const status = createControlClientStatus(baseClient);
		expect(status.allowedTools).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
		expect(status.usesDefaultTools).toBe(true);
		expect(status).toMatchObject({ clientNodeId: "client-node", label: "phone", pairedAtMs: 100, lastSeenAtMs: 200 });
	});

	it("reports a pinned client's exact grant without the default marker", () => {
		const status = createControlClientStatus({ ...baseClient, allowedTools: "read,grep" });
		expect(status.allowedTools).toEqual(["read", "grep"]);
		expect(status.usesDefaultTools).toBe(false);
	});

	it("reports a deny-all client as an empty grant, never the default", () => {
		const status = createControlClientStatus({ ...baseClient, allowedTools: "" });
		expect(status.allowedTools).toEqual([]);
		expect(status.usesDefaultTools).toBe(false);
	});
});
