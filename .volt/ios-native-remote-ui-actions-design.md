# iOS Native Remote UI Actions Design

## Status

Proposed.

## Purpose

Define the long-term architecture for bringing Volt's interactive TUI capabilities into the iOS app without mirroring terminal rendering. The target is a native iOS interface that exposes the same useful capabilities as slash commands, selectors, settings panes, model controls, review workflows, and extension UI, while keeping the wire protocol typed, remote-safe, and stable.

This document focuses on the host/app contract for native action surfaces such as cards, buttons, command palettes, and settings controls. It intentionally treats slash commands as one presentation of host actions rather than the protocol itself.

## Context

Volt currently has three overlapping interaction surfaces:

1. **Interactive TUI**
   - Built-in slash commands are handled inside `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
   - Examples: `/review`, `/model`, `/settings`, `/compact`, `/clear`, `/resume`, `/tree`, `/login`, `/extensions`.
   - The TUI also provides autocomplete, selectors, custom extension UI, status/footer widgets, and keyboard shortcuts.

2. **Core agent/session APIs**
   - `AgentSession` owns session state, prompt dispatch, extension command dispatch, prompt-template expansion, skill expansion, compaction, model switching, session switching, and extension binding.
   - Extension slash commands, prompt templates, and skills are already available outside the TUI when invoked through `AgentSession.prompt()`.

3. **RPC and Iroh remote access**
   - RPC exposes typed commands such as `prompt`, `get_state`, `get_transcript`, `new_session`, `list_sessions`, `switch_session_by_id`, and `abort`.
   - Non-remote RPC also exposes richer local commands such as `get_commands`, `get_available_models`, `set_model`, `compact`, `bash`, and `export_html`.
   - Iroh remote access deliberately narrows direct inbound RPC commands for mobile safety.
   - The iOS app already renders transcript, connection state, session list, and extension UI notifications/dialog cancellation paths using native Swift views.

The current RPC contract can already invoke extension commands, skills, and prompt templates by sending a prompt whose text starts with `/`. For example:

```json
{"type":"prompt","message":"/skill:pi-goal-writer draft a goal"}
```

That is useful as a compatibility path, but it is not the right long-term API for native mobile UI. The iOS app should not need to know that a review workflow is spelled `/review uncommitted`, nor should it need to understand provider-specific model tuning for a "Fast mode" button.

## Problem

A native iOS app needs user-facing controls that do not map cleanly to raw slash-command text:

- Cards such as **Review changes**, **Review PR**, **Summarize session**, **Compact context**, or **New conversation**.
- Toggles such as **Fast mode**, **Deep reasoning**, **Plan mode**, or **Read-only mode**.
- Pickers such as model selection, thinking level, session resume, workspace selection, and extension-provided choices.
- One-tap workflows that internally reuse existing slash command behavior, but should remain stable even if the slash syntax changes.
- Capability-aware UI where the host tells the app which actions are available, enabled, remote-safe, and currently active.

Sending raw slash commands over RPC has several shortcomings:

- It conflates UI presentation with execution semantics.
- Built-in TUI slash commands do not currently execute in RPC mode.
- Remote clients cannot safely discover all local metadata because current `get_commands` includes source paths and excludes built-in TUI commands.
- A raw string gives the app no structured information about arguments, enabled state, destructive behavior, icon/category, current toggle state, or required confirmation.
- iOS could become coupled to TUI implementation details and command names.
- Extension command completion and built-in command flows may require UI requests that are not represented in a raw command string.

## Core Principle

Do not remote-control the terminal TUI. Remote-control Volt's intent model.

The host owns capabilities and execution. The iOS app owns native presentation. Slash commands, buttons, cards, toggles, and menu rows are different presentations of the same host-owned action graph.

## Product Model

The iOS app should eventually expose a native **Actions** or **Command Center** page with cards and controls such as:

- Review uncommitted changes
- Review staged changes
- Review current branch
- Compact conversation
- Start new conversation
- Resume previous session
- Toggle Fast mode
- Toggle high reasoning
- Switch model
- Reload extensions/prompts/skills
- Run extension commands
- Invoke skills
- Apply prompt templates

The user should not need to learn slash syntax to use these. Advanced users can still use a slash-command palette or type slash commands in the editor.

Example native card behavior:

- User taps **Review changes**.
- iOS sends `invoke_ui_action` with action id `review.uncommitted`.
- Host runs the same review implementation that the TUI currently reaches through `/review uncommitted`.
- If the action needs choices or confirmation, the host emits typed UI requests and the app renders native dialogs.
- Transcript and state update through existing event and transcript surfaces.

Example native toggle behavior:

- Host exposes `model.fast_mode` with current state `off`, enabled `true`, and display text "Fast mode".
- User toggles it on.
- iOS sends `invoke_ui_action` with action id `model.fast_mode.set` and `{ "enabled": true }`.
- Host chooses a faster model, lowers thinking level, or applies whatever model policy is valid for the current profile/provider.
- iOS updates from subsequent `ui_action_state_changed`, `get_state`, or action-list refresh data.

## Goals

- Expose remote-safe host capabilities as typed actions instead of raw slash command strings.
- Let iOS render native cards, buttons, toggles, pickers, command palettes, and detail sheets.
- Preserve existing TUI slash commands as a presentation layer.
- Reuse existing core session/action logic where possible.
- Support built-in actions, extension commands, prompt templates, skills, and future extension-provided action cards.
- Keep host-local paths, source metadata, raw transcripts, provider internals, and sensitive extension data out of the mobile protocol.
- Make availability and enabled state host-authoritative.
- Give the app enough metadata to build a polished UI without hardcoding provider-specific or workflow-specific logic.
- Provide a phased migration path from current RPC commands to a shared action registry.

## Non-goals

- Do not stream terminal drawing operations or ANSI/TUI component trees to iOS.
- Do not require iOS to implement the terminal TUI layout engine.
- Do not expose unrestricted local RPC commands over Iroh.
- Do not make iOS parse or own provider-specific model-selection policy.
- Do not expose raw `get_messages`, raw session files, or full host source paths.
- Do not require every TUI-only feature to become remote-safe in the first phase.
- Do not break existing RPC clients that invoke extension commands through `prompt`.

## Desired Long-Term Architecture

### Host-Owned Action Registry

Introduce a shared action registry used by TUI, RPC, Iroh remote, SDK/in-process clients, and future desktop/mobile UIs.

Each action should define:

- Stable `id`, such as `review.uncommitted` or `model.fast_mode.set`.
- Human label and description.
- Source: `builtin`, `extension`, `prompt`, `skill`, or `package`.
- Optional slash alias, such as `review` or `skill:foo`.
- Optional argument schema.
- Optional argument completions.
- Availability and enabled-state logic.
- Optional state for toggles or selected values.
- Remote-safety classification.
- Presentation hints for native UIs.
- Execution handler.

The registry should become the source of truth for interactive command availability. The TUI command parser can call the same action handlers that RPC/iOS invoke by id.

### Native iOS Presentation

The iOS app renders host actions as native views. The host may provide presentation hints, but the app decides exact layout.

Presentation kinds:

- `card`: prominent action card.
- `button`: compact button row.
- `toggle`: boolean or enum state control.
- `picker`: action that opens a host-backed or app-backed selector.
- `palette`: searchable command item.
- `detail`: action with a form or secondary page.
- `hidden`: invokable only by explicit id or deep link, not shown by default.

Example UI grouping:

- Review
- Session
- Model
- Context
- Extensions
- Skills
- Advanced

The app can curate high-value cards while still falling back to host-provided palette entries for less common actions.

### Typed RPC Action Layer

Add a remote UI/action layer on top of existing RPC JSONL.

Core commands:

```json
{"type":"get_ui_capabilities"}
```

```json
{"type":"get_ui_actions","scope":"primary"}
```

```json
{"type":"invoke_ui_action","action":"review.uncommitted","args":{}}
```

```json
{"type":"get_ui_action_completions","action":"review.pr","argument":"target","prefix":"https://"}
```

Core events:

```json
{"type":"ui_actions_changed"}
```

```json
{"type":"ui_action_state_changed","action":"model.fast_mode","state":{"value":"on"}}
```

The first implementation can be much smaller, but the protocol should be designed so the iOS app can evolve without needing new hardcoded routes for every TUI feature.

## Resolved 2026-06-23: Initial Action Scope and Remote Allowlist

A.1 decision: the first native action phase is a discovery and prompt-like invocation layer, not a broad projection of every TUI slash command or local RPC command.

Implementation evidence reviewed for this decision:

- Built-in TUI slash names are declared in `packages/coding-agent/src/core/slash-commands.ts` and handled in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- Headless RPC commands and responses are declared in `packages/coding-agent/src/core/rpc/types.ts` and dispatched in `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
- Iroh remote currently forwards only `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_transcript`, `list_sessions`, `switch_session_by_id`, and `extension_ui_response`.
- Current local `get_commands` returns extension commands, prompt templates, and skills with `sourceInfo`, including host-local paths. It remains blocked over Iroh.
- `AgentSession.prompt()` already executes extension commands and expands skills/templates on the host. Remote clients can currently invoke those only by sending raw slash text through `prompt`.

