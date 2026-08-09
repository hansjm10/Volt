import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { handleIrohRemoteDeviceLogUploadRpcCommand } from "../core/remote/iroh/device-log-rpc.ts";
import { sanitizeIrohRemoteOutbound } from "../core/remote/iroh/outbound-filter.ts";
import {
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteRpcErrorResponse,
} from "../core/remote/iroh/rpc-command-filter.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import {
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	type IrohRemoteTranscriptTextLayout,
	sanitizeIrohRemoteTranscriptText,
} from "../core/remote/iroh/transcript-text.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import {
	handleIrohRemoteWorkspaceUnregisterRpcCommand,
	IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE,
} from "../core/remote/iroh/workspace-rpc.ts";
import {
	handleIrohRemoteWorktreeRpcCommand,
	IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE,
	IROH_REMOTE_LIST_WORKTREES_RPC_TYPE,
	type IrohRemoteWorktreeRpcBackend,
} from "../core/remote/iroh/worktree-rpc.ts";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	measureConversationProjectionUtf8BytesWithin,
} from "../core/rpc/conversation-projection-limits.ts";
import { getRpcErrorResponseTarget } from "../core/rpc/correlation.ts";
import { getRemoteVisibleCustomMessageRole } from "../core/rpc/custom-message-projection.ts";
import { projectSessionTreePage } from "../core/rpc/session-tree.ts";
import { extractMessageImages, projectMessageImages } from "../core/rpc/transcript.ts";
import type {
	RpcConversationAssistantPart,
	RpcConversationTranscriptItem,
	RpcKeepAwakeStatus,
	RpcSessionTreePage,
} from "../core/rpc/types.ts";
import { REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES } from "../core/rpc/wire-limits.ts";
import { getDefaultSessionDir, type SessionEntry, SessionManager } from "../core/session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../core/subagents/tool-names.ts";
import type { KeepAwakeStatus } from "./keep-awake.ts";
import type { LeaseState } from "./lease-broker.ts";
import { getRegisteredWorkingDirectoryForWorktree } from "./worktree-manager.ts";

export const INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES: ReadonlySet<string> = new Set([
	"new_session",
	"switch_session_by_id",
	"get_messages",
]);

/**
 * Commands that start or extend a turn. While a lease is draining to a TUI,
 * these are rejected with `lease_draining` so the drain converges; read-only
 * commands and abort pass through.
 */
export const TURN_INITIATING_RPC_TYPES: ReadonlySet<string> = new Set([
	"prompt",
	"plan_execute",
	"invoke_ui_action",
	"steer",
	"follow_up",
]);

export const LEASE_DRAINING_RETRY_AFTER_MS = 1000;

export const REMOTE_SESSION_LIST_DEFAULT_LIMIT = 50;
export const REMOTE_SESSION_LIST_MAX_LIMIT = 200;
export const REMOTE_SESSION_LIST_CURSOR_TTL_MS = 10 * 60 * 1000;
export const REMOTE_SESSION_LIST_CURSOR_MAX_BYTES = 512;
/**
 * Per-client cap on retained pagination cursors. The cursor map is shared across
 * every stream on the daemon; without a bound a client that never echoes the
 * returned cursor (each no-cursor list_sessions mints a fresh snapshot of up to
 * REMOTE_SESSION_LIST_MAX_LIMIT summaries) would grow it without limit for the
 * whole TTL window. Bounding per client (rather than globally) prevents one client
 * from evicting another's cursors — mirrors the push deduper's per-client cap.
 */
export const REMOTE_SESSION_LIST_MAX_CURSORS_PER_CLIENT = 64;
const REMOTE_TRANSCRIPT_DEFAULT_LIMIT = 200;
const REMOTE_TRANSCRIPT_MAX_LIMIT = 200;
const REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES = 2048;
const REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS = 512;

export { REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES } from "../core/rpc/wire-limits.ts";

const REMOTE_TRANSCRIPT_SOURCE_WINDOW_MIN_ENTRIES = 256;
const REMOTE_TRANSCRIPT_SOURCE_WINDOW_MAX_ENTRIES = 800;
const REMOTE_TRANSCRIPT_SOURCE_WINDOW_MULTIPLIER = 4;
export const REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES = 256;
export const REMOTE_TRANSCRIPT_PROJECTION_VERSION = 3;
const REMOTE_TOOL_COMMAND_MAX_SCALARS = 500;
const REMOTE_TOOL_ARGUMENT_MAX_SCALARS = 500;
const REMOTE_TOOL_ARGUMENT_KEYS_MAX = 12;
export const REMOTE_TOOL_OUTPUT_MAX_SCALARS = 8_000;
/**
 * Elevated per-entry text budget for the branch-latest assistant message.
 * Mirrors the live assistant stream's cumulative content budget so a client
 * attaching after message_end converges on the same full text the live lane
 * would have delivered. Entries whose cumulative text/thinking content exceeds
 * this budget keep the default scalar truncation; their tails stay fetchable
 * through the get_transcript_entry_text continuation RPC.
 */
export const REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES =
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES;
/** Scalar fail-safe covering any text within the byte budget (1 scalar >= 1 UTF-8 byte). */
const REMOTE_TRANSCRIPT_FINAL_ASSISTANT_TEXT_MAX_SCALARS = REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES;

export type RemoteRpcCommand = Record<string, unknown> & { type: string };

export type RemoteSessionRuntimeState = Exclude<LeaseState, "unowned">;

export interface RemoteSessionListEntry {
	sessionId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: "subagent";
	/** Live host ownership for this session. Omitted when no runtime is currently owned. */
	runtimeState?: RemoteSessionRuntimeState;
	/** Present when the session is bound to a daemon-managed worktree (worktrees.v1). */
	worktreeId?: string;
	/** POSIX-style path relative to the registered workspace root. Omitted for root. */
	workingDirectory?: string;
}

export interface RemoteSessionListCursorEntry {
	clientNodeId: string;
	workspaceName: string;
	sessions: RemoteSessionListEntry[];
	nextIndex: number;
	expiresAt: number;
}

/** Minimal runtime surface the conversation command handlers consume. */
export interface ConversationCommandRuntime {
	session: {
		sessionId: string;
		sessionManager: Pick<SessionManager, "getBranch" | "getBranchWindow" | "getLeafEntry"> &
			Partial<Pick<SessionManager, "getEntries">>;
	};
	listSessions(): Promise<
		Array<{
			sessionId: string;
			sessionName?: string;
			createdAt: string;
			modifiedAt: string;
			messageCount: number;
			firstMessage: string;
			cwd?: string;
			origin?: "subagent";
		}>
	>;
}

export interface ConversationCommandContext {
	agentDir?: string;
	auditLogger?: IrohRemoteAuditLogger;
	hostEngine?: { clearPairingSecretForWorkspace(workspaceName: string): void };
	stateManager: IrohRemoteHostStateManager;
	sessionListCursors: Map<string, RemoteSessionListCursorEntry>;
	sessionListCursorTtlMs: number;
	now?: () => number;
	/** Current ordered-projection generation used to correlate transcript pagination. */
	getConversationBranchEpoch?: () => string;
	/** Accept only generation-scoped cursors previously issued by the ordered feed. */
	isConversationTranscriptCursorValid?: (cursor: string) => boolean;
	/** Retain the next bounded cursor emitted by a successful page. */
	registerConversationTranscriptCursor?: (cursor: string | null) => void;
	/** Batch live-runtime presence for list_sessions; absent on hosts without a daemon broker. */
	listRuntimeStates?: (
		workspaceName: string,
	) => Promise<ReadonlyMap<string, RemoteSessionRuntimeState>> | ReadonlyMap<string, RemoteSessionRuntimeState>;
	/** True while this conversation's lease is draining to a TUI (§4.5 rejection). */
	isDraining?: () => boolean;
	/** True once the daemon has closed its admission epoch for shutdown. */
	isTurnAdmissionClosed?: () => boolean;
	/**
	 * True when this conversation runtime is a subagent child session. Subagent
	 * sessions are observe-only for remote clients: the parent agent owns the
	 * delegated turn, so turn-initiating commands are rejected.
	 */
	isSubagentSession?: () => boolean;
	/** Host cleanup after a successful workspace unregister (streams, runtimes, relays). */
	onWorkspaceUnregistered?: (workspaceName: string) => Promise<void>;
	/** Host keep-awake control; absent when no daemon owns the host (e.g. plain rpc mode). */
	keepAwake?: {
		setEnabled(enabled: boolean): KeepAwakeStatus;
		readonly status: KeepAwakeStatus;
	};
	/** Persist the desired keep-awake setting after a successful set_keep_awake. */
	onKeepAwakeSetting?: (enabled: boolean) => void;
	/** Host web-search key control; absent when no daemon owns the host (e.g. plain rpc mode). */
	webSearchKey?: {
		set(apiKey: string | null): void;
		readonly configured: boolean;
	};
	/**
	 * Worktree RPC backend for the stream-bound workspace (worktrees.v1);
	 * absent when no daemon owns the host (create/list_worktrees then fail
	 * with unsupported_remote_command).
	 */
	createWorktreeBackend?: (workspace: { name: string; path: string }) => IrohRemoteWorktreeRpcBackend;
}

