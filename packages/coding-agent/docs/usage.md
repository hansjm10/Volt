# Using Volt

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, current model, and active Fast mode

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/fast [on\|off]` | Toggle or explicitly set Fast mode for the current session |
| `/profile` | Show, switch, or create the active settings profile |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/clear` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/usage` | Show remaining subscription quota and local reset times |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/review [target] [options]` | Snapshot and independently verify uncommitted, branch, PR, or commit changes |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/remote` | Manage daemon status, pairing, devices, workspaces, leases, and headless policy |
| `/changelog` | Display version history |
| `/quit` | Quit volt |

`/usage` fetches quota status on demand for stored Anthropic Claude and OpenAI ChatGPT/Codex subscription logins. API keys are not queried. The active eligible provider is shown first, provider failures are reported independently, and results are cached briefly without background polling. Headless and paired Iroh clients can request the same normalized data with `get_subscription_usage`; remote access requires `host.manage.v1` and excludes credentials, account identity, and raw provider payloads.

Fast mode requests premium low-latency inference capacity on supported OpenAI and OpenAI Codex models. Enabling it may cost more. It is session-scoped and independent of the thinking level; the footer shows `fast` while it is active. Review workflows inherit the current Fast setting for review inference and carry it into the fresh findings session.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want volt to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.volt/agent/sessions/`, organized by working directory.

```bash
volt -c                  # Continue most recent session
volt -r                  # Browse and select a session
volt --no-session        # Ephemeral mode; do not save
volt --name "my task"    # Set session display name at startup
volt --session <path|id> # Use a specific session file or session ID
volt --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Code Review

`/review` captures the selected change as an exact Git snapshot, then runs candidate discovery and independent verification in separate isolated contexts. Host-owned paged tools read only that snapshot. For PR runs with newly accepted findings, a third context-blind pass uses the verifier model to render code-derived finding prose from host-validated anchors; it receives immutable repository tools but no GitHub context or private discovery/verifier prose. Zero-new-finding and prior-only incremental runs skip that pass. Optional auxiliary tools selected with `/review tools` run in a disposable checkout for analysis only; mutable workspace `read`/`grep`/`find`/`ls`/edit tools are never used by a review. When `/review` opens the local target selector, Volt also makes a short best-effort GitHub lookup and puts `Current PR #N — title` first when the current branch has one unambiguous pull request; lookup failures silently leave the normal selector unchanged. Explicit review targets and RPC actions never perform or inherit this selector lookup.

```
/review                                      # open a target selector
/review uncommitted                          # staged, unstaged, deleted, and nonignored untracked files
/review branch [base]                        # captured HEAD vs its merge base with base
/review pr [number]                          # fetched GitHub base/head OIDs (requires gh)
/review commit [sha]                         # commit vs first parent, or empty tree for a root commit
/review branch main --focus "authorization" # add a focused question
/review uncommitted --scope "src/**,test/**" # restrict changed paths
/review branch main --effort high --full     # low|standard|high; incremental|full
/review uncommitted --include-optional       # opt in to P3 suggestions
```

For PR targets, Volt uses the host's `gh` credentials and network to capture the authoritative closing/manual-linked issues, PR issue comments, submitted review summaries, inline review threads and replies, and linked-issue comments. It does not infer links from arbitrary text or follow relationships recursively. GitHub text is capped at 32 KiB per field, capture is capped at 20 linked issues and 200 total discussion entries, and the rendered context is capped at 256 KiB. Truncation, limits, malformed responses, and ancillary API failures are recorded as capture limitations. PR identity or fetch failures are fatal before inference, and Volt rechecks the exact head OID after context capture; if it moved, retry the review.

Both context-aware analysis passes must page the same host-captured context to completion. GitHub-authored text is untrusted evidence: it can establish intent or prior discussion, but cannot change review policy, direct tools, or support a retained finding without independently verified changed-code evidence. P0-P2 findings must have a changed-side anchor, concrete trigger and impact, and an independent verifier decision. P3 findings are disabled by default. Results are marked `incomplete` and have no correctness verdict when GitHub context capture or either analysis pass's context inspection is incomplete, or when verification or in-scope hunk coverage is incomplete. The presentation pass must inspect every accepted hunk but cannot change finding identity, anchor, severity, or status.

