import path from "node:path";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";

const MAX_MARKET_POINTS = 120;

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
      snapshotPath: path.join(this.rootDir, this.snapshotFile)
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

    const tickers = ensureTickerList(snapshot?.tickers?.length ? snapshot.tickers : this.tickers);
    const timeseriesEntries = await Promise.all(
      tickers.map(async (ticker) => [ticker, await this.loadTickerHistory(ticker)])
    );

    this.status.lastLoadedAt = new Date().toISOString();

    return {
      provider: snapshot.provider || "market-router",
      sourceMode: snapshot.sourceMode || "fallback",
      sourceMeta: snapshot.sourceMeta || { provider: "unknown" },
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

  async saveSnapshot(marketState = {}) {
    if (!this.enabled) {
      return;
    }

    await this.ensureDirectories();
    const payload = JSON.stringify(
      {
        provider: marketState.provider || "market-router",
        sourceMode: marketState.sourceMode || "fallback",
        sourceMeta: marketState.sourceMeta || { provider: "unknown" },
        updatedAt: marketState.updatedAt || null,
        tickers: ensureTickerList([...Object.keys(marketState.quotes || {}), ...this.tickers]),
        quotes: marketState.quotes || {}
      },
      null,
      2
    );
    const target = this.snapshotPath();
    const temp = `${target}.tmp`;
    await writeFile(temp, payload, "utf8");
    await rename(temp, target);
    this.status.lastSavedAt = new Date().toISOString();
  }

  async appendHistory(previousMarketState = {}, marketState = {}) {
    if (!this.enabled) {
      return;
    }

    await this.ensureDirectories();
    const tickers = ensureTickerList([...Object.keys(marketState.quotes || {}), ...this.tickers]);

    for (const ticker of tickers) {
      const nextQuote = marketState.quotes?.[ticker];
      const previousQuote = previousMarketState.quotes?.[ticker];
      if (!isFinitePrice(nextQuote?.price) || !nextQuote?.asOf) {
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
        source: nextQuote.source || null
      });
      await appendFile(this.historyPath(ticker), `${record}\n`, "utf8");
    }
  }

  async persistMarketState(previousMarketState = {}, marketState = {}) {
    if (!this.enabled) {
      return this.getStatus();
    }

    await this.appendHistory(previousMarketState, marketState);
    await this.saveSnapshot(marketState);
    return this.getStatus();
  }
}
