---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Added durable parallel finding discussions with independent read-only conversations and upgraded session storage. ([#341](https://github.com/volt-hq/Volt/issues/341))

Before opening existing session stores with this version, stop older Volt CLI and daemon processes that own those stores. The first open upgrades the exact supported v1 schema transactionally to v2 while preserving sessions and transcripts. Older binaries cannot reopen upgraded stores. Update the iOS companion together with the host; the discussion RPC contract has no older-host fallback.
