# Iroh Remote Protocol v1

Iroh remote access tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream. The host runs on the user's machine; clients dial a ticket, send one handshake line, then exchange the same LF-delimited RPC messages documented in [RPC mode](rpc.md), subject to the remote command allowlist below.

This protocol is preview-stable for external client authors. Clients must reject unsupported required values, ignore unknown fields unless this document says otherwise, and treat secrets as one-time credentials.

For user-facing setup, run `volt remote host` on a trusted host workspace, create tickets with `volt remote pair`, inspect `volt remote status`, revoke clients with `volt remote revoke <node-id>` or `volt remote revoke --all`, and approve same-device re-pairing with `volt remote approve-repair <node-id>`. The host-side management workflow, state/audit paths, unsafe tool warnings, relay mode, and Node-only/Bun-binary limitation are documented in [Using Volt](usage.md#remote-access-over-iroh-preview) and [Security](security.md#remote-access-over-iroh-preview). This document defines the wire contract only.

## Version and ALPN

- Ticket prefix: `volt+iroh://v1/`
- ALPN: `volt-rpc/0`
- Handshake type: `volt_iroh_hello`
- Handshake response type: `volt_iroh_handshake`
- Host feature: `multi_streams.v1`
- Host feature: `conversation_streams.v1`

The URL prefix selects protocol v1. The `alpn` ticket field and `protocol` hello field must be exactly `volt-rpc/0`.

## Ticket

A v1 ticket is:

```text
volt+iroh://v1/<base64url-json>
```

The decoded JSON payload is an object with these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `alpn` | yes | Must be `volt-rpc/0`. |
| `irohTicket` | yes | Native Iroh endpoint ticket used to dial the running host. |
| `workspace` | yes | Registered workspace name requested by the client. The host resolves this name from persisted state; clients must not send host paths. |
| `secret` | no | One-time pairing secret. Present only in pairing tickets. Persisted host state stores only a hash. |
| `expiresAt` | no | Unix epoch milliseconds after which the pairing secret is invalid. |
| `nodeId` | no | Host node ID. Required for saved-host reconnect records and verified against the native Iroh ticket plus handshake host identity. |
| `relayMode` | no | `default` or `disabled`; clients may use it only as a diagnostic hint. |

Unknown ticket fields are reserved for compatible extension and must be ignored by v1 clients.

Example decoded payload:

```json
{
  "alpn": "volt-rpc/0",
  "expiresAt": 1790000000000,
  "irohTicket": "<iroh-endpoint-ticket>",
  "nodeId": "<host-node-id>",
  "relayMode": "default",
  "secret": "<one-time-pairing-secret>",
  "workspace": "volt"
}
```

Pairing tickets are explicit Pair Phone invitations. They are short-lived, one-time credentials for adding a new client, not durable reconnect credentials. Mobile-facing host startup does not create an active pairing ticket; `volt remote pair` creates the QR/ticket from a running host when a phone is being added. The ticket's `workspace` is the initial registered workspace for that pairing, not the client's permanent workspace boundary.

Saved-host reconnect data uses the same ticket payload shape without `secret` or `expiresAt`. A saved reconnect record must retain a non-empty `nodeId`, supported `relayMode`, `workspace`, and `irohTicket`; records missing those required reconnect fields are invalid and should not be dialed. Ordinary reconnect after app restart, network loss, or host restart with the same host state uses this saved-host data and does not require another QR scan. A saved-host client may synthesize a reconnect ticket for any registered workspace name it learned from verified host metadata; the host remains authoritative and rejects unknown names with `workspace_unregistered`, removed authorizations with `workspace_authorization_removed`, and registered names whose local directory is unavailable with `workspace_unavailable`.

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
| `conversation` | one mode required | Conversation stream target: `{ "target": "last" }`, `{ "target": "new" }`, or `{ "target": "session", "sessionId": "..." }`. |
| `workspaceDiscovery` | one mode required | Utility stream target. The only v1 payload is `{ "purpose": "list_sessions" }`. |
| `workspaceManagement` | one mode required | Utility stream target. The only v1 payload is `{ "purpose": "unregister_workspace" }`. |
| `secret` | no | Pairing secret when completing a pairing ticket. Omitted for already-paired clients. |
| `clientLabel` | no | Human-readable client label requested during pairing. |
| `clientNodeId` | no | Client-claimed node ID for diagnostics only. It is not authoritative. |

Mobile clients must include exactly one stream mode: `conversation`, `workspaceDiscovery`, or `workspaceManagement`. A `conversation.target:"session"` payload must include a strict lowercase remote session ID. `last` and `new` targets must not include a session ID. Discovery and management payloads reject unknown purposes and unexpected fields.

The authoritative client identity is the remote Iroh node ID observed by the host on the accepted connection, not `clientNodeId` from the hello. Unknown top-level hello fields are ignored.

The host responds with one UTF-8 JSON object followed by LF.

Success:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1"],"sessionId":"abc123","conversation":{"target":"last","sessionId":"abc123","selection":"resumed"},"child":"volt"}
```

Failure:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"client_unknown","hostNodeId":"<authoritative-host-node-id>","error":"client is not paired"}
```

On success, `hostNodeId` is the host's authoritative Iroh node ID and `clientNodeId` is the client's authoritative Iroh node ID observed by the host on the accepted connection. Stream-mode successes require `features` to include both `multi_streams.v1` and `conversation_streams.v1`. Conversation successes also require matching top-level `sessionId` and canonical `conversation.sessionId`, plus `conversation.target` and `conversation.selection` (`resumed`, `created`, `created_missing_last`, or `session_rekeyed`). A `session_rekeyed` selection is valid only for `conversation.target:"session"`, must include `conversation.requestedSessionId`, and means the requested session is an alias for the returned canonical session. Discovery and management successes include purpose metadata and no session metadata:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1"],"workspaceDiscovery":{"purpose":"list_sessions"}}
```

`child` is an implementation label for the host-side runtime and may be omitted. Failure responses include `hostNodeId` when the host identity is known. Failures after target resolution may include `workspace`, `sessionId`, and `retryAfterMs`; `error` is diagnostic text and should not drive app state.

Host handshake failure outcomes:

| Outcome | Meaning |
| --- | --- |
| `invalid_workspace` | The workspace field is malformed. |
| `invalid_conversation_target` | The stream mode, target, purpose, or session ID syntax is malformed or unsupported. |
| `conversation_streams_unsupported` | Reserved for hosts that cannot provide conversation-bound mobile streams. Current `volt remote host` builds are conversation-only. |
| `pairing_secret_expired` | The supplied pairing secret matches an expired pending ticket or retained expired tombstone. |
| `pairing_secret_consumed` | The supplied pairing secret matches a retained consumed tombstone and this client is not the paired recovery node. |
| `client_unknown` | The host does not know this client node ID and no active, expired, or consumed pairing secret applies. |
| `client_revoked` | The client node ID has a retained revocation tombstone and has not completed an approved re-pair. |
| `workspace_unregistered` | The requested workspace name is not registered in this host state. |
| `workspace_unavailable` | The requested workspace is registered but its local directory is not usable. |
| `workspace_authorization_removed` | The workspace exists but this client is no longer authorized for it. |
| `workspace_forbidden` | The workspace exists but this client is not allowed to use it. This is reserved for legacy or future per-client workspace restrictions. |
| `session_unavailable` | A strict `conversation.target:"session"` target does not resolve to an available session. |
| `duplicate_conversation_connection` | The same authoritative client already has an active stream for the resolved workspace/session. |
| `conversation_in_use` | Another authoritative client owns the active or retained runtime for the resolved workspace/session. |

Client-local reconnect outcomes are not sent by the host: `host_unreachable` means no usable transport/handshake could be opened, `host_identity_mismatch` means the reached Iroh node or handshake `hostNodeId` differs from the saved host identity, and `saved_host_invalid` means the local saved record is malformed or missing required v1 fields.

`client_revoked` remains authoritative for a revoked client node ID. A generic new pairing ticket does not let that same node silently return. The desktop host must first approve re-pair for the revoked node ID, then issue a fresh active pairing ticket; successful re-pair creates a new active client record and clears the revocation tombstone.

A successful pairing stores the client as authorized for the workstation represented by the host state file. That paired client can use any registered workspace name in that state file, including workspaces registered later, without scanning another QR. Revocation blocks that client node ID from every registered workspace. The client's persisted `allowedTools` grant applies across all selected workspaces; registering a workspace does not add built-in tools. The default built-in grant is `read,bash,edit,write,grep,find,ls,subagent`. When the persisted grant is the default built-in list, the host also exposes active tools registered by loaded extensions in the selected workspace.

A paired client may open multiple conversation streams, including multiple sessions in the same registered workspace. The identity key is authoritative client node ID, workspace name, and resolved session ID. If the same authoritative client opens the same workspace/session twice on one live Iroh connection, the host rejects the new stream and preserves the existing stream:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"duplicate_conversation_connection","hostNodeId":"<authoritative-host-node-id>","workspace":"volt","sessionId":"abc123","retryAfterMs":500,"error":"duplicate conversation connection"}
```

If the duplicate is the first conversation stream on a new Iroh connection from the same authoritative client, the host treats the previous active stream as stale, closes it with reason `replaced`, and accepts the new stream as the subscriber to the existing integrated runtime. If a different authoritative client owns the resolved workspace/session, the host rejects with `conversation_in_use` and includes the resolved workspace/session identity.

## Stream feature compatibility

`multi_streams.v1` and `conversation_streams.v1` are optional host features, not a protocol version bump. Mobile pinned-agent clients require both features on successful stream-mode handshakes. Missing or malformed feature metadata for those modes means the host is incompatible with conversation streams. Clients should keep the saved host and surface an update/integrated-host-required state rather than asking for another QR scan.

Missing stream features, `conversation_streams_unsupported`, `workspace_unavailable`, `workspace_unregistered`, `workspace_authorization_removed`, `session_unavailable`, `duplicate_conversation_connection`, and `conversation_in_use` are not QR re-pair requirements by themselves. `host_identity_mismatch`, malformed saved-host data, `client_unknown`, and `client_revoked` still require explicit Pair Again or Forget Host style UX.

## Reconnect and session selection

A reconnecting paired client with the same authoritative Iroh node ID selects a conversation in the handshake. `target:last` resumes the last recorded session for that workspace when the remembered ID is valid and the session file still exists; if the remembered ID is invalid or missing, the host creates a new session and reports `conversation.selection:"created_missing_last"` or `created`. `target:new` always creates a fresh session. `target:session` resumes a strict session ID, fails with `session_unavailable`, or returns `conversation.selection:"session_rekeyed"` with `conversation.requestedSessionId` when a live runtime has moved from the requested session to a canonical replacement session. Clients must validate state/transcript against the returned canonical `sessionId` and update the selected pin only after that validation commits.

Saved-host clients must verify that the native endpoint ticket node ID and the handshake `hostNodeId` match the saved host's `nodeId` before trusting authorization failures or refreshing non-secret discovery fields. If the reached identity differs, clients should treat the attempt as `host_identity_mismatch` and leave the saved host identity and discovery data unchanged.

Remote UI clients should request `get_state` followed by `get_transcript` after a conversation stream is accepted. New Agent and Resume Agent are not post-handshake mutations; clients open a new conversation stream with `target:new` or `target:session`. For older history, clients use `get_transcript` pagination (`hasMore` and `nextBeforeEntryId`) and request pages with `beforeEntryId`.

`get_state` responses for Iroh sessions include remote host metadata with the current workspace and the registered workspace names visible to the saved host:

```json
{
  "remoteHost": {
    "workspace": "volt",
    "workspaceNames": ["volt", "other-project"],
    "features": ["multi_streams.v1", "conversation_streams.v1"],
    "hostNodeId": "<authoritative-host-node-id>",
    "relayMode": "default",
    "hostName": "macstudio",
    "userName": "jordan",
    "cwd": "/workspace"
  }
}
```

`remoteHost.workspaceNames` contains names only, never host-local paths. `remoteHost.features` repeats the safe host feature strings advertised during handshake. Conversation clients must validate that the response `sessionId` and `remoteHost.workspace` match the handshake-bound stream identity. Selecting another pinned agent opens another conversation stream; v1 does not switch the cwd or session of an active stream in place.

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

`abort` is the only direct remote cancellation command in v1. Command names such as `cancel`, `cancel_run`, `detach`, and `disconnect` are not forwarded by the remote command allowlist. App-level disconnect without stop should close the stream only; clients reconnect by opening a new authorized stream, then calling `get_state` and `get_transcript`.

The integrated `volt remote host` runtime treats an authorized stream as a subscriber to host-owned session state. When the only subscriber detaches during active work, the prompt continues on the host. The same authoritative Iroh node ID, workspace, and session can reconnect to the detached runtime; `get_state.isStreaming` reports whether work is still active, and `get_transcript` recovers persisted output. Idle detached integrated runtimes are retained for 30 minutes by default, configurable with `--detached-runtime-ttl-ms`.

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
- `register_live_activity`
- `unregister_live_activity`
- `list_sessions`
- `extension_ui_response`

Conversation streams reject `new_session`, `switch_session_by_id`, and raw `get_messages` with `unsupported_remote_command`. Command-level `workspace`, `workspaceName`, or `sessionId` values on conversation commands are assertions only; values that do not match the stream-bound workspace/session fail with `session_mismatch`.

Workspace discovery streams accept only `list_sessions`. Any other valid RPC command receives `unsupported_on_workspace_discovery_stream`. Discovery streams create no conversation runtime and do not update last-session state.

Workspace management streams accept only `unregister_workspace`. Any other valid RPC command receives `unsupported_on_workspace_management_stream`. `unregister_workspace` must include a `workspaceName` matching the stream workspace and may not include extra fields.

All other command types receive a JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process. This includes local-only subagent lifecycle commands such as `list_subagents`, `subagent_start`, `subagent_abort`, `subagent_get_state`, `subagent_get_transcript`, and `subagent_dispose`. Within the remote surface, only `abort` is a direct cancellation command.

`register_push_target` registers mobile-issued relay credentials with the host. The client must first register its raw FCM token with the Volt push relay; it must not send that raw FCM token to the desktop host. The host persists the relay target id and target-scoped auth token so it can notify the phone after the Iroh stream detaches. When an ActivityKit push token is available, the same command may include a `liveActivity` delivery channel containing the raw ActivityKit token plus its lowercase SHA-256 hash; the host stores that channel so it can ask the relay to update the Live Activity later. `relayUrl` is accepted as app registration metadata, but host delivery uses the desktop host's configured relay URL (`--push-relay-url` / `VOLT_PUSH_RELAY_URL`) and does not let clients redirect delivery:

```json
{
  "id": "push-1",
  "type": "register_push_target",
  "args": {
    "provider": "fcm",
    "platform": "ios",
    "pushTargetId": "<relay-target-id>",
    "pushTargetAuthToken": "<relay-target-auth-token>",
    "relayUrl": "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay",
    "tokenHash": "sha256:<fcm-token-hash>",
    "enabled": true,
    "liveActivity": {
      "activityId": "activity-one",
      "pushToken": "<activitykit-push-token-hex>",
      "tokenEnvironment": "production",
      "tokenHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }
}
```

The successful response is:

```json
{"id":"push-1","type":"response","command":"register_push_target","success":true,"data":{"status":"registered","pushTargetId":"<relay-target-id>"}}
```

`register_live_activity` binds an ActivityKit Live Activity to the current conversation stream. The app sends the activity identity and a lowercase SHA-256 token hash that references the previously acknowledged `register_push_target.args.liveActivity` delivery channel. It does not repeat the raw ActivityKit push token in `register_live_activity`:

```json
{
  "id": "live-1",
  "type": "register_live_activity",
  "workspaceName": "volt",
  "sessionId": "abc123",
  "activityId": "activity-one",
  "platform": "ios",
  "tokenEnvironment": "production",
  "tokenHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The host validates that `workspaceName` and `sessionId` match the bound stream, validates the activity payload, resolves `tokenHash` through the existing ActivityKit delivery channel for the authoritative client, and returns stable errors such as `session_mismatch`, `invalid_live_activity_registration`, `invalid_live_activity_token`, or `unknown_live_activity_token`. `unregister_live_activity` uses the same stream-bound workspace/session/activity identity without a token hash and is idempotent for the matching registration.

Completion notifications sent through the relay, or over JSONL as `notification_request` when no push target is available, include the safe workspace name when the host knows it:

```json
{"type":"notification_request","eventId":"conversation:session-one:run-one:completed","kind":"conversation_completed","title":"Volt finished in volt-app","body":"Your conversation is ready.","sessionId":"session-one","workspace":"volt-app"}
```

The `workspace` field is a registered workspace name only. It must never contain a host-local path.

`unregister_workspace` on a workspace management stream removes a registered workspace name from the host state file without deleting files:

```json
{"id":"unregister-1","type":"unregister_workspace","workspaceName":"old-workspace"}
```

The host rejects missing or malformed names, names that do not match the management stream workspace, and unknown workspaces. A successful response includes refreshed safe workspace metadata when available:

```json
{"id":"unregister-1","type":"response","command":"unregister_workspace","success":true,"data":{"removedWorkspace":"old-workspace","workspaceNames":["volt"]}}
```

This command is host-state metadata management only. It does not create, rename, browse, path-map, or delete host workspace directories, and response data must contain registered names and availability statuses only, never host-local paths.

`get_ui_capabilities`, `get_ui_actions`, `get_ui_action_completions`, and `invoke_ui_action` expose the v1 native UI action protocol for the narrow remote-safe action set. Remote `get_ui_capabilities` advertises `ui_action_invocation.v1` only when the host accepts invocation and `ui_action_completions.v1` when action argument completions are available. Descriptor responses omit prompt bodies, skill content, raw `sourceInfo`, extension source paths, prompt and skill file paths, skill base directories, host session files, provider metadata, and secrets. They still pass through the outbound path handling layer below before being written to the remote stream.

Remote `get_ui_action_completions` and `invoke_ui_action` are allowlist-based. V1 forwards exact reviewed built-in ids `session.new`, `run.cancel`, `thinking.fast_mode`, `review.uncommitted`, and `review.branch`, plus projected dynamic action ids under `extension.command.*`, `prompt.template.*`, and `skill.*`; the host still resolves the current action catalog, rechecks action availability and remote safety, validates arguments, confirms remote review requests, and applies streaming policy at invocation time. Local-only built-ins such as `context.compact` and `session.rename`, deferred review/model actions such as `review.pr`, `review.commit`, and `review.tools`, stale ids, malformed ids, and unreviewed action id prefixes receive a normal JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process.

Remote clients should use `get_ui_actions` rather than `get_commands` to build native Actions pages and command palettes. `primary` descriptors are the host-curated card/button/toggle surface. `palette` descriptors are searchable compatibility actions for extension commands, prompt templates, and skills. Slash aliases in descriptors are display hints and compatibility metadata; action ids are the invocation contract.

Projected extension command, prompt-template, and skill actions execute through the host's existing prompt/command expansion path. Extension UI requests raised during those commands continue to use the existing `extension_ui_request` / `extension_ui_response` protocol. RPC-degraded extension UI methods keep the behavior documented in [RPC mode](rpc.md#extension-ui-protocol); Iroh does not add terminal-only UI support.

Remote review descriptors expose only bounded card metadata. Review invocation responses do not include raw diffs, GitHub metadata, configured review model values, auth state, or raw tool output. While review runs, the host may emit `workflow_start`, sanitized workflow-scoped `tool_execution_start`/`tool_execution_end`, `workflow_update`, and `workflow_end` events so clients can render a live progress timeline. These activity events include bounded tool names and arguments only; raw read contents, grep output, review prompts, and diffs remain hidden. The remote review workflow uses the host-owned read-only review tool set (`read`, `grep`, `find`, `ls`) and creates a fresh session seeded with findings when the review completes.

Remote Fast mode descriptors expose only bounded toggle metadata and current boolean state. `thinking.fast_mode` invocation accepts a boolean `enabled` argument, changes only the current session's thinking level without persisting defaults or switching models, and returns updated action state. Direct model and thinking RPC commands, including `get_available_models`, `set_model`, `set_thinking_level`, and `cycle_thinking_level`, remain outside the remote allowlist.

First-class extension-provided native cards, persisted chat/global Fast mode defaults, remote model selection, profile switching, scoped-model editing, package management, provider login/logout, and project settings mutation are deferred. They require separate host-owned policy, storage, descriptor, and allowlist work before they can be exposed over Iroh.

The preview RPC surface intentionally stays narrow. It excludes local tools such as `bash`, `edit`, and `write`; those tools can only be used through the normal model/tool flow and host-side permission policy. It also excludes read-only local RPC commands such as `get_messages`, `get_commands`, `get_last_assistant_text`, and `get_available_models` for v1 preview.

The path-based `switch_session` command remains blocked remotely, and mobile conversation streams also reject direct `switch_session_by_id`; clients select another session by opening a new `conversation.target:"session"` stream. `get_transcript` is the remote-safe transcript read: it returns only the bound session's projected user, assistant, tool-summary, and compaction-summary items, ordered oldest-to-newest, with server-bounded page sizes. Host session file paths, raw `get_messages` payloads, thinking blocks, raw tool output, full file contents, provider payloads, and extension-private custom data are not returned. Transcript path and text fields still pass through the outbound redaction layer below.

- `get_messages` can return the full raw transcript, including prompts, tool output, file excerpts, provider payloads, and extension content beyond the projected transcript needed for reconnect.
- `get_commands` exposes installed extension, prompt-template, and skill metadata; remote clients must use the sanitized `get_ui_actions` discovery surface instead.
- `get_last_assistant_text` duplicates streamed assistant output and is superseded remotely by the projected transcript surface.
- `get_available_models` exposes provider/model availability while remote model selection remains unsupported.
- `set_model`, `set_thinking_level`, and `cycle_thinking_level` directly mutate local model/thinking state; remote clients must use reviewed native actions such as `thinking.fast_mode` instead.

Tool access and RPC command access are separate surfaces. `allowedTools` controls which listed built-in or extension tools the host-side model may invoke, with active extension tools also exposed for the default built-in grant; this allowlist controls which JSONL commands a remote client may send directly.

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

The remaining dedicated placeholders are part of the v1 compatibility surface. Clients must display them as opaque strings and must not assume that a redacted path can be expanded locally.
