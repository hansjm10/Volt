import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	BUILTIN_HOST_ACTION_REGISTRY,
	type HostActionInvocationContext,
	runCancelHostAction,
	runContextCompactHostAction,
	runSessionNewHostAction,
	runSessionRenameHostAction,
} from "../../core/host-actions.ts";
import { projectSessionTranscript } from "../../core/rpc/transcript.ts";
import {
	createUiActionInvocationPlan,
	getUiActionCompletions,
	getUiActionDescriptors,
} from "../../core/rpc/ui-actions.ts";
import type {
	RpcActiveToolExecution,
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcHostActionRequest,
	RpcListSubagentsResponse,
	RpcPendingHostActionsResponse,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionListItem,
	RpcSessionState,
	RpcSlashCommand,
	RpcSubagentStartResponse,
	RpcTranscriptResponse,
	UiActionCapabilities,
} from "./rpc-types.ts";

export const HOST_ACTION_REQUESTS_CAPABILITY: RpcClientCapabilityFeature = "host_action_requests.v1";

export interface RpcCommandDispatcherOptions {
	allowUiActionInvocation: boolean;
	requireRemoteSafeUiActions: boolean;
	registerPushTarget: ((args: unknown) => Promise<RpcRegisterPushTargetResponse>) | undefined;
}

export interface RpcSubagentLifecycleController {
	list(): RpcListSubagentsResponse;
	start(agent: string, prompt: string): Promise<RpcSubagentStartResponse>;
	abort(subagentId: string): Promise<void>;
	getState(subagentId: string): Promise<RpcSessionState>;
	getTranscript(options: {
		subagentId: string;
		limit?: number;
		beforeEntryId?: string;
	}): Promise<RpcTranscriptResponse>;
	dispose(subagentId: string): Promise<void>;
	disposeAll(): Promise<void>;
}

export interface RpcCommandDispatcherContext {
	session: AgentSession;
	runtimeHost: AgentSessionRuntime;
	options: RpcCommandDispatcherOptions;
	output(response: RpcResponse): void;
	rebindSession(): Promise<void>;
	createHostActionContext(): HostActionInvocationContext;
	setClientCapabilities(features: RpcClientCapabilityFeature[]): void;
	getPendingHostActionRequests(): RpcHostActionRequest[];
	cancelPendingHostActionRequests(message?: string): void;
	subagents: RpcSubagentLifecycleController;
}

function getUiActionCapabilities(invocationEnabled: boolean): UiActionCapabilities {
	return {
		protocolVersion: 1,
		features: invocationEnabled
			? ["ui_actions.v1", "ui_action_invocation.v1", "ui_action_completions.v1"]
			: ["ui_actions.v1", "ui_action_completions.v1"],
		maxActions: 200,
		maxDescriptorBytes: 65_536,
	};
}

export function createRpcSuccessResponse<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function createRpcErrorResponse(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export function getRpcErrorResponseTarget(value: unknown): { id: string | undefined; command: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { id: undefined, command: "unknown" };
	}
	const command = value as Record<string, unknown>;
	return {
		id: typeof command.id === "string" ? command.id : undefined,
		command: typeof command.type === "string" ? command.type : "unknown",
	};
}

