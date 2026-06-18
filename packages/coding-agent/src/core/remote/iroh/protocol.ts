export const IROH_REMOTE_ALPN = "volt-rpc/0";
export const IROH_REMOTE_TICKET_PREFIX = "volt+iroh://v1/";
export const IROH_REMOTE_HELLO_TYPE = "volt_iroh_hello";
export const IROH_REMOTE_HANDSHAKE_TYPE = "volt_iroh_handshake";
export const DEFAULT_IROH_REMOTE_ALLOW_TOOLS = "read,grep,find,ls";

export type IrohRemoteRelayMode = "disabled" | "default";

export function isIrohRemoteRelayMode(value: unknown): value is IrohRemoteRelayMode {
	return value === "disabled" || value === "default";
}
