import test from "node:test";
import assert from "node:assert/strict";
import { AiBudgetError, AiBudgetService } from "../services/ai/aiBudgetService.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";

test("unlimited budgets retain accounting and independently honor the remaining finite limit", () => {
  const unlimited = new AiBudgetService({ dailyRequestBudget: 0, dailyTokenBudget: 0 });
  const lease = unlimited.reserveAttempt({ estimatedTokens: 200000 });
  assert.equal(unlimited.snapshot().tokensReserved, 200000);
  unlimited.settleAttempt(lease.leaseId, { actualTokens: 150000 });
  assert.equal(unlimited.snapshot().tokensUsed, 150000);
  assert.equal(unlimited.snapshot().requestsUsed, 1);
  assert.equal(unlimited.snapshot().requestsRemaining, null);
  assert.equal(unlimited.snapshot().tokensRemaining, null);
  assert.equal(unlimited.snapshot().requestsUnlimited, true);
  assert.equal(unlimited.snapshot().exhausted, false);
  const finite = new AiBudgetService({ dailyRequestBudget: 1, dailyTokenBudget: 0 });
  finite.reserveAttempt({ estimatedTokens: 200000 });
  assert.throws(() => finite.reserveAttempt(), { code: "AI_REQUEST_BUDGET_EXHAUSTED" });
  const finiteTokens = new AiBudgetService({ dailyRequestBudget: 0, dailyTokenBudget: 5 });
  assert.throws(() => finiteTokens.reserveAttempt({ estimatedTokens: 6 }), { code: "AI_TOKEN_BUDGET_EXHAUSTED" });
});

test("AI request and token budgets reserve and reconcile independently", () => {
  const budget = new AiBudgetService({ dailyRequestBudget: 2, dailyTokenBudget: 100, now: () => Date.parse("2026-07-19T12:00:00Z") });
  const first = budget.reserveAttempt({ estimatedTokens: 60 });
  assert.equal(budget.snapshot().tokensReserved, 60);
  budget.settleAttempt(first.leaseId, { actualTokens: 40 });
  assert.equal(budget.snapshot().tokensUsed, 40);
  const second = budget.reserveAttempt({ estimatedTokens: 50 });
  budget.settleAttempt(second.leaseId, { actualTokens: 50 });
  assert.throws(() => budget.reserveAttempt({ estimatedTokens: 1 }), (error) => error instanceof AiBudgetError && error.code === "AI_REQUEST_BUDGET_EXHAUSTED");
});

test("AI token reservations fail closed before an upstream attempt", () => {
  const budget = new AiBudgetService({ dailyRequestBudget: 10, dailyTokenBudget: 20 });
  assert.throws(() => budget.reserveAttempt({ estimatedTokens: 21 }), (error) => error.code === "AI_TOKEN_BUDGET_EXHAUSTED");
  assert.equal(budget.snapshot().requestsUsed, 0);
});

test("enrichment store exposes accepted cache entries and recovers interrupted jobs", () => {
  const store = new AiEnrichmentStore();
  const base = {
    enrichmentId: "aie_test",
    kind: "article_summary",
    subjectId: "ca_test",
    cacheKey: "cache",
    provider: "mock",
    model: "mock",
    promptVersion: "p1",
    schemaVersion: "s1",
    createdAt: "2026-07-19T10:00:00Z",
    updatedAt: "2026-07-19T10:00:00Z",
    generatedAt: null,
    output: null,
    validation: { schemaValid: false, groundingValid: false, codes: [] }
  };
  store.upsert({ ...base, status: "pending" });
  store.recoverInterrupted();
  assert.equal(store.get("aie_test").status, "failed");
  store.upsert({ ...base, status: "ready", output: { summary: "Accepted" } });
  assert.equal(store.findAcceptedByCacheKey("cache").output.summary, "Accepted");
});
