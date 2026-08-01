# RFC Amendment: Workspace Authority Generations and Retirement

- Status: Proposed
- Date: 2026-07-31
- Workspaces: `Volt/packages/coding-agent` (authority and runtime integration), `Volt/packages/agent` (origin-aware queues)
- Amends: [Live Shared Sessions](live-shared-session-daemon-design.md) and [Atomic Conversation Bootstrap](conversation-bootstrap-design.md)
- Breaking changes: intentional. Volt has no compatibility obligation for the current daemon control protocol or state format.

Paths are relative to `Volt/packages/coding-agent/` unless prefixed with `packages/agent/`.

---

## 1. Decision

A registered workspace is an authorization identity, not mutable lookup metadata. Its identity is:

```text
(workspaceName, workspaceGeneration, canonicalPath, allowedTools)
```

`workspaceGeneration` is a required, durable, monotonically increasing value. It is captured by every object that can admit or continue remote work:

- successful Iroh authorization;
- accepted direct and utility streams;
- daemon attach claims and integrated runtime entries;
- conversation lease records and TUI lease authority;
- offered and active relay lifecycle owners;
- relay preambles and TUI relay-serving authority;
- origin metadata for admitted prompts, queued inputs, active turns, extension continuations, and descendant tool work;
- in-flight workspace mutation response capabilities.

The logical remote conversation authority is therefore:

```text
(workspaceName, workspaceGeneration, sessionId)
```

Session persistence and display may remain grouped by workspace name. Authorization, routing, runtime reuse, lease lookup, and relay creation must match the exact generation.

A changed path or workspace tool policy is not an in-place update. It is an atomic **retire-and-replace** operation:

```text
retire authority generation G -> persist generation G+1 -> admit generation G+1
```

An exact re-registration of the same canonical path and policy is an idempotent no-op. It does not allocate a generation or retire authority.

## 2. Problem

The current architecture has two independent identities:

```text
workspace authorization: (name, generation, path, policy)
conversation lease:       (name, sessionId)
```

Changing `ws` from path A to path B invalidates new stream admission through the authorization generation, but an existing TUI lease remains valid by name. Existing relays can continue serving a TUI runtime rooted at A, and a later relay for generation B can route through the same stale name-only lease. Daemon runtimes and already-admitted turns can also outlive the registration from which their path and policy were derived.

This cannot be corrected reliably with additional checks only at handshake or RPC command boundaries. Generation must be part of the ownership model, and the state mutation must coordinate retirement of every owner derived from the old generation.

## 3. Required invariants

### W1. Exact-generation authority

No stream, attach, runtime, lease, relay, or TUI relay server may admit work unless its captured workspace generation equals the current admitted generation for that workspace name.

A name match is never sufficient.

### W2. One mutation owner

When the Iroh service is active, every authority-bearing workspace mutation is executed by one `WorkspaceAuthorityCoordinator`. Generic daemon state handling must not mutate workspace registration behind that coordinator.

The state-only fallback may handle registration only when no remote authority service exists and therefore no streams, relays, leases, or daemon runtimes can be active.

### W3. Synchronous admission fence

A replacement or unregister operation synchronously closes the old generation's admission gate before its first retirement await.

After that cut:

- no old-generation attach can publish;
- no old-generation relay token can be redeemed;
- no new relay can be minted from an old lease;
- no old-generation RPC command can cross a command boundary;
- no old-generation TUI relay ingress can accept another command.

Every asynchronous publication path checks the gate both before and after persisted-state revalidation.

### W4. Terminal retirement before mutation success

A workspace mutation does not report success until every old-generation owner is terminal:

- pending attach claims are fenced;
- direct and utility streams have settled;
- offered and active relays have settled;
- daemon runtimes have stopped through their coordinator terminal barriers;
- old-generation lease records and rekey reservations are invalidated;
- each TUI authority holder has acknowledged that relayed ingress is fenced and old-authority work is no longer running.

Successful acknowledgement is the security cut. Courtesy terminal-frame delivery cannot delay or weaken it.

