---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Removed the legacy Agent wrapper in favor of AgentHarness.

Migrate stateful integrations to `AgentHarness` with a `Session` and execution environment, or use `agentLoop()` only when the host owns persistence and lifecycle orchestration.
