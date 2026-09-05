# Review finding discussions (#341)

Developer design for independent, host-owned finding conversations. iOS integration is tracked in volt-app #249.

## Ownership and persistence

The v2 session store keeps canonical review anchors, host-only handoff aliases, unique `(runId, findingId)` discussions, and generation-pinned child history. A host review creation registers the anchor after durable materialization. Approved handoff/clear-context paths register aliases; importing or forking a transcript does not grant membership. Normal unanchored reports remain readable and locally actionable; rerunning a review establishes current discussion authority.

Canonical outcome reads, rerun planning, publishing and feedback resolve the original source rather than stale alias snapshots. A live canonical writer uses its session actor. An unloaded source uses a short provisional broker reservation until the metadata write and manager close settle, then rolls back that reservation without publishing a provider runtime. Competing TUI/phone openers cannot initialize the same source during that write. An already-owned unavailable source fails explicitly.

Source and child references include store/session generations internally. Runtime lookup is additionally scoped to the requester's registered workspace name and generation. Client projections never include store paths or generations as caller-granted authority.

## Sibling admission

The daemon's review service creates siblings without rekeying the source. Broker/coordinator producer admission is acquired before opening the child manager or seeding context. Cold-open competitors either reuse an admitted runtime or retry without modifying its persistence. Registry publication, worktree binding, broker finalization and cleanup retain exact ownership; failed initialization is fully quiescent before provisional ownership is released.

Client revocation, access changes and workspace removal synchronously fence pending review effects before waiting for stream retirement. Ordinary app detach does not revoke that fence. Pending source control work pins normal detached-runtime retention until it settles.

Each child inherits authorized placement, effective model/thinking/Fast configuration and a saved tool ceiling. Its context contains only the selected immutable finding, target revision and evidence. It does not own mutable finding outcomes.

A persisted finding discussion applies research operation capabilities minus plan authoring, independently of Plan/Build mode. Argument checks run after extension hooks and at execution. Structural/host-action/raw MCP paths cannot widen it. Automatic LSP installation is unavailable. Supplied MCP managers are left untouched; the discussion creates its own restricted manager with current project trust instead.

## RPC contract

Ordinary transport correlation `id` is separate from semantic `requestId`. Mutations require current remote `conversationAuthority`.

```ts
{ type: "start_review_discussions", runId, findingIds, requestId }
{ type: "list_review_discussions", runId, cursor?, limit? }
{ type: "reset_review_discussion", discussionId, expectedSessionId, requestId }
{ type: "get_review_discussion_source" }
```

Start accepts 1–50 unique finding IDs and returns independent `created | existing | failed` outcomes. List pages are bounded to 50. Reset returns `reset | conflict | busy` with the current discussion descriptor. A host without the sibling backend returns `review_discussions_unavailable`; unavailable source authority returns `review_source_unavailable`. Both are registered stable errors.

```ts
type Link = {
  discussionId: string;
  runId: string;
  findingId: string;
  sourceSessionId: string;
  sessionId: string;
  readOnly: true;
};
type Discussion = Link & {
  currentSessionId: string;
  sourceAvailable: boolean;
  available: boolean;
  status: "idle" | "running" | "pending" | "completed" |
          "failed" | "cancelled" | "interrupted" | "unavailable";
};
```

State/bootstrap/session-list metadata has optional `reviewDiscussion: Link`. `sessionId` identifies the described child; `currentSessionId` identifies the current reset generation. Older children remain linked and read-only, and their ordinary session-list metadata permits history discovery. Source lookup on a historical child preserves its requested `sessionId` while returning the group's current pointer. List/source status is a snapshot; live conversation events remain authoritative for an attached turn.

## Retry and reset

An initial kickoff has a persisted `clientMessageId`. Start retries reuse the same child and never resend an existing receipt. Partial failures retain successful siblings and recoverable IDs.

Idle reset is serialized with source starts and guarded by the old child's session actor plus SQLite expected-child CAS. It retains previous child IDs, prepares a new bound idle runtime under producer admission, and does not start inference. Replayed reset requests resolve their recorded history instead of clearing the latest context again.

Recovered finding inputs are terminalized as failed, with an interrupted explanation, instead of automatically replaying accepted/started/queued work. A user retries through a new explicitly submitted child prompt. Completion status follows the latest assistant turn, not merely the initial input receipt.

## Validation and rollout

Use the faux-provider suite harness and disposable stores. Regression coverage includes four overlapping discussions, canonical aliases, independent cancellation, duplicate starts/resets, exact-generation lookup, cold-source writes, TUI/phone competitors, publication rollback, revocation, detach retention, interrupted input recovery, and read-only operation gates.

`test.sh` temporarily moves `$HOME/.volt/agent/auth.json`; run it with an isolated HOME when a developer daemon/session is active. Fresh worktrees need ignored local package compiler outputs for package-level typechecks/browser smoke; no dependency changes are required.

See `session-format.md` for the transactional v1-to-v2 upgrade. Do not open real stores with new code until older CLI/daemon owners have been shut down. Implementation verification uses isolated daemons/stores, never an implicit developer-daemon restart.
