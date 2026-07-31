import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { extractVisibleTextContent } from "../../core/messages.ts";
import type { AgentMode, PlanPhase } from "../../core/planning.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundFilteredRpcTransport,
	createIrohRemoteProjectionSanitizer,
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteLiveActivityContentState,
	type IrohRemoteLiveActivityUpdateIntent,
	type IrohRemoteOutboundValueDecorator,
	type IrohRemotePushNotificationDelivery,
	type IrohRemotePushNotificationIntent,
	type IrohRemoteRpcGrant,
	MAX_IROH_REMOTE_LIVE_ACTIVITY_SUBJECT_UTF8_BYTES,
	sanitizeIrohRemoteOutbound,
	sanitizeIrohRemoteTranscriptText,
} from "../../core/remote/iroh/index.ts";
import {
	MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES,
	sanitizeIrohRemoteNotificationMetadata,
	sanitizeIrohRemoteNotificationTarget,
	sanitizeIrohRemoteNotificationText,
	sanitizeIrohRemoteNotificationWorkspace,
	sanitizeIrohRemotePushNotificationIntent,
} from "../../core/remote/iroh/push.ts";
import type { ReviewWorkflowEvent } from "../../core/review.ts";
import type { ReviewWorkflowResultRecord } from "../../core/review-workflows.ts";
import { getRpcErrorResponseTarget } from "../../core/rpc/correlation.ts";
import {
	type ConversationProjectionPreparedValue,
	type ConversationProjectionSnapshotBuilder,
	type ConversationProjectionSubscription,
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
	StreamProjector,
	serializeJsonLine,
} from "../../core/rpc/index.ts";
import { isRpcSessionInterruptionCommand, type RpcModeOptions, type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";
import type { RpcRegisterPushTargetResponse } from "./rpc-types.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {
	rpcGrant: IrohRemoteRpcGrant;
	/** Stable paired-client identity for Live Activity observer handoff across stream reattachment. */
	clientNodeId?: string;
	/** Stop terminally fenced ingress while preserving already-admitted ordered output. */
	isRpcIngressOpen?: () => boolean;
	/** Recheck persisted authority at each command boundary when the host owns grant state. */
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	decorateOutbound?: IrohRemoteOutboundValueDecorator;
	disposeRuntimeOnClose?: boolean;
	notificationDelivery?: IrohRemotePushNotificationDelivery;
	onClientCapabilitiesChanged?: (features: string[]) => void;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	/**
	 * Ownership barrier for replacement sessions. The runtime does not publish
	 * the new conversation generation until every attached host has rekeyed it.
	 */
	onSessionWillProject?: (session: RpcSessionChange) => void | Promise<void>;
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	onWorkflowEvent?: RpcModeOptions["onWorkflowEvent"];
	registerPushTarget?: (args: unknown) => Promise<RpcRegisterPushTargetResponse>;
	remoteCommandHandler?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	remoteWorkspacePath?: string;
	/** Drop extension_ui_request frames (relayed streams: dialogs are answered in the owning TUI). */
	suppressExtensionUiRequests?: boolean;
	workspaceName?: string;
	workspacePath: string;
	/** Extra roots (worktree parent checkout, worktrees root) redacted on every outbound frame. */
	additionalRedactedPaths?: string[];
	/** Synchronous, subscriber-authorized full conversation checkpoint builder. */
	buildConversationSnapshot: ConversationProjectionSnapshotBuilder;
	/** Project canonical runtime commits for this subscriber; null omits one. */
	projectConversationExternal: (event: object) => object | null;
	/** Installs the idempotent owner for the physical conversation stream. */
	onConversationLifecycleReady?: (lifecycle: IrohRemoteConversationLifecycle) => void;
	/** Runs only after RPC has rebound the session and completed extension/resource binding. */
	onReady?: RpcModeOptions["onReady"];
}

export interface IrohRemoteConversationLifecycle {
	write(value: object): Promise<void>;
	/** Discard queued projection output and make this the final frame. */
	writeTerminal(value: object): Promise<void>;
	terminate(): Promise<void>;
}

export type IrohRemoteNotificationKind =
	| "conversation_completed"
	| "plan_ready"
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
	workspaceName?: string;
	planId?: string;
	workflowId?: string;
}

type IrohRemoteRunTerminalOutcome = "completed" | "failed" | "aborted";

export interface IrohRemoteCompletionState {
	sessionId: string;
	runId?: string;
	terminalOutcome?: IrohRemoteRunTerminalOutcome;
	planningMode: AgentMode;
	planPhase?: PlanPhase;
	planId?: string;
	planTitle?: string;
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
	/** Bypasses outbound transformation for values already prepared by the ordered sink. */
	preparedTransport?: RpcTransport;
	getCompletionState?: () => IrohRemoteCompletionState;
	onCommandCompleted?: (completion: IrohRemoteCompletedCommand) => void | Promise<void>;
	onResponseWritten?: (response: Record<string, unknown>) => void | Promise<void>;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
	/** Claims a response at final ordered-FIFO admission. */
	admitPrepared(value: object): void;
	/** Cancels stream-local command waits and emits one synthetic clean close. */
	retire(error?: Error): void;
	writePrepared(value: object): void | Promise<void>;
}

interface IrohRemoteHostCommandRpcTransportOptions {
	handleCommand?: (command: Record<string, unknown>) => object | Promise<object | undefined> | undefined;
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	onRpcGrantStale?: () => void | Promise<void>;
	transport: RpcTransport;
	writeResponse?: (value: object) => void | Promise<void>;
}

/** Runtime/client reconciliation retains only recent terminal delivery history. */
const MAX_SENT_NOTIFICATION_EVENT_IDS = 512;
const MAX_PENDING_NOTIFICATION_EVENT_IDS = 512;

/**
 * Scalar cap for tool result text shipped to remote clients (transcript entries
 * and tool_execution_end frames). Mirrors REMOTE_TOOL_OUTPUT_MAX_SCALARS in
 * daemon/conversation-commands.ts so live events and fetched history agree.
 */
const IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS = 8_000;

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	let detachLiveActivityUpdates: (() => void) | undefined;
	let notificationDelivery: IrohRemoteNotificationDeliveryAttachment | undefined;
	let transportClosed = false;
	const attachLiveActivityUpdates = () => {
		detachLiveActivityUpdates?.();
		detachLiveActivityUpdates = attachIrohRemoteLiveActivityUpdates(
			runtimeHost,
			options.notificationDelivery,
			options.workspaceName,
			options.clientNodeId,
		);
	};
	const irohTransport = createIrohRpcTransport(options);
	const filteredOutboundTransport = createIrohRemoteOutboundFilteredRpcTransport({
		decorate: options.decorateOutbound,
		remoteWorkspacePath: options.remoteWorkspacePath,
		transport: irohTransport,
		workspacePath: options.workspacePath,
		additionalRedactedPaths: options.additionalRedactedPaths,
	});
	const streamProjectionSanitizer = createIrohRemoteProjectionSanitizer({
		remoteWorkspacePath: options.remoteWorkspacePath,
		workspacePath: options.workspacePath,
		additionalRedactedPaths: options.additionalRedactedPaths,
	});
	const suppressingTransport: RpcTransport = options.suppressExtensionUiRequests
		? {
				...filteredOutboundTransport,
				write: (value) => {
					if (
						typeof value === "object" &&
						value !== null &&
						(value as { type?: unknown }).type === "extension_ui_request"
					) {
						return Promise.resolve();
					}
					return filteredOutboundTransport.write(value);
				},
			}
		: filteredOutboundTransport;
	const preparedOutboundTransport: RpcTransport = options.suppressExtensionUiRequests
		? {
				...irohTransport,
				write: (value) => {
					if (
						typeof value === "object" &&
						value !== null &&
						(value as { type?: unknown }).type === "extension_ui_request"
					) {
						return Promise.resolve();
					}
					return irohTransport.write(value);
				},
			}
		: irohTransport;
	// Attach bounded, sanitized tool result text to live tool_execution_end
	// frames so remote clients can show real output in tool details.
	const outboundTransport: RpcTransport = {
		...suppressingTransport,
		write: (value) =>
			suppressingTransport.write(
				decorateIrohRemoteToolExecutionEnd(value, {
					remoteWorkspacePath: options.remoteWorkspacePath,
					workspacePath: options.workspacePath,
				}),
			),
	};
	let writeOrderedControl = (value: object): Promise<void> => Promise.resolve(outboundTransport.write(value));
	let writeOrderedTerminal = (value: object): Promise<void> => Promise.resolve(outboundTransport.write(value));
	const closeDeferringTransport = createIrohRemoteCloseDeferringRpcTransport({
		transport: outboundTransport,
		preparedTransport: preparedOutboundTransport,
		getCompletionState: () => getIrohRemoteCompletionState(runtimeHost),
		onCommandCompleted: async (completion) => {
			const notification = createIrohRemoteCompletionNotification(completion, options.workspaceName);
			if (notification) {
				await notificationDelivery?.deliver(notification);
			}
		},
		onResponseWritten: options.onResponseWritten,
		waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
	});
	let retireConversationStream: (error?: Error) => void = () => {};

	const filteredTransport = createIrohRemoteFilteredRpcTransport({
		transport: closeDeferringTransport,
		rpcGrant: options.rpcGrant,
		writeRejectedResponse: (value) => writeOrderedControl(value),
		writeStaleGrantResponse: (value) => writeOrderedTerminal(value),
		isRpcIngressOpen: options.isRpcIngressOpen,
		isRpcGrantCurrent: options.isRpcGrantCurrent,
		onRpcGrantStale: () => retireConversationStream(),
	});
	const remoteHostCommandTransport = options.remoteCommandHandler
		? createIrohRemoteHostCommandRpcTransport({
				handleCommand: (command) =>
					isRpcSessionInterruptionCommand(command)
						? options.remoteCommandHandler?.(command)
						: runtimeHost.runWithStableSession(() => options.remoteCommandHandler?.(command)),
				transport: filteredTransport,
				writeResponse: (value) => writeOrderedControl(value),
			})
		: filteredTransport;

	const prepareConversationOutbound = (value: object): ConversationProjectionPreparedValue => {
		const prepared = sanitizeIrohRemoteOutbound(
			decorateIrohRemoteToolExecutionEnd(value, {
				remoteWorkspacePath: options.remoteWorkspacePath,
				workspacePath: options.workspacePath,
			}),
			{
				decorate: options.decorateOutbound,
				remoteWorkspacePath: options.remoteWorkspacePath,
				workspacePath: options.workspacePath,
				additionalRedactedPaths: options.additionalRedactedPaths,
			},
		);
		return {
			value: prepared,
			bytes: Buffer.byteLength(serializeJsonLine(prepared), "utf8"),
		};
	};
	let conversationSubscription: ConversationProjectionSubscription | undefined;
	let conversationRetired = false;
	let physicalCloseStarted = false;
	let resolveModeSettled = () => {};
	const modeSettled = new Promise<void>((resolve) => {
		resolveModeSettled = resolve;
	});
	const closePhysicalConversationStream = (): void => {
		if (physicalCloseStarted) {
			return;
		}
		physicalCloseStarted = true;
		try {
			const closeSend = options.stream.send.reset ? options.stream.send.reset(0n) : options.stream.send.finish?.();
			if (closeSend) {
				void Promise.resolve(closeSend).catch(() => {});
			}
		} catch {}
		try {
			const closeRecv = options.stream.recv.stop?.(0n);
			if (closeRecv) {
				void Promise.resolve(closeRecv).catch(() => {});
			}
		} catch {}
	};
	const retireConversation = (error?: Error): void => {
		if (conversationRetired) {
			return;
		}
		// Retirement is the cancellation boundary. Mark it before rejecting feed
		// deliveries so RPC-mode backpressure observes cancellation, not a new
		// transport failure, and can finish independently of a native write promise.
		conversationRetired = true;
		conversationSubscription?.detach();
		closeDeferringTransport.retire(error);
		closePhysicalConversationStream();
	};
	retireConversationStream = retireConversation;
	// Register before runRpcMode installs the close-deferring handler. A natural
	// peer EOF must retire the feed and cancel its delivery promises before RPC
	// shutdown waits for transport backpressure.
	const detachRawCloseRetirement = irohTransport.onClose?.((error) => retireConversation(error)) ?? (() => {});
	const settleDeliveryAfterRetirement = async (delivery: Promise<void>): Promise<void> => {
		try {
			await delivery;
		} catch (error: unknown) {
			if (!conversationRetired) {
				throw error;
			}
		}
	};
	const admitPreparedResponse = (value: object): void => {
		closeDeferringTransport.admitPrepared(value);
	};

	conversationSubscription = runtimeHost.conversationProjectionFeed.attach({
		write: (value) => closeDeferringTransport.writePrepared(value),
		buildSnapshot: options.buildConversationSnapshot,
		projectExternal: options.projectConversationExternal,
		sanitizer: streamProjectionSanitizer,
		prepare: prepareConversationOutbound,
		onDiagnostic: (diagnostic) => {
			console.error(
				`[stream-projection:ordered-conversation] ${diagnostic.code}: ${diagnostic.message}`,
				diagnostic,
			);
		},
		onError: (error) => {
			retireConversation(error);
		},
	});
	if (conversationRetired) {
		conversationSubscription.detach();
	}
	const orderedSubscription = conversationSubscription;
	const enqueueOrderedControl = (value: object): Promise<void> =>
		settleDeliveryAfterRetirement(orderedSubscription.enqueueControl(value, admitPreparedResponse));
	const enqueueOrderedTerminal = (value: object): Promise<void> =>
		settleDeliveryAfterRetirement(orderedSubscription.fenceAndEnqueueTerminal(value, admitPreparedResponse));
	writeOrderedControl = enqueueOrderedControl;
	writeOrderedTerminal = enqueueOrderedTerminal;
	notificationDelivery = attachIrohRemoteNotificationDelivery(runtimeHost, {
		clientNodeId: options.clientNodeId,
		delivery: options.notificationDelivery,
		workspaceName: options.workspaceName,
		writeJsonl: enqueueOrderedControl,
	});
	const lifecycle: IrohRemoteConversationLifecycle = {
		write: enqueueOrderedControl,
		writeTerminal: enqueueOrderedTerminal,
		async terminate() {
			retireConversation();
			await modeSettled;
		},
	};
	options.onConversationLifecycleReady?.(lifecycle);
	const detachSessionWillProject = options.onSessionWillProject
		? runtimeHost.subscribeSessionWillProject((nextSession) =>
				options.onSessionWillProject?.({
					sessionFile: nextSession.sessionFile,
					sessionId: nextSession.sessionId,
				}),
			)
		: undefined;

	// attach() returns only after the cursor-zero bootstrap owns its immutable
	// FIFO slot. RPC ingress can start at that admission boundary; waiting for
	// ready would couple reads to physical bootstrap delivery and deadlock peer
	// EOF behind a blocked native writer. Feed errors still retire the lifecycle.
	void orderedSubscription.ready.catch(() => {});
	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: true,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onReady: options.onReady,
		onSessionChanged: async (session) => {
			await options.onSessionChanged?.(session);
			if (!transportClosed) {
				attachLiveActivityUpdates();
			}
		},
		onClientCapabilitiesChanged: options.onClientCapabilitiesChanged,
		onWorkflowEvent: options.onWorkflowEvent,
		requireRemoteSafeUiActions: true,
		requireConversationAuthority: true,
		transport: remoteHostCommandTransport,
		exitProcess: false,
		registerPushTarget: options.registerPushTarget,
		createStreamProjector: () => new StreamProjector({ sanitizer: streamProjectionSanitizer }),
		orderedConversation: {
			get subscriptionId() {
				return orderedSubscription.subscriptionId;
			},
			get branchEpoch() {
				return orderedSubscription.branchEpoch;
			},
			subscribeAuthorityChanges: (listener) => orderedSubscription.subscribeAuthorityChanges(listener),
			enqueueControl: enqueueOrderedControl,
			requestCheckpoint: (command) =>
				orderedSubscription.requestCheckpoint({
					requestId: command.id,
					lastAppliedCursor: command.lastAppliedCursor,
					...(command.assistantPosition === undefined ? {} : { assistantPosition: command.assistantPosition }),
					reason: command.reason,
				}),
			publishExternal: (event) => runtimeHost.publishConversationProjectionEvent(event),
		},
	}).finally(() => {
		transportClosed = true;
		notificationDelivery?.detach();
		detachSessionWillProject?.();
		detachRawCloseRetirement();
		retireConversation();
		detachLiveActivityUpdates?.();
		resolveModeSettled();
	});
}

