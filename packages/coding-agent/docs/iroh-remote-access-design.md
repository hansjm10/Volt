# Iroh Remote Access Design

## Status

The Iroh remote host is a supported preview for Node.js npm installs and source checkouts with optional `@number0/iroh` available for the platform. RPC mode has a transport abstraction, Iroh streams have a structurally typed RPC adapter, remote command filtering is available, and the Iroh remote helpers cover tickets, handshakes, host state, authorization, workspace selection, audit logging, redaction, reconnect/session selection, revocation, and host/client engine orchestration. `volt remote host` launches a product host entrypoint in the coding-agent package and runs Volt's runtime in-process over `runIrohRemoteRpcMode()`. The preview wire contract is documented in [Iroh Remote Protocol v1](iroh-remote-protocol.md). Unsupported areas remain explicit: Bun binary builds reject remote host startup, `volt remote status` is persisted-state-only, cross-network relay should be validated with `--relay default` in the target environment, and mobile UI/product work is outside this host preview.

## Summary

Add optional remote access that exposes Volt's existing RPC protocol over [Iroh](https://www.iroh.computer/blog/v1). The native `@number0/iroh` dependency is optional in the coding-agent package, while Volt core provides the typed transport, handshake, state, authorization, audit, redaction, reconnect, revocation, and engine helpers needed for the integrated remote mode.

This turns Volt into a remotely reachable local coding agent without requiring users to open ports, configure reverse proxies, or move provider credentials to a mobile client. A future iOS app can use Iroh Swift support to connect to the user's host machine and render a native UI from RPC events.

## Background

Volt already has three relevant layers:

- `AgentSession` and the SDK for embedding Volt in Node.js applications.
- RPC mode (`volt --mode rpc`) for language-agnostic clients over LF-delimited JSONL.
- Extension UI requests in RPC mode, so remote clients can respond to confirmation, input, and selection prompts.

Iroh v1 provides key-based dialing, encrypted QUIC connections, NAT traversal, local-first discovery, relay fallback, and stable v1 wire compatibility. The v1 announcement also calls out official Rust, Node.js, Swift, Kotlin, and Python support, which matches a host-side native daemon plus future mobile clients.

## Goals

- Enable remote access to a local Volt session from another device without port forwarding.
- Keep model credentials, repository files, and tool execution on the host machine.
- Reuse Volt RPC as the application protocol instead of inventing a new agent protocol.
- Keep the native Iroh dependency optional while sharing remote protocol logic through core helpers.
- Define a security model before exposing shell/file tools remotely.

## Non-goals

- No TUI tunneling.
- No mobile app implementation in the host preview.
- No built-in sandbox. Remote Volt has the same local-agent risks described in [Security](security.md).
- No mandatory native dependency; `@number0/iroh` remains optional and remote host startup reports missing or unsupported native installs explicitly.
- No multi-user collaboration semantics in the host preview.

## Current State

RPC mode defaults to process stdin/stdout:

```text
client process
  -> JSONL stdin
volt --mode rpc
  -> JSONL stdout
```

The RPC implementation now accepts a core transport abstraction, so stdin/stdout is one adapter. `volt remote host` uses the in-process Iroh RPC adapter for the integrated host path and can still spawn fake or compatibility RPC children for tests.

## Architecture

```mermaid
flowchart LR
    Mobile[iOS / desktop client] -->|Iroh QUIC stream| Host[volt remote host]
    Host --> Runtime[Volt RPC runtime]
    Runtime --> Files[Workspace files]
    Runtime --> Tools[Local tools and shell]
    Runtime --> Auth[Host Volt auth]
```

The product host entrypoint owns native Iroh endpoint lifecycle through an isolated adapter module. Volt core owns shared remote protocol behavior: pairing tickets, handshake parsing, bounded handshake reads, host state management, client authorization, audit events, workspace selection, remote command filtering, and in-process RPC transport adapters. The host can still spawn child RPC processes for fake-RPC and compatibility tests, but the integrated path calls `runIrohRemoteRpcMode()` directly.

## Minimal Remote Host

### Host command

```bash
volt remote host --workspace volt=C:\Users\Jordan\source\repos\Volt
```

The host process:

1. Creates or loads a persistent Iroh endpoint key. The current host stores this as `hostSecretKey` in `~/.volt/agent/remote/iroh-host.json`.
2. Validates the selected workspace path, plus any requested child RPC executable before printing a ticket.
3. Starts an Iroh endpoint. The current host defaults to disabled relay for local tests; `--relay default` opts into Iroh's default relay/discovery preset.
4. Prints a pairing ticket as text.
5. Accepts client connections until stopped, or exits after the first disconnect when `--once` is set.
6. Validates the pairing secret.
7. Runs Volt in-process by default, or spawns the configured RPC child in the selected workspace for compatibility and fake-RPC tests.
8. Pipes Iroh stream bytes to the selected RPC runtime.
9. Writes host diagnostics and prefixed child stderr, when a child process is used, to stderr.