export function createLeaseDrainingRpcErrorResponse(command: RemoteRpcCommand): Record<string, unknown> {
	const target = getRpcErrorResponseTarget(command);
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: {
			code: "lease_draining",
			message: "Handing off to the desktop TUI; retry shortly.",
			retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
		},
	};
}

export function createHostShutdownRpcErrorResponse(command: RemoteRpcCommand): Record<string, unknown> {
	const target = getRpcErrorResponseTarget(command);
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: {
			code: "host_shutdown",
			message: "The host is shutting down; reconnect after it restarts.",
		},
	};
}

export function createSubagentSessionReadOnlyRpcErrorResponse(command: RemoteRpcCommand): Record<string, unknown> {
	const target = getRpcErrorResponseTarget(command);
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: {
			code: "subagent_session_read_only",
			message: "Subagent sessions are observe-only; prompt the parent agent instead.",
		},
	};
}

function contextNow(context: ConversationCommandContext): number {
	return (context.now ?? Date.now)();
}

async function logAudit(
	auditLogger: IrohRemoteAuditLogger | undefined,
	event: Parameters<IrohRemoteAuditLogger["log"]>[0],
): Promise<void> {
	try {
		await auditLogger?.log(event);
	} catch {
		// Audit logging is best-effort and must not change remote runtime behavior.
	}
}

export function getRpcResponseId(command: Record<string, unknown>): string | undefined {
	return typeof command.id === "string" ? command.id : undefined;
}

export function createRpcSuccessResponse(
	id: string | undefined,
	command: string,
	data?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	};
}

function getRemoteSanitizerOptions(authorization: IrohRemoteClientAuthorizationSuccess) {
	return {
		remoteWorkspacePath: "/workspace",
		workspacePath: authorization.workspace.path,
	};
}

function truncateUnicodeScalars(value: string, maxLength: number): string {
	const scalars = Array.from(value);
	return scalars.length <= maxLength ? value : scalars.slice(0, maxLength).join("");
}

function sanitizeRemoteTextField(
	value: string,
	maxLength: number,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string {
	const sanitized = (
		sanitizeIrohRemoteOutbound({ value }, getRemoteSanitizerOptions(authorization)) as { value?: unknown }
	).value;
	return truncateUnicodeScalars(typeof sanitized === "string" ? sanitized : "", maxLength);
}

function sanitizeRemoteTranscriptText(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	layout: IrohRemoteTranscriptTextLayout = "preserve",
	maxScalars?: number,
) {
	return sanitizeIrohRemoteTranscriptText(
		typeof value === "string" ? value : "",
		getRemoteSanitizerOptions(authorization),
		layout,
		maxScalars,
	);
}

// ============================================================================
// Transcript projection
// ============================================================================

interface RemoteTranscriptRequest {
	limit: number;
	beforeEntryId?: string;
}

export interface RemoteConversationTranscriptPageOptions {
	beforeEntryId?: string;
	limit?: number;
	branchEpoch?: string;
	/** Internal override for deterministic boundary tests. */
	maxSerializedBytes?: number;
}

function parseRemoteTranscriptLimit(
	command: Record<string, unknown>,
): { ok: true; limit: number } | { ok: false; error: string } {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_TRANSCRIPT_DEFAULT_LIMIT };
	}
	if (
		typeof command.limit !== "number" ||
		!Number.isFinite(command.limit) ||
		!Number.isInteger(command.limit) ||
		command.limit <= 0
	) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_TRANSCRIPT_MAX_LIMIT) };
}

function isValidRemoteTranscriptCursor(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Array.from(value).length <= REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS &&
		Buffer.byteLength(value, "utf8") <= REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES
	);
}

function parseRemoteTranscriptRequest(
	command: Record<string, unknown>,
): ({ ok: true } & RemoteTranscriptRequest) | { ok: false; error: string } {
	const limit = parseRemoteTranscriptLimit(command);
	if (!limit.ok) {
		return limit;
	}
	if (command.beforeEntryId !== undefined && !isValidRemoteTranscriptCursor(command.beforeEntryId)) {
		return { ok: false, error: "invalid_cursor" };
	}
	return {
		ok: true,
		limit: limit.limit,
		...(command.beforeEntryId === undefined ? {} : { beforeEntryId: command.beforeEntryId as string }),
	};
}

function extractTranscriptContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRemoteRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

export interface RemoteTranscriptItem {
	entryId: string;
	ordinal: number;
	createdAt: string;
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	truncated: boolean;
	/** Stable submitting-client identity. Omitted for host-local user messages. */
	clientMessageId?: string;
	/** Inline image blocks persisted on the message (user attachments or tool
	 *  results such as image reads); recoverable per entry via
	 *  get_message_images. */
	imageCount?: number;
	toolName?: string;
	status?: "completed" | "failed";
	summary?: string;
	path?: string;
	args?: Record<string, unknown>;
	details?: Record<string, unknown>;
	output?: string;
	outputTruncated?: boolean;
	parts?: RpcConversationAssistantPart[];
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

/**
 * Sanitized, bounded tool result text for remote clients. Layout is preserved
 * (unlike tool summaries) so the phone can render real output; the scalar cap
 * keeps a single transcript item within remote stream size expectations.
 */
function sanitizeRemoteToolOutput(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	hostTruncated = false,
): { text: string; truncated: boolean } | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	const sanitized = sanitizeRemoteTranscriptText(value, authorization, "preserve");
	const scalars = Array.from(sanitized.text);
	const truncated = sanitized.truncated || hostTruncated || scalars.length > REMOTE_TOOL_OUTPUT_MAX_SCALARS;
	return {
		text:
			scalars.length > REMOTE_TOOL_OUTPUT_MAX_SCALARS
				? scalars.slice(0, REMOTE_TOOL_OUTPUT_MAX_SCALARS).join("")
				: sanitized.text,
		truncated,
	};
}

function createRemoteTranscriptItem(
	entry: SessionEntry,
	role: RemoteTranscriptItem["role"],
	text: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	layout: IrohRemoteTranscriptTextLayout = role === "tool" ? "summary" : "preserve",
	maxScalars?: number,
): RemoteTranscriptItem {
	const sanitized = sanitizeRemoteTranscriptText(text, authorization, layout, maxScalars);
	return {
		entryId: entry.id,
		ordinal: entry.ordinal ?? 0,
		createdAt: toRemoteSessionTimestamp(entry.timestamp),
		role,
		text: sanitized.text,
		truncated: sanitized.truncated,
	};
}

function projectRemoteAssistantParts(
	content: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxScalars?: number,
): RpcConversationAssistantPart[] {
	if (!Array.isArray(content)) {
		return [];
	}
	const parts: RpcConversationAssistantPart[] = [];
	for (const part of content) {
		if (!isRemoteRecord(part)) {
			continue;
		}
		// Empty canonical blocks still own an ordered content index. Preserve them
		// so transcript commits can claim the exact live assistant block shape.
		if (part.type === "text" && typeof part.text === "string") {
			const sanitized = sanitizeRemoteTranscriptText(part.text, authorization, "preserve", maxScalars);
			parts.push({ type: "text", text: sanitized.text, truncated: sanitized.truncated });
			continue;
		}
		if (part.type === "thinking" && part.redacted === true) {
			parts.push({ type: "thinking", text: "", redacted: true });
			continue;
		}
		if (part.type === "thinking" && typeof part.thinking === "string") {
			const sanitized = sanitizeRemoteTranscriptText(part.thinking, authorization, "preserve", maxScalars);
			parts.push({ type: "thinking", text: sanitized.text, truncated: sanitized.truncated });
		}
	}
	return parts;
}

/**
 * True when an assistant message's cumulative text/thinking content fits the
 * elevated final-entry budget. Decided on canonical content; the elevated
 * scalar cap remains as a fail-safe on the sanitized output.
 */
