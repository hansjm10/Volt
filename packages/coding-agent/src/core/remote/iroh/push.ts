import { createHash } from "node:crypto";
import type { RpcRegisterPushTargetArgs, RpcRegisterPushTargetResponse } from "../../rpc/types.ts";
import type { IrohRemoteAuditEventInput, IrohRemoteAuditLogger } from "./audit.ts";
import type {
	IrohRemoteClient,
	IrohRemoteLiveActivityRegistration,
	IrohRemotePushTarget,
	IrohRemotePushTargetPlatform,
	IrohRemotePushTargetProvider,
	IrohRemotePushTokenEnvironment,
} from "./state.ts";
import type { IrohRemoteHostStateManager } from "./state-manager.ts";

export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_ATTEMPTS = 3;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_DELAY_MS = 250;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_TIMEOUT_MS = 10_000;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_URL = "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay";

export type IrohRemotePushTargetRegistrationRequest = RpcRegisterPushTargetArgs;
export type IrohRemotePushTargetRegistrationResult = RpcRegisterPushTargetResponse;

export interface IrohRemotePushNotificationIntent {
	eventId: string;
	kind: string;
	title: string;
	body: string;
	sessionId?: string;
	workspace?: string;
}

export interface IrohRemoteLiveActivityToolGlyph {
	name: string;
	symbolName: string;
	status: "started" | "completed" | "failed";
}

export interface IrohRemoteLiveActivityContentState {
	status: "running" | "completed" | "failed" | "waiting";
	statusText: string;
	currentTool?: IrohRemoteLiveActivityToolGlyph;
	recentTools: IrohRemoteLiveActivityToolGlyph[];
	sessionID?: string;
	workspaceName?: string;
	updatedAtEpochSeconds: number;
}

export interface IrohRemoteLiveActivityUpdateIntent {
	eventId: string;
	kind: string;
	activityEvent?: "update" | "end";
	contentState: IrohRemoteLiveActivityContentState;
	staleDateEpochSeconds?: number;
	dismissalDateEpochSeconds?: number;
}

export interface IrohRemotePushRelayNotificationRequest {
	pushTargetId: string;
	pushTargetAuthToken: string;
	eventId: string;
	kind: string;
	title: string;
	body: string;
	workspace?: string;
	data: {
		eventId: string;
		kind: string;
		sessionId?: string;
		workspace?: string;
	};
}

export interface IrohRemotePushRelayLiveActivityRequest {
	pushTargetId: string;
	pushTargetAuthToken: string;
	activityId: string;
	activityPushToken: string;
	eventId: string;
	kind: string;
	contentState: IrohRemoteLiveActivityContentState;
	activityEvent?: "update" | "end";
	staleDateEpochSeconds?: number;
	dismissalDateEpochSeconds?: number;
}

export type IrohRemotePushRelayNotificationResult = { status: "sent" } | { status: "invalid_target" };

export interface IrohRemotePushRelayClient {
	sendNotification(request: IrohRemotePushRelayNotificationRequest): Promise<IrohRemotePushRelayNotificationResult>;
	sendLiveActivityUpdate?(
		request: IrohRemotePushRelayLiveActivityRequest,
	): Promise<IrohRemotePushRelayNotificationResult>;
}

export type IrohRemotePushNotificationDeliveryStatus =
	| "sent"
	| "no_push_target"
	| "duplicate"
	| "failed"
	| "invalid_target";

export interface IrohRemotePushNotificationDelivery {
	deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
	deliverLiveActivityUpdate?(
		update: IrohRemoteLiveActivityUpdateIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
}

export interface IrohRemotePushNotificationDeduper {
	tryMark(clientNodeId: string, eventId: string): boolean;
}

export interface IrohRemotePushNotificationDispatcherOptions {
	auditLogger?: IrohRemoteAuditLogger;
	clientNodeId: string;
	deduper?: IrohRemotePushNotificationDeduper;
	now?: () => number;
	relayClient: IrohRemotePushRelayClient;
	retryAttempts?: number;
	retryDelayMs?: number;
	stateManager: IrohRemoteHostStateManager;
	workspace?: string;
}

export interface IrohRemotePushRelayHttpClientOptions {
	authToken?: string;
	baseUrl?: string;
	fetcher?: (input: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}

export class IrohRemoteInMemoryPushNotificationDeduper implements IrohRemotePushNotificationDeduper {
	private readonly sentEventIdsByClient = new Map<string, Set<string>>();