Review policy comes from user `REVIEW.md` in the Volt agent directory and hierarchical project `REVIEW.md`/`AGENTS.md` files read from the trusted base snapshot. Candidate changes and GitHub discussion cannot alter the active review policy.

Completed, incomplete, failed, and cancelled runs plus explicit finding outcomes are stored as bounded host-only records on the current session branch. Existing bounded PR identity includes its title and body, but newly captured linked-issue and discussion text and all free-form prose from context-aware model passes remain ephemeral. Volt declassifies only host-validated finding existence, anchors/evidence, identity, priority/status, and confidence rounded to one percent; durable finding prose comes from the context-blind pass, while summaries, incomplete copy, model-limitation counts, command-attempt counts, and persisted PR failures use host-generated text. Durable and RPC records retain only bounded capture counts/status/limitation codes and a content fingerprint for the captured context. A changed fingerprint forces a full incremental PR rerun. Opening a fix session copies the same public durable result and can select findings by ID; it does not consume the original result. Publishing uses that result, is explicit and PR-only, and is refused if the PR head moved.

Set `reviewModel` to choose the discovery model. Set `reviewVerifierModel` to choose a separate verifier; it defaults to `reviewModel`, which defaults to the active session model. Example: `"anthropic/claude-opus-4-5"`.

## Subagents (MVP)

Subagents are named child Volt sessions with isolated context. Volt includes built-in subagents for common workflows:

Volt's default model policy is local-first: the root agent normally completes work itself. It delegates when the user or project requests it, or when a bounded, self-contained task benefits enough from specialization or context isolation to justify synchronous coordination. Model-facing `subagent` calls are awaited until their child work finishes, so delegation does not let the root agent continue working concurrently.

| Name | Purpose | Tool posture |
| --- | --- | --- |
| `general` | Ad hoc delegated tasks | Broad normal tools plus registry access, but no `subagent` spawning tool |
| `researcher` | Web/codebase evidence gathering | Enforced non-mutating local tools plus `web_search` network egress and bounded `researcher` delegation; no shell or LSP mutation |
| `design-doc` | RFC/design-document planning and synthesis | Broad inherited tools plus bounded delegation to `researcher`, `security-reviewer`, and `general` |
| `security-reviewer` | Threat modeling and security/code review | Enforced non-mutating local tools plus `web_search` network egress and bounded read-only delegation to `researcher` |

Additional subagents are discovered from markdown files:

- `~/.volt/agent/agents/*.md` for user agents
- `.volt/agents/*.md` for project agents, only when the project is trusted

Built-in subagent names are reserved and file-backed definitions using those names are ignored with a diagnostic; use a distinct name for custom agents. Project agents with the same non-built-in `name` override user agents only after project trust is active. Without trust, project definitions are ignored. Tool lists are requests: effective child tools are still clamped by the parent session's active tool policy, so a child cannot gain tools the parent did not expose. The built-in research and security-review roles are non-mutating locally, but they can call `web_search`, which may send query text to the configured external search provider.

Definition format:

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

Required fields are `name`, `description`, and the markdown body. Optional `tools` is a comma-separated allowlist, `excludedTools` is a comma-separated subtraction list, `allowedSubagents` is a comma-separated child-name allowlist, `maxSubagentDepth` is the deepest nested subagent depth this agent may create (top-level user session is depth 0, and descendants inherit the strictest ancestor cap), `maxChildAgents` is this agent runtime's child-start quota, `model` is a model pattern/id, and `thinking` is a thinking level. Omit `subagent` from `tools`, set `excludedTools: subagent` when inheriting the parent tool set, or set an explicit empty `allowedSubagents:`/`maxChildAgents: 0` if that agent should not spawn child agents. Include `subagent_registry` in an explicit child `tools` allowlist when the child should directly list or follow existing runs; the enforced spawn preflight still reads the registry internally. Malformed tool/delegation policy fields reject the affected definition instead of silently dropping restrictions.