const anonymousNotificationClient = Symbol("anonymous-iroh-notification-client");
type IrohRemoteNotificationClientKey = string | typeof anonymousNotificationClient;

interface IrohRemoteNotificationDeliveryAttachment {
	deliver(notification: IrohRemoteNotificationRequest): Promise<void>;
	detach(): void;
}

interface IrohRemoteNotificationDeliveryAttachmentOptions {
	clientNodeId?: string;
	delivery?: IrohRemotePushNotificationDelivery;
	workspaceName?: string;
	writeJsonl(notification: IrohRemoteNotificationRequest): Promise<void>;
}

interface IrohRemoteActiveNotificationAttachment {
	token: object;
	writeJsonl(notification: IrohRemoteNotificationRequest): Promise<void>;
}

const notificationReconcilersByRuntime = new WeakMap<
	AgentSessionRuntime,
	Map<IrohRemoteNotificationClientKey, IrohRemoteNotificationDeliveryReconciler>
>();

class IrohRemoteNotificationDeliveryReconciler {
	private readonly deliveredEventIds = new Set<string>();
	private readonly pendingNotifications = new Map<string, IrohRemoteNotificationRequest>();
	private readonly runtimeHost: AgentSessionRuntime;
	private currentAttachment: IrohRemoteActiveNotificationAttachment | undefined;
	private deliveryQueue: Promise<void> = Promise.resolve();
	private pushDelivery: IrohRemotePushNotificationDelivery | undefined;
	private workspaceName: string | undefined;

