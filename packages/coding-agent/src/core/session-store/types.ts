export const SESSION_STORE_DATABASE_FILENAME = "sessions.sqlite";
export const SESSION_STORE_SCHEMA_VERSION = 2;
export const SESSION_STORE_REVIEW_CONTEXT_MAX_BYTES = 65_536;
export const SESSION_STORE_REVIEW_LIST_MAX = 100;
export const SESSION_STORE_BUSY_TIMEOUT_MS = 5_000;

export type SessionStoreJsonPrimitive = null | boolean | number | string;
export type SessionStoreJsonValue =
	| SessionStoreJsonPrimitive
	| readonly SessionStoreJsonValue[]
	| { readonly [key: string]: SessionStoreJsonValue };

export type SessionStoreOrigin = "subagent";
export type SessionStoreClientInputCommand = "prompt" | "steer" | "follow_up";
export type SessionStoreClientInputState = "accepted" | "started" | "completed" | "failed";

export interface SessionStoreInfo {
	readonly storeId: string;
	readonly databasePath: string;
	readonly schemaVersion: number;
	readonly journalMode: "wal";
	readonly foreignKeys: true;
	readonly trustedSchema: false;
	readonly busyTimeoutMs: number;
}

export type SessionStoreForeignKeyVerificationResult =
	| { readonly status: "valid" }
	| {
			readonly status: "violation";
			readonly table: string;
			readonly rowId: number | null;
			readonly parentTable: string;
			readonly constraintIndex: number;
	  };

export interface SessionStoreCreateSessionInput {
	readonly id: string;
	readonly sessionGeneration: string;
	readonly formatVersion: number;
	readonly cwd: string;
	readonly createdAt: string;
	readonly parentSessionDirectory: string | null;
	readonly parentStoreId: string | null;
	readonly parentSessionId: string | null;
	readonly parentSessionGeneration: string | null;
	readonly origin: SessionStoreOrigin | null;
}

export interface SessionStoreSessionSummary {
	readonly id: string;
	readonly sessionGeneration: string;
	readonly formatVersion: number;
	readonly cwd: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly parentSessionDirectory: string | null;
	readonly parentStoreId: string | null;
	readonly parentSessionId: string | null;
	readonly parentSessionGeneration: string | null;
	readonly origin: SessionStoreOrigin | null;
	readonly startingGitContextRecorded: boolean;
	readonly startingGitContext: SessionStoreJsonValue | null;
	readonly name: string | null;
	readonly visible: boolean;
	readonly revision: number;
	readonly leafId: string | null;
	readonly messageCount: number;
	readonly firstMessage: string;
}

export interface SessionStoreSearchResult {
	readonly summary: SessionStoreSessionSummary;
	readonly score: number;
}

export interface SessionStoreEntryWrite {
	/** Full canonical persisted SessionEntry. Indexed columns are derived from this value. */
	readonly entry: SessionStoreJsonValue;
}

export interface SessionStoreEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly timestamp: string;
	readonly ordinal: number;
	readonly isHostOnly: boolean;
	readonly payload: SessionStoreJsonValue;
}

export interface SessionStoreClientInputWrite {
	readonly clientMessageId: string;
	readonly receiptEntryId: string;
	readonly command: SessionStoreClientInputCommand;
	readonly semanticDigest: string;
	readonly input: SessionStoreJsonValue;
	readonly queuedEntryId: string | null;
	readonly queuedInput: SessionStoreJsonValue | null;
	readonly state: SessionStoreClientInputState;
	readonly error: string | null;
	readonly canonicalEntryId: string | null;
}

export interface SessionStoreClientInput extends SessionStoreClientInputWrite {}

export interface SessionStoreSearchChunkWrite {
	readonly chunkIndex: number;
	readonly entryId: string | null;
	readonly text: string;
}

export interface SessionStoreSearchChunk extends SessionStoreSearchChunkWrite {}

/** Complete selector/search projection persisted with each transaction. */
export interface SessionStoreSessionProjection {
	readonly updatedAt: string;
	readonly startingGitContextRecorded: boolean;
	readonly startingGitContext: SessionStoreJsonValue | null;
	readonly name: string | null;
	readonly visible: boolean;
	readonly leafId: string | null;
	readonly messageCount: number;
	readonly firstMessage: string;
}

/** Serializable mutations applied under one session revision guard. */
export interface SessionStoreTransactionPayload {
	readonly session: SessionStoreSessionProjection;
	readonly entries: readonly SessionStoreEntryWrite[];
	readonly clientInputs: readonly SessionStoreClientInputWrite[];
	readonly searchChunks: readonly SessionStoreSearchChunkWrite[];
}

export interface SessionStoreApplyTransactionInput {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly expectedRevision: number;
	readonly commitId: string;
	readonly digest: string;
	readonly payload: SessionStoreTransactionPayload;
}

export interface SessionStoreCommitEvidence {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly commitId: string;
	readonly digest: string;
	readonly beforeRevision: number;
	readonly afterRevision: number;
	readonly committedAt: string;
}

