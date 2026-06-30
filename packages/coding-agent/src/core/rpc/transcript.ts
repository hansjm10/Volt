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
	return item;
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
