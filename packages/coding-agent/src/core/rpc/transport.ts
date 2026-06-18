import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

export type RpcLineHandler = (line: string) => void;
export type RpcCloseHandler = (error?: Error) => void;

/** Transport used by Volt RPC protocol handlers. */
export interface RpcTransport {
	/** Write one outbound RPC object. Implementations own JSONL framing. */
	write(value: object): void | Promise<void>;
	/** Subscribe to inbound JSONL payload lines. */
	onLine(handler: RpcLineHandler): () => void;
	/** Subscribe to inbound transport close/end notification. */
	onClose?(handler: RpcCloseHandler): () => void;
	/** Wait until queued outbound writes have drained. */
	waitForBackpressure?(): Promise<void>;
	/** Flush outbound writes before shutdown when supported. */
	flush?(): Promise<void>;
	/** Close transport resources owned by the adapter. */
	close(): void | Promise<void>;
}

export interface JsonlRpcTransportOptions {
	input: Readable;
	writeLine: (line: string) => void | Promise<void>;
	waitForBackpressure?: () => Promise<void>;
	flush?: () => Promise<void>;
	close?: () => void | Promise<void>;
}

/**
 * Create an RPC transport from an input stream and a JSONL line writer.
 *
 * This is useful when stdout is guarded or virtualized and cannot be represented
 * as a normal Node Writable.
 */
export function createJsonlRpcTransport(options: JsonlRpcTransportOptions): RpcTransport {
	return {
		write(value) {
			return options.writeLine(serializeJsonLine(value));
		},
		onLine(handler) {
			return attachJsonlLineReader(options.input, handler);
		},
		onClose(handler) {
			return attachReadableCloseHandler(options.input, handler);
		},
		waitForBackpressure: options.waitForBackpressure,
		flush: options.flush,
		close() {
			return options.close?.();
		},
	};
}

export interface JsonlStreamRpcTransportOptions {
	input: Readable;
	output: Writable;
	/** End the output stream when `close()` is called. Defaults to false. */
	closeOutput?: boolean;
}

/** Create an RPC transport from normal Node readable/writable streams. */
export function createJsonlStreamRpcTransport(options: JsonlStreamRpcTransportOptions): RpcTransport {
	const pendingWrites = new Set<Promise<void>>();
	const pendingWriteRejects = new Set<(error: Error) => void>();
	let pendingWriteError: Error | undefined;

	const recordWriteError = (error: unknown): Error => {
		const writeError = error instanceof Error ? error : new Error(String(error));
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

	const rejectPendingWrites = (error: Error): void => {
		for (const reject of pendingWriteRejects) {
			reject(error);
		}
	};

	const onOutputError = (error: Error): void => {
		rejectPendingWrites(recordWriteError(error));
	};
	const onOutputClose = (): void => {
		if (pendingWrites.size === 0) {
			return;
		}
		rejectPendingWrites(recordWriteError(new Error("RPC output stream closed before pending writes completed")));
	};
	options.output.on("error", onOutputError);
	options.output.on("close", onOutputClose);

	const trackPendingWrite = (writeComplete: Promise<void>, rejectWrite: (error: Error) => void): Promise<void> => {
		pendingWrites.add(writeComplete);
		pendingWriteRejects.add(rejectWrite);
		void writeComplete.then(
			() => {
				pendingWrites.delete(writeComplete);
				pendingWriteRejects.delete(rejectWrite);
			},
			() => {
				pendingWrites.delete(writeComplete);
				pendingWriteRejects.delete(rejectWrite);
			},
		);
		return writeComplete;
	};

	const waitForPendingWrites = async (): Promise<void> => {
		while (pendingWrites.size > 0) {
			await Promise.allSettled(pendingWrites);
		}
		throwPendingWriteError();
	};

	const writeLine = (line: string): Promise<void> => {
		if (options.output.destroyed || !options.output.writable) {
			throw new Error("RPC output stream is not writable");
		}

		let resolveWrite: () => void;
		let rejectWrite: (error: Error) => void;
		const writeComplete = new Promise<void>((resolve, reject) => {
			resolveWrite = resolve;
			rejectWrite = reject;
		});
		trackPendingWrite(writeComplete, rejectWrite!);

		try {
			options.output.write(line, (error) => {
				if (error) {
					rejectWrite!(recordWriteError(error));
					return;
				}
				resolveWrite!();
			});
		} catch (error: unknown) {
			const writeError = recordWriteError(error);
			rejectWrite!(writeError);
			throw writeError;
		}

		return writeComplete;
	};

	return createJsonlRpcTransport({
		input: options.input,
		writeLine,
		waitForBackpressure: waitForPendingWrites,
		flush: waitForPendingWrites,
		close: async () => {
			try {
				if (!options.closeOutput || options.output.destroyed || options.output.writableEnded) {
					return;
				}

				options.output.end();
				if (!options.output.writableFinished) {
					await once(options.output, "finish");
				}
			} finally {
				options.output.off("error", onOutputError);
				options.output.off("close", onOutputClose);
			}
		},
	});
}

function attachReadableCloseHandler(input: Readable, handler: RpcCloseHandler): () => void {
	let closed = false;

	const onClose = (error?: Error) => {
		if (closed) {
			return;
		}
		closed = true;
		handler(error);
	};
	const onEnd = () => {
		onClose();
	};
	const onStreamClose = () => {
		onClose();
	};
	const onError = (error: Error) => {
		onClose(error);
	};

	input.once("end", onEnd);
	input.once("close", onStreamClose);
	input.once("error", onError);

	return () => {
		input.off("end", onEnd);
		input.off("close", onStreamClose);
		input.off("error", onError);
	};
}
