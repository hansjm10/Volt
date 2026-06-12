# LSP Diagnostics & Navigation

Volt can run language servers and feed diagnostics back to the model after every `edit` and `write`. When enabled, the tool result includes a `Diagnostics:` block with errors reported by the matching language server, so the model sees type and compile errors immediately instead of discovering them at build time.

When LSP is enabled, the model also gets an `lsp` tool for code navigation and refactoring: go-to-definition, find-references, hover, file symbol outlines, on-demand diagnostics, project-wide rename, and quick fixes (e.g. auto-import).

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
- After each successful `edit`/`write`, volt syncs the new file content to the server and collects diagnostics, using pull diagnostics (`textDocument/diagnostic`) when the server supports them, otherwise waiting up to `settleMs` for the server to publish. The first collection on a freshly started server waits up to `firstSettleMs` instead, because servers like tsserver publish nothing until the project has loaded.
- Before every diagnostics collection or navigation query, volt re-syncs any previously opened file whose on-disk content changed outside the `edit`/`write` tools (e.g. via `bash`: `git checkout`, codegen). Deleted files are closed on the server, and servers are notified via `workspace/didChangeWatchedFiles`.
- Diagnostics at or above the configured `severity` are appended to the tool result and shown in the TUI. Other open files that go from clean to failing as a result of the change are reported in a `Newly failing in other open files` section (capped at 5 files; best-effort, depends on the server republishing within the settle window).
- One client runs per (server, project root) pair. Servers shut down when the session ends or reloads, and after `idleShutdownMs` without use (they respawn lazily on the next operation).
- `/lsp` shows the status of running servers (root, open documents, idle time); `/lsp restart` stops them all so they respawn fresh on next use.
- A server that fails to start (for example, not installed) is reported once in the tool result and then silenced; after three failed starts it is disabled for the session.

Diagnostics are best-effort: server failures or timeouts never fail the edit itself.

## The lsp Tool

When LSP is enabled, the `lsp` tool is active by default (it still respects `--tools` and `--exclude-tools`). Actions:

| Action | Parameters | Description |
|--------|------------|-------------|
| `definition` | `path`, `symbol`, `line?` | Where a symbol is defined, with a source snippet |
| `references` | `path`, `symbol`, `line?` | All usages of a symbol across the project (capped at 50) |
| `implementations` | `path`, `symbol`, `line?` | Implementations of an interface or abstract symbol |
| `type-definition` | `path`, `symbol`, `line?` | Where a symbol's type is defined |
| `callers` | `path`, `symbol`, `line?` | Functions that call the symbol (call hierarchy, one level) |
| `callees` | `path`, `symbol`, `line?` | Functions the symbol calls (call hierarchy, one level) |
| `hover` | `path`, `symbol`, `line?` | Type signature and documentation for a symbol |
| `symbols` | `path`, `symbol?` | Hierarchical symbol outline of a file; with `symbol`, a project-wide symbol search (the `path` routes the query to the right server) |
| `diagnostics` | `path` | Current diagnostics for a file, on demand |
| `rename` | `path`, `symbol`, `newName`, `line?` | Rename a symbol across the project (applies the server's WorkspaceEdit to disk) |
| `fix` | `path`, `symbol?` or `line?`, `title?`, `kind?` | Apply a quick fix (e.g. add a missing import). A single available action applies automatically; multiple actions are listed and chosen via `title`. `kind` filters by code-action kind, e.g. `source.organizeImports` or `source.fixAll` over the whole file |

The symbol is located by name: volt finds its position in the file (preferring a word-boundary match on the hinted `line`) and issues the positional LSP request. Errors such as a missing server or symbol are returned as text so the model can react.

`rename` and `fix` write the server's `WorkspaceEdit` to disk (including create/rename/delete file operations), re-sync changed open documents, and report a per-file summary. Command-based code actions are executed via `workspace/executeCommand` with server-initiated `workspace/applyEdit` requests applied the same way.

## Built-in Servers

The matching server must be installed and on your `PATH`. Built-in defaults:

| Name | Command | Extensions | Root markers |
|------|---------|------------|--------------|
| `typescript` | `typescript-language-server --stdio` | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `python` | `pyright-langserver --stdio` | `.py` `.pyi` | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `requirements.txt` |
| `go` | `gopls` | `.go` | `go.mod`, `go.work` |
| `rust` | `rust-analyzer` | `.rs` | `Cargo.toml` |
| `cpp` | `clangd` | `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` `.hh` | `compile_commands.json`, `compile_flags.txt`, `.clangd` |
| `zig` | `zls` | `.zig` | `build.zig` |
| `lua` | `lua-language-server` | `.lua` | `.luarc.json`, `.luarc.jsonc` |
| `bash` | `bash-language-server start` | `.sh` `.bash` | (working directory) |

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
| `firstSettleMs` | number | `10000` | Wait window for the first diagnostics from a freshly started server (project load time) |
| `idleShutdownMs` | number | `600000` | Shut down servers idle for this long (10 minutes); `0` disables idle shutdown |
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
| `settings` | object | Server configuration: sent via `workspace/didChangeConfiguration` after startup and used to answer `workspace/configuration` section requests (dot-separated section paths look up into this object) |
| `enabled` | boolean | Set `false` to disable a built-in server |

Example: tuning pyright through `settings`:

```json
{
  "lsp": {
    "servers": {
      "python": {
        "settings": {
          "python": { "analysis": { "typeCheckingMode": "strict" } }
        }
      }
    }
  }
}
```

User entries merge field-wise over built-in defaults: overriding only `command` for `typescript` keeps the default extensions and root markers.

## Limitations

- Disk changes are only detected for files the server has already seen (opened by an earlier edit, write, or `lsp` query). Files created or changed via `bash` that were never touched by a tool are unknown to the server until first opened.
- Diagnostics are collected only for the edited file, not for other files the change may affect.
- On very large projects the first collection can still miss diagnostics if project loading exceeds `firstSettleMs`; raise it in settings if needed.
