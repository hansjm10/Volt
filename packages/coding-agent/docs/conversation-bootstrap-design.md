# RFC: Atomic Conversation Bootstrap and Ordered Subscription Ingress

- Status: Accepted; Phases 1–6, relay ownership consolidation, and the presentation/reconciliation invariants are implemented, regression-clean, and live re-accepted from current branch source; the proposed `PreparedConversationActivation` API in §5.7 remains an optional API-consolidation follow-up
- Date: 2026-07-17
- Workspaces: `Volt/packages/coding-agent` (host contract and feed), `volt-app` (client ingress and UI projection)
- Source branches at diagnosis: `Volt@7f3a873f` (`feat/stream-resync-rpc`), `volt-app@cbd0eb9` (`agent/stream-resync-recovery`)
- Breaking changes: intentional. Volt is pre-alpha with no compatibility obligation; the app and daemon move together.
- Supersedes: the resumable-event-stream proposal in §8 of `transcript-delta-catchup-design.md`. It does not supersede that document's persisted transcript/cache design.
- Amended by: [Workspace Authority Generations and Retirement](workspace-authority-lifecycle-design.md), which scopes conversation ownership to an exact workspace authority generation and defines authority-tightening retirement.

All paths are relative to `Volt/packages/coding-agent/` unless prefixed with `volt-app/`. Symbol names are the durable anchors; line numbers in investigation notes may drift.

---

## 1. Decision

Conversation attachment becomes a versioned **snapshot-and-tail subscription**.

The host owns one serialized `ConversationProjectionFeed` per live conversation. Opening a conversation stream creates a unique `subscriptionId` and atomically:

1. establishes one causal cut of the conversation,
2. captures a subscriber-sanitized snapshot at that cut,
3. registers the subscriber for events after that cut, and
4. enqueues `conversation_bootstrap` before any tail event.

The app owns one `ConversationIngress` per attached conversation transport. It is the only consumer of `VoltTransport.events()` for that transport's lifetime. It applies the bootstrap atomically, then accepts only a contiguous tail for the same subscription.

The ordering key is:

```text
(workspaceName, sessionId, subscriptionId, cursor)
```

The existing assistant projector position remains nested inside that ordered stream:

```text
(assistant epoch, assistant seq)
```

The outer cursor proves delivery and catch-up order. The inner assistant position proves assistant projection correctness.

`report_stream_discontinuity` becomes correlated checkpoint recovery. The host immediately emits the current authoritative subscriber-sanitized conversation checkpoint; it never waits for another model event.

This replaces both of the current initial-attachment reconciliation passes:

- selection preflight `get_state` + `get_transcript`, and
- post-commit `get_state` + `get_transcript` barriers.

Transcript history pagination remains an ordinary RPC after bootstrap. It is physically ordered with the stream but
does not consume a conversation cursor; request and response are correlated to the current `branchEpoch`, and only a
generation-scoped `nextBeforeEntryId` previously issued by the host is accepted.

---

## 2. Incident and Proven Root Cause

### 2.1 Live reproduction

The failure was reproduced against a source daemon and paired iOS simulator with a 1–1000 streamed response. The app was terminated during the run and relaunched three seconds later.

Daemon audit evidence proved the replacement attached while the conversation was still active:

```text
15:12:44.307Z  prompt persisted
15:12:51.735Z  replacement connection opened
15:12:51.746Z  stream-1 replaced by stream-9
15:12:51.747Z  replacement subscriber attached, active=true
15:13:25.321Z  conversation completed
```

The app's PID-filtered log showed two recovery episodes around post-commit replay:

```text
10:12:51.920  delta_position_gap
10:12:51.920  Requesting assistant stream resync snapshot
10:12:51.939  Post-commit catchup complete ... with 1 queued events
10:12:51.940  re-synchronized after 4 dropped frame(s)
10:12:51.940  delta_position_gap
10:12:51.940  Requesting assistant stream resync snapshot
10:12:52.062  re-synchronized after 4 dropped frame(s)
```

The host ended with gapless `1...1000`, `stopReason: "stop"`, and zero `stream-projection` diagnostics. The app also converged to the complete text. The defect was transient ordering at the client boundary, not corrupt host truth.

### 2.2 Current ordering inversion

The app currently reconstructs one ordered transport through event-type heuristics:

1. `VoltHostSessionManager.validateAgentSelectionStream` manually consumes `transport.events()` while waiting for `get_state` and `get_transcript` responses.
2. `AgentSelectionReplayPolicy` retains snapshot-bearing assistant frames but deliberately excludes compact deltas.
3. `VoltSession.startWorkspaceEventTaskIfNeeded` opens a second consumer after selection commits.
4. `VoltSession.shouldDeferPostCommitEvent` continues withholding snapshots until both post-commit barriers are ready, but allows compact deltas through after only the state barrier.
5. A compact delta reaches an idle/desynchronized decoder and opens recovery episode 1.
6. Catch-up later replays its delayed snapshot. Snapshot adoption unconditionally resets `(epoch, lastSeq)`, ends the episode, and clears the resync-request gate.
7. Compact deltas that originally followed that snapshot have already been dropped. The next live delta is therefore ahead of the replayed snapshot and opens recovery episode 2.

This is not two concurrent resync requests in one episode. It is two real decoder episodes separated by a delayed checkpoint that was replayed out of its original causal position.

### 2.3 Host behavior was correct

Each current RPC stream creates a fresh `StreamProjector` in `needs_snapshot`. Its first observed assistant update is a full snapshot. Iroh writes are serialized. `discontinuity()` marks that projector for a snapshot and the next assistant update emits it before later deltas. There were no producer diagnostics.

Stream replacement briefly creates two runtime subscriber records, but the old and new projectors write different QUIC streams. A terminated app cannot receive old-stream frames. That overlap is lifecycle bookkeeping, not the cause.

### 2.4 Post-implementation live acceptance findings

The snapshot-and-tail implementation was then exercised end to end against the source daemon and paired simulator.
The normal-path protocol goals held:

- plain streamed text and a tool-call turn matched persisted host truth;
- a 1–1000 response was terminated and reattached while audit timestamps proved the run was still active;
- the reattached tail visibly advanced, converged gaplessly, and emitted no normal-path discontinuity request;
- abort preserved the canonical truncated assistant generation and a subsequent prompt streamed cleanly;
- every run had zero host `stream-projection` diagnostics and zero PID-filtered decoder gap diagnostics.

That run exposed three independent lifecycle/projection defects outside the cursor algorithm:

1. **A retired physical stream could pin daemon shutdown.** An RPC response was matched to its inbound command only
   when the ordered sink physically dequeued it. If replacement or shutdown retired the subscription while that
   response was still queued behind another write, the response disappeared without settling the
   `PendingIrohRemoteCommand`. Clean close waited forever for that command, the connection supervisor retained its
   child stream task, and `endpoint.close()` never completed. Subscriber/lease counts consequently accumulated across
   app relaunches.
2. **Canonical app updates could miss cache write-through.** Host events committed `conversationLiveStates`, then
   projected the selected state to observable properties while `isApplyingConversationProjection` was true. The
   `transcript.didSet` persistence hook correctly suppressed the intermediate UI write but no canonical commit hook
   re-armed persistence. The UI was current while disk remained at the earlier user row until a lifecycle flush.
3. **Final presentation normalized exact host content.** The canonical assistant generation matched host bytes, but
   `projectAssistantGeneration` trimmed leading and trailing whitespace when producing a final transcript row. An
   aborted prefix ending in `"697\n"` therefore rendered and cached as `"697"`, violating exact host parity even
   though transport and decoder state were correct.

These are not reasons to weaken cursor or assistant-position validation. They add the lifecycle, persistence, and
presentation invariants below.

### 2.5 Final current-source live re-acceptance

The completed implementation was re-accepted on 2026-07-17/18 using `Volt@feat/stream-resync-rpc`,
`volt-app@agent/stream-resync-recovery`, a daemon launched from source, and the paired camera-free simulator. The
selected conversation was `019f72f5-194e-7f43-b743-a27a17f920ce`. Plain text rendered as the exact persisted
newline-delimited `1...30`. The tool-call turn rendered one completed read card, reconciled the optimistic absolute-path
prompt to the host-sanitized row by `clientMessageId`, and returned exactly `SECOND-LINE-STREAM-RESYNC-OK`.

The final, tightly timed mid-run attach used app PID `31010`. The decisive evidence was:

```text
05:15:51.516Z  1–1000 prompt persisted
05:15:54Z      simulator termination requested
05:16:01.655Z  replacement subscriber attached, active=true
05:16:04Z      screenshot tail 293
05:16:08Z      screenshot tail 404
05:16:29.664Z  assistant persisted, stopReason=stop
05:16:29.669Z  conversation completion notification
```

