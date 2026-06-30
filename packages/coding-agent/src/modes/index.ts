/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	createInProcessRpcClient,
	InProcessRpcClient,
	type InProcessRpcClientEventListener,
	type InProcessRpcClientOptions,
} from "./rpc/in-process-rpc-client.ts";
export {
	createIrohRemoteAgentRuntime,
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteAgentRuntimeOptions,
	type IrohRemoteAgentRuntimeResult,
	type IrohRemoteAgentRuntimeSessionSelection,
} from "./rpc/iroh-remote-agent-runtime.ts";
export {
	type IrohRemoteCompletedCommand,
	type IrohRemoteCompletionState,
	type IrohRemoteNotificationKind,
	type IrohRemoteNotificationRequest,
	type IrohRemoteRpcModeOptions,
	runIrohRemoteRpcMode,
} from "./rpc/iroh-remote-rpc-mode.ts";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientEvent,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcExtensionErrorEvent,
	type RpcSubagentEndEvent,
	type RpcSubagentEvent,
} from "./rpc/rpc-client.ts";
export { type RpcModeOptions, type RpcSessionChange, runRpcMode } from "./rpc/rpc-mode.ts";
export { RpcTransportClient, type RpcTransportClientOptions } from "./rpc/rpc-transport-client.ts";
export type {
	RpcActiveCompaction,
	RpcActiveToolExecution,
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostActionRequest,
	RpcHostActionResponse,
	RpcHostActionUpdate,
	RpcListSubagentsResponse,
	RpcLiveActivityRegistration,
	RpcPendingHostActionsResponse,
	RpcPushPlatform,
	RpcPushProvider,
	RpcRegisterPushTargetArgs,
	RpcRegisterPushTargetResponse,
	RpcResponse,
	RpcSessionListItem,
	RpcSessionState,
	RpcSubagentDefinition,
	RpcSubagentDefinitionSource,
	RpcSubagentSourceInfo,
	RpcSubagentStartResponse,
	RpcTranscriptItem,
	RpcTranscriptResponse,
	RpcTranscriptToolStatus,
	RpcWorkflowEvent,
	RpcWorkflowKind,
	RpcWorkflowStatus,
	RpcWorkflowToolEvent,
	UiActionArgumentDescriptor,
	UiActionArgumentType,
	UiActionCapabilities,
	UiActionCapabilityFeature,
	UiActionCategory,
	UiActionDescriptor,
	UiActionInvocationQueueBehavior,
	UiActionInvocationResponse,
	UiActionInvocationStatus,
	UiActionListResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
	UiActionPresentationHint,
	UiActionPresentationKind,
	UiActionScalar,
	UiActionSlashAlias,
	UiActionSource,
	UiActionStateDescriptor,
	UiActionStateType,
	UiActionStreamingBehavior,
} from "./rpc/rpc-types.ts";
