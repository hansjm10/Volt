# RFC: Live Shared Sessions: voltd Daemon, Conversation Leases, and TUI Co-Attach

- Status: Accepted (implementation-ready)
- Workspaces: `Volt/packages/coding-agent` (primary), `volt-app` (iOS deltas, section 10)
- Supersedes: the host-process model described in `docs/iroh-remote-access-design.md` (that doc gets a superseded banner; see M10)
- Amended by: [Workspace Authority Generations and Retirement](workspace-authority-lifecycle-design.md), which makes workspace generation part of every remote ownership identity and defines the mutation retirement barrier.
- Breaking changes: allowed and taken freely (pre-alpha, zero users) EXCEPT the Pi extension API contract in `src/core/extensions/types.ts` (`ExtensionContext`, `ExtensionAPI`, `ExtensionUIContext`), which MUST remain source-compatible.

All file paths in this document are relative to `Volt/packages/coding-agent/` unless prefixed with `volt-app/` or otherwise absolute. Line numbers reference the tree at design time and are anchors, not contracts; re-locate by symbol name when they drift.

---

## 1. Summary, Goals, Non-Goals

### 1.1 Summary

Today, remote iOS access requires a foreground `volt remote host` process: a 3731-line standalone ESM script (`src/remote/iroh-host.mjs`) spawned by `main.ts` (`handleRemoteCommand`, L1009-1101, spawn at L1075-1097, stdio inherit). If the user closes their terminal, the host dies, phones disconnect, and the user must remember to restart it. Worse, a conversation opened in the TUI and the same conversation opened from the phone are two *different* runtimes over the same session file, because the host keys its runtime map by `${clientNodeId}\0${workspaceName}\0${sessionId}` (`getIntegratedRuntimeRegistryKey`, iroh-host.mjs L2298) and knows nothing about the TUI.

This RFC replaces that model with:

1. **voltd** — a persistent, detached, Node-only daemon packaged inside `@hansjm10/volt-coding-agent`. It owns the stable Iroh node identity, pairing/revocation state, push notification dispatch, the workspace registry, an audit log, headless integrated runtimes, and a **conversation lease broker**. It is auto-spawned by `volt` startup when `remote.background` is enabled and is managed via `volt daemon start|stop|status|restart|logs|install-service`.
2. **Conversation leases** — exactly one owner process per `(workspaceName, workspaceGeneration, sessionId)` holds the live `AgentSessionRuntime` + `ExtensionRunner` + tools. The TUI owns leases for sessions it has open (full Pi extension fidelity, `ctx.mode === "tui"`); the daemon owns leases for headless sessions (`ctx.mode === "rpc"`, documented degradation). The lease identity **drops** `clientNodeId` but includes the exact workspace authority generation as required by the [workspace authority amendment](workspace-authority-lifecycle-design.md).
3. **Byte relay** — when the TUI owns a lease, the daemon authenticates the phone's Iroh conversation stream itself, then relays the framed JSONL bytes over the unix control socket to the TUI, which serves the stream with the existing `runIrohRemoteRpcMode(runtime, { stream: relayedStream, disposeRuntimeOnClose: false, ... })` against its in-process runtime. Phone prompts render live in the TUI because `InteractiveMode` renders user messages from `message_start` events regardless of origin (interactive-mode.ts L3008-3015).
4. **Turn-boundary handoff** in both directions, with a draining state and a read-only viewer feed so a user opening the TUI mid-remote-turn watches the turn finish before taking ownership.
5. **Abort redesign** — phone abort becomes "stop current turn" without stream closure or runtime disposal, deleting the host's `invalidateStreamAfterAbortResponse` behavior (iroh-host.mjs L1556-1564) and the iOS abort→expect-closure→reopen dance.
6. **Theme engine lift** — the module-global theme Proxy singleton (`src/modes/interactive/theme/theme.ts`) becomes an instanced `ThemeService` in `src/core/theme/`, so daemon-owned runtimes can resolve themes without a terminal and the Pi facade (`ctx.ui.theme`, `getAllThemes`, `getTheme`, `setTheme`) is preserved exactly.

The net user experience: start a task in the TUI, walk away, continue the same live conversation on the phone, come back, reopen the TUI, and see everything — with no host process to remember, no re-pairing, and no forked histories.

### 1.2 Goals

| # | Goal | Verified by |
|---|------|-------------|
| G1 | Phone can attach to the SAME live conversation a TUI has open; prompts from either side appear on both. | Integration test §12.3.3; manual script §12.5 |
| G2 | Remote host survives TUI close/reopen with zero user action (`remote.background` on). | Integration test §12.3.1 |
| G3 | Paired phones do NOT re-pair after migration (Iroh secret key preserved). | Migration unit test §12.2.4 |
| G4 | TUI open against a daemon-held session takes ownership at the next turn boundary, watching any in-flight turn read-only. | Integration test §12.3.2 |
| G5 | TUI quit hands the session back so the phone continues seamlessly (auto-reconnect, lazy daemon resume). | Integration test §12.3.2 |
| G6 | Pi extensions require zero code changes; handoff is an ordinary `session_shutdown`/`session_start` lifecycle pair. | §8; extension fixture test §12.3.4 |
| G7 | Phone abort stops the turn without closing the stream. | Unit + iOS VoltClient tests §12.4 |
| G8 | `iroh-host.mjs` deleted; host logic lives in typed TS under `src/daemon/`. | M3 acceptance criteria |

### 1.3 Non-Goals (explicit, do not implement)

- **Mid-turn ownership migration.** Handoff happens only at turn boundaries (idle). A TUI killed mid-turn loses that turn (accepted limitation; TUI warns on exit while `session.isStreaming` and a phone is attached).
- **TUI tunneling / terminal remoting.** The phone never sees the TUI's rendered frames.
- **Remoting extension custom TUI components.** `ctx.ui.custom()` etc. remain terminal-only, per existing `docs/rpc.md` degradation.
- **Durable crash recovery of in-flight turns.** If the owner process dies mid-turn, the turn is gone; the session file reflects the last flush.
- **Multi-TUI co-attach.** A second TUI requesting a lease held by another TUI gets `lease_denied` reason `held_by_tui` and opens the session read-only (plain resume-from-file, no live view; it may retry acquire on user action).
- **Windows named pipes.** The daemon is unix-socket only (macOS/Linux). Windows keeps the no-daemon path (all lease calls no-op; behavior identical to today).
- **Forcible lease steal.** `lease_acquire.force` is reserved in the protocol; any request with `force: true` returns `lease_denied` reason `force_unsupported`.

---

## 2. Architecture Overview

### 2.1 Processes and data planes

Three processes participate: **voltd** (persistent), **volt TUI** (per-terminal, transient), and the **iOS app** (via Iroh). Two planes:

- **Control plane**: JSONL over the unix socket `~/.volt/agent/daemon/voltd.sock`. Carries hello/leases/pairing/status/viewer feed/theme snapshots/push registration.
- **Conversation plane**: framed JSONL RPC (existing `docs/rpc.md` protocol) between phone and the runtime owner. When the daemon owns the lease, it terminates the stream locally. When the TUI owns it, the daemon relays raw bytes over a dedicated per-relay unix-socket connection.

```
                                   Iroh (QUIC, e2e encrypted)
   +------------------+   pairing/auth/handshake    +---------------------------------------+
   |    iOS app       | <=========================> |                voltd                  |
   |   (volt-app)     |   conversation streams      |  - Iroh node identity (stable key)    |
   +------------------+   workspace/device streams  |  - pairing, revocation, audit         |
                                                    |  - push notification relay state     |
                                                    |  - workspace registry                 |
                                                    |  - LEASE BROKER (wsName,sessionId)    |
                                                    |  - headless runtimes (ctx.mode=rpc)   |
                                                    |  - relay dispatcher                   |
                                                    +-------------------+-------------------+
                                                                        |
                                              unix socket ~/.volt/agent/daemon/voltd.sock
                                              (control JSONL + per-relay byte-pipe conns)
                                                                        |
   +--------------------------------------------------------------------+----------------+
   |                              volt TUI (InteractiveMode)                              |
   |  - in-process AgentSessionRuntime + ExtensionRunner (ctx.mode = "tui")               |
   |  - DaemonClient (control-client.ts): lease_acquire/release/rekey, relay accept,      |
   |    viewer feed during drain, relay_rpc forwarding, theme_set                         |
   |  - per-relay: runIrohRemoteRpcMode(runtime, {stream: relayedStream,                  |
   |               disposeRuntimeOnClose:false, ...}) — one per attached phone            |
   +--------------------------------------------------------------------------------------+

Lease ownership decides which box terminates the phone's conversation stream:

  daemon-owned:  phone <==Iroh==> voltd[runtime, rpc mode]           (headless, ctx.mode=rpc)
  tui-owned:     phone <==Iroh==> voltd[handshake+auth, byte relay] <--unix--> TUI[runtime, rpc mode]
```

### 2.2 Ownership invariants

1. **One runtime per conversation authority.** For any `(workspaceName, workspaceGeneration, sessionId)`, at most one process holds a live `AgentSessionRuntime`. All phone streams and the TUI view fan out from that single runtime via `AgentSession.subscribe` (agent-session.ts L744-754; `_emit` L522-526 iterates subscribers). A same-name lease or runtime from another workspace generation is stale and cannot be reused.
2. **Extensions co-locate with the runtime.** Handoff = dispose old runtime (`session_shutdown`) + fresh load in the new owner (`session_start` from the session file). Never state migration. There is no `session_switched` event in the codebase and none is added.
3. **The session file is the source of truth across handoffs.** Both owners flush via the existing session persistence (JSONL tree format, `docs/session-format.md`, dir `join(agentDir, "sessions", "--<cwd-mangled>--")`, `SessionManager` in `src/core/session-manager.ts`).
4. **The daemon always terminates Iroh.** The TUI never runs an Iroh node. Auth, handshake parsing, target resolution, and generation-scoped lease lookup happen in the daemon before any bytes reach the TUI.
5. **Daemon integration is strictly additive for the TUI.** If the daemon is unreachable, every lease/relay/push-forward call silently no-ops and the TUI behaves exactly as today. `remote.background` controls auto-spawn; supported TUIs may still join a daemon started by another process.
6. **Workspace authority changes are terminal barriers.** Replace, unregister, client access tightening, and revoke synchronously fence old authority and await daemon/TUI retirement before reporting success. The normative mutation protocol is defined by the [workspace authority amendment](workspace-authority-lifecycle-design.md).

### 2.3 Stream routing decision (daemon, per phone conversation stream)

```
phone opens conversation stream
  -> engine accepts, handshake read + client auth (existing handshake.ts / authorization.ts)
  -> resolveIrohRemoteSessionTarget(handshake.target)   [pure helper, §3.7]
       last | new | session -> concrete sessionId (+ selection kind created/created_after_missing/resumed)
  -> leaseBroker.lookup(workspaceName, workspaceGeneration, sessionId)
       tui-owned        -> mint relay token, send relay_offer to owning TUI, pipe bytes (§5.6)
       daemon-active    -> attach stream to existing daemon runtime (multi-subscriber)
       daemon-detached  -> cancel retention timer, reattach (state -> daemon-active)
       daemon-draining  -> attach as viewer of the draining runtime? NO — draining only exists
                           while a TUI acquire is pending; phone streams attach to the daemon
                           runtime read/write EXCEPT prompt-class commands, which are rejected
                           with error code "lease_draining" (§4.5)
       unowned          -> lazily resume runtime from session file, lease -> daemon-active
  -> duplicate check: same clientNodeId + same conversation + live stream
       -> duplicate_conversation_connection (retryAfterMs 500), replace-stale-stream semantics
          preserved from iroh-host.mjs L2912-2939 (§4.6)
```

---

## 3. voltd Daemon Specification

### 3.1 Process model

