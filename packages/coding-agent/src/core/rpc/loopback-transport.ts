import { serializeJsonLine } from "./jsonl.ts";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "./transport.ts";

export interface LoopbackRpcTransportPair {
	client: RpcTransport;
	server: RpcTransport;
}

/**
 * Create an in-memory, full-duplex RPC transport pair.
 *
 * Each endpoint owns JSONL framing like the stream transports. Writes on one
 * endpoint are delivered as inbound lines on the other endpoint, and closing one
 * endpoint's output closes the peer endpoint's input.
 */
export function createLoopbackRpcTransportPair(): LoopbackRpcTransportPair {
	const client = new LoopbackRpcTransportEndpoint();
	const server = new LoopbackRpcTransportEndpoint();
	client.setPeer(server);
	server.setPeer(client);
	return { client, server };
}

class LoopbackRpcTransportEndpoint implements RpcTransport {
	private readonly lineHandlers = new Set<RpcLineHandler>();
	private readonly closeHandlers = new Set<RpcCloseHandler>();
	private readonly queuedLines: string[] = [];
	private peer: LoopbackRpcTransportEndpoint | undefined;
	private inputBuffer = "";
	private inputClosed = false;
	private inputCloseError: Error | undefined;
	private outputClosed = false;

	setPeer(peer: LoopbackRpcTransportEndpoint): void {
		this.peer = peer;
	}

	write(value: object): void {
		if (this.outputClosed) {
			throw new Error("Loopback RPC transport output is closed");
		}
		if (!this.peer) {
			throw new Error("Loopback RPC transport peer is missing");
		}

		this.peer.receiveText(serializeJsonLine(value));
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		this.drainQueuedLines();
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	onClose(handler: RpcCloseHandler): () => void {
		if (this.inputClosed) {
			let active = true;
			queueMicrotask(() => {
				if (active) {
					handler(this.inputCloseError);
				}
			});
			return () => {
				active = false;
			};
		}

		this.closeHandlers.add(handler);
		return () => {
			this.closeHandlers.delete(handler);
		};
	}

	async waitForBackpressure(): Promise<void> {}

	async flush(): Promise<void> {}

	close(): void {
		if (this.outputClosed) {
			return;
		}
		this.outputClosed = true;
		this.peer?.endInput();
	}

	private receiveText(text: string): void {
		if (this.inputClosed) {
			return;
		}

		this.inputBuffer += text;
		while (true) {
			const newlineIndex = this.inputBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			this.enqueueLine(this.inputBuffer.slice(0, newlineIndex));
			this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
		}
	}

	private endInput(error?: Error): void {
		if (this.inputClosed) {
			return;
		}
		if (this.inputBuffer.length > 0) {
			this.enqueueLine(this.inputBuffer);
			this.inputBuffer = "";
		}

		this.inputClosed = true;
		this.inputCloseError = error;
		for (const handler of this.closeHandlers) {
			handler(error);
		}
	}

	private enqueueLine(line: string): void {
		const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (this.lineHandlers.size === 0) {
			this.queuedLines.push(normalizedLine);
			return;
		}

		this.emitLine(normalizedLine);
	}

	private drainQueuedLines(): void {
		while (this.queuedLines.length > 0 && this.lineHandlers.size > 0) {
			const line = this.queuedLines.shift();
			if (line !== undefined) {
				this.emitLine(line);
			}
		}
	}

	private emitLine(line: string): void {
		for (const handler of this.lineHandlers) {
			handler(line);
		}
	}
}
