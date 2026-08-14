# AgentHarness architecture and lifecycle

`AgentHarness` is the sole reusable stateful orchestrator in `@hansjm10/volt-agent-core`. It owns transactional delivery, runtime configuration, session coordination, hook settlement, provider request policy, and the lifecycle around the low-level loop.

## Ownership boundary

- `agent-loop.ts` is the stateless execution kernel. It executes one dispatched run against an explicit context and callback configuration.
- `AgentHarness` owns reusable state: session access, delivery queues, active-run cancellation, runtime configuration, resources, hooks, provider settings, and persistence ordering.
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

A provider request uses one snapshot. Save-point configuration changes are reflected when the next request snapshot is created. Harness admits the bounded run before snapshot construction or any system-prompt preflight, so cancellation and idle ownership already cover those awaits.

### Session

The supplied `Session` is the persisted conversation authority. Harness session writes never rely on a second transcript cache.

Storage implementations must preserve:

- canonical entry IDs returned from append
- parent relationships
- durable leaf changes
- append order
- metadata

A host adapter may filter application-only entries when projecting the generic Harness session view, but the host's canonical store remains authoritative.

### Delivery inbox and active run

Prompt, steering, and follow-up deliveries share one inbox with stable IDs. The active run owns:

- run ID and phase
- abort controller and first accepted abort source
- current delivery lease and settlement barrier
- ordered delivery outcomes
- terminal event settlement

Run ownership starts synchronously before turn snapshot construction, the configured `systemPrompt` callback, and `before_agent_start` preflight. Both callbacks receive the active run's `AbortSignal`. `activeRunSnapshot` is immutable, and `activeDeliverySettlement` exposes the current durability barrier without exposing mutable run internals.

### Continuation

Harness keeps a run-local continuation candidate separate from cross-run continuation state. At dispatcher boundaries it tracks the effective context, request authority, provider-pending state, and system prompt, then extends that projection with each committed delivery prefix. Canceled preflight, preparation or settlement failure, and abort rollback promote the candidate when they leave queued work; pause and final-response paths preserve authority under the existing dispatcher rules. Callers use bare `continue()` to resume that projection and retry the same retained delivery identity. An explicit context override rebases the retained projection without transferring authority ownership to the caller.

## Transactional delivery

Delivery follows a prepare/begin/settle protocol.

1. Admission snapshots the structured `AgentMessage` payload and assigns a stable ID.
2. Selection leases a FIFO prefix without consuming it.
3. `prepareDelivery` receives an isolated copy and performs side-effect-free transformation or validation.
4. Harness crosses the synchronous revocation cutoff.
5. If preparation supplied a participant, Harness invokes `settle()` exactly once and awaits it.
6. A committed delivery is published before request preparation or provider work.
7. Retained, revoked, and terminal outcomes are recorded in delivery order.

Participant outcomes:

- `committed`: the delivery is canonical and provider work may proceed.
- `retained`: all coupled effects were definitively rolled back; restore the same delivery for explicit retry.
- `terminally_failed`: replay safety cannot be proven; consume the delivery and stop.
- thrown/rejected settlement: normalized to `terminally_failed`.
- `revoked`: explicit revocation won before settlement began.

A participant owns canonical persistence for its prepared delivery. Harness must not append those prepared messages a second time. Without a participant, Harness persists committed delivery messages through its session.

Preparation, participant, committed-delivery, and subscriber payloads are cloned. Mutation of one projection cannot alter retained inbox data, canonical persistence, or provider input.

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

Structural teardown should:

1. inspect `activeDeliverySettlement` when durability must settle first
2. call `abort(source)`
3. await `waitForIdle()`
4. explicitly revoke queues if the host is retiring them

Queue APIs include awaited `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`, and `discardPendingPrompt()`. `revokeAllQueues()` exists for hosts that must synchronously revoke runtime ownership before awaiting their own durability barrier; its queue projection is passive.

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

Harness persists ordinary finalized messages exactly once. For a participant-owned delivery, the participant's canonical transaction is the only delivery append.

Before each provider request Harness:

1. finalizes selected deliveries
2. flushes pending session writes
3. resolves the current request snapshot
4. applies ordered context and provider-request hooks
5. converts messages for the provider
6. invokes the configured `StreamFn`

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

Compaction and tree navigation require an idle Harness and operate on persisted session state. They restore phase in `finally` and normalize subsystem failures.

Applications may layer auto-compaction and retry policy around bounded runs. Explicit continuation context is the supported seam when canonical persisted history differs from the next provider request. Successful compaction rebases retained continuation context; tree navigation clears it because the active branch changed.

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
