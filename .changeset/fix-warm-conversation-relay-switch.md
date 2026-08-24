---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Kept phone relay connections responsive while warm conversation switches finish.

Relay offers now wait until the target session runtime is ready instead of reaching it mid-switch.
