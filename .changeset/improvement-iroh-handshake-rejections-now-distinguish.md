---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Iroh handshake failures now distinguish permanently missing workspaces (`workspace_missing`) from transiently unavailable ones (`workspace_unavailable` with a `retryAfterMs` hint), so clients can stop or pace retries. ([#88](https://github.com/volt-hq/Volt/issues/88))