	constructor(runtimeHost: AgentSessionRuntime) {
		this.runtimeHost = runtimeHost;
		runtimeHost.reviewWorkflows?.attachSink((event) => {
			if (event.type !== "workflow_end" || event.kind !== "review" || event.status !== "completed") {
				return;
			}
			const record = runtimeHost.reviewWorkflows?.get(event.workflowId);
			if (record?.status !== "completed") {
				return;
			}
			const notification = createIrohRemoteReviewCompletionNotification(
				record,
				runtimeHost.session.sessionId,
				this.workspaceName,
			);
			if (notification) {
				void this.deliver(notification);
			}
		});
	}

	attach(options: IrohRemoteNotificationDeliveryAttachmentOptions): IrohRemoteNotificationDeliveryAttachment {
		const token = {};
		this.currentAttachment = { token, writeJsonl: options.writeJsonl };
		this.workspaceName = options.workspaceName;
		this.pushDelivery = options.delivery;
		for (const descriptor of this.runtimeHost.reviewWorkflows?.list() ?? []) {
			if (descriptor.status !== "completed") {
				continue;
			}
			const record = this.runtimeHost.reviewWorkflows?.get(descriptor.workflowId);
			if (record?.status !== "completed") {
				continue;
			}
			const notification = createIrohRemoteReviewCompletionNotification(
				record,
				this.runtimeHost.session.sessionId,
				this.workspaceName,
			);
			if (notification) {
				this.queueNotification(notification);
			}
		}
		void this.enqueueFlush();
		return {
			deliver: (notification) => this.deliver(notification),
			detach: () => {
				if (this.currentAttachment?.token === token) {
					this.currentAttachment = undefined;
				}
			},
		};
	}

	deliver(notification: IrohRemoteNotificationRequest): Promise<void> {
		this.queueNotification(notification);
		return this.enqueueFlush();
	}

	private queueNotification(notification: IrohRemoteNotificationRequest): void {
		const bounded = createBoundedIrohRemoteNotificationRequest(notification);
		if (!bounded || this.deliveredEventIds.has(bounded.eventId) || this.pendingNotifications.has(bounded.eventId)) {
			return;
		}
		while (this.pendingNotifications.size >= MAX_PENDING_NOTIFICATION_EVENT_IDS) {
			const oldest = this.pendingNotifications.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.pendingNotifications.delete(oldest);
		}
		this.pendingNotifications.set(bounded.eventId, bounded);
	}

	private enqueueFlush(): Promise<void> {
		const flush = this.deliveryQueue.then(() => this.flush());
		this.deliveryQueue = flush.catch(() => {});
		return flush;
	}

	private async flush(): Promise<void> {
		for (const [eventId, notification] of [...this.pendingNotifications]) {
			if (this.deliveredEventIds.has(eventId)) {
				this.pendingNotifications.delete(eventId);
				continue;
			}
			if (this.pushDelivery) {
				try {
					const status = await this.pushDelivery.deliverNotification(notification);
					if (status === "sent" || status === "duplicate") {
						this.markDelivered(eventId);
						continue;
					}
				} catch {
					// Preserve the pending intent for JSONL fallback or a later reconnect.
				}
			}
			const attachment = this.currentAttachment;
			if (!attachment) {
				continue;
			}
			try {
				await attachment.writeJsonl(notification);
				this.markDelivered(eventId);
			} catch {
				// The stream detached while writing. Keep the intent for reattachment.
			}
		}
	}

	private markDelivered(eventId: string): void {
		this.pendingNotifications.delete(eventId);
		if (this.deliveredEventIds.has(eventId)) {
			return;
		}
		while (this.deliveredEventIds.size >= MAX_SENT_NOTIFICATION_EVENT_IDS) {
			const oldest = this.deliveredEventIds.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.deliveredEventIds.delete(oldest);
		}
		this.deliveredEventIds.add(eventId);
	}
}

function attachIrohRemoteNotificationDelivery(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteNotificationDeliveryAttachmentOptions,
): IrohRemoteNotificationDeliveryAttachment {
	let reconcilers = notificationReconcilersByRuntime.get(runtimeHost);
	if (!reconcilers) {
		reconcilers = new Map();
		notificationReconcilersByRuntime.set(runtimeHost, reconcilers);
	}
	const key = options.clientNodeId ?? anonymousNotificationClient;
	let reconciler = reconcilers.get(key);
	if (!reconciler) {
		reconciler = new IrohRemoteNotificationDeliveryReconciler(runtimeHost);
		reconcilers.set(key, reconciler);
	}
	return reconciler.attach(options);
}

function createIrohRemoteReviewCompletionNotification(
	record: ReviewWorkflowResultRecord,
	sessionId: string,
	workspaceName: string | undefined,
): IrohRemoteNotificationRequest | undefined {
	const workflowId = sanitizeIrohRemoteNotificationMetadata(record.workflowId);
	if (!workflowId) {
		return undefined;
	}
	const target = sanitizeIrohRemoteNotificationTarget(record.target.description) ?? "Review";
	const findingsCount =
		Number.isSafeInteger(record.findingsCount) && (record.findingsCount ?? -1) >= 0
			? record.findingsCount
			: undefined;
	const body =
		findingsCount === undefined
			? `${target} completed. Open Volt to see the findings.`
			: findingsCount === 0
				? `${target} completed with no issues found.`
				: `${target} completed with ${findingsCount} finding${findingsCount === 1 ? "" : "s"}.`;
	return createBoundedIrohRemoteNotificationRequest({
		eventId: `${workflowId}:completed`,
		kind: "review_completed",
		title: "Your review is ready",
		body,
		sessionId,
		...(workspaceName === undefined ? {} : { workspaceName }),
		workflowId,
	});
}

function isIrohRemoteNotificationKind(value: string): value is IrohRemoteNotificationKind {
	return (
		value === "conversation_completed" ||
		value === "plan_ready" ||
		value === "review_completed" ||
		value === "action_completed" ||
		value === "host_notice"
	);
}

