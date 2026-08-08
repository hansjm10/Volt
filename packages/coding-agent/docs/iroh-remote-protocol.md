# Iroh Remote Protocol v2

Iroh remote access tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream. The host runs on the user's machine; clients dial a ticket, send one handshake line, then exchange the same LF-delimited RPC messages documented in [RPC mode](rpc.md), subject to the remote command allowlist below.

This protocol is preview-stable for external client authors. V2 ticket, relay, and enrollment objects are strict: missing, extra, malformed, or unsupported values fail closed. Post-handshake objects retain their documented additive compatibility rules. Pairing and enrollment secrets are one-time credentials and must not be persisted.

For user-facing setup, start the background daemon with `volt daemon start` (see [Background daemon](daemon.md)), create tickets with `volt remote pair`, inspect `volt remote status`, revoke clients with `volt remote revoke <node-id>`, and approve same-device re-pairing with `volt remote approve-repair <node-id>`. The host-side management workflow, state/audit paths, unsafe tool warnings, relay mode, and npm/source-only daemon limitation are documented in [Using Volt](usage.md#remote-access-over-iroh-preview) and [Security](security.md#remote-access-over-iroh-preview). This document defines the wire contract only.

## Version and ALPN

- Ticket prefix: `volt+iroh://v2/`
- ALPN: `volt-rpc/0`
- Handshake type: `volt_iroh_hello`
- Handshake response type: `volt_iroh_handshake`
- Host feature: `multi_streams.v1`
- Host feature: `conversation_streams.v1`
- Host feature: `working_directories.v1`
- Host feature: `agent_settled.v1`
- Host feature: `session_runtime_state.v1`
- Host feature: `agent_options.v1`

The URL prefix selects pairing ticket v2. The RPC ALPN and hello protocol remain exactly `volt-rpc/0`; ticket versioning does not grant RPC compatibility by itself.

## Ticket

A v2 ticket is:

```text
volt+iroh://v2/<unpadded-base64url-json>
```

The decoded JSON payload has exactly these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `alpn` | yes | Must be `volt-rpc/0`. |
| `irohTicket` | yes | Native Iroh endpoint ticket used to dial the running host. |
| `workspace` | yes | Registered workspace name requested by the client. The host resolves this name from persisted state; clients must not send host paths. |
| `secret` | pairing only | Existing 24-byte one-time Volt pairing secret, encoded canonically. |
| `expiresAt` | pairing only | Safe integer Unix epoch milliseconds after which pairing and enrollment are invalid. |
| `nodeId` | yes | Exactly 64 lowercase hexadecimal characters. It must match the native Iroh ticket and authenticated handshake host identity. |
| `relay` | yes | One strict relay descriptor from the table below. |
| `enrollment` | managed pairing only | One-time managed claim. It is removed from reconnect data. |

Relay descriptors have exact, kind-specific shapes:

| `relay.kind` | Other fields | Meaning |
| --- | --- | --- |
| `volt-managed` | `origins`: non-empty canonical sorted HTTPS origins | Official Volt relay transport. A pairing ticket also requires `enrollment`. |
| `custom-uncredentialed` | `origins`: non-empty canonical sorted HTTPS origins | Owner-controlled relay transport. The official app sends it no App Check material or durable credential. |
| `n0-public` | none | Public n0 relays for explicit development and simulator testing. |
| `disabled` | none | Direct/LAN transport only. |

The managed claim has exactly `version:1`, a 16-byte unpadded-base64url `claimId`, and an independent 32-byte unpadded-base64url `claimSecret`. It carries no broker URL. The app sends Firebase App Check only to its fixed Volt broker, proves possession of its endpoint key, and requires the broker's relay origins to match the ticket exactly before dialing.

Example decoded managed pairing payload:

```json
{
  "alpn": "volt-rpc/0",
  "enrollment": {
    "claimId": "<16-random-bytes-base64url>",
    "claimSecret": "<32-random-bytes-base64url>",
    "version": 1
  },
  "expiresAt": 1790000000000,
  "irohTicket": "<iroh-endpoint-ticket>",
  "nodeId": "<64-lowercase-hex-host-endpoint-id>",
  "relay": {
    "kind": "volt-managed",
    "origins": ["https://iroh-relay-us-central.volt-cli.dev"]
  },
  "secret": "<one-time-pairing-secret>",
  "workspace": "volt"
}
```

Pairing tickets are explicit Pair Phone invitations. They are short-lived, one-time credentials for adding a new client, not durable reconnect credentials. Mobile-facing host startup does not create an active pairing ticket; `volt remote pair` creates the QR/ticket from a running host when a phone is being added. The ticket's `workspace` is the initial registered workspace for that pairing, not the client's permanent workspace boundary.

Relay enrollment and desktop authorization are independent. Managed enrollment only permits the two endpoint IDs to register with the official relay fleet; it cannot authorize a Volt handshake, workspace, RPC, or tool. Desktop control still requires the one-time pairing secret followed by the host-observed client endpoint ID and persisted client grant.

Saved-host reconnect data retains only `alpn`, `irohTicket`, `nodeId`, `relay`, and `workspace`; it strips `secret`, `expiresAt`, and `enrollment` together. After the authenticated host handshake succeeds, the app transactionally stores the pair-scoped 30-day renewal grant beside the saved-host authority in Keychain. That grant never enters a QR or reconnect ticket. Records using v1 fields or any static relay token are invalid and are not dialed. Ordinary reconnect after app restart, network loss, or host restart uses this authority without another QR scan. A saved-host client may synthesize a reconnect ticket for any registered workspace name learned from verified host metadata; the host remains authoritative and rejects unknown names with `workspace_unregistered`, removed authorizations with `workspace_authorization_removed`, missing directories with `workspace_missing`, and transiently unusable directories with `workspace_unavailable`.

Managed claims expire after 10 minutes. Pair grants expire after 30 days and are renewed with limited-use App Check when seven days remain. Broker, App Check, signature, or relay-origin failures deny managed relay registration but do not disable direct/LAN dialing. Forget and endpoint reset persist a signed revocation obligation before deleting local grant identity; retries continue on startup and foreground activation until acknowledged or expired. See [Iroh relay enrollment design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/iroh-relay-enrollment-design.md) for canonical signing bytes, broker routes, quotas, and relay limitations.

## Stream handshake

After opening an Iroh bidirectional stream, the client writes one UTF-8 JSON object followed by LF (`\n`):

```json
{"type":"volt_iroh_hello","protocol":"volt-rpc/0","workspace":"volt","conversation":{"target":"last"},"secret":"<one-time-pairing-secret>","clientLabel":"Jordan iPhone","clientNodeId":"<claimed-client-node-id>"}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Must be `volt_iroh_hello`. |
| `protocol` | yes | Must be `volt-rpc/0`. |
| `workspace` | yes | Registered workspace name requested by the client. |
| `conversation` | one mode required | Conversation stream target: `{ "target": "last" }`, `{ "target": "new", "sessionId": "..." }`, or `{ "target": "session", "sessionId": "..." }`. A `new` target may include a `worktreeId` on `worktrees.v1` hosts and/or `workingDirectory` on `working_directories.v1` hosts. |
| `workspaceDiscovery` | one mode required | Utility stream target: `{ "purpose": "list_sessions" }` or, on `agent_options.v1` hosts, `{ "purpose": "agent_options" }`. |
| `workspaceManagement` | one mode required | Utility stream target. Payloads are `{ "purpose": "unregister_workspace" }` or, on `worktrees.v1` hosts, `{ "purpose": "manage_worktrees" }`. |
| `secret` | no | Pairing secret when completing a pairing ticket. Omitted for already-paired clients. |
| `clientLabel` | no | Human-readable client label requested during pairing. |
| `clientNodeId` | no | Client-claimed node ID for diagnostics only. It is not authoritative. |

Mobile clients must include exactly one stream mode: `conversation`, `workspaceDiscovery`, or `workspaceManagement`. Both `conversation.target:"session"` and `conversation.target:"new"` must include a strict lowercase remote session ID; `last` must not. For `new`, this is a client-generated idempotency identity: first use creates that exact session and identical retries resume it. A `worktreeId` (lowercase worktree id syntax) is accepted only on `target:"new"` and only by hosts advertising `worktrees.v1`; `last` and `session` targets must not include one — resumes derive the worktree from the host's persisted session binding, never from the client. A `workingDirectory` is accepted only on `target:"new"`; it must be a POSIX-style relative path with no absolute prefix, control characters, empty segment, `.`, `..`, or `.git`. The host resolves it inside the registered workspace and rejects symlink escapes. Reusing a `new` session ID with a different workspace, worktree, or working directory fails with `invalid_conversation_target`. Discovery and management payloads reject unknown purposes and unexpected fields.

The authoritative client identity is the remote Iroh node ID observed by the host on the accepted connection, not `clientNodeId` from the hello. Unknown top-level hello fields are ignored.

The host responds with one UTF-8 JSON object followed by LF.

Success:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1","worktrees.v1","working_directories.v1"],"sessionId":"abc123","conversation":{"target":"last","sessionId":"abc123","selection":"resumed"},"child":"volt"}
```

Failure:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"client_unknown","hostNodeId":"<authoritative-host-node-id>","error":"client is not paired"}
```

On success, `hostNodeId` is the host's authoritative Iroh node ID and `clientNodeId` is the client's authoritative Iroh node ID observed by the host on the accepted connection. Stream-mode successes require `features` to include both `multi_streams.v1` and `conversation_streams.v1`. Conversation successes also require matching top-level `sessionId` and canonical `conversation.sessionId`, plus `conversation.target` and `conversation.selection` (`resumed`, `created`, `created_missing_last`, or `session_rekeyed`). A `new` target returns `created` on first publication and `resumed` on an identical retry. A `session_rekeyed` selection is valid only for `conversation.target:"session"`, must include `conversation.requestedSessionId`, and means the requested session is an alias for the returned canonical session. Discovery and management successes include purpose metadata and no session metadata:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1","working_directories.v1"],"workspaceDiscovery":{"purpose":"list_sessions"}}
```

