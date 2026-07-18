const DEFAULT_MAX_SELECTED = null;

function normalizedMaxSelected(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeMarketInstrument(value = {}) {
  const instrumentId = String(value.instrumentId || "").trim();
  const symbol = String(value.symbol || value.canonicalSymbol || "").trim().toUpperCase();
  if (!instrumentId || !symbol) {
    return null;
  }

  return {
    instrumentId,
    symbol,
    displayName: String(value.displayName || symbol).trim(),
    assetType: String(value.assetType || "unknown").trim().toLowerCase(),
    exchange: String(value.exchange || "Unknown exchange").trim(),
    currency: String(value.currency || "").trim().toUpperCase(),
    selected: value.selected === true
  };
}

export function normalizeMarketInstruments(values = []) {
  const byId = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const instrument = normalizeMarketInstrument(value);
    if (!instrument) {
      continue;
    }
    const key = instrument.instrumentId.toLowerCase();
    if (!byId.has(key)) {
      byId.set(key, instrument);
    }
  }
  return [...byId.values()];
}

export function resolveSelectedMarketInstruments(model = {}) {
  const instruments = normalizeMarketInstruments(model.instruments);
  const selectedIds = new Set(
    (Array.isArray(model.selectedInstrumentIds) ? model.selectedInstrumentIds : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const selectedSymbols = new Set(
    (Array.isArray(model.selectedSymbols) ? model.selectedSymbols : [])
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean)
  );

  if (selectedIds.size) {
    return instruments.filter((instrument) => selectedIds.has(instrument.instrumentId.toLowerCase()));
  }
  if (instruments.some((instrument) => instrument.selected)) {
    return instruments.filter((instrument) => instrument.selected);
  }
  if (selectedSymbols.size) {
    return instruments.filter((instrument) => selectedSymbols.has(instrument.symbol));
  }

  // The dynamic endpoint returns only selected instruments, without requiring a
  // redundant selected flag. Treat that response as authoritative.
  return instruments;
}

export function addMarketInstrument(selection = [], value = {}, maxSelected = DEFAULT_MAX_SELECTED) {
  const instruments = normalizeMarketInstruments(selection);
  const instrument = normalizeMarketInstrument(value);
  if (!instrument) {
    return { instruments, changed: false, reason: "invalid" };
  }
  if (instruments.some((item) => item.instrumentId.toLowerCase() === instrument.instrumentId.toLowerCase())) {
    return { instruments, changed: false, reason: null };
  }
  const limit = normalizedMaxSelected(maxSelected);
  if (limit != null && instruments.length >= limit) {
    return { instruments, changed: false, reason: "limit" };
  }
  return { instruments: [...instruments, { ...instrument, selected: true }], changed: true, reason: null };
}

export function removeMarketInstrument(selection = [], instrumentId = "") {
  const key = String(instrumentId || "").trim().toLowerCase();
  const instruments = normalizeMarketInstruments(selection);
  const next = instruments.filter((instrument) => instrument.instrumentId.toLowerCase() !== key);
  return { instruments: next, changed: next.length !== instruments.length };
}

export function validateMarketSelection(selection = [], maxSelected = DEFAULT_MAX_SELECTED) {
  const count = normalizeMarketInstruments(selection).length;
  const limit = normalizedMaxSelected(maxSelected);
  if (limit != null && count > limit) {
    return { valid: false, reason: "limit", count };
  }
  return { valid: true, reason: null, count };
}

export function marketSelectionIds(selection = []) {
  return normalizeMarketInstruments(selection).map((instrument) => instrument.instrumentId);
}

export function marketSelectionSymbols(selection = []) {
  return normalizeMarketInstruments(selection).map((instrument) => instrument.symbol);
}
