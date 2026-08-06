import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import {
	createEmptyVoltdState,
	findRecoverableVoltdStateBackup,
	getLegacyRemoteStatePath,
	inspectVoltdStateFiles,
	migrateLegacyRemoteState,
	parseVoltdState,
	recoverVoltdStateFromBackup,
	regenerateInvalidVoltdState,
	VoltdStateStore,
} from "../src/daemon/state.ts";

const SECRET_KEY_BYTES = Array.from({ length: 32 }, (_, index) => index + 1);

function createLegacyState(): IrohRemoteHostState {
	return {
		hostSecretKey: [...SECRET_KEY_BYTES],
		workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: undefined }],
		clients: [
			{
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["volt"],
				allowedTools: "read,bash",
				pairedAt: 1000,
				lastSeenAt: 2000,
				lastSessionIdByWorkspace: { volt: "s-abc" },
				pushTargets: [
					{
						id: "pt-1",
						provider: "fcm",
						platform: "ios",
						pushTargetAuthToken: "tok",
						enabled: true,
						createdAt: 1000,
						updatedAt: 1000,
					},
				],
			},
		],
		revokedClients: [
			{
				nodeId: "n-old",
				label: "old",
				allowedWorkspaces: [],
				allowedTools: "read",
				pairedAt: 1,
				lastSeenAt: 2,
				revokedAt: 3,
			},
		],
		pendingPairingTickets: [
			{
				secretHash: "legacy-ticket",
				workspace: "volt",
				allowedTools: "read",
				expiresAt: 3000,
				createdAt: 2000,
			},
		],
		pairingSecretTombstones: [],
	};
}

function createGrantedHostState(): IrohRemoteHostState {
	const grant = createIrohRemotePresetAccess("coding").rpcGrant;
	const state = createLegacyState();
	return {
		...state,
		workspaceGenerationCounter: 7,
		workspaceGenerations: [{ workspaceName: "volt", generation: 7 }],
		clients: state.clients.map((client) => ({ ...client, rpcGrant: grant })),
		revokedClients: state.revokedClients?.map((client) => ({ ...client, rpcGrant: grant })),
		pendingPairingTickets: state.pendingPairingTickets?.map((ticket) => ({ ...ticket, rpcGrant: grant })),
	};
}

