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
- Workspaces are exposed by saved names such as `volt=/path/to/repo`; clients cannot request arbitrary host paths.
- The default remote tool allowlist includes the built-in coding tools: `read,bash,edit,write,grep,find,ls`.
- Pairing tickets are short-lived, one-time credentials. Persisted state stores secret hashes and non-secret metadata, not raw pairing secrets.
- Pairing through `volt remote pair` requires a running host control channel; offline ticket generation from persisted state is not supported.
- Mobile-facing `volt remote host --mobile` startup does not create an active pairing ticket. Add phones explicitly with `volt remote pair`.
- Paired clients are persisted until revoked with `volt remote revoke <node-id>`.
- After pairing, saved-host reconnect uses the persisted client node ID and a secret-free client saved-host record. Ordinary app reconnect, temporary network loss, or host restart with the same host state path should not require scanning another QR.
- Revocation removes future access from persisted state and asks a live host to close matching active connections when one is reachable.
- A revoked phone node ID cannot reconnect or re-pair with only a generic new QR. The desktop host must approve that node with `volt remote approve-repair <node-id>`, then issue a fresh active pairing ticket.
- In the default integrated runtime, Iroh stream close is detach, not cancellation. Active work can continue on the host until it finishes or an authorized client sends `abort`.
- Detached integrated runtimes can be reattached only by the same authoritative Iroh client node ID and workspace, and idle detached runtimes expire by the host retention policy.
- `volt remote status` reports persisted workspaces, clients, tool grants, state path, and audit path without printing secrets or secret hashes.
- Default paths are `~/.volt/agent/remote/iroh-host.json` for state and `~/.volt/agent/remote/iroh-host.audit.jsonl` for audit JSONL.

Unsafe remote tools require explicit host approval. Granting `bash`, `edit`, or `write` lets the remote session modify files or run shell commands on the host. TTY host/pair commands ask for confirmation; noninteractive unsafe grants, including the default grant, require `--yes`. Do not grant unsafe tools unless the client device and network path are trusted.

Remote sessions do not auto-approve project trust. Project-local settings, extensions, skills, prompt templates, themes, system prompts, and package-managed resources follow the same project trust rules as local Volt. Use `--approve` only when the host user trusts those resources for the exposed workspace.

Remote host support requires a Node.js npm package install or source checkout with optional `@number0/iroh` available for the platform. Bun binary builds reject `volt remote host` because the native Iroh adapter is not bundled. If startup reports that the optional native adapter is unavailable, reinstall with optional dependencies enabled for the current platform.

Host process exit, host crash, or explicit host shutdown stops in-memory work; remote access does not provide durable job recovery beyond persisted session state. Spawned child compatibility modes through `--use-volt` or `--source-volt` are connection-scoped and can stop the child on disconnect.

Bare `volt remote host` uses `--relay disabled` for same-machine and same-LAN preview workflows. Use `volt remote host --mobile` for mobile-facing setup; it starts the host in relay/discovery mode `"default"` without creating a startup pairing invite. Use `volt remote pair` to create pairing tickets, and use `--relay disabled` only when the host user explicitly chooses LAN-only mode. Use `--relay default` when validating access across networks.

Client UX should treat offline and authorization failures differently. `host_unreachable` keeps the saved host and retries later. `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, and `client_revoked` require explicit user action such as Pair Again or Forget Host. `workspace_unavailable` and `workspace_forbidden` are workspace access problems, not reasons to discard the host relationship.

See [Using Volt](usage.md#remote-access-over-iroh-preview) for copy-pastable commands and [Iroh remote protocol v1](iroh-remote-protocol.md) for the external client contract.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](../../../SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how volt grants access that the local user did not already have.
