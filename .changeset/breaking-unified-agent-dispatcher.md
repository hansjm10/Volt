---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(agent): Changed queued and direct agent input to use one transactional dispatcher with request-only preparation.

Low-level loop integrations must replace `shouldStopAfterTurn`, `prepareNextTurn`, `getSteeringMessages`, and `getFollowUpMessages` with `nextAction` returning `request`, `pause`, or `stop`, and move provider-request refresh work to `prepareRequest`. `Agent.continue({ drainFollowUps: true })` must become `Agent.continue()`; pending user deliveries are now selected by the dispatcher automatically.
