---
"@hansjm10/volt-coding-agent": patch
---

fix(atomic-append): Fixed uncertain atomic session appends without exposing stale live conversation state. ([#217](https://github.com/volt-hq/Volt/issues/217))

Reconciliation now classifies exact persisted bytes, rejects malformed committed JSONL, fences stale projection output, and permits a fresh runtime generation to reopen the authoritative session.
