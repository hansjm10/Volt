---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Reduced in-process subagent streaming overhead by roughly 4–7× for long outputs.

Parent-child RPC frames now pass as structured objects in-process, avoiding repeated serialization and quadratic work.
