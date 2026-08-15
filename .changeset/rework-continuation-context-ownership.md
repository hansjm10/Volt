---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(agent): Reworked continuation context ownership so retries, compaction, and branch navigation use validated Harness projections.

Session context implementations must now provide `anchorLeafId`. Update `rebaseContinuationContext()` projectors to synchronously accept `readonly AgentMessage[]`, and use the returned token's `projectionId`, `source`, and `anchorLeafId` fields when tracking conditional cancellation with `clearContinuationContext()`. Call `invalidateContinuationContext()` after navigation.
