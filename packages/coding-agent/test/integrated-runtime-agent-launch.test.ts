import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { ConversationCoordinatorRegistry } from "../src/daemon/conversation-coordinator.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import { createTestSession } from "./iroh-stream-doubles.ts";

describe("detached agent launch publication", () => {
	test("a failed publication fence installs no owner and disposes the runtime", async () => {
		const coordinators = new ConversationCoordinatorRegistry();
		const broker = new LeaseBroker({
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
			onDrainStarted: () => {},
			onDrainEnded: () => {},
			audit: () => {},
		});
		coordinators.bindLeaseBroker(broker);
		const registry = new IntegratedRuntimeRegistry({
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			coordinators,
			detachedRuntimeTtlMs: () => 60_000,
			getProjectTrustedForWorkspace: () => true,
			setClientLastSessionId: async () => undefined,
		});
		const dispose = vi.fn(async () => {});
		const runtime = {
			session: createTestSession("agent-session", null),
			dispose,
		} as unknown as AgentSessionRuntime;
		const attach = broker.beginDaemonAttach("volt", "agent-session");
		if (attach.kind !== "proceed") throw new Error("expected daemon attach claim");

		await expect(
			registry.registerDetachedRuntime({
				clientNodeId: "client-node",
				workspaceName: "volt",
				sessionId: "agent-session",
				runtime,
				toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
				daemonAttachClaim: attach.claim,
				publicationFence: async () => {
					throw new Error("authorization changed");
				},
			}),
		).rejects.toThrow("authorization changed");
		expect(dispose).toHaveBeenCalledOnce();
		expect(registry.size).toBe(0);
		expect(registry.findOwner("volt", "agent-session")).toBeUndefined();
		expect(coordinators.get("volt", "agent-session")).toBeUndefined();
		expect(broker.lookup("volt", "agent-session")).toMatchObject({ state: "unowned", pendingDaemonAttaches: 1 });
		broker.abortDaemonAttach(attach.claim);
		expect(broker.lookup("volt", "agent-session")).toBeUndefined();

		const pendingDispose = vi.fn(async () => {});
		const pendingRuntime = {
			session: createTestSession("pending-session", null),
			dispose: pendingDispose,
		} as unknown as AgentSessionRuntime;
		const pendingAttach = broker.beginDaemonAttach("volt", "pending-session");
		if (pendingAttach.kind !== "proceed") throw new Error("expected pending launch daemon attach claim");
		const pendingEntry = await registry.registerDetachedRuntime({
			clientNodeId: "client-node",
			workspaceName: "volt",
			sessionId: "pending-session",
			runtime: pendingRuntime,
			toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
			daemonAttachClaim: pendingAttach.claim,
			launchPending: true,
		});
		expect(pendingEntry.detachedRuntimeRetention).toBeUndefined();
		const attachClaim = pendingEntry.coordinator.createAttachClaim("client-node");
		expect(() => registry.assertEntryAttachable(pendingEntry, attachClaim)).toThrow(
			"conversation runtime ownership changed during attach",
		);
		registry.finalizeDetachedRuntimeLaunch(pendingEntry);
		expect(pendingEntry.detachedRuntimeRetention).toBeDefined();
		expect(() => registry.assertEntryAttachable(pendingEntry, attachClaim)).not.toThrow();
		await registry.stopEntry(pendingEntry, "test_cleanup");
		expect(pendingDispose).toHaveBeenCalledOnce();
	});
});
