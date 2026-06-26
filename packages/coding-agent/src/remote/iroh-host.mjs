import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants, rmSync } from "node:fs";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import {
	createIrohRemoteHandshakeFailure,
	createIrohRemoteHandshakeSuccess,
	createIrohRemoteHostMetadata,
	createIrohRemoteRpcErrorResponse,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
	DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
	DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	encodeIrohRemoteTicketPayload,
	formatIrohRemoteTicketQrCode,
	getDefaultSessionDir,
	getIrohRemoteControlPath,
	getIrohRemoteRpcFilterResult,
	getIrohRemoteUnsafeAllowedTools,
	getIrohRemoteVoltRpcToolArgs,
	getIrohRemoteWorkspaceAvailabilityStatus,
	handleIrohRemoteWorkspaceUnregisterRpcCommand,
	hasTrustRequiringProjectResources,
	IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE,
	IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
	IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
	getAgentDir,
	IROH_REMOTE_ALPN,
	IrohRemoteAuditLogger,
	IrohRemoteActiveStreamRegistry,
	IrohRemoteHandshakeError,
	IrohRemoteHostEngine,
	IrohRemoteHostStateManager,
	IrohRemoteInMemoryPushNotificationDeduper,
	isIrohRemoteSessionId,
	isIrohRemoteWorkspaceName,
	DEFAULT_IROH_REMOTE_PUSH_RELAY_URL,
	IrohRemotePushNotificationDispatcher,
	IrohRemotePushRelayHttpClient,
	listenIrohRemoteControlServer,
	parseIrohRemoteWorkspaceSpec,
	parseIrohRemoteControlRequest,
	ProjectTrustStore,
	resolveIrohRemoteWorkspaceProjectTrusted,
	pipeIrohRemoteOutboundJsonlReadable,
	readIrohRemoteHostState,
	requestIrohRemoteActiveRevocation,
	sanitizeIrohRemoteOutbound,
	sanitizeIrohRemoteOutboundJsonLine,
	selectIrohRemoteWorkspace,
	serializeJsonLine,
	serializeIrohRemoteRpcFilterRejection,
	SessionManager,
	writeIrohRemoteHandshakeResponse,
	writeIrohRemoteHostState,
	createIrohRemoteAgentRuntimeWithSessionSelection,
	parseIntegratedDetachedRuntimeTtlMs,
	runIrohRemoteRpcMode,
	scheduleDetachedRuntimeRetention,
	shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization,
} from "@earendil-works/volt-coding-agent";
import nativeAdapter from "./iroh-native-adapter.cjs";

const { loadIroh } = nativeAdapter;
let Endpoint;
let EndpointTicket;
let RelayMode;
let presetMinimal;
let presetN0;
const HOST_ENTRYPOINT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HOST_ENTRYPOINT_DIR, "..", "..");
const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const CONTROL_REQUEST_MAX_BYTES = 16 * 1024;
const DEFAULT_READ_LIMIT = 64 * 1024;
const DEFAULT_STATE_PATH = join(getAgentDir(), "remote", "iroh-host.json");
const ACTIVE_REVOKE_CLOSE_REASON = "revoked";
const ACTIVE_REPLACE_CLOSE_REASON = "replaced";
const DUPLICATE_CONVERSATION_RETRY_AFTER_MS = 500;
const LEGACY_WORKSPACE_SESSION_ID = "legacy-workspace";
const WORKSPACE_DISCOVERY_STREAM_SESSION_ID = "$workspace-discovery";
const WORKSPACE_MANAGEMENT_STREAM_SESSION_ID = "$workspace-management";
const WORKSPACE_UNREGISTERED_CLOSE_REASON = "workspace_unregistered";
const REMOTE_SESSION_LIST_DEFAULT_LIMIT = 50;
const REMOTE_SESSION_LIST_MAX_LIMIT = 200;
const REMOTE_SESSION_LIST_CURSOR_TTL_MS = 10 * 60 * 1000;
const REMOTE_SESSION_LIST_CURSOR_MAX_BYTES = 512;
const REMOTE_SESSION_LIST_CURSOR_TTL_ENV = "VOLT_IROH_SESSION_LIST_CURSOR_TTL_MS";
const REMOTE_TRANSCRIPT_DEFAULT_LIMIT = 200;
const REMOTE_TRANSCRIPT_MAX_LIMIT = 200;
const REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES = 2048;
const REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS = 512;
const REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS = 12_000;
let activeConnectionSequence = 0;
let activeStreamSequence = 0;
const PROMPT_COMPLETION_RPC_TYPES = new Set(["prompt", "steer", "follow_up"]);
const INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES = new Set([
	"new_session",
	"switch_session_by_id",
	"get_messages",
]);
const RESPONSE_COMPLETION_RPC_TYPES = new Set([
	"abort",
	"new_session",
	"set_client_capabilities",
	"get_pending_host_actions",
	"get_state",
	"get_transcript",
	"get_ui_capabilities",
	"get_ui_actions",
	"get_ui_action_completions",
	"invoke_ui_action",
	"list_sessions",
	"register_push_target",
	"register_live_activity",
	"unregister_live_activity",
	"switch_session_by_id",
	"unregister_workspace",
]);
const UI_ACTION_PROMPT_COMPLETION_STATUSES = new Set(["accepted", "queued"]);
const PROMPT_COMPLETION_SETTLE_MS = 100;
const BOOLEAN_FLAGS = new Set([
	"approve",
	"help",
	"integrated-volt",
	"mobile",
	"no-pairing",
	"once",
	"register-workspace",
	"use-volt",
	"yes",
]);
const VALUE_FLAGS = new Set([
	"agent-dir",
	"allow-tools",
	"audit",
	"detached-runtime-ttl-ms",
	"profile",
	"push-relay-auth-token",
	"push-relay-url",
	"relay",
	"source-volt",
	"state",
	"unregister-workspace",
	"volt-bin",
	"workspace",
]);
function parseFlags(argv) {
	const flags = new Map();
	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const equalsIndex = arg.indexOf("=");
		if (equalsIndex !== -1) {
			const name = arg.slice(2, equalsIndex);
			const value = arg.slice(equalsIndex + 1);
			if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
				throw new Error(`Unknown option: --${name}`);
			}
			if (VALUE_FLAGS.has(name) && value.length === 0) {
				throw new Error(`--${name} requires a value`);
			}
			flags.set(name, value);
			continue;
		}

		const name = arg.slice(2);
		if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
			throw new Error(`Unknown option: --${name}`);
		}
		if (BOOLEAN_FLAGS.has(name)) {
			flags.set(name, "true");
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(name, next);
			index += 1;
			continue;
		}

		throw new Error(`--${name} requires a value`);
	}

	return { flags, positionals };
}

function getFlag(flags, name, fallback) {
	return flags.get(name) ?? fallback;
}

function hasFlag(flags, name) {
	return flags.has(name) && flags.get(name) !== "false";
}

async function writeNodeStream(writable, chunk) {
	if (writable.write(chunk)) return;
	await once(writable, "drain");
}

async function readLineFromIroh(recv, initial = Buffer.alloc(0), options = {}) {
	const maxLineBytes = options.maxLineBytes;
	const readLimit = Math.min(DEFAULT_READ_LIMIT, maxLineBytes === undefined ? DEFAULT_READ_LIMIT : maxLineBytes + 1);
	let buffer = Buffer.from(initial);

	while (true) {
		const newlineIndex = buffer.indexOf(10);
		if (newlineIndex !== -1) {
			let lineBuffer = buffer.subarray(0, newlineIndex);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			if (maxLineBytes !== undefined && lineBuffer.length > maxLineBytes) {
				throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
			}
			return {
				line: lineBuffer.toString("utf8"),
				rest: buffer.subarray(newlineIndex + 1),
			};
		}

		if (maxLineBytes !== undefined && buffer.length > maxLineBytes) {
			throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
		}

		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: buffer };
		}
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	}
}

function getRpcResponseId(command) {
	return typeof command.id === "string" ? command.id : undefined;
}

function createRpcSuccessResponse(id, command, data) {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	};
}

function createRemoteRpcError(command, error) {
	return createIrohRemoteRpcErrorResponse(
		typeof command.id === "string" ? command.id : undefined,
		typeof command.type === "string" ? command.type : "unknown",
		error,
	);
}

function parseRemoteRpcCommandLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(undefined, "parse", "invalid_request"),
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(undefined, "unknown", "invalid_request"),
		};
	}
	if (typeof parsed.type !== "string") {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(getRpcResponseId(parsed), "unknown", "invalid_request"),
		};
	}
	return { ok: true, command: parsed };
}

function getRemoteSanitizerOptions(authorization) {
	return {
		remoteWorkspacePath: "/workspace",
		workspacePath: authorization.workspace.path,
	};
}

async function writeIrohRemoteJsonLine(send, value, authorization) {
	const sanitized = sanitizeIrohRemoteOutbound(value, getRemoteSanitizerOptions(authorization));
	await send.writeAll(Array.from(Buffer.from(serializeJsonLine(sanitized), "utf8")));
}

async function writeIrohRemoteRpcResponse(stream, response, authorization) {
	await writeIrohRemoteJsonLine(stream.send, response, authorization);
}

function truncateUnicodeScalars(value, maxLength) {
	const scalars = Array.from(value);
	return scalars.length <= maxLength ? value : scalars.slice(0, maxLength).join("");
}

function sanitizeRemoteTextField(value, maxLength, authorization) {
	const sanitized = sanitizeIrohRemoteOutbound({ value }, getRemoteSanitizerOptions(authorization)).value;
	return truncateUnicodeScalars(typeof sanitized === "string" ? sanitized : "", maxLength);
}

function sanitizeRemoteTranscriptText(value, authorization) {
	const raw = typeof value === "string" ? value : "";
	const normalized = raw
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/[\n\t]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const sanitized = sanitizeIrohRemoteOutbound({ value: normalized }, getRemoteSanitizerOptions(authorization)).value;
	const text = (typeof sanitized === "string" ? sanitized : "").replace(/\s+/gu, " ").trim();
	const scalars = Array.from(text);
	if (scalars.length <= REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS) {
		return { text, truncated: false };
	}
	return {
		text: scalars.slice(0, REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS).join(""),
		truncated: true,
	};
}

function parseRemoteTranscriptLimit(command) {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_TRANSCRIPT_DEFAULT_LIMIT };
	}
	if (!Number.isFinite(command.limit) || !Number.isInteger(command.limit) || command.limit <= 0) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_TRANSCRIPT_MAX_LIMIT) };
}

function isValidRemoteTranscriptCursor(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Array.from(value).length <= REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS &&
		Buffer.byteLength(value, "utf8") <= REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES
	);
}

function parseRemoteTranscriptRequest(command) {
	const limit = parseRemoteTranscriptLimit(command);
	if (!limit.ok) {
		return limit;
	}
	if (command.beforeEntryId !== undefined && !isValidRemoteTranscriptCursor(command.beforeEntryId)) {
		return { ok: false, error: "invalid_cursor" };
	}
	return { ok: true, limit: limit.limit, beforeEntryId: command.beforeEntryId };
}

function extractTranscriptContentText(content) {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function createRemoteTranscriptItem(entry, role, text, authorization) {
	const sanitized = sanitizeRemoteTranscriptText(text, authorization);
	return {
		entryId: entry.id,
		createdAt: toRemoteSessionTimestamp(entry.timestamp),
		role,
		text: sanitized.text,
		truncated: sanitized.truncated,
	};
}

function projectRemoteTranscriptEntry(entry, authorization) {
	if (!entry || typeof entry !== "object") {
		return undefined;
	}
	if (entry.type === "compaction") {
		return createRemoteTranscriptItem(entry, "system", entry.summary, authorization);
	}
	if (entry.type === "custom_message") {
		if (entry.customType !== "review" || entry.display !== true) {
			return undefined;
		}
		const text = extractTranscriptContentText(entry.content);
		return text ? createRemoteTranscriptItem(entry, "assistant", text, authorization) : undefined;
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
		return undefined;
	}
	const message = entry.message;
	if (message.role === "user" || message.role === "assistant") {
		const text = extractTranscriptContentText(message.content);
		return text ? createRemoteTranscriptItem(entry, message.role, text, authorization) : undefined;
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "failed" : "completed";
		const toolName = typeof message.toolName === "string" && message.toolName.trim() ? message.toolName.trim() : "tool";
		return createRemoteTranscriptItem(entry, "tool", `${toolName} ${status}`, authorization);
	}
	if (message.role === "bashExecution") {
		const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
		const status = failed ? "failed" : "completed";
		const exit = message.cancelled
			? "cancelled"
			: message.exitCode === undefined
				? status
				: `exit ${message.exitCode}`;
		return createRemoteTranscriptItem(entry, "tool", `bash ${exit}`, authorization);
	}
	return undefined;
}

function projectRemoteTranscriptItems(sessionManager, authorization) {
	return sessionManager
		.getBranch()
		.map((entry) => projectRemoteTranscriptEntry(entry, authorization))
		.filter(Boolean);
}

function createRemoteTranscriptPage(items, request) {
	const beforeIndex =
		request.beforeEntryId === undefined
			? items.length
			: items.findIndex((item) => item.entryId === request.beforeEntryId);
	if (beforeIndex === -1) {
		return undefined;
	}
	const eligibleItems = items.slice(0, beforeIndex);
	const pageStart = Math.max(0, eligibleItems.length - request.limit);
	const pageItems = eligibleItems.slice(pageStart);
	const hasMore = pageStart > 0;
	return {
		items: pageItems,
		hasMore,
		nextBeforeEntryId: hasMore ? (pageItems[0]?.entryId ?? null) : null,
	};
}

function createRemoteGetTranscriptRpcResponse(command, authorization, runtime) {
	const id = getRpcResponseId(command);
	const request = parseRemoteTranscriptRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", request.error);
	}
	const items = projectRemoteTranscriptItems(runtime.session.sessionManager, authorization);
	const page = createRemoteTranscriptPage(items, request);
	if (!page) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", "invalid_cursor");
	}
	return createRpcSuccessResponse(id, "get_transcript", {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		...page,
	});
}

