---
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Recover from provider context overflows that return no summary output by using chunked compaction, while continuing to reject genuinely truncated summaries.
