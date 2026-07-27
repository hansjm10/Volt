# Design: Durable subagent spawn graph and lazy result recovery

> **Status: in progress (2026-07-27).** Tracking issue: #129. §§1-4 are
> implemented with regression tests (`129-subagent-spawn-entries.test.ts`,
> dispose suite, `agent-session-subagent-recovery-notice.test.ts`).
> Deviations: §2 sources linkage from the durable spawn edges rather than the
> tool's live activity (same data, already durable, no coupling to tool
> internals); §3 does not rehydrate delegation-scope usage (scopes are
> per-tool-call — see the corrected bullet) and maps statuses onto the
> existing union with a `hydrated` marker; §4's notice dedupe is durable via
> the persisted notice itself (in-memory `claimed` flags need not survive
> restarts), the notice is injected into live agent state at the turn-start
> seam (`_runAgentPrompt`) so the appending process's model sees it, child
> runtimes are gated out (they share the root registry), and stranded edges
> carry a `stranded` marker that excludes them from the notice. §5 is
> implemented as a `resume` mode on both the subagent tool's registry modes
> and the standalone `subagent_registry` tool (follow-gated): `claimResume`
> atomically removes the interrupted record so the run re-registers under its
> original id through the live pipeline, a start failure restores the record,
> and no dedup preflight applies. Known skews: after a resume the registry
> record's task shows the continuation prompt, and the original spawn edge
> stays unsettled — a later restart hydrates the now-completed child as
> completed-unclaimed, a benign re-offer suppressed by the notice dedup when
> previously offered. Prior art: Codex
> CLI persists parent→child spawn edges in a SQLite `agent_graph_store` and
> resumes whole descendant trees from rollout files on session resume
> (`resume_agent_from_rollout`, lazy `ensure_v2_agent_loaded`); OpenCode makes
> children ordinary resumable sessions keyed by `parent_id`. This design adapts
> the same idea to Volt's JSONL-transcript idiom: the transcript is already the
> durable store, so spawn edges become session entries rather than a second
> database.

## Problem

Subagent runtimes are in-process and all spawn bookkeeping is in-memory. When
the process dies or a runtime is disposed mid-turn, completed child work that
was not yet settled into the parent transcript is unreachable: the parent has
no durable record of which children it spawned, and nothing ever reads a
finished child's transcript back.

Incident (2026-07-11, session `019f527f-e435…`): a parallel `subagent` call
spawned three audit children under the daemon. The user opened the session in
the terminal TUI mid-turn; the daemon→TUI handoff disposed the runtime. All
three children completed successfully, but no toolResult was ever persisted,
the subagent tree rendered empty, and on the next prompt the model was told the
call "returned without results". The three reports were recovered only by
manually hunting child JSONL files by timestamp.

Mitigations shipped the same day made the loss *bounded and visible*, not
recoverable:

- LeaseBroker drains any mid-turn runtime before TUI handoff instead of
  abandoning it.
- `AgentSession.dispose()` persists an aborted toolResult for every dangling
  toolCall (`_persistAbortedResultsForDanglingToolCalls`,
  `packages/coding-agent/src/core/agent-session.ts:1411`).
- `LocalSubagentHandle.dispose()` aborts still-unsettled children so retained
  daemon children cannot run headless.

Bounded loss is still loss: aborting a child discards its spent tokens, and a
child that already finished cleanly still has no path back to its parent.

### Verified evidence (read on 2026-07-27, HEAD `1d38cc31`)

All paths under `packages/coding-agent/src`.

- `SubagentRegistry` is memory-only: no persist/load anywhere in
  `core/subagents/registry.ts`; the registry is owned lazily by the root
  manager and shared by reference (`core/subagents/manager.ts:650-656`).
- Child session ids reach the parent transcript **only on clean settlement**:
  the settled toolResult's details carry `childSessions`
  (`core/tools/subagent.ts:908-942`, `:1012-1034`). Mid-flight, the linkage
  lives in throttled `onUpdate` partials that are never persisted.
- The dispose-time synthesized aborted toolResult is text-only — no details,
  no child session ids (`core/agent-session.ts:1425-1444`). After a mid-turn
  dispose the parent transcript contains zero linkage to spawned children.
