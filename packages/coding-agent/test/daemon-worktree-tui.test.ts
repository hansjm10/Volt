/**
 * Phase 2 (TUI) worktree integration — worktrees-design.md §5.2 / §9 Phase 2:
 * worktree_resolve/worktree_bind control handling, the auto-registration fix in
 * the TUI's workspace resolution, the /worktree control-plane helper, relay
 * sanitization root switching, capability gating, takeover refusal on a
 * missing checkout, trust-path pinning helpers, and new-session cwd/sessionDir
 * overrides.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import {
	CONTROL_WORKTREES_CAPABILITY,
	type ControlRequest,
	type ControlResponse,
	type RelayPreamble,
} from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import type { EnsureDaemonResult } from "../src/daemon/spawn.ts";
import {
	evaluateWorktreeRelayGate,
	getWorktreeCheckoutPath,
	getWorktreesRoot,
	handleWorktreeControlRequest,
	isPathUnderWorktreesRoot,
	resolveWorktreeParentCheckout,
	WorktreeManager,
} from "../src/daemon/worktree-manager.ts";
import {
	createDaemonAttach,
	getRelayServingSanitizerOptions,
	openDaemonWorktreeControl,
	resolveDaemonWorkspaceForCwd,
} from "../src/modes/interactive/daemon-attach.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestIrohConversationOptions,
	createTestSession,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
} from "./iroh-stream-doubles.ts";

const cleanups: Array<() => Promise<void> | void> = [];
const HOST_FIXTURE_ROOT = join(tmpdir(), "volt-worktree-tui");
const HOST_PARENT_PATH = join(HOST_FIXTURE_ROOT, "parent-repo");
const HOST_AGENT_DIR = join(HOST_FIXTURE_ROOT, ".volt", "agent");
const HOST_WORKTREE_PATH = join(getWorktreesRoot(HOST_AGENT_DIR), "--repo--", "fix-login");

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

function makeTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function createStubConnection(): { connection: ControlConnection; sent: ControlResponse[] } {
	const sent: ControlResponse[] = [];
	const connection: ControlConnection = {
		connectionId: "c-test",
		client: "tui",
		pid: 1,
		version: "0.0.0-test",
		capabilities: new Set([CONTROL_WORKTREES_CAPABILITY]),
		send(message) {
			sent.push(message as ControlResponse);
		},
		close() {},
	};
	return { connection, sent };
}

async function createWorktreeFixture(): Promise<{
	agentDir: string;
	workspacePath: string;
	checkoutPath: string;
	stateManager: IrohRemoteHostStateManager;
	manager: WorktreeManager;
	worktree: IrohRemoteWorkspaceWorktree;
}> {
	const agentDir = makeTempDir("volt-wt-tui-agent-");
	const workspacePath = join(agentDir, "repo");
	mkdirSync(workspacePath, { recursive: true });
	const checkoutPath = getWorktreeCheckoutPath(agentDir, workspacePath, "fix-login");
	mkdirSync(checkoutPath, { recursive: true });
	const stateManager = new IrohRemoteHostStateManager();
	await stateManager.upsertWorkspace({ name: "repo", path: workspacePath });
	const worktree: IrohRemoteWorkspaceWorktree = {
		id: "fix-login",
		workspaceName: "repo",
		path: checkoutPath,
		branch: "volt/fix-login",
		createdAt: 1,
		sessionIds: [],
	};
	await stateManager.upsertWorktree(worktree);
	const manager = new WorktreeManager({
		agentDir,
		stateManager,
		auditLogger: new IrohRemoteAuditLogger(),
		runGit: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
	});
	return { agentDir, workspacePath, checkoutPath, stateManager, manager, worktree };
}

describe("worktree_resolve / worktree_bind control requests (§5.2.2)", () => {
	it("resolves the checkout path and nested paths to the parent workspace", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		for (const path of [fixture.checkoutPath, join(fixture.checkoutPath, "src", "deep")]) {
			sent.length = 0;
			await handleWorktreeControlRequest(
				connection,
				{ type: "worktree_resolve", id: "1", path },
				{ manager: fixture.manager, stateManager: fixture.stateManager },
			);
			expect(sent).toEqual([
				{
					type: "worktree_resolve_result",
					id: "1",
					workspaceName: "repo",
					workspacePath: fixture.workspacePath,
					worktreeId: "fix-login",
					worktreePath: fixture.checkoutPath,
				},
			]);
		}
	});

	it("answers not_found for paths outside any worktree", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_resolve", id: "2", path: fixture.workspacePath },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: "error", id: "2", code: "not_found" });
	});

	it("worktree_bind records the session binding; unknown ids fail", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_bind", id: "3", workspaceName: "repo", worktreeId: "fix-login", sessionId: "s-tui" },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent).toEqual([{ type: "ok", id: "3" }]);
		const bound = await fixture.stateManager.findWorktreeForSession("repo", "s-tui");
		expect(bound?.id).toBe("fix-login");

		sent.length = 0;
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_bind", id: "4", workspaceName: "repo", worktreeId: "nope", sessionId: "s-tui" },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent[0]).toMatchObject({ type: "error", id: "4", code: "worktree_not_found" });
	});
});

describe("resolveDaemonWorkspaceForCwd (§5.2.2 auto-registration fix)", () => {
	function createFakeClient(handlers: {
		workspaces: Array<{ name: string; path: string }>;
		resolve?: (path: string) => ControlResponse;
	}) {
		const requests: ControlRequest[] = [];
		const request = vi.fn(async (req: Omit<ControlRequest, "id">): Promise<ControlResponse> => {
			const full = { ...req, id: "x" } as ControlRequest;
			requests.push(full);
			if (full.type === "status") {
				return {
					type: "status_result",
					id: "x",
					version: "0",
					protocolVersion: 1,
					pid: 1,
					startedAtMs: 0,
					leases: [],
					phoneConnections: 0,
					workspaces: handlers.workspaces,
					clients: [],
					keepAwake: { enabled: false, state: "disabled" },
				};
			}
			if (full.type === "worktree_resolve") {
				return (
					handlers.resolve?.(full.path) ?? {
						type: "error",
						id: "x",
						code: "not_found",
						message: "not a worktree",
					}
				);
			}
			if (full.type === "workspace_register") {
				return { type: "ok", id: "x" };
			}
			throw new Error(`unexpected request ${full.type}`);
		});
		return { request, requests };
	}

	it("uses the parent workspace on a worktree_resolve hit and never auto-registers", async () => {
		const client = createFakeClient({
			workspaces: [{ name: "repo", path: HOST_PARENT_PATH }],
			resolve: () => ({
				type: "worktree_resolve_result",
				id: "x",
				workspaceName: "repo",
				workspacePath: HOST_PARENT_PATH,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
			}),
		});
		const resolved = await resolveDaemonWorkspaceForCwd(client, HOST_WORKTREE_PATH);
		expect(resolved).toEqual({ name: "repo", path: HOST_PARENT_PATH, worktreeId: "fix-login" });
		expect(client.requests.some((req) => req.type === "workspace_register")).toBe(false);
	});

	it("keeps the auto-register fallback on a miss", async () => {
		const client = createFakeClient({ workspaces: [{ name: "repo", path: HOST_PARENT_PATH }] });
		const projectPath = join(HOST_FIXTURE_ROOT, "elsewhere", "project");
		const resolved = await resolveDaemonWorkspaceForCwd(client, projectPath);
		expect(resolved).toEqual({ name: "project", path: projectPath });
		const register = client.requests.find((req) => req.type === "workspace_register");
		expect(register).toMatchObject({ name: "project", path: projectPath });
	});

	it("prefers the longest path-prefix match after checking managed worktrees", async () => {
		const client = createFakeClient({ workspaces: [{ name: "repo", path: HOST_PARENT_PATH }] });
		const resolved = await resolveDaemonWorkspaceForCwd(client, join(HOST_PARENT_PATH, "sub", "dir"));
		expect(resolved).toEqual({ name: "repo", path: HOST_PARENT_PATH });
		expect(client.requests.map((req) => req.type)).toEqual(["status", "worktree_resolve"]);
	});
});

interface ControlHarness {
	agentDir: string;
	socketPath: string;
	server: ControlServer;
	requests: ControlRequest[];
	connections: ControlConnection[];
	/** Connection that carried each request (probe connections carry only status). */
	requestConnections: Array<{ connection: ControlConnection; request: ControlRequest }>;
}

