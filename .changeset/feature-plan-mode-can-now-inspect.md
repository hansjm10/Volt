---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(plan): Activating Plan mode is now asynchronous so its read-only Git, GitHub, and explicitly trusted MCP inspection tools are ready before planning starts.

SDK migration: `AgentSession.setAgentMode()` is now asynchronous. Callers must `await session.setAgentMode(...)` before reading planning state or active tools.