	tryMark(clientNodeId: string, eventId: string): boolean {
		let sentEventIds = this.sentEventIdsByClient.get(clientNodeId);
		if (!sentEventIds) {
			sentEventIds = new Set();
			this.sentEventIdsByClient.set(clientNodeId, sentEventIds);
		}
		if (sentEventIds.has(eventId)) {
			return false;
		}
		sentEventIds.add(eventId);
		return true;
	}
}

export class IrohRemotePushRelayHttpError extends Error {
	readonly status: number;
	readonly transient: boolean;

	constructor(status: number, transient: boolean) {
		super(`Push relay request failed with HTTP ${status}`);
		this.name = "IrohRemotePushRelayHttpError";
		this.status = status;
		this.transient = transient;
	}
}

export class IrohRemotePushRelayHttpClient implements IrohRemotePushRelayClient {
	private readonly authToken: string | undefined;
	private readonly baseUrl: string;
	private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
	private readonly timeoutMs: number;

	constructor(options: IrohRemotePushRelayHttpClientOptions) {
		this.authToken = options.authToken;
		const baseUrl = options.baseUrl ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_URL;
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_TIMEOUT_MS;
	}

	async sendNotification(
		request: IrohRemotePushRelayNotificationRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		return this.sendRelayRequest("v1/notifications", createRelayNotificationBody(request));
	}

	async sendLiveActivityUpdate(
		request: IrohRemotePushRelayLiveActivityRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		return this.sendRelayRequest("v1/live-activities", createRelayLiveActivityBody(request));
	}

