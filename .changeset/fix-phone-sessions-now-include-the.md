---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): The default phone tool grant now includes `inspect` and `lsp`, so Plan mode on a paired device can use vetted Git/GitHub inspection and language-server reads like the TUI. ([#153](https://github.com/volt-hq/Volt/issues/153))

Applies to new pairings and to devices switched to the tracking grant; devices paired before this release stay on their frozen grant until re-paired or reset. `lsp` is also classified as unsafe alongside `bash`, `edit`, and `write`, since its rename and fix actions edit workspace files.
