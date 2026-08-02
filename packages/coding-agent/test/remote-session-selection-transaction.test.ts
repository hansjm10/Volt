import { describe, expect, it } from "vitest";
import { createEmptyIrohRemoteHostState, type IrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import {
	IrohRemoteHostStateManager,
	IrohRemoteStatePersistenceAmbiguousError,
} from "../src/core/remote/iroh/state-manager.ts";

function createState(): IrohRemoteHostState {
	const state = createEmptyIrohRemoteHostState();
	state.clients = ["phone-a", "phone-b"].map((nodeId) => ({
		nodeId,
		label: nodeId,
		allowedWorkspaces: ["ws"],
		allowedTools: "",
		rpcGrant: { schemaVersion: 1, revision: 1, capabilities: [] },
		pairedAt: 1,
		lastSeenAt: 1,
		lastSessionIdByWorkspace: { ws: "old" },
	}));
	return state;
}

function cloneState(state: IrohRemoteHostState): IrohRemoteHostState {
	return structuredClone(state);
}

describe("relayed client session selection transaction", () => {
	it("updates every selected client in one durable write", async () => {
		let persisted = createState();
		let writes = 0;
		const manager = new IrohRemoteHostStateManager({
			store: {
				read: () => cloneState(persisted),
				write: (state) => {
					writes++;
					persisted = cloneState(state);
				},
			},
		});

		await manager.setClientsLastSessionId(["phone-a", "phone-b"], "ws", "new");
		expect(writes).toBe(1);
		expect(persisted.clients.map((client) => client.lastSessionIdByWorkspace?.ws)).toEqual(["new", "new"]);
	});

	it("restores the complete old selection when the durable write fails", async () => {
		let persisted = createState();
		let failNextWrite = true;
		const manager = new IrohRemoteHostStateManager({
			store: {
				read: () => cloneState(persisted),
				write: (state) => {
					if (failNextWrite) {
						failNextWrite = false;
						throw new Error("disk full");
					}
					persisted = cloneState(state);
				},
			},
		});

		await expect(manager.setClientsLastSessionId(["phone-a", "phone-b"], "ws", "new")).rejects.toThrow("disk full");
		expect(persisted.clients.map((client) => client.lastSessionIdByWorkspace?.ws)).toEqual(["old", "old"]);
		expect((await manager.getState()).clients.map((client) => client.lastSessionIdByWorkspace?.ws)).toEqual([
			"old",
			"old",
		]);
	});

	it("surfaces an ambiguous outcome when failed persistence cannot be durably compensated", async () => {
		let persisted = createState();
		let writes = 0;
		const manager = new IrohRemoteHostStateManager({
			store: {
				read: () => cloneState(persisted),
				write: (state) => {
					writes += 1;
					if (writes === 1) persisted = cloneState(state);
					throw new Error("durability unknown");
				},
			},
		});

		await expect(manager.setClientsLastSessionId(["phone-a", "phone-b"], "ws", "new")).rejects.toBeInstanceOf(
			IrohRemoteStatePersistenceAmbiguousError,
		);
		expect(writes).toBe(2);
		expect(persisted.clients.map((client) => client.lastSessionIdByWorkspace?.ws)).toEqual(["new", "new"]);
	});

	it("rejects the whole selection when any attached client is unknown", async () => {
		let persisted = createState();
		let writes = 0;
		const manager = new IrohRemoteHostStateManager({
			store: {
				read: () => cloneState(persisted),
				write: (state) => {
					writes++;
					persisted = cloneState(state);
				},
			},
		});

		await expect(manager.setClientsLastSessionId(["phone-a", "missing-phone"], "ws", "new")).rejects.toThrow(
			"unknown client(s): missing-phone",
		);
		expect(writes).toBe(0);
		expect(persisted.clients.map((client) => client.lastSessionIdByWorkspace?.ws)).toEqual(["old", "old"]);
	});
});
