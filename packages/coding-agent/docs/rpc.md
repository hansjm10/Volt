# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@hansjm10/volt-coding-agent` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For typed RPC clients, use [`RpcClient`](../src/modes/rpc/rpc-client.ts) for subprocess stdio, [`RpcTransportClient`](../src/modes/rpc/rpc-transport-client.ts) for caller-provided transports, or [`createInProcessRpcClient`](../src/modes/rpc/in-process-rpc-client.ts) to run RPC mode in the same process.

## Starting RPC Mode

```bash
volt --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Directory containing the authoritative `sessions.sqlite` store

RPC session state, lists, and mutation commands use stable session IDs. They do not expose or accept live store paths.

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

Commands support an `id` field for request/response correlation. It is required for `invoke_ui_action` (and for `report_stream_discontinuity`) and optional for other commands. An `invoke_ui_action` id must be trimmed, non-empty, and at most 256 UTF-8 bytes. Every success or command-level failure response produced for a valid invocation carries that exact `id`; a transport failure can prevent delivery. A known `invoke_ui_action` payload whose required id is missing or unusable receives an uncorrelated failure with `command: "invalid"` and no `id`—never an id-less response tagged `invoke_ui_action`.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

### Lifecycle and Cancellation

Transport lifetime is separate from cancellation semantics. A clean input close, socket close, stream EOF, or write failure is a transport event, not an RPC command, and must not be interpreted as an implicit `abort`.

Clients that intend to stop active agent work must send the `abort` command and wait for its response. Plain subprocess RPC mode still treats transport close as mode/process shutdown, and remote transports may use close as detach/reconnect; neither path changes the RPC cancellation command.

RPC mode is not durable job recovery. If the Volt process or embedding host process exits or crashes, in-memory work stops; clients can only reopen persisted session state that was written before exit.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `volt.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

`abort` is the semantic cancellation command. Closing the RPC transport without sending `abort` requests transport shutdown or remote detach according to the transport, but it does not ask Volt to cancel the active run.

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional stable parent identity:
```json
{"type": "new_session", "parentSessionId": "parent-session-id"}
```

