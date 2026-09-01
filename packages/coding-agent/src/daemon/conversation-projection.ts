import type { AssistantMessage } from "@hansjm10/volt-ai";
import { type AgentSessionRuntime, isConversationTranscriptCommittedEvent } from "../core/agent-session-runtime.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import type {
	ConversationProjectionRawWorkflowSnapshot,
	ConversationProjectionSnapshot,
	ConversationProjectionSnapshotBuilder,
} from "../core/rpc/conversation-projection-feed.ts";
import {
	assertConversationProjectionAssistantSnapshotWithinLimits,
	assertConversationProjectionAssistantToolStateWithinLimits,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
} from "../core/rpc/conversation-projection-limits.ts";
import {
	buildRpcSessionState,
	measureRpcJsonBytes,
	measureRpcJsonBytesWithin,
	projectRpcBoundedRecord,
	projectRpcBoundedString,
	RPC_SESSION_STATE_MAX_SERIALIZED_BYTES,
} from "../core/rpc/session-state.ts";
import type {
	RpcConversationActiveAssistant,
	RpcConversationWorkflowSnapshot,
	RpcProjectionCollectionTruncation,
	RpcProjectionTruncation,
	RpcSessionState,
	RpcWorkflowEvent,
	RpcWorkflowToolEvent,
} from "../core/rpc/types.ts";
import {
	createRemoteConversationTranscriptEntry,
	createRemoteConversationTranscriptPage,
} from "./conversation-commands.ts";

export const REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES = DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES;
export const REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES =
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES;
export const REMOTE_CONVERSATION_WORKFLOWS_MAX_SERIALIZED_BYTES = 384 * 1024;
export const REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES = 32 * 1024;
export const REMOTE_CONVERSATION_WORKFLOW_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES = 96 * 1024;
export const REMOTE_CONVERSATION_WORKFLOW_MAX_ITEMS = 64;
export const REMOTE_CONVERSATION_WORKFLOW_ARGUMENTS_MAX_SERIALIZED_BYTES = 12 * 1024;

const REMOTE_ACTIVE_ASSISTANT_METADATA_STRING_MAX_UTF8_BYTES = 8 * 1024;
const REMOTE_WORKFLOW_EVENT_PAYLOAD_MAX_SERIALIZED_BYTES = 20 * 1024;
const REMOTE_WORKFLOW_ACTIVE_TOOL_MAX_ITEMS = 128;
const REMOTE_WORKFLOW_MAX_EVENT_FIELDS = 64;

