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
import { createIrohRemoteAgentLaunchSessionId } from "../src/core/remote/iroh/agent-launch.ts";
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
import { createTestSession } from "./iroh-stream-doubles.ts";

const cleanupPaths: string[] = [];
const RPC_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;
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
		): Promise<IrohRemoteAgentLaunchResult>;
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
	failSelectionPersistence?: boolean;
}): Promise<LaunchHarness> {
	const agentDir = await mkdtemp(join(tmpdir(), "volt-launch-transaction-"));
	cleanupPaths.push(agentDir);
	const workspacePath = join(agentDir, "workspace");
	await mkdir(workspacePath, { recursive: true });
	let persisted = createState(workspacePath);
	let failNextWrite = false;
	const stateManager = options.failSelectionPersistence
		? new IrohRemoteHostStateManager({
				store: {
					read: () => structuredClone(persisted),
					write: (state) => {
						if (failNextWrite) {
							failNextWrite = false;
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
	const sessionId = createIrohRemoteAgentLaunchSessionId("client-node", "volt", REQUEST.launchId);
	const runtime = {
		session: createTestSession(sessionId, null),
		dispose: disposeRuntime,
	} as unknown as AgentSessionRuntime;
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
		worktrees: {},
		leaseBroker: broker,
		runtimes,
		log: vi.fn(),
		dependencies: {
			createAgentLaunchRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created" as const, sessionId },
			}),
			beforeAgentLaunchPublication: async () => {
				if (options.failSelectionPersistence) failNextWrite = true;
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
	test("commits a created launch last and returns existing for an identical retry", async () => {
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

		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, REQUEST),
		).resolves.toMatchObject({ kind: "existing", launchId: "launch-1", sessionId });
		await expect(
			harness.service.createConfiguredDetachedAgent(harness.authorization, {
				...REQUEST,
				placement: { kind: "workspace", workingDirectory: "other" },
			}),
		).resolves.toMatchObject({ kind: "error", error: { kind: "launch_conflict" } });
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

	test("rolls back runtime ownership and keeps the prior selection when selection persistence fails", async () => {
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

	test("restores selection, retires the runtime, and removes the receipt when final commit flush fails", async () => {
		const harness = await createHarness({
			beforeCommitFlush: async () => {
				throw new Error("commit flush failed");
			},
		});

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
});