export async function handleRpcCommand(
	command: RpcCommand,
	context: RpcCommandDispatcherContext,
): Promise<RpcResponse | undefined> {
	const { options, runtimeHost, session } = context;
	const id = typeof command.id === "string" ? command.id : undefined;

	switch (command.type) {
		// =================================================================
		// Prompting
		// =================================================================

		case "prompt": {
			// Start prompt handling immediately, but emit the authoritative response only after
			// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
			let preflightSucceeded = false;
			void session
				.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							context.output(createRpcSuccessResponse(id, "prompt"));
						}
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						context.output(createRpcErrorResponse(id, "prompt", e.message));
					}
				});
			return undefined;
		}

		case "steer": {
			await session.steer(command.message, command.images);
			return createRpcSuccessResponse(id, "steer");
		}

		case "follow_up": {
			await session.followUp(command.message, command.images);
			return createRpcSuccessResponse(id, "follow_up");
		}

		case "abort": {
			await runCancelHostAction(context.createHostActionContext());
			return createRpcSuccessResponse(id, "abort");
		}

		case "new_session": {
			const newSessionOptions = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const result = await runSessionNewHostAction(context.createHostActionContext(), newSessionOptions);
			return createRpcSuccessResponse(id, "new_session", result);
		}

		// =================================================================
		// Client capabilities and host-initiated actions
		// =================================================================

		case "set_client_capabilities": {
			context.setClientCapabilities(command.features);
			if (!command.features.includes(HOST_ACTION_REQUESTS_CAPABILITY)) {
				context.cancelPendingHostActionRequests("Host action capability disabled");
			}
			return createRpcSuccessResponse(id, "set_client_capabilities");
		}

		case "get_pending_host_actions": {
			const data: RpcPendingHostActionsResponse = {
				actions: context.getPendingHostActionRequests(),
			};
			return createRpcSuccessResponse(id, "get_pending_host_actions", data);
		}

		// =================================================================
		// Native UI Actions
		// =================================================================

		case "get_ui_capabilities": {
			return createRpcSuccessResponse(
				id,
				"get_ui_capabilities",
				getUiActionCapabilities(options.allowUiActionInvocation),
			);
		}

		case "get_ui_actions": {
			return createRpcSuccessResponse(id, "get_ui_actions", {
				actions: getUiActionDescriptors(session, command.scope, {
					remoteSafeOnly: options.requireRemoteSafeUiActions,
				}),
			});
		}

		case "get_ui_action_completions": {
			return createRpcSuccessResponse(id, "get_ui_action_completions", {
				completions: await getUiActionCompletions(session, {
					action: command.action,
					argument: command.argument,
					prefix: command.prefix,
					requireRemoteSafe: options.requireRemoteSafeUiActions,
				}),
			});
		}

		case "invoke_ui_action": {
			if (!options.allowUiActionInvocation) {
				return createRpcErrorResponse(
					id,
					"invoke_ui_action",
					"UI action invocation is not available over this RPC transport",
				);
			}
			if (BUILTIN_HOST_ACTION_REGISTRY.get(command.action)) {
				const response = await BUILTIN_HOST_ACTION_REGISTRY.invoke(
					command.action,
					context.createHostActionContext(),
					command.args,
					{ requireRemoteSafe: options.requireRemoteSafeUiActions },
				);
				return createRpcSuccessResponse(id, "invoke_ui_action", response);
			}
			const invocation = createUiActionInvocationPlan(session, {
				action: command.action,
				args: command.args,
				requireRemoteSafe: options.requireRemoteSafeUiActions,
				streamingBehavior: command.streamingBehavior,
			});
			let preflightSucceeded = false;
			void session
				.prompt(invocation.promptText, {
					streamingBehavior: invocation.promptStreamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							context.output(createRpcSuccessResponse(id, "invoke_ui_action", invocation.response));
						}
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						context.output(createRpcErrorResponse(id, "invoke_ui_action", e.message));
					}
				});
			return undefined;
		}

		// =================================================================
		// Push notifications
		// =================================================================

		case "register_push_target": {
			if (!options.registerPushTarget) {
				return createRpcErrorResponse(
					id,
					"register_push_target",
					"Push target registration is not available over this RPC transport",
				);
			}
			return createRpcSuccessResponse(id, "register_push_target", await options.registerPushTarget(command.args));
		}

		// =================================================================
		// State
		// =================================================================

		case "get_state": {
			const activeCompaction = session.activeCompaction;
			const activeTools = [...session.agent.state.pendingToolExecutions.values()].map(
				(execution): RpcActiveToolExecution => ({
					toolCallId: execution.toolCallId,
					toolName: execution.toolName,
					status: "started",
					args: { ...execution.args },
				}),
			);
			const state: RpcSessionState = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				autoCompactionEnabled: session.autoCompactionEnabled,
				messageCount: session.messages.length,
				pendingMessageCount: session.pendingMessageCount,
				...(activeTools.length === 0 ? {} : { activeTools }),
				...(activeCompaction ? { activeCompaction } : {}),
			};
			return createRpcSuccessResponse(id, "get_state", state);
		}

		case "get_transcript": {
			const transcript = projectSessionTranscript(session.sessionManager, {
				beforeEntryId: command.beforeEntryId,
				limit: command.limit,
			});
			return createRpcSuccessResponse(id, "get_transcript", transcript);
		}

		// =================================================================
		// Subagents (local RPC only)
		// =================================================================

		case "list_subagents": {
			return createRpcSuccessResponse(id, "list_subagents", context.subagents.list());
		}

		case "subagent_start": {
			return createRpcSuccessResponse(
				id,
				"subagent_start",
				await context.subagents.start(command.agent, command.prompt),
			);
		}

		case "subagent_abort": {
			await context.subagents.abort(command.subagentId);
			return createRpcSuccessResponse(id, "subagent_abort");
		}

		case "subagent_get_state": {
			return createRpcSuccessResponse(
				id,
				"subagent_get_state",
				await context.subagents.getState(command.subagentId),
			);
		}

		case "subagent_get_transcript": {
			return createRpcSuccessResponse(
				id,
				"subagent_get_transcript",
				await context.subagents.getTranscript({
					subagentId: command.subagentId,
					limit: command.limit,
					beforeEntryId: command.beforeEntryId,
				}),
			);
		}

		case "subagent_dispose": {
			await context.subagents.dispose(command.subagentId);
			return createRpcSuccessResponse(id, "subagent_dispose");
		}

		// =================================================================
		// Model
		// =================================================================

		case "set_model": {
			const models = await session.modelRegistry.getAvailable();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return createRpcErrorResponse(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model);
			return createRpcSuccessResponse(id, "set_model", model);
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return createRpcSuccessResponse(id, "cycle_model", null);
			}
			return createRpcSuccessResponse(id, "cycle_model", result);
		}

		case "get_available_models": {
			const models = await session.modelRegistry.getAvailable();
			return createRpcSuccessResponse(id, "get_available_models", { models });
		}

		// =================================================================
		// Thinking
		// =================================================================

		case "set_thinking_level": {
			session.setThinkingLevel(command.level);
			return createRpcSuccessResponse(id, "set_thinking_level");
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return createRpcSuccessResponse(id, "cycle_thinking_level", null);
			}
			return createRpcSuccessResponse(id, "cycle_thinking_level", { level });
		}

		// =================================================================
		// Queue Modes
		// =================================================================

		case "set_steering_mode": {
			session.setSteeringMode(command.mode);
			return createRpcSuccessResponse(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			session.setFollowUpMode(command.mode);
			return createRpcSuccessResponse(id, "set_follow_up_mode");
		}

		// =================================================================
		// Compaction
		// =================================================================

		case "compact": {
			const result = await runContextCompactHostAction(
				context.createHostActionContext(),
				command.customInstructions,
			);
			return createRpcSuccessResponse(id, "compact", result);
		}

		case "set_auto_compaction": {
			session.setAutoCompactionEnabled(command.enabled);
			return createRpcSuccessResponse(id, "set_auto_compaction");
		}

		// =================================================================
		// Retry
		// =================================================================

		case "set_auto_retry": {
			session.setAutoRetryEnabled(command.enabled);
			return createRpcSuccessResponse(id, "set_auto_retry");
		}

		case "abort_retry": {
			session.abortRetry();
			return createRpcSuccessResponse(id, "abort_retry");
		}

		// =================================================================
		// Bash
		// =================================================================

		case "bash": {
			const result = await session.executeBash(command.command, undefined, {
				excludeFromContext: command.excludeFromContext,
			});
			return createRpcSuccessResponse(id, "bash", result);
		}

		case "abort_bash": {
			session.abortBash();
			return createRpcSuccessResponse(id, "abort_bash");
		}

		// =================================================================
		// Session
		// =================================================================

		case "get_session_stats": {
			const stats = session.getSessionStats();
			return createRpcSuccessResponse(id, "get_session_stats", stats);
		}

		case "list_sessions": {
			const sessions: RpcSessionListItem[] = await runtimeHost.listSessions();
			return createRpcSuccessResponse(id, "list_sessions", { sessions });
		}

		case "export_html": {
			const path = await session.exportToHtml(command.outputPath);
			return createRpcSuccessResponse(id, "export_html", { path });
		}

		case "switch_session": {
			const result = await runtimeHost.switchSession(command.sessionPath);
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "switch_session", result);
		}

		case "switch_session_by_id": {
			const result = await runtimeHost.switchSessionById(command.sessionId);
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "switch_session_by_id", result);
		}

		case "fork": {
			const result = await runtimeHost.fork(command.entryId);
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
		}

		case "clone": {
			const leafId = session.sessionManager.getLeafId();
			if (!leafId) {
				return createRpcErrorResponse(id, "clone", "Cannot clone session: no current entry selected");
			}
			const result = await runtimeHost.fork(leafId, { position: "at" });
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "clone", { cancelled: result.cancelled });
		}

		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return createRpcSuccessResponse(id, "get_fork_messages", { messages });
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText();
			return createRpcSuccessResponse(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			runSessionRenameHostAction(context.createHostActionContext(), command.name);
			return createRpcSuccessResponse(id, "set_session_name");
		}

		// =================================================================
		// Messages
		// =================================================================

		case "get_messages": {
			return createRpcSuccessResponse(id, "get_messages", { messages: session.messages });
		}

		// =================================================================
		// Commands (available for invocation via prompt)
		// =================================================================

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const command of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				});
			}

			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return createRpcSuccessResponse(id, "get_commands", { commands });
		}

		default: {
			const target = getRpcErrorResponseTarget(command);
			return createRpcErrorResponse(target.id, target.command, `Unknown command: ${target.command}`);
		}
	}
}
