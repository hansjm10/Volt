---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Warn each long-running subagent at 80 turns and require its final report after 120 turns.

Host `turnLimits` overrides stay consistent: an unset warning threshold clamps to `min(80, maxTurns)`, an explicit `warnAtTurns` above a finite `maxTurns` is rejected, and an infinite `maxTurns` without an explicit warning disables both stages.
