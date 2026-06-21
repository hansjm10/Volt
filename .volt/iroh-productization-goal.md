<goal name="iroh-remote-productization-preview">

<context>
This file is the operating manual and work ledger for a Volt /goal run that moves
Iroh remote access from experimental proof-of-concept to supported preview quality.
The paired design document is `.volt/iroh-productization-design.md`; treat that file
as the SPEC (architecture, security model, open decisions, full acceptance criteria)
and this file as the TURN LEDGER (ordered queue, per-turn protocol, item status,
and evidence). Both files must be updated when a queue item is resolved.

Suggested goal prompt:
/goal Work through .volt/iroh-productization-goal.md, exactly one queue item per
goal turn, following the protocol in that file. Do not mark the goal complete until
every item in its work_queue has status="resolved". Commit after each resolved item
using the commit rules in the goal file.

If the user invokes this goal without explicit commit authorization, follow the repo
rule "Never commit unless the user asks": do all non-commit protocol steps, stop
before committing, and say which explicit paths are ready to stage.
</context>

<turn_definition>
A turn is one agent run from start until the final response is sent and the agent
becomes idle. Exactly ONE selectable work_queue item is worked per turn. If the
selected item finishes quickly, still stop after updating the ledgers and committing
(or stopping before commit when not authorized). Do not start another item in the
same turn.
</turn_definition>

