import { listVerifiedInstruments } from '../services/market/instrumentRegistry.js';
import { stableHash } from '../utils/stableHash.js';
import { readMeta } from './sqlRepositories.js';
import { AppError } from '../utils/error.js';

const int=(v,d,max)=>v===undefined?d:Number.isSafeInteger(Number(v))&&Number(v)>0&&Number(v)<=max?Number(v):NaN;
export function historyPageOptions(input={}) {
  const out={jobsLimit:int(input.jobsLimit,50,50),legacyLimit:int(input.legacyLimit,100,100),datasetsLimit:int(input.datasetsLimit,50,100),maxBytes:int(input.maxBytes,262144,524288),jobsCursor:input.jobsCursor||null,legacyCursor:input.legacyCursor||null,datasetsCursor:input.datasetsCursor||null};
  if(Object.values(out).some(v=>Number.isNaN(v)))throw new AppError('Página administrativa inválida.',400,'INVALID_HISTORY_ARGUMENTS');
  for(const key of ['jobsCursor','legacyCursor','datasetsCursor'])if(out[key]&&(typeof out[key]!=='string'||out[key].length>2048))throw new AppError('Cursor inválido.',400,'INVALID_HISTORY_CURSOR');
  return out;
}
const cursor=(revision,key)=>Buffer.from(JSON.stringify({revision,key})).toString('base64url');
function decode(value,revision) {
  if(!value)return null;
  let parsed;try{parsed=JSON.parse(Buffer.from(value,'base64url').toString());}catch{throw new AppError('Cursor inválido.',400,'INVALID_HISTORY_CURSOR');}
  if(parsed.revision!==revision)throw new AppError('Revisión cambiada; reiniciar la página.',409,'HISTORY_REVISION_CHANGED');
  if(typeof parsed.key!=='string'||parsed.key.length>512)throw new AppError('Cursor inválido.',400,'INVALID_HISTORY_CURSOR');
  return parsed.key;
}

