import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess, type IrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import {
	handleIrohRemoteWorktreeRpcCommand,
	type IrohRemoteWorktreeRpcBackend,
	type IrohRemoteWorktreeSummary,
} from "../src/core/remote/iroh/worktree-rpc.ts";
import { runWorkspaceManagementStream, runWorktreeManagementStream } from "../src/daemon/workspace-streams.ts";
import { ManualIrohRecvStream, ManualIrohSendStream, parseWrittenObjects } from "./iroh-stream-doubles.ts";

const HOST_WORKSPACE_PATH = "/home/user/projects/repo";
const HOST_WORKTREES_ROOT = "/home/user/.volt/agent/worktrees";
const HOST_CHECKOUT_PATH = `${HOST_WORKTREES_ROOT}/--home-user-projects-repo--/fix-login`;

function createHostRecord(): IrohRemoteWorkspaceWorktree {
	return {
		id: "fix-login",
		workspaceName: "ws",
		path: HOST_CHECKOUT_PATH,
		branch: "volt/fix-login",
		baseRef: "main",
		createdAt: 1_751_900_000_000,
		sessionIds: ["s-abc"],
	};
}

function createBackend(): IrohRemoteWorktreeRpcBackend {
	// Backend results intentionally carry host-record shapes (with `path` and
	// `workspaceName`) to prove the RPC layer strips them from the wire.
	const record: IrohRemoteWorktreeSummary = createHostRecord();
	return {
		createWorktree: vi.fn(async () => ({ ok: true as const, worktree: record })),
		listWorktrees: vi.fn(async () => ({
			ok: true as const,
			worktrees: [
				{
					...createHostRecord(),
					available: true,
					dirty: false,
					aheadBehind: { ahead: 3, behind: 1 },
				} as IrohRemoteWorktreeSummary,
			],
		})),
		removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 1, closedStreamCount: 1 })),
	};
}

function createAuthorization(
	rpcGrant: IrohRemoteRpcGrant = createIrohRemotePresetAccess("full").rpcGrant,
): IrohRemoteClientAuthorizationSuccess {
	return {
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
		workspace: { name: "ws", path: HOST_WORKSPACE_PATH },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

/** Recursively assert that no wire payload carries filesystem paths. */
function assertNoFilesystemPaths(value: unknown): void {
	if (typeof value === "string") {
		expect(value).not.toContain(HOST_WORKSPACE_PATH);
		expect(value).not.toContain(HOST_WORKTREES_ROOT);
		expect(value).not.toContain(HOST_CHECKOUT_PATH);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			assertNoFilesystemPaths(entry);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, entry] of Object.entries(value)) {
			expect(key).not.toBe("path");
			expect(key).not.toBe("workspacePath");
			assertNoFilesystemPaths(entry);
		}
	}
}

