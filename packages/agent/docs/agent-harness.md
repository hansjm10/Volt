# AgentHarness architecture and lifecycle

`AgentHarness` is the sole reusable stateful orchestrator in `@hansjm10/volt-agent-core`. It owns transactional delivery, runtime configuration, session coordination, hook settlement, provider request policy, and the lifecycle around the low-level loop.

## Ownership boundary

- `agent-loop.ts` is the stateless execution kernel. It executes one dispatched run against an explicit context and callback configuration.
- `AgentHarness` owns reusable state: session access, delivery queues, one exclusive operation coordinator, runtime configuration, resources, hooks, provider settings, and persistence ordering.
- Applications own product policy. For example, Coding Agent's `AgentSession` privately hosts an `AgentHarness` while retaining planning, durable client-input admission, retries, compaction policy, extensions, RPC, and UI projections.

There is no second stateful core runtime. Hosts should use `AgentHarness` or intentionally own the complete low-level loop contract themselves.

## State model

Harness state is split into five categories.

### Runtime configuration

The latest application configuration includes:

- optional model
- thinking level
- all tools and active tool names
- resources
- system prompt or system-prompt provider
- stream options and provider auth resolver
- steering and follow-up modes

Getters return current configuration. Setters affect future turn snapshots and do not mutate an in-flight provider request.

A model may be unset during construction. Prompt and continuation preflight reject if provider work requires a model before one is selected.

### Turn snapshot

`createTurnState()` resolves one concrete request snapshot:

- persisted session context or an explicit run context override
- resources
- system prompt
- model and thinking level
- all tools and the active subset
- stream options
- session ID

A provider request uses one snapshot. Save-point configuration changes are reflected when the next request snapshot is created. Harness synchronously reserves the bounded run before snapshot construction or any system-prompt preflight. Immediately before provider invocation it reconciles the canonical projection cursor and snapshots the runtime configuration epoch; later changes apply to the next request.

### Session

The supplied `Session` is the persisted conversation authority. Harness session writes never rely on a second transcript cache. `Session.getBranchSnapshot()` returns a store-issued `ProjectionCursor`, and `Session.commitBatch()` accepts only declarative append/move mutations guarded by an exact or descendant cursor. The runtime `SessionStorage` contract exposes no imperative append or leaf setter; identity-preserving import/bootstrap work belongs to a concrete repository boundary.

Storage implementations must preserve:

- canonical entry IDs returned from append
- parent relationships
- atomic leaf changes and structural batches
- append order
- metadata
- committed, rolled-back, and uncertain outcome classification
- store-verifiable mutation receipts bound to optional delivery attribution

A host adapter may filter application-only entries when projecting the generic Harness session view, but the host's canonical store remains authoritative.

### Delivery inbox and active run

Prompt, steering, and follow-up deliveries share one inbox with stable IDs. The shared `HarnessOperationCoordinator` owns each run, compaction, or tree operation through `admitted -> executing -> terminalizing -> notifying -> settled`. The active operation owns:

- run ID and phase
- abort controller and first accepted abort source
- current delivery attempt and settlement barrier
- ordered delivery outcomes
- terminal event settlement

Operation ownership starts synchronously before turn snapshot construction, the configured `systemPrompt` callback, and `before_agent_start` preflight. Both callbacks receive the operation's `AbortSignal`. The abort gate remains open through intermediate delivery and tool commits and seals only immediately before the terminal assistant commit. `activeRunSnapshot` is immutable.

### Continuation

Harness continuation state stores only a canonical basis cursor, owned overlay messages, overlay epoch, and mode. Canonical descendants are reconciled through `ProjectionAdvance`: provider-visible appends extend the overlay, provider-inert or policy-only changes advance its cursor, and divergence or rewrite invalidates an arbitrary frozen overlay. Compaction explicitly installs its committed replacement; tree navigation clears the overlay. Callers use bare `continue()` to retry the same retained delivery identity. Explicit context remains caller-independent owned data.

## Transactional delivery

Delivery follows one owner-coordinated state machine.

1. Admission snapshots the structured `AgentMessage` payload and assigns a stable ID.
2. Selection creates a fresh attempt ID without consuming the logical delivery.
3. The installed `AgentDeliveryOwner.prepareLogical()` performs side-effect-free transformation or validation. One successful immutable result is cached for retained retries.
4. Harness crosses the synchronous revocation cutoff and invokes `commitAttempt()`.
5. The owner commits canonical state atomically or returns a store-verifiable no-effect receipt.
6. Harness verifies receipt authority, delivery attribution, and the exact projection advance before provider work.
7. `finish()` receives the fixed outcome for passive host projection cleanup.
8. Committed delivery events publish before request preparation; retained, revoked, and terminal outcomes remain ordered.

