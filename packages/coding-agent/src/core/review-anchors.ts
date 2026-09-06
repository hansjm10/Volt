import { canonicalizePath } from "../utils/paths.ts";
import type { SessionManager, SessionReference } from "./session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "./session-store/client.ts";

export class ReviewSourceUnavailableError extends Error {
	readonly code = "review_source_unavailable";

	constructor(message = "The canonical review source is unavailable.", options?: ErrorOptions) {
		super(message, options);
		this.name = "ReviewSourceUnavailableError";
	}
}

/** Resolve host-only membership, not a run id or source reference copied into a transcript. */
export async function resolveCanonicalReviewSource(
	manager: SessionManager,
	runId: string,
): Promise<SessionReference | undefined> {
	const ref = manager.getSessionRef();
	if (!ref) return undefined;
	const cwd = manager.getCwd();
	await manager.flush();
	const lease = await acquireSharedSQLiteSessionStore(ref.sessionDirectory);
	try {
		if (lease.client.info.storeId !== ref.storeId) throw new ReviewSourceUnavailableError();
		const member = await lease.client.findSessionSummary(ref.sessionId, ref.sessionGeneration);
		if (!member) throw new ReviewSourceUnavailableError("The review conversation incarnation is unavailable.");
		const anchor = await lease.client.resolveReviewAnchor(runId, {
			sessionId: ref.sessionId,
			sessionGeneration: ref.sessionGeneration,
			cwd: member.cwd,
		});
		const current = manager.getSessionRef();
		if (
			current?.storeId !== ref.storeId ||
			current.sessionDirectory !== ref.sessionDirectory ||
			current.sessionId !== ref.sessionId ||
			current.sessionGeneration !== ref.sessionGeneration ||
			manager.getCwd() !== cwd
		)
			throw new ReviewSourceUnavailableError("The review conversation changed during lookup.");
		manager.assertConversationAuthorityAvailable();
		if (!anchor) return undefined;
		if (!anchor.sourceAvailable || canonicalizePath(cwd) !== anchor.source.cwd)
			throw new ReviewSourceUnavailableError();
		return { ...ref, sessionId: anchor.source.sessionId, sessionGeneration: anchor.source.sessionGeneration };
	} finally {
		await lease.release();
	}
}

/** Register only from the host's durable review-creation path, never hydration/import. */
export async function registerDurableReviewAnchor(manager: SessionManager, runId: string): Promise<void> {
	const ref = manager.getSessionRef();
	if (!ref) return;
	const lease = await acquireSharedSQLiteSessionStore(ref.sessionDirectory);
	try {
		if (lease.client.info.storeId !== ref.storeId) throw new Error("Review store identity changed");
		await lease.client.registerReviewAnchor({
			runId,
			source: { sessionId: ref.sessionId, sessionGeneration: ref.sessionGeneration, cwd: manager.getCwd() },
			createdAt: new Date().toISOString(),
		});
	} finally {
		await lease.release();
	}
}

/** Host handoffs may copy display entries, but only this exact-store edge grants linkage. */
export async function registerReviewHandoffAliases(
	source: SessionManager,
	target: SessionManager,
	runIds: readonly string[],
): Promise<void> {
	if (runIds.length === 0) return;
	const from = source.getSessionRef();
	const to = target.getSessionRef();
	if (!from || !to) return;
	if (from.storeId !== to.storeId || from.sessionDirectory !== to.sessionDirectory)
		throw new Error("Review handoff crosses stores");
	const lease = await acquireSharedSQLiteSessionStore(from.sessionDirectory);
	try {
		if (lease.client.info.storeId !== from.storeId) throw new Error("Review store identity changed");
		const member = { sessionId: from.sessionId, sessionGeneration: from.sessionGeneration, cwd: source.getCwd() };
		for (const runId of runIds) {
			// Unregistered/imported review display entries remain non-authoritative.
			if (!(await lease.client.resolveReviewAnchor(runId, member))) continue;
			await lease.client.registerReviewAlias(runId, member, {
				sessionId: to.sessionId,
				sessionGeneration: to.sessionGeneration,
				cwd: target.getCwd(),
			});
		}
	} finally {
		await lease.release();
	}
}