Initial Iroh action additions:

- `get_ui_capabilities` and `get_ui_actions` may be allowed over Iroh in the discovery phase after descriptor sanitization exists.
- `invoke_ui_action` may be allowed over Iroh only after invocation-time reauthorization and action-level remote-safety checks exist.
- The first remotely invokable action ids are limited to projected extension commands, prompt templates, and skills. They must execute through host-owned `AgentSession.prompt()` or equivalent host expansion, never client-side expansion.
- Raw `get_commands`, `get_messages`, path-based `switch_session`, unrestricted model listing/selection, local bash/export commands, extension source paths, prompt bodies, and skill contents stay blocked remotely.

### Built-In Slash Command Classification

| Slash command | Current RPC equivalent | Classification | A.1 decision |
| --- | --- | --- | --- |
| `/settings` | none | local-only | TUI settings UI stays local. Native settings need separate host-owned descriptors later. |
| `/profile` | none | deferred pending policy | Profile switching can reload resources and model defaults; defer until profile semantics are action-owned. |
| `/model` | `set_model`, `get_available_models`, `cycle_model` local RPC only | deferred pending policy | Full model metadata and model switching stay blocked over Iroh. |
| `/scoped-models` | none | local-only | Scoped model editor is TUI/settings UI and is not a first-phase remote action. |
| `/export` | `export_html` local RPC only | local-only | Writes host files and returns paths; not remote-safe for v1 actions. |
| `/import` | none | local-only | Host-path session import is not remote-safe. |
| `/share` | none | deferred pending policy | Creates an external gist and needs explicit confirmation/audit policy. |
| `/copy` | `get_last_assistant_text` local RPC only | unsupported remote | Clipboard action is app-local; raw last-message RPC remains blocked over Iroh. |
| `/name` | `set_session_name` local RPC only | deferred pending registry | Safe candidate for later `session.rename`, but not in the first action subset. |
| `/session` | `get_state`, `get_session_stats` local RPC for full stats | local-only as action | iOS should use state/session data sources, not a command card. |
| `/lsp` | none | local-only | LSP status/restart/trace can expose host paths and process state. |
| `/changelog` | none | unsupported remote | App release notes should be app-owned or documented separately. |
| `/hotkeys` | none | unsupported remote | Keyboard help is TUI-local. |
| `/fork` | `fork`, `get_fork_messages` local RPC only | deferred pending policy | Exposes message text and mutates session tree; requires a native session/tree design. |
| `/clone` | `clone` local RPC only | deferred pending policy | Session mutation candidate after shared registry and stale-state checks. |
| `/tree` | none | deferred pending policy | Branch tree, summaries, and selectors need a separate data model. |
| `/trust` | none | local-only | Project trust is a security decision and remains host-local until explicitly designed. |
| `/store` | none | local-only | Extension package install/remove/update is a host mutation surface. |
| `/extensions` | none | local-only | Extension management may expose paths and package policy; defer. |
| `/login` | none | local-only | Provider auth and secrets stay local. |
| `/logout` | none | local-only | Provider auth mutation stays local. |
| `/clear` | `new_session` remote-allowed RPC | initial remote-safe existing RPC | Keep existing native new-session flow; add `session.new` action only after the shared registry scaffold. |
| `/compact` | `compact` local RPC only | deferred pending policy | Compaction uses model auth, mutates context, and can abort active work; defer until shared action policy. |
| `/review` | none | deferred pending policy | Not in the first action subset. A.5 will decide review cards and confirmations. |
| `/resume` | `list_sessions`, `switch_session_by_id` remote-allowed RPC | initial remote-safe existing RPC | Keep existing native session list/switch flow; action projection waits for the shared registry. |
| `/reload` | none | local-only | Reloads keybindings, extensions, skills, prompts, and themes; remote policy is not defined. |
| `/quit` | none | unsupported remote | Remote detach is transport close; host shutdown is not a mobile action. |

