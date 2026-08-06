---
"@hansjm10/volt-coding-agent": patch
---

fix(atomic-append): Fixed uncertain atomic session appends without exposing stale live conversation state. ([#217](https://github.com/volt-hq/Volt/issues/217))

Reconciliation now classifies storage effect separately from generation authority, retires stale managers before they can overwrite newer session bytes, fences queued canonical projection responses, and permits a fresh runtime generation to reopen the authoritative session.
