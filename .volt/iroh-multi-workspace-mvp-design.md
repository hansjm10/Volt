# Iroh Multi-Workspace MVP Design

Date: 2026-06-22
Status: Proposed

## Purpose

Define the fastest safe MVP for letting one paired Volt iOS app connection use multiple desktop workspaces registered on the same workstation. This document is intended as an implementation handoff for the Volt host/protocol and iOS app work.

The saved-host pairing contract is already defined in `.volt/iroh-saved-host-pairing-design.md`. This document extends that contract from "one saved host, one primary workspace" to "one saved host, many registered workspaces" without changing the core pairing model.

## Product Goal

A user should pair their phone to a desktop host once. After that, they should be able to register additional local project directories on the desktop and select those workspaces from the app without scanning another QR code.

Target user flow:

1. User starts or has already paired the iOS app with the desktop Volt host.
2. User opens a project directory on the desktop.
3. User runs a simple registration command from that directory:
   ```bash
   volt remote host --register-workspace
   ```
4. The host records that directory as a named workspace in the existing Iroh host state file.
5. The app refreshes or reconnects and sees the new workspace name.
6. The user selects the workspace in the app.
7. The app reconnects to the same saved host using the selected workspace name.
8. The host authorizes the same paired phone identity and starts or resumes a runtime rooted at the selected registered directory.

The important MVP decision is workstation-scoped authorization: one paired phone authorization is valid for all registered workspaces in the same host state file.

## Summary of MVP Decision

Resolved by product direction on 2026-06-22:

- Workspace registration is a local desktop action.
- Registering a workspace makes that workspace available to paired clients for the same host state file.
- The app cannot request arbitrary host paths. It can only select registered workspace names.
- One paired phone authorization may use multiple registered workspaces.
- Workspace selection may reconnect or attach to a separate runtime. Live in-session cwd switching is not required for MVP.
- Per-workspace client permissions are not part of this MVP.
- Per-client tool grants still apply across all selected workspaces.

## Non-goals

Do not include these in the MVP unless explicitly requested later:

- Per-workspace tool allowlists in the app.
- Per-client workspace subset grants in the app.
- Multi-user collaboration or multiple phones sharing a runtime.
- Simultaneously exposing multiple host paths inside one agent process.
- Allowing the app to create, register, rename, delete, or path-edit workspaces.
- Letting the app request arbitrary host-local paths.
- Live cwd/project switching inside an active Volt session.
- Moving an active prompt from one workspace runtime to another.
- Cross-host multi-host selection in the iOS app.
- A desktop GUI for workspace management. CLI registration is enough for MVP.

## Current Implementation Summary

The current implementation already has several useful pieces:

- Host state persists `workspaces: IrohRemoteWorkspace[]`.
- A workspace has `name`, `path`, and optional `allowedTools`.
- Host state persists clients with `allowedWorkspaces` and `allowedTools`.
- `isIrohRemoteClientAllowedForWorkspace()` already treats an empty `allowedWorkspaces` list as a wildcard grant.
- Remote runtime/session state tracks `lastSessionIdByWorkspace` per client.
- Integrated host runtime registry is keyed by client node ID plus workspace name.
- App `SavedHostRecord` already stores `primaryWorkspace` and `workspaceNames`.
- App saved reconnect can synthesize a secret-free reconnect ticket from `SavedHostRecord`.
- Outbound host metadata already includes the current workspace and sanitized `/workspace` cwd.

The current limiting assumptions are:

- `volt remote host` chooses one workspace at startup.
- `IrohRemoteHostEngine` is constructed with one workspace snapshot.
- Pair-control requests reject any workspace other than the running host's single workspace.
- `authorizeIrohRemoteClient()` compares `hello.workspace` to that single workspace.
- New pairings store `allowedWorkspaces: [workspaceName]`, which makes authorization workspace-scoped rather than workstation-scoped.
- App Settings shows only `primaryWorkspace` and has no workspace picker.
- App saved reconnect uses only the record's current `primaryWorkspace`.

## Product Model

### Workstation Host

A Volt desktop host state file represents one trusted workstation identity.

Default state path:

```text
~/.volt/agent/remote/iroh-host.json
```

