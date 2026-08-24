---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Completed reviews no longer resurface after their findings are opened or dismissed over RPC. ([#78](https://github.com/volt-hq/Volt/issues/78), [#281](https://github.com/volt-hq/Volt/issues/281))

A declined or failed open keeps the review available. After a successful open, `get_review_result` for that workflow ID fails and the findings live in the seeded session.
