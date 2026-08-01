---
"@hansjm10/volt-coding-agent": patch
---

feature(coding-agent): Add remote cold-start agent launch management for paired clients.

Launch publication now remains fenced by current client/workspace authority through durable last-session selection and the final commit flush. Interrupted worktree launches retain their receipt until worktree-first cleanup succeeds, and catalog, authorization-race, and cleanup failures return stable retryable responses without terminating the management stream.