### W5. No old/new overlap

Generation `G+1` is not admitted until generation `G` retirement has completed and the replacement state has been durably persisted.

If retirement fails or a TUI does not acknowledge retirement, the replacement is not persisted. The old generation may reopen after the mutation gate rolls back, but retired streams and relays reconnect through fresh authorization. Disruption is preferable to publishing overlapping authority.

### W6. Mutation CAS

Replacement and unregister state operations require the expected current generation. A stale control request cannot replace or remove a registration that changed while it awaited path validation or retirement.

Generation values are never reused, including after unregister and re-register of the same name. The retained per-name generation record prevents same-name ABA.

### W7. Generation-scoped routing

The lease broker and conversation coordinator may retain indexes keyed by workspace name and session ID for lookup, but every record carries `workspaceGeneration`, and every operation supplies and proves the expected generation.

A stale record is fenced rather than reused. In particular, a generation-B phone stream cannot route to a generation-A TUI lease even if both use the same workspace name and session ID.

### W8. TUI retirement is explicit and origin-selective

Closing the byte relay is not proof that work already admitted into the TUI runtime has stopped. A TUI-held workspace authority therefore has an opaque `tuiAuthorityId`, and every admitted input carries trusted origin metadata identifying the remote authority that admitted it.

On `workspace_authority_retire`, the TUI must:

1. synchronously close remote ingress for that authority;
2. reject further relay offers and forwarded commands for it;
3. fence prompt preflight and extension continuations carrying a retired origin;
4. selectively remove queued inputs carrying a retired origin;
5. abort the active agent segment only when its current causal origin includes a retired authority;
6. await matching prompt transactions, active segments, tools, and descendants without waiting for unrelated work;
7. release the generation-scoped conversation lease when requested;
8. respond with `workspace_authority_retired`.

An unrelated local TUI turn is not aborted merely because the workspace's remote serving authority is retiring. If the current provider/tool segment was formed from an input batch containing retired remote authority, that segment must be aborted; an unconsumed remote steer or follow-up is removed without disturbing the local segment.

The local TUI runtime itself may remain open at its local path after retirement. It no longer serves phones under the retired registration. After the transaction settles, the TUI re-resolves its cwd and may auto-register it under another available workspace name.

### W9. Initiator response capability

A remote `unregister_workspace` request needs one response after it has fenced its own workspace. This is represented by a one-shot `WorkspaceMutationResponseCapability`, not by keeping the stream generally active.

The capability permits exactly:

1. the correlated unregister response;
2. one optional terminal frame;
3. physical stream closure.

It permits no further ingress or ordinary projection output. For a TUI relay, the TUI acknowledges authority retirement while retaining only this response capability; after the response write receipt settles, it closes the relay.

### W10. Already-admitted work

Authority tightening is stronger than ordinary detach or ownership handoff:

- workspace replacement and unregister stop generation-scoped daemon runtimes through runtime retirement;
- client revoke and access tightening retire only work carrying the affected remote input origin when the shared runtime itself remains current;
- TUI-owned work is aborted only when its current causal origin includes retired authority;
- queued inputs and preflight transactions derived from retired authority are selectively cancelled;
- unrelated local and still-current remote work remains admitted;
- side effects completed before the retirement cut cannot be undone, but no retired-origin work remains active when mutation success is reported.

This rule applies to workspace replacement, workspace unregister, client revocation, and client access tightening. Those operations use the same origin-aware TUI retirement mechanism instead of merely closing relays.

## 4. Authority model

### 4.1 Persisted registration

```ts
interface WorkspaceRegistrationAuthority {
  name: string;
  generation: number;
  path: string;
  allowedTools?: string;
}
```

The persisted state keeps a global monotonic generation counter and one retained generation record per workspace name. Every registered workspace resolves to exactly one required generation.

### 4.2 Successful Iroh authorization

`IrohRemoteClientAuthorizationSuccess.workspaceGeneration` becomes required. Authorization captures the complete registration authority in the same serialized state-manager operation that validates the client and workspace.

