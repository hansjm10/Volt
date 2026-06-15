# Volt Terminal-Bench Harbor

Run Volt on Terminal-Bench through Harbor.

## Requirements

Install Harbor and Docker on the host:

```bash
uv tool install harbor
docker --version
```

Configure provider credentials for the model you want to benchmark. To reuse Volt's stored auth, pass:

```bash
--agent-kwarg force_auth_json=true
```

For API-key providers, pass credentials to Harbor with `--agent-env`, for example `--agent-env OPENAI_API_KEY=$OPENAI_API_KEY`.

To make the Harbor-run Volt process inherit your local Volt settings and installed extension packages, pass:

```bash
--agent-kwarg inherit_agent_dir=true
--agent-kwarg project_volt_dir=/path/to/project/.volt
```

The `/tbench smoke` TUI helper passes these automatically, including the current project's `.volt` directory when one exists.

By default the Harbor wrapper clones and builds Volt from `https://github.com/hansjm10/Volt.git`. Override the source with agent kwargs:

```bash
--agent-kwarg source_url=https://github.com/hansjm10/Volt.git
--agent-kwarg source_ref=main
```

If a packaged Volt CLI is available from npm, use the faster install path:

```bash
--agent-kwarg install_spec=@earendil-works/volt-coding-agent@0.79.1
```

## Usage

Install from the Volt store once this package is in the remote catalog:

```bash
volt store install terminal-bench-harbor
```

Then use `/tbench` inside Volt:

```text
/tbench doctor
/tbench command openai-codex/gpt-5.5
/tbench oracle
/tbench smoke openai-codex/gpt-5.5
```

You can also run Harbor directly from this package root:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path volt_tbench_harbor.agent:VoltAgent \
  -m openai-codex/gpt-5.5 \
  --agent-kwarg force_auth_json=true \
  --agent-kwarg inherit_agent_dir=true \
  --agent-kwarg project_volt_dir=/path/to/project/.volt \
  --agent-kwarg tools= \
  --agent-kwarg exclude_tools= \
  --agent-kwarg source_ref=main \
  -l 1 \
  -n 1 \
  --yes
```

Use `-l 1` for smoke runs. Remove it for a full benchmark run.

The adapter reads Volt's session JSONL after each run and copies token and cost totals into Harbor's `agent_result`.
