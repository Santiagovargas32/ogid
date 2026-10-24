import { calculateTechnicalIndicators, DEFAULT_INDICATOR_PARAMETERS, TECHNICAL_INDICATORS_METHOD_VERSION } from "./technicalIndicators.js";
import { getInstrumentById } from "./instrumentRegistry.js";
import { stableHash } from "../../utils/stableHash.js";
import { CALENDAR_VERSION } from "./exchangeCalendar.js";
import {resolveClosedSeries} from './closedSeries.js';
export class TechnicalIndicatorService {
  constructor({ store, now = () => new Date(), maxCacheEntries = 128, cacheTtlMs = 900000 } = {}) { Object.assign(this, { store, now, maxCacheEntries, cacheTtlMs }); this.cache = new Map(); }
  calculate({ instrumentId, interval = "1day", adjustmentMode = "splits", parameters = DEFAULT_INDICATOR_PARAMETERS, limit = 500 } = {}) {
    const now = this.now(),instrument=getInstrumentById(instrumentId);
    const resolved=instrument?resolveClosedSeries(this.store,{instrument,interval,adjustmentMode,limit,asOf:now.toISOString()}):null;
    const queried=resolved?.candles||this.store.query({ instrumentId, interval, adjustmentMode, limit });
    const candles = queried.filter(c => Date.parse(c.closeTime) <= now.getTime());
    const seriesRevision = stableHash([candles,resolved?.lineage,resolved?.quality]);
    const key = stableHash({ instrumentId, interval, adjustmentMode, limit, seriesRevision, parameters, instrument: getInstrumentById(instrumentId), calendar: CALENDAR_VERSION, method: TECHNICAL_INDICATORS_METHOD_VERSION });
    for (const [id, row] of this.cache) if (row.expiresAt <= now.getTime()) this.cache.delete(id);
    const cached = this.cache.get(key); if (cached) { this.cache.delete(key); this.cache.set(key,cached); return cached.result; }
    const result = { instrumentId, interval,currency:instrument?.currency||null, adjustmentMode, seriesRevision, calendarVersion: CALENDAR_VERSION, ...calculateTechnicalIndicators(candles, { interval, instrument, parameters, calculatedAt: now.toISOString() }) };
    if(resolved){result.seriesLineage=resolved.lineage;result.seriesCoverage=resolved.quality;}
    if(resolved?.quality.gapDetected){result.quality={...result.quality,reason:'unverified_series',gapDetected:true};for(const value of Object.values(result.indicators))Object.assign(value,{value:null,reason:'unverified_series'});}
    this.cache.set(key, { result, expiresAt: now.getTime() + this.cacheTtlMs });
    while(this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
}
