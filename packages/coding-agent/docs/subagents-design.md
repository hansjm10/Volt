# Core Subagents Design

## Status

Local MVP implemented. This document records the supported boundary for core subagents and the work intentionally deferred beyond the MVP.

Implemented surfaces:

- Built-in `general` definition and markdown definition discovery through `ResourceLoader.getSubagents()`.
- `SubagentManager` for isolated in-process child runtimes.
- Built-in `subagent` tool with single, parallel, and chain modes, active by default when a `SubagentManager` exists.
- Local RPC lifecycle commands for definition-backed subagents.
- App-visible "new agent with initial prompt" flow through existing Iroh conversation streams followed by `prompt`.

Not implemented in this MVP: package-manager `agents` resources, subprocess fallback, remote/Iroh subagent lifecycle commands, protocol handshake changes, app-native subagent action surfaces, or tool modes beyond single/parallel/chain.

## Summary

Core subagents are isolated Volt agent runtimes controlled through the existing RPC stack. A local caller in the TUI, SDK, CLI, extension system, or local RPC mode can request a child agent, pass it a prompt, stream its events, and wait for a terminal `agent_end` or cancellation signal.

The implementation reuses Volt's existing primitives instead of introducing a second agent protocol:

- `AgentSessionRuntime` creates isolated sessions.
- `runRpcMode()` runs a runtime over a transport.
- `createLoopbackRpcTransportPair()` and `createInProcessRpcClient()` provide same-process RPC for local subagents.
- Iroh conversation streams already provide remote multi-agent streams for the app.
- Existing RPC `prompt`, `abort`, `get_state`, `get_transcript`, and `agent_end` semantics remain the lifecycle contract.

The [`examples/extensions/subagent/`](../examples/extensions/subagent/) implementation remains the reference prototype for workflow shape. The core MVP avoids subprocess and JSON-mode parsing fallback.

## Existing building blocks

- **RPC mode** ([rpc.md](rpc.md)): accepts prompts, streams events, and reports completion with `agent_end`.
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
- No plan-mode or task-manager policy baked into core.
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
tools: read, grep, find, ls
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
| `model` | no | Optional model pattern/id for the child. |
| `thinking` | no | Optional child thinking level. |
| body | yes | Child system prompt context appended to the normal Volt system prompt. |

Definition sources:

- Built-in `general` subagent for ad hoc delegated tasks.
- `~/.volt/agent/agents/*.md` for user agents.
- `.volt/agents/*.md` for project agents, only when the project is trusted.

Package-managed agent definitions are outside the MVP. If package support is added later, it should use a separately designed `agents` package resource type next to `extensions`, `skills`, `prompts`, and `themes`.

Conflict policy for the MVP matches the extension prototype, with built-ins at the lowest precedence: user agents override built-in agents, and project agents override user agents with the same name only when project agents are enabled and trusted. If package support is added, use normal package resource ordering and surface conflicts as diagnostics.

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

Owns child runtime creation, limits, and lifecycle.

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

- **Session**: in-memory by default for tool-style delegation; persistent when visible to app/CLI or when requested.
- **Parent tracking**: persistent children should set `parentSession` to the parent session file when that mode is added.
- **cwd**: default to parent cwd. Remote visible agents use the stream-bound workspace cwd.
- **Resource loader**: inherit normal user/project resources for the child cwd, subject to project trust.
- **System prompt**: use Volt's normal base prompt plus the selected agent definition appended as extra context.
- **Model/thinking**: definition values are requests. Clamp through existing model registry and thinking-level logic.
- **Tools**: never grant more tools than the parent/host policy allows by default.

Effective tool policy is:

```text
effective child tools = requested child tools ∩ parent allowed tools ∩ host allowed tools - excluded tools
```

If no child tools are requested, inherit the parent's active tool set. Any future tool escalation must be an explicit host/SDK option, not the default.

## RPC lifecycle

Local core subagents use in-process RPC:

1. Create child `AgentSessionRuntime`.
2. Create `InProcessRpcClient` for that runtime.
3. Send `prompt` with the child prompt.
4. Stream child RPC events to the caller.
5. Treat `agent_end` with `willRetry !== true` as run completion.
6. Optionally call `get_state`, `get_transcript`, and `get_session_stats` for final metadata.
7. Dispose or retain the child runtime according to persistence policy.

Cancellation semantics:

- `abort` is the semantic cancellation command.
- Disposing a local handle may abort if the caller requested stop; otherwise it should detach only when a retained runtime exists.
- Parent session shutdown should abort or dispose ephemeral children.
- Remote stream close must continue to mean detach, matching Iroh remote behavior.

Failure semantics:

