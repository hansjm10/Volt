# Using Volt

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

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
| `/profile` | Show, switch, or create the active settings profile |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/clear` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/review [target]` | Review uncommitted changes, a branch, a PR, or a commit; findings seed a fresh session |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit volt |

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

`/review` runs a code review in an isolated in-process session with its own context window and a dedicated reviewer prompt. The reviewer has full tool access, so it reads the code around each hunk and can run tests to verify suspected bugs.

```
/review                # open a target selector
/review uncommitted    # review uncommitted changes (vs HEAD, plus untracked files)
/review branch [base]  # review branch changes vs base (auto-detects main/master)
/review pr [number]    # review a GitHub PR (requires gh; defaults to the current branch's PR)
/review commit [sha]   # review a single commit (omit the sha to pick from recent commits)
```

When the review finishes, volt starts a **fresh session seeded only with the numbered findings**. Your next message runs with clean context, so you can say "fix 1 and 3" and the agent fixes those findings without the review transcript or your previous conversation consuming the context window.

Set the `reviewModel` setting (e.g. `"anthropic/claude-opus-4-5"`) to review with a different model than the active session; otherwise the current model is used.

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

`volt remote host` exposes a local Volt runtime over Iroh. The feature is opt-in and host-controlled: provider credentials, workspace files, tool execution, sessions, state, and audit logs remain on the host machine.

Phone setup uses a Pair Phone flow. For mobile-facing setup, start the host with `volt remote host --mobile`, then run `volt remote pair` only when adding a phone. That QR/ticket is a short-lived, one-time invitation. After the first successful pairing, the host records the phone's authoritative Iroh node ID in the host state file and the app saves a secret-free saved-host record. Later reconnects use that saved host and do not need another QR scan as long as the host restarts with the same state path and host identity.

Workspace access is workstation-scoped in this preview. Register local desktop directories by name in the host state file, then pair the phone once. The app can later select only those registered workspace names; it cannot request host paths. Registering another workspace under the same state file makes that name available to already paired clients without another QR scan. The client's persisted tool grant applies across every registered workspace, and revocation blocks that phone from every workspace.

Integrated hosts advertise both `multi_streams.v1` and `conversation_streams.v1`. Mobile clients open a conversation-targeted stream by putting one stream mode in the Iroh hello:

- `conversation: { "target": "last" }` resumes the recorded session for that workspace or creates one if the record is missing.
- `conversation: { "target": "new" }` creates a fresh conversation.
- `conversation: { "target": "session", "sessionId": "..." }` resumes an existing session by ID.
- `workspaceDiscovery: { "purpose": "list_sessions" }` opens a short-lived session-list stream without creating or updating a conversation runtime.
- `workspaceManagement: { "purpose": "unregister_workspace" }` opens a short-lived management stream for `unregister_workspace`.

The iOS app renders conversation streams as pinned agent tabs keyed by workspace and session. Multiple sessions in the same registered workspace can run concurrently. The app keeps at most one selected live conversation stream during normal use; hidden pins detach and recover through `get_state`, `get_transcript`, and later live events when selected again.

Commands and state are stream-scoped: prompts, `abort`, `get_state`, `get_transcript`, native actions, host actions, notifications, Live Activity registration, and `/workspace` path mapping affect only the bound conversation. Command-level `workspace`, `workspaceName`, or `sessionId` fields are assertions only; mismatches fail with `session_mismatch`. Mobile conversation streams reject direct `new_session`, `switch_session_by_id`, and raw `get_messages` with `unsupported_remote_command`. Discovery streams permit only `list_sessions`; management streams permit only `unregister_workspace`.

Closing a stream, switching pinned tabs, app backgrounding, or network loss is detach only. It does not cancel active work or close unrelated conversations. Stop/cancel controls send the selected conversation stream's `abort` RPC command. Reconnect and tab reselect recover the remote-safe transcript with bounded `get_transcript` pages and sanitized `transcript_entry` events.

Happy path:

```bash
# Terminal 1: register one or more named workspaces, then start the mobile-facing host.
volt remote host --register-workspace volt=. --allow-tools read,grep,find,ls
volt remote host --register-workspace app=<workspace-dir>
cd <workspace-dir>
volt remote host --mobile --yes

# Terminal 2: ask the running host for a short-lived one-time pairing ticket.
volt remote pair --workspace volt

# From a source checkout demo client, connect with the printed ticket.
npm run iroh:poc:client -- "<ticket>" --get-state
npm run iroh:poc:client -- "<ticket>" --message "List the top-level files."

# Later: register another local workspace for the same paired phone.
volt remote host --register-workspace other=<workspace-dir>
```

