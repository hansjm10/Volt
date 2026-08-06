---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(sessions): Enforced lossless JSON data for persisted session payloads and isolated event snapshots while containing subscriber failures. ([#213](https://github.com/volt-hq/Volt/issues/213))

Custom messages, tool details and updates, diagnostics, compaction details, branch summaries, and extension replacements must now use plain JSON values. Replace `Map`, `Set`, `Date`, typed arrays, shared memory, cycles, and other rich objects with plain object, array, string, number, boolean, or null representations, and omit optional properties instead of assigning `undefined`.
