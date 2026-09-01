import { mkdirSync, mkdtempSync, realpathSync as nodeRealpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	AgentSessionReplacementTarget,
	AgentSessionReplacementTransaction,
	AgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { createConversationOpenError, IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import { createTestSession } from "./iroh-stream-doubles.ts";

const realpathSync = nodeRealpathSync.native;

type CreateRuntimeOptions = Parameters<
	NonNullable<ConstructorParameters<typeof IntegratedRuntimeRegistry>[0]["createRuntime"]>
>[0];

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1", "worktrees.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

let newSessionSequence = 0;

function createConversationHello(conversation: Record<string, unknown>): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation:
			conversation.target === "new" && conversation.sessionId === undefined
				? { ...conversation, sessionId: `new-session-${++newSessionSequence}` }
				: conversation,
	} as unknown as IrohRemoteHello;
}

describe("worktree runtime plumbing (createRuntime seam)", () => {
	let agentDir: string;
	let workspacePath: string;
	let worktreePath: string;
	let worktree: IrohRemoteWorkspaceWorktree;
	let authorization: IrohRemoteClientAuthorizationSuccess;

	beforeEach(() => {
		agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-runtime-")));
		workspacePath = join(agentDir, "repo");
		worktreePath = join(agentDir, "worktrees", "--repo--", "fix-login");
		mkdirSync(workspacePath, { recursive: true });
		mkdirSync(worktreePath, { recursive: true });
		worktree = {
			id: "fix-login",
			workspaceName: "ws",
			path: worktreePath,
			branch: "volt/fix-login",
			baseRef: "origin/main",
			createdAt: 1,
			sessionIds: [],
		};
		authorization = {
			ok: true,
			allowTools: "read",
			client: {
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["ws"],
				allowedTools: "read",
				rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
				pairedAt: 1,
				lastSeenAt: 2,
				lastSessionIdByWorkspace: { ws: "s-last" },
			},
			paired: false,
			pairingSecretConsumed: false,
			workspace: { name: "ws", path: workspacePath },
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
		};
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function createRegistry(options: {
		sessionId: string;
		selectionKind?: "created" | "resumed" | "created_after_missing";
		requestedSessionId?: string;
		stateManager?: IrohRemoteHostStateManager;
		resolveWorktree?: ConstructorParameters<typeof IntegratedRuntimeRegistry>[0]["resolveWorktree"];
		resolveWorkingDirectory?: ConstructorParameters<typeof IntegratedRuntimeRegistry>[0]["resolveWorkingDirectory"];
		bindWorktreeSession?: ConstructorParameters<typeof IntegratedRuntimeRegistry>[0]["bindWorktreeSession"];
	}) {
		const createRuntimeCalls: CreateRuntimeOptions[] = [];
		let prepareSessionReplacement:
			| ((target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>)
			| undefined;
		const runtime = {
			session: createTestSession(options.sessionId, null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			setPrepareSessionReplacement: vi.fn(
				(prepare: (target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction>) => {
					prepareSessionReplacement = prepare;
				},
			),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const selectionKind = options.selectionKind ?? "created";
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: options.stateManager ?? new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => "read,bash",
			getProjectTrustedForWorkspace: () => true,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async (runtimeOptions) => {
				createRuntimeCalls.push(runtimeOptions);
				(runtime as AgentSessionRuntime & { cwd: string }).cwd = runtimeOptions.cwd;
				return {
					runtime,
					sessionSelection:
						selectionKind === "created"
							? { kind: "created", sessionId: options.sessionId }
							: selectionKind === "created_after_missing"
								? {
										kind: "created_after_missing",
										requestedSessionId: options.requestedSessionId ?? options.sessionId,
										sessionId: options.sessionId,
									}
								: { kind: "resumed", requestedSessionId: options.sessionId, sessionId: options.sessionId },
				};
			},
			resolveWorktree: options.resolveWorktree,
			resolveWorkingDirectory: options.resolveWorkingDirectory,
			bindWorktreeSession: options.bindWorktreeSession,
		});
		return {
			registry,
			createRuntimeCalls,
			getPrepareSessionReplacement: () => prepareSessionReplacement,
		};
	}

	it("worktree-bound new passes the worktree cwd and the parent-keyed session dir; binds once after created", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry, createRuntimeCalls } = createRegistry({
			sessionId: "s-wt",
			resolveWorktree,
			bindWorktreeSession,
		});
		const hello = createConversationHello({ target: "new", worktreeId: "fix-login" });

		const created = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		expect(created.created).toBe(true);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "new-session-1");
		expect(createRuntimeCalls).toHaveLength(1);
		expect(createRuntimeCalls[0]).toMatchObject({
			agentDir,
			toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
			conversationTarget: { target: "new", sessionId: "new-session-1" },
			cwd: worktreePath,
			projectCwd: worktreePath,
			workspaceName: "ws",
			baseRef: "origin/main",
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
			projectTrusted: true, // evaluated against the PARENT path
			profile: undefined,
		});
		expect(created.entry).toMatchObject({ worktreeId: "fix-login", worktreePath });
		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "s-wt");
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();

		// A reattach to the same conversation must not re-bind.
		const reattach = await registry.getOrCreateEntry(
			{ hello: createConversationHello({ target: "session", sessionId: "s-wt" }), response: HANDSHAKE_RESPONSE },
			authorization,
		);
		expect(reattach.created).toBe(false);
		expect(reattach.entry).toBe(created.entry);
		expect(bindWorktreeSession).toHaveBeenCalledTimes(1);
		reattach.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("worktree-bound new preserves a selected workspace-relative subfolder under the checkout", async () => {
		mkdirSync(join(workspacePath, "packages", "app"), { recursive: true });
		mkdirSync(join(worktreePath, "packages", "app"), { recursive: true });
		const resolveWorktree = vi.fn(async () => worktree);
		const { registry, createRuntimeCalls } = createRegistry({ sessionId: "s-wt-subdir", resolveWorktree });
		const hello = createConversationHello({
			target: "new",
			worktreeId: "fix-login",
			workingDirectory: "packages/app",
		});

		const created = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);

		expect(createRuntimeCalls[0]).toMatchObject({
			cwd: join(worktreePath, "packages", "app"),
			projectCwd: worktreePath,
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
		});
		expect(created.entry).toMatchObject({
			worktreeId: "fix-login",
			worktreePath,
			workingDirectory: "packages/app",
		});
		await registry.stopAll("test_cleanup");
	});

	it("nested-repo worktree new uses the nested checkout root for project config and preserves remote cwd", async () => {
		const nestedWorktree: IrohRemoteWorkspaceWorktree = {
			...worktree,
			sourceRootRelativePath: "Volt",
		};
		mkdirSync(join(worktreePath, "packages", "coding-agent"), { recursive: true });
		const resolveWorktree = vi.fn(async () => nestedWorktree);
		const resolveWorkingDirectory = vi.fn(async () => ({
			absolutePath: join(worktreePath, "packages", "coding-agent"),
			relativePath: "packages/coding-agent",
		}));
		const { registry, createRuntimeCalls } = createRegistry({
			sessionId: "s-wt-nested",
			resolveWorktree,
			resolveWorkingDirectory,
		});
		const hello = createConversationHello({
			target: "new",
			worktreeId: "fix-login",
			workingDirectory: "Volt/packages/coding-agent",
		});

		const created = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);

		expect(resolveWorkingDirectory).toHaveBeenCalledWith({
			workspace: authorization.workspace,
			rootPath: worktreePath,
			workingDirectory: "Volt/packages/coding-agent",
			worktree: nestedWorktree,
		});
		expect(createRuntimeCalls[0]).toMatchObject({
			cwd: join(worktreePath, "packages", "coding-agent"),
			projectCwd: worktreePath,
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
		});
		expect(created.entry).toMatchObject({
			worktreeId: "fix-login",
			worktreePath,
			worktreeSourceRootRelativePath: "Volt",
			workingDirectory: "Volt/packages/coding-agent",
		});
		await registry.stopAll("test_cleanup");
	});

	it("non-worktree new keeps the parent cwd and the same derived session dir as before", async () => {
		const resolveWorktree = vi.fn(async () => undefined);
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry, createRuntimeCalls } = createRegistry({
			sessionId: "s-plain",
			resolveWorktree,
			bindWorktreeSession,
		});

		const created = await registry.getOrCreateEntry(
			{ hello: createConversationHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			authorization,
		);
		expect(created.created).toBe(true);
		expect(createRuntimeCalls[0]).toMatchObject({
			cwd: workspacePath,
			projectCwd: workspacePath,
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
			toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
			projectTrusted: true,
		});
		expect(created.entry.worktreeId).toBeUndefined();
		expect(created.entry.worktreePath).toBeUndefined();
		expect(bindWorktreeSession).not.toHaveBeenCalled();
		await registry.stopAll("test_cleanup");
	});

	it("non-worktree new can run from a selected workspace-relative subfolder while keeping projectCwd at the root", async () => {
		mkdirSync(join(workspacePath, "packages", "app"), { recursive: true });
		const { registry, createRuntimeCalls } = createRegistry({
			sessionId: "s-plain-subdir",
			resolveWorktree: async () => undefined,
		});

		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({ target: "new", workingDirectory: "packages/app" }),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);

		expect(createRuntimeCalls[0]).toMatchObject({
			cwd: join(workspacePath, "packages", "app"),
			projectCwd: workspacePath,
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
		});
		expect(created.entry.workingDirectory).toBe("packages/app");
		await registry.stopAll("test_cleanup");
	});

	it("concurrent target-new retries with the same session id publish one runtime", async () => {
		const { registry, createRuntimeCalls } = createRegistry({ sessionId: "same-session" });
		const hello = createConversationHello({ target: "new", sessionId: "same-session" });

		const first = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		const retryPromise = registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		await registry.commitEntry(first.entry, first.sessionSelection, authorization, first.attachClaim);
		const retry = await retryPromise;

		expect(createRuntimeCalls).toHaveLength(1);
		expect(first.created).toBe(true);
		expect(retry.created).toBe(false);
		expect(retry.entry).toBe(first.entry);
		expect(retry.sessionSelection).toEqual({
			kind: "resumed",
			requestedSessionId: "same-session",
			sessionId: "same-session",
		});
		first.attachClaim.release();
		retry.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("rejects a target-new retry when placement differs from the published runtime", async () => {
		mkdirSync(join(workspacePath, "packages/app"), { recursive: true });
		const { registry } = createRegistry({ sessionId: "placed-session" });
		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({
					target: "new",
					sessionId: "placed-session",
					workingDirectory: "packages/app",
				}),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);

		await expect(
			registry.getOrCreateEntry(
				{
					hello: createConversationHello({ target: "new", sessionId: "placed-session" }),
					response: HANDSHAKE_RESPONSE,
				},
				authorization,
			),
		).rejects.toMatchObject({ outcome: "invalid_conversation_target" });
		created.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("resume of a bound session resolves the persisted binding into the worktree cwd without re-binding", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry, createRuntimeCalls } = createRegistry({
			sessionId: "s-resume",
			selectionKind: "resumed",
			resolveWorktree,
			bindWorktreeSession,
		});
		const hello = createConversationHello({ target: "session", sessionId: "s-resume" });

		const resumed = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		expect(resumed.created).toBe(true);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-resume");
		expect(createRuntimeCalls[0]).toMatchObject({
			cwd: worktreePath,
			projectCwd: worktreePath,
			sessionDir: getDefaultSessionDir(workspacePath, agentDir),
		});
		expect(resumed.entry).toMatchObject({ worktreeId: "fix-login", worktreePath });
		expect(bindWorktreeSession).not.toHaveBeenCalled();
		await registry.stopAll("test_cleanup");
	});

	it("target last resolves the binding via the client's last session id", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const { registry } = createRegistry({ sessionId: "s-last", selectionKind: "resumed", resolveWorktree });
		const hello = createConversationHello({ target: "last" });
		await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-last");
		await registry.stopAll("test_cleanup");
	});

	it("rekey via handleSessionChanged appends the worktree binding for the new session id (#83)", async () => {
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry } = createRegistry({
			sessionId: "s-wt",
			resolveWorktree: async () => worktree,
			bindWorktreeSession,
		});
		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({ target: "new", worktreeId: "fix-login" }),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();
		bindWorktreeSession.mockClear();

		await registry.handleSessionChanged(created.entry, undefined, { sessionId: "s-wt-rekeyed" }, authorization);

		expect(created.entry.sessionId).toBe("s-wt-rekeyed");
		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "s-wt-rekeyed");
		await registry.stopAll("test_cleanup");
	});

	it("a failed binding write during rekey stops the runtime (fail closed)", async () => {
		const bindWorktreeSession = vi.fn(async (_workspace: string, _worktreeId: string, sessionId: string) => {
			if (sessionId === "s-wt-rekeyed") {
				throw new Error("bind failed");
			}
		});
		const { registry } = createRegistry({
			sessionId: "s-wt",
			resolveWorktree: async () => worktree,
			bindWorktreeSession,
		});
		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({ target: "new", worktreeId: "fix-login" }),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();

		await expect(
			registry.handleSessionChanged(created.entry, undefined, { sessionId: "s-wt-rekeyed" }, authorization),
		).rejects.toThrow("bind failed");
		expect(registry.size).toBe(0);
	});

	it("prepared session replacement binds the worktree for the new session id on commit (#83)", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		vi.spyOn(stateManager, "setClientsLastSessionId").mockResolvedValue([]);
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry, getPrepareSessionReplacement } = createRegistry({
			sessionId: "s-wt",
			stateManager,
			resolveWorktree: async () => worktree,
			bindWorktreeSession,
		});
		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({ target: "new", worktreeId: "fix-login" }),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();
		bindWorktreeSession.mockClear();

		const transaction = await getPrepareSessionReplacement()?.({ previousSessionId: "s-wt", sessionId: "s-wt-new" });
		expect(transaction).toBeDefined();
		await transaction?.commit();

		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "s-wt-new");
		expect(created.entry.sessionId).toBe("s-wt-new");
		await transaction?.finalize?.();
		await registry.stopAll("test_cleanup");
	});

	it("a failed binding write during replacement commit restores the persisted reconnect target", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		const setClientsLastSessionId = vi.spyOn(stateManager, "setClientsLastSessionId").mockResolvedValue([]);
		const bindWorktreeSession = vi.fn(async (_workspace: string, _worktreeId: string, sessionId: string) => {
			if (sessionId === "s-wt-new") {
				throw new Error("bind failed");
			}
		});
		const { registry, getPrepareSessionReplacement } = createRegistry({
			sessionId: "s-wt",
			stateManager,
			resolveWorktree: async () => worktree,
			bindWorktreeSession,
		});
		const created = await registry.getOrCreateEntry(
			{
				hello: createConversationHello({ target: "new", worktreeId: "fix-login" }),
				response: HANDSHAKE_RESPONSE,
			},
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();

		const transaction = await getPrepareSessionReplacement()?.({ previousSessionId: "s-wt", sessionId: "s-wt-new" });
		await expect(transaction?.commit()).rejects.toThrow("bind failed");

		// The runtime identity never moved and the persisted reconnect target was compensated.
		expect(created.entry.sessionId).toBe("s-wt");
		expect(setClientsLastSessionId).toHaveBeenNthCalledWith(1, ["n-phone"], "ws", "s-wt-new");
		expect(setClientsLastSessionId).toHaveBeenNthCalledWith(2, ["n-phone"], "ws", "s-wt");
		await transaction?.rollback();
		await registry.stopAll("test_cleanup");
	});

	it("created_after_missing under a resolved worktree binds the replacement session id (#83)", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry } = createRegistry({
			sessionId: "s-replacement",
			selectionKind: "created_after_missing",
			requestedSessionId: "s-last",
			resolveWorktree,
			bindWorktreeSession,
		});
		const hello = createConversationHello({ target: "last" });

		const created = await registry.getOrCreateEntry({ hello, response: HANDSHAKE_RESPONSE }, authorization);

		expect(created.created).toBe(true);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-last");
		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "s-replacement");
		await registry.stopAll("test_cleanup");
	});

	it("rekey of a non-worktree conversation never touches worktree bindings", async () => {
		const bindWorktreeSession = vi.fn(async () => {});
		const { registry } = createRegistry({
			sessionId: "s-plain",
			resolveWorktree: async () => undefined,
			bindWorktreeSession,
		});
		const created = await registry.getOrCreateEntry(
			{ hello: createConversationHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			authorization,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, authorization, created.attachClaim);
		created.attachClaim.release();

		await registry.handleSessionChanged(created.entry, undefined, { sessionId: "s-plain-new" }, authorization);

		expect(bindWorktreeSession).not.toHaveBeenCalled();
		await registry.stopAll("test_cleanup");
	});

	it("propagates conversation-open errors from worktree resolution (missing checkout)", async () => {
		const invalidTarget = createRegistry({
			sessionId: "s-x",
			resolveWorktree: async () => {
				throw createConversationOpenError("invalid_conversation_target", "unknown or unavailable worktree");
			},
		});
		await expect(
			invalidTarget.registry.getOrCreateEntry(
				{ hello: createConversationHello({ target: "new", worktreeId: "ghost" }), response: HANDSHAKE_RESPONSE },
				authorization,
			),
		).rejects.toMatchObject({ outcome: "invalid_conversation_target" });
		expect(invalidTarget.createRuntimeCalls).toHaveLength(0);

		const unavailable = createRegistry({
			sessionId: "s-y",
			resolveWorktree: async () => {
				throw createConversationOpenError("session_unavailable", "worktree checkout is unavailable");
			},
		});
		await expect(
			unavailable.registry.getOrCreateEntry(
				{ hello: createConversationHello({ target: "session", sessionId: "s-y" }), response: HANDSHAKE_RESPONSE },
				authorization,
			),
		).rejects.toMatchObject({ outcome: "session_unavailable" });
		expect(unavailable.createRuntimeCalls).toHaveLength(0);
	});
});