export interface RemoteConversationProjectionOptions {
	authorization: IrohRemoteClientAuthorizationSuccess;
	runtime: AgentSessionRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCollectionProjection(options: {
	projected: unknown;
	totalCount: number;
	projectedCount: number;
	truncatedItems: NonNullable<RpcProjectionCollectionTruncation["truncatedItems"]>;
}): RpcProjectionCollectionTruncation | undefined {
	const omittedCount = options.totalCount - options.projectedCount;
	if (omittedCount === 0 && options.truncatedItems.length === 0) {
		return undefined;
	}
	return {
		truncated: true,
		originalBytes: null,
		projectedBytes: measureRpcJsonBytes(options.projected) ?? 0,
		totalCount: options.totalCount,
		projectedCount: options.projectedCount,
		omittedCount,
		...(omittedCount === 0 ? {} : { omittedEntries: omittedCount }),
		...(options.truncatedItems.length === 0 ? {} : { truncatedItems: options.truncatedItems }),
	};
}

function projectAssistantMessage(message: AssistantMessage): {
	value: AssistantMessage;
	projection: RpcProjectionTruncation;
} {
	const model = projectRpcBoundedString(message.model, REMOTE_ACTIVE_ASSISTANT_METADATA_STRING_MAX_UTF8_BYTES);
	const responseModel =
		message.responseModel === undefined
			? undefined
			: projectRpcBoundedString(message.responseModel, REMOTE_ACTIVE_ASSISTANT_METADATA_STRING_MAX_UTF8_BYTES);
	const responseId =
		message.responseId === undefined
			? undefined
			: projectRpcBoundedString(message.responseId, REMOTE_ACTIVE_ASSISTANT_METADATA_STRING_MAX_UTF8_BYTES);
	const errorMessage =
		message.errorMessage === undefined
			? undefined
			: projectRpcBoundedString(message.errorMessage, REMOTE_ACTIVE_ASSISTANT_METADATA_STRING_MAX_UTF8_BYTES);
	const value: AssistantMessage = {
		role: "assistant",
		content: message.content,
		api: message.api,
		provider: message.provider,
		model: model.value,
		...(responseModel === undefined ? {} : { responseModel: responseModel.value }),
		...(responseId === undefined ? {} : { responseId: responseId.value }),
		usage: message.usage,
		stopReason: message.stopReason,
		...(errorMessage === undefined ? {} : { errorMessage: errorMessage.value }),
		timestamp: message.timestamp,
	};
	const fields: Record<string, RpcProjectionTruncation> = {};
	if (model.projection) fields.model = model.projection;
	if (responseModel?.projection) fields.responseModel = responseModel.projection;
	if (responseId?.projection) fields.responseId = responseId.projection;
	if (errorMessage?.projection) fields.errorMessage = errorMessage.projection;
	if (message.diagnostics !== undefined) {
		fields.diagnostics = {
			truncated: true,
			originalBytes: null,
			projectedBytes: 0,
			omittedEntries: message.diagnostics.length,
		};
	}
	return {
		value,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes:
				measureRpcJsonBytesWithin(value, REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES) ?? 0,
			...(Object.keys(fields).length === 0 ? {} : { fields }),
		},
	};
}

/** Bound the subscriber-sanitized active assistant without changing projector state. */
export function projectRemoteConversationActiveAssistant(
	activeAssistant: RpcConversationActiveAssistant | null,
): RpcConversationActiveAssistant | null {
	if (activeAssistant === null) return null;
	const originalBytes = measureRpcJsonBytesWithin(
		activeAssistant,
		REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES,
	);
	if (originalBytes !== null) {
		const message = activeAssistant.message as AssistantMessage;
		const metrics = assertConversationProjectionAssistantSnapshotWithinLimits(message);
		assertConversationProjectionAssistantToolStateWithinLimits(message, activeAssistant.toolState ?? [], metrics);
		return activeAssistant;
	}
	const message = projectAssistantMessage(activeAssistant.message as AssistantMessage);
	const metrics = assertConversationProjectionAssistantSnapshotWithinLimits(message.value);
	assertConversationProjectionAssistantToolStateWithinLimits(message.value, activeAssistant.toolState ?? [], metrics);
	const projected: Omit<RpcConversationActiveAssistant, "projection"> = {
		stream: activeAssistant.stream,
		message: message.value,
		...(activeAssistant.toolState === undefined ? {} : { toolState: activeAssistant.toolState }),
	};
	const fields: Record<string, RpcProjectionTruncation> = { message: message.projection };
	const value: RpcConversationActiveAssistant = {
		...projected,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes:
				measureRpcJsonBytesWithin(projected, REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES) ?? 0,
			fields,
		},
	};
	const projectedBytes = measureRpcJsonBytesWithin(value, REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES);
	if (projectedBytes === null) {
		throw new Error(
			`Active assistant delta-dependent state exceeded its ${REMOTE_CONVERSATION_ACTIVE_ASSISTANT_MAX_SERIALIZED_BYTES}-byte contract`,
		);
	}
	return value;
}

function workflowIdentityKeys(type: unknown): readonly string[] {
	if (type === "workflow_start" || type === "workflow_update" || type === "workflow_end") {
		return ["type", "workflowId", "kind", "action", "status", "pullRequest"];
	}
	if (type === "tool_execution_start") {
		return ["type", "workflowId", "workflowKind", "workflowAction", "toolCallId", "toolName"];
	}
	if (type === "tool_execution_end") {
		return ["type", "workflowId", "workflowKind", "workflowAction", "toolCallId", "toolName", "isError"];
	}
	return ["type", "workflowId", "toolCallId", "toolName"];
}

