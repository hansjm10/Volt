import type { AgentSession } from "./agent-session.ts";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	REVIEW_DISCUSSION_OPERATION_GRANT_PROFILE,
} from "./operation-authorization.ts";
import type { RpcCommand } from "./rpc/types.ts";

export const REVIEW_DISCUSSION_READ_ONLY_MESSAGE =
	"Review discussions are read-only; use the source review for lifecycle and finding outcomes";

export function isReviewDiscussionHostActionAllowed(action: string): boolean {
	return ["run.cancel", "context.compact", "session.rename", "thinking.fast_mode", "agent.mode"].includes(action);
}

const DENIED_COMMANDS = new Set<string>([
	"new_session",
	"switch_session",
	"switch_session_by_id",
	"fork",
	"clone",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"open_review_session",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"export_review_feedback",
	"cancel_workflow",
	"subagent_start",
	"subagent_abort",
	"subagent_dispose",
	"bash",
	"export_html",
	"connect_mcp_server",
	"disconnect_mcp_server",
	"refresh_mcp_server",
	"start_mcp_server_auth",
	"complete_mcp_server_auth",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_prompts",
	"get_mcp_prompt",
]);

/** Direct RPC operations must not bypass the model tool's operation-sensitive ceiling. */
export function assertReviewDiscussionRpcAllowed(session: AgentSession, command: RpcCommand): void {
	if (!session.isReviewDiscussion) return;
	if (
		DENIED_COMMANDS.has(command.type) ||
		(command.type === "invoke_ui_action" && !isReviewDiscussionHostActionAllowed(command.action))
	)
		throw new Error(REVIEW_DISCUSSION_READ_ONLY_MESSAGE);
	const action =
		command.type === "list_mcp_tools"
			? "list_tools"
			: command.type === "get_mcp_tool"
				? "describe"
				: command.type === "list_mcp_resources"
					? "list_resources"
					: command.type === "read_mcp_resource"
						? "read_resource"
						: undefined;
	if (action) {
		const manager = session.getMcpManager();
		const decision = authorizeToolOperation(
			getTrustedToolOperationResolver("mcp", { integrationReadAuthority: manager }),
			{ ...command, action },
			REVIEW_DISCUSSION_OPERATION_GRANT_PROFILE,
		);
		if (!decision.allowed) throw new Error(REVIEW_DISCUSSION_READ_ONLY_MESSAGE);
	}
}
