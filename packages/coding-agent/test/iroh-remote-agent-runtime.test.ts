import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIrohRemoteAgentRuntime } from "../src/modes/rpc/iroh-remote-agent-runtime.ts";

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
