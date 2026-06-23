# Iroh Saved Host Pairing Design

## Purpose

Define the target user workflow for pairing the Volt iOS app with a desktop Volt host once, then reconnecting after app, network, computer, or host-service restarts without scanning a new QR code.

This document uses plain product language first, then maps the behavior to the current Volt/Iroh implementation.

## Target User Workflow

1. The user opens Volt on their computer.
2. Volt shows host status and a "Pair phone" action.
3. The user selects "Pair phone".
4. Volt generates and shows a temporary QR code.
5. The user installs the Volt app and scans the QR code.
6. The phone and computer complete pairing.
7. The computer remembers that this phone is allowed.
8. The phone remembers this computer as a saved Volt host.
9. Later, the user restarts the computer or the host service.
10. When the host service starts again, the phone reconnects from the saved host entry.
11. The user does not scan another QR code unless they add a new phone, reinstall the app, delete saved state, or revoke/re-pair the device.

The QR code is a first-time invitation. It is not the long-term credential.

## Product Model

Use two different concepts:

- Pairing QR: short-lived invite used to add a new trusted phone.
- Saved host: durable relationship between one phone and one computer.

The pairing QR should behave like a setup code. After it is used, future authentication depends on the saved phone identity and saved host identity.

Client-specific storage and UI details should live in client docs. For the iOS app handoff, see `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

This is the safer mental model:

- A screenshot of an old QR should not let someone connect forever.
- A previously paired phone should reconnect without another scan.
- The desktop user can revoke a phone from the host.
- The phone user can forget the saved host from the app.

## Current Implementation Summary

The current code already has most of the needed pieces:

- The host persists an Iroh endpoint secret key in the host state file as `hostSecretKey`.
- The host persists paired clients by Iroh client node ID.
- Pairing tickets are short-lived and one-time.
- The iOS app persists its own Iroh endpoint key in Keychain.
- After a successful connection, the iOS app saves a `SavedHostRecord` in Keychain.
- The saved host record removes the one-time pairing secret.
- The iOS app can reconnect from the saved host record on later launches.

Important current behavior:

- If the app is launched with `--volt-iroh-ticket`, it uses that launch argument first.
- That means local development can accidentally force the fresh-QR path every run and hide the saved-host path.

## Desired Behavior

### First Pairing

When the user selects "Pair phone", the desktop host creates a one-time QR code containing:

- host connection information
- workspace name
- relay mode
- short expiry
- one-time pairing secret

The phone scans it and connects to the host. During the handshake:

- the phone proves it has the one-time secret
- the host records the phone's Iroh node ID as an allowed client
- the phone saves the host as a trusted host
- the phone saves a `SavedHostRecord` with no pairing secret

After the host commits the new client record, the pairing QR is consumed for new client identities. If the app fails before saving `SavedHostRecord`, the same phone identity can retry and recover because the host now authorizes that phone by node ID.

### Reconnect

On app launch, if no explicit launch ticket is supplied, the app should:

1. Load the saved host from Keychain.
2. Bind its Iroh endpoint with the same saved phone identity.
3. Connect to the host using the saved host connection information.
4. Send a handshake without a pairing secret.
5. The host authorizes the phone by its persisted client node ID.

This is the normal path after first pairing.

Implemented 2026-06-22: the iOS app startup path now uses an explicit launch ticket first, otherwise a saved host, otherwise the unpaired state. Saved-host reconnect synthesizes a secret-free reconnect ticket from `SavedHostRecord`, verifies the handshake `hostNodeId`, keeps the saved host for offline/retry states, and maps stable reconnect outcomes into app state without parsing human-readable error text.

### Host Restart

When the host service restarts, it should:

1. Load the same host state file.
2. Reuse the persisted `hostSecretKey`.
3. Recreate the Iroh endpoint with the same host identity.
4. Load the existing paired-client list.
5. Accept reconnects from already-paired phone node IDs.

The host should not print or display a fresh pairing QR merely because it restarted. It should offer a "Pair phone" action for adding new devices, but existing devices should not need it.

## State Responsibilities

### Host State

Persisted on the computer:

- host Iroh secret key
- known workspaces
- paired client node IDs
- client labels
- allowed workspaces per client
- allowed tools per client
- paired timestamp
- last-seen timestamp
- optional last session ID by workspace
- revoked client tombstones keyed by client node ID
- explicit re-pair approvals for revoked client node IDs, if any
- active pending pairing ticket hashes and non-secret metadata
- consumed and expired pairing-secret tombstones with non-secret metadata and bounded retention

The host should not persist raw pairing secrets.

Default host state path:

```text
~/.volt/agent/remote/iroh-host.json
```

CLI host, desktop app host, and future background service host should all use this same default path unless the user explicitly overrides it. If the user passes an explicit state path, saved reconnect only works for host launches that use that same path. Any future state path migration must preserve `hostSecretKey`, paired clients, workspace grants, and consumed/pending pairing metadata.

### Client State

Persisted on the client device:

- client Iroh endpoint secret key
- saved host record

`SavedHostRecord` should contain:

- stable host node ID
- host display name, if available
- relay mode
- saved workspace names or workspace grant reference
- endpoint discovery data needed by Iroh
- sanitized endpoint ticket data, if this remains the current Iroh implementation detail
- saved timestamp
- last connected timestamp, if available

The saved host record should not contain the one-time pairing secret. The product contract is a saved host identity and discovery record, even if v1 stores today's sanitized endpoint ticket as one internal field.

The iOS v1 app may support exactly one saved desktop host, but the storage shape should be able to evolve into multiple saved hosts later. App-specific storage, launch, offline-state, and Forget Host behavior is defined in `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

