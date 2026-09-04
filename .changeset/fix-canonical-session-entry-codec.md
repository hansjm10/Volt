---
"@hansjm10/volt-coding-agent": patch
---

fix(sessions): Rejected malformed or contradictory session data, including overlong identities and blank JSONL records, before it can change live or persisted state.
