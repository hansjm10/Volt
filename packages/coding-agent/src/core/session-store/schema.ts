export const SESSION_STORE_SCHEMA_ID = "volt-session-store-v1";

export const SESSION_STORE_TABLE_NAMES = [
	"store_metadata",
	"sessions",
	"entries",
	"labels",
	"client_inputs",
	"subagent_spawns",
	"search_chunks",
	"transaction_commits",
] as const;

export const SESSION_STORE_INDEX_NAMES = [
	"sessions_visible_updated_idx",
	"sessions_cwd_visible_updated_idx",
	"sessions_parent_idx",
	"entries_parent_idx",
	"entries_type_idx",
	"labels_label_idx",
	"client_inputs_state_idx",
	"subagent_spawns_child_idx",
	"search_chunks_entry_idx",
	"transaction_commits_session_revision_idx",
] as const;

export const SESSION_STORE_SCHEMA_SQL = `
CREATE TABLE store_metadata (
	key TEXT PRIMARY KEY NOT NULL,
	value_json TEXT NOT NULL CHECK (json_valid(value_json) = 1)
) STRICT, WITHOUT ROWID;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 512),
	session_generation TEXT NOT NULL CHECK (length(session_generation) BETWEEN 1 AND 512),
	format_version INTEGER NOT NULL CHECK (format_version >= 1),
	cwd TEXT NOT NULL CHECK (length(cwd) >= 1),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	parent_session_directory TEXT CHECK (parent_session_directory IS NULL OR length(parent_session_directory) >= 1),
	parent_store_id TEXT CHECK (parent_store_id IS NULL OR length(parent_store_id) BETWEEN 1 AND 512),
	parent_session_id TEXT CHECK (parent_session_id IS NULL OR length(parent_session_id) BETWEEN 1 AND 512),
	parent_session_generation TEXT CHECK (
		parent_session_generation IS NULL OR length(parent_session_generation) BETWEEN 1 AND 512
	),
	origin TEXT CHECK (origin IS NULL OR origin = 'subagent'),
	starting_git_context_recorded INTEGER NOT NULL DEFAULT 0 CHECK (starting_git_context_recorded IN (0, 1)),
	starting_git_context_json TEXT CHECK (
		starting_git_context_json IS NULL OR json_valid(starting_git_context_json) = 1
	),
	name TEXT,
	visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
	revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
	leaf_entry_id TEXT,
	message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
	first_message TEXT NOT NULL DEFAULT '',
	UNIQUE (id, session_generation),
	CHECK (
		(parent_session_directory IS NULL AND parent_store_id IS NULL AND parent_session_id IS NULL AND parent_session_generation IS NULL)
		OR
		(parent_session_directory IS NOT NULL AND parent_store_id IS NOT NULL AND parent_session_id IS NOT NULL AND parent_session_generation IS NOT NULL)
	),
	CHECK (starting_git_context_recorded = 1 OR starting_git_context_json IS NULL)
) STRICT;

CREATE TRIGGER sessions_generation_immutable
	BEFORE UPDATE OF session_generation ON sessions
	WHEN OLD.session_generation <> NEW.session_generation
BEGIN
	SELECT RAISE(ABORT, 'session_generation is immutable');
END;

CREATE INDEX sessions_visible_updated_idx ON sessions (visible, updated_at DESC, id);
CREATE INDEX sessions_cwd_visible_updated_idx ON sessions (cwd, visible, updated_at DESC, id);
CREATE INDEX sessions_parent_idx
	ON sessions (parent_session_directory, parent_store_id, parent_session_id, parent_session_generation);

CREATE TABLE entries (
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 512),
	ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
	parent_entry_id TEXT,
	entry_type TEXT NOT NULL CHECK (length(entry_type) >= 1),
	timestamp TEXT NOT NULL,
	is_host_only INTEGER NOT NULL CHECK (is_host_only IN (0, 1)),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
	PRIMARY KEY (session_id, entry_id),
	UNIQUE (session_id, ordinal),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, parent_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX entries_parent_idx ON entries (session_id, parent_entry_id);
CREATE INDEX entries_type_idx ON entries (session_id, entry_type, ordinal);

CREATE TABLE labels (
	session_id TEXT NOT NULL,
	target_entry_id TEXT NOT NULL,
	label TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	PRIMARY KEY (session_id, target_entry_id),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, target_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX labels_label_idx ON labels (session_id, label);

CREATE TABLE client_inputs (
	session_id TEXT NOT NULL,
	client_message_id TEXT NOT NULL CHECK (length(client_message_id) BETWEEN 1 AND 512),
	receipt_entry_id TEXT NOT NULL,
	command TEXT NOT NULL CHECK (command IN ('prompt', 'steer', 'follow_up')),
	semantic_digest TEXT NOT NULL CHECK (length(semantic_digest) >= 1),
	input_json TEXT NOT NULL CHECK (json_valid(input_json) = 1),
	queued_entry_id TEXT,
	queued_input_json TEXT CHECK (queued_input_json IS NULL OR json_valid(queued_input_json) = 1),
	state TEXT NOT NULL CHECK (state IN ('accepted', 'started', 'completed', 'failed')),
	error TEXT,
	canonical_entry_id TEXT,
	PRIMARY KEY (session_id, client_message_id),
	CHECK ((queued_entry_id IS NULL) = (queued_input_json IS NULL)),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, receipt_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (session_id, queued_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (session_id, canonical_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX client_inputs_state_idx ON client_inputs (session_id, state, client_message_id);

CREATE TABLE subagent_spawns (
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	tool_call_id TEXT NOT NULL,
	subagent_id TEXT NOT NULL,
	agent TEXT NOT NULL,
	child_session_id TEXT NOT NULL,
	child_store_id TEXT,
	request_key TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_id),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX subagent_spawns_child_idx
	ON subagent_spawns (child_store_id, child_session_id, session_id);

CREATE TABLE search_chunks (
	session_id TEXT NOT NULL,
	chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
	entry_id TEXT,
	text TEXT NOT NULL,
	PRIMARY KEY (session_id, chunk_index),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX search_chunks_entry_idx ON search_chunks (session_id, entry_id);

CREATE TABLE transaction_commits (
	commit_id TEXT PRIMARY KEY NOT NULL CHECK (length(commit_id) BETWEEN 1 AND 512),
	session_id TEXT NOT NULL,
	session_generation TEXT NOT NULL CHECK (length(session_generation) BETWEEN 1 AND 512),
	digest TEXT NOT NULL CHECK (
		length(digest) = 71 AND
		substr(digest, 1, 7) = 'sha256:' AND
		substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
	),
	before_revision INTEGER NOT NULL CHECK (before_revision >= 0),
	after_revision INTEGER NOT NULL CHECK (after_revision = before_revision + 1),
	committed_at TEXT NOT NULL,
	FOREIGN KEY (session_id, session_generation) REFERENCES sessions(id, session_generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX transaction_commits_session_revision_idx
	ON transaction_commits (session_id, session_generation, after_revision DESC, commit_id);
`;
