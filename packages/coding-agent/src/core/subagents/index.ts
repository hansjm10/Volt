import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../source-info.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "./tool-names.ts";

export type SubagentDefinitionSource = "built-in" | "user" | "project";
export type FileSubagentDefinitionSource = Exclude<SubagentDefinitionSource, "built-in">;

export interface SubagentDefinition {
	name: string;
	description: string;
	tools?: string[];
	excludedTools?: string[];
	allowedSubagents?: string[];
	maxSubagentDepth?: number;
	maxChildAgents?: number;
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
const BUILT_IN_RESEARCHER_SUBAGENT_FILE_PATH = "builtin:researcher";
const BUILT_IN_DESIGN_DOC_SUBAGENT_FILE_PATH = "builtin:design-doc";
const BUILT_IN_SECURITY_REVIEWER_SUBAGENT_FILE_PATH = "builtin:security-reviewer";
const BUILT_IN_READ_ONLY_TOOLS = ["read", "web_search", "web_fetch", "grep", "find", "ls"];
const BUILT_IN_DELEGATING_READ_ONLY_TOOLS = [...BUILT_IN_READ_ONLY_TOOLS, "subagent", SUBAGENT_REGISTRY_TOOL_NAME];

export function createBuiltInSubagentDefinitions(): SubagentDefinition[] {
	return [
		{
			name: "general",
			description: "General-purpose isolated child agent for ad hoc delegated tasks",
			excludedTools: ["subagent"],
			allowedSubagents: [],
			maxChildAgents: 0,
			systemPrompt: [
				"You are the built-in general-purpose Volt subagent.",
				"Complete the delegated task independently using only the task prompt and available tools.",
				"You are one contributor in a larger workflow, not the final decision-maker.",
				"Do not delegate to other subagents; the subagent tool is intentionally unavailable for this role.",
				"For code or research tasks, return concise findings, evidence, blockers, and next steps.",
				"For writing or creative tasks, return the requested artifact directly.",
				"Do not assume parent conversation context beyond the delegated task prompt.",
			].join("\n"),
			source: "built-in",
			sourceInfo: createSyntheticSourceInfo(BUILT_IN_GENERAL_SUBAGENT_FILE_PATH, { source: "built-in" }),
			filePath: BUILT_IN_GENERAL_SUBAGENT_FILE_PATH,
		},
		{
			name: "researcher",
			description: "Non-mutating research scout for web and codebase evidence gathering",
			tools: [...BUILT_IN_DELEGATING_READ_ONLY_TOOLS],
			allowedSubagents: ["researcher"],
			maxSubagentDepth: 3,
			maxChildAgents: 2,
			systemPrompt: [
				"You are the built-in Volt researcher subagent.",
				"Gather source-backed evidence from the web and/or codebase for the delegated question.",
				"You are one contributor in a larger workflow, not the final decision-maker.",
				"Do not modify files or run shell commands; this role has non-mutating local tools plus web_search.",
				"Use the subagent tool only when you discover a distinct follow-up question that would benefit from a fresh, narrower researcher context.",
				"Delegate only to researcher subagents and keep recursive research bounded.",
				"Return concise findings with source URLs or file paths, assumptions, uncertainty, and open questions.",
			].join("\n"),
			source: "built-in",
			sourceInfo: createSyntheticSourceInfo(BUILT_IN_RESEARCHER_SUBAGENT_FILE_PATH, { source: "built-in" }),
			filePath: BUILT_IN_RESEARCHER_SUBAGENT_FILE_PATH,
		},
		{
			name: "design-doc",
			description: "Design document planner and synthesizer that delegates independent research when warranted",
			allowedSubagents: ["researcher", "security-reviewer", "general"],
			maxSubagentDepth: 3,
			maxChildAgents: 8,
			systemPrompt: [
				"You are the built-in Volt design-document coordinator.",
				"Your job is to turn an ambiguous technical goal into a sourced design/RFC, decision memo, or implementation plan.",
				"Use the subagent tool for broad or uncertain work that benefits from independent product, architecture, migration, operations, security, performance, prior-art, or skeptical review research before synthesis.",
				"Scale delegation to complexity: handle simple questions directly, use 1 child for one focused gap, use 2-4 children for independent medium-sized questions, and exceed 4 only for genuinely broad work with non-overlapping assignments.",
				"Do not delegate duplicate work, and stop spawning once the available evidence is sufficient to make the design decision.",
				"Prefer parallel delegation for independent research questions and chain delegation only when later steps depend on prior output.",
				"Preserve minority reports and unresolved objections; do not collapse disagreement into false consensus.",
				"When external or current claims matter, perform or delegate web research and cite source URLs.",
				"When editing files, keep changes scoped to the requested design artifact unless the parent task explicitly asks for code changes.",
				"Return or write a structured document with context, goals, non-goals, proposal, alternatives, risks, rollout, verification, and open questions.",
			].join("\n"),
			source: "built-in",
			sourceInfo: createSyntheticSourceInfo(BUILT_IN_DESIGN_DOC_SUBAGENT_FILE_PATH, { source: "built-in" }),
			filePath: BUILT_IN_DESIGN_DOC_SUBAGENT_FILE_PATH,
		},
		{
			name: "security-reviewer",
			description:
				"Non-mutating security review coordinator for threat modeling, code review, and verification planning",
			tools: [...BUILT_IN_DELEGATING_READ_ONLY_TOOLS],
			allowedSubagents: ["researcher"],
			maxSubagentDepth: 3,
			maxChildAgents: 4,
			systemPrompt: [
				"You are the built-in Volt security-reviewer subagent.",
				"Analyze code, design, dependencies, configuration, and agent/tool workflows for security risk.",
				"You are one contributor in a larger workflow, not the final decision-maker.",
				"Do not edit files, write files, run shell commands, or invoke mutating refactors; this role has non-mutating local tools plus web_search and bounded read-only delegation.",
				"Use researcher subagents for independent research or second-opinion review when it improves coverage, but keep delegation bounded and evidence-focused.",
				"For exploit verification or regression tests that require file writes or shell commands, return a precise test plan for the parent to authorize outside this read-only role.",
				"Report findings with file paths, severity, exploit preconditions, evidence, confidence, remediation, and verification steps.",
			].join("\n"),
			source: "built-in",
			sourceInfo: createSyntheticSourceInfo(BUILT_IN_SECURITY_REVIEWER_SUBAGENT_FILE_PATH, { source: "built-in" }),
			filePath: BUILT_IN_SECURITY_REVIEWER_SUBAGENT_FILE_PATH,
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

function readCommaSeparatedListField(
	frontmatter: Record<string, unknown>,
	key: "tools" | "excludedTools",
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string[] | undefined {
	if (!Object.hasOwn(frontmatter, key)) {
		return undefined;
	}
	const value = frontmatter[key];
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value !== "string") {
		diagnostics.push({ type: "warning", message: `${key} must be a comma-separated string`, path: filePath });
		return undefined;
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function readAllowedSubagentsField(
	frontmatter: Record<string, unknown>,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): string[] | undefined {
	if (!Object.hasOwn(frontmatter, "allowedSubagents")) {
		return undefined;
	}
	const value = frontmatter.allowedSubagents;
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value !== "string") {
		diagnostics.push({
			type: "warning",
			message: "allowedSubagents must be a comma-separated string",
			path: filePath,
		});
		return undefined;
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function readOptionalNonNegativeIntegerField(
	frontmatter: Record<string, unknown>,
	key: "maxSubagentDepth" | "maxChildAgents",
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): number | undefined {
	if (!Object.hasOwn(frontmatter, key)) {
		return undefined;
	}
	const value = frontmatter[key];
	const parsed = parseOptionalNonNegativeInteger(value);
	if (parsed === undefined) {
		diagnostics.push({ type: "warning", message: `${key} must be a non-negative integer`, path: filePath });
		return undefined;
	}
	return parsed;
}

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
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

	const policyDiagnosticStart = diagnostics.length;
	const tools = readCommaSeparatedListField(frontmatter, "tools", options.filePath, diagnostics);
	const excludedTools = readCommaSeparatedListField(frontmatter, "excludedTools", options.filePath, diagnostics);
	const allowedSubagents = readAllowedSubagentsField(frontmatter, options.filePath, diagnostics);
	const maxSubagentDepth = readOptionalNonNegativeIntegerField(
		frontmatter,
		"maxSubagentDepth",
		options.filePath,
		diagnostics,
	);
	const maxChildAgents = readOptionalNonNegativeIntegerField(
		frontmatter,
		"maxChildAgents",
		options.filePath,
		diagnostics,
	);
	const hasMalformedPolicyField = diagnostics.length > policyDiagnosticStart;
	const model = readOptionalStringField(frontmatter, "model", options.filePath, diagnostics);
	const thinking = readOptionalStringField(frontmatter, "thinking", options.filePath, diagnostics);

	if (!name || !description || systemPrompt.length === 0 || hasMalformedPolicyField) {
		return { definition: null, diagnostics };
	}

	return {
		definition: {
			name,
			description,
			...(tools ? { tools } : {}),
			...(excludedTools ? { excludedTools } : {}),
			allowedSubagents: allowedSubagents ?? [],
			...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
			...(maxChildAgents !== undefined ? { maxChildAgents } : {}),
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
	const builtInDefinitions = createBuiltInSubagentDefinitions();
	const reservedBuiltInNames = new Set(builtInDefinitions.map((definition) => definition.name));

	function addDefinitions(definitions: SubagentDefinition[]): void {
		for (const definition of definitions) {
			if (definition.source !== "built-in" && reservedBuiltInNames.has(definition.name)) {
				diagnostics.push({
					type: "warning",
					message: `subagent definition "${definition.name}" cannot override a built-in subagent and was ignored`,
					path: definition.filePath,
				});
				continue;
			}
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

	addDefinitions(builtInDefinitions);

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
	DEFAULT_SUBAGENT_DELEGATION_LIMITS,
	type SubagentDelegationReservation,
	SubagentDelegationScope,
	type SubagentDelegationScopeLimits,
	type SubagentDelegationScopeOptions,
	type SubagentDelegationScopeSnapshot,
} from "./delegation-scope.ts";
export {
	type SubagentActivity,
	type SubagentActivityEvent,
	type SubagentActivityListener,
	type SubagentActivityStatus,
	SubagentDefinitionConfigurationError,
	SubagentDefinitionNotFoundError,
	type SubagentDelegationScopeLease,
	type SubagentEndEvent,
	type SubagentEvent,
	type SubagentEventListener,
	type SubagentHandle,
	SubagentManager,
	type SubagentManagerOptions,
	type SubagentResult,
	type SubagentRuntimeCreatedEvent,
	type SubagentRuntimeRegistration,
	type SubagentSpawnRecordContext,
	type SubagentStartByNameOptions,
	type SubagentStartOptions,
} from "./manager.ts";
export {
	type SubagentFollowResult,
	SubagentRegistry,
	type SubagentRegistryFollowability,
	type SubagentRegistryRecord,
	type SubagentRegistrySnapshot,
	type SubagentRegistryStatus,
	type SubagentSpawnConfirmationLease,
	type SubagentSpawnConfirmationPreflight,
	type SubagentSpawnConfirmationStatus,
} from "./registry.ts";
