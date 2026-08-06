---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Added explicit host delivery transaction outcomes and asynchronous participant settlement. ([#207](https://github.com/volt-hq/Volt/issues/207))

Migrate `AgentLoopConfig.beginDelivery` from a boolean admission result to `AgentLoopDeliveryOutcome`, returning `committed`, `revoked`, `retained`, or `terminally_failed`. `Agent.prompt()` and `Agent.continue()` now return `AgentRunResult`; inspect `status` and `deliveries` instead of assuming `Promise<void>`. Hosts that require durability should return an `AgentDeliveryTransactionParticipant` from `prepareDelivery` and settle Agent's commit decision explicitly.