`isAuthorizationCurrent` verifies:

- client identity and RPC grant revision;
- client permission for the workspace;
- workspace name, path, and policy;
- workspace generation;
- the in-memory workspace authority admission gate.

The gate is checked before and after the asynchronous persisted-state check.

### 4.3 Conversation lease

```ts
interface LeaseRecord {
  workspaceName: string;
  workspaceGeneration: number;
  sessionId: string;
  // existing state and ownership fields
}
```

All attach, acquire, release, rekey, relay registration, stream-count, and runtime-disposal operations prove the generation in addition to their existing owner capability.

`LeaseBroker.retireWorkspaceAuthority(name, generation, reason)` synchronously makes matching records unavailable, fences provisional cohorts and rekey reservations, and starts the existing terminal effects. It returns one terminal receipt covering those effects.

### 4.4 Runtime and coordinator

Every `IntegratedRuntimeEntry` and `ConversationCoordinator` captures the workspace generation that created it. Runtime registry lookup refuses a generation mismatch even when workspace name and session ID match.

Workspace authority retirement calls the coordinator's existing monotonic runtime-retirement path. Low-level registry deletion or stream closure is not a substitute for its terminal barrier.

### 4.5 Relay

Every `RelayLifecycleOwner`, relay offer, and relay preamble carries `workspaceGeneration` and `tuiAuthorityId`.

Relay mint and redemption require:

- exact current workspace generation;
- exact generation-scoped TUI lease;
- an open workspace admission gate;
- a current TUI authority ID.

Entering workspace retirement synchronously removes matching offered and active relays from admission lookup before awaiting physical settlement.

### 4.6 Input origin and causal work

Origin is host-authenticated metadata, not a phone-supplied field:

```ts
type AgentInputOrigin =
  | { kind: "local" }
  | { kind: "remote"; authority: RemoteInputAuthority };

interface RemoteInputAuthority {
  clientNodeId: string;
  rpcGrantRevision: number;
  workspaceName: string;
  workspaceGeneration: number;
}
```

`relayId`, physical stream ID, and `tuiAuthorityId` are intentionally absent. Transport replacement does not revoke already-admitted work. Client grant revision and workspace generation are the durable revocation dimensions.

The daemon constructs this origin after authorization. Direct RPC dispatch receives it from the accepted stream owner. Relayed RPC dispatch receives the same trusted value in the daemon-generated relay preamble; bytes supplied by the phone cannot override it. Local TUI, print, SDK, and non-Iroh RPC input use local or another explicitly non-remote origin.

Origin is carried through:

- prompt preflight and its asynchronous extension input/command handlers;
- durable client-input receipt and queue records;
- `AgentSessionQueuedMessage` and the agent-core queue entry identity;
- the current user-input segment of an active agent loop;
- retries, automatic compaction, tool calls, and descendant operations caused by that segment.

Origin is host-only metadata. It never enters model context, canonical transcript messages, conversation projection, bootstrap, checkpoints, or app-visible queue text.

The active causal origin is segment-based rather than transport-based. An immediate prompt establishes the origin before agent-loop execution. When steering or follow-up input is dequeued, the origin set of that drained input batch becomes the origin of the resulting user-input segment before extension hooks, provider calls, or tools can run. At `agent_end`, no input origin remains active. Completed segments become historical transcript content and retain no executable authority.

A segment may contain multiple origins when queue mode drains a batch from multiple producers. Retiring any member aborts that segment. A remote message that remains queued has not tainted the active local segment and can be removed selectively.

`AgentSession.retireInputAuthority(selector, reason)` is the terminal owner for input-derived work. It synchronously fences matching admission, asks agent-core to remove matching queue-entry IDs without clearing other queues, marks matching durable accepted receipts failed, aborts a matching active segment, and returns a receipt that settles when matching prompt transactions and descendant work are terminal. It does not wait for unrelated local work or work admitted by another current remote authority.

The durable idempotency identity includes origin. A client message ID replay must match both semantic payload and `RemoteInputAuthority`; the same ID under another client, grant revision, or workspace generation conflicts. Durable queued-input recovery validates the stored remote authority before replay and fails stale entries instead of executing them after restart.

