/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` and a correlation `id` where required by the command schema
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	type HostActionInvocationContext,
	REVIEW_EXPORT_FEEDBACK_ACTION_ID,
	REVIEW_FEEDBACK_ACTION_ID,
	REVIEW_FIX_ACTION_ID,
	REVIEW_PUBLISH_ACTION_ID,
	REVIEW_RERUN_ACTION_ID,
} from "../../core/host-actions.ts";
import type {
	HostActionDecision,
	HostActionRequest,
	HostActionUpdate,
	HostInteraction,
} from "../../core/host-interaction.ts";
import { startModelCatalogWatcher } from "../../core/model-catalog-watcher.ts";
import {
	flushRawStdout,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import {
	createReviewSeedMessage,
	executeReviewWorkflow,
	prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
	type ReviewWorkflowEvent,
	type ReviewWorkflowToolEvent,
} from "../../core/review.ts";
import { publishReviewRun } from "../../core/review-publish.ts";
import {
	acknowledgeReviewRun,
	appendReviewFindingTransition,
	appendReviewPublication,
	appendReviewRun,
	createReviewRunRecord,
	exportReviewFeedback,
	getReviewRun,
} from "../../core/review-state.ts";
import { type ProjectionDiagnostic, StreamProjector } from "../../core/rpc/stream-projection.ts";
import type { RpcTransport } from "../../core/rpc/transport.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SubagentDefinition, SubagentHandle } from "../../core/subagents/index.ts";
import { SubscriptionUsageService } from "../../core/subscription-usage.ts";
import {
	getAvailableThemesWithPaths,
	getThemeByName,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	theme,
} from "../../core/theme/runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import {
	createRpcErrorResponse,
	getRpcErrorResponseTarget,
	HOST_ACTION_REQUESTS_CAPABILITY,
	handleRpcCommand,
	type RpcSubagentLifecycleController,
} from "./rpc-command-dispatcher.ts";
import { validateRpcCommandPayload } from "./rpc-command-validation.ts";
import type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostActionRequest,
	RpcHostActionResponse,
	RpcHostActionUpdate,
	RpcListSubagentsResponse,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionState,
	RpcSubagentDefinition,
	RpcSubagentStartResponse,
	RpcTranscriptResponse,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostActionRequest,
	RpcHostActionResponse,
	RpcHostActionUpdate,
	RpcListSubagentsResponse,
	RpcPendingHostActionsResponse,
	RpcPushPlatform,
	RpcPushProvider,
	RpcRegisterPushTargetArgs,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionState,
	RpcSubagentDefinition,
	RpcSubagentDefinitionSource,
	RpcSubagentSourceInfo,
	RpcSubagentStartResponse,
	RpcSubscriptionUsageReport,
	RpcWorkflowEvent,
	RpcWorkflowKind,
	RpcWorkflowStatus,
	RpcWorkflowToolEvent,
	UiActionArgumentDescriptor,
	UiActionArgumentType,
	UiActionCapabilities,
	UiActionCapabilityFeature,
	UiActionCategory,
	UiActionCompletionListResponse,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionInvocationStatus,
	UiActionListResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
	UiActionPresentationHint,
	UiActionPresentationKind,
	UiActionScalar,
	UiActionSlashAlias,
	UiActionSource,
	UiActionStateDescriptor,
	UiActionStateType,
	UiActionStreamingBehavior,
} from "./rpc-types.ts";

function parseHostActionResponseDecision(value: unknown): RpcHostActionResponse["decision"] | undefined {
	return value === "approved" || value === "denied" || value === "dismissed" ? value : undefined;
}

export interface RpcSessionChange {
	sessionFile?: string;
	sessionId: string;
}

export interface RpcOrderedConversationBinding {
	readonly subscriptionId: string;
	readonly branchEpoch: string;
	subscribeAuthorityChanges(listener: () => void): () => void;
	enqueueControl(value: object): Promise<void>;
	requestCheckpoint(command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>): {
		subscriptionId: string;
		requestId: string;
		checkpointCursor: number;
	};
	publishExternal(event: object): void;
}

export interface RpcModeOptions {
	transport?: RpcTransport;
	/** Defaults to true. Remote hosts can detach a transport without disposing the owned runtime. */
	disposeRuntimeOnClose?: boolean;
	/** Defaults to true for stdio RPC mode and false for caller-provided transports. */
	exitProcess?: boolean;
	/** Called after the active session is rebound, including initial startup. */
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	/** Called after initial startup has completed and the RPC transport is accepting commands. */
	onReady?: () => void;
	/** Called for review workflow events even if the client transport has already detached. */
	onWorkflowEvent?: (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent) => void | Promise<void>;
	/** Defaults to true. Remote transports can disable this until their action allowlist is widened. */
	allowUiActionInvocation?: boolean;
	/** Defaults to false. Remote transports should only expose and invoke actions marked remote-safe. */
	requireRemoteSafeUiActions?: boolean;
	/** Remote host callback for registering platform push notification targets. */
	registerPushTarget?: (args: unknown) => Promise<RpcRegisterPushTargetResponse>;
	/** Observes set_client_capabilities feature lists (remote hosts gate optional pushes on these). */
	onClientCapabilitiesChanged?: (features: string[]) => void;
	/** Outbound projector factory; Iroh remote mode supplies its field-aware sanitizer. */
	createStreamProjector?: () => StreamProjector;
	/** One runtime-owned conversation lane for events, checkpoints, and control frames. */
	orderedConversation?: RpcOrderedConversationBinding;
	/** Require generation-bound authority for remote conversation mutations. */
	requireConversationAuthority?: boolean;
}

type RpcModeStartupAwareTransport = RpcTransport & {
	setRpcModeStartupComplete?(startupComplete: boolean): void;
};

const MAX_PENDING_RPC_INPUT_TASKS = 64;
const RPC_SESSION_INTERRUPTION_TYPES: ReadonlySet<string> = new Set(["abort", "abort_retry", "abort_bash"]);
const RPC_CONVERSATION_AUTHORITY_MUTATION_TYPES: ReadonlySet<RpcCommand["type"]> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"switch_session_by_id",
	"set_model",
	"set_thinking_level",
	"invoke_ui_action",
	"open_review_session",
	"acknowledge_review",
]);

class StaleConversationAuthorityError extends Error {
	readonly code = "stale_conversation_authority";

	constructor() {
		super("Conversation authority is stale; apply the latest conversation bootstrap and retry");
		this.name = "StaleConversationAuthorityError";
	}
}

/** Commands that must reach the active session even while another stream owns the lifecycle actor. */
export function isRpcSessionInterruptionCommand(command: { type?: unknown }): boolean {
	return typeof command.type === "string" && RPC_SESSION_INTERRUPTION_TYPES.has(command.type);
}

function createStdioRpcTransport(): RpcTransport {
	return {
		write(value) {
			writeRawStdout(serializeJsonLine(value));
		},
		onLine(handler) {
			return attachJsonlLineReader(process.stdin, handler);
		},
		onClose(handler) {
			const onEnd = () => {
				handler();
			};
			const onError = (error: Error) => {
				handler(error);
			};
			process.stdin.on("end", onEnd);
			process.stdin.on("error", onError);
			return () => {
				process.stdin.off("end", onEnd);
				process.stdin.off("error", onError);
			};
		},
		waitForBackpressure: waitForRawStdoutBackpressure,
		flush: flushRawStdout,
		close() {
			process.stdin.pause();
		},
	};
}

interface RpcHostActionBridgeAttachment {
	canSend(): boolean;
	isShuttingDown(): boolean;
	output(message: RpcHostActionRequest | RpcHostActionUpdate): void;
}

interface PendingRpcHostActionRequest {
	request: RpcHostActionRequest;
	resolve(decision: HostActionDecision): void;
	settled: boolean;
	signal?: AbortSignal;
	timeoutId?: ReturnType<typeof setTimeout>;
	onAbort(): void;
}

class RpcHostActionBridge {
	readonly interaction: HostInteraction = {
		requestAction: (request, options) => this.requestAction(request, options),
		updateAction: (update) => this.updateAction(update),
	};

	private activeAttachment: (RpcHostActionBridgeAttachment & { id: number }) | undefined;
	private nextAttachmentId = 0;
	private readonly pendingRequests = new Map<string, PendingRpcHostActionRequest>();

	attach(attachment: RpcHostActionBridgeAttachment): () => void {
		const activeAttachment = { ...attachment, id: ++this.nextAttachmentId };
		this.activeAttachment = activeAttachment;
		return () => {
			if (this.activeAttachment?.id === activeAttachment.id) {
				this.activeAttachment = undefined;
			}
		};
	}

	getPendingRequests(): RpcHostActionRequest[] {
		return Array.from(this.pendingRequests.values()).map((entry) => entry.request);
	}

	cancelAll(message = "RPC mode is shutting down"): void {
		const requests = Array.from(this.pendingRequests.values());
		for (const request of requests) {
			this.settle(request, { decision: "dismissed", message });
		}
	}

	resolveResponse(response: RpcHostActionResponse & { decision: HostActionDecision["decision"] }): void {
		const pending = this.pendingRequests.get(response.id);
		if (pending) {
			this.settle(pending, { decision: response.decision, message: response.message });
		}
	}

	private requestAction(
		request: HostActionRequest,
		requestOptions?: { signal?: AbortSignal },
	): Promise<HostActionDecision> {
		const activeAttachment = this.activeAttachment;
		if (activeAttachment?.isShuttingDown()) {
			return Promise.resolve({ decision: "dismissed" });
		}
		if (!activeAttachment?.canSend()) {
			return Promise.resolve({ decision: "unavailable" });
		}
		if (requestOptions?.signal?.aborted) {
			return Promise.resolve({ decision: "dismissed" });
		}

		return new Promise((resolve) => {
			const existing = this.pendingRequests.get(request.id);
			if (existing) {
				this.settle(existing, { decision: "dismissed", message: "Host action replaced" });
			}

			const rpcRequest: RpcHostActionRequest = { type: "host_action_request", ...request };
			let entry: PendingRpcHostActionRequest;
			const onAbort = (): void => {
				this.settle(entry, { decision: "dismissed", message: "Host action cancelled" });
			};
			entry = {
				request: rpcRequest,
				resolve,
				settled: false,
				signal: requestOptions?.signal,
				onAbort,
			};
			requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
			if (request.timeoutMs !== undefined) {
				entry.timeoutId = setTimeout(() => {
					this.settle(entry, { decision: "dismissed", message: "Host action timed out" });
				}, request.timeoutMs);
				entry.timeoutId.unref?.();
			}
			this.pendingRequests.set(request.id, entry);
			activeAttachment.output(rpcRequest);
		});
	}

	private updateAction(update: HostActionUpdate): void {
		const activeAttachment = this.activeAttachment;
		if (activeAttachment?.canSend()) {
			activeAttachment.output({ type: "host_action_update", ...update });
		}
	}

	private settle(entry: PendingRpcHostActionRequest, decision: HostActionDecision): void {
		if (entry.settled) {
			return;
		}
		entry.settled = true;
		if (entry.timeoutId) {
			clearTimeout(entry.timeoutId);
		}
		entry.signal?.removeEventListener("abort", entry.onAbort);
		this.pendingRequests.delete(entry.request.id);
		entry.resolve(decision);
	}
}

const rpcHostActionBridges = new WeakMap<AgentSessionRuntime, RpcHostActionBridge>();

function getRpcHostActionBridge(runtimeHost: AgentSessionRuntime): RpcHostActionBridge {
	let bridge = rpcHostActionBridges.get(runtimeHost);
	if (!bridge) {
		bridge = new RpcHostActionBridge();
		rpcHostActionBridges.set(runtimeHost, bridge);
	}
	return bridge;
}

interface RpcSubagentEntry {
	handle: SubagentHandle;
	projector: StreamProjector;
	projectorEnded: boolean;
	unsubscribe: () => void;
	disposed: boolean;
}

function toRpcSubagentDefinition(definition: SubagentDefinition): RpcSubagentDefinition {
	return {
		name: definition.name,
		description: definition.description,
		source: definition.source,
		sourceInfo: {
			source: definition.sourceInfo.source,
			scope: definition.sourceInfo.scope,
			origin: definition.sourceInfo.origin,
		},
		...(definition.tools ? { tools: definition.tools } : {}),
		...(definition.excludedTools ? { excludedTools: definition.excludedTools } : {}),
		...(definition.allowedSubagents ? { allowedSubagents: definition.allowedSubagents } : {}),
		...(definition.maxSubagentDepth !== undefined ? { maxSubagentDepth: definition.maxSubagentDepth } : {}),
		...(definition.maxChildAgents !== undefined ? { maxChildAgents: definition.maxChildAgents } : {}),
		...(definition.model ? { model: definition.model } : {}),
		...(definition.thinking ? { thinking: definition.thinking } : {}),
	};
}

class RpcSubagentLifecycle implements RpcSubagentLifecycleController {
	private readonly getSession: () => AgentSession;
	private readonly output: (event: object) => void;
	private readonly createProjector: () => StreamProjector;
	private readonly reportProjectionDiagnostics: (source: string, diagnostics: readonly ProjectionDiagnostic[]) => void;
	private readonly active = new Map<string, RpcSubagentEntry>();

	constructor(options: {
		getSession: () => AgentSession;
		output: (event: object) => void;
		createProjector: () => StreamProjector;
		reportProjectionDiagnostics: (source: string, diagnostics: readonly ProjectionDiagnostic[]) => void;
	}) {
		this.getSession = options.getSession;
		this.output = options.output;
		this.createProjector = options.createProjector;
		this.reportProjectionDiagnostics = options.reportProjectionDiagnostics;
	}

	list(): RpcListSubagentsResponse {
		return {
			subagents: this.getSession().resourceLoader.getSubagents().definitions.map(toRpcSubagentDefinition),
		};
	}

	async start(agent: string, prompt: string): Promise<RpcSubagentStartResponse> {
		const session = this.getSession();
		const manager = session.getSubagentToolManager();
		if (!manager) {
			throw new Error("Subagent manager is not available");
		}

		const handle = await manager.startByName(agent, { allowedTools: session.getActiveToolNames() });
		let entry: RpcSubagentEntry | undefined;
		const projector = this.createProjector();
		const unsubscribe = handle.onEvent((event) => {
			if (entry?.disposed) {
				return;
			}
			const batch = projector.push(event);
			this.reportProjectionDiagnostics(`subagent:${handle.id}`, batch.diagnostics);
			for (const frame of batch.frames) {
				this.output({ type: "subagent_event", subagentId: handle.id, event: frame });
			}
		});
		entry = { handle, projector, projectorEnded: false, unsubscribe, disposed: false };
		this.active.set(handle.id, entry);
		void handle.waitForEnd().then(
			(result) => {
				if (!entry?.disposed) {
					this.endProjector(handle.id, entry);
					this.output({ type: "subagent_end", subagentId: handle.id, result });
				}
			},
			(error: unknown) => {
				if (!entry?.disposed) {
					console.error(`[rpc-subagent:${handle.id}] stream failed`, error);
					void this.disposeEntry(handle.id, entry).catch((disposeError: unknown) => {
						console.error(`[rpc-subagent:${handle.id}] failed to dispose rejected stream`, disposeError);
					});
				}
			},
		);

		try {
			await handle.prompt(prompt);
		} catch (error) {
			await this.disposeEntry(handle.id, entry).catch(() => undefined);
			throw error;
		}

		return { subagentId: handle.id, sessionId: handle.sessionId };
	}

	async abort(subagentId: string): Promise<void> {
		const entry = this.getEntry(subagentId);
		try {
			await entry.handle.abort("remote_request");
		} finally {
			await this.disposeEntry(subagentId, entry);
		}
	}

	async getState(subagentId: string): Promise<RpcSessionState> {
		return this.getEntry(subagentId).handle.getState();
	}

	async getTranscript(options: {
		subagentId: string;
		limit?: number;
		beforeEntryId?: string;
	}): Promise<RpcTranscriptResponse> {
		return this.getEntry(options.subagentId).handle.getTranscript({
			limit: options.limit,
			beforeEntryId: options.beforeEntryId,
		});
	}

	async dispose(subagentId: string): Promise<void> {
		await this.disposeEntry(subagentId, this.getEntry(subagentId));
	}

	async disposeAll(): Promise<void> {
		const entries = Array.from(this.active.entries());
		await Promise.all(
			entries.map(([subagentId, entry]) => this.disposeEntry(subagentId, entry).catch(() => undefined)),
		);
	}

	private getEntry(subagentId: string): RpcSubagentEntry {
		const entry = this.active.get(subagentId);
		if (!entry || entry.disposed) {
			throw new Error(`Subagent ${subagentId} is not active`);
		}
		return entry;
	}

	private async disposeEntry(subagentId: string, entry: RpcSubagentEntry): Promise<void> {
		if (entry.disposed) {
			return;
		}
		entry.disposed = true;
		this.active.delete(subagentId);
		entry.unsubscribe();
		this.endProjector(subagentId, entry);
		// Terminal frame for every disposal path (abort/dispose commands, failed
		// starts, session rebinds). Nothing else fires for host-side disposals, and
		// without a terminal frame clients would retain this subagent stream's
		// message-delta accumulator forever. output() no-ops during shutdown.
		this.output({ type: "subagent_disposed", subagentId });
		await entry.handle.dispose();
	}

	private endProjector(subagentId: string, entry: RpcSubagentEntry): void {
		if (entry.projectorEnded) {
			return;
		}
		entry.projectorEnded = true;
		this.reportProjectionDiagnostics(`subagent:${subagentId}`, entry.projector.endStream().diagnostics);
	}
}

/**
 * Run in RPC mode.
 * Listens for JSON commands from the transport, outputs events and responses to it.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<void> {
	if (!options.transport) {
		takeOverStdout();
	}
	const shouldExitProcess = options.exitProcess ?? !options.transport;
	const shouldDisposeRuntimeOnClose = options.disposeRuntimeOnClose ?? true;
	const allowUiActionInvocation = options.allowUiActionInvocation ?? true;
	const requireRemoteSafeUiActions = options.requireRemoteSafeUiActions ?? false;
	const shouldRestoreStdout = !options.transport && !shouldExitProcess;
	const transport = options.transport ?? createStdioRpcTransport();
	const startupAwareTransport = transport as RpcModeStartupAwareTransport;
	startupAwareTransport.setRpcModeStartupComplete?.(false);
	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const pendingWrites = new Set<Promise<void>>();
	let hasPendingWriteError = false;
	let pendingWriteError: unknown;
	let transportFailureShutdownScheduled = false;
	const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
	const recordPendingWriteError = (error: unknown): Error => {
		const writeError = toError(error);
		if (!hasPendingWriteError) {
			hasPendingWriteError = true;
			pendingWriteError = writeError;
		}
		return writeError;
	};
	const requestTransportFailureShutdown = (error: unknown): void => {
		const writeError = recordPendingWriteError(error);
		if (shuttingDown || transportFailureShutdownScheduled) {
			return;
		}
		transportFailureShutdownScheduled = true;
		// Defer so in-flight backpressure waits can report the same failure first.
		setImmediate(() => {
			transportFailureShutdownScheduled = false;
			if (shuttingDown) {
				return;
			}
			void shutdown(1, undefined, { error: writeError }).catch(() => {});
		});
	};
	const trackTransportWrite = (result: void | Promise<void>): void => {
		if (!result) {
			return;
		}
		const tracked = Promise.resolve(result)
			.catch((error: unknown) => {
				requestTransportFailureShutdown(error);
			})
			.finally(() => {
				pendingWrites.delete(tracked);
			});
		pendingWrites.add(tracked);
	};
	const waitForTransportBackpressure = async (): Promise<void> => {
		while (pendingWrites.size > 0) {
			await Promise.all(pendingWrites);
		}
		if (hasPendingWriteError) {
			const error = pendingWriteError;
			hasPendingWriteError = false;
			pendingWriteError = undefined;
			throw toError(error);
		}
		await transport.waitForBackpressure?.();
	};
	let session = runtimeHost.session;
	let lastNotifiedSession: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let sessionProjector: StreamProjector | undefined;
	let stopModelCatalogWatcher: () => void = () => {};

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		if (shuttingDown || hasPendingWriteError) {
			return;
		}
		try {
			trackTransportWrite(
				options.orderedConversation ? options.orderedConversation.enqueueControl(obj) : transport.write(obj),
			);
		} catch (writeError: unknown) {
			requestTransportFailureShutdown(writeError);
		}
	};
	const createStreamProjector = options.createStreamProjector ?? (() => new StreamProjector());
	const subscriptionUsageService = new SubscriptionUsageService();
	const reportProjectionDiagnostics = (source: string, diagnostics: readonly ProjectionDiagnostic[]): void => {
		for (const diagnostic of diagnostics) {
			console.error(`[stream-projection:${source}] ${diagnostic.code}: ${diagnostic.message}`, diagnostic);
		}
	};
	const rpcSubagents = new RpcSubagentLifecycle({
		getSession: () => session,
		output,
		createProjector: createStreamProjector,
		reportProjectionDiagnostics,
	});
	const endSessionProjector = (): void => {
		if (!sessionProjector) {
			return;
		}
		reportProjectionDiagnostics("rpc-session", sessionProjector.endStream().diagnostics);
		sessionProjector = undefined;
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: RpcExtensionUIResponse) => void; cancel: () => void }
	>();

	const cancelPendingExtensionRequests = (): void => {
		const requests = Array.from(pendingExtensionRequests.values());
		pendingExtensionRequests.clear();
		for (const request of requests) {
			request.cancel();
		}
	};

	let clientCapabilities = new Set<RpcClientCapabilityFeature>();
	const hostActionBridge = getRpcHostActionBridge(runtimeHost);
	const detachHostActionBridge = hostActionBridge.attach({
		canSend: () => !shuttingDown && clientCapabilities.has(HOST_ACTION_REQUESTS_CAPABILITY),
		isShuttingDown: () => shuttingDown,
		output: (message) => output(message),
	});

	const cancelPendingHostActionRequests = (message = "RPC mode is shutting down"): void => {
		hostActionBridge.cancelAll(message);
	};
	const retireConversationControlCapabilities = (): void => {
		cancelPendingExtensionRequests();
		cancelPendingHostActionRequests("Conversation authority changed");
	};
	const detachOrderedAuthorityChanges = options.orderedConversation?.subscribeAuthorityChanges(() => {
		retireConversationControlCapabilities();
	});
	let unsubscribeConversationGenerationChanges: (() => void) | undefined;
	let hasBoundConversationSession = false;

	const setSessionHostInteraction = (targetSession: AgentSession): void => {
		const sessionWithHostInteraction = targetSession as {
			setHostInteraction?: (hostInteraction: HostInteraction) => void;
		};
		sessionWithHostInteraction.setHostInteraction?.(hostActionBridge.interaction);
	};

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted || shuttingDown) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				cancel: () => {
					cleanup();
					resolve(defaultValue);
				},
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			if (shuttingDown) {
				return undefined;
			}

			const id = crypto.randomUUID();
			return new Promise((resolve) => {
				const cleanup = () => {
					pendingExtensionRequests.delete(id);
				};
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						cleanup();
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					cancel: () => {
						cleanup();
						resolve(undefined);
					},
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return getAvailableThemesWithPaths();
		},

		getTheme(name: string) {
			return getThemeByName(name);
		},

		setTheme(themeOrName: string | Theme) {
			// Applies to this process's theme instance and persists the choice; a
			// daemon host observes the change and broadcasts a theme_snapshot. No
			// hot-reload watcher in rpc mode (that is the rendering TUI's job).
			if (themeOrName instanceof Theme) {
				setThemeInstance(themeOrName);
				return { success: true };
			}
			const result = setTheme(themeOrName, false);
			if (result.success && session.settingsManager.getTheme() !== themeOrName) {
				session.settingsManager.setTheme(themeOrName);
			}
			return result;
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// When a phone relays through a running TUI the SAME runtimeHost is shared and
	// survives this mode (shouldDisposeRuntimeOnClose === false). Capture the TUI's
	// own rebind handler so it can be restored on exit; otherwise the TUI's session
	// changes would keep running this RPC-mode handler after the phone disconnects.
	const previousRebindSession = runtimeHost.getRebindSession?.();
	const detachSessionWillProject = runtimeHost.subscribeSessionWillProject?.(() => {
		retireConversationControlCapabilities();
	});
	const detachSessionReplacement = runtimeHost.subscribeSessionReplaced?.(async () => {
		await rebindSession();
	});
	if (!detachSessionReplacement) {
		runtimeHost.setRebindSession(async () => {
			await rebindSession();
		});
	}
	const restoreRebindSession = (): void => {
		detachSessionReplacement?.();
		detachSessionWillProject?.();
		detachOrderedAuthorityChanges?.();
		unsubscribeConversationGenerationChanges?.();
		unsubscribeConversationGenerationChanges = undefined;
		if (!detachSessionReplacement && !shouldDisposeRuntimeOnClose) {
			runtimeHost.setRebindSession(previousRebindSession);
		}
	};

	const notifySessionChanged = async (): Promise<void> => {
		// Fire on a new session OBJECT, not just a new sessionId. A same-file
		// drain/reacquire reload produces a fresh AgentSession with the identical
		// sessionId; consumers (notably the iroh transcript-entry subscription)
		// must rekey to the new object or they stay bound to the
		// disposed one and silently stop delivering. Same-id consumers no-op safely.
		if (options.onSessionChanged && session !== lastNotifiedSession) {
			lastNotifiedSession = session;
			await options.onSessionChanged({ sessionFile: session.sessionFile, sessionId: session.sessionId });
		}
	};

	const rebindSession = async (): Promise<void> => {
		// Correlated control replies are capabilities over the conversation state
		// that minted them. Retire them before a replacement binds extensions, and
		// bind the same synchronous cut to every in-session branch generation.
		if (hasBoundConversationSession) {
			retireConversationControlCapabilities();
		}
		unsubscribeConversationGenerationChanges?.();
		unsubscribeConversationGenerationChanges = undefined;
		await rpcSubagents.disposeAll();
		session = runtimeHost.session;
		const sessionWithConversationGeneration = session as AgentSession & {
			subscribeConversationGenerationChanges?: (listener: () => void) => () => void;
		};
		unsubscribeConversationGenerationChanges =
			sessionWithConversationGeneration.subscribeConversationGenerationChanges?.(() => {
				retireConversationControlCapabilities();
			});
		hasBoundConversationSession = true;
		if (shuttingDown) {
			await notifySessionChanged();
			return;
		}
		setSessionHostInteraction(session);
		// Extension-provided themes resolve by name in rpc mode too (getAllThemes /
		// getTheme / setTheme), mirroring the TUI's registration at bind time.
		const resourceThemes = session.resourceLoader?.getThemes?.().themes;
		if (resourceThemes) {
			setRegisteredThemes(resourceThemes);
		}
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled, seeded: result.seeded };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});
		if (shuttingDown) return;
		await notifySessionChanged();

		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeBackpressure?.();
		unsubscribeBackpressure = undefined;
		endSessionProjector();
		if (!options.orderedConversation) {
			sessionProjector = createStreamProjector();
			unsubscribe = session.subscribe((event) => {
				const batch = sessionProjector?.push(event);
				if (!batch) {
					return;
				}
				reportProjectionDiagnostics("rpc-session", batch.diagnostics);
				for (const frame of batch.frames) {
					output(frame);
				}
			});
			unsubscribeBackpressure = session.subscribeRuntimeEvents(async () => {
				try {
					await waitForTransportBackpressure();
				} catch (transportError: unknown) {
					requestTransportFailureShutdown(transportError);
				}
			});
		}
	};

	// Detached review workflow events reach ordered-conversation clients through
	// the runtime conversation projection feed (published by the manager itself,
	// which outlives this mode instance). This per-mode sink only serves the
	// direct stdio output path and the host's onWorkflowEvent observer.
	const detachReviewWorkflowSink =
		runtimeHost.reviewWorkflows?.attachSink((event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void => {
			try {
				const result = options.onWorkflowEvent?.(event);
				if (result) {
					void Promise.resolve(result).catch(() => {});
				}
			} catch (error) {
				void error;
			}
			if (!options.orderedConversation) {
				output(event);
			}
		}) ?? (() => {});
	// Per-mode review sinks outlive shutdown while workflows this client may be
	// waiting on are still running; the runtime-scoped manager keeps executing
	// them after the transport detaches (disposal aborts them instead).
	const retireReviewWorkflowSink = (): void => {
		const reviewWorkflows = runtimeHost.reviewWorkflows;
		if (!reviewWorkflows?.hasActiveWorkflows) {
			detachReviewWorkflowSink();
			return;
		}
		void reviewWorkflows.waitForIdle().then(detachReviewWorkflowSink, detachReviewWorkflowSink);
	};

	// Review workflows registered by invoke_ui_action but not yet executing; the
	// dispatcher launches them after the accepted response is enqueued so the
	// response deterministically precedes workflow_start on the shared lane.
	const pendingReviewWorkflows = new Map<string, { launch: () => void; cancel: () => void }>();

	const createHostActionContext = (
		commandSession: AgentSession = session,
		assertConversationGenerationCurrent?: () => void,
	): HostActionInvocationContext => ({
		session: commandSession,
		detachedReviews: true,
		abortRun: () => commandSession.abort("remote_request"),
		compactContext: (customInstructions) =>
			commandSession.compact(customInstructions, assertConversationGenerationCurrent),
		newSession: (newSessionOptions) =>
			runtimeHost.newSession({ ...newSessionOptions, assertConversationGenerationCurrent }),
		afterSessionSwitch: rebindSession,
		renameSession: (name) => {
			commandSession.setSessionName(name);
		},
		setFastModeEnabled: (enabled) => {
			commandSession.setFastModeEnabled(enabled);
		},
		setAgentMode: (mode) => {
			assertConversationGenerationCurrent?.();
			return commandSession.setAgentMode(mode);
		},
		executePlan: (planId, expectedRevision, strategy) =>
			runtimeHost.executePlan(planId, expectedRevision, strategy, assertConversationGenerationCurrent),
		changePlan: (planId, expectedRevision) => {
			assertConversationGenerationCurrent?.();
			return commandSession.changePlan(planId, expectedRevision);
		},
		discardPlan: (planId, expectedRevision) => {
			assertConversationGenerationCurrent?.();
			return commandSession.discardPlan(planId, expectedRevision);
		},
		runReviewAction: async (target, reviewOptions) => {
			// Detached review: run the fast preflight inline so target errors fail
			// the invocation synchronously, then register the execution with the
			// runtime-scoped manager and return an accepted response immediately.
			// Confirmation is client-side (the descriptors advertise
			// requiresConfirmation); there is no server confirm round-trip.
			const prepared = await prepareReviewWorkflow({
				target,
				controls: reviewOptions.controls,
				...(reviewOptions.parentRunId ? { parentRunId: reviewOptions.parentRunId } : {}),
				cwd: runtimeHost.cwd,
				settingsManager: commandSession.settingsManager,
				modelRegistry: commandSession.modelRegistry,
				currentModel: commandSession.model,
				sessionManager: commandSession.sessionManager,
				requireProjectTrust: reviewOptions.remote,
				sanitizeRemoteErrors: reviewOptions.remote,
			});
			const thinkingLevel = commandSession.thinkingLevel;
			const fastModeEnabled = commandSession.fastModeEnabled;
			const authStorage = commandSession.modelRegistry.authStorage;
			const modelRegistry = commandSession.modelRegistry;
			const settingsManager = commandSession.settingsManager;
			let started: ReturnType<typeof runtimeHost.reviewWorkflows.start>;
			try {
				started = runtimeHost.reviewWorkflows.start({
					prepared,
					fastModeEnabled,
					execute: async (hooks) => {
						try {
							const result = await executeReviewWorkflow({
								prepared,
								cwd: runtimeHost.cwd,
								agentDir: runtimeHost.services.agentDir,
								authStorage,
								modelRegistry,
								settingsManager,
								sessionManager: commandSession.sessionManager,
								sanitizeRemoteErrors: reviewOptions.remote,
								thinkingLevel,
								fastModeEnabled,
								// Immutable snapshot tools are always installed by the review host;
								// remote reviews receive no workspace or command-capable tools.
								tools: REMOTE_REVIEW_TOOL_NAMES,
								signal: hooks.signal,
								onEvent: hooks.onEvent,
							});
							if (reviewOptions.remote && result.status === "failed") {
								return { status: "failed", errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
							}
							return result;
						} catch (error) {
							if (reviewOptions.remote) {
								return { status: "failed", errorMessage: REMOTE_REVIEW_FAILURE_MESSAGE };
							}
							throw error;
						}
					},
				});
			} catch (error) {
				await prepared.resolution.dispose();
				throw error;
			}
			const { descriptor, launch } = started;
			let launched = false;
			pendingReviewWorkflows.set(descriptor.workflowId, {
				launch: () => {
					launched = true;
					launch();
				},
				cancel: () => {
					if (!launched) {
						appendReviewRun(
							commandSession.sessionManager,
							createReviewRunRecord({
								workflowId: prepared.workflowId,
								workflowAction: prepared.action,
								startedAt: prepared.startedAt,
								snapshot: prepared.resolution,
								controls: prepared.controls,
								status: "cancelled",
								incrementalPlan: prepared.incrementalPlan,
							}),
						);
					}
					runtimeHost.reviewWorkflows.cancel(descriptor.workflowId);
				},
			});
			return {
				status: "accepted",
				workflowId: descriptor.workflowId,
				...(prepared.modelWarning === undefined || reviewOptions.remote ? {} : { message: prepared.modelWarning }),
			};
		},
		runReviewLifecycleAction: async (action, args) => {
			const runId = typeof args.runId === "string" ? args.runId : undefined;
			const record = runId ? getReviewRun(commandSession.sessionManager, runId) : undefined;
			if (action !== REVIEW_EXPORT_FEEDBACK_ACTION_ID && !record)
				throw new Error(`Unknown durable review run: ${runId ?? "missing"}`);
			if (action === REVIEW_FIX_ACTION_ID) {
				if (!record?.result) throw new Error(`Review run has no findings result: ${runId}`);
				const requestedFindingIds =
					typeof args.findingIds === "string" && args.findingIds.trim().length > 0
						? args.findingIds
								.split(",")
								.map((value) => value.trim())
								.filter(Boolean)
						: undefined;
				const requestedIds = requestedFindingIds ?? record.result.findings.map((finding) => finding.id);
				const selectedIds = new Set(requestedIds);
				const unknown = requestedIds.filter(
					(findingId) => !record.result?.findings.some((finding) => finding.id === findingId),
				);
				if (unknown.length > 0) throw new Error(`Unknown finding ids: ${unknown.join(", ")}`);
				const selectedResult = {
					...record.result,
					findings: record.result.findings.filter((finding) => selectedIds.has(finding.id)),
				};
				const sourceSessionManager = commandSession.sessionManager;
				const seedMessage = createReviewSeedMessage(record.target, { parsed: selectedResult });
				let targetSessionManager: SessionManager | undefined;
				let acknowledgedAt: number | undefined;
				const opened = await runtimeHost.newSession({
					assertConversationGenerationCurrent,
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
				if (!opened.cancelled && !opened.seeded)
					throw new Error("The review session opened without the selected findings.");
				if (opened.seeded && requestedFindingIds === undefined) {
					if (acknowledgedAt === undefined) throw new Error("Review session was seeded without acknowledgment");
					const sourceSessionFile = sourceSessionManager.getSessionFile();
					const acknowledgmentManager = sourceSessionFile
						? SessionManager.open(sourceSessionFile, sourceSessionManager.getSessionDir())
						: sourceSessionManager;
					acknowledgeReviewRun(acknowledgmentManager, record.runId, acknowledgedAt);
					await acknowledgmentManager.flush();
					if (sourceSessionFile) sourceSessionManager.setSessionFile(sourceSessionFile);
				}
				return {
					action,
					status: opened.cancelled ? "cancelled" : "completed",
					stateChanged: !opened.cancelled,
					actionsChanged: !opened.cancelled,
					message: opened.cancelled
						? "Review fix session cancelled"
						: `Opened ${selectedResult.findings.length} selected review findings`,
				};
			}
			if (action === REVIEW_FEEDBACK_ACTION_ID) {
				if (!record?.result) throw new Error(`Review run has no findings result: ${runId}`);
				const findingId = typeof args.findingId === "string" ? args.findingId : "";
				if (!record.result.findings.some((finding) => finding.id === findingId))
					throw new Error(`Unknown finding: ${findingId}`);
				const status = args.status;
				if (status !== "accepted" && status !== "fixed" && status !== "dismissed")
					throw new Error("Review outcome must be accepted, fixed, or dismissed.");
				const reason = args.reason;
				if (
					status === "dismissed" &&
					reason !== "false_positive" &&
					reason !== "intentional" &&
					reason !== "not_actionable" &&
					reason !== "other"
				)
					throw new Error("Dismissed findings require an explicit reason.");
				appendReviewFindingTransition(commandSession.sessionManager, {
					runId: record.runId,
					findingId,
					status,
					...(reason === "false_positive" ||
					reason === "intentional" ||
					reason === "not_actionable" ||
					reason === "other"
						? { reason }
						: {}),
					...(typeof args.note === "string" ? { note: args.note } : {}),
				});
				await commandSession.sessionManager.flush();
				return {
					action,
					status: "completed",
					stateChanged: true,
					actionsChanged: true,
					message: `Finding ${findingId} marked ${status}`,
				};
			}
			if (action === REVIEW_RERUN_ACTION_ID) {
				if (!record) throw new Error(`Unknown durable review run: ${runId}`);
				const identity = record.target.identity;
				const target =
					identity.kind === "uncommitted"
						? { kind: "uncommitted" as const }
						: identity.kind === "branch"
							? { kind: "branch" as const, base: identity.baseCommit }
							: identity.kind === "pr"
								? {
										kind: "pr" as const,
										number: identity.pullRequest ? String(identity.pullRequest.number) : undefined,
									}
								: { kind: "commit" as const, sha: identity.headCommit };
				const rerun = await createHostActionContext(
					commandSession,
					assertConversationGenerationCurrent,
				).runReviewAction?.(target, {
					remote: true,
					requireConfirmation: true,
					controls: { ...record.options, scopeMode: args.scopeMode === "full" ? "full" : "incremental" },
					parentRunId: record.runId,
				});
				if (rerun?.status !== "accepted")
					return { action, status: "cancelled", message: "Review rerun was not accepted" };
				return {
					action,
					status: "accepted",
					workflowId: rerun.workflowId,
					actionsChanged: true,
					message: "Review rerun accepted",
				};
			}
			if (action === REVIEW_PUBLISH_ACTION_ID) {
				if (!record) throw new Error(`Unknown durable review run: ${runId}`);
				const published = await publishReviewRun(commandSession.sessionManager.getCwd(), record);
				appendReviewPublication(commandSession.sessionManager, { runId: record.runId, ...published });
				await commandSession.sessionManager.flush();
				return {
					action,
					status: "completed",
					message: published.url ? `Review published: ${published.url}` : "Review published",
				};
			}
			if (action === REVIEW_EXPORT_FEEDBACK_ACTION_ID) {
				if (typeof args.path !== "string" || !args.path.trim())
					throw new Error("RPC review feedback export requires an explicit local path.");
				const outputPath = resolve(commandSession.sessionManager.getCwd(), args.path.trim());
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(
					outputPath,
					`${JSON.stringify(exportReviewFeedback(commandSession.sessionManager), null, 2)}\n`,
					{ mode: 0o600 },
				);
				return { action, status: "completed", message: `Review feedback exported to ${outputPath}` };
			}
			throw new Error(`Unsupported review lifecycle action: ${action}`);
		},
	});

	const createRpcCommandContext = (command: RpcCommand, commandSession: AgentSession = session) => {
		const assertConversationGenerationCurrent = () => assertConversationAuthority(command, commandSession);
		return {
			session: commandSession,
			runtimeHost,
			options: {
				allowUiActionInvocation,
				requireRemoteSafeUiActions,
				registerPushTarget: options.registerPushTarget,
			},
			output,
			rebindSession,
			createHostActionContext: () => createHostActionContext(commandSession, assertConversationGenerationCurrent),
			setClientCapabilities(features: RpcClientCapabilityFeature[]): void {
				clientCapabilities = new Set(
					features.filter((feature): feature is RpcClientCapabilityFeature => typeof feature === "string"),
				);
				options.onClientCapabilitiesChanged?.(Array.from(clientCapabilities));
			},
			async reportStreamDiscontinuity(command: Extract<RpcCommand, { type: "report_stream_discontinuity" }>) {
				const orderedConversation = options.orderedConversation;
				if (!orderedConversation) {
					throw new Error("Ordered conversation recovery is unavailable on this RPC transport");
				}
				if (command.sessionId !== commandSession.sessionId) {
					throw new Error(`Stale conversation session: ${command.sessionId}`);
				}
				if (command.subscriptionId !== orderedConversation.subscriptionId) {
					throw new Error(`Stale conversation subscription: ${command.subscriptionId}`);
				}
				return orderedConversation.requestCheckpoint(command);
			},
			getPendingHostActionRequests: () => hostActionBridge.getPendingRequests(),
			cancelPendingHostActionRequests,
			assertConversationGenerationCurrent,
			subscriptionUsageService,
			takePendingReviewWorkflow: (workflowId: string) => {
				const pending = pendingReviewWorkflows.get(workflowId);
				pendingReviewWorkflows.delete(workflowId);
				return pending;
			},
			subagents: rpcSubagents,
		};
	};

	const assertConversationAuthority = (command: RpcCommand, commandSession: AgentSession): void => {
		if (!options.requireConversationAuthority || !RPC_CONVERSATION_AUTHORITY_MUTATION_TYPES.has(command.type)) {
			return;
		}
		const authority = command.conversationAuthority;
		const orderedConversation = options.orderedConversation;
		if (
			!authority ||
			!orderedConversation ||
			authority.sessionId !== commandSession.sessionId ||
			authority.subscriptionId !== orderedConversation.subscriptionId ||
			authority.branchEpoch !== orderedConversation.branchEpoch
		) {
			throw new StaleConversationAuthorityError();
		}
	};

	let detachInput = () => {};
	let detachClose = () => {};
	let resolveModeClosed: (() => void) | undefined;
	let rejectModeClosed: ((error: unknown) => void) | undefined;
	const modeClosed = new Promise<void>((resolve, reject) => {
		resolveModeClosed = resolve;
		rejectModeClosed = reject;
	});
	let shutdownPromise: Promise<void> | undefined;
	let commandQueue: Promise<void> = Promise.resolve();
	let pendingInputTaskCount = 0;
	const commandTaskContext = new AsyncLocalStorage<boolean>();

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	const cleanupStartupFailure = async (): Promise<void> => {
		shuttingDown = true;
		try {
			restoreRebindSession();
			stopModelCatalogWatcher();
			cancelPendingExtensionRequests();
			detachHostActionBridge();
			detachReviewWorkflowSink();
			await rpcSubagents.disposeAll();
			pendingReviewWorkflows.clear();
			if (shouldDisposeRuntimeOnClose) {
				cancelPendingHostActionRequests();
			}
			for (const cleanup of signalCleanupHandlers) {
				cleanup();
			}
			unsubscribe?.();
			endSessionProjector();
			unsubscribeBackpressure?.();
			if (shouldDisposeRuntimeOnClose) {
				await runtimeHost.dispose();
			}
			detachInput();
			detachClose();
		} finally {
			try {
				await transport.close();
			} finally {
				if (shouldRestoreStdout) {
					restoreStdout();
				}
			}
		}
	};

	let startupComplete = false;
	let startupAbortError: Error | undefined;
	const queuedStartupCommands: unknown[] = [];

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	function shutdown(exitCode = 0, signal?: NodeJS.Signals, failure?: { error: unknown }): Promise<void> {
		const invokedFromCommandTask = commandTaskContext.getStore() === true;
		if (!startupComplete) {
			void modeClosed.catch(() => {});
			if (!startupAbortError) {
				if (failure) {
					startupAbortError = toError(failure.error);
				} else if (signal) {
					startupAbortError = new Error(`RPC mode shut down during startup by ${signal}`);
				} else {
					startupAbortError = new Error("RPC mode shut down during startup");
				}
			}
		}
		stopModelCatalogWatcher();
		cancelPendingExtensionRequests();
		detachHostActionBridge();
		retireReviewWorkflowSink();
		if (shouldDisposeRuntimeOnClose) {
			cancelPendingHostActionRequests();
		}
		if (shuttingDown) {
			return invokedFromCommandTask ? Promise.resolve() : (shutdownPromise ?? modeClosed);
		}
		shuttingDown = true;
		shutdownPromise = (async () => {
			try {
				let hasShutdownError = failure !== undefined;
				let shutdownError: unknown = failure?.error;
				try {
					// Stop admitting input first, then let every command that already
					// owns a bounded queue slot either finish or observe shuttingDown and
					// cancel. Runtime/session teardown is only safe after that barrier.
					detachInput();
					detachClose();
					await commandQueue;
					restoreRebindSession();
					for (const cleanup of signalCleanupHandlers) {
						cleanup();
					}
					unsubscribe?.();
					endSessionProjector();
					unsubscribeBackpressure?.();
					await rpcSubagents.disposeAll();
					if (shouldDisposeRuntimeOnClose) {
						await runtimeHost.dispose();
					}
					if (signal !== "SIGTERM" && !hasShutdownError) {
						await waitForTransportBackpressure();
						await transport.flush?.();
					}
				} catch (error: unknown) {
					if (!hasShutdownError) {
						hasShutdownError = true;
						shutdownError = error;
					}
				} finally {
					try {
						await transport.close();
					} catch (closeError: unknown) {
						if (!hasShutdownError) {
							hasShutdownError = true;
							shutdownError = closeError;
						}
					}
					if (shouldRestoreStdout) {
						restoreStdout();
					}
				}
				if (hasShutdownError) {
					throw shutdownError;
				}
				if (shouldExitProcess) {
					process.exit(exitCode);
				}
				resolveModeClosed?.();
			} catch (shutdownError: unknown) {
				rejectModeClosed?.(shutdownError);
				throw shutdownError;
			}
		})();
		// modeClosed is the public outcome. Keep the independently running
		// finalizer observed as well when a command-task caller must return early.
		void shutdownPromise.catch(() => {});
		// A command cannot await a shutdown finalizer whose first barrier is the
		// command's own queue promise. It has initiated shutdown; returning here
		// lets that command settle so the independently owned finalizer can drain.
		return invokedFromCommandTask ? Promise.resolve() : shutdownPromise;
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleControlMessage = (parsed: unknown): boolean => {
		// Handle extension UI and host action responses during startup as well as normal operation.
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("type" in parsed)) {
			return false;
		}
		if (parsed.type === "extension_ui_response") {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return true;
		}
		if (parsed.type === "host_action_response") {
			const response = parsed as RpcHostActionResponse;
			const decision = parseHostActionResponseDecision(response.decision);
			if (decision) {
				hostActionBridge.resolveResponse({ ...response, decision });
			}
			return true;
		}
		return false;
	};

	const handleQueuedParsedInput = async (parsed: unknown): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			const target = getRpcErrorResponseTarget(parsed);
			output(createRpcErrorResponse(target.id, target.command, `Unknown command: ${target.command}`));
			await waitForTransportBackpressure();
			return;
		}

		const validationError = validateRpcCommandPayload(parsed);
		if (validationError) {
			const target = getRpcErrorResponseTarget(parsed);
			output(createRpcErrorResponse(target.id, target.command, validationError));
			await waitForTransportBackpressure();
			await checkShutdownRequested();
			return;
		}

		const command = parsed as RpcCommand;
		let response: RpcResponse | undefined;
		try {
			response = isRpcSessionInterruptionCommand(command)
				? await runtimeHost.runSessionInterruption((interruptionSession) => {
						assertConversationAuthority(command, interruptionSession);
						return handleRpcCommand(command, createRpcCommandContext(command, interruptionSession));
					})
				: await runtimeHost.runWithStableSession((stableSession) => {
						assertConversationAuthority(command, stableSession);
						return handleRpcCommand(command, createRpcCommandContext(command, stableSession));
					});
		} catch (commandError: unknown) {
			const target = getRpcErrorResponseTarget(command);
			output(createRpcErrorResponse(target.id, target.command, toError(commandError).message, commandError));
			await waitForTransportBackpressure();
			await checkShutdownRequested();
			return;
		}
		if (response && !shuttingDown) {
			output(response);
			await waitForTransportBackpressure();
		}
		await checkShutdownRequested();
	};

	const enqueueInputTask = (task: () => Promise<void>): boolean => {
		if (pendingInputTaskCount >= MAX_PENDING_RPC_INPUT_TASKS) {
			return false;
		}
		pendingInputTaskCount++;
		const runTask = (): Promise<void> =>
			commandTaskContext.run(true, async () => {
				try {
					await task();
				} catch (inputError: unknown) {
					await shutdown(1, undefined, { error: toError(inputError) }).catch(() => {});
				} finally {
					pendingInputTaskCount--;
				}
			});
		commandQueue = commandQueue.then(runTask, runTask);
		void commandQueue.catch(() => {});
		return true;
	};

	const rejectInputTaskOverflow = (): Promise<void> => {
		return shutdown(1, undefined, {
			error: new Error(`RPC input queue exceeds ${MAX_PENDING_RPC_INPUT_TASKS} tasks`),
		}).catch(() => {});
	};

	const processParsedInput = (parsed: unknown): Promise<void> => {
		if (shuttingDown) {
			return Promise.resolve();
		}
		if (handleControlMessage(parsed)) {
			return Promise.resolve();
		}

		if (!startupComplete) {
			if (queuedStartupCommands.length >= MAX_PENDING_RPC_INPUT_TASKS) {
				return rejectInputTaskOverflow();
			}
			queuedStartupCommands.push(parsed);
			return Promise.resolve();
		}

		return enqueueInputTask(() => handleQueuedParsedInput(parsed)) ? Promise.resolve() : rejectInputTaskOverflow();
	};

	const processInputLine = (line: string): Promise<void> => {
		if (shuttingDown) {
			return Promise.resolve();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			const enqueued = enqueueInputTask(async () => {
				if (shuttingDown) {
					return;
				}
				output(
					createRpcErrorResponse(
						undefined,
						"parse",
						`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					),
				);
				await waitForTransportBackpressure();
			});
			return enqueued ? Promise.resolve() : rejectInputTaskOverflow();
		}

		return processParsedInput(parsed);
	};

	detachInput = transport.onValue ? transport.onValue(processParsedInput) : transport.onLine(processInputLine);
	detachClose =
		transport.onClose?.((transportError) => {
			if (transportError) {
				void shutdown(1, undefined, { error: transportError }).catch(() => {});
				return;
			}
			if (!startupComplete) {
				void shutdown(0, undefined, { error: new Error("RPC transport closed during startup") }).catch(() => {});
				return;
			}
			void shutdown().catch(() => {});
		}) ?? (() => {});

	try {
		await rebindSession();
	} catch (startupError: unknown) {
		if (shuttingDown) {
			try {
				await shutdownPromise;
			} catch {}
			throw startupAbortError ?? startupError;
		}
		try {
			await cleanupStartupFailure();
		} catch {}
		throw startupError;
	}
	if (shuttingDown) {
		try {
			await shutdownPromise;
		} catch {}
		throw startupAbortError ?? new Error("RPC mode shut down during startup");
	}
	startupComplete = true;
	startupAwareTransport.setRpcModeStartupComplete?.(true);
	// Notify connected clients when logins or API keys saved by other volt
	// processes change the selectable model catalog on disk.
	stopModelCatalogWatcher = startModelCatalogWatcher({
		agentDir: runtimeHost.services?.agentDir,
		getModelRegistry: () => session.modelRegistry,
		onCatalogChanged: () => output({ type: "models_changed" }),
	});
	for (const parsed of queuedStartupCommands.splice(0)) {
		// These commands were admitted into the bounded pre-startup queue before
		// an async-aware transport could apply steady-state per-frame
		// backpressure. Preserve detached review workflows by scheduling them
		// onto commandQueue without holding RPC-mode startup open until a
		// long-running action ends.
		void processParsedInput(parsed);
	}
	if (shouldExitProcess) {
		registerSignalHandlers();
	}
	try {
		options.onReady?.();
	} catch (readyError: unknown) {
		void modeClosed.catch(() => {});
		await shutdown(1, undefined, { error: readyError });
		throw readyError;
	}

	// Keep RPC mode active until shutdown completes.
	return modeClosed;
}
