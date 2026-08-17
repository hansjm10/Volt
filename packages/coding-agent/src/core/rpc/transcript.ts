import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import { type BashExecutionMessage, extractVisibleTextContent } from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import { getRemoteVisibleCustomMessageRole } from "./custom-message-projection.ts";
import { type ResolvedSessionToolCall, resolveSessionToolCallsByResultEntryId } from "./tool-call-resolution.ts";
import type {
	RpcConversationTranscriptItem,
	RpcMessageImage,
	RpcTranscriptItem,
	RpcTranscriptResponse,
	RpcTranscriptToolItem,
	RpcTranscriptToolStatus,
} from "./types.ts";
import {
	RPC_TRANSCRIPT_PAGE_DEFAULT_ITEMS as DEFAULT_TRANSCRIPT_LIMIT,
	RPC_TRANSCRIPT_PAGE_MAX_ITEMS as MAX_TRANSCRIPT_LIMIT,
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
} from "./wire-limits.ts";

const MESSAGE_TEXT_LIMIT = 16_000;
const SUMMARY_TEXT_LIMIT = 1_000;
const TOOL_SUMMARY_LIMIT = 1_000;
const TOOL_COMMAND_LIMIT = 500;
const TOOL_ARGUMENT_STRING_LIMIT = 500;
const TOOL_ARGUMENT_KEYS_LIMIT = 12;
const MUTATION_PREVIEW_LIMIT = 4_000;
const SUBAGENT_AGENT_LIMIT = 200;
const SUBAGENT_ID_LIMIT = 200;
const SUBAGENT_TASK_LIMIT = 1_000;
const SUBAGENT_ERROR_LIMIT = 1_000;
const SUBAGENT_OUTPUT_LIMIT = 1_000;
const SUBAGENT_ACTIVITY_LIMIT = 300;
const SUBAGENT_TREE_DEPTH_LIMIT = 5;
const SUBAGENT_ARRAY_ITEM_LIMIT = 64;
const SUBAGENT_GLOBAL_NODE_LIMIT = 128;
const SUBAGENT_NUMERIC_DETAIL_KEYS = ["startedAt", "durationMs", "toolCalls", "tokens"] as const;

interface SubagentProjectionBudget {
	remainingNodes: number;
}

interface BoundedTextProjection {
	text: string;
	truncated: boolean;
}

interface ProjectedTranscriptItem<T extends RpcTranscriptItem = RpcTranscriptItem> {
	item: T;
	truncated: boolean;
}

interface ProjectedTranscriptItems {
	items: RpcTranscriptItem[];
	truncatedEntryIds: ReadonlySet<string>;
}

export interface ProjectSessionTranscriptOptions {
	beforeEntryId?: string;
	limit?: number;
}