`child` is an implementation label for the host-side runtime and may be omitted. Failure responses include `hostNodeId` when the host identity is known and may include `workspace`, `sessionId`, and `retryAfterMs`. A present `retryAfterMs` is a pacing hint: wait at least that long before the next automatic dial. Its absence on outcomes that cannot self-heal (for example `workspace_missing`) means automatic redialing will not help. `error` is diagnostic text and should not drive app state.

Host handshake failure outcomes:

| Outcome | Meaning |
| --- | --- |
| `invalid_workspace` | The workspace field is malformed. |
| `invalid_conversation_target` | The stream mode, target, purpose, or session ID syntax is malformed or unsupported. |
| `conversation_streams_unsupported` | Reserved for hosts that cannot provide conversation-bound mobile streams. Current daemon builds are conversation-only. |
| `pairing_secret_expired` | The supplied pairing secret matches an expired pending ticket or retained expired tombstone. |
| `pairing_secret_consumed` | The supplied pairing secret matches a retained consumed tombstone and this client is not the paired recovery node. |
| `client_unknown` | The host does not know this client node ID and no active, expired, or consumed pairing secret applies. |
| `client_revoked` | The client node ID has a retained revocation tombstone and has not completed an approved re-pair. |
| `workspace_unregistered` | The requested workspace name is not registered in this host state. |
| `workspace_unavailable` | The requested workspace is registered but its local directory is transiently not usable (permissions, IO, not a directory). Carries `retryAfterMs` so clients pace their retries. |
| `workspace_missing` | The requested workspace is registered but its local directory no longer exists. Clients should stop automatic redialing until the registration changes. |
| `workspace_authorization_removed` | The workspace exists but this client is no longer authorized for it. |
| `workspace_forbidden` | The workspace exists but this client is not allowed to use it. This is reserved for legacy or future per-client workspace restrictions. |
| `session_unavailable` | A strict `conversation.target:"session"` target does not resolve to an available session. |
| `duplicate_conversation_connection` | The same authoritative client already has an active stream for the resolved workspace/session. |
| `conversation_in_use` | The active or retained daemon runtime permits tools outside the attaching client's persisted grant, so the client cannot safely co-attach. |

Client-local reconnect outcomes are not sent by the host: `host_unreachable` means no usable transport/handshake could be opened, `host_identity_mismatch` means the reached Iroh node or handshake `hostNodeId` differs from the saved host identity, and `saved_host_invalid` means the local saved record is malformed or missing required v2 fields.

`client_revoked` remains authoritative for a revoked client node ID. A generic new pairing ticket does not let that same node silently return. The desktop host must first approve re-pair for the revoked node ID, then issue a fresh active pairing ticket; successful re-pair creates a new active client record and clears the revocation tombstone.

