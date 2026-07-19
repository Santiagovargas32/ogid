import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class AiBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AiBudgetError";
    this.code = code;
  }
}

function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function nextUtcReset(nowMs) {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export class AiBudgetService {
  constructor({ dailyRequestBudget = 50, dailyTokenBudget = 100_000, persistencePath = null, now = Date.now } = {}) {
    this.dailyRequestBudget = Math.max(1, Number(dailyRequestBudget) || 50);
    this.dailyTokenBudget = Math.max(1, Number(dailyTokenBudget) || 100_000);
    this.persistencePath = persistencePath;
    this.now = now;
    this.state = { day: utcDay(this.now()), requestsUsed: 0, tokensUsed: 0, reservations: {} };
    this.hydrate();
    this.rollover();
    this.reconcileInterruptedReservations();
  }

  rollover() {
    const day = utcDay(this.now());
    if (this.state.day === day) return false;
    this.state = { day, requestsUsed: 0, tokensUsed: 0, reservations: {} };
    this.persist();
    return true;
  }

  reservedTokens() {
    return Object.values(this.state.reservations || {}).reduce((total, item) => total + Number(item.estimatedTokens || 0), 0);
  }

  reserveAttempt({ estimatedTokens = 1 } = {}) {
    this.rollover();
    const estimate = Math.max(1, Math.ceil(Number(estimatedTokens) || 1));
    if (this.state.requestsUsed + 1 > this.dailyRequestBudget) {
      throw new AiBudgetError("AI_REQUEST_BUDGET_EXHAUSTED", "AI daily request budget exhausted.");
    }
    if (this.state.tokensUsed + this.reservedTokens() + estimate > this.dailyTokenBudget) {
      throw new AiBudgetError("AI_TOKEN_BUDGET_EXHAUSTED", "AI daily token budget exhausted.");
    }
    const lease = { leaseId: randomUUID(), estimatedTokens: estimate, reservedAt: new Date(this.now()).toISOString() };
    this.state.requestsUsed += 1;
    this.state.reservations[lease.leaseId] = lease;
    this.persist();
    return structuredClone(lease);
  }

  settleAttempt(leaseId, { actualTokens = null, conservative = false } = {}) {
    this.rollover();
    const lease = this.state.reservations?.[leaseId];
    if (!lease) return this.snapshot();
    delete this.state.reservations[leaseId];
    const resolved = Number.isFinite(Number(actualTokens)) && Number(actualTokens) >= 0
      ? Number(actualTokens)
      : conservative ? Number(lease.estimatedTokens || 0) : 0;
    this.state.tokensUsed += Math.max(0, Math.ceil(resolved));
    this.persist();
    return this.snapshot();
  }

  reconcileInterruptedReservations() {
    const reservations = Object.values(this.state.reservations || {});
    if (!reservations.length) return;
    this.state.tokensUsed += reservations.reduce((total, item) => total + Number(item.estimatedTokens || 0), 0);
    this.state.reservations = {};
    this.persist();
  }

  snapshot() {
    this.rollover();
    const tokensReserved = this.reservedTokens();
    return {
      day: this.state.day,
      requestsUsed: this.state.requestsUsed,
      requestBudget: this.dailyRequestBudget,
      requestsRemaining: Math.max(0, this.dailyRequestBudget - this.state.requestsUsed),
      tokensUsed: this.state.tokensUsed,
      tokensReserved,
      tokenBudget: this.dailyTokenBudget,
      tokensRemaining: Math.max(0, this.dailyTokenBudget - this.state.tokensUsed - tokensReserved),
      activeReservations: Object.keys(this.state.reservations || {}).length,
      exhausted: this.state.requestsUsed >= this.dailyRequestBudget || this.state.tokensUsed + tokensReserved >= this.dailyTokenBudget,
      nextResetAt: nextUtcReset(this.now())
    };
  }

  persist() {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, state: this.state }), { mode: 0o600 });
    renameSync(temporary, this.persistencePath);
  }

  hydrate() {
    if (!this.persistencePath) return false;
    try {
      const payload = JSON.parse(readFileSync(this.persistencePath, "utf8"));
      if (payload?.version !== 1 || !payload.state) return false;
      this.state = {
        day: payload.state.day || utcDay(this.now()),
        requestsUsed: Math.max(0, Number(payload.state.requestsUsed || 0)),
        tokensUsed: Math.max(0, Number(payload.state.tokensUsed || 0)),
        reservations: payload.state.reservations && typeof payload.state.reservations === "object" ? payload.state.reservations : {}
      };
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}
