import path from "node:path";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";

const MAX_MARKET_POINTS = 120;
const PROVIDER_BACKED_MODES = new Set(["live", "web-delayed"]);
const ANOMALOUS_MOVE_THRESHOLD_PCT = 3.5;
const PROVIDER_SCHEMA_VERSION = 2;

function ensureTickerList(tickers = []) {
  return [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean))];
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isFinitePrice(value) {
  return Number.isFinite(Number(value));
}

function normalizeDataMode(mode = "") {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "fallback") {
    return "synthetic-fallback";
  }
  if (normalized === "stale") {
    return "router-stale";
  }
  return normalized;
}

function isProviderBackedQuote(quote = {}) {
  if (!quote || quote.synthetic === true || !isFinitePrice(quote.price)) {
    return false;
  }

  return PROVIDER_BACKED_MODES.has(normalizeDataMode(quote.dataMode));
}

function providerBackedTickers(quotes = {}) {
  return Object.entries(quotes || {})
    .filter(([, quote]) => isProviderBackedQuote(quote))
    .map(([ticker]) => String(ticker || "").toUpperCase());
}

function normalizePoint(point = {}) {
  if (!point?.timestamp || !isFinitePrice(point?.price)) {
    return null;
  }

  return {
    timestamp: point.timestamp,
    price: Number(point.price),
    changePct: Number.isFinite(Number(point.changePct)) ? Number(point.changePct) : 0
  };
}

function timestampHourKey(value = null) {
  const parsed = new Date(value || 0);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return [
    parsed.getUTCFullYear(),
    String(parsed.getUTCMonth() + 1).padStart(2, "0"),
    String(parsed.getUTCDate()).padStart(2, "0"),
    String(parsed.getUTCHours()).padStart(2, "0")
  ].join("-");
}

function hasAnomalousProviderMove(previousMarketState = {}, marketState = {}) {
  return providerBackedTickers(marketState.quotes || {}).some((ticker) => {
    const nextQuote = marketState.quotes?.[ticker];
    const previousQuote = previousMarketState.quotes?.[ticker];
    const changePct = Math.abs(Number(nextQuote?.changePct || 0));
    if (changePct >= ANOMALOUS_MOVE_THRESHOLD_PCT) {
      return true;
    }

    if (!isFinitePrice(previousQuote?.price) || !isFinitePrice(nextQuote?.price) || Number(previousQuote.price) <= 0) {
      return false;
    }

    const priceMovePct = Math.abs(((Number(nextQuote.price) - Number(previousQuote.price)) / Number(previousQuote.price)) * 100);
    return priceMovePct >= ANOMALOUS_MOVE_THRESHOLD_PCT;
  });
}

function buildPersistenceMetadata({
  eligible = false,
  reason = null,
  trigger = null,
  providerBacked = [],
  savedAt = null,
  skippedAt = null
} = {}) {
  return {
    persistenceEligible: eligible,
    persistReason: reason,
    persistence: {
      eligible,
      reason,
      trigger,
      savedAt,
      skippedAt,
      providerBackedTickers: [...providerBacked],
      providerBackedCount: providerBacked.length,
      quality: providerBacked.length > 0 ? "provider-backed" : "fallback-only"
    }
  };
}

function filterPersistedQuotes(quotes = {}, providerBacked = []) {
  const allowed = new Set((providerBacked || []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean));
  if (!allowed.size) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(quotes || {}).filter(([ticker, quote]) => {
      const normalizedTicker = String(ticker || "").toUpperCase();
      return allowed.has(normalizedTicker) && isProviderBackedQuote(quote);
    })
  );
}

export class MarketHistoryStore {
  constructor({ enabled = true, rootDir, snapshotFile = "snapshot.json", tickers = [] } = {}) {
    this.enabled = enabled !== false;
    this.rootDir = path.resolve(String(rootDir || path.resolve(process.cwd(), "backend/data/market")));
    this.snapshotFile = String(snapshotFile || "snapshot.json");
    this.historyDir = path.join(this.rootDir, "history");
    this.tickers = ensureTickerList(tickers);
    this.status = {
      enabled: this.enabled,
      lastLoadedAt: null,
      lastSavedAt: null,
      lastSkippedAt: null,
      lastPersistReason: null,
      lastSkipReason: null,
      lastPersistenceEligible: false,
      snapshotPath: path.join(this.rootDir, this.snapshotFile),
      lastSavedMarketUpdatedAt: null
    };
  }

