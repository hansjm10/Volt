import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createLoopbackRpcTransportPair } from "../../core/rpc/index.ts";
import type { RpcClientEvent } from "./rpc-client-base.ts";
import { runRpcMode } from "./rpc-mode.ts";
import { RpcTransportClient } from "./rpc-transport-client.ts";

export type InProcessRpcClientEventListener = (event: RpcClientEvent, client: InProcessRpcClient) => void;

export interface InProcessRpcClientOptions {
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
	/** Initial event listener registered before startup completes. */
	onEvent?: InProcessRpcClientEventListener;
}

interface InProcessRpcClientConstructorOptions extends InProcessRpcClientOptions {
	runtimeHost: AgentSessionRuntime;
}

/**
 * RPC client backed by runRpcMode in the same Node.js process.
 *
 * stop() closes the client transport and waits for RPC mode shutdown, which also
 * disposes the supplied AgentSessionRuntime.
 */
export class InProcessRpcClient extends RpcTransportClient {
	private readonly modeClosed: Promise<void>;
	private readonly modeReady: Promise<void>;

	constructor(options: InProcessRpcClientConstructorOptions) {
		const pair = createLoopbackRpcTransportPair();
		super({ transport: pair.client, requestTimeoutMs: options.requestTimeoutMs });

		const initialEventListener = options.onEvent;
		if (initialEventListener) {
			this.onEvent((event) => {
				initialEventListener(event, this);
			});
		}

		let readySettled = false;
		let resolveReady: () => void = () => {};
		let rejectReady: (error: unknown) => void = () => {};
		this.modeReady = new Promise<void>((resolve, reject) => {
			resolveReady = () => {
				readySettled = true;
				resolve();
			};
			rejectReady = (error) => {
				readySettled = true;
				reject(error);
			};
		});
		void this.modeReady.catch(() => {});

		this.modeClosed = runRpcMode(options.runtimeHost, {
			transport: pair.server,
			exitProcess: false,
			onReady: resolveReady,
		});
		void this.modeClosed.catch((error: unknown) => {
			if (!readySettled) {
				rejectReady(error);
			}
			void pair.server.close();
		});
	}

	async start(): Promise<void> {
		await super.start();
		await this.modeReady;
	}

	async stop(): Promise<void> {
		await super.stop();
		await this.modeClosed;
	}
}

export async function createInProcessRpcClient(
	runtimeHost: AgentSessionRuntime,
	options: InProcessRpcClientOptions = {},
): Promise<InProcessRpcClient> {
	const client = new InProcessRpcClient({ runtimeHost, ...options });
	await client.start();
	return client;
}
