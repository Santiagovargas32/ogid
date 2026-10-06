import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewsArchive } from "../services/research/newsArchive.js";
import { MaterialAlertStore } from "../services/research/materialAlertStore.js";
import { matchInstrument, resolveReferences } from "../services/research/instrumentIdentity.js";
import { getInstrumentByCanonicalSymbol, registerInstrument } from "../services/market/instrumentRegistry.js";
import { publicProjection } from "../utils/researchProjection.js";
import { getOperation, parseOperationQuery } from "../contracts/ogidOperations.js";

const instant = Date.parse("2026-10-06T12:00:00Z");
const fixture = (index, extra = {}) => ({ id: `original-${index}`, title: `NVIDIA earnings release ${index}`, description: "Corporate results without country labels.", provider: "rss", sourceId: "fixture-rss", publisher: "Fixture publisher", url: `https://example.org/news/${index}`, publishedAt: new Date(instant - 3600000 - index * 1000).toISOString(), ...extra });
test("archivo anterior al recorte: empresa sin país, fechas, shadow y procedencia conjunta", () => {
  const archive = new NewsArchive({ now: () => instant });
  archive.ingest([fixture(1), fixture(2, { title: "NVIDIA in Taiwan", countryMentions: ["TW"] }), fixture(3, { admissionState: "shadow" }), fixture(4, { title: "NVIDIA update", publishedAt: "2026-10-06T10:00:00Z", provenance: { publishedAtBasis: "updated" } }), fixture(5, { usagePolicy: { contentPolicy: "headline-only-link-out" }, description: "DO_NOT_RETURN", content: "FULL_PRIVATE", provenance: { token: "SECRET", publishedAtQuality: "fallback-missing" } })]);
  archive.ingest([fixture(1, { provider: "newsapi", sourceId: "second-source" })]);
  const result = archive.search({ symbols: ["NVDA"], limit: 100 });
  assert.equal(result.total, 4); assert.ok(result.articles.some(article => !article.countryMentions.length));
  assert.equal(archive.search({ countries: ["TW"] }).total, 1);
  assert.equal(result.articles.find(article => article.originalIds.includes("original-1")).provenances.length, 2);
  assert.equal(result.articles.find(article => article.originalIds.includes("original-4")).publishedAt, null);
  assert.equal(result.articles.find(article => article.originalIds.includes("original-4")).updatedAt, "2026-10-06T10:00:00.000Z");
  const output = JSON.stringify(result); for (const secret of ["DO_NOT_RETURN", "FULL_PRIVATE", "SECRET", "original-3"]) assert.ok(!output.includes(secret));
  assert.equal(archive.search({ symbols: ["NVDA"], from: "2026-10-06T09:00:00Z", to: "2026-10-06T12:00:00Z" }).total, 2);
  assert.equal(archive.search({ symbols: ["NVDA"], timeField: "receivedAt", from: "2026-10-06T09:00:00Z", to: "2026-10-06T12:00:00Z" }).total, 4);
  assert.equal(archive.ingest([fixture(9)], { lane: "financial", awarenessMode: "shadow" }).accepted, 0);
  const synthetic = new NewsArchive({ now: () => instant });
  synthetic.ingest([fixture(10, { provenance: { synthetic: true } })]);
  assert.equal(synthetic.search().quality.syntheticCount, 1);
  const provenance = new NewsArchive({ now: () => instant });
  provenance.ingest(Array.from({ length: 45 }, (_, i) => fixture(1, { id: `origin-${i}`, sourceId: null, publisher: `publisher-${i}` })));
  const lastSource = provenance.search({ sources: ["publisher-44"] });
  assert.equal(lastSource.total, 1); assert.equal(lastSource.articles[0].provenances.length, 45);
  assert.equal(lastSource.articles[0].originalIds.length, 45);
});
test("filtros antes de paginar, revisión estable ante llegadas/correcciones y continuación por bytes sin pérdida", () => {
  const archive = new NewsArchive({ now: () => instant });
  archive.ingest(Array.from({ length: 237 }, (_, index) => fixture(index, { description: "a".repeat(500), countryMentions: index % 2 ? ["TW"] : [] })));
  let page = archive.search({ countries: ["TW"], symbols: ["NVDA"], limit: 100, maxBytes: 8192 }); const total = page.total;
  assert.equal(total, 118); assert.ok(page.articles.length < 100);
  const received = []; const id = page.snapshotId; const revision = page.revision;
  archive.ingest([fixture(1000, { countryMentions: ["TW"] }), fixture(1, { countryMentions: ["TW"], title: "NVIDIA corrected results" })]);
  for (;;) { received.push(...page.articles); assert.equal(page.snapshotId, id); assert.equal(page.revision, revision); if (!page.hasMore) break; page = archive.search({ cursor: page.nextCursor, maxBytes: 8192, limit: 100 }); }
  assert.equal(received.length, total); assert.equal(new Set(received.map(article => article.id)).size, total);
  assert.ok(received.every(article => article.title !== "NVIDIA corrected results"));
  assert.equal(archive.search({ countries: ["TW"] }).total, 119);
});
test("cursor caduca explícitamente; persistencia de semana, poda y archivo corrupto conservado", () => {
  const root = mkdtempSync(join(tmpdir(), "ogid-archive-test-")); const file = join(root, "news.json"); let now = instant;
  const archive = new NewsArchive({ persistencePath: file, now: () => now, cursorTtlMs: 1000 }); archive.ingest([fixture(1), fixture(2)]);
  archive.recordContext({ meta: { lastRefreshAt: new Date(now).toISOString() }, countries: { TW: { score: 7, level: "Monitoring" } }, impact: { items: [] } });
  const first = archive.search({ limit: 1 }); now += 1001;
  assert.throws(() => archive.search({ cursor: first.nextCursor }), error => error.code === "CURSOR_EXPIRED");
  const restored = new NewsArchive({ persistencePath: file, now: () => now }); assert.equal(restored.records.size, 2); assert.equal(restored.getHistory({}).length, 1); assert.equal(restored.coverage({ from: "2026-09-29T12:00:00Z" }).partial, true);
  assert.throws(() => restored.search({ cursor: first.nextCursor }), error => error.code === "CURSOR_EXPIRED");
  now += 31 * 86400000; restored.prune(); assert.equal(restored.records.size, 0);
  writeFileSync(file, "broken"); assert.throws(() => new NewsArchive({ persistencePath: file }), error => error.code === "ARCHIVE_RECOVERY_FAILED"); assert.equal(readFileSync(file, "utf8"), "broken");
});

