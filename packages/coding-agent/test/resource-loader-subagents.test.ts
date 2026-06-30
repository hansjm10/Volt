import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function agentMarkdown(frontmatter: string, body: string): string {
	return `---\n${frontmatter}\n---\n\n${body}`;
}

function writeAgent(dir: string, filename: string, frontmatter: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, filename);
	writeFileSync(filePath, agentMarkdown(frontmatter, body));
	return filePath;
}

describe("DefaultResourceLoader subagents", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `resource-loader-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads user and trusted project subagents during reload", async () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		const userPath = writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User prompt");
		const projectPath = writeAgent(
			projectDir,
			"planner.md",
			"name: planner\ndescription: Project planner\ntools: read, grep",
			"Project prompt",
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { definitions, diagnostics } = loader.getSubagents();
		expect(diagnostics).toEqual([]);
		expect(definitions.map((definition) => definition.name).sort()).toEqual(["general", "planner", "scout"]);
		expect(definitions.find((definition) => definition.name === "general")).toMatchObject({
			filePath: "builtin:general",
			source: "built-in",
			sourceInfo: { scope: "temporary", source: "built-in" },
		});
		expect(definitions.find((definition) => definition.name === "scout")).toMatchObject({
			filePath: userPath,
			source: "user",
			sourceInfo: { scope: "user", source: "local", baseDir: userDir },
		});
		expect(definitions.find((definition) => definition.name === "planner")).toMatchObject({
			filePath: projectPath,
			source: "project",
			tools: ["read", "grep"],
			sourceInfo: { scope: "project", source: "local", baseDir: projectDir },
		});
	});

	it("gates project subagents on project trust", async () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User prompt");
		writeAgent(projectDir, "planner.md", "name: planner\ndescription: Project planner", "Project prompt");
		writeFileSync(join(projectDir, "invalid.md"), "---\nname: [bad\n---\nProject prompt");

		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		const untrusted = loader.getSubagents();
		expect(untrusted.definitions.map((definition) => definition.name)).toEqual(["general", "scout"]);
		expect(untrusted.diagnostics).toEqual([]);

		settingsManager.setProjectTrusted(true);
		await loader.reload();

		const trusted = loader.getSubagents();
		expect(trusted.definitions.map((definition) => definition.name).sort()).toEqual(["general", "planner", "scout"]);
		expect(trusted.diagnostics.some((diagnostic) => diagnostic.path === join(projectDir, "invalid.md"))).toBe(true);
	});

	it("exposes subagent diagnostics from discovery", async () => {
		const userDir = join(agentDir, "agents");
		writeAgent(userDir, "valid.md", "name: valid\ndescription: Valid agent", "Valid prompt");
		writeFileSync(join(userDir, "missing-description.md"), agentMarkdown("name: broken", "Broken prompt"));
		writeFileSync(join(userDir, "missing-body.md"), agentMarkdown("name: empty\ndescription: Empty body", ""));

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { definitions, diagnostics } = loader.getSubagents();
		expect(definitions.map((definition) => definition.name)).toEqual(["general", "valid"]);
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics.map((diagnostic) => diagnostic.message).sort()).toEqual([
			"description is required",
			"system prompt body is required",
		]);
	});

	it("refreshes subagents on reload", async () => {
		const userDir = join(agentDir, "agents");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: First scout", "First prompt");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getSubagents().definitions.find((definition) => definition.name === "scout")).toMatchObject({
			name: "scout",
			description: "First scout",
		});

		writeAgent(userDir, "planner.md", "name: planner\ndescription: Planner", "Planner prompt");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: Updated scout", "Updated prompt");
		await loader.reload();

		const definitions = loader.getSubagents().definitions;
		expect(definitions.map((definition) => definition.name).sort()).toEqual(["general", "planner", "scout"]);
		expect(definitions.find((definition) => definition.name === "scout")?.description).toBe("Updated scout");
		expect(definitions.find((definition) => definition.name === "scout")?.systemPrompt).toBe("Updated prompt");
	});
});
