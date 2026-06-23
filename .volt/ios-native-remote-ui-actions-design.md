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

- Host exposes `thinking.fast_mode` with current state `off`, enabled `true`, and display text "Fast mode".
- User toggles it on.
- iOS sends `invoke_ui_action` with action id `thinking.fast_mode` and `{ "enabled": true }`.
- Host lowers the current session thinking level when that is supported by the current model.
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

- Stable `id`, such as `review.uncommitted` or `thinking.fast_mode`.
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
{"type":"ui_action_state_changed","action":"thinking.fast_mode","state":{"value":"on"}}
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
| `/review` | none | deferred pending registry | Not in the first discovery subset. A.5 resolves remote-native review exposure to `review.uncommitted` and `review.branch` after shared action handlers exist. |
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
| Model/thinking | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level` | Direct RPC stays local-only over Iroh. A.4 allows only the narrower future `thinking.fast_mode` action after shared action authorization exists. |
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

Review actions are deferred from the first discovery phase. Current `/review` runs git or `gh`, may prompt for target/tool choices, uses review-model policy, runs an isolated agent session, and then starts a fresh session with findings. A.5 resolves the first native review card set as a narrow remote-safe subset plus local-only/deferred review targets.

Fast mode is deferred from the first discovery phase. Current model and thinking RPC commands are local-only over Iroh. A.4 resolves the first native model-speed action as the narrower `thinking.fast_mode` substitute described below.

## Action Descriptor Shape

### Resolved 2026-06-23: V1 Descriptor Schema, Ids, and Compatibility

A.2 decision: v1 uses a small custom descriptor schema. Built-in action ids are stable and semantic. Projected extension commands, prompt templates, and skills use session-local opaque ids for v1. Future extension-provided native actions may add stable extension-owned ids only after E.3 defines registration, trust, and compatibility rules.

Normative v1 TypeScript shape:

```ts
type UiActionSource = "builtin" | "extension" | "prompt" | "skill" | "package";
type UiActionCategory = "review" | "session" | "model" | "context" | "extension" | "prompt" | "skill" | "advanced";
type UiActionPresentationKind = "card" | "button" | "toggle" | "picker" | "palette" | "detail" | "hidden";
type UiActionArgumentType = "string" | "boolean" | "enum" | "integer";
type UiActionStateType = "boolean" | "string" | "enum" | "integer";
type UiActionStreamingBehavior = "disabled" | "immediate" | "queueSteer" | "queueFollowUp";
type UiActionScalar = string | number | boolean | null;

interface UiActionDescriptor {
  schemaVersion: 1;
  id: string;
  label: string;
  description?: string;
  source: UiActionSource;
  sourceScope?: "user" | "project" | "temporary";
  sourceOrigin?: "package" | "top-level";
  sourceLabel?: string;
  category: UiActionCategory | string;
  presentation?: UiActionPresentationHint;
  args?: UiActionArgumentDescriptor[];
  state?: UiActionStateDescriptor;
  enabled: boolean;
  disabledReason?: string | null;
  destructive?: boolean;
  requiresConfirmation?: boolean;
  streamingBehavior?: UiActionStreamingBehavior | UiActionStreamingBehavior[];
  remoteSafe: boolean;
  slash?: UiActionSlashAlias;
}

interface UiActionPresentationHint {
  kind: UiActionPresentationKind | string;
  group?: string;
  priority?: number;
  icon?: string;
}

interface UiActionArgumentDescriptor {
  name: string;
  label?: string;
  description?: string;
  type: UiActionArgumentType;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: UiActionScalar;
  options?: Array<{ value: string; label?: string; description?: string }>;
  completion?: "commandArguments" | string;
}

interface UiActionStateDescriptor {
  type: UiActionStateType | string;
  value: UiActionScalar;
  label?: string;
  options?: Array<{ value: string; label?: string; description?: string }>;
}

