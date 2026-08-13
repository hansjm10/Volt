import type {
	AssistantMessage,
	ToolResultMessage,
	ToolSetSnapshotAuthority,
	ToolSetTransition,
} from "@hansjm10/volt-ai";
import type { AgentMessage } from "./types.ts";

export const UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY = Object.freeze({ kind: "unknown" } as const);

/** Recover authority only from a message already canonicalized by Agent. */
export function getCanonicalToolSetSnapshotAuthority(message: AgentMessage): ToolSetSnapshotAuthority {
	return message.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		message.toolSetSnapshot !== undefined
		? { kind: "known", snapshot: message.toolSetSnapshot }
		: UNKNOWN_TOOL_SET_SNAPSHOT_AUTHORITY;
}

/**
 * Canonicalize a same-role message and strip all caller-controlled authority
 * metadata before reapplying only the authority owned by Agent.
 */
export function canonicalizeMessageReplacement<MessageType extends AgentMessage>(
	original: MessageType,
	replacement: AgentMessage | undefined,
	authority: ToolSetSnapshotAuthority,
): MessageType {
	if (replacement !== undefined && replacement.role !== original.role) {
		throw new Error("message_end listeners must return a message with the same role");
	}
	const candidate = replacement ?? original;
	if (original.role === "assistant" && candidate.role === "assistant") {
		const { toolSetSnapshot: _untrustedSnapshot, ...canonical } = candidate;
		const assistant = canonical as Omit<AssistantMessage, "toolSetSnapshot"> & {
			toolSetSnapshot?: AssistantMessage["toolSetSnapshot"];
		};
		if (authority.kind === "known" && candidate.stopReason !== "error" && candidate.stopReason !== "aborted") {
			assistant.toolSetSnapshot = authority.snapshot;
		}
		return assistant as MessageType;
	}
	if (original.role === "toolResult" && candidate.role === "toolResult") {
		const canonical = { ...candidate } as Omit<ToolResultMessage, "toolSetTransition"> & {
			toolSetTransition?: ToolSetTransition | undefined;
		};
		if (Object.hasOwn(original, "toolSetTransition")) {
			canonical.toolSetTransition = original.toolSetTransition;
		} else {
			delete canonical.toolSetTransition;
		}
		return canonical as MessageType;
	}
	return candidate as MessageType;
}
