import Database from "better-sqlite3";
import { cacheStatements } from "./statementCache.js";
import { randomUUID } from "node:crypto";
import { NewsArchive } from "../services/research/newsArchive.js";
import { AppError } from "../utils/error.js";
import { normalizeNewsFilters } from "../utils/stableHash.js";
import { createHash } from "node:crypto";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { matchInstrument, resolveReferences } from "../services/research/instrumentIdentity.js";
import { readMeta, writeMeta, instrumentRow, sourceRow } from "./sqlRepositories.js";
import { normalizeArticles } from "../services/normalizeService.js";
import { classifyFinancialArticle, scoreFinancialImportance } from "../services/news/financialNewsService.js";
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const wireSize=data=>{const p={ok:true,queriedAt:new Date().toISOString(),origin:"OGID",data,warnings:data.warnings,truncated:false};return Buffer.byteLength(JSON.stringify({structuredContent:p,content:[{type:"text",text:JSON.stringify(p)}]}));};

export class SqlNewsArchive extends NewsArchive {
  constructor(db, options={}) {
    super({...options,persistencePath:null}); this.db=db;this.analysisOnly=options.analysisOnly === true;
    this.reader=new Database(db.name,{readonly:true});this.reader.pragma("query_only=ON");cacheStatements(this.reader);
    Object.assign(this,readMeta(db,"news.meta",{})); this.recoveryStatus=db.prepare("SELECT 1 FROM articles LIMIT 1").get()?"restored":"new";
    this.records={get:id=>this.getRecord(id),set:(_id,article)=>this.save(article),values:()=>this.values(),get size(){return db.prepare("SELECT count(*) AS n FROM articles").get().n;}};
    this.history={set:(_bucket,row)=>db.prepare("INSERT INTO news_context VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET observed_at=excluded.observed_at,payload_json=excluded.payload_json").run(row.bucket,row.observedAt,JSON.stringify(row)),values:()=>db.prepare("SELECT payload_json FROM news_context ORDER BY bucket").all().map(r=>JSON.parse(r.payload_json))};
    if(!options.analysisOnly)this.db.prepare("DELETE FROM news_query_snapshots").run();
    this.prune();
  }
  hydrate() {}
  close(){this.reader?.close();}
  getRecord(id){const row=this.db.prepare("SELECT payload_json FROM articles WHERE article_id=?").get(id);return row?JSON.parse(row.payload_json):undefined;}
  *values(){for(const row of this.db.prepare("SELECT payload_json FROM articles").iterate())yield JSON.parse(row.payload_json);}
  save(article){
    const previous=this.db.prepare("SELECT revision FROM articles WHERE article_id=?").get(article.id);
    if(previous?.revision===article.revision){
      this.db.prepare("UPDATE articles SET last_seen_at=?,payload_json=? WHERE article_id=?").run(article.archiveLastSeenAt,JSON.stringify(article),article.id);
      for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);return;
    }
    const policy=typeof article.usagePolicy==="string"?article.usagePolicy:article.usagePolicy?.contentPolicy || "headline-only-link-out";
    this.db.prepare("INSERT INTO articles VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,canonical_url=excluded.canonical_url,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,revision=excluded.revision,usage_policy=excluded.usage_policy,payload_json=excluded.payload_json").run(article.id,article.title,article.excerpt || null,article.url || null,article.publishedAt || null,article.receivedAt,article.archiveLastSeenAt,article.revision || 1,policy,JSON.stringify(article));
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    if(previous?.revision===article.revision)return;
    this.db.prepare("INSERT OR IGNORE INTO article_revisions VALUES(?,?,?,?)").run(article.id,article.revision || 1,article.archiveLastSeenAt,JSON.stringify(article));
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    for(const table of ["article_instruments","article_countries","article_topics","article_sources"])this.db.prepare(`DELETE FROM ${table} WHERE article_id=?`).run(article.id);
    for(const i of listVerifiedInstruments()) {const reason=matchInstrument(article,i);if(reason){instrumentRow(this.db,i.instrumentId);this.db.prepare("INSERT INTO article_instruments VALUES(?,?,?)").run(article.id,i.instrumentId,JSON.stringify(reason));}}
    for(const country of article.countryMentions || [])this.db.prepare("INSERT OR IGNORE INTO article_countries VALUES(?,?)").run(article.id,country);
    for(const topic of article.topics || [])this.db.prepare("INSERT OR IGNORE INTO article_topics VALUES(?,?)").run(article.id,topic);
    for(const p of article.provenances || []) {const sid=p.sourceId || `publisher:${p.publisher || p.provider || "unknown"}`;sourceRow(this.db,sid,p);this.db.prepare("INSERT INTO article_sources VALUES(?,?,?,?) ON CONFLICT(article_id,source_id) DO UPDATE SET observed_at=excluded.observed_at,provenance_json=excluded.provenance_json").run(article.id,sid,article.archiveLastSeenAt,JSON.stringify(p));}
  }
  persist(){if(this.db)writeMeta(this.db,"news.meta",Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]])));}
  prune(){
    if(!this.db || this.analysisOnly)return;
    // Facts, provenance and contexts have no automatic retention. Query snapshots are temporary.
    this.db.prepare("DELETE FROM news_query_snapshots WHERE expires_at<=?").run(this.now());
  }
  ingest(values,options){
    // Preserve the existing classifiers' inputs at acquisition time without
    // storing restricted provider bodies. Old rows use permitted metadata until
    // their source is fetched again; no missing historical text is invented.
    const enriched=(values || []).map(raw=>{
      const normalized=normalizeArticles([raw],raw.provider)[0];
      if(!normalized)return raw;
      const classified=classifyFinancialArticle(normalized);
      classified.financial.importance=scoreFinancialImportance(normalized);
      return {...raw,countryMentions:[...new Set([...(raw.countryMentions || []),...normalized.countryMentions])],analysisFeatures:{methodVersion:"news-features-v1",sentiment:normalized.sentiment,conflict:normalized.conflict,financial:classified.financial}};
    });
    const before=Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]]));
    try{return this.db.transaction(()=>super.ingest(enriched,options)).immediate();}catch(error){Object.assign(this,readMeta(this.db,"news.meta",before));throw error;}
  }
  recordContext(snapshot){return this.db.transaction(()=>super.recordContext(snapshot)).immediate();}
  getHistory({from,to}={}){
    const predicates=[],args=[];
    for(const [value,operator]of [[from,">="],[to,"<="]])if(value){predicates.push(`observed_at${operator}?`);args.push(value);}
    return this.db.prepare(`SELECT payload_json FROM news_context ${predicates.length?`WHERE ${predicates.join(" AND ")}`:""} ORDER BY observed_at`).all(...args).map(row=>JSON.parse(row.payload_json));
  }
  coverage(filters={}){
    if(!this.db)return {};
    const s=this.db.prepare("SELECT count(*) AS totalStored,min(published_at) AS oldest,max(published_at) AS newest,min(received_at) AS oldestReceivedAt,max(received_at) AS newestReceivedAt,sum(published_at IS NULL) AS unknownPublicationCount FROM articles").get();
    const retainedSince=s.oldest || s.oldestReceivedAt || this.startedAt;
    return {...s,unknownPublicationCount:s.unknownPublicationCount || 0,retentionDays:null,retentionPolicy:"historical-facts-preserved; query-cursors-expire",startedAt:this.startedAt,retainedSince,lastIngestAt:this.lastIngestAt,requestedWindow:{from:filters.from || null,to:filters.to || null,timeField:filters.timeField || "publishedAt"},partial:!filters.from || Date.parse(filters.from)<Date.parse(retainedSince) || Boolean(this.capacityPrunedAt),acquisitionContinuity:"unknown",capacityPrunedAt:this.capacityPrunedAt,recoveryStatus:this.recoveryStatus,meaning:"collected permitted metadata; never all Internet news"};
  }
  getItem(id){const row=this.db.prepare("SELECT article_id FROM article_aliases WHERE alias=? LIMIT 1").get(id);const article=this.getRecord(id)||this.getRecord(row?.article_id || "");if(!article)throw new AppError("Artículo no disponible dentro de la retención del archivo.",404,"NEWS_ITEM_NOT_FOUND");return {article,coverage:this.coverage(),revision:this.revision,warnings:["No se devuelve texto completo; las fuentes duplicadas no son corroboraciones independientes."]};}
  cleanupSnapshots(){if(!this.db)return;this.db.prepare("DELETE FROM news_query_snapshots WHERE expires_at<=?").run(this.now());for(const [id,s]of this.snapshots)if(s.expiresAt<=this.now())this.snapshots.delete(id);}
  search(input={}){
    const {limit=20,maxBytes=262144,cursor,...rawFilters}=input;
    let id,offset=0,snapshot;
    for(const [key,value]of this.snapshots)if(value.expiresAt<=this.now())this.snapshots.delete(key);
    if(cursor){
      ({id,offset}=this.decodeCursor(cursor));snapshot=this.snapshots.get(id);
      if(Object.keys(rawFilters).length&&hash(normalizeNewsFilters(rawFilters))!==snapshot.filterHash)throw new AppError("Los filtros no pueden cambiar dentro de una revisión paginada.",400,"CURSOR_FILTER_MISMATCH");
    }else{
      const filters=normalizeNewsFilters(rawFilters),universe=listVerifiedInstruments();
      const resolutions=resolveReferences([...(filters.symbols || []),...(filters.instrumentIds || [])],{},universe);
      if(resolutions.some(r=>r.status!=="resolved"))throw new AppError("Identidad inexistente o ambigua.",400,"UNRESOLVED_INSTRUMENT");
      snapshot={filters,instruments:resolutions.map(r=>universe.find(i=>i.instrumentId===r.instrumentId)),filterHash:hash(filters),expiresAt:this.now()+this.cursorTtlMs,coverage:this.coverage(filters),total:0,syntheticCount:0,staleCount:0};
      id=randomUUID();
    }
    const data={articles:[],total:snapshot.total,hasMore:false,nextCursor:null,revision:snapshot.revision,snapshotId:id,cursorExpiresAt:new Date(snapshot.expiresAt).toISOString(),coverage:snapshot.coverage,quality:{syntheticCount:snapshot.syntheticCount,staleCount:snapshot.staleCount},warnings:["Archivo de metadata y extractos autorizados; no es cobertura completa de Internet.","La fecha de publicación desconocida queda fuera de ventanas publishedAt; consultar receivedAt de forma explícita.",...(snapshot.coverage.partial?["La cobertura solicitada es parcial por activación, retención o capacidad."]:[])]};
    this.reader.transaction(()=>{
      if(!cursor){snapshot.revision=readMeta(this.reader,"news.meta",{}).revision || 0;snapshot.upper=this.reader.prepare("SELECT coalesce(max(rowid),0) AS n FROM article_revisions").get().n;}
      const filters=snapshot.filters,field=filters.timeField || 'publishedAt';
      const column=({publishedAt:"json_extract(r.payload_json,'$.publishedAt')",receivedAt:"json_extract(r.payload_json,'$.receivedAt')",updatedAt:"json_extract(r.payload_json,'$.updatedAt')",archiveChangedAt:"json_extract(r.payload_json,'$.archiveChangedAt')"})[field];
      const predicates=['r.rowid<=?','NOT EXISTS (SELECT 1 FROM article_revisions newer WHERE newer.article_id=r.article_id AND newer.revision>r.revision AND newer.rowid<=?)'],args=[snapshot.upper,snapshot.upper];
      for(const [bound,op]of [['from','>='],['to','<=']])if(filters[bound]){predicates.push(`${column}${op}?`);args.push(filters[bound]);}
      const query=`SELECT r.payload_json FROM article_revisions r WHERE ${predicates.join(' AND ')} ORDER BY coalesce(${column},json_extract(r.payload_json,'$.receivedAt')) DESC,r.article_id ASC`;
      let matched=0,full=false;
      for(const row of this.reader.prepare(query).iterate(...args)){
        const article=JSON.parse(row.payload_json),reasons=[];
        if(filters.countries?.length){const matches=(article.countryMentions || []).filter(c=>filters.countries.includes(c));if(!matches.length)continue;reasons.push(...matches.map(c=>({kind:'country',method:'country-tag-or-detection',evidence:c})));}
        if(snapshot.instruments.length){const matches=snapshot.instruments.map(i=>matchInstrument(article,i)).filter(Boolean);if(!matches.length)continue;reasons.push(...matches);}
        if(filters.q&&!`${article.title} ${article.excerpt || ''}`.toLowerCase().includes(filters.q.toLowerCase()))continue;
        if(filters.sectors?.length&&!filters.sectors.some(v=>(article.sectors || []).includes(v)))continue;
        if(filters.providers?.length&&!(article.provenances || []).some(p=>filters.providers.includes(p.provider)))continue;
        if(filters.sources?.length&&!(article.provenances || []).some(p=>filters.sources.includes(p.sourceId)||filters.sources.includes(p.publisher)))continue;
        if(filters.topics?.length&&!(article.topics || []).some(t=>filters.topics.includes(t)))continue;
        if(filters.q)reasons.push({kind:'text',method:'case-insensitive-text',evidence:filters.q});
        if(filters.topics?.length)reasons.push({kind:'topic',method:'collected-topic-tag',evidence:filters.topics.filter(t=>(article.topics || []).includes(t)).join(', ')});
        const position=matched++;
        if(!cursor){if(article.synthetic || article.dataMode==='synthetic')snapshot.syntheticCount++;if(article.dataMode==='stale'||article.provenance?.stale)snapshot.staleCount++;}
        if(position<offset)continue;
        if(data.articles.length<limit&&!full){
          data.articles.push({...article,matchReasons:reasons});
          // Include the largest cursor/envelope shape while budgeting the page.
          data.nextCursor=this.cursor(id,offset+data.articles.length);data.hasMore=true;
          if(wireSize(data)>maxBytes-1024){data.articles.pop();full=true;}
        }
        if(cursor&&(full||data.articles.length>=limit))break;
      }
      if(!cursor)snapshot.total=matched;
    }).deferred();
    if(!cursor){while(this.snapshots.size>=this.maxSnapshots)this.snapshots.delete(this.snapshots.keys().next().value);this.snapshots.set(id,snapshot);}
    if(offset>snapshot.total)throw new AppError('Cursor fuera del resultado.',400,'INVALID_CURSOR');
    data.total=snapshot.total;data.revision=snapshot.revision;data.quality={syntheticCount:snapshot.syntheticCount,staleCount:snapshot.staleCount};
    const next=offset+data.articles.length;data.hasMore=next<snapshot.total;data.nextCursor=data.hasMore?this.cursor(id,next):null;
    if(!data.articles.length&&data.hasMore)throw new AppError('Un artículo no cabe en el presupuesto.',413,'NEWS_ITEM_TOO_LARGE');
    if(wireSize(data)>maxBytes-512)throw new AppError('Metadata excede presupuesto.',413,'OUTPUT_TOO_LARGE');
    return data;
  }
}
