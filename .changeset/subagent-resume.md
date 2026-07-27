---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): Interrupted subagent runs recovered after a restart can now be resumed: the subagent tool's resume mode reloads the child from its transcript and lets it finish its original task, with no confirmation round-trip. ([#129](https://github.com/volt-hq/Volt/issues/129))
