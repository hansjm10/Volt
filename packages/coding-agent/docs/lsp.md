# LSP Diagnostics & Navigation

Volt can run language servers and feed diagnostics back to the model after every `edit` and `write`. When enabled, the tool result includes a `Diagnostics:` block with errors reported by the matching language server, so the model sees type and compile errors immediately instead of discovering them at build time.

When LSP is enabled, the model also gets an `lsp` tool for code navigation: go-to-definition, find-references, hover, file symbol outlines, and on-demand diagnostics.

## Enabling

Diagnostics are off by default. Enable them per run:

```bash
volt --lsp
```

Or persistently in `~/.volt/agent/settings.json` (or per project in `.volt/settings.json`):

```json
{
  "lsp": {
    "enabled": true
  }
}
```

## How It Works

- Servers are spawned lazily: the first `edit`/`write` to a file with a matching extension starts the server for that file's project root.
- The project root is found by walking up from the edited file looking for the server's `rootMarkers` (falling back to the working directory). Markers are priority-ordered: for TypeScript, a `tsconfig.json` anywhere up the tree wins over a closer `package.json`, so monorepo subpackages resolve to the directory carrying the language configuration.
- After each successful `edit`/`write`, volt syncs the new file content to the server and collects diagnostics, using pull diagnostics (`textDocument/diagnostic`) when the server supports them, otherwise waiting up to `settleMs` for the server to publish.
- Diagnostics at or above the configured `severity` are appended to the tool result and shown in the TUI.
- One client runs per (server, project root) pair. Servers shut down when the session ends or reloads.
- A server that fails to start (for example, not installed) is reported once in the tool result and then silenced; after three failed starts it is disabled for the session.

Diagnostics are best-effort: server failures or timeouts never fail the edit itself.

## The lsp Tool

When LSP is enabled, the `lsp` tool is active by default (it still respects `--tools` and `--exclude-tools`). Actions:

| Action | Parameters | Description |
|--------|------------|-------------|
| `definition` | `path`, `symbol`, `line?` | Where a symbol is defined, with a source snippet |
| `references` | `path`, `symbol`, `line?` | All usages of a symbol across the project (capped at 50) |
| `hover` | `path`, `symbol`, `line?` | Type signature and documentation for a symbol |
| `symbols` | `path` | Hierarchical symbol outline of a file |
| `diagnostics` | `path` | Current diagnostics for a file, on demand |

The symbol is located by name: volt finds its position in the file (preferring a word-boundary match on the hinted `line`) and issues the positional LSP request. Errors such as a missing server or symbol are returned as text so the model can react.

## Built-in Servers

The matching server must be installed and on your `PATH`. Built-in defaults:

| Name | Command | Extensions | Root markers |
|------|---------|------------|--------------|
| `typescript` | `typescript-language-server --stdio` | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `python` | `pyright-langserver --stdio` | `.py` `.pyi` | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `requirements.txt` |
| `go` | `gopls` | `.go` | `go.mod`, `go.work` |
| `rust` | `rust-analyzer` | `.rs` | `Cargo.toml` |

## Configuration

All settings live under `lsp` in `settings.json`:

```json
{
  "lsp": {
    "enabled": true,
    "settleMs": 1500,
    "maxDiagnostics": 20,
    "severity": "error",
    "servers": {
      "typescript": {
        "command": ["bunx", "typescript-language-server", "--stdio"]
      },
      "rust": {
        "enabled": false
      },
      "zig": {
        "command": ["zls"],
        "fileExtensions": [".zig"],
        "rootMarkers": ["build.zig"]
      }
    }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch (also `--lsp` per run) |
| `settleMs` | number | `1500` | How long to wait for published diagnostics after a change (servers without pull diagnostics) |
| `maxDiagnostics` | number | `20` | Maximum diagnostics per tool call; the rest are summarized as `... and N more` |
| `severity` | string | `"error"` | Minimum severity to report: `error`, `warning`, `information`, or `hint` |
| `servers.<name>` | object | | Server definition, merged over the built-in default with the same name |

Per-server fields:

| Field | Type | Description |
|-------|------|-------------|
| `command` | string[] | Launch command, argv-style |
| `fileExtensions` | string[] | File extensions routed to this server |
| `rootMarkers` | string[] | Files/directories marking the project root, searched upward from the edited file |
| `initializationOptions` | any | Passed to the server in the `initialize` request |
| `enabled` | boolean | Set `false` to disable a built-in server |

User entries merge field-wise over built-in defaults: overriding only `command` for `typescript` keeps the default extensions and root markers.

## Limitations

- Only files changed through the `edit` and `write` tools are synced to servers. Changes made via `bash` (e.g. `git checkout`) are not pushed, so cross-file diagnostics can be stale until the affected files are edited again.
- Some servers index the project after startup; diagnostics for the first edit may be incomplete if the server has not finished loading. Servers that support pull diagnostics (e.g. typescript-language-server 4+) are more reliable here.
- Diagnostics are collected only for the edited file, not for other files the change may affect.