interface UiActionSlashAlias {
  name: string;
  example?: string;
}
```

Field rules:

- `schemaVersion` is required and must be `1` for this contract.
- `id`, `label`, `source`, `category`, `enabled`, and `remoteSafe` are required.
- `description`, labels, hints, group names, icon names, and disabled reasons are display strings. They must be bounded by host-side descriptor limits and must not include source paths or secrets.
- `sourceScope`, `sourceOrigin`, and `sourceLabel` are optional sanitized provenance. They are replacements for raw `SourceInfo`, not a direct projection of it.
- `presentation` is a hint. Unknown `presentation.kind` values must render as a palette/list item or be ignored.
- `args` describes the data shape the app may collect. The first implementation may support only a single optional string argument, but descriptors should use this shape so later forms remain compatible.
- `state` is a display snapshot for toggles, pickers, or selected values. Host state remains authoritative and must be refreshed after invocation, reconnect, or `ui_action_state_changed`.
- `destructive` and `requiresConfirmation` default to `false` when omitted. The host may still require confirmation or reject an action at invocation time.
- `streamingBehavior` describes what the host may do if the action is invoked while an agent turn is already streaming. Omitted means `disabled`. Multiple values mean the client may select between allowed queue modes when invoking.
- `remoteSafe` describes whether the action may be shown to a remote client after filtering. It is not an authorization grant.
- `slash` is an alias/presentation hint only. Clients must not treat slash text as the canonical action id.

Id rules:

- Built-in ids are stable, semantic, lower-case, dot-separated ids such as `session.new`, `run.cancel`, `context.compact`, `session.rename`, `review.uncommitted`, or `thinking.fast_mode`. Once shipped, a built-in id must not be reused for a different behavior. Breaking behavior requires a new id.
- V1 projected extension command ids are session-local opaque ids under the `extension.command.` prefix, for example `extension.command.ec_7f3k2q`. They are derived from the current host action catalog, not from raw source paths.
- V1 projected prompt template ids are session-local opaque ids under the `prompt.template.` prefix, for example `prompt.template.pt_4v9m1x`.
- V1 projected skill ids are session-local opaque ids under the `skill.` prefix, for example `skill.sk_8k2p0d`.
- Dynamic ids are valid only for the action list/revision that returned them. Clients must not persist them across reconnect, session switch, reload, project trust change, or host restart. After any refresh trigger, clients must discard old dynamic ids and use the latest descriptors.
- The human slash alias and display label may remain stable while the action id changes. Invocation must use `id`, not `slash.name`.
- Stable extension-owned ids are deferred until `volt.registerAction()` or an equivalent first-class action API defines package identity, project trust, collision handling, and migration semantics.

Compatibility rules:

- Clients must ignore unknown descriptor fields.
- Clients should skip descriptors missing required fields or containing invalid required field types.
- Clients must tolerate unknown `source`, `category`, `presentation.kind`, argument type, and state type values. Unknown categories render in an advanced/other group; unknown presentation kinds render as palette rows; unknown argument types make the action non-invokable from generated forms.
- Clients must ignore unknown `streamingBehavior` values. If no known streaming behavior remains and the agent is streaming, the action should render disabled until actions refresh.
- Hosts must reject unknown, stale, disabled, unauthorized, or not-remote-safe action ids at invocation time with the normal RPC error shape.
- Descriptors are advisory snapshots. Hosts must re-check availability, streaming state, project trust, remote policy, and authorization when `invoke_ui_action` is received.
- Hosts may omit actions that are unavailable, unsafe, too large, or unsupported by the requesting client capabilities.
- Additive fields and enum values do not require a new protocol version. Removing required fields, changing required field meanings, or changing invocation semantics requires a new capability or schema version.
- Remote descriptors must never include `sourceInfo.path`, `baseDir`, `filePath`, prompt template `content`, full skill content, raw package install paths, provider secrets, environment values, auth internals, raw model/provider metadata, raw transcript payloads, or host session file paths.

Example descriptor:

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
  "requiresConfirmation": true,
  "streamingBehavior": "disabled",
  "remoteSafe": true,
  "args": []
}
```

Built-in action ids should be stable and semantic. Dynamic source action ids should be opaque and session-local. No action id should include display labels, localized text, file paths, or extension source paths.

### Built-in Sources

Built-in examples:

```json
{
  "schemaVersion": 1,
  "id": "session.new",
  "label": "New conversation",
  "source": "builtin",
  "category": "session",
  "presentation": { "kind": "button", "group": "Session" },
  "slash": { "name": "clear", "example": "/clear" },
  "enabled": true,
  "requiresConfirmation": true,
  "remoteSafe": true
}
```

