# Iroh Host Detach and Cancel Semantics Design

## Status

Proposed.

## Context

Manual iOS validation on 2026-06-22 used:

- Device: iPhone 16 Pro
- iOS: 26.2
- Network: Wi-Fi
- Host: macOS 27 beta
- Iroh relay mode: default

Observed behavior:

- Test 1: backgrounding and foregrounding with no active prompt auto-reconnected successfully and preserved the same session/transcript context.
- Test 2: backgrounding during an active prompt appeared to stop prompt progress after the app disconnected from the host.

This points at a host lifecycle issue more than an app transcript issue. The app can lose a foreground network stream because iOS suspends or kills background activity; from the host perspective that usually looks like stream EOF, connection close, or a write failure. It is not a reliable semantic signal that the user wanted the active prompt cancelled.

## Current Host Behavior

Current host code has useful pieces, but they are still connection-scoped:

- `runIrohRemoteRpcMode()` wraps Iroh RPC with close deferral so clean stream close can wait for accepted prompt completion before reporting close to `runRpcMode`.
- `runRpcMode()` treats transport close as mode shutdown. Shutdown unsubscribes session listeners, disposes the runtime, and closes the transport.
- `AgentSession.dispose()` aborts retry, compaction, branch summary, bash, and the underlying agent.
- `abort` is an explicit RPC command that calls `session.abort()` and waits for idle.
- `packages/coding-agent/src/remote/iroh-host.mjs` creates an integrated Volt runtime per accepted Iroh connection in `runIntegratedVoltConnection()`. When the stream ends, the connection handler exits and the runtime is stopped/disposed.
- Spawned RPC-child mode also kills the child when the remote connection ends.

The net effect is that transport lifetime and run lifetime are still coupled. A mobile disconnect can therefore stop a prompt even when the app did not send `abort`.

## Problem

Remote clients need robust mobile behavior:

- iOS background suspension, app process death, Wi-Fi blips, relay churn, and clean stream EOF must not be interpreted as user cancellation.
- A user-visible cancel/stop action must still cancel promptly.
- Reconnect must show the current run/session state and recover the transcript that was produced while detached.
- Host process exit, host crash, or explicit host shutdown are different from client detach and can remain a documented limitation unless durable job recovery is added.

## Core Principle

Connection lifecycle is not run lifecycle.

A remote stream is a subscriber/control channel. A prompt run belongs to the host session. Losing a subscriber detaches the client; only an explicit semantic command cancels the run.

## Terms

- **Transport close**: Iroh stream EOF, QUIC connection close, socket end, input stream close, or write failure.
- **Detach**: a client is no longer connected to a session/run but did not ask to cancel it.
- **Cancel**: an explicit user or client command that should stop active work. Today this is `abort`; a future alias may be `cancel_run`.
- **Host process exit**: the host process or Volt runtime actually exits or crashes. This cannot continue in-memory work unless durable run recovery exists.
- **Subscriber**: an active RPC stream receiving session events and sending commands for a host session.

## Goals

- Define host behavior so a remote disconnect during active work is detach-only by default.
- Preserve the existing explicit `abort` RPC semantics as terminal cancellation.
- Keep the iOS app simple: it does not need to send a best-effort detach command before suspension.
- Allow reconnect to reattach to the active session and recover state/transcript.
- Keep the remote security boundary from the transcript-resume work: no raw session files, no raw `get_messages`, and no host-local path leakage over Iroh.
- Add automated coverage for active-run disconnect, explicit cancel, reconnect, and transcript catch-up.
- Keep spawned child mode behavior explicit, even if the first implementation focuses on integrated Volt runtime.

## Non-goals

- Do not implement full host crash recovery in this phase.
- Do not replay every historical streaming delta after reconnect.
- Do not make iOS background execution reliable for indefinite work. The host must tolerate app loss.
- Do not introduce multi-user collaborative editing semantics.
- Do not expose raw internal agent state or unrestricted session files to remote clients.
- Do not make transport EOF a required app-side signal. iOS may not get time to send anything.

## Target Semantics

### Disconnect Matrix