The two screenshot files were created four seconds apart and visibly showed the reattached tail advance from 293 to
404 while the run remained active. At completion, the host JSONL, app canonical cache, and expected newline-delimited
`1...1000` were the same 3,892 bytes with SHA-256
`8e2cdcf9a82739c1fb56744a4fa53896837c215fae9a26df868747f207db63ca`. Normal replacement emitted zero
`dropped or fenced`, resync-request, or re-synchronized diagnostics. That is the intended outcome of an atomic
bootstrap, so the old acceptance expectation of one recovery episode no longer applies.

Abort persisted a gapless `1...284` prefix with `stopReason: "aborted"`; the app displayed the byte-identical prefix and
exactly one derived `Run stopped` marker, with no transient assistant-error row. A subsequent
`FINAL-AFTER-ABORT-OK` turn completed with `stopReason: "stop"` and no diagnostics. Detached daemon restart then
stopped PID `27280` cleanly and started PID `29702`. Audit recorded the same requested and resumed session ID,
exactly one replacement subscriber, and one stream lease while app PID `28572` remained alive. The retained
transcript stayed canonical and `FINAL-AFTER-DAEMON-RESTART-OK` completed byte-identically with zero drop/resync
diagnostics. Every scenario also had zero host `stream-projection` diagnostics and no `set_c` row.

Current-tree verification completed with `npm run check`, 290 concentrated host tests, 185 XCTest cases plus 731
Swift Testing cases from the full package command, and 17 focused Xcode scheme tests. The host property oracle ran 75
attach cuts with seed `0x51a77ac`. The app scheme also built, installed, and ran in the simulator before the live
matrix.

The three earlier presentation/reconciliation findings are closed: the renderer now has an explicit soft-break
contract without rewriting canonical text, prompt reconciliation uses durable client identity rather than text, and
abort presentation is derived solely from persisted stop reason while transport errors remain typed notices outside
the transcript. Recovery-RPC behavior is intentionally validated by deterministic cursor-loss tests; a healthy atomic
attach should not manufacture a discontinuity merely to exercise recovery.

---

## 3. Goals and Non-Goals

### 3.1 Goals

| ID | Goal | Proof |
|---|---|---|
| G1 | A normal attach or reconnect never invokes resync merely because bootstrap/catch-up reordered valid frames. | Deterministic delayed-bootstrap test and live 1–1000 reattach show zero drops/resyncs. |
| G2 | State, recent transcript, active assistant, active tools/workflows, and lifecycle state come from one causal cut. | Atomic-cut host tests and snapshot fixture parity. |
| G3 | Exactly one client component consumes each conversation transport FIFO. | `ConversationIngress` ownership tests; no selection/workspace iterator handoff. |
| G4 | Old connection/task frames cannot mutate a replacement subscription. | Subscription-generation fencing tests. |
| G5 | A real cursor or assistant-position gap requests exactly one recovery checkpoint and resumes from exact host state. | Gap/resync tests, including model-idle recovery. |
| G6 | Recovery is immediate even when the model emits no later token or is blocked in a tool. | Host test with no post-request model event. |
| G7 | Bootstrap and recovery are bounded without silent frame loss. | Overflow/checkpoint compaction tests. |
| G8 | Text, thinking, tool-call arguments/cards, abort markers, final content, and stop reason remain identical to host truth. | Shared fixtures, app integration tests, and live runtime matrix. |
| G9 | Daemon restart creates a clean subscription generation while preserving conversation identity and transcript. | Restart integration and simulator test. |

### 3.2 Non-goals

- Durable recovery of an in-flight model turn after the runtime owner crashes.
- Replaying an unbounded event log from an arbitrary historical cursor.
- Adding durable or unbounded historical event replay.
- Relaxing assistant decoder validation.
- Preserving the existing preflight/post-commit wire sequence.
- Compatibility negotiation with older app or daemon versions.
- Sharing unsanitized projection state between clients.

---

## 4. Required Invariants

### I1. One host source

For one live conversation runtime, exactly one feed observes source events and maintains the canonical materialized conversation state. Subscribers do not independently reconstruct causal cuts from unrelated RPC responses.

### I2. Atomic subscription cut

Creating a subscription is one serialized operation:

```text
capture snapshot at source revision R
register subscription S for source revisions > R
enqueue bootstrap(S, cursor=0, snapshot(R))
enqueue projected tail for source revisions > R with cursors 1, 2, ...
```

No event after `R` may be emitted before the bootstrap. No event at or before `R` may be replayed as tail.

### I2b. Atomic recovery cut and cursor allocation

Recovery is also one no-`await` source transaction:

```text
capture current source revision C
discard every not-yet-handed-off ordinary frame at/before C
build the subscriber-sanitized checkpoint and post-C assistant projector state together
allocate checkpoint at nextAssignedCursor (never reuse an allocated cursor)
retain controls accepted before the cut in their existing physical FIFO order
append the checkpoint after those controls
accept only source revisions > C as later tail
```

At most one write may already be handed to the transport. Any retained controls accepted before the cut also remain
physically before the checkpoint; controls accepted after the synchronous append remain after it. No unsent ordinary
cursor frame may precede the authoritative cut. A checkpoint may jump over purged cursor values, but no cursor that
was allocated or handed to any downstream queue is reassigned to a different envelope.

The checkpoint uses the sink's single bounded pending-authority slot, not the normal pending lane. Therefore a full
normal lane of retained pre-cut controls and the one in-flight prepared record cannot prevent the cut from being
appended. The authority slot is only an accounting reservation: the checkpoint is still inserted into the same
physical FIFO after those controls. A prior pending authority cut occupies the only slot, so duplicate recovery is
coalesced and a distinct concurrent cut is rejected rather than creating another lane. Snapshot construction and final
preparation are synchronous but reentrant; if the subscriber closes, rotates subscription id, or changes branch epoch
during either operation, the request fails and no receipt is returned for the stale cut.

### I3. One client ingress owner

`ConversationIngress` opens `transport.events()` exactly once and remains its owner until close/replacement. RPC response matching is a service of that ingress; callers never open a temporary iterator.

### I4. Bootstrap before live

The client applies no conversation mutation before accepting a valid bootstrap for the current transport/subscription. Applying bootstrap atomically replaces the conversation projection and seeds the assistant decoder.

### I5. Contiguous live cursor

For an accepted subscription:

- ordinary tail event cursor must equal `lastAppliedCursor + 1`;
- cursor `<= lastAppliedCursor` is a duplicate and is ignored with bounded diagnostics;
- cursor `> lastAppliedCursor + 1` opens one desync episode and fences ordinary tail events until recovery;
- a valid correlated recovery checkpoint may advance directly to its cursor and re-establish the base;
- the next ordinary tail event must then be checkpoint cursor + 1.

The checkpoint must subsume every reducer domain numbered by the skipped cursor interval. An assistant-only
snapshot may never advance a cursor that also orders transcript, tool, workflow, queue, or lifecycle state.

### I6. Subscription replacement is atomic

Accepting a new `subscriptionId` invalidates all old-subscription state together:

- decoder,
- queued/gated frames,
- pending streaming-delta flush,
- pending transcript/live-state publication,
- outstanding resync request,
- old task/transport ownership.

For an in-place host rotation, unsent ordinary old-subscription tail is discarded, while controls already accepted by
the physical FIFO remain before the replacement bootstrap in order. The replacement bootstrap is appended as the
authority cut, and controls accepted afterward remain after it; obsolete generation-scoped controls are resolved and
omitted rather than reordered.

### I7. Snapshot authority is scoped

A snapshot is authoritative only when one of these is true:

1. it is the bootstrap for the current new subscription, or
2. it is a recovery checkpoint for the current subscription and matches the outstanding resync request.

An arbitrary delayed snapshot cannot rewind decoder position or clear a newer resync request.

### I8. Per-subscriber sanitization

The feed may retain canonical raw/materialized state internally, but every bootstrap, checkpoint, and tail frame is derived through the target subscriber's current authorization/sanitizer. Unsanitized wire snapshots are never cached or shared across subscribers.

### I9. No silent overflow

Every queue has explicit count and final encoded-byte limits. A host sink may own at most three bounded parts: a
normal pending lane of 512 envelopes/4 MiB, one pending authority record of at most 4 MiB, and one in-flight prepared
record of at most 4 MiB. The pending authority record is physically ordered in the same queue; there is no bypass or
unbounded emergency lane. Ordinary normal-lane overflow atomically retires that subscription and emits a fresh
`subscriptionId`, cursor-zero bootstrap with reason `overflow`; it does not grant an uncorrelated same-subscription
rewind. A non-droppable control that cannot fit the normal lane fails the stream closed. Client-local overflow requests
an ordinary correlated recovery checkpoint. Neither path drops a frame while pretending the cursor remained
contiguous.

### I10. Final host truth wins

`message_end`/abort and transcript commit converge to the exact host-persisted content, block types, and stop reason. UI coalescing may reduce publication frequency but cannot alter ingress/decoder position.

### I11. One physical outbound sink

