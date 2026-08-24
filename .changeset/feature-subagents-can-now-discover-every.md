---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): [Subagents can now discover, follow, and resume runs across the session tree](https://volt-cli.dev/docs/usage/#subagents-mvp), with bounded pagination and confirmation before duplicate work starts. ([#129](https://github.com/volt-hq/Volt/issues/129), [#136](https://github.com/volt-hq/Volt/issues/136), [#146](https://github.com/volt-hq/Volt/issues/146))

Spawn preflights show the live registry and require an exact one-time confirmation before starting agents. Admission is atomic, confirmation tokens remain available under small output limits, and mismatched tokens rotate without locking out the request.

Interrupted runs can be recovered after a restart or disconnect. Resume mode reloads a child from its transcript and lets it finish the original task without another confirmation round-trip.

Registry access remains available when policy prevents further spawning. Pages use stable newest-first cursors; current, ancestor, and dependency-cycle runs are non-followable; and followed output is marked as untrusted data. Explicit registry calls and failures remain visible in the TUI, while successful spawn preflights stay hidden.