### SavedHostRecord v1

Resolved 2026-06-22: `hostNodeId` is the authoritative saved-host identity. Endpoint tickets and discovery fields are dial hints that can be refreshed only after the client verifies it reached that same host node ID.

Client persistence should use a concrete v1 record with these fields:

- `schemaVersion: 1`
- `hostNodeId`: required stable desktop host node ID; this is the key for future multi-host storage and the value used for identity checks
- `hostDisplayName`: optional user-facing label, such as a desktop host name
- `relayMode`: required normalized relay mode, currently `"disabled"` or `"default"`
- `primaryWorkspace`: required workspace name used for the first reconnect
- `workspaceNames`: non-empty list of saved or granted workspace names known to the client
- `endpointTicket`: required sanitized Iroh endpoint ticket or equivalent Iroh discovery address for dialing the host
- `sanitizedReconnectTicket`: optional v1 compatibility envelope containing the current `volt+iroh://v1` ticket with `secret` removed; if present, it must decode to the same `hostNodeId`, `relayMode`, `primaryWorkspace`, and `endpointTicket`
- `savedAt`: required timestamp
- `lastConnectedAt`: optional timestamp updated after a verified reconnect
- `discoveryRefreshedAt`: optional timestamp updated when non-secret endpoint/discovery data is replaced

The one-time pairing `secret` must never be stored in `SavedHostRecord`. If a record has a secret, lacks `hostNodeId`, lacks a supported `relayMode`, lacks `primaryWorkspace`, or lacks usable `endpointTicket`/discovery data, treat it as `saved_host_invalid`.

For v1, the current sanitized endpoint ticket is sufficient as the discovery field when it is stored with an explicit required `hostNodeId` and verified before use. A separate discovery blob is not required for v1. The sanitized ticket alone is not the identity contract; it is only an implementation detail for dialing.

Implemented 2026-06-22: the iOS app model now persists `SavedHostRecord` v1 instead of treating a sanitized reconnect ticket as the saved record. The record requires `hostNodeId`, normalized `relayMode`, `primaryWorkspace`, `workspaceNames`, `endpointTicket`, `savedAt`, and no pairing secret; it can synthesize a secret-free reconnect ticket for the current Iroh transport and migrate valid legacy saved-ticket Keychain data into the new saved-host account.

Identity verification should happen in two places:

1. Before dialing, if the client can derive a node ID from `endpointTicket`, it must match `hostNodeId`.
2. After dialing, the protocol must let the client verify the reached host node ID, either from the Iroh connection identity or an authenticated handshake field added by the saved-host protocol. If the reached host identity differs from `hostNodeId`, return `host_identity_mismatch` and do not overwrite saved identity or discovery data.

Discovery refresh is allowed only after identity verification succeeds. The client may update `endpointTicket`, `sanitizedReconnectTicket`, `relayMode`, `workspaceNames`, `hostDisplayName`, `lastConnectedAt`, and `discoveryRefreshedAt` from host-provided non-secret data. It must not update `hostNodeId` from refreshed discovery. If the saved endpoint ticket is stale and no refresh path can reach the saved node ID, keep the record and report `host_unreachable`.

## QR Code Rules

Pairing QR codes should be:

- short-lived
- one-time use for new clients
- safe to discard after pairing
- generated on demand from the running host
- revocable indirectly by revoking the paired client after use

A pairing secret should be consumed only after a successful first pairing transaction. Failed connection or authorization attempts should not consume it. After one successful pairing, all later uses of that pairing secret by other node IDs should be rejected. The paired phone node ID may still recover from app-side save failure using the same QR data because the host authorizes it as an existing client, not as a new use of the secret. Concurrent scans should allow at most one successful new-client pairing.

Pairing QR codes should not be:

- reused as permanent credentials
- required for every app launch
- required for reconnect after host restart
- created merely because a mobile-facing host service started
- usable after the phone has already paired and saved the host

