import {
	type Component,
	Container,
	Editor,
	isViewportTUI,
	ProcessTerminal,
	ScrollView,
	setKeybindings,
	Text,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@hansjm10/volt-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { PlanningState, PlanPhase, PlanState } from "../../src/core/planning.ts";
import { getEditorTheme, initTheme, theme } from "../../src/core/theme/runtime.ts";
import { createPlanningToolDefinitions, type PlanningToolController } from "../../src/core/tools/planning.ts";
import { PlanInspectorComponent } from "../../src/modes/interactive/components/plan-inspector.ts";
import { PlanDetailsComponent, PlanStatusComponent } from "../../src/modes/interactive/components/plan-status.ts";
import { ResponsivePlanLayoutComponent } from "../../src/modes/interactive/components/responsive-plan-layout.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";

class FixtureFooter implements Component {
	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		const left = "workspace · main";
		const right = "fixture-model";
		return [
			theme.fg("dim", left) + " ".repeat(Math.max(1, width - left.length - right.length)) + theme.fg("text", right),
		];
	}
}

const width = process.stdout.columns || 160;
const height = process.stdout.rows || 36;
const hold = process.env.VOLT_PLAN_HOLD === "1";
const fullscreen = process.env.VOLT_TUI_MODE === "fullscreen";
initTheme(process.env.VOLT_PLAN_THEME === "light" ? "light" : "dark");
const keybindings = new KeybindingsManager();
setKeybindings(keybindings);

const requestedPhase = process.env.VOLT_PLAN_PHASE;
const phase: PlanPhase =
	requestedPhase === "draft" ||
	requestedPhase === "active" ||
	requestedPhase === "completed" ||
	requestedPhase === "handed_off"
		? requestedPhase
		: "ready";
const execution =
	phase === "active" || phase === "completed" || phase === "handed_off"
		? {
				id: "fixture-execution",
				approvedRevision: 7,
				strategy: "retain_context" as const,
				sourceSessionId: "fixture-source-session",
				targetSessionId: "fixture-target-session",
			}
		: undefined;
const plan: PlanState = {
	id: "plan-native-mode",
	revision: 7,
	phase,
	title: "Responsive Two-Pane Plan Lifecycle TUI With Readable Wrapped Content at Every Terminal Width",
	summary:
		"Keep canonical planning state, conversation controls, progress, lifecycle actions, and end-to-end verification visible without truncating authored content or changing approval semantics.",
	steps: [
		{ id: "step-1", text: "Define the responsive width and height contract", status: "completed" },
		{ id: "step-2", text: "Preserve branch-local planning state outside compaction", status: "completed" },
		{ id: "step-3", text: "Compose ANSI-safe conversation and inspector lines", status: "completed" },
		{ id: "step-4", text: "Keep the footer full-width below both panes", status: "completed" },
		{
			id: "step-5",
			text: "Integrate focus, resize recovery, ready actions, and a complete long checklist item across wrapped visual rows",
			status: phase === "completed" || phase === "handed_off" ? "completed" : "in_progress",
			note: "Verified against exact responsive boundaries and compact fallback",
		},
		{
			id: "step-6",
			text: "Verify streaming, selectors, extension UI, images, themes, ASCII, and scrollback",
			status: phase === "completed" || phase === "handed_off" ? "completed" : "pending",
		},
		{ id: "step-7", text: "Capture narrow and wide lifecycle states", status: "pending" },
		{ id: "step-8", text: "Prepare focused release notes and review evidence", status: "pending" },
	],
	...(execution ? { execution } : {}),
};

