# RFC: Git-worktree-backed session isolation for voltd

**Status:** Draft
**Package:** `packages/coding-agent` (all paths below are relative to it)
**Protocol feature:** `worktrees.v1`

---

> **Current session-storage note:** Volt now stores live sessions in the parent workspace's `sessions.sqlite` database. References below to a session file/header should be read as the corresponding session row/`SessionReference`; worktree sessions still use the parent workspace session directory and persist their effective worktree `cwd` in the session row. JSONL is import/export only.

## 1. Summary

Every daemon-owned headless runtime today runs with `cwd = workspace.path` — the one registered checkout — so two concurrent sessions in the same workspace stomp on each other's files, branches, and index. This RFC adds optional **git-worktree-backed session isolation**: the daemon manages worktrees under `~/.volt/agent/worktrees/`, a session can be started "into" a worktree (from the mobile app over the iroh remote protocol, and later from the TUI), and the daemon persists a `sessionId → worktree` binding so resume, relay, lease takeover, and sanitization all follow the worktree cwd. Sessions remain stored and listed under the **parent workspace**, so `list_sessions`, `target:"last"`, and lease keying keep working unchanged.

Delivery is phased:

- **Phase 1 (foundation):** daemon worktree manager, persisted state, management-stream RPCs (`create_worktree` / `list_worktrees` / `remove_worktree`), `target:"new"` handshake extension, `worktrees.v1` capability, `volt remote worktree …` CLI.
- **Phase 2 (TUI):** new-session-into-worktree from the TUI; lease takeover of a worktree-bound session attaches with the worktree cwd.
- **Phase 3 (polish):** merge-back UX, cleanup/retention policies, prune-on-start, app affordances.

---

## 2. Background

Verified anchors (line numbers may drift ±5):

**cwd flow.** `IntegratedRuntimeRegistry.createEntry` is the single point where a workspace path becomes a runtime cwd: it calls `createIrohRemoteAgentRuntimeWithSessionSelection({ …, cwd: authorization.workspace.path, … })` (`src/daemon/integrated-runtimes.ts:225-233`). That factory fans `options.cwd` into migrations, `SettingsManager.create`, `createAgentSessionServices`, `SubagentManager`, and session-dir resolution (`src/modes/rpc/iroh-remote-agent-runtime.ts:89-152`). Critically, the factory already exposes two bypass seams: `sessionDir?: string` (line 37) and `resolvedSessionTarget?` (line 34), and its internal store is `createSessionManagerTargetStore(options.cwd, options.sessionDir ?? getDefaultSessionDir(options.cwd, agentDir))` (lines 168-176).

**Session storage.** `getDefaultSessionDirPath(cwd)` is a pure encoding of the cwd into `~/.volt/agent/sessions/--<encoded-cwd>--/` (`src/core/session-manager.ts:438-451`). `SessionManager.create(cwd, sessionDir)` stores `cwd` in the session header (line 1461); `SessionManager.open(path, sessionDir, cwdOverride)` defaults to the **header cwd** (line 1477); `SessionManager.list(cwd, sessionDir)` applies a cwd filter **only** when an explicit `sessionDir` differs from the default dir for `cwd`: `filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd)` (lines 1570-1576). The daemon's `list_sessions` lists `SessionManager.list(workspace.path, getDefaultSessionDir(workspace.path, context.agentDir))` (`src/daemon/conversation-commands.ts:984-990`) — since `context.agentDir` is the same env-aware `getAgentDir()` (`src/config.ts:500-506`) that `getDefaultSessionDirPath` defaults to, `filterCwd` is false and **every session file in the parent's dir is listed regardless of header cwd**. This is what makes the "parent-keyed session dir" decision in §5.1.7 work.

**Daemon state.** Wire/host shape `IrohRemoteHostState { hostSecretKey?, pairingSecretTombstones?, workspaces, clients, revokedClients?, pendingPairingTickets? }` (`src/core/remote/iroh/state.ts:97-104`) with strict per-field parsers; `parseOptionalArray` maps `undefined → []` (lines 335-340), so new optional collections are backward compatible. The daemon envelope `VoltdStateFileV1` (`src/daemon/state.ts:24-51`) hard-fails on `version !== 1` (line 102) and reconstructs state via `hostStateToVoltdState`/`voltdStateToHostState` (lines 69-94) — **any new collection must be threaded through both converters, `parseIrohRemoteHostState`, `serializeIrohRemoteHostState` (state.ts:152-193), and `cloneHostState` (state-manager.ts:635-646), or it is silently dropped on the next write.** All five sites enumerate fields explicitly.

**Handshake strictness.** `parseConversationTarget` allowlists exactly `["target", "sessionId"]` via `expectKnownFields` and rejects anything else with `IrohRemoteHandshakeError("invalid_conversation_target", …)` (`src/core/remote/iroh/handshake.ts:438-462, 494-501`). `parseWorkspaceManagementTarget` pins `purpose === "unregister_workspace"` (lines 479-491). Host features `IROH_REMOTE_HOST_FEATURES = ["multi_streams.v1", "conversation_streams.v1"]` (`src/core/remote/iroh/protocol.ts:5-10`) are sent in every handshake success; `docs/iroh-remote-protocol.md` describes features as optional host capabilities, not a version bump.

**Management-stream template.** `runWorkspaceManagement` (`src/daemon/iroh-service.ts:854-905`) registers a synthetic-session active stream and runs `runWorkspaceManagementStream` (`src/daemon/workspace-streams.ts:207-282`): JSONL loop, command-type whitelist (`!== "unregister_workspace"` → `unsupported_on_workspace_management_stream`), strict request parse (`parseWorkspaceManagementUnregisterRequest`, lines 190-205: unknown fields → `invalid_request`; name mismatch → `session_mismatch`), audit log, `createRpcSuccessResponse`.

**Sanitizer.** All outbound frames map `authorization.workspace.path → "/workspace"` (`src/daemon/workspace-streams.ts:64-72`). `createSanitizerContext` derives `workspacePathVariants` from a **single root** — the variants are only separator/Unicode-normalization forms of that one path (`src/core/remote/iroh/outbound-filter.ts:121-146`). There is no multi-root support today.

**Trust & tools.** `getAllowTools` = daemon settings `allowTools` else `workspace.allowedTools` (`src/daemon/iroh-service.ts:429-435`); `projectTrusted` = `resolveIrohRemoteWorkspaceProjectTrusted(workspace, { trustStore })` (`src/core/remote/iroh/host-policy.ts:15-29`) with ancestor-walking `ProjectTrustStore.get` (`src/core/trust-manager.ts:44-58`) and ancestor-walking `hasTrustRequiringProjectResources` (lists `.mcp.json`, `.volt/*`, `.agents/skills`; trust-manager.ts:180-215). A worktree under `~/.volt/agent/worktrees` is **not** filesystem-nested under the workspace, so it would not inherit trust without explicit plumbing.

**Lease/registry keying.** Both `LeaseBroker` (`src/daemon/lease-broker.ts:64-66`) and `IntegratedRuntimeRegistry.getRegistryKey` (`integrated-runtimes.ts:152-154`) key on `${workspaceName}\0${sessionId}` — no path dimension. TUI attach resolves its workspace by **path-prefix match** against registered workspaces and **auto-registers** the cwd on miss (`src/modes/interactive/daemon-attach.ts:192-229`).

**Relay preamble.** `RelayPreamble.authorization` carries `{ clientNodeId, workspaceName, workspacePath }` and `resolvedTarget.workspacePath` (`src/daemon/control-protocol.ts:219-244`); the TUI reconstructs authorization from it for relay serving.

