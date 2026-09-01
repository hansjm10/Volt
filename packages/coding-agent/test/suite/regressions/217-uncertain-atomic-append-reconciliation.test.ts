import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	SessionConversationStateUnavailableError,
	type SessionEntry,
	SessionManager,
	type SessionReference,
} from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SessionStoreTransactionResult,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createAgentSessionTestControl } from "../../agent-session-test-control.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "../harness.ts";

const managers: SessionManager[] = [];
const storeLeases: SQLiteSessionStoreLease[] = [];

async function own(manager: Promise<SessionManager>): Promise<SessionManager> {
	const resolved = await manager;
	managers.push(resolved);
	return resolved;
}

async function trackedStore(sessionDirectory: string): Promise<SQLiteSessionStoreClient> {
	const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
	storeLeases.push(lease);
	return lease.client;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function commitPlanningState(manager: SessionManager, mode: "build" | "plan"): Promise<void> {
	const projection = manager.issueCanonicalProjection();
	await manager.commitCanonicalCommand({
		guard: { kind: "exact", token: projection.token },
		mutations: [{ kind: "append", entry: { type: "planning_state_change", planning: { mode, plan: null } } }],
	});
}

interface PlanningSnapshot {
	phase: string | undefined;
	checkpoints: number;
	userTexts: string[];
}

function snapshotEntries(entries: readonly SessionEntry[]): PlanningSnapshot {
	const planning = entries.filter((entry) => entry.type === "planning_state_change").at(-1);
	return {
		phase: planning?.planning.plan?.phase,
		checkpoints: entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint",
		).length,
		userTexts: entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
		),
	};
}

