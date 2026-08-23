CREATE TABLE grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_node_id text NOT NULL CHECK (host_node_id ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE TABLE endpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grant_id uuid NOT NULL REFERENCES grants(id),
    kind text NOT NULL CHECK (kind IN ('host', 'app')),
    node_id text NOT NULL CHECK (node_id ~ '^[0-9a-f]{64}$'),
    refresh_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_token_hash) = 32),
    refresh_inactive_expires_at timestamptz NOT NULL,
    last_refreshed_at timestamptz,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    UNIQUE (grant_id, kind, node_id)
);

CREATE UNIQUE INDEX endpoints_one_host_per_grant
    ON endpoints (grant_id)
    WHERE kind = 'host';
CREATE INDEX endpoints_grant_id ON endpoints (grant_id);

CREATE TABLE pairing_claims (
    id text PRIMARY KEY,
    claim_secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(claim_secret_hash) = 32),
    host_node_id text NOT NULL CHECK (host_node_id ~ '^[0-9a-f]{64}$'),
    grant_id uuid REFERENCES grants(id),
    bootstrap_host_refresh_hash bytea CHECK (
        bootstrap_host_refresh_hash IS NULL OR octet_length(bootstrap_host_refresh_hash) = 32
    ),
    approved_app_endpoint_id uuid REFERENCES endpoints(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    approved_at timestamptz,
    exchanged_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (
        (grant_id IS NULL AND bootstrap_host_refresh_hash IS NOT NULL)
        OR grant_id IS NOT NULL
    )
);
CREATE INDEX pairing_claims_expires_at ON pairing_claims (expires_at);
CREATE INDEX pairing_claims_grant_id ON pairing_claims (grant_id);

CREATE TABLE consumed_app_check_tokens (
    jti_hash bytea PRIMARY KEY CHECK (octet_length(jti_hash) = 32),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz NOT NULL
);
CREATE INDEX consumed_app_check_tokens_expires_at
    ON consumed_app_check_tokens (expires_at);
