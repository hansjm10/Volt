import { PassThrough, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { serializeJsonLine } from "../src/core/rpc/jsonl.ts";
import {
	createJsonlRpcTransport,
	createJsonlStreamRpcTransport,
	type RpcTransport,
} from "../src/core/rpc/transport.ts";

function waitForTransportClose(transport: RpcTransport): Promise<void> {
	return new Promise((resolve) => {
		let detach: (() => void) | undefined;
		detach = transport.onClose?.(() => {
			detach?.();
			resolve();
		});
		if (!detach) {
			resolve();
		}
	});
}

describe("RPC transports", () => {
	test("serializes outbound values and reads strict JSONL input", async () => {
		const input = new PassThrough();
		const writtenLines: string[] = [];
		const transport = createJsonlRpcTransport({
			input,
			writeLine: (line) => {
				writtenLines.push(line);
			},
		});
		const receivedLines: string[] = [];

		transport.onLine((line) => {
			receivedLines.push(line);
		});
		const closed = waitForTransportClose(transport);

		transport.write({ text: "a\u2028b" });
		input.end(`${serializeJsonLine({ first: true })}{"text":"x\u2029y"}\r\n{"final":true}`);

		await closed;

		expect(writtenLines).toEqual([serializeJsonLine({ text: "a\u2028b" })]);
		expect(receivedLines).toEqual([
			JSON.stringify({ first: true }),
			'{"text":"x\u2029y"}',
			JSON.stringify({ final: true }),
		]);
	});

	test("returns async JSONL line write results", () => {
		const writePromise = Promise.resolve();
		const transport = createJsonlRpcTransport({
			input: new PassThrough(),
			writeLine: () => writePromise,
		});

		expect(transport.write({ ok: true })).toBe(writePromise);
	});

	test("adapts normal Node readable and writable streams", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const outputChunks: string[] = [];
		output.setEncoding("utf8");
		output.on("data", (chunk: string) => {
			outputChunks.push(chunk);
		});

		const transport = createJsonlStreamRpcTransport({ input, output });

		transport.write({ ok: true });
		await transport.flush?.();

		expect(outputChunks.join("")).toBe(serializeJsonLine({ ok: true }));
	});

	test("flush waits for asynchronous stream write callbacks", async () => {
		let completeWrite: (() => void) | undefined;
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				completeWrite = () => callback();
			},
		});
		const transport = createJsonlStreamRpcTransport({ input: new PassThrough(), output });

		const writeResult = transport.write({ ok: true });
		let flushed = false;
		const flushPromise = transport.flush?.().then(() => {
			flushed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(flushed).toBe(false);
		expect(completeWrite).toBeDefined();

		completeWrite?.();
		await writeResult;
		await flushPromise;

		expect(flushed).toBe(true);
	});

	test("surfaces asynchronous stream write errors", async () => {
		const writeError = new Error("write failed");
		let failWrite: (() => void) | undefined;
		const output = new Writable({
			write(_chunk, _encoding, callback) {
				failWrite = () => callback(writeError);
			},
		});
		output.on("error", () => undefined);
		const transport = createJsonlStreamRpcTransport({ input: new PassThrough(), output });

		const writeResult = transport.write({ ok: true });
		const flushPromise = transport.flush?.();
		if (!writeResult || !flushPromise) {
			throw new Error("Expected stream transport writes and flushes to return promises");
		}
		const writeExpectation = expect(writeResult).rejects.toBe(writeError);
		const flushExpectation = expect(flushPromise).rejects.toBe(writeError);

		expect(failWrite).toBeDefined();
		failWrite?.();

		await writeExpectation;
		await flushExpectation;
	});

	test("rejects pending writes when output closes before write callbacks", async () => {
		let receivedWrite = false;
		const output = new Writable({
			write(_chunk, _encoding, _callback) {
				receivedWrite = true;
			},
		});
		const transport = createJsonlStreamRpcTransport({ input: new PassThrough(), output });

		const writeResult = transport.write({ ok: true });
		const flushPromise = transport.flush?.();
		if (!writeResult || !flushPromise) {
			throw new Error("Expected stream transport writes and flushes to return promises");
		}
		const writeExpectation = expect(writeResult).rejects.toThrow(
			"RPC output stream closed before pending writes completed",
		);
		const flushExpectation = expect(flushPromise).rejects.toThrow(
			"RPC output stream closed before pending writes completed",
		);

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(receivedWrite).toBe(true);
		output.destroy();

		await writeExpectation;
		await flushExpectation;
	});

	test("reports input stream errors as close failures", async () => {
		const input = new PassThrough();
		const inputError = new Error("input failed");
		const transport = createJsonlRpcTransport({
			input,
			writeLine: () => {},
		});
		transport.onLine(() => {});
		const closed = new Promise<Error | undefined>((resolve) => {
			transport.onClose?.((error) => {
				resolve(error);
			});
		});

		input.destroy(inputError);

		await expect(closed).resolves.toBe(inputError);
	});

	test("can end an owned output stream on close", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createJsonlStreamRpcTransport({ input, output, closeOutput: true });

		await transport.close();

		expect(output.writableEnded).toBe(true);
	});
});