/** Real control server on the agentDir's daemon socket path, scripted responses. */
async function startControlHarness(
	respond: (connection: ControlConnection, request: ControlRequest) => void,
): Promise<ControlHarness> {
	const agentDir = makeTempDir("volt-wt-ctl-");
	const paths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const requests: ControlRequest[] = [];
	const connections: ControlConnection[] = [];
	const requestConnections: Array<{ connection: ControlConnection; request: ControlRequest }> = [];
	const server = await startControlServer({
		socketPath: paths.socketPath,
		version: "0.0.0-test",
		handlers: {
			onRequest(connection, request) {
				if (!connections.includes(connection)) {
					connections.push(connection);
				}
				requests.push(request);
				requestConnections.push({ connection, request });
				respond(connection, request);
			},
		},
	});
	cleanups.push(() => server.close());
	return { agentDir, socketPath: paths.socketPath, server, requests, connections, requestConnections };
}

function statusResult(id: string, workspaces: Array<{ name: string; path: string }>): ControlResponse {
	return {
		type: "status_result",
		id,
		version: "0.0.0-test",
		protocolVersion: 1,
		pid: 1,
		startedAtMs: 0,
		leases: [],
		phoneConnections: 0,
		workspaces,
		clients: [],
		keepAwake: { enabled: false, state: "disabled" },
	};
}

