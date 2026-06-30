/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type { HostActionInvocationContext } from "../../core/host-actions.ts";
import type {
	HostActionDecision,
	HostActionRequest,
	HostActionUpdate,
	HostInteraction,
} from "../../core/host-interaction.ts";
import {
	flushRawStdout,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import {
	REMOTE_REVIEW_TOOL_NAMES,
	type ReviewWorkflowEvent,
	type ReviewWorkflowToolEvent,
	runReviewWorkflow,
} from "../../core/review.ts";
import type { RpcTransport } from "../../core/rpc/transport.ts";
import type { SubagentDefinition, SubagentHandle } from "../../core/subagents/index.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
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
	RpcLiveActivityRegistration,
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
}

type RpcModeStartupAwareTransport = RpcTransport & {
	setRpcModeStartupComplete?(startupComplete: boolean): void;
};

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
		...(definition.model ? { model: definition.model } : {}),
		...(definition.thinking ? { thinking: definition.thinking } : {}),
	};
}

class RpcSubagentLifecycle implements RpcSubagentLifecycleController {
	private readonly getSession: () => AgentSession;
	private readonly output: (event: object) => void;
	private readonly active = new Map<string, RpcSubagentEntry>();

	constructor(options: { getSession: () => AgentSession; output: (event: object) => void }) {
		this.getSession = options.getSession;
		this.output = options.output;
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
		const unsubscribe = handle.onEvent((event) => {
			if (entry?.disposed) {
				return;
			}
			this.output({ type: "subagent_event", subagentId: handle.id, event });
		});
		entry = { handle, unsubscribe, disposed: false };
		this.active.set(handle.id, entry);
		void handle.waitForEnd().then(
			(result) => {
				if (!entry?.disposed) {
					this.output({ type: "subagent_end", subagentId: handle.id, result });
				}
			},
			() => undefined,
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
			await entry.handle.abort();
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
		await entry.handle.dispose();
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
	let lastNotifiedSessionId: string | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		if (shuttingDown || hasPendingWriteError) {
			return;
		}
		try {
			trackTransportWrite(transport.write(obj));
		} catch (writeError: unknown) {
			requestTransportFailureShutdown(writeError);
		}
	};
	const rpcSubagents = new RpcSubagentLifecycle({ getSession: () => session, output });

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
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const notifySessionChanged = async (): Promise<void> => {
		if (options.onSessionChanged && session.sessionId !== lastNotifiedSessionId) {
			lastNotifiedSessionId = session.sessionId;
			await options.onSessionChanged({ sessionFile: session.sessionFile, sessionId: session.sessionId });
		}
	};

	const rebindSession = async (): Promise<void> => {
		await rpcSubagents.disposeAll();
		session = runtimeHost.session;
		if (shuttingDown) {
			await notifySessionChanged();
			return;
		}
		setSessionHostInteraction(session);
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
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
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			try {
				await waitForTransportBackpressure();
			} catch (transportError: unknown) {
				requestTransportFailureShutdown(transportError);
			}
		});
	};

	const handleReviewWorkflowEvent = (event: ReviewWorkflowEvent | ReviewWorkflowToolEvent): void => {
		try {
			const result = options.onWorkflowEvent?.(event);
			if (result) {
				void Promise.resolve(result).catch(() => {});
			}
		} catch (error) {
			void error;
		}
		output(event);
	};

	const createHostActionContext = (): HostActionInvocationContext => ({
		session,
		abortRun: () => session.abort(),
		compactContext: (customInstructions) => session.compact(customInstructions),
		newSession: (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
		afterSessionSwitch: rebindSession,
		renameSession: (name) => {
			session.setSessionName(name);
		},
		setThinkingLevel: (level, options) => {
			session.setThinkingLevel(level, options);
		},
		setFastModeRestoreThinkingLevel: (level) => {
			session.setFastModeRestoreThinkingLevel(level);
		},
		runReviewAction: (target, reviewOptions) =>
			runReviewWorkflow({
				target,
				cwd: runtimeHost.cwd,
				agentDir: runtimeHost.services.agentDir,
				session,
				newSession: async (newSessionOptions) => {
					const result = await runtimeHost.newSession(newSessionOptions);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				authStorage: session.modelRegistry.authStorage,
				settingsManager: session.settingsManager,
				tools: REMOTE_REVIEW_TOOL_NAMES,
				requireProjectTrust: reviewOptions.remote,
				requireConfirmation: reviewOptions.requireConfirmation,
				confirm: ({ title, message }) => createExtensionUIContext().confirm(title, message),
				onEvent: handleReviewWorkflowEvent,
			}),
	});

	const createRpcCommandContext = () => ({
		session,
		runtimeHost,
		options: {
			allowUiActionInvocation,
			requireRemoteSafeUiActions,
			registerPushTarget: options.registerPushTarget,
		},
		output,
		rebindSession,
		createHostActionContext,
		setClientCapabilities(features: RpcClientCapabilityFeature[]): void {
			clientCapabilities = new Set(
				features.filter((feature): feature is RpcClientCapabilityFeature => typeof feature === "string"),
			);
		},
		getPendingHostActionRequests: () => hostActionBridge.getPendingRequests(),
		cancelPendingHostActionRequests,
		subagents: rpcSubagents,
	});

	let detachInput = () => {};
	let detachClose = () => {};
	let resolveModeClosed: (() => void) | undefined;
	let rejectModeClosed: ((error: unknown) => void) | undefined;
	const modeClosed = new Promise<void>((resolve, reject) => {
		resolveModeClosed = resolve;
		rejectModeClosed = reject;
	});
	let shutdownPromise: Promise<void> | undefined;

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
			cancelPendingExtensionRequests();
			detachHostActionBridge();
			await rpcSubagents.disposeAll();
			if (shouldDisposeRuntimeOnClose) {
				cancelPendingHostActionRequests();
			}
			for (const cleanup of signalCleanupHandlers) {
				cleanup();
			}
			unsubscribe?.();
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
	const queuedStartupCommandLines: string[] = [];

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	function shutdown(exitCode = 0, signal?: NodeJS.Signals, failure?: { error: unknown }): Promise<void> {
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
		cancelPendingExtensionRequests();
		detachHostActionBridge();
		if (shouldDisposeRuntimeOnClose) {
			cancelPendingHostActionRequests();
		}
		if (shuttingDown) {
			if (shouldExitProcess) {
				process.exit(exitCode);
			}
			return shutdownPromise ?? modeClosed;
		}
		shuttingDown = true;
		shutdownPromise = (async () => {
			try {
				let hasShutdownError = failure !== undefined;
				let shutdownError: unknown = failure?.error;
				try {
					for (const cleanup of signalCleanupHandlers) {
						cleanup();
					}
					unsubscribe?.();
					unsubscribeBackpressure?.();
					await rpcSubagents.disposeAll();
					if (shouldDisposeRuntimeOnClose) {
						await runtimeHost.dispose();
					}
					detachInput();
					detachClose();
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
		return shutdownPromise;
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	let commandQueue: Promise<void> = Promise.resolve();

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
			response = await handleRpcCommand(command, createRpcCommandContext());
		} catch (commandError: unknown) {
			const target = getRpcErrorResponseTarget(command);
			output(createRpcErrorResponse(target.id, target.command, toError(commandError).message));
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

	const enqueueInputTask = (task: () => Promise<void>): void => {
		const runTask = async (): Promise<void> => {
			try {
				await task();
			} catch (inputError: unknown) {
				await shutdown(1, undefined, { error: toError(inputError) }).catch(() => {});
			}
		};
		commandQueue = commandQueue.then(runTask, runTask);
		void commandQueue.catch(() => {});
	};

	const processInputLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			enqueueInputTask(async () => {
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
			return;
		}

		if (handleControlMessage(parsed)) {
			return;
		}

		if (!startupComplete) {
			queuedStartupCommandLines.push(line);
			return;
		}

		enqueueInputTask(() => handleQueuedParsedInput(parsed));
	};

	detachInput = transport.onLine(processInputLine);
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
	for (const line of queuedStartupCommandLines.splice(0)) {
		processInputLine(line);
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