export function projectSessionTranscript(
	sessionManager: ReadonlySessionManager,
	options: ProjectSessionTranscriptOptions = {},
): RpcTranscriptResponse {
	const allItems = projectTranscriptItems(sessionManager.getBranch()).items;
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

/**
 * Serialized-size budget for one get_message_images response. Keeps the frame
 * under volt-app's 4 MiB encoded JSONL cap, with explicit headroom for the
 * response envelope, identifiers, array commas, and the LF framing byte.
 */
export {
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
	MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
} from "./wire-limits.ts";

export type ProjectMessageImagesResult =
	| { ok: true; entryId: string; totalImages: number; images: RpcMessageImage[]; nextImageIndex: number | null }
	| {
			ok: false;
			error:
				| "unknown_entry"
				| "invalid_cursor"
				| "image_too_large"
				| "image_count_exceeded"
				| "image_bytes_exceeded";
	  };

function getSerializedMessageImageBytes(image: ImageContent, index: number): number {
	return Buffer.byteLength(JSON.stringify({ ...image, index }), "utf8");
}

/**
 * Recovers the inline image blocks persisted on a session entry, paged from
 * `startImageIndex` under `budgetBytes`. Text-only transcript projections
 * advertise `imageCount`; reconnecting clients call this per entry to restore
 * user-message images after a cold restart.
 */
export function projectMessageImages(
	entries: SessionEntry[],
	entryId: string,
	startImageIndex = 0,
	budgetBytes = MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
): ProjectMessageImagesResult {
	const entry = entries.find((candidate) => candidate.id === entryId);
	if (!entry || entry.type !== "message") {
		return { ok: false, error: "unknown_entry" };
	}
	const allImages = extractMessageImages((entry.message as { content?: unknown }).content);
	if (
		!Number.isSafeInteger(startImageIndex) ||
		startImageIndex < 0 ||
		(allImages.length === 0 ? startImageIndex !== 0 : startImageIndex >= allImages.length)
	) {
		return { ok: false, error: "invalid_cursor" };
	}
	if (allImages.length > MESSAGE_IMAGES_ENTRY_MAX_ITEMS) {
		return { ok: false, error: "image_count_exceeded" };
	}
	const serializedImageBytes: number[] = [];
	let totalSerializedBytes = 0;
	for (const [index, image] of allImages.entries()) {
		const serializedBytes = getSerializedMessageImageBytes(image, index);
		if (serializedBytes > budgetBytes) {
			return { ok: false, error: "image_too_large" };
		}
		totalSerializedBytes += serializedBytes;
		if (totalSerializedBytes > MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES) {
			return { ok: false, error: "image_bytes_exceeded" };
		}
		serializedImageBytes.push(serializedBytes);
	}

	const images: RpcMessageImage[] = [];
	let usedBytes = 0;
	for (let index = startImageIndex; index < allImages.length; index++) {
		const image = allImages[index];
		const serializedBytes = serializedImageBytes[index];
		if (images.length >= MESSAGE_IMAGES_PAGE_MAX_ITEMS || usedBytes + serializedBytes > budgetBytes) {
			break;
		}
		images.push({ ...image, index });
		usedBytes += serializedBytes;
	}
	const nextImageIndex = startImageIndex + images.length < allImages.length ? startImageIndex + images.length : null;
	return { ok: true, entryId, totalImages: allImages.length, images, nextImageIndex };
}

/** Inline image blocks on a persisted message's content array. */
export function extractMessageImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(
		(block): block is ImageContent =>
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			block.data.length > 0 &&
			typeof block.mimeType === "string",
	);
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		return DEFAULT_TRANSCRIPT_LIMIT;
	}
	return Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(limit));
}

