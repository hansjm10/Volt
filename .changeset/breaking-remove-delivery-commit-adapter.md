---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Removed the temporary synchronous delivery commit adapter. ([#205](https://github.com/volt-hq/Volt/issues/205))

Migrate `AgentDeliveryPreparation.commit` to `participant.settle()`, returning an explicit `committed`, `retained`, or `terminally_failed` outcome. Rename `Agent.activeDeliveryCommitSettled` to `Agent.activeDeliverySettlement` when coordinating lifecycle teardown with in-flight participant work.
