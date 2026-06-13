import { afterEach, describe, expect, it, vi } from "vitest";
import rtkExtension from "../examples/extensions/rtk.ts";
import type {
	BashToolCallEvent,
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/index.ts";

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

interface FakeVolt {
	volt: ExtensionAPI;
	exec: ReturnType<typeof vi.fn<(command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>>>;
	toolCallHandlers: ToolCallHandler[];
}

function execResult(overrides: Partial<ExecResult>): ExecResult {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
		...overrides,
	};
}

function createFakeVolt(
	exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>,
): FakeVolt {
	const toolCallHandlers: ToolCallHandler[] = [];
	const execMock = vi.fn(exec);
	const volt = {
		on(event: string, handler: unknown) {
			if (event === "tool_call") {
				toolCallHandlers.push(handler as ToolCallHandler);
			}
		},
		exec: execMock,
	} as unknown as ExtensionAPI;

	return { volt, exec: execMock, toolCallHandlers };
}

function createContext(signal?: AbortSignal): ExtensionContext {
	return { signal } as ExtensionContext;
}

function createBashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command },
	};
}

async function installExtension(fakeVolt: FakeVolt): Promise<ToolCallHandler> {
	await rtkExtension(fakeVolt.volt);
	expect(fakeVolt.toolCallHandlers).toHaveLength(1);
	return fakeVolt.toolCallHandlers[0];
}

const originalRtkDisabled = process.env.RTK_DISABLED;

afterEach(() => {
	if (originalRtkDisabled === undefined) {
		delete process.env.RTK_DISABLED;
	} else {
		process.env.RTK_DISABLED = originalRtkDisabled;
	}
	vi.restoreAllMocks();
});

describe("rtk extension example", () => {
	it("rewrites bash commands through rtk rewrite", async () => {
		const fakeVolt = createFakeVolt(async (_command, args) => {
			if (args[0] === "--version") return execResult({ stdout: "rtk 0.42.4\n" });
			if (args[0] === "rewrite") return execResult({ stdout: "rtk git status\n" });
			return execResult({ code: 1 });
		});
		const handler = await installExtension(fakeVolt);
		const event = createBashEvent("git status");

		await handler(event, createContext());

		expect(event.input.command).toBe("rtk git status");
		expect(fakeVolt.exec).toHaveBeenLastCalledWith("rtk", ["rewrite", "git status"], {
			timeout: 2_000,
			signal: undefined,
		});
	});

	it("accepts advisory rewrite exit code 3", async () => {
		const fakeVolt = createFakeVolt(async (_command, args) => {
			if (args[0] === "--version") return execResult({ stdout: "rtk 0.42.4\n" });
			if (args[0] === "rewrite") return execResult({ code: 3, stdout: "rtk npm run check\n" });
			return execResult({ code: 1 });
		});
		const handler = await installExtension(fakeVolt);
		const event = createBashEvent("npm run check");

		await handler(event, createContext());

		expect(event.input.command).toBe("rtk npm run check");
	});

	it("passes through when RTK_DISABLED is set", async () => {
		process.env.RTK_DISABLED = "1";
		const fakeVolt = createFakeVolt(async (_command, args) => {
			if (args[0] === "--version") return execResult({ stdout: "rtk 0.42.4\n" });
			throw new Error("rewrite should not run");
		});
		const handler = await installExtension(fakeVolt);
		const event = createBashEvent("git status");

		await handler(event, createContext());

		expect(event.input.command).toBe("git status");
		expect(fakeVolt.exec).toHaveBeenCalledTimes(1);
	});

	it("does not register a handler when rtk is too old", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fakeVolt = createFakeVolt(async (_command, args) => {
			if (args[0] === "--version") return execResult({ stdout: "rtk 0.22.0\n" });
			return execResult({ code: 1 });
		});

		await rtkExtension(fakeVolt.volt);

		expect(fakeVolt.toolCallHandlers).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith("[rtk] rtk 0.22.0 is too old; need rtk >= 0.23.0");
	});

	it("passes through when rewrite fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fakeVolt = createFakeVolt(async (_command, args) => {
			if (args[0] === "--version") return execResult({ stdout: "rtk 0.42.4\n" });
			throw new Error("rewrite failed");
		});
		const handler = await installExtension(fakeVolt);
		const event = createBashEvent("git status");

		await handler(event, createContext());

		expect(event.input.command).toBe("git status");
		expect(warn).toHaveBeenCalledWith(
			"[rtk] unexpected error in tool_call handler; passing through command",
			expect.any(Error),
		);
	});
});
