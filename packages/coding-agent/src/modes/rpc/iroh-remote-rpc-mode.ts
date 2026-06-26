import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { REVIEW_BRANCH_ACTION_ID, REVIEW_UNCOMMITTED_ACTION_ID } from "../../core/host-actions.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteLiveActivityContentState,
	type IrohRemoteLiveActivityToolGlyph,
	type IrohRemoteLiveActivityUpdateIntent,
	type IrohRemoteOutboundValueDecorator,
	type IrohRemotePushNotificationDelivery,
	sanitizeIrohRemoteOutbound,
} from "../../core/remote/iroh/index.ts";
import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
} from "../../core/rpc/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";
import type { RpcRegisterPushTargetResponse } from "./rpc-types.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {
	decorateOutbound?: IrohRemoteOutboundValueDecorator;
	disposeRuntimeOnClose?: boolean;
	notificationDelivery?: IrohRemotePushNotificationDelivery;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	registerPushTarget?: (args: unknown) => Promise<RpcRegisterPushTargetResponse>;
	remoteCommandHandler?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	remoteWorkspacePath?: string;
	workspaceName?: string;
	workspacePath: string;
}

export type IrohRemoteNotificationKind =
	| "conversation_completed"
	| "review_completed"
	| "action_completed"
	| "host_notice";

export interface IrohRemoteNotificationRequest {
	type: "notification_request";
	eventId: string;
	kind: IrohRemoteNotificationKind;
	title: string;
	body: string;
	sessionId?: string;
	workspace?: string;
}

export interface IrohRemoteCompletionState {
	sessionId: string;
	runId?: string;
}

export interface IrohRemoteCompletedCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	finalState: IrohRemoteCompletionState | undefined;
	response?: Record<string, unknown>;
}

interface PendingIrohRemoteCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	done: Promise<void>;
	responseMatched: boolean;
	finish(): void;
}

interface IrohRemoteCloseDeferringRpcTransportOptions {
	transport: RpcTransport;
	getCompletionState?: () => IrohRemoteCompletionState;
	onCommandCompleted?: (completion: IrohRemoteCompletedCommand) => void | Promise<void>;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
}

interface IrohRemoteHostCommandRpcTransportOptions {
	handleCommand: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	transport: RpcTransport;
}

const IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS = 12_000;

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	const sentNotificationEventIds = new Set<string>();
	let detachLiveActivityUpdates: (() => void) | undefined;
	const attachLiveActivityUpdates = () => {
		detachLiveActivityUpdates?.();
		detachLiveActivityUpdates = attachIrohRemoteLiveActivityUpdates(
			runtimeHost,
			options.notificationDelivery,
			options.workspaceName,
		);
	};
	const outboundTransport = createIrohRemoteOutboundFilteredRpcTransport({
		decorate: options.decorateOutbound,
		remoteWorkspacePath: options.remoteWorkspacePath,
		transport: createIrohRpcTransport(options),
		workspacePath: options.workspacePath,
	});
	const detachTranscriptEntryEvents = attachIrohRemoteTranscriptEntryEvents(runtimeHost, outboundTransport, {
		remoteWorkspacePath: options.remoteWorkspacePath,
		workspacePath: options.workspacePath,
	});
	const deliverCompletionNotification = async (notification: IrohRemoteNotificationRequest): Promise<void> => {
		if (options.notificationDelivery) {
			const deliveryStatus = await options.notificationDelivery.deliverNotification(notification);
			if (deliveryStatus !== "no_push_target") {
				return;
			}
		}
		await outboundTransport.write(notification);
	};
	const closeDeferringTransport = createIrohRemoteCloseDeferringRpcTransport({
		transport: outboundTransport,
		getCompletionState: () => getIrohRemoteCompletionState(runtimeHost),
		onCommandCompleted: async (completion) => {
			const notification = createIrohRemoteCompletionNotification(completion, options.workspaceName);
			if (!notification || sentNotificationEventIds.has(notification.eventId)) {
				return;
			}
			sentNotificationEventIds.add(notification.eventId);
			await deliverCompletionNotification(notification);
		},
		onResponseWritten: options.onResponseWritten,
		waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
	});

	const filteredTransport = createIrohRemoteFilteredRpcTransport({
		transport: closeDeferringTransport,
	});
	const remoteHostCommandTransport = options.remoteCommandHandler
		? createIrohRemoteHostCommandRpcTransport({
				handleCommand: options.remoteCommandHandler,
				transport: filteredTransport,
			})
		: filteredTransport;

	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: true,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onSessionChanged: async (session) => {
			attachLiveActivityUpdates();
			await options.onSessionChanged?.(session);
		},
		requireRemoteSafeUiActions: true,
		transport: remoteHostCommandTransport,
		exitProcess: false,
		registerPushTarget: options.registerPushTarget,
	}).finally(() => {
		detachTranscriptEntryEvents();
		detachLiveActivityUpdates?.();
	});
}