function projectTranscriptItems(entries: SessionEntry[]): ProjectedTranscriptItems {
	const toolCallsByResultEntryId = resolveSessionToolCallsByResultEntryId(entries);
	const items: RpcTranscriptItem[] = [];
	const truncatedEntryIds = new Set<string>();
	const pushProjectedItem = (projected: ProjectedTranscriptItem): void => {
		items.push(projected.item);
		if (projected.truncated) {
			truncatedEntryIds.add(projected.item.id);
		}
	};

	for (const entry of entries) {
		if (entry.type === "compaction") {
			const text = boundTextWithMetadata(entry.summary, SUMMARY_TEXT_LIMIT);
			pushProjectedItem({
				item: {
					id: entry.id,
					role: "summary",
					timestamp: normalizeTimestamp(entry.timestamp),
					title: "Conversation compacted",
					text: text.text,
				},
				truncated: text.truncated,
			});
			continue;
		}

		if (entry.type === "custom_message") {
			const customItem = projectCustomMessage(entry);
			if (customItem) {
				pushProjectedItem(customItem);
			}
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		const message = entry.message;
		if (message.role === "user") {
			const text = boundTextWithMetadata(extractVisibleTextContent(message.content), MESSAGE_TEXT_LIMIT);
			const imageCount = extractMessageImages(message.content).length;
			if (text.text || imageCount > 0) {
				pushProjectedItem({
					item: {
						id: entry.id,
						role: "user",
						text: text.text,
						timestamp: normalizeTimestamp(entry.timestamp),
						...(message.clientMessageId === undefined ? {} : { clientMessageId: message.clientMessageId }),
						...(imageCount > 0 ? { imageCount } : {}),
					},
					truncated: text.truncated,
				});
			}
			continue;
		}

		if (message.role === "assistant") {
			const text = boundTextWithMetadata(extractVisibleTextContent(message.content), MESSAGE_TEXT_LIMIT);
			if (text.text) {
				pushProjectedItem({
					item: {
						id: entry.id,
						role: "assistant",
						text: text.text,
						timestamp: normalizeTimestamp(entry.timestamp),
					},
					truncated: text.truncated,
				});
			}
			continue;
		}

		if (message.role === "toolResult") {
			pushProjectedItem(
				projectToolResult(entry.id, entry.timestamp, message, toolCallsByResultEntryId.get(entry.id)),
			);
			continue;
		}

		if (message.role === "bashExecution") {
			pushProjectedItem(projectBashExecution(entry.id, entry.timestamp, message));
		}
	}

	return { items, truncatedEntryIds };
}

/**
 * Local-RPC projection in the canonical conversation-item shape used by
 * session-tree pages. Remote callers use the stricter workspace sanitizer but
 * retain this exact schema.
 */
export function projectConversationTranscriptItems(entries: SessionEntry[]): RpcConversationTranscriptItem[] {
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const projected = projectTranscriptItems(entries);
	return projected.items.map((item) => {
		const entry = entriesById.get(item.id);
		if (!entry) {
			throw new Error(`Transcript projection references unknown session entry ${item.id}`);
		}
		const base = {
			entryId: item.id,
			ordinal: entry.ordinal ?? 0,
			createdAt: item.timestamp,
		};
		if (item.role === "tool") {
			return {
				...base,
				role: "tool" as const,
				text: item.summary,
				truncated: projected.truncatedEntryIds.has(item.id),
				toolName: item.toolName,
				status: item.status === "failed" ? "failed" : "completed",
				summary: item.summary,
				...(item.path === undefined ? {} : { path: item.path }),
				...(item.imageCount === undefined ? {} : { imageCount: item.imageCount }),
				...(item.args === undefined ? {} : { args: item.args }),
				...(item.details === undefined ? {} : { details: item.details }),
			};
		}
		const role = item.role === "summary" ? "system" : item.role;
		return {
			...base,
			role,
			text: item.text,
			truncated: projected.truncatedEntryIds.has(item.id),
			...(item.role === "user" && item.clientMessageId !== undefined
				? { clientMessageId: item.clientMessageId }
				: {}),
			...(item.role === "user" && item.imageCount !== undefined ? { imageCount: item.imageCount } : {}),
		};
	});
}

function projectCustomMessage(
	entry: Extract<SessionEntry, { type: "custom_message" }>,
): ProjectedTranscriptItem | undefined {
	const role = getRemoteVisibleCustomMessageRole(entry.customType, entry.display);
	if (role === undefined) {
		return undefined;
	}
	const text = boundTextWithMetadata(extractVisibleTextContent(entry.content), MESSAGE_TEXT_LIMIT);
	if (!text.text) {
		return undefined;
	}
	return {
		item: { id: entry.id, role, text: text.text, timestamp: normalizeTimestamp(entry.timestamp) },
		truncated: text.truncated,
	};
}

function projectToolResult(
	entryId: string,
	timestamp: string,
	message: Extract<AgentMessage, { role: "toolResult" }>,
	toolCall: ResolvedSessionToolCall | undefined,
): ProjectedTranscriptItem<RpcTranscriptToolItem> {
	const args = toolCall?.arguments;
	const status: RpcTranscriptToolStatus = message.isError ? "failed" : "completed";
	const path = getToolPath(message.toolName, args);
	const details = isRecord(message.details) ? message.details : undefined;
	const summary = summarizeToolResult(message.toolName, status, args, path);
	const item: RpcTranscriptToolItem = {
		id: entryId,
		role: "tool",
		toolName: message.toolName,
		status,
		summary: summary.text,
		timestamp: normalizeTimestamp(timestamp),
	};
	if (path) {
		item.path = path;
	}
	const imageCount = extractMessageImages(message.content).length;
	if (imageCount > 0) {
		item.imageCount = imageCount;
	}
	const diffPreview = getBoundedString(details, "diff", MUTATION_PREVIEW_LIMIT);
	if (diffPreview) {
		item.diffPreview = diffPreview;
	}
	const patchPreview = getBoundedString(details, "patch", MUTATION_PREVIEW_LIMIT);
	if (patchPreview) {
		item.patchPreview = patchPreview;
	}
	const projectedArgs = projectToolArgs(message.toolName, args);
	if (projectedArgs) {
		item.args = projectedArgs;
	}
	if (message.toolName === "subagent" || message.toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		const subagentDetails = projectSubagentDetails(details);
		if (subagentDetails) {
			item.details = subagentDetails;
		}
	}
	return { item, truncated: summary.truncated };
}

function projectToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		return projectSubagentArgs(args);
	}
	if (!args) {
		return undefined;
	}

	const projected: Record<string, unknown> = {};
	switch (toolName) {
		case "bash":
			copyStringArg(args, projected, "command", TOOL_COMMAND_LIMIT);
			copyNumberArg(args, projected, "timeout");
			break;
		case "read":
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			copyNumberArg(args, projected, "offset");
			copyNumberArg(args, projected, "limit");
			break;
		case "edit":
		case "write":
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			break;
		case "grep":
			copyStringArg(args, projected, "pattern");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "glob");
			copyStringArg(args, projected, "include");
			copyStringArg(args, projected, "exclude");
			copyBooleanArg(args, projected, "ignoreCase");
			copyBooleanArg(args, projected, "literal");
			copyNumberArg(args, projected, "context");
			break;
		case "find":
			copyStringArg(args, projected, "query");
			copyStringArg(args, projected, "pattern");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "glob");
			copyStringArg(args, projected, "name");
			copyNumberArg(args, projected, "limit");
			break;
		case "ls":
			copyStringArg(args, projected, "path");
			copyNumberArg(args, projected, "limit");
			break;
		case "lsp":
			copyStringArg(args, projected, "action");
			copyStringArg(args, projected, "symbol");
			copyStringArg(args, projected, "path");
			copyStringArg(args, projected, "file_path");
			copyNumberArg(args, projected, "line");
			break;
		case "web_search":
			copyStringArg(args, projected, "query");
			copyStringArrayArg(args, projected, "domains");
			copyNumberArg(args, projected, "limit");
			copyNumberArg(args, projected, "recencyDays");
			break;
		case "web_fetch":
			copyStringArg(args, projected, "url");
			copyNumberArg(args, projected, "maxBytes");
			break;
		default:
			break;
	}

	return Object.keys(projected).length > 0 ? projected : undefined;
}

