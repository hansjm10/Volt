import { Buffer } from "node:buffer";
import {
	getIrohRemoteRpcCommandCapabilities,
	getMissingIrohRemoteRpcCapability,
	parseIrohRemoteRpcGrant,
} from "../core/remote/iroh/access-grant.ts";
import {
	handleIrohRemoteAgentLaunchRpcCommand,
	IROH_REMOTE_AGENT_LAUNCH_RPC_TYPES,
	type IrohRemoteAgentLaunchRpcBackend,
} from "../core/remote/iroh/agent-launch.ts";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { isIrohRemoteWorkspaceName } from "../core/remote/iroh/handshake.ts";
import { sanitizeIrohRemoteOutbound } from "../core/remote/iroh/outbound-filter.ts";
import { isIrohRemoteWorkingDirectory } from "../core/remote/iroh/protocol.ts";
import {
	createIrohRemoteRpcCapabilityDeniedResponse,
	createIrohRemoteRpcErrorResponse,
} from "../core/remote/iroh/rpc-command-filter.ts";
import {
	handleIrohRemoteWorktreeRpcCommand,
	IROH_REMOTE_WORKTREE_RPC_TYPES,
	type IrohRemoteWorktreeRpcBackend,
} from "../core/remote/iroh/worktree-rpc.ts";
import {
	type IrohBiStreamLike,
	type IrohBytes,
	type IrohRecvStreamLike,
	readIrohJsonlLine,
} from "../core/rpc/iroh-transport.ts";
import { serializeJsonLine } from "../core/rpc/jsonl.ts";
import {
	type ConversationCommandContext,
	createRemoteListSessionsRpcResponse,
	createRpcSuccessResponse,
	getRpcResponseId,
	type RemoteRpcCommand,
} from "./conversation-commands.ts";
import { listWorkspaceDirectories } from "./workspace-directory.ts";

const DEFAULT_READ_LIMIT = 64 * 1024;
export const DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES = 64 * 1024;

export const WORKSPACE_UNREGISTERED_CLOSE_REASON = "workspace_unregistered";
const LIST_WORKSPACE_DIRECTORIES_RPC_TYPE = "list_workspace_directories";

export async function readLineFromIroh(
	recv: IrohRecvStreamLike,
	initial: Buffer = Buffer.alloc(0),
	options: { maxLineBytes?: number } = {},
): Promise<{ line: string | undefined; rest: Buffer }> {
	return await readIrohJsonlLine(recv, initial, {
		readLimit: DEFAULT_READ_LIMIT,
		maxLineBytes: options.maxLineBytes ?? DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES,
	});
}

export interface RemoteSanitizerOverrides {
	/** Remote root for the sanitizer. Nested-repo worktrees map to /workspace/<source-root>. */
	remoteWorkspacePath?: string;
	/** Sanitizer root override (worktree-bound streams use the worktree path). */
	workspacePath?: string;
	/** Extra roots (parent checkout, worktrees root) redacted to remoteWorkspacePath. */
	additionalRedactedPaths?: string[];
}

export function getRemoteSanitizerOptions(
	authorization: IrohRemoteClientAuthorizationSuccess,
	overrides: RemoteSanitizerOverrides = {},
): {
	remoteWorkspacePath: string;
	workspacePath: string;
	additionalRedactedPaths?: string[];
} {
	return {
		remoteWorkspacePath: overrides.remoteWorkspacePath ?? "/workspace",
		workspacePath: overrides.workspacePath ?? authorization.workspace.path,
		...(overrides.additionalRedactedPaths === undefined
			? {}
			: { additionalRedactedPaths: overrides.additionalRedactedPaths }),
	};
}

export async function writeIrohRemoteJsonLine(
	send: IrohBiStreamLike["send"],
	value: object,
	authorization: IrohRemoteClientAuthorizationSuccess,
	sanitizerOverrides: RemoteSanitizerOverrides = {},
): Promise<void> {
	const sanitized = sanitizeIrohRemoteOutbound(value, getRemoteSanitizerOptions(authorization, sanitizerOverrides));
	await send.writeAll(Array.from(Buffer.from(serializeJsonLine(sanitized), "utf8")));
}

