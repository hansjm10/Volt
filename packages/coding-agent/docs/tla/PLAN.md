# Volt formal specification — full modeling plan

This is the deeper reference behind [`README.md`](README.md): the complete module
decomposition, the per-module invariant/property catalogs for the modules still to
be written, and the shared abstraction strategy. Predicates are written in
near-TLA prose; each ties back to a named prose invariant (I1…I7) or a §4.8 race
row from the RFC.

> Plain-first: every module below starts from one question a user would
> recognize ("did my phone reconnect to the right chat?", "why did two things run
> at once?"). The formal invariants are just those questions written precisely
> enough for a checker.

---

## 1. Module decomposition

Each module is its own `.tla` + `.cfg`. Shared datatypes (node ids, keys, close
reasons, handshake selections) will live in a `Common.tla` the others `EXTENDS`.
Build highest-value-first; `LeaseBroker` is the spine and everything else refers
to its states and the close reasons it mints.

| # | Module | Plain question it answers | Key state | Bug classes |
|---|--------|---------------------------|-----------|-------------|
| 1 | **`LeaseBroker`** | Who's doing the work for this chat, and how does it hand off? | lease state, owner, streamCount, relays, drain, `runtimeEntry`, pendingAttaches | split-brain runtime (I1), runtime/state coherence (I2), stuck hand-off (I5), lost turn (I6), rekey orphan (I7), relays-only-in-tui (I3), grant never settled (I4). **Written — see README.** |
| 2 | **`RelayViewer`** | While handing off, does the relay token stay single-use and does "watch the turn finish" ever leak or wedge? | relay `{Pending,Active,Invalidated,Settled}` + `used`/`expiresAt`; feed `{Buffering,Truncated,Live,Ended}` + `subscribed`/`seq`/`connId` | lost turn (event after end; silent-cancel emits nothing), token replay/expiry, double-settle, viewer feed leaking to a non-owner, stuck drain. |
| 3 | **`SessionTarget`** | On connect, does the phone pin the *right* session — never a stale one? | `target ∈ {last_noId,last_withId,new,session}`; `hostSession ∈ {exists,missing,liveMoved}`; wire `selection`; `requestedId?`; client `{Validated,StreamOpened,PinCommitted,RolledBack}` | ghost pin (pinned to requested vs canonical id), rekey without requestedId, requestedId leaking onto created/resumed, `target=session` silently creating a session, producer/validator tuple mismatch. |
| 4 | **`ClientAuth`** | Can a revoked or stale phone ever get back in? Is a one-time secret really one-time? | `clients`; `revoked[node]`; `pending[secretHash]`; `tomb ∈ {consumed(node),expired}`; logical `clock`; per-hello workspace authz | revoked-client re-entry, one-time secret replayed to a *different* node, expired-secret pairing, workspace-authz cached-at-pairing, check-order regressions. |
| 5 | **`ClientConn`** | Does the phone reconnect exactly once, never when the user said disconnect, and never confuse abort with detach? | app status; `userRequestedDisconnect`; background flag; per-pin status lattice; closure ledger; monotonic `operationToken`/`reconnectGen`/`attemptId` | ghost reconnect while user-disconnected, double reconnect loop, expected-closure marker mis-consume, abort-conflated-with-detach, stale continuation commit. |

**Build order.** `LeaseBroker` → `RelayViewer` (shares the connection-drop
trigger; compose the two once each is green solo) → `SessionTarget` → `ClientAuth`
→ `ClientConn` (largest state space; consumes close reasons from 1–3 as an
abstract input alphabet).

---

## 2. `LeaseBroker` (written)

Full detail is in [`README.md`](README.md#the-leasebroker-module) and the header
comment of `LeaseBroker.tla`. Summary of what it checks:

- **Safety:** `OwnershipUnique` (I1), `RuntimeIffDaemon` (I2), `TuiOwnerWellFormed`
  (I3a), `DisposePendingOnlyTui`, `RelaysOnlyWhenTui` (I3b), `DrainHasAcquirer`
  (I4), `StreamingCoherent`, `DrainNoNewTurn` (I6), and the off-by-default
  `NoStreamLeak` bug detector.
- **Liveness:** `DrainConverges` (I5), `EventualSettle` (I4), under per-key weak
  fairness on the drain pump.
- **Key modeling move:** `runtimeEntry` is an independent variable and the
  idle-acquire disposal is a two-step `flip → disposeDone/disposeFail`, so the
  flip-before-dispose split-brain window is a reachable state (otherwise I1/I2 are
  vacuous). This is the fix the review forced on the first draft.

---

## 3. Invariant & property catalogs — planned modules

Unless noted, assume **weak fairness (WF)** on the daemon's internal steps (drain
runner, disposal, ack handlers) and on "the environment eventually satisfies the
network / eventually idles"; revocation and user-disconnect are adversarial (no
fairness — they are choices, not obligations).