  getStatus() {
    return {
      ...this.status
    };
  }

  async ensureDirectories() {
    if (!this.enabled) {
      return;
    }

    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.historyDir, { recursive: true });
  }

  snapshotPath() {
    return path.join(this.rootDir, this.snapshotFile);
  }

  historyPath(ticker) {
    return path.join(this.historyDir, `${String(ticker || "").toUpperCase()}.jsonl`);
  }

  async loadSnapshot() {
    try {
      const content = await readFile(this.snapshotPath(), "utf8");
      return parseJson(content, null);
    } catch {
      return null;
    }
  }

  async loadTickerHistory(ticker) {
    try {
      const content = await readFile(this.historyPath(ticker), "utf8");
      return String(content || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseJson(line, null))
        .map(normalizePoint)
        .filter(Boolean)
        .slice(-MAX_MARKET_POINTS);
    } catch {
      return [];
    }
  }

  async loadMarketState() {
    if (!this.enabled) {
      return null;
    }

    await this.ensureDirectories();
    const snapshot = await this.loadSnapshot();
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }
    if (Number(snapshot.providerSchemaVersion) !== PROVIDER_SCHEMA_VERSION) {
      return null;
    }
    if (String(snapshot.provider || "").includes("web+fmp") || String(snapshot.sourceMeta?.provider || "").includes("web+fmp")) {
      return null;
    }

    const tickers = ensureTickerList(snapshot?.tickers?.length ? snapshot.tickers : this.tickers);
    const timeseriesEntries = await Promise.all(
      tickers.map(async (ticker) => [ticker, await this.loadTickerHistory(ticker)])
    );

    this.status.lastLoadedAt = new Date().toISOString();
    this.status.lastSavedAt = snapshot?.sourceMeta?.persistence?.savedAt || this.status.lastSavedAt;
    this.status.lastSavedMarketUpdatedAt = snapshot.updatedAt || this.status.lastSavedMarketUpdatedAt;
    this.status.lastPersistReason = snapshot?.sourceMeta?.persistReason || snapshot?.sourceMeta?.persistence?.reason || null;
    this.status.lastPersistenceEligible = snapshot?.sourceMeta?.persistenceEligible === true;

    return {
      provider: snapshot.provider || "market-router",
      sourceMode: snapshot.sourceMode || "fallback",
      sourceMeta: snapshot.sourceMeta || { provider: "unknown" },
      revision: snapshot.revision || null,
      session: snapshot.session || null,
      updatedAt: snapshot.updatedAt || null,
      quotes: snapshot.quotes || {},
      timeseries: Object.fromEntries(timeseriesEntries)
    };
  }

  async hydrateState(stateManager) {
    if (!this.enabled || !stateManager?.hydrateMarketState) {
      return null;
    }

    const marketState = await this.loadMarketState();
    if (!marketState) {
      return null;
    }

    stateManager.hydrateMarketState(marketState);
    return marketState;
  }

  resolvePersistDecision(previousMarketState = {}, marketState = {}, { trigger = "scheduled-market" } = {}) {
    const providerBacked = providerBackedTickers(marketState.quotes || {});
    if (!providerBacked.length) {
      return {
        eligible: false,
        reason: "fallback-only",
        providerBacked
      };
    }

    if (!this.status.lastSavedAt) {
      return {
        eligible: true,
        reason: "startup-provider-backed",
        providerBacked
      };
    }

    const previousOpen = previousMarketState.session?.open === true;
    const nextOpen = marketState.session?.open === true;
    if (!previousOpen && nextOpen) {
      return {
        eligible: true,
        reason: "market-open",
        providerBacked
      };
    }
    if (previousOpen && !nextOpen) {
      return {
        eligible: true,
        reason: "market-close",
        providerBacked
      };
    }
    if (String(trigger || "").startsWith("manual")) {
      return {
        eligible: true,
        reason: "manual-refresh",
        providerBacked
      };
    }

    if (
      nextOpen &&
      timestampHourKey(this.status.lastSavedMarketUpdatedAt) !== timestampHourKey(marketState.updatedAt)
    ) {
      return {
        eligible: true,
        reason: "intraday-hourly-checkpoint",
        providerBacked
      };
    }

    if (hasAnomalousProviderMove(previousMarketState, marketState)) {
      return {
        eligible: true,
        reason: "anomalous-provider-move",
        providerBacked
      };
    }

    return {
      eligible: false,
      reason: "not-key-moment",
      providerBacked
    };
  }

  async saveSnapshot(marketState = {}, persistenceDecision = {}, options = {}) {
    if (!this.enabled) {
      return;
    }

    await this.ensureDirectories();
    const savedAt = new Date().toISOString();
    const persistenceMetadata = buildPersistenceMetadata({
      eligible: true,
      reason: persistenceDecision.reason,
      trigger: options.trigger || null,
      providerBacked: persistenceDecision.providerBacked || [],
      savedAt
    });
    marketState.sourceMeta = {
      ...(marketState.sourceMeta || {}),
      ...persistenceMetadata
    };
    const persistedQuotes = filterPersistedQuotes(marketState.quotes || {}, persistenceDecision.providerBacked || []);

    const payload = JSON.stringify(
      {
        providerSchemaVersion: PROVIDER_SCHEMA_VERSION,
        provider: marketState.provider || "market-router",
        sourceMode: marketState.sourceMode || "fallback",
        sourceMeta: marketState.sourceMeta || { provider: "unknown" },
        revision: marketState.revision || null,
        session: marketState.session || null,
        updatedAt: marketState.updatedAt || null,
        tickers: ensureTickerList([...Object.keys(marketState.quotes || {}), ...this.tickers]),
        quotes: persistedQuotes
      },
      null,
      2
    );
    const target = this.snapshotPath();
    const temp = `${target}.tmp`;
    await writeFile(temp, payload, "utf8");
    await rename(temp, target);
    this.status.lastSavedAt = savedAt;
    this.status.lastSavedMarketUpdatedAt = marketState.updatedAt || null;
    this.status.lastPersistReason = persistenceDecision.reason || null;
    this.status.lastPersistenceEligible = true;
    this.status.lastSkipReason = null;
  }

  async appendHistory(previousMarketState = {}, marketState = {}, persistenceDecision = {}) {
    if (!this.enabled) {
      return;
    }

    await this.ensureDirectories();
    const tickers = ensureTickerList([
      ...Object.keys(marketState.quotes || {}),
      ...this.tickers,
      ...(persistenceDecision.providerBacked || [])
    ]);

    for (const ticker of tickers) {
      const nextQuote = marketState.quotes?.[ticker];
      const previousQuote = previousMarketState.quotes?.[ticker];
      if (!isProviderBackedQuote(nextQuote) || !nextQuote?.asOf) {
        continue;
      }

      const changed =
        !previousQuote ||
        Number(previousQuote.price) !== Number(nextQuote.price) ||
        String(previousQuote.asOf || "") !== String(nextQuote.asOf || "");
      if (!changed) {
        continue;
      }

      const record = JSON.stringify({
        timestamp: nextQuote.asOf,
        price: Number(nextQuote.price),
        changePct: Number.isFinite(Number(nextQuote.changePct)) ? Number(nextQuote.changePct) : 0,
        dataMode: nextQuote.dataMode || null,
        source: nextQuote.source || null,
        sourceDetail: nextQuote.sourceDetail || null
      });
      await appendFile(this.historyPath(ticker), `${record}\n`, "utf8");
    }
  }

  async persistMarketState(previousMarketState = {}, marketState = {}, options = {}) {
    if (!this.enabled) {
      return this.getStatus();
    }

    const persistenceDecision = this.resolvePersistDecision(previousMarketState, marketState, options);
    const skippedAt = new Date().toISOString();
    marketState.sourceMeta = {
      ...(marketState.sourceMeta || {}),
      ...buildPersistenceMetadata({
        eligible: persistenceDecision.eligible,
        reason: persistenceDecision.reason,
        trigger: options.trigger || null,
        providerBacked: persistenceDecision.providerBacked || [],
        skippedAt: persistenceDecision.eligible ? null : skippedAt
      })
    };

    if (!persistenceDecision.eligible) {
      this.status.lastSkippedAt = skippedAt;
      this.status.lastSkipReason = persistenceDecision.reason || null;
      this.status.lastPersistenceEligible = false;
      return this.getStatus();
    }

    await this.appendHistory(previousMarketState, marketState, persistenceDecision);
    await this.saveSnapshot(marketState, persistenceDecision, options);
    return this.getStatus();
  }
}
