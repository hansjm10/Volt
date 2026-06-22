# Iroh Remote Access Productization Design

## Purpose

Move Volt Iroh remote access from experimental proof of concept to a supported preview-quality feature. This document is intended as an implementation handoff for another development agent. It defines the target scope, required behavior, architecture constraints, detailed work plan, tests, and acceptance criteria.

## Current Implementation Summary

The current implementation is functional and has strong core plumbing:

- `volt remote host` exists and launches `packages/coding-agent/src/remote/iroh-host.mjs`.
- Iroh native loading is isolated in `packages/coding-agent/src/remote/iroh-native-adapter.cjs` through optional `@number0/iroh`.
- The host can run Volt in-process through `runIrohRemoteRpcMode()`.
- The host can also spawn a Volt RPC child or fake RPC child for compatibility and scenario tests.
- RPC mode uses a transport abstraction, and Iroh streams are adapted through `createIrohRpcTransport()`.
- The remote core includes helpers for:
  - ticket encoding/decoding
  - bounded handshake reads
  - host state load/save
  - client authorization
  - workspace selection
  - audit logging
  - command filtering
  - outbound host-path redaction
  - host/client engine orchestration
- The host has basic safety defaults:
  - opt-in command
  - one-time pairing secret
  - persisted paired-client allowlist
  - workspace allowlist
  - default read-only tools: `read,grep,find,ls`
  - `volt remote clients`
  - `volt remote revoke <node-id>`
  - JSONL audit logging
- Local test coverage exists:
  - `packages/coding-agent/test/remote-iroh-core.test.ts`
  - `packages/coding-agent/test/rpc-iroh-transport.test.ts`
  - `packages/coding-agent/test/iroh-remote-agent-runtime.test.ts`
  - `packages/coding-agent/test/remote-cli.test.ts`
  - `scripts/iroh-sidecar-test.mjs`

Recent validation run:

```bash
cd packages/coding-agent
node node_modules/vitest/dist/cli.js --run \
  test/remote-iroh-core.test.ts \
  test/rpc-iroh-transport.test.ts \
  test/iroh-remote-agent-runtime.test.ts \
  test/remote-cli.test.ts

npm run iroh:poc:test
```

Both passed at the time this document was written.

## Problem Statement

The feature works as an engineering proof of concept, but it is not ready to be treated as non-experimental because:

1. Pairing is tied to host startup instead of being a first-class workflow.
2. Per-client authorization policy is not durable enough; reconnecting clients can inherit current host flags instead of stable client-specific policy.
3. The protocol is not documented as a stable contract for external clients.
4. Reconnect/resume behavior is not defined.
5. Active revocation semantics are incomplete; revocation removes future access but does not define active connection handling.
6. The user-facing documentation is sparse and still positions remote support as experimental.
7. Real cross-network relay validation is not formalized.
8. Bun binary support is explicitly unavailable, but the stable support boundary is not framed as a product decision.

## Target Product State

Iroh remote access should graduate to a supported preview-quality feature with explicit limitations.

Supported preview means:

- The command is safe to document in normal usage docs.
- The default configuration is read-only and conservative.
- Pairing, listing, revocation, and host startup are coherent user workflows.
- Remote clients can rely on a documented protocol version.
- Client authorization policy is persistent and predictable.
- Disconnection and reconnection behavior is defined.
- Tests cover security, protocol compatibility, and runtime lifecycle behavior.
- Unsupported cases are explicitly documented.

Supported preview does not mean full mobile product completion.

## Goals

### G1. First-class pairing workflow

Add a dedicated pairing command so users can generate pairing tickets without coupling pairing to a fresh host startup.

Target CLI:

```bash
volt remote host --workspace volt=/path/to/repo
volt remote pair --workspace volt
volt remote clients
volt remote revoke <node-id>
```

A host may still print an initial pairing ticket on startup for convenience, but pairing must be available as a separate command.

### G2. Durable per-client policy

Client authorization must be stable after pairing.

Persist at least:

- client node ID
- label
- paired timestamp
- last seen timestamp
- allowed workspace names
- allowed tools
- revoked state or removal

A reconnecting client must use its persisted `allowedTools` and workspace permissions. It must not silently gain new tools because the current host process was started with a broader `--allow-tools` value.

Resolved 2026-06-21: `IrohRemoteClient.allowedTools` is now parsed with a read-only legacy default, new pairings store the pair-time tool snapshot, and reconnect authorization returns the persisted client tool grant instead of the current host `--allow-tools` value. Unit and sidecar scenario tests cover read-only clients remaining read-only after restart with unsafe host defaults.

### G3. Stable protocol v1 contract

