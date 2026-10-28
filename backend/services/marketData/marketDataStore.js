import { CANDLE_SCHEMA_VERSION, normalizeCanonicalCandle } from "../market/canonicalCandle.js";
import { DailyCandleStore } from "../market/dailyCandleStore.js";
import { getInstrumentByProviderSymbol } from "../market/instrumentRegistry.js";
import { normalizeYahooInstrument, normalizeYahooSymbol } from "./normalizer.js";
import {randomUUID} from 'node:crypto';
import {chartProvenance,assessClosedCandle} from '../market/candleValidation.js';

const CANONICAL_INTERVAL = Object.freeze({ "1d": "1day", "1h": "1h", "30m": "30min", "15m": "15min", "5m": "5min", "1wk": "1wk", "1mo": "1mo" });

function instant(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function closeTime(timestamp, interval) {
  const value = new Date(timestamp);
  if (interval === "5m") value.setUTCMinutes(value.getUTCMinutes() + 5);
  else if (interval === "15m") value.setUTCMinutes(value.getUTCMinutes() + 15);
  else if (interval === "30m") value.setUTCMinutes(value.getUTCMinutes() + 30);
  else if (interval === "1h") value.setUTCHours(value.getUTCHours() + 1);
  else if (interval === "1d") value.setUTCDate(value.getUTCDate() + 1);
  else if (interval === "1wk") value.setUTCDate(value.getUTCDate() + 7);
  else value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString();
}

function dynamicInstrument(symbol) {
  const known = getInstrumentByProviderSymbol("yahoo", symbol);
  if (known) return known;
  return normalizeYahooInstrument({ symbol, assetType: "unknown", timezone: "UTC" });
}

function equivalentBar(left, right) {
  return left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.volume === right.volume && left.source === right.source && left.providerAdjustedClose === right.providerAdjustedClose;
}

export class MarketDataStoreAdapter {
  constructor({ candleStore = null, now = () => new Date(), maxCacheEntries = 256, readThrough = true, persistAsync = false, onPersistenceError = () => {}, onPersisted = null } = {}) {
    this.candleStore = candleStore || new DailyCandleStore({ intervals: ["1day", "1h", "30min", "15min", "5min", "1wk", "1mo"] });
    this.now = now;
    this.maxCacheEntries = Math.max(1, Number(maxCacheEntries) || 256);
    this.cache = new Map();
    this.writeChains = new Map();
    Object.assign(this, {readThrough,persistAsync,onPersistenceError,onPersisted});
    this.pendingPersistence = new Set();
    this.persistenceChains = new Map();
    this.persistenceReceipts=new Map();
    this.pendingProjections=new Set();
    this.persistenceFailures=new Map();
    this.projectionOutcomes=new Map();
    this.projectionSequence=0;
    this.persistenceStatus = {completed:0,failed:0,lastError:null,lastCompletedAt:null};
  }

  hydrate() {
    return this.candleStore.hydrate();
  }

  cacheKey(symbol, interval, period, range = null) {
    const absoluteWindow = range?.explicit
      ? `|${instant(range.period1).toISOString()}|${instant(range.period2).toISOString()}`
      : "|rolling";
    return `${normalizeYahooSymbol(symbol)}|${interval}|${period}${absoluteWindow}`;
  }

  async upsertBars(bars = [], { symbol, period = "1y", interval = "1d", ttlMs, range = null, complete = true } = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol || bars[0]?.symbol);
    const key = this.cacheKey(normalizedSymbol, interval, period, range);
    const priorWrite = this.writeChains.get(key) || Promise.resolve();
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const tail = priorWrite.then(() => gate, () => gate);
    this.writeChains.set(key, tail);
    await priorWrite.catch(() => undefined);

    try {
      const previous = this.#cachedEntry(key);
      const byTimestamp = new Map((previous?.bars || []).map((bar) => [bar.timestamp, bar]));
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const bar of bars) {
        if (bar?.symbol !== normalizedSymbol || bar?.source !== "yahoo") continue;
        const existing = byTimestamp.get(bar.timestamp);
        if (!existing) inserted += 1;
        else if (equivalentBar(existing, bar)) unchanged += 1;
        else updated += 1;
        byTimestamp.set(bar.timestamp, bar);
      }
      const observationTime = instant(this.now());
      const refreshedAt = observationTime.toISOString();
      const merged = [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
      const boundedTtl = Math.max(1, Number(ttlMs) || 1);
      const storedAt = complete ? refreshedAt : previous?.storedAt || refreshedAt;
      const nextEntry = {
        bars: merged,
        storedAt,
        expiresAt: complete
          ? new Date(Date.parse(refreshedAt) + boundedTtl).toISOString()
          : previous?.expiresAt || refreshedAt,
        from: merged[0]?.timestamp || previous?.from || null,
        to: merged.at(-1)?.timestamp || previous?.to || null,
      };

      const incomingTimestamps = new Set(bars.map((bar) => bar?.timestamp).filter(Boolean));
      const candles = merged.filter((bar) => incomingTimestamps.has(bar.timestamp)).map((bar) => this.toCanonicalCandle(bar, interval)).filter(Boolean);
      const admission=this.persistAsync&&this.candleStore.persistDeferred?await this.candleStore.persistDeferred(candles,{now:observationTime}):null;
      const persist = async () => {
        const result = admission?await this.candleStore.waitForPersistence(admission):typeof this.candleStore.upsert === "function"
          ? await this.candleStore.upsert(candles, { now: observationTime })
          : await this.candleStore.append(candles, { now: observationTime });
        const scope=`${normalizedSymbol}|${interval}`,sequence=++this.projectionSequence;
        const outcome=this.projectionOutcomes.get(scope)||{pending:0,error:null};
        const projectionRequired=Boolean(outcome.error||outcome.pending);
        outcome.sequence=sequence;outcome.pending++;this.projectionOutcomes.set(scope,outcome);
        const projection=Promise.resolve().then(()=>this.onPersisted?.({candles,persistence:result,projectionRequired}));
        this.pendingProjections.add(projection);
        const settle=error=>{
          if(outcome.sequence===sequence)outcome.error=error;
        };
        projection.then(()=>settle(null),error=>{
          this.#reportFailure(error,{phase:'indicators',scope,commitId:admission?.commitId||null,jobIds:admission?.jobIds||[]});
          settle(error);
        }).finally(()=>{
          this.pendingProjections.delete(projection);outcome.pending--;
          if(!outcome.pending&&!outcome.error)this.projectionOutcomes.delete(scope);
        }).catch(()=>{});
        return result;
      };
      const persistence = this.persistAsync
        ? this.#persistLater(`${normalizedSymbol}|${interval}`,persist,candles.length,admission||{})
        : await persist();
      nextEntry.persistence=persistence;
      const relatedPrefix = `${normalizedSymbol}|${interval}|`;
      for (const cachedKey of this.cache.keys()) if (cachedKey.startsWith(relatedPrefix)) this.cache.delete(cachedKey);
      this.#setCachedEntry(key, nextEntry);
      return { inserted, updated, unchanged, persistence, bars: merged };
    } finally {
      releaseWrite();
      if (this.writeChains.get(key) === tail) this.writeChains.delete(key);
    }
  }

  getBars(options = {}) {
    const { symbol, period = "1y", interval = "1d", from = null, to = null, ttlMs = 1, limit = 10_000, range = null } = options;
    const normalizedSymbol=normalizeYahooSymbol(symbol),key=this.cacheKey(normalizedSymbol,interval,period,range);
    const finish = records => {
      let entry=this.#cachedEntry(key);
      if (!entry && records.length) {
        const bars=records.map(record=>this.fromCanonicalCandle(record,normalizedSymbol));
        const storedAt=records.map(record=>record.fetchedAt).filter(Boolean).sort().at(-1) || bars.at(-1).timestamp;
        entry={bars,storedAt,expiresAt:new Date(Date.parse(storedAt)+Math.max(1,Number(ttlMs)||1)).toISOString(),from:bars[0]?.timestamp || null,to:bars.at(-1)?.timestamp || null};this.#setCachedEntry(key,entry);
      }
      if(!entry)return {bars:[],cached:false,stale:true,storedAt:null,from:null,to:null};
      const fromMs=from?Date.parse(from):-Infinity,toMs=to?Date.parse(to):Infinity;
      const bars=entry.bars.filter(bar=>Date.parse(bar.timestamp)>=fromMs&&Date.parse(bar.timestamp)<=toMs).slice(-Math.max(1,Number(limit)||10000));
      return {bars,cached:true,stale:Date.parse(entry.expiresAt)<=instant(this.now()).getTime(),storedAt:entry.storedAt,from:bars[0]?.timestamp || null,to:bars.at(-1)?.timestamp || null,persistence:entry.persistence||null};
    };
    if(this.#cachedEntry(key) || !this.readThrough)return finish([]);
    const records=this.candleStore.query({instrumentId:dynamicInstrument(normalizedSymbol).instrumentId,interval:CANONICAL_INTERVAL[interval] || interval,adjustmentMode:"splits",from,to,limit});
    return records?.then ? records.then(finish) : finish(records);
  }

  toCanonicalCandle(bar, interval, {fetchedAt = instant(this.now()).toISOString()} = {}) {
    const instrument = dynamicInstrument(bar.symbol);
    const canonicalInterval = CANONICAL_INTERVAL[interval] || interval;
    const isDaily = canonicalInterval === "1day";
    const raw = {
      instrumentId: instrument.instrumentId,
      interval: canonicalInterval,
      ...(isDaily
        ? { date: String(bar.timestamp).slice(0, 10), datetime: bar.timestamp }
        : { openTime: bar.timestamp, closeTime: closeTime(bar.timestamp, interval) }),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source: "yahoo",
      providerSymbol: bar.symbol,
      dataMode: "observed",
      session: instrument.sessionPolicy,
    };
    if (["1day", "1h", "30min", "15min", "5min"].includes(canonicalInterval)) {
      let normalized = normalizeCanonicalCandle(raw, {
        instrument,
        fetchedAt,
        source: "yahoo",
        providerSymbol: bar.symbol,
        adjustmentMode: "splits",
      }).candle;
      if(normalized){
        const chart=chartProvenance(bar.chartMeta);
        if(chart)normalized={...normalized,provenance:{...normalized.provenance,chart}};
        const assessment=assessClosedCandle(normalized,instrument,this.now());
        normalized={...normalized,validation:assessment,...(!assessment.eligible?{quality:'partial',eligibilityReason:assessment.reason}:{})};
      }
      return normalized && bar.providerAdjustedClose != null ? {...normalized,providerAdjustedClose:bar.providerAdjustedClose,adjustmentQuality:{ohlcv:"provider-split-adjusted",separateAdjustedClose:"provider-adjusted-close; split/dividend basis not independently reconciled",totalReturnVerified:false}} : normalized;
    }
    return {
      schemaVersion: CANDLE_SCHEMA_VERSION,
      ...raw,
      currency: instrument.currency || null,
      exchange: instrument.exchange || null,
      fetchedAt,
      adjusted: true,
      quality: "valid",
      methodVersion: "market-data-chart-v1",
      provenance: { provider: "yahoo", providerSymbol: bar.symbol, adjustmentMode: "splits", fetchedAt },
    };
  }

  fromCanonicalCandle(candle, symbol = candle.providerSymbol) {
    const providerTimestamp = candle.provenance?.providerDatetime;
    const timestamp = instant(providerTimestamp || candle.openTime).toISOString();
    return {
      symbol: normalizeYahooSymbol(symbol),
      source: "yahoo",
      timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      ...(candle.providerAdjustedClose != null ? {providerAdjustedClose:candle.providerAdjustedClose}:{}),
    };
  }

  #persistLater(key, persist, requested, admission={}) {
    const prior = this.persistenceChains.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(persist),commitId=admission.commitId||randomUUID();
    const receipt={...admission,pending:true,commitId,requested,inserted:0,duplicates:0};
    this.persistenceReceipts.set(commitId,task);
    this.pendingPersistence.add(task);
    this.persistenceChains.set(key,task);
    task.then(result => {
      this.persistenceFailures.delete(commitId);
      Object.assign(receipt,result,{pending:false,committed:true});
      this.persistenceStatus.completed++;
      this.persistenceStatus.lastCompletedAt=new Date().toISOString();
    }, error => {
      Object.assign(receipt,{pending:false,committed:false,errorCode:error.code||'MARKET_PERSISTENCE_FAILED'});
      this.persistenceStatus.failed++;
      this.persistenceStatus.lastError=error.code || "MARKET_PERSISTENCE_FAILED";
      this.persistenceFailures.set(commitId,{receipt,persist,error});
      this.#reportFailure(error,{phase:'candles',scope:key,commitId,jobIds:admission.jobIds||[]});
    }).finally(() => {
      this.pendingPersistence.delete(task);
      if(this.persistenceChains.get(key)===task)this.persistenceChains.delete(key);
      for(const [id,value]of this.persistenceReceipts){if(this.persistenceReceipts.size<=256)break;if(!this.pendingPersistence.has(value))this.persistenceReceipts.delete(id);}
    }).catch(() => {});
    return receipt;
  }

  async waitForPersistence(receipt) {
    if(!receipt?.commitId)return receipt;
    const task=this.persistenceReceipts.get(receipt.commitId);
    if(task){try{return {...await task,pending:false,committed:true,commitId:receipt.commitId};}finally{this.persistenceReceipts.delete(receipt.commitId);}}
    if(receipt.committed)return receipt;
    if(receipt.durable&&receipt.jobIds&&this.candleStore.waitForPersistence)return this.candleStore.waitForPersistence(receipt);
    throw Object.assign(Error('Durable market ACK unavailable'),{code:receipt.errorCode||'MARKET_COMMIT_ACK_UNKNOWN'});
  }

  #reportFailure(error,correlation) {
    // Correlation only: no candles, provider payload or credentials in logs.
    error.persistenceCorrelation=correlation;
    this.onPersistenceError(error,correlation);
  }

  getPersistenceStatus() { return {...this.persistenceStatus,pending:this.pendingPersistence.size,projectionsPending:this.pendingProjections.size,
    unresolved:this.persistenceFailures.size+[...this.projectionOutcomes.values()].filter(v=>v.error).length,
    readThrough:this.readThrough,asynchronous:this.persistAsync}; }
  async flushPersistence() {
    const drain=async()=>{while(this.pendingPersistence.size||this.pendingProjections.size)await Promise.allSettled([...this.pendingPersistence,...this.pendingProjections]);};
    await drain();
    // The durable coordinator reads the job/cursor before any resumed write.
    // A recovered ACK clears only this admission, never another observation.
    for(const [id,failure]of this.persistenceFailures){
      if(!failure.receipt.durable)continue;
      try{
        const result=await failure.persist();
        Object.assign(failure.receipt,result,{pending:false,committed:true});
        this.persistenceFailures.delete(id);
      }catch(error){
        error.persistenceCorrelation ||= failure.error.persistenceCorrelation;
        failure.error=error;
      }
    }
    await drain();
    const failures=[...this.persistenceFailures.values()].map(v=>v.error)
      .concat([...this.projectionOutcomes.values()].filter(v=>v.error).map(v=>v.error));
    if(failures.length)throw Object.assign(new AggregateError(failures,'Market persistence remains unconfirmed'),{
      code:'MARKET_PERSISTENCE_UNCONFIRMED',persistenceFailures:failures.slice(0,20).map(e=>({code:e.code||'MARKET_PERSISTENCE_FAILED',...e.persistenceCorrelation})),
      failureCount:failures.length});
  }

  #cachedEntry(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  #setCachedEntry(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
  }
}
