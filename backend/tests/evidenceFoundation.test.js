import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {dependencyManifest} from '../utils/releaseManifest.js';
import {shadowBaseline} from '../scripts/shadow-baseline-report.js';
import {migrate} from '../storage/migrate.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {AgentMaintenance} from '../services/agent/maintenance.js';
import {createAppServer} from '../server.js';
import {StorageManager} from '../storage/StorageManager.js';
import {projectOperation} from '../utils/researchProjection.js';

test('health projection distinguishes applied schema from declared release without leaking its database path',()=>{
  const result=projectOperation({projection:'health'},{status:'ok',effectiveSchemaVersion:22,build:{release:{expectedSchema:{latest:23}}},storage:{state:'ready',databasePath:'/private/db.sqlite'}});
  assert.equal(result.effectiveSchemaVersion,22);assert.equal(result.build.release.expectedSchema.latest,23);
  assert.ok(!JSON.stringify(result).includes('/private/'));
});

test('release manifest detects installation drift without exporting private package config',()=>{
  const root=mkdtempSync(join(tmpdir(),'ogid-release-'));
  try{
    mkdirSync(join(root,'backend/node_modules/fixture'),{recursive:true});
    writeFileSync(join(root,'backend/package-lock.json'),JSON.stringify({packages:{'node_modules/fixture':{version:'1.2.3'}}}));
    const file=join(root,'backend/node_modules/fixture/package.json');
    writeFileSync(file,JSON.stringify({version:'1.2.2',privateKey:'DO_NOT_EXPORT'}));
    const stale=dependencyManifest(root,'backend');assert.equal(stale.state,'mismatch');assert.equal(stale.mismatches[0].installed,'1.2.2');
    assert.ok(!JSON.stringify(stale).includes('DO_NOT_EXPORT'));
    writeFileSync(file,JSON.stringify({version:'1.2.3'}));const current=dependencyManifest(root,'backend');
    assert.equal(current.state,'matched');assert.equal(current.lockHash,stale.lockHash);assert.notEqual(current.installedHash,stale.installedHash);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('shadow report deduplicates terminal attempts and keeps observer/log windows distinct and private',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ogid-baseline-'));
  try{
    const at='2026-10-25T10:00:00.000Z',failure={timestamp:at,message:'agent_generation_failed',jobId:'one',fence:1,code:'AGENT_UNVERIFIED_NUMBER',prompt:'DO_NOT_EXPORT'};
    writeFileSync(join(root,'backend.log'),[failure,failure,{...failure,fence:2}].map(JSON.stringify).join('\n'));
    writeFileSync(join(root,'samples.jsonl'),JSON.stringify({at,pid:1,startedAt:at,build:'fixture',http:{health:200,ready:200,agent:null},status:'ok'})+'\n');
    writeFileSync(join(root,'summary.json'),JSON.stringify({startedAt:at,state:'interrupted',completedObservation:false,lastSample:{agent:{sinceCounts:[{status:'completed',count:1}]}}}));
    const report=await shadowBaseline(join(root,'backend.log'),root);
    assert.equal(report.log.terminalAttempts,2);assert.equal(report.log.terminalCodes.AGENT_UNVERIFIED_NUMBER,2);
    assert.equal(report.observer.samples,1);assert.equal(report.observer.http.agent.unavailable,1);assert.equal(report.observer.completedObservation,false);
    assert.deepEqual(report.observer.terminalSinceCounts,[{status:'completed',count:1}]);assert.ok(!JSON.stringify(report).includes('DO_NOT_EXPORT'));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('status uses ordered partial pages and matches active-first ordering without a corpus sort',()=>{
  const db=new Database(':memory:');migrate(db);
  try{
    const insert=db.prepare("INSERT INTO agent_jobs(job_id,task,scope,model,prompt_version,idempotency_key,status,priority,created_at,updated_at,input_json) VALUES(?,'global_intelligence_brief','global','fixture','fixture',?,?,0,?,?,'{}')");
    db.transaction(()=>{for(let n=0;n<2000;n++){const id=String(n).padStart(5,'0'),at=new Date(1700000000000+n).toISOString();insert.run(id,id,n%100===0?'running':'completed',at,at);}})();
    const expected=db.prepare("SELECT job_id FROM agent_jobs ORDER BY CASE WHEN status IN ('running','waiting-model','validating') THEN 0 ELSE 1 END,updated_at DESC,job_id LIMIT 50").all().map(r=>r.job_id);
    const repo=new AgentRepository({db,load:()=>null});assert.deepEqual(repo.status().recentJobs.map(j=>j.jobId),expected);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT job_id FROM agent_jobs INDEXED BY agent_jobs_active_recent WHERE status IN ('running','waiting-model','validating') ORDER BY updated_at DESC,job_id LIMIT 50").all();
    assert.ok(plan.some(p=>p.detail.includes('agent_jobs_active_recent')));assert.ok(plan.every(p=>!p.detail.includes('TEMP B-TREE')));
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{db.close();}
});

test('off mode retains deterministic maintenance without model children or browser traffic',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-off-maintenance-'));
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite')});
  const runtime=createAppServer({storageManager:manager,agent:{mode:'off'},disableBackgroundRefresh:true});
  try{assert.equal(runtime.app.locals.agentConfig.mode,'off');assert.equal(runtime.app.locals.agentMaintenance.enabled,true);}
  finally{await runtime.stop();}
  rmSync(directory,{recursive:true,force:true});
  const called=[];let page=0;
  const maintenance=new AgentMaintenance({enabled:true,call:async name=>called.push(name),business:{news:{enrichEditorialPage:async()=>({complete:++page===2})},advanced:{getSnapshot:async()=>called.push('advanced')},conditions:{getSnapshot:async()=>called.push('conditions')},forecasts:{evaluate:async()=>called.push('evaluation')}}});
  await maintenance.tick();await maintenance.tick();await maintenance.tick();
  assert.equal(page,2);assert.ok(called.includes('alertSync'));assert.ok(called.includes('advanced'));assert.equal(maintenance.status.state,'ready');await maintenance.stop();
});

test('active and inactive status pages retain one read view during a concurrent transition',()=>{
  const root=mkdtempSync(join(tmpdir(),'ogid-status-view-')),file=join(root,'db.sqlite'),writer=new Database(file);
  writer.pragma('journal_mode=WAL');migrate(writer);
  writer.prepare("INSERT INTO agent_jobs(job_id,task,scope,model,prompt_version,idempotency_key,status,priority,created_at,updated_at,input_json) VALUES('job','global_intelligence_brief','global','fixture','fixture','key','running',0,'2026-10-26T10:00:00Z','2026-10-26T10:00:00Z','{}')").run();
  const reader=new Database(file,{readonly:true});reader.pragma('query_only=ON');const prepare=reader.prepare.bind(reader);let changed=false;
  reader.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INDEXED BY agent_jobs_active_recent')&&!changed){const all=statement.all;statement.all=function(...args){const rows=all.apply(this,args);changed=true;writer.prepare("UPDATE agent_jobs SET status='completed' WHERE job_id='job'").run();return rows;};}return statement;};
  try{
    const repository=new AgentRepository({db:reader,load:()=>null}),status=repository.status();
    assert.equal(status.recentJobs.length,1);assert.equal(status.recentJobs[0].status,'running');assert.equal(reader.inTransaction,false);
    assert.equal(repository.status().recentJobs[0].status,'completed');
  }finally{reader.close();writer.close();rmSync(root,{recursive:true,force:true});}
});
