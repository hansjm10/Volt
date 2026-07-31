import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteHostState,
	type IrohRemoteWorkspaceWorktree,
	parseIrohRemoteHostState,
	parseIrohRemoteWorkspaceWorktree,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { handleIrohRemoteWorkspaceUnregisterRpcCommand } from "../src/core/remote/iroh/workspace-rpc.ts";
import {
	createEmptyVoltdState,
	hostStateToVoltdState,
	parseVoltdState,
	resolveWorktreeCleanupPolicy,
	voltdStateToHostState,
} from "../src/daemon/state.ts";

function createWorktree(overrides: Partial<IrohRemoteWorkspaceWorktree> = {}): IrohRemoteWorkspaceWorktree {
	return {
		id: "fix-login",
		workspaceName: "ws",
		path: "/home/user/.volt/agent/worktrees/--repo--/fix-login",
		branch: "volt/fix-login",
		baseRef: "main",
		createdAt: 1_751_900_000_000,
		sessionIds: ["s-abc"],
		...overrides,
	};
}

function createHostStateWithWorktrees(): IrohRemoteHostState {
	return {
		...createEmptyIrohRemoteHostState(),
		workspaces: [{ name: "ws", path: "/tmp/ws" }],
		worktrees: [createWorktree()],
	};
}

