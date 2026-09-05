import type { AgentSession } from "./agent-session.ts";
import type { RpcCommand } from "./rpc/types.ts";

export const REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE =
	"This action requires the source review to preserve discussion linkage and canonical outcomes; code fixes can be applied here";

/** Domain lifecycle boundaries only; ordinary tools and custom actions use normal grants. */
export function isReviewDiscussionHostActionAllowed(action: string, args?: unknown): boolean {
	if (
		[
			"session.new",
			"review.branch",
			"review.commit",
			"review.pr",
			"review.uncommitted",
			"review.fix",
			"review.feedback",
			"review.rerun",
			"review.publish",
			"review.export_feedback",
		].includes(action)
	)
		return false;
	return !(
		action === "plan.execute" &&
		typeof args === "object" &&
		args !== null &&
		"strategy" in args &&
		args.strategy === "new_session"
	);
}

const SOURCE_OWNED_COMMANDS = new Set<string>([
	"new_session",
	"switch_session",
	"switch_session_by_id",
	"fork",
	"clone",
	"open_review_session",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"export_review_feedback",
]);

/** Linkage is not a capability ceiling: only source-owned lifecycle operations are excluded. */
export function assertReviewDiscussionRpcAllowed(session: AgentSession, command: RpcCommand): void {
	if (!session.isReviewDiscussion) return;
	if (
		SOURCE_OWNED_COMMANDS.has(command.type) ||
		(command.type === "plan_execute" && command.strategy === "new_session") ||
		(command.type === "invoke_ui_action" && !isReviewDiscussionHostActionAllowed(command.action, command.args))
	)
		throw new Error(REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE);
}
