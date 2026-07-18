import { createHash } from "node:crypto";

const VERIFIED_AT = "2026-07-16";
const DEFAULT_ROLLOUT_BATCH = 1;

export function resolveRolloutBatch(value = process.env.MARKET_WATCHLIST_ROLLOUT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : DEFAULT_ROLLOUT_BATCH;
}

export function validateInstrument(instrument) {
  const required = ["instrumentId", "canonicalSymbol", "displayName", "assetType", "exchange", "currency", "timezone", "country", "providerSymbols", "metadataSource", "verificationStatus"];
  const missing = required.filter((field) => !instrument?.[field]);
  const verifiedMappings = instrument?.verificationStatus === "verified" && Boolean(instrument?.providerSymbols?.yahoo);
  return { valid: missing.length === 0 && instrument.instrumentId !== instrument.canonicalSymbol && verifiedMappings, missing };
}

function buildIndexes(values) {
  const byId = new Map(); const bySymbol = new Map(); const byAlias = new Map();
  for (const instrument of values) {
    const validation = validateInstrument(instrument);
    if (!validation.valid) throw new Error(`invalid-instrument:${instrument?.instrumentId || "unknown"}:${validation.missing.join(",")}`);
    const id = instrument.instrumentId.toLowerCase();
    if (byId.has(id)) throw new Error(`duplicate-instrument-id:${instrument.instrumentId}`);
    byId.set(id, instrument);
    for (const reference of [instrument.canonicalSymbol, ...(instrument.aliases || [])]) {
      const key = String(reference).trim().toUpperCase();
      if (byAlias.has(key) && byAlias.get(key).instrumentId !== instrument.instrumentId) throw new Error(`duplicate-instrument-alias:${key}`);
      byAlias.set(key, instrument);
    }
    bySymbol.set(instrument.canonicalSymbol.toUpperCase(), instrument);
  }
  return { byId, bySymbol, byAlias };
}

function freezeInstrument(instrument) {
  return Object.freeze({
    ...instrument,
    providerSymbols: Object.freeze({ ...(instrument.providerSymbols || {}) }),
    aliases: Object.freeze([...(instrument.aliases || [])]),
    metadataSource: Object.freeze({ ...(instrument.metadataSource || {}) })
  });
}

function dynamicInstrumentId(symbol, assetType = "instrument") {
  const slug = String(symbol || "instrument").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "instrument";
  const digest = createHash("sha1").update(String(symbol || "").toUpperCase()).digest("hex").slice(0, 8);
  return `yahoo-${String(assetType || "instrument").toLowerCase()}-${slug}-${digest}`;
}

function normalizeAssetType(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return ({ cryptocurrency: "crypto", currency: "currency", mutualfund: "fund", money_market: "fund" })[normalized] || normalized || "instrument";
}

let instruments = [];
let indexes = buildIndexes([]);