	private async sendRelayRequest(
		path: string,
		body: IrohRemotePushRelayNotificationRequest | IrohRemotePushRelayLiveActivityRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		const response = await this.fetcher(new URL(path, this.baseUrl).toString(), {
			body: JSON.stringify(body),
			headers: this.createHeaders(),
			method: "POST",
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (response.ok) {
			return { status: "sent" };
		}
		if (response.status === 404 || response.status === 410) {
			return { status: "invalid_target" };
		}
		throw new IrohRemotePushRelayHttpError(response.status, isTransientHttpStatus(response.status));
	}

	private createHeaders(): Record<string, string> {
		return {
			"content-type": "application/json",
			...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
		};
	}
}

function createRelayNotificationBody(
	request: IrohRemotePushRelayNotificationRequest,
): IrohRemotePushRelayNotificationRequest {
	return {
		pushTargetId: request.pushTargetId,
		pushTargetAuthToken: request.pushTargetAuthToken,
		eventId: request.eventId,
		kind: request.kind,
		title: request.title,
		body: request.body,
		...(request.workspace === undefined ? {} : { workspace: request.workspace }),
		data: request.data,
	};
}

function createRelayLiveActivityBody(
	request: IrohRemotePushRelayLiveActivityRequest,
): IrohRemotePushRelayLiveActivityRequest {
	return {
		pushTargetId: request.pushTargetId,
		pushTargetAuthToken: request.pushTargetAuthToken,
		activityId: request.activityId,
		activityPushToken: request.activityPushToken,
		eventId: request.eventId,
		kind: request.kind,
		contentState: request.contentState,
		...(request.activityEvent === undefined ? {} : { activityEvent: request.activityEvent }),
		...(request.staleDateEpochSeconds === undefined ? {} : { staleDateEpochSeconds: request.staleDateEpochSeconds }),
		...(request.dismissalDateEpochSeconds === undefined
			? {}
			: { dismissalDateEpochSeconds: request.dismissalDateEpochSeconds }),
	};
}

export class IrohRemotePushNotificationDispatcher implements IrohRemotePushNotificationDelivery {
	private readonly auditLogger: IrohRemoteAuditLogger | undefined;
	private readonly clientNodeId: string;
	private readonly deduper: IrohRemotePushNotificationDeduper;
	private readonly now: () => number;
	private readonly relayClient: IrohRemotePushRelayClient;
	private readonly retryAttempts: number;
	private readonly retryDelayMs: number;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly workspace: string | undefined;

	constructor(options: IrohRemotePushNotificationDispatcherOptions) {
		this.auditLogger = options.auditLogger;
		this.clientNodeId = options.clientNodeId;
		this.deduper = options.deduper ?? new IrohRemoteInMemoryPushNotificationDeduper();
		this.now = options.now ?? Date.now;
		this.relayClient = options.relayClient;
		this.retryAttempts = Math.max(
			1,
			Math.trunc(options.retryAttempts ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_ATTEMPTS),
		);
		this.retryDelayMs = Math.max(
			0,
			Math.trunc(options.retryDelayMs ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_DELAY_MS),
		);
		this.stateManager = options.stateManager;
		this.workspace = options.workspace;
	}

	async registerPushTarget(args: unknown): Promise<RpcRegisterPushTargetResponse> {
		const registration = parseRegisterPushTargetArgs(args);
		try {
			const now = this.now();
			const pushTarget: IrohRemotePushTarget = {
				id: registration.pushTargetId,
				provider: registration.provider,
				platform: registration.platform,
				pushTargetAuthToken: registration.pushTargetAuthToken,
				...(registration.relayUrl === undefined ? {} : { relayUrl: registration.relayUrl }),
				...(registration.tokenHash === undefined ? {} : { tokenHash: registration.tokenHash }),
				...(registration.liveActivity === undefined
					? {}
					: {
							liveActivity: {
								activityId: registration.liveActivity.activityId,
								pushToken: registration.liveActivity.pushToken,
								...(registration.liveActivity.tokenHash === undefined
									? {}
									: { tokenHash: registration.liveActivity.tokenHash }),
								...(registration.liveActivity.tokenEnvironment === undefined
									? {}
									: { tokenEnvironment: registration.liveActivity.tokenEnvironment }),
								updatedAt: now,
							},
						}),
				enabled: registration.enabled,
				createdAt: now,
				updatedAt: now,
			};
			const client = await this.stateManager.upsertClientPushTarget(this.clientNodeId, pushTarget);
			if (!client) {
				throw new Error("paired client not found");
			}
			await this.log({
				type: "push_target_registered",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: true,
				details: getPushTargetAuditDetails(pushTarget),
			});
			return { status: "registered", pushTargetId: registration.pushTargetId };
		} catch (error: unknown) {
			const errorMessage = toErrorMessage(error);
			const redactedError =
				registration.pushTargetAuthToken.length === 0
					? errorMessage
					: errorMessage.split(registration.pushTargetAuthToken).join("[redacted-push-target-auth-token]");
			await this.log({
				type: "push_target_registered",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: false,
				error: redactedError,
				details: {
					pushTargetId: registration.pushTargetId,
					provider: registration.provider,
					platform: registration.platform,
					relayUrl: registration.relayUrl,
					tokenHash: registration.tokenHash,
					liveActivityTokenHash: registration.liveActivity?.tokenHash,
					liveActivityTokenEnvironment: registration.liveActivity?.tokenEnvironment,
					enabled: registration.enabled,
				},
			});
			throw new Error(redactedError);
		}
	}

	async deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus> {
		if (!(await this.markDeliveryIntent(notification.eventId, notification.kind))) {
			return "duplicate";
		}

		const client = await this.stateManager.getClient(this.clientNodeId);
		const pushTarget = selectEnabledPushTarget(client?.pushTargets ?? []);
		if (!pushTarget) {
			await this.logPushFallback(notification.eventId, notification.kind, "no_push_target");
			return "no_push_target";
		}

		const relayRequest = createRelayNotificationRequest(pushTarget, notification);
		try {
			const relayResult = await this.sendNotificationWithRetry(relayRequest);
			if (relayResult.status === "invalid_target") {
				await this.stateManager.disableClientPushTarget(this.clientNodeId, pushTarget.id, this.now());
				await this.logPushDelivery(
					pushTarget,
					notification.eventId,
					notification.kind,
					false,
					"push target is invalid or unregistered",
				);
				return "invalid_target";
			}
			await this.logPushDelivery(pushTarget, notification.eventId, notification.kind, true);
			return "sent";
		} catch (error: unknown) {
			await this.logPushDelivery(pushTarget, notification.eventId, notification.kind, false, toErrorMessage(error));
			return "failed";
		}
	}

	async deliverLiveActivityUpdate(
		update: IrohRemoteLiveActivityUpdateIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus> {
		if (!(await this.markDeliveryIntent(update.eventId, update.kind))) {
			return "duplicate";
		}

		const client = await this.stateManager.getClient(this.clientNodeId);
		const registration = selectLiveActivityRegistration(client, update.contentState);
		const pushTarget = registration ? findRegisteredLiveActivityPushTarget(client, registration) : undefined;
		if (!registration || !pushTarget?.liveActivity) {
			await this.logPushFallback(update.eventId, update.kind, "no_live_activity_target");
			return "no_push_target";
		}

		const relayRequest = createRelayLiveActivityRequest(pushTarget, update, registration.activityId);
		try {
			const relayResult = await this.sendLiveActivityUpdateWithRetry(relayRequest);
			if (relayResult.status === "invalid_target") {
				await this.logPushDelivery(
					pushTarget,
					update.eventId,
					update.kind,
					false,
					"live activity target is invalid or unregistered",
					registration.tokenHash,
				);
				return "invalid_target";
			}
			await this.logPushDelivery(pushTarget, update.eventId, update.kind, true, undefined, registration.tokenHash);
			return "sent";
		} catch (error: unknown) {
			await this.logPushDelivery(
				pushTarget,
				update.eventId,
				update.kind,
				false,
				toErrorMessage(error),
				registration.tokenHash,
			);
			return "failed";
		}
	}

	private async markDeliveryIntent(eventId: string, kind: string): Promise<boolean> {
		if (this.deduper.tryMark(this.clientNodeId, eventId)) {
			return true;
		}
		await this.log({
			type: "push_notification_deduplicated",
			clientNodeId: this.clientNodeId,
			workspace: this.workspace,
			success: true,
			details: { eventId, kind },
		});
		return false;
	}

	private async logPushFallback(eventId: string, kind: string, reason: string): Promise<void> {
		await this.log({
			type: "push_notification_fallback",
			clientNodeId: this.clientNodeId,
			workspace: this.workspace,
			success: true,
			details: { eventId, kind, reason },
		});
	}

	private async sendNotificationWithRetry(
		request: IrohRemotePushRelayNotificationRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		return this.sendWithRetry(() => this.relayClient.sendNotification(request));
	}

	private async sendLiveActivityUpdateWithRetry(
		request: IrohRemotePushRelayLiveActivityRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		const sendLiveActivityUpdate = this.relayClient.sendLiveActivityUpdate?.bind(this.relayClient);
		if (!sendLiveActivityUpdate) {
			throw new Error("push relay does not support live activity updates");
		}
		return this.sendWithRetry(() => sendLiveActivityUpdate(request));
	}

	private async sendWithRetry(
		send: () => Promise<IrohRemotePushRelayNotificationResult>,
	): Promise<IrohRemotePushRelayNotificationResult> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
			try {
				return await send();
			} catch (error: unknown) {
				lastError = error;
				if (attempt >= this.retryAttempts || !isTransientPushRelayError(error)) {
					throw error;
				}
				await delay(this.retryDelayMs * attempt);
			}
		}
		throw lastError;
	}

	private async logPushDelivery(
		pushTarget: IrohRemotePushTarget,
		eventId: string,
		kind: string,
		success: boolean,
		error?: string,
		deliveredTokenHash?: string,
	): Promise<void> {
		await this.log({
			type: "push_notification_delivered",
			clientNodeId: this.clientNodeId,
			workspace: this.workspace,
			success,
			error,
			details: {
				eventId,
				kind,
				pushTargetId: pushTarget.id,
				provider: pushTarget.provider,
				platform: pushTarget.platform,
				tokenHash: deliveredTokenHash ?? pushTarget.tokenHash,
			},
		});
	}

	private async log(event: IrohRemoteAuditEventInput): Promise<void> {
		if (!this.auditLogger) {
			return;
		}
		try {
			await this.auditLogger.log(event);
		} catch {
			// Push relay side effects should not be reinterpreted as RPC failures if audit I/O fails.
		}
	}
}

export function hashIrohRemotePushToken(token: string): string {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

export function parseRegisterPushTargetArgs(value: unknown): RpcRegisterPushTargetArgs {
	const args = expectRecord(value, "register_push_target args");
	return {
		provider: expectPushProvider(args.provider),
		platform: expectPushPlatform(args.platform),
		pushTargetId: expectString(args.pushTargetId, "push target id"),
		pushTargetAuthToken: expectString(args.pushTargetAuthToken, "push target auth token"),
		relayUrl: expectOptionalString(args.relayUrl, "push relay URL"),
		tokenHash: expectOptionalString(args.tokenHash, "push token hash"),
		liveActivity: parseOptionalLiveActivityRegistration(args.liveActivity, "push liveActivity"),
		enabled: expectBoolean(args.enabled, "push enabled"),
	};
}

function parseOptionalLiveActivityRegistration(
	value: unknown,
	label: string,
): RpcRegisterPushTargetArgs["liveActivity"] {
	if (value === undefined) {
		return undefined;
	}
	const liveActivity = expectRecord(value, label);
	return {
		activityId: expectString(liveActivity.activityId, `${label} activityId`),
		pushToken: expectString(liveActivity.pushToken, `${label} pushToken`),
		tokenHash: expectOptionalString(liveActivity.tokenHash, `${label} tokenHash`),
		tokenEnvironment: expectOptionalPushTokenEnvironment(liveActivity.tokenEnvironment, `${label} tokenEnvironment`),
	};
}

function selectEnabledPushTarget(pushTargets: IrohRemotePushTarget[]): IrohRemotePushTarget | undefined {
	return pushTargets
		.filter((target) => target.enabled)
		.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
}

function createRelayNotificationRequest(
	pushTarget: IrohRemotePushTarget,
	notification: IrohRemotePushNotificationIntent,
): IrohRemotePushRelayNotificationRequest {
	const workspace = getSafeNotificationWorkspace(notification.workspace);
	return {
		pushTargetId: pushTarget.id,
		pushTargetAuthToken: pushTarget.pushTargetAuthToken,
		eventId: notification.eventId,
		kind: notification.kind,
		title: notification.title,
		body: notification.body,
		...(workspace === undefined ? {} : { workspace }),
		data: {
			eventId: notification.eventId,
			kind: notification.kind,
			...(notification.sessionId === undefined ? {} : { sessionId: notification.sessionId }),
			...(workspace === undefined ? {} : { workspace }),
		},
	};
}

function getSafeNotificationWorkspace(workspace: string | undefined): string | undefined {
	if (workspace === undefined) {
		return undefined;
	}
	const trimmed = workspace.trim();
	if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
		return undefined;
	}
	return trimmed;
}

function createRelayLiveActivityRequest(
	pushTarget: IrohRemotePushTarget,
	update: IrohRemoteLiveActivityUpdateIntent,
	activityId = pushTarget.liveActivity?.activityId,
): IrohRemotePushRelayLiveActivityRequest {
	if (!pushTarget.liveActivity) {
		throw new Error("push target has no live activity token");
	}
	if (!activityId) {
		throw new Error("live activity registration has no activity id");
	}
	return {
		pushTargetId: pushTarget.id,
		pushTargetAuthToken: pushTarget.pushTargetAuthToken,
		activityId,
		activityPushToken: pushTarget.liveActivity.pushToken,
		eventId: update.eventId,
		kind: update.kind,
		contentState: update.contentState,
		...(update.activityEvent === undefined ? {} : { activityEvent: update.activityEvent }),
		...(update.staleDateEpochSeconds === undefined ? {} : { staleDateEpochSeconds: update.staleDateEpochSeconds }),
		...(update.dismissalDateEpochSeconds === undefined
			? {}
			: { dismissalDateEpochSeconds: update.dismissalDateEpochSeconds }),
	};
}

function getPushTargetAuditDetails(pushTarget: IrohRemotePushTarget): Record<string, unknown> {
	return {
		pushTargetId: pushTarget.id,
		provider: pushTarget.provider,
		platform: pushTarget.platform,
		relayUrl: pushTarget.relayUrl,
		tokenHash: pushTarget.tokenHash,
		liveActivityTokenHash: pushTarget.liveActivity?.tokenHash,
		liveActivityTokenEnvironment: pushTarget.liveActivity?.tokenEnvironment,
		enabled: pushTarget.enabled,
		createdAt: pushTarget.createdAt,
		updatedAt: pushTarget.updatedAt,
	};
}

function selectLiveActivityRegistration(
	client: IrohRemoteClient | undefined,
	contentState: IrohRemoteLiveActivityContentState,
): IrohRemoteLiveActivityRegistration | undefined {
	const workspaceName = contentState.workspaceName;
	const sessionId = contentState.sessionID;
	if (!workspaceName || !sessionId) {
		return undefined;
	}
	return (client?.liveActivities ?? [])
		.filter((registration) => {
			return registration.workspaceName === workspaceName && registration.sessionId === sessionId;
		})
		.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
}

function findRegisteredLiveActivityPushTarget(
	client: IrohRemoteClient | undefined,
	registration: IrohRemoteLiveActivityRegistration,
): IrohRemotePushTarget | undefined {
	return client?.pushTargets?.find((target) => {
		return (
			target.id === registration.pushTargetId &&
			target.platform === registration.platform &&
			target.liveActivity?.tokenHash === registration.tokenHash &&
			target.liveActivity.tokenEnvironment === registration.tokenEnvironment
		);
	});
}

function isTransientPushRelayError(error: unknown): boolean {
	if (error instanceof IrohRemotePushRelayHttpError) {
		return error.transient;
	}
	return true;
}

function isTransientHttpStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function expectPushProvider(value: unknown): IrohRemotePushTargetProvider {
	if (value === "fcm") {
		return value;
	}
	throw new Error("push provider must be fcm");
}

function expectPushPlatform(value: unknown): IrohRemotePushTargetPlatform {
	if (value === "ios") {
		return value;
	}
	throw new Error("push platform must be ios");
}

function expectOptionalPushTokenEnvironment(value: unknown, label: string): IrohRemotePushTokenEnvironment | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "development" || value === "production") {
		return value;
	}
	throw new Error(`${label} must be development or production`);
}

function delay(ms: number): Promise<void> {
	if (ms === 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
