# Iroh sidecar proof of concept

This example tunnels Volt RPC JSONL over an Iroh QUIC bidirectional stream.

The PoC keeps the native Iroh dependency outside Volt core while importing Volt's shared Iroh protocol helpers for tickets, state, authorization, handshakes, and command filtering. `host.mjs` accepts an Iroh connection, validates pairing, and either bridges to a child RPC process or runs the source checkout's Volt runtime in-process with `--integrated-volt`. The default child is `fake-rpc.mjs` so the network bridge can be tested without provider credentials.

## Install

From the repository root:

```bash
npm run iroh:poc:install
```

Or from this directory:

```bash
npm install --ignore-scripts
```

`@number0/iroh` is a native package with optional prebuilt platform packages. Keeping it in this example package avoids adding Iroh to Volt's default install path.

If a root script says the Iroh sidecar dependencies are not installed, run `npm run iroh:poc:install` on that machine.

## Root scripts

From the repository root:

```bash
npm run iroh:poc:smoke                  # local fake-RPC smoke test
npm run iroh:poc:test                   # local fake-RPC scenario tests
npm run iroh:poc:host                   # fake-RPC host
npm run iroh:poc:host:volt              # integrated source Volt host for this checkout
npm run iroh:poc:client -- "<ticket>"    # one-shot client
npm run iroh:poc:client -- "<ticket>" --interactive  # persistent prompt loop
npm run iroh:poc:clients                # list paired clients
npm run iroh:poc:revoke -- <node-id>    # revoke a paired client
```

Pass extra host/client flags after `--`, for example:

```bash
npm run iroh:poc:host:volt -- --relay default --no-pairing
npm run iroh:poc:client -- "<ticket>" --message "List top-level files."
```

Use `npm run --silent ...` if you want stdout to contain only the ticket or client output.

## Local fake-RPC scenario tests

Run the automated local scenario suite when changing the sidecar bridge:

```bash
npm run iroh:poc:test
```

The suite starts local host/client processes with isolated temporary state and covers fake-RPC prompt streaming, `get_state`, pairing persistence, `--no-pairing` rejection, revocation, expired tickets, and workspace preflight failures.

## Local fake-RPC smoke test

Terminal 1:

```bash
npm run host -- --once
```

Copy the printed `volt+iroh://v1/...` ticket.

Terminal 2:

```bash
npm run client -- "<ticket>" --message "hello from another device"
```

Or keep the connection open:

```bash
npm run client -- "<ticket>" --interactive
```

Expected output for the one-shot command:

```text
fake RPC response over Iroh: hello from another device
```

The first successful connection persists the host key, client key, workspace, and paired client allowlist in state files:

```text
~/.volt/agent/remote/iroh-sidecar-host.json
~/.volt/agent/remote/iroh-sidecar-client.json
```

Use `--state <path>` on host or client for isolated test state.

## Pairing and revocation

The host prints a pairing ticket by default. A client that connects with that ticket is added to the host allowlist for the selected workspace.

List paired clients:

```bash
npm run host -- clients
```

Revoke a client:

```bash
npm run host -- revoke <client-node-id>
```

After a client is paired, the host can run without accepting new clients:

```bash
npm run host -- --no-pairing --once
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

Terminal 1, when testing another source checkout as a spawned RPC child from this directory:

```bash
npm run host -- --source-volt /path/to/volt --workspace volt=/path/to/volt --allow-tools read,grep,find,ls
```

Terminal 1, when `volt` is globally installed on the host `PATH`:

```bash
npm run host -- --use-volt --workspace volt=/path/to/repo --allow-tools read,grep,find,ls
```

Terminal 2, one-shot commands:

```bash
npm run client -- "<ticket>" --get-state
npm run client -- "<ticket>" --message "List the top-level files."
```

Terminal 2, persistent prompt loop:

```bash
npm run client -- "<ticket>" --interactive
```

Interactive commands:

- `/state` prints current RPC session state.
- `/abort` sends an abort command.
- `/quit` or `/exit` exits the client.
- Ctrl+C aborts a running prompt; Ctrl+C while idle exits.

Add `--relay default` to the host command when testing across networks; the ticket carries the relay mode to the client. On Windows, a global install normally resolves through `volt.cmd` automatically when `--volt-bin` is omitted.

## Relay mode

The default is `--relay disabled`, which is best for same-machine or same-LAN testing. To exercise Iroh's relay/discovery path:

```bash
npm run host -- --relay default --once
```

The ticket records the relay mode and the client uses the same preset.

## Security notes

This PoC is intentionally small and is not product-ready remote access.

- Pairing tickets contain a one-time secret for adding a client to the allowlist.
- Paired clients are persisted until revoked.
- Any paired client can control the spawned RPC child for its allowed workspace.
- Real Volt RPC can read files, edit files, and run tools allowed by `--allow-tools`.
- Keep the default read-only tool list while testing remotely.
- Do not expose sensitive workspaces or run with `bash,edit,write` unless the client is trusted.

See [the design document](../../../docs/iroh-remote-access-design.md) for the intended product security model.
