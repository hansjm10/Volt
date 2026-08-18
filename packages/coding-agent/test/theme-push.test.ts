import { describe, expect, it, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import {
	createHostThemeTokensFrame,
	HOST_THEME_TOKENS_FEATURE,
	sanitizeHostThemeTokens,
} from "../src/daemon/theme-push.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

describe("host theme token push (§9.5)", () => {
	it("keeps only plain hex colors and drops anything path-like or unresolved", () => {
		const sanitized = sanitizeHostThemeTokens({
			accent: "#ff8800",
			background: "#101010ff",
			short: "#abc",
			shortAlpha: "#abcd",
			pathLike: "/Users/someone/.volt/agent/themes/custom.json",
			varRef: "var(accent)",
			ansi: "[38;5;208m",
			empty: "",
			notHex: "#zzzzzz",
			fiveDigits: "#12345",
		});
		expect(sanitized).toEqual({
			accent: "#ff8800",
			background: "#101010ff",
			short: "#abc",
			shortAlpha: "#abcd",
		});
	});

	it("frames tokens under data with the theme name", () => {
		const frame = createHostThemeTokensFrame("dark", { accent: "#ff8800", leak: "/tmp/x" });
		expect(frame).toEqual({
			type: "host_theme_tokens",
			data: { themeName: "dark", tokens: { accent: "#ff8800" } },
		});
		expect(HOST_THEME_TOKENS_FEATURE).toBe("host_theme_tokens.v1");
	});

	test("rpc mode reports set_client_capabilities feature lists to the host", async () => {
		const session = {
			bindExtensions: vi.fn(async () => undefined),
			subscribe: vi.fn(() => () => undefined),
			activeToolExecutions: new Map(),
			subscribeRuntimeEvents: vi.fn(() => () => undefined),
			resourceLoader: {
				getSubagents: () => ({ definitions: [], diagnostics: [] }),
				getThemes: () => ({ themes: [] }),
			},
			getSubagentToolManager: () => undefined,
			getActiveToolNames: () => ["read"],
			sessionId: "s-caps",
			sessionFile: undefined,
			settingsManager: { getTheme: () => undefined, setTheme: vi.fn() },
		};
		const runtimeHost = {
			get session() {
				return session;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			switchSessionById: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => undefined),
			setRebindSession: vi.fn(),
			async runWithStableSession<T>(operation: (stableSession: AgentSession) => Promise<T> | T): Promise<T> {
				return operation(session as unknown as AgentSession);
			},
		} as unknown as AgentSessionRuntime;

		let lineHandler: ((line: string) => void) | undefined;
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return vi.fn();
			}),
			onClose: vi.fn((_handler: RpcCloseHandler) => vi.fn()),
			waitForBackpressure: vi.fn(async () => undefined),
			flush: vi.fn(async () => undefined),
			close: vi.fn(async () => undefined),
		};
		const capabilityUpdates: string[][] = [];
		let resolveReady: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		void runRpcMode(runtimeHost, {
			transport,
			onReady: resolveReady,
			onClientCapabilitiesChanged: (features) => capabilityUpdates.push(features),
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(
			JSON.stringify({
				id: "c1",
				type: "set_client_capabilities",
				features: ["host_action_requests.v1", HOST_THEME_TOKENS_FEATURE],
			}),
		);
		await vi.waitFor(() => expect(capabilityUpdates).toHaveLength(1));
		expect(capabilityUpdates[0]).toContain(HOST_THEME_TOKENS_FEATURE);
		expect(capabilityUpdates[0]).toContain("host_action_requests.v1");
	});
});