A successful pairing stores the client as authorized for the workstation represented by the host state file. That paired client can use any registered workspace name in that state file, including workspaces registered later, without scanning another QR. Revocation blocks that client node ID from every registered workspace. The client's persisted `allowedTools` value is a **headless agent tool grant** that applies to daemon-owned runtimes across all selected workspaces; registering a workspace does not add built-in tools. The default built-in grant is `read,bash,edit,write,image_gen,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp`. The Codex-only `image_gen` tool can read and upload local reference images and write generated PNG files on the host. When the persisted grant is the default built-in list, the host also exposes active tools registered by loaded extensions in the selected workspace. A TUI-owned conversation continues to use the TUI session's full local tool set; `review` and `chat` pairing presets do not narrow that local runtime.

A paired client may open multiple conversation streams, including multiple sessions in the same registered workspace. The identity key is authoritative client node ID, workspace name, and resolved session ID. If the same authoritative client opens the same workspace/session twice on one live Iroh connection, the host rejects the new stream and preserves the existing stream:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"duplicate_conversation_connection","hostNodeId":"<authoritative-host-node-id>","workspace":"volt","sessionId":"abc123","retryAfterMs":500,"error":"duplicate conversation connection"}
```

If the duplicate is the first conversation stream on a new Iroh connection from the same authoritative client, the host treats the previous active stream as stale, closes it with reason `replaced`, and accepts the new stream as the subscriber to the existing integrated runtime. Distinct authoritative clients may co-attach when the existing runtime's tool policy is within the attaching client's effective grant. Otherwise the host rejects with `conversation_in_use` and includes the resolved workspace/session identity.

## Stream feature compatibility

`multi_streams.v1` and `conversation_streams.v1` are optional host features, not a protocol version bump. Mobile pinned-agent clients require both features on successful stream-mode handshakes. Missing or malformed feature metadata for those modes means the host is incompatible with conversation streams. Clients should keep the saved host and surface an update/integrated-host-required state rather than asking for another QR scan.

`session_runtime_state.v1` is an optional discovery feature. Hosts advertising it may add `runtimeState` to `list_sessions` entries. Older clients must ignore the field; clients must not assume its absence means a session is stopped when the feature is not advertised.

`worktrees.v1` is an additional optional host feature. Clients must check for it before sending `worktreeId` in a conversation hello or opening a `manage_worktrees` management stream; hosts without the feature reject both with `invalid_conversation_target`. Conversation successes for worktree-bound sessions echo `conversation.worktreeId`.

`working_directories.v1` is an additional optional host feature for starting a new conversation in a workspace-relative subfolder while keeping project configuration rooted at the registered workspace (or at the matching worktree checkout root for worktree sessions). Conversation successes echo `conversation.workingDirectory` when the effective cwd is not the root. The wire value is always relative; host-local absolute paths never cross the protocol.

`agent_options.v1` is an optional host feature for read-only configured-agent discovery. Clients open a workspace-discovery stream with purpose `agent_options` and send `get_agent_options { workspaceName }`. The command requires `model.select.v1`; `workspaceName` must match the stream-authorized workspace. Its response contains `workspaceName`, the current authenticated model catalog, and `defaultConfig:{model:{provider,modelId},thinkingLevel,fastModeEnabled,agentMode}`. It has no catalog revision and performs no session, selection, worktree, runtime, or host-default mutation.

Configured-agent creation remains an app-owned sequence over ordinary primitives: optional deterministic `create_worktree`, retry-safe `target:"new"` attach with a stable session ID, then session-only model, thinking, Fast, and agent-mode commands before the first prompt. The host publishes runtimes only through the normal integrated runtime registry and durably records caller-named sessions through `SessionManager`. Concurrent same-ID attempts wait for that publication and converge; after a daemon restart the same request resumes the durable session after validating its stored cwd and worktree binding. There is no launch record, receipt, cleanup transaction, or rollback across resources. A worktree created before a later failure remains for explicit retry or removal, and a configuration failure leaves an empty resumable session; clients must not send the prompt until all configuration commands succeed.

Missing stream features, `conversation_streams_unsupported`, `workspace_unavailable`, `workspace_missing`, `workspace_unregistered`, `workspace_has_worktrees`, `workspace_authorization_removed`, `session_unavailable`, `duplicate_conversation_connection`, and `conversation_in_use` are not QR re-pair requirements by themselves. `workspace_has_worktrees` means the user must explicitly remove each child worktree first; it is not an authorization or connectivity failure. `host_identity_mismatch`, malformed saved-host data, `client_unknown`, and `client_revoked` still require explicit Pair Again or Forget Host style UX.

## Reconnect and session selection

A reconnecting paired client with the same authoritative Iroh node ID selects a conversation in the handshake. `target:last` resumes the last recorded session for that workspace when the remembered ID is valid and the session file still exists; if the remembered ID is invalid or missing, the host creates a new session and reports `conversation.selection:"created_missing_last"` or `created`. `target:new` creates the exact supplied session ID once and resumes it on retry; concurrent identical attempts serialize until one runtime is published. The request must repeat the original placement, and a resumed session's durable cwd must still match it. `target:session` resumes a strict session ID, fails with `session_unavailable`, or returns `conversation.selection:"session_rekeyed"` with `conversation.requestedSessionId` when a live runtime has moved from the requested session to a canonical replacement session. Clients must validate state/transcript against the returned canonical `sessionId` and update the selected pin only after that validation commits.

Saved-host clients must verify that the native endpoint ticket node ID and the handshake `hostNodeId` match the saved host's `nodeId` before trusting authorization failures or refreshing non-secret discovery fields. If the reached identity differs, clients should treat the attempt as `host_identity_mismatch` and leave the saved host identity and discovery data unchanged.

Remote UI clients should request `get_state` followed by `get_transcript` after a conversation stream is accepted. New Agent and Resume Agent are not post-handshake mutations; clients open a new conversation stream with `target:new` or `target:session`. For older history, clients use `get_transcript` pagination (`hasMore` and `nextBeforeEntryId`) and request pages with `beforeEntryId`.

Every conversation bootstrap/checkpoint and `get_state` response includes required nullable `state.gitContext`, using the field semantics in [RPC mode](rpc.md#get_state). It is a host-cached, path-free view of the active session worktree: repository display name, branch/detached/unborn HEAD, local upstream and optional managed-worktree base divergence, count-only status, operation, revision, observation time, and stale state. State reads never wait for Git. The host performs no fetch, changed path names and remote URLs never enter the value, and comparisons reflect only refs already present on the host.

Subsequent semantic changes arrive as ordered full replacements:

```json
{"type":"git_context_changed","gitContext":{"repository":"volt","head":{"kind":"branch","name":"main","oid":"0123456789abcdef0123456789abcdef01234567"},"upstream":null,"base":null,"status":{"staged":{"added":0,"modified":0,"deleted":0,"renamed":0},"unstaged":{"added":0,"modified":1,"deleted":0,"renamed":0},"untracked":0,"conflicted":0,"total":1,"clean":false},"operation":null,"revision":2,"observedAt":"2026-07-29T17:00:00.000Z","stale":false},"delivery":{"subscriptionId":"sub-1","cursor":42}}
```

`gitContext` can be `null` for a non-Git cwd. A bootstrap/checkpoint replaces the entire value and resets the client-side provider-revision baseline; after that, clients apply `git_context_changed` in `delivery.cursor` order. Provider revisions are local to one runtime and must not be compared across session rebinds. Git context is conversation-scoped session state, not handshake or host identity data: it is deliberately absent from `remoteHost`, tickets, workspace discovery metadata, persisted session JSONL, model context, and extension prompts.

`get_state` responses for Iroh sessions include remote host metadata with the current workspace, the available workspace names, and the availability of every registered workspace visible to the saved host:

```json
{
  "remoteHost": {
    "workspace": "volt",
    "workspaceNames": ["volt", "other-project"],
    "workspaces": [
      { "name": "volt", "status": "available" },
      { "name": "other-project", "status": "available" }
    ],
    "features": ["multi_streams.v1", "conversation_streams.v1", "working_directories.v1"],
    "hostNodeId": "<authoritative-host-node-id>",
    "relayMode": "production",
    "relayUrls": ["https://<relay-origin>"],
    "hostName": "macstudio",
    "userName": "jordan",
    "cwd": "/workspace"
  }
}
```

`remoteHost.workspaces` is required whenever `remoteHost` is present and lists every registered workspace as `{name,status}`, where `status` is `available`, `missing`, or `unavailable`. `remoteHost.workspaceNames` repeats only the names whose status is `available`. Both fields contain names only, never host-local paths. `remoteHost.features` repeats the safe host feature strings advertised during handshake. `remoteHost.relayMode` and `remoteHost.relayUrls` report the host's current relay configuration so saved-host clients can refresh their relay list without re-pairing; `relayUrls` is present only in `production` relay mode. Conversation clients must validate that the response `sessionId` and `remoteHost.workspace` match the handshake-bound stream identity. Selecting another pinned agent opens another conversation stream; v2 does not switch the cwd or session of an active stream in place.

## Lifecycle: detach versus cancel

An Iroh stream close, stream EOF, QUIC connection close, input half-close, or remote write failure is a detach signal. It has no RPC payload and the host must not translate it into an `abort` command. Mobile clients do not need to send a best-effort detach command before background suspension or process loss.

User-visible stop/cancel controls must send the allowed `abort` RPC command:

```json
{"id":"cancel-1","type":"abort"}
```

The successful response uses the normal RPC response shape:

```json
{"id":"cancel-1","type":"response","command":"abort","success":true}
```

`abort` is the only direct remote cancellation command in v2. Command names such as `cancel`, `cancel_run`, `detach`, and `disconnect` are not forwarded by the remote command allowlist. App-level disconnect without stop should close the stream only; clients reconnect by opening a new authorized stream, then calling `get_state` and `get_transcript`.

The daemon's integrated runtime treats an authorized stream as a subscriber to host-owned session state. When the only subscriber detaches during active work, the prompt continues on the host. The same authoritative Iroh node ID, workspace, and session can reconnect to the detached runtime; `get_state.isStreaming` reports an active provider run or continuation, `get_state.isBusy` additionally covers prompt preflight and standalone session operations, and `get_transcript` recovers persisted output. Idle detached runtimes are retained for 30 minutes by default, configurable with the `remote.detachedRuntimeTtlMs` setting. Distinct paired devices may co-attach to one runtime, and when a desktop TUI owns the conversation lease the daemon transparently relays the stream to it; `remote_terminal` reasons `lease_transferred` and `session_rekeyed_reconnect` signal expected closures the client should reconnect through immediately. Prompt-class commands during an ownership drain fail with the transient error code `lease_draining` (with `retryAfterMs`).

Host process exit, host crash, or explicit host shutdown are separate from client detach and can stop in-memory work because the runtime is gone. A reconnect after host exit requires a new host process and can recover only persisted session state.

## JSONL framing

All post-handshake traffic is Volt RPC JSONL:

- Each message is one JSON value encoded as UTF-8 and terminated by LF (`\n`).
- Split only on LF byte `0x0a`. Do not treat CR, Unicode line separator U+2028, or Unicode paragraph separator U+2029 as frame terminators.
- Bytes after the hello LF are preserved as initial RPC input. Clients may pipeline the first RPC request immediately after the hello line.
- Overlong or unterminated handshake lines are rejected before any RPC is forwarded.

## Remote RPC command allowlist

The host filters inbound RPC command `type` values by stream mode.

Conversation streams forward or handle these remote commands:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `get_transcript`
- `get_ui_capabilities`
- `get_ui_actions`
- `get_ui_action_completions`
- `invoke_ui_action`
- `register_push_target`
- `list_sessions`
- `create_worktree` (worktrees.v1)
- `list_worktrees` (worktrees.v1)
- `upload_device_logs`
- `extension_ui_response`
- `get_available_models`
- `set_model`
- `set_thinking_level`
- `set_agent_mode`

Conversation streams reject `new_session`, `switch_session_by_id`, and raw `get_messages` with `unsupported_remote_command`. Command-level `workspace`, `workspaceName`, or `sessionId` values on conversation commands are assertions only; values that do not match the stream-bound workspace/session fail with `session_mismatch`.

Conversation streams on `worktrees.v1` hosts also accept `create_worktree` and `list_worktrees` (same shapes and validation as the `manage_worktrees` stream, scoped to the stream-bound workspace), so a client can create a worktree and open a new isolated conversation without a separate management stream. `remove_worktree` remains management-stream-only. Hosts without a daemon backend answer both with `unsupported_remote_command`.

`list_sessions` entries include an optional `worktreeId` when the session is bound to a daemon-managed worktree, so clients can badge worktree sessions without a `list_worktrees` join. Entries also include optional `workingDirectory` when the session cwd is below the workspace/worktree root. Worktree attribution may be absent while a desktop TUI owns the conversation lease.

On hosts advertising `session_runtime_state.v1`, an entry may also include `runtimeState` with one of `tui-owned`, `daemon-active`, `daemon-detached`, or `daemon-draining`. The field is omitted when the session has no live lease/runtime. `tui-owned` means a desktop TUI process currently owns the conversation. `daemon-active` means a daemon runtime has at least one attached phone stream. `daemon-detached` means the daemon still retains the runtime with no attached streams and may represent idle warm retention rather than active work. `daemon-draining` means the daemon runtime is handing ownership to a TUI. Clients should therefore use the exact state, not mere field presence, when deciding which hidden sessions to auto-connect.

Workspace discovery streams are purpose-scoped. `list_sessions` streams accept only `list_sessions`; `agent_options` streams accept only `get_agent_options`. Any other valid RPC command receives `unsupported_on_workspace_discovery_stream`. Discovery streams create no conversation runtime and do not update last-session state.

Workspace management streams with purpose `unregister_workspace` accept `unregister_workspace` and `list_workspace_directories`. The directory-listing RPC takes `workspaceName` plus optional relative `path`, and returns `directories:[{name,path}]` with relative paths only. Unregister refuses with `workspace_has_worktrees` while any persisted child worktree remains; clients must remove each worktree through `remove_worktree`, using `force:true` only as the user's explicit destructive choice. Management streams with purpose `manage_worktrees` (worktrees.v1) accept only `create_worktree`, `list_worktrees`, and `remove_worktree`. Any other valid RPC command receives `unsupported_on_workspace_management_stream`. Every management command must include a `workspaceName` matching the stream workspace (`session_mismatch` otherwise) and may not include extra fields (`invalid_request`); inbound host-local filesystem paths are always rejected.

All other command types receive a JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process. This includes local-only subagent lifecycle commands such as `list_subagents`, `subagent_start`, `subagent_abort`, `subagent_get_state`, `subagent_get_transcript`, and `subagent_dispose`. Within the remote surface, only `abort` is a direct cancellation command.

### Subagent delegation trees on conversation streams

Remote clients observe spawning activity through the parent conversation's `subagent` tool call rather than through the local-only lifecycle commands. Child runtimes expose registry list/follow operations through the ordinary `subagent_registry` tool, including after delegation depth or child-count policy removes the spawning tool. Live `tool_execution_update`/`tool_execution_end` frames, `transcript_entry` frames, and `get_transcript` items carry the same bounded argument/detail projection for both tool names. Spawning details include per-task `status`, `subagentId`/`sessionId` attach targets, and — on hosts that stream delegation trees — bounded live fields per task: `task` (preview), `startedAt`, `durationMs`, `toolCalls`, `tokens`, `currentActivity`, and a recursive `children` array of the same node shape for nested delegation. Registry details include list/follow mode, status, run id, agent, and bounded pagination/output metadata. Trees are depth-capped at 5 levels and all strings are length-bounded and path-sanitized. `get_state` additionally includes the newest projected details on in-flight tool entries in `activeTools`, so a client attaching mid-turn can paint current activity without waiting for the next update frame. Clients must treat all of these fields as optional; older hosts omit them.

`register_push_target` registers mobile-issued relay credentials with the host. The client must first register its raw FCM token with the Volt push relay; it must not send that raw FCM token to the desktop host. The host persists the relay target id and target-scoped auth token so it can notify the phone after the Iroh stream detaches. `relayUrl` is accepted as app registration metadata, but host delivery uses the desktop host's configured relay URL (`--push-relay-url` / `VOLT_PUSH_RELAY_URL`) and does not let clients redirect delivery:

```json
{
  "id": "push-1",
  "type": "register_push_target",
  "args": {
    "provider": "fcm",
    "platform": "ios",
    "pushTargetId": "<relay-target-id>",
    "pushTargetAuthToken": "<relay-target-auth-token>",
    "relayUrl": "https://push-relay-us-central.volt-cli.dev",
    "tokenHash": "sha256:<fcm-token-hash>",
    "enabled": true
  }
}
```

The successful response is:

```json
{"id":"push-1","type":"response","command":"register_push_target","success":true,"data":{"status":"registered","pushTargetId":"<relay-target-id>"}}
```

Completion notifications use one canonical intent for managed push delivery and JSONL fallback. The JSONL shape is `notification_request`; the relay receives the same `eventId`, `kind`, title, body, `workspaceName`/`sessionId` authority, and `planId` or `workflowId`, and forwards those exact metadata fields in FCM `data`.

| Outcome | `kind` | Title | Body | Navigation |
| --- | --- | --- | --- | --- |
| Successful ordinary prompt | `conversation_completed` | `Volt finished` (optionally `in <workspace>`) | `Your conversation is ready.` | session only |
| Successful prompt ending in Plan mode with a ready plan | `plan_ready` | `Your plan is ready` | `Open Volt to review and approve it.` | `planId` |
| Completed review, zero findings | `review_completed` | `Your review is ready` | `<target> completed with no issues found.` | `workflowId` |
| Completed review, one finding | `review_completed` | `Your review is ready` | `<target> completed with 1 finding.` | `workflowId` |
| Completed review, multiple findings | `review_completed` | `Your review is ready` | `<target> completed with N findings.` | `workflowId` |
| Completed review, unknown count | `review_completed` | `Your review is ready` | `<target> completed. Open Volt to see the findings.` | `workflowId` |

A ready Plan emits `plan_ready` instead of `conversation_completed` for that prompt. Failed prompts retain the `host_notice` error copy, aborted prompts emit no completion notification, and cancelled or failed reviews do not emit `review_completed`.

```json
{"type":"notification_request","eventId":"plan:session-one:run-one:ready","kind":"plan_ready","title":"Your plan is ready","body":"Open Volt to review and approve it.","sessionId":"session-one","workspaceName":"volt-app","planId":"plan-one"}
```

```json
{"type":"notification_request","eventId":"review:one:completed","kind":"review_completed","title":"Your review is ready","body":"PR #151 completed with 4 findings.","sessionId":"session-one","workspaceName":"volt-app","workflowId":"review:one"}
```

Review targets come only from the host's bounded workflow target record: `PR #N`, `uncommitted changes`, a canonical commit, or a path-free branch comparison. Unsafe or unavailable targets fall back to `Review`; commands, diffs, pull request titles/bodies, and host paths are never copied into a notification. Notification titles are limited to 128 UTF-8 bytes, bodies to 512, review targets to 256, workspace and navigation/session identifiers to 128, event IDs to 512, and kinds to 64. Host construction removes unsafe copy before delivery, and strict control/relay boundaries reject path separators plus control, format, or surrogate characters; metadata also rejects whitespace.

