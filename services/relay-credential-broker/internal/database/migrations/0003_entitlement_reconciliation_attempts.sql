-- Refresh-triggered Apple attempts are independent of successful verification.
-- A reservation survives failures and is shared by every endpoint and replica.
ALTER TABLE app_store_entitlements
    ADD COLUMN last_reconcile_attempt_at timestamptz;
