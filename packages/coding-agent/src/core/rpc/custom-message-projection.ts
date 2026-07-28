export type RemoteVisibleCustomMessageRole = "assistant" | "system";

/**
 * Remote-visible custom messages and the transcript roles clients should use
 * for them. All other custom messages remain host-private.
 */
export function getRemoteVisibleCustomMessageRole(
	customType: string,
	display: boolean,
): RemoteVisibleCustomMessageRole | undefined {
	if (!display) {
		return undefined;
	}
	switch (customType) {
		case "review":
			return "assistant";
		case "subagent_recovery":
			return "system";
		default:
			return undefined;
	}
}