### Example client command

```bash
npm run iroh:poc:client -- "<pairing-ticket>"
```

The client process:

1. Opens an Iroh endpoint.
2. Dials the host ticket.
3. Sends a JSON handshake containing the pairing secret, requested workspace name, client label, and protocol version.
4. Sends normal Volt RPC JSONL commands after the host accepts.
5. Renders RPC events in a minimal terminal UI or prints text deltas for the demo client.

### Pairing ticket shape

The supported preview ticket format and compatibility rules are specified in [Iroh Remote Protocol v1](iroh-remote-protocol.md). Use an opaque URL-safe payload so the format can change:

```text
volt+iroh://v1/<base64url-json>
```

Initial ticket payload fields:

```json
{
  "nodeId": "<iroh-node-id>",
  "irohTicket": "<iroh-endpoint-ticket>",
  "relayMode": "disabled",
  "workspace": "volt",
  "secret": "<one-time-secret>",
  "expiresAt": 1790000000000,
  "alpn": "volt-rpc/0"
}
```

The host must treat the ticket secret as one-time. After successful pairing, persist the client node ID and require that ID for later connections.

### Stream protocol

The supported preview stream handshake, strict LF framing, command allowlist, authoritative identity rules, and outbound redaction guarantees are specified in [Iroh Remote Protocol v1](iroh-remote-protocol.md). After the handshake succeeds, the stream carries the same LF-delimited JSONL described in [RPC mode](rpc.md). The current host parses command envelopes only to enforce the remote command filter, track connection-level shutdown, and preserve response completion behavior. It should preserve strict LF framing and not use generic line readers that split on Unicode separators.

### Process model

Preview process model:

- One Iroh connection maps to one in-process Volt RPC runtime by default.
- One workspace per runtime.
- The runtime is disposed when the Iroh connection closes.
- Compatibility and fake-RPC modes can still spawn a child process, and the host terminates that child on disconnect after a short grace period.
- Reconnecting paired clients resume the last recorded session for that workspace when the session file still exists. If it is missing, the host creates and audits a replacement session.
- A second active stream for the same authoritative client node ID and workspace is rejected with handshake error `client already connected`; the existing runtime remains active.

## Security Model

Remote access to Volt is remote access to local files, shell commands, provider credentials, extensions, and project toolchains. The supported preview is explicit about that risk.

Required controls for preview:

- Opt-in only. No listener starts unless the user runs the host command.
- Explicit pairing using a one-time secret.
- Persistent allowlist of paired client node IDs.
- Workspace allowlist. Remote clients choose from names, not arbitrary host paths.
- Client revocation command.
- Host-side audit log for connections, workspace selection, child process start/stop, and rejected attempts.
- No automatic `--approve`. Project trust should inherit existing Volt behavior unless the host user explicitly approves a workspace.
- Clear warning that `bash`, `write`, and `edit` allow remote modification of the host machine.

Preview safety default:

```bash
volt remote host --workspace volt=. --allow-tools read,grep,find,ls
```

Granting write or shell tools requires explicit host approval. TTY host and pair commands prompt before accepting `bash`, `edit`, or `write`; noninteractive flows must pass `--yes`:

```bash
volt remote host --workspace volt=. --allow-tools read,grep,find,ls,bash,edit,write --yes
volt remote pair --workspace volt --allow-tools read,grep,find,ls,bash --yes
```

Remote sessions do not auto-approve project trust. Pass `--approve` only when the host user trusts project-local settings/resources for the exposed workspace.

## Configuration

Default host state and audit paths:

```text
~/.volt/agent/remote/iroh-host.json
~/.volt/agent/remote/iroh-host.audit.jsonl
```

Suggested shape:

```json
{
  "hostName": "home-desktop",
  "workspaces": [
    { "name": "volt", "path": "C:\\Users\\Jordan\\source\\repos\\Volt" }
  ],
  "clients": [
    {
      "nodeId": "<client-node-id>",
      "label": "Jordan iPhone",
      "allowedWorkspaces": ["volt"],
      "allowedTools": "read,grep,find,ls"
    }
  ]
}
```

The host state file also persists `hostSecretKey`, consumed pairing secret hashes, pending pairing ticket hashes plus non-secret metadata, and per-client last session IDs. It does not persist raw pairing secrets. `volt remote status` prints a secret-free persisted-state view. Preview does not store relay mode in the persisted state; the running host owns the live relay mode, tickets include a relay hint, and `volt remote pair --relay <disabled|default>` can be used as an expected-live-mode check when needed.

## CLI UX

Supported preview commands:

```bash
# Start a host for one saved workspace.
volt remote host --workspace volt=/path/to/repo --allow-tools read,grep,find,ls

# Ask the running host for a short-lived one-time pairing ticket.
volt remote pair --workspace volt

# Inspect and manage persisted state.
volt remote status
volt remote clients
volt remote revoke <node-id>

# Demo client used by the source checkout examples.
npm run iroh:poc:client -- "<ticket>" --get-state
```