describe("createDaemonAttach + control server integration", () => {
	it("advertises the worktrees capability and lease-acquires under the parent workspace on a worktree_resolve hit", async () => {
		const harness = await startControlHarness((connection, request) => {
			if (request.type === "status") {
				connection.send(statusResult(request.id, [{ name: "repo", path: HOST_PARENT_PATH }]));
				return;
			}
			if (request.type === "worktree_resolve") {
				connection.send({
					type: "worktree_resolve_result",
					id: request.id,
					workspaceName: "repo",
					workspacePath: HOST_PARENT_PATH,
					worktreeId: "fix-login",
					worktreePath: request.path,
				});
				return;
			}
			if (request.type === "lease_acquire") {
				connection.send({
					type: "lease_granted",
					id: request.id,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					handoff: "none",
				});
				return;
			}
			connection.send({ type: "ok", id: request.id });
		});

		// The TUI's cwd is INSIDE a daemon-managed worktree, not the parent repo.
		const worktreeCwd = join(getWorktreesRoot(harness.agentDir), "--parent-repo--", "fix-login");
		mkdirSync(worktreeCwd, { recursive: true });
		const attach = createDaemonAttach({ cwd: worktreeCwd, agentDir: harness.agentDir });
		cleanups.push(() => attach.dispose());
		await attach.start();
		const outcome = await attach.acquire("s-worktree");

		expect(outcome).toEqual({ kind: "granted", handoff: "none" });
		expect(attach.workspaceName()).toBe("repo");
		const bindIndex = harness.requests.findIndex((request) => request.type === "worktree_bind");
		const leaseIndex = harness.requests.findIndex((request) => request.type === "lease_acquire");
		expect(harness.requests[bindIndex]).toMatchObject({
			workspaceName: "repo",
			worktreeId: "fix-login",
			sessionId: "s-worktree",
		});
		expect(bindIndex).toBeLessThan(leaseIndex);
		expect(harness.requests[leaseIndex]).toMatchObject({ workspaceName: "repo", sessionId: "s-worktree" });
		// §5.2.2: no bogus workspace was auto-registered for the worktree path.
		expect(harness.requests.some((request) => request.type === "workspace_register")).toBe(false);
		// §5.2.3: the daemon can gate relay offers on the TUI's capability. The
		// lease-holding connection (not the initial probe) must advertise it.
		const leasePair = harness.requestConnections.find((pair) => pair.request.type === "lease_acquire");
		expect(leasePair?.connection.capabilities.has(CONTROL_WORKTREES_CAPABILITY)).toBe(true);
	});

	it("forwards relayed notification delivery through the resolved workspace", async () => {
		const harness = await startControlHarness((connection, request) => {
			if (request.type === "status") {
				connection.send(statusResult(request.id, [{ name: "repo", path: HOST_PARENT_PATH }]));
				return;
			}
			if (request.type === "relay_notification_delivery") {
				connection.send({ type: "relay_push_delivery_result", id: request.id, status: "sent" });
				return;
			}
			connection.send({ type: "ok", id: request.id });
		});
		const attach = createDaemonAttach({ cwd: join(HOST_PARENT_PATH, "sub"), agentDir: harness.agentDir });
		cleanups.push(() => attach.dispose());
		await attach.start();

		await expect(
			attach.relayNotificationDelivery.deliverNotification("n-1", "s-relay", {
				eventId: "conversation:s-relay:run-1:completed",
				hostNodeId: "a".repeat(64),
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				sessionId: "s-relay",
				workspaceName: "repo",
			}),
		).resolves.toBe("sent");
		const notificationRequest = harness.requests.find((request) => request.type === "relay_notification_delivery");
		expect(notificationRequest).toMatchObject({
			clientNodeId: "n-1",
			workspaceName: "repo",
			sessionId: "s-relay",
		});
	});

	it("exposes an empty capability set for clients that do not advertise one", async () => {
		const harness = await startControlHarness((connection, request) => {
			connection.send(statusResult(request.id, []));
		});
		const client = createDaemonClient({
			socketPath: harness.socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: false,
		});
		cleanups.push(() => client.close());
		await client.connect();
		await client.request({ type: "status" });
		expect(harness.connections[0]?.capabilities.size).toBe(0);
	});
});