function isFullContentProjectableAssistantMessage(content: unknown): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	let remaining = REMOTE_TRANSCRIPT_FINAL_ASSISTANT_MAX_CONTENT_UTF8_BYTES;
	for (const part of content) {
		if (!isRemoteRecord(part)) {
			continue;
		}
		const text =
			part.type === "text" && typeof part.text === "string"
				? part.text
				: part.type === "thinking" && part.redacted !== true && typeof part.thinking === "string"
					? part.thinking
					: undefined;
		if (text === undefined || text.length === 0) {
			continue;
		}
		if (remaining <= 0) {
			return false;
		}
		const bytes = measureConversationProjectionUtf8BytesWithin(text, remaining);
		if (bytes === null) {
			return false;
		}
		remaining -= bytes;
	}
	return true;
}

/** True when an assistant message carries any non-empty text/thinking content the elevated budget could preserve. */
function hasProjectableAssistantContent(content: unknown): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	return content.some(
		(part) =>
			isRemoteRecord(part) &&
			((part.type === "text" && typeof part.text === "string" && part.text.length > 0) ||
				(part.type === "thinking" &&
					part.redacted !== true &&
					typeof part.thinking === "string" &&
					part.thinking.length > 0)),
	);
}

/**
 * Newest assistant message entry with non-empty text/thinking content in a
 * head window; only it earns the elevated text budget. Entries that project
 * empty (tool-call-only messages, identity-only aborted/error terminals) are
 * skipped so the budget lands on the last real answer instead.
 */
function findLatestAssistantMessageEntryId(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") {
			continue;
		}
		const message = entry.message as unknown as Record<string, unknown>;
		if (message?.role === "assistant" && hasProjectableAssistantContent(message.content)) {
			return entry.id;
		}
	}
	return undefined;
}

function getRemoteStopReason(value: unknown): RemoteTranscriptItem["stopReason"] {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted"
		? value
		: undefined;
}

interface RemoteToolCallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export function projectRemoteTranscriptEntry(
	entry: SessionEntry,
	authorization: IrohRemoteClientAuthorizationSuccess,
	toolCallsById: Map<string, RemoteToolCallRecord>,
	finalAssistantEntry = false,
): RemoteTranscriptItem | undefined {
	if (!entry || typeof entry !== "object") {
		return undefined;
	}
	if (entry.type === "compaction") {
		const item = createRemoteTranscriptItem(entry, "system", entry.summary, authorization);
		return item.text.length > 0 ? item : undefined;
	}
	if (entry.type === "custom_message") {
		const role = getRemoteVisibleCustomMessageRole(entry.customType, entry.display);
		if (role === undefined) {
			return undefined;
		}
		const text = extractTranscriptContentText(entry.content);
		return text ? createRemoteTranscriptItem(entry, role, text, authorization) : undefined;
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
		return undefined;
	}
	const message = entry.message as unknown as Record<string, unknown>;
	if (message.role === "user" || message.role === "assistant") {
		// The branch-latest assistant message ships complete (up to the elevated
		// byte budget) so late-attaching clients can converge on text the live
		// stream no longer serves after message_end.
		const fullContentMaxScalars =
			finalAssistantEntry &&
			message.role === "assistant" &&
			isFullContentProjectableAssistantMessage(message.content)
				? REMOTE_TRANSCRIPT_FINAL_ASSISTANT_TEXT_MAX_SCALARS
				: undefined;
		const parts =
			message.role === "assistant"
				? projectRemoteAssistantParts(message.content, authorization, fullContentMaxScalars)
				: [];
		const stopReason = message.role === "assistant" ? getRemoteStopReason(message.stopReason) : undefined;
		const text =
			message.role === "assistant"
				? parts
						.filter(
							(part): part is Extract<RpcConversationAssistantPart, { type: "text" }> => part.type === "text",
						)
						.map((part) => part.text)
						.join("")
				: extractTranscriptContentText(message.content);
		const imageCount = message.role === "user" ? extractMessageImages(message.content).length : 0;
		const isIdentityOnlyTerminal =
			message.role === "assistant" && (stopReason === "aborted" || stopReason === "error");
		if (!text && imageCount === 0 && parts.length === 0 && !isIdentityOnlyTerminal) {
			return undefined;
		}
		const item = createRemoteTranscriptItem(
			entry,
			message.role,
			text,
			authorization,
			"preserve",
			fullContentMaxScalars,
		);
		if (message.role === "user" && typeof message.clientMessageId === "string") {
			item.clientMessageId = message.clientMessageId;
		}
		if (parts.length > 0) {
			item.parts = parts;
			item.truncated ||= parts.some((part) => part.truncated === true);
		}
		if (message.role === "assistant") {
			item.stopReason = stopReason;
		}
		if (imageCount > 0) {
			item.imageCount = imageCount;
		}
		return item;
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "failed" : "completed";
		const toolName =
			typeof message.toolName === "string" && message.toolName.trim() ? message.toolName.trim() : "tool";
		const toolCall = typeof message.toolCallId === "string" ? toolCallsById.get(message.toolCallId) : undefined;
		const args = isRemoteRecord(toolCall?.arguments) ? toolCall.arguments : undefined;
		const path = getRemoteToolPath(toolName, args, authorization);
		const summary = summarizeRemoteToolResult(toolName, status, args, path, authorization);
		const item = createRemoteTranscriptItem(entry, "tool", summary, authorization);
		item.toolName = toolName;
		item.status = status;
		item.summary = summary;
		if (path) {
			item.path = path;
		}
		const projectedArgs = projectRemoteToolArgs(toolName, args, authorization);
		if (projectedArgs) {
			item.args = projectedArgs;
		}
		if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
			const details = projectRemoteSubagentDetails(message.details, authorization);
			if (details) {
				item.details = details;
			}
		}
		const output = sanitizeRemoteToolOutput(extractTranscriptContentText(message.content), authorization);
		if (output) {
			item.output = output.text;
			item.outputTruncated = output.truncated;
		}
		const imageCount = extractMessageImages(message.content).length;
		if (imageCount > 0) {
			item.imageCount = imageCount;
		}
		return item;
	}
	if (message.role === "bashExecution") {
		const failed = message.cancelled === true || (message.exitCode !== undefined && message.exitCode !== 0);
		const status = failed ? "failed" : "completed";
		const exit = message.cancelled
			? "cancelled"
			: message.exitCode === undefined
				? status
				: `exit ${message.exitCode}`;
		const command = remoteString(message.command, authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
		const summary = command ? `Ran command: ${command} (${exit})` : `bash ${exit}`;
		const item = createRemoteTranscriptItem(entry, "tool", summary, authorization);
		item.toolName = "bash";
		item.status = status;
		item.summary = summary;
		if (command) {
			item.args = { command };
		}
		const output = sanitizeRemoteToolOutput(message.output, authorization, message.truncated === true);
		if (output) {
			item.output = output.text;
			item.outputTruncated = output.truncated;
		}
		return item;
	}
	return undefined;
}

export function projectRemoteTranscriptItems(
	sessionManager: Pick<SessionManager, "getBranchWindow">,
	authorization: IrohRemoteClientAuthorizationSuccess,
): RemoteTranscriptItem[] {
	const window = sessionManager.getBranchWindow({
		maxEntries: REMOTE_TRANSCRIPT_SOURCE_WINDOW_MAX_ENTRIES,
		lookbackEntries: REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES,
	});
	if (!window) return [];
	const boundedBranch = [...window.lookback, ...window.entries];
	const toolCallsById = collectRemoteToolCalls(boundedBranch);
	const fullContentEntryId = findLatestAssistantMessageEntryId(window.entries);
	return window.entries
		.map((entry) =>
			projectRemoteTranscriptEntry(entry, authorization, toolCallsById, entry.id === fullContentEntryId),
		)
		.filter((item): item is RemoteTranscriptItem => item !== undefined);
}

export interface RemoteConversationTranscriptPage extends Record<string, unknown> {
	workspaceName: string;
	sessionId: string;
	items: RemoteTranscriptItem[];
	hasMore: boolean;
	nextBeforeEntryId: string | null;
	projectionVersion: number;
	branchEpoch: string;
	head: { entryId: string; ordinal: number } | null;
}

/**
 * Build the authoritative, subscriber-projected recent transcript used by
 * initial bootstrap and recovery checkpoints. This is synchronous so it can be
 * captured inside the feed's atomic snapshot-and-subscribe cut.
 */
