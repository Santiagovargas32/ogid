import {createHash} from 'node:crypto';
import {PUBLISHERS} from './publisherIdentity.js';
import {SOURCE_ASSESSMENT_METHOD,SOURCE_IMPORT_SCHEMA} from './sourceAssessmentSchema.js';
import {validateValue} from '../../contracts/ogidOperations.js';
import {AppError} from '../../utils/error.js';
import {stableHash} from '../../utils/stableHash.js';
import {publishedSourceEvaluation,evaluationSummary,sourceEvaluationState} from '../../storage/sourceDossiers.js';

const json = JSON.stringify;
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const fail = (code,status=400) => {throw new AppError(code,status,code);};
const wireSize = data => {const payload={ok:true,queriedAt:new Date().toISOString(),origin:'OGID',data,warnings:[],truncated:false};return Buffer.byteLength(json({structuredContent:payload,content:[{type:'text',text:json(payload)}]}));};
const instant = value => {if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail('SOURCE_ASSESSMENT_INVALID_DATE');return new Date(value).toISOString();};
function reference(value) {
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(key=>/token|secret|password|signature|api.?key|auth/i.test(key)))throw Error();return url.href;}
  catch{fail('SOURCE_ASSESSMENT_INVALID_REFERENCE');}
}
function comparable(value) {const {recordedAt,...rest}=value;return stableHash(rest);}

export function publisherEdition(article,registry=PUBLISHERS) {
  if(article.publisherResolution?.status!=='resolved')return null;
  const publisher=registry.find(p=>p.publisherId===article.publisherId),domain=article.publisherResolution.domain;
  return publisher?.domains.find(base=>domain===base||domain?.endsWith(`.${base}`)) || null;
}

