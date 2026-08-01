import { rm } from "node:fs/promises";
import type { IrohRemoteWorkspace } from "../core/remote/iroh/state.ts";
import type { AgentLaunchRecord } from "../core/session-manager.ts";

export type IncompleteAgentLaunchCleanupResult =
	| { kind: "committed" }
	| { kind: "cleaned" }
	| { kind: "cleanup_required"; worktreeId: string };

export async function cleanupIncompleteAgentLaunch(options: {
	workspace: IrohRemoteWorkspace;
	sessionId: string;
	sessionFile: string;
	record: AgentLaunchRecord;
	removeWorktree: (
		workspace: IrohRemoteWorkspace,
		worktreeId: string,
	) => Promise<{ ok: true } | { ok: false; error: string; verifiedAbsent?: boolean }>;
	releaseWorktreeReservation?: (
		workspaceName: string,
		worktreeId: string,
		pendingLaunchKey: string,
		sessionId: string,
	) => Promise<void>;
	restoreSelection: (
		clientNodeId: string,
		workspaceName: string,
		expectedSessionId: string,
		previousSessionId: string | undefined,
	) => Promise<void>;
	signal?: AbortSignal;
	log?: (message: string, details: Record<string, unknown>) => void;
}): Promise<IncompleteAgentLaunchCleanupResult> {
	options.signal?.throwIfAborted();
	if (options.record.commit !== undefined) {
		return { kind: "committed" };
	}
	const placement = options.record.receipt.placement;
	if (placement.kind === "worktree" && placement.created) {
		let removed = false;
		let removalError: string | undefined;
		try {
			const result = await options.removeWorktree(options.workspace, placement.worktreeId);
			removed = result.ok || (result.error === "worktree_not_found" && result.verifiedAbsent === true);
			if (!result.ok && !removed) removalError = result.error;
		} catch (error) {
			removalError = error instanceof Error ? error.message : String(error);
		}
		options.signal?.throwIfAborted();
		if (!removed) {
			options.log?.("incomplete agent launch cleanup requires retry", {
				workspace: options.workspace.name,
				launchId: options.record.receipt.launchId,
				sessionId: options.sessionId,
				worktreeId: placement.worktreeId,
				error: removalError ?? "worktree removal failed",
			});
			return { kind: "cleanup_required", worktreeId: placement.worktreeId };
		}
	} else if (placement.kind === "worktree") {
		options.signal?.throwIfAborted();
		if (!options.releaseWorktreeReservation) {
			throw new Error("incomplete existing-worktree launch reservation cannot be released");
		}
		await options.releaseWorktreeReservation(
			options.workspace.name,
			placement.worktreeId,
			options.record.receipt.requestDigest,
			options.sessionId,
		);
	}
	options.signal?.throwIfAborted();
	await options.restoreSelection(
		options.record.receipt.clientNodeId,
		options.workspace.name,
		options.sessionId,
		options.record.receipt.previousSessionId ?? undefined,
	);
	options.signal?.throwIfAborted();
	await rm(options.sessionFile, { force: true });
	return { kind: "cleaned" };
}