Document and test the wire contract used by non-demo clients:

- ticket format
- handshake request
- handshake success response
- handshake failure response
- RPC JSONL framing
- allowed inbound RPC commands over remote access
- outbound event redaction guarantees
- protocol version and compatibility rules

Resolved 2026-06-21: Added `packages/coding-agent/docs/iroh-remote-protocol.md`, linked it from the docs index and Iroh remote access design, and added protocol compatibility vectors for v1 ticket encoding/decoding, unknown-field tolerance, hello/handshake response shapes, strict LF framing with initial RPC input preservation, the remote RPC allowlist/rejection behavior, and representative outbound redaction guarantees.

### G4. Security hardening

Before removing experimental language, the feature must have explicit safety gates:

- read-only default remains `read,grep,find,ls`
- enabling `bash`, `edit`, or `write` requires an explicit warning/confirmation unless a noninteractive flag is provided
- pairing tickets are short-lived and one-time by default
- revocation is clearly auditable
- workspace access is name-based, not arbitrary path-based
- project trust is never auto-approved for remote sessions
- audit events cover pairing, authorization, rejection, revocation, connection lifecycle, runtime startup/stopping, and unsafe tool grants

Resolved 2026-06-21: Unsafe remote tool grants are detected through shared core helpers. `volt remote host` now requires TTY confirmation or `--yes` before granting `bash`, `edit`, or `write`; non-TTY startup fails without `--yes`; accepted unsafe grants write `unsafe_tools_enabled` audit events. CLI help, the sidecar README, unit tests, and scenario tests cover the gate.

### G5. Reconnect/resume semantics

Define and implement minimum reconnection behavior suitable for mobile or flaky networks.

Preview requirement:

- A remote client can reconnect as the same paired node ID.
- Reconnect creates or resumes a Volt session deterministically according to a documented policy.
- If full live stream resume is deferred, the client can recover current state and continue with the latest persisted session.

### G6. Product-quality host status and diagnostics

Users must be able to understand host state without inspecting JSON files.

Target additions:

```bash
volt remote status
```

Status should show:

- host node ID if available
- state path
- audit path
- configured workspaces
- relay mode, if a host process supplied it or if saved in state
- paired clients
- last seen times
- allowed tools per client
- whether pairing is currently enabled, if discoverable from the running host model

If `status` cannot discover live process state, it must clearly say it is showing persisted state only.

## Non-goals

Do not implement these as part of this graduation effort unless the user explicitly expands scope:

- TUI tunneling over Iroh.
- Multi-user collaboration semantics.
- Mobile application UI.
- Full historical stream replay for every event.
- Mandatory Iroh native dependency in the main CLI path.
- Bun binary remote-host support, unless product direction changes.
- Opening arbitrary host paths requested by clients.
- Remote clients changing host settings, installing packages, or approving project trust automatically.

## Product Scope Decision

The first non-experimental release should support:

- Node.js package install and source checkout only.
- Optional `@number0/iroh` native adapter.
- One client connection maps to one active Volt runtime at a time.
- One workspace per remote runtime.
- Read-only tools by default.
- Explicit opt-in for write/shell tools.
- One paired client node ID represents one client installation/device.

The Bun binary should continue to reject `volt remote host` with a clear message until a bundling or native sidecar strategy is chosen.

## Architecture Constraints

### Native dependency isolation

Keep `@number0/iroh` loading isolated to `src/remote/iroh-native-adapter.cjs` and `src/remote/iroh-host.mjs`. Do not import the native adapter from core modules or normal CLI startup code.

### Core remains structurally typed

Core RPC and remote helpers should continue to use structural stream types (`IrohRecvStreamLike`, `IrohSendStreamLike`, `IrohBiStreamLike`) rather than importing Iroh native types.

### Protocol logic belongs in TypeScript core

Ticket parsing, handshakes, authorization, state management, policy decisions, redaction, and RPC filtering should live under:

```text
packages/coding-agent/src/core/remote/iroh/
packages/coding-agent/src/core/rpc/iroh-transport.ts
packages/coding-agent/src/modes/rpc/iroh-remote-*.ts
```

`src/remote/iroh-host.mjs` should own native endpoint lifecycle, CLI glue, and child-process compatibility only.

### No inline imports in TypeScript

Use top-level imports only in TypeScript files, consistent with repo policy.

### Erasable TypeScript only

Do not introduce `enum`, parameter properties, namespaces, or TypeScript syntax requiring emit in root-config-checked code.

## Proposed State Model

Current state is approximately:

```typescript
interface IrohRemoteHostState {
  hostSecretKey?: number[];
  consumedPairingSecretHashes: string[];
  workspaces: IrohRemoteWorkspace[];
  clients: IrohRemoteClient[];
}
```

