import { calculateTechnicalIndicators, DEFAULT_INDICATOR_PARAMETERS, TECHNICAL_INDICATORS_METHOD_VERSION } from "./technicalIndicators.js";

export class TechnicalIndicatorService {
  constructor({ store, now = () => new Date() } = {}) { this.store = store; this.now = now; this.cache = new Map(); }
  /** @param {{instrumentId:string, interval?:string, adjustmentMode?:"splits"|"none", parameters?:object, limit?:number}} request */
  calculate({ instrumentId, interval = "1day", adjustmentMode = "splits", parameters = DEFAULT_INDICATOR_PARAMETERS, limit = 500 } = {}) {
    const candles = this.store.query({ instrumentId, interval, adjustmentMode, limit }); const latest = candles.at(-1); const key = JSON.stringify([instrumentId, interval, adjustmentMode, latest?.openTime || null, parameters, TECHNICAL_INDICATORS_METHOD_VERSION]);
    if (this.cache.has(key)) return this.cache.get(key);
    const result = { instrumentId, interval, adjustmentMode, ...calculateTechnicalIndicators(candles, { interval, parameters, calculatedAt: this.now().toISOString() }) }; this.cache.set(key, result); return result;
  }
}