All workspace registrations under that state file belong to the same workstation-level trust boundary.

### Registered Workspace

A registered workspace is a host-local directory saved by name:

```json
{"name":"volt","path":"/Users/jordan/Projects/Volt","allowedTools":"read,grep,find,ls"}
```

The workspace name is the only value the app sees and selects. The host-local path is never sent to the app.

### Workstation-Scoped Client Authorization

For MVP, pairing grants a phone access to the workstation's registered workspace set.

Internally, this should use the existing wildcard representation:

```json
"allowedWorkspaces": []
```

Meaning:

- this client may use any workspace registered in this state file
- this client may also use future workspaces registered later in this state file
- revocation still blocks the client completely
- `allowedTools` remains the client's tool grant across all workspaces

This intentionally changes the product model from one-folder pairing to workstation pairing.

## CLI Requirements

### Register current directory

Primary MVP command:

```bash
volt remote host --register-workspace
```

Behavior:

- One-shot command.
- Does not start the long-running Iroh host.
- Uses the default state path unless `--state <path>` is supplied.
- Registers `process.cwd()`.
- Uses `basename(realpath(cwd))` as the workspace name.
- Validates the directory exists and is a directory.
- Stores the real path.
- Prints a concise confirmation to stderr or stdout.

Example:

```bash
cd /Users/jordan/Projects/Volt
volt remote host --register-workspace
# registered workspace: Volt -> /Users/jordan/Projects/Volt
```

### Register specified directory

The MVP should also support an explicit path or `name=path` spec:

```bash
volt remote host --register-workspace /Users/jordan/Projects/Volt
volt remote host --register-workspace volt=/Users/jordan/Projects/Volt
volt remote host --register-workspace .
volt remote host --register-workspace volt=.
```

Implementation note: because `--register-workspace` is naturally a boolean one-shot mode, the optional workspace spec can be accepted as the first positional after the flag. The existing `--workspace <name=path>` option may also be accepted as a parser-friendly fallback:

```bash
volt remote host --register-workspace --workspace volt=/Users/jordan/Projects/Volt
```

Rules:

- If no spec is supplied, use current directory.
- If a spec contains `=`, the left side is the workspace name and the right side is the path.
- If a spec does not contain `=`, the path is resolved against the current directory and the name is the path basename.
- Empty names are rejected.
- Nonexistent paths are rejected.
- Files are rejected; only directories may be registered.
- Paths are stored after `realpath()`.
- Re-registering the same name updates the path.
- Re-registering the same name should preserve existing `allowedTools` unless an explicit `--allow-tools` is supplied.

### Register with non-default state

```bash
volt remote host --state /tmp/volt-host.json --register-workspace volt=/path/to/Volt
```

The workspace is available only to hosts and clients that use the same state path.

### Register with default tools

MVP behavior:

```bash
volt remote host --register-workspace volt=. --allow-tools read,grep,find,ls
```

The workspace's `allowedTools` field remains a default for future pairing tickets when `volt remote pair --workspace <name>` is run without `--allow-tools`. It is not a per-workspace runtime enforcement rule for an already paired client. Runtime enforcement continues to use the paired client's persisted `allowedTools`.

### Host startup with registered workspaces

`volt remote host` should serve all registered workspaces in the selected state file.

Startup behavior:

- If `--workspace <spec>` is supplied, upsert that workspace first.
- If registered workspaces exist, serve the registered set.
- If no registered workspaces exist and no `--workspace` is supplied, preserve current convenience behavior by registering or serving the current directory as the default workspace.
- Startup ticket behavior still needs one primary workspace. Use this order:
  1. explicit `--workspace <spec>` name
  2. first workspace in persisted state order
  3. current directory fallback
- `--mobile` still starts without a startup pairing ticket.
- `volt remote pair --workspace <name>` remains the explicit Pair Phone action and chooses the ticket's initial workspace.

### Pair command with registered workspaces

```bash
volt remote pair --workspace volt
```

Behavior:

- The workspace name must exist in the registered workspace set.
- If only one registered workspace exists, `--workspace` may be omitted.
- If multiple registered workspaces exist and `--workspace` is omitted, the command fails with the existing ambiguity diagnostic.
- The ticket's `workspace` field is the initial workspace for the first connection.
- The ticket does not limit the client's future workspace set in MVP.
- Pairing creates or updates the client as workstation-scoped.

