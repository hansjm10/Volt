import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

export type RpcLineHandler = (line: string) => void;
export type RpcCloseHandler = () => void;

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
	let pendingDrain: Promise<void> | undefined;

	const waitForBackpressure = async (): Promise<void> => {
		while (pendingDrain) {
			await pendingDrain;
		}
	};

	const writeLine = (line: string): void => {
		if (options.output.destroyed || !options.output.writable) {
			throw new Error("RPC output stream is not writable");
		}

		const canContinue = options.output.write(line);
		if (!canContinue && !pendingDrain) {
			pendingDrain = once(options.output, "drain")
				.then(() => undefined)
				.finally(() => {
					pendingDrain = undefined;
				});
		}
	};

	return createJsonlRpcTransport({
		input: options.input,
		writeLine,
		waitForBackpressure,
		flush: waitForBackpressure,
		close: async () => {
			if (!options.closeOutput || options.output.destroyed || options.output.writableEnded) {
				return;
			}

			options.output.end();
			if (!options.output.writableFinished) {
				await once(options.output, "finish");
			}
		},
	});
}

function attachReadableCloseHandler(input: Readable, handler: RpcCloseHandler): () => void {
	let closed = false;

	const onClose = () => {
		if (closed) {
			return;
		}
		closed = true;
		handler();
	};

	input.once("end", onClose);
	input.once("close", onClose);

	return () => {
		input.off("end", onClose);
		input.off("close", onClose);
	};
}