- Prompt preflight failures reject the start request.
- Model/provider/tool errors are reported through child events and final result metadata.
- Subprocess fallback is outside the MVP.
- Child failures must not crash the parent agent loop.

## Parent-facing tool

Core exposes a `subagent` tool when a `SubagentManager` exists. The tool is active by default for normal local/SDK sessions with a manager, can be disabled through normal tool policy (`--exclude-tools subagent`, `--no-builtin-tools`, or `--no-tools`), and remains subject to strict explicit allowlists when callers pass `tools`.

Supported MVP modes:

- Single: `{ "agent": "scout", "task": "Find auth code" }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "..." }] }`
- Chain: `{ "chain": [{ "agent": "scout", "task": "... {previous}" }] }`

The tool result returns:

- final child output visible to the parent model
- child agent name/source
- status (`completed`, `failed`, `aborted`)
- child session id when available
- bounded transcript/tool summary
- usage and cost when available

Model-visible output is capped at 50 KB per task/step. Full child output remains in child session state when available; tool details include status, usage, truncation, and error metadata.

## Public RPC surface

There are two separate use cases.

### Visible app agents

App-visible agents use existing Iroh conversation streams:

1. App opens `conversation.target: "new"` or `"session"`.
2. Host returns the concrete workspace/session identity.
3. App validates with `get_state` and `get_transcript`.
4. App sends `prompt` when an initial prompt is provided.
5. App listens for `agent_end` and transcript updates.

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

The initial TUI surface can be tool rendering only:

- Show child agent name, status, model, and task.
- Stream child tool calls and text deltas into the parent tool row.
- Support collapsed and expanded views.
- Show usage summary when complete.
- Propagate Escape/Ctrl+C through the parent abort path to active ephemeral children.

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
5. listen for `agent_end` or notification completion.

This keeps stream selection, identity validation, detach, reconnect, and abort behavior aligned with the existing remote protocol. If the prompt send fails after agent creation, the selected new agent remains active and the app records a clear system message.

## Security and trust

Subagents do not create a new security boundary.

Required rules:

- Project agent definitions load only when the project is trusted.
- Child tools are clamped by parent and host tool policy.
- Remote paired-client `allowedTools` continues to apply to any child or visible agent in that workspace.
- Child cwd defaults to parent cwd; remote children stay within the host-selected workspace model.
- Agent definitions are prompts and can contain prompt injection. Treat project definitions like other project resources.
- Do not expose definition file paths, host session file paths, provider credentials, or raw tool output through remote-safe discovery.
- Explicit cancellation is `abort`; stream/transport close should not silently cancel retained remote work.

## Persistence model

MVP defaults:

- Tool-style child subagents are ephemeral/in-memory.
- App-visible agents are persistent normal sessions, because reconnect and transcript recovery depend on session files.
- Persistent child sessions should record `parentSession` when that mode is added and a parent session file exists.
- Parent tool results include child `sessionId` but do not rely on child session files for correctness.

Deferred options:

- A setting to persist all subagent sessions for auditability.
- Session metadata tagging such as `createdBy: "subagent"` and `parentEntryId`.
- A session selector filter for subagent sessions.

## Implementation status

### Implemented in the local MVP

- Built-in `general` subagent plus agent definition parsing and discovery for user/project markdown files.
- `ResourceLoader.getSubagents()` with diagnostics and source info.
- `SubagentManager` using `createInProcessRpcClient()` and isolated child runtimes.
- Definition-backed starts with system prompt, tools, model, and thinking configuration applied to child sessions.
- Parent/session tool policy clamping for child tools.
- Built-in `subagent` tool backed by `SubagentManager`.
- Single, parallel, and chain modes with output truncation and usage/status details.
- Compact TUI rendering and live progress updates for built-in `subagent` tool calls.
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

Integration tests:

- run a child through in-process RPC with the faux provider
- parent `subagent` tool receives child final output
- parallel children respect concurrency limits
- child provider/tool errors do not crash parent runtime
- app-visible sessions keep the selected workspace/session identity through the existing remote flow

Remote/app tests:

- open new conversation stream, send optional initial prompt, receive `agent_end`
- empty initial prompt preserves no-prompt new-agent behavior
- initial prompt send failure keeps the new agent selected and records a system message
- stream close detaches without aborting
- explicit abort stops selected stream only
- transcript recovery after reconnect
- remote command allowlist rejects subagent lifecycle commands until explicitly enabled

## Remaining design questions

- Should child sessions ever be persisted by default for auditability despite extra session noise?
- Should package-managed subagents use package resource ordering exactly, or a narrower precedence policy?
- What CLI-visible child-agent command surface is worth adding beyond local RPC and the built-in tool?
- What remote policy would make subagent discovery and lifecycle commands safe over Iroh without exposing local paths, prompts, raw tool output, or extra cancellation authority?