function toRemoteSessionTimestamp(value) {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function getRemoteSessionTimestampMs(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function createRemoteSessionSummary(input, authorization) {
	const createdAt = toRemoteSessionTimestamp(input.createdAt);
	const updatedAt = toRemoteSessionTimestamp(input.updatedAt);
	return {
		sortUpdatedAtMs: getRemoteSessionTimestampMs(updatedAt),
		session: {
			sessionId: input.sessionId,
			title: sanitizeRemoteTextField(input.title, 160, authorization),
			createdAt,
			updatedAt,
			messageCount: input.messageCount,
		},
	};
}

function sortRemoteSessionSummaries(left, right) {
	return right.sortUpdatedAtMs - left.sortUpdatedAtMs || left.session.sessionId.localeCompare(right.session.sessionId);
}

async function listRemoteWorkspaceSessionSummaries(authorization, options, runtime) {
	const summaries =
		runtime === undefined
			? (await SessionManager.list(
					authorization.workspace.path,
					getDefaultSessionDir(authorization.workspace.path, options.agentDir),
				)).map((info) =>
					createRemoteSessionSummary(
						{
							sessionId: info.id,
							title: info.name ?? info.firstMessage,
							createdAt: info.created,
							updatedAt: info.modified,
							messageCount: info.messageCount,
						},
						authorization,
					),
				)
			: (await runtime.listSessions()).map((summary) =>
					createRemoteSessionSummary(
						{
							sessionId: summary.sessionId,
							title: summary.sessionName ?? summary.firstMessage,
							createdAt: summary.createdAt,
							updatedAt: summary.modifiedAt,
							messageCount: summary.messageCount,
						},
						authorization,
					),
				);
	const bySessionId = new Map();
	for (const summary of summaries) {
		bySessionId.set(summary.session.sessionId, summary);
	}
	return Array.from(bySessionId.values()).sort(sortRemoteSessionSummaries);
}

function cleanupExpiredSessionListCursors(options, now = Date.now()) {
	for (const [cursor, entry] of options.sessionListCursors) {
		if (entry.expiresAt <= now) {
			options.sessionListCursors.delete(cursor);
		}
	}
}

function createSessionListCursor(options, authorization, sessions, nextIndex) {
	const cursor = randomUUID();
	options.sessionListCursors.set(cursor, {
		clientNodeId: authorization.client.nodeId,
		workspaceName: authorization.workspace.name,
		sessions,
		nextIndex,
		expiresAt: Date.now() + options.sessionListCursorTtlMs,
	});
	return cursor;
}

function getSessionListCursorEntry(options, authorization, cursor) {
	cleanupExpiredSessionListCursors(options);
	const entry = options.sessionListCursors.get(cursor);
	if (
		!entry ||
		entry.clientNodeId !== authorization.client.nodeId ||
		entry.workspaceName !== authorization.workspace.name
	) {
		return undefined;
	}
	return entry;
}

function parseRemoteSessionListLimit(command) {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_SESSION_LIST_DEFAULT_LIMIT };
	}
	if (typeof command.limit !== "number" || !Number.isInteger(command.limit) || command.limit <= 0) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_SESSION_LIST_MAX_LIMIT) };
}

function parseRemoteSessionListRequest(command) {
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
	return { ok: true, limit: limit.limit, cursor: command.cursor };
}

async function createRemoteListSessionsRpcResponse(command, authorization, options, runtime) {
	const id = getRpcResponseId(command);
	const request = parseRemoteSessionListRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "list_sessions", request.error);
	}

	let sessions;
	let startIndex;
	if (request.cursor) {
		const cursorEntry = getSessionListCursorEntry(options, authorization, request.cursor);
		if (!cursorEntry) {
			return createIrohRemoteRpcErrorResponse(id, "list_sessions", "invalid_cursor");
		}
		sessions = cursorEntry.sessions;
		startIndex = cursorEntry.nextIndex;
	} else {
		sessions = (await listRemoteWorkspaceSessionSummaries(authorization, options, runtime)).map(
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
		nextCursor: hasMore ? createSessionListCursor(options, authorization, sessions, nextIndex) : null,
	});
}

function formatIrohLoadError(error) {
	const detail = error instanceof Error ? error.message : error ? String(error) : "unknown native adapter error";
	return [
		"The optional @number0/iroh native adapter is not available.",
		`Native adapter error: ${detail}`,
		"Install Volt with optional dependencies enabled for this platform, then retry `volt remote host`.",
		"If optional dependencies were omitted, reinstall without `--omit=optional`.",
	].join("\n");
}

function ensureIrohAvailable() {
	const { iroh, irohLoadError } = loadIroh();
	if (!iroh) {
		throw new Error(formatIrohLoadError(irohLoadError));
	}
	({ Endpoint, EndpointTicket, RelayMode, presetMinimal, presetN0 } = iroh);
}

function printUsage() {
	console.error(`Usage: volt remote host [serve] [options]
       volt remote host --register-workspace [path|name=path] [options]
       volt remote host --unregister-workspace <name> [options]
       volt remote clients [options]
       volt remote revoke <node-id> [options]
       volt remote approve-repair <node-id> [options]

Serve options:
  --workspace <name=path>    Workspace exposed to the client. Defaults to cwd.
  --register-workspace       Register cwd, path, or name=path in host state and exit.
  --unregister-workspace <name>
                              Remove a registered workspace from host state without deleting files.
  --mobile                   Mobile-facing host mode. Skips startup pairing; relay already defaults to default.
  --relay <disabled|default> Iroh relay preset. Defaults to default; use disabled for LAN-only testing.
  --state <path>             Host state path. Defaults to ~/.volt/agent/remote/iroh-host.json.
  --audit <path>             Host audit JSONL path. Defaults to <state>.audit.jsonl.
  --use-volt                 Spawn volt --mode rpc instead of the fake RPC child.
  --source-volt <repo-root>  Spawn Volt from a source checkout. Implies --use-volt.
  --integrated-volt          Run Volt's runtime in-process over Iroh.
  --volt-bin <path>          Volt executable for --use-volt. Defaults to volt.
  --allow-tools <list>       Tool allowlist passed to Volt. Defaults to the saved workspace allowlist or read,bash,edit,write,grep,find,ls.
                              bash, edit, or write can modify host state and require confirmation.
  --profile <name>           Volt settings profile for integrated Volt runtime.
  --agent-dir <path>         Volt agent config directory for integrated Volt runtime.
  --push-relay-url <url>     Volt push relay URL. Defaults to the managed Volt relay or VOLT_PUSH_RELAY_URL.
  --push-relay-auth-token <token>
                              Optional bearer token for custom push relays. Defaults to VOLT_PUSH_RELAY_AUTH_TOKEN.
  --detached-runtime-ttl-ms <ms>
                              Retain idle detached integrated runtimes for this many milliseconds. Defaults to 30 minutes.
  --approve                  Trust project-local Volt settings/resources for the remote workspace.
  --no-pairing               Reject unpaired clients and print a paired-client ticket.
  --once                     Exit after the first client disconnects.
  --yes                      Accept unsafe remote tool grants for noninteractive startup without trusting the workspace.

Client management:
  clients                    Print paired clients from state.
  revoke <node-id>           Remove a paired client from state.
  approve-repair <node-id>   Allow a revoked client node ID to re-pair.
`);
}

async function withStateFileLock(statePath, operation) {
	await mkdir(dirname(statePath), { recursive: true });
	let release;
	let lockCompromised = false;
	let lockCompromisedError;
	const throwIfCompromised = () => {
		if (lockCompromised) {
			throw lockCompromisedError ?? new Error("Iroh remote host state lock was compromised");
		}
	};

	try {
		release = await lockfile.lock(statePath, {
			lockfilePath: `${statePath}.lock`,
			realpath: false,
			retries: {
				retries: 10,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 10000,
				randomize: true,
			},
			stale: 30000,
			onCompromised: (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			},
		});

		throwIfCompromised();
		const result = await operation();
		throwIfCompromised();
		return result;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// Ignore unlock errors after a compromised lock.
			}
		}
	}
}

function syncState(target, source) {
	target.hostSecretKey = source.hostSecretKey;
	target.pairingSecretTombstones = source.pairingSecretTombstones ?? [];
	target.workspaces = source.workspaces ?? [];
	target.clients = source.clients ?? [];
	target.revokedClients = source.revokedClients ?? [];
	target.pendingPairingTickets = source.pendingPairingTickets ?? [];
}

function getDefaultAuditPath(statePath) {
	return statePath.endsWith(".json")
		? `${statePath.slice(0, -".json".length)}.audit.jsonl`
		: `${statePath}.audit.jsonl`;
}

function createAuditLogger(flags, statePath) {
	const auditPath = resolve(getFlag(flags, "audit", getDefaultAuditPath(statePath)));
	return { auditLogger: new IrohRemoteAuditLogger({ path: auditPath }), auditPath };
}

async function logAudit(auditLogger, event) {
	try {
		await auditLogger.log(event);
	} catch {
		// Audit logging is best-effort and must not change remote runtime behavior.
	}
}

function formatUnsafeToolWarning(unsafeTools) {
	const formattedTools = unsafeTools.join(", ");
	return [
		`Unsafe remote tools requested: ${formattedTools}.`,
		"These tools can modify files or run shell commands on the host through a paired remote client.",
	].join("\n");
}

function getRemoteWorkspaceTrustState(flags, workspace) {
	const trustStore = new ProjectTrustStore(getFlag(flags, "agent-dir", getAgentDir()));
	const hasTrustResources = hasTrustRequiringProjectResources(workspace.path);
	return {
		hasTrustResources,
		projectTrusted: hasFlag(flags, "approve") || !hasTrustResources || trustStore.get(workspace.path) === true,
		trustStore,
	};
}

function formatRemoteWorkspaceConfirmationPrompt(options) {
	const lines = [];
	if (options.unsafeTools.length > 0) {
		lines.push(formatUnsafeToolWarning(options.unsafeTools), "");
	}
	lines.push(`Remote workspace: ${options.workspace.name} -> ${options.workspace.path}`);
	if (options.offerTrust) {
		lines.push(
			"This workspace has project-local Volt settings/resources.",
			"Type yes to continue without trusting project-local resources.",
			"Type trust to continue and trust this workspace.",
			"Any other answer cancels.",
		);
	} else {
		lines.push("Type yes to continue.");
	}
	return `${lines.join("\n")}\nChoice: `;
}

async function auditUnsafeRemoteToolGrant(options, unsafeTools, approval) {
	if (!options.auditLogger) return;
	await logAudit(options.auditLogger, {
		type: "unsafe_tools_enabled",
		workspace: options.workspace.name,
		success: true,
		details: {
			allowTools: options.allowTools,
			approval,
			context: options.context,
			unsafeTools,
		},
	});
}

async function confirmRemoteWorkspaceAccess(options) {
	const unsafeTools = options.allowTools ? getIrohRemoteUnsafeAllowedTools(options.allowTools) : [];
	const offerTrust = options.promptForTrust && options.hasTrustResources && !options.projectTrusted;
	if (unsafeTools.length === 0 && !offerTrust) {
		return { projectTrusted: options.projectTrusted };
	}

	if (options.yes) {
		if (unsafeTools.length > 0) {
			await auditUnsafeRemoteToolGrant(options, unsafeTools, "yes_flag");
		}
		return { projectTrusted: options.projectTrusted };
	}

	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		if (unsafeTools.length > 0) {
			const warning = formatUnsafeToolWarning(unsafeTools);
			throw new Error(
				[
					warning,
					"Pass --yes to accept unsafe remote tool grants in noninteractive contexts.",
					"Pass --approve to trust project-local resources for the remote workspace.",
				].join("\n"),
			);
		}
		return { projectTrusted: options.projectTrusted };
	}

	const readline = createInterface({ input: process.stdin, output: process.stderr });
	let answer;
	try {
		answer = await readline.question(
			formatRemoteWorkspaceConfirmationPrompt({ ...options, offerTrust, unsafeTools }),
		);
	} finally {
		readline.close();
	}

	const normalizedAnswer = answer.trim().toLowerCase();
	let projectTrusted = options.projectTrusted;
	if (normalizedAnswer === "trust" || normalizedAnswer === "t") {
		options.trustStore.set(options.workspace.path, true);
		projectTrusted = true;
		console.error(`trusted workspace: ${options.workspace.name} -> ${options.workspace.path}`);
	} else if (normalizedAnswer !== "yes" && normalizedAnswer !== "y") {
		throw new Error(
			unsafeTools.length > 0 ? "Unsafe remote tool grant was not accepted." : "Remote workspace was not accepted.",
		);
	}

	if (unsafeTools.length > 0) {
		await auditUnsafeRemoteToolGrant(options, unsafeTools, "tty_confirmation");
	}
	return { projectTrusted };
}

async function assertWorkspaceDirectory(workspace) {
	let workspaceStat;
	try {
		workspaceStat = await stat(workspace.path);
	} catch (error) {
		if (error && error.code === "ENOENT") {
			throw new Error(`Workspace path does not exist: ${workspace.path}`);
		}
		throw error;
	}
	if (!workspaceStat.isDirectory()) {
		throw new Error(`Workspace path is not a directory: ${workspace.path}`);
	}
	workspace.path = await realpath(workspace.path);
}

async function isWorkspaceDirectoryAvailable(workspace) {
	return (await getIrohRemoteWorkspaceAvailabilityStatus(workspace)) === "available";
}

function getRegisterWorkspacePositionals(positionals) {
	return positionals[0] === "serve" ? positionals.slice(1) : positionals;
}

function getRegisterWorkspaceSpec(flags, positionals) {
	const registerPositionals = getRegisterWorkspacePositionals(positionals);
	if (registerPositionals.length > 1) {
		throw new Error(`Unexpected workspace registration argument: ${registerPositionals[1]}`);
	}

	const workspaceFlag = getFlag(flags, "workspace");
	if (registerPositionals.length === 1 && workspaceFlag !== undefined) {
		throw new Error("Workspace registration accepts either a positional workspace spec or --workspace, not both");
	}
	return registerPositionals[0] ?? workspaceFlag;
}

async function registerWorkspace(flags, positionals) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const spec = getRegisterWorkspaceSpec(flags, positionals);
	const workspace = parseIrohRemoteWorkspaceSpec(spec, process.cwd());
	const useRealpathBasename = spec === undefined || !spec.includes("=");
	await assertWorkspaceDirectory(workspace);
	if (useRealpathBasename) {
		workspace.name = basename(workspace.path) || "workspace";
	}

	const trustState = getRemoteWorkspaceTrustState(flags, workspace);
	if (hasFlag(flags, "approve")) {
		trustState.trustStore.set(workspace.path, true);
	}
	await confirmRemoteWorkspaceAccess({
		allowTools: undefined,
		context: "workspace_registration",
		hasTrustResources: trustState.hasTrustResources,
		projectTrusted: trustState.projectTrusted,
		promptForTrust: true,
		trustStore: trustState.trustStore,
		workspace,
		yes: hasFlag(flags, "yes"),
	});

	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const savedWorkspace = await stateManager.upsertWorkspace(workspace, getFlag(flags, "allow-tools"));
	console.error(`registered workspace: ${savedWorkspace.name} -> ${savedWorkspace.path}`);
}

