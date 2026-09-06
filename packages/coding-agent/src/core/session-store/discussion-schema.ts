export const REVIEW_DISCUSSION_SCHEMA_SQL = `
-- Session references deliberately have no cascading FK: deleted identities remain historical evidence.
CREATE TABLE review_anchors (
	run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
	source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 512),
	source_session_generation TEXT NOT NULL CHECK (length(source_session_generation) BETWEEN 1 AND 512),
	cwd TEXT NOT NULL CHECK (length(cwd) >= 1),
	general_session_id TEXT NOT NULL CHECK (length(general_session_id) BETWEEN 1 AND 512),
	general_session_generation TEXT NOT NULL CHECK (length(general_session_generation) BETWEEN 1 AND 512),
	general_revision INTEGER NOT NULL CHECK (general_revision >= 0),
	created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX review_anchors_source_idx ON review_anchors (source_session_id, source_session_generation, run_id);

-- Only host handoff paths register aliases. Portable entries never create membership.
CREATE TABLE review_anchor_aliases (
	run_id TEXT NOT NULL,
	session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
	session_generation TEXT NOT NULL CHECK (length(session_generation) BETWEEN 1 AND 512),
	PRIMARY KEY (run_id, session_id, session_generation),
	FOREIGN KEY (run_id) REFERENCES review_anchors(run_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE review_discussions (
	discussion_id TEXT PRIMARY KEY NOT NULL CHECK (length(discussion_id) BETWEEN 1 AND 512),
	run_id TEXT NOT NULL,
	finding_id TEXT NOT NULL CHECK (length(finding_id) BETWEEN 1 AND 512),
	context_snapshot_json TEXT NOT NULL CHECK (
		json_valid(context_snapshot_json) = 1 AND length(CAST(context_snapshot_json AS BLOB)) <= 65536
	),
	created_at TEXT NOT NULL,
	current_ordinal INTEGER NOT NULL CHECK (current_ordinal >= 1),
	UNIQUE (run_id, finding_id),
	FOREIGN KEY (run_id) REFERENCES review_anchors(run_id),
	FOREIGN KEY (discussion_id, current_ordinal) REFERENCES review_discussion_children(discussion_id, ordinal)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX review_discussions_run_idx ON review_discussions (run_id, discussion_id);

CREATE TABLE review_discussion_children (
	discussion_id TEXT NOT NULL,
	ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
	child_session_id TEXT NOT NULL CHECK (length(child_session_id) BETWEEN 1 AND 512),
	child_session_generation TEXT NOT NULL CHECK (length(child_session_generation) BETWEEN 1 AND 512),
	request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 512),
	request_json TEXT NOT NULL CHECK (json_valid(request_json) = 1),
	kickoff_client_message_id TEXT NOT NULL CHECK (length(kickoff_client_message_id) BETWEEN 1 AND 512),
	created_at TEXT NOT NULL,
	PRIMARY KEY (discussion_id, ordinal),
	UNIQUE (discussion_id, request_id),
	UNIQUE (child_session_id, child_session_generation),
	UNIQUE (discussion_id, kickoff_client_message_id),
	FOREIGN KEY (discussion_id) REFERENCES review_discussions(discussion_id)
) STRICT, WITHOUT ROWID;
`;