## Pairing Transaction Boundary

Resolved 2026-06-22: the successful pairing transaction boundary is the host-side durable authorization commit.

A host consumes a one-time pairing secret only when it atomically commits all host-side state needed to trust the phone:

- validate the pending pairing secret, expiry, workspace, and any revocation or re-pair approval rules
- record the phone node ID as a paired client with its label, workspace grants, allowed tools, paired timestamp, and last-seen timestamp
- remove or invalidate the matching pending pairing ticket
- persist the consumed pairing secret hash
- prepare a successful handshake response for that same phone node ID

Handshake response delivery, audit-log I/O, and the app's Keychain save are not part of the host commit. If the host commits the client and then fails to write the success response, the host must not roll back the client record or un-consume the secret. Rollback after commit would reopen the QR to another device. The recovery path is that the same phone endpoint identity reconnects as an already-paired client.

Failed attempts before this commit must not consume the secret. That includes malformed handshakes, wrong workspace, expired tickets, revoked clients without explicit re-pair approval, unknown clients without a valid pending secret, network failures before the host authorizes the hello, and any attempt where the host does not create or update the paired-client record.

If the host records the phone but the app fails before saving `SavedHostRecord`, the host relationship is still authoritative. A retry from the same phone endpoint identity should succeed even if the client still sends the original now-consumed QR secret, because the host should authorize existing clients by node ID before treating the secret as a new-pairing credential. That retry lets the app save a `SavedHostRecord` without another desktop approval step. If the phone loses both its endpoint identity and the QR/discovery data before saving, it cannot prove it is the recorded node and must use Pair Again.

Concurrent pairing attempts for one QR must be serialized by host state. At most one previously unpaired node ID may commit for a pairing secret. A duplicate attempt from the winning phone node ID is an existing-client reconnect/recovery attempt; it does not consume the secret again and may complete app-side saving. Attempts from any other node ID after the commit must receive `pairing_secret_consumed`. If an unintended device wins the race, the desktop user must revoke that device and generate a fresh QR; the host must not grant the same consumed QR to a second node ID.

Implemented 2026-06-22: host core authorization serializes pairing attempts through the host state manager, commits a new client and consumed-secret tombstone together, preserves same-node recovery with the original QR data, and keeps failed attempts from consuming the pending pairing ticket.

## Pairing Metadata Retention

Resolved 2026-06-22: consumed pairing-secret hashes should not be retained forever. The host should keep bounded non-secret tombstones for consumed and expired pairing secrets, then prune them by TTL.

Host state should distinguish:

- active pending pairing tickets: unexpired, unconsumed ticket hashes plus non-secret metadata needed to complete first pairing
- terminal pairing-secret tombstones: consumed or expired ticket hashes plus non-secret metadata used only to reject replay with a precise outcome and support status/audit

Active pending pairing tickets should contain `secretHash`, `workspace`, `allowedTools`, `createdAt`, `expiresAt`, optional `labelHint`, and any future non-secret pair-flow metadata. They should be pruned from the active pending list as soon as `now > expiresAt`. When pruned for expiry, the host should write an expired tombstone so a later scan can receive `pairing_secret_expired` while the tombstone is retained.

Consumed tombstones should contain `secretHash`, `workspace`, `consumedAt`, original `createdAt` and `expiresAt` if known, `clientNodeId`, optional `labelHint`, and `retainUntil`. Expired tombstones should contain `secretHash`, `workspace`, original `createdAt` and `expiresAt`, optional `labelHint`, outcome `pairing_secret_expired`, and `retainUntil`.

The default tombstone retention should be 30 days after the terminal state, with `retainUntil` never earlier than the original ticket `expiresAt`. After `retainUntil`, the host should prune the tombstone. A replay after pruning is still unauthorized; it may be reported as `client_unknown` because the host no longer has enough retained metadata to prove the secret was previously consumed or expired.

Cleanup should run at host startup/load, before writing state after any pairing/auth/revoke/status mutation, and before status output. Cleanup must never require or expose raw pairing secrets.

Implemented 2026-06-22: host core state stores consumed and expired pairing-secret tombstones with retained non-secret metadata instead of an unbounded consumed-hash list. Expired pending tickets move to expired tombstones, retained tombstones reject replays while in retention, and authorization prunes tombstones after their retention window.

## Relay and Discovery

Mobile reconnect should default to Iroh relay/discovery mode because phones move between Wi-Fi, cellular, and constrained networks.

Resolved 2026-06-22: the global preview CLI default should not change. Bare `volt remote host` remains `--relay disabled` for same-machine, LAN, CI, and existing preview workflows. Mobile-facing product flows default to relay/discovery.

The relay default scope is:

