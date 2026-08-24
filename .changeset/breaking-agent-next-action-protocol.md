---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-ai": minor
---

breaking(agent): Changed low-level agent dispatch to use delivery-aware next actions and explicit event-stream failure propagation.

Exhaustive `AgentEvent` consumers must handle `delivery_start`. Low-level loops now always use delivery-aware dispatch: migrate `prepareNextTurn` to `prepareRequest`, and replace `shouldStopAfterTurn`, `getSteeringMessages`, and `getFollowUpMessages` with `nextAction` plus explicit deliveries. Migrate queued-message hooks to an `AgentDeliveryOwner` installed before admission.
