import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	BUILTIN_HOST_ACTION_REGISTRY,
	type HostActionInvocationContext,
	REVIEW_RERUN_ACTION_ID,
	runCancelHostAction,
	runContextCompactHostAction,
	runSessionNewHostAction,
	runSessionRenameHostAction,
} from "../../core/host-actions.ts";
import { getMcpRpcCapabilities, listMcpRpcServers } from "../../core/mcp/rpc.ts";
import type { McpGatewayExecutionContext } from "../../core/mcp/types.ts";
import { toIrohRemoteAgentOptionsCatalogModel } from "../../core/remote/iroh/agent-options.ts";
import { createReviewSeedMessage } from "../../core/review.ts";
import { publishReviewRun } from "../../core/review-publish.ts";
import {
	acknowledgeReviewRun,
	appendReviewFindingTransition,
	appendReviewPublication,
	appendReviewRun,
	exportReviewFeedback,
	getReviewRun,
	type HydratedReviewRunRecord,
	listReviewRuns,
} from "../../core/review-state.ts";
import { getRpcErrorResponseTarget, isUsableRpcConversationIdentifier } from "../../core/rpc/correlation.ts";
import { buildRpcSessionState } from "../../core/rpc/session-state.ts";
import { projectSessionTreePage } from "../../core/rpc/session-tree.ts";
import { resolveSessionToolCallsByResultEntryId } from "../../core/rpc/tool-call-resolution.ts";
import {
	projectConversationTranscriptEntry,
	projectMessageImages,
	projectSessionTranscript,
} from "../../core/rpc/transcript.ts";
import {
	createUiActionInvocationPlan,
	getUiActionCompletions,
	getUiActionDescriptors,
} from "../../core/rpc/ui-actions.ts";
import { RPC_STABLE_ERROR_CODES } from "../../core/rpc/wire-limits.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SubscriptionUsageReport, SubscriptionUsageService } from "../../core/subscription-usage.ts";
import type {
	RpcCatalogModel,
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcHostActionRequest,
	RpcListSubagentsResponse,
	RpcModel,
	RpcPendingHostActionsResponse,
	RpcPromptResponse,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionListItem,
	RpcSessionState,
	RpcSessionTreePage,
	RpcSlashCommand,
	RpcSubagentStartResponse,
	RpcSubscriptionUsageReport,
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
	reportStreamDiscontinuity(
		command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>,
	): Promise<{ subscriptionId: string; requestId: string; checkpointCursor: number }>;
	getPendingHostActionRequests(): RpcHostActionRequest[];
	cancelPendingHostActionRequests(message?: string): void;
	/** Revalidate the mutation lease after an awaited dispatcher/session preflight boundary. */
	assertConversationGenerationCurrent(): void;
	subscriptionUsageService: SubscriptionUsageService;
	/**
	 * Claim the deferred launch of a review workflow registered by this
	 * invocation. The dispatcher launches it only after the accepted response is
	 * enqueued, so the response precedes workflow_start on the shared lane.
	 */
	takePendingReviewWorkflow?(workflowId: string): { launch: () => void; cancel: () => void } | undefined;
	subagents: RpcSubagentLifecycleController;
}