Owner outcomes:

- `committed`: the delivery is canonical and provider work may proceed.
- `retained`: all coupled effects were definitively rolled back; restore the same delivery for explicit retry.
- `terminally_failed`: replay safety cannot be proven; consume the delivery and stop.
- thrown/rejected preparation or commitment: normalized to `terminally_failed` unless an explicit verified no-effect result proves retention.
- `revoked`: explicit revocation won before settlement began.

An owner installed at admission owns canonical persistence for its prepared delivery. Harness must not append those messages a second time. The built-in owner uses the same guarded session batch and receipt path.

Preparation, owner, committed-delivery, and subscriber payloads are cloned. Every asynchronous completion checks inbox epoch and attempt ID. Mutation of one projection cannot alter retained inbox data, canonical persistence, or provider input.

## Bounded runs

`run()` accepts one structured message or an ordered message array. `runPrompt()` is the text convenience form. Both return `AgentRunResult`:

- `completed`: the run settled without a retained or terminal delivery failure.
- `delivery_failed`: includes the first failure and all ordered delivery outcomes observed in the bounded run.

Committed and revoked prefixes remain visible even if a later delivery retains or fails terminally.

`prompt()` returns the required assistant response and is convenient when the caller does not need the delivery outcome surface.

A canceled-preflight or retained prompt remains pending until `continue()` retries it or `discardPendingPrompt()` revokes it. Its effective context and system-prompt projection, including any committed delivery prefix, carry into bare `continue()` so retry does not fall back to canonical/default state. Continuations may also supply an explicit context override, allowing hosts to keep canonical error messages persisted while omitting them from the next provider request.

## Abort and teardown

`abort(source?)` is synchronous intent. It returns `AgentAbortAcceptance` immediately and signals the active run without waiting for settlement.

Rules:

- the first accepted source wins
- repeated abort calls do not replace provenance
- queued steer/follow-up work is not implicitly cleared
- explicit revocation remains separate
- runtime-abort diagnostics are applied after message replacement so hooks cannot erase provenance
- system-prompt and `before_agent_start` preflight receive the active signal
- `waitForIdle()` covers preflight callbacks, terminal listener settlement, and failure cleanup

Terminal teardown should:

1. call `requestClose(source)` or its fence-only `dispose()` alias
2. synchronously clear host streaming and pending-tool projections
3. await `waitForClosed()` from external lifecycle code
4. release remaining host resources after their producer drains

Close rejects new admissions and canonical mutations, revokes only deliveries that have not started commitment, and waits for any commit that already crossed its boundary. Queue APIs include awaited `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`, and `discardPendingPrompt()`. Callback code may call `requestClose()` but must not join `waitForClosed()` from the operation that closure is waiting on.

## Dispatcher and continuation authority

Harness implements the low-level next-action protocol:

- `request` authorizes a provider request and may carry deliveries
- `stop` terminates the bounded run
- `pause` preserves continuation intent for a higher orchestrator

Queue selection happens before delivery leasing:

1. prompt and steering selection
2. independent provider/tool continuation when already authorized
3. follow-up selection when no independent request remains, or when explicitly prioritized

Scoped next-action policies reduce an evolving suggested action in registration order. Policy-generated deliveries are combined with leased inbox deliveries. Runtime-owned `final_response` authority remains tool-free across pause, retry, and compaction continuations. Policy may pause that request but cannot weaken it to an ordinary request or stop.

## Persistence and save points

Harness persists ordinary finalized messages exactly once. For an owner-managed delivery, the owner's canonical transaction is the only delivery append.

Before each provider request Harness:

1. settles selected delivery transactions and awaits durability
2. awaits a stable runtime-configuration epoch and resolves auth for that model
3. applies ordered hooks outside the canonical mutation lane
4. discards that attempt's patches if a hook changes the configuration epoch, retains one staged logical set of Harness-owned appends, and retries the hook against the new epoch
5. reconciles the projection cursor, converts messages, and verifies the epoch again
6. begins the configured `StreamFn` synchronously and releases the provider-admission barrier

