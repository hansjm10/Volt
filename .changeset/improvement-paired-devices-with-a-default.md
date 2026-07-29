---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Newly paired devices with a default tool grant now track the daemon's defaults, automatically picking up new builtin tools; only explicitly customized grants stay pinned. ([#154](https://github.com/volt-hq/Volt/issues/154))

Devices paired before this release keep their frozen pair-time grant (an old snapshot is indistinguishable from an explicit customization). Because a frozen grant no longer counts as default, such devices also lose access to extension-registered tools until switched over. Re-pair the device, or reset its access to the coding preset, to switch it to tracking.
