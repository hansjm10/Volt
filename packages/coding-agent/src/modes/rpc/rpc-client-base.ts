import type { AgentMessage, ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { ImageContent } from "@earendil-works/volt-ai";
import type { AgentSessionEvent, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { ExtensionError } from "../../core/extensions/index.ts";
import type { SubagentEvent, SubagentResult } from "../../core/subagents/index.ts";
import type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostActionRequest,
	RpcHostActionResponse,
	RpcHostActionUpdate,
	RpcListSubagentsResponse,
	RpcResponse,
	RpcSessionListItem,
	RpcSessionState,
	RpcSlashCommand,
	RpcSubagentStartResponse,
	RpcTranscriptResponse,
	RpcWorkflowEvent,
	RpcWorkflowToolEvent,
	UiActionCapabilities,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
} from "./rpc-types.ts";

/** Distributive Omit that works with union types. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field for client call sites. */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

interface PendingRpcRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

type InboundRpcMessage = Record<string, unknown> & { type: string };

export interface RpcClientBaseOptions {
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcExtensionErrorEvent = { type: "extension_error" } & ExtensionError;
export type RpcSubagentEvent = { type: "subagent_event"; subagentId: string; event: SubagentEvent };
export type RpcSubagentEndEvent = { type: "subagent_end"; subagentId: string; result: SubagentResult };
export type RpcClientEvent =
	| AgentSessionEvent
	| RpcWorkflowEvent
	| RpcWorkflowToolEvent
	| RpcExtensionUIRequest
	| RpcHostActionRequest
	| RpcHostActionUpdate
	| RpcSubagentEvent
	| RpcSubagentEndEvent
	| RpcExtensionErrorEvent;
export type RpcEventListener = (event: RpcClientEvent) => void;

const MALFORMED_RPC_LINE_PREVIEW_CHARS = 200;

export abstract class RpcClientBase {
	private readonly requestTimeoutMs: number;
	private readonly eventListeners: RpcEventListener[] = [];
	private readonly pendingRequests = new Map<string, PendingRpcRequest>();
	private requestId = 0;
	private failureError: Error | null = null;

	constructor(options: RpcClientBaseOptions = {}) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	}

	/** Subscribe to RPC events and extension UI requests. */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/** Respond to an extension UI request emitted through onEvent(). */
	async sendExtensionUIResponse(response: RpcExtensionUIResponse): Promise<void> {
		await this.sendOneWay(response);
	}

	/** Respond to a host-initiated action request emitted through onEvent(). */
	async sendHostActionResponse(response: RpcHostActionResponse): Promise<void> {
		await this.sendOneWay(response);
	}

	/** Advertise client-supported optional protocol features. */
	async setClientCapabilities(features: RpcClientCapabilityFeature[]): Promise<void> {
		await this.send({ type: "set_client_capabilities", features });
	}

	/** Return host actions currently waiting for client response. */
	async getPendingHostActions(): Promise<RpcHostActionRequest[]> {
		const response = await this.send({ type: "get_pending_host_actions" });
		return this.getData<{ actions: RpcHostActionRequest[] }>(response).actions;
	}

	/** Send a prompt to the agent. */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/** Queue a steering message to interrupt the agent mid-run. */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/** Queue a follow-up message to be processed after the agent finishes. */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/** Abort current operation. */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/** Start a new session, optionally with parent tracking. */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/** Get current session state. */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/** Get a UI-ready projected transcript for the active session. */
	async getTranscript(options: { limit?: number; beforeEntryId?: string } = {}): Promise<RpcTranscriptResponse> {
		const response = await this.send({
			type: "get_transcript",
			limit: options.limit,
			beforeEntryId: options.beforeEntryId,
		});
		return this.getData(response);
	}

	/** Get native UI action protocol capabilities. */
	async getUiCapabilities(): Promise<UiActionCapabilities> {
		const response = await this.send({ type: "get_ui_capabilities" });
		return this.getData(response);
	}

	/** Get native UI action descriptors. */
	async getUiActions(scope?: UiActionListScope): Promise<UiActionDescriptor[]> {
		const response = await this.send({ type: "get_ui_actions", scope });
		return this.getData<{ actions: UiActionDescriptor[] }>(response).actions;
	}

	/** Get native UI action completions for one argument. */
	async getUiActionCompletions(
		action: string,
		argument: string,
		prefix?: string,
	): Promise<UiActionOptionDescriptor[]> {
		const response = await this.send({ type: "get_ui_action_completions", action, argument, prefix });
		return this.getData<{ completions: UiActionOptionDescriptor[] }>(response).completions;
	}

	/** Invoke a native UI action by id. */
	async invokeUiAction(
		action: string,
		options: { args?: Record<string, unknown>; streamingBehavior?: UiActionInvocationQueueBehavior } = {},
	): Promise<UiActionInvocationResponse> {
		const response = await this.send({
			type: "invoke_ui_action",
			action,
			args: options.args,
			streamingBehavior: options.streamingBehavior,
		});
		return this.getData(response);
	}

	/** List discovered subagent definitions available to local RPC clients. */
	async listSubagents(): Promise<RpcListSubagentsResponse> {
		const response = await this.send({ type: "list_subagents" });
		return this.getData(response);
	}

	/** Start a local RPC-managed subagent and send its initial prompt. */
	async startSubagent(agent: string, prompt: string): Promise<RpcSubagentStartResponse> {
		const response = await this.send({ type: "subagent_start", agent, prompt });
		return this.getData(response);
	}

	/** Abort and dispose a local RPC-managed subagent. */
	async abortSubagent(subagentId: string): Promise<void> {
		await this.send({ type: "subagent_abort", subagentId });
	}

	/** Get state for a local RPC-managed subagent. */
	async getSubagentState(subagentId: string): Promise<RpcSessionState> {
		const response = await this.send({ type: "subagent_get_state", subagentId });
		return this.getData(response);
	}

	/** Get a transcript projection for a local RPC-managed subagent. */
	async getSubagentTranscript(
		subagentId: string,
		options: { limit?: number; beforeEntryId?: string } = {},
	): Promise<RpcTranscriptResponse> {
		const response = await this.send({
			type: "subagent_get_transcript",
			subagentId,
			limit: options.limit,
			beforeEntryId: options.beforeEntryId,
		});
		return this.getData(response);
	}

	/** Dispose a local RPC-managed subagent without sending an abort request first. */
	async disposeSubagent(subagentId: string): Promise<void> {
		await this.send({ type: "subagent_dispose", subagentId });
	}

	/** Set model by provider and ID. */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/** Cycle to next model. */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/** Get list of available models. */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/** Set thinking level. */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/** Cycle thinking level. */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/** Set steering mode. */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/** Set follow-up mode. */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/** Compact session context. */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/** Set auto-compaction enabled/disabled. */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/** Set auto-retry enabled/disabled. */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/** Abort in-progress retry. */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/** Execute a bash command. */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/** Abort running bash command. */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/** Get session statistics. */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/** List persisted sessions for the current workspace. */
	async listSessions(): Promise<RpcSessionListItem[]> {
		const response = await this.send({ type: "list_sessions" });
		return this.getData<{ sessions: RpcSessionListItem[] }>(response).sessions;
	}

	/** Export session to HTML. */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/** Switch to a different session file. */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/** Switch to a workspace session by stable session id. */
	async switchSessionById(sessionId: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session_by_id", sessionId });
		return this.getData(response);
	}

	/** Fork from a specific message. */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/** Clone the current active branch into a new session. */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/** Get messages available for forking. */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/** Get text of last assistant message. */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/** Set the session display name. */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/** Get all messages in the session. */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/** Get available commands. */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/** Wait for agent to become idle. */
	waitForIdle(timeout = 60_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(this.formatError("Timeout waiting for agent to become idle")));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/** Collect events until agent becomes idle. */
	collectEvents(timeout = 60_000): Promise<RpcClientEvent[]> {
		return new Promise((resolve, reject) => {
			const events: RpcClientEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(this.formatError("Timeout collecting events")));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/** Send prompt and wait for completion, returning all events. */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60_000): Promise<RpcClientEvent[]> {
		return new Promise((resolve, reject) => {
			const events: RpcClientEvent[] = [];
			let agentEnded = false;
			let promptAccepted = false;
			let settled = false;
			let unsubscribe = (): void => {};

			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				unsubscribe();
				reject(new Error(this.formatError("Timeout collecting events")));
			}, timeout);

			const cleanup = (): void => {
				clearTimeout(timer);
				unsubscribe();
			};

			const rejectAndCleanup = (error: unknown): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(toError(error));
			};

			const resolveIfComplete = (): void => {
				if (settled || !agentEnded || !promptAccepted) {
					return;
				}
				settled = true;
				cleanup();
				resolve(events);
			};

			unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					agentEnded = true;
					resolveIfComplete();
				}
			});

			void this.send({ type: "prompt", message, images }, () => {
				promptAccepted = true;
				resolveIfComplete();
			}).catch(rejectAndCleanup);
		});
	}

	protected handleLine(line: string): void {
		if (this.failureError) {
			return;
		}

		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch (error: unknown) {
			const failureError = new Error(
				this.formatError(
					`Malformed inbound RPC JSON: ${toError(error).message}. Bad line preview: ${formatLinePreview(line)}`,
				),
			);
			this.setFailureError(failureError);
			this.rejectPendingRequests(failureError);
			return;
		}

		if (!isInboundRpcMessage(data)) {
			this.failInboundProtocol("Invalid inbound RPC message: expected object with string type", line);
			return;
		}

		if (data.type === "response") {
			this.handleResponse(data, line);
			return;
		}

		this.emitEvent(data as RpcClientEvent);
	}

	protected assertCanSend(): void {
		if (this.failureError) {
			throw this.failureError;
		}
	}

	protected clearFailureError(): void {
		this.failureError = null;
	}

	protected setFailureError(error: Error): void {
		this.failureError = error;
	}

	protected rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	protected getErrorContext(): string | undefined {
		return undefined;
	}

	protected abstract writeMessage(
		message: RpcCommand | RpcExtensionUIResponse | RpcHostActionResponse,
	): void | Promise<void>;

	private async sendOneWay(message: RpcExtensionUIResponse | RpcHostActionResponse): Promise<void> {
		this.assertCanSend();
		try {
			await this.writeMessage(message);
		} catch (error: unknown) {
			throw toError(error);
		}
	}

	private async send(command: RpcCommandBody, onSuccessResponse?: () => void): Promise<RpcResponse> {
		this.assertCanSend();

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(this.formatError(`Timeout waiting for response to ${command.type}`)));
			}, this.requestTimeoutMs);

			const rejectRequest = (error: Error): void => {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				reject(error);
			};

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					if (!response.success) {
						reject(new Error(response.error));
						return;
					}
					try {
						onSuccessResponse?.();
					} catch (error: unknown) {
						reject(toError(error));
						return;
					}
					resolve(response);
				},
				reject: rejectRequest,
			});

			try {
				const writeResult = this.writeMessage(fullCommand);
				if (writeResult) {
					void Promise.resolve(writeResult).catch((error: unknown) => {
						rejectRequest(toError(error));
					});
				}
			} catch (error: unknown) {
				rejectRequest(toError(error));
			}
		});
	}

	private handleResponse(response: InboundRpcMessage, line: string): void {
		// Responses are reserved protocol messages. Missing, malformed, or
		// unrecognized correlation ids fail the client instead of reaching event
		// listeners as ordinary events.
		if (typeof response.id !== "string") {
			this.failInboundProtocol("Invalid inbound RPC response: expected string id", line);
			return;
		}
		if (typeof response.command !== "string") {
			this.failInboundProtocol("Invalid inbound RPC response: expected string command", line);
			return;
		}
		if (typeof response.success !== "boolean") {
			this.failInboundProtocol("Invalid inbound RPC response: expected boolean success", line);
			return;
		}
		if (response.success === false && typeof response.error !== "string") {
			this.failInboundProtocol("Invalid inbound RPC response: expected string error", line);
			return;
		}

		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			this.failInboundProtocol(`Invalid inbound RPC response: unknown id ${JSON.stringify(response.id)}`, line);
			return;
		}

		this.pendingRequests.delete(response.id);
		pending.resolve(response as RpcResponse);
	}

	private failInboundProtocol(message: string, line: string): void {
		const failureError = new Error(this.formatError(`${message}. Bad line preview: ${formatLinePreview(line)}`));
		this.setFailureError(failureError);
		this.rejectPendingRequests(failureError);
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}

	private emitEvent(event: RpcClientEvent): void {
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	private formatError(message: string): string {
		const context = this.getErrorContext();
		return context ? `${message}. ${context}` : message;
	}
}

function isInboundRpcMessage(value: unknown): value is InboundRpcMessage {
	return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function formatLinePreview(line: string): string {
	const preview = JSON.stringify(line.slice(0, MALFORMED_RPC_LINE_PREVIEW_CHARS));
	return line.length > MALFORMED_RPC_LINE_PREVIEW_CHARS ? `${preview}… (${line.length} chars)` : preview;
}
