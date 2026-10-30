import {getInstrumentById} from '../services/market/instrumentRegistry.js';
import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';
import {ANALYSIS_SECTIONS} from '../services/situations/analysisSchema.js';
import {publishedSourceEvaluation,evaluationSummary} from './sourceDossiers.js';
const fail=(code,status=400)=>{throw new AppError(code,status,code);};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);
const json=JSON.stringify;
const read=(db,sql,...args)=>db.prepare(sql).get(...args);
export function requestAnalysis(repo,{requestId,situationId,baselineAnalysisId},model){
 if(!identifier(requestId)||!identifier(situationId)||baselineAnalysisId&&!identifier(baselineAnalysisId))fail('AGENT_INVALID_ARGUMENTS');
 const input={situationId,baselineAnalysisId:baselineAnalysisId||null},hash=stableHash(input);
 return repo.db.transaction(()=>{
  const previous=read(repo.db,'SELECT * FROM situation_analysis_requests WHERE request_id=?',requestId);
  if(previous){if(previous.input_hash!==hash)fail('AGENT_IDEMPOTENCY_CONFLICT',409);return {jobId:previous.job_id,replayed:true};}
  if(!read(repo.db,'SELECT 1 FROM situation_entities WHERE entity_id=?',situationId))fail('SITUATION_NOT_FOUND',404);
  if(baselineAnalysisId&&!read(repo.db,"SELECT 1 FROM agent_publications WHERE publication_id=? AND scope=? AND task='situation_analysis'",baselineAnalysisId,situationId))fail('AGENT_INVALID_BASELINE');
  const result=repo.enqueue({task:'situation_analysis',scope:situationId,model,key:`situation-analysis:${requestId}`,priority:10,input});
  repo.db.prepare('INSERT INTO situation_analysis_requests VALUES(?,?,?)').run(requestId,hash,result.jobId);
  return result;
 }).immediate();
}
export function prepareAnalysis(repo,job,{rowSink,maxPreparationMs}){
 const started=performance.now(),asOf=new Date(repo.now()).toISOString(),snapshotId=randomUUID(),upper=repo.situations.upper();
 const rows={evidence:[],clusters:[],members:[]},counts={evidence:0,clusters:0,members:0},hashes=[],instruments=new Set();let bytes=0;
 const input=JSON.parse(job.input_json),baseline=input.baselineAnalysisId?read(repo.db,'SELECT payload_json FROM agent_publications WHERE publication_id=?',input.baselineAnalysisId):null;
 const add=(id,domain,data)=>{
  const payload=json(data),row=[id,domain,asOf,null,null,payload];bytes+=Buffer.byteLength(payload);
  if(bytes>2*1024*1024)fail('AGENT_SNAPSHOT_TOO_LARGE',413);
  if(performance.now()-started>maxPreparationMs)fail('AGENT_SNAPSHOT_PREPARATION_TIMEOUT',503);
  hashes.push(stableHash(row));counts.evidence++;
  if(rowSink)rowSink('evidence',row);else rows.evidence.push(row);
 };
 const descriptor=repo.situations.detail({id:job.scope,atSequence:upper,limit:1});
 let cursor,more=true,captured=0,scanned=0,truncated=false;const seen=new Set();
 while(more&&captured<100&&scanned<500){
  const page=repo.situations.detail({id:job.scope,atSequence:upper,cursor,limit:20,maxBytes:65536});scanned+=page.scanned;
  for(const item of page.items){
   if(captured>=100){truncated=true;break;}
   const key=`${item.stream}:${item.sourceId}`;if(seen.has(key))continue;seen.add(key);
   const quality=item.stream==='news'?read(repo.db,"SELECT json_extract(payload_json,'$.stale') stale,json_extract(payload_json,'$.quality.stale') quality_stale,json_extract(payload_json,'$.provenance.stale') provenance_stale FROM article_revisions WHERE article_id=? AND revision=?",item.sourceId,item.sourceRevision):null;
   if(quality?.stale||quality?.quality_stale||quality?.provenance_stale)continue;
   if(!item.currentAtCut||!item.eligible||item.synthetic||item.stale||['synthetic','fallback','seeded','stale'].includes(item.dataMode))continue;
   for(const id of item.instrumentIds||[])if(identifier(id)&&getInstrumentById(id)?.verificationStatus==='verified'&&instruments.size<50)instruments.add(id);
   // Domain projection contains permitted metadata/claims, never full article bodies.
   const data={...item,citationRole:'attributed-source',knownAt:read(repo.db,'SELECT changed_at FROM situation_revisions WHERE sequence=?',item.domainSequence)?.changed_at||asOf,occurredAt:item.occurredAt||null,publishedAt:item.publishedAt||null};
   add(`situation-source:${item.evidenceSequence}`,'situation-source',data);captured++;
   const profile=item.publisherId?publishedSourceEvaluation(repo.db,item.publisherId,item.edition||'default',{asOf,knownAt:asOf}):null;
   if(profile){const id=`source-profile:${profile.dossier_id}:${profile.revision}`;if(!seen.has(id)){seen.add(id);add(id,'source-profile',{...evaluationSummary(profile),reviewSequence:profile.review_sequence});}}
  }
  more=page.hasMore||truncated;cursor=page.nextCursor;
 }
 for(const instrumentId of instruments){
  const ref=read(repo.db,"SELECT analysis_id,generated_at,length(CAST(payload_json AS BLOB)) bytes FROM analysis_runs INDEXED BY analysis_runs_instrument_time WHERE kind IN ('technical.get','indicators.calculate') AND kind='technical.get' AND generated_at<=? AND json_extract(payload_json,'$.instrumentId')=? AND json_extract(payload_json,'$.interval')='1day' ORDER BY generated_at DESC LIMIT 1",asOf,instrumentId);
  if(ref&&ref.bytes<=131072){const data=JSON.parse(read(repo.db,'SELECT payload_json FROM analysis_runs WHERE analysis_id=?',ref.analysis_id).payload_json);add(`technical:${ref.analysis_id}`,'technical.get',data);}
 }
 if(baseline)add(`baseline:${input.baselineAnalysisId}`,'analysis-baseline',{derived:true,analysisId:input.baselineAnalysisId,proposal:JSON.parse(baseline.payload_json).proposal});
 const manifest={sealed:true,complete:!more,partial:more,reasonCodes:more?['bounded-situation-selection']:['collected-sources-only'],situationId:job.scope,domainSequence:upper,situationRevision:descriptor.entity.revision,baselineAnalysisId:input.baselineAnalysisId||null,selectedInstrumentIds:[...instruments],capturedSources:captured,scanned,methodVersion:'situation-analysis-v1',domains:{'situation-source':{count:captured,freeze:'immutable-domain-revisions'}},reviewCoverage:'not-a-read-receipt',evidenceCount:counts.evidence+1};
 add(`coverage:${snapshotId}`,'coverage',{...manifest,citationRole:'coverage-only; never claim evidence',entity:descriptor.entity,limitations:['Collected reports, not verified incidents. Origin independence may be unknown. No live acquisition. Numeric market observations not included unless explicitly frozen.']});
 manifest.sha256=stableHash(hashes);
 if(rowSink)rows.evidence={length:counts.evidence};
 return {snapshotId,asOf,scope:job.scope,manifest,rows};
}
export function commitAnalysisDependencies(repo,publicationId,snapshotId,proposal){
 const insert=repo.db.prepare('INSERT INTO situation_analysis_dependencies VALUES(?,?,?,?,?,?)');
 for(const id of proposal.evidenceIds){
  const row=read(repo.db,"SELECT payload_json FROM agent_evidence WHERE snapshot_id=? AND evidence_id=? AND domain='situation-source'",snapshotId,id);
  if(!row)continue;const data=JSON.parse(row.payload_json);
  insert.run(publicationId,id,data.stream,data.sourceId,data.sourceRevision,data.sourceSequence);
 }
}
export function analysisCurrentness(repo,snapshotId){
 const info=repo.snapshotInfo(snapshotId),coverage=info.coverage;
 const items=[];const rows=repo.db.prepare("SELECT evidence_id,payload_json FROM agent_evidence WHERE snapshot_id=? AND domain='situation-source' LIMIT 101").all(snapshotId);
 for(const row of rows){
  const data=JSON.parse(row.payload_json),table=data.stream==='news'?'articles':'awareness_events',key=data.stream==='news'?'article_id':'event_id';
  const live=read(repo.db,`SELECT revision FROM ${table} WHERE ${key}=?`,data.sourceId);
  const invalidation=read(repo.db,'SELECT reason FROM situation_invalidations WHERE stream=? AND source_id=? AND source_sequence>? ORDER BY sequence DESC LIMIT 1',data.stream,data.sourceId,data.sourceSequence);
  if(!live||live.revision!==data.sourceRevision||invalidation)items.push({evidenceId:row.evidence_id,reason:invalidation?.reason||(!live?'source-unavailable':'source-revised')});
 }
 const technical=repo.db.prepare("SELECT evidence_id,payload_json FROM agent_evidence WHERE snapshot_id=? AND domain='technical.get' LIMIT 50").all(snapshotId);
 for(const row of technical){const data=JSON.parse(row.payload_json);const live=read(repo.db,"SELECT json_extract(payload_json,'$.seriesRevision') series_revision FROM analysis_runs INDEXED BY analysis_runs_instrument_time WHERE kind IN ('technical.get','indicators.calculate') AND kind='technical.get' AND json_extract(payload_json,'$.instrumentId')=? AND json_extract(payload_json,'$.interval')='1day' ORDER BY generated_at DESC LIMIT 1",data.instrumentId);if(live?.series_revision!==data.seriesRevision)items.push({evidenceId:row.evidence_id,reason:'technical-series-revised'});}
 const profiles=repo.db.prepare("SELECT evidence_id,payload_json FROM agent_evidence WHERE snapshot_id=? AND domain='source-profile' LIMIT 100").all(snapshotId);
 for(const row of profiles){const data=JSON.parse(row.payload_json),live=publishedSourceEvaluation(repo.db,data.publisherId,data.edition,{asOf:new Date(repo.now()).toISOString(),knownAt:new Date(repo.now()).toISOString()});if(!live||live.content_hash!==data.contentHash||live.review_sequence!==data.reviewSequence)items.push({evidenceId:row.evidence_id,reason:'source-profile-revised'});}
 const current=items.length===0&&rows.length<=100;
 return {current,partial:rows.length>100,items:items.slice(0,20),checkedReferences:rows.length,updateAvailable:Boolean(read(repo.db,'SELECT 1 FROM situation_revisions WHERE entity_id=? AND sequence>? LIMIT 1',coverage.situationId,coverage.domainSequence))};
}
function publication(repo,row){
 const data=JSON.parse(row.payload_json),sourceCurrentness=analysisCurrentness(repo,row.snapshot_id);
 return {analysisId:row.publication_id,jobId:row.job_id,situationId:row.scope,snapshotId:row.snapshot_id,mode:row.mode,publishedAt:row.published_at,summary:data.proposal.summary,model:data.model,generationVersion:data.promptVersion,coverage:data.coverage,sourceCurrentness,status:!sourceCurrentness.current?'needs-review':Date.parse(row.valid_until)<=repo.now()?'stale':'ready'};
}
function cursorDecode(value,scope){try{const data=JSON.parse(Buffer.from(value,'base64url'));if(data.scope!==scope||!Number.isSafeInteger(data.upper)||!Number.isSafeInteger(data.after)||data.after<0||data.upper<0)throw 0;return data;}catch{fail('AGENT_INVALID_CURSOR');}}
export function readAnalyses(repo,input={}){
 const {id,section,situationId}=input,limit=Math.max(1,Math.min(100,Number(input.limit)||20)),maxBytes=Math.max(4096,Math.min(65536,Number(input.maxBytes)||32768));
 const scope=stableHash([id||null,section||null,situationId||null]);let items,upper,after=0,base={mode:'shadow'};
 const c=input.cursor?cursorDecode(input.cursor,scope):null;
 if(id){
  const row=read(repo.db,"SELECT * FROM agent_publications WHERE publication_id=? AND task='situation_analysis'",id);
  if(!row)fail('AGENT_ANALYSIS_NOT_FOUND',404);base=publication(repo,row);
  if(!section)return base;
  if(!ANALYSIS_SECTIONS.includes(section)&&section!=='contradictions'&&section!=='limitations'&&section!=='missingEvidence')fail('AGENT_INVALID_ARGUMENTS');
  const all=JSON.parse(row.payload_json).proposal[section];upper=all.length;after=c?.after||0;items=all.slice(after,after+limit+1);
 }else{
  upper=c?.upper??read(repo.db,'SELECT coalesce(max(rowid),0) n FROM agent_publications').n;after=c?.after||0;
  items=repo.db.prepare("SELECT rowid,* FROM agent_publications WHERE task='situation_analysis' AND rowid>? AND rowid<=? AND (? IS NULL OR scope=?) ORDER BY rowid LIMIT ?").all(after,upper,situationId||null,situationId||null,limit+1);
 }
 if(!id)base.jobs=repo.db.prepare("SELECT job_id jobId,scope situationId,status,error_code errorCode,updated_at updatedAt FROM agent_jobs WHERE task='situation_analysis' AND (? IS NULL OR scope=?) ORDER BY created_at DESC LIMIT 20").all(situationId||null,situationId||null);
 const result=[];let next=after;
 for(const item of items.slice(0,limit)){
  const value=id?item:publication(repo,item),candidate={...base,items:[...result,value]};
  if(Buffer.byteLength(json(candidate))*3+4096>maxBytes){if(!result.length)fail('AGENT_OUTPUT_TOO_LARGE',413);break;}
  result.push(value);next=id?next+1:item.rowid;
 }
 const hasMore=items.length>result.length;
 return {...base,section:section||null,items:result,hasMore,nextCursor:hasMore?Buffer.from(json({scope,upper,after:next})).toString('base64url'):null};
}
