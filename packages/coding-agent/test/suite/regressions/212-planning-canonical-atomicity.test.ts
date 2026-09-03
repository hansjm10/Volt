import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePersistedSessionEntry } from "../../../src/core/session-entry-codec.ts";
import { type SessionEntry, SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

async function faultNextTransaction(
	manager: SessionManager,
	stage: "before" | "pause",
	pause?: { started(): void; release: Promise<void> },
): Promise<SQLiteSessionStoreLease> {
	const lease = await acquireSharedSQLiteSessionStore(manager.getSessionDir());
	const store = lease.client;
	const applyTransaction = store.applyTransaction.bind(store);
	vi.spyOn(store, "applyTransaction").mockImplementation(async (input) => {
		if (
			!input.payload.entries.some(
				(entry) => parsePersistedSessionEntry(entry.entry).type === "planning_state_change",
			)
		) {
			return applyTransaction(input);
		}
		if (stage === "before") throw new Error("injected pre-commit transaction failure");
		pause?.started();
		await pause?.release;
		return applyTransaction(input);
	});
	return lease;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
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

async function snapshotReopened(sessionRef: SessionReference): Promise<PlanningSnapshot> {
	const manager = await SessionManager.open(sessionRef);
	try {
		return snapshotEntries(manager.getBranch());
	} finally {
		await manager.closePersistence();
	}
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = harness.session.updatePlan({
		title: "Atomic planning feedback",
		summary: "Commit plan state and canonical feedback together.",
		steps: [{ text: "Apply feedback atomically" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
	await harness.sessionManager.flush();
}

describe("regression #212: planning and canonical delivery atomicity", () => {
	const harnesses: Harness[] = [];
	const managers: SessionManager[] = [];
	const storeLeases: SQLiteSessionStoreLease[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
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

	async function setup(): Promise<{ harness: Harness; sessionRef: SessionReference; baseline: PlanningSnapshot }> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-212-"));
		tempDirs.push(tempDir);
		const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		await createReadyPlan(harness);
		return {
			harness,
			sessionRef: sessionManager.getSessionRef()!,
			baseline: snapshotHarness(harness),
		};
	}

	async function expectRetainedFailure(
		harness: Harness,
		sessionRef: SessionReference,
		baseline: PlanningSnapshot,
		clientMessageId: string,
	): Promise<void> {
		await harness.session.steer("revise this ready plan", undefined, clientMessageId);
		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(await snapshotReopened(sessionRef)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.clearQueue();
	}

	it.each(["planning", "checkpoint", "canonical user"] as const)(
		"rolls back every staged entry when the %s append fails",
		async (stage) => {
			const { harness, sessionRef, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			if (stage === "planning") {
				const original = harness.sessionManager.appendPlanningState.bind(harness.sessionManager);
				vi.spyOn(harness.sessionManager, "appendPlanningState").mockImplementation((planning) => {
					if (planning.plan?.phase === "draft") throw new Error("injected planning append failure");
					return original(planning);
				});
			} else if (stage === "checkpoint") {
				const original = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
				vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementation(
					(customType, content, display, details) => {
						if (customType === "volt-plan-checkpoint") throw new Error("injected checkpoint append failure");
						return original(customType, content, display, details);
					},
				);
			} else {
				const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
				vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
					if (message.role === "user") throw new Error("injected canonical user append failure");
					return original(message);
				});
			}

			await expectRetainedFailure(harness, sessionRef, baseline, `issue-212-${stage.replace(" ", "-")}`);
		},
	);

	it("keeps the ready plan when the SQLite transaction rolls back", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		storeLeases.push(await faultNextTransaction(harness.sessionManager, "before"));

		await expectRetainedFailure(harness, sessionRef, baseline, "issue-212-first-durability");
	});

	it("atomically commits after reopening the SQLite-backed session", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harnesses.pop();
		harness.session.dispose();
		await harness.session.waitForClosed();
		await harness.cleanupAsync();

		const resumed = await createHarness({ sessionManager: await SessionManager.open(sessionRef) });
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("feedback applied")]);
		await resumed.session.prompt("revise this ready plan");

		expect(snapshotHarness(resumed)).toEqual({
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["revise this ready plan"],
		});
		expect(await snapshotReopened(sessionRef)).toEqual(snapshotHarness(resumed));
		expect(resumed.getPendingResponseCount()).toBe(0);
	});

	it("does not overwrite a newer revision committed by another manager", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-212-stale-preimage";
		await harness.session.steer("revise this ready plan", undefined, clientMessageId);
		await harness.sessionManager.flush();
		const otherManager = await SessionManager.open(sessionRef);
		managers.push(otherManager);
		otherManager.appendFastModeChange(true);
		await otherManager.flush();
		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

		expect(harness.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		expect(harness.getPendingResponseCount()).toBe(1);
		const reopened = await SessionManager.open(sessionRef);
		managers.push(reopened);
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(reopened.getEntries().filter((entry) => entry.type === "fast_mode_change" && entry.enabled)).toHaveLength(
			1,
		);
		harnesses.pop();
		harness.session.dispose();
		await harness.session.waitForClosed().catch(() => {});
		await harness.cleanupAsync().catch(() => {});
	});

	it("assigns one ready-plan transition across a mixed prompt and steer batch", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("both applied")]);
		await harness.session.steer("queued steer", undefined, "issue-212-mixed-steer");
		await harness.session.prompt("pending prompt", {
			clientMessageId: "issue-212-mixed-prompt",
			source: "rpc",
		});

		const live = snapshotHarness(harness);
		expect(live).toEqual({
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["queued steer", "pending prompt"],
		});
		expect(await snapshotReopened(sessionRef)).toEqual(live);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("fences session replacement while atomic durability is pending", async () => {
		const { harness } = await setup();
		harness.setResponses([fauxAssistantMessage("feedback applied")]);
		const started = deferred();
		const release = deferred();
		storeLeases.push(
			await faultNextTransaction(harness.sessionManager, "pause", {
				started: started.resolve,
				release: release.promise,
			}),
		);

		await harness.session.steer("revise this ready plan", undefined, "issue-212-session-replacement");
		const attempt = harness.control.continue();
		await started.promise;
		expect(() => harness.sessionManager.newSession()).toThrow("Cannot create a new session during an atomic append");
		await expect(harness.sessionManager.createBranchedSession(harness.sessionManager.getLeafId()!)).rejects.toThrow(
			"Cannot create a branched session during an atomic append",
		);
		release.resolve();
		await expect(attempt).resolves.toMatchObject({ status: "completed" });
	});

	it("publishes planning before transcript observers and fences nested writes", async () => {
		const { harness } = await setup();
		harness.setResponses([fauxAssistantMessage("feedback applied")]);
		const observedPhases: Array<string | undefined> = [];
		const nestedWrites: string[] = [];
		const unsubscribe = harness.sessionManager.subscribeEntries((entry) => {
			if (
				(entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint") ||
				(entry.type === "message" && entry.message.role === "user")
			) {
				observedPhases.push(harness.session.planningState.plan?.phase);
				try {
					harness.sessionManager.appendFastModeChange(true);
					nestedWrites.push("accepted");
				} catch {
					nestedWrites.push("rejected");
				}
			}
		});

		await harness.session.steer("revise this ready plan", undefined, "issue-212-observer-order");
		await harness.control.continue();
		unsubscribe();

		expect(observedPhases).toEqual(["draft", "draft"]);
		expect(nestedWrites).toEqual(["rejected", "rejected"]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "fast_mode_change")).toHaveLength(0);
	});

	it("retains an identified direct prompt after a proven pre-replacement failure", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		storeLeases.push(await faultNextTransaction(harness.sessionManager, "before"));
		const clientMessageId = "issue-212-direct-pre-replacement";

		await expect(
			harness.session.prompt("revise this ready plan", {
				clientMessageId,
				source: "rpc",
			}),
		).rejects.toThrow("SQLite session transaction was rolled back");
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(await snapshotReopened(sessionRef)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.clearQueue();
	});
});