- Desktop/mobile product flow: a desktop "Pair Phone" action, background host service launched for the iOS app, or equivalent product setup should use relay mode `"default"` unless the user explicitly chooses an advanced LAN-only mode.
- CLI mobile profile: add a dedicated mobile-facing host option such as `volt remote host --mobile` that defaults relay mode to `"default"`. Do not overload `--profile`; that option already means a Volt settings profile.
- Existing CLI preview flow: `volt remote host` with no mobile option keeps relay mode `"disabled"`.
- Explicit opt-out: `--relay disabled` remains available and wins over mobile/product defaults when the user intentionally chooses LAN-only mode.
- Pair command: `volt remote pair` cannot change the relay mode of an already-running host. When omitted, its `--relay` expectation should use the live host mode. In mobile-facing flows, the host should already be running in relay mode `"default"`; `volt remote pair --relay default` should validate that expectation.

Mobile-facing tickets should include `relayMode: "default"` so the iOS app binds with compatible Iroh options. LAN-only tickets should include `relayMode: "disabled"` and be treated as an explicit advanced/local configuration.

Implemented 2026-06-22: `volt remote host --mobile` defaults the running host and explicit control-channel pair tickets to `relayMode: "default"` without emitting a startup ticket. Bare `volt remote host` continues to default startup tickets to `relayMode: "disabled"`, and explicit `--relay disabled` overrides `--mobile` for LAN-only setup.

## Local Development Guidance

When testing the desired flow:

1. Start the host with a persistent state path.
2. Scan the QR once.
3. Remove `--volt-iroh-ticket` from the iOS app launch arguments.
4. Relaunch the iOS app.
5. Verify that the app reconnects from the saved host.

If `--volt-iroh-ticket` is still present, the app will prefer that explicit ticket and may not exercise saved-host reconnect.

## Failure and Re-Pairing Cases

The user should need to scan again when:

- the phone app is deleted or its Keychain state is cleared
- the user taps "Forget Host"
- the desktop host state file is deleted
- the desktop user revokes that phone
- the host identity or host state is replaced
- the saved host record is malformed, references a different host identity, or the reached host no longer recognizes the phone

Changing workspace membership or permissions should not require re-pairing if the host identity and host state remain the same. If a saved host record references a workspace the host no longer exposes, the app should show a workspace unavailable or permission error rather than automatically sending the user through full pairing again.

The user should not need to scan again when:

- the app is force-quit and reopened
- the phone temporarily loses network
- the computer restarts
- the host service restarts with the same state path
- the host generates a fresh QR for another device after the user selects "Pair phone"

## Saved-Host Recovery Boundaries

Resolved 2026-06-22: ordinary offline hosts and stale discovery data are retryable saved-host states, not reasons to discard the saved host or force QR pairing.

Use these boundaries:

- `host_unreachable`: the app cannot open a transport to the saved host using the saved record and available Iroh discovery. Keep the saved host, show offline/retry, and do not offer QR scanning as the primary path. This covers the host process being stopped, the computer being asleep, temporary network loss, relay outage, and discovery lookup failure where no different host identity was reached.
- stale-but-refreshable discovery: the saved record is structurally valid and still names the authoritative host node ID, but its endpoint/discovery data is outdated. The app should keep the saved host, attempt Iroh discovery by the saved host node ID and relay mode, and refresh non-secret discovery fields after it reaches and verifies the same host identity. If refresh cannot reach the host, report `host_unreachable`, not `saved_host_invalid`.
- `host_identity_mismatch`: the app reaches a node whose cryptographic host node ID differs from the `SavedHostRecord` host node ID, or the host handshake proves a different identity. Stop automatic reconnect for that saved host, do not overwrite the saved host identity, and offer Pair Again or Forget Host.
- `saved_host_invalid`: the local saved host record cannot be parsed or lacks required v1 fields needed to identify and dial the host, such as a valid host node ID, supported relay mode, or usable discovery/ticket data. Do not attempt network reconnect from that record; offer Forget Host and Pair Again.
- `client_unknown`: the app reaches the saved host identity, but the host does not authorize the phone node ID. Keep the distinction from offline and invalid local data; offer Pair Again or Forget Host because host-side state no longer contains the phone relationship.
- `client_revoked`: the app reaches the saved host identity, but the host has a durable revocation tombstone for the phone node ID. Keep the saved host and phone endpoint identity, show that the phone was revoked by the desktop host, and offer Pair Again only after desktop approval plus Forget Host.
- `workspace_unavailable` and `workspace_forbidden`: keep the saved host. These outcomes are workspace access problems, not pairing or discovery failures.

## Revocation and Re-Pairing

Resolved 2026-06-22: revocation is a durable host-side block for a specific phone node ID, not only deletion from the paired-client list.

