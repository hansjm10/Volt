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

const BUILT_IN_SUBAGENT_NAMES = ["design-doc", "general", "researcher", "security-reviewer"];

function expectedNamesWithBuiltIns(...names: string[]): string[] {
	return [...BUILT_IN_SUBAGENT_NAMES, ...names].sort();
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
		expect(result.definition?.allowedSubagents).toEqual([]);
	});

	it("rejects malformed tool lists instead of inheriting broader tools", () => {
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

		expect(result.definition).toBeNull();
		expect(result.diagnostics).toEqual([
			{ type: "warning", message: "tools must be a comma-separated string", path: filePath },
		]);
	});

	it("parses delegation controls from frontmatter", () => {
		const filePath = join(agentDir, "agents", "non-delegating.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				[
					"name: non-delegating",
					"description: No delegation",
					"excludedTools: subagent, deploy",
					"allowedSubagents: researcher, analyst",
					"maxSubagentDepth: 3",
					"maxChildAgents: 2",
				].join("\n"),
				"No delegation prompt",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.definition?.excludedTools).toEqual(["subagent", "deploy"]);
		expect(result.definition?.allowedSubagents).toEqual(["researcher", "analyst"]);
		expect(result.definition?.maxSubagentDepth).toBe(3);
		expect(result.definition?.maxChildAgents).toBe(2);
	});

	it("parses explicit empty allowedSubagents as no delegated child names", () => {
		const filePath = join(agentDir, "agents", "no-children.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				["name: no-children", "description: No child delegation", "allowedSubagents:"].join("\n"),
				"No child delegation prompt",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.definition?.allowedSubagents).toEqual([]);
	});

	it("parses explicit empty tools as no child tools", () => {
		const filePath = join(agentDir, "agents", "no-tools.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				["name: no-tools", "description: No child tools", "tools:"].join("\n"),
				"No tool prompt",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.definition?.tools).toEqual([]);
	});

	it("rejects malformed delegation controls instead of allowing unrestricted delegation", () => {
		const filePath = join(agentDir, "agents", "bad-delegation.md");
		const result = parseSubagentDefinition({
			content: agentMarkdown(
				[
					"name: bad-delegation",
					"description: Bad delegation",
					"allowedSubagents:",
					"  - researcher",
					"maxSubagentDepth: -1",
					"maxChildAgents: many",
				].join("\n"),
				"Still valid prompt",
			),
			filePath,
			source: "user",
			sourceInfo: sourceInfo(filePath, "user"),
		});

		expect(result.definition).toBeNull();
		expect(result.diagnostics).toEqual([
			{ type: "warning", message: "allowedSubagents must be a comma-separated string", path: filePath },
			{ type: "warning", message: "maxSubagentDepth must be a non-negative integer", path: filePath },
			{ type: "warning", message: "maxChildAgents must be a non-negative integer", path: filePath },
		]);
	});

	it("returns the built-in subagent definitions when no files are present", () => {
		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });
		const general = result.definitions.find((definition) => definition.name === "general");
		const researcher = result.definitions.find((definition) => definition.name === "researcher");
		const designDoc = result.definitions.find((definition) => definition.name === "design-doc");
		const securityReviewer = result.definitions.find((definition) => definition.name === "security-reviewer");
		expect(result.definitions.map((definition) => definition.name).sort()).toEqual(BUILT_IN_SUBAGENT_NAMES);
		expect(general).toMatchObject({
			name: "general",
			description: "General-purpose isolated child agent for ad hoc delegated tasks",
			source: "built-in",
			filePath: "builtin:general",
			sourceInfo: { source: "built-in", scope: "temporary", origin: "top-level" },
		});
		expect(general?.tools).toBeUndefined();
		expect(general?.excludedTools).toEqual(["subagent"]);
		expect(general?.allowedSubagents).toEqual([]);
		expect(general?.maxChildAgents).toBe(0);
		expect(general?.systemPrompt).toContain("general-purpose Volt subagent");
		expect(researcher).toMatchObject({
			allowedSubagents: ["researcher"],
			maxSubagentDepth: 3,
			maxChildAgents: 2,
		});
		expect(researcher?.tools).toContain("subagent");
		expect(researcher?.tools).toContain("subagent_registry");
		expect(researcher?.tools).not.toContain("bash");
		expect(researcher?.tools).not.toContain("lsp");
		expect(researcher?.systemPrompt).toContain(
			"Follow any applicable delegation policy; otherwise remain local-first.",
		);
		expect(researcher?.systemPrompt).not.toContain("base policy");
		expect(researcher?.systemPrompt).not.toContain("would benefit from a fresh, narrower researcher context");
		expect(designDoc).toMatchObject({
			description: "Design document planner and synthesizer for sourced technical decisions",
			allowedSubagents: ["researcher", "security-reviewer", "general"],
			maxSubagentDepth: 3,
			maxChildAgents: 8,
		});
		expect(designDoc?.tools).toBeUndefined();
		expect(designDoc?.systemPrompt).toContain(
			"Follow any applicable delegation policy; otherwise remain local-first.",
		);
		expect(designDoc?.systemPrompt).not.toContain("base delegation policy");
		expect(designDoc?.systemPrompt).not.toContain("use 2-4 children");
		expect(designDoc?.systemPrompt).not.toContain("Use the subagent tool for broad or uncertain work");
		expect(securityReviewer).toMatchObject({
			allowedSubagents: ["researcher"],
			maxSubagentDepth: 3,
			maxChildAgents: 4,
		});
		expect(securityReviewer?.tools).toContain("subagent");
		expect(securityReviewer?.tools).toContain("subagent_registry");
		expect(securityReviewer?.tools).not.toContain("bash");
		expect(securityReviewer?.tools).not.toContain("lsp");
		expect(securityReviewer?.tools).not.toContain("write");
		expect(securityReviewer?.systemPrompt).toContain(
			"Follow any applicable delegation policy; otherwise remain local-first.",
		);
		expect(securityReviewer?.systemPrompt).not.toContain("base policy");
		expect(securityReviewer?.systemPrompt).not.toContain("when it improves coverage");
		expect(result.diagnostics).toEqual([]);
		expect(result.userAgentsDir).toBe(join(agentDir, "agents"));
		expect(result.projectAgentsDir).toBe(join(cwd, ".volt", "agents"));
	});

	it("ignores file definitions that try to override built-in names", () => {
		const userDir = join(agentDir, "agents");
		const userPath = writeAgent(
			userDir,
			"general.md",
			"name: general\ndescription: User general",
			"User general prompt",
		);

		const result = discoverSubagentDefinitions({ cwd, agentDir, projectTrusted: true });
		const general = result.definitions.find((definition) => definition.name === "general");

		expect(result.diagnostics).toEqual([
			{
				type: "warning",
				message: 'subagent definition "general" cannot override a built-in subagent and was ignored',
				path: userPath,
			},
		]);
		expect(general).toMatchObject({
			name: "general",
			description: "General-purpose isolated child agent for ad hoc delegated tasks",
			source: "built-in",
			filePath: "builtin:general",
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
		expect(result.definitions.map((definition) => definition.name).sort()).toEqual(
			expectedNamesWithBuiltIns("planner", "scout"),
		);
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

		expect(untrusted.definitions.map((definition) => definition.name).sort()).toEqual(
			expectedNamesWithBuiltIns("scout"),
		);
		expect(untrusted.diagnostics).toEqual([]);
		expect(trusted.definitions.map((definition) => definition.name).sort()).toEqual(
			expectedNamesWithBuiltIns("planner", "scout"),
		);
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

		expect(result.definitions.map((definition) => definition.name).sort()).toEqual(
			expectedNamesWithBuiltIns("valid"),
		);
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

		expect(result.definitions.map((definition) => definition.name).sort()).toEqual(BUILT_IN_SUBAGENT_NAMES);
		expect(result.definitions.every((definition) => definition.source === "built-in")).toBe(true);
		expect(result.projectAgentsDir).toBe(join(nestedCwd, ".volt", "agents"));
	});
});