describe("worktree RPC command helpers", () => {
	const options = { authorizedWorkspaceName: "ws", backend: createBackend() };

	it("ignores non-worktree commands", async () => {
		expect(await handleIrohRemoteWorktreeRpcCommand({ type: "list_sessions" }, options)).toEqual({
			handled: false,
		});
		expect(await handleIrohRemoteWorktreeRpcCommand({ type: 42 }, options)).toEqual({ handled: false });
	});

	it("rejects any field outside the allowlist (including inbound paths) with invalid_request", async () => {
		for (const command of [
			{ id: "1", type: "create_worktree", workspaceName: "ws", path: "/etc" },
			{ id: "1", type: "create_worktree", workspaceName: "ws", workspacePath: "/etc" },
			{ id: "1", type: "create_worktree", workspaceName: "ws", bogus: true },
			{ id: "2", type: "list_worktrees", workspaceName: "ws", force: true },
			{ id: "3", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login", path: "/etc" },
		]) {
			const result = await handleIrohRemoteWorktreeRpcCommand(command, options);
			expect(result).toMatchObject({
				handled: true,
				response: { success: false, error: "invalid_request" },
			});
		}
	});

	it("rejects cross-workspace requests with session_mismatch and missing names with invalid_request", async () => {
		for (const type of ["create_worktree", "list_worktrees"]) {
			expect(
				await handleIrohRemoteWorktreeRpcCommand({ id: "1", type, workspaceName: "other" }, options),
			).toMatchObject({ handled: true, response: { success: false, error: "session_mismatch" } });
			expect(await handleIrohRemoteWorktreeRpcCommand({ id: "1", type }, options)).toMatchObject({
				handled: true,
				response: { success: false, error: "invalid_request" },
			});
		}
		expect(
			await handleIrohRemoteWorktreeRpcCommand(
				{ id: "1", type: "remove_worktree", workspaceName: "other", worktreeId: "fix-login" },
				options,
			),
		).toMatchObject({ handled: true, response: { success: false, error: "session_mismatch" } });
	});

	it("validates create/remove field types before touching the backend", async () => {
		const backend = createBackend();
		const strict = { authorizedWorkspaceName: "ws", backend };
		for (const command of [
			{ id: "1", type: "create_worktree", workspaceName: "ws", worktreeName: "UPPER" },
			{ id: "1", type: "create_worktree", workspaceName: "ws", branch: 42 },
			{ id: "1", type: "create_worktree", workspaceName: "ws", baseRef: 42 },
			{ id: "1", type: "create_worktree", workspaceName: "ws", workingDirectory: "../escape" },
			{ id: "2", type: "remove_worktree", workspaceName: "ws", worktreeId: "../evil" },
			{ id: "2", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login", force: "yes" },
		]) {
			const result = await handleIrohRemoteWorktreeRpcCommand(command, strict);
			expect(result).toMatchObject({
				handled: true,
				response: { success: false, error: "invalid_request" },
			});
		}
		expect(backend.createWorktree).not.toHaveBeenCalled();
		expect(backend.removeWorktree).not.toHaveBeenCalled();
	});

	it("passes relative workingDirectory to create backend", async () => {
		const backend = createBackend();
		const result = await handleIrohRemoteWorktreeRpcCommand(
			{
				id: "1",
				type: "create_worktree",
				workspaceName: "ws",
				worktreeName: "fix-login",
				workingDirectory: "packages/app",
			},
			{ authorizedWorkspaceName: "ws", backend },
		);

		expect(result).toMatchObject({ handled: true, response: { success: true } });
		expect(backend.createWorktree).toHaveBeenCalledExactlyOnceWith("ws", {
			id: "fix-login",
			workingDirectory: "packages/app",
		});
	});

	it("maps backend failures to error responses without detail leakage", async () => {
		const backend: IrohRemoteWorktreeRpcBackend = {
			...createBackend(),
			createWorktree: async () => ({
				ok: false,
				error: "worktree_branch_conflict",
				detail: `branch exists in ${HOST_WORKSPACE_PATH}`,
			}),
		};
		const result = await handleIrohRemoteWorktreeRpcCommand(
			{ id: "1", type: "create_worktree", workspaceName: "ws" },
			{ authorizedWorkspaceName: "ws", backend },
		);
		expect(result).toMatchObject({
			handled: true,
			response: { id: "1", success: false, error: "worktree_branch_conflict" },
		});
		if (result.handled) {
			assertNoFilesystemPaths(result.response);
		}
	});

	it("returns wire summaries with no filesystem paths on create/list/remove", async () => {
		const create = await handleIrohRemoteWorktreeRpcCommand(
			{ id: "1", type: "create_worktree", workspaceName: "ws", worktreeName: "fix-login", baseRef: "main" },
			options,
		);
		expect(create).toMatchObject({
			handled: true,
			response: {
				id: "1",
				type: "response",
				command: "create_worktree",
				success: true,
				data: { worktree: { id: "fix-login", branch: "volt/fix-login", baseRef: "main" } },
			},
		});
		const list = await handleIrohRemoteWorktreeRpcCommand(
			{ id: "2", type: "list_worktrees", workspaceName: "ws" },
			options,
		);
		expect(list).toMatchObject({
			handled: true,
			response: {
				success: true,
				data: {
					worktrees: [
						{
							id: "fix-login",
							available: true,
							dirty: false,
							sessionIds: ["s-abc"],
							// Merge-back guidance (§5.3) crosses the wire; paths still don't.
							aheadBehind: { ahead: 3, behind: 1 },
						},
					],
				},
			},
		});
		const remove = await handleIrohRemoteWorktreeRpcCommand(
			{ id: "3", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login", force: true },
			options,
		);
		expect(remove).toMatchObject({
			handled: true,
			response: {
				success: true,
				data: { worktreeId: "fix-login", removed: true, stoppedRuntimeCount: 1, closedStreamCount: 1 },
			},
		});
		for (const result of [create, list, remove]) {
			if (result.handled) {
				assertNoFilesystemPaths(result.response);
			}
		}
	});
});

describe("manage_worktrees management stream", () => {
	async function runStream(
		lines: object[],
		rpcGrant = createIrohRemotePresetAccess("full").rpcGrant,
		isRpcGrantCurrent: () => boolean | Promise<boolean> = async () => true,
	) {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		for (const line of lines) {
			recv.pushLine(JSON.stringify(line));
		}
		recv.end();
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const backend = createBackend();
		const closeStream = vi.fn();
		await runWorktreeManagementStream(
			{
				stream: { recv, send },
				initialInput: [],
				authorization: createAuthorization(rpcGrant),
				isRpcGrantCurrent,
				closeStream,
			},
			{
				auditLogger: new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } }),
				worktrees: backend,
				additionalRedactedPaths: [HOST_WORKTREES_ROOT],
			},
		);
		return { frames: parseWrittenObjects(send), auditEvents, backend, closeStream };
	}

	it("serves create/list/remove and keeps the stream open", async () => {
		const { frames, auditEvents, closeStream } = await runStream([
			{ id: "1", type: "create_worktree", workspaceName: "ws", worktreeName: "fix-login" },
			{ id: "2", type: "list_worktrees", workspaceName: "ws" },
			{ id: "3", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login", force: true },
		]);
		expect(frames).toHaveLength(3);
		expect(frames[0]).toMatchObject({ id: "1", command: "create_worktree", success: true });
		expect(frames[1]).toMatchObject({ id: "2", command: "list_worktrees", success: true });
		expect(frames[2]).toMatchObject({ id: "3", command: "remove_worktree", success: true });
		expect(closeStream).not.toHaveBeenCalled();
		// Audit: create + remove, never list.
		expect(auditEvents.map((event) => event.type)).toEqual(["worktree_created", "worktree_removed"]);
		expect(auditEvents[0]).toMatchObject({
			clientNodeId: "n-phone",
			workspace: "ws",
			success: true,
			details: { source: "remote_worktree_management_stream", worktreeId: "fix-login" },
		});
	});

	it("does not dispatch an unterminated utility command", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const backend = createBackend();
		recv.end();

		await runWorktreeManagementStream(
			{
				stream: { recv, send },
				initialInput: Buffer.from(JSON.stringify({ id: "partial", type: "create_worktree", workspaceName: "ws" })),
				authorization: createAuthorization(),
				isRpcGrantCurrent: () => true,
				closeStream: vi.fn(),
			},
			{
				auditLogger: new IrohRemoteAuditLogger(),
				worktrees: backend,
			},
		);

		expect(parseWrittenObjects(send)).toEqual([]);
		expect(backend.createWorktree).not.toHaveBeenCalled();
	});

	it("closes before executing the next command when the persisted grant revision becomes stale", async () => {
		let checks = 0;
		const { frames, backend, closeStream } = await runStream(
			[
				{ id: "1", type: "list_worktrees", workspaceName: "ws" },
				{ id: "2", type: "create_worktree", workspaceName: "ws" },
			],
			createIrohRemotePresetAccess("full").rpcGrant,
			() => ++checks === 1,
		);
		expect(frames).toHaveLength(1);
		expect(backend.listWorktrees).toHaveBeenCalledOnce();
		expect(backend.createWorktree).not.toHaveBeenCalled();
		expect(closeStream).toHaveBeenCalledWith("access_updated");
	});

	it("denies utility commands without the required capability", async () => {
		const { frames, backend } = await runStream(
			[{ id: "1", type: "create_worktree", workspaceName: "ws" }],
			createIrohRemotePresetAccess("coding").rpcGrant,
		);
		expect(frames[0]).toMatchObject({
			id: "1",
			command: "create_worktree",
			success: false,
			error: { code: "rpc_capability_denied", requiredCapability: "worktrees.manage.v1" },
		});
		expect(backend.createWorktree).not.toHaveBeenCalled();
	});

	it("never puts filesystem paths on the wire", async () => {
		const { frames } = await runStream([
			{ id: "1", type: "create_worktree", workspaceName: "ws" },
			{ id: "2", type: "list_worktrees", workspaceName: "ws" },
			{ id: "3", type: "remove_worktree", workspaceName: "ws", worktreeId: "fix-login" },
		]);
		for (const frame of frames) {
			assertNoFilesystemPaths(frame);
		}
	});

	it("rejects non-worktree commands with unsupported_on_workspace_management_stream", async () => {
		const { frames, backend, auditEvents } = await runStream([
			{ id: "1", type: "unregister_workspace", workspaceName: "ws" },
			{ id: "2", type: "list_sessions" },
		]);
		expect(frames[0]).toMatchObject({
			id: "1",
			command: "unregister_workspace",
			success: false,
			error: "unsupported_on_workspace_management_stream",
		});
		expect(frames[1]).toMatchObject({
			id: "2",
			command: "list_sessions",
			success: false,
			error: "unsupported_on_workspace_management_stream",
		});
		expect(backend.createWorktree).not.toHaveBeenCalled();
		expect(auditEvents).toEqual([]);
	});

	it("rejects allowlist violations and cross-workspace names on the stream", async () => {
		const { frames, auditEvents } = await runStream([
			{ id: "1", type: "create_worktree", workspaceName: "ws", path: "/etc" },
			{ id: "2", type: "create_worktree", workspaceName: "other" },
			{ id: "3", type: "remove_worktree", workspaceName: "other", worktreeId: "fix-login" },
			"not json" as unknown as object,
		]);
		expect(frames[0]).toMatchObject({ id: "1", success: false, error: "invalid_request" });
		expect(frames[1]).toMatchObject({ id: "2", success: false, error: "session_mismatch" });
		expect(frames[2]).toMatchObject({ id: "3", success: false, error: "session_mismatch" });
		expect(frames[3]).toMatchObject({ success: false, error: "invalid_request" });
		// Failed create/remove attempts are still audited.
		expect(auditEvents.map((event) => event.success)).toEqual([false, false, false]);
	});
});