function createBoundedIrohRemoteNotificationRequest(
	intent: IrohRemotePushNotificationIntent,
): IrohRemoteNotificationRequest | undefined {
	const sanitized = sanitizeIrohRemotePushNotificationIntent(intent);
	if (!sanitized || !isIrohRemoteNotificationKind(sanitized.kind)) {
		return undefined;
	}
	return { type: "notification_request", ...sanitized, kind: sanitized.kind };
}

interface IrohRemoteTranscriptEventOptions {
	remoteWorkspacePath?: string;
	workspacePath: string;
}

function sanitizeIrohRemoteToolOutputFields(
	value: unknown,
	options: IrohRemoteTranscriptEventOptions,
	hostTruncated = false,
): Record<string, unknown> {
	if (typeof value !== "string" || value.trim().length === 0) {
		return {};
	}
	const sanitized = sanitizeIrohRemoteTranscriptText(value, options, "preserve");
	const scalars = Array.from(sanitized.text);
	const truncated = sanitized.truncated || hostTruncated || scalars.length > IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS;
	return {
		output:
			scalars.length > IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS
				? scalars.slice(0, IROH_REMOTE_TOOL_OUTPUT_MAX_SCALARS).join("")
				: sanitized.text,
		outputTruncated: truncated,
	};
}

/**
 * Adds `output`/`outputTruncated` to outbound tool_execution_end frames. The
 * generic outbound filter still sanitizes the whole frame afterwards; the text
 * is pre-sanitized and truncated here so the added field is bounded regardless.
 */
function decorateIrohRemoteToolExecutionEnd(value: object, options: IrohRemoteTranscriptEventOptions): object {
	if (!isRecord(value) || value.type !== "tool_execution_end" || "output" in value) {
		return value;
	}
	const result = value.result;
	if (!isRecord(result)) {
		return value;
	}
	const outputFields = sanitizeIrohRemoteToolOutputFields(extractVisibleTextContent(result.content), options);
	return Object.keys(outputFields).length > 0 ? { ...value, ...outputFields } : value;
}

type IrohRemoteLiveActivityAttachmentKey = string | IrohRemotePushNotificationDelivery;

interface IrohRemoteLiveActivityAttachment {
	dispose(): void;
	retire(): void;
}

const liveActivityAttachmentsByRuntime = new WeakMap<
	AgentSessionRuntime,
	Map<IrohRemoteLiveActivityAttachmentKey, IrohRemoteLiveActivityAttachment>
>();

function attachIrohRemoteLiveActivityUpdates(
	runtimeHost: AgentSessionRuntime,
	delivery: IrohRemotePushNotificationDelivery | undefined,
	workspaceName: string | undefined,
	clientNodeId: string | undefined,
): () => void {
	if (!delivery?.deliverLiveActivityUpdate) {
		return () => {};
	}
	const attachmentKey = clientNodeId ?? delivery;
	let attachments = liveActivityAttachmentsByRuntime.get(runtimeHost);
	if (!attachments) {
		attachments = new Map();
		liveActivityAttachmentsByRuntime.set(runtimeHost, attachments);
	}
	const updater = new IrohRemoteLiveActivityUpdater(runtimeHost, delivery, workspaceName);
	const unsubscribeSession = runtimeHost.session.subscribe(
		(event) => {
			void updater.handleSessionEvent(event).catch(() => {});
		},
		{ monitorGitContext: false },
	);
	const unsubscribeReviews =
		runtimeHost.reviewWorkflows?.attachSink((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				return;
			}
			void updater.handleReviewEvent(event).catch(() => {});
		}) ?? (() => {});
	let disposed = false;
	let retirementStarted = false;
	let attachment: IrohRemoteLiveActivityAttachment;
	const dispose = () => {
		if (disposed) {
			return;
		}
		disposed = true;
		updater.stop();
		unsubscribeSession();
		unsubscribeReviews();
		if (attachments.get(attachmentKey) === attachment) {
			attachments.delete(attachmentKey);
			if (attachments.size === 0) {
				liveActivityAttachmentsByRuntime.delete(runtimeHost);
			}
		}
	};
	const retire = () => {
		if (disposed || retirementStarted) {
			return;
		}
		retirementStarted = true;
		const reviewWorkflows = runtimeHost.reviewWorkflows;
		if (!reviewWorkflows?.hasActiveWorkflows) {
			dispose();
			return;
		}
		void (async () => {
			do {
				await reviewWorkflows.waitForIdle();
				await updater.waitForIdle();
			} while (reviewWorkflows.hasActiveWorkflows);
		})().then(dispose, dispose);
	};
	attachment = { dispose, retire };
	const previousAttachment = attachments.get(attachmentKey);
	attachments.set(attachmentKey, attachment);
	previousAttachment?.dispose();
	updater.start();
	return retire;
}

interface IrohRemoteLiveActivityOperation {
	kind: IrohRemoteLiveActivityContentState["operationKind"];
	id: string;
	subject?: string;
	startedAtEpochSeconds: number;
}

class IrohRemoteLiveActivityUpdater {
	private readonly delivery: Required<Pick<IrohRemotePushNotificationDelivery, "deliverLiveActivityUpdate">>;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly workspaceName: string | undefined;
	private readonly instanceId = randomUUID();
	private deliveryQueue: Promise<void> = Promise.resolve();
	private eventQueue: Promise<void> = Promise.resolve();
	private currentState: IrohRemoteLiveActivityContentState | undefined;
	private ordinaryOperation: IrohRemoteLiveActivityOperation | undefined;
	private sequence = 0;
	private ordinaryActive = false;
	private stopped = false;
	private pendingOrdinaryTerminalStatus: IrohRemoteLiveActivityContentState["status"] | undefined;

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

	start(): void {
		void this.enqueueEvent(async () => {
			const session = this.runtimeHost.session;
			this.ordinaryActive = session.isBusy || session.isStreaming;
			if (this.ordinaryActive) {
				this.refreshOrdinaryOperation();
			}
			await this.projectRunningOperation();
		}).catch(() => {});
	}