export function parseRemoteRpcCommandLine(
	line: string,
): { ok: true; command: RemoteRpcCommand } | { ok: false; response: object } {
	let parsed: unknown;
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
	const record = parsed as Record<string, unknown>;
	if (typeof record.type !== "string") {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(getRpcResponseId(record), "unknown", "invalid_request"),
		};
	}
	return { ok: true, command: record as RemoteRpcCommand };
}

function getUtilityCapabilityDenial(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
): object | undefined {
	const required = getIrohRemoteRpcCommandCapabilities(command);
	if (required === undefined) return undefined;
	const missing = getMissingIrohRemoteRpcCapability(
		parseIrohRemoteRpcGrant(authorization.client.rpcGrant, "client rpcGrant"),
		required,
	);
	return missing === undefined
		? undefined
		: createIrohRemoteRpcCapabilityDeniedResponse(getRpcResponseId(command), command.type, missing);
}

async function runWorkspaceUtilityRpcLoop(
	stream: IrohBiStreamLike,
	initialInput: IrohBytes,
	handleCommand: (line: string) => Promise<boolean>,
): Promise<void> {
	let buffer: Buffer = Buffer.from(initialInput);
	while (true) {
		const result = await readLineFromIroh(stream.recv, buffer);
		if (result.line === undefined) {
			// Utility streams use the same strict LF-delimited framing as the
			// conversation transport. Never dispatch a trailing partial frame.
			return;
		}

		const shouldClose = await handleCommand(result.line);
		if (shouldClose) {
			return;
		}
		buffer = result.rest;
	}
}

export interface WorkspaceStreamHooks {
	auditLogger: IrohRemoteAuditLogger;
	commandContext: ConversationCommandContext;
	/** Unregister the workspace and tear down its streams/runtimes. Returns close counts. */
	unregisterWorkspace(
		workspaceName: string,
		excludedStreamClose: () => void,
	): Promise<
		| { ok: true; closedStreamCount: number; stoppedRuntimeCount: number }
		| { ok: false; error: string; details?: Record<string, unknown> }
	>;
}

export interface WorkspaceStreamContext {
	stream: IrohBiStreamLike;
	initialInput: IrohBytes;
	authorization: IrohRemoteClientAuthorizationSuccess;
	/** Recheck the persisted grant revision before every utility command. */
	isRpcGrantCurrent(): boolean | Promise<boolean>;
	closeStream(reason?: string): void;
}

/** Serve a workspaceDiscovery stream: list_sessions only. */
export async function runWorkspaceDiscoveryStream(
	context: WorkspaceStreamContext,
	hooks: Pick<WorkspaceStreamHooks, "commandContext">,
): Promise<void> {
	const { stream, authorization } = context;
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		if (!(await context.isRpcGrantCurrent())) {
			context.closeStream("access_updated");
			return true;
		}
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization);
			return false;
		}
		if (parsed.command.type !== "list_sessions") {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_discovery_stream",
				),
				authorization,
			);
			return false;
		}
		const denied = getUtilityCapabilityDenial(parsed.command, authorization);
		if (denied) {
			await writeIrohRemoteJsonLine(stream.send, denied, authorization);
			return false;
		}
		await writeIrohRemoteJsonLine(
			stream.send,
			await createRemoteListSessionsRpcResponse(parsed.command, authorization, hooks.commandContext),
			authorization,
		);
		return false;
	});
}

function parseWorkspaceManagementWorkspaceRequest(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	allowedFields: readonly string[],
): { ok: true; workspaceName: string } | { ok: false; error: string } {
	if (typeof command.workspaceName !== "string" || !isIrohRemoteWorkspaceName(command.workspaceName)) {
		return { ok: false, error: "invalid_workspace_payload" };
	}
	if (command.workspaceName !== authorization.workspace.name) {
		return { ok: false, error: "session_mismatch" };
	}
	const allowed = new Set(allowedFields);
	for (const field of Object.keys(command)) {
		if (!allowed.has(field)) {
			return { ok: false, error: "invalid_request" };
		}
	}
	return { ok: true, workspaceName: command.workspaceName };
}

