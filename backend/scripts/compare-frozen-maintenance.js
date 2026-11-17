import Database from 'better-sqlite3';
import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {AdvancedSnapshots} from '../storage/advancedSnapshots.js';
import {SituationStore} from '../storage/situations.js';
import {AgentMaintenance} from '../services/agent/maintenance.js';
import {cacheStatements} from '../storage/statementCache.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {stableHash} from '../utils/stableHash.js';
import {writeMeta} from '../storage/sqlRepositories.js';

const MAX_BYTES=64*1024*1024;
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const identity=file=>{const s=statSync(file);return {dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs};};
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});

// Capture one already completed real request, never a new job on the source.
// This is an instrumental subset of storage, not a full database clone or an
// acquisition/pressure/semantic acceptance test. Run under an external watchdog.
export function freezeMaintenanceInput(source,destination){
  if(existsSync(destination))throw Error('Frozen destination already exists');
  const before=identity(source),db=new Database(source,{readonly:true,timeout:1500});
  db.pragma('query_only=ON');
  let frozen;
  try{
    db.exec('BEGIN');
    const job=db.prepare("SELECT job_id,as_of,input_json FROM analysis_jobs WHERE status='complete' ORDER BY as_of DESC LIMIT 1").get();
    if(!job)throw Error('A completed advanced job is required');
    const input=JSON.parse(job.input_json),asOf=job.as_of,watermark=input.revisions.articleWatermark;
    const from=new Date(Date.parse(asOf)-input.options.windowHours*2*3600000).toISOString();
    const rows=[];let bytes=0;
    const query=db.prepare(`SELECT r.rowid AS sourceRowid,r.* FROM article_revisions r INDEXED BY article_revisions_window
      WHERE r.rowid<=? AND r.observed_at<=? AND json_extract(r.payload_json,'$.publishedAt')>=?
      AND json_extract(r.payload_json,'$.publishedAt')<=?
      AND NOT EXISTS (SELECT 1 FROM article_revisions newer INDEXED BY article_revisions_available
        WHERE newer.article_id=r.article_id AND newer.observed_at<=? AND newer.rowid<=? AND newer.revision>r.revision)
      ORDER BY r.rowid`);
    for(const row of query.iterate(watermark,asOf,from,asOf,asOf,watermark)){
      bytes+=Buffer.byteLength(row.payload_json);if(bytes>MAX_BYTES)throw Error('Frozen input exceeds byte budget; no partial comparison');
      rows.push(row);
    }
    const signals=db.prepare("SELECT * FROM derived_observations WHERE kind='signals' AND observed_at<=? ORDER BY observed_at DESC LIMIT 1").get(asOf);
    const legacySignals=signals?null:db.prepare("SELECT * FROM runtime_snapshots WHERE kind='signals' AND updated_at<=?").get(asOf);
    const rollout=db.prepare('SELECT applied_at FROM schema_migrations WHERE version=9').get();
    const anchor=rows.some(r=>r.sourceRowid===watermark)?null:db.prepare('SELECT rowid AS sourceRowid,* FROM article_revisions WHERE rowid=?').get(watermark);
    frozen={schemaVersion:'maintenance-frozen-v1',sourceJobId:job.job_id,asOf,input,rows,anchor:anchor||null,signals:signals||null,legacySignals:legacySignals||null,rollout,
      coverage:{from,to:asOf,articleRows:rows.length,payloadBytes:bytes,completeWindow:true,
        excluded:'outside-window, future/unknown publications, superseded revisions; no candles, acquisition or other historical tables'}};
    db.exec('COMMIT');
  }finally{db.close();}
  const after=identity(source);
  if(stableHash(before)!==stableHash(after))throw Error('Source changed during capture');
  json(destination,{...frozen,source:{path:realpathSync(source),before,after},inputHash:stableHash(frozen)});
  return {file:destination,sha256:digest(destination),...frozen.coverage};
}

function validateFrozen(frozen){
  const {source,inputHash,...payload}=frozen;
  if(frozen.schemaVersion!=='maintenance-frozen-v1'||stableHash(payload)!==inputHash)throw Error('Frozen input hash mismatch');
  if(!Number.isFinite(Date.parse(frozen.asOf))||!Number.isSafeInteger(frozen.input?.revisions?.articleWatermark)||!Array.isArray(frozen.rows)||!frozen.coverage?.completeWindow)throw Error('Invalid frozen input');
  if(frozen.rows.reduce((n,r)=>n+Buffer.byteLength(r.payload_json),0)>MAX_BYTES)throw Error('Frozen input exceeds budget');
}