- Child transcripts do persist the **reverse** edge: separate JSONL files with
  `origin: "subagent"` and `parentSession` (`core/subagents/manager.ts:1176-1185`,
  header fields `core/session-manager.ts:53-71`) — but discovering a parent's
  children requires scanning every session file in the directory.
- Nothing reloads: runtimes are created only by live spawn
  (`core/subagents/manager.ts:893-1044`); after a restart the daemon's
  attachable child conversation entries are gone, and detached children are
  reaped by TTL (`daemon/integrated-runtimes.ts:936`).
- Delegation-scope usage (turns/tokens/cost,
  `core/subagents/delegation-scope.ts`) resets to zero on restart.

## Goals

1. A parent transcript is self-sufficient: from it alone (plus the child files
   it names), the full spawn tree, each child's terminal state, and each
   child's report are recoverable after process death.
2. A completed child's report reaches the parent even when the parent runtime
   died before settlement — without re-running the child.
3. `subagent_registry` list/follow work across restarts.
4. An interrupted child can be resumed lazily instead of restarted from
   scratch.

Non-goals: inter-agent messaging / follow-up channels to running children
(separate design), persistence of dedup confirm leases (in-memory 5-minute TTL
is correct), cross-tree registries beyond one session tree.

No backward-compatibility constraints: session formats change in place per the
no-legacy policy.

## Design

### 1. Spawn edges as session entries