function snapshotHarness(harness: Harness): PlanningSnapshot {
	return {
		...snapshotEntries(harness.sessionManager.getBranch()),
		phase: harness.session.planningState.plan?.phase,
	};
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = harness.session.updatePlan({
		title: "Atomic append reconciliation",
		summary: "Reconcile committed SQLite transactions before publication.",
		steps: [{ text: "Prove the transaction outcome before publication" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
	await harness.sessionManager.flush();
}

type TransactionFaultMode =
	| "rollback"
	| "reconcile_committed"
	| "pause_committed"
	| "uncertain_rollback"
	| "uncertain_committed";

interface TransactionFaultEvidence {
	expectedRevision?: number;
	applyResult?: SessionStoreTransactionResult;
	reconcileCalls: number;
}

async function faultNextPlanningTransaction(
	manager: SessionManager,
	mode: TransactionFaultMode,
	pause?: { started(): void; release: Promise<void> },
): Promise<TransactionFaultEvidence> {
	const store = await trackedStore(manager.getSessionDir());
	const applyTransaction = store.applyTransaction.bind(store);
	const reconcileCommit = store.reconcileCommit.bind(store);
	const evidence: TransactionFaultEvidence = { reconcileCalls: 0 };
	let intercepted = false;

	vi.spyOn(store, "applyTransaction").mockImplementation(async (input) => {
		if (intercepted || !input.payload.entries.some((entry) => entry.type === "planning_state_change")) {
			return applyTransaction(input);
		}
		intercepted = true;
		evidence.expectedRevision = input.expectedRevision;
		if (mode === "rollback" || mode === "uncertain_rollback") {
			throw new Error("injected transaction request failure");
		}
		evidence.applyResult = await applyTransaction(input);
		throw new Error("injected lost transaction response");
	});

	vi.spyOn(store, "reconcileCommit").mockImplementation(async (input) => {
		if (!intercepted) return reconcileCommit(input);
		evidence.reconcileCalls++;
		if (mode === "pause_committed") {
			pause?.started();
			await pause?.release;
		}
		if (mode === "uncertain_rollback" || mode === "uncertain_committed") {
			throw new Error("injected reconciliation failure");
		}
		return reconcileCommit(input);
	});
	return evidence;
}

describe("regression #217: SQLite transaction reconciliation", () => {
	const harnesses: Harness[] = [];
	const runtimeCleanups: Array<() => Promise<void>> = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (runtimeCleanups.length > 0) await runtimeCleanups.pop()?.();
		while (harnesses.length > 0)
			await harnesses
				.pop()!
				.cleanupAsync()
				.catch(() => {});
		while (managers.length > 0) await managers.pop()!.drainPersistence();
		vi.restoreAllMocks();
		while (storeLeases.length > 0) await storeLeases.pop()!.release();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	async function setupRuntime(replacementHook: () => void = () => {}): Promise<{
		runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
		faux: ReturnType<typeof registerFauxProvider>;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-runtime-"));
		tempDirs.push(tempDir);
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("must remain unused")]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(model.provider, {
							baseUrl: model.baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						volt.on("session_before_switch", replacementHook);
						volt.on("session_shutdown", replacementHook);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await own(SessionManager.create(tempDir, join(tempDir, "sessions"))),
		});
		await runtime.session.bindExtensions({});
		runtimeCleanups.push(async () => {
			await runtime.dispose().catch(() => {});
			faux.unregister();
		});
		return { runtime, faux };
	}

	async function makeRuntimeAuthorityUncertain(
		runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
	): Promise<void> {
		await runtime.session.setAgentMode("plan");
		const draft = runtime.session.updatePlan({
			title: "Runtime reconciliation",
			summary: "Replace the retired manager generation.",
			steps: [{ text: "Reopen authoritative SQLite state" }],
		});
		runtime.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await runtime.session.sessionManager.flush();
		await runtime.session.steer("retire this runtime", undefined, "issue-217-runtime-replacement");
		await faultNextPlanningTransaction(runtime.session.sessionManager, "uncertain_committed");
		await expect(createAgentSessionTestControl(runtime.session).continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
		expect(runtime.session.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
	}

	async function setup(options: HarnessOptions = {}): Promise<{
		harness: Harness;
		sessionRef: SessionReference;
		baseline: PlanningSnapshot;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-"));
		tempDirs.push(tempDir);
		const sessionManager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		const harness = await createHarness({ ...options, sessionManager });
		harnesses.push(harness);
		await createReadyPlan(harness);
		return {
			harness,
			sessionRef: sessionManager.getSessionRef()!,
			baseline: snapshotHarness(harness),
		};
	}

	it("replaces a genuinely reconciliation-required runtime without old-generation hooks", async () => {
		let replacementHookCalls = 0;
		const { runtime } = await setupRuntime(() => {
			replacementHookCalls++;
		});
		await makeRuntimeAuthorityUncertain(runtime);
		const previousSession = runtime.session;
		expect(() =>
			runtime.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must not snapshot stale authority");
				},
			}),
		).toThrow(SessionConversationStateUnavailableError);

		await expect(runtime.newSession()).resolves.toEqual({ cancelled: false, seeded: false });

		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(replacementHookCalls).toBe(0);
	});

	it("refreshes a reconciliation-required runtime from the same stable session reference", async () => {
		const { runtime } = await setupRuntime();
		await makeRuntimeAuthorityUncertain(runtime);
		const previousSession = runtime.session;
		const previousSessionRef = previousSession.sessionRef;
		const previousBranchEpoch = runtime.conversationProjectionFeed.branchEpoch;
		const prepareReplacement = vi.fn(async () => undefined);
		runtime.setPrepareSessionReplacement(prepareReplacement);

		await expect(runtime.switchSessionById(previousSession.sessionId)).resolves.toEqual({
			cancelled: false,
			seeded: false,
		});

		expect(runtime.session).not.toBe(previousSession);
		expect(runtime.session.sessionRef).toEqual(previousSessionRef);
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(runtime.conversationProjectionFeed.branchEpoch).not.toBe(previousBranchEpoch);
		expect(prepareReplacement).not.toHaveBeenCalled();
	});

	it("rejects a stale manager at the revision boundary without changing the committed winner", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-stale-manager-"));
		tempDirs.push(tempDir);
		const current = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		current.appendPlanningState({ mode: "build", plan: null });
		await current.flush();
		const sessionRef = current.getSessionRef()!;
		const stale = await own(SessionManager.open(sessionRef, tempDir));

		current.appendPlanningState({ mode: "plan", plan: null });
		await current.flush();
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winner = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);

		await expect(commitPlanningState(stale, "build")).rejects.toMatchObject({
			effect: "not_started",
			authority: "reconciliation_required",
			message: expect.stringMatching(/Session revision changed from \d+ to \d+/),
		});

		expect(await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration)).toMatchObject({
			revision: winner?.revision,
		});
		expect(stale.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		expect(() => stale.getEntries()).toThrow(SessionConversationStateUnavailableError);
		await expect(stale.drainPersistence()).resolves.toMatchObject({ status: "reconciliation_required" });
		expect((await own(SessionManager.open(sessionRef, tempDir))).buildSessionContext().planning).toEqual({
			mode: "plan",
			plan: null,
		});
	});

	it("retains delivery and client-input ownership when the transaction is proven rolled back", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-rolled-back";
		await harness.session.steer("retain this feedback", undefined, clientMessageId);
		const evidence = await faultNextPlanningTransaction(harness.sessionManager, "rollback");

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});

		expect(snapshotHarness(harness)).toEqual(baseline);
		const reopened = await own(SessionManager.open(sessionRef));
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		const summary = await (await trackedStore(sessionRef.sessionDirectory)).findSessionSummary(
			sessionRef.sessionId,
			sessionRef.sessionGeneration,
		);
		expect(summary?.revision).toBe(evidence.expectedRevision);
		expect(evidence.applyResult).toBeUndefined();
		expect(evidence.reconcileCalls).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("publishes a committed delivery after reconciling a lost transaction response", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("candidate committed")]);
		const preflight: PromptPreflightResult[] = [];
		const clientMessageId = "issue-217-reconciled-commit";
		const evidence = await faultNextPlanningTransaction(harness.sessionManager, "reconcile_committed");

		await harness.session.prompt("publish the reconciled commit", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});

		const expected = {
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["publish the reconciled commit"],
		};
		expect(snapshotHarness(harness)).toEqual(expected);
		const reopened = await own(SessionManager.open(sessionRef));
		expect(snapshotEntries(reopened.getBranch())).toEqual(expected);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(evidence.applyResult).toMatchObject({ status: "committed" });
		expect(evidence.reconcileCalls).toBe(1);
		if (evidence.applyResult?.status !== "committed") throw new Error("Expected committed transaction evidence");
		expect(evidence.applyResult.evidence).toMatchObject({
			beforeRevision: evidence.expectedRevision,
			afterRevision: (evidence.expectedRevision ?? Number.NaN) + 1,
		});
		const summary = await (await trackedStore(sessionRef.sessionDirectory)).findSessionSummary(
			sessionRef.sessionId,
			sessionRef.sessionGeneration,
		);
		expect(summary?.revision).toBeGreaterThanOrEqual(evidence.applyResult.evidence.afterRevision);
		expect(preflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("gates planning, delivery, RPC acceptance, and provider work until commit reconciliation completes", async () => {
		const { harness, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("proof completed")]);
		const proofStarted = deferred();
		const releaseProof = deferred();
		const evidence = await faultNextPlanningTransaction(harness.sessionManager, "pause_committed", {
			started: proofStarted.resolve,
			release: releaseProof.promise,
		});
		const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
		const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
		const preflight: PromptPreflightResult[] = [];

		const prompting = harness.session.prompt("wait for transaction proof", {
			clientMessageId: "issue-217-gated-direct-rpc",
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});
		await proofStarted.promise;

		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
		expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
		expect(preflight).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		releaseProof.resolve();
		await prompting;

		expect(evidence.applyResult).toMatchObject({ status: "committed" });
		expect(evidence.reconcileCalls).toBe(1);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore + 1);
		expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore + 1);
		expect(preflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("terminally consumes a stale-generation delivery and recovers it from a fresh manager", async () => {
		const { harness, sessionRef } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-stale-generation";
		await harness.session.steer("recover from the authoritative revision", undefined, clientMessageId);
		await harness.sessionManager.flush();

		const current = await own(SessionManager.open(sessionRef));
		current.appendSessionInfo("newer manager generation");
		await current.flush();
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winnerRevision = (await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))
			?.revision;

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

		expect(harness.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		expect((await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))?.revision).toBe(
			winnerRevision,
		);
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);

		const reopened = await own(SessionManager.open(sessionRef));
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
			kind: "replay",
			records: [{ clientMessageId }],
		});
		const replacement = await createHarness({ sessionManager: reopened });
		harnesses.push(replacement);
		replacement.setResponses([fauxAssistantMessage("fresh manager recovered delivery")]);

		await replacement.session.resumeRecoveredClientInputs();

		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(getUserTexts(replacement)).toEqual(["recover from the authoritative revision"]);
		expect(getAssistantTexts(replacement)).toEqual(["fresh manager recovered delivery"]);
		expect(replacement.getPendingResponseCount()).toBe(0);
	});

	it("rejects new work before extension, MCP, bash, provider, queue, or planning effects after an unknown outcome", async () => {
		let inputHookCalls = 0;
		const { harness } = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("input", () => {
						inputHookCalls++;
						return { action: "continue" };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const mcpStart = vi.fn(async () => undefined);
		const mcpDispose = vi.fn(async () => undefined);
		const internals = harness.session as unknown as {
			_mcpManager?: { startEagerServers(): Promise<void>; dispose(): Promise<void> };
		};
		internals._mcpManager = { startEagerServers: mcpStart, dispose: mcpDispose };
		await harness.session.steer("fail authority", undefined, "issue-217-side-effect-fence");
		await harness.session.followUp("hand back later input");
		await faultNextPlanningTransaction(harness.sessionManager, "uncertain_rollback");

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

		const bashOperations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
		const planningEvents = harness.eventsOfType("planning_state_changed").length;
		const messageEvents = harness.events.filter(
			(event) => event.type === "message_start" || event.type === "message_end",
		).length;
		const preflight: PromptPreflightResult[] = [];

		await expect(
			harness.session.prompt("must reject", {
				clientMessageId: "issue-217-rejected-prompt",
				source: "rpc",
				preflightResult: (result) => preflight.push(result),
			}),
		).rejects.toBeInstanceOf(SessionConversationStateUnavailableError);
		await expect(harness.session.steer("must not queue")).rejects.toBeInstanceOf(
			SessionConversationStateUnavailableError,
		);
		await expect(harness.session.followUp("must not queue")).rejects.toBeInstanceOf(
			SessionConversationStateUnavailableError,
		);
		await expect(
			harness.session.executeBash("must-not-run", undefined, { operations: bashOperations }),
		).rejects.toBeInstanceOf(SessionConversationStateUnavailableError);
		expect(() => harness.session.setAgentMode("build")).toThrow(SessionConversationStateUnavailableError);
		expect(() =>
			harness.session.updatePlan({
				title: "must not update",
				summary: "must not update",
				steps: [{ text: "must not update" }],
			}),
		).toThrow(SessionConversationStateUnavailableError);

		expect(preflight).toEqual([]);
		expect(inputHookCalls).toBe(0);
		expect(mcpStart).not.toHaveBeenCalled();
		expect(bashOperations.exec).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEvents);
		expect(
			harness.events.filter((event) => event.type === "message_start" || event.type === "message_end"),
		).toHaveLength(messageEvents);

		await expect(harness.session.abort()).resolves.toBeUndefined();
		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: [],
			followUp: ["hand back later input"],
		});
		expect(harness.control.hasQueuedMessages()).toBe(false);
		harness.session.dispose();
		await expect(harness.session.waitForClosed()).rejects.toThrow("outcome could not be reconciled");
		expect(mcpDispose).toHaveBeenCalledOnce();
	});

	it.each([
		{ mode: "uncertain_committed" as const, authoritativeOutcome: "committed" as const },
		{ mode: "uncertain_rollback" as const, authoritativeOutcome: "rolled_back" as const },
	])(
		"recovers from the authoritative $authoritativeOutcome transaction after reconciliation is unavailable",
		async ({ mode, authoritativeOutcome }) => {
			const { harness, sessionRef, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const clientMessageId = `issue-217-unavailable-${authoritativeOutcome}`;
			const laterClientMessageId = `issue-217-later-${authoritativeOutcome}`;
			await harness.session.steer("unproven feedback", undefined, clientMessageId);
			await harness.session.followUp("later queued feedback", undefined, laterClientMessageId);
			const evidence = await faultNextPlanningTransaction(harness.sessionManager, mode);
			const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
			const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
			const queueEventsBefore = harness.eventsOfType("queue_update").length;

			await expect(harness.control.continue()).resolves.toMatchObject({
				status: "delivery_failed",
				failure: { outcome: "terminally_failed", phase: "settlement" },
			});

			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(harness.eventsOfType("queue_update")).toHaveLength(queueEventsBefore);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
			expect(evidence.reconcileCalls).toBe(1);
			const store = await trackedStore(sessionRef.sessionDirectory);
			const summary = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);
			expect(summary?.revision).toBe(
				authoritativeOutcome === "committed"
					? (evidence.expectedRevision ?? Number.NaN) + 1
					: evidence.expectedRevision,
			);
			expect(evidence.applyResult).toEqual(
				authoritativeOutcome === "committed" ? expect.objectContaining({ status: "committed" }) : undefined,
			);
			expect(() => harness.sessionManager.getEntries()).toThrow(SessionConversationStateUnavailableError);
			expect(harness.session.sessionRef).toEqual(sessionRef);
			await expect(harness.sessionManager.drainPersistence()).resolves.toMatchObject({
				status: "reconciliation_required",
			});

			const reopened = await own(SessionManager.open(sessionRef));
			const replacement = await createHarness({ sessionManager: reopened });
			harnesses.push(replacement);
			if (authoritativeOutcome === "committed") {
				replacement.setResponses([fauxAssistantMessage("fresh recovery later")]);
				expect(snapshotEntries(reopened.getBranch())).toEqual({
					phase: "draft",
					checkpoints: baseline.checkpoints + 1,
					userTexts: ["unproven feedback"],
				});
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
				expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId: laterClientMessageId }],
				});
			} else {
				replacement.setResponses([
					fauxAssistantMessage("fresh recovery first"),
					fauxAssistantMessage("fresh recovery later"),
				]);
				expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
				expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId }, { clientMessageId: laterClientMessageId }],
				});
			}

			await replacement.session.resumeRecoveredClientInputs();
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(replacement)).toEqual(["unproven feedback", "later queued feedback"]);
			expect(getAssistantTexts(replacement)).toEqual(
				authoritativeOutcome === "committed"
					? ["fresh recovery later"]
					: ["fresh recovery first", "fresh recovery later"],
			);
			expect(replacement.getPendingResponseCount()).toBe(0);
		},
	);
});