```json
{
  "schemaVersion": 1,
  "id": "context.compact",
  "label": "Compact context",
  "source": "builtin",
  "category": "context",
  "presentation": { "kind": "card", "group": "Context" },
  "slash": { "name": "compact", "example": "/compact" },
  "enabled": true,
  "remoteSafe": false,
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
  "schemaVersion": 1,
  "id": "review.pr",
  "label": "Review PR",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "card", "group": "Review" },
  "slash": { "name": "review", "example": "/review pr <url>" },
  "enabled": false,
  "disabledReason": "GitHub credential and network policy is not remote-safe yet.",
  "requiresConfirmation": true,
  "remoteSafe": false,
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
  "schemaVersion": 1,
  "id": "extension.command.ec_7f3k2q",
  "label": "Deploy",
  "description": "Deploy to an environment",
  "source": "extension",
  "sourceScope": "project",
  "sourceOrigin": "package",
  "sourceLabel": "deploy-tools",
  "category": "extension",
  "presentation": { "kind": "palette", "group": "Extensions" },
  "slash": { "name": "deploy", "example": "/deploy" },
  "enabled": true,
  "remoteSafe": true,
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

Remote projection must not include host-local `sourceInfo.path` by default. If provenance is useful, expose only sanitized `sourceScope`, `sourceOrigin`, and `sourceLabel` fields.

### Prompt Template Sources

Prompt templates can become actions whose execution sends the expanded prompt:

```json
{
  "schemaVersion": 1,
  "id": "prompt.template.pt_4v9m1x",
  "label": "review",
  "description": "Review staged git changes",
  "source": "prompt",
  "sourceScope": "project",
  "sourceOrigin": "top-level",
  "category": "prompt",
  "presentation": { "kind": "palette", "group": "Prompts" },
  "slash": { "name": "review", "example": "/review" },
  "enabled": true,
  "remoteSafe": true,
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
  "schemaVersion": 1,
  "id": "skill.sk_8k2p0d",
  "label": "pi-goal-writer",
  "description": "Drafts and reviews strong /goal objectives.",
  "source": "skill",
  "sourceScope": "user",
  "sourceOrigin": "top-level",
  "category": "skill",
  "presentation": { "kind": "palette", "group": "Skills" },
  "slash": { "name": "skill:pi-goal-writer", "example": "/skill:pi-goal-writer" },
  "enabled": true,
  "remoteSafe": true,
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

`invoke_ui_action` response data reports the command disposition, not necessarily final workflow completion. Prompt-like actions keep the existing `prompt` contract: the RPC response means the host accepted the request after preflight, and the normal agent event stream reports the turn lifecycle.

Request shape:

```ts
interface InvokeUiActionCommand {
  action: string;
  args?: Record<string, unknown>;
  streamingBehavior?: "steer" | "followUp";
}
```

Response data shape:

```ts
type UiActionInvocationStatus =
  | "accepted"
  | "completed"
  | "queued"
  | "handled"
  | "cancelled";

interface UiActionInvocationResponse {
  action: string;
  status: UiActionInvocationStatus;
  queuedAs?: "steer" | "followUp";
  state?: UiActionStateDescriptor;
  stateChanged?: boolean;
  actionsChanged?: boolean;
  message?: string;
}
```

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

- `accepted`: a prompt-like action was accepted while idle and will produce normal agent events. iOS should enter or keep streaming UI state and clear action pending state only when the turn reaches `agent_end`, fails, or the connection recovery path replaces the session state.
- `queued`: a prompt-like action was accepted while another turn is streaming. `queuedAs` names whether the host queued it as a `steer` or `followUp`. iOS should clear the tap/send pending spinner on the response, keep the current streaming state, and rely on `queue_update` plus later agent events for queue visibility and completion.
- `completed`: the action finished synchronously and no agent events are expected. iOS should clear pending UI immediately and apply any returned state or refresh hints.
- `handled`: the host, an extension command, or an input hook handled the action without starting an agent turn. No `agent_end` is expected; iOS should clear pending UI immediately.
- `cancelled`: the action was cancelled before execution by the user, host, or extension. No `agent_end` is expected; iOS should clear pending UI immediately.

Only `accepted` and `queued` may require waiting for later agent events after the RPC response. `completed`, `handled`, and `cancelled` are terminal for the invocation response itself. Clients must not use a `promptAndWait`-style `agent_end` wait for terminal synchronous statuses because extension/input-hook handling can intentionally produce no agent turn.

Synchronous state actions return `completed` with `stateChanged`, `actionsChanged`, or bounded response data when useful. If the response says actions changed, iOS should refresh `get_ui_actions`; if it says state changed, iOS should refresh `get_state` unless the response already contains the new state shape for the specific action.

While the agent is streaming, the host rechecks the current action descriptor and handler policy before invocation:

- `disabled`: reject with a normal RPC error.
- `immediate`: execute now and return `completed`, `handled`, or `cancelled`.
- `queueSteer`: enqueue as steering and return `queued` with `queuedAs: "steer"`.
- `queueFollowUp`: enqueue as a follow-up and return `queued` with `queuedAs: "followUp"`.

If a descriptor allows both queue modes, the optional `streamingBehavior` request field selects the mode. If a prompt-like action has no streaming policy and the agent is already streaming, the host rejects it instead of guessing.

The host must never trust cached client availability. On every invocation it resolves the action id against the current registry, applies the Iroh/local allowlist, validates arguments, rechecks `enabled`, `remoteSafe`, trust, session state, and streaming policy, then executes the current handler. Unknown, stale, disabled, local-only, or disallowed actions fail with the normal RPC error shape even if an older descriptor advertised them as enabled.

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

Expected later tests:

- `B.1` RPC shape tests cover parsing `invoke_ui_action` request fields and serializing all five status values.
- `B.4` host tests cover idle prompt-like `accepted`, streaming `queued` steer/follow-up, immediate `handled`, synchronous `completed`, `cancelled`, stale id rejection, disabled action rejection, and invocation-time enabled rechecks.
- `B.5` Iroh tests cover remote allowlist rejection and confirm synchronous responses do not wait for `agent_end` before remote command completion.
- `C.4` iOS tests cover `accepted` waiting for `agent_end`, `queued` preserving current streaming/queue UI, terminal synchronous statuses clearing pending UI immediately, and RPC errors clearing pending UI with a system-visible error.

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

### Resolved 2026-06-23: Fast Mode Policy Boundary

A.4 decision: full `model.fast_mode` is deferred. The v1 model-speed action is `thinking.fast_mode`, a session-local toggle that only changes the current session's thinking level. It never switches models, changes scoped model lists, edits profile/global defaults, or exposes model catalog metadata.

`thinking.fast_mode` may be exposed to iOS over Iroh after the shared action registry and `invoke_ui_action` remote allowlist exist. Direct remote `set_thinking_level`, `cycle_thinking_level`, `set_model`, `cycle_model`, and `get_available_models` remain blocked. The action is safe because the host computes the target level from the current session model and returns only bounded action state, not the provider's full model/thinking matrix.

Persistence:

- Fast mode is session-local and non-persistent.
- Enabling or disabling it must call thinking-level mutation with default persistence disabled.
- It must not write `defaultThinkingLevel`, `defaultProvider`, `defaultModel`, `enabledModels`, profile settings, or review model settings.
- New session, session switch, profile switch, resource reload, model switch, model cycle, or scoped-model changes clear the fast-mode overlay and recompute descriptor state.

Policy:

- Enabling captures the current thinking level as the restore level, then applies the lowest-latency supported level that lowers the current model's thinking setting.
- The target order is `off`, then `minimal`, then `low`, filtered by the current model's supported thinking levels.
- If the target would not lower the current level, the descriptor is disabled with a reason such as "Current model is already at its fastest supported thinking level."
- Disabling restores the captured thinking level, clamped to the current model if the model changed before the action state refreshed.
- Manual thinking-level changes, explicit model changes, profile switches, and scoped-model changes turn fast mode off; the user's explicit choice becomes the new session state.

Scoped models and profiles remain authoritative:

- Profile defaults and scoped model `:thinking` suffixes define the base session model/thinking state.
- Fast mode is an overlay on that base state for the current session only.
- Scoped model cycling keeps its existing behavior: an explicit scoped thinking level overrides the previous session level, and an omitted scoped thinking level inherits the current session preference after fast mode has been cleared.
- A future full `model.fast_mode` may switch models only after a separate remote model policy defines how host-owned fast variants are configured and how profile/scoped defaults are restored.

iOS may display only host-provided, bounded metadata:

- Action label, description, presentation, boolean state, state label, disabled reason, and invocation message.
- The current active model provider/id and thinking level already available through `get_state`.
- No model catalog, costs, provider capability matrices, auth state, profile contents, scoped model list, configured defaults, or provider-specific thinking maps.

### User Intent

Fast mode means: prefer speed and lower cost/latency over maximum reasoning depth when the current model/profile supports a meaningful speed tradeoff.

The v1 implementation is deliberately narrower than the long-term product idea:

- Lower the current thinking level to `off`, `minimal`, or `low` when that is supported and actually lowers latency.
- Do nothing with a clear disabled reason if no faster thinking level exists.
- Do not switch models, select a configured fast profile, or change review behavior in v1.

### Action Shape

```json
{
  "schemaVersion": 1,
  "id": "thinking.fast_mode",
  "label": "Fast mode",
  "description": "Use the fastest supported thinking level for this session.",
  "source": "builtin",
  "category": "model",
  "presentation": { "kind": "toggle", "group": "Model" },
  "enabled": true,
  "remoteSafe": true,
  "streamingBehavior": "disabled",
  "state": {
    "type": "boolean",
    "value": false,
    "label": "Normal reasoning"
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
{"type":"invoke_ui_action","action":"thinking.fast_mode","args":{"enabled":true}}
```

Response uses generic action state and refresh hints:

```json
{
  "type": "response",
  "command": "invoke_ui_action",
  "success": true,
  "data": {
    "action": "thinking.fast_mode",
    "status": "completed",
    "state": { "type": "boolean", "value": true, "label": "Fast: minimal thinking" },
    "stateChanged": true,
    "actionsChanged": true,
    "message": "Fast mode enabled: minimal thinking"
  }
}
```

The app can display returned state and message but should not calculate the target level.

### Deferred Full Model Fast Mode

Full `model.fast_mode` remains deferred until a remote model policy answers:

- How users configure host-owned fast variants without exposing raw model catalogs over Iroh.
- Whether model-speed preferences live in a profile, a named policy, or session state.
- How to restore scoped model/profile defaults after a temporary fast model switch.
- Whether **Deep mode** or review-specific model policy should be separate actions.

## Review Cards Design

Review workflows are a strong fit for native action cards.

### Resolved 2026-06-23: Review Remote-Safety and First Card Set

A.5 decision: v1 exposes only two remotely visible review cards after the shared action registry exists:

- `review.uncommitted`: review uncommitted workspace changes against `HEAD`, including untracked file names as extra context.
- `review.branch`: review `HEAD` against a base branch. The `base` argument is optional; if omitted the host auto-detects `origin/HEAD`, `main`, or `master`.

These actions may be shown over Iroh only after `invoke_ui_action` reauthorization exists. They require confirmation, are disabled while streaming or compacting, and use `streamingBehavior: "disabled"`. They are not file-destructive, but they do consume model tokens, inspect workspace diffs, may read project files during the isolated review session, and create a fresh Volt session seeded with findings.

Deferred or local-only review actions:

- `review.pr`: local-only in v1. It runs `gh pr view` and `gh pr diff`, can contact GitHub, and may use host GitHub credentials or expose private PR metadata. Remote unlock requires a GitHub/network credential policy and confirmation copy that names that external access.
- `review.commit`: local-only in v1. It needs a native recent-commit picker or explicit arbitrary-ref policy before remote exposure, because commit subjects/history are a separate data surface.
- `review.tools`: local-only. Tool selection persists `reviewTools` settings and can reveal extension/custom tool names and provenance; remote review tool policy is fixed by the host.
- `review.staged`: deferred because the current review implementation has no staged-only target.

First remote descriptors:

```json
{
  "schemaVersion": 1,
  "id": "review.uncommitted",
  "label": "Review changes",
  "description": "Review uncommitted workspace changes.",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "card", "group": "Review", "priority": 100 },
  "enabled": true,
  "remoteSafe": true,
  "requiresConfirmation": true,
  "destructive": false,
  "streamingBehavior": "disabled",
  "slash": { "name": "review", "example": "/review uncommitted" }
}
```

```json
{
  "schemaVersion": 1,
  "id": "review.branch",
  "label": "Review branch",
  "description": "Review the current branch against its merge base.",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "card", "group": "Review", "priority": 90 },
  "enabled": true,
  "remoteSafe": true,
  "requiresConfirmation": true,
  "destructive": false,
  "streamingBehavior": "disabled",
  "slash": { "name": "review", "example": "/review branch [base]" },
  "args": [
    {
      "name": "base",
      "label": "Base branch",
      "type": "string",
      "required": false,
      "placeholder": "main"
    }
  ]
}
```

Local-only/deferred descriptors can exist in local RPC/TUI action discovery, but must be filtered from Iroh until their policy is resolved:

```json
{
  "schemaVersion": 1,
  "id": "review.pr",
  "label": "Review PR",
  "description": "Review a GitHub pull request.",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "card", "group": "Review", "priority": 80 },
  "enabled": false,
  "disabledReason": "GitHub credential and network policy is not remote-safe yet.",
  "remoteSafe": false,
  "requiresConfirmation": true,
  "slash": { "name": "review", "example": "/review pr [number]" },
  "args": [
    {
      "name": "target",
      "label": "PR number, URL, or branch",
      "type": "string",
      "required": false,
      "placeholder": "123"
    }
  ]
}
```

```json
{
  "schemaVersion": 1,
  "id": "review.commit",
  "label": "Review commit",
  "description": "Review one commit by ref.",
  "source": "builtin",
  "category": "review",
  "presentation": { "kind": "palette", "group": "Review", "priority": 70 },
  "enabled": false,
  "disabledReason": "Commit picker and arbitrary-ref policy are not remote-safe yet.",
  "remoteSafe": false,
  "requiresConfirmation": true,
  "slash": { "name": "review", "example": "/review commit <sha>" },
  "args": [
    {
      "name": "sha",
      "label": "Commit ref",
      "type": "string",
      "required": true,
      "placeholder": "HEAD"
    }
  ]
}
```

Host-side review execution remains authoritative for:

- Fixed git command execution for remote-safe targets:
  - `review.uncommitted`: `git rev-parse --is-inside-work-tree`, `git diff HEAD` or no-commit fallback `git diff --cached` plus `git diff`, and `git ls-files --others --exclude-standard`.
  - `review.branch`: the same repository check, optional base detection with `git symbolic-ref --short refs/remotes/origin/HEAD` and `git rev-parse --verify --quiet main/master`, explicit base validation with `git rev-parse --verify --quiet <base>`, `git diff <base>...HEAD`, and `git log --oneline <base>..HEAD`.
- Review prompt construction and diff truncation. Descriptors and invocation responses must not include the raw diff.
- Model choice. If `reviewModel` is configured and authenticated, the host may use it; otherwise the current session model is used. iOS must not see configured review model values, model catalogs, auth state, or provider policy.
- Review tool policy. Local TUI review may keep using configured `reviewTools`; remote v1 review must use a host-owned read-only tool set and must not expose tool names or extension source labels. The remote v1 reviewer tool set is limited to safe read/navigation tools such as `read`, `grep`, `find`, and `ls`. It must not include `edit`, `write`, arbitrary extension tools, or `bash` unless a future explicit unsafe-review-tools policy is added.
- Session replacement. Successful review starts a fresh session seeded only with numbered findings, matching current `/review` behavior. If session replacement is blocked, findings may be added to the current session using the existing host logic.
- Security checks and project trust. Review actions use the registered workspace cwd only, never a client-provided host path. The host rechecks project trust, current streaming/compaction state, model availability, target validity, remote allowlist, and action enabled state at invocation time.

Confirmation text should tell the user that review will inspect the selected diff, may read related project files with host-approved read-only tools, consumes model tokens, and will create a fresh session with findings. For `review.branch`, the confirmation should include the resolved base branch before the run starts when available.

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
| Fast thinking toggle | `set_thinking_level` in local RPC | `thinking.fast_mode` |
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
6. Host response returns `accepted`, `queued`, `completed`, `handled`, or `cancelled`, or a normal RPC error.
7. `completed`, `handled`, `cancelled`, and errors clear pending state immediately.
8. `accepted` waits for normal agent events through `agent_end`; `queued` clears tap pending state but leaves queue/streaming UI driven by `queue_update` and later agent events.

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

## Resolved 2026-06-23: Core RPC UI Action Protocol Foundation

B.1 implementation adds the v1 native UI action protocol shape to the local RPC contract without widening Iroh remote access.

Concrete behavior:

- `RpcCommand` includes `get_ui_capabilities`, `get_ui_actions`, and `invoke_ui_action`.
- `RpcResponse` includes success shapes for UI action capabilities, action lists, and invocation responses.
- Exported protocol types include `UiActionDescriptor`, presentation hints, argument/state descriptors, capabilities, action-list responses, and invocation responses.
- `RpcClientBase` exposes typed `getUiCapabilities()`, `getUiActions(scope?)`, and `invokeUiAction(action, options?)` helpers.
- Local `runRpcMode` returns protocol v1 capabilities with only `ui_actions.v1` advertised, returns an empty `actions` array for `get_ui_actions`, and rejects `invoke_ui_action` with a normal RPC error until handlers exist.
- `docs/rpc.md` documents the non-remote commands, descriptor shape, invocation response statuses, and security notes.
- At the B.1 foundation step, Iroh remote RPC remained allowlist-based and did not yet forward UI action commands; B.3 and B.5 own remote allowlist changes.

## Resolved 2026-06-23: Dynamic Host Action Discovery

B.2 implementation projects existing dynamic command sources into sanitized local RPC UI action descriptors.

Concrete behavior:

- `get_ui_actions` returns palette descriptors for extension commands, prompt templates, and skills for the default, `palette`, and `all` scopes. `primary` remains empty until host-curated built-in action cards exist.
- Projected extension command ids use session-local opaque ids under `extension.command.*`; prompt templates use `prompt.template.*`; skills use `skill.*`.
- Duplicate extension command invocation names are preserved in descriptor labels and slash aliases, matching the existing `getRegisteredCommands()` resolution.
- Descriptors include bounded labels, descriptions, hints, safe source scope/origin fields, and generic source labels such as `Project`, `User`, `Temporary`, or `Package`.
- Descriptors omit raw `sourceInfo`, extension source paths, prompt template file paths and bodies, skill file paths, skill base directories, and package install paths.
- Display text projection redacts path-like strings before bounding so accidental path mentions in descriptions or hints do not leak through the action list.
- Dynamic descriptors are marked `remoteSafe: true` as an action-level classification, but Iroh remote access remains blocked until B.3 adds the explicit allowlist and outbound descriptor policy.
- `invoke_ui_action` remains unavailable until B.4 implements prompt-like action invocation and stale-id checks.

## Resolved 2026-06-23: Iroh Safe Action Discovery

B.3 implementation allows read-only native action discovery over Iroh without widening unrelated remote RPC access.

Concrete behavior:

- The Iroh remote RPC command allowlist now forwards `get_ui_capabilities` and `get_ui_actions`.
- `invoke_ui_action` remains blocked over Iroh until B.5 adds invocation-time reauthorization and action-level remote-safety checks.
- Raw legacy/local RPC commands remain blocked over Iroh, including `get_messages`, `get_commands`, path-based `switch_session`, unrestricted model listing/selection, local tool RPC such as `bash`, and host file export RPC.
- Remote action descriptor responses pass through the existing Iroh outbound sanitizer after descriptor-level sanitization. Workspace paths in descriptor-like string or path fields normalize to the remote workspace path, while dedicated redaction/omission rules still apply to known sensitive path fields.
- `docs/rpc.md` and `docs/iroh-remote-protocol.md` document the remote discovery surface and the continued invocation/legacy-command boundary.

## Resolved 2026-06-23: Prompt-Like Local Action Invocation

B.4 implementation adds local `invoke_ui_action` support for the dynamic actions discovered in B.2 while keeping Iroh remote invocation disabled until B.5.

Concrete behavior:

- Local RPC capabilities now advertise `ui_action_invocation.v1`; Iroh remote RPC passes `allowUiActionInvocation: false`, so remote capabilities continue to advertise discovery only.
- `invoke_ui_action` resolves the current dynamic action catalog and invokes extension command, prompt template, and skill actions by descriptor id.
- Invocation supports one optional raw string argument named `arguments`. Unknown argument names or non-string `arguments` values are rejected with normal RPC errors.
- Extension command actions invoke their slash alias through `AgentSession.prompt()` and return `handled` after prompt preflight succeeds, so synchronous command handlers do not require `agent_end`.
- Prompt template and skill actions invoke through the same host prompt path used by raw slash compatibility. Idle invocations return `accepted`; streaming invocations require `streamingBehavior: "steer"` or `"followUp"` and return `queued` with `queuedAs`.
- Dynamic ids now include an opaque per-session catalog token. The token changes when the current extension/prompt/skill catalog changes or when a new session object owns the catalog, so stale ids reject instead of silently invoking a different action at the same index.

## Resolved 2026-06-23: Iroh Prompt-Like Action Invocation

B.5 implementation exposes the B.4 prompt-like action invocation path over Iroh for the currently reviewed remote-safe dynamic action classes only.

Concrete behavior:

- The Iroh remote command filter accepts `invoke_ui_action` only for projected dynamic ids under `extension.command.*`, `prompt.template.*`, and `skill.*`. Local-only built-in ids, deferred review/model ids, malformed ids, and unreviewed prefixes receive a normal RPC error before reaching the local Volt RPC process.
- Integrated Iroh RPC runs with `allowUiActionInvocation: true` and a remote-safe action policy. Remote descriptor lists are filtered to `remoteSafe: true`, and invocation rechecks the live descriptor's `remoteSafe` flag before dispatch.
- Spawned-child Iroh hosts no longer strip `ui_action_invocation.v1` from `get_ui_capabilities`; their outbound `get_ui_actions` responses are filtered to `remoteSafe: true` before path sanitization.
- Remote invocation still uses the host `AgentSession.prompt()` expansion path from B.4, so extension commands return terminal `handled`, prompt templates and skills return `accepted` while idle, and queued prompt-like actions return `queued`.
- Iroh close/defer tracking treats terminal `invoke_ui_action` statuses such as `handled`, `completed`, and `cancelled` as complete after the response write, while `accepted` and `queued` continue to wait for the normal prompt lifecycle where the transport path requires that wait.

## Resolved 2026-06-23: iOS RPC Action Models

C.1 implementation adds the typed iOS client protocol surface needed before session loading and UI work.

Concrete behavior:

- `VoltRPCCommand` now encodes `get_ui_capabilities`, `get_ui_actions` with optional `scope`, and `invoke_ui_action` with action id, optional argument object, and optional queue behavior.
- `VoltClient` exposes Swift models for capabilities, action list responses, descriptors, presentation hints, argument metadata, option metadata, action state, streaming behavior, slash aliases, and invocation responses.
- Descriptor parsing keeps required v1 fields strict, passes unknown source/category/presentation/argument/state/streaming string values through for forward compatibility, ignores unknown fields, and skips invalid descriptors, argument entries, or option entries without failing the whole action list.
- Tests cover command JSONL encoding and descriptor parsing with unknown fields, invalid entries, presentation/source metadata, enabled and disabled reason state, argument metadata, state snapshots, streaming behavior, and slash aliases.

## Resolved 2026-06-23: iOS Session Action Discovery

C.2 implementation loads host native action descriptors into `VoltSession` as optional capability-driven state.

Concrete behavior:

- `VoltSession` now stores `uiActionCapabilities`, `uiActions`, `isLoadingUIActions`, `uiActionLoadError`, and `uiActionsUnsupported`.
- Connect and reconnect request state, transcript, and UI action capabilities without changing transcript loading semantics. When `ui_actions.v1` is advertised, the session requests `get_ui_actions` with `scope: "all"` and stores parsed descriptors.
- New conversation, session switch, changed `sessionId` in `get_state`, `ui_actions_changed`, and `ui_action_state_changed` clear stale descriptors and refresh the action list.
- Capability/list failures do not fail the connection. Unsupported capability responses are treated as a non-fatal fallback; malformed or failed action-list responses are stored in action error state instead of transcript noise.
- The demo mock transport advertises the v1 action protocol and returns a safe mock palette action so local demo sessions exercise the discovery path.
- Lifecycle tests cover initial connect/reconnect request ordering, successful capability/list loading, invalid descriptor skipping, unsupported-command fallback, session-change refresh, action-change refresh, and unchanged transcript loading behavior.

## Resolved 2026-06-23: iOS Command Palette

C.3 implementation exposes discovered descriptors through a native SwiftUI command palette while leaving response lifecycle handling to C.4.

Concrete behavior:

- The chat composer plus button opens a native command palette sheet backed by `VoltSession.uiActions`.
- The palette is searchable and groups visible actions by category and source. Rows show action label, host description, source/category/slash badges, and source-specific icon/accent treatment so extension, prompt, skill, package, and built-in actions are visually distinct.
- Loading, unsupported-host, action-list error, empty-list, and no-search-match states render native empty/loading views without affecting the transcript.
- Rows are disabled when disconnected, host-disabled, or requiring argument fields the palette does not support. Host-provided `disabledReason` text is shown for host-disabled actions and disabled rows do not invoke.
- Actions with no arguments, or with only optional arguments outside the single-string case, invoke directly without sending args. Actions whose only argument is a string prompt for text in a second native sheet and send the descriptor argument name as a string value.
- `VoltSession.invokeUIAction` checks connected/enabled state before sending `invoke_ui_action`, omits empty argument objects, and appends a system message only if transport send fails. C.4 remains responsible for handling invocation responses and streaming-state transitions.
- Tests cover session invocation encoding/disabled-action refusal and source-level UI affordances for the command palette, argument sheet, search, grouping/source display, disabled reasons, invocation modes, and invocation calls.

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
   - `review.uncommitted`
   - `review.branch`
   - Local-only/deferred descriptors for `review.tools`, `review.pr`, and `review.commit`
2. Add native action descriptors for review cards.
3. Add `thinking.fast_mode` as the first model-speed action; defer full `model.fast_mode`.
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
4. Add Review branch base form; add Review PR form only after PR policy is resolved.
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
- `thinking.fast_mode` lowers/restores thinking with default persistence disabled and does not mutate model, scoped-model, profile, or global default settings.
- Review descriptors expose only `review.uncommitted` and `review.branch` remotely, require confirmation, omit raw diffs/model/tool metadata, and keep `review.pr`, `review.commit`, and `review.tools` local-only or deferred.

### Host Integration Tests

- TUI `/compact` and RPC `invoke_ui_action(context.compact)` use the same core handler.
- TUI `/review uncommitted` and RPC `invoke_ui_action(review.uncommitted)` produce equivalent session behavior.
- Iroh remote rejects local-only actions.
- Iroh remote allows only the A.5 review subset, rejects `review.pr`, `review.commit`, and `review.tools`, and keeps direct git/gh/model/tool metadata out of descriptors and responses.
- Iroh remote exposes `thinking.fast_mode` only through the action allowlist and never exposes direct model listing/selection as part of the descriptor or response.
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
- Fast mode toggle updates thinking state while leaving the displayed model unchanged.
- Review cards show confirmation, render the optional base-branch argument, and do not show local-only PR/commit/tool actions over Iroh.

### Manual iOS Smoke

1. Connect to a trusted host over Iroh.
2. Open the native Actions page.
3. Confirm primary cards load.
4. Tap Review uncommitted and verify a review run starts.
5. Tap Fast mode and verify thinking state updates while the model remains unchanged.
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
   - Resolved 2026-06-23: v1 uses session-local opaque ids for projected extension commands, prompt templates, and skills. Stable extension-owned action ids are deferred to the future `registerAction()` decision.

2. **Fast mode persistence**
   - Session-local, profile-level, or global setting.
   - Proposed first implementation: session-local or profile-level depending on existing settings model; avoid global surprises.
   - Resolved 2026-06-23: v1 `thinking.fast_mode` is session-local and non-persistent. It must not change profile/global defaults or scoped model settings.

3. **Remote model selection**
   - Current remote allowlist blocks `get_available_models` and `set_model`.
   - Need a separate remote-safe model policy review before exposing full model/provider metadata.
   - Fast mode may be safer than raw model selection because the host keeps provider policy private.
   - Resolved 2026-06-23: direct remote model listing/selection stays blocked. V1 exposes only `thinking.fast_mode`, which does not switch models or expose model catalog metadata. Full `model.fast_mode` is deferred pending separate model policy.

4. **Action result detail**
   - Keep invocation response small and rely on transcript/state events, or return richer action-specific results.
   - Proposed first implementation: small generic response plus normal events.
   - Resolved 2026-06-23: v1 uses the generic `UiActionInvocationResponse` with status, optional queue mode, and bounded state/action refresh hints. Rich action-specific result payloads are deferred.

5. **Built-in review exposure over Iroh**
   - Review can run git/gh commands and may inspect workspace data.
   - Need confirmation that this is acceptable for an authorized paired client and consistent with tool policy.
   - Resolved 2026-06-23: v1 remote review exposure is limited to `review.uncommitted` and `review.branch`, both requiring confirmation and read-only remote reviewer tools. `review.pr`, `review.commit`, and `review.tools` remain local-only or deferred pending GitHub credential/network, commit-history, and tool-provenance policy.

6. **Extension-provided card trust**
   - Project-local extension actions should only appear after project trust.
   - Need UI labeling so users can distinguish built-in and extension/package actions.

7. **Argument schema format**
   - Reuse TypeBox/JSON Schema subset or define a small custom schema.
   - Proposed first implementation: small custom schema for `string`, `boolean`, `enum`, and `integer`, with room for JSON Schema later.

8. **Action availability while streaming**
   - Some actions can execute immediately, some can queue, some must be disabled.
   - Need per-action `streamingBehavior`: `disabled`, `immediate`, `queueSteer`, `queueFollowUp`, or `custom`.
   - Resolved 2026-06-23: v1 supports `disabled`, `immediate`, `queueSteer`, and `queueFollowUp`. `custom` remains deferred; host handlers must recheck the live descriptor and reject unsupported streaming invocations.

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
