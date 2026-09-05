import { DEFAULT_IROH_REMOTE_PUSH_RELAY_URL, IrohRemotePushRelayHttpClient } from "../core/remote/iroh/push.ts";

/** Bind managed credentials to the managed push endpoint, never a custom destination. */
export function createDaemonPushRelayClient(
	config: { pushRelayUrl?: string; pushRelayAuthToken?: string },
	getManagedAccessToken: () => string | undefined,
	env: Record<string, string | undefined> = process.env,
): IrohRemotePushRelayHttpClient {
	const baseUrl = config.pushRelayUrl ?? env.VOLT_PUSH_RELAY_URL ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_URL;
	let useManagedAuth = false;
	try {
		// Match the HTTP client's trailing-slash handling and URL resolution. The
		// function path is part of the authority boundary, not just the origin.
		useManagedAuth =
			new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href === `${DEFAULT_IROH_REMOTE_PUSH_RELAY_URL}/`;
	} catch {
		// Invalid custom URLs still fail at request time, without managed auth.
	}
	return new IrohRemotePushRelayHttpClient({
		baseUrl,
		authToken: () =>
			(useManagedAuth ? getManagedAccessToken() : undefined) ??
			config.pushRelayAuthToken ??
			env.VOLT_PUSH_RELAY_AUTH_TOKEN,
	});
}
