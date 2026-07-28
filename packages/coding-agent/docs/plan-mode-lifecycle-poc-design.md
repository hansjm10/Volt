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

## Tool split

Planning exposes:

- read-only exploration tools
- `update_plan`, which completely replaces only a draft checklist
- `submit_plan`, which moves a researched draft to `ready`

Approved execution exposes:

- normal Build tools
- `update_plan_progress`, which can change only status and notes for existing step IDs
- `request_replan`, which pauses execution, removes execution metadata, returns the plan to `draft`, and terminates the current run

Approved title, summary, step IDs, text, order, and cardinality are therefore structurally inaccessible to the execution progress tool. Completing every step moves the plan to `completed` and removes both execution-only plan tools from the active tool set.

Exact no-op draft and progress updates are rejected so repeated calls cannot consume revisions without making progress.

## Exploration first

The trusted Plan-mode prompt directs the model to investigate relevant code, configuration, tests, documentation, or history before drafting; resolve discoverable repository facts before asking questions; distinguish evidence from assumptions; compare meaningful alternatives; and include verification criteria.

`submit_plan` is blocked at the model tool boundary until the current runtime has observed a successful read-only exploration call. A resumed draft must therefore perform a fresh exploration call before submission. Direct SDK state-transition methods remain deterministic and do not synthesize tool evidence.

The safe research surface now includes non-mutating LSP actions. Plan mode uses an explicit action allowlist, so `rename`, `fix`, and unknown future LSP actions fail closed.

## Cache-safe model context

Plan state is not rendered into the system prompt or appended ephemerally to every provider request. The system prompt contains only static policy selected by mode and phase, so draft and progress revisions leave provider instructions byte-identical.

Canonical state reaches the model through append-only context:

- planning tool results return plan ID, revision, phase, and steps
- both execution strategies persist one complete activation checkpoint from the active plan, including actual statuses and notes
- host-driven transitions such as Change Plan and manual Plan-mode re-entry persist a checkpoint
- compaction appends a fresh checkpoint after the new context boundary
- restoration adds a checkpoint only when the current revision is absent from retained tool results or prior checkpoints

This preserves Codex WebSocket continuation and provider prefix caching during ordinary planning and execution turns. Mode, phase, or tool-policy boundaries may still cause one intentional cache miss.

## Deliberately deferred

This POC does not yet add:

- a persisted research-evidence/provenance record; the submission gate is runtime-local
- a configurable Plan-mode turn, tool-call, or structural-revision budget
- semantic no-progress detection beyond exact duplicate updates
- read-only git-history access, because the current `bash` tool cannot prove command purity
- MCP, extension, or delegated research tools, because their schemas do not currently carry a host-enforced read-only capability

Those research surfaces should be expanded through operation-level capabilities rather than by trusting tool names or prompt instructions. A later hardening pass can add persisted evidence and configurable budgets without weakening the frozen-plan boundary.
