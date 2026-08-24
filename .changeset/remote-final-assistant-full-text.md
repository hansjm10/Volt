---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Remote clients can now retrieve complete sanitized assistant transcript text for the latest turn and paginated older entries. ([#85](https://github.com/volt-hq/Volt/issues/85), [#86](https://github.com/volt-hq/Volt/issues/86))

The branch-latest assistant message is served complete (up to the 256 KiB live assistant content budget) in conversation bootstraps, resync checkpoints, `get_transcript` head pages, and its transcript commit frame. Older or over-budget entries remain bounded in transcript pages and can be retrieved through the paginated `get_transcript_entry_text` RPC.
