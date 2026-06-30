import { join, resolve } from "node:path";
import { Text, type TUI } from "@earendil-works/volt-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSubagentToolDefinition, type SubagentToolDetails } from "../src/core/tools/subagent.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createSubagentRenderDefinition() {
	return createSubagentToolDefinition({
		manager: {
			getDefinition: () => {
				throw new Error("not used");
			},
			startByName: async () => {
				throw new Error("not used");
			},
		},
	});
}

function createSubagentUsage(): NonNullable<SubagentToolDetails["usage"]> {
	return {
		turns: 1,
		messages: { user: 1, assistant: 1, toolCalls: 0, toolResults: 0, total: 2 },
		tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
		cost: 0,
	};
}

function createSubagentOutput(text: string): NonNullable<NonNullable<SubagentToolDetails["tasks"]>[number]["output"]> {
	return {
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		truncated: false,
		maxBytes: 50 * 1024,
	};
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("renders built-in subagent single results compactly until expanded", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-single",
			{ agent: "scout", task: "Inspect the auth flow" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "final answer" }],
				details: {
					mode: "single",
					status: "completed",
					subagentId: "sa_1",
					sessionId: "session_1",
					agent: { name: "scout", source: "user" },
					usage: createSubagentUsage(),
					output: createSubagentOutput("final answer"),
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("subagent scout");
		expect(collapsed).toContain("scout (user) completed");
		expect(collapsed).toContain("Inspect the auth flow");
		expect(collapsed).toContain("1 turn");
		expect(collapsed).not.toContain("final answer");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("final answer");
	});

	test("renders built-in subagent parallel statuses in stable order", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-parallel",
			{
				tasks: [
					{ agent: "alpha", task: "First task" },
					{ agent: "beta", task: "Second task" },
				],
			},
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: {
					mode: "parallel",
					status: "partial",
					summary: { total: 2, completed: 1, failed: 1, aborted: 0, maxTasks: 8, maxConcurrency: 4 },
					tasks: [
						{
							index: 0,
							subagentId: "sa_alpha",
							sessionId: "session_alpha",
							agent: { name: "alpha", source: "user" },
							status: "completed",
							usage: createSubagentUsage(),
							output: createSubagentOutput("alpha output"),
						},
						{
							index: 1,
							subagentId: "sa_beta",
							sessionId: "session_beta",
							agent: { name: "beta", source: "project" },
							status: "failed",
							output: createSubagentOutput("beta failed"),
							error: { message: "beta failed" },
						},
					],
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(140).join("\n"));
		expect(collapsed).toContain("subagent parallel 1/2 completed, 1 failed");
		expect(collapsed.indexOf("Task 1: alpha (user) completed")).toBeLessThan(
			collapsed.indexOf("Task 2: beta (project) failed"),
		);
		expect(collapsed).toContain("First task");
		expect(collapsed).toContain("Second task");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(140).join("\n"));
		expect(expanded).toContain("alpha output");
		expect(expanded).toContain("beta failed");
	});

	test("renders built-in subagent running progress compactly", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-running",
			{
				tasks: [
					{ agent: "alpha", task: "First task" },
					{ agent: "beta", task: "Second task" },
				],
			},
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Subagent parallel: 0/2 completed, 2 running" }],
				details: {
					mode: "parallel",
					status: "running",
					summary: { total: 2, completed: 0, failed: 0, aborted: 0, running: 2, maxTasks: 8, maxConcurrency: 4 },
					tasks: [
						{
							index: 0,
							subagentId: "sa_alpha",
							sessionId: "session_alpha",
							agent: { name: "alpha", source: "user" },
							status: "running",
						},
						{
							index: 1,
							subagentId: "sa_beta",
							sessionId: "session_beta",
							agent: { name: "beta", source: "project" },
							status: "running",
						},
					],
				} satisfies SubagentToolDetails,
				isError: false,
			},
			true,
		);

		const collapsed = stripAnsi(component.render(140).join("\n"));
		expect(collapsed).toContain("subagent parallel 0/2 completed, 2 running");
		expect(collapsed).toContain("Task 1: alpha (user) running");
		expect(collapsed).toContain("Task 2: beta (project) running");
		expect(collapsed).toContain("First task");
		expect(collapsed).toContain("Second task");
	});

	test("renders built-in subagent chain steps with expanded outputs", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-chain",
			{
				chain: [
					{ agent: "first", task: "Collect facts" },
					{ agent: "second", task: "Use {previous} to decide" },
				],
			},
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult(
			{
				content: [{ type: "text", text: "second output" }],
				details: {
					mode: "chain",
					status: "completed",
					summary: { total: 2, completed: 2, failed: 0, aborted: 0 },
					steps: [
						{
							index: 0,
							subagentId: "sa_first",
							sessionId: "session_first",
							agent: { name: "first", source: "user" },
							status: "completed",
							usage: createSubagentUsage(),
							output: createSubagentOutput("first output"),
						},
						{
							index: 1,
							subagentId: "sa_second",
							sessionId: "session_second",
							agent: { name: "second", source: "user" },
							status: "completed",
							usage: createSubagentUsage(),
							output: createSubagentOutput("second output"),
						},
					],
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);

		const expanded = stripAnsi(component.render(140).join("\n"));
		expect(expanded).toContain("subagent chain 2/2 completed");
		expect(expanded).toContain("Step 1: first (user) completed");
		expect(expanded).toContain("Task: Collect facts");
		expect(expanded).toContain("first output");
		expect(expanded).toContain("Step 2: second (user) completed");
		expect(expanded).toContain("Task: Use {previous} to decide");
		expect(expanded).toContain("second output");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".volt", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .volt/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Volt documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Volt documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
