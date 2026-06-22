<goal name="iroh-host-detach-cancel-semantics">

<context>
This file is the operating manual and work ledger for a Volt /goal run that
decouples remote Iroh client transport lifetime from host prompt/run lifetime.
The paired design document is `.volt/iroh-host-detach-cancel-design.md`; treat
that file as the SPEC and this file as the TURN LEDGER. Update both files when a
queue item is resolved or when implementation reveals a necessary design change.

Suggested goal prompt:
/goal Work through .volt/iroh-host-detach-cancel-goal.md, exactly one queue item
per goal turn, following the protocol in that file. Do not mark the goal complete
until every item in its work_queue has status="resolved". Commit only files
changed for the selected item, by explicit path, when committing is safe under
the repo rules; if commit ownership or target repo is unclear, stop before
committing and list the exact paths ready to stage.
</context>

<turn_definition>
A turn is one agent run from start until the final response is sent and the agent
becomes idle. Exactly ONE selectable work_queue item is worked per turn. If the
selected item finishes quickly, still stop after updating ledgers and committing
(or stopping before commit when commit safety is unclear). Do not start another
item in the same turn.
</turn_definition>

<protocol>
  <step n="1" name="preflight">
    Run `git status --short` in `/Users/jordan.hans/Projects/Volt` and
    `git -C ../volt-app status --short`. Confirm dirty files are either:
    baseline out-of-scope files listed in working_tree_rules, the paired docs for
    this goal, or in-progress files from a prior partial turn on the item you are
    about to re-select. If any other surprise dirty file exists, do not select an
    item: report the unexpected state and stop the turn.
  </step>

  <step n="2" name="select">
    Read the work_queue below. Select the FIRST item with status="open" whose
    prereq items, if any, all have status="resolved". Treat status="blocked" as
    not selectable. Items with type="rollup" are never selected directly; see
    rollup_rule. Work only the selected item this turn.
  </step>

  <step n="3" name="read_spec">
    Read `.volt/iroh-host-detach-cancel-design.md` and the selected item's
    relevant sections in full. Also read the current implementation files that
    own the behavior before editing them. Expected areas include:

    - `packages/coding-agent/src/remote/iroh-host.mjs`
    - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
    - `packages/coding-agent/src/modes/rpc/iroh-remote-rpc-mode.ts`
    - `packages/coding-agent/src/core/rpc/transport.ts`
    - `packages/coding-agent/src/core/rpc/iroh-transport.ts`
    - `packages/coding-agent/src/core/remote/iroh/`
    - `packages/coding-agent/src/core/agent-session.ts`
    - `packages/coding-agent/src/core/agent-session-runtime.ts`
    - `packages/coding-agent/docs/rpc.md`
    - `packages/coding-agent/docs/iroh-remote-protocol.md`
    - `packages/coding-agent/test/rpc-mode-transport.test.ts`
    - `packages/coding-agent/test/remote-iroh-core.test.ts`
    - `scripts/iroh-sidecar-test.mjs`

    Use LSP tools per &lt;lsp_usage/&gt; for semantic TypeScript questions before
    changing shared symbols. Use text search for `.mjs`, `.cjs`, Markdown, shell
    scripts, and other files without language server coverage.
  </step>

  <step n="4" name="implement">
    Implement the SPEC behavior faithfully for the selected item and add or
    extend tests that would have failed before the change and pass after it.
    Preserve the remote security boundary: do not expose raw `get_messages` over
    Iroh, do not return session file paths, keep transcript loading scoped to the
    active authorized workspace/session, and bound large transcript fields.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then
    run the commands in &lt;verification/&gt;. All required checks for changed files
    must pass before the item may be marked resolved. If native Iroh behavior,
    iOS hardware, credentials, or a manual environment is unavailable, follow
    blocked_rule or partial_progress_rule instead of overclaiming.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/iroh-host-detach-cancel-design.md`: update the relevant section with
    `Resolved YYYY-MM-DD:` plus the concrete behavior when an item is resolved.
    Do not silently delete unresolved requirements; if the selected item reveals
    new scope, add a new open item instead.

    This file: set the selected item status="resolved" and fill its
    &lt;evidence&gt; with one concise line containing what changed, what verification
    ran, and the commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If committing is safe under the repo rules, stage only files changed for the
    selected item, by explicit path. Never use `git add -A` or `git add .`.

    Suggested commit message formats:
    code fix: `fix(coding-agent): preserve remote runs across detach &lt;ref&gt;`
    docs-only: `docs(coding-agent): record remote detach semantics &lt;ref&gt;`
    partial progress: `fix(coding-agent): remote detach semantics &lt;ref&gt; partial`

    If not committing, leave the item status open unless the user explicitly
    accepts non-committed ledger updates; report the exact paths ready to stage
    and stop.
  </step>

  <step n="8" name="stop">
    Summarize what changed and what verification ran, then end the turn.
  </step>
</protocol>

<verification>
  <when_changed kind="volt_code">npm run check</when_changed>
  <when_changed path="packages/coding-agent/test packages/coding-agent/src">cd packages/coding-agent; node node_modules/vitest/dist/cli.js --run &lt;specific changed or affected test files&gt;</when_changed>
  <when_changed path="packages/coding-agent/src/core/remote/iroh packages/coding-agent/src/core/rpc/iroh-transport.ts packages/coding-agent/src/modes/rpc packages/coding-agent/src/remote/iroh-host.mjs scripts/iroh-sidecar-*.mjs">npm run iroh:poc:test</when_changed>
  <when_changed path="packages/coding-agent/docs .volt">git diff --check -- &lt;changed docs paths&gt;</when_changed>
  <manual when="manual_ios_detach_validation">Deploy to iPhone, connect to an integrated Volt host, start a long-running prompt, background until disconnect, verify host continuation, reconnect, then send explicit cancel on a second prompt. Record device, iOS version, macOS version, relay mode, network, commands, and result.</manual>
  <notes>
    `npm run check` is required after Volt code changes and must be run from the
    Volt repo root. If a test file is created or modified, run the specific test
    file and iterate until it passes before broader checks. Use native Iroh
    scenario evidence for connection lifecycle behavior. Manual iOS validation is
    required only for the final validation item unless a selected item explicitly
    changes iOS-facing protocol behavior.
  </notes>
</verification>

<lsp_usage>
Volt has LSP tools available through the `lsp` tool with actions such as
`definition`, `references`, `hover`, `symbols`, `diagnostics`, `rename`, and
`fix`. Prefer LSP over grep/read whenever the question is semantic: who calls
this, where is this symbol defined, what type is this, or what breaks if this
signature changes.

Per-turn usage:

- Use `lsp.symbols` to locate relevant TypeScript symbols when the file is not
  obvious.
- Before changing a shared TS symbol's behavior or signature, call
  `lsp.references`; every caller is potentially a behavior or test surface that
  must be considered in the same turn.
- For renames, use `lsp.rename`, not find-and-replace.
- After editing, run `lsp.diagnostics` on each changed TS/TSX file.
- `.mjs`, `.cjs`, Markdown, shell scripts, and Swift files may not have semantic
  LSP coverage; read/search those files directly and mention that fallback in
  evidence when relevant.
</lsp_usage>

<working_tree_rules>
This setup turn may leave `.volt/iroh-host-detach-cancel-design.md` and
`.volt/iroh-host-detach-cancel-goal.md` uncommitted until the user decides
whether to commit planning documents.

At setup time on 2026-06-22, this worktree already contained unrelated
transcript-resume changes. Treat these baseline paths as out-of-scope unless the
selected detach/cancel item intentionally edits the same path:

- `.volt/ios-remote-transcript-resume-design.md`
- `.volt/ios-remote-transcript-resume-goal.md`
- `package-lock.json`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/docs/iroh-remote-access-design.md`
- `packages/coding-agent/docs/iroh-remote-protocol.md`
- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/docs/security.md`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/npm-shrinkwrap.json`
- `packages/coding-agent/package.json`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/remote/iroh/index.ts`
- `packages/coding-agent/src/core/remote/iroh/protocol.ts`
- `packages/coding-agent/src/core/remote/iroh/qr.ts`
- `packages/coding-agent/src/core/remote/iroh/rpc-command-filter.ts`
- `packages/coding-agent/src/core/rpc/index.ts`
- `packages/coding-agent/src/core/rpc/transcript.ts`
- `packages/coding-agent/src/core/rpc/types.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/modes/index.ts`
- `packages/coding-agent/src/modes/rpc/iroh-remote-rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/remote/iroh-host.mjs`
- `packages/coding-agent/src/types/qrcode-terminal.d.ts`
- `packages/coding-agent/test/remote-iroh-core.test.ts`
- `packages/coding-agent/test/rpc-mode-transport.test.ts`
- `packages/coding-agent/test/rpc-transcript.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`

Multiple Volt sessions may share the same worktree. Never stage or commit files
you did not modify for the selected item. If you need to edit a baseline-dirty
path, inspect its existing diff first and make only the selected item's changes.
</working_tree_rules>

<partial_progress_rule>
If the selected item is too large to finish in one turn but coherent progress is
possible, this is not a block. Work only that item, keep it status="open", add a
`&lt;progress date="YYYY-MM-DD"&gt;` child describing what changed and what remains,
run verification required for the files changed, and commit only coherent
completed progress if committing is safe. The next turn will re-select this same
item because it remains the first selectable open item.
</partial_progress_rule>

<rollup_rule>
Items with type="rollup" are never selected directly. When a turn resolves the
final prerequisite of a rollup item, mark the rollup resolved in this file and
update the design doc checklist during that same turn. Do not spend a separate
turn on a rollup item.
</rollup_rule>

<blocked_rule>
If the selected item cannot proceed at all, or its remaining portion cannot
proceed because required evidence, credentials, a supported platform, a simulator,
native Iroh support, iOS hardware access, or a human product decision is
unavailable:

1. Do whatever portion is achievable without the blocker, following
   partial_progress_rule.
2. Add a `Blocked YYYY-MM-DD:` note to
   `.volt/iroh-host-detach-cancel-design.md` under the relevant section and set
   this file's item status="blocked" with a `&lt;blocker&gt;` child explaining what
   is needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and the final turn's required verification passed.
</completion_rule>

<work_queue>

<group n="1" title="Contract and lifecycle shape">
  <item ref="A.1" status="resolved" prereq="">
    <title>Document and enforce the remote lifecycle contract: transport close is detach, explicit abort is cancel</title>
    <acceptance>RPC and Iroh protocol docs define detach versus cancel; `abort` remains the only remote cancellation command; transport close is not documented or implemented as implicit cancel; existing remote command allowlist and transcript security constraints remain intact; targeted tests cover the command contract where practical.</acceptance>
    <evidence>Resolved 2026-06-22: added RPC/Iroh detach-vs-cancel docs, exported the remote cancellation command set as `abort` only, added lifecycle contract tests for cancel-like rejections and clean close not synthesizing `abort`, and fixed the sidecar harness safe allowlist default for noninteractive native scenarios; verification: `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-lifecycle-contract.test.ts test/remote-iroh-core.test.ts`, `npm run iroh:poc:test`, `npm run check`; commit 9ba8888d</evidence>
  </item>

  <item ref="A.2" status="resolved" prereq="A.1">
    <title>Add host runtime/subscriber lifecycle state for integrated Iroh runtimes</title>
    <acceptance>The integrated host has a runtime registry keyed by authoritative client node ID and workspace; a runtime can have zero or more subscribers; clean stream close detaches the subscriber without disposing the runtime; reconnect attaches to the existing runtime when authorized; audit/logging records attach, detach, reattach, and runtime stop transitions.</acceptance>
    <evidence>Resolved 2026-06-22: added integrated host runtime registry keyed by authoritative client node ID/workspace, subscriber attach/detach state, reattach to existing runtime, host-shutdown runtime disposal, `disposeRuntimeOnClose: false` RPC mode support, and audit events for runtime/subscriber lifecycle transitions; verification: `node --check packages/coding-agent/src/remote/iroh-host.mjs`, `node --check scripts/iroh-sidecar-test.mjs`, `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/rpc-mode-transport.test.ts test/remote-iroh-core.test.ts test/remote-iroh-lifecycle-contract.test.ts`, `npm run iroh:poc:test`, `npm run check`; commit 30abb623</evidence>
  </item>
</group>

<group n="2" title="Run preservation and cancellation">
  <item ref="B.1" status="resolved" prereq="A.2">
    <title>Keep active integrated prompts running after client disconnect</title>
    <acceptance>An accepted prompt continues when the Iroh stream closes or the remote write side fails; `AgentSessionRuntime.dispose()` is not called solely because the subscriber detached; transcript entries produced while detached remain persisted; tests prove the old failure mode would have cancelled/disposed and the new behavior does not.</acceptance>
    <evidence>Resolved 2026-06-22: added remote lifecycle regressions using real RPC mode and the Iroh close-deferring transport to prove accepted prompts survive clean close and write failure without runtime dispose/abort, and detached transcript entries remain recoverable; verification: `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-lifecycle-contract.test.ts`, `npm run check`, `npm run iroh:poc:test`; commit 7761c3dd</evidence>
  </item>

  <item ref="B.2" status="resolved" prereq="B.1">
    <title>Preserve explicit remote cancellation behavior</title>
    <acceptance>Authorized inbound `abort` still calls `session.abort()` and waits for the agent to settle; cancellation is observable through state/events/transcript as currently supported; tests cover explicit abort during an active remote run and distinguish it from transport detach.</acceptance>
    <evidence>Resolved 2026-06-22: added an active remote prompt regression through the Iroh remote filter and close-deferring transport proving `abort` calls `session.abort()`, waits for abort settlement before responding, leaves detach-only paths distinct, and persists observable transcript output; verification: `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-lifecycle-contract.test.ts`, `npm run check`, `npm run iroh:poc:test`; commit be521aa0</evidence>
  </item>

  <item ref="B.3" status="resolved" prereq="B.1">
    <title>Add detached runtime retention and cleanup policy</title>
    <acceptance>Detached runtimes are retained long enough for reconnect and cleaned up by a documented TTL/resource policy; active prompts either continue to completion or stop only by explicit policy; idle detached runtimes are disposed without leaking resources; tests cover TTL cleanup and no premature cleanup during active work.</acceptance>
    <evidence>Resolved 2026-06-22: added a detached integrated runtime retention scheduler, default 30-minute idle TTL configurable via `--detached-runtime-ttl-ms`, host audit/disposal on TTL expiry, unit coverage for idle expiry/no active-run expiry/cancel-on-reattach, and a native integrated TTL cleanup scenario; verification: `node --check packages/coding-agent/src/remote/iroh-host.mjs`, `node --check scripts/iroh-sidecar-test.mjs`, `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/integrated-runtime-retention.test.ts`, `npm run check`, `npm run iroh:poc:test`; commit 411958d1</evidence>
  </item>
</group>

<group n="3" title="Reconnect and protocol recovery">
  <item ref="C.1" status="resolved" prereq="B.1">
    <title>Reconnect same authorized client to detached active runtime</title>
    <acceptance>A reconnecting client with the same authoritative Iroh node ID and workspace attaches to the detached runtime, sees the same session ID, and can call `get_state` plus `get_transcript` to recover output generated while detached; different or revoked clients cannot attach; duplicate active connection behavior remains deterministic and tested.</acceptance>
    <evidence>Resolved 2026-06-22: added a native integrated-host scenario with a local OpenAI-compatible streaming provider proving same-node active detach reconnect keeps the session ID, `get_state` shows the active runtime, `get_transcript` recovers detached user/assistant output after completion, a different node cannot reuse the consumed ticket, revoked reconnect is rejected, and duplicate active behavior remains covered by the existing native duplicate scenario; verification: `node --check scripts/iroh-sidecar-test.mjs`, `npm run iroh:poc:test`, `npm run check`; commit 1b4c72fa</evidence>
  </item>

  <item ref="C.2" status="resolved" prereq="C.1">
    <title>Expose enough state for remote UI to represent active detached work</title>
    <acceptance>`get_state` continues to be safe over Iroh and exposes sufficient active/idle information for iOS to render reconnecting active work. If new run metadata is added, it is documented, typed, redacted where needed, and covered by tests; if existing `isStreaming` is sufficient, record that decision in both ledgers.</acceptance>
    <evidence>Resolved 2026-06-22: recorded the decision to keep existing `get_state.isStreaming` as the active-work signal for iOS and defer richer run metadata; current evidence includes the native C.1 active-reconnect scenario proving `isStreaming === true` on reconnect plus Iroh outbound sanitizer coverage for safe `get_state` responses; verification: `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-core.test.ts`, `git diff --check -- .volt/iroh-host-detach-cancel-design.md .volt/iroh-host-detach-cancel-goal.md`</evidence>
  </item>
</group>

<group n="4" title="Docs and validation">
  <item ref="D.1" status="open" prereq="B.2,C.1">
    <title>Update user-facing and protocol docs for detach/cancel semantics and limitations</title>
    <acceptance>`packages/coding-agent/docs/rpc.md`, `packages/coding-agent/docs/iroh-remote-protocol.md`, and relevant remote access docs explain that transport close means detach, `abort` means cancel, host process exit is not durable recovery, and spawned child mode limitations are documented if still connection-scoped.</acceptance>
    <evidence/>
  </item>

  <item ref="D.2" status="open" prereq="D.1,C.2">
    <title>Run final automated and manual validation</title>
    <acceptance>Final evidence lists exact targeted Vitest files, `npm run iroh:poc:test`, `npm run check`, doc diff checks, and manual iOS detach/cancel smoke results with device, iOS version, macOS version, relay mode, and network. Any unsupported case is documented without overclaiming.</acceptance>
    <evidence/>
  </item>

  <item ref="D.3" status="open" prereq="D.2" type="rollup">
    <title>Rollup: host detach/cancel semantics are implemented, tested, documented, and ready for iOS use</title>
    <acceptance>All prior items are resolved; the design doc decisions and limitations are recorded; no open host-side detach/cancel implementation decisions remain except explicitly deferred future work.</acceptance>
    <evidence/>
  </item>
</group>

</work_queue>

</goal>
