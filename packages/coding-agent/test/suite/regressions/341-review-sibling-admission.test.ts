import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../../../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { registerReviewHandoffAliases } from "../../../src/core/review-anchors.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getCanonicalReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	ConversationCoordinator,
	ConversationCoordinatorRegistry,
} from "../../../src/daemon/conversation-coordinator.ts";
import { type IntegratedRuntimeEntry, IntegratedRuntimeRegistry } from "../../../src/daemon/integrated-runtimes.ts";
import { IrohDaemonAdmissionGate } from "../../../src/daemon/iroh-service.ts";
import { LeaseBroker } from "../../../src/daemon/lease-broker.ts";
import {
	beginReviewSiblingAdmission,
	withReviewSourceWriteLease,
} from "../../../src/daemon/review-sibling-admission.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-341-admission-"));
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const gate = new IrohDaemonAdmissionGate();
	const coordinators = new ConversationCoordinatorRegistry();
	const stateManager = new IrohRemoteHostStateManager();
	let registry: IntegratedRuntimeRegistry;
	const broker = new LeaseBroker({
		isRuntimeStreaming: (ws, id) => registry.findOwner(ws, id)?.runtime.session.isBusy === true,
		waitForRuntimeIdle: async (ws, id) => {
			await registry.findOwner(ws, id)?.runtime.session.waitForIdle();
		},
		disposeRuntime: async (ws, id, reason) => {
			const entry = registry.findOwner(ws, id);
			if (entry) await registry.stopEntry(entry, reason);
		},
		closePhoneStreams: () => {},
		closeRelays: () => {},
		audit: () => {},
		beginTuiLeaseHandoff: (ws, id, connection) => coordinators.getOrCreate(ws, id).beginTuiLeaseHandoff(connection),
		commitTuiLeaseHandoff: (ws, id, connection) => coordinators.getOrCreate(ws, id).commitTuiLeaseHandoff(connection),
		cancelTuiLeaseHandoff: (ws, id, connection) => coordinators.get(ws, id)?.cancelTuiLeaseHandoff(connection),
		releaseTuiLease: (ws, id, connection) => coordinators.get(ws, id)?.releaseTuiLease(connection),
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
	});
	coordinators.bindLeaseBroker(broker);
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			tools: ["read"],
			disableMcp: true,
		});
		return {
			...created,
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				gitContextProvider: created.session.gitContextProvider,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const source = await createAgentSessionRuntime(factory, {
		sessionManager: await SessionManager.create(root, join(root, "sessions")),
		cwd: root,
		agentDir: root,
	});
	const record: ReviewRunRecord = {
		schemaVersion: 1,
		runId: "run",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "revision",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "findings",
			overallExplanation: "evidence",
			findings: [1, 2, 3, 4].map((n) => ({
				id: `f${n}`,
				fingerprint: `fp${n}`,
				status: "open",
				title: `Finding ${n}`,
				body: "evidence",
				trigger: "input",
				impact: "wrong",
				category: "correctness",
				rootCauseKey: `cause${n}`,
				priority: 2,
				confidence: 1,
				changeLocation: { path: "file.ts", side: "head", startLine: 1, endLine: 1 },
				evidenceLocations: [],
				verification: { outcome: "accepted", method: "read", rationale: "evidence", confidence: 1 },
			})),
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
		},
	};
	await appendReviewRunDurably(source.session.sessionManager, record);
	const validate = vi.fn(async () => {});
	const published = vi.fn((_entry: IntegratedRuntimeEntry) => {});
	const createRuntime = vi.fn(async () => ({
		runtime: source,
		sessionSelection: {
			kind: "resumed" as const,
			requestedSessionId: source.session.sessionId,
			sessionId: source.session.sessionId,
		},
	}));
	registry = new IntegratedRuntimeRegistry({
		agentDir: root,
		coordinators,
		auditLogger: new IrohRemoteAuditLogger({ sink: { write: () => {} } }),
		stateManager,
		activeStreams: new IrohRemoteActiveStreamRegistry(),
		detachedRuntimeTtlMs: () => 60_000,
		getProjectTrustedForWorkspace: () => false,
		setClientLastSessionId: async () => undefined,
		createRuntime,
		withReviewSourceWrite: (parent, ref, write) => {
			const lease = gate.tryAcquire();
			if (!lease) return Promise.reject(new Error("admission closed"));
			return withReviewSourceWriteLease({
				workspaceName: parent.workspaceName,
				sessionId: ref.sessionId,
				broker,
				lease,
				write,
				validateWorkspace: validate,
			});
		},
		onRuntimePublished: published,
		beginReviewSiblingAdmission: (parent, id) => {
			const lease = gate.tryAcquire();
			if (!lease) throw new Error("admission closed");
			return beginReviewSiblingAdmission({
				workspaceName: parent.workspaceName,
				sessionId: id,
				broker,
				lease,
				validateWorkspace: validate,
			});
		},
	});
	cleanups.push(async () => {
		gate.close();
		await registry.stopAll("test_cleanup");
		await source.dispose();
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		paired: false,
		pairingSecretConsumed: false,
		client: {
			nodeId: "phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		workspace: { name: "ws", path: root },
		workspaceGeneration: 1,
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
	await stateManager.save({
		...(await stateManager.getState()),
		clients: [authorization.client],
		workspaces: [authorization.workspace],
	});
	const handshake = (id: string) => ({
		hello: {
			type: "volt_iroh_hello",
			protocol: "volt-rpc/0",
			workspace: "ws",
			mode: "conversation",
			conversation: { target: "session", sessionId: id },
		} as IrohRemoteHello,
		response: {} as IrohRemoteHandshakeSuccess,
	});
	const prepared = await registry.getOrCreateEntry(handshake(source.session.sessionId), authorization);
	const sourceLease = gate.tryAcquire()!;
	const admission = beginReviewSiblingAdmission({
		workspaceName: "ws",
		sessionId: source.session.sessionId,
		broker,
		lease: sourceLease,
		validateWorkspace: async () => {},
	});
	admission.commit(prepared.entry.coordinator);
	await registry.commitEntry(prepared.entry, prepared.sessionSelection, authorization, prepared.attachClaim);
	admission.finalize();
	admission.release();
	prepared.attachClaim.release();
	published.mockClear();
	return {
		root,
		registry,
		source,
		gate,
		broker,
		validate,
		published,
		harness,
		authorization,
		handshake,
		createRuntime,
		record,
	};
}

describe("Regression #341 real daemon sibling broker admission", () => {
	it("publishes four independent broker-owned conversations without replacing the source", async () => {
		const f = await fixture();
		f.harness.setResponses([1, 2, 3, 4].map(() => fauxAssistantMessage("answer")));
		const result = await f.source.reviewDiscussions!.start("run", ["f1", "f2", "f3", "f4"], "start");
		expect(result.results.every((row) => row.outcome === "created")).toBe(true);
		expect(f.registry.size).toBe(5);
		for (const row of result.results) {
			const entry = f.registry.findOwner("ws", row.discussion!.sessionId)!;
			expect(entry.lifecycle).toBe("active");
			expect(entry.leaseOwner).toBeDefined();
			expect(f.broker.isDaemonRuntimeOwnerCurrent(entry.leaseOwner!, "ws", entry.sessionId)).toBe(true);
			await entry.runtime.session.waitForIdle();
		}
		expect(f.published).toHaveBeenCalledTimes(4);
		expect(f.createRuntime).toHaveBeenCalledOnce();
		await f.gate.waitForDrain();
	});

	it.each([
		{ workspace: "other", generation: 1 },
		{ workspace: "ws", generation: 2 },
	])("does not borrow runtime state from another workspace authority: %j", async ({ workspace, generation }) => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const first = (await f.source.reviewDiscussions!.start("run", ["f1"], "start")).results[0]!.discussion!;
		const local = f.registry.findOwner("ws", first.sessionId)!;
		await local.runtime.session.waitForIdle();
		const ref = local.runtime.session.sessionRef!;
		await f.registry.stopEntry(local, "test_detach");
		const foreign = await f.source.createReviewDiscussionSibling(await SessionManager.open(ref));
		f.createRuntime.mockResolvedValueOnce({
			runtime: foreign,
			sessionSelection: { kind: "resumed", requestedSessionId: ref.sessionId, sessionId: ref.sessionId },
		});
		const authorization = {
			...f.authorization,
			workspace: { name: workspace, path: f.root },
			workspaceGeneration: generation,
		};
		const request = f.handshake(ref.sessionId);
		const prepared = await f.registry.getOrCreateEntry(
			{ ...request, hello: { ...request.hello, workspace } },
			authorization,
		);
		const admission = beginReviewSiblingAdmission({
			workspaceName: workspace,
			sessionId: ref.sessionId,
			broker: f.broker,
			lease: f.gate.tryAcquire()!,
			validateWorkspace: async () => {},
		});
		admission.commit(prepared.entry.coordinator);
		await f.registry.commitEntry(prepared.entry, prepared.sessionSelection, authorization, prepared.attachClaim);
		admission.finalize();
		admission.release();
		prepared.attachClaim.release();
		const busy = vi.spyOn(foreign.session, "isBusy", "get").mockReturnValue(true);
		try {
			expect((await f.source.reviewDiscussions!.list("run")).discussions[0]!.status).toBe("completed");
		} finally {
			busy.mockRestore();
		}
	});

	it("rolls back a publication failure and can retry the same durable child", async () => {
		const f = await fixture();
		f.published.mockImplementationOnce(() => {
			throw new Error("publication failed");
		});
		const failed = await f.source.reviewDiscussions!.start("run", ["f1"], "start");
		expect(failed.results[0]!.outcome).toBe("failed");
		const id = failed.results[0]!.discussion!.sessionId;
		expect(f.registry.findOwner("ws", id)).toBeUndefined();
		expect(f.broker.lookup("ws", id)).toBeUndefined();
		f.harness.setResponses([fauxAssistantMessage("retry")]);
		const retried = await f.source.reviewDiscussions!.start("run", ["f1"], "retry");
		expect(retried.results[0]).toMatchObject({ outcome: "existing", discussion: { sessionId: id } });
		await f.registry.findOwner("ws", id)!.runtime.session.waitForIdle();
		await f.gate.waitForDrain();
	});

	it("fences shutdown and workspace validation failures without leaking pending claims", async () => {
		const f = await fixture();
		f.validate.mockImplementationOnce(async () => {
			f.gate.close();
		});
		const result = await f.source.reviewDiscussions!.start("run", ["f1"], "start");
		expect(result.results[0]!.outcome).toBe("failed");
		const id = result.results[0]!.discussion!.sessionId;
		expect(f.registry.findOwner("ws", id)).toBeUndefined();
		expect(f.broker.lookup("ws", id)).toBeUndefined();
		await f.gate.waitForDrain();
	});

	it("cleans a provisional lease when activation fails before publication", async () => {
		const f = await fixture();
		const activate = vi.spyOn(ConversationCoordinator.prototype, "activateRuntime");
		activate.mockImplementationOnce(() => {
			throw new Error("activation failed");
		});
		const result = await f.source.reviewDiscussions!.start("run", ["f1"], "start");
		expect(result.results[0]!.outcome).toBe("failed");
		const id = result.results[0]!.discussion!.sessionId;
		expect(f.registry.findOwner("ws", id)).toBeUndefined();
		expect(f.broker.lookup("ws", id)).toBeUndefined();
		activate.mockRestore();
		f.harness.setResponses([fauxAssistantMessage("retry")]);
		expect((await f.source.reviewDiscussions!.start("run", ["f1"], "retry")).results[0]!.outcome).toBe("existing");
		await f.registry.findOwner("ws", id)!.runtime.session.waitForIdle();
		await f.gate.waitForDrain();
	});

	it("does not seed through another TUI's producer ownership", async () => {
		const f = await fixture();
		f.validate.mockRejectedValueOnce(new Error("defer initialization"));
		const first = await f.source.reviewDiscussions!.start("run", ["f1"], "start");
		const id = first.results[0]!.discussion!.sessionId;
		expect(await f.broker.acquireForTui({ connectionId: "tui", workspaceName: "ws", sessionId: id })).toMatchObject({
			kind: "granted",
		});
		const ref = await SessionManager.findForResume(join(f.root, "sessions"), id);
		const tuiManager = await SessionManager.open(ref!);
		try {
			expect(tuiManager.getEntries()).toHaveLength(0);
			expect((await f.source.reviewDiscussions!.start("run", ["f1"], "retry")).results[0]!.outcome).toBe("failed");
			tuiManager.appendSessionInfo("TUI owns initialization");
			// If the losing service had seeded first, this owner's revision would be stale.
			await expect(tuiManager.flush()).resolves.toBeUndefined();
			expect(f.registry.findOwner("ws", id)).toBeUndefined();
			expect(f.broker.lookup("ws", id)?.state).toBe("tui-owned");
		} finally {
			await tuiManager.closePersistence();
		}
		await f.gate.waitForDrain();
	});

	it("revokes a pending launch before draining the source RPC stream", async () => {
		const f = await fixture();
		let release!: () => void;
		f.validate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const starting = f.source.reviewDiscussions!.start("run", ["f1"], "start");
		const rejected = expect(starting).rejects.toThrow("unavailable");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const id = (await f.source.reviewDiscussions!.list("run")).discussions[0]!.sessionId;
		const captured = f.registry.values();
		f.registry.fenceReviewOperations(captured);
		// Revocation now waits for stream closure while the parent is still active.
		expect(captured[0]!.lifecycle).toBe("active");
		release();
		await rejected;
		expect(f.registry.findOwner("ws", id)).toBeUndefined();
		expect(f.broker.lookup("ws", id)).toBeUndefined();
		expect(f.published).not.toHaveBeenCalled();
		await f.gate.waitForDrain();
	});

	it("revalidates workspace authority after the child factory returns", async () => {
		const f = await fixture();
		f.validate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("workspace replaced"));
		const result = await f.source.reviewDiscussions!.start("run", ["f1"], "start");
		expect(result.results[0]!.outcome).toBe("failed");
		const id = result.results[0]!.discussion!.sessionId;
		expect(f.registry.findOwner("ws", id)).toBeUndefined();
		expect(f.broker.lookup("ws", id)).toBeUndefined();
		expect(f.published).not.toHaveBeenCalled();
		await f.gate.waitForDrain();
	});

	it("keeps reset idle-only and preserves the new child through an old-child TUI handoff", async () => {
		const f = await fixture();
		let finishTurn!: () => void;
		f.harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					finishTurn = resolve;
				});
				return fauxAssistantMessage("answer");
			},
		]);
		const first = (await f.source.reviewDiscussions!.start("run", ["f1"], "start")).results[0]!.discussion!;
		await vi.waitFor(() => expect(finishTurn).toBeTypeOf("function"));
		expect((await f.source.reviewDiscussions!.reset(first.discussionId, first.sessionId, "busy-reset")).status).toBe(
			"busy",
		);
		finishTurn();
		await f.registry.findOwner("ws", first.sessionId)!.runtime.session.waitForIdle();
		let release!: () => void;
		f.validate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const resetting = f.source.reviewDiscussions!.reset(first.discussionId, first.sessionId, "reset");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		let acquired = false;
		const acquiring = f.broker
			.acquireForTui({ connectionId: "tui-old", workspaceName: "ws", sessionId: first.sessionId })
			.then((result) => {
				acquired = true;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acquired).toBe(false);
		release();
		const reset = await resetting;
		expect(reset.status).toBe("reset");
		expect(reset.discussion.currentSessionId).not.toBe(first.sessionId);
		expect(await acquiring).toMatchObject({ kind: "granted" });
		const child = f.registry.findOwner("ws", reset.discussion.currentSessionId)!;
		expect(child.lifecycle).toBe("active");
		expect(child.runtime.session.isBusy).toBe(false);
		expect(child.runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
		expect(f.broker.lookup("ws", first.sessionId)?.state).toBe("tui-owned");
	});

	it("serializes an unloaded canonical outcome write ahead of a competing TUI", async () => {
		const f = await fixture();
		const canonical = await SessionManager.create(f.root, join(f.root, "sessions"));
		const originalId = canonical.getSessionId();
		const coldRecord = { ...f.record, runId: "cold-run" };
		await appendReviewRunDurably(canonical, coldRecord);
		appendReviewRun(f.source.session.sessionManager, coldRecord);
		await f.source.session.sessionManager.materialize();
		await registerReviewHandoffAliases(canonical, f.source.session.sessionManager, ["cold-run"]);
		await canonical.closePersistence();
		let release!: () => void;
		f.validate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const writing = f.source.reviewDiscussions!.recordOutcome({
			runId: "cold-run",
			findingId: "f1",
			status: "fixed",
		});
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		let acquired = false;
		const acquiring = f.broker
			.acquireForTui({ connectionId: "tui", workspaceName: "ws", sessionId: originalId })
			.then((result) => {
				acquired = true;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acquired).toBe(false);
		release();
		await writing;
		expect(await acquiring).toMatchObject({ kind: "granted" });
		expect(
			(await getCanonicalReviewRun(f.source.session.sessionManager, "cold-run"))?.result?.findings[0]?.status,
		).toBe("fixed");
		await expect(
			f.source.reviewDiscussions!.recordOutcome({ runId: "cold-run", findingId: "f1", status: "dismissed" }),
		).rejects.toThrow("owned");
		expect(f.broker.lookup("ws", originalId)?.state).toBe("tui-owned");
		await f.gate.waitForDrain();
	});

	it("keeps source admission alive after detach until its sibling launch settles", async () => {
		const f = await fixture();
		let release!: () => void;
		f.validate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const starting = f.source.reviewDiscussions!.start("run", ["f1"], "start");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const parent = f.registry.findOwner("ws", f.source.session.sessionId)!;
		parent.coordinator.markDetached();
		f.registry.scheduleRetention(parent, "phone_detached", 0);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(parent.lifecycle).toBe("active");
		release();
		const result = await starting;
		expect(result.results[0]!.outcome).toBe("created");
		const child = f.registry.findOwner("ws", result.results[0]!.discussion!.sessionId)!;
		await child.runtime.session.waitForIdle();
		expect(child.lifecycle).toBe("active");
	});

	it("holds a concurrent phone attach until sibling publication completes", async () => {
		const f = await fixture();
		let release!: () => void;
		f.validate.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const starting = f.source.reviewDiscussions!.start("run", ["f1"], "start");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const listing = await f.source.reviewDiscussions!.list("run");
		const id = listing.discussions[0]!.sessionId;
		let attached = false;
		const attaching = f.registry.getOrCreateEntry(f.handshake(id), f.authorization).then((value) => {
			attached = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(attached).toBe(false);
		release();
		const started = await starting;
		expect(started.results[0]!.outcome).toBe("created");
		const entry = await attaching;
		expect(entry.created).toBe(false);
		expect(entry.entry).toBe(f.registry.findOwner("ws", id));
		entry.attachClaim.release();
		await entry.entry.runtime.session.waitForIdle();
		expect(f.createRuntime).toHaveBeenCalledOnce();
	});
});