export function createRemoteConversationTranscriptPage(
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
	options: RemoteConversationTranscriptPageOptions = {},
): RemoteConversationTranscriptPage | undefined {
	const requestedLimit = options.limit ?? 100;
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
		throw new Error("Transcript page limit must be a positive safe integer");
	}
	const maxSerializedBytes = options.maxSerializedBytes ?? REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES;
	if (!Number.isSafeInteger(maxSerializedBytes) || maxSerializedBytes <= 0) {
		throw new Error("Transcript page byte budget must be a positive safe integer");
	}
	const limit = Math.min(requestedLimit, REMOTE_TRANSCRIPT_MAX_LIMIT);
	const sourceWindowSize = Math.min(
		REMOTE_TRANSCRIPT_SOURCE_WINDOW_MAX_ENTRIES,
		Math.max(REMOTE_TRANSCRIPT_SOURCE_WINDOW_MIN_ENTRIES, limit * REMOTE_TRANSCRIPT_SOURCE_WINDOW_MULTIPLIER),
	);
	const window = runtime.session.sessionManager.getBranchWindow({
		...(options.beforeEntryId === undefined ? {} : { beforeEntryId: options.beforeEntryId }),
		maxEntries: sourceWindowSize,
		lookbackEntries: REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES,
	});
	if (!window) return undefined;
	const boundedBranch = [...window.lookback, ...window.entries];
	// Only head pages (no cursor) can identify the branch-latest assistant
	// message; older pages keep the default truncation.
	const fullContentEntryId =
		options.beforeEntryId === undefined ? findLatestAssistantMessageEntryId(window.entries) : undefined;
	const projectedItems = projectRemoteTranscriptWindow(
		boundedBranch,
		window.lookback.length,
		boundedBranch.length,
		authorization,
		fullContentEntryId,
	);
	const leaf = runtime.session.sessionManager.getLeafEntry();
	if (leaf !== undefined && (!Number.isSafeInteger(leaf.ordinal) || (leaf.ordinal ?? 0) <= 0)) {
		throw new Error("Active conversation leaf is missing its positive commit ordinal");
	}
	const fixedFields = {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		projectionVersion: REMOTE_TRANSCRIPT_PROJECTION_VERSION,
		branchEpoch: options.branchEpoch ?? runtime.session.sessionId,
		head: leaf === undefined ? null : { entryId: leaf.id, ordinal: leaf.ordinal! },
	};
	const page = createRemoteTranscriptPage(projectedItems, {
		fixedFields,
		hasEarlierSourceEntries: window.hasEarlier || window.lookback.length > 0,
		fallbackBeforeEntryId: window.hasEarlier || window.lookback.length > 0 ? window.entries[0]?.id : undefined,
		limit,
		maxSerializedBytes,
	});
	return { ...fixedFields, ...page };
}

/** Project one committed entry with the same authorization rules as transcript pages. */
export function createRemoteConversationTranscriptEntry(
	entry: SessionEntry,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): RemoteTranscriptItem | undefined {
	const window = runtime.session.sessionManager.getBranchWindow({
		maxEntries: 1,
		lookbackEntries: REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES,
	});
	const isCurrentCommit = window?.entries.at(-1)?.id === entry.id;
	const toolCallsById = isCurrentCommit
		? collectRemoteToolCalls([...(window?.lookback ?? []), ...(window?.entries ?? [])])
		: new Map<string, RemoteToolCallRecord>();
	const finalAssistantEntry =
		isCurrentCommit &&
		entry.type === "message" &&
		(entry.message as unknown as Record<string, unknown>)?.role === "assistant";
	return projectRemoteTranscriptEntry(entry, authorization, toolCallsById, finalAssistantEntry);
}

function projectRemoteTranscriptWindow(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	authorization: IrohRemoteClientAuthorizationSuccess,
	fullContentEntryId?: string,
): RemoteTranscriptItem[] {
	const toolCallsById = collectRemoteToolCalls(
		entries,
		Math.max(0, startIndex - REMOTE_TRANSCRIPT_TOOL_CALL_LOOKBACK_ENTRIES),
		endIndex,
	);
	const items: RemoteTranscriptItem[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (!entry) {
			continue;
		}
		const item = projectRemoteTranscriptEntry(
			entry,
			authorization,
			toolCallsById,
			fullContentEntryId !== undefined && entry.id === fullContentEntryId,
		);
		if (item) {
			items.push(item);
		}
	}
	return items;
}

function collectRemoteToolCalls(
	entries: SessionEntry[],
	startIndex = 0,
	endIndex = entries.length,
): Map<string, RemoteToolCallRecord> {
	const toolCallsById = new Map<string, RemoteToolCallRecord>();
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (!entry) {
			continue;
		}
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message as unknown as Record<string, unknown>;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (
				isRemoteRecord(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				isRemoteRecord(block.arguments)
			) {
				toolCallsById.set(block.id, {
					id: block.id,
					name: block.name,
					arguments: block.arguments,
				});
			}
		}
	}
	return toolCallsById;
}

function projectRemoteToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		return projectRemoteSubagentArgs(args, authorization);
	}
	if (!isRemoteRecord(args)) {
		return undefined;
	}

	const projected: Record<string, unknown> = {};
	switch (toolName) {
		case "bash":
			copyRemoteString(args, projected, "command", authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
			copyRemoteNumber(args, projected, "timeout");
			break;
		case "read":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "offset");
			copyRemoteNumber(args, projected, "limit");
			break;
		case "edit":
		case "write":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			break;
		case "grep":
			copyRemoteString(args, projected, "pattern", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "glob", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "include", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "exclude", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteBoolean(args, projected, "ignoreCase");
			copyRemoteBoolean(args, projected, "literal");
			copyRemoteNumber(args, projected, "context");
			break;
		case "find":
			copyRemoteString(args, projected, "query", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "pattern", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "glob", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "name", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			break;
		case "ls":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			break;
		case "lsp":
			copyRemoteString(args, projected, "action", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "symbol", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "line");
			break;
		case "web_search":
			copyRemoteString(args, projected, "query", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteStringArray(args, projected, "domains", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			copyRemoteNumber(args, projected, "recencyDays");
			break;
		case "web_fetch":
			copyRemoteString(args, projected, "url", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "maxBytes");
			break;
		default:
			break;
	}

	return Object.keys(projected).length > 0 ? projected : undefined;
}

function getRemoteToolPath(
	toolName: string,
	args: Record<string, unknown> | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	if (!isRemoteRecord(args)) {
		return undefined;
	}
	switch (toolName) {
		case "read":
		case "edit":
		case "write":
		case "lsp":
			return (
				remoteString(args.path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS) ??
				remoteString(args.file_path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS)
			);
		case "grep":
		case "find":
		case "ls":
			return remoteString(args.path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
		default:
			return undefined;
	}
}

function summarizeRemoteToolResult(
	toolName: string,
	status: "completed" | "failed",
	args: Record<string, unknown> | undefined,
	path: string | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string {
	const statusText = status === "failed" ? "failed" : "completed";
	if (toolName === "bash") {
		const command = remoteString(args?.command, authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
		if (command) {
			return `Ran command: ${command} (${statusText})`;
		}
	}
	if (toolName === "read" && path) {
		return `Read ${path} (${statusText})`;
	}
	if (path) {
		return `${toolName} ${path} (${statusText})`;
	}
	return `${toolName} ${statusText}`;
}

function projectRemoteSubagentArgs(
	args: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(args)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: RemoteSubagentProjectionBudget = { remainingNodes: REMOTE_SUBAGENT_GLOBAL_NODE_LIMIT };
	copyRemoteString(args, projected, "agent", authorization, 200);
	copyRemoteString(args, projected, "task", authorization, 1000);
	const tasks = projectRemoteSubagentInputArray(args.tasks, authorization, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectRemoteSubagentInputArray(args.chain, authorization, budget);
	if (chain) {
		projected.chain = chain;
	}
	if (typeof args.list === "boolean") {
		projected.list = args.list;
	}
	copyRemoteNumber(args, projected, "cursor");
	copyRemoteString(args, projected, "follow", authorization, 200);
	copyRemoteString(args, projected, "resume", authorization, 200);
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentInputArray(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	budget: RemoteSubagentProjectionBudget,
): Array<{ agent: string; task: string }> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected: Array<{ agent: string; task: string }> = [];
	for (
		let index = 0;
		index < value.length && index < REMOTE_SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const item = value[index];
		if (!isRemoteRecord(item)) continue;
		const agent = remoteString(item.agent, authorization, 200);
		const task = remoteString(item.task, authorization, 1000);
		if (agent && task) projected.push({ agent, task });
	}
	return projected.length > 0 ? projected : undefined;
}

function projectRemoteSubagentDetails(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const budget: RemoteSubagentProjectionBudget = { remainingNodes: REMOTE_SUBAGENT_GLOBAL_NODE_LIMIT };
	copyRemoteString(value, projected, "mode", authorization, 200);
	copyRemoteString(value, projected, "status", authorization, 200);
	copyRemoteString(value, projected, "subagentId", authorization, 200);
	copyRemoteString(value, projected, "sessionId", authorization, 200);
	copyRemoteSubagentNumericDetails(value, projected);
	copyRemoteString(value, projected, "currentActivity", authorization, 300);
	const summary = projectRemoteSubagentSummary(value.summary);
	if (summary) {
		projected.summary = summary;
	}
	const childSessions = projectRemoteSubagentDetailArray(value.childSessions, authorization, budget);
	if (childSessions) {
		projected.childSessions = childSessions;
	}
	const agent = projectRemoteSubagentAgent(value.agent, authorization);
	if (agent) {
		projected.agent = agent;
	}
	const output = projectRemoteSubagentOutput(value.output, authorization);
	if (output) {
		projected.output = output;
	}
	const error = projectRemoteSubagentError(value.error, authorization);
	if (error) {
		projected.error = error;
	}
	const children = projectRemoteSubagentDetailArray(value.children, authorization, budget);
	if (children) {
		projected.children = children;
	}
	const tasks = projectRemoteSubagentDetailArray(value.tasks, authorization, budget);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectRemoteSubagentDetailArray(value.steps, authorization, budget);
	if (steps) {
		projected.steps = steps;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

const REMOTE_SUBAGENT_NUMERIC_KEYS = ["startedAt", "durationMs", "toolCalls", "tokens"] as const;
const REMOTE_SUBAGENT_TREE_DEPTH_LIMIT = 5;
const REMOTE_SUBAGENT_ARRAY_ITEM_LIMIT = 64;
const REMOTE_SUBAGENT_GLOBAL_NODE_LIMIT = 128;

interface RemoteSubagentProjectionBudget {
	remainingNodes: number;
}

function copyRemoteSubagentNumericDetails(from: Record<string, unknown>, to: Record<string, unknown>): void {
	for (const key of REMOTE_SUBAGENT_NUMERIC_KEYS) {
		const numberValue = remoteFiniteNumber(from[key]);
		if (numberValue !== undefined) {
			to[key] = numberValue;
		}
	}
}

function projectRemoteSubagentSummary(value: unknown): Record<string, number> | undefined {
	if (!isRemoteRecord(value)) {
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
		const numberValue = remoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentDetailArray(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	budget: RemoteSubagentProjectionBudget,
	depth = 0,
): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value) || depth >= REMOTE_SUBAGENT_TREE_DEPTH_LIMIT) {
		return undefined;
	}
	const projected: Array<Record<string, unknown>> = [];
	for (
		let index = 0;
		index < value.length && index < REMOTE_SUBAGENT_ARRAY_ITEM_LIMIT && budget.remainingNodes > 0;
		index++
	) {
		budget.remainingNodes--;
		const task = projectRemoteSubagentTask(value[index], authorization, budget, depth);
		if (task) projected.push(task);
	}
	return projected.length > 0 ? projected : undefined;
}

function projectRemoteSubagentTask(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	budget: RemoteSubagentProjectionBudget,
	depth = 0,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const index = remoteFiniteNumber(value.index);
	if (index !== undefined) {
		projected.index = index;
	}
	copyRemoteString(value, projected, "subagentId", authorization, 200);
	copyRemoteString(value, projected, "sessionId", authorization, 200);
	const agent = projectRemoteSubagentAgent(value.agent, authorization);
	if (agent) {
		projected.agent = agent;
	}
	copyRemoteString(value, projected, "status", authorization, 200);
	copyRemoteString(value, projected, "task", authorization, 1_000);
	copyRemoteSubagentNumericDetails(value, projected);
	copyRemoteString(value, projected, "currentActivity", authorization, 300);
	const error = projectRemoteSubagentError(value.error, authorization);
	if (error) {
		projected.error = error;
	}
	const children = projectRemoteSubagentDetailArray(value.children, authorization, budget, depth + 1);
	if (children) {
		projected.children = children;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentAgent(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(value, projected, "name", authorization, 200);
	copyRemoteString(value, projected, "source", authorization, 200);
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentOutput(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(value, projected, "text", authorization, 1000);
	for (const key of ["bytes", "omittedBytes", "maxBytes"]) {
		const numberValue = remoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	if (typeof value.truncated === "boolean") {
		projected.truncated = value.truncated;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentError(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): { message: string } | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const message = remoteString(value.message, authorization, 1000);
	return message ? { message } : undefined;
}

function remoteString(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): string | undefined {
	return typeof value === "string" && value.trim()
		? sanitizeRemoteTextField(value, maxLength, authorization)
		: undefined;
}

function copyRemoteString(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): void {
	const value = remoteString(from[key], authorization, maxLength);
	if (value) {
		to[key] = value;
	}
}

function copyRemoteNumber(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = remoteFiniteNumber(from[key]);
	if (value !== undefined) {
		to[key] = value;
	}
}

function copyRemoteBoolean(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	if (typeof from[key] === "boolean") {
		to[key] = from[key];
	}
}

function copyRemoteStringArray(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): void {
	const value = from[key];
	if (!Array.isArray(value)) {
		return;
	}
	const projected = value
		.slice(0, REMOTE_TOOL_ARGUMENT_KEYS_MAX)
		.map((entry) => remoteString(entry, authorization, maxLength))
		.filter((entry): entry is string => entry !== undefined);
	if (projected.length > 0) {
		to[key] = projected;
	}
}

function remoteFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRemoteRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRemoteTranscriptPage(
	items: RemoteTranscriptItem[],
	options: {
		fixedFields: Omit<RemoteConversationTranscriptPage, "items" | "hasMore" | "nextBeforeEntryId">;
		hasEarlierSourceEntries: boolean;
		fallbackBeforeEntryId?: string;
		limit: number;
		maxSerializedBytes: number;
	},
): Pick<RemoteConversationTranscriptPage, "items" | "hasMore" | "nextBeforeEntryId"> {
	let pageStart = items.length;
	let serializedItemBytes = 0;
	while (pageStart > 0 && items.length - pageStart < options.limit) {
		const candidateIndex = pageStart - 1;
		const candidate = items[candidateIndex];
		if (!candidate) {
			break;
		}
		const candidateItemBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
		const candidateCount = items.length - candidateIndex;
		const candidateHasMore = options.hasEarlierSourceEntries || candidateIndex > 0;
		const candidateBytes = measureRemoteTranscriptPageBytes(
			options.fixedFields,
			serializedItemBytes + candidateItemBytes,
			candidateCount,
			candidateHasMore,
			candidateHasMore ? candidate.entryId : null,
		);
		if (candidateBytes > options.maxSerializedBytes) {
			if (pageStart === items.length) {
				throw new Error(`Projected transcript entry ${candidate.entryId} exceeds the transcript page byte budget`);
			}
			break;
		}
		pageStart = candidateIndex;
		serializedItemBytes += candidateItemBytes;
	}

	const pageItems = items.slice(pageStart);
	const hasMore = options.hasEarlierSourceEntries || pageStart > 0;
	const nextBeforeEntryId = hasMore ? (pageItems[0]?.entryId ?? options.fallbackBeforeEntryId ?? null) : null;
	const serializedBytes = measureRemoteTranscriptPageBytes(
		options.fixedFields,
		serializedItemBytes,
		pageItems.length,
		hasMore,
		nextBeforeEntryId,
	);
	if (serializedBytes > options.maxSerializedBytes) {
		throw new Error("Transcript page metadata exceeds the transcript page byte budget");
	}
	return { items: pageItems, hasMore, nextBeforeEntryId };
}

/** Exact UTF-8 JSON size without repeatedly serializing the growing item array. */
function measureRemoteTranscriptPageBytes(
	fixedFields: Omit<RemoteConversationTranscriptPage, "items" | "hasMore" | "nextBeforeEntryId">,
	serializedItemBytes: number,
	itemCount: number,
	hasMore: boolean,
	nextBeforeEntryId: string | null,
): number {
	const emptyPageBytes = Buffer.byteLength(
		JSON.stringify({ ...fixedFields, items: [], hasMore, nextBeforeEntryId }),
		"utf8",
	);
	return emptyPageBytes + serializedItemBytes + Math.max(0, itemCount - 1);
}

export function createRemoteGetTranscriptRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
	branchEpoch?: string,
	isCursorValid?: (cursor: string) => boolean,
	registerCursor?: (cursor: string | null) => void,
): object {
	const id = getRpcResponseId(command);
	if (branchEpoch !== undefined) {
		if (typeof command.branchEpoch !== "string" || command.branchEpoch.length === 0) {
			return createIrohRemoteRpcErrorResponse(id, "get_transcript", "branch_epoch_required");
		}
		if (command.branchEpoch !== branchEpoch) {
			return createIrohRemoteRpcErrorResponse(id, "get_transcript", "stale_branch_epoch");
		}
	}
	const request = parseRemoteTranscriptRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", request.error);
	}
	if (request.beforeEntryId !== undefined && isCursorValid && !isCursorValid(request.beforeEntryId)) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", "invalid_cursor");
	}
	const page = createRemoteConversationTranscriptPage(authorization, runtime, {
		...request,
		...(branchEpoch === undefined ? {} : { branchEpoch }),
	});
	if (!page) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", "invalid_cursor");
	}
	registerCursor?.(page.nextBeforeEntryId);
	return createRpcSuccessResponse(id, "get_transcript", page);
}

export function createRemoteGetSessionTreeRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): object {
	const id = getRpcResponseId(command);
	if (
		command.limit !== undefined &&
		(typeof command.limit !== "number" || !Number.isSafeInteger(command.limit) || command.limit <= 0)
	) {
		return createIrohRemoteRpcErrorResponse(id, "get_session_tree", "invalid_limit");
	}
	if (
		command.afterOrdinal !== undefined &&
		(typeof command.afterOrdinal !== "number" ||
			!Number.isSafeInteger(command.afterOrdinal) ||
			command.afterOrdinal < 0)
	) {
		return createIrohRemoteRpcErrorResponse(id, "get_session_tree", "invalid_cursor");
	}
	const entries = runtime.session.sessionManager.getEntries?.();
	if (!entries) {
		return createIrohRemoteRpcErrorResponse(id, "get_session_tree", "unsupported_remote_command");
	}
	const activeBranch = runtime.session.sessionManager.getBranch();
	const toolCallsById = collectRemoteToolCalls(entries);
	const finalAssistantEntryId = findLatestAssistantMessageEntryId(activeBranch);
	let page: RpcSessionTreePage;
	try {
		page = projectSessionTreePage(entries, activeBranch, {
			workspaceName: authorization.workspace.name,
			sessionId: runtime.session.sessionId,
			limit: command.limit as number | undefined,
			afterOrdinal: command.afterOrdinal as number | undefined,
			projectTranscriptEntry: (entry): RpcConversationTranscriptItem | undefined =>
				projectRemoteTranscriptEntry(entry, authorization, toolCallsById, entry.id === finalAssistantEntryId),
		});
	} catch {
		return createIrohRemoteRpcErrorResponse(id, "get_session_tree", "session_tree_unavailable");
	}
	return createRpcSuccessResponse(id, "get_session_tree", page);
}

/**
 * The unbounded sanitized long-form text lane of one transcript entry — the
 * same composition the transcript projection truncates. Assistant entries
 * reuse the projection's per-part-then-join sanitize order so continuation
 * offsets stay aligned with the projected item text; tool entries serve the
 * output lane (the projection's `text` is a derived summary). Undefined for
 * entry kinds the remote projection never emits.
 */
function getRemoteTranscriptEntryCanonicalText(
	entry: SessionEntry,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	const sanitize = (value: unknown): string =>
		sanitizeRemoteTranscriptText(value, authorization, "preserve", Number.MAX_SAFE_INTEGER).text;
	if (!entry || typeof entry !== "object") {
		return undefined;
	}
	if (entry.type === "compaction") {
		return sanitize(entry.summary);
	}
	if (entry.type === "custom_message") {
		if (getRemoteVisibleCustomMessageRole(entry.customType, entry.display) === undefined) {
			return undefined;
		}
		return sanitize(extractTranscriptContentText(entry.content));
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
		return undefined;
	}
	const message = entry.message as unknown as Record<string, unknown>;
	if (message.role === "assistant") {
		const joined = Array.isArray(message.content)
			? message.content
					.filter(
						(part): part is { type: "text"; text: string } =>
							isRemoteRecord(part) && part.type === "text" && typeof part.text === "string",
					)
					.map((part) => sanitize(part.text))
					.join("")
			: "";
		return sanitize(joined);
	}
	if (message.role === "user" || message.role === "toolResult") {
		return sanitize(extractTranscriptContentText(message.content));
	}
	if (message.role === "bashExecution") {
		return sanitize(message.output);
	}
	return undefined;
}

/**
 * `get_transcript_entry_text`: one bounded chunk of a transcript entry's
 * sanitized canonical text. Transcript projections truncate long entries at
 * IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS (tool output even lower); remote
 * clients page in the remainder per entry through this response. Offsets are
 * Unicode-scalar indices into the sanitized canonical text, so chunks
 * concatenate exactly and remain stable across requests.
 */
export function createRemoteGetTranscriptEntryTextRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): object {
	const id = getRpcResponseId(command);
	if (!isValidRemoteTranscriptCursor(command.entryId)) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript_entry_text", "invalid_cursor");
	}
	let offset = 0;
	if (command.offset !== undefined) {
		if (typeof command.offset !== "number" || !Number.isSafeInteger(command.offset) || command.offset < 0) {
			return createIrohRemoteRpcErrorResponse(id, "get_transcript_entry_text", "invalid_request");
		}
		offset = command.offset;
	}
	const entry = runtime.session.sessionManager.getBranch().find((candidate) => candidate.id === command.entryId);
	const canonicalText = entry === undefined ? undefined : getRemoteTranscriptEntryCanonicalText(entry, authorization);
	if (canonicalText === undefined) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript_entry_text", "unknown_entry");
	}
	const scalars = Array.from(canonicalText);
	if (scalars.length === 0 ? offset !== 0 : offset >= scalars.length) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript_entry_text", "invalid_cursor");
	}
	const chunk = scalars.slice(offset, offset + IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);
	const nextOffset = offset + chunk.length < scalars.length ? offset + chunk.length : null;
	return createRpcSuccessResponse(id, "get_transcript_entry_text", {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		entryId: command.entryId,
		offset,
		text: chunk.join(""),
		truncated: nextOffset !== null,
		nextOffset,
		totalScalars: scalars.length,
	});
}

export function createRemoteGetMessageImagesRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): object {
	const id = getRpcResponseId(command);
	if (!isValidRemoteTranscriptCursor(command.entryId)) {
		return createIrohRemoteRpcErrorResponse(id, "get_message_images", "invalid_cursor");
	}
	let startImageIndex = 0;
	if (command.startImageIndex !== undefined) {
		if (
			typeof command.startImageIndex !== "number" ||
			!Number.isInteger(command.startImageIndex) ||
			command.startImageIndex < 0
		) {
			return createIrohRemoteRpcErrorResponse(id, "get_message_images", "invalid_request");
		}
		startImageIndex = command.startImageIndex;
	}
	const result = projectMessageImages(runtime.session.sessionManager.getBranch(), command.entryId, startImageIndex);
	if (!result.ok) {
		return createIrohRemoteRpcErrorResponse(id, "get_message_images", result.error);
	}
	return createRpcSuccessResponse(id, "get_message_images", {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		entryId: result.entryId,
		totalImages: result.totalImages,
		images: result.images,
		nextImageIndex: result.nextImageIndex,
	});
}

// ============================================================================
// Session listing
// ============================================================================

function toRemoteSessionTimestamp(value: string | number | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function getRemoteSessionTimestampMs(value: string): number {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

interface RemoteSessionSummaryInput {
	sessionId: string;
	title: unknown;
	createdAt: string | Date;
	updatedAt: string | Date;
	messageCount: number;
	cwd?: string;
	origin?: "subagent";
}

function getRelativeWorkingDirectory(rootPath: string, cwd: string | undefined): string | null | undefined {
	if (!cwd) {
		return undefined;
	}
	const root = resolve(rootPath);
	const child = resolve(cwd);
	const relativePath = relative(root, child);
	if (relativePath === "" || relativePath === ".") {
		return undefined;
	}
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return null;
	}
	return relativePath.split(sep).join("/");
}

interface RemoteSessionSummary {
	sortUpdatedAtMs: number;
	session: RemoteSessionListEntry;
	cwd?: string;
}

function createRemoteSessionSummary(
	input: RemoteSessionSummaryInput,
	authorization: IrohRemoteClientAuthorizationSuccess,
): RemoteSessionSummary {
	const createdAt = toRemoteSessionTimestamp(input.createdAt);
	const updatedAt = toRemoteSessionTimestamp(input.updatedAt);
	const workingDirectory = getRelativeWorkingDirectory(authorization.workspace.path, input.cwd);
	return {
		sortUpdatedAtMs: getRemoteSessionTimestampMs(updatedAt),
		session: {
			sessionId: input.sessionId,
			title: sanitizeRemoteTextField(typeof input.title === "string" ? input.title : "", 160, authorization),
			createdAt,
			updatedAt,
			messageCount: input.messageCount,
			...(input.origin === undefined ? {} : { origin: input.origin }),
			...(workingDirectory === undefined || workingDirectory === null ? {} : { workingDirectory }),
		},
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
	};
}

function sortRemoteSessionSummaries(left: RemoteSessionSummary, right: RemoteSessionSummary): number {
	return right.sortUpdatedAtMs - left.sortUpdatedAtMs || left.session.sessionId.localeCompare(right.session.sessionId);
}

export async function listRemoteWorkspaceSessionSummaries(
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime?: ConversationCommandRuntime,
): Promise<RemoteSessionSummary[]> {
	const bySessionId = new Map<string, RemoteSessionSummary>();
	if (runtime === undefined || context.agentDir !== undefined) {
		for (const info of await SessionManager.list(
			authorization.workspace.path,
			getDefaultSessionDir(authorization.workspace.path, context.agentDir),
		)) {
			const summary = createRemoteSessionSummary(
				{
					sessionId: info.id,
					title: info.name ?? info.firstMessage,
					createdAt: info.created,
					updatedAt: info.modified,
					messageCount: info.messageCount,
					cwd: info.cwd,
					...(info.origin === undefined ? {} : { origin: info.origin }),
				},
				authorization,
			);
			bySessionId.set(summary.session.sessionId, summary);
		}
	}
	if (runtime !== undefined) {
		for (const liveSummary of await runtime.listSessions()) {
			const summary = createRemoteSessionSummary(
				{
					sessionId: liveSummary.sessionId,
					title: liveSummary.sessionName ?? liveSummary.firstMessage,
					createdAt: liveSummary.createdAt,
					updatedAt: liveSummary.modifiedAt,
					messageCount: liveSummary.messageCount,
					cwd: liveSummary.cwd,
					...(liveSummary.origin === undefined ? {} : { origin: liveSummary.origin }),
				},
				authorization,
			);
			bySessionId.set(summary.session.sessionId, summary);
		}
	}
	// Worktree attribution (worktrees.v1): join the persisted session bindings so
	// clients can badge worktree-bound sessions without a separate list_worktrees
	// round trip. Ids only — checkout paths never reach the wire.
	try {
		for (const worktree of await context.stateManager.listWorktrees(authorization.workspace.name)) {
			for (const sessionId of worktree.sessionIds) {
				const summary = bySessionId.get(sessionId);
				if (summary) {
					summary.session.worktreeId = worktree.id;
					const worktreeRelativeDirectory = getRelativeWorkingDirectory(worktree.path, summary.cwd);
					if (worktreeRelativeDirectory === null) {
						delete summary.session.workingDirectory;
						continue;
					}
					const workingDirectory = getRegisteredWorkingDirectoryForWorktree(worktree, worktreeRelativeDirectory);
					if (workingDirectory === undefined) {
						delete summary.session.workingDirectory;
					} else {
						summary.session.workingDirectory = workingDirectory;
					}
				}
			}
		}
	} catch {
		// Attribution is best-effort; the session list itself stays authoritative.
	}
	try {
		const runtimeStates = await context.listRuntimeStates?.(authorization.workspace.name);
		if (runtimeStates) {
			for (const [sessionId, runtimeState] of runtimeStates) {
				const summary = bySessionId.get(sessionId);
				if (summary) {
					summary.session.runtimeState = runtimeState;
				}
			}
		}
	} catch {
		// Presence is best-effort; persisted session discovery remains authoritative.
	}
	return Array.from(bySessionId.values()).sort(sortRemoteSessionSummaries);
}

function cleanupExpiredSessionListCursors(context: ConversationCommandContext, now = contextNow(context)): void {
	for (const [cursor, entry] of context.sessionListCursors) {
		if (entry.expiresAt <= now) {
			context.sessionListCursors.delete(cursor);
		}
	}
}

function evictExcessSessionListCursors(
	context: ConversationCommandContext,
	clientNodeId: string,
	maxForClient: number,
): void {
	// Map iteration is insertion order, so this client's oldest cursors come first.
	const clientCursors: string[] = [];
	for (const [cursor, entry] of context.sessionListCursors) {
		if (entry.clientNodeId === clientNodeId) {
			clientCursors.push(cursor);
		}
	}
	// Drop oldest until inserting one more keeps this client within the cap.
	for (let index = 0; index <= clientCursors.length - maxForClient; index++) {
		context.sessionListCursors.delete(clientCursors[index]);
	}
}

function createSessionListCursor(
	context: ConversationCommandContext,
	authorization: IrohRemoteClientAuthorizationSuccess,
	sessions: RemoteSessionListEntry[],
	nextIndex: number,
): string {
	// Sweep expired entries on every insert (not only on the cursored read path) and
	// bound this client's retained cursors so a client that never echoes the returned
	// cursor cannot grow the shared, daemon-wide map without limit.
	cleanupExpiredSessionListCursors(context);
	evictExcessSessionListCursors(context, authorization.client.nodeId, REMOTE_SESSION_LIST_MAX_CURSORS_PER_CLIENT);
	const cursor = randomUUID();
	context.sessionListCursors.set(cursor, {
		clientNodeId: authorization.client.nodeId,
		workspaceName: authorization.workspace.name,
		sessions,
		nextIndex,
		expiresAt: contextNow(context) + context.sessionListCursorTtlMs,
	});
	return cursor;
}

function getSessionListCursorEntry(
	context: ConversationCommandContext,
	authorization: IrohRemoteClientAuthorizationSuccess,
	cursor: string,
): RemoteSessionListCursorEntry | undefined {
	cleanupExpiredSessionListCursors(context);
	const entry = context.sessionListCursors.get(cursor);
	if (
		!entry ||
		entry.clientNodeId !== authorization.client.nodeId ||
		entry.workspaceName !== authorization.workspace.name
	) {
		return undefined;
	}
	return entry;
}

function parseRemoteSessionListLimit(
	command: Record<string, unknown>,
): { ok: true; limit: number } | { ok: false; error: string } {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_SESSION_LIST_DEFAULT_LIMIT };
	}
	if (typeof command.limit !== "number" || !Number.isInteger(command.limit) || command.limit <= 0) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_SESSION_LIST_MAX_LIMIT) };
}

