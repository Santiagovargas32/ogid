import test from "node:test";
import assert from "node:assert/strict";
import { resolveMarketQuotesPollDelayMs, MARKET_POLLING_INTERVALS } from "../../frontend/js/marketPolling.js";

test("market polling resolves foreground, background, stale and closed delays", () => {
  assert.equal(
    resolveMarketQuotesPollDelayMs({
      hidden: false,
      marketOpen: true,
      dataMode: "live"
    }),
    MARKET_POLLING_INTERVALS.foreground
  );

  assert.equal(
    resolveMarketQuotesPollDelayMs({
      hidden: true,
      marketOpen: true,
      dataMode: "live"
    }),
    MARKET_POLLING_INTERVALS.background
  );

  assert.equal(
    resolveMarketQuotesPollDelayMs({
      hidden: false,
      marketOpen: true,
      dataMode: "router-stale"
    }),
    MARKET_POLLING_INTERVALS.stale
  );

  assert.equal(
    resolveMarketQuotesPollDelayMs({
      hidden: false,
      marketOpen: false,
      dataMode: "live"
    }),
    MARKET_POLLING_INTERVALS.closed
  );
});
