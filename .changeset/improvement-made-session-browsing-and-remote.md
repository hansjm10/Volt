---
"@hansjm10/volt-coding-agent": minor
---

breaking(sessions): Made session browsing and remote history discovery fast regardless of transcript size by moving live session storage to indexed SQLite ([#328](https://github.com/volt-hq/Volt/issues/328)).

Persisted `SessionManager.create`, `open`, `continueRecent`, and `forkFrom` calls are now asynchronous. Replace live session-file paths and `getSessionFile()` with `SessionReference` values and `getSessionRef()`. Existing JSONL histories migrate once into private per-workspace stores; JSONL remains available for explicit snapshot import and export.
