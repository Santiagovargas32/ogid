import { listVerifiedInstruments } from "../market/instrumentRegistry.js";
import { pick } from "../../utils/researchProjection.js";

const COMPANIES = {
  MSFT: ["Microsoft"], NVDA: ["NVIDIA"], GOOGL: ["Alphabet", "Google"], GOOG: ["Alphabet", "Google"],
  ASML: ["ASML"], "ASML.AS": ["ASML"], AMD: ["Advanced Micro Devices"], ORCL: ["Oracle"], AAPL: ["Apple"],
  LMT: ["Lockheed Martin"], NOC: ["Northrop Grumman"], GD: ["General Dynamics"], ARM: ["Arm Holdings"], META: ["Meta Platforms", "Facebook"]
};
const norm = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function entityAliases(instrument) {
  return [...new Set([instrument.displayName, ...(COMPANIES[instrument.canonicalSymbol] || [])].filter(Boolean).map(norm))];
}
export function resolveReferences(references = [], criteria = {}, universe = listVerifiedInstruments()) {
  return references.map(reference => {
    const exactId = universe.find(instrument => instrument.instrumentId.toLowerCase() === reference.toLowerCase());
    const normalized = norm(reference);
    let matches = exactId ? [exactId] : universe.filter(instrument =>
      [instrument.canonicalSymbol, ...(instrument.aliases || [])].some(alias => norm(alias) === normalized)
      || entityAliases(instrument).includes(normalized)
      || (instrument.assetType === "etf" && normalized.length >= 12 && norm(instrument.displayName).includes(normalized)));
    // ASML sin identidad de mercado es la empresa, no una elección implícita USD/EUR.
    if (!exactId && normalized === "asml") matches = universe.filter(instrument => (COMPANIES[instrument.canonicalSymbol] || []).includes("ASML"));
    matches = matches.filter(instrument => (!criteria.exchange || norm(instrument.exchange) === norm(criteria.exchange) || norm(instrument.mic) === norm(criteria.exchange))
      && (!criteria.currency || instrument.currency === criteria.currency) && (!criteria.isin || instrument.isin === criteria.isin));
    // Una sola clase conocida no acredita que el usuario eligiera esa clase/bolsa.
    const broadProduct = !exactId && !criteria.exchange && !criteria.isin && !criteria.currency
      && (["asml", "alphabet", "google"].includes(normalized)
        || matches.some(instrument => instrument.assetType === "etf" && normalized !== norm(instrument.canonicalSymbol)));
    const requiresSelection = matches.length > 1 || (matches.length === 1 && broadProduct);
    const resolved = matches.length === 1 && !requiresSelection;
    return { reference, status: resolved ? "resolved" : matches.length ? "ambiguous" : "unavailable", instrumentId: resolved ? matches[0].instrumentId : null,
      candidates: matches.map(instrument => instrument.instrumentId), missingReason: matches.length ? null : "not-in-verified-runtime-registry", requiresSelection,
      selectionReason: broadProduct && matches.length ? "confirm-market-or-share-class-with-id-symbol-or-criteria" : null };
  });
}
export function instrumentView(instrument, selectedIds = [], quotes = {}) {
  const quote = quotes[instrument.canonicalSymbol];
  const usable = quote?.price != null && !quote.synthetic && !["synthetic", "fallback"].includes(quote.dataMode);
  return { ...pick(instrument, ["instrumentId", "canonicalSymbol", "displayName", "assetType", "sector", "industry", "exchange", "mic", "currency", "timezone", "country", "isin", "shareClass", "aliases", "providerSymbols", "metadataSource"]),
    isin: instrument.isin ?? null, shareClass: instrument.shareClass ?? null, mic: instrument.mic ?? null,
    selected: selectedIds.includes(instrument.instrumentId), verified: instrument.verificationStatus === "verified", coverage: usable ? "quote-available" : "identity-only", missingReason: usable ? null : "no-usable-stored-quote", holdings: null, holdingsMissingReason: instrument.assetType === "etf" ? "no-dated-weighted-holdings" : null };
}
export function matchInstrument(article, instrument) {
  const body = `${article.title || ""} ${article.excerpt || ""}`;
  const normalized = ` ${norm(body)} `;
  if ((article.instrumentIds || []).includes(instrument.instrumentId)) return { instrumentId: instrument.instrumentId, kind: "direct", method: "provider-instrument-tag", evidence: instrument.instrumentId, confidence: "tagged-not-independently-corroborated" };
  for (const alias of entityAliases(instrument)) {
    if (alias.length >= 4 && normalized.includes(` ${alias} `)) return { instrumentId: instrument.instrumentId, kind: "direct", method: "entity-name-boundary-v1", evidence: alias, confidence: "name-match-not-independently-corroborated" };
  }
  const symbol = instrument.canonicalSymbol;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualified = new RegExp(`(?:\\$|(?:NASDAQ|NYSE|XETRA|ticker|symbol|cotiza(?:ción)?)(?::\\s*|\\s+))${escaped}(?![A-Za-z0-9.])`, "i");
  // Los acrónimos cortos/ambiguos solos nunca acreditan una empresa.
  if (qualified.test(body) || (!new Set(["GD", "AMD", "ARM", "META"]).has(symbol) && symbol.length >= 4 && new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9.])`).test(body)))
    return { instrumentId: instrument.instrumentId, kind: "direct", method: "qualified-symbol-v1", evidence: symbol, confidence: "symbol-match-not-independently-corroborated" };
  return null;
}
