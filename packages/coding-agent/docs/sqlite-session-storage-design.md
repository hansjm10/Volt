# RFC: SQLite Session Storage Ownership and Materialized Projections

- Status: Proposed; implementation blocked pending review
- Date: 2026-09-03
- Pull request: [#329](https://github.com/volt-hq/Volt/pull/329)
- Issue: [#328](https://github.com/volt-hq/Volt/issues/328)
- Package: `packages/coding-agent`
- Scope: repository design only; this RFC does not authorize implementation
- Amends: session-storage language and boundaries in the delivery, conversation-bootstrap, live-session, workspace-authority, worktree, and subagent RFCs listed in §5.1

Paths are relative to `packages/coding-agent/` unless stated otherwise. Symbol names are durable anchors; line numbers are intentionally omitted.

## 1. Decision summary

Keep the core storage choices already present in #329:

- one authoritative `sessions.sqlite` store per workspace or custom session directory;
- one shared worker-backed SQLite client per store within a process;
- stable `SessionReference` identity containing store, session, and immutable session-generation identity;
- optimistic session revisions, transaction commit identities, payload digests, and reconciliation after uncertain worker outcomes;
- current-format JSONL only as explicit import/export interchange;
- unchanged public `SessionManager.create`, `open`, `continueRecent`, `forkFrom`, `importFromJsonl`, list, search, and delete signatures.

Add four missing contracts in a later, separately approved implementation:

1. **Preparation ownership and durable adoption.** Every internally acquired manager carries a `SessionManagerPreparation` that records whether the manager was created, opened, or borrowed. Internally created candidates begin as durable `prepared` rows that normal list/find/open paths cannot resolve. One reconciliation-capable SQLite transaction marks the row `adopted` and commits contingent canonical setup before any external publication. Definitive pre-adoption failure discards only the exact preparation; opened managers are closed but never deleted; borrowed managers remain caller-owned after a proven no-effect failure. Published or uncertain candidates are never deleted.
2. **Incarnation-pinned host ownership.** Once a persisted session ID is resolved, every host-internal runtime, lease, worktree binding, last-session pointer, subagent edge, and delayed callback pins the exact store ID and session generation. ID-only remote requests mean “resolve the current incarnation,” not authority to mutate whichever incarnation later reuses the name.
3. **One materialized-projection reducer.** Session summaries and side indexes are deterministic derivatives of the canonical session row and ordered entry log. The same reducer drives incremental updates and full replay. Opening a session compares replayed state with persisted projections and fails closed on mismatch.
4. **An honest search bound.** Listing, exact lookup, continuation lookup, and remote enumeration do not read canonical entry payloads, but their cost includes returned materialized-summary bytes. Deep fuzzy and phrase search is parameterized by query size and extracted text; JavaScript regex has no general asymptotic guarantee. Search accumulates at most one session's searchable document plus query/normalization state in the worker. This RFC does not add FTS or change search semantics.

`SessionManagerPreparation` is not a new conversation, runtime, lease, delivery, or workspace owner. It is a short-lived compensation capability that exists only until an already-defined owner publishes or rejects a candidate manager.

## 2. Motivation

#329 changes more than a file format. It changes persistence latency, manager lifetime, session identity, runtime replacement, remote target creation, subagent startup, catalog projection, and deep search.

The current branch contains correct low-level mechanisms, including revision and generation fences, commit reconciliation, private store files, strict protocol validation, and worker reference counting. Repeated review findings instead cluster at boundaries where those mechanisms are composed:

- created managers require different cleanup from opened or caller-supplied managers;
- the publication cutoff differs between SDK return, runtime replacement, daemon registry activation, relay handoff, and subagent first-prompt publication;
- cleanup policy is inferred repeatedly from local booleans, session-selection values, or object identity;
- session summary and side-index state is updated by several independent mutable indexes;
- SQLite snapshot side tables are loaded but are not all checked against replayed canonical entries;
- deep search uses extracted text but not a content index, while current prose implies a stronger asymptotic guarantee.

Adding another local `try`/`catch` around each finding does not establish a durable contract. This RFC defines the contract before further source changes.

## 3. Scope

### 3.1 Goals

1. Define exactly who may close, discard, preserve, or transfer every manager acquired during a higher-level operation.
2. Define one irreversible adoption cutoff for each creation and replacement flow.
3. Prevent deletion of a session that may already be externally reachable.
4. Prevent caught pre-publication failures from retaining newly created hidden rows.
5. Preserve pre-existing sessions when setup, replacement, transport, or publication fails.
6. Make every persisted summary and side index reproducible from canonical session data.
7. Detect projection drift without making routine listing proportional to transcript size.
8. State search time and memory complexity accurately while preserving current query behavior.
9. Provide deterministic failure, concurrency, property, and benchmark acceptance criteria for a later implementation plan.

### 3.2 Non-goals

This RFC does not propose:

- replacing SQLite, the per-directory store layout, or the worker boundary;
- changing `SessionReference`, session-generation fencing, store identity, or revision reconciliation;
- changing public `SessionManager` signatures;
- adding a compatibility path or migrating pre-#329 live JSONL sessions;
- adding FTS, changing fuzzy matching, removing regex, or changing search result ranking;
- changing remote/mobile wire shapes or adding iOS work;
- replacing `AgentDeliveryOwner`, `AgentSessionRuntime`, `ConversationCoordinator`, `LeaseBroker`, `SubagentManager`, or the separately proposed `WorkspaceAuthorityCoordinator` ownership;
- distributed exactly-once guarantees across provider, tool, extension, audit, or control-plane side effects;
- age-based or generic automatic deletion of rows left by abrupt process termination; only the owner-proven exact remote retry reclaim in §4.6 is defined;
- changing the remote session-ID wire shape (host-internal durable bindings may gain store/generation identity);
- implementing any source, schema, test, user-documentation, or PR-description change under this RFC-writing scope.

### 3.3 Preserved public behavior

Unless a later implementation plan explicitly says otherwise:

- direct owners of a persisted `SessionManager` still await `closePersistence()`;
- a successfully returned `AgentSession` or `AgentSessionRuntime` owns its manager's eventual close;
- a caller-supplied manager remains usable when `createAgentSession()` proves that candidate setup had no canonical effect; a committed or uncertain contingent setup transaction retires that manager authority and requires reopen;
- adopted selector-hidden sessions remain available for durable client-input recovery and exact internal lookup;
- a session may be adopted while still selector-hidden;
- prepared rows are not ordinary selector-hidden sessions and cannot be resolved without their process-local preparation capability;
- JSONL import remains strict, current-version-only interchange;
- remote requests and responses remain session-ID based; session-store locators never cross remote-safe surfaces, while existing authorized relative/synthetic workspace and worktree path fields remain allowed.

## 4. Vocabulary and authoritative data

### 4.1 Manager acquisition origin

Every higher-level operation classifies its manager acquisition as exactly one of:

- **created**: the operation created the current session row or changed an operation-private manager to a newly created session identity. The row did not predate the operation and may be discarded before adoption.
- **opened**: the operation opened or continued a pre-existing row into a manager it owns temporarily. Failure closes this manager but never deletes the row.
- **borrowed**: the manager was supplied by the caller or is an already installed in-memory/current manager. Pre-adoption failure does not close or delete it.

`created_after_missing`, JSONL import, cross-store fork, and a new branched-session identity are `created`. Exact resume is `opened`. `continueRecent` must report whether it opened or created instead of forcing callers to infer that result.

### 4.2 Preparation state

An operation-local preparation has one monotonic state plus a monotonic rollback-request flag:

```text
prepared -> publishing -> adopted -> settled(transferred)
    |            |
    |            `-> settled(rolled_back)  // only proven not published
    `--------------> settled(rolled_back)
```

- **prepared**: no publication attempt is in flight and no irreversible publication is known to have occurred. Origin-specific compensation remains permitted.
- **publishing**: a typed publication attempt owns settlement. Cancellation may set `rollbackRequested`, but no cleanup may start until the attempt is joined and classified.
- **adopted**: the durable row and a terminal runtime owner are installed, or publication is uncertain. Deletion is permanently forbidden.
- **settled**: the preparation either completed origin-specific rollback or transferred responsibility to the installed owner. It performs no further cleanup.

The transition into `publishing` and the rollback-request flag update are synchronous. The existing lifecycle actor for the flow owns and joins the publication promise. A `not published` outcome permits rollback; `published` or `uncertain` moves to adopted even when rollback was requested. Shutdown joins the same promise. If bounded process shutdown ends before classification, the case is abrupt process loss: no delete is attempted.

### 4.3 Publication

For this RFC, **publication** means that another durable or live owner may resolve, route to, resume, or act on the candidate session identity. It is not the same as selector visibility.

Examples include:

- resolving `createAgentSession()` or `createAgentSessionRuntime()` to a caller;
- committing an `AgentSessionRuntime` source rebind;
- rekeying a daemon runtime/lease registry to the candidate session;
- handing a newly created target reference to a TUI relay owner;
- committing child runtime registration, parent spawn linkage, registry, or activity state for a subagent.

The SQLite `sessions.visible` column is a content-derived catalog projection. It is not a lifecycle or publication bit. Setup may make a prepared session visible, and a successfully adopted empty session may remain hidden.

### 4.4 Canonical session data

The authoritative persisted session consists of:

1. **Primary store identity** in `store_metadata`: immutable store ID, schema identity/version, and schema digest.
2. **Primary session identity/header fields** in `sessions`: session ID, immutable session generation, format version, cwd, creation time, parent reference, origin, durable prepared/adopted publication state, and the preparation ID/owner identity present only while prepared.
3. **Ordered canonical entries** in `entries`: entry ID, ordinal, parent, type, timestamp, host-only classification, and canonical payload.
4. **Session revision and transaction evidence**: revision ordering plus `transaction_commits` identity, digest, before/after revisions, and commit time.

The following are materialized projections, not independent truth:

- `sessions.updated_at`, starting Git context fields, `name`, `visible`, `leaf_entry_id`, `message_count`, and `first_message`;
- `labels`;
- `client_inputs`;
- `subagent_spawns`;
- `search_chunks`.

`transaction_commits` is evidence for transaction outcome reconciliation, not a materialized conversation projection.

### 4.5 Definitive and uncertain outcomes

A publication participant reports one of:

- **not published**: the participant and every earlier durable routing participant prove complete restoration. Prepared rollback is allowed.
- **published**: the durable adoption transaction or another ownership participant crossed its cutoff. The preparation adopts and deletion is forbidden.
- **uncertain**: any participant cannot prove that publication or a durable route did not occur. The preparation adopts conservatively and deletion is forbidden.

An untyped exception from an operation that may have crossed publication is `uncertain`, never `not published`.

### 4.6 Durable row publication state

Preparation state is process-local, but a created candidate also carries durable store state. Opened and persisted borrowed managers already reference durable adopted rows; their process-local `prepared` state controls only contingent mutation and close-authority transfer and never grants delete authority.

```text
prepared(sessionGeneration, preparationId) -> adopted(sessionGeneration, adoptionRevision)
```

Required rules:

- normal list, search, continuation, `findForResume`, and public `open` exclude prepared rows;
- only a manager holding the opaque process-local preparation capability may load or append to its prepared row;
- prepared writes include `preparationId` in the worker request and are rejected after adoption or for another preparation;
- created rollback uses a dedicated conditional discard requiring store ID, session ID, session generation, preparation ID, prepared state, and expected revision;
- ordinary `SessionManager.delete` operates only on adopted rows and cannot substitute for prepared discard;
- adoption is one commit-identified SQLite transaction that applies staged canonical setup, marks the row adopted, clears the preparation ID, advances revision, and records evidence;
- adoption reconciliation uses the existing commit ID/digest rules: matching evidence proves adoption, absent evidence plus unchanged expected revision proves no publication, and any unreadable/mismatched/advanced state is uncertain;
- once adopted, the row can be deleted only by the ordinary explicit session-delete contract, never preparation rollback;
- direct public `SessionManager.create` adopts before returning because its caller immediately owns the manager;
- a crash-left prepared row remains inaccessible and hidden. This RFC defines no automatic reclamation policy.

The durable state is distinct from `sessions.visible`. A prepared row's content projection may compute either visibility value, but normal catalog queries exclude it by publication state; an adopted row may also have `visible = 0`. The preparation ID is a collision-resistant stale-operation capability, not a security secret against the OS user who owns the database.

A caller-named ID that already has a prepared row is not treated as missing. An internal status lookup may report `preparing` without returning an open capability: the same in-process coordinator joins its exact preparation, while an unrelated live process/request receives a typed `session_preparing`/busy result without an open capability. It cannot create a second incarnation, adopt without the preparation capability, or fall through to ordinary resume. After adoption, an exact retry resolves the adopted incarnation.

Remote caller-named idempotency also needs a stranded-preparation rule. A daemon-owned preparation records the daemon boot/instance authority that created it. After acquiring the daemon's existing exclusive process lock with a fresh boot/instance ID and proving that the recorded owner cannot still hold that lock (socket or pidfile failure alone is insufficient), a later exact `target:"new"` retry may CAS-discard that still-prepared row and create the same requested ID with a fresh session generation. A live current-daemon preparation is joined/retried, never reclaimed. A preparation whose owner death cannot be proven returns stable `session_unavailable` and is preserved. This targeted exact-retry reclaim is not age-based garbage collection and never applies to adopted rows or arbitrary CLI/SDK preparations.

### 4.7 Session incarnation identity

`SessionReference` is the persisted incarnation identity:

```text
(storeId, sessionId, sessionGeneration)
```

`sessionDirectory` locates the host store but does not replace store identity. Once an ID-only local or remote request resolves to a reference, every authority-bearing host object pins that reference (or equivalent store ID/generation fields) for its lifetime. Lookup indexes may remain keyed by workspace/session ID, but each record and mutation proves the pinned incarnation.

Deleting and recreating the same session ID is allowed. A stale worktree binding, last-session pointer, lease, coordinator callback, subagent edge, or attach claim for the old generation must fail resolution or be explicitly replaced; it cannot silently bind to the new generation. The remote wire continues to carry session IDs and resolves the current incarnation at each new attach.

## 5. Composition with existing ownership contracts

### 5.1 Normative amendments and prerequisites

This RFC is the session-storage amendment for stale file-era language; it does not reopen the accepted ownership decisions in the linked RFCs.

| Document | Status under this RFC |
| --- | --- |
| [Delivery transaction contract](delivery-transaction-contract-design.md) | Remains authoritative for canonical delivery settlement, receipts, reconciliation, and conversation authority. Manager acquisition/adoption happens outside one delivery owner's scope. |
| [Atomic conversation bootstrap](conversation-bootstrap-design.md) | Its `ConversationCoordinator`, feed, and replacement ownership remain authoritative. References to a recoverable “WAL-only file” mean an adopted selector-hidden SQLite row opened by exact reference. Replacement order is the implemented reservation → candidate construction/durable setup → lease/registry rekey commit → feed source commit → finalization sequence; session preparation wraps that sequence but does not replace its owners. |
| [Live shared sessions](live-shared-session-daemon-design.md) | References to a session file or JSONL source of truth mean the authoritative SQLite session row plus ordered entries. JSONL is not live handoff storage. |
| [Workspace authority lifecycle](workspace-authority-lifecycle-design.md) | This remains a Proposed prerequisite, not a current source owner. Until it is implemented, existing Iroh service admission epochs, attach claims, coordinators, and lease capabilities retain their current duties. If accepted later, `WorkspaceAuthorityCoordinator` surrounds but does not replace session preparation. |
| [Worktree design](worktrees-design.md) | Parent-keyed SQLite storage and worktree cwd remain authoritative. Old path-based `SessionManager.open` examples mean exact `SessionReference` resolution followed by cwd authorization. Durable worktree session bindings must pin the session incarnation under §4.7. |
| [Subagent design](subagents-design.md) | Registry/activity publication still begins at accepted prompt. Session-row adoption is separate: returning a live handle/reference adopts the row even before registry publication; an internal atomic start-and-prompt flow may remain prepared until prompt acceptance. A registration failure permits row discard only when its typed outcome proves no row/handle/runtime publication. |

A later implementation must update contradictory clauses in those documents in the same source change; implementation may not choose whichever historical wording is most convenient.

### 5.2 Ownership composition

This RFC adds no competing long-lived owner.

| Existing owner | Existing responsibility | Relationship to `SessionManagerPreparation` |
| --- | --- | --- |
| `SQLiteSessionStoreLease` | Reference-counts one process-local worker client for a store. | The manager owns/relinquishes the lease. Preparation chooses whether failure asks the manager to close or discard. |
| `SessionManager` | Owns one live session-generation authority, canonical indexes, persistence queue, and reconciliation state. | Preparation wraps acquisition disposition only; it cannot append, reconcile, or replace manager authority. |
| `AgentDeliveryOwner` | Settles one logical delivery and supplies verified canonical mutation receipts. | Unchanged. Delivery settlement may use an adopted manager but never adopts or discards a manager. See [delivery transaction contract](delivery-transaction-contract-design.md). |
| `AgentSession` | Owns active agent/harness resources and, after explicit transfer, closes its manager on disposal. | A prepared candidate initially lacks persistence-close authority; adoption transfers that authority exactly once. |
| Prepared candidate finalizer | Temporarily disposes candidate harness, extension, MCP, Git, settings, subagent, and other non-persistence resources before adoption. | It is an operation helper, not a long-lived owner. It leaves manager close/discard to the preparation until transfer. |
| `AgentSessionRuntime` | Serializes current-session structural operations and stages source replacement. | Its lifecycle actor holds and joins preparation publication until the existing replacement cutoff. |
| `ConversationProjectionFeed` | Owns one materialized live conversation feed and atomic subscriber source rebind. | Its `commitSourceRebind` is one publication boundary, not manager-lifetime ownership. See [atomic conversation bootstrap](conversation-bootstrap-design.md). |
| `ConversationCoordinator` | Owns daemon runtime/transport retirement for one logical conversation. | Must hold the candidate runtime before adoption and close it on every post-adoption failure. |
| `LeaseBroker` | Owns process-level conversation lease state and exact owner capabilities. | Lease publication consumes a prepared manager indirectly through the runtime; it does not delete session rows. See [live shared sessions](live-shared-session-daemon-design.md). |
| Proposed `WorkspaceAuthorityCoordinator` | If separately accepted and implemented, owns workspace-generation admission and retirement. | It may fence a prepared operation, but manager compensation remains origin-specific; current code continues using its existing distributed admission owners until then. |
| `WorktreeManager` | Owns worktree checkout/binding state. | Worktree cwd and parent-keyed session directory remain inputs to acquisition; preparation never changes path authority. See [worktree design](worktrees-design.md). |
| `SubagentManager`, handle, and runtime registration | Own child admission, handle lifetime, first-prompt registry/activity publication, and child runtime lifetime. | Returning a public handle adopts the row; only an internal atomic create-and-prompt flow may retain row rollback through prompt acceptance. See [subagent design](subagents-design.md). |

The preparation may retain a reference to an installed owner for ordering, but it never becomes the owner of provider work, tools, streams, leases, registries, or child execution.

## 6. Session manager preparation contract

### 6.1 Proposed internal shape

The eventual implementation may choose different private names, but it must expose equivalent semantics:

```ts
type SessionManagerAcquisitionOrigin = "created" | "opened" | "borrowed";
type SessionManagerPreparationState = "prepared" | "publishing" | "adopted" | "settled";
type SessionManagerPublicationOutcome = "not_published" | "published" | "uncertain";

interface SessionManagerPreparation {
  readonly manager: SessionManager;
  readonly origin: SessionManagerAcquisitionOrigin;
  readonly state: SessionManagerPreparationState;
  readonly settled: Promise<void>;

  /** Synchronously fences rollback and returns the sole publication attempt. */
  beginPublication(): SessionManagerPublicationAttempt;

  /** Request origin-specific rollback, joining an in-flight publication first. */
  rollback(): Promise<void>;

  /** Complete transfer after a published/uncertain outcome; performs no I/O. */
  settleAdoption(): SessionManager;
}

interface SessionManagerPublicationAttempt {
  /** Exactly one terminal classification is required. */
  finish(outcome: SessionManagerPublicationOutcome): Promise<void>;
}
```

Required behavior:

- terminal `settled` state records transfer or rollback; callers never infer disposition from manager state;
- `beginPublication()` synchronously transitions prepared → publishing and is single-claim;
- rollback during publishing sets monotonic intent and joins the same publication/settlement promise;
- `finish("not_published")` performs origin rollback and settles; it is legal only after every publication participant proves restoration;
- `finish("published")` or `finish("uncertain")` transitions to adopted and permanently disables preparation deletion, even when rollback was requested;
- an abandoned publication attempt is classified uncertain by its mandatory finalizer;
- `settleAdoption()` transfers persistence-close authority to the installed terminal owner, transitions adopted → settled, and is idempotent after transfer;
- repeated rollback returns the same promise and never closes/deletes twice;
- rollback after adoption or transfer rejects with a preparation-state error and performs no manager I/O;
- adoption/transfer after completed rollback is a state error and cannot resurrect ownership;
- cleanup failure preserves the original operation error and every cleanup error in an `AggregateError`;
- created cleanup uses the durable preparation ID as well as exact store/session/generation/revision identity;
- the flow's existing lifecycle actor must await `settled` during caught failure and graceful shutdown.

### 6.2 Origin-specific rollback

| Origin | Definitive failure before durable adoption | Success/adoption |
| --- | --- | --- |
| `created` | Finalize candidate resources without closing persistence, drain/close the manager, then discard only the exact durable preparation. Attempt close and discard and aggregate failures. A state/revision/preparation conflict preserves the row and reports cleanup failure. | Durable adoption clears preparation identity; transfer normal close responsibility to the installed `AgentSession`/runtime owner. |
| `opened` | Finalize candidate resources without closing persistence, then close the temporary manager. Never delete. | Transfer normal close responsibility to the installed owner. |
| `borrowed` | Finalize candidate resources without closing the manager. The original caller/current runtime retains it after a proven no-effect outcome. | Transfer only the responsibility explicitly documented by the successful API, such as a returned `AgentSession` owning eventual close. |

In-memory managers use borrowed manager cleanup semantics. Internal replacement must still use a separate in-memory candidate so failure cannot mutate or dispose the installed conversation.

### 6.3 Prepared candidate finalization

A candidate `AgentSession` currently closes its manager during ordinary disposal. That behavior cannot coexist with preparation rollback: it would close borrowed managers and give created/opened managers two persistence finalizers.

The implementation therefore needs an internal prepared-candidate mode or helper with this contract:

1. construct the candidate without transferring persistence-close authority;
2. keep it isolated from RPC/relay attachment, provider/tool work, public observers, subagent starts, and extension `session_start` publication while prepared;
3. permit resource discovery/module validation pre-adoption, but stage any session-bound mutation through the canonical overlay and defer externally observable lifecycle hooks until adoption;
4. on pre-adoption failure, synchronously fence candidate and delayed Git/resource callbacks;
5. dispose/join harness, extension-loader, MCP, Git, settings, subagent, staged feed-subscription, and other non-persistence resources without calling manager close;
6. invoke exactly one origin-specific preparation rollback;
7. aggregate candidate-finalization and manager-cleanup failures deterministically;
8. on adoption, transfer the persistence-close capability exactly once to `AgentSession`, publish deferred lifecycle binding, and make normal `AgentSession.dispose()` the sole manager finalizer.

No prepared candidate may expose its session reference through extensions, RPC, registries, or event callbacks. The helper is temporary preparation choreography, not another long-lived owner. `agent-session.ts` and `agent-session-services.ts` are therefore part of the future implementation boundary even though public session/runtime signatures remain unchanged.

### 6.4 Acquisition factories

Internal higher-level paths must receive acquisition disposition from the factory that knows it. They must not infer it from:

- whether the manager currently equals `runtime.session.sessionManager`;
- whether a `SessionReference` exists;
- selector visibility;
- message count;
- a remote response after several transformations;
- an unscoped boolean such as `createdRuntime` or `published` detached from the manager capability.

Required factory classifications:

| Factory/result | Origin |
| --- | --- |
| New persisted session | `created` |
| JSONL import target | `created` |
| Cross-store/session fork target | `created` |
| Branched-session target | a separate `created` preparation; the source remains a scoped opened manager |
| Exact `SessionManager.open` | `opened` |
| `continueRecent` opening an existing row | `opened` |
| `continueRecent` creating a row | `created` |
| Caller-provided manager | `borrowed` |
| In-memory replacement candidate | separate borrowed/in-memory preparation; never the installed manager object |

One preparation pins one manager object, acquisition origin, and persisted incarnation. Identity-changing methods such as `newSession()` or `createBranchedSession()` are not used on a wrapped source manager. Internal fork/clone opens the source as a scoped reader and creates a separate target preparation. CLI missing-cwd recovery resolves/validates the final cwd before final acquisition, or rolls back/closes the first preparation before opening another; it never overwrites a manager variable while abandoning its lease/origin.

Public low-level `SessionManager.create/open/...` continue returning `SessionManager`. Internally, the underlying acquisition path produces a preparation first; a direct public create durably adopts and settles before return because the caller becomes the explicit owner. This avoids an exception gap between row creation and preparation.

The public runtime factory also keeps its current options shape through an explicit split:

```text
public createAgentSessionRuntime({ sessionManager, ... })
  -> wrap raw manager as borrowed
  -> internal createPreparedAgentSessionRuntime({ preparation, ... })

CLI / daemon / replacement / subagent internals
  -> acquire created|opened|borrowed preparation
  -> internal createPreparedAgentSessionRuntime({ preparation, ... })
```

The internal helper returns the prepared candidate/runtime plus its mandatory finalizer; it does not hide acquisition origin inside the public raw-manager parameter.

### 6.5 Adoption invariants

1. **Candidate finalizer first.** A candidate session/runtime with a guaranteed non-persistence finalizer exists before publication begins.
2. **Persistence owner transfers once.** Preparation alone may close/discard before adoption; `AgentSession` alone may close after transfer.
3. **No avoidable fallible work after the ideal cut.** Validation, service construction, rejecting hooks, path checks, and reversible reservations run while prepared.
4. **Fence asynchronous publication.** Once publication begins, cancellation cannot run origin rollback until its typed outcome is joined.
5. **Durable adoption before external reachability.** For created rows, the reconciliation-capable SQLite adoption transaction commits before a runtime, handle, reference, route, binding, or registry entry becomes externally reachable.
6. **Earliest durable route wins.** If worktree, last-session, parent-edge, lease, or registry state can resolve the candidate, that effect is publication unless a typed receipt proves restoration.
7. **Uncertainty preserves.** If any participant may have published, adopt/fail-preserve even when the overall operation reports failure.
8. **Post-adoption failures do not roll back identity.** They retire through the installed owner and preserve the session row.
9. **Selector visibility is irrelevant.** `visible` never authorizes adoption or deletion.
10. **Incarnation and preparation fencing are authoritative.** Stale preparation cannot delete an adopted row, another preparation, or a recreated generation.

If an existing publication API can throw after making the candidate reachable without returning typed evidence, it must be split into reversible preparation and a no-throw linearization step or return a typed outcome. Cleanup convenience never justifies delete-after-publication risk.

#### Preparation-local canonical view

Manager-row ownership and canonical mutation atomicity are separate concerns.

- Candidate-dependent model, thinking, planning, checkpoint, name, and extension setup is represented as a declarative `SessionCanonicalCommand` overlay against a manager-issued projection guard.
- Candidate construction reads one effective view: authoritative base projection plus the ordered overlay. It never reads stale base policy while setup writes wait for adoption.
- The overlay is not visible through the original opened/borrowed manager, observers, list/search, or another process.
- After all other fallible setup succeeds, `beginPublication()` atomically commits the overlay. For a created row, the same SQLite transaction changes durable publication state to adopted. For opened/borrowed rows, it commits only guarded canonical mutations because the row was already durable/adopted.
- Proven rollback drops the overlay and leaves opened/borrowed canonical state unchanged. Committed or uncertain outcome moves the preparation to adopted/fail-preserved before external publication continues.
- The candidate then binds to the committed revision/effective state without replaying hooks or appending the setup twice.
- A mutation explicitly intended to survive runtime-construction failure is an independent user operation committed before preparation, not candidate setup.

This rule applies to CLI startup options, SDK model/thinking/plan initialization, resumed runtime setup, plan handoff checkpoints, and extension-driven setup. Closing an opened manager is not rollback for already appended canonical entries. A borrowed manager is guaranteed usable only after a proven no-effect failure; committed or uncertain overlay outcomes require a fresh authoritative manager.

### 6.6 Exact adoption boundaries

#### CLI startup

`main.ts` session selection must return a preparation, not a bare manager with lost origin information.

- new, imported, and forked targets are `created`;
- resumed targets are `opened`;
- `continueRecent` reports its actual origin;
- no-session mode is `borrowed`/in-memory.

Synchronous flag/name validation completes before acquisition. Immediately after acquisition, one top-level `try/finally` owns the preparation; no `process.exit()` path may bypass its joined settlement. Missing-cwd prompting completes before final acquisition (or explicitly rolls back/closes the first preparation before reacquiring), and `--name` is part of the startup canonical overlay rather than an immediate append to an opened/imported manager.

`createAgentSessionRuntime()` stages services, the prepared candidate, feed, and startup canonical overlay. Immediately before returning the runtime, its publication attempt commits/reconciles durable adoption and contingent setup, transfers persistence-close authority to `AgentSession`, and settles the preparation. Any proven no-effect failure before that point rolls back by origin. Once returned, runtime disposal owns close and the row is retained even if print, RPC, or interactive mode later fails.

#### SDK `createAgentSession`

- the default internally created manager is `created`;
- `options.sessionManager` is `borrowed`.

The prepared candidate finalizer exists before publication; `AgentSession` receives persistence-close authority only after durable adoption. Resource loading, model resolution, MCP/LSP setup, extension loading, and startup policy calculation remain pre-publication, while their canonical effects stay in the preparation-local overlay. Immediately before `createAgentSession()` resolves, the publication attempt commits/reconciles that overlay, transfers close authority, and settles. A proven no-effect failure discards only a default-created preparation and leaves a borrowed manager usable. A committed or uncertain overlay fails but preserves the session and retires the borrowed manager authority for reopen. Any error after the promise resolves is ordinary adopted-session lifecycle, never construction rollback.

The lower-level public `createAgentSessionRuntime()` follows the same ownership rule: a raw manager supplied by an SDK caller is borrowed until success, while internal CLI/daemon callers may pass a preparation carrying created/opened origin. On a proven no-effect construction failure, a raw caller manager remains caller-owned; after a committed/uncertain setup outcome the candidate terminalizes that stale authority and the caller reopens, while on success the returned runtime owns eventual close. This intentionally replaces the current ambiguous close-on-failure behavior without changing the function signature and must be called out in the later SDK documentation change.

#### `AgentSessionRuntime` replacement

New, resume, fork, clone, and import all pass a preparation into the serialized lifecycle actor.

Required order:

```text
acquire preparation
  -> validate structural operation and durable input gates
  -> build candidate AgentSession/services
  -> stage feed source rebind, contingent canonical mutations, and host replacement reservations
  -> complete reversible/fallible pre-publication work
  -> commit/classify contingent canonical state under the lifecycle actor
  -> classify host replacement commit outcome
  -> adopt no later than the first proven or uncertain durable/source/registry publication cut
  -> commit feed source and installed runtime generation
  -> settle adoption
  -> run post-publication recovery, callbacks, and listeners
```

For daemon-backed replacement, the preparation publication attempt spans contingent canonical commit, durable created-row adoption, `AgentSessionReplacementTransaction.commit()`, and `ConversationProjectionFeed.commitSourceRebind()`. The lifecycle actor joins that attempt. The implemented order remains reservation → candidate/durable setup → lease/registry rekey commit → feed commit → finalization. Any successful early routing/rekey participant makes the result published unless its typed receipt proves restoration; an untyped throw is uncertain. Persistence-close authority transfers before post-publication callbacks, and the row is preserved thereafter.

`withSession`, rebind callbacks, replacement listeners, recovered-input processing, and UI rendering happen after adoption. Their failure may fail-stop or retire the new runtime, but cannot delete its row.

A same-reference authority refresh is `opened`, not `created`, and never permits deletion.

#### Daemon-owned remote runtime creation

`resolveIrohRemoteSessionTarget()` must preserve acquisition origin through `createIrohRemoteAgentRuntimeWithSessionSelection()` and `IntegratedRuntimeRegistry` preparation.

- `created` and `created_after_missing` selections carry `created` preparation;
- `resumed` carries `opened` preparation;
- a pre-resolved target carries the same capability rather than reconstructing policy from selection strings later.

Runtime/service construction, cwd authorization, worktree resolution, tool policy, and audit preparation occur while prepared. Worktree binding, client last-session persistence, registry insertion, lease/coordinator activation, and publication callbacks form a composite publication sequence:

1. prepare each durable participant and retain a typed restoration receipt;
2. begin and reconcile session-row adoption;
3. commit durable worktree/last-session routing only after adoption;
4. publish the exact-incarnation registry/lease/coordinator owner;
5. transfer persistence-close authority and settle preparation.

`ConversationCoordinator.activateRuntime()` is not the only cutoff. A committed binding, pointer, registry insertion, or throwing post-linearization callback is already published unless all prior receipts restore it. `abortPreparedEntry()` may discard only after the entire sequence proves `not_published`. Stream failure after publication detaches or retires through the coordinator and preserves the row.

A late runtime result that arrives after attach cancellation still carries its preparation. The attach/shutdown owner must join its rollback/publication settlement instead of launching unobserved late cleanup.

#### TUI relay target handoff

If target resolution creates a row for a TUI-owned conversation, closing the temporary manager is not rollback: the TUI/relay is expected to open that reference. The preparation adopts before the resolved target or relay offer becomes available to the TUI owner, then the temporary manager closes while the row remains.

Failure before target handoff discards a created row. Failure after a possibly delivered offer preserves it.

#### Host-internal incarnation propagation

After target resolution, these structures carry the exact persisted incarnation rather than a bare session ID:

| Structure | Required identity |
| --- | --- |
| `ResolvedSessionTargetWithManager` / runtime creation result | Full `SessionReference` plus created/opened preparation |
| `IntegratedRuntimeEntry` and `ConversationCoordinator` | Store ID, session ID, session generation; lookup key may remain workspace/session ID only as an index |
| Daemon `LeaseRecord`, attach claim, rekey reservation, and delayed stream callback | The coordinator's exact incarnation capability |
| Persisted client last-session state | Exact store ID, session ID, and session generation; a stale value fails/clears and never binds to a same-ID replacement |
| Worktree session binding | Parent store ID, session ID, and generation; stale binding fails rather than selecting a same-ID replacement |
| Parent/child session and `subagent_spawns` index | Child store ID, session ID, and generation matching the canonical spawn entry |
| Session deletion/recreation callbacks | Exact old capability; an ID-only callback cannot mutate the current record |

An ID-only remote target is resolved once at attach. That attach then remains pinned even if another operation deletes/recreates the name; normal generation/revision authority loss retires the stale runtime. Re-resolution on a later attach may intentionally choose the newer incarnation.

#### Subagent startup

A persisted child created beside a persisted parent is `created`; a resumed child is `opened`; an injected manager is `borrowed`.

Session-row adoption and registry/activity publication are distinct.

- A public `start()`/`startByName()` that returns a live handle, session ID, or session reference adopts and transfers the child row immediately before returning. A later first-prompt failure may keep registry/activity state unpublished, but it cannot delete the already returned session identity.
- A high-level internal spawn operation may preserve pre-adoption rollback only by keeping the handle/reference private and combining create + prompt acceptance atomically. Prompt rejection before that API returns may then discard a created preparation.
- Definition application, loopback setup, and reversible runtime registration remain prepared in either form.
- Daemon subagent registration, worktree binding, durable parent spawn linkage, shared registry insertion, and activity publication require the same typed composite publication outcome as daemon root creation. A callback that throws after registration linearization is published/uncertain unless it proves restoration.

The subagent design's term “unpublished prompt failure” continues to describe registry/activity visibility. It does not authorize deletion of a session row whose handle or reference already escaped.

### 6.7 Failure and concurrency matrix

| Scenario | Preparation classification | Manager/session result | Higher-level owner result |
| --- | --- | --- | --- |
| Factory fails before manager exists | none | No manager or row to clean | Original error |
| Created candidate; setup fails before publication begins | `created`, `prepared` | Finalize candidate resources, close manager, discard exact prepared row/capability | Original error, aggregated with cleanup errors |
| Opened candidate; proven no-effect setup failure | `opened`, `prepared` | Finalize candidate resources and close temporary manager; preserve row | Original error, aggregated with finalization/close errors |
| Borrowed candidate; proven no-effect setup failure | `borrowed`, `prepared` | Finalize candidate without manager close; manager stays usable | Original error, aggregated only with candidate-finalization errors |
| Normal code tries to list/find/open a durable prepared row | durable `prepared` | Reject as unavailable; do not expose a reusable reference | No competing owner can defeat prepared discard CAS |
| Opened/borrowed setup needs candidate-only canonical writes | any, `prepared` | Read through preparation-local overlay; do not mutate live log | Proven setup failure leaves canonical state unchanged |
| Contingent/adoption transaction proves rollback | `publishing` → rollback | Drop overlay; origin-specific cleanup | Candidate remains unpublished |
| Contingent/adoption transaction commits | `publishing` → `adopted` | Preserve committed row/revision and transfer close authority | Later external-publication failure cannot restore old log |
| Adoption or another publication participant is uncertain | `publishing` → `adopted` | Preserve row; fail-stop uncertain manager and require reconciliation/reopen | Never conditionally delete |
| Validation/cancellation wins before publication begins | any, `prepared` | Origin-specific rollback | Current owner remains authoritative |
| Cancellation arrives during publication | `publishing`, rollback requested | Join typed participant outcome | Roll back only on `not_published`; otherwise preserve/adopt |
| Durable binding/last pointer/registry participant fails with proven restoration | `publishing` | Continue toward `not_published` only after every receipt restores | No dangling external route |
| Any publication participant cannot prove restoration | `publishing` → `adopted` | Preserve row and exact incarnation | Composite result is uncertain |
| Public SDK/runtime/handle return succeeds | `adopted` → `settled` | Persistence-close authority transfers once | Returned owner is authoritative |
| Listener/callback/recovery/stream fails after adoption | `adopted` or transferred | Preserve row; installed owner closes/retires | No construction rollback |
| Created cleanup close fails | rollback settlement | Still attempt prepared-row discard; aggregate outcomes | No silent cleanup success |
| Prepared discard sees adopted state, wrong preparation, or newer revision | rollback settlement | Preserve row and report conflict | Never force-delete another owner/write |
| Session ID is deleted/recreated with another generation | stale capability | Store/generation/preparation guard prevents mutation | Replacement remains authoritative |
| Old-generation host binding/callback reaches reused ID | stale incarnation | Reject exact-reference/capability mismatch | Never route to replacement incarnation |
| Two rollback calls race | `prepared` | One settlement promise and one cleanup attempt | Both callers observe same result |
| Rollback and `beginPublication` race | `prepared` | First synchronous claim wins | Losing path cannot reverse state |
| Graceful shutdown during publication | `publishing` | Fence new work and join preparation settlement | No unobserved late cleanup/publication |
| Bounded process termination before join | process loss | Attempt no speculative delete | Durable prepared/adopted row records last proven cutoff |
| Abrupt process termination while durable prepared | process lost | Inaccessible prepared row may remain | No automatic reclamation or ordinary retry-open |

### 6.8 Abrupt process loss

This RFC guarantees cleanup for caught failure, cancellation, graceful shutdown, and worker failure that the process can still classify. It does not claim automatic crash reclamation.

A process killed before durable adoption can leave a row explicitly marked prepared with a preparation ID whose process-local capability is lost. Unlike an adopted selector-hidden row, it is distinguishable and normal list/find/open paths cannot resolve it. It cannot be deleted merely because it is old: another live process may own a long-running preparation. Only an exact caller-named remote retry may reclaim a daemon-owned preparation after exclusive daemon authority proves the recorded owner terminal (§4.6).

A process killed after the adoption transaction but before external runtime publication leaves an adopted selector-hidden row. Preserving it is required because durable adoption is the fail-preserve cutoff. Exact retry may resolve that adopted incarnation normally.

Generic CLI/SDK reclamation still needs durable owner/liveness or explicit operator recovery policy and remains separate from #329's corrective implementation.

## 7. Materialized projection contract

### 7.1 Canonical entry envelope

SQLite columns are the sole authority for entry envelope identity:

```text
(session_id, entry_id, ordinal, parent_entry_id, entry_type, timestamp, is_host_only)
```

`payload_json` stores only the exhaustively validated type-specific body. It does not duplicate ID, parent, ordinal, type, timestamp, or host-only classification. `SessionManager` reconstructs the public `SessionEntry` from columns plus body; explicit JSONL export continues writing the full public envelope.

Before reduction, every entry type has an exact schema with unknown-field rejection, canonical JSON checks, timestamp/range checks, and cross-reference validation. `is_host_only` must equal the deterministic classification for `entry_type`; callers cannot choose it independently. Parent, compaction boundary, label target, client-input receipt/queue/canonical target, leaf target, and subagent-reference invariants are validated before any derived state changes.

Because #329 is unreleased and provides no SQLite compatibility contract, implementation changes the schema/data shape in place rather than retaining a dual full-entry/body payload reader. If physical normalization is deferred in an implementation revision, every duplicated envelope field must compare exactly and the implementation plan must explain why duplication remains; silently overwriting a mismatched payload ordinal or ignoring `is_host_only` is forbidden.

### 7.2 One reducer

The later implementation introduces one internal session-store projection module. It owns the deterministic functions conceptually equivalent to:

```ts
interface SessionDerivedState {
  summary: SessionSummaryAccumulator;
  labels: ReadonlyMap<string, SessionLabelState>;
  clientInputs: ReadonlyMap<string, ClientInputRecord>;
  subagentSpawns: readonly SessionStoreSubagentSpawnWrite[];
  searchChunks: readonly SessionStoreSearchChunkWrite[];
  leafId: string | null;
  nextOrdinal: number;
}

function createSessionDerivedState(header: SessionHeader): SessionDerivedState;
function reduceSessionEntry(state: SessionDerivedState, entry: SessionEntry): SessionDerivedState;
function replaySessionEntries(header: SessionHeader, entries: readonly SessionEntry[]): SessionDerivedState;
```

The concrete implementation may use controlled mutable builders for performance. There must still be one semantic reducer and one canonical comparison representation.

The reducer receives entries only after canonical JSON cloning, shape validation, ordinal validation, and parent/reference validation. It processes persisted ordinal order. It does not read the filesystem, clock, SQLite, runtime, TUI, or remote state.

### 7.3 Derived families

| Projection family | Canonical source | Required derived semantics |
| --- | --- | --- |
| Session `updatedAt` | Header creation time plus existing activity-bearing message/custom-message timestamps | Preserve current activity semantics and stable timestamps on attach/detach. Invalid dates reject before state changes. |
| `messageCount` | Public message entries plus displayed custom messages under current semantics | Lifetime count; branch leaf movement alone does not reduce it. Fork/import replay derives the retained target's count. |
| `firstMessage` | First user text, else first eligible assistant/displayed-custom fallback | A later first user may replace an earlier fallback after reopen. Reducer state therefore retains user and fallback components, not only final text. |
| `name` | Ordered `session_info` entries | Latest trimmed non-empty name, with empty name clearing it. |
| `visible` | Existing message/planning visibility policy | Independent of preparation/adoption state. |
| `leafId` | Public appends and durable leaf entries | Must resolve to a stored public entry or null. Host-only entries never become the conversation leaf. |
| Starting Git context | First valid host-only `session_start_git_context` | At most one; recorded null differs from absent. |
| Labels | Ordered label entries | Latest non-empty label per target; clear removes it; target must exist. |
| Client input | Ordered host-only receipt, queued, state, and identified canonical user entries | Preserve limits, digest checks, legal transitions, canonical completion, and recovery ambiguity fences. |
| Subagent spawn index | Ordered host-only `subagent_spawn` entries | Exact tool/request identity plus child store ID, session ID, and session generation; never projected remotely as a host locator. |
| Search chunks | Eligible user/assistant text and displayed custom-message text | Deterministic contiguous chunk indexes in entry order; no transcript parsing during list/exact lookup. |

The reducer also produces the complete `SessionStoreSessionProjection` and affected side-table writes for each transaction.

### 7.4 Incremental application

Incremental append and full replay must call the same entry transition functions. Separate implementations that merely share tests are not sufficient.

For ordinary queued persistence:

1. validate and clone the entry;
2. apply the reducer once to live derived state;
3. build the transaction payload from the resulting state plus affected side-index deltas;
4. enqueue persistence in causal order;
5. on uncertain failure, fail-stop conversation authority as already specified by the delivery transaction contract.

No routine append may filter or replay all historical entries to derive a summary.

### 7.5 Atomic staging and rollback

Atomic commands need staged reads of earlier entries in the same command without publishing partial state. The preferred implementation is a transaction-local overlay or undo journal proportional to the staged entries and affected keys:

```text
base canonical/index state
  + staged entry list
  + staged by-id/label/client-input/projection deltas
  -> one SQLite payload
```

On proven rollback, drop the overlay. On commit, merge it once, then notify observers. This avoids using full-history array/map copies as the semantic rollback mechanism.

If implementation retains snapshots temporarily, acceptance still requires that projection derivation itself is incremental and that long-session persistence benchmarks do not regress. A future implementation plan must state whether full canonical-index copying is retained or replaced; this RFC recommends delta staging.

### 7.6 Persisted snapshot verification

`SessionManager.open()` already loads the session row, entries, and side tables. After parsing canonical entries, it must:

1. replay one `SessionDerivedState` from the header and ordered entries;
2. normalize persisted and replayed maps/lists into deterministic order;
3. compare every derived session-summary field and each labels, client-input, subagent-spawn, and search-chunk record;
4. reject the open with a dedicated projection-mismatch/store-integrity error when any value differs;
5. release the temporary store lease on failure.

It must not silently rewrite projections during open.

Reasons to fail closed instead of self-heal:

- mismatch may represent canonical-entry corruption rather than a stale cache;
- automatic repair can race another manager and hide revision conflicts;
- a summary may already have influenced continuation/selection;
- strict failure makes reducer or transaction bugs observable in tests;
- Volt has no released legacy store requiring compatibility repair.

Routine `list`, `search`, exact summary lookup, and continuation selection continue using materialized rows without loading transcripts. Verifying every session during enumeration would reintroduce the original performance defect. A selected session is verified when opened. A dedicated diagnostic audit may verify all sessions explicitly later, outside routine browsing.

### 7.7 Projection transaction invariants

1. Canonical entries, complete session-summary projection, affected side indexes, publication-state transition when any, revision increment, and commit evidence are one SQLite transaction.
2. A side-index write never commits at a revision different from its canonical entry.
3. The worker remains the transaction and reconciliation authority; domain projection semantics remain in the shared SessionManager reducer.
4. The low-level worker protocol validates exact fields, preparation/adoption capability, body-only canonical JSON, and transaction guards but is not a second independent semantic reducer.
5. Reconciliation that proves commit adopts the staged derived state exactly once.
6. Reconciliation that proves rollback leaves live/replayed state exactly at the before snapshot.
7. Uncertain reconciliation makes current conversation projection unavailable rather than selecting either candidate.
8. Opening a fresh manager replays and verifies the authoritative committed snapshot before restoring conversation authority.

### 7.8 Incremental/replay property

The normative property is:

> For any valid session header, valid ordered entry sequence, and partition of that sequence into legal transaction batches, incrementally reducing and committing those batches yields exactly the same normalized derived state as replaying the final canonical entry sequence from empty state.

Additional properties:

- inserting proven transaction rollbacks anywhere leaves final state equal to omitting those batches;
- reopen after each committed prefix equals the live incremental state at that prefix;
- branch movements affect leaf/context but not lifetime summary fields except when a new session is built from a retained branch;
- import/fork ID rewriting preserves projection semantics for the rewritten canonical entries;
- no host-only entry enters provider context or remote transcript projection;
- no side-table corruption can be accepted by open merely because foreign keys pass.

## 8. Search contract

### 8.1 Operation classes

Let `S` be returned/candidate session count, `M` the materialized-summary bytes read, `B` the eligible searchable text examined, `Q` total query bytes/characters processed, `F` fuzzy-token count, and `P` phrase-token count.

| Operation | Data read | Complexity guarantee |
| --- | --- | --- |
| List current/custom store | Adopted `sessions` summary rows only | `O(S + M)`; independent of canonical entry/transcript payload bytes not copied into summaries |
| List all stores | Directory enumeration plus each store's adopted summary rows | `O(stores + S + M)`; independent of canonical entry payload bytes |
| Exact ID/reference lookup | Indexed adopted session identity plus one summary | Indexed lookup plus matched summary bytes; no entry/search-chunk read |
| Continue recent | Adopted summaries plus indexed pending-input metadata | Proportional to materialized candidate/index work; no canonical transcript payload read |
| Remote `list_sessions` | Adopted summaries plus bounded remote-safe projection | `O(S + M)` before remote projection; no canonical entry payload read |
| Deep fuzzy/phrase search | Session metadata plus eligible `search_chunks.text` | Parsing `O(Q)`, fuzzy scans `O(F × B)`, and a conservative phrase-search bound `O(B × Q)` including phrase lengths: total `O(Q + B × (F + Q))` |
| Deep regex search | Same extracted document | Document/query construction is `O(Q + B)`; RegExp compile and match have no general time bound |

SQLite stores extracted text separately so deep search avoids parsing canonical entry JSON and ignores non-searchable payloads such as tool details, images, hidden custom entries, and arbitrary extension data. That is useful but is not a content-index complexity guarantee. Materialized `name`, `first_message`, cwd, and other summary fields still contribute to `M`; documentation and benchmarks must not pretend summary bytes are free.

### 8.2 Preserved query semantics

The search worker preserves:

- whitespace-separated fuzzy tokens;
- quoted phrases, including matches spanning adjacent extracted chunks after space joining;
- `re:` JavaScript regular expressions;
- current fuzzy scoring and alphanumeric swap behavior;
- aggregate score ordering with modified-time tie-breaking;
- session ID, name, cwd, and extracted message text in the searchable document;
- visibility and canonical-cwd filtering;
- global cross-store score merge behavior.

No documentation may say that deep search is independent of transcript or searchable-text size.

### 8.3 Memory bound

The current worker materializes an entire store's search rows before scoring. The target implementation iterates chunks ordered by session, builds and scores one session document, releases it, and proceeds to the next session.

Expected worker-owned search memory is therefore:

```text
O(materialized summaries + result summaries + Q-sized query/parser state
  + largest single session searchable document and its normalization copies)
```

not:

```text
O(all searchable text in the store)
```

Cross-store search remains sequential so only one store scan is active in the calling operation. Repeated fuzzy tokens currently create repeated lowercase/scan work; the implementation may normalize one session document once only if generated parity tests prove identical scoring.

This is a memory bound, not a CPU-time bound. Token/phrase cost scales with query-token count as well as text, and JavaScript regex has no general asymptotic guarantee. Because search and writes share the store worker, an expensive regex may delay later operations for that store. This limitation must be documented rather than hidden behind the word "indexed."

### 8.4 Why this RFC does not add FTS

[Node 22.16.0 enabled SQLite common flags including FTS5](https://nodejs.org/en/blog/release/v22.16.0), and Volt's supported/CI Node versions are newer. Availability does not solve semantic equivalence:

- subsequence fuzzy matching does not require contiguous lexical terms;
- quoted phrases currently span independently stored message chunks;
- arbitrary JavaScript regex cannot be represented by an FTS query;
- an FTS candidate fast path would still need a full fallback to avoid false negatives;
- changing semantics or returning incomplete candidates would remove intentional behavior;
- FTS virtual/shadow tables would expand schema validation and release testing in an already broad storage change.

FTS may be designed later if the product chooses a different default query language or accepts an explicitly incomplete/alternate search mode. It is not a hidden follow-up required to make #329's listing objective true.

### 8.5 Benchmark contract

The session benchmark must report separate dimensions:

1. **Non-searchable payload growth**: grow canonical custom/tool payload while keeping summary/search text fixed. Cold/warm listing and exact lookup should remain insensitive to those bytes.
2. **Searchable text growth**: grow eligible user/assistant/displayed-custom text. Token/phrase runs report text and query-token scaling, regex runs are observational without a linearity claim, and peak heap should reflect one-session rather than whole-store accumulation.
3. **Query growth**: vary total query bytes, fuzzy-token count, phrase count/length, and regex pattern bytes independently from searchable text.
4. **Session/store count growth**: vary sessions per store and number of stores independently.

The benchmark is observational unless a later implementation plan defines stable same-host thresholds. It must not use a large unsearched custom payload as evidence that deep search itself is transcript-size-independent.

## 9. Path, privacy, and trust boundaries

1. `SessionReference.sessionDirectory`, store ID, session generation, preparation ID, and parent session directories are host-local capabilities. Local APIs and explicit local JSONL interchange may carry the documented local parent locator, but remote-safe session surfaces never carry store/preparation locators.
2. Store ID, session ID, session generation, durable publication state, and preparation capability must all match the operation being performed. Path or ID equality alone is insufficient.
3. Custom session directories are resolved before publishing reusable references.
4. Equivalent cwd aliases use the existing canonical path comparison for filtering; stored lexical cwd remains available for display and worktree behavior.
5. Worktree sessions remain in the parent workspace store with their effective worktree cwd, as defined by `worktrees-design.md`.
6. Search over cwd is local-only. Remote session surfaces may carry existing relative `workingDirectory`, `worktreeId`, and synthetic `/workspace` mappings; they never carry the SQLite directory, parent-session directory, store ID, generation, or preparation ID. Unrelated host paths retain the existing Iroh outbound-filter contract rather than gaining an implicit new guarantee here.
7. A projection mismatch error must map to a stable remote-safe failure without message payload, storage locators, provider data, raw client-input bodies, or newly exposed host paths.
8. The preparation capability object is process-local and is never exposed to extensions or application/remote RPC. Its opaque preparation ID is serialized only in the owner-local SQLite row and private worker protocol needed for guarded writes/adoption/discard.

## 10. Future implementation map

This section is a handoff for a later plan, not implementation authorization.

### Phase A: preparation primitive and acquisition metadata

Likely files:

- new `src/core/session-manager-preparation.ts`;
- `src/core/session-manager.ts` internal create/open/continue/import/fork acquisition paths;
- `src/core/session-store/{schema,types,protocol,client,worker}.ts` for prepared-row capability/owner identity, adoption transaction, and normal-lookup exclusion;
- focused unit/store tests for preparation and adoption.

Exit criteria:

- public `SessionManager` signatures remain unchanged;
- every internal acquisition reports created/opened/borrowed without inference;
- prepared rows cannot be resolved through normal list/find/open and cannot be mutated/discarded without their preparation capability;
- adoption and contingent canonical setup share reconciliation-capable commit evidence;
- publishing, rollback intent, transfer, and cleanup settle exactly once.

### Phase B: local/SDK and runtime replacement adoption

Likely files:

- `src/main.ts`;
- `src/core/sdk.ts`;
- `src/core/agent-session.ts` and `src/core/agent-session-services.ts` for prepared candidate finalization and persistence-close authority transfer;
- `src/core/agent-session-runtime.ts`, with public raw-manager wrapping and a separate internal preparation-aware factory;
- existing SDK/runtime replacement tests.

Exit criteria:

- default-created proven pre-publication failures discard the prepared row;
- borrowed proven no-effect failures leave the manager usable and candidate disposal does not close it;
- resume failures never delete existing sessions or leave contingent setup entries after a proven no-effect result;
- post-publication callback failures preserve the adopted row;
- replacement publication reports definitive versus uncertain outcome.

### Phase C: daemon, relay, and subagent adoption

Likely files:

- `src/daemon/session-target.ts`;
- `src/modes/rpc/iroh-remote-agent-runtime.ts`;
- `src/daemon/integrated-runtimes.ts`, `src/daemon/conversation-coordinator.ts`, and `src/daemon/lease-broker.ts`;
- `src/daemon/iroh-service.ts` where created relay targets are handed off;
- worktree and daemon state/binding modules that persist session identities;
- `src/core/subagents/manager.ts` and the subagent-spawn projection/index schema;
- daemon co-attach, remote runtime, worktree, and subagent integration tests.

Exit criteria:

- `sessionSelection` remains wire metadata, not cleanup authority;
- same-daemon caller-named retries join/live-retry one preparation, and a restarted exclusive daemon can reclaim only its proven-terminal predecessor's still-prepared row;
- prepared daemon entries and late canceled runtime results are joined and roll back once only after all participants prove no publication;
- published daemon entries retire through `ConversationCoordinator` without row deletion;
- every host-internal runtime, lease, binding, pointer, edge, and callback proves exact session incarnation;
- public child handles adopt before return, while internal atomic create-and-prompt may discard on proven pre-return prompt failure;
- uncertain parent-edge/runtime publication preserves the child row.

### Phase D: projection reducer and integrity verification

Likely files:

- new `src/core/session-store/projection.ts`;
- exhaustive entry-body schemas and column/body reconstruction;
- `src/core/session-manager.ts`;
- `src/core/session-store/{schema,types,protocol,worker}.ts` for body-only payloads and a dedicated integrity error;
- projection, session-store, import/fork, and reconciliation tests.

Exit criteria:

- one semantic reducer serves append and replay;
- each side projection matches replay after every tested prefix;
- malformed entry bodies, envelope/classification mismatch, and corrupt summary/label/client-input/spawn/search projection fail open cleanly;
- routine list/exact lookup still does not load entries;
- atomic rollback restores before state without projection drift.

### Phase E: bounded search scan and contract corrections

Likely files:

- `src/core/session-store/worker.ts`;
- `benchmarks/session-listing.ts` or a renamed session-storage benchmark;
- `README.md`, `docs/usage.md`, `docs/sessions.md`, `docs/session-format.md`, SDK docs, the #329 PR body, and the primary SQLite changeset.

Exit criteria:

- generated parity tests return identical results/scores before and after scan refactoring;
- phrase matching across chunks remains intact;
- worker accumulation is bounded to one session document;
- prose distinguishes summary indexes from deep-text scan complexity.

### Phase F: verification and implementation review

A later approved implementation plan should run modified focused tests, `./test.sh`, and `npm run check` under repository rules. It should review the resulting diff against this RFC's state and failure matrices before requesting another broad PR review.

Build/package smoke commands require their own explicit scope under repository rules.

## 11. Verification contract

### 11.1 Preparation state-machine tests

Exercise every legal and illegal method sequence for each origin:

- rollback from prepared and repeated rollback;
- single-claim `beginPublication`;
- rollback requested while publication is blocked;
- each typed publication outcome and mandatory uncertain finalization;
- adopted transfer and repeated settlement;
- conflicting rollback/publication/transfer calls;
- candidate non-persistence finalization before manager cleanup;
- close failure, prepared-discard failure, and both failing;
- wrong preparation ID, adopted-state conflict, revision conflict, and session-generation replacement;
- borrowed proven-no-effect failure followed by a successful write;
- committed/uncertain borrowed overlay followed by stale-authority rejection and reopen.

Assertions target observable manager/store behavior, not source text.

### 11.2 Lifecycle integration tests

Inject failure at every await boundary before, during, and after publication for:

- default SDK startup, caller-supplied SDK manager, and direct `createAgentSessionRuntime`;
- CLI new, continue, resume, missing-cwd retry/cancel, import, and fork setup;
- runtime new/resume/fork/import replacement;
- daemon runtime creation, same-instance named retry, daemon-restart stranded-preparation retry, unprovable-owner rejection, late canceled result, registry commit, attach cancellation, and post-publication stream failure;
- TUI relay target creation/handoff;
- subagent runtime setup, definition application, loopback creation, public handle return, internal atomic start-and-prompt, runtime registration, first prompt, parent spawn linkage, and handle disposal.

For each injection, assert the matrix result: prepared row absent/inaccessible, adopted row retained, borrowed manager usable or correctly retired for reopen, manager closed exactly once, routing state restored, or fail-preserved uncertainty. Graceful shutdown joins late runtime/preparation cleanup instead of merely scheduling it.

Delete and recreate the same session ID with a new generation while retaining old last-session, worktree, lease/coordinator, subagent-edge, and delayed-callback fixtures. Every old fixture must fail/clear against the replacement rather than resolving or mutating it.

### 11.3 Projection deterministic tests

For canonical envelopes and each derived family:

- exhaustive type-body validation plus column/body reconstruction and JSONL export;
- rejection of mismatched host-only classification, parent/reference fields, and malformed type-specific bodies;
- append, flush, list, reopen, and compare;
- import and fork, including ID rewriting and branch retention;
- atomic commit and proven rollback;
- empty/cleared metadata;
- recorded-null versus absent Git context;
- legal and illegal client-input transitions;
- labels before immediate branch/fork;
- subagent edge and child store/session/generation integrity;
- search chunk ordering and eligibility.

Directly corrupt one persisted projection family at a time while retaining valid foreign keys. `SessionManager.open()` must reject it and release the lease. Healthy sessions in another store remain available.

### 11.4 Projection property tests

Use deterministic-seed `fast-check` operation sequences. Generate valid actions rather than malformed source objects:

- public and host-only append types;
- labels and clears against existing targets;
- branch/leaf movement;
- client receipt/queue/state transitions;
- planning/name/Git-context updates;
- subagent edges;
- transaction batch boundaries and injected proven rollbacks.

The oracle compares normalized incremental state with replay after every committed prefix, not only at the end.

### 11.5 Search parity and bounds

- generated token, phrase, regex, and fuzzy queries produce identical IDs and scores;
- phrases spanning chunk boundaries remain matches;
- canonical cwd aliases retain current filtering;
- search-all preserves global ranking and isolates unreadable stores;
- large non-searchable payload does not appear in search work;
- large searchable text reports token/phrase scaling by query count without whole-store accumulation, while regex is measured separately without a linearity claim;
- stale debounced selector results remain fenced by existing query sequence handling.

### 11.6 Static ownership audit

The implementation review should classify every internal `SessionManager.create/open/continueRecent/forkFrom/importFromJsonl` handoff. Transient read-only opens with immediate `try/finally close` may remain direct. Any manager passed into runtime/session setup must carry preparation origin through publication settlement.

The audit must also classify every identity-changing manager call and every host-internal session binding, pointer, coordinator/lease record, subagent edge, and delayed callback. Wrapped source managers are never mutated into target identities, and resolved persisted targets pin exact incarnation.

The audit should find no cleanup decision based solely on `sessionSelection.kind`, manager object equality, selector visibility, an ID-only binding, or a free-floating `published` boolean when the preparation capability is available.

## 12. Rejected alternatives

### 12.1 Keep adding local cleanup blocks

Rejected. It duplicates origin inference, publication timing, aggregation, and idempotence across each caller. The repeated fixes on #329 show that local compensation is not a stable contract.

### 12.2 Make `SessionManager` the runtime/daemon/subagent owner

Rejected. `SessionManager` owns persistence authority, not provider work, transports, leases, registries, or child execution. Expanding it would conflict with accepted ownership RFCs and make disposal more coupled.

### 12.3 Use `sessions.visible` as publication state

Rejected. Visibility is derived from content. Prepared setup can create visible planning/message state, and an adopted empty runtime can remain hidden. Conflating these states enables both leaks and unsafe deletion.

### 12.4 Delete every created row whenever setup returns an error

Rejected. An error can occur after registry, lease, relay, feed, or subagent publication. Deleting by creation origin alone can create a dangling externally published identity.

### 12.5 Preserve every created row on any error

Rejected. It is safe from delete-after-publication but guarantees abandoned hidden rows for ordinary caught setup failures. Typed preparation and publication outcomes distinguish the cases.

### 12.6 Auto-repair projection mismatch on open

Rejected. It can hide canonical corruption, race another writer, and make listing decisions depend on unverified repaired state. Fail closed and require an explicit future repair tool if real users ever need one.

### 12.7 Recompute summaries by replay on every write or list

Rejected. It restores `O(history)` saves or the exact discovery defect #328 is intended to remove.

### 12.8 Treat `search_chunks` as a full-text index

Rejected as inaccurate. The current index accelerates session/entry lookup, not arbitrary content matching. Fuzzy and regex semantics require scanning extracted text.

### 12.9 Add FTS as a transparent optimization now

Rejected. It cannot safely prefilter every current fuzzy/regex query without a complete fallback and expands schema/release complexity without changing the worst-case contract.

### 12.10 Reclaim crash-left prepared rows by age

Rejected. Durable prepared state distinguishes them from adopted selector-hidden recovery rows, but age does not prove owner death. The only automatic path is exact remote retry of a daemon-owned preparation after exclusive daemon authority proves the recorded boot/instance terminal; generic CLI/SDK recovery remains explicit future work.

### 12.11 Preserve old live-JSONL or SQLite layouts

Rejected. Volt has no users and #329 explicitly changes the storage/API contract in place. Compatibility machinery would obscure the new invariants.

### 12.12 Use session generation and revision alone as discard proof

Rejected. Another owner can open the same generation without advancing revision. Prepared rows therefore require a distinct durable state and opaque collision-resistant preparation ID, and normal open paths cannot resolve them.

### 12.13 Let ordinary `AgentSession.dispose()` finalize prepared candidates

Rejected. It closes persistence unconditionally, which conflicts with borrowed-manager preservation and duplicates created/opened cleanup. Persistence-close authority transfers only after adoption; prepared candidate finalization excludes manager close.

### 12.14 Treat first-prompt acceptance as session-row adoption after returning a child handle

Rejected. Returning a live handle or reference already exposes an owner that can act on the child. Public handle return adopts the row; only an internal operation that withholds the handle may keep rollback through prompt acceptance.

### 12.15 Keep host authority and durable bindings keyed by session ID alone

Rejected. Session IDs are reusable names. After resolution, host owners and bindings pin store ID/generation so delayed old-incarnation work cannot affect a replacement.

### 12.16 Keep a full duplicated entry envelope in `payload_json`

Rejected. Duplicate identity/classification fields create two possible truths. SQLite columns own the envelope and payload JSON contains only the exhaustively validated type-specific body.

## 13. Risks and mitigations

| Risk | Mitigation in the design |
| --- | --- |
| Preparation becomes another lifetime owner | Restrict it to origin-specific compensation; use a prepared candidate finalizer; transfer persistence-close authority once; settle immediately afterward. |
| Publication is in flight when cancellation/shutdown arrives | Explicit `publishing` state, rollback intent, mandatory typed finalizer, and lifecycle-owner join. |
| Adoption occurs too early and retains ordinary failed rows | Stage all fallible work and contingent canonical overlays before the cutoff; require typed definitive restoration. |
| Adoption occurs too late and deletes a published row | Commit durable adopted state before reachability; classify any unproven participant as uncertain/fail-preserve. |
| Another process opens a prepared row before discard | Normal list/find/open exclude prepared rows; mutation/discard require the preparation capability. |
| Borrowed manager is closed on SDK failure | Withhold persistence-close authority from the candidate and test post-failure writes. |
| Failed setup leaves model/planning/name entries in an opened session | Build against a preparation-local overlay and commit it once during adoption; close alone is never called rollback. |
| Created manager is closed but not deleted | Created rollback uses dedicated prepared-state/preparation-ID discard and verifies absence. |
| Cleanup deletes another writer's work | Prepared state, preparation ID, exact store/generation, and expected revision all participate in CAS. |
| Stale ID-only route reaches a recreated session | Pin exact incarnation in every host owner/binding after resolution and reject stale capabilities. |
| Candidate and manager both close persistence | Prepared candidate finalizer excludes persistence; authority transfers to `AgentSession` once. |
| Shared reducer becomes a large mutable god object | Keep it pure in semantics, split validation/helpers by projection family, and expose one composed state transition. |
| Incremental and replay share the same bug | Add explicit behavior examples plus property tests and persisted corruption tests; sharing establishes consistency, not semantic correctness by itself. |
| Open verification makes listing slow | Verify only the selected/opened session; list and exact summary lookup remain projection-only. |
| Search wording again overpromises | Put operation complexity in a normative table and benchmark searchable text separately. |
| Long regex blocks the store worker | Document as an accepted limitation under preserved semantics; revisit query language or worker separation in a separate design. |
| Process crash leaves a prepared or adopted hidden row | Durable state records the last proven cutoff; normal APIs reject prepared rows and no automatic GC guesses liveness. |
| Entry columns and payload disagree | Make columns the sole envelope authority, store body-only JSON, and validate every entry type before reduction. |
| Existing RFCs claim file/JSONL source of truth | This RFC uses current SQLite terms and is the normative session-storage amendment; later documentation work should update stale file-era prose without changing those RFCs' ownership decisions. |

## 14. Decision gates before implementation

The recommendations below require explicit acceptance during RFC review:

1. **Internal capability, unchanged public signatures.** Add `SessionManagerPreparation` to higher-level acquisition paths; direct public factories retain ownership, and a raw manager passed to `createAgentSessionRuntime()` is borrowed on proven no-effect construction failure.
2. **Durable prepared/adopted state.** Normal APIs cannot resolve a prepared row; adoption and prepared discard require commit evidence and an opaque collision-resistant preparation ID.
3. **Explicit publishing state and join.** Cancellation/shutdown cannot clean up until the sole publication attempt returns a typed outcome; timeout is process loss, not permission to delete.
4. **Single persistence finalizer.** Prepared candidate disposal excludes manager close; adoption transfers close authority exactly once to `AgentSession`/runtime.
5. **Fail-preserve uncertainty.** Any unproven publication or durable-routing outcome forbids deletion, even if that retains a hidden row.
6. **No age-based crash reclamation.** Permit only owner-proven exact remote retry reclaim for daemon-owned prepared rows; generic CLI/SDK prepared rows require a separate recovery design.
7. **Exact incarnation after resolution.** Host owners and durable bindings pin store ID/session generation while remote wire identities remain ID-based.
8. **Stage contingent writes.** Candidate setup uses a local canonical overlay; a proven no-effect failure leaves opened/borrowed state unchanged, while committed/uncertain state requires reopen.
9. **Column-authoritative entry envelope.** Store type-specific body JSON only and validate every reconstructed entry before reduction.
10. **Fail-closed projection mismatch.** Opening rejects drift and does not self-heal.
11. **One reducer, transaction-local staging.** Incremental and replay semantics share code; atomic work should move toward delta overlays rather than full-history projection recomputation.
12. **Preserve search semantics.** Deep search remains a token-parameterized/regex-unbounded scan with one-session accumulation; no FTS is added.
13. **No competing long-lived owner.** Existing delivery, runtime, conversation, lease, workspace, worktree, and subagent ownership contracts remain authoritative in their domains.

A reviewer should request changes to this RFC rather than infer a different choice during implementation.

## 15. RFC acceptance criteria

This RFC is ready to become an implementation plan only when reviewers can answer all of the following from the document without reading cleanup code:

- Who owns a newly created, opened, borrowed, imported, forked, continued, or branched manager before and after failure?
- How do durable prepared/adopted row state and process-local prepared/publishing/adopted/settled state compose?
- Why can no normal opener acquire a row while prepared discard remains possible?
- What exact event forbids deletion in CLI, SDK, replacement, daemon, relay, and subagent flows?
- How is an in-flight publication joined and classified as not published, published, or uncertain?
- Which finalizer disposes candidate resources before adoption, and which owner alone closes persistence after transfer?
- How does the preparation-local canonical overlay give candidate construction the intended policy without mutating an opened/borrowed log on a proven no-effect failure?
- When does returning a subagent handle adopt its row relative to first-prompt registry/activity publication?
- Which exact session incarnation is pinned by each runtime, lease, worktree/last-session binding, parent edge, and delayed callback?
- Why is selector visibility not lifecycle state?
- Which SQLite columns/body fields are canonical and what is derived?
- How do incremental reduction, atomic rollback, reopen replay, and persisted projection comparison compose?
- What happens when side indexes drift but foreign keys remain valid?
- Which operations avoid canonical entry payloads, how do materialized-summary bytes affect listing, and how do token count and regex semantics affect search cost?
- Which crash, regex CPU, distributed side-effect, and compatibility guarantees are explicitly not made?
- What tests and benchmarks prove each observable contract?

Until the user accepts these decisions and approves a separate implementation plan, the status remains **Proposed** and no product implementation is authorized.