After the handshake, every envelope for the stream—cursor-covered conversation state and out-of-domain control
traffic alike—uses one bootstrap-gated `ConversationStreamSink`. No active-stream registry, transcript observer,
workflow fanout, theme push, or RPC response may write directly to the transport. The sink prepares sanitization and
decoration exactly once, owns an immutable JSON copy plus its exact encoded byte count, and hands at most one write
promise to a transformation-free transport path at a time. Producer mutation after enqueue cannot change the wire
value or invalidate byte accounting.

### I12. Structured persisted truth

Checkpoint transcript items preserve assistant content parts in order, including text and thinking/redaction shape,
plus final `stopReason`. They also carry projection version, branch epoch, commit ordinal, and transcript head. A
branch rebase or projection-version mismatch replaces invalid cached pages rather than merging stale history.

The branch-latest assistant message is projected with complete text and thinking content whenever its cumulative
canonical content fits the live assistant budget (256 KiB UTF-8), on head transcript pages and on its own
head-commit `transcript_entry` frame. A client attaching after `message_end` therefore converges on the same full
text the live stream would have delivered. Older entries and over-budget entries keep the default 12,000-scalar
truncation with `truncated: true`; their tails are recoverable per entry through the `get_transcript_entry_text`
continuation RPC, which pages an entry's sanitized canonical text in 12,000-scalar chunks. The continuation
serves the text lane only: a truncated thinking part still sets the item-level `truncated` flag but its tail is
not recoverable through this RPC.

### I13. Atomic app selection and ownership rekey

The app stages a replacement transport and its bound `ConversationIngress`, receives and validates the complete
bootstrap, and builds the replacement projection before persisting or publishing selection. One
prepare/commit/rollback transaction reserves both identities and spans the transport pool, host-session manager,
workspace event task, and durable selected-session identity. Pre-commit failure leaves the old owner usable; failure
after old-owner invalidation terminally closes the staged ingress/transport and publishes neither half. A mandatory
termination finalizer settles the reservation and closes every losing task/transport on success, rollback,
cancellation, or thrown error.

### I14. End-to-end app receive backpressure

The ingress-owned retained backlog is bounded to 512 envelopes and 4 MiB. The transport-to-ingress mailbox is a
demand-driven rendezvous, not another queue: beyond that retained backlog, the pipeline may own exactly one encoded
record of at most 4 MiB as the pending or returned iterator handoff. The producer is acknowledged only when ingress
asks for its next record, so it cannot decode or retain a second record while the current handoff is being parsed,
enqueued, applied, or discarded. Exact JSONL bytes are measured at transport receipt and carried with the decoded
envelope; moving an envelope between transport, actor, and projection ownership cannot reset its accounting.

### I15. One physical conversation-stream lifecycle

Every accepted physical conversation stream has one idempotent lifecycle owner. It owns the feed subscription, RPC
command tracker, RPC task, active-stream registry entry, connection-supervisor child, and physical send/receive halves.
Replacement, access change, transport failure, and host shutdown all terminate this same owner exactly once.

An RPC response is claimed when its immutable prepared record is successfully admitted to the final ordered FIFO,
not when a later transport drain happens to dequeue it. Admission removes that response obligation from the set that
may delay clean stream close. A separate delivery receipt settles exactly once on every terminal path: successful
write, rejected admission, write failure, subscription retirement, cancellation, or physical-stream termination. A
runtime-owned prompt/completion notification may continue in a detached task after its client disconnects, but no dead
transport task or completion-notification waiter may pin the connection supervisor or daemon endpoint.

Daemon shutdown order is therefore:

```text
stop accepting -> drain busy runtimes -> terminate/fence physical stream lifecycles
-> dispose runtime feeds -> finalize connection supervisors -> close endpoint
```

A timeout may contain a broken dependency, but is not the correctness mechanism.

### I16. Cache persistence follows canonical conversation commits

`conversationLiveStates[(workspaceName, sessionId)]` is the app persistence source. Every canonical mutation that
changes persisted conversation fields schedules a write for that exact conversation key, regardless of whether it is
currently selected. UI projection is a derived publication and never owns cache durability.

Debouncing may coalesce multiple commits for one key, but it cannot capture selected UI properties that later point to
a different conversation. Invalidation cancels pending work for the invalidated host/conversation so a stale task
cannot resurrect deleted cache data.

### I17. Visible transcript content is byte-exact canonical content

For every visible assistant or thinking block:

```text
host-persisted block content == canonical assistant block content == transcript-row body == cached row body
```

Whitespace trimming is permitted only as a visibility/emptiness predicate. It never transforms the stored or rendered
body. This applies to normal finalization, abort, recovery checkpoints, cache round trips, and leading as well as
trailing Unicode whitespace.

### I18. One serialized conversation owner

Every daemon-owned `(workspaceName, sessionId)` has one lifecycle coordinator with an explicit admission state:

```text
accepting -> draining -> stopped
```

The coordinator serializes attach/reconnect, structural RPC mutations, session replacement, stream retirement, and
runtime disposal. An attach or replacement is a transaction: reserve the source and target identities, stage every
fallible runtime/feed change without publishing it, install the physical-stream lifecycle, publish the new generation,
then commit the registry/lease identity. Failure closes the staged stream/runtime and restores or terminally retires
the previous state; it never exposes a registry identity whose feed generation is still unpublished.

Closing admission is synchronous and monotonic. After the transition to `draining`, asynchronous handshakes must
recheck their captured admission epoch before any lease, registry, stream, or runtime ownership commit, and existing
streams must reject new turn-starting commands. The owner then drains the fixed set of already-admitted structural
operations and runtime turns, terminates every physical stream owner, awaits RPC/subscriber settlement, and only then
disposes the feed/runtime. Low-level runtime disposal is not a valid shortcut while the owner has registered streams,
subscribers, or admitted mutations.

Lease ownership is capability-scoped, never key-scoped. A provisional daemon attach receives an opaque owner
capability plus a one-shot commit token. Concurrent attaches to the same runtime share the candidate owner: the first
successful registry publication finalizes it, peer commits observe the same durable owner, and all-failed cohorts
restore the latest stable base state. The finalized capability is stored on the runtime entry and is required for
stream-count changes, detach/drain transitions, rekey, and disposal. A stale callback holding only an old key or owner
generation cannot mutate a replacement runtime that later occupies `(workspaceName, sessionId)`.

Physical response delivery is not conversation ownership. Successful synchronous admission of an immutable response
to the final ordered FIFO settles the RPC command's logical response obligation. Its physical delivery receipt remains
owned by the stream lifecycle and may be rejected on retirement without delaying ingress EOF, admitted runtime
operations, or conversation disposal.

Conversation ownership is scoped to `(workspaceName, workspaceGeneration, sessionId)`, not merely workspace name and
session ID. Workspace replacement, unregister, client access tightening, and revoke are authority-tightening
operations: they synchronously close generation admission and use the terminal retirement and TUI acknowledgement
barriers specified by [Workspace Authority Generations and Retirement](workspace-authority-lifecycle-design.md).
Unlike ordinary handoff, those operations abort old-authority work rather than draining it to completion.

### I19. Durable client-input idempotency

Every remote `prompt`, `steer`, and `follow_up` carries a client-minted `clientMessageId` that is independent of the
per-transport RPC request id. Before dispatch, the host appends a host-only receipt containing that identity, command,
and a SHA-256 digest of the exact semantic wire input. It then durably appends `started` immediately before the first
side effect. These records never enter model context, transcript projection, bootstrap, or tail delivery.
They also cannot materialize a selectable session: a WAL-only file remains available for explicit crash recovery by
path but is omitted from local, all-project, and remote session enumeration until canonical conversation content is
committed.

The same identity and digest joins the live admission or replays its durable outcome; reuse with a different command,
message, ordered image payload, or streaming behavior fails closed. A persisted canonical user message bearing the
identity proves completion. After reload, a receipt that never reached `started` may be claimed by the retry, while a
`started` receipt without a canonical user message or terminal state reports an explicit ambiguous outcome and is not
executed again. This is an honest at-most-once boundary around arbitrary model, extension, and tool side effects, not
a claim of distributed exactly-once execution.

### I20. Canonical transcript and derived presentation

Only host-persisted transcript entries may occupy the canonical conversation transcript or its cache. Optimistic user
rows reconcile solely by `clientMessageId`; host text replaces provisional text even when sanitization changes it.
Abort presentation is derived once from persisted assistant `stopReason: "aborted"`, including zero-token turns.
Connection, pairing, workspace-management, extension, transport, provider, and retry notices use typed ephemeral UI
state and never synthesize transcript rows. Markdown line preservation is a renderer policy applied to the unchanged
canonical body, never a whitespace rewrite. The client independently bounds ephemeral workflow presentation to 64
active workflow IDs, 24 completed rows, and 128 KiB total retained UTF-8. Invalid or over-limit workflow events leave
the current reducer state and applied cursor unchanged and request one correlated authoritative checkpoint; active
rows are never evicted to disguise protocol overflow.

---

## 5. Architecture

### 5.1 Host: `ConversationProjectionFeed`

