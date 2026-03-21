import { buildResponsePreview, sanitizeRequestUrl, sanitizeRequestUrls } from "../providerDiagnostics.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export function ensureTrailingSlash(baseUrl = "") {
  return String(baseUrl || "").endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

export function normalizeRequestedTickers(tickers = []) {
  return [
    ...new Set(
      (Array.isArray(tickers) ? tickers : [])
        .map((ticker) => String(ticker || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ];
}

export function parsePrice(value) {
  if (value && typeof value === "object" && "raw" in value) {
    return parsePrice(value.raw);
  }

  const parsed = Number.parseFloat(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export function parsePercent(value) {
  if (value && typeof value === "object" && "raw" in value) {
    return parsePercent(value.raw);
  }

  const parsed = Number.parseFloat(
    String(value ?? "")
      .replaceAll("%", "")
      .replaceAll("(", "")
      .replaceAll(")", "")
      .replaceAll("+", "")
      .replaceAll(",", "")
      .trim()
  );
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export function parseInteger(value) {
  if (value && typeof value === "object" && "raw" in value) {
    return parseInteger(value.raw);
  }

  const parsed = Number.parseInt(String(value ?? "").replaceAll(",", "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIsoTimestamp(value, fallbackTimestamp) {
  if (value === undefined || value === null || value === "") {
    return fallbackTimestamp;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const numeric = value > 1e12 ? value : value * 1000;
    return new Date(numeric).toISOString();
  }

  if (value && typeof value === "object" && "raw" in value) {
    return toIsoTimestamp(value.raw, fallbackTimestamp);
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallbackTimestamp;
}

export function computeChangePct(price, previousClose, fallbackChangePct = null) {
  if (Number.isFinite(fallbackChangePct)) {
    return Number(fallbackChangePct.toFixed(2));
  }

  if (Number.isFinite(previousClose) && previousClose > 0 && Number.isFinite(price)) {
    return Number((((price - previousClose) / previousClose) * 100).toFixed(2));
  }

  return 0;
}

export function computeProviderScore({
  returnedCount = 0,
  totalTickers = 0,
  durationMs = 0,
  errorCount = 0,
  marketOpen = true,
  transport = "api"
} = {}) {
  const coverage = totalTickers > 0 ? returnedCount / totalTickers : 0;
  const transportBonus = transport === "api" ? 12 : 8;
  const marketBonus = marketOpen ? 5 : 0;
  const latencyPenalty = Number.isFinite(durationMs) ? Math.min(28, durationMs / 180) : 10;
  const errorPenalty = errorCount * 7;
  return Math.max(0, Math.round(coverage * 65 + transportBonus + marketBonus - latencyPenalty - errorPenalty));
}

export function buildProviderError({
  provider,
  scope,
  code,
  message,
  tickers = [],
  ticker = null,
  status = null,
  requestUrl = null,
  responsePreview = null
}) {
  return {
    provider: String(provider || "unknown"),
    scope: scope || "provider",
    code: code || "provider-error",
    reason: code || "provider-error",
    message: message || "Provider request failed.",
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    tickers: Array.isArray(tickers) && tickers.length ? tickers : undefined,
    ticker: ticker || undefined,
    requestUrl: requestUrl ? sanitizeRequestUrl(requestUrl) : null,
    responsePreview: buildResponsePreview(responsePreview)
  };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function summarizeAttempt({
  provider,
  transport,
  configuredBaseUrl,
  requestMode,
  durationMs,
  requestUrls = [],
  requestedTickers = [],
  returnedTickers = [],
  missingTickers = [],
  httpStatus = null,
  lastAttemptAt = null,
  lastSuccessAt = null,
  quotaSnapshot = null,
  score = 0,
  errors = [],
  responsePreview = null,
  quotes = {},
  historicalSeries = {},
  extras = {}
} = {}) {
  return {
    provider: String(provider || "unknown"),
    transport: transport || null,
    configuredBaseUrl: configuredBaseUrl || null,
    requestMode: requestMode || null,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0,
    requestUrls: sanitizeRequestUrls(requestUrls),
    requestedTickers: normalizeRequestedTickers(requestedTickers),
    returnedTickers: normalizeRequestedTickers(returnedTickers),
    missingTickers: normalizeRequestedTickers(missingTickers),
    httpStatus: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    lastAttemptAt: lastAttemptAt || null,
    lastSuccessAt: lastSuccessAt || null,
    quotaSnapshot: quotaSnapshot || null,
    score: Number.isFinite(Number(score)) ? Number(score) : 0,
    errors: (Array.isArray(errors) ? errors : []).map((error) => ({
      ...error,
      requestUrl: error?.requestUrl ? sanitizeRequestUrl(error.requestUrl) : null,
      responsePreview: buildResponsePreview(error?.responsePreview)
    })),
    responsePreview: buildResponsePreview(responsePreview),
    quotes: quotes && typeof quotes === "object" ? quotes : {},
    historicalSeries: historicalSeries && typeof historicalSeries === "object" ? historicalSeries : {},
    ...extras
  };
}