| Event | Host interpretation | Active prompt behavior | Reconnect behavior |
| --- | --- | --- | --- |
| iOS enters background and stream closes | Detach | Continue running | Same client reattaches to active session |
| App process killed or network lost | Detach | Continue running until completion or TTL/policy | Same client calls `get_state` and `get_transcript` |
| User taps app-level disconnect without stop | Detach | Continue running | User may reconnect later |
| User taps stop/cancel | Explicit cancel via `abort` | Stop promptly | State shows idle/cancelled result where available |
| Host `volt remote host` exits | Host shutdown | In-memory work stops | Reconnect requires a new host process; persisted transcript only |
| Host revokes client | Administrative close | Policy decision; default should close connection, not necessarily cancel a run unless the run is owned only by that client and policy says so | Revoked client cannot reconnect |
| Detached-run TTL expires | Host policy timeout | Cancel or stop according to documented TTL policy | Reconnect sees stopped/expired state |

### RPC Contract

Existing `abort` remains the semantic cancellation command:

```json
{"id":"cancel-1","type":"abort"}
```

Response:

```json
{"id":"cancel-1","type":"response","command":"abort","success":true}
```

Transport close has no RPC payload and must not be translated into `abort`.

Resolved 2026-06-22: RPC and Iroh protocol docs now define transport close as detach and `abort` as cancellation; the remote command filter exports the v1 cancellation set as `abort` only, and contract tests pin cancel-like command rejection plus clean close not synthesizing `abort`.

Optional future additions:

- `cancel_run`: clearer alias for `abort` if the protocol wants run-scoped naming.
- `detach`: advisory client intent for clean UI disconnect. This must never be required for correctness.
- `get_state.run`: additional run metadata such as `status`, `activeRunId`, `detached`, `startedAt`, `lastEventAt`, and `cancelledAt`.
- Transcript/event cursor: reconnect can ask for events after a known entry/event ID instead of reloading a transcript page.

### State Recovery Contract

On connect or reconnect, remote clients should:

1. Call `get_state`.
2. Call `get_transcript`.
3. If `get_state.isStreaming` or future `run.status` indicates active work, render the session as still running and wait for new events.

The host must persist transcript entries independently of subscriber presence so that detached work can be recovered through `get_transcript`.

Resolved 2026-06-22: Native integrated-host coverage now exercises active detach and reconnect against a local OpenAI-compatible streaming provider. The same authorized Iroh node reconnects while the detached prompt is still active, sees the same session ID via `get_state`, receives prompt completion, and recovers both the detached user prompt and assistant output through `get_transcript`. The same scenario also proves a different node cannot reuse the consumed pairing ticket and a revoked node cannot reconnect.

Resolved 2026-06-22: No additional `get_state.run` metadata is required for this phase. The existing safe `get_state.isStreaming` boolean is the remote UI signal for active work after reconnect, and `get_transcript` remains the recovery surface for output generated while detached. The native active-detach reconnect scenario verifies `isStreaming === true` on active reconnect, and the Iroh outbound sanitizer continues to omit/redact host-local state fields such as `sessionFile`.

## Proposed Architecture

### Host Runtime Registry

Add a host-owned runtime registry for integrated remote sessions. The registry key should include at least:

- authoritative client node ID
- workspace name

The registry owns:

- the `AgentSessionRuntime`
- active session ID
- subscriber set
- detached/attached timestamps
- optional run status metadata
- a cleanup/TTL timer

Accepted Iroh streams become subscribers to an existing runtime when one exists for the same client/workspace and policy allows it. If no runtime exists, the host creates one using the existing session-selection logic.

Resolved 2026-06-22: Integrated remote hosts now keep a host-owned runtime registry keyed by authoritative client node ID and workspace name. Runtime entries own the `AgentSessionRuntime`, current session ID, subscriber set, and detached timestamps; authorized streams attach as subscribers, clean close detaches without runtime disposal, and same-client reconnect reattaches to the existing runtime.

### Subscriber Transport

Instead of letting stream close dispose the session runtime:

- Stream close unsubscribes that subscriber from session events.
- Stream close closes only that stream's transport resources.
- Stream close marks the registry entry detached if no subscribers remain.
- Stream close does not call `session.abort()` and does not call `runtime.dispose()` while an active prompt is expected to continue.

Write failures should be treated as subscriber loss. They should not shut down the session runtime unless they indicate a host-internal fatal error.

Resolved 2026-06-22: `runRpcMode()` now has an opt-in `disposeRuntimeOnClose: false` path used by integrated Iroh subscribers, so stream shutdown closes the subscriber transport while leaving the host runtime alive. The host audits `remote_subscriber_attached`, `remote_subscriber_detached`, `remote_runtime_detached`, and `remote_runtime_reattached`.

