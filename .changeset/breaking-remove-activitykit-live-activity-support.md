---
"@hansjm10/volt-coding-agent": minor
---

breaking(remote): Removed ActivityKit Live Activity support from remote sessions.

Clients must stop sending `register_live_activity` and `unregister_live_activity` RPC commands or ActivityKit token data in `register_push_target`. Use ordinary completion notifications through `register_push_target` instead.
