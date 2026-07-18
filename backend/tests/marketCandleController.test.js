import assert from "node:assert/strict";
import test from "node:test";
import { getCandles } from "../controllers/marketController.js";
import { getInstrumentById } from "../services/market/instrumentRegistry.js";

const instrument = getInstrumentById("us-equity-general-dynamics");

function response(locals) {
  return {
    app: { locals },
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("Yahoo candles reject adjusted=none without reporting a fresh empty dataset", async () => {
  let yahooCalled = false;
  const req = { query: { instrumentId: instrument.instrumentId, interval: "1day", adjusted: "none" } };
  const res = response({
    config: { market: { provider: "yahoo" } },
    marketDataService: { fetchYahooBars: async () => { yahooCalled = true; } },
    dailyCandleService: { query: () => [] },
  });

  await getCandles(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, "UNSUPPORTED_ADJUSTMENT");
  assert.equal(yahooCalled, false);
});

test("Yahoo candles forward absolute history while Twelve retains adjusted=none", async () => {
  let yahooOptions = null;
  const yahooReq = { query: {
    instrumentId: instrument.instrumentId,
    interval: "1day",
    adjusted: "splits",
    from: "2024-01-01T00:00:00Z",
    to: "2024-02-01T00:00:00Z",
  } };
  const yahooRes = response({
    config: { market: { provider: "yahoo" } },
    marketDataService: { fetchYahooBars: async (_symbol, options) => { yahooOptions = options; return { stale: false, error: null }; } },
    dailyCandleService: { query: () => [{ instrumentId: instrument.instrumentId }] },
  });
  await getCandles(yahooReq, yahooRes, (error) => { throw error; });
  assert.equal(yahooOptions.from.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(yahooOptions.to.toISOString(), "2024-02-01T00:00:00.000Z");
  assert.equal(yahooRes.payload.data.status, "fresh");

  let adjustmentMode = null;
  const twelveReq = { query: { instrumentId: instrument.instrumentId, interval: "1day", adjusted: "none" } };
  const twelveRes = response({
    config: { market: { provider: "twelve" } },
    dailyCandleService: { query: (options) => { adjustmentMode = options.adjustmentMode; return [{ adjusted: false }]; } },
  });
  await getCandles(twelveReq, twelveRes, (error) => { throw error; });
  assert.equal(twelveRes.statusCode, 200);
  assert.equal(twelveRes.payload.data.status, "stored");
  assert.equal(adjustmentMode, "none");
});

test("candle history rejects an unbounded single from/to boundary", async () => {
  let yahooCalled = false;
  const req = { query: { instrumentId: instrument.instrumentId, interval: "1day", from: "2024-01-01T00:00:00Z" } };
  const res = response({
    config: { market: { provider: "yahoo" } },
    marketDataService: { fetchYahooBars: async () => { yahooCalled = true; } },
    dailyCandleService: { query: () => [] },
  });

  await getCandles(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, "INVALID_RANGE");
  assert.equal(yahooCalled, false);
});

test("Yahoo candles expose incomplete provider coverage as partial", async () => {
  const req = { query: { instrumentId: instrument.instrumentId, interval: "1day" } };
  const res = response({
    config: { market: { provider: "yahoo" } },
    marketDataService: { fetchYahooBars: async () => ({ complete: false, stale: false, error: { code: "YAHOO_INCOMPLETE_DATA" } }) },
    dailyCandleService: { query: () => [{ instrumentId: instrument.instrumentId }] },
  });

  await getCandles(req, res, (error) => { throw error; });
  assert.equal(res.payload.data.status, "partial");
  assert.equal(res.payload.data.error.code, "YAHOO_INCOMPLETE_DATA");
});