export type SessionStoreTransactionResult =
	| {
			readonly status: "committed";
			readonly evidence: SessionStoreCommitEvidence;
	  }
	| {
			readonly status: "conflict";
			readonly actualRevision: number;
	  };

export interface SessionStoreReconcileCommitInput {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly commitId: string;
	readonly digest: string;
}

export type SessionStoreCommitReconciliation =
	| { readonly status: "committed"; readonly evidence: SessionStoreCommitEvidence }
	| { readonly status: "not_found" }
	| { readonly status: "mismatch" };

export interface SessionStoreDeleteSessionInput {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly expectedRevision: number;
}

export type SessionStoreDeleteSessionResult =
	| { readonly status: "deleted" }
	| { readonly status: "not_found" }
	| { readonly status: "conflict"; readonly actualRevision: number };

export interface SessionStoreSnapshot {
	readonly session: SessionStoreSessionSummary;
	readonly entries: readonly SessionStoreEntry[];
	readonly clientInputs: readonly SessionStoreClientInput[];
	readonly searchChunks: readonly SessionStoreSearchChunk[];
}

export interface SessionStoreListOptions {
	readonly includeHidden?: boolean;
	readonly cwd?: string;
}

/** Exact local-store identity. Never resolve historical relations by id alone. */
export interface SessionStoreSessionIdentity {
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

export interface SessionStoreReviewSource extends SessionStoreSessionIdentity {
	readonly cwd: string;
}

export interface SessionStoreRegisterReviewAnchorInput {
	readonly runId: string;
	readonly source: SessionStoreReviewSource;
	readonly createdAt: string;
}

export interface SessionStoreReviewAnchor extends SessionStoreRegisterReviewAnchorInput {
	readonly sourceAvailable: boolean;
	readonly general: SessionStoreSessionIdentity;
	readonly generalRevision: number;
	readonly generalAvailable: boolean;
}

export interface SessionStoreReplaceReviewGeneralInput {
	readonly runId: string;
	readonly member: SessionStoreReviewSource;
	readonly expectedRevision: number;
	readonly replacement: SessionStoreReviewSource;
}

export interface SessionStoreCreateReviewDiscussionInput {
	readonly source: SessionStoreReviewSource;
	readonly runId: string;
	readonly findingId: string;
	readonly discussionId: string;
	readonly child: SessionStoreCreateSessionInput;
	readonly contextSnapshot: SessionStoreJsonValue;
	readonly createdAt: string;
	readonly requestId: string;
	readonly kickoffClientMessageId: string;
}

export interface SessionStoreResetReviewDiscussionInput {
	readonly source: SessionStoreReviewSource;
	readonly discussionId: string;
	readonly expectedChild: SessionStoreSessionIdentity;
	readonly child: SessionStoreCreateSessionInput;
	readonly createdAt: string;
	readonly requestId: string;
	readonly kickoffClientMessageId: string;
}

export interface SessionStoreReviewDiscussionChild {
	readonly discussionId: string;
	readonly ordinal: number;
	readonly child: SessionStoreSessionIdentity;
	readonly createdAt: string;
	readonly requestId: string;
	readonly kickoffClientMessageId: string;
	readonly available: boolean;
}

export interface SessionStoreReviewDiscussion {
	readonly discussionId: string;
	readonly runId: string;
	readonly findingId: string;
	readonly source: SessionStoreReviewSource;
	readonly sourceAvailable: boolean;
	readonly contextSnapshot: SessionStoreJsonValue;
	readonly createdAt: string;
	readonly current: SessionStoreReviewDiscussionChild;
}

export interface SessionStoreReviewDiscussionLookup {
	readonly discussion: SessionStoreReviewDiscussion;
	readonly child: SessionStoreReviewDiscussionChild;
}

export type SessionStoreResetReviewDiscussionResult = {
	readonly status: "reset" | "conflict";
	readonly child: SessionStoreReviewDiscussionChild;
};

/** Deterministic bounded pages; defaults are limit=100, offset=0. */
export interface SessionStoreReviewListOptions {
	readonly limit?: number;
	readonly offset?: number;
}

export type SessionStoreErrorCode =
	| "closed"
	| "invalid_request"
	| "invalid_response"
	| "store_initialization_failed"
	| "store_schema_mismatch"
	| "store_busy"
	| "store_io_error"
	| "store_full"
	| "review_anchor_not_found"
	| "review_identity_conflict"
	| "review_source_unavailable"
	| "review_cwd_mismatch"
	| "review_discussion_not_found"
	| "session_already_exists"
	| "session_not_found"
	| "commit_identity_conflict"
	| "commit_digest_mismatch"
	| "constraint_failed"
	| "session_store_entry_integrity"
	| "session_store_projection_integrity"
	| "worker_failed";

export class SessionStoreError extends Error {
	readonly code: SessionStoreErrorCode;

	constructor(code: SessionStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionStoreError";
		this.code = code;
	}
}