The feed is eagerly owned by `AgentSessionRuntime`, before a prompt can run. It is not lazy, weak-map-only, owned by
a UI selection, or owned by a single transport write callback.

Responsibilities:

- consume source conversation events once;
- maintain a materialized snapshot containing session state, a recent transcript page, active assistant projection, active tools/workflows/compaction, queue/lifecycle state, and conversation identity;
- assign an internal source revision at a deterministic event boundary;
- create and replace subscriber records atomically;
- run subscriber-specific stream projection/sanitization;
- assign contiguous per-subscription delivery cursors after filtering/projection;
- enqueue bootstrap before tail;
- emit immediate correlated recovery checkpoints;
- compact subscriber backlog to a fresh checkpoint when bounded queues overflow;
- terminate/fence subscriptions when runtime ownership changes or ends.

The existing `StreamProjector` remains useful as the subscriber-specific assistant encoder. It cannot be the sole canonical feed because sanitization affects emitted accumulators and tool-state shippability. The feed retains canonical source state; each subscriber retains its policy-specific encoder state.

The feed must be available to daemon-owned Iroh streams and TUI-relayed streams because both can subscribe to the same `AgentSession` in their respective owner process.

### 5.2 Atomicity model

Node's single-threaded synchronous execution is sufficient if the entire cut is created without an `await`:

1. read current materialized source revision and snapshot,
2. install subscriber with `minimumSourceRevision = R + 1`,
3. enqueue/bootstrap cursor 0,
4. return control.

Serialization and transport writes may be asynchronous, but the subscriber owns one FIFO sink containing final
sanitized/decorated bytes. Tail events are enqueued behind bootstrap, never written through a separate path, and
only one transport write is in flight. Recovery prunes unsent ordinary tail before its checkpoint is enqueued.

Snapshot construction itself must be synchronous over already-materialized state. It must not await transcript I/O or issue `get_state`/`get_transcript` internally. The feed is updated as the source conversation commits events, and is seeded from persisted session state when a runtime starts.

### 5.3 App: `ConversationIngress`

`ConversationIngress` is a transport-scoped actor/state machine with no UI responsibilities.

Suggested states:

```swift
enum ConversationIngressPhase {
    case awaitingBootstrap(transportGeneration: UUID)
    case live(subscriptionID: String, lastCursor: Int)
    case awaitingRecovery(subscriptionID: String, lastCursor: Int, requestID: String)
    case closed
}
```

Responsibilities:

- own the sole transport event iterator;
- validate bootstrap identity and schema;
- match RPC responses for callers without surrendering FIFO ownership;
- validate `subscriptionId` and cursor before routing any envelope;
- atomically publish bootstrap/checkpoint state to the conversation store;
- feed assistant frames to `VoltStreamProjectionDecoder` only after outer ordering succeeds;
- coalesce UI text/thinking publication after decoding, never before ordering;
- request one recovery per desync episode;
- atomically replace/close on transport generation change;
- expose connection/bootstrap health to `VoltSession`/manager without duplicating projection state.

`VoltHostSessionManager` opens/creates an ingress immediately after the transport opens. Selection awaits the ingress's bootstrap result. `VoltSession` binds to that already-live conversation projection; it does not create a new event consumer or run another catch-up pass.

Background agent streams keep their own ingress and projection current. Selecting an already-attached agent is presentation/cache selection, not network stream ownership transfer.

### 5.4 Projection layering

Ingress processing order is fixed:

```text
transport FIFO
  -> transport generation fence
  -> subscriptionId/cursor gate
  -> bootstrap/recovery atomic adoption OR ordinary envelope routing
  -> assistant epoch/seq decoder (assistant frames only)
  -> conversation reducer
  -> UI delta coalescing/publication
```

No layer may replay an event around an earlier layer. In particular, transcript reconciliation and UI batching cannot call the decoder with frames held outside the cursor gate.

### 5.5 Physical lifecycle and canonical persistence

The ordered feed queue and the RPC command tracker meet at FIFO admission. Admission claims the response and returns a
separate lifecycle receipt (or equivalent exactly-once settlement handle) that is owned by the physical stream
lifecycle until the queued record writes or is retired. The feed never silently discards a control response: dropping
or rejecting a queued control settles its delivery receipt before the subscription is detached.

The daemon active-stream registry stores the stream lifecycle terminator, not a disconnected collection of a raw
writer and physical-close closure. Stream replacement and shutdown invoke that terminator before disposing the
runtime/feed that owns its sink. The stream task's finalizer remains idempotent and performs subscriber/lease cleanup
even when termination started elsewhere.

The direct, workspace, and relay paths now use stable lifecycle owners. `RelayRegistry` is only a lookup and
token-admission index. `mint()` creates one `RelayLifecycleOwner` in `offered`; redemption promotes that same object to
`active` and installs its byte pump without replacing or handing ownership to another object. Expiry, pending-offer
cancellation, socket/stream failure, coordinator or external close, and shutdown all converge on that owner's
idempotent close/finish path. Entering `closed` removes the owner from registry lookup synchronously, fencing token
admission before asynchronous terminal work.

`RelayLifecycleOwner.settled` is the single terminal relay receipt, and every repeated close returns that same promise.
An offered close awaits the deferred phone-handshake rejection plus terminal send/receive operations. For an active
owner, the first terminal signal synchronously fences lookup and captures both byte pumps. A graceful EOF drains every
admitted TUI-to-phone write before FIN; an abortive close resets/stops the Iroh halves. Both paths observe the retained
phone-to-TUI pump, terminal Iroh operations, and socket close before recording one `RelayOutcome`. `onSettled` then runs
exactly once, and only its completion resolves `settled`. The coordinator releases its registered relay transport from
this physical terminal receipt, so lease removal, `relay_closed` notification, audit, and transport-index cleanup
cannot race old relay I/O or be bypassed by choosing a different close origin.

On the app, an ingress reducer commit writes `ConversationLiveState` first, schedules persistence for that conversation
key, and only then publishes selected properties. The persistence snapshot is taken from canonical state at fire time.
This preserves background conversations and removes observable-property suppression from the durability contract.

### 5.6 Conversation lifecycle coordinator

`ConversationCoordinator` is the implemented stable authority for one logical conversation. The object survives
session-id rekeys and direct/relay transport changes. It owns the runtime lifecycle and generation, attach claims,
subscribers and detached-runtime retention, the durable daemon lease capability or TUI lease identity, and every
registered direct or relay transport owner. `ConversationCoordinatorRegistry` retains current and previous session-key
aliases to that same object until it is vacant; the integrated-runtime, active-stream, lease, and relay registries are
indexes or delegated records, not replacement conversation lifetime owners.

Attach publication captures a claim from the coordinator's current generation. Retirement wins terminal ownership
synchronously before its first await: it moves the runtime to `retiring`, increments the generation, invalidates all
attach claims, and cancels detached retention. `beginRuntimeRetirement()` is idempotent. Its `finalization` promise
covers only the runtime-specific finalizer; its `settled` promise is the sole terminal barrier and awaits all registered
transport closes plus that finalizer, then requires an exact capability-scoped broker release before registry aliases
can be released. A failed or mismatched broker release retains lease ownership and keeps the coordinator non-vacant
instead of silently clearing authority. Competing close failures are aggregated rather than permitting an early clean
settlement.

Session replacement and rekey retain this same coordinator and durable lease capability. Prepared replacement reserves
both source/target runtime keys and the lease rekey against a captured coordinator generation, revalidates ownership
after persistence awaits, commits the lease, then moves the coordinator aliases, runtime index, and every active stream
identity together. The reservation remains held until the feed commits its staged source rebind and transaction
finalization runs; rollback leaves the previous identity authoritative. A direct session rekey likewise mutates the
lease first and only then rekeys the same coordinator and all stream indexes.

Daemon shutdown first closes the service-wide admission epoch, then closes published direct streams and both offered and
active relays through their coordinators. After the fixed admitted-operation set drains, runtime retirement uses each
coordinator's terminal barrier before ownership is released. This keeps global admission, per-runtime structural
serialization, and stable conversation lifetime ownership distinct while preserving one terminal route.

### 5.7 Finish-state ownership consolidation

The implemented capability and generation checks are correctness boundaries, not compatibility shims. Their lifetime
authority is now the concrete `ConversationCoordinator` described in §5.6; it is not an illustrative future name.

The current attach implementation exposes generation-bound attach claims, the service admission lease, and provisional
daemon-lease commit tokens as separate internal capabilities. It does **not** yet expose a type named
`PreparedConversationActivation`. A future API consolidation may package the already-enforced preparation choreography
behind one object with exactly one terminal operation:

```text
reserve identities
  -> stage runtime/feed/subscription/physical owner
  -> publish activation atomically
  -> commit

any failure or cancellation
  -> rollback every staged resource
  -> never expose partial ownership
```