interface IrohRemoteTranscriptEventOptions {
	remoteWorkspacePath?: string;
	workspacePath: string;
}

function attachIrohRemoteTranscriptEntryEvents(
	runtimeHost: AgentSessionRuntime,
	transport: RpcTransport,
	options: IrohRemoteTranscriptEventOptions,
): () => void {
	const emittedFinalEntryIds = new Set<string>();
	return runtimeHost.session.subscribe((event) => {
		if (event.type !== "message_end") {
			return;
		}
		const message = event.message;
		queueMicrotask(() => {
			const entry = findPersistedMessageEntry(runtimeHost, message);
			if (!entry || emittedFinalEntryIds.has(entry.id)) {
				return;
			}
			const transcriptEvent = createIrohRemoteTranscriptEntryEvent(entry, options);
			if (!transcriptEvent) {
				return;
			}
			emittedFinalEntryIds.add(entry.id);
			void Promise.resolve(transport.write(transcriptEvent)).catch(() => {});
		});
	});
}

function findPersistedMessageEntry(
	runtimeHost: AgentSessionRuntime,
	message: unknown,
): Extract<SessionEntry, { type: "message" }> | undefined {
	const branch = runtimeHost.session.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message === message) {
			return entry;
		}
	}
	return undefined;
}

function createIrohRemoteTranscriptEntryEvent(
	entry: Extract<SessionEntry, { type: "message" }>,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> | undefined {
	const message = entry.message;
	if (message.role === "user" || message.role === "assistant") {
		const text = extractIrohRemoteTranscriptContentText(message.content);
		if (!text) {
			return undefined;
		}
		return createIrohRemoteTranscriptEntryEventValue(entry, message.role, text, options);
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "failed" : "completed";
		const toolName =
			typeof message.toolName === "string" && message.toolName.trim() ? message.toolName.trim() : "tool";
		return createIrohRemoteTranscriptEntryEventValue(entry, "tool", `${toolName} ${status}`, options);
	}
	if (message.role === "bashExecution") {
		const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
		const status = failed ? "failed" : "completed";
		const exit = message.cancelled
			? "cancelled"
			: message.exitCode === undefined
				? status
				: `exit ${message.exitCode}`;
		return createIrohRemoteTranscriptEntryEventValue(entry, "tool", `bash ${exit}`, options);
	}
	return undefined;
}

function createIrohRemoteTranscriptEntryEventValue(
	entry: SessionEntry,
	role: "user" | "assistant" | "system" | "tool",
	text: string,
	options: IrohRemoteTranscriptEventOptions,
): Record<string, unknown> {
	const sanitized = sanitizeIrohRemoteTranscriptText(text, options);
	return {
		type: "transcript_entry",
		entry: {
			entryId: entry.id,
			createdAt: normalizeIrohRemoteTranscriptTimestamp(entry.timestamp),
			role,
			text: sanitized.text,
			truncated: sanitized.truncated,
		},
		final: true,
	};
}

function extractIrohRemoteTranscriptContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function sanitizeIrohRemoteTranscriptText(
	value: string,
	options: IrohRemoteTranscriptEventOptions,
): { text: string; truncated: boolean } {
	const normalized = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/[\n\t]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const sanitizedValue = sanitizeIrohRemoteOutbound(
		{ value: normalized },
		{
			remoteWorkspacePath: options.remoteWorkspacePath,
			workspacePath: options.workspacePath,
		},
	) as { value?: unknown };
	const sanitized = sanitizedValue.value;
	const text = (typeof sanitized === "string" ? sanitized : "").replace(/\s+/gu, " ").trim();
	const scalars = Array.from(text);
	if (scalars.length <= IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS) {
		return { text, truncated: false };
	}
	return {
		text: scalars.slice(0, IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS).join(""),
		truncated: true,
	};
}

function normalizeIrohRemoteTranscriptTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function attachIrohRemoteLiveActivityUpdates(
	runtimeHost: AgentSessionRuntime,
	delivery: IrohRemotePushNotificationDelivery | undefined,
	workspaceName: string | undefined,
): () => void {
	if (!delivery?.deliverLiveActivityUpdate) {
		return () => {};
	}
	const updater = new IrohRemoteLiveActivityUpdater(runtimeHost, delivery, workspaceName);
	return runtimeHost.session.subscribe((event) => {
		void updater.handle(event).catch(() => {});
	});
}

class IrohRemoteLiveActivityUpdater {
	private readonly delivery: Required<Pick<IrohRemotePushNotificationDelivery, "deliverLiveActivityUpdate">>;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly workspaceName: string | undefined;
	private readonly toolIndexesByCallId = new Map<string, number>();
	private deliveryQueue: Promise<void> = Promise.resolve();
	private recentTools: IrohRemoteLiveActivityToolGlyph[] = [];
	private sequence = 0;
	private active = false;

	constructor(
		runtimeHost: AgentSessionRuntime,
		delivery: IrohRemotePushNotificationDelivery,
		workspaceName: string | undefined,
	) {
		if (!delivery.deliverLiveActivityUpdate) {
			throw new Error("live activity delivery is unavailable");
		}
		this.runtimeHost = runtimeHost;
		this.delivery = { deliverLiveActivityUpdate: delivery.deliverLiveActivityUpdate.bind(delivery) };
		this.workspaceName = workspaceName;
	}

	async handle(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.active = true;
				this.recentTools = [];
				this.toolIndexesByCallId.clear();
				await this.sendUpdate("running");
				break;
			case "tool_execution_start":
				this.active = true;
				if (this.recordTool(event.toolCallId, createLiveActivityToolGlyph(event.toolName, "started"))) {
					await this.sendUpdate("running");
				}
				break;
			case "tool_execution_end":
				this.active = true;
				if (
					this.recordTool(
						event.toolCallId,
						createLiveActivityToolGlyph(event.toolName, event.isError ? "failed" : "completed"),
					)
				) {
					await this.sendUpdate("running");
				}
				break;
			case "agent_end":
				if (!this.active || event.willRetry) {
					return;
				}
				await this.sendUpdate("completed");
				this.active = false;
				this.toolIndexesByCallId.clear();
				break;
			default:
				break;
		}
	}

	private recordTool(toolCallId: string | undefined, tool: IrohRemoteLiveActivityToolGlyph): boolean {
		const normalizedCallId = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
		if (normalizedCallId) {
			const existingIndex = this.toolIndexesByCallId.get(normalizedCallId);
			if (existingIndex !== undefined && existingIndex < this.recentTools.length) {
				this.recentTools[existingIndex] = tool;
				return true;
			}
		}
		if (this.recentTools.at(-1)?.name === tool.name) {
			return false;
		}
		this.recentTools.push(tool);
		while (this.recentTools.length > 6) {
			this.recentTools.shift();
			for (const [callId, index] of this.toolIndexesByCallId) {
				if (index === 0) {
					this.toolIndexesByCallId.delete(callId);
				} else {
					this.toolIndexesByCallId.set(callId, index - 1);
				}
			}
		}
		if (normalizedCallId) {
			this.toolIndexesByCallId.set(normalizedCallId, this.recentTools.length - 1);
		}
		return true;
	}

	private async sendUpdate(
		status: IrohRemoteLiveActivityContentState["status"],
		activityEvent: "update" | "end" = "update",
	): Promise<void> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const currentTool = this.recentTools.at(-1);
		const completionState = getIrohRemoteCompletionState(this.runtimeHost);
		const contentState: IrohRemoteLiveActivityContentState = {
			status,
			statusText: liveActivityStatusText(status, currentTool),
			...(currentTool === undefined ? {} : { currentTool }),
			recentTools: this.recentTools.slice(-6),
			sessionID: completionState.sessionId,
			...(this.workspaceName === undefined ? {} : { workspaceName: this.workspaceName }),
			updatedAtEpochSeconds: nowSeconds,
		};
		const update: IrohRemoteLiveActivityUpdateIntent = {
			eventId: `live-activity:${completionState.sessionId}:${completionState.runId ?? "active"}:${++this.sequence}`,
			kind: activityEvent === "end" ? "live_activity_end" : "live_activity_update",
			activityEvent,
			contentState,
			...(activityEvent === "end"
				? { dismissalDateEpochSeconds: nowSeconds + 45 }
				: { staleDateEpochSeconds: nowSeconds + 90 }),
		};
		const delivery = this.deliveryQueue.then(() => this.delivery.deliverLiveActivityUpdate(update));
		this.deliveryQueue = delivery.then(
			() => {},
			() => {},
		);
		await delivery;
	}
}

