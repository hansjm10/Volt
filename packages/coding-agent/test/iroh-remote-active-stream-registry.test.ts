import { describe, expect, test } from "vitest";
import { type IrohRemoteActiveStreamEntry, IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/index.ts";

function makeEntry(
	overrides: Partial<
		Pick<IrohRemoteActiveStreamEntry, "clientNodeId" | "workspaceName" | "sessionId" | "connectionId" | "streamId">
	> = {},
): IrohRemoteActiveStreamEntry & { closeReasons: string[] } {
	const closeReasons: string[] = [];
	return {
		clientNodeId: overrides.clientNodeId ?? "client-a",
		workspaceName: overrides.workspaceName ?? "alpha",
		sessionId: overrides.sessionId ?? "session-1",
		connectionId: overrides.connectionId ?? "conn-1",
		streamId: overrides.streamId ?? "stream-1",
		closeReasons,
		close(reason: string) {
			closeReasons.push(reason);
		},
	};
}

describe("IrohRemoteActiveStreamRegistry", () => {
	test("registers and removes active streams by client workspace and connection", () => {
		const registry = new IrohRemoteActiveStreamRegistry();
		const entry = makeEntry();
		const remove = registry.register(entry);

		expect(registry.size).toBe(1);
		expect(registry.entriesForClientNodeId("client-a")).toEqual([entry]);
		expect(registry.entriesForWorkspace("client-a", "alpha")).toEqual([entry]);
		expect(registry.entriesForConversation("client-a", "alpha", "session-1")).toEqual([entry]);
		expect(registry.entriesForConnection("conn-1")).toEqual([entry]);
		expect(registry.hasWorkspaceOnConnection("client-a", "alpha", "conn-1")).toBe(true);
		expect(registry.hasConversationOnConnection("client-a", "alpha", "session-1", "conn-1")).toBe(true);

		remove();
		remove();

		expect(registry.size).toBe(0);
		expect(registry.entriesForClientNodeId("client-a")).toEqual([]);
		expect(registry.entriesForWorkspace("client-a", "alpha")).toEqual([]);
		expect(registry.entriesForConversation("client-a", "alpha", "session-1")).toEqual([]);
		expect(registry.entriesForConnection("conn-1")).toEqual([]);
		expect(registry.hasWorkspaceOnConnection("client-a", "alpha", "conn-1")).toBe(false);
		expect(registry.hasConversationOnConnection("client-a", "alpha", "session-1", "conn-1")).toBe(false);
	});

	test("allows the same client to hold different workspaces concurrently", () => {
		const registry = new IrohRemoteActiveStreamRegistry();
		const alpha = makeEntry({ workspaceName: "alpha", streamId: "stream-alpha" });
		const beta = makeEntry({ workspaceName: "beta", streamId: "stream-beta" });

		registry.register(alpha);
		registry.register(beta);

		expect(registry.size).toBe(2);
		expect(registry.entriesForClientNodeId("client-a")).toEqual([alpha, beta]);
		expect(registry.entriesForWorkspace("client-a", "alpha")).toEqual([alpha]);
		expect(registry.entriesForWorkspace("client-a", "beta")).toEqual([beta]);
		expect(registry.entriesForConnection("conn-1")).toEqual([alpha, beta]);
	});

	test("matches duplicates only for the same client workspace and session", () => {
		const registry = new IrohRemoteActiveStreamRegistry();
		const alpha = makeEntry({ workspaceName: "alpha", streamId: "stream-alpha" });
		const alphaOtherSession = makeEntry({
			workspaceName: "alpha",
			sessionId: "session-2",
			streamId: "stream-alpha-other-session",
		});
		const otherClientAlpha = makeEntry({
			clientNodeId: "client-b",
			workspaceName: "alpha",
			streamId: "stream-client-b-alpha",
		});
		const beta = makeEntry({ workspaceName: "beta", streamId: "stream-beta" });

		registry.register(alpha);
		registry.register(alphaOtherSession);
		registry.register(otherClientAlpha);
		registry.register(beta);

		expect(registry.entriesForWorkspace("client-a", "alpha")).toEqual([alpha, alphaOtherSession]);
		expect(registry.entriesForConversation("client-a", "alpha", "session-1")).toEqual([alpha]);
		expect(registry.entriesForConversation("client-a", "alpha", "session-2")).toEqual([alphaOtherSession]);
		expect(registry.entriesForWorkspace("client-b", "alpha")).toEqual([otherClientAlpha]);
		expect(registry.entriesForWorkspace("client-a", "beta")).toEqual([beta]);
		expect(registry.hasWorkspaceOnConnection("client-a", "alpha", "conn-1")).toBe(true);
		expect(registry.hasConversationOnConnection("client-a", "alpha", "session-1", "conn-1")).toBe(true);
		expect(registry.hasConversationOnConnection("client-a", "alpha", "session-2", "conn-1")).toBe(true);
		expect(registry.hasConversationOnConnection("client-a", "alpha", "missing-session", "conn-1")).toBe(false);
		expect(registry.hasWorkspaceOnConnection("client-b", "alpha", "conn-1")).toBe(true);
		expect(registry.hasWorkspaceOnConnection("client-a", "missing", "conn-1")).toBe(false);
	});

	test("removes only the affected connection entries during connection cleanup", () => {
		const registry = new IrohRemoteActiveStreamRegistry();
		const alpha = makeEntry({ connectionId: "conn-1", workspaceName: "alpha", streamId: "stream-alpha" });
		const beta = makeEntry({ connectionId: "conn-1", workspaceName: "beta", streamId: "stream-beta" });
		const gamma = makeEntry({ connectionId: "conn-2", workspaceName: "gamma", streamId: "stream-gamma" });

		registry.register(alpha);
		registry.register(beta);
		registry.register(gamma);

		for (const entry of registry.entriesForConnection("conn-1")) {
			registry.unregister(entry);
			entry.close("connection_closed");
		}

		expect(alpha.closeReasons).toEqual(["connection_closed"]);
		expect(beta.closeReasons).toEqual(["connection_closed"]);
		expect(gamma.closeReasons).toEqual([]);
		expect(registry.entriesForConnection("conn-1")).toEqual([]);
		expect(registry.entriesForClientNodeId("client-a")).toEqual([gamma]);
		expect(registry.entriesForWorkspace("client-a", "gamma")).toEqual([gamma]);
	});
});
