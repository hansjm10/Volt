# Plan-mode lifecycle proof of concept

This proof of concept separates plan authoring from approved execution so an executing agent cannot repeatedly rewrite the scope it is meant to finish.

## Lifecycle

The persisted plan wire shape remains unchanged. Legal transitions are enforced when state is committed:

```text
no plan -> draft -> ready -> active -> completed
                  |        |
                  |        +-> draft (explicit replan; approval removed)
                  +-> draft (user requests changes)

ready -> handed_off (clear-context execution source)
```

- `draft` and `ready` have no execution metadata.
- `active`, `completed`, and `handed_off` require execution metadata.
- Entering Plan mode during active execution is treated as an explicit replan transition, not a mode-only mutation.
- Entering Plan mode after completion or handoff starts a new plan.
- Every transition is revision-fenced and every committed state passes the same semantic parser used for restored state.
- Asynchronous mode, activation, and handoff requests commit in invocation order. Toggle targets are derived only when their queued transition starts, after earlier transitions have settled.

## Tool split

Planning exposes operations authorized by a host-owned research capability profile:

- workspace and network reads
- vetted process inspection through the structured `inspect` tool
- explicitly trusted MCP discovery and reads
- `update_plan`, which completely replaces only a draft checklist
- `submit_plan`, which moves a researched draft to `ready`

Unrestricted Bash, workspace/network writes, delegation, extension/custom operations, and unresolved mixed-tool actions are not granted. Before a Plan-to-Build transition commits, Volt awaits unrestricted eager/keep-alive MCP startup, rebuilds direct MCP definitions from fresh tool metadata, and resynchronizes requested Build tools under the session's allow/exclude policy. MCP tools, resources, and prompts carry independent freshness timestamps, so a restricted resource-only refresh cannot promote stale tool metadata. Concurrent partial refresh commits merge against the latest cached categories. Build is not exposed while restoration is still running.

Approved execution exposes:

- normal Build tools
- `update_plan_progress`, which can change only status and notes for existing step IDs
- `request_replan`, which pauses execution, removes execution metadata, returns the plan to `draft`, and terminates the current run

Approved title, summary, step IDs, text, order, and cardinality are therefore structurally inaccessible to the execution progress tool. Completing every step moves the plan to `completed` and removes both execution-only plan tools from the active tool set.

Exact no-op draft and progress updates are rejected so repeated calls cannot consume revisions without making progress.

## Exploration first

The trusted Plan-mode prompt directs the model to investigate relevant code, configuration, tests, documentation, or history before drafting; resolve discoverable repository facts before asking questions; distinguish evidence from assumptions; compare meaningful alternatives; and include verification criteria.

`submit_plan` is blocked at the model tool boundary until the current runtime has observed a successful operation that resolved to a research-evidence capability (`workspace.read`, `network.read`, or `integration.read`). That evidence remains valid when ordinary user feedback, including feedback queued during submission, returns the researched ready plan to draft in the same conversation generation, so a focused revision can be resubmitted without an unrelated read. Fresh Plan-mode entry, execution replanning, tree navigation, and a resumed draft must perform a new exploration call before submission. Direct SDK state-transition methods remain deterministic and do not synthesize tool evidence.

The research surface includes non-mutating LSP actions. LSP uses argument-sensitive resolution, so `rename`, `fix`, and unknown future actions fail closed. Repository inspection similarly resolves only validated Git/GitHub operations after building direct argv; each Git operation uses a positive option grammar, branch/tag listing cannot be negated, and repository-configured helpers are disabled. MCP calls require explicit per-server `trustedReads` evidence that remains effective under normal include/exclude filters. Restricted eager startup, connect, list, describe, and pre-call refreshes request only configured tool/resource metadata categories and never list prompts; tool list/describe requires configured trusted tools rather than resource trust alone. Restricted calls refresh and revalidate the exact tool's configured trust, `readOnlyHint`, and separator-aware risk immediately before invocation. Protocol-level failed MCP results remain structured but become failed top-level tool results, so they cannot satisfy the research gate.

## Operation authorization

Capability resolvers are registered only by trusted host code and remain separate from public `ToolDefinition`, so extensions and SDK callers cannot self-attest. Plan selects the reusable research grant profile; another future Review/Explore mode can reuse that profile or a subset without adding mode flags to tools.

Discovery advertises a mixed tool when at least one operation is compatible with the profile. Every concrete call is resolved again from its final arguments after extension `tool_call` hooks, preventing an allowed read from being transformed into a write at the last boundary. Unknown tools and operations fail closed under restricted profiles. Successful resolved capabilities—not tool names—drive the exploration gate.

## Cache-safe model context

Plan state is not rendered into the system prompt or appended ephemerally to every provider request. The system prompt contains only static policy selected by mode and phase, so draft and progress revisions leave provider instructions byte-identical.

Canonical state reaches the model through append-only context:

- planning tool results return plan ID, revision, phase, and steps
- both execution strategies persist one complete activation checkpoint from the active plan, including actual statuses and notes
- host-driven transitions such as Change Plan and manual Plan-mode re-entry persist a checkpoint
- compaction appends a fresh checkpoint after the new context boundary
- restoration adds a checkpoint only when the current revision is absent from retained tool results or prior checkpoints

This preserves Codex WebSocket continuation and provider prefix caching during ordinary planning and execution turns. Mode, phase, or tool-policy boundaries may still cause one intentional cache miss.

## User-feedback delivery

Direct prompts, steering, and follow-ups use the same Agent delivery inbox. Runtime delivery IDs identify queue admission and commit independently of external `clientMessageId` values, which remain unchanged for canonical persistence and client idempotency.

Ready-plan feedback uses one staged transaction for direct prompts, steering, and follow-ups. Delivery preparation captures the ready revision without mutating planning state or composing a checkpoint. Synchronous delivery begin then transfers ownership, commits one ready-to-draft transition for the admitted batch, rebuilds the Plan tool surface, and prefixes one checkpoint before the first user message. Feedback revoked before begin leaves the ready plan and transcript unchanged; feedback observed after `delivery_start` is authoritative.

System-prompt ownership remains separate across that transition. `before_agent_start` may supply one logical-invocation override; tool and planning rebuilds update only the host base, then one composer reapplies the invocation override and trusted Plan policy for every provider request and automatic continuation.

Preparation alone does not remove an admitted message. The shared delivery inbox keeps entries queued or leased and revocable until a synchronous begin operation atomically transfers ownership. Queue clearing returns exact revoked runtime IDs; preparation failure rolls back only unbegun leases ahead of concurrently admitted work. Abort, disposal, queue clearing, and tree-generation fences retain their durable admission semantics without repurposing external client IDs.

## Deliberately deferred

This POC does not yet add:

- a persisted research-evidence/provenance record; the submission gate is runtime-local
- a configurable Plan-mode turn, tool-call, or structural-revision budget
- semantic no-progress detection beyond exact duplicate updates
- extension/custom or delegated research operations; public tool schemas are intentionally not accepted as authorization evidence
- a user-facing allow/ask/deny policy language layered over the capability substrate

Additional research surfaces should be expanded through trusted host operation resolvers rather than tool names, self-attested metadata, or prompt instructions. A later hardening pass can add persisted evidence and configurable budgets without weakening the frozen-plan boundary.
