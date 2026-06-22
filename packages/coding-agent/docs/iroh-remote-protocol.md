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

A reconnecting paired client with the same authoritative Iroh node ID resumes the last recorded Volt session for that workspace when the session file still exists. If the recorded session is missing, the host creates a new session, records it for future reconnects, and reports the active `sessionId` through `get_state`. V1 does not replay live stream deltas; clients recover by reconnecting, calling `get_state`, and continuing from the persisted session state.

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
- `get_state`
- `extension_ui_response`

All other command types receive a JSONL `response` with `success:false` and are not forwarded to the local Volt RPC process.

The preview RPC surface intentionally stays narrow. It excludes local tools such as `bash`, `edit`, and `write`; those tools can only be used through the normal model/tool flow and host-side permission policy. It also excludes read-only local RPC commands such as `get_messages`, `get_commands`, `get_last_assistant_text`, and `get_available_models` for v1 preview:

- `get_messages` can return the full transcript, including prompts, tool output, file excerpts, and extension content beyond the minimal state needed for reconnect.
- `get_commands` exposes installed extension, prompt-template, and skill metadata; slash-command use should go through `prompt` until the remote UI command surface is reviewed separately.
- `get_last_assistant_text` duplicates streamed assistant output and would expose prior-session text without a settled transcript-access policy.
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