That wrapper remains maintainability follow-up, not an unimplemented ownership invariant or a Phase 6 acceptance
blocker. Today the same fail-closed behavior is provided by coordinator attach claims, expected generations, provisional
lease commit/rollback tokens, staged feed source rebind, and idempotent retirement. Any eventual wrapper must preserve
the current coordinator, lease capability, and terminal receipts rather than introducing another lifetime owner.
External persistence, audit, and worktree services should eventually accept an `AbortSignal` and/or
expected-generation CAS token: fencing their continuations prevents late runtime publication, but cannot physically
cancel an already-started backing-store write.

On the app, selection/reattach follows the equivalent atomicity contract; this does not imply a shared concrete
`PreparedConversationActivation` type:

```text
sole ConversationIngress
  -> buffer bootstrap and exact FIFO tail
  -> reduce bootstrap into one staged authoritative state
  -> persist selection metadata
  -> atomically publish manager + conversation + visible selection on MainActor
  -> release the buffered tail exactly once
```

The manager must not separately project the bootstrap into a mutable workspace session before the ingress reducer
applies it. A disk cache may render provisional pre-authority UI and restore local draft state, but cached transcript,
assistant generations, cursor state, and host lifecycle state are never merged after the host bootstrap becomes
authoritative. The transport mailbox is single-claim and fail-closed: a second iterator attempt throws instead of
superseding the active ingress. Test-only transport-identity seams are removed once all callers bind by ingress
identity.

`RelayRegistry` now follows the same ownership rule. The `RelayLifecycleOwner` created at offer mint remains the exact
owner promoted on redemption and the only expiry, error, external-close, and shutdown authority through terminal
settlement. The registry performs lookup and token admission only; it neither owns the active byte pump nor creates a
second owner at the offered-to-active handoff.

---

## 6. Wire Contract

Field names below are normative for implementation. The existing protocol is changed in place.

### 6.1 Delivery metadata

Every server-to-client **conversation projection** envelope carries:

```ts
interface ConversationDeliveryPosition {
    subscriptionId: string; // opaque UUID/string, unique per opened conversation stream
    cursor: number;         // safe integer, starts at 0 for bootstrap
}
```

Wire field:

```json
"delivery": {
  "subscriptionId": "91bb...",
  "cursor": 42
}
```

Rules:

- Cursor is contiguous over envelopes actually delivered to that subscriber, after filtering/projection.
- Bootstrap is cursor 0.
- The cursor domain is exactly the state consumed by the conversation reducer: transcript mutations, assistant
  projection, tool execution, workflows, queue state, and session/run lifecycle state.
- Correlated RPC responses, extension dialogs, host notices, notifications, live-activity updates, discovery, and
  other control-plane envelopes are outside this cursor domain and never mutate the conversation reducer.
- MCP server/status/auth/call events are ordered control envelopes without `delivery`; they never consume a
  conversation cursor.
- The host's canonical external lane is closed to exactly persisted transcript commits, workflow
  start/update/end, and workflow tool start/end. Unknown or malformed external events poison the generation before
  cursor allocation; canonical JSON ownership/size failure does the same. Subscriber-generated `projection` metadata
  is forbidden on raw canonical input. Adding a new reducer mutation requires an explicit protocol case on both host
  and app.
- Discovery and workspace-management streams do not use this contract.
- A new Iroh conversation stream always gets a new `subscriptionId`, including daemon restart or same-session reconnect.
- If cursor exhaustion is approached, the host creates a replacement subscription/bootstrap rather than wrapping.

### 6.2 Bootstrap envelope

`conversation_bootstrap` is the first RPC envelope after a successful conversation-stream handshake:

```jsonc
{
  "type": "conversation_bootstrap",
  "delivery": {
    "subscriptionId": "91bb...",
    "cursor": 0
  },
  "conversation": {
    "workspaceName": "scratch",
    "sessionId": "019f..."
  },
  "state": {
    // coherent RpcSessionState projection, including queued steering/follow-up
    // messages and active retry/compaction/tool state
  },
  "transcript": {
    "items": [],
    "hasMore": false,
    "nextBeforeEntryId": null,
    "projectionVersion": 3,
    "branchEpoch": "f3d9…",
    "head": { "entryId": "a1b2…", "ordinal": 87 }
  },
  "activeAssistant": {
    "stream": { "epoch": 3, "seq": 128 },
    "message": { "role": "assistant", "content": [] },
    "toolState": []
  },
  "activeWorkflows": [],
  "reason": "bootstrap"
}
```

`activeAssistant` is absent/null when no assistant message is active. The transcript page and live assistant must not duplicate the same finalized generation. The snapshot projection owns one explicit rule for the cut:

- finalized/persisted assistant generations at or before the cut appear in transcript;
- an in-flight assistant generation at the cut appears only in `activeAssistant`;
- tail events represent source mutations strictly after the cut.

The bootstrap contains everything needed to render and accept a prompt without an immediate `get_state` or `get_transcript` request.
`workspaceName` and `sessionId` are required bootstrap identity fields. Authenticated host metadata remains in the
handshake and is not duplicated in checkpoint state.

An assistant transcript item contains ordered structured parts and its terminal reason:

```jsonc
{
  "entryId": "a1b2…",
  "ordinal": 87,
  "role": "assistant",
  "createdAt": "2026-07-17T15:13:25.321Z",
  "text": "final answer",
  "truncated": false,
  "stopReason": "aborted",
  "parts": [
    { "type": "thinking", "text": "", "redacted": true },
    { "type": "text", "text": "final answer", "truncated": false }
  ]
}
```

`projectionVersion`, `branchEpoch`, item `ordinal`, and `head` use the retained transcript/cache contract. Access
tightening closes and replaces the physical stream; an in-place checkpoint cannot revoke bytes already in flight.
`head.ordinal` is a positive persisted commit ordinal; a missing/invalid ordinal is a fatal host invariant violation.

Transcript pagination requests carry the current bootstrap `branchEpoch`. A page response repeats that epoch. The
host accepts `beforeEntryId` only when it was emitted as a generation-scoped `nextBeforeEntryId`, retains at most
1,024 accepted cursors, and clears the table on branch/source rebase. A stale-epoch response is omitted from a newer
generation rather than merged into its transcript reducer.

### 6.3 Tail envelopes

Existing RPC event shapes remain, with `delivery` added. Example compact assistant update:

```json
{
  "type": "message_update",
  "delivery": {
    "subscriptionId": "91bb...",
    "cursor": 1
  },
  "stream": { "epoch": 3, "seq": 129 },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "next"
  }
}
```

The host assigns `delivery.cursor` after subscriber filtering. A source event that projects to no wire frame consumes no delivery cursor. If one source event produces multiple wire envelopes, each receives its own cursor in enqueue order.

### 6.4 Discontinuity command

Request:

```jsonc
{
  "id": "resync-uuid",
  "type": "report_stream_discontinuity",
  "sessionId": "019f...",
  "subscriptionId": "91bb...",
  "lastAppliedCursor": 40,
  "assistantPosition": { "epoch": 3, "seq": 125 },
  "reason": "cursor_gap" // or assistant_position_gap / reducer_divergence
}
```

The host validates that the command targets the current stream subscription. A mismatched subscription is rejected and cannot alter projector/feed state.

### 6.5 Recovery checkpoint

The feed immediately enqueues a full conversation checkpoint through the same subscriber FIFO. It is the same
schema and snapshot builder used for initial bootstrap, not an assistant-only recovery record:

```jsonc
{
  "type": "conversation_bootstrap",
  "delivery": {
    "subscriptionId": "91bb...",
    "cursor": 47
  },
  "conversation": { "workspaceName": "scratch", "sessionId": "019f..." },
  "state": { /* coherent current state */ },
  "transcript": { /* coherent recent page */ },
  "activeAssistant": { /* current snapshot and assistant stream position */ },
  "activeWorkflows": [],
  "reason": "resync",
  "requestId": "resync-uuid"
}
```

The checkpoint may advance from the client's last applied cursor directly to 47 because it is authoritative and correlated. The client ignores/fences ordinary cursors 41–46 while awaiting it. After adoption, the next ordinary envelope must be cursor 48.

That cursor jump is legal only because `state`, `transcript`, `activeAssistant`, and `activeWorkflows` collectively
replace every conversation-reducer domain covered by cursors 41–46. Adding a new cursor-covered event requires
adding its materialized state to this checkpoint schema in the same change.

The normal command success response may follow, but it does not clear recovery state. Only the correlated checkpoint does.

If no assistant is active, the checkpoint carries `activeAssistant: null`; that still closes the recovery episode and establishes authoritative idle state.

### 6.6 Abort, finalization, and next prompt

- `message_end` remains a full authoritative assistant boundary inside the ordered tail.
- Abort content and `stopReason: "aborted"` must be represented in the checkpoint if abort occurs at/before its cut, or in the tail if after it.
- `agent_end`/`agent_settled` remain ordered tail events and cannot overtake `message_end`.
- A new prompt after abort starts a new assistant epoch within the same subscription; reconnect may instead create a new subscription and seed that state through bootstrap.