export function registerInstrument(rawInstrument = {}) {
  const symbol = String(rawInstrument.canonicalSymbol || rawInstrument.symbol || "").trim().toUpperCase();
  const existing = getInstrumentById(rawInstrument.instrumentId) || getInstrumentByCanonicalSymbol(symbol);
  const assetType = normalizeAssetType(rawInstrument.assetType || rawInstrument.quoteType || existing?.assetType);
  const providerSymbols = {
    ...(existing?.providerSymbols || {}),
    ...(rawInstrument.providerSymbols || {}),
    yahoo: rawInstrument.providerSymbols?.yahoo || rawInstrument.yahooSymbol || existing?.providerSymbols?.yahoo || symbol
  };
  const aliases = [...new Set([
    ...(existing?.aliases || []),
    ...(rawInstrument.aliases || []),
    symbol,
    providerSymbols.yahoo
  ].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))];
  const instrument = freezeInstrument({
    ...existing,
    ...rawInstrument,
    instrumentId: existing?.instrumentId || rawInstrument.instrumentId || dynamicInstrumentId(symbol, assetType),
    canonicalSymbol: symbol,
    displayName: rawInstrument.displayName || rawInstrument.longName || rawInstrument.shortName || existing?.displayName || symbol,
    assetType,
    exchange: rawInstrument.exchange || rawInstrument.fullExchangeName || existing?.exchange || null,
    mic: rawInstrument.mic ?? existing?.mic ?? null,
    currency: String(rawInstrument.currency || existing?.currency || "").trim().toUpperCase() || null,
    timezone: rawInstrument.timezone || rawInstrument.exchangeTimezoneName || existing?.timezone || null,
    country: rawInstrument.country || rawInstrument.region || existing?.country || "GLOBAL",
    enabled: rawInstrument.enabled !== false,
    rolloutBatch: Number.isInteger(rawInstrument.rolloutBatch) ? rawInstrument.rolloutBatch : existing?.rolloutBatch || 1,
    refreshTier: rawInstrument.refreshTier || existing?.refreshTier || "background",
    minRefreshIntervalMs: Number(rawInstrument.minRefreshIntervalMs || existing?.minRefreshIntervalMs) || (assetType === "crypto" ? 14_400_000 : 23_400_000),
    verificationStatus: rawInstrument.verificationStatus || existing?.verificationStatus || "verified",
    sessionPolicy: rawInstrument.sessionPolicy || existing?.sessionPolicy || (["crypto", "currency"].includes(assetType) ? "24x7" : "exchange-hours"),
    providerSymbols,
    aliases,
    metadataSource: rawInstrument.metadataSource || existing?.metadataSource || { provider: "yahoo-finance2", verifiedAt: new Date().toISOString() },
    dynamic: rawInstrument.dynamic ?? existing?.dynamic ?? true
  });
  const validation = validateInstrument(instrument);
  if (!validation.valid) {
    throw Object.assign(new Error(`invalid-instrument:${instrument.instrumentId}:${validation.missing.join(",")}`), {
      code: "INVALID_INSTRUMENT_METADATA",
      details: validation
    });
  }
  const next = existing
    ? instruments.map((item) => item.instrumentId === existing.instrumentId ? instrument : item)
    : [...instruments, instrument];
  const nextIndexes = buildIndexes(next);
  instruments = next;
  indexes = nextIndexes;
  return instrument;
}

export function registerInstruments(values = []) {
  return values.map((instrument) => registerInstrument(instrument));
}

if (process.env.NODE_ENV === "test" && Array.isArray(globalThis.__OGID_TEST_MARKET_INSTRUMENTS__)) {
  registerInstruments(globalThis.__OGID_TEST_MARKET_INSTRUMENTS__);
}

export function getInstrumentById(instrumentId) { return indexes.byId.get(String(instrumentId || "").trim().toLowerCase()) || null; }
export function getInstrumentByCanonicalSymbol(symbol) { return indexes.bySymbol.get(String(symbol || "").trim().toUpperCase()) || null; }
export function resolveAlias(alias) { return indexes.byAlias.get(String(alias || "").trim().toUpperCase()) || null; }
export function resolveInstrument(reference) { return getInstrumentById(reference) || resolveAlias(reference); }
export function getProviderSymbol(instrumentId, providerId) { return getInstrumentById(instrumentId)?.providerSymbols?.[String(providerId || "").toLowerCase()] || null; }
export function getInstrumentByProviderSymbol(providerId, symbol) { const provider = String(providerId || "").toLowerCase(); const normalized = String(symbol || "").toUpperCase(); return instruments.find((instrument) => String(instrument.providerSymbols?.[provider] || "").toUpperCase() === normalized) || null; }
export function listVerifiedInstruments() { return instruments.filter((instrument) => instrument.verificationStatus === "verified"); }
export function listEnabledInstruments(rolloutBatch = resolveRolloutBatch()) { return listVerifiedInstruments().filter((instrument) => instrument.enabled && instrument.rolloutBatch <= rolloutBatch); }
export function applyHotInstrumentSelection(values = [], selectedInstrumentIds = []) {
  const selected = new Set(selectedInstrumentIds.map((value) => String(value).toLowerCase()));
  return values.map((instrument) => selected.has(instrument.instrumentId.toLowerCase())
    ? { ...instrument, refreshTier: "hot", minRefreshIntervalMs: instrument.sessionPolicy === "24x7" ? 14_400_000 : 300_000 }
    : { ...instrument, refreshTier: "background", minRefreshIntervalMs: instrument.sessionPolicy === "24x7" ? 14_400_000 : 23_400_000 });
}
export function resolveInstrumentSession(instrument, marketSession = null) { return instrument?.sessionPolicy === "24x7" ? "24x7" : marketSession?.state || marketSession || null; }
export function resolveEnabledInstruments(references = [], rolloutBatch = resolveRolloutBatch()) {
  const enabledIds = new Set(listEnabledInstruments(rolloutBatch).map((instrument) => instrument.instrumentId)); const resolved = []; const rejected = [];
  for (const reference of references) { const instrument = resolveInstrument(reference); if (!instrument || !enabledIds.has(instrument.instrumentId)) { rejected.push(String(reference || "")); continue; } if (!resolved.some((entry) => entry.instrumentId === instrument.instrumentId)) resolved.push(instrument); }
  return { instruments: resolved, rejected };
}

