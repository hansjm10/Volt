---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Every delegation tree now shares default root-scope structural safeguards of depth 5, 100 total starts, and 16 concurrently active descendants in addition to per-call and per-definition limits.

Structural admission failures reject new starts without aborting admitted descendants. SDK hosts can override every limit through `SubagentManagerOptions.delegationLimits`; turn, token, cost, and deadline budgets remain unlimited unless the host supplies finite values, and crossing a configured consumption budget cancels the whole tree.
