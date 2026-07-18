export const ProviderErrorCode = Object.freeze({
  TIMEOUT: "timeout", ABORTED: "aborted", RATE_LIMITED: "rate_limited",
  UPSTREAM_5XX: "upstream_5xx", UPSTREAM_4XX: "upstream_4xx",
  QUOTA_EXHAUSTED: "quota_exhausted", CIRCUIT_OPEN: "circuit_open", NETWORK: "network"
});

export class ProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = code === ProviderErrorCode.TIMEOUT ? "AbortError" : "ProviderError";
    this.code = code;
    this.provider = options.provider || null;
    this.status = options.status || null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function errorFromResponse(provider, response, nowMs = Date.now()) {
  const status = response?.status || 0;
  const retryAfterMs = parseRetryAfter(response?.headers?.get?.("retry-after"), nowMs);
  if (status === 429) return new ProviderError(ProviderErrorCode.RATE_LIMITED, `${provider}-rate-limited`, { provider, status, retryAfterMs, retryable: true });
  if (status >= 500) return new ProviderError(ProviderErrorCode.UPSTREAM_5XX, `${provider}-upstream-${status}`, { provider, status, retryAfterMs, retryable: true });
  return new ProviderError(ProviderErrorCode.UPSTREAM_4XX, `${provider}-upstream-${status}`, { provider, status, retryAfterMs, retryable: false });
}
