// Read-only evidence for a real recovery cohort. Run before startup and after shutdown.
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {storageMaintenanceOptions} from './storage-options.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recoverySnapshot(db){
  if(db.pragma('query_only',{simple:true})!==1)throw Error('Recovery evidence requires query_only');
  const rows=(sql,...args)=>{const values=db.prepare(sql+' LIMIT 10001').all(...args);if(values.length>10000)throw Error('Recovery evidence row budget exceeded');return values;};
  return db.transaction(()=>({
    version:1,at:new Date().toISOString(),
    schema:db.prepare('SELECT max(version) n FROM schema_migrations').get().n,
    owners:rows('SELECT * FROM storage_writer_owner'),
    activeAgent:rows("SELECT job_id,status,fence,lease_owner,lease_until FROM agent_jobs WHERE status IN ('running','validating','waiting-model') AND lease_owner IS NOT NULL ORDER BY job_id"),
    agentDigest:digest(rows('SELECT job_id,status,fence,attempts,lease_owner,lease_until,error_code,updated_at FROM agent_jobs ORDER BY job_id')),
    runsDigest:digest(rows('SELECT run_id,job_id,fence,status,finished_at FROM agent_runs ORDER BY run_id')),
    publicationsDigest:digest(rows('SELECT publication_id,job_id,payload_json FROM agent_publications ORDER BY publication_id')),
    consumers:rows('SELECT stream,last_sequence,error_code FROM situation_consumers ORDER BY stream'),
    heads:{news:db.prepare('SELECT coalesce(max(sequence),0) n FROM news_comparison_changes').get().n,awareness:db.prepare('SELECT coalesce(max(sequence),0) n FROM awareness_revisions').get().n},
    receipts:rows("SELECT job_id,request_id,status,json_extract(job_json,'$.cursor') cursor,json_array_length(job_json,'$.candles') items FROM acquisition_jobs WHERE kind='market-persistence' ORDER BY job_id"),
    projections:rows('SELECT scope_key,state,required_revision,completed_revision,last_error FROM market_projection_state ORDER BY scope_key'),
    rss:rows("SELECT kind,updated_at,json_extract(payload_json,'$.lastCommittedAt') committed,json_extract(payload_json,'$.lastAttemptAt') attempted,json_extract(payload_json,'$.etag') etag,json_extract(payload_json,'$.contentHash') contentHash FROM runtime_snapshots WHERE kind GLOB 'rss-canonical-feed:*' ORDER BY kind"),
    rssCycles:db.prepare("SELECT json_extract(payload_json,'$.metrics.cycles') n FROM runtime_snapshots WHERE kind='rss-canonical-v2'").get()?.n??null,
    outboxMissing:db.prepare('SELECT count(*) n FROM situation_outbox o LEFT JOIN situation_revisions r ON r.sequence=o.domain_sequence WHERE r.sequence IS NULL').get().n
  }))();
}

export function compareRecovery(before,after){
  const failures=[];
  const require=(ok,label)=>{if(!ok)failures.push(label);};
  require(before.version===1&&after.version===1,'snapshot-version');
  require(after.schema===before.schema,'schema-changed');
  require(before.owners.length===0&&after.owners.length===0,'writer-owner-remains');
  require(before.activeAgent.length===0&&after.activeAgent.length===0,'active-agent-lease');
  for(const key of ['agentDigest','runsDigest','publicationsDigest'])require(before[key]===after[key],key+'-changed');
  for(const stream of ['news','awareness']){
    const previous=before.consumers.find(x=>x.stream===stream),current=after.consumers.find(x=>x.stream===stream);
    require(Boolean(previous&&current)&&!current.error_code&&current.last_sequence>=previous.last_sequence&&current.last_sequence>=before.heads[stream]&&after.heads[stream]>=before.heads[stream]&&current.last_sequence<=after.heads[stream],'consumer-'+stream);
  }
  const receipts=new Map(after.receipts.map(x=>[x.job_id,x]));
  for(const row of before.receipts){const next=receipts.get(row.job_id);require(Boolean(next)&&next.request_id===row.request_id&&next.cursor>=row.cursor&&(row.status!=='complete'||next.status==='complete'&&next.cursor===row.cursor&&next.items===row.items),'receipt-'+row.job_id);}
  require(after.receipts.every(x=>x.status==='complete'&&x.cursor===x.items),'market-incomplete');
  require(after.projections.every(x=>x.state==='complete'&&!x.last_error&&x.required_revision===x.completed_revision),'projection-incomplete');
  const projections=new Map(after.projections.map(x=>[x.scope_key,x]));
  for(const row of before.projections){const next=projections.get(row.scope_key);require(Boolean(next)&&next.required_revision>=row.required_revision&&next.completed_revision>=row.completed_revision,'projection-lost-'+row.scope_key);}
  const rss=new Map(after.rss.map(x=>[x.kind,x]));
  for(const row of before.rss){const next=rss.get(row.kind);require(Boolean(next)&&next.updated_at>=row.updated_at&&(row.committed==null||next.committed>=row.committed)&&(row.attempted==null||next.attempted>=row.attempted),'rss-checkpoint-'+row.kind);}
  require(Number.isFinite(before.rssCycles)&&after.rssCycles>before.rssCycles,'rss-did-not-progress');
  require(after.outboxMissing===0,'outbox-reference-missing');
  return {verified:failures.length===0,failures,newsRemaining:after.heads.news-after.consumers.find(x=>x.stream==='news')?.last_sequence,awarenessRemaining:after.heads.awareness-after.consumers.find(x=>x.stream==='awareness')?.last_sequence,rssCycles:after.rssCycles-before.rssCycles};
}

function main(){
  const [output,baseline]=process.argv.slice(2);
  if(!output)throw Error('Usage: node scripts/verify-durable-recovery.js output.json [baseline.json]');
  const options=storageMaintenanceOptions(),db=new Database(options.databasePath,{readonly:true,fileMustExist:true,timeout:2000});
  let snapshot;
  try{db.pragma('query_only=ON');snapshot=recoverySnapshot(db);}finally{db.close();}
  if(baseline)snapshot.comparison=compareRecovery(JSON.parse(readFileSync(baseline,'utf8')),snapshot);
  writeFileSync(output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({at:snapshot.at,owners:snapshot.owners.length,activeAgent:snapshot.activeAgent.length,receipts:snapshot.receipts.length,rssFeeds:snapshot.rss.length,comparison:snapshot.comparison}));
  if(snapshot.comparison&&!snapshot.comparison.verified)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
