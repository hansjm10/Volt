import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../source-info.ts";

export type SubagentDefinitionSource = "built-in" | "user" | "project";
export type FileSubagentDefinitionSource = Exclude<SubagentDefinitionSource, "built-in">;

export interface SubagentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: SubagentDefinitionSource;
	sourceInfo: SourceInfo;
	filePath: string;
}

export interface ParseSubagentDefinitionOptions {
	content: string;
	filePath: string;
	source: FileSubagentDefinitionSource;
	sourceInfo: SourceInfo;
}

export interface ParseSubagentDefinitionResult {
	definition: SubagentDefinition | null;
	diagnostics: ResourceDiagnostic[];
}

export interface DiscoverSubagentDefinitionsOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

export interface SubagentDiscoveryResult {
	definitions: SubagentDefinition[];
	diagnostics: ResourceDiagnostic[];
	userAgentsDir: string;
	projectAgentsDir: string;
}

const BUILT_IN_GENERAL_SUBAGENT_FILE_PATH = "builtin:general";

export function createBuiltInSubagentDefinitions(): SubagentDefinition[] {
	return [
		{
			name: "general",
			description: "General-purpose isolated child agent for ad hoc delegated tasks",
			systemPrompt: [
				"You are the built-in general-purpose Volt subagent.",
				"Complete the delegated task independently using only the task prompt and available tools.",
				"For code or research tasks, return concise findings, evidence, blockers, and next steps.",
				"For writing or creative tasks, return the requested artifact directly.",
				"Do not assume parent conversation context beyond the delegated task prompt.",
			].join("\n"),
			source: "built-in",
			sourceInfo: createSyntheticSourceInfo(BUILT_IN_GENERAL_SUBAGENT_FILE_PATH, { source: "built-in" }),
			filePath: BUILT_IN_GENERAL_SUBAGENT_FILE_PATH,
		},
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function readRequiredStringField(
	frontmatter: Record<string, unknown>,
	key: "name" | "description",
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string | undefined {
	const value = frontmatter[key];
	if (typeof value !== "string" || value.trim() === "") {
		diagnostics.push({ type: "warning", message: `${key} is required`, path: filePath });
		return undefined;
	}
	return value.trim();
}

function readOptionalStringField(
	frontmatter: Record<string, unknown>,
	key: "model" | "thinking",
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string | undefined {
	const value = frontmatter[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		diagnostics.push({ type: "warning", message: `${key} must be a string`, path: filePath });
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readToolsField(
	frontmatter: Record<string, unknown>,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string[] | undefined {
	const value = frontmatter.tools;
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		diagnostics.push({ type: "warning", message: "tools must be a comma-separated string", path: filePath });
		return undefined;
	}

	const tools = value
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	return tools.length > 0 ? tools : undefined;
}

export function parseSubagentDefinition(options: ParseSubagentDefinitionOptions): ParseSubagentDefinitionResult {
	const diagnostics: ResourceDiagnostic[] = [];
	let frontmatter: Record<string, unknown>;
	let body: string;

	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(options.content);
		if (!isRecord(parsed.frontmatter)) {
			diagnostics.push({ type: "warning", message: "frontmatter must be a mapping", path: options.filePath });
			return { definition: null, diagnostics };
		}
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: `failed to parse subagent definition: ${getErrorMessage(error, "invalid frontmatter")}`,
			path: options.filePath,
		});
		return { definition: null, diagnostics };
	}

	const name = readRequiredStringField(frontmatter, "name", options.filePath, diagnostics);
	const description = readRequiredStringField(frontmatter, "description", options.filePath, diagnostics);
	const systemPrompt = body.trim();
	if (systemPrompt.length === 0) {
		diagnostics.push({ type: "warning", message: "system prompt body is required", path: options.filePath });
	}

	const tools = readToolsField(frontmatter, options.filePath, diagnostics);
	const model = readOptionalStringField(frontmatter, "model", options.filePath, diagnostics);
	const thinking = readOptionalStringField(frontmatter, "thinking", options.filePath, diagnostics);

	if (!name || !description || systemPrompt.length === 0) {
		return { definition: null, diagnostics };
	}

	return {
		definition: {
			name,
			description,
			...(tools ? { tools } : {}),
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			systemPrompt,
			source: options.source,
			sourceInfo: options.sourceInfo,
			filePath: options.filePath,
		},
		diagnostics,
	};
}

function createSubagentSourceInfo(
	filePath: string,
	agentsDir: string,
	source: FileSubagentDefinitionSource,
): SourceInfo {
	return createSyntheticSourceInfo(filePath, {
		source: "local",
		scope: source,
		baseDir: agentsDir,
	});
}

function loadSubagentDefinitionsFromDir(
	dir: string,
	source: FileSubagentDefinitionSource,
): { definitions: SubagentDefinition[]; diagnostics: ResourceDiagnostic[] } {
	const definitions: SubagentDefinition[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { definitions, diagnostics };
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: getErrorMessage(error, "failed to read subagent directory"),
			path: dir,
		});
		return { definitions, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) {
			continue;
		}

		const filePath = join(dir, entry.name);
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(filePath).isFile();
			} catch (error) {
				diagnostics.push({
					type: "warning",
					message: getErrorMessage(error, "failed to read subagent symlink"),
					path: filePath,
				});
				continue;
			}
		}

		if (!isFile) {
			continue;
		}

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: getErrorMessage(error, "failed to read subagent definition"),
				path: filePath,
			});
			continue;
		}

		const result = parseSubagentDefinition({
			content,
			filePath,
			source,
			sourceInfo: createSubagentSourceInfo(filePath, dir, source),
		});
		if (result.definition) {
			definitions.push(result.definition);
		}
		diagnostics.push(...result.diagnostics);
	}

	return { definitions, diagnostics };
}

