import { existsSync } from "node:fs";
import { isIrohRemoteSessionId } from "../core/remote/iroh/handshake.ts";
import { IrohRemoteOutcomeError } from "../core/remote/iroh/protocol.ts";
import { SessionManager } from "../core/session-manager.ts";

/**
 * Conversation target for a remote session, after the owner's last-session
 * bookkeeping has been applied ("last" carries the remembered session id).
 */
export type IrohRemoteSessionTarget =
	| { kind: "last"; resumeSessionId?: string }
	| { kind: "new"; sessionId: string }
	| { kind: "session"; sessionId: string };

export type IrohRemoteSessionTargetSelection = "created" | "created_after_missing" | "resumed";

export interface ResolvedSessionTarget {
	/** Concrete id (existing file id, or freshly created). */
	sessionId: string;
	sessionFilePath?: string;
	selection: IrohRemoteSessionTargetSelection;
	/** Present for created_after_missing/resumed selections. */
	requestedSessionId?: string;
	workspaceName: string;
	workspacePath: string;
}

export interface SessionTargetSessionHandle {
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

/** Minimal session-store surface consumed by target resolution — injectable for tests. */
export interface SessionTargetSessionStore<H extends SessionTargetSessionHandle = SessionTargetSessionHandle> {
	/** Existing sessions for the workspace (only entries whose files exist on disk). */
	list(): Promise<Array<{ id: string; path: string }>>;
	/** Strict internal lookup that may include selector-hidden WAL-only sessions. */
	find?(sessionId: string): Promise<{ id: string; path: string } | undefined>;
	open(path: string): H;
	create(sessionId?: string): H;
}

export interface ResolvedSessionTargetWithManager<H extends SessionTargetSessionHandle = SessionTargetSessionHandle>
	extends ResolvedSessionTarget {
	sessionManager: H;
}

/**
 * Resolve a conversation target to a concrete session, matching the historical
 * behavior of createIrohRemoteAgentRuntimeWithSessionSelection exactly:
 *
 * - new: create the caller-named id once, or resume that exact id on retry
 * - last without a remembered id: create -> "created"
 * - last with a remembered id: open if it exists -> "resumed", else create -> "created_after_missing"
 * - session: open if it exists -> "resumed", else throw session_unavailable
 *   (the wire protocol forbids created_after_missing for explicit session targets)
 */
export async function resolveIrohRemoteSessionTarget<H extends SessionTargetSessionHandle>(
	target: IrohRemoteSessionTarget,
	workspace: { name: string; path: string },
	sessions: SessionTargetSessionStore<H>,
): Promise<ResolvedSessionTargetWithManager<H>> {
	const resolved = (
		sessionManager: H,
		selection: IrohRemoteSessionTargetSelection,
		requestedSessionId?: string,
	): ResolvedSessionTargetWithManager<H> => ({
		sessionId: sessionManager.getSessionId(),
		...(sessionManager.getSessionFile() === undefined ? {} : { sessionFilePath: sessionManager.getSessionFile() }),
		selection,
		...(requestedSessionId === undefined ? {} : { requestedSessionId }),
		workspaceName: workspace.name,
		workspacePath: workspace.path,
		sessionManager,
	});

	const requestedSessionId = target.kind === "last" ? target.resumeSessionId : target.sessionId;
	if (requestedSessionId === undefined) {
		return resolved(sessions.create(), "created");
	}

	if (!isIrohRemoteSessionId(requestedSessionId)) {
		if (target.kind === "session" || target.kind === "new") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		return resolved(sessions.create(), "created_after_missing", requestedSessionId);
	}

	let existingSession: { id: string; path: string } | undefined;
	try {
		existingSession = sessions.find
			? await sessions.find(requestedSessionId)
			: (await sessions.list()).find((session) => session.id === requestedSessionId);
	} catch {
		// Corrupt or duplicate durable identity is unavailable, never missing. In
		// particular, `last` must not create a fresh idempotency domain and replay
		// a handled side effect under the same clientMessageId.
		throw new IrohRemoteOutcomeError("session_unavailable", "session state is corrupt or ambiguous");
	}
	if (!existingSession) {
		if (target.kind === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		if (target.kind === "new") {
			return resolved(sessions.create(requestedSessionId), "created");
		}
		return resolved(sessions.create(), "created_after_missing", requestedSessionId);
	}

	try {
		const sessionManager = sessions.open(existingSession.path);
		if (sessionManager.getSessionId() !== requestedSessionId) {
			throw new Error("session identity changed while opening resume target");
		}
		return resolved(sessionManager, "resumed", target.kind === "new" ? undefined : requestedSessionId);
	} catch {
		// Lookup and open cannot be atomic across an arbitrary injected store. Fail
		// closed if the target disappears, is replaced, or no longer claims the
		// requested durable idempotency domain between those operations.
		throw new IrohRemoteOutcomeError("session_unavailable", "session state is corrupt or ambiguous");
	}
}

/** Real SessionManager-backed store for a workspace cwd + session dir. */
export function createSessionManagerTargetStore(
	cwd: string,
	sessionDir: string,
	options: { listAll?: boolean; preserveSessionCwd?: boolean } = {},
): SessionTargetSessionStore<SessionManager> {
	return {
		async find(sessionId) {
			return SessionManager.findForResume(sessionDir, sessionId);
		},
		async list() {
			const sessions = options.listAll
				? await SessionManager.listAll(sessionDir)
				: await SessionManager.list(cwd, sessionDir);
			return sessions
				.filter((session) => existsSync(session.path))
				.map((session) => ({ id: session.id, path: session.path }));
		},
		open(path: string) {
			return SessionManager.open(path, sessionDir, options.preserveSessionCwd ? undefined : cwd);
		},
		create(sessionId) {
			return SessionManager.create(cwd, sessionDir, sessionId === undefined ? undefined : { id: sessionId });
		},
	};
}