**Git helpers.** No `git worktree` invocation exists anywhere in `src/`. `src/core/review.ts:108-125` has a private promise-wrapped `spawn` runner; `src/utils/child-process.ts:18-36` provides the cross-platform `spawnProcess`/`waitForChildProcess` seam.

**CLI.** `volt remote <cmd>` routes through `handleRemoteControlCommand` (`src/daemon/remote-cli.ts`), which talks to the daemon over the control socket using `ControlRequest` types (`src/daemon/control-protocol.ts:50-70`, e.g. `workspace_register` at line 67, handled in `src/daemon/main.ts:308+`).

---

## 3. Goals / Non-goals

### Goals

1. A session can optionally run in a daemon-managed git worktree, isolated from the main checkout and from other worktrees of the same workspace.
2. Worktree lifecycle (create/list/remove/prune) is controllable from the mobile app (iroh management stream) and the CLI; Phase 2 adds the TUI.
3. Sessions stay keyed and listable **under the parent workspace** — `list_sessions`, `target:"session"`, `target:"last"`, push notifications, and leases keep the `(workspaceName, sessionId)` model.
4. Resume of a worktree-bound session (daemon restart, phone reattach, TUI takeover) lands in the worktree cwd.
5. Worktree runtimes inherit the parent workspace's trust decision and tool allowlist — **never wider**.
6. No absolute host paths cross the wire: paths are computed server-side; the sanitizer covers both the worktree path and the parent path.
7. Full backward compatibility: old app builds, old state files, old daemons keep working; new features are gated on `worktrees.v1`.

### Non-goals

- Automatic merge/rebase of worktree branches back into the base branch (Phase 3 provides *guidance* UX only; git operations stay user-initiated).
- Dependency bootstrap inside worktrees (`node_modules`, venvs) — documented limitation, see §6.
- Multiple concurrent runtimes for the *same* sessionId in different worktrees (sessions are single-cwd by construction).
- Worktrees for non-git workspaces, submodule-heavy special-casing, or bare-repo workspaces beyond a clean error.
- Changing the TUI's default behavior when launched inside an arbitrary directory.

---

## 4. High-level proposal

Model a worktree as a **child resource of a registered workspace**, not as a workspace of its own. The alternative — auto-registering each worktree as a separate workspace — was considered and rejected: it fragments pairing/allowlists (`allowedWorkspaces` is per-client), splits `lastSessionIdByWorkspace`, breaks the one-name-per-repo mental model in the app, collides with the NFC-lowercase name-alias check in `upsertIrohRemoteWorkspace` (`src/core/remote/iroh/workspace.ts:53-86`), and multiplies unregister/cleanup paths. Keeping the parent workspace as the authorization and keying unit means the only new state is a worktree table plus a session binding, and the only cwd change is at the two runtime-creation choke points.

Storage layout:

```
~/.volt/agent/worktrees/                      (0700)
  --<encoded-workspace-path>--/               (same encoding as session dirs)
    <worktreeId>/                             (the git worktree checkout)
```

Keying the directory by encoded workspace *path* (reusing the `--…--` scheme from `getDefaultSessionDirPath`) rather than workspace *name* survives workspace renames and name collisions.

---

## 5. Detailed design

### 5.1 Phase 1 — foundation

#### 5.1.1 New module: `src/daemon/worktree-manager.ts`

```ts
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";

/** join(agentDir, "worktrees") — sibling of sessions/, daemon/, trust.json. */
export function getWorktreesRoot(agentDir: string): string;

/** Deterministic checkout path; never accepts a caller-supplied path. */
export function getWorktreeCheckoutPath(agentDir: string, workspacePath: string, worktreeId: string): string;

export const WORKTREE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type WorktreeError =
  | "not_a_git_repository"
  | "worktree_exists"
  | "worktree_branch_conflict"
  | "worktree_not_found"
  | "worktree_dirty"
  | "worktree_busy"          // has an active runtime / bound streaming session
  | "worktree_limit_reached"
  | "invalid_worktree_id"
  | "git_failed";

export interface WorktreeGitRunner {
  (args: string[], cwd: string): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>;
}

export interface WorktreeManagerOptions {
  agentDir: string;
  stateManager: IrohRemoteHostStateManager;
  auditLogger: IrohRemoteAuditLogger;
  /** Injectable for tests; defaults to spawnProcess/waitForChildProcess wrapper. */
  runGit?: WorktreeGitRunner;
  /** Injectable for tests / policy: max worktrees per workspace (default 16). */
  maxWorktreesPerWorkspace?: number;
  /** Seam for "is a runtime using this worktree" (wired to IntegratedRuntimeRegistry). */
  hasActiveRuntimeForSession?: (workspaceName: string, sessionId: string) => boolean;
}

export interface WorktreeStatus extends IrohRemoteWorkspaceWorktree {
  /** Checkout directory exists and `git worktree list` still knows it. */
  available: boolean;
  /** `git status --porcelain` non-empty (best-effort; undefined when unavailable). */
  dirty?: boolean;
}

export class WorktreeManager {
  constructor(options: WorktreeManagerOptions);

  /** git worktree add; persists the record via stateManager with flush(). */
  create(workspace: IrohRemoteWorkspace, options: {
    id?: string;          // default: generated slug (adjective-noun-nn)
    branch?: string;      // default: `volt/<id>`
    baseRef?: string;     // default: HEAD of the main checkout
  }): Promise<{ ok: true; worktree: IrohRemoteWorkspaceWorktree } | { ok: false; error: WorktreeError; detail?: string }>;

  list(workspace: IrohRemoteWorkspace): Promise<WorktreeStatus[]>;

  /** Refuses dirty/busy unless force; `git worktree remove [--force]`, then drops the record. */
  remove(workspace: IrohRemoteWorkspace, worktreeId: string, options?: { force?: boolean }):
    Promise<{ ok: true } | { ok: false; error: WorktreeError; detail?: string }>;

  /** Reconcile persisted records vs filesystem vs `git worktree list --porcelain`;
   *  runs `git worktree prune` in the main checkout. Safe to run on daemon start. */
  prune(workspace: IrohRemoteWorkspace): Promise<{ removedRecords: string[]; orphanCheckouts: string[] }>;

  /** Lookup used by conversation open/resume and relay preamble resolution. */
  resolveSessionWorktree(workspaceName: string, sessionId: string): Promise<IrohRemoteWorkspaceWorktree | undefined>;
  bindSession(workspaceName: string, worktreeId: string, sessionId: string): Promise<void>;
}
```

Git invocations (always executed with `cwd = workspace.path`, i.e. the main checkout — never a caller path):

| Operation | Command |
|---|---|
| validate repo | `git rev-parse --git-common-dir` |
| create | `git worktree add <checkoutPath> -b <branch> <baseRef>` |
| enumerate | `git worktree list --porcelain` |
| remove | `git worktree remove [--force] <checkoutPath>` |
| prune | `git worktree prune` |
| dirty check | `git -C <checkoutPath> status --porcelain --no-optional-locks` |

The default `runGit` is a ~15-line wrapper over `spawnProcess` + `waitForChildProcess` (`src/utils/child-process.ts:18-36, 49+`) with `stdio: ["ignore","pipe","pipe"]`, mirroring the private `runCommand` in `src/core/review.ts:108-125` (which stays private; do not export it — its error shape is review-specific).