function seedDatabase(file,frozen){
  const db=new Database(file);let archive;
  try{
    db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('foreign_keys=ON');migrate(db);
    archive=new SqlNewsArchive(db,{analysisOnly:true});
    const rows=[...frozen.rows,...(frozen.anchor?[frozen.anchor]:[])].sort((a,b)=>a.sourceRowid-b.sourceRowid);
    for(let offset=0;offset<rows.length;offset+=100)db.transaction(()=>{
      for(const row of rows.slice(offset,offset+100)){
        archive.save(JSON.parse(row.payload_json));
        db.prepare('UPDATE article_revisions SET rowid=?,observed_at=?,payload_json=? WHERE article_id=? AND revision=?')
          .run(row.sourceRowid,row.observed_at,row.payload_json,row.article_id,row.revision);
      }
    }).immediate();
    writeMeta(db,'news.meta',{revision:frozen.input.revisions.news});
    writeMeta(db,'signals.revision',frozen.input.revisions.signals);
    if(frozen.signals){const r=frozen.signals;db.prepare('INSERT INTO derived_observations VALUES(?,?,?,?)').run(r.kind,r.input_hash,r.observed_at,r.payload_json);}
    if(frozen.legacySignals){const r=frozen.legacySignals;db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run(r.kind,r.updated_at,r.payload_json);}
    if(frozen.rollout)db.prepare('UPDATE schema_migrations SET applied_at=? WHERE version=9').run(frozen.rollout.applied_at);
    db.pragma('wal_checkpoint(TRUNCATE)');
  }finally{archive?.close();db.close();}
}

const difference=(after,before)=>Object.fromEntries(['transactions','statements','rowsChanged','bindingBytes'].map(k=>[k,after[k]-before[k]]));
const walBytes=file=>existsSync(file+'-wal')?statSync(file+'-wal').size:0;
function content(db){return Object.fromEntries(['analysis_runs','analysis_inputs','analysis_jobs','analysis_latest'].map(table=>[table,db.prepare('SELECT count(*) n FROM '+table).get().n]));}

