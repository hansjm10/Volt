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
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import type * as DurableAtomicWriteModule from "../../../src/utils/durable-atomic-write.ts";

const atomicWriteFault = vi.hoisted(() => ({
	writeStages: [] as Array<"before" | "after">,
	syncStages: [] as Array<"pause" | "fail">,
	pause: undefined as { started(): void; release: Promise<void> } | undefined,
	capturePreimage: undefined as ((path: string) => void) | undefined,
	captureCandidate: undefined as ((path: string) => void) | undefined,
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
			if (stage === "after") {
				atomicWriteFault.captureCandidate?.(args[0]);
				throw new Error("injected post-replacement durability failure");
			}
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

import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "../harness.ts";

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
		atomicWriteFault.captureCandidate = undefined;
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

	async function setup(options: HarnessOptions = {}): Promise<{
		harness: Harness;
		sessionFile: string;
		baseline: PlanningSnapshot;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const harness = await createHarness({ ...options, sessionManager });
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
		const exactPreimage = readFileSync(sessionFile, "utf8");
		atomicWriteFault.writeStages = ["before"];

		await expect(harness.session.agent.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});

		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(readFileSync(sessionFile, "utf8")).toBe(exactPreimage);
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
		const exactPreimage = readFileSync(sessionFile, "utf8");
		let exactCandidate = "";
		atomicWriteFault.captureCandidate = (path) => {
			exactCandidate = readFileSync(path, "utf8");
		};
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
		expect(exactCandidate).not.toBe(exactPreimage);
		expect(readFileSync(sessionFile, "utf8")).toBe(exactCandidate);
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

	it("rejects conversation work before extension, MCP, bash, provider, queue, or planning side effects while cleanup remains available", async () => {
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
		let preimage = "";
		atomicWriteFault.capturePreimage = (path) => {
			preimage = readFileSync(path, "utf8");
		};
		atomicWriteFault.beforeSyncFailure = (path) => {
			writeFileSync(path, preimage, "utf8");
		};
		atomicWriteFault.writeStages = ["after"];
		atomicWriteFault.syncStages = ["fail"];

		await expect(harness.session.agent.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

		const authority = harness.sessionManager.getConversationAuthorityStatus();
		expect(authority.status).toBe("reconciliation_required");
		const agentPrompt = vi.spyOn(harness.session.agent, "prompt");
		const agentSteer = vi.spyOn(harness.session.agent, "steer");
		const agentFollowUp = vi.spyOn(harness.session.agent, "followUp");
		const bashOperations: BashOperations = {
			exec: vi.fn(async () => ({ exitCode: 0 })),
		};
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
			harness.session.sendCustomMessage({ customType: "issue-217", content: "must not append", display: true }),
		).rejects.toBeInstanceOf(SessionConversationStateUnavailableError);
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
		expect(() => harness.session.getMcpManager()).toThrow(SessionConversationStateUnavailableError);
		expect(() => harness.session.resumeRecoveredClientInputs()).toThrow(SessionConversationStateUnavailableError);

		expect(preflight).toEqual([]);
		expect(inputHookCalls).toBe(0);
		expect(mcpStart).not.toHaveBeenCalled();
		expect(bashOperations.exec).not.toHaveBeenCalled();
		expect(agentPrompt).not.toHaveBeenCalled();
		expect(agentSteer).not.toHaveBeenCalled();
		expect(agentFollowUp).not.toHaveBeenCalled();
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
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		await expect(harness.session.dispose()).rejects.toThrow("Atomic append durability is uncertain");
		expect(mcpDispose).toHaveBeenCalledOnce();
	});

	it.each(["candidate", "preimage"] as const)(
		"terminally consumes the failed runtime delivery while a fresh manager follows the authoritative %s",
		async (authoritativeFile) => {
			const { harness, sessionFile, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const clientMessageId = `issue-217-unavailable-${authoritativeFile}`;
			const laterClientMessageId = `issue-217-later-${authoritativeFile}`;
			await harness.session.steer("unproven feedback", undefined, clientMessageId);
			await harness.session.followUp("later queued feedback", undefined, laterClientMessageId);
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
			const messageStartEventsBefore = harness.eventsOfType("message_start").length;
			const messageEndEventsBefore = harness.eventsOfType("message_end").length;

			await expect(harness.session.agent.continue()).resolves.toMatchObject({
				status: "delivery_failed",
				failure: { outcome: "terminally_failed", phase: "settlement" },
			});

			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(harness.eventsOfType("message_start")).toHaveLength(messageStartEventsBefore);
			expect(harness.eventsOfType("message_end")).toHaveLength(messageEndEventsBefore);
			expect(harness.getPendingResponseCount()).toBe(1);
			const authorityStatus = harness.sessionManager.getConversationAuthorityStatus();
			expect(authorityStatus.status).toBe("reconciliation_required");
			if (authorityStatus.status !== "reconciliation_required") {
				throw new Error("Expected reconciliation-required conversation authority");
			}
			expect(authorityStatus.error.cause).toMatchObject({
				message: "Atomic append durability is uncertain",
				cause: { message: "injected roll-forward fsync failure" },
			});
			expect(() => harness.sessionManager.appendPlanningState({ mode: "build", plan: null })).toThrow(
				authorityStatus.error,
			);
			expect(harness.sessionManager.getConversationAuthorityStatus()).toBe(authorityStatus);
			expect(harness.session.sessionId).toBe(stableSessionId);
			expect(harness.session.sessionFile).toBe(stableSessionFile);
			const unavailableProjections = [
				() => harness.sessionManager.getEntries(),
				() => harness.sessionManager.getBranch(),
				() => harness.sessionManager.getBranchWindow({ maxEntries: 1 }),
				() => harness.sessionManager.getTree(),
				() => harness.sessionManager.getHeader(),
				() => harness.sessionManager.getLeafId(),
				() => harness.sessionManager.getLeafEntry(),
				() => harness.sessionManager.getEntry("missing"),
				() => harness.sessionManager.getClientInput(clientMessageId),
				() => harness.sessionManager.getClientInputRecoveryPlan(),
				() => harness.sessionManager.getRecoverableQueuedClientInputs(),
				() => harness.sessionManager.getSubagentSpawnEntries(),
				() => harness.sessionManager.getSessionName(),
				() => harness.sessionManager.buildSessionContext(),
				() => harness.session.messages,
				() => harness.session.planningState,
				() => harness.session.state,
			];
			for (const readProjection of unavailableProjections) {
				expect(readProjection).toThrow(SessionConversationStateUnavailableError);
			}
			expect(() => harness.sessionManager.subscribeEntries(() => {})).toThrow(
				SessionConversationStateUnavailableError,
			);
			expect(() => harness.sessionManager.setSessionFile(sessionFile)).toThrow(
				SessionConversationStateUnavailableError,
			);
			expect(harness.sessionManager.getSessionId()).toBe(stableSessionId);
			expect(harness.sessionManager.getSessionFile()).toBe(stableSessionFile);
			expect(harness.sessionManager.getCwd()).toBeTruthy();
			expect(harness.sessionManager.getSessionDir()).toBeTruthy();
			expect(harness.sessionManager.isPersisted()).toBe(true);
			await expect(harness.sessionManager.flush()).rejects.toThrow("Atomic append durability is uncertain");

			expect(harness.session.agent.hasPendingPrompt()).toBe(false);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			const reopened = SessionManager.open(sessionFile);
			const replacement = await createHarness({ sessionManager: reopened });
			harnesses.push(replacement);
			if (authoritativeFile === "candidate") {
				replacement.setResponses([fauxAssistantMessage("fresh recovery later")]);
				expect(snapshotEntries(reopened.getBranch())).toEqual({
					phase: "draft",
					checkpoints: baseline.checkpoints + 1,
					userTexts: ["unproven feedback"],
				});
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
				expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "accepted" });
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
				expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "accepted" });
				expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId }, { clientMessageId: laterClientMessageId }],
				});
			}
			await replacement.session.resumeRecoveredClientInputs();
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "completed" });
			expect(snapshotEntries(reopened.getBranch()).userTexts).toEqual([
				"unproven feedback",
				"later queued feedback",
			]);
			const expectedLiveUserTexts =
				authoritativeFile === "candidate"
					? ["later queued feedback"]
					: ["unproven feedback", "later queued feedback"];
			expect(getUserTexts(replacement)).toEqual(expectedLiveUserTexts);
			const expectedAssistantTexts =
				authoritativeFile === "candidate"
					? ["fresh recovery later"]
					: ["fresh recovery first", "fresh recovery later"];
			expect(getAssistantTexts(replacement)).toEqual(expectedAssistantTexts);
			expect(replacement.getPendingResponseCount()).toBe(0);
			await replacement.session.resumeRecoveredClientInputs();
			expect(getUserTexts(replacement)).toEqual(expectedLiveUserTexts);
			expect(getAssistantTexts(replacement)).toEqual(expectedAssistantTexts);
		},
	);
});
