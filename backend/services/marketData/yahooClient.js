import YahooFinance from "yahoo-finance2";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";
import { normalizeSearchQuery, normalizeYahooSymbol } from "./normalizer.js";
import { YahooRequestQueue } from "./rateLimit.js";

const DEFAULT_YAHOO_LOGGER = Object.freeze({
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  dir: (...args) => console.dir(...args),
  debug: () => {},
});

function sanitizeLogValue(value) {
  if (!(value instanceof Error)) return sanitizeSensitiveData(value);
  return sanitizeSensitiveData({
    name: value.name,
    message: value.message,
    code: value.code,
    status: value.status ?? value.statusCode,
    stack: value.stack,
  });
}

export function createSanitizedYahooLogger(logger = DEFAULT_YAHOO_LOGGER) {
  const call = (level, args) => {
    const target = typeof logger?.[level] === "function" ? logger[level] : DEFAULT_YAHOO_LOGGER[level];
    target.call(logger, ...args.map(sanitizeLogValue));
  };
  return {
    info: (...args) => call("info", args),
    warn: (...args) => call("warn", args),
    error: (...args) => call("error", args),
    debug: (...args) => call("debug", args),
    dir: (...args) => call("dir", args),
  };
}

export function createGuardedYahooFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("Yahoo fetch implementation is required");
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const status = Number(response?.status);
    if (Number.isInteger(status) && status >= 400) {
      const error = new Error(`Yahoo request failed with HTTP ${status}`);
      error.name = "YahooHttpError";
      error.code = status;
      error.status = status;
      if (status === 429) {
        const retryAfter = String(response?.headers?.get?.("retry-after") || "").trim();
        const seconds = Number(retryAfter);
        const dateMs = Date.parse(retryAfter);
        if (retryAfter && Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = Math.ceil(seconds * 1_000);
        else if (Number.isFinite(dateMs)) error.retryAfterMs = Math.max(1, dateMs - Date.now());
      }
      throw error;
    }
    return response;
  };
}

function requestModuleOptions(signal, moduleOptions = {}) {
  return {
    ...moduleOptions,
    fetchOptions: {
      ...(moduleOptions.fetchOptions || {}),
      signal,
    },
  };
}

function stableOptions(options = {}) {
  return JSON.stringify(options, (_key, value) => value instanceof Date ? value.toISOString() : value);
}

export function createYahooFinanceClient(options = {}) {
  if (typeof window !== "undefined") throw new Error("yahoo-finance2 must only be initialized on the server");
  const { fetch: fetchImpl = globalThis.fetch, logger: loggerImpl = DEFAULT_YAHOO_LOGGER, ...clientOptions } = options;
  if (typeof fetchImpl !== "function") throw new Error("Yahoo fetch implementation is unavailable");
  const logger = createSanitizedYahooLogger(loggerImpl);
  const client = new YahooFinance({
    ...clientOptions,
    logger,
    fetch: createGuardedYahooFetch(fetchImpl),
    queue: { ...(options.queue || {}), concurrency: 3 },
    suppressNotices: [...new Set(["yahooSurvey", ...(clientOptions.suppressNotices || [])])],
  });
  return client;
}

export class YahooClient {
  constructor({ client = null, clientOptions = {}, requestQueue = null, timeoutMs = 10_000, retries = 2 } = {}) {
    this.client = client || createYahooFinanceClient(clientOptions);
    this.requestQueue = requestQueue || new YahooRequestQueue({ concurrency: 3, timeoutMs, retries });
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  chart(symbol, options = {}, moduleOptions = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol);
    const queryOptions = { ...options, return: "array" };
    const key = `chart:${normalizedSymbol}:${stableOptions(queryOptions)}`;
    return this.requestQueue.run(key, ({ signal }) => this.client.chart(
      normalizedSymbol,
      queryOptions,
      requestModuleOptions(signal, moduleOptions),
    ), { timeoutMs: this.timeoutMs, retries: this.retries, scope: "chart" });
  }

  quote(symbols, options = {}, moduleOptions = {}) {
    const values = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(normalizeYahooSymbol))];
    if (values.length === 0) return Promise.resolve({});
    const queryOptions = { ...options, return: "object" };
    const key = `quote:${[...values].sort().join(",")}:${stableOptions(queryOptions)}`;
    return this.requestQueue.run(key, ({ signal }) => this.client.quote(
      values,
      queryOptions,
      requestModuleOptions(signal, moduleOptions),
    ), { timeoutMs: this.timeoutMs, retries: this.retries, scope: "quote" });
  }

  search(query, options = {}, moduleOptions = {}) {
    const normalizedQuery = normalizeSearchQuery(query);
    const queryOptions = { newsCount: 0, quotesCount: 10, ...options };
    const key = `search:${normalizedQuery.toLowerCase()}:${stableOptions(queryOptions)}`;
    return this.requestQueue.run(key, ({ signal }) => this.client.search(
      normalizedQuery,
      queryOptions,
      requestModuleOptions(signal, moduleOptions),
    ), { timeoutMs: this.timeoutMs, retries: this.retries, scope: "search" });
  }

  snapshot() {
    return {
      provider: "yahoo-finance2",
      transport: "server-library",
      queue: this.requestQueue.snapshot(),
    };
  }
}
