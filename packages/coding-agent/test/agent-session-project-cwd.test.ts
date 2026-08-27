import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("AgentSession projectCwd propagation", () => {
	it("keeps a remote-style nested runtime cwd separate from the canonical LSP workspace across reload", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-agent-project-cwd-"));
		tempDirs.push(root);
		const projectCwd = join(root, "workspace");
		const runtimeCwd = join(projectCwd, "packages", "app");
		const agentDir = join(root, "agent");
		mkdirSync(runtimeCwd, { recursive: true });
		mkdirSync(agentDir);
		const settingsManager = SettingsManager.inMemory({ lsp: { enabled: true } });
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			projectCwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(runtimeCwd),
		});
		try {
			expect(services.cwd).toBe(runtimeCwd);
			expect(services.projectCwd).toBe(realpathSync(projectCwd));
			expect(session.getLspStatus()).toMatchObject({
				enabled: true,
				workspaceRoot: realpathSync(projectCwd),
			});

			await session.reload();
			expect(session.getLspStatus()).toMatchObject({
				enabled: true,
				workspaceRoot: realpathSync(projectCwd),
				servers: [],
			});
		} finally {
			session.dispose();
			await session.waitForClosed();
		}
	});
});