	stop(): void {
		this.stopped = true;
	}

	waitForIdle(): Promise<void> {
		return this.eventQueue;
	}

	handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		return this.enqueueEvent(async () => {
			switch (event.type) {
				case "agent_start":
					if (!this.ordinaryActive) {
						this.ordinaryOperation = undefined;
					}
					this.ordinaryActive = true;
					this.pendingOrdinaryTerminalStatus = undefined;
					this.refreshOrdinaryOperation();
					await this.projectRunningOperation();
					break;
				case "planning_state_changed":
					if (!this.ordinaryActive) {
						return;
					}
					this.refreshOrdinaryOperation();
					await this.projectRunningOperation();
					break;
				case "agent_end":
					if (!this.ordinaryActive) {
						return;
					}
					this.pendingOrdinaryTerminalStatus = liveActivityStatusForRunOutcome(
						getRunTerminalOutcome(event.messages),
					);
					break;
				case "agent_settled": {
					if (!this.ordinaryActive || this.pendingOrdinaryTerminalStatus === undefined) {
						return;
					}
					const operation = this.ordinaryOperation;
					const status = this.pendingOrdinaryTerminalStatus;
					this.ordinaryActive = false;
					this.ordinaryOperation = undefined;
					this.pendingOrdinaryTerminalStatus = undefined;
					if (await this.projectRunningOperation()) {
						return;
					}
					if (operation) {
						await this.projectOperation(operation, status);
					}
					break;
				}
				default:
					break;
			}
		});
	}

	handleReviewEvent(event: ReviewWorkflowEvent): Promise<void> {
		return this.enqueueEvent(async () => {
			if (event.type !== "workflow_end") {
				await this.projectRunningOperation();
				return;
			}
			if (await this.projectRunningOperation()) {
				return;
			}
			const operation = this.resolveReviewOperation(event.workflowId);
			if (operation) {
				await this.projectOperation(operation, event.status);
			}
		});
	}

	private enqueueEvent(operation: () => Promise<void>): Promise<void> {
		const queued = this.eventQueue.then(async () => {
			if (!this.stopped) {
				await operation();
			}
		});
		this.eventQueue = queued.catch(() => {});
		return queued;
	}

	private refreshOrdinaryOperation(): void {
		const sessionID = nonEmptyLiveActivityString(this.runtimeHost.session.sessionId);
		const workspaceName = nonEmptyLiveActivityString(this.workspaceName);
		if (!sessionID || !workspaceName) {
			this.ordinaryOperation = undefined;
			return;
		}
		const planning = this.runtimeHost.session.getPlanningState?.() ?? { mode: "build" as const, plan: null };
		const kind = planning.mode === "plan" ? "planCreation" : "conversation";
		const previous = this.ordinaryOperation;
		this.ordinaryOperation = {
			kind,
			id: sessionID,
			...(kind === "planCreation" && planning.plan?.title
				? { subject: boundLiveActivitySubject(planning.plan.title) }
				: {}),
			startedAtEpochSeconds:
				previous?.kind === kind && previous.id === sessionID
					? previous.startedAtEpochSeconds
					: Math.floor(Date.now() / 1000),
		};
	}

	private resolveReviewOperation(workflowId?: string): IrohRemoteLiveActivityOperation | undefined {
		const reviewWorkflows = this.runtimeHost.reviewWorkflows;
		if (!reviewWorkflows) {
			return undefined;
		}
		const descriptor =
			workflowId === undefined
				? reviewWorkflows
						.list()
						.filter((review) => review.status === "running")
						.at(-1)
				: reviewWorkflows.get(workflowId);
		if (!descriptor || (descriptor.status === "running" && descriptor.workflowId.trim().length === 0)) {
			return undefined;
		}
		const id = nonEmptyLiveActivityString(descriptor.workflowId);
		return id
			? {
					kind: "review",
					id,
					startedAtEpochSeconds: Math.max(0, Math.floor(descriptor.startedAt / 1000)),
				}
			: undefined;
	}

	private async projectRunningOperation(): Promise<boolean> {
		const review = this.resolveReviewOperation();
		if (review) {
			await this.projectOperation(review, "running");
			return true;
		}
		if (!this.ordinaryActive) {
			return false;
		}
		this.refreshOrdinaryOperation();
		if (!this.ordinaryOperation) {
			return false;
		}
		await this.projectOperation(this.ordinaryOperation, "running");
		return true;
	}

	private async projectOperation(
		operation: IrohRemoteLiveActivityOperation,
		status: IrohRemoteLiveActivityContentState["status"],
	): Promise<void> {
		const sessionID = nonEmptyLiveActivityString(this.runtimeHost.session.sessionId);
		const workspaceName = nonEmptyLiveActivityString(this.workspaceName);
		if (!sessionID || !workspaceName) {
			return;
		}
		const nowSeconds = Math.floor(Date.now() / 1000);
		const operationStartedAtEpochSeconds =
			this.currentState?.operationKind === operation.kind &&
			this.currentState.operationID === operation.id &&
			(status !== "running" || this.currentState.status === "running")
				? this.currentState.operationStartedAtEpochSeconds
				: operation.startedAtEpochSeconds;
		const updatedAtEpochSeconds = Math.max(nowSeconds, operationStartedAtEpochSeconds);
		const contentState: IrohRemoteLiveActivityContentState = {
			operationKind: operation.kind,
			operationID: operation.id,
			status,
			...(operation.subject === undefined ? {} : { subject: operation.subject }),
			sessionID,
			workspaceName,
			operationStartedAtEpochSeconds,
			updatedAtEpochSeconds,
		};
		if (hasSameLiveActivitySemantics(this.currentState, contentState)) {
			return;
		}
		this.currentState = contentState;
		const update: IrohRemoteLiveActivityUpdateIntent = {
			eventId: `live-activity:${this.instanceId}:${++this.sequence}`,
			kind: "live_activity_update",
			activityEvent: "update",
			contentState,
			staleDateEpochSeconds: updatedAtEpochSeconds + 90,
		};
		const delivery = this.deliveryQueue.then(() => this.delivery.deliverLiveActivityUpdate(update));
		this.deliveryQueue = delivery.then(
			() => {},
			() => {},
		);
		await delivery;
	}
}

