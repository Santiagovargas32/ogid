// Generated fixture only. Never accepts or opens an operational database path.
import Database from 'better-sqlite3';
import {mkdtempSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../storage/migrate.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {performance} from 'node:perf_hooks';

const root=mkdtempSync(join(tmpdir(),'ogid-status-benchmark-')),db=new Database(':memory:');
const oldQuery="SELECT job_id,task,scope,model,status FROM agent_jobs ORDER BY CASE WHEN status IN ('running','waiting-model','validating') THEN 0 ELSE 1 END,updated_at DESC,job_id LIMIT 50";
const newQuery="SELECT job_id,task,scope,model,status FROM agent_jobs INDEXED BY agent_jobs_active_recent WHERE status IN ('running','waiting-model','validating') ORDER BY updated_at DESC,job_id LIMIT 50";
function measure(run){const samples=Array.from({length:50},()=>{const at=performance.now();run();return performance.now()-at;}).sort((a,b)=>a-b);return {samples:50,p50Ms:samples[25],p95Ms:samples[47],maxMs:samples[49]};}
try{
  const source=new URL('../storage/migrations/',import.meta.url);
  for(const name of readdirSync(source).filter(name=>/^\d{3}_.*\.sql$/.test(name)&&Number(name.slice(0,3))<=22))copyFileSync(new URL(name,source),join(root,name));
  migrate(db,root);const previous=db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
  const put=db.prepare("INSERT INTO agent_jobs(job_id,task,scope,model,prompt_version,idempotency_key,status,priority,created_at,updated_at,input_json) VALUES(?,'global_intelligence_brief','global','fixture','fixture',?,?,0,?,?,'{}')");
  db.transaction(()=>{for(let n=0;n<100000;n++){const id=String(n).padStart(7,'0'),at=new Date(1700000000000+n).toISOString();put.run(id,id,n%1000===0?'running':'completed',at,at);}})();
  const oldPlan=db.prepare('EXPLAIN QUERY PLAN '+oldQuery).all().map(row=>row.detail),old=db.prepare(oldQuery);
  const before=measure(()=>old.all()),expected=old.all().map(row=>row.job_id);
  migrate(db);const fresh=db.prepare(newQuery),repo=new AgentRepository({db,load:()=>null});
  const actual=repo.status().recentJobs.map(row=>row.jobId);
  const unchanged=JSON.stringify(previous)===JSON.stringify(db.prepare('SELECT version,name,checksum FROM schema_migrations WHERE version<=22 ORDER BY version').all());
  console.log(JSON.stringify({fixture:{rows:100000,storage:'SQLite memory database',node:process.version,realCorpus:false},
    migration:{from:22,to:23,previousChecksumsUnchanged:unchanged,integrity:db.pragma('integrity_check',{simple:true}),foreignKeyErrors:db.pragma('foreign_key_check').length},
    activeFirstOrderPreserved:JSON.stringify(expected)===JSON.stringify(actual),
    oldPlan,newPlan:db.prepare('EXPLAIN QUERY PLAN '+newQuery).all().map(row=>row.detail),
    before,after:measure(()=>fresh.all()),fullStatus:measure(()=>repo.status()),
    limitation:'No cold-disk or concurrent writer guarantee. Actual v19 I/O cause and corpus-copy validation remain pending.'},null,2));
}finally{db.close();rmSync(root,{recursive:true,force:true});}