function parseRemoteSessionListRequest(
	command: Record<string, unknown>,
): { ok: true; limit: number; cursor?: string } | { ok: false; error: string } {
	if (Object.hasOwn(command, "sessionId")) {
		return { ok: false, error: "unexpected_session_id" };
	}
	for (const field of ["workspace", "workspaceName", "clientNodeId", "hostNodeId"]) {
		if (Object.hasOwn(command, field)) {
			return { ok: false, error: "session_mismatch" };
		}
	}
	for (const field of Object.keys(command)) {
		if (field !== "id" && field !== "type" && field !== "limit" && field !== "cursor") {
			return { ok: false, error: "invalid_request" };
		}
	}
	const limit = parseRemoteSessionListLimit(command);
	if (!limit.ok) {
		return limit;
	}
	if (command.cursor !== undefined) {
		if (
			typeof command.cursor !== "string" ||
			command.cursor.length === 0 ||
			Buffer.byteLength(command.cursor, "utf8") > REMOTE_SESSION_LIST_CURSOR_MAX_BYTES
		) {
			return { ok: false, error: "invalid_cursor" };
		}
	}
	return {
		ok: true,
		limit: limit.limit,
		...(command.cursor === undefined ? {} : { cursor: command.cursor as string }),
	};
}

export async function createRemoteListSessionsRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime?: ConversationCommandRuntime,
): Promise<object> {
	const id = getRpcResponseId(command);
	const request = parseRemoteSessionListRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "list_sessions", request.error);
	}

	let sessions: RemoteSessionListEntry[];
	let startIndex: number;
	if (request.cursor) {
		const cursorEntry = getSessionListCursorEntry(context, authorization, request.cursor);
		if (!cursorEntry) {
			return createIrohRemoteRpcErrorResponse(id, "list_sessions", "invalid_cursor");
		}
		sessions = cursorEntry.sessions;
		startIndex = cursorEntry.nextIndex;
	} else {
		sessions = (await listRemoteWorkspaceSessionSummaries(authorization, context, runtime)).map(
			(summary) => summary.session,
		);
		startIndex = 0;
	}

	const nextIndex = startIndex + request.limit;
	const page = sessions.slice(startIndex, nextIndex);
	const hasMore = nextIndex < sessions.length;
	return createRpcSuccessResponse(id, "list_sessions", {
		sessions: page,
		hasMore,
		nextCursor: hasMore ? createSessionListCursor(context, authorization, sessions, nextIndex) : null,
	});
}

