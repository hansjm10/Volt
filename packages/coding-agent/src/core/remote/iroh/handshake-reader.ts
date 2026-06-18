import { Buffer } from "node:buffer";
import {
	DEFAULT_IROH_READ_LIMIT,
	type IrohBytes,
	type IrohRecvStreamLike,
	type IrohSendStreamLike,
	serializeJsonLine,
} from "../../rpc/index.ts";
import type { IrohRemoteHandshakeResponse, IrohRemoteHello } from "./handshake.ts";

export const DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES = 16 * 1024;
export const DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface IrohRemoteHandshakeLineReadOptions {
	initialInput?: IrohBytes;
	maxLineBytes?: number;
	readLimit?: number;
	timeoutStopErrorCode?: bigint;
	timeoutMs?: number;
}

export interface IrohRemoteHandshakeLineReadResult {
	line: string | undefined;
	rest: IrohBytes;
}

export async function readIrohRemoteHandshakeLine(
	recv: IrohRecvStreamLike,
	options: IrohRemoteHandshakeLineReadOptions = {},
): Promise<IrohRemoteHandshakeLineReadResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS;
	return withTimeout(readBoundedIrohLine(recv, options), timeoutMs, "Iroh remote handshake timed out", () => {
		try {
			const stopResult = recv.stop?.(options.timeoutStopErrorCode ?? 0n);
			if (stopResult) {
				void Promise.resolve(stopResult).catch(() => {});
			}
		} catch {
			// Timeout cleanup is best-effort; callers should receive the timeout error.
		}
	});
}

export async function writeIrohRemoteHello(send: IrohSendStreamLike, hello: IrohRemoteHello): Promise<void> {
	await send.writeAll(textToBytes(serializeJsonLine(hello)));
}

export async function writeIrohRemoteHandshakeResponse(
	send: IrohSendStreamLike,
	response: IrohRemoteHandshakeResponse,
): Promise<void> {
	await send.writeAll(textToBytes(serializeJsonLine(response)));
}

async function readBoundedIrohLine(
	recv: IrohRecvStreamLike,
	options: IrohRemoteHandshakeLineReadOptions,
): Promise<IrohRemoteHandshakeLineReadResult> {
	const maxLineBytes = normalizePositiveInteger(
		options.maxLineBytes ?? DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES,
		"maxLineBytes",
	);
	const requestedReadLimit = normalizePositiveInteger(options.readLimit ?? DEFAULT_IROH_READ_LIMIT, "readLimit");
	const readLimit = Math.min(requestedReadLimit, maxLineBytes + 1);
	let buffer = options.initialInput ? bytesToBuffer(options.initialInput) : Buffer.alloc(0);

	while (true) {
		const newlineIndex = buffer.indexOf(10);
		if (newlineIndex !== -1) {
			let lineBuffer = buffer.subarray(0, newlineIndex);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			assertLineWithinLimit(lineBuffer.length, maxLineBytes);
			return {
				line: lineBuffer.toString("utf8"),
				rest: buffer.subarray(newlineIndex + 1),
			};
		}

		assertLineWithinLimit(buffer.length, maxLineBytes);
		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: buffer };
		}
		buffer = Buffer.concat([buffer, bytesToBuffer(chunk)]);
	}
}

function assertLineWithinLimit(length: number, maxLineBytes: number): void {
	if (length > maxLineBytes) {
		throw new Error(`Iroh remote handshake line exceeds maximum size of ${maxLineBytes} bytes`);
	}
}

function normalizePositiveInteger(value: number, label: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout: () => void,
): Promise<T> {
	normalizePositiveInteger(timeoutMs, "timeoutMs");
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(new Error(message));
					onTimeout();
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
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
