import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { createIrohRemoteFilteredRpcTransport } from "../src/core/remote/iroh/rpc-transport.ts";
import {
	createIrohRpcTransport,
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	type IrohBytes,
	type IrohRecvStreamLike,
	type IrohSendStreamLike,
	readIrohJsonlLine,
} from "../src/core/rpc/iroh-transport.ts";
import { serializeJsonLine } from "../src/core/rpc/jsonl.ts";
import type { RpcTransport } from "../src/core/rpc/transport.ts";

type QueuedRead = { type: "data"; bytes: IrohBytes } | { type: "end" } | { type: "error"; error: Error };

interface PendingRead {
	resolve(value: IrohBytes | undefined): void;
	reject(error: Error): void;
}

class ManualIrohRecvStream implements IrohRecvStreamLike {
	readonly stopCalls: bigint[] = [];
	private readonly queue: QueuedRead[] = [];
	private readonly readers: PendingRead[] = [];

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		const queued = this.queue.shift();
		if (queued) {
			return this.resolveQueued(queued);
		}

		return new Promise((resolve, reject) => {
			this.readers.push({ resolve, reject });
		});
	}

	push(bytes: IrohBytes): void {
		this.enqueue({ type: "data", bytes });
	}

	end(): void {
		this.enqueue({ type: "end" });
	}

	fail(error: Error): void {
		this.enqueue({ type: "error", error });
	}

	async stop(errorCode: bigint): Promise<void> {
		this.stopCalls.push(errorCode);
		this.end();
	}

	private enqueue(queued: QueuedRead): void {
		const reader = this.readers.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}

		if (queued.type === "data") {
			reader.resolve(queued.bytes);
		} else if (queued.type === "end") {
			reader.resolve(undefined);
		} else {
			reader.reject(queued.error);
		}
	}

	private resolveQueued(queued: QueuedRead): Promise<IrohBytes | undefined> {
		if (queued.type === "data") {
			return Promise.resolve(queued.bytes);
		}
		if (queued.type === "end") {
			return Promise.resolve(undefined);
		}
		return Promise.reject(queued.error);
	}
}

class BlockingStopIrohRecvStream implements IrohRecvStreamLike {
	readonly stopCalls: bigint[] = [];
	readonly readStarted: Promise<void>;
	private resolveReadStarted: (() => void) | undefined;
	private resolveRead: ((value: IrohBytes | undefined) => void) | undefined;
	private resolveStop: (() => void) | undefined;

	constructor() {
		this.readStarted = new Promise((resolve) => {
			this.resolveReadStarted = resolve;
		});
	}

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		this.resolveReadStarted?.();
		this.resolveReadStarted = undefined;
		return new Promise((resolve) => {
			this.resolveRead = resolve;
		});
	}

	stop(errorCode: bigint): Promise<void> {
		this.stopCalls.push(errorCode);
		return new Promise((resolve) => {
			this.resolveStop = resolve;
		});
	}

	endRead(): void {
		this.resolveRead?.(undefined);
		this.resolveRead = undefined;
	}

	finishStop(): void {
		this.resolveStop?.();
		this.resolveStop = undefined;
	}
}

class FragmentedIrohRecvStream implements IrohRecvStreamLike {
	readonly requestedReadLimits: number[] = [];
	private readonly bytes: Buffer;
	private readonly fragmentBytes: number;
	private offset = 0;

	constructor(bytes: Buffer, fragmentBytes: number) {
		this.bytes = bytes;
		this.fragmentBytes = fragmentBytes;
	}

	read(sizeLimit: number): Promise<IrohBytes | undefined> {
		this.requestedReadLimits.push(sizeLimit);
		if (this.offset >= this.bytes.length) {
			return Promise.resolve(undefined);
		}
		const end = Math.min(this.bytes.length, this.offset + this.fragmentBytes, this.offset + sizeLimit);
		const chunk = this.bytes.subarray(this.offset, end);
		this.offset = end;
		return Promise.resolve(chunk);
	}
}

interface DeferredWrite {
	resolve(): void;
	reject(error: Error): void;
}

