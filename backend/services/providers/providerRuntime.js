import { ProviderError, ProviderErrorCode, errorFromResponse } from "./providerErrors.js";
import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";

class Semaphore {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise((resolve) => this.waiters.push(resolve)); this.active += 1;
  }
  release() { this.active -= 1; this.waiters.shift()?.(); }
}

export class ProviderRuntime {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
    this.globalSemaphore = new Semaphore(options.globalConcurrency || 12);
    this.providerConcurrency = options.providerConcurrency || 4;
    this.hostConcurrency = options.hostConcurrency || 6;
    this.providerSemaphores = new Map(); this.hostSemaphores = new Map(); this.inFlight = new Map();
    this.circuits = new Map(); this.metrics = new Map();
    this.failureThreshold = options.failureThreshold || 5; this.recoveryMs = options.recoveryMs || 30_000;
  }
  semaphore(map, key, limit) { if (!map.has(key)) map.set(key, new Semaphore(limit)); return map.get(key); }
  metric(provider) {
    if (!this.metrics.has(provider)) this.metrics.set(provider, { calls: 0, attempts: 0, retries: 0, deduplicated: 0, cacheHits: 0, quotaRejected: 0, success: 0, errors: 0, latencyMs: 0, results: {} });
    return this.metrics.get(provider);
  }
  getMetrics(provider) { return structuredClone(this.metric(provider)); }
  recordCache(provider, hit = true) { if (hit) this.metric(provider).cacheHits += 1; }
  reset() { this.providerSemaphores.clear(); this.hostSemaphores.clear(); this.inFlight.clear(); this.circuits.clear(); this.metrics.clear(); }
  circuit(provider) { if (!this.circuits.has(provider)) this.circuits.set(provider, { state: "closed", failures: 0, openedAt: null }); return this.circuits.get(provider); }
  assertCircuit(provider) {
    const circuit = this.circuit(provider);
    if (circuit.state === "open" && this.now() - circuit.openedAt < this.recoveryMs) throw new ProviderError(ProviderErrorCode.CIRCUIT_OPEN, `${provider}-circuit-open`, { provider });
    if (circuit.state === "open") circuit.state = "half-open";
  }
  async fetch(provider, url, options = {}) {
    const idempotent = options.idempotent ?? ["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
    const key = options.dedupeKey || (idempotent ? `${provider}:${String(options.method || "GET")}:${url}` : null);
    if (key && this.inFlight.has(key)) { this.metric(provider).deduplicated += 1; return this.inFlight.get(key); }
    const promise = this.#execute(provider, url, { ...options, idempotent });
    if (key) this.inFlight.set(key, promise);
    try { return await promise; } finally { if (key) this.inFlight.delete(key); }
  }
  async #execute(provider, url, options) {
    this.assertCircuit(provider); const metric = this.metric(provider); metric.calls += 1; const started = this.now();
    const quotaSnapshot = (options.quotaTracker || apiQuotaTracker).getProviderSnapshot(provider, this.now());
    if (quotaSnapshot.exhausted) { metric.quotaRejected += 1; throw new ProviderError(ProviderErrorCode.QUOTA_EXHAUSTED, `${provider}-quota-exhausted`, { provider }); }
    const host = new URL(url).host; const providerSem = this.semaphore(this.providerSemaphores, provider, options.providerConcurrency || this.providerConcurrency);
    const hostSem = this.semaphore(this.hostSemaphores, host, options.hostConcurrency || this.hostConcurrency);
    await this.globalSemaphore.acquire(); await providerSem.acquire(); await hostSem.acquire();
    try {
      const retries = options.idempotent ? (options.retries ?? 2) : 0;
      for (let attempt = 0; ; attempt += 1) {
        metric.attempts += 1; const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 9_000);
        try {
          const response = await this.fetchImpl(url, { ...options, signal: controller.signal, retries: undefined, timeoutMs: undefined, dedupeKey: undefined, providerConcurrency: undefined, hostConcurrency: undefined, idempotent: undefined, throwHttpErrors: undefined, quotaTracker: undefined });
          if (response.status === 429 || response.status >= 500) {
            const httpError = errorFromResponse(provider, response, this.now());
            if (attempt < retries) throw httpError;
            const circuit = this.circuit(provider); circuit.failures += 1;
            if (circuit.failures >= this.failureThreshold) { circuit.state = "open"; circuit.openedAt = this.now(); }
            metric.errors += 1; metric.results[response.status] = (metric.results[response.status] || 0) + 1;
            if (options.throwHttpErrors) throw httpError;
            return response;
          }
          this.circuits.set(provider, { state: "closed", failures: 0, openedAt: null }); metric.success += 1; metric.results[response.status] = (metric.results[response.status] || 0) + 1; return response;
        } catch (error) {
          let normalized = error;
          if (!(error instanceof ProviderError)) normalized = new ProviderError(error?.name === "AbortError" ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK, `${provider}-${error?.name === "AbortError" ? "timeout" : "network-error"}`, { provider, cause: error, retryable: true });
          if (attempt < retries && normalized.retryable) { metric.retries += 1; const base = normalized.retryAfterMs ?? Math.min(5_000, 250 * (2 ** attempt)); await this.sleep(Math.ceil(base * (0.8 + this.random() * 0.4))); continue; }
          const circuit = this.circuit(provider); circuit.failures += 1; if (normalized.retryable && circuit.failures >= this.failureThreshold) { circuit.state = "open"; circuit.openedAt = this.now(); }
          metric.errors += 1; metric.results[normalized.code] = (metric.results[normalized.code] || 0) + 1; throw normalized;
        } finally { clearTimeout(timeout); }
      }
    } finally { metric.latencyMs += Math.max(0, this.now() - started); hostSem.release(); providerSem.release(); this.globalSemaphore.release(); }
  }
}

export const providerRuntime = new ProviderRuntime();