Extend it deliberately. Suggested shape:

```typescript
interface IrohRemoteHostState {
  hostSecretKey?: number[];
  consumedPairingSecretHashes: string[];
  workspaces: IrohRemoteWorkspace[];
  clients: IrohRemoteClient[];
  pendingPairingTickets?: IrohRemotePendingPairingTicket[];
  version?: 1;
}

interface IrohRemoteWorkspace {
  name: string;
  path: string;
  defaultAllowedTools?: string;
}

interface IrohRemoteClient {
  nodeId: string;
  label: string;
  allowedWorkspaces: string[];
  allowedTools: string;
  pairedAt: number;
  lastSeenAt: number;
  lastWorkspace?: string;
  revokedAt?: number;
}

interface IrohRemotePendingPairingTicket {
  secretHash: string;
  workspace: string;
  allowedTools: string;
  expiresAt: number;
  createdAt: number;
  consumedAt?: number;
  labelHint?: string;
}
```

Implementation notes:

- Avoid storing raw pairing secrets.
- Existing `consumedPairingSecretHashes` may remain for migration compatibility.
- If adding `pendingPairingTickets`, update parser defaults so old state files load.
- If keeping consumed-only secret storage, ensure `volt remote pair` can authorize future connections without relying on a live host process variable.
- Do not silently broaden `client.allowedTools` on reconnect.
- If a user wants to change an existing client's tools, provide an explicit command or require re-pairing.

## CLI Design

### `volt remote host`

Current behavior should remain mostly compatible.

Required changes:

- Use persisted per-client tools for existing clients.
- Use pair-time tools for newly paired clients.
- Warn before unsafe tools.
- Document whether startup prints a pairing ticket by default.

Suggested options:

```text
--workspace <name=path>       Workspace exposed to clients
--relay <disabled|default>    Iroh relay preset
--state <path>                Host state path
--audit <path>                Audit JSONL path
--allow-tools <list>          Default tools for new pairing tickets
--approve                    Trust project-local Volt resources for this host process
--no-pairing                 Do not create a startup pairing ticket
--once                       Exit after first client disconnects
--yes                        Accept unsafe remote tool warning in noninteractive contexts
```

Unsafe tools are any of:

```text
bash, edit, write
```

If `--allow-tools` contains unsafe tools and `--yes` is not present:

- In TTY mode: prompt for confirmation.
- In non-TTY mode: fail with an error instructing the user to pass `--yes`.

### `volt remote pair`

New command.

Purpose: create a pairing ticket for an existing saved workspace and selected per-client policy.

Example:

```bash
volt remote pair --workspace volt --label "Jordan iPhone"
volt remote pair --workspace volt --allow-tools read,grep,find,ls
volt remote pair --workspace volt --allow-tools read,grep,find,ls,bash --yes
```

Options:

```text
--workspace <name>            Saved workspace name. Required if more than one workspace exists.
--allow-tools <list>          Tools granted to the paired client. Defaults to workspace default or read-only.
--label <label>               Optional label hint for the client.
--ttl <duration>              Ticket TTL. Default 10m. Examples: 30s, 10m, 1h.
--state <path>                Host state path.
--relay <disabled|default>    Relay hint embedded in the ticket. Defaults to saved/default host relay mode if available.
--yes                         Accept unsafe remote tool warning.
```

Output:

- stdout: ticket only, suitable for copy/paste.
- stderr: human diagnostics.

Acceptance details:

- The command must fail if the workspace does not exist in state.
- The command must fail if no host secret/endpoint identity exists and the implementation cannot produce a dialable Iroh ticket without starting a host.
- If pair tickets can only be generated while a host endpoint is live, document and implement the command as host-mediated instead of pretending offline pairing works.
- If offline pairing is not possible with the current Iroh endpoint ticket model, acceptable v1 alternative: add `volt remote host --pair-only` or a control mechanism in the running host. Document the chosen model.

Important design issue to resolve during implementation:

The current ticket includes `irohTicket`, which is produced from the bound endpoint address. If an offline `volt remote pair` command cannot create a valid current `EndpointTicket` without binding an endpoint, the implementation must choose one of these approaches:

1. Pair command starts a short-lived endpoint using the persisted host key, prints a ticket, and remains running until the ticket expires or is consumed.
2. Pair command communicates with a running host control socket to request a ticket from the live endpoint.
3. Pair command is deferred, and host startup pairing is retained, but the CLI/docs explicitly state that pairing is host-runtime-scoped.

Preferred approach: running-host control socket if feasible, short-lived pair endpoint if not. Do not ship a misleading offline pair command.

