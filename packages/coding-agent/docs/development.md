# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
cd <volt-repo>
npm install
npm run build
```

Run from source:

```bash
/path/to/volt/volt-test.sh
```

The script can be run from any directory. Volt keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "voltConfig": {
    "name": "volt",
    "configDir": ".volt"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.volt/agent/volt-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Lifecycle memory benchmark

Run the manual coding-agent memory benchmark from the repository root. It executes TypeScript source directly with Node strip-only mode and the `volt-source` export condition; it does not build or read `dist`:

```bash
npm run benchmark:memory
npm run benchmark:memory -- --quick
npm run benchmark:memory -- --scenario daemon-idle,rpc-idle --quick
```

The default is one warmup and three measured fresh processes per scenario. `--quick` skips the warmup and uses one measured process. Use `--runs`, `--warmup`, and `--settle-ms` for explicit sampling. Each checkpoint waits for the settle interval and then runs two exposed-GC passes before capturing memory.

Write and compare versioned reports with:

```bash
npm run benchmark:memory -- --quick --output ./memory-before.json
npm run benchmark:memory -- --quick --output ./memory-after.json --compare ./memory-before.json
```

Comparison requires identical Node version, platform, architecture, selected scenarios, workload schema, and workload parameters. Compare reports on the same host with the same allocator and otherwise idle system. Git revision/dirty state, Node/V8, OS, CPU, and host memory are recorded for interpretation but do not make results portable between hosts.

### Scenarios and checkpoints

| Scenario | Checkpoints | Lifecycle exercised |
| --- | --- | --- |
| `daemon-idle` | `idle` | Shared source daemon launch, including `--optimize-for-size`, authenticated empty status, Iroh relay-disabled readiness, graceful shutdown |
| `rpc-idle` | `idle` | Successful `get_state` while stdin and the benchmark snapshot channel remain open, then clean EOF shutdown |
| `runtime-idle` | `baseline`, `post-disposal` | Persisted `AgentSessionRuntime` with the faux provider |
| `conversation` | `baseline`, `populated`, `post-disposal` | Schema-v1 fixed conversation: 20 user/assistant turns, exactly 2 KiB of text per message |
| `reconnect-retention` | `baseline`, `detached`, `post-cycle`, `post-disposal` | Real registry attach/detach, ten warm same-runtime reattaches, then detached retirement with a short TTL |
| `extension` | `before-activation`, `active`, `post-disposal` | Generated on-disk TypeScript extension loaded through Jiti, with a registered tool and `session_start` listener |
| `mcp` | `before-activation`, `active`, `post-disposal` | Local stdio MCP connect, list, call, and disconnect through `McpManager` |
| `lsp` | `before-activation`, `active`, `post-disposal` | Benchmark-owned stdio language server queried through the session `lsp` tool |

Workload schema v1 also fixes two GC passes, ten reconnect cycles, one MCP call, one LSP query, and a reconnect-retention TTL of `settle-ms + 1000`. Changing any parameter makes reports comparison-incompatible.

### Output and interpretation

The readable summary reports min, median, average, and max root RSS, used heap, and aggregate process-tree RSS. Stable machine-readable lines use this form for every captured numeric metric:

```text
METRIC scenario=mcp checkpoint=active metric=memory.rssBytes unit=bytes min=... median=... average=... max=...
```

`--output` includes all warmup and measured runs, raw root memory (`rss`, heap total/used, external, and array buffers), V8 heap statistics, active-resource counts, checkpoint timing, lifecycle invariants, process-tree observations, measured-run summaries, workload parameters, and host/runtime/Git metadata. `--compare` prints absolute and percentage median deltas; a zero baseline produces `percent=n/a`.

Process-tree RSS is best effort. Linux and macOS use one `ps` snapshot whose RSS values are normalized from KiB; Windows uses `Get-CimInstance Win32_Process` working-set data. Descendants can exit, reparent, or reuse a PID around a snapshot, and Windows may include shell or console helper processes. If enumeration is unavailable, raw root metrics remain valid and process-tree summaries are omitted.

Every run uses isolated HOME, agent, session, and workspace directories; forces offline/version-check-disabled execution; removes inherited provider credentials; disables external Iroh relays; and cleans the process tree and temporary files on success, failure, or handled termination signals. The benchmark is observational: it is not run in CI, has no committed absolute baseline, and enforces no pass/fail memory threshold.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
