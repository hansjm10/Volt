/**
 * The numeric bounds, grammars, and stable string vocabularies of the RPC wire
 * contract, in one dependency-free module.
 *
 * Everything here is contract, not tuning: clients (volt-app mirrors these in
 * VoltRPCConversationInputLimits / VoltRPCConversationProjectionLimits and its
 * JSONL codec) and the exported JSON Schema artifact both derive from these
 * values. Behavioral knobs that clients never observe stay in their own
 * modules.
 */

// ============================================================================
// Identifiers
// ============================================================================

/** UTF-8 budget for conversation-scoped identifiers (session, subscription, branch epoch, workflow, request ids). */
export const RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES = 256;

/**
 * Grammar for durable client-supplied message identities (`clientMessageId`).
 * The pattern is anchored by consumers; it admits 1–256 ASCII characters and
 * already excludes whitespace, so byte and character budgets coincide.
 */
export const RPC_CLIENT_MESSAGE_ID_MAX_CHARS = 256;
export const RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]{0,255}";
/** Runtime-only queue identities use this reserved namespace; it is never valid at client ingress. */
export const RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX = "local-queue:";
/**
 * Self-contained JSON Schema `pattern` for `clientMessageId`: the grammar plus
 * the reserved-prefix exclusion. Kept equivalent to `isValidClientMessageId`
 * (asserted by a property test in rpc-command-validation.test.ts).
 */
export const RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN = `^(?!${RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX})${RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE}$`;

// ============================================================================
// Conversation input (prompt / steer / follow_up)
// ============================================================================

export const RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES = 512 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_IMAGES = 8;
export const RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES = 256;
export const RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES = 1024 * 1024;
export const RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES = 1536 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

// ============================================================================
// Session-state projection budgets
// ============================================================================

export const RPC_SESSION_STATE_MAX_SERIALIZED_BYTES = 768 * 1024;
export const RPC_SESSION_MODEL_MAX_SERIALIZED_BYTES = 32 * 1024;
export const RPC_SESSION_QUEUE_MAX_SERIALIZED_BYTES = 128 * 1024;
/** Also the host-side recoverable client-input queue depth (`CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES`). */
export const RPC_SESSION_QUEUE_MAX_ITEMS = 128;
export const RPC_SESSION_QUEUE_ITEM_MAX_UTF8_BYTES = 16 * 1024;
export const RPC_SESSION_QUEUE_ID_MAX_UTF8_BYTES = 256;
export const RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES = 256 * 1024;
export const RPC_SESSION_ACTIVE_TOOLS_MAX_ITEMS = 128;
export const RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES = 12 * 1024;
export const RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES = 20 * 1024;
export const RPC_PROJECTION_STRING_MAX_UTF8_BYTES = 4 * 1024;

// ============================================================================
// Git context
// ============================================================================

export const RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS = 256;
export const RPC_GIT_CONTEXT_REF_MAX_CHARS = 1024;
export const RPC_GIT_CONTEXT_OID_MAX_CHARS = 64;
export const RPC_GIT_CONTEXT_OID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
export const RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS = 32;

// ============================================================================
// Work association
// ============================================================================

export const RPC_WORK_CHANGE_ID_MAX_CHARS = 128;
export const RPC_WORK_REPOSITORY_MAX_CHARS = 256;
export const RPC_WORK_BRANCH_MAX_CHARS = 1024;
export const RPC_WORK_PROVIDER_MAX_CHARS = 64;
export const RPC_WORK_PULL_REQUEST_TITLE_MAX_CHARS = 512;

// ============================================================================
// UI action-state events
// ============================================================================

export const RPC_UI_ACTION_ID_MAX_CHARS = 160;
export const RPC_UI_ACTION_STATE_TYPE_MAX_CHARS = 64;
export const RPC_UI_ACTION_STATE_VALUE_MAX_CHARS = 240;
export const RPC_UI_ACTION_STATE_LABEL_MAX_CHARS = 80;
export const RPC_UI_ACTION_STATE_MAX_OPTIONS = 50;
export const RPC_UI_ACTION_STATE_OPTION_VALUE_MAX_CHARS = 80;
export const RPC_UI_ACTION_STATE_OPTION_LABEL_MAX_CHARS = 80;
export const RPC_UI_ACTION_STATE_OPTION_DESCRIPTION_MAX_CHARS = 240;