function createWorkflowIdentityProjection(event: Record<string, unknown>): Record<string, unknown> {
	const identity: Record<string, unknown> = {};
	for (const key of workflowIdentityKeys(event.type)) {
		if (event[key] !== undefined) identity[key] = event[key];
	}
	const identityBytes = measureRpcJsonBytesWithin(identity, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES);
	if (identityBytes === null) {
		throw new Error(
			`Workflow event identity exceeded its ${REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES}-byte contract`,
		);
	}
	const originalBytes = isRecord(event.projection)
		? typeof event.projection.originalBytes === "number"
			? event.projection.originalBytes
			: null
		: null;
	const value = {
		...identity,
		projection: {
			truncated: true,
			originalBytes,
			projectedBytes: identityBytes,
		} satisfies RpcProjectionTruncation,
	};
	if (measureRpcJsonBytesWithin(value, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES) === null) {
		throw new Error(
			`Workflow event identity projection exceeded its ${REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES}-byte contract`,
		);
	}
	return value;
}

/** Apply the identical bounded policy to snapshot and live workflow events. */
export function projectRemoteConversationWorkflowEvent(event: object): object {
	if (!isRecord(event)) return event;
	const originalBytes = measureRpcJsonBytesWithin(event, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES);
	const identity: Record<string, unknown> = {};
	const extras: Record<string, unknown> = {};
	const identityKeys = new Set(workflowIdentityKeys(event.type));
	for (const key of identityKeys) {
		if (event[key] !== undefined) identity[key] = event[key];
	}
	let extraFields = 0;
	for (const key in event) {
		if (!Object.hasOwn(event, key)) continue;
		if (key === "projection") continue;
		if (identityKeys.has(key)) continue;
		if (extraFields >= REMOTE_WORKFLOW_MAX_EVENT_FIELDS) break;
		extras[key] = event[key];
		extraFields++;
	}
	const fields: Record<string, RpcProjectionTruncation> = {};
	if (isRecord(extras.args)) {
		const args = projectRpcBoundedRecord(extras.args, REMOTE_CONVERSATION_WORKFLOW_ARGUMENTS_MAX_SERIALIZED_BYTES);
		extras.args = args.value;
		if (args.projection) fields.args = args.projection;
	}
	if (isRecord(extras.details)) {
		const details = projectRpcBoundedRecord(
			extras.details,
			REMOTE_CONVERSATION_WORKFLOW_ARGUMENTS_MAX_SERIALIZED_BYTES,
		);
		extras.details = details.value;
		if (details.projection) fields.details = details.projection;
	}
	const payload = projectRpcBoundedRecord(extras, REMOTE_WORKFLOW_EVENT_PAYLOAD_MAX_SERIALIZED_BYTES);
	if (payload.projection) fields.payload = payload.projection;
	if (originalBytes !== null && Object.keys(fields).length === 0) {
		return event;
	}
	const projected = { ...identity, ...payload.value };
	let value: Record<string, unknown> = {
		...projected,
		projection: {
			truncated: true,
			originalBytes,
			projectedBytes:
				measureRpcJsonBytesWithin(projected, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES) ?? 0,
			...(Object.keys(fields).length === 0 ? {} : { fields }),
		} satisfies RpcProjectionTruncation,
	};
	if (measureRpcJsonBytesWithin(value, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES) === null) {
		value = createWorkflowIdentityProjection(event);
	}
	if (measureRpcJsonBytesWithin(value, REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES) === null) {
		throw new Error(
			`Workflow event projection exceeded its ${REMOTE_CONVERSATION_WORKFLOW_EVENT_MAX_SERIALIZED_BYTES}-byte contract`,
		);
	}
	return value;
}