Add a `subagent_spawn` entry type to the session JSONL union (alongside
`compaction`, `model_change`, …). The parent's `SessionManager` appends one per
task at the existing two-phase publish commit point
(`core/subagents/manager.ts:966-982`) — i.e. only after the child's first
prompt is accepted, so ghost spawns (regression #56) never produce entries.

```jsonc
{
  "type": "subagent_spawn",
  "id": "…", "parentId": "…", "timestamp": "…",
  "toolCallId": "…",          // the parent toolCall this task belongs to
  "subagentId": "sa_…",
  "agent": "security-reviewer",
  "childSessionId": "…",
  "childSessionFile": "…",     // absolute path at spawn time
  "requestKey": "…"            // createSubagentSpawnRequestKey hash (dedup key)
}
```

Persistence-only: never part of model context, projected to clients only
through the existing allowlists. Edge state is derived, not stored: a spawn
entry whose `toolCallId` has a toolResult produced by the tool itself is
settled; one without is in-flight or interrupted, and a dispose-time
synthesized aborted result does not settle an edge (§4). No terminal entry, no
rewrite of an append-only file.

If the parent session is unpersisted (in-memory child of an in-memory parent),
entries are skipped — recovery scope is persisted trees, same as today's
transcripts.

### 2. Dispose-time linkage

`_persistAbortedResultsForDanglingToolCalls` attaches `childSessions` details
to the synthesized aborted result for `subagent` toolCalls, rebuilt from the
durable spawn edges of §1, so even the abort path keeps the transcript's tool
row attachable. Call-level state only: children are marked `aborted` from the
parent call's perspective; each child's true terminal state is derived by
hydration from its own transcript. (For a hard crash, dispose never runs — the
`subagent_spawn` entries alone carry the linkage.)

### 3. Registry hydration

On first registry access after a session load (root manager creation with a
loaded `SessionManager`), hydrate `SubagentRegistry` from the transcript tree:

- Walk `subagent_spawn` entries of the parent (and, recursively, of child
  transcripts — grandchildren registered their own spawn entries).
- For each edge without a settled toolResult, read the child transcript's tail:
  - final assistant message + terminal stop reason → record status
    `completed-unclaimed` with the report text (existing 50 KB truncation);
  - transcript ends mid-turn → status `interrupted`.
- Delegation-scope usage is NOT rehydrated (correction during implementation):
  scopes are per-delegation-tool-call objects, so after a restart there is no
  live scope to rehydrate into. A §5 `resume` reserves against a fresh scope
  like any new start.

`follow` on a hydrated terminal record returns immediately with the persisted
result (today it awaits live settlement, `core/subagents/registry.ts:304-375`);
`follow` on `interrupted` returns the last persisted state instead of hanging.
Deadlock detection is unaffected — hydrated records have no live waiters.

Implementation mapping (landed with §3): hydrated records reuse the existing
status union plus a `hydrated: true` marker — `completed` for
completed-unclaimed work, `aborted` with an interruption error for mid-turn
children, `failed` for unrecoverable edges. §4 claim tracking builds on the
marker.

Hydration is defensive about edge quality — spawn entries load without
field-level validation, and session rewrites can strand them:

- an edge missing required fields (hand-edited or corrupted files) is skipped;
- an edge whose `toolCallId` has no matching toolCall in the transcript
  (possible after branch extraction or a session clear replaces the entry set
  while a child is still publishing) hydrates as a plain registry record but
  never produces a §4 recovery notice; "in the transcript" is file-scoped by
  design — a toolCall on an abandoned branch still counts, because the notice
  text is self-contained and cross-branch result reuse is the registry's
  purpose;
- an edge whose `childSessionFile` is missing or unreadable records status
  `unrecoverable` rather than failing hydration.

### 4. Recovery to the parent conversation

On the first prompt after a load, if the context contains a `subagent` toolCall
whose result is missing (crash) or aborted-with-linkage (dispose) while the
registry holds a `completed-unclaimed` record for its edges, the session
appends a compact custom message before the turn:

> Subagent recovery: 2 of 3 children of the interrupted call completed after
> the session closed. Results are available via subagent_registry
> (`follow: "sa_…"`).

The model then pulls reports through the registry with the normal truncation
budgets. This keeps recovery single-sourced through the registry rather than
inventing a second delivery path, and avoids blowing up context with
auto-injected full reports. Claiming a record flips `completed-unclaimed` →
`completed` so the notice is not repeated.

### 5. Lazy runtime reload for interrupted children

Add a `resume` action to `subagent_registry` for `interrupted` records: the
manager recreates a runtime from `childSessionFile` (the ordinary session-file
load path) instead of a fresh session, and prompts it to continue its original
task. Depth/policy checks and delegation-scope reservation apply as for a new
start; the resumed run reuses its `subagentId` and registry record. No dedup
preflight: the preflight prevents duplicate *spawns*, while `resume` claims an
existing record by id, so duplication is structurally impossible. This is
deliberately minimal — no mid-run steering, just completion of interrupted
work.

### 6. Daemon interplay

Integrated-runtimes' TTL reaping of detached children becomes safe rather than
lossy: a reaped child's report remains recoverable via hydration. After a
daemon restart, child conversation entries are not eagerly re-registered;
attaching to a parent hydrates its registry, and `resume` re-creates child
runtimes (and their attachable entries) on demand.

## Testing

Regression tests under `packages/coding-agent/test/suite/regressions/` with the
faux provider harness:

- Dispose mid-parallel-call → reload session → registry lists children as
  `completed-unclaimed`/`interrupted`; recovery notice appears; `follow`
  returns the persisted report.
- Simulated hard crash (no dispose; drop the manager) → same recovery from
  `subagent_spawn` entries alone.
- Spawn-entry commit point: a rejected first prompt (ghost spawn, #56 suite)
  produces no entry.
- Hydration of grandchildren via recursive spawn entries; scope usage
  rehydrated and enforced.
- `resume` on an interrupted child completes the task in the reloaded runtime;
  `resume` refused when depth/policy would deny a fresh start.
- Projection: `subagent_spawn` entries and `completed-unclaimed` records pass
  the transcript/daemon allowlists with `requestKey` treated like the confirm
  token (never projected).

## Decided (2026-07-27)

- **Hydration is lazy, per parent attach/load.** Eager daemon-side scanning
  costs scale with session history rather than need (spawn entries can sit
  anywhere in a JSONL, so honest scans read everything), and the sessions dir
  is shared with non-daemon writers (TUI-owned sessions), so an eager index
  goes stale in ways attach-time derivation cannot — it is correct by
  construction because it reads at the moment of use. Lazy's downsides
  (post-restart discovery gap in the iOS runs list, attach-path tail-read I/O)
  are UX gaps, not correctness liabilities. If the discovery gap starts to
  matter, layer the bounded hybrid: the daemon's persisted state additionally
  records recently hosted parent sessions and hydrates only those on restart —
  no format changes required. Hydration yields a macrotask per child transcript
  load; the loads themselves are still synchronous reads (`SessionManager.open`),
  so fully off-event-loop hydration remains a follow-up (per the #46/#123
  lesson).
- **`resume` takes no dedup preflight.** The preflight prevents duplicate
  spawns; `resume` claims an existing registry record by id, so duplication is
  structurally impossible.