The built-in `subagent` tool is active by default when a `SubagentManager` has an available definition, including normal CLI sessions. Root sessions retain its list and follow modes for compatibility. In definition-backed child runtimes, `subagent` exposes only single, parallel, and chain spawning modes, while the standard child-only `subagent_registry` tool exposes list and follow independently. Registry access remains available when `maxSubagentDepth`, `maxChildAgents`, or an empty `allowedSubagents` policy disables further spawning. Explicit tool allowlists and exclusions remain strict: include or exclude `subagent` and `subagent_registry` separately.

Provide exactly one spawning mode per `subagent` call:

```json
{ "agent": "scout", "task": "Find the auth entry points" }
```

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find auth entry points" },
    { "agent": "planner", "task": "Plan a minimal fix" }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Find auth entry points" },
    { "agent": "planner", "task": "Plan a fix using {previous}" }
  ]
}
```

In normal Volt sessions, every spawn request is two-phase. The first single, parallel, or chain call programmatically lists the live session-wide registry and returns a one-time confirmation token without starting any subagents. After reviewing that list, reuse or follow equivalent work when possible. If a new run is still needed, repeat the exact spawn request with only the returned `confirm` token added:

```json
{ "agent": "scout", "task": "Find the auth entry points", "confirm": "<preflight-token>" }
```

Confirmation reservations are shared across the whole session tree. If two branches request the same normalized spawn at once, only the first receives a token; the other sees that an identical request is pending or claimed and starts nothing. Tokens expire after five minutes, are valid only for the exact normalized request that produced them, and are consumed by one successful confirmation attempt. A missing, expired, reused, or mismatched token starts nothing and returns a registry preflight; when the reservation is still pending, that preflight carries a freshly rotated token (invalidating the previous one) so a garbled token never locks the request out until expiry. Differently worded prompts are not treated as exact duplicates, so the returned registry still requires judgment about semantic overlap.

Root sessions may continue using compatibility list/follow calls on `subagent`. Child runtimes use the same inputs with `subagent_registry`:

```json
{ "list": true }
```

```json
{ "list": true, "cursor": 42 }
```

```json
{ "follow": "sa_1f2e3d4c" }
```

List and follow expose the session-wide delegation registry. Every runtime in one session tree — the root session and every nested subagent — shares one registry that records each delegated run's id, agent, task prompt, status, and bounded final output. `list` returns bounded newest-first pages of up to 50 recorded runs so an agent can spot that an equivalent task already ran (or is still running) in another branch before spawning a duplicate; when more runs remain, the result provides the `cursor` for the next page, and cursors stay exact while runs change state. `follow` returns an existing run's result by id, waiting for completion when the run is still in flight. Follows that could never resolve — waiting on an ancestor, or two runs waiting on each other — are rejected with a deadlock error instead of hanging. Subagents with an active `subagent_registry` tool also start with a bounded snapshot of already-recorded runs in their system prompt context, so they can reuse prior results without being told to check first. Task prompts and outputs surfaced this way cross subagent context boundaries and are untrusted data; follow results are prefixed with an explicit untrusted-data notice.

Parallel mode is limited to 8 tasks per call with max concurrency 4. Exact duplicate agent/task pairs in one parallel request are rejected before anything starts. Results are returned in input order, and mixed success/failure runs return a combined status summary instead of hiding partial results. Chain mode is limited to 8 steps, runs them sequentially, replaces `{previous}` with bounded prior successful step output that is XML-escaped and delimited as untrusted data, returns the final successful step output when all steps complete, and stops at the first failed step with details for executed steps. Recursive delegation is opt-in through `allowedSubagents`; omission allows no child names. Every delegation tree shares default root-scope structural spawn safeguards of depth 5, 100 total starts, and 16 concurrently active descendants. A structural rejection starts nothing new and does not abort admitted descendants. Each child receives its own wrap-up warning after 80 assistant turns. At that child's turn 120, Volt blocks further tools and asks it for its best final report; trying another tool aborts only that child, without consuming or ending a parallel sibling's turn budget. Token, cost, and wall-clock budgets remain unlimited unless an SDK or host supplies finite tree-wide `SubagentManagerOptions.delegationLimits`. Explicit definition policy and user/parent cancellation remain authoritative. In-memory parents create in-memory child sessions, while persisted parents create linked persisted children. Model-visible output is capped at 50 KB per task or chain step and 100 KB for a combined parallel result or registry list page; metadata includes IDs, source, status, usage, truncation/errors, pagination, and tree-wide accounting.

## Context Files

Volt loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.volt/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.volt/SYSTEM.md` for a project
- `~/.volt/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, volt asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.volt/agent/trust.json`. Trusting a project allows volt to load `.volt/settings.json` and `.volt` resources, install missing project packages, and execute project extensions.

