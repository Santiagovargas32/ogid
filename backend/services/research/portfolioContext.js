import { AppError } from "../../utils/error.js";
import { publicProjection } from "../../utils/researchProjection.js";
import { listVerifiedInstruments } from "../market/instrumentRegistry.js";
import { computeMarketImpact } from "../market/impactEngineService.js";
import { instrumentView, resolveReferences } from "./instrumentIdentity.js";

const MATERIAL_HIGH = /\b(?:bankrupt(?:cy)?|insolven(?:cy|t)|restatement|trading halt|fraud|acquisition|merger|earnings warning|profit warning|export ban|quiebra|fraude|fusi[oó]n)\b/i;
const MATERIAL_MEDIUM = /\b(?:earnings|guidance|results|regulatory|sanctions|lawsuit|recall|dividend|contract award|resultados|sanciones|demanda|dividendo)\b/i;
export class PortfolioContextService {
  constructor({ stateManager, archive, alerts, awarenessService, watchlist, scenarioService=null, now = Date.now } = {}) { Object.assign(this, { stateManager, archive, alerts, awarenessService, watchlist, scenarioService, now }); }
  getContext(input) {
    const now = this.now(); const mode = input.mode;
    const window = { from: input.from || new Date(now - (mode === "weekly" ? 7 * 86400000 : mode === "material" ? 3 * 3600000 : mode === "agenda" ? 0 : 86400000)).toISOString(),
      to: input.to || new Date(now + (mode === "agenda" ? 7 * 86400000 : 0)).toISOString() };
    const snapshot = this.stateManager.getSnapshot(); const universe = listVerifiedInstruments();
    const references = [...(input.symbols || []), ...(input.instrumentIds || [])];
    const resolutions = resolveReferences(references.length ? references : this.watchlist.selectedInstrumentIds, {}, universe);
    if (resolutions.some(row => row.status !== "resolved")) throw new AppError("El universo contiene identidades inexistentes o ambiguas; resolver y elegir antes de consultar.", 400, "UNRESOLVED_INSTRUMENT");
    const instruments = resolutions.map(row => universe.find(instrument => instrument.instrumentId === row.instrumentId));
    const ids = instruments.map(instrument => instrument.instrumentId);
    const newsWindow = mode === "agenda" ? { from: new Date(now - 86400000).toISOString(), to: new Date(now).toISOString() } : window;
    // Sin universo no se transforma la consulta en una cartera global inventada.
    const news = this.archive.search({ ...newsWindow, ...(mode === "material" ? { timeField: "archiveChangedAt" } : {}), ...(ids.length ? { instrumentIds: ids } : {}), ...(input.countries?.length ? { countries: input.countries } : {}), limit: input.limit || 20, maxBytes: 65536 });
    const events = this.awarenessService.getSnapshot({ ...window, countries: input.countries || [], limit: 100 }, { publicView: true });
    const eventsLimited = events.upcoming.length >= 100 || events.recent.length >= 100;
    const relevant = event => !event.instrumentIds?.length || event.instrumentIds.some(id => ids.includes(id));
    events.upcoming = events.upcoming.filter(relevant).slice(0, input.limit || 20); events.recent = events.recent.filter(relevant).slice(0, input.limit || 20);
    const market = instruments.map(instrument => {
      const raw = snapshot.market?.quotes?.[instrument.canonicalSymbol]; const usable = raw?.price != null && !raw.synthetic && !["synthetic", "fallback"].includes(raw.dataMode);
      return { instrumentId: instrument.instrumentId, symbol: instrument.canonicalSymbol, exchange: instrument.exchange, currency: instrument.currency,
        quote: raw ? publicProjection({ ...raw, changePct: usable ? raw.changePct ?? null : null }) : null, usable, missingReason: usable ? null : "no-usable-stored-price" };
    });
    const impact = instruments.length ? computeMarketImpact({ articles: news.articles, countries: snapshot.countries || {}, marketQuotes: snapshot.market?.quotes || {}, tickers: instruments.map(instrument => instrument.canonicalSymbol), instruments, windowMin: mode === "weekly" ? 10080 : 1440 }) : { items: [] };
    const history = mode === "weekly" ? this.archive.getHistory(window).map(row => ({ ...row, impacts: row.impacts.filter(item => instruments.some(instrument => instrument.canonicalSymbol === item.ticker)) })) : [];
    const warnings = [...news.warnings, "OGID es una fuente complementaria: confirmar hechos y calendarios con fuentes oficiales y contexto externo.", "Scores internos no son probabilidades financieras; vínculo noticia-precio no demuestra causalidad.", "Resúmenes y explicaciones de IA no son corroboración independiente."];
    if (!ids.length) warnings.push("No hay universo seleccionado; las noticias generales no se presentan como exposición de cartera.");
    if (events.mode !== "visible") warnings.push(`Awareness ${events.mode}: eventos ocultos; vacío no significa ausencia de eventos.`);
    if (mode === "weekly" && (!history.length || Date.parse(history[0].observedAt) > Date.parse(window.from))) warnings.push("El historial de riesgos/impactos no cubre toda la semana; los riesgos actuales no representan su evolución pasada.");
    const candidates = [];
    if (mode === "material") {
      for (const article of news.articles) {
        if (!ids.length || article.synthetic || ["synthetic", "fallback"].includes(article.dataMode)) continue;
        // Una noticia antigua recién importada no es un hecho nuevo. Una revisión sí puede serlo.
        if (article.publishedAt && Date.parse(article.publishedAt) < Date.parse(window.from) && (article.contentRevision || 1) <= 1) continue;
        const text = `${article.title} ${article.excerpt || ""}`; const match = text.match(MATERIAL_HIGH) || (input.minImportance !== "high" ? text.match(MATERIAL_MEDIUM) : null);
        if (!match) continue;
        if (!input.includeUncorroborated) continue;
        candidates.push({ ...article, materiality: { band: MATERIAL_HIGH.test(text) ? "high" : "medium", method: "material-keywords-v1", evidence: match[0], confidence: "candidate-requires-external-confirmation" } });
      }
      for (const event of [...events.upcoming, ...events.recent]) {
        if (!ids.length || !(input.minImportance === "high" ? event.importance === "high" : ["medium", "high"].includes(event.importance)) || event.dataMode === "synthetic" || event.provenance?.synthetic || (event.source?.official !== true && !input.includeUncorroborated)) continue;
        candidates.push({ ...event, materiality: { band: event.importance, method: event.importanceMethod || "OGID-event-importance", evidence: event.eventId, confidence: event.source?.official ? "official-source-not-portfolio-materiality-proof" : "requires-corroboration" } });
      }
    }
    return publicProjection({ mode, queriedAt: new Date(now).toISOString(), window, newsWindow, sourceMode: snapshot.meta?.sourceMode || null, dataQuality: snapshot.meta?.dataQuality || {},
      health: { lastRefreshAt: snapshot.meta?.lastRefreshAt || null, marketUpdatedAt: snapshot.market?.updatedAt || null, newsCoverage: news.coverage },
      universe: instruments.map(instrument => instrumentView(instrument, this.watchlist.selectedInstrumentIds, snapshot.market?.quotes || {})), resolutions, news, awareness: events, market,
      risks: { dataAsOf: snapshot.meta?.lastRefreshAt || null, countries: input.countries?.length ? Object.fromEntries(Object.entries(snapshot.countries || {}).filter(([iso]) => input.countries.includes(iso))) : snapshot.countries || {}, temporalScope: "current-snapshot" },
      scenarioSummary: this.scenarioService ? (()=>{const result=this.scenarioService.list({instrumentIds:ids,limit:input.limit||20});return {snapshotId:result.snapshotId,latestSequence:result.latestSequence,hasMore:result.hasMore,scenarios:result.scenarios.map(s=>({scenarioId:s.scenarioId,instrumentId:s.instrumentId,role:s.role,status:s.status,revision:s.revision,expiresAt:s.expiresAt,seriesRevision:s.context.seriesRevision,quality:s.quality})),deliveryVerified:false};})() : null,
      impact: { ...impact, evidenceWindow: newsWindow, methodCaveat: "heuristic-association-not-causality" }, history, material: { candidates: mode === "material" ? this.alerts.candidates(candidates) : [], deliveryAcknowledged: false,
        policy: { minImportance: input.minImportance || "medium", includeUncorroborated: input.includeUncorroborated || false, methodVersion: "material-v1" }, partial: news.hasMore || eventsLimited || events.upcoming.length >= (input.limit || 20) || events.recent.length >= (input.limit || 20),
        acknowledgementOperation: "operator-only; acknowledge after actual delivery" }, warnings });
  }
}
