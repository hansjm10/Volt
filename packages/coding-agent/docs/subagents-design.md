# Core Subagents Design

## Status

Local MVP implemented. This document records the supported boundary for core subagents and the work intentionally deferred beyond the MVP.

Implemented surfaces:

- Built-in `general`, `researcher`, `design-doc`, and `security-reviewer` definitions and markdown definition discovery through `ResourceLoader.getSubagents()`.
- `SubagentManager` for isolated in-process child runtimes.
- Built-in `subagent` spawning tool with single, parallel, and chain modes, plus child-only `subagent_registry` list/follow access to the shared delegation registry.
- Local RPC lifecycle commands for definition-backed subagents.
- App-visible "new agent with initial prompt" flow through existing Iroh conversation streams followed by `prompt`.

Not implemented in this MVP: package-manager `agents` resources, subprocess fallback, remote/Iroh subagent lifecycle commands, protocol handshake changes, app-native subagent action surfaces, or spawning modes beyond single/parallel/chain.

## Summary

Core subagents are isolated Volt agent runtimes controlled through the existing RPC stack. A local caller in the TUI, SDK, CLI, extension system, or local RPC mode can request a child agent, pass it a prompt, stream its events, and wait for session-level settlement or cancellation.

The implementation reuses Volt's existing primitives instead of introducing a second agent protocol:

- `AgentSessionRuntime` creates isolated sessions.
- `runRpcMode()` runs a runtime over a transport.
- `createLoopbackRpcTransportPair()` and `createInProcessRpcClient()` provide same-process RPC for local subagents.
- Iroh conversation streams already provide remote multi-agent streams for the app.
- Existing RPC `prompt`, `abort`, `get_state`, `get_transcript`, and `agent_end` events remain the transport contract; the session additionally emits `agent_settled` once retries, compaction continuations, and queued continuations finish, and local handles wait for that settlement before releasing child ownership.

The [`examples/extensions/subagent/`](../examples/extensions/subagent/) implementation remains the reference prototype for workflow shape. The core MVP avoids subprocess and JSON-mode parsing fallback.

## Existing building blocks

- **RPC mode** ([rpc.md](rpc.md)): accepts prompts, streams events, and reports run completion with `agent_end` and final settlement with `agent_settled`.
- **SDK runtime** ([sdk.md](sdk.md)): creates and replaces `AgentSessionRuntime` instances.
- **In-process RPC client**: `createInProcessRpcClient()` runs `runRpcMode()` over an in-memory loopback transport.
- **Iroh remote conversation streams** ([iroh-remote-protocol.md](iroh-remote-protocol.md)): mobile clients can open `conversation.target: "new"` or `"session"` streams. Stream close is detach; `abort` is cancellation.
- **Subagent extension prototype**: [`../examples/extensions/subagent/`](../examples/extensions/subagent/) defines markdown agents and a `subagent` tool with single, parallel, and chain modes.

## Goals

- Provide a core API for starting isolated child agents and observing their lifecycle.
- Use RPC as the communication boundary between parent and child agents.
- Support named subagent definitions with tool/model/system-prompt configuration.
- Allow parent agents to delegate work through a built-in `subagent` tool.
- Keep app-visible agents aligned with existing remote conversation streams instead of adding subagent-specific Iroh protocol commands.
- Keep child context windows isolated from the parent session.
- Propagate explicit cancellation and session shutdown correctly.
- Enforce tool, project-trust, and remote-host policy without escalation.
- Make the design testable with the faux provider and in-memory transports.

## Non-goals

- No durable job recovery beyond normal persisted session state.
- No sandbox. Subagents run with the same host permissions as Volt.
- Plan mode excludes subagents in v1; Build mode keeps the existing delegation policy.
- No multi-user collaboration semantics.
- No TUI tunneling for child agents.
- No mandatory Iroh dependency for local subagents.
- No package-manager `agents` resource type in the MVP.
- No remote/Iroh subagent lifecycle commands until an explicit remote policy slice defines allowlist and redaction behavior.

## Agent definitions

Core subagents use the markdown frontmatter shape from the extension prototype:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls, web_search, subagent, subagent_registry
allowedSubagents: researcher
maxSubagentDepth: 2
maxChildAgents: 2
model: claude-haiku-4-5
thinking: off
---

