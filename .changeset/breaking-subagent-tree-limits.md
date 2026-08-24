---
"@hansjm10/volt-coding-agent": minor
---

breaking(subagents): Replaced implicit delegation-tree consumption budgets with explicit structural safeguards and host-configured token, cost, and deadline limits.

Hosts that rely on finite tree-wide token, cost, or deadline budgets must configure them explicitly. Hosts that need more than depth 5, 100 total starts, or 16 concurrently active descendants must raise the corresponding `SubagentManagerOptions.delegationLimits` values.

Structural admission failures reject only new starts without aborting admitted descendants. Per-call, per-definition, and per-child turn safeguards continue to apply.
