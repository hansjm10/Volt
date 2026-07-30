---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Shared conversations now recover reliably across daemon restarts and branch changes while rejecting stale or duplicate device input.

Input acknowledgements and queued delivery remain durable, outstanding records are bounded, audits identify the acting device, and Live Activities retire for every attached device.
