# RFC: SQLite Session Storage Merge Contract

- Status: Accepted; implemented
- Date: 2026-09-03
- Pull request: [#329](https://github.com/volt-hq/Volt/pull/329)
- Issue: [#328](https://github.com/volt-hq/Volt/issues/328)
- Package: `packages/coding-agent`
- Scope: merge-blocking storage work only; deferred designs are explicitly non-normative

Paths are relative to `packages/coding-agent/` unless stated otherwise. Symbol names are durable anchors; line numbers are intentionally omitted.

## 1. Decision

A successfully committed SQLite session row is immediately **adopted**. No SDK, CLI, runtime-replacement, remote, import, fork, or subagent setup failure automatically deletes that row.

The merge-blocking #329 design is limited to five corrections:

1. **Single manager finalization.** A high-level session/runtime factory consumes its `SessionManager` at invocation. Before `AgentSession` construction succeeds, the factory closes the manager on failure. After construction, only the `AgentSession`/runtime disposes it. No failure path both disposes a session and separately closes or discards its manager.
2. **Canonical entry validation.** The full validated `SessionEntry` in `payload_json` is canonical. SQLite envelope columns are derived indexes and must agree exactly on read, including ordinal and deterministic host-only classification. Every entry type is validated exhaustively before state changes.
3. **One projection reducer.** Incremental append and full replay share the same transition logic for session summaries, labels, client-input state, subagent edges, and search chunks.
4. **Projection verification.** Opening a session replays canonical entries and compares every retained materialized projection. Mismatch fails closed without automatic repair. Side tables with no indexed reader are removed.
5. **Bounded deep-search accumulation.** Listing and exact lookup remain summary-only. Deep fuzzy, phrase, and regex search preserves current behavior but processes one session document at a time instead of retaining an entire store's searchable text. Documentation states the real query-dependent cost and does not call this a full-text index.

The accepted tradeoff is deliberate:

> A failed setup may leave a hidden, or occasionally visible, session row. That is recoverable clutter. Deleting a committed row that another route or caller may already know is a correctness failure.

If failed-row reclamation later becomes a product requirement, durable preparation state, publication settlement, and crash recovery must be designed together in a separate RFC.

## 2. Why the earlier design was narrowed

The first revision proposed durable prepared/adopted rows, a cross-system publishing state machine, setup overlays, crash-owner recovery, and exact session-generation propagation through daemon/worktree/subagent state.

Those mechanisms can provide stronger cleanup guarantees, but they materially expand #329 into runtime, daemon, worktree, subagent, and public-construction lifecycle redesigns. Issue #328 requires session discovery to stop parsing cumulative transcript history; it does not require zero abandoned rows after every setup failure.

Removing automatic deletion collapses the dangerous lifecycle problem:

- another process opening the same generation without writing can no longer race a creator's cleanup deletion;
- durable worktree or last-session pointers cannot be left dangling by setup cleanup;
- a child handle can expose its session identity without later first-prompt failure deleting that identity;
- cancellation no longer needs a new cross-system publication state merely to decide whether deletion is safe;
- created and opened managers have the same failure cleanup: close the manager and preserve the row.

The remaining ownership problem is resource finalization, not row adoption. The implementation leaves existing owners in their established domains rather than wrapping them with another long-lived owner.

## 3. Scope

### 3.1 Goals

1. Make listing, exact lookup, continuation lookup, and remote enumeration independent of canonical transcript payload size.
2. Ensure every manager transferred into high-level construction has one eventual close path.
3. Preserve every committed session row unless an explicit user/host delete operation targets its exact reference and revision.
4. Reject malformed or internally contradictory persisted entries before changing live state.
5. Make retained summary/index state deterministic from canonical entries.
6. Detect projection drift when opening a selected session without replaying every session during listing.
7. Preserve current search matching and ranking while bounding worker accumulation to one session document.
8. Keep JSONL as strict explicit interchange only.
9. Preserve observable acceptance criteria for the implemented contract.

### 3.2 Non-goals

This RFC does not add or require:

- durable prepared/adopted row state or preparation IDs;
- automatic cleanup of failed or crash-left committed sessions;
- a new publication or rollback state machine spanning SQLite, daemon, relay, worktree, and subagent owners;
- transactional rollback of arbitrary SDK/runtime construction side effects;
- a universal canonical setup overlay;
- host-wide session-generation propagation through every lease, worktree binding, last-session pointer, or subagent record;
- transaction-local delta staging to remove all history-sized in-memory copies;
- FTS, changed fuzzy semantics, regex removal, search cancellation, or a separate search worker;
- changes to remote/mobile wire shapes or iOS code;
- live JSONL migration or SQLite backward compatibility;
- replacement of existing delivery, runtime, conversation, lease, workspace, worktree, or subagent ownership;
- implementation of any deferred design in §11 as part of #329.

### 3.3 Preserved core design

Keep:

- one `sessions.sqlite` store per workspace or custom session directory;
- one shared worker-backed client per store within a process;
- `SessionReference` with session directory, store ID, session ID, and immutable session generation;
- expected revisions, transaction commit IDs, canonical payload digests, and uncertain-outcome reconciliation;
- generation-fenced stale writes after delete/recreate;
- SQLite WAL, foreign keys, strict tables, trusted-schema disabling, and private filesystem permissions;
- current public `SessionManager` factory signatures;
- current fuzzy, phrase, regex, score, and modified-time tie-break behavior;
- session-ID-based remote protocol with existing authorized relative/synthetic path fields.

## 4. Session row adoption and manager ownership

### 4.1 Row adoption

A row becomes adopted when its creation transaction commits. Adoption does not depend on:

- selector visibility;
- message count;
- successful model/resource/extension setup;
- `AgentSession` construction;
- daemon registry activation;
- first prompt acceptance;
- worktree or last-session publication.

Once creation commits:

- normal exact lookup may resolve the row according to existing hidden-session rules;
- setup cleanup may close managers/runtimes but does not delete the row;
- caller-named retry may resume the same row;
- explicit deletion remains available through the existing exact-reference/revision contract;
- stale managers remain unable to write after delete/recreate because store/session generation and revision guards remain mandatory.

`SessionManager.discardPersistence()` is removed from construction/setup cleanup so future callers cannot reintroduce delete-after-publication heuristics.

### 4.2 Ownership states

The high-level ownership state is intentionally small:

```text
caller-owned manager
  -> factory-owned manager
       -> closed                         // construction failed before AgentSession
       -> AgentSession-owned manager
            -> closed                    // normal disposal or later failure
```

Rules:

1. Passing a manager to `createAgentSession()`, `createAgentSessionRuntime()`, runtime replacement, or subagent runtime creation consumes manager ownership at invocation.
2. The caller does not reuse that manager after either success or failure; it may reopen the stable reference if needed.
3. Until `AgentSession` construction returns, the factory owns manager close plus cleanup of every resource it created but has not transferred.
4. Once an `AgentSession` exists, that session is the sole persistence finalizer. Any still-untransferred service resource remains owned by the factory until attached or cleaned.
5. Later setup failure disposes the session and separately cleans only resources that were never transferred; it never separately closes the session's manager.
6. Close is idempotent, but idempotence is not permission to create multiple logical finalizers or discard cleanup errors.
7. Setup errors and all close/dispose errors that settle while the caller remains pending are preserved together in `AggregateError`. When attach cancellation returns before an uncancellable factory later produces a runtime, a failure disposing that late runtime is instead recorded as a failed `runtime_start_cleanup_failed` audit event because the cancellation caller has already settled.
8. No construction finalizer invokes session deletion.
9. Static/transient readers continue using scoped `try/finally` close and never transfer ownership to a runtime.

This is a deliberate SDK ownership clarification. The public function signatures remain unchanged. SDK documentation records—and must continue to state—that passing a manager transfers ownership immediately. A caller that needs another live manager opens a separate one.

### 4.3 Flow-specific ownership

| Flow | Manager owner before transfer | Transfer point | Failure behavior |
| --- | --- | --- | --- |
| CLI startup | `main.ts` startup scope | Invocation of the runtime factory | Validate flags first; close on pre-transfer exit; after transfer the factory/session owns close |
| `createAgentSession()` default manager | SDK factory | Successful `AgentSession` construction | Factory closes on early failure; session disposes on later failure; row retained |
| `createAgentSession()` supplied manager | Caller until invocation, then SDK factory | Successful `AgentSession` construction | Same as default manager; ownership is consumed |
| Public `createAgentSessionRuntime()` | Caller until invocation, then runtime factory | Successful candidate `AgentSession` construction | Close before construction; dispose session afterward |
| Runtime new/resume/fork/import | Serialized `AgentSessionRuntime` lifecycle operation | Successful candidate `AgentSession` construction | Candidate manager closes or candidate session disposes; row retained |
| Remote target/runtime creation | Remote runtime factory/registry preparation | Successful candidate `AgentSession` construction | Selection kind remains response metadata, not delete policy; close/dispose only |
| TUI relay target inspection | Relay setup scope | None; manager is temporary | Always close after reading target cwd/reference; row retained |
| Subagent start | `SubagentManager` after invocation | Successful child `AgentSession` construction | Returned handle/runtime later owns disposal; first-prompt failure never deletes the row |
| Static list/search/export/read helper | Scoped helper | None | `try/finally` close/release |

### 4.4 CLI acquisition requirements

`main.ts` implements these acquisition requirements:

1. synchronous flags and `--name` syntax are validated before acquiring a manager;
2. one top-level finalizer is installed immediately after acquisition;
3. direct `process.exit()` is not used while that scope owns an unsettled manager;
4. missing-cwd choice is resolved before final runtime transfer;
5. when reacquisition is unavoidable, the first manager is closed before assignment of the replacement;
6. the committed row is preserved even when startup is cancelled or runtime creation fails.

No created/opened classification is required because both outcomes close and retain the row.

### 4.5 Failure matrix

| Scenario | Manager result | Session row result |
| --- | --- | --- |
| SQLite creation transaction fails | Factory releases worker lease | No committed row |
| Creation commits; later setup fails before `AgentSession` exists | Factory closes manager | Row retained |
| Existing session open; setup fails before `AgentSession` exists | Factory closes manager | Existing row retained |
| Supplied manager; setup fails before `AgentSession` exists | Factory closes consumed manager | Row retained; caller may reopen reference |
| `AgentSession` exists; later setup/hook/registration fails | Dispose session only | Row retained |
| Remote worktree/last-session/registry step commits then later fails | Existing daemon owner compensates or retires its own state; runtime closes | Row retained, so no dangling route points to a deleted identity |
| Subagent handle returns, then first prompt fails | Handle/runtime disposes according to current subagent contract | Row retained |
| Persistence transaction is proven rolled back | Manager follows existing authority rules | Prior row state retained |
| Persistence outcome is uncertain | Manager becomes reconciliation-required and closes/fail-stops | Row retained; fresh manager reopens authoritative state |
| Explicit user/session-selector delete | Close active manager, export recovery snapshot when applicable, then exact conditional delete | Row deleted only on matching store/generation/revision |
| Stale manager writes after delete/recreate | Generation/revision check rejects and retires stale authority | Replacement row preserved |
| Process terminates during setup | OS/worker cleanup eventually releases process resources | Any committed row remains |

## 5. Canonical entry contract

### 5.1 One canonical representation

The full validated entry object stored in `entries.payload_json` is canonical. It includes its persisted ordinal and all public or host-only type-specific fields.

SQLite envelope columns are derived indexes:

```text
session_id
entry_id
ordinal
parent_entry_id
entry_type
timestamp
is_host_only
```

The write protocol carries one canonical entry value rather than independently caller-selected envelope fields. The worker derives indexed columns from the validated entry.

On load:

1. parse canonical JSON;
2. validate the complete entry schema;
3. derive the expected envelope;
4. compare every stored column exactly;
5. reject any mismatch before reduction.

Canonical payload, row-value, or envelope disagreement during open is reported as `session_store_entry_integrity` with the fixed bounded message `Session store canonical entries are invalid or inconsistent`. The worker retains the underlying cause internally while exposing only that code and message across its protocol.

`session_id` comes from the containing row/transaction. `is_host_only` is deterministic from entry type and cannot be chosen by payload data. A stored ordinal is required and must be a positive contiguous safe integer.

Keeping the full entry payload avoids an unrelated body-only storage redesign while still establishing one source of truth.

### 5.2 Exhaustive entry validation

One shared codec module is used by `SessionManager`, the store protocol/worker, and JSONL import/export where applicable. It has an admission form that validates a new entry before ordinal assignment and a persisted form that requires the assigned ordinal and exact SQL-envelope parity. Both use the same type-specific body schemas. It validates every current entry type:

- message;
- client-input receipt, queued payload, and state;
- thinking, Fast mode, model, and planning state changes;
- compaction and branch summary;
- custom and custom-message entries;
- label and session-info entries;
- starting Git context;
- durable leaf;
- subagent spawn.

Required validation includes:

- exact allowed fields with unknown-field rejection;
- canonical lossless JSON values;
- valid IDs and required strings;
- canonical ISO entry timestamps and representable message timestamps;
- valid message role/content shape;
- valid thinking/Fast/planning values;
- finite numeric fields and bounded persisted error/input values;
- parent references to an earlier entry in the same session;
- compaction `firstKeptEntryId` on the compaction's active ancestor path;
- leaf and label targets that exist and are eligible;
- client-input receipt/digest/queue/state/canonical-entry consistency;
- at most one valid starting Git context entry;
- complete, generation-pinned parent/child session references where present;
- deterministic host-only classification.

Validation and canonical cloning happen before mutating arrays, maps, ordinals, leaf state, derived projections, persistence queues, or observers.

Unknown future entry types require an explicit schema and reducer update in the same change. Extension-defined payloads remain supported through the known `custom` and `custom_message` entry envelopes.

### 5.3 JSONL snapshots

JSONL remains explicit interchange, not live storage.

Snapshot import:

- requires the current entry and snapshot versions;
- validates the header and every entry through the same canonical codec;
- rejects host-only entries and transport-owned client message identities;
- validates leaf, parent, compaction, label, and branch references before creating/importing durable state where practical;
- never installs a compatibility reader for old formats.

Snapshot export reconstructs the current full public entry envelope, removes transport-owned identities, excludes host-only state, and appends one final leaf record.

A failed import after a row has committed closes the manager and retains the row. Up-front validation and a single initial transaction minimize that case; automatic deletion is still forbidden.

## 6. Materialized projection contract

### 6.1 Retained and removed projections

Retain only projections used by indexed operations:

| Projection | Why retained |
| --- | --- |
| `sessions.updated_at`, Git-context fields, `name`, `visible`, `leaf_entry_id`, `message_count`, `first_message` | Listing, exact summary, continuation, and remote enumeration |
| `client_inputs` | Pending/ambiguous input continuation lookup without transcript replay |
| `search_chunks` | Deep text search without parsing canonical entry JSON |
| `transaction_commits` | Commit-outcome reconciliation; evidence rather than a conversation projection |

Remove:

- `labels` table and index;
- `subagent_spawns` table and index.

Current code reads labels and subagent edges from canonical entries after opening a session. No indexed list/search/lookup path consumes their duplicate tables. Removing unused projections is safer than maintaining and verifying redundant state for hypothetical future queries.

If a future feature needs an indexed label or child lookup, it adds the projection with a concrete reader, reducer rule, and verification test in the same change.

The resulting schema contains only `store_metadata`, `sessions`, `entries`, `client_inputs`, `search_chunks`, and `transaction_commits`.

### 6.2 One reducer

The implementation uses one composed derived-state reducer. Illustrative shape:

```ts
interface SessionDerivedState {
  summary: SessionSummaryAccumulator;
  labels: ReadonlyMap<string, SessionLabelState>;
  clientInputs: ReadonlyMap<string, ClientInputRecord>;
  subagentSpawns: readonly SubagentSpawnEntry[];
  searchChunks: readonly SessionStoreSearchChunkWrite[];
  leafId: string | null;
  nextOrdinal: number;
}

function createSessionDerivedState(header: SessionHeader): SessionDerivedState;
function applySessionEntry(state: SessionDerivedState, entry: SessionEntry): void;
function replaySessionEntries(header: SessionHeader, entries: readonly SessionEntry[]): SessionDerivedState;
```

Controlled mutable builders are acceptable for performance. The semantic transition for one entry must still be shared by:

- initial/reopen replay;
- ordinary append;
- atomic append staging;
- import/fork construction;
- transaction projection generation.

`_storePayload()` must not independently reinterpret labels, client input, subagent edges, or search eligibility.

### 6.3 Projection semantics

The reducer preserves current intended behavior:

- message count includes persisted message entries and displayed custom messages under current semantics;
- first message prefers the first user text, otherwise the first eligible assistant/displayed-custom fallback;
- a later first user can replace a fallback after reopen;
- modified time derives from existing user/assistant/displayed-custom activity rules and does not change on attach/detach;
- latest trimmed non-empty session name wins and an empty name clears it;
- visibility follows existing message/planning policy and is unrelated to setup success;
- public appends and durable leaf records determine the active leaf;
- starting Git context is absent versus recorded-null versus recorded-value;
- label clearing treats empty/absent labels consistently in live and replay state;
- client-input state preserves receipt limits, semantic digest, queue ordering, terminal states, and ambiguity fences;
- subagent edges remain canonical host-only entries;
- search chunks contain only eligible user/assistant text and displayed custom-message text in deterministic entry order.

### 6.4 Transaction behavior

Each session transaction commits together:

- canonical entries;
- the complete updated session-summary projection;
- affected `client_inputs` rows;
- new `search_chunks` rows;
- session revision increment;
- commit evidence.

Existing expected-revision, session-generation, commit-ID, digest, and reconciliation behavior remains authoritative.

Incremental projection calculation must not replay full history for every append. This RFC does not require replacing the current full-history array/map snapshots used by some atomic operations; delta/undo staging is deferred until a dedicated benchmark demonstrates that it is necessary.

### 6.5 Open-time verification

`SessionManager.open()` already loads one selected session's row, canonical entries, client-input rows, and search chunks. Before returning a live manager it must:

1. validate and reconstruct every canonical entry;
2. replay one derived state;
3. normalize retained persisted projections into deterministic order;
4. compare every derived summary field, client-input row, and search chunk;
5. reject with a stable store-integrity error on any mismatch;
6. release its temporary store lease on failure.

It must not repair automatically.

Reasons:

- mismatch may be canonical corruption rather than stale cache;
- repair can race another writer and hide revision conflicts;
- strict failure makes transaction/reducer defects observable;
- Volt has no released SQLite store requiring compatibility repair.

Routine list, search, exact summary lookup, and continuation candidate selection continue using materialized rows. Replaying every session there would recreate issue #328. A chosen continuation candidate is verified when its snapshot is opened; verification failure does not silently create a replacement idempotency domain.

### 6.6 Incremental/replay property

Normative property:

> For any valid header, valid ordered entry sequence, and partition into legal committed transaction batches, incremental reduction produces exactly the same normalized derived state as replaying the final canonical entry sequence.

Also require:

- a proven rolled-back batch has no effect;
- reopen after each committed prefix equals live incremental state at that prefix;
- import/fork rewriting preserves derived behavior for rewritten canonical entries;
- corrupting any retained projection while foreign keys remain valid makes open fail;
- one corrupt/unreadable store does not hide healthy sessions in other stores during global enumeration.

## 7. Search contract

### 7.1 Operation classes

Let:

- `S` = candidate/returned session count;
- `M` = materialized summary bytes;
- `B` = eligible searchable text examined;
- `Q` = query bytes/characters processed;
- `F` = fuzzy-token count.

| Operation | Data read | Contract |
| --- | --- | --- |
| List one store | Session summary rows | `O(S + M)`; no canonical entry/search text read |
| List all stores | Directory enumeration and each store's summaries | `O(stores + S + M)`; no canonical entry/search text read |
| Exact reference/ID lookup | Indexed session identity and one summary | No canonical entry/search text read; `open()` separately loads and verifies one transcript |
| Continue recent | Summary and indexed pending-input metadata | No canonical transcript payload read before chosen-session open |
| Remote `list_sessions` | Summaries plus bounded remote-safe projection | No canonical entry/search text read |
| Fuzzy/phrase search | Metadata plus eligible search chunks | Parsing `O(Q)`; fuzzy scans `O(F × B)`; phrase substring cost also depends on query length |
| Regex search | Same extracted document | Document/query construction is bounded by `Q + B`; JavaScript RegExp compile/match has no general time bound |

Summary strings such as `name`, `first_message`, and cwd contribute to `M`. The guarantee is independence from cumulative canonical transcript payload, not zero cost per summary byte.

### 7.2 One-session accumulation

Before #329, the worker loaded every matching store chunk row with `.all()`, retained a `chunksBySession` map, then joined each session document.

The implemented worker:

1. obtains candidate summaries;
2. iterates eligible chunks ordered by session and chunk index;
3. accumulates one session document;
4. scores and releases that document before continuing;
5. retains only summaries and scored results needed for final sorting.

Expected worker-owned memory:

```text
O(materialized summaries + result summaries + query/parser state
  + largest one-session searchable document and normalization copies)
```

It is not `O(all searchable text in the store)`.

Cross-store search remains sequential. This is a memory guarantee, not a latency guarantee. A large or pathological regex can still block the shared store worker; regex isolation or removal requires a separate search design.

### 7.3 Preserved matching behavior

Preserve:

- whitespace-separated fuzzy tokens;
- quoted phrases, including matches spanning adjacent chunks after space joining;
- `re:` JavaScript regex mode;
- fuzzy score and alphanumeric-swap behavior;
- session ID, latest name, cwd, and extracted message text in the document;
- score ordering and modified-time tie-break;
- visibility and canonical-cwd filtering;
- global score merge across stores;
- selector request sequencing that ignores stale debounced results.

No docs or PR text may claim that deep search is independent of searchable text size or that `search_chunks` is a full-text content index.

### 7.4 Why not FTS

[Node 22.16.0 enabled SQLite FTS5](https://nodejs.org/en/blog/release/v22.16.0), and Volt's supported versions are newer. Availability does not make FTS transparent:

- subsequence fuzzy matching does not require contiguous lexical terms;
- phrases currently span message chunks;
- arbitrary JavaScript regex cannot be represented by FTS;
- preserving exact behavior still requires a complete fallback;
- FTS virtual/shadow tables add schema and release complexity without changing the worst-case contract.

FTS belongs in a later query-language design, not #329.

### 7.5 Benchmark dimensions

The repository benchmark contract requires these dimensions to be reported independently:

1. session count;
2. store count;
3. materialized-summary/first-message bytes;
4. non-searchable canonical payload bytes;
5. searchable text bytes per session and per store;
6. query bytes, fuzzy-token count, phrase count/length, and regex pattern size;
7. cold versus warm list, exact open, and search;
8. elapsed time and heap delta.

The benchmark remains observational unless a later plan establishes reproducible same-host thresholds. Large unsearched custom data is evidence for listing independence, not deep-search independence.

## 8. Ownership and protocol composition

This RFC preserves existing owners:

| Owner | Responsibility retained |
| --- | --- |
| `SessionManager` | Canonical session state, persistence queue, revision/generation authority, and reconciliation |
| `AgentDeliveryOwner` | One logical delivery's canonical settlement and verified receipt |
| `AgentSession` / `AgentSessionRuntime` | Active agent resources, structural replacement, and eventual manager close |
| `ConversationProjectionFeed` | Live materialized conversation projection and atomic source/subscriber cuts |
| `ConversationCoordinator` | Daemon conversation runtime and transport terminal retirement |
| `LeaseBroker` | Process-level conversation lease ownership |
| Existing Iroh admission/attach owners | Current workspace/client authority checks pending any separately accepted workspace-authority RFC |
| `WorktreeManager` | Worktree checkout and binding state |
| `SubagentManager` and handle/registration owners | Child admission, registry/activity publication, and runtime lifetime |

This document does not introduce `SessionManagerPreparation` or `PreparedConversationActivation` as a merge requirement.

Storage terminology amendments:

- references to a live session file in [live shared sessions](live-shared-session-daemon-design.md) mean the authoritative SQLite row plus ordered entries;
- references to WAL-only session files in [atomic conversation bootstrap](conversation-bootstrap-design.md) mean selector-hidden SQLite rows resolved by ID/reference;
- worktree sessions remain in the parent workspace store with their effective worktree cwd as described by [worktrees design](worktrees-design.md);
- the [workspace authority lifecycle](workspace-authority-lifecycle-design.md) remains Proposed and is not a prerequisite for #329;
- subagent registry/activity publication remains first-prompt-based, while the committed child row itself is retained after any later failure.

### 8.1 Path and privacy boundary

- SQLite directories, store IDs, session generations, and parent store locators remain host-local.
- Existing remote session surfaces may carry relative `workingDirectory`, `worktreeId`, and synthetic `/workspace` mappings.
- No SQLite locator is added to remote responses.
- Remote errors caused by entry/projection integrity failures expose stable bounded messages, not raw payloads, client input, provider data, or new host paths.
- Explicit local JSONL interchange may carry the documented local parent locator; this does not widen remote behavior.

## 9. Implementation record

The implementation was delivered in the following five phases. Their required results remain normative.

### Phase 1: manager ownership and fail-preserve cleanup

Primary files:

- `src/main.ts`;
- `src/core/sdk.ts`;
- `src/core/agent-session-runtime.ts`;
- `src/core/agent-session.ts` only where needed to enforce one finalizer;
- `src/modes/rpc/iroh-remote-agent-runtime.ts`;
- `src/daemon/integrated-runtimes.ts`;
- `src/core/subagents/manager.ts`.

Required result:

- setup cleanup never calls session deletion;
- factory ownership is explicit from invocation;
- before session construction, manager and untransferred construction resources close once;
- after session construction, session disposal is the only manager finalizer and the factory cleans only untransferred resources;
- CLI reacquisition closes the superseded manager;
- remote selection kind no longer selects close versus delete;
- failed created rows remain exact-openable/hidden according to their content;
- original and cleanup errors remain observable, including an audited failure when a cancelled attach's runtime materializes only after its caller has settled.

### Phase 2: canonical entry codec

Primary files:

- `src/core/session-entry-codec.ts`;
- `src/core/session-manager.ts`;
- `src/core/session-store/{types,protocol,worker}.ts`;
- JSONL import/export paths.

Required result:

- one full canonical entry drives SQL envelope columns;
- every entry type rejects malformed and unknown fields;
- column/payload ordinal, ID, parent, type, timestamp, and host-only classification agree exactly;
- malformed canonical rows and envelope disagreement use the stable `session_store_entry_integrity` classification;
- dangling/invalid references reject before state mutation;
- the current deterministic compaction CI regression asserts the authoritative validation boundary rather than obsolete later text.

### Phase 3: projection reducer and schema simplification

Primary files:

- `src/core/session-store/projection.ts`;
- `src/core/session-manager.ts`;
- `src/core/session-store/{schema,types,protocol,worker}.ts`;
- projection/store tests.

Required result:

- incremental and replay state use one transition path;
- `labels` and `subagent_spawns` duplicate tables/indexes are removed;
- session summary, `client_inputs`, and `search_chunks` commit with canonical entries;
- open compares replay with every retained projection and fails closed;
- list/exact lookup remain summary-only;
- label clearing and imported/forked projection behavior are identical before and after reopen.

### Phase 4: search scan and contract wording

Primary files:

- `src/core/session-store/worker.ts`;
- session search/selector tests;
- `benchmarks/session-listing.ts`;
- README, usage/session/SDK docs, PR description, and primary SQLite changeset.

Required result:

- result IDs, order, and scores remain identical;
- phrase matching across chunks remains intact;
- worker accumulation is bounded to one session document;
- docs distinguish summary indexes from deep-text scanning;
- unsupported performance claims are removed.

### Phase 5: integrated acceptance

The continuing verification requirement is to run modified focused tests, then `./test.sh` and `npm run check` under repository rules. Build/package smoke testing requires separate explicit authorization.

## 10. Verification contract

### 10.1 Ownership tests

Cover:

- default and supplied SDK manager failure before session construction;
- failure after session construction, proving only session disposal closes persistence while untransferred services still clean up;
- direct `createAgentSessionRuntime()` ownership transfer;
- CLI invalid flag/name before acquisition;
- CLI missing-cwd cancel and manager replacement;
- runtime new/resume/fork/import failure at pre- and post-session boundaries;
- remote created/resumed setup failure without selection-based deletion;
- late remote cleanup retaining the row and auditing any detached disposal failure;
- public subagent handle return, first-prompt failure, and resumed-handle disposal failure;
- close/dispose failure aggregation;
- explicit delete remaining generation/revision conditional.

Observable assertions include manager closed or reopened, row retained or explicitly deleted, and exactly one logical finalizer. Tests do not assert implementation source text.

### 10.2 Canonical entry tests

For every entry type:

- valid round trip;
- unknown and missing fields;
- noncanonical JSON values;
- invalid timestamps/numbers/modes;
- each envelope-column mismatch;
- wrong host-only classification;
- duplicate IDs and noncontiguous ordinals;
- forward/missing/cyclic parents;
- invalid compaction, leaf, label, client-input, and subagent references;
- strict JSONL import/export parity.

Corruption rejection must release the store lease and leave other sessions/stores usable. Malformed canonical payloads, invalid row values, and valid payload/envelope mismatches all use the exact `session_store_entry_integrity` code and bounded message defined in §5.1.

### 10.3 Projection tests

Deterministic cases:

- summary fallback later replaced by first user text;
- stable modified time;
- planning visibility;
- name set/clear;
- absent versus recorded-null Git context;
- branch movement versus retained-branch fork;
- label set/clear and immediate fork/import;
- client-input receipt/queue/terminal/ambiguity state;
- subagent edges from canonical entries;
- search eligibility and chunk order;
- proven atomic rollback and uncertain reconciliation.

Property oracle with deterministic `fast-check` seed:

> For every generated valid operation sequence and every legal transaction partition, incremental derived state equals replayed state after each committed prefix. Injected proven rollbacks are equivalent to omitting their batches.

Directly corrupt each retained summary/client-input/search projection while preserving foreign keys; open must fail closed without repair.

### 10.4 Search tests

- generated parity against the current matcher for fuzzy, phrase, regex, metadata, and score ties;
- phrases spanning chunk boundaries;
- cwd alias and visibility filtering;
- global ranking and unreadable-store isolation;
- independent growth of summary, non-searchable, and searchable bytes;
- independent growth of query bytes/token/phrase count;
- one-session rather than whole-store accumulation;
- stale selector request suppression.

Regex tests verify parity and bounded test fixtures, not a false general latency guarantee.

### 10.5 Completion definition

#329's corrective implementation is complete only while all of these conditions remain true:

- no setup cleanup automatically deletes a committed session;
- each transferred manager has one finalizer;
- every canonical entry is exhaustively validated and agrees with its SQL envelope;
- only concretely consumed projections remain;
- incremental and replay projection state agree;
- open rejects every retained projection mismatch;
- list/exact/continuation discovery remains summary-only;
- deep search retains at most one session document and preserves matching/ranking;
- docs and PR claims state the real complexity;
- focused tests, `./test.sh`, and `npm run check` pass or unrelated failures are reported.

## 11. Deferred follow-up designs

These are not merge requirements for #329.

### 11.1 Failed-session reclamation

Only pursue if retained failed rows become a real product problem.

Required dependency order:

1. define which failed rows are safe to remove;
2. define durable prepared/adopted state;
3. define typed publication settlement across every route that can expose an ID;
4. define crash-owner/liveness proof and caller-named retry;
5. define explicit operator recovery;
6. then permit conditional prepared-row deletion.

Implementing only the deletion step is unsafe.

### 11.2 Transactional runtime construction

A separate SDK/runtime RFC may define success-only borrowing, candidate views, setup overlays, and rollback of canonical startup mutations. It must acknowledge that arbitrary extension imports, MCP startup, filesystem work, and other external effects cannot be universally rolled back.

### 11.3 Host-wide session incarnation routing

Core SQLite writes already prove store ID and session generation. Propagating incarnation identity through every daemon lease, coordinator, worktree binding, last-session pointer, subagent index, and delayed callback is a broader availability/routing design. Start it only from a concrete stale-routing defect and preserve the ID-based wire contract deliberately.

### 11.4 Long-session mutation staging

Profile `appendAtomically()`, canonical projection receipts, and delivery commits independently. Replace full-history snapshots with delta/undo staging only under a benchmark-backed performance design. Do not conflate this with summary-only discovery.

### 11.5 Search redesign

Regex isolation/cancellation, FTS, a different fuzzy language, result limits, or intentionally incomplete candidate modes require a separate search contract.

### 11.6 Workspace authority and ownership API consolidation

The proposed workspace-authority coordinator and optional `PreparedConversationActivation` remain separate designs. Neither is required to make SQLite session discovery correct.

## 12. Rejected alternatives

### 12.1 Keep automatic setup deletion with local heuristics

Rejected. Generation and revision do not prove that another owner has not opened or learned the same committed row. Selection kind, manager identity, visibility, and free-floating `published` booleans are not safe delete authority.

### 12.2 Add durable preparation state now

Rejected from #329's merge scope. It solves failed-row cleanup but creates schema, cross-process open, caller-named retry, crash recovery, and composite publication requirements disproportionate to issue #328.

### 12.3 Preserve every duplicate projection table

Rejected. A materialized projection needs a concrete indexed reader. Unused label/spawn tables create drift and validation work without serving discovery.

### 12.4 Store body-only payload JSON

Rejected from the merge slice. It is clean but unnecessary. Keeping one exhaustively validated full entry canonical and treating columns as checked indexes resolves the ambiguity with less churn.

### 12.5 Auto-repair projection drift

Rejected. Repair can hide canonical corruption and race another writer. Fail closed; add an explicit repair tool only if released user data later requires one.

### 12.6 Recompute summaries on every write or list

Rejected. It restores history-sized writes or the exact discovery defect #328 is intended to remove.

### 12.7 Add FTS transparently

Rejected. Existing fuzzy, cross-chunk phrase, and regex semantics still require fallback scanning, so FTS does not remove the worst-case contract.

### 12.8 Replace existing lifecycle owners

Rejected. The manager ownership rule concerns close responsibility only. Delivery, runtime, conversation, lease, worktree, and subagent owners remain authoritative in their existing domains.

## 13. Accepted decisions

Reviewers accepted these eight decisions:

1. A committed session row is immediately adopted and setup cleanup never deletes it.
2. Passing a manager to a high-level session/runtime/subagent factory consumes ownership at invocation.
3. Before `AgentSession` construction the factory closes; afterward only the session/runtime disposes.
4. Full validated `payload_json` is canonical and every SQL envelope column is derived and checked.
5. Remove duplicate label and subagent-spawn tables because no indexed reader consumes them.
6. Use one reducer and fail-closed open verification for retained projections; defer delta staging.
7. Preserve search semantics, bound accumulation to one session, state query-dependent cost honestly, and do not add FTS.
8. Defer durable preparation, crash reclaim, universal setup overlays, host-wide incarnation propagation, and new cross-system ownership state machines.

These decisions are accepted and implemented. Changing them requires a follow-up RFC.
