---
"@hansjm10/volt-coding-agent": patch
---

improvement(sessions): Made session browsing and remote history discovery fast regardless of transcript size by moving live session storage to indexed SQLite ([#328](https://github.com/volt-hq/Volt/issues/328)).

Existing JSONL histories migrate once into private per-workspace stores. Session IDs now carry immutable generations so stale runtimes cannot write into deleted and recreated sessions.
