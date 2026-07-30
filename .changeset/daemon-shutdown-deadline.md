---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Made daemon restarts recover promptly from stalled network teardown without interrupting admitted work.

Accepted remote streams, pairing tickets, control requests, and startup state now drain within a bounded shutdown window before durable state closes. If the operating system refuses termination, shutdown fails closed instead of risking overlapping daemon ownership.