export class SourceAssessments {
  constructor(db=null,{now=Date.now,registry=PUBLISHERS}={}){Object.assign(this,{db,now,registry});}
  subject(publisherId,edition){
    if(!this.registry.some(p=>p.publisherId===publisherId&&p.domains.includes(edition)))fail('SOURCE_ASSESSMENT_UNKNOWN_EDITION');
  }
  importBatch(input) {
    if(!validateValue(input,SOURCE_IMPORT_SCHEMA)||Buffer.byteLength(json(input))>65536)fail('SOURCE_ASSESSMENT_INVALID_IMPORT');
    if(input.permission.redistributionAllowed!==true)fail('SOURCE_ASSESSMENT_PERMISSION_REQUIRED',403);
    const recordedAt=new Date(this.now()).toISOString(),permission={...input.permission};
    const assessments=(input.assessments||[]).map(raw=>{
      this.subject(raw.publisherId,raw.edition);
      const row={...raw,assessedAt:instant(raw.assessedAt),validFrom:instant(raw.validFrom),
        ...(raw.validUntil?{validUntil:instant(raw.validUntil)}:{}),methodUrl:reference(raw.methodUrl),licenseUrl:reference(raw.licenseUrl),evidenceUrls:raw.evidenceUrls.map(reference),usagePermission:permission,recordedAt};
      if(!row.evidenceUrls.length||Date.parse(row.assessedAt)>this.now()+300000||row.validUntil&&row.validUntil<=row.validFrom)fail('SOURCE_ASSESSMENT_INVALID_PERIOD');
      if((row.rating==='unmapped')!==(row.scaleVersion==='external-unmapped'))fail('SOURCE_ASSESSMENT_INCOMPATIBLE_SCALE');
      return row;
    });
    const profiles=(input.profiles||[]).map(raw=>{
      this.subject(raw.publisherId,raw.edition);const row={...raw,verifiedAt:instant(raw.verifiedAt),evidenceUrls:raw.evidenceUrls.map(reference),usagePermission:permission,recordedAt};
      if(!row.evidenceUrls.length||Date.parse(row.verifiedAt)>this.now()+300000||Boolean(row.ownerGroupId)!==Boolean(row.ownerGroupName))fail('SOURCE_PROFILE_INVALID');
      return row;
    });
    const dryRun=input.dryRun!==false;
    if(new Set(assessments.map(r=>r.assessmentId)).size!==assessments.length||new Set(profiles.map(r=>`${r.publisherId}:${r.edition}`)).size!==profiles.length)fail('SOURCE_ASSESSMENT_DUPLICATE_BATCH_KEY');
    if(!this.db){if(!dryRun)fail('SOURCE_ASSESSMENT_STORAGE_REQUIRED',503);return {dryRun:true,validated:assessments.length,profiles:profiles.length,inserted:0};}
    const commit=this.db.transaction(()=>{
      let inserted=0,profileInserted=0,duplicates=0;
      for(const row of assessments){
        const existing=this.db.prepare('SELECT payload_json FROM news_source_assessments WHERE assessment_id=? AND revision=?').get(row.assessmentId,row.revision);
        if(existing){if(comparable(JSON.parse(existing.payload_json))!==comparable(row))fail('SOURCE_ASSESSMENT_REVISION_CONFLICT',409);duplicates++;continue;}
        const previous=this.db.prepare('SELECT payload_json FROM news_source_assessments WHERE assessment_id=? ORDER BY revision DESC LIMIT 1').get(row.assessmentId);
        const old=previous?JSON.parse(previous.payload_json):null;
        if(row.revision!==(old?.revision||0)+1)fail('SOURCE_ASSESSMENT_REVISION_GAP',409);
        if(old&&['publisherId','edition','evaluatorId','politicalScope','methodId'].some(key=>old[key]!==row[key]))fail('SOURCE_ASSESSMENT_IDENTITY_CONFLICT',409);
        if(!dryRun)this.db.prepare('INSERT INTO news_source_assessments(assessment_id,revision,publisher_id,edition,evaluator_id,political_scope,valid_from,valid_until,recorded_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.assessmentId,row.revision,row.publisherId,row.edition,row.evaluatorId,row.politicalScope,row.validFrom,row.validUntil||null,recordedAt,json(row));
        inserted++;
      }
      for(const row of profiles){
        const existing=this.db.prepare('SELECT payload_json FROM news_publisher_profiles WHERE publisher_id=? AND edition=? AND revision=?').get(row.publisherId,row.edition,row.revision);
        if(existing){if(comparable(JSON.parse(existing.payload_json))!==comparable(row))fail('SOURCE_PROFILE_REVISION_CONFLICT',409);duplicates++;continue;}
        const previous=this.db.prepare('SELECT payload_json FROM news_publisher_profiles WHERE publisher_id=? AND edition=? ORDER BY revision DESC LIMIT 1').get(row.publisherId,row.edition);
        const old=previous?JSON.parse(previous.payload_json):null;
        if(row.revision!==(old?.revision||0)+1)fail('SOURCE_PROFILE_REVISION_GAP',409);
        if(!dryRun)this.db.prepare('INSERT INTO news_publisher_profiles(publisher_id,edition,revision,recorded_at,payload_json) VALUES(?,?,?,?,?)').run(row.publisherId,row.edition,row.revision,recordedAt,json(row));
        profileInserted++;
      }
      return {dryRun,validated:assessments.length,profiles:profiles.length,inserted:dryRun?0:inserted,profileInserted:dryRun?0:profileInserted,duplicates};
    });
    return dryRun?commit.deferred():commit.immediate();
  }
  cut(input={}) {
    const asOf=instant(input.asOf||new Date(this.now()).toISOString()),knownAt=instant(input.knownAt||asOf);
    if(Date.parse(knownAt)>this.now()+300000||Date.parse(asOf)>this.now()+300000)fail('SOURCE_ASSESSMENT_FUTURE_CUT');
    return {asOf,knownAt};
  }
  revision(){return this.db?{assessments:this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM news_source_assessments').get().n,profiles:this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM news_publisher_profiles').get().n,evaluations:this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM source_evaluation_reviews').get().n,dossiers:this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM source_evaluation_dossiers').get().n}:{assessments:0,profiles:0,evaluations:0,dossiers:0};}
  profile(publisherId,edition,{asOf,knownAt},upper) {
    const row=this.db?.prepare("SELECT payload_json FROM news_publisher_profiles WHERE publisher_id=? AND edition=? AND sequence<=? AND recorded_at<=? AND json_extract(payload_json,'$.verifiedAt')<=? ORDER BY revision DESC LIMIT 1").get(publisherId,edition,upper,knownAt,asOf);
    return row?JSON.parse(row.payload_json):null;
  }
  view(publisherId,edition,cut,upper,politicalScope) {
    const args=[publisherId,edition,upper.assessments,cut.knownAt,cut.asOf,cut.asOf,upper.assessments,cut.knownAt,cut.asOf];
    const rows=this.db?.prepare(`SELECT a.payload_json FROM news_source_assessments a WHERE a.publisher_id=? AND a.edition=? AND a.sequence<=? AND a.recorded_at<=? AND a.valid_from<=? AND (a.valid_until IS NULL OR a.valid_until>?) AND NOT EXISTS(SELECT 1 FROM news_source_assessments n WHERE n.assessment_id=a.assessment_id AND n.revision>a.revision AND n.sequence<=? AND n.recorded_at<=? AND n.valid_from<=?) ${politicalScope?'AND a.political_scope=?':''} ORDER BY a.evaluator_id,a.assessment_id LIMIT 101`).all(...args,...(politicalScope?[politicalScope]:[])) || [];
    const eligible=rows.map(r=>JSON.parse(r.payload_json)).filter(r=>r.state==='published');
    const contexts=new Set(eligible.map(r=>r.politicalScope)),ratings=new Set(eligible.map(r=>r.rating));
    const partial=rows.length>100;
    const status=partial?'partial':!eligible.length?'unrated':contexts.size>1?'different-contexts':ratings.has('unmapped')?'unmapped':ratings.size>1?'disputed':ratings.has('not-applicable')?'not-applicable':'rated';
    const profile=this.profile(publisherId,edition,cut,upper.profiles);
    const ownEvaluation=this.db?evaluationSummary(publishedSourceEvaluation(this.db,publisherId,edition,cut,upper.evaluations||0)):null;
    const ownEvaluationStatus=this.db?sourceEvaluationState(this.db,publisherId,edition,cut.knownAt,upper.dossiers||0,upper.evaluations||0):null;
    return {publisherId,edition,name:this.registry.find(p=>p.publisherId===publisherId)?.name||publisherId,status,ownEvaluation,ownEvaluationStatus,
      rating:status==='rated'?eligible[0].rating:null,evaluationCount:eligible.length,partial,
      evaluations:eligible.slice(0,5).map(r=>({assessmentId:r.assessmentId,revision:r.revision,evaluatorId:r.evaluatorId,evaluatorName:r.evaluatorName,politicalScope:r.politicalScope,rating:r.rating,originalRating:r.originalRating,methodId:r.methodId,methodVersion:r.methodVersion,assessedAt:r.assessedAt,validFrom:r.validFrom,...(r.validUntil?{validUntil:r.validUntil}:{})})),
      moreEvaluations:eligible.length>5,
      profile:profile?{revision:profile.revision,verifiedAt:profile.verifiedAt,editorialCountries:profile.editorialCountries,languages:profile.languages,ownerGroupId:profile.ownerGroupId||null,ownerGroupName:profile.ownerGroupName||null,evidenceUrls:profile.evidenceUrls,usagePermission:profile.usagePermission}:null};
  }
  catalogue(input={}) {
    const run=()=>{
      let cut=this.cut(input),upper=this.revision(),offset=0;
      const filters={publisherIds:[...(input.publisherIds||[])].sort(),politicalScope:input.politicalScope||null,edition:input.edition||null,view:input.view||'subjects'};
      if(input.cursor){
        let cursor;try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{fail('SOURCE_ASSESSMENT_INVALID_CURSOR');}
        if(cursor.filter!==hash(filters)||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||!cursor.upper||!Number.isSafeInteger(cursor.upper.assessments)||!Number.isSafeInteger(cursor.upper.profiles)||cursor.upper.assessments<0||cursor.upper.profiles<0)fail('SOURCE_ASSESSMENT_CURSOR_MISMATCH');
        if(input.asOf&&instant(input.asOf)!==cursor.asOf||input.knownAt&&instant(input.knownAt)!==cursor.knownAt)fail('SOURCE_ASSESSMENT_CURSOR_MISMATCH');
        cut=this.cut(cursor);upper=cursor.upper;offset=cursor.offset;
      }
      if(filters.view==='records')return this.recordPage(input,filters,cut,upper,offset);
      const subjects=this.registry.filter(p=>!filters.publisherIds.length||filters.publisherIds.includes(p.publisherId)).flatMap(p=>p.domains.filter(edition=>!filters.edition||filters.edition===edition).map(edition=>({publisherId:p.publisherId,edition})));
      const limit=Math.max(1,Math.min(50,Number(input.limit)||20)),maxBytes=Math.max(4096,Math.min(262144,Number(input.maxBytes)||65536));
      const data={methodVersion:SOURCE_ASSESSMENT_METHOD,...cut,revision:upper,items:[],total:subjects.length,hasMore:false,nextCursor:null,available:Boolean(this.db),meaning:'publisher assessments; not article framing or factual corroboration'};
      for(const subject of subjects.slice(offset,offset+limit)){
        data.items.push(this.view(subject.publisherId,subject.edition,cut,upper,filters.politicalScope));
        const next=offset+data.items.length;data.hasMore=next<subjects.length;
        data.nextCursor=data.hasMore?Buffer.from(json({...cut,upper,offset:next,filter:hash(filters)})).toString('base64url'):null;
        if(wireSize(data)>maxBytes-512){data.items.pop();break;}
      }
      if(!data.items.length&&offset<subjects.length)fail('SOURCE_ASSESSMENT_OUTPUT_TOO_LARGE',413);
      const next=offset+data.items.length;data.hasMore=next<subjects.length;
      data.nextCursor=data.hasMore?Buffer.from(json({...cut,upper,offset:next,filter:hash(filters)})).toString('base64url'):null;
      if(wireSize(data)>maxBytes)fail('SOURCE_ASSESSMENT_OUTPUT_TOO_LARGE',413);return data;
    };
    return this.db?this.db.transaction(run).deferred():run();
  }
  recordPage(input,filters,cut,upper,offset) {
    const where=['a.sequence>?','a.sequence<=?','a.recorded_at<=?','a.valid_from<=?',"(a.valid_until IS NULL OR a.valid_until>?)",'NOT EXISTS(SELECT 1 FROM news_source_assessments n WHERE n.assessment_id=a.assessment_id AND n.revision>a.revision AND n.sequence<=? AND n.recorded_at<=? AND n.valid_from<=?)'];
    const args=[offset,upper.assessments,cut.knownAt,cut.asOf,cut.asOf,upper.assessments,cut.knownAt,cut.asOf];
    for(const [key,column] of [['edition','edition'],['politicalScope','political_scope']])if(filters[key]){where.push(`a.${column}=?`);args.push(filters[key]);}
    if(filters.publisherIds.length){where.push(`a.publisher_id IN (${filters.publisherIds.map(()=>'?').join(',')})`);args.push(...filters.publisherIds);}
    const limit=Math.max(1,Math.min(50,Number(input.limit)||20));
    const rows=this.db?.prepare(`SELECT sequence,payload_json FROM news_source_assessments a WHERE ${where.join(' AND ')} ORDER BY a.sequence LIMIT ?`).all(...args,limit+1)||[];
    const maxBytes=Math.max(4096,Math.min(262144,Number(input.maxBytes)||65536));
    const data={methodVersion:SOURCE_ASSESSMENT_METHOD,view:'records',...cut,revision:upper,items:[],hasMore:false,nextCursor:null};
    let last=offset;
    for(const row of rows.slice(0,limit)){
      data.items.push(JSON.parse(row.payload_json));data.hasMore=true;
      data.nextCursor=Buffer.from(json({...cut,upper,offset:row.sequence,filter:hash(filters)})).toString('base64url');
      if(wireSize(data)>maxBytes-512){data.items.pop();break;}last=row.sequence;
    }
    if(!data.items.length&&rows.length)fail('SOURCE_ASSESSMENT_OUTPUT_TOO_LARGE',413);
    data.hasMore=rows.some(r=>r.sequence>last);data.nextCursor=data.hasMore?Buffer.from(json({...cut,upper,offset:last,filter:hash(filters)})).toString('base64url'):null;
    if(wireSize(data)>maxBytes)fail('SOURCE_ASSESSMENT_OUTPUT_TOO_LARGE',413);return data;
  }
  detail({assessmentId,revision,...input}) {
    const cut=this.cut(input);
    const row=this.db?.prepare(`SELECT payload_json FROM news_source_assessments WHERE assessment_id=? AND recorded_at<=? ${revision?'AND revision=?':'AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)'} ORDER BY revision DESC LIMIT 1`).get(assessmentId,cut.knownAt,...(revision?[revision]:[cut.asOf,cut.asOf]));
    if(!row)fail('SOURCE_ASSESSMENT_NOT_FOUND',404);
    return {methodVersion:SOURCE_ASSESSMENT_METHOD,...cut,assessment:JSON.parse(row.payload_json)};
  }
}