Resolved 2026-06-21: Offline pairing from persisted host state is not supported. Direct `@number0/iroh` evidence: `EndpointTicket.fromAddr()` wraps an `EndpointAddr`; an ID-only `EndpointAddr` created from a persisted secret key produced a ticket with zero direct addresses and no relay URL, and a native connect attempt failed with `No addressing information available` / `No address lookup configured`; a bound endpoint ticket included a direct address. Decision: implement `volt remote pair` as a running-host-mediated command. The CLI will contact the live host's local control channel, and the host will create the ticket from its current bound endpoint address, persist/audit the pending pairing ticket, and return the ticket to stdout. If no live host/control channel is available, the workspace is missing or ambiguous, unsafe tools are not accepted, or endpoint-ticket creation fails, the command fails with diagnostics on stderr and no ticket on stdout. Security implications: pairing remains a local management action, raw secrets appear only in the returned ticket, persisted state stores only hashes and non-secret metadata, and pair-time tools/TTL/label policy are owned by the host. A short-lived pair endpoint is deferred as a fallback only if the control channel becomes impractical; no offline pair command should be shipped.

Resolved 2026-06-21: Core/host pairing ticket lifecycle now supports pair-time `allowedTools`, label hints, TTL, relay hints in ticket payloads, saved-workspace binding, one-time consumption, and cross-workspace rejection. Pending state remains hash-only plus non-secret metadata, and authorization applies a label hint only when the client does not provide a label.

Resolved 2026-06-21: `volt remote pair` is now exposed in the main CLI as a running-host-mediated command. The host opens a local control channel derived from the state path, creates tickets from its live bound endpoint address, and applies requested `--workspace`, `--allow-tools`, `--label`, `--ttl`, `--relay`, and `--yes` policy. The command validates saved workspace selection before contacting the host, prints only the ticket on stdout, emits diagnostics to stderr, reuses unsafe-tool confirmation gates, and fails if no running host control channel is available.

### `volt remote clients`

Improve output while preserving JSON compatibility if it currently prints JSON.

Recommended approach:

- Keep default JSON output for machine readability, or add `--json` if switching to human default.
- Include per-client allowed tools and workspace names.
- Include `lastSeenAt` and `pairedAt` in ISO and/or numeric form.
- Exclude raw secrets and secret hashes.

### `volt remote revoke <node-id>`

Required changes:

- Audit revocation.
- Prevent future authorization.
- If an active connection registry is implemented, disconnect active streams for that client.
- If active disconnect is not implemented, document that revocation affects future connections and add a follow-up TODO.

Preferred preview acceptance: active connections are closed within one second of revocation when host and management command coordinate through a control socket or shared revocation watcher.

Resolved 2026-06-21: Preview revocation will use live host coordination when available. `volt remote revoke <node-id>` must always remove the client from persisted state first so future authorization fails; it must also send a local control-channel revoke request to any running host for the same state path. The running host will keep an active connection registry keyed by authoritative Iroh remote node ID and workspace, close matching native `Connection` handles, let the existing connection cleanup stop the RPC child/runtime, and audit `active_connection_revoked`. Direct `@number0/iroh` API evidence: `Connection.close(errorCode, reason)` and `Connection.closed()` are available for active QUIC connections, with `RecvStream.stop()` and `SendStream.reset()` available if stream-level cleanup is needed. Lifecycle guarantee for C.3: if a live host acknowledges a matching active client, the connection is closed within one second with reason `revoked`; if no host is reachable, the command still succeeds for persisted revocation and reports that active live revocation was not available.

Resolved 2026-06-21: `volt remote revoke <node-id>` and the host-script management path now remove the client from persisted state, audit `client_revoked`, send a local control-channel revoke request to the running host, and close active native Iroh connections with reason `revoked` when present. Running hosts track active authorized connections by authoritative remote node ID, audit `active_connection_revoked`, and report when no matching active connection exists. CLI and sidecar scenario tests cover control-channel active revocation, persisted reconnect denial remains covered by the revocation scenario, and no-host revocation remains a successful persisted-state operation with an active-live-unavailable diagnostic.

### `volt remote status`

New command.

Minimum output:

- persisted state path
- known workspaces
- clients count
- clients with labels, node IDs, workspaces, tools, last seen
- warning if this is persisted state only and no live host status is available

Resolved 2026-06-21: `volt remote status` now prints deterministic JSON for persisted host state, including state/audit paths, sorted workspaces, client count, client labels/node IDs, allowedWorkspaces, allowedTools, pairedAt, and lastSeenAt. It omits host secret keys, consumed pairing secret hashes, and pending ticket secret hashes, and includes a persisted-state-only warning because live host status discovery is not implemented for this command yet.

