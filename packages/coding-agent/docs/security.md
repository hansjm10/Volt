# Security

Volt is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether volt loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Volt considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.volt/settings.json`
- `.mcp.json` or `.volt/mcp.json`
- `.volt/extensions`, `.volt/skills`, `.volt/prompts`, or `.volt/themes`
- `.volt/SYSTEM.md` or `.volt/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.volt` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, volt follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.volt/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows volt to load project resources that require trust, including:

- `.volt/settings.json`
- project MCP server config in `.mcp.json` or `.volt/mcp.json`
- `.volt` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, volt only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Volt does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the volt process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Volt is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing volt's settings, MCP servers, or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by volt.

## Standalone Release Integrity

Prebuilt Volt executables are Node.js 22.23.1 Single Executable Applications.
Release builds verify a pinned official Node runtime archive, bundle Volt's
JavaScript, and generate an exact esbuild metafile plus a checksum-linked npm
license manifest. Each archive includes Volt's license, the consolidated Node
license and third-party notices, and the copied license files recorded by that
manifest. Verify the downloaded archive against the release `SHA256SUMS` before
running it.

Standalone builds intentionally exclude the native Iroh adapter and the
source-repository Doom overlay example. The official Linux runtime requires
glibc 2.28 or newer and does not support Alpine/musl. Windows executables
are not Authenticode-signed, so Windows may show an unknown-publisher warning;
the published SHA-256 checksum is the release authenticity check. macOS
executables are ad-hoc signed after SEA injection, not Developer ID notarized.
See [Standalone Binary Capabilities](../BINARY-CAPABILITIES.md) and
[Third-Party Notices](../THIRD-PARTY-NOTICES.md).

## MCP Servers

Native MCP support can spawn local stdio server commands or connect to configured HTTP/SSE endpoints. User MCP config lives in `~/.volt/agent/mcp.json` and shared `~/.config/mcp/mcp.json`; project `.mcp.json` and `.volt/mcp.json` are loaded only after project trust. Project definitions with the same server id replace, rather than inherit, user-scope definitions so project endpoints cannot reuse user auth/env config by id collision.

MCP server metadata and output are untrusted. Volt exposes MCP through one `mcp` gateway tool, uses risk classification only as display/audit metadata, redacts obvious secrets in audit arguments/errors, and stores audit records under `~/.volt/agent/mcp/audit.jsonl`. Runtime availability is controlled by the top-level `mcp` tool, server include/exclude filters, project trust, auth, and transport/remote-safety rules. Large outputs may be cached under `~/.volt/agent/mcp/output/` and are scoped to the creating session/workspace when Volt constructs the default MCP manager.

Avoid putting long-lived secrets in project MCP config. Auth headers and OAuth-protected remote MCP servers are rejected over non-HTTPS URLs except loopback HTTP. OAuth authorization/token/device/registration endpoints must use HTTPS; browser auth uses PKCE S256 and a loopback callback, and device auth exposes only the verification URL and user code (never the OAuth device code). OAuth tokens are stored host-side in `~/.volt/agent/mcp-auth.json` with owner-only permissions and are never sent to the model or mobile client.

Stdio server environments start from the MCP SDK default safe environment plus explicit `envAllowlist` and configured `env` templates.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run volt in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `volt` process inside OpenShell or Docker
- run host volt while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.volt/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Remote Access over Iroh (Preview)

Remote access is served by the background daemon (`voltd`, see [Background daemon](daemon.md)) and is opt-in. Treat a paired remote client as a user who can operate Volt inside the exposed workspace with the tools granted by the host — pairing a phone grants it desktop-equivalent power over any conversation a desktop TUI shares with it.

Supported preview safety model:

- Nothing listens until the host user starts the daemon (`volt daemon start` or `remote.background: true`). The daemon listens only on its local unix control socket (mode `0600`) and the Iroh endpoint.
- Workspaces are registered locally by the desktop user with saved names; clients cannot request arbitrary host paths.
- Registering a workspace is a local desktop action. Remote clients cannot create, rename, delete files, browse host paths, or path-map host workspaces from the app. A reviewed remote unregister request may remove an empty known workspace name from host state only; it does not delete files. Persisted child worktrees make unregister fail with `workspace_has_worktrees`, preserving their records and checkouts until the user explicitly removes each worktree. Unknown/orphan worktree directories are never unregister cleanup targets.
- The default headless agent tool grant includes `read,bash,edit,write,image_gen,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp` plus active tools registered by loaded extensions. The `coding` and `full` remote RPC presets use this canonical default, so the Codex-only `image_gen` tool is enabled automatically when an OpenAI Codex model is selected. A custom `remote.allowTools` list is strict and applies ONLY to daemon-owned headless runtimes; extension tools must be named explicitly there. The `subagent` tool only starts built-in or discovered named definitions, `subagent_registry` only exposes the shared delegation registry inside child runtimes, and child tools are clamped by the remote session's active tool grant.
- **Tool policy asymmetry (explicit decision).** When a desktop TUI owns the conversation lease, phone prompts execute with the TUI session's FULL local tool set — the phone is the same paired user driving the same conversation, and splitting tool policy mid-conversation creates confusing, falsely-reassuring states. This supersedes `remote.allowTools` for co-attached conversations. Corollary: pairing a phone grants it desktop-equivalent power over any TUI-open conversation.
- Pairing tickets are short-lived, one-time credentials. Persisted state stores secret hashes and non-secret metadata, not raw pairing secrets.
- Pairing through `volt remote pair` talks to the running daemon; offline ticket generation from persisted state is not supported.
- Daemon startup never creates an active pairing ticket. Add phones explicitly with `volt remote pair`.
- Paired clients are persisted until revoked with `volt remote revoke <node-id>`.
- After pairing, saved-host reconnect uses the persisted client node ID and a secret-free client saved-host record. Ordinary app reconnect, temporary network loss, or daemon restart should not require scanning another QR (the daemon owns a persistent Iroh identity).
- Pairing is workstation-scoped for the daemon's state file. A paired phone can reconnect to any registered workspace name, including workspaces registered after pairing, without another QR scan. The app receives and selects names and host feature strings only, never host-local paths.
- Integrated hosts advertise `multi_streams.v1` and `conversation_streams.v1`. Mobile conversation streams bind at handshake time to one authorized workspace/session target, and the host-observed Iroh client node ID is authoritative for authorization, runtime ownership, revocation, and audit.
- Same-client duplicates for one workspace/session on one live Iroh connection are rejected with `duplicate_conversation_connection`. The first conversation stream on a new same-client connection can replace a stale active stream for the same workspace/session and reattach to the retained runtime. Different sessions in the same registered workspace may run concurrently.
- Distinct paired devices normally co-attach to one shared conversation runtime (or to a TUI-owned conversation over the daemon's byte relay). `conversation_in_use` is reserved for the narrow case where that existing daemon runtime permits tools outside the attaching client's persisted grant; the client cannot safely drive the broader runtime. Audit records (`~/.volt/agent/daemon/audit.jsonl`) cover pairing, lease transfers, and relay lifecycle so "what did the phone do while I was away" is reviewable after the fact.
- Mobile conversation streams cannot be retargeted after handshake. Command-level workspace/session fields are assertions only and mismatches fail with `session_mismatch`. Direct `new_session`, `switch_session_by_id`, and raw `get_messages` are rejected on mobile conversation streams.
- Paired clients with `host.manage.v1` can request normalized subscription quota windows for stored OAuth logins. This account-level read never returns credentials, account identity, or raw provider payloads, and it never queries API keys.
- Workspace discovery streams accept only remote-safe `list_sessions` and do not create or update runtime state. Workspace management streams accept only authorized `unregister_workspace`.
- Hosts that do not advertise `conversation_streams.v1` are incompatible with the mobile pinned-agent model. The app should keep the saved host and show an update/integrated-host-required state instead of asking for a QR scan or using old mutation commands.
- Registering another workspace does not grant more built-in tools. For daemon-owned runtimes, the effective tool policy is the intersection of the client's persisted `allowedTools` grant, any workspace ceiling, and the daemon's `remote.allowTools` ceiling; missing ceilings add no restriction and an explicit empty daemon ceiling denies all tools. The client grant remains the maximum authority across every registered workspace until the client is revoked and paired again with a different grant. When every active policy layer has default-grant semantics, active extension tools in the selected workspace are also exposed.
- Revocation removes future access from persisted state and asks a live host to close matching active streams, connections, and integrated runtimes when one is reachable. A revoked phone is blocked from every registered workspace in that state file.
- A revoked phone node ID cannot reconnect or re-pair with only a generic new QR. The desktop host must approve that node with `volt remote approve-repair <node-id>`, then issue a fresh active pairing ticket.
- In the default integrated runtime, Iroh stream close is detach, not cancellation. Closing one conversation stream does not close or abort other active conversation streams for the same phone. Active work can continue on the host until it finishes or an authorized client sends `abort` on the selected bound stream.
- Detached integrated runtimes can be reattached only by the same authoritative Iroh client node ID, workspace, and session, and idle detached runtimes expire by the host retention policy.
- `volt daemon status` and `volt remote status` include required structured `remoteTransport` health and exit nonzero unless it is `ready`. Safe reason codes expose missing bindings, endpoint startup failure, or observed storage exhaustion without leaking raw exception details. Local management remains available while phone transport is unavailable.
- State and audit JSONL are stored under `~/.volt/agent/daemon/` (`state.json` mode `0600` — it contains the Iroh secret key — and `audit.jsonl`).

Unsafe remote tools are powerful. Granting `bash`, `edit`, or `write` lets the remote session modify files or run shell commands on the host. Granting `image_gen` lets it read and upload local reference images and write generated PNG files. Extension tools run code installed on the host and may do the same; expose them only when those extensions, the client device, and the network path are trusted.

Remote sessions do not bypass project trust. Project-local settings, extensions, skills, prompt templates, themes, system prompts, and package-managed resources follow the same project trust rules as local Volt. A saved trust decision for the workspace is honored; otherwise the daemon runs those resources untrusted. Save trust from a desktop Volt session in that workspace.

The daemon requires a Node.js npm package install or source checkout with the exact required `@hansjm10/volt-iroh` wrapper and its optional selected native binding. `--omit=optional` installs retain the wrapper but cannot provide phone transport. Darwin x64 has no binding and is local CLI/TUI only. Standalone Node SEA builds reject `volt daemon` because Iroh is intentionally not bundled. If status reports `native_binding_missing`, reinstall with optional dependencies enabled on a supported platform.

Daemon exit, crash, or explicit shutdown stops in-memory work; remote access does not provide durable job recovery beyond persisted session state.

Push notification delivery is mediated by the managed Volt relay by default. The mobile app registers its FCM token with the relay, then sends the desktop host only an opaque relay target id plus a target-scoped delivery credential. Volt host state stores that relay credential and optional token hash, but not the raw FCM registration token. Custom relays can be selected with `VOLT_PUSH_RELAY_URL`; if a custom relay uses shared bearer auth, pass it with `VOLT_PUSH_RELAY_AUTH_TOKEN`. Push registration keeps working after a TUI takes over a conversation because relayed `register_push_target` commands are forwarded to the daemon.

The daemon defaults to Iroh relay mode `production`, using the Volt-operated relay fleet so saved-host reconnects can survive restarts. Set `VOLT_IROH_RELAY_MODE` to `disabled` for LAN-only connections, `development` for the public n0 development relays, or `production`. Use `volt remote pair` to create pairing tickets.

Client UX should treat offline, capacity, authorization, workspace, and conversation failures differently. `host_unreachable` keeps the saved host, uses a bounded five-attempt automatic cycle, and points operators to `volt daemon status`. `host_storage_full` also keeps pairing, selected-agent, transcript, and authority state, but is Retry-only and never auto-redials until the user frees computer capacity and retries. `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, and `client_revoked` require explicit user action such as Pair Again or Forget Host. `workspace_unavailable`, `workspace_missing`, `workspace_unregistered`, `workspace_has_worktrees`, `workspace_authorization_removed`, `workspace_forbidden`, `session_unavailable`, `duplicate_conversation_connection`, and `conversation_streams_unsupported` are host capability, workspace, or conversation-selection problems, not reasons to discard the saved host by default. `workspace_unavailable` is transient and paced by `retryAfterMs`; `workspace_missing` means the registered path is gone and automatic redialing should stop. `workspace_has_worktrees` requires explicit worktree review/removal before retrying unregister. `lease_transferred` and `session_rekeyed_reconnect` closures are expected handoffs the app reconnects through silently.

See [Using Volt](usage.md#remote-access-over-iroh-preview) for copy-pastable commands and [Iroh remote protocol v1](iroh-remote-protocol.md) for the external client contract.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](../../../SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how volt grants access that the local user did not already have.
