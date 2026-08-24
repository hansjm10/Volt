---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Streamed message deltas can no longer bypass host path redaction on Iroh remote connections.

Delta-only `message_update` frames are now derived from sanitized accumulated text, and the host replaces the client accumulator with a fully sanitized snapshot whenever redaction rewrites text that already streamed (including tool-call arguments), so remote clients can no longer reassemble a complete redacted host path from deltas split across frames. As before, an incomplete prefix of a path may still appear in individual frames until the completing snapshot rewrites it.