describe("openDaemonWorktreeControl (§5.2.1)", () => {
	it("creates a worktree in the resolved workspace and binds the session", async () => {
		const harness = await startControlHarness((connection, request) => {
			if (request.type === "status") {
				connection.send(statusResult(request.id, [{ name: "repo", path: HOST_PARENT_PATH }]));
				return;
			}
			if (request.type === "worktree_create") {
				connection.send({
					type: "worktree_result",
					id: request.id,
					worktree: {
						id: request.worktreeName ?? "generated-slug-01",
						workspaceName: request.workspaceName,
						path: join(
							getWorktreesRoot(HOST_AGENT_DIR),
							"--parent-repo--",
							request.worktreeName ?? "generated-slug-01",
						),
						branch: `volt/${request.worktreeName ?? "generated-slug-01"}`,
						createdAt: 1,
						sessionIds: [],
					},
				});
				return;
			}
			connection.send({ type: "ok", id: request.id });
		});

		const ensureDaemon = async (agentDir: string): Promise<EnsureDaemonResult> => ({
			healthy: true,
			state: "healthy",
			socketPath: getDaemonPaths(agentDir).socketPath,
			spawned: false,
		});
		const opened = await openDaemonWorktreeControl({
			cwd: join(HOST_PARENT_PATH, "sub"),
			agentDir: harness.agentDir,
			ensureDaemon,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) {
			return;
		}
		cleanups.push(() => opened.control.close());
		expect(opened.control.workspaceName).toBe("repo");
		expect(opened.control.workspacePath).toBe(HOST_PARENT_PATH);

		const created = await opened.control.createWorktree("fix-login");
		expect(created).toMatchObject({ ok: true, worktree: { id: "fix-login", branch: "volt/fix-login" } });
		expect(await opened.control.bindSession("fix-login", "s-new")).toBe(true);
		const bind = harness.requests.find((request) => request.type === "worktree_bind");
		expect(bind).toMatchObject({ workspaceName: "repo", worktreeId: "fix-login", sessionId: "s-new" });
	});

	it("fails fast when the daemon is unavailable", async () => {
		const agentDir = makeTempDir("volt-wt-nodaemon-");
		const opened = await openDaemonWorktreeControl({
			cwd: join(HOST_FIXTURE_ROOT, "anywhere"),
			agentDir,
			ensureDaemon: async () => ({
				healthy: false,
				state: "not-running",
				socketPath: getDaemonPaths(agentDir).socketPath,
				spawned: true,
			}),
		});
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			expect(opened.error).toContain("not-running");
		}
	});
});

