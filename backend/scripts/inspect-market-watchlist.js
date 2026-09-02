import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const historyDir = path.resolve(process.cwd(), process.env.MARKET_HISTORY_DIR || "data/market");
const selectionPath = path.join(historyDir, "watchlist-selection.json");
const configuredTickers = [...new Set(String(process.env.MARKET_TICKERS || "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean))];

function report(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

try {
  const persisted = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  if (![1, 2].includes(persisted?.schemaVersion) || !Array.isArray(persisted?.selectedInstrumentIds)) {
    throw Object.assign(new Error("Unsupported or malformed watchlist selection schema."), { code: "INVALID_WATCHLIST_SCHEMA" });
  }
  const symbolsById = new Map((persisted.instruments || []).map((instrument) => [
    String(instrument?.instrumentId || ""),
    String(instrument?.canonicalSymbol || instrument?.symbol || "").trim().toUpperCase(),
  ]));
  const selectedSymbols = persisted.selectedInstrumentIds.map((id) => symbolsById.get(String(id))).filter(Boolean);
  report({
    ok: true,
    selectionSource: "persisted",
    selectionPath,
    schemaVersion: persisted.schemaVersion,
    updatedAt: persisted.updatedAt || null,
    configuredMarketTickers: configuredTickers,
    selectedInstrumentIds: persisted.selectedInstrumentIds,
    selectedSymbols,
    unresolvedInstrumentIds: persisted.selectedInstrumentIds.filter((id) => !symbolsById.has(String(id))),
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    report({
      ok: true,
      selectionSource: "environment",
      selectionPath,
      persistedSelectionExists: false,
      configuredMarketTickers: configuredTickers,
      selectedSymbols: configuredTickers,
    });
  } else {
    report({
      ok: false,
      selectionPath,
      errorName: String(error?.name || "Error"),
      errorCode: String(error?.code || "WATCHLIST_READ_FAILED"),
      message: String(error?.message || "Unable to inspect persisted watchlist."),
    });
    process.exitCode = 1;
  }
}