Resolved 2026-06-22: Accepted integrated prompt behavior is pinned by remote lifecycle regression tests that run the real RPC mode over the Iroh close-deferring transport. Clean stream close waits for the accepted prompt to finish without disposing the runtime, remote write failure detaches the subscriber without calling runtime dispose/abort, and transcript entries produced after detach remain recoverable through the transcript projection.

### Runtime Disposal

Dispose the runtime only when one of these is true:

- The host process is shutting down.
- The user explicitly starts a new incompatible runtime and the old runtime is idle.
- A documented detached-runtime retention policy expires.
- A fatal runtime error occurs.
- A future administrative control explicitly stops the runtime.

If the runtime is disposed while active, that is cancellation/stop behavior and should be logged as such.

Resolved 2026-06-22: Integrated runtime disposal moved to host-owned registry shutdown for this phase. Host shutdown disposes retained runtimes and audits `remote_runtime_stopped` while preserving the legacy `runtime_started`/`runtime_stopped` events for existing diagnostics.

Resolved 2026-06-22: Detached integrated runtimes now use an explicit retention policy. Active detached runtimes wait for the session to become idle and are not disposed by TTL while work is running; idle detached runtimes are retained for 30 minutes by default, configurable with `--detached-runtime-ttl-ms`, then audit `remote_runtime_retention_expired` and dispose with reason `detached_runtime_ttl_expired`.

### Explicit Cancel Path

Keep explicit cancel narrow:

- Inbound `abort` from an authorized remote client calls `session.abort()`.
- It should record enough event/state for reconnecting clients to know active work stopped.
- If multiple subscribers exist, all subscribers see the resulting events.
- No transport close path should call `abort`.

Resolved 2026-06-22: The explicit remote `abort` path remains the only cancellation command and is covered during an active remote prompt. The regression test runs the real RPC mode through the Iroh remote filter and close-deferring transport, proves `session.abort()` is called, proves the `abort` response is withheld until abort settlement, and checks the cancelled prompt's transcript output remains observable.

### Duplicate Connections

The current protocol rejects a second active connection for the same client/workspace. Detach-aware behavior should revisit this:

- If the previous connection is still truly active, reject or replace according to existing preview policy.
- If the previous stream is closed but the runtime is still detached/running, accept reconnect and attach it as the new subscriber.
- If native Iroh connection state lags, prefer a short replacement grace period over losing a running prompt.

### Spawned Child Mode

Spawned child mode currently maps connection lifetime to child process lifetime. It can remain a documented limitation if integrated mode is the supported mobile path, but the host should make that explicit:

- Integrated runtime: detach can preserve active work.
- Spawned RPC child: disconnect may stop the child unless a persistent child registry is implemented.

If spawned mode must support mobile detach, it needs a child-process registry, detached stdout buffering, and reconnectable stdin/stdout routing. That is larger than the integrated-runtime fix.

## Security and Privacy

Detach support must preserve the remote access boundary:

- `get_messages` remains blocked over Iroh.
- `get_transcript` remains the remote-safe transcript recovery surface.
- Transcript fields remain bounded and redacted.
- Session file paths remain hidden.
- Host-local paths outside the workspace remain redacted.
- Detached runs must not accept commands from revoked clients.
- Reconnect must authorize the same authoritative Iroh client node ID before attaching to any existing runtime.
- If client permissions change or are revoked while detached, the next attach must enforce the new policy.

## Observability

Add audit/log events for the lifecycle transitions:

- `remote_runtime_started`
- `remote_subscriber_attached`
- `remote_subscriber_detached`
- `remote_runtime_detached`
- `remote_runtime_reattached`
- `remote_run_cancelled`
- `remote_runtime_retention_expired`
- `remote_runtime_stopped`

Events should include client node ID, workspace, session ID, whether the runtime was active, and a bounded reason. Do not log prompts, raw transcript, tickets, or secrets.

## Testing Plan

### Unit Tests

- Transport clean close during an active accepted prompt detaches the subscriber and does not call `runtime.dispose()` or `session.abort()`.
- Transport close with an error detaches the subscriber when the stream itself failed, but does not cancel active work.
- Explicit `abort` calls `session.abort()` and transitions the run to idle/cancelled.
- Write failure while streaming to a detached subscriber does not kill the active runtime.
- Detached runtime TTL cancels/disposes only according to the documented policy.
- Reconnect attaches to an existing detached runtime for the same client/workspace.
- Reconnect from a different or revoked client is rejected.

