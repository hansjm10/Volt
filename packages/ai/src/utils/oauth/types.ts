import type { Api, Model } from "../../types.ts";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

export type OAuthProviderId = string;

export interface SubscriptionUsageLimit {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: number;
	windowDurationMs?: number;
	limitReached?: boolean;
}

export interface SubscriptionUsageSnapshot {
	providerId: OAuthProviderId;
	fetchedAt: number;
	plan?: string;
	limits: SubscriptionUsageLimit[];
}

export type SubscriptionUsageErrorCode =
	| "unauthorized"
	| "rate_limited"
	| "timeout"
	| "unavailable"
	| "malformed_response";

export interface SubscriptionUsageError {
	code: SubscriptionUsageErrorCode;
	message: string;
}

export type SubscriptionUsageResult =
	| { status: "success"; snapshot: SubscriptionUsageSnapshot }
	| { status: "error"; error: SubscriptionUsageError };

export interface SubscriptionUsageFetchOptions {
	signal?: AbortSignal;
}

/** @deprecated Use OAuthProviderId instead */
export type OAuthProvider = OAuthProviderId;

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export type OAuthDeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

export type OAuthSelectOption = {
	id: string;
	label: string;
};

export type OAuthSelectPrompt = {
	message: string;
	options: OAuthSelectOption[];
};

export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	/** Show an interactive selector and return the selected option id, or undefined on cancel. */
	onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;

	/** Run the login flow, return credentials to persist */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

	/** Whether login uses a local callback server and supports manual code input. */
	usesCallbackServer?: boolean;

	/** Refresh expired credentials, return updated credentials to persist */
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	/** Convert credentials to API key string for the provider */
	getApiKey(credentials: OAuthCredentials): string;

	/** Fetch provider-neutral subscription quota usage for stored OAuth credentials. */
	fetchSubscriptionUsage?(
		credentials: OAuthCredentials,
		options?: SubscriptionUsageFetchOptions,
	): Promise<SubscriptionUsageResult>;

	/** Optional: modify models for this provider (e.g., update baseUrl) */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** @deprecated Use OAuthProviderInterface instead */
export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}
