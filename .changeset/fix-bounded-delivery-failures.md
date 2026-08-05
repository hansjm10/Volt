---
"@hansjm10/volt-coding-agent": patch
---

fix(agent): Stopped persistent queued-delivery failures from retrying indefinitely.

Delivery commit callbacks now reject reentrant session abort or disposal; request lifecycle changes after the active Agent run settles.
