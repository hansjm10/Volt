# Iroh remote demo client

This example drives Volt RPC JSONL over Iroh against the product background daemon (`voltd`). The old standalone example host has been removed; the daemon owns the persistent endpoint identity, pairing, registered workspaces, grants, and audit state.

## Install

From the repository root:

```bash
npm run iroh:poc:install
```

`@number0/iroh` is optional in `@hansjm10/volt-coding-agent`. Run the root install with optional dependencies enabled before starting the daemon. Standalone Node SEA builds do not bundle Iroh; use a Node.js npm install or source checkout.

## Start, register, and pair

Terminal 1:

```bash
volt daemon start
volt remote workspace add /path/to/repo --name volt
volt remote pair --workspace volt
```

`volt remote pair` prints a strict `volt+iroh://v2/...` invitation and waits for it to be claimed. The ticket is short-lived and one-time. A managed ticket contains separate desktop-pairing and 10-minute relay-enrollment claims, but no broker URL, App Check token, durable pair grant, or relay infrastructure bearer.

Terminal 2:

```bash
npm run iroh:poc:client -- "<ticket>" --get-state
npm run iroh:poc:client -- "<ticket>" --message "List the top-level files."
npm run iroh:poc:client -- "<ticket>" --interactive
```

Interactive commands are `/state`, `/abort`, and `/quit` (`/exit` is an alias). Ctrl+C aborts a running prompt and exits while idle.

Use `npm run --silent ...` when stdout must contain only client output.

## Management and reconnect

```bash
volt daemon status
volt remote status
volt remote clients
volt remote workspace list
volt remote revoke <client-node-id>
volt remote approve-repair <client-node-id>
```

After host authentication, a paired client reconnects with pinned endpoint identity and saved-host authority rather than another QR. The same phone can select any registered workspace name in the daemon state. Revocation blocks desktop RPC for that phone across all workspaces; approving re-pair and issuing a fresh ticket are both required before a revoked endpoint can return.

The demo client persists its endpoint key under `~/.volt/agent/remote/iroh-sidecar-client.json`. Use its `--state <path>` option for isolated tests. Daemon state and audit data live under `~/.volt/agent/daemon/`; status output does not print secrets.

## Relay descriptors

The running daemon fixes the v2 ticket descriptor:

- default `production` with official origins: `volt-managed`, requiring app-assisted enrollment from the official iOS app;
- `VOLT_IROH_RELAY_MODE=development`: `n0-public`, suitable for this non-App-Check demo and simulator testing;
- `VOLT_IROH_RELAY_MODE=disabled`: direct/LAN only; or
- production with custom `VOLT_IROH_RELAY_URLS`: `custom-uncredentialed` owner-controlled origins.

The Node demo client cannot approve a managed Firebase App Check claim. Use explicit n0-public or disabled transport for this example:

```bash
VOLT_IROH_RELAY_MODE=development volt daemon start
```

Broker failure for managed transport does not disable direct/LAN dialing. Custom relays receive no App Check material. See [Iroh relay enrollment design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/iroh-relay-enrollment-design.md).

## Security notes

- Desktop-control pairing and relay enrollment are separate. A pair grant cannot authorize a Volt handshake, workspace, RPC, or tool.
- Pair only devices you control. A paired phone can drive every registered workspace and, for a TUI-owned conversation, the TUI's full local tool set.
- Daemon-owned runtimes enforce the persisted client tool/capability grant and configured ceilings. `bash`, `edit`, `write`, `image_gen`, and extension tools can affect host files, processes, credentials, or networks.
- Workspace names are registered locally; clients cannot supply arbitrary host paths. Remote sessions do not bypass project trust.
- Stock managed-relay revocation takes effect on the next endpoint registration. It cannot interrupt an already-open relay registration or meter endpoint bytes.

See [Using Volt](../../../docs/usage.md#remote-access-over-iroh-preview), [Security](../../../docs/security.md#remote-access-over-iroh-preview), [Iroh Remote Protocol v2](../../../docs/iroh-remote-protocol.md), and [Background daemon](../../../docs/daemon.md).
