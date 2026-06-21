export const IROH_REMOTE_ALPN = "volt-rpc/0";
export const IROH_REMOTE_TICKET_PREFIX = "volt+iroh://v1/";
export const IROH_REMOTE_HELLO_TYPE = "volt_iroh_hello";
export const IROH_REMOTE_HANDSHAKE_TYPE = "volt_iroh_handshake";
export const DEFAULT_IROH_REMOTE_ALLOW_TOOLS = "read,grep,find,ls";
export const IROH_REMOTE_UNSAFE_TOOL_NAMES = ["bash", "edit", "write"] as const;

const IROH_REMOTE_UNSAFE_TOOL_NAME_SET = new Set<string>(IROH_REMOTE_UNSAFE_TOOL_NAMES);

export type IrohRemoteRelayMode = "disabled" | "default";

export function isIrohRemoteRelayMode(value: unknown): value is IrohRemoteRelayMode {
	return value === "disabled" || value === "default";
}

export function getIrohRemoteUnsafeAllowedTools(allowTools: string): string[] {
	const unsafeTools: string[] = [];
	const seenUnsafeTools = new Set<string>();
	for (const toolName of allowTools.split(",")) {
		const normalizedToolName = toolName.trim();
		if (!IROH_REMOTE_UNSAFE_TOOL_NAME_SET.has(normalizedToolName) || seenUnsafeTools.has(normalizedToolName)) {
			continue;
		}
		seenUnsafeTools.add(normalizedToolName);
		unsafeTools.push(normalizedToolName);
	}
	return unsafeTools;
}