Optional live status if a host control socket exists:

- host process PID
- endpoint node ID
- relay mode
- active connections
- pairing enabled/disabled
- current ticket expiry

## Protocol v1 Contract

Resolved 2026-06-21: The supported preview wire contract is documented in `packages/coding-agent/docs/iroh-remote-protocol.md`; this section remains the design source for unresolved follow-up protocol decisions.

### Ticket

Current prefix:

```text
volt+iroh://v1/<base64url-json>
```

Payload fields:

```json
{
  "alpn": "volt-rpc/0",
  "expiresAt": 1790000000000,
  "irohTicket": "<iroh-endpoint-ticket>",
  "nodeId": "<host-node-id>",
  "relayMode": "disabled",
  "secret": "<one-time-secret>",
  "workspace": "volt"
}
```

Rules:

- Clients must reject unknown prefixes.
- Clients must reject unsupported ALPN.
- Clients must reject expired tickets before dialing when `expiresAt` exists.
- Hosts must treat `secret` as one-time.
- Future ticket fields are allowed; clients must ignore unknown fields unless explicitly documented otherwise.

### Client hello

First line sent on the Iroh bidirectional stream:

```json
{
  "type": "volt_iroh_hello",
  "protocol": "volt-rpc/0",
  "workspace": "volt",
  "secret": "<one-time-secret-if-pairing>",
  "clientLabel": "Jordan iPhone",
  "clientNodeId": "<client-claimed-node-id>"
}
```

Rules:

- Host authorization must use the Iroh connection remote node ID as authoritative.
- `clientNodeId` is informational only unless validated against the transport identity.
- `workspace` must match an allowed saved workspace name.
- The line must be bounded by `DEFAULT_IROH_REMOTE_HANDSHAKE_MAX_LINE_BYTES`.
- The read must time out after `DEFAULT_IROH_REMOTE_HANDSHAKE_TIMEOUT_MS` unless overridden internally for tests.

### Host handshake response

Success:

```json
{
  "type": "volt_iroh_handshake",
  "success": true,
  "workspace": "volt",
  "clientNodeId": "<authoritative-remote-node-id>",
  "child": "volt"
}
```

Failure:

```json
{
  "type": "volt_iroh_handshake",
  "success": false,
  "error": "client is not paired"
}
```

Rules:

- After success, the stream carries strict LF-delimited Volt RPC JSONL.
- Handshake parsing must preserve bytes already read after the first newline and pass them as initial RPC input.
- Host must not split JSONL on Unicode line separators.

### Allowed inbound remote RPC commands

Current allowlist:

```text
prompt
steer
follow_up
abort
get_state
extension_ui_response
```

Before graduation, decide whether to include additional read-only commands such as:

```text
get_messages
get_commands
get_last_assistant_text
get_available_models
```

If added, update:

- `IROH_REMOTE_RPC_PASSTHROUGH_TYPES`
- protocol docs
- command filter tests
- scenario tests

Do not allow direct `bash`, `edit`, `write`, session switching, model changes, package installation, or settings mutation over remote access unless explicitly reviewed.

Note: tool access is governed by the agent prompt/tool allowlist, but RPC command access is a separate surface. Keep the remote RPC command allowlist narrow.

### Outbound redaction contract

Remote clients must not receive full host-only paths unless those paths are inside the selected workspace and normalized to the remote workspace root.

Current remote workspace root default:

```text
/workspace
```

Guarantees:

- Paths inside the workspace are normalized under `/workspace`.
- Host session files are redacted.
- Host export paths are redacted.
- Bash temp output paths are redacted.
- Absolute host paths outside the workspace are redacted.
- Image data and opaque signatures are preserved.

Resolved 2026-06-21: Protocol compatibility tests now assert representative outbound RPC event redaction, including workspace normalization, host path redaction, session-file omission, structured export-path redaction, opaque image payload preservation, and signature preservation. D.3 keeps broader redaction hardening open for additional event shapes and path variants.

## Reconnect and Session Resume Design

Minimum preview behavior:

1. A paired client reconnects with the same Iroh node ID.
2. Host authorizes it using persisted policy.
3. Host starts a runtime in the workspace.
4. Runtime opens a deterministic session.
5. Client can call `get_state` and continue interaction.

Recommended implementation:

- Add optional remote session metadata to host state:

```typescript
interface IrohRemoteClient {
  nodeId: string;
  label: string;
  allowedWorkspaces: string[];
  allowedTools: string;
  pairedAt: number;
  lastSeenAt: number;
  lastSessionIdByWorkspace?: Record<string, string>;
}
```