describe("relay sanitization root switching (§5.2.3)", () => {
	const authorizationBase = {
		clientNodeId: "n-1",
		workspaceName: "repo",
		workspacePath: HOST_PARENT_PATH,
		allowedTools: "read",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
	} satisfies RelayPreamble["authorization"];

	it("keeps the parent root for non-worktree conversations", () => {
		expect(getRelayServingSanitizerOptions(authorizationBase, HOST_AGENT_DIR)).toEqual({
			workspacePath: HOST_PARENT_PATH,
		});
	});

	it("switches the root to the worktree and redacts the parent + worktrees root", () => {
		const options = getRelayServingSanitizerOptions(
			{
				...authorizationBase,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
			},
			HOST_AGENT_DIR,
		);
		expect(options).toEqual({
			workspacePath: HOST_WORKTREE_PATH,
			additionalRedactedPaths: [HOST_PARENT_PATH, getWorktreesRoot(HOST_AGENT_DIR)],
		});
	});

	it("maps nested worktree relay roots back under the registered workspace", () => {
		const options = getRelayServingSanitizerOptions(
			{
				...authorizationBase,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
				worktreeSourceRootRelativePath: "Volt",
			},
			HOST_AGENT_DIR,
		);
		expect(options).toEqual({
			remoteWorkspacePath: "/workspace/Volt",
			workspacePath: HOST_WORKTREE_PATH,
			additionalRedactedPaths: [HOST_PARENT_PATH, getWorktreesRoot(HOST_AGENT_DIR)],
		});
	});

	it("redacts worktree, parent, and worktrees-root paths on served relay frames", async () => {
		const parentPath = HOST_PARENT_PATH;
		const agentDir = HOST_AGENT_DIR;
		const worktreePath = HOST_WORKTREE_PATH;
		const session = createTestSession("s-relay-wt", null);
		const subscribers = new Set<(event: AgentSessionEvent) => void>();
		session.subscribe = vi.fn((handler: (event: AgentSessionEvent) => void) => {
			subscribers.add(handler);
			return () => {
				subscribers.delete(handler);
			};
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as Parameters<typeof runIrohRemoteRpcMode>[0];

		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const sanitizerOptions = getRelayServingSanitizerOptions(
			{ ...authorizationBase, worktreeId: "fix-login", worktreePath },
			agentDir,
		);
		const modePromise = runIrohRemoteRpcMode(runtimeHost, {
			...createTestIrohConversationOptions(runtimeHost),
			stream: { recv, send },
			disposeRuntimeOnClose: false,
			rpcGrant: authorizationBase.rpcGrant,
			workspaceName: "repo",
			workspacePath: sanitizerOptions.workspacePath,
			...(sanitizerOptions.additionalRedactedPaths === undefined
				? {}
				: { additionalRedactedPaths: sanitizerOptions.additionalRedactedPaths }),
		});
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
		expect(parseWrittenObjects(send)[0]).toMatchObject({
			type: "conversation_bootstrap",
			delivery: { cursor: 0 },
			conversation: { sessionId: "s-relay-wt" },
		});

		const text = `wt=${worktreePath}/file.ts parent=${parentPath}/file.ts root=${agentDir}/worktrees`;
		for (const handler of Array.from(subscribers)) {
			handler({
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text }] },
			} as unknown as AgentSessionEvent);
		}
		await vi.waitFor(() => {
			const frame = parseWrittenObjects(send).find((entry) => entry.type === "message_start");
			expect(frame).toBeDefined();
			const serialized = JSON.stringify(frame);
			expect(serialized).not.toContain(parentPath);
			expect(serialized).not.toContain(worktreePath);
			expect(serialized).not.toContain(`${agentDir}/worktrees`);
			expect(serialized).toContain("/workspace/file.ts");
		});
		recv.end();
		await modePromise;
	});
});

