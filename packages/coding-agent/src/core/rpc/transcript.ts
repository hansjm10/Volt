import type { AgentMessage } from "@earendil-works/volt-agent-core";
import type { TextContent } from "@earendil-works/volt-ai";
import type { BashExecutionMessage } from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import type {
	RpcTranscriptItem,
	RpcTranscriptResponse,
	RpcTranscriptToolItem,
	RpcTranscriptToolStatus,
} from "./types.ts";

const DEFAULT_TRANSCRIPT_LIMIT = 100;
const MAX_TRANSCRIPT_LIMIT = 200;
const MESSAGE_TEXT_LIMIT = 16_000;
const SUMMARY_TEXT_LIMIT = 1_000;
const TOOL_SUMMARY_LIMIT = 1_000;
const TOOL_COMMAND_LIMIT = 500;
const MUTATION_PREVIEW_LIMIT = 4_000;
const SUBAGENT_AGENT_LIMIT = 200;
const SUBAGENT_TASK_LIMIT = 1_000;
const SUBAGENT_ERROR_LIMIT = 1_000;
const SUBAGENT_OUTPUT_LIMIT = 1_000;

interface StoredToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ProjectSessionTranscriptOptions {
	beforeEntryId?: string;
	limit?: number;
}

export function projectSessionTranscript(
	sessionManager: ReadonlySessionManager,
	options: ProjectSessionTranscriptOptions = {},
): RpcTranscriptResponse {
	const allItems = projectTranscriptItems(sessionManager.getBranch());
	const beforeIndex = options.beforeEntryId
		? allItems.findIndex((item) => item.id === options.beforeEntryId)
		: allItems.length;
	const eligibleItems = beforeIndex === -1 ? [] : allItems.slice(0, beforeIndex);
	const limit = normalizeLimit(options.limit);
	const pageStart = Math.max(0, eligibleItems.length - limit);
	const items = eligibleItems.slice(pageStart);
	const hasMore = pageStart > 0;

	return {
		sessionId: sessionManager.getSessionId(),
		items,
		hasMore,
		nextBeforeEntryId: hasMore ? (items[0]?.id ?? null) : null,
	};
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		return DEFAULT_TRANSCRIPT_LIMIT;
	}
	return Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(limit));
}

function projectTranscriptItems(entries: SessionEntry[]): RpcTranscriptItem[] {
	const toolCallsById = collectToolCalls(entries);
	const items: RpcTranscriptItem[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction") {
			items.push({
				id: entry.id,
				role: "summary",
				timestamp: normalizeTimestamp(entry.timestamp),
				title: "Conversation compacted",
				text: boundText(entry.summary, SUMMARY_TEXT_LIMIT),
			});
			continue;
		}

		if (entry.type === "custom_message") {
			const customItem = projectCustomMessage(entry);
			if (customItem) {
				items.push(customItem);
			}
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		const message = entry.message;
		if (message.role === "user") {
			const text = boundText(extractTextContent(message.content), MESSAGE_TEXT_LIMIT);
			if (text) {
				items.push({ id: entry.id, role: "user", text, timestamp: normalizeTimestamp(entry.timestamp) });
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = boundText(extractTextContent(message.content), MESSAGE_TEXT_LIMIT);
			if (text) {
				items.push({ id: entry.id, role: "assistant", text, timestamp: normalizeTimestamp(entry.timestamp) });
			}
			continue;
		}

		if (message.role === "toolResult") {
			items.push(projectToolResult(entry.id, entry.timestamp, message, toolCallsById.get(message.toolCallId)));
			continue;
		}

		if (message.role === "bashExecution") {
			items.push(projectBashExecution(entry.id, entry.timestamp, message));
		}
	}

	return items;
}

function projectCustomMessage(entry: Extract<SessionEntry, { type: "custom_message" }>): RpcTranscriptItem | undefined {
	if (!entry.display || entry.customType !== "review") {
		return undefined;
	}
	const text = boundText(extractTextContent(entry.content), MESSAGE_TEXT_LIMIT);
	if (!text) {
		return undefined;
	}
	return { id: entry.id, role: "assistant", text, timestamp: normalizeTimestamp(entry.timestamp) };
}

function collectToolCalls(entries: SessionEntry[]): Map<string, StoredToolCall> {
	const toolCalls = new Map<string, StoredToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		for (const block of entry.message.content) {
			if (isStoredToolCall(block)) {
				toolCalls.set(block.id, block);
			}
		}
	}
	return toolCalls;
}

