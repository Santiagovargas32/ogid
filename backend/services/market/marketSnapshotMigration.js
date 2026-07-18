import { decorateCanonicalQuote, resolveInstrument, resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";

export const MARKET_PROVIDER_SCHEMA_VERSION = 3;

function isRecognizedShape(snapshot) {
  return snapshot && typeof snapshot === "object" && snapshot.quotes && typeof snapshot.quotes === "object" && !Array.isArray(snapshot.quotes);
}

export function migrateMarketSnapshot(snapshot) {
  if (!isRecognizedShape(snapshot)) return { snapshot: null, migrated: false, reason: "unknown-shape" };
  const version = Number(snapshot.providerSchemaVersion || 0);
  if (![0, 2, MARKET_PROVIDER_SCHEMA_VERSION].includes(version)) return { snapshot: null, migrated: false, reason: "unsupported-schema" };
  if (version === 0 && String(snapshot.provider || snapshot.sourceMeta?.provider || "").includes("web+fmp")) return { snapshot: null, migrated: false, reason: "unsafe-legacy-provider" };

  const quotes = {}; const unknownSymbols = [];
  for (const [reference, quote] of Object.entries(snapshot.quotes || {})) {
    const instrument = resolveInstrument(reference) || resolveInstrument(quote?.instrumentId) || resolveInstrument(quote?.symbol);
    if (!instrument) { unknownSymbols.push(reference); continue; }
    const dataMode = version === 0 && !["observed", "stale", "synthetic"].includes(quote?.dataMode) ? "stale" : quote?.dataMode;
    quotes[instrument.canonicalSymbol] = decorateCanonicalQuote({ ...quote, dataMode }, instrument, {
      providerId: quote?.sourceDetail || quote?.source || null,
      providerSymbol: quote?.providerSymbol || reference,
      fetchedAt: quote?.fetchedAt || snapshot.updatedAt || quote?.asOf || null,
      session: quote?.session || snapshot.session?.state || null
    });
  }
  if (!Object.keys(quotes).length) return { snapshot: null, migrated: false, reason: "no-known-instruments", unknownSymbols };
  const resolved = resolveVerifiedInstrumentReferences(snapshot.tickers || Object.keys(quotes));
  return {
    snapshot: {
      ...snapshot,
      providerSchemaVersion: MARKET_PROVIDER_SCHEMA_VERSION,
      tickers: resolved.instruments.map((instrument) => instrument.canonicalSymbol),
      quotes,
      sourceMeta: {
        ...(snapshot.sourceMeta || {}),
        migrationSource: version === 0 ? "legacy-unversioned" : version === 2 ? "provider-schema-v2" : null,
        unknownLegacySymbols: unknownSymbols
      }
    },
    migrated: version !== MARKET_PROVIDER_SCHEMA_VERSION,
    reason: version === 0 ? "legacy-migrated" : version === 2 ? "v2-migrated" : "current",
    unknownSymbols
  };
}
