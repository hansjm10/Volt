# @hansjm10/volt-agent-core

Stateful LLM orchestration, transactional message delivery, tool execution, session persistence, and a low-level agent loop. Built on `@hansjm10/volt-ai`.

Maintained and distributed as part of Volt by [Jordan Hans](https://github.com/hansjm10).
Volt is derived from [Mario Zechner's Pi project](https://github.com/badlogic/pi-mono) under the MIT License.

## Installation

```bash
npm install @hansjm10/volt-agent-core@beta
```

## Quick start

`AgentHarness` is the public stateful orchestrator. Node applications also import `NodeExecutionEnv` from the package's `node` entry point.

```typescript
import {
  AgentHarness,
  InMemorySessionRepo,
} from "@hansjm10/volt-agent-core";
import { NodeExecutionEnv } from "@hansjm10/volt-agent-core/node";
import { getModel } from "@hansjm10/volt-ai";

const session = await new InMemorySessionRepo().create();
const harness = new AgentHarness({
  env: new NodeExecutionEnv({ cwd: process.cwd() }),
  session,
  model: getModel("anthropic", "claude-sonnet-4-5"),
  systemPrompt: "You are a helpful assistant.",
});

harness.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const response = await harness.prompt("Hello!");
console.log(response.stopReason);
```

`prompt()` is a convenience API that requires an assistant response. Use `run()` or `runPrompt()` when the caller needs the bounded `AgentRunResult`, including delivery outcomes.

## Ownership model

The package has two execution layers:

- `AgentHarness` is the reusable stateful orchestrator. It owns runtime configuration, queues, transactional delivery, persistence coordination, lifecycle state, hooks, and turn execution.
- `agent-loop.ts` is the stateless execution kernel. Use it only when the host needs to own all state, persistence, event settlement, and request policy itself.

The supplied `Session` is the persisted conversation authority. Harness queues and active-run state are runtime state; committed messages are written to the session.

## Messages and context

`AgentMessage` includes standard LLM messages (`user`, `assistant`, and `toolResult`) plus application messages added through declaration merging.

```typescript
declare module "@hansjm10/volt-agent-core" {
  interface CustomAgentMessages {
    notification: {
      role: "notification";
      text: string;
      timestamp: number;
    };
  }
}
```

Before each provider request, Harness applies context hooks and converts `AgentMessage[]` to provider-compatible `Message[]`. Supply `convertToLlm` when custom messages require application-specific filtering or conversion.

```typescript
const harness = new AgentHarness({
  env,
  session,
  model,
  convertToLlm: (messages) =>
    messages.flatMap((message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult"
        ? [message]
        : [],
    ),
});
```

A turn snapshot fixes the model, thinking level, active tools, resources, system prompt, stream options, and session context used by one provider request. Runtime setters affect future snapshots, not an in-flight request.

## Transactional delivery

Harness admits prompt, steering, and follow-up messages into one stable inbox. A host that owns canonical persistence can attach a participant during side-effect-free preparation:

```typescript
const harness = new AgentHarness({
  env,
  session,
  model,
  prepareDelivery: (delivery) => ({
    messages: [...delivery.messages],
    participant: {
      settle: async ({ deliveryId, kind, messages, requestAbort }) => {
        const result = await persistDeliveryAtomically({ deliveryId, kind, messages });
        if (result === "rolled_back") {
          return { outcome: "retained", error: new Error("Persistence rolled back") };
        }
        if (result === "ambiguous") {
          requestAbort("disposal");
          return {
            outcome: "terminally_failed",
            error: new Error("Persistence outcome is ambiguous"),
          };
        }
        return { outcome: "committed" };
      },
    },
  }),
});
```

Preparation must not mutate canonical host state. Its returned fields and message array are readonly. Harness invokes `prepareDelivery` for every attempt, so each call must return a fresh participant and the same logical messages for a retained delivery. Completed message reductions may be cached across retained attempts, but participant instances are never reused. A changed replay payload is terminally fenced; ordinary preparation errors remain retryable.

Harness snapshots delivery payloads at admission and gives hooks, participants, and observers isolated copies. Participants must persist the reduced `messages` from their transaction context, not messages captured by the preparation closure. Passive `delivery_start`, `message_start`, and `message_end` publication occurs only after commitment and before provider work.

Participant outcomes are:

- `committed`: publish the delivery and permit provider work.
- `retained`: restore the same logical delivery and stable ID for explicit retry.
- `terminally_failed`: consume unsafe-to-replay work and stop the run.
- `revoked`: reported by Harness when explicit revocation wins before settlement begins.

A supplied participant owns canonical persistence for that delivery. Harness does not append the prepared delivery messages again. Without a participant, Harness persists committed delivery messages through the supplied session.

```typescript
const result = await harness.runPrompt("Apply the change");
if (result.status === "delivery_failed") {
  console.error(result.failure.phase, result.failure.error.message);
}
```

## Lifecycle and abort

`abort(source?)` records synchronous cancellation intent and returns an immutable `AgentAbortAcceptance`. The first accepted source is preserved. Abort does not implicitly clear queued work.

```typescript
const acceptance = harness.abort("remote_request");
if (acceptance.accepted) {
  await harness.waitForIdle();
}
```

Useful lifecycle projections include:

- `getPhase()`
- `signal`
- `activeRunSnapshot`
- `activeDeliverySettlement`
- `waitForIdle()`

Queue revocation is explicit:

```typescript
await harness.clearSteeringQueue();
await harness.clearFollowUpQueue();
await harness.clearAllQueues();
await harness.discardPendingPrompt();
```

`dispose()` is terminal and idempotent. It synchronously aborts the active run, fences later persistence, and revokes retained delivery, queue, and continuation state without waiting for an active callback to return. Its receipt therefore may resolve before `waitForIdle()` would. Subsequent prompting, continuation, queue mutation, append, compaction, navigation, and configuration operations reject.

## Prompting and queues

```typescript
await harness.prompt("Hello");
await harness.run({ role: "user", content: "Structured input", timestamp: Date.now() });

// During a run:
await harness.steer("Change direction");
await harness.followUp("Also summarize the result");
await harness.nextTurn("Include this with the next user-initiated turn");

// Admit already-structured queue messages synchronously:
const steerId = harness.queueSteer(userMessage);
const followUpId = harness.queueFollowUp(otherUserMessage);

// Resume retained work or a provider/tool continuation:
await harness.continue();
```

Harness owns deep snapshots of `run()`, `runPrompt()`, and `prompt()` messages, explicit context, images, and options before any asynchronous preflight. `continue()` similarly owns explicit context and dispatch options, and `promptFromTemplate()` owns its argument array before resolving runtime context. Later caller mutation cannot change admission, retries, or provider context.

`queueSteer()` and `queueFollowUp()` synchronously return after admission. Their async text counterparts, `steer()` and `followUp()`, wait for passive `queue_update` publication before resolving. Steering and follow-up modes are `"one-at-a-time"` or `"all"` and can be changed with their corresponding getters and setters.

## Tools

Tools implement `AgentTool`:

```typescript
import { Type } from "typebox";

const readFileTool = {
  name: "read_file",
  label: "Read file",
  description: "Read a UTF-8 file",
  parameters: Type.Object({ path: Type.String() }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate) {
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });
    const text = await fs.readFile(params.path, "utf8");
    return {
      content: [{ type: "text", text }],
      details: { path: params.path },
    };
  },
} satisfies AgentTool;
```

Configure all tools and the active subset separately:

```typescript
await harness.setTools([readFileTool], ["read_file"]);
await harness.setActiveTools(["read_file"]);
```

Thrown tool errors become failed tool results. Return `isError: true` to preserve structured failure details. A successful result may request `disposition: "stop"` or one bounded tool-free `disposition: "final_response"`.

## Hooks and events

Use `on()` for ordered mutation policy and `subscribe()` for finalized observation.

```typescript
const removeToolPolicy = harness.on("tool_call", (event) => {
  if (event.toolName === "bash") return { block: true, reason: "bash is disabled" };
});

const removeContextPolicy = harness.on("context", (event) => ({
  messages: pruneContext(event.messages),
}));

const unsubscribe = harness.subscribe(async (event) => {
  if (event.type === "agent_end") await flushUiProjection(event.messages);
});
```

Mutation hooks run in registration order before persistence or provider use, as appropriate for the event. Every `next_action` hook and scoped policy receives a fresh deep projection of messages, completed-turn results, and delivery payloads; tool arrays are copied while tool objects retain their callable identity. Only an explicitly returned action advances reducer state. Finalized subscribers receive cloned, passive projections. Subscriber mutation or failure cannot change committed delivery or terminal outcomes.

Important loop events include:

- `agent_start`, `agent_end`, and Harness `settled`
- `turn_start`, `turn_end`
- `delivery_start`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `queue_update`

Provider hooks are `before_provider_request`, `before_provider_payload`, and `after_provider_response`. Request options include transport, retry limits, timeouts, WebSocket connect timeout, inference speed, thinking budgets, environment, headers, metadata, and cache retention.

Scoped next-action policy is available for bounded host policy such as subagent budgets:

```typescript
const unregister = harness.registerNextActionPolicy((context, _signal) => {
  return budgetExceeded(context) ? { type: "stop" } : context.defaultAction;
});
```

## Session repositories

The package includes in-memory and JSONL repositories. Repositories create/open sessions; Harness receives one session instance.

```typescript
const repo = new InMemorySessionRepo();
const session = await repo.create({ id: "session-1" });
```

A custom `SessionStorage` must preserve canonical entry IDs, parent links, leaf changes, metadata, and append ordering.

## Low-level loop

Use the low-level loop when the host intentionally owns orchestration:

```typescript
import { agentLoop } from "@hansjm10/volt-agent-core";

const context = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [readFileTool],
};

const config = {
  model,
  convertToLlm,
  nextAction: async (context) => context.defaultAction,
};

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}
```

`agentLoop()` and `agentLoopContinue()` preserve event order but do not provide Harness persistence, transactional inboxes, lifecycle snapshots, or hook settlement. Prefer `AgentHarness` unless the host needs to implement those responsibilities itself.

## License

MIT
