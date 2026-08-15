---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(session): Canonical continuations and structural operations now use store-issued cursors and guarded atomic batches. ([#211](https://github.com/volt-hq/Volt/issues/211))

Custom `SessionStorage` implementations must provide atomic branch snapshots, exact/descendant guarded `commitBatch()` operations, opaque mutation receipts, and committed/rolled-back/uncertain classification. Harness continuation state now tracks a `ProjectionCursor` plus owned overlay messages; canonical appends reconcile, rewrites invalidate arbitrary overlays, compaction installs a replacement, and tree navigation clears it.

Runs, compaction, and tree navigation share one Harness operation coordinator. Structural hooks remain abortable until the coordinator seals and submits their single noncancelable canonical commit.