async function unregisterWorkspace(flags, positionals) {
	if (positionals.length > 0) {
		throw new Error(`Unexpected workspace unregister argument: ${positionals[0]}`);
	}
	const workspaceName = getFlag(flags, "unregister-workspace");
	if (!workspaceName || workspaceName.trim().length === 0) {
		throw new Error("--unregister-workspace requires a value");
	}
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const removedWorkspace = await stateManager.unregisterWorkspace(workspaceName);
	if (!removedWorkspace) {
		throw new Error(`No registered Iroh remote workspace named ${workspaceName}`);
	}
	await stateManager.removeLiveActivitiesForWorkspace(workspaceName);
	console.error(`unregistered workspace: ${workspaceName}`);
}

function getPlatformVoltBin(voltBin) {
	return process.platform === "win32" && voltBin === "volt" ? "volt.cmd" : voltBin;
}

function isPathCommand(command) {
	return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function getExecutableCandidates(command) {
	if (process.platform !== "win32") return [command];

	const lowerCommand = command.toLowerCase();
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension.length > 0);
	if (extensions.some((extension) => lowerCommand.endsWith(extension.toLowerCase()))) {
		return [command];
	}
	return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function isExecutable(path) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findExecutable(command) {
	const candidates = getExecutableCandidates(command);
	if (isPathCommand(command)) {
		for (const candidate of candidates) {
			const candidatePath = isAbsolute(candidate) ? candidate : resolve(candidate);
			if (await isExecutable(candidatePath)) return candidatePath;
		}
		return undefined;
	}

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
	for (const pathEntry of pathEntries) {
		for (const candidate of candidates) {
			const candidatePath = join(pathEntry, candidate);
			if (await isExecutable(candidatePath)) return candidatePath;
		}
	}
	return undefined;
}

function sourceCheckoutVoltBinHint(workspace) {
	if (process.platform === "win32") {
		return "If testing a source checkout on Windows, run from an environment that can execute volt-test.sh or pass a built volt.cmd path.";
	}
	return `If testing a source checkout, pass --volt-bin ${resolve(workspace.path, "volt-test.sh")}.`;
}

async function resolveSourceVoltRunner(sourceVolt) {
	const runnerPath = resolve(sourceVolt, "scripts", "run-coding-agent-source.mjs");
	try {
		const runnerStat = await stat(runnerPath);
		if (runnerStat.isFile()) return runnerPath;
	} catch (error) {
		if (error && error.code !== "ENOENT") throw error;
	}
	throw new Error(`Volt source runner is not available: ${runnerPath}`);
}

function selectServeWorkspace(state, workspaceSpec, allowTools, cwd) {
	if (workspaceSpec !== undefined || state.workspaces.length === 0) {
		return selectIrohRemoteWorkspace(state, workspaceSpec, allowTools, cwd);
	}

	const cwdWorkspace = parseIrohRemoteWorkspaceSpec(undefined, cwd);
	const workspace = state.workspaces.find((entry) => entry.path === cwdWorkspace.path) ?? state.workspaces[0];
	if (allowTools !== undefined) {
		workspace.allowedTools = allowTools;
	}
	return workspace;
}

async function preflightRpcChild(options, workspace) {
	await assertWorkspaceDirectory(workspace);
	if (options.integratedVolt) {
		return;
	}
	if (options.sourceVolt) {
		options.resolvedSourceVoltRunner = await resolveSourceVoltRunner(options.sourceVolt);
		return;
	}
	if (!options.useVolt) return;

	const voltBin = getPlatformVoltBin(options.voltBin);
	const resolvedVoltBin = await findExecutable(voltBin);
	if (!resolvedVoltBin) {
		throw new Error(
			`Volt executable is not available: ${voltBin}. Install Volt globally or pass --volt-bin <path>. ${sourceCheckoutVoltBinHint(workspace)}`,
		);
	}
	options.resolvedVoltBin = resolvedVoltBin;
}

async function bindEndpoint(relayMode, state, statePath) {
	const endpoint = await withStateFileLock(statePath, async () => {
		syncState(state, await readIrohRemoteHostState(statePath));
		const builder = Endpoint.builder();
		if (relayMode === "default") {
			presetN0(builder);
		} else {
			presetMinimal(builder);
			builder.relayMode(RelayMode.disabled());
		}
		if (state.hostSecretKey) {
			builder.secretKey(state.hostSecretKey);
		}
		builder.alpns([ALPN]);
		const boundEndpoint = await builder.bind();
		if (!state.hostSecretKey) {
			state.hostSecretKey = boundEndpoint.secretKey().toBytes();
			await writeIrohRemoteHostState(statePath, state);
		}
		return boundEndpoint;
	});
	if (relayMode === "default") {
		await endpoint.online();
	}
	return endpoint;
}

function isWindowsCommandShim(command) {
	if (process.platform !== "win32") return false;
	const lowerCommand = command.toLowerCase();
	return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}

function spawnProcess(command, args, options) {
	if (!isWindowsCommandShim(command)) {
		return spawn(command, args, options);
	}
	return spawn(process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}

function getProjectTrustedForWorkspace(options, workspace) {
	return options.getProjectTrustedForWorkspace?.(workspace) === true;
}

function spawnRpcChild(options, workspace, allowTools) {
	if (options.sourceVolt) {
		const runnerPath =
			options.resolvedSourceVoltRunner ?? resolve(options.sourceVolt, "scripts", "run-coding-agent-source.mjs");
		const args = [runnerPath, "--mode", "rpc", ...getIrohRemoteVoltRpcToolArgs(allowTools)];
		if (getProjectTrustedForWorkspace(options, workspace)) args.push("--approve");
		return {
			command: process.execPath,
			args,
			child: spawnProcess(process.execPath, args, {
				cwd: workspace.path,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		};
	}

	if (!options.useVolt) {
		const fakeRpcPath = join(PACKAGE_DIR, "examples", "remote", "iroh-sidecar", "fake-rpc.mjs");
		const args = [fakeRpcPath];
		return {
			command: process.execPath,
			args,
			child: spawnProcess(process.execPath, args, {
				cwd: workspace.path,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		};
	}

	const voltBin = options.resolvedVoltBin ?? getPlatformVoltBin(options.voltBin);
	const args = ["--mode", "rpc", ...getIrohRemoteVoltRpcToolArgs(allowTools)];
	if (getProjectTrustedForWorkspace(options, workspace)) args.push("--approve");
	return {
		command: voltBin,
		args,
		child: spawnProcess(voltBin, args, {
			cwd: workspace.path,
			stdio: ["pipe", "pipe", "pipe"],
		}),
	};
}

function formatCommand(command, args) {
	return [command, ...args].join(" ");
}

async function waitForChildSpawn(child, commandText, workspace) {
	await new Promise((resolveSpawn, rejectSpawn) => {
		const cleanup = () => {
			child.off("spawn", handleSpawn);
			child.off("error", handleError);
		};
		const handleSpawn = () => {
			cleanup();
			resolveSpawn();
		};
		const handleError = (error) => {
			cleanup();
			rejectSpawn(
				new Error(`Failed to spawn RPC child (${commandText}) in ${workspace.path}: ${error.message}`),
			);
		};
		child.once("spawn", handleSpawn);
		child.once("error", handleError);
	});
}

function attachChildLogging(child) {
	if (!child.stderr) return;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.trim().length > 0) process.stderr.write(`[volt-rpc] ${line}\n`);
		}
	});
}

async function waitForChildExitOrTimeout(child) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	await Promise.race([
		once(child, "exit").then(() => true),
		new Promise((resolveDelay) => {
			setTimeout(() => resolveDelay(false), 500);
		}),
	]);
	return child.exitCode !== null || child.signalCode !== null;
}

async function logRpcChildStopped(child, childCommand, authorization, options) {
	const stopped = await waitForChildExitOrTimeout(child);
	await logAudit(options.auditLogger, {
		type: "child_stopped",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: stopped,
		error: stopped ? undefined : "RPC child did not exit before audit timeout",
		details: {
			command: childCommand,
			exitCode: child.exitCode,
			killed: child.killed,
			pid: child.pid,
			signal: child.signalCode,
		},
	});
}

async function sendHandshakeError(stream, error, options) {
	const message = error instanceof Error ? error.message : String(error);
	const outcome = typeof error?.outcome === "string" ? error.outcome : undefined;
	const workspace = typeof error?.workspace === "string" ? error.workspace : undefined;
	const sessionId = typeof error?.sessionId === "string" ? error.sessionId : undefined;
	const retryAfterMs = typeof error?.retryAfterMs === "number" ? error.retryAfterMs : undefined;
	await writeIrohRemoteHandshakeResponse(
		stream.send,
		createIrohRemoteHandshakeFailure(message, {
			hostNodeId: options.hostNodeId,
			...(outcome === undefined ? {} : { outcome }),
			...(workspace === undefined ? {} : { workspace }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		}),
	);
	await stream.send.finish?.();
	await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

async function waitForConnectionClose(connection) {
	await Promise.race([
		connection.closed().catch(() => {}),
		new Promise((resolveDelay) => {
			setTimeout(resolveDelay, 500);
		}),
	]);
}

async function withTimeout(promise, timeoutMs, message) {
	let timeoutId;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function isExpectedApplicationClose(error) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ConnectionLost(ApplicationClosed") &&
		message.includes("error_code: 0") &&
		(message.includes('reason: b"done"') ||
			message.includes(`reason: b"${ACTIVE_REVOKE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${ACTIVE_REPLACE_CLOSE_REASON}"`) ||
			message.includes(`reason: b"${WORKSPACE_UNREGISTERED_CLOSE_REASON}"`))
	);
}

function createIrohSendQueue(send) {
	let pendingWrite = Promise.resolve();
	let finishPromise;
	return {
		write(chunk) {
			if (chunk.length === 0 || finishPromise) return pendingWrite;
			const bytes = Array.from(Buffer.from(chunk));
			pendingWrite = pendingWrite.then(() => send.writeAll(bytes));
			return pendingWrite;
		},
		async finish() {
			finishPromise ??= pendingWrite.then(() => send.finish());
			await finishPromise;
		},
	};
}

function getCurrentUserName() {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME;
	}
}

function createRemoteHostMetadata(authorization, options) {
	return createIrohRemoteHostMetadata({
		authorization,
		hostNodeId: options.hostNodeId,
		relayMode: options.relayMode,
		hostName: hostname(),
		userName: getCurrentUserName(),
		cwd: "/workspace",
	});
}

function updateAuthorizationWorkspaceMetadata(authorization, metadata) {
	authorization.workspaceNames = [...metadata.workspaceNames];
	authorization.workspaces = metadata.workspaces.map((workspace) => ({ ...workspace }));
}

async function handleRemoteHostRpcCommand(command, authorization, options) {
	let result;
	try {
		result = await handleIrohRemoteWorkspaceUnregisterRpcCommand(command, {
			classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
			stateManager: options.stateManager,
		});
	} catch (error) {
		return createIrohRemoteRpcErrorResponse(
			typeof command.id === "string" ? command.id : undefined,
			typeof command.type === "string" ? command.type : "unknown",
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!result.handled) {
		return undefined;
	}
	if (result.metadata) {
		updateAuthorizationWorkspaceMetadata(authorization, result.metadata);
	}
	await logAudit(options.auditLogger, {
		type: "workspace_unregistered",
		clientNodeId: authorization.client.nodeId,
		workspace: typeof command.name === "string" ? command.name : undefined,
		success: result.response.success === true,
		error: result.response.success === true ? undefined : result.response.error,
		details: { source: "remote_rpc" },
	});
	return result.response;
}

function decorateRemoteHostState(value, authorization, options) {
	const decoratedValue = decorateRemoteUiActionResponse(value);
	if (
		typeof decoratedValue !== "object" ||
		decoratedValue === null ||
		Array.isArray(decoratedValue) ||
		decoratedValue.type !== "response" ||
		decoratedValue.command !== "get_state" ||
		decoratedValue.success !== true ||
		typeof decoratedValue.data !== "object" ||
		decoratedValue.data === null ||
		Array.isArray(decoratedValue.data)
	) {
		return decoratedValue;
	}
	return {
		...decoratedValue,
		data: {
			...decoratedValue.data,
			workspaceName: authorization.workspace.name,
			remoteHost: createRemoteHostMetadata(authorization, options),
		},
	};
}

function decorateRemoteUiActionResponse(value) {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value.type !== "response" ||
		value.command !== "get_ui_actions" ||
		value.success !== true ||
		typeof value.data !== "object" ||
		value.data === null ||
		Array.isArray(value.data) ||
		!Array.isArray(value.data.actions)
	) {
		return value;
	}
	return {
		...value,
		data: {
			...value.data,
			actions: value.data.actions.filter((action) => action?.remoteSafe === true),
		},
	};
}

function createRemoteRpcCompletionTracker(sendQueue) {
	let clientInputEnded = false;
	let pendingPromptCompletions = 0;
	let completionSettled = false;
	let runningAgent = false;
	let pendingCompaction = false;
	let promptCompletionTimer;
	let retryInProgress = false;
	let waitingForContinuation = false;
	const pendingResponseIds = new Set();
	const pendingResponseCommands = new Map();
	let resolveCompletion;
	let rejectCompletion;
	const completion = new Promise((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	const getPendingResponseCommandCount = () => {
		let count = 0;
		for (const value of pendingResponseCommands.values()) count += value;
		return count;
	};
	const addPendingResponseCommand = (command) => {
		pendingResponseCommands.set(command, (pendingResponseCommands.get(command) ?? 0) + 1);
	};
	const completePendingResponseCommand = (command) => {
		const count = pendingResponseCommands.get(command) ?? 0;
		if (count <= 1) {
			pendingResponseCommands.delete(command);
			return;
		}
		pendingResponseCommands.set(command, count - 1);
	};
	const completePendingResponse = (event) => {
		if (typeof event.id === "string" && pendingResponseIds.delete(event.id)) {
			return true;
		}
		if (pendingResponseCommands.has(event.command)) {
			completePendingResponseCommand(event.command);
			return true;
		}
		return false;
	};
	const clearPromptCompletionTimer = () => {
		if (!promptCompletionTimer) return;
		clearTimeout(promptCompletionTimer);
		promptCompletionTimer = undefined;
	};
	const hasPendingPromptContinuation = () => {
		return runningAgent || waitingForContinuation || retryInProgress || pendingCompaction;
	};
	const completePendingPromptCompletion = () => {
		clearPromptCompletionTimer();
		if (pendingPromptCompletions > 0) pendingPromptCompletions -= 1;
		if (pendingPromptCompletions > 0 && !hasPendingPromptContinuation()) {
			schedulePendingPromptCompletion();
			return;
		}
		maybeComplete();
	};
	const schedulePendingPromptCompletion = () => {
		if (pendingPromptCompletions <= 0) {
			maybeComplete();
			return;
		}
		clearPromptCompletionTimer();
		promptCompletionTimer = setTimeout(() => {
			promptCompletionTimer = undefined;
			if (hasPendingPromptContinuation()) return;
			completePendingPromptCompletion();
		}, PROMPT_COMPLETION_SETTLE_MS);
	};
	const maybeComplete = () => {
		if (
			completionSettled ||
			!clientInputEnded ||
			pendingPromptCompletions > 0 ||
			pendingResponseIds.size > 0 ||
			getPendingResponseCommandCount() > 0
		) {
			return;
		}
		completionSettled = true;
		clearPromptCompletionTimer();
		sendQueue.finish().then(resolveCompletion, rejectCompletion);
	};

	return {
		completion,
		markChildOutputLine(line) {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof event !== "object" || event === null || typeof event.type !== "string") return;

			if (event.type === "agent_start") {
				runningAgent = true;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "queue_update") {
				if (hasPendingPromptContinuation()) {
					clearPromptCompletionTimer();
				} else {
					schedulePendingPromptCompletion();
				}
				return;
			}

			if (event.type === "auto_retry_start") {
				retryInProgress = true;
				runningAgent = true;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "auto_retry_end") {
				retryInProgress = false;
				runningAgent = false;
				waitingForContinuation = false;
				if (event.success === false && !hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type === "compaction_start") {
				pendingCompaction = true;
				runningAgent = false;
				waitingForContinuation = false;
				clearPromptCompletionTimer();
				return;
			}

			if (event.type === "compaction_end") {
				pendingCompaction = false;
				waitingForContinuation = event.willRetry === true;
				if (!waitingForContinuation && !hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type === "agent_end") {
				runningAgent = false;
				if (event.willRetry) {
					waitingForContinuation = true;
					clearPromptCompletionTimer();
					return;
				}
				waitingForContinuation = false;
				if (!hasPendingPromptContinuation()) schedulePendingPromptCompletion();
				return;
			}

			if (event.type !== "response" || typeof event.command !== "string") return;
			const completedTrackedResponse = completePendingResponse(event);
			if (
				completedTrackedResponse &&
				event.success === true &&
				shouldWaitForRemoteRpcPromptCompletion(event.command, event)
			) {
				pendingPromptCompletions += 1;
				if (!hasPendingPromptContinuation()) schedulePendingPromptCompletion();
			}
			maybeComplete();
		},
		markClientInputEnded() {
			clientInputEnded = true;
			maybeComplete();
		},
		registerForwardedCommand(command) {
			if (typeof command?.type !== "string") return;
			if (PROMPT_COMPLETION_RPC_TYPES.has(command.type)) {
				if (typeof command.id === "string") {
					pendingResponseIds.add(command.id);
					return;
				}
				addPendingResponseCommand(command.type);
				return;
			}
			if (!RESPONSE_COMPLETION_RPC_TYPES.has(command.type)) return;
			if (typeof command.id === "string") {
				pendingResponseIds.add(command.id);
				return;
			}
			addPendingResponseCommand(command.type);
		},
	};
}

function shouldWaitForRemoteRpcPromptCompletion(command, response) {
	if (PROMPT_COMPLETION_RPC_TYPES.has(command)) {
		return true;
	}
	if (command !== "invoke_ui_action") {
		return false;
	}
	return UI_ACTION_PROMPT_COMPLETION_STATUSES.has(response.data?.status);
}

async function writeRemoteRpcLineToChild(
	line,
	writable,
	initialAuthorization,
	options,
	writeToClient,
	rpcCompletionTracker,
	sanitizerOptions,
) {
	const filterResult = getIrohRemoteRpcFilterResult(line);
	if (!filterResult.allowed) {
		await writeToClient(
			sanitizeIrohRemoteOutboundJsonLine(serializeIrohRemoteRpcFilterRejection(filterResult.response), sanitizerOptions),
		);
		return;
	}
	const remoteHostResponse = await handleRemoteHostRpcCommand(filterResult.command, initialAuthorization, options);
	if (remoteHostResponse) {
		await writeToClient(
			sanitizeIrohRemoteOutboundJsonLine(`${JSON.stringify(remoteHostResponse)}\n`, sanitizerOptions),
		);
		return;
	}
	rpcCompletionTracker.registerForwardedCommand(filterResult.command);
	await writeNodeStream(writable, Buffer.from(`${line}\n`, "utf8"));
}

async function pipeFilteredIrohRpcToNodeWritable(
	recv,
	writable,
	initial,
	initialAuthorization,
	options,
	writeToClient,
	rpcCompletionTracker,
	sanitizerOptions,
) {
	let buffer = Buffer.from(initial);

	while (true) {
		const result = await readLineFromIroh(recv, buffer, { maxLineBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES });
		if (result.line === undefined) {
			if (result.rest.length > 0) {
				await writeRemoteRpcLineToChild(
					result.rest.toString("utf8"),
					writable,
					initialAuthorization,
					options,
					writeToClient,
					rpcCompletionTracker,
					sanitizerOptions,
				);
			}
			rpcCompletionTracker.markClientInputEnded();
			return;
		}

		await writeRemoteRpcLineToChild(
			result.line,
			writable,
			initialAuthorization,
			options,
			writeToClient,
			rpcCompletionTracker,
			sanitizerOptions,
		);
		buffer = result.rest;
	}
}

async function runSpawnedRpcConnection(stream, handshake, authorization, options) {
	const spawnedChild = spawnRpcChild(options, authorization.workspace, authorization.allowTools);
	const child = spawnedChild.child;
	const childCommand = formatCommand(spawnedChild.command, spawnedChild.args);
	attachChildLogging(child);
	try {
		await waitForChildSpawn(child, childCommand, authorization.workspace);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await logAudit(options.auditLogger, {
			type: "child_start_failed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: message,
			details: { command: childCommand },
		});
		await sendHandshakeError(stream, message, options);
		return child;
	}

	await logAudit(options.auditLogger, {
		type: "child_started",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: true,
		details: { command: childCommand, pid: child.pid },
	});
	await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);

	const sendQueue = createIrohSendQueue(stream.send);
	const rpcCompletionTracker = createRemoteRpcCompletionTracker(sendQueue);
	const clientToChild = pipeFilteredIrohRpcToNodeWritable(
		stream.recv,
		child.stdin,
		handshake.initialInput,
		authorization,
		options,
		(chunk) => sendQueue.write(chunk),
		rpcCompletionTracker,
		{ workspacePath: authorization.workspace.path },
	).catch((error) => {
		if (!child.killed) child.kill();
		throw error;
	});
	const childToClient = pipeIrohRemoteOutboundJsonlReadable(child.stdout, {
		decorate: (value) => decorateRemoteHostState(value, authorization, options),
		workspacePath: authorization.workspace.path,
		writeLine: (line) => sendQueue.write(line),
		onLine: (line) => {
			rpcCompletionTracker.markChildOutputLine(line);
		},
	}).then(() => sendQueue.finish());
	const childError = new Promise((_, rejectChildError) => {
		child.once("error", (error) => {
			rejectChildError(new Error(`RPC child error (${childCommand}): ${error.message}`));
		});
	});
	const clientToChildFailure = clientToChild.then(() => new Promise(() => {}));

	try {
		await Promise.race([childToClient, childError, clientToChildFailure, rpcCompletionTracker.completion]);
	} finally {
		if (child.exitCode === null && !child.killed) child.kill();
		await logRpcChildStopped(child, childCommand, authorization, options);
	}
	return child;
}

async function runIntegratedVoltConnection(stream, handshake, authorization, connection, connectionId, streamId, options) {
	let entry;
	let sessionSelection;
	let createdRuntime = false;
	try {
		({ entry, sessionSelection, created: createdRuntime } = await getOrCreateIntegratedRuntimeEntry(
			handshake,
			authorization,
			options,
		));
	} catch (error) {
		await logAudit(options.auditLogger, {
			type: "runtime_failure",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			details: { runtime: "integrated-volt" },
		});
		await sendHandshakeError(stream, error, options);
		return;
	}

	if (hasActiveStreamForConversationOnConnection(options, authorization, entry.sessionId, connectionId)) {
		if (createdRuntime) {
			await cleanupUncommittedIntegratedRuntimeEntry(entry, sessionSelection, options);
		}
		await rejectDuplicateActiveConnection(stream, authorization, options, entry.sessionId);
		return;
	}

	const matchingActiveStreams = getActiveStreamsForConversation(options, authorization, entry.sessionId);
	if (matchingActiveStreams.length > 0) {
		if (createdRuntime) {
			await cleanupUncommittedIntegratedRuntimeEntry(entry, sessionSelection, options);
		}
		await rejectDuplicateActiveConnection(stream, authorization, options, entry.sessionId);
		return;
	}

	let activeStream;
	let subscriber;
	let subscriberError;
	let handshakeCommitted = false;
	let abortStreamInvalidated = false;
	const invalidateStreamAfterAbortResponse = async (response) => {
		if (response.command !== "abort" || response.success !== true || abortStreamInvalidated) {
			return;
		}
		abortStreamInvalidated = true;
		activeStream?.remove();
		await stopIntegratedRuntimeEntry(entry, options, "abort");
		closeIrohRemoteStream(stream, "abort");
	};
	try {
		await commitIntegratedRuntimeEntry(entry, sessionSelection, authorization, options);
		handshakeCommitted = true;
		activeStream = registerActiveStream(
			options,
			authorization,
			entry.sessionId,
			stream,
			connection,
			connectionId,
			streamId,
		);
		await writeIrohRemoteHandshakeResponse(
			stream.send,
			createIntegratedConversationHandshakeResponse(handshake, authorization, entry, sessionSelection, options),
		);
		subscriber = await attachIntegratedRuntimeSubscriber(entry, options);
		const pushDispatcher = createPushNotificationDispatcher(authorization, options);
		const rpcMode = runIrohRemoteRpcMode(entry.runtime, {
			decorateOutbound: (value) => decorateRemoteHostState(value, authorization, options),
			disposeRuntimeOnClose: false,
			notificationDelivery: pushDispatcher,
			onResponseWritten: invalidateStreamAfterAbortResponse,
			onSessionChanged: async (session) => {
				if (session.sessionId === entry.recordedSessionId) return;
				entry.recordedSessionId = session.sessionId;
				await recordRemoteSessionChange(session, authorization, options);
			},
			registerPushTarget: pushDispatcher
				? (args) => pushDispatcher.registerPushTarget(args)
				: undefined,
			remoteCommandHandler: (command) =>
				handleIntegratedConversationRpcCommand(command, authorization, options, entry.runtime),
			stream,
			initialInput: handshake.initialInput,
			workspaceName: authorization.workspace.name,
			workspacePath: authorization.workspace.path,
		});
		await rpcMode;
	} catch (error) {
		subscriberError = error;
		if (!handshakeCommitted) {
			await cleanupUncommittedIntegratedRuntimeEntry(entry, sessionSelection, options);
			await sendHandshakeError(stream, error, options);
			return;
		}
	} finally {
		if (subscriber) {
			await detachIntegratedRuntimeSubscriber(
				entry,
				subscriber,
				options,
				subscriberError ? "transport_error" : "transport_closed",
				subscriberError,
			);
		} else if (handshakeCommitted && !abortStreamInvalidated) {
			await detachIntegratedRuntimeWithoutSubscriber(
				entry,
				options,
				subscriberError ? "transport_error" : "transport_closed",
			);
		}
		activeStream?.remove();
	}
}

async function handleIntegratedConversationRpcCommand(command, authorization, options, runtime) {
	if (command.type === "list_sessions") {
		return await createRemoteListSessionsRpcResponse(command, authorization, options, runtime);
	}
	if (INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES.has(command.type)) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "unsupported_remote_command");
	}
	if (command.type === "register_live_activity") {
		return await createRemoteRegisterLiveActivityRpcResponse(command, authorization, options, runtime);
	}
	if (command.type === "unregister_live_activity") {
		return await createRemoteUnregisterLiveActivityRpcResponse(command, authorization, options, runtime);
	}
	const identityError = getIntegratedConversationIdentityError(command, authorization, runtime);
	if (identityError) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, identityError);
	}
	if (command.type === "get_transcript") {
		return createRemoteGetTranscriptRpcResponse(command, authorization, runtime);
	}
	return await handleRemoteHostRpcCommand(command, authorization, options);
}

