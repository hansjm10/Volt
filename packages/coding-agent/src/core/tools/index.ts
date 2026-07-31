export {
	createMcpTool,
	createMcpToolDefinition,
	type McpGatewayToolDetails,
	type McpGatewayToolInput,
	type McpGatewayToolOptions,
} from "../mcp/gateway-tool.ts";
export { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export type { ToolDiagnosticsProvider } from "./diagnostics-provider.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createImageGenTool,
	createImageGenToolDefinition,
	type ImageGenFetcher,
	type ImageGenModelContext,
	type ImageGenModelContextProvider,
	type ImageGenToolDetails,
	type ImageGenToolInput,
	type ImageGenToolOptions,
	isCodexImageGenerationModel,
} from "./image-gen.ts";
export {
	createInspectionTool,
	createInspectionToolDefinition,
	createLocalInspectionOperations,
	INSPECTION_OPERATIONS,
	type InspectionOperation,
	type InspectionOperations,
	type InspectionToolDetails,
	type InspectionToolInput,
	type InspectionToolOptions,
	type ResolvedInspectionCommand,
	resolveInspectionCommand,
} from "./inspect.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLspTool,
	createLspToolDefinition,
	type LspAction,
	type LspNavigationProvider,
	type LspToolDetails,
	type LspToolInput,
	type LspToolOptions,
} from "./lsp.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createSubagentRegistryTool,
	createSubagentRegistryToolDefinition,
	createSubagentTool,
	createSubagentToolDefinition,
	DEFAULT_SUBAGENT_AGGREGATE_OUTPUT_MAX_BYTES,
	DEFAULT_SUBAGENT_CHAIN_MAX_STEPS,
	DEFAULT_SUBAGENT_OUTPUT_MAX_BYTES,
	DEFAULT_SUBAGENT_PARALLEL_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_PARALLEL_MAX_TASKS,
	type SubagentRegistryToolInput,
	type SubagentRegistryToolOptions,
	type SubagentToolAgentDetails,
	type SubagentToolDetails,
	type SubagentToolErrorDetails,
	type SubagentToolInput,
	type SubagentToolManager,
	type SubagentToolMode,
	type SubagentToolOptions,
	type SubagentToolOutputDetails,
	type SubagentToolOverallStatus,
	type SubagentToolStatus,
	type SubagentToolTaskDetails,
	type SubagentToolTaskInput,
	type SubagentToolUsageDetails,
} from "./subagent.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createDefaultWebFetchOperations,
	createWebFetchTool,
	createWebFetchToolDefinition,
	type DefaultWebFetchOperationsOptions,
	type ExtractedHtml,
	extractHtml,
	extractUrls,
	htmlToText,
	normalizeFetchUrl,
	type WebFetchDownloadTruncation,
	type WebFetchFetcher,
	type WebFetchHostResolver,
	type WebFetchOperations,
	type WebFetchRequest,
	type WebFetchResponse,
	type WebFetchToolDetails,
	type WebFetchToolInput,
	type WebFetchToolOptions,
	type WebFetchUrlPolicy,
	type WebFetchUrlSource,
} from "./web-fetch.ts";
export {
	BRAVE_SEARCH_AUTH_PROVIDER,
	createDefaultWebSearchOperations,
	createWebSearchTool,
	createWebSearchToolDefinition,
	type DefaultWebSearchOperationsOptions,
	type WebSearchFetcher,
	type WebSearchModelContext,
	type WebSearchModelContextProvider,
	type WebSearchOperations,
	type WebSearchRequest,
	type WebSearchResponse,
	type WebSearchResult,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.ts";
export {
	cleanProviderContent,
	FALLBACK_MAX_LINES,
	MAX_SNIPPET_CHARS,
	parseProviderContent,
} from "./web-search-extract.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolDetails,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createMcpTool, createMcpToolDefinition, type McpGatewayToolOptions } from "../mcp/gateway-tool.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createImageGenTool, createImageGenToolDefinition, type ImageGenToolOptions } from "./image-gen.ts";
import { createInspectionTool, createInspectionToolDefinition, type InspectionToolOptions } from "./inspect.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createLspTool, createLspToolDefinition, type LspToolOptions } from "./lsp.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import {
	createSubagentRegistryTool,
	createSubagentRegistryToolDefinition,
	createSubagentTool,
	createSubagentToolDefinition,
	type SubagentRegistryToolOptions,
	type SubagentToolOptions,
} from "./subagent.ts";
import { createWebFetchTool, createWebFetchToolDefinition, type WebFetchToolOptions } from "./web-fetch.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type CoreToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "image_gen"
	| "web_search"
	| "web_fetch"
	| "grep"
	| "find"
	| "ls"
	| "inspect"
	| "lsp";
