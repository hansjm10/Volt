---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(boundaries): Public input, reducer, session-state, and queue-publication boundaries now expose owned readonly projections.

Migrate code that assigns through `AgentSession.state` to the corresponding session mutation APIs; every state property and its tool/message arrays, pending-tool set, and pending-tool map are now readonly. `AgentHarness.steer()` and `followUp()` now resolve only after passive queue publication completes, while `queueSteer()` and `queueFollowUp()` remain synchronous.