// Only scalar projections cross this boundary. No ResearchStore proxies and no
// job -> instrument -> full history traversal. A detail read owns its own budget.
export class AdminHistoryProjection {
  constructor(db){this.db=db;this.cache=new Map();}
  revision(input={}) {
    const options=historyPageOptions(input);
    const {jobsCursor,legacyCursor,datasetsCursor,...parameters}=options;
    return stableHash([1,readMeta(this.db,'research.revision',0),readMeta(this.db,'projection.events.status',null),this.db.prepare("SELECT coalesce(sum(records),0) AS n FROM storage_counts WHERE name IN ('candles','candle_revisions','events','acquisition_jobs')").get().n,readMeta(this.db,'candle.validationRevision',0),listVerifiedInstruments().map(i=>i.instrumentId),parameters]);
  }
  get(input={}) {
    const options=historyPageOptions(input);
    return this.db.transaction(()=>{
      const revision=this.revision(options),key=stableHash(options),hit=this.cache.get(key);
      if(hit?.revision===revision)return structuredClone(hit.value);
      const jobsAfter=decode(options.jobsCursor,revision),legacyAfter=decode(options.legacyCursor,revision),datasetsAfter=decode(options.datasetsCursor,revision);
      let legacyKey=['',0];
      if(legacyAfter){try{legacyKey=JSON.parse(legacyAfter);}catch{throw new AppError('Cursor inválido.',400,'INVALID_HISTORY_CURSOR');}}
      if(!Array.isArray(legacyKey)||legacyKey.length!==2||typeof legacyKey[0]!=='string'||!Number.isSafeInteger(legacyKey[1])||legacyKey[1]<0)throw new AppError('Cursor inválido.',400,'INVALID_HISTORY_CURSOR');
      const db=this.db;
      const projectionRows=db.prepare("SELECT identity_version AS identityVersion,count(*) AS count FROM events INDEXED BY events_by_identity GROUP BY identity_version").all();
      const projected=projectionRows.reduce((n,r)=>n+r.count,0),canonical=db.prepare("SELECT records FROM storage_collection_counts WHERE collection='events'").get()?.records||0;
      let projectionConsistent=projected===canonical&&(projected===0||readMeta(this.db,'projection.events.status',null)==='ready');
      const countsByVersion=Object.fromEntries(projectionRows.map(r=>[r.identityVersion,r.count]));
      const coverageRows=db.prepare("SELECT instrument_id AS instrumentId,count(*) AS storedBars,min(open_time) AS oldest,max(close_time) AS newest FROM candles WHERE interval='1day' AND adjustment_mode='splits' AND dataset_id='provider-yahoo' GROUP BY instrument_id").all();
      const byInstrument=new Map(coverageRows.map(r=>[r.instrumentId,r]));
      const instruments=listVerifiedInstruments().map(i=>({instrumentId:i.instrumentId,symbol:i.canonicalSymbol,currency:i.currency,missingIdentity:['companyId','calendarId','mic','isin'].filter(k=>!i[k]),coverage:{instrumentId:i.instrumentId,targetBars:500,storedBars:byInstrument.get(i.instrumentId)?.storedBars||0,validBars:null,goalMet:null,quantityGoalMet:null,oldest:byInstrument.get(i.instrumentId)?.oldest||null,newest:byInstrument.get(i.instrumentId)?.newest||null,gaps:null,continuity:'unknown',technicalEligibility:'not-evaluated',detailRequired:true}}));
      const jobRows=db.prepare(`SELECT a.job_id AS jobId,a.created_at AS createdAt,a.status,a.kind,
        json_extract(a.job_json,'$.targetBars') AS targetBars,json_extract(a.job_json,'$.instrumentIds') AS instrumentIds,
        json_extract(a.job_json,'$.cursor') AS cursor,json_array_length(a.job_json,'$.chunks') AS chunkCount,
        r.payload_json=a.job_json AS projectionMatches
        FROM acquisition_jobs a LEFT JOIN research_rows r ON r.collection='jobs' AND r.entity_id=a.job_id
        WHERE a.kind!='csv-import' ${jobsAfter?"AND (a.created_at||'|'||a.job_id)<?":''}
        ORDER BY a.created_at DESC,a.job_id DESC LIMIT ?`).all(...(jobsAfter?[jobsAfter]:[]),options.jobsLimit+1);
      const legacyRows=db.prepare(`WITH refs AS MATERIALIZED (SELECT rowid,identity_version FROM events INDEXED BY events_by_identity WHERE identity_version!='source-publication-v2' AND (identity_version,rowid)>(?,?) ORDER BY identity_version,rowid LIMIT ?)
        SELECT e.rowid AS position,e.identity_version AS identityVersion,e.event_id AS eventId,json_array_length(e.payload_json,'$.evidence') AS evidenceCount,
        e.revision=coalesce(json_extract(r.payload_json,'$.revision'),1) AND e.identity_version=coalesce(json_extract(r.payload_json,'$.identityVersion'),'legacy') AS projectionMatches
        FROM refs JOIN events e ON e.rowid=refs.rowid LEFT JOIN research_rows r ON r.collection='events' AND r.entity_id=e.event_id ORDER BY refs.identity_version,refs.rowid`).all(...legacyKey,options.legacyLimit+1);
      const datasetRows=db.prepare(`SELECT dataset_id AS datasetId,metadata_json FROM market_datasets WHERE dataset_id LIKE 'csv-%' ${datasetsAfter?'AND dataset_id>?':''} ORDER BY dataset_id LIMIT ?`).all(...(datasetsAfter?[datasetsAfter]:[]),options.datasetsLimit+1);
      if(legacyRows.some(r=>!r.projectionMatches))projectionConsistent=false;
      const value={instruments,jobs:[],datasets:[],revision,eventIdentity:{verified:projectionConsistent?(countsByVersion['source-publication-v2']||0):null,countsByVersion:projectionConsistent?countsByVersion:null,total:projectionConsistent?projected:null,projectionStatus:projectionConsistent?'consistent':'unknown',legacyRequiresReplay:[]},pagination:{},coverage:{continuity:'not-evaluated',details:'bounded history.coverage read',projectionConsistent}};
      const append=(name,rows,limit,map,id,target)=>{
        let last=null,used=0;
        for(const row of rows.slice(0,limit)){
          const item=map(row);target.push(item);
          if(Buffer.byteLength(JSON.stringify(value))+2048>options.maxBytes){target.pop();break;}
          used++;last=id(row);
        }
        const hasMore=rows.length>used;
        value.pagination[name]={limit,returned:used,hasMore,nextCursor:hasMore&&last?cursor(revision,last):null,reason:hasMore&&!last?'byte-budget':null};
      };
      append('jobs',jobRows,options.jobsLimit,r=>({...r,instrumentIds:JSON.parse(r.instrumentIds||'[]').slice(0,20),chunks:[],chunksTruncated:r.chunkCount>0,coverage:null,detailRequired:true}),r=>`${r.createdAt}|${r.jobId}`,value.jobs);
      append('legacy',legacyRows,options.legacyLimit,({position,...r})=>({...r,reason:'legacy_identity_requires_replay; excluded from impacts'}),r=>JSON.stringify([r.identityVersion,r.position]),value.eventIdentity.legacyRequiresReplay);
      append('datasets',datasetRows,options.datasetsLimit,r=>({datasetId:r.datasetId,...JSON.parse(r.metadata_json)}),r=>r.datasetId,value.datasets);
      value.coverage.serializedBytes=Buffer.byteLength(JSON.stringify(value));
      if(value.coverage.serializedBytes>options.maxBytes)throw new AppError('Presupuesto insuficiente para la proyección.',413,'HISTORY_OUTPUT_TOO_LARGE');
      this.cache.set(key,{revision,value:structuredClone(value)});while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
      return value;
    })();
  }
}