function createLiveActivityToolGlyph(
	toolName: string | undefined,
	status: IrohRemoteLiveActivityToolGlyph["status"],
): IrohRemoteLiveActivityToolGlyph {
	const name = sanitizeLiveActivityToolName(toolName);
	return {
		name,
		symbolName: liveActivitySymbolNameForTool(name),
		status,
	};
}

function sanitizeLiveActivityToolName(toolName: string | undefined): string {
	const trimmed = toolName?.trim();
	if (!trimmed) {
		return "tool";
	}
	return trimmed.slice(0, 32);
}

export function createIrohRemoteHostCommandRpcTransport(
	options: IrohRemoteHostCommandRpcTransportOptions,
): RpcTransport {
	let pendingInboundCommand = Promise.resolve();

	const waitForPendingInboundCommand = async (): Promise<void> => {
		await pendingInboundCommand;
	};

	const writeHandlerError = async (line: string, error: unknown): Promise<void> => {
		const target = getIrohRemoteRpcErrorTarget(line);
		await options.transport.write(
			createIrohRemoteRpcErrorResponse(
				target.id,
				target.command,
				error instanceof Error ? error.message : String(error),
			),
		);
	};

	const handleLine = async (line: string, handler: RpcLineHandler): Promise<void> => {
		const command = parseIrohRemoteHostCommandLine(line);
		if (!command) {
			handler(line);
			return;
		}
		let response: object | undefined;
		try {
			response = await options.handleCommand(command);
		} catch (error: unknown) {
			await writeHandlerError(line, error);
			return;
		}
		if (response === undefined) {
			handler(line);
			return;
		}
		await options.transport.write(response);
	};

	return {
		write(value) {
			return options.transport.write(value);
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				pendingInboundCommand = pendingInboundCommand.then(
					() => handleLine(line, handler),
					() => handleLine(line, handler),
				);
				void pendingInboundCommand.catch(() => {});
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			return options.transport.onClose?.(handler) ?? (() => {});
		},
		async waitForBackpressure() {
			await waitForPendingInboundCommand();
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await waitForPendingInboundCommand();
			await options.transport.flush?.();
		},
		async close() {
			await waitForPendingInboundCommand();
			await options.transport.close();
		},
	};
}

