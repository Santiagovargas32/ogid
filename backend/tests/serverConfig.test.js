import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server.js";

test("server resolves relative market history dirs against the backend directory", () => {
  const runtime = createAppServer({
    disableBackgroundRefresh: true,
    market: {
      provider: "",
      fallbackProvider: "",
      historyDir: "data/custom-market",
      historyPersist: false
    }
  });

  const expected = path.resolve(path.dirname(fileURLToPath(new URL("../server.js", import.meta.url))), "data/custom-market");
  assert.equal(path.normalize(runtime.config.market.historyDir), path.normalize(expected));
});

test("server keeps market off-hours strategy and provider budgets from config", () => {
  const runtime = createAppServer({
    disableBackgroundRefresh: true,
    market: {
      provider: "twelve",
      fallbackProvider: "yahoo",
      offHoursStrategy: "skip",
      requestReserve: 2,
      intervalByBandMs: {
        GREEN: {
          activeIntervalMs: 120_000,
          offHoursIntervalMs: 1_800_000
        }
      },
      historyPersist: false
    },
    apiLimits: {
      twelveDailyLimit: 800,
      twelveDailyBudget: 600,
      twelveMinuteLimit: 8,
      twelveMinuteBudget: 4,
      yahooDailyLimit: 200,
      yahooDailyBudget: 150
    }
  });

  assert.equal(runtime.config.market.offHoursStrategy, "skip");
  assert.equal(runtime.config.market.requestReserve, 2);
  assert.equal(runtime.config.market.intervalByBandMs.GREEN.activeIntervalMs, 120_000);
  assert.equal(runtime.config.market.intervalByBandMs.GREEN.offHoursIntervalMs, 1_800_000);
  assert.equal(runtime.config.apiLimits.twelveDailyLimit, 800);
  assert.equal(runtime.config.apiLimits.twelveDailyBudget, 600);
  assert.equal(runtime.config.apiLimits.twelveMinuteLimit, 8);
  assert.equal(runtime.config.apiLimits.twelveMinuteBudget, 4);
  assert.equal(runtime.config.apiLimits.yahooDailyLimit, 200);
  assert.equal(runtime.config.apiLimits.yahooDailyBudget, 150);
});
