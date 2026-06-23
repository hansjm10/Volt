<goal name="ios-native-remote-ui-actions">

<context>
This file is the operating manual and work ledger for a Volt /goal run that
adds a native remote UI action layer for the iOS app. The paired design document
is `.volt/ios-native-remote-ui-actions-design.md`; treat that file as the SPEC
and this file as the TURN LEDGER. Update both files when a queue item is
resolved or when implementation reveals a necessary design change.

The long-term product direction is: iOS should render native cards, buttons,
toggles, pickers, and command palettes for host-owned actions instead of
mirroring the terminal TUI or sending raw slash-command strings as the canonical
protocol. Slash commands remain aliases/presentation. The host owns action
availability, execution, security policy, model policy, prompt/template/skill
expansion, and extension command execution.

Suggested goal prompt:
/goal Work through .volt/ios-native-remote-ui-actions-goal.md, exactly one queue
item per goal turn, following the protocol in that file. Do not mark the goal
complete until every item in its work_queue has status="resolved". Commit only
files changed for the selected item, by explicit path, when committing is safe
under the repo rules; if commit ownership, target repo, branch, remote, or
security implications are unclear, stop before committing and list the exact
paths ready to stage.
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
    `git -C ../volt-app status --short`. Confirm dirty files are either the
    paired planning docs named in working_tree_rules or in-progress files from a
    prior partial turn on the item you are about to re-select. If any other
    surprise dirty file exists, do not select an item: report the unexpected
    state and stop the turn.
  </step>

  <step n="2" name="select">
    Read the work_queue below. Select the FIRST item with status="open" whose
    prereq items, if any, all have status="resolved". Treat status="blocked" as
    not selectable. Items with type="rollup" are never selected directly; see
    rollup_rule. Work only the selected item this turn.
  </step>

  <step n="3" name="read_spec">
    Read `.volt/ios-native-remote-ui-actions-design.md` and the selected item's
    relevant sections in full. Also read current implementation files that own
    the behavior before editing them. Expected Volt host/protocol areas include:

    - `packages/coding-agent/src/core/rpc/types.ts`
    - `packages/coding-agent/src/core/rpc/index.ts`
    - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
    - `packages/coding-agent/src/modes/rpc/rpc-client-base.ts`
    - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
    - `packages/coding-agent/src/core/remote/iroh/rpc-command-filter.ts`
    - `packages/coding-agent/src/core/remote/iroh/outbound-filter.ts`
    - `packages/coding-agent/src/modes/rpc/iroh-remote-rpc-mode.ts`
    - `packages/coding-agent/src/core/agent-session.ts`
    - `packages/coding-agent/src/core/slash-commands.ts`
    - `packages/coding-agent/src/core/prompt-templates.ts`
    - `packages/coding-agent/src/core/skills.ts`
    - `packages/coding-agent/src/core/extensions/runner.ts`
    - `packages/coding-agent/src/core/extensions/types.ts`
    - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
    - `packages/coding-agent/docs/rpc.md`
    - `packages/coding-agent/docs/iroh-remote-protocol.md`
    - `packages/coding-agent/docs/extensions.md`
    - `packages/coding-agent/docs/prompt-templates.md`
    - `packages/coding-agent/docs/skills.md`

    Expected iOS app areas include:

    - `../volt-app/Packages/VoltClient/Sources/VoltClient/RPC/VoltRPC.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/VoltTransport.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohVoltTransport.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/MockVoltTransport.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession.swift`
    - `../volt-app/Volt/ChatView.swift`
    - `../volt-app/Volt/SettingsView.swift`
    - `../volt-app/Volt/*.swift` files that own tabs, sheets, navigation, or cards
    - `../volt-app/Packages/VoltClient/Tests/VoltClientTests/`
    - `../volt-app/Packages/VoltClient/Tests/VoltCoreTests/`

    Use LSP tools per &lt;lsp_usage/&gt; for semantic TypeScript questions before
    changing shared symbols. For Swift files, read the owning files and run the
    Swift verification commands because Swift LSP may not be available.
  </step>

  <step n="4" name="implement_or_decide">
    Implement the SPEC behavior faithfully for the selected item and add or
    extend tests that would have failed before the change and pass after it.

    type="decision" items: make the decision explicitly, record it in the design
    document and this ledger, and implement only the docs/tests/code needed by
    that decision in the same turn. A defer/keep-narrow decision counts as
    resolving the item only if it includes enough rationale and acceptance notes
    for a future implementer.

    Preserve the remote security boundary:

    - Do not expose raw `get_messages` over Iroh.
    - Do not expose host session file paths or extension source file paths in
      remote action descriptors.
    - Do not expose prompt template bodies or full skill content in descriptors.
    - Do not expose provider secrets, environment values, auth internals, or raw
      local model/provider metadata without a separate remote policy decision.
    - Re-check action availability and authorization at invocation time even if
      the client presents a stale descriptor.
    - Keep all Iroh remote additions allowlist-based.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then
    run the commands in &lt;verification/&gt; that apply to changed files. All required
    checks for changed files must pass before the item may be marked resolved. If
    native Iroh behavior, iOS simulator/device access, credentials, model access,
    or a product decision is unavailable, follow blocked_rule or
    partial_progress_rule instead of overclaiming.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/ios-native-remote-ui-actions-design.md`: update the relevant section
    with `Resolved YYYY-MM-DD:` plus the concrete behavior or decision when an
    item is resolved. Do not silently delete unresolved requirements; if the
    selected item reveals new scope, add a new open item instead.

    This file: set the selected item status="resolved" and fill its
    &lt;evidence&gt; with one concise line containing what changed, what verification
    ran, and the commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If committing is safe under the repo rules, stage only files changed for the
    selected item, by explicit path. Never use `git add -A` or `git add .`.

    If the selected item changes both `/Users/jordan.hans/Projects/Volt` and
    `../volt-app`, commit them separately in their respective repositories unless
    the user requested otherwise. Ask before committing or pushing if scope,
    target branch, remote, ownership, or lockfile implications are unclear.

    Suggested commit message formats:
    Volt protocol/code: `feat(coding-agent): add native remote UI actions &lt;ref&gt;`
    Volt docs/decision: `docs(coding-agent): record native remote UI action decision &lt;ref&gt;`
    Volt tests only: `fix(coding-agent): cover native remote UI actions &lt;ref&gt;`
    iOS app: `feat: add native Volt action cards &lt;ref&gt;`
    iOS tests/docs: `test: cover native Volt actions &lt;ref&gt;`

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
  <when_changed path="packages/coding-agent/src/core/remote/iroh packages/coding-agent/src/core/rpc packages/coding-agent/src/modes/rpc packages/coding-agent/src/remote/iroh-host.mjs scripts/iroh-sidecar-*.mjs">npm run iroh:poc:test</when_changed>
  <when_changed path="packages/coding-agent/docs .volt">git diff --check -- &lt;changed docs paths&gt;</when_changed>
  <when_changed path="../volt-app/Packages/VoltClient">cd ../volt-app/Packages/VoltClient &amp;&amp; swift test</when_changed>
  <when_changed path="../volt-app/Volt ../volt-app/VoltTests ../volt-app/Volt.xcodeproj">cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test</when_changed>
  <manual when="ios_native_actions_ui_changed">Run an iOS simulator or real-device smoke that connects to a host, loads native actions, invokes at least one prompt-like action, invokes one synchronous state action, and verifies pending/streaming state clears correctly. Record device/simulator, iOS version, host command, relay mode, workspace, and result.</manual>
  <manual when="review_or_fast_mode_changed">Run a host/iOS smoke for Review and/or Fast mode if those actions changed. Record the exact action, host state before/after, transcript/state outcome, and whether any model/provider credentials were required.</manual>
  <notes>
    `npm run check` is required after Volt code changes and must be run from the
    Volt repo root. If a test file is created or modified, run the specific test
    file and iterate until it passes before broader checks. For iOS simulator
    verification, if the named simulator is unavailable, choose an available iOS
    simulator and record the exact destination used. Manual UI smoke is required
    only for final validation or for items that change visible iOS behavior.
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

- `.volt/ios-native-remote-ui-actions-design.md`
- `.volt/ios-native-remote-ui-actions-goal.md`

Expected out-of-scope dirty files during native-remote-ui-action turns: none
beyond the planning files above. Multiple Volt sessions may share the same
worktree. Never stage or commit files you did not modify for the selected item.
If either repository shows unrelated dirty files beyond the allowances above,
stop before selecting work.
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
a real iOS device, native Iroh support, provider/model access, or a human product
decision is unavailable:

1. Do whatever portion is achievable without the blocker, following
   partial_progress_rule.
2. Add a `Blocked YYYY-MM-DD:` note to
   `.volt/ios-native-remote-ui-actions-design.md` under the relevant section and
   set this file's item status="blocked" with a `&lt;blocker&gt;` child explaining what
   is needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and the final turn's required verification passed.
Final evidence must include host automated tests, Iroh remote allowlist/security
tests for exposed actions, Swift package tests, iOS UI/state tests, and at least
one iOS simulator or real-device native action smoke, unless explicitly blocked
and recorded without overclaiming.
</completion_rule>

<work_queue>

<group n="1" title="Decisions and remote action contract">
  <item ref="A.1" status="resolved" prereq="" type="decision">
    <title>Classify initial action scope and remote allowlist</title>
    <acceptance>The design document includes an inventory of current TUI built-in slash commands, existing RPC equivalents, extension commands, prompt templates, and skills. Each candidate is classified as initial remote-safe, local-only, deferred pending policy, or unsupported. The initial exposed Iroh subset is deliberately narrow and justified. Review actions and Fast mode have explicit include/defer decisions for the first implementation phase.</acceptance>
    <evidence>Resolved 2026-06-23: design records built-in slash/RPC/dynamic command inventory, narrow Iroh discovery/invocation scope, and Review/Fast first-phase deferrals; verified with `git diff --check -- .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md` and pre-commit `npm run check`; commit 3db207b225007462498148fe70e512a778e40a91.</evidence>
  </item>

  <item ref="A.2" status="resolved" prereq="A.1" type="decision">
    <title>Define the v1 action descriptor schema, ids, and compatibility rules</title>
    <acceptance>`UiActionDescriptor` v1 fields are documented, including stable built-in ids, session-local or stable extension ids, label/description, source, category, presentation hints, args, state, enabled/disabledReason, destructive/confirmation flags, remoteSafe, and slash alias. Compatibility rules say clients ignore unknown fields, hosts reject unknown ids, and descriptors never expose sensitive source paths or bodies. The decision names whether extension command action ids are stable or session-local for v1.</acceptance>
    <evidence>Resolved 2026-06-23: design documents the v1 `UiActionDescriptor` schema, stable built-in ids, session-local opaque dynamic ids, and compatibility/security rules; verified with `git diff --check -- .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md` and pre-commit `npm run check`; commit e7c8cd0d681c1c4b5a02b5160da2b6a017d29087.</evidence>
  </item>

  <item ref="A.3" status="resolved" prereq="A.1,A.2" type="decision">
    <title>Define invocation semantics for synchronous, prompt-like, queued, and state actions</title>
    <acceptance>The design document defines `invoke_ui_action` response semantics, including `accepted`, `completed`, `queued`, `handled`, and `cancelled` statuses; how prompt-like actions relate to `agent_end`; how synchronous actions clear pending UI without waiting for agent events; how invocation behaves while streaming; and how stale enabled state is rechecked by the host. Tests expected in later items are named.</acceptance>
    <evidence>Resolved 2026-06-23: design documents `invoke_ui_action` response statuses, `agent_end` waiting rules, synchronous pending-state clearing, descriptor streaming policy, host-side stale enabled rechecks, and later host/Iroh/iOS test names; verified with `git diff --check -- .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md` and pre-commit `npm run check`; commit 13e7b9ea8277860ed71a88154d02c0710382574d.</evidence>
  </item>

  <item ref="A.4" status="resolved" prereq="A.1" type="decision">
    <title>Define Fast mode policy boundaries</title>
    <acceptance>The design document states whether Fast mode is in v1, whether it is session-local/profile/global, whether it changes thinking level only or may switch models, how it interacts with scoped models/profile defaults, and what metadata iOS may display. If deferred, the design records a smaller substitute such as `thinking.fast_mode` or names the blocker.</acceptance>
    <evidence>Resolved 2026-06-23: design defers full `model.fast_mode` and records v1 `thinking.fast_mode` as session-local, non-persistent, thinking-level-only, scoped/profile-safe, and bounded in iOS-visible metadata; verified with `git diff --check -- .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md` and pre-commit `npm run check`; commit f0a1f2872ec7c1dcade73193742ed55c825e3846.</evidence>
  </item>

  <item ref="A.5" status="resolved" prereq="A.1" type="decision">
    <title>Define Review action remote-safety and first card set</title>
    <acceptance>The design document states which review actions are exposed first, what arguments they accept, whether they require confirmation, what host-side tools/commands they may run, and how the remote security boundary applies. If any review mode is deferred, the reason and future unlock condition are recorded.</acceptance>
    <evidence>Resolved 2026-06-23: design records the first remote review card set as `review.uncommitted` and `review.branch`, requires confirmation, documents arguments, fixed git command use, read-only remote reviewer tools, and defers PR/commit/tool review actions with unlock conditions; verified with `git diff --check -- .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md` and pre-commit `npm run check`; commit 87a14502a47df61afde96aa7708dcecba33caf6b.</evidence>
  </item>
</group>

<group n="2" title="Host protocol foundation and safe discovery">
  <item ref="B.1" status="resolved" prereq="A.2,A.3">
    <title>Add core RPC protocol types and documentation for UI action capabilities</title>
    <acceptance>RPC types include `get_ui_capabilities`, `get_ui_actions`, and `invoke_ui_action` with v1 descriptor and response shapes; typed RPC exports are updated; `docs/rpc.md` documents the commands, response semantics, and security notes for non-remote RPC. Tests cover parse/dispatch for capability and empty or minimal action lists without exposing remote-only behavior prematurely.</acceptance>
    <evidence>Resolved 2026-06-23: added v1 UI action RPC command/response types, typed exports/client helpers, local capability and empty action-list dispatch, unavailable invocation error, non-remote RPC docs, and Iroh blocked-command coverage; verified with `node node_modules/vitest/dist/cli.js --run test/rpc-transport-client.test.ts` from `packages/coding-agent`, `npm run iroh:poc:test`, `npm run check`, and `git diff --check -- packages/coding-agent/docs/rpc.md .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md`; commit 07bd4d21c787b6e485b06b22cb6d85ea2bc097dd.</evidence>
  </item>

  <item ref="B.2" status="resolved" prereq="B.1,A.1">
    <title>Implement host action discovery for extension commands, prompt templates, and skills</title>
    <acceptance>`get_ui_actions` returns sanitized descriptors for extension commands, prompt templates, and skills; descriptors omit host-local paths, prompt bodies, and skill content; duplicate extension command invocation names are preserved; source labels are bounded and remote-safe; tests cover extension command, template, skill, duplicates, and no sensitive fields.</acceptance>
    <evidence>Resolved 2026-06-23: implemented sanitized `get_ui_actions` projection for extension commands, prompt templates, and skills with opaque ids, bounded safe source labels, duplicate invocation-name preservation, path-like text redaction, and sensitive-field omission tests; verified with `node node_modules/vitest/dist/cli.js --run test/rpc-transport-client.test.ts` from `packages/coding-agent`, `npm run check`, `npm run iroh:poc:test` after an initial timeout rerun, and `git diff --check -- packages/coding-agent/docs/rpc.md .volt/ios-native-remote-ui-actions-design.md .volt/ios-native-remote-ui-actions-goal.md`; commit 31da88fdf8da25bdeb3e1d470bb81e49832c6f95.</evidence>
  </item>

  <item ref="B.3" status="resolved" prereq="B.2">
    <title>Allow safe action discovery over Iroh without widening unrelated remote RPC access</title>
    <acceptance>The Iroh remote command filter allows the minimum discovery command(s) needed for action descriptors; blocked commands such as raw `get_messages`, path-based `switch_session`, unrestricted model listing, and local tool RPC remain blocked; outbound redaction applies to descriptors; protocol docs explain the remote action discovery surface; tests cover allowed discovery and blocked legacy commands.</acceptance>
    <evidence>Resolved 2026-06-23: allowed only `get_ui_capabilities` and `get_ui_actions` through the Iroh remote RPC filter, kept `invoke_ui_action` and legacy/local commands blocked, added descriptor outbound-redaction coverage, and documented the remote discovery-only surface; verified with `node node_modules/vitest/dist/cli.js --run test/rpc-transport-client.test.ts` from `packages/coding-agent`, `npm run iroh:poc:test`, `npm run check`, pre-commit `npm run check`, and `git diff --check -- packages/coding-agent/docs/rpc.md packages/coding-agent/docs/iroh-remote-protocol.md .volt/ios-native-remote-ui-actions-design.md`; commit b6fb63e22dfc1638f619d732b9d71f965b38ce05.</evidence>
  </item>

  <item ref="B.4" status="resolved" prereq="B.2,A.3">
    <title>Implement `invoke_ui_action` for prompt-like discovered actions</title>
    <acceptance>Extension command actions, prompt template actions, and skill actions can be invoked by action id; the host performs command dispatch and template/skill expansion; invocation supports a single raw arguments string at minimum; prompt-like actions use existing `AgentSession.prompt()` semantics and return the correct acceptance status; synchronous extension commands that do not start an agent run still complete without requiring `agent_end`; tests cover success, unknown id, stale id after reload/session replacement, and invocation while streaming.</acceptance>
    <evidence>Resolved 2026-06-23: implemented local `invoke_ui_action` for discovered extension command, prompt template, and skill actions using `AgentSession.prompt()` semantics with raw `arguments` support, handled/accepted/queued responses, streaming queue behavior, stale catalog-id rejection, and Iroh remote invocation capability suppression; verified with `node node_modules/vitest/dist/cli.js --run test/rpc-transport-client.test.ts` from `packages/coding-agent`, `npm run iroh:poc:test`, `npm run check`, pre-commit `npm run check`, and `git diff --check -- packages/coding-agent/docs/rpc.md packages/coding-agent/docs/iroh-remote-protocol.md .volt/ios-native-remote-ui-actions-design.md`; commit 9a7dd0671f80189908b4c24848674adc2c269d14.</evidence>
  </item>

  <item ref="B.5" status="open" prereq="B.4,B.3">
    <title>Expose prompt-like action invocation over Iroh with security and lifecycle tests</title>
    <acceptance>Iroh remote allowlist includes `invoke_ui_action` only after host-side reauthorization and action-level remote-safety checks exist; remote invocation can run allowed prompt/template/skill/extension actions; local-only action ids are rejected with a normal RPC error; transport close remains detach-only; tests cover remote allowed invocation, rejected local-only action, and synchronous action response behavior.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="3" title="iOS discovery, palette, and invocation">
  <item ref="C.1" status="open" prereq="B.1,B.2">
    <title>Add iOS RPC commands and models for UI action descriptors</title>
    <acceptance>`VoltRPCCommand` can encode `get_ui_capabilities`, `get_ui_actions`, and `invoke_ui_action`; Swift models parse action descriptors, presentation hints, argument metadata, state, enabled/disabledReason, source, and slash alias while skipping invalid entries safely; tests cover encoding and descriptor parsing with unknown fields.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="C.2" status="open" prereq="C.1,B.3">
    <title>Load and refresh native action descriptors in `VoltSession`</title>
    <acceptance>The iOS session loads action capabilities/descriptors after connect/reconnect, refreshes after session switch/new session and action-change events if available, stores loading/error state, preserves existing transcript loading behavior, and treats unavailable host support as non-fatal fallback. Tests cover connect, reconnect, session switch, new session, unsupported-command fallback, and invalid descriptor skipping.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="C.3" status="open" prereq="C.2,B.4">
    <title>Add a native command palette for discovered actions</title>
    <acceptance>The iOS app exposes a searchable native palette or sheet listing discovered actions grouped by category/source; disabled actions show host-provided reasons and do not invoke; actions with no required args can be invoked; single-string argument actions can prompt for text; extension/prompt/skill actions remain visually distinct from built-in actions. Simulator or Swift/UI tests cover visible state decisions where practical.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="C.4" status="open" prereq="C.3,B.5">
    <title>Handle action invocation lifecycle in iOS without streaming-state deadlocks</title>
    <acceptance>iOS sends `invoke_ui_action` and handles `accepted`, `completed`, `queued`, `handled`, `cancelled`, and failure responses. Prompt-like accepted actions keep or enter streaming state until normal agent events finish; synchronous handled/completed actions clear pending UI without waiting for `agent_end`; errors append a system message and clear pending state. Tests cover an extension command that completes without an agent run and a prompt-like action that streams.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="4" title="Shared built-in action registry">
  <item ref="D.1" status="open" prereq="B.1,A.2,A.3">
    <title>Create a shared host action registry scaffold for built-in actions</title>
    <acceptance>A shared core action registry can register built-in actions with descriptors, availability checks, argument metadata, slash aliases, and handlers. TUI and RPC can both resolve actions through this registry without duplicating core business logic. Initial scaffold includes tests and does not change user-visible TUI behavior beyond internal routing for a minimal safe action.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="D.2" status="open" prereq="D.1">
    <title>Migrate simple built-ins to shared actions and keep TUI aliases working</title>
    <acceptance>At least `session.new`, `run.cancel`, `context.compact`, and `session.rename` (or a documented subset if policy requires) are implemented as shared actions; TUI slash commands continue to work; RPC action invocation works for the remote-safe subset; docs list action ids and slash aliases; tests prove TUI slash and RPC action paths hit equivalent handlers.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="D.3" status="open" prereq="D.1,A.5">
    <title>Refactor review workflows into shared native actions</title>
    <acceptance>Review actions decided in A.5 are registered with descriptors and handlers; TUI `/review ...` aliases continue to work; iOS-visible descriptors include card presentation metadata; host-side review behavior remains authoritative for git/gh inspection, model choice, tool setup, and session behavior; tests cover at least one review action through both TUI alias or core parser and RPC action invocation. If full review execution requires credentials or environment, blocked/partial evidence is recorded.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="D.4" status="open" prereq="D.1,A.4">
    <title>Implement Fast mode or the decided first model-speed action</title>
    <acceptance>The host exposes the decided Fast mode or model-speed action with toggle/picker state; iOS does not hardcode provider-specific policy; invocation applies the host-owned policy and returns updated state; get_state/action state remains consistent after reconnect/session switch; tests cover supported and unsupported models or thinking levels. If Fast mode is deferred, implement the agreed substitute and record the remaining blocker.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="5" title="Richer action UX, arguments, and extensions">
  <item ref="E.1" status="open" prereq="C.4,D.2">
    <title>Add descriptor-driven argument forms and completions</title>
    <acceptance>The host supports a v1 argument schema subset for string, multiline string, boolean, enum, and integer arguments; optional `get_ui_action_completions` or equivalent completion flow is implemented for applicable command arguments; iOS renders simple forms from descriptors; tests cover argument validation, invalid args, completions, and form state.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="E.2" status="open" prereq="C.4,D.3,D.4">
    <title>Add native iOS Actions page with curated Review, Model, Session, and Context cards</title>
    <acceptance>The iOS app has a dedicated Actions page/sheet/tab showing grouped cards for host-provided primary actions; Review and Fast mode or their decided substitutes appear when supported; disabled states and reasons render correctly; card invocation routes through `invoke_ui_action`; manual iOS smoke verifies at least one card that starts an agent run and one card/toggle that completes synchronously.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="E.3" status="open" prereq="B.4,E.1">
    <title>Add a first-class extension `registerAction` API or explicitly defer it with compatibility coverage</title>
    <acceptance>Either `volt.registerAction()` exists with descriptor validation, remote-safety fields, handler invocation, docs, examples, and tests; or the design records a deliberate defer decision while existing extension commands remain projected as palette actions with argument support. If implemented, project trust and remote-safe filtering apply to extension-provided actions.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="E.4" status="open" prereq="E.2,E.3">
    <title>Support extension-provided native cards in iOS when remote-safe</title>
    <acceptance>Remote-safe extension-provided actions or projected extension commands can appear in iOS extension/action groups with safe source labels; users can distinguish built-in versus extension/package actions; extension UI requests continue to render or degrade through the existing RPC UI protocol; tests cover extension action visibility, source labeling, disabled state, and invocation.</acceptance>
    <evidence></evidence>
  </item>
</group>

<group n="6" title="Documentation, compatibility, and final validation">
  <item ref="F.1" status="open" prereq="B.5,C.4,D.2">
    <title>Update protocol, extension, skill, prompt-template, and iOS docs for native actions</title>
    <acceptance>`packages/coding-agent/docs/rpc.md`, `docs/iroh-remote-protocol.md`, `docs/extensions.md`, `docs/prompt-templates.md`, `docs/skills.md`, the paired design doc, and relevant iOS README/user-facing docs describe native UI actions, slash aliases, discovery, invocation, security limits, extension command projection, skills/templates, and unsupported/deferred surfaces. Changelog entries are added where appropriate.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="F.2" status="open" prereq="E.2,F.1">
    <title>Run final cross-surface validation for native remote UI actions</title>
    <acceptance>Final evidence lists exact targeted Vitest files, Iroh scenario tests when remote RPC changed, `npm run check`, Swift package tests, iOS simulator tests, doc checks, and manual native iOS smoke. Manual smoke covers connect, load action list, invoke a prompt-like action, invoke a synchronous action or toggle, refresh after reconnect/session switch, and verify no raw sensitive metadata is exposed. Unsupported cases are documented without overclaiming.</acceptance>
    <evidence></evidence>
  </item>

  <item ref="F.3" status="open" prereq="F.2" type="rollup">
    <title>Rollup: native remote UI actions are implemented, tested, documented, and ready for iOS preview use</title>
    <acceptance>All prior items are resolved; design decisions and limitations are recorded; no open implementation decisions remain except explicitly deferred future work; final automated and manual validation evidence is recorded; migration notes explain how existing raw slash prompt compatibility remains supported.</acceptance>
    <evidence></evidence>
  </item>
</group>

</work_queue>

</goal>
