import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';
import {safeUrl} from '../utils/researchProjection.js';
import {AWARENESS_SOURCES} from '../services/awareness/awarenessCatalog.js';

export const SITUATION_METHOD='situations-v1';
const MAX_BYTES=131072,DAY=86400000;
const json=JSON.stringify,parse=JSON.parse;
const iso=ms=>new Date(ms).toISOString();
const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
const clean=(x,n=512)=>typeof x==='string'?x.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,n):'';
const fail=(code,message=code,status=400)=>{throw new AppError(message,status,code);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(x);
const encode=x=>Buffer.from(json(x)).toString('base64url');
const cap=x=>Math.max(1,Math.min(100,Number(x)||20));
// Includes duplicated MCP structured/text envelopes and cursor/identity overhead.
const wire=x=>2*Buffer.byteLength(json(x))+Buffer.byteLength(json(json(x)))-Buffer.byteLength(json(x))+2048;
function decode(value,scope){
 if(!value)return null;
 try{const c=parse(Buffer.from(value,'base64url').toString());if(c.scope!==scope||!Number.isSafeInteger(c.upper)||c.upper<0||!Number.isSafeInteger(c.before)||c.before<0)throw 0;return c;}
 catch{fail('SITUATION_INVALID_CURSOR');}
}
 function fits(input,data){return wire(data)<=Math.max(4096,Math.min(262144,Number(input.maxBytes)||65536));}

export class SituationStore{
 constructor(db,{now=Date.now}={}){this.db=db;this.now=now;}
 upper(){return this.db.prepare('SELECT coalesce(max(sequence),0) n FROM situation_revisions').get().n;}
 receipt(requestId,input,execute){
  if(requestId&&!id(requestId))fail('SITUATION_INVALID_REQUEST_ID');
  const hash=stableHash(input);
  return this.db.transaction(()=>{
   if(requestId){const old=this.db.prepare('SELECT * FROM situation_requests WHERE request_id=?').get(requestId);if(old){if(old.input_hash!==hash)fail('SITUATION_REQUEST_CONFLICT',undefined,409);return parse(old.result_json);}}
   const result=execute();
   if(requestId)this.db.prepare('INSERT INTO situation_requests VALUES(?,?,?)').run(requestId,hash,json(result));
   return result;
  }).immediate();
 }
 status(){
  const bootstrap=this.db.prepare('SELECT * FROM situation_bootstrap ORDER BY phase').all();
  const streams=this.db.prepare('SELECT * FROM situation_consumers ORDER BY stream').all().map(s=>{
   const table=s.stream==='news'?'news_comparison_changes':'awareness_revisions';
   const head=this.db.prepare(`SELECT coalesce(max(sequence),0) n FROM ${table}`).get().n;
   return {stream:s.stream,lastSequence:s.last_sequence,headSequence:head,roundUpper:s.upper_sequence,processedEntries:s.processed,excludedEntries:s.excluded,
    hasMore:head>s.last_sequence||Boolean(s.continuation_json),pendingSequenceSpan:Math.max(0,head-s.last_sequence),pendingMeaning:'sequence span; gaps are possible',continuation:s.continuation_json?parse(s.continuation_json):null,
    updatedAt:s.updated_at,errorCode:s.error_code,blockedSequence:s.blocked_sequence,bootstrapUpper:s.bootstrap_upper};
  });
  const initialized=bootstrap.every(s=>s.complete===1),error=bootstrap.find(s=>s.error_code)?.error_code||streams.find(s=>s.errorCode)?.errorCode||null;
  return {methodVersion:SITUATION_METHOD,initialized,state:error?'blocked':initialized?'ready':'bootstrapping',errorCode:error,bootstrap:bootstrap.map(s=>({phase:s.phase,cursor:s.cursor,upper:s.upper_rowid,part:s.part,complete:Boolean(s.complete),errorCode:s.error_code})),streams,
   hasMore:!initialized||streams.some(s=>s.hasMore),domainSequence:this.upper(),outboxSequence:this.db.prepare('SELECT coalesce(max(sequence),0) n FROM situation_outbox').get().n,
   coverage:{partial:true,meaning:'collected reports and admitted official claims; unknowns remain explicit; not verified incident coverage'}};
 }
 checkedPayload(table,key,value){
  const r=this.db.prepare(`SELECT length(CAST(payload_json AS BLOB)) bytes FROM ${table} WHERE ${key}=?`).get(value);
  if(!r)return null;if(r.bytes>MAX_BYTES)fail('SITUATION_SOURCE_TOO_LARGE','Entrada bloqueada: consultar detalle por referencia.',413);
  return parse(this.db.prepare(`SELECT payload_json FROM ${table} WHERE ${key}=?`).get(value).payload_json);
 }
 seed(phase,remaining,deadline,maxBytes=MAX_BYTES){
  const state=this.db.prepare('SELECT * FROM situation_bootstrap WHERE phase=?').get(phase);
  if(state.complete)return {processed:0,bytes:0};
  const table=phase==='legacy'?'geopolitical_alert_revisions':'awareness_events';
  const refs=this.db.prepare(`SELECT rowid,length(CAST(payload_json AS BLOB)) bytes FROM ${table} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(state.cursor,state.upper_rowid,remaining);
  let processed=0,bytes=0;
  for(const ref of refs){
   if(ref.bytes>MAX_BYTES)fail('SITUATION_SOURCE_TOO_LARGE',undefined,413);
   if(bytes+ref.bytes>maxBytes)break;
   const row=this.db.prepare(`SELECT * FROM ${table} WHERE rowid=?`).get(ref.rowid),v=parse(row.payload_json);bytes+=ref.bytes;
   if(phase==='legacy'){
    this.db.prepare('INSERT OR IGNORE INTO geopolitical_alert_changes(alert_id,revision) VALUES(?,?)').run(row.alert_id,row.revision);
    const keys=(v.evidenceIds||[]).map(x=>/^news:(.*):\d+$/.exec(x)).filter(Boolean).map(x=>x[1]);
    if(!row.alert_id.startsWith('news:'))this.db.prepare('INSERT OR IGNORE INTO situation_legacy_links VALUES(?,?,?)').run('awareness',row.alert_id,row.alert_id);
    let n=state.part;
    for(;n<keys.length&&processed<remaining;n++,processed++)this.db.prepare('INSERT OR IGNORE INTO situation_legacy_links VALUES(?,?,?)').run('news',keys[n],row.alert_id);
    if(n<keys.length||processed>=remaining){state.part=n;break;}
    state.part=0;
   }else this.db.prepare("INSERT OR IGNORE INTO awareness_revisions(event_id,revision,source_id,available_at,baseline,payload_json) VALUES(?,?,?,?,1,?)").run(row.event_id,row.revision,row.source_id,iso(this.now()),row.payload_json);
   state.cursor=ref.rowid;processed++;
   if(processed>=remaining||performance.now()>=deadline)break;
  }
  state.complete=!this.db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND rowid<=? LIMIT 1`).get(state.cursor,state.upper_rowid);
  this.db.prepare('UPDATE situation_bootstrap SET cursor=?,part=?,complete=?,error_code=NULL WHERE phase=?').run(state.cursor,state.part,Number(state.complete),phase);
  return {processed,bytes};
 }
 processPage({limit=100,budgetMs=50,requestId}={}){
  limit=Math.max(1,Math.min(100,Number(limit)||100));budgetMs=Math.max(1,Math.min(100,Number(budgetMs)||50));
  const started=performance.now(),deadline=started+budgetMs;let blockedStream=null,blockedSequence=null,phase=null;
  try{return this.receipt(requestId,['sync',limit,budgetMs],()=>{
   let processed=0,updated=0,bytes=0;
   for(phase of ['legacy','awareness']){
    const seeded=this.seed(phase,limit-processed,deadline,MAX_BYTES-bytes);processed+=seeded.processed;bytes+=seeded.bytes;
    if(processed>=limit||bytes>=MAX_BYTES||performance.now()>=deadline)return {updated,processed,...this.status(),durationMs:performance.now()-started};
   }
   phase=null;
   const states=this.db.prepare('SELECT * FROM situation_consumers ORDER BY coalesce(updated_at,\'\'),stream').all();
   for(const state of states){
    blockedStream=state.stream;
    const table=state.stream==='news'?'news_comparison_changes':'awareness_revisions';
    if(state.last_sequence>=state.upper_sequence)state.upper_sequence=this.db.prepare(`SELECT coalesce(max(sequence),0) n FROM ${table}`).get().n;
    const refs=this.db.prepare(`SELECT sequence,length(CAST(payload_json AS BLOB)) bytes FROM ${table} WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`).all(state.last_sequence,state.upper_sequence,limit-processed);
    for(const ref of refs){
     blockedSequence=ref.sequence;
     if(ref.bytes>MAX_BYTES)fail('SITUATION_SOURCE_TOO_LARGE',undefined,413);
     if(bytes&&bytes+ref.bytes>MAX_BYTES)break;
     const row=this.db.prepare(`SELECT * FROM ${table} WHERE sequence=?`).get(ref.sequence);bytes+=ref.bytes;
     if(state.stream==='news'){
      const change=parse(row.payload_json),continuation=state.continuation_json?parse(state.continuation_json):null;
      const members=this.newsMembers(row,change,continuation?.after||'',limit-processed);
      for(const member of members.items){
       const v=this.newsVersion(member.article_id,member.article_revision,row.sequence);
       if(!v){fail('SITUATION_EVIDENCE_MISSING',undefined,409);}
       const cost=Buffer.byteLength(json(v));if(cost>MAX_BYTES)fail('SITUATION_SOURCE_TOO_LARGE',undefined,413);
       if(bytes+cost>MAX_BYTES){if(!processed)fail('SITUATION_SOURCE_TOO_LARGE',undefined,413);break;}
       if(row.kind==='publication'&&!v.eligible)state.excluded++;
       bytes+=cost;updated+=this.applySource('news',row.sequence,v,row.sequence<=state.bootstrap_upper,row.changed_at,row.kind);processed++;
       state.continuation_json=json({sequence:row.sequence,after:member.article_id});
       if(processed>=limit||performance.now()>=deadline)break;
      }
      const after=state.continuation_json?parse(state.continuation_json).after:'';
      if(this.newsMembers(row,change,after,1).items.length){this.saveConsumer(state);break;}
      if(!members.items.length)state.excluded++;
     }else{
      const v=this.awarenessVersion(row);if(!v.eligible)state.excluded++;updated+=this.applySource('awareness',row.sequence,v,Boolean(row.baseline),row.available_at,'publication');processed++;
     }
     state.last_sequence=row.sequence;state.processed++;state.continuation_json=null;
     this.saveConsumer(state);
     if(processed>=limit||bytes>=MAX_BYTES||performance.now()>=deadline)break;
    }
    this.saveConsumer(state);
    if(processed>=limit||bytes>=MAX_BYTES||performance.now()>=deadline)break;
   }
   return {updated,processed,...this.status(),durationMs:performance.now()-started};
  });}catch(error){
   const code=/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'SITUATION_PROCESSING_FAILED';
   if(phase)this.db.prepare('UPDATE situation_bootstrap SET error_code=? WHERE phase=?').run(code,phase);
   else if(blockedStream)this.db.prepare('UPDATE situation_consumers SET error_code=?,blocked_sequence=? WHERE stream=?').run(code,blockedSequence,blockedStream);
   throw error;
  }
 }
 saveConsumer(s){this.db.prepare('UPDATE situation_consumers SET last_sequence=?,upper_sequence=?,processed=?,excluded=?,continuation_json=?,updated_at=?,error_code=NULL,blocked_sequence=NULL WHERE stream=?').run(s.last_sequence,s.upper_sequence,s.processed,s.excluded,s.continuation_json,iso(this.now()),s.stream);}
 newsMembers(row,change,after,limit){
  if(row.kind==='publication')return {items:change.articleId>after?[{article_id:change.articleId,article_revision:change.articleRevision}]:[]};
  if(row.kind==='claim-link'){
   const ids=[change.leftClaimId,change.rightClaimId].filter(Boolean),values=[];
   for(const claimId of ids){const c=this.db.prepare('SELECT article_id FROM news_comparison_claims WHERE claim_id=?').get(claimId);if(c&&c.article_id>after&&!values.some(v=>v.article_id===c.article_id)){
    const a=this.db.prepare('SELECT article_id,article_revision FROM news_comparison_assignments WHERE article_id=? AND change_sequence<=? ORDER BY change_sequence DESC LIMIT 1').get(c.article_id,row.sequence);if(a)values.push(a);
   }}return {items:values.sort((a,b)=>a.article_id<b.article_id?-1:a.article_id>b.article_id?1:0).slice(0,limit)};
  }
  return {items:this.db.prepare('SELECT article_id,article_revision FROM news_comparison_assignments WHERE change_sequence=? AND article_id>? ORDER BY article_id LIMIT ?').all(row.sequence,after,limit)};
 }
 newsVersion(articleId,revision,sequence){
  const ref=this.db.prepare('SELECT length(CAST(payload_json AS BLOB)) bytes FROM news_comparison_publication_versions WHERE article_id=? AND article_revision=?').get(articleId,revision);
  if(!ref)return null;if(ref.bytes>MAX_BYTES)fail('SITUATION_SOURCE_TOO_LARGE',undefined,413);
  const v=parse(this.db.prepare('SELECT payload_json FROM news_comparison_publication_versions WHERE article_id=? AND article_revision=?').get(articleId,revision).payload_json);
  // Most archived reports do not qualify for this consumer. A new ineligible
  // source needs no historical article body or group resolution. Corrections
  // to an existing member still take the full invalidation/projection path.
  if((!v.eventType||v.classificationStatus!=='evaluated')&&!this.db.prepare("SELECT 1 FROM situation_members WHERE stream='news' AND source_id=?").get(articleId))
    return {sourceId:articleId,sourceRevision:revision,eligible:false};
  const a=this.db.prepare('SELECT group_id,origin_override,review_id FROM news_comparison_assignments WHERE article_id=? AND change_sequence<=? ORDER BY change_sequence DESC LIMIT 1').get(articleId,sequence);
  const originReview=a?.origin_override?this.db.prepare("SELECT a.review_id FROM news_comparison_assignments a JOIN news_comparison_reviews r ON r.review_id=a.review_id WHERE a.article_id=? AND a.origin_override=? AND a.change_sequence<=? AND json_extract(r.payload_json,'$.action')='origin' ORDER BY a.change_sequence DESC LIMIT 1").get(articleId,a.origin_override,sequence)?.review_id||null:null;
  const content=this.db.prepare("SELECT json_extract(payload_json,'$.contentRevision') content_revision,json_extract(payload_json,'$.threatLevel') threat_level,json_extract(payload_json,'$.synthetic') synthetic,json_extract(payload_json,'$.provenance.synthetic') provenance_synthetic,json_extract(payload_json,'$.dataMode') data_mode,json_extract(payload_json,'$.provider') provider FROM article_revisions WHERE article_id=? AND revision=?").get(articleId,revision);
  const synthetic=Boolean(content?.synthetic||content?.provenance_synthetic||content?.provider==='fallback'||['synthetic','fallback','seeded'].includes(content?.data_mode));
  const severity=['critical','elevated','monitoring','low','unknown'].includes(content?.threat_level)?content.threat_level:v.eventType==='military-attack'?'elevated':'monitoring';
  return {...v,sourceId:articleId,sourceRevision:revision,contextKey:`news:${a?.group_id||articleId}`,candidateGroupId:a?.group_id||null,originChainId:a?.origin_override||v.originChainId||null,
   originReviewId:originReview,contentRevision:content?.content_revision??null,
   verification:'unverified',occurredAt:null,location:{mentions:v.locations||[],method:'textual-place-alias; occurrence-not-established',precision:'mentioned-place'},sourceUrl:safeUrl(v.url),summary:'',severity,synthetic,dataMode:content?.data_mode||'observed',eligible:Boolean(v.eventType)&&v.classificationStatus==='evaluated'&&!synthetic};
 }
 awarenessVersion(row){
  const e=parse(row.payload_json),sourceId=e.source?.sourceId||row.source_id;
  const synthetic=Boolean(e.synthetic||e.provenance?.synthetic||['synthetic','fallback','seeded'].includes(e.dataMode));
  const eligible=!synthetic&&AWARENESS_SOURCES.some(s=>s.sourceId===sourceId&&s.admissionState==='active')&&['official_security_release','maritime_alert','market_moving_news'].includes(e.kind)&&['released','updated','cancelled'].includes(e.status);
  return {sourceId:row.event_id,sourceRevision:row.revision,contextKey:`awareness:${row.event_id}`,title:clean(e.title),summary:clean(e.summary,1000),sourceUrl:safeUrl(e.canonicalUrl||e.url),publisherId:null,originChainId:null,
   publishedAt:date(e.publishedAt),receivedAt:date(e.observedAt)||row.available_at,occurredAt:null,location:{reported:e.location||null,method:'attributed-source-location; occurrence-not-established',precision:e.location?.precision||'unknown'},
   modality:e.status==='cancelled'?'retracted':'reported',classificationStatus:'official-source-claim',eventType:e.kind,verification:e.status==='cancelled'?'corrected':'official-claim',severity:e.importance||'medium',countries:e.countries||[],instrumentIds:e.instrumentIds||[],officialSourceId:sourceId,synthetic,dataMode:e.dataMode||'observed',stale:Boolean(e.provenance?.stale),eligible};
 }
 context(key,v){
  const old=this.db.prepare('SELECT entity_id FROM situation_contexts WHERE context_key=?').get(key);if(old)return old.entity_id;
  const entityId=`situation-${randomUUID()}`;this.db.prepare('INSERT INTO situation_entities VALUES(?,?,0,?)').run(entityId,'situation',iso(this.now()));
  this.db.prepare('INSERT INTO situation_contexts VALUES(?,?)').run(key,entityId);return entityId;
 }
 latest(entityId,upper=this.upper()){
  const r=this.db.prepare('SELECT * FROM situation_revisions WHERE entity_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(entityId,upper);return r?{...parse(r.payload_json),sequence:r.sequence}:null;
 }
 revise(entityId,eventKey,value,{stream='operator',sourceSequence=0,historical=false,changeKind='reviewed',sourceId=null}={}){
  const exists=this.db.prepare('SELECT sequence,payload_json FROM situation_revisions WHERE event_key=?').get(eventKey);if(exists)return {...parse(exists.payload_json),sequence:exists.sequence};
  const entity=this.db.prepare('SELECT * FROM situation_entities WHERE entity_id=?').get(entityId),revision=entity.revision+1,changedAt=iso(this.now());
  const payload={...value,id:entityId,kind:entity.kind,revision,changedAt,availableAt:changedAt,occurredAt:value.occurredAt||null,verification:value.verification||'unverified',methodVersion:SITUATION_METHOD,
   independentCorroboration:'not-established',probability:null,sourceChange:{stream,sequence:sourceSequence,sourceId},changeKind,historical};
  const sequence=Number(this.db.prepare('INSERT INTO situation_revisions(entity_id,revision,kind,event_key,changed_at,occurred_at,published_at,payload_json) VALUES(?,?,?,?,?,?,?,?)').run(entityId,revision,entity.kind,eventKey,changedAt,payload.occurredAt,payload.publishedAt||null,json(payload)).lastInsertRowid);
  this.db.prepare('UPDATE situation_entities SET revision=? WHERE entity_id=?').run(revision,entityId);
  this.db.prepare('INSERT INTO situation_outbox(emission_key,entity_id,domain_sequence,change_kind,historical,available_at,payload_json) VALUES(?,?,?,?,?,?,?)').run(eventKey,entityId,sequence,changeKind,Number(historical),changedAt,json({entityId,domainRevision:revision,domainSequence:sequence,kind:entity.kind,changeKind,historical,stream,sourceSequence,sourceId,occurredAt:payload.occurredAt,meaning:'change in attributed knowledge; not confirmation of a new event'}));
  return {...payload,sequence};
 }
 applySource(stream,sourceSequence,v,historical,availableAt,sourceKind){
  const old=this.db.prepare('SELECT * FROM situation_members WHERE stream=? AND source_id=?').get(stream,v.sourceId);
  if(!v.eligible&&!old)return 0;
  if(old&&v.sourceRevision<old.source_revision)return 0;
  const entityId=!v.eligible&&old?old.entity_id:this.context(v.contextKey,v),previous=this.latest(entityId),changedContext=old&&old.entity_id!==entityId;
  const fresh=date(v.receivedAt)&&this.now()-Date.parse(v.receivedAt)>=-300000&&this.now()-Date.parse(v.receivedAt)<=DAY&&(!v.publishedAt||this.now()-Date.parse(v.publishedAt)<=DAY);
  const legacy=this.db.prepare('SELECT 1 FROM situation_legacy_links WHERE stream=? AND source_id=?').get(stream,v.sourceId);
  historical=historical||(!fresh&&!legacy);
  let changeKind=historical?'historical-indexed':old?'source-corrected':'new-report';
  if(old&&stream==='news'&&v.contentRevision!==null&&sourceKind==='publication'){
   const priorEvidence=this.db.prepare('SELECT payload_json FROM situation_evidence WHERE entity_id=? AND stream=? AND source_id=? ORDER BY domain_sequence DESC LIMIT 1').get(old.entity_id,stream,v.sourceId);
   if(priorEvidence&&parse(priorEvidence.payload_json).contentRevision===v.contentRevision)changeKind='metadata-updated';
  }
  if(sourceKind!=='publication')changeKind='evidence-reviewed';
  this.db.prepare('INSERT INTO situation_members VALUES(?,?,?,?,?) ON CONFLICT(stream,source_id) DO UPDATE SET entity_id=excluded.entity_id,source_revision=excluded.source_revision,source_sequence=excluded.source_sequence').run(stream,v.sourceId,entityId,v.sourceRevision,sourceSequence);
  const memberCount=this.db.prepare('SELECT count(*) n FROM situation_members WHERE entity_id=?').get(entityId).n;
  const value={title:!v.eligible&&previous?previous.title:clean(v.title),summary:!v.eligible&&previous?previous.summary:clean(v.summary,1000),verification:v.eligible?'unverified':'needs-review',...(!v.eligible?{qualityReason:'source-ineligible'}:{}),association:'candidate-coverage-context; not a physical incident',candidateGroupId:v.candidateGroupId||null,
   publishedAt:v.publishedAt||null,receivedAt:v.receivedAt||null,occurredAt:null,location:v.location,modality:v.modality||'unknown',classificationStatus:v.classificationStatus||'unknown',memberCount,severity:v.severity,originChainId:v.originChainId,publisherId:v.publisherId||null};
  const eventKey=`${stream}:${sourceSequence}:${v.sourceId}:${entityId}`,domain=this.revise(entityId,eventKey,value,{stream,sourceSequence,sourceId:v.sourceId,historical,changeKind});
  this.db.prepare('INSERT OR IGNORE INTO situation_evidence(entity_id,domain_sequence,stream,source_id,source_revision,source_sequence,payload_json) VALUES(?,?,?,?,?,?,?)').run(entityId,domain.sequence,stream,v.sourceId,v.sourceRevision,sourceSequence,json({...v,stream,sourceSequence,sourceRevision:v.sourceRevision,attribution:'source claim; occurrence not established'}));
  if(old){this.db.prepare('INSERT OR IGNORE INTO situation_invalidations(stream,source_id,source_sequence,domain_sequence,reason,changed_at) VALUES(?,?,?,?,?,?)').run(stream,v.sourceId,sourceSequence,domain.sequence,changedContext?'context-changed':'source-revised',iso(this.now()));}
  if(changedContext){const prior=this.latest(old.entity_id);this.revise(old.entity_id,`${eventKey}:previous-context`,{...prior,memberCount:this.db.prepare('SELECT count(*) n FROM situation_members WHERE entity_id=?').get(old.entity_id).n,association:'coverage-reorganized; incident associations require their own review'},{stream,sourceSequence,sourceId:v.sourceId,historical,changeKind:'context-changed'});}
  return this.projectAlert(stream,v,domain,historical,availableAt,old);
 }
 projectAlert(stream,v,domain,historical,availableAt,old){
  const link=this.db.prepare('SELECT alert_id FROM situation_legacy_links WHERE stream=? AND source_id=?').get(stream,v.sourceId);
  const alertId=link?.alert_id||(stream==='awareness'?v.sourceId:`news:${v.sourceId}`),priorRow=this.db.prepare('SELECT * FROM geopolitical_alerts WHERE alert_id=?').get(alertId),prior=priorRow?parse(priorRow.payload_json):null;
  if(!v.eligible&&!prior)return 0;
  if((historical||['metadata-updated','evidence-reviewed'].includes(domain.changeKind))&&!prior)return 0;
  if(stream==='news'&&!['critical','elevated'].includes(v.severity)&&!prior)return 0;
  if(prior?.sourceRevision===v.sourceRevision&&old&&domain.changeKind!=='evidence-reviewed')return 0;
  const revision=(priorRow?.revision||0)+1,at=iso(this.now());
  const payload={alertId,revision,sourceRevision:v.sourceRevision,title:clean(v.title),summary:clean(v.summary,1000),sourceId:v.officialSourceId||v.publisherId||stream,url:v.sourceUrl,
   publishedAt:v.publishedAt||null,receivedAt:v.receivedAt||null,updatedAt:at,changedAt:at,availableAt:availableAt||at,occurredAt:null,verification:v.verification||'unverified',assessment:'deterministic',severity:v.severity,
   countries:v.countries||v.entities||[],instrumentIds:v.instrumentIds||[],evidenceIds:stream==='news'?[`news:${v.sourceId}:${v.sourceRevision}`]:[],situationId:domain.id,
   changeKind:domain.changeKind,historical,modality:v.modality||'unknown',publisherId:v.publisherId||null,originChainId:v.originChainId||null,corroboration:'not-established',synthetic:v.synthetic,dataMode:v.dataMode,stale:v.stale||false,
   ...(!v.eligible?{title:prior.title,summary:prior.summary,url:prior.url,evidenceIds:prior.evidenceIds||[],verification:'needs-review',severity:'unknown',qualityReason:'source-ineligible'}:{}),
   ...(prior?.agentAssessment?{previousAgentAssessment:{...prior.agentAssessment,current:false,reason:'source-revised'}}:{})};
  this.db.prepare('INSERT INTO geopolitical_alerts VALUES(?,?,?,?,?) ON CONFLICT(alert_id) DO UPDATE SET revision=excluded.revision,source_id=excluded.source_id,updated_at=excluded.updated_at,payload_json=excluded.payload_json').run(alertId,revision,payload.sourceId,at,json(payload));
  this.db.prepare('INSERT INTO geopolitical_alert_revisions VALUES(?,?,?)').run(alertId,revision,json(payload));
  this.db.prepare('INSERT OR IGNORE INTO situation_legacy_links VALUES(?,?,?)').run(stream,v.sourceId,alertId);
  if((historical||domain.changeKind==='metadata-updated')&&priorRow)this.db.prepare('UPDATE geopolitical_alert_state SET read_revision=? WHERE alert_id=? AND read_revision>=?').run(revision,alertId,priorRow.revision);
  return 1;
 }
 alerts(input={},legacy){
  const {deviceId='',state='open',severity='all'}=input;
  if(!['all','open','unread','archived'].includes(state)||!['all','high','critical'].includes(severity))fail('AGENT_INVALID_FILTER');
  if(!this.db.prepare("SELECT complete FROM situation_bootstrap WHERE phase='legacy'").get().complete){
   const result=legacy();return {...result,coverage:{...result.coverage,bootstrapComplete:false},situations:this.status()};
  }
  const scope=stableHash(['inbox',deviceId,state,severity]),c=decode(input.cursor,scope),upper=c?.upper??this.db.prepare('SELECT coalesce(max(sequence),0) n FROM geopolitical_alert_changes').get().n,before=c?.before??upper+1;
  const refs=this.db.prepare('SELECT sequence,alert_id,revision FROM geopolitical_alert_changes WHERE sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT 500').all(upper,before);
  const items=[];let last=before;
  for(const ref of refs){
   if(this.db.prepare('SELECT 1 FROM geopolitical_alert_changes WHERE alert_id=? AND revision>? AND sequence<=? LIMIT 1').get(ref.alert_id,ref.revision,upper)){last=ref.sequence;continue;}
   const flags=this.db.prepare('SELECT read_revision,archived FROM geopolitical_alert_state WHERE device_id=? AND alert_id=?').get(deviceId,ref.alert_id),read=(flags?.read_revision||0)>=ref.revision,archived=Boolean(flags?.archived);
   if(state==='open'&&archived||state==='unread'&&(archived||read)||state==='archived'&&!archived){last=ref.sequence;continue;}
   const value=this.checkedPayload('geopolitical_alert_revisions','rowid',this.db.prepare('SELECT rowid FROM geopolitical_alert_revisions WHERE alert_id=? AND revision=?').get(ref.alert_id,ref.revision).rowid);
   if(severity==='critical'&&value.severity!=='critical'||severity==='high'&&!['critical','high','elevated'].includes(value.severity)){last=ref.sequence;continue;}
   const item={...value,title:clean(value.title),summary:clean(value.summary,1000),read,archived};
   if(!fits(input,{items:[...items,item],asOfSequence:upper,hasMore:true,nextCursor:encode({scope,upper,before:ref.sequence})})){if(!items.length)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);break;}
   items.push(item);last=ref.sequence;if(items.length>=cap(input.limit))break;
  }
  const hasMore=Boolean(this.db.prepare('SELECT 1 FROM geopolitical_alert_changes WHERE sequence<? LIMIT 1').get(last));
  return {items,asOfSequence:upper,hasMore,nextCursor:hasMore?encode({scope,upper,before:last}):null,
   coverage:{partial:true,bootstrapComplete:true,meaning:'attributed reports; changedAt and occurredAt are different; original unknowns preserved'}};
 }
 invalidations(entityId,upper=this.upper()){
  const refs=this.db.prepare('SELECT r.stream,r.source_id,r.source_sequence FROM situation_incident_ref_versions r WHERE r.incident_id=? AND r.domain_sequence<=? AND NOT EXISTS(SELECT 1 FROM situation_incident_ref_versions n WHERE n.incident_id=r.incident_id AND n.stream=r.stream AND n.source_id=r.source_id AND n.domain_sequence>r.domain_sequence AND n.domain_sequence<=?) LIMIT 101').all(entityId,upper,upper);
  const items=[];for(const ref of refs){const row=this.db.prepare('SELECT * FROM situation_invalidations WHERE stream=? AND source_id=? AND source_sequence>? AND domain_sequence<=? ORDER BY sequence DESC LIMIT 1').get(ref.stream,ref.source_id,ref.source_sequence,upper);if(row)items.push({stream:ref.stream,sourceId:ref.source_id,reason:row.reason,sequence:row.domain_sequence,changedAt:row.changed_at});}
  return {current:items.length===0,items};
 }
 view(row,upper){
  const value=parse(row.payload_json),currentness=value.kind==='incident'?this.invalidations(row.entity_id,upper):{current:true,items:[]};
  return {...value,sequence:row.sequence,currentness,...(!currentness.current?{verification:'needs-review',previousVerification:value.verification}:{}),detailPath:`/api/situations/${row.entity_id}?atSequence=${upper}`};
 }
 list(input={}){
  const kind=input.kind||'situation',timeField=input.timeField||'changed';if(!['situation','incident'].includes(kind)||!['changed','occurred','published'].includes(timeField))fail('SITUATION_INVALID_FILTER');
  for(const x of [input.from,input.to])if(x!==undefined&&!date(x))fail('SITUATION_INVALID_FILTER');
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))fail('SITUATION_INVALID_FILTER');
  const from=date(input.from),to=date(input.to);
  const scope=stableHash(['situations',kind,timeField,input.from||null,input.to||null]),c=decode(input.cursor,scope),upper=c?.upper??this.upper(),before=c?.before??upper+1;
  const refs=this.db.prepare('SELECT sequence,entity_id,changed_at,occurred_at,published_at,length(CAST(payload_json AS BLOB)) bytes FROM situation_revisions WHERE kind=? AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT 500').all(kind,upper,before);
  const items=[];let scanned=0,last=before;
  for(const ref of refs){
   const newer=this.db.prepare('SELECT 1 FROM situation_revisions WHERE entity_id=? AND sequence>? AND sequence<=? LIMIT 1').get(ref.entity_id,ref.sequence,upper);
   const field=ref[`${timeField==='changed'?'changed':timeField==='occurred'?'occurred':'published'}_at`];
   if(newer||from&&(!field||field<from)||to&&(!field||field>to)){last=ref.sequence;scanned++;continue;}
   if(ref.bytes>MAX_BYTES)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);
   const row=this.db.prepare('SELECT * FROM situation_revisions WHERE sequence=?').get(ref.sequence),item=this.view(row,upper);
   const draft={items:[...items,item],asOfSequence:upper,hasMore:true,nextCursor:encode({scope,upper,before:ref.sequence})};
   if(!fits(input,draft)){if(!items.length)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);break;}
   items.push(item);last=ref.sequence;scanned++;
   if(items.length>=cap(input.limit))break;
  }
  const hasMore=last>0&&Boolean(this.db.prepare('SELECT 1 FROM situation_revisions WHERE kind=? AND sequence<? LIMIT 1').get(kind,last));
  return {available:true,items,asOfSequence:upper,hasMore,nextCursor:hasMore?encode({scope,upper,before:last}):null,scanned,
   coverage:{partial:true,meaning:'candidate situations and explicitly reviewed incidents; missing event time remains null'},methodVersion:SITUATION_METHOD};
 }
 detail(input){
  if(!id(input.id))fail('SITUATION_INVALID_ID');
  const scope=stableHash(['detail',input.id,input.atSequence??null]),c=decode(input.cursor,scope),upper=c?.upper??Math.min(input.atSequence??this.upper(),this.upper());
  const row=this.db.prepare('SELECT * FROM situation_revisions WHERE entity_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(input.id,upper);
  if(!row)fail('SITUATION_NOT_FOUND',undefined,404);
  if(c?.relationAfter!==undefined&&c.relationAfter!==''&&!id(c.relationAfter))fail('SITUATION_INVALID_CURSOR');
  const before=c?.before??Number.MAX_SAFE_INTEGER,refs=this.db.prepare('SELECT sequence,stream,source_id,domain_sequence,length(CAST(payload_json AS BLOB)) bytes FROM situation_evidence WHERE entity_id=? AND domain_sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT 500').all(input.id,upper,before);
  const items=[];let last=before,scanned=0;
  const entity=this.view(row,upper);
  const sourceKey=entity.kind==='incident'?'incident_id':'situation_id',targetKey=entity.kind==='incident'?'situation_id':'incident_id';
  const related=this.db.prepare(`SELECT ${targetKey} id FROM situation_incident_links WHERE ${sourceKey}=? AND created_sequence<=? AND ${targetKey}>? ORDER BY ${targetKey} LIMIT ?`).all(input.id,upper,c?.relationAfter||'',cap(input.limit)+1);
  const relations=related.slice(0,cap(input.limit)),relationsMore=related.length>relations.length,relationAfter=relations.at(-1)?.id||c?.relationAfter||'';
  for(const ref of refs){
   const newer=this.db.prepare('SELECT 1 FROM situation_evidence WHERE entity_id=? AND stream=? AND source_id=? AND domain_sequence>? AND domain_sequence<=? LIMIT 1').get(input.id,ref.stream,ref.source_id,ref.domain_sequence,upper);
   if(newer){last=ref.sequence;scanned++;continue;}
   if(ref.bytes>MAX_BYTES)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);
   const e=this.db.prepare('SELECT * FROM situation_evidence WHERE sequence=?').get(ref.sequence),v=parse(e.payload_json);
   const item={...v,evidenceSequence:e.sequence,domainSequence:e.domain_sequence,currentAtCut:!this.db.prepare('SELECT 1 FROM situation_invalidations WHERE stream=? AND source_id=? AND source_sequence>? AND domain_sequence<=? LIMIT 1').get(e.stream,e.source_id,e.source_sequence,upper),
    claimReferences:(v.claimIds||[]).map(claimId=>({claimId,path:`/api/news/claims/${claimId}`}))};
   if(!fits(input,{entity,relations,items:[...items,item],asOfSequence:upper,hasMore:true,nextCursor:encode({scope,upper,before:ref.sequence,relationAfter})})){if(!items.length)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);break;}
   items.push(item);last=ref.sequence;scanned++;if(items.length>=cap(input.limit))break;
  }
  const sourcesMore=Boolean(this.db.prepare('SELECT 1 FROM situation_evidence WHERE entity_id=? AND domain_sequence<=? AND sequence<? LIMIT 1').get(input.id,upper,last));
  const hasMore=sourcesMore||relationsMore;
  const base={entity,items,asOfSequence:upper,hasMore,nextCursor:hasMore?encode({scope,upper,before:sourcesMore?last:0,relationAfter}):null,scanned,relations,relationsPartial:relationsMore,methodVersion:SITUATION_METHOD};
  if(!fits(input,base))fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);return base;
 }
 revisions(input){
  if(!id(input.id))fail('SITUATION_INVALID_ID');
  const scope=stableHash(['history',input.id]),c=decode(input.cursor,scope),upper=c?.upper??this.upper(),before=c?.before??upper+1;
  const refs=this.db.prepare('SELECT sequence FROM situation_revisions WHERE entity_id=? AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(input.id,upper,before,cap(input.limit)+1);
  const items=[];for(const ref of refs){const row=this.db.prepare('SELECT * FROM situation_revisions WHERE sequence=?').get(ref.sequence),item={...parse(row.payload_json),sequence:ref.sequence,detailPath:`/api/situations/${input.id}?atSequence=${ref.sequence}`};if(items.length>=cap(input.limit)||!fits(input,{items:[...items,item],asOfSequence:upper,hasMore:true,nextCursor:encode({scope,upper,before:ref.sequence})}))break;items.push(item);}
  if(refs.length&&!items.length)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);
  const hasMore=items.length<refs.length;return {items,asOfSequence:upper,hasMore,nextCursor:hasMore?encode({scope,upper,before:items.at(-1).sequence}):null};
 }
 changes(input={}){
  const scope=stableHash(['outbox',input.sinceSequence||0]),c=decode(input.cursor,scope),upper=c?.upper??this.db.prepare('SELECT coalesce(max(sequence),0) n FROM situation_outbox').get().n,after=c?.before??input.sinceSequence??0;
  const refs=this.db.prepare('SELECT sequence FROM situation_outbox WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(after,upper,cap(input.limit)+1);
  const items=[];for(const ref of refs){const row=this.db.prepare('SELECT payload_json FROM situation_outbox WHERE sequence=?').get(ref.sequence),item={sequence:ref.sequence,...parse(row.payload_json)};if(items.length>=cap(input.limit)||!fits(input,{items:[...items,item],asOfSequence:upper,hasMore:true,nextCursor:encode({scope,upper,before:ref.sequence})}))break;items.push(item);}
  if(refs.length&&!items.length)fail('SITUATION_OUTPUT_TOO_LARGE',undefined,413);
  const hasMore=items.length<refs.length;return {items,asOfSequence:upper,hasMore,nextCursor:hasMore?encode({scope,upper,before:items.at(-1).sequence}):null,nextSinceSequence:items.at(-1)?.sequence??after,delivery:'durably recorded; reading is not an external ACK',methodVersion:SITUATION_METHOD};
 }
 review(input){
  const {requestId,action,entityId,title,reviewer,reason,references,sourceRefs=[],verification,occurredAt,occurrenceBasis}=input;
  if(!id(requestId)||!['create-incident','link-incident','verification'].includes(action)||!id(entityId)||!clean(reviewer,120)||!clean(reason,2000)||!Array.isArray(references)||!references.length||references.length>20||references.some(x=>safeUrl(x)!==x)||sourceRefs.length>25)fail('SITUATION_INVALID_REVIEW');
  if(new Set(sourceRefs.map(r=>`${r.stream}:${r.sourceId}`)).size!==sourceRefs.length)fail('SITUATION_INVALID_REVIEW');
  if(action==='verification'&&!verification)fail('SITUATION_INVALID_REVIEW');
  if(occurredAt&&(!date(occurredAt)||!clean(occurrenceBasis,500)))fail('SITUATION_INVALID_EVENT_TIME');
  return this.receipt(`review:${requestId}`,input,()=>{
   const target=this.latest(entityId);if(!target)fail('SITUATION_NOT_FOUND',undefined,404);
   if(action==='create-incident'&&(!sourceRefs.length||target.kind!=='situation'||!clean(title)))fail('SITUATION_INVALID_REVIEW');
   if(action!=='create-incident'&&target.kind!=='incident')fail('SITUATION_INVALID_REVIEW');
   const entities=new Set(),evidence=[];
   for(const ref of sourceRefs){
    if(!['news','awareness'].includes(ref.stream)||!id(ref.sourceId)||!Number.isInteger(ref.sourceRevision)||ref.sourceRevision<1)fail('SITUATION_INVALID_REVIEW');
    const member=this.db.prepare('SELECT * FROM situation_members WHERE stream=? AND source_id=?').get(ref.stream,ref.sourceId);
    if(!member||member.source_revision!==ref.sourceRevision)fail('SITUATION_STALE_OR_UNPROCESSED_EVIDENCE',undefined,409);
    const row=this.db.prepare('SELECT payload_json FROM situation_evidence WHERE entity_id=? AND stream=? AND source_id=? ORDER BY domain_sequence DESC LIMIT 1').get(member.entity_id,ref.stream,ref.sourceId);
    evidence.push({member,value:parse(row.payload_json)});entities.add(member.entity_id);
   }
   const incidentId=action==='create-incident'?`incident-${randomUUID()}`:entityId;
   const existingRefs=action==='create-incident'?[]:this.db.prepare('SELECT stream,source_id FROM situation_incident_refs WHERE incident_id=?').all(incidentId);
   const allRefs=new Set([...existingRefs.map(r=>`${r.stream}:${r.source_id}`),...sourceRefs.map(r=>`${r.stream}:${r.sourceId}`)]);
   if(allRefs.size>100)fail('SITUATION_REFERENCE_LIMIT',undefined,413);
   if(action==='create-incident')this.db.prepare('INSERT INTO situation_entities VALUES(?,?,0,?)').run(incidentId,'incident',iso(this.now()));
   const old=action==='create-incident'?null:target;
   if(verification&&!['unverified','reviewed-supported','reviewed-disputed','retracted'].includes(verification))fail('SITUATION_INVALID_REVIEW');
   const payload={...(old||{}),title:clean(title||old?.title),summary:clean(reason,1000),verification:verification||old?.verification||'unverified',
    occurredAt:occurredAt?date(occurredAt):old?.occurredAt||null,occurrenceBasis:occurredAt?{method:'attributed-operator-review',precision:'operator-supplied',reference:references,explanation:clean(occurrenceBasis,500)}:old?.occurrenceBasis||{method:'unknown',precision:'unknown'},
    lastReview:{requestId,reviewer:clean(reviewer,120),reason:clean(reason,2000),references,action},meaning:'reviewed reported incident; operator attribution is explicit'};
   const domain=this.revise(incidentId,`operator:${requestId}`,payload,{changeKind:action,historical:false});
   entities.add(action==='create-incident'?entityId:null);
   for(const situationId of entities)if(situationId)this.db.prepare('INSERT OR IGNORE INTO situation_incident_links(incident_id,situation_id,created_sequence) VALUES(?,?,?)').run(incidentId,situationId,domain.sequence);
   for(const {member,value}of evidence){
    this.db.prepare('INSERT INTO situation_incident_refs VALUES(?,?,?,?,?) ON CONFLICT(incident_id,stream,source_id) DO UPDATE SET source_revision=excluded.source_revision,source_sequence=excluded.source_sequence').run(incidentId,member.stream,member.source_id,member.source_revision,member.source_sequence);
    this.db.prepare('INSERT INTO situation_incident_ref_versions VALUES(?,?,?,?,?,?)').run(incidentId,domain.sequence,member.stream,member.source_id,member.source_revision,member.source_sequence);
    this.db.prepare('INSERT INTO situation_evidence(entity_id,domain_sequence,stream,source_id,source_revision,source_sequence,payload_json) VALUES(?,?,?,?,?,?,?)').run(incidentId,domain.sequence,member.stream,member.source_id,member.source_revision,member.source_sequence,json(value));
   }
   return {id:incidentId,revision:domain.revision,sequence:domain.sequence,review:payload.lastReview};
  });
 }
}