`parentSessionId` must identify a session in the active store. The new session receives its own stable ID; refresh with `get_state` after a successful replacement.

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "availableThinkingLevels": ["off", "minimal", "low", "medium", "high"],
    "fastModeEnabled": true,
    "planning": {"mode": "build", "plan": null},
    "gitContext": {
      "repository": "volt",
      "head": {"kind": "branch", "name": "feat/rpc-git-context", "oid": "0123456789abcdef0123456789abcdef01234567"},
      "upstream": {"ref": "origin/feat/rpc-git-context", "ahead": 2, "behind": 0},
      "base": {"ref": "origin/main", "ahead": 3, "behind": 0},
      "status": {
        "staged": {"added": 1, "modified": 0, "deleted": 0, "renamed": 0},
        "unstaged": {"added": 0, "modified": 1, "deleted": 0, "renamed": 0},
        "untracked": 0,
        "conflicted": 0,
        "total": 2,
        "clean": false
      },
      "operation": null,
      "revision": 4,
      "observedAt": "2026-07-29T17:00:00.000Z",
      "stale": false
    },
    "isStreaming": false,
    "isBusy": true,
    "isCompacting": true,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0,
    "activeCompaction": {"reason": "threshold", "startedAt": 1782470400000}
  }
}
```

The `model` field is a full [Model](#model) object or `null`. `availableThinkingLevels` lists the thinking levels the current model supports (`["off"]` for non-reasoning models). `fastModeEnabled` is the authoritative branch-local Fast state used by initial and replacement conversation bootstraps. `isStreaming` indicates an active provider run or session-level continuation; `isBusy` also includes asynchronous prompt preflight and standalone session operations such as manual compaction and tree navigation. `sessionId` is the stable identity used by session switch and resume commands. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set. `activeCompaction` is present only while context compaction is currently running; `startedAt` is Unix epoch milliseconds.

`gitContext` is a required nullable field read from a host-owned cache; `get_state` never waits for Git. It is `null` when the session cwd is not a usable Git worktree or before an initial scan has succeeded. A non-null value has these semantics:

- `repository` is a bounded display name derived from the common Git repository, or a trusted host workspace-name override. It is never an absolute path or remote URL.
- `head` is one of `{kind:"branch",name,oid}`, `{kind:"detached",oid}`, or `{kind:"unborn",name}`. Object IDs accept both SHA-1 and SHA-256 forms.
- `upstream` is the local tracking-ref comparison from porcelain-v2 status, or `null`. `base` is the optional managed-worktree comparison against its recorded local base ref, or `null`. Both report `ahead` and `behind`; the base comparison is computed against the HEAD object ID captured by the same scan.
- `status.staged` and `status.unstaged` independently count added, modified, deleted, and renamed paths. A path changed in both index and worktree contributes to both groups but only once to `total`. Copies count as added, type changes count as modified, conflicts are counted only in `conflicted`, ignored paths are excluded, and `clean` is equivalent to `total === 0`.
- `operation` is `null` or a host-detected merge, rebase, cherry-pick, revert, bisect, or sequencer operation. Rebase metadata may include `step` and `total`.
- `revision` is monotonic only for one provider lifetime. `observedAt` advances only after a complete successful scan. On a later scan failure, Volt retains the last good value, increments its revision once, and sets `stale:true`; recovery emits another replacement with `stale:false`.

Collection is local-only and performs no fetch. It uses bounded, fixed-argument Git reads and never includes changed path names, absolute checkout paths, remote URLs, credentials, or diff content. Live `gitContext` is not persisted. A newly created session may additionally expose optional `startingGitContext`, which is the first definitive path-free observation (`null` for a definitive non-Git cwd) stored as one strictly validated host-only `session_start_git_context` entry in SQLite. That entry never enters model context, transcript projection, extension prompts, handshake `remoteHost`, or host-global metadata.

#### get_transcript

Get a UI-ready projected transcript for the active session. The response is ordered oldest-to-newest and omits raw provider payloads, thinking blocks, image data, raw tool output, full file contents, and host store paths. Text, summaries, and mutation previews are bounded.

```json
{"type": "get_transcript", "limit": 100}
```

Use `beforeEntryId` to request older items than the first item already loaded:

```json
{"type": "get_transcript", "limit": 100, "beforeEntryId": "entry-id"}
```

`limit` defaults to 100 and is capped at 200.

Response:
```json
{
  "type": "response",
  "command": "get_transcript",
  "success": true,
  "data": {
    "sessionId": "abc123",
    "items": [
      {"id": "entry-user", "role": "user", "text": "User prompt", "timestamp": "2026-06-22T15:00:00.000Z"},
      {"id": "entry-assistant", "role": "assistant", "text": "Assistant response", "timestamp": "2026-06-22T15:01:00.000Z"},
      {"id": "entry-tool", "role": "tool", "toolName": "read", "status": "completed", "path": "src/file.ts", "summary": "Read src/file.ts (completed)", "timestamp": "2026-06-22T15:01:30.000Z"},
      {"id": "entry-summary", "role": "summary", "title": "Conversation compacted", "text": "Earlier conversation summary...", "timestamp": "2026-06-22T15:02:00.000Z"}
    ],
    "hasMore": false,
    "nextBeforeEntryId": null
  }
}
```

Tool items may include bounded `diffPreview` and `patchPreview` fields for mutation tools. `subagent` spawning calls and child-only `subagent_registry` list/follow calls include the same bounded subagent argument/detail projection used by live tool events, including registry pagination summaries.

Recommended resume flow for remote or headless UI clients:

1. After a successful connection or reconnect, send `get_state`, then `get_transcript` for the active persisted session.
2. After a successful `switch_session_by_id`, clear or replace the visible transcript with a loading state, refresh with `get_state`, then call `get_transcript` for the selected session.
3. After a successful `new_session`, refresh state only and keep the fresh empty transcript; do not reuse or load older transcript from the previous session.
4. For pagination, keep `hasMore` and `nextBeforeEntryId`; when `hasMore` is true, request older items with `beforeEntryId` and prepend returned items by stable `id`.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

### Subagents (local RPC only)

Local RPC clients can manage definition-backed subagents over the same connection. These commands are local RPC only for now; Iroh remote transports reject them until a later explicit remote policy slice.

#### list_subagents

List built-in and discovered subagent definition summaries. The response omits definition file paths, source paths, base directories, and system prompts.

```json
{"type": "list_subagents"}
```

Response:
```json
{
  "type": "response",
  "command": "list_subagents",
  "success": true,
  "data": {
    "subagents": [
      {
        "name": "scout",
        "description": "Fast codebase reconnaissance",
        "source": "project",
        "sourceInfo": {"source": "local", "scope": "project", "origin": "top-level"},
        "tools": ["read", "grep", "find", "ls"],
        "model": "claude-haiku-4-5",
        "thinking": "off"
      }
    ]
  }
}
```

#### subagent_start

Start a definition-backed child subagent, send its initial prompt, and return after the prompt is accepted. Child tools are clamped by the current parent/session tool policy.

```json
{"type": "subagent_start", "agent": "scout", "prompt": "Find auth code"}
```

Response:
```json
{
  "type": "response",
  "command": "subagent_start",
  "success": true,
  "data": {"subagentId": "sa_123", "sessionId": "child-session-id"}
}
```

Child events are wrapped on the parent RPC stream:

```json
{"type": "subagent_event", "subagentId": "sa_123", "event": {"type": "agent_start"}}
{"type": "subagent_end", "subagentId": "sa_123", "result": {"id": "sa_123", "sessionId": "child-session-id", "status": "completed", "event": {"type": "agent_end", "messages": [], "willRetry": false}}}
```

`subagent_event.event` is the child RPC event. `subagent_end.result` is emitted after the child session settles, including automatic retries, overflow compaction, and queued continuations. Its required `status` is the authoritative terminal outcome: `"completed"`, `"failed"`, or `"aborted"`. The optional `error` field supplies terminal failure detail when available. Clients must not infer the terminal outcome from the nested `event` or its assistant stop reasons: that latest low-level `agent_end` retains attempt history and can contain an error from a retry that was subsequently aborted. `event.willRetry` is normalized to `false` if a planned retry was cancelled before another run started.

When the host releases a subagent — after `subagent_abort`/`subagent_dispose`, when `subagent_start` fails after accepting the child, or when a session switch disposes all active subagents — it emits a terminal frame (possibly after `subagent_end`); no further frames follow for that `subagentId`:

```json
{"type": "subagent_disposed", "subagentId": "sa_123"}
```

#### subagent_abort

Abort and dispose a local RPC-managed subagent.

```json
{"type": "subagent_abort", "subagentId": "sa_123"}
```

Response:
```json
{"type": "response", "command": "subagent_abort", "success": true}
```

#### subagent_get_state

Get the child session state for an active local RPC-managed subagent.

```json
{"type": "subagent_get_state", "subagentId": "sa_123"}
```

Response data uses the same shape as [`get_state`](#get_state).

#### subagent_get_transcript

Get the child transcript projection for an active local RPC-managed subagent.

```json
{"type": "subagent_get_transcript", "subagentId": "sa_123", "limit": 100, "beforeEntryId": "entry-id"}
```

Response data uses the same shape as [`get_transcript`](#get_transcript).

#### subagent_dispose

Dispose a local RPC-managed subagent and remove it from this RPC connection's active subagent map. Later commands for the same `subagentId` fail with the normal RPC error shape.

```json
{"type": "subagent_dispose", "subagentId": "sa_123"}
```

Response:
```json
{"type": "response", "command": "subagent_dispose", "success": true}
```

Active RPC-started subagents are scoped to the RPC connection/runtime and are disposed on RPC shutdown and session replacement.

### MCP management

Local RPC clients can inspect and manage configured MCP servers. Iroh remote transports allow only the remote-safe subset: capabilities, list/get server status, recent calls, disconnect, and device-code auth start/poll/cancel.

#### get_mcp_capabilities

```json
{"type": "get_mcp_capabilities"}
```

Response data:

```json
{"protocolVersion": 1, "features": ["mcp_management.v1", "mcp_oauth.v1", "mcp_device_auth.v1", "mcp_events.v1"], "remoteSafeByDefault": ["list_mcp_servers", "get_mcp_server", "list_mcp_recent_calls", "disconnect_mcp_server", "start_mcp_server_auth", "poll_mcp_server_auth", "cancel_mcp_server_auth"]}
```

#### list_mcp_servers / get_mcp_server

```json
{"type": "list_mcp_servers"}
{"type": "get_mcp_server", "server": "github"}
```

Responses return sanitized server summaries with status, auth state, transport/lifecycle, tool counts, capabilities, and recent call summaries. File paths, raw env, headers, tokens, and schemas are omitted.

#### connect_mcp_server / refresh_mcp_server / disconnect_mcp_server / set_mcp_server_enabled

```json
{"type": "connect_mcp_server", "server": "github"}
{"type": "refresh_mcp_server", "server": "github"}
{"type": "disconnect_mcp_server", "server": "github"}
{"type": "set_mcp_server_enabled", "server": "github", "enabled": false}
```

`connect_mcp_server` and `refresh_mcp_server` connect to the MCP server and refresh cached metadata; they are local RPC only. `disconnect_mcp_server` closes a live connection. `set_mcp_server_enabled` persists an overlay in the relevant Volt-owned MCP config file and is local RPC only.

#### MCP OAuth auth

Browser auth-code + PKCE is local RPC only:

```json
{"type": "start_mcp_server_auth", "server": "linear", "flow": "browser", "redirectUrl": "http://127.0.0.1:49152/mcp/oauth/callback/random"}
{"type": "complete_mcp_server_auth", "server": "linear", "redirectUrl": "http://127.0.0.1:49152/mcp/oauth/callback/random", "code": "...", "state": "..."}
```

Device-code auth can be started and polled over local RPC or Iroh remote transports:

```json
{"type": "start_mcp_server_auth", "server": "linear", "flow": "device"}
{"type": "poll_mcp_server_auth", "server": "linear"}
{"type": "cancel_mcp_server_auth", "server": "linear"}
```

`start_mcp_server_auth` with `flow: "device"` returns `verificationUri`, optional `verificationUriComplete`, `userCode`, `expiresAt`, and `intervalMs`; it never returns the OAuth `device_code`. Tokens stay on the host in MCP OAuth storage. `logout_mcp_server` clears stored OAuth credentials and is local RPC only.

#### list_mcp_tools / get_mcp_tool

```json
{"type": "list_mcp_tools", "server": "github"}
{"type": "get_mcp_tool", "server": "github", "tool": "search_issues"}
```

Returns sanitized tool metadata, risk classification, metadata hash, stale flag, and whether the tool is currently promoted as a direct tool.

#### list_mcp_resources / read_mcp_resource

```json
{"type": "list_mcp_resources", "server": "docs"}
{"type": "read_mcp_resource", "server": "docs", "resourceUri": "file:///guide.md"}
```

Resource contents are returned through the same truncation/cache shaping as the `mcp` gateway. Remote transports do not expose resource listing or content reads by default because those operations can start MCP backends.

#### list_mcp_prompts / get_mcp_prompt

```json
{"type": "list_mcp_prompts", "server": "prompts"}
{"type": "get_mcp_prompt", "server": "prompts", "prompt": "review", "arguments": {"focus": "security"}}
```

Prompt content is available for user-initiated preview when prompts are not disabled; model-initiated access still requires `settings.prompts: "model"`. Remote transports do not expose prompt listing or content reads by default because those operations can start MCP backends.

#### list_mcp_recent_calls

```json
{"type": "list_mcp_recent_calls"}
{"type": "list_mcp_recent_calls", "server": "github"}
```

Returns bounded recent MCP tool-call summaries for one server or all servers.

### Native UI Actions

Native UI action commands let typed clients discover host-owned actions for native cards, buttons, toggles, pickers, and command palettes. They are distinct from raw slash command strings: slash commands are presentation aliases, while action ids are the invocation contract.

The current local RPC implementation exposes the v1 protocol shape, sanitized palette descriptors, shared built-in actions, review cards, Fast mode, and prompt-like invocation for extension commands, prompt templates, and skills. Iroh remote transports allow discovery plus `invoke_ui_action` for the currently advertised remote-safe built-in, review, Fast mode, projected extension command, prompt template, and skill actions. Local-only built-ins and unreviewed action ids remain blocked remotely.

Native clients should treat this as an optional capability:

1. Call `get_ui_capabilities`.
2. If `ui_actions.v1` is present, call `get_ui_actions` and render descriptors that the client supports.
3. If `ui_action_invocation.v1` is present, invoke by descriptor `id` with `invoke_ui_action`.
4. Keep raw `prompt` slash-text submission as compatibility for clients or hosts that do not expose native actions.

`scope` defaults to `"all"`. In v1, `scope: "primary"` returns built-in cards and toggles such as Review and Fast mode. `scope: "palette"` returns descriptors with `presentation.kind: "palette"`, including searchable built-ins, extension commands, prompt templates, and skills. `scope: "all"` lets a client build both surfaces from one response.

#### get_ui_capabilities

Get supported native UI action protocol features.

```json
{"type": "get_ui_capabilities"}
```

Response:
```json
{
  "type": "response",
  "command": "get_ui_capabilities",
  "success": true,
  "data": {
    "protocolVersion": 1,
    "features": ["ui_actions.v1", "ui_action_invocation.v1", "ui_action_completions.v1"],
    "maxActions": 200,
    "maxDescriptorBytes": 65536
  }
}
```

`ui_actions.v1` means the host understands `get_ui_actions` descriptors. `ui_action_invocation.v1` means the host accepts `invoke_ui_action` for currently advertised actions. `ui_action_completions.v1` means the host accepts `get_ui_action_completions` for descriptor arguments that advertise a `completion` source. Clients must only rely on features present in this list.

#### get_ui_actions

Get native UI action descriptors. `scope` is optional, defaults to `"all"`, and may be `"primary"`, `"palette"`, or `"all"`.

```json
{"type": "get_ui_actions", "scope": "palette"}
```

Example response:
```json
{
  "type": "response",
  "command": "get_ui_actions",
  "success": true,
  "data": {
    "actions": [
      {
        "schemaVersion": 1,
        "id": "extension.command.ec_a1b2c3d4e5f6_1",
        "label": "session-name",
        "description": "Set or clear session name",
        "source": "extension",
        "sourceScope": "project",
        "sourceOrigin": "top-level",
        "sourceLabel": "Project",
        "category": "extension",
        "presentation": {"kind": "palette", "group": "Extensions"},
        "args": [{"name": "arguments", "label": "Arguments", "type": "string", "required": false}],
        "enabled": true,
        "disabledReason": null,
        "destructive": false,
        "requiresConfirmation": false,
        "streamingBehavior": "immediate",
        "remoteSafe": true,
        "slash": {"name": "session-name", "example": "/session-name"}
      }
    ]
  }
}
```

Each descriptor uses this v1 shape:

```json
{
  "schemaVersion": 1,
  "id": "review.uncommitted",
  "label": "Review changes",
  "description": "Review uncommitted workspace changes for bugs and regressions.",
  "source": "builtin",
  "category": "review",
  "presentation": {
    "kind": "card",
    "group": "Review",
    "priority": 100,
    "icon": "magnifyingglass"
  },
  "args": [],
  "enabled": true,
  "disabledReason": null,
  "destructive": false,
  "requiresConfirmation": true,
  "streamingBehavior": "disabled",
  "remoteSafe": true,
  "slash": {
    "name": "review",
    "example": "/review uncommitted"
  }
}
```

Required fields are `schemaVersion`, `id`, `label`, `source`, `category`, `enabled`, and `remoteSafe`. Clients should ignore unknown fields, skip invalid descriptors, render unknown categories as advanced or other actions, and treat unknown presentation kinds as palette rows.

Descriptor fields are advisory snapshots. The host remains authoritative and may omit actions that are unavailable, unsafe, too large, or unsupported by the client. Dynamic action ids are session-local unless a future descriptor explicitly documents stronger stability.

Projected extension command, prompt template, and skill actions use session-local opaque ids. Descriptors include bounded display strings, source kind, source scope/origin, and a safe source label such as `"Project"`, `"User"`, `"Temporary"`, or `"Package"`. They do not include extension source paths, prompt file paths or bodies, skill file paths, skill base directories, or raw `sourceInfo`.

Built-in v1 actions currently include:

| Action id | Slash alias | Remote over Iroh | Notes |
| --- | --- | --- | --- |
| `session.new` | `/clear` | yes | Starts a fresh session through the same host path as `new_session`. |
| `run.cancel` | none | yes | Aborts the current agent operation through the same host path as `abort`; descriptors may be disabled when no run is active. |
| `context.compact` | `/compact` | no | Runs host compaction through the same handler as the local `compact` RPC command. |
| `session.rename` | `/name <name>` | no | Sets the current session display name through the same handler as `set_session_name`. |
| `thinking.fast_mode` | none | yes | Durable branch-local inference-speed toggle for eligible canonical OpenAI Responses and OpenAI Codex models. Enabled sends Priority processing; disabled sends the default service tier. |
| `review.uncommitted` | `/review uncommitted` | yes | Starts a detached review of uncommitted changes against `HEAD` using host-owned git/model policy; the response reports `accepted` with a `workflowId` and progress streams as workflow events. |
| `review.branch` | `/review branch [base]` | yes | Captures `HEAD`, refreshes a plain or short remote base branch with the host's Git credentials/network, and reviews from their merge base. Full `refs/heads/*` and `refs/remotes/*` inputs intentionally use local cached state; omitted values use host auto-detection. The `base` argument advertises `"completion": "gitBranches"`. |
| `review.pr` | `/review pr [number]` | yes | Starts a detached GitHub pull request review using the host's GitHub credentials and network. Pull request metadata, diff, authoritative linked issues, comments, submitted review summaries, and inline review threads are sent to discovery and independent verification; retained finding prose is rendered separately without GitHub context. The optional string `number` must be a canonical positive decimal no greater than `2147483647`; omission selects the current branch's pull request. |
| `review.commit` | `/review commit <ref>` | yes | Starts a detached review of a commit from workspace history. The required string `ref` is bounded to 1024 UTF-8 bytes and resolved to a commit object before the diff is inspected with textconv and external diff drivers disabled. |

Slash aliases are display and compatibility metadata. Clients may show them in palettes or advanced detail views, but should not synthesize slash strings when an action id is available. The host may change slash syntax without changing a stable built-in action id.

Unsupported or deferred native surfaces in v1:

- Extension commands project as palette actions only. First-class extension cards/toggles are deferred until a future `volt.registerAction()` policy defines stable extension-owned ids, trust, descriptor validation, and remote safety.
- Prompt templates and skills project as palette actions; descriptors omit prompt bodies, skill bodies, file paths, and base directories.
- Model selection is not a native action; remote clients use the direct `get_available_models`/`set_model`/`set_thinking_level` RPC commands, which are forwarded over Iroh conversation streams. Profile switching, scoped-model editing, login/logout, package management, and local settings screens remain unexposed over Iroh.
- Local-only built-ins such as `context.compact` and `session.rename` may appear in local RPC descriptors but are blocked over Iroh until separate remote policy exists.

#### get_ui_action_completions

Get completion options for one action argument. Clients should only call this when the descriptor argument includes a supported `completion` value. V1 currently supports extension command argument completions via `"completion": "commandArguments"` and git branch-name completions via `"completion": "gitBranches"` (advertised by `review.branch`'s `base` argument). `gitBranches` serves logical branch names with local/upstream duplicates collapsed, keeps unmatched local and remote-tracking branches, orders `main`/`master`-style defaults first, and filters case-insensitively by `prefix` within the response bound; values are branch names only.

```json
{"type": "get_ui_action_completions", "action": "extension.command.ec_a1b2c3d4e5f6_1", "argument": "arguments", "prefix": "pr"}
```

Response:

```json
{
  "type": "response",
  "command": "get_ui_action_completions",
  "success": true,
  "data": {
    "completions": [
      {"value": "prod", "label": "Production", "description": "Production target"}
    ]
  }
}
```

Unknown or stale action ids fail with the normal RPC error shape. Unsupported arguments or completion kinds — for built-in and projected actions alike — return an empty completion list unless the argument name itself is not present in the descriptor. `gitBranches` also returns an empty list when the workspace is not a git repository.

#### invoke_ui_action

Invoke a native UI action by descriptor id.

```json
{"id": "action-42", "type": "invoke_ui_action", "action": "review.uncommitted", "args": {}, "streamingBehavior": "followUp"}
```

`id` is a required correlation id: a trimmed, non-empty string of at most 256 UTF-8 bytes. Every success or command-level failure response produced for the invocation echoes it exactly; transport failure can prevent delivery. If the required id is missing, non-string, empty, padded with surrounding whitespace, or over the byte bound, the host cannot safely correlate the request and returns an id-less `command: "invalid"` failure instead of an `invoke_ui_action` response. `args` is an optional object matching the descriptor's argument metadata. V1 hosts validate the supported descriptor subset: `string` and multiline `string` values are JSON strings, `boolean` values are JSON booleans, `enum` values are strings present in `options`, and `integer` values are JSON numbers with integer values. Unknown argument names, unknown argument types, missing required values, and mismatched value types fail before invocation. `streamingBehavior` is optional and may be `"steer"` or `"followUp"` when the descriptor allows queued invocation while the agent is streaming.

Unknown, stale, disabled, unauthorized, or unavailable action ids fail with the normal RPC error shape:
```json
{
  "id": "action-42",
  "type": "response",
  "command": "invoke_ui_action",
  "success": false,
  "error": "UI action not available: prompt.template.pt_a1b2c3d4e5f6_1"
}
```

Successful response data reports the command disposition:

```json
{
  "id": "action-42",
  "type": "response",
  "command": "invoke_ui_action",
  "success": true,
  "data": {
    "action": "review.uncommitted",
    "status": "accepted",
    "workflowId": "review:2f4c…",
    "actionsChanged": true,
    "message": "Review started"
  }
}
```

Possible statuses:
- `"accepted"`: a prompt-like action was accepted while idle (normal agent events report completion; wait for `agent_settled` for final settlement), or a detached workflow was started (`workflowId` is present and `workflow_*` events report progress and completion).
- `"queued"`: a prompt-like action was queued while another turn is streaming. `queuedAs` is `"steer"` or `"followUp"`.
- `"completed"`: the action finished synchronously. No `agent_end` is expected for this invocation.
- `"handled"`: the host, extension command, or input hook handled the action without starting an agent turn.
- `"cancelled"`: the action was cancelled before execution.

Only `accepted` and `queued` may require waiting for later agent events. Clients must clear pending UI immediately for `completed`, `handled`, `cancelled`, and RPC errors.

Committed action-state transitions may also publish a bounded generic event on the ordered conversation feed so every attached client can update the same action snapshot:

```json
{
  "type": "ui_action_state_changed",
  "action": "thinking.fast_mode",
  "state": { "type": "boolean", "value": true, "label": "Fast mode enabled" },
  "delivery": { "subscriptionId": "sub-…", "cursor": 42 }
}
```

The initiating `invoke_ui_action` response still includes its resulting state. Other attached clients use `ui_action_state_changed` or a fresh `get_ui_actions` response; reconnect state remains authoritative from persisted session policy.

For projected dynamic actions, invocation uses the host's existing prompt semantics:

- Extension command actions invoke their registered slash command and return `handled` when the command handler completes. They do not require an `agent_end` event.
- Prompt template and skill actions send their slash alias through host prompt expansion. While idle they return `accepted`; while the agent is streaming they require `streamingBehavior: "steer"` or `"followUp"` and return `queued`.
- Dynamic action ids are opaque and tied to the current action catalog. After a reload, session replacement, or catalog change, clients must refresh descriptors; stale ids are rejected instead of being remapped to another action.
- `thinking.fast_mode` uses a required boolean `enabled` argument. The independent boolean policy is durable on the active session branch and does not change the selected model, thinking level, model/thinking defaults, profiles, or project/global settings. Reconnects and tree navigation restore the branch's latest Fast state. The action is enabled only for supported models on the canonical OpenAI Responses and OpenAI Codex endpoints. Enabled maps normal conversation turns to `service_tier: "priority"`; disabled maps them to `service_tier: "default"`. Auxiliary calls such as compaction and session naming do not inherit the toggle.
- Review actions start a detached host workflow: the host resolves git targets and review-model settings inline (target errors fail the invocation synchronously), then returns `accepted` with a `workflowId` while isolated review sessions run with the approved tool policy. All Git-backed review diffs disable textconv and external diff drivers; `review.commit` additionally resolves the bounded input ref to a canonical commit object id before invoking `git show`. `review.branch` captures local `HEAD` before refreshing a plain branch through its configured/matching upstream, or a short remote branch directly, into an isolated temporary Git source using host credentials and network. It never moves workspace refs or `FETCH_HEAD`, fails instead of silently using stale state, and treats explicit full refs as local cached targets. Durable branch reruns recapture the same resolved remote branch or explicit local/cached full ref instead of depending on disposed snapshot objects. `review.pr` validates the optional number before using the host's GitHub credentials and network. For PR targets, pull request metadata/diff plus authoritative closing/manual-linked issues, PR comments, submitted review summaries, inline review threads/replies, and linked-issue comments are submitted to discovery and independent verification. GitHub text is untrusted evidence and is bounded to 32 KiB per field, 20 linked issues, 200 total discussion entries, and 256 KiB of rendered context; links are not inferred from arbitrary text or followed recursively. Both analysis passes must inspect the same complete captured context. Capture limitations or incomplete inspection make the result incomplete and withhold its correctness verdict, while a final head-OID check rejects a PR that moved during capture. When they accept a new finding, the verifier model runs once more in a fresh context-blind presentation session that receives one-time host ids, validated code anchors/evidence, severity, and immutable code tools, but no GitHub context, target title/body, private model prose, extension tools, or auxiliary commands. It must inspect every accepted hunk and cannot change finding identity, anchor, severity, or status; no-new-finding and prior-only incremental runs skip this pass. The runtime keeps serving other RPC commands, and the client's session is never force-switched. Progress streams as sanitized `workflow_*` and `tool_execution_*` events; completion is reported by `workflow_end`. Findings are fetched with `get_review_result`, running or retained reviews are listed with `list_review_workflows`, a running review is aborted with `cancel_workflow`, and `open_review_session` seeds a fresh session with the findings when the client asks for one. Responses, events, durable records, opened review sessions, and publication payloads do not include raw diffs, review prompts, pull request titles or bodies, linked-issue/discussion text, free-form discovery/verifier prose, configured model names, auth state, or raw tool output. They may include bounded context status/count/limitation/fingerprint metadata plus explicitly declassified finding structure; finding prose is code-derived by the context-blind pass, and other PR summaries, diagnostics, limitation counts, and command-attempt counts are host-generated. Pull request workflow tool events omit all model-controlled string arguments; configured-model fallback warnings are suppressed remotely, and subprocess/provider failures use stable remote messages while detailed diagnostics remain host-local. Reviews use the host-owned read-only tool set (`read`, `grep`, `find`, `ls`) without inheriting extension tools; descriptors advertise `requiresConfirmation`, and clients confirm before invoking (there is no host-side confirmation round trip). Hosts cap concurrent reviews and retain a bounded window of terminal results.
- Over Iroh, v1 invocation is allowlist-based and forwards only exact reviewed built-in ids (`session.new`, `run.cancel`, `thinking.fast_mode`, `review.uncommitted`, `review.branch`, `review.pr`, `review.commit`) plus projected dynamic ids under `extension.command.*`, `prompt.template.*`, and `skill.*`. Local-only built-ins such as `context.compact` and `session.rename`, deferred `review.tools`, and unreviewed prefixes are rejected with a normal RPC error. Model and thinking changes use the direct `set_model`/`set_thinking_level` RPC commands, which are forwarded over Iroh conversation streams.

#### Detached review workflows

Review invocations return `accepted` with a `workflowId` and run detached from the RPC command queue. Four commands manage them:

```json
{"type": "list_review_workflows"}
{"type": "get_review_result", "workflowId": "review:2f4c…"}
{"type": "cancel_workflow", "workflowId": "review:2f4c…"}
{"type": "open_review_session", "workflowId": "review:2f4c…"}
```

- `list_review_workflows` returns `{ "workflows": […] }` with active workflows followed by a bounded window of retained terminal results. Each entry carries `workflowId`, `action`, `status` (`running`, `completed`, `cancelled`, or `failed`), a bounded `target` (`description`, `diffCommand`), optional `findingsCount`/`errorMessage`, and `startedAt`/`endedAt` timestamps. PR targets may also include `target.context` metadata: `captureStatus`, captured and rendered issue/discussion counts, `renderedBytes`, `limitationCodes`, and `fingerprint`. It never includes linked-issue or discussion text. Commit targets use the canonical object id; pull request targets use `PR #N` without the title or body. Clients reconnecting after missing `workflow_end` should list to discover finished reviews.
- `get_review_result` returns the same descriptor plus structured findings for completed reviews: `findings` (title, body, priority, confidence, file, line), optional `coverage`, `overallCorrectness`, and `overallExplanation`. PR results may include `coverage.context` with capture status/counts/limitation codes/fingerprint and booleans reporting whether discovery and verification each inspected all context pages. This is metadata plus context-blind code-derived finding prose only; no newly captured GitHub text or free-form context-aware model prose is returned. A report or presentation that cannot be validated fails the workflow with a bounded host-generated error. Unknown workflow ids fail with a normal RPC error.
- `cancel_workflow` aborts a running review; the workflow ends with `workflow_end` status `cancelled`. Cancelling an unknown or finished workflow fails with a normal RPC error.
- `open_review_session` starts a fresh session seeded with a completed review's findings (the client-driven replacement for the old forced session switch) and responds with `{ "cancelled": boolean }`. It fails for unknown or non-completed workflows. It also fails when the replacement session was created but the seed was skipped because recovered durable client input failed to replay; in that case the review stays retained (still listed and fetchable) so the open can be retried.

#### Native UI Action Security

Descriptors must not expose host-local paths, extension source paths, prompt template bodies, skill content, provider secrets, environment values, auth internals, raw model/provider metadata, raw transcript payloads, or host session store paths. Iroh remote discovery responses pass through the remote outbound redaction layer in addition to descriptor-level sanitization. Remote invocation is allowlist-based and re-checks action availability, remote safety, authorization, streaming policy, and argument validity at invocation time.

`get_commands` remains the legacy local command-discovery surface for raw slash invocation and may include source metadata useful to local clients. Remote clients and native mobile clients should use sanitized `get_ui_actions`; raw `get_commands` remains blocked over Iroh.

### Host-Initiated Action Requests

Host-initiated action requests let Volt pause a running workflow and ask an RPC client to approve a host-owned action. This is separate from native UI actions: native UI actions are client-initiated, while host action requests are emitted by Volt when it needs user/app approval to continue.

Clients must opt in before Volt will block on host action requests:

```json
{"type": "set_client_capabilities", "features": ["host_action_requests.v1"]}
```

Response:

```json
{"type": "response", "command": "set_client_capabilities", "success": true}
```

When a host action is needed, Volt emits:

```json
{
  "type": "host_action_request",
  "id": "ha_123",
  "action": "lsp.install_server",
  "title": "Install typescript language server?",
  "message": "Volt tried to use LSP for typescript, but typescript-language-server is not installed. Install it now and retry diagnostics?",
  "confirmLabel": "Install",
  "cancelLabel": "Skip",
  "commandPreview": "npm install -g typescript-language-server typescript",
  "blocking": true,
  "destructive": false,
  "metadata": {"server": "typescript", "binary": "typescript-language-server"}
}
```

The client responds with one of `"approved"`, `"denied"`, or `"dismissed"`:

```json
{"type": "host_action_response", "id": "ha_123", "decision": "approved"}
```

Volt may emit progress updates for approved actions:

```json
{"type": "host_action_update", "id": "ha_123", "action": "lsp.install_server", "status": "running", "message": "Running npm install -g typescript-language-server typescript"}
{"type": "host_action_update", "id": "ha_123", "action": "lsp.install_server", "status": "completed", "message": "typescript language server installed. Retrying diagnostics.", "exitCode": 0}
```

Use `get_pending_host_actions` to recover currently pending requests after reconnect:

```json
{"type": "get_pending_host_actions"}
```

Clients approve only the advertised host-owned action; they cannot alter the command. If the client does not advertise `host_action_requests.v1`, Volt falls back without blocking (for example, an LSP missing-server message with install instructions). Current LSP install requests are limited to trusted built-in install recipes; custom LSP commands and manual-install-only servers still produce instructions only.

### Model

#### set_model

Switch to a specific model. Matches CLI `/model` behavior: the change is recorded in the session and persisted as the default model and provider for future sessions. Pass `"persistDefault": false` to change the current session's model without rewriting the host default (used e.g. for per-agent model overrides). Switching models re-clamps the thinking level to the new model's capabilities (emitting `thinking_level_changed` when it changes) without changing the branch-local Fast policy. Unknown provider/model pairs fail with `Model not found: <provider>/<modelId>`.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object plus `availableThinkingLevels`, the thinking levels the model supports:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {..., "availableThinkingLevels": ["off", "minimal", "low", "medium", "high"]}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models. The host reloads `auth.json` and `models.json` from disk before answering, so logins, logouts, and API keys saved by other volt processes become selectable without restarting the host.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects, each enriched with `availableThinkingLevels` (the thinking levels that model supports, `["off"]` for non-reasoning models) so clients can present valid choices without provider capability matrices:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it. Pass `"persistDefault": false` to apply the level to the current session without persisting it as the host default.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are advertised only for models whose metadata explicitly supports them. GPT-5.6 Sol, Terra, and Luna expose both as distinct efforts.

Levels the current model does not support are silently clamped to the nearest supported level, not rejected. The response reports the effective post-clamp level, and a `thinking_level_changed` event fires only when the effective level actually changes. Use `get_state`'s `availableThinkingLevels` to present valid choices.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true, "data": {"level": "high"}}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "details": {}
  }
}
```

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context.

```json
{"type": "bash", "command": "ls -la"}
```

Response:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/volt-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state. This message does NOT emit an event.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included
3. No event is emitted for the `BashExecutionMessage` itself

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` contains assistant usage totals for the current session state. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### get_subscription_usage

Get normalized subscription quota windows for stored OAuth logins. API keys are not queried. Results use the same brief host-side cache as `/usage`; each configured provider succeeds or fails independently.

```json
{"type": "get_subscription_usage"}
```

Response:
```json
{
  "type": "response",
  "command": "get_subscription_usage",
  "success": true,
  "data": {
    "status": "providers",
    "providers": [
      {
        "providerId": "openai-codex",
        "result": {
          "status": "success",
          "snapshot": {
            "providerId": "openai-codex",
            "fetchedAt": 1800000000000,
            "plan": "plus",
            "limits": [
              {
                "id": "weekly",
                "label": "Weekly",
                "usedPercent": 25,
                "resetsAt": 1800086400000,
                "windowDurationMs": 604800000,
                "limitReached": false
              }
            ]
          }
        }
      }
    ]
  }
}
```

`data.status` is `providers`, `no_subscription`, or `unsupported`. Provider results are either a normalized snapshot or an error with code `unauthorized`, `rate_limited`, `timeout`, `unavailable`, or `malformed_response`. The response excludes credentials, account identity, and raw provider payloads. Typed clients can call `getSubscriptionUsage()`.

Iroh conversation streams also allow this command for paired clients with `host.manage.v1`; the standard `coding`, `review`, and `chat` grants include that capability.

#### list_sessions

List sessions for the current workspace through the SQLite summary index. The response uses stable IDs and omits the store directory, database path, and `SessionReference` internals so local and remote clients can present workspace-scoped choices safely.

```json
{"type": "list_sessions"}
```

Response:
```json
{
  "type": "response",
  "command": "list_sessions",
  "success": true,
  "data": {
    "sessions": [
      {
        "sessionId": "abc123",
        "sessionName": "my-feature-work",
        "createdAt": "2026-06-22T15:00:00.000Z",
        "modifiedAt": "2026-06-22T15:10:00.000Z",
        "messageCount": 12,
        "firstMessage": "Implement the feature",
        "current": true,
        "workContext": {
          "changeId": "c56d55ca-3937-4fc8-b13a-a7525577864b",
          "repository": "Volt",
          "branch": "feature/work-association",
          "resolutionState": "resolved",
          "pullRequest": {
            "provider": "github",
            "number": 42,
            "title": "Add Work association",
            "status": "open",
            "stale": false
          }
        }
      }
    ]
  }
}
```

Daemon-backed remote lists may add optional `workContext`. It is either a
resolved context with bounded `pullRequest`, or an unresolved context whose
`resolutionState` is `none`, `ambiguous`, or `unavailable` and has no
`pullRequest`. The daemon joins this from its synchronous private store; a
`list_sessions` request never starts Git or provider work. Only opaque
`changeId`, repository display name, effective branch, resolution state, and
the bounded PR provider/number/title/status/staleness cross the wire. Checkout
paths, remotes, canonical repository IDs, matched object IDs, credentials, raw
provider output, and diagnostics are excluded.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load another session from the active workspace store by stable ID. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionId": "abc123"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### switch_session_by_id

Load another session from the current workspace by stable ID. It has the same path-free request semantics as `switch_session`. Conversation-bound mobile streams reject direct retargeting; select the session when opening the stream instead.

```json
{"type": "switch_session_by_id", "sessionId": "abc123"}
```

Response:
```json
{"type": "response", "command": "switch_session_by_id", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session_by_id", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `volt --mode rpc` process.

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.volt/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.volt/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.volt/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `volt.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.volt/agent/`)
  - `"project"`: Project-level (`./.volt/agent/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do NOT include an `id` field (only responses do).

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | Agent run completes (includes all generated messages); a retry or continuation may still follow |
| `agent_settled` | Prompt fully settles: no further automatic retries, compaction continuations, or queued continuations |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `workflow_start` | Host-owned workflow begins (for example, review) |
| `workflow_update` | Host-owned workflow progress update |
| `workflow_end` | Host-owned workflow completes, fails, or is cancelled |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `subagent_event` | Wrapped child event from a local RPC-managed subagent |
| `subagent_end` | Terminal completion result for a local RPC-managed subagent |
| `subagent_disposed` | Host released a local RPC-managed subagent; terminal for its event stream |
| `extension_error` | Extension threw an error |
| `models_changed` | Available model catalog changed on disk (login, logout, or API key save) |
| `git_context_changed` | Full replacement of the active session's nullable cached Git context |
| `mcp_servers_changed` | MCP server list or enablement changed (`servers`: full summary list) |
| `mcp_server_status_changed` | An MCP server's status or auth state changed (`server`: full summary) |
| `mcp_auth_request` | An MCP OAuth flow needs user action (`serverId`, `auth`: flow, URL/device-code details) |
| `mcp_auth_update` | An MCP OAuth flow progressed (`serverId`, `status`, `authState`, optional `server` summary) |
| `mcp_call_start` | MCP gateway tool call began (`call`: id, server, tool, risk) |
| `mcp_call_update` | MCP tool call progress notification (`call`, `progress`) |
| `mcp_call_end` | MCP tool call completed, failed, or was cancelled (`call`, optional `cacheId`) |

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when an agent run completes. Contains all messages generated during this run.

```json
{
  "type": "agent_end",
  "messages": [...]
}
```

A single prompt can produce multiple `agent_end` events: automatic retries, overflow/threshold compaction, and queued follow-up messages each continue the run after a raw `agent_end`. Wait for `agent_settled` to know the prompt is finished.

### agent_settled

Emitted when all tracked prompt work reaches a global idle boundary, after any final `agent_end`, automatic retries, compaction continuations, and queued-message continuations have finished. Overlapping prompt transactions share one boundary, and handled or rejected preflight can settle without an `agent_end`; this event does not carry a prompt correlation id. Client helpers such as `waitForIdle`, `collectEvents`, and `promptAndWait` terminate on this event.

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`. Assistant frames also carry a projector-local `stream` position; non-assistant message frames pass through without one.

```json
{"type": "message_start", "stream": {"epoch": 1, "seq": 0}, "message": {...}}
{"type": "message_end", "stream": {"epoch": 1, "seq": 4}, "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Normal frames carry a compact delta plus an explicit `stream` position, avoiding the quadratic cost of sending the accumulated message on every token. Recovery frames additionally carry a full `message` snapshot.

```json
{
  "type": "message_update",
  "stream": {"epoch": 1, "seq": 2},
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The in-process `AssistantMessageEvent` type carries contiguous `seq`, immutable `snapshot`, and resumable `toolState` fields. Compact wire deltas omit those fields because `stream.seq` carries the position and the decoder rebuilds the snapshot. A recovery frame includes `message` and may include `toolState`.

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_start","stream":{"epoch":1,"seq":0},"message":{"role":"assistant","content":[],"...":"..."}}
{"type":"message_update","stream":{"epoch":1,"seq":1},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","stream":{"epoch":1,"seq":2},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","stream":{"epoch":1,"seq":3},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","stream":{"epoch":1,"seq":4},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
{"type":"message_end","stream":{"epoch":1,"seq":4},"message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}],"...":"..."}}
```

Reconstruction rules:

- Assistant `message_start`, `message_update`, and `message_end` frames carry `{epoch, seq}` in `stream`. `message_start` is the base at sequence 0. Within one epoch, accept a delta only when its sequence is exactly the previous sequence plus one.
- Adopt every `message_start`, snapshot-bearing `message_update`, and `message_end` unconditionally, even if its epoch is lower than a previously observed epoch. A server-side projector can be recreated during session rebinding. Epoch and sequence checks gate compact deltas only.
- If no `message_start` was observed for the current message (for example, a mid-turn attach), the first `message_update` carries a full `message` snapshot. A snapshot can also arrive after a delivery discontinuity, a sequence gap, an authoritative non-append update, or remote redaction. Treat any update that includes `message` as an accumulator replacement and seed open tool argument text from its optional `toolState`.
- `text_delta`/`thinking_delta` append `delta` to the block at `contentIndex`; `text_end`/`thinking_end` carry the authoritative block `content`.
- `toolcall_start` includes best-effort `id` and `name`; `toolcall_delta.argsTextDelta` streams raw argument JSON text and may refine identity; `toolcall_end` carries the authoritative full `toolCall` object.
- The same rules apply to `message_update` events wrapped in `subagent_event`, keyed per `subagentId`. Drop a subagent's accumulator on `subagent_end` or `subagent_disposed`.
- If a compact delta has an invalid position or cannot be applied at its bounded `contentIndex`, drop it and wait for the next base, snapshot, or final frame. Do not partially apply it.
- A client that detects a delivery, assistant-position, or reducer gap must fence
  ordinary conversation projection and send one correlated
  `report_stream_discontinuity` command. The report is scoped to the exact
  session and ordered-conversation subscription that produced the dropped
  frame:

```json
{
  "id": "recovery-42",
  "type": "report_stream_discontinuity",
  "sessionId": "session-abc",
  "subscriptionId": "subscription-def",
  "lastAppliedCursor": 17,
  "assistantPosition": {"epoch": 3, "seq": 28},
  "reason": "assistant_position_gap"
}
```

`reason` is one of `cursor_gap`, `assistant_position_gap`, or
`reducer_divergence`; `assistantPosition` is omitted when no assistant frame
has been committed. `lastAppliedCursor` may not be ahead of the host's issued
cursor. The host remembers the 128 most recent recovery IDs for each
subscription. Within that replay window, a repeated `id` is idempotent only
when every recovery field is identical; reusing it for a different report is
rejected. Clients must mint a fresh ID for every detected gap and never
intentionally reuse one. An ID that has fallen out of the bounded window is
treated as a new, rate-limited recovery request.

The host synchronously takes one authoritative cut, discards only ordinary
tail frames that have not yet been handed to transport, and writes a correlated
checkpoint on the same ordered writer:

```json
{
  "type": "conversation_bootstrap",
  "reason": "resync",
  "requestId": "recovery-42",
  "delivery": {"subscriptionId": "subscription-def", "cursor": 18},
  "conversation": {"...": "..."},
  "transcript": {"...": "..."},
  "state": {"...": "..."},
  "activeAssistant": {"...": "..."},
  "activeWorkflows": []
}
```

Only that checkpoint, carrying the same `requestId` and subscription, can clear
the client's fence. After it has been admitted to the writer, the host writes
the RPC receipt behind it:

```json
{
  "id": "recovery-42",
  "type": "response",
  "command": "report_stream_discontinuity",
  "success": true,
  "data": {
    "subscriptionId": "subscription-def",
    "requestId": "recovery-42",
    "checkpointCursor": 18
  }
}
```

The receipt is not recovery state and does not clear the fence. Stale session
or subscription identities fail closed. Send one request per detected gap, not
one per dropped frame.

The bundled RPC client (`RpcClientBase` and the SDK clients built on it) performs this reconstruction transparently and exposes a fully accumulated `message` plus `assistantMessageEvent.snapshot`, `seq`, and `toolState` to event listeners.

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update. `subagent_registry` is an ordinary built-in tool, not an RPC command: when active in a child runtime, its list/follow calls use these unchanged lifecycle events over stdio, in-process loopback, and Iroh transports.

Host-owned workflows can also emit sanitized tool lifecycle events with workflow metadata. For example, review actions emit tool names and bounded arguments, but omit raw file contents and raw tool output:

```json
{"type":"tool_execution_start","workflowId":"review:abc","workflowKind":"review","workflowAction":"review.uncommitted","toolCallId":"review:abc:call_1","toolName":"read","args":{"path":"src/file.ts"}}
{"type":"tool_execution_end","workflowId":"review:abc","workflowKind":"review","workflowAction":"review.uncommitted","toolCallId":"review:abc:call_1","toolName":"read","isError":false}
```

### workflow_start / workflow_update / workflow_end

Emitted for host-owned workflows that are not ordinary assistant chat turns, such as a review action. The invocation response arrives before `workflow_start`; clients can render these as a live timeline and, for reviews, fetch results with `get_review_result` after `workflow_end`.

```json
{"type":"workflow_start","workflowId":"review:abc","kind":"review","action":"review.uncommitted","title":"Review","message":"Reviewing uncommitted changes.","status":"running"}
{"type":"workflow_update","workflowId":"review:abc","kind":"review","action":"review.uncommitted","title":"Review","message":"Finalizing findings.","status":"finalizing"}
{"type":"workflow_end","workflowId":"review:abc","kind":"review","action":"review.uncommitted","title":"Review","message":"Review complete: 2 findings. Fetch the findings or open them in a review session.","status":"completed"}
```

`status` is advisory. Known review statuses are `running`, `finalizing`, `completed`, `cancelled`, and `failed`. Unknown workflow kinds, statuses, and extra fields should be ignored or rendered generically.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

### git_context_changed

Emitted after the cached Git context changes semantically, becomes stale, recovers, or changes to/from `null`. The payload is a full replacement, never a patch:

```json
{
  "type": "git_context_changed",
  "gitContext": {
    "repository": "volt",
    "head": {"kind": "branch", "name": "main", "oid": "0123456789abcdef0123456789abcdef01234567"},
    "upstream": null,
    "base": null,
    "status": {
      "staged": {"added": 0, "modified": 0, "deleted": 0, "renamed": 0},
      "unstaged": {"added": 0, "modified": 1, "deleted": 0, "renamed": 0},
      "untracked": 0,
      "conflicted": 0,
      "total": 1,
      "clean": false
    },
    "operation": null,
    "revision": 2,
    "observedAt": "2026-07-29T17:00:00.000Z",
    "stale": false
  }
}
```

`gitContext` may be `null`. A fresh `get_state` or conversation bootstrap is authoritative and resets any client-side provider-revision baseline; apply later events in stream order. Ordered remote events also carry the normal top-level `delivery` position.

### models_changed

Emitted when the host detects that the available model catalog changed on disk — for example after `/login`, `/logout`, or an API key save in another volt process rewrote `auth.json` or `models.json`. The event carries no payload; clients should re-request `get_available_models` to fetch the updated catalog. Rewrites that do not change the available catalog (such as OAuth token refreshes) do not emit this event.

```json
{"type": "models_changed"}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)

The theme facade is fully functional in RPC mode: `getAllThemes()` returns the real theme list (builtin plus extension-registered), `getTheme()` resolves by name, and `setTheme()` applies the theme to the process and persists the choice. Under the background daemon, a successful `setTheme()` also broadcasts a `theme_snapshot` to connected desktop TUIs, which apply it unless the user explicitly picked a theme in that TUI session.

For conversations owned by a desktop TUI and served to phones over the daemon's byte relay, `extension_ui_request` frames are suppressed on the relayed stream: dialogs are answered on the desktop where the extension's UI actually lives, and phones receive none of them.

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "volt - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

A syntactically valid `invoke_ui_action` payload with no usable required correlation id is an uncorrelated validation error:

```json
{
  "type": "response",
  "command": "invalid",
  "success": false,
  "error": "Invalid RPC command payload: \"id\" is required"
}
```

`parse` remains reserved for invalid JSON, and `unknown` remains reserved for non-object input or a missing/unknown command type.

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/core/rpc/types.ts`](../src/core/rpc/types.ts) - RPC command/response types, extension UI request/response types
- [`src/core/rpc/transport.ts`](../src/core/rpc/transport.ts) - RPC transport abstraction and JSONL stream adapters
- [`src/core/rpc/loopback-transport.ts`](../src/core/rpc/loopback-transport.ts) - in-memory transport pair for in-process clients
- [`src/modes/rpc/rpc-transport-client.ts`](../src/modes/rpc/rpc-transport-client.ts) - typed RPC client for caller-provided transports

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105},
    "serviceTier": {"requested": "priority", "effective": "priority"}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

For OpenAI Responses and OpenAI Codex responses, optional `usage.serviceTier` records the requested and effective upstream service tier. The effective value can be `"default"` when a Priority request is downgraded.

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "isError": false,
  "timestamp": 1733234567890
}
```

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["volt", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_settled":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for the subprocess typed client, or [`src/modes/rpc/rpc-transport-client.ts`](../src/modes/rpc/rpc-transport-client.ts) for the transport-backed typed client.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("volt", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
