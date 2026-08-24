---
"@hansjm10/volt-coding-agent": patch
---

feature(web-fetch): Agents can now use [`web_fetch`](https://volt-cli.dev/docs/usage/#tool-options) to retrieve approved public URLs as bounded readable text after `web_search` or a user-provided link.

Only links supplied by the user or returned by approved tools are eligible. Non-public destinations are rejected before and after redirects, and response size, parsing work, metadata, and DNS cancellation remain bounded.

Readable HTML extraction removes navigation and footer chrome while preserving code formatting.