const planning: PlanningState = { mode: phase === "draft" || phase === "ready" ? "plan" : "build", plan };
const terminal = hold ? new ProcessTerminal() : new VirtualTerminal(width, height);
const tui: TUI = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
const details = new PlanDetailsComponent({
	plan,
	getTerminalRows: () => tui.terminal.rows,
	onAction: () => undefined,
	onClose: () => undefined,
	requestRender: () => tui.requestRender(),
});
const editor = new Editor(tui, getEditorTheme(), {
	topBorderLabel: planning.mode === "plan" ? "PLAN · AGENT READ-ONLY" : "ASK VOLT · BUILD",
	placeholder: "Tell Volt what to change",
});
const actionMessage = new Text("", 1, 0);
let inspector: PlanInspectorComponent;
const focusEditor = () => {
	transcriptScroll.setPrimary(true);
	tui.setFocus(editor);
};
const toggleFocus = () => {
	if (inspector.focused) focusEditor();
	else {
		transcriptScroll.setPrimary(false);
		inspector.setFullscreenActive(fullscreen);
		tui.setFocus(inspector);
	}
	tui.requestRender();
};
inspector = new PlanInspectorComponent({
	planning,
	onAction: (action) => {
		actionMessage.setText(theme.fg("accent", `Selected ready action: ${action}`));
		tui.requestRender();
	},
	onReturnFocus: focusEditor,
	onToggleFocus: toggleFocus,
	requestRender: () => tui.requestRender(),
});
const status = new PlanStatusComponent(planning);
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
		content: [{ type: "text", text: JSON.stringify({ mode: planning.mode, planId: plan.id, steps: plan.steps }) }],
		details: planning,
		isError: false,
	},
	false,
);
tool.setExpanded(process.env.VOLT_PLAN_EXPANDED === "1");

const transcript = new Container();
transcript.addChild(
	new Text(theme.fg("muted", "Conversation transcript remains available while the plan stays visible."), 1, 0),
);
if (process.env.VOLT_PLAN_SCENARIO === "tools") transcript.addChild(tool);
if (process.env.VOLT_PLAN_SCENARIO === "scrollback") {
	transcript.addChild(
		new Text(Array.from({ length: 40 }, (_, index) => `Conversation history row ${index + 1}`).join("\n"), 1, 0),
	);
}
const streamingText = new Text("Assistant stream: chunk 1", 1, 0);
if (process.env.VOLT_PLAN_STREAM === "1") transcript.addChild(streamingText);
const statusContainer = new Container();
statusContainer.addChild(status);
const editorContainer = new Container();
editorContainer.addChild(actionMessage);
editorContainer.addChild(editor);
const footer = new FixtureFooter();
const transcriptScroll = new ScrollView(transcript, { follow: "end", primary: true });
let layout: ResponsivePlanLayoutComponent;
const fullscreenConversation = new VStack([
	{ component: transcriptScroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
	{
		component: statusContainer,
		shrink: 2,
		minSize: 0,
		visible: () => !layout.isTerminalSplit(),
	},
	{ component: editorContainer, shrink: 1, minSize: 1 },
]);
layout = new ResponsivePlanLayoutComponent({
	planning,
	transcriptComponents: [transcript],
	controlComponents: [editorContainer],
	compactComponents: [transcript, statusContainer, details, editorContainer],
	fullscreenConversation,
	inspector,
	footer,
	getTerminalColumns: () => tui.terminal.columns,
	getTerminalRows: () => tui.terminal.rows,
	requestViewportReset: () => {
		if (tui instanceof TuiMainScreen) tui.resetViewportOnNextRender();
	},
	onSplitChange: () => undefined,
});

tui.addChild(layout);
if (isViewportTUI(tui)) tui.setLayoutRoot(layout.getFullscreenLayout());
if (process.env.VOLT_PLAN_FOCUSED === "1") {
	transcriptScroll.setPrimary(false);
	inspector.setFullscreenActive(fullscreen);
	tui.setFocus(inspector);
} else {
	tui.setFocus(editor);
}
tui.addInputListener((data) => {
	if (!keybindings.matches(data, "app.plan.togglePane")) return undefined;
	toggleFocus();
	return { consume: true };
});

tui.start();
if (hold) {
	let streamChunk = 1;
	const streamTimer =
		process.env.VOLT_PLAN_STREAM === "1"
			? setInterval(() => {
					streamChunk += 1;
					streamingText.setText(`Assistant stream: chunk ${streamChunk}`);
					tui.requestRender();
				}, 1000)
			: undefined;
	process.on("SIGTERM", () => {
		if (streamTimer) clearInterval(streamTimer);
		tui.stop({ preserveScreen: true });
		process.exit(0);
	});
} else {
	if (!(terminal instanceof VirtualTerminal)) throw new Error("Expected virtual terminal");
	await terminal.waitForRender();
	const output = terminal.getViewport().map((line) => `${line}\u001b[0m`);
	tui.stop({ preserveScreen: true });
	process.stdout.write(`\u001b[2J${output.map((line, index) => `\u001b[${index + 1};1H${line}`).join("")}`);
}
