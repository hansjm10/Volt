CREATE TABLE app_store_entitlements (
    app_transaction_id text PRIMARY KEY CHECK (
        app_transaction_id ~ '^[A-Za-z0-9_-]{1,128}$'
    ),
    environment text NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
    product_id text,
    subscription_group_id text,
    status text NOT NULL CHECK (
        status IN ('active', 'grace', 'billing_retry', 'expired', 'revoked', 'inactive')
    ),
    entitled_until timestamptz,
    source_signed_at timestamptz NOT NULL,
    last_verified_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
        (status IN ('active', 'grace') AND entitled_until IS NOT NULL)
        OR status NOT IN ('active', 'grace')
    )
);

CREATE TABLE grant_entitlements (
    grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
    app_transaction_id text NOT NULL UNIQUE REFERENCES app_store_entitlements(app_transaction_id),
    bound_claim_created_at timestamptz NOT NULL,
    bound_at timestamptz NOT NULL
);
CREATE INDEX grant_entitlements_app_transaction_id
    ON grant_entitlements (app_transaction_id);

CREATE TABLE app_store_approval_proofs (
    proof_identity_hash bytea PRIMARY KEY CHECK (octet_length(proof_identity_hash) = 32),
    claim_id text NOT NULL REFERENCES pairing_claims(id) ON DELETE CASCADE,
    app_transaction_id text NOT NULL REFERENCES app_store_entitlements(app_transaction_id),
    proof_created_at timestamptz NOT NULL,
    consumed_at timestamptz NOT NULL
);
CREATE INDEX app_store_approval_proofs_consumed_at
    ON app_store_approval_proofs (consumed_at);

-- No managed-relay users exist at this protocol cutover. Revoke every
-- pre-entitlement grant explicitly so old refresh keys cannot become an
-- untracked compatibility path; affected development pairings must bootstrap
-- again through App Store-authorized approval.
UPDATE grants
SET revoked_at = COALESCE(revoked_at, transaction_timestamp());
UPDATE endpoints
SET revoked_at = COALESCE(revoked_at, transaction_timestamp());

CREATE TABLE app_store_notifications (
    notification_uuid text PRIMARY KEY CHECK (
        notification_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    app_transaction_id text NOT NULL REFERENCES app_store_entitlements(app_transaction_id),
    source_signed_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL
);
CREATE INDEX app_store_notifications_received_at
    ON app_store_notifications (received_at);