function nonEmptyLiveActivityString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? value : undefined;
}

function boundLiveActivitySubject(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	let bounded = "";
	for (const character of trimmed) {
		if (
			Buffer.byteLength(bounded, "utf8") + Buffer.byteLength(character, "utf8") >
			MAX_IROH_REMOTE_LIVE_ACTIVITY_SUBJECT_UTF8_BYTES
		) {
			break;
		}
		bounded += character;
	}
	return bounded || undefined;
}

function hasSameLiveActivitySemantics(
	current: IrohRemoteLiveActivityContentState | undefined,
	next: IrohRemoteLiveActivityContentState,
): boolean {
	return (
		current?.operationKind === next.operationKind &&
		current.operationID === next.operationID &&
		current.status === next.status &&
		current.subject === next.subject &&
		current.sessionID === next.sessionID &&
		current.workspaceName === next.workspaceName
	);
}

function liveActivityStatusForRunOutcome(
	outcome: IrohRemoteRunTerminalOutcome,
): IrohRemoteLiveActivityContentState["status"] {
	if (outcome === "aborted") {
		return "cancelled";
	}
	return outcome;
}

export function createIrohRemoteHostCommandRpcTransport(
	options: IrohRemoteHostCommandRpcTransportOptions,
): RpcTransport & { setRpcModeStartupComplete?(startupComplete: boolean): void } {
	let pendingInboundCommand = Promise.resolve();
	const pendingResponseWrites = new Set<Promise<void>>();
	let pendingResponseWriteError: Error | undefined;
	const inboundCommandContext = new AsyncLocalStorage<boolean>();
	const startupAwareTransport = options.transport as {
		setRpcModeStartupComplete?: (startupComplete: boolean) => void;
	};
	const waitForPendingInboundCommand = async (): Promise<void> => {
		// Command handlers themselves call transport backpressure/flush/close.
		// Awaiting their own pending promise would form a cycle; external callers
		// still wait for the full serialized inbound command chain.
		if (inboundCommandContext.getStore() === true) {
			return;
		}
		await pendingInboundCommand;
	};

	const trackResponseWrite = (result: void | Promise<void>): void => {
		if (!result) {
			return;
		}
		const pending = Promise.resolve(result)
			.catch((error: unknown) => {
				pendingResponseWriteError ??= error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				pendingResponseWrites.delete(pending);
			});
		pendingResponseWrites.add(pending);
	};

	const waitForResponseWrites = async (): Promise<void> => {
		while (pendingResponseWrites.size > 0) {
			await Promise.allSettled(pendingResponseWrites);
		}
		if (!pendingResponseWriteError) {
			return;
		}
		const error = pendingResponseWriteError;
		pendingResponseWriteError = undefined;
		throw error;
	};

	const admitResponse = (value: object): void => {
		// Ordered sinks claim their final FIFO slot synchronously. The returned
		// promise is a physical-delivery receipt owned by transport lifecycle
		// methods, never by the serialized input-handler chain.
		trackResponseWrite((options.writeResponse ?? options.transport.write.bind(options.transport))(value));
	};

	const writeHandlerError = (line: string, error: unknown): void => {
		const target = getIrohRemoteRpcErrorTarget(line);
		admitResponse(
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
			await handler(line);
			return;
		}
		let response: object | undefined;
		let grantStale = false;
		try {
			if (options.isRpcGrantCurrent && !(await options.isRpcGrantCurrent())) {
				grantStale = true;
				const target = getIrohRemoteRpcErrorTarget(line);
				response = createIrohRemoteRpcErrorResponse(target.id, target.command, "RPC grant is stale; reconnect");
			} else {
				response = await options.handleCommand?.(command);
			}
		} catch (error: unknown) {
			writeHandlerError(line, error);
			return;
		}
		if (response === undefined) {
			await handler(line);
			return;
		}
		admitResponse(response);
		if (grantStale) {
			await options.onRpcGrantStale?.();
		}
	};

	return {
		setRpcModeStartupComplete(startupComplete: boolean) {
			startupAwareTransport.setRpcModeStartupComplete?.(startupComplete);
		},
		write(value) {
			return options.transport.write(value);
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				pendingInboundCommand = pendingInboundCommand.then(
					() => inboundCommandContext.run(true, () => handleLine(line, handler)),
					() => inboundCommandContext.run(true, () => handleLine(line, handler)),
				);
				void pendingInboundCommand.catch(() => {});
				return pendingInboundCommand;
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			return options.transport.onClose?.(handler) ?? (() => {});
		},
		async waitForBackpressure() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
			await options.transport.flush?.();
		},
		async close() {
			await waitForPendingInboundCommand();
			await waitForResponseWrites();
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
		return getRpcErrorResponseTarget(parsed);
	} catch {
		return { id: undefined, command: "parse" };
	}
}