**Path containment invariant:** `getWorktreeCheckoutPath` is the only producer of checkout paths; it validates `worktreeId` against `WORKTREE_ID_PATTERN`, then asserts `resolve(path)` starts with `resolve(getWorktreesRoot(agentDir)) + sep` before any git call. RPCs and control commands accept **ids and refs only, never paths** (branch/baseRef are validated with `git check-ref-format`-equivalent syntax checks and passed as separate argv entries, never shell-interpolated).

#### 5.1.2 State schema

Add the worktree table to the host state (so the existing operation-queue/state-manager machinery applies), and thread it through all five enumeration sites.

`src/core/remote/iroh/state.ts`:

```ts
export interface IrohRemoteWorkspaceWorktree {
  /** ^[a-z0-9][a-z0-9._-]{0,63}$ — unique per workspace. */
  id: string;
  workspaceName: string;
  /** Absolute checkout path under getWorktreesRoot(agentDir); host-local, never sent on the wire. */
  path: string;
  branch: string;
  baseRef?: string;
  createdAt: number;
  /** Sessions bound to this worktree (usually exactly one). */
  sessionIds: string[];
}

export interface IrohRemoteHostState {
  hostSecretKey?: number[];
  pairingSecretTombstones?: IrohRemotePairingSecretTombstone[];
  workspaces: IrohRemoteWorkspace[];
  worktrees?: IrohRemoteWorkspaceWorktree[];        // NEW (optional ⇒ old files parse)
  clients: IrohRemoteClient[];
  revokedClients?: IrohRemoteRevokedClient[];
  pendingPairingTickets?: IrohRemotePendingPairingTicket[];
}
```

Parse/serialize/clone changes (all five sites are field-enumerating today, so each must be touched):

1. `parseIrohRemoteHostState` (state.ts:132-150): add
   ```ts
   worktrees: parseOptionalArray(state.worktrees, "worktrees", parseIrohRemoteWorkspaceWorktree),
   ```
   with a new strict parser:
   ```ts
   export function parseIrohRemoteWorkspaceWorktree(value: unknown): IrohRemoteWorkspaceWorktree {
     const worktree = expectRecord(value, "Iroh remote worktree");
     const baseRef = expectOptionalString(worktree.baseRef, "worktree baseRef");
     return {
       id: expectWorktreeId(worktree.id),                    // pattern check, non-empty
       workspaceName: expectString(worktree.workspaceName, "worktree workspaceName"),
       path: expectString(worktree.path, "worktree path"),
       branch: expectString(worktree.branch, "worktree branch"),
       ...(baseRef === undefined ? {} : { baseRef }),
       createdAt: expectNumber(worktree.createdAt, "worktree createdAt"),
       sessionIds: parseArray(worktree.sessionIds, "worktree sessionIds",
         (entry) => expectString(entry, "worktree session id")),
     };
   }
   ```
2. `serializeIrohRemoteHostState` (state.ts:152-193): add `worktrees: (state.worktrees ?? []).map((w) => ({ ...w, sessionIds: [...w.sessionIds] }))`.
3. `src/daemon/state.ts` — `VoltdStateFileV1` gains `worktrees: IrohRemoteWorkspaceWorktree[]`; `createEmptyVoltdState` initializes `[]`; **both** `voltdStateToHostState` and `hostStateToVoltdState` (state.ts:69-94) copy it (`hostState.worktrees ?? []` on the return trip). `parseVoltdState` needs no change beyond what `parseIrohRemoteHostState` provides, since it already delegates (line 105).
4. `cloneHostState` (`src/core/remote/iroh/state-manager.ts:635-646`): add `worktrees: (state.worktrees ?? []).map(cloneWorktree)`.
5. `IrohRemoteHostStateManager` (state-manager.ts:75+): new queued methods, mirroring `upsertWorkspace`/`unregisterWorkspace`:
   ```ts
   upsertWorktree(worktree: IrohRemoteWorkspaceWorktree): Promise<IrohRemoteWorkspaceWorktree>;
   removeWorktree(workspaceName: string, worktreeId: string): Promise<IrohRemoteWorkspaceWorktree | undefined>;
   listWorktrees(workspaceName?: string): Promise<IrohRemoteWorkspaceWorktree[]>;
   bindWorktreeSession(workspaceName: string, worktreeId: string, sessionId: string): Promise<void>;
   findWorktreeForSession(workspaceName: string, sessionId: string): Promise<IrohRemoteWorkspaceWorktree | undefined>;
   ```
   `unregisterWorkspace` (state-manager.ts:123-137) checks `state.worktrees` for the workspace inside the same exclusive state mutation. If any child exists it throws the structured `workspace_has_worktrees` conflict without changing the workspace, worktree records, pending tickets, or filesystem. The user must explicitly remove each worktree first; unregister never owns checkout deletion (§5.1.6).

Durability rule: `create` persists via `VoltdStateStore.flush()` (state.ts:306-315 pattern, as used for the freshly minted iroh key at `iroh-service.ts:513-521`) **after** `git worktree add` succeeds, so a crash window leaves at worst an orphan checkout (reconciled by `prune`), never a record pointing at nothing that a subsequent create could double-book. Bindings (`bindWorktreeSession`) also use `flush()` — low-frequency, and a lost binding degrades to a resume in the wrong cwd.

#### 5.1.3 Management-stream RPCs

Add a new management purpose rather than widening the existing `unregister_workspace` stream, keeping the one-purpose-per-stream property the protocol doc promises ("Discovery and management payloads reject unknown purposes and unexpected fields", `docs/iroh-remote-protocol.md:76-82`).

`handshake.ts`:

```ts
export interface IrohRemoteWorkspaceManagementTarget {
  purpose: "unregister_workspace" | "manage_worktrees";   // widened union
}
```

`parseWorkspaceManagementTarget` (handshake.ts:479-491) accepts `"manage_worktrees"` in addition to `"unregister_workspace"`; the response-side `parseWorkspaceManagementResponseMetadata` is widened symmetrically. Old daemons reject `manage_worktrees` hellos with `invalid_conversation_target` — which is exactly why clients must gate on `worktrees.v1` (§5.1.8) before opening the stream.

New commands on the `manage_worktrees` stream (`src/daemon/workspace-streams.ts`, new `runWorktreeManagementStream` alongside `runWorkspaceManagementStream`, same JSONL framing, same strict-parse conventions as `parseWorkspaceManagementUnregisterRequest`):

**create_worktree**

```jsonc
// request — field allowlist: id, type, workspaceName, worktreeName?, branch?, baseRef?
{"id":"1","type":"create_worktree","workspaceName":"myrepo","worktreeName":"fix-login","baseRef":"main"}

// success (createRpcSuccessResponse shape) — NOTE: no filesystem paths on the wire
{"id":"1","type":"response","command":"create_worktree","success":true,
 "data":{"worktree":{"id":"fix-login","branch":"volt/fix-login","baseRef":"main","createdAt":1751900000000,"sessionIds":[]}}}

// failure (createIrohRemoteRpcErrorResponse shape)
{"id":"1","type":"response","command":"create_worktree","success":false,"error":"worktree_branch_conflict"}
```

**list_worktrees**

```jsonc
{"id":"2","type":"list_worktrees","workspaceName":"myrepo"}

{"id":"2","type":"response","command":"list_worktrees","success":true,
 "data":{"worktrees":[
   {"id":"fix-login","branch":"volt/fix-login","createdAt":1751900000000,
    "sessionIds":["s-abc"],"available":true,"dirty":false}]}}
```

**remove_worktree**

