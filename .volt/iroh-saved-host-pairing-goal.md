<goal name="iroh-saved-host-pairing">

<context>
This file is the operating manual and work ledger for a Volt /goal run that
implements one-time phone pairing followed by saved-host reconnect across app,
network, computer, and host-service restarts.

The paired root design document is `.volt/iroh-saved-host-pairing-design.md`;
treat that file as the cross-product SPEC. The iOS app handoff document is
`/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`;
treat that file as the app-specific SPEC. This file is the TURN LEDGER. Update
the relevant SPEC document and this ledger when a queue item is resolved or when
implementation reveals a necessary design change.

Suggested goal prompt:
/goal Work through .volt/iroh-saved-host-pairing-goal.md, exactly one queue item
per goal turn, following the protocol in that file. Do not mark the goal complete
until every item in its work_queue has status="resolved". Commit only files
changed for the selected item, by explicit path, when committing is safe under
the repo rules; if commit authorization, target repo, branch, or ownership is
unclear, stop before committing and list the exact paths ready to stage.
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
    `git -C ../volt-app status --short`. Confirm dirty files are either expected
    setup files from working_tree_rules or in-progress files from a prior partial
    turn on the item you are about to re-select. If any other surprise dirty file
    exists, do not select an item: report the unexpected state and stop the turn.
  </step>

  <step n="2" name="select">
    Read the work_queue below. Select the FIRST item with status="open" whose
    prereq items, if any, all have status="resolved". Treat status="blocked" as
    not selectable. Items with type="rollup" are never selected directly; see
    rollup_rule. Work only the selected item this turn.
  </step>

  <step n="3" name="read_spec">
    Read `.volt/iroh-saved-host-pairing-design.md` and the selected item's
    relevant sections in full. If the selected item touches the iOS app, also read
    `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.
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
    - `packages/coding-agent/test/remote-iroh-core.test.ts`
    - `packages/coding-agent/test/remote-cli.test.ts`
    - `scripts/iroh-sidecar-test.mjs`

    Expected iOS app areas include:

    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohTicket.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohVoltTransport.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltCore/SavedIrohTicket.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession.swift`
    - `../volt-app/Volt/SettingsView.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltClientTests/IrohTicketTests.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltClientTests/IrohVoltTransportIdentityTests.swift`
    - `../volt-app/Packages/VoltClient/Tests/VoltCoreTests/VoltSessionLifecycleTests.swift`

    Use LSP tools per &lt;lsp_usage/&gt; for semantic TypeScript questions before
    changing shared symbols. For Swift files, read/search directly and run Swift
    verification because Swift LSP may not be available.
  </step>

  <step n="4" name="implement">
    Implement the SPEC behavior faithfully for the selected item and add or
    extend tests that would have failed before the change and pass after it.
    Preserve the remote security boundary: one-time pairing secrets are never
    saved on the client, host state persists only secret hashes and non-secret
    metadata, existing paired clients reconnect by authoritative node ID, and
    clients cannot request arbitrary host paths or tools.

    type="decision" items: make the decision explicitly, record it in the
    relevant SPEC document and this ledger, and implement only the docs/tests/code
    needed by that decision in the same turn. A defer/keep decision counts as
    resolving the item only if it includes enough rationale and acceptance notes
    for a future implementer.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then
    run the commands in &lt;verification/&gt; that apply to changed files. All required
    checks for changed files must pass before the item may be marked resolved. If
    native Iroh behavior, iOS hardware, relay environment, or product input is
    unavailable, follow blocked_rule or partial_progress_rule instead of
    overclaiming.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/iroh-saved-host-pairing-design.md`: update relevant sections with
    `Resolved YYYY-MM-DD:` plus the concrete behavior or decision when an item is
    resolved.

    `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`:
    update app-specific sections when the selected item changes app behavior or
    app-specific decisions.

    This file: set the selected item status="resolved" and fill its
    &lt;evidence&gt; with one concise line containing what changed, what verification
    ran, and the commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If committing is safe and authorized under the repo rules, stage only files
    changed for the selected item, by explicit path. Never use `git add -A` or
    `git add .`.

    If the selected item changes both `/Users/jordan.hans/Projects/Volt` and
    `../volt-app`, commit them separately in their respective repositories unless
    the user requested otherwise. Ask before committing or pushing if scope,
    target branch, remote, or ownership is unclear.

    Suggested commit message formats:
    Volt host/protocol: `fix(coding-agent): support saved Iroh hosts &lt;ref&gt;`
    Volt docs/decision: `docs(coding-agent): record saved Iroh host decision &lt;ref&gt;`
    iOS app: `fix: support saved Iroh host reconnect &lt;ref&gt;`
    iOS tests/docs: `test: cover saved Iroh host reconnect &lt;ref&gt;`

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
  <when_changed path="packages/coding-agent/docs .volt">git diff --check -- &lt;changed tracked docs paths&gt;</when_changed>
  <when_changed path="../volt-app/Packages/VoltClient">cd ../volt-app/Packages/VoltClient &amp;&amp; swift test</when_changed>
  <when_changed path="../volt-app/Volt ../volt-app/VoltTests ../volt-app/Volt.xcodeproj">cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test</when_changed>
  <when_changed path="../volt-app/.volt">perl -ne 'print "$ARGV:$.:$_" if /[ \t]+$/' ../volt-app/.volt/designs/iroh-saved-host-app-design.md</when_changed>
  <manual when="native_reconnect_changed">Run a native Iroh host/client smoke proving pair once, reconnect without secret, host restart with same state path, and no QR rescan. Record relay mode, state path, commands, and redacted results.</manual>
  <manual when="relay_default_changed">Run a `--relay default` smoke across at least same-machine and, when possible, two-network or Wi-Fi/cellular environments. Record environment and result; if no relay environment is available, document the evidence gap.</manual>
  <manual when="ios_saved_host_changed">Run an iOS simulator or real-device smoke that pairs once, relaunches without `--volt-iroh-ticket`, reconnects from saved host, restarts host, and reconnects again. Record device/simulator, iOS version, host command, relay mode, and result.</manual>
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

- `.volt/iroh-saved-host-pairing-design.md`
- `.volt/iroh-saved-host-pairing-goal.md`
- `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`

The `../volt-app/.volt/` directory is ignored by that repository. Treat the app
design file as a local planning artifact unless the user changes the app repo
ignore policy.

Expected out-of-scope dirty files during saved-host-pairing turns: none beyond
the planning files above. Multiple Volt sessions may share the same worktrees.
Never stage or commit files you did not modify for the selected item. If either
repository shows unrelated dirty files beyond the allowances above, stop before
selecting work.
</working_tree_rules>

<partial_progress_rule>
If the selected item is too large to finish in one turn but coherent progress is
possible, this is not a block. Work only that item, keep it status="open", add a
`&lt;progress date="YYYY-MM-DD"&gt;` child describing what changed and what remains,
run verification required for the files changed, and commit only coherent
completed progress if committing is safe and authorized. The next turn will
re-select this same item because it remains the first selectable open item.
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
2. Add a `Blocked YYYY-MM-DD:` note to the relevant SPEC document and set this
   file's item status="blocked" with a `&lt;blocker&gt;` child explaining what is
   needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and final required verification passed. Final
evidence must include at least one native Iroh saved-host reconnect smoke and one
iOS app saved-host reconnect smoke, or explicitly document why that evidence is
blocked.
</completion_rule>

<work_queue>

<group n="1" title="Resolve remaining product and protocol decisions">
  <item ref="A.1" status="resolved" prereq="" type="decision">
    <title>Define the boundary between transient offline, stale discovery, and invalid saved-host data</title>
    <acceptance>Root and app specs define when the app keeps the saved host and shows offline/retry, when it refreshes discovery data, and when it offers Pair Again or Forget Host. The decision distinguishes host_unreachable, stale-but-refreshable discovery, host_identity_mismatch, and saved_host_invalid without requiring QR scanning for ordinary offline hosts.</acceptance>
    <evidence>2026-06-22: Root and app specs now classify host_unreachable, stale-but-refreshable discovery, host_identity_mismatch, saved_host_invalid, client_unknown, and workspace access outcomes; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit 75b6037e.</evidence>
  </item>

  <item ref="A.2" status="resolved" prereq="A.1" type="decision">
    <title>Define revocation and re-pair behavior for a previously revoked phone identity</title>
    <acceptance>Specs define whether revocation blocks the same phone node ID from re-pairing until desktop approval, whether re-pair can reuse the phone identity after explicit approval, and when the app should rotate or clear its endpoint identity. Host state, app Forget Host behavior, and UX copy are consistent.</acceptance>
    <evidence>2026-06-22: Root and app specs now require durable revoked-client tombstones, explicit desktop approval before same-node re-pair, same phone identity reuse after approval, and no automatic endpoint identity rotation for revoked/unknown clients; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit 4597671b.</evidence>
  </item>

  <item ref="A.3" status="resolved" prereq="A.1" type="decision">
    <title>Define pairing transaction completion and QR consumption boundary</title>
    <acceptance>Specs define when the host consumes the one-time pairing secret, what happens if the host records the client but the app fails before saving SavedHostRecord, whether a retry from the same phone can complete recovery, and how concurrent attempts allow at most one successful pairing without stranding the legitimate phone.</acceptance>
    <evidence>2026-06-22: Root and app specs now define host-side durable authorization commit as the QR consumption boundary, same-phone retry recovery after app save failure, and serialized concurrency where one new node wins and other nodes get pairing_secret_consumed; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit f2f633ed.</evidence>
  </item>

  <item ref="A.4" status="resolved" prereq="A.1" type="decision">
    <title>Define SavedHostRecord v1 discovery fields, identity verification, and refresh behavior</title>
    <acceptance>Specs name the concrete v1 fields persisted by clients, identify which field is authoritative for host identity, define how the client verifies the reached host node ID, and define how endpoint/discovery data is refreshed when relay or network details change. The decision states whether the current sanitized endpoint ticket is sufficient for v1 or needs a new record field.</acceptance>
    <evidence>2026-06-22: Root and app specs now define SavedHostRecord v1 fields, make hostNodeId authoritative, require pre/post-dial host identity verification, and allow only verified non-secret discovery refresh; current sanitized endpoint ticket is sufficient for v1 discovery when paired with hostNodeId verification; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit 7ce375db.</evidence>
  </item>

  <item ref="A.5" status="resolved" prereq="A.1" type="decision">
    <title>Define the exact scope of the mobile `--relay default` product default</title>
    <acceptance>Specs state whether the global CLI default changes, only desktop/mobile pairing flows default to relay, or `volt remote host` gains a mobile/profile option. Docs and tests expected from later items are updated to match the decision.</acceptance>
    <evidence>2026-06-22: Root and app specs now keep bare volt remote host defaulting to relay disabled, make desktop Pair Phone/service and a dedicated CLI mobile mode default to relay default, preserve explicit --relay disabled LAN-only opt-out, and treat volt remote pair --relay as a running-host expectation check; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit dab5c3c5.</evidence>
  </item>

  <item ref="A.6" status="resolved" prereq="A.2,A.3" type="decision">
    <title>Define pairing metadata retention and precise auth outcome detection</title>
    <acceptance>Specs define cleanup for pending pairing tickets and consumed pairing-secret hashes, including whether consumed hashes are retained forever or pruned by TTL. Specs also define how hosts distinguish client_unknown, client_revoked, host_identity_mismatch, workspace_unavailable, and workspace_forbidden in protocol terms.</acceptance>
    <evidence>2026-06-22: Root/app specs now define active pending tickets, consumed/expired pairing-secret tombstones pruned after 30-day retention, and stable protocol outcomes for client_unknown, client_revoked, workspace_unavailable, workspace_forbidden, pairing_secret_expired, and pairing_secret_consumed; verification: Volt/app doc whitespace checks and commit-hook npm run check passed; Volt commit 4c1cf4d5.</evidence>
  </item>
</group>

<group n="2" title="Host and protocol implementation">
  <item ref="B.1" status="resolved" prereq="A.3,A.6">
    <title>Make one-time pairing transaction semantics precise and tested</title>
    <acceptance>Host authorization consumes a pairing secret only at the decided successful transaction boundary; failed attempts do not consume it; concurrent attempts allow at most one success; recovery behavior for host-recorded/app-not-saved cases follows A.3; core tests cover success, failed attempt, concurrent attempt, reuse, expiry, and restart persistence.</acceptance>
    <evidence>2026-06-22: Host core now records consumed/expired pairing-secret tombstones with 30-day retention, commits consumed tombstones with new-client authorization, rejects consumed/expired replays while retained, preserves same-node recovery with the original QR data, and tests failed-attempt non-consumption, concurrency, expiry retention/pruning, and restart persistence; verification: targeted Vitest files, npm run iroh:poc:test, git diff --check, and commit-hook npm run check passed; Volt commit e407b04b.</evidence>
  </item>

  <item ref="B.2" status="resolved" prereq="A.2,A.6">
    <title>Implement revocation and re-pair semantics</title>
    <acceptance>Revoked clients cannot silently reconnect; re-pair behavior follows A.2; host state and CLI/status output expose enough information for desktop approval or continued rejection; tests cover revoked reconnect, revoked re-pair, approved re-pair if supported, and audit events.</acceptance>
    <evidence>2026-06-22: Host state now persists revoked-client tombstones with explicit re-pair approval timestamps, revoked nodes reject reconnects and generic QR use until approval plus an active pairing secret, successful same-node re-pair clears the tombstone, and CLI/status exposes revoked devices plus approve-repair audit events; verification: targeted Vitest files, npm run iroh:poc:test, git diff --check, npm run check, and commit-hook npm run check passed; Volt commit d26756b0.</evidence>
  </item>

  <item ref="B.3" status="resolved" prereq="A.1,A.4">
    <title>Add stable saved-host protocol support and host identity verification</title>
    <acceptance>Ticket/handshake/protocol support exposes enough non-secret data for SavedHostRecord v1; reconnect handshakes without pairing secrets verify the reached host identity; stale discovery refresh or failure behavior follows A.1/A.4; tests cover host restart with same state, host identity mismatch, stale discovery if reproducible, and malformed saved-host data.</acceptance>
    <evidence>2026-06-22: Volt protocol now exposes sanitized non-secret reconnect tickets, includes hostNodeId in handshakes when the host identity is known, and verifies saved-host identity in ticket, connection, and handshake paths; core tests cover host restart with same state, host identity mismatch, and malformed saved reconnect fields. Verification: targeted Vitest file, npm run iroh:poc:test, git diff --check, npm run check, and commit-hook npm run check passed; Volt commit 95da73e0.</evidence>
  </item>

  <item ref="B.4" status="resolved" prereq="A.1,A.6">
    <title>Add machine-readable auth and reconnect outcomes</title>
    <acceptance>Handshake failures or response data include stable outcomes for host/client/app UX: host_unreachable where applicable on the client side, pairing_secret_expired, pairing_secret_consumed, client_unknown, client_revoked, workspace_unavailable, workspace_forbidden, host_identity_mismatch, and saved_host_invalid. Protocol docs and compatibility tests cover these outcomes without relying on fragile human strings.</acceptance>
    <evidence>2026-06-22: Volt protocol now defines stable reconnect outcomes, emits host auth outcomes on failed handshakes, exposes outcome-bearing client-local errors for host identity mismatch and invalid saved-host ticket data, and updates PoC client/tests to assert outcome fields instead of only human strings. Verification: targeted Vitest file, npm run iroh:poc:test, git diff --check, npm run check, and commit-hook npm run check passed; Volt commit 2b5336f1.</evidence>
  </item>

  <item ref="B.5" status="resolved" prereq="A.5">
    <title>Apply the decided relay default policy to host pairing flows</title>
    <acceptance>Host CLI/desktop/service behavior follows A.5; mobile-facing tickets include `relayMode: "default"` unless explicitly opted out; local/LAN-only mode remains available as an explicit advanced option; tests and docs cover default and opt-out behavior.</acceptance>
    <evidence>2026-06-22: Host CLI now supports `volt remote host --mobile`, defaults mobile startup/control-channel tickets to `relayMode: "default"`, preserves bare-host `disabled` and explicit `--relay disabled` opt-out, and documents/tests the policy; verification: targeted remote-cli Vitest file, npm run iroh:poc:test, same-machine --relay default host/client smoke passed, two-network relay environment unavailable in this session, git diff --check, npm run check, and commit-hook npm run check passed; Volt commit 6cb030d9.</evidence>
  </item>

  <item ref="B.6" status="resolved" prereq="B.1,B.3,B.5">
    <title>Move QR generation to an explicit Pair Phone action path</title>
    <acceptance>Host service startup does not create an active pairing invite merely because it started in product/mobile flow; explicit pair action or `volt remote pair` creates the QR/ticket; existing clients reconnect without QR after restart; docs and tests cover startup without pairing, explicit pairing, and adding another device.</acceptance>
    <evidence>2026-06-22: Mobile-facing host startup now skips active startup pairing tickets, preserves bare startup and explicit --no-pairing paired-client tickets, and PoC coverage proves no pending startup invite, explicit volt remote pair ticket, and saved-client reconnect after host restart without a new ticket; verification: npm run iroh:poc:test, git diff --check, npm run check, and commit-hook npm run check passed; Volt commit f8db2250.</evidence>
  </item>
</group>

<group n="3" title="iOS app implementation">
  <item ref="C.1" status="resolved" prereq="A.4,B.3">
    <title>Replace saved reconnect-ticket semantics with SavedHostRecord in the app model</title>
    <acceptance>iOS stores a SavedHostRecord with the fields decided in A.4, no pairing secret, and one-host-v1/multi-host-ready shape; existing Keychain loading/migration behavior is explicit; tests cover saving, loading, sanitization, malformed record handling, and future-compatible host-node-ID keying where practical.</acceptance>
    <evidence>2026-06-22: iOS now stores SavedHostRecord v1 keyed by hostNodeId, migrates valid legacy saved-ticket Keychain data, strips secret/expiry from reconnect envelopes, and tests saving/loading, sanitization, malformed records, and host-node-ID keying; verification: cd ../volt-app/Packages/VoltClient &amp;&amp; swift test, XcodeBuildMCP test_sim on Volt scheme with iPhone 17 Pro iOS 27.0, root/app doc whitespace checks passed; app commit 295f143.</evidence>
  </item>

  <item ref="C.2" status="resolved" prereq="C.1,B.4">
    <title>Implement saved-host startup, reconnect, and offline/error UX</title>
    <acceptance>App launch uses explicit launch ticket first, otherwise saved host, otherwise unpaired state; saved-host reconnect sends no pairing secret; host_unreachable keeps the saved host and shows offline/retry; stale/invalid/mismatch/revoked outcomes follow A.1/A.2/B.4; tests cover startup priority and outcome mapping.</acceptance>
    <evidence>2026-06-22: iOS startup now prioritizes explicit launch tickets, otherwise saved-host reconnect, otherwise unpaired state; saved reconnect sends secret-free tickets, verifies handshake hostNodeId, maps stable outcomes into savedHostIssue/offline state, and preserves saved records for retryable/revoked/workspace failures; verification: cd ../volt-app/Packages/VoltClient &amp;&amp; swift test, app package diff/app design whitespace checks, and root doc diff check passed; app commit 7448f53.</evidence>
  </item>

  <item ref="C.3" status="resolved" prereq="C.1,A.2">
    <title>Align Forget Host and endpoint identity behavior with one-host v1 and future multi-host support</title>
    <acceptance>Forget Host deletes the selected saved host record; one-host v1 clears endpoint identity only according to A.2; future multi-host behavior is not blocked by current storage; tests cover Forget Host, endpoint identity retention/clearing, and re-pair behavior after forget.</acceptance>
    <evidence>2026-06-22: iOS Forget Host now uses an explicit endpoint identity reset path, clears saved-host issue state with the selected saved record, preserves endpoint identity for client_unknown/client_revoked outcomes until intentional forget, and an Iroh transport regression proves reset rotates the client node ID for later re-pair; verification: cd ../volt-app/Packages/VoltClient &amp;&amp; swift test, app package diff/app design whitespace checks, and root doc diff check passed; app commit b9ed40e.</evidence>
  </item>

  <item ref="C.4" status="resolved" prereq="C.2,C.3">
    <title>Add app UI affordances for saved host, offline, and Pair Again flows</title>
    <acceptance>Settings or connection UI shows saved host status, Host offline, Retry, Forget Host, Pair Again where appropriate, and does not make QR scanning the main path for ordinary offline states; simulator or Swift tests cover visible state decisions where possible.</acceptance>
    <evidence>2026-06-22: iOS Settings now shows saved-host status, issue detail, Retry, Forget Host, and Pair Again only for invalid/mismatched/unknown/revoked/expired/consumed states while Host offline uses Retry instead of QR scanning; Chat header shows saved-host issue detail and Host offline warning state; verification: cd ../volt-app/Packages/VoltClient &amp;&amp; swift test, XcodeBuildMCP test_sim on Volt scheme with iPhone 17 Pro iOS 27.0, app package diff/app design whitespace checks, and root doc diff check passed; app commit 79a7af7.</evidence>
  </item>
</group>

<group n="4" title="Docs and validation">
  <item ref="D.1" status="open" prereq="B.4,B.5,B.6,C.2">
    <title>Update root and app docs for saved-host pairing behavior</title>
    <acceptance>Root docs and app README/design docs describe Pair Phone, one-time QR, saved-host reconnect, default relay policy, revocation/re-pair behavior, offline states, host state path, and known limitations. Docs avoid implying QR is needed after ordinary reconnect.</acceptance>
    <evidence/>
  </item>

  <item ref="D.2" status="open" prereq="B.1,B.2,B.3,B.4,B.5,B.6,C.4,D.1">
    <title>Run final automated and manual saved-host validation</title>
    <acceptance>Final evidence lists exact targeted Vitest files, `npm run iroh:poc:test`, `npm run check`, Swift package tests, iOS simulator tests, doc checks, native Iroh saved-host smoke, and iOS saved-host smoke. Manual evidence covers pair once, relaunch app without launch ticket, reconnect without QR, restart host with same state path, reconnect without QR, revoked phone behavior, and relay mode used. Unsupported cases are documented without overclaiming.</acceptance>
    <evidence/>
  </item>

  <item ref="D.3" status="open" prereq="D.2" type="rollup">
    <title>Rollup: saved-host pairing is implemented, tested, documented, and ready for preview use</title>
    <acceptance>All prior items are resolved; root and app design docs record final behavior and limitations; no open saved-host pairing implementation decisions remain except explicitly deferred future work; final automated and manual validation evidence is recorded.</acceptance>
    <evidence/>
  </item>
</group>

</work_queue>

</goal>
