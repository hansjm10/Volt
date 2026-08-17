import { Editor, TuiMainScreen } from "@hansjm10/volt-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { PlanningState, PlanState } from "../../src/core/planning.ts";
import { getEditorTheme, initTheme, theme } from "../../src/core/theme/runtime.ts";
import { createPlanningToolDefinitions, type PlanningToolController } from "../../src/core/tools/planning.ts";
import { PlanDetailsComponent, PlanStatusComponent } from "../../src/modes/interactive/components/plan-status.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";

const width = process.stdout.columns || 120;
const height = process.stdout.rows || 36;
initTheme(process.env.VOLT_PLAN_THEME === "light" ? "light" : "dark");

const plan: PlanState = {
	id: "plan-native-mode",
	revision: 7,
	phase: "ready",
	title: "Native Plan Mode Across Volt and Volt App With Readable Wrapped Content at Every Terminal Width",
	summary:
		"Coordinate durable branch-local planning, exact approval, responsive clients, and end-to-end verification while keeping the complete decision summary visible instead of truncating it.",
	steps: [
		{ id: "step-1", text: "Define the shared planning state and validate its bounds", status: "completed" },
		{ id: "step-2", text: "Persist branch-local snapshots outside compaction", status: "completed" },
		{ id: "step-3", text: "Enforce read-only Plan tools at the execution boundary", status: "completed" },
		{ id: "step-4", text: "Wire strict RPC bootstrap, checkpoint, and event schemas", status: "completed" },
		{
			id: "step-5",
			text: "Implement exact revision-fenced execution actions and keep the complete long checklist item readable across wrapped visual rows",
			status: "in_progress",
			note: "Verified against stale revisions and compact terminal rendering",
		},
		{
			id: "step-6",
			text: "Render the responsive terminal plan viewer without cutting off authored lines",
			status: "pending",
		},
		{ id: "step-7", text: "Project Plan state into the iOS composer", status: "pending" },
		{ id: "step-8", text: "Fence delayed mobile responses by conversation authority", status: "pending" },
		{ id: "step-9", text: "Verify reconnect and branch rebase recovery", status: "pending" },
		{ id: "step-10", text: "Run dark and light visual review", status: "pending" },
		{ id: "step-11", text: "Run Unicode and ASCII visual review", status: "pending" },
		{ id: "step-12", text: "Complete coordinated release checks", status: "pending" },
	],
};

const planning: PlanningState = { mode: "plan", plan };
const tui = new TuiMainScreen(new VirtualTerminal(width, height));
const details = new PlanDetailsComponent({
	plan,
	getTerminalRows: () => height,
	onAction: () => undefined,
	onClose: () => undefined,
	requestRender: () => undefined,
});
const status = new PlanStatusComponent(planning);
const editor = new Editor(tui, getEditorTheme(), {
	topBorderLabel: "PLAN · AGENT READ-ONLY",
	placeholder: "Tell Volt what to change in the plan",
});
const controller: PlanningToolController = {
	getPlanningState: () => planning,
	flushPlanningState: async () => undefined,
	updatePlan: () => plan,
	submitPlan: () => plan,
	updatePlanProgress: () => plan,
	requestReplan: () => planning,
};
const updatePlanDefinition = createPlanningToolDefinitions(controller)[0];
const tool = new ToolExecutionComponent(
	"update_plan",
	"fixture-update-plan",
	{
		title: plan.title,
		summary: plan.summary,
		steps: plan.steps.map((step) => ({ id: step.id, text: step.text })),
	},
	{},
	updatePlanDefinition,
	tui,
	process.cwd(),
);
tool.updateResult(
	{
		content: [{ type: "text", text: JSON.stringify({ mode: "plan", planId: plan.id, steps: plan.steps }) }],
		details: planning,
		isError: false,
	},
	false,
);
tool.setExpanded(process.env.VOLT_PLAN_EXPANDED === "1");

const primaryLines = process.env.VOLT_PLAN_SCENARIO === "tools" ? tool.render(width) : details.render(width);
const statusLines = status.render(width);
const editorLines = editor.render(width);
const footer = theme.fg("dim", "Shift+Tab build/plan  Ctrl+Shift+T thinking");
const reservedBottomRows = statusLines.length + editorLines.length + 1;
const availablePrimaryRows = Math.max(0, height - reservedBottomRows);
const visiblePrimaryLines = primaryLines.slice(Math.max(0, primaryLines.length - availablePrimaryRows));
const fixedRows = visiblePrimaryLines.length + reservedBottomRows;
const spacer = Array.from({ length: Math.max(0, height - fixedRows) }, () => "");
const lines = [...visiblePrimaryLines, ...spacer, ...statusLines, ...editorLines, footer];
const output = lines.slice(0, height).map((line) => `${line}\u001b[0m`);

process.stdout.write(`\u001b[2J${output.map((line, index) => `\u001b[${index + 1};1H${line}`).join("")}`);
