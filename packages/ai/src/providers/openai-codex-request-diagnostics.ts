import type { Transport } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import type { JsonObject } from "../utils/json-value.ts";

const MAX_INPUT_ITEM_HASHES = 2048;
const HASH_TIMEOUT_MS = 250;

export type CodexRequestDispatch = {
	transport: "websocket" | "sse";
	continuationReason:
		| "eligible"
		| "no_previous_response"
		| "non_input_changed"
		| "input_shorter"
		| "input_prefix_changed"
		| "missing_response_id"
		| "cache_disabled"
		| "transport_not_cached"
		| "connection_not_cached"
		| "sse_requested"
		| "websocket_fallback";
	connectionReused?: boolean;
};

async function hash(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fingerprint serialized snapshots, never retain caller-owned objects or raw payload fields. */
export async function createCodexRequestDiagnostic(
	fullBodyJson: string,
	wireJson: string,
	configuredTransport: Transport,
	attempt: number,
	dispatch: CodexRequestDispatch,
): Promise<AssistantMessageDiagnostic> {
	const timestamp = Date.now();
	const wireBody: Record<string, unknown> = JSON.parse(wireJson);
	// Full requests fingerprint exactly what was sent. Delta requests also need
	// the already-serialized pre-transport context, never another hook traversal.
	const fullBody: Record<string, unknown> = wireBody.previous_response_id ? JSON.parse(fullBodyJson) : wireBody;
	const fullInput = Array.isArray(fullBody.input) ? fullBody.input : [];
	const wireInput = wireBody.input ?? [];
	const details: JsonObject = {
		...dispatch,
		requestMode: wireBody.previous_response_id ? "delta" : "full",
		configuredTransport,
		attempt,
		fullInputItems: fullInput.length,
		wireInputItems: Array.isArray(wireInput) ? wireInput.length : 0,
		inputItemsTruncated: fullInput.length > MAX_INPUT_ITEM_HASHES,
		hashesAvailable: false,
	};
	// Exclude the WebSocket envelope and continuation pointer so full/delta
	// requests with identical non-input policy have comparable fingerprints.
	const { type: _type, input: _input, previous_response_id: _previousResponseId, ...configuration } = wireBody;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const fingerprints = Promise.all([
			hash(wireBody.prompt_cache_key ?? null),
			hash(wireBody.instructions ?? null),
			hash(wireBody.tools ?? null),
			hash(configuration),
			Promise.all(fullInput.slice(0, MAX_INPUT_ITEM_HASHES).map(hash)),
			hash(wireInput),
			hash(wireBody.previous_response_id ?? null),
		]);
		const hashes = await Promise.race([
			fingerprints,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), HASH_TIMEOUT_MS);
			}),
		]);
		if (hashes) {
			const [cacheKey, instructions, tools, config, inputItems, wire, previousResponseId] = hashes;
			details.hashesAvailable = true;
			details.hashes = {
				cacheKey,
				instructions,
				tools,
				configuration: config,
				inputItems,
				wireInput: wire,
				previousResponseId,
			};
		}
	} catch {
		// Diagnostics must neither fail inference nor expose crypto/payload errors.
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	return { type: "codex_request", timestamp, details };
}
