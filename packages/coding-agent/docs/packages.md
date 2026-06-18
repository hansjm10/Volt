> volt can help you create volt packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Volt Packages

Volt packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `volt` key, or use conventional directories.

Volt can also install existing Pi extension packages. When a package has a `pi` manifest but no `volt` manifest, Volt reads the `pi` resources and maps Pi core imports to the Volt APIs at load time.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Volt Package](#creating-a-volt-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Volt packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
volt install npm:@foo/bar@1.0.0
volt install git:github.com/user/repo@v1
volt install https://github.com/user/repo  # raw URLs work too
volt install /absolute/path/to/package
volt install ./relative/path/to/package

volt remove npm:@foo/bar
volt list                     # show installed packages from settings
volt update                   # update volt, update packages, and reconcile pinned git refs
volt update --extensions      # update packages and reconcile pinned git refs only
volt update --self            # update volt only
volt update --self --force    # reinstall volt even if current
volt update npm:@foo/bar      # update one package
volt update --extension npm:@foo/bar
```

These commands manage volt packages, not the volt CLI installation. To uninstall volt itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.volt/agent/settings.json`). Use `-l` to write to project settings (`.volt/settings.json`) instead. Project settings can be shared with your team, and volt installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
volt -e npm:@foo/bar
volt -e git:github.com/user/repo
```

## Package Sources

Volt accepts three source types in settings and `volt install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`volt update`, `volt update --extensions`).
- User installs go under `~/.volt/agent/npm/`.
- Project installs go under `.volt/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `volt update` and `volt update --extensions` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `volt install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.volt/agent/git/<host>/<path>` (global) or `.volt/git/<host>/<path>` (project).
- When reconciliation changes the checkout, volt resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
volt install git:git@github.com:user/repo

# ssh:// protocol format
volt install ssh://git@github.com/user/repo

# With version ref
volt install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, volt loads resources using package rules.

## Creating a Volt Package

Add a `volt` manifest to `package.json` or use conventional directories. Include the `volt-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["volt-package"],
  "volt": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Package Metadata

Packages can include `video` or `image` fields for tools that render package previews:

```json
{
  "name": "my-package",
  "keywords": ["volt-package"],
  "volt": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `volt` or compatible `pi` manifest is present, volt auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When volt installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Volt bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/volt-ai`, `@earendil-works/volt-agent-core`, `@earendil-works/volt-coding-agent`, `@earendil-works/volt-tui`, `typebox`.

For Pi compatibility, Volt aliases `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and the legacy `@mariozechner/pi-*` package names to the corresponding Volt modules when loading extensions.

Other volt packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Volt loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "volt": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `volt config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. Works for both global (`~/.volt/agent`) and project (`.volt/`) scopes.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
