import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/index.ts";
import { RpcTransportClient } from "../src/modes/index.ts";
import {
	type IrohRemoteClientIo,
	parseIrohRemoteClientArgs,
	runIrohRemoteClientRpcSession,
} from "../src/remote/iroh-client.ts";

class MemoryWritable extends Writable {
	private readonly chunks: string[] = [];

	text(): string {
		return this.chunks.join("");
	}

	override _write(
		chunk: Buffer | Uint8Array | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		callback();
	}
}

describe("remote client args", () => {
	test("defaults to interactive mode only on TTYs", () => {
		expect(parseIrohRemoteClientArgs(["ticket"], true)).toMatchObject({
			mode: "interactive",
			ticket: "ticket",
		});
		expect(parseIrohRemoteClientArgs(["ticket"], false).error).toContain("--message");
	});

	test("parses one-shot options and rejects conflicting modes", () => {
		expect(
			parseIrohRemoteClientArgs(
				["ticket", "--message", "hello", "--timeout-ms", "50", "--client-label", "phone", "--verbose"],
				false,
			),
		).toMatchObject({
			clientLabel: "phone",
			message: "hello",
			mode: "message",
			timeoutMs: 50,
			verbose: true,
		});
		expect(parseIrohRemoteClientArgs(["ticket", "--message", "hello", "--get-state"], false).error).toContain(
			"Choose only one",
		);
	});
});

describe("remote client RPC session", () => {
	test("prints get_state JSON over RpcTransportClient", async () => {
		const { client, pair } = await createStartedLoopbackClient();
		pair.server.onLine((line) => {
			const command = parseRpcObject(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: {
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: "remote-session",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			});
		});
		const { io, output } = createTestIo();

		try {
			await expect(
				runIrohRemoteClientRpcSession(
					client,
					{
						mode: "get-state",
						timeoutMs: 100,
						verbose: false,
					},
					io,
				),
			).resolves.toBe(0);
			expect(JSON.parse(output.text())).toMatchObject({ sessionId: "remote-session" });
		} finally {
			await client.stop();
		}
	});

	test("prints streamed prompt text and tool summaries", async () => {
		const { client, pair } = await createStartedLoopbackClient();
		pair.server.onLine((line) => {
			const command = parseRpcObject(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
			});
			pair.server.write({ type: "agent_start" });
			pair.server.write({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello remote" },
			});
			pair.server.write({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			});
			pair.server.write({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: {},
				isError: false,
			});
			pair.server.write({ type: "agent_end", messages: [], willRetry: false });
		});
		const { error, io, output } = createTestIo();

		try {
			await expect(
				runIrohRemoteClientRpcSession(
					client,
					{
						message: "hello",
						mode: "message",
						timeoutMs: 100,
						verbose: false,
					},
					io,
				),
			).resolves.toBe(0);
			expect(output.text()).toBe("hello remote\n");
			expect(error.text()).toContain("[tool:start] read");
			expect(error.text()).toContain("[tool:end] read ok");
		} finally {
			await client.stop();
		}
	});

	test("cancels blocking extension UI requests", async () => {
		let promptId: unknown;
		let cancellation: Record<string, unknown> | undefined;
		const { client, pair } = await createStartedLoopbackClient();
		pair.server.onLine((line) => {
			const command = parseRpcObject(line);
			if (command.type === "prompt") {
				promptId = command.id;
				pair.server.write({
					type: "extension_ui_request",
					id: "ui-1",
					method: "confirm",
					title: "Approve",
					message: "Continue?",
				});
				return;
			}
			if (command.type === "extension_ui_response") {
				cancellation = command;
				pair.server.write({
					id: promptId,
					type: "response",
					command: "prompt",
					success: true,
				});
				pair.server.write({ type: "agent_end", messages: [], willRetry: false });
			}
		});
		const { error, io } = createTestIo();

		try {
			await expect(
				runIrohRemoteClientRpcSession(
					client,
					{
						message: "hello",
						mode: "message",
						timeoutMs: 100,
						verbose: false,
					},
					io,
				),
			).resolves.toBe(0);
			expect(cancellation).toMatchObject({
				type: "extension_ui_response",
				id: "ui-1",
				cancelled: true,
			});
			expect(error.text()).toContain("confirm request cancelled");
		} finally {
			await client.stop();
		}
	});
});

async function createStartedLoopbackClient(): Promise<{
	client: RpcTransportClient;
	pair: ReturnType<typeof createLoopbackRpcTransportPair>;
}> {
	const pair = createLoopbackRpcTransportPair();
	const client = new RpcTransportClient({ transport: pair.client, requestTimeoutMs: 100 });
	await client.start();
	return { client, pair };
}

function createTestIo(): { error: MemoryWritable; io: IrohRemoteClientIo; output: MemoryWritable } {
	const output = new MemoryWritable();
	const error = new MemoryWritable();
	return {
		error,
		io: {
			error,
			input: Readable.from([]),
			inputIsTTY: false,
			output,
		},
		output,
	};
}

function parseRpcObject(line: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("RPC line must be an object");
	}
	return parsed as Record<string, unknown>;
}
