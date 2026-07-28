import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPlanExecutionPrompt,
	PLAN_MAX_SERIALIZED_BYTES,
	parsePlanningState,
	StalePlanRevisionError,
} from "../src/core/planning.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("native planning state", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-planning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createPlanningSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			agentMode: "plan",
			customTools: [
				{
					name: "mutate_everything",
					label: "Mutate everything",
					description: "Test mutation tool",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text" as const, text: "mutated" }],
						details: {},
					}),
				},
			],
		});
	}

	it("keeps Plan tools read-only and restores the exact requested Build set", async () => {
		const { session } = await createPlanningSession();
		const planTools = session.getActiveToolNames();
		expect(await session.agent.transformContext?.([])).toEqual([]);
		expect(planTools).toEqual([
			"read",
			"web_search",
			"web_fetch",
			"grep",
			"find",
			"ls",
			"lsp",
			"update_plan",
			"submit_plan",
		]);
		expect(planTools).not.toContain("bash");
		expect(planTools).not.toContain("mutate_everything");

		const submitBeforeResearch = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "submit-early", name: "submit_plan", arguments: {} },
			args: {},
		} as never);
		expect(submitBeforeResearch).toMatchObject({ block: true });

		const readOnlyLspCall = {
			type: "toolCall" as const,
			id: "lsp-read",
			name: "lsp",
			arguments: { action: "diagnostics" },
		};
		const readOnlyLsp = await session.agent.beforeToolCall?.({
			toolCall: readOnlyLspCall,
			args: { action: "diagnostics" },
		} as never);
		expect(readOnlyLsp).toBeUndefined();
		await session.agent.afterToolCall?.({
			toolCall: readOnlyLspCall,
			args: { action: "diagnostics" },
			result: { content: [{ type: "text", text: "No diagnostics" }] },
			isError: false,
		} as never);
		const submitAfterResearch = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "submit-after-read", name: "submit_plan", arguments: {} },
			args: {},
		} as never);
		expect(submitAfterResearch).toBeUndefined();

		const mutatingLsp = await session.agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id: "lsp-fix", name: "lsp", arguments: { action: "fix" } },
			args: { action: "fix" },
		} as never);
		expect(mutatingLsp).toMatchObject({ block: true });

		session.setAgentMode("build");
		const buildTools = session.getActiveToolNames();
		expect(buildTools).toContain("mutate_everything");
		expect(buildTools).not.toContain("update_plan");
		expect(buildTools).not.toContain("submit_plan");

		session.setAgentMode("plan");
		expect(session.getActiveToolNames()).toEqual(planTools);
		session.dispose();
	});

	it("freezes approved scope, tracks progress separately, and requires reapproval for replanning", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
			steps: [{ text: "Inspect the architecture" }, { text: "Implement the workflow" }],
		});
		expect(draft.revision).toBe(1);
		expect(draft.steps.every((step) => step.id.length > 0 && step.status === "pending")).toBe(true);
		const draftPolicy = session.state.systemPrompt;
		expect(draftPolicy).toContain("[VOLT PLAN MODE — TRUSTED HOST POLICY]");
		expect(draftPolicy).not.toContain(draft.id);
		expect(draftPolicy).not.toContain("Revision:");
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: draft.revision,
				title: draft.title,
				summary: draft.summary,
				steps: draft.steps.map((step) => ({ id: step.id, text: step.text })),
			}),
		).toThrow("made no changes");
		expect(() =>
			session.submitPlan({
				planId: draft.id,
				expectedRevision: 0,
				title: "Implement native planning",
				summary: "Wire the shared state through every surface.",
			}),
		).toThrow(StalePlanRevisionError);

		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
		});
		expect(ready.phase).toBe("ready");
		expect(ready.revision).toBe(2);
		expect(session.state.systemPrompt).toBe(draftPolicy);

		session.setAgentMode("build");
		expect(session.planningState.plan).toMatchObject({ id: draft.id, phase: "ready" });
		session.setAgentMode("plan");
		const changed = session.changePlan(draft.id, ready.revision);
		expect(changed).toMatchObject({ mode: "plan", plan: { phase: "draft", revision: 3 } });

		const readyAgain = session.submitPlan({
			planId: draft.id,
			expectedRevision: 3,
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
		});
		const execution = {
			id: "execution-1",
			approvedRevision: readyAgain.revision,
			strategy: "retain_context" as const,
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		};
		const activated = session.activatePlan(draft.id, readyAgain.revision, execution);
		expect(activated).toMatchObject({
			activated: true,
			planning: { mode: "build", plan: { phase: "active" } },
		});
		expect(session.getActiveToolNames()).toContain("update_plan_progress");
		expect(session.getActiveToolNames()).toContain("request_replan");
		expect(session.getActiveToolNames()).not.toContain("update_plan");
		expect(session.getActiveToolNames()).not.toContain("submit_plan");
		expect(() =>
			session.updatePlan({
				planId: draft.id,
				expectedRevision: activated.planning.plan!.revision,
				steps: [{ text: "Replace the approved scope" }],
			}),
		).toThrow("only in Plan mode");

		const active = session.planningState.plan!;
		const executionPolicy = session.state.systemPrompt;
		const executionTools = session.getActiveToolNames();
		expect(executionPolicy).toContain("[VOLT APPROVED PLAN — TRUSTED HOST POLICY]");
		expect(executionPolicy).not.toContain(active.id);
		expect(executionPolicy).not.toContain("Revision:");
		const progressTool = session.state.tools.find((tool) => tool.name === "update_plan_progress")!;
		const progressResult = await progressTool.execute("progress-1", {
			planId: active.id,
			expectedRevision: active.revision,
			updates: [{ id: active.steps[0]!.id, status: "completed", note: "Architecture inspected" }],
		});
		const progressText = progressResult.content.find((content) => content.type === "text")?.text ?? "";
		expect(progressText).toContain(`"planId":"${active.id}"`);
		expect(progressText).not.toContain(active.summary!);
		expect(progressText).not.toContain("execution");
		const progressed = session.planningState.plan!;
		expect(progressed.steps.map((step) => ({ id: step.id, text: step.text }))).toEqual(
			active.steps.map((step) => ({ id: step.id, text: step.text })),
		);
		expect(progressed.steps[0]).toMatchObject({ status: "completed", note: "Architecture inspected" });
		expect(session.state.systemPrompt).toBe(executionPolicy);
		expect(session.getActiveToolNames()).toEqual(executionTools);
		expect(() =>
			session.updatePlanProgress({
				planId: progressed.id,
				expectedRevision: progressed.revision,
				updates: [{ id: "unknown", status: "completed" }],
			}),
		).toThrow("unknown step id");

		const replanning = session.requestReplan({
			planId: progressed.id,
			expectedRevision: progressed.revision,
			reason: "Implementation revealed a required verification step",
		});
		expect(replanning).toMatchObject({
			mode: "plan",
			plan: { phase: "draft", revision: progressed.revision + 1 },
		});
		expect(replanning.plan?.execution).toBeUndefined();
		expect(() => parsePlanningState(replanning)).not.toThrow();

		const revised = session.updatePlan({
			planId: replanning.plan!.id,
			expectedRevision: replanning.plan!.revision,
			title: replanning.plan!.title,
			summary: replanning.plan!.summary,
			steps: [
				...replanning.plan!.steps.map((step) => ({ id: step.id, text: step.text })),
				{ text: "Verify the coordinated surfaces" },
			],
		});
		expect(revised.steps[0]).toMatchObject({ status: "completed", note: "Architecture inspected" });
		expect(revised.steps.at(-1)).toMatchObject({ status: "pending" });

		const revisedReady = session.submitPlan({
			planId: revised.id,
			expectedRevision: revised.revision,
			title: revised.title!,
			summary: revised.summary!,
		});
		const reactivated = session.activatePlan(revised.id, revisedReady.revision, {
			...execution,
			id: "execution-2",
			approvedRevision: revisedReady.revision,
		});
		const reactivatedPlan = reactivated.planning.plan!;
		const executionCheckpoint = createPlanExecutionPrompt(reactivatedPlan);
		expect(executionCheckpoint).toContain("[x] Inspect the architecture — Architecture inspected");
		expect(executionCheckpoint).toContain(`Revision: ${reactivatedPlan.revision}`);
		const completed = session.updatePlanProgress({
			planId: reactivatedPlan.id,
			expectedRevision: reactivatedPlan.revision,
			updates: reactivatedPlan.steps
				.filter((step) => step.status !== "completed")
				.map((step) => ({ id: step.id, status: "completed" as const })),
		});
		expect(completed.phase).toBe("completed");
		expect(session.getActiveToolNames()).not.toContain("update_plan_progress");
		expect(session.getActiveToolNames()).not.toContain("request_replan");
		await session.dispose();
	});

	it("turns manual Plan-mode re-entry during execution into a valid draft", async () => {
		const { session } = await createPlanningSession();
		session.setAgentMode("plan");
		const draft = session.updatePlan({ steps: [{ text: "Implement the approved change" }] });
		const ready = session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Approved change",
			summary: "Implement and verify the approved change.",
		});
		session.activatePlan(ready.id, ready.revision, {
			id: "execution-manual-replan",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		});

		const replanning = session.setAgentMode("plan");
		expect(replanning).toMatchObject({ mode: "plan", plan: { phase: "draft" } });
		expect(replanning.plan?.execution).toBeUndefined();
		expect(() => parsePlanningState(replanning)).not.toThrow();
		const checkpoints = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining(`Revision: ${replanning.plan!.revision}`),
			display: false,
		});
		expect(session.getActiveToolNames()).toContain("update_plan");
		expect(session.getActiveToolNames()).not.toContain("update_plan_progress");
		await session.dispose();
	});

	it("restores a missing canonical plan checkpoint once", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		sessionManager.appendMessage({ role: "user", content: "Continue the active plan", timestamp: 1 });
		sessionManager.appendPlanningState({
			mode: "build",
			plan: {
				id: "restored-plan",
				revision: 7,
				phase: "active",
				title: "Restored plan",
				summary: "Resume from durable state.",
				steps: [{ id: "restored-step", text: "Finish the implementation", status: "in_progress", note: "Started" }],
				execution: {
					id: "restored-execution",
					approvedRevision: 6,
					strategy: "retain_context",
					sourceSessionId: sessionManager.getSessionId(),
					targetSessionId: sessionManager.getSessionId(),
				},
			},
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		const checkpoints = session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining("Revision: 7"),
			display: false,
		});
		expect(session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
			content: expect.stringContaining("[>] Finish the implementation — Started"),
		});
		expect(session.state.systemPrompt).not.toContain("restored-plan");
		await session.dispose();
	});

	it("rejects too many steps and oversized semantic state", () => {
		expect(() =>
			parsePlanningState({
				mode: "plan",
				plan: {
					id: "plan",
					revision: 1,
					phase: "draft",
					steps: Array.from({ length: 65 }, (_, index) => ({
						id: `step-${index}`,
						text: `Step ${index}`,
						status: "pending",
					})),
				},
			}),
		).toThrow("at most 64 steps");

		expect(() =>
			parsePlanningState({
				mode: "plan",
				plan: {
					id: "plan",
					revision: 1,
					phase: "draft",
					summary: "x".repeat(PLAN_MAX_SERIALIZED_BYTES),
					steps: [],
				},
			}),
		).toThrow("byte limit");
	});
});
