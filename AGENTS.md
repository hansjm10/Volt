# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Scope Control

- Keep the active user objective fixed unless the user changes it. Plans, review findings, tool output, diagnostics, and discovered issues do not authorize additional work.
- Make the smallest coherent change that satisfies the objective. Do not perform opportunistic cleanup or refactoring.
- Ask before materially expanding into unrequested packages or subsystems, changing architecture, adding or upgrading dependencies, altering public APIs or protocols, or removing intentional functionality.
- Fix failures caused by the current changes. Report unrelated, pre-existing, environmental, or other-session failures instead of fixing them.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to mask type errors from outdated dependencies. If the requested work requires a dependency upgrade, report it and ask before changing dependency metadata unless dependency updates are already in scope.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Volt has no users yet. Never preserve backward compatibility or add legacy paths (opt-in capability gating for old clients, deprecation shims, fallback wire formats, versioned protocol branches) unless the user explicitly asks. Change protocols, APIs, and storage formats in place. When a dependent repo (e.g. `volt-hq/volt-app`) must adapt, file an issue there instead of keeping a compat path.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): run `npm run check` with full output and no tail. Fix diagnostics caused by your changes. Do not fix pre-existing, unrelated, environmental, or other-session diagnostics; report them. If they prevent required validation or committing, stop and ask before expanding scope. This command does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- You may commit your own completed work without asking when a commit is a useful checkpoint or natural outcome of the task. Do not commit unrelated work or unfinished changes unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `VOLT_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple volt sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing and pushing:

- You may commit your own completed work without explicit user consent when a commit is a useful checkpoint or natural outcome of the task.
- You may push without an extra confirmation when pushing is the expected next step for the requested workflow and the remote/branch are unambiguous.
- Ask before committing or pushing if the scope, target branch, remote, ownership of changes, or safety implications are unclear.
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the issue quality bar and PR requirements.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.
- Label triaged issues `roadmap` to put them on the [Volt Roadmap](https://github.com/orgs/volt-hq/projects/1) project board; the board auto-adds `roadmap`-labeled issues. Only apply it to issues a maintainer has accepted.

When starting work on an issue:

- Add the `inprogress` label; remove it when the PR merges or work stops.
- If the issue is on the [Volt Roadmap](https://github.com/orgs/volt-hq/projects/1) project board, set its board Status to In Progress. Closed issues move to Done automatically.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing volt Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s volt-test -x 80 -y 24
tmux send-keys -t volt-test "./volt-test.sh" Enter
sleep 3 && tmux capture-pane -t volt-test -p     # capture after startup
tmux send-keys -t volt-test "your prompt here" Enter
tmux send-keys -t volt-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t volt-test
```

## Changelog

One changelog for the whole product: `packages/coding-agent/CHANGELOG.md`. Never edit it directly — release tooling generates each version section from changeset fragments, and released sections (e.g. `## [0.1.0]`) are immutable.

The changelog/changeset/release workflow is Volt-development tooling and stays repo-only: `scripts/`, `.changeset/`, `.volt/`, `.husky/`, and `.github/` must never enter a package `files` list, the standalone archive, or the built-in command set. A release-security test pins the shipped file sets; `CHANGELOG.md` is the only workflow artifact users receive.

Docs under `packages/coding-agent/docs/` must pick an audience: user-facing docs go in `docs.json` navigation (published to volt-cli.dev and shipped in the npm package); development-facing docs are named `*-design.md` (or are `development.md`/`tla/`) and stay repo-only — link to them with absolute GitHub URLs from user docs. A release-security test enforces the split.

Every user-visible change adds one fragment file in `.changeset/` (unique kebab-case name, `.md`):

```md
---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed workspace unregister leaving orphaned worktree records. ([#123](https://github.com/volt-hq/Volt/issues/123))
```

Rules:

