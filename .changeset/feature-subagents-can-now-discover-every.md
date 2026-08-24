---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): [Subagents can now discover, follow, and resume runs across the session tree](https://volt-cli.dev/docs/usage/#subagents-mvp), with bounded pagination and confirmation before duplicate work starts. ([#129](https://github.com/volt-hq/Volt/issues/129), [#136](https://github.com/volt-hq/Volt/issues/136), [#146](https://github.com/volt-hq/Volt/issues/146))

Spawn preflights show the live registry and require exact one-time confirmation before new work starts, helping agents reuse equivalent runs instead of duplicating them.

Interrupted children can resume from their transcripts after restarts or disconnects. Registry listing and follow remain available when spawning is disabled, and followed output remains explicitly marked as untrusted data.
