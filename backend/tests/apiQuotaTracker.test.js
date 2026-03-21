import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";

test("api quota tracker computes effective remaining using env + headers", () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 5,
    newsapiDailyBudget: 4,
    gnewsDailyLimit: 5,
    mediastackDailyLimit: 5,
    yahooDailyLimit: 5
  });

  apiQuotaTracker.recordCall("newsapi", {
    status: "success",
    headers: {
      "x-ratelimit-limit": "20",
      "x-ratelimit-remaining": "3"
    }
  });

  const snapshot = apiQuotaTracker.getProviderSnapshot("newsapi");
  assert.equal(snapshot.calls24h, 1);
  assert.equal(snapshot.success24h, 1);
  assert.equal(snapshot.configuredLimit, 5);
  assert.equal(snapshot.hardDailyLimit, 5);
  assert.equal(snapshot.budgetDailyLimit, 4);
  assert.equal(snapshot.headerLimit, 20);
  assert.equal(snapshot.headerRemaining, 3);
  assert.equal(snapshot.effectiveRemaining, 3);
  assert.equal(snapshot.hardRemainingDay, 4);
  assert.equal(snapshot.budgetRemainingDay, 3);
  assert.equal(snapshot.operationalStatus, "within-budget");
  assert.equal(snapshot.exhausted, false);
});

test("api quota tracker tracks twelve minute/day quotas and yahoo unit usage", () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 2,
    twelveDailyBudget: 1,
    twelveMinuteLimit: 2,
    twelveMinuteBudget: 1,
    yahooDailyLimit: 4,
    yahooDailyBudget: 3
  });

  apiQuotaTracker.recordCall("twelve", {
    status: "error",
    fallback: true,
    headers: {
      "api-credits-used": "1",
      "api-credits-left": "1"
    },
    units: 1
  });
  apiQuotaTracker.recordCall("yahoo", { status: "success", units: 2 });

  const twelveSnapshot = apiQuotaTracker.getProviderSnapshot("twelve");
  const yahooSnapshot = apiQuotaTracker.getProviderSnapshot("yahoo");
  assert.equal(twelveSnapshot.calls24h, 1);
  assert.equal(twelveSnapshot.callsMinute, 1);
  assert.equal(twelveSnapshot.errors24h, 1);
  assert.equal(twelveSnapshot.fallback24h, 1);
  assert.equal(twelveSnapshot.configuredMinuteLimit, 2);
  assert.equal(twelveSnapshot.hardDailyLimit, 2);
  assert.equal(twelveSnapshot.budgetDailyLimit, 1);
  assert.equal(twelveSnapshot.hardMinuteLimit, 2);
  assert.equal(twelveSnapshot.budgetMinuteLimit, 1);
  assert.equal(twelveSnapshot.apiCreditsLeft, 1);
  assert.equal(twelveSnapshot.effectiveRemainingMinute, 0);
  assert.equal(twelveSnapshot.effectiveRemainingDay, 0);
  assert.equal(twelveSnapshot.effectiveRemaining, 0);
  assert.equal(twelveSnapshot.operationalStatus, "budget-exhausted");
  assert.equal(yahooSnapshot.calls24h, 1);
  assert.equal(yahooSnapshot.success24h, 1);
  assert.equal(yahooSnapshot.units24h, 2);
  assert.equal(yahooSnapshot.hardRemainingDay, 2);
  assert.equal(yahooSnapshot.budgetRemainingDay, 1);
  assert.equal(yahooSnapshot.effectiveRemaining, 1);
});

test("api quota tracker purges events older than 24h", () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 100,
    gnewsDailyLimit: 100,
    mediastackDailyLimit: 100,
    yahooDailyLimit: 100
  });

  const oldTimestamp = Date.now() - 25 * 60 * 60 * 1_000;
  apiQuotaTracker.recordCall("gnews", { status: "success", timestamp: oldTimestamp });
  apiQuotaTracker.recordCall("gnews", { status: "success", timestamp: Date.now() });

  const snapshot = apiQuotaTracker.getProviderSnapshot("gnews");
  assert.equal(snapshot.calls24h, 1);
  assert.equal(snapshot.success24h, 1);
});