Resolved 2026-06-22: Volt host state implements revocation as `revokedClients[]` tombstones keyed by node ID. Each tombstone records label, prior workspace/tool grants, prior paired and last-seen timestamps, revocation time, optional last session metadata, and optional `rePairApprovedAt`. `volt remote status` exposes active clients and revoked clients separately; `volt remote approve-repair <node-id>` records explicit desktop approval. A revoked node cannot reconnect or consume a generic pairing QR. If the tombstone has `rePairApprovedAt`, the same node may re-pair only with an active unused pairing secret; the successful re-pair creates a new active client record and clears the tombstone.

When the desktop user revokes a phone, the host should:

- remove the phone from the active allowed-client list
- close active connections from that node ID
- retain a revoked-client tombstone keyed by the phone node ID
- record enough non-secret metadata for status, audit, and future approval, such as label, revoked timestamp, previous paired timestamp, previous workspace grants, and previous allowed tools
- reject reconnects from that node ID with `client_revoked`
- reject fresh pairing attempts from that same node ID with `client_revoked` unless the desktop user explicitly approved re-pair for that revoked node ID

A generic "Pair phone" QR is approval to add a new phone. It is not, by itself, approval for a previously revoked node ID to come back. Re-pairing the same phone identity requires an explicit desktop action such as "Allow re-pair" for that revoked device. After that approval, the next successful pairing from the same phone node ID may reuse the existing phone endpoint identity and create a new paired-client record, replacing or clearing the revocation tombstone according to the host-state implementation.

The app should not rotate or clear its endpoint identity automatically when it receives `client_revoked` or `client_unknown`. Keeping the phone identity lets the host make an authoritative decision and lets a desktop-approved re-pair reuse the same phone node ID. The app should rotate or clear the endpoint identity only when the user intentionally removes local state, such as Forget Host in the one-host v1 app, app deletion, Keychain deletion, or a future explicit "Reset phone identity" action.

If the app has cleared its endpoint identity, the host cannot cryptographically connect the new node ID to the revoked tombstone. That device is treated as a new phone and still requires a fresh desktop-generated pairing QR. The product should not describe endpoint rotation as a way to bypass revocation.

Implemented 2026-06-22: the iOS one-host v1 Forget Host path disconnects, clears the selected saved host record, clears saved-host issue state, and clears the persisted Iroh endpoint identity. `client_revoked` and `client_unknown` reconnect outcomes keep the saved host and endpoint identity until the user intentionally forgets the host. App tests cover endpoint identity retention and reset, and an Iroh transport test proves endpoint reset rotates the client node ID for later re-pair.

## UX Requirements

Desktop host:

- Show host status and a "Pair phone" action for first setup and adding devices.
- Generate the QR only after the user selects "Pair phone".
- Explain that the QR is temporary.
- Show saved paired devices.
- Allow revoking a device.
- Show revoked devices separately from active paired devices.
- Offer an explicit re-pair approval action for a revoked device when the desktop user wants to trust the same phone identity again.
- Prefer labels like "Jordan iPhone" over raw node IDs when available.

iOS app:

- Show saved host status.
- Try saved-host reconnect on launch.
- Provide "Forget Host".
- Show useful errors:
  - host unavailable
  - phone revoked by this desktop
  - saved host invalid
  - pairing ticket expired

Implemented 2026-06-22: the iOS Settings screen now shows saved-host status, saved-host issue details, Retry for offline/workspace recovery, Pair Again for invalid/mismatched/unknown/revoked/expired/consumed pairing states, and Forget Host. Host offline uses Retry as the primary action and does not make QR scanning the ordinary offline recovery path. The chat connection header also shows saved-host issue detail and a warning state for Host offline.

