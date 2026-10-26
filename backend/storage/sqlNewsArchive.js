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
import { sanitizeArticleContent } from '../services/news/newsContentSanitizer.js';
import { physicalPages } from './sqlNewsCorpus.js';
import {resolveEditorialIdentity,editorialProjection,PUBLISHER_METHOD} from '../services/news/publisherIdentity.js';
import {classifyRssArticle} from '../services/news/rssClassifier.js';
import {classificationProjection,NEWS_CLASSIFICATION_VERSION} from '../services/news/newsClassification.js';
import {SourceAssessments} from '../services/news/sourceAssessments.js';
import {sourceCoverage,saveEditorialFacet} from './sourceCoverage.js';
import {NewsComparisons} from './newsComparisons.js';
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const EDITORIAL_BACKFILL_KEY=`news.editorial-backfill:${PUBLISHER_METHOD}:${NEWS_CLASSIFICATION_VERSION}:comparisons-v1`;
const wireSize=data=>{const p={ok:true,queriedAt:new Date().toISOString(),origin:"OGID",data,warnings:data.warnings,truncated:false};return Buffer.byteLength(JSON.stringify({structuredContent:p,content:[{type:"text",text:JSON.stringify(p)}]}));};

export class SqlNewsArchive extends NewsArchive {
  constructor(db, options={}) {
    super({...options,persistencePath:null}); this.db=db;this.analysisOnly=options.analysisOnly === true;this.featureCache=new Map();this.featureCacheBytes=0;
    this.reader=new Database(db.name,{readonly:true});this.reader.pragma("query_only=ON");cacheStatements(this.reader);
    Object.assign(this,readMeta(db,"news.meta",{})); this.recoveryStatus=db.prepare("SELECT 1 FROM articles LIMIT 1").get()?"restored":"new";
    this.sourceAssessmentStore=new SourceAssessments(db,{now:this.now});
    this.comparisonStore=new NewsComparisons(db,{now:this.now});
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
    const previous=this.db.prepare("SELECT revision,payload_json FROM articles WHERE article_id=?").get(article.id);
    if(previous?.revision===article.revision){
      this.db.prepare("UPDATE articles SET last_seen_at=?,payload_json=? WHERE article_id=? AND (last_seen_at IS NOT ? OR payload_json!=?)").run(article.archiveLastSeenAt,JSON.stringify(article),article.id,article.archiveLastSeenAt,JSON.stringify(article));
      for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);this.saveSources(article);saveEditorialFacet(this.db,article);this.comparisonStore.index(article);return;
    }
    const policy=typeof article.usagePolicy==="string"?article.usagePolicy:article.usagePolicy?.contentPolicy || "headline-only-link-out";
    this.db.prepare("INSERT INTO articles VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,canonical_url=excluded.canonical_url,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,revision=excluded.revision,usage_policy=excluded.usage_policy,payload_json=excluded.payload_json").run(article.id,article.title,article.excerpt || null,article.url || null,article.publishedAt || null,article.receivedAt,article.archiveLastSeenAt,article.revision || 1,policy,JSON.stringify(article));
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    if(previous?.revision===article.revision)return;
    this.db.prepare("INSERT OR IGNORE INTO article_revisions VALUES(?,?,?,?)").run(article.id,article.revision || 1,article.metadataUpdatedAt || article.archiveLastSeenAt,JSON.stringify(article));
    const excerpt=this.pendingExcerpts?.get(article.id);
    if(excerpt!==undefined&&article.permittedExcerptHash)this.db.prepare('INSERT OR IGNORE INTO article_permitted_excerpts VALUES(?,?,?,?,?)').run(article.id,article.revision,article.permittedExcerptHash,excerpt,article.archiveLastSeenAt);
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    const prior=previous?JSON.parse(previous.payload_json):null;
    const inputs=v=>[v.title,v.excerpt,v.instrumentIds||[],v.countryMentions||[],v.topics||[]];
    if(!prior||hash(inputs(prior))!==hash(inputs(article))){
      for(const table of ["article_instruments","article_countries","article_topics"])this.db.prepare(`DELETE FROM ${table} WHERE article_id=?`).run(article.id);
      for(const i of listVerifiedInstruments()) {const reason=matchInstrument(article,i);if(reason){instrumentRow(this.db,i.instrumentId);this.db.prepare("INSERT INTO article_instruments VALUES(?,?,?)").run(article.id,i.instrumentId,JSON.stringify(reason));}}
      for(const country of article.countryMentions || [])this.db.prepare("INSERT OR IGNORE INTO article_countries VALUES(?,?)").run(article.id,country);
      for(const topic of article.topics || [])this.db.prepare("INSERT OR IGNORE INTO article_topics VALUES(?,?)").run(article.id,topic);
    }
    this.saveSources(article);
    saveEditorialFacet(this.db,article);
    this.comparisonStore.index(article);
  }
  comparisons(input={}){return this.comparisonStore.list(input);}
  comparison(input){return this.comparisonStore.detail(input);}
  comparisonClaim(input){return this.comparisonStore.claim(input);}
  comparisonChanges(input={}){return this.comparisonStore.changes(input);}
  reviewComparison(input){return this.comparisonStore.review(input);}
  sourceAssessments(input={}){return this.sourceAssessmentStore.catalogue(input);}
  sourceAssessment(input={}){return this.sourceAssessmentStore.detail(input);}
  importSourceAssessments(input){return this.sourceAssessmentStore.importBatch(input);}
  sourceCoverage(input={}){return sourceCoverage(this.db,this.sourceAssessmentStore,input);}
  saveSources(article){for(const p of article.provenances||[]){const sid=p.sourceId||`publisher:${p.publisher||p.provider||'unknown'}`;sourceRow(this.db,sid,p);this.db.prepare('INSERT INTO article_sources VALUES(?,?,?,?) ON CONFLICT(article_id,source_id) DO UPDATE SET observed_at=excluded.observed_at,provenance_json=excluded.provenance_json WHERE observed_at IS NOT excluded.observed_at OR provenance_json!=excluded.provenance_json').run(article.id,sid,article.archiveLastSeenAt,JSON.stringify(p));}}
  persist(){if(this.db)writeMeta(this.db,"news.meta",Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]])));}
  prune(){
    if(!this.db || this.analysisOnly)return;
    // Facts, provenance and contexts have no automatic retention. Query snapshots are temporary.
    this.db.prepare("DELETE FROM news_query_snapshots WHERE expires_at<=?").run(this.now());
  }
  // SQL retains historical facts. Counting the full archive after every small
  // batch served only the legacy retention rule and stalled the writer on cold I/O.
  shouldPruneAfterIngest(){return false;}
  ingest(values,options){
    // Preserve the existing classifiers' inputs at acquisition time without
    // storing restricted provider bodies. Old rows use permitted metadata until
    // their source is fetched again; no missing historical text is invented.
    const enriched=(values || []).map(raw=>{
      const {archiveLastSeenAt:_lastSeen,fetchedAt:_fetched,receivedAt:_received,firstSeenAt:_first,...semantic}=raw;
      if(semantic.provenance){const {fetchedAt:_polled,observedAt:_observed,checkedAt:_checked,...provenance}=semantic.provenance;semantic.provenance=provenance;}
      const key=hash(semantic),cached=this.featureCache.get(key);
      if(cached)return {...raw,countryMentions:cached.countryMentions,analysisFeatures:cached.analysisFeatures};
      const normalized=normalizeArticles([raw],raw.provider)[0];
      if(!normalized)return raw;
      const classified=classifyFinancialArticle(normalized);
      classified.financial.importance=scoreFinancialImportance(normalized);
      const features={countryMentions:[...new Set([...(raw.countryMentions || []),...normalized.countryMentions])],analysisFeatures:{methodVersion:"news-features-v1",sentiment:normalized.sentiment,conflict:normalized.conflict,financial:classified.financial}};
      const bytes=Buffer.byteLength(JSON.stringify(features));
      while(this.featureCache.size&&(this.featureCache.size>=2048||this.featureCacheBytes+bytes>4194304)){const old=this.featureCache.keys().next().value;this.featureCacheBytes-=this.featureCache.get(old).bytes;this.featureCache.delete(old);}
      if(bytes>4194304)return {...raw,...features};
      this.featureCacheBytes+=bytes;
      this.featureCache.set(key,{...features,bytes});return {...raw,...features};
    });
    const before=Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]]));
    this.pendingExcerpts=new Map();
    try{return this.db.transaction(()=>super.ingest(enriched,options)).immediate();}catch(error){Object.assign(this,readMeta(this.db,"news.meta",before));throw error;}finally{this.pendingExcerpts=null;}
  }
  ingestPage(values,options,{budgetMs=100}={}){
    const before=Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]]));
    try{return this.db.transaction(()=>{
      const started=performance.now();let processed=0,accepted=0;
      for(const article of values){accepted+=this.ingest([article],options).accepted||0;processed++;if(performance.now()-started>=budgetMs)break;}
      return {processed,accepted,revision:this.revision};
    }).immediate();}catch(error){Object.assign(this,readMeta(this.db,'news.meta',before));throw error;}
  }
  enrichEditorialPage({limit=100,budgetMs=50}={}) {
    const key=EDITORIAL_BACKFILL_KEY, before=this.revision;
    try{return this.db.transaction(()=>{
      const state=readMeta(this.db,key,null) || {cursor:0,upper:this.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM articles').get().n,processed:0};
      if(state.complete)return state;
      const rows=this.db.prepare('SELECT rowid,length(CAST(payload_json AS BLOB)) AS bytes FROM articles WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(state.cursor,state.upper,Math.max(1,Math.min(100,Number(limit)||100)));
      const start=performance.now();let bytes=0;
      for(const row of rows){
        if(bytes && bytes+row.bytes>131072)break;
        if(row.bytes>131072)throw new AppError('Enriquecimiento diferido: un registro excede el presupuesto de página.',413,'NEWS_METADATA_ROW_TOO_LARGE');
        const previous=JSON.parse(this.db.prepare('SELECT payload_json FROM articles WHERE rowid=?').get(row.rowid).payload_json),classified=classifyRssArticle(previous);
        const metadata={...editorialProjection(resolveEditorialIdentity(previous)),publisher:classified.publisher,
          classification:classificationProjection(classified.classification),threatLevel:classified.threatLevel,topicTags:classified.topicTags,
          countryMentions:[...new Set([...(previous.countryMentions||[]),...classified.countryMentions])].sort()};
        if(hash(Object.fromEntries(Object.keys(metadata).map(k=>[k,previous[k]])))!==hash(metadata)){
          this.save({...previous,...metadata,revision:previous.revision+1,metadataUpdatedAt:new Date(this.now()).toISOString()});this.revision++;
        }else {saveEditorialFacet(this.db,previous);this.comparisonStore.index(previous);}
        state.cursor=row.rowid;state.processed++;bytes+=row.bytes;
        if(performance.now()-start>=Math.max(1,Math.min(100,Number(budgetMs)||50)))break;
      }
      state.complete=!this.db.prepare('SELECT 1 FROM articles WHERE rowid>? AND rowid<=? LIMIT 1').get(state.cursor,state.upper);
      writeMeta(this.db,key,state);this.persist();return state;
    }).immediate();}catch(error){this.revision=before;throw error;}
  }
  preparePermittedExcerpt(raw,record,previous){
    if(!this.pendingExcerpts)return;
    const policies=[record.usagePolicy,record.usagePolicy?.mode,record.usagePolicy?.contentPolicy,raw.provenance?.contentPolicy];
    if(record.excerpt===null||policies.includes('headline-only-link-out'))return;
    // Only the provider's permitted description/excerpt, never raw fullText,
    // scraping, headers or provider bodies. Old search payloads remain compact.
    let excerpt=sanitizeArticleContent({description:raw.description||raw.excerpt||''}).description;
    if(!excerpt){if(previous?.permittedExcerptHash)record.permittedExcerptHash=previous.permittedExcerptHash;return;}
    if(previous?.permittedExcerptHash&&excerpt.length>=100){
      const prior=this.db.prepare('SELECT excerpt FROM article_permitted_excerpts WHERE article_id=? AND revision=?').get(previous.id,previous.revision);
      const prefix=excerpt.replace(/\.{3}$/,'');
      if(prior?.excerpt.length>excerpt.length&&prior.excerpt.startsWith(prefix))excerpt=prior.excerpt;
    }
    record.permittedExcerptHash=createHash('sha256').update(excerpt).digest('hex');
    this.pendingExcerpts.set(record.id,excerpt);
  }
  recordContext(snapshot){return this.db.transaction(()=>super.recordContext(snapshot)).immediate();}
  getHistory({from,to}={}){
    const predicates=[],args=[];
    for(const [value,operator]of [[from,">="],[to,"<="]])if(value){predicates.push(`observed_at${operator}?`);args.push(value);}
    return this.db.prepare(`SELECT payload_json FROM news_context ${predicates.length?`WHERE ${predicates.join(" AND ")}`:""} ORDER BY observed_at`).all(...args).map(row=>JSON.parse(row.payload_json));
  }
  coverage(filters={}){
    if(!this.db)return {};
    // One consistent statement, each aggregate served by its covering date
    // index. Combining reception/publication forces a scan of large payload rows.
    const s=this.db.prepare(`SELECT
      (SELECT records FROM storage_counts WHERE name='articles') AS totalStored,
      (SELECT min(published_at) FROM articles) AS oldest,
      (SELECT max(published_at) FROM articles) AS newest,
      (SELECT min(received_at) FROM articles) AS oldestReceivedAt,
      (SELECT max(received_at) FROM articles) AS newestReceivedAt,
      (SELECT count(*) FROM articles WHERE published_at IS NULL) AS unknownPublicationCount`).get();
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
      snapshot={filters,instruments:resolutions.map(r=>universe.find(i=>i.instrumentId===r.instrumentId)),filterHash:hash(filters),expiresAt:this.now()+this.cursorTtlMs,coverage:this.coverage(filters),total:0,syntheticCount:0,staleCount:0,rows:[]};
      id=randomUUID();
    }
    const data={articles:[],total:snapshot.total,hasMore:false,nextCursor:null,revision:snapshot.revision,snapshotId:id,cursorExpiresAt:new Date(snapshot.expiresAt).toISOString(),coverage:snapshot.coverage,quality:{syntheticCount:snapshot.syntheticCount,staleCount:snapshot.staleCount},warnings:["Archivo de metadata y extractos autorizados; no es cobertura completa de Internet.","La fecha de publicación desconocida queda fuera de ventanas publishedAt; consultar receivedAt de forma explícita.",...(snapshot.coverage.partial?["La cobertura solicitada es parcial por activación, retención o capacidad."]:[])]};
    this.reader.transaction(()=>{
      if(!cursor){snapshot.revision=readMeta(this.reader,"news.meta",{}).revision || 0;snapshot.upper=this.reader.prepare("SELECT coalesce(max(rowid),0) AS n FROM article_revisions").get().n;}
      const filters=snapshot.filters,field=filters.timeField || 'publishedAt';
      const column=({publishedAt:"json_extract(r.payload_json,'$.publishedAt')",receivedAt:"json_extract(r.payload_json,'$.receivedAt')",updatedAt:"json_extract(r.payload_json,'$.updatedAt')",archiveChangedAt:"json_extract(r.payload_json,'$.archiveChangedAt')"})[field];
      const predicates=['r.rowid<=?','NOT EXISTS (SELECT 1 FROM article_revisions newer WHERE newer.article_id=r.article_id AND newer.revision>r.revision AND newer.rowid<=?)'],args=[snapshot.upper,snapshot.upper];
      for(const [bound,op]of [['from','>='],['to','<=']])if(filters[bound]){predicates.push(`${column}${op}?`);args.push(filters[bound]);}
      // Sort only immutable row references, keeping payloads out of SQLite's temporary sorter.
      // A bounded date window already excludes NULL dates; its expression
      // index can sort references without opening every historical JSON body.
      const order=filters.from || filters.to ? column : `coalesce(${column},json_extract(r.payload_json,'$.receivedAt'))`;
      const windowIndex=({publishedAt:'article_revisions_window',receivedAt:'article_revisions_received_window',updatedAt:'article_revisions_updated_window',archiveChangedAt:'article_revisions_changed_window'})[field];
      const indexed=filters.from || filters.to?` INDEXED BY ${windowIndex}`:'';
      const query=`SELECT r.rowid AS rowid FROM article_revisions r${indexed} WHERE ${predicates.join(' AND ')} ORDER BY ${order} DESC,r.article_id ASC`;
      let matched=cursor?offset:0,full=false;
      // Later pages resolve the frozen references directly instead of scanning
      // and sorting the entire revision corpus again for every cursor.
      const rows=cursor?snapshot.rows.slice(offset,offset+limit).map(rowid=>({rowid})):physicalPages(this.reader,'article_revisions',this.reader.prepare(query).iterate(...args));
      const payload=this.reader.prepare("SELECT payload_json FROM article_revisions WHERE rowid=?");
      for(const row of rows){
        const article=JSON.parse(row.payload_json || payload.get(row.rowid).payload_json),reasons=[];
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
        if(!cursor){
          if(snapshot.rows.length>=this.maxSnapshotItems)throw new AppError('El resultado excede la capacidad de revisiones; acotar la ventana.',413,'SNAPSHOT_TOO_LARGE');
          snapshot.rows.push(row.rowid);
          if(article.synthetic || article.dataMode==='synthetic')snapshot.syntheticCount++;
          if(article.dataMode==='stale'||article.provenance?.stale)snapshot.staleCount++;
        }
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
    if(!cursor){
      let retained=[...this.snapshots.values()].reduce((sum,value)=>sum+value.rows.length,0);
      while(this.snapshots.size>=this.maxSnapshots || retained+snapshot.rows.length>this.maxSnapshotItems){
        const oldest=this.snapshots.keys().next().value;
        retained-=this.snapshots.get(oldest).rows.length;this.snapshots.delete(oldest);
      }
      this.snapshots.set(id,snapshot);
    }
    if(offset>snapshot.total)throw new AppError('Cursor fuera del resultado.',400,'INVALID_CURSOR');
    data.total=snapshot.total;data.revision=snapshot.revision;data.quality={syntheticCount:snapshot.syntheticCount,staleCount:snapshot.staleCount};
    const next=offset+data.articles.length;data.hasMore=next<snapshot.total;data.nextCursor=data.hasMore?this.cursor(id,next):null;
    if(!data.articles.length&&data.hasMore)throw new AppError('Un artículo no cabe en el presupuesto.',413,'NEWS_ITEM_TOO_LARGE');
    if(wireSize(data)>maxBytes-512)throw new AppError('Metadata excede presupuesto.',413,'OUTPUT_TOO_LARGE');
    return data;
  }
}
