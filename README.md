# Volt Agent Harness Monorepo

Volt is a local coding-agent monorepo with a CLI, agent runtime, provider API, and terminal UI package.

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/volt-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/volt-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/volt-ai](packages/ai)** | Unified multi-provider LLM API |
| **[@earendil-works/volt-tui](packages/tui)** | Terminal UI library with differential rendering |

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

MIT