export function discoverSubagentDefinitions(options: DiscoverSubagentDefinitionsOptions): SubagentDiscoveryResult {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const userAgentsDir = join(resolvedAgentDir, "agents");
	const projectAgentsDir = join(resolvedCwd, CONFIG_DIR_NAME, "agents");

	const diagnostics: ResourceDiagnostic[] = [];
	const definitionsByName = new Map<string, SubagentDefinition>();
	const seenBySource = new Set<string>();

	function addDefinitions(definitions: SubagentDefinition[]): void {
		for (const definition of definitions) {
			const sourceKey = `${definition.source}:${definition.name}`;
			if (seenBySource.has(sourceKey)) {
				diagnostics.push({
					type: "warning",
					message: `duplicate ${definition.source} subagent definition "${definition.name}" ignored`,
					path: definition.filePath,
				});
				continue;
			}
			seenBySource.add(sourceKey);
			definitionsByName.set(definition.name, definition);
		}
	}

	addDefinitions(createBuiltInSubagentDefinitions());

	const userResult = loadSubagentDefinitionsFromDir(userAgentsDir, "user");
	addDefinitions(userResult.definitions);
	diagnostics.push(...userResult.diagnostics);

	if (options.projectTrusted) {
		const projectResult = loadSubagentDefinitionsFromDir(projectAgentsDir, "project");
		addDefinitions(projectResult.definitions);
		diagnostics.push(...projectResult.diagnostics);
	}

	return {
		definitions: Array.from(definitionsByName.values()),
		diagnostics,
		userAgentsDir,
		projectAgentsDir,
	};
}

export {
	SubagentDefinitionConfigurationError,
	SubagentDefinitionNotFoundError,
	type SubagentEndEvent,
	type SubagentEvent,
	type SubagentEventListener,
	type SubagentHandle,
	SubagentManager,
	type SubagentManagerOptions,
	type SubagentResult,
	type SubagentStartByNameOptions,
	type SubagentStartOptions,
} from "./manager.ts";
