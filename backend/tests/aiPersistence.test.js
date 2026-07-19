import test from "node:test";
import assert from "node:assert/strict";
import { AiBudgetError, AiBudgetService } from "../services/ai/aiBudgetService.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";

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
