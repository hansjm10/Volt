# Changelog

## [0.2.0] - 2026-07-30

### Highlights

- Agents can now use `web_fetch` to retrieve approved public URLs as bounded readable text after `web_search` or a user-provided link.
  Only URLs already present in the conversation as user input or trusted tool output are eligible; model-constructed and delegated-task URLs are refused. Requests to non-public addresses are rejected before and after every redirect, response buffering and extracted metadata are bounded, and cancellation remains effective during hostname resolution.

  HTML extraction preserves code formatting while removing navigation and footer chrome. Parsing and truncation stay within fixed resource limits, including for boundary-heavy pages and alternate IPv6 address spellings.
- Added a native read-only Plan mode with structured checklists and an explicit, context-clearing handoff into execution.
- Added session-scoped [Fast mode](https://volt-cli.dev/docs/usage/#slash-commands) with `/fast` controls, a TUI status indicator, and OpenAI Priority processing for eligible OpenAI and OpenAI Codex models. ([#111](https://github.com/volt-hq/Volt/issues/111), [#112](https://github.com/volt-hq/Volt/issues/112))
- [Remote clients can now run detached reviews](https://volt-cli.dev/docs/rpc/#detached-review-workflows) of uncommitted changes, branches, commits, and pull requests while the conversation remains available. ([#66](https://github.com/volt-hq/Volt/issues/66), [#80](https://github.com/volt-hq/Volt/issues/80))
  Accepted invocations return a workflow ID immediately and stream sanitized progress events. Clients can fetch findings, list or cancel workflows, and open completed findings in a fresh session on demand.
- [Subagents can now discover and follow runs across the session tree](https://volt-cli.dev/docs/usage/#subagents-mvp), with bounded pagination and confirmation before duplicate work starts.
  Spawn preflights show the live registry and require an exact one-time confirmation before starting agents. Admission is atomic, confirmation tokens remain available under small output limits, and mismatched tokens rotate without locking out the request. ([#146](https://github.com/volt-hq/Volt/issues/146))

  Child runtimes use `subagent_registry`, while root sessions retain list and follow compatibility on `subagent`. Registry access remains available when policy prevents further spawning and is advertised only when supported. Pages use stable newest-first cursors, current, ancestor, and dependency-cycle runs are non-followable, and followed output is marked as untrusted data. Explicit registry calls and failures remain visible in the TUI, while successful spawn preflights stay hidden.
- [Interrupted subagent runs](https://volt-cli.dev/docs/usage/#subagents-mvp) can now be rediscovered, followed, and resumed after a restart or disconnect, with recovered results surfaced in local and remote transcripts. ([#129](https://github.com/volt-hq/Volt/issues/129), [#136](https://github.com/volt-hq/Volt/issues/136))
  Resume mode reloads an interrupted child from its transcript and lets it finish the original task without another confirmation round-trip.

### Breaking Changes

- **daemon:** UI action invocations now require a correlation ID that the daemon echoes in every response.
  Clients must add a unique, trimmed, non-empty `id` of at most 256 UTF-8 bytes to every `invoke_ui_action` command and correlate the result using the identical response `id`. Invocations without a usable id now receive an uncorrelated `command: "invalid"` failure instead of an id-less `invoke_ui_action` response.
- **rpc:** Added explicit epoch and sequence positions to assistant streaming frames. ([#72](https://github.com/volt-hq/Volt/issues/72))
  RPC clients must adopt assistant base, snapshot, and final frames unconditionally, apply only contiguous compact deltas within an epoch, and seed resumable tool arguments from snapshot `toolState`. TypeScript clients can use `StreamProjectionDecoder` for this reconstruction.
- **plan:** Activating Plan mode is now asynchronous so its read-only Git, GitHub, and explicitly trusted MCP inspection tools are ready before planning starts.
  SDK migration: `AgentSession.setAgentMode()` is now asynchronous. Callers must `await session.setAgentMode(...)` before reading planning state or active tools.
- **remote:** Remote conversations now use an atomic resumable attachment and input-delivery protocol across reconnects and daemon restarts.
  Remote conversation clients must upgrade with the daemon because conversation attachment now uses the versioned atomic bootstrap-and-tail protocol instead of the legacy snapshot replay sequence.

  Prompt, steer, and follow-up commands now require a stable `clientMessageId`, which the host echoes on the canonical user transcript entry.

  The host now durably deduplicates prompt, steer, and follow-up retries by `clientMessageId`, including across daemon restarts.
  Private retry receipts never appear as blank conversations in local or remote session history.

  Conversation runtime, lease, direct-stream, and relay ownership now remain under one stable coordinator through handoff, rekey, reconnect, and retirement.
- **streaming:** Made assistant streaming events immutable and self-contained. ([#72](https://github.com/volt-hq/Volt/issues/72))
  Custom providers must emit fragments through `AssistantStreamNormalizer`. Event consumers must read the immutable `snapshot`, contiguous `seq`, and typed `toolState` fields instead of `partial` or provider-owned argument scratch fields.
- **rpc:** message_update frames are now delta-only: they no longer carry the accumulated partial message or the duplicated assistantMessageEvent.partial. ([#44](https://github.com/volt-hq/Volt/issues/44))
  Every `message_update` frame previously serialized the full accumulated assistant message twice (as `message` and as `assistantMessageEvent.partial`), making streaming bandwidth quadratic in message length on stdio RPC, Iroh remote, `--mode json`, and daemon viewer feeds. Frames now carry only the streaming delta; `message_start` seeds the accumulator, `message_end` carries the final message, and a client attaching mid-message receives one full `message` snapshot on its first update. Daemon viewer feeds still carry full messages but drop the duplicated partial.

  Migration: clients using the bundled RPC client (`RpcClientBase` and SDK clients built on it) are unaffected — full `message` and `partial` fields are reconstructed transparently. Clients reading raw JSONL frames must accumulate deltas per the reconstruction rules in `docs/rpc.md` (`text_delta`/`thinking_delta` append to the block at `contentIndex`; `toolcall_start` carries an id/name stub, `toolcall_delta` streams raw argument JSON, `toolcall_end` is authoritative), or read only `message_end` for final content.

### Improvements

- **daemon:** Kept long lease-drain overlays visible instead of truncating from repeated accumulated assistant messages. ([#63](https://github.com/volt-hq/Volt/issues/63))
- **plan:** Plan details now wrap complete checklists, and planning updates show focused semantic checklists instead of JSON.
- **plan-mode:** Plan execution now freezes approved scope and requires explicit reapproval before structural changes.
  Plan state now travels through append-only checkpoints and progress results so ordinary planning and execution turns remain provider-cacheable.
- **release:** Stable releases now publish through npm `latest` and GitHub's latest non-prerelease channel.
- **remote:** Model catalogs now report whether each model supports Fast mode so remote clients can hide unavailable controls.
- **remote:** Remote clients can now display [path-free Git context](https://volt-cli.dev/docs/rpc/#get_state), including branch, divergence, operation, and status, from session state and live updates.
- **remote:** Remote clients can request a correlated assistant-stream recovery snapshot after detecting frame loss, restoring live transcripts without waiting for the message boundary.
  Recovery validates the client's exact stream position and continues from a matching checkpoint.
- **remote:** Iroh handshake rejections now distinguish a permanently missing registered workspace path (workspace_missing) from a transiently unavailable one (workspace_unavailable with a retryAfterMs pacing hint) so paired clients can stop or pace automatic redials. ([#88](https://github.com/volt-hq/Volt/issues/88))
- **remote:** Paired devices now receive the host.manage.v1 capability by default, so capability advertisement, host-action responses, and keep-awake work without a custom access grant.
- **remote:** Newly paired devices with a default tool grant now track the daemon's defaults, automatically picking up new builtin tools; only explicitly customized grants stay pinned. ([#154](https://github.com/volt-hq/Volt/issues/154))
  Devices paired before this release keep their frozen pair-time grant (an old snapshot is indistinguishable from an explicit customization). Because a frozen grant no longer counts as default, such devices also lose access to extension-registered tools until switched over. Re-pair the device, or reset its access to the coding preset, to switch it to tracking.
- **remote:** Show semantic conversation, Plan, and review status in Live Activities. ([#150](https://github.com/volt-hq/Volt/issues/150))
- **remote:** Remote clients can now retrieve the full sanitized text of truncated transcript entries through the paginated `get_transcript_entry_text` RPC. ([#86](https://github.com/volt-hq/Volt/issues/86))
- **rpc:** RPC client authors can now validate integrations against the committed `packages/coding-agent/contract/rpc-schema.json` JSON Schema, which CI keeps aligned with the wire contract.
- **rpc:** RPC commands now reject unknown fields and validate every command type against the schema-derived contract.
- **rpc:** The review.branch UI action now advertises a gitBranches completion source on its base argument, so get_ui_action_completions serves workspace branch names to local and remote clients. ([#79](https://github.com/volt-hq/Volt/issues/79))
- **rpc:** The host now emits a terminal `subagent_disposed` event whenever it releases a local RPC-managed subagent (abort, dispose, failed start, or a session switch disposing active subagents). ([#44](https://github.com/volt-hq/Volt/issues/44))
  Host-side disposals (for example a session switch while a subagent streams) previously produced no terminal frame, so the bundled RPC client retained that subagent's message-delta accumulator indefinitely. The bundled client now drops the accumulator on `subagent_disposed`; raw-frame consumers should treat it as the end of that subagent's event stream.
- **session:** Session saves no longer block active conversation work while preserving ordered, durable shutdown and handoff behavior. ([#46](https://github.com/volt-hq/Volt/issues/46))
- **subagents:** Cut in-process subagent streaming overhead about 4-7x: parent-child RPC frames now pass as structured objects instead of being JSON-serialized and re-parsed inside the same process, removing the quadratic cost on long streaming outputs.
- **subagents:** Made subagent delegation local-first by default. ([#143](https://github.com/volt-hq/Volt/issues/143))
- **subagents:** Every delegation tree now shares default root-scope structural safeguards of depth 5, 100 total starts, and 16 concurrently active descendants in addition to per-call and per-definition limits.
  Structural admission failures reject new starts without aborting admitted descendants. SDK hosts can override every limit through `SubagentManagerOptions.delegationLimits`; turn, token, cost, and deadline budgets remain unlimited unless the host supplies finite values, and crossing a configured consumption budget cancels the whole tree.
- **subagents:** Warn each long-running subagent at 80 turns and require its final report after 120 turns.
  Host `turnLimits` overrides stay consistent: an unset warning threshold clamps to `min(80, maxTurns)`, an explicit `warnAtTurns` above a finite `maxTurns` is rejected, and an infinite `maxTurns` without an explicit warning disables both stages.
- **tools:** Bash commands that stop producing output are now killed as hung after five minutes, and timed-out commands no longer leave stray processes running. ([#125](https://github.com/volt-hq/Volt/issues/125))
  Silence, not elapsed time, is what separates a hung command from a slow one, so long-running commands no longer need an inflated `timeout` to stay safe. Pass `stallTimeout` to adjust the window for commands that are legitimately quiet for long stretches, or `0` to disable the check. Explicit `timeout` values are now capped at one hour.

  Teardown now enumerates the whole process tree before signalling, so a child that moved itself into its own process group — as test runners and daemons commonly do — is killed rather than orphaned. Commands also get a brief SIGTERM grace period to clean up before SIGKILL.
- **web-search:** Structured OpenAI and OpenAI Codex search results now use roughly 14x less context and respect requested result limits.
- In-app release notes and extension catalog links now point to the Volt repository under the `volt-hq` GitHub organization.

### Fixes

- **agent:** Made automatic context compaction retry transient summary failures, stop safely when recovery cannot complete, and use supported reasoning levels.
- **agent:** Persisted branch-local Fast mode independently from thinking and synchronized state across attached clients. ([#110](https://github.com/volt-hq/Volt/issues/110))
- **coding-agent:** A subagent re-prompted after finishing at its turn limit now returns a tool-free reply instead of aborting, and turn-budget hook wiring is guarded against accidental reinstall.
- **coding-agent:** Bash full-output files are fully written before their path is reported, so opening the saved output no longer shows an empty file.
- **compaction:** Fixed threshold compaction repeatedly re-triggering when a conversation ended in a long run of tool results; the compaction cutoff now advances past trailing tool results, and the reported estimate matches the context actually retained for the retry. ([#25](https://github.com/volt-hq/Volt/issues/25))
- **daemon:** Prevented closed Iroh transcript streams from crashing voltd. ([#57](https://github.com/volt-hq/Volt/issues/57))
- **daemon:** Made daemon restarts recover promptly from stalled network teardown without interrupting admitted work.
  Accepted remote streams, pairing tickets, control requests, and startup state now drain within a bounded shutdown window before durable state closes. If the operating system refuses termination, shutdown fails closed instead of risking overlapping daemon ownership.
- **daemon:** Fixed daemon workspace matching and remote path sanitization on Windows. ([#32](https://github.com/volt-hq/Volt/issues/32))
- **daemon:** Fixed warm TUI lease handoffs leaving a conversation permanently unreachable from paired phones with "conversation owner changed; retry" until the TUI released the session. ([#81](https://github.com/volt-hq/Volt/issues/81))
  After a warm daemon-to-TUI handoff the conversation authority kept its retired runtime lifecycle and rejected every subsequent phone relay attach. Relay attaches now succeed while the TUI owns the session, a daemon reservation racing relay closure reports the accurate transient reason, and rejected relay handshakes record the underlying error in the daemon audit log.
- **daemon:** Preserved structured Iroh handshake failures until remote clients close the connection. ([#67](https://github.com/volt-hq/Volt/issues/67))
- **daemon:** Fixed worktree-bound conversations failing to resume after a daemon restart with "stored session working directory is outside the authorized workspace". ([#83](https://github.com/volt-hq/Volt/issues/83))
  Session rekeys (fork/new), missing-session replacements, and TUI-side rekeys now keep the durable worktree binding covering the current session id, and resume/relay resolution heals stranded bindings (including subagent sessions) from the session's stored working directory. Attach failures additionally audit the target session id.
- **daemon:** Isolated fallback control sockets for distinct agent directories. ([#126](https://github.com/volt-hq/Volt/issues/126))
- **fast:** Fixed Fast mode not carrying through review inference or into fresh review findings sessions. ([#112](https://github.com/volt-hq/Volt/issues/112))
- **remote:** Prevented connection cleanup from interrupting sibling Iroh handshake responses. ([#69](https://github.com/volt-hq/Volt/issues/69))
- **remote:** Remote-access and Iroh protocol documentation now use the actual relay modes, `production` default, pairing-ticket fields, secret handling, and workspace availability metadata. ([#51](https://github.com/volt-hq/Volt/issues/51), [#97](https://github.com/volt-hq/Volt/issues/97))
- **remote:** Opening a completed review's findings session now consumes the retained review record, so reconnecting or reconciling clients no longer re-surface an already-acted-on review and cannot seed a duplicate findings session. ([#78](https://github.com/volt-hq/Volt/issues/78))
  A declined or failed open keeps the review available. After a successful open, get_review_result for that workflow id fails; the findings live in the seeded session.
- **remote:** The default phone tool grant now includes the inspect and lsp tools, so plan mode on a paired device can use vetted Git/GitHub inspection and language-server reads like the TUI. ([#153](https://github.com/volt-hq/Volt/issues/153))
  Applies to new pairings and to devices switched to the tracking grant; devices paired before this release stay on their frozen grant until re-paired or reset. lsp is also classified as unsafe alongside bash/edit/write, since its rename and fix actions edit workspace files.
- **remote:** Preserved empty assistant content blocks so live conversation transcripts stay synchronized.
- **remote:** Shared conversations now recover reliably across daemon restarts and branch changes while rejecting stale or duplicate device input.
  Input acknowledgements and queued delivery remain durable, outstanding records are bounded, audits identify the acting device, and Live Activities retire for every attached device.
- **remote:** Streamed message deltas can no longer bypass host path redaction on iroh remote connections.
  Delta-only `message_update` frames are now derived from sanitized accumulated text, and the host replaces the client accumulator with a fully sanitized snapshot whenever redaction rewrites text that already streamed (including tool-call arguments), so remote clients can no longer reassemble a complete redacted host path from deltas split across frames. As before, an incomplete prefix of a path may still appear in individual frames until the completing snapshot rewrites it.
- **remote:** Prevented shared conversations from emitting blank compaction rows.
- **remote:** A paired client attaching after a turn completes now receives the full text of the latest assistant message instead of a permanent 12,000-character truncation. ([#85](https://github.com/volt-hq/Volt/issues/85))
  The branch-latest assistant message is served complete (up to the 256 KiB live assistant content budget) in conversation bootstraps, resync checkpoints, `get_transcript` head pages, and its own transcript commit frame. Older or over-budget entries keep the previous bounded truncation.
- **remote:** Rejected malformed assistant tool state before publishing it to remote clients.
- **retry:** Made active runs more resilient to short transient provider outages by increasing the default automatic retry budget. ([#124](https://github.com/volt-hq/Volt/issues/124))
- **review:** Opening review findings no longer drops them when post-replacement input recovery fails. ([#92](https://github.com/volt-hq/Volt/issues/92))
- **rpc:** Mid-turn attaches that land exactly on a toolcall_start now stream tool-call arguments instead of freezing them until toolcall_end.
- **subagents:** Explicitly aborted subagent retries now appear as aborted in activity, registry list, and follow results.
- **subagents:** Prevented subagents rejected before prompt acceptance from appearing in the inspector or daemon. ([#56](https://github.com/volt-hq/Volt/issues/56))
  A first prompt rejected before the start is published (including a daemon registration commit failure after acceptance) now also disposes the SDK subagent handle, so later handle calls fail with a clear disposed-handle error instead of hitting a rolled-back runtime.
- **subagents:** Removed implicit subagent turn, token, and cost budgets so delegation trees run until completion unless a host supplies finite consumption limits.
- **subagents:** Internal aborts (tree budget crossed, run timeout) that land while a child is being cleaned up no longer discard the child's already-computed result or a parallel run's per-task failure details.
- **subagents:** Bounded subagent tool detail payloads so large parallel outputs and error messages stay under remote RPC frame limits instead of disconnecting the session.
  Details snapshots retain at most 100 task entries with one shared output-text budget and clamp per-task error messages; omitted entries are counted in the summary and full output stays reachable through child sessions and the registry. The parallel aggregate is also built incrementally under its byte limit instead of materializing one unbounded string.
- **subagents:** A `runTimeoutMs` expiry now aborts children whose start was still in flight when the timeout fired, instead of letting them run to completion on a shared delegation scope.
- **subagents:** Definition-less SDK `start()` children now join the session tree — sharing the session-wide registry, delegation ceilings, and depth accounting — instead of acting as fresh roots, and are fail-closed for nested delegation.
- **subagents:** Delegation UI now stays hidden until a child agent is created, including for nested preflights.
- **subagents:** Restored responsive TUI rendering with large delegation trees by caching rosters, collapsing long lists, bounding nested rendering, and throttling progress snapshots.
- **subagents:** Kept untrusted delegation labels and task text out of child system prompts while preserving them in registry tool results.
- **subagents:** Fixed completed subagent usage stats shrinking after compaction; final message, tool-call, token, and cost totals are now computed from lifetime session history instead of retained context. ([#24](https://github.com/volt-hq/Volt/issues/24))
- **tui:** Long-running TUI sessions no longer accumulate subagent repaint timers when tool rows are discarded.
- **tui:** Fixed Escape aborts crashing the interactive TUI. ([#105](https://github.com/volt-hq/Volt/issues/105))
- **tui:** Fixed terminal scrollback being corrupted during live transcript updates; offscreen rows keep their last painted content until re-exposed, and the bottom anchor survives terminal height shrinks. ([#30](https://github.com/volt-hq/Volt/pull/30))

## [0.1.0] - 2026-07-13

Volt's first release: a terminal coding agent with a companion daemon that can hand a running session to your phone and back. Volt is a fork of [Pi](https://github.com/badlogic/pi-mono); this release restarts the version line under the `@hansjm10/volt-coding-agent` package identity.

### Highlights

- **Remote sessions on your phone** — Pair the Volt iOS app with your machine over an end-to-end encrypted Iroh connection (QR-code pairing, no port forwarding or accounts), attach to live conversations, steer runs from anywhere, and get push notifications and Live Activities as turns complete. Every device pairs with an explicit access preset: `coding`, `review`, `chat`, or `full`.
- **`voltd` daemon and `/remote` control center** — A background daemon owns workspaces, runtimes, and conversation leases, so sessions survive TUI restarts and move cleanly between desktop and phone. The `/remote` command manages daemon health, workspace registration, pairing, paired devices, active leases, and runtime tool policy from inside the TUI. See [Daemon](docs/daemon.md).
- **Subagent delegation** — A built-in `subagent` tool discovers user- and project-defined child agents, ships reserved `general`, `researcher`, `design-doc`, and `security-reviewer` roles, enforces bounded recursive delegation budgets, and renders live nested delegation trees in the TUI and on remote clients.
- **Native MCP support** — Trusted config loading, a built-in `mcp` gateway tool, stdio/Streamable HTTP/SSE transports, and OAuth (browser PKCE and device-code) with host-side token storage. See [MCP](docs/mcp.md).
- **LSP-backed editing** — Language servers spawn lazily per project and append diagnostics to `edit`/`write` results by default, and the `lsp` tool adds navigation, references, call hierarchy, project-wide rename, and quick fixes. See [LSP Diagnostics](docs/lsp.md).
- **`/review`** — Review uncommitted changes, branch diffs, GitHub PRs, or single commits in an isolated session, then continue from the numbered findings with clean context.
- **Built-in web search** — A `web_search` tool enabled by default across SDK, CLI/RPC, and remote sessions, with OpenAI/Codex, custom-endpoint, and Brave Search backends.
- **Settings profiles** — Workflow-specific settings and resource overlays selectable with `--profile`, `VOLT_PROFILE`, or `defaultProfile`, plus `/profile` for switching interactively.

### Breaking Changes

- Volt now ships as `@hansjm10/volt-coding-agent` with the release line restarted at 0.1.0; npm beta installs use the `beta` dist-tag.
- Paired remote devices and pending pairing tickets require a versioned per-device access grant; pairings created before this release fail closed and must re-pair with `volt remote pair --access coding|review|chat|full`.

### Also in this release

- Standalone releases are Node.js Single Executable Applications for six OS/architecture targets, with checksum-verified installers, pinned license manifests, and a reviewed exact-commit release pipeline.
- Live model catalog updates, mid-turn reconnect state (`get_state` active tools), remote model/thinking-level switching, and remote-safe transcript projection for paired clients.
- Proactive mid-run compaction, an `agent_settled` idle-boundary event, and bounded summarization input for long conversations.
- Pi extension compatibility: `volt install` reads `pi` manifests when no `volt` manifest is present and aliases Pi core imports to Volt modules at load time.
- A redesigned interactive shell: responsive startup lockup, electric purple themes, Bash syntax highlighting, tool duration suffixes, focus-aware turn-done alerts, and `/clear` replacing `/new`.
- Extensive hardening across daemon lifecycle and Windows support, Iroh pairing and connection admission, push delivery, MCP and OAuth handling, local persistence, and release integrity. The full engineering log for this release (~180 entries) is preserved in this file's git history.