### 6.7 Daemon restart

Daemon restart creates a new runtime/feed and a new subscription. The app accepts a lower assistant epoch only as part of the new subscription bootstrap. Old-subscription frames, flush tasks, and resync completions are fenced.

---

## 7. State and Ownership Changes

### 7.1 Host ownership map

Target symbols/files:

- new `src/core/rpc/conversation-projection-feed.ts`
  - canonical materialized state,
  - atomic subscribe/bootstrap,
  - subscriber delivery cursor/queue,
  - immediate checkpoint recovery.
- `src/modes/rpc/rpc-mode.ts`
  - bind a conversation stream to the session-owned feed,
  - remove per-stream independent causal bootstrap,
  - route all subscriber output through feed ordering,
  - route discontinuity commands to subscriber checkpoint recovery.
- `src/modes/rpc/iroh-remote-rpc-mode.ts`
  - supply subscriber sanitizer/access policy,
  - ensure bootstrap is first post-handshake conversation envelope.
- `src/core/rpc/types.ts` and validation/dispatcher files
  - delivery position,
  - bootstrap/checkpoint envelope,
  - discontinuity request fields.
- daemon/TUI runtime construction
  - feed lifetime equals runtime/session lifetime, not phone stream lifetime;
  - a multi-listener session-replacement broker rotates every subscriber before new-session tail;
  - branch navigation/history rebase also rotates the subscription.
- daemon active-stream and push writers
  - replace raw post-handshake transport writes with the one bootstrap-gated sink;
  - remove pre-bootstrap workflow replay and include active workflow state in bootstrap.

The feed is stored directly on the runtime host, eagerly constructed and synchronously rebound/disposed with it.

### 7.2 App ownership map

Target symbols/files:

- `volt-app/Packages/VoltClient/Sources/VoltClient/Transport/ConversationIngress.swift`
  - sole event pump,
  - response continuation table,
  - bootstrap/cursor/recovery state machine,
  - transport replacement.
- `VoltClient/RPC/VoltRPC.swift`
  - delivery/bootstrap mappings and discontinuity fields.
- `VoltHostSessionManager+AgentSelection.swift`
  - await ingress bootstrap instead of opening an iterator and issuing preflight state/transcript commands.
- `VoltSession+WorkspaceEventStreams.swift`
  - bind to ingress projection/output; stop opening a second `events()` stream.
- `VoltSession+PostCommitCatchup.swift`
  - remove initial attach state/transcript barrier and assistant replay path.
- `AgentSelectionReplayPolicy.swift`
  - delete after all callers/tests migrate.
- `VoltSession+EventRouting.swift`
  - outer cursor gate precedes assistant decoder;
  - resync fence clears only for correlated checkpoint.
- `VoltStreamProjectionDecoder.swift`
  - remain strict for assistant epoch/seq;
  - expose/reset state only through ingress subscription lifecycle.
- `VoltSession+StreamingDeltaCoalescing.swift`
  - key scheduled flushes by subscription generation and cancel them atomically on replacement.

### 7.3 Selection model

Selection no longer owns network catch-up:

- Opening a new agent stages transport + ingress, awaits and validates the full bootstrap, and binds the staged
  projection without persisting or publishing selection.
- One prepared ownership rekey then commits the pool, manager, workspace event task, durable selected identity, and
  `VoltWorkspaceSession` projection together; rollback retains the old selection.
- Every selection attempt has a mandatory termination finalizer that closes the losing ingress/transport and settles
  the prepared rekey on success, cancellation, or failure.
- Selecting a background agent already attached to an ingress selects its cached live projection.
- Closing/replacing an ingress is a transport lifecycle operation, not a UI selection side effect.

---

## 8. Bounds, Backpressure, and Failure Semantics

### 8.1 Host subscriber queue

Each subscriber sink has this exhaustive ownership contract:

| Part | Bound | Purpose |
|---|---:|---|
| Normal pending lane | 512 envelopes and 4 MiB aggregate | Ordinary cursor tail and accepted controls |
| Pending authority slot | Exactly one prepared record, at most 4 MiB | Bootstrap, checkpoint, replacement bootstrap, or terminal fence |
| In-flight slot | Exactly one prepared record, at most 4 MiB | The sole value already handed to transport |

The authority slot is physically inserted into the same FIFO as the normal lane. It cannot overtake retained controls,
and it is not an unbounded bypass. The in-flight record is no longer pending and is excluded from normal-lane count and
byte admission. Attaching-tail records consume the same normal-lane budget; they do not form a fourth queue. Thus the
maximum sink ownership is 512 normal pending records plus one pending authority record plus one in-flight record, with
each of the latter two independently bounded to 4 MiB: at most 514 records and 12 MiB of exact encoded data in total.
Feed/subscriber configuration may lower these limits for testing or deployment policy but may never raise them above
the normative maxima.

One materialized bootstrap or checkpoint must itself fit the 4 MiB record limit. The enclosing Iroh JSON line has a
separate 8 MiB transport ceiling; the smaller feed limit is normative for conversation projection so later transport
decoration cannot consume the safety margin. Final preparation, immutable JSON ownership, and exact JSONL byte
measurement occur before a value occupies any of the three parts.

On overflow:

1. stop enqueueing ordinary tail for that subscriber,
2. discard its unsent ordinary tail,
3. retire the old subscription id,
4. atomically project a fresh current bootstrap through the same current authorization,
5. retain already accepted controls in physical FIFO order and append the bootstrap after them with a new
   subscription id, cursor 0, and reason `overflow`,
6. continue with source events strictly after that replacement cut.

This is subscription replacement, not an uncorrelated rewind. Other subscribers are unaffected. Access-policy
tightening is stricter: purge queued bytes, close the physical stream, and require a new authenticated attach. If an
accepted control cannot fit the normal lane, the sink fails closed because neither checkpoint compaction nor authority
priority may discard or overtake that control.

### 8.2 Inbound conversation command limits

`prompt`, `steer`, and `follow_up` are rejected before dispatch when any of these exact limits is exceeded:

| Resource | Limit |
|---|---:|
| Message UTF-8 bytes | 512 KiB |
| Images per command | 8 |
| One image's encoded `data` UTF-8 bytes | 1 MiB |
| One image MIME type UTF-8 bytes | 256 bytes |
| Aggregate image MIME + encoded-data UTF-8 bytes | 1.5 MiB |
| Serialized `{ message, images }` JSON bytes | 2 MiB |
| `clientMessageId` | 256 UTF-8 bytes |
| Discontinuity request `id`, `sessionId`, or `subscriptionId` | 256 UTF-8 bytes each |
| Transcript pagination `branchEpoch` | 256 UTF-8 bytes |

The image limits count the encoded string accepted on the wire, not decoded pixels. Exceeding a limit produces an
ordinary invalid-command response; the command is never queued and cannot become session state.

### 8.3 Bootstrap component limits and truncation metadata

Every bootstrap/checkpoint builder enforces these exact component limits before the final 4 MiB envelope check:

| Component | Limit |
|---|---:|
| Recent transcript page | 2 MiB serialized JSON |
| `RpcSessionState` | 768 KiB serialized JSON |
| Session model record | 32 KiB, otherwise omitted |
| Steering queue / follow-up queue | 128 KiB and 128 entries each |
| One projected queued message | 16 KiB UTF-8 |
| Active session tools | 256 KiB and 128 entries |
| One active-tool `args` record | 12 KiB serialized JSON |
| One active-tool `details` record | 20 KiB serialized JSON |
| Active workflows | 384 KiB and 64 entries |
| One live or checkpoint workflow event | 32 KiB serialized JSON |
| Active tools for one workflow | 96 KiB and 128 entries |
| One workflow `args` or `details` record | 12 KiB serialized JSON |
| Active assistant | 384 KiB serialized JSON, lossless for delta-dependent state |
| Branch-latest assistant transcript item | complete text up to 256 KiB cumulative content, else 12,000-scalar truncation |
| One canonical transcript commit before subscriber projection | 4 MiB serialized JSON |
| Canonical active workflows | 64 workflows, 128 tools per workflow, 4 MiB aggregate |
| One canonical workflow event before subscriber projection | 256 KiB serialized JSON |
| Transcript source work per page/checkpoint | 800 entries + 256 tool-call lookback entries |

The four largest envelope components reserve explicit headroom: 2 MiB transcript + 768 KiB state + 384 KiB active
assistant + 384 KiB workflows = 3.5 MiB, leaving 512 KiB for delivery/conversation fields, projection metadata,
subscriber decoration, and framing.

Structured records are projected deterministically by source key order. Ordered collections retain their source
prefix and order. Tool/workflow identifiers are retained for every projected entry; collection metadata records
`totalCount`, `projectedCount`, `omittedCount`, serialized byte counts, and truncated item indexes. Omitted tails are
not traversed merely to enumerate their identifiers. State carries the top-level workflow collection metadata so the atomic envelope
describes all projection loss.