function createRpcMcpExecutionContext(): McpGatewayExecutionContext {
	return {
		mode: "rpc",
		caller: "user",
	};
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

function toCatalogModel(model: RpcModel): RpcCatalogModel {
	return toIrohRemoteAgentOptionsCatalogModel(model);
}

function projectSubscriptionUsageReport(report: SubscriptionUsageReport): RpcSubscriptionUsageReport {
	if (report.status !== "providers") {
		return { status: report.status };
	}
	return {
		status: "providers",
		providers: report.providers.map((provider) => {
			if (provider.result.status === "error") {
				return {
					providerId: provider.providerId,
					result: {
						status: "error",
						error: {
							code: provider.result.error.code,
							message: provider.result.error.message,
						},
					},
				};
			}
			const snapshot = provider.result.snapshot;
			return {
				providerId: provider.providerId,
				result: {
					status: "success",
					snapshot: {
						providerId: provider.providerId,
						fetchedAt: snapshot.fetchedAt,
						...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
						limits: snapshot.limits.map((limit) => ({
							id: limit.id,
							label: limit.label,
							usedPercent: limit.usedPercent,
							...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
							...(limit.windowDurationMs === undefined ? {} : { windowDurationMs: limit.windowDurationMs }),
							...(limit.limitReached === undefined ? {} : { limitReached: limit.limitReached }),
						})),
					},
				},
			};
		}),
	};
}

function getPromptExtensionCommandName(message: string): string | undefined {
	if (!message.startsWith("/")) {
		return undefined;
	}
	const spaceIndex = message.indexOf(" ");
	const name = spaceIndex === -1 ? message.slice(1) : message.slice(1, spaceIndex);
	return name.length > 0 ? name : undefined;
}

export function createRpcSuccessResponse<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (command === "invoke_ui_action" && !isUsableRpcConversationIdentifier(id)) {
		throw new Error("invoke_ui_action success responses require a usable correlation id");
	}
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

const STABLE_RPC_ERROR_CODES: ReadonlySet<string> = new Set(RPC_STABLE_ERROR_CODES);

function getStableRpcErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
		return undefined;
	}
	return STABLE_RPC_ERROR_CODES.has(error.code) ? error.code : undefined;
}

export function createRpcErrorResponse(
	id: string | undefined,
	command: string,
	message: string,
	error?: unknown,
): RpcResponse {
	const errorCode = getStableRpcErrorCode(error);
	const target = getRpcErrorResponseTarget({ id, type: command });
	return {
		...(target.id === undefined ? {} : { id: target.id }),
		type: "response",
		command: target.command,
		success: false,
		error: message,
		...(errorCode === undefined ? {} : { errorCode }),
	};
}

export { getRpcErrorResponseTarget };