### 3.2 `RelayViewer` — written + verified green

Implemented in `RelayViewer.tla` (207,025 states). The prose below is the design
intent; the shipped module realizes it with `FeedOwnerSet`, `BufferCoherent`,
`RelayUsedCoherent` (safety) and `NoEmitAfterEnd`, `EndedIsTerminal`,
`SeqMonotone`, `RelayNoResurrect`, `FeedConverges`, `RelaySettleConverges`
(temporal). The daemon-side relay byte pump and the drain trigger are abstracted;
composition with `LeaseBroker` is future work.

**Safety**

- `RelayTokenRedeemableAtMostOnce` — `admit` succeeds ≤ once per relayId; the
  shared `used` bit is flipped by both `admit` and `invalidatePending`, so a
  rekey-invalidate and a concurrent admit cannot both win.
- `RelayTokenExpiryEnforced` — `admit` rejects `now > expiresAt` at redeem time.
- `AdmitAtomicityUnderReject` — a failing `admit` mutates neither `pending` nor `active`.
- `RelaySettleExactlyOnce` — `finish()` settles and deletes exactly once; daemon
  `closeReason` takes precedence over a socket-derived reason.
- `NoViewerEventAfterViewerEnd` — once a feed ended, no `viewer_event` is emitted.
- `ViewerFeedToRequesterOnly` — emit/subscribe/abort check `feed.connId`; the
  draining transcript never leaks to another connection.
- `ViewerBufferBounded` — the pre-subscribe buffer is capped; overflow yields
  exactly one `truncated` marker and no partial transcript.
- `SilentCancelEmitsNothing` (§4.8 row 2) — if the requester drops between
  `lease_pending` and `drain_end`, the grant rejects internally and **no** wire
  frame is sent (distinct from granted/error which do emit). Getting "nothing is
  sent" wrong is the likely wedge.

