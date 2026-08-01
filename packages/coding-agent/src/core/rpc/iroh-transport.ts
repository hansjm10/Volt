import { Buffer } from "node:buffer";
import { serializeJsonLine } from "./jsonl.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "./transport.ts";

import { DEFAULT_IROH_RPC_MAX_LINE_BYTES } from "./wire-limits.ts";

export const DEFAULT_IROH_READ_LIMIT = 64 * 1024;
export { DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES, DEFAULT_IROH_RPC_MAX_LINE_BYTES } from "./wire-limits.ts";

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
	/** Maximum JSON content bytes allowed in one inbound or outbound line. Defaults to 4 MiB minus LF. */
	maxLineBytes?: number;
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
	let writeQueue: Promise<void> | undefined;
	let pendingWriteError: Error | undefined;
	let readLoopStarted = false;
	let localCloseRequested = false;
	let closeEmitted = false;
	let sendClosed = false;
	const requestedReadLimit = normalizePositiveInteger(options.readLimit ?? DEFAULT_IROH_READ_LIMIT, "readLimit");
	const maxLineBytes = normalizePositiveInteger(
		options.maxLineBytes ?? DEFAULT_IROH_RPC_MAX_LINE_BYTES,
		"maxLineBytes",
	);
	const readLimit = Math.min(requestedReadLimit, maxLineBytes + 1);
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

	const emitLine = async (line: string): Promise<void> => {
		const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		for (const handler of lineHandlers) {
			await handler(normalizedLine);
		}
	};

	const startReadLoop = (): void => {
		if (readLoopStarted) {
			return;
		}
		readLoopStarted = true;
		void readIrohJsonl(options.stream.recv, readLimit, maxLineBytes, options.initialInput, emitLine).then(
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

			const serialized = serializeJsonLine(value);
			const serializedBytes = Buffer.from(serialized, "utf8");
			assertIrohRpcLineWithinLimit(serializedBytes.length - 1, maxLineBytes);
			const bytes = Array.from(serializedBytes);
			const runWrite = (): Promise<void> => {
				try {
					return options.stream.send.writeAll(bytes);
				} catch (error: unknown) {
					throw recordWriteError(error);
				}
			};
			const queuedAfter = writeQueue;
			const rawWrite = queuedAfter ? queuedAfter.then(runWrite) : runWrite();
			const writePromise = rawWrite
				.catch((error: unknown) => {
					throw recordWriteError(error);
				})
				.finally(() => {
					pendingWrites.delete(writePromise);
					if (writeQueue === writePromise) {
						writeQueue = undefined;
					}
				});
			pendingWrites.add(writePromise);
			writeQueue = writePromise;
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
					const stopPromise = options.stream.recv.stop(closeErrorCode);
					if (!readLoopStarted && stopPromise) {
						await stopPromise;
					} else if (stopPromise) {
						// Iroh read() and stop() share a stream lock; do not block local shutdown behind the read loop.
						void stopPromise.catch(() => {});
					}
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
	maxLineBytes: number,
	initialInput: IrohBytes | undefined,
	onLine: (line: string) => void | Promise<void>,
): Promise<void> {
	let buffer = initialInput ? copyBytesToBuffer(initialInput) : Buffer.alloc(0);
	while (true) {
		const result = await readIrohJsonlLine(recv, buffer, { readLimit, maxLineBytes });
		if (result.line === undefined) {
			// JSONL frames are complete only after LF. Discard an unterminated
			// suffix on EOF; a peer failure must never promote partial bytes into
			// an RPC command or let them contaminate a replacement stream.
			break;
		}
		await onLine(result.line);
		buffer = result.rest;
	}
}

export interface ReadIrohJsonlLineOptions {
	/** Maximum bytes requested per Iroh read. Defaults to 64 KiB. */
	readLimit?: number;
	/** Maximum bytes allowed before the LF delimiter. Defaults to 4 MiB minus LF. */
	maxLineBytes?: number;
}

/**
 * Read one bounded JSONL line without repeatedly concatenating an attacker-
 * controlled partial line. The geometric accumulator performs linear total
 * copying while retaining at most maxLineBytes of partial-line storage.
 */
export async function readIrohJsonlLine(
	recv: IrohRecvStreamLike,
	initialInput: IrohBytes = Buffer.alloc(0),
	options: ReadIrohJsonlLineOptions = {},
): Promise<{ line: string | undefined; rest: Buffer }> {
	const maxLineBytes = normalizePositiveInteger(
		options.maxLineBytes ?? DEFAULT_IROH_RPC_MAX_LINE_BYTES,
		"maxLineBytes",
	);
	const requestedReadLimit = normalizePositiveInteger(options.readLimit ?? DEFAULT_IROH_READ_LIMIT, "readLimit");
	const readLimit = Math.min(requestedReadLimit, maxLineBytes + 1);
	const accumulator = new BoundedLineAccumulator(maxLineBytes);
	let input = bytesToBuffer(initialInput);

	while (true) {
		const newlineIndex = input.indexOf(10);
		if (newlineIndex !== -1) {
			accumulator.append(input.subarray(0, newlineIndex));
			return {
				line: normalizeJsonlLine(accumulator.take()).toString("utf8"),
				// Iroh reads are already capped. Keep an immutable view over the
				// unread suffix so a chunk containing many short lines is consumed
				// linearly instead of copying its shrinking remainder for every line.
				rest: input.subarray(newlineIndex + 1),
			};
		}

		accumulator.append(input);
		const remainingBytes = maxLineBytes - accumulator.length;
		const nextReadLimit = Math.min(readLimit, remainingBytes + 1);
		const chunk = await recv.read(nextReadLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: accumulator.take() };
		}
		if (chunk.length > nextReadLimit) {
			throw new Error(`Iroh recv returned ${chunk.length} bytes for a ${nextReadLimit}-byte read`);
		}
		input = bytesToBuffer(chunk);
	}
}

