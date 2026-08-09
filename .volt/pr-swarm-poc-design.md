# PR Agent Swarm PoC

## Status

Experimental repo-only PoC implemented under `.volt/pr-swarm/`. It is not included in any published package.

## Objective

A local TypeScript sidecar watches one same-repository GitHub PR while `voltd` hosts persistent agent sessions and managed worktrees. It reviews unreviewed head commits, fixes every unresolved inline review thread, verifies each fix, pushes accepted batches automatically, handles failed checks, and posts one LGTM comment when the current head is clean.

## Constraints

- Same-repository PRs only; reject forks and closed/draft PRs.
- Poll every 30 seconds; webhooks are deferred.
- One active job per unresolved review thread. New replies update or steer that job.
- Agents never push, resolve threads, or write GitHub comments.
- Every operation is fenced by the exact PR head SHA.
- Normal fast-forward pushes only; never force-push.
- Maximum three fixer jobs and one integration operation per PR.
- Maximum two automated repair attempts per source event and head SHA.

## Components

1. **Sidecar:** owns polling, persisted state, Git operations, GitHub writes, concurrency, and recovery.
2. **Daemon local control/CLI:** creates, lists, and removes managed worktrees and exposes their paths locally.
3. **Daemon Iroh RPC:** opens caller-named worktree sessions, invokes reviews, controls Plan mode, executes approved plans, and resumes sessions.
4. **GitHub CLI/API:** reads PR state and threads, reads checks/logs, pushes through Git, comments, and resolves threads.

Use one dedicated paired automation identity with the minimum RPC capabilities for conversation control/observation and worktree management. Runtime state lives outside the repository at `~/.volt/agent/swarm/<owner>--<repo>--pr-<number>.json` and is written by temp-file replacement under a single-process lock.

## GitHub Poll

Each poll reads:

- `gh pr view`: `state`, `isDraft`, `isCrossRepository`, `headRefName`, `headRefOid`, `headRepository`, and `baseRefName`.
- GraphQL `pullRequest.reviews`: review state and `commit.oid`, paged to completion, to determine whether the current head has been reviewed.
- GraphQL `pullRequest.reviewThreads`: paged thread/comment IDs, resolution state, location, and the original plus newest eight comments within 16 KiB.
- `gh pr checks --required --json` for required-check buckets, joined to REST `commits/{sha}/check-runs?filter=latest` IDs, at most 50 annotations, and a 32 KiB failed Actions log excerpt.

General PR comments are ignored except authenticated Volt idempotency markers. Inputs from GitHub, repository files, and CI logs are untrusted and size-bounded before entering prompts.

## Persisted State

```text
PR: repo, number, headSha, headRefName, phase, reviewRunId, lgtmSha
Job: id, sourceKind, sourceId, lastCommentId, generationSha,
     worktreeId, sessionId, state, attempts, fixCommit, verifierRunId
```

Job states:

```text
detected -> planning -> executing -> verifying -> ready_to_integrate
         -> integrating -> pushed_waiting_ci -> completed
         -> stale | failed | manual
```

A head change marks unfinished jobs stale. Thread jobs remain associated with their thread ID so a swarm-generated push does not duplicate the same unresolved thread while it waits for CI and automatic resolution.

## Review Flow

For a head SHA with no submitted non-dismissed GitHub review referencing that SHA and no pre-existing actionable work:

1. Invoke native `review.pr` through an orchestration conversation.
2. Wait for `workflow_end`, then fetch the durable structured result.
3. If findings exist, publish the review and create jobs directly from finding IDs; do not rediscover the swarm's own comments as new work.
4. If no findings exist, record the clean review and defer LGTM until required checks pass and no actionable threads remain.

## Thread and CI Fix Flow

1. Fetch the PR branch into an exact local ref and assert it resolves to the captured head SHA.
2. Create a deterministic managed worktree and session from that ref.
3. Send `set_agent_mode: plan`, then prompt with the single thread or failed check, exact SHA, scope, validation requirements, and instructions to create one commit without pushing.
4. Wait for an authoritative ready plan and mechanically approve its exact ID/revision with `plan_execute` using `retain_context`.
5. Require one commit based on the captured SHA, a clean worktree, and successful declared validation.
6. If execution requests replanning, expands scope, cannot validate, or needs a product decision, mark the job `manual`.

A failed check run creates one job keyed by check-run ID and head SHA. Logs are limited to failed annotations and a bounded failed-log excerpt.

## Verification and Integration

