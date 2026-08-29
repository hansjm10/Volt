# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## Canonical JSON Data

Every admitted entry must round-trip through JSON without type or value loss. Accepted data is `null`, booleans, strings, finite numbers other than negative zero, dense arrays, and ordinary plain objects whose own properties are enumerable string-keyed data properties. Optional properties are omitted when absent.

Volt rejects explicit `undefined`, non-finite numbers, negative zero, bigint, symbols, functions, cycles, sparse arrays, accessors, symbol-keyed or non-enumerable properties, custom or null prototypes, and rich objects such as `Map`, `Set`, `Date`, `Error`, `RegExp`, `Buffer`, typed arrays, `ArrayBuffer`, and `SharedArrayBuffer`. Encode rich values as plain JSON, for example dates as ISO strings and maps as arrays of entries.

`SessionManager` validates and clones each complete entry before assigning its ordinal or changing indexes, the active leaf, persistence queues, files, or observers. A rejected entry therefore leaves memory, disk, and branch position unchanged. This admission rule does not change the session format version: accepted values are ordinary JSONL.

## File Location

```
~/.volt/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Where `<path>` is the working directory with `/` replaced by `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.volt/agent/sessions/`.

Volt also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, volt uses the `trash` CLI to avoid permanent deletion.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)
- **Version 4**: Added stable file-order commit ordinals
- **Version 5**: Replaced unreplayable legacy client-input WAL state

Existing sessions are automatically migrated to the current version (v5) when a writer next appends. Canonical JSON admission does not introduce another migration.

## Source Files

Source files:
- [`packages/coding-agent/src/core/session-manager.ts`](../src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@hansjm10/volt-coding-agent/dist/` and `node_modules/@hansjm10/volt-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
}
```

### Base Message Types (from volt-ai)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: JsonValue; // Tool-specific JSON metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  serviceTier?: {
    requested?: "auto" | "default" | "flex" | "scale" | "priority";
    effective?: "auto" | "default" | "flex" | "scale" | "priority";
  };
}
```

### Extended Message Types (from volt-coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: JsonValue;           // Extension-specific JSON metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### FastModeChangeEntry

Emitted when the user changes the branch-local inference-speed policy. This is independent of thinking level. Eligible OpenAI requests map enabled Fast mode to Priority processing.

```json
{"type":"fast_mode_change","id":"f5g6h7i8","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","enabled":true}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional fields:
- `details`: JSON data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension; omitted otherwise (legacy field name)

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: JSON file-tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom JSON data for extensions
- `fromHook`: `true` if generated by an extension; omitted otherwise (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Call `appendLabelChange(targetId, undefined)` to clear a label; the persisted entry omits the optional `label` field.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `volt.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

### SessionStartGitContextEntry (host-only)

A newly created current-format session records its first **definitive** path-free
Git observation. `gitContext` is either the same bounded object used by RPC
`gitContext`, or `null` when the cwd was definitively not a Git worktree.
Transient Git command failures do not create this entry; a later successful
observation may still do so. The expected session ID fences delayed scans from a
replacement session.

```json
{"type":"session_start_git_context","id":"l2m3n4o5","parentId":null,"timestamp":"2026-08-29T16:00:00.000Z","ordinal":1,"gitContext":{"repository":"Volt","head":{"kind":"branch","name":"feature/work","oid":"0123456789abcdef0123456789abcdef01234567"},"upstream":null,"base":null,"status":{"staged":{"added":0,"modified":0,"deleted":0,"renamed":0},"unstaged":{"added":0,"modified":0,"deleted":0,"renamed":0},"untracked":0,"conflicted":0,"total":0,"clean":true},"operation":null,"revision":1,"observedAt":"2026-08-29T16:00:00.000Z","stale":false}}
```

Current-format readers validate this entry strictly and reject duplicates. It
is host metadata only: it never advances the active leaf, enters model context,
appears as a transcript item, copies into forks, or reaches extension message
projection. Session listings and state responses may expose the validated
path-free value as optional `startingGitContext`.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildSessionContext()` walks from the current leaf to the root, producing the message list for the LLM:

1. Collects all entries on the path
2. Extracts current model, thinking level, and Fast mode settings
3. If a `CompactionEntry` is on the path:
   - Emits the summary first
   - Then messages from `firstKeptEntryId` to compaction
   - Then messages after compaction
4. Converts `BranchSummaryEntry` and `CustomMessageEntry` to appropriate message formats
5. Ignores host-only entries such as `session_start_git_context`, client-input WAL records, durable leaf pointers, and subagent spawn edges

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?)` - List all sessions across all projects

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendFastModeChange(enabled)` - Record branch-local Fast mode change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
