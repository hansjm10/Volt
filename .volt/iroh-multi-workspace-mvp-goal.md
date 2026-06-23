<goal name="iroh-multi-workspace-mvp">

<context>
This file is the operating manual and work ledger for a Volt /goal run that
implements the Iroh multi-workspace MVP: register desktop workspaces locally,
let one saved/paired workstation authorization use registered workspace names,
and let the iOS app select among those workspaces without another QR scan.

The paired design document is `.volt/iroh-multi-workspace-mvp-design.md`; treat
that file as the SPEC. The saved-host pairing baseline is
`.volt/iroh-saved-host-pairing-design.md`; treat it as the parent contract for
pairing, saved-host reconnect, revocation, host identity, and recovery outcomes.
This file is the TURN LEDGER. Update the SPEC and this ledger when a queue item
is resolved or implementation reveals a necessary design change.

Suggested goal prompt:
/goal Work through .volt/iroh-multi-workspace-mvp-goal.md, exactly one queue item
per goal turn, following the protocol in that file. Do not mark the goal
complete until every item in its work_queue has status="resolved". Commit only
files changed for the selected item, by explicit path, when committing is safe
under the repo rules; if commit ownership, target branch, target repo, or dirty
worktree ownership is unclear, stop before committing and list the exact paths
ready to stage.
</context>