Common management commands:

```bash
volt remote status                         # persisted state, workspaces, clients, tools, state/audit paths
volt remote clients                        # paired client JSON without secrets
volt remote revoke <node-id>               # revoke future access; live hosts also close active streams/connections
volt remote approve-repair <node-id>       # allow a revoked phone identity to re-pair with a fresh ticket
volt remote host --register-workspace .    # register current directory by basename
volt remote host --register-workspace other=<workspace-dir>
volt remote host --unregister-workspace other
volt remote pair --workspace volt --label "Jordan iPhone"
volt remote host --workspace volt=<workspace-dir> --no-pairing

# Mobile-facing startup does not create a pairing invite; pair explicitly.
volt remote host --mobile --workspace volt=<workspace-dir> --yes
volt remote pair --workspace volt --label "Jordan iPhone"
```

Options to know:

- Host: `--workspace <name=path>`, `--register-workspace [path|name=path]`, `--unregister-workspace <name>`, `--mobile`, `--relay <disabled|default>`, `--state <path>`, `--audit <path>`, `--allow-tools <list>`, `--profile <name>`, `--agent-dir <path>`, `--push-relay-url <url>`, `--push-relay-auth-token <token>`, `--detached-runtime-ttl-ms <ms>`, `--approve`, `--no-pairing`, `--once`, `--yes`.
- Pair: `--workspace <name>`, `--allow-tools <list>`, `--label <label>`, `--ttl <duration>`, `--state <path>`, `--relay <disabled|default>`, `--yes`.
- Management: `--state <path>` and `--audit <path>` for `status`, `clients`, `revoke`, and `approve-repair`.

Security and support boundary:

- The default remote tool grant enables the built-in tools `read,bash,edit,write,grep,find,ls` plus active tools registered by loaded extensions. Custom `--allow-tools` grants that differ from the default built-in list are strict; name extension tools explicitly when using one.
- Granting `bash`, `edit`, or `write` can modify host files or run shell commands. Extension tools run code installed on the host and may do the same. TTY host startup asks for confirmation and offers `trust` to continue while trusting project-local workspace resources; noninteractive unsafe grants, including the default grant, require `--yes`.
- `--register-workspace` is a local desktop action. It stores a workspace name and realpath in the selected host state file, without starting a remote API for clients to create, rename, browse, or path-map workspaces. In a TTY, registration also offers `trust` when the workspace has project-local Volt resources; `--register-workspace --approve` saves workspace trust noninteractively. Removing a workspace unregisters the saved name from host state only; it does not delete files.
- Bare `volt remote host` exposes the current working directory. If that directory is already registered, the saved workspace name and tool defaults are reused; otherwise the host registers it by basename.
- If a host state file has multiple registered workspaces, `volt remote pair --workspace <name>` chooses the initial workspace for the ticket. It does not restrict that paired phone to only that workspace.
- Pairing tickets are short-lived and one-time. Bare preview `volt remote host` shows a startup ticket as a terminal QR code by default when stderr is a TTY. `volt remote host --mobile` starts without an active startup pairing invite; use `volt remote pair` to create the QR/ticket when adding or explicitly re-pairing a phone. The QR is not used for ordinary reconnects, workspace registration changes, New Agent, Resume Agent, or pinned-tab changes. `volt remote pair` is mediated by a running host control channel; offline pairing from persisted state is not supported.
- Saved-host reconnects omit the pairing secret and verify the host node ID. App restart, foreground reconnect after network loss, and host restart with the same host state path should use the saved-host path instead of asking for another QR.
- A paired phone is authorized for the workstation represented by the host state file. It can reconnect to any registered workspace name in that state file, including names registered later, without scanning another QR.
- On integrated hosts that advertise `multi_streams.v1` and `conversation_streams.v1`, that paired phone can open multiple conversation streams, including different sessions in the same workspace. The host rejects the same client opening the same workspace/session twice on one live Iroh connection with `duplicate_conversation_connection` and retry metadata. The first conversation stream on a new same-client connection can replace a stale active stream for the same workspace/session and reattach to the retained integrated runtime. If another client owns the requested workspace/session runtime, the host rejects with `conversation_in_use`.
- Hosts that do not advertise `conversation_streams.v1` are incompatible with the mobile pinned-agent model. The app keeps the saved host and shows an update/integrated-host-required state rather than falling back to mobile mutation commands.
- Registering a workspace does not add built-in tools to a client. The persisted client `allowedTools` grant applies across all registered workspaces until the client is revoked and paired again with a different grant; when that grant is the default built-in list, active extension tools in the selected workspace are also exposed.
- Revoked clients cannot reconnect or silently re-pair. Live hosts close active streams and runtimes for that phone across all workspaces. To trust the same phone identity again, run `volt remote approve-repair <node-id>` on the desktop host, then create a fresh pairing ticket.
- Reconnect clients should distinguish `host_unreachable`, `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, `client_revoked`, `workspace_unavailable`, `workspace_unregistered`, `workspace_authorization_removed`, `session_unavailable`, `duplicate_conversation_connection`, `conversation_in_use`, and `conversation_streams_unsupported`. Ordinary offline hosts are retry states that keep the saved host; invalid, mismatched, unknown, or revoked relationships require Pair Again or Forget Host decisions.
- Remote clients select saved workspace names only. They cannot request arbitrary host paths. If a selected name is not registered or its saved path is stale, reconnect fails with `workspace_unavailable` while keeping the saved host. A reviewed remote unregister request can remove a known workspace name from host state without deleting files; creating, renaming, browsing, or path-mapping host workspaces stays local to the desktop host.
- Remote sessions do not bypass project trust. A saved trust decision for the workspace is honored; otherwise the host runs project resources untrusted unless the host user chooses `trust` in the prompt or passes `--approve`.
- In the default integrated runtime, app backgrounding, network loss, or stream close detaches the client and does not send `abort`. Active work continues on the host; the same paired client/workspace/session can reconnect and refresh with `get_state` and `get_transcript`. A pinned-agent client should reopen only the selected saved agent on foreground recovery; hidden pins remain detached until selected and then catch up from state/transcript.
- Remote stop/cancel controls must send the `abort` RPC command. Closing the stream without `abort` is disconnect only.
- Idle detached integrated runtimes are retained for 30 minutes by default; change this with `--detached-runtime-ttl-ms <ms>`. Host exit, crash, explicit shutdown, or `--once` is not durable recovery for active work.
- State and audit JSONL are stored under the Volt agent config directory by default, or under the paths passed with `--state` and `--audit`.
- Remote push notifications use the managed Volt push relay by default. The mobile app registers its FCM token with the relay and sends the host target-scoped relay credentials over Iroh; the host does not store raw FCM tokens. Use `--push-relay-url` or `VOLT_PUSH_RELAY_URL` only for a custom relay, and `--push-relay-auth-token` or `VOLT_PUSH_RELAY_AUTH_TOKEN` only when that custom relay requires shared bearer auth.
- Live Activity updates are bound to the selected conversation stream. When an ActivityKit push token is available, the app first sends it to the host as `register_push_target.args.liveActivity` with the activity ID, token environment, and lowercase SHA-256 hash. After that delivery channel is acknowledged, the app sends `register_live_activity` with workspace name, session ID, activity ID, platform, token environment, and the ActivityKit token hash. The host validates the hash against the existing delivery channel and cleans registrations up on unregister, selected-stream abort, replacement, revocation, workspace unregister/authorization removal, or retained-runtime disposal.
- `volt remote host` uses `--relay default` by default so saved-host reconnects can survive host restarts. `volt remote host --mobile` remains the mobile-facing mode because it skips startup pairing. Use `--relay disabled` only as an explicit LAN-only opt-out.
- `volt remote pair` creates pairing tickets with the live host relay mode unless `--relay <disabled|default>` is supplied as an expectation check; it cannot change a running host's relay mode.
- `volt remote host` requires a Node.js npm install or source checkout with optional `@number0/iroh` available for the platform. Bun binary builds reject it because the native Iroh adapter is not bundled.
- Known preview limitations: host process exit is not durable active-work recovery, idle detached runtime retention is time-limited, very large hidden-agent sets may need future host/app resource controls, per-workspace client grants are deferred, remote workspace creation/rename/path browsing stays local to the desktop host, `volt remote status` is a persisted-state view, and default relay/discovery should be validated in the target cross-network environment.

See [Iroh remote protocol v1](iroh-remote-protocol.md), [Iroh remote access design](iroh-remote-access-design.md), and [Security](security.md#remote-access-over-iroh-preview).

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
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
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

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

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
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

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
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

Volt keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

For the full rationale, see the project documentation and extension examples.