function projectWorkflowActiveTools(events: readonly object[]): {
	value: RpcWorkflowToolEvent[];
	projection?: RpcProjectionCollectionTruncation;
} {
	const value: object[] = [];
	const truncatedItems: NonNullable<RpcProjectionCollectionTruncation["truncatedItems"]> = [];
	for (let index = 0; index < events.length && index < REMOTE_WORKFLOW_ACTIVE_TOOL_MAX_ITEMS; index++) {
		const full = projectRemoteConversationWorkflowEvent(events[index]!);
		let projected = full;
		let candidate = [...value, projected];
		let candidateBytes = measureRpcJsonBytes(candidate);
		if (candidateBytes === null || candidateBytes > REMOTE_CONVERSATION_WORKFLOW_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES) {
			projected = isRecord(full) ? createWorkflowIdentityProjection(full) : full;
			candidate = [...value, projected];
			candidateBytes = measureRpcJsonBytes(candidate);
		}
		if (candidateBytes === null || candidateBytes > REMOTE_CONVERSATION_WORKFLOW_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES) {
			break;
		}
		value.push(projected);
		if (isRecord(projected) && isRecord(projected.projection)) {
			truncatedItems.push({
				index,
				originalBytes:
					typeof projected.projection.originalBytes === "number" ? projected.projection.originalBytes : null,
				projectedBytes:
					typeof projected.projection.projectedBytes === "number"
						? projected.projection.projectedBytes
						: (measureRpcJsonBytes(projected) ?? 0),
			});
		}
	}
	return {
		value: value as RpcWorkflowToolEvent[],
		projection: createCollectionProjection({
			projected: value,
			totalCount: events.length,
			projectedCount: value.length,
			truncatedItems,
		}),
	};
}

function projectWorkflowSnapshot(workflow: ConversationProjectionRawWorkflowSnapshot): RpcConversationWorkflowSnapshot {
	const workflowEvent =
		workflow.workflowEvent === undefined
			? undefined
			: (projectRemoteConversationWorkflowEvent(workflow.workflowEvent) as RpcWorkflowEvent);
	const activeTools = projectWorkflowActiveTools(workflow.activeTools);
	return {
		workflowId: workflow.workflowId,
		...(workflowEvent === undefined ? {} : { workflowEvent }),
		activeTools: activeTools.value,
		...(activeTools.projection === undefined ? {} : { activeToolsProjection: activeTools.projection }),
	};
}

function createWorkflowSnapshotIdentity(snapshot: RpcConversationWorkflowSnapshot): RpcConversationWorkflowSnapshot {
	const workflowEvent =
		snapshot.workflowEvent === undefined
			? undefined
			: (createWorkflowIdentityProjection(
					snapshot.workflowEvent as unknown as Record<string, unknown>,
				) as unknown as RpcWorkflowEvent);
	const activeTools = projectWorkflowActiveTools(
		snapshot.activeTools.map((event) =>
			createWorkflowIdentityProjection(event as unknown as Record<string, unknown>),
		),
	);
	return {
		workflowId: snapshot.workflowId,
		...(workflowEvent === undefined ? {} : { workflowEvent }),
		activeTools: activeTools.value,
		...(activeTools.projection === undefined ? {} : { activeToolsProjection: activeTools.projection }),
	};
}

function projectActiveWorkflows(workflows: readonly ConversationProjectionRawWorkflowSnapshot[]): {
	value: RpcConversationWorkflowSnapshot[];
	projection?: RpcProjectionCollectionTruncation;
} {
	const value: RpcConversationWorkflowSnapshot[] = [];
	const truncatedItems: NonNullable<RpcProjectionCollectionTruncation["truncatedItems"]> = [];
	for (let index = 0; index < workflows.length && index < REMOTE_CONVERSATION_WORKFLOW_MAX_ITEMS; index++) {
		const full = projectWorkflowSnapshot(workflows[index]!);
		let projected = full;
		let candidate = [...value, projected];
		let candidateBytes = measureRpcJsonBytes(candidate);
		if (candidateBytes === null || candidateBytes > REMOTE_CONVERSATION_WORKFLOWS_MAX_SERIALIZED_BYTES) {
			projected = createWorkflowSnapshotIdentity(full);
			candidate = [...value, projected];
			candidateBytes = measureRpcJsonBytes(candidate);
		}
		if (candidateBytes === null || candidateBytes > REMOTE_CONVERSATION_WORKFLOWS_MAX_SERIALIZED_BYTES) {
			break;
		}
		value.push(projected);
		if (
			projected.activeToolsProjection !== undefined ||
			(isRecord(projected.workflowEvent) && projected.workflowEvent.projection !== undefined)
		) {
			truncatedItems.push({
				index,
				originalBytes: null,
				projectedBytes: measureRpcJsonBytes(projected) ?? 0,
			});
		}
	}
	return {
		value,
		projection: createCollectionProjection({
			projected: value,
			totalCount: workflows.length,
			projectedCount: value.length,
			truncatedItems,
		}),
	};
}