export function resolveVerifiedInstrumentReferences(references = []) {
  const resolved = []; const rejected = [];
  for (const reference of references) {
    const instrument = resolveInstrument(reference);
    if (!instrument?.enabled || instrument.verificationStatus !== "verified") { rejected.push(String(reference || "")); continue; }
    if (!resolved.some((entry) => entry.instrumentId === instrument.instrumentId)) resolved.push(instrument);
  }
  return { instruments: resolved, rejected };
}

export function serializeInstrument(instrument) {
  return instrument ? structuredClone(instrument) : null;
}

export function decorateCanonicalQuote(quote = {}, instrument, { providerId = null, providerSymbol = null, fetchedAt = null, session = null } = {}) {
  if (!instrument) return null; const asOfMs = new Date(quote.asOf || 0).getTime(); const fetchedMs = new Date(fetchedAt || 0).getTime(); const stale = quote.dataMode === "stale" || quote.stale === true;
  return { ...quote, instrumentId: instrument.instrumentId, symbol: instrument.canonicalSymbol, canonicalSymbol: instrument.canonicalSymbol, providerSymbol: providerSymbol || (providerId ? getProviderSymbol(instrument.instrumentId, providerId) : null), displayName: instrument.displayName, assetType: instrument.assetType, sector: instrument.sector || null, industry: instrument.industry || null, exchange: instrument.exchange, mic: instrument.mic, currency: instrument.currency, timezone: instrument.timezone, country: instrument.country, fetchedAt: fetchedAt || quote.fetchedAt || null, session: session || quote.session || null, stale, staleAgeMs: stale && Number.isFinite(asOfMs) && Number.isFinite(fetchedMs) ? Math.max(0, fetchedMs - asOfMs) : quote.staleAgeMs ?? null };
}

export function findMetadataDiscrepancies(instrument, providerMetadata = {}) { if (!instrument || !providerMetadata) return []; const normalizeExchange = (value) => String(value || "").trim().toUpperCase().replace("NEW YORK STOCK EXCHANGE", "NYSE"); const checks = [["exchange", normalizeExchange(instrument.exchange), normalizeExchange(providerMetadata.exchange)], ["mic", instrument.mic, providerMetadata.mic], ["currency", instrument.currency, providerMetadata.currency], ["timezone", instrument.timezone, providerMetadata.timezone]]; return checks.filter(([, canonical, observed]) => canonical && observed && String(canonical).toUpperCase() !== String(observed).toUpperCase()).map(([field, canonical, observed]) => ({ field, canonical, observed })); }

export { DEFAULT_ROLLOUT_BATCH, VERIFIED_AT };