Detailed iOS UX and state behavior lives in `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

## Documentation Surface

Resolved 2026-06-22: the public root docs now describe the saved-host pairing contract in the user-facing usage guide, security notes, and protocol reference. The docs identify Pair Phone as the explicit ticket creation path, define the QR as a short-lived one-time invitation, state that saved-host reconnect uses no pairing secret and no ordinary QR rescan, document `~/.volt/agent/remote/iroh-host.json`, record the mobile relay default and LAN-only opt-out, cover revocation plus `volt remote approve-repair`, list offline/auth outcome boundaries, and keep preview limitations explicit.

## Auth and Error Outcomes

The app needs stable machine-readable outcomes, not only human-readable error strings. These outcomes should drive whether the app retries, keeps the saved host, asks the user to pair again, or asks the user to inspect the desktop host.

Resolved 2026-06-22: reconnect UX must classify failures by saved-host recovery boundary. Offline and stale discovery keep the saved host; identity mismatch, revoked/unknown client, and invalid local records require explicit Pair Again or Forget Host decisions.

Resolved 2026-06-22: host handshake failures should carry a stable machine-readable `outcome` field. The human `error` field remains diagnostic text and must not be the app's authority for user-facing state.

Resolved 2026-06-22: Volt protocol now defines the shared outcome set and exposes host auth outcomes in failed handshake responses. Client-local saved-host validation errors use outcome-bearing errors for `host_identity_mismatch` and `saved_host_invalid`; `host_unreachable` remains a client transport outcome outside host handshakes.

Suggested outcomes:

- `host_unreachable`: app could not reach the host. Keep the saved host and show offline/retry.
- `pairing_secret_expired`: QR expired before pairing. Ask the user to generate a new QR.
- `pairing_secret_consumed`: QR was already used. Ask the user to generate a new QR.
- `client_unknown`: saved host exists, but the host does not know this phone. Offer Pair Again or Forget Host.
- `client_revoked`: phone was revoked by the desktop host. Keep the saved host and phone endpoint identity; offer Pair Again only after desktop approval, plus Forget Host.
- `workspace_unavailable`: requested workspace is no longer exposed by the host. Keep the saved host and show workspace unavailable.
- `workspace_forbidden`: phone is paired but not allowed for that workspace. Keep the saved host and show permission denied.
- `host_identity_mismatch`: saved host record reached a different host identity. Stop reconnecting and offer Pair Again or Forget Host.
- `saved_host_invalid`: local saved host record is malformed or unusable. Offer Forget Host and Pair Again.

Protocol outcome source:

- Client-local outcomes:
  - `host_unreachable`: no transport/connection/handshake can be opened to the saved host.
  - `host_identity_mismatch`: the reached Iroh node ID or authenticated handshake `hostNodeId` differs from `SavedHostRecord.hostNodeId`. The client should ignore any later host auth outcome from that connection.
  - `saved_host_invalid`: the saved host record is malformed, unsupported, or missing required local fields before dialing.
- Host handshake outcomes:
  - `pairing_secret_expired`: the pairing secret hash matches an expired pending ticket or retained expired tombstone.
  - `pairing_secret_consumed`: the pairing secret hash matches a retained consumed tombstone and the authoritative remote node ID is not the already-paired client for recovery.
  - `client_unknown`: the authoritative remote node ID has no active client record, no revoked tombstone, and no recognized active/expired/consumed pairing secret.
  - `client_revoked`: the authoritative remote node ID matches a revoked-client tombstone and does not have an active desktop-approved re-pair grant.
  - `workspace_unavailable`: the requested workspace name is not currently known or exposed by the host.
  - `workspace_forbidden`: the requested workspace exists, but this paired client or pairing ticket is not granted access to it.

Handshake failure responses should include at least:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"client_unknown","error":"client is not paired","hostNodeId":"<host-node-id>"}
```

Handshake success responses should include the authoritative `hostNodeId` and `clientNodeId` so saved-host clients can verify identity and update non-secret discovery data after success. Outcome precedence on the host should be: revoked node, existing paired client authorization, recognized active pending secret, retained consumed/expired secret tombstone, then unknown client. Workspace checks apply before success: missing workspace is `workspace_unavailable`; known but unauthorized workspace is `workspace_forbidden`.

Implemented 2026-06-22: the iOS transport now decodes handshake `outcome` and `hostNodeId`, rejects saved-host identity mismatches before applying host outcomes, and surfaces outcome-bearing transport errors. `VoltSession` maps those errors to `host_unreachable`, `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, `client_revoked`, workspace failures, and pairing-secret failures while preserving saved-host records according to the recovery boundaries above.

## Implementation Plan

1. Verify current saved-host path end to end.
   - Pair once.
   - Relaunch app without `--volt-iroh-ticket`.
   - Confirm reconnect succeeds.

2. Make local development workflow explicit.
   - Document that launch-argument tickets bypass saved-host reconnect.
   - Consider an Xcode scheme or helper script that launches without `--volt-iroh-ticket`.

3. Make host startup reconnect-friendly.
   - Ensure the default host state path is stable.
   - Ensure `hostSecretKey` is reused.
   - Keep bare CLI host relay default disabled for preview/local workflows.
   - Prefer relay mode `default` for desktop/mobile Pair Phone and CLI mobile-profile host commands.

4. Improve pairing UX.
   - Treat QR generation as an explicit "Pair phone" action.
   - Add or polish `volt remote pair` for generating new pairing QR codes from a running host.
   - Keep existing clients authorized through saved state.
   - Implemented 2026-06-22: `volt remote host --mobile` starts without creating or printing a startup pairing ticket; `volt remote pair` creates the Pair Phone ticket from the running host. Bare preview `volt remote host` keeps its startup pairing ticket for local preview compatibility.

5. Improve status and diagnostics.
   - Host should expose paired device list and revoke controls.
   - App should distinguish "needs pairing" from "host offline" and "revoked".

6. Validate host restart.
   - Pair phone.
   - Stop host.
   - Restart host with same state path and relay mode.
   - Open app and reconnect without scanning.

## Test Plan

Host/core tests:

- Existing paired client reconnects without `secret`.
- New unpaired client without `secret` is rejected.
- Consumed pairing secret cannot pair a second client.
- Pending pairing tickets expire into retained expired tombstones, then prune after retention.
- Consumed pairing secret tombstones are retained by TTL, not forever.
- Handshake failures include stable `outcome` values for expired/consumed secrets, unknown clients, revoked clients, unavailable workspaces, and forbidden workspaces.
- Saved-host reconnect verifies reached host node ID against `SavedHostRecord.hostNodeId`.
- Verified reconnect refreshes non-secret discovery fields without changing `hostNodeId`.
- Malformed saved-host records missing required v1 fields map to `saved_host_invalid`.
- Bare `volt remote host` keeps relay mode disabled by default.
- Mobile-facing host/profile startup creates no pending startup ticket, while explicit Pair Phone tickets use `relayMode: "default"` unless explicitly opted out.
- Explicit LAN-only opt-out tickets use `relayMode: "disabled"`.
- `volt remote pair --relay default` validates that the running host is relay-capable.
- Retry from the same phone node ID after host commit can recover even if the app has not saved `SavedHostRecord` yet.
- Host response-write failure after client commit keeps the client paired and the secret consumed.
- Failed pairing attempt does not consume the pairing secret.
- Concurrent pairing attempts allow at most one successful pairing.
- Expired pairing secret is rejected.
- Host restart with same state authorizes existing client node ID.
- Host restart with deleted state requires re-pairing.
- Revoked client cannot reconnect.
- Revoked client cannot re-pair with the same node ID until desktop approval.
- Desktop-approved re-pair can reuse the same phone node ID.

iOS tests:

- See `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