function parseIrohRemoteHostCommandLine(line: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		return undefined;
	}
	return parsed;
}

function getIrohRemoteRpcErrorTarget(line: string): { id: string | undefined; command: string } {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) {
			return { id: undefined, command: "unknown" };
		}
		return {
			id: typeof parsed.id === "string" ? parsed.id : undefined,
			command: typeof parsed.type === "string" ? parsed.type : "unknown",
		};
	} catch {
		return { id: undefined, command: "parse" };
	}
}

function liveActivityStatusText(
	status: IrohRemoteLiveActivityContentState["status"],
	currentTool: IrohRemoteLiveActivityToolGlyph | undefined,
): string {
	if (status === "completed") {
		return "Volt finished";
	}
	if (status === "failed") {
		return "Volt needs attention";
	}
	if (status === "waiting") {
		return "Waiting for input";
	}
	return currentTool ? `Using ${currentTool.name}` : "Volt is thinking";
}

function liveActivitySymbolNameForTool(toolName: string): string {
	switch (toolName.toLowerCase()) {
		case "read":
			return "doc.text.magnifyingglass";
		case "write":
			return "square.and.pencil";
		case "edit":
			return "pencil.and.outline";
		case "bash":
		case "shell":
		case "terminal":
			return "terminal";
		case "find":
		case "grep":
		case "search":
		case "rg":
			return "magnifyingglass";
		case "lsp":
			return "point.3.connected.trianglepath.dotted";
		case "build":
		case "build_sim":
		case "build_run_sim":
			return "hammer";
		case "test":
		case "test_sim":
			return "checkmark.seal";
		case "screenshot":
		case "snapshot_ui":
			return "camera.viewfinder";
		case "tap":
		case "touch":
		case "gesture":
		case "swipe":
		case "drag":
			return "hand.tap";
		default:
			return "sparkles";
	}
}