function copyStringArg(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	limit = TOOL_ARGUMENT_STRING_LIMIT,
): void {
	const value = getStringArg(from, key);
	if (value) {
		to[key] = boundText(value, limit);
	}
}

function copyNumberArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = getFiniteNumber(from, key);
	if (value !== undefined) {
		to[key] = value;
	}
}

function copyBooleanArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = from[key];
	if (typeof value === "boolean") {
		to[key] = value;
	}
}

function copyStringArrayArg(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = from[key];
	if (!Array.isArray(value)) {
		return;
	}
	const strings = value
		.map((item) => (typeof item === "string" ? boundText(item, TOOL_ARGUMENT_STRING_LIMIT) : undefined))
		.filter((item): item is string => item !== undefined && item.trim().length > 0)
		.slice(0, TOOL_ARGUMENT_KEYS_LIMIT);
	if (strings.length > 0) {
		to[key] = strings;
	}
}

function projectSubagentArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: SubagentProjectionBudget = { remainingNodes: SUBAGENT_GLOBAL_NODE_LIMIT };
	const agent = getStringArg(args, "agent");
	if (agent) {
		projected.agent = boundSummary(agent, SUBAGENT_AGENT_LIMIT);
	}
	const task = getStringArg(args, "task");
	if (task) {
		projected.task = boundText(task, SUBAGENT_TASK_LIMIT);
	}
	const tasks = projectSubagentInputArray(args.tasks, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectSubagentInputArray(args.chain, budget);
	if (chain) {
		projected.chain = chain;
	}
	copyBooleanArg(args, projected, "list");
	copyNumberArg(args, projected, "cursor");
	copyStringArg(args, projected, "follow", SUBAGENT_ID_LIMIT);
	copyStringArg(args, projected, "resume", SUBAGENT_ID_LIMIT);
	// The one-time confirm token is consumed by the call and omitted here, as
	// in the daemon and iroh projections.
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentInputArray(
	value: unknown,
	budget: SubagentProjectionBudget,
): Record<string, string>[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected: Record<string, string>[] = [];
	for (
		let index = 0;
		index < value.length && index < SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const item = value[index];
		if (!isRecord(item)) continue;
		const agent = getStringArg(item, "agent");
		const task = getStringArg(item, "task");
		if (!agent || !task) continue;
		projected.push({
			agent: boundSummary(agent, SUBAGENT_AGENT_LIMIT),
			task: boundText(task, SUBAGENT_TASK_LIMIT),
		});
	}
	return projected.length > 0 ? projected : undefined;
}

export function projectSubagentDetails(
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: SubagentProjectionBudget = { remainingNodes: SUBAGENT_GLOBAL_NODE_LIMIT };
	copyBoundedString(details, projected, "mode", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(details, projected, "status", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(details, projected, "subagentId", SUBAGENT_ID_LIMIT);
	copyBoundedString(details, projected, "sessionId", SUBAGENT_ID_LIMIT);
	for (const key of SUBAGENT_NUMERIC_DETAIL_KEYS) {
		const numberValue = getFiniteNumber(details, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	copyBoundedString(details, projected, "currentActivity", SUBAGENT_ACTIVITY_LIMIT);
	const summary = projectSubagentSummary(details.summary);
	if (summary) {
		projected.summary = summary;
	}
	const childSessions = projectSubagentDetailArray(details.childSessions, budget);
	if (childSessions) {
		projected.childSessions = childSessions;
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
	const children = projectSubagentDetailArray(details.children, budget);
	if (children) {
		projected.children = children;
	}
	const tasks = projectSubagentDetailArray(details.tasks, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectSubagentDetailArray(details.steps, budget);
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
		"returned",
		"nextCursor",
		"omittedTasks",
	]) {
		const numberValue = getFiniteNumber(value, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSubagentDetailArray(
	value: unknown,
	budget: SubagentProjectionBudget,
	depth = 0,
): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value) || depth >= SUBAGENT_TREE_DEPTH_LIMIT) {
		return undefined;
	}
	const projected: Record<string, unknown>[] = [];
	for (
		let index = 0;
		index < value.length && index < SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const item = value[index];
		if (!isRecord(item)) continue;
		const task = projectSubagentTaskDetails(item, budget, depth);
		if (task) projected.push(task);
	}
	return projected.length > 0 ? projected : undefined;
}

function projectSubagentTaskDetails(
	item: Record<string, unknown>,
	budget: SubagentProjectionBudget,
	depth = 0,
): Record<string, unknown> | undefined {
	const projected: Record<string, unknown> = {};
	const index = getFiniteNumber(item, "index");
	if (index !== undefined) {
		projected.index = index;
	}
	copyBoundedString(item, projected, "subagentId", SUBAGENT_ID_LIMIT);
	copyBoundedString(item, projected, "sessionId", SUBAGENT_ID_LIMIT);
	const agent = projectSubagentAgent(item.agent);
	if (agent) {
		projected.agent = agent;
	}
	copyBoundedString(item, projected, "status", SUBAGENT_AGENT_LIMIT);
	copyBoundedString(item, projected, "task", SUBAGENT_TASK_LIMIT);
	for (const key of SUBAGENT_NUMERIC_DETAIL_KEYS) {
		const numberValue = getFiniteNumber(item, key);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	copyBoundedString(item, projected, "currentActivity", SUBAGENT_ACTIVITY_LIMIT);
	const error = projectSubagentError(item.error);
	if (error) {
		projected.error = error;
	}
	const children = projectSubagentDetailArray(item.children, budget, depth + 1);
	if (children) {
		projected.children = children;
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
): ProjectedTranscriptItem<RpcTranscriptToolItem> {
	const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
	const status: RpcTranscriptToolStatus = failed ? "failed" : "completed";
	const command = boundSummaryWithMetadata(message.command, TOOL_COMMAND_LIMIT);
	const summaryParts = [`Ran command: ${command.text}`];
	if (message.truncated) {
		summaryParts.push("output truncated");
	}
	if (message.cancelled) {
		summaryParts.push("cancelled");
	} else if (message.exitCode !== undefined) {
		summaryParts.push(`exit ${message.exitCode}`);
	}
	const summary = boundSummaryWithMetadata(summaryParts.join("; "), TOOL_SUMMARY_LIMIT);
	const item: RpcTranscriptToolItem = {
		id: entryId,
		role: "tool",
		toolName: "bash",
		status,
		summary: summary.text,
		timestamp: normalizeTimestamp(timestamp),
	};
	if (message.command.trim().length > 0) {
		item.args = { command: boundText(message.command, TOOL_COMMAND_LIMIT) };
	}
	return { item, truncated: command.truncated || summary.truncated };
}

function summarizeToolResult(
	toolName: string,
	status: RpcTranscriptToolStatus,
	args: Record<string, unknown> | undefined,
	path: string | undefined,
): BoundedTextProjection {
	const statusText = status === "failed" ? "failed" : "completed";
	const target = path ? ` ${path}` : "";
	if (toolName === "read") {
		return boundSummaryWithMetadata(`Read${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "edit") {
		return boundSummaryWithMetadata(`Edited${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "write") {
		return boundSummaryWithMetadata(`Wrote${target || " file"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "bash") {
		const command = getStringArg(args, "command");
		const boundedCommand = command ? boundSummaryWithMetadata(command, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedCommand ? `Ran command: ${boundedCommand.text} (${statusText})` : `Ran command (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedCommand?.truncated === true };
	}
	if (toolName === "web_search") {
		const query = getStringArg(args, "query");
		const boundedQuery = query ? boundSummaryWithMetadata(query, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedQuery ? `Searched web for ${boundedQuery.text} (${statusText})` : `Searched web (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedQuery?.truncated === true };
	}
	if (toolName === "web_fetch") {
		const url = getStringArg(args, "url");
		const boundedUrl = url ? boundSummaryWithMetadata(url, TOOL_COMMAND_LIMIT) : undefined;
		const summary = boundSummaryWithMetadata(
			boundedUrl ? `Fetched ${boundedUrl.text} (${statusText})` : `Fetched URL (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
		return { text: summary.text, truncated: summary.truncated || boundedUrl?.truncated === true };
	}
	if (toolName === "grep") {
		const pattern = getStringArg(args, "pattern");
		const patternText = pattern ? ` for ${pattern}` : "";
		return boundSummaryWithMetadata(
			`Searched${target || " workspace"}${patternText} (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	if (toolName === "find") {
		const query = getStringArg(args, "query") ?? getStringArg(args, "pattern");
		const queryText = query ? ` for ${query}` : "";
		return boundSummaryWithMetadata(`Found files${target}${queryText} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "ls") {
		return boundSummaryWithMetadata(`Listed${target || " directory"} (${statusText})`, TOOL_SUMMARY_LIMIT);
	}
	if (toolName === "lsp") {
		const action = getStringArg(args, "action");
		return boundSummaryWithMetadata(
			action ? `Ran lsp ${action}${target} (${statusText})` : `Ran lsp${target} (${statusText})`,
			TOOL_SUMMARY_LIMIT,
		);
	}
	return boundSummaryWithMetadata(`${toolName} ${statusText}`, TOOL_SUMMARY_LIMIT);
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

function boundSummaryWithMetadata(text: string, limit: number): BoundedTextProjection {
	return boundTextWithMetadata(text.replace(/\s+/g, " ").trim(), limit);
}

function boundSummary(text: string, limit: number): string {
	return boundSummaryWithMetadata(text, limit).text;
}

function boundTextWithMetadata(text: string, limit: number): BoundedTextProjection {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, Math.max(0, limit - 16)).trimEnd()}\n[truncated]`,
		truncated: true,
	};
}

function boundText(text: string, limit: number): string {
	return boundTextWithMetadata(text, limit).text;
}

function normalizeTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
