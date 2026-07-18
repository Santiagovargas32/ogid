import { createHash } from "node:crypto";

function hashToFloat(seed, min, max) {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const numeric = Number.parseInt(digest, 16);
  const ratio = numeric / 0xffffffff;
  return min + (max - min) * ratio;
}

export function buildFallbackQuote(ticker, timestamp) {
  const normalizedTicker = String(ticker || "").toUpperCase();
  const basePrice = hashToFloat(`${normalizedTicker}:synthetic-base`, 20, 500);
  const changePct = hashToFloat(`${normalizedTicker}-${timestamp.slice(0, 16)}`, -2.8, 2.8);
  const price = basePrice * (1 + changePct / 100);

  return {
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    asOf: timestamp,
    source: "fallback",
    sourceDetail: "synthetic",
    synthetic: true,
    dataMode: "synthetic",
    providerDataMode: "synthetic-fallback",
    providerScore: 0,
    providerLatencyMs: null,
    marketState: "SYNTHETIC"
  };
}
