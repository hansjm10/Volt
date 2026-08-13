---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

feature(tools): Added durable cache-friendly message-anchored tool loading, reactivation, navigation restore, and request-aware compaction admission. ([#237](https://github.com/volt-hq/Volt/issues/237))

Branches now distinguish inherited defaults from explicit requested tools, retain temporarily unavailable names across reload and navigation, and reactivate them when extension or MCP definitions return. Proactive compaction admits the exact transformed provider request and resumes one checkpoint successor without redelivery or queue drain. Provider, extension, persistence, and RPC observers receive tool snapshots only when the final provider payload attests them.