describe("worktree relay gating and takeover refusal (§5.2.3)", () => {
	it("evaluateWorktreeRelayGate: non-worktree conversations always pass", () => {
		expect(evaluateWorktreeRelayGate(undefined, undefined, CONTROL_WORKTREES_CAPABILITY)).toEqual({ ok: true });
	});

	it("evaluateWorktreeRelayGate: missing checkout refuses regardless of capability", () => {
		const gate = evaluateWorktreeRelayGate(
			{ path: join(tmpdir(), `volt-nope-${Date.now()}`) },
			new Set([CONTROL_WORKTREES_CAPABILITY]),
			CONTROL_WORKTREES_CAPABILITY,
		);
		expect(gate).toEqual({ ok: false, reason: "checkout_missing" });
	});

	it("evaluateWorktreeRelayGate: old TUIs (no capability) are never offered worktree relays", () => {
		const checkout = makeTempDir("volt-wt-gate-");
		expect(evaluateWorktreeRelayGate({ path: checkout }, new Set(), CONTROL_WORKTREES_CAPABILITY)).toEqual({
			ok: false,
			reason: "tui_not_capable",
		});
		expect(evaluateWorktreeRelayGate({ path: checkout }, undefined, CONTROL_WORKTREES_CAPABILITY)).toEqual({
			ok: false,
			reason: "tui_not_capable",
		});
		expect(
			evaluateWorktreeRelayGate(
				{ path: checkout },
				new Set([CONTROL_WORKTREES_CAPABILITY]),
				CONTROL_WORKTREES_CAPABILITY,
			),
		).toEqual({ ok: true });
	});

	it("isPathUnderWorktreesRoot identifies daemon-managed checkout paths (takeover refusal predicate)", () => {
		const agentDir = makeTempDir("volt-wt-root-");
		const root = getWorktreesRoot(agentDir);
		expect(isPathUnderWorktreesRoot(agentDir, join(root, "--repo--", "fix-login"))).toBe(true);
		expect(isPathUnderWorktreesRoot(agentDir, join(root, "--repo--", "fix-login", "src"))).toBe(true);
		expect(isPathUnderWorktreesRoot(agentDir, root)).toBe(false);
		expect(isPathUnderWorktreesRoot(agentDir, join(agentDir, "repo"))).toBe(false);
		expect(isPathUnderWorktreesRoot(agentDir, join(tmpdir(), "unrelated"))).toBe(false);
	});
});

describe("trust pinning helpers (§5.2.1)", () => {
	it("resolveWorktreeParentCheckout derives the parent from the gitdir pointer", () => {
		const agentDir = makeTempDir("volt-wt-trust-");
		const parent = join(agentDir, "parent-repo");
		mkdirSync(parent, { recursive: true });
		const checkout = join(getWorktreesRoot(agentDir), "--parent-repo--", "fix-login");
		mkdirSync(checkout, { recursive: true });
		writeFileSync(join(checkout, ".git"), `gitdir: ${join(parent, ".git", "worktrees", "fix-login")}\n`);

		expect(resolveWorktreeParentCheckout(agentDir, checkout)).toBe(parent);
		expect(resolveWorktreeParentCheckout(agentDir, join(checkout, "src", "deep"))).toBe(parent);
	});

	it("returns undefined outside the worktrees root and for unparseable pointers", () => {
		const agentDir = makeTempDir("volt-wt-trust2-");
		expect(resolveWorktreeParentCheckout(agentDir, join(agentDir, "parent-repo"))).toBeUndefined();

		const noGit = join(getWorktreesRoot(agentDir), "--repo--", "no-git");
		mkdirSync(noGit, { recursive: true });
		expect(resolveWorktreeParentCheckout(agentDir, noGit)).toBeUndefined();

		const badPointer = join(getWorktreesRoot(agentDir), "--repo--", "bad-pointer");
		mkdirSync(badPointer, { recursive: true });
		writeFileSync(join(badPointer, ".git"), "gitdir: relative/path\n");
		expect(resolveWorktreeParentCheckout(agentDir, badPointer)).toBeUndefined();

		const notWorktreeGitdir = join(getWorktreesRoot(agentDir), "--repo--", "odd");
		mkdirSync(notWorktreeGitdir, { recursive: true });
		writeFileSync(join(notWorktreeGitdir, ".git"), `gitdir: ${join(agentDir, "somewhere", "else")}\n`);
		expect(resolveWorktreeParentCheckout(agentDir, notWorktreeGitdir)).toBeUndefined();
	});
});