Before the trust decision, volt loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.volt/agent/settings.json`, or change it with `/settings`.

`volt config` and package commands use the same project trust flow, except `volt update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.volt/agent/trust.json` only; the current session is not reloaded, so restart volt for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link. Set `VOLT_SHARE_VIEWER_URL` if you want those links to point at a custom session viewer; otherwise Volt returns the private gist URL.

## CLI Reference

```bash
volt [options] [@files...] [messages...]
```

### Package Commands

```bash
volt install <source> [-l]     # Install package, -l for project-local
volt remove <source> [-l]      # Remove package
volt uninstall <source> [-l]   # Alias for remove
volt update [source|self|volt]   # Update volt and packages; reconcile pinned git refs
volt update --extensions       # Update packages only; reconcile pinned git refs
volt update --self             # Update volt only
volt update --extension <src>  # Update one package
volt list                      # List installed packages
volt config                    # Enable/disable package resources
```

These commands manage volt packages, not the volt CLI installation. To uninstall volt itself, see [Quickstart](quickstart.md#uninstall). `volt config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `volt update` never prompts for project trust.

See [Volt Packages](packages.md) for package sources and security notes.

### Remote Access over Iroh (Preview)

Remote access is served by the background daemon (`voltd`); see [Background daemon](daemon.md). The daemon owns the stable Iroh endpoint identity, pairing, workspace registration, push dispatch, and the conversation runtimes phones attach to. The feature is opt-in and host-controlled: provider credentials, workspace files, tool execution, sessions, state, and audit logs remain on the host machine. Open `/remote` in an interactive TUI to inspect or start the daemon, register Volt's current directory, see the current lease and attached phones, generate a pairing QR or revoke devices, and review registered workspaces and the effective headless policy. The control center uses a management-only daemon connection and never acquires or releases the active conversation lease. You can also start the daemon with `volt daemon start`, or set `remote.background: true` so interactive Volt starts it automatically. Every supported interactive Volt process joins a running daemon and exposes its current conversation, including processes that were already open when another process started the daemon.

Phone setup uses a Pair Phone flow: choose **Pair a phone** in `/remote`, or run `volt remote pair` from the shell. The TUI renders the one-time QR when it fits and offers the ticket as a copy action in constrained terminals. That QR/ticket is a short-lived, one-time invitation. After the first successful pairing, the daemon records the phone's authoritative Iroh node ID in its state file and the app saves a secret-free saved-host record. Later reconnects use that saved host and do not need another QR scan; the daemon's persistent identity means pairings also survive daemon restarts.

Workspace access is workstation-scoped in this preview. Register local desktop directories by name with `volt remote workspace add`, choose **Register current directory** in `/remote`, or let a TUI connected to the daemon auto-register its working directory; then pair the phone once. The app can later select only those registered workspace names; it cannot request host paths. Registering another workspace with the same daemon makes that name available to already paired clients without another QR scan. The client's persisted tool grant applies across every registered workspace, and revocation blocks that phone from every workspace.

Integrated hosts advertise both `multi_streams.v1` and `conversation_streams.v1`. Mobile clients open a conversation-targeted stream by putting one stream mode in the Iroh hello:

- `conversation: { "target": "last" }` resumes the recorded session for that workspace or creates one if the record is missing.
- `conversation: { "target": "new" }` creates a fresh conversation.
- `conversation: { "target": "session", "sessionId": "..." }` resumes an existing session by ID.
- `workspaceDiscovery: { "purpose": "list_sessions" }` opens a short-lived session-list stream without creating or updating a conversation runtime.
- `workspaceManagement: { "purpose": "unregister_workspace" }` opens a short-lived management stream for `unregister_workspace`.

The iOS app renders conversation streams as pinned agent tabs keyed by workspace and session. Multiple sessions in the same registered workspace can run concurrently. Hosts advertising `session_runtime_state.v1` mark live session ownership in discovery, allowing the app to keep currently running desktop agents connected alongside the selected agent. Dormant hidden pins still detach and recover through `get_state`, `get_transcript`, and later live events when selected again.

Commands and state are stream-scoped: prompts, `abort`, `get_state`, `get_transcript`, native actions, host actions, notifications, and `/workspace` path mapping affect only the bound conversation. Command-level `workspace`, `workspaceName`, or `sessionId` fields are assertions only; mismatches fail with `session_mismatch`. Mobile conversation streams reject direct `new_session`, `switch_session_by_id`, and raw `get_messages` with `unsupported_remote_command`. Discovery streams permit only `list_sessions`; management streams permit only `unregister_workspace`.

Closing a stream, switching pinned tabs, app backgrounding, or network loss is detach only. It does not cancel active work or close unrelated conversations. Stop/cancel controls send the selected conversation stream's `abort` RPC command. Reconnect and tab reselect recover the remote-safe transcript with bounded `get_transcript` pages and sanitized `transcript_entry` events.

Happy path:

```bash
# Start the daemon and register one or more named workspaces.
volt daemon start
volt remote workspace add . --name volt
volt remote workspace add <workspace-dir> --name app

# Ask the daemon for a short-lived one-time pairing ticket.
volt remote pair --workspace volt

# From a source checkout demo client, connect with the printed ticket.
npm run iroh:poc:client -- "<ticket>" --get-state
npm run iroh:poc:client -- "<ticket>" --message "List the top-level files."

# Later: register another local workspace for the same paired phone.
volt remote workspace add <workspace-dir> --name other
```

Use `/remote` for the common interactive management flow. Selecting a paired device asks for confirmation before revoking it; revoked identities remain visible and require a separate confirmed **Allow re-pair** action before that phone can use a fresh QR. Escape returns without changing access. Leaving an active TUI pairing screen cancels, invalidates, and durably removes that invitation. If `/remote` asks you to restart `voltd`, the already-running daemon predates safe TUI cancellation, so pairing stays disabled until restart. Equivalent shell commands are:

```bash
volt daemon status                        # daemon health, workspaces, clients, leases
volt daemon logs -f                       # follow the daemon log
volt remote status                        # same status view as volt daemon status
volt remote clients                       # paired client JSON without secrets
volt remote revoke <node-id>              # revoke one client; closes its active streams
volt remote approve-repair <node-id>      # allow a revoked phone identity to re-pair
volt remote workspace add . --name volt   # register current directory
volt remote workspace remove other        # unregister only after all child worktrees are removed
volt remote workspace list
volt remote pair --workspace volt
```

Options to know:

- Daemon behavior is settings-driven (see [Settings](settings.md)): `remote.background` automatically starts the daemon from interactive Volt, `remote.detachedRuntimeTtlMs` controls how long idle detached runtimes are retained (default 30 minutes), and `remote.allowTools` restricts tools for daemon-owned headless runtimes. Supported TUIs connect whenever a daemon is running even when auto-start is off.
- Pair: `--workspace <name>` selects the initial workspace for the ticket.
- Daemon file layout, lease model, and troubleshooting live in [Background daemon](daemon.md).

Security and support boundary:

- The default remote tool grant enables the built-in tools `read,bash,edit,write,image_gen,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp` plus active tools registered by loaded extensions. The `coding` and `full` remote RPC presets use this canonical default, so `image_gen` is enabled automatically when an OpenAI Codex model is selected. A custom `remote.allowTools` list restricts daemon-owned headless runtimes only; name extension tools explicitly when using one. When a desktop TUI owns the conversation lease, phone prompts run with the TUI session's full local tool set (see [Security](security.md)). The `subagent` tool can only run built-in or discovered named definitions, and child tools are clamped by the remote session's active tool grant.
- Granting `bash`, `edit`, or `write` can modify host files or run shell commands. Granting the Codex-only `image_gen` tool lets the session read and upload local reference images and write generated PNG files. Extension tools run code installed on the host and may do the same. Pairing a phone grants it desktop-equivalent power over the workspaces it can reach; pair only devices you control.
- `volt remote workspace add` is a local desktop action. It stores a workspace name and realpath in the daemon's state file, without starting a remote API for clients to create, rename, browse, or path-map workspaces. Removing a workspace unregisters the saved name from daemon state only; it does not delete files. If any daemon-managed worktree record remains, unregister fails with `workspace_has_worktrees`; run `volt remote worktree list --workspace <name>` and explicitly remove each worktree first. Only per-worktree `remove --force` is allowed to discard dirty or busy work.
- When interactive Volt connects to the daemon, it auto-registers its working directory when it is not inside a registered workspace (named by basename, with a numeric suffix on collision).
- If the daemon has multiple registered workspaces, `volt remote pair --workspace <name>` chooses the initial workspace for the ticket. It does not restrict that paired phone to only that workspace.
- Pairing tickets are short-lived and one-time. The daemon never creates a pairing invite at startup; use `volt remote pair` to create the QR/ticket when adding or explicitly re-pairing a phone. The QR is not used for ordinary reconnects, workspace registration changes, New Agent, Resume Agent, or pinned-tab changes. `volt remote pair` talks to the running daemon; offline pairing from persisted state is not supported.
- Saved-host reconnects omit the pairing secret and verify the host node ID. App restart, foreground reconnect after network loss, and daemon restart all use the saved-host path instead of asking for another QR (the daemon keeps a stable Iroh identity in its state file).
- A paired phone is authorized for the workstation represented by the daemon's state file. It can reconnect to any registered workspace name, including names registered later, without scanning another QR.
- On integrated hosts that advertise `multi_streams.v1` and `conversation_streams.v1`, that paired phone can open multiple conversation streams, including different sessions in the same workspace. The host rejects the same client opening the same workspace/session twice on one live Iroh connection with `duplicate_conversation_connection` and retry metadata. The first conversation stream on a new same-client connection can replace a stale active stream for the same workspace/session and reattach to the retained runtime. Distinct paired devices co-attach to one shared conversation runtime when their grants are compatible. If the existing daemon runtime permits tools outside the attaching phone's persisted grant, the host rejects that attach with `conversation_in_use` rather than letting the narrower phone drive a broader runtime.
- Hosts that do not advertise `conversation_streams.v1` are incompatible with the mobile pinned-agent model. The app keeps the saved host and shows an update/integrated-host-required state rather than falling back to mobile mutation commands.
- Registering a workspace does not add built-in tools to a client. For daemon-owned runtimes, the persisted client `allowedTools` grant is intersected with any workspace and `remote.allowTools` ceilings; an explicit empty daemon ceiling denies all tools. The client grant applies across all registered workspaces until the client is revoked and paired again with a different grant. Active extension tools are exposed only when every active policy layer retains default-grant semantics.
- Revoked clients cannot reconnect or silently re-pair. Live hosts close active streams and runtimes for that phone across all workspaces. To trust the same phone identity again, select it under **Revoked devices** in `/remote` and confirm **Allow re-pair**, or run `volt remote approve-repair <node-id>` on the desktop host; then create a fresh pairing ticket.
- Reconnect clients should distinguish `host_unreachable`, `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, `client_revoked`, `workspace_unavailable`, `workspace_missing`, `workspace_unregistered`, `workspace_has_worktrees`, `workspace_authorization_removed`, `session_unavailable`, `duplicate_conversation_connection`, `conversation_in_use`, and `conversation_streams_unsupported`. Ordinary offline hosts are retry states that keep the saved host; invalid, mismatched, unknown, or revoked relationships require Pair Again or Forget Host decisions. `workspace_unavailable` is transient and carries a `retryAfterMs` pacing hint; `workspace_missing` means the registered path no longer exists, so clients keep the saved host but stop automatic redialing. `workspace_has_worktrees` is an actionable management conflict: keep the host and workspace, show the worktrees, and require explicit per-worktree removal.
- Remote clients select saved workspace names only. They cannot request arbitrary host paths. If a selected name is not registered, its saved path is deleted, or its saved path is transiently unreadable, reconnect fails with `workspace_unregistered`, `workspace_missing`, or `workspace_unavailable` respectively while keeping the saved host. A reviewed remote unregister request can remove an empty known workspace name from host state without deleting files; registered, dirty, unmerged, busy, and unknown/orphan worktree checkouts are never implicit unregister cleanup. Creating, renaming, browsing, or path-mapping host workspaces stays local to the desktop host.
- Remote sessions do not bypass project trust. A saved trust decision for the workspace is honored; otherwise the host runs project resources untrusted unless the host user chooses `trust` in the prompt or passes `--approve`.
- In the default integrated runtime, app backgrounding, network loss, or stream close detaches the client and does not send `abort`. Active work continues on the host; the same paired client/workspace/session can reconnect and refresh with `get_state` and `get_transcript`. On foreground recovery, a pinned-agent client may reopen the selected saved agent plus sessions reported as currently desktop-owned by a `session_runtime_state.v1` host; dormant hidden pins remain detached until selected and then catch up from state/transcript.
- Remote stop/cancel controls must send the `abort` RPC command. Closing the stream without `abort` is disconnect only.
- Idle detached runtimes are retained for 30 minutes by default; change this with the `remote.detachedRuntimeTtlMs` setting. Daemon exit, crash, or explicit shutdown is not durable recovery for active work.
- State and audit JSONL are stored under `~/.volt/agent/daemon/` (`state.json`, `audit.jsonl`); see [Background daemon](daemon.md).
- Remote push notifications use the managed Volt push relay by default. The mobile app registers its FCM token with the relay and sends the host target-scoped relay credentials over Iroh; the host does not store raw FCM tokens. Use `VOLT_PUSH_RELAY_URL` only for a custom relay, and `VOLT_PUSH_RELAY_AUTH_TOKEN` only when that custom relay requires shared bearer auth.
- The daemon defaults to Iroh relay mode `production`, using the Volt-operated relay fleet so saved-host reconnects survive restarts and network changes. Set `VOLT_IROH_RELAY_MODE` to `disabled` for LAN-only connections, `development` for the public n0 development relays, or `production`; set `VOLT_IROH_RELAY_URLS` to use custom production relay origins.
- `volt remote pair` creates pairing tickets with the daemon's live relay mode; it cannot change a running daemon's relay mode.
- The daemon requires a Node.js npm install or source checkout with optional `@hansjm10/volt-iroh` available for the platform. The pinned adapter supports macOS arm64, Linux x64/arm64 (glibc and musl), and Windows x64/arm64; it does not ship a Darwin x64 binding, so Intel macOS npm installs are local CLI/TUI only. Standalone Node SEA builds reject `volt daemon` because the native Iroh adapter is intentionally not bundled.
- Known preview limitations: daemon exit is not durable active-work recovery, idle detached runtime retention is time-limited, very large hidden-agent sets may need future host/app resource controls, per-workspace client grants are deferred, remote workspace creation/rename/path browsing stays local to the desktop host, and production relay/discovery should be validated in the target cross-network environment.

See [Iroh remote protocol v1](iroh-remote-protocol.md), [Iroh remote access design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/iroh-remote-access-design.md), and [Security](security.md#remote-access-over-iroh-preview).

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, volt also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | volt -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools include `read`, `bash`, `edit`, `write`, `image_gen` (when an OpenAI Codex model is selected), `web_search`, `web_fetch`, `grep`, `find`, `ls`, `inspect`, `lsp` (when enabled), `subagent` (when spawning is available), child-only `subagent_registry`, and `mcp` (when MCP servers are configured). The `image_gen` tool can read and upload local reference images and write generated PNG files. The `subagent` tool only runs built-in or discovered named definitions from the ResourceLoader; `subagent_registry` lists or follows runs in a child runtime's shared session registry; the `mcp` tool is a single gateway for configured MCP servers.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
volt --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | Interactive TUI mode: `regular` (default) or `fullscreen` |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

In `regular` mode, Volt renders in the main terminal buffer and leaves scrolling to native terminal scrollback. In `fullscreen` mode, the transcript scrolls inside the terminal viewport while queued messages, working status, extension widgets, Plan status, editor, and footer remain fixed at the bottom. Mouse and trackpad input scroll the region under the pointer; keyboard viewport actions target the transcript.

Inline images work in fullscreen terminals that support Kitty, including Kitty and Ghostty, and in Windows Terminal 1.22+ through negotiated Sixel. Volt enables Sixel only when Windows Terminal reports support, converts supported non-PNG tool images before rendering, and re-encodes visible image regions while scrolling. Because Sixel cannot delete individual placements, image changes and movement repaint the full viewport; text-only updates remain differential. Sixel is disabled under tmux and GNU screen. In iTerm2, fullscreen images render as text placeholders because its protocol cannot delete or crop placements during application-owned scrolling; regular mode continues to render them normally. See [Terminal setup](terminal-setup.md) for terminal-specific behavior.

Set **TUI mode** in `/settings` to switch immediately and choose the default for future sessions. `--tui-mode` overrides that setting only for the current run. **Fullscreen scrollbar** controls transcript scrollbar visibility. **Fullscreen exit output** controls shutdown while fullscreen: `transcript` prints the final transcript before Volt's normal resume hint, while `resume-hint` restores the previous main-buffer screen without printing the transcript and leaves only the normal resume hint when one is available.

### File Arguments

Prefix files with `@` to include them in the message:

```bash
volt @prompt.md "Answer this"
volt -p @screenshot.png "What's in this image?"
volt @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
volt "List all .ts files in src/"

