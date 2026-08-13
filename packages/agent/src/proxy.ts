/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AssistantStreamFragment,
	AssistantStreamNormalizer,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
} from "@hansjm10/volt-ai";

/** Compact fragment protocol sent by the proxy server. */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "maxTokens"
	| "reasoning"
	| "inferenceSpeed"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Report that this proxy protocol cannot attest the server's final tool payload. */
	reportToolSetSnapshot?: SimpleStreamOptions["reportToolSetSnapshot"];
	/** Local abort signal for the proxy request. */
	signal?: AbortSignal;
	/** Auth token for the proxy server. */
	authToken: string;
	/** Proxy server URL (for example, `https://genai.example.com`). */
	proxyUrl: string;
}

function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
		...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
		...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
		...(options.inferenceSpeed === undefined ? {} : { inferenceSpeed: options.inferenceSpeed }),
		...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options.headers === undefined ? {} : { headers: options.headers }),
		...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		...(options.transport === undefined ? {} : { transport: options.transport }),
		...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
		...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
	};
}

/**
 * Stream through a remote provider proxy. The proxy protocol already carries
 * provider-like fragments, so the shared normalizer owns reconstruction and
 * malformed-stream recovery just as it does for local providers.
 */
export function streamProxy<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: ProxyStreamOptions,
): AssistantMessageEventStream {
	const normalizer = new AssistantStreamNormalizer();
	options.reportToolSetSnapshot?.({ kind: "unknown" });

	void (async () => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let started = false;

		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		options.signal?.addEventListener("abort", abortHandler);

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model, context, options: buildProxyRequestOptions(options) }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Preserve the status-based message when the response is not JSON.
				}
				throw new Error(errorMessage);
			}

			if (!response.body) {
				throw new Error("Proxy response did not include a body");
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6).trim();
					if (!data) {
						continue;
					}
					const fragment = processProxyEvent(JSON.parse(data) as ProxyAssistantMessageEvent, model);
					started ||= fragment.type === "start";
					normalizer.push(fragment);
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}
		} catch (error) {
			if (!started) {
				normalizer.push(createStartFragment(model));
			}
			normalizer.push({
				type: "error",
				reason: options.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		} finally {
			options.signal?.removeEventListener("abort", abortHandler);
			normalizer.end();
		}
	})();

	return normalizer.stream;
}

function createStartFragment<TApi extends Api>(model: Model<TApi>): AssistantStreamFragment {
	return {
		type: "start",
		init: { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() },
	};
}

function processProxyEvent<TApi extends Api>(
	proxyEvent: ProxyAssistantMessageEvent,
	model: Model<TApi>,
): AssistantStreamFragment {
	switch (proxyEvent.type) {
		case "start":
			return createStartFragment(model);
		case "text_start":
			return { type: "text_start", contentIndex: proxyEvent.contentIndex };
		case "text_delta":
			return { type: "text_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta };
		case "text_end":
			return {
				type: "text_end",
				contentIndex: proxyEvent.contentIndex,
				...(proxyEvent.contentSignature === undefined ? {} : { textSignature: proxyEvent.contentSignature }),
			};
		case "thinking_start":
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta };
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex: proxyEvent.contentIndex,
				...(proxyEvent.contentSignature === undefined ? {} : { thinkingSignature: proxyEvent.contentSignature }),
			};
		case "toolcall_start":
			return {
				type: "toolcall_start",
				contentIndex: proxyEvent.contentIndex,
				id: proxyEvent.id,
				name: proxyEvent.toolName,
			};
		case "toolcall_delta":
			return {
				type: "toolcall_delta",
				contentIndex: proxyEvent.contentIndex,
				argsTextDelta: proxyEvent.delta,
			};
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: proxyEvent.contentIndex };
		case "done":
			return { type: "done", reason: proxyEvent.reason, usage: proxyEvent.usage };
		case "error":
			return {
				type: "error",
				reason: proxyEvent.reason,
				errorMessage: proxyEvent.errorMessage ?? "Proxy stream failed",
				usage: proxyEvent.usage,
			};
		default: {
			const exhaustive: never = proxyEvent;
			return exhaustive;
		}
	}
}
