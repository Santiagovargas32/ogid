import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";

test("api quota tracker computes effective remaining using env + headers", () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 5,
    gnewsDailyLimit: 5,
    mediastackDailyLimit: 5,
    fmpDailyLimit: 5
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
  assert.equal(snapshot.headerLimit, 20);
  assert.equal(snapshot.headerRemaining, 3);
  assert.equal(snapshot.effectiveRemaining, 3);
  assert.equal(snapshot.exhausted, false);
});

test("api quota tracker tracks twelve minute/day quotas, fallback and credit headers", () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 2,
    twelveMinuteLimit: 2,
    fmpDailyLimit: 2
  });

  apiQuotaTracker.recordCall("twelve", {
    status: "error",
    fallback: true,
    headers: {
      "api-credits-used": "1",
      "api-credits-left": "1"
    }
  });
  apiQuotaTracker.recordCall("fmp", { status: "success" });

  const twelveSnapshot = apiQuotaTracker.getProviderSnapshot("twelve");
  const fmpSnapshot = apiQuotaTracker.getProviderSnapshot("fmp");
  assert.equal(twelveSnapshot.calls24h, 1);
  assert.equal(twelveSnapshot.callsMinute, 1);
  assert.equal(twelveSnapshot.errors24h, 1);
  assert.equal(twelveSnapshot.fallback24h, 1);
  assert.equal(twelveSnapshot.configuredMinuteLimit, 2);
  assert.equal(twelveSnapshot.apiCreditsLeft, 1);
  assert.equal(twelveSnapshot.effectiveRemainingMinute, 1);
  assert.equal(twelveSnapshot.effectiveRemainingDay, 1);
  assert.equal(twelveSnapshot.effectiveRemaining, 1);
  assert.equal(fmpSnapshot.calls24h, 1);
  assert.equal(fmpSnapshot.success24h, 1);
  assert.equal(fmpSnapshot.effectiveRemaining, 1);
});

test("api quota tracker purges events older than 24h", () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 100,
    gnewsDailyLimit: 100,
    mediastackDailyLimit: 100,
    fmpDailyLimit: 100
  });

  const oldTimestamp = Date.now() - 25 * 60 * 60 * 1_000;
  apiQuotaTracker.recordCall("gnews", { status: "success", timestamp: oldTimestamp });
  apiQuotaTracker.recordCall("gnews", { status: "success", timestamp: Date.now() });

  const snapshot = apiQuotaTracker.getProviderSnapshot("gnews");
  assert.equal(snapshot.calls24h, 1);
  assert.equal(snapshot.success24h, 1);
});