describe("voltd state migration", () => {
	let agentDir: string;
	let statePath: string;
	let legacyPath: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-state-"));
		statePath = getDaemonPaths(agentDir).statePath;
		legacyPath = getLegacyRemoteStatePath(agentDir);
		mkdirSync(join(agentDir, "remote"), { recursive: true });
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("preserves pre-grant identity and workspace metadata but drops old access records", () => {
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const migrated = migrateLegacyRemoteState(agentDir, statePath);
		expect(migrated).not.toBeNull();
		expect(migrated?.state.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(migrated?.state.clients).toEqual([]);
		expect(migrated?.state.revokedClients).toEqual([]);
		expect(migrated?.state.pendingPairingTickets).toEqual([]);
		expect(migrated?.state.workspaces[0]?.name).toBe("volt");
		expect(migrated?.state.workspaceGenerationCounter).toBe(0);
		expect(migrated?.state.workspaceGenerations).toEqual([]);
		expect(migrated?.state.settings.detachedRuntimeTtlMs).toBe(30 * 60 * 1000);
		expect(migrated?.droppedAccess).toEqual({ clients: 1, revokedClients: 1, pendingPairingTickets: 1 });
	});

	it("defaults missing legacy sections to empty", () => {
		writeFileSync(legacyPath, JSON.stringify({ workspaces: [], clients: [] }));
		const migrated = migrateLegacyRemoteState(agentDir, statePath);
		expect(migrated).not.toBeNull();
		expect(migrated?.state.irohSecretKey).toBeUndefined();
		expect(migrated?.state.revokedClients).toEqual([]);
		expect(migrated?.state.pendingPairingTickets).toEqual([]);
		expect(migrated?.droppedAccess).toEqual({ clients: 0, revokedClients: 0, pendingPairingTickets: 0 });
	});

	it("does nothing when state.json already exists", () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		writeFileSync(statePath, JSON.stringify(createEmptyVoltdState()));
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		expect(migrateLegacyRemoteState(agentDir, statePath)).toBeNull();
	});

	it("store.load migrates once, renames legacy to .migrated, and is idempotent", async () => {
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const first = await store.load();
		expect(first.migratedFromLegacyState).toBe(true);
		expect(first.legacyDroppedAccess).toEqual({ clients: 1, revokedClients: 1, pendingPairingTickets: 1 });
		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
		await store.close();

		// Reload from disk: secret key survives byte-identically.
		const secondStore = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const second = await secondStore.load();
		expect(second.migratedFromLegacyState).toBe(false);
		expect(second.state.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(second.state.clients).toEqual([]);
		expect(second.state.workspaces[0]?.name).toBe("volt");
		await secondStore.close();

		// Legacy file restored alongside state.json: still nothing happens.
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const thirdStore = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		expect((await thirdStore.load()).migratedFromLegacyState).toBe(false);
		await thirdStore.close();
	});

	it("round-trips through parseVoltdState including settings", async () => {
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await store.load();
		store.updateSettings({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.settings).toEqual({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
	});

	it("setHostState updates the persisted host portion", async () => {
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await store.load();
		store.setHostState(createGrantedHostState());
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(parsed.workspaceGenerationCounter).toBe(7);
		expect(parsed.workspaceGenerations).toEqual([{ workspaceName: "volt", generation: 7 }]);
		expect(store.getHostState()).toMatchObject({
			hostSecretKey: SECRET_KEY_BYTES,
			workspaceGenerationCounter: 7,
			workspaceGenerations: [{ workspaceName: "volt", generation: 7 }],
		});
	});

	it("rejects an unparseable state file without modifying it", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const invalidState = "{ this is : not valid json";
		writeFileSync(statePath, invalidState);

		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await expect(store.load()).rejects.toThrow("Confirm regeneration from /remote");
		expect(readFileSync(statePath, "utf8")).toBe(invalidState);
	});

	it("backs up invalid state only after the caller explicitly requests regeneration", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const invalidState = "{ invalid";
		writeFileSync(statePath, invalidState);

		expect(inspectVoltdStateFiles(agentDir)).toMatchObject({ path: statePath });
		expect(readFileSync(statePath, "utf8")).toBe(invalidState);
		const { backupPath, preservedIdentity } = await regenerateInvalidVoltdState(agentDir);
		expect(preservedIdentity).toBe(false);
		expect(existsSync(statePath)).toBe(false);
		expect(readFileSync(backupPath, "utf8")).toBe(invalidState);

		const replacementStore = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const replacement = await replacementStore.load();
		expect(replacement.state).toEqual(createEmptyVoltdState());
		await replacementStore.close();
	});

	it("rewrites valid state immediately to scrub deprecated relay bearer fields", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const stateWithDeprecatedBearer = {
			...createEmptyVoltdState(),
			irohSecretKey: SECRET_KEY_BYTES,
			relayAuthToken: "top-level-relay-token",
			settings: {
				...createEmptyVoltdState().settings,
				relayAuthToken: "persisted-relay-token",
			},
		};
		writeFileSync(statePath, JSON.stringify(stateWithDeprecatedBearer));

		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const loaded = await store.load();
		expect(loaded.state.settings).not.toHaveProperty("relayAuthToken");
		const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		expect(persisted).not.toHaveProperty("relayAuthToken");
		expect(persisted.settings).not.toHaveProperty("relayAuthToken");
		await store.close();
	});

	it("rejects incompatible pre-grant daemon state without dropping identity or settings", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const incompatibleState = {
			...createEmptyVoltdState(),
			irohSecretKey: SECRET_KEY_BYTES,
			clients: createLegacyState().clients,
			workspaces: createLegacyState().workspaces,
			settings: {
				...createEmptyVoltdState().settings,
				relayAuthToken: "persisted-relay-token",
			},
		};
		writeFileSync(statePath, JSON.stringify(incompatibleState));

		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await expect(store.load()).rejects.toThrow("client rpcGrant must be an object");
		const persisted = JSON.parse(readFileSync(statePath, "utf8")) as typeof incompatibleState;
		expect(persisted.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(persisted.clients).toHaveLength(1);
		expect(persisted.settings.relayAuthToken).toBe("persisted-relay-token");

		const { backupPath, preservedIdentity } = await regenerateInvalidVoltdState(agentDir);
		expect(preservedIdentity).toBe(true);
		expect(existsSync(backupPath)).toBe(true);
		const regenerated = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(regenerated.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(regenerated.settings).not.toHaveProperty("relayAuthToken");
		expect(regenerated.workspaces).toEqual(createLegacyState().workspaces);
		expect(regenerated.clients).toEqual([]);
		expect(regenerated.revokedClients).toEqual([]);
		expect(regenerated.pendingPairingTickets).toEqual([]);

		const recoveryCandidate = findRecoverableVoltdStateBackup(agentDir);
		expect(recoveryCandidate?.path).toBe(backupPath);
		writeFileSync(statePath, JSON.stringify(createEmptyVoltdState()));
		const recovered = await recoverVoltdStateFromBackup(agentDir, backupPath);
		expect(recovered.preservedIdentity).toBe(true);
		expect(recovered.previousStateBackupPath).toBeDefined();
		const restored = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(restored.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(restored.settings).not.toHaveProperty("relayAuthToken");
	});
});