describe("new session into a worktree (§5.2.1 cwd/sessionDir overrides)", () => {
	function createRuntimeFixture(parentCwd: string, agentDir: string) {
		const createdSessions: Array<{
			cwd: string;
			sessionDir: string;
			sessionFile: string | undefined;
			workspaceName?: string;
			baseRef?: string;
		}> = [];
		const makeSessionDouble = (sessionManager: SessionManager): AgentSession =>
			({
				sessionManager,
				extensionRunner: { hasHandlers: () => false },
				disposeSubagentToolManager: vi.fn(),
				disposeForSessionReplacement: vi.fn(),
				dispose: vi.fn(),
				subscribe: vi.fn(() => () => {}),
				get sessionFile() {
					return sessionManager.getSessionFile();
				},
				get sessionId() {
					return sessionManager.getSessionId();
				},
			}) as unknown as AgentSession;
		const makeServices = (cwd: string): AgentSessionServices =>
			({
				cwd,
				agentDir,
				settingsManager: { getRequestedProfile: () => undefined },
			}) as unknown as AgentSessionServices;
		const createRuntime = vi.fn(
			async (options: {
				cwd: string;
				sessionManager: SessionManager;
				workspaceName?: string;
				baseRef?: string;
			}): Promise<CreateAgentSessionRuntimeResult> => {
				createdSessions.push({
					cwd: options.cwd,
					sessionDir: options.sessionManager.getSessionDir(),
					sessionFile: options.sessionManager.getSessionFile(),
					workspaceName: options.workspaceName,
					baseRef: options.baseRef,
				});
				return {
					session: makeSessionDouble(options.sessionManager),
					services: makeServices(options.cwd),
					diagnostics: [],
				} as unknown as CreateAgentSessionRuntimeResult;
			},
		);
		const parentSessionDir = getDefaultSessionDir(parentCwd, agentDir);
		const initialManager = SessionManager.create(parentCwd, parentSessionDir);
		const runtime = new AgentSessionRuntime(
			makeSessionDouble(initialManager),
			makeServices(parentCwd),
			createRuntime as never,
		);
		return { runtime, createRuntime, createdSessions, parentSessionDir };
	}

	it("creates the session with the worktree cwd in the PARENT workspace's session dir", async () => {
		const agentDir = makeTempDir("volt-wt-newsession-");
		const parentCwd = join(agentDir, "parent-repo");
		const worktreeCwd = join(getWorktreesRoot(agentDir), "--parent-repo--", "fix-login");
		mkdirSync(parentCwd, { recursive: true });
		mkdirSync(worktreeCwd, { recursive: true });
		const fixture = createRuntimeFixture(parentCwd, agentDir);

		const result = await fixture.runtime.newSession({
			cwd: worktreeCwd,
			sessionDir: fixture.parentSessionDir,
			workspaceName: "parent-workspace",
			baseRef: "origin/main",
		});
		expect(result).toEqual({ cancelled: false, seeded: false });
		expect(fixture.createdSessions).toHaveLength(1);
		const created = fixture.createdSessions[0]!;
		expect(created.cwd).toBe(worktreeCwd);
		expect(created.sessionDir).toBe(fixture.parentSessionDir);
		expect(created.workspaceName).toBe("parent-workspace");
		expect(created.baseRef).toBe("origin/main");
		expect(fixture.runtime.session.sessionManager.getCwd()).toBe(worktreeCwd);
		// §5.1.7 pin: the parent-dir listing includes the worktree session once it
		// has persisted content (session files flush on the first assistant message).
		fixture.runtime.session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "worktree session" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await fixture.runtime.session.sessionManager.flush();
		const listed = await SessionManager.list(parentCwd, fixture.parentSessionDir);
		expect(listed.some((info) => info.id === fixture.runtime.session.sessionManager.getSessionId())).toBe(true);
	});

	it("without overrides, newSession keeps the current cwd and session dir (unchanged behavior)", async () => {
		const agentDir = makeTempDir("volt-wt-newsession2-");
		const parentCwd = join(agentDir, "parent-repo");
		mkdirSync(parentCwd, { recursive: true });
		const fixture = createRuntimeFixture(parentCwd, agentDir);

		await fixture.runtime.newSession();
		expect(fixture.createdSessions[0]).toMatchObject({ cwd: parentCwd, sessionDir: fixture.parentSessionDir });
	});
});
