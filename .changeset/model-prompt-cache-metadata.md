---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(caching): Added authoritative model-specific prompt cache retention metadata and safer provider cache controls.

Custom providers and `models.json` configurations must replace `compat.supportsLongCacheRetention` with model or provider `promptCache` metadata. Declare `retention.long` to enable the `long` preference, or set `promptCache` to `null` in an override to clear inherited cache behavior for an incompatible proxy.