function projectReviewRun(record: HydratedReviewRunRecord, includeResult: boolean): Record<string, unknown> {
	const result = record.result;
	return {
		runId: record.runId,
		workflowAction: record.workflowAction,
		status: record.status,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		...(record.acknowledgedAt === undefined ? {} : { acknowledgedAt: record.acknowledgedAt }),
		target: {
			description: record.target.description,
			diffCommand: record.target.diffCommand,
			identity: record.target.identity,
			...(record.target.context ? { context: record.target.context } : {}),
		},
		options: record.options,
		...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
		...(record.incrementalFallbackReason ? { incrementalFallbackReason: record.incrementalFallbackReason } : {}),
		...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
		...(result
			? includeResult
				? {
						completionStatus: result.completionStatus,
						summary: result.summary,
						findings: result.findings,
						coverage: result.coverage,
						...(result.overallCorrectness ? { overallCorrectness: result.overallCorrectness } : {}),
						overallExplanation: result.overallExplanation,
						...(result.verificationChallenge ? { verificationChallenge: result.verificationChallenge } : {}),
					}
				: { completionStatus: result.completionStatus, findingsCount: result.findings.length }
			: {}),
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
			if (options.requireRemoteSafeUiActions) {
				const commandName = getPromptExtensionCommandName(command.message);
				const extensionCommand = commandName ? session.extensionRunner.getCommand(commandName) : undefined;
				if (extensionCommand && extensionCommand.remoteSafe !== true) {
					return createRpcErrorResponse(
						id,
						"prompt",
						`Extension command is not available over remote host: /${commandName}`,
					);
				}
			}
			// Start prompt handling immediately, but emit the authoritative response only after
			// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
			let preflightSucceeded = false;
			let settleAdmission!: () => void;
			const admission = new Promise<void>((resolve) => {
				settleAdmission = resolve;
			});
			void session
				.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					clientMessageId: command.clientMessageId,
					source: "rpc",
					assertConversationGenerationCurrent: context.assertConversationGenerationCurrent,
					preflightResult: (result) => {
						if (result.success) {
							preflightSucceeded = true;
							const record = session.sessionManager.getClientInput(command.clientMessageId);
							const data: RpcPromptResponse = {
								clientMessageId: command.clientMessageId,
								outcome: result.outcome,
								...(record?.canonicalEntryId === undefined
									? {}
									: { canonicalEntryId: record.canonicalEntryId }),
							};
							context.output(createRpcSuccessResponse(id, "prompt", data));
							settleAdmission();
						}
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						context.output(createRpcErrorResponse(id, "prompt", e.message, e));
					}
					settleAdmission();
				});
			// Structural replacement joins this dedicated admission fence, while
			// ordinary state reads remain responsive during async input hooks.
			runtimeHost.trackClientInputAdmission?.(session, admission);
			return undefined;
		}

		case "steer": {
			await session.steer(command.message, command.images, command.clientMessageId);
			return createRpcSuccessResponse(id, "steer");
		}

		case "follow_up": {
			await session.followUp(command.message, command.images, command.clientMessageId);
			return createRpcSuccessResponse(id, "follow_up");
		}

		case "abort": {
			await runCancelHostAction(context.createHostActionContext());
			return createRpcSuccessResponse(id, "abort");
		}

		case "new_session": {
			const preservedReviewRun = command.preserveReviewRunId
				? getReviewRun(session.sessionManager, command.preserveReviewRunId)
				: undefined;
			if (command.preserveReviewRunId && !preservedReviewRun) {
				return createRpcErrorResponse(id, "new_session", `Unknown review run: ${command.preserveReviewRunId}`);
			}
			let parentSessionRef =
				command.parentSessionId === session.sessionId ? session.sessionManager.getSessionRef() : undefined;
			if (command.parentSessionId && !parentSessionRef) {
				const candidates = await SessionManager.listAll(session.sessionManager.getSessionDir(), undefined, {
					includeMessageFreeDurable: true,
				});
				parentSessionRef = candidates.find((candidate) => candidate.id === command.parentSessionId)?.ref;
				if (!parentSessionRef) {
					return createRpcErrorResponse(id, "new_session", `Unknown parent session: ${command.parentSessionId}`);
				}
			}
			const newSessionOptions = {
				rebindRequestId: id,
				...(parentSessionRef ? { parentSessionRef } : {}),
				...(preservedReviewRun
					? {
							setup: async (sessionManager: SessionManager) => {
								appendReviewRun(sessionManager, preservedReviewRun);
								if (preservedReviewRun.acknowledgedAt !== undefined) {
									acknowledgeReviewRun(
										sessionManager,
										preservedReviewRun.runId,
										preservedReviewRun.acknowledgedAt,
									);
								}
							},
						}
					: {}),
			};
			const result = await runSessionNewHostAction(context.createHostActionContext(), newSessionOptions);
			return createRpcSuccessResponse(id, "new_session", { cancelled: result.cancelled });
		}

		case "set_agent_mode": {
			context.assertConversationGenerationCurrent();
			const planning = await session.setAgentMode(command.mode);
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "set_agent_mode", planning);
		}

		case "plan_execute": {
			const result = await runtimeHost.executePlan(
				command.planId,
				command.expectedRevision,
				command.strategy,
				context.assertConversationGenerationCurrent,
			);
			return createRpcSuccessResponse(id, "plan_execute", result);
		}

		case "plan_change": {
			context.assertConversationGenerationCurrent();
			const planning = session.changePlan(command.planId, command.expectedRevision);
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "plan_change", planning);
		}

		case "plan_discard": {
			context.assertConversationGenerationCurrent();
			const planning = session.discardPlan(command.planId, command.expectedRevision);
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "plan_discard", planning);
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

		case "report_stream_discontinuity": {
			const data = await context.reportStreamDiscontinuity(command);
			return createRpcSuccessResponse(id, "report_stream_discontinuity", data);
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
					detachedReviews: true,
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
				const pendingReviewWorkflow =
					response.status === "accepted" && response.workflowId !== undefined
						? context.takePendingReviewWorkflow?.(response.workflowId)
						: undefined;
				try {
					await session.sessionManager.flush();
				} catch (error) {
					pendingReviewWorkflow?.cancel();
					throw error;
				}
				if (pendingReviewWorkflow) {
					try {
						context.output(createRpcSuccessResponse(id, "invoke_ui_action", response));
					} finally {
						// The workflow must always launch once registered; an unlaunched
						// entry would pin the active set (and daemon retention) forever.
						pendingReviewWorkflow.launch();
					}
					return undefined;
				}
				return createRpcSuccessResponse(id, "invoke_ui_action", response);
			}
			const invocation = createUiActionInvocationPlan(session, {
				action: command.action,
				args: command.args,
				requireRemoteSafe: options.requireRemoteSafeUiActions,
				streamingBehavior: command.streamingBehavior,
			});
			let preflightSucceeded = false;
			let settleAdmission!: () => void;
			const admission = new Promise<void>((resolve) => {
				settleAdmission = resolve;
			});
			void session
				.prompt(invocation.promptText, {
					streamingBehavior: invocation.promptStreamingBehavior,
					source: "rpc",
					assertConversationGenerationCurrent: context.assertConversationGenerationCurrent,
					preflightResult: (result) => {
						if (result.success) {
							preflightSucceeded = true;
							context.output(createRpcSuccessResponse(id, "invoke_ui_action", invocation.response));
							settleAdmission();
						}
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						context.output(createRpcErrorResponse(id, "invoke_ui_action", e.message, e));
					}
					settleAdmission();
				});
			runtimeHost.trackClientInputAdmission?.(session, admission);
			return undefined;
		}

		// =================================================================
		// Detached review workflows
		// =================================================================

		case "cancel_workflow": {
			runtimeHost.reviewWorkflows.cancel(command.workflowId);
			return createRpcSuccessResponse(id, "cancel_workflow");
		}

		case "list_review_workflows": {
			const page = listReviewRuns(session.sessionManager, { cursor: command.cursor, limit: command.limit });
			return createRpcSuccessResponse(id, "list_review_workflows", {
				runs: page.runs.map((run) => projectReviewRun(run, false)),
				activeWorkflows: runtimeHost.reviewWorkflows.list().filter((workflow) => workflow.status === "running"),
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			});
		}

		case "get_review_result": {
			const record = getReviewRun(session.sessionManager, command.runId);
			if (!record)
				return createRpcErrorResponse(id, "get_review_result", `Unknown durable review run: ${command.runId}`);
			return createRpcSuccessResponse(id, "get_review_result", projectReviewRun(record, true));
		}

		case "open_review_session": {
			const sourceSessionManager = session.sessionManager;
			const record = getReviewRun(sourceSessionManager, command.runId);
			if (!record?.result)
				return createRpcErrorResponse(
					id,
					"open_review_session",
					`Review run has no findings result: ${command.runId}`,
				);
			const selectedIds = new Set(command.findingIds ?? record.result.findings.map((finding) => finding.id));
			const unknownIds = [...selectedIds].filter(
				(findingId) => !record.result?.findings.some((finding) => finding.id === findingId),
			);
			if (unknownIds.length > 0)
				return createRpcErrorResponse(id, "open_review_session", `Unknown finding ids: ${unknownIds.join(", ")}`);
			const selectedResult = {
				...record.result,
				findings: record.result.findings.filter((finding) => selectedIds.has(finding.id)),
			};
			const seedMessage = createReviewSeedMessage(record.target, { parsed: selectedResult });
			let targetSessionManager: SessionManager | undefined;
			let acknowledgedAt: number | undefined;
			const result = await runSessionNewHostAction(context.createHostActionContext(), {
				setup: async (sessionManager) => {
					targetSessionManager = sessionManager;
					appendReviewRun(sessionManager, record);
				},
				withSession: async (sessionContext) => {
					await sessionContext.sendMessage(seedMessage);
					if (!targetSessionManager) throw new Error("Review session was not initialized");
					acknowledgedAt = acknowledgeReviewRun(
						targetSessionManager,
						record.runId,
						record.acknowledgedAt ?? Date.now(),
					).acknowledgedAt;
				},
			});
			if (!result.cancelled && !result.seeded) {
				return createRpcErrorResponse(
					id,
					"open_review_session",
					`Review session was opened without findings; the durable run remains available: ${command.runId}`,
				);
			}
			if (result.seeded && command.findingIds === undefined) {
				if (acknowledgedAt === undefined) throw new Error("Review session was seeded without acknowledgment");
				const sourceSessionRef = sourceSessionManager.getSessionRef();
				const acknowledgmentManager = sourceSessionRef
					? await SessionManager.open(sourceSessionRef)
					: sourceSessionManager;
				acknowledgeReviewRun(acknowledgmentManager, record.runId, acknowledgedAt);
				await acknowledgmentManager.flush();
			}
			return createRpcSuccessResponse(id, "open_review_session", { cancelled: result.cancelled });
		}

		case "acknowledge_review": {
			const acknowledgment = acknowledgeReviewRun(session.sessionManager, command.runId);
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "acknowledge_review", {
				runId: acknowledgment.runId,
				acknowledgedAt: acknowledgment.acknowledgedAt,
			});
		}

		case "record_review_finding_outcome": {
			const record = getReviewRun(session.sessionManager, command.runId);
			if (!record?.result?.findings.some((finding) => finding.id === command.findingId)) {
				return createRpcErrorResponse(
					id,
					"record_review_finding_outcome",
					`Unknown finding ${command.findingId} in review run ${command.runId}`,
				);
			}
			if (command.status === "dismissed" && !command.reason) {
				return createRpcErrorResponse(
					id,
					"record_review_finding_outcome",
					"Dismissed findings require an explicit reason.",
				);
			}
			const transition = appendReviewFindingTransition(session.sessionManager, {
				runId: command.runId,
				findingId: command.findingId,
				status: command.status,
				...(command.reason ? { reason: command.reason } : {}),
				...(command.note ? { note: command.note } : {}),
			});
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "record_review_finding_outcome", transition);
		}

		case "rerun_review": {
			const record = getReviewRun(session.sessionManager, command.runId);
			if (!record) return createRpcErrorResponse(id, "rerun_review", `Unknown review run: ${command.runId}`);
			const response = await BUILTIN_HOST_ACTION_REGISTRY.invoke(
				REVIEW_RERUN_ACTION_ID,
				context.createHostActionContext(),
				{ runId: record.runId, scopeMode: command.mode ?? "incremental" },
				{ requireRemoteSafe: options.requireRemoteSafeUiActions },
			);
			if (response.status !== "accepted" || !response.workflowId) {
				return createRpcErrorResponse(id, "rerun_review", response.message ?? "The review rerun was not accepted.");
			}
			const pending = context.takePendingReviewWorkflow?.(response.workflowId);
			if (!pending)
				return createRpcErrorResponse(id, "rerun_review", "The accepted review rerun was not registered.");
			try {
				await session.sessionManager.flush();
				context.output(
					createRpcSuccessResponse(id, "rerun_review", { status: "accepted", workflowId: response.workflowId }),
				);
			} catch (error) {
				pending.cancel();
				throw error;
			} finally {
				pending.launch();
			}
			return undefined;
		}

		case "publish_review": {
			const record = getReviewRun(session.sessionManager, command.runId);
			if (!record) return createRpcErrorResponse(id, "publish_review", `Unknown review run: ${command.runId}`);
			const published = await publishReviewRun(session.sessionManager.getCwd(), record);
			appendReviewPublication(session.sessionManager, { runId: record.runId, ...published });
			await session.sessionManager.flush();
			return createRpcSuccessResponse(id, "publish_review", published);
		}

		case "export_review_feedback":
			return createRpcSuccessResponse(id, "export_review_feedback", exportReviewFeedback(session.sessionManager));

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
		// MCP management
		// =================================================================

		case "get_mcp_capabilities": {
			return createRpcSuccessResponse(id, "get_mcp_capabilities", getMcpRpcCapabilities());
		}

		case "list_mcp_servers": {
			return createRpcSuccessResponse(id, "list_mcp_servers", listMcpRpcServers(session.getMcpManager()));
		}

		case "get_mcp_server": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "get_mcp_server", "MCP is not configured");
			}
			return createRpcSuccessResponse(id, "get_mcp_server", { server: manager.getServer(command.server) });
		}

		case "connect_mcp_server":
		case "refresh_mcp_server": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, command.type, "MCP is not configured");
			}
			const result = await manager.connectServer(command.server);
			return createRpcSuccessResponse(id, command.type, { server: result.server });
		}

		case "disconnect_mcp_server": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "disconnect_mcp_server", "MCP is not configured");
			}
			const result = await manager.disconnectServer(command.server);
			return createRpcSuccessResponse(id, "disconnect_mcp_server", { server: result.server });
		}

		case "start_mcp_server_auth": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "start_mcp_server_auth", "MCP is not configured");
			}
			const result = await manager.startServerAuth(command.server, {
				flow: command.flow,
				redirectUrl: command.redirectUrl,
			});
			return createRpcSuccessResponse(id, "start_mcp_server_auth", result as object);
		}

		case "complete_mcp_server_auth": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "complete_mcp_server_auth", "MCP is not configured");
			}
			const result = await manager.completeServerBrowserAuth(command.server, {
				redirectUrl: command.redirectUrl,
				code: command.code,
				state: command.state,
			});
			return createRpcSuccessResponse(id, "complete_mcp_server_auth", result as object);
		}

		case "poll_mcp_server_auth": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "poll_mcp_server_auth", "MCP is not configured");
			}
			return createRpcSuccessResponse(
				id,
				"poll_mcp_server_auth",
				(await manager.pollServerAuth(command.server)) as object,
			);
		}

		case "cancel_mcp_server_auth": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "cancel_mcp_server_auth", "MCP is not configured");
			}
			return createRpcSuccessResponse(id, "cancel_mcp_server_auth", manager.cancelServerAuth(command.server));
		}

		case "logout_mcp_server": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "logout_mcp_server", "MCP is not configured");
			}
			return createRpcSuccessResponse(id, "logout_mcp_server", await manager.logoutServer(command.server));
		}

		case "set_mcp_server_enabled": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "set_mcp_server_enabled", "MCP is not configured");
			}
			const result = await manager.setServerEnabled(command.server, command.enabled);
			return createRpcSuccessResponse(id, "set_mcp_server_enabled", {
				server: result.server,
				...(result.persisted ? { persisted: result.persisted } : {}),
			});
		}

		case "list_mcp_tools": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "list_mcp_tools", "MCP is not configured");
			}
			return createRpcSuccessResponse(id, "list_mcp_tools", await manager.listTools(command.server));
		}

		case "get_mcp_tool": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "get_mcp_tool", "MCP is not configured");
			}
			const tools = await manager.listTools(command.server);
			const tool = tools.tools.find((entry) => entry.name === command.tool);
			if (!tool) {
				return createRpcErrorResponse(id, "get_mcp_tool", `MCP tool not found: ${command.server}.${command.tool}`);
			}
			return createRpcSuccessResponse(id, "get_mcp_tool", { tool });
		}

		case "list_mcp_resources": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "list_mcp_resources", "MCP is not configured");
			}
			return createRpcSuccessResponse(
				id,
				"list_mcp_resources",
				await manager.listResources(command.server, command.cursor),
			);
		}

		case "read_mcp_resource": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "read_mcp_resource", "MCP is not configured");
			}
			const result = await manager.readResource(command.server, command.resourceUri, createRpcMcpExecutionContext());
			return createRpcSuccessResponse(id, "read_mcp_resource", { result });
		}

		case "list_mcp_prompts": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "list_mcp_prompts", "MCP is not configured");
			}
			return createRpcSuccessResponse(
				id,
				"list_mcp_prompts",
				await manager.listPrompts(command.server, command.cursor),
			);
		}

		case "get_mcp_prompt": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcErrorResponse(id, "get_mcp_prompt", "MCP is not configured");
			}
			const result = await manager.getPrompt(
				command.server,
				command.prompt,
				{ action: "get_prompt", arguments: command.arguments, argumentsJson: command.argumentsJson },
				createRpcMcpExecutionContext(),
			);
			return createRpcSuccessResponse(id, "get_mcp_prompt", { result });
		}

		case "list_mcp_recent_calls": {
			const manager = session.getMcpManager();
			if (!manager) {
				return createRpcSuccessResponse(id, "list_mcp_recent_calls", { calls: [] });
			}
			const calls = command.server
				? manager.getServer(command.server).recentCalls
				: manager.listServers().flatMap((server) => server.recentCalls);
			return createRpcSuccessResponse(id, "list_mcp_recent_calls", { calls });
		}

		// =================================================================
		// State
		// =================================================================

		case "get_state": {
			return createRpcSuccessResponse(id, "get_state", buildRpcSessionState(session));
		}

		case "get_transcript": {
			const transcript = projectSessionTranscript(session.sessionManager, {
				beforeEntryId: command.beforeEntryId,
				limit: command.limit,
			});
			return createRpcSuccessResponse(id, "get_transcript", transcript);
		}

		case "get_session_tree": {
			const entries = session.sessionManager.getEntries();
			const toolCallsByResultEntryId = resolveSessionToolCallsByResultEntryId(entries);
			const tree: RpcSessionTreePage = projectSessionTreePage(entries, session.sessionManager.getBranch(), {
				sessionId: session.sessionManager.getSessionId(),
				limit: command.limit,
				afterOrdinal: command.afterOrdinal,
				projectTranscriptEntry: (entry) =>
					projectConversationTranscriptEntry(entry, toolCallsByResultEntryId.get(entry.id)),
			});
			return createRpcSuccessResponse(id, "get_session_tree", tree);
		}

		case "get_message_images": {
			const result = projectMessageImages(
				session.sessionManager.getEntries(),
				command.entryId,
				command.startImageIndex,
			);
			if (!result.ok) {
				return createRpcErrorResponse(id, "get_message_images", result.error);
			}
			return createRpcSuccessResponse(id, "get_message_images", {
				sessionId: session.sessionManager.getSessionId(),
				entryId: result.entryId,
				totalImages: result.totalImages,
				images: result.images,
				nextImageIndex: result.nextImageIndex,
			});
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
			context.assertConversationGenerationCurrent();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return createRpcErrorResponse(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model, { persistDefault: command.persistDefault });
			return createRpcSuccessResponse(id, "set_model", toCatalogModel(model));
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return createRpcSuccessResponse(id, "cycle_model", null);
			}
			return createRpcSuccessResponse(id, "cycle_model", result);
		}

		case "get_available_models": {
			// Reload credentials and models from disk so logins, logouts, and API keys
			// saved by other volt processes become selectable without a host restart.
			session.modelRegistry.refreshFromDisk();
			const models = await session.modelRegistry.getAvailable();
			return createRpcSuccessResponse(id, "get_available_models", { models: models.map(toCatalogModel) });
		}

		// =================================================================
		// Thinking
		// =================================================================

		case "set_thinking_level": {
			session.setThinkingLevel(command.level, { persistDefault: command.persistDefault });
			await Promise.all([session.sessionManager.flush(), session.settingsManager.flush()]);
			return createRpcSuccessResponse(id, "set_thinking_level", { level: session.thinkingLevel });
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return createRpcSuccessResponse(id, "cycle_thinking_level", null);
			}
			await Promise.all([session.sessionManager.flush(), session.settingsManager.flush()]);
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
			const { sessionRef: _sessionRef, ...stats } = session.getSessionStats();
			return createRpcSuccessResponse(id, "get_session_stats", stats);
		}

		case "get_subscription_usage": {
			const report = await context.subscriptionUsageService.fetch(
				session.modelRegistry.authStorage,
				session.model?.provider,
			);
			return createRpcSuccessResponse(id, "get_subscription_usage", projectSubscriptionUsageReport(report));
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
			const result = await runtimeHost.switchSessionById(command.sessionId, {
				assertConversationGenerationCurrent: context.assertConversationGenerationCurrent,
			});
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "switch_session", { cancelled: result.cancelled });
		}

		case "switch_session_by_id": {
			const result = await runtimeHost.switchSessionById(command.sessionId, {
				assertConversationGenerationCurrent: context.assertConversationGenerationCurrent,
			});
			if (!result.cancelled) {
				await context.rebindSession();
			}
			return createRpcSuccessResponse(id, "switch_session_by_id", { cancelled: result.cancelled });
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
			await session.sessionManager.flush();
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
