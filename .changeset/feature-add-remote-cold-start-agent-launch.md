---
"@hansjm10/volt-coding-agent": patch
---

feature(coding-agent): Add remote cold-start agent launch management for paired clients.

Launch publication now remains fenced by current client/workspace authority through durable last-session selection and the final commit flush. New-worktree launches durably reserve their recovery receipt before checkout creation, recover checkouts whose daemon record was interrupted, and retain the receipt until verified worktree-first cleanup succeeds. Catalog, authorization-race, and cleanup failures return stable retryable responses without terminating the management stream.