```jsonc
// field allowlist: id, type, workspaceName, worktreeId, force?
{"id":"3","type":"remove_worktree","workspaceName":"myrepo","worktreeId":"fix-login","force":false}

{"id":"3","type":"response","command":"remove_worktree","success":true,
 "data":{"worktreeId":"fix-login","removed":true,"stoppedRuntimeCount":1,"closedStreamCount":1}}
```

Validation rules, matching the unregister precedent exactly:

- `workspaceName` must equal `authorization.workspace.name` → else `session_mismatch`.
- Any field outside the allowlist → `invalid_request`.
- Commands other than the three above → `unsupported_on_workspace_management_stream` (reuse the existing error string; the stream *is* a workspaceManagement stream).
- No `path` field is accepted anywhere; a request carrying one is `invalid_request`.
- `remove_worktree` with active runtimes bound to the worktree: without `force` → `worktree_busy`; with `force`, stop those runtimes via `IntegratedRuntimeRegistry.stopEntry` first (mirroring `cleanupUnregisteredWorkspace`, `iroh-service.ts:1631-1651`), then `git worktree remove --force`.

Each command writes an audit event (`src/core/remote/iroh/audit.ts:4-12` free-form shape): `{type:"worktree_created"|"worktree_removed"|"worktree_pruned", clientNodeId, workspace:<name>, success, details:{worktreeId, branch?, force?, stoppedRuntimeCount?}}`.

The pure-state RPC helpers live in a new `src/core/remote/iroh/worktree-rpc.ts` mirroring `workspace-rpc.ts:44-94` (`handleIrohRemoteWorktreeRpcCommand` handling all three types), so the conversation-stream dispatch (`handleRemoteHostRpcCommand`, `src/daemon/conversation-commands.ts:1433-1482`) and the relay path can reuse them later if we choose to also expose these on conversation streams (Open Question 1).

#### 5.1.4 Handshake extension: `target:"new"` into a worktree

Phase 1 deliberately requires the worktree to be **created first** via `create_worktree` and only *referenced* at conversation open. Creating a worktree inline during the handshake would put a multi-second `git worktree add` inside `DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS` — rejected.

```jsonc
{"type":"volt_iroh_hello","protocol":"volt-rpc/0","workspace":"myrepo",
 "conversation":{"target":"new","worktreeId":"fix-login"}}
```

Type change (`handshake.ts:18-28`):

```ts
export type IrohRemoteConversationTarget =
  | { target: "last" }
  | { target: "new"; worktreeId?: string }
  | { target: "session"; sessionId: string };
```

`parseConversationTarget` changes (handshake.ts:438-462):

- Widen the allowlist: `expectKnownFields(target, "handshake conversation", ["target", "sessionId", "worktreeId"])`.
- `worktreeId` is permitted **only** when `target === "new"`; on `"last"`/`"session"` it throws `invalid_conversation_target` ("… must not include worktreeId") — resume targets derive the worktree from the persisted binding, never from the client, so a client cannot re-point an existing session at a different checkout.
- `worktreeId` must be a string matching `WORKTREE_ID_PATTERN` (add `expectWorktreeId` beside `expectRemoteSessionId`, handshake.ts:513-522).

Success-response metadata (`IrohRemoteConversationHandshakeMetadata`, handshake.ts:32-37) gains optional `worktreeId?: string`, and the response-side allowlist in `parseOptionalHandshakeSuccessMode`'s `conversation` check (`expectKnownResponseFields`) is widened to include it. Old clients that parse responses strictly never see the field because they never send worktree hellos (the daemon echoes `worktreeId` only for worktree-bound conversations, and only worktree-capable clients can create those).

**Failure outcomes.** `IROH_REMOTE_OUTCOMES` (`protocol.ts:19-37`) is a closed enum on both sides, so Phase 1 does **not** add a new outcome value. An unknown/unavailable `worktreeId` on `target:"new"` fails with the existing `invalid_conversation_target`; a resume whose bound worktree checkout has vanished fails with the existing `session_unavailable`. A dedicated `worktree_unavailable` outcome is deferred to a later protocol revision (Open Question 3).

#### 5.1.5 cwd plumbing

Exact touch points:

1. **`IntegratedRuntimeRegistry`** (`src/daemon/integrated-runtimes.ts`):
   - `IntegratedRuntimeRegistryOptions` gains `resolveWorktree: (workspaceName: string, hello: IrohRemoteHello, targetSessionId: string | undefined) => Promise<IrohRemoteWorkspaceWorktree | undefined>` and `bindWorktreeSession(...)` seams, wired to the `WorktreeManager` in `IrohDaemonService` (constructor wiring at `iroh-service.ts:349-366`).
   - `createEntry` (lines 218-260): before building the runtime, resolve the worktree —
     - `hello.conversation.target === "new"` with `worktreeId` → `resolveWorktree` must return that record (available on disk) or throw `createConversationOpenError("invalid_conversation_target", …)`;
     - `target === "session"` / `"last"` with a resolved id → `findWorktreeForSession(workspaceName, targetSessionId)`.
   - The factory call becomes:
     ```ts
     const runtimeResult = await (this.options.createRuntime ?? createIrohRemoteAgentRuntimeWithSessionSelection)({
       agentDir: this.options.agentDir,
       allowTools: this.options.getAllowTools(authorization.workspace) ?? authorization.allowTools,
       conversationTarget: createIrohRuntimeConversationTarget(handshake.hello, authorization),
       cwd: worktree?.path ?? authorization.workspace.path,                       // CHANGED
       sessionDir: getDefaultSessionDir(authorization.workspace.path, this.options.agentDir), // NEW — always parent-keyed
       onSubagentRuntimeCreated: (event) => this.registerSubagentRuntime(event, authorization),
       profile: this.options.profile,
       projectTrusted: this.options.getProjectTrustedForWorkspace(authorization.workspace),   // unchanged: parent path
     });
     ```
     Note `sessionDir` is now passed for *all* daemon runtimes (worktree or not); for the non-worktree case it is identical to today's derived default, so behavior is unchanged.
   - After a `created` selection for a worktree conversation, call `bindWorktreeSession(workspaceName, worktree.id, sessionId)`. `IntegratedRuntimeEntry` gains `worktreeId?: string` for cleanup/audit.