### Status output

`volt remote status` already exposes persisted workspaces. It should continue to show all registered workspaces. MVP status should make the workstation-wide grant clear enough for debugging.

Suggested additions if cheap:

- `workspaceCount`
- `client.allowedWorkspaces: []` retained as the wildcard representation
- a docs note that `[]` means all registered workspaces

## Host State Requirements

### State shape

No schema change is required for MVP.

Existing fields are sufficient:

```ts
interface IrohRemoteHostState {
  hostSecretKey?: number[];
  workspaces: IrohRemoteWorkspace[];
  clients: IrohRemoteClient[];
  revokedClients?: IrohRemoteRevokedClient[];
  pendingPairingTickets?: IrohRemotePendingPairingTicket[];
  pairingSecretTombstones?: IrohRemotePairingSecretTombstone[];
}
```

### Workspace registration storage

Registration must write through the existing state manager and file lock path so concurrent host and CLI actions do not corrupt state.

Required behavior:

- Load state under lock.
- Parse workspace spec.
- Validate and realpath the directory.
- Upsert by workspace name.
- Save state atomically.
- Return the saved workspace.

### Client grant storage

New workstation-scoped pairings should store:

```json
"allowedWorkspaces": []
```

Existing clients:

- MVP may migrate active clients in the state file to `allowedWorkspaces: []` when the host first runs in multi-workspace mode, or it may do this when a client next successfully authorizes.
- The product behavior should be clear: paired clients under this state file are workstation-scoped.
- Revoked clients remain revoked and must not be silently restored.

Preferred MVP path for speed:

- New pairings use `allowedWorkspaces: []`.
- Existing active clients are treated as workstation-scoped by the authorization layer when workstation mode is enabled.
- Optionally persist the normalized `[]` grant the next time that client is touched.

This avoids forcing existing paired phones to scan again.

## Host Authorization Requirements

### Workspace lookup

Host authorization must resolve `hello.workspace` against the registered workspace set.

Current behavior compares `hello.workspace` to one engine workspace. MVP behavior should be:

1. Load or access the current registered workspace list.
2. Find a workspace whose `name` equals `hello.workspace`.
3. If none exists, reject with `workspace_unavailable`.
4. If the client is revoked, reject with `client_revoked` before allowing reconnect.
5. If the client is paired and workstation-scoped, authorize it for the selected workspace.
6. If the client has a non-wildcard `allowedWorkspaces` list and it does not include the selected workspace, either:
   - treat it as workstation-scoped under MVP migration rules, or
   - reject with `workspace_forbidden` if preserving legacy restrictions is explicitly chosen.

For MVP speed and product simplicity, the preferred behavior is workstation-scoped authorization for all active paired clients in the state file.

### Pairing tickets

Pairing tickets remain workspace-bearing because the client needs an initial workspace:

```json
{
  "workspace": "volt",
  "secret": "one-time-secret",
  "nodeId": "host-node-id",
  "relayMode": "default"
}
```

The `workspace` field means:

- initial workspace used during first connection
- workspace used for pairing ticket validity checks
- primary workspace saved by the app after pairing

It does not mean:

- the only workspace the client may ever use
- an app-selected host path
- a per-workspace tool grant

### Reconnect tickets

Saved-host reconnect tickets remain secret-free and workspace-bearing:

```json
{
  "workspace": "other-project",
  "nodeId": "host-node-id",
  "relayMode": "default",
  "irohTicket": "..."
}
```

The app can synthesize a reconnect ticket for any workspace name in its saved `workspaceNames` list. The host remains authoritative: if the workspace is no longer registered, the host returns `workspace_unavailable`.

### Runtime root

A successful authorization returns the selected `IrohRemoteWorkspace`. The host must use that workspace path as the runtime cwd.

Integrated runtime:

- Registry key remains `clientNodeId + workspaceName`.
- Each workspace gets its own runtime/session continuity for that client.
- `lastSessionIdByWorkspace` continues to work.

Spawned RPC child:

- Spawn cwd is the selected workspace path.
- Existing process-per-connection behavior remains acceptable.

### Active connections

For MVP, switching workspaces in the app can close the current connection and open a new one. The host does not need to multiplex workspaces over one Iroh stream.

If a prompt is active in workspace A and the app switches to workspace B:

- The app should avoid doing this silently.
- MVP UI may disable workspace switching while streaming.
- Host detach semantics for workspace A remain as defined in `.volt/iroh-host-detach-cancel-design.md`.
- Workspace B uses a separate runtime key.

## Control Channel Requirements

The local control channel used by `volt remote pair` must resolve workspaces from host state, not from one startup workspace.

Required behavior:

- Pair request for registered workspace succeeds.
- Pair request for unregistered workspace fails with clear error.
- Pair request does not allow arbitrary paths.
- Running host should pick up workspaces registered under the same state path without requiring restart if feasible.

Preferred MVP implementation:

- On each pair-control request, read current state through `IrohRemoteHostStateManager`.
- Resolve `request.workspace` against `state.workspaces`.
- Create ticket for that workspace.
- The host process's endpoint identity and relay mode are still supplied by the running process.

## Running Host and Registration Interaction

A user should be able to register a workspace while the host is running:

```bash
# Terminal 1
volt remote host --mobile

# Terminal 2
cd /Users/jordan/Projects/OtherProject
volt remote host --register-workspace
```

Expected MVP behavior:

- The registration command writes the same default state file.
- The running host sees the new workspace for future pair-control requests and future handshakes.
- Existing connected clients may need to reconnect or refresh state before the app UI shows the new workspace.
- No existing active runtime is moved or restarted by registration.

If immediate live reload is too costly, the fallback MVP may require host restart after registration. That fallback must be documented, but it is not preferred because it weakens the simple workflow.

## Host Metadata Requirements

Outbound `get_state` decoration should include the registered workspace names without leaking host paths.

Current remote host metadata shape:

```json
"remoteHost": {
  "workspace": "volt",
  "hostNodeId": "...",
  "relayMode": "default",
  "hostName": "macstudio",
  "userName": "jordan",
  "cwd": "/workspace"
}
```

MVP should extend it to:

```json
"remoteHost": {
  "workspace": "volt",
  "workspaceNames": ["volt", "other-project"],
  "hostNodeId": "...",
  "relayMode": "default",
  "hostName": "macstudio",
  "userName": "jordan",
  "cwd": "/workspace"
}
```

Rules:

- `workspace` is the currently selected workspace for this connection.
- `workspaceNames` is the complete set of registered workspace names the app may present.
- `cwd` remains `/workspace`, not the host path.
- Host paths are never included.
- Ordering should be stable and user-friendly. Persisted order is acceptable for MVP; alphabetical order is also acceptable if documented.

## App Requirements

### Saved host record

The existing `SavedHostRecord` is sufficient:

- `primaryWorkspace`: selected workspace for next reconnect
- `workspaceNames`: known selectable workspace names
- `endpointTicket`: host discovery
- `hostNodeId`: host identity
- `relayMode`: connection mode

No app storage schema change is required.

### Refresh workspace names

When the app receives `get_state.remoteHost.workspaceNames`, it should update the saved host record:

- keep `hostNodeId` unchanged
- keep `endpointTicket` unchanged unless discovery refresh is also happening
- keep `relayMode` unless host metadata supplies a verified value
- set `workspaceNames` to the host-provided list, normalized with `primaryWorkspace` first or preserved as host order
- ensure the current connected workspace is included
- update `lastConnectedAt`
- optionally update `discoveryRefreshedAt`

If metadata does not include `workspaceNames`, keep the existing list.

### Workspace picker

Settings should show a workspace picker when a saved host has more than one workspace name.

Minimum UI:

- Section: `Saved Iroh Host`
- Row: `Workspace`
- Picker values: `savedHostRecord.workspaceNames`
- Current selection: `savedHostRecord.primaryWorkspace`

Changing selection should:

1. Create a new `SavedHostRecord` with the selected `primaryWorkspace`.
2. Preserve `workspaceNames`, `hostNodeId`, `relayMode`, `endpointTicket`, timestamps, and display name.
3. Clear or regenerate `sanitizedReconnectTicket` so it matches the selected primary workspace.
4. Save the record.
5. Reconnect to the saved host using the selected workspace, or show a `Reconnect` action if automatic reconnect is not desired.

MVP preference:

- If idle, changing the picker disconnects/reconnects automatically.
- If connected and streaming, disable the picker or require the user to wait/stop first.
- If host is offline, allow changing the saved primary workspace locally but keep offline state until retry.

### Reconnect with selected workspace

Saved reconnect should synthesize a reconnect ticket for `primaryWorkspace`.

If the selected workspace is unavailable:

- Host returns `workspace_unavailable`.
- App keeps the saved host.
- App marks `savedHostIssue = .workspaceUnavailable`.
- App keeps the selected primary workspace unless the user selects another workspace.

If the selected workspace is forbidden:

- For MVP this should be rare because auth is workstation-scoped.
- App handles existing `.workspaceForbidden` behavior.

### Pairing save behavior

After first pairing, the app initially knows only the ticket workspace. It should save:

```swift
primaryWorkspace = ticket.payload.workspace
workspaceNames = [ticket.payload.workspace]
```

After the first successful `get_state`, the app should refresh `workspaceNames` from host metadata.

### Workspace display names

MVP uses workspace names exactly as registered. No separate display name field is required.

## Security Requirements

### No arbitrary path access

The app must never send host-local paths. The only app-controlled workspace value is a registered workspace name.

Host must reject unknown workspace names with `workspace_unavailable`.

### Host path redaction

The outbound sanitizer remains scoped to the selected workspace path for the current connection. That is sufficient for MVP because each connection has one active workspace root.

Host path rules:

- Paths under selected workspace map to `/workspace`.
- Paths outside selected workspace are redacted.
- Paths for other registered workspaces are outside the current selected workspace and should be redacted unless that workspace is selected on a separate connection.

This prevents workspace A sessions from leaking workspace B host paths.

### Tool grants

Pairing and reconnect still use persisted `client.allowedTools`.

Registering a workspace must not grant additional tools.

If a client is paired with read-only tools, it remains read-only across all registered workspaces. If a client is paired with `bash`, `edit`, or `write`, those tools apply to all registered workspaces.

Unsafe tool confirmation remains required at pair time.

### Revocation

Revocation remains workstation-scoped.

If a phone is revoked:

- it cannot reconnect to any workspace
- it cannot use a newly registered workspace
- it cannot re-pair without explicit desktop approval as defined in the saved-host design

### Registration authority

Workspace registration is a local desktop action. It assumes the desktop user has shell access to the workstation. No remote client API for registration is included in MVP.

## Error Outcome Requirements

Use existing stable outcomes where possible:

- `workspace_unavailable`: selected workspace name is not registered or the registered path is no longer usable.
- `workspace_forbidden`: client is known but not allowed for that workspace. This is reserved for legacy/future per-client restrictions.
- `client_unknown`: phone identity is not paired with this workstation state.
- `client_revoked`: phone identity was revoked.
- `host_unreachable`: app cannot reach the saved host.
- `host_identity_mismatch`: app reached a different host identity.
- `saved_host_invalid`: local saved host record is malformed.

MVP should not introduce a new outcome for workspace registration.

## Backward Compatibility and Migration

The feature intentionally changes the preview model from workspace-scoped pairing to workstation-scoped pairing.

Suggested migration behavior:

- Existing `workspaces[]` continue to load.
- Existing saved host records continue to load.
- Existing records with one `workspaceNames` entry can be refreshed after `get_state` returns the full registered list.
- Existing active clients should not be forced to scan a new QR.
- Existing active clients may be treated as workstation-scoped under the new host behavior.
- Revoked clients remain revoked.
- Pending pairing tickets remain valid for their initial workspace only, but successful pairing creates workstation-scoped client authorization.

If implementation chooses not to auto-upgrade existing active clients, this must be documented because it would require re-pairing or manual state adjustment for old clients. The preferred MVP is no re-pairing.

## Implementation Plan

### Phase 1: Workspace registration command

Files likely touched:

- `packages/coding-agent/src/remote/iroh-host.mjs`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/remote/iroh/workspace.ts`
- `packages/coding-agent/src/core/remote/iroh/state-manager.ts`
- `packages/coding-agent/test/remote-cli.test.ts`
- `packages/coding-agent/test/remote-iroh-core.test.ts`

Tasks:

1. Add `--register-workspace` to host CLI help and parsing.
2. Add one-shot register path before serve startup.
3. Reuse or extend `parseIrohRemoteWorkspaceSpec()`.
4. Validate path exists and is directory.
5. Store realpath.
6. Upsert via state manager.
7. Add tests for cwd, path, `name=path`, state path, invalid path, and update existing name.

### Phase 2: Host multi-workspace authorization

Files likely touched:

- `packages/coding-agent/src/core/remote/iroh/authorization.ts`
- `packages/coding-agent/src/core/remote/iroh/engine.ts`
- `packages/coding-agent/src/core/remote/iroh/state-manager.ts`
- `packages/coding-agent/src/remote/iroh-host.mjs`
- `packages/coding-agent/test/remote-iroh-core.test.ts`

Tasks:

1. Change host engine options from single `workspace` to registered workspace resolver or workspace list.
2. Resolve `hello.workspace` dynamically.
3. Return selected workspace in authorization success.
4. Make new pairings workstation-scoped with `allowedWorkspaces: []`.
5. Decide and implement existing-client upgrade behavior.
6. Preserve revocation and pairing-secret semantics.
7. Add tests for:
   - pair in workspace A, reconnect workspace B
   - unregistered workspace rejected
   - revoked client rejected for all workspaces
   - consumed/expired pairing behavior unchanged
   - persisted `lastSessionIdByWorkspace` still keyed by selected workspace

### Phase 3: Pair control and running host reload

Files likely touched:

- `packages/coding-agent/src/remote/iroh-host.mjs`
- `packages/coding-agent/src/core/remote/iroh/control.ts`
- `packages/coding-agent/test/remote-cli.test.ts`
- `scripts/iroh-sidecar-test.mjs`

Tasks:

1. Resolve pair-control workspace from current state.
2. Allow any registered workspace.
3. Reject unregistered workspace with a clear error.
4. Keep relay expectation behavior unchanged.
5. Add scenario coverage for registering a second workspace and pairing/selecting it.

### Phase 4: Host metadata

Files likely touched:

- `packages/coding-agent/src/remote/iroh-host.mjs`
- `packages/coding-agent/test/remote-iroh-core.test.ts`
- `packages/coding-agent/test/remote-iroh-lifecycle-contract.test.ts` if relevant

Tasks:

1. Add `workspaceNames` to `remoteHost` metadata.
2. Ensure only names are exposed, not paths.
3. Ensure sanitizer still redacts host paths.
4. Add tests for metadata shape.

### Phase 5: App workspace picker and saved record refresh

Files likely touched in `/Users/jordan.hans/Projects/volt-app`:

- `Packages/VoltClient/Sources/VoltCore/SavedHostRecord.swift`
- `Packages/VoltClient/Sources/VoltCore/VoltSession.swift`
- `Volt/SettingsView.swift`
- `Packages/VoltClient/Tests/VoltCoreTests/SavedHostRecordTests.swift`
- `Packages/VoltClient/Tests/VoltCoreTests/VoltSessionLifecycleTests.swift`
- `Packages/VoltClient/Tests/VoltCoreTests/XcodeProjectConfigurationTests.swift`

Tasks:

1. Parse `remoteHost.workspaceNames` from `get_state`.
2. Refresh saved record workspace names after verified connection.
3. Add method to select primary workspace.
4. Regenerate or omit stale `sanitizedReconnectTicket` on primary change.
5. Add Settings picker.
6. Reconnect on workspace change when safe.
7. Add tests for refresh, selection, reconnect ticket workspace, unavailable workspace issue, and UI affordance.

### Phase 6: Docs and smoke validation

Files likely touched:

- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/security.md`
- `packages/coding-agent/docs/iroh-remote-protocol.md`
- `packages/coding-agent/examples/remote/iroh-sidecar/README.md`
- app README if app behavior changes