async function createRemoteRegisterLiveActivityRpcResponse(command, authorization, options, runtime) {
	const id = getRpcResponseId(command);
	const request = parseRemoteLiveActivityRegistrationCommand(command, authorization, runtime);
	if (!request.ok) {
		await logLiveActivityRegistrationAudit(options, authorization, command, false, request.error);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", request.error);
	}
	const deliveryChannel = await options.stateManager.findClientLiveActivityDeliveryChannel(
		authorization.client.nodeId,
		{
			tokenHash: request.tokenHash,
			tokenEnvironment: request.tokenEnvironment,
			platform: request.platform,
		},
	);
	if (!deliveryChannel?.liveActivity) {
		await logLiveActivityRegistrationAudit(
			options,
			authorization,
			command,
			false,
			"unknown_live_activity_token",
			request,
		);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", "unknown_live_activity_token");
	}
	const now = Date.now();
	const result = await options.stateManager.registerClientLiveActivity(authorization.client.nodeId, {
		workspaceName: request.workspaceName,
		sessionId: request.sessionId,
		activityId: request.activityId,
		tokenHash: request.tokenHash,
		tokenEnvironment: request.tokenEnvironment,
		platform: request.platform,
		pushTargetId: deliveryChannel.id,
		createdAt: now,
		updatedAt: now,
	});
	if (!result.registration) {
		await logLiveActivityRegistrationAudit(options, authorization, command, false, "unknown_live_activity_token", request);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", "unknown_live_activity_token");
	}
	await logLiveActivityRegistrationAudit(options, authorization, command, true, undefined, request, {
		pushTargetId: deliveryChannel.id,
		replaced: result.replacedRegistration !== undefined,
	});
	return createRpcSuccessResponse(id, "register_live_activity", {
		status: "registered",
		activityId: request.activityId,
	});
}

async function createRemoteUnregisterLiveActivityRpcResponse(command, authorization, options, runtime) {
	const id = getRpcResponseId(command);
	const request = parseRemoteLiveActivityUnregistrationCommand(command, authorization, runtime);
	if (!request.ok) {
		await logLiveActivityRegistrationAudit(options, authorization, command, false, request.error);
		return createIrohRemoteRpcErrorResponse(id, "unregister_live_activity", request.error);
	}
	const removed = await options.stateManager.unregisterClientLiveActivity(
		authorization.client.nodeId,
		request.workspaceName,
		request.sessionId,
		request.activityId,
	);
	await logLiveActivityRegistrationAudit(options, authorization, command, true, undefined, request, { removed });
	return createRpcSuccessResponse(id, "unregister_live_activity", {
		status: "unregistered",
		activityId: request.activityId,
	});
}