// ============================================================================
// Identity checks, device logs, host commands
// ============================================================================

export function getIntegratedConversationIdentityError(
	command: Record<string, unknown>,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): string | undefined {
	const expectedWorkspaceName = authorization.workspace.name;
	for (const field of ["workspace", "workspaceName"]) {
		if (
			Object.hasOwn(command, field) &&
			(typeof command[field] !== "string" || command[field] !== expectedWorkspaceName)
		) {
			return "session_mismatch";
		}
	}
	if (
		Object.hasOwn(command, "sessionId") &&
		(typeof command.sessionId !== "string" || command.sessionId !== runtime.session.sessionId)
	) {
		return "session_mismatch";
	}
	return undefined;
}

async function createRemoteUploadDeviceLogsRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
): Promise<object> {
	const response = await handleIrohRemoteDeviceLogUploadRpcCommand(command, {
		workspacePath: authorization.workspace.path,
	});
	await logAudit(context.auditLogger, {
		type: "device_log_uploaded",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: response.success === true,
		error: response.success === true ? undefined : response.error,
		details: response.success === true ? { path: response.data.path, byteCount: response.data.byteCount } : undefined,
	});
	return response;
}

function updateAuthorizationWorkspaceMetadata(
	authorization: IrohRemoteClientAuthorizationSuccess,
	metadata: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> },
): void {
	authorization.workspaceNames = [...metadata.workspaceNames];
	authorization.workspaces = metadata.workspaces.map((workspace) => ({
		...workspace,
	})) as typeof authorization.workspaces;
}

