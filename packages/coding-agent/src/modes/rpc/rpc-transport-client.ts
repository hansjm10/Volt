import type { RpcTransport } from "../../core/rpc/index.ts";
import { RpcClientBase } from "./rpc-client-base.ts";
import type { RpcCommand, RpcExtensionUIResponse } from "./rpc-types.ts";

export interface RpcTransportClientOptions {
	transport: RpcTransport;
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
	/** Close the transport when stop() is called. Defaults to true. */
	closeTransportOnStop?: boolean;
}

/** Typed RPC client that runs over a caller-provided RPC transport. */
export class RpcTransportClient extends RpcClientBase {
	private readonly transport: RpcTransport;
	private readonly closeTransportOnStop: boolean;
	private detachInput: (() => void) | undefined;
	private detachClose: (() => void) | undefined;
	private started = false;
	private transportCloseRequested = false;

	constructor(options: RpcTransportClientOptions) {
		super({ requestTimeoutMs: options.requestTimeoutMs });
		this.transport = options.transport;
		this.closeTransportOnStop = options.closeTransportOnStop ?? true;
	}

	async start(): Promise<void> {
		if (this.started) {
			throw new Error("RPC transport client already started");
		}

		this.clearFailureError();
		this.started = true;
		try {
			this.detachInput = this.transport.onLine((line) => {
				this.handleLine(line);
			});
			this.detachClose =
				this.transport.onClose?.((error) => {
					this.handleTransportClose(error);
				}) ?? (() => {});
		} catch (error: unknown) {
			this.started = false;
			this.detachInput?.();
			this.detachInput = undefined;
			this.detachClose?.();
			this.detachClose = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.started) {
			this.started = false;
			this.detachInput?.();
			this.detachInput = undefined;
			this.detachClose?.();
			this.detachClose = undefined;
			this.rejectPendingRequests(new Error("RPC transport client stopped"));
		}

		if (this.closeTransportOnStop && !this.transportCloseRequested) {
			this.transportCloseRequested = true;
			await this.transport.close();
		}
	}

	protected assertCanSend(): void {
		if (!this.started) {
			throw new Error("RPC transport client not started");
		}
		super.assertCanSend();
	}

	protected writeMessage(message: RpcCommand | RpcExtensionUIResponse): void | Promise<void> {
		return this.transport.write(message);
	}

	private handleTransportClose(error?: Error): void {
		if (!this.started) {
			return;
		}

		this.started = false;
		this.detachInput?.();
		this.detachInput = undefined;
		this.detachClose?.();
		this.detachClose = undefined;
		const closeError = error ?? new Error("RPC transport closed");
		this.setFailureError(closeError);
		this.rejectPendingRequests(closeError);
	}
}
