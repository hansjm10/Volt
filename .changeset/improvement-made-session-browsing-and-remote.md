---
"@hansjm10/volt-coding-agent": minor
---

breaking(sessions): Made session listing, exact-ID resolution, continuation lookup, and remote history discovery independent of transcript payload size by moving live session storage to SQLite ([#328](https://github.com/volt-hq/Volt/issues/328)).

Persisted `SessionManager.create`, `open`, `continueRecent`, and `forkFrom` calls are now asynchronous. Replace live session-file paths and `getSessionFile()` with `SessionReference` values and `getSessionRef()`. JSONL remains available only for explicit current-format snapshot import and export. Awaited `AgentSession` or `AgentSessionRuntime` disposal releases its manager; callers that directly own a persisted `SessionManager` must await `closePersistence()`. Deep fuzzy, phrase, and regex search still scans extracted searchable text, bounded to one session document in memory at a time.
