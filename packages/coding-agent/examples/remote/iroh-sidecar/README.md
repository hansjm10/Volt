# Iroh remote demo clients

This example tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream.

The supported preview host lives in Volt itself: `volt remote host` launches `packages/coding-agent/src/remote/iroh-host.mjs` from source checkouts, or the copied `dist/remote/iroh-host.mjs` from package installs. This directory keeps demo clients, fake-RPC fixtures, and compatibility wrappers for local remote-host testing.

## Install

From the repository root:

```bash
npm run iroh:poc:install
```

For direct demo-client commands from this directory after the repository root or containing package has already been installed:

```bash
npm install --ignore-scripts
```

`@number0/iroh` is an optional dependency of `@earendil-works/volt-coding-agent`. Host commands use the product package install, so run root install before `volt remote host` or `npm run iroh:poc:host`. If `volt remote host` reports that the optional native adapter is unavailable, reinstall with optional dependencies enabled for the current platform. The example package can still install the dependency locally for direct client demos. Bun binary builds reject `volt remote host` because the optional native Iroh adapter is not bundled; use a Node.js npm install or source checkout.

## Root scripts

From the repository root:

```bash
npm run iroh:poc:smoke                  # local fake-RPC smoke test
npm run iroh:poc:test                   # local fake-RPC scenario tests
npm run iroh:poc:host                   # product host with the fake-RPC child
npm run iroh:poc:host:volt              # integrated source Volt host for this checkout
npm run iroh:poc:client -- "<ticket>"    # one-shot client
npm run iroh:poc:client -- "<ticket>" --interactive  # persistent prompt loop
npm run iroh:poc:clients                # list paired clients through the example wrapper
volt remote clients                     # list paired clients through the product CLI
volt remote status                      # inspect persisted host state
npm run iroh:poc:revoke -- <node-id>    # revoke a paired client through the wrapper
volt remote revoke <node-id>            # revoke a paired client through the product CLI
```

Pass extra host/client flags after `--`, for example:

```bash
npm run iroh:poc:host:volt -- --relay default --no-pairing
npm run iroh:poc:client -- "<ticket>" --message "List top-level files."
```

Use `npm run --silent ...` if you want stdout to contain only the ticket or client output.

## Local fake-RPC scenario tests

Run the automated local scenario suite when changing the remote host bridge:

```bash
npm run iroh:poc:test
```

The suite starts local host/client processes with isolated temporary state and covers fake-RPC prompt streaming, remote command filtering, `get_state`, first-class `volt remote pair`, `volt remote status`, pairing persistence, multi-workspace reconnect without another QR, reconnect session resume, missing-session fallback, duplicate active connection rejection, `--no-pairing` rejection, active revocation, unsafe tool gates, expired tickets, and workspace preflight failures.

## Local fake-RPC smoke test

Terminal 1:

```bash
npm run iroh:poc:host -- --once
```

Copy the printed `volt+iroh://v1/...` ticket.

Terminal 2:

```bash
npm run iroh:poc:client -- "<ticket>" --message "hello from another device"
```

Or keep the connection open:

```bash
npm run iroh:poc:client -- "<ticket>" --interactive
```

Expected output for the one-shot command:

```text
fake RPC response over Iroh: hello from another device
```

The first successful connection persists the host key, client key, registered workspaces, and paired client allowlist in state files:

```text
~/.volt/agent/remote/iroh-host.json
~/.volt/agent/remote/iroh-sidecar-client.json
```

Use `--state <path>` on host or client for isolated test state.

## Workspace registration, pairing, and revocation

Register workspaces locally on the desktop host. The registered name is what remote clients and the iOS app see; the host-local path stays in the host state file. In a TTY, registration offers `trust` when the workspace has project-local Volt resources; use `--approve` to save workspace trust noninteractively.

```bash
volt remote host --register-workspace volt=/path/to/repo
volt remote host --register-workspace other=/path/to/other-repo
```

The host prints a pairing ticket by default. A client that connects with that ticket is added to the host allowlist for the workstation represented by the host state file. The ticket workspace is the first selected workspace, not the only workspace the paired client may use.

A running host also accepts local management requests from `volt remote pair`, which prints only the generated ticket on stdout:

```bash
# Terminal 1
volt remote host --register-workspace volt=/path/to/repo --allow-tools read,grep,find,ls
volt remote host --mobile --yes

# Terminal 2
volt remote pair --workspace volt
npm run iroh:poc:client -- "<ticket>" --get-state

# Unsafe grants require confirmation, or --yes for noninteractive use.
volt remote pair --workspace volt --allow-tools read,grep,find,ls,bash --yes
```

If no host is running for the selected `--state` file, or if the workspace is missing or ambiguous, `volt remote pair` fails with diagnostics on stderr and no ticket on stdout.

After a client is paired, reconnect tickets do not need a pairing secret. The same paired client can reconnect to another registered workspace name in the same host state file without scanning another QR. Registering a new workspace does not change the client's persisted built-in tool grant; the existing `allowedTools` grant applies across all registered workspaces until the client is revoked and paired again with a different grant. When that grant is the default built-in list, active extension tools in the selected workspace are also exposed.

