const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

const TRANSIENT_PROVIDER_ERROR_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
const TRANSIENT_PROVIDER_STATUS_PATTERN =
	/\b(?:http(?:\/[\d.]+)?(?:\s+status)?|status(?:\s+code)?|response\s+status|error\s+code)\s*[:=]?\s*(?:429|500|502|503|504)\b/i;

export function isNonRetryableProviderLimitError(errorMessage: string): boolean {
	return NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(errorMessage);
}

export function isTransientProviderError(errorMessage: string): boolean {
	return (
		!isNonRetryableProviderLimitError(errorMessage) &&
		(TRANSIENT_PROVIDER_ERROR_PATTERN.test(errorMessage) || TRANSIENT_PROVIDER_STATUS_PATTERN.test(errorMessage))
	);
}
