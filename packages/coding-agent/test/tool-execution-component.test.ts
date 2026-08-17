import { join } from "node:path";
import {
	Image,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	Text,
	type TUI,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createSubagentToolDefinition, type SubagentToolDetails } from "../src/core/tools/subagent.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
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

	afterEach(() => {
		vi.restoreAllMocks();
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

	test("converts non-PNG tool images before Sixel rendering", async () => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			let renderRequests = 0;
			const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-sixel-gif",
				{},
				{},
				createBaseToolDefinition(),
				tui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [
						{
							type: "image",
							mimeType: "image/gif",
							data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
						},
					],
					details: {},
					isError: false,
				},
				false,
			);
			expect(component.render(120).join("\n")).not.toContain("\x1bP0;1;0q");

			await vi.waitFor(() => expect(renderRequests).toBeGreaterThan(0));
			const rendered = component.render(120).join("\n");
			expect(rendered).toContain("\x1bP0;1;0q");
			expect(rendered).not.toContain("[image/gif]");
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	test("converts an existing non-PNG tool image after delayed Sixel detection", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			let renderRequests = 0;
			const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-delayed-sixel-gif",
				{},
				{},
				createBaseToolDefinition(),
				tui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [
						{
							type: "image",
							mimeType: "image/gif",
							data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
						},
					],
					details: {},
					isError: false,
				},
				false,
			);
			expect(component.render(120).join("\n")).not.toContain("\x1bP0;1;0q");
			expect(renderRequests).toBe(0);

			setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
			component.invalidate();

			await vi.waitFor(() => expect(renderRequests).toBeGreaterThan(0));
			const rendered = component.render(120).join("\n");
			expect(rendered).toContain("\x1bP0;1;0q");
			expect(rendered).not.toContain("[image/gif]");
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	test("ignores a stale non-PNG conversion that completes after a newer image", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const oldConversion = deferred<{ data: string; mimeType: string } | null>();
		const newConversion = deferred<{ data: string; mimeType: string } | null>();
		vi.spyOn(imageConvert, "convertToPng").mockImplementation((data) =>
			data === "old-source" ? oldConversion.promise : newConversion.promise,
		);
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-conversion-race",
				{},
				{},
				createBaseToolDefinition(),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "image", mimeType: "image/gif", data: "old-source" }], isError: false },
				true,
			);
			component.updateResult(
				{ content: [{ type: "image", mimeType: "image/webp", data: "new-source" }], isError: false },
				false,
			);
			newConversion.resolve({ data: "new-png", mimeType: "image/png" });
			await newConversion.promise;
			await Promise.resolve();
			expect(component.render(80).join("\n")).toContain("new-png");

			oldConversion.resolve({ data: "old-png", mimeType: "image/png" });
			await oldConversion.promise;
			await Promise.resolve();
			const rendered = component.render(80).join("\n");
			expect(rendered).toContain("new-png");
			expect(rendered).not.toContain("old-png");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("deduplicates concurrent conversions of an identical image source", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const conversion = deferred<{ data: string; mimeType: string } | null>();
		const convert = vi.spyOn(imageConvert, "convertToPng").mockReturnValue(conversion.promise);
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-conversion-dedup",
				{},
				{},
				createBaseToolDefinition(),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{
					content: [
						{ type: "image", mimeType: "image/gif", data: "duplicate-source" },
						{ type: "image", mimeType: "image/gif", data: "duplicate-source" },
					],
					isError: false,
				},
				false,
			);
			expect(convert).toHaveBeenCalledTimes(1);
			conversion.resolve({ data: "dedup-png", mimeType: "image/png" });
			await conversion.promise;
			await Promise.resolve();
			expect(
				component
					.render(80)
					.join("\n")
					.match(/dedup-png/g),
			).toHaveLength(2);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("does not apply or render-request a conversion after disposal", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const conversion = deferred<{ data: string; mimeType: string } | null>();
		vi.spyOn(imageConvert, "convertToPng").mockReturnValue(conversion.promise);
		let renderRequests = 0;
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-conversion-dispose",
				{},
				{},
				createBaseToolDefinition(),
				{ requestRender: () => renderRequests++ } as unknown as TUI,
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "image", mimeType: "image/gif", data: "disposed-source" }], isError: false },
				false,
			);
			component.dispose();
			conversion.resolve({ data: "disposed-png", mimeType: "image/png" });
			await conversion.promise;
			await Promise.resolve();
			expect(renderRequests).toBe(0);
			expect(component.render(80).join("\n")).not.toContain("disposed-png");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("disposes image components when results replace them and when the tool is disposed", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const dispose = vi.spyOn(Image.prototype, "dispose");
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-lifecycle",
				{},
				{},
				createBaseToolDefinition(),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "image", mimeType: "image/png", data: "first-png" }], isError: false },
				true,
			);
			component.updateResult(
				{ content: [{ type: "image", mimeType: "image/png", data: "second-png" }], isError: false },
				false,
			);
			expect(dispose).toHaveBeenCalledTimes(1);
			component.dispose();
			expect(dispose).toHaveBeenCalledTimes(2);
		} finally {
			resetCapabilitiesCache();
		}
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

	test("collapses fallback output for tools without result renderers and shows expand hint", () => {
		const toolDefinition: ToolDefinition = createBaseToolDefinition();
		const output = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-fallback-collapse",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("20 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-11");
		expect(expanded).toContain("line-30");
		expect(expanded).not.toContain("more lines");
	});

	test("does not collapse short fallback output", () => {
		const toolDefinition: ToolDefinition = createBaseToolDefinition();
		const output = Array.from({ length: 5 }, (_, i) => `short-${i + 1}`).join("\n");

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-fallback-short",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("short-5");
		expect(rendered).not.toContain("more lines");
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
		expect(updates).toEqual([{ content: [] }]);
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
		component.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
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
		component.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
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
		component.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
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
		component.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
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
		component.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
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
					durationMs: 32_100,
					usage: createSubagentUsage(),
					output: createSubagentOutput("final answer"),
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Subagent  1 done");
		expect(collapsed).toContain("scout · Inspect the auth flow");
		expect(collapsed).toContain("done · 0 tool calls · 32.1s · 30 tokens");
		expect(collapsed).not.toContain("final answer");
		expect(collapsed).toContain("inspect");
		expect(collapsed).toContain("outputs");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("final answer");
		expect(expanded).toContain("collapse outputs");
	});

	test("does not present a subagent until a child is actually created", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-preflight",
			{ agent: "scout", task: "Inspect the auth flow" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [{ type: "text", text: "A registry preflight was completed. No subagents were started." }],
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 3, completed: 0, failed: 0, aborted: 0, running: 3 },
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("presents explicit registry list and follow calls without a created child", () => {
		const listComponent = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-list",
			{ list: true },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		listComponent.markExecutionStarted();
		expect(stripAnsi(listComponent.render(120).join("\n"))).toContain("Subagent registry");
		listComponent.updateResult(
			{
				content: [{ type: "text", text: "2 subagent runs recorded in this session" }],
				details: {
					mode: "list",
					status: "completed",
					summary: { total: 2, completed: 1, failed: 0, aborted: 0, running: 1, returned: 2 },
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);
		expect(stripAnsi(listComponent.render(120).join("\n"))).toContain("Subagent registry");

		const followComponent = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-follow",
			{ follow: "sa_existing" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		followComponent.markExecutionStarted();
		expect(followComponent.render(120)).not.toEqual([]);
		followComponent.updateResult(
			{
				content: [{ type: "text", text: "shared result" }],
				details: {
					mode: "follow",
					status: "completed",
					subagentId: "sa_existing",
					agent: { name: "researcher", source: "built-in" },
				} satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);
		expect(stripAnsi(followComponent.render(120).join("\n"))).toContain("researcher");
	});

	test("presents terminal errors that occur before any child is created", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-precreation-error",
			{ agent: "scout", task: "Inspect the auth flow" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [
					{ type: "text", text: 'Cannot delegate to "scout": the delegation tree already started 100 subagents' },
				],
				isError: true,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("scout");
		expect(rendered).toContain("failed");
	});

	test("dispose releases the subagent repaint interval", () => {
		vi.useFakeTimers();
		try {
			let renderRequests = 0;
			const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
			const component = new ToolExecutionComponent(
				"subagent",
				"tool-subagent-dispose",
				{ agent: "scout", task: "Inspect the auth flow" },
				{},
				createSubagentRenderDefinition(),
				tui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [{ type: "text", text: "started" }],
					details: {
						mode: "single",
						status: "running",
						subagentId: "sa_1",
						sessionId: "session_1",
						agent: { name: "scout" },
					} satisfies SubagentToolDetails,
					isError: false,
				},
				true,
			);
			const baseline = renderRequests;
			vi.advanceTimersByTime(3_000);
			expect(renderRequests).toBeGreaterThan(baseline);

			component.dispose();
			const afterDispose = renderRequests;
			vi.advanceTimersByTime(5_000);
			expect(renderRequests).toBe(afterDispose);
		} finally {
			vi.useRealTimers();
		}
	});

	test("renders unstructured built-in subagent failures as terminal errors", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-error",
			{ agent: "missing", task: "Inspect the auth flow" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "started" }],
				details: {
					mode: "single",
					status: "running",
					subagentId: "sa_missing",
					sessionId: "session_missing",
					agent: { name: "missing" },
				} satisfies SubagentToolDetails,
				isError: false,
			},
			true,
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Unknown subagent: missing" }],
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Subagent  1 failed");
		expect(rendered).toContain("✗ missing · Inspect the auth flow");
		expect(rendered).toContain("failed · Unknown subagent: missing");
		expect(rendered).not.toContain("running");
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
		expect(collapsed).toContain("Subagents · parallel  1 done · 1 failed");
		expect(collapsed.indexOf("alpha · First task")).toBeLessThan(collapsed.indexOf("beta · Second task"));
		expect(collapsed).toContain("done");
		expect(collapsed).toContain("failed");
		expect(collapsed).toContain("First task");
		expect(collapsed).toContain("Second task");
		expect(collapsed).not.toContain("alpha output");
		expect(collapsed.match(/beta failed/g)?.length).toBe(1);
		for (const line of component.render(32)) expect(visibleWidth(line)).toBeLessThanOrEqual(32);

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
					startedAt: Date.now() - 65_000,
					tasks: [
						{
							index: 0,
							subagentId: "sa_alpha",
							sessionId: "session_alpha",
							agent: { name: "alpha", source: "user" },
							status: "running",
							startedAt: Date.now() - 65_000,
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
		expect(collapsed).toContain("Subagents · parallel  2 running");
		expect(collapsed).toContain("├─ … alpha · First task");
		expect(collapsed).toMatch(/│ {3}running · 6[45]\.\ds/);
		// Tasks without a startedAt render no elapsed time.
		expect(collapsed).toContain("└─ … beta · Second task");
		expect(collapsed).toMatch(/\n {4}running\n/);
		expect(collapsed).toContain("First task");
		expect(collapsed).toContain("Second task");

		// Completing the tool clears the live-elapsed refresh interval.
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: { mode: "parallel", status: "completed" } satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);
	});

	test("caps the rendered subagent roster and prioritizes non-completed runs", () => {
		const taskCount = 40;
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-roster-cap",
			{ tasks: Array.from({ length: taskCount }, (_v, i) => ({ agent: `agent-${i}`, task: `task ${i}` })) },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "progress" }],
				details: {
					mode: "parallel",
					status: "running",
					summary: { total: taskCount, completed: 30, failed: 0, aborted: 0, running: 10 },
					tasks: Array.from({ length: taskCount }, (_v, index) => ({
						index,
						subagentId: `sa_${index}`,
						sessionId: `session_${index}`,
						agent: { name: `agent-${index}`, source: "user" as const },
						// The last 10 are still running; they must all stay visible.
						status: index < 30 ? ("completed" as const) : ("running" as const),
					})),
				} satisfies SubagentToolDetails,
				isError: false,
			},
			true,
		);

		const rendered = stripAnsi(component.render(140).join("\n"));
		expect(rendered).toContain("…and 24 more agents");
		for (let index = 30; index < 40; index++) {
			expect(rendered).toContain(`agent-${index}`);
		}
		expect(rendered).toContain("agent-0");
		expect(rendered).not.toContain("agent-10 ");
		// Roster summary still reports the full counts.
		expect(rendered).toContain("10 running");
		expect(rendered).toContain("30 done");
	});

	test("bounds rendered nested-tree lines per roster item", () => {
		const children = Array.from({ length: 16 }, (_v, i) => ({
			subagentId: `sa_child-${i}`,
			agent: { name: `child-${i}` },
			status: "running" as const,
			task: `child task ${i}`,
			children: Array.from({ length: 16 }, (_w, j) => ({
				subagentId: `sa_grandchild-${i}-${j}`,
				agent: { name: `grandchild-${i}-${j}` },
				status: "running" as const,
			})),
		}));
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-tree-budget",
			{ agent: "coordinator", task: "big tree" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "progress" }],
				details: {
					mode: "single",
					status: "running",
					subagentId: "sa_root",
					agent: { name: "coordinator", source: "user" },
					children,
				} satisfies SubagentToolDetails,
				isError: false,
			},
			true,
		);

		const lines = component.render(140);
		const rendered = stripAnsi(lines.join("\n"));
		// 16 children x 16 grandchildren would be hundreds of lines without a budget.
		expect(lines.length).toBeLessThan(45);
		expect(rendered).toContain("└─ …");
		expect(rendered).toContain("child-0");
	});

	test("returns cached subagent lines until the result changes", () => {
		const component = new ToolExecutionComponent(
			"subagent",
			"tool-subagent-render-cache",
			{ agent: "worker", task: "cached task" },
			{},
			createSubagentRenderDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		const runningDetails = {
			mode: "single",
			status: "running",
			subagentId: "sa_worker",
			agent: { name: "worker", source: "user" },
		} satisfies SubagentToolDetails;
		component.updateResult(
			{ content: [{ type: "text", text: "progress" }], isError: false, details: runningDetails },
			true,
		);

		const first = component.render(140);
		expect(component.render(140)).toEqual(first);

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: { ...runningDetails, status: "completed" } satisfies SubagentToolDetails,
				isError: false,
			},
			false,
		);
		const completed = stripAnsi(component.render(140).join("\n"));
		expect(completed).toContain("done");
		expect(completed).not.toContain("running");
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
		expect(expanded).toContain("Subagents · chain  2 done");
		expect(expanded).toContain("first · Collect facts");
		expect(expanded).toContain("Collect facts");
		expect(expanded).toContain("first output");
		expect(expanded).toContain("second · Use {previous} to decide");
		expect(expanded).toContain("Use {previous} to decide");
		expect(expanded).toContain("second output");
	});

	test("renders pending, running, partial, success, and failure states as text", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("inspect target.ts", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-states",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		expect(stripAnsi(component.render(120).join("\n"))).toContain("inspect target.ts [pending]");
		component.markExecutionStarted();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("inspect target.ts [running]");
		component.updateResult({ content: [{ type: "text", text: "working" }], isError: false }, true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("inspect target.ts [partial]");
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("inspect target.ts [success]");
		component.updateResult({ content: [{ type: "text", text: "broken" }], isError: true }, false);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("inspect target.ts [failure]");
	});

	test("renders lifecycle colors without state background bands", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("inspect target.ts", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-no-state-background",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain("[success]");
		expect(rendered).not.toContain("\x1b[48;");
	});

	test("keeps lifecycle state visible when header metadata wraps", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("inspect a-very-long-target-name.ts", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-state-wrap",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const lines = component.render(32).map(stripAnsi);
		expect(lines.some((line) => line.includes("[success]"))).toBe(true);
	});

	test("appends a dim duration to the call header once execution completes", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-duration",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		component.markExecutionStarted();

		now.mockReturnValue(3_000);
		component.updateResult({ content: [{ type: "text", text: "working" }], details: {}, isError: false }, true);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("(2.0s)");

		now.mockReturnValue(5_200);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call [success] (4.2s)");

		// Duration is frozen at completion; later renders keep the same value
		now.mockReturnValue(99_000);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call [success] (4.2s)");
	});

	test("hides sub-second durations", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-duration-fast",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		component.markExecutionStarted();
		now.mockReturnValue(1_400);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);

		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("(0.4s)");
	});

	test("shows durations for tools without renderers and for restored history only when execution was observed", () => {
		const now = vi.spyOn(Date, "now");

		// No tool definition -> generic fallback rendering still gets the suffix
		const fallbackComponent = new ToolExecutionComponent(
			"mystery_tool",
			"tool-duration-fallback",
			{ foo: "bar" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		now.mockReturnValue(1_000);
		fallbackComponent.markExecutionStarted();
		now.mockReturnValue(4_500);
		fallbackComponent.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(stripAnsi(fallbackComponent.render(120).join("\n"))).toContain("mystery_tool [success] (3.5s)");

		// Restored history never calls markExecutionStarted -> no duration
		const restoredComponent = new ToolExecutionComponent(
			"mystery_tool",
			"tool-duration-restored",
			{ foo: "bar" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		now.mockReturnValue(9_000);
		restoredComponent.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(stripAnsi(restoredComponent.render(120).join("\n"))).not.toContain("s)");
	});

	test("highlights built-in bash tool commands", () => {
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
		const component = new ToolExecutionComponent(
			"bash",
			"tool-highlight-bash",
			{ command: `cd src && python -c 'print("hello")'` },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain(theme.fg("syntaxFunction", "cd"));
		expect(rendered).toContain(theme.fg("syntaxFunction", "python"));
		expect(stripAnsi(rendered)).toContain(`$ cd src && python -c 'print("hello")' [pending]`);
	});

	test("does not add a second duration for the built-in bash renderer", () => {
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
		const component = new ToolExecutionComponent(
			"bash",
			"tool-duration-bash",
			{ command: "sleep 5" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);

		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		component.markExecutionStarted();
		now.mockReturnValue(6_000);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Took 5.0s");
		expect(rendered.match(/5\.0s/g)?.length ?? 0).toBe(1);
		expect(rendered).not.toContain("(5.0s)");
	});

	test("wraps state and duration metadata when the header line has no room", () => {
		const longHeader = "x".repeat(60);
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text(longHeader, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-duration-narrow",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		component.markExecutionStarted();
		now.mockReturnValue(3_500);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);

		// Box padding leaves the narrow header without room for metadata, so
		// state and duration move to the next line rather than disappearing.
		const narrow = stripAnsi(component.render(64).join("\n"));
		expect(narrow).toContain(longHeader);
		expect(narrow).toContain("[success] (2.5s)");
		expect(stripAnsi(component.render(120).join("\n"))).toContain(`${longHeader} [success] (2.5s)`);
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
		component.updateResult({ content: [{ type: "text", text: "one\ntwo\n" }], isError: false }, false);
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
		component.updateResult({ content: [{ type: "text", text: "hidden content" }], isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	const outsideAgentsPath = process.platform === "win32" ? "C:/outside/AGENTS.md" : "/outside/AGENTS.md";
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
			path: outsideAgentsPath,
			content: "Hidden outside resource instructions",
			compact: `read resource ${outsideAgentsPath}`,
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
			component.updateResult({ content: [{ type: "text", text: scenario.content }], isError: false }, false);

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
