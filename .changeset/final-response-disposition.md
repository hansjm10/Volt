---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Replaced tool termination hints with bounded final-response dispositions and added typed local abort provenance. ([#199](https://github.com/volt-hq/Volt/issues/199))

Migrate `AgentToolResult.terminate` and `AfterToolCallResult.terminate` to `disposition: "stop"`; use `disposition: "final_response"` when a successful tool should authorize one additional tool-free response.
