import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import type * as DurableAtomicWriteModule from "../../../src/utils/durable-atomic-write.ts";

const atomicWriteFault = vi.hoisted(() => ({
	stages: [] as Array<"before" | "after" | "pause">,
	pause: undefined as { started(): void; release: Promise<void> } | undefined,
}));

vi.mock("../../../src/utils/durable-atomic-write.ts", async (importOriginal) => {
	const original = await importOriginal<typeof DurableAtomicWriteModule>();
	return {
		...original,
		writeDurableAtomicFile: async (...args: Parameters<typeof original.writeDurableAtomicFile>) => {
			const stage = atomicWriteFault.stages.shift();
			if (stage === "before") throw new Error("injected pre-replacement durability failure");
			if (stage === "pause") {
				atomicWriteFault.pause?.started();
				await atomicWriteFault.pause?.release;
				atomicWriteFault.pause = undefined;
			}
			await original.writeDurableAtomicFile(...args);
			if (stage === "after") throw new Error("injected post-replacement durability failure");
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

function snapshotReopened(sessionFile: string): PlanningSnapshot {
	return snapshotEntries(SessionManager.open(sessionFile).getBranch());
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
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()!.session.dispose();
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	async function setup(): Promise<{ harness: Harness; sessionFile: string; baseline: PlanningSnapshot }> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-212-"));
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

	async function expectRetainedFailure(
		harness: Harness,
		sessionFile: string,
		baseline: PlanningSnapshot,
		clientMessageId: string,
	): Promise<void> {
		await harness.session.steer("revise this ready plan", undefined, clientMessageId);
		await expect(harness.session.agent.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(snapshotReopened(sessionFile)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.clearQueue();
	}

	it.each(["planning", "checkpoint", "canonical user"] as const)(
		"rolls back every staged entry when the %s append fails",
		async (stage) => {
			const { harness, sessionFile, baseline } = await setup();
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

			await expectRetainedFailure(harness, sessionFile, baseline, `issue-212-${stage.replace(" ", "-")}`);
		},
	);

	it("keeps the ready plan when atomic durability fails before replacement", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		atomicWriteFault.stages = ["before"];

		await expectRetainedFailure(harness, sessionFile, baseline, "issue-212-first-durability");
	});

	it("atomically commits a resumed session missing its final newline", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harnesses.pop();
		await harness.session.dispose();
		harness.cleanup();
		const persisted = readFileSync(sessionFile, "utf8");
		writeFileSync(sessionFile, persisted.trimEnd(), "utf8");

		const resumed = await createHarness({ sessionManager: SessionManager.open(sessionFile) });
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("feedback applied")]);
		await resumed.session.prompt("revise this ready plan");

		expect(snapshotHarness(resumed)).toEqual({
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["revise this ready plan"],
		});
		expect(snapshotReopened(sessionFile)).toEqual(snapshotHarness(resumed));
		expect(resumed.getPendingResponseCount()).toBe(0);
	});

	it("does not overwrite a same-file commit from another manager", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const otherManager = SessionManager.open(sessionFile);
		otherManager.appendFastModeChange(true);
		await otherManager.flush();

		await expectRetainedFailure(harness, sessionFile, baseline, "issue-212-stale-preimage");
		expect(
			SessionManager.open(sessionFile)
				.getEntries()
				.filter((entry) => entry.type === "fast_mode_change" && entry.enabled),
		).toHaveLength(1);
	});

	it("assigns one ready-plan transition across a mixed prompt and steer batch", async () => {
		const { harness, sessionFile, baseline } = await setup();
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
		expect(snapshotReopened(sessionFile)).toEqual(live);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("fences session replacement while atomic durability is pending", async () => {
		const { harness, sessionFile } = await setup();
		harness.setResponses([fauxAssistantMessage("feedback applied")]);
		const started = deferred();
		const release = deferred();
		atomicWriteFault.stages = ["pause"];
		atomicWriteFault.pause = { started: started.resolve, release: release.promise };

		await harness.session.steer("revise this ready plan", undefined, "issue-212-session-replacement");
		const attempt = harness.session.agent.continue();
		await started.promise;
		expect(() => harness.sessionManager.setSessionFile(sessionFile)).toThrow(
			"Cannot switch session files during an atomic append",
		);
		expect(() => harness.sessionManager.newSession()).toThrow("Cannot create a new session during an atomic append");
		expect(() => harness.sessionManager.createBranchedSession(harness.sessionManager.getLeafId()!)).toThrow(
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
		await harness.session.agent.continue();
		unsubscribe();

		expect(observedPhases).toEqual(["draft", "draft"]);
		expect(nestedWrites).toEqual(["rejected", "rejected"]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "fast_mode_change")).toHaveLength(0);
	});

	it("retains an identified direct prompt after a proven pre-replacement failure", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		atomicWriteFault.stages = ["before"];
		const clientMessageId = "issue-212-direct-pre-replacement";

		await expect(
			harness.session.prompt("revise this ready plan", {
				clientMessageId,
				source: "rpc",
			}),
		).rejects.toThrow("Atomic append was rolled back");
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(snapshotReopened(sessionFile)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.clearQueue();
	});

	it("terminally fails without publication when candidate rollback is uncertain", async () => {
		const { harness, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		atomicWriteFault.stages = ["after", "before"];

		await harness.session.steer("revise this ready plan");
		await expect(harness.session.agent.continue()).rejects.toThrow(
			"Session persistence is fail-stopped after an uncertain write",
		);
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);

		harnesses.pop();
		await expect(harness.session.dispose()).rejects.toThrow("Atomic append rollback failed");
		harness.cleanup();
	});

	it("restores the preimage when final durability fails after replacement", async () => {
		const { harness, sessionFile, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		atomicWriteFault.stages = ["after"];

		await expectRetainedFailure(harness, sessionFile, baseline, "issue-212-final-durability");
	});
});