// ============================================================================
// Ordered-conversation projection budgets
// ============================================================================

/** Hard wire envelope shared by the projection feed and subscriber snapshot builders. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES = 512;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS = 128;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES = 256 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES = 64 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES = 384 * 1024;

// ============================================================================
// Transcript paging
// ============================================================================

export const RPC_TRANSCRIPT_PAGE_DEFAULT_ITEMS = 100;
export const RPC_TRANSCRIPT_PAGE_MAX_ITEMS = 200;
/** Serialized budget for one remote transcript page: half the ordered feed's queue envelope. */
export const REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
/**
 * Scalar cap on one remote transcript item's projected text and on one
 * get_transcript_entry_text continuation chunk. Clients page a truncated
 * entry's canonical text in chunks of this size.
 */
export const IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS = 12_000;

// ============================================================================
// Session-tree paging
// ============================================================================

export const RPC_SESSION_TREE_PAGE_DEFAULT_ITEMS = 100;
export const RPC_SESSION_TREE_PAGE_MAX_ITEMS = 200;
/** Serialized budget for one local or remote session-tree page. */
export const RPC_SESSION_TREE_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

// ============================================================================
// Message-image recovery paging (get_message_images)
// ============================================================================

/** Headroom for the response envelope, identifiers, array commas, and the LF framing byte. */
export const MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES = 64 * 1024;
export const MESSAGE_IMAGES_PAGE_MAX_ITEMS = 32;
/** A recovered transcript entry may span pages, but never an unbounded number of images. */
export const MESSAGE_IMAGES_ENTRY_MAX_ITEMS = 64;
/** Aggregate serialized image-component bytes recoverable for one transcript entry. */
export const MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;

// ============================================================================
// JSONL framing
// ============================================================================

/** Mirrored by volt-app's JSONLLineDecoder.maximumEncodedLineBytes. */
export const DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES = 4 * 1024 * 1024;
/** JSON content bytes before the required LF framing byte. */
export const DEFAULT_IROH_RPC_MAX_LINE_BYTES = DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES - 1;
export const MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES =
	DEFAULT_IROH_RPC_MAX_LINE_BYTES - MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES;

// ============================================================================
// Numeric wire domain
// ============================================================================

/** Every integral wire field fits the JSON/JavaScript safe-integer domain shared with native clients. */
export const RPC_WIRE_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Upper bound of the `retryAfterMs` domain clients honor before treating a
 * backoff hint as invalid. Enforced client-side; the host currently emits
 * 500/1000 ms hints well inside it.
 */
export const RPC_RETRY_AFTER_MS_MAX = 30_000;

// ============================================================================
// Stable error vocabularies
// ============================================================================

/**
 * `errorCode` values on error responses that clients may branch on.
 * Everything else in `error` is prose.
 */
export const RPC_STABLE_ERROR_CODES = [
	"client_input_conflict",
	"client_input_outcome_ambiguous",
	"stale_plan_revision",
	"stale_conversation_authority",
	"review_discussions_unavailable",
	"review_source_unavailable",
] as const;
export type RpcStableErrorCode = (typeof RPC_STABLE_ERROR_CODES)[number];

/**
 * Stable machine-readable strings the remote host surfaces in the `error`
 * field of error responses (mirrored by volt-app's VoltRPCErrorCode).
 */
export const RPC_REMOTE_ERROR_STRINGS = [
	"invalid_cursor",
	"invalid_limit",
	"invalid_request",
	"invalid_workspace_payload",
	"session_mismatch",
	"unexpected_session_id",
	"unknown_entry",
	"unsupported_on_workspace_discovery_stream",
	"unsupported_on_workspace_management_stream",
	"unsupported_remote_command",
] as const;
export type RpcRemoteErrorString = (typeof RPC_REMOTE_ERROR_STRINGS)[number];
