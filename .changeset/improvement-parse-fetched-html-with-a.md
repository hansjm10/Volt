---
"@hansjm10/volt-coding-agent": patch
---

improvement(web-fetch): Parse fetched HTML with a real parser instead of tag-stripping regexes, preserving code block whitespace and dropping nav and footer chrome, and detect non-public addresses by comparing address bytes so alternate IPv6 spellings of loopback can no longer bypass the fetch guard.