function projectToolResult(
	entryId: string,
	timestamp: string,
	message: Extract<AgentMessage, { role: "toolResult" }>,
	toolCall: StoredToolCall | undefined,
): RpcTranscriptToolItem {
	const args = toolCall?.arguments;
	const status: RpcTranscriptToolStatus = message.isError ? "failed" : "completed";
	const path = getToolPath(message.toolName, args);
	const details = isRecord(message.details) ? message.details : undefined;
	const item: RpcTranscriptToolItem = {
		id: entryId,
		role: "tool",
		toolName: message.toolName,
		status,
		summary: summarizeToolResult(message.toolName, status, args, path),
		timestamp: normalizeTimestamp(timestamp),
	};
	if (path) {
		item.path = path;
	}
	const diffPreview = getBoundedString(details, "diff", MUTATION_PREVIEW_LIMIT);
	if (diffPreview) {
		item.diffPreview = diffPreview;
	}
	const patchPreview = getBoundedString(details, "patch", MUTATION_PREVIEW_LIMIT);
	if (patchPreview) {
		item.patchPreview = patchPreview;
	}
	if (message.toolName === "subagent") {
		const subagentArgs = projectSubagentArgs(args);
		if (subagentArgs) {
			item.args = subagentArgs;
		}
		const subagentDetails = projectSubagentDetails(details);
		if (subagentDetails) {
			item.details = subagentDetails;
		}
	}
	return item;
}

function projectSubagentArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const agent = getStringArg(args, "agent");
	if (agent) {
		projected.agent = boundSummary(agent, SUBAGENT_AGENT_LIMIT);
	}
	const task = getStringArg(args, "task");
	if (task) {
		projected.task = boundText(task, SUBAGENT_TASK_LIMIT);
	}
	const tasks = projectSubagentInputArray(args.tasks);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectSubagentInputArray(args.chain);
	if (chain) {
		projected.chain = chain;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentInputArray(value: unknown): Record<string, string>[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected = value
		.map((item) => {
			if (!isRecord(item)) {
				return undefined;
			}
			const agent = getStringArg(item, "agent");
			const task = getStringArg(item, "task");
			if (!agent || !task) {
				return undefined;
			}
			return {
				agent: boundSummary(agent, SUBAGENT_AGENT_LIMIT),
				task: boundText(task, SUBAGENT_TASK_LIMIT),
			};
		})
		.filter((item): item is { agent: string; task: string } => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectSubagentDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!details) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyBoundedString(details, projected, "mode", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(details, projected, "status", SUBAGENT_AGENT_LIMIT);
	const summary = projectSubagentSummary(details.summary);
	if (summary) {
		projected.summary = summary;
	}
	const agent = projectSubagentAgent(details.agent);
	if (agent) {
		projected.agent = agent;
	}
	const output = projectSubagentOutput(details.output);
	if (output) {
		projected.output = output;
	}
	const error = projectSubagentError(details.error);
	if (error) {
		projected.error = error;
	}
	const tasks = projectSubagentDetailArray(details.tasks);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectSubagentDetailArray(details.steps);
	if (steps) {
		projected.steps = steps;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentSummary(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, number> = {};
	for (const key of [
		"total",
		"completed",
		"failed",
		"aborted",
		"running",
		"maxTasks",
		"maxConcurrency",
		"stoppedAt",
	]) {
		const numberValue = getFiniteNumber(value, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentDetailArray(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected = value
		.map((item) => (isRecord(item) ? projectSubagentTaskDetails(item) : undefined))
		.filter((item): item is Record<string, unknown> => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectSubagentTaskDetails(item: Record<string, unknown>): Record<string, unknown> | undefined {
	const projected: Record<string, unknown> = {};
	const index = getFiniteNumber(item, "index");
	if (index !== undefined) {
		projected.index = index;
	}
	const agent = projectSubagentAgent(item.agent);
	if (agent) {
		projected.agent = agent;
	}
	copyBoundedString(item, projected, "status", SUBAGENT_AGENT_LIMIT);
	const error = projectSubagentError(item.error);
	if (error) {
		projected.error = error;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentAgent(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, string> = {};
	const name = getStringArg(value, "name");
	if (name) {
		projected.name = boundSummary(name, SUBAGENT_AGENT_LIMIT);
	}
	const source = getStringArg(value, "source");
	if (source) {
		projected.source = boundSummary(source, SUBAGENT_AGENT_LIMIT);
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentOutput(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const text = getStringArg(value, "text");
	if (text) {
		projected.text = boundText(text, SUBAGENT_OUTPUT_LIMIT);
	}
	for (const key of ["bytes", "omittedBytes", "maxBytes"]) {
		const numberValue = getFiniteNumber(value, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	const truncated = value.truncated;
	if (typeof truncated === "boolean") {
		projected.truncated = truncated;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentError(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const message = getStringArg(value, "message");
	return message ? { message: boundText(message, SUBAGENT_ERROR_LIMIT) } : undefined;
}

function copyBoundedString(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	limit: number,
): void {
	const value = getStringArg(from, key);
	if (value) {
		to[key] = boundText(value, limit);
	}
}

function getFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectBashExecution(
	entryId: string,
	timestamp: string,
	message: BashExecutionMessage,
): RpcTranscriptToolItem {
	const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
	const status: RpcTranscriptToolStatus = failed ? "failed" : "completed";
	const summaryParts = [`Ran command: ${boundSummary(message.command, TOOL_COMMAND_LIMIT)}`];
	if (message.truncated) {
		summaryParts.push("output truncated");
	}
	if (message.cancelled) {
		summaryParts.push("cancelled");
	} else if (message.exitCode !== undefined) {
		summaryParts.push(`exit ${message.exitCode}`);
	}
	return {
		id: entryId,
		role: "tool",
		toolName: "bash",
		status,
		summary: boundSummary(summaryParts.join("; "), TOOL_SUMMARY_LIMIT),
		timestamp: normalizeTimestamp(timestamp),
	};
}

function summarizeToolResult(
	toolName: string,
	status: RpcTranscriptToolStatus,
	args: Record<string, unknown> | undefined,
	path: string | undefined,
): string {
	const statusText = status === "failed" ? "failed" : "completed";
	const target = path ? ` ${path}` : "";
	if (toolName === "read") {
		return boundSummary(`Read${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "edit") {
		return boundSummary(`Edited${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "write") {
		return boundSummary(`Wrote${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "bash") {
		const command = getStringArg(args, "command");
		return boundSummary(
			command
				? `Ran command: ${boundSummary(command, TOOL_COMMAND_LIMIT)} (${statusText})`
				: `Ran command (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	if (toolName === "web_search") {
		const query = getStringArg(args, "query");
		return boundSummary(
			query
				? `Searched web for ${boundSummary(query, TOOL_COMMAND_LIMIT)} (${statusText})`
				: `Searched web (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	if (toolName === "grep") {
		const pattern = getStringArg(args, "pattern");
		const patternText = pattern ? ` for ${pattern}` : "";
		return boundSummary(`Searched${target || " workspace"}${patternText} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "find") {
		const query = getStringArg(args, "query") ?? getStringArg(args, "pattern");
		const queryText = query ? ` for ${query}` : "";
		return boundSummary(`Found files${target}${queryText} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "ls") {
		return boundSummary(`Listed${target || " directory"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "lsp") {
		const action = getStringArg(args, "action");
		return boundSummary(
			action ? `Ran lsp ${action}${target} (${statusText})` : `Ran lsp${target} (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	return boundSummary(`${toolName} ${statusText}`, TOOL_SUMMARY_LIMIT);
}

function getToolPath(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	return getStringArg(args, "path") ?? getStringArg(args, "file_path") ?? getStringArg(args, `${toolName}Path`);
}

function getStringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getBoundedString(record: Record<string, unknown> | undefined, key: string, limit: number): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? boundText(value, limit) : undefined;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is TextContent => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function boundSummary(text: string, limit: number): string {
	return boundText(text.replace(/\s+/g, " ").trim(), limit);
}

function boundText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(0, limit - 16)).trimEnd()}\n[truncated]`;
}

function normalizeTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

function isStoredToolCall(value: unknown): value is StoredToolCall {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