Unregistered developer or easter-egg handlers in `interactive-mode.ts` such as `/debug`, `/arminsayshi`, and `/dementedelves` are unsupported and must not appear in native action descriptors.

### Existing RPC Surface Classification

| RPC group | Commands | Iroh/action decision |
| --- | --- | --- |
| Prompt compatibility | `prompt`, `steer`, `follow_up` | Already remote allowed. Remains the fallback path and the internal execution path for first-phase prompt-like actions. |
| Cancellation | `abort` | Already remote allowed. Future `run.cancel` can wrap it after shared registry work. |
| Session basics | `new_session`, `get_state`, `get_transcript`, `list_sessions`, `switch_session_by_id` | Already remote allowed. Continue using these as native data/control flows before action projection. |
| Extension UI | `extension_ui_response` | Already remote allowed as the response path for host-owned UI requests. |
| Model/thinking | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level` | Local-only for now; Fast mode and model actions require A.4 policy. |
| Context/settings/retry | `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry` | Local-only for now; remote actions need shared handlers and state semantics. |
| Local tools/export/raw data | `bash`, `abort_bash`, `export_html`, `get_messages`, `get_last_assistant_text` | Remain blocked remotely. |
| Session internals | `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_session_stats`, `set_session_name` | Local-only unless a later action explicitly sanitizes data and rechecks state. |
| Command discovery | `get_commands` | Replace remotely with sanitized `get_ui_actions`; do not allow raw `get_commands` over Iroh. |

### Dynamic Command Source Classification

| Source | Current behavior | Classification | A.1 decision |
| --- | --- | --- | --- |
| Extension commands | `volt.registerCommand()` provides name, description, completions, handler, and source metadata. Duplicate names receive invocation suffixes. | initial remote-safe with sanitized descriptors | Project as palette actions without source paths. Invoke by action id only after B.5 reauthorization. |
| Prompt templates | Markdown templates provide name, description, optional argument hint, body, source info, and file path. Host expands arguments. | initial remote-safe with sanitized descriptors | Project as palette actions. Descriptors omit template body and host paths; host expands on invocation. |
| Skills | Loaded skills provide name, description, file path, base directory, source info, and full skill body read at expansion time. | initial remote-safe with sanitized descriptors | Project as palette actions when host policy enables them. Descriptors omit body, file path, and base directory; host expands on invocation. |
| Future extension native cards | No API yet. | deferred pending policy | E.3 decides whether to add `registerAction()` or keep command projection only. |

### Review and Fast Mode First-Phase Decisions

Review actions are deferred from the first implementation phase. Current `/review` runs git or `gh`, may prompt for target/tool choices, uses review-model policy, runs an isolated agent session, and then starts a fresh session with findings. That is a good long-term native card surface, but it needs A.5 policy for which review targets are remote-safe, what arguments and confirmations are required, and how host-side tool/model policy is represented.

Fast mode is deferred from the first implementation phase. Current model and thinking RPC commands are local-only over Iroh, and there is no single host-owned "fast" policy today. A.4 will decide whether v1 exposes `model.fast_mode`, a narrower `thinking.fast_mode`, or no model-speed action until provider/profile policy is explicit.

## Action Descriptor Shape

Proposed action descriptor:

```json
{
  "id": "review.uncommitted",
  "label": "Review changes",
  "description": "Review uncommitted workspace changes for bugs and regressions.",
  "source": "builtin",
  "category": "review",
  "presentation": {
    "kind": "card",
    "priority": 100,
    "icon": "magnifyingglass",
    "group": "Review"
  },
  "slash": {
    "name": "review",
    "example": "/review uncommitted"
  },
  "enabled": true,
  "disabledReason": null,
  "destructive": false,
  "requiresConfirmation": false,
  "remoteSafe": true,
  "args": []
}
```

Action ids should be stable and semantic. They should not include display labels, localized text, file paths, or extension source paths.

### Built-in Sources

Built-in examples:

```json
{
  "id": "session.new",
  "label": "New conversation",
  "source": "builtin",
  "category": "session",
  "presentation": { "kind": "button", "group": "Session" },
  "slash": { "name": "clear", "example": "/clear" },
  "enabled": true,
  "requiresConfirmation": true
}
```

```json
{
  "id": "context.compact",
  "label": "Compact context",
  "source": "builtin",
  "category": "context",
  "presentation": { "kind": "card", "group": "Context" },
  "slash": { "name": "compact", "example": "/compact" },
  "args": [
    {
      "name": "customInstructions",
      "label": "Custom instructions",
      "type": "string",
      "required": false,
      "multiline": true
    }
  ]
}
```

```json
{
  "id": "review.pr",
  "label": "Review PR",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "card", "group": "Review" },
  "slash": { "name": "review", "example": "/review pr <url>" },
  "args": [
    {
      "name": "target",
      "label": "PR URL or number",
      "type": "string",
      "required": true,
      "placeholder": "https://github.com/org/repo/pull/123"
    }
  ]
}
```

### Extension Command Sources

Extension commands can be projected as actions:

```json
{
  "id": "extension.command.abc123.deploy",
  "label": "Deploy",
  "description": "Deploy to an environment",
  "source": "extension",
  "category": "extension",
  "presentation": { "kind": "palette", "group": "Extensions" },
  "slash": { "name": "deploy", "example": "/deploy" },
  "enabled": true,
  "args": [
    {
      "name": "arguments",
      "type": "string",
      "required": false,
      "completion": "commandArguments"
    }
  ]
}
```

Remote projection must not include host-local `sourceInfo.path` by default. If provenance is useful, expose coarse metadata such as `scope: "user" | "project" | "package"` and a package/source label that has passed remote redaction.

### Prompt Template Sources

Prompt templates can become actions whose execution sends the expanded prompt:

```json
{
  "id": "prompt.template.review",
  "label": "review",
  "description": "Review staged git changes",
  "source": "prompt",
  "category": "prompt",
  "presentation": { "kind": "palette", "group": "Prompts" },
  "slash": { "name": "review", "example": "/review" },
  "args": [
    {
      "name": "arguments",
      "label": "Arguments",
      "type": "string",
      "required": false,
      "hint": "<PR-URL>"
    }
  ]
}
```

The host should perform template expansion. iOS should not fetch or interpret template body content.

### Skill Sources

Skills can become actions that inject the skill content through existing skill expansion:

```json
{
  "id": "skill.pi-goal-writer",
  "label": "pi-goal-writer",
  "description": "Drafts and reviews strong /goal objectives.",
  "source": "skill",
  "category": "skill",
  "presentation": { "kind": "palette", "group": "Skills" },
  "slash": { "name": "skill:pi-goal-writer", "example": "/skill:pi-goal-writer" },
  "args": [
    {
      "name": "instructions",
      "type": "string",
      "required": false,
      "multiline": true
    }
  ]
}
```

As with prompt templates, the host expands the skill. The remote descriptor should not include `filePath` or `baseDir` unless explicitly allowed and sanitized.

## Invocation Response Semantics

`invoke_ui_action` should behave like `prompt` in that the response reports acceptance or immediate failure, not necessarily final workflow completion.

Example accepted response:

```json
{
  "id": "req-1",
  "type": "response",
  "command": "invoke_ui_action",
  "success": true,
  "data": {
    "action": "review.uncommitted",
    "status": "accepted"
  }
}
```

Possible statuses:

- `accepted`: action accepted and may produce async events.
- `completed`: action finished synchronously.
- `queued`: action was queued for later delivery.
- `handled`: action was handled without starting an agent turn.
- `cancelled`: user or extension cancelled before execution.

If an action starts an agent turn, normal agent events continue streaming. If an action only changes state, the app should rely on response data plus state/action change events.

Errors should use normal RPC error shape:

```json
{
  "id": "req-1",
  "type": "response",
  "command": "invoke_ui_action",
  "success": false,
  "error": "Action not available while the agent is streaming"
}
```

## Slash Commands as Presentation

Slash commands should become one view over the action registry.

TUI behavior:

- User types `/review uncommitted`.
- TUI parser resolves slash name and arguments to `review.uncommitted`.
- The shared action handler runs.

RPC/iOS behavior:

- User taps **Review changes**.
- iOS sends `invoke_ui_action` for `review.uncommitted`.
- The same shared action handler runs.

Advanced fallback:

- User types `/skill:foo args` in the iOS prompt editor.
- iOS may send existing `prompt` text for compatibility.
- Later, iOS can resolve slash text against `get_ui_actions` and invoke by action id when possible.

This keeps slash commands useful without making slash text the canonical remote protocol.

## Fast Mode Design

Fast mode should be a host-owned policy action, not an iOS hardcoded provider map.

### User Intent

Fast mode means: prefer speed and lower cost/latency over maximum reasoning depth when the current model/profile supports a meaningful speed tradeoff.

The exact implementation may vary by provider and settings:

- Lower thinking level from `high` to `low`, `minimal`, or `off`.
- Switch from a slower scoped model to a faster scoped model.
- Disable optional deep-review behavior.
- Use a configured fast model profile.
- Do nothing with a clear disabled reason if no fast variant exists.

### Action Shape

```json
{
  "id": "model.fast_mode",
  "label": "Fast mode",
  "description": "Prefer lower latency model settings when supported.",
  "source": "builtin",
  "category": "model",
  "presentation": { "kind": "toggle", "group": "Model" },
  "enabled": true,
  "state": {
    "type": "boolean",
    "value": false
  },
  "args": [
    {
      "name": "enabled",
      "type": "boolean",
      "required": true
    }
  ]
}
```

Invocation:

```json
{"type":"invoke_ui_action","action":"model.fast_mode","args":{"enabled":true}}
```

Response can include the applied policy:

```json
{
  "type": "response",
  "command": "invoke_ui_action",
  "success": true,
  "data": {
    "action": "model.fast_mode",
    "status": "completed",
    "state": { "value": true },
    "applied": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinkingLevel": "low"
    }
  }
}
```

The app can display applied state but should not calculate it.

### Open Policy Questions

- Should fast mode persist as a settings/profile preference or be session-local?
- Should it be a simple thinking-level toggle first, then model policy later?
- How should fast mode interact with scoped model cycling and profile defaults?
- Should there also be a **Deep mode** or **Review mode** action, or is fast mode enough?

## Review Cards Design

Review workflows are a strong fit for native action cards.

Initial card set:

- Review uncommitted changes.
- Review staged changes.
- Review current branch against base.
- Review PR by URL/number.
- Review commit by ref.

Potential descriptors:

```json
{
  "id": "review.uncommitted",
  "label": "Review changes",
  "description": "Review uncommitted workspace changes.",
  "presentation": { "kind": "card", "group": "Review", "priority": 100 },
  "enabled": true
}
```

```json
{
  "id": "review.branch",
  "label": "Review branch",
  "description": "Review the current branch against its merge base.",
  "presentation": { "kind": "card", "group": "Review", "priority": 90 },
  "enabled": true,
  "args": [
    {
      "name": "base",
      "type": "string",
      "required": false,
      "placeholder": "main"
    }
  ]
}
```

Host-side review execution should remain responsible for:

- Git/gh command execution.
- Tool selection.
- Review prompt construction.
- Session replacement if review findings start a fresh session.
- Model choice if a review model is configured.
- Security checks and project trust.

The iOS app should only provide user intent and optional arguments.

## Relationship to Existing RPC Commands

Several built-in actions already have RPC equivalents. The action layer can initially delegate to those instead of duplicating logic.

| User-facing action | Existing RPC equivalent | Long-term action id |
| --- | --- | --- |
| New conversation | `new_session` | `session.new` |
| Load transcript | `get_transcript` | not normally a user action |
| List sessions | `list_sessions` | `session.list` or native screen data source |
| Resume session | `switch_session_by_id` | `session.switch` |
| Cancel active run | `abort` | `run.cancel` |
| Compact context | `compact` in local RPC, currently not remote allowlisted | `context.compact` |
| Set session name | `set_session_name` in local RPC | `session.rename` |
| Set model | `set_model` in local RPC | `model.set` |
| Get models | `get_available_models` in local RPC | data source for `model.set` |
| Extension command | `prompt` with `/cmd` | `extension.command.*` |
| Skill | `prompt` with `/skill:name` | `skill.*` |
| Prompt template | `prompt` with `/template` | `prompt.template.*` |

For Iroh remote, every action must be separately reviewed before being exposed. Existing local RPC availability does not automatically imply remote availability.

## Remote Security Model

The remote action layer must be allowlist-based.

Each action should declare or derive:

- `remoteSafe`: can be exposed to remote clients.
- `requiresConfirmation`: app should ask or host will ask before execution.
- `destructive`: action can mutate local state or files.
- `requiresTrust`: action requires project trust.
- `requiredCapabilities`: feature flags or protocol versions.
- `allowedDuringStreaming`: whether action can run while the agent is active.

Host policy remains authoritative even if the app shows stale enabled state. `invoke_ui_action` must re-check permissions and current state before execution.

Remote descriptors must not expose:

- Host-local file paths.
- Extension source file paths.
- Prompt template bodies.
- Skill full content or base directories.
- Raw package install paths.
- Provider secrets, auth state internals, or environment variables.
- Full session/transcript payloads.

Descriptors may expose bounded/sanitized:

- Command name.
- Description.
- Source kind.
- Source scope such as `user`, `project`, or `package`.
- Package/display label if safe.
- Argument hints.
- Enabled state and disabled reason.

## Extension Model

There are two levels of extension support.

### Phase 1: Project Existing Extension Commands

Existing `volt.registerCommand()` commands appear as palette actions. They can be invoked remotely by action id, but the host internally calls the registered command handler.

Behavior:

- Remote descriptor uses command `invocationName`, description, and argument completion if safe.
- Invocation passes a single `arguments` string, matching existing command handler semantics.
- Extension UI requests continue through the existing `extension_ui_request` protocol.
- Commands that rely on TUI-only APIs may receive degraded RPC UI behavior just as they do today.

### Future: Extension-Provided Native Actions

Add a richer extension API so extensions can declare native actions directly:

```ts
volt.registerAction({
  id: "my-extension.deploy",
  label: "Deploy",
  description: "Deploy current branch",
  presentation: { kind: "card", group: "Deploy" },
  args: [
    { name: "environment", type: "string", required: true, options: ["dev", "staging", "prod"] },
  ],
  remoteSafe: true,
  async handler(args, ctx) {
    // ...
  },
});
```

This avoids overloading slash command strings and gives extensions first-class native UI metadata.

Extension-provided actions must pass the same trust and remote-safety filters as extension commands.

## UI Request Protocol Evolution

The current extension UI protocol already supports:

- `select`
- `confirm`
- `input`
- `editor`
- `notify`
- `setStatus`
- `setWidget`
- `setTitle`
- `set_editor_text`

Long term, built-in actions should use the same request/response mechanism when they need user input. For example, `session.new` could request confirmation; `model.set` could request a picker; `review.pr` could request a text input.

Potential additions:

- `form`: structured multi-field input.
- `progress`: bounded progress status separate from transcript.
- `openPanel`: request that the app opens a specific native panel.
- `actionResult`: rich result notification for action cards.

The first implementation should avoid complex custom layouts. iOS can build native screens from action descriptors and simple UI requests.

## iOS UX Model

### Action Center Page

A dedicated page can show curated groups:

- **Review**: Review changes, Review branch, Review PR.
- **Model**: Fast mode, Thinking level, Model picker.
- **Session**: New conversation, Resume session, Rename session.
- **Context**: Compact context, Load older transcript.
- **Extensions**: Extension commands and extension-provided cards.
- **Skills**: Skill invocations.

The app should distinguish:

- Host-curated primary actions.
- User/project extension actions.
- Advanced palette items.
- Disabled actions with explanation.

### Prompt Editor Integration

The prompt editor can support slash autocomplete by querying action descriptors:

- `/` opens a native command palette.
- Selecting an action either inserts text, opens an argument form, or invokes directly.
- For text-producing prompt templates and skills, the app can show a form and then invoke by id.
- For advanced compatibility, raw text submission remains supported.

### Card Invocation Flow

1. User taps card.
2. If required arguments are missing, app opens a native form.
3. If `requiresConfirmation` is true, app confirms or lets host send a confirmation UI request.
4. App sends `invoke_ui_action`.
5. App shows optimistic pending state for that action.
6. Host response confirms accepted/completed/rejected.
7. Transcript and state update from normal events.

### Stale Data Handling

Action descriptors can become stale when:

- Session switches.
- Extensions reload.
- Project trust changes.
- Model changes.
- Agent starts/stops streaming.
- Remote workspace changes.

The app should refresh actions after:

- Initial connect/reconnect.
- `get_state` showing a new `sessionId`.
- `ui_actions_changed` event.
- Successful `new_session` or `switch_session_by_id`.
- Extension reload completion.

## Protocol Versioning

Add explicit capabilities so clients can adapt safely.

Example:

```json
{
  "type": "response",
  "command": "get_ui_capabilities",
  "success": true,
  "data": {
    "protocolVersion": 1,
    "features": [
      "ui_actions.v1",
      "ui_action_invocation.v1",
      "ui_action_completions.v1"
    ],
    "maxActions": 200,
    "maxDescriptorBytes": 65536
  }
}
```

Compatibility rules:

- Clients ignore unknown descriptor fields.
- Hosts reject unknown action ids at invocation time.
- Hosts may omit actions that are unavailable or unsafe for the client.
- Clients should handle missing features by falling back to current prompt/new-session/session-list behavior.

## Host Implementation Plan

### Phase A: Design and Inventory

1. Inventory existing built-in TUI slash commands.
2. Classify each as:
   - already has RPC equivalent,
   - easy remote-safe action,
   - requires native UI/dialog support,
   - local-only/TUI-only for now,
   - sensitive or not appropriate for remote.
3. Define the initial `UiActionDescriptor` TypeScript types.
4. Define `get_ui_capabilities`, `get_ui_actions`, and `invoke_ui_action` RPC types.
5. Decide the initial Iroh allowlist subset.

### Phase B: Read-Only/Compatibility Discovery

1. Add remote-safe command/action discovery for extension commands, prompt templates, and skills.
2. Omit or sanitize source paths.
3. Add iOS command palette support using descriptors.
4. Invoke extension/prompt/skill actions through existing `prompt` semantics internally.
5. Fix iOS prompt-response handling so prompt commands that complete without `agent_end` do not leave the app stuck in streaming state.

### Phase C: Shared Built-in Action Registry

1. Move simple built-ins from `interactive-mode.ts` into a shared action registry:
   - `session.new`
   - `context.compact`
   - `session.rename`
   - `run.cancel`
   - `session.resume` data-source hooks
2. Keep TUI slash names as aliases.
3. Expose the safe subset through RPC.
4. Add tests proving TUI slash and RPC action invocation hit the same handler.

### Phase D: Review and Model Actions

1. Refactor `/review` into shared action handlers:
   - `review.tools`
   - `review.uncommitted`
   - `review.branch`
   - `review.pr`
   - `review.commit`
2. Add native action descriptors for review cards.
3. Add `model.fast_mode` or a smaller first version such as `thinking.fast_mode`.
4. Expose model/thinking state changes as action state updates.
5. Add iOS cards for Review and Fast mode.

### Phase E: Rich Extension Actions

1. Add `volt.registerAction()` extension API.
2. Add descriptor validation and remote-safety fields.
3. Add argument schema and completion support.
4. Render extension cards in iOS when remote-safe.
5. Keep extension slash commands as compatibility palette actions.

## iOS Implementation Plan

### Phase 1: Discovery and Palette

1. Add Swift models for action descriptors.
2. Add `VoltRPCCommand.getUIActions()` and `VoltRPCCommand.invokeUIAction(...)` once host support exists.
3. Load actions after connect/reconnect and session switch.
4. Add a searchable action palette.
5. Invoke simple no-arg actions and actions with a single string argument.
6. Keep existing prompt submission path as fallback.

### Phase 2: Native Cards

1. Add an Actions tab/page or sheet.
2. Render primary host actions as grouped cards.
3. Add built-in card layouts for Review, Model, Session, and Context groups.
4. Show disabled actions with host-provided reasons.
5. Add pending/completed/error UI around invocation responses.

### Phase 3: Forms and Toggles

1. Render descriptor-driven string/boolean/enum arguments.
2. Support `toggle` presentation and state refresh.
3. Add Fast mode card/toggle.
4. Add Review PR form.
5. Add model/thinking picker actions when remote-safe.

### Phase 4: Extension Cards

1. Render extension-provided remote-safe action cards.
2. Show source scope/package label.
3. Route extension dialogs through existing extension UI handling.
4. Add user affordances to hide or pin extension actions locally.

## Testing Plan

### Host Unit Tests

- `get_ui_actions` returns only remote-safe actions over Iroh.
- Action descriptors omit host-local paths and prompt/skill bodies.
- Disabled state updates when streaming starts/stops.
- Unknown action id returns a normal RPC error.
- Built-in action invocation re-checks availability at execution time.
- Extension command projection preserves invocation names, including duplicate suffixes.
- Prompt template and skill actions invoke through host expansion, not client expansion.
- `invoke_ui_action` for a prompt-like action returns success on acceptance and streams normal agent events.
- Actions that complete synchronously do not require `agent_end`.

### Host Integration Tests

- TUI `/compact` and RPC `invoke_ui_action(context.compact)` use the same core handler.
- TUI `/review uncommitted` and RPC `invoke_ui_action(review.uncommitted)` produce equivalent session behavior.
- Iroh remote rejects local-only actions.
- Iroh outbound sanitizer applies to action responses and extension UI events.
- Revoked or unauthorized clients cannot invoke actions.
- Session switch/reload causes action descriptors to refresh.

### iOS Tests

- Command encoding for `get_ui_actions` and `invoke_ui_action`.
- Descriptor parsing skips invalid or partial action entries safely.
- Action list loads after connect/reconnect.
- Session switch clears/refreshes transcript and action list.
- Synchronous action response clears pending UI state without waiting for `agent_end`.
- Prompt-like action keeps streaming state until `agent_end`.
- Toggle state updates from response or refresh.
- Disabled actions render with reason and do not invoke.

### Manual iOS Smoke

1. Connect to a trusted host over Iroh.
2. Open the native Actions page.
3. Confirm primary cards load.
4. Tap Review uncommitted and verify a review run starts.
5. Tap Fast mode and verify model/thinking state updates.
6. Invoke a skill from the command palette.
7. Invoke an extension command that emits a notification.
8. Disconnect/reconnect and verify actions refresh.
9. Try an action while streaming and verify disabled or queued behavior matches host state.

Record device, iOS version, macOS version, relay mode, workspace, and host commit.

## Migration Strategy

The design should not require a flag day.

1. Keep existing RPC commands working.
2. Keep raw `prompt` slash invocation working for extension commands, skills, and prompt templates.
3. Add action discovery as an optional capability.
4. Let iOS use actions opportunistically when available.
5. Gradually move TUI built-ins into shared action handlers.
6. Eventually make slash command autocomplete consume the same action registry.

## Open Decisions

1. **Action ids for extension commands**
   - Option A: deterministic hash of source info plus invocation name.
   - Option B: session-local ids that must be refreshed after reload.
   - Proposed: session-local opaque ids for v1 remote descriptors, with stable built-in ids only.

2. **Fast mode persistence**
   - Session-local, profile-level, or global setting.
   - Proposed first implementation: session-local or profile-level depending on existing settings model; avoid global surprises.

3. **Remote model selection**
   - Current remote allowlist blocks `get_available_models` and `set_model`.
   - Need a separate remote-safe model policy review before exposing full model/provider metadata.
   - Fast mode may be safer than raw model selection because the host keeps provider policy private.

4. **Action result detail**
   - Keep invocation response small and rely on transcript/state events, or return richer action-specific results.
   - Proposed first implementation: small generic response plus normal events.

5. **Built-in review exposure over Iroh**
   - Review can run git/gh commands and may inspect workspace data.
   - Need confirmation that this is acceptable for an authorized paired client and consistent with tool policy.

6. **Extension-provided card trust**
   - Project-local extension actions should only appear after project trust.
   - Need UI labeling so users can distinguish built-in and extension/package actions.

7. **Argument schema format**
   - Reuse TypeBox/JSON Schema subset or define a small custom schema.
   - Proposed first implementation: small custom schema for `string`, `boolean`, `enum`, and `integer`, with room for JSON Schema later.

8. **Action availability while streaming**
   - Some actions can execute immediately, some can queue, some must be disabled.
   - Need per-action `streamingBehavior`: `disabled`, `immediate`, `queueSteer`, `queueFollowUp`, or `custom`.

## Acceptance Criteria

- A design exists for native iOS action cards and command palette backed by host-owned action descriptors.
- Slash commands are treated as aliases/presentation, not the canonical mobile protocol.
- The design supports built-in actions, extension commands, prompt templates, skills, and future extension-provided native actions.
- The design preserves the current remote security boundary and keeps source paths/template bodies/skill content out of descriptors.
- There is a phased plan that can start with remote-safe discovery and evolve into a shared TUI/RPC action registry.
- Review cards and Fast mode have concrete proposed action shapes.
- Tests cover descriptor safety, invocation semantics, iOS parsing, and synchronous-versus-streaming action behavior.

## Implementation Notes

- Resolved items should be recorded here as `Resolved YYYY-MM-DD:` entries.
- Initial implementation should prefer a narrow action subset over exposing broad local RPC capabilities.
- If an action would currently require exposing blocked RPC data over Iroh, it should stay local-only until its remote-safe projection is designed.
