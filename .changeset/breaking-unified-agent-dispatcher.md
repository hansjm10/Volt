---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(agent): Changed queued and direct agent input to use one transactional dispatcher with explicit request authority and delivery-level admission.

Low-level loop integrations must replace `shouldStopAfterTurn`, `prepareNextTurn`, `getSteeringMessages`, and `getFollowUpMessages` with `nextAction` returning `request`, `pause`, or `stop`, and move provider-request refresh work to `prepareRequest`. Every request now declares `reason: "delivery" | "continuation"`; delivery-dependent requests whose entries are all revoked do not prepare or call the provider. External queues should lease deliveries in `nextAction` and transfer ownership synchronously with `beginDelivery`, after which `delivery_start` marks the irrevocable boundary. `Agent.prepareDelivery` now returns `{ messages, commit? }`, with staged commit work run only after begin succeeds. Queue clear methods return the exact revoked runtime IDs. `Agent.continue({ drainFollowUps: true })` must become `Agent.continue()`; pending user deliveries are selected by the dispatcher automatically.
