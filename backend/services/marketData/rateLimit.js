import { sanitizeSensitiveData } from "../../utils/sanitize.js";

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function positiveInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function errorStatus(error) {
  for (const value of [error?.status, error?.statusCode, error?.response?.status, error?.code]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

export function isYahooRateLimitError(error) {
  return errorStatus(error) === 429 || error?.code === "YAHOO_RATE_LIMITED";
}

export function yahooRetryAfterMs(error, fallback = 0) {
  for (const value of [error?.retryAfterMs, error?.details?.retryAfterMs]) {
    const milliseconds = Number(value);
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds);
  }
  return Math.max(0, Number(fallback) || 0);
}

function nowMilliseconds(value) {
  const candidate = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(candidate) ? candidate : Date.now();
}

function normalizeScope(value) {
  const scope = String(value || "global").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(scope) ? scope : "global";
}

function publicQueueError(error) {
  const status = errorStatus(error);
  return {
    name: String(error?.name || "Error").slice(0, 64),
    code: String(error?.code || status || "YAHOO_REQUEST_FAILED").slice(0, 64),
    status,
    message: sanitizeSensitiveData(String(error?.message || "Yahoo request failed")),
    retryAfterMs: yahooRetryAfterMs(error) || null,
  };
}

export class SlidingWindowRateLimiter {
  constructor({ maxRequests = 30, windowMs = 60_000, maxKeys = 1_000, now = Date.now } = {}) {
    this.maxRequests = positiveInteger(maxRequests, 30, { min: 1, max: 10_000 });
    this.windowMs = positiveInteger(windowMs, 60_000, { min: 1 });
    this.maxKeys = positiveInteger(maxKeys, 1_000, { min: 1, max: 100_000 });
    this.now = now;
    this.windows = new Map();
  }

  consume(key = "global") {
    const normalizedKey = String(key || "global");
    const nowMs = nowMilliseconds(this.now());
    const cutoff = nowMs - this.windowMs;
    const timestamps = (this.windows.get(normalizedKey) || []).filter((timestamp) => timestamp > cutoff);
    this.windows.delete(normalizedKey);
    this.windows.set(normalizedKey, timestamps);
    while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value);
    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, timestamps[0] + this.windowMs - nowMs) };
    }
    timestamps.push(nowMs);
    return { allowed: true, remaining: Math.max(0, this.maxRequests - timestamps.length), retryAfterMs: 0 };
  }
}