List paired clients:

```bash
npm run iroh:poc:clients
```

Inspect persisted host state, workspaces, clients, client tool grants, and state/audit paths:

```bash
volt remote status
volt remote status --state ~/.volt/agent/remote/iroh-host.json
```

`volt remote status` prints persisted state only and includes that warning in its output; it does not print pairing secrets or secret hashes.

Revoke a client:

```bash
npm run iroh:poc:revoke -- <client-node-id>
```

Revocation removes the client from persisted state so future connections to every registered workspace fail. If a host is currently running for the same state file, the revoke command also asks that host to close matching active connections and audits `active_connection_revoked`; if no live host is reachable, persisted revocation still succeeds and the command prints an active-live-unavailable diagnostic. To change an existing client's tool grant in preview, revoke that client and pair it again with the desired `--allow-tools`.

After a client is paired, the host can run without accepting new clients:

```bash
npm run iroh:poc:host -- --no-pairing --once
```

In `--no-pairing` mode, the printed ticket contains no pairing secret. Only clients already stored in the host allowlist can connect.

## Test with real Volt RPC

Terminal 1, when testing this source checkout from the repository root:

```bash
npm run iroh:poc:host:volt -- --allow-tools read,grep,find,ls
```

The same integrated path is also available through the source CLI:

```bash
node scripts/run-coding-agent-source.mjs remote host --workspace volt=. --allow-tools read,grep,find,ls
```

Remote sessions follow normal project trust behavior. Saved workspace trust is honored; otherwise choose `trust` in the host prompt or add `--approve` only when the host user trusts project-local settings/resources for the exposed workspace.

Terminal 1, when testing another source checkout as a spawned RPC child from this directory:

```bash
npm run iroh:poc:host -- --source-volt /path/to/volt --workspace volt=/path/to/volt --allow-tools read,grep,find,ls
```

Terminal 1, when `volt` is globally installed on the host `PATH`:

```bash
npm run iroh:poc:host -- --use-volt --workspace volt=/path/to/repo --allow-tools read,grep,find,ls
```

Terminal 2, one-shot commands:

```bash
npm run iroh:poc:client -- "<ticket>" --get-state
npm run iroh:poc:client -- "<ticket>" --message "List the top-level files."
```

Terminal 2, persistent prompt loop:

```bash
npm run iroh:poc:client -- "<ticket>" --interactive
```

Interactive commands:

- `/state` prints current RPC session state.
- `/abort` sends an abort command.
- `/quit` or `/exit` exits the client.
- Ctrl+C aborts a running prompt; Ctrl+C while idle exits.

The default relay mode is suitable for cross-network testing; the ticket carries the relay mode to the client. On Windows, a global install normally resolves through `volt.cmd` automatically when `--volt-bin` is omitted.

## Relay mode

The default is `--relay default`, which keeps saved-host reconnect tickets usable across host restarts. For explicit LAN-only testing:

```bash
npm run iroh:poc:host -- --relay disabled --once
```

The ticket records the relay mode and the client uses the same preset. Use the default relay mode for real app validation; same-machine tests do not prove relay reachability.

## Security notes

Remote host support is a preview feature and should be treated as remote access to the host machine.

- Remote access is opt-in; nothing listens until the host command starts.
- Pairing tickets contain a short-lived one-time secret for adding a client to the allowlist. Persisted state stores hashes and non-secret metadata, not raw secrets.
- Paired clients are persisted until revoked.
- Any paired client can control the integrated runtime or spawned RPC child for registered workspace names in the same host state file.
- Pairing is workstation-scoped in this preview. A paired client can use registered workspace names added later without another QR scan, and revocation blocks that client from every registered workspace.
- Real Volt RPC can use only built-in tools allowed by the client's persisted `allowedTools` grant. That grant applies across all registered workspaces; when it is the default built-in list, active extension tools in the selected workspace are also exposed.
- Use a custom read-only tool list (`read,grep,find,ls`) unless the client, workspace, and loaded extensions are trusted.
- `--allow-tools` grants that include `bash`, `edit`, or `write` can modify host files or run shell commands; extension tools run code installed on the host and may do the same. TTY host and pair commands ask for confirmation on unsafe built-in grants, and noninteractive commands must pass `--yes`.
- Workspaces are registered locally and selected by saved name, not arbitrary client-provided paths. Remote clients cannot register, edit, delete, or map workspace paths.
- Remote sessions do not bypass project trust. Saved workspace trust is honored; otherwise choose `trust` in the host prompt or use `--approve` only when the host user trusts project-local resources.
- Default state and audit paths are `~/.volt/agent/remote/iroh-host.json` and `~/.volt/agent/remote/iroh-host.audit.jsonl`.
- Do not expose sensitive workspaces or run with `bash,edit,write` unless the client is trusted.

See [Using Volt](../../../docs/usage.md#remote-access-over-iroh-preview), [Security](../../../docs/security.md#remote-access-over-iroh-preview), and [the design document](../../../docs/iroh-remote-access-design.md) for the product security model.
