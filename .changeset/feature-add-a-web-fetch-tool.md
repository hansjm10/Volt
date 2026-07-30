---
"@hansjm10/volt-coding-agent": patch
---

feature(web-fetch): Agents can now use `web_fetch` to retrieve approved public URLs as bounded readable text after `web_search` or a user-provided link.

Only URLs already present in the conversation as user input or trusted tool output are eligible; model-constructed and delegated-task URLs are refused. Requests to non-public addresses are rejected before and after every redirect, response buffering and extracted metadata are bounded, and cancellation remains effective during hostname resolution.

HTML extraction preserves code formatting while removing navigation and footer chrome. Parsing and truncation stay within fixed resource limits, including for boundary-heavy pages and alternate IPv6 address spellings.
