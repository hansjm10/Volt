# Volt Agent Harness Monorepo

Volt is a local coding-agent monorepo with a CLI, agent runtime, provider API, and terminal UI package.

Volt is maintained and distributed by [Jordan Hans](https://github.com/hansjm10).
It is derived from [Mario Zechner's Pi project](https://github.com/badlogic/pi-mono)
and remains available under the MIT License.

## Packages

| Package | Description |
|---------|-------------|
| **[@hansjm10/volt-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@hansjm10/volt-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@hansjm10/volt-ai](packages/ai)** | Unified multi-provider LLM API |
| **[@hansjm10/volt-tui](packages/tui)** | Terminal UI library with differential rendering |

## Remote Access Preview

The background daemon (`voltd`) can expose local Volt conversations to a paired phone over Iroh without moving provider credentials or repository files off the host. Pairing is workstation-scoped: start with `volt daemon start`, register local workspaces by name, and issue a strict one-time `volt+iroh://v2` invitation with `volt remote pair`. Official relay enrollment is app-assisted and endpoint-bound; the QR contains no broker URL or durable relay bearer. After pairing, the phone can open known workspace names without another QR scan.

Integrated hosts advertise `multi_streams.v1` and `conversation_streams.v1`.
Mobile streams bind during the Iroh handshake to one workspace/session
conversation: `target:last`, `target:new`, or `target:session`. The iOS app
renders those conversations as pinned agent tabs, including multiple sessions
inside the same registered workspace. Commands, transcripts, native actions,
host actions, notifications, and `/workspace` path mapping stay scoped to the
bound conversation stream.

Workspace discovery and management use short-lived utility streams. Discovery
permits only `list_sessions`; management permits only authorized
`unregister_workspace`. Mobile conversation streams no longer use direct
`new_session`, `switch_session_by_id`, or raw `get_messages`; new and resumed
agents are selected by opening a targeted conversation stream, and transcript
recovery uses bounded `get_transcript` plus sanitized `transcript_entry` events.

Closing a stream, switching tabs, app backgrounding, or network loss is detach
only. User cancellation is the selected stream's `abort` RPC command. Same
client/workspace/session duplicates fail with `duplicate_conversation_connection`
and retry metadata; another client owning the same conversation fails with
`conversation_in_use`. Revocation, workspace authorization removal, and
workspace unregister close only affected streams and retained runtimes. Host
process exit is not durable active-work recovery, and large hidden-agent sets may
need future resource controls.

See [Using Volt](packages/coding-agent/docs/usage.md#remote-access-over-iroh-preview),
[Security](packages/coding-agent/docs/security.md#remote-access-over-iroh-preview),
[Iroh Remote Protocol v2](packages/coding-agent/docs/iroh-remote-protocol.md), and
[Iroh relay enrollment design](packages/coding-agent/docs/iroh-relay-enrollment-design.md)
for setup commands, transport fallback behavior, and the wire contracts.

## Permissions And Containerization

Volt does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Volt. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `volt` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `volt` process in a local container for simple isolation.
- **OpenShell**: run the whole `volt` process in a policy-controlled sandbox.

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run check                 # Lint, format, and type check
./test.sh                     # Run tests without e2e provider tests
./volt-test.sh                # Run volt from sources
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules.

## Supply Chain

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `VOLT_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Local release installs, documented npm installs, and `volt update --self` use `--ignore-scripts` where supported.

## License

MIT. Volt preserves the copyright and license notices for the Pi project and
other incorporated open-source software. See [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](packages/coding-agent/THIRD-PARTY-NOTICES.md).
