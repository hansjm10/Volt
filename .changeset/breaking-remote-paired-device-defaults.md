---
"@hansjm10/volt-coding-agent": minor
---

breaking(remote): Changed paired-device defaults to track daemon tool grants and include `host.manage.v1`, `inspect`, and `lsp` capabilities. ([#153](https://github.com/volt-hq/Volt/issues/153), [#154](https://github.com/volt-hq/Volt/issues/154))

Devices paired before this release retain their frozen pair-time tool grant and no longer receive extension-registered tools through the default grant. Re-pair the device or reset its access to the coding preset to adopt the tracking grant. Explicitly customized grants remain pinned.

`host.manage.v1` enables capability advertisement, host-action responses, and keep-awake without a custom access grant. The `inspect` and `lsp` tools make Plan mode inspection available from paired devices; `lsp` is classified as unsafe alongside `bash`, `edit`, and `write` because its rename and fix actions can edit workspace files.
