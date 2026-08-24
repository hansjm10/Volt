import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { RpcRegisterPushTargetArgs, RpcRegisterPushTargetResponse } from "../../rpc/types.ts";
import type { IrohRemoteAuditEventInput, IrohRemoteAuditLogger } from "./audit.ts";
import type {
	IrohRemoteClient,
	IrohRemotePushTarget,
	IrohRemotePushTargetPlatform,
	IrohRemotePushTargetProvider,
} from "./state.ts";
import type { IrohRemoteHostStateManager } from "./state-manager.ts";

export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_ATTEMPTS = 3;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_DELAY_MS = 250;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_TIMEOUT_MS = 10_000;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_URL = "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay";
export const MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES = 512;
export const MAX_IROH_REMOTE_NOTIFICATION_TARGET_UTF8_BYTES = 256;
export const MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES = 512;
export const MAX_IROH_REMOTE_NOTIFICATION_KIND_UTF8_BYTES = 64;

const NOTIFICATION_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const NOTIFICATION_UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const NOTIFICATION_PATH_SEPARATOR = /[/\\]/u;
const IROH_REMOTE_NOTIFICATION_HOST_NODE_ID = /^[0-9a-f]{64}$/u;
const IROH_REMOTE_NOTIFICATION_KINDS = new Set([
	"conversation_completed",
	"plan_ready",
	"review_completed",
	"action_completed",
	"host_notice",
]);

export type IrohRemotePushTargetRegistrationRequest = RpcRegisterPushTargetArgs;
export type IrohRemotePushTargetRegistrationResult = RpcRegisterPushTargetResponse;

export interface IrohRemotePushNotificationIntent {
	eventId: string;
	hostNodeId: string;
	kind: string;
	title: string;
	body: string;
	sessionId?: string;
	workspaceName?: string;
	planId?: string;
	workflowId?: string;
}

function boundNotificationUtf8(value: string, maxBytes: number): string {
	let bounded = "";
	for (const character of value) {
		if (Buffer.byteLength(bounded, "utf8") + Buffer.byteLength(character, "utf8") > maxBytes) {
			break;
		}
		bounded += character;
	}
	return bounded;
}

