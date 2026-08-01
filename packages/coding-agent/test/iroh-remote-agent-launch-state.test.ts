import { describe, expect, test } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteGrantedClient,
	type IrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";

const WORKSPACE = { name: "volt", path: "/workspace", allowedTools: "read" } as const;
const RPC_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;

function createState(lastSessionId?: string): IrohRemoteHostState {
	return {
		...createEmptyIrohRemoteHostState(),
		workspaces: [{ ...WORKSPACE }],
		clients: [
			{
				nodeId: "client-node",
				label: "phone",
				allowedWorkspaces: [],
				allowedTools: "read",
				rpcGrant: RPC_GRANT,
				pairedAt: 1,
				lastSeenAt: 2,
				...(lastSessionId === undefined ? {} : { lastSessionIdByWorkspace: { volt: lastSessionId } }),
			},
		],
	};
}

function createAuthorization(state: IrohRemoteHostState): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: structuredClone(state.clients[0]) as IrohRemoteGrantedClient,
		paired: false,
		pairingSecretConsumed: false,
		workspace: { ...WORKSPACE },
		workspaceNames: ["volt"],
		workspaces: [{ name: "volt", status: "available" }],
	};
}

describe("agent launch session selection state", () => {
	test("restores in-memory selection when single-client persistence fails", async () => {
		let persisted = createState("session-old");
		let failNextWrite = true;
		const stateManager = new IrohRemoteHostStateManager({
			store: {
				read: () => structuredClone(persisted),
				write: (state) => {
					if (failNextWrite) {
						failNextWrite = false;
						throw new Error("save failed");
					}
					persisted = structuredClone(state);
				},
			},
		});

		await expect(stateManager.setClientLastSessionId("client-node", "volt", "session-new")).rejects.toThrow(
			"save failed",
		);
		expect((await stateManager.getClient("client-node"))?.lastSessionIdByWorkspace).toEqual({
			volt: "session-old",
		});
	});

	test("restores an authorization-fenced selection when persistence fails", async () => {
		let persisted = createState("session-old");
		const authorization = createAuthorization(persisted);
		let failNextWrite = true;
		const stateManager = new IrohRemoteHostStateManager({
			store: {
				read: () => structuredClone(persisted),
				write: (state) => {
					if (failNextWrite) {
						failNextWrite = false;
						throw new Error("save failed");
					}
					persisted = structuredClone(state);
				},
			},
		});

		await expect(
			stateManager.setClientLastSessionIdIfAuthorizationCurrent(authorization, "session-new"),
		).rejects.toThrow("save failed");
		expect((await stateManager.getClient("client-node"))?.lastSessionIdByWorkspace).toEqual({
			volt: "session-old",
		});
	});

	test("rejects a stale authorization without changing the persisted selection", async () => {
		const state = createState("session-old");
		const authorization = createAuthorization(state);
		const stateManager = new IrohRemoteHostStateManager({ initialState: state });
		await stateManager.updateClientAccess("client-node", RPC_GRANT.revision, createIrohRemotePresetAccess("coding"));

		await expect(
			stateManager.setClientLastSessionIdIfAuthorizationCurrent(authorization, "session-new"),
		).resolves.toEqual({ ok: false, reason: "authorization_changed" });
		expect((await stateManager.getClient("client-node"))?.lastSessionIdByWorkspace).toEqual({
			volt: "session-old",
		});
	});

	test("persists an authorized selection and restores it only with a matching compare-and-set", async () => {
		const state = createState("session-old");
		const authorization = createAuthorization(state);
		const stateManager = new IrohRemoteHostStateManager({ initialState: state });

		const selected = await stateManager.setClientLastSessionIdIfAuthorizationCurrent(authorization, "session-new");
		expect(selected).toMatchObject({ ok: true, previousSessionId: "session-old" });
		await expect(
			stateManager.restoreClientLastSessionIdIfCurrent("client-node", "volt", "session-other", "session-old"),
		).resolves.toBe(false);
		expect((await stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe("session-new");
		await expect(
			stateManager.restoreClientLastSessionIdIfCurrent("client-node", "volt", "session-new", "session-old"),
		).resolves.toBe(true);
		expect((await stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe("session-old");
	});
});
