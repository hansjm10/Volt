import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundFilteredRpcTransport,
	type IrohRemoteOutboundValueDecorator,
} from "../../core/remote/iroh/index.ts";
import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
} from "../../core/rpc/index.ts";
import { type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {
	decorateOutbound?: IrohRemoteOutboundValueDecorator;
	disposeRuntimeOnClose?: boolean;
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	remoteWorkspacePath?: string;
	workspacePath: string;
}

interface PendingIrohRemoteCommand {
	command: string;
	id: string | undefined;
	done: Promise<void>;
	responseMatched: boolean;
	finish(): void;
}

interface IrohRemoteCloseDeferringRpcTransportOptions {
	transport: RpcTransport;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
}

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: false,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onSessionChanged: options.onSessionChanged,
		transport: createIrohRemoteFilteredRpcTransport({
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: createIrohRemoteOutboundFilteredRpcTransport({
					decorate: options.decorateOutbound,
					remoteWorkspacePath: options.remoteWorkspacePath,
					transport: createIrohRpcTransport(options),
					workspacePath: options.workspacePath,
				}),
				waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
			}),
		}),
		exitProcess: false,
	});
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
		if (command.type === "extension_ui_response") {
			return undefined;
		}
		return createPendingCommand(command.type, typeof command.id === "string" ? command.id : undefined);
	};

	const finishAfterPromptCompletion = async (pending: PendingIrohRemoteCommand): Promise<void> => {
		try {
			// Prompt success is emitted just before AgentSession starts the run.
			// Steer/follow_up success means input was accepted into an active session run.
			// Yield once so waitForIdle observes that run or any accepted queued input.
			await Promise.resolve();
			await options.waitForPromptCompletion();
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
		if (
			response.success === true &&
			(pending.command === "prompt" || pending.command === "steer" || pending.command === "follow_up")
		) {
			void finishAfterPromptCompletion(pending).catch(() => {});
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
