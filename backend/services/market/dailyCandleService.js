import { adjacentTradingDay, tradingDay } from "./exchangeCalendar.js";
import { fetchDailyCandles } from "./marketProviderRouter.js";
import { getInstrumentById, resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";
import { resolveDailyCandleTimes } from "./canonicalCandle.js";

function dateInZone(now, timeZone) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now).map((part) => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) }; }
function previousUtcDate(now) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10); }
function previousWeekday(dateText) { const date = new Date(`${dateText}T12:00:00Z`); do { date.setUTCDate(date.getUTCDate() - 1); } while ([0, 6].includes(date.getUTCDay())); return date.toISOString().slice(0, 10); }

export function resolveExpectedClosedDailyCandle(instrument, now = new Date(), { equityDelayMinutes = 15, cryptoCloseDelayMinutes = 5 } = {}) {
  if (instrument.sessionPolicy === "24x7") {
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < cryptoCloseDelayMinutes) return null;
    return resolveDailyCandleTimes(previousUtcDate(now), instrument);
  }
  const local = dateInZone(now, instrument.timezone); const day = tradingDay(instrument, local.date);
  if (day.halfDayPending) return null;
  const expected = !day.closed && now.getTime() >= Date.parse(day.closeTime) + equityDelayMinutes * 60000 ? day : adjacentTradingDay(instrument, local.date, -1);
  return expected ? resolveDailyCandleTimes(expected.date, instrument) : null;
}

export class DailyCandleService {
  constructor({ store, marketConfig = {}, now = () => new Date(), fetchCandles = fetchDailyCandles } = {}) { this.fetchCandles=fetchCandles; this.store = store; this.marketConfig = marketConfig; this.now = now; this.inFlight = null; this.retryState = new Map(); }
  enabledInstruments() { return this.marketConfig.watchlistService?.selectedInstruments?.() || resolveVerifiedInstrumentReferences(this.marketConfig.tickers || []).instruments; }
  async runScheduled() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#runScheduled(); try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async #runScheduled() {
    if (this.store?.enabled === false) return { status: "disabled", requested: 0, inserted: 0, stale: [] };
    const now = this.now(); const adjustmentMode = this.marketConfig.dailyCandles?.adjustmentMode || "splits"; const due = [];
    const keys=new Map();let deferred=0;
    for (const instrument of this.enabledInstruments()) {
      const expected=resolveExpectedClosedDailyCandle(instrument,now,this.marketConfig.dailyCandles);
      if(!expected)continue;
      const key=`${instrument.instrumentId}|${expected.openTime}|${adjustmentMode}`;
      keys.set(key,{instrument,expected});
      if(await this.store.has(instrument.instrumentId,expected.openTime,adjustmentMode)){this.retryState.delete(key);continue;}
      if((this.retryState.get(key)?.nextEligibleAt || 0)>now.getTime()){deferred++;continue;}
      due.push(instrument);
    }
    for(const key of this.retryState.keys())if(!keys.has(key))this.retryState.delete(key);
    if (!due.length) return { status: deferred ? "backoff" : "up-to-date", requested: 0, inserted: 0, stale: [], deferred };
    let postponed=false;
    const postpone=()=>{
      if(postponed)return;postponed=true;
      for(const instrument of due){
        const [key]=[...keys].find(([,value])=>value.instrument===instrument);
        const attempts=(this.retryState.get(key)?.attempts || 0)+1;
        const delay=Math.min(this.marketConfig.dailyCandles?.retryMaxMs || 900000,(this.marketConfig.dailyCandles?.retryBaseMs || 30000)*2**Math.min(10,attempts-1));
        this.retryState.set(key,{attempts,nextEligibleAt:this.now().getTime()+delay});
      }
    };
    let result,persistence;
    try {
      result=await this.fetchCandles({ ...this.marketConfig, instrumentIds: due.map(instrument=>instrument.instrumentId), outputsize:2, adjustmentMode, trigger:"scheduled-daily-candles",timestamp:now.toISOString() });
      persistence=result.persistedByProvider?result.persistence:await this.store.append(result.candles,{now});
      postpone();
      for(const [key,{instrument,expected}] of keys)if(await this.store.has(instrument.instrumentId,expected.openTime,adjustmentMode))this.retryState.delete(key);
    }catch(error){postpone();throw error;}
    return { status:result.creditRejections.length?"postponed-quota":result.errors.length || this.retryState.size?"partial":"ok", requested:due.length,...persistence,errors:result.errors,creditRejections:result.creditRejections,
      retries:[...this.retryState].map(([scope,state])=>({scope,...state})),
      stale:(await Promise.all(due.filter(instrument=>[...this.retryState.keys()].some(key=>key.startsWith(instrument.instrumentId+"|"))).map(instrument=>this.store.latest(instrument.instrumentId)))).filter(Boolean).map(candle=>({...candle,dataMode:"stale",quality:"stale-if-error",provenance:{...candle.provenance,stale:true}})) };
  }

  async backfill({ instrumentIds = [], days = 30, adjustmentMode = null } = {}) {
    if (this.store?.enabled === false) return { requested: 0, days: 0, inserted: 0, errors: [{ code: "daily-candles-disabled" }], creditRejections: [] };
    const maxDays = this.marketConfig.dailyCandles?.backfillMaxDays || 30; const boundedDays = Math.min(maxDays, Math.max(1, Number(days) || 1));
    const allowed = new Set(this.enabledInstruments().map((instrument) => instrument.instrumentId)); const resolved = [...new Set(instrumentIds)].map(getInstrumentById).filter((instrument) => instrument?.verificationStatus === "verified" && allowed.has(instrument.instrumentId));
    const now = this.now(); const result = await fetchDailyCandles({ ...this.marketConfig, instrumentIds: resolved.map((instrument) => instrument.instrumentId), outputsize: boundedDays + 2, adjustmentMode: adjustmentMode || this.marketConfig.dailyCandles?.adjustmentMode || "splits", trigger: "daily-backfill", timestamp: now.toISOString() });
    const persistence = result.persistedByProvider ? result.persistence : await this.store.append(result.candles, { now }); return { requested: resolved.length, days: boundedDays, ...persistence, errors: result.errors, creditRejections: result.creditRejections };
  }
  query(options) { return this.store.query(options); }
}