export function createIrohRemoteCloseDeferringRpcTransport(
	options: IrohRemoteCloseDeferringRpcTransportOptions,
): RpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();
	let rpcModeStartupComplete = true;
	let startupCompletedPendingCommand = false;
	let startupCleanClosePending = false;
	const startupCleanCloseHandlers = new Set<() => void>();

	const createPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand => {
		let finished = false;
		let resolveDone = () => {};
		const pending: PendingIrohRemoteCommand = {
			command,
			id,
			initialState: options.getCompletionState?.(),
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
			responseMatched: false,
			finish() {
				if (finished) {
					return;
				}
				finished = true;
				pendingCommands.delete(pending);
				if (!rpcModeStartupComplete) {
					startupCompletedPendingCommand = true;
				}
				resolveDone();
			},
		};
		pendingCommands.add(pending);
		return pending;
	};

	const waitForPendingCommands = async (): Promise<void> => {
		while (pendingCommands.size > 0) {
			await Promise.allSettled([...pendingCommands].map((pending) => pending.done));
		}
	};

	const findPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand | undefined => {
		for (const pending of pendingCommands) {
			if (!pending.responseMatched && pending.command === command && pending.id === id) {
				return pending;
			}
		}
		return undefined;
	};

	const trackInboundLine = (line: string): PendingIrohRemoteCommand | undefined => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return createPendingCommand("parse", undefined);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return createPendingCommand("unknown", undefined);
		}
		const command = parsed as Record<string, unknown>;
		if (typeof command.type !== "string") {
			return createPendingCommand("unknown", typeof command.id === "string" ? command.id : undefined);
		}
		if (command.type === "extension_ui_response" || command.type === "host_action_response") {
			return undefined;
		}
		return createPendingCommand(command.type, typeof command.id === "string" ? command.id : undefined);
	};

	const notifyCompletedCommand = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		await options.onCommandCompleted?.({
			command: pending.command,
			id: pending.id,
			initialState: pending.initialState,
			finalState: options.getCompletionState?.(),
			response,
		});
	};

	const finishAfterCommandCompletion = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		try {
			await notifyCompletedCommand(pending, response);
		} finally {
			pending.finish();
		}
	};

	const finishAfterPromptCompletion = async (pending: PendingIrohRemoteCommand): Promise<void> => {
		try {
			// Prompt success is emitted just before AgentSession starts the run.
			// Steer/follow_up success means input was accepted into an active session run.
			// Yield once so waitForIdle observes that run or any accepted queued input.
			await Promise.resolve();
			await options.waitForPromptCompletion();
			await notifyCompletedCommand(pending);
		} finally {
			pending.finish();
		}
	};

	const trackOutboundResponse = (value: object): void => {
		const response = value as Record<string, unknown>;
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		const pending = findPendingCommand(response.command, typeof response.id === "string" ? response.id : undefined);
		if (!pending) {
			return;
		}
		pending.responseMatched = true;
		if (response.success === true && shouldWaitForRemoteResponseCompletion(pending.command, response)) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
		}
		if (response.success === true && isCompletedReviewInvocationResponse(pending.command, response)) {
			void finishAfterCommandCompletion(pending, response).catch(() => {});
			return;
		}
		pending.finish();
	};

	const finishPendingResponseAfterWriteFailure = (value: object): void => {
		const response = value as Record<string, unknown>;
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		const pending = findPendingCommand(response.command, typeof response.id === "string" ? response.id : undefined);
		if (pending) {
			pending.responseMatched = true;
			pending.finish();
		}
	};

	const notifyResponseWritten = async (value: object, writeResult: void | Promise<void>): Promise<void> => {
		await writeResult;
		const response = value as Record<string, unknown>;
		if (response.type !== "response") {
			return;
		}
		await options.onResponseWritten?.(response);
	};

	const transport: IrohRemoteCloseDeferringRpcTransport = {
		setRpcModeStartupComplete(startupComplete) {
			rpcModeStartupComplete = startupComplete;
			if (!rpcModeStartupComplete || !startupCleanClosePending) {
				if (rpcModeStartupComplete) {
					startupCompletedPendingCommand = false;
				}
				return;
			}
			startupCleanClosePending = false;
			startupCompletedPendingCommand = false;
			for (const handler of startupCleanCloseHandlers) {
				handler();
			}
		},
		write(value) {
			let result: void | Promise<void>;
			try {
				result = options.transport.write(value);
			} catch (error: unknown) {
				finishPendingResponseAfterWriteFailure(value);
				throw error;
			}
			trackOutboundResponse(value);
			if (options.onResponseWritten && (value as Record<string, unknown>).type === "response") {
				return notifyResponseWritten(value, result);
			}
			return result;
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				const pending = trackInboundLine(line);
				try {
					handler(line);
				} catch (error: unknown) {
					pending?.finish();
					throw error;
				}
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			let active = true;
			const handleCleanClose = () => {
				void waitForPendingCommands().then(() => {
					if (active) {
						handler();
					}
				});
			};
			startupCleanCloseHandlers.add(handleCleanClose);
			const detach =
				options.transport.onClose?.((error) => {
					if (!active) {
						return;
					}
					if (error) {
						handler(error);
						return;
					}
					if (!rpcModeStartupComplete && (pendingCommands.size > 0 || startupCompletedPendingCommand)) {
						startupCleanClosePending = true;
						return;
					}
					handleCleanClose();
				}) ?? (() => {});
			return () => {
				active = false;
				startupCleanCloseHandlers.delete(handleCleanClose);
				detach();
			};
		},
		async waitForBackpressure() {
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await options.transport.flush?.();
		},
		close() {
			return options.transport.close();
		},
	};
	return transport;
}

