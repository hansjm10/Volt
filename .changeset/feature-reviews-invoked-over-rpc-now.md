---
"@hansjm10/volt-coding-agent": patch
---

feature(review): [Remote clients can now run detached reviews](https://volt-cli.dev/docs/rpc/#detached-review-workflows) of uncommitted changes, branches, commits, and pull requests while the conversation remains available. ([#66](https://github.com/volt-hq/Volt/issues/66), [#80](https://github.com/volt-hq/Volt/issues/80))

Accepted invocations return a workflow ID immediately and stream sanitized progress events. Clients can fetch findings, list or cancel workflows, and open completed findings in a fresh session on demand.
