# Security

Volt is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether volt loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Volt considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.volt/settings.json`
- `.volt/extensions`, `.volt/skills`, `.volt/prompts`, or `.volt/themes`
- `.volt/SYSTEM.md` or `.volt/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.volt` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, volt follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.volt/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows volt to load project resources that require trust, including:

- `.volt/settings.json`
- `.volt` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, volt only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Volt does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the volt process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Volt is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing volt's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by volt.

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

`volt remote host` is opt-in remote access to a local Volt runtime. Treat a paired remote client as a user who can operate Volt inside the exposed workspace with the tools granted by the host.

Supported preview safety model:

- Nothing listens until the host user runs `volt remote host`.
- Workspaces are registered locally by the desktop user with saved names; clients cannot request arbitrary host paths.
- Registering a workspace is a local desktop action. Remote clients cannot create, rename, delete files, browse host paths, or path-map host workspaces from the app. A reviewed remote unregister request may remove a known workspace name from host state only; it does not delete files.
- The default remote tool grant includes the built-in coding tools `read,bash,edit,write,grep,find,ls,subagent` plus active tools registered by loaded extensions. Custom grants that differ from the default built-in list are strict; extension tools must be named explicitly there. The `subagent` tool only starts built-in or discovered named definitions, and child tools are clamped by the remote session's active tool grant.
- Pairing tickets are short-lived, one-time credentials. Persisted state stores secret hashes and non-secret metadata, not raw pairing secrets.
- Pairing through `volt remote pair` requires a running host control channel; offline ticket generation from persisted state is not supported.
- Mobile-facing `volt remote host --mobile` startup does not create an active pairing ticket. Add phones explicitly with `volt remote pair`.
- Paired clients are persisted until revoked with `volt remote revoke <node-id>` or `volt remote revoke --all`.
- After pairing, saved-host reconnect uses the persisted client node ID and a secret-free client saved-host record. Ordinary app reconnect, temporary network loss, or host restart with the same host state path should not require scanning another QR.
- Pairing is workstation-scoped for the host state file. A paired phone can reconnect to any registered workspace name in that state file, including workspaces registered after pairing, without another QR scan. The app receives and selects names and host feature strings only, never host-local paths.
- Integrated hosts advertise `multi_streams.v1` and `conversation_streams.v1`. Mobile conversation streams bind at handshake time to one authorized workspace/session target, and the host-observed Iroh client node ID is authoritative for authorization, runtime ownership, revocation, audit, and Live Activity routing.
- Same-client duplicates for one workspace/session on one live Iroh connection are rejected with `duplicate_conversation_connection`. The first conversation stream on a new same-client connection can replace a stale active stream for the same workspace/session and reattach to the retained integrated runtime. Another client owning the same workspace/session is rejected with `conversation_in_use`. Different sessions in the same registered workspace may run concurrently.
- Mobile conversation streams cannot be retargeted after handshake. Command-level workspace/session fields are assertions only and mismatches fail with `session_mismatch`. Direct `new_session`, `switch_session_by_id`, and raw `get_messages` are rejected on mobile conversation streams.
- Workspace discovery streams accept only remote-safe `list_sessions` and do not create or update runtime state. Workspace management streams accept only authorized `unregister_workspace`.
- Hosts that do not advertise `conversation_streams.v1` are incompatible with the mobile pinned-agent model. The app should keep the saved host and show an update/integrated-host-required state instead of asking for a QR scan or using old mutation commands.
- Registering another workspace does not grant more built-in tools. The client's persisted `allowedTools` grant applies across every registered workspace until the client is revoked and paired again with a different grant; when that grant is the default built-in list, active extension tools in the selected workspace are also exposed.
- Revocation removes future access from persisted state and asks a live host to close matching active streams, connections, integrated runtimes, and stream-bound Live Activity registrations when one is reachable. A revoked phone is blocked from every registered workspace in that state file.
- A revoked phone node ID cannot reconnect or re-pair with only a generic new QR. The desktop host must approve that node with `volt remote approve-repair <node-id>`, then issue a fresh active pairing ticket.
- In the default integrated runtime, Iroh stream close is detach, not cancellation. Closing one conversation stream does not close or abort other active conversation streams for the same phone. Active work can continue on the host until it finishes or an authorized client sends `abort` on the selected bound stream.
- Detached integrated runtimes can be reattached only by the same authoritative Iroh client node ID, workspace, and session, and idle detached runtimes expire by the host retention policy.
- `volt remote status` and `volt remote clients` report persisted workspaces, clients, tool grants, state path, audit path, and redacted push target metadata without printing secrets or secret hashes.
- State and audit JSONL are stored under the Volt agent config directory by default, or under the paths passed with `--state` and `--audit`.

Unsafe remote tools require explicit host approval. Granting `bash`, `edit`, or `write` lets the remote session modify files or run shell commands on the host. Extension tools run code installed on the host and may do the same; expose them only when those extensions, the client device, and the network path are trusted. TTY host startup asks for confirmation and offers `trust` to continue while saving workspace trust; TTY pair commands ask for confirmation. Noninteractive unsafe grants, including the default grant, require `--yes`.

Remote sessions do not bypass project trust. Project-local settings, extensions, skills, prompt templates, themes, system prompts, and package-managed resources follow the same project trust rules as local Volt. A saved trust decision for the workspace is honored; otherwise the host runs those resources untrusted unless the host user chooses `trust` in the prompt or passes `--approve`. `volt remote host --register-workspace --approve` saves trust for the registered workspace.

Remote host support requires a Node.js npm package install or source checkout with optional `@number0/iroh` available for the platform. Bun binary builds reject `volt remote host` because the native Iroh adapter is not bundled. If startup reports that the optional native adapter is unavailable, reinstall with optional dependencies enabled for the current platform.

Host process exit, host crash, or explicit host shutdown stops in-memory work; remote access does not provide durable job recovery beyond persisted session state.

Push notification delivery is mediated by the managed Volt relay by default. The mobile app registers its FCM token with the relay, then sends the desktop host only an opaque relay target id plus a target-scoped delivery credential. Volt host state stores that relay credential and optional token hash, but not the raw FCM registration token. Custom relays can be selected with `--push-relay-url` or `VOLT_PUSH_RELAY_URL`; if a custom relay uses shared bearer auth, pass it with `--push-relay-auth-token` or `VOLT_PUSH_RELAY_AUTH_TOKEN`.

Live Activity delivery is stream-bound. When an ActivityKit push token is available, the app sends it to the host inside `register_push_target.args.liveActivity` with the activity ID, token environment, and lowercase SHA-256 hash. The later `register_live_activity` command sends workspace name, session ID, activity ID, platform, token environment, and the same hash without repeating the raw token. The host resolves that hash against the existing delivery channel and drops matching registrations on explicit unregister, selected-stream abort success, replacement, revocation, workspace unregister or authorization removal, and retained-runtime disposal.

`volt remote host` uses `--relay default` by default so saved-host reconnects can survive host restarts. Use `volt remote host --mobile` for mobile-facing setup; it starts without creating a startup pairing invite. Use `volt remote pair` to create pairing tickets, and use `--relay disabled` only when the host user explicitly chooses LAN-only mode.

Client UX should treat offline, authorization, workspace, and conversation failures differently. `host_unreachable` keeps the saved host and retries later. `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, and `client_revoked` require explicit user action such as Pair Again or Forget Host. `workspace_unavailable`, `workspace_unregistered`, `workspace_authorization_removed`, `workspace_forbidden`, `session_unavailable`, `duplicate_conversation_connection`, `conversation_in_use`, and `conversation_streams_unsupported` are host capability, workspace, or conversation-selection problems, not reasons to discard the saved host by default.

See [Using Volt](usage.md#remote-access-over-iroh-preview) for copy-pastable commands and [Iroh remote protocol v1](iroh-remote-protocol.md) for the external client contract.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](../../../SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how volt grants access that the local user did not already have.
