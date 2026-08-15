---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(delivery): Delivery participants now receive the stable delivery identity, kind, and isolated reduced messages in their transaction context.

Migrate `AgentDeliveryTransactionParticipant.settle()` implementations to persist `context.messages` instead of messages captured during `prepareDelivery`. `AgentDeliveryPreparation` fields and its message array are now readonly. Create a fresh participant on every preparation attempt with the same prepared payload; a changed replay payload is terminally fenced instead of retried.

Prompt deliveries are now admitted before abortable preflight, completed system-prompt and message transformations survive retained retries, passive delivery lifecycle events publish only after canonical commitment, and disposal terminally fences the Harness while revoking all retained delivery and continuation state without joining an active callback.
