# Background daemon (voltd)

`voltd` is a persistent background daemon that owns Volt's remote-access
plane: the stable Iroh endpoint identity, phone pairing and revocation,
workspace registration, push notification dispatch, headless conversation
runtimes, and the conversation lease broker that lets a phone and a desktop
TUI share one live conversation.

It replaces the old foreground `volt remote host` process. Remote access no
longer requires a dedicated terminal: the daemon keeps running when every TUI
is closed, and paired phones stay paired across restarts because the Iroh
secret key lives in the daemon's state file.

## Quick start

```bash
volt daemon start          # start the daemon (no-op if already running)
volt remote pair           # pair a phone (QR / ticket)
volt daemon status         # inspect workspaces, clients, leases
```

Every supported interactive Volt process connects to a running daemon,
registers its working directory as a workspace, and acquires a conversation
lease for the open session so a paired phone can co-attach to it live. Set
`remote.background: true` to additionally start the daemon on demand. A TUI
that was already open while the daemon was stopped reconnects automatically
when another process starts it.

## CLI

```
volt daemon start                 Start the background daemon.
volt daemon stop                  Graceful shutdown (state flushed, phones notified).
volt daemon status [--json]       Status; exit 0 only when phone transport is ready.
volt daemon restart               Stop then start; persistent state survives.
volt daemon logs [-f] [-n N]      Tail the daemon log.
volt daemon install-service       Register a login service (launchd/systemd).
volt daemon uninstall-service     Remove the login service.
volt daemon run --foreground      Run in this process (internal; used by start).

volt remote pair [--workspace <name>]   Create a pairing ticket, wait for the phone.
volt remote status [--json]             Same status view as volt daemon status.
volt remote clients                     List paired clients.
volt remote revoke <node-id>            Revoke a client and close its connections.
volt remote approve-repair <node-id>    Allow a revoked node ID to re-pair.
volt remote workspace add [path] [--name <name>]
volt remote workspace remove <name>
volt remote workspace list
volt remote worktree add [--workspace <name>] [--name <id>] [--branch <ref>] [--base <ref>]
volt remote worktree list [--workspace <name>] [--json]
volt remote worktree remove <id> [--workspace <name>] [--force]
volt remote worktree prune [--workspace <name>]
volt remote worktree diff <id> [--workspace <name>]
```

`volt remote host` is gone; running it prints a pointer to `volt daemon
start`. The daemon requires a Node.js npm install or source checkout with the
exact required `@hansjm10/volt-iroh` wrapper and its optional selected native
binding. Installs made with `--omit=optional` cannot provide phone transport,
and Darwin x64 has no binding. Standalone Node SEA builds do not bundle Iroh and
cannot host the daemon.

`volt daemon install-service` writes a launchd LaunchAgent (macOS) or a
systemd user unit (Linux) that starts the daemon at login. The service does
not auto-restart after a graceful `volt daemon stop`; on Linux, run
`loginctl enable-linger` if the daemon should also run without an active
login session.

## File layout

Everything lives under `~/.volt/agent/daemon/` (mode `0700`):

| File | Purpose |
|------|---------|
| `voltd.sock` | Control socket (JSONL protocol; mode `0600`) |
| `voltd.pid` | Advisory pidfile; liveness truth is always a socket probe |
| `voltd.log` | Daemon log (`volt daemon logs`) |
| `state.json` | Iroh secret key, paired clients, workspaces, settings (`0600`) |
| `work-state.json` | Private, bounded session-to-change and pull-request associations (`0600`) |
| `audit.jsonl` | Append-only audit log (pairing, leases, relays, lifecycle) |

On first start the daemon migrates the legacy `remote/iroh-host.json` state
file automatically and renames it to `.migrated`. A pre-grant file keeps the
Iroh secret key (so the saved host identity does not rotate) plus validated
workspace/worktree metadata, but intentionally drops active clients, revoked
clients, and pending pairing tickets. The daemon logs and audits this expected
migration as `legacy_remote_access_dropped`; it is not corruption. Every old
client must pair again to receive an explicit current grant.

## Session storage

Conversation history uses the same authoritative SQLite storage as local Volt.
Each registered workspace's session directory, or an explicitly configured
session directory, contains `sessions.sqlite`; session lists and resumes use its
indexes. The daemon addresses conversations by stable workspace/session IDs and
never sends the database path, session directory, or host-side
`SessionReference` over the remote wire.

