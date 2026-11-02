import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {archiveSemanticCase} from '../services/agent/semanticArchive.js';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'semantic-archive-')),databasePath=join(directory,'fixture.sqlite'),db=new Database(databasePath);
 db.exec('CREATE TABLE agent_jobs(job_id,snapshot_id,session_id,model,prompt_version,status); CREATE TABLE agent_runs(job_id,run_id,fence,status,started_at,finished_at,metadata_json)');
 db.prepare('INSERT INTO agent_jobs VALUES(?,?,?,?,?,?)').run('j','s','owned','fixture','prompt','completed');db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?)').run('j','j:1',1,'completed','start','finish',JSON.stringify({generation:{snapshotId:'s',sessionId:'remote',messageId:'initial'}}));db.close();
 const evidence={evidenceId:'news:one',domain:'news',data:{title:'Un relato atribuido'}},encoded=JSON.stringify(evidence),sha256=createHash('sha256').update(encoded).digest('hex');
 const request=async path=>path.includes('/chunk?')?{snapshotId:'s',evidenceId:'news:one',sha256,chunk:encoded,nextOffset:Buffer.byteLength(encoded),hasMore:false}:{snapshotId:'s',asOf:'2026-11-02T10:00:00Z',coverage:{sealed:true,sha256:'b'.repeat(64)},items:[{evidenceId:'news:one',representation:'chunked'}],hasMore:false};
 const args={selected:{id:'brief-01',family:'brief',scenario:'sufficient',evidenceSelectionRationale:'real-context-fixture'},run:{jobId:'j',snapshotId:'s',sessionId:'owned',model:'fixture',promptVersion:'prompt',status:'completed',publication:{proposal:{evidenceIds:['news:one']}}},candidateHash:'a'.repeat(64),modelManifestHash:'d'.repeat(64),databasePath,request,opencode:{messages:async()=>({data:[{type:'assistant',content:[{type:'text',text:'Initial candidate preserved'}]}]})}};
 return {args,evidence,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('archive reconstructs exact private chunks and preserves candidates with a read-only database',async()=>{
 const f=fixture();try{const result=await archiveSemanticCase(f.args);assert.deepEqual(result.evidence,[f.evidence]);assert.equal(result.attempts[0].messages.data[0].content[0].text,'Initial candidate preserved');assert.match(result.contentHash,/^[a-f0-9]{64}$/);const db=new Database(f.args.databasePath,{readonly:true});assert.equal(db.prepare('SELECT count(*) n FROM agent_jobs').get().n,1);db.close();}finally{f.close();}
});
test('archive refuses tampered chunk hashes and mismatched execution identity',async()=>{
 const f=fixture();try{const request=f.args.request;await assert.rejects(archiveSemanticCase({...f.args,request:async p=>{const r=await request(p);return p.includes('/chunk?')?{...r,chunk:r.chunk+' '}:r;}}),/hash mismatch/);await assert.rejects(archiveSemanticCase({...f.args,run:{...f.args.run,sessionId:'foreign'}}),/disagree/);}finally{f.close();}
});
