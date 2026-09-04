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

The script can be run from any directory. Volt keeps the caller's current working directory. `volt-test.sh` and `volt-test.ps1` enable private review diagnostics for source-development runs. Exact model-reported limitations and bounded failed-tool output are written as one owner-only JSONL file per affected review under `~/.volt/agent/review-diagnostics/` (or the configured agent directory). These records are untrusted and may contain sensitive GitHub context. They are not added to sessions, RPC responses, exports, or model context, and only the 20 newest files are retained.

Set `VOLT_REVIEW_PRIVATE_DIAGNOSTICS=0` before launching either script to disable these records.

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

## Session discovery benchmark

Run the observational SQLite listing/open/search benchmark from the repository root:

```bash
npm --prefix packages/coding-agent run benchmark:sessions
```

It reports elapsed time, main-thread heap delta, and sampled process-wide peak RSS delta for cold/warm cross-store listing, cold/warm exact open, and token/phrase/regex deep search. Scale dimensions independently with `VOLT_BENCH_SESSION_COUNT` (total), `VOLT_BENCH_STORE_COUNT`, `VOLT_BENCH_SESSION_SUMMARY_BYTES`, `VOLT_BENCH_SESSION_NON_SEARCHABLE_BYTES`, `VOLT_BENCH_SESSION_SEARCHABLE_BYTES`, `VOLT_BENCH_QUERY_TOKEN_COUNT`, `VOLT_BENCH_QUERY_TOKEN_BYTES`, `VOLT_BENCH_QUERY_PHRASE_COUNT`, `VOLT_BENCH_QUERY_PHRASE_BYTES`, and `VOLT_BENCH_QUERY_REGEX_BYTES`. The command rejects query terms that do not fit the requested per-session searchable payload instead of silently increasing it.

Listing and exact lookup should remain independent of non-searchable transcript payload. Deep-search time still depends on total searchable text and query shape; stores are searched sequentially, and each worker accumulates at most its largest one-session document rather than all searchable text in that store. Process RSS sampling includes worker threads but is host-dependent, observational, and has no pass/fail threshold.

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

## SWE-bench Verified smoke benchmark

The repository-only SWE-bench runner exercises one Verified instance sequentially with an extracted Linux x64 Volt standalone distribution. It requires Linux x64, Docker, Python, at least 16 GB RAM, and roughly 120 GB of free disk for official task images and evaluator artifacts.

Create the ignored Python environment and install the official harness at the commit pinned in `scripts/requirements-swebench.txt`:

```bash
python3 -m venv .venv-swebench
. .venv-swebench/bin/activate
python -m pip install -r scripts/requirements-swebench.txt
```

Build the native standalone distribution on Linux x64, or extract an existing Linux x64 standalone archive:

```bash
npm --prefix packages/coding-agent run build:binary
```

Log in to the `openai-codex` provider with Volt before running the benchmark. The runner reads `~/.volt/agent/auth.json` by default, copies only its `openai-codex` OAuth entry into a private temporary writable agent directory, and deletes that directory after generation. It never updates the source credential. The temporary credential is readable by code in the disposable task container, network egress is not restricted, and v1 must not be run concurrently with the same credential.

From the repository root, run the default `sympy__sympy-20590` smoke task with an exact Codex model:

```bash
npm run benchmark:swebench -- \
  --volt-dir packages/coding-agent/binaries/linux-x64 \
  --model openai-codex/gpt-5.6-sol \
  --thinking high
```

Use `--instance`, `--thinking`, `--timeout-seconds`, `--auth-file`, `--python`, or `--output-dir` to override defaults. Volt receives only the task's `problem_statement`; the runner does not include gold patches, test patches, or evaluation test names in the prompt. It records the clean initial image HEAD, stages tracked and non-ignored untracked changes after Volt exits, and captures a binary diff from that initial HEAD so model-created commits are included.

Artifacts are written under ignored `swebench-output/<run-id>/`: the prompt, `patch.diff`, redacted Volt stdout/stderr, one official `predictions.jsonl` record, evaluator stdout/stderr, and the official report directory. The official evaluator runs one worker for only the selected instance. Both resolved and unresolved reports are valid benchmark outcomes; infrastructure, authentication, timeout, malformed-output, missing-report, and cleanup failures exit nonzero.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
