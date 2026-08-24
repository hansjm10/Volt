---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

feature(fast): Added session-scoped [Fast mode](https://volt-cli.dev/docs/usage/#slash-commands) with `/fast` controls, a TUI status indicator, and OpenAI Priority processing for eligible OpenAI and OpenAI Codex models. ([#110](https://github.com/volt-hq/Volt/issues/110), [#111](https://github.com/volt-hq/Volt/issues/111), [#112](https://github.com/volt-hq/Volt/issues/112))

Fast mode persists per branch independently from thinking, synchronizes across attached clients, carries into review inference and findings sessions, and is advertised only for models that support it.
