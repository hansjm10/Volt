---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Bound production and canary relay fleets to their exact managed credential services.

Daemon startup now rejects persisted managed credentials, pending claims, and revocation authority from a different built-in broker or relay set before connecting.
