---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-ai": minor
---

breaking(agent): Added delivery-aware next-action dispatch and explicit event-stream failure propagation.

Exhaustive `AgentEvent` consumers must handle `delivery_start`. Low-level loops now always use delivery-aware dispatch: migrate `prepareNextTurn` to `prepareRequest`, and replace `shouldStopAfterTurn`, `getSteeringMessages`, and `getFollowUpMessages` with policy-only `nextAction` decisions plus payload ownership in `prepareDeliveries` or `Agent.hostDelivery()`. Migrate Agent `prepareQueuedMessages` hooks to `prepareDelivery`.
