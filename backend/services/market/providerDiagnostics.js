function normalizeUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    for (const key of ["apikey", "apiKey", "token", "key"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return String(value || "");
  }
}

export function sanitizeRequestUrl(value = "") {
  return normalizeUrl(value);
}

export function sanitizeRequestUrls(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => sanitizeRequestUrl(value)).filter(Boolean))];
}

export function buildResponsePreview(payload, maxLength = 240) {
  if (payload === undefined || payload === null) {
    return null;
  }

  const text =
    typeof payload === "string"
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload);
          } catch {
            return String(payload);
          }
        })();

  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildProviderDiagnosticRecord({
  provider,
  configuredProvider = null,
  configuredFallbackProvider = null,
  effectiveProvider = null,
  configuredSource = null,
  requestMode = null,
  lastAttemptAt = null,
  lastSuccessAt = null,
  durationMs = null,
  requestUrl = null,
  requestUrls = [],
  requestedTickers = [],
  returnedTickers = [],
  missingTickers = [],
  httpStatus = null,
  responsePreview = null,
  errorCode = null,
  errorMessage = null,
  providerDisabledReason = null,
  nextAllowedAt = null,
  rateLimit = null,
  extras = {}
} = {}) {
  return {
    provider: String(provider || "unknown"),
    configuredProvider,
    configuredFallbackProvider,
    effectiveProvider,
    configuredSource,
    requestMode,
    lastAttemptAt,
    lastSuccessAt,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    requestUrl: requestUrl ? sanitizeRequestUrl(requestUrl) : null,
    requestUrls: sanitizeRequestUrls(requestUrls),
    requestedTickers: (Array.isArray(requestedTickers) ? requestedTickers : []).map((ticker) => String(ticker || "").toUpperCase()),
    returnedTickers: (Array.isArray(returnedTickers) ? returnedTickers : []).map((ticker) => String(ticker || "").toUpperCase()),
    missingTickers: (Array.isArray(missingTickers) ? missingTickers : []).map((ticker) => String(ticker || "").toUpperCase()),
    httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    responsePreview: buildResponsePreview(responsePreview),
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    providerDisabledReason: providerDisabledReason || null,
    nextAllowedAt: nextAllowedAt || null,
    rateLimit: rateLimit || null,
    ...extras
  };
}
