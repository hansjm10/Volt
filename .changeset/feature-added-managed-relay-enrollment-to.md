---
"@hansjm10/volt-coding-agent": patch
---

feature(remote): [Managed relay enrollment](https://volt-cli.dev/docs/daemon/) now runs through the normal daemon pairing flow, so paired iOS clients connect without manually configured relay credentials.

The credential service refreshes and explicitly revokes node-bound credentials, persists state across broker restarts and replicas, and keeps enrollment retryable through reconnects, pairing cancellation, daemon restarts, and stalled networking.

Production and canary relay fleets are bound to their exact broker and relay origins. Expired, revoked, or cross-environment credentials are rejected, and established connections close when access expires.
