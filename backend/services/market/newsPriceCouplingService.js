import { getInstrumentById } from "./instrumentRegistry.js";
import { calculateNewsPriceCouplingV2, DEFAULT_COUPLING_PARAMETERS } from "./newsPriceCoupling.js";

export class NewsPriceCouplingService {
  constructor({ store, now = () => new Date() } = {}) { this.store = store; this.now = now; }
  calculate({ articles = [], links = [], benchmarkInstrumentId = null, parameters = {}, asOf = this.now().toISOString() } = {}) {
    const params = { ...DEFAULT_COUPLING_PARAMETERS, ...parameters }; const benchmarkInstrument = benchmarkInstrumentId ? getInstrumentById(benchmarkInstrumentId) : null; const benchmarkCandles = benchmarkInstrument ? this.store.query({ instrumentId: benchmarkInstrument.instrumentId, interval: params.interval, adjustmentMode: params.adjustmentMode, limit: 500 }) : [];
    return links.map(({ newsId, instrumentId }) => { const news = articles.find((article) => article.id === newsId); const instrument = getInstrumentById(instrumentId); if (!news || !instrument || instrument.verificationStatus !== "verified") return null; const related = links.filter((link) => link.instrumentId === instrumentId).map((link) => articles.find((article) => article.id === link.newsId)).filter(Boolean); const candles = this.store.query({ instrumentId, interval: params.interval, adjustmentMode: params.adjustmentMode, limit: 500 }); return calculateNewsPriceCouplingV2({ news, instrument, candles, benchmarkInstrument, benchmarkCandles, competingNews: related, parameters: params, asOf }); }).filter(Boolean);
  }
}
