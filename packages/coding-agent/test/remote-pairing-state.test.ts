import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { hashIrohRemotePairingSecret } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { createEmptyIrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";

const HOST_NODE_ID = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";

describe("remote pairing ticket cancellation", () => {
	it("removes only the cancelled pending ticket", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.addPendingPairingTicket({
			secretHash: "cancelled-hash",
			workspace: "volt",
			allowedTools: "read",
			createdAt: 1,
			expiresAt: 100,
		});
		await manager.addPendingPairingTicket({
			secretHash: "kept-hash",
			workspace: "volt",
			allowedTools: "read",
			createdAt: 2,
			expiresAt: 100,
		});

		await expect(manager.removePendingPairingTicket("cancelled-hash")).resolves.toBe(true);
		await expect(manager.removePendingPairingTicket("missing-hash")).resolves.toBe(false);
		expect((await manager.getState()).pendingPairingTickets).toEqual([
			{
				secretHash: "kept-hash",
				workspace: "volt",
				allowedTools: "read",
				createdAt: 2,
				expiresAt: 100,
			},
		]);
	});

	it("persists client revocation obligations until acknowledged", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const revocation = { nodeId: HOST_NODE_ID, createdAt: 10 };

		await manager.addPendingClientRevocation(revocation);
		await manager.addPendingClientRevocation(revocation);
		expect(await manager.listPendingClientRevocations()).toEqual([revocation]);
		await expect(manager.removePendingClientRevocation(HOST_NODE_ID)).resolves.toBe(true);
		await expect(manager.removePendingClientRevocation(HOST_NODE_ID)).resolves.toBe(false);
		expect(await manager.listPendingClientRevocations()).toEqual([]);
	});

	it("persists enrollment cancellation obligations until acknowledged", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		const cancellation = {
			version: 1 as const,
			claimId: Buffer.alloc(16, 1).toString("base64url"),
			claimSecret: Buffer.alloc(32, 2).toString("base64url"),
			createdAt: 10,
		};

		await manager.addPendingEnrollmentCancellation(cancellation);
		await manager.addPendingEnrollmentCancellation(cancellation);
		expect(await manager.listPendingEnrollmentCancellations()).toEqual([cancellation]);
		await expect(manager.removePendingEnrollmentCancellation(cancellation.claimId)).resolves.toBe(true);
		await expect(manager.removePendingEnrollmentCancellation(cancellation.claimId)).resolves.toBe(false);
		expect(await manager.listPendingEnrollmentCancellations()).toEqual([]);
	});

	it("clears the engine's live pairing secret as well as persisted state", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ name: "volt", path: "/workspace" });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "volt", path: "/workspace" },
			now: () => 1,
		});
		const pairing = await engine.pair({
			workspace: "volt",
			irohTicket: "endpoint-ticket",
			nodeId: HOST_NODE_ID,
			relay: { kind: "disabled" },
			secret: "one-time-secret",
			expiresAt: 100,
		});
		const secretHash = hashIrohRemotePairingSecret(pairing.secret);

		await expect(engine.cancelPairingSecretByHash(secretHash)).resolves.toBe(true);
		await expect(engine.cancelPairingSecretByHash(secretHash)).resolves.toBe(false);
		await expect(manager.removePendingPairingTicket(secretHash)).resolves.toBe(false);
		expect((await manager.getState()).pendingPairingTickets).toEqual([]);
	});
});