<protocol>
  <step n="1" name="preflight">
    Run `git status --short`. Confirm the only unrelated dirty files are the
    out-of-scope files named in working_tree_rules, plus any in-progress files from
    a prior partial turn on the item you are about to re-select. If any other
    surprise dirty file exists, do not select an item: report the unexpected state
    and stop the turn.
  </step>

  <step n="2" name="select">
    Read the work_queue below. Select the FIRST item with status="open" whose
    prereq items, if any, all have status="resolved". Treat status="blocked" as
    not selectable. Items with type="rollup" are never selected directly; see
    rollup_rule. Work only the selected item this turn.
  </step>

  <step n="3" name="read_spec">
    Open `.volt/iroh-productization-design.md` and read the selected item's relevant
    SPEC sections in full. Also read the current implementation files that own the
    behavior before editing them; for Iroh this usually includes files under:

    - `packages/coding-agent/src/core/remote/iroh/`
    - `packages/coding-agent/src/core/rpc/iroh-transport.ts`
    - `packages/coding-agent/src/modes/rpc/iroh-remote-*.ts`
    - `packages/coding-agent/src/remote/iroh-host.mjs`
    - `packages/coding-agent/src/main.ts`
    - `packages/coding-agent/examples/remote/iroh-sidecar/`
    - `scripts/iroh-sidecar-*.mjs`

    Use LSP tools per &lt;lsp_usage/&gt; for semantic questions before changing shared
    TypeScript symbols. Use text search only to discover candidate files or where no
    language server covers the file, such as `.mjs` scripts.
  </step>

  <step n="4" name="implement">
    Normal items: implement the SPEC behavior faithfully and add or extend tests
    that would have failed before the fix and pass after it. Keep native Iroh
    dependency loading isolated from normal CLI startup. Preserve read-only remote
    defaults unless the selected item explicitly changes an authorization policy.

    type="decision" items: make the decision explicitly, record the decision and
    rationale in both ledgers, and implement only the code/docs needed by that
    decision in the same turn. A recorded defer/keep decision counts as resolving
    the item only if it includes enough rationale and acceptance notes for a future
    implementer.

    If the item requires native Iroh behavior, gather evidence per
    &lt;native_iroh_evidence/&gt; before committing to a design.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then run
    the commands in &lt;verification/&gt;. All required checks must pass before the item
    may be marked resolved; verification commands, not LSP diagnostics, are
    authoritative.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/iroh-productization-design.md`: update the relevant SPEC section,
    graduation checklist, and/or open decision with `Resolved YYYY-MM-DD:` plus the
    concrete fix or decision. Do not silently delete unresolved requirements; if the
    selected item reveals new scope, add a new open item instead.

    This file: set the selected item status="resolved" and fill its &lt;evidence&gt;
    with one concise line containing what changed, what verification ran, and the
    commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If commit authorization is present, stage only files changed for the selected
    item, by explicit path. Never use `git add -A` or `git add .`.

    Commit message format:
    code fix:          fix(coding-agent): resolve Iroh productization §REF — &lt;short summary&gt;
    docs-only/decision: docs(coding-agent): record Iroh productization §REF — &lt;short summary&gt;
    partial progress:  fix(coding-agent): Iroh productization §REF partial — &lt;short summary&gt;

    If commit authorization is absent, do not commit. Leave the item status open
    unless the user explicitly accepts non-committed ledger updates; report the
    paths ready to stage and stop.
  </step>

  <step n="8" name="stop">
    Summarize what changed and what verification ran, then end the turn.
  </step>
</protocol>

<verification>
  <when_changed kind="code">npm run check</when_changed>
  <when_changed path="packages/coding-agent/test">cd packages/coding-agent; node node_modules/vitest/dist/cli.js --run &lt;specific changed or affected test files&gt;</when_changed>
  <when_changed path="packages/coding-agent/src/core/remote/iroh packages/coding-agent/src/core/rpc/iroh-transport.ts packages/coding-agent/src/modes/rpc packages/coding-agent/src/remote scripts/iroh-sidecar-*.mjs packages/coding-agent/examples/remote/iroh-sidecar">npm run iroh:poc:test</when_changed>
  <when_changed path="packages/coding-agent/docs packages/coding-agent/README.md .volt">git diff --check -- &lt;changed docs paths&gt;</when_changed>
  <manual when="relay_behavior_changed">Run a cross-network or at least two-network `--relay default` host/client smoke test and record environment, command, and result in evidence. If no real relay environment is available, mark the selected relay-validation item blocked rather than pretending local tests cover it.</manual>
  <notes>
    `npm run check` is required after code changes and must be run from the repo root.
    If a test file is created or modified, run the specific test file and iterate
    until it passes before running broader checks. Do not run the full vitest suite
    directly; use specific vitest files or `./test.sh` only when appropriate.
  </notes>
</verification>

<lsp_usage>
Volt has LSP tools available through the `lsp` tool with actions such as
`definition`, `references`, `hover`, `symbols`, `diagnostics`, `rename`, and `fix`.
Prefer LSP over grep/read whenever the question is semantic: who calls this, where
is this symbol defined, what type is this, or what breaks if this signature changes.

Per-turn usage:

- While reading the selected item, use `lsp.symbols` to locate the relevant TS
  symbol when the file is not obvious.
- Before changing a shared TS symbol's behavior or signature, call
  `lsp.references`; every caller is potentially a test or behavior surface that
  must be considered in the same turn.
- For renames, use `lsp.rename`, not find-and-replace.
- After editing, run `lsp.diagnostics` on each changed TS/TSX file.
- `.mjs`, `.cjs`, Markdown, and shell scripts may not have semantic LSP coverage;
  text-inspect those files and mention that in evidence when relevant.
- A timeout or no-server result is not a blocker; fall back to reading/searching
  the file and record the fallback if it matters.
</lsp_usage>

<native_iroh_evidence>
Use native Iroh evidence when the selected item depends on endpoint-ticket behavior,
relay behavior, native stream lifecycle, or active connection handling.

Evidence sources:

- Automated local scenario suite: `npm run iroh:poc:test`.
- Focused source tests under `packages/coding-agent/test/*iroh*`.
- Manual same-machine host/client smoke test with `npm run iroh:poc:host:volt` and
  `npm run iroh:poc:client`.
- Manual relay test with `--relay default` on two networks when relay behavior is
  part of the item.
- Minimal direct inspection of `@number0/iroh` types/API in `node_modules` when an
  item depends on native API shape. Do not guess external API behavior.

Rules:

- Do not add `@number0/iroh` imports to TypeScript core modules.
- Do not move native loading out of `src/remote/iroh-native-adapter.cjs` and
  `src/remote/iroh-host.mjs` unless the selected item explicitly changes the
  packaging architecture.
- If optional native dependency is unavailable in the local environment, document
  the blocker on the selected item. Do not mark native-dependent behavior resolved
  from unit tests alone.
- Do not include secrets, provider API keys, raw tickets, or local private paths in
  committed evidence. Redact or summarize.
</native_iroh_evidence>

<working_tree_rules>
Expected out-of-scope dirty files during productization turns: none.

This setup turn may leave `.volt/iroh-productization-design.md` and
`.volt/iroh-productization-goal.md` uncommitted until the user decides whether to
commit the planning documents. Future implementation turns should treat these two
files as in-scope only when updating ledgers for the selected item.

Multiple Volt sessions may share the same worktree. Never stage or commit files you
did not modify for the selected item. If `git status --short` shows unrelated dirty
files, stop before selecting work.
</working_tree_rules>

<partial_progress_rule>
If the selected item is too large to finish in one turn but coherent progress is
possible, this is not a block. Work only that item, keep it status="open", add a
`&lt;progress date="YYYY-MM-DD"&gt;` child describing what changed and what remains,
run the verification required for the files changed, and commit only coherent
completed progress if commit authorization is present. The next turn will re-select
this same item because it remains the first selectable open item.
</partial_progress_rule>

<rollup_rule>
Items with type="rollup" are never selected directly. When a turn resolves the
final prerequisite of a rollup item, mark the rollup resolved in this file and
update the design doc checklist during that same turn. Do not spend a separate turn
on a rollup item.
</rollup_rule>

<blocked_rule>
If the selected item cannot proceed at all, or its remaining portion cannot proceed
because required evidence, credentials, a supported platform, or a human product
decision is unavailable:

1. Do whatever portion is achievable without the blocker, following
   partial_progress_rule.
2. Add a `Blocked YYYY-MM-DD:` note to `.volt/iroh-productization-design.md` under
   the relevant section and set this file's item status="blocked" with a
   `&lt;blocker&gt;` child explaining what is needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and the final turn's required verification passed.
</completion_rule>

<work_queue>

<!-- Ordered queue. Select the first open item whose prereq items are resolved.
     Resolved item format:
     <item ref="A.1" status="resolved" prereq="">
       <title>...</title>
       <acceptance>...</acceptance>
       <evidence>Resolved YYYY-MM-DD: what changed; verification; commit sha</evidence>
     </item>
     Partial progress format:
     <item ref="A.1" status="open" prereq="">
       <title>...</title>
       <acceptance>...</acceptance>
       <progress date="YYYY-MM-DD">what changed; what remains</progress>
       <evidence/>
     </item> -->

<group n="1" title="Security and authorization blockers">
  <item ref="A.1" status="resolved" prereq="">
    <title>Persist and enforce per-client allowedTools: new clients store pair-time tools, reconnecting clients use persisted tools, and host restart flags cannot silently broaden an existing client's tool grant</title>
    <acceptance>Existing state files still parse; newly paired clients persist allowedTools; reconnect authorization returns persisted client.allowedTools; existing clients do not get bash/edit/write from a broader host --allow-tools; unit tests cover pairing, reconnect, and state-manager clones; scenario coverage proves a read-only client remains read-only after host restart with unsafe host defaults.</acceptance>
    <evidence>Resolved 2026-06-21: persisted read-only legacy defaults, pair-time tool snapshots, reconnect authorization from client.allowedTools, unit/scenario coverage, and changelog/design updates; verification: lsp.diagnostics on changed TS/test files, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-core.test.ts, npm run iroh:poc:test, npm run check, git diff --check -- .volt/iroh-productization-design.md packages/coding-agent/CHANGELOG.md; commit 125d0d3e</evidence>
  </item>

  <item ref="A.2" status="resolved" prereq="A.1">
    <title>Add unsafe remote tool gates for bash/edit/write grants on host startup and new pairing tickets, with --yes for noninteractive approval and audit logging for accepted unsafe grants</title>
    <acceptance>Unsafe tools are centrally detected; TTY host/pair flows require confirmation unless --yes is present; non-TTY unsafe flows fail without --yes; accepted unsafe grants write an unsafe_tools_enabled audit event; docs and CLI help mention the risk; tests cover safe, unsafe rejected, and unsafe accepted paths.</acceptance>
    <evidence>Resolved 2026-06-21: added shared unsafe tool detection, host startup confirmation/--yes gate, unsafe_tools_enabled audit events, help/docs warnings, unit/CLI/scenario coverage; verification: lsp.diagnostics on changed TS/test files, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-core.test.ts test/remote-cli.test.ts, npm run iroh:poc:test, npm run check, git diff --check -- .volt/iroh-productization-design.md packages/coding-agent/CHANGELOG.md packages/coding-agent/examples/remote/iroh-sidecar/README.md; commit 278e22aa</evidence>
  </item>

  <item ref="A.3" status="resolved" prereq="A.1">
    <title>Harden pairing secret lifecycle so raw secrets are never persisted, consumed secrets cannot be reused across restarts, expired pending secrets are rejected/pruned, and audit events distinguish created/consumed/expired tickets</title>
    <acceptance>State contains only hashes and non-secret metadata; consumed secrets reject after process restart; expired pending tickets reject and are pruned opportunistically; audit covers pairing_ticket_created, pairing_ticket_consumed, and pairing_ticket_expired; tests cover reuse, expiry, and old-state compatibility.</acceptance>
    <evidence>Resolved 2026-06-21: pending pairing tickets persist only sha256 hashes and non-secret metadata, consumed hashes reject after restart, expired pending tickets reject/prune opportunistically, and created/consumed/expired audit events are covered; verification: lsp.diagnostics on changed TS/test files, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-core.test.ts test/remote-cli.test.ts, npm run iroh:poc:test, npm run check, git diff --check -- .volt/iroh-productization-design.md packages/coding-agent/CHANGELOG.md; commit 432d9eda</evidence>
  </item>
</group>

<group n="2" title="First-class pairing workflow">
  <item ref="B.1" status="resolved" prereq="A.1,A.3" type="decision">
    <title>Resolve the Iroh endpoint-ticket model for `volt remote pair`: decide whether pairing can be generated offline, must be mediated by a running host control channel, or should be implemented as a short-lived pair endpoint</title>
    <acceptance>Decision is recorded with direct evidence from @number0/iroh API behavior or a small native smoke; design doc open decision #1 is updated; chosen approach includes user-visible behavior, failure modes, and security implications; no misleading offline pair command is shipped if the endpoint ticket cannot be valid offline.</acceptance>
    <evidence>Resolved 2026-06-21: decided `volt remote pair` must be mediated by a running host control channel; native smoke showed an ID-only persisted-secret ticket had zero direct addresses/no relay and connect failed with no address lookup, while a bound endpoint ticket had a direct address; design records user behavior, failure modes, and security implications; verification: git diff --check -- .volt/iroh-productization-design.md and pre-commit npm run check; commit 9d3aa735</evidence>
  </item>

  <item ref="B.2" status="resolved" prereq="B.1,A.2">
    <title>Implement the core/host pairing-ticket lifecycle according to the B.1 decision, including workspace binding, pair-time allowedTools, label hints, TTL, relay hint, and one-time consumption</title>
    <acceptance>Pairing tickets bind to a saved workspace name; pair-time allowedTools are stored for the eventual client; label hints are applied when the client does not provide a label; TTL is enforced; relay mode is embedded when available; reusing or crossing workspace tickets fails; core tests cover success, expiry, reuse, and workspace mismatch.</acceptance>
    <evidence>Resolved 2026-06-21: core/host pair lifecycle now records pair-time allowedTools, label hints, TTLs, relay hints, workspace binding, one-time consumption, and cross-workspace rejection; verification: lsp.diagnostics on changed TS/test files, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-iroh-core.test.ts, npm run iroh:poc:test, npm run check, git diff --check -- .volt/iroh-productization-design.md packages/coding-agent/CHANGELOG.md; commit bba0ef12</evidence>
  </item>

  <item ref="B.3" status="resolved" prereq="B.2">
    <title>Expose `volt remote pair` in the main CLI with --workspace, --allow-tools, --label, --ttl, --state, --relay, and --yes; stdout must contain only the ticket and stderr must contain diagnostics</title>
    <acceptance>`volt remote pair --workspace &lt;name&gt;` works for saved workspaces under the chosen B.1 model; missing/ambiguous workspace fails with actionable error; unsafe --allow-tools follows A.2 gates; stdout is ticket-only; CLI tests cover argument parsing and failure modes; scenario tests pair a real demo client using the new command or document why host-mediated pairing is required.</acceptance>
    <evidence>Resolved 2026-06-21: added host control-channel pairing and main CLI `volt remote pair` with saved-workspace validation, unsafe grant gates, ticket-only stdout, stderr failures, CLI coverage, and a real sidecar pair-command scenario; verification: lsp.diagnostics on changed TS/test files, node --check packages/coding-agent/src/remote/iroh-host.mjs scripts/iroh-sidecar-test.mjs, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-cli.test.ts, npm run iroh:poc:test, npm run check, git diff --check; commit a6210d50</evidence>
  </item>
</group>

<group n="3" title="Client management and host status">
  <item ref="C.1" status="resolved" prereq="A.1">
    <title>Add `volt remote status` for persisted host state, showing state/audit paths, workspaces, paired clients, per-client tools, last seen timestamps, and a clear persisted-state-only warning when no live host state is available</title>
    <acceptance>Status never prints secrets or secret hashes; output is deterministic and testable; includes workspace names/paths, client labels/node IDs, allowedWorkspaces, allowedTools, pairedAt, lastSeenAt; if live host discovery is absent, output explicitly says persisted state only; docs mention status.</acceptance>
    <evidence>Resolved 2026-06-21: added deterministic JSON `volt remote status` output with state/audit paths, sorted workspaces, client count, client labels/node IDs, allowedWorkspaces, allowedTools, pairedAt, lastSeenAt, persisted-state-only warning, and secret/hash omission tests plus sidecar status scenario/docs; verification: lsp.diagnostics on changed TS/test files, cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/remote-cli.test.ts, node --check scripts/iroh-sidecar-test.mjs, npm run iroh:poc:test, npm run check, git diff --check; commit 431af3d7</evidence>
  </item>

  <item ref="C.2" status="resolved" prereq="C.1" type="decision">
    <title>Decide active revocation semantics: future-connections-only with explicit docs, or live host coordination that disconnects active revoked clients promptly</title>
    <acceptance>Decision is recorded in both ledgers with rationale; if active disconnect is deferred, docs state revocation affects future connections only; if active disconnect is chosen, implementation plan names the control mechanism and lifecycle guarantees; audit event requirements are updated.</acceptance>
    <evidence>Resolved 2026-06-21: chose live host coordination for preview active revocation, with persisted-state revocation as fallback; design names the running host control channel, active connection registry, one-second close guarantee, and `active_connection_revoked` audit requirements; direct @number0/iroh API evidence: Connection.close/closed plus stream stop/reset handles in node_modules/@number0/iroh/index.d.ts; verification: git diff --check -- .volt/iroh-productization-design.md and pre-commit npm run check; commit c36d9dd4</evidence>
  </item>

  <item ref="C.3" status="open" prereq="C.2">
    <title>Implement revocation behavior from C.2 and ensure `volt remote revoke &lt;node-id&gt;` audits the action, prevents reconnect, and handles active connections according to the recorded policy</title>
    <acceptance>Revoked clients cannot reconnect; revoke writes audit with success/failure; active connections are either closed within the documented bound or documented as unaffected until reconnect; tests and/or scenario coverage prove the selected behavior.</acceptance>
    <evidence/>
  </item>
</group>

<group n="4" title="Protocol contract and RPC surface">
  <item ref="D.1" status="open" prereq="A.1,B.2">
    <title>Add an Iroh remote protocol v1 document and compatibility tests for ticket payloads, hello, handshake success/failure, strict LF JSONL framing, initialInput preservation, and outbound redaction guarantees</title>
    <acceptance>`packages/coding-agent/docs/iroh-remote-protocol.md` exists and is linked from docs index and Iroh design doc; test vectors pin ticket and handshake shapes; command/redaction tests fail on unintended v1 changes; docs tell client authors which fields are authoritative and which unknown fields must be ignored.</acceptance>
    <evidence/>
  </item>

  <item ref="D.2" status="open" prereq="D.1" type="decision">
    <title>Decide whether preview remote RPC should allow additional read-only commands such as get_messages, get_commands, get_last_assistant_text, or get_available_models beyond prompt/steer/follow_up/abort/get_state/extension_ui_response</title>
    <acceptance>Decision is recorded with security rationale for each candidate command; if commands are added, `IROH_REMOTE_RPC_PASSTHROUGH_TYPES`, docs, and tests are updated; if kept narrow, docs explain that tool access and RPC command access are separate surfaces.</acceptance>
    <evidence/>
  </item>

  <item ref="D.3" status="open" prereq="D.1">
    <title>Audit and harden outbound remote-safe state/event views so host-only paths remain redacted, workspace paths normalize to /workspace, opaque signatures/image data are preserved, and compatibility tests cover representative RPC events</title>
    <acceptance>Representative get_state, response, extension UI, assistant content, tool-call, export/session/bash-output path cases are covered; redaction does not corrupt image data or opaque signatures; docs list the redaction guarantees; tests cover Windows, POSIX, tilde, file URL, and spaced-path cases where relevant.</acceptance>
    <evidence/>
  </item>
</group>

<group n="5" title="Reconnect and resume">
  <item ref="E.1" status="open" prereq="A.1,D.1" type="decision">
    <title>Decide duplicate active connection behavior for the same client node/workspace: reject the second connection or replace the old connection</title>
    <acceptance>Decision is recorded with mobile UX and safety rationale; handshake failure or replacement behavior is specified; audit events are named; scenario test plan is updated.</acceptance>
    <evidence/>
  </item>

  <item ref="E.2" status="open" prereq="E.1">
    <title>Persist per-client per-workspace last session IDs and update remote runtime creation so reconnecting a paired client resumes the previous session when its session file still exists</title>
    <acceptance>Client state records lastSessionIdByWorkspace or equivalent; runtime can open the previous session for the authorized workspace; missing session file creates a new session and logs session_missing_on_resume/session_created; `get_state` after reconnect returns the resumed session ID; unit tests cover state updates and runtime selection.</acceptance>
    <evidence/>
  </item>

  <item ref="E.3" status="open" prereq="E.2">
    <title>Add reconnect scenario coverage for same-client resume, missing-session fallback, and duplicate active connection behavior from E.1</title>
    <acceptance>`npm run iroh:poc:test` covers reconnecting with the same client state, verifies same session ID after reconnect, verifies new session after deleting the saved session, and verifies duplicate connection behavior; failures produce actionable diagnostics without PHI or raw secrets.</acceptance>
    <evidence/>
  </item>
</group>

<group n="6" title="Docs, packaging boundary, and release readiness">
  <item ref="F.1" status="open" prereq="B.3,C.1,C.3,D.1,E.3">
    <title>Update user documentation for remote host, pair, clients, revoke, status, relay mode, state/audit paths, read-only defaults, unsafe tool warnings, project trust, and Node-only/Bun-binary limitation</title>
    <acceptance>README, docs/usage, docs/index, security docs, Iroh design doc, protocol doc, sidecar README, and changelog are updated; experimental language is either removed or narrowed to explicit unsupported areas; docs include copy-pastable happy path and revocation path; security warnings are prominent.</acceptance>
    <evidence/>
  </item>

  <item ref="F.2" status="open" prereq="F.1">
    <title>Run final validation, including local scenario suite, targeted tests touched by the final docs/code, `npm run check`, and a documented `--relay default` cross-network smoke or explicit blocker</title>
    <acceptance>Final evidence lists exact commands and results; cross-network relay smoke succeeds or the item is blocked with what environment is needed; optional native dependency install failure messaging is verified or documented; no unsupported environment is implied supported.</acceptance>
    <evidence/>
  </item>

  <item ref="F.3" status="open" prereq="F.2" type="rollup">
    <title>Rollup: all graduation checklist items in `.volt/iroh-productization-design.md` are checked, every work_queue item is resolved, and Iroh remote access is ready to be described as supported preview</title>
    <acceptance>All prior items resolved; design doc graduation checklist fully checked; final verification evidence recorded; no open decisions remain unresolved; known unsupported cases are documented.</acceptance>
    <evidence/>
  </item>
</group>

</work_queue>

</goal>
