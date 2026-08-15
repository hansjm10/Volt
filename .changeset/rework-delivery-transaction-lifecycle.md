---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(delivery): Replaced delivery participants with stable owners, attempt-bound store receipts, and fence-first closure. ([#205](https://github.com/volt-hq/Volt/issues/205), [#207](https://github.com/volt-hq/Volt/issues/207), [#214](https://github.com/volt-hq/Volt/issues/214))

Replace `prepareDelivery` and transaction participants with an `AgentDeliveryOwner` installed before admission. Implement side-effect-free `prepareLogical()`, atomic `commitAttempt()`, and passive `finish()`; committed and retained outcomes require store-verifiable receipts bound to delivery ID, inbox epoch, attempt ID, and exact canonical projection delta.

`AgentHarness.dispose()` is now a synchronous fence-only alias for `requestClose()`. Call `waitForClosed()` externally to join active operations, delivery settlement, notifications, and persistence. Owner callbacks may request abort or close but must not join closure from inside themselves.
