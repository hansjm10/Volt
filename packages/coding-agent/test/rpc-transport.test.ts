import { PassThrough } from "node:stream";
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

	test("can end an owned output stream on close", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createJsonlStreamRpcTransport({ input, output, closeOutput: true });

		await transport.close();

		expect(output.writableEnded).toBe(true);
	});
});
