---
"@hansjm10/volt-coding-agent": minor
---

breaking(remote): Local development credential brokers now support separate approvals and repeated pairings on the same device using nonce-prefixed proofs.

Development callers must replace bare shared-secret `signedAppTransaction` values with `<64-lowercase-hex nonce>.<shared secret>`. Generate the nonce with `openssl rand -hex 32` once per new proof instance and retain the exact composed proof, device ID, app node ID, and refresh-token hash for retries of the same claim. New pairings require a fresh nonce; keep the device ID stable. `VOLT_DEVELOPMENT_APP_STORE_PROOF` remains the shared secret. No database reset or migration is required, and Apple verification is unchanged.