function parseWorkspaceDirectoryPath(command: RemoteRpcCommand): string | undefined | { error: string } {
	if (command.path === undefined) {
		return undefined;
	}
	if (typeof command.path !== "string" || !isIrohRemoteWorkingDirectory(command.path)) {
		return { error: "invalid_working_directory" };
	}
	return command.path;
}

/** Serve a workspaceManagement stream: workspace management RPCs. */
export async function runWorkspaceManagementStream(
	context: WorkspaceStreamContext,
	hooks: WorkspaceStreamHooks,
): Promise<void> {
	const { stream, authorization } = context;
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		if (!(await context.isRpcGrantCurrent())) {
			context.closeStream("access_updated");
			return true;
		}
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization);
			return false;
		}
		if (
			parsed.command.type !== "unregister_workspace" &&
			parsed.command.type !== LIST_WORKSPACE_DIRECTORIES_RPC_TYPE
		) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_management_stream",
				),
				authorization,
			);
			return false;
		}
		const denied = getUtilityCapabilityDenial(parsed.command, authorization);
		if (denied) {
			await writeIrohRemoteJsonLine(stream.send, denied, authorization);
			return false;
		}
		const id = getRpcResponseId(parsed.command);
		if (parsed.command.type === LIST_WORKSPACE_DIRECTORIES_RPC_TYPE) {
			const request = parseWorkspaceManagementWorkspaceRequest(parsed.command, authorization, [
				"id",
				"type",
				"workspaceName",
				"path",
			]);
			if (!request.ok) {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, request.error),
					authorization,
				);
				return false;
			}
			const path = parseWorkspaceDirectoryPath(parsed.command);
			if (typeof path === "object") {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, path.error),
					authorization,
				);
				return false;
			}
			const listed = await listWorkspaceDirectories(authorization.workspace.path, path);
			if (!listed.ok) {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, listed.error),
					authorization,
				);
				return false;
			}
			await writeIrohRemoteJsonLine(
				stream.send,
				createRpcSuccessResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, {
					workspaceName: request.workspaceName,
					...(listed.currentPath === undefined ? {} : { path: listed.currentPath }),
					directories: listed.directories,
				}),
				authorization,
			);
			return false;
		}
		const request = parseWorkspaceManagementWorkspaceRequest(parsed.command, authorization, [
			"id",
			"type",
			"workspaceName",
		]);
		if (!request.ok) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(id, "unregister_workspace", request.error),
				authorization,
			);
			return false;
		}

		let excludedClosed = false;
		const result = await hooks.unregisterWorkspace(request.workspaceName, () => {
			excludedClosed = true;
		});
		if (!result.ok) {
			await hooks.auditLogger
				.log({
					type: "workspace_unregistered",
					clientNodeId: authorization.client.nodeId,
					workspace: request.workspaceName,
					success: false,
					error: result.error,
					details: { source: "remote_workspace_management_stream", ...(result.details ?? {}) },
				})
				.catch(() => {});
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(id, "unregister_workspace", result.error),
				authorization,
			);
			return false;
		}
		await hooks.auditLogger
			.log({
				type: "workspace_unregistered",
				clientNodeId: authorization.client.nodeId,
				workspace: request.workspaceName,
				success: true,
				details: {
					closedStreamCount: result.closedStreamCount,
					source: "remote_workspace_management_stream",
					stoppedRuntimeCount: result.stoppedRuntimeCount,
				},
			})
			.catch(() => {});
		await writeIrohRemoteJsonLine(
			stream.send,
			createRpcSuccessResponse(id, "unregister_workspace", {
				workspaceName: request.workspaceName,
				unregistered: true,
			}),
			authorization,
		);
		if (!excludedClosed) {
			context.closeStream(WORKSPACE_UNREGISTERED_CLOSE_REASON);
		}
		return true;
	});
}

export interface AgentLaunchStreamHooks {
	auditLogger: IrohRemoteAuditLogger;
	agents: IrohRemoteAgentLaunchRpcBackend;
	additionalRedactedPaths?: string[];
}

