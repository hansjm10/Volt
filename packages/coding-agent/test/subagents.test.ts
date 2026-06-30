import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	discoverSubagentDefinitions,
	type FileSubagentDefinitionSource,
	parseSubagentDefinition,
} from "../src/core/subagents/index.ts";

function agentMarkdown(frontmatter: string, body: string): string {
	return `---\n${frontmatter}\n---\n\n${body}`;
}

function writeAgent(dir: string, filename: string, frontmatter: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, filename);
	writeFileSync(filePath, agentMarkdown(frontmatter, body));
	return filePath;
}

function sourceInfo(filePath: string, source: FileSubagentDefinitionSource) {
	return createSyntheticSourceInfo(filePath, {
		source: "local",
		scope: source,
		baseDir: join(filePath, ".."),
	});
}

describe("subagent definitions", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `subagents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses markdown frontmatter and body", () => {
		const filePath = join(agentDir, "agents", "scout.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				"name: scout\ndescription: Fast codebase recon\ntools: read, grep, find, ls\nmodel: claude-haiku-4-5\nthinking: off",
				"You are a scout.\n\nFind relevant files.",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.definition).toMatchObject({
			name: "scout",
			description: "Fast codebase recon",
			tools: ["read", "grep", "find", "ls"],
			model: "claude-haiku-4-5",
			thinking: "off",
			systemPrompt: "You are a scout.\n\nFind relevant files.",
			source: "user",
			filePath,
		});
		expect(result.definition?.sourceInfo.scope).toBe("user");
	});

	it("reports malformed tool lists without dropping otherwise valid definitions", () => {
		const filePath = join(agentDir, "agents", "bad-tools.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				"name: bad-tools\ndescription: Bad tools\ntools:\n  - read\n  - grep",
				"Still valid prompt",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.definition).toMatchObject({ name: "bad-tools" });
		expect(result.definition?.tools).toBeUndefined();
		expect(result.diagnostics).toEqual([
			{ type: "warning", message: "tools must be a comma-separated string", path: filePath },
		]);
	});

	it("returns the built-in general definition when no files are present", () => {
		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });

		expect(result.definitions).toHaveLength(1);
		expect(result.definitions[0]).toMatchObject({
			name: "general",
			description: "General-purpose isolated child agent for ad hoc delegated tasks",
			source: "built-in",
			filePath: "builtin:general",
			sourceInfo: { source: "built-in", scope: "temporary", origin: "top-level" },
		});
		expect(result.definitions[0]?.systemPrompt).toContain("general-purpose Volt subagent");
		expect(result.diagnostics).toEqual([]);
		expect(result.userAgentsDir).toBe(join(agentDir, "agents"));
		expect(result.projectAgentsDir).toBe(join(cwd, ".volt", "agents"));
	});

	it("lets file definitions override the built-in general definition", () => {
		const userDir = join(agentDir, "agents");
		writeAgent(userDir, "general.md", "name: general\ndescription: User general", "User general prompt");

		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });
		const general = result.definitions.find((definition) => definition.name === "general");

		expect(result.diagnostics).toEqual([]);
		expect(general).toMatchObject({
			name: "general",
			description: "User general",
			systemPrompt: "User general prompt",
			source: "user",
		});
	});

	it("discovers user and trusted project definitions", () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User scout prompt");
		writeAgent(projectDir, "planner.md", "name: planner\ndescription: Project planner", "Project planner prompt");

		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });

		expect(result.userAgentsDir).toBe(userDir);
		expect(result.projectAgentsDir).toBe(projectDir);
		expect(result.diagnostics).toEqual([]);
		expect(result.definitions.map((definition) => definition.name).sort()).toEqual(["general", "planner", "scout"]);
		expect(result.definitions.find((definition) => definition.name === "scout")?.source).toBe("user");
		expect(result.definitions.find((definition) => definition.name === "planner")?.sourceInfo.scope).toBe("project");
	});

	it("loads project definitions only when project trust is active", () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User scout prompt");
		writeAgent(projectDir, "planner.md", "name: planner\ndescription: Project planner", "Project planner prompt");
		writeFileSync(join(projectDir, "invalid.md"), "---\nname: [bad\n---\nBody");

		const untrusted = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: false });
		const trusted = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });

		expect(untrusted.definitions.map((definition) => definition.name)).toEqual(["general", "scout"]);
		expect(untrusted.diagnostics).toEqual([]);
		expect(trusted.definitions.map((definition) => definition.name).sort()).toEqual(["general", "planner", "scout"]);
		expect(trusted.diagnostics.some((diagnostic) => diagnostic.path === join(projectDir, "invalid.md"))).toBe(true);
	});

	it("keeps user definitions when an untrusted project defines the same name", () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User scout prompt");
		writeAgent(projectDir, "scout.md", "name: scout\ndescription: Project scout", "Project scout prompt");

		const untrusted = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: false });
		const trusted = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });

		expect(untrusted.definitions.find((definition) => definition.name === "scout")).toMatchObject({
			name: "scout",
			description: "User scout",
			source: "user",
		});
		expect(trusted.definitions.find((definition) => definition.name === "scout")).toMatchObject({
			name: "scout",
			description: "Project scout",
			source: "project",
		});
	});

	it("lets project definitions override user definitions by name", () => {
		const userDir = join(agentDir, "agents");
		const projectDir = join(cwd, ".volt", "agents");
		const userPath = writeAgent(userDir, "scout.md", "name: scout\ndescription: User scout", "User scout prompt");
		const projectPath = writeAgent(
			projectDir,
			"scout.md",
			"name: scout\ndescription: Project scout\ntools: read",
			"Project scout prompt",
		);

		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });
		const scout = result.definitions.find((definition) => definition.name === "scout");

		expect(result.diagnostics).toEqual([]);
		expect(scout?.filePath).toBe(projectPath);
		expect(scout?.filePath).not.toBe(userPath);
		expect(scout?.description).toBe("Project scout");
		expect(scout?.source).toBe("project");
		expect(scout?.tools).toEqual(["read"]);
	});

	it("reports invalid definitions as diagnostics without aborting discovery", () => {
		const userDir = join(agentDir, "agents");
		writeAgent(userDir, "valid.md", "name: valid\ndescription: Valid agent", "Valid prompt");
		writeFileSync(join(userDir, "bad-yaml.md"), "---\nname: [bad\n---\nPrompt");
		writeFileSync(join(userDir, "missing-description.md"), agentMarkdown("name: missing-description", "Prompt"));
		writeFileSync(
			join(userDir, "missing-body.md"),
			agentMarkdown("name: missing-body\ndescription: Missing body", ""),
		);

		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });

		expect(result.definitions.map((definition) => definition.name)).toEqual(["general", "valid"]);
		expect(result.diagnostics).toHaveLength(3);
		expect(result.diagnostics.map((diagnostic) => diagnostic.path).sort()).toEqual([
			join(userDir, "bad-yaml.md"),
			join(userDir, "missing-body.md"),
			join(userDir, "missing-description.md"),
		]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
			"description is required",
		);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
			"system prompt body is required",
		);
	});

	it("does not search ancestor project agent directories", () => {
		const nestedCwd = join(cwd, "packages", "app");
		mkdirSync(nestedCwd, { recursive: true });
		writeAgent(join(cwd, ".volt", "agents"), "root.md", "name: root\ndescription: Root project", "Root prompt");

		const result = discoverSubagentDefinitions({ cwd: nestedCwd, agentDir, projectTrusted: true });

		expect(result.definitions).toMatchObject([{ name: "general", source: "built-in" }]);
		expect(result.projectAgentsDir).toBe(join(nestedCwd, ".volt", "agents"));
	});
});