**Liveness** — `PendingOfferResolves`, `ActiveRelaySettles`, `ViewerFeedEnds`
(every started feed reaches granted/cancelled/error; `unsubscribe` doesn't strand it).

### 3.3 `SessionTarget` — written + verified green

Implemented in `SessionTarget.tla` (28 states). Models the daemon producer
(`session-target.ts` + rekey overlay) and the phone validator as a
resolve → validate → commit/reject pipeline, checking `NoGhostSession`,
`CanonicalPinOnly`, `ProducerSubsetOfValidator` (the compatibility proof),
`RekeyWellFormed`, `SessionResumedMatches`, `RequestedOnlyForRekey`, and
`HandshakeTerminates`. The prose below is the original design intent.

**Safety**

- `CanonicalPinOnly` — the app commits a pin only against the canonical
  `metadata.sessionId`, never `requestedSessionId`. The strongest one: TLC must be
  unable to reach a `PinCommitted` whose id = the requested id on a rekey.
- `RequestedIdImpliesRekey` — `requestedSessionId` on the wire ⇔ `selection =
  session_rekeyed` ⇔ `target = session`; no created/resumed carries a requested id.
- `SessionTargetNoCreate` — `target=session ∧ hostSession=missing ⇒
  session_unavailable`, never `created_after_missing`.
- `NewTargetCreatedOnly` — `target=new ⇒ selection=created`.
- `ProducerSubsetOfValidator` (refinement) — the `(target, selection, requestedId)`
  tuples the host emits are a subset of what the Swift validator accepts. A genuine
  cross-language compatibility proof no test gives us.

**Liveness** — `HandshakeTerminates` (every valid target reaches exactly one of
`PinCommitted` / `RolledBack`; no partial pin persists), `RekeySurfacesToClient`.

### 3.4 `ClientAuth` — written + verified green

Implemented in `ClientAuth.tla` (9,678 states). Models the host authorization
decision (`authorization.ts`) evolving through pair / revoke / approve-re-pair /
expire-secret and a clock that moves backwards, checking `NoIllegitimatePairing`
(covers revoked re-entry, one-time-secret replay by another node, expired-secret
pairing, and the fail-closed backwards-clock case) and `WorkspacePerRequest`. The
prose below is the original design intent.

**Safety**

- `AuthoritativeIdentityIsNodeId` — all keying uses the transport `remoteNodeId`;
  `hello.clientNodeId` is never consulted.
- `RevokedNeedsApprovedRePair` — a revoked node is rejected unless re-pair approval
  is active (0 ≤ now−approvedAt ≤ 30min, **fail-closed on negative**) *and* a live,
  non-consumed, non-expired secret. A generic new ticket alone never re-admits.
- `ConsumedSecretBindsOneNode` — a `consumed(node)` tombstone rejects any *other*
  node presenting the same secret hash.
- `ExpiredSecretNeverPairs` — expiry dominates in check order; re-pair approval
  can't rescue an expired secret.
- `WorkspaceAuthzPerRequest` — even a paired client is authz-checked against
  *current* host state every handshake, never cached at pairing.
- `CheckOrderPreserved` — outcomes match the load-bearing order (revoked → expired
  → workspace_unregistered → workspace_missing/workspace_unavailable → workspace_authorization_removed
  → consumed → client_unknown).
- `RetiredOutcomesUnreachable` — the authorization-state model cannot produce
  `conversation_in_use` or `workspace_forbidden`; runtime attach may separately
  emit `conversation_in_use` for incompatible client tool grants.

**Adversarial-clock note.** Model the logical clock as able to move **backward**
and assert `RevokedNeedsApprovedRePair` still holds — a future-dated approval must
fail closed. **Liveness** — `PendingTicketResolves`, `TombstonesReclaimed`.

### 3.5 `ClientConn` — written + verified green

Implemented in `ClientConn.tla` (176 states). Models the phone reconnect loop and
network-path handling, checking `SingleReconnectDial` (the anti-double-loop race:
a network blip during a dial never spawns a second concurrent dial),
`UserDiscSuppresses`, `TerminalAbsorbing`, and `AbortKeepsLive`. The generation
guards, snapshots, and backoff timing are abstracted; the prose below is the fuller
design intent.

**Safety**

- `UserDisconnectSuppressesAutoReconnect` — while `userRequestedDisconnect`, no
  automatic reconnect runs; the flag clears only on an explicit user connect. Holds
  across app-active, network-flap, and background-return.
- `AbortKeepsStreamOpen` — a successful abort does not close the stream, arm a
  closure marker, schedule reconnect, or reselect. Abort and detach are disjoint.
- `ExpectedClosureNeverReportsDisconnect` — an EOF whose `(ws,sid)` marker is in
  the ledger is consumed exactly once and never reports a disconnect or schedules
  reconnect. Only `lease_transferred` / `session_rekeyed_reconnect` (+ terminal
  revoke/workspace-removal) arm markers.
- `SingleReconnectLoop` — ≤ one live reconnect loop (generation guard);
  `networkPathStatusDidChange` never clobbers an in-flight dial.
- `StaleContinuationBails` — any await-resumption whose captured
  `operationToken`/`reconnectGen`/`attemptId` no longer matches is a no-op.
- `TerminalIsAbsorbing` — nothing auto-escapes a terminal `Failed` state.

**Suspected bugs to try to break:** closure-marker key collision (ledger keyed by
`ws` vs `(ws,sid)`); double reconnect across `networkPathStatusDidChange` vs
`beginForegroundReconnect` when `status=.connecting`; `reconnectGen` orphaning.

**Liveness** — `ReconnectMakesProgress`, `LeaseHandoffSelfHeals` (a
`lease_transferred` on the selected agent re-establishes a live stream — ties back
to `LeaseBroker`/`RelayViewer` close reasons), `BoundedRetryLoops` (duplicate ≤5,
lease_draining ≤3 both terminate).