`packages/agent` adds selective queue removal by core queue-entry identity. AgentSession retains an origin tombstone for a queue entry until dequeue can no longer race retirement: if agent-core drained the entry just before removal, the awaited `message_start` observes the retired origin and aborts before extension, provider, or tool side effects.

## 5. Workspace mutation transaction

`WorkspaceAuthorityCoordinator` serializes mutations by workspace name.

### 5.1 Exact no-op registration

```text
canonicalize candidate
  -> load current authority
  -> same path and policy
  -> return current authority; no generation change; no retirement
```

### 5.2 New registration

```text
canonicalize candidate
  -> prove name is absent
  -> allocate and durably persist next generation
  -> publish admission for that generation
  -> acknowledge success
```

There is no old authority to retire. A retained generation tombstone still prevents reuse after a previous unregister.

### 5.3 Replacement

```text
canonicalize candidate
  -> load authority G
  -> acquire expected-generation mutation claim
  -> synchronously close generation-G admission
  -> synchronously fence attach/lease/relay lookup
  -> start direct/utility stream retirement
  -> start daemon runtime retirement
  -> request and await TUI authority retirement
  -> await every terminal receipt
  -> CAS persist candidate as generation G+1
  -> publish generation-G+1 admission
  -> notify affected TUIs to re-resolve cwd
  -> acknowledge success
```

No path exists that calls the generic `upsertWorkspace` and performs lifecycle cleanup afterward.

### 5.4 Unregister

Unregister uses the same transaction through terminal retirement, then CAS-removes the registration while retaining its generation tombstone.

For a local control request, success is acknowledged after removal is durable and retirement is terminal.

For a remote request, the initiating stream is converted to the response-only capability from W9. The durable removal occurs after all other authority is terminal; the correlated success response and terminal frame then settle through that capability.

### 5.5 Failure

If retirement, TUI acknowledgement, or persistence fails:

- no replacement generation is published;
- no unregister success is reported;
- the old persisted registration remains authoritative;
- the mutation gate rolls back to that generation;
- already-retired streams and relays remain closed and must reconnect;
- audit records the failed phase and counts of retired owners.

A TUI retirement timeout is a mutation failure. The daemon does not assume that control-socket loss proves the TUI process and its already-admitted turn are dead.

## 6. Control protocol changes

The local protocol changes in place.

Workspace and lease messages expose required generation identity:

```ts
interface ControlWorkspaceStatus {
  name: string;
  generation: number;
  path: string;
  allowedTools?: string[];
}

interface LeaseAcquireRequest {
  type: "lease_acquire";
  workspaceName: string;
  workspaceGeneration: number;
  sessionId: string;
}
```

TUI authority retirement uses:

```ts
type RemoteInputAuthority = {
  clientNodeId: string;
  rpcGrantRevision: number;
  workspaceName: string;
  workspaceGeneration: number;
};

type RemoteInputAuthoritySelector =
  | {
      kind: "workspace_generation";
      workspaceName: string;
      workspaceGeneration: number;
    }
  | {
      kind: "client_grant";
      clientNodeId: string;
      rpcGrantRevision: number;
    }
  | { kind: "client"; clientNodeId: string };

type WorkspaceAuthorityRetireEvent = {
  type: "workspace_authority_retire";
  retirementId: string;
  tuiAuthorityId: string;
  workspaceName: string;
  workspaceGeneration: number;
  retiredInputAuthoritySelectors: RemoteInputAuthoritySelector[];
  reason:
    | "workspace_replaced"
    | "workspace_unregistered"
    | "client_access_updated"
    | "client_revoked";
  releaseWorkspaceLease: boolean;
  responseRelayId?: string;
};

type WorkspaceAuthorityRetiredRequest = {
  type: "workspace_authority_retired";
  id: string;
  retirementId: string;
  tuiAuthorityId: string;
};
```