Every lossy wire projection carries `projection.truncated: true`, nullable `originalBytes`, and `projectedBytes`;
field and collection metadata identify what was shortened or omitted. `originalBytes` is `null` when computing the
exact source size would itself violate the bounded-work rule. This metadata is part of the protocol contract, not a
log-only diagnostic.

Assistant text, thinking, tool-call arguments, tool-call IDs, and `toolState.argsText` are the base for later compact
deltas. They are never truncated in a bootstrap. Non-delta metadata such as diagnostics may be omitted or bounded
with explicit projection metadata. If the remaining lossless active-assistant state exceeds 384 KiB, snapshot creation
fails before a cursor-bearing bootstrap is enqueued. The subscription is failed rather than claiming continuity from a
base the client did not receive.

Projection bounds apply to work as well as output. Record measurement stops at its budget; queue/tool/workflow
collections inspect only their retained prefix; transcript projection reverse-walks at most the bounded window and
performs one earlier-ancestor existence probe. Canonical workflow state is count- and byte-bounded before it can become
checkpoint input. Exceeding a canonical bound poisons that source generation and rejects later attaches/checkpoints
until an authoritative source or branch rebase establishes a new cut.

After component projection, the builder measures the complete bootstrap/checkpoint with its delivery metadata. The
feed's authoritative preparation then applies outbound decoration and sanitization once, owns the resulting JSON
value, and measures the final JSONL record including its trailing LF. The transport writes that prepared value without
repeating either transformation. The final decorated JSONL value must be at most 4 MiB. There is no fallback to the raw
oversized value. Projection/serialization failure is fatal for the current subscription, as is an oversized lossless
active assistant. These failures must never advance a cursor or permit later compact deltas to be applied to a partial
base.

### 8.4 App pre-bootstrap queue

The host contract puts bootstrap first, so the app should normally buffer nothing before it. If a malformed/buggy peer sends tail first, the app does not apply it. A small bounded diagnostic buffer may be retained for evidence, but recovery is stream replacement/protocol failure, not heuristic replay.

`ConversationIngress` retains at most 512 envelopes and 4 MiB of exact encoded bytes, including the delivery currently
owned by its handler. Ahead of it, the receive callback and handoff mailbox may own exactly one additional JSONL record
of at most 4 MiB. The mailbox suspends the sole producer until ingress requests the next iterator element; a QUIC read
containing many lines is kept raw and decoded one line at a time, so neither `AsyncStream`, actor messages, nor an eager
decoded-line array can become a hidden queue. Cancellation, consumer replacement, and terminal failure settle that
single handoff explicitly. There is never a second decoded record outside the ingress bound.

### 8.5 App recovery fence

While awaiting recovery:

- continue consuming the transport to avoid backpressure,
- route command responses that are safe to complete,
- fence conversation mutations,
- accept only the matching recovery checkpoint or a replacement subscription bootstrap,
- bound diagnostics and timeout/reconnect if recovery never arrives.

### 8.6 Protocol errors

Fatal for the current subscription:

- missing/invalid bootstrap identity,
- bootstrap not first,
- wrong workspace/session,
- cursor outside safe-integer range,
- tail from an unknown subscription,
- malformed authoritative snapshot,
- sanitizer/projection failure that prevents a valid checkpoint.

Recoverable through one checkpoint:

- delivery cursor gap,
- assistant epoch/seq gap,
- reducer projection divergence,
- local bounded queue overflow before publication.

### 8.7 Security

- Bootstrap and checkpoint use the same outbound sanitizer as tail frames.
- Access tightening or revocation terminally fences queued output, closes the physical stream, and requires a new
  authenticated attach. Only non-tightening projection recovery may use an in-place checkpoint.
- No host paths, raw tool arguments, thinking signatures, or restricted extension payloads may leak through materialized snapshot fields.
- Sanitizer parity tests compare bootstrap, checkpoint, and equivalent tail/final projections.

---

## 9. Implementation Plan

The phases are dependency-ordered and now serve as the implementation and acceptance record. Phases 1–6 are complete;
explicitly unchecked follow-up below is API consolidation rather than missing lifecycle ownership.

### Phase 1. Host feed and atomic bootstrap

- Add `ConversationProjectionFeed` and its materialized conversation snapshot.
- Add delivery metadata and bootstrap/checkpoint wire types.
- Create an atomic subscriber cut and make bootstrap the first post-handshake envelope.
- Preserve per-subscriber sanitizer/projector state.
- Add immediate checkpoint emission for discontinuity.
- Add host changeset fragment because product source changes.

Exit criteria:

- concurrent source update cannot overtake bootstrap;
- first delivered envelope is bootstrap cursor 0;
- tail cursors are contiguous;
- idle resync emits an immediate checkpoint;
- host typecheck/static checks and targeted tests pass.

### Phase 2. App single-owner `ConversationIngress`

- Add ingress state machine and one lifetime event iterator.
- Move RPC response correlation behind ingress.
- Decode/apply bootstrap atomically.
- Gate all tail by subscription/cursor before assistant decoding.
- Bind manager/session projections without creating another consumer.

Exit criteria:

- selecting/attaching creates only one `events()` consumer;
- delayed UI binding cannot lose or reorder ingress frames;
- old transport generation cannot mutate new state;
- app package tests pass.

### Phase 3. Attach/reconnect/resync on snapshot-plus-cursor

- Replace initial preflight/post-commit state/transcript fetches with bootstrap.
- Use correlated checkpoint recovery for cursor/assistant/reducer gaps.
- Generation-key and cancel pending UI flushes.
- Ensure daemon restart accepts new bootstrap and preserves conversation transcript.

Exit criteria:

- normal reattach generates zero discontinuity requests;
- real loss generates exactly one request and one matching checkpoint;
- recovery works without a subsequent model event.

### Phase 4. Delete selective replay and assistant gating

- Delete `AgentSelectionReplayPolicy`.
- Remove snapshot-only queues and `shouldDeferPostCommitEvent` assistant behavior.
- Remove obsolete post-commit selection reconciliation/retry code once no caller remains.
- Delete tests that encode compact-delta exclusion; replace them with ordered-lane invariants.

Exit criteria:

- no event classification attempts to reconstruct transport order;
- no initial attach code opens a temporary transport iterator;
- searches show no obsolete replay/gating symbols.

### Phase 5. Verification matrix

Add deterministic and property tests, then live verification:

1. concurrent bootstrap/update;
2. long streamed text with delayed client binding;
3. thinking and text block parity;
4. mid-tool-call bootstrap, argument deltas, tool card and execution lifecycle;
5. message end during bootstrap/recovery;
6. abort with exact truncated prefix/marker, then clean next prompt;
7. late frames from an old subscription;
8. duplicate, gap, and out-of-order delivery cursors;
9. genuine assistant epoch/seq gap;
10. immediate idle resync;
11. host/app queue overflow checkpoint compaction;
12. daemon restart with lower assistant epoch/new subscription;
13. sanitizer isolation/parity;
14. live simulator 1–1000 kill/relaunch with screenshots and host/app truth comparison.

Exit criteria are in §10.

### Phase 6. Post-acceptance lifecycle and persistence hardening

**Status: Implemented and accepted.**

- [x] Introduced one stable `ConversationCoordinator` per daemon-owned logical conversation, with
  generation-fenced attach claims and `prepared -> active -> retiring -> retired` runtime ownership.
- [x] Bound each physical Iroh conversation stream to one idempotent lifecycle owner.
- [x] Consolidated offered and active relay lifetime under one `RelayLifecycleOwner` and one terminal `settled` receipt.
- [x] Claimed ordered RPC responses at successful FIFO admission and settled every failure/retirement path.
- [x] Made session replacement a staged, expected-generation transaction whose registry reservation remains held
  through feed publication.
- [x] Made daemon lease publication a provisional cohort transaction that yields one durable owner capability; that
  capability is required for later lease mutations so same-key ABA callbacks are harmless.
- [x] Closed attach/turn admission before shutdown snapshots, drained the fixed admitted-operation set, and terminated
  stream lifecycles before runtime/feed disposal during replacement and daemon shutdown.
- [x] Moved transcript-cache scheduling to per-conversation canonical commits.
- [x] Preserved exact canonical block content in final transcript rows; trimming decides visibility only.
- [x] Added durable `clientMessageId` receipts and fail-closed at-most-once retry semantics for remote prompt, steer,
  and follow-up admission without projecting host-only WAL records.
- [x] Derived abort markers from persisted stop reason and moved all local informational/error presentation outside
  the canonical transcript and cache.
- [x] Added deterministic blocked-write retirement, concurrent structural replacement, shutdown-handshake
  interleaving, repeated replacement, relay settlement, cache write-through, and whitespace parity tests.

Follow-up API consolidation (not a Phase 6 completion blocker):

- [ ] Optionally introduce the `PreparedConversationActivation` wrapper described in §5.7. The current attach path
  already enforces its ownership invariants through coordinator claims, admission leases, provisional lease commit
  tokens, staged publication, and exact terminal receipts.

Exit criteria:

