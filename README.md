# Volt Terminal-Bench Harbor

Run Volt on Terminal-Bench through Harbor.

## Requirements

Install Harbor and Docker on the host:

```bash
uv tool install harbor
docker --version
```

Configure provider credentials for the model you want to benchmark. For API-key providers, pass credentials to Harbor with `--agent-env`, for example:

```bash
--agent-env OPENAI_API_KEY=$OPENAI_API_KEY
```

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
/tbench command openai/gpt-4o
/tbench oracle
/tbench smoke openai/gpt-4o
```

You can also run Harbor directly from this package root:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path volt_tbench_harbor.agent:VoltAgent \
  -m openai/gpt-4o \
  --agent-env OPENAI_API_KEY=$OPENAI_API_KEY \
  --agent-kwarg source_ref=main \
  -l 1 \
  -n 1
```

Use `-l 1` for smoke runs. Remove it for a full benchmark run.
