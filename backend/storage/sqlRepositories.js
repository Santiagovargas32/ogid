import { randomBytes } from "node:crypto";
import { EventLedger } from "../services/research/eventLedger.js";
import { MaterialAlertStore } from "../services/research/materialAlertStore.js";
import { storeIdentity, sameMarketValues, revise, mergeStoredSession } from "../services/market/dailyCandleStore.js";
import { AppError } from "../utils/error.js";
import { getInstrumentById, listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";

export function readMeta(db, key, fallback) {
  const row = db.prepare("SELECT value_json FROM runtime_meta WHERE key=?").get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}
export function writeMeta(db, key, value) { db.prepare("INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(value)); }
export function instrumentRow(db, instrumentId, candle = {}) {
  const i = getInstrumentById(instrumentId) || { instrumentId, canonicalSymbol: candle.providerSymbol || instrumentId, assetType: "unknown", currency: candle.currency || null, timezone: candle.calendar?.timezone || "UTC" };
  db.prepare("INSERT INTO instruments VALUES(?,?,?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET symbol=excluded.symbol,asset_type=excluded.asset_type,currency=excluded.currency,timezone=excluded.timezone,metadata_json=excluded.metadata_json").run(instrumentId, i.canonicalSymbol || i.symbol || instrumentId, i.assetType || "unknown", i.currency || null, i.timezone || "UTC", JSON.stringify(i));
}
export function sourceRow(db, id, payload = {}) {
  db.prepare("INSERT INTO sources VALUES(?,?,?,?) ON CONFLICT(source_id) DO NOTHING").run(id, payload.publisher || payload.provider || id, payload.admissionState || "admitted", JSON.stringify(payload));
}

// Domain algorithms see synchronous objects inside the worker. Only accessed rows
// are materialized, and a transaction writes only rows whose contents changed.
export class SqlResearchStore {
  constructor(db) { this.db = db; this.state = this.makeState(); }
  makeState(cache = null) {
    const state = { schemaVersion: "research-ledger-v1", revision: readMeta(this.db, "research.revision", 0) };
    Object.defineProperty(state,"revision",{ enumerable:true,get:()=>readMeta(this.db,"research.revision",0) });
    for (const collection of ["events", "jobs", "holdings", "companyFacts", "sourceStates", "forecasts"]) {
      const rows = cache && new Map(); if (cache) cache.set(collection, rows);
      const read = id => {
        if (rows?.has(id)) return rows.get(id).value;
        const row = this.db.prepare("SELECT payload_json FROM research_rows WHERE collection=? AND entity_id=?").get(collection, id);
        const value = row ? JSON.parse(row.payload_json) : undefined;
        rows?.set(id, { before: row?.payload_json, value }); return value;
      };
      state[collection] = new Proxy(Object.create(null), {
        get: (_target, id) => typeof id === "string" ? read(id) : undefined,
        set: (_target, id, value) => { if (!rows) throw new Error("Write outside research transaction"); read(id); rows.get(id).value = value; return true; },
        deleteProperty: (_target, id) => { if (!rows) throw new Error("Write outside research transaction"); read(id); rows.get(id).value = undefined; return true; },
        ownKeys: () => [...new Set([...this.db.prepare("SELECT entity_id FROM research_rows WHERE collection=?").all(collection).map(r => r.entity_id), ...(rows ? [...rows.keys()].filter(id => rows.get(id).value !== undefined) : [])])].filter(id => read(id) !== undefined),
        getOwnPropertyDescriptor: (_target, id) => read(id) === undefined ? undefined : { enumerable: true, configurable: true },
        has: (_target, id) => read(id) !== undefined
      });
    }
    return state;
  }
  transact(fn) {
    return this.db.transaction(() => {
      const cache = new Map(), next = this.makeState(cache), result = fn(next);
      if (result?.then) throw new Error("SQL domain transactions must be synchronous");
      for (const [collection, rows] of cache) for (const [id, row] of rows) {
        const encoded = row.value === undefined ? undefined : JSON.stringify(row.value);
        if (encoded === row.before) continue;
        if (encoded === undefined) this.db.prepare("DELETE FROM research_rows WHERE collection=? AND entity_id=?").run(collection,id);
        else {
          this.db.prepare("INSERT INTO research_rows VALUES(?,?,?) ON CONFLICT(collection,entity_id) DO UPDATE SET payload_json=excluded.payload_json").run(collection,id,encoded);
          this.project(collection, id, row.value);
        }
      }
      writeMeta(this.db, "research.revision", next.revision + 1);

      return structuredClone(result ?? null);
    }).immediate();
  }
  project(collection, id, row) {
    if (collection === "events") {
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET identity_version=excluded.identity_version,revision=excluded.revision,published_at=excluded.published_at,observed_at=excluded.observed_at,status=excluded.status,payload_json=excluded.payload_json").run(id,null,row.identityVersion || "legacy",row.revision || 1,row.publishedAt || null,row.updatedAt || row.receivedAt || new Date().toISOString(),row.claimStatus || "unknown",JSON.stringify(row));
      this.db.prepare("INSERT OR IGNORE INTO event_revisions VALUES(?,?,?,?)").run(id,row.revision || 1,row.updatedAt || new Date().toISOString(),JSON.stringify(row));
      this.db.prepare("DELETE FROM event_instruments WHERE event_id=?").run(id);
      for(const impact of new EventLedger({store:this}).impact(row,listVerifiedInstruments())){instrumentRow(this.db,impact.instrumentId);this.db.prepare("INSERT INTO event_instruments VALUES(?,?,?)").run(id,impact.instrumentId,JSON.stringify(impact));}
      for (const e of row.evidence || []) {
        const sid = e.sourceId || "unknown"; sourceRow(this.db,sid,e);
        this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?) ON CONFLICT(evidence_id) DO UPDATE SET payload_json=excluded.payload_json,available_at=excluded.available_at").run(e.id,id,null,sid,e.receivedAt || new Date().toISOString(),JSON.stringify(e));
      }
    } else if (collection === "sourceStates") {
      sourceRow(this.db,id);
      this.db.prepare("INSERT INTO source_states VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET updated_at=excluded.updated_at,state_json=excluded.state_json").run(id,new Date().toISOString(),JSON.stringify(row));
    } else if (collection === "jobs") {
      if(row.kind === "csv-import" && row.metadata)this.db.prepare("INSERT INTO market_datasets VALUES(?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET source=excluded.source,adjustment_mode=excluded.adjustment_mode,metadata_json=excluded.metadata_json").run(row.datasetId,row.metadata.source,row.metadata.adjustmentMode,JSON.stringify(row.metadata));
      this.db.prepare("INSERT INTO acquisition_jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,job_json=excluded.job_json").run(id,id,row.kind || "history",row.status || "pending",row.createdAt,new Date().toISOString(),JSON.stringify(row));
    }
  }
  view(table) { return Object.fromEntries(Object.entries(this.state[table])); }
  getRow(table,id) { const row=this.db.prepare("SELECT payload_json FROM research_rows WHERE collection=? AND entity_id=?").get(table,id);return row?JSON.parse(row.payload_json):null; }
}

export class SqlCandleStore {
  constructor(db, { datasetId = "provider-yahoo", rootDir, enabled = true } = {}) {
    Object.assign(this,{ db,datasetId,rootDir,enabled });
    this.db.prepare("INSERT OR IGNORE INTO market_datasets VALUES(?,?,?,?)").run(datasetId,"provider-observed","mixed", "{}");
  }
  hydrate() { return 0; }
  key(c) { return [c.instrumentId,c.interval,c.provenance?.adjustmentMode || (c.adjusted ? "splits" : "none"),this.datasetId,storeIdentity(c)]; }
  has(instrumentId, openTime, adjustmentMode = "splits") { return this.hasCandle(instrumentId,"1day",openTime,adjustmentMode); }
  hasCandle(instrumentId, interval, openTime, adjustmentMode = "splits") {
    return Boolean(this.db.prepare("SELECT 1 FROM candles WHERE instrument_id=? AND interval=? AND adjustment_mode=? AND dataset_id=? AND session_key=?").get(instrumentId,interval,adjustmentMode,this.datasetId,storeIdentity({instrumentId,interval,openTime})));
  }
  append(values, options) { return this.write(values,options,false); }
  upsert(values, options) { return this.write(values,options,true); }
  write(values = [], { now = new Date(), importing = false } = {}, update) {
    now = new Date(now);
    const counts = { inserted:0, ...(update ? {updated:0} : {}), duplicates:0,rejectedOpen:0 };
    if (!this.enabled) { counts.duplicates=values.length; return counts; }
    return this.db.transaction(() => {
      for (const raw of values) {
        if (Date.parse(raw.closeTime)>now.getTime()) { counts.rejectedOpen++; continue; }
        let c = sanitizeSensitiveData(raw); const key=this.key(c);
        const previousRow=this.db.prepare("SELECT payload_json FROM candles WHERE instrument_id=? AND interval=? AND adjustment_mode=? AND dataset_id=? AND session_key=?").get(...key);
        const previous=previousRow ? JSON.parse(previousRow.payload_json) : null;
        if (previous && (!update || sameMarketValues(previous,c))) { counts.duplicates++; continue; }
        if (previous) { c=importing ? mergeStoredSession(previous,c) : revise(previous,c); counts.updated++; } else counts.inserted++;
        instrumentRow(this.db,c.instrumentId,c);
        this.db.prepare("INSERT INTO candles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instrument_id,interval,adjustment_mode,dataset_id,session_key) DO UPDATE SET open_time=excluded.open_time,close_time=excluded.close_time,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,revision=excluded.revision,fetched_at=excluded.fetched_at,provenance_json=excluded.provenance_json,payload_json=excluded.payload_json").run(...key,c.openTime,c.closeTime,c.open,c.high,c.low,c.close,c.volume ?? null,c.revision || 1,c.fetchedAt || now.toISOString(),JSON.stringify(c.provenance || {}),JSON.stringify(c));
        this.db.prepare("INSERT OR IGNORE INTO candle_revisions VALUES(?,?,?,?,?,?,?,?)").run(...key,c.revision || 1,c.fetchedAt || now.toISOString(),JSON.stringify(c));
      }
      return counts;
    }).immediate();
  }
  query({instrumentId,interval="1day",adjustmentMode="splits",from=null,to=null,limit=100}={}) {
    const predicates=["instrument_id=?","interval=?","adjustment_mode=?","dataset_id=?"], args=[instrumentId,interval,adjustmentMode,this.datasetId];
    if(from){predicates.push("open_time>=?");args.push(new Date(from).toISOString());} if(to){predicates.push("open_time<=?");args.push(new Date(to).toISOString());}
    return this.db.prepare(`SELECT payload_json FROM candles WHERE ${predicates.join(" AND ")} ORDER BY open_time DESC LIMIT ?`).all(...args,Math.min(10000,Math.max(1,Number(limit)||100))).reverse().map(r=>JSON.parse(r.payload_json));
  }
  latest(instrumentId,adjustmentMode="splits",interval="1day") { return this.query({instrumentId,interval,adjustmentMode,limit:1}).at(-1)||null; }
}

export class SqlAlertStore extends MaterialAlertStore {
  constructor(db) {
    super(); this.db=db;
    this.observed=new Map(this.rows("observed"));this.acknowledged=new Map(this.rows("acknowledged"));
    const meta=readMeta(db,"alerts.meta",{sequence:0,retainedAfter:0,cursorKey:randomBytes(32).toString("base64url")});
    this.research={...meta,scenarios:Object.fromEntries(this.rows("scenarios")),signals:Object.fromEntries(this.rows("signals")),consumers:Object.fromEntries(this.rows("consumers")),changes:db.prepare("SELECT payload_json FROM signal_changes ORDER BY sequence").all().map(r=>JSON.parse(r.payload_json))};
    this.persisted=new Map();for(const r of db.prepare("SELECT * FROM alert_rows").all())this.persisted.set(`${r.collection}|${r.entity_id}`,r.payload_json);
  }
  rows(collection) { return this.db.prepare("SELECT entity_id,payload_json FROM alert_rows WHERE collection=?").all(collection).map(r=>[r.entity_id,JSON.parse(r.payload_json)]); }
  persist() {
    if(!this.db) return;
    this.prune(); const next=new Map();
    this.db.transaction(()=>{
      for(const [collection,entries] of [["observed",this.observed],["acknowledged",this.acknowledged],...["scenarios","signals","consumers"].map(k=>[k,Object.entries(this.research[k])])]) for(const [id,value] of entries){
        const encoded=JSON.stringify(value),key=`${collection}|${id}`;next.set(key,encoded);
        if(this.persisted.get(key)!==encoded)this.db.prepare("INSERT INTO alert_rows VALUES(?,?,?) ON CONFLICT(collection,entity_id) DO UPDATE SET payload_json=excluded.payload_json").run(collection,id,encoded);
      }
      for(const key of this.persisted.keys())if(!next.has(key)){const i=key.indexOf("|");this.db.prepare("DELETE FROM alert_rows WHERE collection=? AND entity_id=?").run(key.slice(0,i),key.slice(i+1));}
      for(const c of this.research.changes){
        this.db.prepare("INSERT OR IGNORE INTO signal_changes VALUES(?,?,?)").run(c.sequence,c.generatedAt,JSON.stringify(c));
        this.db.prepare("INSERT OR IGNORE INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json) VALUES(?,?,?,?,?,?)").run(c.changeId,c.kind,c.entityId,c.revision || 1,c.observedAt || c.generatedAt,JSON.stringify(c));
      }
      for(const [consumerId,row]of Object.entries(this.research.consumers))this.db.prepare("INSERT INTO consumer_checkpoints VALUES(?,?,?) ON CONFLICT(consumer_id) DO UPDATE SET sequence=excluded.sequence,acknowledged_at=excluded.acknowledged_at").run(consumerId,row.sequence,row.acknowledgedAt || new Date(this.now()).toISOString());
      this.db.prepare("DELETE FROM signal_changes WHERE sequence<=?").run(this.research.retainedAfter);
      writeMeta(this.db,"alerts.meta",Object.fromEntries(["sequence","retainedAfter","cursorKey"].map(k=>[k,this.research[k]])));
    }).immediate();this.persisted=next;
  }
}

export class SqlEventLedger extends EventLedger {
  constructor(options) { super(options); }
  search({instrumentIds=[],eventIds=[],from,to,limit=20}={}) {
    const db=this.store.db;
    if(instrumentIds.some(id=>!listVerifiedInstruments().some(i=>i.instrumentId===id)))throw new AppError("Instrumento no resuelto.",400,"UNRESOLVED_INSTRUMENT");
    const predicates=[],args=[];
    for(const [values,column]of [[eventIds,"event_id"],[instrumentIds,"instrument_id"]])if(values.length){predicates.push(column==="event_id"?`event_id IN (${values.map(()=>"?").join(",")})`:`event_id IN (SELECT event_id FROM event_instruments WHERE instrument_id IN (${values.map(()=>"?").join(",")}))`);args.push(...values);}
    if(from){predicates.push("observed_at>=?");args.push(from);}if(to){predicates.push("observed_at<=?");args.push(to);}
    const where=predicates.length?`WHERE ${predicates.join(" AND ")}`:"",total=db.prepare(`SELECT count(*) AS n FROM events ${where}`).get(...args).n;
    const rows=db.prepare(`SELECT payload_json FROM events ${where} ORDER BY observed_at DESC,event_id LIMIT ?`).all(...args,limit);
    const events=rows.map(row=>{
      const e=JSON.parse(row.payload_json),verified=e.identityVersion==="source-publication-v2"&&e.quality?.identityVerified!==false;
      let impacts=db.prepare("SELECT instrument_id,impact_json FROM event_instruments WHERE event_id=? ORDER BY instrument_id").all(e.eventId).filter(r=>!instrumentIds.length||instrumentIds.includes(r.instrument_id)).map(r=>JSON.parse(r.impact_json));
      // Preserve registry order for impact consumers.
      const order=listVerifiedInstruments().map(i=>i.instrumentId);impacts.sort((a,b)=>order.indexOf(a.instrumentId)-order.indexOf(b.instrumentId));
      return {...e,quality:{...e.quality,identityVerified:verified,...(!verified?{identityReason:e.identityVersion!=="source-publication-v2"?"legacy_identity_requires_replay":"publication_identity_insufficient"}:{})},impacts};
    });
    const coverage=db.prepare("SELECT count(*) AS storedEvents,sum(identity_version!='source-publication-v2') AS legacyRequiresReplay FROM events").get();
    return {events,total,hasMore:total>limit,asOf:new Date(this.now()).toISOString(),snapshotId:`events-${this.store.state.revision}`,methodVersion:"event-ledger-v2",coverage:{...coverage,legacyRequiresReplay:coverage.legacyRequiresReplay || 0,continuity:"not-guaranteed",revisionHistoryLimit:20,evidenceLimit:50},warnings:["Legacy URL-based event IDs require replay from original sources; excluded from impacts, preserved for audit.","Republished wires are one origin; unknown provenance cannot establish corroboration.","A topic or named company does not establish benefit, contract award or price causality."]};
  }
}
