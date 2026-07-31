---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Remote clients can request a correlated assistant-stream recovery snapshot after detecting frame loss, restoring live transcripts without waiting for the message boundary.

Recovery validates the client's exact stream position and continues from a matching checkpoint.
