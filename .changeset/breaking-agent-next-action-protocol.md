---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-ai": minor
---

breaking(agent): Added delivery-aware next-action dispatch and explicit event-stream failure propagation.

Exhaustive `AgentEvent` consumers must handle `delivery_start`. Existing low-level loop configurations remain on legacy polling unless they provide `nextAction`, `beginDelivery`, or `prepareRequest`.
