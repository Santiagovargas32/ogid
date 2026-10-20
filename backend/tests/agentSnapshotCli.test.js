import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { migrate } from '../storage/migrate.js';
import { BusinessRuntime } from '../storage/businessRuntime.js';
import { AgentRepository } from '../storage/agentRepository.js';

test('snapshot validation handles a copy with queued jobs without claiming or deleting its existing work',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-snapshot-cli-')),file=join(directory,'copy.sqlite'),output=join(directory,'report.json');
 let db=new Database(file);db.pragma('foreign_keys=ON');migrate(db);
 const repo=new AgentRepository(new BusinessRuntime(db,()=>{}),{now:()=>Date.now()-10*86400000,debounceMs:0});
 const old=repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',priority:10,key:'old'});db.close();
 try{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/agent-snapshot-check.js',import.meta.url)),file,output],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  const report=JSON.parse(readFileSync(output));assert.equal(report.status,'passed');assert.equal(report.recoveredAfterReopen,true);
  db=new Database(file,{readonly:true});
  assert.deepEqual(db.prepare('SELECT status,lease_owner FROM agent_jobs WHERE job_id=?').get(old.jobId),{status:'queued',lease_owner:null});
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_snapshots WHERE json_extract(manifest_json,\'$.sealed\')=1').get().n,1);
 }finally{if(db.open)db.close();rmSync(directory,{recursive:true,force:true});}
});