- When a remote runtime creates a session, record the session ID for that client/workspace.
- On reconnect, open that session if it still exists.
- If missing, create a new session and update state.
- Do not attempt to replay live stream deltas in v1.
- Client recovery path is `get_state` plus future commands.

Acceptance criteria:

- Reconnecting a paired client within the same workspace continues in the same session when the session file still exists.
- If the session file is deleted, reconnect creates a new session and logs an audit event.
- If another active connection for the same client/workspace exists, define behavior:
  - preferred: reject the second connection with `client already connected`; or
  - alternative: close the old connection and accept the new one.
- The chosen behavior must be documented and tested.

## Security Requirements

### Tool grants

Unsafe tools:

```text
bash
edit
write
```

Requirements:

- New pairing tickets that include unsafe tools require confirmation or `--yes`.
- Host startup with unsafe default `--allow-tools` requires confirmation or `--yes`.
- Audit event `unsafe_tools_enabled` is written when unsafe tools are accepted.
- Existing clients do not get unsafe tools unless explicitly paired or updated with those tools.

Resolved 2026-06-21: Host-startup pairing tickets with unsafe tool grants require confirmation or `--yes`, and accepted grants audit `unsafe_tools_enabled` with non-secret details. Future first-class `volt remote pair` work must reuse this gate when it adds standalone pair-ticket creation.

### Project trust

Requirements:

- Remote runtime default is untrusted unless `--approve` is provided.
- Pairing must not set project trust.
- Reconnecting clients must not bypass project trust.

### Pairing secret handling

Requirements:

- Raw secrets are not persisted.
- Pairing secret hashes use a cryptographic hash with prefix, currently `sha256:`.
- Consumed secrets cannot be reused across host restarts.
- Expired secrets are rejected.
- Expired pending tickets should be pruned opportunistically.

Resolved 2026-06-21: Pairing creation now persists only `sha256:` pending-ticket hashes plus non-secret metadata (`workspace`, `allowedTools`, `createdAt`, `expiresAt`). Authorization hashes presented secrets, rejects consumed hashes even after host restart, rejects and prunes expired pending tickets, removes pending entries on consumption, and audits `pairing_ticket_created`, `pairing_ticket_consumed`, and `pairing_ticket_expired` without raw secrets.

### Audit events

Minimum event types:

```text
pairing_ticket_created
pairing_ticket_consumed
pairing_ticket_expired
client_authorized
client_rejected
client_connected
client_disconnected
client_revoked
workspace_selected
runtime_started
runtime_stopped
unsafe_tools_enabled
remote_command_rejected
active_connection_revoked
session_resumed
session_created
session_missing_on_resume
```

Each event should include where relevant:

- timestamp
- client node ID
- workspace
- success
- error
- non-secret details

Never log raw pairing secrets, provider API keys, full auth paths, or raw prompt content.

Resolved 2026-06-21: Active revocation must audit `active_connection_revoked` when a running host receives a revoke request for an active client. The event should include client node ID, workspace, success, non-secret details such as control-channel source and close reason, and an error if no matching active connection was found on that host.

## Implementation Plan

### Phase 1: Policy persistence and safety gates

Files likely involved:

```text
packages/coding-agent/src/core/remote/iroh/state.ts
packages/coding-agent/src/core/remote/iroh/authorization.ts
packages/coding-agent/src/core/remote/iroh/state-manager.ts
packages/coding-agent/src/core/remote/iroh/engine.ts
packages/coding-agent/src/remote/iroh-host.mjs
packages/coding-agent/src/main.ts
packages/coding-agent/test/remote-iroh-core.test.ts
packages/coding-agent/test/remote-cli.test.ts
scripts/iroh-sidecar-test.mjs
```

Tasks:

1. Update state parsing to preserve old state compatibility.
2. Ensure `allowedTools` is required or defaulted on clients.
3. Change reconnect authorization to return persisted client tools, not current host `allowTools`.
4. Ensure new pairings store pair-time tools.
5. Add unsafe tool detection helper.
6. Add warning/confirmation or `--yes` behavior to remote host/pair commands.
7. Add audit events for unsafe tool grants and command rejections.

Acceptance criteria:

- Existing state files without new fields still parse.
- New clients store allowed tools at pairing time.
- Existing clients reconnect with their persisted tools even if host starts with a different `--allow-tools`.
- A client paired read-only cannot use a host restart to gain `bash`, `edit`, or `write`.
- Unsafe host startup fails in non-TTY mode without `--yes`.
- Unsafe host startup succeeds with `--yes` and writes an audit event.
- Unit and scenario tests cover the above.