- a queued response retired before physical dequeue cannot hold a clean close open;
- simultaneous structural commands from co-attached streams publish exactly one complete runtime/feed generation at a
  time, and a failed staged generation never becomes registry-visible;
- a handshake or turn that crosses the shutdown admission cut cannot commit new conversation ownership;
- two concurrent provisional attaches either publish one shared durable lease owner or restore the latest stable base,
  and stale detach/stream-count/dispose/rekey callbacks cannot affect a same-key replacement;
- five terminate/relaunch cycles keep one live subscriber/stream and detach every superseded generation;
- an idle detached daemon restart completes without `SIGKILL` and the app reconnects with transcript intact;
- inbound assistant finalization reaches disk after the debounce without a lifecycle/manual flush;
- normal and aborted final rows retain leading/trailing whitespace byte-for-byte.

---

## 10. Test and Acceptance Contract

### 10.1 Host unit/property tests

Extend `test/stream-projection.test.ts` and add feed-specific tests.

Property oracle:

> For any valid source conversation event sequence and any subscription cut, applying bootstrap plus the delivered contiguous tail produces the same materialized projection as applying the full source prefix directly.

Randomize:

- cut position,
- text/thinking/tool block shapes,
- subscriber start timing,
- source updates during delayed bootstrap write,
- resync position,
- queue compaction point,
- abort/final boundary,
- sanitizer behavior.

Mandatory assertions:

- bootstrap always first;
- exact contiguous delivery cursor sequence;
- no pre-cut tail duplication;
- no post-cut loss;
- resync checkpoint is immediate and correlated;
- old subscription cannot affect replacement;
- final blocks and stop reason match source truth.
- the normal pending lane remains within 512 envelopes/4 MiB while one independently bounded authority record and one
  independently bounded in-flight record may coexist;
- a full retained-control lane remains physically before overflow, rebind, and recovery authority records;
- in-flight count/bytes do not spuriously reject an otherwise bounded normal enqueue or authority cut;
- synchronous snapshot/preparation failure or generation rotation returns no checkpoint receipt;
- malformed, non-owned, oversized, or outbound-decorated canonical external events poison before subscriber
  projection and cursor allocation.
- a control response queued behind a blocked physical write is claimed at FIFO admission and its command settles when
  subscription retirement rejects that queued record;
- natural peer EOF in that blocked-write state returns without an explicit lifecycle-retire call, proving clean close
  and subscription cleanup do not wait on each other cyclically;
- co-attached structural RPC commands serialize across physical streams and stale expected generations fail before
  mutating the runtime, feed, lease, or registry;
- shutdown closes admission before an asynchronously paused handshake/turn commit and waits for every operation admitted
  before the cut;
- provisional lease cohorts cover both-success, one-success, all-failed, shutdown/drain, rekey, and same-key ABA
  interleavings; every post-publication mutation proves the durable owner capability rather than merely matching a key;
- every attach failure after authorization runs the same idempotent stream-owner finalizer, including failures before
  handshake delivery and feed subscription;
- clean close, replacement, and host shutdown return with no retained feed subscriber, RPC task, active-stream entry,
  supervisor child, or connection task.

### 10.2 Shared contract fixtures

Extend the existing generated assistant-stream JSONL fixture path. Fixtures include delivery metadata and bootstrap/checkpoint records.

Required fixtures:

- mid-text bootstrap + tail,
- mid-thinking bootstrap + tail,
- mid-tool-call bootstrap with `toolState`,
- bootstrap immediately followed by final/abort,
- recovery with no later delta,
- old-subscription event after replacement,
- daemon-restart subscription with lower assistant epoch.

Host encoder and Swift decoder must consume the same fixtures.

### 10.3 App pure tests

Test `ConversationIngress` independently from SwiftUI:

- bootstrap validation and atomic apply,
- cursor duplicate/gap/out-of-order behavior,
- recovery correlation,
- state replacement on subscription change,
- late old-task frames,
- response matching while live/recovering,
- pending flush cancellation,
- bounded diagnostics/timeout,
- malformed/fatal bootstrap.

For each valid permutation, compare final `ConversationLiveState`, transcript, active generation, decoder state, and emitted commands with direct ordered application.

### 10.4 App manager/session integration tests

Use recording transports that can hold bootstrap or tail writes deterministically:

- manager opens one ingress and never a second iterator;
- bootstrap arrives while UI selection commit is delayed;
- tail advances while binding is delayed;
- tool/workflow events preserve order;
- message end/abort settles exactly once;
- reconnect replaces generation atomically;
- normal attach sends zero resync requests;
- one injected cursor gap sends exactly one request and only matching checkpoint clears it.
- an inbound final assistant commit reaches the cache, including assistant-generation metadata, after the debounce and
  without an explicit flush;
- selected and background conversation commits persist under their own `(workspaceName, sessionId)` keys;
- normal and aborted final transcript rows/cache round trips preserve leading and trailing whitespace exactly.

### 10.5 Static and targeted verification

Volt:

```bash
npm run check
node ../../node_modules/vitest/dist/cli.js --run test/<target>.test.ts
```

Run modified tests specifically as required by repository rules. Use `./test.sh` only when broader non-e2e coverage is warranted. Do not run the raw full Vitest suite.

volt-app:

- run affected Swift package tests through XcodeBuildMCP/SwiftPM workflow;
- build and run scheme `Volt` with the configured simulator;
- inspect PID-filtered unified logs.

### 10.6 Live acceptance

Run from branch source with the `volt-runtime` workflow:

1. check daemon leases and restart detached;
2. build/run the app via XcodeBuildMCP;
3. pair camera-free to a scratch workspace if needed;
4. send `Count from 1 to 1000, one number per line`;
5. terminate app about three seconds into the run;
6. relaunch about three seconds later;
7. prove audit attach timestamp precedes conversation completion;
8. capture two screenshots with visibly advancing tail;
9. verify host JSONL and app transcript are gapless 1–1000;
10. verify zero host projector diagnostics;
11. verify zero app drop/resync diagnostics for normal reattach.

Then inject one deterministic real discontinuity and verify exactly one request followed by one correlated checkpoint and clean continuation.

Finally restart the idle daemon detached while the app remains connected. The old daemon must stop without forced
termination, each superseded stream must detach, the replacement daemon must expose one live stream for the app, and a
fresh prompt must stream without drops while the prior transcript remains intact.

### 10.7 Completion definition

The work is complete only when all are true:

- design contract implemented on both branches;
- selective replay/gating deleted;
- host and app static checks pass;
- every modified/added targeted test passes;
- deterministic coverage includes every Phase 5 scenario;
- live 1–1000 reattach passes with zero normal-path recovery;
- real discontinuity recovers exactly once;
- final host and app content/block/stop-reason truth match;
- daemon restart completes without forced termination and repeated relaunch/replacement does not accumulate streams;
- canonical assistant commits are durable without relying on scene/lifecycle flush;
- visible and cached final row bodies preserve canonical whitespace byte-for-byte;
- no unrelated worktree changes were modified.

---

## 11. Rejected Alternatives

### 11.1 Clear the resync fence later

Rejected. It suppresses a duplicate request but leaves missing/reordered frames and an invalid decoder base.

### 11.2 Accept gaps or lower/stale snapshots in the decoder

Rejected. It weakens the component that correctly detected the ordering defect.

### 11.3 Queue only compact assistant deltas in post-commit catch-up

Rejected as the final design. A carefully bounded latest-snapshot-plus-contiguous-tail queue is a correct migration bridge, but it preserves two attachment phases and cannot prove transcript/state coverage without a shared cut.

### 11.4 Pause transport consumption

Rejected. Command responses and events share the FIFO; pausing creates head-of-line blocking and possible deadlock.

### 11.5 Add only connection/task generation fencing

Rejected as insufficient. Generation fencing rejects stale frames but cannot restore a skipped suffix or establish an authoritative base.

### 11.6 Add only a replay ring buffer

Rejected as the primary contract. A replay buffer can optimize short reconnects later, but it still needs an atomic snapshot/cursor fallback and does not solve initial causal-cut ambiguity by itself.

---

## 12. Context Recovery Checklist

If implementation context is compacted or transferred, restart from this checklist:

1. Read this document in full.
2. Confirm branches/heads and inspect both worktrees before editing.
3. Preserve the untracked `transcript-delta-catchup-design.md` unless its owner explicitly coordinates changes.
4. Re-read `Volt/AGENTS.md`, `volt-app/AGENTS.md`, and the `volt-runtime`/`xcodebuildmcp` skills.
5. Find current progress by searching for:
   - `ConversationProjectionFeed`,
   - `conversation_bootstrap`,
   - `ConversationIngress`,
   - `ConversationDeliveryPosition`,
   - `AgentSelectionReplayPolicy`,
   - `shouldDeferPostCommitEvent`.
6. Reconcile work against the phase exit criteria in §9 and completion definition in §10.7.
7. Never mark completion from tests alone; re-run the live acceptance in §10.6.