# Non-interactive
volt -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | volt -p "Summarize this text"

# Named one-shot session
volt --name "release audit" -p "Audit this repository"

# Different model
volt --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
volt --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
volt --model sonnet:high "Solve this complex problem"

# Limit model cycling
volt --models "claude-*,gpt-4o"

# Read-only mode
volt --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
volt --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VOLT_CODING_AGENT_DIR` | Override config directory; default is `~/.volt/agent` |
| `VOLT_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `VOLT_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `VOLT_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `VOLT_SKIP_VERSION_CHECK` | Skip the Volt version update check at startup |
| `VOLT_LATEST_VERSION_URL` | Enable hosted version checks against this JSON endpoint |
| `VOLT_REPORT_INSTALL_URL` | Enable hosted install/update telemetry against this endpoint |
| `VOLT_SHARE_VIEWER_URL` | Base URL for `/share` command viewer links |
| `VOLT_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `VOLT_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VOLT_TUI_ESC_TIMEOUT` | Milliseconds to wait for bytes following a lone Escape key; defaults to 10 locally and 100 over SSH |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

Volt keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

Native MCP support is intentionally explicit: configured servers are exposed through a single `mcp` gateway tool and project MCP config follows project trust. HTTP/SSE MCP servers that require OAuth can be authenticated with `volt mcp auth <server>` or `volt mcp auth-device <server>`; tokens stay on the host. Volt still avoids permission popups, plan mode, built-in to-dos, background bash, or advanced subagent orchestration. The core subagent MVP is limited to built-in/discovered named agents, the single/parallel/chain `subagent` spawning tool, and child registry list/follow access; richer workflows can be built as extensions or external tools.

For the full rationale, see the project documentation and extension examples.
