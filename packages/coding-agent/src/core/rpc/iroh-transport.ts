import { Buffer } from "node:buffer";
import { serializeJsonLine } from "./jsonl.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "./transport.ts";

export const DEFAULT_IROH_READ_LIMIT = 64 * 1024;

export type IrohBytes = Array<number> | Uint8Array;

export interface IrohRecvStreamLike {
	read(sizeLimit: number): Promise<IrohBytes | null | undefined>;
	stop?(errorCode: bigint): void | Promise<void>;
}

export interface IrohSendStreamLike {
	writeAll(bytes: Array<number>): Promise<void>;
	finish?(): Promise<void>;
	reset?(errorCode: bigint): void | Promise<void>;
}

export interface IrohBiStreamLike {
	recv: IrohRecvStreamLike;
	send: IrohSendStreamLike;
}

export interface IrohRpcTransportOptions {
	stream: IrohBiStreamLike;
	/** Bytes already read while handling a pre-RPC handshake. */
	initialInput?: IrohBytes;
	/** Maximum bytes requested per Iroh read. Defaults to 64 KiB. */
	readLimit?: number;
	/** Finish the send half during close. Defaults to true. */
	finishSendOnClose?: boolean;
	/** Stop the recv half during close. Defaults to true. */
	stopRecvOnClose?: boolean;
	/** Error code used for the recv stop helper. Defaults to 0. */
	closeErrorCode?: bigint;
}

/**
 * Create an RPC transport over an Iroh bidirectional stream.
 *
 * The transport preserves Volt RPC's strict LF-only JSONL framing and uses the
 * Iroh stream's write promises for backpressure. It is intentionally typed
 * structurally so callers can pass @number0/iroh BiStream values without making
 * the core RPC abstraction own endpoint lifecycle.
 */
export function createIrohRpcTransport(options: IrohRpcTransportOptions): RpcTransport {
	const lineHandlers = new Set<RpcLineHandler>();
	const closeHandlers = new Set<RpcCloseHandler>();
	const pendingWrites = new Set<Promise<void>>();
	let pendingWriteError: Error | undefined;
	let readLoopStarted = false;
	let localCloseRequested = false;
	let closeEmitted = false;
	let sendClosed = false;
	const readLimit = options.readLimit ?? DEFAULT_IROH_READ_LIMIT;
	const closeErrorCode = options.closeErrorCode ?? 0n;

	const recordWriteError = (error: unknown): Error => {
		const writeError = toError(error);
		pendingWriteError ??= writeError;
		return writeError;
	};

	const throwPendingWriteError = (): void => {
		if (!pendingWriteError) {
			return;
		}
		const writeError = pendingWriteError;
		pendingWriteError = undefined;
		throw writeError;
	};

	const waitForPendingWrites = async (): Promise<void> => {
		while (pendingWrites.size > 0) {
			await Promise.allSettled(pendingWrites);
		}
		throwPendingWriteError();
	};

	const emitClose = (error?: Error): void => {
		if (closeEmitted) {
			return;
		}
		closeEmitted = true;
		for (const handler of closeHandlers) {
			handler(error);
		}
	};

	const emitLine = (line: string): void => {
		const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		for (const handler of lineHandlers) {
			handler(normalizedLine);
		}
	};

	const startReadLoop = (): void => {
		if (readLoopStarted) {
			return;
		}
		readLoopStarted = true;
		void readIrohJsonl(options.stream.recv, readLimit, options.initialInput, emitLine).then(
			() => {
				if (!localCloseRequested) {
					emitClose();
				}
			},
			(error: unknown) => {
				if (!localCloseRequested) {
					emitClose(toError(error));
				}
			},
		);
	};

	return {
		write(value) {
			if (localCloseRequested || sendClosed) {
				throw new Error("Iroh RPC send stream is closed");
			}

			let rawWrite: Promise<void>;
			try {
				rawWrite = options.stream.send.writeAll(textToBytes(serializeJsonLine(value)));
			} catch (error: unknown) {
				throw recordWriteError(error);
			}

			const writePromise = rawWrite
				.catch((error: unknown) => {
					throw recordWriteError(error);
				})
				.finally(() => {
					pendingWrites.delete(writePromise);
				});
			pendingWrites.add(writePromise);
			return writePromise;
		},
		onLine(handler) {
			lineHandlers.add(handler);
			startReadLoop();
			return () => {
				lineHandlers.delete(handler);
			};
		},
		onClose(handler) {
			closeHandlers.add(handler);
			return () => {
				closeHandlers.delete(handler);
			};
		},
		waitForBackpressure: waitForPendingWrites,
		flush: waitForPendingWrites,
		async close() {
			localCloseRequested = true;
			let pendingWriteFailure: Error | undefined;
			try {
				await waitForPendingWrites();
			} catch (error: unknown) {
				pendingWriteFailure = toError(error);
			}

			const closeFailures: Error[] = [];
			if ((options.finishSendOnClose ?? true) && !sendClosed && options.stream.send.finish) {
				try {
					await options.stream.send.finish();
					sendClosed = true;
				} catch (error: unknown) {
					closeFailures.push(toError(error));
				}
			}
			if ((options.stopRecvOnClose ?? true) && options.stream.recv.stop) {
				try {
					await options.stream.recv.stop(closeErrorCode);
				} catch (error: unknown) {
					closeFailures.push(toError(error));
				}
			}
			if (pendingWriteFailure) {
				throw pendingWriteFailure;
			}
			if (closeFailures.length > 0) {
				throw closeFailures[0];
			}
		},
	};
}

async function readIrohJsonl(
	recv: IrohRecvStreamLike,
	readLimit: number,
	initialInput: IrohBytes | undefined,
	onLine: (line: string) => void,
): Promise<void> {
	let buffer = initialInput ? bytesToBuffer(initialInput) : Buffer.alloc(0);

	while (true) {
		while (true) {
			const newlineIndex = buffer.indexOf(10);
			if (newlineIndex === -1) {
				break;
			}

			const lineBuffer = buffer.subarray(0, newlineIndex);
			buffer = buffer.subarray(newlineIndex + 1);
			onLine(lineBuffer.toString("utf8"));
		}

		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			break;
		}
		buffer = Buffer.concat([buffer, bytesToBuffer(chunk)]);
	}

	if (buffer.length > 0) {
		onLine(buffer.toString("utf8"));
	}
}

function bytesToBuffer(bytes: IrohBytes): Buffer {
	if (Buffer.isBuffer(bytes)) {
		return bytes;
	}
	return Buffer.from(Array.from(bytes));
}

function textToBytes(text: string): Array<number> {
	return Array.from(Buffer.from(text, "utf8"));
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