- **Runtime**: npm package or source checkout only. Use `isStandaloneBinary` from `src/config.ts` to reject the Node SEA distribution, which intentionally omits Iroh; `volt daemon *` in that distribution prints actionable npm/source guidance and exits 1. Native dependency `@number0/iroh` loads via the existing `src/remote/iroh-native-adapter.cjs` mechanism (keep this file; it is the native loader, not host logic).
- **Entry point**: `src/daemon/main.ts` exporting `runVoltDaemon(config: VoltdConfig): Promise<number>`; a thin bin shim is invoked as `volt daemon run --foreground` (internal) so packaging needs no new binary. The daemon process title is set to `voltd`.
- **Detached spawn** (`src/daemon/spawn.ts`): `spawn(process.execPath, [cliEntry, "daemon", "run", "--foreground"], { detached: true, stdio: ["ignore", logFd, logFd] })`, `child.unref()`. `logFd` is an append fd to `voltd.log`. The spawner waits up to 5s for the socket to accept a `status` probe before reporting success.
- **Auto-spawn**: in TUI startup (see §6.2), if setting `remote.background === true` and platform is not Windows and the process is not a standalone SEA, `ensureDaemonRunning()` (spawn.ts) probes the socket; if no healthy daemon, spawns one. Failures are logged at debug level and never block TUI startup.
- **Single instance**: guaranteed by socket bind. On `EADDRINUSE`: connect and send `status`; if a valid `status_result` arrives within 2s, another daemon is healthy → exit 3 (`already_running`). If connect fails or times out, unlink the socket and retry the bind exactly once; if that fails, exit 4.
- **Pidfile** `voltd.pid` is advisory (JSON: `{ pid, version, startedAtMs, socketPath }`), written after successful bind, removed on graceful shutdown. Liveness truth is always the socket probe, never the pidfile.

### 3.2 File layout

All under `join(getAgentDir(), "daemon")` (`getAgentDir` from `src/config.ts`). Directory mode `0700`, socket mode `0600` (chmod after bind).

| Path | Purpose | Format |
|------|---------|--------|
| `daemon/voltd.sock` | control socket | unix stream, JSONL (§5) |
| `daemon/voltd.pid` | advisory pidfile | JSON `{pid, version, startedAtMs, socketPath}` |
| `daemon/voltd.log` | daemon log | text; rotate at 10 MiB, keep exactly 1 rotated file (`voltd.log.1`) |
| `daemon/state.json` | persistent state | `VoltdStateFileV1` (§3.3), atomic write (tmp + rename) |
| `daemon/audit.jsonl` | audit log | JSONL, reuse `src/core/remote/iroh/audit.ts` writer pointed at this path |

### 3.3 State schema

`src/daemon/state.ts`:

```ts
export interface VoltdStateFileV1 {
  version: 1;
  /** Hex/base32 Iroh secret key. MUST survive migration so phones stay paired. */
  irohSecretKey: string;
  /** Paired clients, same element shape as today's remote/iroh-host.json `clients`. */
  clients: RemotePairedClient[];        // reuse type from src/core/remote/iroh/state.ts
  revokedClients: RemoteRevokedClient[]; // reuse type from src/core/remote/iroh/state.ts
  /** Registered workspaces: name -> absolute path (+ registration metadata). */
  workspaces: RemoteWorkspaceRecord[];   // reuse/extend type from src/core/remote/iroh/state.ts
  /** Push targets keyed by clientNodeId; shape from src/core/remote/iroh/push.ts. */
  pushTargets: Record<string, RemotePushTargetRecord>;
  settings: {
    /** Detached headless runtime retention. Default DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS
     *  (30 min, src/remote/integrated-runtime-retention.ts L1). */
    detachedRuntimeTtlMs: number;
    /** Tool allowlist applied ONLY to daemon-owned headless runtimes (§11.2). */
    allowTools: string[] | null;
  };
}
```

Where a named type does not yet exist in `src/core/remote/iroh/state.ts`, define it there (typed) and make `state-manager.ts` use it; the daemon must not carry untyped state.

**Persistence**: `src/daemon/state.ts` wraps the existing `state-manager.ts` logic with the new path and envelope. Writes are debounced (250ms) and always atomic. State is flushed synchronously (best-effort) during graceful shutdown.

### 3.4 One-time migration from `remote/iroh-host.json`

`src/daemon/state.ts` exports `migrateLegacyRemoteState(agentDir: string): VoltdStateFileV1 | null`:

1. Runs on daemon startup only when `daemon/state.json` does not exist and `join(agentDir, "remote", "iroh-host.json")` (the default path used by main.ts: `join(getAgentDir(), "remote", "iroh-host.json")`) does.
2. Maps legacy fields → `VoltdStateFileV1`: secret key (**verbatim** — this is what preserves pairing), clients, revokedClients, workspaces, push targets. Unknown legacy fields are dropped. Missing sections default to empty.
3. Writes `daemon/state.json`, then renames the legacy file to `remote/iroh-host.json.migrated` (never deleted).
4. Emits audit event `daemon_started` with `details.migratedFromLegacyState: true`.
5. Idempotent: if `.migrated` exists and `state.json` exists, nothing happens.

**Acceptance**: after migration, a previously paired phone's `clientNodeId` authenticates against voltd without re-pairing; `volt remote status` lists the same clients.

### 3.5 Daemon internals (module map for `src/daemon/`)

| File | Responsibility |
|------|----------------|
| `main.ts` | `runVoltDaemon`: wire Iroh engine (`src/core/remote/iroh/engine.ts` `IrohRemoteHostEngine`) + control server + lease broker + state + audit + shutdown; signal handlers (SIGTERM/SIGINT → graceful shutdown §3.9). |
| `cli.ts` | `volt daemon` subcommand implementations (start/stop/status/restart/logs/install-service/run); invoked from main.ts command router. |
| `spawn.ts` | detached spawn, socket health probe, `ensureDaemonRunning()`, stale-socket recovery, version-skew handling (§3.8). |
| `state.ts` | `VoltdStateFileV1`, load/save/migrate. |
| `control-protocol.ts` | ALL control-plane TS types (§5.3-5.5), frame encode/decode, 8 MiB line cap. Shared by daemon and TUI. Zero runtime deps beyond node:buffer. |
| `control-server.ts` | unix socket listener; hello/hello_ack; request dispatch; unsolicited event fan-out; per-connection lease bookkeeping (implicit release on disconnect); relay-socket admission (role:"relay" hellos, token check). |
| `control-client.ts` | `DaemonClient` used by TUI and CLI: connect/reconnect backoff (250ms→5s, jittered), request/response correlation, event subscription, relay socket dialing. |
| `lease-broker.ts` | pure-ish state machine (§4): Map keyed `${workspaceName}\0${sessionId}`, transitions, draining orchestration hooks, timers injected for tests. |
| `integrated-runtimes.ts` | daemon-owned runtime lifecycle: create via `createIrohRemoteAgentRuntimeWithSessionSelection` (src/modes/rpc/iroh-remote-agent-runtime.ts L85), attach/detach subscribers (port iroh-host.mjs L2624-2682), stop entry (port `stopIntegratedRuntimeEntry` L2684-2723), retention (port L2741-2774 using `src/remote/integrated-runtime-retention.ts`), workflow event replay, `onSessionChanged` rekey (port `handleIntegratedRuntimeSessionChanged` L2168-2179 → calls `leaseBroker.rekey`). |
| `relay-stream.ts` | relay lifecycle daemon-side: token mint/expiry (10s, single-use), preamble write, bidirectional raw byte pump Iroh stream ↔ relay unix connection, half-close + error propagation, `relay_opened`/`relay_closed` audit. |
| `session-target.ts` | `resolveIrohRemoteSessionTarget` (extracted pure helper, §3.7). |
| `conversation-commands.ts` | port of integrated-conversation host RPC command handling (`handleIntegratedConversationRpcCommand`), including `INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES = {new_session, switch_session_by_id, get_messages}` rejection, and the NEW abort semantics (§7.4). |
| `handshake-responses.ts` | `createIntegratedConversationHandshakeResponse` ported from iroh-host.mjs into a typed module **shared by the daemon path and the TUI relay path** (the TUI writes the handshake success response itself, §5.6 step 7). |
| `workspace-streams.ts` | workspace discovery/management + device-log streams, porting the remaining serve() surface (iroh-host.mjs L3458-3639) onto `workspace-rpc.ts` / `device-log-rpc.ts`. |

Reused as-is from `src/core/remote/iroh/`: `engine.ts`, `handshake.ts`, `handshake-reader.ts`, `protocol.ts` (feature strings `multi_streams.v1`, `conversation_streams.v1`, plus new additive `conversation_leases.v1`), `rpc-command-filter.ts`, `outbound-filter.ts`, `active-stream-registry.ts`, `state-manager.ts`, `push.ts`, `ticket.ts`, `audit.ts`, `qr.ts`, `host-policy.ts`, `workspace-rpc.ts`, `device-log-rpc.ts`, `authorization.ts`, `metadata.ts`.

### 3.6 CLI surface

`main.ts` command router changes:

| Command | Behavior |
|---------|----------|
| `volt daemon start` | `ensureDaemonRunning()`; prints socket path + pid; exit 0 if already running. |
| `volt daemon stop` | control `shutdown` request; waits up to 75s (60s drain cap + margin); falls back to SIGTERM via pidfile if socket dead; exit 0 on stop, 1 on timeout. |
| `volt daemon status` | control `status` request; prints version, protocolVersion, pid, uptime, lease table, connected phones, relay count, workspace count. `--json` for machine output. Exit 0 running / 1 not running. |
| `volt daemon restart` | stop + start; preserves state (state.json survives). |
| `volt daemon logs [-f] [-n N]` | tail `voltd.log` (default 200 lines); `-f` follows. |
| `volt daemon install-service` | OPTIONAL milestone M9: writes launchd plist (`~/Library/LaunchAgents/com.github.hansjm10.voltd.plist`) or systemd user unit (`~/.config/systemd/user/voltd.service`) that runs `volt daemon run --foreground`; prints load/enable instructions. Does not load/enable itself. |
| `volt daemon run --foreground` | internal: runs the daemon in-process (used by spawn + service units + tests). |
| `volt remote host` | **REMOVED.** Prints: `"volt remote host" has been replaced by the background daemon. Run "volt daemon start" (or enable remote.background). See docs/daemon.md.` Exit 1. Delete the spawn path (main.ts L1075-1097) and the `remoteHost*` plumbing. |
| `volt remote pair` | Now a control-socket client: sends `pair_request`, renders ticket + QR (reuse `qr.ts` rendering client-side from `pairing_progress` payloads), streams `pairing_progress` until `completed`/`failed`/Ctrl-C (which sends cancel by closing the request scope). Replaces `startPairControlServer` (iroh-host.mjs L3357). Requires a running daemon; auto-starts it when `remote.background` is on, else instructs `volt daemon start`. |
| `volt remote status` | Real implementation via control `status` (replaces the placeholder at main.ts L237-238). |
| `volt remote clients` / `volt remote revoke <id>` | via `clients_list` / `client_revoke`. |
| `volt remote workspace add/remove/list` | via `workspace_register` / `workspace_unregister` / `status`. |

All `volt remote *` and `volt daemon *` reject the standalone SEA with actionable npm/source guidance.

### 3.7 Session target resolution (shared helper)

Extract from `createIrohRemoteAgentRuntimeWithSessionSelection` (src/modes/rpc/iroh-remote-agent-runtime.ts L85) a pure function in `src/daemon/session-target.ts`:

```ts
export type IrohRemoteSessionTarget =
  | { kind: "last" }
  | { kind: "new" }
  | { kind: "session"; sessionId: string };

export interface ResolvedSessionTarget {
  sessionId: string;                 // concrete id (existing file id, or freshly created)
  sessionFilePath: string;
  selection: "created" | "created_after_missing" | "resumed";
  workspaceName: string;
  workspacePath: string;
}

export function resolveIrohRemoteSessionTarget(
  target: IrohRemoteSessionTarget,
  workspace: { name: string; path: string },
  sessions: SessionManagerLike,       // list/open/create — injectable for tests
): Promise<ResolvedSessionTarget>;
```