export type ToolName = CoreToolName | "subagent" | typeof SUBAGENT_REGISTRY_TOOL_NAME | "mcp";
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly CoreToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"image_gen",
	"web_search",
	"web_fetch",
];
export const READ_ONLY_TOOL_NAMES: readonly CoreToolName[] = [
	"read",
	"web_search",
	"web_fetch",
	"grep",
	"find",
	"ls",
	"inspect",
];
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"image_gen",
	"web_search",
	"web_fetch",
	"grep",
	"find",
	"ls",
	"inspect",
	"lsp",
	"subagent",
	SUBAGENT_REGISTRY_TOOL_NAME,
	"mcp",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	webSearch?: WebSearchToolOptions;
	webFetch?: WebFetchToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	inspect?: InspectionToolOptions;
	imageGen?: ImageGenToolOptions;
	lsp?: LspToolOptions;
	subagent?: SubagentToolOptions;
	subagentRegistry?: SubagentRegistryToolOptions;
	mcp?: McpGatewayToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "image_gen":
			return createImageGenToolDefinition(cwd, options?.imageGen);
		case "web_search":
			return createWebSearchToolDefinition(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchToolDefinition(cwd, options?.webFetch);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "inspect":
			return createInspectionToolDefinition(cwd, options?.inspect);
		case "lsp":
			return createLspToolDefinition(cwd, options?.lsp);
		case "subagent":
			if (!options?.subagent) {
				throw new Error("Subagent tool requires SubagentToolOptions");
			}
			return createSubagentToolDefinition(options.subagent);
		case SUBAGENT_REGISTRY_TOOL_NAME:
			if (!options?.subagentRegistry) {
				throw new Error("Subagent registry tool requires SubagentRegistryToolOptions");
			}
			return createSubagentRegistryToolDefinition(options.subagentRegistry);
		case "mcp":
			if (!options?.mcp) {
				throw new Error("MCP tool requires McpGatewayToolOptions");
			}
			return createMcpToolDefinition(options.mcp);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "image_gen":
			return createImageGenTool(cwd, options?.imageGen);
		case "web_search":
			return createWebSearchTool(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchTool(cwd, options?.webFetch);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "inspect":
			return createInspectionTool(cwd, options?.inspect);
		case "lsp":
			return createLspTool(cwd, options?.lsp);
		case "subagent":
			if (!options?.subagent) {
				throw new Error("Subagent tool requires SubagentToolOptions");
			}
			return createSubagentTool(cwd, options.subagent);
		case SUBAGENT_REGISTRY_TOOL_NAME:
			if (!options?.subagentRegistry) {
				throw new Error("Subagent registry tool requires SubagentRegistryToolOptions");
			}
			return createSubagentRegistryTool(cwd, options.subagentRegistry);
		case "mcp":
			if (!options?.mcp) {
				throw new Error("MCP tool requires McpGatewayToolOptions");
			}
			return createMcpTool(options.mcp);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createWebSearchToolDefinition(cwd, options?.webSearch),
		createWebFetchToolDefinition(cwd, options?.webFetch),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createWebSearchToolDefinition(cwd, options?.webSearch),
		createWebFetchToolDefinition(cwd, options?.webFetch),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createInspectionToolDefinition(cwd, options?.inspect),
	];
}

export function createAllToolDefinitions(
	cwd: string,
	options?: ToolsOptions,
): Record<CoreToolName, ToolDef> & Partial<Record<"subagent" | typeof SUBAGENT_REGISTRY_TOOL_NAME | "mcp", ToolDef>> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		image_gen: createImageGenToolDefinition(cwd, options?.imageGen),
		web_search: createWebSearchToolDefinition(cwd, options?.webSearch),
		web_fetch: createWebFetchToolDefinition(cwd, options?.webFetch),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		inspect: createInspectionToolDefinition(cwd, options?.inspect),
		lsp: createLspToolDefinition(cwd, options?.lsp),
		...(options?.subagent ? { subagent: createSubagentToolDefinition(options.subagent) } : {}),
		...(options?.subagentRegistry
			? { [SUBAGENT_REGISTRY_TOOL_NAME]: createSubagentRegistryToolDefinition(options.subagentRegistry) }
			: {}),
		...(options?.mcp ? { mcp: createMcpToolDefinition(options.mcp) } : {}),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		createWebSearchTool(cwd, options?.webSearch),
		createWebFetchTool(cwd, options?.webFetch),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createWebSearchTool(cwd, options?.webSearch),
		createWebFetchTool(cwd, options?.webFetch),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createInspectionTool(cwd, options?.inspect),
	];
}

export function createAllTools(
	cwd: string,
	options?: ToolsOptions,
): Record<CoreToolName, Tool> & Partial<Record<"subagent" | typeof SUBAGENT_REGISTRY_TOOL_NAME | "mcp", Tool>> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		image_gen: createImageGenTool(cwd, options?.imageGen),
		web_search: createWebSearchTool(cwd, options?.webSearch),
		web_fetch: createWebFetchTool(cwd, options?.webFetch),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		inspect: createInspectionTool(cwd, options?.inspect),
		lsp: createLspTool(cwd, options?.lsp),
		...(options?.subagent ? { subagent: createSubagentTool(cwd, options.subagent) } : {}),
		...(options?.subagentRegistry
			? { [SUBAGENT_REGISTRY_TOOL_NAME]: createSubagentRegistryTool(cwd, options.subagentRegistry) }
			: {}),
		...(options?.mcp ? { mcp: createMcpTool(options.mcp) } : {}),
	};
}
