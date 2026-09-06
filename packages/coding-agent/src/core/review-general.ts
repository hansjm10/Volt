import { canonicalizePath } from "../utils/paths.ts";
import { ReviewSourceUnavailableError } from "./review-anchors.ts";
import type { RpcReviewGeneral } from "./rpc/schema/review-discussions.ts";
import type { SessionManager } from "./session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "./session-store/client.ts";

/** Routing only: this never grants a finding child canonical-source write authority. */
export async function getReviewGeneral(manager: SessionManager, runId: string): Promise<RpcReviewGeneral> {
	const ref = manager.getSessionRef();
	if (!ref) throw new ReviewSourceUnavailableError("Review General requires a durable review anchor.");
	const cwd = manager.getCwd();
	await manager.flush();
	const lease = await acquireSharedSQLiteSessionStore(ref.sessionDirectory);
	try {
		if (lease.client.info.storeId !== ref.storeId) throw new ReviewSourceUnavailableError();
		const anchor = await lease.client.resolveReviewGeneral(runId, {
			sessionId: ref.sessionId,
			sessionGeneration: ref.sessionGeneration,
			cwd,
		});
		const current = manager.getSessionRef();
		if (
			!anchor ||
			current?.storeId !== ref.storeId ||
			current.sessionDirectory !== ref.sessionDirectory ||
			current.sessionId !== ref.sessionId ||
			current.sessionGeneration !== ref.sessionGeneration ||
			manager.getCwd() !== cwd ||
			canonicalizePath(cwd) !== anchor.source.cwd
		)
			throw new ReviewSourceUnavailableError("This conversation is not an exact member of the review run.");
		manager.assertConversationAuthorityAvailable();
		return {
			runId: anchor.runId,
			sourceSessionId: anchor.source.sessionId,
			generalSessionId: anchor.general.sessionId,
			generalSessionGeneration: anchor.general.sessionGeneration,
			generalRevision: anchor.generalRevision,
			generalAvailable: anchor.generalAvailable,
		};
	} finally {
		await lease.release();
	}
}

/** Capture the CAS before preparing a replacement; ordinary aliases never promote. */
export async function prepareReviewGeneralReplacement(source: SessionManager, runId: string) {
	const general = await getReviewGeneral(source, runId);
	const from = source.getSessionRef()!;
	const cwd = source.getCwd();
	if (
		!general.generalAvailable ||
		general.generalSessionId !== from.sessionId ||
		general.generalSessionGeneration !== from.sessionGeneration
	)
		throw new ReviewSourceUnavailableError("Only the exact current General can replace itself.");
	const lease = await acquireSharedSQLiteSessionStore(from.sessionDirectory);
	return {
		async commit(target: SessionManager): Promise<void> {
			const to = target.getSessionRef();
			if (
				!to ||
				to.storeId !== from.storeId ||
				to.sessionDirectory !== from.sessionDirectory ||
				lease.client.info.storeId !== from.storeId
			)
				throw new ReviewSourceUnavailableError("Review General replacement crosses stores.");
			await lease.client.replaceReviewGeneral({
				runId,
				member: { sessionId: from.sessionId, sessionGeneration: from.sessionGeneration, cwd },
				expectedRevision: general.generalRevision,
				replacement: { sessionId: to.sessionId, sessionGeneration: to.sessionGeneration, cwd: target.getCwd() },
			});
		},
		dispose: () => lease.release(),
	};
}
