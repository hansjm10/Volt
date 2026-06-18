import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
} from "../../rpc/index.ts";
import { getIrohRemoteRpcFilterResult } from "./rpc-command-filter.ts";

export interface IrohRemoteFilteredRpcTransportOptions {
	transport: RpcTransport;
}

/**
 * Wrap an RPC transport with the remote Iroh command policy.
 *
 * Allowed commands are forwarded to the in-process RPC mode unchanged.
 * Disallowed or malformed commands are rejected on the same transport without
 * reaching Volt RPC handlers.
 */
export function createIrohRemoteFilteredRpcTransport(options: IrohRemoteFilteredRpcTransportOptions): RpcTransport {
	const pendingRejections = new Set<Promise<void>>();
	let pendingRejectionError: Error | undefined;

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
				throw recordRejectionError(error);
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
		write(value) {
			return options.transport.write(value);
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				const filterResult = getIrohRemoteRpcFilterResult(line);
				if (filterResult.allowed) {
					handler(line);
					return;
				}

				try {
					trackRejectionWrite(options.transport.write(filterResult.response));
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
		close() {
			return options.transport.close();
		},
	};
}

export function createIrohRemoteRpcTransport(options: IrohRpcTransportOptions): RpcTransport {
	return createIrohRemoteFilteredRpcTransport({
		transport: createIrohRpcTransport(options),
	});
}
