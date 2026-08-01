import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import type {
	IrohRemoteAgentLaunchOptions,
	IrohRemoteAgentLaunchResult,
	IrohRemoteCreateAgentRequest,
} from "../src/core/remote/iroh/agent-launch.ts";
import {
	createIrohRemoteAgentLaunchSessionId,
	digestIrohRemoteAgentLaunchRequest,
} from "../src/core/remote/iroh/agent-launch.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { createEmptyIrohRemoteHostState, type IrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { RpcCatalogModel } from "../src/core/rpc/types.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { ConversationCoordinatorRegistry } from "../src/daemon/conversation-coordinator.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import { IrohDaemonAdmissionGate, IrohDaemonService } from "../src/daemon/iroh-service.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import type { WorktreeManager } from "../src/daemon/worktree-manager.ts";
import { createTestSession } from "./iroh-stream-doubles.ts";

const cleanupPaths: string[] = [];
const RPC_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

const REQUEST: IrohRemoteCreateAgentRequest = {
	launchId: "launch-1",
	catalogRevision: "revision-1",
	placement: { kind: "workspace" },
	config: { fastModeEnabled: false, agentMode: "build" },
};

interface LaunchHarness {
	agentDir: string;
	authorization: IrohRemoteClientAuthorizationSuccess;
	broker: LeaseBroker;
	disposeRuntime: ReturnType<typeof vi.fn>;
	runtimes: IntegratedRuntimeRegistry;
	service: {
		createConfiguredDetachedAgent(
			authorization: IrohRemoteClientAuthorizationSuccess,
			request: IrohRemoteCreateAgentRequest,
			signal?: AbortSignal,
		): Promise<IrohRemoteAgentLaunchResult>;
		reconcileAgentLaunchesOnStart(signal: AbortSignal): Promise<void>;
	};
	stateManager: IrohRemoteHostStateManager;
	workspacePath: string;
}

function createState(workspacePath: string): IrohRemoteHostState {
	return {
		...createEmptyIrohRemoteHostState(),
		workspaces: [{ name: "volt", path: workspacePath }],
		clients: [
			{
				nodeId: "client-node",
				label: "phone",
				allowedWorkspaces: [],
				allowedTools: "read",
				rpcGrant: RPC_GRANT,
				pairedAt: 1,
				lastSeenAt: 2,
				lastSessionIdByWorkspace: { volt: "session-old" },
			},
		],
	};
}

