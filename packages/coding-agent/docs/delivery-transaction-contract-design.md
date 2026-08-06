# Coding-agent delivery transaction contract

Issue: [#206](https://github.com/volt-hq/Volt/issues/206)

This document specifies the target observable delivery behavior for coding-agent and its replacement dispatcher integration. It deliberately does not specify a production API, callback shape, storage primitive, or refactor. #206 changes no production behavior: its executable tests pin the guarantees the temporary adapter already provides, while named pending conformance cases identify guarantees that require #207's transaction participant. #205 must preserve the completed suite when it removes the adapters.

## Scope

The contract covers direct prompts, steering, follow-ups, and continuations where coding-agent participates in Agent delivery with persistence, client-input, RPC, planning, and lifecycle work.

The contract does not promise exactly-once provider calls or extension side effects across process loss. A durable ambiguity fence is allowed when the host cannot prove that an external side effect did not occur.

## Vocabulary

- **Logical delivery:** One immutable unit of input coordinated by Agent. It keeps the same identity, payload, delivery kind, and per-kind FIFO position across retained attempts.
- **Delivery attempt:** One selection, lease, preparation, and commit cycle for a logical delivery during an Agent run.
- **Lease:** Agent's revocable, exclusive authority to prepare a delivery. Coding-agent receives the leased delivery as a capability; it does not own a second lease or shadow delivery state machine.
- **Persistence participant:** Coding-agent work attached to an attempt for client-input state, canonical transcript entries, planning state, checkpoints, and durability. It may stage or settle host state but does not select deliveries.
- **Commit decision:** The linearization point at which Agent closes the lease to caller revocation and accepts responsibility for settling the participant. Under the temporary adapter, this is the successful begin of the prepared delivery. A later definitive participant rollback may retain the logical delivery, but clear/revoke cannot win after this point.
- **Logical commit:** Successful durable settlement of all delivery-coupled host state. After logical commit, the delivery is permanently consumed and can never be retained, revoked, or redelivered.
- **Publication:** Delivery and message lifecycle events exposed to observers. Publication reports state; observers are not transaction participants and cannot change the outcome by throwing.
- **Durability:** Completion of the SessionManager persistence watermark required by an outcome. In-memory append or event publication alone is not durability.
- **Continuation:** Authority for a provider request without a new logical delivery, including tool continuation, retry, compaction recovery, and final response.

`deliveryId`, durable `clientMessageId`, runtime queue identity, and RPC correlation `id` are distinct. A retained attempt preserves `deliveryId`. A same-`clientMessageId` retry joins or replays the original logical input. An RPC correlation ID identifies one invocation and does not deduplicate delivery.

## Ownership and irreversible boundary

Agent is the sole delivery coordinator. It owns admission policy, per-kind FIFO ordering, leases, revocation, and retained redelivery. Coding-agent owns only its persistence participant and projections of Agent-owned queues.

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
2. **Uncertain or irreversible failure:** the participant cannot prove safe replay. The logical delivery is `terminally_failed` and durable client input remains failed or `started`/ambiguous. It is never automatically replayed.

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
5. settle `started`, planning transition, checkpoint, and canonical user state in one ordered participant transaction;
6. publish delivery/message projections without granting observers rollback authority;
7. flush the required durability watermark;
8. settle the RPC prompt response;
9. invoke the provider or continue the run.

The implementation may interleave publication with step 5 while persistence settles, but observer timing cannot change the transaction outcome, and RPC/provider work must remain behind the required durability fence.

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

`delivery_start` means Agent has crossed the revocation cutoff; it does not by itself mean disk durability or RPC acceptance. For each delivery, `delivery_start` precedes its ordered `message_start`/`message_end` pairs. The planning checkpoint precedes its feedback message in provider context, the direct RPC response follows canonical durability, and the provider request follows that response boundary. Public session subscribers are observers: throwing synchronously or returning a rejected promise cannot roll back delivery, transcript, client-input, RPC, or planning state, escape as an unhandled rejection, or prevent later observers from receiving the event.

Extension hooks that explicitly replace messages or perform preflight are not passive public observers; their documented validation and failure behavior remains part of preparation or participant work.

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
| Ambiguous durability failure | Delivery `terminally_failed`; no replay | No unproven canonical entry is projected | Durable `started` ambiguity or `failed` fence | Settles once with failure unless already acknowledged | No unproven transition is projected |
| External abort during durability | Commit decision deterministically wins or loses; losing pre-commit attempt is retained | No partial state; successful commit is preserved | Matches the winning transaction | Settles once | Matches canonical outcome; no divergence |
| Reentrant abort/dispose during participant work | Records lifecycle intent without deadlock; participant outcome remains authoritative | Successful participant state precedes abort marker | Settles from participant outcome | Settles once | Successful transition is preserved |
| Abort after commit | Delivery committed; run may abort | Preserved | `completed` | Accepted/success unchanged | Transition and checkpoint preserved |
| Explicit discard of retained delivery | Delivery revoked | Unchanged | Identified queued input becomes durably `failed` | Earlier queue response unchanged; terminal outcome event may follow | Unchanged |
| Observer throws or rejects after publication | Delivery committed | Preserved | Unchanged (`completed`) | Unchanged | Preserved; rejection is handled and later observers still run |
| `all` batch fails after an earlier commit | Earlier delivery committed; unbegun delivery retained/revoked in FIFO order | Contains only committed deliveries | Each input matches its own outcome | Each invocation remains independently settled | At most one committed ready-to-draft transition/checkpoint |

## Conformance suite

`packages/coding-agent/test/suite/regressions/206-delivery-transaction-contract.test.ts` exercises the temporary adapter path through observable session, Agent, client-input, planning, event, and provider behavior. Its executable baseline covers:

- durable identified direct-prompt settlement at the RPC admission seam;
- steering and follow-up queue admission through canonical completion;
- preparation failure, direct and queued retained attempts, explicit retry, synchronous planning-commit rejection, and explicit discard;
- external abort before commit and while canonical durability is pending;
- reentrant disposal during commit;
- successful and partial `all` batches with one planning transition/checkpoint; and
- preservation of a committed batch prefix when a later delivery is retained.

The suite also names pending semantic cases rather than implementing temporary `AgentSession` transaction state to make them pass:

- retained direct RPC failure followed by explicit same-`clientMessageId` retry;
- definitive versus ambiguous persistence-watermark failure;
- direct feedback preflight leaving a ready plan unchanged;
- external dispose versus reentrant abort during participant durability;
- synchronous and asynchronous committed-delivery observer isolation; and
- provider-only continuation without recommitting client-input or planning state.

Those cases are acceptance criteria for #207. #207 must replace the pending cases with executable conformance tests using semantic fault stages rather than assertions on adapter callback internals. Lease/FIFO mechanics remain covered by `packages/agent/test/delivery-inbox.test.ts`; existing wire-level RPC tests do not substitute for the pending retained-direct retry case.

#205 must run the completed coding-agent conformance suite after removing the temporary adapters. Its test driver may change with the adapter, but the observable assertions may not weaken.

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
