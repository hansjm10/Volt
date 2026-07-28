import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { PlanningState, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { createPlanningToolDefinitions, type PlanningToolController } from "../src/core/tools/planning.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createPlan(): PlanState {
	return {
		id: "plan-rendering",
		revision: 7,
		phase: "draft",
		title: "Readable planning tools",
		summary: "Replace serialized state with semantic rendering and retain the complete expanded summary.",
		steps: [
			{
				id: "step-1",
				text: "Render the first long planning step across terminal rows without losing EXPANDED_STEP_TAIL",
				status: "completed",
				note: "Confirmed by a focused tool-card test EXPANDED_NOTE_TAIL",
			},
			{ id: "step-2", text: "Render the active planning step", status: "in_progress" },
			{ id: "step-3", text: "Render the final pending planning step", status: "pending" },
		],
	};
}

function createController(planning: PlanningState): PlanningToolController {
	return {
		getPlanningState: () => planning,
		flushPlanningState: async () => undefined,
		updatePlan: () => planning.plan!,
		submitPlan: () => planning.plan!,
		updatePlanProgress: () => planning.plan!,
		requestReplan: () => planning,
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => undefined } as unknown as TUI;
}

function plain(component: ToolExecutionComponent, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

function normalized(component: ToolExecutionComponent, width = 120): string {
	return plain(component, width).replace(/\s+/g, " ");
}

describe("planning tool TUI rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows semantic collapsed state instead of serialized JSON and expands the complete plan", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definition = createPlanningToolDefinitions(createController(planning))[0];
		const component = new ToolExecutionComponent(
			"update_plan",
			"plan-tool-1",
			{
				title: planning.plan!.title,
				steps: planning.plan!.steps.map((step) => ({ id: step.id, text: step.text })),
			},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({
							mode: planning.mode,
							planId: planning.plan!.id,
							steps: planning.plan!.steps,
						}),
					},
				],
				details: planning,
				isError: false,
			},
			false,
		);

		const collapsed = normalized(component);
		expect(collapsed).toContain("update plan · 3 steps [success]");
		expect(collapsed).toContain("DRAFT · revision 7 · 1/3 complete");
		expect(collapsed).not.toContain("planId");
		expect(collapsed).not.toContain("EXPANDED_STEP_TAIL");

		component.setExpanded(true);
		const expanded = normalized(component, 80);
		expect(expanded).toContain("Readable planning tools");
		expect(expanded).toContain("complete expanded summary");
		expect(expanded).toContain("EXPANDED_STEP_TAIL");
		expect(expanded).toContain("EXPANDED_NOTE_TAIL");
		for (const line of component.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it.each([
		{
			index: 0,
			name: "update_plan",
			args: { title: "Improve the viewer", steps: [{ text: "Implement wrapping" }, { text: "Verify" }] },
			expected: "update plan · 2 steps",
		},
		{
			index: 1,
			name: "submit_plan",
			args: { planId: "plan-rendering", expectedRevision: 7, title: "Improve the viewer", summary: "Ready" },
			expected: "submit plan · Improve the viewer",
		},
		{
			index: 2,
			name: "update_plan_progress",
			args: {
				planId: "plan-rendering",
				expectedRevision: 7,
				updates: [
					{ id: "step-1", status: "completed" },
					{ id: "step-2", status: "in_progress" },
				],
			},
			expected: "update plan progress · 1 completed · 1 in progress",
		},
		{
			index: 3,
			name: "request_replan",
			args: { planId: "plan-rendering", expectedRevision: 7, reason: "The implementation evidence changed" },
			expected: "request replan · The implementation evidence changed",
		},
	])("renders a semantic $name call", ({ index, name, args, expected }) => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definition = createPlanningToolDefinitions(createController(planning))[index]!;
		const component = new ToolExecutionComponent(
			name,
			`plan-tool-${index}`,
			args,
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		expect(normalized(component)).toContain(`${expected} [pending]`);
	});

	it("keeps planning errors readable without exposing fallback JSON", () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definition = createPlanningToolDefinitions(createController(planning))[0];
		const component = new ToolExecutionComponent(
			"update_plan",
			"plan-tool-error",
			{ steps: [] },
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Plan changed; apply the latest planning state and retry" }],
				details: undefined,
				isError: true,
			},
			false,
		);
		const rendered = normalized(component);
		expect(rendered).toContain("[failure]");
		expect(rendered).toContain("Plan changed; apply the latest planning state and retry");
		expect(rendered).not.toContain("planId");
	});

	it("preserves the serialized canonical result returned to the model", async () => {
		const planning: PlanningState = { mode: "plan", plan: createPlan() };
		const definition = createPlanningToolDefinitions(createController(planning))[0];
		const result = await definition.execute(
			"plan-tool-payload",
			{ title: "Readable planning tools", steps: [{ text: "Render semantic cards" }] },
			undefined,
			undefined,
			{} as never,
		);
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Expected text planning result");
		expect(JSON.parse(content.text)).toMatchObject({
			mode: "plan",
			planId: "plan-rendering",
			revision: 7,
			phase: "draft",
		});
	});
});
