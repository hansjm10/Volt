---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Removed delivery payloads from next-action policy decisions so one inbox owns admission and revocation.

Migrate `nextAction` results that include `deliveries` to `prepareDeliveries`, or enqueue host-owned payloads with `Agent.hostDelivery()` before returning a delivery request. `Agent.prompt()` and `Agent.continue()` now resolve to `AgentRunResult`; inspect `status` to handle bounded delivery failures explicitly.