class BoundedLineAccumulator {
	private readonly maxLineBytes: number;
	private storage = Buffer.alloc(0);
	private used = 0;

	constructor(maxLineBytes: number) {
		this.maxLineBytes = maxLineBytes;
	}

	get length(): number {
		return this.used;
	}

	append(bytes: Buffer): void {
		const nextLength = this.used + bytes.length;
		assertIrohRpcLineWithinLimit(nextLength, this.maxLineBytes);
		if (bytes.length === 0) {
			return;
		}
		if (nextLength > this.storage.length) {
			let nextCapacity = Math.max(1, this.storage.length);
			while (nextCapacity < nextLength) {
				nextCapacity = Math.min(this.maxLineBytes, Math.max(nextLength, nextCapacity * 2));
			}
			const grown = Buffer.allocUnsafe(nextCapacity);
			this.storage.copy(grown, 0, 0, this.used);
			this.storage = grown;
		}
		bytes.copy(this.storage, this.used);
		this.used = nextLength;
	}

	take(): Buffer {
		const result = Buffer.from(this.storage.subarray(0, this.used));
		this.storage = Buffer.alloc(0);
		this.used = 0;
		return result;
	}
}

function normalizeJsonlLine(line: Buffer): Buffer {
	return line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, line.length - 1) : line;
}

function assertIrohRpcLineWithinLimit(length: number, maxLineBytes: number): void {
	if (length > maxLineBytes) {
		throw new Error(`Iroh RPC line exceeds maximum size of ${maxLineBytes} bytes`);
	}
}

function normalizePositiveInteger(value: number, label: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function bytesToBuffer(bytes: IrohBytes): Buffer {
	if (Buffer.isBuffer(bytes)) {
		return bytes;
	}
	return Buffer.from(bytes);
}

function copyBytesToBuffer(bytes: IrohBytes): Buffer {
	return Buffer.from(bytesToBuffer(bytes));
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