Rules (must exactly match today's behavior in iroh-remote-agent-runtime.ts, including `created_after_missing` when `kind:"session"` names a missing id, and host-synthesized `session_rekeyed` semantics for the client-side selection validation):

- `last`: newest session for the workspace path, else create → `created`.
- `new`: always create → `created`.
- `session`: open if exists → `resumed`; else create fresh → `created_after_missing`.

The daemon calls this **before** lease lookup (routing needs the concrete sessionId). `createIrohRemoteAgentRuntimeWithSessionSelection` is refactored to accept a pre-resolved `ResolvedSessionTarget` (new overload/param) so resolution is not run twice; its existing signature keeps working by resolving internally via the same helper.

### 3.8 Version skew

- `status_result` carries `{ version, protocolVersion }` (package version from package.json; `PROTOCOL_VERSION = 1` from control-protocol.ts).
- Every CLI/TUI connect compares. On mismatch:
  - If the daemon is **idle** (zero daemon-owned leases in `daemon-active`/`daemon-draining`, zero live phone conversation streams, zero relays): the client triggers an automatic in-place restart (`shutdown` + `ensureDaemonRunning()`) and logs one info line.
  - Else: warn once per process (`voltd version X != client Y; restart when idle with "volt daemon restart"`), continue on protocol 1. Any future protocolVersion bump makes mismatched hellos hard-fail with `hello_ack.error = "protocol_mismatch"`.

### 3.9 Graceful shutdown sequence

On `shutdown` request or SIGTERM/SIGINT:

1. Stop accepting new phone streams and new control connections; reject with close reason `host_shutdown` / hello error `shutting_down`.
2. For each daemon-owned runtime that `session.isStreaming`: `await session.waitForIdle()` with a **60s cap per runtime** (run concurrently). **Never call `session.abort()`** — a hard cap simply proceeds to disposal (the in-flight turn is lost only in the pathological case; acceptable per non-goals).
3. Flush + dispose each daemon runtime (extension `session_shutdown` reason `"quit"` via the normal dispose path; `AgentSession.dispose()` invalidates extension ctx, agent-session.ts L781-800).
4. Close all phone conversation/workspace streams with reason `host_shutdown`.
5. Send `daemon_shutdown` event to all control connections. TUIs keep their in-process leases and runtimes untouched; they mark relay availability off (footer indicator clears) and begin reconnect backoff.
6. Flush `state.json`, write audit `daemon_shutdown`, unlink socket, remove pidfile, exit 0.

### 3.10 Audit log

Reuse `src/core/remote/iroh/audit.ts` (writer + event envelope) targeting `daemon/audit.jsonl`. Preserve ALL existing event types emitted by iroh-host.mjs (pairing, auth success/failure, session_created, stream open/close, revocation, push dispatch, etc. — enumerate from grep of `auditLog`/`type:` in iroh-host.mjs during port and carry every one). Add:

| New event | details |
|-----------|---------|
| `daemon_started` | `{ version, migratedFromLegacyState }` |
| `daemon_shutdown` | `{ reason: "cli" \| "signal", drainedRuntimes, cappedRuntimes }` |
| `lease_acquired` | `{ workspaceName, sessionId, owner: "tui" \| "daemon", handoff: "cold" \| "warm" \| "none", connectionId? }` |
| `lease_released` | `{ workspaceName, sessionId, owner, reason: "quit" \| "switch" \| "connection_lost" \| "rekey" \| "shutdown" }` |
| `lease_denied` | `{ workspaceName, sessionId, requester, reason }` |
| `relay_opened` | `{ relayId, clientNodeId, workspaceName, sessionId, connectionId, streamId }` |
| `relay_closed` | `{ relayId, reason, bytesUp, bytesDown, durationMs }` |

---

## 4. Lease Broker

`src/daemon/lease-broker.ts`. Key: `${workspaceName}\0${sessionId}` — **`clientNodeId` is dropped** from today's key (iroh-host.mjs L2298). The broker is the single authority on ownership; runtimes and relays are effects driven by its transitions.

### 4.1 Types

```ts
export type LeaseState =
  | "unowned"
  | "daemon-active"     // daemon runtime live, >=1 phone stream attached
  | "daemon-detached"   // daemon runtime live, 0 streams, retention TTL ticking
  | "daemon-draining"   // TUI acquire pending; finishing current turn before release
  | "tui-owned";        // TUI holds runtime; daemon relays phone streams

export interface LeaseRecord {
  key: string;                        // `${workspaceName}\0${sessionId}`
  workspaceName: string;
  sessionId: string;
  state: LeaseState;
  /** control connectionId of owning TUI when tui-owned / target of daemon-draining */
  tuiConnectionId?: string;
  /** live daemon runtime entry when daemon-* */
  runtimeEntryId?: string;
  /** active relayIds when tui-owned */
  relayIds: Set<string>;
  /** retention timer handle when daemon-detached */
  retentionTimer?: TimerHandle;
  /** drain bookkeeping when daemon-draining */
  drain?: { viewerFeedId: string; requestId: string; startedAtMs: number };
}

export type LeaseDenyReason =
  | "held_by_tui"        // another TUI connection owns it (multi-TUI non-goal)
  | "force_unsupported"  // force flag is reserved
  | "draining_elsewhere";// a different TUI's drain is already pending

export interface LeaseBroker {
  lookup(workspaceName: string, sessionId: string): LeaseRecord | undefined;
  /** TUI acquire; may resolve granted immediately, or pending->granted after drain. */
  acquireForTui(req: {
    connectionId: string; workspaceName: string; sessionId: string; force?: boolean;
  }): Promise<
    | { kind: "granted"; handoff: "cold" | "warm" | "none" }
    | { kind: "pending"; viewerFeedId: string; granted: Promise<{ handoff: "warm" }> }
    | { kind: "denied"; reason: LeaseDenyReason }
  >;
  releaseFromTui(connectionId: string, workspaceName: string, sessionId: string): void;
  rekey(workspaceName: string, oldSessionId: string, newSessionId: string): void;
  /** connection died: implicit release of ALL leases held by connectionId */
  releaseAllForConnection(connectionId: string): void;
  /** daemon runtime lifecycle notifications */
  onDaemonRuntimeAttached(workspaceName: string, sessionId: string, entryId: string): void;
  onDaemonRuntimeStreamCountChanged(key: string, liveStreams: number): void;
  onDaemonRuntimeDisposed(key: string): void;
}
```

### 4.2 State machine

| From \ Event | tui acquire | tui release / conn lost | phone stream attach | last phone stream detach | retention TTL fires | daemon runtime turn idle (drain) | rekey |
|---|---|---|---|---|---|---|---|
| **unowned** | → `tui-owned`, `lease_granted{handoff:"none"}` | n/a | daemon lazily resumes runtime from session file → `daemon-active` | n/a | n/a | n/a | n/a |
| **daemon-active** | if `session.isStreaming`: → `daemon-draining` + `lease_pending{viewerFeedId}`; else immediate: dispose runtime (shutdown reason `"quit"`), → `tui-owned`, `lease_granted{handoff:"warm"}`, phone streams closed reason `lease_transferred` then re-routed as relays on reconnect | n/a | attach additional subscriber (multi-device) | → `daemon-detached`, start retention timer | n/a | n/a | rekey key, keep state |
| **daemon-detached** | cancel timer; dispose runtime + immediate grant `handoff:"warm"`. A turn still streaming on a detached runtime is intentionally abandoned, not drained (see note below) | n/a | cancel timer → `daemon-active` | n/a | dispose runtime (shutdown reason `"quit"`) → `unowned` | n/a | rekey key, keep state |
| **daemon-draining** | same TUI conn: idempotent (same pending). Different TUI conn: `lease_denied{draining_elsewhere}` | pending TUI conn lost: cancel drain → `daemon-active` (or `daemon-detached` if 0 streams); viewer feed ends `viewer_end{reason:"cancelled"}` | attach subscriber; prompt-class commands rejected `lease_draining` (§4.5) | stream count may hit 0; stay `daemon-draining` (drain completes regardless) | timer not armed in this state | flush + dispose runtime (shutdown `"quit"`), close phone streams `lease_transferred`, → `tui-owned`, resolve `lease_granted{handoff:"warm"}`, `viewer_end{reason:"granted"}` | rekey key + notify pending TUI via granted payload sessionId |
| **tui-owned** | same conn: idempotent ok. Other conn: `lease_denied{held_by_tui}` | flush (TUI-side) + release → `unowned`; all relays closed reason `lease_transferred`; phones auto-reconnect and lazily resume (§4.4) | daemon mints relay to owning TUI (§5.6) | (relay closed; no state change) | n/a | n/a | TUI sends `lease_rekey`; broker rekeys; open relays for the old key are closed reason `session_rekeyed_reconnect` (phone revalidates via its existing `session_rekeyed` selection logic) |

`handoff` semantics in `lease_granted`:
- `"none"`: nothing was running in the daemon; TUI proceeds without any reload (its normal open path).
- `"warm"`: the daemon had a runtime and disposed it; the TUI MUST (re)load the session from file before serving (its normal resume path already does this on open; on an already-open TUI reacquiring after reconnect, it triggers `session.reload()` — agent-session.ts L2657-2681 — if the daemon reports it owned a runtime in the gap).
- `"cold"`: reserved for future use (grant where daemon never had state but the session file changed externally); implement as an alias of `"warm"` on the TUI side.

**Drain is `daemon-active`-only; detached turns are abandonable (decided).** The
`session.isStreaming` drain gate fires only for `daemon-active` — i.e. a phone is
attached and can watch the turn finish. A `daemon-detached` runtime whose turn is
still running (the last phone left mid-turn; the turn continued on the host per
§Lifecycle) is disposed immediately on TUI acquire, killing that in-flight turn
rather than draining it. This is intentional, not an oversight: the drain exists
to hand a *watched* turn off gracefully, so once no device is receiving the turn
(no attached phone, and the desktop is only now acquiring) there is nothing to
watch and the turn is abandonable — the same way closing a TUI mid-turn loses that
turn (§1.3 non-goal). The tradeoff is a mild asymmetry: whether a walked-away turn
survives opening the desktop depends on whether a phone was still attached. We
accept it; draining an unwatched detached runtime would add a viewer feed with no
viewer for marginal benefit. (Formalized as the `IdleAcquireOnlyWhenIdle`
predicate in `docs/tla/LeaseBroker.tla`, which intentionally does NOT hold.)

### 4.3 Draining protocol detail (daemon side)

On `acquireForTui` finding `daemon-active` + `session.isStreaming`:

1. Transition → `daemon-draining`; create `viewerFeedId`; reply `lease_pending{viewerFeedId}`.
2. From this instant, subscribe to the runtime's `AgentSession` and forward every `AgentSessionEvent` as a `viewer_event` control message to the acquiring TUI connection. Buffer events emitted between drain start and the TUI's `viewer_subscribe` (cap 2000 events / 4 MiB; if exceeded, drop the buffer and send `viewer_event{kind:"truncated"}` first — the TUI shows a spinner instead of partial transcript, then relies on the post-grant file load for truth).
3. Reject phone prompt-class commands with error `lease_draining` (§4.5) so the drain converges (no new turns can start).
4. `await session.waitForIdle()` (no cap here — the turn ends when it ends; abort is available to the user from either surface and is now non-destructive §7.4).
5. Flush; dispose daemon runtime (`session_shutdown` reason `"quit"`); close phone streams reason `lease_transferred`; `viewer_end{reason:"granted"}`; transition → `tui-owned`; resolve the pending acquire with `lease_granted{handoff:"warm"}`.

### 4.4 Lazy daemon resume (tui-owned → unowned → daemon-active)

On TUI release, the daemon does NOT speculatively build a runtime. The lease goes `unowned`. Phones whose relays closed with `lease_transferred` auto-reconnect (iOS delta D9); the next conversation-stream arrival for that key finds `unowned` and resumes from the session file via `integrated-runtimes.ts` (which uses `createIrohRemoteAgentRuntimeWithSessionSelection` with the pre-resolved target from §3.7). This keeps release O(1) and avoids warm runtimes nobody uses.

### 4.5 Prompt-class command rejection during draining

`conversation-commands.ts` classifies inbound RPC commands. During `daemon-draining`, commands that would start or extend a turn — `prompt` (any `streamingBehavior`), and any command documented in docs/rpc.md as turn-initiating — receive:

```json
{ "type": "response", "command": "prompt", "success": false,
  "error": { "code": "lease_draining", "message": "Handing off to the desktop TUI; retry shortly.", "retryAfterMs": 1000 } }
```

Read-only commands (`get_state`, `get_transcript`, `get_pending_host_actions`, `set_client_capabilities`, abort, etc.) pass through. The iOS app treats `lease_draining` like a transient failure with retry (iOS delta D10).

### 4.6 `conversation_in_use` policy exception and duplicate derivation

- `conversation_in_use` is retired as a general ownership rejection: all paired devices belong to the same human, and distinct clients normally co-attach. A security exception applies when an existing daemon runtime permits tools outside the attaching client's persisted grant; that client receives `conversation_in_use` rather than being allowed to drive the broader runtime. TUI-owned conversations retain the explicit full-local-tool policy.
- `duplicate_conversation_connection` (SAME clientNodeId, same `(workspaceName, sessionId)`, existing live stream) keeps today's semantics ported from iroh-host.mjs L2912-2939: replace-stale-stream (if the existing stream is dead, silently replace), else reject with `retryAfterMs: 500`. Applies identically to daemon-owned attaches and relay minting (the daemon tracks live relays per clientNodeId+key). The iOS retry loop (max 5 attempts, backoff+jitter, retryAfterMs clamp 500-5000; `volt-app` `VoltHostSessionManager+AgentSelection.swift`) continues to work unchanged.

### 4.7 Rekey

Session id changes originate from the runtime owner:

- Daemon-owned: `onSessionChanged` (the `runIrohRemoteRpcMode` option, see call site iroh-host.mjs L1587-1611) → port `handleIntegratedRuntimeSessionChanged` (L2168-2179) → `leaseBroker.rekey(ws, oldId, newId)` + host-synthesized `session_rekeyed` notice to attached phones (existing behavior preserved).
- TUI-owned: TUI sends `lease_rekey` (§6.4). The broker rekeys, closes open relays for the old key with reason `session_rekeyed_reconnect`; phones re-run target/selection validation on reconnect (existing `IrohProtocol.selectionIsValid` / `validatedRequestedSessionId` logic).

### 4.8 Race conditions and ordering rules (normative)

The broker runs single-threaded on the daemon event loop; every transition is a synchronous state mutation followed by async effects. The following interleavings MUST be handled exactly as specified:

| Race | Rule |
|------|------|
| Phone stream arrives while `acquireForTui` is transitioning `daemon-active` → `tui-owned` (immediate grant path) | Transition is atomic on the loop: the routing decision (§2.3) reads the post-transition state. If the runtime disposal effect is still in flight, the relay offer is queued until `lease_granted` has been sent; the phone stream waits (handshake response deferred) up to 10s, then transient handshake error → phone retries. |
| TUI control connection drops between `lease_pending` and drain completion | `releaseAllForConnection` cancels the drain (§4.2 daemon-draining row): viewer buffer discarded, `viewer_end` unsendable (connection gone), state reverts to `daemon-active`/`daemon-detached`. The pending acquire promise rejects internally; nothing is sent. |
| Two phones (distinct clientNodeIds) race to attach to an `unowned` key | First arrival triggers lazy resume and moves state to `daemon-active`; second arrival observes `daemon-active` (or an in-flight resume — the broker records `resuming` as a sub-flag of `daemon-active` with a pending-runtime promise both attaches await). Resume failure rejects both attaches with a handshake error and reverts to `unowned`. |
| `rekey` arrives while a `relay_offer` for the old key is outstanding (token unredeemed) | The offer's token is invalidated (mark used); daemon closes the phone stream with a transient error; phone retries and re-resolves the target (its `session` target now takes the `session_rekeyed`/`created_after_missing` path per existing selection validation). |
| Retention timer fires concurrently with a phone attach | Timer callback checks state first: if not `daemon-detached`, it is a no-op. Attach cancels the timer before transitioning; a fired-but-not-yet-run callback is guarded by the state check. |
| TUI sends `lease_release` for a key it does not hold | `error{code:"not_held"}`; broker state untouched. Never treat as fatal. |
| Daemon shutdown begins during `daemon-draining` | Shutdown's per-runtime `waitForIdle` (60s cap) subsumes the drain; on idle, the drain completes normally FIRST (grant sent) if the requester connection is still up, then shutdown proceeds; the freshly `tui-owned` lease survives shutdown (TUIs keep in-process runtimes, §3.9 step 5). If the cap fires, drain is cancelled (`viewer_end{reason:"error"}`, response `error{drain_failed}`) and disposal proceeds. |
| Duplicate relay offer: same clientNodeId reconnects while its previous relay's token is unredeemed | Invalidate the old token, emit `relay_closed{reason:"error"}` for the never-opened relayId, mint a fresh offer. |

### 4.9 Subagents

Subagent runtimes (docs/subagents-design.md; `src/core/tools/subagent*`) are **children of the parent lease** and never acquire their own leases. The broker has no knowledge of them; they live and die inside the owner process with the parent runtime. A handoff disposes them with the parent (`session_shutdown` cascade) — in-flight subagent work is lost with the parent turn per the drain rule (drain waits for the parent turn, which by definition includes awaited subagent work).

### 4.10 Retention interplay

`daemon-detached` reuses `src/remote/integrated-runtime-retention.ts` (`DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS = 30 * 60 * 1000`, override via `settings.detachedRuntimeTtlMs`). Timer arms on last stream detach, cancels on any attach or TUI acquire. TTL fire disposes the runtime (audit `lease_released{reason:"connection_lost"}`? — no: use dedicated `details.reason:"retention_expired"` on the existing runtime-stop audit event, and `lease_released` with reason `"quit"` is NOT emitted; instead emit `lease_released{owner:"daemon", reason:"retention_expired"}` — add this reason to the union in §3.10's table).

---

## 5. Unix Socket Control Protocol

`src/daemon/control-protocol.ts` — single module defining every wire type; imported by daemon, TUI, and CLI. No `any`.

### 5.1 Framing

- Transport: `net` unix stream socket at `~/.volt/agent/daemon/voltd.sock`.
- Framing: JSONL — one JSON object per `\n`-terminated line, UTF-8. Hard cap **8 MiB per line**; a longer line closes the connection with a final `{"type":"fatal","error":"frame_too_large"}` best-effort write.
- Two connection roles established by the first line (`hello`): `control` (long-lived, multiplexed requests/events) and `relay` (single-purpose byte pipe after a one-line preamble, §5.6).

### 5.2 Hello

```ts
export const PROTOCOL_VERSION = 1;

export type HelloMessage =
  | { type: "hello"; role: "control"; protocolVersion: number; pid: number;
      version: string; client: "tui" | "cli" }
  | { type: "hello"; role: "relay"; protocolVersion: number;
      relayId: string; relayToken: string };

export interface HelloAck {
  type: "hello_ack";
  ok: boolean;
  error?: "protocol_mismatch" | "shutting_down" | "bad_relay_token";
  connectionId?: string;      // daemon-assigned, present when ok (control role)
  version?: string;           // daemon package version
  protocolVersion?: number;
}
```

For `role:"relay"`, a successful `hello_ack` is followed immediately by exactly one `relay_preamble` line (§5.6), after which the connection is a raw byte pipe (no further JSONL parsing by the daemon).

### 5.3 Requests and responses (control role)

Every request carries a client-generated `id`; every response echoes it. Unsolicited events have no `id`.

```ts
export type ControlRequest =
  | { type: "status"; id: string }
  | { type: "shutdown"; id: string }
  | { type: "lease_acquire"; id: string; workspaceName: string; sessionId: string;
      /** reserved; true => lease_denied{force_unsupported} */ force?: boolean }
  | { type: "lease_release"; id: string; workspaceName: string; sessionId: string }
  | { type: "lease_rekey"; id: string; workspaceName: string;
      oldSessionId: string; newSessionId: string }
  | { type: "pair_request"; id: string }              // events: pairing_progress
  | { type: "clients_list"; id: string }
  | { type: "client_revoke"; id: string; clientNodeId: string }
  | { type: "workspace_register"; id: string; name: string; path: string }
  | { type: "workspace_unregister"; id: string; name: string }
  | { type: "theme_set"; id: string; theme: string }  // name; daemon resolves + broadcasts
  | { type: "viewer_subscribe"; id: string; viewerFeedId: string }
  | { type: "viewer_unsubscribe"; id: string; viewerFeedId: string }
  | { type: "relay_rpc"; id: string; clientNodeId: string; workspaceName: string;
      sessionId: string;
      /** verbatim state-touching RPC command (register_push_target or
       *  unregister_workspace) forwarded from a
       *  TUI-owned conversation (§6.6); the daemon replies relay_rpc_result with the
       *  verbatim RPC response for the phone */
      command: Record<string, unknown> & { type: string } };

export type ControlResponse =
  | { type: "ok"; id: string }
  | { type: "error"; id: string; code: string; message: string }
  | { type: "lease_granted"; id: string; workspaceName: string; sessionId: string;
      handoff: "cold" | "warm" | "none" }
  | { type: "lease_pending"; id: string; viewerFeedId: string }
      // followed later (same id) by lease_granted or error
  | { type: "lease_denied"; id: string;
      reason: "held_by_tui" | "force_unsupported" | "draining_elsewhere" }
  | { type: "status_result"; id: string; version: string; protocolVersion: number;
      pid: number; startedAtMs: number;
      leases: Array<{ workspaceName: string; sessionId: string; state: LeaseState;
                      relayCount: number; streamCount: number }>;
      phoneConnections: number; workspaces: Array<{ name: string; path: string }>;
      clients: Array<{ clientNodeId: string; label?: string; pairedAtMs: number }> };
```

Note: `lease_pending` is a *provisional* response; the terminal response for the same `id` arrives when the drain completes (`lease_granted`) or fails (`error` with code `drain_cancelled` if the requester disconnects — moot — or `drain_failed` on runtime error, in which case the lease reverts to `daemon-active`).

### 5.4 Unsolicited events (daemon → control clients)

```ts
export type ControlEvent =
  | { type: "relay_offer"; relayId: string; relayToken: string; // single-use, 10s expiry
      workspaceName: string; sessionId: string;
      clientNodeId: string; connectionId: string; streamId: string }
  | { type: "relay_closed"; relayId: string;
      reason: "phone_disconnected" | "lease_transferred" | "session_rekeyed_reconnect"
            | "host_shutdown" | "error" }
  | { type: "viewer_event"; viewerFeedId: string; seq: number;
      event: unknown /* AgentSessionEvent JSON, union agent-session.ts L138-163 */ }
  | { type: "viewer_end"; viewerFeedId: string; reason: "granted" | "cancelled" | "error" }
  | { type: "theme_snapshot"; themeName: string; tokens: Record<string, string> } // §9.5
  | { type: "pairing_progress"; requestId: string;
      phase: "ticket" | "qr" | "waiting" | "completed" | "failed";
      ticket?: string; qrLines?: string[]; clientNodeId?: string; error?: string }
  | { type: "daemon_shutdown" };
```

`relay_offer` is sent only to the control connection that owns the target lease. `viewer_event` is sent only to the drain requester after `viewer_subscribe` (buffered from drain start, §4.3).

### 5.5 DaemonClient (TUI/CLI side, `src/daemon/control-client.ts`)

```ts
export interface DaemonClientOptions {
  socketPath: string; client: "tui" | "cli"; version: string;
  onEvent(event: ControlEvent): void;
  onConnectionStateChange(state: "connected" | "reconnecting" | "gone"): void;
}
export interface DaemonClient {
  request(req: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse>;
  /** dial a fresh unix connection with role:"relay", returns duplex after preamble read */
  openRelay(offer: RelayOfferInfo): Promise<{ preamble: RelayPreamble; stream: Duplex }>;
  close(): Promise<void>;
}
```

- Reconnect: exponential backoff 250ms → 5s (factor 2, ±20% jitter), forever while enabled.
- On reconnect, the TUI **re-acquires** all leases it believes it holds (§6.5). Daemon-side, the old connection's leases were already implicitly released on disconnect (crash rule); a brief window where the daemon serves phones directly is acceptable — the re-acquire then follows the normal (possibly draining) path with `handoff:"warm"`, and the TUI runs `session.reload()` to pick up anything the daemon runtime appended.
- All lease methods used by the TUI are wrapped by `src/modes/interactive/daemon-attach.ts` so that unreachable-daemon ⇒ resolved no-op (§6.1).

### 5.6 Relay lifecycle (authoritative step list)

Preconditions: phone conversation stream authenticated; target resolved (§3.7); lease is `tui-owned` with live control connection `C`.

1. Daemon performs the full handshake read + client authorization itself (existing `handshake.ts` / `handshake-reader.ts` / `authorization.ts`). It does NOT write the handshake success response.
2. Duplicate check per §4.6 (per clientNodeId + key against live relays); may reject `duplicate_conversation_connection{retryAfterMs:500}` or replace a stale relay.
3. Daemon mints `relayId` (uuid) + `relayToken` (32B random, base64url), stores `{token, key, expiresAt: now+10_000, used:false}`.
4. Daemon sends `relay_offer{relayId, relayToken, workspaceName, sessionId, clientNodeId, connectionId, streamId}` on `C`.
5. TUI dials a NEW unix connection, sends `hello{role:"relay", relayId, relayToken}`. Daemon validates token (unexpired, unused, matching relayId), marks used, replies `hello_ack{ok:true}`. Invalid/expired ⇒ `hello_ack{ok:false,error:"bad_relay_token"}` + close; daemon closes the phone stream with a transient handshake error so the phone retries.
6. Daemon writes exactly one JSONL `relay_preamble` line:

```ts
export interface RelayPreamble {
  type: "relay_preamble";
  relayId: string;
  /** verbatim phone handshake JSON as received (parsed object, re-serialized) */
  handshake: unknown;
  /** authorization subset — everything the TUI needs to serve the stream */
  authorization: { clientNodeId: string; workspaceName: string; workspacePath: string };
  connectionId: string;
  streamId: string;
  resolvedTarget: ResolvedSessionTarget;   // §3.7 (sessionId, selection, paths)
}
```

7. **TUI writes the handshake success response itself** onto the relay stream, using `createIntegratedConversationHandshakeResponse` from the shared module `src/daemon/handshake-responses.ts` (fed from the preamble's handshake + authorization + resolvedTarget + its live runtime entry). This keeps response construction identical between daemon-owned and relayed paths.
8. Daemon enters raw pipe mode: bidirectional byte pump Iroh stream ⇄ relay connection, **no inspection, no reframing** (`relay-stream.ts`). Backpressure via standard stream `pipe` semantics. Half-close propagates; error on either side closes both. Audit `relay_opened`.
9. TUI wraps the relay `Duplex` in the stream shape expected by `runIrohRemoteRpcMode` (the `stream` option; see the option bundle at the existing call site iroh-host.mjs L1587-1611) and invokes:

```ts
runIrohRemoteRpcMode(this.runtime, {
  stream: relayedStream,
  disposeRuntimeOnClose: false,
  workspaceName: preamble.authorization.workspaceName,
  workspacePath: preamble.authorization.workspacePath,
  initialInput: handshake.initialInput,
  remoteCommandHandler: tuiConversationCommandHandler,   // §6.7 incl. abort semantics
  onSessionChanged: (s) => this.daemonAttach.rekey(...), // §6.4
  registerPushTarget: (args) => this.daemonAttach.forwardPushRegister(...), // §6.6
  notificationDelivery: pushForwardingDispatcher,        // §6.6
  decorateOutbound: undefined,  // host-state decoration is daemon-side metadata; the daemon
                                // cannot decorate (no inspection), so the TUI applies the
                                // ported decorateRemoteHostState from a shared module if the
                                // existing protocol requires it on conversation streams —
                                // port decorateRemoteHostState into src/daemon/handshake-responses.ts
                                // (or a sibling shared module) and call it here.
  onResponseWritten: undefined, // invalidateStreamAfterAbortResponse is DELETED (§7.4)
})
```

  `runIrohRemoteRpcMode` (src/modes/rpc/iroh-remote-rpc-mode.ts L99) already layers outbound filter → close-deferring `waitForIdle` → inbound command filter → host-command intercept; all of that now runs in the TUI for relayed streams. `INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES` `{new_session, switch_session_by_id, get_messages}` rejection lives in the shared `conversation-commands.ts` handler used by both owners.
10. Multiple concurrent relays (multiple paired devices) each repeat steps 3-9 independently; each gets its own `runIrohRemoteRpcMode` invocation against the same runtime; `AgentSession.subscribe` fans out events to each stream's subscriber.
11. Teardown: phone disconnect → daemon closes relay conn → TUI's rpc-mode invocation ends (runtime NOT disposed) → daemon audits `relay_closed{reason:"phone_disconnected"}` and emits `relay_closed` event on `C` (footer count update). TUI-initiated lease release / rekey / daemon shutdown close relays with the reasons in §5.4.

### 5.7 Relay stream adapter (TUI side, exact shape)

`runIrohRemoteRpcMode`'s `stream` option (see the existing call site option bundle, iroh-host.mjs L1587-1611, and the transport layering at src/modes/rpc/iroh-remote-rpc-mode.ts L99) expects the Iroh stream shape used by the host today (a `send` writable side consumed by `writeIrohRemoteHandshakeResponse`/response writer and a readable side consumed by the framed reader, plus close semantics). The TUI wraps the relay `net.Socket` in an adapter, `src/modes/interactive/relay-stream-adapter.ts`:

```ts
export interface RelayedIrohStreamLike {
  /** writable side: same interface surface the rpc-mode response writer and
   *  writeIrohRemoteHandshakeResponse consume (write(bytes), flush, closeWrite) */
  send: IrohSendStreamLike;
  /** readable side: async chunk iteration feeding the existing framed JSONL reader */
  recv: IrohRecvStreamLike;
  /** close both directions; maps to socket.destroy() */
  close(reason?: string): void;
  readonly closed: Promise<{ reason?: string }>;
}
export function adaptRelaySocketToIrohStream(socket: Duplex): RelayedIrohStreamLike;
```

Implementation notes:
- Define `IrohSendStreamLike` / `IrohRecvStreamLike` in `src/core/remote/iroh/rpc-transport.ts` (which already abstracts transport) as the minimal structural interfaces `runIrohRemoteRpcMode` actually touches, then make both the real Iroh stream (daemon path) and the relay socket (TUI path) satisfy them. If `iroh-remote-rpc-mode.ts` currently reaches into Iroh-specific members beyond that minimal surface, narrow it to the interface as part of M1/M5 — this is the load-bearing refactor that makes byte relay possible without a parallel rpc-mode implementation.
- `closeIrohRemoteStream(stream, reason)` equivalents on the adapter map reason strings to a best-effort trailer: NO trailer bytes are written by the TUI (the daemon owns close-reason signaling to the phone via the Iroh layer). Instead, the adapter destroys the socket; the daemon's relay pump observes EOF/error and closes the Iroh stream with reason `error` unless the daemon itself initiated the close with a specific reason (`lease_transferred`, `session_rekeyed_reconnect`, `host_shutdown`). Consequence: TUI-initiated stream closes surface to the phone as generic closures — acceptable because the TUI only closes relays via lease release/rekey, which the DAEMON executes with proper reasons; assert in code review that InteractiveMode never destroys a relay socket outside those flows (except process exit, where reason `lease_transferred` is again daemon-driven by the implicit release).

### 5.8 Wire transcript examples (informative)

TUI startup, lease acquire, phone attach via relay:

```jsonl
-> {"type":"hello","role":"control","protocolVersion":1,"pid":4242,"version":"0.9.0","client":"tui"}
<- {"type":"hello_ack","ok":true,"connectionId":"c-01","version":"0.9.0","protocolVersion":1}
-> {"type":"lease_acquire","id":"r1","workspaceName":"volt","sessionId":"s-abc"}
<- {"type":"lease_granted","id":"r1","workspaceName":"volt","sessionId":"s-abc","handoff":"none"}
<- {"type":"relay_offer","relayId":"rl-7","relayToken":"tK…","workspaceName":"volt","sessionId":"s-abc","clientNodeId":"n-phone","connectionId":"ic-3","streamId":"st-9"}
   (TUI dials new unix conn)
-> {"type":"hello","role":"relay","protocolVersion":1,"relayId":"rl-7","relayToken":"tK…"}
<- {"type":"hello_ack","ok":true}
<- {"type":"relay_preamble","relayId":"rl-7","handshake":{…verbatim…},"authorization":{"clientNodeId":"n-phone","workspaceName":"volt","workspacePath":"/Users/x/volt"},"connectionId":"ic-3","streamId":"st-9","resolvedTarget":{"sessionId":"s-abc","selection":"resumed",…}}
   (raw bytes both ways from here; first TUI write is the handshake success response)
```

TUI acquire against a mid-turn daemon runtime (drain):

```jsonl
-> {"type":"lease_acquire","id":"r2","workspaceName":"volt","sessionId":"s-abc"}
<- {"type":"lease_pending","id":"r2","viewerFeedId":"vf-1"}
-> {"type":"viewer_subscribe","id":"r3","viewerFeedId":"vf-1"}
<- {"type":"ok","id":"r3"}
<- {"type":"viewer_event","viewerFeedId":"vf-1","seq":0,"event":{"type":"message_delta",…}}
<- {"type":"viewer_event","viewerFeedId":"vf-1","seq":1,"event":{"type":"agent_end",…}}
<- {"type":"viewer_end","viewerFeedId":"vf-1","reason":"granted"}
<- {"type":"lease_granted","id":"r2","workspaceName":"volt","sessionId":"s-abc","handoff":"warm"}
```

### 5.9 Stale socket recovery & single instance

Already specified in §3.1: connect → `status` probe → 2s timeout → unlink → retry bind once.

---

## 6. TUI Integration

Surgical changes to `src/modes/interactive/interactive-mode.ts` plus a new façade `src/modes/interactive/daemon-attach.ts` wrapping `src/daemon/control-client.ts`. InteractiveMode is 7152 lines with 64 distinct `this.session.*` member uses — deep coupling that justifies co-locating the runtime with the TUI rather than remoting it.

### 6.1 `daemon-attach.ts` façade

```ts
export interface DaemonAttach {
  /** All methods resolve successfully as no-ops when daemon is off/unreachable. */
  acquire(ws: string, sessionId: string): Promise<AcquireOutcome>; // granted|pending(viewer)|denied|noop
  release(ws: string, sessionId: string): Promise<void>;
  rekey(ws: string, oldId: string, newId: string): Promise<void>;
  forwardPushRegister(ws: string, sessionId: string, payload: unknown): Promise<void>;
  onRelayOffer(handler: (offer, openRelay) => void): void;
  relayCount(): number;                      // for footer indicator
  onRelayCountChange(cb: (n: number) => void): void;
  connectionState(): "connected" | "reconnecting" | "gone" | "disabled";
  dispose(): Promise<void>;
}
```

Constructed at TUI startup whenever the platform supports it. `remote.background === true` enables auto-spawn; otherwise the attach remains in reconnect backoff until another process starts the daemon. Unsupported platforms use a `disabledDaemonAttach` stub where every method is an immediate no-op. **No InteractiveMode code path may throw or block on daemon absence.**

### 6.2 Lifecycle seams (exact insertion points)

| Seam | Location | Action |
|------|----------|--------|
| Startup | after `bindCurrentSessionExtensions()` completes for the initial session (call site ~L1741 within the startup flow; method defined L1631) | `acquire(ws, session.id)`; handle pending (drain viewer, §6.3) / denied (`held_by_tui` → read-only banner) |
| `/new`, resume, fork, tree-navigate | the same seams that fire extension `session_shutdown` → `session_start` (reasons `new`/`resume`/`fork`) | `release(ws, oldId)` **before** the old session's shutdown completes is not required — order is: begin switch → `release(old)` → normal switch → `acquire(new)` after the new `bindCurrentSessionExtensions` |
| Session id change in place (compaction/rekey without shutdown) | wherever `session.id` changes without the shutdown/start pair | `rekey(ws, oldId, newId)` |
| Quit | TUI shutdown path (after final flush, before process exit) | if `session.isStreaming` && `relayCount() > 0` → exit warning prompt ("A phone is attached and a turn is streaming; quitting will kill the turn. Quit anyway?"); then `release(ws, id)`; `dispose()` |

`ws` (workspaceName) resolution: the daemon's workspace registry maps registered names→paths; the TUI resolves its cwd against `status_result.workspaces` (longest-prefix match on real paths). When connected, the TUI sends `workspace_register` automatically if its cwd is inside no registered workspace — name = basename with numeric suffix on collision.

### 6.3 Drain viewer ("Attaching — finishing remote turn…")

On `AcquireOutcome.pending{viewerFeedId}`:

1. TUI sends `viewer_subscribe{viewerFeedId}` and enters a read-only attach overlay: editor disabled, status line "Attaching — finishing remote turn…", input keystrokes buffered into a local queue (plain text only; commands ignored).
2. Each `viewer_event` is rendered through the same event-rendering path used for live session events where feasible; implement as a lightweight renderer that feeds `AgentSessionEvent` objects into the existing message/tool renderers WITHOUT a live session (new `src/modes/interactive/drain-viewer.ts`). If `viewer_event{kind:"truncated"}` arrives first, show spinner only.
3. On terminal `lease_granted{handoff:"warm"}`: dismiss overlay, load the session from file via the normal resume path (which fires `session_start` reason per the seam), then flush the queued input into the editor (not auto-submit).
4. On `viewer_end{reason:"error"}` / response `error{drain_failed}`: show notice, fall back to read-only open with a retry hint.

### 6.4 Rekey and relays

When `onSessionChanged` fires inside a TUI-served relay (or the TUI itself rekeys), `daemon-attach.rekey` updates the broker; the daemon closes affected relays `session_rekeyed_reconnect`; phones reconnect and re-validate selection. The TUI does not tear down its runtime.

### 6.5 Reconnect behavior

On DaemonClient reconnect, `daemon-attach` re-sends `lease_acquire` for the currently open session. If the response is `granted{handoff:"warm"}` (daemon had spun up a runtime during the gap), the TUI calls `session.reload()` (agent-session.ts L2657-2681) to absorb file changes; extension lifecycle follows reload semantics (reason `"reload"`). `pending` follows the drain viewer path with the current transcript kept on screen behind the overlay.

### 6.6 Push notification / workspace forwarding

Relayed conversations must keep push working after TUI exit, so push state lives in the daemon. The relay's `remoteCommandHandler` intercepts the state-touching RPC commands (`RELAY_RPC_COMMAND_TYPES`: `register_push_target`, `unregister_workspace`) and forwards them verbatim as `relay_rpc` control requests carrying the phone's `clientNodeId` and the TUI's current session id. The daemon executes them against its real state (push dispatcher and workspace registry with full unregister cleanup) and returns the verbatim RPC response in `relay_rpc_result`, which the TUI relays to the phone; `unregister_workspace` results also carry refreshed workspace metadata for the TUI's authorization decoration. Notification dispatch always happens daemon-side.

### 6.7 Abort symmetry and command handling

The TUI's relay command handler (shared `conversation-commands.ts`) implements the new abort: on `abort` → `session.abort()` (agent-session.ts L1535-1539) + `waitForIdle`, reply success, **stream stays open**. Local TUI abort (Esc) is now behaviorally identical from the phone's perspective: the phone sees the turn end (`agent_end`/idle events) and its stream stays open. No `onResponseWritten` stream invalidation anywhere.

### 6.8 Footer indicator

Add a "phone attached" segment via the existing footer-data-provider seam (the mechanism used by `setFooter`/footer data providers in interactive mode): visible when `relayCount() >= 1`, shows `📱 n` (or `[phone n]` in ASCII terminals). Updates on `relay_offer` accept / `relay_closed`.

### 6.9 Extension dialogs bind to the owner frontend

For TUI-owned runtimes, extension UI requests route to the TUI's real `ExtensionUIContext` (created via `createExtensionUIContext`, theme mappings interactive-mode.ts L2242-2261). Phones do **not** receive `extension_ui_request` for TUI-owned runtimes — the outbound filter for relayed streams suppresses `extension_ui_request` frames. (Mechanism: `runIrohRemoteRpcMode`'s outbound filter layer gets an option `suppressExtensionUiRequests: boolean`, set `true` for relayed streams in the TUI and `false` for daemon-owned streams.) Rationale: dialogs are answered where the extension's mediated UI actually lives; split-brain answers are worse than phone silence. docs/rpc.md gets a note (M10).

---

## 7. Daemon-Owned Runtime Path (headless)

### 7.1 Construction

`integrated-runtimes.ts` builds runtimes with `createIrohRemoteAgentRuntimeWithSessionSelection` (iroh-remote-agent-runtime.ts L85) using the pre-resolved target (§3.7). Selection kinds `created` / `created_after_missing` / `resumed` and host-synthesized `session_rekeyed` behavior are preserved bit-for-bit for the iOS selection validation.

### 7.2 Serving streams

Each attached phone stream is served by `runIrohRemoteRpcMode(entry.runtime, options)` with the ported option bundle (decorateOutbound host-state decoration, `disposeRuntimeOnClose:false`, push dispatcher as `notificationDelivery` + `registerPushTarget`, `onSessionChanged` → rekey, `onWorkflowEvent` → workflow replay bookkeeping, `remoteCommandHandler` → shared `conversation-commands.ts`, `initialInput`, workspace name/path). Attach/detach subscriber logic ports from iroh-host.mjs L2624-2682; stop from `stopIntegratedRuntimeEntry` L2684-2723. **Workflow event replay** on (re)attach is preserved (port `replayIntegratedRuntimeWorkflowEvents`).

### 7.3 Extensions in daemon mode

`ExtensionRunner` loads normally (loader reads `pkg.volt` or Pi-compatible `pkg.pi`, loader.ts L492-506; tool wrapping via wrapper.ts `wrapRegisteredTool` injecting `runner.createContext`). `ctx.mode === "rpc"` (`ExtensionMode`, types.ts:301). UI context is the rpc-mediated one: dialogs (`select/confirm/input/editor`) go over `extension_ui_request` to phones per docs/rpc.md L1513+; `custom()` returns undefined; `setFooter/setHeader/setEditorComponent` no-op; `setWidget` component factories ignored (runner.ts `noOpUIContext` L230-265 shape for the terminal-only surface). This is today's documented degradation — unchanged.

### 7.4 Abort redesign (daemon side)

Delete `invalidateStreamAfterAbortResponse` (iroh-host.mjs L1556-1564: on successful abort it removed the active stream, stopped the runtime entry, and closed the Iroh stream). New behavior in shared `conversation-commands.ts`:

```
abort command -> session.abort() -> await session.waitForIdle()
             -> respond { success: true }
             -> stream stays open; runtime stays live; lease state unchanged
```

No `onResponseWritten` hook is passed anywhere. Audit keeps recording the abort as a command execution; no `runtime stop reason "abort"` events exist anymore.

### 7.5 Prompt streaming behavior

Unchanged: `prompt` while streaming requires `streamingBehavior: "steer" | "followUp"` (agent-session.ts L1153-1166); `queue_update` events (in the event union L138-163) flow to all subscribers, so a TUI viewing a daemon drain and a second phone both see queued steering.

---

## 8. Extension Compatibility Contract

**Fixed constraint: zero source changes to `ExtensionContext` / `ExtensionAPI` / `ExtensionUIContext` (types.ts).** Theme facade shape (types.ts:261-270: `theme` getter, `getAllThemes()`, `getTheme(name)`, `setTheme(string|Theme)`) preserved exactly. Lifecycle reasons remain the existing unions: `session_start` reasons `startup|reload|new|resume|fork`; `session_shutdown` reasons `quit|reload|new|resume|fork`. **No new lifecycle event** (no `session_switched`).

What a Pi extension experiences, by lease state of its host process:

| Situation | ctx.mode | UI dialogs | custom()/setFooter/setHeader/setEditorComponent | theme APIs | lifecycle observed |
|---|---|---|---|---|---|
| TUI-owned, no phones | `"tui"` | real TUI dialogs | full fidelity | live ThemeService (TUI facade) | normal |
| TUI-owned, phones relayed | `"tui"` | real TUI dialogs (phones suppressed §6.9) | full fidelity | live ThemeService | normal; phone prompts are indistinguishable from local prompts |
| Daemon-owned (headless) | `"rpc"` | mediated over extension_ui_request to phones; on iOS only `confirm` is answerable, `select/input/editor` auto-cancelled (volt-app `VoltSession+HostActions.swift` 381-396) | undefined / no-ops per docs/rpc.md | ThemeService rpc facade (§9.4): `getAllThemes()` returns real list, `setTheme` persists + broadcasts, `ctx.ui.theme` returns last resolved snapshot | normal |
| Handoff daemon→TUI | old instance: `session_shutdown{reason:"quit"}` then disposed with runtime; new instance in TUI: fresh `load` + `session_start{reason:"resume"}` (or the TUI's actual open reason) | — | — | — | exactly the same as user quitting a headless session and resuming in a TUI |
| Handoff TUI→daemon | old: `session_shutdown{reason:"quit"}` at TUI exit; new (lazy, on next phone attach): fresh load + `session_start{reason:"resume"}` in the daemon | — | — | — | same as quit+resume |

Guarantees the implementation must uphold:

1. Extensions never migrate in-memory state across processes. Anything an extension wants to survive handoff must already live in the session file or its own storage — identical to surviving `volt` quit/reopen today. Document this in docs/extensions.md (M10).
2. `AgentSession.dispose()` invalidates the extension context (agent-session.ts L781-800; runner.ts `invalidate` L510-517) — the dispose ordering in drain (§4.3 step 5) and shutdown (§3.9 step 3) must go through the normal dispose path so this happens.
3. `runner.setUIContext` (runner.ts L400-403) is only ever called with the owner-appropriate context; relays never swap the TUI's UI context.
4. Loader behavior (pkg.volt / pkg.pi, loader.ts L492-506) and tool wrapping (wrapper.ts) are untouched.
5. `commandContextActions` / `uiContext` passed at `bindCurrentSessionExtensions` (interactive-mode.ts L1631) are untouched in shape.

---

## 9. Theme Service

### 9.1 Problem

`src/modes/interactive/theme/theme.ts` is a module-global Proxy singleton (globalThis-keyed, L732), with a single `onThemeChange` callback slot and an fs watcher (L812-892). The daemon cannot import interactive-mode internals, and a singleton with one subscriber cannot serve daemon + broadcast needs.

### 9.2 New module: `src/core/theme/`

```
src/core/theme/
  theme-service.ts    // ThemeService class
  tokens.ts           // token resolution (moved from modes/interactive/theme/theme.ts)
  discovery.ts        // theme file discovery per docs/themes.md locations
  types.ts            // Theme, ThemeName, ResolvedThemeTokens
  index.ts
```

```ts
export interface ThemeService {
  readonly current: Theme;                       // resolved active theme
  getAllThemes(): Theme[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: string | Theme): Promise<void>;
  resolveTokens(theme?: Theme): ResolvedThemeTokens;   // flat token map for snapshots
  subscribe(cb: (theme: Theme) => void): () => void;   // subscriber LIST, not single slot
  /** hot-reload fs watcher — enabled ONLY by the rendering (TUI) process */
  enableHotReload(): void;
  dispose(): void;
}
export function createThemeService(opts?: { agentDir?: string; initialTheme?: string }): ThemeService;
```

Instanced: TUI creates one at `initTheme` (interactive-mode.ts L481 seam) with `enableHotReload()`; the daemon creates one without the watcher; CLI paths (config-selector, startup-ui, export-html) create ephemeral instances or receive one.

### 9.3 Importer migration (complete list, from current imports of the singleton)

Migrate every importer of `modes/interactive/theme/theme.ts` to receive/construct a `ThemeService` (or a bound token-resolver where a full service is overkill):

- `src/core/agent-session.ts:35`
- `src/core/resource-loader.ts:5`
- `src/core/extensions/runner.ts:8`
- `src/core/extensions/types.ts:43` (type-only import — repoint to `src/core/theme/types.ts`; NO shape change)
- `src/core/export-html/*` (all files importing theme)
- `src/core/tools/*`: `bash`, `edit`, `find`, `grep`, `ls`, `lsp`, `read`, `render-utils`, `subagent`, `web-search`, `write`
- `src/main.ts:72`
- `src/index.ts:775`
- `src/cli/config-selector.ts`
- `src/cli/startup-ui.ts`

A compatibility Proxy re-export at the old path MAY remain during the milestone to keep the tree green mid-migration, but M6's acceptance criteria require zero remaining imports of the old path and deletion of the shim. Tools that only need colors at render time should take a `ResolvedThemeTokens`/theme accessor through their existing context plumbing rather than a service instance (implementer's choice per tool; the acceptance criterion is only "no module-global theme").

### 9.4 Pi facade per mode (shape unchanged, types.ts:261-270)

| API | TUI (`mode:"tui"`) | Daemon (`mode:"rpc"`) |
|---|---|---|
| `ctx.ui.theme` (getter) | live `service.current` | last resolved snapshot (`service.current` of the daemon's instance) |
| `getAllThemes()` | full list | full list (**supersedes** docs/rpc.md's "returns []" — update doc, M10) |
| `getTheme(name)` | lookup | lookup |
| `setTheme(x)` | applies + re-render | persists to daemon settings, applies to daemon instance, broadcasts `theme_snapshot{themeName, tokens}` to all control connections (**supersedes** docs/rpc.md's "fails in rpc mode") |

TUIs receiving `theme_snapshot` for a theme they didn't set: apply only if the user hasn't set a per-TUI theme override this session; otherwise ignore (local explicit choice wins). Keep this rule simple and documented.

### 9.5 Optional milestone (M11): iOS token push

Feature-flagged, additive: daemon pushes sanitized resolved tokens (hex colors only, denylist anything path-like) as a new notification frame `host_theme_tokens` on workspace streams, gated on the phone advertising a future feature string. `volt-app/Volt/Theme/` today is static caseless enums (`VoltPalette`, `VoltSpacing`, `VoltTypography`) with **no host data path and no theme RPC in `VoltRPC.swift`** — the iOS side would add a `HostThemeStore` mapping tokens onto VoltPalette accessors. Ship OFF by default; app MAY ignore the frame entirely. No acceptance dependency for M1-M10.

---

## 10. iOS App Deltas (volt-app; breaking OK, enumerate exactly)

The app keeps advertising BOTH `multi_streams.v1` and `conversation_streams.v1` (handshake requires both — `IrohProtocol.swift:375-377`). The host MAY additionally advertise `conversation_leases.v1` (additive; app MAY ignore, D11 makes it optional-but-useful).

| # | Delta | Affected Swift files | Detail |
|---|-------|----------------------|--------|
| D1 | **Abort contract change (breaking).** Abort success now means: turn stopped, stream STAYS open, runtime stays live. Remove the abort→expect-closure→reopen dance. | `Volt/.../VoltSession+Prompting.swift` | At `:140+`: keep sending the abort command and recording `SelectedAbortRequest` for UI state, but DELETE `markUserAbortClosureExpected`. `handleSelectedAbortResponse` (`:222`): on success, clear pending abort UI, do NOT arm closure expectation. DELETE `completePendingSelectedAbortAfterExpectedClosure` (`:261`) and its call sites. DELETE `scheduleSelectedAbortRecovery` (`:297`) and its reopen-via-`selectPinnedAgent` path. |
| D2 | **Remove user-abort closure ledger markers.** | `ConversationClosureLedger` (file containing it), `VoltSession+Connect.swift` (`:535`, `:549`), `WorkspaceEventStreams.swift` (`:126`) | Remove userAbort marker recording (10s TTL) and the two Connect.swift + one WorkspaceEventStreams.swift call sites of `completePendingSelectedAbortAfterExpectedClosure`. Ledger stays for other expected-closure kinds (incl. new D9). |
| D3 | **`conversation_in_use` vestigial at handshake.** Host never emits it at handshake for paired clients. | `FailureClassification.swift:143-146`, `PinnedAgentStatus` definition, any UI rendering `.inUse` | Keep the classification mapping for forward-compat (harmless), but mark `.inUse` handling as vestigial with a comment; delete any proactive UX built around expecting it (e.g., "in use by another device" retry prompts) if such flows are wired to handshake outcomes. No new behavior required. |
| D4 | **`duplicate_conversation_connection` unchanged.** | `VoltHostSessionManager+AgentSelection.swift` | Keep retry loop max 5 attempts, backoff+jitter, `retryAfterMs` clamp 500-5000. Verify tests still pass against daemon host. |
| D5 | **New transient error `lease_draining` on prompt.** | `FailureClassification.swift`, prompt error handling in `VoltSession+Prompting.swift` | Classify as retryable-transient; honor `retryAfterMs` (default 1000ms); surface as brief "Handing off to desktop…" toast, auto-retry a few times, then leave the composer content intact for manual retry. |
| D6 | **Selection validation unchanged.** | `IrohProtocol.swift` (`selectionIsValid`, `validatedRequestedSessionId`) | `.last/.new/.session` targets and `created/created_after_missing/resumed` + `session_rekeyed` handling stay as-is; daemon preserves semantics (§3.7, §7.1). Re-run existing tests. |
| D7 | **Backgrounding unchanged.** | `VoltHostSessionManager.swift:175-190`, `VoltSession+Lifecycle.swift` (`suspendForBackgroundRecovery`) | Detach-only backgrounding still correct; daemon-detached retention gives 30min reattach. No change. |
| D8 | **Foreground reconnect + catchup unchanged.** | `VoltSession+Connect.swift:408-412`, `VoltSession+PostCommitCatchup.swift` | `set_client_capabilities` / `get_pending_host_actions` / `get_state` / `get_transcript` sequence and post-commit catchup barrier (max 500 entries / 2 MiB) work against both daemon-owned and relayed streams (relay is byte-transparent). No change; add a test against a relayed fake. |
| D9 | **New close reason `lease_transferred` = expected closure → immediate reconnect.** | `ConversationClosureLedger` (or the closure-reason → reconnect policy map), `VoltSession+Connect.swift` reconnect scheduling | Map `lease_transferred` (and `session_rekeyed_reconnect`) to expected-closure: no error UI, reconnect immediately (no backoff first attempt). This is THE hook that makes TUI-open/TUI-quit invisible on the phone. |
| D10 | **Transcript merge already multi-origin ready — verify.** | `VoltSession+Transcript.swift` | remoteEntryID dedupe + optimistic reconciliation appending unmatched incoming user entries must accept user entries originating from the TUI. Expected zero code change; add a VoltClient test with an interleaved TUI-origin user entry. |
| D11 | **Optional: recognize `conversation_leases.v1`.** | `IrohProtocol.swift` feature parsing | If present, the app MAY show "shared with desktop" affordance and expect `lease_transferred` closures; ignoring the feature is fully safe. |
| D12 | **Extension UI: no `extension_ui_request` while TUI owns the lease.** | `VoltSession+HostActions.swift:381-396` | No code change needed (fewer requests arrive); update in-code comment: only `confirm` is answerable, `select/input/editor` auto-cancelled, and TUI-owned conversations produce none. |

---

## 11. Security Considerations

1. **Unix socket trust boundary.** `daemon/` dir `0700`, socket `0600`, owned by the user. Anyone who can connect is the same OS user, who already owns the agent dir, session files, and could read the Iroh secret key — the socket adds no privilege. No socket auth beyond filesystem perms. Relay tokens (single-use, 10s) exist to bind a relay connection to a specific offer, not as an auth boundary.
2. **Iroh termination stays in the daemon.** Phone identity verification (paired clientNodeId), handshake parsing, and revocation checks all complete before any relay is offered. The TUI receives only post-auth streams plus the authorization subset. Revocation (`client_revoke`) closes live streams and relays for that client immediately.
3. **Tool policy (explicit decision).** When the TUI owns the lease, phone prompts execute with the **TUI session's full local tool set** — the phone is the same paired user driving the same conversation; splitting tool policy mid-conversation creates confusing, falsely-reassuring states. This **supersedes `--allow-tools` for co-attached conversations**. Daemon-owned headless runtimes keep the allow-tools restriction (`settings.allowTools`). `docs/security.md` MUST document this asymmetry prominently (M10), including the corollary: pairing a phone grants it desktop-equivalent power over any TUI-open conversation.
4. **`conversation_in_use` policy exception** removes the old pseudo-lock for compatible clients while rejecting a narrower client that would otherwise inherit a broader daemon runtime. Documented in security.md.
5. **State file** contains the Iroh secret key — `state.json` written `0600` (enforce on write), as `remote/iroh-host.json` is today.
6. **Audit** (§3.10) covers lease/relay/daemon lifecycle so post-hoc "what did the phone do while I was away" review is possible (`volt daemon logs` + `audit.jsonl`).
7. **Frame cap** (8 MiB) bounds control-plane memory; relay pipes are unframed and bounded by stream backpressure.
8. **No new network listeners.** The daemon listens only on the unix socket and the existing Iroh endpoint.

---

## 12. Testing Strategy

Volt entry point: `./test.sh` (repo root of Volt). iOS: VoltClient package tests in volt-app.

### 12.1 Test infrastructure to build

- `src/daemon/testing/fake-clock.ts` — injectable timers for lease broker (retention, token expiry, drain).
- `src/daemon/testing/loopback-control.ts` — in-memory duplex pair implementing the control framing (no real socket) for protocol tests; plus a real-socket harness (tmpdir socket) for integration tests.
- `src/daemon/testing/fake-phone.ts` — drives the conversation-plane JSONL protocol (handshake, prompt, abort, get_transcript) over an arbitrary Duplex — reused against daemon-owned streams AND relayed streams. Build on existing loopback rpc utilities (`src/modes/rpc/in-process-rpc-client.ts`, `createLoopbackRpcTransportPair`).

### 12.2 Unit tests

1. **Lease broker** (`lease-broker.test.ts`): every cell of the §4.2 table; idempotent acquire; connection-loss implicit release; draining cancel on requester disconnect; rekey during each state; retention arm/cancel/fire; force → `force_unsupported`; `draining_elsewhere`.
2. **Control protocol** (`control-protocol.test.ts`): encode/decode round-trip for every type in §5.3-5.5; 8 MiB cap enforcement; partial-line buffering; relay hello token validation incl. expiry and reuse rejection.
3. **Relay framing** (`relay-stream.test.ts`): preamble exactness (verbatim handshake JSON, authorization subset fields); byte-transparency (random binary chunks survive both directions unmodified); half-close propagation; token single-use.
4. **State migration** (`state.test.ts`): legacy iroh-host.json → VoltdStateFileV1; secret key byte-identical; idempotency; `.migrated` rename; missing/partial legacy sections.
5. **Session target** (`session-target.test.ts`): last/new/session × existing/missing → correct selection kinds, matching current iroh-remote-agent-runtime behavior (golden tests extracted before refactor).
6. **Theme service** (`theme-service.test.ts`): discovery, token resolution parity with old singleton (golden snapshot), multi-subscriber notify, setTheme persistence hook, watcher only when enabled.
7. **Conversation commands** (`conversation-commands.test.ts`): abort → success + stream stays open (assert no close, runtime live); `INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES` rejection; `lease_draining` rejection set.

### 12.3 Integration tests (real daemon on tmpdir socket, fake Iroh transport where possible; mark network-Iroh tests optional/skipped in CI without the native module)

1. **Daemon lifecycle**: spawn → probe → status → single-instance rejection → stale-socket recovery → graceful shutdown ordering (§3.9 observable via audit lines + control events); log rotation at threshold.
2. **Handoff both directions**: (a) daemon-active + mid-turn fake turn → TUI acquire → `lease_pending` → viewer events observed → turn idle → `lease_granted{warm}` → daemon runtime disposed (extension fixture logs `session_shutdown{quit}`) → phone stream closed `lease_transferred`; (b) TUI release → `unowned` → fake-phone reconnect → lazy resume → transcript continuity (entry appended by TUI visible via `get_transcript`).
3. **Dual-frontend live session over loopback**: TUI harness (headless InteractiveMode driver or a runtime-level stand-in exercising the relay serving path) owns lease; two fake phones relay-attach concurrently; phone A prompts; assert: TUI runtime received prompt, both phones receive streamed events, `message_start` user entry carries phone origin and is renderable, abort from phone B stops turn with both streams still open.
4. **Extension fidelity fixture**: a test extension recording lifecycle events + ctx.mode + theme facade results, loaded in both owners across a handoff; assert the §8 table rows it can observe (mode value, dialogs routing, getAllThemes non-empty in rpc mode, shutdown/start reasons).
5. **Reconnect/re-acquire**: kill daemon under a lease-holding TUI harness → restart → DaemonClient reconnects → re-acquire → `warm` + reload path invoked.

### 12.4 iOS (VoltClient package tests, volt-app)

1. Abort: success response with NO subsequent closure → UI clears pending abort, no reconnect scheduled (D1/D2).
2. Closure reasons: `lease_transferred` and `session_rekeyed_reconnect` → expected-closure, immediate reconnect (D9).
3. `lease_draining` prompt error → retry with retryAfterMs, composer preserved (D5).
4. Transcript merge with interleaved TUI-origin user entry → dedup/append correctness (D10).
5. Duplicate retry loop against fake daemon responses (D4).

### 12.5 Manual walk-away verification script

Add `docs/daemon.md` appendix + `scripts/manual-walkaway.md` checklist:

1. Start the daemon manually or set `remote.background: true`; open TUI in a registered workspace; confirm `volt daemon status` shows a tui-owned lease.
2. Pair phone (`volt remote pair`), open the same conversation on phone; footer shows 📱1.
3. Phone prompt → appears live in TUI; TUI prompt → appears on phone.
4. Quit TUI → phone continues within ~2s (lease_transferred reconnect); run another turn from phone.
5. While phone turn is streaming, reopen TUI → "Attaching — finishing remote turn…" viewer → editor unlocks at turn end → full transcript incl. away-time turns.
6. Phone abort mid-turn → turn stops, phone stream stays connected (no reconnect spinner).
7. `volt daemon restart` with TUI open → footer relay indicator drops and returns; phone reconnects.

---

## 13. Implementation Plan (ordered milestones)

Each milestone leaves `./test.sh` green. Branch implements M1-M8 (+M10 docs) in one pass; M9/M11 optional.

### M1 — Shared extraction & theme lift foundations
**Files**: new `src/core/theme/*` (§9.2); new `src/daemon/session-target.ts` (+ refactor `src/modes/rpc/iroh-remote-agent-runtime.ts` to consume it); new `src/daemon/handshake-responses.ts` (port `createIntegratedConversationHandshakeResponse` + `decorateRemoteHostState` from iroh-host.mjs into typed TS); new `src/daemon/conversation-commands.ts` (port command handling; abort NOT yet changed); golden tests for target resolution + theme tokens.
**Accept**: old theme singleton still present (shim re-export); iroh-host.mjs temporarily imports nothing new (parallel code allowed); unit tests §12.2.5/§12.2.6 pass; no behavior change.

### M2 — Control protocol + daemon skeleton
**Files**: `src/daemon/control-protocol.ts`, `control-server.ts`, `control-client.ts`, `state.ts` (+migration), `spawn.ts`, `cli.ts`, `main.ts` (daemon), main.ts (CLI router: add `volt daemon *`); daemon file layout, pidfile, log rotation, single-instance, version skew, graceful shutdown skeleton (no runtimes yet).
**Accept**: `volt daemon start/stop/status/restart/logs` work end-to-end on macOS+Linux; migration test §12.2.4 passes; standalone SEA rejected; unit tests §12.2.2 pass; lifecycle integration §12.3.1 passes (minus runtime drain).

### M3 — Host rewrite: daemon-owned runtimes (parity port)
**Files**: `src/daemon/integrated-runtimes.ts`, `workspace-streams.ts`; wire `IrohRemoteHostEngine` into daemon main; port pairing (`pair_request` control flow replacing `startPairControlServer`), revocation, push notifications, audit (all existing events + `daemon_started`/`daemon_shutdown`), workflow replay, retention, `onSessionChanged` rekey plumbing (broker stub: everything `daemon-active`/`daemon-detached`), duplicate handling, UNSUPPORTED_RPC rejection. **Delete** `src/remote/iroh-host.mjs`; **delete** main.ts spawn path (L1075-1097) and `volt remote host` (replace with removal error); rewrite `volt remote pair/status/clients/revoke/workspace` as control clients.
**Accept**: a phone (or fake-phone harness) pairs, connects, prompts, backgrounds/reattaches within TTL against voltd with behavior parity to the old host; `git grep iroh-host.mjs` only hits docs/changelog; §12.3.1 fully passes.

### M4 — Lease broker + abort redesign
**Files**: `src/daemon/lease-broker.ts` (+tests), integrate into stream routing (§2.3); drop clientNodeId from runtime key; retire handshake `conversation_in_use`; new abort semantics in `conversation-commands.ts` (delete `invalidateStreamAfterAbortResponse` port); `lease_draining` rejection; audit lease events.
**Accept**: §12.2.1 and §12.2.7 pass; two fake phones (distinct clientNodeIds) co-attach to one daemon runtime and both stream; abort keeps streams open; retention interplay test passes.

### M5 — Relay path + TUI integration
**Files**: `src/daemon/relay-stream.ts`; relay admission in `control-server.ts`; `src/modes/interactive/daemon-attach.ts`; `src/modes/interactive/drain-viewer.ts`; surgical edits to `src/modes/interactive/interactive-mode.ts` (seams §6.2, footer indicator §6.8, exit warning, relay serving with `runIrohRemoteRpcMode` §5.6 step 9, `suppressExtensionUiRequests` option added to iroh-remote-rpc-mode outbound filter); push forwarding (`relay_rpc`) §6.6.
**Accept**: §12.2.3 passes; dual-frontend integration §12.3.3 passes; with the daemon stopped, InteractiveMode behavior remains unchanged apart from the dormant reconnect client; footer indicator toggles.

### M6 — Theme migration completion
**Files**: migrate ALL importers listed in §9.3; delete `src/modes/interactive/theme/theme.ts` singleton + shim (move remaining pure logic into core/theme); daemon `theme_set` + `theme_snapshot` broadcast; rpc-mode facade (getAllThemes real, setTheme persists) in runner UI-context wiring.
**Accept**: `git grep "modes/interactive/theme/theme"` returns nothing; §12.2.6 + extension fixture theme rows (§12.3.4) pass; `ctx.ui.*` types unchanged (compile-time check: a fixture Pi extension from before the branch compiles unmodified).

### M7 — Handoff (drain, viewer, lazy resume, reconnect)
**Files**: drain orchestration in `lease-broker.ts` + `integrated-runtimes.ts`; viewer feed in `control-server.ts`/`control-client.ts`; drain-viewer rendering + queued input in InteractiveMode; `lease_transferred` close reason emission; DaemonClient re-acquire + `session.reload()` on warm; auto workspace_register for TUI cwd.
**Accept**: §12.3.2 both directions; §12.3.6 reconnect; queued input lands in editor un-submitted; extension fixture observes `quit`→`resume` pairs across both handoff directions.

### M8 — iOS deltas
**Files** (volt-app): per §10 table — `VoltSession+Prompting.swift`, `VoltSession+Connect.swift`, `WorkspaceEventStreams.swift`, `ConversationClosureLedger` file, `FailureClassification.swift`, `VoltSession+Transcript.swift` (test only), `IrohProtocol.swift` (D11 optional), comments in `VoltSession+HostActions.swift`.
**Accept**: VoltClient tests §12.4 pass; manual: abort leaves stream connected; TUI quit/open invisible except momentary reconnect.

### M9 (optional) — `volt daemon install-service`
**Files**: `src/daemon/cli.ts` (+ templates). **Accept**: generated launchd plist/systemd unit boots a working daemon after logout/login.

### M10 — Documentation
**Files**: README "Remote Access Preview" section (daemon model, no more `remote host`); `docs/usage.md` (`volt daemon` family, revised `volt remote`); `docs/security.md` (§11.3 tool-policy decision, in_use retirement); `docs/rpc.md` (extension UI: phones get no extension_ui_request for TUI-owned runtimes; theme rpc-mode statements superseded per §9.4); `docs/iroh-remote-access-design.md` (superseded banner pointing here); `docs/settings.md` (`remote.background`); new `docs/daemon.md` (file layout, CLI, lease model, troubleshooting, manual walkaway script); `docs/extensions.md` (handoff = quit+resume note).
**Accept**: docs build (`docs.json` updated); no doc references `volt remote host` as a live command.

### M11 (optional) — iOS theme token push (§9.5)
**Accept**: flag off by default; app ignores frame safely when off/unrecognized.

---

## 14. Risks & Mitigations, Open Questions

### 14.1 Risks

| Risk | Mitigation |
|------|------------|
| InteractiveMode edits regress the daemon-off path | §6.1 no-op façade rule; M5 acceptance requires byte-identical daemon-off behavior; keep all new code behind `daemonAttach` calls. |
| Drain never converges (runaway turn) | Prompt-class rejection (§4.5) prevents new turns; abort is available and non-destructive; user can abort from phone or from the TUI drain overlay (add an "Abort remote turn" keybinding in drain-viewer sending abort via a temporary control channel — implement as `viewer` extension: `viewer_abort{viewerFeedId}` control request, daemon calls `session.abort()`; ADD this request to §5.3 catalog: `{ type:"viewer_abort"; id; viewerFeedId }` → `ok`). |
| Relay byte-pipe hides protocol drift between daemon handshake and TUI serving | Handshake response construction shared (`handshake-responses.ts`); preamble carries verbatim handshake + resolved target; §12.2.3 transparency tests. |
| Port of 3731-line host loses subtle behavior (replay, decoration, retention edge cases) | Parity milestone M3 before any behavior change (M4+); golden tests extracted from current behavior in M1; audit-event parity check (diff event-type sets old vs new). |
| Daemon leaks runtimes (lease bookkeeping bugs) | Broker is sole authority with invariant asserts (runtime entry exists ⟺ state ∈ daemon-*); `volt daemon status` exposes the lease table; retention TTL is a backstop for detached runtimes. |
| Version skew after `npm update` leaves an old daemon serving | §3.8 idle auto-restart + warning; `status` always reports both versions. |
| Secret-key migration bug forces re-pairing | Byte-identical key assertion in migration tests; legacy file kept as `.migrated` for manual recovery. |
| Two TUIs in the same workspace fight over one session | Explicit `held_by_tui` denial + read-only open; multi-TUI is a stated non-goal. |
| Unix socket path length limits (104/108 bytes) with deep home dirs | Compute at startup; if too long, fall back to an agent-directory-scoped socket at `$XDG_RUNTIME_DIR/voltd-<uid>-<hash>.sock` (or `/tmp/voltd-<uid>/voltd-<hash>.sock` with the directory mode 0700) and record the actual path in the pidfile, which clients read when the default probe fails. |

### 14.2 Appendix A: iroh-host.mjs function → new home mapping (port checklist)

Every exported/major function in the dissolved script must land somewhere or be deliberately deleted. The implementer completes this table during M3 by grepping the script top-to-bottom; the known majors:

| iroh-host.mjs symbol (anchor) | Disposition |
|---|---|
| `serve()` (L3458-3639) | split: engine wiring → `daemon/main.ts`; per-stream routing → `control-server.ts` + `integrated-runtimes.ts` + `workspace-streams.ts` |
| `runIntegratedVoltConnection` (L1497-1632) | `integrated-runtimes.ts` (daemon-owned serve) + §5.6 (relayed serve in TUI); option bundle preserved per §7.2 |
| `invalidateStreamAfterAbortResponse` (L1556-1564) | **DELETED** (§7.4) |
| `createIntegratedConversationHandshakeResponse` | `daemon/handshake-responses.ts` (shared) |
| `decorateRemoteHostState` | `daemon/handshake-responses.ts` or sibling shared module (§5.6 step 9 note) |
| `getIntegratedRuntimeRegistryKey` (L2298) | replaced by lease key `${workspaceName}\0${sessionId}` in `lease-broker.ts` |
| `attachIntegratedRuntimeSubscriber` / detach (L2624-2682) | `integrated-runtimes.ts` |
| `stopIntegratedRuntimeEntry` (L2684-2723) | `integrated-runtimes.ts` |
| retention scheduling (L2741-2774) | `integrated-runtimes.ts` + existing `src/remote/integrated-runtime-retention.ts` |
| `handleIntegratedRuntimeSessionChanged` (L2168-2179) | `integrated-runtimes.ts` → `leaseBroker.rekey` |
| `handleIntegratedConversationRpcCommand` | `daemon/conversation-commands.ts` (shared daemon+TUI) |
| `replayIntegratedRuntimeWorkflowEvents` / `handleIntegratedRuntimeWorkflowEvent` | `integrated-runtimes.ts` |
| duplicate rejection (L2912-2939) | `lease-broker.ts` routing layer (§4.6), semantics preserved incl. retryAfterMs 500 + replace-stale |
| `startPairControlServer` (L3357) | **DELETED**; replaced by `pair_request` control flow (§3.6) |
| push dispatcher creation (`createPushNotificationDispatcher`) | daemon-side dispatcher in `integrated-runtimes.ts` reusing `core/remote/iroh/push.ts`; TUI relays forward via `relay_rpc` (§6.6) |
| workspace/device-log stream serving | `workspace-streams.ts` on `workspace-rpc.ts` / `device-log-rpc.ts` |
| audit emission sites | preserved 1:1; new events per §3.10 |
| `cleanupUncommittedIntegratedRuntimeEntry` / `commitIntegratedRuntimeEntry` / `closeReplacedActiveStreams` / `registerActiveStream` | `integrated-runtimes.ts` on `active-stream-registry.ts` |

Acceptance for the checklist: an M3 review artifact (PR description table) lists every function ≥10 lines from the script with its disposition; "forgotten" is not a valid disposition.

### 14.3 Appendix B: settings & config surface

`docs/settings.md` additions (M10):

| Setting | Type | Default | Effect |
|---|---|---|---|
| `remote.background` | boolean | `false` | Enables daemon auto-spawn at `volt` startup. On supported platforms the DaemonClient, lease integration, and auto workspace registration activate whenever any process starts the daemon. |
| `remote.detachedRuntimeTtlMs` | number | 1800000 | Mirrors daemon `settings.detachedRuntimeTtlMs`; `volt daemon start` syncs CLI-side setting → daemon state on connect (daemon state is authoritative at runtime). |
| `remote.allowTools` | string[] \| null | null | Tool allowlist for daemon-owned headless runtimes ONLY (§11.3). Ignored for TUI-owned co-attached conversations by design. |

`VoltdConfig` (daemon/main.ts):

```ts
export interface VoltdConfig {
  agentDir: string;          // getAgentDir()
  socketPath?: string;       // default computed; §14.1 fallback for long paths
  logPath?: string;
  foreground: boolean;       // true under `volt daemon run --foreground`
  clock?: Clock;             // injectable for tests
}
```

Daemon log line format: `<iso8601> <level> <subsystem> <message> <json-details?>` — plain text, greppable, no JSON-only logging (audit.jsonl is the structured record).

### 14.4 Open questions (minimized; defaults decided)

1. **Should the TUI auto-register its cwd as a workspace?** Decided **yes** (§6.2) — otherwise G1 silently fails for unregistered dirs. Revisit only if name-collision UX proves confusing.
2. **Apply daemon `theme_snapshot` to a TUI that set its own theme?** Decided **no** (local explicit choice wins, §9.4).
3. **Drain viewer rendering fidelity** — full renderer reuse vs. minimal event log. Decided: best-effort reuse via `drain-viewer.ts`; truncation fallback to spinner (§6.3). Fidelity gaps are cosmetic and post-grant file load is authoritative.
4. **Retention TTL for daemon runtimes with zero phone history (created by TUI release)** — none exist: release goes straight to `unowned` with no runtime (§4.4). No question remains.
5. **launchd/systemd auto-install by default?** Deferred to M9 as opt-in `install-service`; auto-spawn-on-`volt`-start covers the primary UX.

---

*End of RFC.*