You are a scout. Find relevant files and return concise findings.
```

Initial fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Stable invocation name. |
| `description` | yes | Shown to users and the parent model. |
| `tools` | no | Requested child tool names. Effective tools are policy-clamped. |
| `excludedTools` | no | Child tool names to subtract after inheritance or `tools`/policy intersection. |
| `allowedSubagents` | no | Child subagent names this definition may start. Omission is fail-closed and allows no child names. |
| `maxSubagentDepth` | no | Deepest nested subagent depth this definition may create; top-level user sessions are depth 0 and descendants inherit the strictest ancestor cap. |
| `maxChildAgents` | no | Maximum child subagent starts allowed for one runtime of this definition. |
| `model` | no | Optional model pattern/id for the child. |
| `thinking` | no | Optional child thinking level. |
| body | yes | Child system prompt context appended to the normal Volt system prompt. |

Definition sources:

- Built-in subagents for ad hoc delegation, research, design-document planning, and security review.
- `~/.volt/agent/agents/*.md` for user agents.
- `.volt/agents/*.md` for project agents, only when the project is trusted.

Package-managed agent definitions are outside the MVP. If package support is added later, it should use a separately designed `agents` package resource type next to `extensions`, `skills`, `prompts`, and `themes`.

Conflict policy for the MVP reserves built-in names: user and project definitions that use a built-in name are ignored with diagnostics. Project agents override user agents with the same non-built-in name only when project agents are enabled and trusted. If package support is added, use normal package resource ordering for non-built-in names and surface conflicts as diagnostics.

## Architecture

```text
Parent session / TUI / SDK / CLI / app
        |
        v
SubagentManager
        |
        +-- ResourceLoader.getSubagents() -> built-in and named markdown definitions
        |
        +-- child AgentSessionRuntime
                |
                +-- runRpcMode(child runtime, loopback transport)
                        |
                        +-- RpcClient / SubagentHandle
```

### Core components

#### Definition discovery and ResourceLoader

Loads, validates, deduplicates, and reports diagnostics for agent definitions through `ResourceLoader.getSubagents()`.

Responsibilities:

- Parse markdown frontmatter.
- Track source info (`user`, `project` in the MVP).
- Respect project trust.
- Return safe summaries for UI/RPC discovery.
- Avoid exposing local file paths over remote-safe surfaces.

#### SubagentManager

Owns child runtime creation, accounting, and lifecycle.

Responsibilities:

- Create an isolated `AgentSessionRuntime` for each child.
- Bind it to RPC using `createInProcessRpcClient()` for local children.
- Apply model, thinking, system prompt, tool, cwd, and session policy.
- Track active children by `subagentId`.
- Forward child events to callers.
- Dispose idle children when done unless persistence is requested.
- Abort or dispose children on parent shutdown.

#### SubagentHandle

A typed handle returned to callers.

Illustrative shape:

```ts
interface SubagentStartRequest {
  agentName?: string;
  prompt: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: string;
  persistSession?: boolean;
  parentSession?: string;
}

interface SubagentHandle {
  id: string;
  sessionId: string;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  getTranscript(): Promise<unknown>;
  waitForEnd(): Promise<SubagentResult>;
  dispose(): Promise<void>;
  onEvent(listener: (event: SubagentEvent) => void): () => void;
}
```

The implementation uses exported RPC types for state and transcript access.

## Runtime creation policy

A child runtime is a normal Volt runtime with narrowed configuration:

- **Session**: in-memory when the parent is in-memory; persisted beside a persisted parent so child transcripts remain attachable and auditable.
- **Parent tracking**: persisted children set `parentSession` to the parent session file.
- **cwd**: default to parent cwd. Remote visible agents use the stream-bound workspace cwd.
- **Resource loader**: inherit normal user/project resources for the child cwd, subject to project trust.
- **System prompt**: use Volt's normal base prompt plus the selected agent definition appended as extra context.
- **Model/thinking**: definition values are requests. Clamp through existing model registry and thinking-level logic.
- **Tools**: never grant more tools than the parent/host policy allows by default.

Effective tool policy is:

```text
effective child tools = (requested child tools OR inherited parent tools) ∩ parent allowed tools ∩ host allowed tools - excluded tools
```

If no child tools are requested, inherit the parent's active tool set. `excludedTools` can remove capabilities such as `subagent` or `subagent_registry` while preserving the rest of the inherited parent tool posture. Delegation is fail-closed: omitting `allowedSubagents` allows no child names and removes the `subagent` spawning tool from that child. When delegation is available, the child-facing `subagent` description, prompt guidelines, and JSON schema enumerate only definitions permitted by the inherited `allowedSubagents` policy; disallowed names are rejected before any child starts. The spawning tool is omitted when no definition is currently available, including at an inherited depth or zero-child limit. Separately, a child runtime with a `SubagentRuntimeContext` registers `subagent_registry` whenever its explicit tool policy allows it, so list/follow access survives exhausted spawning limits. Every descendant shares one root accounting and cancellation scope. Its default structural spawn safeguards are depth 5, 100 starts, and 16 active descendants; structural admission failures reject new work without aborting admitted descendants. Turn, token, cost, and deadline budgets are unlimited unless the host supplies finite `SubagentManagerOptions.delegationLimits`, in which case crossing one aborts the entire tree. Every limit accepts `Infinity` explicitly. Definition `maxSubagentDepth` values additionally propagate as the strictest inherited cap, while `maxChildAgents` caps total starts for one runtime. Malformed tool/delegation policy fields reject the affected definition instead of silently dropping restrictions. Built-in research and security-review roles are non-mutating locally but include `web_search`, so they can send query text to the configured external search provider. Any future tool escalation must be an explicit host/SDK option, not the default.

## RPC lifecycle

Local core subagents use in-process RPC:

1. Create child `AgentSessionRuntime`.
2. Create `InProcessRpcClient` for that runtime.
3. Send `prompt` with the child prompt.
4. Stream child RPC events to the caller.
5. Retain the latest `agent_end`, then wait for the child `AgentSession` to settle through retries, compaction, and queued continuations.
6. Optionally call `get_state`, `get_transcript`, and `get_session_stats` for final metadata.
7. Dispose or retain the child runtime according to persistence policy.

Cancellation semantics:

- `abort` is the semantic cancellation command.
- Disposing a local handle may abort if the caller requested stop; otherwise it should detach only when a retained runtime exists.
- Parent session shutdown should abort or dispose ephemeral children.
- Remote stream close must continue to mean detach, matching Iroh remote behavior.

Failure semantics:

- First-prompt failures before the start is published (preflight rejections and host runtime-registration commit failures) reject the prompt, roll back the unpublished start (daemon hosts dispose the prepared child runtime), and dispose the handle; nothing is recorded in activities or the registry.
- Model/provider/tool errors are reported through child events and final result metadata.
- Subprocess fallback is outside the MVP.
- Child failures must not crash the parent agent loop.

## Parent- and child-facing tools

Core exposes a `subagent` tool when a `SubagentManager` exists and its current delegation policy has at least one available definition. The tool is active by default for normal local/SDK sessions with an eligible manager, can be disabled through normal tool policy (`--exclude-tools subagent`, `--no-builtin-tools`, or `--no-tools`), and remains subject to strict explicit allowlists when callers pass `tools`. Root sessions retain list/follow on this tool for compatibility. In child runtimes, its schema and guidance are spawn-only:

- Single: `{ "agent": "scout", "task": "Find auth code" }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "..." }] }`, capped at 8 tasks
- Chain: `{ "chain": [{ "agent": "scout", "task": "... {previous}" }] }`, capped at 8 steps

Spawn modes are two-phase when the manager exposes the shared atomic confirmation API. The first request lists the live registry and returns a JSON-safe advisory capacity snapshot for the exact proposal: requested starts; peak width (one for single/chain, up to four for parallel); caller `maxChildAgents` and local-depth headroom; tree start, active-descendant, and depth headroom; `fits`; and machine-readable constraints. Unlimited maxima and remaining values are `null`. The registry reserves a SHA-256 key derived from the normalized mode and ordered agent/task inputs only when the proposal currently fits; a non-fitting request starts nothing, receives no usable token, and is directed to reduce the batch, work locally, or return delegation upward. Exact duplicate agent/task pairs inside one parallel request are rejected before preflight.

Repeating the exact request with `confirm` atomically claims its one-time registry token and reserves the whole batch in `SubagentManager` before any child starts. Admission holds every caller/tree start permit plus only the proposal's peak active width, so sequential chains are not charged as fully concurrent. Direct and competing batch starts account for held permits. Each `startByName()` consumes a pre-reserved caller/tree permit; active permits return to an admitted chain or parallel worker as children settle. Starts that created a child remain consumed, while unused permits are refunded after pre-creation failure, abort, early chain termination, or tool settlement. Capacity changes between preflight and confirmation return a structured `admission-rejected` result stating that zero children started; provider/runtime/child failures after admission remain ordinary per-task failures with child metadata.

A standard `subagent_registry` tool is registered only for runtimes whose manager has a `SubagentRuntimeContext`, independently of whether spawning is currently available. It supports:

- List: `{ "list": true }` or `{ "list": true, "cursor": 42 }` — a bounded newest-first page of delegated runs in the session-wide registry, paginated by immutable registration-sequence cursor
- Follow: `{ "follow": "sa_..." }` — an existing run's result, waiting while it is still running

`subagent` and `subagent_registry` are separate policy names. Explicit allowlists and exclusions can enable or disable either capability without implicitly widening the other. The spawn tool's internal preflight uses its manager's registry directly, so disabling the child-facing `subagent_registry` tool does not bypass confirmation.

The session-wide registry (`SubagentRegistry`) is owned by the root session's manager and shared with every descendant runtime through the subagent context, alongside the delegation scope. A start is recorded only once its first prompt passes preflight; the record captures id, parent id, agent, path, bounded task prompt, and status, and terminal transitions attach the bounded final assistant output. Starts that never prompt or whose first prompt is rejected before acceptance leave no record. The same registry owns pending and claimed exact-request confirmation reservations. Reservation preparation lists and reserves synchronously, so concurrent identical requests across separate branches cannot receive independent tokens; a claimed reservation remains held until its tool call settles. Pending reservations expire after five minutes. This gives sideways visibility that the parent/child activity ledgers cannot: any branch can discover cousin runs and follow their results instead of duplicating work. Follow waits are deadlock-checked against a dependency graph of parent-awaits-child edges plus active follow edges; waits that close a cycle (following an ancestor, mutual sibling follows) are rejected. Terminal records are evicted oldest-first past a cap; running records are never evicted. List results return up to 50 complete rows newest first within the aggregate byte limit and include the next registration-sequence cursor when more records remain; because sequences are immutable, later pages never duplicate or skip records as runs change state. Definition-backed children receive a bounded start-time snapshot of recorded runs only when `subagent_registry` is active (and the snapshot is non-empty), so prompt guidance never advertises an unavailable tool.

The tool result returns:

- final child output visible to the parent model
- child agent name/source
- status (`completed`, `failed`, `aborted`)
- child session id when available
- bounded transcript/tool summary
- usage and cost when available
- advisory or admitted capacity phase, proposal, headroom, fit, and constraints when confirmation is enabled

Model-visible output is capped at 50 KB per task/step, while parallel results and registry list pages have a 100 KB aggregate cap; details payloads additionally bound task entries and retained output text so unbounded task counts stay under remote frame limits. Chain `{previous}` substitution uses that bounded output, XML-escapes it, and wraps it as untrusted prior data instead of forwarding raw child text. Delegation tool calls have no automatic deadline or turn/token/cost budget by default. The shared scope always accounts for consumption and applies the default structural depth/start/active-descendant safeguards; finite host-provided `maxTurns`, `maxTotalTokens`, `maxTotalCostUsd`, or `maxDurationMs` values opt into whole-tree aborts. SDK callers may also opt into a call-specific `runTimeoutMs`, and users or parents can cancel explicitly. Full child output remains in child session state when available; tool details include status, usage, truncation, error metadata, and a final snapshot of tree-wide accounting.

## Public RPC surface

There are two separate use cases.

### Visible app agents

App-visible agents use existing Iroh conversation streams:

1. App opens `conversation.target: "new"` or `"session"`.
2. Host returns the concrete workspace/session identity.
3. App validates with `get_state` and `get_transcript`.
4. App sends `prompt` when an initial prompt is provided.
5. App uses `agent_end` for per-run transcript updates and `agent_settled` as the terminal signal after retries, compaction, and queued continuations.

The MVP intentionally avoids an `initialPrompt` handshake field or any other Iroh protocol change.

### Nested subagents over one local RPC connection

Local RPC clients can multiplex definition-backed subagents on one RPC connection:

```json
{"type":"list_subagents"}
{"type":"subagent_start","agent":"scout","prompt":"Find auth code"}
{"type":"subagent_abort","subagentId":"sa_123"}
{"type":"subagent_get_state","subagentId":"sa_123"}
{"type":"subagent_get_transcript","subagentId":"sa_123"}
{"type":"subagent_dispose","subagentId":"sa_123"}
```

Child events wrap normal child RPC events:

```json
{"type":"subagent_event","subagentId":"sa_123","event":{"type":"message_update", "...":"..."}}
{"type":"subagent_end","subagentId":"sa_123","result":{"id":"sa_123","sessionId":"child-session-id","event":{"type":"agent_end","messages":[],"willRetry":false}}}
```

`list_subagents` returns safe summaries only; it omits definition file paths, source paths, base directories, and system prompts. Active RPC-started children are scoped to the RPC connection/runtime and are disposed on RPC shutdown or parent session replacement.

These lifecycle commands are local RPC only. Iroh remote transports reject them until a separate remote policy slice defines allowlist, ownership, and redaction rules.

## TUI behavior

The parent tool row stays compact:

- Show child agent name, status, model, and task.
- Stream aggregate progress for single, parallel, and chain calls.
- Support collapsed and expanded result views.
- Show usage summary when complete.
- Propagate Escape/Ctrl+C through the parent abort path to active ephemeral children.

While a child runs, the interactive TUI streams its conversation live inline in the transcript, mirroring how `/review` renders its isolated session: each running activity gets a bordered group (agent name plus first task line in the header) that reuses the normal assistant-message and tool-execution components. The group is display-only and transient — it is removed when the child finishes, at which point the parent tool result summarizes the outcome. If a full transcript re-render drops a live group mid-run, it is rebuilt from the activity's retained events on the next notification.

The interactive TUI also owns a bounded activity ledger for the current runtime. `/subagents` or `Alt+A` opens a live inspector that:

- lists active children first while retaining recently completed children after their handles are disposed;
- drills into a child conversation with chronological assistant messages, tool arguments, status, and bounded output previews;
- follows a running child until the user scrolls away;
- uses the configurable selection, paging, and cancel keybindings and bounds its viewport for narrow terminals.

Later TUI commands can add:

- `/agents` to list available definitions.
- `/agent <name> <prompt>` to run a visible child session.
- Session tree links from parent tool result to child session file.

## App behavior

The iOS app uses `IrohHostConnectionPool.openConversationStream(target: .new | .session)` for visible agents. Starting a new remote agent with an initial prompt follows the existing two-step flow:

1. open a new conversation stream for the workspace;
2. validate `get_state` and `get_transcript` against the stream identity;
3. send `prompt` on that stream when the optional initial prompt is non-empty;
4. render events in the new pinned agent tab;
5. use `agent_end` for per-run transcript updates and `agent_settled` or notification completion as the terminal boundary.

This keeps stream selection, identity validation, detach, reconnect, and abort behavior aligned with the existing remote protocol. If the prompt send fails after agent creation, the selected new agent remains active and the app records a clear system message.

## Security and trust

Subagents do not create a new security boundary.

Required rules:

- Project agent definitions load only when the project is trusted.
- Child tools are clamped by parent and host tool policy.
- Remote paired-client `allowedTools` continues to apply to any child or visible agent in that workspace.
- Child cwd defaults to parent cwd; remote children stay within the host-selected workspace model.
- Agent definitions are prompts and can contain prompt injection. Treat project definitions like other project resources. Built-in names are reserved so trusted projects cannot silently replace built-in role semantics.
- Do not expose definition file paths, host session file paths, provider credentials, or raw tool output through remote-safe discovery.
- Explicit cancellation is `abort`; stream/transport close should not silently cancel retained remote work.

## Persistence model

MVP defaults:

- Tool-style child subagents follow parent persistence: in-memory parents create in-memory children, while persisted parents create persisted child sessions with parent linkage.
- App-visible agents are persistent normal sessions, because reconnect and transcript recovery depend on session files.
- Persistent child sessions record `parentSession` when a parent session file exists.
- Parent tool results include child `sessionId` but do not rely on child session files for correctness.

Deferred options:

- A setting to persist all subagent sessions for auditability.
- Session metadata tagging such as `createdBy: "subagent"` and `parentEntryId`.
- A session selector filter for subagent sessions.

## Implementation status

### Implemented in the local MVP

- Built-in `general`, `researcher`, `design-doc`, and `security-reviewer` subagents plus agent definition parsing and discovery for user/project markdown files.
- `ResourceLoader.getSubagents()` with diagnostics and source info.
- `SubagentManager` using `createInProcessRpcClient()` and isolated child runtimes.
- Definition-backed starts with system prompt, tools, model, and thinking configuration applied to child sessions.
- Parent/session tool policy clamping for child tools.
- Built-in `subagent` spawning tool and child-only `subagent_registry` tool backed by shared `SubagentManager` registry behavior.
- Single, parallel, and chain spawning modes with shared registry preflight/confirmation, exact concurrent-request reservation, duplicate parallel-item rejection, bounded/paginated registry list, and deadlock-checked follow modes, with output truncation and usage/status details.
- Compact TUI rendering and live progress updates for built-in `subagent` tool calls.
- Live `/subagents` inspector with bounded active/completed activity retention, conversation drill-down, and tool-flow rendering.
- Local RPC commands: `list_subagents`, `subagent_start`, `subagent_abort`, `subagent_get_state`, `subagent_get_transcript`, and `subagent_dispose`.
- App convenience for "new agent with initial prompt" using the existing open-stream-then-prompt sequence.

### Deferred beyond the MVP

- Package-manager `agents` resources.
- Subprocess fallback or JSON-mode child parsing.
- Remote/Iroh subagent lifecycle commands.
- Iroh handshake/protocol changes such as `initialPrompt` in the handshake.
- App-native subagent action cards or command surfaces.
- CLI-visible child-agent commands beyond the existing local RPC/tool surfaces.

## Testing plan

Unit tests:

- frontmatter parsing and validation
- user/project precedence and trust behavior
- effective tool policy intersection
- lifecycle state transitions
- output truncation
- abort propagation
- child cleanup on parent shutdown
- retained activity snapshots and live/narrow TUI inspector navigation

Integration tests:

- run a child through in-process RPC with the faux provider
- parent `subagent` tool receives child final output
- max-depth children omit `subagent` spawning while retaining callable `subagent_registry` list/follow access
- registry tool calls project through stdio, loopback, and Iroh as ordinary tool events
- concurrent identical spawn requests across separate tool instances share one atomic registry reservation
- advisory preflight exposes caller/tree headroom and issues no token when the whole proposal cannot fit
- confirmation atomically reserves caller starts, tree starts, and peak active width so competing batches cannot partially start
- unused admission permits return after abort, pre-creation failure, and early chain termination
- parallel children respect concurrency limits
- child provider/tool errors do not crash parent runtime
- app-visible sessions keep the selected workspace/session identity through the existing remote flow

Remote/app tests:

- open new conversation stream, send optional initial prompt, receive per-run `agent_end` and terminal `agent_settled`
- empty initial prompt preserves no-prompt new-agent behavior
- initial prompt send failure keeps the new agent selected and records a system message
- stream close detaches without aborting
- explicit abort stops selected stream only
- transcript recovery after reconnect
- remote command allowlist rejects subagent lifecycle commands until explicitly enabled

## Remaining design questions

- Should child sessions ever be persisted by default for auditability despite extra session noise?
- Should core support path-scoped write/edit policy for future writable roles beyond today's tool-name allowlists?
- Should package-managed subagents use package resource ordering exactly, or a narrower precedence policy?
- What CLI-visible child-agent command surface is worth adding beyond local RPC and the built-in tool?
- What remote policy would make subagent discovery and lifecycle commands safe over Iroh without exposing local paths, prompts, raw tool output, or extra cancellation authority?
