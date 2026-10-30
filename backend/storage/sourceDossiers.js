import {AppError} from '../utils/error.js';
import {stableHash} from '../utils/stableHash.js';
import {SOURCE_CRITERIA,SOURCE_DOSSIER,DOSSIER_REVIEW} from '../services/news/sourceDossierSchema.js';
import {validateValue} from '../contracts/ogidOperations.js';

const fail=(code,status=400)=>{throw new AppError(code,status,code);};
const json=JSON.stringify;
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&![...u.searchParams.keys()].some(k=>/token|secret|password|signature|api.?key|auth/i.test(k));}catch{return false;}};
const wireSize=data=>Buffer.byteLength(json({content:[{type:'text',text:json({ok:true,data})}],structuredContent:{ok:true,data}}));
const reviewFor=(db,id,revision,knownAt,upper=Number.MAX_SAFE_INTEGER)=>db.prepare('SELECT * FROM source_evaluation_reviews WHERE dossier_id=? AND revision=? AND recorded_at<=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(id,revision,knownAt,upper);
export function sourceEvaluationState(db,publisherId,edition,knownAt,upper,reviewUpper){const d=db.prepare('SELECT dossier_id,revision FROM source_evaluation_dossiers WHERE publisher_id=? AND edition=? AND recorded_at<=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(publisherId,edition,knownAt,upper);return d?(reviewFor(db,d.dossier_id,d.revision,knownAt,reviewUpper)?.decision||'pending-review'):null;}
export function publishedSourceEvaluation(db,publisherId,edition,{asOf,knownAt},upper=Number.MAX_SAFE_INTEGER){
  const row=db.prepare(`SELECT d.*,r.decision,r.reviewer,r.reason,r.recorded_at reviewed_at,r.sequence review_sequence
    FROM source_evaluation_dossiers d JOIN source_evaluation_reviews r ON r.dossier_id=d.dossier_id AND r.revision=d.revision
    WHERE d.publisher_id=? AND d.edition=? AND d.recorded_at<=? AND r.recorded_at<=? AND r.sequence<=?
    AND json_extract(d.payload_json,'$.validFrom')<=? AND r.decision IN ('approve','withdraw') ORDER BY r.sequence DESC LIMIT 1`).get(publisherId,edition,knownAt,knownAt,upper,asOf);
  return row?.decision==='approve'?row:null;
}
export function evaluationSummary(row){
  if(!row)return null;const d=JSON.parse(row.payload_json);
  return {dossierId:d.dossierId,revision:d.revision,publisherId:d.profile.publisherId,edition:d.profile.edition,methodVersion:d.methodVersion,asOf:d.asOf,validFrom:d.validFrom,contentHash:row.content_hash,reviewedAt:row.reviewed_at,reviewer:row.reviewer,
    political:d.political,journalism:Object.fromEntries(SOURCE_CRITERIA.map(k=>[k,{status:d.journalism[k].status,summary:d.journalism[k].summary,observations:d.journalism[k].observations.length,problems:d.journalism[k].observations.filter(o=>o.outcome==='problem').length,unobservable:d.journalism[k].observations.filter(o=>o.outcome==='unobservable').length}])),sampleSize:d.sample.length,limitations:d.limitations};
}

export class SourceDossiers{
  constructor(db,{assessments,now=Date.now}={}){Object.assign(this,{db,assessments,now});}
  receipt(input,work){
    return this.db.transaction(()=>{
      const hash=stableHash(input),previous=this.db.prepare('SELECT * FROM source_evaluation_requests WHERE request_id=?').get(input.requestId);
      if(previous){if(previous.input_hash!==hash)fail('SOURCE_DOSSIER_REQUEST_CONFLICT',409);return JSON.parse(previous.result_json);}
      const result=work();this.db.prepare('INSERT INTO source_evaluation_requests VALUES(?,?,?)').run(input.requestId,hash,json(result));return result;
    }).immediate();
  }
  validate(d){
    if(!validateValue(d,SOURCE_DOSSIER))fail('SOURCE_DOSSIER_INVALID');
    this.assessments.subject(d.profile.publisherId,d.profile.edition);
    if(d.permission.basis!=='self-authored'||d.permission.redistributionAllowed!==true)fail('SOURCE_DOSSIER_PERMISSION_REQUIRED');
    const stamp=x=>new Date(x).toISOString(),asOf=stamp(d.asOf);if(Date.parse(asOf)>this.now()+300000)fail('SOURCE_DOSSIER_FUTURE_CUT');
    if(stamp(d.validFrom)>asOf||stamp(d.profile.verifiedAt)>asOf)fail('SOURCE_DOSSIER_FUTURE_CUT');
    const refs=new Map(d.evidence.map(r=>[r.id,r])),samples=new Map(d.sample.map(s=>[s.id,s]));
    if(refs.size!==d.evidence.length||samples.size!==d.sample.length||!refs.size)fail('SOURCE_DOSSIER_DUPLICATE_REFERENCE');
    const references=(ids,required=true)=>{if(required&&!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!refs.has(id)))fail('SOURCE_DOSSIER_REFERENCE_REQUIRED');};
    for(const r of refs.values())if(!safeUrl(r.url)||Date.parse(r.retrievedAt)>this.now()+300000)fail('SOURCE_DOSSIER_INVALID_REFERENCE');
    if(!d.profile.evidenceUrls.length||d.profile.evidenceUrls.some(u=>!safeUrl(u)||!d.evidence.some(r=>r.url===u)))fail('SOURCE_DOSSIER_PROFILE_REFERENCE');
    for(const s of samples.values()){
      if(!safeUrl(s.url)||stamp(s.publishedAt)>asOf||Date.parse(asOf)-Date.parse(s.publishedAt)>90*86400000||stamp(s.receivedAt)>asOf||Boolean(s.articleId)!==Boolean(s.articleRevision))fail('SOURCE_DOSSIER_SAMPLE_INVALID');
      const host=new URL(s.url).hostname;if(host!==d.profile.edition&&!host.endsWith('.'+d.profile.edition))fail('SOURCE_DOSSIER_SAMPLE_EDITION_MISMATCH');
      if(s.articleId){const row=this.db.prepare('SELECT payload_json FROM article_revisions WHERE article_id=? AND revision=?').get(s.articleId,s.articleRevision);if(!row)fail('SOURCE_DOSSIER_ARTICLE_REVISION_MISSING');const a=JSON.parse(row.payload_json);if(a.title!==s.title||a.url!==s.url||stamp(a.publishedAt)!==stamp(s.publishedAt)||stamp(a.receivedAt)!==stamp(s.receivedAt))fail('SOURCE_DOSSIER_ARTICLE_MISMATCH');}
    }
    const origins=d.sample.map(s=>s.originChainId).filter(Boolean);if(new Set(origins).size!==origins.length)fail('SOURCE_DOSSIER_DUPLICATED_ORIGIN');
    for(const fact of d.profileStatements)references(fact.evidenceIds);
    references(d.political.evidenceIds);references(d.political.counterEvidenceIds,false);
    if(new Set(d.political.sampleIds).size!==d.political.sampleIds.length||d.political.sampleIds.some(id=>!samples.has(id)))fail('SOURCE_DOSSIER_SAMPLE_INVALID');
    if(d.political.rating!==null&&d.political.status!=='supported'||['supported','mixed'].includes(d.political.status)&&d.political.sampleIds.length<10)fail('SOURCE_DOSSIER_POLITICAL_EVIDENCE_REQUIRED');
    for(const k of SOURCE_CRITERIA){
      const c=d.journalism[k];references(c.evidenceIds);
      if(new Set(c.observations.map(o=>o.sampleId)).size!==c.observations.length)fail('SOURCE_DOSSIER_DUPLICATE_OBSERVATION');
      for(const o of c.observations){if(!samples.has(o.sampleId))fail('SOURCE_DOSSIER_SAMPLE_INVALID');references(o.evidenceIds,o.outcome!=='unobservable');}
      const good=c.observations.filter(o=>o.outcome==='supported').length,bad=c.observations.filter(o=>o.outcome==='problem').length;
      if(c.status==='backed'&&(!good||bad)||c.status==='mixed'&&(!good||!bad)||c.status==='problems'&&!bad||c.status==='insufficient-evidence'&&(good||bad))fail('SOURCE_DOSSIER_CRITERION_INCONSISTENT');
    }
    return d;
  }
  propose(input){return this.receipt(input,()=>{
    const d=this.validate(input.dossier);if(Buffer.byteLength(json(input))>65536)fail('SOURCE_DOSSIER_TOO_LARGE',413);
    const previous=this.db.prepare('SELECT * FROM source_evaluation_dossiers WHERE dossier_id=? ORDER BY revision DESC LIMIT 1').get(d.dossierId);
    if(d.revision!==(previous?.revision||0)+1)fail('SOURCE_DOSSIER_REVISION_CONFLICT',409);
    if(previous&&(previous.publisher_id!==d.profile.publisherId||previous.edition!==d.profile.edition))fail('SOURCE_DOSSIER_SUBJECT_CONFLICT',409);
    const contentHash=stableHash(d);this.db.prepare('INSERT INTO source_evaluation_dossiers(dossier_id,revision,publisher_id,edition,recorded_at,content_hash,payload_json) VALUES(?,?,?,?,?,?,?)').run(d.dossierId,d.revision,d.profile.publisherId,d.profile.edition,new Date(this.now()).toISOString(),contentHash,json(d));
    return {dossierId:d.dossierId,revision:d.revision,contentHash,status:'pending-review'};
  });}
  review(input){if(!validateValue(input,{type:'object',properties:DOSSIER_REVIEW,required:Object.keys(DOSSIER_REVIEW),additionalProperties:false}))fail('SOURCE_DOSSIER_REVIEW_INVALID');return this.receipt(input,()=>{
    const row=this.db.prepare('SELECT * FROM source_evaluation_dossiers WHERE dossier_id=? AND revision=?').get(input.dossierId,input.revision);
    if(!row)fail('SOURCE_DOSSIER_NOT_FOUND',404);if(row.content_hash!==input.contentHash)fail('SOURCE_DOSSIER_REVIEW_CONFLICT',409);
    const latest=this.db.prepare('SELECT max(revision) revision FROM source_evaluation_dossiers WHERE dossier_id=?').get(input.dossierId).revision;
    if(latest!==input.revision)fail('SOURCE_DOSSIER_REVIEW_STALE',409);
    const stamp=new Date(this.now()).toISOString(),previous=reviewFor(this.db,input.dossierId,input.revision,stamp);
    if(input.decision==='withdraw'?previous?.decision!=='approve':Boolean(previous))fail('SOURCE_DOSSIER_ALREADY_REVIEWED',409);
    const d=JSON.parse(row.payload_json);
    if(input.decision==='approve'){
      const profile={...d.profile};const records=this.assessments.importBatch({requestId:input.requestId,dryRun:false,permission:d.permission,profiles:[profile]});
      if(!records.profileInserted&&!records.duplicates)fail('SOURCE_DOSSIER_PROFILE_NOT_PUBLISHED',409);
    }
    this.db.prepare('INSERT INTO source_evaluation_reviews(dossier_id,revision,content_hash,decision,reviewer,reason,recorded_at) VALUES(?,?,?,?,?,?,?)').run(input.dossierId,input.revision,input.contentHash,input.decision,input.reviewer,input.reason,stamp);
    return {dossierId:input.dossierId,revision:input.revision,contentHash:row.content_hash,decision:input.decision,reviewedAt:stamp};
  });}
  cut(input){return this.assessments.cut(input);}
  list(input={},internal=false){return this.db.transaction(()=>{
    let cut=this.cut(input),upper=this.db.prepare('SELECT coalesce(max(sequence),0) n FROM source_evaluation_dossiers').get().n,reviewUpper=this.db.prepare('SELECT coalesce(max(sequence),0) n FROM source_evaluation_reviews').get().n,after=0;
    const filters={publisherId:input.publisherId||null,edition:input.edition||null,internal};
    if(input.cursor){let c;try{c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{fail('SOURCE_DOSSIER_CURSOR_INVALID');}if(c.filter!==stableHash(filters)||!Number.isSafeInteger(c.after)||!Number.isSafeInteger(c.upper)||!Number.isSafeInteger(c.reviewUpper)||c.after<0||c.upper<0||c.reviewUpper<0)fail('SOURCE_DOSSIER_CURSOR_INVALID');cut=this.cut(c);if(input.asOf&&new Date(input.asOf).toISOString()!==cut.asOf||input.knownAt&&new Date(input.knownAt).toISOString()!==cut.knownAt)fail('SOURCE_DOSSIER_CURSOR_INVALID');({upper,reviewUpper,after}=c);}
    const rows=this.db.prepare(`SELECT publisher_id,edition,max(sequence) seq FROM source_evaluation_dossiers WHERE sequence<=? AND recorded_at<=? ${filters.publisherId?'AND publisher_id=?':''} ${filters.edition?'AND edition=?':''} GROUP BY publisher_id,edition HAVING max(sequence)>? ORDER BY seq LIMIT 51`).all(upper,cut.knownAt,...(filters.publisherId?[filters.publisherId]:[]),...(filters.edition?[filters.edition]:[]),after);
    const result={methodVersion:'ogid-source-review-v1',...cut,items:[],hasMore:false,nextCursor:null},limit=Math.min(30,Number(input.limit)||10),maxBytes=Math.min(262144,Number(input.maxBytes)||65536);let last=after;
    for(const subject of rows){
      let value;if(internal){const d=this.db.prepare('SELECT * FROM source_evaluation_dossiers WHERE sequence=?').get(subject.seq),r=reviewFor(this.db,d.dossier_id,d.revision,cut.knownAt,reviewUpper);value={...evaluationSummary({...d,reviewed_at:r?.recorded_at,reviewer:r?.reviewer}),status:r?.decision||'pending-review'};}
      else value=evaluationSummary(publishedSourceEvaluation(this.db,subject.publisher_id,subject.edition,cut,reviewUpper));
      if(value){result.items.push(value);if(wireSize(result)>maxBytes-1024){result.items.pop();if(!result.items.length)fail('SOURCE_DOSSIER_OUTPUT_TOO_LARGE',413);break;}}
      last=subject.seq;if(result.items.length>=limit)break;
    }
    result.hasMore=rows.some(r=>r.seq>last)||rows.length===51;result.nextCursor=result.hasMore?Buffer.from(json({...cut,upper,reviewUpper,after:last,filter:stableHash(filters)})).toString('base64url'):null;
    if(wireSize(result)>maxBytes)fail('SOURCE_DOSSIER_OUTPUT_TOO_LARGE',413);return result;
  }).deferred();}
  detail(input={},internal=false){return this.db.transaction(()=>{
    let cut=this.cut(input),cursor=null;if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{fail('SOURCE_DOSSIER_CURSOR_INVALID');}if(!cursor.cut)fail('SOURCE_DOSSIER_CURSOR_INVALID');const frozen=this.cut(cursor.cut);if(input.asOf&&new Date(input.asOf).toISOString()!==frozen.asOf||input.knownAt&&new Date(input.knownAt).toISOString()!==frozen.knownAt)fail('SOURCE_DOSSIER_CURSOR_INVALID');cut=frozen;}
    let row=this.db.prepare(`SELECT * FROM source_evaluation_dossiers WHERE dossier_id=? AND recorded_at<=? ${input.revision?'AND revision=?':''} ORDER BY revision DESC LIMIT 1`).get(input.dossierId,cut.knownAt,...(input.revision?[input.revision]:[]));
    if(!row)fail('SOURCE_DOSSIER_NOT_FOUND',404);const published=publishedSourceEvaluation(this.db,row.publisher_id,row.edition,cut);
    if(!internal&&!input.revision){if(!published||published.dossier_id!==input.dossierId)fail('SOURCE_DOSSIER_NOT_FOUND',404);row=published;}
    const review=reviewFor(this.db,row.dossier_id,row.revision,cut.knownAt);
    if(!internal&&(review?.decision!=='approve'||new Date(JSON.parse(row.payload_json).validFrom).toISOString()>cut.asOf))fail('SOURCE_DOSSIER_NOT_FOUND',404);
    const d=JSON.parse(row.payload_json),section=input.section||'overview',all=section==='evidence'?d.evidence:section==='sample'?d.sample:section==='observations'?SOURCE_CRITERIA.flatMap(k=>d.journalism[k].observations.map(o=>({criterion:k,...o}))):[];
    let offset=0;const key=stableHash([row.content_hash,section,cut]);if(cursor){if(cursor.key!==key||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)fail('SOURCE_DOSSIER_CURSOR_INVALID');offset=cursor.offset;}
    const data={...cut,...evaluationSummary({...row,reviewed_at:review?.recorded_at,reviewer:review?.reviewer}),status:review?.decision||'pending-review',section,profile:d.profile,profileStatements:d.profileStatements,selection:d.selection,items:[],hasMore:false,nextCursor:null};
    const limit=Math.min(30,Number(input.limit)||10),maxBytes=Math.min(262144,Number(input.maxBytes)||65536);
    for(const item of all.slice(offset,offset+limit)){data.items.push(item);if(wireSize(data)>maxBytes-1024){data.items.pop();break;}}
    if(all.length>offset&&!data.items.length)fail('SOURCE_DOSSIER_OUTPUT_TOO_LARGE',413);
    data.hasMore=offset+data.items.length<all.length;data.nextCursor=data.hasMore?Buffer.from(json({key,cut,offset:offset+data.items.length})).toString('base64url'):null;
    if(wireSize(data)>maxBytes)fail('SOURCE_DOSSIER_OUTPUT_TOO_LARGE',413);return data;
  }).deferred();}
}