/** Sanitize one path-free lock-screen text fragment and apply a UTF-8 byte cap. */
export function sanitizeIrohRemoteNotificationText(value: string, maxBytes: number): string | undefined {
	const normalized = value.replace(NOTIFICATION_UNSAFE_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
	if (!normalized || NOTIFICATION_PATH_SEPARATOR.test(normalized)) {
		return undefined;
	}
	return boundNotificationUtf8(normalized, maxBytes).trim() || undefined;
}

/** Accept only the bounded target descriptions produced by the built-in review resolvers. */
export function sanitizeIrohRemoteNotificationTarget(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const target = sanitizeIrohRemoteNotificationText(value, MAX_IROH_REMOTE_NOTIFICATION_TARGET_UTF8_BYTES);
	if (!target) {
		return undefined;
	}
	if (
		target === "uncommitted changes" ||
		/^PR #[1-9]\d*$/u.test(target) ||
		/^commit [0-9a-f]{7,64}$/iu.test(target) ||
		/^branch changes vs [A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target)
	) {
		return target;
	}
	return undefined;
}

export function sanitizeIrohRemoteNotificationWorkspace(value: string | undefined): string | undefined {
	return value === undefined
		? undefined
		: sanitizeIrohRemoteNotificationText(value, MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES);
}

export function sanitizeIrohRemoteNotificationMetadata(
	value: string | undefined,
	maxBytes = MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES,
): string | undefined {
	if (
		value === undefined ||
		value !== value.trim() ||
		/\s/u.test(value) ||
		NOTIFICATION_UNSAFE_CHARACTER.test(value)
	) {
		return undefined;
	}
	if (!value || NOTIFICATION_PATH_SEPARATOR.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
		return undefined;
	}
	return value;
}

export function sanitizeIrohRemoteNotificationHostNodeId(value: string | undefined): string | undefined {
	const hostNodeId = sanitizeIrohRemoteNotificationMetadata(value);
	return hostNodeId && IROH_REMOTE_NOTIFICATION_HOST_NODE_ID.test(hostNodeId) ? hostNodeId : undefined;
}

/** Normalize a trusted notification intent before either push or JSONL delivery. */
export function sanitizeIrohRemotePushNotificationIntent(
	value: IrohRemotePushNotificationIntent,
): IrohRemotePushNotificationIntent | undefined {
	const eventId = sanitizeIrohRemoteNotificationMetadata(
		value.eventId,
		MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES,
	);
	const hostNodeId = sanitizeIrohRemoteNotificationHostNodeId(value.hostNodeId);
	const kind = sanitizeIrohRemoteNotificationMetadata(value.kind, MAX_IROH_REMOTE_NOTIFICATION_KIND_UTF8_BYTES);
	const title = sanitizeIrohRemoteNotificationText(value.title, MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES);
	const body = sanitizeIrohRemoteNotificationText(value.body, MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES);
	const sessionId = sanitizeIrohRemoteNotificationMetadata(value.sessionId);
	const workspaceName = sanitizeIrohRemoteNotificationWorkspace(value.workspaceName);
	const planId = sanitizeIrohRemoteNotificationMetadata(value.planId);
	const workflowId = sanitizeIrohRemoteNotificationMetadata(value.workflowId);
	if (
		!eventId ||
		!hostNodeId ||
		!kind ||
		!IROH_REMOTE_NOTIFICATION_KINDS.has(kind) ||
		!title ||
		!body ||
		(value.sessionId !== undefined && sessionId === undefined) ||
		(value.workspaceName !== undefined && workspaceName === undefined) ||
		(value.planId !== undefined && planId === undefined) ||
		(value.workflowId !== undefined && workflowId === undefined) ||
		(kind === "plan_ready" && (planId === undefined || workflowId !== undefined)) ||
		(kind === "review_completed" && (workflowId === undefined || planId !== undefined)) ||
		(kind !== "plan_ready" && kind !== "review_completed" && (planId !== undefined || workflowId !== undefined))
	) {
		return undefined;
	}
	return {
		eventId,
		hostNodeId,
		kind,
		title,
		body,
		...(sessionId === undefined ? {} : { sessionId }),
		...(workspaceName === undefined ? {} : { workspaceName }),
		...(planId === undefined ? {} : { planId }),
		...(workflowId === undefined ? {} : { workflowId }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict control-plane parser: unsafe or non-canonical text is rejected, not silently rewritten. */
export function parseIrohRemotePushNotificationIntent(value: unknown): IrohRemotePushNotificationIntent | undefined {
	if (
		!isRecord(value) ||
		!Object.keys(value).every((key) =>
			[
				"eventId",
				"hostNodeId",
				"kind",
				"title",
				"body",
				"sessionId",
				"workspaceName",
				"planId",
				"workflowId",
			].includes(key),
		) ||
		typeof value.eventId !== "string" ||
		typeof value.hostNodeId !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.title !== "string" ||
		typeof value.body !== "string" ||
		(value.sessionId !== undefined && typeof value.sessionId !== "string") ||
		(value.workspaceName !== undefined && typeof value.workspaceName !== "string") ||
		(value.planId !== undefined && typeof value.planId !== "string") ||
		(value.workflowId !== undefined && typeof value.workflowId !== "string")
	) {
		return undefined;
	}
	const sanitized = sanitizeIrohRemotePushNotificationIntent(value as unknown as IrohRemotePushNotificationIntent);
	if (!sanitized) {
		return undefined;
	}
	for (const [key, entry] of Object.entries(sanitized)) {
		if (value[key] !== entry) {
			return undefined;
		}
	}
	return Object.keys(value).length === Object.keys(sanitized).length ? sanitized : undefined;
}

export interface IrohRemotePushRelayNotificationRequest {
	pushTargetId: string;
	pushTargetAuthToken: string;
	eventId: string;
	hostNodeId: string;
	kind: string;
	title: string;
	body: string;
	workspaceName?: string;
	planId?: string;
	workflowId?: string;
	data: {
		eventId: string;
		hostNodeId: string;
		kind: string;
		sessionId?: string;
		workspaceName?: string;
		planId?: string;
		workflowId?: string;
	};
}

export interface IrohRemotePushRelayRevocationRequest {
	pushTargetId: string;
	pushTargetAuthToken: string;
}

export type IrohRemotePushRelayNotificationResult = { status: "sent" } | { status: "invalid_target" };
export type IrohRemotePushRelayRevocationResult = { status: "revoked" } | { status: "already_absent" };

export interface IrohRemotePushRelayClient {
	sendNotification(request: IrohRemotePushRelayNotificationRequest): Promise<IrohRemotePushRelayNotificationResult>;
	revokePushTarget?(request: IrohRemotePushRelayRevocationRequest): Promise<IrohRemotePushRelayRevocationResult>;
}

export interface IrohRemotePushTargetRevocationSummary {
	attempted: number;
	revoked: number;
	alreadyAbsent: number;
	failed: number;
	skipped: number;
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
}

export interface IrohRemotePushNotificationDeduper {
	tryMark(clientNodeId: string, eventId: string): boolean;
	/** Release a mark claimed by tryMark when the corresponding delivery did not succeed. */
	unmark(clientNodeId: string, eventId: string): void;
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

// The deduper lives for the daemon's whole lifetime, so the per-client id set is
// bounded. Re-marking an evicted id at most re-sends one very old notification.
const MAX_SENT_EVENT_IDS_PER_CLIENT = 1000;
export const MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT = 8;
export const MAX_IROH_REMOTE_PUSH_TARGET_REVOCATION_CONCURRENCY = 4;
const MAX_IROH_REMOTE_PUSH_RELAY_RESPONSE_BYTES = 1024;

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
		// Evict oldest ids (Sets preserve insertion order) once over the cap.
		while (sentEventIds.size > MAX_SENT_EVENT_IDS_PER_CLIENT) {
			const oldest = sentEventIds.values().next().value;
			if (oldest === undefined) {
				break;
			}
			sentEventIds.delete(oldest);
		}
		return true;
	}

	unmark(clientNodeId: string, eventId: string): void {
		this.sentEventIdsByClient.get(clientNodeId)?.delete(eventId);
	}
}

export class IrohRemotePushRelayHttpError extends Error {
	readonly status: number;
	readonly transient: boolean;

	constructor(status: number, transient: boolean, detail?: string) {
		super(`Push relay request failed with HTTP ${status}${detail ? ` (${detail})` : ""}`);
		this.name = "IrohRemotePushRelayHttpError";
		this.status = status;
		this.transient = transient;
	}
}

const MAX_RELAY_ERROR_DETAIL_LENGTH = 200;

/** Best-effort extraction of the relay's `{ error, code }` body for audit logs. */
async function readRelayErrorDetail(response: Response): Promise<string | undefined> {
	try {
		const body: unknown = await readBoundedRelayJson(response);
		if (typeof body !== "object" || body === null) {
			return undefined;
		}
		const record = body as Record<string, unknown>;
		const parts = [record.error, record.code].filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
		if (parts.length === 0) {
			return undefined;
		}
		return parts.join(": ").slice(0, MAX_RELAY_ERROR_DETAIL_LENGTH);
	} catch {
		return undefined;
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

	async revokePushTarget(request: IrohRemotePushRelayRevocationRequest): Promise<IrohRemotePushRelayRevocationResult> {
		const response = await this.fetcher(new URL("v1/push-targets/revoke", this.baseUrl).toString(), {
			body: JSON.stringify(createRelayRevocationBody(request)),
			headers: this.createHeaders(),
			method: "POST",
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (response.status === 404 || response.status === 410) {
			return { status: "already_absent" };
		}
		if (!response.ok) {
			throw new IrohRemotePushRelayHttpError(
				response.status,
				isTransientHttpStatus(response.status),
				await readRelayErrorDetail(response),
			);
		}
		const body = await readBoundedRelayJson(response);
		if (body.status === "revoked") return { status: "revoked" };
		if (body.status === "already_revoked") return { status: "already_absent" };
		throw new IrohRemotePushRelayHttpError(502, true, "invalid revoke response");
	}

	private async sendRelayRequest(
		path: string,
		body: IrohRemotePushRelayNotificationRequest | IrohRemotePushRelayRevocationRequest,
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
		// 404/410: target unknown or disabled. 422: the relay cannot deliver to
		// this target at all. Treat these as invalid instead of retrying a
		// permanently undeliverable channel.
		if (response.status === 404 || response.status === 410 || response.status === 422) {
			return { status: "invalid_target" };
		}
		throw new IrohRemotePushRelayHttpError(
			response.status,
			isTransientHttpStatus(response.status),
			await readRelayErrorDetail(response),
		);
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
		hostNodeId: request.hostNodeId,
		kind: request.kind,
		title: request.title,
		body: request.body,
		...(request.workspaceName === undefined ? {} : { workspaceName: request.workspaceName }),
		...(request.planId === undefined ? {} : { planId: request.planId }),
		...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
		data: request.data,
	};
}

function createRelayRevocationBody(
	request: IrohRemotePushRelayRevocationRequest,
): IrohRemotePushRelayRevocationRequest {
	return {
		pushTargetId: request.pushTargetId,
		pushTargetAuthToken: request.pushTargetAuthToken,
	};
}

async function readBoundedRelayJson(response: Response): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) return {};
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_IROH_REMOTE_PUSH_RELAY_RESPONSE_BYTES) {
				await reader.cancel();
				throw new IrohRemotePushRelayHttpError(502, true, "relay response too large");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Best-effort cleanup after local client revocation. Local authority is already
 * gone before this runs, so relay failures are summarized rather than thrown.
 * The call count is capped to keep a corrupted or malicious state file from
 * turning one control request into unbounded outbound work; relay TTL bounds any
 * skipped or failed credential's remaining lifetime.
 */
export async function revokeIrohRemoteClientPushTargets(
	client: Pick<IrohRemoteClient, "pushTargets"> | undefined,
	relayClient: IrohRemotePushRelayClient,
): Promise<IrohRemotePushTargetRevocationSummary> {
	const uniqueTargets = new Map<string, IrohRemotePushRelayRevocationRequest>();
	for (const target of client?.pushTargets ?? []) {
		if (target.id.length === 0 || target.pushTargetAuthToken.length === 0) continue;
		uniqueTargets.set(`${target.id}\0${target.pushTargetAuthToken}`, {
			pushTargetId: target.id,
			pushTargetAuthToken: target.pushTargetAuthToken,
		});
	}
	const targets = Array.from(uniqueTargets.values());
	const selectedTargets = targets.slice(0, MAX_IROH_REMOTE_PUSH_TARGET_REVOCATIONS_PER_CLIENT);
	const summary: IrohRemotePushTargetRevocationSummary = {
		attempted: selectedTargets.length,
		revoked: 0,
		alreadyAbsent: 0,
		failed: 0,
		skipped: targets.length - selectedTargets.length,
	};
	const revokePushTarget = relayClient.revokePushTarget?.bind(relayClient);
	if (!revokePushTarget) {
		summary.failed = selectedTargets.length;
		return summary;
	}
	for (let offset = 0; offset < selectedTargets.length; offset += MAX_IROH_REMOTE_PUSH_TARGET_REVOCATION_CONCURRENCY) {
		const batch = selectedTargets.slice(offset, offset + MAX_IROH_REMOTE_PUSH_TARGET_REVOCATION_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((target) => revokePushTarget(target)));
		for (const result of results) {
			if (result.status === "rejected") {
				summary.failed += 1;
			} else if (result.value.status === "revoked") {
				summary.revoked += 1;
			} else {
				summary.alreadyAbsent += 1;
			}
		}
	}
	return summary;
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
					enabled: registration.enabled,
				},
			});
			throw new Error(redactedError);
		}
	}

	async deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus> {
		const sanitized = sanitizeIrohRemotePushNotificationIntent(notification);
		if (!sanitized) {
			return "failed";
		}
		if (!(await this.markDeliveryIntent(sanitized.eventId, sanitized.kind))) {
			return "duplicate";
		}

		const client = await this.stateManager.getClient(this.clientNodeId);
		const pushTarget = selectEnabledPushTarget(client?.pushTargets ?? []);
		if (!pushTarget) {
			this.deduper.unmark(this.clientNodeId, sanitized.eventId);
			await this.logPushFallback(sanitized.eventId, sanitized.kind, "no_push_target");
			return "no_push_target";
		}

		const relayRequest = createRelayNotificationRequest(pushTarget, sanitized);
		try {
			const relayResult = await this.sendNotificationWithRetry(relayRequest);
			if (relayResult.status === "invalid_target") {
				await this.stateManager.disableClientPushTarget(this.clientNodeId, pushTarget.id, this.now());
				this.deduper.unmark(this.clientNodeId, sanitized.eventId);
				await this.logPushDelivery(
					pushTarget,
					sanitized.eventId,
					sanitized.kind,
					false,
					"push target is invalid or unregistered",
				);
				return "invalid_target";
			}
			await this.logPushDelivery(pushTarget, sanitized.eventId, sanitized.kind, true);
			return "sent";
		} catch (error: unknown) {
			// Release the dedup claim so a transient relay failure can be retried on a
			// later re-emission instead of being permanently suppressed as delivered.
			this.deduper.unmark(this.clientNodeId, sanitized.eventId);
			await this.logPushDelivery(pushTarget, sanitized.eventId, sanitized.kind, false, toErrorMessage(error));
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
				tokenHash: pushTarget.tokenHash,
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
		enabled: expectBoolean(args.enabled, "push enabled"),
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
	return {
		pushTargetId: pushTarget.id,
		pushTargetAuthToken: pushTarget.pushTargetAuthToken,
		eventId: notification.eventId,
		hostNodeId: notification.hostNodeId,
		kind: notification.kind,
		title: notification.title,
		body: notification.body,
		...(notification.workspaceName === undefined ? {} : { workspaceName: notification.workspaceName }),
		...(notification.planId === undefined ? {} : { planId: notification.planId }),
		...(notification.workflowId === undefined ? {} : { workflowId: notification.workflowId }),
		data: {
			eventId: notification.eventId,
			hostNodeId: notification.hostNodeId,
			kind: notification.kind,
			...(notification.sessionId === undefined ? {} : { sessionId: notification.sessionId }),
			...(notification.workspaceName === undefined ? {} : { workspaceName: notification.workspaceName }),
			...(notification.planId === undefined ? {} : { planId: notification.planId }),
			...(notification.workflowId === undefined ? {} : { workflowId: notification.workflowId }),
		},
	};
}

function getPushTargetAuditDetails(pushTarget: IrohRemotePushTarget): Record<string, unknown> {
	return {
		pushTargetId: pushTarget.id,
		provider: pushTarget.provider,
		platform: pushTarget.platform,
		relayUrl: pushTarget.relayUrl,
		tokenHash: pushTarget.tokenHash,
		enabled: pushTarget.enabled,
		createdAt: pushTarget.createdAt,
		updatedAt: pushTarget.updatedAt,
	};
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

function delay(ms: number): Promise<void> {
	if (ms === 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
