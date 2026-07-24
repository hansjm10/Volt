import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_MAX_SERIALIZED_BYTES, parsePlanningState, StalePlanRevisionError } from "../src/core/planning.ts";
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
		expect(planTools).toEqual([
			"read",
			"web_search",
			"web_fetch",
			"grep",
			"find",
			"ls",
			"update_plan",
			"submit_plan",
		]);
		expect(planTools).not.toContain("bash");
		expect(planTools).not.toContain("mutate_everything");

		session.setAgentMode("build");
		const buildTools = session.getActiveToolNames();
		expect(buildTools).toContain("mutate_everything");
		expect(buildTools).not.toContain("update_plan");
		expect(buildTools).not.toContain("submit_plan");

		session.setAgentMode("plan");
		expect(session.getActiveToolNames()).toEqual(planTools);
		session.dispose();
	});

	it("fences revisions, preserves drafts, and permits active checklist changes", async () => {
		const { session } = await createPlanningSession();
		const draft = session.updatePlan({
			title: "Implement native planning",
			summary: "Wire the shared state through every surface.",
			steps: [
				{ text: "Inspect the architecture", status: "completed" },
				{ text: "Implement the workflow", status: "in_progress" },
			],
		});
		expect(draft.revision).toBe(1);
		expect(draft.steps.every((step) => step.id.length > 0)).toBe(true);
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
		expect(session.getActiveToolNames()).toContain("update_plan");
		expect(session.getActiveToolNames()).not.toContain("submit_plan");

		const active = session.planningState.plan!;
		const completed = session.updatePlan({
			planId: active.id,
			expectedRevision: active.revision,
			title: active.title,
			summary: active.summary,
			steps: [
				...active.steps.map((step) => ({ ...step, status: "completed" as const })),
				{ text: "Verify the coordinated surfaces", status: "completed" },
			],
		});
		expect(completed.phase).toBe("completed");
		expect(completed.revision).toBe(active.revision + 1);
		session.dispose();
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
