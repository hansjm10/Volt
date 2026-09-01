# Coding-agent delivery transaction contract

Issue: [#206](https://github.com/volt-hq/Volt/issues/206)

This document specifies the observable delivery behavior for coding-agent and its Harness integration. #206 established the behavioral contract, #207 established explicit delivery outcomes, #205 moved coding-agent persistence behind canonical settlement, #211 isolated delivery projections, #214 fenced reentrant shutdown, and #217 defined reconciliation when an atomic replacement reports failure after its candidate may already be visible.

## Scope

The contract covers direct prompts, steering, follow-ups, and continuations where coding-agent supplies an `AgentDeliveryOwner` for persistence, client-input, RPC, planning, and lifecycle work.

The contract does not promise exactly-once provider calls or extension side effects across process loss. A durable ambiguity fence is allowed when the host cannot prove that an external side effect did not occur.

## Vocabulary

- **Logical delivery:** One immutable unit of input coordinated by Agent. It keeps the same identity, payload, delivery kind, and per-kind FIFO position across retained attempts.
- **Delivery attempt:** One selection, lease, preparation, and commit cycle for a logical delivery during an Agent run.
- **Delivery owner:** The stable capability installed before admission. It prepares the logical payload once, commits fresh attempts, and passively finishes host projections without selecting deliveries.
- **Commit decision:** The linearization point at which Harness closes the attempt to caller revocation and accepts responsibility for owner settlement. A later verified rollback may retain the logical delivery, but clear/revoke cannot win after this point.
- **Projection cursor:** A store-issued authority generation, revision, and branch identity used to classify same-branch, descendant, and divergent canonical changes.
- **Mutation receipt:** An opaque store-issued capability proving the exact committed or no-effect projection delta and its delivery ID, inbox epoch, and attempt ID.
- **Logical commit:** Successful durable settlement of all delivery-coupled host state. After logical commit, the delivery is permanently consumed and can never be retained, revoked, or redelivered.
- **Publication:** Delivery and message lifecycle events exposed to observers. Publication reports state; observers do not own settlement and cannot change the outcome by throwing.
- **Durability:** Completion of the SessionManager persistence watermark required by an outcome. In-memory append or event publication alone is not durability.
- **Continuation:** Authority for a provider request without a new logical delivery, including tool continuation, retry, compaction recovery, and final response.
- **Conversation authority:** SessionManager's generation-scoped authority to project and mutate the canonical conversation. Its status is either `available` or sticky `reconciliation_required`; the latter retains the first cause for which persisted SQLite state could not be proven to match that manager until a fresh manager reopens the authoritative session record.

`deliveryId`, durable `clientMessageId`, runtime queue identity, and RPC correlation `id` are distinct. A retained attempt preserves `deliveryId`. A same-`clientMessageId` retry joins or replays the original logical input. An RPC correlation ID identifies one invocation and does not deduplicate delivery.

## Ownership and irreversible boundary

Harness is the sole delivery coordinator. It owns admission policy, per-kind FIFO ordering, attempt epochs, revocation, and retained redelivery. Coding-agent constructs one stable `AgentDeliveryOwner` before admission and projects Harness-owned queues. Revocation is reported once through `owner.finish({ outcome: "revoked" })`; coding-agent reconciles durable client-input and queue projections without changing the Harness-owned outcome.

`prepareLogical()` is revocable and side-effect-free. One successful immutable result is cached for the logical delivery. It may validate or compose staged messages, but it must not:

- mutate the canonical transcript or planning state;
- complete or fail a durable client receipt;
- remove queue ownership;
- invoke a provider;
- publish delivery or message events; or
- perform a non-repeatable extension side effect.

`commitAttempt()` receives a fresh attempt ID and must settle all local delivery state as one transaction. An implementation cannot perform one irreversible effect, fail a later effect, and classify the delivery as safely retained. A retained result requires a store-verifiable no-effect receipt. If exact rollback cannot be proven, the outcome is `terminally_failed`.

The **commit decision** is the exact cutoff for external revocation. Before it, clear, abort, or close may prevent commitment. After it, clear cannot report the delivery as removed. Abort or close may stop the run, but closure joins owner settlement and preserves a successful logical commit.

An owner failure after the commit decision has one of two deterministic classifications:

1. **Definitive rollback:** the owner returns a no-effect receipt proving that no delivery-coupled durable state committed and the current manager still owns conversation authority. The attempt is `retained`; this is a transaction outcome, not a late revocation.
2. **Uncertain, irreversible, or authority-losing failure:** the owner cannot prove safe replay in the current generation. The logical delivery is `terminally_failed` for that Harness runtime generation. That generation consumes the delivery terminally and must not retry, requeue, or publish it as committed.

Atomic transaction failures classify two independent properties: storage effect (`not_started`, `rolled_back`, `uncertain`, or `committed`) and conversation authority (`available` or `reconciliation_required`). Each transaction carries the expected session revision, a unique commit identity, and a digest of its canonical payload. The SQLite worker inserts the canonical mutations, derived session metadata, client-input state, and commit evidence in one transaction. After an ordinary success, the returned evidence proves the exact before/after revision. After a worker or commit failure, SessionManager opens a fresh store boundary and reconciles the commit identity and digest: matching evidence proves commitment, an absent commit with the unchanged expected revision proves rollback, and any mismatched/unreadable/advanced state is uncertain and retires authority. Publication, direct RPC acceptance, and provider work remain behind that proof.

Unreadable database state, a revision conflict, mismatched commit evidence, or an outcome that cannot be reconciled makes conversation authority sticky `reconciliation_required` with the first unresolved cause. The transition synchronously suspends the old projection source, discards conversation frames and canonical conversation-derived RPC responses that have not reached transport, retires correlated host interactions, and suppresses every later AgentSession event from that generation. Non-projection control and error responses remain available so the host can report the failure and request cleanup or runtime replacement. Staged indexes remain unpublished and every conversation, planning, transcript, queue, and client-input projection or mutation is unavailable rather than reporting either an old in-memory snapshot or unproven persisted state. The only remaining capabilities are stable session identity/reference, abort, queue hand-back for runtime replacement, disposal/final drain, and runtime replacement itself.

A fresh SessionManager establishes a new authority generation by reopening the authoritative SQLite session record through its stable `SessionReference`. Replacement teardown may acknowledge the retired manager's recorded reconciliation failure even when validation stopped before a persistence watermark rejected; unrelated persistence, MCP, and subagent cleanup failures still fail replacement. Reopening the same store/session identity is a generation refresh, not a registry or lease rekey, but it still rotates projection authority and publishes a fresh cursor-zero bootstrap. A committed candidate contains the canonical delivery and completed client input, so startup completes it without replay. An authoritative rolled-back record may still contain the accepted queued input: startup may recover and replay that input exactly once in the fresh Agent generation because direct RPC acceptance, delivery publication, provider execution, and other post-proof side effects never crossed the failed durability boundary.

No outcome depends on whether an observer, abort, or close request happens between adjacent public events.

## Canonical authority and provider admission

`SessionManagerHarnessStorage` projects one canonical branch and owns its mutation lane. Every Harness-visible message, custom message, model/thinking change, compaction, and navigation passes through guarded declarative batches; host-only receipt and planning entries may join the same atomic `SessionManager.appendAtomically()` transaction without entering provider context.

A projection cursor carries authority generation, revision, and branch identity. Reconciliation classifies lineage before message effect:

- `same` accepts provider-inert or persisted-policy changes without relying on object identity;
- `descendant` reports an exact append or rewrite using the same reducer as `buildSessionContext()`; and
- `diverged` requires a replacement and invalidates arbitrary frozen continuation context.

Committed and retained attempt results carry opaque store receipts. Harness resolves the receipt through the originating session, verifies delivery ID, epoch, attempt ID, and exact message delta, and only then admits provider work. A durable committed result remains committed even if later host projection cleanup fails. An uncertain result retires conversation authority, suppresses provider work, and never appends a guessed failure state.

Provider admission uses a short linearization barrier: settle delivery durability, run hooks outside the canonical mutation lane, reconcile the cursor, await ordered model/thinking persistence, snapshot message and runtime-configuration epochs, begin provider invocation, then release the barrier. Changes after invocation begins apply to the next request.

Runs, compaction, and tree navigation share Harness's `HarnessOperationCoordinator`. Expensive structural work remains abortable; the coordinator rechecks lifecycle and cursor, seals the operation, and submits one noncancelable canonical batch. Manual compaction reserves the successor after an active run, while tree navigation remains fail-fast when busy. Closure after the seal waits for the structural commit and suppresses passive publication.

## State machines

### Logical delivery

```text
pending
  -> committed
  -> revoked
  -> terminally_failed
```

A retained attempt returns the logical delivery to `pending`; retention is not a terminal logical outcome.

### Delivery attempt

```text
queued -> preparing -> ready -> settling -> committed
   |         |          |         |------> ready (explicit retained result)
   |         |          |         `------> terminally_failed
   |         `----------> queued (revocation won before preparation completed)
   `------------ queued|preparing|ready -> revoking -> revoked
```

Every asynchronous completion checks the delivery epoch and attempt ID. Settling attempts cannot be revoked. Every selected attempt reaches exactly one attempt outcome; a retained outcome returns the logical delivery to `ready` for an explicit later continuation.

### Durable client input

```text
accepted -> started -> completed
    |           |
    |           -> failed
    -> failed
```

- `accepted` means the original input, or the exact transformed queued payload, is durably recoverable.
- `started` fences replay before a potentially non-repeatable boundary.
- A canonical identified user entry implies `completed`.
- `started` without a canonical or terminal entry is ambiguous and cannot be replayed automatically.
- A retained queued delivery remains `accepted`; retention must not falsely mark the logical input failed.

### Run attempt

A run that encounters a retained delivery attempt settles once after its error lifecycle. It does not declare the logical delivery terminal. Explicit `continue()` starts a later attempt; explicit clear/discard revokes the logical delivery.

Provider failure after logical commit is a run failure, not a delivery failure. Retry and compaction reuse canonical context and never recommit the original delivery.

### RPC invocation

Every RPC invocation emits at most one response and settles independently of the logical delivery lifetime.

- A direct prompt invocation succeeds only after its required canonical/client-input durability watermark.
- If a direct attempt is retained before RPC acceptance, that invocation returns one error; the client input remains accepted and a same-`clientMessageId` invocation may retry it.
- Steering and follow-up RPC invocations succeed after durable queue admission. A later retained delivery attempt does not emit a second response or terminal `client_input_outcome`.
- A later terminal failure of previously acknowledged queued input emits `client_input_outcome` after durable failure, never a second command response.
- Response transport loss does not change durable state. Repeating the semantic input with the same `clientMessageId` joins or replays it under the new RPC correlation ID.

## The retained-failure settlement rule

If an attempt fails and the logical delivery is retained:

1. The **attempt** settles as `retained` and the current Agent run reaches its normal settlement boundary with one failure lifecycle.
2. The **logical delivery** returns to pending with the same identity, exact payload, kind, and FIFO position.
3. A durable queued **client input** remains `accepted`; it is neither `completed` nor `failed`.
4. An already acknowledged steer/follow-up **RPC invocation** remains successfully settled and receives no second response. A not-yet-accepted direct prompt invocation receives one failure response.
5. **Planning and canonical transcript state** remain unchanged.
6. Only explicit continuation retries the delivery. Explicit clear/discard instead revokes it and terminalizes any identified queued input consistently.

This separates “this attempt failed” from “the user's logical input is terminal.”

## Ordering

### Identified direct prompt

The required causal order is:

1. append and durably flush the client receipt;
2. complete abortable input and model/auth preflight;
3. prepare the logical delivery without delivery-coupled side effects;
4. make the commit decision;
5. atomically commit and durably flush `started`, planning transition, checkpoint, and canonical user state through the owner;
6. settle the RPC prompt response;
7. verify the store receipt and publish delivery/message projections without granting observers rollback authority;
8. invoke the provider or continue the run.

RPC acceptance, publication, and provider work all remain behind the required durability fence.

### Identified steering and follow-up

Admission order is:

1. append and flush the receipt;
2. persist the exact post-preflight payload and queue class;
3. flush queue admission;
4. admit the same payload to Agent;
5. publish `queue_update`;
6. settle the queueing RPC invocation.

On dequeue, the owner atomically crosses `started`, removes durable queue ownership, commits the canonical identified user entry, and completes the client input exactly once. Steering is selected before follow-up. Follow-up waits until independent provider/tool continuation is exhausted or explicit follow-up draining is requested.

### Planning feedback

The first committed user-bearing delivery against a `ready` plan logically commits:

```text
planning_state_change(ready -> draft)
plan checkpoint
canonical feedback messages
```

The checkpoint precedes feedback in provider context. Preparation failure, definitive durability failure, pre-commit abort, or revocation leaves the plan `ready` and creates no checkpoint.

For an `all` batch, delivery commitment remains per-delivery rather than batch-atomic, but the batch performs at most one `ready -> draft` transition and creates at most one checkpoint. If no user-bearing delivery commits, neither planning effect occurs. If an earlier delivery commits and a later delivery is retained, the one transition remains committed with the earlier feedback.

### Public events

`delivery_start` is a post-settlement projection: Harness has verified the owner's committed receipt, so observers cannot alter the transaction outcome. The event is not a separate disk-durability or RPC-acceptance receipt. For each delivery, `delivery_start` precedes its ordered `message_start`/`message_end` pairs. The planning checkpoint precedes its feedback message in provider context, the direct RPC response follows canonical durability, and the provider request follows that response boundary. Public session subscribers are observers: throwing synchronously or returning a rejected promise cannot roll back delivery, transcript, client-input, RPC, or planning state, escape as an unhandled rejection, or prevent later observers from receiving the event.

Extension hooks that explicitly replace delivery messages run during logical preparation and are cached by delivery identity, so a retained retry cannot rerun the hook or drift the provider payload. Their validation failure is terminally fenced by the owner. Passive public observers remain post-commit projections.

## Abort and close

### Before commit decision

- Abort prevents the attempt from committing and retains the logical delivery unless the caller explicitly clears it.
- Close fences new admission and prevents commit. An identified queued input with a durable queued payload remains `accepted` for recovery; anonymous uncommitted work is revoked; work that crossed a non-repeatable `started` boundary without a recoverable payload is terminally fenced as failed or ambiguous.
- Canonical transcript and planning state remain unchanged.

### During owner durability

The commit decision and lifecycle request have a deterministic winner:

- If abort/close fences admission first, the owner does not commit and the delivery is retained or terminalized according to the proven persistence outcome.
- If the commit decision wins, revocation is invalid. Closure waits for owner settlement. A successful logical commit is preserved before an abort marker; a verified rollback retains the delivery; uncertainty terminally fences it.
- A reentrant abort/close request from owner work records synchronous intent but cannot retroactively revoke a successful commit.

`AgentDeliveryOwner` callbacks receive `requestAbort()` and `requestClose()` as one-way lifecycle capabilities. `AgentHarness.requestClose()` and `AgentSession.dispose()` are fence-only and return `void`; they reject new work, signal the open abort gate, and return without joining the callback. External lifecycle code calls `waitForClosed()` after leaving owner callbacks.

Owner implementations request lifecycle intent, return their authoritative `committed`, `retained`, or `terminally_failed` outcome, and let external code join closure. `finish()` is invoked exactly once for attempt exit or revocation and performs passive projection cleanup only; it cannot write canonical state.

### After logical commit

Abort stops provider/tool continuation, but preserves canonical delivery, completed client input, RPC acceptance, planning transition, and checkpoint. If the run needs a terminal abort marker, it follows committed delivery messages. Close is idempotent: the fence makes late callbacks inert, and `waitForClosed()` resolves after the active operation, owner settlement, notifications, and persistence drain.

## Failure and concurrency matrix

| Scenario | Logical delivery / attempt | Canonical transcript | Client input | RPC invocation | Planning |
|---|---|---|---|---|---|
| Preparation fails | Delivery retained; attempt settles `retained` | Unchanged | Queued input remains `accepted`; direct invocation receives a bounded nonterminal failure | Settles once; acknowledged queue RPC is unchanged | Unchanged |
| Definitive durability failure with authority preserved | Delivery retained; attempt settles `retained` | Unchanged | Remains `accepted` | Settles once; no later duplicate response | Unchanged |
| Disk/live mismatch before writing | Delivery `terminally_failed` and non-retryable in the stale Agent generation | Stale live projection unavailable; fresh manager follows disk | Reopened accepted input may recover once in a fresh generation | Settles once with failure unless already acknowledged | Stale live projection unavailable until reload |
| Ambiguous durability failure | Delivery `terminally_failed` and non-retryable in this Agent generation | Live projection unavailable until a fresh manager reopens authoritative bytes | Live projection unavailable; reopened candidate is complete, while reopened accepted non-candidate state may recover once in a fresh generation | Settles once with failure unless already acknowledged | Live projection unavailable until reload |
| External abort during durability | Commit decision deterministically wins or loses; losing pre-commit attempt is retained | No partial state; successful commit is preserved | Matches the winning transaction | Settles once | Matches canonical outcome; no divergence |
| Reentrant abort/close during owner work | Records fence intent without deadlock; owner outcome remains authoritative | Successful owner commit precedes abort marker | Settles from owner outcome | Settles once | Successful transition is preserved |
| Abort after commit | Delivery committed; run may abort | Preserved | `completed` | Accepted/success unchanged | Transition and checkpoint preserved |
| Explicit discard of retained delivery | Delivery revoked | Unchanged | Identified queued input becomes durably `failed` | Earlier queue response unchanged; terminal outcome event may follow | Unchanged |
| Observer throws or rejects after publication | Delivery committed | Preserved | Unchanged (`completed`) | Unchanged | Preserved; rejection is handled and later observers still run |
| `all` batch fails after an earlier commit | Earlier delivery committed; unbegun delivery retained/revoked in FIFO order | Contains only committed deliveries | Each input matches its own outcome | Each invocation remains independently settled | At most one committed ready-to-draft transition/checkpoint |

## Conformance suite

`packages/coding-agent/test/suite/regressions/206-delivery-transaction-contract.test.ts` exercises the observable session, Agent, client-input, planning, event, and provider behavior. Its executable baseline covers:

- durable identified direct-prompt settlement at the RPC admission seam;
- steering and follow-up queue admission through canonical completion;
- preparation failure, direct and queued retained attempts, explicit retry, synchronous planning-commit rejection, and explicit discard;
- external abort before commit and while canonical durability is pending;
- reentrant close during owner settlement;
- successful and partial `all` batches with one planning transition/checkpoint; and
- preservation of a committed batch prefix when a later delivery is retained.

#207 makes the owner-level acceptance cases executable in `packages/agent/test/harness/agent-harness-delivery-transaction.test.ts` and `packages/agent/test/harness/agent-harness-lifecycle.test.ts`. Those tests cover retained retry with stable identity, store-verifiable receipts, deterministic preflight, lifecycle races and reentrancy, committed-observer isolation, and provider-only continuation without recommit. Inbox mechanics remain covered by `packages/agent/test/delivery-inbox.test.ts`.

#205 adds consumer-level fault-stage coverage in `packages/coding-agent/test/suite/regressions/205-delivery-participant-migration.test.ts`. It proves that canonical durability precedes delivery publication and that a failure after canonical append is terminally fenced rather than replayed. #211 covers payload isolation and exact receipt deltas; #214 covers reentrant close without callback joins.

#217 provides SQLite-backed reconciliation coverage in `packages/coding-agent/test/suite/regressions/217-uncertain-atomic-append-reconciliation.test.ts`. It proves revision-conflict fencing, commit-identity reconciliation, definitive rollback retention, proof-gated planning/RPC/provider publication, stale-manager retirement, sticky reconciliation-required authority, queued canonical-response fencing, cleanup/runtime replacement, and exact-once recovery after reopening authoritative accepted input.

## Non-goals

This contract does not promise:

- distributed atomicity for arbitrary external side effects outside the canonical store;
- changes to the existing `AgentRunResult` shape;
- a new RPC response shape or protocol version;
- a storage transaction or commit-marker implementation;
- exactly-once provider, tool, or extension side effects across process loss;
- automatic replay of `started`/ambiguous client input;
- batch-atomic `all` delivery;
- new queue priorities; or
- durable local TUI input before its ordinary session watermark.

A reviewer should be able to classify the logical delivery, attempt, durable client input, RPC invocation, canonical transcript, and planning outcome from this document and the conformance tests without reading `AgentSession` internals.
