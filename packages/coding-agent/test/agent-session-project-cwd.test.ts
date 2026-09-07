import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDirectorySymlinkSync } from "./symlink-utils.ts";

const FAKE_SERVER = join(__dirname, "fixtures", "fake-lsp-server.mjs");
const tempDirs: string[] = [];

function createLspSettingsManager(): SettingsManager {
	return SettingsManager.inMemory({
		lsp: {
			enabled: true,
			idleShutdownMs: 0,
			servers: {
				typescript: { enabled: false },
				python: { enabled: false },
				go: { enabled: false },
				rust: { enabled: false },
				fake: {
					command: [process.execPath, FAKE_SERVER],
					fileExtensions: [".foo"],
					rootMarkers: [],
				},
			},
		},
	});
}

function createSymlinkedProject():
	| { root: string; projectCwd: string; runtimeCwd: string; siblingFile: string; agentDir: string }
	| undefined {
	const root = mkdtempSync(join(tmpdir(), "volt-agent-project-cwd-alias-"));
	tempDirs.push(root);
	const realProjectCwd = join(root, "real-workspace");
	const projectCwd = join(root, "workspace-alias");
	const realRuntimeCwd = join(realProjectCwd, "packages", "app");
	const runtimeCwd = join(projectCwd, "packages", "app");
	const siblingFile = join(projectCwd, "packages", "shared", "test.foo");
	const agentDir = join(root, "agent");
	mkdirSync(realRuntimeCwd, { recursive: true });
	mkdirSync(join(realProjectCwd, "packages", "shared"), { recursive: true });
	mkdirSync(agentDir);
	writeFileSync(join(realProjectCwd, "packages", "shared", "test.foo"), "has ERROR\n");
	try {
		createDirectorySymlinkSync(realProjectCwd, projectCwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return undefined;
		throw error;
	}
	return { root, projectCwd, runtimeCwd, siblingFile, agentDir };
}

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
			expect(services.projectCwd).toBe(realpathSync.native(projectCwd));
			expect(session.getLspStatus()).toMatchObject({
				enabled: true,
				workspaceRoot: realpathSync.native(projectCwd),
			});

			await session.reload();
			expect(session.getLspStatus()).toMatchObject({
				enabled: true,
				workspaceRoot: realpathSync.native(projectCwd),
				servers: [],
			});
		} finally {
			session.dispose();
			await session.waitForClosed();
		}
	});

	it("preserves a lexical project-root alias through session services and reload", async () => {
		const paths = createSymlinkedProject();
		if (!paths) return;
		const settingsManager = createLspSettingsManager();
		const services = await createAgentSessionServices({
			cwd: paths.runtimeCwd,
			projectCwd: paths.projectCwd,
			agentDir: paths.agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(paths.runtimeCwd),
		});
		try {
			const tool = session.getToolDefinition("lsp");
			expect(tool).toBeDefined();
			const first = await tool!.execute(
				"lsp-alias-before-reload",
				{ action: "diagnostics", path: paths.siblingFile },
				undefined,
				undefined,
				{} as never,
			);
			expect(first.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("error: found ERROR on line 1") }),
			]);
			expect(session.getLspStatus().workspaceRoot).toBe(realpathSync.native(paths.projectCwd));

			await session.reload();
			const reloadedTool = session.getToolDefinition("lsp");
			const second = await reloadedTool!.execute(
				"lsp-alias-after-reload",
				{ action: "diagnostics", path: paths.siblingFile },
				undefined,
				undefined,
				{} as never,
			);
			expect(second.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("error: found ERROR on line 1") }),
			]);
		} finally {
			session.dispose();
			await session.waitForClosed();
		}
	});

	it("preserves a lexical project-root alias through the SDK construction path", async () => {
		const paths = createSymlinkedProject();
		if (!paths) return;
		const { session } = await createAgentSession({
			cwd: paths.runtimeCwd,
			projectCwd: paths.projectCwd,
			agentDir: paths.agentDir,
			settingsManager: createLspSettingsManager(),
			sessionManager: SessionManager.inMemory(paths.runtimeCwd),
			disableMcp: true,
		});
		try {
			const tool = session.getToolDefinition("lsp");
			expect(tool).toBeDefined();
			const result = await tool!.execute(
				"lsp-sdk-alias",
				{ action: "diagnostics", path: paths.siblingFile },
				undefined,
				undefined,
				{} as never,
			);
			expect(result.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("error: found ERROR on line 1") }),
			]);
			expect(session.getLspStatus().workspaceRoot).toBe(realpathSync.native(paths.projectCwd));
		} finally {
			session.dispose();
			await session.waitForClosed();
		}
	});
});