The daemon responds to `workspace_authority_retired` only when the enclosing mutation has committed or rolled back. For workspace replacement or unregister, `releaseWorkspaceLease` is true; the TUI then clears its cached registration binding, resolves its current cwd from fresh status, and reacquires under the returned current generation. Client-only access changes use false and preserve the current generation-scoped TUI lease after the affected input origins and relays retire.

## 7. Ownership boundaries

The design retains the existing stable owners:

- `ConversationCoordinator` remains the logical conversation/runtime terminal owner.
- `RelayLifecycleOwner` remains the offered-to-active physical relay owner.
- `IrohPhysicalStreamOwner` remains the accepted direct-stream owner.
- `LeaseBroker` remains the process-ownership state machine.

`WorkspaceAuthorityCoordinator` is above them. It owns only workspace-generation admission and the cross-owner mutation transaction. It invokes their existing retirement paths and awaits their terminal receipts; it does not replace their lifecycle ownership.

The active-stream, runtime, lease, and relay registries remain indexes. None may independently decide that a same-name object from another generation is reusable.

## 8. Acknowledgement guarantees

After a successful workspace replacement or unregister response:

- persisted state contains only the new generation or no registration;
- old-generation publication and ingress gates are closed;
- no old-generation attach claim can publish;
- no old-generation lease or relay is routable;
- no old-generation daemon runtime is running;
- no TUI runtime is executing work admitted by the retired remote authority;
- every subsequent phone attach performs fresh authorization against the current generation.

This is stronger than “future commands will eventually notice a stale grant.” It is the externally observable contract of mutation success.

## 9. Implementation map

Expected primary changes:

- `src/core/remote/iroh/state.ts`
  - required workspace generations and registration authority shape.
- `src/core/remote/iroh/state-manager.ts`
  - expected-generation create/replace/unregister operations; no lifecycle-blind public upsert for daemon control mutations.
- `src/core/remote/iroh/authorization.ts`
  - required captured generation and canonical remote input authority.
- `src/core/session-manager.ts`
  - host-only origin metadata on durable input receipts/queues and stale-authority recovery fencing.
- `src/core/agent-session.ts`
  - origin-aware prompt transactions, queues, active segments, descendants, and selective authority retirement.
- `src/modes/rpc/rpc-command-dispatcher.ts`
  - stamp every prompt, steer, and follow-up from trusted dispatcher context.
- `packages/agent/src/agent.ts`
  - selective queued-message removal by core queue-entry identity.
- `src/daemon/main.ts`
  - route authority-bearing mutations to the Iroh service; state-only fallback only when no authority service exists.
- `src/daemon/iroh-service.ts`
  - `WorkspaceAuthorityCoordinator`, gate checks, mutation transactions, and TUI retirement acknowledgements.
- `src/daemon/lease-broker.ts`
  - generation-scoped records/claims and workspace-authority retirement.
- `src/daemon/integrated-runtimes.ts`
  - generation-scoped entries and lookup.
- `src/daemon/relay-stream.ts`
  - generation and TUI authority identity on relay owners.
- `src/daemon/control-protocol.ts`
  - generation fields and retirement messages.
- `src/modes/interactive/daemon-attach.ts`
  - generation-aware binding, authority retirement handling, and cwd re-resolution.
- `src/modes/interactive/interactive-mode.ts`
  - origin-selective retirement of relayed ingress, queues, and active causal segments.

## 10. Verification contract

### 10.1 State and generation

- Exact same-path registration is idempotent and leaves generation unchanged.
- Path or policy replacement increments generation exactly once.
- Unregister/re-register never reuses a generation.
- Stale expected-generation replacement and unregister fail without mutation.

### 10.2 Daemon-owned authority

- Replacement while a direct conversation is idle closes the stream and stops the runtime before success.
- Replacement while a turn is active aborts/stops it before success.
- Discovery, workspace-management, and worktree-management streams from the old generation become terminal.
- An attach paused at every publication await cannot publish after the retirement cut.

### 10.3 TUI-owned authority