export function isRetryableYahooError(error) {
  const status = errorStatus(error);
  if (status === 429 || (status != null && status >= 500)) return true;
  if (error?.code === "YAHOO_TIMEOUT" || error?.name === "AbortError") return true;
  const code = String(error?.code || "").toUpperCase();
  if (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR_")) return true;
  return /\b(fetch failed|network|socket hang up|timed? ?out)\b/i.test(String(error?.message || ""));
}

export class YahooTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Yahoo request timed out after ${timeoutMs}ms`);
    this.name = "YahooTimeoutError";
    this.code = "YAHOO_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class YahooRateLimitError extends Error {
  constructor(retryAfterMs) {
    super("Yahoo Finance is temporarily rate limited");
    this.name = "YahooRateLimitError";
    this.code = "YAHOO_RATE_LIMITED";
    this.status = 429;
    this.retryAfterMs = Math.max(1, Math.ceil(Number(retryAfterMs) || 1));
  }
}

export class YahooRequestQueue {
  constructor({
    concurrency = 3,
    timeoutMs = 10_000,
    retries = 2,
    baseDelayMs = 250,
    maxDelayMs = 5_000,
    rateLimitCooldownMs = 60_000,
    maxRateLimitCooldownMs = 15 * 60_000,
    now = Date.now,
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.concurrency = positiveInteger(concurrency, 3, { min: 1, max: 16 });
    this.timeoutMs = positiveInteger(timeoutMs, 10_000, { min: 1 });
    this.retries = positiveInteger(retries, 2, { min: 0, max: 8 });
    this.baseDelayMs = positiveInteger(baseDelayMs, 250, { min: 1 });
    this.maxDelayMs = positiveInteger(maxDelayMs, 5_000, { min: this.baseDelayMs });
    this.rateLimitCooldownMs = positiveInteger(rateLimitCooldownMs, 60_000, { min: 1 });
    this.maxRateLimitCooldownMs = positiveInteger(maxRateLimitCooldownMs, 15 * 60_000, { min: this.rateLimitCooldownMs });
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.active = 0;
    this.pending = [];
    this.inFlight = new Map();
    this.cooldowns = new Map();
    this.operations = new Map();
    this.recentErrors = [];
    this.metrics = { started: 0, completed: 0, failed: 0, retries: 0, deduplicated: 0, rateLimited: 0 };
  }

  run(key, operation, { timeoutMs = this.timeoutMs, retries = this.retries, scope = "global" } = {}) {
    if (typeof operation !== "function") throw new TypeError("Yahoo request operation must be a function");
    const requestKey = String(key || "").trim();
    if (!requestKey) throw new TypeError("Yahoo request key is required");
    const requestScope = normalizeScope(scope);
    const operationMetrics = this.#operationMetrics(requestScope);
    operationMetrics.requested += 1;
    const existing = this.inFlight.get(requestKey);
    if (existing) {
      this.metrics.deduplicated += 1;
      operationMetrics.deduplicated += 1;
      return existing;
    }
    const cooldownRemainingMs = this.#cooldownRemainingMs(requestScope);
    if (cooldownRemainingMs > 0) {
      const error = new YahooRateLimitError(cooldownRemainingMs);
      operationMetrics.blockedByCooldown += 1;
      this.#recordOperationFailure(requestScope, error, 0, true);
      return Promise.reject(error);
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    this.inFlight.set(requestKey, promise);
    this.pending.push({
      key: requestKey,
      operation,
      scope: requestScope,
      timeoutMs: positiveInteger(timeoutMs, this.timeoutMs, { min: 1 }),
      retries: positiveInteger(retries, this.retries, { min: 0, max: 8 }),
      resolve: resolveTask,
      reject: rejectTask,
    });
    this.#drain();
    return promise;
  }

  snapshot() {
    const cooldowns = Object.fromEntries(
      [...new Set([...this.operations.keys(), ...this.cooldowns.keys()])]
        .sort()
        .map((scope) => [scope, this.#cooldownRemainingMs(scope)])
    );
    return {
      concurrency: this.concurrency,
      active: this.active,
      queued: this.pending.length,
      inFlight: this.inFlight.size,
      cooldownRemainingMs: this.#cooldownRemainingMs(),
      cooldowns,
      operations: Object.fromEntries(
        [...this.operations.entries()].map(([scope, metrics]) => [scope, { ...metrics }])
      ),
      recentErrors: this.recentErrors.map((entry) => ({
        ...entry,
        error: { ...entry.error },
      })),
      ...this.metrics,
    };
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      const cooldownRemainingMs = this.#cooldownRemainingMs(task.scope);
      if (cooldownRemainingMs > 0) {
        this.inFlight.delete(task.key);
        this.metrics.failed += 1;
        const error = new YahooRateLimitError(cooldownRemainingMs);
        this.#operationMetrics(task.scope).blockedByCooldown += 1;
        this.#recordOperationFailure(task.scope, error, 0, true);
        task.reject(error);
        continue;
      }
      this.active += 1;
      this.metrics.started += 1;
      const startedAt = nowMilliseconds(this.now());
      const operationMetrics = this.#operationMetrics(task.scope);
      operationMetrics.started += 1;
      operationMetrics.lastAttemptAt = new Date(startedAt).toISOString();
      this.#executeWithRetry(task)
        .then((value) => {
          this.metrics.completed += 1;
          operationMetrics.completed += 1;
          operationMetrics.lastSuccessAt = new Date(nowMilliseconds(this.now())).toISOString();
          operationMetrics.lastDurationMs = Math.max(0, nowMilliseconds(this.now()) - startedAt);
          operationMetrics.lastError = null;
          task.resolve(value);
        })
        .catch((error) => {
          this.metrics.failed += 1;
          this.#recordOperationFailure(task.scope, error, startedAt);
          task.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          if (this.inFlight.get(task.key)) this.inFlight.delete(task.key);
          this.#drain();
        });
    }
  }

  async #executeWithRetry(task) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#executeAttempt(task.operation, task.timeoutMs, attempt);
      } catch (error) {
        if (isYahooRateLimitError(error)) {
          this.#activateRateLimitCooldown(error, task.scope);
          throw error;
        }
        if (attempt >= task.retries || !isRetryableYahooError(error)) throw error;
        this.metrics.retries += 1;
        this.#operationMetrics(task.scope).retries += 1;
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        const jitter = 0.75 + (Math.max(0, Math.min(1, Number(this.random()) || 0)) * 0.5);
        await this.sleep(Math.max(1, Math.round(exponential * jitter)));
      }
    }
  }

  async #executeAttempt(operation, timeoutMs, attempt) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new YahooTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation({ signal: controller.signal, attempt })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #cooldownRemainingMs(scope = null) {
    const nowMs = nowMilliseconds(this.now());
    if (scope != null) {
      const normalizedScope = normalizeScope(scope);
      const remainingMs = Math.max(0, Number(this.cooldowns.get(normalizedScope) || 0) - nowMs);
      if (remainingMs === 0) this.cooldowns.delete(normalizedScope);
      return remainingMs;
    }
    let maximum = 0;
    for (const key of [...this.cooldowns.keys()]) maximum = Math.max(maximum, this.#cooldownRemainingMs(key));
    return maximum;
  }

  #activateRateLimitCooldown(error, scope = "global") {
    const hintedMs = yahooRetryAfterMs(error);
    const cooldownMs = Math.min(this.maxRateLimitCooldownMs, Math.max(this.rateLimitCooldownMs, hintedMs));
    const normalizedScope = normalizeScope(scope);
    const cooldownUntil = nowMilliseconds(this.now()) + cooldownMs;
    this.cooldowns.set(normalizedScope, Math.max(Number(this.cooldowns.get(normalizedScope) || 0), cooldownUntil));
    this.metrics.rateLimited += 1;
    this.#operationMetrics(normalizedScope).rateLimited += 1;
    error.retryAfterMs = Math.max(yahooRetryAfterMs(error), cooldownMs);
  }

  #operationMetrics(scope) {
    const normalizedScope = normalizeScope(scope);
    if (!this.operations.has(normalizedScope)) {
      this.operations.set(normalizedScope, {
        requested: 0,
        started: 0,
        completed: 0,
        failed: 0,
        retries: 0,
        deduplicated: 0,
        rateLimited: 0,
        blockedByCooldown: 0,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDurationMs: null,
        lastError: null,
      });
    }
    return this.operations.get(normalizedScope);
  }

  #recordOperationFailure(scope, error, startedAt, blockedByCooldown = false) {
    const metrics = this.#operationMetrics(scope);
    const nowMs = nowMilliseconds(this.now());
    const publicError = publicQueueError(error);
    metrics.failed += 1;
    metrics.lastFailureAt = new Date(nowMs).toISOString();
    metrics.lastDurationMs = startedAt ? Math.max(0, nowMs - startedAt) : 0;
    metrics.lastError = publicError;
    this.recentErrors.push({
      at: new Date(nowMs).toISOString(),
      scope: normalizeScope(scope),
      blockedByCooldown: Boolean(blockedByCooldown),
      error: publicError,
    });
    if (this.recentErrors.length > 20) this.recentErrors.splice(0, this.recentErrors.length - 20);
  }
}
