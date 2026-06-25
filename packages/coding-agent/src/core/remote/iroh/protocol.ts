export const IROH_REMOTE_ALPN = "volt-rpc/0";
export const IROH_REMOTE_TICKET_PREFIX = "volt+iroh://v1/";
export const IROH_REMOTE_HELLO_TYPE = "volt_iroh_hello";
export const IROH_REMOTE_HANDSHAKE_TYPE = "volt_iroh_handshake";
export const DEFAULT_IROH_REMOTE_ALLOW_TOOLS = "read,bash,edit,write,grep,find,ls";
export const IROH_REMOTE_UNSAFE_TOOL_NAMES = ["bash", "edit", "write"] as const;
export const IROH_REMOTE_OUTCOMES = [
	"host_unreachable",
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_forbidden",
	"host_identity_mismatch",
	"saved_host_invalid",
] as const;
export const IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES = [
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_forbidden",
] as const;

const IROH_REMOTE_UNSAFE_TOOL_NAME_SET = new Set<string>(IROH_REMOTE_UNSAFE_TOOL_NAMES);
const IROH_REMOTE_OUTCOME_SET = new Set<string>(IROH_REMOTE_OUTCOMES);
const IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOME_SET = new Set<string>(IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES);

export type IrohRemoteRelayMode = "disabled" | "default";
export type IrohRemoteOutcome = (typeof IROH_REMOTE_OUTCOMES)[number];
export type IrohRemoteHostHandshakeFailureOutcome = (typeof IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES)[number];

export function isIrohRemoteRelayMode(value: unknown): value is IrohRemoteRelayMode {
	return value === "disabled" || value === "default";
}

export function isIrohRemoteOutcome(value: unknown): value is IrohRemoteOutcome {
	return typeof value === "string" && IROH_REMOTE_OUTCOME_SET.has(value);
}

export function isIrohRemoteHostHandshakeFailureOutcome(
	value: unknown,
): value is IrohRemoteHostHandshakeFailureOutcome {
	return typeof value === "string" && IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOME_SET.has(value);
}

export class IrohRemoteOutcomeError extends Error {
	readonly outcome: IrohRemoteOutcome;

	constructor(outcome: IrohRemoteOutcome, message: string) {
		super(`${outcome}: ${message}`);
		this.name = "IrohRemoteOutcomeError";
		this.outcome = outcome;
	}
}

export function parseIrohRemoteAllowTools(allowTools: string | undefined): string[] {
	const requestedAllowTools = allowTools ?? DEFAULT_IROH_REMOTE_ALLOW_TOOLS;
	const tools = requestedAllowTools
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	return tools.length > 0 ? tools : DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",");
}

export function usesDefaultIrohRemoteAllowTools(allowTools: string | undefined): boolean {
	const tools = parseIrohRemoteAllowTools(allowTools);
	const defaultTools = new Set(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
	return tools.length === defaultTools.size && tools.every((tool) => defaultTools.has(tool));
}

export function getIrohRemoteVoltRpcToolArgs(allowTools: string | undefined): string[] {
	const normalizedAllowTools = parseIrohRemoteAllowTools(allowTools).join(",");
	const args = ["--tools", normalizedAllowTools];
	if (usesDefaultIrohRemoteAllowTools(normalizedAllowTools)) {
		args.push("--allow-unlisted-extension-tools");
	}
	return args;
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
