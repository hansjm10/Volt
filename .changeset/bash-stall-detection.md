---
"@hansjm10/volt-coding-agent": patch
---

improvement(tools): Bash commands that stop producing output are now killed as hung after five minutes, and timed-out commands no longer leave stray processes running. ([#125](https://github.com/volt-hq/Volt/issues/125))

Silence, not elapsed time, is what separates a hung command from a slow one, so long-running commands no longer need an inflated `timeout` to stay safe. Pass `stallTimeout` to adjust the window for commands that are legitimately quiet for long stretches, or `0` to disable the check. Explicit `timeout` values are now capped at one hour.

Teardown now enumerates the whole process tree before signalling, so a child that moved itself into its own process group — as test runners and daemons commonly do — is killed rather than orphaned. Commands also get a brief SIGTERM grace period to clean up before SIGKILL.