describe("worktree state round-trips (all five enumeration sites)", () => {
	it("parseIrohRemoteHostState preserves worktrees and parses old files without the key to []", () => {
		const parsed = parseIrohRemoteHostState({
			workspaces: [{ name: "ws", path: "/tmp/ws" }],
			clients: [],
			worktrees: [createWorktree()],
		});
		expect(parsed.worktrees).toEqual([createWorktree()]);

		// Old state files never carried the key: they must load cleanly as [].
		const legacy = parseIrohRemoteHostState({ workspaces: [], clients: [] });
		expect(legacy.worktrees).toEqual([]);
	});

	it("rejects malformed worktree entries with the standard error shape", () => {
		expect(() => parseIrohRemoteWorkspaceWorktree(createWorktree({ id: "UPPER" }))).toThrow(
			"worktree id must match lowercase worktree id syntax",
		);
		expect(() => parseIrohRemoteWorkspaceWorktree({ ...createWorktree(), branch: undefined })).toThrow(
			"worktree branch",
		);
		expect(() => parseIrohRemoteWorkspaceWorktree({ ...createWorktree(), sessionIds: "s-abc" })).toThrow(
			"worktree sessionIds",
		);
		expect(() => parseIrohRemoteHostState({ workspaces: [], clients: [], worktrees: [{ id: "x" }] })).toThrow();
		// A missing baseRef stays absent (optional).
		const withoutBaseRef = { ...createWorktree() } as Record<string, unknown>;
		delete withoutBaseRef.baseRef;
		expect(parseIrohRemoteWorkspaceWorktree(withoutBaseRef)).not.toHaveProperty("baseRef");
	});

	it("serialize/read round-trips worktrees through the state file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "volt-worktree-state-"));
		try {
			const statePath = join(dir, "iroh-host.json");
			await writeIrohRemoteHostState(statePath, createHostStateWithWorktrees());
			const reread = await readIrohRemoteHostState(statePath);
			expect(reread.worktrees).toEqual([createWorktree()]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cloneHostState (state manager getState) deep-copies worktrees", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createHostStateWithWorktrees() });
		const state = await manager.getState();
		expect(state.worktrees).toEqual([createWorktree()]);
		// Mutating the returned clone must not leak into the manager's state.
		state.worktrees?.[0]?.sessionIds.push("s-injected");
		state.worktrees?.pop();
		const fresh = await manager.getState();
		expect(fresh.worktrees).toEqual([createWorktree()]);
	});

	it("voltdStateToHostState/hostStateToVoltdState carry worktrees both ways", () => {
		const settings = createEmptyVoltdState().settings;
		const voltd = hostStateToVoltdState(createHostStateWithWorktrees(), settings);
		expect(voltd.worktrees).toEqual([createWorktree()]);
		expect(voltdStateToHostState(voltd).worktrees).toEqual([createWorktree()]);
		// Host state without the collection maps to [] on the return trip.
		expect(hostStateToVoltdState({ workspaces: [], clients: [] }, settings).worktrees).toEqual([]);
	});

	it("parseVoltdState preserves worktrees and defaults them for old daemon state files", () => {
		const settings = createEmptyVoltdState().settings;
		const withWorktrees = parseVoltdState(
			JSON.parse(JSON.stringify(hostStateToVoltdState(createHostStateWithWorktrees(), settings))),
		);
		expect(withWorktrees.worktrees).toEqual([createWorktree()]);

		const oldFile = JSON.parse(
			JSON.stringify(hostStateToVoltdState(createHostStateWithWorktrees(), settings)),
		) as Record<string, unknown>;
		delete oldFile.worktrees;
		expect(parseVoltdState(oldFile).worktrees).toEqual([]);
	});
});

describe("worktreeCleanup settings (§5.3)", () => {
	it("parseVoltdState round-trips worktreeCleanup and drops malformed shapes", () => {
		const settings = {
			...createEmptyVoltdState().settings,
			worktreeCleanup: { retention: { enabled: true, ttlMs: 3_600_000 }, pruneOnStart: false },
		};
		const file = JSON.parse(JSON.stringify(hostStateToVoltdState(createHostStateWithWorktrees(), settings)));
		expect(parseVoltdState(file).settings.worktreeCleanup).toEqual({
			retention: { enabled: true, ttlMs: 3_600_000 },
			pruneOnStart: false,
		});

		// Old files without the key parse to undefined (defaults apply at read).
		const oldFile = JSON.parse(
			JSON.stringify(hostStateToVoltdState(createHostStateWithWorktrees(), createEmptyVoltdState().settings)),
		) as { settings: Record<string, unknown> };
		expect(parseVoltdState(oldFile).settings.worktreeCleanup).toBeUndefined();

		// Malformed shapes are dropped, never crash the state load.
		for (const bogus of [
			42,
			"yes",
			[],
			{ retention: { enabled: "yes", ttlMs: 5 } },
			{ retention: { enabled: true, ttlMs: 0 } },
			{ retention: { enabled: true, ttlMs: -5 } },
			{ pruneOnStart: "no" },
		]) {
			oldFile.settings.worktreeCleanup = bogus;
			expect(parseVoltdState(JSON.parse(JSON.stringify(oldFile))).settings.worktreeCleanup).toBeUndefined();
		}
	});

	it("resolveWorktreeCleanupPolicy applies defaults: retention off, pruneOnStart on", () => {
		expect(resolveWorktreeCleanupPolicy({})).toEqual({ retention: undefined, pruneOnStart: true });
		expect(resolveWorktreeCleanupPolicy({ worktreeCleanup: {} })).toEqual({
			retention: undefined,
			pruneOnStart: true,
		});
		expect(resolveWorktreeCleanupPolicy({ worktreeCleanup: { pruneOnStart: false } })).toEqual({
			retention: undefined,
			pruneOnStart: false,
		});
		expect(resolveWorktreeCleanupPolicy({ worktreeCleanup: { retention: { enabled: true, ttlMs: 1000 } } })).toEqual({
			retention: { enabled: true, ttlMs: 1000 },
			pruneOnStart: true,
		});
		expect(resolveWorktreeCleanupPolicy({ worktreeCleanup: { retention: { enabled: false, ttlMs: 1000 } } })).toEqual(
			{ retention: undefined, pruneOnStart: true },
		);
	});
});

describe("worktree state manager operations", () => {
	let manager: IrohRemoteHostStateManager;

	beforeEach(() => {
		manager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [
					{ name: "ws", path: "/tmp/ws" },
					{ name: "other", path: "/tmp/other" },
				],
			},
		});
	});

	afterEach(async () => {
		// Nothing persisted to disk; in-memory manager only.
	});

	it("upserts, lists, binds, resolves, and removes worktree records", async () => {
		await manager.upsertWorktree(createWorktree({ sessionIds: [] }));
		await manager.upsertWorktree(createWorktree({ id: "other-tree", workspaceName: "other", sessionIds: [] }));

		expect(await manager.listWorktrees()).toHaveLength(2);
		expect((await manager.listWorktrees("ws")).map((worktree) => worktree.id)).toEqual(["fix-login"]);

		await manager.bindWorktreeSession("ws", "fix-login", "s-abc");
		// Binding is idempotent per session id.
		await manager.bindWorktreeSession("ws", "fix-login", "s-abc");
		expect((await manager.listWorktrees("ws"))[0]?.sessionIds).toEqual(["s-abc"]);
		expect((await manager.findWorktreeForSession("ws", "s-abc"))?.id).toBe("fix-login");
		expect(await manager.findWorktreeForSession("other", "s-abc")).toBeUndefined();

		const removed = await manager.removeWorktree("ws", "fix-login");
		expect(removed?.id).toBe("fix-login");
		expect(await manager.listWorktrees("ws")).toEqual([]);
		expect(await manager.removeWorktree("ws", "fix-login")).toBeUndefined();
	});

	it("refuses to persist a worktree whose parent workspace is not registered", async () => {
		await expect(
			manager.upsertWorktree(createWorktree({ workspaceName: "missing", sessionIds: [] })),
		).rejects.toMatchObject({
			code: "worktree_parent_workspace_not_found",
			workspaceName: "missing",
		});
		expect(await manager.listWorktrees()).toEqual([]);
	});

	it("unregisterWorkspace refuses to drop a workspace or its worktree records", async () => {
		await manager.upsertWorktree(createWorktree({ sessionIds: [] }));
		await manager.upsertWorktree(createWorktree({ id: "other-tree", workspaceName: "other", sessionIds: [] }));

		await expect(manager.unregisterWorkspace("ws")).rejects.toMatchObject({
			code: "workspace_has_worktrees",
			workspaceName: "ws",
			worktreeIds: ["fix-login"],
		});
		expect((await manager.getState()).workspaces.map((workspace) => workspace.name)).toContain("ws");
		expect((await manager.listWorktrees("ws")).map((worktree) => worktree.id)).toEqual(["fix-login"]);
		expect((await manager.listWorktrees("other")).map((worktree) => worktree.id)).toEqual(["other-tree"]);
	});

	it("unregisterWorkspace removes a normal empty workspace", async () => {
		await manager.upsertWorktree(createWorktree({ id: "other-tree", workspaceName: "other", sessionIds: [] }));

		await expect(manager.unregisterWorkspace("ws")).resolves.toEqual({ name: "ws", path: "/tmp/ws" });
		expect((await manager.getState()).workspaces.map((workspace) => workspace.name)).toEqual(["other"]);
		expect((await manager.listWorktrees("other")).map((worktree) => worktree.id)).toEqual(["other-tree"]);
	});
});