function getIrohRemoteCompletionState(runtimeHost: AgentSessionRuntime): IrohRemoteCompletionState {
	return {
		sessionId: runtimeHost.session.sessionId,
		runId: runtimeHost.session.sessionManager.getLeafId() ?? undefined,
	};
}

function createIrohRemoteCompletionNotification(
	completion: IrohRemoteCompletedCommand,
	workspaceName: string | undefined,
): IrohRemoteNotificationRequest | undefined {
	const finalState = getChangedFinalCompletionState(completion);
	if (!finalState) {
		return undefined;
	}
	const workspace = getSafeNotificationWorkspace(workspaceName);
	const workspaceDetails = workspace === undefined ? {} : { workspace };
	if (isConversationCompletionCommand(completion.command)) {
		return {
			type: "notification_request",
			eventId: `conversation:${finalState.sessionId}:${finalState.runId}:completed`,
			kind: "conversation_completed",
			title: workspace === undefined ? "Volt finished" : `Volt finished in ${workspace}`,
			body: "Your conversation is ready.",
			sessionId: finalState.sessionId,
			...workspaceDetails,
		};
	}
	if (isCompletedReviewInvocationResponse(completion.command, completion.response)) {
		return {
			type: "notification_request",
			eventId: `review:${finalState.sessionId}:${finalState.runId}:completed`,
			kind: "review_completed",
			title: workspace === undefined ? "Review complete" : `Review complete in ${workspace}`,
			body: "Open Volt to see the findings.",
			sessionId: finalState.sessionId,
			...workspaceDetails,
		};
	}
	return undefined;
}

function getSafeNotificationWorkspace(workspaceName: string | undefined): string | undefined {
	if (workspaceName === undefined) {
		return undefined;
	}
	const trimmed = workspaceName.trim();
	if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
		return undefined;
	}
	return trimmed;
}

function getChangedFinalCompletionState(
	completion: IrohRemoteCompletedCommand,
): Required<IrohRemoteCompletionState> | undefined {
	const finalState = completion.finalState;
	if (!finalState?.runId) {
		return undefined;
	}
	const initialState = completion.initialState;
	if (initialState?.sessionId === finalState.sessionId && initialState.runId === finalState.runId) {
		return undefined;
	}
	return { sessionId: finalState.sessionId, runId: finalState.runId };
}

function isConversationCompletionCommand(command: string): boolean {
	return command === "prompt" || command === "steer" || command === "follow_up";
}

function shouldWaitForRemoteResponseCompletion(command: string, response: Record<string, unknown>): boolean {
	if (isConversationCompletionCommand(command)) {
		return true;
	}
	if (command !== "invoke_ui_action") {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "accepted" || data.status === "queued";
}

function isCompletedReviewInvocationResponse(
	command: string,
	response: Record<string, unknown> | undefined,
): response is Record<string, unknown> & { data: { action: string; status: "completed" } } {
	if (command !== "invoke_ui_action" || !response) {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "completed" && isReviewActionId(data.action);
}

function isReviewActionId(action: unknown): boolean {
	return action === REVIEW_UNCOMMITTED_ACTION_ID || action === REVIEW_BRANCH_ACTION_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