Verification runs in a fresh conversation bound to the fixer worktree. It invokes detached native `review.commit` on the exact fix SHA with the bounded original concern in `focus`; only a complete, correct, zero-active-finding result for that commit passes.

Accepted commits enter one serialized integration worktree based on the captured head SHA:

1. Cherry-pick each accepted commit; conflicts become `manual`.
2. Run combined validation.
3. Fetch the PR branch and assert its remote head still equals the captured SHA.
4. Push the integration HEAD normally to the PR branch. A rejected or non-fast-forward push makes the batch stale.
5. On the new head, restart review and CI observation.

After required checks pass, reply to each fixed thread with the pushed commit and resolve it with GraphQL `resolveReviewThread`. Reopened threads become actionable again.

## LGTM Condition

Post exactly one deterministic LGTM comment for a head SHA only when:

- Volt's review of that SHA completed with zero findings.
- All required checks passed or were skipped.
- No unresolved actionable thread or remediation job remains.

```md
LGTM — Volt reviewed `abc1234`; all required checks passed.

<!-- volt-swarm kind=lgtm head=<full-40-character-sha> -->
```

## Recovery and Safety

On restart, acquire the state lock, re-read the PR head, list managed worktrees, and reconcile jobs, durable review runs, authenticated markers, and remote heads. Verification may be rerun safely from a retained clean worktree. A prepared push is completed only when both GitHub and the fetched remote prove the intended head was published; ambiguous interrupted execution, integration, or external effects become `manual` rather than being replayed.

Worktrees isolate concurrent changes but are not a security sandbox. Run the PoC only for trusted same-repository PRs and preferably inside a container or VM. Keep GitHub writes in the sidecar and give agent sessions no instruction or authority to modify GitHub.

## Acceptance

A single sidecar run can review an unreviewed PR, create isolated Plan-mode fixes for unresolved inline threads, independently verify them, batch and push without overwriting a moved branch, react to failed checks, resolve successfully fixed threads after green CI, and post one LGTM comment for the final clean head.

## Source-checkout prerequisites

This PoC runs only from a trusted Volt source checkout on Node.js 22.19 or newer. Install the root workspace with optional dependencies and lifecycle scripts disabled:

```sh
npm install --ignore-scripts
```

The optional native `@number0/iroh` package must support the current platform. Start `voltd` from this same source checkout, register the repository root as a daemon workspace, and leave the daemon running. The registered workspace path must resolve to the current Git root. Standalone Volt builds do not include the native daemon/Iroh support required by this sidecar.

Authenticate both control planes before starting:

- Run `gh auth login`, then verify the active account can read the PR, read Actions/check-run data, push the same-repository PR branch, create review comments, reply to review threads, and resolve review threads.
- Configure Volt model credentials for the daemon's selected model provider. The sidecar fails closed if the selected provider has no stored or environment authentication.

On first use, the sidecar requests an explicit local-control pairing ticket for one dedicated identity. It persists the identity key and sanitized reconnect ticket in owner-only files under `~/.volt/agent/swarm/`; a production relay bearer token, when present, is retained separately. Later runs refuse to repair, re-pair, or continue through revoked credentials or grant drift automatically.

## Trust and safety prerequisites

Run only against a disposable or otherwise trusted PR whose head branch belongs to the current repository. Forks, closed PRs, drafts, repository mismatches, and moved eligibility fences are rejected. GitHub text, CI logs, and repository content are untrusted prompt data, but fixer sessions still have `bash` and daemon-inherited credentials may be reachable. Managed worktrees provide edit isolation, not a security sandbox. Prefer a container or VM.

Only repeated `--check` values are executed through a shell; all Git, GitHub, and daemon operations use argv/stdin adapters. Write mode requires at least one trusted validation command. `--dry-run` suppresses review publication, thread replies/resolution, LGTM comments, and pushes, but it can consume model tokens and modify disposable managed worktrees.

## Usage

Run targeted validation first:

```sh
npm run test:pr-swarm:poc
npm run check:pr-swarm:poc
```

Run one dry scheduling cycle against a disposable same-repository PR:

```sh
npm run pr-swarm:poc -- <pr-number> --workspace <registered-name> --once --dry-run
```

Run continuously in write mode with one or more operator-trusted checks:

```sh
npm run pr-swarm:poc -- <pr-number> --workspace <registered-name> \
  --remote origin --poll-ms 30000 \
  --check "npm run check" --check "node path/to/targeted-test.js"
```

Options are exactly:

```text
<pr-number> --workspace <name> [--remote origin] [--poll-ms 30000]
            [--check <command>...] [--once] [--dry-run]
```
