import "dotenv/config";
import { sanitizeSensitiveData } from "../utils/sanitize.js";
import { summarizeYahooError, YahooClient } from "../services/marketData/yahooClient.js";

const enabled = process.env.RUN_LIVE_UPSTREAM_SMOKE === "1";
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.MARKET_TIMEOUT_MS || "10000", 10) || 10_000);
const yahooSymbols = [...new Set(String(process.env.MARKET_SMOKE_TICKERS || "SPY")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean))];
const blsUrl = "https://www.bls.gov/feed/ppi.rss";

function safeFailure(provider, error, durationMs) {
  const yahooDiagnostics = provider === "yahoo" ? summarizeYahooError(error) : {};
  const httpStatus = yahooDiagnostics.httpStatus || [error?.status, error?.statusCode, error?.response?.status]
    .map(Number)
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599) || null;
  return {
    provider,
    status: "error",
    durationMs,
    errorName: sanitizeSensitiveData(String(yahooDiagnostics.errorName || error?.name || "Error")),
    httpStatus,
    validationIssues: yahooDiagnostics.validationIssues || [],
    message: sanitizeSensitiveData(String(error?.message || `${provider} smoke probe failed.`)),
  };
}

async function probeYahoo() {
  const startedAt = Date.now();
  try {
    const client = new YahooClient({ timeoutMs, retries: 0 });
    const raw = await client.quote(yahooSymbols);
    const returnedSymbols = Array.isArray(raw)
      ? raw.map((quote) => quote?.symbol)
      : Object.keys(raw || {});
    if (returnedSymbols.length === 0) throw new Error("Yahoo returned no quotes for the smoke symbols.");
    return {
      provider: "yahoo",
      status: "ok",
      durationMs: Date.now() - startedAt,
      requestedSymbols: yahooSymbols,
      returnedSymbols,
      missingSymbols: yahooSymbols.filter((symbol) => !returnedSymbols.includes(symbol)),
    };
  } catch (error) {
    return safeFailure("yahoo", error, Date.now() - startedAt);
  }
}

async function probeBls() {
  const startedAt = Date.now();
  try {
    const response = await fetch(blsUrl, {
      headers: {
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": process.env.AWARENESS_USER_AGENT || "OGID-awareness/1.0 (+https://localhost; contact: local-operator)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`BLS PPI request failed with HTTP ${response.status}`), { status: response.status });
    const body = await response.text();
    const contentType = response.headers.get("content-type") || null;
    if (!body.trim() || !/(?:<rss\b|<feed\b)/i.test(body)) throw new Error("BLS PPI returned an empty or non-feed response.");
    return {
      provider: "awareness-bls-ppi",
      status: "ok",
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
      contentType,
      bytes: Buffer.byteLength(body),
    };
  } catch (error) {
    return safeFailure("awareness-bls-ppi", error, Date.now() - startedAt);
  }
}

if (!enabled) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    skipped: true,
    reason: "Set RUN_LIVE_UPSTREAM_SMOKE=1 to contact Yahoo and BLS.",
  }, null, 2)}\n`);
} else {
  const probes = await Promise.all([probeYahoo(), probeBls()]);
  const ok = probes.every((probe) => probe.status === "ok");
  process.stdout.write(`${JSON.stringify({ ok, generatedAt: new Date().toISOString(), probes }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}