export function createIrohRemoteCloseDeferringRpcTransport(
	options: IrohRemoteCloseDeferringRpcTransportOptions,
): IrohRemoteCloseDeferringRpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();
	let retired = false;
	let retirementError: Error | undefined;
	let rpcModeStartupComplete = true;
	let startupCompletedPendingCommand = false;
	let startupCleanClosePending = false;
	const retirementCloseHandlers = new Set<(error?: Error) => void>();

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
		if (retired) {
			return undefined;
		}
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
		const target = getRpcErrorResponseTarget(command);
		return createPendingCommand(target.command, target.id);
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
		// The response obligation belongs to the final FIFO once admitted. It must
		// no longer delay clean close while a prior physical write is blocked.
		pending.finish();
		if (response.success === true && shouldWaitForRemoteResponseCompletion(pending.command, response)) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
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
			for (const handler of retirementCloseHandlers) {
				handler();
			}
		},
		write(value) {
			trackOutboundResponse(value);
			const result = options.transport.write(value);
			if (options.onResponseWritten && (value as Record<string, unknown>).type === "response") {
				return notifyResponseWritten(value, result);
			}
			return result;
		},
		admitPrepared(value) {
			trackOutboundResponse(value);
		},
		retire(error) {
			if (retired) {
				return;
			}
			retired = true;
			retirementError = error;
			for (const pending of [...pendingCommands]) {
				pending.finish();
			}
			startupCleanClosePending = false;
			startupCompletedPendingCommand = false;
			for (const handleRetirementClose of [...retirementCloseHandlers]) {
				handleRetirementClose(error);
			}
		},
		writePrepared(value) {
			const result = (options.preparedTransport ?? options.transport).write(value);
			if (options.onResponseWritten && (value as Record<string, unknown>).type === "response") {
				return notifyResponseWritten(value, result);
			}
			return result;
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine(async (line) => {
				const pending = trackInboundLine(line);
				try {
					await handler(line);
				} catch (error: unknown) {
					pending?.finish();
					throw error;
				}
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			let active = true;
			let delivered = false;
			const deliver = (error?: Error) => {
				if (!active || delivered) {
					return;
				}
				delivered = true;
				handler(error);
			};
			const handleCleanClose = () => {
				void waitForPendingCommands().then(() => {
					deliver();
				});
			};
			const handleRetirementClose = (error?: Error) => {
				if (error) {
					deliver(error);
					return;
				}
				handleCleanClose();
			};
			retirementCloseHandlers.add(handleRetirementClose);
			const detach =
				options.transport.onClose?.((error) => {
					if (!active || delivered) {
						return;
					}
					if (error) {
						deliver(error);
						return;
					}
					if (!rpcModeStartupComplete && (pendingCommands.size > 0 || startupCompletedPendingCommand)) {
						startupCleanClosePending = true;
						return;
					}
					handleCleanClose();
				}) ?? (() => {});
			if (retired) {
				queueMicrotask(() => handleRetirementClose(retirementError));
			}
			return () => {
				active = false;
				retirementCloseHandlers.delete(handleRetirementClose);
				detach();
			};
		},
		async waitForBackpressure() {
			if (retired) {
				return;
			}
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			if (retired) {
				return;
			}
			await options.transport.flush?.();
		},
		close() {
			if (retired) {
				return Promise.resolve();
			}
			return options.transport.close();
		},
	};
	return transport;
}

function getIrohRemoteCompletionState(runtimeHost: AgentSessionRuntime): IrohRemoteCompletionState {
	const planning = runtimeHost.session.getPlanningState?.() ?? { mode: "build" as const, plan: null };
	const planId = sanitizeIrohRemoteNotificationMetadata(planning.plan?.id);
	const planTitle =
		planning.plan?.title === undefined
			? undefined
			: sanitizeIrohRemoteNotificationText(planning.plan.title, MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES);
	return {
		sessionId: runtimeHost.session.sessionId,
		runId: runtimeHost.session.sessionManager.getLeafId() ?? undefined,
		terminalOutcome: getRunTerminalOutcome(runtimeHost.session.messages),
		planningMode: planning.mode,
		...(planning.plan === null ? {} : { planPhase: planning.plan.phase }),
		...(planId === undefined ? {} : { planId }),
		...(planTitle === undefined ? {} : { planTitle }),
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
	if (!isConversationCompletionCommand(completion.command)) {
		return undefined;
	}
	const workspaceNameMetadata = sanitizeIrohRemoteNotificationWorkspace(workspaceName);
	const workspaceDetails = workspaceNameMetadata === undefined ? {} : { workspaceName: workspaceNameMetadata };
	switch (finalState.terminalOutcome) {
		case "failed":
			return createBoundedIrohRemoteNotificationRequest({
				eventId: `conversation:${finalState.sessionId}:${finalState.runId}:failed`,
				kind: "host_notice",
				title:
					workspaceNameMetadata === undefined
						? "Volt needs attention"
						: `Volt needs attention in ${workspaceNameMetadata}`,
				body: "Open Volt to view the error.",
				sessionId: finalState.sessionId,
				...workspaceDetails,
			});
		case "aborted":
			return undefined;
		case "completed":
			if (finalState.planningMode === "plan" && finalState.planPhase === "ready") {
				if (!finalState.planId) {
					return undefined;
				}
				return createBoundedIrohRemoteNotificationRequest({
					eventId: `plan:${finalState.sessionId}:${finalState.runId}:ready`,
					kind: "plan_ready",
					title: "Your plan is ready",
					body: "Open Volt to review and approve it.",
					sessionId: finalState.sessionId,
					...workspaceDetails,
					planId: finalState.planId,
				});
			}
			return createBoundedIrohRemoteNotificationRequest({
				eventId: `conversation:${finalState.sessionId}:${finalState.runId}:completed`,
				kind: "conversation_completed",
				title: workspaceNameMetadata === undefined ? "Volt finished" : `Volt finished in ${workspaceNameMetadata}`,
				body: "Your conversation is ready.",
				sessionId: finalState.sessionId,
				...workspaceDetails,
			});
	}
}

function getChangedFinalCompletionState(
	completion: IrohRemoteCompletedCommand,
): (IrohRemoteCompletionState & { runId: string; terminalOutcome: IrohRemoteRunTerminalOutcome }) | undefined {
	const finalState = completion.finalState;
	if (!finalState?.runId) {
		return undefined;
	}
	const initialState = completion.initialState;
	if (initialState?.sessionId === finalState.sessionId && initialState.runId === finalState.runId) {
		return undefined;
	}
	return {
		...finalState,
		runId: finalState.runId,
		terminalOutcome: finalState.terminalOutcome ?? "completed",
	};
}

function getRunTerminalOutcome(messages: readonly AgentMessage[]): IrohRemoteRunTerminalOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error") {
			return "failed";
		}
		if (message.stopReason === "aborted") {
			return "aborted";
		}
		return "completed";
	}
	return "completed";
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
	if (typeof data.workflowId === "string") {
		// Detached workflow acceptance: the review runs independently of the
		// session run loop, so there is no prompt completion to wait for.
		return false;
	}
	return data.status === "accepted" || data.status === "queued";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
