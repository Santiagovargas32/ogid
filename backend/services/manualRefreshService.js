import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backend/services/manualRefreshService");

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asIso(valueMs) {
  return new Date(valueMs).toISOString();
}

class ManualRefreshService {
  constructor({
    orchestrator,
    cooldownMs = 120_000,
    perClientWindowMs = 900_000,
    perClientMax = 3
  } = {}) {
    this.orchestrator = orchestrator;
    this.cooldownMs = toPositiveInt(cooldownMs, 120_000);
    this.perClientWindowMs = toPositiveInt(perClientWindowMs, 900_000);
    this.perClientMax = toPositiveInt(perClientMax, 3);
    this.lastAcceptedAtMs = 0;
    this.inFlight = false;
    this.clientEvents = new Map();
  }

  purgeClientEvents(clientId, nowMs) {
    const history = this.clientEvents.get(clientId) || [];
    const minTs = nowMs - this.perClientWindowMs;
    const trimmed = history.filter((value) => value >= minTs);
    this.clientEvents.set(clientId, trimmed);
    return trimmed;
  }

  resolveGlobalRetryAfterMs(nowMs) {
    const elapsed = nowMs - this.lastAcceptedAtMs;
    if (elapsed >= this.cooldownMs) {
      return 0;
    }
    return this.cooldownMs - elapsed;
  }

  request({ clientId = "anonymous", countries = [], reason = "manual" } = {}) {
    if (!this.orchestrator) {
      return {
        accepted: false,
        status: "unavailable",
        httpStatus: 503,
        code: "REFRESH_UNAVAILABLE",
        message: "Manual refresh is unavailable.",
        retryAfterMs: 0
      };
    }

    const nowMs = Date.now();
    if (this.inFlight) {
      const retryAfterMs = Math.max(1_000, this.resolveGlobalRetryAfterMs(nowMs));
      return {
        accepted: false,
        status: "in-progress",
        httpStatus: 409,
        code: "REFRESH_IN_PROGRESS",
        message: "A manual refresh is already in progress.",
        retryAfterMs,
        nextAllowedAt: asIso(nowMs + retryAfterMs)
      };
    }

    const globalRetryAfterMs = this.resolveGlobalRetryAfterMs(nowMs);
    if (globalRetryAfterMs > 0) {
      return {
        accepted: false,
        status: "cooldown",
        httpStatus: 429,
        code: "REFRESH_COOLDOWN",
        message: "Manual refresh is cooling down.",
        retryAfterMs: globalRetryAfterMs,
        nextAllowedAt: asIso(nowMs + globalRetryAfterMs)
      };
    }

    const history = this.purgeClientEvents(clientId, nowMs);
    if (history.length >= this.perClientMax) {
      const oldest = history[0];
      const retryAfterMs = Math.max(1_000, oldest + this.perClientWindowMs - nowMs);
      return {
        accepted: false,
        status: "client-rate-limited",
        httpStatus: 429,
        code: "REFRESH_CLIENT_RATE_LIMIT",
        message: "Manual refresh limit reached for this client.",
        retryAfterMs,
        nextAllowedAt: asIso(nowMs + retryAfterMs)
      };
    }

    const refreshId = randomUUID();
    this.lastAcceptedAtMs = nowMs;
    this.inFlight = true;
    history.push(nowMs);
    this.clientEvents.set(clientId, history);

    void this.orchestrator
      .runManualRefresh({
        refreshId,
        trigger: reason || "manual",
        countries
      })
      .catch((error) => {
        log.error("manual_refresh_failed", {
          refreshId,
          message: error.message
        });
      })
      .finally(() => {
        this.inFlight = false;
      });

    return {
      accepted: true,
      status: "accepted",
      httpStatus: 202,
      refreshId,
      requestedAt: asIso(nowMs),
      retryAfterMs: this.cooldownMs,
      nextAllowedAt: asIso(nowMs + this.cooldownMs)
    };
  }
}

export default ManualRefreshService;