Manual smoke test:

1. Start host with `--relay default`.
2. Launch app with QR ticket and scan/connect.
3. Confirm saved host appears in Settings.
4. Kill and relaunch app without launch ticket.
5. Confirm app reconnects without scan.
6. Restart host with same state path.
7. Confirm app reconnects without scan.
8. Revoke phone on host.
9. Confirm app can no longer reconnect until re-paired.

## Acceptance Criteria

- A user can pair the iOS app to a desktop host by scanning one QR code.
- A paired phone reconnects after app restart without scanning.
- A paired phone reconnects after host restart without scanning when the same host state is reused.
- The QR remains short-lived and one-time for new pairings.
- The host can list and revoke paired phones.
- The iOS app can forget a saved host.
- Development launch arguments do not obscure the saved-host path during testing.

## Resolved Design Questions

### Should the product default for mobile host setup always be `--relay default`?

Yes for mobile-facing product setup, no for the bare preview CLI.

Phones frequently move between Wi-Fi, cellular, VPNs, hotspots, and sleep/wake network states. A local-only default would make reconnect feel unreliable for normal phone use. Relay-capable setup should be the product default, while LAN-only mode can remain available as an explicit advanced option.

Resolved 2026-06-22: bare `volt remote host` keeps its existing `--relay disabled` default for same-machine, LAN, CI, and preview workflows. Desktop Pair Phone, the future desktop background service, and a dedicated CLI mobile mode such as `volt remote host --mobile` default to `--relay default`. `volt remote pair` follows the running host relay mode unless `--relay` is supplied as an expectation check.

### Should the desktop host print a QR on every startup, or only when the user chooses "Pair phone"?

Only when the user chooses "Pair phone".

The QR is a temporary invite for adding a new device. Printing it every startup makes pairing look like a required reconnect step and creates unnecessary active invites. Startup can show that no phone is paired yet and offer a "Pair phone" action, but QR generation should be tied to that explicit user action.

Resolved 2026-06-22: mobile-facing `volt remote host --mobile` now follows this product rule by starting without a startup pairing ticket. `volt remote pair` is the explicit Pair Phone action path. The bare preview CLI remains compatible and still prints a startup pairing ticket unless `--mobile` or `--no-pairing` changes that startup mode.

### Should saved reconnect use the current endpoint ticket format, or do we need a more stable host identity/discovery ticket for stronger restart/network-change behavior?

Saved reconnect should use a stable saved-host record.

`SavedHostRecord` is the product model. It should contain the stable host node ID, relay mode, workspace grant reference or workspace names, endpoint discovery data, saved timestamp, optional last connected timestamp, and no pairing secret.

Resolved 2026-06-22: the current sanitized endpoint ticket is sufficient as the v1 discovery field when the record also has a required `hostNodeId` and reconnect verifies the reached host identity. The product contract is still "saved host identity and discovery," not "reuse the original QR." If future Iroh behavior needs stronger discovery data, migrate the refreshable `endpointTicket` field without changing the user-facing saved-host flow.