Legacy session JSONL is imported once when a store first opens and archived
under that private session directory. Daemon handoffs reopen the stable session
identity from SQLite; they do not transfer or reopen a JSONL file.

## Configured remote agents

Hosts advertising `agent_options.v1` expose a read-only workspace-discovery
stream with purpose `agent_options`. `get_agent_options` requires
`model.select.v1`, is bound to the stream-authorized workspace, and returns the
current authenticated model catalog plus a complete default model, thinking,
Fast, and Build/Plan configuration. Discovery creates no session or runtime,
changes no selection, provisions no worktree, and does not mutate host
defaults.

Clients own configured-agent setup. They keep one caller-generated session ID
for the retry intent, optionally provision a deterministic worktree through
`create_worktree`, then open a normal conversation with `target:"new"`, that
session ID, and the chosen placement. The first attach creates the exact
session identity; identical retries resume it, including after daemon restart,
and concurrent attempts wait for the same runtime publication. Reusing the ID
with a different workspace, worktree, or working directory fails closed.

After attach, clients apply model, thinking level, Fast mode, and Build/Plan
mode as session-only commands, in that order, before sending the initial prompt.
A configuration failure leaves one empty resumable session and sends no prompt.
A successfully provisioned worktree is intentionally retained if a later step
fails; the client offers retry or explicit removal instead of expecting the
daemon to roll unrelated resources back. Prompt retries use the normal stable
command-ID receipt path, so neither configured attach nor prompt delivery needs
a launch receipt or transaction store.

## Conversation leases

Exactly one process owns the live runtime for each `(workspace, session)`
conversation at a time:

- **daemon-active / daemon-detached** — the daemon runs a headless runtime for
  phones. When the last phone disconnects, the runtime is retained for
  `remote.detachedRuntimeTtlMs` (default 30 minutes) so a reattach is warm.
- **tui-owned** — a desktop TUI owns the runtime. The daemon still terminates
  the phone's Iroh connection, then relays the raw stream bytes to the TUI,
  which serves it from its in-process session. Prompts from either side appear
  on both; the TUI footer shows `📱 n` while phones are attached.
- **daemon-draining** — a TUI asked to take over while a remote turn is
  streaming. The TUI shows a read-only "Attaching — finishing remote turn…"
  viewer, phones get transient `lease_draining` errors on new prompts, and
  ownership transfers at the turn boundary.

Handoffs are invisible on the phone: when a TUI takes over or quits, the
daemon closes phone streams with reason `lease_transferred` and the app
reconnects immediately to the new owner. Abort is non-destructive everywhere:
stopping a turn never closes streams or disposes runtimes.

When the TUI owns the lease, phone prompts run with the TUI session's full
local tool set. `remote.allowTools` applies only to daemon-owned headless
runtimes — see [Security](security.md).

## Work and pull-request association

The daemon observes fresh path-free Git branch state from whichever process
owns a conversation lease. Daemon runtimes publish directly; a TUI may publish
only over the exact local control connection holding that `(workspace,
session)` lease. Phone input and `list_sessions` requests cannot choose an
association or start provider discovery.

For trusted workspaces, the daemon uses configured Git remotes plus the local
authenticated `gh` CLI to match the exact head repository, branch, and object
ID. Provider failure remains distinct from “no pull request,” ambiguous matches
are not guessed, and configured/default base branches such as `main` are not
grouped across sessions. A positive PR match is sticky: later checkouts,
refresh failures, branch reuse, or a newer PR do not silently move the session
to another change. Set `remote.pullRequestDiscovery: false` to disable provider
calls.

