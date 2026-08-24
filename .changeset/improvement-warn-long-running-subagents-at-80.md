---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Long-running subagents now receive a wrap-up warning at 80 turns and a tool-free final-report prompt at 120 turns.

Host `turnLimits` overrides stay consistent: an unset warning threshold clamps to `min(80, maxTurns)`, an explicit `warnAtTurns` above a finite `maxTurns` is rejected, and an infinite `maxTurns` without an explicit warning disables both stages.
