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

test("api quota tracker marks fallback and errors for market providers", () => {
  apiQuotaTracker.reset({
    webDailyLimit: 2,
    fmpDailyLimit: 2
  });

  apiQuotaTracker.recordCall("web", { status: "error", fallback: true });
  apiQuotaTracker.recordCall("fmp", { status: "success" });

  const webSnapshot = apiQuotaTracker.getProviderSnapshot("web");
  const fmpSnapshot = apiQuotaTracker.getProviderSnapshot("fmp");
  assert.equal(webSnapshot.calls24h, 1);
  assert.equal(webSnapshot.errors24h, 1);
  assert.equal(webSnapshot.fallback24h, 1);
  assert.equal(webSnapshot.effectiveRemaining, 1);
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
