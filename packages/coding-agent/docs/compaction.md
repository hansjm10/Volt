# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, volt uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files**:
- [`packages/coding-agent/src/core/compaction/context-compaction.ts`](../src/core/compaction/context-compaction.ts) - Cache-preserving session compaction
- [`packages/coding-agent/src/core/compaction/compaction.ts`](../src/core/compaction/compaction.ts) - Cut-point preparation and chunked fallback
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](../src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](../src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](../src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](../src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@hansjm10/volt-coding-agent/dist/`.

## Overview

Volt has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

By default, `reserveTokens` is 16384 tokens (configurable in `~/.volt/agent/settings.json` or `<project-dir>/.volt/settings.json`). This leaves room for the LLM's response.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### How It Works

1. **Find cut point**: Walk backwards from the newest message, accumulating token estimates up to `keepRecentTokens` (default 20k). When active tool definitions would consume too much of the selected model's context, Volt lowers this message budget to leave the configured reserve and tool definitions room.
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Make one request with the current system prompt, tool definitions, reasoning setting, and native older-message prefix (including the previous checkpoint). Append a summarization instruction rather than serializing or rewriting the prefix. Recent messages beyond the cut remain outside this request.
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards; the completion result reports a fresh token estimate for the rebuilt messages and active tool definitions

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Volt also recalculates `tokensBefore` from the rebuilt session context and active tool definitions before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Summary Budget and Failure Handling

Built-in compaction requests at most 4096 summary tokens per request, independently of `reserveTokens`. It also stops and rejects generated text above 16,384 characters per response, including on providers that do not enforce the requested token limit. File-operation metadata is appended separately.

The normal single-pass request preserves the session's reasoning level, Fast mode, transport, routing identity and cache policy. This enables prefix-cache reuse; cache hits are not guaranteed, particularly after provider/extension transformations or cache expiry. Compaction never executes returned tool calls.

If the native request is estimated not to fit, or the provider reports a context overflow, Volt uses the existing chronological chunked summarizer with a small fixed output allowance and minimal supported reasoning. Other errors do not select the fallback. Built-in summary generation has a five-minute deadline covering context conversion, requests, retry delays and any fallback. Transient failures have at most two compaction-level retries per request; provider-level retries are disabled for session compaction.

Cancellation, timeout, empty responses, truncated output and tool-calling responses do not install a checkpoint. The original conversation remains intact. Custom extension-provided summaries retain their extension hook behavior.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

The normal single-pass request summarizes history and the turn prefix together. The oversized-input fallback generates history and turn-prefix summaries separately and merges them; each stream processes its chunks chronologically.

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Volt excludes a candidate context entry when retaining it would exceed the effective message allowance. It always retains the newest indivisible context suffix when no later retained anchor exists, even if that suffix alone exceeds the allowance. In particular, Volt never cuts at tool results: an assistant tool call and its trailing results stay together so compaction advances with a valid continuation.

### CompactionEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: JsonValue; // implementation-specific JSON data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store data from Volt's lossless JSON grammar in `details`. Optional fields must be omitted rather than set to `undefined`; cycles, non-finite numbers, rich objects such as `Map`/`Date`/typed arrays, and shared memory are rejected. The default compaction tracks file operations, but custom extension implementations can use their own plain JSON structure.

See [`prepareCompaction()`](../src/core/compaction/compaction.ts) and [`compact()`](../src/core/compaction/compaction.ts) for the implementation.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, volt offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, volt extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](../src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: JsonValue; // implementation-specific JSON data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

As with compaction, extensions can store custom lossless JSON data in `details`.

See [`collectEntriesForBranchSummary()`](../src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](../src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](../src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

The normal compaction path keeps native messages and signatures unchanged through the configured context/conversion pipeline. Only the chunked fallback and branch summarization serialize messages to text via [`serializeConversation()`](../src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](../src/core/extensions/types.ts) for event type definitions. Volt validates and owns custom summaries before appending an entry or moving the branch leaf. Invalid details fail the operation without committing a compaction or tree-navigation mutation.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
volt.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@hansjm10/volt-coding-agent";

volt.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
volt.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.volt/agent/settings.json` or `<project-dir>/.volt/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Maximum recent message tokens to keep; active tool definitions can lower the effective budget |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
