import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import {
	SessionConversationStateUnavailableError,
	type SessionEntry,
	SessionManager,
} from "../../../src/core/session-manager.ts";
import type * as DurableAtomicWriteModule from "../../../src/utils/durable-atomic-write.ts";

const atomicWriteFault = vi.hoisted(() => ({
	writeStages: [] as Array<"before" | "after">,
	syncStages: [] as Array<"pause" | "fail">,
	pause: undefined as { started(): void; release: Promise<void> } | undefined,
	capturePreimage: undefined as ((path: string) => void) | undefined,
	beforeSyncFailure: undefined as ((path: string) => void) | undefined,
}));

vi.mock("../../../src/utils/durable-atomic-write.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DurableAtomicWriteModule>();
	return {
		...original,
		writeDurableAtomicFile: async (...args: Parameters<typeof original.writeDurableAtomicFile>) => {
			const stage = atomicWriteFault.writeStages.shift();
			if (stage === "before") throw new Error("injected pre-replacement durability failure");
			if (stage === "after") atomicWriteFault.capturePreimage?.(args[0]);
			await original.writeDurableAtomicFile(...args);
			if (stage === "after") throw new Error("injected post-replacement durability failure");
		},
		syncDurableFile: async (...args: Parameters<typeof original.syncDurableFile>) => {
			const stage = atomicWriteFault.syncStages.shift();
			if (stage === "pause") {
				atomicWriteFault.pause?.started();
				await atomicWriteFault.pause?.release;
				atomicWriteFault.pause = undefined;
			}
			if (stage === "fail") {
				atomicWriteFault.beforeSyncFailure?.(args[0]);
				throw new Error("injected roll-forward fsync failure");
			}
			await original.syncDurableFile(...args);
		},
	};
});

import { createHarness, getMessageText, type Harness } from "../harness.ts";

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

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = harness.session.updatePlan({
		title: "Atomic append reconciliation",
		summary: "Reconcile visible candidates without restoring stale projections.",
		steps: [{ text: "Prove the candidate before publication" }],
	});
	harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
	await harness.sessionManager.flush();
}

describe("regression #217: uncertain atomic append reconciliation", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		atomicWriteFault.writeStages = [];
		atomicWriteFault.syncStages = [];
		atomicWriteFault.pause = undefined;
		atomicWriteFault.capturePreimage = undefined;
		atomicWriteFault.beforeSyncFailure = undefined;
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose().catch(() => {});
			harness.faux.unregister();
			rmSync(harness.tempDir, { recursive: true, force: true });
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	async function setup(): Promise<{
		harness: Harness;
		sessionFile: string;
		baseline: PlanningSnapshot;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		await createReadyPlan(harness);
		return {
			harness,
			sessionFile: sessionManager.getSessionFile()!,
			baseline: snapshotHarness(harness),
		};
	}

	it("retains an originally missing preimage after a proven pre-replacement failure", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-missing-"));
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const sessionFile = manager.getSessionFile()!;
		let published = false;
		atomicWriteFault.writeStages = ["before"];

		await expect(
			manager.appendAtomically(
				() => manager.appendPlanningState({ mode: "build", plan: null }),
				() => {
					published = true;
				},
			),
		).rejects.toMatchObject({ effect: "rolled_back" });

		expect(existsSync(sessionFile)).toBe(false);
		expect(manager.getEntries()).toEqual([]);
		expect(published).toBe(false);
	});

	it("retains the exact preimage after a proven pre-replacement failure", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		await harness.session.steer("retain this feedback", undefined, "issue-217-retained-preimage");
		atomicWriteFault.writeStages = ["before"];

		await expect(harness.session.agent.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});

		expect(snapshotHarness(harness)).toEqual(baseline);
		const reopened = SessionManager.open(sessionFile);
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(harness.sessionManager.getClientInput("issue-217-retained-preimage")).toMatchObject({
			state: "accepted",
		});
		expect(reopened.getClientInput("issue-217-retained-preimage")).toMatchObject({ state: "accepted" });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("rolls a visible candidate forward into matching live and reopened state", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("candidate committed")]);
		atomicWriteFault.writeStages = ["after"];
		const preflight: PromptPreflightResult[] = [];
		const clientMessageId = "issue-217-visible-candidate";

		await harness.session.prompt("roll this candidate forward", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});

		const expected = {
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["roll this candidate forward"],
		};
		expect(snapshotHarness(harness)).toEqual(expected);
		const reopened = SessionManager.open(sessionFile);
		expect(snapshotEntries(reopened.getBranch())).toEqual(expected);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(preflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("gates planning, delivery, direct RPC acceptance, and provider work on roll-forward proof", async () => {
		const { harness, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("proof completed")]);
		const proofStarted = deferred();
		const releaseProof = deferred();
		atomicWriteFault.writeStages = ["after"];
		atomicWriteFault.syncStages = ["pause"];
		atomicWriteFault.pause = { started: proofStarted.resolve, release: releaseProof.promise };
		const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
		const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
		const preflight: PromptPreflightResult[] = [];

		const prompting = harness.session.prompt("wait for durability proof", {
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

		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore + 1);
		expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore + 1);
		expect(preflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["candidate", "preimage"] as const)(
		"makes live projections unavailable when proof fails while the reopened %s remains authoritative",
		async (authoritativeFile) => {
			const { harness, sessionFile, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const clientMessageId = `issue-217-unavailable-${authoritativeFile}`;
			await harness.session.steer("unproven feedback", undefined, clientMessageId);
			const stableSessionId = harness.session.sessionId;
			const stableSessionFile = harness.session.sessionFile;
			let preimage = "";
			atomicWriteFault.capturePreimage = (path) => {
				preimage = existsSync(path) ? readFileSync(path, "utf8") : "";
			};
			atomicWriteFault.beforeSyncFailure = (path) => {
				if (authoritativeFile === "preimage") writeFileSync(path, preimage, "utf8");
			};
			atomicWriteFault.writeStages = ["after"];
			atomicWriteFault.syncStages = ["fail"];
			const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
			const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;

			await expect(harness.session.agent.continue()).resolves.toMatchObject({
				status: "delivery_failed",
				failure: { outcome: "terminally_failed", phase: "settlement" },
			});

			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.sessionId).toBe(stableSessionId);
			expect(harness.session.sessionFile).toBe(stableSessionFile);
			expect(() => harness.sessionManager.getEntries()).toThrow(SessionConversationStateUnavailableError);
			expect(() => harness.sessionManager.getClientInput(clientMessageId)).toThrow(
				SessionConversationStateUnavailableError,
			);
			expect(() => harness.session.messages).toThrow(SessionConversationStateUnavailableError);
			expect(() => harness.session.planningState).toThrow(SessionConversationStateUnavailableError);
			expect(() => harness.session.state).toThrow(SessionConversationStateUnavailableError);
			await expect(harness.sessionManager.flush()).rejects.toThrow("Atomic append durability is uncertain");

			const reopened = SessionManager.open(sessionFile);
			if (authoritativeFile === "candidate") {
				expect(snapshotEntries(reopened.getBranch())).toEqual({
					phase: "draft",
					checkpoints: baseline.checkpoints + 1,
					userTexts: ["unproven feedback"],
				});
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			} else {
				expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
			}
		},
	);
});