Tasks:

1. Document `--register-workspace`.
2. Document workstation-scoped authorization.
3. Document that app can select registered names only.
4. Document that registering a workspace makes it available to paired clients.
5. Document per-client tool grants still apply across all workspaces.
6. Run automated tests and a manual smoke.

## Test Plan

### Host/core tests

Required:

- Register current directory into empty state.
- Register explicit path.
- Register `name=path`.
- Reject missing path.
- Reject file path.
- Re-register same name updates path.
- Register command respects `--state`.
- Host auth resolves requested workspace by name.
- Paired client can reconnect to a second registered workspace without another secret.
- Unregistered workspace returns `workspace_unavailable`.
- Revoked client cannot use any registered workspace.
- Pairing ticket for workspace A creates workstation-scoped client grant.
- Same client `lastSessionIdByWorkspace` is independent for workspaces A and B.
- Pair control can create ticket for any registered workspace.
- Pair control rejects unknown workspace.
- `remoteHost.workspaceNames` contains registered names and no host paths.
- Outbound sanitizer still redacts paths outside the selected workspace.

### App tests

Required:

- Saved host record can store multiple `workspaceNames`.
- Saved reconnect ticket uses selected `primaryWorkspace`.
- `get_state.remoteHost.workspaceNames` refreshes saved record.
- Workspace picker appears when multiple workspace names exist.
- Selecting a workspace saves a new primary workspace.
- Selecting a workspace regenerates or omits stale reconnect envelope.
- Reconnect after selection sends selected workspace.
- `workspace_unavailable` keeps saved host and selected workspace.
- Workspace selection is disabled or guarded while streaming.

### Scenario/manual smoke

Minimum smoke:

1. Start host with persistent temp state and relay mode `default`.
2. Register workspace A.
3. Pair app/client once with workspace A.
4. Register workspace B with the same state path.
5. Refresh app/client state and observe workspace names A and B.
6. Select workspace B.
7. Reconnect without QR or pairing secret.
8. Verify host starts runtime in workspace B.
9. Switch back to workspace A.
10. Reconnect without QR or pairing secret.
11. Revoke phone/client.
12. Verify reconnect to both A and B fails with `client_revoked`.

## Acceptance Criteria

- `volt remote host --register-workspace` registers the current directory in the default host state.
- `volt remote host --register-workspace <path-or-name=path>` registers a specified directory.
- A running or restarted host can serve all registered workspaces from the same state file.
- One paired phone can use multiple registered workspaces without scanning another QR.
- The app can display and select registered workspace names.
- Workspace selection uses only names, never host paths.
- Reconnecting to a selected workspace starts or resumes a runtime rooted at that workspace.
- Per-client tool grants continue to apply across all workspaces.
- Revocation blocks all workspaces for that phone.
- Unknown workspace names are rejected with `workspace_unavailable`.
- Host metadata exposes workspace names but never host-local paths.
- Tests cover registration, authorization, app selection, and security boundaries.

## Open Questions

These should be resolved before implementation or explicitly accepted as MVP constraints:

1. Should existing active clients be automatically persisted to `allowedWorkspaces: []`, or only treated as wildcard at runtime?
   - Preferred MVP: persist `[]` when touched, no re-pair required.
2. Should workspace registration while the host is running be immediately visible without restart?
   - Preferred MVP: yes, by reading state for control requests and handshakes.
3. Should selecting a workspace in the app auto-reconnect immediately?
   - Preferred MVP: yes when idle, disabled while streaming.
4. Should `--register-workspace` print JSON for scripting or plain text for humans?
   - Preferred MVP: plain text is enough; JSON can be added later if needed.
5. Should host startup validate all registered paths or only validate a selected path on connection?
   - Preferred MVP: registration validates paths; connection failures for stale paths return `workspace_unavailable`.

## Deferred Future Work

- Desktop UI to list, rename, and remove registered workspaces.
- Per-client workspace subset permissions.
- Per-workspace tool grants.
- Explicit app-side workspace search/filter for many workspaces.
- Live workspace switching without reconnect.
- Multi-host app storage and host picker.
- Workspace removal command and stale path diagnostics.
- Host-side audit event for workspace registration.
