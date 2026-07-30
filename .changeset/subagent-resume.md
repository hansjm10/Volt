---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): [Interrupted subagent runs](https://volt-cli.dev/docs/usage/#subagents-mvp) can now be rediscovered, followed, and resumed after a restart or disconnect, with recovered results surfaced in local and remote transcripts. ([#129](https://github.com/volt-hq/Volt/issues/129), [#136](https://github.com/volt-hq/Volt/issues/136))

Resume mode reloads an interrupted child from its transcript and lets it finish the original task without another confirmation round-trip.