describe("workspace unregister management stream", () => {
	it("returns and audits workspace_has_worktrees without closing the stream", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		recv.pushLine(JSON.stringify({ id: "remove", type: "unregister_workspace", workspaceName: "ws" }));
		recv.end();
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const closeStream = vi.fn();
		const unregisterWorkspace = vi.fn(async () => ({
			ok: false as const,
			error: "workspace_has_worktrees",
			details: { worktreeCount: 1, worktreeIds: ["fix-login"] },
		}));
		await runWorkspaceManagementStream(
			{
				stream: { recv, send },
				initialInput: [],
				authorization: createAuthorization(),
				isRpcGrantCurrent: () => true,
				closeStream,
			},
			{
				auditLogger: new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } }),
				commandContext: {
					stateManager: new IrohRemoteHostStateManager({
						initialState: { workspaces: [], worktrees: [], clients: [] },
					}),
					sessionListCursors: new Map(),
					sessionListCursorTtlMs: 60_000,
				},
				unregisterWorkspace,
			},
		);

		expect(parseWrittenObjects(send)).toEqual([
			{
				id: "remove",
				type: "response",
				command: "unregister_workspace",
				success: false,
				error: "workspace_has_worktrees",
			},
		]);
		expect(unregisterWorkspace).toHaveBeenCalledOnce();
		expect(closeStream).not.toHaveBeenCalled();
		expect(auditEvents).toEqual([
			{
				timestamp: expect.any(Number),
				type: "workspace_unregistered",
				clientNodeId: "n-phone",
				workspace: "ws",
				success: false,
				error: "workspace_has_worktrees",
				details: {
					source: "remote_workspace_management_stream",
					worktreeCount: 1,
					worktreeIds: ["fix-login"],
				},
			},
		]);
	});
});