function parseRemoteLiveActivityRegistrationCommand(command, authorization, runtime) {
	const common = parseRemoteLiveActivityCommandScope(command, authorization, runtime);
	if (!common.ok) {
		return common;
	}
	if (typeof command.tokenHash !== "string") {
		return { ok: false, error: "invalid_live_activity_token" };
	}
	if (!/^[0-9a-f]{64}$/.test(command.tokenHash)) {
		return { ok: false, error: "invalid_live_activity_token" };
	}
	if (command.tokenEnvironment !== "development" && command.tokenEnvironment !== "production") {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	if (command.platform !== "ios") {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	return {
		...common,
		tokenHash: command.tokenHash,
		tokenEnvironment: command.tokenEnvironment,
		platform: command.platform,
	};
}

function parseRemoteLiveActivityUnregistrationCommand(command, authorization, runtime) {
	return parseRemoteLiveActivityCommandScope(command, authorization, runtime);
}

function parseRemoteLiveActivityCommandScope(command, authorization, runtime) {
	if (
		typeof command.workspaceName !== "string" ||
		typeof command.sessionId !== "string" ||
		typeof command.activityId !== "string"
	) {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	if (command.workspaceName !== authorization.workspace.name || command.sessionId !== runtime.session.sessionId) {
		return { ok: false, error: "session_mismatch" };
	}
	if (!isValidLiveActivityId(command.activityId)) {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	return {
		ok: true,
		workspaceName: command.workspaceName,
		sessionId: command.sessionId,
		activityId: command.activityId,
	};
}

function isValidLiveActivityId(activityId) {
	return (
		activityId.length > 0 &&
		Array.from(activityId).length <= 128 &&
		Buffer.byteLength(activityId, "utf8") <= 512
	);
}

async function logLiveActivityRegistrationAudit(
	options,
	authorization,
	command,
	success,
	error,
	request,
	extraDetails = {},
) {
	const details = {
		command: command.type,
		...(request
			? {
					sessionId: request.sessionId,
					activityId: request.activityId,
					tokenHash: request.tokenHash,
					tokenEnvironment: request.tokenEnvironment,
					platform: request.platform,
				}
			: {}),
		...extraDetails,
	};
	await logAudit(options.auditLogger, {
		type: command.type === "unregister_live_activity" ? "live_activity_unregistered" : "live_activity_registered",
		clientNodeId: authorization.client.nodeId,
		workspace: request?.workspaceName ?? authorization.workspace.name,
		success,
		error,
		details,
	});
}

function getIntegratedConversationIdentityError(command, authorization, runtime) {
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

async function runWorkspaceUtilityRpcLoop(stream, handshake, authorization, handleCommand) {
	let buffer = Buffer.from(handshake.initialInput);
	while (true) {
		const result = await readLineFromIroh(stream.recv, buffer, {
			maxLineBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
		});
		if (result.line === undefined) {
			if (result.rest.length > 0) {
				const shouldClose = await handleCommand(result.rest.toString("utf8"));
				if (shouldClose) return;
			}
			return;
		}

		const shouldClose = await handleCommand(result.line);
		if (shouldClose) return;
		buffer = result.rest;
	}
}

async function runIntegratedWorkspaceDiscoveryConnection(
	stream,
	handshake,
	authorization,
	connection,
	connectionId,
	streamId,
	options,
) {
	await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
	const activeStream = registerActiveStream(
		options,
		authorization,
		WORKSPACE_DISCOVERY_STREAM_SESSION_ID,
		stream,
		connection,
		connectionId,
		streamId,
		{ terminalSessionId: undefined },
	);
	try {
		await runWorkspaceUtilityRpcLoop(stream, handshake, authorization, async (line) => {
			const parsed = parseRemoteRpcCommandLine(line);
			if (!parsed.ok) {
				await writeIrohRemoteRpcResponse(stream, parsed.response, authorization);
				return false;
			}
			if (parsed.command.type !== "list_sessions") {
				await writeIrohRemoteRpcResponse(
					stream,
					createRemoteRpcError(parsed.command, "unsupported_on_workspace_discovery_stream"),
					authorization,
				);
				return false;
			}
			await writeIrohRemoteRpcResponse(
				stream,
				await createRemoteListSessionsRpcResponse(parsed.command, authorization, options),
				authorization,
			);
			return false;
		});
	} finally {
		activeStream.remove();
	}
}

function parseWorkspaceManagementUnregisterRequest(command, authorization) {
	if (typeof command.workspaceName !== "string" || !isIrohRemoteWorkspaceName(command.workspaceName)) {
		return { ok: false, error: "invalid_workspace_payload" };
	}
	if (command.workspaceName !== authorization.workspace.name) {
		return { ok: false, error: "session_mismatch" };
	}
	for (const field of Object.keys(command)) {
		if (field !== "id" && field !== "type" && field !== "workspaceName") {
			return { ok: false, error: "invalid_request" };
		}
	}
	return { ok: true, workspaceName: command.workspaceName };
}

async function closeActiveStreamsForWorkspace(options, workspaceName, reason, excludedEntry) {
	const entries = options.activeStreams
		.entriesForWorkspaceName(workspaceName)
		.filter((entry) => entry !== excludedEntry);
	if (entries.length === 0) {
		return 0;
	}
	for (const entry of entries) {
		options.activeStreams.unregister(entry);
		await Promise.resolve(entry.close(reason)).catch(() => {});
	}
	await closeIdleConnectionsForEntries(options, entries, reason);
	return entries.length;
}

async function closeActiveStreamsForClientWorkspace(options, nodeId, workspaceName, reason) {
	const entries = options.activeStreams
		.entriesForClientNodeId(nodeId)
		.filter((entry) => entry.workspaceName === workspaceName);
	if (entries.length === 0) {
		return 0;
	}
	for (const entry of entries) {
		options.activeStreams.unregister(entry);
		await Promise.resolve(entry.close(reason)).catch(() => {});
	}
	await closeIdleConnectionsForEntries(options, entries, reason);
	return entries.length;
}

async function stopIntegratedRuntimesForWorkspace(options, workspaceName, reason) {
	let stoppedCount = 0;
	for (const entry of Array.from(options.integratedRuntimes.values())) {
		if (entry.workspaceName !== workspaceName) {
			continue;
		}
		await stopIntegratedRuntimeEntry(entry, options, reason);
		stoppedCount++;
	}
	return stoppedCount;
}

async function stopIntegratedRuntimesForClientWorkspace(options, nodeId, workspaceName, reason) {
	let stoppedCount = 0;
	for (const entry of Array.from(options.integratedRuntimes.values())) {
		if (entry.clientNodeId !== nodeId || entry.workspaceName !== workspaceName) {
			continue;
		}
		await stopIntegratedRuntimeEntry(entry, options, reason);
		stoppedCount++;
	}
	return stoppedCount;
}

async function closeWorkspaceAuthorizationRemovedStreams(options, nodeId, workspaceName) {
	const reason = "workspace_authorization_removed";
	const closedStreamCount = await closeActiveStreamsForClientWorkspace(options, nodeId, workspaceName, reason);
	const stoppedRuntimeCount = await stopIntegratedRuntimesForClientWorkspace(options, nodeId, workspaceName, reason);
	const removedLiveActivityCount = await options.stateManager.removeClientLiveActivitiesForWorkspace(
		nodeId,
		workspaceName,
	);
	await logAudit(options.auditLogger, {
		type: "workspace_authorization_removed",
		clientNodeId: nodeId,
		workspace: workspaceName,
		success: closedStreamCount > 0 || stoppedRuntimeCount > 0 || removedLiveActivityCount > 0,
		details: {
			closedStreamCount,
			removedLiveActivityCount,
			source: "authorization_failure",
			stoppedRuntimeCount,
		},
	});
}

async function handleWorkspaceManagementUnregisterCommand(command, authorization, activeStream, options) {
	const id = getRpcResponseId(command);
	const request = parseWorkspaceManagementUnregisterRequest(command, authorization);
	if (!request.ok) {
		return { close: false, response: createIrohRemoteRpcErrorResponse(id, "unregister_workspace", request.error) };
	}

	const removedWorkspace = await options.stateManager.unregisterWorkspace(request.workspaceName);
	if (!removedWorkspace) {
		return {
			close: false,
			response: createIrohRemoteRpcErrorResponse(id, "unregister_workspace", "workspace_unregistered"),
		};
	}
	const closedStreamCount = await closeActiveStreamsForWorkspace(
		options,
		request.workspaceName,
		WORKSPACE_UNREGISTERED_CLOSE_REASON,
		activeStream.entry,
	);
	const stoppedRuntimeCount = await stopIntegratedRuntimesForWorkspace(
		options,
		request.workspaceName,
		WORKSPACE_UNREGISTERED_CLOSE_REASON,
	);
	const removedLiveActivityCount = await options.stateManager.removeLiveActivitiesForWorkspace(request.workspaceName);
	await logAudit(options.auditLogger, {
		type: "workspace_unregistered",
		clientNodeId: authorization.client.nodeId,
		workspace: request.workspaceName,
		success: true,
		details: {
			closedStreamCount,
			removedLiveActivityCount,
			source: "remote_workspace_management_stream",
			stoppedRuntimeCount,
		},
	});
	return {
		close: true,
		response: createRpcSuccessResponse(id, "unregister_workspace", {
			workspaceName: request.workspaceName,
			unregistered: true,
		}),
	};
}

async function runIntegratedWorkspaceManagementConnection(
	stream,
	handshake,
	authorization,
	connection,
	connectionId,
	streamId,
	options,
) {
	await writeIrohRemoteHandshakeResponse(stream.send, handshake.response);
	const activeStream = registerActiveStream(
		options,
		authorization,
		WORKSPACE_MANAGEMENT_STREAM_SESSION_ID,
		stream,
		connection,
		connectionId,
		streamId,
		{ terminalSessionId: undefined },
	);
	try {
		await runWorkspaceUtilityRpcLoop(stream, handshake, authorization, async (line) => {
			const parsed = parseRemoteRpcCommandLine(line);
			if (!parsed.ok) {
				await writeIrohRemoteRpcResponse(stream, parsed.response, authorization);
				return false;
			}
			if (parsed.command.type !== "unregister_workspace") {
				await writeIrohRemoteRpcResponse(
					stream,
					createRemoteRpcError(parsed.command, "unsupported_on_workspace_management_stream"),
					authorization,
				);
				return false;
			}
			const result = await handleWorkspaceManagementUnregisterCommand(parsed.command, authorization, activeStream, options);
			await writeIrohRemoteRpcResponse(stream, result.response, authorization);
			if (!result.close) {
				return false;
			}
			activeStream.remove();
			closeIrohRemoteStream(stream, WORKSPACE_UNREGISTERED_CLOSE_REASON);
			return true;
		});
	} finally {
		activeStream.remove();
	}
}

function createPushNotificationDispatcher(authorization, options) {
	if (!options.pushRelayClient) {
		return undefined;
	}
	return new IrohRemotePushNotificationDispatcher({
		auditLogger: options.auditLogger,
		clientNodeId: authorization.client.nodeId,
		deduper: options.pushNotificationDeduper,
		relayClient: options.pushRelayClient,
		stateManager: options.stateManager,
		workspace: authorization.workspace.name,
	});
}

async function recordRemoteSessionChange(session, authorization, options) {
	try {
		const client = await options.hostEngine.setClientLastSessionId(
			authorization.client.nodeId,
			authorization.workspace.name,
			session.sessionId,
		);
		await logAudit(options.auditLogger, {
			type: "session_changed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: client !== undefined,
			error: client ? undefined : "client not found",
			details: { reason: "remote_rpc_session_change", sessionId: session.sessionId },
		});
	} catch (error) {
		await logAudit(options.auditLogger, {
			type: "session_changed",
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			details: { reason: "remote_rpc_session_change", sessionId: session.sessionId },
		});
	}
}

async function logRemoteSessionSelection(selection, authorization, options) {
	const common = {
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
	};
	if (selection.kind === "resumed") {
		await logAudit(options.auditLogger, {
			...common,
			type: "session_resumed",
			success: true,
			details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
		});
		return;
	}
	if (selection.kind === "created_after_missing") {
		await logAudit(options.auditLogger, {
			...common,
			type: "session_missing_on_resume",
			success: false,
			error: "session not found",
			details: { requestedSessionId: selection.requestedSessionId },
		});
		await logAudit(options.auditLogger, {
			...common,
			type: "session_created",
			success: true,
			details: { reason: "missing_on_resume", sessionId: selection.sessionId },
		});
		return;
	}
	await logAudit(options.auditLogger, {
		...common,
		type: "session_created",
		success: true,
		details: { reason: "new_client_connection", sessionId: selection.sessionId },
	});
}

function getIntegratedRuntimeRegistryKey(clientNodeId, workspaceName, sessionId) {
	return `${clientNodeId}\0${workspaceName}\0${sessionId}`;
}

function getIntegratedRuntimeDetails(entry, extraDetails = {}) {
	return {
		runtime: "integrated-volt",
		sessionId: entry.sessionId,
		subscriberCount: entry.subscribers.size,
		active: entry.runtime.session.isStreaming,
		...extraDetails,
	};
}

async function logIntegratedRuntimeAudit(options, entry, type, details = {}, success = true, error) {
	await logAudit(options.auditLogger, {
		type,
		clientNodeId: entry.clientNodeId,
		workspace: entry.workspaceName,
		success,
		error,
		details: getIntegratedRuntimeDetails(entry, details),
	});
}

async function createIntegratedRuntimeEntry(handshake, authorization, options) {
	let runtime;
	let sessionSelection;
	try {
		const runtimeResult = await createIrohRemoteAgentRuntimeWithSessionSelection({
			agentDir: options.agentDir,
			allowTools: authorization.allowTools,
			conversationTarget: createIrohRuntimeConversationTarget(handshake.hello, authorization),
			cwd: authorization.workspace.path,
			profile: options.profile,
			projectTrusted: getProjectTrustedForWorkspace(options, authorization.workspace),
		});
		runtime = runtimeResult.runtime;
		sessionSelection = runtimeResult.sessionSelection;
		const sessionId = runtime.session.sessionId;
		const owner = findIntegratedRuntimeOwner(options, authorization.workspace.name, sessionId);
		if (owner && owner.clientNodeId !== authorization.client.nodeId) {
			throw createConversationOpenError("conversation_in_use", "conversation is already in use", {
				workspace: authorization.workspace.name,
				sessionId,
			});
		}
		if (owner) {
			await cleanupUncommittedRuntime(runtime, sessionSelection);
			return { entry: owner, created: false, sessionSelection: createConversationSessionSelectionFromEntry(owner) };
		}
		const entry = {
			key: getIntegratedRuntimeRegistryKey(
				authorization.client.nodeId,
				authorization.workspace.name,
				sessionId,
			),
			clientNodeId: authorization.client.nodeId,
			workspaceName: authorization.workspace.name,
			sessionId,
			runtime,
			recordedSessionId: sessionId,
			subscribers: new Set(),
			detachedAt: undefined,
			detachedRuntimeRetention: undefined,
		};
		return { entry, created: true, sessionSelection };
	} catch (error) {
		if (runtime) {
			await cleanupUncommittedRuntime(runtime, sessionSelection);
		}
		throw error;
	}
}

async function commitIntegratedRuntimeEntry(entry, sessionSelection, authorization, options) {
	const owner = findIntegratedRuntimeOwner(options, authorization.workspace.name, entry.sessionId);
	if (owner && owner !== entry) {
		throw createConversationOpenError("conversation_in_use", "conversation is already in use", {
			workspace: authorization.workspace.name,
			sessionId: entry.sessionId,
		});
	}

	const inserted = options.integratedRuntimes.get(entry.key) !== entry;
	if (inserted) {
		options.integratedRuntimes.set(entry.key, entry);
	}

	try {
		await options.hostEngine.setClientLastSessionId(
			authorization.client.nodeId,
			authorization.workspace.name,
			entry.sessionId,
		);
		await logRemoteSessionSelection(sessionSelection, authorization, options);
		if (inserted) {
			await logAudit(options.auditLogger, {
				type: "runtime_started",
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: true,
				details: getIntegratedRuntimeDetails(entry),
			});
			await logIntegratedRuntimeAudit(options, entry, "remote_runtime_started", { reason: "created" });
		}
	} catch (error) {
		if (inserted && options.integratedRuntimes.get(entry.key) === entry) {
			options.integratedRuntimes.delete(entry.key);
		}
		throw error;
	}
}

async function cleanupUncommittedIntegratedRuntimeEntry(entry, sessionSelection, options) {
	if (options.integratedRuntimes.get(entry.key) === entry) {
		options.integratedRuntimes.delete(entry.key);
	}
	cancelIntegratedRuntimeRetention(entry);
	entry.subscribers.clear();
	await cleanupUncommittedRuntime(entry.runtime, sessionSelection);
}

async function cleanupUncommittedRuntime(runtime, sessionSelection) {
	const sessionFile = runtime.session.sessionFile;
	await runtime.dispose().catch(() => {});
	if (sessionSelection?.kind === "resumed") {
		return;
	}
	if (typeof sessionFile === "string" && sessionFile.length > 0) {
		await rm(sessionFile, { force: true }).catch(() => {});
	}
}

function createIrohRuntimeConversationTarget(hello, authorization) {
	if (hello.mode !== "conversation") {
		throw new Error("integrated runtime requires a conversation stream");
	}
	if (hello.conversation.target === "new") {
		return { target: "new" };
	}
	if (hello.conversation.target === "session") {
		return { target: "session", sessionId: hello.conversation.sessionId };
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return previousSessionId === undefined
		? { target: "last" }
		: { target: "last", resumeSessionId: previousSessionId };
}

function getResolvedTargetSessionId(hello, authorization) {
	if (hello.mode !== "conversation") {
		return undefined;
	}
	if (hello.conversation.target === "session") {
		return hello.conversation.sessionId;
	}
	if (hello.conversation.target !== "last") {
		return undefined;
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return isIrohRemoteSessionId(previousSessionId) ? previousSessionId : undefined;
}

function findIntegratedRuntimeEntry(options, clientNodeId, workspaceName, sessionId) {
	return options.integratedRuntimes.get(getIntegratedRuntimeRegistryKey(clientNodeId, workspaceName, sessionId));
}

function findIntegratedRuntimeOwner(options, workspaceName, sessionId) {
	for (const entry of options.integratedRuntimes.values()) {
		if (entry.workspaceName === workspaceName && entry.sessionId === sessionId) {
			return entry;
		}
	}
	return undefined;
}

function createConversationOpenError(outcome, message, details = {}) {
	const error = new IrohRemoteHandshakeError(outcome, message);
	Object.assign(error, details);
	return error;
}

function createConversationSessionSelectionFromEntry(entry) {
	return {
		kind: "resumed",
		requestedSessionId: entry.sessionId,
		sessionId: entry.sessionId,
	};
}

function getHandshakeConversationSelection(sessionSelection) {
	if (sessionSelection.kind === "created_after_missing") {
		return "created_missing_last";
	}
	if (sessionSelection.kind === "created") {
		return "created";
	}
	return "resumed";
}

function createIntegratedConversationHandshakeResponse(handshake, authorization, entry, sessionSelection, options) {
	const sessionId = entry.sessionId;
	return createIrohRemoteHandshakeSuccess({
		child: handshake.response.child,
		clientNodeId: authorization.client.nodeId,
		features: handshake.response.features,
		hostNodeId: options.hostNodeId,
		workspace: authorization.workspace.name,
		sessionId,
		conversation: {
			target: handshake.hello.conversation.target,
			sessionId,
			selection: getHandshakeConversationSelection(sessionSelection),
		},
	});
}

async function getOrCreateIntegratedRuntimeEntry(handshake, authorization, options) {
	const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
	if (targetSessionId !== undefined) {
		const owner = findIntegratedRuntimeOwner(options, authorization.workspace.name, targetSessionId);
		if (owner && owner.clientNodeId !== authorization.client.nodeId) {
			throw createConversationOpenError("conversation_in_use", "conversation is already in use", {
				workspace: authorization.workspace.name,
				sessionId: targetSessionId,
			});
		}
		const existing = findIntegratedRuntimeEntry(
			options,
			authorization.client.nodeId,
			authorization.workspace.name,
			targetSessionId,
		);
		if (existing) {
			if (!shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization(authorization)) {
				return { entry: existing, created: false, sessionSelection: createConversationSessionSelectionFromEntry(existing) };
			}
			await stopIntegratedRuntimeEntry(existing, options, "fresh_pairing_replaced_runtime");
		}
	}
	return createIntegratedRuntimeEntry(handshake, authorization, options);
}

let integratedRuntimeSubscriberSequence = 0;

async function attachIntegratedRuntimeSubscriber(entry, options) {
	const wasDetached = entry.subscribers.size === 0 && entry.detachedAt !== undefined;
	cancelIntegratedRuntimeRetention(entry);
	const subscriber = {
		id: `subscriber-${++integratedRuntimeSubscriberSequence}`,
		attachedAt: Date.now(),
	};
	entry.subscribers.add(subscriber);
	if (wasDetached) {
		entry.detachedAt = undefined;
		await logIntegratedRuntimeAudit(options, entry, "remote_runtime_reattached", {
			reason: "subscriber_attached",
			subscriberId: subscriber.id,
		});
	}
	await logIntegratedRuntimeAudit(options, entry, "remote_subscriber_attached", {
		subscriberId: subscriber.id,
	});
	return subscriber;
}

async function detachIntegratedRuntimeSubscriber(entry, subscriber, options, reason, error) {
	if (!entry.subscribers.delete(subscriber)) {
		return;
	}
	const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
	await logIntegratedRuntimeAudit(
		options,
		entry,
		"remote_subscriber_detached",
		{ reason, subscriberId: subscriber.id },
		errorMessage === undefined,
		errorMessage,
	);
	if (entry.subscribers.size > 0) {
		return;
	}
	entry.detachedAt = Date.now();
	await logIntegratedRuntimeAudit(options, entry, "remote_runtime_detached", {
		detachedAt: entry.detachedAt,
		reason,
	});
	scheduleIntegratedRuntimeRetention(entry, options, reason);
}

async function detachIntegratedRuntimeWithoutSubscriber(entry, options, reason) {
	if (options.integratedRuntimes.get(entry.key) !== entry || entry.subscribers.size > 0) {
		return;
	}
	if (entry.detachedAt !== undefined) {
		return;
	}
	entry.detachedAt = Date.now();
	await logIntegratedRuntimeAudit(options, entry, "remote_runtime_detached", {
		detachedAt: entry.detachedAt,
		reason,
	});
	scheduleIntegratedRuntimeRetention(entry, options, reason);
}

async function stopIntegratedRuntimeEntry(entry, options, reason) {
	if (!options.integratedRuntimes.has(entry.key)) {
		return;
	}
	cancelIntegratedRuntimeRetention(entry);
	options.integratedRuntimes.delete(entry.key);
	entry.subscribers.clear();
	entry.detachedAt = undefined;
	const wasActive = entry.runtime.session.isStreaming;
	const removedLiveActivityCount = await options.stateManager.removeClientLiveActivitiesForSession(
		entry.clientNodeId,
		entry.workspaceName,
		entry.sessionId,
	);
	let stopSuccess = true;
	let stopError;
	try {
		await entry.runtime.dispose();
	} catch (error) {
		stopSuccess = false;
		stopError = error instanceof Error ? error.message : String(error);
	}
	await logAudit(options.auditLogger, {
		type: "runtime_stopped",
		clientNodeId: entry.clientNodeId,
		workspace: entry.workspaceName,
		success: stopSuccess,
		error: stopError,
		details: getIntegratedRuntimeDetails(entry, { active: wasActive, reason, removedLiveActivityCount }),
	});
	await logIntegratedRuntimeAudit(
		options,
		entry,
		"remote_runtime_stopped",
		{ active: wasActive, reason, removedLiveActivityCount },
		stopSuccess,
		stopError,
	);
}

function cancelIntegratedRuntimeRetention(entry) {
	if (!entry.detachedRuntimeRetention) {
		return;
	}
	entry.detachedRuntimeRetention.cancel();
	entry.detachedRuntimeRetention = undefined;
}

function isIntegratedRuntimeDetached(entry, options) {
	return (
		options.integratedRuntimes.get(entry.key) === entry &&
		entry.subscribers.size === 0 &&
		entry.detachedAt !== undefined
	);
}

function scheduleIntegratedRuntimeRetention(entry, options, detachReason) {
	cancelIntegratedRuntimeRetention(entry);
	entry.detachedRuntimeRetention = scheduleDetachedRuntimeRetention({
		ttlMs: options.detachedRuntimeTtlMs,
		isDetached: () => isIntegratedRuntimeDetached(entry, options),
		isActive: () => entry.runtime.session.isStreaming,
		waitForIdle: () => entry.runtime.session.waitForIdle(),
		onExpire: async () => {
			if (!isIntegratedRuntimeDetached(entry, options) || entry.runtime.session.isStreaming) {
				return;
			}
			await logIntegratedRuntimeAudit(options, entry, "remote_runtime_retention_expired", {
				detachedAt: entry.detachedAt,
				detachReason,
				reason: "detached_runtime_ttl_expired",
				ttlMs: options.detachedRuntimeTtlMs,
			});
			await stopIntegratedRuntimeEntry(entry, options, "detached_runtime_ttl_expired");
		},
		onError: (error) => {
			void logIntegratedRuntimeAudit(
				options,
				entry,
				"remote_runtime_retention_expired",
				{
					detachedAt: entry.detachedAt,
					detachReason,
					reason: "detached_runtime_ttl_error",
					ttlMs: options.detachedRuntimeTtlMs,
				},
				false,
				error instanceof Error ? error.message : String(error),
			);
		},
	});
}

async function stopIntegratedRuntimes(options, reason) {
	for (const entry of Array.from(options.integratedRuntimes.values())) {
		await stopIntegratedRuntimeEntry(entry, options, reason);
	}
}

async function stopIntegratedRuntimesForClient(options, nodeId, reason) {
	let stoppedCount = 0;
	for (const entry of Array.from(options.integratedRuntimes.values())) {
		if (entry.clientNodeId !== nodeId) {
			continue;
		}
		await stopIntegratedRuntimeEntry(entry, options, reason);
		stoppedCount++;
	}
	return stoppedCount;
}

function registerClientConnection(options, nodeId, connection, connectionId) {
	const entry = {
		connectionId,
		close: (reason) => closeConnection(connection, reason),
	};
	let entries = options.clientConnections.get(nodeId);
	if (!entries) {
		entries = new Set();
		options.clientConnections.set(nodeId, entries);
	}
	entries.add(entry);
	let removed = false;
	return () => {
		if (removed) {
			return;
		}
		removed = true;
		entries.delete(entry);
		if (entries.size === 0 && options.clientConnections.get(nodeId) === entries) {
			options.clientConnections.delete(nodeId);
		}
	};
}

async function closeClientConnectionsForClient(options, nodeId, reason) {
	const entries = Array.from(options.clientConnections.get(nodeId) ?? []);
	if (entries.length === 0) {
		return 0;
	}

	options.clientConnections.delete(nodeId);
	for (const entry of entries) {
		try {
			await Promise.resolve(entry.close(reason));
		} catch {
			// Connection closure is best-effort; the transport may already be closing.
		}
	}
	return entries.length;
}

function registerActiveStream(options, authorization, sessionId, stream, connection, connectionId, streamId, details = {}) {
	const terminalSessionId = Object.hasOwn(details, "terminalSessionId") ? details.terminalSessionId : sessionId;
	const entry = {
		clientNodeId: authorization.client.nodeId,
		connectionId,
		sessionId,
		streamId,
		workspaceName: authorization.workspace.name,
		close: (reason) =>
			closeIrohRemoteStreamWithTerminal(stream, reason, {
				authorization,
				hostNodeId: options.hostNodeId,
				sessionId: terminalSessionId,
				workspace: authorization.workspace.name,
			}),
		closeConnection: (reason) => closeConnection(connection, reason),
	};
	const remove = options.activeStreams.register(entry);
	return { entry, remove };
}

function getActiveStreamsForAuthorization(options, authorization) {
	return options.activeStreams.entriesForWorkspace(authorization.client.nodeId, authorization.workspace.name);
}

function getActiveStreamsForConversation(options, authorization, sessionId) {
	return options.activeStreams.entriesForConversation(
		authorization.client.nodeId,
		authorization.workspace.name,
		sessionId,
	);
}

function hasActiveStreamForAuthorizationOnConnection(options, authorization, connectionId) {
	return options.activeStreams.hasWorkspaceOnConnection(
		authorization.client.nodeId,
		authorization.workspace.name,
		connectionId,
	);
}

function hasActiveStreamForConversationOnConnection(options, authorization, sessionId, connectionId) {
	return options.activeStreams.hasConversationOnConnection(
		authorization.client.nodeId,
		authorization.workspace.name,
		sessionId,
		connectionId,
	);
}

function takeActiveStreamsForAuthorization(options, authorization) {
	const matchingEntries = getActiveStreamsForAuthorization(options, authorization);
	if (matchingEntries.length === 0) {
		return [];
	}

	for (const entry of matchingEntries) {
		options.activeStreams.unregister(entry);
	}
	return matchingEntries;
}

async function closeReplacedActiveStreams(options, authorization, replacementStreamId, replacedEntries) {
	if (replacedEntries.length === 0) {
		return { replaced: false, closedCount: 0 };
	}

	const replacedStreamIds = replacedEntries.map((entry) => entry.streamId);
	for (const entry of replacedEntries) {
		await Promise.resolve(entry.close(ACTIVE_REPLACE_CLOSE_REASON)).catch(() => {});
	}
	await closeIdleConnectionsForEntries(options, replacedEntries, ACTIVE_REPLACE_CLOSE_REASON);
	console.error(
		`client stream replaced: ${authorization.client.nodeId}/${authorization.workspace.name} (${replacedStreamIds.join(", ")} -> ${replacementStreamId})`,
	);
	await logAudit(options.auditLogger, {
		type: "duplicate_connection_replaced",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: true,
		details: {
			closeReason: ACTIVE_REPLACE_CLOSE_REASON,
			closedCount: replacedEntries.length,
			replacedStreamIds,
			replacementStreamId,
			source: "active_stream_registry",
		},
	});
	return { replaced: true, closedCount: replacedEntries.length };
}

async function rejectDuplicateActiveConnection(stream, authorization, options, sessionId) {
	const error = "duplicate conversation connection";
	await logAudit(options.auditLogger, {
		type: "duplicate_connection_rejected",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: false,
		error,
		details: {
			retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
			sessionId,
			source: "active_stream_registry",
		},
	});
	await writeIrohRemoteHandshakeResponse(
		stream.send,
		createIrohRemoteHandshakeFailure(error, {
			hostNodeId: options.hostNodeId,
			outcome: "duplicate_conversation_connection",
			workspace: authorization.workspace.name,
			sessionId,
			retryAfterMs: DUPLICATE_CONVERSATION_RETRY_AFTER_MS,
		}),
	);
	await stream.send.finish?.();
	await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

async function rejectUnsupportedConversationStreams(stream, handshake, options) {
	const error = new IrohRemoteHandshakeError(
		"conversation_streams_unsupported",
		"conversation stream modes require integrated Volt host mode",
	);
	await logAudit(options.auditLogger, {
		type: "handshake_rejected",
		clientNodeId: handshake.authorization.client.nodeId,
		workspace: handshake.authorization.workspace.name,
		success: false,
		error: error.message,
		details: { mode: handshake.hello.mode, outcome: error.outcome },
	});
	await sendHandshakeError(stream, error, options);
}

function getHandshakeChildLabel(options) {
	return options.integratedVolt || options.useVolt ? "volt" : "fake-rpc";
}

function getRemoteTerminalReason(reason) {
	if (reason === ACTIVE_REVOKE_CLOSE_REASON) {
		return "client_revoked";
	}
	if (reason === WORKSPACE_UNREGISTERED_CLOSE_REASON || reason === "workspace_authorization_removed") {
		return reason;
	}
	return undefined;
}

function closeIrohRemoteStream(stream, _reason) {
	void Promise.resolve(stream.send.finish?.()).catch(() => {});
	void Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
}

async function closeIrohRemoteStreamWithTerminal(stream, reason, terminal) {
	const terminalReason = getRemoteTerminalReason(reason);
	if (terminalReason) {
		await writeIrohRemoteJsonLine(
			stream.send,
			{
				type: "remote_terminal",
				reason: terminalReason,
				workspace: terminal.workspace,
				...(terminal.sessionId === undefined ? {} : { sessionId: terminal.sessionId }),
				hostNodeId: terminal.hostNodeId,
			},
			terminal.authorization,
		).catch(() => {});
	}
	closeIrohRemoteStream(stream, reason);
}

async function closeEntryConnection(entry, reason) {
	try {
		await Promise.resolve(entry.closeConnection?.(reason));
	} catch {
		// Connection closure is best-effort. Stream teardown still drives task cleanup.
	}
}

async function closeIdleConnectionsForEntries(options, entries, reason) {
	const closedConnectionIds = new Set();
	for (const entry of entries) {
		if (closedConnectionIds.has(entry.connectionId)) {
			continue;
		}
		if (options.activeStreams.entriesForConnection(entry.connectionId).length > 0) {
			continue;
		}
		closedConnectionIds.add(entry.connectionId);
		await closeEntryConnection(entry, reason);
	}
}

async function closeActiveStreamsForClient(options, nodeId) {
	const entries = options.activeStreams.entriesForClientNodeId(nodeId);
	if (entries.length === 0) {
		const closedConnectionCount = await closeClientConnectionsForClient(options, nodeId, ACTIVE_REVOKE_CLOSE_REASON);
		const stoppedRuntimeCount = await stopIntegratedRuntimesForClient(options, nodeId, "client_revoked");
		const closed = closedConnectionCount > 0;
		await logAudit(options.auditLogger, {
			type: "active_connection_revoked",
			clientNodeId: nodeId,
			success: closed || stoppedRuntimeCount > 0,
			error: closed || stoppedRuntimeCount > 0 ? undefined : "no active connection found",
			details: {
				closeReason: ACTIVE_REVOKE_CLOSE_REASON,
				closedConnectionCount,
				source: "control_channel",
				stoppedRuntimeCount,
			},
		});
		return { closed, closedCount: closedConnectionCount };
	}

	for (const entry of entries) {
		options.activeStreams.unregister(entry);
		await Promise.resolve(entry.close(ACTIVE_REVOKE_CLOSE_REASON)).catch(() => {});
	}
	await closeIdleConnectionsForEntries(options, entries, ACTIVE_REVOKE_CLOSE_REASON);
	const closedConnectionCount = await closeClientConnectionsForClient(options, nodeId, ACTIVE_REVOKE_CLOSE_REASON);
	const stoppedRuntimeCount = await stopIntegratedRuntimesForClient(options, nodeId, "client_revoked");
	for (const entry of entries) {
		await logAudit(options.auditLogger, {
			type: "active_connection_revoked",
			clientNodeId: nodeId,
			workspace: entry.workspaceName,
			success: true,
			details: {
				closeReason: ACTIVE_REVOKE_CLOSE_REASON,
				closedConnectionCount,
				source: "control_channel",
				streamId: entry.streamId,
				stoppedRuntimeCount,
			},
		});
	}
	return { closed: true, closedCount: entries.length };
}

async function handleConnectionStream(
	stream,
	connection,
	remoteId,
	connectionId,
	streamId,
	options,
	replaceExistingWorkspaceStream,
) {
	const handshake = await options.hostEngine.readHandshake(stream, remoteId, {
		allowLegacyWorkspaceMode: !options.integratedVolt,
		child: getHandshakeChildLabel(options),
		maxLineBytes: DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
		timeoutMs: DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS,
		writeSuccessResponse: false,
	});
	if (!handshake.ok) {
		if (
			handshake.response?.outcome === "workspace_authorization_removed" &&
			typeof handshake.response.workspace === "string"
		) {
			await closeWorkspaceAuthorizationRemovedStreams(options, remoteId, handshake.response.workspace);
		}
		await stream.send.finish?.();
		await Promise.resolve(stream.recv.stop?.(0n)).catch(() => {});
		return;
	}

	if (handshake.authorization.paired) {
		console.error(`paired client stream: ${handshake.authorization.client.label} (${remoteId}, ${streamId})`);
	}

	if (handshake.hello.mode !== "conversation") {
		if (!options.integratedVolt) {
			if (handshake.hello.mode !== "legacyWorkspace") {
				await rejectUnsupportedConversationStreams(stream, handshake, options);
				return;
			}
		} else {
			if (handshake.hello.mode === "workspaceDiscovery") {
				await runIntegratedWorkspaceDiscoveryConnection(
					stream,
					handshake,
					handshake.authorization,
					connection,
					connectionId,
					streamId,
					options,
				);
				return;
			}
			await runIntegratedWorkspaceManagementConnection(
				stream,
				handshake,
				handshake.authorization,
				connection,
				connectionId,
				streamId,
				options,
			);
			return;
		}
	} else if (!options.integratedVolt) {
		await rejectUnsupportedConversationStreams(stream, handshake, options);
		return;
	}

	if (options.integratedVolt) {
		await runIntegratedVoltConnection(
			stream,
			handshake,
			handshake.authorization,
			connection,
			connectionId,
			streamId,
			options,
		);
		return;
	}

	if (hasActiveStreamForAuthorizationOnConnection(options, handshake.authorization, connectionId)) {
		await rejectDuplicateActiveConnection(stream, handshake.authorization, options, LEGACY_WORKSPACE_SESSION_ID);
		return;
	}

	const matchingActiveStreams = getActiveStreamsForAuthorization(options, handshake.authorization);
	if (matchingActiveStreams.length > 0 && !replaceExistingWorkspaceStream) {
		await rejectDuplicateActiveConnection(stream, handshake.authorization, options, LEGACY_WORKSPACE_SESSION_ID);
		return;
	}
	const replacedEntries = replaceExistingWorkspaceStream
		? takeActiveStreamsForAuthorization(options, handshake.authorization)
		: [];
	let child;
	const activeStream = registerActiveStream(
		options,
		handshake.authorization,
		LEGACY_WORKSPACE_SESSION_ID,
		stream,
		connection,
		connectionId,
		streamId,
	);
	if (replaceExistingWorkspaceStream) {
		await closeReplacedActiveStreams(options, handshake.authorization, streamId, replacedEntries);
	}

	try {
		child = await runSpawnedRpcConnection(stream, handshake, handshake.authorization, options);
	} finally {
		if (child && child.exitCode === null && !child.killed) child.kill();
		activeStream.remove();
	}
}

function closeConnection(connection, reason) {
	connection.close(0n, Array.from(Buffer.from(reason, "utf8")));
}

async function closeActiveStreamsForConnection(options, connectionId, reason) {
	const entries = options.activeStreams.entriesForConnection(connectionId);
	for (const entry of entries) {
		options.activeStreams.unregister(entry);
		await Promise.resolve(entry.close(reason)).catch(() => {});
	}
}

async function handleConnection(incoming, options) {
	const accepting = await incoming.accept();
	const connection = await accepting.connect();
	const remoteId = connection.remoteId().toString();
	const connectionId = `conn-${++activeConnectionSequence}`;
	const removeClientConnection = registerClientConnection(options, remoteId, connection, connectionId);
	const streamTasks = new Set();
	let acceptedStreamCount = 0;
	let closeRequested = false;
	console.error(`client connection opened: ${remoteId} (${connectionId})`);
	await logAudit(options.auditLogger, {
		type: "client_connected",
		clientNodeId: remoteId,
		workspace: options.workspace.name,
		success: true,
		details: { connectionId },
	});

	const requestCloseWhenIdle = () => {
		if (closeRequested || acceptedStreamCount === 0 || streamTasks.size > 0) {
			return;
		}
		closeRequested = true;
		closeConnection(connection, "done");
	};

	try {
		while (!closeRequested) {
			const stream = await (acceptedStreamCount === 0
				? withTimeout(connection.acceptBi(), DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS, "handshake timed out")
				: connection.acceptBi());
			acceptedStreamCount++;
			const streamId = `stream-${++activeStreamSequence}`;
			const replaceExistingWorkspaceStream = acceptedStreamCount === 1;
			const task = handleConnectionStream(
				stream,
				connection,
				remoteId,
				connectionId,
				streamId,
				options,
				replaceExistingWorkspaceStream,
			)
				.catch((error) => {
					if (!isExpectedApplicationClose(error)) {
						console.error(error instanceof Error ? error.stack : String(error));
					}
				})
				.finally(() => {
					streamTasks.delete(task);
					requestCloseWhenIdle();
				});
			streamTasks.add(task);
		}
	} catch (error) {
		if (acceptedStreamCount === 0) {
			throw error;
		}
	} finally {
		await closeActiveStreamsForConnection(options, connectionId, "connection_closed");
		await Promise.allSettled(streamTasks);
		removeClientConnection();
		if (!closeRequested) {
			closeConnection(connection, "done");
		}
		await waitForConnectionClose(connection);
		console.error(`client connection closed: ${remoteId} (${connectionId})`);
		await logAudit(options.auditLogger, {
			type: "client_disconnected",
			clientNodeId: remoteId,
			workspace: options.workspace.name,
			success: true,
			details: { connectionId },
		});
	}
}

function readLineFromControlSocket(socket) {
	return new Promise((resolveLine, rejectLine) => {
		let buffer = "";
		const cleanup = () => {
			socket.off("data", handleData);
			socket.off("end", handleEnd);
			socket.off("error", handleError);
		};
		const handleData = (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > CONTROL_REQUEST_MAX_BYTES) {
				cleanup();
				rejectLine(new Error(`Control request exceeds ${CONTROL_REQUEST_MAX_BYTES} bytes`));
				return;
			}
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			cleanup();
			resolveLine(buffer.slice(0, newlineIndex));
		};
		const handleEnd = () => {
			cleanup();
			rejectLine(new Error("Control request ended before a line was received"));
		};
		const handleError = (error) => {
			cleanup();
			rejectLine(error);
		};
		socket.setEncoding("utf8");
		socket.on("data", handleData);
		socket.once("end", handleEnd);
		socket.once("error", handleError);
	});
}

function createControlErrorResponse(type, message) {
	return {
		type,
		success: false,
		error: message,
	};
}

function getControlResponseType(request) {
	if (request.type === IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE) {
		return IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE;
	}
	return IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
}

async function resolvePairControlWorkspace(request, options) {
	const state = await options.stateManager.getState();
	const workspace = state.workspaces.find((entry) => entry.name === request.workspace);
	if (!workspace) {
		return { error: `workspace_unavailable: workspace not registered: ${request.workspace}` };
	}
	if (!(await isWorkspaceDirectoryAvailable(workspace))) {
		return { error: `workspace_unavailable: workspace path is unavailable: ${request.workspace}` };
	}
	return { workspace };
}

async function createPairControlSuccessResponse(request, endpoint, options) {
	const workspaceResult = await resolvePairControlWorkspace(request, options);
	if (workspaceResult.error) {
		return createControlErrorResponse(IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE, workspaceResult.error);
	}
	const workspace = workspaceResult.workspace;
	if (request.relayMode !== undefined && request.relayMode !== options.relayMode) {
		return createControlErrorResponse(
			IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
			`running host relay mode is ${options.relayMode}; cannot create a ${request.relayMode} ticket`,
		);
	}

	const allowTools = request.allowTools ?? workspace.allowedTools ?? options.allowTools;
	const unsafeTools = getIrohRemoteUnsafeAllowedTools(allowTools);
	if (unsafeTools.length > 0) {
		if (!request.unsafeApproval) {
			return createControlErrorResponse(
				IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
				"Unsafe remote tool grants require confirmation or --yes.",
			);
		}
		await logAudit(options.auditLogger, {
			type: "unsafe_tools_enabled",
			workspace: workspace.name,
			success: true,
			details: {
				allowTools,
				approval: request.unsafeApproval,
				context: "pair_command",
				unsafeTools,
			},
		});
	}

	const pairing = await options.hostEngine.pair({
		allowTools,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		labelHint: request.labelHint,
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		ttlMs: request.ttlMs,
		workspace: workspace.name,
	});
	return {
		type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
		success: true,
		expiresAt: pairing.expiresAt,
		ticket: pairing.ticket,
	};
}

async function createRevokeControlSuccessResponse(request, options) {
	const result = await closeActiveStreamsForClient(options, request.nodeId);
	return {
		type: IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
		success: true,
		closed: result.closed,
		closedCount: result.closedCount,
	};
}

async function createControlSuccessResponse(request, endpoint, options) {
	if (request.type === IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE) {
		return await createPairControlSuccessResponse(request, endpoint, options);
	}
	return await createRevokeControlSuccessResponse(request, options);
}

async function handlePairControlConnection(socket, endpoint, options) {
	let responseType = IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
	try {
		const line = await readLineFromControlSocket(socket);
		const request = parseIrohRemoteControlRequest(JSON.parse(line));
		responseType = getControlResponseType(request);
		const response = await createControlSuccessResponse(request, endpoint, options);
		socket.end(`${JSON.stringify(response)}\n`);
	} catch (error) {
		socket.end(
			`${JSON.stringify(createControlErrorResponse(responseType, error instanceof Error ? error.message : String(error)))}\n`,
		);
	}
}

async function startPairControlServer(endpoint, options) {
	const controlPath = getIrohRemoteControlPath(options.statePath);
	const server = createServer((socket) => {
		handlePairControlConnection(socket, endpoint, options).catch((error) => {
			socket.end(
				`${JSON.stringify(
					createControlErrorResponse(
						IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
						error instanceof Error ? error.message : String(error),
					),
				)}\n`,
			);
		});
	});
	await listenIrohRemoteControlServer(server, controlPath);
	return { controlPath, server };
}

async function closePairControlServer(controlServer) {
	if (!controlServer) return;
	await new Promise((resolveClose) => {
		controlServer.server.close(() => resolveClose());
	});
	if (process.platform !== "win32") {
		await rm(controlServer.controlPath, { force: true });
	}
}

function installControlPathExitCleanup(controlPath) {
	if (process.platform === "win32") {
		return () => {};
	}
	const cleanup = () => {
		rmSync(controlPath, { force: true });
	};
	process.once("exit", cleanup);
	return () => {
		process.off("exit", cleanup);
	};
}

function installShutdownSignalHandlers(requestShutdown) {
	const signals = ["SIGINT", "SIGTERM"];
	const handlers = [];
	for (const signal of signals) {
		const handler = () => requestShutdown(signal);
		process.once(signal, handler);
		handlers.push([signal, handler]);
	}
	return () => {
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
	};
}

function createTicketPayload(endpoint, options, includePairingSecret) {
	return {
		alpn: IROH_REMOTE_ALPN,
		expiresAt: includePairingSecret ? options.ticketExpiresAt : undefined,
		irohTicket: EndpointTicket.fromAddr(endpoint.addr()).toString(),
		nodeId: endpoint.id().toString(),
		relayMode: options.relayMode,
		secret: includePairingSecret ? options.pairingSecret : undefined,
		workspace: options.workspace.name,
	};
}

function printTicket(ticket, label) {
	if (process.stderr.isTTY) {
		try {
			console.error(`${label} QR:`);
			console.error(formatIrohRemoteTicketQrCode(ticket));
		} catch (error) {
			console.error(`Could not render ${label} QR: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.error(`${label}:`);
	console.log(ticket);
}

function getRelayMode(flags) {
	const relayMode = getFlag(flags, "relay", "default");
	if (relayMode !== "disabled" && relayMode !== "default") {
		throw new Error("--relay must be disabled or default");
	}
	return relayMode;
}

function getStartupTicketMode(flags) {
	if (hasFlag(flags, "no-pairing")) {
		return "paired-client";
	}
	if (hasFlag(flags, "mobile")) {
		return "none";
	}
	return "pairing";
}

function parseRemoteSessionListCursorTtlMs(value) {
	if (value === undefined || value === "") {
		return REMOTE_SESSION_LIST_CURSOR_TTL_MS;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${REMOTE_SESSION_LIST_CURSOR_TTL_ENV} must be a positive integer when set`);
	}
	return parsed;
}

async function serve(flags) {
	ensureIrohAvailable();
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger, auditPath } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const state = await stateManager.load();
	const allowToolsFlag = getFlag(flags, "allow-tools");
	const workspace = selectServeWorkspace(state, getFlag(flags, "workspace"), allowToolsFlag, process.cwd());
	const allowTools = allowToolsFlag ?? workspace.allowedTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS;

	const relayMode = getRelayMode(flags);
	const startupTicketMode = getStartupTicketMode(flags);
	const startupPairingEnabled = startupTicketMode === "pairing";
	const sourceVolt = getFlag(flags, "source-volt");
	const trustState = getRemoteWorkspaceTrustState(flags, workspace);
	const confirmation = await confirmRemoteWorkspaceAccess({
		allowTools,
		auditLogger,
		context: startupPairingEnabled ? "host_startup_pairing" : "host_startup",
		hasTrustResources: trustState.hasTrustResources,
		projectTrusted: trustState.projectTrusted,
		promptForTrust: true,
		trustStore: trustState.trustStore,
		workspace,
		yes: hasFlag(flags, "yes"),
	});
	const pushRelayUrl = getFlag(flags, "push-relay-url", process.env.VOLT_PUSH_RELAY_URL);
	const effectivePushRelayUrl = pushRelayUrl ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_URL;
	const pushRelayAuthToken = getFlag(flags, "push-relay-auth-token", process.env.VOLT_PUSH_RELAY_AUTH_TOKEN);
	const approvedWorkspacePaths = new Set();
	const options = {
		activeStreams: new IrohRemoteActiveStreamRegistry(),
		agentDir: getFlag(flags, "agent-dir"),
		allowTools,
		auditLogger,
		clientConnections: new Map(),
		detachedRuntimeTtlMs: parseIntegratedDetachedRuntimeTtlMs(getFlag(flags, "detached-runtime-ttl-ms")),
		getProjectTrustedForWorkspace: (candidateWorkspace) =>
			resolveIrohRemoteWorkspaceProjectTrusted(candidateWorkspace, {
				approvedWorkspacePaths,
				trustStore: trustState.trustStore,
			}),
		hostEngine: undefined,
		integratedVolt: hasFlag(flags, "integrated-volt"),
		integratedRuntimes: new Map(),
		profile: getFlag(flags, "profile"),
		pushNotificationDeduper: new IrohRemoteInMemoryPushNotificationDeduper(),
		pushRelayClient: new IrohRemotePushRelayHttpClient({ authToken: pushRelayAuthToken, baseUrl: pushRelayUrl }),
		pushRelayAuthToken,
		pushRelayUrl: effectivePushRelayUrl,
		relayMode,
		sessionListCursorTtlMs: parseRemoteSessionListCursorTtlMs(process.env[REMOTE_SESSION_LIST_CURSOR_TTL_ENV]),
		sessionListCursors: new Map(),
		hostNodeId: undefined,
		ticketExpiresAt: undefined,
		once: hasFlag(flags, "once"),
		sourceVolt: sourceVolt ? resolve(sourceVolt) : undefined,
		stateManager,
		statePath,
		useVolt: Boolean(sourceVolt) || hasFlag(flags, "use-volt"),
		voltBin: getFlag(flags, "volt-bin", "volt"),
		workspace,
	};
	await preflightRpcChild(options, workspace);
	Object.assign(workspace, await stateManager.upsertWorkspace(workspace, allowTools));
	if (hasFlag(flags, "approve") && confirmation.projectTrusted) {
		approvedWorkspacePaths.add(workspace.path);
	}

	const endpoint = await bindEndpoint(relayMode, state, statePath);
	options.hostNodeId = endpoint.id().toString();
	const hostEngine = new IrohRemoteHostEngine({
		allowTools,
		auditLogger,
		classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
		hostNodeId: options.hostNodeId,
		stateManager,
		validateWorkspace: isWorkspaceDirectoryAvailable,
		workspace,
	});
	options.hostEngine = hostEngine;
	const endpointTicket = EndpointTicket.fromAddr(endpoint.addr()).toString();
	let controlServer;
	try {
		controlServer = await startPairControlServer(endpoint, options);
	} catch (error) {
		await endpoint.close().catch(() => {});
		throw error;
	}
	const connectionTasks = new Set();
	let shutdownRequested = false;
	let shutdownSignal;
	const removeControlPathExitCleanup = installControlPathExitCleanup(controlServer.controlPath);
	const removeShutdownSignalHandlers = installShutdownSignalHandlers((signal) => {
		if (shutdownRequested) return;
		shutdownRequested = true;
		shutdownSignal = signal;
		process.exitCode = signal === "SIGINT" ? 130 : 143;
		void endpoint.close().catch(() => {});
	});
	try {
		let ticket;
		let ticketLabel;
		if (startupTicketMode === "pairing") {
			options.ticketExpiresAt = Date.now() + DEFAULT_IROH_REMOTE_PAIRING_TICKET_TTL_MS;
			ticket = (
				await hostEngine.pair({
					expiresAt: options.ticketExpiresAt,
					irohTicket: endpointTicket,
					nodeId: endpoint.id().toString(),
					relayMode,
				})
			).ticket;
			ticketLabel = "pairing ticket";
		} else if (startupTicketMode === "paired-client") {
			ticket = encodeIrohRemoteTicketPayload(createTicketPayload(endpoint, options, false));
			ticketLabel = "paired-client ticket";
		}

		console.error(`host id: ${endpoint.id().toString()}`);
		console.error(`state: ${statePath}`);
		console.error(`audit: ${auditPath}`);
		console.error(`control: ${controlServer.controlPath}`);
		console.error(`workspace: ${workspace.name} -> ${workspace.path}`);
		console.error(
			`push relay: ${effectivePushRelayUrl}${pushRelayUrl ? "" : " (managed default)"}${pushRelayAuthToken ? " with bearer auth" : ""}`,
		);
		console.error(
			`child: ${options.integratedVolt ? "in-process volt remote host" : options.sourceVolt ? `${process.execPath} ${options.resolvedSourceVoltRunner} --mode rpc` : options.useVolt ? `${options.resolvedVoltBin ?? getPlatformVoltBin(options.voltBin)} --mode rpc` : "fake-rpc"}`,
		);
		console.error(`pairing: ${startupPairingEnabled ? "enabled" : "disabled"}`);
		if (ticket !== undefined && ticketLabel !== undefined) {
			printTicket(ticket, ticketLabel);
		} else {
			console.error("startup ticket: disabled; run `volt remote pair` to create a pairing ticket.");
		}

		while (true) {
			let incoming;
			try {
				incoming = await endpoint.acceptNext();
			} catch (error) {
				if (shutdownRequested) break;
				throw error;
			}
			if (!incoming) break;
			const task = handleConnection(incoming, options).catch((error) => {
				if (!isExpectedApplicationClose(error)) {
					console.error(error instanceof Error ? error.stack : String(error));
				}
			}).finally(() => {
				connectionTasks.delete(task);
			});
			connectionTasks.add(task);
			if (options.once) {
				await task;
				break;
			}
		}
	} finally {
		removeShutdownSignalHandlers();
		await closePairControlServer(controlServer);
		removeControlPathExitCleanup();
		try {
			await endpoint.close();
		} finally {
			await Promise.allSettled(connectionTasks);
			await stopIntegratedRuntimes(options, shutdownSignal ? "host_signal_shutdown" : "host_shutdown");
		}
	}
}

async function listClients(flags) {
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	console.log(JSON.stringify(await stateManager.listClients(), null, 2));
}

async function revokeClient(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to revoke");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const result = await stateManager.revokeClient(nodeId);
	await logAudit(auditLogger, {
		type: "client_revoked",
		clientNodeId: nodeId,
		success: result.revoked,
		error: result.revoked ? undefined : "client not found",
	});
	if (!result.revoked) {
		console.error(`No client found for ${nodeId}`);
		return;
	}
	try {
		const activeRevocation = await requestIrohRemoteActiveRevocation({
			statePath,
			request: {
				type: IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
				nodeId,
			},
		});
		if (activeRevocation.success && activeRevocation.closed) {
			console.error(`Active connection revoked for ${nodeId}`);
		} else if (activeRevocation.success) {
			console.error(`No active live connection found for ${nodeId}`);
		} else {
			console.error(`Active live revocation unavailable for ${nodeId}: ${activeRevocation.error}`);
		}
	} catch (error) {
		console.error(
			`Active live revocation unavailable for ${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	console.error(`Revoked ${nodeId}`);
}

async function approveClientRePair(flags, nodeId) {
	if (!nodeId) throw new Error("Missing node id to approve for re-pair");
	const statePath = resolve(getFlag(flags, "state", DEFAULT_STATE_PATH));
	const { auditLogger } = createAuditLogger(flags, statePath);
	const stateManager = new IrohRemoteHostStateManager({ statePath });
	const result = await stateManager.approveClientRePair(nodeId);
	await logAudit(auditLogger, {
		type: "client_repair_approved",
		clientNodeId: nodeId,
		success: result.approved,
		error: result.approved ? undefined : "revoked client not found",
	});
	if (!result.approved) {
		console.error(`No revoked client found for ${nodeId}`);
		return;
	}
	console.error(`Approved re-pair for ${nodeId}`);
}

async function main() {
	const { flags, positionals } = parseFlags(process.argv.slice(2));
	if (hasFlag(flags, "help")) {
		printUsage();
		return;
	}

	if (hasFlag(flags, "register-workspace")) {
		await registerWorkspace(flags, positionals);
		return;
	}

	if (flags.has("unregister-workspace")) {
		await unregisterWorkspace(flags, positionals);
		return;
	}

	const command = positionals[0] ?? "serve";
	if (command === "serve") {
		await serve(flags);
		return;
	}
	if (command === "clients") {
		await listClients(flags);
		return;
	}
	if (command === "revoke") {
		await revokeClient(flags, positionals[1]);
		return;
	}
	if (command === "approve-repair") {
		await approveClientRePair(flags, positionals[1]);
		return;
	}

	throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
