---
"@hansjm10/volt-coding-agent": minor
---

breaking(agent-session): Removed Agent injection and mutable runtime exposure from AgentSession.

Construct `AgentSession` with model, stream, conversion, and queue configuration. Use the explicit session capabilities for abort, runtime events, transport, active tool projections, and scoped turn policy.
