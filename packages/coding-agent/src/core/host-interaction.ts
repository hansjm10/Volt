export type HostActionDecisionKind = "approved" | "denied" | "dismissed" | "unavailable";
export type HostActionStatus = "running" | "completed" | "failed" | "cancelled";
export type HostActionMetadataValue = string | number | boolean | null;
export type HostActionMetadata = Record<string, HostActionMetadataValue>;

export interface HostActionRequest {
	id: string;
	action: string;
	title: string;
	message?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	commandPreview?: string;
	blocking?: boolean;
	destructive?: boolean;
	metadata?: HostActionMetadata;
	timeoutMs?: number;
}

export interface HostActionDecision {
	decision: HostActionDecisionKind;
	message?: string;
}

export interface HostActionUpdate {
	id: string;
	action: string;
	status: HostActionStatus;
	message?: string;
	exitCode?: number | null;
}

export interface HostInteraction {
	requestAction(request: HostActionRequest, options?: { signal?: AbortSignal }): Promise<HostActionDecision>;
	updateAction?(update: HostActionUpdate): void | Promise<void>;
}
