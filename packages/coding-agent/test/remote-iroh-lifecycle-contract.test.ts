import { describe, expect, test } from "vitest";
import {
	getIrohRemoteRpcFilterResult,
	IROH_REMOTE_RPC_CANCELLATION_TYPES,
	IROH_REMOTE_RPC_PASSTHROUGH_TYPES,
} from "../src/core/remote/iroh/index.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../src/core/rpc/index.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

class ManualRpcTransport implements RpcTransport {
	readonly writes: object[] = [];
	readonly lineHandlers = new Set<RpcLineHandler>();
	readonly closeHandlers = new Set<RpcCloseHandler>();

	write(value: object): void {
		this.writes.push(value);
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	onClose(handler: RpcCloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	close(): void {}

	emitClose(error?: Error): void {
		for (const handler of this.closeHandlers) {
			handler(error);
		}
	}
}

describe("Iroh remote lifecycle command contract", () => {
	test("allows abort as the only direct remote cancellation command", () => {
		expect(Array.from(IROH_REMOTE_RPC_CANCELLATION_TYPES)).toEqual(["abort"]);
		expect(IROH_REMOTE_RPC_PASSTHROUGH_TYPES.has("abort")).toBe(true);

		expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: "abort-1", type: "abort" }))).toEqual({
			allowed: true,
			command: { id: "abort-1", type: "abort" },
		});

		for (const command of ["cancel", "cancel_run", "detach", "disconnect", "stop"] as const) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${command}-1`, type: command }))).toEqual({
				allowed: false,
				response: {
					id: `${command}-1`,
					type: "response",
					command,
					success: false,
					error: `RPC command not allowed over remote host: ${command}`,
				},
			});
		}
	});

	test("clean transport close is not translated into an abort command", async () => {
		const inner = new ManualRpcTransport();
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: inner,
			waitForPromptCompletion: () => Promise.resolve(),
		});
		const forwardedLines: string[] = [];
		const closeErrors: Array<Error | undefined> = [];
		transport.onLine((line) => {
			forwardedLines.push(line);
		});
		const onClose = transport.onClose;
		if (!onClose) {
			throw new Error("Expected Iroh remote close-deferring transport to expose onClose");
		}
		const closeReceived = new Promise<void>((resolve) => {
			onClose((error) => {
				closeErrors.push(error);
				resolve();
			});
		});

		inner.emitClose();
		await closeReceived;

		expect(forwardedLines).toEqual([]);
		expect(inner.writes).toEqual([]);
		expect(closeErrors).toEqual([undefined]);
	});
});
