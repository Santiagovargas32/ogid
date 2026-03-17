import { createHash } from "node:crypto";

const BASE_PRICES = {
  GD: 285,
  BA: 205,
  NOC: 465,
  LMT: 470,
  RTX: 96,
  XOM: 105,
  CVX: 150,
  COP: 110,
  SPY: 515,
  XLE: 94,
  ITA: 125
};

function hashToFloat(seed, min, max) {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const numeric = Number.parseInt(digest, 16);
  const ratio = numeric / 0xffffffff;
  return min + (max - min) * ratio;
}

export function buildFallbackQuote(ticker, timestamp) {
  const normalizedTicker = String(ticker || "").toUpperCase();
  const basePrice = BASE_PRICES[normalizedTicker] ?? 100;
  const changePct = hashToFloat(`${normalizedTicker}-${timestamp.slice(0, 16)}`, -2.8, 2.8);
  const price = basePrice * (1 + changePct / 100);

  return {
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    asOf: timestamp,
    source: "fallback",
    sourceDetail: "synthetic",
    synthetic: true,
    dataMode: "synthetic-fallback",
    providerScore: 0,
    providerLatencyMs: null,
    marketState: "SYNTHETIC"
  };
}
