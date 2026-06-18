import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
	createIrohRpcTransport,
	type IrohBytes,
	type IrohRecvStreamLike,
	type IrohSendStreamLike,
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
		recv.push(Buffer.from('\n{"final":true}'));
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
});