function addWorkflowProjectionToState(
	state: RpcSessionState,
	projection: RpcProjectionCollectionTruncation | undefined,
): RpcSessionState {
	if (projection === undefined) return state;
	return {
		...state,
		projection: { ...state.projection, activeWorkflows: projection },
	};
}

/** Build one synchronous, authorization-specific checkpoint at the feed cut. */
export function createRemoteConversationSnapshotBuilder(
	options: RemoteConversationProjectionOptions,
): ConversationProjectionSnapshotBuilder {
	return (context) => {
		const transcript = createRemoteConversationTranscriptPage(options.authorization, options.runtime, {
			branchEpoch: context.branchEpoch,
		});
		if (!transcript) {
			throw new Error("Unable to project the active conversation transcript");
		}
		const activeAssistant = projectRemoteConversationActiveAssistant(context.activeAssistant);
		const activeWorkflows = projectActiveWorkflows(context.activeWorkflows);
		const state = addWorkflowProjectionToState(
			buildRpcSessionState(options.runtime.session),
			activeWorkflows.projection,
		);
		const stateBytes = measureRpcJsonBytes(state);
		if (stateBytes === null || stateBytes > RPC_SESSION_STATE_MAX_SERIALIZED_BYTES) {
			throw new Error(
				`Decorated RPC session state projection exceeded its ${RPC_SESSION_STATE_MAX_SERIALIZED_BYTES}-byte contract`,
			);
		}
		const snapshot: ConversationProjectionSnapshot = {
			conversation: {
				workspaceName: options.authorization.workspace.name,
				sessionId: options.runtime.session.sessionId,
			},
			state,
			transcript,
			activeAssistant,
			activeWorkflows: activeWorkflows.value,
		};
		const probe = {
			type: "conversation_bootstrap",
			delivery: { subscriptionId: context.subscriptionId, cursor: Number.MAX_SAFE_INTEGER },
			...snapshot,
			reason: context.reason,
			...(context.requestId === undefined ? {} : { requestId: context.requestId }),
		};
		const bootstrapBytes = measureRpcJsonBytes(probe);
		if (bootstrapBytes === null || bootstrapBytes + 1 > REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES) {
			throw new Error(
				`Conversation bootstrap projection exceeded its ${REMOTE_CONVERSATION_BOOTSTRAP_MAX_SERIALIZED_BYTES}-byte contract`,
			);
		}
		return snapshot;
	};
}

/** Project canonical runtime commits using the same policy as the checkpoint. */
export function createRemoteConversationExternalProjector(
	options: Pick<RemoteConversationProjectionOptions, "authorization" | "runtime">,
): (event: object) => object | null {
	return (event) => {
		if (isConversationTranscriptCommittedEvent(event)) {
			const transcriptEntry = createRemoteConversationTranscriptEntry(
				event.entry,
				options.authorization,
				options.runtime,
			);
			return transcriptEntry === undefined
				? null
				: { type: "transcript_entry", entry: transcriptEntry, final: true };
		}
		if (
			isRecord(event) &&
			(event.type === "workflow_start" ||
				event.type === "workflow_update" ||
				event.type === "workflow_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_end")
		) {
			return projectRemoteConversationWorkflowEvent(event);
		}
		return event;
	};
}
