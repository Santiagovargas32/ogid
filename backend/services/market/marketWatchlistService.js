import fs from "node:fs";
import path from "node:path";
import { applyHotInstrumentSelection, registerInstrument, resolveInstrument, serializeInstrument } from "./instrumentRegistry.js";
import { projectDailyCredits } from "./marketCreditScheduler.js";

const SCHEMA_VERSION = 2;
const CANDIDATE_METADATA_FIELDS = Object.freeze(["displayName", "sector", "industry", "exchange", "currency"]);

function normalizeSelectionLimit(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function mergeVerifiedCandidate(candidate, discovered) {
  const merged = { ...(candidate || {}), ...(discovered || {}) };
  const discoveredSymbol = String(discovered?.canonicalSymbol || discovered?.symbol || "").trim().toUpperCase();
  for (const field of CANDIDATE_METADATA_FIELDS) {
    const discoveredValue = discovered?.[field];
    const isPlaceholderName = field === "displayName" && discoveredSymbol && String(discoveredValue || "").trim().toUpperCase() === discoveredSymbol;
    if ((discoveredValue == null || discoveredValue === "" || isPlaceholderName) && candidate?.[field] != null && candidate[field] !== "") {
      merged[field] = candidate[field];
    }
  }
  return merged;
}

export class MarketWatchlistService {
  constructor({ rolloutBatch = 1, initialReferences = [], maxSelected = null, persistencePath = null, legacySnapshotPath = null, creditPolicy = null, instrumentResolver = null } = {}) {
    this.rolloutBatch = rolloutBatch;
    this.maxSelected = normalizeSelectionLimit(maxSelected);
    this.persistencePath = persistencePath;
    this.legacySnapshotPath = legacySnapshotPath;
    this.creditPolicy = creditPolicy;
    this.instrumentResolver = instrumentResolver;
    this.candidates = new Map();
    this.persistenceError = null;
    const persisted = this.#readPersisted();
    for (const instrument of persisted?.instruments || []) {
      try { registerInstrument(instrument); } catch (error) { this.persistenceError = { code: error.code || "INVALID_PERSISTED_INSTRUMENT", message: error.message }; }
    }
    const requestedReferences = persisted?.selectedInstrumentIds || initialReferences;
    this.selectedInstrumentIds = this.#applySelectionLimit(this.#resolveKnown(requestedReferences));
    this.pendingReferences = requestedReferences
      .filter((reference) => !resolveInstrument(reference))
      .map((reference) => ({ reference, legacyId: persisted?.schemaVersion === 1 }));
  }

  #resolveKnown(references) {
    return [...new Set((references || []).map((reference) => resolveInstrument(reference)?.instrumentId).filter(Boolean))];
  }

  #applySelectionLimit(values) {
    return this.maxSelected == null ? [...values] : values.slice(0, this.maxSelected);
  }

  #selectionErrorMessage() {
    return this.maxSelected == null
      ? "Choose enabled verified instruments."
      : `Choose up to ${this.maxSelected} enabled verified instruments.`;
  }

  #readPersisted() {
    if (!this.persistencePath) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.persistencePath, "utf8"));
      return [1, SCHEMA_VERSION].includes(value.schemaVersion) ? value : null;
    } catch (error) {
      if (error?.code !== "ENOENT") this.persistenceError = { code: "WATCHLIST_PERSISTENCE_READ_FAILED", message: error.message };
      return null;
    }
  }

  #persist() {
    if (!this.persistencePath) return;
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      selectedInstrumentIds: this.selectedInstrumentIds,
      instruments: this.selectedInstruments().map(serializeInstrument),
      updatedAt: new Date().toISOString()
    }, null, 2));
    fs.renameSync(temporary, this.persistencePath);
  }

  #legacyCandidates() {
    if (!this.legacySnapshotPath) return new Map();
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.legacySnapshotPath, "utf8"));
      return new Map(Object.values(snapshot?.quotes || {}).filter(Boolean).map((quote) => [String(quote.instrumentId || ""), quote]));
    } catch (error) {
      if (error?.code !== "ENOENT") this.persistenceError = { code: "WATCHLIST_LEGACY_SNAPSHOT_READ_FAILED", message: error.message };
      return new Map();
    }
  }

  async hydrate() {
    if (!this.pendingReferences.length) return this.snapshot();
    const legacyCandidates = this.#legacyCandidates();
    const resolved = [...this.selectedInstrumentIds];
    const failures = [];
    for (const pending of this.pendingReferences) {
      const candidate = pending.legacyId ? legacyCandidates.get(String(pending.reference)) || null : null;
      const lookup = candidate?.canonicalSymbol || candidate?.symbol || pending.reference;
      if ((pending.legacyId && !candidate) || !this.instrumentResolver) {
        failures.push(String(pending.reference));
        continue;
      }
      try {
        const discovered = await this.instrumentResolver(lookup, candidate);
        const instrument = discovered ? registerInstrument(mergeVerifiedCandidate(candidate, discovered)) : null;
        if (!instrument?.enabled || instrument.verificationStatus !== "verified") throw new Error("instrument-not-verified");
        if (!resolved.includes(instrument.instrumentId)) resolved.push(instrument.instrumentId);
      } catch {
        failures.push(String(pending.reference));
      }
    }
    this.selectedInstrumentIds = this.#applySelectionLimit(resolved);
    if (failures.length) {
      this.persistenceError = {
        code: "WATCHLIST_LEGACY_MIGRATION_INCOMPLETE",
        message: `${failures.length} persisted watchlist instrument(s) could not be verified with Yahoo Finance.`
      };
    } else {
      this.pendingReferences = [];
      this.persistenceError = null;
      this.#persist();
    }
    return this.snapshot();
  }

  rememberCandidates(instruments = []) {
    for (const instrument of instruments) {
      for (const reference of [instrument?.instrumentId, instrument?.symbol, instrument?.canonicalSymbol]) {
        const key = String(reference || "").trim().toUpperCase();
        if (key) this.candidates.set(key, structuredClone(instrument));
      }
    }
    while (this.candidates.size > 200) this.candidates.delete(this.candidates.keys().next().value);
  }
  selectedInstruments() { return applyHotInstrumentSelection(this.selectedInstrumentIds.map((id) => resolveInstrument(id)).filter(Boolean), this.selectedInstrumentIds); }
  selectedSymbols() { return this.selectedInstruments().map((item) => item.canonicalSymbol); }
  applySelection(values) { return applyHotInstrumentSelection(values, this.selectedInstrumentIds); }
  projection() {
    if (!this.creditPolicy) return null;
    const instruments = this.selectedInstruments();
    const quotes = projectDailyCredits(instruments, this.creditPolicy);
    const dailyCandleCredits = instruments.length * this.creditPolicy.costPerSymbol;
    return { quoteCreditsPerDay: quotes.scheduledCredits, dailyCandleCreditsPerDay: dailyCandleCredits, baselineCreditsPerDay: quotes.scheduledCredits + dailyCandleCredits, creditsPerMinuteWorstCase: instruments.length, softLimit: this.creditPolicy.normalSoftLimit, hardLimit: this.creditPolicy.internalHardLimit, reservedCapacity: this.creditPolicy.reservedCapacity };
  }
  snapshot() {
    const selected = new Set(this.selectedInstrumentIds);
    return {
      maxSelected: this.maxSelected,
      selectedInstrumentIds: [...this.selectedInstrumentIds],
      selectedSymbols: this.selectedSymbols(),
      instruments: this.selectedInstruments().map((item) => ({ instrumentId: item.instrumentId, symbol: item.canonicalSymbol, displayName: item.displayName, assetType: item.assetType, sector: item.sector || null, industry: item.industry || null, exchange: item.exchange, currency: item.currency, selected: selected.has(item.instrumentId) })),
      projection: this.projection(),
      persistenceError: this.persistenceError
    };
  }
  async update(references) {
    if (!Array.isArray(references)) throw Object.assign(new Error("instrumentIds must be an array."), { code: "INVALID_WATCHLIST" });
    const uniqueReferences = [...new Set(references.map((reference) => String(reference || "").trim()).filter(Boolean))];
    if ((this.maxSelected != null && uniqueReferences.length > this.maxSelected) || uniqueReferences.length !== references.length) {
      throw Object.assign(new Error(this.#selectionErrorMessage()), { code: "INVALID_WATCHLIST" });
    }
    const resolved = [];
    for (const reference of uniqueReferences) {
      let instrument = resolveInstrument(reference);
      if (!instrument) {
        const candidate = this.candidates.get(reference.toUpperCase()) || null;
        const discovered = this.instrumentResolver
          ? await this.instrumentResolver(candidate?.symbol || candidate?.canonicalSymbol || reference, candidate)
          : candidate;
        if (discovered) instrument = registerInstrument(mergeVerifiedCandidate(candidate, discovered));
      }
      if (!instrument?.enabled || instrument.verificationStatus !== "verified") throw Object.assign(new Error(this.#selectionErrorMessage()), { code: "INVALID_WATCHLIST" });
      resolved.push(instrument);
    }
    const ids = [...new Set(resolved.map((instrument) => instrument.instrumentId))];
    if (ids.length !== uniqueReferences.length) throw Object.assign(new Error("Each watchlist instrument must be unique."), { code: "INVALID_WATCHLIST" });
    this.selectedInstrumentIds = ids;
    this.#persist();
    return this.snapshot();
  }
}
