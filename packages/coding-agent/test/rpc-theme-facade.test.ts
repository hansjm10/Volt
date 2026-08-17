/**
 * M6 rpc-mode theme facade (§9.4, supersedes the old "returns [] / fails in
 * rpc mode" behavior): extensions bound in rpc mode see the real theme list,
 * can look themes up by name, and setTheme applies + persists.
 */

import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { Theme } from "../src/core/theme/runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

function createSession() {
	return {
		bindExtensions: vi.fn(
			async (_options: {
				uiContext: ExtensionUIContext;
				mode: string;
				commandContextActions: { waitForIdle(): Promise<void> };
			}) => undefined,
		),
		subscribe: vi.fn(() => () => undefined),
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn(() => () => undefined),
		resourceLoader: {
			getSubagents: () => ({ definitions: [], diagnostics: [] }),
			getThemes: () => ({ themes: [] }),
		},
		getSubagentToolManager: () => undefined,
		getActiveToolNames: () => ["read"],
		waitForIdle: vi.fn(async () => undefined),
		sessionId: "s-theme",
		sessionFile: undefined,
		settingsManager: {
			getTheme: vi.fn(() => undefined),
			setTheme: vi.fn(),
		},
	};
}

function createRuntimeHost(session: ReturnType<typeof createSession>): AgentSessionRuntime {
	return {
		get session() {
			return session;
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		switchSessionById: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => undefined),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function createFakeTransport(): RpcTransport {
	return {
		write: vi.fn(),
		onLine: vi.fn(() => vi.fn()),
		onClose: vi.fn((_handler: RpcCloseHandler) => vi.fn()),
		waitForBackpressure: vi.fn(async () => undefined),
		flush: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
}

describe("rpc-mode extension theme facade", () => {
	test("getAllThemes is non-empty, getTheme resolves, setTheme applies and persists", async () => {
		const session = createSession();
		const runtimeHost = createRuntimeHost(session);
		let resolveReady: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(runtimeHost, { transport: createFakeTransport(), onReady: resolveReady });
		await ready;
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalled());

		const bindOptions = session.bindExtensions.mock.calls[0]?.[0];
		const uiContext = bindOptions?.uiContext as ExtensionUIContext;
		expect(bindOptions?.mode).toBe("rpc");
		await bindOptions?.commandContextActions.waitForIdle();
		expect(session.waitForIdle).toHaveBeenCalledOnce();

		// Theme rows (§12.3.4): the full list is visible in rpc mode.
		const allThemes = uiContext.getAllThemes();
		const names = allThemes.map((entry) => entry.name);
		expect(names).toContain("dark");
		expect(names).toContain("light");

		const dark = uiContext.getTheme("dark");
		expect(dark).toBeInstanceOf(Theme);

		// setTheme applies to this process's instance and persists the choice.
		const applied = uiContext.setTheme("light");
		expect(applied).toEqual({ success: true });
		expect(session.settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(uiContext.theme.name).toBe("light");

		// Unknown themes fail without persisting.
		session.settingsManager.setTheme.mockClear();
		const failed = uiContext.setTheme("no-such-theme");
		expect(failed.success).toBe(false);
		expect(session.settingsManager.setTheme).not.toHaveBeenCalled();

		await runtimeHost.dispose();
		// Shut the mode down by disposing; the transport never closes on its own
		// in this harness, so just stop awaiting it.
		void modePromise;
	});
});
