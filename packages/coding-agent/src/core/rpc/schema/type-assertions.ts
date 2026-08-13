/**
 * Compile-time drift tripwires pinning the contract schemas to the upstream
 * types they project onto the wire (volt-ai, volt-agent-core, and host
 * modules that own the source shapes). No runtime exports — `tsgo --noEmit`
 * and every build fail when an upstream shape changes until the contract is
 * updated consciously.
 *
 * Notes:
 * - MutualExtends tolerates *optional* additions: the stream-frame schemas
 *   deliberately add the projection feed's optional `delivery` decoration on
 *   top of the constructing StreamProjector types.
 * - JsonWireShape maps `| undefined` properties to optional ones — the wire
 *   sees JSON.stringify output, which drops undefined-valued keys.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type {
	ActiveToolCallState,
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolDefinitionFingerprint,
	ToolSetSnapshot,
	Usage,
} from "@hansjm10/volt-ai";
import type { Static } from "typebox";
import type { SessionStats } from "../../agent-session.ts";
import type { BashResult } from "../../bash-executor.ts";
import type { CompactionResult } from "../../compaction/index.ts";
import type { HostActionRequest, HostActionUpdate } from "../../host-interaction.ts";
import type {
	McpOAuthBrowserCompleteResult,
	McpOAuthBrowserStartResult,
	McpOAuthDevicePollResult,
	McpOAuthDeviceStartResult,
} from "../../mcp/oauth-flow.ts";
import type { McpRpcCapabilities } from "../../mcp/rpc.ts";
import type {
	McpPromptSummary,
	McpRecentCallSummary,
	McpResourceSummary,
	McpServerSummary,
	McpToolSummary,
} from "../../mcp/types.ts";
import type { ReviewCoverage, ReviewFinding } from "../../review.ts";
import type { SourceInfo } from "../../source-info.ts";
import type {
	ProjectedMessageEndFrame,
	ProjectedMessageStartFrame,
	ProjectedMessageUpdateFrame,
	SlimAssistantEvent,
} from "../stream-projection.ts";
import type { RpcModel } from "../types.ts";
import type {
	RpcMessageEndFrameSchema,
	RpcMessageStartFrameSchema,
	RpcMessageUpdateFrameSchema,
} from "./conversation.ts";
import type { RpcHostActionRequestSchema, RpcHostActionUpdateSchema } from "./events.ts";
import type {
	RpcActiveToolCallStateSchema,
	RpcAssistantMessageSchema,
	RpcModelSchema,
	RpcSlimAssistantEventSchema,
	RpcStopReasonSchema,
	RpcTextContentSchema,
	RpcThinkingContentSchema,
	RpcToolCallSchema,
	RpcToolDefinitionFingerprintSchema,
	RpcToolSetSnapshotSchema,
	RpcUsageSchema,
} from "./external.ts";
import type { Assert, JsonWireShape, MutualExtends } from "./helpers.ts";
import type {
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthDevicePollResultSchema,
	RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpPromptSummarySchema,
	RpcMcpRecentCallSummarySchema,
	RpcMcpResourceSummarySchema,
	RpcMcpServerSummarySchema,
	RpcMcpToolSummarySchema,
	RpcSourceInfoSchema,
} from "./mcp.ts";
import type { RpcImageContentSchema, RpcThinkingLevelSchema } from "./primitives.ts";
import type { RpcReviewCoverageSchema, RpcReviewFindingSchema } from "./projections.ts";
import type { RpcBashResultSchema, RpcCompactionResultSchema, RpcSessionStatsSchema } from "./responses.ts";

// volt-ai content and message shapes
type _imageContent = Assert<MutualExtends<Static<typeof RpcImageContentSchema>, ImageContent>>;
type _textContent = Assert<MutualExtends<Static<typeof RpcTextContentSchema>, TextContent>>;
type _thinkingContent = Assert<MutualExtends<Static<typeof RpcThinkingContentSchema>, ThinkingContent>>;
type _toolCall = Assert<MutualExtends<Static<typeof RpcToolCallSchema>, ToolCall>>;
type _toolDefinitionFingerprint = Assert<
	MutualExtends<Static<typeof RpcToolDefinitionFingerprintSchema>, ToolDefinitionFingerprint>
>;
type _toolSetSnapshot = Assert<MutualExtends<Static<typeof RpcToolSetSnapshotSchema>, ToolSetSnapshot>>;
type _usage = Assert<MutualExtends<Static<typeof RpcUsageSchema>, Usage>>;
type _stopReason = Assert<MutualExtends<Static<typeof RpcStopReasonSchema>, StopReason>>;
type _assistantDiagnostics = Assert<
	MutualExtends<Static<typeof RpcAssistantMessageSchema>["diagnostics"], AssistantMessage["diagnostics"] | undefined>
>;
type _assistantMessage = Assert<MutualExtends<Static<typeof RpcAssistantMessageSchema>, AssistantMessage>>;
type _activeToolCallState = Assert<MutualExtends<Static<typeof RpcActiveToolCallStateSchema>, ActiveToolCallState>>;
type _model = Assert<MutualExtends<Static<typeof RpcModelSchema>, RpcModel>>;

// volt-agent-core
type _thinkingLevel = Assert<MutualExtends<Static<typeof RpcThinkingLevelSchema>, ThinkingLevel>>;

// Stream projection frames and slim events
type _slimAssistantEvent = Assert<MutualExtends<Static<typeof RpcSlimAssistantEventSchema>, SlimAssistantEvent>>;
type _messageStartFrame = Assert<MutualExtends<Static<typeof RpcMessageStartFrameSchema>, ProjectedMessageStartFrame>>;
type _messageUpdateFrame = Assert<
	MutualExtends<Static<typeof RpcMessageUpdateFrameSchema>, ProjectedMessageUpdateFrame>
>;
type _messageEndFrame = Assert<MutualExtends<Static<typeof RpcMessageEndFrameSchema>, ProjectedMessageEndFrame>>;

// Host modules that own response-body shapes
type _sessionStats = Assert<MutualExtends<Static<typeof RpcSessionStatsSchema>, JsonWireShape<SessionStats>>>;
type _bashResult = Assert<MutualExtends<Static<typeof RpcBashResultSchema>, JsonWireShape<BashResult>>>;
type _compactionResult = Assert<MutualExtends<Static<typeof RpcCompactionResultSchema>, CompactionResult>>;
type _hostActionRequest = Assert<
	MutualExtends<Static<typeof RpcHostActionRequestSchema>, { type: "host_action_request" } & HostActionRequest>
>;
type _hostActionUpdate = Assert<
	MutualExtends<Static<typeof RpcHostActionUpdateSchema>, { type: "host_action_update" } & HostActionUpdate>
>;
type _sourceInfo = Assert<MutualExtends<Static<typeof RpcSourceInfoSchema>, SourceInfo>>;
type _reviewFinding = Assert<MutualExtends<Static<typeof RpcReviewFindingSchema>, ReviewFinding>>;
type _reviewCoverage = Assert<MutualExtends<Static<typeof RpcReviewCoverageSchema>, ReviewCoverage>>;

// MCP module shapes
type _mcpCapabilities = Assert<MutualExtends<Static<typeof RpcMcpCapabilitiesResponseSchema>, McpRpcCapabilities>>;
type _mcpRecentCall = Assert<MutualExtends<Static<typeof RpcMcpRecentCallSummarySchema>, McpRecentCallSummary>>;
type _mcpTool = Assert<MutualExtends<Static<typeof RpcMcpToolSummarySchema>, McpToolSummary>>;
type _mcpResource = Assert<MutualExtends<Static<typeof RpcMcpResourceSummarySchema>, McpResourceSummary>>;
type _mcpPrompt = Assert<MutualExtends<Static<typeof RpcMcpPromptSummarySchema>, McpPromptSummary>>;
type _mcpServer = Assert<MutualExtends<Static<typeof RpcMcpServerSummarySchema>, McpServerSummary>>;
type _mcpBrowserStart = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthBrowserStartResultSchema>, McpOAuthBrowserStartResult>
>;
type _mcpBrowserComplete = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthBrowserCompleteResultSchema>, McpOAuthBrowserCompleteResult>
>;
type _mcpDeviceStart = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthDeviceStartResultSchema>, McpOAuthDeviceStartResult>
>;
type _mcpDevicePoll = Assert<MutualExtends<Static<typeof RpcMcpOAuthDevicePollResultSchema>, McpOAuthDevicePollResult>>;