test("ventana de revisión distingue corrección nueva de publicación antigua y sondeos repetidos", () => {
  let now = instant - 86400000;
  const archive = new NewsArchive({ now: () => now });
  archive.ingest([fixture(1, { publishedAt: new Date(now).toISOString() })]);
  now = instant;
  const query = { symbols: ["NVDA"], from: "2026-10-06T09:00:00Z", to: "2026-10-06T12:00:00Z", timeField: "archiveChangedAt" };
  archive.ingest([fixture(1, { publishedAt: "2026-10-05T12:00:00.000Z" })]);
  assert.equal(archive.search(query).total, 0);
  archive.ingest([fixture(1, { title: "NVIDIA acquisition cancelled", publishedAt: "2026-10-05T12:00:00.000Z" })]);
  const corrected = archive.search(query);
  assert.equal(corrected.total, 1); assert.equal(corrected.articles[0].revision, 2);
  assert.equal(corrected.articles[0].publishedAt, "2026-10-05T12:00:00.000Z");
  assert.equal(corrected.articles[0].archiveChangedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(corrected.articles[0].contentRevision, 2);
});

test("otro sondeo, fuente o estado stale no convierte un artículo antiguo en una corrección material", () => {
  let now = instant - 86400000;
  const archive = new NewsArchive({ now: () => now });
  const article = fixture(1, { publishedAt: new Date(now).toISOString(), provenance: { fetchedAt: new Date(now).toISOString() } });
  archive.ingest([article]);
  now = instant;
  archive.ingest([{ ...article, provenance: { fetchedAt: new Date(now).toISOString() } }]);
  assert.equal(archive.search().articles[0].revision, 1);
  archive.ingest([{ ...article, provider: "newsapi", sourceId: "another", dataMode: "stale", provenance: { fetchedAt: new Date(now).toISOString() } }]);
  const item = archive.search().articles[0];
  assert.equal(item.contentRevision, 1);
  assert.equal(item.provenances.length, 2);
  assert.equal(archive.search({ timeField: "archiveChangedAt", from: "2026-10-06T09:00:00Z", to: "2026-10-06T12:00:00Z" }).total, 0);
});
test("GD/AMD/ARM/META como palabras no acreditan vínculo y las identidades ambiguas no se eligen", () => {
  for (const symbol of ["GD", "AMD"]) assert.equal(matchInstrument({ title: `A discussion of ${symbol.toLowerCase()} without a company` }, getInstrumentByCanonicalSymbol(symbol)), null);
  const base = { instrumentId: "fixture-arm", canonicalSymbol: "ARM", displayName: "Arm Holdings", aliases: [] };
  assert.equal(matchInstrument({ title: "An arm injury after a game" }, base), null);
  assert.equal(matchInstrument({ title: "The meta analysis of trials" }, { ...base, canonicalSymbol: "META", displayName: "Meta Platforms" }), null);
  assert.ok(matchInstrument({ title: "NASDAQ:AMD earnings" }, getInstrumentByCanonicalSymbol("AMD")));
  assert.ok(matchInstrument({ title: "General Dynamics earnings" }, getInstrumentByCanonicalSymbol("GD")));
  for (const [id, symbol, currency, exchange] of [["test-asml-us", "ASML", "USD", "Nasdaq"], ["test-asml-eu", "ASML.AS", "EUR", "Amsterdam"]]) registerInstrument({ instrumentId: id, canonicalSymbol: symbol, displayName: "ASML Holding", assetType: "equity", currency, exchange, timezone: "Europe/Amsterdam", providerSymbols: { yahoo: symbol }, country: "NL" });
  assert.equal(resolveReferences(["ASML"])[0].status, "ambiguous"); assert.equal(resolveReferences(["ASML"], { currency: "EUR" })[0].instrumentId, "test-asml-eu");
  assert.equal(resolveReferences(["DOES_NOT_EXIST"])[0].status, "unavailable");
  const archive = new NewsArchive({ now: () => instant }); assert.throws(() => archive.search({ symbols: ["ASML"] }), error => error.code === "UNRESOLVED_INSTRUMENT");
});
test("validación de fechas reales, ventanas, claves extra y lectura segura de vistas compuestas", () => {
  const operation = getOperation("news.search");
  for (const query of [{ from: "2026-02-30T00:00:00Z" }, { from: "2026-10-06" }, { from: "2026-10-06T12:00:00Z", to: "2026-10-05T12:00:00Z" }, { limit: "101" }, { force: "true" }, { constructor: "1" }, { toString: "1" }]) assert.throws(() => parseOperationQuery(query, operation));
  const output = publicProjection({ news: [fixture(1, { fullText: "SECRET", revision: 2, matchReasons: [{ evidence: "NVIDIA" }] })], awareness: { recent: [{ eventId: "e1", title: "Event", canonicalUrl: "https://example.org/event?token=SECRET", publishedAt: null, importance: "high" }] }, quotes: { NVDA: { price: null, changePct: 0, synthetic: true } }, admin: { token: "SECRET", historyDir: "/home/private", prompt: "SECRET" } });
  assert.ok(!JSON.stringify(output).includes("SECRET")); assert.equal(output.news[0].revision, 2); assert.equal(output.news[0].matchReasons[0].evidence, "NVIDIA"); assert.equal(output.awareness.recent[0].eventId, "e1"); assert.equal(output.quotes.NVDA.changePct, null);
});

test("una sola cotización ETF/ASML conocida no elige clase o bolsa por una referencia general", () => {
  const etf = { instrumentId: "verified-etf", canonicalSymbol: "VWCE.DE", displayName: "Vanguard FTSE All-World UCITS ETF", assetType: "etf", currency: "EUR", exchange: "Xetra", isin: "IE00BK5BQT80", aliases: [] };
  const name = "Vanguard FTSE All-World UCITS";
  assert.equal(resolveReferences([name], {}, [etf])[0].status, "ambiguous");
  assert.equal(resolveReferences([name], {}, [etf])[0].requiresSelection, true);
  for (const reference of ["verified-etf", "VWCE.DE"]) assert.equal(resolveReferences([reference], {}, [etf])[0].instrumentId, etf.instrumentId);
  assert.equal(resolveReferences([name], { isin: etf.isin }, [etf])[0].instrumentId, etf.instrumentId);
  const asml = { instrumentId: "verified-asml", canonicalSymbol: "ASML", displayName: "ASML Holding", assetType: "equity", currency: "USD", exchange: "Nasdaq", aliases: [] };
  assert.equal(resolveReferences(["ASML"], {}, [asml])[0].status, "ambiguous");
  assert.equal(resolveReferences(["ASML"], { currency: "USD" }, [asml])[0].instrumentId, asml.instrumentId);
});
test("alertas persistentes: consulta no entrega, repetición de feeds y revisiones materiales", () => {
  const root = mkdtempSync(join(tmpdir(), "ogid-alert-test-")); const file = join(root, "alerts.json"); const alerts = new MaterialAlertStore({ persistencePath: file, now: () => instant });
  const event = { eventId: "e1", title: "NVIDIA acquisition", summary: "Agreement announced", publishedAt: "2026-10-06T10:00:00Z", status: "released", importance: "high", revision: 1 };
  const initial = alerts.candidates([event, { ...event, eventId: "e2" }]); assert.equal(initial.length, 1); assert.equal(initial[0].evidenceIds.length, 2); assert.equal(initial[0].delivered, false);
  assert.equal(alerts.candidates([event]).length, 1);
  alerts.acknowledge({ candidateIds: [initial[0].candidateId], deliveredAt: "2026-10-06T12:00:00Z" });
  const restored = new MaterialAlertStore({ persistencePath: file, now: () => instant }); assert.equal(restored.candidates([event]).length, 0);
  assert.equal(restored.candidates([{ ...event, revision: 2 }]).length, 0);
  const correction = restored.candidates([{ ...event, eventId: "e2", title: "NVIDIA cancels acquisition", revision: 3, status: "cancelled", summary: "Agreement cancelled" }]); assert.equal(correction.length, 1); assert.equal(correction[0].correction, true);
  assert.throws(() => restored.acknowledge({ candidateIds: ["unknown"], deliveredAt: "2026-10-06T12:00:00Z" }), error => error.code === "UNKNOWN_ALERT_CANDIDATE");
});