`workspaceName` is the sole notification workspace key, contains a registered workspace name only, and never carries a host-local path; the former `workspace` key is rejected. `sessionId` remains the stream/runtime authority. `planId` and `workflowId` are mutually exclusive stable navigation identifiers and appear only on their matching kind. A retained runtime reconciles completed review records per paired client: a completion that lands while detached remains pending, is retried through push when available or delivered over JSONL after reattachment, and a stable `eventId` is surfaced at most once for that runtime/client.

`unregister_workspace` on a workspace management stream removes a registered workspace name from the host state file without deleting files:

```json
{"id":"unregister-1","type":"unregister_workspace","workspaceName":"old-workspace"}
```

The host rejects missing or malformed names, names that do not match the management stream workspace, and unknown workspaces. If the workspace has any persisted daemon-managed worktree records, the response is `success:false` with `error:"workspace_has_worktrees"`; the workspace, records, dirty/unmerged work, active worktree sessions, and all checkout directories remain untouched. A successful response is possible only after the user explicitly removes every managed worktree, and confirms the removed workspace name:

```json
{"id":"unregister-1","type":"response","command":"unregister_workspace","success":true,"data":{"workspaceName":"old-workspace","unregistered":true}}
```

This command is host-state metadata management only. It does not create, rename, path-map, or delete host workspace or worktree directories, including unrecognized/orphan directories under the daemon worktree root. Response data contains the registered name only, never a host-local path. Folder browsing is a separate read-only `list_workspace_directories` RPC on the same management stream and returns relative paths only.

