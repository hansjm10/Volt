---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Kept review snapshots and searches fast, bounded, and reliable across large trees, unusual Git paths, sparse checkouts, and Windows. ([#249](https://github.com/volt-hq/Volt/issues/249))

Snapshot collection now returns safe incomplete results for binary or oversized content. Searches read immutable Git trees directly, return bounded pages without prefetching excess blobs, preserve ignored and sparse tracked files, and handle non-UTF-8 or oversized pathnames, configured Git pathspec modes, and Windows `NUL` artifacts.
