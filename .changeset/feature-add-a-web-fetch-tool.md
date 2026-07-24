---
"@hansjm10/volt-coding-agent": patch
---

feature(web-fetch): Add a web_fetch tool that reads a single URL as text, so agents can follow up on web_search results without pulling whole pages into context. Only URLs that already appeared in the conversation as user input or a tool result can be fetched; URLs the model writes itself are refused. Output size is bounded, and requests to non-public addresses are rejected before and after every redirect.