describe("stream authorization freshness", () => {
	it("invalidates an unchanged client grant when its workspace registration is removed or changed", async () => {
		const rpcGrant = createIrohRemotePresetAccess("full").rpcGrant;
		const workspace = { name: "ws", path: "/tmp/ws", allowedTools: "read" };
		const authorization: IrohRemoteClientAuthorizationSuccess = {
			ok: true,
			allowTools: "read",
			client: {
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["ws"],
				allowedTools: "read",
				rpcGrant,
				pairedAt: 1,
				lastSeenAt: 2,
			},
			paired: false,
			pairingSecretConsumed: false,
			workspace,
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
		};
		const manager = new IrohRemoteHostStateManager({
			initialState: {
				...createEmptyIrohRemoteHostState(),
				workspaces: [workspace],
				clients: [authorization.client],
			},
		});

		await expect(manager.isAuthorizationCurrent(authorization)).resolves.toBe(true);
		await manager.unregisterWorkspace("ws");
		await expect(manager.isAuthorizationCurrent(authorization)).resolves.toBe(false);
		await manager.upsertWorkspace({ ...workspace, path: "/tmp/replacement" });
		await expect(manager.isAuthorizationCurrent(authorization)).resolves.toBe(false);
		await manager.upsertWorkspace({ ...workspace, allowedTools: "read,bash" });
		await expect(manager.isAuthorizationCurrent(authorization)).resolves.toBe(false);
	});
});

describe("workspace unregister RPC safety", () => {
	it("returns a stable workspace_has_worktrees conflict without changing state", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createHostStateWithWorktrees() });

		const result = await handleIrohRemoteWorkspaceUnregisterRpcCommand(
			{ id: "remove-ws", type: "unregister_workspace", workspaceName: "ws" },
			{ stateManager: manager },
		);

		expect(result).toEqual({
			handled: true,
			response: {
				id: "remove-ws",
				type: "response",
				command: "unregister_workspace",
				success: false,
				error: "workspace_has_worktrees",
			},
		});
		expect((await manager.getState()).workspaces).toEqual([{ name: "ws", path: "/tmp/ws" }]);
		expect(await manager.listWorktrees("ws")).toEqual([createWorktree()]);
	});
});
