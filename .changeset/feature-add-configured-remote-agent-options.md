---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): [Configured remote agents](https://volt-cli.dev/docs/daemon/#configured-remote-agents) can now discover read-only workspace defaults and retry caller-named conversation creation safely.

Clients can discover workspace model defaults without side effects, provision worktrees separately, and safely retry the normal configured attach flow with the same session identity.
