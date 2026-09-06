import { isIrohRemoteSessionId } from "../core/remote/iroh/handshake.ts";
import {
	IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE,
	IrohRemoteOutcomeError,
	isIrohRemoteHostStorageFullError,
} from "../core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../core/session-manager.ts";
import { SessionStoreError } from "../core/session-store/types.ts";

function sessionTargetFailure(error: unknown, workspace: string, sessionId: string): IrohRemoteOutcomeError {
	if (isIrohRemoteHostStorageFullError(error) || (error instanceof SessionStoreError && error.code === "store_full")) {
		return Object.assign(new IrohRemoteOutcomeError("host_storage_full", IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE), {
			cause: error,
			workspace,
			sessionId,
		});
	}
	if (
		error instanceof SessionStoreError &&
		[
			"closed",
			"invalid_response",
			"store_initialization_failed",
			"store_schema_mismatch",
			"store_busy",
			"store_io_error",
			"worker_failed",
		].includes(error.code)
	) {
		// A workspace-wide store failure says nothing about this conversation's
		// identity. Keep it retryable instead of making every saved pin stale.
		return Object.assign(
			new IrohRemoteOutcomeError(
				"workspace_unavailable",
				"workspace session storage is unavailable; retry after the host recovers",
			),
			{ cause: error, workspace, retryAfterMs: 5_000 },
		);
	}
	return Object.assign(new IrohRemoteOutcomeError("session_unavailable", "session state is corrupt or ambiguous"), {
		cause: error,
		workspace,
		sessionId,
	});
}

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
	/** Concrete id (existing session id, or freshly created). */
	sessionId: string;
	sessionRef?: SessionReference;
	selection: IrohRemoteSessionTargetSelection;
	/** Present for created_after_missing/resumed selections. */
	requestedSessionId?: string;
	workspaceName: string;
	workspacePath: string;
}

export interface SessionTargetSessionHandle {
	getSessionId(): string;
	getSessionRef(): SessionReference | undefined;
}

/** Minimal session-store surface consumed by target resolution — injectable for tests. */
export interface SessionTargetSessionStore<H extends SessionTargetSessionHandle = SessionTargetSessionHandle> {
	/** Existing sessions for the workspace. */
	list(): Promise<Array<{ id: string; ref: SessionReference }>>;
	/** Strict internal lookup that may include selector-hidden WAL-only sessions. */
	find?(sessionId: string): Promise<SessionReference | undefined>;
	open(ref: SessionReference): Promise<H>;
	create(sessionId?: string): Promise<H>;
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
	): ResolvedSessionTargetWithManager<H> => {
		const sessionRef = sessionManager.getSessionRef();
		return {
			sessionId: sessionManager.getSessionId(),
			...(sessionRef === undefined ? {} : { sessionRef }),
			selection,
			...(requestedSessionId === undefined ? {} : { requestedSessionId }),
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			sessionManager,
		};
	};

	const requestedSessionId = target.kind === "last" ? target.resumeSessionId : target.sessionId;
	if (requestedSessionId === undefined) {
		return resolved(await sessions.create(), "created");
	}

	if (!isIrohRemoteSessionId(requestedSessionId)) {
		if (target.kind === "session" || target.kind === "new") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		return resolved(await sessions.create(), "created_after_missing", requestedSessionId);
	}

	let existingSessionRef: SessionReference | undefined;
	try {
		existingSessionRef = sessions.find
			? await sessions.find(requestedSessionId)
			: (await sessions.list()).find((session) => session.id === requestedSessionId)?.ref;
	} catch (error) {
		// Corrupt or duplicate durable identity is unavailable, never missing. In
		// particular, `last` must not create a fresh idempotency domain and replay
		// a handled side effect under the same clientMessageId.
		throw sessionTargetFailure(error, workspace.name, requestedSessionId);
	}
	if (!existingSessionRef) {
		if (target.kind === "session") {
			throw new IrohRemoteOutcomeError("session_unavailable", "session not found in workspace");
		}
		if (target.kind === "new") {
			return resolved(await sessions.create(requestedSessionId), "created");
		}
		return resolved(await sessions.create(), "created_after_missing", requestedSessionId);
	}

	try {
		const sessionManager = await sessions.open(existingSessionRef);
		if (sessionManager.getSessionId() !== requestedSessionId) {
			throw new Error("session identity changed while opening resume target");
		}
		return resolved(sessionManager, "resumed", target.kind === "new" ? undefined : requestedSessionId);
	} catch (error) {
		// Lookup and open cannot be atomic across an arbitrary injected store. Fail
		// closed if the target disappears, is replaced, or no longer claims the
		// requested durable idempotency domain between those operations.
		throw sessionTargetFailure(error, workspace.name, requestedSessionId);
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
			return sessions.map((session) => ({ id: session.id, ref: session.ref }));
		},
		async open(ref) {
			return SessionManager.open(ref, options.preserveSessionCwd ? undefined : cwd);
		},
		async create(sessionId) {
			return SessionManager.create(cwd, sessionDir, sessionId === undefined ? undefined : { id: sessionId });
		},
	};
}