### Integration/Scenario Tests

- Start integrated Iroh host, send a long-running prompt, close the client stream, verify the host runtime continues and transcript grows.
- Reconnect as the same paired client and verify `get_state` plus `get_transcript` shows the same session and final assistant content.
- Send explicit `abort` during active work and verify prompt stops.
- Verify `get_messages` and path-based `switch_session` remain blocked remotely.
- Verify `get_transcript` remains redacted and bounded after detached execution.
- Verify duplicate connection behavior for active, detached, and reattached states.

### Manual iOS Smoke

Run on iPhone 16 Pro or newer equivalent:

1. Connect to host over Wi-Fi with relay mode default.
2. Start a prompt that takes long enough to observe.
3. Background the app until the stream disconnects.
4. Confirm the host continues the run.
5. Reopen the app and confirm reconnect shows the same session and transcript.
6. Start another prompt and use the app stop/cancel control.
7. Confirm the host receives `abort` and stops the prompt.

Record exact device, iOS version, macOS version, relay mode, and network.

Blocked 2026-06-22: Automated D.2 validation passed, but the manual physical-device iOS smoke was not run. `xcrun xctrace list devices` showed only the Mac online; two physical iPhones were listed offline (`Corin's Iphone` on iOS 26.2.1 and `Jordan's iPhone` on iOS 26.6). Simulators were available, including a booted iPhone 17 Pro Simulator on iOS 27.0, but simulator evidence does not prove real-device background suspension/foreground reconnect behavior. To unblock D.2, run the steps above on an online iPhone 16 Pro or newer equivalent and record device, iOS version, macOS version, relay mode, network, commands, and results.

## Open Decisions

1. Detached runtime retention:
   - Proposed default: continue active prompts to completion, then retain idle runtime for a short TTL such as 10 to 30 minutes.
   - Need product decision on whether active detached prompts can run indefinitely.
   - Resolved 2026-06-22: active detached prompts continue until idle; idle detached runtimes retain for 30 minutes by default and can be configured per host with `--detached-runtime-ttl-ms`.

2. App disconnect button:
   - Proposed default: app-level disconnect is detach only.
   - A separate stop/cancel control sends `abort`.

3. Runtime ownership:
   - Proposed first implementation: integrated Volt runtime supports detach; spawned child mode remains connection-scoped and documented.
   - Alternative: implement persistent spawned child registry.

4. State shape:
   - Proposed first implementation: keep `get_state.isStreaming` and add minimal remote run metadata only if needed by iOS.
   - Alternative: add explicit run IDs and event cursors now.
   - Resolved 2026-06-22: keep `get_state.isStreaming` as the active-work signal for iOS in this phase; defer richer run metadata and event cursors until a concrete UI need appears.

5. Revocation while active:
   - Proposed default: revoke closes active streams and prevents reconnect. Whether it also cancels a detached active run should be a host policy decision.

## Acceptance Criteria

- Host docs define disconnect, detach, cancel, and host exit as separate lifecycle states.
- Integrated host runtime is not disposed only because an Iroh stream closes after startup.
- `abort` remains the only remote command path that cancels an active prompt.
- A disconnected mobile client can reconnect and recover state/transcript after the prompt finishes.
- Automated tests cover disconnect-during-run and explicit cancel.
- Protocol docs explain that transport close is detach-only and `abort` is cancellation.
- Unsupported durability cases, especially host process exit and spawned child mode if deferred, are documented.

## Implementation Notes

- Resolved items should be recorded here as `Resolved YYYY-MM-DD:` entries.
- Resolved 2026-06-22: User-facing and protocol docs now document the D.1 lifecycle contract: transport close is detach, `abort` is cancellation, integrated host runtimes support active-work detach/reconnect with idle retention, host process exit is not durable recovery, and spawned child compatibility modes remain connection-scoped. Evidence commit: `694aa7d8`; verification: `git diff --check -- packages/coding-agent/docs/rpc.md packages/coding-agent/docs/iroh-remote-protocol.md packages/coding-agent/docs/iroh-remote-access-design.md packages/coding-agent/docs/usage.md packages/coding-agent/docs/security.md`, pre-commit `npm run check`.
