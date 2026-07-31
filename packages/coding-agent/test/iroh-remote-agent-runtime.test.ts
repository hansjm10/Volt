import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../src/core/remote/iroh/index.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import { DEFAULT_SUBAGENT_TURN_LIMITS, SubagentManager } from "../src/core/subagents/index.ts";
import {
	createIrohRemoteAgentRuntime,
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "../src/modes/rpc/iroh-remote-agent-runtime.ts";

const SAVED_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;

function expectDefaultPerRuntimeTurnStagesAndUnlimitedAggregateBudgets(manager: SubagentManager): void {
	const configuredScope = manager.createDelegationScope();
	expect(configuredScope.owned).toBe(true);
	expect(configuredScope.scope.turnLimits).toEqual(DEFAULT_SUBAGENT_TURN_LIMITS);
	configuredScope.scope.dispose();

	const cases: Array<{
		name: string;
		consume(scope: ReturnType<SubagentManager["createDelegationScope"]>["scope"]): void;
	}> = [
		{
			name: "turns",
			consume: (scope) => {
				for (let turn = 0; turn < 1_000; turn += 1) scope.recordTurn();
			},
		},
		{ name: "tokens", consume: (scope) => scope.recordUsage(50_000_001, 0) },
		{ name: "cost", consume: (scope) => scope.recordUsage(0, 100.01) },
	];

	for (const testCase of cases) {
		const lease = manager.createDelegationScope();
		expect(lease.owned).toBe(true);
		let descendantAborted = false;
		const reservation = lease.scope.reserve(`${testCase.name}-probe`, 1);
		reservation.commit(`sa_iroh-${testCase.name}-probe`, () => {
			descendantAborted = true;
		});

		testCase.consume(lease.scope);

		expect(lease.scope.signal.aborted).toBe(false);
		expect(descendantAborted).toBe(false);
		reservation.release();
		lease.scope.dispose();
	}
}

describe("createIrohRemoteAgentRuntime", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let savedEnv: Record<(typeof SAVED_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-iroh-remote-runtime-"));
		cwd = join(tempDir, "workspace");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof SAVED_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
		// Keep the runtime hermetic: MCP config resolution reads the shared
		// user config under homedir (~/.config/mcp/mcp.json).
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		for (const key of SAVED_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	function writeToolExtension(): void {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "remote-tool.ts"),
			`import { Type } from "typebox";

export default function (volt) {
	volt.registerTool({
		name: "remote_extension_tool",
		label: "Remote Extension Tool",
		description: "Remote extension test tool",
		promptSnippet: "Run remote extension test behavior",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});

	volt.on("session_start", () => {
		volt.registerTool({
			name: "remote_dynamic_tool",
			label: "Remote Dynamic Tool",
			description: "Remote dynamic test tool",
			promptSnippet: "Run remote dynamic test behavior",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	});
}
`,
		);
	}

	function writeAgent(dir: string, filename: string, frontmatter: string, body: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n\n${body}`);
	}

	function writeMcpConfig(): void {
		// A lazy stdio server is enough for the runtime to wire an McpManager
		// (and expose the "mcp" tool) without ever spawning the process.
		writeFileSync(
			join(agentDir, "mcp.json"),
			`${JSON.stringify({ servers: { "test-server": { command: "true", lifecycle: "lazy" } } }, null, 2)}\n`,
		);
	}

	function writeRuntimeConfig(settings: Record<string, unknown>): void {
		writeRuntimeModelConfig({
			api: "openai-completions",
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:9/v1",
			models: [{ id: "fake-runtime", name: "Fake Runtime" }],
		});
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					defaultProvider: "iroh-runtime-test",
					defaultModel: "fake-runtime",
					...settings,
				},
				null,
				2,
			)}\n`,
		);
	}

	function writeRuntimeModelConfig(providerConfig: Record<string, unknown>, providerName = "iroh-runtime-test"): void {
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[providerName]: providerConfig,
					},
				},
				null,
				2,
			)}\n`,
		);
	}

	it("applies HTTP proxy settings before creating the runtime", async () => {
		writeRuntimeConfig({ httpProxy: "http://127.0.0.1:7890" });
		writeMcpConfig();
		mkdirSync(join(agentDir, "commands"), { recursive: true });
		writeFileSync(join(agentDir, "commands", "remote.md"), "remote prompt\n");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({ agentDir: pathToFileURL(agentDir).href, cwd });
			expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
			expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
			expect(existsSync(join(agentDir, "prompts", "remote.md"))).toBe(true);
			expect(existsSync(join(agentDir, "commands"))).toBe(false);
			expect(readdirSync(join(agentDir, "sessions"))).toHaveLength(1);
			expect(runtime.session.getActiveToolNames()).toEqual(
				DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",").filter(
					(name) => name !== "subagent_registry" && name !== "image_gen",
				),
			);
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("uses per-runtime Iroh turn defaults while leaving aggregate consumption budgets unlimited", async () => {
		writeRuntimeConfig({});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({ agentDir, cwd });
			const manager = runtime.session.getSubagentToolManager();
			expect(manager).toBeInstanceOf(SubagentManager);
			if (!(manager instanceof SubagentManager)) {
				throw new Error("expected the Iroh runtime to create a SubagentManager");
			}

			expectDefaultPerRuntimeTurnStagesAndUnlimitedAggregateBudgets(manager);
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("keeps active user extension tools available with the default remote grant", async () => {
		writeRuntimeConfig({});
		writeMcpConfig();
		writeToolExtension();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({ agentDir, cwd });

			expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain("remote_extension_tool");
			expect(runtime.session.getActiveToolNames()).toEqual(
				expect.arrayContaining([
					...DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",").filter(
						(name) => name !== "subagent_registry" && name !== "image_gen",
					),
					"remote_extension_tool",
				]),
			);

			await runtime.session.bindExtensions({});

			expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain("remote_dynamic_tool");
			expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(["remote_dynamic_tool"]));
			expect(runtime.session.systemPrompt).toContain("- remote_dynamic_tool: Run remote dynamic test behavior");
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("creates persistent attachable child runtimes for tool-created remote subagents", async () => {
		const faux = registerFauxProvider();
		const model = faux.getModel();
		faux.setResponses([
			// Spawning is two-phase: the first exact request only returns a registry
			// preflight with a one-time confirmation token and starts nothing.
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "scout", task: "Inspect the remote child" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				let token: string | undefined;
				for (let index = context.messages.length - 1; index >= 0; index -= 1) {
					const message = context.messages[index];
					if (message?.role === "toolResult" && message.toolName === "subagent") {
						const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
						token = /"confirm": "([^"]+)"/.exec(text)?.[1];
						break;
					}
				}
				if (!token) {
					throw new Error("expected a subagent spawn confirmation token in the preflight result");
				}
				return fauxAssistantMessage(
					fauxToolCall("subagent", { agent: "scout", task: "Inspect the remote child", confirm: token }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("child finished"),
			fauxAssistantMessage("parent finished"),
		]);
		writeRuntimeModelConfig(
			{
				api: faux.api,
				apiKey: "faux-key",
				baseUrl: "http://localhost:0",
				models: faux.models,
			},
			model.provider,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }, null, 2)}\n`,
		);
		writeAgent(join(agentDir, "agents"), "scout.md", "name: scout\ndescription: Scout child", "Scout prompt");
		const subagentEvents: IrohRemoteSubagentRuntimeCreatedEvent[] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({
				agentDir,
				cwd,
				onSubagentRuntimeCreated: (event) => {
					subagentEvents.push(event);
				},
			});

			await runtime.session.prompt("delegate to scout");

			expect(subagentEvents).toHaveLength(1);
			const child = subagentEvents[0];
			expect(child).toMatchObject({ parentSessionId: runtime.session.sessionId });
			expect(child.parentSessionFile).toBe(runtime.session.sessionFile);
			expect(child.sessionId).toBe(child.runtime.session.sessionId);
			expect(child.runtime.session.sessionFile).toBeTruthy();
			expect(child.runtime.session.getActiveToolNames()).toContain("subagent_registry");
			expect(child.runtime.session.getActiveToolNames()).not.toContain("subagent");
			if (!child.runtime.session.sessionFile) {
				throw new Error("expected child session file");
			}
			const childHeaderLine = readFileSync(child.runtime.session.sessionFile, "utf-8").split("\n")[0];
			if (!childHeaderLine) {
				throw new Error("expected child session header");
			}
			const childHeader = JSON.parse(childHeaderLine) as { parentSession?: string };
			expect(childHeader.parentSession).toBe(runtime.session.sessionFile);
			// The first subagent tool result is the registry preflight; the confirmed
			// spawn's result is the last one.
			const parentToolResult = runtime.session.sessionManager
				.getBranch()
				.filter((entry) => {
					return (
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "subagent"
					);
				})
				.at(-1);
			if (parentToolResult?.type !== "message" || parentToolResult.message.role !== "toolResult") {
				throw new Error("expected parent subagent tool result");
			}
			const details = parentToolResult.message.details as
				| { childSessions?: Array<{ sessionId?: string; subagentId?: string }> }
				| undefined;
			expect(details?.childSessions?.[0]).toMatchObject({
				sessionId: child.sessionId,
				subagentId: child.id,
			});
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
			await subagentEvents[0]?.runtime.dispose().catch(() => undefined);
			faux.unregister();
		}
	});

	it("keeps custom remote tool allowlists strict", async () => {
		writeRuntimeConfig({});
		writeToolExtension();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({ agentDir, allowTools: "read", cwd });
			await runtime.session.bindExtensions({});

			expect(
				runtime.session
					.getAllTools()
					.map((tool) => tool.name)
					.sort(),
			).toEqual(["read"]);
			expect(runtime.session.getActiveToolNames()).toEqual(["read"]);
			expect(runtime.session.systemPrompt).not.toContain("remote_extension_tool");
			expect(runtime.session.systemPrompt).not.toContain("remote_dynamic_tool");
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("preserves an explicit deny-all composed policy", async () => {
		writeRuntimeConfig({});
		writeToolExtension();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({
				agentDir,
				cwd,
				toolPolicy: { tools: [], allowUnlistedExtensionTools: false },
			});
			await runtime.session.bindExtensions({});

			expect(runtime.session.getAllTools()).toEqual([]);
			expect(runtime.session.getActiveToolNames()).toEqual([]);
			expect(runtime.session.systemPrompt).not.toContain("remote_extension_tool");
			expect(runtime.session.systemPrompt).not.toContain("remote_dynamic_tool");
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("loads a requested remote session without dispatching recovery before attach ownership", async () => {
		writeRuntimeConfig({});
		const sessionDir = join(agentDir, "sessions", "remote-workspace");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "2026-06-21T00-00-00-000Z_remote-session.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "remote-session",
				timestamp: "2026-06-21T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const resumeRecoveredInputs = vi.spyOn(AgentSession.prototype, "resumeRecoveredClientInputs").mockResolvedValue();

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			const result = await createIrohRemoteAgentRuntimeWithSessionSelection({
				agentDir,
				cwd,
				resumeSessionId: "remote-session",
				sessionDir,
			});
			runtime = result.runtime;

			expect(result.sessionSelection).toEqual({
				kind: "resumed",
				requestedSessionId: "remote-session",
				sessionFile,
				sessionId: "remote-session",
			});
			expect(runtime.session.sessionId).toBe("remote-session");
			expect(runtime.session.sessionFile).toBe(sessionFile);
			expect(resumeRecoveredInputs).not.toHaveBeenCalled();
		} finally {
			resumeRecoveredInputs.mockRestore();
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("creates a new remote session when the requested resume session is missing", async () => {
		writeRuntimeConfig({});
		const sessionDir = join(agentDir, "sessions", "remote-workspace");
		mkdirSync(sessionDir, { recursive: true });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			const result = await createIrohRemoteAgentRuntimeWithSessionSelection({
				agentDir,
				cwd,
				resumeSessionId: "missing-session",
				sessionDir,
			});
			runtime = result.runtime;

			expect(result.sessionSelection.kind).toBe("created_after_missing");
			if (result.sessionSelection.kind !== "created_after_missing") {
				throw new Error("expected missing-session fallback");
			}
			expect(result.sessionSelection.requestedSessionId).toBe("missing-session");
			expect(result.sessionSelection.sessionId).toBe(runtime.session.sessionId);
			expect(result.sessionSelection.sessionId).not.toBe("missing-session");
			expect(result.sessionSelection.sessionFile).toBe(runtime.session.sessionFile);
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("ignores malformed remembered remote session IDs before lookup", async () => {
		writeRuntimeConfig({});
		const sessionDir = join(agentDir, "sessions", "remote-workspace");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "2026-06-21T00-00-00-000Z_BAD-SESSION.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "BAD-SESSION",
				timestamp: "2026-06-21T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			const result = await createIrohRemoteAgentRuntimeWithSessionSelection({
				agentDir,
				cwd,
				resumeSessionId: "BAD-SESSION",
				sessionDir,
			});
			runtime = result.runtime;

			expect(result.sessionSelection.kind).toBe("created_after_missing");
			if (result.sessionSelection.kind !== "created_after_missing") {
				throw new Error("expected malformed remembered session fallback");
			}
			expect(result.sessionSelection.requestedSessionId).toBe("BAD-SESSION");
			expect(result.sessionSelection.sessionId).toBe(runtime.session.sessionId);
			expect(result.sessionSelection.sessionId).not.toBe("BAD-SESSION");
			expect(runtime.session.sessionId).not.toBe("BAD-SESSION");
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("rejects a strict missing remote session target", async () => {
		writeRuntimeConfig({});
		const sessionDir = join(agentDir, "sessions", "remote-workspace");
		mkdirSync(sessionDir, { recursive: true });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(
				createIrohRemoteAgentRuntimeWithSessionSelection({
					agentDir,
					conversationTarget: { target: "session", sessionId: "missing-session" },
					cwd,
					sessionDir,
				}),
			).rejects.toMatchObject({ outcome: "session_unavailable" });
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("validates HTTP idle timeout settings before creating the runtime", async () => {
		writeRuntimeConfig({ httpIdleTimeoutMs: -1 });

		await expect(createIrohRemoteAgentRuntime({ agentDir, cwd })).rejects.toThrow(
			"Invalid httpIdleTimeoutMs setting: -1",
		);
	});
});
