import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createIrohRemoteRpcTransport } from "../../core/remote/iroh/index.ts";
import type { IrohRpcTransportOptions, RpcCloseHandler, RpcLineHandler, RpcTransport } from "../../core/rpc/index.ts";
import { runRpcMode } from "./rpc-mode.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {}

interface PendingIrohRemoteCommand {
	command: string;
	id: string | undefined;
	done: Promise<void>;
	finish(): void;
}

interface IrohRemoteCloseDeferringRpcTransportOptions {
	transport: RpcTransport;
	waitForPromptCompletion(): Promise<void>;
}

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	return runRpcMode(runtimeHost, {
		transport: createIrohRemoteCloseDeferringRpcTransport({
			transport: createIrohRemoteRpcTransport(options),
			waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
		}),
		exitProcess: false,
	});
}

export function createIrohRemoteCloseDeferringRpcTransport(
	options: IrohRemoteCloseDeferringRpcTransportOptions,
): RpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();

	const createPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand => {
		let finished = false;
		let resolveDone = () => {};
		const pending: PendingIrohRemoteCommand = {
			command,
			id,
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
			finish() {
				if (finished) {
					return;
				}
				finished = true;
				pendingCommands.delete(pending);
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
			if (pending.command === command && pending.id === id) {
				return pending;
			}
		}
		return undefined;
	};

	const trackInboundCommand = (line: string): PendingIrohRemoteCommand | undefined => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const command = parsed as Record<string, unknown>;
		if (typeof command.type !== "string" || command.type === "extension_ui_response") {
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
		if (
			response.success === true &&
			(pending.command === "prompt" || pending.command === "steer" || pending.command === "follow_up")
		) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
		}
		pending.finish();
	};

	return {
		write(value) {
			const result = options.transport.write(value);
			trackOutboundResponse(value);
			return result;
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				const pending = trackInboundCommand(line);
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
			const detach =
				options.transport.onClose?.((error) => {
					if (!active) {
						return;
					}
					if (error) {
						handler(error);
						return;
					}
					void waitForPendingCommands().then(() => {
						if (active) {
							handler();
						}
					});
				}) ?? (() => {});
			return () => {
				active = false;
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
}