/** Serve a manage_agents workspaceManagement stream: launch catalog and cold creation only. */
export async function runAgentLaunchManagementStream(
	context: WorkspaceStreamContext,
	hooks: AgentLaunchStreamHooks,
): Promise<void> {
	const { stream, authorization } = context;
	const sanitizerOverrides = { additionalRedactedPaths: hooks.additionalRedactedPaths };
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		if (!(await context.isRpcGrantCurrent())) {
			context.closeStream("access_updated");
			return true;
		}
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization, sanitizerOverrides);
			return false;
		}
		if (!IROH_REMOTE_AGENT_LAUNCH_RPC_TYPES.has(parsed.command.type)) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_management_stream",
				),
				authorization,
				sanitizerOverrides,
			);
			return false;
		}
		const denied = getUtilityCapabilityDenial(parsed.command, authorization);
		if (denied) {
			await writeIrohRemoteJsonLine(stream.send, denied, authorization, sanitizerOverrides);
			return false;
		}
		const result = await handleIrohRemoteAgentLaunchRpcCommand(parsed.command, {
			authorizedWorkspaceName: authorization.workspace.name,
			backend: hooks.agents,
		});
		if (!result.handled) return false;
		if (parsed.command.type === "create_agent") {
			const data = result.response.success ? result.response.data : undefined;
			const success =
				result.response.success &&
				typeof data === "object" &&
				data !== null &&
				"kind" in data &&
				data.kind !== "error";
			await hooks.auditLogger
				.log({
					type: "agent_launched",
					clientNodeId: authorization.client.nodeId,
					workspace: authorization.workspace.name,
					success,
					...(success ? {} : { error: result.response.success ? "agent_launch_failed" : result.response.error }),
					details: {
						source: "remote_agent_management_stream",
						...(success && "sessionId" in data && typeof data.sessionId === "string"
							? { sessionId: data.sessionId }
							: {}),
					},
				})
				.catch(() => undefined);
		}
		await writeIrohRemoteJsonLine(stream.send, result.response, authorization, sanitizerOverrides);
		return false;
	});
}

export interface WorktreeStreamHooks {
	auditLogger: IrohRemoteAuditLogger;
	worktrees: IrohRemoteWorktreeRpcBackend;
	/** Extra roots redacted on every frame of this stream (worktrees root). */
	additionalRedactedPaths?: string[];
}

/** Serve a manage_worktrees workspaceManagement stream: create/list/remove worktrees only. */
export async function runWorktreeManagementStream(
	context: WorkspaceStreamContext,
	hooks: WorktreeStreamHooks,
): Promise<void> {
	const { stream, authorization } = context;
	const sanitizerOverrides = { additionalRedactedPaths: hooks.additionalRedactedPaths };
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		if (!(await context.isRpcGrantCurrent())) {
			context.closeStream("access_updated");
			return true;
		}
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization, sanitizerOverrides);
			return false;
		}
		if (!IROH_REMOTE_WORKTREE_RPC_TYPES.has(parsed.command.type)) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_management_stream",
				),
				authorization,
				sanitizerOverrides,
			);
			return false;
		}
		const denied = getUtilityCapabilityDenial(parsed.command, authorization);
		if (denied) {
			await writeIrohRemoteJsonLine(stream.send, denied, authorization, sanitizerOverrides);
			return false;
		}
		const result = await handleIrohRemoteWorktreeRpcCommand(parsed.command, {
			authorizedWorkspaceName: authorization.workspace.name,
			backend: hooks.worktrees,
		});
		if (!result.handled) {
			return false;
		}
		if (parsed.command.type !== "list_worktrees") {
			await hooks.auditLogger
				.log({
					type:
						result.audit?.type ??
						(parsed.command.type === "create_worktree" ? "worktree_created" : "worktree_removed"),
					clientNodeId: authorization.client.nodeId,
					workspace: authorization.workspace.name,
					success: result.response.success,
					...(result.response.success ? {} : { error: result.response.error }),
					details: { source: "remote_worktree_management_stream", ...(result.audit?.details ?? {}) },
				})
				.catch(() => {});
		}
		await writeIrohRemoteJsonLine(stream.send, result.response, authorization, sanitizerOverrides);
		return false;
	});
}
