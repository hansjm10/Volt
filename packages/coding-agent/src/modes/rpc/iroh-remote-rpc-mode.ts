import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createIrohRemoteRpcTransport } from "../../core/remote/iroh/index.ts";
import type { IrohRpcTransportOptions } from "../../core/rpc/index.ts";
import { runRpcMode } from "./rpc-mode.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {}

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	return runRpcMode(runtimeHost, {
		transport: createIrohRemoteRpcTransport(options),
		exitProcess: false,
	});
}