`volt remote pair` is mediated by the running host control channel because offline tickets made only from persisted state are not dialable. To change an existing client's tool policy in preview, revoke that client and pair it again with the desired `--allow-tools`; there is no in-place policy update command.

## Implementation Plan

### Phase 0: External sidecar, no Volt core changes

- Create a separate exploratory host/client package or repository.
- Use Iroh's stable Rust API first, or verify the Node.js binding API and use it if it is mature enough for the bridge.
- Spawn the installed `volt` binary with `--mode rpc`.
- Bridge bytes with backpressure handling.
- Support one workspace, one client, one session.
- Demonstrate prompt, streaming output, abort, model list, and read-only tools.

### Phase 1: Monorepo experiment

- Add an example under `packages/coding-agent/examples/remote/iroh-sidecar/` if the external exploration is successful.
- Keep native dependencies isolated until the optional dependency strategy is proven.
- Document setup, pairing, and security warnings.

### Phase 2: RPC transport and remote core extraction

Status: mostly complete.

Build on the core RPC transport abstraction so stdin/stdout remains one adapter:

```typescript
interface RpcTransport {
  write(value: object): Promise<void> | void;
  onLine(handler: (line: string) => void): () => void;
  close(): Promise<void> | void;
}
```

Then add adapters:

- stdio adapter for current `volt --mode rpc`.
- in-process adapter for SDK consumers.
- Iroh adapter if native dependency strategy is acceptable.

Current Volt core also includes typed Iroh remote helpers for ticket encoding/decoding, bounded handshakes, host state, authorization, audit logging, workspace management, pair/list/revoke operations, command filtering, and host/client engine orchestration. The product host entrypoint is the native dependency integration point while those core APIs harden.

### Phase 3: Productized remote mode

- Add `volt remote ...` commands.
- Add reconnect/resume semantics.
- Add remote-safe response filtering where needed, such as hiding full host session paths from untrusted clients.
- Add mobile-oriented event batching and attachment transfer.
- Consider Iroh blobs for large images, logs, or session exports.

## Testing and Validation

Preview validation:

- Pair a client and host on the same LAN.
- Pair a client and host across different networks using `--relay default` relay/discovery.
- Send allowed remote RPC commands such as `get_state`, `prompt`, `abort`, `steer`, `follow_up`, and `extension_ui_response`.
- Verify assistant streaming events arrive in order.
- Verify extension UI requests can round-trip through the client.
- Verify child process exits when the Iroh stream closes.
- Verify unpaired clients are rejected.
- Verify a missing workspace path or Volt executable fails before printing a pairing ticket.
- Verify a client cannot request a workspace outside the host allowlist.

Automated tests for a monorepo version:

- Unit-test handshake parsing, ticket expiry, and client allowlist checks.
- Unit-test JSONL bridging with embedded `U+2028` and `U+2029` inside JSON strings.
- Integration-test the remote host bridge against a fake child process before testing against Volt RPC.
- Integration-test against Volt's faux provider from the coding-agent test harness where possible.

## Risks

| Risk | Mitigation |
| --- | --- |
| Remote access exposes local shell and filesystem | Opt-in host command, read-only tool default, workspace allowlist, client revocation, clear warnings |
| Native dependency increases install complexity | Keep `@number0/iroh` optional, keep native loading isolated from the main CLI, document native install troubleshooting, and reject Bun binary remote host startup with an actionable Node/source guidance message |
| Mobile networks disconnect often | Preview reconnect resumes the last recorded session when present and creates/audits a replacement when missing |
| RPC responses expose host paths | Remote-safe outbound filtering normalizes workspace paths and redacts host-only session, export, bash-output, and arbitrary absolute paths |
| Relay fallback may add latency or cost | Prefer direct connections, expose connection diagnostics, allow custom relay config later |
| Project extensions can run arbitrary code | Preserve project trust behavior and do not auto-approve remote workspaces |

## Future Product Questions

These are outside the host preview support boundary:

- Should the long-term host remain a Node.js package using Iroh Node bindings, or add a Rust/native sidecar?
- How should mobile clients display and approve extension UI prompts?
- Should sessions created over remote access be tagged as remote in session metadata?

Resolved preview decisions:

- Remote clients are read-only by default (`read,grep,find,ls`) and keep their pair-time tool grant on reconnect.
- Remote outbound state/events normalize workspace paths to `/workspace` and redact host-only session, export, bash-output, and arbitrary absolute host paths.
- Pairing is workspace-bound by saved workspace name; clients cannot request arbitrary host paths.

## References

- [Iroh 1.0 announcement](https://www.iroh.computer/blog/v1)
- [RPC mode](rpc.md)
- [SDK](sdk.md)
- [Security](security.md)