export async function compareFrozenMaintenance(inputFile,outputDir){
  const inputFileHash=digest(inputFile),frozen=JSON.parse(readFileSync(inputFile,'utf8'));validateFrozen(frozen);
  // Refuse an existing directory; never mutate a source DB or previous evidence.
  mkdirSync(outputDir,{mode:0o700});
  const seed=join(outputDir,'seed.sqlite');seedDatabase(seed,frozen);const seedHash=digest(seed),results=[];
  const OriginalDate=Date,fixedTime=Date.parse(frozen.asOf);
  // Date.now alone does not freeze new Date() defaults in analytical reads.
  // This standalone diagnostic owns its process clock until every run closes.
  globalThis.Date=class extends OriginalDate{
    constructor(...args){super(...(args.length?args:[fixedTime]));}
    static now(){return fixedTime;}
  };
  try{
    for(const [index,mode]of ['continuous','on-demand','on-demand','continuous'].entries()){
      const file=join(outputDir,`${index+1}-${mode}.sqlite`);copyFileSync(seed,file);
      if(digest(file)!==seedHash)throw Error('Initial database mismatch');
      const db=new Database(file),activity=new SqlActivity(createSqlActivityBuffer()),operations=[],errors=[];
      let runtime,maintenance;
      try{
        db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('foreign_keys=ON');
        trackTransactions(db,activity);cacheStatements(db,256,{activity});
        runtime=new BusinessRuntime(db,()=>{throw Error('Network/RPC is forbidden in frozen comparison');});
        runtime.configure({rootDir:outputDir,instruments:[],rss:{rssFeeds:[]},news:{analyzeLimit:3000,displayLimit:40,rssFeeds:[]}});
        runtime.advancedSnapshots=new AdvancedSnapshots(runtime,{now:Date.now});
        const context={...structuredClone(runtime.defaultContext),...structuredClone(frozen.input.context)},versions={...frozen.input.revisions};
        // Rowids and news/signal/context inputs are preserved; the subset seed
        // deliberately omits unrelated data. Never claim full runtime parity.
        async function measure(operation,work){
          const before=activity.writeMetrics.status(),walBefore=walBytes(file),countsBefore=content(db),cpu=process.cpuUsage(),started=performance.now();
          let value;
          try{value=await work();}catch(error){errors.push({operation,code:error.code,message:error.message,stack:error.stack});throw error;}
          const ms=performance.now()-started,usage=process.cpuUsage(cpu),after=activity.writeMetrics.status();
          operations.push({operation,ms,cpuMicros:usage,writes:difference(after.total,before.total),
            buckets:Object.fromEntries(Object.entries(after.buckets).map(([k,v])=>[k,difference(v,before.buckets[k]||{transactions:0,statements:0,rowsChanged:0,bindingBytes:0})]).filter(([,v])=>v.statements)),
            walFileBytes:{before:walBefore,after:walBytes(file)},countsBefore,countsAfter:content(db),
            resultHash:stableHash(operation==='alertSync'?{...value,durationMs:undefined}:value)});
          return value;
        }
        const advanced=async()=>{
          const pending=runtime.advancedSnapshots.prepare({options:frozen.input.options,context});
          if(!pending.dispatchJobId)return runtime.advancedSnapshots.status(pending.lifecycle.jobId);
          const job=runtime.advancedSnapshots.claim({jobId:pending.dispatchJobId,owner:'frozen-comparison'});
          if(stableHash(job.revisions)!==stableHash(versions))throw Error('Effective revisions differ from frozen request');
          const result=await runtime.call({service:'advanced',method:'getSnapshot',args:[{...job.options,force:true,asOf:job.asOf}],context:job.context,analysisJob:job});
          // Exercise the same atomic writer publication as the coordinator.
          // runtime.call's analysisJob path routes through this local writer.
          return result;
        };
        runtime.rpc=(operation,input)=>{if(operation!=='analysis.persist')throw Error('Unexpected RPC');return runtime.persistDerived(input);};
        const situations=new SituationStore(db,{now:Date.now});
        maintenance=new AgentMaintenance({enabled:true,advancedMode:mode,now:Date.now,
          dependencies:async()=>({news:{revision:versions.news},research:0,candles:{}}),
          call:()=>measure('alertSync',()=>situations.processPage({limit:100,budgetMs:50})),
          business:{
            advanced:{getSnapshot:()=>measure('advanced.automatic',advanced)},
            conditions:{getSnapshot:options=>measure('conditions',()=>runtime.call({service:'conditions',method:'getSnapshot',args:[options],context}))},
            forecasts:{evaluate:options=>measure('evaluation',()=>runtime.call({service:'forecasts',method:'evaluate',args:[options],context}))}
          }});
        // Control and analytical paths normally overlap. Serialize only their
        // measurement boundaries here so per-operation deltas cannot overlap.
        await maintenance.tick();await maintenance.stop();
        const failures=Object.entries(maintenance.status.domains||{}).filter(([,v])=>v.state==='degraded'||v.state==='deferred');
        if(failures.length){json(join(outputDir,`${index+1}-failure.json`),{failures,errors,operations});throw Error('Maintenance failed: '+JSON.stringify({failures,errors}));}
        const automatic=content(db),automaticWrites=operations.reduce((total,o)=>{
          for(const k of Object.keys(total))total[k]+=o.writes[k];return total;
        },{transactions:0,statements:0,rowsChanged:0,bindingBytes:0});
        const result=await measure('advanced.explicit',advanced);
        await measure('advanced.reuse',advanced);
        const stableResult=db.prepare("SELECT a.payload_json FROM analysis_latest l JOIN analysis_runs a USING(analysis_id) LIMIT 1").get();
        const counts=content(db);
        if(counts.analysis_jobs!==1||counts.analysis_latest!==1)throw Error('Explicit reuse/deduplication failed');
        results.push({index,mode,initialDatabaseSHA256:seedHash,inputHash:frozen.inputHash,automatic,automaticWrites,operations,
          resultHash:stableHash(JSON.parse(stableResult.payload_json)),explicitReady:Boolean(result),counts,
          sqlite:{synchronous:db.pragma('synchronous',{simple:true}),walAutocheckpoint:db.pragma('wal_autocheckpoint',{simple:true}),checkpoint:db.pragma('wal_checkpoint(PASSIVE)')},
          maintenance:maintenance.status});
        json(join(outputDir,`${index+1}-result.json`),results.at(-1));
      }finally{await maintenance?.stop();runtime?.close();db.close();}
    }
  }finally{globalThis.Date=OriginalDate;}
  if(new Set(results.map(r=>r.resultHash)).size!==1)throw Error('Frozen result parity failed');
  for(const operation of ['alertSync','conditions','evaluation']){
    if(new Set(results.map(r=>r.operations.find(o=>o.operation===operation).resultHash)).size!==1)throw Error('Common result parity failed: '+operation);
  }
  if(digest(seed)!==seedHash||digest(inputFile)!==inputFileHash)throw Error('Frozen seed changed');
  const summary={schemaVersion:'maintenance-comparison-v1',scope:'instrumental frozen subset; real calculation, maintenance selector and atomic publication; no live acquisition, technical candle workload or host-pressure acceptance',
    inputHash:frozen.inputHash,inputFileSHA256:digest(inputFile),seedSHA256:seedHash,coverage:frozen.coverage,order:'A/B/B/A',parity:true,commonResultParity:true,results,
    metricLimits:'binding bytes are logical; WAL file sizes are retained allocation, not cumulative frames or physical I/O; CPU is process-wide; wall/CPU observations are descriptive, not long-tail evidence'};
  json(join(outputDir,'comparison.json'),summary);return summary;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,input,output]=process.argv.slice(2);
  if(!['freeze','compare'].includes(command)||!input||!output)throw Error('Usage: compare-frozen-maintenance.js freeze SOURCE.sqlite INPUT.json | compare INPUT.json NEW_OUTPUT_DIR');
  const result=command==='freeze'?freezeMaintenanceInput(input,output):await compareFrozenMaintenance(input,output);
  console.log(JSON.stringify(command==='freeze'?result:{parity:result.parity,file:join(output,'comparison.json'),runs:result.results.map(r=>({mode:r.mode,automatic:r.automatic,automaticWrites:r.automaticWrites}))}));
}