class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];
	finishCalls = 0;
	resetCalls: bigint[] = [];
	private deferNext = false;
	private deferredWrite: DeferredWrite | undefined;

	writeAll(bytes: Array<number>): Promise<void> {
		this.writes.push(bytes);
		if (!this.deferNext) {
			return Promise.resolve();
		}

		this.deferNext = false;
		return new Promise((resolve, reject) => {
			this.deferredWrite = { resolve, reject };
		});
	}

	deferNextWrite(): void {
		this.deferNext = true;
	}

	completeWrite(): void {
		const deferred = this.deferredWrite;
		if (!deferred) {
			throw new Error("No deferred write to complete");
		}
		this.deferredWrite = undefined;
		deferred.resolve();
	}

	failWrite(error: Error): void {
		const deferred = this.deferredWrite;
		if (!deferred) {
			throw new Error("No deferred write to fail");
		}
		this.deferredWrite = undefined;
		deferred.reject(error);
	}

	async finish(): Promise<void> {
		this.finishCalls++;
	}

	async reset(errorCode: bigint): Promise<void> {
		this.resetCalls.push(errorCode);
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

function waitForTransportClose(transport: RpcTransport): Promise<Error | undefined> {
	return new Promise((resolve) => {
		transport.onClose?.((error) => {
			resolve(error);
		});
	});
}

function nextTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("Iroh RPC transport", () => {
	test("matches volt-app's 4 MiB encoded JSONL ceiling including the LF", () => {
		expect(DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES).toBe(4 * 1024 * 1024);
		expect(DEFAULT_IROH_RPC_MAX_LINE_BYTES).toBe(DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES - 1);
	});

	test("reads a maximally fragmented line with bounded remaining-byte reads", async () => {
		const recv = new FragmentedIrohRecvStream(Buffer.from(`${"a".repeat(4096)}\nrest`), 1);

		await expect(readIrohJsonlLine(recv, undefined, { maxLineBytes: 4096 })).resolves.toEqual({
			line: "a".repeat(4096),
			rest: Buffer.alloc(0),
		});
		expect(recv.requestedReadLimits.at(-1)).toBe(1);
	});

	test("rejects a fragmented partial line as soon as it crosses the ceiling", async () => {
		const recv = new FragmentedIrohRecvStream(Buffer.from("a".repeat(4097)), 1);

		await expect(readIrohJsonlLine(recv, undefined, { maxLineBytes: 4096 })).rejects.toThrow(
			"Iroh RPC line exceeds maximum size of 4096 bytes",
		);
		expect(recv.requestedReadLimits.at(-1)).toBe(1);
	});

	test("consumes many short lines without copying each shrinking remainder", async () => {
		const lineCount = 8192;
		const input = Buffer.from("x\n".repeat(lineCount));
		let readCalls = 0;
		const recv: IrohRecvStreamLike = {
			read: async () => {
				readCalls++;
				return undefined;
			},
		};
		let rest: Buffer = input;

		for (let index = 0; index < lineCount; index++) {
			const result = await readIrohJsonlLine(recv, rest);
			expect(result.line).toBe("x");
			expect(result.rest.buffer).toBe(input.buffer);
			rest = result.rest;
		}

		expect(rest).toHaveLength(0);
		expect(readCalls).toBe(0);
	});

	test("does not dispatch another short line until its async handler completes", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		let releaseFirstLine: (() => void) | undefined;
		const firstLineGate = new Promise<void>((resolve) => {
			releaseFirstLine = resolve;
		});
		const receivedLines: string[] = [];
		transport.onLine(async (line) => {
			receivedLines.push(line);
			if (receivedLines.length === 1) {
				await firstLineGate;
			}
		});
		const closed = waitForTransportClose(transport);
		recv.push(Buffer.from("{}\n".repeat(4096)));
		recv.end();

		await nextTick();
		expect(receivedLines).toEqual(["{}"]);

		releaseFirstLine?.();
		await expect(closed).resolves.toBeUndefined();
		expect(receivedLines).toHaveLength(4096);
	});

	test("waits for each filtered parse-error write before dispatching the next line", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const rawTransport = createIrohRpcTransport({ stream: { recv, send } });
		const transport = createIrohRemoteFilteredRpcTransport({
			transport: rawTransport,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		});
		transport.onLine(() => {
			throw new Error("empty lines must be rejected before RPC dispatch");
		});
		const closed = waitForTransportClose(transport);
		send.deferNextWrite();
		recv.push(Buffer.from("\n".repeat(4096)));
		recv.end();

		await nextTick();
		expect(send.writes).toHaveLength(1);

		send.completeWrite();
		await expect(closed).resolves.toBeUndefined();
		expect(send.writes).toHaveLength(4096);
	});

	test("serializes outbound values and reads strict JSONL from an Iroh stream", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({
			stream: { recv, send },
			initialInput: Buffer.from(serializeJsonLine({ initial: true })),
		});
		const receivedLines: string[] = [];
		transport.onLine((line) => {
			receivedLines.push(line);
		});
		const closed = waitForTransportClose(transport);

		await transport.write({ text: "a\u2028b" });
		recv.push(Buffer.from(`${serializeJsonLine({ first: true })}{"text":"x\u2029y"}\r`));
		recv.push(Buffer.from('\n{"final":true}\n'));
		recv.end();

		await expect(closed).resolves.toBeUndefined();
		expect(send.writtenText()).toBe(serializeJsonLine({ text: "a\u2028b" }));
		expect(receivedLines).toEqual([
			JSON.stringify({ initial: true }),
			JSON.stringify({ first: true }),
			'{"text":"x\u2029y"}',
			JSON.stringify({ final: true }),
		]);
	});

	test("rejects Iroh RPC lines that exceed the configured maximum", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send }, maxLineBytes: 4 });
		transport.onLine(() => {
			throw new Error("oversized lines must not be delivered");
		});
		const closed = waitForTransportClose(transport);

		recv.push(Buffer.from("abcde"));
		recv.end();

		await expect(closed).resolves.toMatchObject({
			message: "Iroh RPC line exceeds maximum size of 4 bytes",
		});
	});

	test("rejects outbound JSONL lines that exceed the configured maximum", () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send }, maxLineBytes: 4 });

		expect(() => transport.write({ ok: true })).toThrow("Iroh RPC line exceeds maximum size of 4 bytes");
		expect(send.writes).toEqual([]);
	});

	test("flush waits for pending Iroh writes", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		send.deferNextWrite();

		const writePromise = transport.write({ ok: true });
		let flushed = false;
		const flushPromise = transport.flush?.().then(() => {
			flushed = true;
		});
		await nextTick();

		expect(flushed).toBe(false);

		send.completeWrite();
		await writePromise;
		await flushPromise;

		expect(flushed).toBe(true);
	});

	test("queues outbound Iroh writes before calling writeAll", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		send.deferNextWrite();

		const firstWrite = transport.write({ sequence: 1 });
		const secondWrite = transport.write({ sequence: 2 });
		await nextTick();

		expect(send.writtenText()).toBe(serializeJsonLine({ sequence: 1 }));

		send.completeWrite();
		await Promise.all([firstWrite, secondWrite]);

		expect(send.writtenText()).toBe(`${serializeJsonLine({ sequence: 1 })}${serializeJsonLine({ sequence: 2 })}`);
	});

	test("surfaces Iroh write failures through write and flush", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		const writeError = new Error("write failed");
		send.deferNextWrite();

		const writePromise = transport.write({ ok: false });
		const flushPromise = transport.flush?.();
		send.failWrite(writeError);

		await expect(writePromise).rejects.toBe(writeError);
		await expect(flushPromise).rejects.toBe(writeError);
	});

	test("drops a partial frame on read failure and gives its replacement clean framing", async () => {
		const failedRecv = new ManualIrohRecvStream();
		const failedTransport = createIrohRpcTransport({
			stream: { recv: failedRecv, send: new ManualIrohSendStream() },
		});
		const readError = new Error("injected read failure after partial frame");
		const failedLines: string[] = [];
		const closeErrors: Array<Error | undefined> = [];
		failedTransport.onLine((line) => {
			failedLines.push(line);
		});
		const failedClose = new Promise<void>((resolve) => {
			failedTransport.onClose?.((error) => {
				closeErrors.push(error);
				resolve();
			});
		});

		failedRecv.push(Buffer.from('{"id":"partial","type":"get_state"'));
		failedRecv.fail(readError);
		failedRecv.end();

		await failedClose;
		expect(failedLines).toEqual([]);
		expect(closeErrors).toEqual([readError]);

		const replacementRecv = new ManualIrohRecvStream();
		const replacementTransport = createIrohRpcTransport({
			stream: { recv: replacementRecv, send: new ManualIrohSendStream() },
		});
		const replacementLines: string[] = [];
		replacementTransport.onLine((line) => {
			replacementLines.push(line);
		});
		const replacementClose = waitForTransportClose(replacementTransport);

		replacementRecv.push(Buffer.from('{"id":"fresh","type":"get_state"}\n'));
		replacementRecv.end();

		await expect(replacementClose).resolves.toBeUndefined();
		expect(replacementLines).toEqual(['{"id":"fresh","type":"get_state"}']);
	});

	test("does not dispatch an unterminated frame on clean EOF", async () => {
		const recv = new ManualIrohRecvStream();
		const transport = createIrohRpcTransport({ stream: { recv, send: new ManualIrohSendStream() } });
		const receivedLines: string[] = [];
		transport.onLine((line) => {
			receivedLines.push(line);
		});
		const closed = waitForTransportClose(transport);

		recv.push(Buffer.from('{"id":"partial","type":"get_state"'));
		recv.end();

		await expect(closed).resolves.toBeUndefined();
		expect(receivedLines).toEqual([]);
	});

	test("reports Iroh read errors as close failures", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		const readError = new Error("read failed");
		transport.onLine(() => {});
		const closed = waitForTransportClose(transport);

		recv.fail(readError);

		await expect(closed).resolves.toBe(readError);
	});

	test("close finishes the send half and stops the recv half", async () => {
		const recv = new ManualIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });

		await transport.close();

		expect(send.finishCalls).toBe(1);
		expect(recv.stopCalls).toEqual([0n]);
	});

	test("close does not wait for recv stop while the read loop is blocked", async () => {
		const recv = new BlockingStopIrohRecvStream();
		const send = new ManualIrohSendStream();
		const transport = createIrohRpcTransport({ stream: { recv, send } });
		transport.onLine(() => {});
		await recv.readStarted;

		let closeResolved = false;
		const closePromise = Promise.resolve(transport.close()).then(() => {
			closeResolved = true;
		});
		await nextTick();
		const resolvedBeforeStopFinished = closeResolved;
		recv.finishStop();
		recv.endRead();
		await closePromise;

		expect(resolvedBeforeStopFinished).toBe(true);
		expect(send.finishCalls).toBe(1);
		expect(recv.stopCalls).toEqual([0n]);
	});
});