2. **`createIrohRemoteAgentRuntimeWithSessionSelection`** (`src/modes/rpc/iroh-remote-agent-runtime.ts`): **no changes needed** — the existing `sessionDir` option (line 37) already flows to `createSessionManagerTargetStore(options.cwd, options.sessionDir ?? …)` (lines 168-176), and `SessionManager.create(cwd, sessionDir)` / `open(path, sessionDir, cwd)` (`session-target.ts:100-118`) already produce worktree-cwd headers inside the parent dir.
3. **Relay preamble resolution** (`iroh-service.ts:1055-1068`): before `resolveIrohRemoteSessionTarget`, look up `findWorktreeForSession`; when bound, build the store as `createSessionManagerTargetStore(worktree.path, getDefaultSessionDir(authorization.workspace.path, this.services.agentDir))`. (The `filterCwd` behavior of `SessionManager.list` — custom dir + non-matching cwd ⇒ filter by header cwd, `session-manager.ts:1570-1576` — then correctly restricts resolution to that worktree's sessions.)
4. **Sanitizer** (`getRemoteSanitizerOptions`, `workspace-streams.ts:64-72`, and the conversation path at `iroh-service.ts:1439-1441`): for worktree-bound streams, `workspacePath` becomes `worktree.path` (so `cwd`/`path` strict fields map to `/workspace`), **and** the parent `workspace.path` must still be redacted (bash output can mention it via `git worktree list`, `.git` gitdir pointers, etc.). Extend `IrohRemoteOutboundSanitizerOptions` (`outbound-filter.ts:28-32`) with `additionalRedactedPaths?: string[]`; `createSanitizerContext` folds their normalization/separator variants into `workspacePathVariants` (all mapping to `remoteWorkspacePath`).
5. **Availability validation:** `authorizeClient`'s `validateWorkspace` hook (`state-manager.ts:163-186`) stays parent-based; worktree availability is checked at conversation open in `createEntry` (a missing checkout is an open-time failure, not an authorization failure, so discovery/management streams keep working while a worktree is broken).

#### 5.1.6 Lifecycle interactions

- **Workspace unregister:** refuse before changing state when any persisted child worktree exists. The stable conflict is `workspace_has_worktrees`; clients show the worktrees and require explicit `remove_worktree` operations. Dirty, unmerged, busy, missing-checkout, and clean records all block equally, so the state layer never needs to infer whether data is disposable. Per-worktree `force:true` remains the only destructive opt-in and stops bound runtimes first. Once no records remain, unregister may close streams/runtimes and workspace-scoped relays, but it never removes the workspace worktrees directory or unknown/orphan checkout directories. The retained `cleanupUnregisteredWorkspace` compatibility guard is inspection/audit-only and performs no git or filesystem mutation.
- **Detached-runtime retention** (`integrated-runtimes.ts:735-760` sweep): Phase 1 does **not** delete worktrees when a runtime is swept — the checkout may hold uncommitted work; the sessionId→worktree binding persists so the session can be resumed later into the same worktree. Cleanup policy is Phase 3.
- **`lastSessionIdByWorkspace`** (`state.ts:57`, consumed at `integrated-runtimes.ts:100-116`): unchanged. `target:"last"` may resolve to a worktree-bound session; the binding lookup in §5.1.5(1) makes that resume land in the worktree. This is by design (last means last).
- **Push notifications:** keyed `{workspaceName, sessionId}` — no change needed.

#### 5.1.7 Session-dir keying decision (normative)

**Decision: worktree sessions are stored in the parent workspace's default session dir (`getDefaultSessionDir(workspace.path, agentDir)`) with `header.cwd = worktree.path`.**

Rationale:

- `list_sessions` uses `SessionManager.list(workspace.path, getDefaultSessionDir(workspace.path, agentDir))` (`conversation-commands.ts:984-990`); because that dir equals `getDefaultSessionDirPath(workspace.path)` when `agentDir` matches the env-aware default, `filterCwd` is false and worktree sessions **appear in the workspace's session list with zero changes**. The alternative (letting `getDefaultSessionDirPath` encode the worktree cwd) makes worktree sessions permanently invisible to the app.
- `target:"session"` resume works: the daemon consults the persisted binding first, then opens with `SessionManager.open(path, parentDir, worktree.path)` — never trusting the header alone, so a deleted-then-recreated worktree at the same path is fine, and a *missing* worktree fails deterministically instead of resurrecting a dead cwd (which is what bare `SessionManager.open`'s header-cwd default would do, session-manager.ts:1477).
- `lastSessionIdByWorkspace` and lease/registry keys stay `(workspaceName, sessionId)`.
- No wire change: `RemoteSessionListEntry` carries no paths (`conversation-commands.ts:953-970`). Worktree attribution in the list UI comes from `list_worktrees.sessionIds`, not from the session list (a `worktreeId` field on the session summary is a compatible later addition since the summary is host-constructed).

Caveat to document: `SessionManager.list`'s `filterCwd` compares against `getDefaultSessionDirPath(cwd)` with the *default* agentDir; a caller passing a non-default `agentDir` inconsistent with `$VOLT_CODING_AGENT_DIR` would flip the filter on and hide worktree sessions. The daemon always uses `services.agentDir` = env-aware `getAgentDir()`, so this is a latent footgun, not a live bug; a Phase 1 test pins it.

#### 5.1.8 Capability flag

`src/core/remote/iroh/protocol.ts:5-10`:

```ts
export const IROH_REMOTE_WORKTREES_FEATURE = "worktrees.v1";
export const IROH_REMOTE_HOST_FEATURES = [
  IROH_REMOTE_MULTI_STREAMS_FEATURE,
  IROH_REMOTE_CONVERSATION_STREAMS_FEATURE,
  IROH_REMOTE_WORKTREES_FEATURE,
] as const;
```

This flows automatically into every handshake success (`engine.createHandshakeSuccessResponse`, `src/core/remote/iroh/engine.ts:478-496`) and `remoteHost` metadata (`metadata.ts:31-43`). **Do not** add it to `assertRequiredHandshakeFeatures` (handshake.ts:629-638) — it is optional. Clients must check for `worktrees.v1` before (a) sending `worktreeId` in a hello or (b) opening a `manage_worktrees` stream; old hosts reject both with `invalid_conversation_target`.

A later `worktrees.v2` can add inline-create or new outcomes.

#### 5.1.9 Trust and allowedTools inheritance (normative)

**Rule: a worktree runtime uses exactly the parent workspace's policy. It can never be wider.**

- `allowTools`: unchanged call `this.options.getAllowTools(authorization.workspace)` (`integrated-runtimes.ts:227`) — the workspace record *is* the parent; there is no per-worktree `allowedTools` field, deliberately.
- `projectTrusted`: unchanged call `getProjectTrustedForWorkspace(authorization.workspace)` (`integrated-runtimes.ts:232` → `host-policy.ts:15-29`), i.e. trust is always evaluated against **`workspace.path`**, never the worktree checkout path. The worktree contains a branch of the same repository the user already made a trust decision about; evaluating `hasTrustRequiringProjectResources` against a path under `~/.volt/agent/worktrees` would walk `~/.volt/agent` ancestors, which is meaningless, and would invite trust prompts the daemon cannot surface.
- Corollary: **never write trust.json entries for worktree paths** (an entry for `~/.volt/agent/worktrees` would, via `findNearestTrustEntry`'s ancestor walk, blanket-trust every future worktree of every workspace).
- Known asymmetry, accepted: a *branch* checked out in a worktree could contain a `.mcp.json`/`.volt` config that the trunk (against which trust was decided) does not. This is identical in kind to `git checkout <branch>` in the main checkout today, which also does not re-prompt. Documented in Security (§7), not mitigated in Phase 1.

#### 5.1.10 CLI: `volt remote worktree …`

New control requests (`src/daemon/control-protocol.ts` `ControlRequest` union, beside `workspace_register` at line 67) and handlers in `src/daemon/main.ts` (beside `workspace_register` at line 308):

```ts
| { type: "worktree_create"; id: string; workspaceName: string; worktreeName?: string; branch?: string; baseRef?: string }
| { type: "worktree_list";   id: string; workspaceName?: string }
| { type: "worktree_remove"; id: string; workspaceName: string; worktreeId: string; force?: boolean }
| { type: "worktree_prune";  id: string; workspaceName?: string }
```

`src/daemon/remote-cli.ts` gains a `worktree` command group in `handleRemoteControlCommand`'s switch and `printRemoteUsage`:

```
volt remote worktree add [--workspace <name>] [--name <id>] [--branch <ref>] [--base <ref>]
volt remote worktree list [--workspace <name>] [--json]
volt remote worktree remove <id> [--workspace <name>] [--force]
volt remote worktree prune [--workspace <name>]
```

`--workspace` defaults via the same cwd-prefix match used by `handlePairCommand` (remote-cli.ts:118-137). The control plane is local-socket-only (trusted user), so responses *may* include checkout paths for display — the no-paths rule applies to the iroh wire, not the control socket.

---

### 5.2 Phase 2 — TUI

#### 5.2.1 New session into a worktree from the TUI

Flow: TUI issues `worktree_create` over the control socket (daemon must be running; if not, offer to start it, reusing `ensureDaemonRunning`), then starts a **new local session with an explicit cwd override** equal to the worktree path and `sessionDir = getDefaultSessionDir(<parent path>)`.

Implementation surface: the TUI's runtime today uses its own process cwd. `SessionManager.create(cwd, sessionDir)` supports arbitrary cwd/sessionDir (session-manager.ts:1461-1464), and `interactive-mode.ts` constructs its session manager at startup — the change is threading an optional `{ cwd, sessionDir }` override through interactive-mode session creation and the `/worktree new` command UI. **Phase 2 requires an audit of every cwd consumer inside interactive mode (footer git status, extension discovery, `.volt` settings resolution).** Settings/trust note: `SettingsManager.create(worktreePath, …)` will read the worktree's `.volt` project settings — same content as the repo branch; trust must again be pinned to the parent path (the TUI trust prompt flow should recognize daemon-managed worktree paths via `worktree_resolve`, below, and skip re-prompting by reusing the parent decision).

#### 5.2.2 Fixing the auto-registration trap

`createDaemonAttach.resolveWorkspace` (daemon-attach.ts:192-229) prefix-matches the TUI cwd against workspace paths and otherwise **auto-registers a new workspace**. A TUI launched inside `~/.volt/agent/worktrees/--…--/fix-login` would silently mint a bogus workspace, splitting lease keys from the daemon's worktree conversations.

Fix: add control request `{ type: "worktree_resolve"; id: string; path: string }` → `{ workspaceName, worktreeId } | not_found`. `resolveWorkspace` calls it before the auto-register fallback; on a hit, it uses the **parent workspace name** for `lease_acquire`, so lease keys stay `(parentWorkspaceName, sessionId)` and co-attach/relay work identically to main-checkout sessions.

#### 5.2.3 Lease takeover with the worktree cwd

- **Session file reload (warm/cold handoff, `interactive-mode.ts:1824-1841`):** the session header cwd *is* the worktree path, so `SessionManager.open` without override already yields the worktree cwd. The TUI must additionally verify the checkout exists and refuse takeover with a clear error when it does not (rather than resurrecting a ghost cwd — session-manager.ts:1477 behavior).
- **Relay serving after takeover:** the TUI builds its serving authorization from `RelayPreamble.authorization` and passes `workspacePath` into `runIrohRemoteRpcMode` (interactive-mode.ts:1973-1990, 2027-2033) — sanitization would use the parent path while the runtime emits worktree paths, leaking host paths to the phone. Extend `RelayPreamble` (`control-protocol.ts:219-244`):
  ```ts
  authorization: { clientNodeId: string; workspaceName: string; workspacePath: string;
                   worktreeId?: string; worktreePath?: string };
  resolvedTarget: { /* existing fields */; worktreeId?: string };
  ```
  and `runIrohRemoteRpcMode`'s options gain the same `additionalRedactedPaths` extension from §5.1.5(4) with `workspacePath = worktreePath ?? workspacePath`. Compatibility: control-plane `PROTOCOL_VERSION` stays 1 — new optional fields on the preamble are additive. Add a `worktrees` capability to the control `HelloMessage` (control role) so the daemon can gate relay offers per TUI; an old TUI simply never receives relays for worktree sessions (the daemon serves them itself).

---

### 5.3 Phase 3 — polish

1. **Merge-back UX.** Non-mutating guidance surfaces:
   - `list_worktrees` response gains `aheadBehind: { ahead: number; behind: number }` (computed with `git rev-list --left-right --count`, same runner). *Implementation note:* the separately proposed `hasUncommitted` field was consolidated into the existing Phase 1 `dirty` field — both are `git status --porcelain` non-empty, and shipping two names for one fact would be redundant. To make the base ref stable for later guidance, `create` resolves a defaulted base to the main checkout's current branch name (falling back to its commit sha) and persists it.
   - CLI `volt remote worktree diff <id>` (control-plane only) prints `git -C <checkout> diff <baseRef>...HEAD` locally.
   - App/TUI affordance text: suggested `git merge volt/<id>` / `git push -u origin volt/<id>` + PR instructions. Actual merges/pushes remain user actions in a shell or agent session — the daemon never mutates the main checkout.
2. **Cleanup policies** (all opt-in, persisted in `VoltdStateFileV1.settings`):
   ```ts
   settings: { /* existing */; worktreeCleanup?: {
     retention?: { enabled: boolean; ttlMs: number };    // clean worktrees only
     pruneOnStart?: boolean } }                          // default true
   ```
   *Implementation note:* the proposed `onSessionDelete` policy was deferred — the daemon has no session-deletion surface (no `delete_session` RPC or control command) to hook it to. Add it alongside whatever session-deletion surface lands first.
   - Retention sweep hooks `onRuntimeDisposed` (`integrated-runtimes.ts:75`, wired at `iroh-service.ts:364-365`) → schedule a worktree TTL; on expiry, remove **only if clean** (`git status --porcelain` empty and branch fully merged into `baseRef`), else audit `worktree_retention_skipped_dirty`.
   - `pruneOnStart`: run `WorktreeManager.prune` for every workspace during daemon startup (after state load, before endpoint bind), reconciling records ↔ filesystem ↔ `git worktree list --porcelain`; quarantine unrecognized directories under the worktrees root by renaming to `<dir>.orphan-<ts>` (never delete unrecognized content destructively).
3. **App affordances** (iOS side, out of this repo's scope but protocol-relevant): worktree picker on new-session, worktree badge in session list (join `list_worktrees.sessionIds`), dirty indicator, remove-with-confirmation.

---

## 6. Failure modes and edge cases

| Case | Behavior |
|---|---|
| **Non-git workspace** | `create_worktree` → `not_a_git_repository` (from `rev-parse --git-common-dir` failure). Conversation `target:"new"` without `worktreeId` is unaffected. |
| **Bare repo / repo with no commits** | `worktree add -b … HEAD` fails → `git_failed` with stderr detail (sanitized: strip absolute paths before putting stderr in RPC detail). |
| **Branch name conflict** | `git worktree add -b` refuses existing branches → map to `worktree_branch_conflict`; client may retry with explicit `branch`. No auto-suffixing (surprise branches are worse than an error). Duplicate `worktreeId` → `worktree_exists` (checked against state *and* filesystem before git runs). |
| **Dirty / locked worktree on remove** | `git worktree remove` refuses dirty/locked → `worktree_dirty` (no force) with `dirty:true` detail; `--force` path stops bound runtimes first (§5.1.3). Locked worktrees (`git worktree lock`) surface as `git_failed` detail; we never auto-unlock. |
| **Workspace unregister with child worktrees** | Refuse atomically with `workspace_has_worktrees`. Preserve the workspace record, every child record, all runtimes/checkouts, and unknown directories. The user lists and removes children individually; only per-worktree `force:true` can discard dirty or busy work. |
| **Worktree deleted out-of-band** | `list_worktrees` reports `available:false`. Conversation open referencing it → `invalid_conversation_target` (new) / `session_unavailable` (resume). `prune` drops the record and runs `git worktree prune` to clear the stale gitdir entry. Session files remain (parent dir) and can be viewed read-only. |
| **Daemon crash mid-create** | Order is: git add (idempotent-checkable) → state record → `flush()`. Crash before flush leaves an orphan checkout + branch, reconciled by `pruneOnStart` (which detects checkouts with no record and quarantines/adopts per policy). Crash after flush is fully consistent. |
| **Debounced-write loss** | Bindings written debounced could lose ≤250 ms on hard kill (`DEFAULT_STATE_DEBOUNCE_MS`, state.ts:180); a lost binding degrades to "resume lands in the parent cwd" — wrong but safe. Mitigation: `bindWorktreeSession` uses `flush()`, since it's low-frequency. |
| **Windows** | Checkout paths under `%USERPROFILE%\.volt\agent\worktrees\--…--\<id>` can approach MAX_PATH with the encoded workspace path; mitigate by hashing the encoded segment when it exceeds ~80 chars (`--<prefix>-<sha1-8>--`). Use `spawnProcess` (cross-spawn on win32). `git worktree` requires `core.longpaths` for deep repos — surface the git error verbatim in `detail`. Path-containment checks must compare case-insensitively on win32 and use `path.sep`-aware prefix checks. The sanitizer already generates both separator variants (outbound-filter.ts:131-140). |
| **Untracked deps (`node_modules`, venvs, build caches)** | Worktrees share git objects but not untracked files: a fresh worktree has no `node_modules`. Phase 1: documented limitation + `create_worktree` response is fast precisely because we do **not** bootstrap. Phase 3 open question: optional post-create hook (`.volt/worktree-init` script) — deliberately *not* proposed now because it executes repo-controlled code and interacts with trust (§7). |
| **Concurrent creates, same id** | State-manager operation queue (`runExclusive`) serializes record insertion; second create sees the record → `worktree_exists` before touching git. |
| **`git` missing / launchd PATH** | A service-installed daemon may have a minimal PATH. `WorktreeManager` resolves git once at first use (`spawnProcess("git", ["--version"])`), caches the result, and returns `git_failed` with a "git not found on daemon PATH; see docs/daemon.md" detail. Verification item for Phase 1: test under `launchctl`-spawned voltd (`service-install.ts` env). |
| **Worktree of a worktree / registered workspace is itself a worktree** | `--git-common-dir` resolves to the main repo; git handles this natively. No special-casing, but add a test. |
| **Session forked/branched (`SessionManager.forkFrom`)** | Fork rewrites header cwd to the target cwd (session-manager.ts:1509-1560); a fork of a worktree session into the parent cwd detaches from the worktree by construction — acceptable. |

---

## 7. Security considerations

1. **Path containment.** The iroh wire never carries filesystem paths inbound: `create_worktree`/`remove_worktree` accept ids/refs only; checkout paths are computed solely by `getWorktreeCheckoutPath` with pattern-validated ids and a resolve-plus-prefix assertion under `getWorktreesRoot`. Any request containing `path`/`workspacePath` fields is `invalid_request` (same defense `workspace-rpc.ts:96-100` uses today).
2. **No argv/shell injection.** All git calls use `spawnProcess(command, argsArray)` — no shell. `branch`/`baseRef` are syntax-validated (reject leading `-` to prevent option injection, plus ref-format checks) and always passed as separate argv entries.
3. **No policy widening.** §5.1.9: parent `allowTools`, parent trust, no per-worktree overrides, no trust.json writes for worktree paths. The daemon settings `allowTools` override (`iroh-service.ts:429-435`) continues to dominate.
4. **Branch-content trust gap (accepted risk).** A worktree checks out a branch whose `.volt`/`.mcp.json` may differ from what was trusted. Equivalent to in-place `git checkout`; called out in docs. Mitigation lever if needed later: evaluate `hasTrustRequiringProjectResources(worktree.path)` and *deny* (not prompt) when the worktree introduces trust-requiring resources absent from the parent — deferred, since it produces false positives on any repo that already has them.
5. **Outbound path hygiene.** Worktree streams sanitize with root = worktree path **and** `additionalRedactedPaths = [workspace.path, getWorktreesRoot(agentDir)]`, so neither the parent checkout path nor the agent-dir layout leaks (bash output like `git worktree list` prints both). Git stderr embedded in RPC `detail` fields passes through the same sanitizer because `writeIrohRemoteJsonLine` already sanitizes every frame (workspace-streams.ts:74-82).
6. **Filesystem hygiene.** `worktrees/` root created 0700 (matching `ensureDaemonDirs`, `paths.ts:58-65`). Prune never deletes unrecognized directories destructively (quarantine-rename, mirroring the state-file `.corrupt-<ts>` pattern, state.ts:259-272). Workspace unregister never invokes git removal or recursive deletion; it refuses while records exist and preserves unknown/orphan directories even after an empty workspace is unregistered.
7. **Resource limits.** `maxWorktreesPerWorkspace` (default 16) → `worktree_limit_reached`; prevents a paired phone from filling the disk with checkouts. Audit every create/remove with client node id.
8. **Session pinning.** Resume targets ignore client-supplied worktree hints entirely (§5.1.4); a client cannot redirect an existing session into a different checkout to exfiltrate files outside its sanitizer root.

---

## 8. Backward / forward compatibility

| Surface | Old client/state → New daemon | New client/state → Old daemon |
|---|---|---|
| **State file** | `parseIrohRemoteHostState` reads missing `worktrees` as `[]` via `parseOptionalArray` — old files load cleanly; `version` stays 1. | Old daemon reading a new file: parsers copy only known keys, so `worktrees` is **silently dropped and lost on the next write**. Checkouts survive on disk as orphans; a re-upgrade's `pruneOnStart` quarantines them. Documented downgrade caveat; no schema-version bump (rejecting the file outright would be worse). |
| **Handshake** | Old app + new daemon: identical hellos, identical parses; `worktrees.v1` in `features` is ignored by old clients (the features list is already open-ended and clients treat unknown entries as inert capabilities). | New app + old daemon: the app must gate on `worktrees.v1`; a gating client never sends `worktreeId` or `manage_worktrees`. A non-gating client gets a deterministic `invalid_conversation_target` handshake error. |
| **Management stream** | Existing successful `unregister_workspace` frames are unchanged; a workspace with child worktrees now returns the stable `workspace_has_worktrees` conflict. | `manage_worktrees` hello → `invalid_conversation_target` on old daemons (same gate as above). |
| **Conversation resume** | Old app can resume a worktree-bound session by id; the daemon resolves the binding server-side and the app transparently runs in the worktree (paths sanitized to `/workspace` either way). | After a daemon downgrade, worktree records are gone; resuming such a session opens with the session header cwd (the worktree path). If the checkout still exists it works incidentally; if not, the open fails. Documented. |
| **Control socket / relay** | Old TUI + new daemon: `RelayPreamble` additions are optional fields; old TUIs are never offered worktree-session relays (gated on the TUI's control-hello `worktrees` capability). | New TUI + old daemon: `worktree_*` control requests get the daemon's standard unknown-request error; the CLI prints "daemon does not support worktrees; restart/upgrade voltd". `PROTOCOL_VERSION` stays 1. |
| **CLI** | n/a | `volt remote worktree …` against an old daemon surfaces the unknown-request error above. |

---

## 9. Testing strategy

Repo conventions: targeted vitest runs from the package root (`node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`), `./test.sh` from the repo root for the non-e2e suite, `npm run check` after code changes. No real git required for unit tests — inject `runGit`; one integration test uses a real temp git repo.

### Phase 1

- **`test/daemon-worktree-manager.test.ts`** — unit tests with a fake `WorktreeGitRunner`: create success/limit/duplicate-id/branch-conflict/non-git mappings; remove dirty/busy/force ordering (runtimes stopped before git); prune reconciliation (record-without-checkout, checkout-without-record → quarantine); path containment (`getWorktreeCheckoutPath` rejects ids failing `WORKTREE_ID_PATTERN`, traversal attempts, and asserts the worktrees-root prefix); ref syntax validation (leading `-`, invalid ref chars). Plus one **real-git integration test** (temp repo via `git init` + commit): create → list --porcelain agreement → dirty detection → remove.
- **Workspace unregister safety** — state-level and management-stream regressions pin `workspace_has_worktrees`; dirty, unmerged, busy, and stray checkout fixtures remain present; no git runner call or recursive deletion occurs; a normal empty workspace still unregisters successfully; failed attempts are audited with worktree ids/counts.
- **State round-trip** — extend the existing state tests: `parseIrohRemoteHostState`/`serializeIrohRemoteHostState`/`cloneHostState`/`voltdStateToHostState`/`hostStateToVoltdState` preserve `worktrees`; old files without the key parse to `[]`; malformed worktree entries fail parse with the standard error shape.
- **Handshake** — `parseConversationTarget`: `worktreeId` accepted on `new`, rejected on `last`/`session`, pattern-validated; response metadata round-trip with `worktreeId`; `worktrees.v1` present in `IROH_REMOTE_HOST_FEATURES` and absent from `assertRequiredHandshakeFeatures`.
- **Management stream** — mirror the existing `unregister_workspace` stream tests for the three new commands: allowlist violations → `invalid_request`; cross-workspace name → `session_mismatch`; unknown command → `unsupported_on_workspace_management_stream`; audit events written; no `path` fields in any success payload (assert recursively).
- **Runtime plumbing** — via the injectable `createRuntime` seam in `IntegratedRuntimeRegistryOptions`: worktree-bound `new` passes `cwd = worktree.path` and parent-keyed `sessionDir`; non-worktree `new` is byte-identical to today's options; resume of a bound session resolves the binding; missing checkout at open → `invalid_conversation_target`/`session_unavailable`; `bindWorktreeSession` called exactly once after `created`.
- **Session-dir pin test** — create a session with worktree cwd in the parent session dir, then assert `SessionManager.list(parentPath, parentDir)` includes it (pins the `filterCwd` footgun in §5.1.7).
- **Sanitizer** — `additionalRedactedPaths`: parent path and worktrees root redact to `/workspace` in strings and strict fields, both separator variants, NFC/NFD variants.
- **Control protocol / CLI** — `worktree_*` request parse/dispatch in `main.ts`; `remote-cli` argument handling (`--workspace` default via cwd-prefix match, `--json` output shape).

### Phase 2

- `worktree_resolve` control request: hit → parent workspace name used for `lease_acquire` (no auto-registration); miss → existing fallback preserved.
- TUI new-session-into-worktree: session created with worktree cwd + parent sessionDir; interactive-mode cwd consumers audited with regression tests for footer git status and settings resolution under an overridden cwd.
- Takeover: `RelayPreamble` round-trip with `worktreeId`/`worktreePath`; relay serving sanitizes with the worktree path as root and parent path redacted; takeover refused with a clear error when the checkout is missing.
- Old-TUI gating: daemon does not offer worktree-session relays to control clients without the `worktrees` capability.

### Phase 3

- Retention sweep: clean+merged worktree removed on TTL expiry; dirty or unmerged worktree skipped with `worktree_retention_skipped_dirty` audit.
- `pruneOnStart`: orphan checkout quarantined (renamed, not deleted); stale record dropped; recognized checkouts untouched.
- `aheadBehind`/`hasUncommitted` computation against a real temp repo.
- Settings parse/serialize round-trip for `worktreeCleanup`.

---

## 10. Rollout and phase acceptance criteria

### Phase 1 — daemon foundation

Accepted when:
1. `volt remote worktree add/list/remove/prune` work end-to-end against a running daemon on a real git workspace.
2. A paired client (or the iroh test harness) can `create_worktree` over a `manage_worktrees` stream and open a `target:"new"` conversation with `worktreeId`; the runtime's bash tool observes `pwd` = the worktree checkout; a second concurrent session in the same workspace without a worktree observes the main checkout.
3. Daemon restart + `target:"session"` resume of the worktree-bound session lands back in the worktree.
4. `list_sessions` shows worktree-bound sessions alongside normal ones; `volt daemon status` unchanged.
5. No frame on the iroh wire contains the worktree path, the parent path, or the agent dir (sanitizer tests + a manual grep of a captured stream).
6. Old state files load; a state file written by the new daemon loads in the previous release (worktrees dropped, nothing else lost).
7. `npm run check` and `./test.sh` pass.

### Phase 2 — TUI

Accepted when:
1. `/worktree new` (or equivalent picker) in the TUI creates a worktree via the daemon and opens a session running in it.
2. A TUI can take over a phone-opened worktree session (warm and cold); the footer shows the worktree cwd; relayed phone frames remain path-sanitized.
3. A TUI launched inside a daemon-managed worktree does not auto-register a bogus workspace.
4. Old TUI + new daemon and new TUI + old daemon both degrade per §8.

### Phase 3 — polish

Accepted when:
1. `list_worktrees` reports ahead/behind and dirty status; CLI `worktree diff` works.
2. Opt-in retention removes only clean, fully merged worktrees; audit records every removal and skip.
3. `pruneOnStart` reconciles records/filesystem/git without destroying unrecognized content.
4. `docs/daemon.md` and `docs/iroh-remote-protocol.md` updated (worktree section, RPC shapes, `worktrees.v1`, downgrade caveats).

Suggested flag strategy: none needed — the feature is inert unless a client creates a worktree, and `worktrees.v1` gates the wire surface.

---

## 11. Open questions

1. **Conversation-stream exposure.** ~~Should `create_worktree`/`list_worktrees` also be accepted on conversation streams?~~ **Resolved: implemented.** Conversation streams (and the TUI-owned relay path via `RELAY_RPC_COMMAND_TYPES`) accept `create_worktree` and `list_worktrees`, dispatched through `handleRemoteHostRpcCommand` with the daemon's backend (`ConversationCommandContext.createWorktreeBackend`). `remove_worktree` stays management-stream-only.
2. **Inline create at handshake (`worktrees.v2`).** `{"target":"new","worktree":{"create":true,…}}` would save a round trip but puts git latency inside the handshake timeout. Revisit with a longer per-mode timeout or an async "creating" handshake state.
3. **Dedicated `worktree_unavailable` outcome.** `IROH_REMOTE_OUTCOMES` is a closed enum on both ends; adding a value breaks old clients that parse strictly. Bundle with the next protocol revision.
4. **Post-create bootstrap hook.** `.volt/worktree-init` (deps install) executes repo-controlled code under daemon identity — needs a trust story first. Phase 3+ at earliest.
5. **Worktree id slugs.** Generated default (`adjective-noun-nn`) vs. requiring an explicit name from clients. Current design: generated default, explicit override allowed.
6. **`worktreeId` on session summaries.** **Resolved: implemented.** `RemoteSessionListEntry.worktreeId` is joined from the persisted bindings in `listRemoteWorkspaceSessionSummaries` (ids only, best-effort). Attribution may be absent while a TUI owns the lease (the relay-side state manager has no worktree records).