async function createHarness(options: {
	beforePublication?: (stateManager: IrohRemoteHostStateManager) => Promise<void>;
	beforeCommitFlush?: () => Promise<void>;
	beforeRuntimeCreation?: () => Promise<void>;
	failSelectionPersistence?: boolean;
	ambiguousSelectionPersistence?: boolean;
	worktrees?: Partial<
		Pick<
			WorktreeManager,
			| "bindSession"
			| "create"
			| "finalizeLaunchWorktree"
			| "releaseLaunchWorktree"
			| "removeIncompleteLaunch"
			| "reserveWorktreeForLaunch"
		>
	>;
}): Promise<LaunchHarness> {
	const agentDir = await mkdtemp(join(tmpdir(), "volt-launch-transaction-"));
	cleanupPaths.push(agentDir);
	const workspacePath = join(agentDir, "workspace");
	await mkdir(workspacePath, { recursive: true });
	let persisted = createState(workspacePath);
	let failingSelectionWrites = 0;
	let selectionFailureArmed = options.failSelectionPersistence || options.ambiguousSelectionPersistence;
	const stateManager =
		options.failSelectionPersistence || options.ambiguousSelectionPersistence
			? new IrohRemoteHostStateManager({
					store: {
						read: () => structuredClone(persisted),
						write: (state) => {
							if (failingSelectionWrites > 0) {
								failingSelectionWrites -= 1;
								if (options.ambiguousSelectionPersistence && failingSelectionWrites === 1) {
									persisted = structuredClone(state);
								}
								throw new Error("selection save failed");
							}
							persisted = structuredClone(state);
						},
					},
				})
			: new IrohRemoteHostStateManager({ initialState: persisted });
	const initialState = await stateManager.getState();
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		client: initialState.clients[0] as IrohRemoteClientAuthorizationSuccess["client"],
		paired: false,
		pairingSecretConsumed: false,
		workspace: initialState.workspaces[0]!,
		workspaceNames: ["volt"],
		workspaces: [{ name: "volt", status: "available" }],
	};
	const engine = new IrohRemoteHostEngine({
		stateManager,
		workspace: authorization.workspace,
	});
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
	const runtimes = new IntegratedRuntimeRegistry({
		auditLogger: new IrohRemoteAuditLogger(),
		stateManager,
		activeStreams: new IrohRemoteActiveStreamRegistry(),
		coordinators,
		detachedRuntimeTtlMs: () => 60_000,
		getProjectTrustedForWorkspace: () => true,
		setClientLastSessionId: engine.setClientLastSessionId.bind(engine),
	});
	const disposeRuntime = vi.fn(async () => {});
	const catalog: IrohRemoteAgentLaunchOptions = {
		workspaceName: "volt",
		revision: REQUEST.catalogRevision,
		models: [
			{
				provider: "test",
				id: "model",
				availableThinkingLevels: ["off"],
				supportsFastMode: false,
			} as RpcCatalogModel,
		],
		defaultConfig: {
			kind: "configured",
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			fastModeEnabled: false,
			agentMode: "build",
		},
	};
	const rawService = Object.create(IrohDaemonService.prototype) as Record<string, unknown>;
	Object.assign(rawService, {
		admission: new IrohDaemonAdmissionGate(),
		stateManager,
		engine,
		services: { agentDir, state: { state: { settings: { allowTools: null } } } },
		profile: undefined,
		trustStore: new ProjectTrustStore(agentDir),
		worktrees: options.worktrees ?? {},
		leaseBroker: broker,
		runtimes,
		log: vi.fn(),
		dependencies: {
			createAgentLaunchRuntime: async (launchOptions: { resolvedSessionTarget: { sessionId: string } }) => {
				await options.beforeRuntimeCreation?.();
				const launchSessionId = launchOptions.resolvedSessionTarget.sessionId;
				return {
					runtime: {
						session: createTestSession(launchSessionId, null),
						dispose: disposeRuntime,
					} as unknown as AgentSessionRuntime,
					sessionSelection: { kind: "created" as const, sessionId: launchSessionId },
				};
			},
			beforeAgentLaunchPublication: async () => {
				if (selectionFailureArmed) {
					selectionFailureArmed = false;
					failingSelectionWrites = options.ambiguousSelectionPersistence ? 2 : 1;
				}
				await options.beforePublication?.(stateManager);
			},
			beforeAgentLaunchCommitFlush: options.beforeCommitFlush,
		},
		getAgentLaunchOptions: async () => catalog,
		resolveConversationWorkingDirectory: async () => ({ absolutePath: workspacePath }),
	});
	return {
		agentDir,
		authorization,
		broker,
		disposeRuntime,
		runtimes,
		service: rawService as unknown as LaunchHarness["service"],
		stateManager,
		workspacePath,
	};
}

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("cold agent launch transaction", () => {
	test("persists a worktree receipt before creation can escape and converges an identical retry", async () => {
		let createCount = 0;
		let removeCount = 0;
		let harness: LaunchHarness;
		const worktreePath = join(tmpdir(), "volt-planned-agent-worktree");
		const worktrees: Pick<WorktreeManager, "bindSession" | "create" | "removeIncompleteLaunch"> = {
			bindSession: async () => {},
			create: async (_workspace, createOptions = {}) => {
				createCount++;
				if (createCount === 1) {
					await createOptions.beforeCreate?.(
						{
							id: "launch-worktree",
							workspaceName: "volt",
							path: worktreePath,
							branch: "volt/launch-worktree",
							createdAt: 1,
							sessionIds: [],
						},
						{
							branch: "volt/launch-worktree",
							expectedOid: "a".repeat(40),
							ownershipRef: `refs/volt/agent-launches/${"b".repeat(64)}`,
						},
					);
					const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", "launch-worktree");
					const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
					const session = await SessionManager.findForResume(sessionDir, sessionId, {
						includeUncommittedAgentLaunch: true,
					});
					expect(session).toBeDefined();
					expect(
						SessionManager.open(session!.path, sessionDir).getAgentLaunchRecord("launch-worktree"),
					).toMatchObject({
						receipt: {
							placement: { kind: "worktree", created: true, worktreeId: "launch-worktree" },
							branchReservation: { branch: "volt/launch-worktree", expectedOid: "a".repeat(40) },
						},
						commit: undefined,
					});
				}
				return { ok: false as const, error: "git_failed" as const };
			},
			removeIncompleteLaunch: async () => {
				removeCount++;
				return removeCount === 1 ? { ok: false as const, error: "git_failed" as const } : { ok: true as const };
			},
		};
		harness = await createHarness({ worktrees });
		const request: IrohRemoteCreateAgentRequest = {
			...REQUEST,
			launchId: "launch-worktree",
			placement: { kind: "new_worktree", worktreeName: "launch-worktree" },
		};

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, request),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "cleanup_required", worktreeId: "launch-worktree" },
		});
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", request.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		await expect(SessionManager.findForResume(sessionDir, sessionId)).rejects.toThrow(
			"reserved for incomplete agent launch recovery",
		);
		await expect(
			SessionManager.findForResume(sessionDir, sessionId, { includeUncommittedAgentLaunch: true }),
		).resolves.toBeDefined();

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, request),
		).resolves.toMatchObject({
			kind: "error",
			error: { kind: "placement_unavailable" },
		});
		expect(removeCount).toBe(2);
		await expect(SessionManager.findForResume(sessionDir, sessionId)).resolves.toBeUndefined();
	});

	test("commits a created launch last and returns existing without replaying selection", async () => {
		const harness = await createHarness({});

		const created = await harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);
		expect(created).toMatchObject({ kind: "created", launchId: "launch-1" });
		expect(harness.runtimes.size).toBe(1);
		expect(harness.broker.list()).toEqual([
			expect.objectContaining({ state: "daemon-detached", pendingDaemonAttaches: 0 }),
		]);
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(sessionId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const session = await SessionManager.findForResume(sessionDir, sessionId);
		expect(session).toBeDefined();
		expect(SessionManager.open(session!.path, sessionDir).getAgentLaunchRecord("launch-1")?.commit).toBeDefined();

		await harness.stateManager.setClientLastSessionId("client-node", "volt", "session-newer");
		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST),
		).resolves.toMatchObject({ kind: "existing", launchId: "launch-1", sessionId });
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(
			"session-newer",
		);
		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, {
				...REQUEST,
				placement: { kind: "workspace", workingDirectory: "other" },
			}),
		).resolves.toMatchObject({ kind: "error", error: { kind: "launch_conflict" } });
		await harness.runtimes.stopAll("test_cleanup");
	});

	test("launches end-to-end in a reserved existing worktree", async () => {
		const finalizeLaunchWorktree = vi.fn(async () => {});
		const bindSession = vi.fn(async () => {});
		const worktrees: Partial<
			Pick<
				WorktreeManager,
				| "bindSession"
				| "create"
				| "finalizeLaunchWorktree"
				| "releaseLaunchWorktree"
				| "removeIncompleteLaunch"
				| "reserveWorktreeForLaunch"
			>
		> = {
			bindSession,
			finalizeLaunchWorktree,
			reserveWorktreeForLaunch: async (workspace, worktreeId, pendingLaunchKey, launchSessionId, beforeReserve) => {
				const worktree = {
					id: worktreeId,
					workspaceName: workspace.name,
					path: workspace.path,
					branch: "feature/existing",
					pendingLaunchKey,
					pendingLaunchSessionId: launchSessionId,
					createdAt: 1,
					sessionIds: [],
				};
				await beforeReserve(worktree);
				return { ok: true, worktree };
			},
		};
		const harness = await createHarness({ worktrees });
		const request: IrohRemoteCreateAgentRequest = {
			...REQUEST,
			placement: { kind: "existing_worktree", worktreeId: "existing", workingDirectory: "packages" },
		};

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, request),
		).resolves.toMatchObject({
			kind: "created",
			placement: { kind: "worktree", worktreeId: "existing", created: false },
		});
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", request.launchId);
		expect(bindSession).toHaveBeenCalledWith("volt", "existing", sessionId, expect.any(String));
		expect(finalizeLaunchWorktree).toHaveBeenCalledWith("volt", "existing", expect.any(String), sessionId);
		await harness.runtimes.stopAll("test_cleanup");
	});

	test("supports sequential launches on one authorization snapshot", async () => {
		const harness = await createHarness({});
		const secondRequest: IrohRemoteCreateAgentRequest = { ...REQUEST, launchId: "launch-2" };

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST),
		).resolves.toMatchObject({ kind: "created", launchId: REQUEST.launchId });
		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, secondRequest),
		).resolves.toMatchObject({ kind: "created", launchId: secondRequest.launchId });
		const secondSessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", secondRequest.launchId);
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(
			secondSessionId,
		);
		expect(harness.runtimes.size).toBe(2);
		await harness.runtimes.stopAll("test_cleanup");
	});

	test.each(["client revocation", "workspace removal"])(
		"returns authorization_changed and publishes no runtime after %s before publication",
		async (race) => {
			const harness = await createHarness({
				beforePublication: async (stateManager) => {
					if (race === "client revocation") await stateManager.revokeClient("client-node");
					else await stateManager.unregisterWorkspace("volt");
				},
			});

			const result = await harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);

			expect(result).toMatchObject({ kind: "error", error: { kind: "authorization_changed" } });
			expect(harness.runtimes.size).toBe(0);
			expect(harness.broker.list()).toEqual([]);
			expect(harness.disposeRuntime).toHaveBeenCalled();
		},
	);

	test("serializes authorization revocation through the terminal launch commit", async () => {
		const commitStarted = createDeferred();
		const finishCommit = createDeferred();
		const harness = await createHarness({
			beforeCommitFlush: async () => {
				commitStarted.resolve();
				await finishCommit.promise;
			},
		});
		const launching = harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);
		await commitStarted.promise;
		let revocationSettled = false;
		const revoking = harness.stateManager.revokeClient("client-node").finally(() => {
			revocationSettled = true;
		});
		await Promise.resolve();
		expect(revocationSettled).toBe(false);

		finishCommit.resolve();
		await expect(launching).resolves.toMatchObject({ kind: "created" });
		await revoking;
		await harness.runtimes.stopAll("test_cleanup");
	});

	test("cancels cold runtime preparation without waiting for a late factory", async () => {
		const runtimeCreationStarted = createDeferred();
		const finishRuntimeCreation = createDeferred();
		const harness = await createHarness({
			beforeRuntimeCreation: async () => {
				runtimeCreationStarted.resolve();
				await finishRuntimeCreation.promise;
			},
		});
		const controller = new AbortController();
		const launching = harness.service.createConfiguredDetachedAgent(
			harness.authorization,
			REQUEST,
			controller.signal,
		);
		await runtimeCreationStarted.promise;

		controller.abort(new Error("shutdown"));
		await expect(launching).resolves.toMatchObject({ kind: "error", error: { kind: "host_shutdown" } });
		expect(harness.runtimes.size).toBe(0);

		finishRuntimeCreation.resolve();
		await vi.waitFor(() => expect(harness.disposeRuntime).toHaveBeenCalledOnce());
	});

	test("publishes fenced ownership that is not attachable before the durable launch commit", async () => {
		const commitStarted = createDeferred();
		const finishCommit = createDeferred();
		const harness = await createHarness({
			beforeCommitFlush: async () => {
				commitStarted.resolve();
				await finishCommit.promise;
			},
		});

		const launching = harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);
		await commitStarted.promise;
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		expect(harness.runtimes.findOwner("volt", sessionId)).toMatchObject({
			lifecycle: "active",
			launchPending: true,
		});
		expect(harness.runtimes.size).toBe(1);
		expect(harness.broker.lookup("volt", sessionId)).toMatchObject({
			state: "daemon-detached",
			pendingDaemonAttaches: 0,
		});

		finishCommit.resolve();
		await expect(launching).resolves.toMatchObject({ kind: "created", sessionId });
		expect(harness.runtimes.findOwner("volt", sessionId)).toMatchObject({
			lifecycle: "active",
			launchPending: false,
		});
		await harness.runtimes.stopAll("test_cleanup");
	});

	test("rolls back runtime ownership when last-session selection persistence fails", async () => {
		const harness = await createHarness({ failSelectionPersistence: true });

		const result = await harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);

		expect(result).toMatchObject({ kind: "error", error: { kind: "internal_error" } });
		expect(harness.runtimes.size).toBe(0);
		expect(harness.broker.list()).toEqual([]);
		expect(harness.disposeRuntime).toHaveBeenCalled();
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe("session-old");
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		await expect(SessionManager.findForResume(sessionDir, sessionId)).resolves.toBeUndefined();
	});

	test("preserves and then retries a launch after ambiguous selection persistence", async () => {
		const harness = await createHarness({ ambiguousSelectionPersistence: true });
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST),
		).resolves.toMatchObject({ kind: "error", error: { kind: "internal_error" } });
		expect(harness.runtimes.findOwner("volt", sessionId)).toMatchObject({ launchPending: true });
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(sessionId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		await expect(SessionManager.findForResume(sessionDir, sessionId)).rejects.toThrow(
			"reserved for incomplete agent launch recovery",
		);
		await expect(
			SessionManager.findForResume(sessionDir, sessionId, { includeUncommittedAgentLaunch: true }),
		).resolves.toBeDefined();

		const retry = await harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);
		expect(retry).toMatchObject({ kind: "created", sessionId });
		expect(harness.runtimes.findOwner("volt", sessionId)).toMatchObject({ launchPending: false });
		await harness.runtimes.stopAll("test_cleanup");
	});

	test("startup restores selection and removes an uncommitted workspace launch without an engine", async () => {
		const harness = await createHarness({});
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const manager = SessionManager.create(harness.workspacePath, sessionDir, { id: sessionId });
		manager.appendAgentLaunchReceipt({
			launchId: REQUEST.launchId,
			requestDigest: digestIrohRemoteAgentLaunchRequest("volt", REQUEST),
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request: REQUEST,
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		await manager.flush();
		await harness.stateManager.setClientLastSessionId("client-node", "volt", sessionId);
		(harness.service as unknown as { engine?: unknown }).engine = undefined;

		await harness.service.reconcileAgentLaunchesOnStart(new AbortController().signal);

		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe("session-old");
		await expect(SessionManager.findForResume(sessionDir, sessionId)).resolves.toBeUndefined();
	});

	test("startup ignores launch records authenticated to a different workspace alias", async () => {
		const harness = await createHarness({});
		const aliasName = "volt-alias";
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", aliasName, REQUEST.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const manager = SessionManager.create(harness.workspacePath, sessionDir, { id: sessionId });
		manager.appendAgentLaunchReceipt({
			launchId: REQUEST.launchId,
			requestDigest: digestIrohRemoteAgentLaunchRequest(aliasName, REQUEST),
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request: REQUEST,
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		await manager.flush();

		await harness.service.reconcileAgentLaunchesOnStart(new AbortController().signal);

		await expect(
			SessionManager.findForResume(sessionDir, sessionId, { includeUncommittedAgentLaunch: true }),
		).resolves.toBeDefined();
	});

	test("startup finalizes a committed existing-worktree reservation", async () => {
		const finalizeLaunchWorktree = vi.fn(async () => {});
		const harness = await createHarness({
			worktrees: { finalizeLaunchWorktree },
		});
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const manager = SessionManager.create(harness.workspacePath, sessionDir, { id: sessionId });
		const existingRequest = { ...REQUEST, placement: { kind: "existing_worktree" as const, worktreeId: "existing" } };
		const existingRequestDigest = digestIrohRemoteAgentLaunchRequest("volt", existingRequest);
		const existingReceipt = manager.appendAgentLaunchReceipt({
			launchId: REQUEST.launchId,
			requestDigest: existingRequestDigest,
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request: existingRequest,
			placement: { kind: "worktree", worktreeId: "existing", branch: "feature/existing", created: false },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		manager.appendAgentLaunchCommit(existingReceipt.id, REQUEST.launchId);
		await manager.flush();

		await harness.service.reconcileAgentLaunchesOnStart(new AbortController().signal);

		expect(finalizeLaunchWorktree).toHaveBeenCalledWith("volt", "existing", existingRequestDigest, sessionId);
	});

	test("startup does not replay selection from a committed launch", async () => {
		const harness = await createHarness({});
		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const manager = SessionManager.create(harness.workspacePath, sessionDir, { id: sessionId });
		const committedReceipt = manager.appendAgentLaunchReceipt({
			launchId: REQUEST.launchId,
			requestDigest: digestIrohRemoteAgentLaunchRequest("volt", REQUEST),
			clientNodeId: "client-node",
			previousSessionId: "session-old",
			request: REQUEST,
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		});
		manager.appendAgentLaunchCommit(committedReceipt.id, REQUEST.launchId);
		await manager.flush();
		await harness.stateManager.setClientLastSessionId("client-node", "volt", "session-newer");
		(harness.service as unknown as { engine?: unknown }).engine = undefined;

		await harness.service.reconcileAgentLaunchesOnStart(new AbortController().signal);

		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(
			"session-newer",
		);
		await expect(SessionManager.findForResume(sessionDir, sessionId)).resolves.toBeDefined();
	});

	test("finalizes instead of rolling back when a post-append failure has a durable commit", async () => {
		const harness = await createHarness({
			beforeCommitFlush: async () => {
				throw new Error("commit flush failed");
			},
		});

		const result = await harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST);

		const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
		expect(result).toMatchObject({ kind: "created", sessionId });
		expect(harness.runtimes.size).toBe(1);
		expect(harness.broker.list()).toEqual([
			expect.objectContaining({ state: "daemon-detached", pendingDaemonAttaches: 0 }),
		]);
		expect(harness.disposeRuntime).not.toHaveBeenCalled();
		expect((await harness.stateManager.getClient("client-node"))?.lastSessionIdByWorkspace?.volt).toBe(sessionId);
		const sessionDir = getDefaultSessionDir(harness.workspacePath, harness.agentDir);
		const session = await SessionManager.findForResume(sessionDir, sessionId);
		expect(session).toBeDefined();
		expect(
			SessionManager.open(session!.path, sessionDir).getAgentLaunchRecord(REQUEST.launchId)?.commit,
		).toBeDefined();
		await harness.runtimes.stopAll("test_cleanup");
	});
});