### Worktree management (`manage_worktrees`, worktrees.v1)

A `manage_worktrees` management stream drives daemon-managed git worktrees for the stream workspace. Checkout paths are computed host-side under the agent dir and never cross the wire in either direction; requests carry ids and git refs only. If `workingDirectory` is inside a nested git repository or submodule under the registered workspace, the daemon creates the worktree from that nested repository root while keeping the worktree record and sessions under the registered parent workspace.

`create_worktree` runs `git worktree add` in the selected source checkout on a new branch (default `volt/<id>`; the base defaults to the source checkout's current branch and is recorded for later merge-back guidance):

```json
{"id":"1","type":"create_worktree","workspaceName":"myrepo","worktreeName":"fix-login","baseRef":"main"}
```

```json
{"id":"1","type":"response","command":"create_worktree","success":true,"data":{"worktree":{"id":"fix-login","branch":"volt/fix-login","baseRef":"main","createdAt":1751900000000,"sessionIds":[]}}}
```

Failures use the standard error response with reasons such as `not_a_git_repository`, `worktree_exists`, `worktree_branch_conflict`, `worktree_limit_reached`, `invalid_worktree_id`, `invalid_working_directory`, or `git_failed`. The wire `workingDirectory` remains registered-workspace-relative for both root and nested-repo worktrees; host-local nested repo roots and checkout paths are never exposed.

`list_worktrees` reports each worktree with availability, dirtiness, bound session ids, and merge-back counts (`aheadBehind` compares the worktree branch against its recorded base ref):

```json
{"id":"2","type":"list_worktrees","workspaceName":"myrepo"}
```

```json
{"id":"2","type":"response","command":"list_worktrees","success":true,"data":{"worktrees":[{"id":"fix-login","branch":"volt/fix-login","baseRef":"main","createdAt":1751900000000,"sessionIds":["s-abc"],"available":true,"dirty":false,"aheadBehind":{"ahead":1,"behind":0}}]}}
```

`remove_worktree` refuses dirty or in-use worktrees unless `force:true`, which stops bound runtimes first:

```json
{"id":"3","type":"remove_worktree","workspaceName":"myrepo","worktreeId":"fix-login","force":false}
```

```json
{"id":"3","type":"response","command":"remove_worktree","success":true,"data":{"worktreeId":"fix-login","removed":true,"stoppedRuntimeCount":0,"closedStreamCount":0}}
```

`create_worktree` and `list_worktrees` (but not `remove_worktree`) are also accepted on conversation streams — see the command allowlist above.

A conversation hello with `{"target":"new","sessionId":"agent-one","worktreeId":"fix-login"}` opens the caller-named session with the worktree checkout as its working directory; `{"target":"new","sessionId":"agent-two","workingDirectory":"packages/app"}` opens at `/workspace/packages/app` while project resources still load from the workspace root. Combining both maps the registered-workspace-relative `workingDirectory` into the worktree's source repo: for a nested source root `Volt` and selected folder `Volt/packages/coding-agent`, the checkout is created from the host's nested `Volt` repo and the agent cwd is `<worktree>/packages/coding-agent`, while the handshake/session-list `workingDirectory` remains `Volt/packages/coding-agent`. Worktree runtimes use the source checkout root as `projectCwd`, so `.volt`, settings, prompts, and MCP config are read from that isolated repo checkout; sessions are still stored under the parent registered workspace. The daemon persists the session→worktree binding so later `session`/`last` resumes land in the same checkout and subfolder. The runtime also receives the host record's workspace name and `baseRef`; when that local ref resolves, `state.gitContext.base` reports `baseRef...<captured-head-oid>` divergence coherently with the rest of the snapshot. Missing or locally stale refs produce `base:null`; Volt does not fetch to resolve them. Worktree runtimes inherit the parent workspace's trust decision and tool allowlist — never wider — and their outbound frames sanitize the worktree path, the parent checkout path, and the worktrees root to `/workspace` (or `/workspace/<nested-source-root>` for nested repo worktrees).

`upload_device_logs` on a conversation stream stores client diagnostic logs inside the stream-bound workspace so host-side tooling and agents can read them:

```json
{"id":"logs-1","type":"upload_device_logs","fileName":"volt-device.log","content":"+0.1s info app: App did finish launching\n"}
```

`content` must be a non-empty UTF-8 string of at most 4 MiB (and must fit the 16 MiB RPC line limit after JSON encoding). `fileName` is optional; when present it must be a single path component of letters, digits, `.`, `_`, or `-` that does not start with a dot, and when absent the host generates a UTC-timestamped `device-<timestamp>.log` name. The host writes the file atomically under `.volt/device-logs/` inside the workspace root, overwriting any file with the same name, and never writes outside the workspace. A successful response echoes the workspace-relative path only, never a host-local absolute path:

```json
{"id":"logs-1","type":"response","command":"upload_device_logs","success":true,"data":{"path":".volt/device-logs/volt-device.log","byteCount":42}}
```

`get_ui_capabilities`, `get_ui_actions`, `get_ui_action_completions`, and `invoke_ui_action` expose the native UI action protocol for the narrow remote-safe action set. Remote `get_ui_capabilities` advertises `ui_action_invocation.v1` only when the host accepts invocation and `ui_action_completions.v1` when action argument completions are available. Descriptor responses omit prompt bodies, skill content, raw `sourceInfo`, extension source paths, prompt and skill file paths, skill base directories, host session files, provider metadata, and secrets. They still pass through the outbound path handling layer below before being written to the remote stream.

Remote `get_ui_action_completions` and `invoke_ui_action` are allowlist-based. Every `invoke_ui_action` command requires a trimmed, non-empty string correlation `id` of at most 256 UTF-8 bytes; every success or command-level failure response produced for it echoes that exact id through the filter, grant, daemon-admission, identity, and runtime-dispatch layers, although transport failure can prevent delivery. A known invocation payload with a missing, non-string, empty, whitespace-padded, or overbound id receives an uncorrelated JSONL failure with no `id` and `command:"invalid"`; no layer emits an id-less or unusably correlated response tagged `invoke_ui_action`. V2 forwards exact reviewed built-in ids `session.new`, `run.cancel`, `thinking.fast_mode`, `review.uncommitted`, `review.branch`, `review.pr`, and `review.commit`, plus projected prompt-template and skill ids. `review.branch`'s `base` argument advertises the `gitBranches` completion source; its completion responses contain workspace branch names only and pass through the same outbound redaction layer as other descriptor surfaces. Extension commands are denied by default and are discovered or invoked remotely only when their registration explicitly sets `remoteSafe: true`; the same opt-in is rechecked for direct RPC prompts containing an extension slash command. The host still resolves the current action catalog, rechecks action availability and remote safety, validates arguments, and applies streaming policy at invocation time; review descriptors advertise `requiresConfirmation` and clients confirm before invoking. Local-only built-ins such as `context.compact` and `session.rename`, deferred `review.tools`, stale action ids, malformed action ids, near-prefix action ids, and unreviewed action id prefixes receive a normal JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process.

Remote clients should use `get_ui_actions` rather than `get_commands` to build native Actions pages and command palettes. `primary` descriptors are the host-curated card/button/toggle surface. `palette` descriptors are searchable compatibility actions for extension commands, prompt templates, and skills. Slash aliases in descriptors are display hints and compatibility metadata; action ids are the invocation contract.

Projected extension command, prompt-template, and skill actions execute through the host's existing prompt/command expansion path. Extension UI requests raised during those commands continue to use the existing `extension_ui_request` / `extension_ui_response` protocol. RPC-degraded extension UI methods keep the behavior documented in [RPC mode](rpc.md#extension-ui-protocol); Iroh does not add terminal-only UI support.

Remote review descriptors expose only bounded card metadata. All Git-backed review diffs disable textconv and external diff drivers. `review.commit` discloses that it inspects workspace commit history and sends commit metadata and diff to the review model; its required `ref` is trimmed, bounded to 1024 UTF-8 bytes, resolved to a commit object, and replaced with the canonical object id before `git show`. `review.pr` discloses use of the host's GitHub credentials and network and submission of pull request metadata and diff to the review model; its optional string `number` must be a canonical positive decimal no greater than `2147483647`, and omission selects the current branch's pull request. Explicit `null` is not omission and fails string argument validation.

Review invocations run detached: synchronous target or credential failures return `success:false` without an accepted response or workflow events; otherwise the response reports `accepted` with a `workflowId`, the conversation stays fully usable while the review runs, and the client's session is never force-switched. Review invocation responses do not include raw diffs, pull request titles or bodies, configured review model values, auth state, or raw tool output. Configured-model fallback warnings are suppressed remotely, and subprocess/provider failures are replaced with stable remote messages while detailed diagnostics remain host-local. Workflow metadata identifies commit targets by canonical object id and pull request targets as `PR #N`. While review runs, the host emits `workflow_start`, sanitized workflow-scoped `tool_execution_start`/`tool_execution_end`, `workflow_update`, and `workflow_end` events so clients can render a live progress timeline. Pull request tool events omit all model-controlled string arguments so title/body text cannot be reflected through them; other activity events include bounded tool names and approved arguments only. Raw read contents, grep output, review prompts, and diffs remain hidden. The remote review workflow uses the host-owned read-only review tool set (`read`, `grep`, `find`, `ls`) and never inherits extension tools or ordinary conversation tool grants. `get_review_result` and `list_review_workflows` (observe capability) fetch structured findings and discover active or recently finished reviews after a reconnect; `cancel_workflow` and `open_review_session` (control capability) abort a running review and seed a fresh session with completed findings on demand.

Remote Fast mode descriptors expose only bounded toggle metadata and current boolean state. `thinking.fast_mode` invocation accepts a boolean `enabled` argument, changes only the current session's branch-local inference-speed policy without changing thinking level, persisting defaults, or switching models, and returns updated action state. The action is available only for supported models on the canonical OpenAI Responses and OpenAI Codex endpoints; enabled requests Priority processing and disabled requests the default service tier for normal conversation turns.

Direct model and thinking RPC commands `get_available_models`, `set_model`, and `set_thinking_level` are forwarded on conversation streams so paired clients can render a native model picker and change the model or thinking level for the bound session:

- `get_available_models` returns the auth-configured model catalog (`data.models`), the same objects local RPC clients receive, each enriched with `availableThinkingLevels` so clients can render per-model thinking choices without provider capability matrices. Custom-model API keys and custom request headers never reach these model objects, but the catalog does expose model ids, display names, providers, base URLs, costs, and capability metadata to the paired client. The host reloads `auth.json` and `models.json` from disk before answering, so logins, logouts, and API keys saved by other volt processes become selectable without restarting the host.
- The host also watches `auth.json` and `models.json` and emits a payload-free `models_changed` event on conversation streams when the available catalog changes on disk (for example after `/login` or `/logout` in a desktop CLI). Clients should respond by re-requesting `get_available_models`; the event never carries credential material.
- `set_model` preserves local RPC/CLI semantics: omitting `persistDefault` switches the bound session and persists the choice as the host default for future sessions. Remote app calls **must send `persistDefault: false`** so a phone selection stays parameter-scoped to the bound session and cannot rewrite desktop defaults. Unknown provider/model pairs fail with `Model not found: <provider>/<modelId>`. `set_model` also clears any active Fast mode overlay and re-clamps the session thinking level to the new model (emitting `thinking_level_changed` when it changes); its response echoes the model with `availableThinkingLevels`.
- `set_thinking_level` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Remote app calls must send `persistDefault: false`; omission retains local RPC semantics and is reserved for callers authorized to change the host default. Levels the current model does not support are silently clamped, not rejected; the response `data.level` reports the effective post-clamp level, and a `thinking_level_changed` event fires only when the effective level actually changes. `get_state` reports the current model's valid levels in `availableThinkingLevels`.
- `cycle_model` and `cycle_thinking_level` remain blocked remotely; native clients have the full catalog and select explicitly.

First-class extension-provided native cards, persisted chat/global Fast mode defaults, profile switching, scoped-model editing, package management, provider login/logout, and project settings mutation are deferred. They require separate host-owned policy, storage, descriptor, and allowlist work before they can be exposed over Iroh.

The preview RPC surface intentionally stays narrow. It excludes local tools such as `bash`, `edit`, and `write`; those tools can only be used through the normal model/tool flow and host-side permission policy. It also excludes read-only local RPC commands such as `get_messages`, `get_commands`, and `get_last_assistant_text` for the remote preview.

The path-based `switch_session` command remains blocked remotely, and mobile conversation streams also reject direct `switch_session_by_id`; clients select another session by opening a new `conversation.target:"session"` stream. `get_transcript` is the remote-safe transcript read: it returns only the bound session's projected user, assistant, tool-summary, and compaction-summary items, ordered oldest-to-newest, with server-bounded page sizes. Host session file paths, raw `get_messages` payloads, thinking blocks, raw tool output, full file contents, provider payloads, and extension-private custom data are not returned. Transcript path and text fields still pass through the outbound redaction layer below.

- `get_messages` can return the full raw transcript, including prompts, tool output, file excerpts, provider payloads, and extension content beyond the projected transcript needed for reconnect.
- `get_commands` exposes installed extension, prompt-template, and skill metadata; remote clients must use the sanitized `get_ui_actions` discovery surface instead.
- `get_last_assistant_text` duplicates streamed assistant output and is superseded remotely by the projected transcript surface.
- `cycle_model` and `cycle_thinking_level` blind-cycle host state; remote clients use `get_available_models` plus explicit `set_model`/`set_thinking_level` instead.

Headless agent tool access and RPC command access are separate surfaces. `allowedTools` controls which listed built-in or extension tools the model may invoke in daemon-owned headless runtimes; it is carried through TUI relay metadata for visibility but does not narrow a TUI-owned conversation's full local tools. Every active/revoked client and pending pairing ticket also carries an RPC grant with the strict shape `{"schemaVersion":1,"revision":<integer >= 1>,"capabilities":[...]}`. Missing grants, unknown or duplicate capability IDs, and malformed revisions fail closed; development pairings created before this schema must re-pair.

The exact capability IDs are `conversation.observe.v1`, `conversation.control.v1`, `model.select.v1`, `integrations.manage.v1`, `worktrees.manage.v1`, `host.manage.v1`, `workspace.manage.v1`, and `diagnostics.upload.v1`. Command authorization is evaluated after the static remote command allowlist, which remains a hard ceiling. Capability denials use `error.code:"rpc_capability_denied"` and include `error.requiredCapability` where the response architecture supports structured errors. Session-only `set_model`/`set_thinking_level` (`persistDefault:false`) requires `model.select.v1`; persisting or omitting `persistDefault` additionally requires `host.manage.v1`. Agent-options discovery requires `model.select.v1`. Configured-agent setup uses the existing capabilities for each independent operation: `worktrees.manage.v1` for worktree provisioning, conversation control for attach and prompts, and model selection for session-only model and thinking changes.

Pairing snapshots either an explicit headless-agent-tool/capability selection or one immutable preset: `coding` (default), `review`, and `chat` grant observe/control/model selection, while `full` grants every capability. For daemon-owned headless runtimes, `coding` and `full` use the canonical default tool list and therefore enable `image_gen` automatically when an OpenAI Codex model is selected; `review` uses `read,grep,find,ls`, and `chat` grants no model tools. These preset tool differences do not constrain TUI-owned conversations, which retain the TUI session's full local tools. A fresh re-pair ticket always supplies its newly selected grant. Local control clients may atomically update both access planes with an expected grant revision; successful updates increment the revision and close that device's existing streams, runtimes, connections, and relays so reconnects use the authoritative grant.

## Outbound path handling

Before host RPC output is sent to the remote stream, Volt normalizes remote-meaningful workspace paths and keeps generic host paths intact:

- Paths under the selected stream's hosted workspace are rewritten under `/workspace`.
- A multi-stream host applies this mapping independently per stream; sibling workspace paths are not rewritten to `/workspace` unless they are the selected workspace for that stream.
- Host-local paths outside the workspace are left unchanged; Volt no longer emits a generic placeholder for them.
- Export paths are redacted when recognized with `[redacted export path]`.
- Session files are omitted or replaced with `[redacted session file]`.
- Bash output file paths are omitted or replaced with `[redacted bash output path]`.
- Path handling applies to responses, extension UI requests, assistant content, tool-call arguments, and plain-text fallback lines.
- Opaque model/provider data such as image base64 payloads and signature fields are preserved, while adjacent text and structured arguments are still processed as above.

The remaining dedicated placeholders are part of the remote RPC compatibility surface. Clients must display them as opaque strings and must not assume that a redacted path can be expanded locally.