- Replacing workspace `ws` from path A to B closes offered and active relays, retires the generation-A TUI lease, and aborts active generation-A remote work before success.
- An unrelated local TUI turn continues when no generation-A remote input has entered its active segment.
- Unconsumed generation-A remote steer/follow-up entries are removed while local and still-current remote queue entries retain order.
- A provider/tool segment whose drained input batch contains a generation-A remote steer is aborted before success.
- A generation-B phone attach cannot route to the former generation-A TUI runtime.
- The TUI at path A re-resolves and may register under a different name; it does not silently reclaim `ws` at B.
- Missing or delayed TUI retirement acknowledgement causes replacement failure and leaves persisted registration A.

### 10.4 Unregister response ordering

- Direct and relayed unregister initiators receive exactly one success response before terminal closure.
- No command pipelined after unregister is admitted.
- Response backpressure cannot keep other old-generation authority alive.
- A failed response write does not roll back an already durable unregister, but still settles the initiator capability.

### 10.5 Access tightening parity

- Client access update and revoke use the same origin-aware TUI retirement protocol.
- Revoking client A removes A's queued input and aborts a segment influenced by A without clearing client B or local input.
- Incrementing a client's RPC grant revision makes durable queue records from the previous revision ineligible for restart replay.
- Mutation success implies no daemon or TUI work admitted under the retired client/workspace authority remains active.

### 10.6 Origin and queue races

- Retirement before prompt preflight, during an extension input hook, and immediately before provider dispatch cannot publish new retired-origin work.
- Retirement racing agent-core queue drain either removes the entry or observes its tombstoned origin at `message_start`; it never executes invisibly.
- Queue mode `all` preserves nonmatching entries and fences every matching entry in a drained batch.
- Same `clientMessageId` under a different remote input authority conflicts.
- Restart recovery fails stale-origin durable input and replays only currently authorized origin.
- Descendant tools and subagents inherit the causal origin and settle before its retirement receipt.

### 10.7 ABA and lifecycle races

- Generation A unregister followed by generation B registration cannot be affected by stale A stream, relay, attach, lease, runtime, rekey, origin, or retirement callbacks.
- Concurrent register/register and register/unregister operations serialize by workspace name and one loses by expected generation.
- Daemon shutdown and workspace retirement converge through existing idempotent terminal owners without double release.

## 11. Rejected alternatives

### 11.1 Check generation only when creating a relay

Rejected. It does not stop an active relay, a stale TUI lease, runtime reuse, or already-admitted work.

### 11.2 Revalidate only at RPC command boundaries

Rejected. A TUI relay does not own daemon state, and a command already admitted into an agent turn can continue invoking tools after the registration changes.

### 11.3 Close streams after state mutation

Rejected. It creates an interval where the new persisted generation coexists with old name-scoped lease and runtime authority. Mutation success also lacks a defensible terminal cut.

### 11.4 Key only by workspace name and close known relays

Rejected. Name reuse creates ABA across leases, pending attach claims, runtimes, and delayed callbacks.

### 11.5 Treat TUI control disconnect as retirement acknowledgement

Rejected. Socket loss proves that future relay ingress is unavailable; it does not prove that a previously admitted TUI turn has stopped. The mutation fails unless the TUI acknowledges retirement or the operator terminates it and retries.

### 11.6 Abort every active TUI turn

Rejected. It is secure but unnecessarily destroys unrelated local work. Trusted origin metadata lets retirement preserve a local segment unless retired remote input has causally entered it.

### 11.7 Infer origin from transport or client message ID

Rejected. A transport can disappear while admitted work remains valid, and a client message ID is client-controlled idempotency identity rather than authorization provenance. Origin is stamped by the authenticated host and persists independently of physical transport.

---

## 12. Completion definition

The amendment is implemented only when workspace generation is present in every authority-bearing owner, input origin survives every admission/queue/dequeue/continuation seam without entering model or projection data, all workspace mutations route through the coordinator, the acknowledgement guarantees in §8 are covered by deterministic race tests, targeted tests pass, and `npm run check` reports no errors, warnings, or infos.