Associations are stored separately in private `work-state.json`. The file uses
opaque local IDs and a salted hash of the common Git directory; checkout paths,
credentials, raw provider output, and provider diagnostics are not projected to
phones. `list_sessions.workContext` contains only the opaque change ID,
repository display name, effective branch, resolution state, and bounded PR
summary described in [Iroh Remote Protocol](iroh-remote-protocol.md#remote-rpc-command-allowlist).

## Git worktrees

Concurrent sessions in one workspace share one checkout by default — two
agents will step on each other's files and branches. The daemon can instead
run a session inside a **daemon-managed git worktree**: an isolated checkout
on its own branch under `~/.volt/agent/worktrees/` (0700). Create worktrees
with `volt remote worktree add`, from the TUI's `/worktree` command, or from a
paired phone (`manage_worktrees` stream, gated on the `worktrees.v1` feature);
then open a conversation with `target:"new"`, a caller-generated `sessionId`,
and a `worktreeId`.

Key behaviors:

- **Sessions stay with the parent workspace.** Worktree sessions use the
  parent workspace's SQLite store and remain listed there; leases, push
  notifications, and `list_sessions` are unchanged. The daemon persists a
  session→worktree binding so resumes (phone reattach, daemon restart, TUI
  takeover) land back in the worktree checkout.
- **Policy inheritance.** A worktree runtime uses exactly the parent
  workspace's trust decision and tool allowlist — never wider. Trust is never
  prompted for or persisted on worktree paths.
- **Branch layout.** Each worktree gets its own branch (default
  `volt/<id>`) off the recorded base ref (default: the checkout's current
  branch). `volt remote worktree list` shows dirtiness and ahead/behind counts
  against the base; `volt remote worktree diff <id>` shows the branch diff.
  Merging back is always a user action — the daemon never mutates the main
  checkout.
- **Removal safety.** `worktree remove` refuses dirty or in-use worktrees
  without `--force`; force stops bound runtimes first. `worktree prune`
  reconciles records against the filesystem and quarantines unrecognized
  directories by renaming (never deleting) them.
- **Fresh checkouts are fresh.** Worktrees share git objects but not
  untracked files: `node_modules`, virtualenvs, and build caches must be
  reinstalled per worktree.

Cleanup policies live in `state.json` under `settings.worktreeCleanup`:

```json
{ "worktreeCleanup": { "retention": { "enabled": true, "ttlMs": 3600000 }, "pruneOnStart": true } }
```

- `retention` (off by default): after a worktree-bound runtime is disposed,
  remove the worktree once the TTL expires — but only when it is clean and its
  branch is fully merged into the base ref. Skips are recorded in the audit
  log as `worktree_retention_skipped_dirty`; uncommitted work is never
  deleted.
- `pruneOnStart` (default `true`): reconcile worktree records and checkouts
  during daemon startup.

Downgrade caveat: older daemons drop the `worktrees` state collection on
their next write. Checkouts survive on disk as orphans; re-upgrading and
running `volt remote worktree prune` quarantines them.

## Optional: theme token push (experimental)

With `VOLT_HOST_THEME_TOKENS=1` in the daemon's environment (or
`settings.themeTokenPush` in `state.json`), the daemon pushes its resolved
theme colors to phones that advertise the `host_theme_tokens.v1` capability as
`host_theme_tokens` frames (hex color values only — nothing path-like ever
crosses the wire). Off by default; clients that ignore the frame are fully
supported.

## Troubleshooting

- `volt daemon status --json` reports `remoteTransport.state` as `starting`,
  `ready`, `degraded`, or `unavailable`, plus a safe reason code/message and the
  wrapper version when discoverable. Both daemon and remote status exit nonzero
  unless phone transport is `ready`; local daemon workspace/client maintenance
  remains available while it is not ready.
- `native_binding_missing` → reinstall without `--omit=optional` on a supported
  platform. Darwin x64 is intentionally local CLI/TUI only.
- `endpoint_start_failed` → inspect `volt daemon logs`, fix the reported host
  issue, then restart the daemon.
- `host_storage_full` → free computer disk/quota capacity, then retry. Rejected
  handshakes do not create an in-memory authorization, and the phone keeps its
  saved pairing, selected agent, and transcript.
- `volt daemon status` reports that the daemon is not running → run `volt daemon
  start` and check `volt daemon logs`.
- Stale socket after a crash: `volt daemon start` probes the socket, unlinks
  it when dead, and rebinds.
- A second daemon on the same agent dir exits immediately (single-instance is
  guaranteed by the socket bind).
- Phone shows an "in use" error: the existing daemon-owned runtime permits tools outside this phone's persisted grant, so it cannot safely co-attach. Re-pair with a compatible grant or close the broader runtime. A `duplicate_conversation_connection` error instead means the same phone raced two connections and retries on its own.
- Full audit trail: `~/.volt/agent/daemon/audit.jsonl` records pairing,
  revocation, lease transitions, and daemon lifecycle for post-hoc review.

## Manual walk-away checklist

See [scripts/manual-walkaway.md](../scripts/manual-walkaway.md) for the full
end-to-end verification script (TUI ↔ phone handoff in both directions,
mid-turn attach, abort semantics, and daemon restart behavior).