<turn_definition>
A turn is one agent run from start until the final response is sent and the agent
becomes idle. Exactly ONE selectable work_queue item is worked per turn. If the
selected item finishes quickly, still stop after updating ledgers and committing
or stopping before commit when commit safety is unclear. Do not start another
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
    Read `.volt/iroh-multi-workspace-mvp-design.md` and the selected item's
    relevant sections in full. Also read `.volt/iroh-saved-host-pairing-design.md`
    sections that govern pairing, saved-host reconnect, revocation, and app
    recovery boundaries when the selected item touches those behaviors.

    Also read current implementation files that own the behavior before editing
    them. Expected Volt host/protocol areas include:

    - `packages/coding-agent/src/core/remote/iroh/`
    - `packages/coding-agent/src/core/rpc/iroh-transport.ts`
    - `packages/coding-agent/src/modes/rpc/iroh-remote-rpc-mode.ts`
    - `packages/coding-agent/src/remote/iroh-host.mjs`
    - `packages/coding-agent/src/main.ts`
    - `packages/coding-agent/docs/iroh-remote-protocol.md`
    - `packages/coding-agent/docs/usage.md`
    - `packages/coding-agent/docs/security.md`
    - `packages/coding-agent/examples/remote/iroh-sidecar/README.md`
    - `packages/coding-agent/test/remote-iroh-core.test.ts`
    - `packages/coding-agent/test/remote-cli.test.ts`
    - `scripts/iroh-sidecar-test.mjs`

    Expected iOS app areas include:

    - `../volt-app/Packages/VoltClient/Sources/VoltCore/SavedHostRecord.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohTicket.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohVoltTransport.swift`
    - `../volt-app/Volt/SettingsView.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltCoreTests/SavedHostRecordTests.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltCoreTests/VoltSessionLifecycleTests.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltCoreTests/XcodeProjectConfigurationTests.swift`

    Use LSP tools per <lsp_usage/> for semantic TypeScript questions before
    changing shared symbols. Use text search for `.mjs`, `.cjs`, Markdown, shell
    scripts, Swift, and other files without language-server coverage.
  </step>

  <step n="4" name="implement">
    Implement the SPEC behavior faithfully for the selected item and add or
    extend tests that would have failed before the change and pass after it.
    Preserve the remote security boundary:

    - app-selected workspaces are names only, not host paths
    - host paths are never exposed in remote metadata
    - unregistered workspace names are rejected with `workspace_unavailable`
    - registering a workspace does not change a client's persisted tool grant
    - revocation blocks every registered workspace for that phone
    - no remote API can register, edit, delete, or path-map workspaces

    type="decision" items: make the decision explicitly, record the decision in
    the SPEC and this ledger, and implement only the docs/tests/code needed by
    that decision in the same turn. A defer/keep decision counts as resolving the
    item only if it includes enough rationale and acceptance notes for a future
    implementer.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then
    run the commands in <verification/> that apply to changed files. All required
    checks for changed files must pass before the item may be marked resolved. If
    native Iroh behavior, iOS simulator/device support, relay environment, or a
    human product decision is unavailable, follow blocked_rule or
    partial_progress_rule instead of overclaiming.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/iroh-multi-workspace-mvp-design.md`: update relevant sections with
    `Resolved YYYY-MM-DD:` plus the concrete behavior or decision when an item is
    resolved. Do not silently delete unresolved requirements; if the selected item
    reveals new scope, add a new open item instead.

    This file: set the selected item status="resolved" and fill its <evidence>
    with one concise line containing what changed, what verification ran, and the
    commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If committing is safe under the repo rules, stage only files changed for the
    selected item, by explicit path. Never use `git add -A` or `git add .`.

    If the selected item changes both `/Users/jordan.hans/Projects/Volt` and
    `../volt-app`, commit them separately in their respective repositories unless
    the user requested otherwise. Ask before committing or pushing if scope,
    target branch, remote, or ownership is unclear.

    Suggested commit message formats:
    Volt host/protocol: `fix(coding-agent): support Iroh multi-workspace MVP <ref>`
    Volt docs/decision: `docs(coding-agent): record Iroh multi-workspace MVP <ref>`
    iOS app: `fix: support Iroh workspace selection <ref>`
    iOS tests/docs: `test: cover Iroh workspace selection <ref>`

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
  <when_changed path="packages/coding-agent/src/core/remote/iroh packages/coding-agent/src/core/rpc/iroh-transport.ts packages/coding-agent/src/modes/rpc packages/coding-agent/src/remote/iroh-host.mjs scripts/iroh-sidecar-*.mjs packages/coding-agent/examples/remote/iroh-sidecar">npm run iroh:poc:test</when_changed>
  <when_changed path="packages/coding-agent/docs packages/coding-agent/README.md .volt">git diff --check -- &lt;changed tracked docs paths&gt;</when_changed>
  <when_changed path="../volt-app/Packages/VoltClient">cd ../volt-app/Packages/VoltClient &amp;&amp; swift test</when_changed>
  <when_changed path="../volt-app/Volt ../volt-app/VoltTests ../volt-app/Volt.xcodeproj">cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test</when_changed>
  <when_changed path="../volt-app/.volt">perl -ne 'print "$ARGV:$.:$_" if /[ \t]+$/' ../volt-app/.volt/designs/iroh-saved-host-app-design.md</when_changed>
  <manual when="native_multi_workspace_changed">Run a native Iroh host/client smoke proving register workspace A, pair once, register workspace B, reconnect to B without a secret or QR, switch back to A without a QR, and revocation blocks both. Record relay mode, temp state path, commands, and redacted results.</manual>
  <manual when="ios_workspace_selection_changed">Run an iOS simulator or real-device smoke proving the app refreshes workspace names, selects another workspace, reconnects without a QR, and handles workspace_unavailable. Record simulator/device, host command, relay mode, state path, and result.</manual>
  <notes>
    `npm run check` is required after Volt code changes and must be run from the
    Volt repo root. If a test file is created or modified, run the specific test
    file and iterate until it passes before broader checks. For iOS simulator
    verification, if the named simulator is unavailable, choose an available iOS
    simulator and record the exact destination used. Prefer XcodeBuildMCP
    simulator tools when configured; otherwise use the xcodebuild command above.
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
This setup turn may leave these planning files uncommitted until the user decides
whether to commit them:

- `.volt/iroh-multi-workspace-mvp-design.md`
- `.volt/iroh-multi-workspace-mvp-goal.md`

At setup time on 2026-06-22, the Volt worktree also contained unrelated dirty
files from other work. Treat these baseline paths as out-of-scope unless the
selected multi-workspace item intentionally edits the same path:

- `.volt/iroh-host-detach-cancel-design.md`
- `.volt/iroh-productization-design.md`
- `packages/coding-agent/docs/iroh-remote-access-design.md`
- `packages/coding-agent/docs/iroh-remote-protocol.md`
- `packages/coding-agent/src/core/remote/iroh/index.ts`
- `packages/coding-agent/src/core/remote/iroh/outbound-filter.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/test/remote-iroh-core.test.ts`
- `scripts/iroh-sidecar-test.mjs`

At setup time on 2026-06-22, the app worktree contained this unrelated dirty
file. Treat it as out-of-scope unless the selected item intentionally edits app
docs:

- `/Users/jordan.hans/Projects/volt-app/README.md`

Multiple Volt sessions may share the same worktrees. Never stage or commit files
you did not modify for the selected item. If you need to edit a baseline-dirty
path, inspect its existing diff first and make only the selected item's changes.
If either repository shows unrelated dirty files beyond the allowances above,
stop before selecting work.
</working_tree_rules>

<partial_progress_rule>
If the selected item is too large to finish in one turn but coherent progress is
possible, this is not a block. Work only that item, keep it status="open", add a
`<progress date="YYYY-MM-DD">` child describing what changed and what remains,
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
a real iOS device, native Iroh support, a relay environment, or a human product
decision is unavailable:

1. Do whatever portion is achievable without the blocker, following
   partial_progress_rule.
2. Add a `Blocked YYYY-MM-DD:` note to the relevant SPEC section and set this
   file's item status="blocked" with a <blocker> child explaining what is needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and final required verification passed. Final
evidence must include at least one native Iroh multi-workspace smoke. If app work
is in scope, final evidence must also include one iOS simulator or real-device
workspace-selection smoke, or explicitly document why that evidence is blocked.
</completion_rule>

<work_queue>

<group n="1" title="Resolve MVP decisions">
  <item ref="A.1" status="resolved" prereq="" type="decision">
    <title>Finalize workstation-scoped authorization and existing-client migration</title>
    <acceptance>The SPEC states the exact persisted representation for workstation-scoped clients, how new pairings are stored, how existing active clients are treated, whether and when legacy clients are normalized to `allowedWorkspaces: []`, and why revoked clients remain blocked. Tests or fixtures are identified for the chosen behavior.</acceptance>
    <evidence>Resolved workstation grants as persisted `allowedWorkspaces: []`, new pairings as wildcard, legacy active-client normalization on next successful authorization, and revoked tombstones as blocked/non-normalized; verification: `git diff --check -- .volt/iroh-multi-workspace-mvp-design.md` plus commit hook `npm run check`; commit 5ab055f7.</evidence>
  </item>

  <item ref="A.2" status="open" prereq="" type="decision">
    <title>Finalize registration visibility for running hosts and stale workspace paths</title>
    <acceptance>The SPEC states whether `--register-workspace` is visible to a running host without restart, how pair-control and handshakes read current state, and how stale or deleted registered paths fail. The outcome mapping for stale paths is explicit.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="A.3" status="open" prereq="" type="decision">
    <title>Finalize app workspace-selection UX for idle, connected, streaming, and offline states</title>
    <acceptance>The SPEC states whether picker changes auto-reconnect, when selection is disabled or confirmed, what happens while streaming, and how offline or workspace_unavailable states preserve selected workspace. The decision is concrete enough for app implementation.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="2" title="Host and protocol implementation">
  <item ref="B.1" status="open" prereq="A.1,A.2">
    <title>Implement workspace registration CLI and state upsert</title>
    <acceptance>`volt remote host --register-workspace`, explicit path, and `name=path` registration work with default and explicit state paths; invalid paths are rejected; re-registering a name updates the saved realpath; tests cover parser and state behavior.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="B.2" status="open" prereq="A.1,A.2,B.1">
    <title>Implement multi-workspace host authorization</title>
    <acceptance>Host authorization resolves the requested workspace by registered name, authorizes paired workstation-scoped clients for any registered workspace, rejects unknown workspaces with `workspace_unavailable`, preserves revocation and pairing-secret semantics, and tests cover workspace A/B reconnect without QR.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="B.3" status="open" prereq="B.2">
    <title>Update pair control and pairing tickets for registered workspace names</title>
    <acceptance>`volt remote pair --workspace <name>` can create a ticket for any registered workspace from a running host, rejects unknown names, keeps relay expectation behavior, and creates workstation-scoped client grants after successful pairing. Tests cover pair-control success and failure.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="B.4" status="open" prereq="B.2">
    <title>Expose registered workspace names in remote host metadata without paths</title>
    <acceptance>`get_state.remoteHost.workspaceNames` contains registered workspace names, `remoteHost.workspace` remains the selected workspace, no host paths are exposed, and outbound path redaction still treats only the selected workspace path as `/workspace`. Tests cover metadata and sanitizer boundaries.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="B.5" status="open" prereq="B.1,B.2,B.3,B.4">
    <title>Add native scenario coverage for multi-workspace reconnect</title>
    <acceptance>The native Iroh scenario suite or an equivalent focused smoke proves register A, pair once, register B, reconnect/select B without QR or secret, switch back to A without QR, and revocation blocks both workspaces.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="3" title="iOS app implementation">
  <item ref="C.1" status="open" prereq="A.3,B.4">
    <title>Refresh saved host workspace names from verified host metadata</title>
    <acceptance>The app parses `remoteHost.workspaceNames`, updates `SavedHostRecord.workspaceNames` after verified host connection without changing host identity, preserves the current/primary workspace, and tests cover metadata refresh and missing metadata fallback.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="C.2" status="open" prereq="A.3,C.1">
    <title>Implement saved-host workspace selection and reconnect</title>
    <acceptance>The app can select a registered workspace name, saves it as `primaryWorkspace`, regenerates or omits stale reconnect envelopes, reconnects using the selected workspace when safe, and tests prove the reconnect ticket uses the selected workspace and `workspace_unavailable` keeps the saved host.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="C.3" status="open" prereq="C.2">
    <title>Add Settings workspace picker UX</title>
    <acceptance>Settings shows a picker when multiple saved workspace names exist, follows the A.3 disabled/auto-reconnect behavior, keeps Retry/Pair Again/Forget Host semantics intact, and simulator or source tests cover visible state decisions where practical.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="4" title="Docs and validation">
  <item ref="D.1" status="open" prereq="B.4,C.2">
    <title>Document multi-workspace registration and workstation-scoped auth</title>
    <acceptance>Root docs and app docs/README describe `--register-workspace`, registered names only, workstation-scoped authorization, app workspace selection, tool grants applying across workspaces, revocation blocking all workspaces, and the MVP limitations. Docs avoid implying that QR rescanning is needed for workspace changes.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="D.2" status="open" prereq="B.5,C.3,D.1">
    <title>Run final automated and manual multi-workspace validation</title>
    <acceptance>Final evidence lists exact targeted Vitest files, `npm run iroh:poc:test`, `npm run check`, Swift package tests, iOS simulator tests when app UI changed, doc checks, native multi-workspace smoke, and app workspace-selection smoke or a documented blocker. Unsupported cases are documented without overclaiming.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="D.3" status="open" prereq="D.2" type="rollup">
    <title>Rollup: multi-workspace MVP is implemented, tested, documented, and ready for preview use</title>
    <acceptance>All prior items are resolved; the SPEC records final behavior and limitations; no open multi-workspace MVP implementation decisions remain except explicitly deferred future work; final automated and manual validation evidence is recorded.</acceptance>
    <evidence></evidence>
  </item>
</group>

</work_queue>

</goal>
