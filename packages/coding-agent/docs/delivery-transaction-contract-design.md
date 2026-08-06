# Coding-agent delivery transaction contract

Issue: [#206](https://github.com/volt-hq/Volt/issues/206)

This document specifies the observable delivery behavior for coding-agent and its dispatcher integration. #206 established the behavioral contract, #207 added Agent's transaction participant, #205 migrated coding-agent persistence to that participant and removed the temporary commit adapter, and #217 defined reconciliation when an atomic replacement reports failure after its candidate may already be visible.

## Scope

The contract covers direct prompts, steering, follow-ups, and continuations where coding-agent participates in Agent delivery with persistence, client-input, RPC, planning, and lifecycle work.

The contract does not promise exactly-once provider calls or extension side effects across process loss. A durable ambiguity fence is allowed when the host cannot prove that an external side effect did not occur.

## Vocabulary

- **Logical delivery:** One immutable unit of input coordinated by Agent. It keeps the same identity, payload, delivery kind, and per-kind FIFO position across retained attempts.
- **Delivery attempt:** One selection, lease, preparation, and commit cycle for a logical delivery during an Agent run.
- **Lease:** Agent's revocable, exclusive authority to prepare a delivery. Coding-agent receives the leased delivery as a capability; it does not own a second lease or shadow delivery state machine.
- **Persistence participant:** Coding-agent work attached to an attempt for client-input state, canonical transcript entries, planning state, checkpoints, and durability. It may stage or settle host state but does not select deliveries.
- **Commit decision:** The linearization point at which Agent closes the lease to caller revocation and accepts responsibility for settling the participant. A later definitive participant rollback may retain the logical delivery, but clear/revoke cannot win after this point.
- **Logical commit:** Successful durable settlement of all delivery-coupled host state. After logical commit, the delivery is permanently consumed and can never be retained, revoked, or redelivered.
- **Publication:** Delivery and message lifecycle events exposed to observers. Publication reports state; observers are not transaction participants and cannot change the outcome by throwing.
- **Durability:** Completion of the SessionManager persistence watermark required by an outcome. In-memory append or event publication alone is not durability.
- **Continuation:** Authority for a provider request without a new logical delivery, including tool continuation, retry, compaction recovery, and final response.
- **Conversation authority:** SessionManager's generation-scoped authority to project and mutate the canonical conversation. Its status is either `available` or sticky `reconciliation_required`; the latter retains the first unresolved atomic-replacement cause until a fresh manager reopens the session bytes.

`deliveryId`, durable `clientMessageId`, runtime queue identity, and RPC correlation `id` are distinct. A retained attempt preserves `deliveryId`. A same-`clientMessageId` retry joins or replays the original logical input. An RPC correlation ID identifies one invocation and does not deduplicate delivery.

## Ownership and irreversible boundary

Agent is the sole delivery coordinator. It owns admission policy, per-kind FIFO ordering, leases, revocation, and retained redelivery. Coding-agent owns only its persistence participant and projections of Agent-owned queues. Agent synchronously reports successful revocation through `deliveryRevoked`; coding-agent uses that notification to invalidate prepared payloads and reconcile its durable client-input and queue projections without changing the Agent-owned outcome.

Preparation is revocable and side-effect-free. It may validate or compose staged messages, but it must not:

- mutate the canonical transcript or planning state;
- complete or fail a durable client receipt;
- remove queue ownership;
- invoke a provider;
- publish delivery or message events; or
- perform a non-repeatable extension side effect.

Composed participants must settle as one transaction. An implementation cannot perform one irreversible participant commit, fail a later participant, and classify the delivery as safely retained. If it cannot prove that every committed effect rolled back, the outcome is `terminally_failed`.

The **commit decision** is the exact cutoff for external revocation. Before it, clear, abort, or dispose may prevent commitment. After it, clear cannot report the delivery as removed. Abort or dispose may stop the run, but must join the participant's settlement and preserve a successful logical commit.

A participant failure after the commit decision has one of two deterministic classifications:

1. **Definitive rollback:** the participant proves no delivery-coupled durable state committed. The attempt is `retained`; this is a transaction outcome, not a late revocation.
2. **Uncertain or irreversible failure:** the participant cannot prove safe replay. The logical delivery is `terminally_failed` for the current Agent runtime generation. That generation consumes the delivery terminally and must not retry, requeue, or publish it as committed.

An atomic replacement that reports failure is reconciled from exact bytes, not by attempting another replacement back to the preimage. Current-schema committed JSONL lines must be valid UTF-8 JSON objects; permissive legacy parsing cannot classify an atomic preimage. A malformed unterminated final fragment remains the supported torn-tail case, and a complete final object without its line delimiter remains committed. Preimage, candidate, and post-sync visibility comparisons use exact bytes. If the unchanged preimage (including an originally missing file) is visible, the attempt is definitively rolled back. If the exact candidate is visible, SessionManager rolls forward: it fsyncs the target through a write-capable, non-truncating handle and then the supported parent directory, re-reads the target, and commits the staged indexes only if the exact candidate remains visible. Publication, direct RPC acceptance, and provider work remain behind that proof.

If visibility cannot be classified exactly, candidate synchronization fails, or the post-sync bytes cannot be reverified, the persistence watermark remains rejected and conversation authority becomes sticky `reconciliation_required` with the first unresolved cause. The transition synchronously suspends the old projection source, discards conversation frames that have not reached transport, retires correlated host interactions, and suppresses every later AgentSession event from that generation. Non-projection control responses remain available so the host can report the failure and request cleanup or runtime replacement. Staged indexes remain unpublished and every conversation, planning, transcript, queue, and client-input projection or mutation is unavailable rather than reporting either an old in-memory preimage or an unproven candidate. The only remaining capabilities are stable session identity and file path, abort, queue hand-back for runtime replacement, disposal/final drain, and runtime replacement itself. These capabilities must not begin extension hooks, MCP preparation, provider/helper completion, shell execution, queue mutation, planning transitions, custom-message mutation, or an Agent run.

A fresh SessionManager establishes a new authority generation by reopening the authoritative JSONL bytes. Replacement teardown may acknowledge only the rejected persistence watermark recorded by that retired manager; unrelated persistence, MCP, and subagent cleanup failures still fail replacement. Reopening the same file and session ID is a generation refresh, not a registry or lease rekey, but it still rotates projection authority and publishes a fresh cursor-zero bootstrap. An exact candidate contains the canonical delivery and completed client input, so startup completes it without replay. An exact preimage may still contain the accepted queued input: startup may recover and replay that input exactly once in the fresh Agent generation because direct RPC acceptance, delivery publication, provider execution, and other post-proof side effects never crossed the failed durability boundary. This recovery does not retry the terminal delivery object from the failed generation.

No outcome depends on whether an observer, abort, or dispose happens between adjacent public events.

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
leased
  -> preparing
       -> retained                 (preparation failed without side effects)
       -> revoked                  (revocation won before preparation completed)
       -> prepared
            -> revoked
            -> committing
                 -> committed           (logical durability completed)
                 -> retained            (definitive rollback)
                 -> terminally_failed   (unsafe or ambiguous replay)
```

Every selected attempt reaches exactly one terminal attempt outcome. One failed attempt cannot keep its run unsettled or trigger an unbounded automatic continuation loop.

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
3. lease and prepare without delivery-coupled side effects;
4. make the commit decision;
5. settle and durably flush `started`, planning transition, checkpoint, and canonical user state in one ordered participant transaction;
6. settle the RPC prompt response;
7. publish delivery/message projections without granting observers rollback authority;
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

On dequeue, the participant durably crosses `started`, removes the queue projection, commits the canonical identified user entry, and completes the client input exactly once. Steering is selected before follow-up. Follow-up waits until independent provider/tool continuation is exhausted or explicit follow-up draining is requested.

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

`delivery_start` is a post-settlement projection: the participant has already returned `committed`, so observers cannot alter the transaction outcome. The event is not a separate disk-durability or RPC-acceptance receipt. For each delivery, `delivery_start` precedes its ordered `message_start`/`message_end` pairs. The planning checkpoint precedes its feedback message in provider context, the direct RPC response follows canonical durability, and the provider request follows that response boundary. Public session subscribers are observers: throwing synchronously or returning a rejected promise cannot roll back delivery, transcript, client-input, RPC, or planning state, escape as an unhandled rejection, or prevent later observers from receiving the event.

Extension hooks that explicitly replace delivery messages are prepared before the commit decision and cached by Agent delivery identity, so a retained retry cannot rerun the hook or drift the provider payload. Their validation failure is terminally fenced by the participant. Passive public observers remain post-commit projections.

## Abort and dispose

### Before commit decision

- Abort prevents the attempt from committing and retains the logical delivery unless the caller explicitly clears it.
- Dispose closes new admission and prevents commit. An identified queued input with a durable queued payload remains `accepted` for recovery; anonymous uncommitted work is revoked; work that crossed a non-repeatable `started` boundary without a recoverable payload is terminally fenced as failed or ambiguous.
- Canonical transcript and planning state remain unchanged.

### During participant durability

The commit decision and lifecycle request have a deterministic winner:

- If abort/dispose closes admission first, the participant does not commit and the delivery is retained or terminalized according to the proven persistence outcome.
- If the commit decision wins, revocation is invalid. Abort/dispose waits for participant settlement. A successful logical commit is preserved before an abort marker; a definitive rollback retains the delivery; uncertainty terminally fences it.
- A reentrant abort/dispose requested from inside participant work records intent but must not synchronously await the work that invoked it. It cannot deadlock or retroactively revoke a successful commit.

### After logical commit

Abort stops provider/tool continuation, but preserves canonical delivery, completed client input, RPC acceptance, planning transition, and checkpoint. If the run needs a terminal abort marker, it follows committed delivery messages. Dispose is idempotent, drains owned subsystems, seals the final persistence watermark, and makes late callbacks inert.

## Failure and concurrency matrix

| Scenario | Logical delivery / attempt | Canonical transcript | Client input | RPC invocation | Planning |
|---|---|---|---|---|---|
| Preparation fails | Delivery retained; attempt settles `retained` | Unchanged | Queued input remains `accepted`; direct invocation receives a bounded nonterminal failure | Settles once; acknowledged queue RPC is unchanged | Unchanged |
| Definitive durability failure | Delivery retained; attempt settles `retained` | Unchanged | Remains `accepted` | Settles once; no later duplicate response | Unchanged |
| Ambiguous durability failure | Delivery `terminally_failed` and non-retryable in this Agent generation | Live projection unavailable until a fresh manager reopens authoritative bytes | Live projection unavailable; reopened candidate is complete, while reopened accepted preimage may recover once in a fresh generation | Settles once with failure unless already acknowledged | Live projection unavailable until reload |
| External abort during durability | Commit decision deterministically wins or loses; losing pre-commit attempt is retained | No partial state; successful commit is preserved | Matches the winning transaction | Settles once | Matches canonical outcome; no divergence |
| Reentrant abort/dispose during participant work | Records lifecycle intent without deadlock; participant outcome remains authoritative | Successful participant state precedes abort marker | Settles from participant outcome | Settles once | Successful transition is preserved |
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
- reentrant disposal during participant settlement;
- successful and partial `all` batches with one planning transition/checkpoint; and
- preservation of a committed batch prefix when a later delivery is retained.

#207 makes the participant-level acceptance cases executable in `packages/agent/test/agent-delivery-transaction.test.ts` and `packages/agent/test/agent-next-action.test.ts`. Those tests cover retained retry with stable identity, definitive versus ambiguous settlement, deterministic preflight, lifecycle races and reentrancy, committed-observer isolation, and provider-only continuation without recommit. Lease mechanics remain covered by `packages/agent/test/delivery-inbox.test.ts`.

#205 adds consumer-level fault-stage coverage in `packages/coding-agent/test/suite/regressions/205-delivery-participant-migration.test.ts`. It proves that canonical durability precedes delivery publication and that a failure after canonical append is terminally fenced rather than replayed.

#217 adds disk-backed reconciliation coverage in `packages/coding-agent/test/suite/regressions/217-uncertain-atomic-append-reconciliation.test.ts`. It proves exact-preimage retention, cross-platform exact-candidate roll-forward, proof-gated planning/RPC/provider publication, sticky reconciliation-required authority, immediate rejection before conversation side effects, and cleanup/runtime replacement. It also proves that reopening a candidate completes without replay, while reopening an accepted preimage recovers exactly once in a fresh Agent generation with later queued input still ordered.

## Non-goals

This contract does not choose:

- participant callback names, parameters, return types, or asynchronous representation;
- an Agent run-result type;
- a new RPC response shape or protocol version;
- a storage transaction or commit-marker implementation;
- exactly-once provider, tool, or extension side effects across process loss;
- automatic replay of `started`/ambiguous client input;
- batch-atomic `all` delivery;
- new queue priorities; or
- durable local TUI input before its ordinary session watermark.

A reviewer should be able to classify the logical delivery, attempt, durable client input, RPC invocation, canonical transcript, and planning outcome from this document and the conformance tests without reading `AgentSession` internals.