### Should one desktop host support multiple named workspaces under a single saved phone relationship?

Yes, the design should make multiple workspaces easy to support later.

The first implementation may pair a phone to one workspace, but the durable relationship should be between the phone and the desktop host identity. Workspace access should remain a permission on that relationship. The host state and app model should avoid one-folder-only assumptions so a paired phone can later be granted access to multiple named workspaces without rethinking pairing.

### What should the app show when the saved host exists but the host service is not currently running?

The app should show a saved-host offline state, not a pairing failure.

Suggested copy:

- Status: "Host offline"
- Detail: "Volt is paired with this computer, but the host service is not reachable."
- Primary action: "Retry"
- Secondary action: "Forget Host"
- Optional guidance: "Start Volt on your computer to reconnect."

The QR scanner should not be the main path from this state. Offline means the saved relationship may still be valid. Re-pairing should be reserved for explicit user choice, revoked clients, deleted state, or invalid saved-host data.

### Where is the boundary between offline, stale discovery, identity mismatch, and invalid saved-host data?

Resolved 2026-06-22: the authoritative saved-host identity is the saved host node ID. A well-formed saved host with that node ID stays saved through offline and stale-discovery failures. The app should retry and refresh non-secret discovery data when it can verify the same host identity. It should only leave the normal reconnect path when local data is malformed or unsupported (`saved_host_invalid`), when a reached host proves a different node ID (`host_identity_mismatch`), or when the reached saved host rejects the phone relationship (`client_unknown` or `client_revoked`).

### Can a revoked phone re-pair with the same phone identity?

Resolved 2026-06-22: not silently. The host must keep a revocation tombstone for the phone node ID and reject both saved reconnect and fresh pairing from that node ID with `client_revoked` until the desktop user explicitly approves re-pair for that revoked device. After desktop approval, the app may re-pair with the same phone endpoint identity. The app should not rotate endpoint identity automatically for `client_revoked`; it clears endpoint identity only when the user intentionally removes local state, such as Forget Host in the one-host v1 app, app deletion, Keychain deletion, or a future explicit reset identity action.

### When is a one-time QR consumed, and how does app-save failure recover?

Resolved 2026-06-22: the QR is consumed when the host durably commits the new phone node ID, removes the pending ticket, and persists the consumed secret hash. The app saving `SavedHostRecord` is required for normal future reconnect, but it is not part of the host's commit boundary. If the app crashes or Keychain save fails after the host records the phone, the same phone endpoint identity can retry with the original QR data and the host must treat it as an existing-client recovery path, not as a second use of the consumed secret. A different node ID cannot reuse the consumed secret.

### What are the concrete SavedHostRecord v1 fields and identity rules?

Resolved 2026-06-22: clients persist `schemaVersion`, required `hostNodeId`, optional `hostDisplayName`, normalized `relayMode`, `primaryWorkspace`, `workspaceNames`, required `endpointTicket`, optional `sanitizedReconnectTicket`, `savedAt`, optional `lastConnectedAt`, and optional `discoveryRefreshedAt`. `hostNodeId` is authoritative. Endpoint tickets and sanitized reconnect tickets are refreshable dial hints. The current sanitized endpoint ticket is sufficient for v1 discovery when paired with explicit `hostNodeId` verification; no separate discovery blob is required for v1.

Resolved 2026-06-22: Volt protocol helpers now expose a sanitized reconnect ticket payload that strips `secret` and `expiresAt` while requiring `nodeId` and `relayMode` for saved-host use. Host handshake responses can include authoritative `hostNodeId`; clients verify expected host identity before trusting reconnect results or refreshing non-secret discovery.

### What is the scope of the mobile `--relay default` product default?

Resolved 2026-06-22: do not change the global CLI default. The default changes only for mobile-facing product/profile flows. Bare `volt remote host` remains relay-disabled; desktop Pair Phone, desktop service startup for the iOS app, and `volt remote host --mobile` default to relay `"default"`. Explicit `--relay disabled` remains the advanced LAN-only opt-out. `volt remote pair` uses the running host relay mode by default and treats `--relay` as an expectation check.

### How long are pairing metadata hashes retained, and how are auth outcomes detected?

Resolved 2026-06-22: active pending pairing tickets expire at `expiresAt`; expired and consumed secrets become non-secret tombstones retained for 30 days after their terminal state, with `retainUntil` never before the original expiry. Tombstones are pruned after `retainUntil`, so hashes are not retained forever. Host handshake failures use a stable `outcome` field. `client_unknown`, `client_revoked`, `workspace_unavailable`, `workspace_forbidden`, `pairing_secret_expired`, and `pairing_secret_consumed` are host outcomes; `host_unreachable`, `host_identity_mismatch`, and `saved_host_invalid` are client-local outcomes based on transport, reached host identity, and saved record validation.
