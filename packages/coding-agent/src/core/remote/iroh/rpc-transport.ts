import { getRpcErrorResponseTarget } from "../../rpc/correlation.ts";
import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
} from "../../rpc/index.ts";
import type { IrohRemoteRpcGrant } from "./access-grant.ts";
import {
	createIrohRemoteRpcErrorResponse,
	getIrohRemoteRpcFilterResult,
	getStaticIrohRemoteRpcFilterResult,
} from "./rpc-command-filter.ts";

export interface IrohRemoteFilteredRpcTransportOptions {
	transport: RpcTransport;
	/** Persisted grant snapshot for this authorized remote stream. */
	rpcGrant: IrohRemoteRpcGrant;
	/**
	 * Optional ordered response sink. Conversation transports install their
	 * runtime-owned projection lane here so policy rejections cannot overtake
	 * bootstrap or already-enqueued conversation frames.
	 */
	writeRejectedResponse?: (value: object) => void | Promise<void>;
	/** Atomically fence queued output and write the stale-authority rejection last. */
	writeStaleGrantResponse?: (value: object) => void | Promise<void>;
	/** Stop terminally fenced ingress without cancelling already-admitted ordered output. */
	isRpcIngressOpen?: () => boolean;
	/** Recheck persisted authority before even parsing/capability-filtering input. */
	isRpcGrantCurrent?: () => boolean | Promise<boolean>;
	/** Retire the stream immediately after the stale rejection owns its ordered slot. */
	onRpcGrantStale?: () => void | Promise<void>;
}

interface StartupAwareRpcTransport extends RpcTransport {
	setRpcModeStartupComplete?(startupComplete: boolean): void;
}

/**
 * Wrap an RPC transport with the remote Iroh command policy.
 *
 * Allowed commands are forwarded to the in-process RPC mode unchanged.
 * Disallowed or malformed commands are rejected on the same transport without
 * reaching Volt RPC handlers.
 */
export function createIrohRemoteFilteredRpcTransport(
	options: IrohRemoteFilteredRpcTransportOptions,
): RpcTransport & { setRpcModeStartupComplete?(startupComplete: boolean): void } {
	const pendingRejections = new Set<Promise<void>>();
	let pendingRejectionError: Error | undefined;
	const startupAwareTransport = options.transport as StartupAwareRpcTransport;

	const recordRejectionError = (error: unknown): Error => {
		const rejectionError = error instanceof Error ? error : new Error(String(error));
		pendingRejectionError ??= rejectionError;
		return rejectionError;
	};

	const trackRejectionWrite = (result: void | Promise<void>): void => {
		if (!result) {
			return;
		}
		const pending = Promise.resolve(result)
			.catch((error: unknown) => {
				recordRejectionError(error);
			})
			.finally(() => {
				pendingRejections.delete(pending);
			});
		pendingRejections.add(pending);
	};

	const waitForRejectionWrites = async (): Promise<void> => {
		while (pendingRejections.size > 0) {
			await Promise.allSettled(pendingRejections);
		}
		if (!pendingRejectionError) {
			return;
		}
		const error = pendingRejectionError;
		pendingRejectionError = undefined;
		throw error;
	};

	return {
		setRpcModeStartupComplete(startupComplete: boolean) {
			startupAwareTransport.setRpcModeStartupComplete?.(startupComplete);
		},
		write(value) {
			return options.transport.write(value);
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine(async (line) => {
				if (options.isRpcIngressOpen && !options.isRpcIngressOpen()) {
					return;
				}
				if (options.isRpcGrantCurrent && !(await options.isRpcGrantCurrent())) {
					const staticResult = getStaticIrohRemoteRpcFilterResult(line);
					const target = staticResult.allowed
						? getRpcErrorResponseTarget(staticResult.command)
						: { id: staticResult.response.id, command: staticResult.response.command };
					const staleResponse = createIrohRemoteRpcErrorResponse(
						target.id,
						target.command,
						"RPC grant is stale; reconnect",
					);
					try {
						const writeResult = options.writeStaleGrantResponse
							? options.writeStaleGrantResponse(staleResponse)
							: options.writeRejectedResponse
								? options.writeRejectedResponse(staleResponse)
								: options.transport.write(staleResponse);
						trackRejectionWrite(writeResult);
						// Ordered sinks admit synchronously before returning their physical
						// delivery promise. Authority retirement must start at that boundary;
						// waiting for delivery can deadlock behind an older blocked write.
					} catch (error: unknown) {
						recordRejectionError(error);
					}
					try {
						await options.onRpcGrantStale?.();
					} catch (error: unknown) {
						recordRejectionError(error);
					}
					return;
				}
				const filterResult = getIrohRemoteRpcFilterResult(line, options.rpcGrant);
				if (filterResult.allowed) {
					await handler(line);
					return;
				}

				try {
					if (options.writeRejectedResponse) {
						// Conversation sinks claim the response synchronously at FIFO
						// admission. Track their later delivery settlement without blocking
						// input behind a potentially retired physical stream.
						trackRejectionWrite(options.writeRejectedResponse(filterResult.response));
					} else {
						// A raw transport has no separate admission receipt. Await each write
						// so a peer cannot build an unbounded queue of policy rejections.
						await options.transport.write(filterResult.response);
					}
				} catch (error: unknown) {
					recordRejectionError(error);
				}
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			return options.transport.onClose?.(handler) ?? (() => {});
		},
		async waitForBackpressure() {
			await waitForRejectionWrites();
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await waitForRejectionWrites();
			await options.transport.flush?.();
		},
		async close() {
			let rejectionError: unknown;
			try {
				await waitForRejectionWrites();
			} catch (error: unknown) {
				rejectionError = error;
			}

			try {
				await options.transport.close();
			} catch (closeError: unknown) {
				if (!rejectionError) {
					throw closeError;
				}
			}

			if (rejectionError) {
				throw rejectionError;
			}
		},
	};
}

export function createIrohRemoteRpcTransport(
	options: IrohRpcTransportOptions & { rpcGrant: IrohRemoteRpcGrant },
): RpcTransport {
	return createIrohRemoteFilteredRpcTransport({
		transport: createIrohRpcTransport(options),
		rpcGrant: options.rpcGrant,
	});
}
