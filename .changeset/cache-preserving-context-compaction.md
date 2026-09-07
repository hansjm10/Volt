---
"@hansjm10/volt-coding-agent": patch
---

improvement(compaction): Compact context in one cache-preserving request when it fits, with a small summary budget, bounded retries and cancellation-safe fallback for oversized input.

Built-in summary generation keeps the current reasoning setting for cache reuse, requests at most 4096 summary tokens, and has a five-minute deadline. Empty, truncated, tool-calling or overlong summaries leave the original context intact.