export async function handleRemoteHostRpcCommand(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
): Promise<object | undefined> {
	// create_worktree / list_worktrees are accepted on conversation streams so a
	// phone can spin up a parallel isolated session without opening a separate
	// manage_worktrees stream. remove_worktree stays management-stream-only (a
	// destructive op keeps the narrower surface); the passthrough filter and the
	// relay command set never admit it here.
	if (command.type === IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE || command.type === IROH_REMOTE_LIST_WORKTREES_RPC_TYPE) {
		const backend = context.createWorktreeBackend?.(authorization.workspace);
		if (!backend) {
			return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "unsupported_remote_command");
		}
		const worktreeResult = await handleIrohRemoteWorktreeRpcCommand(command, {
			authorizedWorkspaceName: authorization.workspace.name,
			backend,
		});
		if (!worktreeResult.handled) {
			return undefined;
		}
		if (worktreeResult.audit) {
			await logAudit(context.auditLogger, {
				type: worktreeResult.audit.type,
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: true,
				details: { ...worktreeResult.audit.details, source: "remote_rpc" },
			});
		}
		return worktreeResult.response;
	}
	if (command.type === IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE) {
		// Conversation and relay unregister is scoped to the stream-bound workspace:
		// the documented `workspaceName` must be present and equal the authorized
		// workspace, so a client cannot unregister an unrelated registered workspace
		// by name. The relay path bypasses getIntegratedConversationIdentityError, so
		// this is the authoritative scope check for it; the dedicated
		// workspaceManagement stream enforces the same rule (workspace-streams.ts).
		if (typeof command.workspaceName !== "string" || command.workspaceName !== authorization.workspace.name) {
			return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "session_mismatch");
		}
	}
	let result: Awaited<ReturnType<typeof handleIrohRemoteWorkspaceUnregisterRpcCommand>>;
	try {
		result = await handleIrohRemoteWorkspaceUnregisterRpcCommand(command, {
			classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
			stateManager: context.stateManager,
		});
	} catch (error) {
		return createIrohRemoteRpcErrorResponse(
			getRpcResponseId(command),
			command.type,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!result.handled) {
		return undefined;
	}
	if (result.metadata) {
		updateAuthorizationWorkspaceMetadata(authorization, result.metadata);
	}
	if (result.response.success === true) {
		context.hostEngine?.clearPairingSecretForWorkspace(authorization.workspace.name);
		await context.onWorkspaceUnregistered?.(authorization.workspace.name);
	}
	await logAudit(context.auditLogger, {
		type: "workspace_unregistered",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: result.response.success === true,
		error: result.response.success === true ? undefined : result.response.error,
		details: { source: "remote_rpc" },
	});
	return result.response;
}

/**
 * `set_keep_awake` / `get_keep_awake` from a phone. Host-level (not
 * conversation-level): any paired client with stream access may toggle it. The
 * wire status strips the host-local mechanism name.
 */
export function createKeepAwakeRpcResponse(
	command: RemoteRpcCommand,
	context: ConversationCommandContext,
): Record<string, unknown> | IrohRemoteRpcErrorResponse {
	const id = getRpcResponseId(command);
	const keepAwake = context.keepAwake;
	if (!keepAwake) {
		return createIrohRemoteRpcErrorResponse(id, command.type, "unsupported_remote_command");
	}
	if (command.type === "set_keep_awake") {
		if (typeof command.enabled !== "boolean") {
			return createIrohRemoteRpcErrorResponse(id, command.type, "set_keep_awake requires a boolean enabled");
		}
		const status = keepAwake.setEnabled(command.enabled);
		context.onKeepAwakeSetting?.(command.enabled);
		return createRpcSuccessResponse(id, command.type, { keepAwake: toRpcKeepAwakeStatus(status) });
	}
	return createRpcSuccessResponse(id, command.type, { keepAwake: toRpcKeepAwakeStatus(keepAwake.status) });
}

/**
 * `set_web_search_key` / `get_web_search_status` from a phone. Host-level (not
 * conversation-level): any paired client with stream access may set it. The
 * wire status never includes the key itself, only whether one is stored.
 */
export function createWebSearchKeyRpcResponse(
	command: RemoteRpcCommand,
	context: ConversationCommandContext,
): Record<string, unknown> | IrohRemoteRpcErrorResponse {
	const id = getRpcResponseId(command);
	const webSearchKey = context.webSearchKey;
	if (!webSearchKey) {
		return createIrohRemoteRpcErrorResponse(id, command.type, "unsupported_remote_command");
	}
	if (command.type === "set_web_search_key") {
		const apiKey = command.apiKey;
		if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
			return createIrohRemoteRpcErrorResponse(
				id,
				command.type,
				"set_web_search_key requires apiKey to be a string or null",
			);
		}
		const normalized = typeof apiKey === "string" ? apiKey.trim() : "";
		webSearchKey.set(normalized.length > 0 ? normalized : null);
	}
	return createRpcSuccessResponse(id, command.type, { webSearch: { configured: webSearchKey.configured } });
}

export function toRpcKeepAwakeStatus(status: KeepAwakeStatus): RpcKeepAwakeStatus {
	return {
		enabled: status.enabled,
		state: status.state,
		...(status.reason === undefined ? {} : { reason: status.reason }),
	};
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Host-side handler for conversation-stream RPC commands that are not served
 * directly by the runtime's rpc mode. Returns undefined for commands the rpc
 * mode should handle itself — including abort, which stops the turn while the
 * stream stays open and the runtime stays live.
 */
export async function handleIntegratedConversationRpcCommand(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime: ConversationCommandRuntime,
): Promise<object | undefined> {
	if (context.isTurnAdmissionClosed?.() && TURN_INITIATING_RPC_TYPES.has(command.type)) {
		return createHostShutdownRpcErrorResponse(command);
	}
	if (context.isDraining?.() && TURN_INITIATING_RPC_TYPES.has(command.type)) {
		return createLeaseDrainingRpcErrorResponse(command);
	}
	// Defense in depth: the phone hides the composer for subagent tabs, but a
	// stray client must not be able to inject turns into a delegated child run.
	if (context.isSubagentSession?.() && TURN_INITIATING_RPC_TYPES.has(command.type)) {
		return createSubagentSessionReadOnlyRpcErrorResponse(command);
	}
	if (command.type === "list_sessions") {
		return await createRemoteListSessionsRpcResponse(command, authorization, context, runtime);
	}
	if (command.type === "set_keep_awake" || command.type === "get_keep_awake") {
		return createKeepAwakeRpcResponse(command, context);
	}
	if (command.type === "set_web_search_key" || command.type === "get_web_search_status") {
		return createWebSearchKeyRpcResponse(command, context);
	}
	if (INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES.has(command.type)) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "unsupported_remote_command");
	}
	const identityError = getIntegratedConversationIdentityError(command, authorization, runtime);
	if (identityError) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, identityError);
	}
	if (command.type === "upload_device_logs") {
		return await createRemoteUploadDeviceLogsRpcResponse(command, authorization, context);
	}
	if (command.type === "get_transcript") {
		return createRemoteGetTranscriptRpcResponse(
			command,
			authorization,
			runtime,
			context.getConversationBranchEpoch?.(),
			context.isConversationTranscriptCursorValid,
			context.registerConversationTranscriptCursor,
		);
	}
	if (command.type === "get_session_tree") {
		return createRemoteGetSessionTreeRpcResponse(command, authorization, runtime);
	}
	if (command.type === "get_message_images") {
		return createRemoteGetMessageImagesRpcResponse(command, authorization, runtime);
	}
	if (command.type === "get_transcript_entry_text") {
		return createRemoteGetTranscriptEntryTextRpcResponse(command, authorization, runtime);
	}
	return await handleRemoteHostRpcCommand(command, authorization, context);
}
