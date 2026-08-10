---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Upgraded review to immutable two-pass verification with durable structured findings and lifecycle actions. ([#228](https://github.com/volt-hq/Volt/issues/228))

RPC clients must migrate review results from transient workflow IDs and legacy `file`/`line` and model-authored coverage fields to durable run IDs, structured change/evidence locations, verification metadata, and host-derived coverage. Clients must also handle complete and incomplete results, paginate durable run listings, and use the new finding lifecycle actions.

The lifecycle now also:

- Opens all findings when a blank finding selection starts a fix session.
- Persists detached review records for empty sessions across restarts.
- Reports incomplete reviews consistently through host actions, detached workflows, and notifications.
- Inherits unchanged incremental coverage only from the requested compatible completed review.
- Requires verification passes to independently inspect in-scope changed files before completion.
- Keeps feedback export local-only so remote clients cannot write caller-selected host paths.
- Allows paired remote clients to record outcomes, rerun reviews, and publish reviews.
- Preserves changed-line locations when reviewed source begins with diff header markers.
- Keeps reviews with unsupported in-scope changes incomplete.
