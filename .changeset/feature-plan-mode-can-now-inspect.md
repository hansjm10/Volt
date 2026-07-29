---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(plan): Plan mode can now inspect Git and GitHub context and use explicitly trusted MCP reads while keeping mutating operations blocked.

SDK migration: `AgentSession.setAgentMode()` is now asynchronous. Callers must `await session.setAgentMode(...)` before reading planning state or active tools.