### Phase 2: Pairing UX

Tasks:

1. Decide pair generation model after verifying Iroh endpoint ticket constraints.
2. Implement `volt remote pair` accordingly.
3. Add `--label`, `--workspace`, `--allow-tools`, `--ttl`, `--state`, `--relay`, and `--yes`.
4. Ensure stdout contains only the ticket.
5. Ensure stderr contains diagnostics.
6. Add tests for workspace selection, expiry, unsafe tools, and malformed args.

Acceptance criteria:

Resolved 2026-06-21: Core/host lifecycle support is in place for host-mediated pair command implementation: pair requests can supply workspace, pair-time tools, label hints, TTL, relay hints, and the host enforces one-time use plus workspace binding.

Resolved 2026-06-21: The main CLI implements host-mediated `volt remote pair` with saved-workspace validation, unsafe grant confirmation/`--yes`, ticket-only stdout, stderr diagnostics, and local scenario coverage that pairs a real demo client through the new command.

- `volt remote pair --workspace volt` creates a valid ticket for a saved workspace or fails with a precise actionable message.
- Ticket can pair a new client exactly once.
- Expired pair ticket is rejected.
- Reusing a consumed pair ticket is rejected.
- Pairing a different workspace than the host workspace is rejected.
- The command does not print secrets outside the ticket.

### Phase 3: Status and client management

Tasks:

1. Add `volt remote status`.
2. Improve `clients` output if needed.
3. Define revocation behavior for active connections.
4. If implementing active disconnect, add a live host connection registry and management communication path.

Resolved 2026-06-21: Active disconnect is selected for preview and will extend the existing running-host control channel with revoke requests plus a host-side active connection registry.

Acceptance criteria:

- `volt remote status --state <path>` shows persisted workspaces and clients. Resolved 2026-06-21.
- `volt remote clients --state <path>` includes allowed tools and workspace permissions.
- `volt remote revoke <node-id>` prevents reconnect. Resolved 2026-06-21.
- If active disconnect is implemented, active revoked clients are disconnected promptly and an audit event is written. Resolved 2026-06-21.
- If active disconnect is deferred, docs explicitly state revocation applies to future connections only.

### Phase 4: Protocol documentation and compatibility tests

Tasks:

1. Add `packages/coding-agent/docs/iroh-remote-protocol.md`.
2. Link it from `packages/coding-agent/docs/index.md` and the existing Iroh design doc.
3. Add test vectors for tickets and handshakes.
4. Add tests for allowed/rejected command types.
5. Add tests for redaction compatibility.

Acceptance criteria:

Resolved 2026-06-21: `packages/coding-agent/docs/iroh-remote-protocol.md` includes ticket, hello, response, JSONL framing, command allowlist, authoritative-field/unknown-field compatibility rules, and redaction guarantees; it is linked from `docs/index.md` and the Iroh remote access design doc. `remote-iroh-core.test.ts` now pins ticket/handshake shapes, strict LF framing with initial RPC input preservation, the current command allowlist/rejection surface, and representative redaction guarantees. Broader README/usage/security doc polish remains tracked by F.1.

- Protocol doc includes ticket, hello, response, JSONL framing, command allowlist, and redaction guarantees. Resolved 2026-06-21.
- Tests fail if the v1 protocol shape changes unintentionally. Resolved 2026-06-21.
- README/usage docs point users to the protocol/security docs.

### Phase 5: Reconnect/resume

Tasks:

1. Add per-client/workspace last session tracking.
2. Update `createIrohRemoteAgentRuntime()` to accept a session selection/resume option.
3. Record session ID after runtime creation.
4. Open previous session on reconnect when possible.
5. Define duplicate active connection behavior.
6. Add scenario tests.

Acceptance criteria:

- Client reconnect resumes previous session for the same client/workspace.
- Missing session file creates a new session and logs an audit event.
- Duplicate active connection behavior is deterministic and tested.
- `get_state` after reconnect returns the resumed session ID.

### Phase 6: Cross-network validation and docs polish

Tasks:

1. Run and document `--relay default` validation across two networks.
2. Add troubleshooting docs for native adapter install failures.
3. Update README and `docs/usage.md` to remove or narrow experimental language only after all acceptance criteria pass.
4. Document Bun binary limitation.
5. Document security model prominently.

Acceptance criteria:

- A real host/client test over relay succeeds.
- Docs include install, pair, connect, list, revoke, status, relay, and security sections.
- Unsupported environments produce actionable errors.

## Required Tests

### Unit tests

Add or update tests for:

- state parsing migration
- persistent per-client tool policy
- unsafe tool helper
- pair ticket persistence/consumption
- expired pending pair tickets
- protocol compatibility vectors
- command filter allowlist/rejection
- outbound redaction guarantees
- reconnect session selection

### CLI tests

Add or update tests for:

- `volt remote pair`
- `volt remote status`
- unsafe tool warning failures and `--yes`
- `clients` output includes policy fields
- revoke audit behavior
- malformed args

### Scenario tests

Update `scripts/iroh-sidecar-test.mjs` to cover:

- pair command flow, if implemented
- reconnect with persisted tools
- reconnect session resume
- read-only client remains read-only after host restart with unsafe tools
- unsafe pair ticket requires `--yes`
- status output
- active revocation behavior or documented deferred behavior

### Manual validation

Run:

```bash
npm run iroh:poc:test
```

Run a same-machine integrated host/client:

```bash
npm run iroh:poc:host:volt -- --allow-tools read,grep,find,ls
npm run iroh:poc:client -- "<ticket>" --get-state
npm run iroh:poc:client -- "<ticket>" --message "List top-level files."
```

Run cross-network relay validation:

```bash
npm run iroh:poc:host:volt -- --relay default --allow-tools read,grep,find,ls
npm run iroh:poc:client -- "<ticket>" --get-state
```

After code changes, run from repo root:

```bash
npm run check
```

If test files are modified, run the specific tests and iterate until they pass. Do not run the full vitest suite directly.

## Documentation Updates Required

Update these files when implementation is complete:

```text
packages/coding-agent/README.md
packages/coding-agent/docs/usage.md
packages/coding-agent/docs/index.md
packages/coding-agent/docs/iroh-remote-access-design.md
packages/coding-agent/docs/security.md
packages/coding-agent/examples/remote/iroh-sidecar/README.md
packages/coding-agent/CHANGELOG.md
```

Add:

```text
packages/coding-agent/docs/iroh-remote-protocol.md
```

Docs must cover:

- remote access is opt-in
- what the host exposes
- read-only default
- unsafe tool warning
- pairing workflow
- revocation workflow
- state and audit paths
- relay mode
- Bun binary limitation
- troubleshooting optional native dependency install
- protocol link for client authors

## Graduation Checklist

Do not remove experimental language until all of these are true:

- [x] Per-client tools are persisted and enforced on reconnect. Resolved 2026-06-21.
- [x] Unsafe tool grants require confirmation or `--yes`. Resolved 2026-06-21.
- [x] Pairing workflow is first-class and scoped to a running host control channel. Resolved 2026-06-21.
- [x] Protocol v1 is documented. Resolved 2026-06-21.
- [x] Protocol compatibility tests exist. Resolved 2026-06-21.
- [ ] Reconnect/resume behavior is implemented and documented.
- [x] Revocation behavior is implemented and documented, including active connection semantics. Resolved 2026-06-21.
- [x] `volt remote status` persisted-state inspection exists. Resolved 2026-06-21.
- [ ] Scenario tests cover pair, reconnect, policy, revocation, expiry, and command filtering.
- [ ] Cross-network `--relay default` dogfood succeeds.
- [ ] README and usage docs include security warnings and unsupported environments.
- [ ] `npm run check` passes after code changes.

## Open Decisions

These must be resolved during implementation:

1. Resolved 2026-06-21: A dialable Iroh endpoint ticket cannot be generated offline from persisted host state alone; `volt remote pair` will be mediated by a running host control channel that has access to the live endpoint address.
2. Should duplicate connections from the same client node ID be rejected or should the newer connection replace the older one?
3. Should `get_messages`, `get_commands`, or `get_available_models` be allowed over remote RPC in preview?
4. Should client policy updates be supported by a command, or should users revoke and re-pair?
5. Resolved 2026-06-21: Active revocation should use the running host control channel in preview; persisted-state revocation remains the fallback when no live host is reachable.
6. Should the host store relay mode in state for status/pair defaults?
7. Is supported preview explicitly Node-only, or should a native sidecar be planned before removing experimental language?

## Recommended First PR

Start with durable per-client policy because it is the most important security blocker and does not depend on unresolved Iroh endpoint-ticket behavior.

Recommended first PR scope:

- Persist pair-time `allowedTools` on clients.
- Return persisted `allowedTools` for reconnecting clients.
- Stop mutating existing client `allowedTools` from current host flags.
- Add tests proving a read-only paired client remains read-only after host restart with unsafe `--allow-tools`.
- Add unsafe tool detection helper and noninteractive `--yes` gate for host startup.
- Add changelog entry under `packages/coding-agent/CHANGELOG.md`.

This creates a safer foundation for pairing UX, status, and reconnect work.