`before_provider_request` handlers may replay when they change runtime configuration. They must be replay-safe. Same-value configuration setters are no-ops during replay, so an unconditional hook that selects its desired model or thinking level stabilizes. Patches come only from the final authorized attempt. Harness-owned appends remain staged through conversion and must be structurally identical on every replay; Harness commits that logical set exactly once under the final provider-admission fence and closes on a mismatch.

After a successful turn, message and tool-result persistence completes before the next action is leased. Save-point refresh lets changes to model, thinking level, tools, resources, system prompt, and stream options affect a later request in the same run.

## Hooks and finalized observation

`on(eventType, handler)` registers ordered mutation policy. Event-specific reducers define how results compose:

- context and message hooks replace the current value
- tool-call hooks reduce block/reason decisions
- tool-result hooks reduce content, details, error state, and disposition
- provider-request and provider-payload hooks transform the evolving request
- next-action policies reduce the evolving suggested action

Handlers receive cloned input and run in registration order. Hook failures are normalized to Harness errors and settle through the run's failure path.

`message_end` hooks run before persistence. Replacements must preserve message role. Runtime-abort and delivery-transaction diagnostics are applied after replacement.

`subscribe(listener)` observes finalized cloned events. Subscribers are passive for committed delivery and terminal projections: failure, rejection, mutation, or a returned value cannot alter canonical outcomes or suppress later subscribers.

Provider transport streaming remains decoupled from downstream event settlement by `AssistantMessageStream`, so lifecycle ordering can be awaited without blocking the network reader.

## Provider seams

Harness accepts a configurable `StreamFn`, message converter, auth resolver, and stream options. Request snapshots preserve:

- transport
- timeout and WebSocket connect timeout
- inference speed
- retry count and maximum retry delay
- thinking budgets
- cache retention
- environment
- headers
- metadata

Auth headers/environment are resolved per provider request and merged with snapshotted options. Ordered provider hooks run before request, payload, and response use.

## Tools

Harness stores all tool definitions separately from the active subset. Tool changes are validated for unique names and known active names.

Tool execution uses the low-level loop:

- tool calls are validated before execution
- `tool_call` policy may block
- sequential and parallel batches preserve source-order transcript artifacts
- `tool_result` policy runs before final tool events and persistence
- successful `final_response` disposition requests one bounded tool-free response
- `stop` disposition ends when the batch reducer selects it

Active tool executions are exposed through finalized runtime events; application layers may maintain read-only UI/RPC projections without mutating Harness internals.

## Structural operations

Compaction and tree navigation use the same exclusive `HarnessOperationCoordinator` as runs. Expensive summarization and hooks remain abortable and execute outside the canonical mutation lane. Immediately before the one structural commit, Harness checks lifecycle, operation ownership, signal, and expected projection cursor, seals the abort gate, and submits a noncancelable guarded batch. Close after that seal waits for the structural commit and suppresses passive events.

Manual compaction reserves the next operation, aborts an open run, and promotes after it settles; close cancels the handoff. Tree navigation remains fail-fast while busy. Applications may retain their own summarization and tree policy, but Harness owns operation admission, abort, seal, and commit ordering. Successful compaction installs a replacement continuation overlay; tree navigation clears it because the active branch changed.

## Low-level loop contract

`agentLoop()` and `agentLoopContinue()` are appropriate only when a host owns all orchestration responsibilities. The low-level loop provides:

- ordered lifecycle events
- request preparation
- explicit next actions and request authority
- delivery begin outcomes
- context conversion
- tool execution and disposition reduction
- provider streaming

It does not provide Harness inboxes, session persistence, lifecycle snapshots, abort provenance retention, hook reducers, or passive subscriber isolation.

## Tests

Use the `volt-ai` faux provider for deterministic Harness and provider tests.

Focused suites are organized under `packages/agent/test/harness/`:

- `agent-harness-delivery-transaction.test.ts`
- `agent-harness-lifecycle.test.ts`
- `agent-harness-policy.test.ts`
- `agent-harness-stream.test.ts`
- `agent-harness.test.ts`

Commands:

```bash
npm run test:harness
npm run coverage:harness
```

Harness coverage includes `src/harness/**/*.ts` and `src/agent-loop.ts`. Type-only contracts are excluded from runtime coverage.

Related design references:

- [Hook design](./hooks.md)
- [Observability](./observability.md)
- [Durable Harness recovery](./durable-harness.md)
