import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	getIrohRemoteRpcCommandCapabilities,
	IROH_REMOTE_RPC_CAPABILITIES,
	parseIrohRemoteRpcGrant,
} from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../src/core/remote/iroh/protocol.ts";
import {
	getIrohRemoteRpcFilterResult,
	IROH_REMOTE_RPC_PASSTHROUGH_TYPES,
} from "../src/core/remote/iroh/rpc-command-filter.ts";
import {
	createEmptyIrohRemoteHostState,
	parseIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { isControlRequest } from "../src/daemon/control-protocol.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Iroh remote RPC grants", () => {
	it("strictly parses versioned grants and accepts an empty capability set", () => {
		expect(parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 1, capabilities: [] })).toEqual({
			schemaVersion: 1,
			revision: 1,
			capabilities: [],
		});
		expect(() => parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 1, capabilities: ["unknown.v1"] })).toThrow(
			"unknown capability",
		);
		expect(() =>
			parseIrohRemoteRpcGrant({
				schemaVersion: 1,
				revision: 1,
				capabilities: ["conversation.observe.v1", "conversation.observe.v1"],
			}),
		).toThrow("duplicates");
		expect(() => parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 0, capabilities: [] })).toThrow(
			"greater than or equal to 1",
		);
		expect(() =>
			parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER + 1, capabilities: [] }),
		).toThrow("safe integer");
	});

	it("defines immutable coding, review, chat, and full presets", () => {
		const coding = createIrohRemotePresetAccess("coding");
		const review = createIrohRemotePresetAccess("review");
		const chat = createIrohRemotePresetAccess("chat");
		const full = createIrohRemotePresetAccess("full");
		expect(coding.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(full.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(coding.allowedTools.split(",")).toContain("image_gen");
		expect(full.allowedTools.split(",")).toContain("image_gen");
		expect(review.allowedTools).toBe("read,grep,find,ls");
		expect(chat.allowedTools).toBe("");
		expect(coding.rpcGrant.capabilities).toEqual([
			"conversation.observe.v1",
			"conversation.control.v1",
			"model.select.v1",
			"host.manage.v1",
		]);
		expect(review.rpcGrant.capabilities).toEqual(coding.rpcGrant.capabilities);
		expect(chat.rpcGrant.capabilities).toEqual(coding.rpcGrant.capabilities);
		expect(full.rpcGrant.capabilities).toEqual(IROH_REMOTE_RPC_CAPABILITIES);
	});

	it("classifies parameter-sensitive and management commands centrally", () => {
		for (const type of IROH_REMOTE_RPC_PASSTHROUGH_TYPES) {
			expect(getIrohRemoteRpcCommandCapabilities({ type }), `classification for ${type}`).toBeDefined();
		}
		for (const type of [
			"invoke_ui_action",
			"get_ui_action_completions",
			"start_mcp_server_auth",
			"remove_worktree",
			"list_workspace_directories",
		]) {
			expect(getIrohRemoteRpcCommandCapabilities({ type }), `classification for ${type}`).toBeDefined();
		}
		expect(getIrohRemoteRpcCommandCapabilities({ type: "prompt" })).toEqual(["conversation.control.v1"]);
		for (const type of ["set_agent_mode", "plan_execute", "plan_change", "plan_discard"]) {
			expect(getIrohRemoteRpcCommandCapabilities({ type })).toEqual(["conversation.control.v1"]);
		}
		expect(getIrohRemoteRpcCommandCapabilities({ type: "set_client_capabilities", features: [] })).toEqual([]);
		expect(
			getIrohRemoteRpcCommandCapabilities({
				type: "set_client_capabilities",
				features: ["host_action_requests.v1"],
			}),
		).toEqual(["host.manage.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "get_transcript" })).toEqual(["conversation.observe.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "get_transcript_entry_text" })).toEqual([
			"conversation.observe.v1",
		]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "set_model", persistDefault: false })).toEqual([
			"model.select.v1",
		]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "set_model" })).toEqual(["model.select.v1", "host.manage.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "set_thinking_level", persistDefault: true })).toEqual([
			"model.select.v1",
			"host.manage.v1",
		]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "create_worktree" })).toEqual(["worktrees.manage.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "list_worktrees" })).toEqual(["conversation.observe.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "unregister_workspace" })).toEqual(["workspace.manage.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "upload_device_logs" })).toEqual(["diagnostics.upload.v1"]);
	});

	it("returns stable structured denials without bypassing the static ceiling", () => {
		expect(
			getIrohRemoteRpcFilterResult(JSON.stringify({ id: "missing-grant", type: "get_state" }), undefined as never),
		).toMatchObject({
			allowed: false,
			response: { id: "missing-grant", error: "Remote RPC grant is missing or malformed" },
		});
		const observeOnly = createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant;
		expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: "1", type: "prompt" }), observeOnly)).toEqual({
			allowed: false,
			response: {
				id: "1",
				type: "response",
				command: "prompt",
				success: false,
				error: {
					code: "rpc_capability_denied",
					message: "RPC capability required: conversation.control.v1",
					requiredCapability: "conversation.control.v1",
				},
			},
		});
		expect(
			getIrohRemoteRpcFilterResult(
				JSON.stringify({
					id: "invoke-capability-denied",
					type: "invoke_ui_action",
					action: "session.new",
				}),
				observeOnly,
			),
		).toEqual({
			allowed: false,
			response: {
				id: "invoke-capability-denied",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: {
					code: "rpc_capability_denied",
					message: "RPC capability required: conversation.control.v1",
					requiredCapability: "conversation.control.v1",
				},
			},
		});
		expect(
			getIrohRemoteRpcFilterResult(
				JSON.stringify({
					id: "caps",
					type: "set_client_capabilities",
					features: ["host_action_requests.v1"],
				}),
				createIrohRemotePresetAccess("coding").rpcGrant,
			),
		).toMatchObject({ allowed: true });
		expect(
			getIrohRemoteRpcFilterResult(
				JSON.stringify({
					id: "caps-observe",
					type: "set_client_capabilities",
					features: ["host_action_requests.v1"],
				}),
				createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant,
			),
		).toMatchObject({
			allowed: false,
			response: {
				command: "set_client_capabilities",
				error: { code: "rpc_capability_denied", requiredCapability: "host.manage.v1" },
			},
		});
		expect(
			getIrohRemoteRpcFilterResult(
				JSON.stringify({ id: "caps-empty", type: "set_client_capabilities", features: [] }),
				createIrohRemotePresetAccess("coding").rpcGrant,
			),
		).toMatchObject({ allowed: true });

		const unsupported = getIrohRemoteRpcFilterResult(
			JSON.stringify({ id: "2", type: "local_only_command" }),
			createIrohRemotePresetAccess("full").rpcGrant,
		);
		expect(unsupported).toMatchObject({
			allowed: false,
			response: {
				command: "local_only_command",
				error: "RPC command not allowed over remote host: local_only_command",
			},
		});
	});

	it("requires grants on every persisted active, revoked, and pending record", () => {
		const base = { workspaces: [], worktrees: [], pendingPairingTickets: [], clients: [], revokedClients: [] };
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				clients: [
					{ nodeId: "n", label: "phone", allowedWorkspaces: [], allowedTools: "", pairedAt: 1, lastSeenAt: 1 },
				],
			}),
		).toThrow("client rpcGrant");
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				revokedClients: [
					{
						nodeId: "n",
						label: "phone",
						allowedWorkspaces: [],
						allowedTools: "",
						pairedAt: 1,
						lastSeenAt: 1,
						revokedAt: 2,
					},
				],
			}),
		).toThrow("revoked client rpcGrant");
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				pendingPairingTickets: [{ secretHash: "h", workspace: "ws", allowedTools: "", expiresAt: 2, createdAt: 1 }],
			}),
		).toThrow("pending pairing ticket rpcGrant");
	});

	it("snapshots each pairing ticket's selected grant", async () => {
		const manager = new IrohRemoteHostStateManager();
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "ws", path: "/tmp/ws" },
		});
		const review = createIrohRemotePresetAccess("review");
		const chat = createIrohRemotePresetAccess("chat");
		await engine.pair({
			irohTicket: "endpoint",
			secret: "review-secret",
			allowTools: review.allowedTools,
			rpcGrant: review.rpcGrant,
		});
		await engine.pair({
			irohTicket: "endpoint",
			secret: "chat-secret",
			allowTools: chat.allowedTools,
			rpcGrant: chat.rpcGrant,
		});
		const tickets = (await manager.getState()).pendingPairingTickets ?? [];
		expect(tickets).toHaveLength(2);
		expect(tickets.map((ticket) => ticket.allowedTools)).toEqual(["read,grep,find,ls", ""]);
		expect(tickets.map((ticket) => ticket.rpcGrant?.capabilities)).toEqual([
			review.rpcGrant.capabilities,
			chat.rpcGrant.capabilities,
		]);
	});

	it("atomically persists both access planes and rejects stale revisions", async () => {
		const path = mkdtempSync(join(tmpdir(), "volt-rpc-grant-"));
		temporaryDirectories.push(path);
		const statePath = join(path, "state.json");
		const coding = createIrohRemotePresetAccess("coding");
		await writeIrohRemoteHostState(statePath, {
			workspaces: [],
			clients: [
				{
					nodeId: "n",
					label: "phone",
					allowedWorkspaces: [],
					allowedTools: coding.allowedTools,
					rpcGrant: coding.rpcGrant,
					pairedAt: 1,
					lastSeenAt: 1,
				},
			],
		});
		const manager = new IrohRemoteHostStateManager({ statePath });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "voltd", path },
		});
		const review = createIrohRemotePresetAccess("review", 2);
		const updated = await engine.updateClientAccess("n", 1, review);
		expect(updated).toMatchObject({
			ok: true,
			client: { allowedTools: "read,grep,find,ls", rpcGrant: { revision: 2 } },
		});
		expect(await engine.updateClientAccess("n", 1, createIrohRemotePresetAccess("chat", 2))).toEqual({
			ok: false,
			reason: "revision_conflict",
			currentRevision: 2,
		});
		const reloaded = new IrohRemoteHostStateManager({ statePath });
		expect(await reloaded.getClient("n")).toMatchObject({
			allowedTools: "read,grep,find,ls",
			rpcGrant: { revision: 2, capabilities: review.rpcGrant.capabilities },
		});
	});

	it("fails safely before incrementing an exhausted revision", async () => {
		const full = createIrohRemotePresetAccess("full", Number.MAX_SAFE_INTEGER);
		const manager = new IrohRemoteHostStateManager({
			initialState: {
				workspaces: [],
				clients: [
					{
						nodeId: "n",
						label: "phone",
						allowedWorkspaces: [],
						allowedTools: full.allowedTools,
						rpcGrant: full.rpcGrant,
						pairedAt: 1,
						lastSeenAt: 1,
					},
				],
			},
		});

		await expect(
			manager.updateClientAccess("n", Number.MAX_SAFE_INTEGER, createIrohRemotePresetAccess("chat")),
		).resolves.toEqual({
			ok: false,
			reason: "revision_exhausted",
			currentRevision: Number.MAX_SAFE_INTEGER,
		});
		expect(await manager.getClient("n")).toMatchObject({
			allowedTools: full.allowedTools,
			rpcGrant: { revision: Number.MAX_SAFE_INTEGER, capabilities: full.rpcGrant.capabilities },
		});
		await expect(
			manager.updateClientAccess("n", Number.MAX_SAFE_INTEGER + 1, createIrohRemotePresetAccess("chat")),
		).rejects.toThrow("safe integer");
	});

	it("does not acknowledge ticket creation, pairing consumption, or revocation before durable writes", async () => {
		let persisted = createEmptyIrohRemoteHostState();
		let failNextWrite = false;
		const store = {
			read: () => parseIrohRemoteHostState(structuredClone(persisted)),
			write: async (state: typeof persisted) => {
				if (failNextWrite) {
					failNextWrite = false;
					throw new Error("injected flush failure");
				}
				persisted = parseIrohRemoteHostState(structuredClone(state));
			},
		};
		const createEngine = () =>
			new IrohRemoteHostEngine({
				stateManager: new IrohRemoteHostStateManager({ store }),
				workspace: { name: "ws", path: "/tmp/ws" },
				now: () => 100,
			});
		const pairOptions = { irohTicket: "endpoint", secret: "durable-secret", ttlMs: 1000 };

		failNextWrite = true;
		await expect(createEngine().pair(pairOptions)).rejects.toThrow("injected flush failure");
		expect(persisted.pendingPairingTickets).toEqual([]);

		await createEngine().pair(pairOptions);
		expect(persisted.pendingPairingTickets).toHaveLength(1);
		const hello = {
			type: "volt_iroh_hello" as const,
			protocol: "volt-rpc/0" as const,
			workspace: "ws",
			secret: "durable-secret",
			clientLabel: "phone",
			mode: "conversation" as const,
			conversation: { target: "new" as const },
		};

		failNextWrite = true;
		await expect(createEngine().authorizeHello(hello, "client-node")).rejects.toThrow("injected flush failure");
		expect(persisted.clients).toEqual([]);
		expect(persisted.pendingPairingTickets).toHaveLength(1);

		const paired = await createEngine().authorizeHello(hello, "client-node");
		expect(paired.ok).toBe(true);
		expect(persisted.clients).toHaveLength(1);
		expect(persisted.pendingPairingTickets).toEqual([]);

		failNextWrite = true;
		await expect(createEngine().revokeClient("client-node")).rejects.toThrow("injected flush failure");
		expect(persisted.clients).toHaveLength(1);
		expect(persisted.revokedClients).toEqual([]);

		await expect(createEngine().revokeClient("client-node")).resolves.toMatchObject({ revoked: true });
		const restarted = new IrohRemoteHostStateManager({ store });
		expect(await restarted.getClient("client-node")).toBeUndefined();
		expect(await restarted.listRevokedClients()).toEqual([
			expect.objectContaining({ nodeId: "client-node", revokedAt: 100 }),
		]);
	});

	it("parses preset and explicit control requests and rejects mixed access", () => {
		expect(isControlRequest({ type: "pair_request", id: "1", access: "coding" })).toBe(true);
		expect(
			isControlRequest({
				type: "pair_request",
				id: "2",
				allowedTools: [],
				rpcCapabilities: [],
			}),
		).toBe(true);
		expect(
			isControlRequest({
				type: "client_access_update",
				id: "3",
				clientNodeId: "n",
				expectedRevision: 1,
				access: "full",
			}),
		).toBe(true);
		expect(
			isControlRequest({
				type: "pair_request",
				id: "4",
				access: "coding",
				allowedTools: [],
				rpcCapabilities: [],
			}),
		).toBe(false);
		expect(
			isControlRequest({
				type: "client_access_update",
				id: "unsafe",
				clientNodeId: "n",
				expectedRevision: Number.MAX_SAFE_INTEGER + 1,
				access: "full",
			}),
		).toBe(false);
		expect(createIrohRemoteExplicitAccess([], []).rpcGrant.capabilities).toEqual([]);
	});
});