describe("worktree session-dir keying (§5.1.7 filterCwd pin)", () => {
	it("a session with a worktree cwd in the parent session dir stays visible in the parent listing", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-sessiondir-")));
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		try {
			// The daemon always uses the env-aware agent dir; pin that setup here so
			// SessionManager.list's filterCwd stays OFF for the parent's default dir.
			process.env[ENV_AGENT_DIR] = agentDir;
			const parentPath = join(agentDir, "repo");
			const worktreePath = join(agentDir, "worktrees", "--repo--", "fix-login");
			mkdirSync(parentPath, { recursive: true });
			mkdirSync(worktreePath, { recursive: true });

			const parentSessionDir = getDefaultSessionDir(parentPath, agentDir);
			const worktreeSession = await SessionManager.create(worktreePath, parentSessionDir, {
				id: "s-worktree",
			});
			const parentSession = await SessionManager.create(parentPath, parentSessionDir, { id: "s-parent" });
			worktreeSession.appendMessage({ role: "user", content: "worktree session", timestamp: Date.now() });
			parentSession.appendMessage({ role: "user", content: "parent session", timestamp: Date.now() });
			await Promise.all([worktreeSession.flush(), parentSession.flush()]);

			// The daemon's list_sessions call shape: parent cwd + parent default dir.
			const sessions = await SessionManager.list(parentPath, parentSessionDir);
			const ids = sessions.map((session) => session.id);
			expect(ids).toContain("s-worktree");
			expect(ids).toContain("s-parent");
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = originalAgentDir;
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
