import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../src/core/remote/iroh/index.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import {
	createIrohRemoteAgentRuntime,
	createIrohRemoteAgentRuntimeWithSessionSelection,
} from "../src/modes/rpc/iroh-remote-agent-runtime.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;

describe("createIrohRemoteAgentRuntime", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-iroh-remote-runtime-"));
		cwd = join(tempDir, "workspace");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		for (const key of PROXY_ENV_KEYS) {
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

	function writeRuntimeConfig(settings: Record<string, unknown>): void {
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						"iroh-runtime-test": {
							api: "openai-completions",
							apiKey: "test-key",
							baseUrl: "http://127.0.0.1:9/v1",
							models: [{ id: "fake-runtime", name: "Fake Runtime" }],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
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

	it("applies HTTP proxy settings before creating the runtime", async () => {
		writeRuntimeConfig({ httpProxy: "http://127.0.0.1:7890" });
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
			expect(runtime.session.getActiveToolNames()).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
		} finally {
			errorSpy.mockRestore();
			await runtime?.dispose();
		}
	});

	it("keeps active user extension tools available with the default remote grant", async () => {
		writeRuntimeConfig({});
		writeToolExtension();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		let runtime: Awaited<ReturnType<typeof createIrohRemoteAgentRuntime>> | undefined;
		try {
			runtime = await createIrohRemoteAgentRuntime({ agentDir, cwd });

			expect(runtime.session.getAllTools().map((tool) => tool.name)).toContain("remote_extension_tool");
			expect(runtime.session.getActiveToolNames()).toEqual(
				expect.arrayContaining([...DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","), "remote_extension_tool"]),
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

	it("resumes a requested remote session when its file still exists", async () => {
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
		} finally {
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

	it("validates HTTP idle timeout settings before creating the runtime", async () => {
		writeRuntimeConfig({ httpIdleTimeoutMs: -1 });

		await expect(createIrohRemoteAgentRuntime({ agentDir, cwd })).rejects.toThrow(
			"Invalid httpIdleTimeoutMs setting: -1",
		);
	});
});