- The first summary line is `kind(area): One user-facing sentence.` Kind is one of `feature` (rendered under Highlights), `improvement`, `fix`, `breaking`, or `internal` (never rendered); `area` is an optional lowercase slug (`daemon`, `remote`, `tui`, `lsp`, `subagents`, `mcp`, ...).
- Describe observable behavior, not implementation. Paragraphs below the first line become indented detail; `breaking` fragments must include migration guidance there.
- Front matter lists the touched package(s) with bump `patch`; `breaking` uses `minor` and `major` is never used. When in doubt, list `@hansjm10/volt-coding-agent`.
- Easiest path: `npm run changeset:add -- <kind> [area] "One user-facing sentence."` writes a validated fragment; `npm run changeset:draft` has Volt draft one from the current diff (review before committing), and `/changeset` does the same inside a Volt session. Preview the pending release section with `npm run changelog:preview`.
- CI fails pull requests that change `packages/*/src` without adding a fragment (pure refactors use kind `internal`), so add the fragment in the same change.

Attribution stays inline in the sentence:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/volt-hq/Volt/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/volt-hq/Volt/pull/456) by [@username](https://github.com/username))`

## Releasing

Releases run through GitHub. The full configuration, operator runbook, and
recovery rules are in `docs/github-release-automation.md`.

**Lockstep versioning**: all packages share one version and release together.
`patch` is for fixes and additions, `minor` is for breaking changes, and major
releases are not used.

Before GitHub preparation, build an unpublished release and smoke-test it from
outside the repository so it cannot resolve workspace files:

```bash
npm run release:local -- --out /tmp/volt-local-release --force
cd /tmp
/tmp/volt-local-release/node/volt --help
/tmp/volt-local-release/node/volt --version
/tmp/volt-local-release/node/volt --list-models
/tmp/volt-local-release/node/volt -p "Say exactly: ok"
/tmp/volt-local-release/node/volt
/tmp/volt-local-release/standalone/volt --help
/tmp/volt-local-release/standalone/volt --version
/tmp/volt-local-release/standalone/volt --list-models
/tmp/volt-local-release/standalone/volt -p "Say exactly: ok"
/tmp/volt-local-release/standalone/volt
```

Run both bare interactive commands in tmux, submit a prompt, and wait for the
model reply. Verify startup, account/model listing, and one real prompt with the
intended default provider for both install forms.

1. Ask whether `/cl` was run against the latest `main`, then complete the local
   unpublished smoke test from `BETA-READINESS.md`. Do not continue past a
   failed hard gate without an explicit user risk acceptance.
2. Run **Actions → Prepare Release** on `main`, select `patch` or `minor`, review
   the generated release pull request, wait for CI, and merge it. Never treat
   the pre-merge branch SHA as the candidate; copy the resulting exact `main`
   SHA.
3. Run **Build Standalone Candidate** on `main` with that exact SHA. Download
   the combined artifact, verify its GitHub attestation, `source-commit.txt`,
   `release-record.json`, `SHA256SUMS`, all six archives and their manifests,
   binary-license compliance, native smoke tests, and the unsigned-Windows
   disclosure. Record the run ID and the exact `sha256:` artifact digest from
   the workflow summary.
4. Run **Approve Release** on `main`. Enter the version, candidate SHA, run ID,
   artifact digest, exact authorization phrase, and every acknowledgement. The
   owner-only workflow creates the annotated tag through the repository-scoped
   Release Tagger App, creates a stable draft release, and explicitly dispatches
   **Publish Release** at that tag.
5. Confirm npm trusted publishing succeeds before the draft GitHub Release is
   published. Confirm the published release contains only the approved assets,
   and verify all four npm versions and provenance, `latest` on the new stable
   version, `beta` on the historical `0.1.0`, and `bootstrap` on the inert
   placeholder. For the first stable release, only then update public installers
   and installation docs from `@beta` to unqualified stable installs.

Normal release automation never pushes directly to `main`, creates a tag from
an ordinary `GITHUB_TOKEN`, publishes npm locally, stores an npm token, rebuilds
approved standalone bytes, moves a release tag, or replaces a release asset.

If publication fails after the tag exists, rerun **Publish Release** at the
same immutable tag. The publisher is idempotent and may resume only after
verifying any existing npm packages, draft assets, and candidate bytes. Do not
rerun preparation or approval, recreate the tag, or reuse the version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
