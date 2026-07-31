---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-ai": minor
---

breaking(remote): Remote conversations now use an atomic resumable attachment and input-delivery protocol across reconnects and daemon restarts.

Remote conversation clients must upgrade with the daemon because conversation attachment now uses the versioned atomic bootstrap-and-tail protocol instead of the legacy snapshot replay sequence.

Prompt, steer, and follow-up commands now require a stable `clientMessageId`, which the host echoes on the canonical user transcript entry.

The host now durably deduplicates prompt, steer, and follow-up retries by `clientMessageId`, including across daemon restarts.
Private retry receipts never appear as blank conversations in local or remote session history.

Conversation runtime, lease, direct-stream, and relay ownership now remain under one stable coordinator through handoff, rekey, reconnect, and retirement.
