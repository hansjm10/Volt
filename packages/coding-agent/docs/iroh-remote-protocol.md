# Iroh Remote Protocol v1

Iroh remote access tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream. The host runs on the user's machine; clients dial a ticket, send one handshake line, then exchange the same LF-delimited RPC messages documented in [RPC mode](rpc.md), subject to the remote command allowlist below.

This protocol is preview-stable for external client authors. Clients must reject unsupported required values, ignore unknown fields unless this document says otherwise, and treat secrets as one-time credentials.

For user-facing setup, run `volt remote host` on a trusted host workspace, create tickets with `volt remote pair`, inspect `volt remote status`, and revoke clients with `volt remote revoke <node-id>`. The host-side management workflow, state/audit paths, unsafe tool warnings, relay mode, and Node-only/Bun-binary limitation are documented in [Using Volt](usage.md#remote-access-over-iroh-preview) and [Security](security.md#remote-access-over-iroh-preview). This document defines the wire contract only.

## Version and ALPN

- Ticket prefix: `volt+iroh://v1/`
- ALPN: `volt-rpc/0`
- Handshake type: `volt_iroh_hello`
- Handshake response type: `volt_iroh_handshake`

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
| `workspace` | yes | Workspace label requested by the client. The host still authorizes against its persisted workspace binding. |
| `secret` | no | One-time pairing secret. Present only in pairing tickets. Persisted host state stores only a hash. |
| `expiresAt` | no | Unix epoch milliseconds after which the pairing secret is invalid. |
| `nodeId` | no | Host node ID hint for display and diagnostics. The native Iroh ticket remains the dial authority. |
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

## Stream handshake

After opening an Iroh bidirectional stream, the client writes one UTF-8 JSON object followed by LF (`\n`):

```json
{"type":"volt_iroh_hello","protocol":"volt-rpc/0","workspace":"volt","secret":"<one-time-pairing-secret>","clientLabel":"Jordan iPhone","clientNodeId":"<claimed-client-node-id>"}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Must be `volt_iroh_hello`. |
| `protocol` | yes | Must be `volt-rpc/0`. |
| `workspace` | yes | Workspace label requested by the client. |
| `secret` | no | Pairing secret when completing a pairing ticket. Omitted for already-paired clients. |
| `clientLabel` | no | Human-readable client label requested during pairing. |
| `clientNodeId` | no | Client-claimed node ID for diagnostics only. It is not authoritative. |

The authoritative client identity is the remote Iroh node ID observed by the host on the accepted connection, not `clientNodeId` from the hello. Unknown hello fields are ignored.

The host responds with one UTF-8 JSON object followed by LF.

Success:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","clientNodeId":"<authoritative-client-node-id>","child":"volt"}
```

Failure:

```json
{"type":"volt_iroh_handshake","success":false,"error":"client is not paired"}
```

On success, `clientNodeId` is authoritative and comes from the host's accepted Iroh connection. `child` is an implementation label for the host-side child process and may be omitted. Unknown handshake response fields are ignored.

A paired client may have only one active connection per workspace in v1 preview. If the same authoritative client node ID connects to the same workspace while a previous connection is still active, the host rejects the new stream with a normal handshake failure response whose `error` is `client already connected`; the existing connection remains active.

## Reconnect and session selection

A reconnecting paired client with the same authoritative Iroh node ID resumes the last recorded Volt session for that workspace when the session file still exists. If the recorded session is missing, the host creates a new session, records it for future reconnects, and reports the active `sessionId` through `get_state`. Clients may start a fresh conversation on the active stream with the `new_session` RPC command, list current-workspace sessions with `list_sessions`, or resume another current-workspace session with `switch_session_by_id`; the host records the active `sessionId` for future reconnects after new-session and switch operations. V1 does not replay live stream deltas; clients recover by reconnecting, calling `get_state` and `get_transcript`, and continuing from the persisted session state.

Remote UI clients should request `get_state` followed by `get_transcript` after connect/reconnect, and after a successful `switch_session_by_id` should show a loading transcript state while refreshing state and transcript for the selected session. After `new_session`, clients should keep a fresh empty transcript and refresh state without requesting older transcript from the previous session. For older history, clients use `get_transcript` pagination (`hasMore` and `nextBeforeEntryId`) and request pages with `beforeEntryId`.

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

The default integrated `volt remote host` runtime treats an authorized stream as a subscriber to host-owned session state. When the only subscriber detaches during active work, the prompt continues on the host. The same authoritative Iroh node ID and workspace can reconnect to the detached runtime; `get_state.isStreaming` reports whether work is still active, and `get_transcript` recovers persisted output. Idle detached integrated runtimes are retained for 30 minutes by default, configurable with `--detached-runtime-ttl-ms`.

Compatibility modes that spawn `volt --mode rpc` through `--use-volt` or `--source-volt` remain connection-scoped. A disconnect can terminate the spawned child and any in-memory active work unless a future persistent child registry is added. Mobile clients that depend on detach/reconnect during active work should use the integrated host path.

Host process exit, host crash, or explicit host shutdown are separate from client detach and can stop in-memory work because the runtime is gone. A reconnect after host exit requires a new host process and can recover only persisted session state.

## JSONL framing

All post-handshake traffic is Volt RPC JSONL:

- Each message is one JSON value encoded as UTF-8 and terminated by LF (`\n`).
- Split only on LF byte `0x0a`. Do not treat CR, Unicode line separator U+2028, or Unicode paragraph separator U+2029 as frame terminators.
- Bytes after the hello LF are preserved as initial RPC input. Clients may pipeline the first RPC request immediately after the hello line.
- Overlong or unterminated handshake lines are rejected before any RPC is forwarded.

## Remote RPC command allowlist

The host forwards only these inbound RPC command `type` values from remote clients:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `new_session`
- `get_state`
- `get_transcript`
- `list_sessions`
- `switch_session_by_id`
- `extension_ui_response`

All other command types receive a JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process. Within this allowlist, only `abort` is a direct cancellation command.

The preview RPC surface intentionally stays narrow. It excludes local tools such as `bash`, `edit`, and `write`; those tools can only be used through the normal model/tool flow and host-side permission policy. It also excludes read-only local RPC commands such as `get_messages`, `get_commands`, `get_last_assistant_text`, and `get_available_models` for v1 preview:

The path-based `switch_session` command remains blocked remotely; remote clients must use workspace-scoped `switch_session_by_id` instead. `get_transcript` is the remote-safe transcript read: it returns only the active session's projected user, assistant, tool-summary, and compaction-summary items, ordered oldest-to-newest, with default limit 100 and server cap 200. Host session file paths, raw `get_messages` payloads, thinking blocks, raw tool output, full file contents, provider payloads, and extension-private custom data are not returned. Transcript path and text fields still pass through the outbound redaction layer below.

- `get_messages` can return the full raw transcript, including prompts, tool output, file excerpts, provider payloads, and extension content beyond the projected transcript needed for reconnect.
- `get_commands` exposes installed extension, prompt-template, and skill metadata; slash-command use should go through `prompt` until the remote UI command surface is reviewed separately.
- `get_last_assistant_text` duplicates streamed assistant output and is superseded remotely by the projected transcript surface.
- `get_available_models` exposes provider/model availability while remote model selection remains unsupported.

Tool access and RPC command access are separate surfaces. `allowedTools` controls which tools the host-side model may invoke; this allowlist controls which JSONL commands a remote client may send directly.

## Outbound redaction guarantees

Before host RPC output is sent to the remote stream, Volt sanitizes host-local paths while preserving remote-meaningful workspace paths:

- Paths under the hosted workspace are rewritten under `/workspace`.
- Host-local paths outside the workspace are replaced with `[redacted host path]`.
- Export paths are redacted. Recognized export path occurrences and structured path fields use `[redacted export path]`; unrecognized host-local path fields use `[redacted host path]`.
- Session files are omitted or replaced with `[redacted session file]`.
- Bash output file paths are omitted or replaced with `[redacted bash output path]`.
- Redaction applies to responses, extension UI requests, assistant content, tool-call arguments, and plain-text fallback lines.
- Opaque model/provider data such as image base64 payloads and signature fields are preserved, while adjacent text and structured arguments are still sanitized.

These placeholders are part of the v1 compatibility surface. Clients must display them as opaque strings and must not assume that a redacted path can be expanded locally.
